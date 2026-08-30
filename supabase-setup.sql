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

-- ----------------------------------------------------------------------------
-- v74: social + retention layer (friends, challenges, achievements, seasons)
-- Social rows are RLS-safe for clients; results/XP/achievements stay
-- server-written (service role) — clients can never settle outcomes.
-- ----------------------------------------------------------------------------
alter table public.player_stats add column if not exists daily_days int not null default 0;
alter table public.player_stats add column if not exists last_daily text not null default '';
alter table public.player_stats add column if not exists challenges_done int not null default 0;

create table if not exists public.friends (
  id         bigint generated always as identity primary key,
  from_uid   uuid not null references auth.users(id) on delete cascade,
  to_uid     uuid not null references auth.users(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  unique (from_uid, to_uid),
  check (from_uid <> to_uid)
);
create index if not exists friends_to on public.friends (to_uid, status);
create index if not exists friends_from on public.friends (from_uid, status);
alter table public.friends enable row level security;
create policy "friends see"  on public.friends for select using (auth.uid() = from_uid or auth.uid() = to_uid);
create policy "friends ask"  on public.friends for insert with check (auth.uid() = from_uid);
create policy "friends ans"  on public.friends for update using (auth.uid() = to_uid);
create policy "friends drop" on public.friends for delete using (auth.uid() = from_uid or auth.uid() = to_uid);

create table if not exists public.challenges (
  id         bigint generated always as identity primary key,
  from_uid   uuid not null references auth.users(id) on delete cascade,
  from_name  text not null,
  map        int not null,
  mode       text not null default 'race',
  laps       int not null default 1,
  target_ms  int,                      -- time to beat (null = just race)
  status     text not null default 'open' check (status in ('open','done','expired')),
  winner_uid uuid,
  created_at timestamptz not null default now()
);
create index if not exists ch_open on public.challenges (status) where status = 'open';
alter table public.challenges enable row level security;
create policy "ch read" on public.challenges for select using (true);   -- share links are public
create policy "ch make" on public.challenges for insert with check (auth.uid() = from_uid);
-- no update policy: only the relay (service role) completes a challenge

create table if not exists public.player_achievements (
  user_id     uuid not null references auth.users(id) on delete cascade,
  ach         text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, ach)
);
alter table public.player_achievements enable row level security;
create policy "ach read" on public.player_achievements for select using (true);

create table if not exists public.seasons (
  id       int primary key,
  name     text not null,
  start_at timestamptz not null,
  end_at   timestamptz not null
);
alter table public.seasons enable row level security;
create policy "seasons read" on public.seasons for select using (true);
insert into public.seasons (id, name, start_at, end_at)
values (1, 'SEASON 01', now(), now() + interval '90 days')
on conflict (id) do nothing;

create table if not exists public.player_seasons (
  user_id   uuid not null references auth.users(id) on delete cascade,
  season_id int not null references public.seasons(id) on delete cascade,
  rating    int not null default 1000,
  xp        bigint not null default 0,
  primary key (user_id, season_id)
);
alter table public.player_seasons enable row level security;
create policy "pseasons read" on public.player_seasons for select using (true);

-- v75: garage economy (wallet, inventory, equipped). Clients READ equipped
-- (showcase) + own wallet/inventory; ALL writes via relay service role.
create table if not exists public.player_wallet (
  user_id uuid primary key references auth.users(id) on delete cascade,
  coins   bigint not null default 0 check (coins >= 0),
  updated_at timestamptz not null default now()
);
alter table public.player_wallet enable row level security;
create policy "wallet own read" on public.player_wallet for select using (auth.uid() = user_id);

create table if not exists public.player_inventory (
  user_id     uuid not null references auth.users(id) on delete cascade,
  item_id     text not null,
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.player_inventory enable row level security;
create policy "inv own read" on public.player_inventory for select using (auth.uid() = user_id);

create table if not exists public.player_equipped (
  user_id uuid primary key references auth.users(id) on delete cascade,
  car     text not null default 'street_runner',
  paint   int not null default 0,
  wheels  int not null default 0,
  trail   int not null default 0,
  decal   int not null default 0,
  neon    int not null default 0,
  title   text not null default ''
);
alter table public.player_equipped enable row level security;
create policy "equipped read" on public.player_equipped for select using (true);

-- v77 BUG-005: atomic coin spend (single transaction: balance check + decrement + insert)
create or replace function public.spend_coins(p_uid uuid, p_amount bigint, p_item text)
returns json language plpgsql security definer set search_path = public as $$
declare v_coins bigint;
begin
  if exists (select 1 from player_inventory where user_id = p_uid and item_id = p_item) then
    return json_build_object('ok', false, 'err', 'owned');
  end if;
  select coins into v_coins from player_wallet where user_id = p_uid for update;
  if v_coins is null then v_coins := 0; end if;
  if v_coins < p_amount then
    return json_build_object('ok', false, 'err', 'funds');
  end if;
  if v_coins = 0 and not exists (select 1 from player_wallet where user_id = p_uid) then
    insert into player_wallet (user_id, coins) values (p_uid, 0);
  end if;
  update player_wallet set coins = coins - p_amount, updated_at = now() where user_id = p_uid;
  insert into player_inventory (user_id, item_id) values (p_uid, p_item)
    on conflict (user_id, item_id) do nothing;
  return json_build_object('ok', true, 'coins', v_coins - p_amount);
end $$;

-- v78 BUG-007: friend challenges (to_uid) + recipient accept/decline; expiry client-side
alter table public.challenges add column if not exists to_uid uuid references auth.users(id) on delete cascade;
create index if not exists ch_to on public.challenges (to_uid, status);
create policy "ch answer" on public.challenges for update
  using (auth.uid() = to_uid)
  with check (status in ('accepted', 'declined'));

-- v79 BUG-016: coin ledger + atomic earn (idempotent by ref = race_key)
create table if not exists public.coin_ledger (
  id         bigint generated always as identity primary key,
  ref        text not null unique,
  user_id    uuid not null references auth.users(id) on delete cascade,
  delta      bigint not null,
  reason     text not null default 'race',
  created_at timestamptz not null default now()
);
create index if not exists ledger_user on public.coin_ledger (user_id, created_at desc);

create or replace function public.earn_coins(p_uid uuid, p_delta bigint, p_ref text, p_reason text default 'race')
returns json language plpgsql security definer set search_path = public as $$
declare v_coins bigint;
begin
  if p_delta <= 0 then
    return json_build_object('ok', false, 'err', 'delta');
  end if;
  if exists (select 1 from coin_ledger where ref = p_ref) then
    select coins into v_coins from player_wallet where user_id = p_uid;
    return json_build_object('ok', true, 'coins', coalesce(v_coins, 0), 'dup', true);
  end if;
  insert into coin_ledger (ref, user_id, delta, reason) values (p_ref, p_uid, p_delta, p_reason);
  insert into player_wallet (user_id, coins) values (p_uid, p_delta)
    on conflict (user_id) do update set coins = player_wallet.coins + p_delta, updated_at = now();
  select coins into v_coins from player_wallet where user_id = p_uid;
  return json_build_object('ok', true, 'coins', v_coins);
end $$;
