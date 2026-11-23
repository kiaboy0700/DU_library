-- 자리비움 신고의 진행 단계와 취소
--   접수 → (관리자) 확인 중 → 결과.  관리자가 '확인 시작'을 누르면 양쪽에 알리고, 그동안 자동 반납은 멈춘다(관리자가 직접 결론을 낸다).
--   신고자는 결과가 나오기 전까지 신고를 취소할 수 있고, 학생은 도움 요청을 취소할 수 있다.
--   취소되거나 이용자가 돌아와 끝난 건은 관리자 화면에서 바로 사라지지 않고 한동안 '어떻게 끝났는지'와 함께 남는다.
alter table seat_reports add column if not exists stage text not null default 'received';
alter table seat_reports drop constraint if exists seat_reports_status_check;
alter table seat_reports add constraint seat_reports_status_check check (status in ('pending','dismissed','confirmed','closed','cancelled'));
alter table help_requests drop constraint if exists help_requests_status_check;
alter table help_requests add constraint help_requests_status_check check (status in ('open','resolved','cancelled'));

-- 관리자: 확인 시작
create or replace function admin_report_check(p_report bigint) returns void
language plpgsql security definer set search_path = public as $$
declare rep seat_reports; r reservations; lbl text;
begin
  perform require_admin();
  update seat_reports set stage = 'checking' where id = p_report and status = 'pending' and stage <> 'checking' returning * into rep;
  if not found then raise exception '이미 확인 중이거나 끝난 신고입니다.'; end if;
  select * into r from reservations where id = rep.reservation_id;
  select label into lbl from seats where id = rep.seat_id;
  perform notify(r.user_id, format('%s 관리자가 자리를 확인하고 있습니다', lbl), '자리에 있다면 지금 좌석 QR을 찍어 주세요. 비어 있으면 반납되고 벌점이 붙습니다.');
  perform notify(rep.reporter_id, format('%s 신고 · 관리자 확인 중', lbl), '결과가 나오면 알려 드립니다.', '/me#reports');
  perform log_admin('report:check', r.user_id, rep.seat_id, r.id, null);
end $$;
grant execute on function admin_report_check(bigint) to authenticated;

-- 신고자: 신고 취소
create or replace function cancel_report(p_report bigint) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); rep seat_reports; r reservations; lbl text; rname text; p profiles;
begin
  update seat_reports set status = 'cancelled', resolved_at = now(), resolved_by = 'reporter'
    where id = p_report and reporter_id = u and status = 'pending' returning * into rep;
  if not found then raise exception '취소할 수 없는 신고입니다.'; end if;
  select * into r from reservations where id = rep.reservation_id;
  select s.label, rm.name into lbl, rname from seats s join rooms rm on rm.id = s.room_id where s.id = rep.seat_id;
  select * into p from profiles where id = u;
  perform notify(r.user_id, format('%s 자리 확인 요청 취소', lbl), '신고가 취소되었습니다. 벌점은 없습니다.');
  perform notify_admins(format('신고 취소 · %s %s', rname, lbl), format('%s(%s) 학생이 신고를 취소했습니다.', p.name, p.student_id), '/admin/reports');
end $$;
grant execute on function cancel_report(bigint) to authenticated;

-- 학생: 도움 요청 취소. 멈춰 둔 마감은 지금부터 다시 센다
create or replace function cancel_help() returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); h help_requests; p profiles;
begin
  update help_requests set status = 'cancelled', resolution = '학생이 취소', resolved_at = now()
    where user_id = u and status = 'open' returning * into h;
  if not found then raise exception '취소할 도움 요청이 없습니다.'; end if;
  update reservations set on_hold = false,
      checkin_deadline = case when status = 'reserved' then greatest(checkin_deadline, now() + make_interval(mins => cfg('checkin_minutes')::int)) else checkin_deadline end,
      away_deadline = case when status = 'away' then greatest(away_deadline, now() + interval '10 minutes') else away_deadline end,
      end_at = greatest(end_at, now() + interval '10 minutes')
    where id = h.reservation_id and status in ('reserved','in_use','away');
  update seat_reports set respond_deadline = greatest(respond_deadline, now() + interval '10 minutes')
    where reservation_id = h.reservation_id and status = 'pending';
  select * into p from profiles where id = u;
  perform notify_admins('도움 요청 취소', format('%s(%s) 학생이 요청을 취소했습니다: %s', p.name, p.student_id, h.reason), '/admin/reports');
