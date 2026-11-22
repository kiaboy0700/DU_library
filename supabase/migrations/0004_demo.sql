-- 발표용: 가상 학생으로 열람실을 원하는 혼잡도까지 채운다 (관리자 전용)
alter table profiles add column if not exists is_virtual boolean not null default false;

create or replace function admin_demo_fill(p_room int, p_pct int) returns int
language plpgsql security definer set search_path = public as $$
declare total int; target int; cur int; n int := 0; r record;
begin
  perform require_admin();
  -- 이 열람실의 가상 학생 예약을 모두 정리
  for r in select res.id from reservations res join seats s on s.id = res.seat_id join profiles p on p.id = res.user_id
           where s.room_id = p_room and p.is_virtual and res.status in ('reserved','in_use','away')
  loop
    perform end_reservation(r.id, 'admin');
  end loop;
  select count(*) into total from seats where room_id = p_room and is_active;
  select count(*) into cur from seats s join seat_state ss on ss.seat_id = s.id where s.room_id = p_room and s.is_active and ss.state <> 'free';
  target := greatest(0, round(total * least(greatest(p_pct, 0), 100) / 100.0)::int - cur);
  for r in
    select s.id as seat_id, u.id as user_id from
      (select s.id, row_number() over (order by random()) rn from seats s join seat_state ss on ss.seat_id = s.id
        where s.room_id = p_room and s.is_active and ss.state = 'free') s
      join (select p.id, row_number() over (order by random()) rn from profiles p
        where p.is_virtual and not exists (select 1 from reservations x where x.user_id = p.id and x.status in ('reserved','in_use','away'))) u
      on u.rn = s.rn
    where s.rn <= target
  loop
    insert into reservations(user_id, seat_id, status, start_at, end_at, checkin_deadline, checked_in_at, by_admin)
    values (r.user_id, r.seat_id, case when random() < 0.08 then 'away' else 'in_use' end,
            now() - make_interval(mins => (random() * 120)::int), now() + make_interval(mins => 60 + (random() * 180)::int),
            now(), now() - interval '20 minutes', true);
    n := n + 1;
  end loop;
  update reservations set away_started_at = now(), away_deadline = end_at
    where status = 'away' and away_deadline is null;
  perform log_admin('demo_fill', null, null, null, format('room %s → %s%%', p_room, p_pct));
  return n;
end $$;
