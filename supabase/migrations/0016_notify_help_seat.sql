-- 알림 문구 정리(어느 좌석인지, 무엇을 해야 하는지) + 도움 요청에 좌석 위치를 담는다


alter table help_requests add column if not exists seat_id int references seats(id) on delete set null;


create or replace function add_penalty(p_user uuid, p_res bigint, p_type text, p_points int, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare total int; days int := 0;
begin
  if p_points <= 0 then return; end if;
  insert into penalties(user_id, reservation_id, type, points, note) values (p_user, p_res, p_type, p_points, p_note);
  total := penalty_points(p_user);
  if total >= cfg('ban2_points') then days := cfg('ban2_days');
  elsif total >= cfg('ban1_points') then days := cfg('ban1_days');
  end if;
  if days > 0 then
    update profiles set banned_until = greatest(coalesce(banned_until, now()), now() + make_interval(days => days)),
      ban_reason = format('벌점 %s점 누적', total) where id = p_user;
    perform notify(p_user, '예약이 정지되었습니다', format('벌점 %s점이 쌓여 %s일 동안 예약할 수 없습니다. 내 좌석 화면에서 이의신청할 수 있습니다.', total, days));
  else
    perform notify(p_user, format('벌점 %s점 · 누적 %s점', p_points, total), p_note);
  end if;
end $$;

create or replace function report_seat(p_token uuid, p_lat double precision default null, p_lng double precision default null) returns int
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); s seats; r reservations; mins int; rname text;
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  select * into s from seats where qr_token = p_token;
  if not found then raise exception '유효하지 않은 QR입니다.'; end if;
  select * into r from reservations where seat_id = s.id and status in ('reserved','in_use','away');
  if not found then raise exception '비어 있는 좌석입니다. 바로 예약할 수 있어요.'; end if;
  if r.user_id = u then raise exception '내 좌석은 신고할 수 없습니다.'; end if;
  if r.status = 'away' then raise exception '외출 처리된 좌석입니다. 외출 시간이 지나면 자동으로 반납됩니다.'; end if;
  if r.status = 'reserved' then raise exception '체크인 대기 중인 좌석입니다. 시간 안에 오지 않으면 자동 취소됩니다.'; end if;
  if r.checked_in_at > now() - make_interval(mins => cfg('report_min_after_checkin')::int) then
    raise exception '방금 체크인한 좌석입니다. 잠시 후 다시 확인해 주세요.';
  end if;
  if exists (select 1 from seat_reports where reservation_id = r.id and status = 'pending') then
    raise exception '이미 신고가 접수되어 확인 중인 좌석입니다.';
  end if;
  if exists (select 1 from seat_reports where reservation_id = r.id and status = 'dismissed'
             and resolved_at > now() - make_interval(mins => cfg('report_cooldown')::int)) then
    raise exception '조금 전 이용자가 자리에 있음을 확인한 좌석입니다.';
  end if;
  if (select count(*) from seat_reports where reporter_id = u and created_at > now() - interval '1 hour') >= cfg('report_hourly_limit') then
    raise exception '신고는 1시간에 %건까지만 할 수 있습니다.', cfg('report_hourly_limit')::int;
  end if;
  perform gps_check(p_lat, p_lng);
  mins := report_minutes(s.room_id);
  select name into rname from rooms where id = s.room_id;
  insert into seat_reports(seat_id, reservation_id, reporter_id, occupancy_pct, respond_deadline)
    values (s.id, r.id, u, room_occupancy(s.room_id), now() + make_interval(mins => mins));
  perform notify(r.user_id, format('%s 자리 확인 요청 · %s분 안에 응답', s.label, mins), '자리가 비어 있다는 신고가 들어왔습니다. 좌석 QR을 찍으면 끝납니다. 응답하지 않으면 자동 반납되고 벌점이 붙습니다.');
  perform notify_admins(format('자리비움 신고 · %s %s', rname, s.label), format('응답 기한 %s분', mins), '/admin/reports');
  return mins;
end $$;

