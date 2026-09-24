-- ============================================================================
-- SRIDHAR RUSH — v96 migration: DURABLE PROGRESSION + WEEKLY CLUBS
-- ============================================================================
-- Run this ONCE in the Supabase SQL Editor on an EXISTING database.
--
-- SUPERSEDED BY supabase-migration-v98.sql - run that file instead. THIS FILE
-- CANNOT RUN on a database that predates the progression tables: its first line is
--     drop policy if exists "missions own read" on public.player_missions;
-- and IF EXISTS guards the POLICY, not the TABLE, so it aborts with
--     ERROR: 42P01: relation "public.player_missions" does not exist
-- before creating anything. v98 creates every missing table first, then relaxes
-- the identity columns, then recreates the policies, and is safe from any state.
--
-- THIS FILE SUPERSEDES supabase-migration-v94.sql. It contains everything v94
-- did plus the v96 change, so run THIS file whether or not you already ran v94.
-- Every statement is idempotent - the whole file is safe to re-run, and re-running
-- it after v94 is a no-op apart from section 4.
--
-- Brand-new projects do NOT need it: supabase-setup.sql already contains all of
-- this. (setup.sql is deliberately not re-runnable - its policies have no
-- drop-if-exists guard - which is why upgrades go through a migration file.)
--
-- WHAT THIS FIXES
-- ---------------
-- 1. identity columns relaxed uuid -> text: a guest racer is keyed by a device
--    pid or a display name, which a uuid column would have rejected
-- 2. player_revenge rebuilt to the shape the server actually stores
-- 3. three club tables: crews, crew_members (with the alias array the v90
--    club-sync fix depends on), crew_milestone_claims
-- 4. NEW IN v96 - club milestone claims become WEEKLY. Club counters were always
--    named and labelled "weekly" but nothing ever reset them; build v96 rolls
--    them over every Monday 00:00 UTC and lets each member collect each milestone
--    tier once per week. That needs week_key inside the claim's primary key, so a
--    second week's claim is a new row rather than an overwrite of the first.
--
-- Sections 1-3 touch only tables that were EMPTY in every deployment before v95
-- (nothing ever wrote them), so no player data is at risk. Section 2 refuses to
-- drop a table that somehow does have rows, and section 4 keeps every existing
-- claim, stamping any that predate it with the week they were made in.
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
  week_key   text        not null default '',        -- v96: part of a claim's identity
  claimed_at timestamptz not null default now(),
  primary key (crew_id, week_key, tier, member_key)   -- v96: one claim per member per week
);

alter table public.crews                 enable row level security;
alter table public.crew_members          enable row level security;
alter table public.crew_milestone_claims enable row level security;

create index if not exists crew_members_alias_idx on public.crew_members using gin (aliases);


-- ----------------------------------------------------------------------------
-- 4. v96 — club milestone claims become weekly
-- ----------------------------------------------------------------------------
-- Build v96 rolls club counters over every Monday 00:00 UTC and lets a member
-- collect each milestone tier once PER WEEK. week_key therefore has to be part of
-- a claim's identity: without it, week two's claim would overwrite week one's.
--
-- This section is also safe on a database that never had the club tables at all
-- (section 3 has just created them with the weekly primary key already in place).

alter table if exists public.crew_milestone_claims
  alter column week_key set default '';

-- Any row written before the week was known gets stamped with the week it is
-- being migrated in, so nobody collects the same reward twice in the week it was
-- already paid out. Computed with exactly the formula the server uses:
-- Monday-based week number of the UTC week, formatted YYYY-Www.
do $$
declare
  mon     date;
  onejan  date;
  wk      text;
begin
  if to_regclass('public.crew_milestone_claims') is null then
    return;   -- no club tables yet: section 3 creates them already weekly
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

-- Swap the primary key only if it is not already the weekly one.
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

-- The primary key now serves the server's read pattern
-- (crew_id = ? and week_key = ?) as a prefix, so no extra index is needed.


-- ----------------------------------------------------------------------------
-- 5. Verification
-- ----------------------------------------------------------------------------
-- Expect: player_missions.user_id, weekly_bounties.user_id, player_badges.user_id,
-- player_revenge.owner_id all = text; crews, crew_members, crew_milestone_claims
-- present; and the claim primary key = crew_id, week_key, tier, member_key.
--
--   select table_name, column_name, data_type
--   from information_schema.columns
--   where table_schema = 'public'
--     and (table_name, column_name) in (
--       ('player_missions','user_id'), ('weekly_bounties','user_id'),
--       ('player_badges','user_id'), ('player_revenge','owner_id'))
--   order by table_name;
--
--   select a.attname
--   from pg_constraint con
--   join lateral unnest(con.conkey) with ordinality as x(attnum, ordinality) on true
--   join pg_attribute a on a.attrelid = con.conrelid and a.attnum = x.attnum
--   where con.conrelid = 'public.crew_milestone_claims'::regclass and con.contype = 'p'
--   order by x.ordinality;
--
--   select relname, relrowsecurity from pg_class
--   where relname in ('crews','crew_members','crew_milestone_claims','player_revenge');
-- ============================================================================
