-- 자리비움 신고의 경우의 수 정리. 원칙: 자동 처리가 기본이고, 관리자는 '확인 시작'을 누른 건만 끝까지 맡는다.
--   · 관리자가 확인 중인 신고는 신고자가 취소할 수 없다 (헛걸음 방지)
--   · 확인 중에 이용자가 돌아오거나 스스로 반납하면 신고는 자동으로 끝나고, 관리자에게 '가지 않아도 됨'을 바로 알린다
--   · 확인 전(자동 처리 중)에 끝난 건은 관리자에게 알림을 보내지 않고 '방금 끝난 건'에만 남긴다
--   · 신고한 학생은 그 좌석 화면에서 자기 신고의 단계를 보고 취소할 수 있다


create or replace function cancel_report(p_report bigint) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); rep seat_reports; r reservations; lbl text; rname text; p profiles;
begin
  if exists (select 1 from seat_reports where id = p_report and reporter_id = u and status = 'pending' and stage = 'checking') then
    raise exception '관리자가 확인하고 있어 취소할 수 없습니다. 곧 결과를 알려 드립니다.';
  end if;
  update seat_reports set status = 'cancelled', resolved_at = now(), resolved_by = 'reporter'
    where id = p_report and reporter_id = u and status = 'pending' returning * into rep;
  if not found then raise exception '취소할 수 없는 신고입니다.'; end if;
  select * into r from reservations where id = rep.reservation_id;
  select s.label, rm.name into lbl, rname from seats s join rooms rm on rm.id = s.room_id where s.id = rep.seat_id;
  select * into p from profiles where id = u;
  perform notify(r.user_id, format('%s 자리 확인 요청 취소', lbl), '신고가 취소되었습니다. 벌점은 없습니다.');
end $$;

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
    select reporter_id, format('%s 이용자가 자리로 돌아왔습니다', s.label), '신고는 정상 처리되었고 불이익은 없습니다.', '/me'
    from seat_reports where reservation_id = r.id and status = 'pending';
  -- 관리자가 확인하러 가는 중이었다면 바로 알린다
  if exists (select 1 from seat_reports where reservation_id = r.id and status = 'pending' and stage = 'checking') then
    perform notify_admins(format('%s 이용자가 돌아왔습니다', s.label), '확인하러 가지 않아도 됩니다. 신고는 자동으로 끝났습니다.', '/admin/reports');
  end if;
  update seat_reports set status = 'dismissed', resolved_at = now(), resolved_by = 'owner'
    where reservation_id = r.id and status = 'pending';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function sync_seat_state() returns trigger
language plpgsql security definer set search_path = public as $$
declare sid int;
begin
  -- 예약이 끝나면 맡아 둔 이동 좌석도 풀어 준다
  if new.status not in ('reserved','in_use','away') then
    delete from seat_holds where reservation_id = new.id;
    -- 끝난 예약에 걸려 있던 신고는 더 처리할 것이 없다
    if exists (select 1 from seat_reports where reservation_id = new.id and status = 'pending' and stage = 'checking') then
      perform notify_admins(format('%s 이용자가 좌석을 반납했습니다', (select label from seats where id = new.seat_id)), '확인하러 가지 않아도 됩니다. 신고는 자동으로 끝났습니다.', '/admin/reports');
    end if;
    -- 이용자가 스스로 반납해 끝난 신고: 신고자에게도 알린다
    insert into notifications(user_id, title, body, url)
      select sr.reporter_id, format('신고한 %s 좌석이 반납되었습니다', (select label from seats where id = new.seat_id)), '이용자가 좌석을 반납했습니다.', '/rooms/' || (select room_id from seats where id = new.seat_id)
      from seat_reports sr where sr.reservation_id = new.id and sr.status = 'pending' and new.end_reason in ('user', 'expired');
    update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'auto' where reservation_id = new.id and status = 'pending';
  end if;
  -- 그 좌석을 예약했거나 그 좌석으로 옮겼으면 우선권은 다 쓴 것
  if tg_op = 'INSERT' or new.seat_id is distinct from old.seat_id then
    delete from seat_holds where seat_id = new.seat_id and user_id = new.user_id and kind = 'priority';
  end if;
  for sid in select distinct x from unnest(array[new.seat_id, case when tg_op = 'UPDATE' then old.seat_id end]) x where x is not null
  loop
    perform resync_seat(sid);
  end loop;
  return null;
end $$;

-- 좌석 화면: 내가 이 좌석을 신고해 둔 상태인지, 다른 학생의 신고가 걸려 있는지
create or replace function seat_context_v2(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select seat_context(p_token) || jsonb_build_object(
    'held_by_me', exists (select 1 from seat_holds h join seats s on s.id = h.seat_id where s.qr_token = p_token and h.expires_at > now() and h.user_id = auth.uid() and h.kind = 'move'),
    'priority_until', (select h.expires_at from seat_holds h join seats s on s.id = h.seat_id where s.qr_token = p_token and h.expires_at > now() and h.user_id = auth.uid() and h.kind = 'priority'),
    'held_by_other', exists (select 1 from seat_holds h join seats s on s.id = h.seat_id where s.qr_token = p_token and h.expires_at > now() and h.user_id <> auth.uid()),
    'my_report', (select jsonb_build_object('id', sr.id, 'stage', sr.stage, 'respond_deadline', sr.respond_deadline, 'created_at', sr.created_at)
      from seat_reports sr join seats s on s.id = sr.seat_id where s.qr_token = p_token and sr.status = 'pending' and sr.reporter_id = auth.uid() limit 1),
    'reported', exists (select 1 from seat_reports sr join seats s on s.id = sr.seat_id where s.qr_token = p_token and sr.status = 'pending'));
$$;

notify pgrst, 'reload schema';
