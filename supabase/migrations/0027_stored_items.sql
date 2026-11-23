-- 짐 보관: 자리비움 신고로 반납된 좌석의 짐을 어디에 언제까지 보관하는지 자동으로 알리고, 실제로 보관한 짐은 기록으로 남긴다
insert into settings(key, value) values
  ('storage_place', '"2층 안내 데스크"'),
  ('storage_hours', '"평일 09:00~18:00"'),
  ('storage_days', '7')
on conflict (key) do nothing;

create or replace function cfgt(k text) returns text
language sql stable security definer set search_path = public as $$
  select value #>> '{}' from settings where key = k;
$$;

create or replace function storage_text() returns text
language sql stable security definer set search_path = public as $$
  select format('%s에서 %s일간 보관합니다 (%s).', cfgt('storage_place'), cfg('storage_days')::int, cfgt('storage_hours'));
$$;

-- 자리비움 신고로 반납될 때 이용자에게 짐 보관 안내를 함께 보낸다
create or replace function end_reservation(p_res bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  update reservations set status = 'ended', ended_at = now(), end_reason = p_reason, on_hold = false
    where id = p_res and status in ('reserved','in_use','away');
  if found and p_reason = 'report' then
    select res.user_id, s.label into r from reservations res join seats s on s.id = res.seat_id where res.id = p_res;
    perform notify(r.user_id, format('%s 자리비움으로 반납 · 짐 보관 안내', r.label), '자리에 둔 짐은 ' || storage_text(), '/me#items');
  end if;
  update seat_reports set status = 'closed', resolved_at = now(), resolved_by = 'auto'
    where reservation_id = p_res and status = 'pending';
end $$;

create table if not exists stored_items (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  seat_id int references seats(id) on delete set null,
  memo text not null,
  place text not null,
  hours text,
  until_at timestamptz not null,
  status text not null default 'stored' check (status in ('stored','picked','disposed')),
  warned boolean not null default false,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
alter table stored_items enable row level security;
drop policy if exists own_read on stored_items;
create policy own_read on stored_items for select to authenticated using (user_id = auth.uid() or is_admin());

-- 보관 등록: 신고 건에서 바로(p_report) 또는 학번으로(p_student)
create or replace function admin_store_item(p_memo text, p_report bigint default null, p_student text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare uid uuid; sid int; id_ bigint; until_ timestamptz; memo_ text := trim(coalesce(p_memo, ''));
begin
  perform require_admin();
  if memo_ = '' then raise exception '보관한 물건을 적어 주세요.'; end if;
  if p_report is not null then
    select r.user_id, sr.seat_id into uid, sid from seat_reports sr join reservations r on r.id = sr.reservation_id where sr.id = p_report;
  else
    select id into uid from profiles where student_id = trim(p_student) and role = 'student';
    select r.seat_id into sid from reservations r where r.user_id = uid order by r.id desc limit 1;
  end if;
  if uid is null then raise exception '학생을 찾을 수 없습니다.'; end if;
  -- 보관 마지막 날의 끝까지
  until_ := (date_trunc('day', now() at time zone 'Asia/Seoul') + make_interval(days => cfg('storage_days')::int + 1) - interval '1 minute') at time zone 'Asia/Seoul';
  insert into stored_items(user_id, seat_id, memo, place, hours, until_at)
    values (uid, sid, left(memo_, 200), cfgt('storage_place'), cfgt('storage_hours'), until_) returning id into id_;
  perform notify(uid, format('짐을 보관하고 있습니다 · %s', left(memo_, 30)),
    format('%s · %s까지 찾아가 주세요 (%s).', cfgt('storage_place'), to_char(until_ at time zone 'Asia/Seoul', 'MM월 DD일'), cfgt('storage_hours')), '/me#items');
  perform log_admin('item:store', uid, sid, null, memo_);
  return id_;
end $$;
grant execute on function admin_store_item(text, bigint, text) to authenticated;

create or replace function admin_item_done(p_item bigint, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare it stored_items;
begin
  perform require_admin();
  if p_status not in ('picked', 'disposed') then raise exception '알 수 없는 처리입니다.'; end if;
  if p_status = 'disposed' and exists (select 1 from stored_items where id = p_item and until_at > now()) then
    raise exception '보관 기한이 지난 뒤에 처분할 수 있습니다.';
  end if;
  update stored_items set status = p_status, closed_at = now() where id = p_item and status = 'stored' returning * into it;
  if not found then raise exception '이미 처리된 보관 건입니다.'; end if;
  perform notify(it.user_id, case when p_status = 'picked' then '보관한 짐을 찾아가셨습니다' else '보관 기간이 지나 짐을 처분했습니다' end, it.memo, '/me');
  perform log_admin('item:' || p_status, it.user_id, it.seat_id, null, it.memo);
end $$;
grant execute on function admin_item_done(bigint, text) to authenticated;

create or replace function admin_items() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return jsonb_build_object(
    'place', cfgt('storage_place'), 'hours', cfgt('storage_hours'), 'days', cfg('storage_days')::int,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'memo', i.memo, 'place', i.place, 'until_at', i.until_at, 'created_at', i.created_at,
        'name', p.name, 'student_id', p.student_id, 'seat', (select rm.name || ' ' || s.label from seats s join rooms rm on rm.id = s.room_id where s.id = i.seat_id)) order by i.until_at)
      from stored_items i join profiles p on p.id = i.user_id where i.status = 'stored'), '[]'::jsonb));
