'use strict';

/* ============================================================================
   v111 — REVENGE IS A REQUEST, NOT A SOLO RACE.

   What the game used to do when the loser clicked ACCEPT REVENGE: paint the
   rival's track, click START, race BOTS. The rival was never asked, never
   told, never present - and the instant start inherited held keys from the
   previous race (a keyup that landed while a dialog input had focus was
   dropped), which is why that race had the nitro stuck on and the car
   uncontrollable.

   The flow now:
     loser sees the grudge  ->  sends a REQUEST to the racer who beat them
     winner sees the request (live toast, or lobby banner next visit)
     winner ACCEPTS         ->  server opens one room, seats BOTH, bots off,
                                countdown starts; DECLINES ends it
     either side offline    ->  request waits as 'accepted' and resumes itself
                                the moment both sockets are online again

   These tests pin every link of that chain, plus the stuck-key fix, so neither
   the solo-race shortcut nor the stale-input bug can come back.
   ========================================================================== */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const GAME = read('public/js/game.js');
const SERVER = read('server.js');
const HTML = read('public/index.html');

/** source of the rev-accept-btn onclick handler */
const acceptHandler = (() => {
  const i = GAME.indexOf('const rBtn = $(\'rev-accept-btn\');');
  assert.ok(i >= 0, 'the revenge banner button wiring must exist');
  return GAME.slice(i, GAME.indexOf('// 0.6 v111 INCOMING', i));
})();

test('the loser sends a REQUEST - the race no longer self-starts', () => {
  assert.match(acceptHandler, /\/api\/player\/revenge\/request/,
    'clicking ACCEPT REVENGE must issue a challenge to the rival');
  assert.match(acceptHandler, /targetUid: topRev\.targetUid/,
    'addressed to the racer who actually won');
  assert.ok(!/start-btn/.test(acceptHandler),
    'the revenge click must not click START - that was the solo-race shortcut');
  assert.ok(!/acceptMapChoice/.test(acceptHandler),
    'and must not silently retune a room behind the rival\'s back');
  assert.match(acceptHandler, /REQUEST SENT/,
    'the button must tell the loser the request is pending');
});

test('the winner sees the request and decides', () => {
  for (const id of ['revenge-incoming-banner', 'rev-in-msg', 'rev-in-accept', 'rev-in-decline']) {
    assert.ok(HTML.includes('id="' + id + '"'), 'index.html must carry #' + id);
    assert.ok(GAME.includes("$('" + id + "')"), 'game.js must wire #' + id);
  }
  assert.match(GAME, /\/api\/player\/challenges\?/, 'the lobby poll must fetch incoming requests');
  assert.match(GAME, /\/api\/player\/revenge\/accept/, 'accept posts to the server');
  assert.match(GAME, /\/api\/player\/revenge\/decline/, 'decline posts to the server');
  assert.match(GAME, /is offline right now — the race starts automatically/,
    'accepting while the issuer is offline must say what happens next');
});

test('a held key can never survive into the next race', () => {
  const keyup = /window\.addEventListener\('keyup'[\s\S]*?\n\}\);/.exec(GAME);
  assert.ok(keyup, 'keyup listener must exist');
  assert.match(keyup[0], /keys\.delete\(e\.code\);/);
  assert.ok(!/if \(isInput\) return/.test(keyup[0]),
    'a release that lands while a dialog input has focus must still count - ' +
    'dropping it is exactly how the nitro got stuck on');
  assert.match(GAME, /window\.addEventListener\('blur', \(\) => keys\.clear\(\)\)/,
    'releasing outside the window fires no keyup at all');
  const ingest = /function ingestSnapshot\(snap\) \{[\s\S]*?const now = performance\.now\(\);/.exec(GAME);
  assert.match(ingest[0], /snap\.state === 'countdown'[\s\S]*keys\.clear\(\)/,
    'and a fresh countdown drops whatever is still held');
});

test('the client reacts to live revenge pushes', () => {
  assert.match(GAME, /case 'revenge_request':/, 'a live toast when a grudge arrives');
  assert.match(GAME, /case 'revenge_start':/, 'and when the head-to-head begins');
  const start = /case 'revenge_start':[\s\S]*?break;/.exec(GAME);
  assert.match(start[0], /keys\.clear\(\)/, 'the head-to-head starts with clean inputs');
});

