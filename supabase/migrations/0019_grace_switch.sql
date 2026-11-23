-- 대기 시간 연장: 체크인 대기·외출·자리 확인 중일 때만, 분은 관리자가 정한다 / 다른 좌석 QR을 찍었을 때 그 좌석으로 바꾸기

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
    -- 지금 걸려 있는 마감(체크인·복귀·자리 확인)이 있을 때만, 관리자가 정한 분만큼 더 준다
    if coalesce(p_arg, 15) < 1 or coalesce(p_arg, 15) > 180 then raise exception '1분에서 180분 사이로 정해 주세요.'; end if;
    if r.status = 'in_use' and not exists (select 1 from seat_reports where reservation_id = r.id and status = 'pending') then
      raise exception '연장할 대기 시간이 없습니다.';
    end if;
    update reservations set
        checkin_deadline = case when status = 'reserved' then greatest(checkin_deadline, now()) + make_interval(mins => coalesce(p_arg, 15)) else checkin_deadline end,
        away_deadline = case when status = 'away' then greatest(away_deadline, now()) + make_interval(mins => coalesce(p_arg, 15)) else away_deadline end,
        notified_away = false
      where id = r.id;
    update seat_reports set respond_deadline = greatest(respond_deadline, now()) + make_interval(mins => coalesce(p_arg, 15))
      where reservation_id = r.id and status = 'pending';
    -- 늘린 마감보다 이용 종료가 먼저 오지 않게
    update reservations set end_at = greatest(end_at, coalesce(case when status = 'reserved' then checkin_deadline when status = 'away' then away_deadline end, end_at),
        coalesce((select max(respond_deadline) from seat_reports where reservation_id = r.id and status = 'pending'), end_at))
      where id = r.id;
    perform notify(r.user_id,
      format('%s %s %s분 연장', s.label, case when r.status = 'reserved' then '체크인 대기' when r.status = 'away' then '외출 시간' else '자리 확인 시간' end, coalesce(p_arg, 15)),
      '관리자가 시간을 늘렸습니다.');
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

-- 체크인 대기·외출 중에 다른 빈 좌석의 QR을 찍고 그 좌석으로 바꾼다 (남은 시간 그대로, 바로 이용 시작)
create or replace function switch_seat(p_token uuid, p_lat double precision default null, p_lng double precision default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations; s seats; old_label text; st record;
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  select * into r from reservations where user_id = u and status in ('reserved','away');
  if not found then raise exception '체크인 대기 중이거나 외출 중인 좌석이 없습니다.'; end if;
  select * into s from seats where qr_token = p_token;
  if not found then raise exception '유효하지 않은 QR입니다.'; end if;
  if s.id = r.seat_id then raise exception '내 좌석입니다.'; end if;
  if not s.is_active then raise exception '사용이 중지된 좌석입니다.'; end if;
  select * into st from room_status(s.room_id);
  if not st.is_open then raise exception '%', coalesce(st.reason, '운영 중이 아닌 열람실입니다.'); end if;
  if exists (select 1 from seat_holds where seat_id = s.id and user_id <> u) then
    raise exception '다른 학생이 이동하려고 맡아 둔 좌석입니다.';
  end if;
  perform gps_check(p_lat, p_lng);
  select label into old_label from seats where id = r.seat_id;
  update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'owner' where reservation_id = r.id and status = 'pending';
  begin
    update reservations set seat_id = s.id, status = 'in_use', checked_in_at = coalesce(checked_in_at, now()),
      away_started_at = null, away_deadline = null where id = r.id;
  exception when unique_violation then
    raise exception '이미 다른 학생이 쓰고 있는 좌석입니다.';
  end;
  return jsonb_build_object('from', old_label, 'to', s.label);
end $$;
grant execute on function switch_seat(uuid, double precision, double precision) to authenticated;

notify pgrst, 'reload schema';
