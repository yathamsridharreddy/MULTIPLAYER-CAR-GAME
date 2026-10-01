-- ============================================================================
-- SRIDHAR RUSH - v158 migration: DELETING A USER REALLY DELETES THE USER
-- ============================================================================
-- Run this ONCE, in the Supabase SQL Editor. It is idempotent and defensive:
-- every statement checks what exists before touching it, so it converges from
-- any shape of the database and can be re-run safely.
--
-- WHY IT EXISTS
-- -------------
-- Deleting a racer in Supabase (Authentication -> Users -> Delete) removed the
-- auth row and NOTHING ELSE. Their rating, XP, lap records, race history,
-- achievements, coins, missions, bounties, badges, daily and weekly cup rows,
-- the club roster row that carried their name and kilometres, their ghost laps
-- and their leaderboard times all stayed behind - orphaned, unreachable, and
-- still counting towards their old club's weekly total. The next time a stale
-- server copy of their stats was flushed, some of it came back.
--
-- That is not an accident of the code, it is a consequence of a deliberate
-- earlier decision: v97/v98/v99 dropped every foreign key to auth.users, because
-- the identity columns are text and hold GUEST keys (a device pid or a display
-- name) as well as account uuids. A guest key is not in auth.users, so the
-- constraint only ever rejected rows - but it also meant the database had
-- nothing to cascade with.
--
-- This migration gives the database the purge it should always have had:
--
--   1. sr_purge_identity(keys, names) - erase rows across EVERY table the game
--      writes, matching any of the account's identities, and repair the clubs
--      that depended on them (totals no longer count a deleted member, an
--      orphaned club is removed, leadership passes to whoever is left).
--   2. a trigger on auth.users AFTER DELETE that calls it - so deleting the
--      user in the dashboard is the whole operation.
--   3. sr_purge_orphans() - a one-time sweep for accounts that were already
--      deleted before this migration existed. Their rows are removed too.
--   4. a tombstone table the game server reads, so its in-memory copies are
--      dropped as well and cannot re-create what the database just deleted.
--
-- WHAT IT DOES NOT DO
-- -------------------
-- It does not touch other accounts, and it does not delete a club that still
-- has members. A shared ghost lap carrying a name but no owner key can only be
-- matched by that name - the trade-off is stated where it happens, in section 3.
-- ============================================================================


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


-- ----------------------------------------------------------------------------
-- 6. the sweep, once, as part of this migration
-- ----------------------------------------------------------------------------
-- Delete an account in the dashboard today and the trigger handles it. This call
-- is for the accounts already deleted before today.

select public.sr_purge_orphans() as orphans_removed;

-- Optional, and safe to run any time - it reports what a purge WOULD remove
-- without deleting anything:
--
--   select public.sr_purge_identity(array['<uuid>'], array['<display name>']);
--
-- Run it for real by moving the same call into an RPC from the game server, or
-- simply delete the user in Authentication -> Users: the trigger calls it.
