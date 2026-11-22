-- 관리자 기능. 모든 함수는 관리자 확인 후 실행하고 admin_actions 에 기록한다.

create or replace function require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception '관리자만 할 수 있습니다.'; end if;
end $$;

create or replace function log_admin(p_action text, p_user uuid, p_seat int, p_res bigint, p_reason text) returns void
language sql security definer set search_path = public as $$
  insert into admin_actions(actor_id, action, target_user, seat_id, reservation_id, reason)
  values (auth.uid(), p_action, p_user, p_seat, p_res, p_reason);
$$;

-- 계정 생성 (학번 로그인: 내부적으로 {학번}@du-library.app 이메일 사용)
create or replace function create_account(p_student_id text, p_name text, p_department text, p_grade int, p_password text, p_role text default 'student')
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := gen_random_uuid(); mail text := lower(p_student_id) || '@du-library.app';
begin
  if exists (select 1 from profiles where student_id = p_student_id) then
    raise exception '이미 등록된 학번입니다: %', p_student_id;
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', mail,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('student_id', p_student_id, 'name', p_name),
    now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', mail, 'email_verified', true),
    'email', now(), now(), now());
  insert into profiles(id, student_id, name, department, grade, role) values (uid, p_student_id, p_name, p_department, p_grade, p_role);
  return uid;
end $$;
revoke execute on function create_account(text, text, text, int, text, text) from public, anon, authenticated;

create or replace function admin_create_account(p_student_id text, p_name text, p_department text, p_grade int, p_password text)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  perform require_admin();
  if length(coalesce(p_password, '')) < 8 then raise exception '비밀번호는 8자 이상이어야 합니다.'; end if;
  uid := create_account(trim(p_student_id), trim(p_name), p_department, p_grade, p_password, 'student');
  perform log_admin('create_account', uid, null, null, null);
  return uid;
end $$;

create or replace function admin_reset_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform require_admin();
  if length(coalesce(p_password, '')) < 8 then raise exception '비밀번호는 8자 이상이어야 합니다.'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_user;
  perform log_admin('reset_password', p_user, null, null, null);
end $$;