end $$;
grant execute on function cancel_help() to authenticated;

-- 내가 한 신고 중 처리 중인 것: 어느 단계인지, 관리자와 대화가 있는지
create or replace function my_reports() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'seat_label', s.label, 'room_name', rm.name, 'created_at', r.created_at,
      'stage', r.stage, 'respond_deadline', r.respond_deadline,
      'chat', r.chat_open or exists (select 1 from report_messages m where m.report_id = r.id)) order by r.created_at desc), '[]'::jsonb)
  from seat_reports r join seats s on s.id = r.seat_id join rooms rm on rm.id = s.room_id
  where r.reporter_id = auth.uid() and r.status = 'pending';
$$;


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
             where rep.status = 'pending' and rep.respond_deadline < now() and not res.on_hold and rep.stage <> 'checking'
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
        'reporter_name', pr.name, 'reporter_sid', pr.student_id, 'stage', rep.stage,
        'end_at', r.end_at, 'checked_in_at', r.checked_in_at, 'extend_count', r.extend_count) order by rep.created_at)
      from seat_reports rep join seats s on s.id = rep.seat_id join rooms rm on rm.id = s.room_id
      join reservations r on r.id = rep.reservation_id join profiles po on po.id = r.user_id
      join profiles pr on pr.id = rep.reporter_id where rep.status = 'pending'), '[]'::jsonb),
    -- 관리자가 처리하지 않았는데 끝난 건: 한 시간 동안 어떻게 끝났는지 보여 준다
    'recent_reports', coalesce((select jsonb_agg(jsonb_build_object(
        'id', rep.id, 'created_at', rep.created_at, 'resolved_at', rep.resolved_at, 'seat_label', s.label, 'room_name', rm.name,
        'owner_name', po.name, 'owner_sid', po.student_id, 'reporter_name', pr.name, 'reporter_sid', pr.student_id,
        'how', case when rep.status = 'cancelled' then 'cancelled' when rep.status = 'dismissed' then 'returned' when rep.status = 'confirmed' then 'auto' else 'closed' end)
        order by rep.resolved_at desc)
      from seat_reports rep join seats s on s.id = rep.seat_id join rooms rm on rm.id = s.room_id
      join reservations r on r.id = rep.reservation_id join profiles po on po.id = r.user_id
      join profiles pr on pr.id = rep.reporter_id
      where rep.status <> 'pending' and rep.resolved_by in ('owner','reporter','auto') and rep.resolved_at > now() - interval '1 hour'), '[]'::jsonb),
    'recent_helps', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'created_at', h.created_at, 'resolved_at', h.resolved_at, 'reason', h.reason, 'name', p.name, 'student_id', p.student_id)
        order by h.resolved_at desc)
      from help_requests h join profiles p on p.id = h.user_id
      where h.status = 'cancelled' and h.resolved_at > now() - interval '1 hour'), '[]'::jsonb),
    'helps', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'created_at', h.created_at, 'reason', h.reason, 'message', h.message, 'reservation_id', h.reservation_id,
        'name', p.name, 'student_id', p.student_id, 'user_id', p.id,
        'seat_label', s.label, 'room_name', rm.name, 'room_id', rm.id, 'seat_id', s.id, 'res_status', r.status, 'end_at', r.end_at,
        'deadline', case when r.status = 'reserved' then r.checkin_deadline when r.status = 'away' then r.away_deadline end) order by h.created_at)
      from help_requests h join profiles p on p.id = h.user_id
      left join reservations r on r.id = h.reservation_id left join seats s on s.id = coalesce(h.seat_id, r.seat_id) left join rooms rm on rm.id = s.room_id
      where h.status = 'open'), '[]'::jsonb),
    'appeals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'created_at', a.created_at, 'message', a.message, 'name', p.name, 'student_id', p.student_id, 'user_id', p.id,
        'penalty_type', pe.type, 'points', pe.points, 'note', pe.note, 'penalty_at', pe.created_at,
        'report_id', a.report_id, 'report_seat', (select rm.name || ' ' || st.label from seats st join rooms rm on rm.id = st.room_id where st.id = sr.seat_id),
        'report_at', sr.created_at) order by a.created_at)
      from appeals a join profiles p on p.id = a.user_id left join penalties pe on pe.id = a.penalty_id left join seat_reports sr on sr.id = a.report_id
      where a.status = 'open'), '[]'::jsonb));
end $$;

notify pgrst, 'reload schema';
