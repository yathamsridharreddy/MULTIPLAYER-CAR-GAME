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
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[A-Za-z0-9_]{3,16}$'),
  -- v144: the driver name the player chose. Not unique - two racers may share a
  -- display name - and free of the handle's charset rules. The account's name of
  -- record, so it follows them to every device at sign-in.
  display_name text check (display_name is null
                           or (char_length(display_name) between 1 and 16
                               and display_name !~ '[[:cntrl:]]')),
  created_at   timestamptz not null default now()
);
-- runs on a database created before v144 (create table if not exists is a no-op there)
alter table public.profiles add column if not exists display_name text;
alter table public.profiles
  drop constraint if exists profiles_display_name_chk;
alter table public.profiles
  add constraint profiles_display_name_chk
  check (display_name is null
         or (char_length(display_name) between 1 and 16
             and display_name !~ '[[:cntrl:]]'));
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
  created_at    timestamptz      not null default now(),
  -- v158.6: last time the WORDING changed (name/tag/motto/badge/colour). The game
  -- server caches clubs in memory and reads this to notice a rename made in the
  -- SQL editor, without a restart.
  updated_at    timestamptz      not null default now()
);

create or replace function public.sr_crews_touch()
returns trigger
language plpgsql
as $$
begin
  if new.name is distinct from old.name
     or new.tag is distinct from old.tag
     or new.motto is distinct from old.motto
     or new.badge is distinct from old.badge
     or new.color is distinct from old.color then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;   -- a counter moving is not a rename
  end if;
  return new;
end $$;

drop trigger if exists sr_crews_touch on public.crews;
create trigger sr_crews_touch
  before update on public.crews
  for each row execute function public.sr_crews_touch();

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

-- ----------------------------------------------------------------------------
-- v158 ACCOUNT DELETION - the purge machine
-- ----------------------------------------------------------------------------
-- Deleting a racer in Authentication -> Users used to leave every row they ever
-- wrote behind. The functions below erase them and a trigger on auth.users calls
-- one of them, so the dashboard delete is the whole operation. A database built
-- from this file gets the same machine as one upgraded with
-- supabase-migration-v98.sql; a database that wants neither re-run can run
-- supabase-migration-v158.sql alone. The one-time sweep of accounts deleted
-- before v158 existed is the last statement of that file, not of this one.
-- ----------------------------------------------------------------------------
-- 1. the tombstone ledger
-- ----------------------------------------------------------------------------
-- The game server keeps copies of a player's stats, missions, bounties and club
-- row in RAM between races. Without this table a purge would be undone by the
-- next write from a warm process, so every erase is recorded here and the server
-- sweeps its memory against it. `names` rides along because a few caches (the
-- in-process leaderboard, the club name hints) are keyed by display name alone.

create table if not exists public.sr_purged_players (
  key       text primary key,
  names     text[] not null default '{}',
  purged_at timestamptz not null default now()
);
-- the table may predate the names column (this file is re-runnable)
alter table public.sr_purged_players add column if not exists names text[] not null default '{}';

alter table public.sr_purged_players enable row level security;
-- RLS with no policies: the anon key can neither read nor write this, and the
-- game server reaches it with the service role, exactly like the club tables.


-- ----------------------------------------------------------------------------
-- 2. ghosts gain an owner key
-- ----------------------------------------------------------------------------
-- A ghost row is a shared racing line: id, map, name and the frames. It had no
-- identity column at all, so a deleted racer's ghost could not be found except
-- by the display name written on it. New rows carry the identity that saved
-- them; the purge matches the key when it is there and falls back to the name
-- for rows saved before this migration.

alter table if exists public.ghosts
  add column if not exists owner_key text;

create index if not exists ghosts_owner_key_idx on public.ghosts (owner_key);


-- ----------------------------------------------------------------------------
-- 3. sr_purge_identity - every row of one racer, everywhere
-- ----------------------------------------------------------------------------
-- p_keys  : every identity this account is known by (account uuid, the
--           'sb:<uuid>' device form the game writes, device pids, and any
--           aliases recorded on their club roster row).
-- p_names : the display names this account raced under. Only used where a table
--           has a name and no identity column (legacy ghost rows, old
--           leaderboard rows), because a name is weaker evidence than a key.
--
-- Every delete is built dynamically after checking that the table AND the column
-- exist, so this function never aborts on a database that is missing a table,
-- and it returns a per-table count so the caller can see what was erased.

