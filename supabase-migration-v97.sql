-- ============================================================================
-- SRIDHAR RUSH — v97 migration: ONE DURABLE IDENTITY FOR EVERY RACER
-- ============================================================================
-- Run this ONCE in the Supabase SQL Editor on an EXISTING database.
--
-- SUPERSEDED BY supabase-migration-v98.sql - run that file instead. Like v96, this
-- one opens with `drop policy ... on public.race_history`, which aborts with 42P01
-- on a database that does not have that table yet. v98 contains this relaxation for
-- all twelve tables, creates anything missing first, and is safe from any state.
--
-- Every statement is idempotent - the whole file is safe to re-run.
-- Brand-new projects do NOT need it: supabase-setup.sql now declares these columns
-- as text itself, and carries the name columns and the text-parameter coin
-- functions. This file exists for databases created before that change.
--
-- WHAT THIS FIXES
-- ---------------
-- The competitive tables were created with
--
--     user_id uuid primary key references auth.users(id) on delete cascade
--
-- which only accepts the id of a signed-in Supabase Auth account. But a racer who
-- has not signed in is keyed by their device pid ("p3k9x2ab1c2d"), and the server
-- sends that key on every read and every write. Postgres rejects it:
--
--     invalid input syntax for type uuid  ->  HTTP 400 from PostgREST
--
-- A 400 is swallowed by the fetch guards around those calls, so nothing logged and
-- nothing looked broken - it just meant that for every guest racer:
--
--   * player_stats          rating, XP, races, wins, streaks  -> never saved
--   * player_map_records    personal best lap / race times    -> never saved
--   * race_history          per-race rows                     -> never saved
--   * player_achievements   unlocked achievements             -> never saved
--   * player_seasons        season rating / XP                -> never saved
--   * daily_competition     Daily Cup rows                    -> never saved
--   * weekly_competition    Founders Cup rows                 -> never saved
--   * player_wallet, player_inventory, player_equipped, coin_ledger,
--     season_rewards_claimed                                  -> never saved
--
-- and the matching SELECTs failed the same way, so the Global Rating board read
-- back an empty set and fell back to whatever was in server RAM - which is wiped on
-- every dyno restart or redeploy. That is why the board's numbers changed between
-- visits, why a racer's own rank could not be found, and why the Track Records,
-- Daily Cup and Founders Cup boards looked empty or stale.
--
-- v96 already did this for player_missions, weekly_bounties and player_badges -
-- the tables whose columns happened to be declared text. This file finishes the job
-- for the twelve that were declared uuid.
--
-- Trade-off, stated plainly: dropping the foreign key to auth.users means deleting
-- an auth account no longer cascades to these rows. Nothing in the game deletes an
-- account, and a guest key was never in auth.users to begin with, so the constraint
-- was only ever rejecting rows rather than protecting any.
--
-- Section 2 adds a name column to player_stats, daily_competition and
-- weekly_competition. All three boards used to take every racer's name from
-- profiles.username, and a guest has no profiles row - so the Global Rating board
-- rendered a page of racers all called "RACER" next to real ratings, and the Daily
-- and Founders Cups did the same. The server probes for these columns at boot and
-- only writes them once they exist, so applying this file is what makes names appear.
--
-- Section 3 recreates the two coin functions with a text racer id. They were
-- declared `p_uid uuid`, so awarding coins to a guest failed with the same 400 -
-- and because the caller treats a 400 as permanent, every guest race finished with
-- no coins and pushed a settle-warn to the results screen.
--
-- Section 4 is a note about two cup totals the server was overwriting rather than
-- accumulating; that half of the fix is in the application, not the schema.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. identity columns relaxed uuid -> text on the twelve competitive tables
-- ----------------------------------------------------------------------------
-- Postgres will not change a column's type underneath a policy that references it,
-- so the four policies comparing auth.uid() = user_id are dropped first and
-- recreated with an explicit cast afterwards. The remaining policies on these
-- tables use `using (true)` and are untouched.
drop policy if exists "history own read"        on public.race_history;
drop policy if exists "wallet own read"         on public.player_wallet;
drop policy if exists "inv own read"            on public.player_inventory;
drop policy if exists "season claim own read"   on public.season_rewards_claimed;

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

create policy "history own read" on public.race_history
  for select using (auth.uid()::text = user_id);

create policy "wallet own read" on public.player_wallet
  for select using (auth.uid()::text = user_id);

create policy "inv own read" on public.player_inventory
  for select using (auth.uid()::text = user_id);

create policy "season claim own read" on public.season_rewards_claimed
  for select using (auth.uid()::text = user_id);


-- ----------------------------------------------------------------------------
-- 2. names on the board rows — so a racer with no profiles row is not "RACER"
-- ----------------------------------------------------------------------------
-- All three boards took every name from profiles.username. A guest has no profiles
-- row, so the Global Rating board rendered a page of racers all called "RACER" next
-- to real ratings, and the Daily and Founders Cups did the same. The server probes
-- for these columns at boot and only writes them once they exist, so applying this
-- file is what makes the names appear.
alter table if exists public.player_stats
  add column if not exists name text not null default '';

alter table if exists public.daily_competition
  add column if not exists name text not null default '';

alter table if exists public.weekly_competition
  add column if not exists name text not null default '';

-- The board sorts by rating and then breaks ties on wins; v96's setup already
-- carries idx_stats_competitive (rating desc, wins desc, races asc) which covers it.


-- ----------------------------------------------------------------------------
-- 3. coin functions — the same uuid assumption, in plpgsql
-- ----------------------------------------------------------------------------
-- earn_coins is called once per finisher per race with the identity settlement
-- uses. With p_uid uuid, a guest's device pid was rejected outright; the server
-- reads a 400 as a permanent validation failure, so the coins were never awarded
-- and the results screen was told the settlement had failed.
--
-- The uuid overload is dropped rather than left alongside the new one, so there is
-- exactly one function and no overload resolution to reason about. Bodies are
-- unchanged apart from the parameter type.
drop function if exists public.earn_coins(uuid, bigint, text, text);

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

drop function if exists public.spend_coins(uuid, bigint, text);

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


-- ----------------------------------------------------------------------------
-- 4. verify
-- ----------------------------------------------------------------------------
-- After running this, these should both come back clean:
--
--   select table_name, data_type from information_schema.columns
--    where table_schema = 'public' and column_name = 'user_id'
--      and table_name in ('player_stats','player_map_records','race_history',
--                         'player_achievements','player_seasons','daily_competition',
--                         'weekly_competition')
--    order by table_name;
--   -- every row should say data_type = text
--
--   select table_name from information_schema.columns
--    where table_schema='public' and column_name='name'
--      and table_name in ('player_stats','daily_competition','weekly_competition')
--    order by table_name;
--   -- should list all three
--
-- Or skip the SQL and read the running server instead:
--
--   curl -s https://<your-app>/health | python3 -m json.tool
--
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in ('earn_coins','spend_coins');
--   -- both should now take p_uid text, and there should be one of each
--
-- persistence.playerStatsKeyType should read "text", persistence.playerStatsHasName
-- and persistence.compHasName should both be true. While keyType says "uuid" the
-- boards are still discarding every guest's results.
--
-- The application half of this fix (build v97) also stops the two cup writes from
-- overwriting their own totals: a Daily Cup row used to be replaced by the latest
-- race's lap instead of keeping the day's fastest, and a Founders Cup row was
-- replaced by the latest race's points instead of the week's accumulated score.
-- Both are now read back, merged and written as running totals.
-- ============================================================================
