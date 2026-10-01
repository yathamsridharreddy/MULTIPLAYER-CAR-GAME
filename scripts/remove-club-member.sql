-- ============================================================================
--  SRIDHAR RUSH - remove ONE person you can still see in a club.  (v158.4)
--
--  WHEN TO USE THIS
--    A name is still on a club roster after the account was deleted. The purge
--    takes every row that CARRIES an account identity, but a roster row can be
--    keyed by a device instead of an account:
--
--      * the racer joined the club before signing in (a guest), or
--      * they joined as a guest on one device and signed in on another.
--
--    A guest row has no account on it at all, so deleting the account cannot
--    find it - and no automatic rule can prove the row is theirs. You can: you
--    are looking at the name. This removes exactly that row, and nothing else.
--
--  HOW TO USE (Supabase dashboard -> SQL Editor -> New query)
--    1. Paste this WHOLE file and Run. It only creates the function.
--    2. Look first - nothing is removed by this line:
--
--         select public.sr_remove_club_member('Midnight Club Tokyo', 'RACER-9WKP', true);
--
--       It answers with the row it found: the key it is stored under, its
--       aliases, its role and its kilometres, and what removing it would do.
--       Use the club's name or its id, and the name exactly as the roster
--       shows it (case does not matter).
--    3. Remove it - leave the `true` off:
--
--         select public.sr_remove_club_member('Midnight Club Tokyo', 'RACER-9WKP');
--
--  WHAT IT DOES
--    - deletes that roster row
--    - subtracts that member's kilometres and points from the club's totals
--      (never below zero), exactly the way a purge does
--    - hands the club's leadership to the member who has been there longest,
--      if the row removed was the leader and anybody is left
--    - records the row's identities in the tombstone table, so the RUNNING game
--      server drops the member from its memory within a minute - no restart
--    - never deletes the club itself, even if it ends up empty
--
--  SAFEGUARDS
--    - a row whose key (or alias) still answers to an account in auth.users is
--      REFUSED: that racer is alive, and the way to remove them is to delete
--      their account in Authentication -> Users. The dry run names the account.
--    - the built-in clubs are ordinary here: their rosters are edited exactly
--      like anybody else's, the club row itself is never touched
--    - the dry run is genuinely read-only
-- ============================================================================


