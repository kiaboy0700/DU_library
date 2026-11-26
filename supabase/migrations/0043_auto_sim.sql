-- 가상 학생 자동 이용: 켜 두면 가상 학생들이 운영 시간에 맞춰 스스로 예약·체크인·외출·연장·반납·신고·도움 요청을 한다.
-- 팀원과 관리자 계정은 대상이 아니다. 켜져 있는 동안 관리자는 혼잡도를 직접 맞추거나 전체 초기화를 할 수 없다.

alter table reservations add column if not exists sim boolean not null default false;
create index if not exists reservations_sim_idx on reservations(status) where sim;
insert into settings(key, value) values ('auto_sim', 'false'::jsonb) on conflict (key) do nothing;

-- 관리자가 손댄 예약·학생은 자동 이용에서 뺀다 (서로 덮어쓰지 않게)
create or replace function sim_handoff() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.reservation_id is not null then
    update reservations set sim = false where id = new.reservation_id and sim;
  end if;
  if new.target_user is not null then
    update reservations set sim = false where user_id = new.target_user and sim and status in ('reserved','in_use','away');
  end if;
  return new;
end $$;
drop trigger if exists sim_handoff on admin_actions;
create trigger sim_handoff after insert on admin_actions for each row execute function sim_handoff();

-- 자동으로 움직여도 되는 가상 학생: 정지 중이 아니고, 최근 3시간 안에 누가 로그인해 쓰지 않았고, 최근 30분 안에 관리자가 손대지 않은 학생
create or replace function sim_pool() returns table (id uuid)
language sql stable security definer set search_path = public as $$
  select p.id from profiles p join auth.users au on au.id = p.id
  where p.is_virtual and p.role = 'student'
    and (p.banned_until is null or p.banned_until < now())
    and (au.last_sign_in_at is null or au.last_sign_in_at < now() - interval '3 hours')
    and not exists (select 1 from admin_actions a where a.target_user = p.id and a.created_at > now() - interval '30 minutes');
$$;
revoke execute on function sim_pool() from public, anon, authenticated;

-- 시간대별 목표 혼잡도(%). 오전에 차오르고 오후에 가장 붐볐다가 저녁에 빠진다
create or replace function sim_target(p_room int, p_at timestamptz default now()) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  h numeric := extract(epoch from (p_at at time zone 'Asia/Seoul')::time) / 3600.0;
  xs numeric[] := array[0, 9, 10.5, 13, 15, 17, 19, 21, 22, 24];
  ys numeric[] := array[10, 15, 45, 60, 82, 86, 70, 45, 25, 10];
  base numeric := 10; i int; fl int;
begin
  for i in 1..array_length(xs, 1) - 1 loop
    if h >= xs[i] and h <= xs[i + 1] then
      base := ys[i] + (ys[i + 1] - ys[i]) * (h - xs[i]) / (xs[i + 1] - xs[i]);
      exit;
    end if;
  end loop;
  select floor into fl from rooms where id = p_room;
  if fl = 2 then base := base * 0.85; end if;
  base := base + 5 * sin(extract(epoch from p_at) / 1300.0 + p_room);
  return least(95, greatest(3, round(base)))::int;
end $$;
revoke execute on function sim_target(int, timestamptz) from public, anon;
grant execute on function sim_target(int, timestamptz) to authenticated;