create or replace function admin_set_role(p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if p_user = auth.uid() then raise exception '본인의 권한은 바꿀 수 없습니다.'; end if;
  update profiles set role = p_role where id = p_user;
  perform log_admin('set_role:' || p_role, p_user, null, null, null);
end $$;

-- 대리 예약 (기본: 바로 체크인 상태로)
create or replace function admin_reserve(p_student_id text, p_seat int, p_reason text, p_checkin boolean default true) returns bigint
language plpgsql security definer set search_path = public as $$
declare p profiles; s seats; st record; e timestamptz; rid bigint;
begin
  perform require_admin();
  select * into p from profiles where student_id = trim(p_student_id);
  if not found then raise exception '등록되지 않은 학번입니다.'; end if;
  select * into s from seats where id = p_seat;
  if not found or not s.is_active then raise exception '사용할 수 없는 좌석입니다.'; end if;
  select * into st from room_status(s.room_id);
  e := now() + make_interval(mins => cfg('max_minutes')::int);
  if st.closes_at is not null then e := least(e, st.closes_at); end if;
  begin
    insert into reservations(user_id, seat_id, status, end_at, checkin_deadline, checked_in_at, by_admin)
      values (p.id, p_seat, case when p_checkin then 'in_use' else 'reserved' end, e,
              now() + make_interval(mins => cfg('checkin_minutes')::int), case when p_checkin then now() end, true)
      returning id into rid;
  exception when unique_violation then
    raise exception '이미 사용 중인 좌석이거나, 해당 학생이 이용 중인 좌석이 있습니다.';
  end;
  perform log_admin('reserve', p.id, p_seat, rid, p_reason);
  perform notify(p.id, '관리자가 좌석을 배정했습니다', format('%s 좌석이 배정되었습니다.', s.label));
  return rid;
end $$;

-- 예약에 대한 대리 처리: check_in | come_back | extend | return | move | away
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

-- 자리비움 신고 처리: confirm(비어 있음 확정) | dismiss(착석 확인) | extend(응답 시간 10분 연장)
create or replace function admin_resolve_report(p_report bigint, p_decision text) returns void
language plpgsql security definer set search_path = public as $$
declare rep seat_reports; r reservations; s seats; pts int; busy boolean;
begin
  perform require_admin();
  select * into rep from seat_reports where id = p_report and status = 'pending';
  if not found then raise exception '이미 처리된 신고입니다.'; end if;
  select * into r from reservations where id = rep.reservation_id;
  select * into s from seats where id = rep.seat_id;
  if p_decision = 'confirm' then
    busy := rep.occupancy_pct >= cfg('occ_high') or current_mode() = 'exam';
    pts := case when busy then cfg('pen_report_busy') else cfg('pen_report') end;
    update seat_reports set status = 'confirmed', resolved_at = now(), resolved_by = 'admin' where id = rep.id;
    perform end_reservation(r.id, 'report');
    perform add_penalty(r.user_id, r.id, 'vacancy_report', pts, format('%s 좌석 자리비움 (관리자 현장 확인)', s.label));
    perform notify(rep.reporter_id, '신고 결과 안내', format('%s 좌석이 반납 처리되어 빈자리가 되었습니다.', s.label), '/rooms/' || s.room_id);
  elsif p_decision = 'dismiss' then
    update seat_reports set status = 'dismissed', resolved_at = now(), resolved_by = 'admin' where id = rep.id;
    perform notify(r.user_id, '자리 확인 완료', '관리자가 자리에 있음을 확인했습니다. 벌점은 없습니다.');
    perform notify(rep.reporter_id, '신고 결과 안내', format('%s 좌석은 이용자가 자리에 있는 것으로 확인되었습니다.', s.label));
  elsif p_decision = 'extend' then
    update seat_reports set respond_deadline = respond_deadline + interval '10 minutes' where id = rep.id;
  else
    raise exception '알 수 없는 처리입니다.';
  end if;
  perform log_admin('report:' || p_decision, r.user_id, s.id, r.id, null);
end $$;

create or replace function refresh_ban(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  -- 벌점 누적으로 걸린 정지는 벌점이 기준 아래로 내려가면 해제
  if penalty_points(p_user) < cfg('ban1_points') then
    update profiles set banned_until = null, ban_reason = null where id = p_user and ban_reason like '벌점%';
  end if;
end $$;

create or replace function admin_penalty(p_user uuid, p_points int, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if coalesce(p_points, 0) <= 0 then raise exception '벌점은 1점 이상이어야 합니다.'; end if;
  perform add_penalty(p_user, null, 'manual', p_points, coalesce(nullif(p_note, ''), '관리자 부여'));
  perform log_admin('penalty:' || p_points, p_user, null, null, p_note);
end $$;

create or replace function admin_revoke_penalty(p_penalty bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare pe penalties;
begin
  perform require_admin();
  update penalties set revoked_at = now() where id = p_penalty and revoked_at is null returning * into pe;
  if not found then raise exception '이미 취소된 벌점입니다.'; end if;
  perform refresh_ban(pe.user_id);
  perform notify(pe.user_id, '벌점이 취소되었습니다', format('%s점 취소 (%s)', pe.points, coalesce(nullif(p_reason, ''), '관리자 처리')));
  perform log_admin('revoke_penalty', pe.user_id, null, pe.reservation_id, p_reason);
end $$;

-- p_days = 0 이면 정지 해제
create or replace function admin_ban(p_user uuid, p_days int, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if coalesce(p_days, 0) <= 0 then
    update profiles set banned_until = null, ban_reason = null where id = p_user;
    perform notify(p_user, '예약 정지가 해제되었습니다', '다시 좌석을 예약할 수 있습니다.');
    perform log_admin('unban', p_user, null, null, p_reason);
  else
    update profiles set banned_until = now() + make_interval(days => p_days),
      ban_reason = '관리자: ' || coalesce(nullif(p_reason, ''), '사유 미기재') where id = p_user;
    perform notify(p_user, '예약이 정지되었습니다', format('%s일간 예약할 수 없습니다. 사유: %s', p_days, coalesce(nullif(p_reason, ''), '관리자 조치')));
    perform log_admin('ban:' || p_days, p_user, null, null, p_reason);
  end if;
end $$;

create or replace function admin_resolve_appeal(p_appeal bigint, p_approve boolean, p_reply text) returns void
language plpgsql security definer set search_path = public as $$
declare a appeals;
begin
  perform require_admin();
  update appeals set status = case when p_approve then 'approved' else 'rejected' end, reply = p_reply, resolved_at = now()
    where id = p_appeal and status = 'open' returning * into a;
  if not found then raise exception '이미 처리된 이의신청입니다.'; end if;
  if p_approve then
    update penalties set revoked_at = now() where id = a.penalty_id and revoked_at is null;
    perform refresh_ban(a.user_id);
    perform notify(a.user_id, '이의신청이 승인되었습니다', coalesce(nullif(p_reply, ''), '벌점이 취소되었습니다.'));
  else
    perform notify(a.user_id, '이의신청이 반려되었습니다', coalesce(nullif(p_reply, ''), '벌점이 유지됩니다.'));
  end if;
  perform log_admin('appeal:' || case when p_approve then 'approve' else 'reject' end, a.user_id, null, null, p_reply);
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
  update reservations set on_hold = false, checkin_deadline = now() + make_interval(mins => cfg('checkin_minutes')::int)
    where id = h.reservation_id and status = 'reserved';
  perform notify(h.user_id, '도움 요청이 처리되었습니다', coalesce(nullif(p_resolution, ''), '관리자가 확인했습니다.'));
  perform log_admin('help:resolve', h.user_id, null, h.reservation_id, p_resolution);
end $$;

-- 좌석 사용 중지/재개 (여러 좌석·구역 단위). 중지 시 이용 중이던 학생은 벌점 없이 반납
create or replace function admin_set_seats(p_ids int[], p_active boolean, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int;
begin
  perform require_admin();
  update seats set is_active = p_active, inactive_reason = case when p_active then null else p_reason end where id = any(p_ids);
  get diagnostics n = row_count;
  if not p_active then
    for r in select id, user_id from reservations where seat_id = any(p_ids) and status in ('reserved','in_use','away')
    loop
      perform end_reservation(r.id, 'admin');
      perform notify(r.user_id, '좌석 사용이 중지되었습니다', format('사유: %s. 다른 좌석을 예약해 주세요. (벌점 없음)', coalesce(nullif(p_reason, ''), '시설 점검')), '/');
    end loop;
  end if;
  perform log_admin(case when p_active then 'seats:on' else 'seats:off' end, null, p_ids[1], null, format('%s석: %s', n, p_reason));
  return n;
end $$;

create or replace function admin_close_room(p_room int, p_closed boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  perform require_admin();
  update rooms set is_closed = p_closed, closed_reason = case when p_closed then p_reason end where id = p_room;
  if p_closed then
    for r in select res.id, res.user_id from reservations res join seats s on s.id = res.seat_id
             where s.room_id = p_room and res.status in ('reserved','in_use','away')
    loop
      perform end_reservation(r.id, 'room_closed');
      perform notify(r.user_id, '열람실이 임시 폐쇄되었습니다', format('사유: %s. 좌석이 반납되었습니다. (벌점 없음)', coalesce(nullif(p_reason, ''), '시설 점검')), '/');
    end loop;
  end if;
  perform log_admin(case when p_closed then 'room:close' else 'room:open' end, null, null, null, p_reason);
end $$;

create or replace function admin_regen_qr(p_seat int) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  perform require_admin();
  update seats set qr_token = gen_random_uuid() where id = p_seat returning qr_token into t;
  perform log_admin('regen_qr', null, p_seat, null, null);
  return t;
end $$;

create or replace function admin_announce(p_title text, p_body text, p_room int, p_hours int, p_push boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  insert into announcements(room_id, title, body, until)
    values (p_room, p_title, coalesce(p_body, ''), case when p_hours > 0 then now() + make_interval(hours => p_hours) end);
  if p_push then
    insert into notifications(user_id, title, body, url)
      select distinct user_id, '[공지] ' || p_title, coalesce(p_body, ''), '/' from push_subscriptions;
  end if;
  perform log_admin('announce', null, null, null, p_title);
end $$;

-- 관리자 좌석맵: 좌석별 이용자 정보
create or replace function admin_room_map(p_room int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'seat_id', s.id, 'label', s.label, 'zone', s.zone, 'seat_type', s.seat_type, 'x', s.x, 'y', s.y,
      'is_active', s.is_active, 'inactive_reason', s.inactive_reason, 'qr_token', s.qr_token,
      'res', case when r.id is not null then jsonb_build_object(
        'id', r.id, 'status', r.status, 'start_at', r.start_at, 'end_at', r.end_at, 'checkin_deadline', r.checkin_deadline,
        'away_deadline', r.away_deadline, 'extend_count', r.extend_count, 'on_hold', r.on_hold, 'by_admin', r.by_admin,
        'user_id', p.id, 'student_id', p.student_id, 'name', p.name, 'department', p.department, 'grade', p.grade,
        'points', penalty_points(p.id),
        'report', exists (select 1 from seat_reports sr where sr.reservation_id = r.id and sr.status = 'pending')) end)
      order by s.id)
    from seats s
    left join reservations r on r.seat_id = s.id and r.status in ('reserved','in_use','away')
    left join profiles p on p.id = r.user_id
    where s.room_id = p_room), '[]'::jsonb);
end $$;

-- 처리 대기 큐 + 오늘 현황
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
        'seat_label', s.label, 'room_name', rm.name, 'res_status', r.status) order by h.created_at)
      from help_requests h join profiles p on p.id = h.user_id
      left join reservations r on r.id = h.reservation_id left join seats s on s.id = r.seat_id left join rooms rm on rm.id = s.room_id
      where h.status = 'open'), '[]'::jsonb),
    'appeals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'created_at', a.created_at, 'message', a.message, 'name', p.name, 'student_id', p.student_id, 'user_id', p.id,
        'penalty_type', pe.type, 'points', pe.points, 'note', pe.note, 'penalty_at', pe.created_at) order by a.created_at)
      from appeals a join profiles p on p.id = a.user_id join penalties pe on pe.id = a.penalty_id
      where a.status = 'open'), '[]'::jsonb));
