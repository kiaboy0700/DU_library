-- 예약 -> 취소 -> 재예약을 되풀이해 좌석을 묶어 두는 것을 막는다
--   내가 취소한 좌석은 10분 동안 내가 다시 예약할 수 없다 (다른 학생은 바로 예약할 수 있고, 나도 다른 좌석은 바로 예약할 수 있다)
-- 관리자가 대신 잡아 주는 예약에는 적용하지 않는다.
insert into settings(key, value) values ('rebook_same_seat_minutes', '10') on conflict (key) do nothing;
delete from settings where key in ('cancel_daily_limit', 'cancel_cooldown_minutes');
drop function if exists cancel_info(uuid);

create or replace function cancel_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare last_ timestamptz;
begin
  if new.by_admin or new.status <> 'reserved' then return new; end if;
  select max(ended_at) into last_ from reservations
    where user_id = new.user_id and seat_id = new.seat_id and status = 'cancelled' and end_reason = 'user'
      and ended_at > now() - make_interval(mins => cfg('rebook_same_seat_minutes')::int);
  if last_ is not null then
    raise exception '방금 취소한 좌석입니다. %분 뒤에 다시 예약할 수 있습니다. 다른 좌석은 지금 예약할 수 있어요.',
      greatest(1, ceil(extract(epoch from (last_ + make_interval(mins => cfg('rebook_same_seat_minutes')::int) - now())) / 60)::int);
  end if;
  return new;
end $$;
drop trigger if exists reservations_cancel_guard on reservations;
create trigger reservations_cancel_guard before insert on reservations
  for each row execute function cancel_guard();

-- 빠른 예약은 내가 방금 취소한 좌석을 고르지 않는다
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
      and not exists (select 1 from reservations x where x.user_id = u and x.seat_id = s.id and x.status = 'cancelled' and x.end_reason = 'user'
                      and x.ended_at > now() - make_interval(mins => cfg('rebook_same_seat_minutes')::int))
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
