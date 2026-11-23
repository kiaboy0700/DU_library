-- 보관 짐: 묶음마다 고유 번호(층-좌석-날짜), 한 학생의 짐 여러 개를 한 묶음으로, 번호로 검색
--   묶음 번호  2F-N024-1123        2층 N-024 좌석, 11월 23일   (같은 좌석·같은 날 두 번째 묶음은 2F-N024-1123B)
--   짐 번호    2F-N024-1123-1, -2  묶음 안의 짐 하나하나
alter table stored_items add column if not exists code text;
alter table stored_items add column if not exists items jsonb not null default '[]'::jsonb;
create unique index if not exists stored_items_code on stored_items(code);

create or replace function item_code(p_seat int) returns text
language plpgsql security definer set search_path = public as $$
declare base text; cand text; n int := 0;
begin
  select rm.floor || 'F-' || replace(s.label, '-', '') into base from seats s join rooms rm on rm.id = s.room_id where s.id = p_seat;
  base := coalesce(base, 'ETC') || '-' || to_char(now() at time zone 'Asia/Seoul', 'MMDD');
  cand := base;
  while exists (select 1 from stored_items where code = cand) loop
    n := n + 1;
    cand := base || chr(65 + n);   -- B, C, D …
  end loop;
  return cand;
end $$;
revoke execute on function item_code(int) from public, anon, authenticated;

-- 예전 방식으로 들어간 기록에 번호를 붙인다
do $$
declare r record;
begin
  for r in select id, seat_id, memo from stored_items where code is null order by id loop
    update stored_items set code = item_code(r.seat_id),
      items = (select coalesce(jsonb_agg(trim(x)), '[]'::jsonb) from regexp_split_to_table(r.memo, '[,\n]+') x where trim(x) <> '')
    where id = r.id;
  end loop;
end $$;

-- 보관 등록. p_memo 에 쉼표나 줄바꿈으로 여러 개를 적으면 한 묶음의 짐 여러 개가 된다
drop function if exists admin_store_item(text, bigint, text);
create or replace function admin_store_item(p_memo text, p_report bigint default null, p_student text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; sid int; id_ bigint; until_ timestamptz; list jsonb; code_ text; memo_ text;
begin
  perform require_admin();
  select coalesce(jsonb_agg(left(trim(x), 60)), '[]'::jsonb) into list from regexp_split_to_table(coalesce(p_memo, ''), '[,\n]+') x where trim(x) <> '';
  if jsonb_array_length(list) = 0 then raise exception '보관한 물건을 적어 주세요.'; end if;
  if jsonb_array_length(list) > 20 then raise exception '한 묶음에 20개까지 등록할 수 있습니다.'; end if;
  select string_agg(v, ', ') into memo_ from jsonb_array_elements_text(list) v;
  if p_report is not null then
    select r.user_id, sr.seat_id into uid, sid from seat_reports sr join reservations r on r.id = sr.reservation_id where sr.id = p_report;
  else
    select id into uid from profiles where student_id = trim(p_student) and role = 'student';
    select r.seat_id into sid from reservations r where r.user_id = uid order by r.id desc limit 1;
  end if;
  if uid is null then raise exception '학생을 찾을 수 없습니다.'; end if;
  until_ := (date_trunc('day', now() at time zone 'Asia/Seoul') + make_interval(days => cfg('storage_days')::int + 1) - interval '1 minute') at time zone 'Asia/Seoul';
  code_ := item_code(sid);
  insert into stored_items(user_id, seat_id, memo, items, code, place, hours, until_at)
    values (uid, sid, memo_, list, code_, cfgt('storage_place'), cfgt('storage_hours'), until_) returning id into id_;
  perform notify(uid, format('짐 %s개를 보관하고 있습니다 · %s', jsonb_array_length(list), code_),
    format('%s · %s · %s까지 찾아가 주세요 (%s).', left(memo_, 60), cfgt('storage_place'), to_char(until_ at time zone 'Asia/Seoul', 'MM월 DD일'), cfgt('storage_hours')), '/me#items');
  perform log_admin('item:store', uid, sid, null, code_ || ' ' || memo_);
  return jsonb_build_object('id', id_, 'code', code_, 'count', jsonb_array_length(list));
end $$;
grant execute on function admin_store_item(text, bigint, text) to authenticated;

-- 목록. p_q 가 있으면 번호·학번·이름으로 찾고, 이미 찾아갔거나 처분한 것도 함께 보여 준다
drop function if exists admin_items();
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
          'seat', (select rm.name || ' ' || s.label from seats s join rooms rm on rm.id = s.room_id where s.id = i.seat_id)) x
        from stored_items i join profiles p on p.id = i.user_id
        where case when q = '' then i.status = 'stored'
              -- 짐 번호(2F-N024-1123-2)를 넣어도 그 묶음을 찾는다
              else i.code like q || '%' or q like i.code || '%' or p.student_id like q || '%' or p.name like '%' || trim(p_q) || '%' end
        order by (i.status = 'stored') desc, i.until_at limit 50) t), '[]'::jsonb));
end $$;
grant execute on function admin_items(text) to authenticated;

create or replace function my_items() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'code', i.code, 'items', i.items, 'memo', i.memo, 'place', i.place, 'hours', i.hours, 'until_at', i.until_at, 'created_at', i.created_at,
      'seat', (select rm.name || ' ' || s.label from seats s join rooms rm on rm.id = s.room_id where s.id = i.seat_id)) order by i.until_at), '[]'::jsonb)
  from stored_items i where i.user_id = auth.uid() and i.status = 'stored';
$$;

notify pgrst, 'reload schema';
