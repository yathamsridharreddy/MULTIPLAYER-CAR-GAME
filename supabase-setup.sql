-- ============================================================================
-- SRIDHAR RUSH — Supabase setup (run once in the Supabase SQL editor)
-- Creates the global leaderboard table. Browsers can only READ it;
-- the game server writes with the service-role key (bypasses RLS).
--
-- v97: every player-scoped identity column is TEXT, not uuid. A racer who has not
-- signed in is keyed by their device pid, which a uuid column rejects with a 400 -
-- and because the server guards every fetch, that looked like "no data yet" rather
-- than an error, so guest ratings, lap records, achievements, cups and coins were
-- silently never saved. `profiles.id` stays uuid: that one really is an auth user.
-- Existing projects get the same change from supabase-migration-v97.sql.
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
  user_id      text primary key,
  races       int not null default 0,
  wins        int not null default 0,
  podiums     int not null default 0,
  xp          bigint not null default 0,
  rating      int not null default 1000,
  peak_rating int not null default 1000,
  streak      int not null default 0,
  best_streak int not null default 0,
  name        text not null default '',            -- v97: a guest has no profiles row to be named from
  updated_at  timestamptz not null default now()
);
alter table public.player_stats enable row level security;
create policy "stats read" on public.player_stats for select using (true);
create index if not exists stats_rating on public.player_stats (rating desc);

create table if not exists public.player_map_records (
  user_id       text not null,
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
  user_id       text not null,
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
create policy "history own read" on public.race_history for select using (auth.uid()::text = user_id);
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
  from_uid   text not null,               -- v111: a guest pid or name issues challenges too
  from_name  text not null,
  map        int not null,
  mode       text not null default 'race',
  laps       int not null default 1,
  target_ms  int,                      -- time to beat (null = just race)
  status     text not null default 'open'
             check (status in ('open','done','expired','pending','accepted','declined')),  -- v111 revenge lifecycle
  winner_uid text,
  created_at timestamptz not null default now()
);
create index if not exists ch_open on public.challenges (status) where status = 'open';
alter table public.challenges enable row level security;
create policy "ch read" on public.challenges for select using (true);   -- share links are public
create policy "ch make" on public.challenges for insert with check (auth.uid()::text = from_uid);
-- no update policy: only the relay (service role) completes a challenge

create table if not exists public.player_achievements (
  user_id      text not null,
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
  user_id    text not null,
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
  user_id  text primary key,
  coins   bigint not null default 0 check (coins >= 0),
  updated_at timestamptz not null default now()
);
alter table public.player_wallet enable row level security;
create policy "wallet own read" on public.player_wallet for select using (auth.uid()::text = user_id);

create table if not exists public.player_inventory (
  user_id      text not null,
  item_id     text not null,
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.player_inventory enable row level security;
create policy "inv own read" on public.player_inventory for select using (auth.uid()::text = user_id);

create table if not exists public.player_equipped (
  user_id  text primary key,
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
create or replace function public.spend_coins(p_uid text, p_amount bigint, p_item text)
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
alter table public.challenges add column if not exists to_uid text;   -- v111: the addressee is an identity, not an account
create index if not exists ch_to on public.challenges (to_uid, status);
create policy "ch answer" on public.challenges for update
  using (auth.uid()::text = to_uid)
  with check (status in ('accepted', 'declined'));

-- v79 BUG-016: coin ledger + atomic earn (idempotent by ref = race_key)
create table if not exists public.coin_ledger (
  id         bigint generated always as identity primary key,
  ref        text not null unique,
  user_id     text not null,
  delta      bigint not null,
  reason     text not null default 'race',
  created_at timestamptz not null default now()
);
create index if not exists ledger_user on public.coin_ledger (user_id, created_at desc);

create or replace function public.earn_coins(p_uid text, p_delta bigint, p_ref text, p_reason text default 'race')
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

-- ----------------------------------------------------------------------------
-- v80: Competitive Leaderboard & Retention Layer (Daily Cup & Weekly Championship)
-- ----------------------------------------------------------------------------
create index if not exists idx_stats_competitive on public.player_stats (rating desc, wins desc, races asc);
create index if not exists idx_stats_wins on public.player_stats (wins desc, races asc);
create index if not exists idx_stats_races on public.player_stats (races desc);

create table if not exists public.daily_competition (
  id          bigint generated always as identity primary key,
  date_key    text not null,                         -- 'YYYY-MM-DD'
  user_id      text not null,
  map         int not null,
  best_lap_ms int not null check (best_lap_ms >= 15000),
  races_today int not null default 1,
  name        text not null default '',            -- v97: board names for racers without a profiles row
  updated_at  timestamptz not null default now(),
  unique (date_key, user_id)
);
create index if not exists idx_daily_comp_rank on public.daily_competition (date_key, best_lap_ms asc);
alter table public.daily_competition enable row level security;
create policy "daily comp read" on public.daily_competition for select using (true);

create table if not exists public.weekly_competition (
  id          bigint generated always as identity primary key,
  week_key    text not null,                         -- 'YYYY-WW'
  user_id      text not null,
  points      int not null default 0,
  races_week  int not null default 0,
  wins_week   int not null default 0,
  best_lap_ms int,
  name        text not null default '',            -- v97: board names for racers without a profiles row
  updated_at  timestamptz not null default now(),
  unique (week_key, user_id)
);
create index if not exists idx_weekly_comp_rank on public.weekly_competition (week_key, points desc, wins_week desc);
alter table public.weekly_competition enable row level security;
create policy "weekly comp read" on public.weekly_competition for select using (true);

-- ----------------------------------------------------------------------------
-- v81: Competitive Retention (Daily Missions & Season Reward Claims)
-- ----------------------------------------------------------------------------
create table if not exists public.player_missions (
  -- v94: text, not uuid. This server identifies a racer by whatever key arrives
  -- (a Supabase uuid when signed in, a device pid or display name for guests),
  -- so a uuid column would have rejected every guest row.
  user_id     text not null,
  date_key    text not null,                         -- 'YYYY-MM-DD'
  mission_id  text not null,
  progress    int not null default 0,
  completed   boolean not null default false,
  claimed     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, date_key, mission_id)
);
alter table public.player_missions enable row level security;
create policy "missions own read" on public.player_missions for select using (auth.uid()::text = user_id);

create table if not exists public.season_rewards_claimed (
  user_id     text not null,
  season_id  text not null,
  tier       text not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, season_id)
);
alter table public.season_rewards_claimed enable row level security;
create policy "season claim own read" on public.season_rewards_claimed for select using (auth.uid()::text = user_id);

