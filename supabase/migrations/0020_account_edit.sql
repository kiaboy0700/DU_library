-- 학생 계정 수정·삭제 (관리자)
create or replace function admin_update_account(p_user uuid, p_name text, p_department text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if nullif(trim(p_name), '') is null then raise exception '이름을 입력해 주세요.'; end if;
  update profiles set name = trim(p_name), department = nullif(trim(coalesce(p_department, '')), '') where id = p_user and role = 'student';
  if not found then raise exception '학생 계정만 수정할 수 있습니다.'; end if;
  perform log_admin('account:update', p_user, null, null, trim(p_name));
end $$;
grant execute on function admin_update_account(uuid, text, text) to authenticated;

create or replace function admin_delete_account(p_user uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
declare p profiles;
begin
  perform require_admin();
  select * into p from profiles where id = p_user;
  if not found then raise exception '없는 계정입니다.'; end if;
  if p.role <> 'student' then raise exception '학생 계정만 삭제할 수 있습니다.'; end if;
  -- 쓰던 좌석은 비우고, 계정과 그 학생의 기록(예약·벌점·알림)을 함께 지운다
  update reservations set status = 'cancelled', ended_at = now(), end_reason = 'admin', on_hold = false
    where user_id = p_user and status in ('reserved','in_use','away');
  perform log_admin('account:delete', null, null, null, format('%s(%s)', p.name, p.student_id));
  delete from auth.users where id = p_user;
end $$;
grant execute on function admin_delete_account(uuid) to authenticated;
notify pgrst, 'reload schema';
