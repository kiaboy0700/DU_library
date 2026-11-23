-- 연장 횟수는 하루 두 번, 0시와 12시에 0으로 돌아간다 (오전·오후 각각 한도를 새로 받는다).
-- 오래 공부하는 학생도 반나절마다 다시 연장할 수 있고, 혼잡할 때 한 사람이 하루 종일 자리를 잡는 것은 막는다.
alter table reservations add column if not exists extend_reset_at timestamptz not null default now();

-- 지금 속한 구간이 시작된 시각 (오늘 0시 또는 12시, 한국 시간)
create or replace function extend_window_start() returns timestamptz
language sql stable as $$
  select (date_trunc('day', now() at time zone 'Asia/Seoul')
          + case when extract(hour from now() at time zone 'Asia/Seoul') >= 12 then interval '12 hours' else interval '0' end) at time zone 'Asia/Seoul';
$$;

-- 새 예약은 이번 구간에 이미 쓴 연장 횟수를 물려받는다 (좌석을 바꿔도 합산)
create or replace function carry_extends() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.extend_reset_at := now();
  new.extend_count := greatest(new.extend_count, coalesce((
    select max(extend_count) from reservations
    where user_id = new.user_id and extend_reset_at >= extend_window_start()), 0));
  return new;
end $$;


create or replace function extend_reservation(p_token uuid default null, p_lat double precision default null, p_lng double precision default null) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations; s seats; st record; new_end timestamptz; is_exam boolean;
begin
  select * into r from reservations where user_id = u and status = 'in_use';
  if not found then raise exception '이용 중(체크인 완료)인 좌석만 연장할 수 있습니다.'; end if;
  select * into s from seats where id = r.seat_id;
  -- 0시·12시를 넘겼으면 횟수를 새로 센다
  if r.extend_reset_at < extend_window_start() then
    update reservations set extend_count = 0, extend_reset_at = now() where id = r.id;
    r.extend_count := 0;
  end if;
  if r.end_at - now() > make_interval(mins => cfg('extend_window_min')::int) then
    raise exception '종료 %분 전부터 연장할 수 있습니다.', cfg('extend_window_min')::int;
  end if;
  select * into st from room_status(s.room_id);
  is_exam := st.mode = 'exam';
  if is_exam then
    if p_token is null or p_token <> s.qr_token then
      raise exception '시험기간에는 내 좌석의 QR을 스캔해야 연장할 수 있습니다.';
    end if;
    perform gps_check(p_lat, p_lng);
  end if;
  if room_occupancy(s.room_id) >= cfg('occ_high') and r.extend_count >= cfg('max_extends') then
    raise exception '지금은 혼잡해서 연장은 %회까지입니다. 이미 %회 연장했습니다. (0시·12시에 다시 셉니다)', cfg('max_extends')::int, r.extend_count;
  end if;
  new_end := r.end_at + make_interval(mins => cfg('extend_minutes')::int);
  if st.closes_at is not null then new_end := least(new_end, st.closes_at); end if;
  if not st.is_open or new_end <= r.end_at then raise exception '폐관 시각이라 더 연장할 수 없습니다.'; end if;
  update reservations set end_at = new_end, extend_count = extend_count + 1, notified_end = false where id = r.id;
  return new_end;
end $$;

create or replace function tick() returns void
language plpgsql security definer set search_path = public as $$
declare r record; pts int; busy boolean; url text; secret text; pri boolean;
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
               and (rep.stage <> 'checking' or rep.checking_at < now() - make_interval(mins => coalesce(cfg('report_check_minutes'), 30)::int))
    loop
      if r.status = 'in_use' then
        busy := r.occupancy_pct >= cfg('occ_high') or current_mode() = 'exam';
        pts := case when busy then cfg('pen_report_busy') else cfg('pen_report') end;
        update seat_reports set status = 'confirmed', resolved_at = now(), resolved_by = 'auto' where id = r.report_id;
        pri := grant_report_priority((select seat_id from reservations where id = r.id), r.reporter_id);
        perform end_reservation(r.id, 'report');
        perform add_penalty(r.user_id, r.id, 'vacancy_report', pts, format('%s 좌석 자리비움 신고 확인 요청에 응답하지 않음', r.label));
        perform notify(r.reporter_id, format('신고한 %s 좌석이 반납되었습니다', r.label),
          case when pri then priority_text(r.reporter_id) else '지금 빈자리입니다.' end,
          case when pri then '/s/' || (select qr_token from seats where id = (select seat_id from reservations where id = r.id)) else '/rooms/' || r.room_id end);
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

  -- 6-1) 기다리는 좌석의 이용 종료 5분 전
  for r in select w.user_id, w.seat_id, st.label, st.room_id from seat_watches w join seats st on st.id = w.seat_id
             join reservations res on res.seat_id = w.seat_id and res.status in ('in_use','away')
           where not w.warned and res.end_at < now() + interval '5 minutes'
  loop
    update seat_watches set warned = true where user_id = r.user_id and seat_id = r.seat_id;
    perform notify(r.user_id, format('%s 5분 뒤 이용 종료 예정', r.label), '이용자가 연장하면 더 늦어집니다. 비면 다시 알려 드립니다.', '/rooms/' || r.room_id);
  end loop;

  -- 6-2) 0시·12시가 지나면 이용 중인 좌석의 연장 횟수를 0으로 (화면의 '남은 연장'도 함께 바뀐다)
  update reservations set extend_count = 0, extend_reset_at = now()
    where status in ('reserved','in_use','away') and extend_reset_at < extend_window_start();

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

notify pgrst, 'reload schema';
