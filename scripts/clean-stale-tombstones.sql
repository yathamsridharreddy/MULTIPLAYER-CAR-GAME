-- ============================================================================
--  SRIDHAR RUSH - clear tombstones that name a LIVE account  (v163)
--
--  HOW TO USE
--    Supabase dashboard -> SQL Editor -> New query -> paste this WHOLE file ->
--    Run. There are three statements: a preview that prints what would go, the
--    delete itself, and a check that must come back empty.
--
--    If anything at all is selected in the editor, Supabase runs ONLY the
--    selection - press Ctrl+A (or click in the editor and press it) before you
--    paste, or the file runs in pieces and nothing changes.
--
--  WHAT IT DOES
--    public.sr_purged_players is the list of identities the game refuses to
--    write: it is the record of a racer who is gone. A row is added there when
--    an account is deleted in Authentication -> Users.
--
--    A row there can also name an account that STILL EXISTS - a key an operator
--    erased by hand with one of the SQL tools, an admin purge called with the
--    wrong id, a row left behind by a half-finished cleanup. While that row
--    exists, the game refuses every club join from that account:
--        "This account was deleted from the game - sign out and sign up again"
--    and signing up again hands back the SAME account id, so the refusal
--    repeats for ever. Nothing on the screen can get out of it.
--
--    This removes exactly those rows: a tombstone whose key IS an account uuid
--    (with or without the 'sb:' prefix) that still has a row in auth.users.
--
--  WHAT IT NEVER TOUCHES
--    - the tombstone of an account that really is deleted
--    - a guest device key (they are not account uuids)
--    - a display name (a name is not an account)
--    - any game row: no stats, no club, no race history, nothing but the
--      tombstone rows named above
--
--  AFTER RUNNING IT: RESTART THE GAME SERVER ONCE.
--    A running server holds the tombstone list in memory and only ever adds to
--    it, so it keeps refusing until it restarts. (The v163 deploy asks Supabase
--    the same question on the first join from a tombstoned account and clears
--    the row in memory itself - so if the server is already on v163, you do not
--    need this file at all. It is the manual equivalent, for when the deploy
--    cannot be updated yet.)
-- ============================================================================


-- 1. PREVIEW - the tombstones that name an account Supabase still has.
select p.key, p.names, p.purged_at
  from public.sr_purged_players p
 where exists (
   select 1 from auth.users u
    where u.id::text = regexp_replace(lower(p.key), '^sb:', '')
       or ('sb:' || u.id::text) = lower(p.key)
 );


-- 2. CLEAR THEM - the statement that changes data.
delete from public.sr_purged_players p
 where exists (
   select 1 from auth.users u
    where u.id::text = regexp_replace(lower(p.key), '^sb:', '')
       or ('sb:' || u.id::text) = lower(p.key)
 );


-- 3. VERIFY - this must return zero rows.
select p.key, p.names
  from public.sr_purged_players p
 where exists (
   select 1 from auth.users u
    where u.id::text = regexp_replace(lower(p.key), '^sb:', '')
       or ('sb:' || u.id::text) = lower(p.key)
 );
