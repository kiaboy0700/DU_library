-- 규칙 엔진: 설정값, 운영시간, 혼잡도, 예약 상태 전이 (모두 Asia/Seoul 기준)

create or replace function cfg(k text) returns numeric
language sql stable security definer set search_path = public as $$
  select (value #>> '{}')::numeric from settings where key = k;
$$;

create or replace function cfgb(k text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::boolean from settings where key = k), false);
$$;

create or replace function current_mode(d date default (now() at time zone 'Asia/Seoul')::date) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select mode from operating_periods where d between start_date and end_date
      order by (mode = 'exam') desc, start_date desc limit 1),
    'semester');
$$;

-- 열람실이 지금 열려 있는지, 언제 닫는지
create or replace function room_status(p_room int, p_at timestamptz default now())
returns table (is_open boolean, closes_at timestamptz, mode text, reason text)
language plpgsql stable security definer set search_path = public as $$
declare
  r rooms;
  loc timestamp := p_at at time zone 'Asia/Seoul';
  d date := (p_at at time zone 'Asia/Seoul')::date;
  m text;
  o int; c int;
  pend date;
  cd_reason text;
begin
  select * into r from rooms where id = p_room;
  m := current_mode(d);
  if r.is_closed then
    return query select false, null::timestamptz, m, coalesce(r.closed_reason, '임시 폐쇄'); return;
  end if;
  if cfgb('force_open') then
    return query select true, null::timestamptz, m, null::text; return;
  end if;
  if m = 'exam' and r.open_24h_in_exam then
    select max(end_date) into pend from operating_periods
      where operating_periods.mode = 'exam' and d between start_date and end_date;
    return query select true, ((pend + 1)::timestamp at time zone 'Asia/Seoul'), m, null::text; return;
  end if;
  if extract(isodow from d) >= 6 then
    return query select false, null::timestamptz, m, '주말 휴관'::text; return;
  end if;
  select coalesce(cd.reason, '휴관일') into cd_reason from closed_days cd where cd.day = d;
  if found then
    return query select false, null::timestamptz, m, cd_reason; return;
  end if;
  if m = 'vacation' then
    o := cfg('vacation_open'); c := cfg('vacation_close');
  else
    o := cfg('semester_open'); c := cfg('semester_close');
  end if;
  if loc::time < make_time(o, 0, 0) then
    return query select false, null::timestamptz, m, format('개관 전 (%s시 개관)', o); return;
  end if;
  if loc::time >= make_time(c, 0, 0) then
    return query select false, null::timestamptz, m, format('운영 종료 (%s시 폐관)', c); return;
  end if;
  return query select true, ((d + make_time(c, 0, 0)) at time zone 'Asia/Seoul'), m, null::text;
end $$;

create or replace function room_occupancy(p_room int) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(round(100.0 * count(*) filter (where ss.state <> 'free') / nullif(count(*), 0)), 0)::int
  from seats s join seat_state ss on ss.seat_id = s.id
  where s.room_id = p_room and s.is_active;
$$;

-- 혼잡도 연동: 외출 허용 시간(분)
create or replace function away_minutes(p_room int) returns int
language sql stable security definer set search_path = public as $$
  select case when room_occupancy(p_room) >= cfg('occ_high') then cfg('away_high')
              when room_occupancy(p_room) >= cfg('occ_mid') then cfg('away_mid')
              else cfg('away_low') end::int;
$$;

-- 혼잡도 연동: 자리비움 신고 확인 응답 시간(분)
create or replace function report_minutes(p_room int) returns int
language sql stable security definer set search_path = public as $$
  select case when room_occupancy(p_room) >= cfg('occ_high') then cfg('report_high')
              when room_occupancy(p_room) >= cfg('occ_mid') then cfg('report_mid')
              else cfg('report_low') end::int;
$$;

create or replace function notify(p_user uuid, p_title text, p_body text, p_url text default '/me') returns void
language sql security definer set search_path = public as $$
  insert into notifications(user_id, title, body, url) values (p_user, p_title, p_body, p_url);
$$;

create or replace function notify_admins(p_title text, p_body text, p_url text default '/admin') returns void
language sql security definer set search_path = public as $$
  insert into notifications(user_id, title, body, url)
  select id, p_title, p_body, p_url from profiles where role = 'admin';
