-- 1) 사용 중인 좌석의 남은 시간·연장 횟수를 누구나 볼 수 있게 (이용자가 누구인지는 계속 비공개)
alter table seat_state add column if not exists end_at timestamptz;      -- 이용 종료 시각
alter table seat_state add column if not exists until_at timestamptz;    -- 지금 상태의 마감 (체크인 마감·복귀 마감·종료)
alter table seat_state add column if not exists extend_count int not null default 0;

create or replace function sync_seat_state() returns trigger
language plpgsql security definer set search_path = public as $$
declare sid int; r record; new_state text; old_state text; rid int; rname text;
begin
  for sid in select distinct x from unnest(array[new.seat_id, case when tg_op = 'UPDATE' then old.seat_id end]) x where x is not null
  loop
    select status, end_at, extend_count,
           case status when 'reserved' then checkin_deadline when 'away' then coalesce(away_deadline, end_at) else end_at end as until_at
      into r from reservations where seat_id = sid and status in ('reserved','in_use','away') limit 1;
    new_state := coalesce(r.status, 'free');
    select state, room_id into old_state, rid from seat_state where seat_id = sid;
    update seat_state set state = new_state, end_at = r.end_at, until_at = r.until_at,
           extend_count = coalesce(r.extend_count, 0), updated_at = now()
      where seat_id = sid
        and (state, end_at, until_at, extend_count) is distinct from (new_state, r.end_at, r.until_at, coalesce(r.extend_count, 0));
    if old_state is distinct from new_state and new_state = 'free' then
      select name into rname from rooms where id = rid;
      insert into notifications(user_id, title, body, url)
        select w.user_id, '빈자리가 생겼어요', format('%s에 자리가 났습니다. 지금 예약하세요.', rname), '/rooms/' || rid
        from watch_requests w where w.room_id = rid;
      delete from watch_requests where room_id = rid;
    end if;
  end loop;
  return null;
end $$;

-- 기존 예약 반영
update seat_state ss set end_at = r.end_at, extend_count = r.extend_count,
  until_at = case r.status when 'reserved' then r.checkin_deadline when 'away' then coalesce(r.away_deadline, r.end_at) else r.end_at end
from reservations r where r.seat_id = ss.seat_id and r.status in ('reserved','in_use','away');

-- 2) 관리자 계정은 좌석을 예약하지 않는다
create or replace function no_admin_reservation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from profiles where id = new.user_id and role = 'admin') then
    raise exception '관리자 계정으로는 좌석을 예약할 수 없습니다.';
  end if;
  return new;
end $$;
drop trigger if exists reservations_no_admin on reservations;
create trigger reservations_no_admin before insert on reservations
  for each row execute function no_admin_reservation();

notify pgrst, 'reload schema';
