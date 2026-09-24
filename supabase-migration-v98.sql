-- ============================================================================
-- SRIDHAR RUSH - v98 migration: CONVERGE ANY DATABASE TO THE CURRENT SCHEMA
-- ============================================================================
-- Run this ONE file in the Supabase SQL Editor. It supersedes supabase-migration
-- -v94, -v96 and -v97, and it is safe from every starting state:
--
--   * a database that never had the progression or club tables
--   * a database whose tables are an older SHAPE (missing columns)
--   * a database whose identity columns are still uuid
--   * a database that already ran v96 and v97 (almost everything is then a no-op)
--   * a brand-new database (this is supabase-setup.sql, made re-runnable)
--
-- Every statement is idempotent, so re-running the file is harmless.
--
-- WHY IT EXISTS - TWO REAL FAILURES, BOTH FROM ASSUMING A SHAPE
-- -------------------------------------------------------------
-- 1. v96 opened with
--        drop policy if exists "missions own read" on public.player_missions;
--    IF EXISTS guards the POLICY, not the TABLE, so on a database created before
--    the progression tables existed it aborted with
--        ERROR: 42P01: relation "public.player_missions" does not exist
--    on line one, and the club tables it was meant to create stayed missing.
--
-- 2. Guarding with to_regclass() is NOT enough on its own. Inside a DO block the
--    whole IF condition is parsed before any of it is evaluated, so
--        if to_regclass('public.player_revenge') is not null
--           and not exists (select 1 from public.player_revenge) then
--    still died with
--        ERROR: 42P01: relation "public.player_revenge" does not exist
--        QUERY: to_regclass(...) is not null and not exists (select 1 from ...)
--    because the second half names the table statically. Short-circuit evaluation
--    never got a chance. Anything that inspects a table which may not exist has to
--    go through EXECUTE, so the name is resolved at run time, not at parse time.
--
-- ORDER MATTERS, and this is the order that works from any state:
--   0. drop the legacy uuid coin-function overloads
--   1. drop an empty old-shape player_revenge          (dynamic SQL, see above)
--   2. CREATE every missing table, RLS flag, function and the season seed
--   3. converge COLUMNS  - add any that an older table is missing, each in its own
--                          savepoint so one bad column cannot abort the script
--   4. converge INDEXES  - same, guarded
--   5. relax fifteen identity columns uuid -> text, dropping the eight policies
--      that depend on them first (Postgres will not alter a column that a policy
--      references)
--   6. recreate all 28 policies - must follow 5, because a policy comparing
--      auth.uid()::text cannot be created over a uuid column
--   7. the three board name columns, stated explicitly
--   8. widen the club milestone claim key to include the week
--
-- WHAT IT UNLOCKS
-- ---------------
-- Without the club tables, every club write fails and is swallowed on purpose:
-- clubs, rosters and weekly totals live in server RAM only and vanish on the next
-- deploy or spin-down. While player_stats.user_id is a uuid foreign key to
-- auth.users, every guest identity (device pid, display name) is rejected with a
-- 400 that the fetch guards swallow: ratings, lap records, race history,
-- achievements, seasons, wallets, coins and both cups are never stored for anyone
-- who has not signed in. GET /health reports both, as persistence.verdict and
-- persistence.playerStatsKeyType.
--
-- NOTICE lines in the output are informational. Only ERROR stops anything.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. legacy uuid overloads of the coin functions
-- ----------------------------------------------------------------------------
-- Section 2 recreates both with p_uid text. Left alongside, the uuid overload
-- would make every call ambiguous, so they go first.
drop function if exists public.earn_coins(uuid, bigint, text, text);
drop function if exists public.spend_coins(uuid, bigint, text);


-- ----------------------------------------------------------------------------
-- 1. old-shape player_revenge
-- ----------------------------------------------------------------------------
-- The v82 definition used two uuid columns and had no room for the display fields
-- the revenge UI shows. It was never populated, so an empty one is dropped and
-- section 2 rebuilds it. A table that does have rows is reported and left alone
-- rather than destroyed.
--
-- Both the row check and the drop go through EXECUTE. A static reference to a
-- table that may not exist is a parse-time 42P01, even on a line where
-- to_regclass() has already said the table is absent - see the header.
do $rev$
declare
  has_rows boolean;
begin
  if to_regclass('public.player_revenge') is null then
    return;   -- nothing to clean up: section 2 creates the current shape
  end if;

  execute 'select exists (select 1 from public.player_revenge)' into has_rows;

  if has_rows then
    raise notice 'player_revenge has rows - left untouched; reconcile manually before re-running';
  else
    execute 'drop table public.player_revenge cascade';
    raise notice 'dropped the empty old-shape player_revenge; section 2 rebuilds it';
  end if;
end $rev$;


-- ----------------------------------------------------------------------------
-- 2. the canonical schema, re-runnable
-- ----------------------------------------------------------------------------
-- supabase-setup.sql verbatim, with its 28 `create policy` statements lifted into
-- section 6 (where they can be dropped and recreated safely) and its 15 indexes
-- lifted into section 4 (where a missing column cannot abort the script).
-- Everything here is `if not exists` / `or replace` / `on conflict do nothing`, so
-- a database that already has these objects is untouched. A table that already
-- exists in an OLDER SHAPE is not fixed here - that is section 3.
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

-- no insert/update/delete policies on purpose:
-- writes happen only through the server's service-role key

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

alter table public.race_history enable row level security;

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

alter table public.friends enable row level security;

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

alter table public.challenges enable row level security;

-- no update policy: only the relay (service role) completes a challenge

create table if not exists public.player_achievements (
  user_id      text not null,
  ach         text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, ach)
);
alter table public.player_achievements enable row level security;

create table if not exists public.seasons (
  id       int primary key,
  name     text not null,
  start_at timestamptz not null,
  end_at   timestamptz not null
);
alter table public.seasons enable row level security;

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

-- v75: garage economy (wallet, inventory, equipped). Clients READ equipped
-- (showcase) + own wallet/inventory; ALL writes via relay service role.
create table if not exists public.player_wallet (
  user_id  text primary key,
  coins   bigint not null default 0 check (coins >= 0),
  updated_at timestamptz not null default now()
);
alter table public.player_wallet enable row level security;

create table if not exists public.player_inventory (
  user_id      text not null,
  item_id     text not null,
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.player_inventory enable row level security;

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

-- v79 BUG-016: coin ledger + atomic earn (idempotent by ref = race_key)
create table if not exists public.coin_ledger (
  id         bigint generated always as identity primary key,
  ref        text not null unique,
  user_id     text not null,
  delta      bigint not null,
  reason     text not null default 'race',
  created_at timestamptz not null default now()
);

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

alter table public.daily_competition enable row level security;

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

alter table public.weekly_competition enable row level security;

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

create table if not exists public.season_rewards_claimed (
  user_id     text not null,
  season_id  text not null,
  tier       text not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, season_id)
);
alter table public.season_rewards_claimed enable row level security;

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