end $$;
grant execute on function admin_items() to authenticated;

create or replace function admin_set_storage(p_place text, p_hours text, p_days int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if nullif(trim(p_place), '') is null then raise exception '보관 장소를 적어 주세요.'; end if;
  if coalesce(p_days, 0) < 1 or p_days > 90 then raise exception '보관 기간은 1일에서 90일 사이로 정해 주세요.'; end if;
  insert into settings(key, value) values ('storage_place', to_jsonb(trim(p_place))), ('storage_hours', to_jsonb(trim(coalesce(p_hours, '')))), ('storage_days', to_jsonb(p_days))
    on conflict (key) do update set value = excluded.value;
  perform log_admin('storage:set', null, null, null, format('%s / %s / %s일', p_place, p_hours, p_days));
end $$;
grant execute on function admin_set_storage(text, text, int) to authenticated;

create or replace function my_items() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'memo', i.memo, 'place', i.place, 'hours', i.hours, 'until_at', i.until_at, 'created_at', i.created_at,
      'seat', (select rm.name || ' ' || s.label from seats s join rooms rm on rm.id = s.room_id where s.id = i.seat_id)) order by i.until_at), '[]'::jsonb)
  from stored_items i where i.user_id = auth.uid() and i.status = 'stored';
$$;
grant execute on function my_items() to authenticated;

-- 보관 기한 하루 전에 한 번 더 알린다
create or replace function warn_stored_items() returns void
language plpgsql security definer set search_path = public as $$
declare it record;
begin
  for it in select * from stored_items where status = 'stored' and not warned and until_at < now() + interval '1 day'
  loop
    update stored_items set warned = true where id = it.id;
    perform notify(it.user_id, '보관 중인 짐 · 내일까지 찾아가 주세요', format('%s · %s (%s)', it.memo, it.place, coalesce(it.hours, '')), '/me#items');
  end loop;
end $$;
revoke execute on function warn_stored_items() from public, anon, authenticated;
do $$ begin
  perform cron.unschedule('du-library-items');
exception when others then null; end $$;
select cron.schedule('du-library-items', '*/10 * * * *', 'select warn_stored_items()');

notify pgrst, 'reload schema';

-- 공지와 알림은 별개: 공지를 올릴 때 '알림도 보내기'를 고르면 학생 모두의 알림함(과 푸시)에 그 공지 알림이 간다
create or replace function admin_announce(p_title text, p_body text, p_room int, p_hours int, p_push boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  insert into announcements(room_id, title, body, until)
    values (p_room, p_title, coalesce(p_body, ''), case when p_hours > 0 then now() + make_interval(hours => p_hours) end);
  if p_push then
    insert into notifications(user_id, title, body, url)
      select id, '공지 · ' || p_title, coalesce(nullif(p_body, ''), '공지에서 확인하세요.'), '/notices' from profiles where role = 'student' and not is_virtual;
  end if;
  perform log_admin('announce', null, null, null, p_title);
end $$;
notify pgrst, 'reload schema';
