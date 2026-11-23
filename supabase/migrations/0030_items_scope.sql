-- 짐 보관은 자리비움 신고 처리에서만: 좌석·시각·이용자는 신고에서 자동으로 정해지고, 관리자는 보관한 짐만 적는다.
-- 분실물(주인·좌석 없는 등록)과 학번으로 직접 등록하는 길은 없앤다. 보관 기간이 지나면 폐기될 수 있음을 함께 알린다.
drop function if exists lost_items();
drop function if exists admin_store_item(text, bigint, text, text);
drop function if exists admin_store_item(text, bigint, text);

create or replace function storage_text() returns text
language sql stable security definer set search_path = public as $$
  select format('%s에서 %s일간 보관합니다 (%s). 보관 기간이 지나면 폐기될 수 있습니다.', cfgt('storage_place'), cfg('storage_days')::int, cfgt('storage_hours'));
$$;

create or replace function admin_store_item(p_memo text, p_report bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; sid int; id_ bigint; until_ timestamptz; list jsonb; code_ text; memo_ text;
begin
  perform require_admin();
  select coalesce(jsonb_agg(left(trim(x), 60)), '[]'::jsonb) into list from regexp_split_to_table(coalesce(p_memo, ''), '[,\n]+') x where trim(x) <> '';
  if jsonb_array_length(list) = 0 then raise exception '보관한 물건을 적어 주세요.'; end if;
  if jsonb_array_length(list) > 20 then raise exception '한 번에 20개까지 등록할 수 있습니다.'; end if;
  select string_agg(v, ', ') into memo_ from jsonb_array_elements_text(list) v;
  select r.user_id, sr.seat_id into uid, sid from seat_reports sr join reservations r on r.id = sr.reservation_id where sr.id = p_report;
  if uid is null then raise exception '신고를 찾을 수 없습니다.'; end if;
  until_ := (date_trunc('day', now() at time zone 'Asia/Seoul') + make_interval(days => cfg('storage_days')::int + 1) - interval '1 minute') at time zone 'Asia/Seoul';
  code_ := item_code(sid);
  insert into stored_items(user_id, seat_id, memo, items, code, place, hours, until_at)
    values (uid, sid, memo_, list, code_, cfgt('storage_place'), cfgt('storage_hours'), until_) returning id into id_;
  perform notify(uid, format('짐 %s개를 보관하고 있습니다 · %s', jsonb_array_length(list), code_),
    format('%s · %s · %s까지 (%s). 기간이 지나면 폐기될 수 있습니다.', left(memo_, 60), cfgt('storage_place'), to_char(until_ at time zone 'Asia/Seoul', 'MM월 DD일'), cfgt('storage_hours')), '/me#items');
  perform log_admin('item:store', uid, sid, null, code_ || ' ' || memo_);
  return jsonb_build_object('id', id_, 'code', code_, 'count', jsonb_array_length(list));
end $$;
grant execute on function admin_store_item(text, bigint) to authenticated;

create or replace function warn_stored_items() returns void
language plpgsql security definer set search_path = public as $$
declare it record;
begin
  for it in select * from stored_items where status = 'stored' and not warned and user_id is not null and until_at < now() + interval '1 day'
  loop
    update stored_items set warned = true where id = it.id;
    perform notify(it.user_id, format('보관 중인 짐 · 내일까지 · %s', it.code), format('%s · %s (%s). 기간이 지나면 폐기될 수 있습니다.', it.memo, it.place, coalesce(it.hours, '')), '/me#items');
  end loop;
end $$;

notify pgrst, 'reload schema';