-- ----------------------------------------------------------------------------
-- 3. converge columns
-- ----------------------------------------------------------------------------
-- `create table if not exists` is a no-op on a table that already exists, so a
-- database created from an older schema keeps whatever columns it had. The server
-- selects explicit column lists (player_stats alone is read as
-- user_id,rating,xp,races,wins,podiums,streak,best_streak,updated_at), and one
-- missing column makes PostgREST answer 400 - which the fetch guards swallow, so
-- the board just looks empty. Every column of every table in the canonical schema
-- is therefore added if absent.
--
-- Each column runs in its own savepoint. The strict form keeps `not null`; where
-- that cannot work (a table that already has rows and no default to fill them
-- with) the loose form adds the column nullable instead, and only if BOTH fail is
-- a notice raised and the script allowed to continue. Nothing here can abort the
-- migration, and to_regclass is a function call on a string, so a table that does
-- not exist is skipped rather than referenced.
do $conv$
declare
  r record;
begin
  for r in
    select * from (values
    ($$leaderboard$$, $$id$$, $$alter table public.leaderboard add column if not exists id bigint generated always as identity$$, $$alter table public.leaderboard add column if not exists id bigint generated always as identity$$),
    ($$leaderboard$$, $$map$$, $$alter table public.leaderboard add column if not exists map int not null$$, $$alter table public.leaderboard add column if not exists map int$$),
    ($$leaderboard$$, $$pid$$, $$alter table public.leaderboard add column if not exists pid text not null$$, $$alter table public.leaderboard add column if not exists pid text$$),
    ($$leaderboard$$, $$name$$, $$alter table public.leaderboard add column if not exists name text not null$$, $$alter table public.leaderboard add column if not exists name text$$),
    ($$leaderboard$$, $$time_ms$$, $$alter table public.leaderboard add column if not exists time_ms int not null$$, $$alter table public.leaderboard add column if not exists time_ms int$$),
    ($$leaderboard$$, $$updated_at$$, $$alter table public.leaderboard add column if not exists updated_at timestamptz not null default now()$$, $$alter table public.leaderboard add column if not exists updated_at timestamptz default now()$$),
    ($$ghosts$$, $$id$$, $$alter table public.ghosts add column if not exists id text$$, $$alter table public.ghosts add column if not exists id text$$),
    ($$ghosts$$, $$map$$, $$alter table public.ghosts add column if not exists map int not null$$, $$alter table public.ghosts add column if not exists map int$$),
    ($$ghosts$$, $$name$$, $$alter table public.ghosts add column if not exists name text not null$$, $$alter table public.ghosts add column if not exists name text$$),
    ($$ghosts$$, $$data$$, $$alter table public.ghosts add column if not exists data jsonb not null$$, $$alter table public.ghosts add column if not exists data jsonb$$),
    ($$ghosts$$, $$created_at$$, $$alter table public.ghosts add column if not exists created_at timestamptz not null default now()$$, $$alter table public.ghosts add column if not exists created_at timestamptz default now()$$),
    ($$profiles$$, $$id$$, $$alter table public.profiles add column if not exists id uuid references auth.users(id) on delete cascade$$, $$alter table public.profiles add column if not exists id uuid references auth.users(id) on delete cascade$$),
    ($$profiles$$, $$username$$, $$alter table public.profiles add column if not exists username text not null check (username ~ '^[A-Za-z0-9_]{3,16}$')$$, $$alter table public.profiles add column if not exists username text check (username ~ '^[A-Za-z0-9_]{3,16}$')$$),
    ($$profiles$$, $$created_at$$, $$alter table public.profiles add column if not exists created_at timestamptz not null default now()$$, $$alter table public.profiles add column if not exists created_at timestamptz default now()$$),
    ($$player_stats$$, $$user_id$$, $$alter table public.player_stats add column if not exists user_id text$$, $$alter table public.player_stats add column if not exists user_id text$$),
    ($$player_stats$$, $$races$$, $$alter table public.player_stats add column if not exists races int not null default 0$$, $$alter table public.player_stats add column if not exists races int default 0$$),
    ($$player_stats$$, $$wins$$, $$alter table public.player_stats add column if not exists wins int not null default 0$$, $$alter table public.player_stats add column if not exists wins int default 0$$),
    ($$player_stats$$, $$podiums$$, $$alter table public.player_stats add column if not exists podiums int not null default 0$$, $$alter table public.player_stats add column if not exists podiums int default 0$$),
    ($$player_stats$$, $$xp$$, $$alter table public.player_stats add column if not exists xp bigint not null default 0$$, $$alter table public.player_stats add column if not exists xp bigint default 0$$),
    ($$player_stats$$, $$rating$$, $$alter table public.player_stats add column if not exists rating int not null default 1000$$, $$alter table public.player_stats add column if not exists rating int default 1000$$),
    ($$player_stats$$, $$peak_rating$$, $$alter table public.player_stats add column if not exists peak_rating int not null default 1000$$, $$alter table public.player_stats add column if not exists peak_rating int default 1000$$),
    ($$player_stats$$, $$streak$$, $$alter table public.player_stats add column if not exists streak int not null default 0$$, $$alter table public.player_stats add column if not exists streak int default 0$$),
    ($$player_stats$$, $$best_streak$$, $$alter table public.player_stats add column if not exists best_streak int not null default 0$$, $$alter table public.player_stats add column if not exists best_streak int default 0$$),
    ($$player_stats$$, $$name$$, $$alter table public.player_stats add column if not exists name text not null default ''$$, $$alter table public.player_stats add column if not exists name text default ''$$),
    ($$player_stats$$, $$updated_at$$, $$alter table public.player_stats add column if not exists updated_at timestamptz not null default now()$$, $$alter table public.player_stats add column if not exists updated_at timestamptz default now()$$),
    ($$player_map_records$$, $$user_id$$, $$alter table public.player_map_records add column if not exists user_id text not null$$, $$alter table public.player_map_records add column if not exists user_id text$$),
    ($$player_map_records$$, $$map$$, $$alter table public.player_map_records add column if not exists map int not null$$, $$alter table public.player_map_records add column if not exists map int$$),
    ($$player_map_records$$, $$best_lap_ms$$, $$alter table public.player_map_records add column if not exists best_lap_ms int$$, $$alter table public.player_map_records add column if not exists best_lap_ms int$$),
    ($$player_map_records$$, $$best_race_ms$$, $$alter table public.player_map_records add column if not exists best_race_ms int$$, $$alter table public.player_map_records add column if not exists best_race_ms int$$),
    ($$player_map_records$$, $$races$$, $$alter table public.player_map_records add column if not exists races int not null default 0$$, $$alter table public.player_map_records add column if not exists races int default 0$$),
    ($$player_map_records$$, $$wins$$, $$alter table public.player_map_records add column if not exists wins int not null default 0$$, $$alter table public.player_map_records add column if not exists wins int default 0$$),
    ($$race_history$$, $$id$$, $$alter table public.race_history add column if not exists id bigint generated always as identity$$, $$alter table public.race_history add column if not exists id bigint generated always as identity$$),
    ($$race_history$$, $$race_key$$, $$alter table public.race_history add column if not exists race_key text not null$$, $$alter table public.race_history add column if not exists race_key text$$),
    ($$race_history$$, $$user_id$$, $$alter table public.race_history add column if not exists user_id text not null$$, $$alter table public.race_history add column if not exists user_id text$$),
    ($$race_history$$, $$map$$, $$alter table public.race_history add column if not exists map int not null$$, $$alter table public.race_history add column if not exists map int$$),
    ($$race_history$$, $$mode$$, $$alter table public.race_history add column if not exists mode text not null$$, $$alter table public.race_history add column if not exists mode text$$),
    ($$race_history$$, $$position$$, $$alter table public.race_history add column if not exists position int not null$$, $$alter table public.race_history add column if not exists position int$$),
    ($$race_history$$, $$players$$, $$alter table public.race_history add column if not exists players int not null$$, $$alter table public.race_history add column if not exists players int$$),
    ($$race_history$$, $$duration_ms$$, $$alter table public.race_history add column if not exists duration_ms int$$, $$alter table public.race_history add column if not exists duration_ms int$$),
    ($$race_history$$, $$best_lap_ms$$, $$alter table public.race_history add column if not exists best_lap_ms int$$, $$alter table public.race_history add column if not exists best_lap_ms int$$),
    ($$race_history$$, $$rating_delta$$, $$alter table public.race_history add column if not exists rating_delta int not null default 0$$, $$alter table public.race_history add column if not exists rating_delta int default 0$$),
    ($$race_history$$, $$xp$$, $$alter table public.race_history add column if not exists xp int not null default 0$$, $$alter table public.race_history add column if not exists xp int default 0$$),
    ($$race_history$$, $$created_at$$, $$alter table public.race_history add column if not exists created_at timestamptz not null default now()$$, $$alter table public.race_history add column if not exists created_at timestamptz default now()$$),
    ($$friends$$, $$id$$, $$alter table public.friends add column if not exists id bigint generated always as identity$$, $$alter table public.friends add column if not exists id bigint generated always as identity$$),
    ($$friends$$, $$from_uid$$, $$alter table public.friends add column if not exists from_uid uuid not null references auth.users(id) on delete cascade$$, $$alter table public.friends add column if not exists from_uid uuid references auth.users(id) on delete cascade$$),
    ($$friends$$, $$to_uid$$, $$alter table public.friends add column if not exists to_uid uuid not null references auth.users(id) on delete cascade$$, $$alter table public.friends add column if not exists to_uid uuid references auth.users(id) on delete cascade$$),
    ($$friends$$, $$status$$, $$alter table public.friends add column if not exists status text not null default 'pending' check (status in ('pending','accepted','rejected'))$$, $$alter table public.friends add column if not exists status text default 'pending' check (status in ('pending','accepted','rejected'))$$),
    ($$friends$$, $$created_at$$, $$alter table public.friends add column if not exists created_at timestamptz not null default now()$$, $$alter table public.friends add column if not exists created_at timestamptz default now()$$),
    ($$challenges$$, $$id$$, $$alter table public.challenges add column if not exists id bigint generated always as identity$$, $$alter table public.challenges add column if not exists id bigint generated always as identity$$),
    ($$challenges$$, $$from_uid$$, $$alter table public.challenges add column if not exists from_uid text not null$$, $$alter table public.challenges add column if not exists from_uid text$$),
    ($$challenges$$, $$from_name$$, $$alter table public.challenges add column if not exists from_name text not null$$, $$alter table public.challenges add column if not exists from_name text$$),
    ($$challenges$$, $$map$$, $$alter table public.challenges add column if not exists map int not null$$, $$alter table public.challenges add column if not exists map int$$),
    ($$challenges$$, $$mode$$, $$alter table public.challenges add column if not exists mode text not null default 'race'$$, $$alter table public.challenges add column if not exists mode text default 'race'$$),
    ($$challenges$$, $$laps$$, $$alter table public.challenges add column if not exists laps int not null default 1$$, $$alter table public.challenges add column if not exists laps int default 1$$),
    ($$challenges$$, $$target_ms$$, $$alter table public.challenges add column if not exists target_ms int$$, $$alter table public.challenges add column if not exists target_ms int$$),
    ($$challenges$$, $$status$$, $$alter table public.challenges add column if not exists status text not null default 'open' check (status in ('open','done','expired'))$$, $$alter table public.challenges add column if not exists status text default 'open' check (status in ('open','done','expired'))$$),
    ($$challenges$$, $$winner_uid$$, $$alter table public.challenges add column if not exists winner_uid text$$, $$alter table public.challenges add column if not exists winner_uid text$$),
    ($$challenges$$, $$created_at$$, $$alter table public.challenges add column if not exists created_at timestamptz not null default now()$$, $$alter table public.challenges add column if not exists created_at timestamptz default now()$$),
    ($$player_achievements$$, $$user_id$$, $$alter table public.player_achievements add column if not exists user_id text not null$$, $$alter table public.player_achievements add column if not exists user_id text$$),
    ($$player_achievements$$, $$ach$$, $$alter table public.player_achievements add column if not exists ach text not null$$, $$alter table public.player_achievements add column if not exists ach text$$),
    ($$player_achievements$$, $$unlocked_at$$, $$alter table public.player_achievements add column if not exists unlocked_at timestamptz not null default now()$$, $$alter table public.player_achievements add column if not exists unlocked_at timestamptz default now()$$),
    ($$seasons$$, $$id$$, $$alter table public.seasons add column if not exists id int$$, $$alter table public.seasons add column if not exists id int$$),
    ($$seasons$$, $$name$$, $$alter table public.seasons add column if not exists name text not null$$, $$alter table public.seasons add column if not exists name text$$),
    ($$seasons$$, $$start_at$$, $$alter table public.seasons add column if not exists start_at timestamptz not null$$, $$alter table public.seasons add column if not exists start_at timestamptz$$),
    ($$seasons$$, $$end_at$$, $$alter table public.seasons add column if not exists end_at timestamptz not null$$, $$alter table public.seasons add column if not exists end_at timestamptz$$),
    ($$player_seasons$$, $$user_id$$, $$alter table public.player_seasons add column if not exists user_id text not null$$, $$alter table public.player_seasons add column if not exists user_id text$$),
    ($$player_seasons$$, $$season_id$$, $$alter table public.player_seasons add column if not exists season_id int not null references public.seasons(id) on delete cascade$$, $$alter table public.player_seasons add column if not exists season_id int references public.seasons(id) on delete cascade$$),
    ($$player_seasons$$, $$rating$$, $$alter table public.player_seasons add column if not exists rating int not null default 1000$$, $$alter table public.player_seasons add column if not exists rating int default 1000$$),
    ($$player_seasons$$, $$xp$$, $$alter table public.player_seasons add column if not exists xp bigint not null default 0$$, $$alter table public.player_seasons add column if not exists xp bigint default 0$$),
    ($$player_wallet$$, $$user_id$$, $$alter table public.player_wallet add column if not exists user_id text$$, $$alter table public.player_wallet add column if not exists user_id text$$),
    ($$player_wallet$$, $$coins$$, $$alter table public.player_wallet add column if not exists coins bigint not null default 0 check (coins >= 0)$$, $$alter table public.player_wallet add column if not exists coins bigint default 0 check (coins >= 0)$$),
    ($$player_wallet$$, $$updated_at$$, $$alter table public.player_wallet add column if not exists updated_at timestamptz not null default now()$$, $$alter table public.player_wallet add column if not exists updated_at timestamptz default now()$$),
    ($$player_inventory$$, $$user_id$$, $$alter table public.player_inventory add column if not exists user_id text not null$$, $$alter table public.player_inventory add column if not exists user_id text$$),
    ($$player_inventory$$, $$item_id$$, $$alter table public.player_inventory add column if not exists item_id text not null$$, $$alter table public.player_inventory add column if not exists item_id text$$),
    ($$player_inventory$$, $$acquired_at$$, $$alter table public.player_inventory add column if not exists acquired_at timestamptz not null default now()$$, $$alter table public.player_inventory add column if not exists acquired_at timestamptz default now()$$),
    ($$player_equipped$$, $$user_id$$, $$alter table public.player_equipped add column if not exists user_id text$$, $$alter table public.player_equipped add column if not exists user_id text$$),
    ($$player_equipped$$, $$car$$, $$alter table public.player_equipped add column if not exists car text not null default 'street_runner'$$, $$alter table public.player_equipped add column if not exists car text default 'street_runner'$$),
    ($$player_equipped$$, $$paint$$, $$alter table public.player_equipped add column if not exists paint int not null default 0$$, $$alter table public.player_equipped add column if not exists paint int default 0$$),
    ($$player_equipped$$, $$wheels$$, $$alter table public.player_equipped add column if not exists wheels int not null default 0$$, $$alter table public.player_equipped add column if not exists wheels int default 0$$),
    ($$player_equipped$$, $$trail$$, $$alter table public.player_equipped add column if not exists trail int not null default 0$$, $$alter table public.player_equipped add column if not exists trail int default 0$$),
    ($$player_equipped$$, $$decal$$, $$alter table public.player_equipped add column if not exists decal int not null default 0$$, $$alter table public.player_equipped add column if not exists decal int default 0$$),
    ($$player_equipped$$, $$neon$$, $$alter table public.player_equipped add column if not exists neon int not null default 0$$, $$alter table public.player_equipped add column if not exists neon int default 0$$),
    ($$player_equipped$$, $$title$$, $$alter table public.player_equipped add column if not exists title text not null default ''$$, $$alter table public.player_equipped add column if not exists title text default ''$$),
    ($$coin_ledger$$, $$id$$, $$alter table public.coin_ledger add column if not exists id bigint generated always as identity$$, $$alter table public.coin_ledger add column if not exists id bigint generated always as identity$$),
    ($$coin_ledger$$, $$ref$$, $$alter table public.coin_ledger add column if not exists ref text not null$$, $$alter table public.coin_ledger add column if not exists ref text$$),
    ($$coin_ledger$$, $$user_id$$, $$alter table public.coin_ledger add column if not exists user_id text not null$$, $$alter table public.coin_ledger add column if not exists user_id text$$),
    ($$coin_ledger$$, $$delta$$, $$alter table public.coin_ledger add column if not exists delta bigint not null$$, $$alter table public.coin_ledger add column if not exists delta bigint$$),
    ($$coin_ledger$$, $$reason$$, $$alter table public.coin_ledger add column if not exists reason text not null default 'race'$$, $$alter table public.coin_ledger add column if not exists reason text default 'race'$$),
    ($$coin_ledger$$, $$created_at$$, $$alter table public.coin_ledger add column if not exists created_at timestamptz not null default now()$$, $$alter table public.coin_ledger add column if not exists created_at timestamptz default now()$$),
    ($$daily_competition$$, $$id$$, $$alter table public.daily_competition add column if not exists id bigint generated always as identity$$, $$alter table public.daily_competition add column if not exists id bigint generated always as identity$$),
    ($$daily_competition$$, $$date_key$$, $$alter table public.daily_competition add column if not exists date_key text not null$$, $$alter table public.daily_competition add column if not exists date_key text$$),
    ($$daily_competition$$, $$user_id$$, $$alter table public.daily_competition add column if not exists user_id text not null$$, $$alter table public.daily_competition add column if not exists user_id text$$),
    ($$daily_competition$$, $$map$$, $$alter table public.daily_competition add column if not exists map int not null$$, $$alter table public.daily_competition add column if not exists map int$$),
    ($$daily_competition$$, $$best_lap_ms$$, $$alter table public.daily_competition add column if not exists best_lap_ms int not null check (best_lap_ms >= 15000)$$, $$alter table public.daily_competition add column if not exists best_lap_ms int check (best_lap_ms >= 15000)$$),
    ($$daily_competition$$, $$races_today$$, $$alter table public.daily_competition add column if not exists races_today int not null default 1$$, $$alter table public.daily_competition add column if not exists races_today int default 1$$),
    ($$daily_competition$$, $$name$$, $$alter table public.daily_competition add column if not exists name text not null default ''$$, $$alter table public.daily_competition add column if not exists name text default ''$$),
    ($$daily_competition$$, $$updated_at$$, $$alter table public.daily_competition add column if not exists updated_at timestamptz not null default now()$$, $$alter table public.daily_competition add column if not exists updated_at timestamptz default now()$$),
    ($$weekly_competition$$, $$id$$, $$alter table public.weekly_competition add column if not exists id bigint generated always as identity$$, $$alter table public.weekly_competition add column if not exists id bigint generated always as identity$$),
    ($$weekly_competition$$, $$week_key$$, $$alter table public.weekly_competition add column if not exists week_key text not null$$, $$alter table public.weekly_competition add column if not exists week_key text$$),
    ($$weekly_competition$$, $$user_id$$, $$alter table public.weekly_competition add column if not exists user_id text not null$$, $$alter table public.weekly_competition add column if not exists user_id text$$),
    ($$weekly_competition$$, $$points$$, $$alter table public.weekly_competition add column if not exists points int not null default 0$$, $$alter table public.weekly_competition add column if not exists points int default 0$$),
    ($$weekly_competition$$, $$races_week$$, $$alter table public.weekly_competition add column if not exists races_week int not null default 0$$, $$alter table public.weekly_competition add column if not exists races_week int default 0$$),
    ($$weekly_competition$$, $$wins_week$$, $$alter table public.weekly_competition add column if not exists wins_week int not null default 0$$, $$alter table public.weekly_competition add column if not exists wins_week int default 0$$),
    ($$weekly_competition$$, $$best_lap_ms$$, $$alter table public.weekly_competition add column if not exists best_lap_ms int$$, $$alter table public.weekly_competition add column if not exists best_lap_ms int$$),
    ($$weekly_competition$$, $$name$$, $$alter table public.weekly_competition add column if not exists name text not null default ''$$, $$alter table public.weekly_competition add column if not exists name text default ''$$),
    ($$weekly_competition$$, $$updated_at$$, $$alter table public.weekly_competition add column if not exists updated_at timestamptz not null default now()$$, $$alter table public.weekly_competition add column if not exists updated_at timestamptz default now()$$),
    ($$player_missions$$, $$user_id$$, $$alter table public.player_missions add column if not exists user_id text not null$$, $$alter table public.player_missions add column if not exists user_id text$$),
    ($$player_missions$$, $$date_key$$, $$alter table public.player_missions add column if not exists date_key text not null$$, $$alter table public.player_missions add column if not exists date_key text$$),
    ($$player_missions$$, $$mission_id$$, $$alter table public.player_missions add column if not exists mission_id text not null$$, $$alter table public.player_missions add column if not exists mission_id text$$),
    ($$player_missions$$, $$progress$$, $$alter table public.player_missions add column if not exists progress int not null default 0$$, $$alter table public.player_missions add column if not exists progress int default 0$$),
    ($$player_missions$$, $$completed$$, $$alter table public.player_missions add column if not exists completed boolean not null default false$$, $$alter table public.player_missions add column if not exists completed boolean default false$$),
    ($$player_missions$$, $$claimed$$, $$alter table public.player_missions add column if not exists claimed boolean not null default false$$, $$alter table public.player_missions add column if not exists claimed boolean default false$$),
    ($$player_missions$$, $$updated_at$$, $$alter table public.player_missions add column if not exists updated_at timestamptz not null default now()$$, $$alter table public.player_missions add column if not exists updated_at timestamptz default now()$$),
    ($$season_rewards_claimed$$, $$user_id$$, $$alter table public.season_rewards_claimed add column if not exists user_id text not null$$, $$alter table public.season_rewards_claimed add column if not exists user_id text$$),
    ($$season_rewards_claimed$$, $$season_id$$, $$alter table public.season_rewards_claimed add column if not exists season_id text not null$$, $$alter table public.season_rewards_claimed add column if not exists season_id text$$),
    ($$season_rewards_claimed$$, $$tier$$, $$alter table public.season_rewards_claimed add column if not exists tier text not null$$, $$alter table public.season_rewards_claimed add column if not exists tier text$$),
    ($$season_rewards_claimed$$, $$claimed_at$$, $$alter table public.season_rewards_claimed add column if not exists claimed_at timestamptz not null default now()$$, $$alter table public.season_rewards_claimed add column if not exists claimed_at timestamptz default now()$$),
    ($$player_badges$$, $$user_id$$, $$alter table public.player_badges add column if not exists user_id text not null$$, $$alter table public.player_badges add column if not exists user_id text$$),
    ($$player_badges$$, $$badge_id$$, $$alter table public.player_badges add column if not exists badge_id text not null$$, $$alter table public.player_badges add column if not exists badge_id text$$),
    ($$player_badges$$, $$tier_level$$, $$alter table public.player_badges add column if not exists tier_level int not null default 1$$, $$alter table public.player_badges add column if not exists tier_level int default 1$$),
    ($$player_badges$$, $$equipped$$, $$alter table public.player_badges add column if not exists equipped boolean not null default false$$, $$alter table public.player_badges add column if not exists equipped boolean default false$$),
    ($$player_badges$$, $$unlocked_at$$, $$alter table public.player_badges add column if not exists unlocked_at timestamptz not null default now()$$, $$alter table public.player_badges add column if not exists unlocked_at timestamptz default now()$$),
    ($$player_revenge$$, $$owner_id$$, $$alter table public.player_revenge add column if not exists owner_id text not null$$, $$alter table public.player_revenge add column if not exists owner_id text$$),
    ($$player_revenge$$, $$target_id$$, $$alter table public.player_revenge add column if not exists target_id text not null$$, $$alter table public.player_revenge add column if not exists target_id text$$),
    ($$player_revenge$$, $$target_name$$, $$alter table public.player_revenge add column if not exists target_name text not null default 'RIVAL'$$, $$alter table public.player_revenge add column if not exists target_name text default 'RIVAL'$$),
    ($$player_revenge$$, $$map$$, $$alter table public.player_revenge add column if not exists map int not null default 0$$, $$alter table public.player_revenge add column if not exists map int default 0$$),
    ($$player_revenge$$, $$map_name$$, $$alter table public.player_revenge add column if not exists map_name text$$, $$alter table public.player_revenge add column if not exists map_name text$$),
    ($$player_revenge$$, $$target_rating$$, $$alter table public.player_revenge add column if not exists target_rating int$$, $$alter table public.player_revenge add column if not exists target_rating int$$),
    ($$player_revenge$$, $$status$$, $$alter table public.player_revenge add column if not exists status text not null default 'open'$$, $$alter table public.player_revenge add column if not exists status text default 'open'$$),
    ($$player_revenge$$, $$issued_at$$, $$alter table public.player_revenge add column if not exists issued_at timestamptz not null default now()$$, $$alter table public.player_revenge add column if not exists issued_at timestamptz default now()$$),
    ($$weekly_bounties$$, $$user_id$$, $$alter table public.weekly_bounties add column if not exists user_id text not null$$, $$alter table public.weekly_bounties add column if not exists user_id text$$),
    ($$weekly_bounties$$, $$week_key$$, $$alter table public.weekly_bounties add column if not exists week_key text not null$$, $$alter table public.weekly_bounties add column if not exists week_key text$$),
    ($$weekly_bounties$$, $$bounty_id$$, $$alter table public.weekly_bounties add column if not exists bounty_id text not null$$, $$alter table public.weekly_bounties add column if not exists bounty_id text$$),
    ($$weekly_bounties$$, $$progress$$, $$alter table public.weekly_bounties add column if not exists progress int not null default 0$$, $$alter table public.weekly_bounties add column if not exists progress int default 0$$),
    ($$weekly_bounties$$, $$completed$$, $$alter table public.weekly_bounties add column if not exists completed boolean not null default false$$, $$alter table public.weekly_bounties add column if not exists completed boolean default false$$),
    ($$weekly_bounties$$, $$claimed$$, $$alter table public.weekly_bounties add column if not exists claimed boolean not null default false$$, $$alter table public.weekly_bounties add column if not exists claimed boolean default false$$),
    ($$weekly_bounties$$, $$updated_at$$, $$alter table public.weekly_bounties add column if not exists updated_at timestamptz not null default now()$$, $$alter table public.weekly_bounties add column if not exists updated_at timestamptz default now()$$),
    ($$crews$$, $$id$$, $$alter table public.crews add column if not exists id text$$, $$alter table public.crews add column if not exists id text$$),
    ($$crews$$, $$tag$$, $$alter table public.crews add column if not exists tag text not null$$, $$alter table public.crews add column if not exists tag text$$),
    ($$crews$$, $$name$$, $$alter table public.crews add column if not exists name text not null$$, $$alter table public.crews add column if not exists name text$$),
    ($$crews$$, $$motto$$, $$alter table public.crews add column if not exists motto text$$, $$alter table public.crews add column if not exists motto text$$),
    ($$crews$$, $$badge$$, $$alter table public.crews add column if not exists badge text$$, $$alter table public.crews add column if not exists badge text$$),
    ($$crews$$, $$color$$, $$alter table public.crews add column if not exists color text$$, $$alter table public.crews add column if not exists color text$$),
    ($$crews$$, $$leader_uid$$, $$alter table public.crews add column if not exists leader_uid text$$, $$alter table public.crews add column if not exists leader_uid text$$),
    ($$crews$$, $$weekly_meters$$, $$alter table public.crews add column if not exists weekly_meters double precision not null default 0$$, $$alter table public.crews add column if not exists weekly_meters double precision default 0$$),
    ($$crews$$, $$total_meters$$, $$alter table public.crews add column if not exists total_meters double precision not null default 0$$, $$alter table public.crews add column if not exists total_meters double precision default 0$$),
    ($$crews$$, $$weekly_points$$, $$alter table public.crews add column if not exists weekly_points int not null default 0$$, $$alter table public.crews add column if not exists weekly_points int default 0$$),
    ($$crews$$, $$week_key$$, $$alter table public.crews add column if not exists week_key text$$, $$alter table public.crews add column if not exists week_key text$$),
    ($$crews$$, $$seeded$$, $$alter table public.crews add column if not exists seeded boolean not null default false$$, $$alter table public.crews add column if not exists seeded boolean default false$$),
    ($$crews$$, $$created_at$$, $$alter table public.crews add column if not exists created_at timestamptz not null default now()$$, $$alter table public.crews add column if not exists created_at timestamptz default now()$$),
    ($$crew_members$$, $$crew_id$$, $$alter table public.crew_members add column if not exists crew_id text not null references public.crews(id) on delete cascade$$, $$alter table public.crew_members add column if not exists crew_id text references public.crews(id) on delete cascade$$),
    ($$crew_members$$, $$member_key$$, $$alter table public.crew_members add column if not exists member_key text not null$$, $$alter table public.crew_members add column if not exists member_key text$$),
    ($$crew_members$$, $$name$$, $$alter table public.crew_members add column if not exists name text$$, $$alter table public.crew_members add column if not exists name text$$),
    ($$crew_members$$, $$role$$, $$alter table public.crew_members add column if not exists role text not null default 'member'$$, $$alter table public.crew_members add column if not exists role text default 'member'$$),
    ($$crew_members$$, $$aliases$$, $$alter table public.crew_members add column if not exists aliases text[] not null default '{}'$$, $$alter table public.crew_members add column if not exists aliases text[] default '{}'$$),
    ($$crew_members$$, $$weekly_meters$$, $$alter table public.crew_members add column if not exists weekly_meters double precision not null default 0$$, $$alter table public.crew_members add column if not exists weekly_meters double precision default 0$$),
    ($$crew_members$$, $$total_meters$$, $$alter table public.crew_members add column if not exists total_meters double precision not null default 0$$, $$alter table public.crew_members add column if not exists total_meters double precision default 0$$),
    ($$crew_members$$, $$weekly_points$$, $$alter table public.crew_members add column if not exists weekly_points int not null default 0$$, $$alter table public.crew_members add column if not exists weekly_points int default 0$$),
    ($$crew_members$$, $$week_key$$, $$alter table public.crew_members add column if not exists week_key text$$, $$alter table public.crew_members add column if not exists week_key text$$),
    ($$crew_members$$, $$joined_at$$, $$alter table public.crew_members add column if not exists joined_at timestamptz not null default now()$$, $$alter table public.crew_members add column if not exists joined_at timestamptz default now()$$),
    ($$crew_milestone_claims$$, $$crew_id$$, $$alter table public.crew_milestone_claims add column if not exists crew_id text not null$$, $$alter table public.crew_milestone_claims add column if not exists crew_id text$$),
    ($$crew_milestone_claims$$, $$tier$$, $$alter table public.crew_milestone_claims add column if not exists tier int not null$$, $$alter table public.crew_milestone_claims add column if not exists tier int$$),
    ($$crew_milestone_claims$$, $$member_key$$, $$alter table public.crew_milestone_claims add column if not exists member_key text not null$$, $$alter table public.crew_milestone_claims add column if not exists member_key text$$),
    ($$crew_milestone_claims$$, $$week_key$$, $$alter table public.crew_milestone_claims add column if not exists week_key text not null default ''$$, $$alter table public.crew_milestone_claims add column if not exists week_key text default ''$$),
    ($$crew_milestone_claims$$, $$claimed_at$$, $$alter table public.crew_milestone_claims add column if not exists claimed_at timestamptz not null default now()$$, $$alter table public.crew_milestone_claims add column if not exists claimed_at timestamptz default now()$$)
    ) as v(tbl, col, ddl_strict, ddl_loose)
  loop
    if to_regclass('public.' || r.tbl) is null then
      continue;
    end if;
    begin
      execute r.ddl_strict;
    exception when others then
      begin
        execute r.ddl_loose;
      exception when others then
        raise notice 'column converge skipped %.%: %', r.tbl, r.col, sqlerrm;
      end;
    end;
  end loop;
