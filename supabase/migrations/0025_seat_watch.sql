-- 특정 좌석 알림: 지금 누가 쓰고 있는 좌석이 비거나, 이용 종료 5분 전에 알려 준다
create table if not exists seat_watches (
  user_id uuid not null references profiles(id) on delete cascade,
  seat_id int not null references seats(id) on delete cascade,
  warned boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, seat_id)
);
alter table seat_watches enable row level security;
drop policy if exists own_read on seat_watches;
create policy own_read on seat_watches for select to authenticated using (user_id = auth.uid());

-- 켜고 끄기. 켜져 있으면 true 를 돌려준다. 한 사람이 동시에 세 좌석까지
create or replace function toggle_seat_watch(p_seat int) returns boolean
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  delete from seat_watches where user_id = u and seat_id = p_seat;
  if found then return false; end if;
  if not exists (select 1 from seat_state where seat_id = p_seat and state <> 'free') then
    raise exception '지금 빈자리입니다. 바로 예약할 수 있어요.';
  end if;
  if exists (select 1 from reservations where seat_id = p_seat and user_id = u and status in ('reserved','in_use','away')) then
    raise exception '내 좌석입니다.';
  end if;
  if (select count(*) from seat_watches where user_id = u) >= 3 then raise exception '좌석 알림은 세 좌석까지 켤 수 있습니다.'; end if;
  insert into seat_watches(user_id, seat_id) values (u, p_seat);
  return true;
end $$;
grant execute on function toggle_seat_watch(int) to authenticated;


create or replace function resync_seat(sid int) returns void
language plpgsql security definer set search_path = public as $$
declare r record; h record; new_state text; old_state text; rid int; rname text; lbl text; v_end timestamptz; v_until timestamptz; v_ext int;
begin
  select status, end_at, extend_count,
         case status when 'reserved' then checkin_deadline when 'away' then coalesce(away_deadline, end_at) else end_at end as until_at
    into r from reservations where seat_id = sid and status in ('reserved','in_use','away') limit 1;
  if r.status is not null then
    new_state := r.status; v_end := r.end_at; v_until := r.until_at; v_ext := r.extend_count;
  else
    select expires_at into h from seat_holds where seat_id = sid and expires_at > now();
    if found then
      new_state := 'reserved'; v_end := null; v_until := h.expires_at; v_ext := 0;
    else
      new_state := 'free'; v_end := null; v_until := null; v_ext := 0;
    end if;
  end if;
  select state, room_id into old_state, rid from seat_state where seat_id = sid;
  update seat_state set state = new_state, end_at = v_end, until_at = v_until, extend_count = v_ext, updated_at = now()
    where seat_id = sid and (state, end_at, until_at, extend_count) is distinct from (new_state, v_end, v_until, v_ext);
  if old_state is distinct from new_state and new_state = 'free' then
    select name into rname from rooms where id = rid;
    insert into notifications(user_id, title, body, url)
      select w.user_id, '빈자리가 생겼어요', format('%s에 자리가 났습니다. 지금 예약하세요.', rname), '/rooms/' || rid
      from watch_requests w where w.room_id = rid;
    delete from watch_requests where room_id = rid;
    -- 이 좌석을 기다리던 학생에게
    select label into lbl from seats where id = sid;
    insert into notifications(user_id, title, body, url)
      select w.user_id, format('%s 빈자리가 되었습니다', lbl), format('%s · 지금 예약할 수 있습니다.', rname), '/rooms/' || rid
      from seat_watches w where w.seat_id = sid;
    delete from seat_watches where seat_id = sid;
  end if;
end $$;

