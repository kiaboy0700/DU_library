-- 빈틈 두 가지 메우기
--   1) 관리자가 '확인 시작'만 누르고 결론을 내지 않으면 자동 반납이 계속 멈춰 있었다 → 30분이 지나면 자동 처리로 돌아간다
--   2) 우선 예약권이 있는 학생이 다른 좌석을 예약하면 그 우선권 좌석이 쓸데없이 묶여 있었다 → 어느 좌석이든 예약하면 우선권은 바로 풀린다
alter table seat_reports add column if not exists checking_at timestamptz;
insert into settings(key, value) values ('report_check_minutes', '30') on conflict (key) do nothing;


create or replace function admin_report_check(p_report bigint) returns void
language plpgsql security definer set search_path = public as $$
declare rep seat_reports; r reservations; lbl text;
begin
  perform require_admin();
  update seat_reports set stage = 'checking', checking_at = now() where id = p_report and status = 'pending' and stage <> 'checking' returning * into rep;
  if not found then raise exception '이미 확인 중이거나 끝난 신고입니다.'; end if;
  select * into r from reservations where id = rep.reservation_id;
  select label into lbl from seats where id = rep.seat_id;
  perform notify(r.user_id, format('%s 관리자가 자리를 확인하고 있습니다', lbl), '자리에 있다면 지금 좌석 QR을 찍어 주세요. 비어 있으면 반납되고 벌점이 붙습니다.');
  perform notify(rep.reporter_id, format('%s 신고 · 관리자 확인 중', lbl), '결과가 나오면 알려 드립니다.', '/me#reports');
  perform log_admin('report:check', r.user_id, rep.seat_id, r.id, null);
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

create or replace function sync_seat_state() returns trigger
language plpgsql security definer set search_path = public as $$
declare sid int;
begin
  -- 예약이 끝나면 맡아 둔 이동 좌석도 풀어 준다
  if new.status not in ('reserved','in_use','away') then
    delete from seat_holds where reservation_id = new.id;
    -- 끝난 예약에 걸려 있던 신고는 더 처리할 것이 없다
    if exists (select 1 from seat_reports where reservation_id = new.id and status = 'pending' and stage = 'checking') then
      perform notify_admins(format('%s 이용자가 좌석을 반납했습니다', (select label from seats where id = new.seat_id)), '확인하러 가지 않아도 됩니다. 신고는 자동으로 끝났습니다.', '/admin/reports');
    end if;
    -- 이용자가 스스로 반납해 끝난 신고: 신고자에게도 알린다
    insert into notifications(user_id, title, body, url)
      select sr.reporter_id, format('신고한 %s 좌석이 반납되었습니다', (select label from seats where id = new.seat_id)), '이용자가 좌석을 반납했습니다.', '/rooms/' || (select room_id from seats where id = new.seat_id)
      from seat_reports sr where sr.reservation_id = new.id and sr.status = 'pending' and new.end_reason in ('user', 'expired');
    update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'auto' where reservation_id = new.id and status = 'pending';
  end if;
  -- 그 좌석을 예약했거나 그 좌석으로 옮겼으면 우선권은 다 쓴 것
  if tg_op = 'INSERT' or new.seat_id is distinct from old.seat_id then
    delete from seat_holds where user_id = new.user_id and kind = 'priority' and (tg_op = 'INSERT' or seat_id = new.seat_id);
  end if;
  for sid in select distinct x from unnest(array[new.seat_id, case when tg_op = 'UPDATE' then old.seat_id end]) x where x is not null
  loop
    perform resync_seat(sid);
  end loop;
  return null;
end $$;

notify pgrst, 'reload schema';