end $conv$;



-- ----------------------------------------------------------------------------
-- 4. converge indexes
-- ----------------------------------------------------------------------------
-- Same reasoning, same protection: an index over a column an old table lacks is
-- skipped with a notice instead of aborting the whole migration. Indexes are
-- performance, not correctness, so this is the right trade.
do $idx$
declare
  r record;
begin
  for r in
    select * from (values
    ($$lb_map_time$$, $$create index if not exists lb_map_time on public.leaderboard (map, time_ms)$$),
    ($$stats_rating$$, $$create index if not exists stats_rating on public.player_stats (rating desc)$$),
    ($$rh_user_time$$, $$create index if not exists rh_user_time on public.race_history (user_id, created_at desc)$$),
    ($$friends_to$$, $$create index if not exists friends_to on public.friends (to_uid, status)$$),
    ($$friends_from$$, $$create index if not exists friends_from on public.friends (from_uid, status)$$),
    ($$ch_open$$, $$create index if not exists ch_open on public.challenges (status) where status = 'open'$$),
    ($$ch_to$$, $$create index if not exists ch_to on public.challenges (to_uid, status)$$),
    ($$ledger_user$$, $$create index if not exists ledger_user on public.coin_ledger (user_id, created_at desc)$$),
    ($$idx_stats_competitive$$, $$create index if not exists idx_stats_competitive on public.player_stats (rating desc, wins desc, races asc)$$),
    ($$idx_stats_wins$$, $$create index if not exists idx_stats_wins on public.player_stats (wins desc, races asc)$$),
    ($$idx_stats_races$$, $$create index if not exists idx_stats_races on public.player_stats (races desc)$$),
    ($$idx_daily_comp_rank$$, $$create index if not exists idx_daily_comp_rank on public.daily_competition (date_key, best_lap_ms asc)$$),
    ($$idx_weekly_comp_rank$$, $$create index if not exists idx_weekly_comp_rank on public.weekly_competition (week_key, points desc, wins_week desc)$$),
    ($$revenge_owner_issued_idx$$, $$create index if not exists revenge_owner_issued_idx on public.player_revenge (owner_id, issued_at desc)$$),
    ($$crew_members_alias_idx$$, $$create index if not exists crew_members_alias_idx on public.crew_members using gin (aliases)$$)
    ) as v(nm, ddl)
  loop
    begin
      execute r.ddl;
    exception when others then
      raise notice 'index skipped %: %', r.nm, sqlerrm;
    end;
  end loop;