$$;

create or replace function penalty_points(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(points), 0)::int from penalties
  where user_id = p_user and revoked_at is null
    and created_at > now() - make_interval(days => cfg('penalty_window_days')::int);
$$;

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
    perform notify(p_user, '예약이 정지되었습니다', format('벌점 %s점 누적으로 %s일간 예약할 수 없습니다. 이의가 있으면 내 예약 화면에서 신청하세요.', total, days));
  else
    perform notify(p_user, format('벌점 %s점이 부여되었습니다', p_points), format('%s (누적 %s점)', p_note, total));
  end if;
end $$;

-- 좌석 상태 공개 테이블 유지 + 빈자리 알림
create or replace function sync_seat_state() returns trigger
language plpgsql security definer set search_path = public as $$
declare sid int; new_state text; old_state text; rid int; rname text;
begin
  for sid in select distinct x from unnest(array[new.seat_id, case when tg_op = 'UPDATE' then old.seat_id end]) x where x is not null
  loop
    select coalesce((select status from reservations where seat_id = sid and status in ('reserved','in_use','away') limit 1), 'free') into new_state;
    select state, room_id into old_state, rid from seat_state where seat_id = sid;
    if old_state is distinct from new_state then
      update seat_state set state = new_state, updated_at = now() where seat_id = sid;
      if new_state = 'free' then
        select name into rname from rooms where id = rid;
        insert into notifications(user_id, title, body, url)
          select w.user_id, '빈자리가 생겼어요', format('%s에 자리가 났습니다. 지금 예약하세요.', rname), '/rooms/' || rid
          from watch_requests w where w.room_id = rid;
        delete from watch_requests where room_id = rid;
      end if;
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists reservations_sync on reservations;
create trigger reservations_sync after insert or update on reservations
  for each row execute function sync_seat_state();

create or replace function seat_state_init() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into seat_state(seat_id, room_id) values (new.id, new.room_id) on conflict do nothing;
  return null;
end $$;
drop trigger if exists seats_init on seats;
create trigger seats_init after insert on seats for each row execute function seat_state_init();

create or replace function end_reservation(p_res bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update reservations set status = 'ended', ended_at = now(), end_reason = p_reason, on_hold = false
    where id = p_res and status in ('reserved','in_use','away');
  update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'auto'
    where reservation_id = p_res and status = 'pending';
end $$;

create or replace function gps_check(p_lat double precision, p_lng double precision) returns void
language plpgsql stable security definer set search_path = public as $$
declare lat0 double precision; lng0 double precision; dist double precision;
begin
  if cfgb('gps_disabled') then return; end if;
  if p_lat is null or p_lng is null then
    raise exception '위치 정보를 확인할 수 없습니다. 브라우저의 위치 권한을 허용해 주세요.';
  end if;
  lat0 := cfg('library_lat'); lng0 := cfg('library_lng');
  dist := 2 * 6371000 * asin(sqrt(
    power(sin(radians(p_lat - lat0) / 2), 2) +
    cos(radians(lat0)) * cos(radians(p_lat)) * power(sin(radians(p_lng - lng0) / 2), 2)));
  if dist > cfg('gps_radius_m') then
    raise exception '도서관 안에서만 할 수 있습니다. (현재 위치가 도서관에서 약 %m 떨어져 있습니다)', round(dist);
  end if;
end $$;

-- ---------- 학생용 RPC ----------

create or replace function reserve_seat(p_seat int, p_minutes int default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); p profiles; s seats; st record; mins int; e timestamptz; rid bigint;
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  select * into p from profiles where id = u;
  if p.banned_until is not null and p.banned_until > now() then
    raise exception '예약이 정지된 상태입니다. (%까지)', to_char(p.banned_until at time zone 'Asia/Seoul', 'MM월 DD일 HH24:MI');
  end if;
  select * into s from seats where id = p_seat;
  if not found or not s.is_active then raise exception '사용할 수 없는 좌석입니다.'; end if;
  select * into st from room_status(s.room_id);
  if not st.is_open then raise exception '지금은 예약할 수 없습니다: %', st.reason; end if;
  mins := greatest(30, least(coalesce(p_minutes, cfg('max_minutes')::int), cfg('max_minutes')::int));
  e := now() + make_interval(mins => mins);
  if st.closes_at is not null then e := least(e, st.closes_at); end if;
  begin
    insert into reservations(user_id, seat_id, status, end_at, checkin_deadline)
      values (u, p_seat, 'reserved', e, least(now() + make_interval(mins => cfg('checkin_minutes')::int), e))
      returning id into rid;
  exception when unique_violation then
    raise exception '이미 다른 사람이 예약한 좌석이거나, 내가 이용 중인 좌석이 있습니다.';
  end;
  return rid;
end $$;

create or replace function check_in(p_token uuid, p_lat double precision default null, p_lng double precision default null) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); s seats; r reservations;
begin
  select * into s from seats where qr_token = p_token;
  if not found then raise exception '유효하지 않은 QR입니다.'; end if;
  select * into r from reservations where user_id = u and seat_id = s.id and status = 'reserved';
  if not found then raise exception '이 좌석에 체크인할 예약이 없습니다.'; end if;
  perform gps_check(p_lat, p_lng);
  update reservations set status = 'in_use', checked_in_at = now(), on_hold = false where id = r.id;
