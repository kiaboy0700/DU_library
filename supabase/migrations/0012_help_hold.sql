-- 도움 요청과 시간 여유
--
-- 학생이 QR을 못 찍는 문제로 도움을 요청하면, 관리자가 처리하기 전에 불이익을 받지 않아야 한다.
--   1) 도움 요청을 누르는 순간, 예약 상태가 무엇이든 자동 취소·자동 반납·벌점·이용 시간 종료가 모두 멈춘다
--      (전에는 체크인 전 예약만 멈췄다. 외출 복귀나 자리 확인 요청에 QR을 못 찍는 경우는 벌점이 붙었다)
--   2) 관리자는 처리 전에 '시간 더 주기'로 지금 걸려 있는 마감을 늘려 줄 수 있다
--   3) 관리자가 요청을 완료하면, 멈춘 동안 지나간 마감은 그때부터 다시 센다

create or replace function request_help(p_reason text, p_message text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations; p profiles;
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  if exists (select 1 from help_requests where user_id = u and status = 'open') then
    raise exception '이미 접수된 도움 요청이 있습니다. 관리자가 확인 중입니다.';
  end if;
  select * into r from reservations where user_id = u and status in ('reserved','in_use','away');
  select * into p from profiles where id = u;
  insert into help_requests(user_id, reservation_id, reason, message) values (u, r.id, p_reason, p_message);
  -- 체크인 전이든, 외출 중이든, 자리 확인 요청을 받았든: 관리자가 처리할 때까지 자동 취소·반납·벌점을 멈춘다
  if r.id is not null then
    update reservations set on_hold = true where id = r.id;
  end if;
  perform notify_admins('도움 요청', format('%s(%s): %s', p.name, p.student_id, p_reason), '/admin/reports');
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
    perform notify(r.user_id, '도움 요청이 닫혔습니다', '오래 처리되지 않아 자동으로 닫혔습니다. 문제가 계속되면 다시 요청해 주세요.');
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
        perform notify(r.reporter_id, '신고 결과 안내', format('%s 좌석이 반납 처리되어 빈자리가 되었습니다.', r.label), '/rooms/' || r.room_id);
      else
        update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'auto' where id = r.report_id;
      end if;
    end loop;
  end if;

  -- 4) 이용 시간 종료
  for r in select id, user_id from reservations where status in ('reserved','in_use','away') and end_at < now() and not on_hold
  loop
    perform end_reservation(r.id, 'expired');
    perform notify(r.user_id, '이용 시간이 끝났습니다', '좌석이 자동으로 반납되었습니다.');
  end loop;

  -- 5) 폐관·임시 폐쇄된 열람실 정리
  for r in select res.id, res.user_id from reservations res join seats s on s.id = res.seat_id,
           lateral room_status(s.room_id) st
           where res.status in ('reserved','in_use','away') and not st.is_open
  loop
    perform end_reservation(r.id, 'closing');
    perform notify(r.user_id, '열람실 운영이 종료되었습니다', '좌석이 자동으로 반납되었습니다. (벌점 없음)');
  end loop;

  -- 6) 미리 알림
  for r in select id, user_id from reservations where status in ('in_use','away') and not notified_end and end_at < now() + interval '10 minutes'
  loop
    update reservations set notified_end = true where id = r.id;
    perform notify(r.user_id, '이용 시간 종료 10분 전', '계속 이용하려면 지금 연장하세요.');
  end loop;
  for r in select id, user_id from reservations where status = 'away' and not notified_away and away_deadline < now() + interval '5 minutes'
  loop
    update reservations set notified_away = true where id = r.id;
    perform notify(r.user_id, '외출 시간 종료 5분 전', '자리로 돌아와 좌석 QR을 스캔하세요. 시간이 지나면 자동 반납됩니다.');
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
  perform notify(h.user_id, '도움 요청이 처리되었습니다', coalesce(nullif(p_resolution, ''), '관리자가 확인했습니다.'));
  perform log_admin('help:resolve', h.user_id, null, h.reservation_id, p_resolution);
end $$;

