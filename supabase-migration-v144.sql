-- ============================================================================
-- SRIDHAR RUSH - v144 migration: the driver name belongs to the ACCOUNT
-- ============================================================================
-- Run this ONCE, in the Supabase SQL Editor, AFTER supabase-migration-v99.sql.
-- Every statement is idempotent: running it twice, or on a database that
-- already has the column, changes nothing.
--
-- WHY IT EXISTS
-- -------------
-- The racer's driver name was only ever stored in the browser (localStorage),
-- and the account's own name lived in profiles.username - a UNIQUE handle that
-- must match ^[A-Za-z0-9_]{3,16}$. Two consequences:
--
--   * signing in on a second device showed that device's local placeholder
--     ("RACER1234") instead of the racer's name, until they typed one again;
--   * a name with a space could not be stored on the account at all, so it
--     stayed on one device while the account kept an underscored version.
--
-- profiles.display_name is what the player actually chose. It is NOT unique:
-- two racers may share a display name, exactly as they share a first name.
-- profiles.username keeps its job as the unique handle, so nothing that already
-- references a username (clubs, challenges, stats) changes meaning.
--
-- The client works WITHOUT this migration (it falls back to writing the handle,
-- which is what it did before), so the site never breaks on an unmigrated
-- database - it simply gains the proper name once this has been run.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'display_name'
  ) then
    alter table public.profiles add column display_name text;
    raise notice 'v144: added public.profiles.display_name';
  else
    raise notice 'v144: public.profiles.display_name already present - nothing to do';
  end if;

  -- the same shape the client enforces: 1..16 characters, no control characters
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_chk') then
    alter table public.profiles
      add constraint profiles_display_name_chk
      check (display_name is null
             or (char_length(display_name) between 1 and 16
                 and display_name !~ '[[:cntrl:]]'));
    raise notice 'v144: added profiles_display_name_chk';
  end if;
end $$;

-- Row level security already covers this: "profiles own u" allows a racer to
-- update their own row (using auth.uid() = id), and "profiles read" lets the
-- client read the name back at sign-in. No new policy is needed.

-- Backfill: every existing account keeps the name it has been racing under, so
-- nobody's name changes when this is run.
update public.profiles
   set display_name = username
 where display_name is null
   and username is not null
   and char_length(username) between 1 and 16;

-- ============================================================================
-- Verification
-- ============================================================================
--   select id, username, display_name from public.profiles limit 5;
--
-- Expect display_name to mirror username on every existing row. New changes
-- write display_name only, leaving the unique handle alone.
