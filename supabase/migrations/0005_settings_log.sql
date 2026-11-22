-- 설정 변경도 관리자 처리 기록에 남긴다
create or replace function admin_log_setting(p_keys text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  perform log_admin('settings', null, null, null, p_keys);
end $$;