test('the server only races a grudge both sides agreed to', () => {
  for (const ep of ['/api/player/revenge/request', '/api/player/challenges',
    '/api/player/revenge/accept', '/api/player/revenge/decline']) {
    assert.ok(SERVER.includes("app." + (ep === '/api/player/challenges' ? 'get' : 'post') + "('" + ep + "'"),
      'endpoint missing: ' + ep);
  }
  const start = /async function startRevengeRoom\(row\) \{[\s\S]*?\n\}/.exec(SERVER);
  assert.ok(start, 'startRevengeRoom must exist');
  assert.match(start[0], /setBot\(false\)/, 'head-to-head means no stand-in bots');
  assert.match(start[0], /joinRoom\(a, entry, 'screen'[\s\S]*joinRoom\(b, entry, 'screen'/,
    'both racers are seated in the same room');
  assert.match(start[0], /entry\.room\.start\(\)/, 'and the countdown starts server-side');
  assert.equal((start[0].match(/type: 'revenge_start'/g) || []).length, 2,
    'each racer is told who the rival is');
  const accept = /app\.post\('\/api\/player\/revenge\/accept'[\s\S]*?\n\}\);/.exec(SERVER);
  assert.match(accept[0], /NOT_YOURS/, 'only the addressed racer may accept');
  assert.match(accept[0], /status: 'accepted'/, 'pending becomes accepted exactly once');
});

test('presence is registered on hello and released on disconnect', () => {
  assert.match(SERVER, /registerRevengeClient\(client, msg\);/,
    'the registry is how a request rings an online rival');
  assert.match(SERVER, /unregisterRevengeClient\(client\);/,
    'and a closed socket must stop receiving pushes');
  assert.match(SERVER, /resumeAcceptedRevenge\(client\)/,
    'an accepted grudge resumes itself when both racers are online again');
});

/* ========================================================================== *
 *  The schema leg: a revenge request is a `challenges` row, and that table
 *  used to reject every one of them - uuid identity columns, a three-value
 *  status CHECK, and policies comparing auth.uid() (uuid) with text.
 * ========================================================================== */
const SETUP_SQL = read('supabase-setup.sql');
const V98 = read('supabase-migration-v98.sql');
const V99 = read('supabase-migration-v99.sql');

test('the challenges table stores identities, not accounts', () => {
  for (const [name, sql] of [['setup', SETUP_SQL], ['v98', V98]]) {
    const create = /create table if not exists public\.challenges \([\s\S]*?\n\);/.exec(sql);
    assert.ok(create, name + ' must define challenges');
    assert.match(create[0], /from_uid\s+text not null/, name + ': from_uid must be text');
    assert.match(create[0], /winner_uid\s+text,/, name + ': winner_uid must be text');
    assert.match(create[0], /'pending',\s*'accepted',\s*'declined'/,
      name + ': the status CHECK must cover the request lifecycle');
    assert.ok(!/references auth\.users/.test(create[0]),
      name + ': no identity column may be a foreign key to auth.users');
  }
  for (const sql of [SETUP_SQL, V98, V99]) {
    assert.match(sql, /create policy "ch make" on public\.challenges for insert with check \(auth\.uid\(\)::text = from_uid\)/,
      'ch make must compare cast identities');
    assert.match(sql, /using \(auth\.uid\(\)::text = to_uid\)/,
      'ch answer must compare cast identities');
  }
});

test('v99 converges an old challenges table without ever aborting', () => {
  assert.match(V99, /alter table if exists public\.challenges\s+add column if not exists to_uid text;/,
    'a table older than friend challenges gets the addressee column');
  assert.match(V99, /drop policy if exists "ch make"[\s\S]*drop policy if exists "ch answer"/,
    'policies go before the columns they reference');
  const relax = /do \$\$\s+declare\s+c record;\s+col text;[\s\S]*?end \$\$;/.exec(V99);
  assert.ok(relax, 'the relaxation must live in one guarded block');
  assert.match(relax[0], /if to_regclass\('public\.challenges'\) is null then/,
    'existence is probed with to_regclass, which never throws');
  assert.match(relax[0], /execute format\('alter table public\.challenges drop constraint %I'/,
    'foreign keys drop through EXECUTE');
  assert.match(relax[0], /alter column %I type text using %I::text/,
    'and each uuid column relaxes through EXECUTE');
  const check = /pg_get_constraintdef\(oid\) not like '%pending%'/.exec(V99);
  assert.ok(check, 'the three-value CHECK is detected by definition, not assumed');
  // the 42P01 class: no IF condition may name a table statically
  const conds = [...V99.matchAll(/if ([\s\S]*?)\bthen\b/g)].map((m) => m[1])
    .filter((c) => !/'/.test(c.split('public.')[1] || ''));
  for (const c of conds) {
    assert.ok(!/(?:from|join|update|into)\s+public\.\w+/.test(c.replace(/'[^']*'/g, "''")),
      'an IF condition names a table statically: ' + c.slice(0, 60));
  }
});

test('v99 is idempotent - every destructive statement is guarded', () => {
  for (const line of V99.split('\n')) {
    if (line.startsWith(' ')) continue; // inside a DO block: guarded by its IF
    const t = line.trim();
    if (/^(drop policy|alter table)/.test(t)) {
      assert.match(t, /if exists|if not exists/, 'unguarded DDL: ' + t);
    }
  }
  assert.equal((V99.match(/drop constraint challenges_status_check/g) || []).length, 1);
  assert.match(V99, /add constraint challenges_status_check/, 'and the wide check is re-added');
});
