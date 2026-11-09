-- ================================================================
-- AURUM Workspace — initial schema (Phase 1)
-- Run once in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- Design notes vs. the original plan draft:
--   * No custom users table / password_hash — identity lives in
--     auth.users (Supabase Auth). This table only extends the profile.
--   * portfolios is UNIQUE(user_id): one portfolio per user.
--   * positions carry side / SL / TP / status / closing fields.
--   * Row-level security on every table; children are reachable only
--     through the owning portfolio. No DELETE policies for clients:
--     trade history is append-only (service_role can still manage).
-- ================================================================

-- ---------- shared helper: keep updated_at honest ----------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- profiles: 1:1 with auth.users ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  theme        text not null default 'dark',
  settings     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------- portfolios: exactly one per user ----------
create table if not exists public.portfolios (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  balance    numeric(18,2) not null default 10000,
  currency   text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portfolios_one_per_user unique (user_id)
);

-- ---------- enums (idempotent) ----------
do $$ begin
  create type public.position_side as enum ('BUY','SELL');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.position_status as enum ('OPEN','CLOSED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum ('PENDING','FILLED','REJECTED','CANCELLED');
exception when duplicate_object then null; end $$;

-- ---------- positions ----------
create table if not exists public.positions (
  id            uuid primary key default gen_random_uuid(),
  portfolio_id  uuid not null references public.portfolios(id) on delete cascade,
  symbol        text not null,
  side          public.position_side not null,
  amount        numeric(18,2) not null check (amount > 0),   -- USD notional, matches app
  entry_price   numeric(18,8) not null,
  stop_loss     numeric(18,8),
  take_profit   numeric(18,8),
  source        text not null default 'manual'
                check (source in ('manual','signal','bot')),
  status        public.position_status not null default 'OPEN',
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  exit_price    numeric(18,8),
  realized_pnl  numeric(18,4),
  created_at    timestamptz not null default now()
);

-- ---------- orders (audit trail of every attempt) ----------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  portfolio_id     uuid not null references public.portfolios(id) on delete cascade,
  position_id      uuid references public.positions(id) on delete set null,
  symbol           text not null,
  side             public.position_side not null,
  amount           numeric(18,2) not null check (amount > 0),
  price            numeric(18,8),
  stop_loss        numeric(18,8),
  take_profit      numeric(18,8),
  status           public.order_status not null default 'PENDING',
  broker           text not null default 'paper'
                   check (broker in ('paper','deriv','mt5','oanda')),
  broker_ref       text,
  rejection_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------- indexes ----------
create index if not exists positions_portfolio_idx
  on public.positions (portfolio_id, status);
create index if not exists orders_portfolio_idx
  on public.orders (portfolio_id, created_at desc);

-- ---------- touch triggers ----------
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists portfolios_touch on public.portfolios;
create trigger portfolios_touch
  before update on public.portfolios
  for each row execute function public.touch_updated_at();

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch
  before update on public.orders
  for each row execute function public.touch_updated_at();

-- ---------- auto-provision on signup ----------
-- New auth user -> profile + portfolio, no client action needed.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name',
             split_part(coalesce(new.email, 'trader'), '@', 1))
  )
  on conflict (id) do nothing;

  insert into public.portfolios (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ================================================================
-- Row Level Security
-- ================================================================
alter table public.profiles  enable row level security;
alter table public.portfolios enable row level security;
alter table public.positions enable row level security;
alter table public.orders    enable row level security;

-- profiles: own row only
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (id = auth.uid());

-- portfolios: own rows only, no delete (history preserved)
drop policy if exists "portfolios_select_own" on public.portfolios;
create policy "portfolios_select_own" on public.portfolios
  for select using (user_id = auth.uid());

drop policy if exists "portfolios_update_own" on public.portfolios;
create policy "portfolios_update_own" on public.portfolios
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "portfolios_insert_own" on public.portfolios;
create policy "portfolios_insert_own" on public.portfolios
  for insert with check (user_id = auth.uid());

-- positions: reachable only via an owned portfolio (subquery re-checks RLS)
drop policy if exists "positions_select_own" on public.positions;
create policy "positions_select_own" on public.positions
  for select using (
    portfolio_id in (select id from public.portfolios where user_id = auth.uid())
  );

drop policy if exists "positions_update_own" on public.positions;
create policy "positions_update_own" on public.positions
  for update using (
    portfolio_id in (select id from public.portfolios where user_id = auth.uid())
  ) with check (
    portfolio_id in (select id from public.portfolios where user_id = auth.uid())
  );

drop policy if exists "positions_insert_own" on public.positions;
create policy "positions_insert_own" on public.positions
  for insert with check (
    portfolio_id in (select id from public.portfolios where user_id = auth.uid())
  );
-- no DELETE policy: closed trades are append-only history

-- orders: same ownership pattern
drop policy if exists "orders_select_own" on public.orders;
create policy "orders_select_own" on public.orders
  for select using (
    portfolio_id in (select id from public.portfolios where user_id = auth.uid())
  );

drop policy if exists "orders_update_own" on public.orders;
create policy "orders_update_own" on public.orders
  for update using (
    portfolio_id in (select id from public.portfolios where user_id = auth.uid())
  ) with check (
    portfolio_id in (select id from public.portfolios where user_id = auth.uid())
  );

drop policy if exists "orders_insert_own" on public.orders;
create policy "orders_insert_own" on public.orders
  for insert with check (
    portfolio_id in (select id from public.portfolios where user_id = auth.uid())
  );
-- no DELETE policy: order audit trail is append-only

-- Done. Expected after Run: "Success. No rows returned."
-- Phase 2 tables (signals, watchlists, bots, audit_log) come later.