-- 가상 학생 한 명이 실제 학생과 똑같은 함수로 행동한다. 규칙에 걸리면 조용히 넘어간다
create or replace function sim_do(p_user uuid, p_action text, p_seat int default null, p_arg int default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare tok uuid; lat double precision := cfg('library_lat'); lng double precision := cfg('library_lng');
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  if p_seat is not null then select qr_token into tok from seats where id = p_seat; end if;
  begin
    case p_action
      when 'reserve' then perform reserve_seat(p_seat, p_arg);
      when 'quick' then perform quick_reserve(p_arg);
      when 'check_in' then perform check_in(tok, lat, lng);
      when 'away' then perform go_away();
      when 'back' then perform come_back(tok, lat, lng);
      when 'extend' then perform extend_reservation(tok, lat, lng);
      when 'return' then perform return_seat();
      when 'move' then perform move_seat(tok, lat, lng);
      when 'report' then perform report_seat(tok, lat, lng);
      when 'confirm' then perform confirm_presence(tok, lat, lng);
      when 'help' then perform request_help('QR이 인식되지 않아요', null, null, null, null);
      when 'help_cancel' then perform cancel_help();
      else raise exception 'unknown';
    end case;
  exception when others then
    return false;
  end;
  update reservations set sim = true where user_id = p_user and status in ('reserved','in_use','away') and not sim;
  return true;
end $$;
revoke execute on function sim_do(uuid, text, int, int) from public, anon, authenticated;

-- 1분마다 한 걸음
create or replace function sim_tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c0 text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  c1 text := coalesce(current_setting('request.jwt.claims', true), '');
  rm record; r record; u uuid; sid int; total int; occ int; need int; n int;
  win int := cfg('extend_window_min')::int;
  did jsonb := '{}'::jsonb; k text; ok boolean;
begin
  if not cfgb('auto_sim') then return null; end if;
  if not pg_try_advisory_xact_lock(778201) then return null; end if;

  for rm in select ro.id from rooms ro order by ro.floor loop
    continue when not (select st.is_open from room_status(rm.id) st);
    select count(*), count(*) filter (where ss.state <> 'free') into total, occ
      from seats s join seat_state ss on ss.seat_id = s.id where s.room_id = rm.id and s.is_active;
    need := round(sim_target(rm.id) * total / 100.0)::int - occ;

    -- 들어오는 학생: 목표보다 비어 있을수록 많이. 오늘 아직 이용하지 않은 학생부터
    n := least(8, greatest(0, ceil(need * 0.3)::int)) + (case when need > -4 and random() < 0.3 then 1 else 0 end);
    for r in
      select s.id as seat_id, v.id as user_id from
        (select s.id, row_number() over (order by random()) rn from seats s join seat_state ss on ss.seat_id = s.id
          where s.room_id = rm.id and s.is_active and not s.close_pending and ss.state = 'free') s
        join (select p.id, row_number() over (order by
                exists (select 1 from reservations x where x.user_id = p.id
                        and x.created_at >= date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'), random()) rn
              from sim_pool() p
              where not exists (select 1 from reservations x where x.user_id = p.id and x.status in ('reserved','in_use','away'))) v
          on v.rn = s.rn
      where s.rn <= n
    loop
      if random() < 0.25 then
        ok := sim_do(r.user_id, 'quick', null, rm.id);
      else
        ok := sim_do(r.user_id, 'reserve', r.seat_id, (array[60, 120, 180, 240])[1 + floor(random() * 4)::int]);
        if ok and random() < 0.4 then perform sim_do(r.user_id, 'check_in', r.seat_id); end if;
      end if;
      if ok then did := jsonb_set(did, '{reserve}', to_jsonb(coalesce((did->>'reserve')::int, 0) + 1)); end if;
    end loop;

    -- 목표보다 붐비면 몇 명이 먼저 나간다
    if need < 0 then
      for r in select res.user_id from reservations res join seats s on s.id = res.seat_id join sim_pool() p on p.id = res.user_id
               where res.sim and res.status = 'in_use' and not res.on_hold and s.room_id = rm.id
                 and not exists (select 1 from seat_reports sr where sr.reservation_id = res.id and sr.status = 'pending')
               order by random() limit least(6, ceil(-need * 0.3)::int)
      loop
        if sim_do(r.user_id, 'return') then did := jsonb_set(did, '{return}', to_jsonb(coalesce((did->>'return')::int, 0) + 1)); end if;
      end loop;
    end if;
  end loop;

  -- 자리에 있는 학생들의 행동
  for r in
    select res.user_id, res.seat_id, res.status, res.checkin_deadline, res.end_at, s.room_id, random() as x,
           exists (select 1 from seat_reports sr where sr.reservation_id = res.id and sr.status = 'pending') as reported
    from reservations res join seats s on s.id = res.seat_id join sim_pool() p on p.id = res.user_id
    where res.sim and res.status in ('reserved','in_use','away') and not res.on_hold
  loop
    k := null;
    if r.status = 'reserved' then
      if r.x < 0.30 or (r.checkin_deadline < now() + interval '2 minutes' and r.x < 0.9) then k := 'check_in';
      elsif r.x > 0.992 then k := 'return';
      end if;
    elsif r.status = 'away' then
      if r.x < 0.18 then k := 'back'; end if;
    elsif r.reported then
      if r.x < 0.15 then k := 'confirm'; end if;
    elsif r.end_at < now() + make_interval(mins => win) and r.x < 0.03 then k := 'extend';
    elsif r.x < 0.006 then k := 'return';
    elsif r.x < 0.016 then k := 'away';
    elsif r.x < 0.0175 then k := 'move';
    end if;
    continue when k is null;
    sid := r.seat_id;
    if k = 'move' then
      select s.id into sid from seats s join seat_state ss on ss.seat_id = s.id
        where s.room_id = r.room_id and s.is_active and not s.close_pending and ss.state = 'free' order by random() limit 1;
      continue when sid is null;
    end if;
    if sim_do(r.user_id, k, sid) then did := jsonb_set(did, array[k], to_jsonb(coalesce((did->>k)::int, 0) + 1)); end if;
  end loop;

  -- 자리비움 신고: 한 번에 두 건까지만 걸려 있게
  if random() < 0.07 and (select count(*) from seat_reports sr join profiles p on p.id = sr.reporter_id where sr.status = 'pending' and p.is_virtual) < 2 then
    select res.seat_id into sid from reservations res join sim_pool() p on p.id = res.user_id
      where res.sim and res.status = 'in_use' and not res.on_hold
        and res.checked_in_at < now() - make_interval(mins => cfg('report_min_after_checkin')::int)
        and not exists (select 1 from seat_reports sr where sr.reservation_id = res.id and sr.status = 'pending')
      order by random() limit 1;
    select p.id into u from sim_pool() p join profiles pr on pr.id = p.id
      where (pr.report_banned_until is null or pr.report_banned_until < now())
        and not exists (select 1 from reservations x where x.user_id = p.id and x.status in ('reserved','in_use','away'))
        and not exists (select 1 from seat_reports sr where sr.reporter_id = p.id and sr.created_at > now() - interval '24 hours')
      order by random() limit 1;
    if sid is not null and u is not null and sim_do(u, 'report', sid) then did := jsonb_set(did, '{report}', '1'); end if;
  end if;

  -- 도움 요청: 한 번에 한 건. 관리자가 7분 안에 받지 않으면 학생이 취소한다
  for r in select h.user_id from help_requests h join sim_pool() p on p.id = h.user_id
           where h.status = 'open' and not h.chat_open and h.created_at < now() - interval '7 minutes'
  loop
    perform sim_do(r.user_id, 'help_cancel');
  end loop;
  if random() < 0.03 and not exists (select 1 from help_requests h join profiles p on p.id = h.user_id where h.status = 'open' and p.is_virtual) then
    select res.user_id into u from reservations res join sim_pool() p on p.id = res.user_id
      where res.sim and res.status = 'reserved' and not res.on_hold order by random() limit 1;
    if u is not null and sim_do(u, 'help') then did := jsonb_set(did, '{help}', '1'); end if;
  end if;

  -- 가상 학생의 알림함이 끝없이 쌓이지 않게
  delete from notifications nt using profiles p where p.id = nt.user_id and p.is_virtual and nt.created_at < now() - interval '3 hours';

  perform set_config('request.jwt.claim.sub', c0, true);
  perform set_config('request.jwt.claims', c1, true);
  return did;
exception when others then
  perform set_config('request.jwt.claim.sub', c0, true);
  perform set_config('request.jwt.claims', c1, true);
  raise;
end $$;
revoke execute on function sim_tick() from public, anon, authenticated;

-- 켜고 끄기
create or replace function admin_set_auto_sim(p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  perform require_admin();
  insert into settings(key, value) values ('auto_sim', to_jsonb(p_on)) on conflict (key) do update set value = excluded.value;
  perform log_admin('auto_sim', null, null, null, case when p_on then '켬' else '끔' end);
  if p_on then
    -- 이미 앉아 있는 가상 학생들도 이어서 움직인다
    update reservations res set sim = true from profiles p
      where p.id = res.user_id and p.is_virtual and res.status in ('reserved','in_use','away') and not res.sim;
    perform sim_tick();
  else
    -- 끄면 자리는 그대로 두고, 가상 학생이 걸어 둔 도움 요청만 닫는다
    update reservations set on_hold = false where on_hold and sim and status in ('reserved','in_use','away');
    update help_requests h set status = 'resolved', resolution = '자동 이용 종료', resolved_at = now()
      from profiles p where p.id = h.user_id and p.is_virtual and h.status = 'open';
    update reservations set sim = false where sim;
  end if;
  select count(*) into n from reservations res join profiles p on p.id = res.user_id
    where p.is_virtual and res.status in ('reserved','in_use','away');
  return jsonb_build_object('on', p_on, 'active', n);
end $$;
revoke execute on function admin_set_auto_sim(boolean) from public, anon;
grant execute on function admin_set_auto_sim(boolean) to authenticated;

-- 켜져 있는 동안에는 혼잡도 직접 맞추기와 전체 초기화를 막는다
create or replace function admin_demo_fill(p_room int, p_pct int) returns int
language plpgsql security definer set search_path = public as $$
declare total int; target int; cur int; n int := 0; r record;
begin
  perform require_admin();
  if cfgb('auto_sim') then raise exception '가상 학생 자동 이용이 켜져 있습니다. 끄고 다시 해 주세요.'; end if;
  -- 이 열람실의 가상 학생 예약을 모두 정리
  for r in select res.id from reservations res join seats s on s.id = res.seat_id join profiles p on p.id = res.user_id
           where s.room_id = p_room and p.is_virtual and res.status in ('reserved','in_use','away')
  loop
    perform end_reservation(r.id, 'admin');
  end loop;
  select count(*) into total from seats where room_id = p_room and is_active;
  select count(*) into cur from seats s join seat_state ss on ss.seat_id = s.id where s.room_id = p_room and s.is_active and ss.state <> 'free';
  target := greatest(0, round(total * least(greatest(p_pct, 0), 100) / 100.0)::int - cur);
  for r in
    select s.id as seat_id, u.id as user_id from
      (select s.id, row_number() over (order by random()) rn from seats s join seat_state ss on ss.seat_id = s.id
        where s.room_id = p_room and s.is_active and ss.state = 'free') s
      join (select p.id, row_number() over (order by random()) rn from profiles p
        where p.is_virtual and not exists (select 1 from reservations x where x.user_id = p.id and x.status in ('reserved','in_use','away'))) u
      on u.rn = s.rn
    where s.rn <= target
  loop
    insert into reservations(user_id, seat_id, status, start_at, end_at, checkin_deadline, checked_in_at, by_admin)
    values (r.user_id, r.seat_id, case when random() < 0.08 then 'away' else 'in_use' end,
            now() - make_interval(mins => (random() * 120)::int), now() + make_interval(mins => 60 + (random() * 180)::int),
            now(), now() - interval '20 minutes', true);
    n := n + 1;
  end loop;
  update reservations set away_started_at = now(), away_deadline = end_at
    where status = 'away' and away_deadline is null;
  perform log_admin('demo_fill', null, null, null, format('room %s → %s%%', p_room, p_pct));
  return n;
end $$;

create or replace function admin_demo_reset() returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_res int; n_pen int;
begin
  perform require_admin();
  if cfgb('auto_sim') then raise exception '가상 학생 자동 이용이 켜져 있습니다. 끄고 다시 해 주세요.'; end if;

  -- 좌석: 진행 중인 예약과 맡아 둔 자리를 모두 비운다
  delete from seat_holds where true;
  update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'admin' where status = 'pending';
  update reservations set status = 'cancelled', ended_at = now(), end_reason = 'admin', on_hold = false
    where status in ('reserved','in_use','away');
  get diagnostics n_res = row_count;

  -- 좌석 수·열람실 상태: 사용 중지한 좌석과 임시 폐쇄를 되돌린다
  update seats set is_active = true, inactive_reason = null where not is_active;
  update rooms set is_closed = false, closed_reason = null where is_closed;

  -- 학생: 벌점, 이의신청, 예약 정지, 신고 정지, 도움 요청, 빈자리 알림, 알림함
  select count(*) into n_pen from penalties;
  delete from appeals where true;
  delete from penalties where true;
  update profiles set banned_until = null, ban_reason = null, report_banned_until = null
    where banned_until is not null or report_banned_until is not null;
  update help_requests set status = 'resolved', resolution = '시연 초기화', resolved_at = now() where status = 'open';
  delete from watch_requests where true;
  delete from notifications where true;

  -- 운영 상황: 시연용 기간과 장애 모드
  delete from operating_periods where label = '시연';
  update settings set value = 'false'::jsonb where key = 'incident_mode';

  perform log_admin('demo_reset_all', null, null, null, format('예약 %s건, 벌점 %s건', n_res, n_pen));
  return jsonb_build_object('reservations', n_res, 'penalties', n_pen);
end $$;

do $$
begin
  perform cron.unschedule('du-library-sim');
exception when others then null;
end $$;
select cron.schedule('du-library-sim', '* * * * *', 'select public.sim_tick()');

notify pgrst, 'reload schema';