end $idx$;



-- ----------------------------------------------------------------------------
-- 5. identity columns uuid -> text
-- ----------------------------------------------------------------------------
-- A guest racer is keyed by a device pid ("p3k9x2ab1c2d") or a display name, and
-- the server sends that key on every read and every write. Postgres rejects it
-- against a uuid column:
--     invalid input syntax for type uuid  ->  HTTP 400 from PostgREST
-- and a 400 is swallowed by the fetch guards around those calls, so nothing logged
-- and nothing looked broken - the rows simply were never saved.
--
-- Postgres will not change a column's type underneath a policy that references it,
-- so the eight policies that compare auth.uid() with an identity column are dropped
-- here and recreated in section 6 with an explicit ::text cast. The remaining
-- policies use `using (true)` and are untouched. Every table named below exists by
-- now, because section 2 created it.
drop policy if exists "missions own read"        on public.player_missions;
drop policy if exists "weekly bounties own read" on public.weekly_bounties;
drop policy if exists "badges own read"          on public.player_badges;
drop policy if exists "revenge own read"         on public.player_revenge;
drop policy if exists "history own read"         on public.race_history;
drop policy if exists "wallet own read"          on public.player_wallet;
drop policy if exists "inv own read"             on public.player_inventory;
drop policy if exists "season claim own read"    on public.season_rewards_claimed;

