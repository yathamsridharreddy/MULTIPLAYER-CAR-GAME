-- ============================================================================
-- SRIDHAR RUSH — Supabase setup (run once in the Supabase SQL editor)
-- Creates the global leaderboard table. Browsers can only READ it;
-- the game server writes with the service-role key (bypasses RLS).
-- ============================================================================
create table if not exists public.leaderboard (
  id         bigint generated always as identity primary key,
  map        int  not null,
  pid        text not null,
  name       text not null,
  time_ms    int  not null,
  updated_at timestamptz not null default now(),
  unique (map, pid)
);

alter table public.leaderboard enable row level security;

-- anyone (anon + logged-in) may read the board
create policy "lb read" on public.leaderboard
  for select using (true);

-- no insert/update/delete policies on purpose:
-- writes happen only through the server's service-role key

create index if not exists lb_map_time on public.leaderboard (map, time_ms);

-- ----------------------------------------------------------------------------
-- v41: shareable ghosts ("race my ghost" links)
-- ----------------------------------------------------------------------------
create table if not exists public.ghosts (
  id         text primary key,
  map        int  not null,
  name       text not null,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.ghosts enable row level security;

-- anyone may load a shared ghost; writes only via the server's service role
create policy "ghost read" on public.ghosts
  for select using (true);

-- ----------------------------------------------------------------------------
-- v73: persistent player platform (identity, stats, history, rating)
-- Clients may READ public info; ONLY the game server (service role) writes.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null unique check (username ~ '^[A-Za-z0-9_]{3,16}$'),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles read"   on public.profiles for select using (true);
create policy "profiles own i"  on public.profiles for insert with check (auth.uid() = id);
create policy "profiles own u"  on public.profiles for update using (auth.uid() = id);

create table if not exists public.player_stats (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  races       int not null default 0,
  wins        int not null default 0,
  podiums     int not null default 0,
  xp          bigint not null default 0,
  rating      int not null default 1000,
  peak_rating int not null default 1000,
  streak      int not null default 0,
  best_streak int not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.player_stats enable row level security;
create policy "stats read" on public.player_stats for select using (true);
create index if not exists stats_rating on public.player_stats (rating desc);

create table if not exists public.player_map_records (
  user_id      uuid references auth.users(id) on delete cascade,
  map          int not null,
  best_lap_ms  int,
  best_race_ms int,
  races        int not null default 0,
  wins         int not null default 0,
  primary key (user_id, map)
);
alter table public.player_map_records enable row level security;
create policy "records read" on public.player_map_records for select using (true);

create table if not exists public.race_history (
  id           bigint generated always as identity primary key,
  race_key     text not null unique,          -- idempotent settlement (no double-write)
  user_id      uuid not null references auth.users(id) on delete cascade,
  map          int not null,
  mode         text not null,
  position     int not null,
  players      int not null,
  duration_ms  int,
  best_lap_ms  int,
  rating_delta int not null default 0,
  xp           int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists rh_user_time on public.race_history (user_id, created_at desc);
alter table public.race_history enable row level security;
create policy "history own read" on public.race_history for select using (auth.uid() = user_id);
-- NOTE: no insert/update/delete policies for stats/records/history on purpose:
-- settlement happens exclusively through the server's service-role key.