create or replace function public.sr_purge_identity(p_keys text[], p_names text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keys   text[];
  v_names  text[];
  v_given  text[];   -- exactly the keys the caller named; never filtered away
  v_rec    record;
  v_hit    bigint;
  v_out    jsonb := '{}'::jsonb;
  v_claims text[];
  v_crews  text[];
  -- (the table/column pairs are written as VALUES lists below rather than as
  --  2-D arrays: plpgsql flattens a multidimensional array into scalars when it
  --  iterates, which silently hands a string to a record variable)
begin
  -- ---- 1. the identity set ------------------------------------------------
  -- drop nulls and blanks, de-duplicate, and always include the 'sb:<uuid>'
  -- device form the game writes for a signed-in racer alongside the bare uuid
  select coalesce(array_agg(distinct t), '{}')
    into v_keys
    from (
      select btrim(k) as t from unnest(coalesce(p_keys, '{}')) as k
      union
      select 'sb:' || btrim(k) from unnest(coalesce(p_keys, '{}')) as k
       where btrim(k) <> '' and btrim(k) !~* '^sb:'
    ) s
   where t <> '';

  select coalesce(array_agg(distinct btrim(n)), '{}')
    into v_names
    from unnest(coalesce(p_names, '{}')) as n
   where btrim(n) <> '';

  if v_keys = '{}' then
    return v_out;
  end if;

  -- remember what the caller asked for. The roster may only ADD identities to
  -- this list, and a roster row never gets to widen a purge onto a living
  -- account - so the two rules below need to tell the two apart.
  v_given := v_keys;

  -- ---- 2. widen the identity set from the club roster ---------------------
  -- The roster row is the richest record of who a racer is: it carries every
  -- device pid and display name ever seen for them. It is read FIRST so every
  -- other table is purged with the full set, not just the key the caller knew.
  if to_regclass('public.crew_members') is not null then
    begin
      select coalesce(array_agg(distinct m.member_key), '{}')
        into v_claims
        from public.crew_members m
       where m.member_key = any(v_keys)
          or (m.aliases is not null and m.aliases && v_keys)
          -- a name is weaker evidence, so it never claims a roster row whose key
          -- still answers to a LIVE account: two racers sharing a display name
          -- must not let one of them drag the other into a purge
          or (v_names <> '{}' and m.name = any(v_names)
              and not exists (
                select 1 from auth.users u
                 where u.id::text = m.member_key or ('sb:' || u.id::text) = m.member_key
              ));

      -- A roster row can be shared by two racers who picked the same display
      -- name: one joined as a guest, the other signed in, and both aliases
      -- ended up on one row. Only that row may go with the purged account -
      -- never the living racer who happens to be the other name on it. So a
      -- claimed key (and, below, any key the roster widens us onto) is dropped
      -- the moment it still answers to a LIVE auth user, unless the caller
      -- asked for that key by name. Same rule as the name guard above, applied
      -- to every key the roster hands us.
      if v_claims <> '{}' then
        select coalesce(array_agg(distinct c), '{}')
          into v_claims
          from unnest(v_claims) as c
         where c = any(v_given)
            or not exists (
                 select 1 from auth.users u
                  where u.id::text = regexp_replace(lower(c), '^sb:', '')
                     or ('sb:' || u.id::text) = lower(c));
      end if;

      if v_claims <> '{}' then
        select coalesce(array_agg(distinct a), '{}')
          into v_keys
          from (
            select unnest(v_keys) as a
            union
            select unnest(coalesce(m.aliases, '{}')) as a
              from public.crew_members m
             where m.member_key = any(v_claims)
            union
            select m.member_key from public.crew_members m where m.member_key = any(v_claims)
          ) s
         where a is not null and a <> ''
           and (a = any(v_given)
                or not exists (
                      select 1 from auth.users u
                       where u.id::text = regexp_replace(lower(a), '^sb:', '')
                          or ('sb:' || u.id::text) = lower(a)));
      end if;
    exception when undefined_column then
      v_claims := '{}';
    end;
  end if;

  -- ---- 3. one identity column per table -----------------------------------
  for v_rec in
    select t.tbl, t.col from (values
      ('player_stats',           'user_id'),
      ('player_map_records',     'user_id'),
      ('race_history',           'user_id'),
      ('player_achievements',    'user_id'),
      ('player_seasons',         'user_id'),
      ('player_wallet',          'user_id'),
      ('player_inventory',       'user_id'),
      ('player_equipped',        'user_id'),
      ('coin_ledger',            'user_id'),
      ('daily_competition',      'user_id'),
      ('weekly_competition',     'user_id'),
      ('season_rewards_claimed', 'user_id'),
      ('player_missions',        'user_id'),
      ('weekly_bounties',        'user_id'),
      ('player_badges',          'user_id'),
      ('player_revenge',         'owner_id'),
      ('profiles',               'id'),
      ('leaderboard',            'pid'),
      ('ghosts',                 'owner_key')
    ) as t(tbl, col)
  loop
    begin
      if to_regclass('public.' || v_rec.tbl) is not null then
        -- ::text on the left: profiles.id is uuid on older databases while every
        -- other identity column is text, and one purge must work on both
        execute format('delete from public.%I t where t.%I::text = any($1)', v_rec.tbl, v_rec.col)
          using v_keys;
        get diagnostics v_hit = row_count;
        if v_hit > 0 then
          v_out := v_out || jsonb_build_object(v_rec.tbl || '.' || v_rec.col, v_hit);
        end if;
      end if;
    exception when undefined_column then
      null; -- an older database without this column: nothing to purge there
    end;
  end loop;

  -- ---- 4. link tables: either side of the link -----------------------------
  for v_rec in
    select t.tbl, t.col from (values
      ('friends',    'from_uid'),
      ('friends',    'to_uid'),
      ('challenges', 'from_uid'),
      ('challenges', 'to_uid'),
      ('challenges', 'winner_uid')
    ) as t(tbl, col)
  loop
    begin
      if to_regclass('public.' || v_rec.tbl) is not null then
        -- ::text on the left: profiles.id is uuid on older databases while every
        -- other identity column is text, and one purge must work on both
        execute format('delete from public.%I t where t.%I::text = any($1)', v_rec.tbl, v_rec.col)
          using v_keys;
        get diagnostics v_hit = row_count;
        if v_hit > 0 then
          v_out := v_out || jsonb_build_object(v_rec.tbl || '.' || v_rec.col, v_hit);
        end if;
      end if;
    exception when undefined_column then
      null;
    end;
  end loop;

  -- ---- 5. names, only where there is no identity to match -----------------
  -- The shared ghost table is the case this exists for: a racing line saved
  -- under a name, and rows written before v158 have no owner key. Matching by
  -- name can only be as precise as the name, so it is done ONLY for keyless
  -- rows and ONLY for names this account actually raced under. Rows written from
  -- v158 on carry owner_key and never reach this branch.
  if v_names <> '{}' then
    begin
      if to_regclass('public.ghosts') is not null then
        execute 'delete from public.ghosts t where t.owner_key is null and t.name = any($1)' using v_names;
        get diagnostics v_hit = row_count;
        if v_hit > 0 then
          v_out := v_out || jsonb_build_object('ghosts.legacy_name', v_hit);
        end if;
      end if;
    exception when undefined_column then
      null;
    end;

    begin
      if to_regclass('public.leaderboard') is not null then
        execute 'delete from public.leaderboard t where t.pid is null and t.name = any($1)' using v_names;
        get diagnostics v_hit = row_count;
        if v_hit > 0 then
          v_out := v_out || jsonb_build_object('leaderboard.legacy_name', v_hit);
        end if;
      end if;
    exception when undefined_column then
      null;
    end;
  end if;

  -- ---- 6. the clubs -------------------------------------------------------
  -- Before the roster rows go, the kilometres and points they contributed are
  -- SUBTRACTED from their club. Otherwise the club keeps a deleted racer's
  -- weekly total for ever - the "full data from clubs" this migration is for.
  if v_claims is not null and v_claims <> '{}' and to_regclass('public.crew_members') is not null then
    begin
      select coalesce(array_agg(distinct m.crew_id), '{}')
        into v_crews
        from public.crew_members m
       where m.member_key = any(v_claims);

      if to_regclass('public.crew_milestone_claims') is not null then
        execute 'delete from public.crew_milestone_claims t where t.member_key = any($1)' using v_claims;
        get diagnostics v_hit = row_count;
        if v_hit > 0 then
          v_out := v_out || jsonb_build_object('crew_milestone_claims', v_hit);
        end if;
      end if;

      execute $sql$
        update public.crews c
           set weekly_meters = greatest(0, c.weekly_meters - agg.wm),
               total_meters  = greatest(0, c.total_meters  - agg.tm),
               weekly_points = greatest(0, c.weekly_points - agg.wp)
          from (
            select m.crew_id,
                   coalesce(sum(m.weekly_meters), 0) as wm,
                   coalesce(sum(m.total_meters), 0)  as tm,
                   coalesce(sum(m.weekly_points), 0) as wp
              from public.crew_members m
             where m.member_key = any($1)
             group by m.crew_id
          ) agg
         where c.id = agg.crew_id
      $sql$ using v_claims;

      execute 'delete from public.crew_members t where t.member_key = any($1)' using v_claims;
      get diagnostics v_hit = row_count;
      if v_hit > 0 then
        v_out := v_out || jsonb_build_object('crew_members', v_hit);
      end if;

      -- A club with nobody left in it was that racer's club, so it goes with
      -- them - but ONLY a club this purge actually emptied (c.id = any(v_crews))
      -- and ONLY when the leader who owned it is one of the identities being
      -- purged. Without the first condition this statement deletes every club
      -- that merely happens to have no roster rows right now, which is not this
      -- racer's data at all. The built-in clubs are seeded and stay either way.
      execute $sql$
        delete from public.crews c
         where c.id = any($1)
           and coalesce(c.seeded, false) = false
           and (c.leader_uid is null or c.leader_uid = any($2))
           and not exists (select 1 from public.crew_members m where m.crew_id = c.id)
      $sql$ using v_crews, v_keys;

      -- ...and a club whose leader is gone passes to the member who has been
      -- there longest, rather than pointing at an account that no longer
      -- exists. The CLUB ROW can be the only thing naming that leader - a
      -- leader whose roster row was never written, or was already removed - so
      -- the club's own leader_uid is checked against the purge keys too.
      -- Without that, a club keeps pointing at a deleted account for ever.
      execute $sql$
        update public.crews c
           set leader_uid = (
             select m.member_key from public.crew_members m
              where m.crew_id = c.id
              order by m.joined_at asc, m.member_key asc
              limit 1
           )
         where exists (select 1 from public.crew_members m where m.crew_id = c.id)
           and (c.leader_uid is null or c.leader_uid = any($1))
           and (c.id = any($2) or c.leader_uid = any($3))
      $sql$ using v_claims, v_crews, v_keys;
    exception when undefined_column then
      null;
    end;
  end if;

  -- ---- 6b. take the purged identities off the rows that SURVIVED ----------
  -- A roster row can be shared by two racers who picked the same display name.
  -- The row belongs to the one who is still here, so it stays - but the
  -- deleted racer's key must not stay on it, or the identity lives on inside a
  -- living racer's row for ever (and every later cleanup finds it again).
  if to_regclass('public.crew_members') is not null and v_keys <> '{}' then
    begin
      execute $sql$
        update public.crew_members m
           set aliases = (
             select coalesce(array_agg(a order by a), '{}')
               from unnest(coalesce(m.aliases, '{}')) as a
              where not (a = any($1))
           )
         where m.aliases is not null and m.aliases && $1
      $sql$ using v_keys;
      get diagnostics v_hit = row_count;
      if v_hit > 0 then
        v_out := v_out || jsonb_build_object('crew_members.aliases_cleaned', v_hit);
      end if;
    exception when undefined_column then
      null;
    end;
  end if;

  -- ---- 7. the tombstone ---------------------------------------------------
  -- The game server keeps copies of these rows in RAM between races; this is how
  -- it learns to drop them, so a warm process cannot write the racer back.
  insert into public.sr_purged_players (key, names)
  select unnest(v_keys), v_names
  on conflict (key) do update
    set purged_at = now(),
        names = (select array(select distinct unnest(public.sr_purged_players.names || excluded.names)));

  return v_out;
end $$;

comment on function public.sr_purge_identity(text[], text[]) is
  'v158: erases every row of one racer across the game tables and repairs the clubs they were in.';

-- Supabase's role names, guarded so this file also runs on a plain PostgreSQL
-- (a local test cluster, a staging copy) where they do not exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.sr_purge_identity(text[], text[]) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.sr_purge_identity(text[], text[]) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sr_purge_identity(text[], text[]) to service_role';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 4. the trigger: deleting the auth user IS the delete
-- ----------------------------------------------------------------------------
-- Runs when you delete a user in Authentication -> Users (or via the Admin API).
-- It gathers every identity the account is known by - the uuid, the sb:<uuid>
-- device form, the pids and aliases recorded in the club roster, the display
-- name on their stats and profile - and hands the lot to the purge.

create or replace function public.sr_on_auth_user_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids    text[] := array[]::text[];
  v_keys   text[] := array[]::text[];
  v_names  text[] := array[]::text[];
  v_extra  text[];
  v_names_extra text[];
begin
  v_ids  := array[old.id::text, 'sb:' || old.id::text];

  -- the display name(s) this account raced under: the profile, then the name on
  -- its stats rows. Both are best-effort - an older database may not have them.
  begin
    if to_regclass('public.profiles') is not null then
      -- Both names the account is known by: the handle and the driver name the
      -- game actually SHOWS (v144). The driver name is the one a club roster
      -- carries, so a row that was written before this account was linked to an
      -- identity can still be recognised as theirs. display_name arrived in
      -- v144, hence the column check rather than an exception.
      if exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'display_name') then
        execute 'select coalesce(array_agg(distinct x), ''{}'') from (
                   select p.username as x from public.profiles p where p.id::text = $1
                   union all
                   select p.display_name from public.profiles p where p.id::text = $1
                 ) s where length(btrim(x)) > 0'
        into v_extra using old.id::text;
      else
        execute 'select coalesce(array_agg(distinct p.username), ''{}'') from public.profiles p where p.id::text = $1'
        into v_extra using old.id::text;
      end if;
      v_names := v_names || coalesce(v_extra, '{}');
    end if;
  exception when undefined_column then null;
  end;

  begin
    if to_regclass('public.player_stats') is not null then
      execute 'select coalesce(array_agg(distinct s.name), ''{}'') from public.player_stats s where s.user_id = any($1)'
        into v_extra using v_ids;
      v_names := v_names || coalesce(v_extra, '{}');
    end if;
  exception when undefined_column then null;
  end;

  -- every identity the club roster remembers this account by: its own roster
  -- row, the aliases on it, and the name it was listed under
  begin
    if to_regclass('public.crew_members') is not null then
      execute $sql$
        select coalesce(array_agg(distinct k), '{}'), coalesce(array_agg(distinct n), '{}')
          from (
            select m.member_key as k, m.name as n
              from public.crew_members m
             where m.member_key = any($1) or (m.aliases is not null and m.aliases && $1)
            union all
            select unnest(coalesce(m.aliases, '{}')) as k, m.name as n
              from public.crew_members m
             where m.member_key = any($1) or (m.aliases is not null and m.aliases && $1)
          ) s
         -- A roster row can be shared by two racers who use the same display
         -- name, and then one of them is the account being deleted while the
         -- other one is alive. Their account id must never travel with this
         -- purge: the row goes, the living racer's own data does not.
         where k is null or k = ''
            or not exists (
                  select 1 from auth.users u
                   where u.id::text = regexp_replace(lower(k), '^sb:', '')
                      or ('sb:' || u.id::text) = lower(k));
      $sql$ into v_extra, v_names_extra using v_ids;
      v_keys  := v_keys  || coalesce(v_extra, '{}');
      v_names := v_names || coalesce(v_names_extra, '{}');
    end if;
  exception when undefined_column then null;
  end;

  perform public.sr_purge_identity(v_ids || v_keys, v_names);
  return old;
