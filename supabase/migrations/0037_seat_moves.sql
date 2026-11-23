-- 좌석 이동 기록: 누가 언제 어느 좌석에서 어느 좌석으로 옮겼는지 남긴다.
-- 이동 방법이 무엇이든(자리 이동, 체크인 대기·외출 중 바꾸기, 신고 좌석으로 바꾸기, 관리자 이동) 예약의 좌석이 바뀌는 순간 기록된다.
create table if not exists seat_moves (
  id bigint generated always as identity primary key,
  reservation_id bigint not null references reservations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  from_seat int references seats(id) on delete set null,
  to_seat int references seats(id) on delete set null,
  by_admin boolean not null default false,
  moved_at timestamptz not null default now()
);
create index if not exists seat_moves_user on seat_moves(user_id, moved_at desc);
alter table seat_moves enable row level security;
drop policy if exists own_read on seat_moves;
create policy own_read on seat_moves for select to authenticated using (user_id = auth.uid() or is_admin());

create or replace function log_seat_move() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.seat_id is distinct from old.seat_id then
    insert into seat_moves(reservation_id, user_id, from_seat, to_seat, by_admin)
      values (new.id, new.user_id, old.seat_id, new.seat_id, coalesce(is_admin(), false));
  end if;
  return null;
end $$;
drop trigger if exists reservations_log_move on reservations;
create trigger reservations_log_move after update of seat_id on reservations
  for each row execute function log_seat_move();

create or replace function admin_user_detail(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return jsonb_build_object(
    'profile', (select to_jsonb(p) from profiles p where p.id = p_user),
    'points', penalty_points(p_user),
    'penalties', coalesce((select jsonb_agg(to_jsonb(pe) order by pe.created_at desc) from penalties pe where pe.user_id = p_user), '[]'::jsonb),
    'reservations', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', r.id, 'status', r.status, 'start_at', r.start_at, 'end_at', r.end_at, 'ended_at', r.ended_at,
        'end_reason', r.end_reason, 'seat_label', s.label, 'room_name', rm.name, 'by_admin', r.by_admin, 'extend_count', r.extend_count,
        'moves', (select count(*) from seat_moves m where m.reservation_id = r.id)) x
      from reservations r join seats s on s.id = r.seat_id join rooms rm on rm.id = s.room_id
      where r.user_id = p_user order by r.created_at desc limit 20) q), '[]'::jsonb),
    'moves', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', m.id, 'moved_at', m.moved_at, 'by_admin', m.by_admin,
        'from', (select rm.name || ' ' || s.label from seats s join rooms rm on rm.id = s.room_id where s.id = m.from_seat),
        'to', (select rm.name || ' ' || s.label from seats s join rooms rm on rm.id = s.room_id where s.id = m.to_seat)) x
      from seat_moves m where m.user_id = p_user order by m.moved_at desc limit 30) q), '[]'::jsonb),
    'reports_made', (select count(*) from seat_reports where reporter_id = p_user),
    'reports_dismissed', (select count(*) from seat_reports where reporter_id = p_user and status = 'dismissed'));
end $$;

notify pgrst, 'reload schema';
