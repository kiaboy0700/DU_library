-- 신고자와 관리자의 대화. 도움 요청과 같이 관리자가 열어야 신고자가 보낼 수 있다
alter table seat_reports add column if not exists chat_open boolean not null default false;

create table if not exists report_messages (
  id bigint generated always as identity primary key,
  report_id bigint not null references seat_reports(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists report_messages_idx on report_messages(report_id, id);
alter table report_messages enable row level security;
drop policy if exists report_messages_read on report_messages;
create policy report_messages_read on report_messages for select to authenticated
  using (is_admin() or exists (select 1 from seat_reports r where r.id = report_id and r.reporter_id = auth.uid()));
do $$ begin
  alter publication supabase_realtime add table report_messages;
exception when duplicate_object then null; end $$;

create or replace function report_thread(p_report bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r seat_reports;
begin
  select * into r from seat_reports where id = p_report;
  if not found or not (is_admin() or r.reporter_id = auth.uid()) then raise exception '볼 수 없는 대화입니다.'; end if;
  return jsonb_build_object(
    'open', r.chat_open and r.status = 'pending',
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
        'mine', m.sender_id = auth.uid(), 'admin', p.role = 'admin') order by m.id)
      from report_messages m join profiles p on p.id = m.sender_id where m.report_id = p_report), '[]'::jsonb));
end $$;
grant execute on function report_thread(bigint) to authenticated;

create or replace function send_report_message(p_report bigint, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); r seat_reports; p profiles; txt text := trim(coalesce(p_body, '')); adm boolean := is_admin(); lbl text;
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  select * into r from seat_reports where id = p_report;
  if not found or not (adm or r.reporter_id = u) then raise exception '보낼 수 없는 대화입니다.'; end if;
  if r.status <> 'pending' then raise exception '이미 처리가 끝난 신고입니다.'; end if;
  if txt = '' then raise exception '내용을 입력해 주세요.'; end if;
  if not adm and not r.chat_open then raise exception '관리자가 대화를 열면 보낼 수 있습니다.'; end if;
  insert into report_messages(report_id, sender_id, body) values (p_report, u, left(txt, 500));
  select label into lbl from seats where id = r.seat_id;
  if adm then
    update seat_reports set chat_open = true where id = p_report and not chat_open;
    perform notify(r.reporter_id, format('관리자 메시지 · %s 신고', lbl), left(txt, 120), '/me#reports');
  else
    select * into p from profiles where id = u;
    perform notify_admins(format('신고자 메시지 · %s', lbl), format('%s: %s', p.name, left(txt, 100)), '/admin/reports');
  end if;
end $$;
grant execute on function send_report_message(bigint, text) to authenticated;

create or replace function admin_report_chat(p_report bigint, p_open boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update seat_reports set chat_open = p_open where id = p_report and status = 'pending';
  if not found then raise exception '이미 처리가 끝난 신고입니다.'; end if;
end $$;
grant execute on function admin_report_chat(bigint, boolean) to authenticated;

-- 내가 한 신고 중 아직 처리 중인 것 (관리자와 대화가 있는 것만 화면에 보인다)
create or replace function my_reports() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'seat_label', s.label, 'room_name', rm.name, 'created_at', r.created_at,
      'chat', r.chat_open or exists (select 1 from report_messages m where m.report_id = r.id)) order by r.created_at desc), '[]'::jsonb)
  from seat_reports r join seats s on s.id = r.seat_id join rooms rm on rm.id = s.room_id
  where r.reporter_id = auth.uid() and r.status = 'pending';
$$;
grant execute on function my_reports() to authenticated;
notify pgrst, 'reload schema';
