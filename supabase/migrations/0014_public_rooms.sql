-- 로그인 화면에 보여 줄 열람실별 빈자리 수 (로그인 전에도 볼 수 있는 숫자만)
create or replace function public_rooms() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name,
    'total', (select count(*) from seats s where s.room_id = r.id and s.is_active),
    'free', (select count(*) from seats s join seat_state ss on ss.seat_id = s.id where s.room_id = r.id and s.is_active and ss.state = 'free'),
    'pct', room_occupancy(r.id),
    'is_open', (select st.is_open from room_status(r.id) st)
  ) order by r.floor), '[]'::jsonb)
  from rooms r;
$$;
grant execute on function public_rooms() to anon, authenticated;
notify pgrst, 'reload schema';
