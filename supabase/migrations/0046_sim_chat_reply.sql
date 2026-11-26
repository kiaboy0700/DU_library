-- 가상 학생 자동 답장: 관리자가 가상 학생의 도움 요청·신고 대화에 메시지를 보내면, 가상 학생이 테스트용 답장을 보낸다.
-- 팀원이 그 가상 학생 계정으로 직접 로그인해 쓰는 중(최근 3시간)이면 답장하지 않는다.
create or replace function sim_chat_reply() returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid; msgs text[]; n int;
begin
  if not exists (select 1 from profiles where id = new.sender_id and role = 'admin') then return new; end if;
  if tg_table_name = 'help_messages' then
    select user_id into u from help_requests where id = new.help_id and status = 'open';
    select count(*) into n from help_messages where help_id = new.help_id and sender_id = new.sender_id;
    msgs := array[
      '[가상 학생 자동 답장] 네, 확인했습니다. 안내해 주신 대로 다시 해 볼게요.',
      '[가상 학생 자동 답장] 다시 해 봤는데 이제 됩니다. 감사합니다.',
      '[가상 학생 자동 답장] 테스트 답장입니다. 더 필요한 것은 없습니다.'];
  else
    select reporter_id into u from seat_reports where id = new.report_id and status = 'pending';
    select count(*) into n from report_messages where report_id = new.report_id and sender_id = new.sender_id;
    msgs := array[
      '[가상 학생 자동 답장] 네, 지금도 자리에 사람은 없고 짐만 있습니다.',
      '[가상 학생 자동 답장] 제가 본 지 20분쯤 됐습니다. 그동안 아무도 오지 않았어요.',
      '[가상 학생 자동 답장] 테스트 답장입니다. 확인 부탁드립니다.'];
  end if;
  if u is null or not exists (
    select 1 from profiles p join auth.users au on au.id = p.id
    where p.id = u and p.is_virtual and (au.last_sign_in_at is null or au.last_sign_in_at < now() - interval '3 hours')
  ) then return new; end if;
  -- 관리자가 보낸 순서대로 다른 문구, 세 번째부터는 마지막 문구
  if tg_table_name = 'help_messages' then
    insert into help_messages(help_id, sender_id, body, created_at)
      values (new.help_id, u, msgs[least(greatest(n, 1), 3)], new.created_at + interval '1 second');
  else
    insert into report_messages(report_id, sender_id, body, created_at)
      values (new.report_id, u, msgs[least(greatest(n, 1), 3)], new.created_at + interval '1 second');
  end if;
  return new;
end $$;

drop trigger if exists sim_chat_reply on help_messages;
create trigger sim_chat_reply after insert on help_messages for each row execute function sim_chat_reply();
drop trigger if exists sim_chat_reply on report_messages;
create trigger sim_chat_reply after insert on report_messages for each row execute function sim_chat_reply();
