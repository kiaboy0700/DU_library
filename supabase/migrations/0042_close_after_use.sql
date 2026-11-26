-- 이용 중인 좌석을 닫을 때의 두 가지 방법
--   · 이용이 끝나면 닫기: 지금 쓰는 학생은 끝까지 쓰고(연장은 불가), 반납·종료되는 순간 좌석이 닫힌다
--   · 지금 닫기: 학생은 벌점 없이 바로 반납된다 (기존 방식)
alter table seats add column if not exists close_pending boolean not null default false;
alter table seats add column if not exists close_reason text;

create or replace function admin_close_seats(p_ids int[], p_reason text, p_wait boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; now_ids int[] := '{}'; n_wait int := 0; why text := coalesce(nullif(trim(p_reason), ''), '시설 점검');
begin
  perform require_admin();
  for r in select s.id, s.label, res.user_id from seats s
           left join reservations res on res.seat_id = s.id and res.status in ('reserved','in_use','away')
           where s.id = any(p_ids) and s.is_active
  loop
    if p_wait and r.user_id is not null then
      update seats set close_pending = true, close_reason = why where id = r.id;
      perform notify(r.user_id, format('%s 이용이 끝나면 좌석이 닫힙니다', r.label), format('사유: %s. 지금 이용 시간까지는 그대로 쓸 수 있고, 연장은 할 수 없습니다.', why));
      n_wait := n_wait + 1;
    else
      now_ids := now_ids || r.id;
    end if;
  end loop;
  if array_length(now_ids, 1) > 0 then perform admin_set_seats(now_ids, false, why); end if;
  if n_wait > 0 then perform log_admin('seats:close_after', null, p_ids[1], null, format('%s석: %s', n_wait, why)); end if;
  return jsonb_build_object('closed', coalesce(array_length(now_ids, 1), 0), 'pending', n_wait);
end $$;
grant execute on function admin_close_seats(int[], text, boolean) to authenticated;


create or replace function admin_set_seats(p_ids int[], p_active boolean, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int;
begin
  perform require_admin();
  update seats set is_active = p_active, inactive_reason = case when p_active then null else p_reason end,
      close_pending = false, close_reason = null where id = any(p_ids);
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
  -- 닫힐 예정이던 좌석: 그 좌석을 쓰던 예약이 끝났거나 다른 좌석으로 옮겨 갔으면 이제 닫는다
  update seats set is_active = false, inactive_reason = close_reason, close_pending = false, close_reason = null
    where close_pending and (
      (id = new.seat_id and new.status not in ('reserved','in_use','away'))
      or (tg_op = 'UPDATE' and id = old.seat_id and old.seat_id is distinct from new.seat_id));
  for sid in select distinct x from unnest(array[new.seat_id, case when tg_op = 'UPDATE' then old.seat_id end]) x where x is not null
  loop
    perform resync_seat(sid);
  end loop;
  return null;
end $$;

create or replace function extend_reservation(p_token uuid default null, p_lat double precision default null, p_lng double precision default null) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations; s seats; st record; new_end timestamptz; is_exam boolean;
begin
  select * into r from reservations where user_id = u and status = 'in_use';
  if not found then raise exception '이용 중(체크인 완료)인 좌석만 연장할 수 있습니다.'; end if;
  select * into s from seats where id = r.seat_id;
  if s.close_pending then raise exception '이용이 끝나면 닫히는 좌석이라 연장할 수 없습니다. (%)', coalesce(s.close_reason, '시설 점검'); end if;
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

create or replace function admin_room_map(p_room int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'seat_id', s.id, 'label', s.label, 'zone', s.zone, 'seat_type', s.seat_type, 'x', s.x, 'y', s.y,
      'is_active', s.is_active, 'inactive_reason', s.inactive_reason, 'qr_token', s.qr_token, 'close_pending', s.close_pending,
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

notify pgrst, 'reload schema';
