-- ============================================================================
-- SRIDHAR RUSH - v99 migration: converge the CHALLENGES table for live revenge
-- ============================================================================
-- Run this ONCE, in the Supabase SQL Editor, AFTER supabase-migration-v98.sql.
-- If your database was created from supabase-setup.sql at build v111 or later,
-- or already ran a v98 that includes section 5c, every statement here is a
-- no-op - it is safe either way.
--
-- WHY IT EXISTS
-- -------------
-- v111 turned revenge into a request/accept flow between two racers, and the
-- challenges table is where a request lives. As shipped years ago that table
-- could not hold one:
--
--   * from_uid / to_uid / winner_uid were uuid foreign keys to auth.users, so
--     a guest racer - device pid or display name, i.e. almost everyone - was
--     rejected with "invalid input syntax for type uuid" on every write;
--   * the status CHECK allowed only ('open','done','expired'), while the
--     friend-answer policy writes 'accepted' / 'declined' and revenge adds
--     'pending' - so even a signed-in racer's answer was rejected by the
--     table itself;
--   * both policies compared auth.uid() (a uuid) with those columns directly,
--     which cannot typecheck once the columns are text.
--
-- Every statement is idempotent and guarded: existence is probed with
-- to_regclass() (a function on a string, never an error) and every inspection
-- of a possibly-missing object goes through the catalog or EXECUTE, so this
-- file converges from any shape without aborting - the same rule v98 follows.
-- NOTICE lines in the output are informational; only ERROR stops anything.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. the addressee column, for databases older than the friend-challenge build
-- ----------------------------------------------------------------------------
alter table if exists public.challenges
  add column if not exists to_uid text;


-- ----------------------------------------------------------------------------
-- 2. the two policies that compare auth.uid() with an identity column
-- ----------------------------------------------------------------------------
-- Dropped before the columns relax (Postgres will not alter a column a policy
-- references) and recreated in section 5 with an explicit ::text cast.
drop policy if exists "ch make"   on public.challenges;
drop policy if exists "ch answer" on public.challenges;


-- ----------------------------------------------------------------------------
-- 3. drop the auth.users foreign keys, then relax uuid -> text
-- ----------------------------------------------------------------------------
-- A guest's device pid is not an auth user, and neither is a display name; the
-- constraints only ever rejected rows rather than protecting any.
do $$
declare
  c record;
  col text;
begin
  if to_regclass('public.challenges') is null then
    raise notice 'challenges table absent - nothing to converge';
    return;
  end if;

  for c in
    select con.conname
    from pg_constraint con
    join pg_class frel on frel.oid = con.confrelid
    join pg_namespace fnsp on fnsp.oid = frel.relnamespace
    where con.conrelid = 'public.challenges'::regclass
      and con.contype = 'f'
      and fnsp.nspname = 'auth'
      and frel.relname = 'users'
  loop
    execute format('alter table public.challenges drop constraint %I', c.conname);
    raise notice 'dropped auth.users foreign key %', c.conname;
  end loop;

  foreach col in array array['from_uid', 'to_uid', 'winner_uid']
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'challenges'
        and column_name = col and data_type = 'uuid'
    ) then
      execute format('alter table public.challenges alter column %I type text using %I::text', col, col);
      raise notice 'challenges.% relaxed uuid -> text', col;
    end if;
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 4. widen the status CHECK to the full request lifecycle
-- ----------------------------------------------------------------------------
-- pg_constraint is a catalog, so these probes cannot raise 42P01.
do $$
begin
  if to_regclass('public.challenges') is null then
    return;
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.challenges'::regclass
      and conname = 'challenges_status_check'
      and pg_get_constraintdef(oid) not like '%pending%'
  ) then
    alter table public.challenges drop constraint challenges_status_check;
    raise notice 'dropped the three-value status check';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.challenges'::regclass
      and conname = 'challenges_status_check'
  ) then
    alter table public.challenges add constraint challenges_status_check
      check (status in ('open', 'done', 'expired', 'pending', 'accepted', 'declined'));
    raise notice 'status check now covers pending / accepted / declined';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 5. recreate the two policies over text identity columns
-- ----------------------------------------------------------------------------
create policy "ch make" on public.challenges for insert with check (auth.uid()::text = from_uid);
create policy "ch answer" on public.challenges for update
  using (auth.uid()::text = to_uid)
  with check (status in ('accepted', 'declined'));


-- ----------------------------------------------------------------------------
-- 6. verify
-- ----------------------------------------------------------------------------
-- All three should say text, and no row should mention auth:
--
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'challenges'
--      and column_name in ('from_uid', 'to_uid', 'winner_uid');
--
--   select conname from pg_constraint
--    where conrelid = 'public.challenges'::regclass and contype = 'f';
--
-- The check should list six statuses:
--
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.challenges'::regclass
--      and conname = 'challenges_status_check';
-- ============================================================================
