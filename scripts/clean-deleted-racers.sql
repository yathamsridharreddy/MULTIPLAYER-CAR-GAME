-- ============================================================================
--  SRIDHAR RUSH - clean up racers that were deleted BEFORE the purge trigger
--  existed, and report what you have left.  (v158.3)
--
--  HOW TO USE
--    Supabase dashboard -> SQL Editor -> New query -> paste this WHOLE file ->
--    Run. The last statement prints one JSON report. That is it.
--
--  WHAT IT DOES
--    The v158 trigger purges an account the moment you delete it in
--    Authentication -> Users. Accounts you deleted BEFORE that trigger was
--    installed never fired it, so their rows are still there - a member slot in
--    a club that shows a name nobody owns, stats nobody reads, a ghost nobody
--    can race. This finds those accounts (a key that IS an account uuid with no
--    row in auth.users) and erases every row of them with the same purger the
--    trigger uses, repairing the clubs they were in.
--
--    The running game server learns about each erase through the tombstone
--    table within a minute and drops the racer from its memory, so a deleted
--    member leaves the club roster without a restart or a redeploy.
--
--  WHAT IT NEVER TOUCHES
--    - accounts that still exist (nothing of a living racer is ever removed)
--    - guest device identities and display names that were never accounts
--    - the five built-in clubs
--    - a club that merely has no members, unless this cleanup emptied it
--
--  SAFEGUARD
--    It refuses to start on a database that still carries the FIRST v158
--    sr_purge_identity - the one whose club delete was not scoped and deleted
--    clubs that merely happened to be empty. If you get that error, run the
--    updated supabase-migration-v158.sql once, then run this again.
--
--  WANT A PREVIEW FIRST?  Run this instead of the last line - it reports what
--  the cleanup WOULD remove and changes nothing:
--
--    select public.sr_cleanup_deleted_racers(true);
-- ============================================================================


