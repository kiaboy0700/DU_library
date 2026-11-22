-- 알림 지우기 + 도움 요청 대화(학생 ↔ 관리자)

create or replace function clear_notifications(p_id bigint default null) returns void
language sql security definer set search_path = public as $$
  delete from notifications where user_id = auth.uid() and (p_id is null or id = p_id);
$$;
grant execute on function clear_notifications(bigint) to authenticated;

create table if not exists help_messages (
  id bigint generated always as identity primary key,
  help_id bigint not null references help_requests(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists help_messages_idx on help_messages(help_id, id);
alter table help_messages enable row level security;
drop policy if exists help_messages_read on help_messages;
create policy help_messages_read on help_messages for select to authenticated
  using (is_admin() or exists (select 1 from help_requests h where h.id = help_id and h.user_id = auth.uid()));
do $$ begin
  alter publication supabase_realtime add table help_messages;
exception when duplicate_object then null; end $$;

-- 대화 내용. 내 도움 요청이거나 관리자일 때만
create or replace function help_thread(p_help bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_admin() or exists (select 1 from help_requests h where h.id = p_help and h.user_id = auth.uid())) then
    raise exception '볼 수 없는 대화입니다.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
      'mine', m.sender_id = auth.uid(), 'admin', p.role = 'admin') order by m.id)
    from help_messages m join profiles p on p.id = m.sender_id where m.help_id = p_help), '[]'::jsonb);
end $$;
grant execute on function help_thread(bigint) to authenticated;

create or replace function send_help_message(p_help bigint, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); h help_requests; p profiles; txt text := trim(coalesce(p_body, ''));
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  select * into h from help_requests where id = p_help;
  if not found or not (is_admin() or h.user_id = u) then raise exception '보낼 수 없는 대화입니다.'; end if;
  if h.status <> 'open' then raise exception '이미 끝난 도움 요청입니다.'; end if;
  if txt = '' then raise exception '내용을 입력해 주세요.'; end if;
  insert into help_messages(help_id, sender_id, body) values (p_help, u, left(txt, 500));
  if h.user_id = u then
    select * into p from profiles where id = u;
    perform notify_admins(format('도움 요청 메시지 · %s', p.name), left(txt, 120), '/admin/reports');
  else
    perform notify(h.user_id, '관리자 메시지', left(txt, 120), '/me#help');
  end if;
end $$;
grant execute on function send_help_message(bigint, text) to authenticated;

-- 내 도움 요청 요약에 id 포함 (0016 과 같음)
notify pgrst, 'reload schema';