create or replace function tick() returns void
language plpgsql security definer set search_path = public as $$
declare r record; pts int; busy boolean; url text; secret text;
begin
  -- 0) 도움 요청이 2시간 넘게 처리되지 않으면 멈춤을 푼다 (관리자가 없는 시간에 좌석이 계속 묶이지 않게). 마감은 지금부터 다시 센다
  for r in select h.id, h.reservation_id, h.user_id from help_requests h where h.status = 'open' and h.created_at < now() - interval '2 hours'
  loop
    update help_requests set status = 'resolved', resolution = '오래 처리되지 않아 자동으로 닫혔습니다', resolved_at = now() where id = r.id;
    update reservations set on_hold = false,
        checkin_deadline = case when status = 'reserved' then now() + make_interval(mins => cfg('checkin_minutes')::int) else checkin_deadline end,
        away_deadline = case when status = 'away' then now() + interval '10 minutes' else away_deadline end
      where id = r.reservation_id and status in ('reserved','in_use','away');
    perform notify(r.user_id, '도움 요청이 닫혔습니다', '2시간 동안 처리되지 않아 닫혔습니다. 문제가 계속되면 다시 요청해 주세요.');
  end loop;

  if not cfgb('incident_mode') then
    -- 1) 노쇼: 체크인 마감 초과
    for r in select res.*, s.label from reservations res join seats s on s.id = res.seat_id
             where res.status = 'reserved' and res.checkin_deadline < now() and not res.on_hold
    loop
      update reservations set status = 'no_show', ended_at = now(), end_reason = 'no_show' where id = r.id;
      perform add_penalty(r.user_id, r.id, 'no_show', cfg('pen_no_show')::int, format('%s 좌석 예약 후 체크인하지 않음', r.label));
    end loop;

    -- 2) 외출 시간 초과
    for r in select res.*, s.label from reservations res join seats s on s.id = res.seat_id
             where res.status = 'away' and res.away_deadline < now() and res.away_deadline < res.end_at and not res.on_hold
    loop
      perform end_reservation(r.id, 'away_timeout');
      perform add_penalty(r.user_id, r.id, 'away_timeout', cfg('pen_away')::int, format('%s 좌석 외출 시간 초과로 자동 반납', r.label));
    end loop;

    -- 3) 자리비움 신고 응답 기한 초과
    for r in select rep.id as report_id, rep.reporter_id, rep.occupancy_pct, res.id, res.user_id, res.status, s.label, s.room_id
             from seat_reports rep join reservations res on res.id = rep.reservation_id join seats s on s.id = res.seat_id
             where rep.status = 'pending' and rep.respond_deadline < now() and not res.on_hold
    loop
      if r.status = 'in_use' then
        busy := r.occupancy_pct >= cfg('occ_high') or current_mode() = 'exam';
        pts := case when busy then cfg('pen_report_busy') else cfg('pen_report') end;
        update seat_reports set status = 'confirmed', resolved_at = now(), resolved_by = 'auto' where id = r.report_id;
        perform end_reservation(r.id, 'report');
        perform add_penalty(r.user_id, r.id, 'vacancy_report', pts, format('%s 좌석 자리비움 신고 확인 요청에 응답하지 않음', r.label));
        perform notify(r.reporter_id, format('신고한 %s 좌석이 반납되었습니다', r.label), '지금 빈자리입니다.', '/rooms/' || r.room_id);
      else
        update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'auto' where id = r.report_id;
      end if;
    end loop;
  end if;

  -- 4) 이용 시간 종료
  for r in select res.id, res.user_id, st.label, rm.name as room from reservations res join seats st on st.id = res.seat_id join rooms rm on rm.id = st.room_id
           where res.status in ('reserved','in_use','away') and res.end_at < now() and not res.on_hold
  loop
    perform end_reservation(r.id, 'expired');
    perform notify(r.user_id, format('%s 이용 시간 종료', r.label), format('%s %s 좌석이 반납되었습니다.', r.room, r.label));
  end loop;

  -- 5) 폐관·임시 폐쇄된 열람실 정리
  for r in select res.id, res.user_id, s.label from reservations res join seats s on s.id = res.seat_id,
           lateral room_status(s.room_id) st
           where res.status in ('reserved','in_use','away') and not st.is_open
  loop
    perform end_reservation(r.id, 'closing');
    perform notify(r.user_id, '열람실 운영 종료', format('%s 좌석이 반납되었습니다. 벌점은 없습니다.', r.label));
  end loop;

  -- 6) 미리 알림
  for r in select res.id, res.user_id, st.label from reservations res join seats st on st.id = res.seat_id
           where res.status in ('in_use','away') and not res.notified_end and res.end_at < now() + interval '10 minutes'
  loop
    update reservations set notified_end = true where id = r.id;
    perform notify(r.user_id, format('%s 이용 종료 10분 전', r.label), '더 이용하려면 지금 연장하세요. 시간이 지나면 자동 반납됩니다.');
  end loop;
  for r in select res.id, res.user_id, st.label from reservations res join seats st on st.id = res.seat_id
           where res.status = 'away' and not res.notified_away and res.away_deadline < now() + interval '5 minutes'
  loop
    update reservations set notified_away = true where id = r.id;
    perform notify(r.user_id, format('%s 복귀 5분 전', r.label), '자리로 돌아와 좌석 QR을 찍어 주세요. 늦으면 자동 반납되고 벌점이 붙습니다.');
  end loop;

  -- 7) 혼잡도 기록 (10분마다)
  if extract(minute from now())::int % 10 = 0 then
    insert into occupancy_snapshots(room_id, occupied, total)
      select s.room_id, count(*) filter (where ss.state <> 'free'), count(*)
      from seats s join seat_state ss on ss.seat_id = s.id where s.is_active group by s.room_id;
  end if;

  -- 8) 푸시 발송 요청 (앱 서버가 notifications 큐를 비움)
  if exists (select 1 from notifications where pushed_at is null and created_at > now() - interval '30 minutes') then
    select value into url from private_config where key = 'push_flush_url';
    select value into secret from private_config where key = 'push_flush_secret';
    if url is not null and url <> '' then
      perform net.http_post(url := url, headers := jsonb_build_object('Content-Type', 'application/json', 'x-flush-secret', secret), body := '{}'::jsonb);
    end if;
  end if;
