-- 알림 확인: 내 기기로 푸시가 오는지 직접 눌러 본다. 알림을 넣고 곧바로 발송을 요청한다(1분 주기를 기다리지 않게)
create or replace function test_push() returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); url text; secret text;
begin
  if u is null then raise exception '로그인이 필요합니다.'; end if;
  if exists (select 1 from notifications where user_id = u and title = '알림 확인' and created_at > now() - interval '15 seconds') then
    raise exception '방금 보냈습니다. 잠시 뒤 다시 눌러 주세요.';
  end if;
  perform notify(u, '알림 확인', '이 알림이 보이면 이 기기에서 알림이 정상입니다.', '/');
  select value into url from private_config where key = 'push_flush_url';
  select value into secret from private_config where key = 'push_flush_secret';
  if url is not null and url <> '' then
    perform net.http_post(url := url, headers := jsonb_build_object('Content-Type', 'application/json', 'x-flush-secret', secret), body := '{}'::jsonb);
  end if;
end $$;
revoke execute on function test_push() from public, anon;
grant execute on function test_push() to authenticated;

notify pgrst, 'reload schema';
