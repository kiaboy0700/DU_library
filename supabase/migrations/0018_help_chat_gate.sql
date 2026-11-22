-- 도움 요청 대화는 관리자가 열어야 학생이 보낼 수 있다 (관리자가 먼저 메시지를 보내면 자동으로 열린다)
alter table help_requests add column if not exists chat_open boolean not null default false;

drop function if exists help_thread(bigint);
create or replace function help_thread(p_help bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare h help_requests;
begin
  select * into h from help_requests where id = p_help;
  if not found or not (is_admin() or h.user_id = auth.uid()) then raise exception '볼 수 없는 대화입니다.'; end if;
  return jsonb_build_object(
    'open', h.chat_open and h.status = 'open',
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
        'mine', m.sender_id = auth.uid(), 'admin', p.role = 'admin') order by m.id)
      from help_messages m join profiles p on p.id = m.sender_id where m.help_id = p_help), '[]'::jsonb));
end $$;
grant execute on function help_thread(bigint) to authenticated;

create or replace function send_help_message(p_help bigint, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); h help_requests; p profiles; txt text := trim(coalesce(p_body, '')); adm boolean := is_admin();
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  select * into h from help_requests where id = p_help;
  if not found or not (adm or h.user_id = u) then raise exception '보낼 수 없는 대화입니다.'; end if;
  if h.status <> 'open' then raise exception '이미 끝난 도움 요청입니다.'; end if;
  if txt = '' then raise exception '내용을 입력해 주세요.'; end if;
  if not adm and not h.chat_open then raise exception '관리자가 대화를 열면 보낼 수 있습니다.'; end if;
  insert into help_messages(help_id, sender_id, body) values (p_help, u, left(txt, 500));
  if adm then
    update help_requests set chat_open = true where id = p_help and not chat_open;
    perform notify(h.user_id, '관리자 메시지', left(txt, 120), '/me#help');
  else
    select * into p from profiles where id = u;
    perform notify_admins(format('도움 요청 메시지 · %s', p.name), left(txt, 120), '/admin/reports');
  end if;
end $$;

-- 관리자가 학생의 대화를 열거나 막는다
create or replace function admin_help_chat(p_help bigint, p_open boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update help_requests set chat_open = p_open where id = p_help and status = 'open';
  if not found then raise exception '이미 끝난 도움 요청입니다.'; end if;
end $$;
grant execute on function admin_help_chat(bigint, boolean) to authenticated;

-- 학생 화면이 열림·막힘을 바로 알도록
do $$ begin
  alter publication supabase_realtime add table help_requests;
exception when duplicate_object then null; end $$;
notify pgrst, 'reload schema';
