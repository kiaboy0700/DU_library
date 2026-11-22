-- 빠른 예약: 좌석을 고르지 않고 빈자리 하나를 바로 배정한다.
-- 옆자리가 비어 있는 좌석을 먼저 고르고, 동시에 여러 명이 눌러도 같은 좌석이 두 번 배정되지 않는다
-- (seat_state 행 잠금 + 건너뛰기, 그리고 reservations 의 유일 인덱스가 최종 방어선).
create or replace function quick_reserve(p_room int, p_type text default null, p_minutes int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid(); p profiles; st record; mins int; e timestamptz; rid bigint; sid int; lbl text; tries int := 0;
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  select * into p from profiles where id = u;
  if p.banned_until is not null and p.banned_until > now() then
    raise exception '예약이 정지된 상태입니다. (%까지)', to_char(p.banned_until at time zone 'Asia/Seoul', 'MM월 DD일 HH24:MI');
  end if;
  if exists (select 1 from reservations where user_id = u and status in ('reserved','in_use','away')) then
    raise exception '이미 이용 중인 좌석이 있습니다. 먼저 반납해 주세요.';
  end if;
  select * into st from room_status(p_room);
  if st.is_open is null then raise exception '열람실을 찾을 수 없습니다.'; end if;
  if not st.is_open then raise exception '지금은 예약할 수 없습니다: %', st.reason; end if;
  mins := greatest(30, least(coalesce(p_minutes, cfg('max_minutes')::int), cfg('max_minutes')::int));
  e := now() + make_interval(mins => mins);
  if st.closes_at is not null then e := least(e, st.closes_at); end if;

  loop
    tries := tries + 1;
    select s.id, s.label into sid, lbl
    from seats s join seat_state ss on ss.seat_id = s.id
    where s.room_id = p_room and s.is_active and ss.state = 'free'
      and (p_type is null or s.seat_type = p_type)
    order by (select count(*) from seats n join seat_state ns on ns.seat_id = n.id
              where n.room_id = s.room_id and n.y = s.y and abs(n.x - s.x) = 1 and ns.state <> 'free'),
             random()
    limit 1
    for update of ss skip locked;
    if sid is null then
      raise exception '지금은 빈자리가 없습니다. 빈자리 알림을 켜 두면 자리가 날 때 알려 드립니다.';
    end if;
    begin
      insert into reservations(user_id, seat_id, status, end_at, checkin_deadline)
        values (u, sid, 'reserved', e, least(now() + make_interval(mins => cfg('checkin_minutes')::int), e))
        returning id into rid;
      exit;
    exception when unique_violation then
      -- 내가 이미 예약을 가진 경우(두 번 누름)와 좌석을 방금 빼앗긴 경우를 구분
      if exists (select 1 from reservations where user_id = u and status in ('reserved','in_use','away')) then
        raise exception '이미 이용 중인 좌석이 있습니다.';
      end if;
      if tries >= 5 then raise exception '예약이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.'; end if;
    end;
  end loop;
  return jsonb_build_object('reservation_id', rid, 'seat_id', sid, 'seat_label', lbl);
end $$;

notify pgrst, 'reload schema';
