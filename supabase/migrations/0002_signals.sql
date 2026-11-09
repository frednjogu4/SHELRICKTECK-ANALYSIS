-- ================================================================
-- AURUM — Signal Analyzer schema (Phase 2, additive to 0001)
-- Run in Supabase SQL Editor after 0001_init.sql. Idempotent.
--
-- Corrections vs. the draft spec:
--  * UNIQUE(user_id, symbol, timeframe, created_at::date) is ILLEGAL —
--    PostgreSQL forbids expressions in UNIQUE table constraints — and
--    it contradicted the 5-minute cache (one row/day vs expiry every
--    5 min). Replaced with an `active` flag + partial unique index:
--    exactly ONE live signal per user/symbol/timeframe, history kept.
--  * Foreign keys to auth.users on every user_id.
--  * Full RLS: users read only their own signals/usage; sentiment
--    cache is readable by signed-in users, writable only server-side.
--  * Token/cost columns live on the signal row (from message.usage),
--    with the ai_usage table kept as a per-call audit log.
-- ================================================================

-- ---------- signals ----------
create table if not exists public.signals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  symbol            text not null,
  timeframe         text not null check (timeframe in ('1m','5m','15m','1h','4h','1d','MTF')),
  signal            text not null check (signal in ('BUY','SELL','WAIT')),
  confidence        int  not null check (confidence between 0 and 100),
  entry_price       numeric(18,8) not null,
  stop_loss         numeric(18,8) not null,
  take_profit_1     numeric(18,8) not null,
  take_profit_2     numeric(18,8),
  risk_reward_ratio numeric(8,2),
  rationale         text,
  technical_summary text,
  sentiment_score   int check (sentiment_score between 0 and 100),
  key_levels        jsonb not null default '{}'::jsonb,
  risks             jsonb not null default '[]'::jsonb,
  indicators        jsonb not null default '{}'::jsonb,
  model             text,
  tokens_in         int,
  tokens_out        int,
  cost              numeric(10,4),
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '5 minutes'
);

-- one LIVE signal per user/symbol/timeframe (expired rows stay as history)
create unique index if not exists signals_one_active_per_symbol_tf
  on public.signals (user_id, symbol, timeframe)
  where active;

create index if not exists signals_user_lookup
  on public.signals (user_id, symbol, timeframe, created_at desc);
create index if not exists signals_expires
  on public.signals (expires_at) where active;

-- ---------- sentiment cache (global, server-written) ----------
create table if not exists public.sentiment_cache (
  id              uuid primary key default gen_random_uuid(),
  symbol          text not null unique,
  sentiment_score int check (sentiment_score between 0 and 100),
  news_summary    text,
  key_drivers     jsonb not null default '[]'::jsonb,
  risk_alerts     jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '1 day'
);

create index if not exists sentiment_cache_expiry
  on public.sentiment_cache (expires_at);

-- ---------- AI usage audit ----------
create table if not exists public.ai_usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  model      text,
  tokens_in  int not null default 0,
  tokens_out int not null default 0,
  cost       numeric(10,4) not null default 0,
  endpoint   text,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_user_window
  on public.ai_usage (user_id, created_at desc);

-- ================================================================
-- RLS
-- ================================================================
alter table public.signals       enable row level security;
alter table public.sentiment_cache enable row level security;
alter table public.ai_usage      enable row level security;

-- signals: owners read; server (service role) writes; clients never delete
drop policy if exists "signals_select_own" on public.signals;
create policy "signals_select_own" on public.signals
  for select using (user_id = auth.uid());

drop policy if exists "signals_update_own" on public.signals;
create policy "signals_update_own" on public.signals
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- (insert intentionally omitted: the analyzer service uses the service
--  role, which bypasses RLS. No delete policy: signals are audit history.)

-- sentiment cache: readable by any signed-in user, write via server only
drop policy if exists "sentiment_read_authenticated" on public.sentiment_cache;
create policy "sentiment_read_authenticated" on public.sentiment_cache
  for select to authenticated using (expires_at > now());

-- ai_usage: owners read their own spend (the budget UI reads this)
drop policy if exists "ai_usage_select_own" on public.ai_usage;
create policy "ai_usage_select_own" on public.ai_usage
  for select using (user_id = auth.uid());

-- done: expect "Success. No rows returned."