end $$;

create or replace function admin_search_users(p_q text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object('id', p.id, 'student_id', p.student_id, 'name', p.name, 'department', p.department, 'grade', p.grade,
      'role', p.role, 'banned_until', p.banned_until, 'ban_reason', p.ban_reason, 'points', penalty_points(p.id),
      'active', exists (select 1 from reservations r where r.user_id = p.id and r.status in ('reserved','in_use','away'))) x
    from profiles p
    where coalesce(trim(p_q), '') = '' and p.role = 'student' and (p.banned_until > now() or p.report_banned_until > now() or penalty_points(p.id) > 0)
       or coalesce(trim(p_q), '') <> '' and (p.student_id ilike '%' || trim(p_q) || '%' or p.name ilike '%' || trim(p_q) || '%')
    order by p.student_id limit 50) q), '[]'::jsonb);
end $$;

create or replace function admin_user_detail(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return jsonb_build_object(
    'profile', (select to_jsonb(p) from profiles p where p.id = p_user),
    'points', penalty_points(p_user),
    'penalties', coalesce((select jsonb_agg(to_jsonb(pe) order by pe.created_at desc) from penalties pe where pe.user_id = p_user), '[]'::jsonb),
    'reservations', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', r.id, 'status', r.status, 'start_at', r.start_at, 'end_at', r.end_at, 'ended_at', r.ended_at,
        'end_reason', r.end_reason, 'seat_label', s.label, 'room_name', rm.name, 'by_admin', r.by_admin) x
      from reservations r join seats s on s.id = r.seat_id join rooms rm on rm.id = s.room_id
      where r.user_id = p_user order by r.created_at desc limit 20) q), '[]'::jsonb),
    'reports_made', (select count(*) from seat_reports where reporter_id = p_user),
    'reports_dismissed', (select count(*) from seat_reports where reporter_id = p_user and status = 'dismissed'));