create or replace function public.sr_cleanup_deleted_racers(p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uuid_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_src     text;
  v_keys    text[] := array[]::text[];
  v_more    text[];
  v_dead    text[] := array[]::text[];
  v_names   text[] := array[]::text[];
  v_trigger boolean := false;
  v_out     jsonb := '{}'::jsonb;
  v_roster  jsonb := '[]'::jsonb;
  v_fixed   bigint := 0;
begin
  -- ---- 0. refuse to run next to the old, club-deleting purger --------------
  select p.prosrc into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sr_purge_identity'
   limit 1;

  if v_src is null then
    raise exception 'sr_purge_identity is not installed here. Run supabase-migration-v158.sql first. Nothing was changed.';
  end if;
  if position('c.id = any($1)' in v_src) = 0 then
    raise exception 'This database still has the FIRST v158 purge - the one that deleted clubs. Run the updated supabase-migration-v158.sql, then run this file again. Nothing was changed.';
  end if;

  select exists (
           select 1 from pg_trigger t
             join pg_class c on c.oid = t.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
            where t.tgname = 'sr_purge_on_auth_delete'
              and n.nspname = 'auth' and not t.tgisinternal
         ) into v_trigger;

  -- ---- 1. every account-shaped key the game wrote down ---------------------
  -- Only uuids are candidates: that is the shape of a Supabase account id, and
  -- only an account can be deleted there. A device pid or a display name was
  -- never an account, so it is never swept by this.
  if to_regclass('public.crew_members') is not null then
    execute format($sql$
      select coalesce(array_agg(distinct k), '{}') from (
        select regexp_replace(lower(btrim(m.member_key)), '^sb:', '') as k
          from public.crew_members m
        union all
        select regexp_replace(lower(btrim(a)), '^sb:', '')
          from public.crew_members m, unnest(coalesce(m.aliases, '{}')) as a
      ) s where k ~ %L
    $sql$, v_uuid_re) into v_more;
    v_keys := v_keys || coalesce(v_more, '{}');
  end if;

  if to_regclass('public.player_stats') is not null then
    execute format($sql$
      select coalesce(array_agg(distinct regexp_replace(lower(btrim(s.user_id)), '^sb:', '')), '{}')
        from public.player_stats s
       where regexp_replace(lower(btrim(s.user_id)), '^sb:', '') ~ %L
    $sql$, v_uuid_re) into v_more;
    v_keys := v_keys || coalesce(v_more, '{}');
  end if;

  if to_regclass('public.profiles') is not null then
    execute format($sql$
      select coalesce(array_agg(distinct lower(p.id::text)), '{}')
        from public.profiles p where lower(p.id::text) ~ %L
    $sql$, v_uuid_re) into v_more;
    v_keys := v_keys || coalesce(v_more, '{}');
  end if;

  if to_regclass('public.ghosts') is not null then
    execute format($sql$
      select coalesce(array_agg(distinct regexp_replace(lower(btrim(g.owner_key)), '^sb:', '')), '{}')
        from public.ghosts g
       where g.owner_key is not null
         and regexp_replace(lower(btrim(g.owner_key)), '^sb:', '') ~ %L
    $sql$, v_uuid_re) into v_more;
    v_keys := v_keys || coalesce(v_more, '{}');
  end if;

  if to_regclass('public.leaderboard') is not null then
    execute format($sql$
      select coalesce(array_agg(distinct regexp_replace(lower(btrim(l.pid)), '^sb:', '')), '{}')
        from public.leaderboard l
       where l.pid is not null
         and regexp_replace(lower(btrim(l.pid)), '^sb:', '') ~ %L
    $sql$, v_uuid_re) into v_more;
    v_keys := v_keys || coalesce(v_more, '{}');
  end if;

  -- ---- 2. keep only the ones that no longer answer to an account -----------
  select coalesce(array_agg(distinct k), '{}') into v_dead
    from unnest(v_keys) as k
   where not exists (select 1 from auth.users u where u.id::text = k);

  if v_dead = '{}' then
    return jsonb_build_object(
      'dry_run', p_dry_run,
      'deleted_accounts_found', 0,
      'message', 'Nothing to clean: every account-shaped key in the game tables still has an account. If a club still shows somebody you deleted, that member is not keyed by an account - see the manual block at the bottom of this file.',
      'purge_trigger_installed', v_trigger,
      'removed', '{}'::jsonb
    );
  end if;

  -- ---- 3. the display names those accounts raced under --------------------
  -- The purger uses them only where a table has a name and no identity column,
  -- and it never lets a name claim a row whose key answers to a living account.
  if to_regclass('public.player_stats') is not null then
    execute $sql$
      select coalesce(array_agg(distinct s.name), '{}') from public.player_stats s
       where regexp_replace(lower(btrim(s.user_id)), '^sb:', '') = any($1) and nullif(btrim(s.name), '') is not null
    $sql$ into v_more using v_dead;
    v_names := v_names || coalesce(v_more, '{}');
  end if;

  if to_regclass('public.profiles') is not null then
    execute $sql$
      select coalesce(array_agg(distinct p.username), '{}') from public.profiles p
       where lower(p.id::text) = any($1) and nullif(btrim(p.username), '') is not null
    $sql$ into v_more using v_dead;
    v_names := v_names || coalesce(v_more, '{}');
  end if;

  if to_regclass('public.crew_members') is not null then
    execute $sql$
      select coalesce(array_agg(distinct m.name), '{}') from public.crew_members m
       where regexp_replace(lower(btrim(m.member_key)), '^sb:', '') = any($1) and nullif(btrim(m.name), '') is not null
    $sql$ into v_more using v_dead;
    v_names := v_names || coalesce(v_more, '{}');
  end if;

  -- ---- 4. the preview -----------------------------------------------------
  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true,
      'deleted_accounts_found', coalesce(array_length(v_dead, 1), 0),
      'keys', to_jsonb(v_dead),
      'names', to_jsonb(v_names),
      'purge_trigger_installed', v_trigger,
      'removed', '{}'::jsonb
    );
  end if;

  -- ---- 5. the erase -------------------------------------------------------
  -- Exactly the purger the v158 trigger calls: every table, the club totals and
  -- the club itself, plus the tombstone the running game server sweeps against.
  v_out := public.sr_purge_identity(v_dead, v_names);

  -- ---- 5b. clubs still pointing at a leader nobody owns -------------------
  -- The purger hands leadership on when it removes the leader's roster row. A
  -- club can still name a leader whose row was never written, or was lost
  -- before this cleanup existed - a leftover of a deleted racer all the same.
  -- Repaired with the same rule the purger uses: leadership passes to the
  -- member who has been there longest.
  if to_regclass('public.crews') is not null and to_regclass('public.crew_members') is not null then
    update public.crews c
       set leader_uid = (
         select m.member_key from public.crew_members m
          where m.crew_id = c.id
          order by m.joined_at asc, m.member_key asc
          limit 1
       )
     where c.leader_uid is not null
       and not exists (select 1 from public.crew_members m
                        where m.crew_id = c.id and m.member_key = c.leader_uid)
       and exists (select 1 from public.crew_members m where m.crew_id = c.id);
    get diagnostics v_fixed = row_count;
    if v_fixed > 0 then
      v_out := v_out || jsonb_build_object('crews.leader_repaired', v_fixed);
    end if;
  end if;

  -- ---- 6. what is left ----------------------------------------------------
  if to_regclass('public.crews') is not null and to_regclass('public.crew_members') is not null then
    execute $sql$
      select coalesce(jsonb_agg(x order by x->>'club'), '[]'::jsonb) from (
        select jsonb_build_object(
                 'club', c.name,
                 'id', c.id,
                 'built_in', coalesce(c.seeded, false),
                 'km_this_week', round((coalesce(c.weekly_meters, 0) / 1000.0)::numeric, 1),
                 'km_lifetime', round((coalesce(c.total_meters, 0) / 1000.0)::numeric, 1),
                 'members', coalesce((
                   select jsonb_agg(jsonb_build_object('name', m.name, 'role', m.role, 'key', m.member_key)
                                    order by m.role desc, m.name)
                     from public.crew_members m where m.crew_id = c.id), '[]'::jsonb)
               ) as x
          from public.crews c
      ) s
    $sql$ into v_roster;
  end if;

  return jsonb_build_object(
    'dry_run', false,
    'deleted_accounts_found', coalesce(array_length(v_dead, 1), 0),
    'keys', to_jsonb(v_dead),
    'names', to_jsonb(v_names),
    'removed', v_out,
    'purge_trigger_installed', v_trigger,
    'message', case when v_trigger then 'Done. Deleting a user in Authentication -> Users now erases them completely, and this file is only needed for accounts deleted before that trigger existed.'
                    else 'Done - but the v158 trigger is NOT installed on auth.users, so future deletions will leave rows behind. Run the updated supabase-migration-v158.sql.'
               end,
    'clubs_after', v_roster
  );