-- 5a. the three progression tables (v96)
do $$
declare
  t text;
  c record;
begin
  foreach t in array array['player_missions', 'weekly_bounties', 'player_badges']
  loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    -- drop the auth.users foreign keys: a guest pid is not an auth user
    for c in
      select conname from pg_constraint
      where conrelid = ('public.' || t)::regclass and contype = 'f'
    loop
      execute format('alter table public.%I drop constraint %I', t, c.conname);
    end loop;

    execute format('alter table public.%I alter column user_id type text using user_id::text', t);
  end loop;
end $$;

-- 5b. the twelve competitive tables (v97)
do $$
declare
  t text;
  c record;
begin
  foreach t in array array[
    'player_stats',
    'player_map_records',
    'race_history',
    'player_achievements',
    'player_seasons',
    'player_wallet',
    'player_inventory',
    'player_equipped',
    'coin_ledger',
    'daily_competition',
    'weekly_competition',
    'season_rewards_claimed'
  ]
  loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'user_id'
    ) then
      continue;
    end if;

    -- drop every foreign key on this table that points at auth.users: a guest's
    -- device pid is not an auth user, and neither is a display name
    for c in
      select con.conname
      from pg_constraint con
      join pg_class frel on frel.oid = con.confrelid
      join pg_namespace fnsp on fnsp.oid = frel.relnamespace
      where con.conrelid = ('public.' || t)::regclass
        and con.contype = 'f'
        and fnsp.nspname = 'auth'
        and frel.relname = 'users'
    loop
      execute format('alter table public.%I drop constraint %I', t, c.conname);
    end loop;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t
        and column_name = 'user_id' and data_type = 'uuid'
    ) then
      execute format('alter table public.%I alter column user_id type text using user_id::text', t);
    end if;
  end loop;