end $$;

comment on function public.sr_on_auth_user_delete() is
  'v158: purges a deleted account from every game table. Attached to auth.users.';

-- the trigger is what makes the dashboard delete complete
drop trigger if exists sr_purge_on_auth_delete on auth.users;
create trigger sr_purge_on_auth_delete
  after delete on auth.users
  for each row execute function public.sr_on_auth_user_delete();


-- ----------------------------------------------------------------------------
-- 5. accounts deleted BEFORE this migration
-- ----------------------------------------------------------------------------
-- Everything above only fires from now on. Any account deleted from the
-- dashboard while this migration did not exist still has its rows, and they are
-- identified the same way the game identifies them: a key that is a uuid, where
-- that uuid is no longer in auth.users. Guest rows (a device pid, a display
-- name) are NOT touched - they were never accounts.

create or replace function public.sr_purge_orphans()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keys  text[] := array[]::text[];
  v_names text[] := array[]::text[];
  v_out   jsonb;
begin
  -- candidates from every identity column the game writes
  begin
    execute $sql$
      select coalesce(array_agg(distinct k), '{}'), coalesce(array_agg(distinct n), '{}')
        from (
          select s.user_id as k, s.name as n from public.player_stats s
           where s.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          union all
          select m.member_key, m.name from public.crew_members m
           where m.member_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          union all
          select p.id::text, p.username from public.profiles p
           where p.id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ) c
    $sql$ into v_keys, v_names;
  exception when undefined_table then
    return '{}'::jsonb;
  end;

  if v_keys = '{}' then
    return '{}'::jsonb;
  end if;

  -- keep only the keys that no longer answer to an auth user
  select coalesce(array_agg(k), '{}') into v_keys
    from unnest(v_keys) as k
   where not exists (select 1 from auth.users u where u.id::text = k);

  if v_keys = '{}' then
    return '{}'::jsonb;
  end if;

  v_out := public.sr_purge_identity(v_keys, v_names);
  return v_out;
end $$;

comment on function public.sr_purge_orphans() is
  'v158: sweeps rows left behind by accounts deleted before the purge trigger existed.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.sr_purge_orphans() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.sr_purge_orphans() from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sr_purge_orphans() to service_role';
  end if;
end $$;
