-- 자주 쓰는 조회를 위한 인덱스 (데이터는 바꾸지 않는다)
-- 1분마다 도는 tick()과 좌석맵·관리자 화면이 상태별로 예약을 찾는다
create index if not exists reservations_active_idx on reservations(status, end_at) where status in ('reserved','in_use','away');
create index if not exists seat_state_room_idx on seat_state(room_id);
create index if not exists seats_room_idx on seats(room_id);
create index if not exists seat_reports_pending_idx on seat_reports(reservation_id) where status = 'pending';
create index if not exists seat_reports_reporter_idx on seat_reports(reporter_id, created_at desc);
create index if not exists penalties_user_idx on penalties(user_id, created_at desc);
create index if not exists notifications_unpushed_idx on notifications(created_at) where pushed_at is null;
create index if not exists notifications_unread_idx on notifications(user_id) where read_at is null;
create index if not exists help_requests_open_idx on help_requests(user_id) where status = 'open';