end $$;

create or replace function go_away() returns int
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations; rid int; mins int;
begin
  select * into r from reservations where user_id = u and status = 'in_use';
  if not found then raise exception '이용 중인 좌석이 없습니다.'; end if;
  if exists (select 1 from seat_reports where reservation_id = r.id and status = 'pending') then
    raise exception '자리 확인 요청이 접수되어 있습니다. 먼저 좌석 QR을 스캔해 자리에 있음을 확인해 주세요.';
  end if;
  select room_id into rid from seats where id = r.seat_id;
  mins := away_minutes(rid);
  update reservations set status = 'away', away_started_at = now(),
    away_deadline = least(now() + make_interval(mins => mins), end_at), notified_away = false where id = r.id;
  return mins;
end $$;

create or replace function come_back(p_token uuid, p_lat double precision default null, p_lng double precision default null) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); s seats; r reservations;
begin
  select * into s from seats where qr_token = p_token;
  if not found then raise exception '유효하지 않은 QR입니다.'; end if;
  select * into r from reservations where user_id = u and seat_id = s.id and status = 'away';
  if not found then raise exception '외출 중인 내 좌석이 아닙니다.'; end if;
  perform gps_check(p_lat, p_lng);
  update reservations set status = 'in_use', away_started_at = null, away_deadline = null where id = r.id;
end $$;

-- 자리 확인 요청(신고)에 응답: 내 좌석 QR 재스캔
create or replace function confirm_presence(p_token uuid, p_lat double precision default null, p_lng double precision default null) returns int
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); s seats; r reservations; n int;
begin
  select * into s from seats where qr_token = p_token;
  if not found then raise exception '유효하지 않은 QR입니다.'; end if;
  select * into r from reservations where user_id = u and seat_id = s.id and status = 'in_use';
  if not found then raise exception '이용 중인 내 좌석이 아닙니다.'; end if;
  perform gps_check(p_lat, p_lng);
  insert into notifications(user_id, title, body, url)
    select reporter_id, '신고 결과 안내', format('%s 좌석 이용자가 자리에 있음을 확인했습니다.', s.label), '/me'
    from seat_reports where reservation_id = r.id and status = 'pending';
  update seat_reports set status = 'dismissed', resolved_at = now(), resolved_by = 'owner'
    where reservation_id = r.id and status = 'pending';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function extend_reservation(p_token uuid default null, p_lat double precision default null, p_lng double precision default null) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations; s seats; st record; new_end timestamptz; is_exam boolean;
begin
  select * into r from reservations where user_id = u and status = 'in_use';
  if not found then raise exception '이용 중(체크인 완료)인 좌석만 연장할 수 있습니다.'; end if;
  select * into s from seats where id = r.seat_id;
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
  elsif r.extend_count >= cfg('max_extends') then
    raise exception '연장은 최대 %회까지 가능합니다.', cfg('max_extends')::int;
  end if;
  new_end := r.end_at + make_interval(mins => cfg('extend_minutes')::int);
  if st.closes_at is not null then new_end := least(new_end, st.closes_at); end if;
  if not st.is_open or new_end <= r.end_at then raise exception '폐관 시각이라 더 연장할 수 없습니다.'; end if;
  update reservations set end_at = new_end, extend_count = extend_count + 1, notified_end = false where id = r.id;
  return new_end;
