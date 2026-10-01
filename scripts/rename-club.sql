-- ============================================================================
--  SRIDHAR RUSH - rename a club (name, tag, motto, badge, colour).  (v158.6)
--
--  WHEN TO USE THIS
--    A club was created with wording that is not what the racer meant - a
--    name that came through with extra text in front of it, a typo, a tag that
--    reads wrong. There is no rename button in the game, so this is the rename.
--
--  HOW TO USE (Supabase dashboard -> SQL Editor -> New query)
--    1. Paste this WHOLE file and Run - every line, from the first one to the
--       last comment. That is what creates the function. Nothing else happens:
--       no club is looked at and nothing is changed. Running only a call further
--       down answers with
--           ERROR: 42883: function public.sr_rename_club(...) does not exist
--       and that just means the file has not been run yet. (In the Supabase SQL
--       Editor, if any text is highlighted, Run executes ONLY the highlighted
--       text - click in the editor and press Ctrl+A before you paste.)
--    2. Look first - nothing is changed by this line:
--
--         select public.sr_rename_club('racing-c B.Tech Badithulu', 'B.Tech Badithulu', true);
--
--       Pass the club as its NAME or its ID (the tag in lowercase, e.g. 'bhai'),
--       and the new name. Everything else is left exactly as it is.
--    3. Rename - leave the `true` off:
--
--         select public.sr_rename_club('racing-c B.Tech Badithulu', 'B.Tech Badithulu');
--
--  CHANGING MORE THAN THE NAME
--    The same call takes any of the other wording fields, as named arguments:
--
--      select public.sr_rename_club('bhai', 'B.Tech Badithulu',
--                                   p_tag => 'BTEC', p_motto => 'Code by day, race by night',
--                                   p_badge => 'racing-car', p_color => '#00d0ff');
--
--  WHAT IT DOES
--    - writes the new wording to the club row, and nothing else: no member, no
--      kilometre and no point is touched
--    - validates the name and tag with the SAME rules the game uses, so a club
--      can never be renamed into something the create form would reject
--    - refuses a tag another club already uses (the game identifies a club by it)
--    - lets the RUNNING game server pick the change up by itself: the update
--      bumps crews.updated_at, which the server polls, so the board and the club
--      page show the new name within seconds - no restart, no redeploy
--    - reports the before and after wording, so a rename is never a guess
--
--  SAFEGUARDS
--    - the built-in clubs (Redline Motorsport, Akina SpeedStars, Midnight Club
--      Tokyo, Veloce Grand Prix, Monza Oversteer Works) and their tags are
--      refused: they are the game's own, and the server keeps their wording
--    - nothing is deleted by this file, ever
--    - service role only, like every other club write path
-- ============================================================================


-- ----------------------------------------------------------------------------
--  The one thing this file needs in the database: a note of WHEN a club's
--  wording last changed, so a running game server can notice a rename without
--  being restarted. This is the same schema change supabase-migration-v158.sql
--  applies (its section 1b) - kept here so this file works on its own.
-- ----------------------------------------------------------------------------

alter table if exists public.crews
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.sr_crews_touch()
returns trigger
language plpgsql
as $$
begin
  -- ONLY wording counts. If a counter moving bumped this, every settlement
  -- would make the game server re-read every club.
  if new.name is distinct from old.name
     or new.tag is distinct from old.tag
     or new.motto is distinct from old.motto
     or new.badge is distinct from old.badge
     or new.color is distinct from old.color then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;

drop trigger if exists sr_crews_touch on public.crews;
create trigger sr_crews_touch
  before update on public.crews
  for each row execute function public.sr_crews_touch();