end $$;

create or replace function admin_stats(p_days int default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return jsonb_build_object(
    'daily', coalesce((select jsonb_agg(x order by x->>'day') from (
      select jsonb_build_object('day', d::date,
        'reservations', (select count(*) from reservations r where (r.created_at at time zone 'Asia/Seoul')::date = d::date),
        'no_shows', (select count(*) from reservations r where (r.created_at at time zone 'Asia/Seoul')::date = d::date and r.status = 'no_show'),
        'auto_returns', (select count(*) from reservations r where (r.ended_at at time zone 'Asia/Seoul')::date = d::date and r.end_reason in ('away_timeout','report')),
        'reports', (select count(*) from seat_reports sr where (sr.created_at at time zone 'Asia/Seoul')::date = d::date),
        'penalty_points', (select coalesce(sum(points), 0) from penalties pe where (pe.created_at at time zone 'Asia/Seoul')::date = d::date and pe.revoked_at is null)) x
      from generate_series((now() at time zone 'Asia/Seoul')::date - (p_days - 1), (now() at time zone 'Asia/Seoul')::date, interval '1 day') d) q), '[]'::jsonb),
    'totals', jsonb_build_object(
      'users', (select count(*) from profiles where role = 'student'),
      'banned', (select count(*) from profiles where banned_until > now()),
      'avg_minutes', (select coalesce(round(avg(extract(epoch from (ended_at - checked_in_at)) / 60)), 0) from reservations where status = 'ended' and checked_in_at is not null and ended_at > now() - make_interval(days => p_days)),
      'recovered', (select count(*) from reservations where (status = 'no_show' or end_reason in ('away_timeout','report')) and created_at > now() - make_interval(days => p_days))),
    'actions', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', a.id, 'created_at', a.created_at, 'action', a.action, 'reason', a.reason,
        'actor', pa.name, 'target', pt.name, 'target_sid', pt.student_id) x
      from admin_actions a left join profiles pa on pa.id = a.actor_id left join profiles pt on pt.id = a.target_user
      order by a.created_at desc limit 40) q), '[]'::jsonb));
end $$;

revoke execute on function log_admin(text, uuid, int, bigint, text), refresh_ban(uuid) from public, anon, authenticated;

-- 1분마다 자동 처리
do $$
begin
  perform cron.unschedule('du-library-tick');
exception when others then null;
end $$;
select cron.schedule('du-library-tick', '* * * * *', 'select public.tick()');