end $$;

-- 반납(이용 중·외출) 또는 예약 취소(체크인 전)
create or replace function return_seat() returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations;
begin
  select * into r from reservations where user_id = u and status in ('reserved','in_use','away');
  if not found then raise exception '이용 중인 좌석이 없습니다.'; end if;
  if r.status = 'reserved' then
    update reservations set status = 'cancelled', ended_at = now(), end_reason = 'user', on_hold = false where id = r.id;
  else
    perform end_reservation(r.id, 'user');
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
  perform notify(r.user_id, '자리 확인 요청', format('자리가 비어 있다는 신고가 접수되었습니다. %s분 안에 좌석 QR을 스캔하지 않으면 자동 반납되고 벌점이 부여됩니다.', mins));
  perform notify_admins('자리비움 신고 접수', format('%s %s 좌석 (응답 기한 %s분)', rname, s.label, mins), '/admin/reports');
  return mins;
end $$;

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
  if r.id is not null and r.status = 'reserved' then
    update reservations set on_hold = true where id = r.id;
  end if;
  perform notify_admins('도움 요청', format('%s(%s): %s', p.name, p.student_id, p_reason), '/admin/reports');
end $$;

create or replace function submit_appeal(p_penalty bigint, p_message text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); p profiles;
begin
  if not exists (select 1 from penalties where id = p_penalty and user_id = u and revoked_at is null) then
    raise exception '이의신청할 수 없는 벌점입니다.';
  end if;
  if exists (select 1 from appeals where penalty_id = p_penalty) then
    raise exception '이미 이의신청한 벌점입니다.';
  end if;
  if coalesce(trim(p_message), '') = '' then raise exception '사유를 입력해 주세요.'; end if;
  select * into p from profiles where id = u;
  insert into appeals(penalty_id, user_id, message) values (p_penalty, u, p_message);
  perform notify_admins('벌점 이의신청', format('%s(%s)', p.name, p.student_id), '/admin/reports');
end $$;

-- ---------- 조회용 RPC ----------

create or replace function home_summary() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'mode', current_mode(),
    'incident', cfgb('incident_mode'),
    'rooms', coalesce((select jsonb_agg(x order by (x->>'floor')::int) from (
      select jsonb_build_object(
        'id', r.id, 'floor', r.floor, 'name', r.name, 'description', r.description,
        'total', (select count(*) from seats s where s.room_id = r.id and s.is_active),
        'occupied', (select count(*) from seats s join seat_state ss on ss.seat_id = s.id where s.room_id = r.id and s.is_active and ss.state <> 'free'),
        'pct', room_occupancy(r.id),
        'away_minutes', away_minutes(r.id),
        'report_minutes', report_minutes(r.id),
        'is_open', st.is_open, 'closes_at', st.closes_at, 'reason', st.reason
      ) x from rooms r, lateral room_status(r.id) st) q), '[]'::jsonb));
$$;

create or replace function my_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare u uuid := auth.uid(); p profiles; r reservations; s seats; rm rooms; st record; res jsonb := null; rep timestamptz;
begin
  if u is null then return null; end if;
  select * into p from profiles where id = u;
  select * into r from reservations where user_id = u and status in ('reserved','in_use','away');
  if found then
    select * into s from seats where id = r.seat_id;
    select * into rm from rooms where id = s.room_id;
    select * into st from room_status(rm.id);
    select min(respond_deadline) into rep from seat_reports where reservation_id = r.id and status = 'pending';
    res := to_jsonb(r) || jsonb_build_object(
      'seat_label', s.label, 'zone', s.zone, 'seat_type', s.seat_type, 'room_id', rm.id, 'room_name', rm.name, 'floor', rm.floor,
      'report_deadline', rep, 'occupancy', room_occupancy(rm.id), 'away_minutes', away_minutes(rm.id),
      'mode', st.mode, 'max_extends', case when st.mode = 'exam' then null else cfg('max_extends') end,
      'extend_window_min', cfg('extend_window_min'));
  end if;
  return jsonb_build_object(
    'profile', jsonb_build_object('id', p.id, 'student_id', p.student_id, 'name', p.name, 'department', p.department,
      'grade', p.grade, 'role', p.role, 'banned_until', p.banned_until, 'ban_reason', p.ban_reason),
    'points', penalty_points(u),
    'reservation', res,
    'help_open', exists (select 1 from help_requests where user_id = u and status = 'open'),
    'unread', (select count(*) from notifications where user_id = u and read_at is null));
