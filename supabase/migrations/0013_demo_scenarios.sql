-- 관리자 시연 페이지: 층별 혼잡도 맞추기 + 학생 한 명을 원하는 상황으로 만들기

-- 두 열람실을 모두 가득 채울 수 있도록 채움용 가상 학생을 보탠다 (로그인용이 아님)
do $$
declare i int; sid text; nm text; dp text; gr int; uid uuid;
begin
  for i in 1..140 loop
    sid := '2599' || lpad(i::text, 4, '0');
    continue when exists (select 1 from profiles where student_id = sid);
    select left(a.name, 1) || substr(b.name, 2), c.department, c.grade into nm, dp, gr
      from (select name from profiles where is_virtual order by random() limit 1) a,
           (select name from profiles where is_virtual order by random() limit 1) b,
           (select department, grade from profiles where is_virtual order by random() limit 1) c;
    uid := create_account(sid, nm, dp, gr, gen_random_uuid()::text);
    update profiles set is_virtual = true where id = uid;
  end loop;
end $$;

-- 학생을 원하는 상태(reserved | in_use | away)로 만든다. 좌석이 없거나 다른 열람실이면 새로 잡는다
create or replace function demo_prepare(p_user uuid, p_room int, p_want text) returns bigint
language plpgsql security definer set search_path = public as $$
declare r reservations; sid int; rid bigint; room int;
begin
  update help_requests set status = 'resolved', resolution = '시연', resolved_at = now() where user_id = p_user and status = 'open';
  select res.* into r from reservations res where res.user_id = p_user and res.status in ('reserved','in_use','away');
  if found then
    select s.room_id into room from seats s where s.id = r.seat_id;
    update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'admin' where reservation_id = r.id and status = 'pending';
    if p_room is not null and room <> p_room then
      update reservations set status = 'cancelled', ended_at = now(), end_reason = 'admin', on_hold = false where id = r.id;
      r.id := null;
    end if;
  end if;
  if r.id is null then
    room := coalesce(p_room, (select id from rooms order by floor limit 1));
    select s.id into sid from seats s join seat_state ss on ss.seat_id = s.id
      where s.room_id = room and s.is_active and ss.state = 'free' order by random() limit 1;
    if sid is null then raise exception '빈 좌석이 없습니다. 혼잡도를 낮춘 뒤 다시 해 보세요.'; end if;
    insert into reservations(user_id, seat_id, status, end_at, checkin_deadline, by_admin)
      values (p_user, sid, 'reserved', now() + make_interval(mins => cfg('max_minutes')::int), now() + make_interval(mins => cfg('checkin_minutes')::int), true)
      returning id into rid;
  else
    rid := r.id;
  end if;
  if p_want = 'reserved' then
    update reservations set status = 'reserved', start_at = now(), end_at = now() + make_interval(mins => cfg('max_minutes')::int),
      checkin_deadline = now() + make_interval(mins => cfg('checkin_minutes')::int), checked_in_at = null,
      away_started_at = null, away_deadline = null, extend_count = 0, on_hold = false, notified_end = false, notified_away = false where id = rid;
  else
    update reservations set status = 'in_use', start_at = now() - interval '30 minutes', checked_in_at = now() - interval '30 minutes',
      end_at = now() + make_interval(mins => cfg('max_minutes')::int - 30), away_started_at = null, away_deadline = null,
      on_hold = false, notified_end = false, notified_away = false where id = rid;
    if p_want = 'away' then
      update reservations set status = 'away', away_started_at = now(), away_deadline = now() + make_interval(mins => away_minutes(room)) where id = rid;
    end if;
  end if;
  return rid;
end $$;
revoke execute on function demo_prepare(uuid, int, text) from public, anon, authenticated;

-- 학생의 지금 상태 요약
create or replace function demo_state(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'points', penalty_points(p.id),
    'banned_until', case when p.banned_until > now() then p.banned_until end,
    'help_open', exists (select 1 from help_requests h where h.user_id = p.id and h.status = 'open'),
    'res', (select jsonb_build_object('status', r.status, 'seat_label', s.label, 'room_name', ro.name, 'room_id', ro.id,
              'end_at', r.end_at, 'checkin_deadline', r.checkin_deadline, 'away_deadline', r.away_deadline, 'on_hold', r.on_hold,
              'report_deadline', (select sr.respond_deadline from seat_reports sr where sr.reservation_id = r.id and sr.status = 'pending' limit 1))
            from reservations r join seats s on s.id = r.seat_id join rooms ro on ro.id = s.room_id
            where r.user_id = p.id and r.status in ('reserved','in_use','away')))
  from profiles p where p.id = p_user;
