-- AURUM Cloud Sync — per-user analysis history.
-- Run after 0001_init.sql and 0002_signals.sql in Supabase SQL Editor.
-- Idempotent. Client requests require a signed-in Supabase Auth user;
-- publishable/anon keys alone have no read/write access to these rows.

create table if not exists public.analysis_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  kind text not null,
  symbol text not null,
  timeframe text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.pattern_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  symbol text not null,
  timeframe text not null,
  pattern_key text not null,
  direction text,
  action text,
  confidence integer check (confidence between 0 and 100),
  status text,
  price numeric(20,8),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  channel text not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists analysis_history_user_created_idx
  on public.analysis_history (user_id, created_at desc);
create index if not exists pattern_events_user_created_idx
  on public.pattern_events (user_id, created_at desc);
create index if not exists alerts_user_created_idx
  on public.alerts (user_id, created_at desc);

alter table public.analysis_history enable row level security;
alter table public.pattern_events enable row level security;
alter table public.alerts enable row level security;

-- Only authenticated owners may read or append their own rows.
revoke all on public.analysis_history, public.pattern_events, public.alerts from anon, authenticated;
grant select, insert on public.analysis_history, public.pattern_events, public.alerts to authenticated;

drop policy if exists "analysis_history_select_own" on public.analysis_history;
create policy "analysis_history_select_own" on public.analysis_history
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "analysis_history_insert_own" on public.analysis_history;
create policy "analysis_history_insert_own" on public.analysis_history
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "pattern_events_select_own" on public.pattern_events;
create policy "pattern_events_select_own" on public.pattern_events
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "pattern_events_insert_own" on public.pattern_events;
create policy "pattern_events_insert_own" on public.pattern_events
  for insert to authenticated with check (user_id = auth.uid());

-- Alerts are user-private append-only history too.
drop policy if exists "alerts_select_own" on public.alerts;
create policy "alerts_select_own" on public.alerts
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "alerts_insert_own" on public.alerts;
create policy "alerts_insert_own" on public.alerts
  for insert to authenticated with check (user_id = auth.uid());

-- Signals already exist in 0002_signals.sql. Make browser-written signal
-- history compatible with authenticated ownership and WAIT/incomplete plans.
alter table public.signals add column if not exists engine text;
alter table public.signals alter column entry_price drop not null;
alter table public.signals alter column stop_loss drop not null;
alter table public.signals alter column take_profit_1 drop not null;
revoke all on public.signals from anon, authenticated;
grant select, insert on public.signals to authenticated;
drop policy if exists "signals_insert_own" on public.signals;
create policy "signals_insert_own" on public.signals
  for insert to authenticated with check (user_id = auth.uid());

-- No client DELETE policies are granted. Retention/erasure is an explicit
-- account-management action, not a broad browser capability.