create or replace function public.sr_rename_club(
  p_club  text,
  p_name  text default null,
  p_dry_run boolean default false,
  p_tag   text default null,
  p_motto text default null,
  p_badge text default null,
  p_color text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id      text;
  v_before  jsonb;
  v_tag     text;
  v_name    text;
  v_motto   text;
  v_badge   text;
  v_color   text;
  v_taken   text;
  v_after   jsonb;
begin
  if nullif(btrim(coalesce(p_club, '')), '') is null then
    raise exception 'Call it with the club (name or id) and the new name: select public.sr_rename_club(''racing-c B.Tech Badithulu'', ''B.Tech Badithulu'');';
  end if;

  -- ---- 1. find the club: by id first, then by name ------------------------
  select c.id into v_id
    from public.crews c
   where lower(btrim(c.id)) = lower(btrim(p_club))
      or lower(btrim(c.name)) = lower(btrim(p_club))
   order by (lower(btrim(c.id)) = lower(btrim(p_club))) desc, c.id
   limit 1;

  if v_id is null then
    -- unknown club: show what exists, so the next call can name it exactly
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'tag', c.tag, 'name', c.name, 'built_in', coalesce(c.seeded, false)) order by c.name), '[]'::jsonb)
      into v_before from public.crews c;
    return jsonb_build_object(
      'ok', false,
      'error', 'club_not_found',
      'message', 'No club has that name or id. The clubs below are all of them - call it again with one of these names or ids.',
      'clubs', v_before
    );
  end if;

  if coalesce((select c.seeded from public.crews c where c.id = v_id), false) then
    return jsonb_build_object(
      'ok', false,
      'error', 'built_in_club',
      'club_id', v_id,
      'message', 'That is one of the game''s own clubs, and its wording belongs to the game. Nothing was changed.'
    );
  end if;

  select jsonb_build_object('id', c.id, 'tag', c.tag, 'name', c.name, 'motto', c.motto,
                            'badge', c.badge, 'color', c.color)
    into v_before
    from public.crews c where c.id = v_id;

  -- ---- 2. work out the new wording ----------------------------------------
  v_name  := case when p_name  is null then v_before->>'name'  else regexp_replace(btrim(p_name), '\s+', ' ', 'g') end;
  v_tag   := case when p_tag   is null then v_before->>'tag'   else upper(btrim(p_tag)) end;
  v_motto := case when p_motto is null then v_before->>'motto' else btrim(p_motto) end;
  v_badge := case when p_badge is null then v_before->>'badge' else btrim(p_badge) end;
  v_color := case when p_color is null then v_before->>'color' else btrim(p_color) end;

  if v_motto is not null and v_motto = '' then v_motto := null; end if;
  if v_name = v_before->>'name' and v_tag = v_before->>'tag' and v_motto is not distinct from (v_before->>'motto')
     and v_badge is not distinct from (v_before->>'badge') and v_color is not distinct from (v_before->>'color') then
    return jsonb_build_object(
      'ok', false,
      'error', 'nothing_to_change',
      'club_id', v_id,
      'club', v_before,
      'message', 'That is already the club''s wording. Nothing was changed.'
    );
  end if;

  -- ---- 3. the same rules the game applies ---------------------------------
  -- 3-32 characters, letters/numbers/spaces and the punctuation the create form
  -- allows; no angle brackets or control characters (names are rendered as text)
  if length(v_name) < 3 or length(v_name) > 32 then
    return jsonb_build_object('ok', false, 'error', 'invalid_crew_name',
      'message', 'A club name is 3-32 characters. Nothing was changed.');
  end if;
  -- the classes are Postgres' own: \p{L} is a JavaScript regex, this is ARE
  if v_name ~ '[<>[:cntrl:]]' or v_name !~ '^[[:alnum:][:space:]_''.!&#+-]{3,32}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_crew_name',
      'message', 'A club name may use letters, numbers, spaces and . ! & # + _ - ''. Nothing was changed.',
      'name', v_name);
  end if;
  if v_tag !~ '^[A-Z0-9]{2,5}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_crew_tag',
      'message', 'A club tag is 2-5 letters or numbers (e.g. APEX, F1, SPEED). Nothing was changed.', 'tag', v_tag);
  end if;

  -- the tag is how the game tells clubs apart, so it must stay unique. Case is
  -- ignored on purpose: two clubs called [BHAI] and [bhai] would be one club.
  select c.name into v_taken
    from public.crews c
   where upper(c.tag) = v_tag and c.id <> v_id
   limit 1;
  if v_taken is not null then
    return jsonb_build_object('ok', false, 'error', 'tag_taken', 'tag', v_tag,
      'message', 'The tag [' || v_tag || '] is already used by ' || v_taken || '. Pick another one. Nothing was changed.');
  end if;

  -- ---- 4. the dry run stops here ------------------------------------------
  if p_dry_run then
    return jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'club_id', v_id,
      'before', v_before,
      'after', jsonb_build_object('tag', v_tag, 'name', v_name, 'motto', v_motto, 'badge', v_badge, 'color', v_color),
      'message', 'Nothing was changed. Run the same call without the true to apply it.'
    );
  end if;

  -- ---- 5. apply -----------------------------------------------------------
  -- only the wording columns: not one member, kilometre or point is touched.
  -- The sr_crews_touch trigger sees the wording change and bumps updated_at,
  -- which is what the running server polls - so the new name appears within
  -- seconds on the board and on the club page.
  update public.crews c
     set name = v_name, tag = v_tag, motto = v_motto, badge = v_badge, color = v_color
   where c.id = v_id;

  select jsonb_build_object('id', c.id, 'tag', c.tag, 'name', c.name, 'motto', c.motto,
                            'badge', c.badge, 'color', c.color)
    into v_after
    from public.crews c where c.id = v_id;

  return jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'club_id', v_id,
    'before', v_before,
    'after', v_after,
    'message', 'Renamed. The board and the club page pick it up by themselves within a few seconds - refresh to see it. Nothing else about the club changed.'
  );
end $$;

comment on function public.sr_rename_club(text, text, boolean, text, text, text, text) is
  'v158.6: renames a club (name, and optionally tag/motto/badge/colour) with the game''s own validation, bumping crews.updated_at so a running server picks it up. Never touches members or counters; never deletes anything.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.sr_rename_club(text, text, boolean, text, text, text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.sr_rename_club(text, text, boolean, text, text, text, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sr_rename_club(text, text, boolean, text, text, text, text) to service_role';
  end if;
end $$;


-- ============================================================================
--  IN ORDER
--    1. Run this WHOLE FILE once - the function above is created, nothing else
--       happens. If a call below answers with error 42883, the file has not
--       been run yet (or only one highlighted line was run).
--    2. LOOK with the `true` call below - nothing is changed by it.
--    3. RENAME with the same call, without the `true`.
-- ============================================================================

-- ============================================================================
--  STEP 2 - LOOK (nothing is changed)
-- ============================================================================
-- select public.sr_rename_club('racing-c B.Tech Badithulu', 'B.Tech Badithulu', true);

-- ============================================================================
--  STEP 3 - RENAME
-- ============================================================================
-- select public.sr_rename_club('racing-c B.Tech Badithulu', 'B.Tech Badithulu');

-- ============================================================================
--  IF YOU DO NOT KNOW THE CLUB'S EXACT NAME
-- ============================================================================
-- select id, tag, name, seeded from public.crews order by seeded desc, name;