$$;
revoke execute on function demo_state(uuid) from public, anon, authenticated;

create or replace function admin_demo(p_action text, p_student text default null, p_room int default null, p_arg text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p profiles; rid bigint; r reservations; s seats; rep uuid; mins int; msg text; rname text;
begin
  perform require_admin();

  -- 학생과 무관한 동작
  if p_action = 'tick' then
    perform tick();
    return jsonb_build_object('message', '자동 처리를 실행했습니다.');
  elsif p_action = 'mode' then
    delete from operating_periods where label = '시연';
    if p_arg in ('semester','vacation','exam') then
      -- 시연 중에는 다른 기간보다 먼저 적용되도록 겹치는 시험기간을 가리지 않게 한다
      insert into operating_periods(mode, label, start_date, end_date)
        values (p_arg, '시연', (now() at time zone 'Asia/Seoul')::date, (now() at time zone 'Asia/Seoul')::date);
    end if;
    perform log_admin('demo_mode', null, null, null, coalesce(p_arg, 'auto'));
    return jsonb_build_object('message', '운영 기간을 바꿨습니다.', 'mode', current_mode());
  elsif p_action = 'setting' then
    if p_student not in ('force_open','gps_disabled','incident_mode') then raise exception '바꿀 수 없는 설정입니다.'; end if;
    insert into settings(key, value) values (p_student, to_jsonb(p_arg = 'true'))
      on conflict (key) do update set value = excluded.value;
    perform log_admin('demo_setting', null, null, null, p_student || '=' || p_arg);
    return jsonb_build_object('message', '설정을 바꿨습니다.');
  end if;

  select * into p from profiles where student_id = trim(p_student) and role = 'student';
  if not found then raise exception '학생을 선택해 주세요.'; end if;

  if p_action = 'state' then
    return jsonb_build_object('state', demo_state(p.id));

  elsif p_action = 'reset' then
    update reservations set status = 'cancelled', ended_at = now(), end_reason = 'admin', on_hold = false
      where user_id = p.id and status in ('reserved','in_use','away');
    update help_requests set status = 'resolved', resolution = '시연 초기화', resolved_at = now() where user_id = p.id and status = 'open';
    delete from seat_holds where user_id = p.id;
    delete from penalties where user_id = p.id;
    delete from notifications where user_id = p.id;
    update profiles set banned_until = null, ban_reason = null, report_banned_until = null where id = p.id;
    msg := '처음 상태로 되돌렸습니다.';

  elsif p_action = 'reserved' then
    perform demo_prepare(p.id, p_room, 'reserved');
    msg := '체크인 대기 상태로 만들었습니다.';
  elsif p_action = 'checkin_soon' then
    rid := demo_prepare(p.id, p_room, 'reserved');
    update reservations set checkin_deadline = now() + interval '1 minute' where id = rid;
    msg := '체크인 마감을 1분 뒤로 당겼습니다.';
  elsif p_action = 'no_show' then
    rid := demo_prepare(p.id, p_room, 'reserved');
    update reservations set checkin_deadline = now() - interval '1 second' where id = rid;
    perform tick();
    msg := '체크인하지 않아 자동 취소되고 벌점이 붙었습니다.';

  elsif p_action = 'in_use' then
    perform demo_prepare(p.id, p_room, 'in_use');
    msg := '이용 중 상태로 만들었습니다.';
  elsif p_action = 'end_soon' then
    rid := demo_prepare(p.id, p_room, 'in_use');
    update reservations set end_at = now() + interval '9 minutes' where id = rid;
    perform tick();
    msg := '이용 종료를 9분 뒤로 당겼습니다. 연장할 수 있습니다.';
  elsif p_action = 'expire' then
    rid := demo_prepare(p.id, p_room, 'in_use');
    update reservations set end_at = now() - interval '1 second' where id = rid;
    perform tick();
    msg := '이용 시간이 끝나 자동 반납되었습니다.';

  elsif p_action = 'away' then
    rid := demo_prepare(p.id, p_room, 'away');
    select round(extract(epoch from (away_deadline - away_started_at)) / 60) into mins from reservations where id = rid;
    msg := format('외출 중 상태로 만들었습니다. 지금 혼잡도 기준 %s분.', mins);
  elsif p_action = 'away_soon' then
    rid := demo_prepare(p.id, p_room, 'away');
    update reservations set away_deadline = now() + interval '4 minutes' where id = rid;
    perform tick();
    msg := '복귀 마감을 4분 뒤로 당겼습니다.';
  elsif p_action = 'away_timeout' then
    rid := demo_prepare(p.id, p_room, 'away');
    update reservations set away_deadline = now() - interval '1 second' where id = rid;
    perform tick();
    msg := '외출 시간이 지나 자동 반납되고 벌점이 붙었습니다.';

  elsif p_action in ('report', 'report_timeout') then
    rid := demo_prepare(p.id, p_room, 'in_use');
    select * into r from reservations where id = rid;
    select * into s from seats where id = r.seat_id;
    select name into rname from rooms where id = s.room_id;
    -- 최근 24시간 동안 신고한 적이 없는 가상 학생이 신고한 것으로 한다
    select v.id into rep from profiles v where v.is_virtual
      and (v.report_banned_until is null or v.report_banned_until < now())
      and not exists (select 1 from seat_reports sr where sr.reporter_id = v.id and sr.created_at > now() - interval '24 hours')
      order by random() limit 1;
    mins := report_minutes(s.room_id);
    insert into seat_reports(seat_id, reservation_id, reporter_id, occupancy_pct, respond_deadline)
      values (s.id, r.id, rep, room_occupancy(s.room_id), now() + make_interval(mins => mins));
    perform notify(p.id, '자리 확인 요청', format('자리가 비어 있다는 신고가 접수되었습니다. %s분 안에 좌석 QR을 스캔하지 않으면 자동 반납되고 벌점이 부여됩니다.', mins));
    perform notify_admins('자리비움 신고 접수', format('%s %s 좌석 (응답 기한 %s분)', rname, s.label, mins), '/admin/reports');
    msg := format('자리비움 신고가 접수되었습니다. 응답 기한 %s분.', mins);
    if p_action = 'report_timeout' then
      update seat_reports set respond_deadline = now() - interval '1 second' where reservation_id = rid and status = 'pending';
      perform tick();
      msg := '신고에 응답하지 않아 자동 반납되고 벌점이 붙었습니다.';
    end if;

  elsif p_action = 'help' then
    select res.* into r from reservations res where res.user_id = p.id and res.status in ('reserved','in_use','away');
    if not found then
      rid := demo_prepare(p.id, p_room, 'reserved');
    else
      rid := r.id;
    end if;
    if not exists (select 1 from help_requests where user_id = p.id and status = 'open') then
      insert into help_requests(user_id, reservation_id, reason) values (p.id, rid, 'QR이 인식되지 않아요');
      perform notify_admins('도움 요청', format('%s(%s): %s', p.name, p.student_id, 'QR이 인식되지 않아요'), '/admin/reports');
    end if;
    update reservations set on_hold = true where id = rid;
    msg := '도움 요청이 접수되었습니다. 자동 취소·반납·벌점이 멈춥니다.';

  elsif p_action = 'penalty' then
    perform add_penalty(p.id, null, 'manual', greatest(coalesce(p_arg::int, 1), 1), '시연');
    msg := format('벌점 %s점을 부여했습니다.', greatest(coalesce(p_arg::int, 1), 1));

  else
    raise exception '알 수 없는 동작입니다.';
  end if;

  perform log_admin('demo:' || p_action, p.id, null, null, '시연');
  return jsonb_build_object('message', msg, 'state', demo_state(p.id));
end $$;
revoke execute on function admin_demo(text, text, int, text) from public, anon;
grant execute on function admin_demo(text, text, int, text) to authenticated;

notify pgrst, 'reload schema';