end $$;

comment on function public.sr_cleanup_deleted_racers(boolean) is
  'v158.3: erases accounts that were deleted before the purge trigger existed; reports the clubs that are left.';

-- reachable with the service role only, same as every other purge entry point
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.sr_cleanup_deleted_racers(boolean) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.sr_cleanup_deleted_racers(boolean) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sr_cleanup_deleted_racers(boolean) to service_role';
  end if;
end $$;


-- ============================================================================
--  RUN IT
-- ============================================================================
select public.sr_cleanup_deleted_racers() as cleanup_report;

-- ============================================================================
--  OPTIONAL - remove one person you can still see, by name
-- ============================================================================
-- The cleanup above only removes rows that belong to a deleted ACCOUNT. If a
-- club still shows a name after that, the row is keyed by a device identity
-- (a guest that never signed in) or by a display name, and only you can say
-- whether it should go. Put the club id and the exact name from the roster in
-- the two lines below, remove the two leading dashes, and run them:
--
-- begin;
--   update public.crews c
--      set weekly_meters = greatest(0, c.weekly_meters - m.weekly_meters),
--          total_meters  = greatest(0, c.total_meters  - m.total_meters),
--          weekly_points = greatest(0, c.weekly_points - m.weekly_points)
--     from public.crew_members m
--    where m.crew_id = '<CLUB ID>' and m.name = '<NAME ON THE ROSTER>' and c.id = m.crew_id;
--   delete from public.crew_members where crew_id = '<CLUB ID>' and name = '<NAME ON THE ROSTER>';
-- commit;
--
-- ============================================================================
--  OPTIONAL - start the clubs from zero (this deletes your club history)
-- ============================================================================
-- Only if you want the old club data gone for good: every membership, every
-- club anybody made, and every counter on the five built-in clubs. The built-in
-- clubs stay (they are seeded), with nobody in them and nothing on the board.
-- Remove the leading dashes on each line and run:
--
-- begin;
--   delete from public.crew_milestone_claims;
--   delete from public.crew_members;
--   delete from public.crews where coalesce(seeded, false) = false;
--   update public.crews set weekly_meters = 0, total_meters = 0, weekly_points = 0,
--                           leader_uid = null, week_key = to_char(now(), 'IYYY-"W"IW');
-- commit;
