-- 자리 이동
-- 이용 중인 학생이 다른 빈자리로 옮긴다. 옮길 좌석의 QR을 찍어야 이동이 끝난다(그 자리에 왔다는 증명).
--   1) 좌석을 먼저 고르면 그 자리를 잠깐 맡아 두고(기본 10분), 시간 안에 그 좌석 QR을 찍는다
--   2) 고르지 않고 빈 좌석의 QR을 바로 찍어도 이동된다
-- 남은 이용 시간과 연장 횟수는 그대로 따라간다.
insert into settings(key, value) values ('move_hold_minutes', '10') on conflict (key) do nothing;

create table if not exists seat_holds (
  seat_id int primary key references seats(id) on delete cascade,
  reservation_id bigint not null unique references reservations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table seat_holds enable row level security;
drop policy if exists own_read on seat_holds;
create policy own_read on seat_holds for select to authenticated using (user_id = auth.uid() or is_admin());

-- 좌석 한 칸의 공개 상태를 다시 계산한다. 맡아 둔 좌석은 '체크인 대기'로 보인다
create or replace function resync_seat(sid int) returns void
language plpgsql security definer set search_path = public as $$
declare r record; h record; new_state text; old_state text; rid int; rname text; v_end timestamptz; v_until timestamptz; v_ext int;
begin
  select status, end_at, extend_count,
         case status when 'reserved' then checkin_deadline when 'away' then coalesce(away_deadline, end_at) else end_at end as until_at
    into r from reservations where seat_id = sid and status in ('reserved','in_use','away') limit 1;
  if r.status is not null then
    new_state := r.status; v_end := r.end_at; v_until := r.until_at; v_ext := r.extend_count;
  else
    select expires_at into h from seat_holds where seat_id = sid and expires_at > now();
    if found then
      new_state := 'reserved'; v_end := null; v_until := h.expires_at; v_ext := 0;
    else
      new_state := 'free'; v_end := null; v_until := null; v_ext := 0;
    end if;
  end if;
  select state, room_id into old_state, rid from seat_state where seat_id = sid;
  update seat_state set state = new_state, end_at = v_end, until_at = v_until, extend_count = v_ext, updated_at = now()
    where seat_id = sid and (state, end_at, until_at, extend_count) is distinct from (new_state, v_end, v_until, v_ext);
  if old_state is distinct from new_state and new_state = 'free' then
    select name into rname from rooms where id = rid;
    insert into notifications(user_id, title, body, url)
      select w.user_id, '빈자리가 생겼어요', format('%s에 자리가 났습니다. 지금 예약하세요.', rname), '/rooms/' || rid
      from watch_requests w where w.room_id = rid;
    delete from watch_requests where room_id = rid;
  end if;
end $$;
revoke execute on function resync_seat(int) from public, anon, authenticated;

create or replace function sync_seat_state() returns trigger
language plpgsql security definer set search_path = public as $$
declare sid int;
begin
  -- 예약이 끝나면 맡아 둔 이동 좌석도 풀어 준다
  if new.status not in ('reserved','in_use','away') then
    delete from seat_holds where reservation_id = new.id;
  end if;
  for sid in select distinct x from unnest(array[new.seat_id, case when tg_op = 'UPDATE' then old.seat_id end]) x where x is not null
  loop
    perform resync_seat(sid);
  end loop;
  return null;
end $$;

create or replace function seat_hold_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform resync_seat(coalesce(new.seat_id, old.seat_id));
  if tg_op = 'UPDATE' and old.seat_id <> new.seat_id then perform resync_seat(old.seat_id); end if;
  return null;
end $$;
drop trigger if exists seat_holds_sync on seat_holds;
create trigger seat_holds_sync after insert or update or delete on seat_holds
  for each row execute function seat_hold_sync();

-- 다른 학생이 맡아 둔 좌석은 예약·이동할 수 없다 (예약 경로가 무엇이든 여기서 막는다)
create or replace function seat_hold_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' or new.seat_id is distinct from old.seat_id)
     and exists (select 1 from seat_holds h where h.seat_id = new.seat_id and h.expires_at > now() and h.user_id <> new.user_id) then
    raise exception '다른 학생이 이동하려고 맡아 둔 좌석입니다. 다른 좌석을 골라 주세요.';
  end if;
  return new;
end $$;
drop trigger if exists reservations_hold_guard on reservations;
create trigger reservations_hold_guard before insert or update of seat_id on reservations
  for each row execute function seat_hold_guard();

-- 옮길 좌석을 고른다: 그 자리를 잠깐 맡아 둔다
create or replace function request_move(p_seat int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations; s seats; st record; mins int; exp timestamptz;
begin
  select * into r from reservations where user_id = u and status in ('reserved','in_use','away');
  if not found then raise exception '이용 중인 좌석이 없습니다.'; end if;
  if r.status <> 'in_use' then raise exception '체크인한 뒤, 외출 중이 아닐 때 자리를 옮길 수 있습니다.'; end if;
  if exists (select 1 from seat_reports where reservation_id = r.id and status = 'pending') then
    raise exception '자리 확인 요청이 접수되어 있습니다. 먼저 지금 좌석의 QR을 스캔해 주세요.';
  end if;
  if p_seat = r.seat_id then raise exception '지금 앉아 있는 좌석입니다.'; end if;
  select * into s from seats where id = p_seat;
  if not found or not s.is_active then raise exception '사용할 수 없는 좌석입니다.'; end if;
  select * into st from room_status(s.room_id);
  if not st.is_open then raise exception '지금은 이용할 수 없는 열람실입니다: %', st.reason; end if;
  if exists (select 1 from reservations where seat_id = p_seat and status in ('reserved','in_use','away'))
     or exists (select 1 from seat_holds where seat_id = p_seat and expires_at > now() and user_id <> u) then
    raise exception '이미 다른 학생이 쓰고 있는 좌석입니다.';
  end if;
  mins := cfg('move_hold_minutes')::int;
  exp := least(now() + make_interval(mins => mins), r.end_at);
  delete from seat_holds where reservation_id = r.id or (seat_id = p_seat and expires_at <= now());
  begin
    insert into seat_holds(seat_id, reservation_id, user_id, expires_at) values (p_seat, r.id, u, exp);
  exception when unique_violation then
    raise exception '방금 다른 학생이 먼저 고른 좌석입니다.';
  end;
  return jsonb_build_object('seat_label', s.label, 'minutes', mins, 'expires_at', exp);
end $$;

create or replace function cancel_move() returns void
language sql security definer set search_path = public as $$
  delete from seat_holds where user_id = auth.uid();
$$;

-- 옮길 좌석의 QR을 찍어 이동을 끝낸다. 미리 고르지 않았어도 빈 좌석이면 바로 이동된다
create or replace function move_seat(p_token uuid, p_lat double precision default null, p_lng double precision default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r reservations; s seats; old_label text; st record; new_end timestamptz;
begin
  select * into s from seats where qr_token = p_token;
  if not found then raise exception '유효하지 않은 QR입니다.'; end if;
  select * into r from reservations where user_id = u and status in ('reserved','in_use','away');
  if not found then raise exception '이용 중인 좌석이 없습니다.'; end if;
  if r.status <> 'in_use' then raise exception '체크인한 뒤, 외출 중이 아닐 때 자리를 옮길 수 있습니다.'; end if;
  if s.id = r.seat_id then raise exception '지금 앉아 있는 좌석입니다.'; end if;
  if not s.is_active then raise exception '사용할 수 없는 좌석입니다.'; end if;
  if exists (select 1 from seat_reports where reservation_id = r.id and status = 'pending') then
    raise exception '자리 확인 요청이 접수되어 있습니다. 먼저 지금 좌석의 QR을 스캔해 주세요.';
  end if;
  select * into st from room_status(s.room_id);
  if not st.is_open then raise exception '지금은 이용할 수 없는 열람실입니다: %', st.reason; end if;
  perform gps_check(p_lat, p_lng);
  select label into old_label from seats where id = r.seat_id;
  new_end := r.end_at;
  if st.closes_at is not null then new_end := least(new_end, st.closes_at); end if;
  delete from seat_holds where reservation_id = r.id;
  begin
    update reservations set seat_id = s.id, end_at = new_end where id = r.id;
  exception when unique_violation then
    raise exception '이미 다른 학생이 쓰고 있는 좌석입니다.';
  end;
  return jsonb_build_object('from', old_label, 'to', s.label);
end $$;

-- 진행 중인 내 이동
create or replace function my_move() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('seat_id', s.id, 'seat_label', s.label, 'room_id', rm.id, 'room_name', rm.name, 'expires_at', h.expires_at)
  from seat_holds h join seats s on s.id = h.seat_id join rooms rm on rm.id = s.room_id
  where h.user_id = auth.uid() and h.expires_at > now();
$$;

-- QR 화면용 좌석 정보에 '맡아 둔 좌석' 여부를 더한다
create or replace function seat_context_v2(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select seat_context(p_token) || jsonb_build_object(
    'held_by_me', exists (select 1 from seat_holds h join seats s on s.id = h.seat_id where s.qr_token = p_token and h.expires_at > now() and h.user_id = auth.uid()),
    'held_by_other', exists (select 1 from seat_holds h join seats s on s.id = h.seat_id where s.qr_token = p_token and h.expires_at > now() and h.user_id <> auth.uid()));
$$;

-- 시간이 지난 이동은 풀어 준다 (원래 좌석은 그대로)
create or replace function expire_moves() returns void
language plpgsql security definer set search_path = public as $$
declare h record;
begin
  for h in select hd.seat_id, hd.user_id, s.label from seat_holds hd join seats s on s.id = hd.seat_id where hd.expires_at <= now()
  loop
    delete from seat_holds where seat_id = h.seat_id;
    perform notify(h.user_id, '자리 이동 시간이 지났습니다', format('%s 좌석은 다시 빈자리가 되었습니다. 원래 좌석은 그대로 이용할 수 있습니다.', h.label));
  end loop;
end $$;
revoke execute on function expire_moves() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('du-library-moves');
exception when others then null;
end $$;
select cron.schedule('du-library-moves', '* * * * *', 'select public.expire_moves()');

notify pgrst, 'reload schema';
