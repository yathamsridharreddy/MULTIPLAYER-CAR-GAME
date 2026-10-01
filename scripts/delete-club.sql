-- ============================================================================
--  SRIDHAR RUSH - delete a club.  (v158.8)
--
--  WHEN TO USE THIS
--    The leader can delete their own club from inside the game (OPEN CLUB ->
--    MY CLUB -> DELETE THIS CLUB). This file is the way to delete a club when
--    there is nobody left who can press that button: the leader's account was
--    deleted, the club was founded by an account that is gone, or it is a test
--    club that was never finished.
--
--  HOW TO USE (Supabase dashboard -> SQL Editor -> New query)
--    1. Paste this WHOLE file and Run. It only creates the function.
--    2. Look first - nothing is changed by this line:
--
--         select public.sr_delete_club('B.Tech Badithulu', true);
--
--       Pass the club as its NAME or its ID (the tag in lowercase, e.g. 'bhai').
--       The report shows the club's tag, who leads it and every racer who will be
--       removed from it.
--    3. Delete - leave the `true` off:
--
--         select public.sr_delete_club('B.Tech Badithulu');
--
--  WHAT IT DOES
--    - deletes exactly three things, all of them the club's own: the club row,
--      its roster rows (crew_members) and its weekly milestone claims
--      (crew_milestone_claims)
--    - reports what it deleted, so the result is never a guess
--    - refuses a name that matches more than one club instead of picking one
--
--  WHAT IT DOES NOT DO
--    - it never touches a racer's own data: stats, wallet, garage, badges, race
--      history and leaderboard times belong to the racer, not to the club, and
--      they stay exactly as they are
--    - it never touches another club
--    - it writes no tombstone and erases no account
--
--  SAFEGUARDS
--    - the built-in clubs (Redline Motorsport, Akina SpeedStars, Midnight Club
--      Tokyo, Veloce Grand Prix, Monza Oversteer Works) are refused: they are
--      the game's own content
--    - service role only, like every other club write path
--
--  AFTERWARDS
--    The in-game button removes the club from the running server immediately.
--    A delete done HERE is a database change only: a game server that already
--    has the club loaded keeps showing it until it restarts (Render -> Manual
--    Deploy -> Restart, or the next deploy) because there is no row left for it
--    to notice. The rows are gone either way - nobody can join it again once the
--    server restarts, and the club is not in the database.
-- ============================================================================