end $$;

-- 5c. the challenge columns that name a RACER, not an account (v111)
-- ----------------------------------------------------------------------------
-- Revenge requests and friend challenges are addressed to whatever identity a
-- racer actually has - a device pid or a display name for guests - and a
-- settled challenge stores its winner the same way. Under uuid columns every
-- one of those writes was rejected with invalid input syntax for type uuid,
-- which the fetch guards swallowed, so from_uid / to_uid / winner_uid relax
-- here exactly like the user_id columns above. The two policies that compare
-- auth.uid() with these columns go first (section 6 recreates them cast).
drop policy if exists "ch make"   on public.challenges;
drop policy if exists "ch answer" on public.challenges;

do $$
declare
  c record;
  col text;
begin
  if to_regclass('public.challenges') is null then
    return;
  end if;

  for c in
    select con.conname
    from pg_constraint con
    join pg_class frel on frel.oid = con.confrelid
    join pg_namespace fnsp on fnsp.oid = frel.relnamespace
    where con.conrelid = 'public.challenges'::regclass
      and con.contype = 'f'
      and fnsp.nspname = 'auth'
      and frel.relname = 'users'
  loop
    execute format('alter table public.challenges drop constraint %I', c.conname);
  end loop;

  foreach col in array array['from_uid', 'to_uid', 'winner_uid']
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'challenges'
        and column_name = col and data_type = 'uuid'
    ) then
      execute format('alter table public.challenges alter column %I type text using %I::text', col, col);
    end if;
  end loop;