create or replace function admin_res_action(p_res bigint, p_action text, p_reason text, p_arg int default null) returns void
language plpgsql security definer set search_path = public as $$
declare r reservations; s seats; st record; new_end timestamptz;
begin
  perform require_admin();
  select * into r from reservations where id = p_res and status in ('reserved','in_use','away');
  if not found then raise exception '진행 중인 예약이 아닙니다.'; end if;
  select * into s from seats where id = r.seat_id;
  if p_action = 'check_in' then
    if r.status <> 'reserved' then raise exception '체크인 대기 상태가 아닙니다.'; end if;
    update reservations set status = 'in_use', checked_in_at = now(), on_hold = false where id = r.id;
    perform notify(r.user_id, '관리자가 체크인을 처리했습니다', format('%s 좌석 이용이 시작되었습니다.', s.label));
  elsif p_action = 'come_back' then
    if r.status <> 'away' then raise exception '외출 상태가 아닙니다.'; end if;
    update reservations set status = 'in_use', away_started_at = null, away_deadline = null where id = r.id;
    perform notify(r.user_id, '관리자가 복귀를 처리했습니다', format('%s 좌석', s.label));
  elsif p_action = 'away' then
    if r.status <> 'in_use' then raise exception '이용 중 상태가 아닙니다.'; end if;
    update reservations set status = 'away', away_started_at = now(),
      away_deadline = least(now() + make_interval(mins => away_minutes(s.room_id)), end_at), notified_away = false where id = r.id;
  elsif p_action = 'extend' then
    select * into st from room_status(s.room_id);
    new_end := r.end_at + make_interval(mins => coalesce(p_arg, cfg('extend_minutes')::int));
    if st.closes_at is not null then new_end := least(new_end, st.closes_at); end if;
    update reservations set end_at = new_end, notified_end = false where id = r.id;
    perform notify(r.user_id, '관리자가 이용 시간을 연장했습니다', format('%s 좌석', s.label));
  elsif p_action = 'grace' then
    -- 문제가 생긴 학생에게 지금 걸려 있는 마감을 p_arg분(기본 15분) 더 준다
    update reservations set
        checkin_deadline = case when status = 'reserved' then greatest(checkin_deadline, now()) + make_interval(mins => coalesce(p_arg, 15)) else checkin_deadline end,
        away_deadline = case when status = 'away' then greatest(away_deadline, now()) + make_interval(mins => coalesce(p_arg, 15)) else away_deadline end,
        end_at = case when end_at < now() + make_interval(mins => coalesce(p_arg, 15)) then now() + make_interval(mins => coalesce(p_arg, 15)) else end_at end,
        notified_away = false
      where id = r.id;
    update seat_reports set respond_deadline = greatest(respond_deadline, now()) + make_interval(mins => coalesce(p_arg, 15))
      where reservation_id = r.id and status = 'pending';
    perform notify(r.user_id, '관리자가 시간을 더 드렸습니다', format('%s 좌석 · %s분', s.label, coalesce(p_arg, 15)));
  elsif p_action = 'return' then
    perform end_reservation(r.id, 'admin');
    perform notify(r.user_id, '관리자가 좌석을 반납 처리했습니다', coalesce(nullif(p_reason, ''), format('%s 좌석', s.label)));
    if coalesce(p_arg, 0) > 0 then
      perform add_penalty(r.user_id, r.id, 'manual', p_arg, coalesce(nullif(p_reason, ''), '관리자 부여'));
    end if;
  elsif p_action = 'move' then
    if not exists (select 1 from seats where id = p_arg and is_active) then raise exception '옮길 좌석을 사용할 수 없습니다.'; end if;
    begin
      update reservations set seat_id = p_arg where id = r.id;
    exception when unique_violation then
      raise exception '옮길 좌석이 이미 사용 중입니다.';
    end;
    perform notify(r.user_id, '좌석이 변경되었습니다', format('%s → %s (남은 시간은 그대로입니다)', s.label, (select label from seats where id = p_arg)));
  else
    raise exception '알 수 없는 동작입니다.';
  end if;
  perform log_admin('res:' || p_action, r.user_id, r.seat_id, r.id, p_reason);
end $$;

notify pgrst, 'reload schema';