end $$;

-- QR 스캔 화면용: 이 좌석에서 내가 할 수 있는 일
create or replace function seat_context(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare u uuid := auth.uid(); s seats; rm rooms; r reservations; mine reservations; st record;
begin
  select * into s from seats where qr_token = p_token;
  if not found then return null; end if;
  select * into rm from rooms where id = s.room_id;
  select * into r from reservations where seat_id = s.id and status in ('reserved','in_use','away');
  select * into mine from reservations where user_id = u and status in ('reserved','in_use','away');
  select * into st from room_status(rm.id);
  return jsonb_build_object(
    'seat', jsonb_build_object('id', s.id, 'label', s.label, 'zone', s.zone, 'seat_type', s.seat_type, 'is_active', s.is_active,
                               'room_id', rm.id, 'room_name', rm.name, 'floor', rm.floor),
    'state', coalesce(r.status, 'free'),
    'is_mine', r.id is not null and r.user_id = u,
    'my_reservation', case when r.id is not null and r.user_id = u then to_jsonb(r) end,
    'have_other', mine.id is not null and mine.seat_id <> s.id,
    'pending_report', r.id is not null and exists (select 1 from seat_reports where reservation_id = r.id and status = 'pending'),
    'report_deadline', (select min(respond_deadline) from seat_reports where reservation_id = r.id and status = 'pending'),
    'is_open', st.is_open, 'reason', st.reason, 'mode', st.mode,
    'occupancy', room_occupancy(rm.id), 'away_minutes', away_minutes(rm.id), 'report_minutes', report_minutes(rm.id),
    'gps_required', not cfgb('gps_disabled'),
    'extend_window_min', cfg('extend_window_min'));
end $$;

-- 요일(1=월)·시간대별 평균 혼잡도
create or replace function occupancy_heatmap(p_room int) returns table (dow int, hour int, pct int)
language sql stable security definer set search_path = public as $$
  select extract(isodow from taken_at at time zone 'Asia/Seoul')::int,
         extract(hour from taken_at at time zone 'Asia/Seoul')::int,
         round(avg(100.0 * occupied / nullif(total, 0)))::int
  from occupancy_snapshots
  where room_id = p_room and taken_at > now() - interval '35 days'
  group by 1, 2 order by 1, 2;
$$;

-- ---------- 1분마다 도는 자동 처리 ----------
create or replace function tick() returns void
language plpgsql security definer set search_path = public as $$
declare r record; pts int; busy boolean; url text; secret text;
begin
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
             where res.status = 'away' and res.away_deadline < now() and res.away_deadline < res.end_at
    loop
      perform end_reservation(r.id, 'away_timeout');
      perform add_penalty(r.user_id, r.id, 'away_timeout', cfg('pen_away')::int, format('%s 좌석 외출 시간 초과로 자동 반납', r.label));
    end loop;

    -- 3) 자리비움 신고 응답 기한 초과
    for r in select rep.id as report_id, rep.reporter_id, rep.occupancy_pct, res.id, res.user_id, res.status, s.label, s.room_id
             from seat_reports rep join reservations res on res.id = rep.reservation_id join seats s on s.id = res.seat_id
             where rep.status = 'pending' and rep.respond_deadline < now()
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
  for r in select id, user_id from reservations where status in ('reserved','in_use','away') and end_at < now()
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

revoke execute on function tick(), add_penalty(uuid, bigint, text, int, text), end_reservation(bigint, text),
  notify(uuid, text, text, text), notify_admins(text, text, text) from public, anon, authenticated;
