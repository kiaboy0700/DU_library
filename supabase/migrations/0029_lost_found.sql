-- 분실물도 같은 보관함에: 주인을 모르는 물건(학생 없음), 좌석이 아닌 곳에서 나온 물건(발견 위치를 글로)
--   좌석에서 나온 짐  2F-N024-1123
--   그 밖의 분실물    LF-1123, LF-1123B, …  (LF = Lost & Found)
alter table stored_items alter column user_id drop not null;
alter table stored_items add column if not exists found_at text;

create or replace function item_code(p_seat int) returns text
language plpgsql security definer set search_path = public as $$
declare base text; cand text; n int := 0;
begin
  select rm.floor || 'F-' || replace(s.label, '-', '') into base from seats s join rooms rm on rm.id = s.room_id where s.id = p_seat;
  base := coalesce(base, 'LF') || '-' || to_char(now() at time zone 'Asia/Seoul', 'MMDD');
  cand := base;
  while exists (select 1 from stored_items where code = cand) loop
    n := n + 1;
    cand := base || case when n <= 25 then chr(65 + n) else 'Z' || (n - 25) end;
  end loop;
  return cand;
end $$;
revoke execute on function item_code(int) from public, anon, authenticated;

-- 등록: 신고 건에서(p_report) / 학번으로(p_student) / 주인 모르는 분실물(둘 다 없이 p_where 만)
drop function if exists admin_store_item(text, bigint, text);
create or replace function admin_store_item(p_memo text, p_report bigint default null, p_student text default null, p_where text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; sid int; id_ bigint; until_ timestamptz; list jsonb; code_ text; memo_ text;
        stu text := nullif(trim(coalesce(p_student, '')), ''); loc text := nullif(trim(coalesce(p_where, '')), '');
begin
  perform require_admin();
  select coalesce(jsonb_agg(left(trim(x), 60)), '[]'::jsonb) into list from regexp_split_to_table(coalesce(p_memo, ''), '[,\n]+') x where trim(x) <> '';
  if jsonb_array_length(list) = 0 then raise exception '보관한 물건을 적어 주세요.'; end if;
  if jsonb_array_length(list) > 20 then raise exception '한 묶음에 20개까지 등록할 수 있습니다.'; end if;
  select string_agg(v, ', ') into memo_ from jsonb_array_elements_text(list) v;
  if p_report is not null then
    select r.user_id, sr.seat_id into uid, sid from seat_reports sr join reservations r on r.id = sr.reservation_id where sr.id = p_report;
    if uid is null then raise exception '신고를 찾을 수 없습니다.'; end if;
  elsif stu is not null then
    select id into uid from profiles where student_id = stu and role = 'student';
    if uid is null then raise exception '학생을 찾을 수 없습니다.'; end if;
    -- 발견 위치를 따로 적지 않았으면 그 학생이 마지막으로 쓴 좌석
    if loc is null then select r.seat_id into sid from reservations r where r.user_id = uid order by r.id desc limit 1; end if;
  elsif loc is null then
    raise exception '학번이나 발견 위치 중 하나는 적어 주세요.';
  end if;
  until_ := (date_trunc('day', now() at time zone 'Asia/Seoul') + make_interval(days => cfg('storage_days')::int + 1) - interval '1 minute') at time zone 'Asia/Seoul';
  code_ := item_code(sid);
  insert into stored_items(user_id, seat_id, found_at, memo, items, code, place, hours, until_at)
    values (uid, sid, loc, memo_, list, code_, cfgt('storage_place'), cfgt('storage_hours'), until_) returning id into id_;
  if uid is not null then
    perform notify(uid, format('짐 %s개를 보관하고 있습니다 · %s', jsonb_array_length(list), code_),
      format('%s · %s · %s까지 찾아가 주세요 (%s).', left(memo_, 60), cfgt('storage_place'), to_char(until_ at time zone 'Asia/Seoul', 'MM월 DD일'), cfgt('storage_hours')), '/me#items');
  end if;
  perform log_admin('item:store', uid, sid, null, code_ || ' ' || memo_);
  return jsonb_build_object('id', id_, 'code', code_, 'count', jsonb_array_length(list));
end $$;
grant execute on function admin_store_item(text, bigint, text, text) to authenticated;

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
  if it.user_id is not null then
    perform notify(it.user_id, case when p_status = 'picked' then '보관한 짐을 찾아가셨습니다' else '보관 기간이 지나 짐을 처분했습니다' end, it.code || ' · ' || it.memo, '/me');
  end if;
  perform log_admin('item:' || p_status, it.user_id, it.seat_id, null, it.code || ' ' || it.memo);
end $$;

create or replace function admin_items(p_q text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q text := upper(trim(coalesce(p_q, '')));
begin
  perform require_admin();
  return jsonb_build_object(
    'place', cfgt('storage_place'), 'hours', cfgt('storage_hours'), 'days', cfg('storage_days')::int,
    'count', (select count(*) from stored_items where status = 'stored'),
    'items', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('id', i.id, 'code', i.code, 'items', i.items, 'memo', i.memo, 'place', i.place, 'until_at', i.until_at, 'created_at', i.created_at,
          'status', i.status, 'closed_at', i.closed_at, 'name', p.name, 'student_id', p.student_id,
          'seat', coalesce(i.found_at, (select rm.name || ' ' || s.label from seats s join rooms rm on rm.id = s.room_id where s.id = i.seat_id))) x
        from stored_items i left join profiles p on p.id = i.user_id
        where case when q = '' then i.status = 'stored'
              else i.code like q || '%' or regexp_replace(q, '-[0-9]+$', '') = i.code or p.student_id like q || '%'
                or p.name like '%' || trim(p_q) || '%' or i.memo ilike '%' || trim(p_q) || '%' or i.found_at ilike '%' || trim(p_q) || '%' end
        order by (i.status = 'stored') desc, i.until_at limit 50) t), '[]'::jsonb));
end $$;

create or replace function my_items() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'code', i.code, 'items', i.items, 'memo', i.memo, 'place', i.place, 'hours', i.hours, 'until_at', i.until_at, 'created_at', i.created_at,
      'seat', coalesce(i.found_at, (select rm.name || ' ' || s.label from seats s join rooms rm on rm.id = s.room_id where s.id = i.seat_id))) order by i.until_at), '[]'::jsonb)
  from stored_items i where i.user_id = auth.uid() and i.status = 'stored';
$$;

-- 주인을 모르는 분실물: 학생 누구나 볼 수 있다 (무엇이, 어디서, 언제 나왔는지와 보관 번호)
create or replace function lost_items() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('place', cfgt('storage_place'), 'hours', cfgt('storage_hours'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'code', i.code, 'items', i.items, 'found_at', i.found_at, 'created_at', i.created_at, 'until_at', i.until_at)
      order by i.created_at desc) from stored_items i where i.user_id is null and i.status = 'stored'), '[]'::jsonb));
$$;
grant execute on function lost_items() to authenticated;

notify pgrst, 'reload schema';
