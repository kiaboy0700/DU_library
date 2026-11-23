-- 학생 검색 정렬: 학번으로 찾으면 학번 순, 이름으로 찾으면 이름 순(같은 이름은 학번이 빠른 순)
create or replace function admin_search_users(p_q text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q text := coalesce(trim(p_q), ''); by_name boolean := q <> '' and q !~ '^[0-9]+$';
begin
  perform require_admin();
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object('id', p.id, 'student_id', p.student_id, 'name', p.name, 'department', p.department, 'grade', p.grade,
      'role', p.role, 'banned_until', p.banned_until, 'ban_reason', p.ban_reason, 'points', penalty_points(p.id),
      'active', exists (select 1 from reservations r where r.user_id = p.id and r.status in ('reserved','in_use','away'))) x
    from profiles p
    where q = '' and p.role = 'student' and (p.banned_until > now() or p.report_banned_until > now() or penalty_points(p.id) > 0)
       or q <> '' and (p.student_id ilike '%' || q || '%' or p.name ilike '%' || q || '%')
    order by case when by_name then p.name collate "C" end, p.student_id limit 50) t), '[]'::jsonb);
end $$;
notify pgrst, 'reload schema';
