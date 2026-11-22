-- 허위·남발 신고 방지
-- 1) 같은 학생을 24시간 안에 두 번 신고할 수 없다 (특정인 괴롭힘 방지)
-- 2) 하루 신고 한도
-- 3) 신고가 기각(이용자가 자리에 있었음)된 횟수가 누적되면 신고 기능 정지 + 벌점
alter table profiles add column if not exists report_banned_until timestamptz;

insert into settings(key, value) values
  ('report_daily_limit', '5'),
  ('false_report_limit', '3'),
  ('false_report_window_days', '30'),
  ('false_report_ban_days', '7'),
  ('pen_false_report', '1')
on conflict (key) do nothing;

create or replace function seat_report_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare owner uuid; until timestamptz;
begin
  select report_banned_until into until from profiles where id = new.reporter_id;
  if until is not null and until > now() then
    raise exception '허위 신고 누적으로 %까지 신고할 수 없습니다.', to_char(until at time zone 'Asia/Seoul', 'MM월 DD일 HH24:MI');
  end if;
  if (select count(*) from seat_reports where reporter_id = new.reporter_id and created_at > now() - interval '24 hours') >= cfg('report_daily_limit') then
    raise exception '신고는 하루에 %건까지만 할 수 있습니다.', cfg('report_daily_limit')::int;
  end if;
  select user_id into owner from reservations where id = new.reservation_id;
  if exists (
    select 1 from seat_reports sr join reservations r on r.id = sr.reservation_id
    where sr.reporter_id = new.reporter_id and r.user_id = owner and sr.created_at > now() - interval '24 hours'
  ) then
    raise exception '같은 이용자는 24시간 안에 다시 신고할 수 없습니다. 계속 비어 있다면 안내 데스크에 알려 주세요.';
  end if;
  return new;
end $$;
drop trigger if exists seat_reports_guard on seat_reports;
create trigger seat_reports_guard before insert on seat_reports
  for each row execute function seat_report_guard();

-- 신고가 기각되면 신고자의 허위 신고 횟수를 확인
create or replace function seat_report_dismissed() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int; lim int := cfg('false_report_limit'); days int := cfg('false_report_ban_days');
begin
  if new.status = 'dismissed' and old.status is distinct from 'dismissed' then
    select count(*) into n from seat_reports
      where reporter_id = new.reporter_id and status = 'dismissed'
        and resolved_at > now() - make_interval(days => cfg('false_report_window_days')::int);
    if n >= lim and n % lim = 0 then
      update profiles set report_banned_until = now() + make_interval(days => days) where id = new.reporter_id;
      perform add_penalty(new.reporter_id, null, 'false_report', cfg('pen_false_report')::int,
        format('이용자가 자리에 있던 좌석을 %s회 신고함 · %s일간 신고 불가', n, days));
    elsif n = lim - 1 then
      perform notify(new.reporter_id, '신고 전에 한 번 더 확인해 주세요',
        format('이용자가 자리에 있던 좌석을 신고한 일이 %s회 있습니다. %s회가 되면 %s일간 신고할 수 없고 벌점이 부여됩니다.', n, lim, days));
    end if;
  end if;
  return null;
end $$;
drop trigger if exists seat_reports_dismissed on seat_reports;
create trigger seat_reports_dismissed after update on seat_reports
  for each row execute function seat_report_dismissed();

-- 관리자가 신고 정지를 풀 수 있게
create or replace function admin_report_unban(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update profiles set report_banned_until = null where id = p_user;
  perform notify(p_user, '신고 정지가 해제되었습니다', '다시 자리비움 신고를 할 수 있습니다.');
  perform log_admin('report_unban', p_user, null, null, null);
end $$;