end $$;

-- The status CHECK predates both the friend-answer flow and revenge requests:
-- 'accepted' / 'declined' / 'pending' were never in it, so answering a friend
-- challenge was rejected by the table itself. Widen it whenever it is still the
-- three-value one. pg_constraint is a catalog, so these probes cannot 42P01.
do $$
begin
  if to_regclass('public.challenges') is null then
    return;
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.challenges'::regclass
      and conname = 'challenges_status_check'
      and pg_get_constraintdef(oid) not like '%pending%'
  ) then
    alter table public.challenges drop constraint challenges_status_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.challenges'::regclass
      and conname = 'challenges_status_check'
  ) then
    alter table public.challenges add constraint challenges_status_check
      check (status in ('open', 'done', 'expired', 'pending', 'accepted', 'declined'));
  end if;
end $$;

-- Trade-off, stated plainly: dropping the foreign key to auth.users means deleting
-- an auth account no longer cascades to these rows. Nothing in the game deletes an
-- account, and a guest key was never in auth.users to begin with, so the constraint
-- was only ever rejecting rows rather than protecting any.


-- ----------------------------------------------------------------------------
-- 6. row-level security policies
-- ----------------------------------------------------------------------------
-- Dropped first so this file can be re-run: `create policy` has no `or replace`
-- and fails on a name that already exists. Club data reaches the browser only
-- through the server's service-role endpoints, so the three crew tables keep RLS
-- enabled with NO policies - the tightest setting that still works.

drop policy if exists "lb read" on public.leaderboard;
create policy "lb read" on public.leaderboard
  for select using (true);

drop policy if exists "ghost read" on public.ghosts;
create policy "ghost read" on public.ghosts
  for select using (true);

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read"   on public.profiles for select using (true);

drop policy if exists "profiles own i" on public.profiles;
create policy "profiles own i"  on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "profiles own u" on public.profiles;
create policy "profiles own u"  on public.profiles for update using (auth.uid() = id);

drop policy if exists "stats read" on public.player_stats;
create policy "stats read" on public.player_stats for select using (true);

drop policy if exists "records read" on public.player_map_records;
create policy "records read" on public.player_map_records for select using (true);

drop policy if exists "history own read" on public.race_history;
create policy "history own read" on public.race_history for select using (auth.uid()::text = user_id);

drop policy if exists "friends see" on public.friends;
create policy "friends see"  on public.friends for select using (auth.uid() = from_uid or auth.uid() = to_uid);

drop policy if exists "friends ask" on public.friends;
create policy "friends ask"  on public.friends for insert with check (auth.uid() = from_uid);

drop policy if exists "friends ans" on public.friends;
create policy "friends ans"  on public.friends for update using (auth.uid() = to_uid);

