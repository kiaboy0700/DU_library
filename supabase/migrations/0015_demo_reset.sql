-- 시연 전체 초기화: 좌석·예약·벌점·신고·알림을 모두 처음 상태로
create or replace function admin_demo_reset() returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_res int; n_pen int;
begin
  perform require_admin();

  -- 좌석: 진행 중인 예약과 맡아 둔 자리를 모두 비운다
  delete from seat_holds where true;
  update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'admin' where status = 'pending';
  update reservations set status = 'cancelled', ended_at = now(), end_reason = 'admin', on_hold = false
    where status in ('reserved','in_use','away');
  get diagnostics n_res = row_count;

  -- 좌석 수·열람실 상태: 사용 중지한 좌석과 임시 폐쇄를 되돌린다
  update seats set is_active = true, inactive_reason = null where not is_active;
  update rooms set is_closed = false, closed_reason = null where is_closed;

  -- 학생: 벌점, 이의신청, 예약 정지, 신고 정지, 도움 요청, 빈자리 알림, 알림함
  select count(*) into n_pen from penalties;
  delete from appeals where true;
  delete from penalties where true;
  update profiles set banned_until = null, ban_reason = null, report_banned_until = null
    where banned_until is not null or report_banned_until is not null;
  update help_requests set status = 'resolved', resolution = '시연 초기화', resolved_at = now() where status = 'open';
  delete from watch_requests where true;
  delete from notifications where true;

  -- 운영 상황: 시연용 기간과 장애 모드
  delete from operating_periods where label = '시연';
  update settings set value = 'false'::jsonb where key = 'incident_mode';

  perform log_admin('demo_reset_all', null, null, null, format('예약 %s건, 벌점 %s건', n_res, n_pen));
  return jsonb_build_object('reservations', n_res, 'penalties', n_pen);
end $$;
revoke execute on function admin_demo_reset() from public, anon;
grant execute on function admin_demo_reset() to authenticated;

notify pgrst, 'reload schema';
