-- ============================================================================
-- SRIDHAR RUSH — v94 migration: DURABLE PROGRESSION
-- ============================================================================
-- Run this ONCE in the Supabase SQL Editor on an EXISTING database
-- (one that already had supabase-setup.sql applied).
--
-- SUPERSEDED BY supabase-migration-v98.sql - run that file instead. v98 contains
-- everything here, creates any table that is missing first, and is safe from any
-- starting state.
--
-- Every statement is idempotent — the whole file is safe to re-run.
--
-- Brand-new projects do NOT need this file: supabase-setup.sql already contains
-- all of it. (setup.sql is deliberately not re-runnable, because its policies
-- have no drop-if-exists guard.)
--
-- WHAT THIS FIXES
-- ---------------
-- The v94 audit found that clubs, daily missions, weekly bounties, equipped
-- badges and revenge targets lived only in server RAM: every restart or redeploy
-- wiped them, even with Supabase fully configured. Six tables existed here but
-- no server code ever wrote to them, and clubs had no table at all.
--
-- Build v95 wires the server to these tables. This migration prepares them:
--   1. identity columns relaxed uuid -> text (guests race on a device pid or a
--      display name, which a uuid column would have rejected)
--   2. player_revenge rebuilt to match the shape the server actually stores
--   3. three new club tables
--
-- All four relaxed tables were EMPTY in every deployment — nothing ever wrote
-- them — so no player data is touched. Section 2 refuses to drop a table that
-- somehow does have rows.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Identity columns: uuid -> text
-- ----------------------------------------------------------------------------
-- The policies that compared `auth.uid() = user_id` are dropped first (Postgres
-- will not let a column change type underneath a policy) and recreated with an
-- explicit cast afterwards.
drop policy if exists "missions own read"       on public.player_missions;
drop policy if exists "weekly bounties own read" on public.weekly_bounties;
drop policy if exists "badges own read"          on public.player_badges;
drop policy if exists "revenge own read"         on public.player_revenge;

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

create policy "missions own read" on public.player_missions
  for select using (auth.uid()::text = user_id);

create policy "weekly bounties own read" on public.weekly_bounties
  for select using (auth.uid()::text = user_id);

create policy "badges own read" on public.player_badges
  for select using (auth.uid()::text = user_id);


-- ----------------------------------------------------------------------------
-- 2. player_revenge — rebuilt to the shape the server stores
-- ----------------------------------------------------------------------------
-- The v82 definition used two uuid columns and had no room for the display
-- fields the revenge UI shows (rival name, rating, track name). The server also
-- fans a target out under EVERY identity its owner is known by (uuid, device
-- pid, display name), so owner_id is text and part of the primary key.
do $$
begin
  if to_regclass('public.player_revenge') is not null
     and not exists (select 1 from public.player_revenge) then
    drop table public.player_revenge cascade;
  elsif to_regclass('public.player_revenge') is not null then
    raise notice 'player_revenge has rows - left untouched; reconcile manually before re-running';
  end if;
end $$;

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

create policy "revenge own read" on public.player_revenge
  for select using (auth.uid()::text = owner_id);

create index if not exists revenge_owner_issued_idx
  on public.player_revenge (owner_id, issued_at desc);


-- ----------------------------------------------------------------------------
-- 3. Clubs / syndicates — three new tables
-- ----------------------------------------------------------------------------
-- Club data is served to the browser exclusively through the server's
-- /api/player/crew/* endpoints, which use the service-role key (RLS does not
-- apply to it). RLS is therefore enabled with NO policies: the client's anon key
-- can neither read nor write club rows directly, which is the tightest setting
-- that still works.

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
  week_key   text,                                   -- recorded so a weekly rollover can be added later
  claimed_at timestamptz not null default now(),
  primary key (crew_id, tier, member_key)
);

alter table public.crews                 enable row level security;
alter table public.crew_members          enable row level security;
alter table public.crew_milestone_claims enable row level security;

create index if not exists crew_members_alias_idx on public.crew_members using gin (aliases);


-- ----------------------------------------------------------------------------
-- 4. Verification
-- ----------------------------------------------------------------------------
-- Expect: player_missions.user_id, weekly_bounties.user_id, player_badges.user_id,
-- player_revenge.owner_id all = text; and crews, crew_members,
-- crew_milestone_claims present.
--
--   select table_name, column_name, data_type
--   from information_schema.columns
--   where table_schema = 'public'
--     and (table_name, column_name) in (
--       ('player_missions','user_id'), ('weekly_bounties','user_id'),
--       ('player_badges','user_id'), ('player_revenge','owner_id'))
--   order by table_name;
--
--   select relname, relrowsecurity from pg_class
--   where relname in ('crews','crew_members','crew_milestone_claims','player_revenge');
-- ============================================================================