create or replace function public.sr_remove_club_member(
  p_crew    text,
  p_name    text,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_crew   text;
  v_cname  text;
  v_is_seeded boolean := false;
  v_rows   jsonb := '[]'::jsonb;
  v_live   text[] := array[]::text[];
  v_keys   text[] := array[]::text[];
  v_names  text[] := array[]::text[];
  v_removed bigint := 0;
  v_fixed  bigint := 0;
  v_after  jsonb := '[]'::jsonb;
  v_wm     numeric := 0;
  v_tm     numeric := 0;
  v_wp     numeric := 0;
begin
  if nullif(btrim(coalesce(p_crew, '')), '') is null or nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'Call it with a club (id or name) and the name exactly as the roster shows it: select public.sr_remove_club_member(''Midnight Club Tokyo'', ''RACER-9WKP'');';
  end if;

  -- ---- 1. find the club: by id first, then by name ------------------------
  select c.id, c.name, coalesce(c.seeded, false)
    into v_crew, v_cname, v_is_seeded
    from public.crews c
   where lower(btrim(c.id)) = lower(btrim(p_crew))
      or lower(btrim(c.name)) = lower(btrim(p_crew))
   order by (lower(btrim(c.id)) = lower(btrim(p_crew))) desc, c.id
   limit 1;

  if v_crew is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'crew_not_found',
      'message', 'No club has that id or name. Open the club board and use the name it shows there.'
    );
  end if;

  -- ---- 2. the roster row(s) with that name --------------------------------
  select coalesce(jsonb_agg(distinct jsonb_build_object(
           'key', m.member_key,
           'name', m.name,
           'role', m.role,
           'aliases', to_jsonb(coalesce(m.aliases, '{}')),
           'km_this_week', round((coalesce(m.weekly_meters, 0) / 1000.0)::numeric, 2),
           'km_lifetime', round((coalesce(m.total_meters, 0) / 1000.0)::numeric, 2),
           'points', coalesce(m.weekly_points, 0),
           'joined_at', m.joined_at
         )), '[]'::jsonb),
         coalesce(array_agg(distinct m.member_key) filter (where m.member_key is not null), '{}'),
         coalesce(array_agg(distinct a) filter (where a is not null and a <> ''), '{}')
    into v_rows, v_keys, v_names
    from public.crew_members m
    left join lateral unnest(coalesce(m.aliases, '{}')) as a on true
   where m.crew_id = v_crew
     and lower(btrim(coalesce(m.name, ''))) = lower(btrim(p_name));

  if v_keys = '{}' then
    -- nothing under that name: list what the roster actually shows, so the
    -- next call can copy a name from here instead of guessing at it
    select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'role', x.role,
             'km_lifetime', round((coalesce(x.total_meters, 0) / 1000.0)::numeric, 1)) order by x.name), '[]'::jsonb)
      into v_after
      from public.crew_members x where x.crew_id = v_crew;
    return jsonb_build_object(
      'ok', false,
      'error', 'member_not_found',
      'club', v_cname,
      'message', 'Nobody on that roster is called ' || btrim(p_name) || '. The names below are exactly what the club shows - call it again with one of them.',
      'roster', v_after
    );
  end if;

  -- ---- 3. is any of it a LIVING racer? ------------------------------------
  -- Refuse: a row whose key still has an account is somebody's club
  -- membership, not a leftover. Their account is the thing to delete.
  select coalesce(array_agg(distinct u.id::text), '{}') into v_live
    from auth.users u
   where u.id::text = any(select regexp_replace(lower(k), '^sb:', '') from unnest(v_keys) as k)
      or ('sb:' || u.id::text) = any(select lower(k) from unnest(v_keys) as k);

  if v_live <> '{}' then
    return jsonb_build_object(
      'ok', false,
      'error', 'live_account',
      'club', v_cname,
      'rows', v_rows,
      'accounts', to_jsonb(v_live),
      'message', 'That row belongs to a racer whose account still exists, so it was left alone. To remove them, delete that account in Authentication -> Users: the v158 trigger takes the club row with it.'
    );
  end if;

  -- ---- 4. what would change (dry run stops here) --------------------------
  select coalesce(sum(m.weekly_meters), 0), coalesce(sum(m.total_meters), 0), coalesce(sum(m.weekly_points), 0)
    into v_wm, v_tm, v_wp
    from public.crew_members m
   where m.crew_id = v_crew
     and lower(btrim(coalesce(m.name, ''))) = lower(btrim(p_name));

  if p_dry_run then
    return jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'club', v_cname,
      'club_id', v_crew,
      'built_in', v_is_seeded,
      'rows', v_rows,
      'keys_to_tombstone', to_jsonb(v_keys),
      'club_loses', jsonb_build_object(
        'km_this_week', round((v_wm / 1000.0)::numeric, 2),
        'km_lifetime', round((v_tm / 1000.0)::numeric, 2),
        'points', v_wp
      ),
      'message', 'Nothing was changed. Run the same call without the true to remove this row, or without the row at all if it is not the person you meant.'
    );
  end if;

  -- ---- 5. remove the row --------------------------------------------------
  update public.crews c
     set weekly_meters = greatest(0, c.weekly_meters - x.wm),
         total_meters  = greatest(0, c.total_meters  - x.tm),
         weekly_points = greatest(0, c.weekly_points - x.wp)
    from (
      select sum(m.weekly_meters) as wm, sum(m.total_meters) as tm, sum(m.weekly_points) as wp
        from public.crew_members m
       where m.crew_id = v_crew
         and lower(btrim(coalesce(m.name, ''))) = lower(btrim(p_name))
    ) x
   where c.id = v_crew;

  delete from public.crew_members m
   where m.crew_id = v_crew
     and lower(btrim(coalesce(m.name, ''))) = lower(btrim(p_name));
  get diagnostics v_removed = row_count;

  -- leadership: never left pointing at a row that is no longer there
  update public.crews c
     set leader_uid = (
       select m.member_key from public.crew_members m
        where m.crew_id = c.id
        order by m.joined_at asc, m.member_key asc
        limit 1
     )
   where c.id = v_crew
     and not exists (select 1 from public.crew_members m
                      where m.crew_id = c.id and m.member_key = c.leader_uid)
     and exists (select 1 from public.crew_members m where m.crew_id = c.id);
  get diagnostics v_fixed = row_count;

  -- ---- 6. the tombstone: this is what reaches the RUNNING server ----------
  -- The club keeps this roster in memory; without a tombstone it would keep
  -- showing the name until the next restart. The server sweeps within a minute.
  -- Only the row's own keys are recorded - never the display name, which other
  -- racers may share.
  insert into public.sr_purged_players (key, names)
  select k, '{}'::text[]
    from unnest(v_keys) as k
   where nullif(btrim(k), '') is not null
  on conflict (key) do update set purged_at = now();

  -- ---- 7. what the club shows now ----------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'role', x.role,
           'km_lifetime', round((coalesce(x.total_meters, 0) / 1000.0)::numeric, 1)) order by x.name), '[]'::jsonb)
    into v_after
    from public.crew_members x where x.crew_id = v_crew;

  return jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'club', v_cname,
    'club_id', v_crew,
    'removed_rows', v_removed,
    'removed', v_rows,
    'tombstoned_keys', to_jsonb(v_keys),
    'leadership_repaired', v_fixed > 0,
    'roster', v_after,
    'message', 'Removed. The club itself is untouched. The running game server drops this member from memory within a minute (no restart); refresh the club page after that.'
  );
end $$;

comment on function public.sr_remove_club_member(text, text, boolean) is
  'v158.4: removes one member from one club by the name the roster shows, subtracts their contribution, tombstones their keys. Refuses rows that belong to a living account. The club itself is never deleted.';

-- service role only, like every other write path into the club tables
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.sr_remove_club_member(text, text, boolean) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.sr_remove_club_member(text, text, boolean) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sr_remove_club_member(text, text, boolean) to service_role';
  end if;
end $$;


-- ============================================================================
--  STEP 2 - LOOK (nothing is removed)
-- ============================================================================
-- select public.sr_remove_club_member('Midnight Club Tokyo', 'RACER-9WKP', true);

-- ============================================================================
--  STEP 3 - REMOVE
-- ============================================================================
-- select public.sr_remove_club_member('Midnight Club Tokyo', 'RACER-9WKP');

-- ============================================================================
--  IF YOU WANT TO SEE THE RAW ROW FIRST
-- ============================================================================
-- select m.crew_id, m.member_key, m.name, m.role, m.aliases,
--        m.weekly_meters, m.total_meters, m.weekly_points, m.joined_at
--   from public.crew_members m
--   join public.crews c on c.id = m.crew_id
--  where lower(c.name) = lower('Midnight Club Tokyo');
