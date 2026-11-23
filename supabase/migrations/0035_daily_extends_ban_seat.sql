-- 1) 연장 횟수는 좌석이 아니라 하루 기준: 반납하고 다른 좌석(또는 같은 좌석)을 다시 예약해도 오늘 쓴 연장 횟수가 이어진다.
--    새 예약이 만들어질 때 오늘 이미 쓴 횟수를 그대로 물려받게 해서, 화면의 '남은 연장'과 연장 규칙이 모두 그대로 맞는다.
-- 2) 예약이 정지되면 이용 중인 좌석도 그 자리에서 반납된다 (정지 중에 계속 앉아 연장하는 일을 막는다).

create or replace function carry_extends() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.extend_count := greatest(new.extend_count, coalesce((
    select max(extend_count) from reservations
    where user_id = new.user_id
      and created_at >= (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')), 0));
  return new;
end $$;
drop trigger if exists reservations_carry_extends on reservations;
create trigger reservations_carry_extends before insert on reservations
  for each row execute function carry_extends();

create or replace function ban_takes_seat() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.banned_until is not null and new.banned_until > now()
     and (old.banned_until is null or old.banned_until <= now()) then
    for r in select res.id, s.label from reservations res join seats s on s.id = res.seat_id
             where res.user_id = new.id and res.status in ('reserved','in_use','away')
    loop
      perform end_reservation(r.id, 'banned');
      perform notify(new.id, format('%s 좌석이 반납되었습니다', r.label), '예약이 정지되어 이용 중이던 좌석도 반납되었습니다.');
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists profiles_ban_takes_seat on profiles;
create trigger profiles_ban_takes_seat after update of banned_until on profiles
  for each row execute function ban_takes_seat();

notify pgrst, 'reload schema';