-- ----------------------------------------------------------------------------
-- v82: Badges, Revenge Targets & Weekly Syndicate Bounties
-- ----------------------------------------------------------------------------
create table if not exists public.player_badges (
  user_id      text not null,                        -- v94: text identity (guests included)
  badge_id     text not null,
  tier_level   int not null default 1,
  equipped     boolean not null default false,
  unlocked_at  timestamptz not null default now(),
  primary key (user_id, badge_id)
);
alter table public.player_badges enable row level security;
create policy "badges own read" on public.player_badges for select using (auth.uid()::text = user_id);

-- v94: rebuilt. The v82 shape used two uuid columns and had no room for the
-- display fields the revenge UI shows. The server fans a target out under EVERY
-- identity its owner is known by (uuid, device pid, display name), so owner_id
-- is text and part of the primary key.
create table if not exists public.player_revenge (
  owner_id      text        not null,   -- one identity of the challenger (they own several rows)
  target_id     text        not null,   -- the rival being challenged
  target_name   text        not null default 'RIVAL',
  map           int         not null default 0,
  map_name      text,
  target_rating int,
  status        text        not null default 'open',
  issued_at     timestamptz not null default now(),
  primary key (owner_id, target_id)
);
alter table public.player_revenge enable row level security;
create policy "revenge own read" on public.player_revenge for select using (auth.uid()::text = owner_id);
create index if not exists revenge_owner_issued_idx on public.player_revenge (owner_id, issued_at desc);

create table if not exists public.weekly_bounties (
  user_id      text not null,                        -- v94: text identity (guests included)
  week_key     text not null,                         -- 'YYYY-WW'
  bounty_id    text not null,
  progress     int not null default 0,
  completed    boolean not null default false,
  claimed      boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (user_id, week_key, bounty_id)
);
alter table public.weekly_bounties enable row level security;
create policy "weekly bounties own read" on public.weekly_bounties for select using (auth.uid()::text = user_id);


-- ----------------------------------------------------------------------------
-- v94: Clubs / syndicates. Club data reaches the browser only through the
-- server's /api/player/crew/* endpoints, which use the service-role key (RLS
-- does not apply to it), so RLS is enabled with NO policies: the anon key can
-- neither read nor write club rows directly.
-- ----------------------------------------------------------------------------
create table if not exists public.crews (
  id            text primary key,                    -- 'apex' | a user-created id
  tag           text not null,                       -- 4-letter roster tag
  name          text not null,
  motto         text,
  badge         text,
  color         text,
  leader_uid    text,
  weekly_meters double precision not null default 0,
  total_meters  double precision not null default 0,
  weekly_points int              not null default 0,
  week_key      text,                                -- 'YYYY-Www' the weekly counters belong to
  seeded        boolean          not null default false,  -- one of the five built-in clubs
  created_at    timestamptz      not null default now()
);

create table if not exists public.crew_members (
  crew_id       text not null references public.crews(id) on delete cascade,
  member_key    text not null,                       -- normalized identity that owns this roster row
  name          text,
  role          text not null default 'member',
  aliases       text[] not null default '{}',        -- every identity this racer is seen with (v90 sync fix)
  weekly_meters double precision not null default 0,
  total_meters  double precision not null default 0,
  weekly_points int              not null default 0,
  week_key      text,
  joined_at     timestamptz      not null default now(),
  primary key (crew_id, member_key)
);

create table if not exists public.crew_milestone_claims (
  crew_id    text        not null,
  tier       int         not null,
  member_key text        not null,
  week_key   text        not null default '',        -- v96: part of a claim's identity
  claimed_at timestamptz not null default now(),
  primary key (crew_id, week_key, tier, member_key)   -- v96: one claim per member per week
);

alter table public.crews                 enable row level security;
alter table public.crew_members          enable row level security;
alter table public.crew_milestone_claims enable row level security;

create index if not exists crew_members_alias_idx on public.crew_members using gin (aliases);
