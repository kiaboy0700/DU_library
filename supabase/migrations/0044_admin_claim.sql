-- 관리자가 여러 명일 때: 신고·도움 요청·이의신청을 누가 맡았는지 남기고, 다른 관리자가 겹쳐 처리하지 못하게 한다.

alter table seat_reports add column if not exists handler_id uuid references profiles(id) on delete set null;
alter table seat_reports add column if not exists handler_at timestamptz;
alter table help_requests add column if not exists handler_id uuid references profiles(id) on delete set null;
alter table help_requests add column if not exists handler_at timestamptz;
alter table appeals add column if not exists handler_id uuid references profiles(id) on delete set null;
alter table appeals add column if not exists handler_at timestamptz;

-- 처리 함수 맨 앞에서 부른다. 다른 관리자가 맡은 건이면 막고, 아무도 맡지 않은 건이면 내가 맡은 것으로 남긴다
create or replace function claim_check(p_kind text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); h uuid; nm text; open_ boolean;
begin
  if p_id is null then return; end if;
  if p_kind = 'report' then select handler_id, status = 'pending' into h, open_ from seat_reports where id = p_id for update;
  elsif p_kind = 'help' then select handler_id, status = 'open' into h, open_ from help_requests where id = p_id for update;
  else select handler_id, status = 'open' into h, open_ from appeals where id = p_id for update;
  end if;
  -- 이미 끝난 건은 각 함수가 알아서 알린다
  if not found or not open_ then return; end if;
  if h is not null and h <> me then
    select name into nm from profiles where id = h;
    raise exception '%님이 처리 중입니다. 넘겨받은 뒤 처리해 주세요.', coalesce(nm, '다른 관리자');
  end if;
  if h is null then
    if p_kind = 'report' then update seat_reports set handler_id = me, handler_at = now() where id = p_id;
    elsif p_kind = 'help' then update help_requests set handler_id = me, handler_at = now() where id = p_id;
    else update appeals set handler_id = me, handler_at = now() where id = p_id;
    end if;
  end if;
end $$;
revoke execute on function claim_check(text, bigint) from public, anon, authenticated;

-- 맡기 / 넘겨받기
create or replace function admin_claim(p_kind text, p_id bigint, p_take boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); h uuid; open_ boolean; nm text; mine text; what text;
begin
  perform require_admin();
  if p_kind = 'report' then
    select rep.handler_id, rep.status = 'pending', rm.name || ' ' || s.label || ' 자리비움 신고' into h, open_, what
      from seat_reports rep join seats s on s.id = rep.seat_id join rooms rm on rm.id = s.room_id where rep.id = p_id for update of rep;
  elsif p_kind = 'help' then
    select hr.handler_id, hr.status = 'open', p.name || ' 학생의 도움 요청' into h, open_, what
      from help_requests hr join profiles p on p.id = hr.user_id where hr.id = p_id for update of hr;
  elsif p_kind = 'appeal' then
    select a.handler_id, a.status = 'open', p.name || ' 학생의 이의신청' into h, open_, what
      from appeals a join profiles p on p.id = a.user_id where a.id = p_id for update of a;
  else
    raise exception '알 수 없는 종류입니다.';
  end if;
  if open_ is null or not open_ then raise exception '이미 끝난 건입니다.'; end if;
  if h = me then return; end if;
  if h is not null and not p_take then
    select name into nm from profiles where id = h;
    raise exception '이미 %님이 맡았습니다.', coalesce(nm, '다른 관리자');
  end if;
  if p_kind = 'report' then
    -- 확인 중이던 신고를 넘겨받으면 확인 시간을 다시 센다
    update seat_reports set handler_id = me, handler_at = now(), checking_at = case when stage = 'checking' then now() else checking_at end where id = p_id;
  elsif p_kind = 'help' then update help_requests set handler_id = me, handler_at = now() where id = p_id;
  else update appeals set handler_id = me, handler_at = now() where id = p_id;
  end if;
  if h is not null then
    select name into mine from profiles where id = me;
    perform notify(h, format('%s님이 넘겨받았습니다', mine), what, '/admin/reports');
  end if;
  perform log_admin(case when h is null then 'claim' else 'takeover' end, null, null, null, what);
end $$;
revoke execute on function admin_claim(text, bigint, boolean) from public, anon;
grant execute on function admin_claim(text, bigint, boolean) to authenticated;

