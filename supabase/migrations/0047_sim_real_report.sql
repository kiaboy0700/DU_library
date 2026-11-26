-- 가상 학생 자동 이용: 팀원(가상이 아닌 계정)이 신고한 좌석의 가상 학생은 스스로 응답하지 않는다.
-- 신고 → 관리자 확인 → 반납 확정 → 우선 예약까지 시연 도구 없이 직접 해 볼 수 있게 하기 위함.
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
           exists (select 1 from seat_reports sr where sr.reservation_id = res.id and sr.status = 'pending') as reported,
           coalesce((select p2.is_virtual from seat_reports sr join profiles p2 on p2.id = sr.reporter_id where sr.reservation_id = res.id and sr.status = 'pending' limit 1), false) as rep_virtual
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
      -- 팀원이 직접 신고한 좌석은 스스로 돌아오지 않는다 (관리자 처리까지 직접 해 볼 수 있게)
      if r.rep_virtual and r.x < 0.15 then k := 'confirm'; end if;
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