drop policy if exists "friends drop" on public.friends;
create policy "friends drop" on public.friends for delete using (auth.uid() = from_uid or auth.uid() = to_uid);

drop policy if exists "ch read" on public.challenges;
create policy "ch read" on public.challenges for select using (true);   -- share links are public

drop policy if exists "ch make" on public.challenges;
create policy "ch make" on public.challenges for insert with check (auth.uid()::text = from_uid);

drop policy if exists "ach read" on public.player_achievements;
create policy "ach read" on public.player_achievements for select using (true);

drop policy if exists "seasons read" on public.seasons;
create policy "seasons read" on public.seasons for select using (true);

drop policy if exists "pseasons read" on public.player_seasons;
create policy "pseasons read" on public.player_seasons for select using (true);

drop policy if exists "wallet own read" on public.player_wallet;
create policy "wallet own read" on public.player_wallet for select using (auth.uid()::text = user_id);

drop policy if exists "inv own read" on public.player_inventory;
create policy "inv own read" on public.player_inventory for select using (auth.uid()::text = user_id);

drop policy if exists "equipped read" on public.player_equipped;
create policy "equipped read" on public.player_equipped for select using (true);

drop policy if exists "ch answer" on public.challenges;
create policy "ch answer" on public.challenges for update
  using (auth.uid()::text = to_uid)
  with check (status in ('accepted', 'declined'));

drop policy if exists "daily comp read" on public.daily_competition;
create policy "daily comp read" on public.daily_competition for select using (true);

drop policy if exists "weekly comp read" on public.weekly_competition;
create policy "weekly comp read" on public.weekly_competition for select using (true);

drop policy if exists "missions own read" on public.player_missions;
create policy "missions own read" on public.player_missions for select using (auth.uid()::text = user_id);

drop policy if exists "season claim own read" on public.season_rewards_claimed;
create policy "season claim own read" on public.season_rewards_claimed for select using (auth.uid()::text = user_id);

drop policy if exists "badges own read" on public.player_badges;
create policy "badges own read" on public.player_badges for select using (auth.uid()::text = user_id);

drop policy if exists "revenge own read" on public.player_revenge;
create policy "revenge own read" on public.player_revenge for select using (auth.uid()::text = owner_id);

drop policy if exists "weekly bounties own read" on public.weekly_bounties;
create policy "weekly bounties own read" on public.weekly_bounties for select using (auth.uid()::text = user_id);


-- ----------------------------------------------------------------------------
-- 7. names on the board rows - so a racer with no profiles row is not "RACER"
-- ----------------------------------------------------------------------------
-- Section 3 already covers these; they are repeated here because they are the
-- columns the /health probe reports as playerStatsHasName and compHasName, and
-- they should be visible in the file rather than buried in a generated list.
-- All three boards used to take every name from profiles.username. A guest has no
-- profiles row, so the Global Rating board rendered a page of racers all called
-- "RACER" next to real ratings, and the Daily and Founders Cups did the same.
alter table if exists public.player_stats
  add column if not exists name text not null default '';

alter table if exists public.daily_competition
  add column if not exists name text not null default '';

alter table if exists public.weekly_competition
  add column if not exists name text not null default '';


-- ----------------------------------------------------------------------------
-- 8. club milestone claims become weekly
-- ----------------------------------------------------------------------------
-- Club counters roll over every Monday 00:00 UTC and a member may collect each
-- milestone tier once PER WEEK, so week_key has to be part of a claim's identity:
-- without it, week two's claim would overwrite week one's. The column is added
-- first, because a database that has this table from an older shape would
-- otherwise fail on the ALTER that follows.
alter table if exists public.crew_milestone_claims
  add column if not exists week_key text not null default '';

alter table if exists public.crew_milestone_claims
  alter column week_key set default '';

-- Any row written before the week was known is stamped with the week it is being
-- migrated in, so nobody collects the same reward twice in the week it was already
-- paid out. Computed with exactly the formula the server uses. The UPDATE names
-- the table statically, which is safe only because the to_regclass guard returns
-- before it is ever prepared - a statement is planned on first execution.
do $$
declare
  mon     date;
  onejan  date;
  wk      text;
begin
  if to_regclass('public.crew_milestone_claims') is null then
    return;
  end if;

  mon    := date_trunc('week', now() at time zone 'utc')::date;   -- Postgres weeks start Monday
  onejan := make_date(extract(year from mon)::int, 1, 1);
  wk     := to_char(mon, 'YYYY') || '-W' ||
            lpad(ceil(((mon - onejan) + extract(dow from onejan)::int + 1) / 7.0)::int::text, 2, '0');

  update public.crew_milestone_claims set week_key = wk where week_key is null or week_key = '';
  raise notice 'stamped un-dated club claims with week %', wk;
end $$;

alter table if exists public.crew_milestone_claims
  alter column week_key set not null;

-- Swap the primary key only if it is not already the weekly one. The regclass cast
-- below would throw on a missing table, so the guard returns before it is planned.
do $$
declare
  conname text;
  pk_cols text;
begin
  if to_regclass('public.crew_milestone_claims') is null then
    return;
  end if;

  select con.conname,
         string_agg(a.attname, ',' order by x.ordinality)
    into conname, pk_cols
    from pg_constraint con
    join lateral unnest(con.conkey) with ordinality as x(attnum, ordinality) on true
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = x.attnum
   where con.conrelid = 'public.crew_milestone_claims'::regclass
     and con.contype = 'p'
   group by con.conname;

  if pk_cols is distinct from 'crew_id,week_key,tier,member_key' then
    if conname is not null then
      execute format('alter table public.crew_milestone_claims drop constraint %I', conname);
    end if;
    alter table public.crew_milestone_claims
      add primary key (crew_id, week_key, tier, member_key);
    raise notice 'crew_milestone_claims primary key widened to (crew_id, week_key, tier, member_key)';
  else
    raise notice 'crew_milestone_claims primary key is already weekly - nothing to do';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 9. verify
-- ----------------------------------------------------------------------------
-- Every row should say data_type = text:
--
--   select table_name, data_type from information_schema.columns
--    where table_schema = 'public' and column_name = 'user_id'
--      and table_name in ('player_stats','player_map_records','race_history',
--                         'player_achievements','player_seasons','daily_competition',
--                         'weekly_competition','player_missions','weekly_bounties',
--                         'player_badges')
--    order by table_name;
--
-- All three should be listed:
--
--   select table_name from information_schema.columns
--    where table_schema = 'public' and column_name = 'name'
--      and table_name in ('player_stats','daily_competition','weekly_competition');
--
-- The club tables must exist, with RLS on:
--
--   select relname, relrowsecurity from pg_class
--    where relname in ('crews','crew_members','crew_milestone_claims','player_revenge');
--
-- Or skip the SQL and read the running server (restart it first - it probes once at
-- boot): persistence.verdict should be "ok", crews / crewMembers / crewClaims "ok",
-- playerStatsKeyType "text", playerStatsHasName and compHasName true.
--
--   curl -s https://<your-backend-host>/health | python3 -m json.tool
-- ============================================================================
