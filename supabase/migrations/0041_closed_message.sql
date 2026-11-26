-- 열람실이 닫혀 있을 때의 예약 거절 문구를 '운영 시간이 아닙니다'로 통일한다.
-- 테스트용 '운영시간 무시'를 끈다: 이제 운영 시간 밖에는 실제로 예약할 수 없다 (운영 설정의 테스트 설정에서 다시 켤 수 있다).
update settings set value = 'false'::jsonb where key = 'force_open';

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
  if not st.is_open then raise exception '운영 시간이 아닙니다. (%)', st.reason; end if;
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
  if not st.is_open then raise exception '운영 시간이 아닙니다. (%)', st.reason; end if;
  mins := greatest(30, least(coalesce(p_minutes, cfg('max_minutes')::int), cfg('max_minutes')::int));
  e := now() + make_interval(mins => mins);
  if st.closes_at is not null then e := least(e, st.closes_at); end if;

  loop
    tries := tries + 1;
    select s.id, s.label into sid, lbl
    from seats s join seat_state ss on ss.seat_id = s.id
    where s.room_id = p_room and s.is_active and ss.state = 'free'
      and (p_type is null or s.seat_type = p_type)
      and not exists (select 1 from reservations x where x.user_id = u and x.seat_id = s.id and x.status in ('cancelled','ended','no_show')
                      and x.ended_at > now() - make_interval(mins => cfg('rebook_same_seat_minutes')::int))
      and not exists (select 1 from seat_moves m where m.user_id = u and m.from_seat = s.id
                      and m.moved_at > now() - make_interval(mins => cfg('rebook_same_seat_minutes')::int))
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
