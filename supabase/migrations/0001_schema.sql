-- 대구대 창파도서관 열람실 좌석 예약: 테이블과 RLS
create extension if not exists pgcrypto with schema extensions;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  student_id text unique not null,
  name text not null,
  department text,
  grade int,
  role text not null default 'student' check (role in ('student','admin')),
  banned_until timestamptz,
  ban_reason text,
  created_at timestamptz not null default now()
);

create table if not exists rooms (
  id int primary key,
  floor int not null,
  name text not null,
  description text,
  layout_w int not null,
  layout_h int not null,
  decor jsonb not null default '[]',          -- 기둥·테이블·라벨 등 좌석맵 배경 요소
  open_24h_in_exam boolean not null default true,
  is_closed boolean not null default false,   -- 관리자 임시 폐쇄
  closed_reason text
);

create table if not exists seats (
  id int primary key,
  room_id int not null references rooms(id) on delete cascade,
  zone text not null,
  label text not null,
  seat_type text not null check (seat_type in ('general','partition','laptop','window','booth')),
  x int not null,
  y int not null,
  qr_token uuid not null unique default gen_random_uuid(),
  is_active boolean not null default true,
  inactive_reason text,
  unique (room_id, label)
);

create table if not exists reservations (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  seat_id int not null references seats(id) on delete cascade,
  status text not null check (status in ('reserved','in_use','away','ended','no_show','cancelled')),
  start_at timestamptz not null default now(),
  end_at timestamptz not null,
  checkin_deadline timestamptz not null,
  checked_in_at timestamptz,
  away_started_at timestamptz,
  away_deadline timestamptz,
  extend_count int not null default 0,
  ended_at timestamptz,
  end_reason text,                 -- user | expired | closing | away_timeout | report | admin | room_closed
  on_hold boolean not null default false,   -- 도움 요청 접수 중: 자동 취소 정지
  notified_end boolean not null default false,
  notified_away boolean not null default false,
  by_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists one_active_per_seat on reservations(seat_id) where status in ('reserved','in_use','away');
create unique index if not exists one_active_per_user on reservations(user_id) where status in ('reserved','in_use','away');
create index if not exists reservations_user_idx on reservations(user_id, created_at desc);

-- 누구나 볼 수 있는 좌석 상태 (개인 정보 없음). reservations 트리거로 유지, Realtime 대상
create table if not exists seat_state (
  seat_id int primary key references seats(id) on delete cascade,
  room_id int not null references rooms(id) on delete cascade,
  state text not null default 'free' check (state in ('free','reserved','in_use','away')),
  updated_at timestamptz not null default now()
);

create table if not exists penalties (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  reservation_id bigint references reservations(id) on delete set null,
  type text not null,              -- no_show | away_timeout | vacancy_report | manual
  points int not null,
  note text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists seat_reports (
  id bigint generated always as identity primary key,
  seat_id int not null references seats(id) on delete cascade,
  reservation_id bigint not null references reservations(id) on delete cascade,
  reporter_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','dismissed','confirmed','closed')),
  occupancy_pct int not null default 0,
  respond_deadline timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text                 -- owner | auto | admin
);

create table if not exists settings (
  key text primary key,
  value jsonb not null
);

create table if not exists operating_periods (
  id bigint generated always as identity primary key,
  mode text not null check (mode in ('semester','vacation','exam')),
  label text,
  start_date date not null,
  end_date date not null
);

create table if not exists closed_days (
  day date primary key,
  reason text
);

create table if not exists occupancy_snapshots (
  id bigint generated always as identity primary key,
  room_id int not null references rooms(id) on delete cascade,
  taken_at timestamptz not null default now(),
  occupied int not null,
  total int not null
);
create index if not exists snapshots_idx on occupancy_snapshots(room_id, taken_at);

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table if not exists watch_requests (
  user_id uuid not null references profiles(id) on delete cascade,
  room_id int not null references rooms(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, room_id)
);

-- 사이트 내 알림함 겸 푸시 발송 큐
create table if not exists notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  body text not null,
  url text not null default '/me',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  pushed_at timestamptz
);
create index if not exists notifications_user_idx on notifications(user_id, created_at desc);

create table if not exists help_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  reservation_id bigint references reservations(id) on delete set null,
  reason text not null,
  message text,
  status text not null default 'open' check (status in ('open','resolved')),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists appeals (
  id bigint generated always as identity primary key,
  penalty_id bigint not null references penalties(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  message text not null,
  status text not null default 'open' check (status in ('open','approved','rejected')),
  reply text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists announcements (
  id bigint generated always as identity primary key,
  room_id int references rooms(id) on delete cascade,
  title text not null,
  body text not null default '',
  until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists admin_actions (
  id bigint generated always as identity primary key,
  actor_id uuid references profiles(id) on delete set null,
  action text not null,
  target_user uuid references profiles(id) on delete set null,
  seat_id int,
  reservation_id bigint,
  reason text,
  created_at timestamptz not null default now()
);

-- 서버만 읽는 비밀 설정 (푸시 발송 URL·시크릿). 정책이 없으므로 클라이언트는 접근 불가
create table if not exists private_config (
  key text primary key,
  value text not null
);

-- ---------- RLS ----------
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles','rooms','seats','reservations','seat_state','penalties','seat_reports',
    'settings','operating_periods','closed_days','occupancy_snapshots','push_subscriptions','watch_requests',
    'notifications','help_requests','appeals','announcements','admin_actions','private_config']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- 공개 읽기 + 관리자 쓰기
do $$
declare t text;
begin
  foreach t in array array['rooms','seat_state','settings','operating_periods','closed_days','occupancy_snapshots','announcements']
  loop
    execute format('drop policy if exists read_all on %I', t);
    execute format('create policy read_all on %I for select to anon, authenticated using (true)', t);
    execute format('drop policy if exists admin_write on %I', t);
    execute format('create policy admin_write on %I for all to authenticated using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;

-- seats: qr_token 은 관리자만 볼 수 있음. 일반 사용자는 seats_public 뷰 사용
drop policy if exists admin_all on seats;
create policy admin_all on seats for all to authenticated using (is_admin()) with check (is_admin());
create or replace view seats_public as
  select id, room_id, zone, label, seat_type, x, y, is_active, inactive_reason from seats;
grant select on seats_public to anon, authenticated;

-- 본인 것만 읽기 + 관리자 전체
do $$
declare t text;
begin
  foreach t in array array['reservations','penalties','notifications','help_requests','appeals','push_subscriptions','watch_requests']
  loop
    execute format('drop policy if exists own_read on %I', t);
    execute format('create policy own_read on %I for select to authenticated using (user_id = auth.uid() or is_admin())', t);
  end loop;
end $$;

drop policy if exists own_read on profiles;
create policy own_read on profiles for select to authenticated using (id = auth.uid() or is_admin());

drop policy if exists own_write on push_subscriptions;
create policy own_write on push_subscriptions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists own_write on watch_requests;
create policy own_write on watch_requests for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists own_update on notifications;
create policy own_update on notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists report_read on seat_reports;
create policy report_read on seat_reports for select to authenticated using (is_admin() or reporter_id = auth.uid());
drop policy if exists admin_read on admin_actions;
create policy admin_read on admin_actions for select to authenticated using (is_admin());

-- Realtime
do $$
declare t text;
begin
  foreach t in array array['seat_state','reservations','notifications','seat_reports','help_requests','appeals','settings','announcements']
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