create or replace function tick() returns void
language plpgsql security definer set search_path = public as $$
declare r record; pts int; busy boolean; url text; secret text; pri boolean;
begin
  -- 0) 도움 요청이 2시간 넘게 처리되지 않으면 멈춤을 푼다 (관리자가 없는 시간에 좌석이 계속 묶이지 않게). 마감은 지금부터 다시 센다
  for r in select h.id, h.reservation_id, h.user_id from help_requests h where h.status = 'open' and h.created_at < now() - interval '2 hours'
  loop
    update help_requests set status = 'resolved', resolution = '오래 처리되지 않아 자동으로 닫혔습니다', resolved_at = now() where id = r.id;
    update reservations set on_hold = false,
        checkin_deadline = case when status = 'reserved' then now() + make_interval(mins => cfg('checkin_minutes')::int) else checkin_deadline end,
        away_deadline = case when status = 'away' then now() + interval '10 minutes' else away_deadline end
      where id = r.reservation_id and status in ('reserved','in_use','away');
    perform notify(r.user_id, '도움 요청이 닫혔습니다', '2시간 동안 처리되지 않아 닫혔습니다. 문제가 계속되면 다시 요청해 주세요.');
  end loop;

  if not cfgb('incident_mode') then
    -- 1) 노쇼: 체크인 마감 초과
    for r in select res.*, s.label from reservations res join seats s on s.id = res.seat_id
             where res.status = 'reserved' and res.checkin_deadline < now() and not res.on_hold
    loop
      update reservations set status = 'no_show', ended_at = now(), end_reason = 'no_show' where id = r.id;
      perform add_penalty(r.user_id, r.id, 'no_show', cfg('pen_no_show')::int, format('%s 좌석 예약 후 체크인하지 않음', r.label));
    end loop;

    -- 2) 외출 시간 초과
    for r in select res.*, s.label from reservations res join seats s on s.id = res.seat_id
             where res.status = 'away' and res.away_deadline < now() and res.away_deadline < res.end_at and not res.on_hold
    loop
      perform end_reservation(r.id, 'away_timeout');
      perform add_penalty(r.user_id, r.id, 'away_timeout', cfg('pen_away')::int, format('%s 좌석 외출 시간 초과로 자동 반납', r.label));
    end loop;

    -- 3) 자리비움 신고 응답 기한 초과
    for r in select rep.id as report_id, rep.reporter_id, rep.occupancy_pct, res.id, res.user_id, res.status, s.label, s.room_id
             from seat_reports rep join reservations res on res.id = rep.reservation_id join seats s on s.id = res.seat_id
             where rep.status = 'pending' and rep.respond_deadline < now() and not res.on_hold
    loop
      if r.status = 'in_use' then
        busy := r.occupancy_pct >= cfg('occ_high') or current_mode() = 'exam';
        pts := case when busy then cfg('pen_report_busy') else cfg('pen_report') end;
        update seat_reports set status = 'confirmed', resolved_at = now(), resolved_by = 'auto' where id = r.report_id;
        pri := grant_report_priority((select seat_id from reservations where id = r.id), r.reporter_id);
        perform end_reservation(r.id, 'report');
        perform add_penalty(r.user_id, r.id, 'vacancy_report', pts, format('%s 좌석 자리비움 신고 확인 요청에 응답하지 않음', r.label));
        perform notify(r.reporter_id, format('신고한 %s 좌석이 반납되었습니다', r.label),
          case when pri then format('%s분 동안 먼저 예약할 수 있습니다.', cfg('report_priority_minutes')::int) else '지금 빈자리입니다.' end,
          case when pri then '/s/' || (select qr_token from seats where id = (select seat_id from reservations where id = r.id)) else '/rooms/' || r.room_id end);
      else
        update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'auto' where id = r.report_id;
      end if;
    end loop;
  end if;

  -- 4) 이용 시간 종료
  for r in select res.id, res.user_id, st.label, rm.name as room from reservations res join seats st on st.id = res.seat_id join rooms rm on rm.id = st.room_id
           where res.status in ('reserved','in_use','away') and res.end_at < now() and not res.on_hold
  loop
    perform end_reservation(r.id, 'expired');
    perform notify(r.user_id, format('%s 이용 시간 종료', r.label), format('%s %s 좌석이 반납되었습니다.', r.room, r.label));
  end loop;

  -- 5) 폐관·임시 폐쇄된 열람실 정리
  for r in select res.id, res.user_id, s.label from reservations res join seats s on s.id = res.seat_id,
           lateral room_status(s.room_id) st
           where res.status in ('reserved','in_use','away') and not st.is_open
  loop
    perform end_reservation(r.id, 'closing');
    perform notify(r.user_id, '열람실 운영 종료', format('%s 좌석이 반납되었습니다. 벌점은 없습니다.', r.label));
  end loop;

  -- 6) 미리 알림
  for r in select res.id, res.user_id, st.label from reservations res join seats st on st.id = res.seat_id
           where res.status in ('in_use','away') and not res.notified_end and res.end_at < now() + interval '10 minutes'
  loop
    update reservations set notified_end = true where id = r.id;
    perform notify(r.user_id, format('%s 이용 종료 10분 전', r.label), '더 이용하려면 지금 연장하세요. 시간이 지나면 자동 반납됩니다.');
  end loop;
  for r in select res.id, res.user_id, st.label from reservations res join seats st on st.id = res.seat_id
           where res.status = 'away' and not res.notified_away and res.away_deadline < now() + interval '5 minutes'
  loop
    update reservations set notified_away = true where id = r.id;
    perform notify(r.user_id, format('%s 복귀 5분 전', r.label), '자리로 돌아와 좌석 QR을 찍어 주세요. 늦으면 자동 반납되고 벌점이 붙습니다.');
  end loop;

  -- 6-1) 기다리는 좌석의 이용 종료 5분 전
  for r in select w.user_id, w.seat_id, st.label, st.room_id from seat_watches w join seats st on st.id = w.seat_id
             join reservations res on res.seat_id = w.seat_id and res.status in ('in_use','away')
           where not w.warned and res.end_at < now() + interval '5 minutes'
  loop
    update seat_watches set warned = true where user_id = r.user_id and seat_id = r.seat_id;
    perform notify(r.user_id, format('%s 5분 뒤 이용 종료 예정', r.label), '이용자가 연장하면 더 늦어집니다. 비면 다시 알려 드립니다.', '/rooms/' || r.room_id);
  end loop;

  -- 7) 혼잡도 기록 (10분마다)
  if extract(minute from now())::int % 10 = 0 then
    insert into occupancy_snapshots(room_id, occupied, total)
      select s.room_id, count(*) filter (where ss.state <> 'free'), count(*)
      from seats s join seat_state ss on ss.seat_id = s.id where s.is_active group by s.room_id;
  end if;

  -- 8) 푸시 발송 요청 (앱 서버가 notifications 큐를 비움)
  if exists (select 1 from notifications where pushed_at is null and created_at > now() - interval '30 minutes') then
    select value into url from private_config where key = 'push_flush_url';
    select value into secret from private_config where key = 'push_flush_secret';
    if url is not null and url <> '' then
      perform net.http_post(url := url, headers := jsonb_build_object('Content-Type', 'application/json', 'x-flush-secret', secret), body := '{}'::jsonb);
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