create or replace function public.sr_delete_club(
  p_club    text,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id       text;
  v_club     jsonb;
  v_members  jsonb;
  v_count    int := 0;
  v_claims   int := 0;
  v_roster   int := 0;
  v_rows     int := 0;
  v_deleted  int := 0;
begin
  if nullif(btrim(coalesce(p_club, '')), '') is null then
    raise exception 'Call it with the club (name or id): select public.sr_delete_club(''B.Tech Badithulu'', true);';
  end if;

  -- ---- 1. find the club: by id first, then by name ------------------------
  -- A name is only accepted when it is unambiguous. Two clubs can share a name
  -- (only the tag is unique), and deleting the wrong roster is not a mistake
  -- this file is allowed to make.
  select c.id into v_id
    from public.crews c
   where lower(btrim(c.id)) = lower(btrim(p_club))
   order by c.id
   limit 1;

  if v_id is null then
    select count(*) into v_rows
      from public.crews c
     where lower(btrim(c.name)) = lower(btrim(p_club));
    if v_rows > 1 then
      return jsonb_build_object(
        'ok', false,
        'error', 'ambiguous_name',
        'message', 'More than one club has that name. Call it again with the club id (the tag in lowercase).',
        'clubs', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'tag', c.tag, 'name', c.name, 'built_in', coalesce(c.seeded, false)) order by c.id), '[]'::jsonb)
                    from public.crews c where lower(btrim(c.name)) = lower(btrim(p_club)))
      );
    end if;
    select c.id into v_id
      from public.crews c
     where lower(btrim(c.name)) = lower(btrim(p_club))
     limit 1;
  end if;

  if v_id is null then
    -- unknown club: show what exists, so the next call can name it exactly
    return jsonb_build_object(
      'ok', false,
      'error', 'club_not_found',
      'message', 'No club has that name or id. The clubs below are all of them - call it again with one of these names or ids.',
      'clubs', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'tag', c.tag, 'name', c.name, 'built_in', coalesce(c.seeded, false)) order by c.name), '[]'::jsonb)
                  from public.crews c)
    );
  end if;

  if coalesce((select c.seeded from public.crews c where c.id = v_id), false) then
    return jsonb_build_object(
      'ok', false,
      'error', 'built_in_club',
      'club_id', v_id,
      'message', 'That is one of the game''s own clubs. It cannot be deleted - nothing was changed.'
    );
  end if;

  -- what is about to go, in words, before anything does
  select jsonb_build_object('id', c.id, 'tag', c.tag, 'name', c.name, 'motto', c.motto,
                            'leader_uid', c.leader_uid, 'seeded', coalesce(c.seeded, false))
    into v_club
    from public.crews c where c.id = v_id;

  if to_regclass('public.crew_members') is not null then
    select coalesce(jsonb_agg(jsonb_build_object('name', m.name, 'key', m.member_key, 'role', m.role) order by m.role desc, m.member_key), '[]'::jsonb),
           count(*)::int
      into v_members, v_roster
      from public.crew_members m where m.crew_id = v_id;
  else
    v_members := '[]'::jsonb;
  end if;

  if to_regclass('public.crew_milestone_claims') is not null then
    select count(*)::int into v_claims from public.crew_milestone_claims where crew_id = v_id;
  end if;

  -- ---- 2. the dry run stops here -----------------------------------------
  if p_dry_run then
    return jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'club_id', v_id,
      'club', v_club,
      'members', v_members,
      'member_count', v_roster,
      'claim_count', v_claims,
      'message', 'Nothing was changed. Run the same call without the true to delete the club, its roster and its claims.'
    );
  end if;

  -- ---- 3. apply -----------------------------------------------------------
  -- The claims table has no foreign key to the club, so it is deleted first.
  -- The roster cascades from the club row, and is deleted explicitly as well so
  -- a database without that cascade still loses nothing but the club.
  if to_regclass('public.crew_milestone_claims') is not null then
    delete from public.crew_milestone_claims where crew_id = v_id;
    get diagnostics v_deleted = row_count;
    v_claims := greatest(v_claims, v_deleted);
  end if;

  if to_regclass('public.crew_members') is not null then
    delete from public.crew_members where crew_id = v_id;
  end if;

  delete from public.crews c where c.id = v_id;

  return jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'club_id', v_id,
    'club', v_club,
    'members', v_members,
    'member_count', v_roster,
    'claim_count', v_claims,
    'message', 'Deleted. The club row, its ' || v_roster || ' roster row(s) and its ' || v_claims || ' claim row(s) are gone; no racer''s own data was touched. A running game server keeps a club it has already loaded until it restarts.'
  );
end $$;

comment on function public.sr_delete_club(text, boolean) is
  'v158.8: deletes one club with its roster rows and milestone claims, refusing names that match more than one club and the game''s built-in clubs. Never touches racer data or any other club.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.sr_delete_club(text, boolean) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.sr_delete_club(text, boolean) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sr_delete_club(text, boolean) to service_role';
  end if;
end $$;


-- ============================================================================
--  STEP 2 - LOOK (nothing is changed)
-- ============================================================================
-- select public.sr_delete_club('B.Tech Badithulu', true);

-- ============================================================================
--  STEP 3 - DELETE
-- ============================================================================
-- select public.sr_delete_club('B.Tech Badithulu');

-- ============================================================================
--  IF YOU DO NOT KNOW THE CLUB'S EXACT NAME
-- ============================================================================
-- select id, tag, name, seeded from public.crews order by seeded desc, name;
