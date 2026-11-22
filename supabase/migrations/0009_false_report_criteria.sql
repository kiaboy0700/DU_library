-- 허위 신고 기준 다시 정하기
--
-- 자리가 비어 있어서 신고했는데 이용자가 화장실에서 돌아와 QR을 찍은 경우는 허위 신고가 아니다.
-- 신고 시점에 자리는 실제로 비어 있었기 때문이다. 그래서:
--   * 정상 신고  : 이용자가 QR로 응답함 / 응답 없이 자동 반납됨 / 관리자가 '잠시 비움'으로 확인함
--   * 허위 신고  : 관리자가 현장에서 "신고 당시 이용자가 자리에 앉아 있었다"고 확인한 경우만
--   * 확인 필요  : 신고 후 아주 짧은 시간(기본 2분) 안에 이용자가 응답한 경우.
--                  자리에 있었을 가능성이 높지만 단정할 수 없으므로 벌점 없이 횟수만 세고,
--                  누적되면 관리자에게 살펴보라고 알린다.
insert into settings(key, value) values
  ('false_quick_seconds', '120'),
  ('false_quick_flag', '3')
on conflict (key) do nothing;

create or replace function seat_report_dismissed() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int; q int; lim int := cfg('false_report_limit'); days int := cfg('false_report_ban_days');
        win interval := make_interval(days => cfg('false_report_window_days')::int); pr profiles;
begin
  if new.status = 'dismissed' and old.status is distinct from 'dismissed' then
    if new.resolved_by = 'admin' then
      -- 관리자가 착석을 확인: 허위 신고
      select count(*) into n from seat_reports
        where reporter_id = new.reporter_id and status = 'dismissed' and resolved_by = 'admin' and resolved_at > now() - win;
      if n >= lim and n % lim = 0 then
        update profiles set report_banned_until = now() + make_interval(days => days) where id = new.reporter_id;
        perform add_penalty(new.reporter_id, null, 'false_report', cfg('pen_false_report')::int,
          format('이용자가 앉아 있던 좌석을 %s회 신고함 · %s일간 신고 불가', n, days));
      else
        perform notify(new.reporter_id, '허위 신고로 확인되었습니다',
          format('관리자가 확인한 결과 이용자가 자리에 있었습니다. 허위 신고 %s회 (%s회가 되면 %s일간 신고할 수 없고 벌점이 부여됩니다)', n, lim, days));
      end if;
    elsif new.resolved_by = 'owner' and new.resolved_at - new.created_at <= make_interval(secs => cfg('false_quick_seconds')) then
      -- 신고 직후 응답: 단정하지 않고 관리자에게만 알린다
      select count(*) into q from seat_reports
        where reporter_id = new.reporter_id and status = 'dismissed' and resolved_by = 'owner'
          and resolved_at - created_at <= make_interval(secs => cfg('false_quick_seconds')) and resolved_at > now() - win;
      if q >= cfg('false_quick_flag') and q % cfg('false_quick_flag')::int = 0 then
        select * into pr from profiles where id = new.reporter_id;
        perform notify_admins('허위 신고 의심', format('%s(%s) 학생의 신고에 이용자가 %s초 안에 응답한 일이 %s회 있습니다. 확인해 주세요.',
          pr.name, pr.student_id, cfg('false_quick_seconds')::int, q), '/admin/users');
      end if;
    end if;
  end if;
  return null;
end $$;

-- 이용자가 QR로 응답: 신고자에게는 불이익이 없다고 분명히 알린다
create or replace function confirm_presence(p_token uuid, p_lat double precision default null, p_lng double precision default null) returns int
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); s seats; r reservations; n int;
begin
  select * into s from seats where qr_token = p_token;
  if not found then raise exception '유효하지 않은 QR입니다.'; end if;
  select * into r from reservations where user_id = u and seat_id = s.id and status = 'in_use';
  if not found then raise exception '이용 중인 내 좌석이 아닙니다.'; end if;
  perform gps_check(p_lat, p_lng);
  insert into notifications(user_id, title, body, url)
    select reporter_id, '신고 결과 안내', format('%s 좌석 이용자가 자리로 돌아와 확인했습니다. 신고는 정상 처리되었고 불이익은 없습니다.', s.label), '/me'
    from seat_reports where reservation_id = r.id and status = 'pending';
  update seat_reports set status = 'dismissed', resolved_at = now(), resolved_by = 'owner'
    where reservation_id = r.id and status = 'pending';
  get diagnostics n = row_count;
  return n;
