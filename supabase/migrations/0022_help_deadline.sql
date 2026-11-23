-- 처리 대기: 도움 요청에는 남은 대기 시간(체크인·복귀 마감), 신고에는 이용자의 이용 시간을 함께 준다
create or replace function admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d0 timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
begin
  perform require_admin();
  return jsonb_build_object(
    'today', jsonb_build_object(
      'reservations', (select count(*) from reservations where created_at >= d0),
      'no_shows', (select count(*) from reservations where created_at >= d0 and status = 'no_show'),
      'auto_returns', (select count(*) from reservations where ended_at >= d0 and end_reason in ('away_timeout','report')),
      'reports', (select count(*) from seat_reports where created_at >= d0),
      'active', (select count(*) from reservations where status in ('reserved','in_use','away'))),
    'reports', coalesce((select jsonb_agg(jsonb_build_object(
        'id', rep.id, 'created_at', rep.created_at, 'respond_deadline', rep.respond_deadline, 'occupancy_pct', rep.occupancy_pct,
        'seat_label', s.label, 'room_name', rm.name, 'room_id', rm.id,
        'owner_name', po.name, 'owner_sid', po.student_id, 'owner_id', po.id,
        'reporter_name', pr.name, 'reporter_sid', pr.student_id,
        'end_at', r.end_at, 'checked_in_at', r.checked_in_at, 'extend_count', r.extend_count) order by rep.created_at)
      from seat_reports rep join seats s on s.id = rep.seat_id join rooms rm on rm.id = s.room_id
      join reservations r on r.id = rep.reservation_id join profiles po on po.id = r.user_id
      join profiles pr on pr.id = rep.reporter_id where rep.status = 'pending'), '[]'::jsonb),
    'helps', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'created_at', h.created_at, 'reason', h.reason, 'message', h.message, 'reservation_id', h.reservation_id,
        'name', p.name, 'student_id', p.student_id, 'user_id', p.id,
        'seat_label', s.label, 'room_name', rm.name, 'room_id', rm.id, 'seat_id', s.id, 'res_status', r.status, 'end_at', r.end_at,
        'deadline', case when r.status = 'reserved' then r.checkin_deadline when r.status = 'away' then r.away_deadline end) order by h.created_at)
      from help_requests h join profiles p on p.id = h.user_id
      left join reservations r on r.id = h.reservation_id left join seats s on s.id = coalesce(h.seat_id, r.seat_id) left join rooms rm on rm.id = s.room_id
      where h.status = 'open'), '[]'::jsonb),
    'appeals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'created_at', a.created_at, 'message', a.message, 'name', p.name, 'student_id', p.student_id, 'user_id', p.id,
        'penalty_type', pe.type, 'points', pe.points, 'note', pe.note, 'penalty_at', pe.created_at) order by a.created_at)
      from appeals a join profiles p on p.id = a.user_id join penalties pe on pe.id = a.penalty_id
      where a.status = 'open'), '[]'::jsonb));
end $$;

notify pgrst, 'reload schema';