end $$;

drop function if exists request_help(text, text);
create or replace function request_help(p_reason text, p_message text default null, p_token uuid default null, p_room int default null, p_label text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations; p profiles; sid int; loc text;
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  if exists (select 1 from help_requests where user_id = u and status = 'open') then
    raise exception '이미 접수된 도움 요청이 있습니다. 관리자가 확인 중입니다.';
  end if;
  select * into r from reservations where user_id = u and status in ('reserved','in_use','away');
  select * into p from profiles where id = u;
  -- 어느 좌석 이야기인지: QR을 찍었으면 그 좌석, 번호를 적었으면 그 좌석, 아니면 내 좌석
  if p_token is not null then
    select id into sid from seats where qr_token = p_token;
    if sid is null then raise exception '유효하지 않은 QR입니다.'; end if;
  elsif nullif(trim(p_label), '') is not null then
    select id into sid from seats where room_id = p_room and upper(label) = upper(trim(p_label));
    if sid is null then raise exception '그 열람실에 없는 좌석 번호입니다. 좌석에 적힌 번호를 확인해 주세요.'; end if;
  else
    sid := r.seat_id;
  end if;
  insert into help_requests(user_id, reservation_id, reason, message, seat_id) values (u, r.id, p_reason, p_message, sid);
  -- 체크인 전이든, 외출 중이든, 자리 확인 요청을 받았든: 관리자가 처리할 때까지 자동 취소·반납·벌점을 멈춘다
  if r.id is not null then
    update reservations set on_hold = true where id = r.id;
  end if;
  select rm.name || ' ' || s.label into loc from seats s join rooms rm on rm.id = s.room_id where s.id = sid;
  perform notify_admins('도움 요청' || coalesce(' · ' || loc, ''), format('%s(%s): %s', p.name, p.student_id, p_reason), '/admin/reports');
end $$;
grant execute on function request_help(text, text, uuid, int, text) to authenticated;


create or replace function admin_resolve_help(p_help bigint, p_resolution text) returns void
language plpgsql security definer set search_path = public as $$
declare h help_requests;
begin
  perform require_admin();
  update help_requests set status = 'resolved', resolution = p_resolution, resolved_at = now()
    where id = p_help and status = 'open' returning * into h;
  if not found then raise exception '이미 처리된 요청입니다.'; end if;
  -- 정지해 둔 체크인 마감을 다시 15분 부여
  -- 멈춰 둔 동안 지나간 마감은 지금부터 다시 센다 (풀자마자 벌점이 붙지 않게)
  update reservations set on_hold = false,
      checkin_deadline = case when status = 'reserved' then greatest(checkin_deadline, now() + make_interval(mins => cfg('checkin_minutes')::int)) else checkin_deadline end,
      away_deadline = case when status = 'away' then greatest(away_deadline, now() + interval '10 minutes') else away_deadline end,
      end_at = greatest(end_at, now() + interval '10 minutes')
    where id = h.reservation_id and status in ('reserved','in_use','away');
  update seat_reports set respond_deadline = greatest(respond_deadline, now() + interval '10 minutes')
    where reservation_id = h.reservation_id and status = 'pending';
  perform notify(h.user_id, '도움 요청 처리 완료', coalesce(nullif(p_resolution, ''), '관리자가 확인했습니다. 멈춰 있던 시간은 지금부터 다시 흐릅니다.'));
  perform log_admin('help:resolve', h.user_id, null, h.reservation_id, p_resolution);
end $$;

create or replace function admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d0 timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
begin
  perform require_admin();
  return jsonb_build_object(
    'today', jsonb_build_object(
      'reservations', (select count(*) from reservations where created_at >= d0),
      'no_shows', (select count(*) from reservations where created_at >= d0 and status = 'no_show'),
      'auto_returns', (select count(*) from reservations where ended_at >= d0 and end_reason in ('away_timeout','report')),
      'reports', (select count(*) from seat_reports where created_at >= d0),
      'active', (select count(*) from reservations where status in ('reserved','in_use','away'))),
    'reports', coalesce((select jsonb_agg(jsonb_build_object(
        'id', rep.id, 'created_at', rep.created_at, 'respond_deadline', rep.respond_deadline, 'occupancy_pct', rep.occupancy_pct,
        'seat_label', s.label, 'room_name', rm.name, 'room_id', rm.id,
        'owner_name', po.name, 'owner_sid', po.student_id, 'owner_id', po.id,
        'reporter_name', pr.name, 'reporter_sid', pr.student_id) order by rep.created_at)
      from seat_reports rep join seats s on s.id = rep.seat_id join rooms rm on rm.id = s.room_id
      join reservations r on r.id = rep.reservation_id join profiles po on po.id = r.user_id
      join profiles pr on pr.id = rep.reporter_id where rep.status = 'pending'), '[]'::jsonb),
    'helps', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'created_at', h.created_at, 'reason', h.reason, 'message', h.message, 'reservation_id', h.reservation_id,
        'name', p.name, 'student_id', p.student_id, 'user_id', p.id,
        'seat_label', s.label, 'room_name', rm.name, 'room_id', rm.id, 'seat_id', s.id, 'res_status', r.status) order by h.created_at)
      from help_requests h join profiles p on p.id = h.user_id
      left join reservations r on r.id = h.reservation_id left join seats s on s.id = coalesce(h.seat_id, r.seat_id) left join rooms rm on rm.id = s.room_id
      where h.status = 'open'), '[]'::jsonb),
    'appeals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'created_at', a.created_at, 'message', a.message, 'name', p.name, 'student_id', p.student_id, 'user_id', p.id,
        'penalty_type', pe.type, 'points', pe.points, 'note', pe.note, 'penalty_at', pe.created_at) order by a.created_at)
      from appeals a join profiles p on p.id = a.user_id join penalties pe on pe.id = a.penalty_id
      where a.status = 'open'), '[]'::jsonb));
end $$;

create or replace function my_help() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', h.id, 'reason', h.reason, 'message', h.message, 'created_at', h.created_at,
      'seat_label', s.label, 'room_name', rm.name)
  from help_requests h left join reservations r on r.id = h.reservation_id
    left join seats s on s.id = coalesce(h.seat_id, r.seat_id) left join rooms rm on rm.id = s.room_id
  where h.user_id = auth.uid() and h.status = 'open' order by h.created_at desc limit 1;
$$;
grant execute on function my_help() to authenticated;

notify pgrst, 'reload schema';