end $$;

-- 관리자 처리: confirm(비어 있음 확정) | returned(잠시 비움, 정상 신고) | dismiss(자리에 있었음, 허위 신고) | extend
create or replace function admin_resolve_report(p_report bigint, p_decision text) returns void
language plpgsql security definer set search_path = public as $$
declare rep seat_reports; r reservations; s seats; pts int; busy boolean;
begin
  perform require_admin();
  select * into rep from seat_reports where id = p_report and status = 'pending';
  if not found then raise exception '이미 처리된 신고입니다.'; end if;
  select * into r from reservations where id = rep.reservation_id;
  select * into s from seats where id = rep.seat_id;
  if p_decision = 'confirm' then
    busy := rep.occupancy_pct >= cfg('occ_high') or current_mode() = 'exam';
    pts := case when busy then cfg('pen_report_busy') else cfg('pen_report') end;
    update seat_reports set status = 'confirmed', resolved_at = now(), resolved_by = 'admin' where id = rep.id;
    perform end_reservation(r.id, 'report');
    perform add_penalty(r.user_id, r.id, 'vacancy_report', pts, format('%s 좌석 자리비움 (관리자 현장 확인)', s.label));
    perform notify(rep.reporter_id, '신고 결과 안내', format('%s 좌석이 반납 처리되어 빈자리가 되었습니다.', s.label), '/rooms/' || s.room_id);
  elsif p_decision = 'returned' then
    -- 자리는 비어 있었고 이용자가 돌아옴: 양쪽 모두 불이익 없음
    update seat_reports set status = 'dismissed', resolved_at = now(), resolved_by = 'admin_returned' where id = rep.id;
    perform notify(r.user_id, '자리 확인 완료', '관리자가 복귀를 확인했습니다. 벌점은 없습니다.');
    perform notify(rep.reporter_id, '신고 결과 안내', format('%s 좌석 이용자가 자리로 돌아왔습니다. 신고는 정상 처리되었고 불이익은 없습니다.', s.label));
  elsif p_decision = 'dismiss' then
    -- 신고 당시 이용자가 자리에 있었음: 허위 신고 (seat_report_dismissed 트리거가 누적 처리)
    update seat_reports set status = 'dismissed', resolved_at = now(), resolved_by = 'admin' where id = rep.id;
    perform notify(r.user_id, '자리 확인 완료', '관리자가 자리에 있었음을 확인했습니다. 벌점은 없습니다.');
  elsif p_decision = 'extend' then
    update seat_reports set respond_deadline = respond_deadline + interval '10 minutes' where id = rep.id;
  else
    raise exception '알 수 없는 처리입니다.';
  end if;
  perform log_admin('report:' || p_decision, r.user_id, s.id, r.id, null);
end $$;

-- 학생의 신고 이력 요약 (관리자 화면)
create or replace function admin_report_stats(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return (select jsonb_build_object(
      'made', count(*),
      'confirmed', count(*) filter (where status = 'confirmed'),
      'returned', count(*) filter (where status = 'dismissed' and resolved_by in ('owner','admin_returned')
                                    and not (resolved_by = 'owner' and resolved_at - created_at <= make_interval(secs => cfg('false_quick_seconds')))),
      'quick', count(*) filter (where status = 'dismissed' and resolved_by = 'owner' and resolved_at - created_at <= make_interval(secs => cfg('false_quick_seconds'))),
      'false', count(*) filter (where status = 'dismissed' and resolved_by = 'admin'))
    from seat_reports where reporter_id = p_user and created_at > now() - make_interval(days => cfg('false_report_window_days')::int));
end $$;

notify pgrst, 'reload schema';