-- 맡은 것을 내려놓는다 (다른 관리자가 맡을 수 있게)
create or replace function admin_release(p_kind text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n int;
begin
  perform require_admin();
  if p_kind = 'report' then
    if exists (select 1 from seat_reports where id = p_id and stage = 'checking' and status = 'pending') then
      raise exception '확인 중인 신고는 내려놓을 수 없습니다. 결론을 내거나 다른 관리자가 넘겨받아야 합니다.';
    end if;
    update seat_reports set handler_id = null, handler_at = null where id = p_id and handler_id = me and status = 'pending';
  elsif p_kind = 'help' then update help_requests set handler_id = null, handler_at = null where id = p_id and handler_id = me and status = 'open';
  else update appeals set handler_id = null, handler_at = null where id = p_id and handler_id = me and status = 'open';
  end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception '내가 맡은 건이 아닙니다.'; end if;
end $$;
revoke execute on function admin_release(text, bigint) from public, anon;
grant execute on function admin_release(text, bigint) to authenticated;

-- 처리 함수들: 다른 관리자가 맡은 건이면 거절
create or replace function admin_report_check(p_report bigint) returns void
language plpgsql security definer set search_path = public as $$
declare rep seat_reports; r reservations; lbl text;
begin
  perform require_admin();
  perform claim_check('report', p_report);
  update seat_reports set stage = 'checking', checking_at = now() where id = p_report and status = 'pending' and stage <> 'checking' returning * into rep;
  if not found then raise exception '이미 확인 중이거나 끝난 신고입니다.'; end if;
  select * into r from reservations where id = rep.reservation_id;
  select label into lbl from seats where id = rep.seat_id;
  perform notify(r.user_id, format('%s 관리자가 자리를 확인하고 있습니다', lbl), '자리에 있다면 지금 좌석 QR을 찍어 주세요. 비어 있으면 반납되고 벌점이 붙습니다.');
  perform notify(rep.reporter_id, format('%s 신고 · 관리자 확인 중', lbl), '결과가 나오면 알려 드립니다.', '/me#reports');
  perform log_admin('report:check', r.user_id, rep.seat_id, r.id, null);
end $$;

create or replace function admin_resolve_report(p_report bigint, p_decision text) returns void
language plpgsql security definer set search_path = public as $$
declare rep seat_reports; r reservations; s seats; pts int; busy boolean; pri boolean;
begin
  perform require_admin();
  perform claim_check('report', p_report);
  select * into rep from seat_reports where id = p_report and status = 'pending';
  if not found then raise exception '이미 처리된 신고입니다.'; end if;
  select * into r from reservations where id = rep.reservation_id;
  select * into s from seats where id = rep.seat_id;
  if p_decision = 'confirm' then
    busy := rep.occupancy_pct >= cfg('occ_high') or current_mode() = 'exam';
    pts := case when busy then cfg('pen_report_busy') else cfg('pen_report') end;
    update seat_reports set status = 'confirmed', resolved_at = now(), resolved_by = 'admin' where id = rep.id;
    pri := grant_report_priority(s.id, rep.reporter_id);
    perform end_reservation(r.id, 'report');
    perform add_penalty(r.user_id, r.id, 'vacancy_report', pts, format('%s 좌석 자리비움 (관리자 현장 확인)', s.label));
    perform notify(rep.reporter_id, format('신고한 %s 좌석이 반납되었습니다', s.label),
      case when pri then priority_text(rep.reporter_id) else '지금 빈자리입니다.' end,
      case when pri then '/s/' || s.qr_token else '/rooms/' || s.room_id end);
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

create or replace function admin_report_chat(p_report bigint, p_open boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  perform claim_check('report', p_report);
  update seat_reports set chat_open = p_open where id = p_report and status = 'pending';
  if not found then raise exception '이미 처리가 끝난 신고입니다.'; end if;
end $$;

create or replace function admin_resolve_help(p_help bigint, p_resolution text) returns void
language plpgsql security definer set search_path = public as $$
declare h help_requests;
begin
  perform require_admin();
  perform claim_check('help', p_help);
  update help_requests set status = 'resolved', resolution = p_resolution, resolved_at = now()
    where id = p_help and status = 'open' returning * into h;
  if not found then raise exception '이미 처리된 요청입니다.'; end if;
  -- 정지해 둔 체크인 마감을 다시 15분 부여
  -- 멈춰 둔 동안 지나간 마감은 지금부터 다시 센다 (풀자마자 벌점이 붙지 않게)
  update reservations set on_hold = false,
      checkin_deadline = case when status = 'reserved' then greatest(checkin_deadline, now() + make_interval(mins => cfg('checkin_minutes')::int)) else checkin_deadline end,
      away_deadline = case when status = 'away' then greatest(away_deadline, now() + interval '10 minutes') else away_deadline end,
      end_at = greatest(end_at, now() + interval '10 minutes')
    where id = h.reservation_id and status in ('reserved','in_use','away');
  update seat_reports set respond_deadline = greatest(respond_deadline, now() + interval '10 minutes')
    where reservation_id = h.reservation_id and status = 'pending';
  perform notify(h.user_id, '도움 요청 처리 완료', coalesce(nullif(p_resolution, ''), '관리자가 확인했습니다. 멈춰 있던 시간은 지금부터 다시 흐릅니다.'));
  perform log_admin('help:resolve', h.user_id, null, h.reservation_id, p_resolution);
end $$;

create or replace function admin_help_chat(p_help bigint, p_open boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  perform claim_check('help', p_help);
  update help_requests set chat_open = p_open where id = p_help and status = 'open';
  if not found then raise exception '이미 끝난 도움 요청입니다.'; end if;
end $$;

create or replace function admin_resolve_appeal(p_appeal bigint, p_approve boolean, p_reply text) returns void
language plpgsql security definer set search_path = public as $$
declare a appeals; lim int := cfg('false_report_limit'); win interval := make_interval(days => cfg('false_report_window_days')::int); n int;
begin
  perform require_admin();
  perform claim_check('appeal', p_appeal);
  update appeals set status = case when p_approve then 'approved' else 'rejected' end, reply = p_reply, resolved_at = now()
    where id = p_appeal and status = 'open' returning * into a;
  if not found then raise exception '이미 처리된 이의신청입니다.'; end if;
  if a.report_id is not null then
    -- 허위 신고 이의신청: 승인하면 허위 신고 기록에서 빼고, 그 때문에 걸린 신고 정지·벌점도 푼다
    if p_approve then
      update seat_reports set resolved_by = 'admin_returned' where id = a.report_id;
      select count(*) into n from seat_reports
        where reporter_id = a.user_id and status = 'dismissed' and resolved_by = 'admin' and resolved_at > now() - win;
      if n < lim then
        update profiles set report_banned_until = null where id = a.user_id;
        update penalties set revoked_at = now() where user_id = a.user_id and type = 'false_report' and revoked_at is null and created_at > now() - win;
        perform refresh_ban(a.user_id);
      end if;
      perform notify(a.user_id, '허위 신고 이의신청 승인', coalesce(nullif(p_reply, ''), '허위 신고 기록에서 지웠습니다.'));
    else
      perform notify(a.user_id, '허위 신고 이의신청 반려', coalesce(nullif(p_reply, ''), '허위 신고 기록이 유지됩니다.'));
    end if;
  elsif p_approve then
    update penalties set revoked_at = now() where id = a.penalty_id and revoked_at is null;
    perform refresh_ban(a.user_id);
    perform notify(a.user_id, '이의신청이 승인되었습니다', coalesce(nullif(p_reply, ''), '벌점이 취소되었습니다.'));
  else
    perform notify(a.user_id, '이의신청이 반려되었습니다', coalesce(nullif(p_reply, ''), '벌점이 유지됩니다.'));
  end if;
  perform log_admin('appeal:' || case when p_approve then 'approve' else 'reject' end, a.user_id, null, null, p_reply);
end $$;

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
        'reporter_name', pr.name, 'reporter_sid', pr.student_id, 'stage', rep.stage, 'handler_id', hp.id, 'handler_name', hp.name, 'handler_at', rep.handler_at,
        'end_at', r.end_at, 'checked_in_at', r.checked_in_at, 'extend_count', r.extend_count) order by rep.created_at)
      from seat_reports rep join seats s on s.id = rep.seat_id join rooms rm on rm.id = s.room_id
      join reservations r on r.id = rep.reservation_id join profiles po on po.id = r.user_id
      join profiles pr on pr.id = rep.reporter_id left join profiles hp on hp.id = rep.handler_id where rep.status = 'pending'), '[]'::jsonb),
    -- 관리자가 처리하지 않았는데 끝난 건: 한 시간 동안 어떻게 끝났는지 보여 준다
    'recent_reports', coalesce((select jsonb_agg(jsonb_build_object(
        'id', rep.id, 'created_at', rep.created_at, 'resolved_at', rep.resolved_at, 'seat_label', s.label, 'room_name', rm.name,
        'owner_name', po.name, 'owner_sid', po.student_id, 'reporter_name', pr.name, 'reporter_sid', pr.student_id,
        'handler_name', case when rep.resolved_by like 'admin%' then hp.name end,
        'how', case when rep.resolved_by = 'admin_returned' then 'admin_returned' when rep.resolved_by = 'admin' and rep.status = 'confirmed' then 'admin_confirm' when rep.resolved_by = 'admin' and rep.status = 'dismissed' then 'admin_false' when rep.resolved_by = 'admin' then 'admin' when rep.status = 'cancelled' then 'cancelled' when rep.status = 'dismissed' then 'returned' when rep.status = 'confirmed' then 'auto' else 'closed' end)
        order by rep.resolved_at desc)
      from seat_reports rep join seats s on s.id = rep.seat_id join rooms rm on rm.id = s.room_id
      join reservations r on r.id = rep.reservation_id join profiles po on po.id = r.user_id
      join profiles pr on pr.id = rep.reporter_id left join profiles hp on hp.id = rep.handler_id
      where rep.status <> 'pending' and (rep.resolved_by in ('owner','reporter','auto') or (rep.resolved_by like 'admin%' and rep.handler_id is not null)) and rep.resolved_at > now() - interval '1 hour'), '[]'::jsonb),
    'recent_helps', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'created_at', h.created_at, 'resolved_at', h.resolved_at, 'reason', h.reason, 'name', p.name, 'student_id', p.student_id,
        'handler_name', case when h.status = 'resolved' then hp.name end)
        order by h.resolved_at desc)
      from help_requests h join profiles p on p.id = h.user_id left join profiles hp on hp.id = h.handler_id
      where (h.status = 'cancelled' or (h.status = 'resolved' and h.handler_id is not null)) and h.resolved_at > now() - interval '1 hour'), '[]'::jsonb),
    'helps', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'created_at', h.created_at, 'reason', h.reason, 'message', h.message, 'reservation_id', h.reservation_id,
        'name', p.name, 'student_id', p.student_id, 'user_id', p.id, 'handler_id', hp.id, 'handler_name', hp.name, 'handler_at', h.handler_at,
        'seat_label', s.label, 'room_name', rm.name, 'room_id', rm.id, 'seat_id', s.id, 'res_status', r.status, 'end_at', r.end_at,
        'deadline', case when r.status = 'reserved' then r.checkin_deadline when r.status = 'away' then r.away_deadline end) order by h.created_at)
      from help_requests h join profiles p on p.id = h.user_id
      left join reservations r on r.id = h.reservation_id left join seats s on s.id = coalesce(h.seat_id, r.seat_id) left join rooms rm on rm.id = s.room_id
      left join profiles hp on hp.id = h.handler_id
      where h.status = 'open'), '[]'::jsonb),
    'appeals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'created_at', a.created_at, 'message', a.message, 'name', p.name, 'student_id', p.student_id, 'user_id', p.id, 'handler_id', hp.id, 'handler_name', hp.name, 'handler_at', a.handler_at,
        'penalty_type', pe.type, 'points', pe.points, 'note', pe.note, 'penalty_at', pe.created_at,
        'report_id', a.report_id, 'report_seat', (select rm.name || ' ' || st.label from seats st join rooms rm on rm.id = st.room_id where st.id = sr.seat_id),
        'report_at', sr.created_at) order by a.created_at)
      from appeals a join profiles p on p.id = a.user_id left join penalties pe on pe.id = a.penalty_id left join seat_reports sr on sr.id = a.report_id
      left join profiles hp on hp.id = a.handler_id
      where a.status = 'open'), '[]'::jsonb));
end $$;

-- 학생 쪽: 도움 요청을 관리자가 맡았는지
create or replace function my_help() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', h.id, 'reason', h.reason, 'message', h.message, 'created_at', h.created_at,
      'seat_label', s.label, 'room_name', rm.name, 'claimed', h.handler_id is not null)
  from help_requests h left join reservations r on r.id = h.reservation_id
    left join seats s on s.id = coalesce(h.seat_id, r.seat_id) left join rooms rm on rm.id = s.room_id
  where h.user_id = auth.uid() and h.status = 'open' order by h.created_at desc limit 1;
$$;

notify pgrst, 'reload schema';
