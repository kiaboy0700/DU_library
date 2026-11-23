-- 연장 한도는 혼잡도 기준: 여유·보통일 때는 제한이 없고, 혼잡(occ_high 이상)일 때만 하루 max_extends 회까지.
-- 횟수는 좌석과 상관없이 오늘 쓴 것을 합쳐 세고(0035), 한도는 연장하려는 그 순간의 혼잡도로 판단한다.
-- 이미 받은 시간은 혼잡도가 바뀌어도 줄지 않는다. 시험기간에도 같은 규칙을 쓰되, 연장할 때 좌석 QR을 찍어야 하는 것은 그대로다.


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
  end if;
  if room_occupancy(s.room_id) >= cfg('occ_high') and r.extend_count >= cfg('max_extends') then
    raise exception '지금은 혼잡해서 연장은 하루 %회까지입니다. 오늘 이미 %회 연장했습니다.', cfg('max_extends')::int, r.extend_count;
  end if;
  new_end := r.end_at + make_interval(mins => cfg('extend_minutes')::int);
  if st.closes_at is not null then new_end := least(new_end, st.closes_at); end if;
  if not st.is_open or new_end <= r.end_at then raise exception '폐관 시각이라 더 연장할 수 없습니다.'; end if;
  update reservations set end_at = new_end, extend_count = extend_count + 1, notified_end = false where id = r.id;
  return new_end;
end $$;

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
      'mode', st.mode, 'max_extends', case when room_occupancy(rm.id) >= cfg('occ_high') then cfg('max_extends') end,
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

notify pgrst, 'reload schema';
