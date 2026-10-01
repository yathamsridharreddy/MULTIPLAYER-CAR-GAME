'use strict';
/* ============================================================================
   v158 — "delete the user and every part of them is gone".

   Two halves are tested here, because the promise has two halves.

   The database half lives in supabase-migration-v158.sql: an AFTER DELETE
   trigger on auth.users that erases the racer from every table the game keeps
   (including the club tables) and leaves a tombstone. Its correctness was
   proven on a real PostgreSQL by deleting an auth.users row and asserting every
   table empty afterwards; what these tests pin is the set of properties that
   would let it silently rot - the trigger being bound to auth.users, using OLD
   (a DELETE trigger has no NEW, and `new.id` there is NULL, which fails soft:
   the trigger runs, purges nothing, and reports no error), every identity table
   still appearing in the delete list, and the file staying re-runnable.

   The process half lives in server.js: this server holds the same racer in a
   dozen Maps, and a Map is how a deleted account comes back. These tests drive
   the REAL sweepers with a stubbed Supabase, which is the same way
   persistence.test.js drives the hydration paths.
   ========================================================================== */
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

const { test, describe, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const realFetch = global.fetch; // kept so the tests' own HTTP calls still work
const SB = 'https://fake.supabase.co';
const calls = [];
let responder = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' });
global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith(SB)) return realFetch(url, opts);
  const body = opts && typeof opts.body === 'string' ? opts.body : null;
  calls.push({ url: u, method: (opts && opts.method) || 'GET', body: body, json: (() => { try { return JSON.parse(body); } catch (e) { return null; } })() });
  return responder(u, opts);
};

const S = require('../server.js');
const {
  app, rooms, newRoom, handleMessage, settleRace, leaderboard,
  memPlayerStats, memCrews, memPlayerCrew, memCrewAliases, memCrewNameHints,
  memPlayerMissions, memEquippedBadges, memRevengeTargets,
  purgedKeys, purgedNames, isPurgedKey, isPurgedName, isPurgedRacer,
  noteTombstones, evictPurged, dropRacerMemory, refreshPurges,
  memClaimedCrewMilestones, crewClaimKey,
  lbAdd, sbUpsert, hydrateMissions, hydrated, claimHydration, forgetHydration
} = S;

const U = '11111111-2222-4333-8444-555555555555';   // the account being deleted
const SB_U = 'sb:' + U;                              // the form a signed-in client sends
const V = '99999999-8888-4777-8666-555555555555';   // the racer next to them, who stays
const NAME = 'GHOST_RIDER';
const PID = 'device-pid-abc123';                     // the same account's device identity

const ROOT = path.resolve(__dirname, '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase-migration-v158.sql'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// the same seeding the shipped client does, so the sweepers see real shapes
function seedCaches() {
  memPlayerStats.set(U, { uid: U, name: NAME, rating: 1500, races: 9 });
  memPlayerStats.set(SB_U, { uid: SB_U, name: NAME, rating: 1500, races: 9 });
  memPlayerStats.set(V, { uid: V, name: 'SURVIVOR', rating: 1400, races: 4 });
  memEquippedBadges.set(U, 'badge-a');
  memPlayerMissions.set('2026-10-01:' + U, new Map([['m1', { progress: 3, completed: false, claimed: false }]]));
  memRevengeTargets.set(SB_U, [{ targetUid: V, targetName: 'SURVIVOR' }]);
  memRevengeTargets.set(V, [{ targetUid: U, targetName: NAME }]);

  const crew = memCrews.get('apex');
  crew.members = [
    { uid: U, name: NAME, role: 'leader', weeklyMeters: 12000, totalMeters: 30000, weeklyPoints: 40, aliases: [PID], joined_at: '2026-01-01T00:00:00Z' },
    { uid: V, name: 'SURVIVOR', role: 'member', weeklyMeters: 30000, totalMeters: 120000, weeklyPoints: 150, aliases: [], joined_at: '2026-02-01T00:00:00Z' }
  ];
  crew.weeklyMeters = 42000;
  crew.totalMeters = 150000;
  crew.weeklyPoints = 190;
  crew.leaderUid = U;
  memPlayerCrew.set(U, 'apex');
  memPlayerCrew.set(PID, 'apex');
  memPlayerCrew.set(V, 'apex');
  memCrewAliases.set(PID, 'apex');
  memCrewNameHints.set(NAME.toLowerCase(), new Set(['apex']));

  leaderboard[0] = [
    { name: NAME, pid: U, t: 41.2 },
    { name: 'SURVIVOR', pid: V, t: 42.8 }
  ];
  hydrated.add('stats|' + U);
  hydrated.add('crew|apex');
}

const crewNow = () => memCrews.get('apex');

describe('v158 — the tombstone empties every cache that knows the racer', () => {
  beforeEach(() => { calls.length = 0; seedCaches(); });

  test('the poll reads the tombstones and sweeps the racer out of RAM', async () => {
    responder = async (u) => {
      if (u.includes('sr_purged_players')) {
        // the trigger writes one row per identity it found, the device pid included
        return { ok: true, status: 200, json: async () => [
          { key: U, names: [NAME], purged_at: new Date().toISOString() },
          { key: PID, names: [NAME], purged_at: new Date().toISOString() }
        ], text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    const learned = await refreshPurges(true);
    assert.equal(learned, 2, 'both tombstone keys were learned');
    assert.ok(isPurgedKey(U) && isPurgedKey(SB_U) && isPurgedKey('stats|' + SB_U), 'the key matches in every form the game writes');
    assert.ok(isPurgedName(NAME) && isPurgedRacer(NAME), 'and by the display name the tombstone carried');

    assert.ok(!memPlayerStats.has(U) && !memPlayerStats.has(SB_U), 'the stat rows are gone');
    assert.ok(memPlayerStats.has(V), 'the racer next to them is untouched');
    assert.ok(!memEquippedBadges.has(U), 'the equipped badge is gone');
    assert.ok(!memPlayerMissions.has('2026-10-01:' + U), 'the mission sheet is gone');
    assert.ok(!memRevengeTargets.has(SB_U), 'their revenge list is gone');
    assert.deepEqual(memRevengeTargets.get(V), [], 'and nobody is left holding them as a target');

    const c = crewNow();
    assert.equal(c.members.length, 1, 'the club roster no longer lists them');
    assert.equal(c.members[0].uid, V, 'the member who stayed is the one who stayed');
    assert.equal(c.members[0].role, 'leader', 'leadership passed to them');
    assert.equal(c.weeklyMeters, 30000, 'the club no longer counts their kilometres');
    assert.equal(c.totalMeters, 120000, 'nor their lifetime ones');
    assert.equal(c.weeklyPoints, 150, 'nor their points');
    assert.ok(!memPlayerCrew.has(U) && !memPlayerCrew.has(PID), 'the club lookup no longer resolves them');
    assert.ok(!memCrewAliases.has(PID), 'and their device identity is unbound');
    assert.ok(!memCrewNameHints.has(NAME.toLowerCase()), 'the club name hint is gone too');

    assert.deepEqual(leaderboard[0].map((r) => r.name), ['SURVIVOR'], 'the account-lite board dropped their time');
    assert.ok(!hydrated.has('stats|' + U), 'the hydration they had already claimed is forgotten');
    assert.ok(hydrated.has('crew|apex'), 'the club keeps its own hydration claim');
  });

  test('a purge is idempotent and never touches the racer beside them', async () => {
    noteTombstones([{ key: U, names: [NAME], purged_at: new Date().toISOString() },
      { key: PID, names: [NAME], purged_at: new Date().toISOString() }]);
    const first = evictPurged();
    const second = evictPurged();
    assert.ok(first > 0, 'the first pass drops entries');
    assert.equal(second, 0, 'the second finds nothing left to drop');
    assert.ok(memPlayerStats.has(V), 'the other racer is still there');
    assert.ok(memPlayerCrew.has(V), 'and still in their club');
  });

  test('a hydration the racer already claimed cannot pull the rows back', async () => {
    noteTombstones([{ key: U, names: [NAME], purged_at: new Date().toISOString() },
      { key: PID, names: [NAME], purged_at: new Date().toISOString() }]);
    evictPurged();
    calls.length = 0;
    const ok = await hydrateMissions('2026-10-01', U);
    assert.equal(ok, false, 'hydration is refused for a deleted account');
    assert.equal(calls.filter((c) => c.url.includes('player_missions')).length, 0, 'and it never reads the table');
    assert.equal(claimHydration('stats|' + U), false, 'the hydration gate refuses the key outright');
    assert.equal(claimHydration('stats|' + V), true, 'while the living racer still hydrates');
  });

  test('the board will not write a deleted racer back in', async () => {
    noteTombstones([{ key: U, names: [NAME], purged_at: new Date().toISOString() },
      { key: PID, names: [NAME], purged_at: new Date().toISOString() }]);
    evictPurged();
    calls.length = 0;
    lbAdd(0, { name: NAME, pid: U, t: 30.1 });        // their client is still open and finishes a lap
    lbAdd(0, { name: NAME, pid: PID, t: 29.9 });      // or sends it under the device pid
    assert.deepEqual((leaderboard[0] || []).map((r) => r.name), ['SURVIVOR'],
      'neither write lands on the in-process board, and the racer still here is untouched');
    await sbUpsert(0, { name: NAME, pid: U, t: 30.1 });
    assert.equal(calls.filter((c) => c.url.includes('/rest/v1/leaderboard')).length, 0, 'and neither reaches Postgres');
  });
});

describe('v158 — settlement cannot resurrect a deleted account', () => {
  // the racer is deleted between the green light and the flag: the room still
  // holds them, the finish still has to be scored for the others, and not one
  // row may be written for the account that is gone.
  //
  // The signed-in racer seats with a token because v121 refuses guests whenever
  // Supabase is configured - which it is here, so the stub can watch the writes.
  const TOK_U = 'tok-U-' + U;   // the account being deleted
  const TOK_V = 'tok-V-' + V;   // the racer next to them
  const tick = () => new Promise((r) => setTimeout(r, 30));
  async function twoRacerRoom() {
    const entry = newRoom('race', 0, 6);
    const seat = async (pid, name, tok) => {
      const ws = { readyState: 1, sent: [], send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); } };
      const client = { ws, entry: null, slot: 0, role: null, pid, name };
      handleMessage(client, { type: 'hello', role: 'screen', room: entry.room.code, pid, name, tok });
      await tick();
      return client;
    };
    const a = await seat(SB_U, NAME, TOK_U);
    const b = await seat(V, 'SURVIVOR', TOK_V);
    assert.ok(a.slot > 0 && b.slot > 0, 'both racers were seated (the auth stub answered)');
    for (const cl of [a, b]) {
      const car = entry.room.cars[cl.slot - 1];
      car.finished = true;
      car.finishTime = cl === a ? 30.5 : 31.2;
      car.best = cl === a ? 10.1 : 10.4;
      car.lapTimes = [car.best];
      car.participating = true;
    }
    entry.room.laps = 3;
    return entry;
  }

  beforeEach(() => {
    calls.length = 0;
    rooms.clear();
    seedCaches();
    // the auth stub answers with whoever the bearer token belongs to, so the two
    // racers are two accounts and not one racer printed twice
    responder = async (u, opts) => {
      if (u.includes('/auth/v1/user')) {
        const tok = String((opts && opts.headers && opts.headers.Authorization) || '');
        return { ok: true, status: 200, json: async () => ({ id: tok.includes(TOK_V) ? V : U }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
  });
  after(() => { rooms.clear(); });

  test('the purged racer writes nothing while their rival races on', async () => {
    noteTombstones([{ key: U, names: [NAME], purged_at: new Date().toISOString() },
      { key: PID, names: [NAME], purged_at: new Date().toISOString() }]);
    evictPurged();
    calls.length = 0;
    const entry = await twoRacerRoom();
    const rows = await settleRace(entry);
    assert.equal(rows.length, 2, 'both racers still get a result screen');

    const writes = calls.filter((c) => c.method === 'POST' && c.url.startsWith(SB));
    const forPurged = writes.filter((c) => JSON.stringify(c.json || '').includes(U));
    assert.equal(forPurged.length, 0, 'not one write names the deleted account: ' + JSON.stringify(forPurged.map((c) => c.url)));
    const forRival = writes.filter((c) => JSON.stringify(c.json || '').includes(V));
    assert.ok(forRival.length >= 1, 'while the racer who is still here is scored normally');
    assert.ok(!memPlayerStats.has(SB_U) && !memPlayerStats.has(U), 'and the deleted racer is not left in the stats map');
    assert.ok(!memPlayerCrew.has(U) && !memPlayerCrew.has(PID), 'nor left resolved to a club');
  });
});

describe('v158 — POST /api/admin/purge', () => {
  function listen() {
    const server = app.listen(0);
    return { server, base: 'http://127.0.0.1:' + server.address().port };
  }
  const post = (base, body, headers) => realFetch(base + '/api/admin/purge', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body)
  });

  beforeEach(() => {
    calls.length = 0;
    responder = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' });
  });

  test('refuses a caller who is not the operator', async () => {
    const { server, base } = listen();
    try {
      const anon = await post(base, { uid: U });
      assert.equal(anon.status, 401, 'no credentials, no purge');
      const wrong = await post(base, { uid: U }, { Authorization: 'Bearer nope' });
      assert.equal(wrong.status, 401, 'a wrong key is refused');
      assert.equal(calls.length, 0, 'and nothing was asked of the database');
    } finally { server.close(); }
  });

  test('purges the identity it is given and evicts in the same request', async () => {
    seedCaches();
    responder = async (u) => {
      if (u.includes('/rpc/sr_purge_identity')) {
        return { ok: true, status: 200, json: async () => ({ 'player_stats.user_id': 1, 'crew_members': 2 }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    const { server, base } = listen();
    try {
      const r = await post(base, { uid: U, name: NAME }, { Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.deepEqual(j.purged, { 'player_stats.user_id': 1, 'crew_members': 2 }, 'the SQL counts come back to the operator');

      const rpc = calls.find((c) => c.url.includes('/rpc/sr_purge_identity'));
      assert.ok(rpc, 'the RPC was called');
      assert.deepEqual(rpc.json.p_keys, [U], 'with the identity the operator named');
      assert.deepEqual(rpc.json.p_names, [NAME], 'and the display names to match keyless rows');
      assert.ok(!memPlayerStats.has(U) && !memPlayerStats.has(SB_U), 'and the racer is out of memory before the response');
      assert.equal(crewNow().members.length, 1, 'their club roster row is gone');
      assert.ok(j.evicted > 0, 'the response reports what was evicted');
    } finally { server.close(); }
  });

  test('an empty request is a 400, a sweep is one call to the orphan function', async () => {
    const { server, base } = listen();
    try {
      const none = await post(base, {}, { Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE });
      assert.equal(none.status, 400, 'nothing to purge is a client error, not a no-op success');

      responder = async (u) => (u.includes('/rpc/sr_purge_orphans')
        ? { ok: true, status: 200, json: async () => ({ 'player_stats.user_id': 4 }), text: async () => '' }
        : { ok: true, status: 200, json: async () => [], text: async () => '' });
      const swept = await post(base, { sweep: true }, { Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE });
      assert.equal(swept.status, 200);
      const j = await swept.json();
      assert.deepEqual(j.swept, { 'player_stats.user_id': 4 }, 'the sweep result is returned');
      assert.ok(calls.some((c) => c.url.includes('/rpc/sr_purge_orphans')), 'sr_purge_orphans was what ran');
    } finally { server.close(); }
  });

  test('the gh signal rides on the ghost, so a purge finds it without the name', () => {
    // the upload now carries owner_key; assert the shipped route writes it
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(/owner_key: purgeSafeKey\(j\.pid\)/.test(src), 'the ghost route stores the uploader identity');
    const client = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game.js'), 'utf8');
    assert.ok(!/name: prefs\.name, data: g/.test(client), 'and the client no longer uploads a ghost it cannot be matched to');
    assert.ok(/pid: crewIdentity\(\)\.pid/.test(client), 'it sends the identity it races with');
  });
});

describe('v158 — the migration that does the database half', () => {
  test('the trigger is bound to auth.users and uses OLD, not NEW', () => {
    assert.match(SQL, /drop trigger if exists sr_purge_on_auth_delete on auth\.users;/,
      'the file can be run twice: the trigger is dropped first');
    assert.match(SQL, /create trigger sr_purge_on_auth_delete\s+after delete on auth\.users\s+for each row execute function public\.sr_on_auth_user_delete\(\)/,
      'deleting the auth user is what fires it');
    const body = SQL.slice(SQL.indexOf('create or replace function public.sr_on_auth_user_delete()'),
      SQL.indexOf('comment on function public.sr_on_auth_user_delete()'));
    assert.ok(/old\.id/.test(body), 'the trigger reads OLD');
    assert.ok(!/\bnew\.id\b/.test(body),
      'and NEVER NEW: in an AFTER DELETE trigger NEW is unset, so new.id is NULL, the purge silently matches nothing and raises no error');
  });

  test('every table a racer can appear in is on the delete list', () => {
    // the v158 account-deletion map: every identity column in the schema
    const targets = [
      'player_stats', 'player_wallet', 'coin_ledger', 'player_inventory', 'player_equipped',
      'player_map_records', 'race_history', 'player_achievements', 'player_badges', 'player_seasons',
      'season_rewards_claimed', 'player_missions', 'weekly_bounties', 'weekly_competition',
      'daily_competition', 'player_revenge', 'friends', 'challenges', 'leaderboard', 'ghosts',
      'crews', 'crew_members', 'crew_milestone_claims'
    ];
    for (const t of targets) {
      const named = SQL.includes("'" + t + "'") || new RegExp('public\\.' + t + '\\b').test(SQL);
      assert.ok(named, t + ' is on the v158 delete list');
    }
    assert.ok(/\(\s*'profiles'\s*,\s*'id'\s*\)/.test(SQL), 'profiles is deleted through its own id form');
    assert.ok(/update public\.crews\b/.test(SQL), 'the club they led is repaired, not just their row removed');
  });

  test('the three defects a real Postgres found stay fixed', () => {
    assert.ok(!/text\[\]\[\]/.test(SQL), 'no 2-D array constants: plpgsql flattens them and the iteration dies');
    assert.match(SQL, /any\(v_keys\)/, 'identity matching is an array test');
    assert.match(SQL, /::text = any\(\$1\)/,
      'and the comparison casts to text: profiles.id is uuid while every other identity column is text');
    assert.ok(!/revoke [^;]*from anon(?!')/.test(SQL) || /pg_roles/.test(SQL),
      'role grants are guarded: anon/authenticated/service_role do not exist on a plain cluster');
    assert.match(SQL, /if exists \(select 1 from pg_roles where rolname = 'anon'\)/, 'the guard is the pg_roles test');
  });

  test('the tombstone records the names, because some caches are name-keyed', () => {
    assert.match(SQL, /create table if not exists public\.sr_purged_players \(\s*key\s+text primary key,\s*names\s+text\[\] not null default '\{\}'/,
      'the tombstone carries the display names as well as the keys');
    assert.match(SQL, /insert into public\.sr_purged_players \(key, names\)/, 'and they are written on every purge');
    assert.ok(/alter table public\.sr_purged_players add column if not exists names/.test(SQL),
      'adding the column to an older tombstone table is safe');
  });

  test('a club is only deleted when THIS purge emptied it and it was theirs', () => {
    // The live incident this pins: the club cleanup used to run as
    //   delete from crews where not seeded and not exists (any member row)
    // with no reference to the clubs the purge had touched, so one purge deleted
    // every club that merely had no roster rows stored at that moment - clubs
    // belonging to racers who were not being purged at all. v_crews is computed
    // for exactly this and has to be what the delete is scoped by.
    const body = SQL.slice(SQL.indexOf('-- 6. the clubs'), SQL.indexOf('-- 7. the tombstone'));
    const del = body.slice(body.indexOf('delete from public.crews c'), body.indexOf('$sql$ using v_crews, v_keys;'));
    assert.match(del, /where c\.id = any\(\$1\)/,
      'the club delete must name only the clubs this purge emptied');
    assert.match(del, /coalesce\(c\.seeded, false\) = false/, 'the built-in clubs stay');
    assert.match(del, /c\.leader_uid is null or c\.leader_uid = any\(\$2\)/,
      'and only a club whose owner is one of the purged identities goes');
    assert.match(del, /not exists \(select 1 from public\.crew_members m where m\.crew_id = c\.id\)/,
      'a club with members left is never deleted');

    const lead = body.slice(body.indexOf('update public.crews c'), body.indexOf('$sql$ using v_claims, v_crews, v_keys;'));
    assert.match(lead, /c\.id = any\(\$2\)/, 'the leadership repair is scoped the same way');
    assert.match(lead, /or c\.leader_uid = any\(\$3\)/,
      'and it also fires for a club whose own row names the purged racer as leader');
  });

  test('a display name can never drag a live account into a purge', () => {
    // The roster widening matches by name last, because a name is weaker
    // evidence than a key. It therefore has to refuse any roster row whose key
    // still answers to a live auth account: two racers called SRIDHAR must not
    // let one of them delete the other.
    const body = SQL.slice(SQL.indexOf('-- 2. widen the identity set'), SQL.indexOf('-- 3. one identity column per table'));
    assert.match(body, /v_names <> '\{\}' and m\.name = any\(v_names\)/,
      'the roster is still widened by a display name - that is how a name-keyed guest is found');
    assert.match(body, /not exists \(\s*select 1 from auth\.users u\s*where u\.id::text = m\.member_key or \('sb:' \|\| u\.id::text\) = m\.member_key\s*\)/,
      'but never for a roster row whose key belongs to a live account');
  });

  test('the guest rows are never swept by the orphan pass', () => {
    // a guest is a device pid, not a uuid, and never had an auth account. The
    // sweep deletes "a uuid with no auth user", so a device must not qualify on
    // either test - the reason the FKs could not be re-added in the first place.
    const body = SQL.slice(SQL.indexOf('create or replace function public.sr_purge_orphans()'));
    assert.ok(/where not exists \(select 1 from auth\.users u where u\.id::text = k\)/.test(body),
      'only keys with no auth user are swept');
    assert.ok(/user_id ~\* '\^\[0-9a-f\]\{8\}-/.test(body), 'and a candidate key must be uuid-shaped to be one');
    assert.ok(/member_key ~\* '\^\[0-9a-f\]\{8\}-/.test(body), 'for club roster rows too');
    assert.ok(/v_out := public\.sr_purge_identity\(v_keys, v_names\)/.test(body),
      'the sweep runs the same purge, never a hand-rolled delete');
  });
});
describe('v158.3 — a purge takes the racer it was told to and nothing else living', () => {
  const TOOL = fs.readFileSync(path.join(ROOT, 'scripts', 'clean-deleted-racers.sql'), 'utf8');

  test('a shared roster row can never widen the purge onto a living racer', () => {
    // Two racers can share a display name and end up on ONE roster row: one
    // joined as a guest, the other signed in, and the second racer's account id
    // is left in the first one's alias list. The row goes with whoever is being
    // purged; the living racer whose key rides on that alias list must not.
    const body = SQL.slice(SQL.indexOf('-- 2. widen the identity set'), SQL.indexOf('-- 3. one identity column per table'));
    assert.match(SQL, /v_given := v_keys;/,
      'the keys the caller named are remembered, so they can be told apart from the widened ones');
    assert.match(body, /and \(a = any\(v_given\)/,
      'a widened key survives only when the caller named it...');
    assert.match(body, /not exists \(\s*select 1 from auth\.users u\s*where u\.id::text = regexp_replace\(lower\(a\), '\^sb:', ''\)/,
      '...or when it answers to nobody: any key that still has an account is dropped');
    assert.match(body, /where c = any\(v_given\)/,
      'the claimed roster rows are filtered the same way before anything is widened from them');

    // and the trigger, which collects keys before the purger runs, with the
    // same rule - otherwise the living racer is inside p_keys from the start
    const trigger = SQL.slice(SQL.indexOf('create or replace function public.sr_on_auth_user_delete()'));
    assert.match(trigger, /where k is null or k = ''\s*or not exists \(/,
      'the trigger drops keys that belong to an account which still exists');
  });

  test('the purged identities come off the roster rows that survived them', () => {
    const body = SQL.slice(SQL.indexOf('-- 6b.'), SQL.indexOf('-- 7. the tombstone'));
    assert.match(body, /update public\.crew_members m/,
      'the surviving row keeps its owner, its alias list is cleaned');
    assert.match(body, /where not \(a = any\(\$1\)\)/, 'the purged keys are what comes off');
    assert.match(body, /aliases_cleaned/, 'and the count is reported');
  });

  test('a roster row for a tombstoned racer is never hydrated again', () => {
    // the moment between the trigger and the server learning of it: a warm
    // process reading the club tables must not put the racer back on the roster
    memCrews.get('apex').members = [];
    noteTombstones([{ key: U, names: [NAME], purged_at: new Date().toISOString() }]);
    const added = S.applyMemberRow({
      crew_id: 'apex', member_key: U, name: NAME, role: 'leader',
      aliases: [], weekly_meters: 1000, total_meters: 2000, weekly_points: 5, week_key: '2026-W40'
    });
    assert.equal(added, null, 'the row is refused');
    assert.equal(memCrews.get('apex').members.length, 0, 'and nothing is on the roster');

    // ...but a display name alone is never evidence: a namesake must still load
    const namesake = S.applyMemberRow({
      crew_id: 'apex', member_key: 'device-pid-someone-else', name: NAME, role: 'member',
      aliases: [], weekly_meters: 0, total_meters: 0, weekly_points: 0, week_key: '2026-W40'
    });
    assert.ok(namesake, 'a racer who merely shares the deleted name is still hydrated');
    assert.equal(memCrews.get('apex').members.length, 1);
  });

  test('the cleanup tool refuses to run beside the old, club-deleting purger', () => {
    // The tool erases accounts that were deleted before the trigger existed, so
    // it runs sr_purge_identity - and it must never do that on a database whose
    // purge still carries the unscoped club delete. The guard is the first thing
    // it does, and it raises instead of proceeding.
    assert.match(TOOL, /if position\('c\.id = any\(\$1\)' in v_src\) = 0 then\s*raise exception/,
      'the version of the installed purger is checked before anything is erased');
    assert.match(TOOL, /raise exception 'sr_purge_identity is not installed here/,
      'and so is its presence');
    assert.match(TOOL, /v_out := public\.sr_purge_identity\(v_dead, v_names\)/,
      'the erase is the same purger the trigger calls, never a second implementation');
    assert.match(TOOL, /p_dry_run/, 'a preview mode exists and changes nothing');
    assert.ok(TOOL.indexOf('p_dry_run') < TOOL.indexOf('v_out := public.sr_purge_identity'),
      'the preview returns before the erase');
    assert.match(TOOL, /revoke all on function public\.sr_cleanup_deleted_racers\(boolean\) from anon/,
      'and it is not callable with the anon key');
  });
});

describe('v158.4 — a row the purge cannot prove is theirs is removed by hand, safely', () => {
  const TOOL = fs.readFileSync(path.join(ROOT, 'scripts', 'remove-club-member.sql'), 'utf8');

  test('the account deletion also looks for the name the game SHOWS', () => {
    // v144 stores the driver name in profiles.display_name, and that is the name
    // a club roster carries - while the trigger only ever read the handle. A
    // racer who joined as a guest and later signed in left a roster row whose
    // only link to the account is that name.
    const trigger = SQL.slice(SQL.indexOf('create or replace function public.sr_on_auth_user_delete()'));
    assert.match(trigger, /p\.display_name from public\.profiles p where p\.id::text = \$1/,
      'the driver name is collected with the handle');
    assert.match(trigger, /information_schema\.columns[\s\S]{0,200}column_name = 'display_name'/,
      'and guarded, because display_name only exists from v144');
    assert.match(trigger, /else[\s\S]{0,160}p\.username/,
      'an older database still collects the handle');
    assert.ok(trigger.indexOf('display_name') < trigger.indexOf('perform public.sr_purge_identity'),
      'both are collected before the purge runs');
  });

  test('the by-hand removal refuses a row that belongs to a living account', () => {
    assert.match(TOOL, /'error', 'live_account'/,
      'a living account is never removed from a club by name');
    assert.match(TOOL, /Authentication -> Users/,
      'and the operator is told what to do instead');
    assert.match(TOOL, /into v_live\s*\n\s*from auth\.users u/,
      'the check is against auth.users, not against the shape of the key');
    // the refusal has to happen before anything is written
    assert.ok(TOOL.indexOf('live_account') < TOOL.indexOf('delete from public.crew_members'),
      'the refusal comes before the delete');
  });

  test('the removal is dry-runnable, subtracts what the member contributed and tombstones the keys', () => {
    assert.match(TOOL, /if p_dry_run then/, 'a preview exists');
    assert.ok(TOOL.indexOf('if p_dry_run then') < TOOL.indexOf('delete from public.crew_members'),
      'and returns before anything is deleted');
    assert.match(TOOL, /greatest\(0, c\.weekly_meters - x\.wm\)/,
      'the club loses that member\'s kilometres, never below zero');
    assert.match(TOOL, /insert into public\.sr_purged_players \(key, names\)\s*\n\s*select k, '\{\}'::text\[\]/,
      'the keys are tombstoned so the RUNNING server drops the member without a restart');
    const insert = TOOL.slice(TOOL.indexOf('insert into public.sr_purged_players'));
    assert.ok(!/p_name/.test(insert.slice(0, 400)), 'and never the display name, which other racers may share');
    assert.match(TOOL, /leader_uid = \(/, 'leadership is handed on if the leader was the one removed');
  });

  test('the removal never touches the club itself and is not reachable with the anon key', () => {
    assert.ok(!/delete from public\.crews/.test(TOOL),
      'no statement deletes a club - emptying a club is not deleting it');
    assert.match(TOOL, /revoke all on function public\.sr_remove_club_member\(text, text, boolean\) from anon/,
      'service role only');
    assert.match(TOOL, /'error', 'member_not_found'/, 'a wrong name is reported, not guessed at');
    assert.match(TOOL, /'roster', v_after/,
      'and the real roster is handed back so the next call can copy a name from it');
  });
});

describe('v158.5 — the club a purge touches is fixed on the spot, not on the next restart', () => {
  const http = require('node:http');
  let srv, base;
  const APEX = () => memCrews.get('apex');
  const club = async (id) => {
    const res = await fetch(base + '/api/crews/' + id);
    return { status: res.status, json: await res.json() };
  };

  before(async () => {
    await new Promise((r) => { srv = http.createServer(S.app); srv.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + srv.address().port; r(); }); });
  });
  after(async () => { if (srv) await new Promise((r) => srv.close(r)); });
  beforeEach(() => { calls.length = 0; });

  test('a pre-seeded club reads its stored roster instead of its empty RAM copy', async () => {
    // The five built-in clubs are seeded into memory at boot WITH NO MEMBERS, so
    // "hydrate only when the club is not in memory" meant their stored rosters
    // were never read: a club that really has members answered with nobody.
    const fresh = memCrews.get('apex');
    fresh.members = []; fresh.weeklyMeters = 0; fresh.totalMeters = 0; fresh.weeklyPoints = 0;
    hydrated.delete('crew|apex');   // a fresh boot's state for this club
    responder = async (u) => {
      if (u.startsWith(SB + '/rest/v1/crews?')) {
        return { ok: true, status: 200, json: async () => [{ id: 'apex', tag: 'REDL', name: 'Redline Motorsport', weekly_meters: 4000, total_meters: 9000, weekly_points: 12, week_key: '2026-W40', seeded: true }] };
      }
      if (u.startsWith(SB + '/rest/v1/crew_members')) {
        return { ok: true, status: 200, json: async () => [{ crew_id: 'apex', member_key: V, name: 'SURVIVOR', role: 'leader', aliases: [V], weekly_meters: 4000, total_meters: 9000, weekly_points: 12, week_key: '2026-W40' }] };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    const { status, json } = await club('apex');
    assert.equal(status, 200);
    assert.deepEqual(json.crew.members.map((m) => m.name), ['SURVIVOR'],
      'the stored member is on the roster even though the club was already in RAM');
    assert.equal(json.crew.totalKm, 9, 'and so is the distance they put in');
  });

  test('opening a club drops a member the tombstones have taken', async () => {
    // A deletion is at most one small query away from being visible: the roster
    // read checks for new tombstones itself instead of waiting for the 60 s poll.
    seedCaches();
    responder = async (u) => {
      if (u.startsWith(SB + '/rest/v1/sr_purged_players')) {
        return { ok: true, status: 200, json: async () => [{ key: U, names: [NAME], purged_at: new Date().toISOString() }] };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    purgedKeys.clear(); purgedNames.clear();
    // the roster check is throttled to one small query every couple of seconds,
    // so wait the throttle out rather than depend on how fast the test runs
    await new Promise((r) => setTimeout(r, 2100));

    const { json } = await club('apex');
    const names = json.crew.members.map((m) => m.name);
    assert.ok(!names.includes(NAME), 'the purged racer is not on the roster: ' + names.join(','));
    assert.ok(names.includes('SURVIVOR'), 'and the racer beside them still is');
    assert.ok(calls.some((c) => c.url.includes('sr_purged_players')),
      'the read consulted the tombstone table');
  });
});

describe('v158.6 — a club renamed in the SQL editor appears without a restart', () => {
  const http = require('node:http');
  const TOOL = fs.readFileSync(path.join(ROOT, 'scripts', 'rename-club.sql'), 'utf8');
  let srv, base;
  before(async () => {
    await new Promise((r) => { srv = http.createServer(S.app); srv.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + srv.address().port; r(); }); });
  });
  after(async () => { if (srv) await new Promise((r) => srv.close(r)); });

  test('the wording timestamp only moves for wording, and the server polls it', () => {
    // The trigger is what makes a rename visible to a running server, and the
    // thing that keeps it cheap is that a counter moving is NOT a rename: if it
    // bumped on every settlement, every club read would re-read every club.
    assert.match(SQL, /create or replace function public\.sr_crews_touch\(\)/,
      'the wording trigger exists in the migration');
    const fn = SQL.slice(SQL.indexOf('create or replace function public.sr_crews_touch'), SQL.indexOf('drop trigger if exists sr_crews_touch'));
    assert.match(fn, /new\.name is distinct from old\.name/, 'a name change bumps it');
    assert.match(fn, /new\.tag is distinct from old\.tag/, 'so does a tag change');
    assert.match(fn, /new\.updated_at := old\.updated_at;/, 'and anything else does not');
    assert.match(SQL, /alter table if exists public\.crews\s*\n\s*add column if not exists updated_at timestamptz not null default now\(\)/,
      'the column is added by the same file, for a database that predates it');
    // the read path the client actually uses
    const roster = SERVER_SRC.slice(SERVER_SRC.indexOf("app.get('/api/crews/:id'"), SERVER_SRC.indexOf("app.get('/api/player/crew'"));
    assert.match(roster, /await touchCrewNames\(\)/, 'opening a club checks for renames');
    const board = SERVER_SRC.slice(SERVER_SRC.indexOf("app.get(['/api/crews'"), SERVER_SRC.indexOf("app.get('/api/crews/:id'"));
    assert.match(board, /await touchCrewNames\(\)/, 'and so does the board');
  });

  test('a renamed row replaces the wording the server already held', async () => {
    // a user-created club: the database owns ITS wording. The five built-in
    // clubs keep the game's own wording (and the rename tool refuses them).
    const id = 'renametest';
    memCrews.set(id, { id, tag: 'OLD', name: 'Old Name', motto: 'old motto', badge: 'bolt', color: '#fff', leaderUid: null, members: [], weeklyMeters: 0, totalMeters: 0, weeklyPoints: 0 });
    forgetHydration('crew|' + id);
    hydrated.delete('crew|' + id);
    responder = async (u) => {
      if (u.startsWith(SB + '/rest/v1/crews?')) {
        return { ok: true, status: 200, json: async () => [{ id, tag: 'NEWT', name: 'New Name', motto: 'new motto', badge: 'bolt', color: '#fff', weekly_meters: 0, total_meters: 0, weekly_points: 0, week_key: '2026-W40', seeded: false }] };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    await S.hydrateCrew(id);
    assert.equal(memCrews.get(id).name, 'New Name', 'the row owns the wording, not the cache');
    assert.equal(memCrews.get(id).tag, 'NEWT');
    assert.equal(memCrews.get(id).motto, 'new motto');
    memCrews.delete(id);
  });

  test('the rename tool validates with the game\'s own rules and never touches members', () => {
    assert.match(TOOL, /'error', 'built_in_club'/, 'the game\'s own clubs cannot be renamed');
    assert.match(TOOL, /'error', 'tag_taken'/, 'a tag another club uses is refused');
    assert.match(TOOL, /'error', 'invalid_crew_name'/);
    assert.match(TOOL, /'error', 'invalid_crew_tag'/);
    assert.match(TOOL, /'error', 'club_not_found'/, 'an unknown club reports, never guesses');
    assert.match(TOOL, /'error', 'nothing_to_change'/, 'and so does a no-op');
    const from = TOOL.indexOf('update public.crews c');
    const upd = TOOL.slice(from, TOOL.indexOf('select jsonb_build_object', from));
    assert.match(upd, /set name = v_name, tag = v_tag, motto = v_motto, badge = v_badge, color = v_color/,
      'only the wording columns are written');
    assert.ok(!/crew_members|delete from/.test(upd), 'no member row and no delete anywhere near it');
    assert.match(TOOL, /p_dry_run/, 'a preview exists');
    assert.ok(TOOL.indexOf('if p_dry_run then') < TOOL.indexOf('update public.crews c'), 'and stops before the write');
    assert.match(TOOL, /revoke all on function public\.sr_rename_club\(text, text, boolean, text, text, text, text\) from anon/,
      'service role only');
    // the tool must work on a database that has never seen the new column
    assert.match(TOOL, /add column if not exists updated_at timestamptz not null default now\(\)/,
      'it carries the schema change it needs, so one paste is enough');
    assert.match(TOOL, /create trigger sr_crews_touch/, 'including the trigger');
    assert.match(TOOL, /The board and the club page pick it up by themselves/,
      'and the operator is told the running server will pick it up without a restart');
  });
});


describe('v158.7 — a name tombstone must not erase the racer who is still here', () => {
  // THE BUG THIS PINS. The user deleted their account in Supabase, signed up
  // again with the same driver name, and could not join a club: the join
  // answered 200 {ok:true}, the screen said "Joined!", and the roster row was
  // silently dropped before it was written, because the tombstone carried the
  // display name and the write path treated a name as decisive. The next reload
  // read the database and the club was gone. A KEY is decisive; a NAME is only
  // decisive when it is all the identity has.
  const http = require('node:http');
  const GAME = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game.js'), 'utf8');
  const NAME2 = 'SRIDHAR';
  const DEAD = '11111111-1111-4111-8111-111111111111';  // the account that was deleted
  const NEW = '22222222-2222-4222-8222-222222222222';   // the account signing in today
  const ME = { uid: NAME2, pid: 'sb:' + NEW, sbUid: NEW, name: NAME2 };
  let srv, base;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const joinBody = (extra) => Object.assign({}, ME, { crewId: 'jointest', name: NAME2 }, extra || {});
  const seedClub = () => {
    memCrews.set('jointest', {
      id: 'jointest', tag: 'JNT', name: 'Join Test', motto: 'm', badge: 'bolt', color: '#fff',
      leaderUid: 'someone-else', members: [], weeklyMeters: 0, totalMeters: 0, weeklyPoints: 0
    });
    forgetHydration('crew|jointest');
    hydrated.delete('crew|jointest');
  };

  before(async () => {
    await new Promise((r) => { srv = http.createServer(S.app); srv.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + srv.address().port; r(); }); });
  });
  after(async () => {
    if (srv) await new Promise((r) => srv.close(r));
    memCrews.delete('jointest');
  });
  beforeEach(() => {
    calls.length = 0;
    purgedKeys.clear(); purgedNames.clear();
    seedClub();
    responder = async (u) => {
      // v163: the default account check answers "that account is gone", which is
      // the honest answer for a tombstoned uuid unless a test says otherwise.
      if (u.startsWith(SB + '/auth/v1/admin/users/')) {
        return { ok: false, status: 404, json: async () => ({ message: 'User not found' }), text: async () => '' };
      }
      if (u.startsWith(SB + '/rest/v1/crews?')) {
        return { ok: true, status: 200, json: async () => [{ id: 'jointest', tag: 'JNT', name: 'Join Test', motto: 'm', badge: 'bolt', color: '#fff', weekly_meters: 0, total_meters: 0, weekly_points: 0, seeded: false }] };
      }
      return { ok: true, status: 201, json: async () => [] };
    };
  });

  test('the write keeps a row with a live account uuid beside a tombstoned name', () => {
    noteTombstones([{ key: DEAD, names: [NAME2], purged_at: new Date().toISOString() }]);
    const row = { crew_id: 'jointest', member_key: 'sridhar', name: NAME2, role: 'leader', aliases: ['sridhar', NEW], weekly_meters: 0, total_meters: 0, weekly_points: 0 };
    assert.deepEqual(S.dropPurgedRows([row]), [row],
      'the roster row is written: the same row carries an account uuid the tombstones do not name');
    assert.deepEqual(S.dropPurgedRows([Object.assign({}, row, { aliases: ['sridhar'] })]), [],
      'a row that is nothing but the erased name is still dropped');
    assert.deepEqual(S.dropPurgedRows([Object.assign({}, row, { member_key: DEAD, aliases: [DEAD] })]), [],
      'and a tombstoned KEY always drops, whatever else the row says');
    assert.equal(S.purgeNameIsSoleIdentity(NAME2, ['sridhar', NEW]), false, 'the helper says why');
    assert.equal(S.purgeNameIsSoleIdentity(NAME2, ['sridhar']), true);
  });

  test('the sweep keeps the living member and still takes the erased one out', () => {
    noteTombstones([{ key: DEAD, names: [NAME2], purged_at: new Date().toISOString() }]);
    const c = memCrews.get('jointest');
    c.members = [{ uid: 'sridhar', name: NAME2, role: 'leader', aliases: ['sridhar', NEW], weeklyMeters: 1000, totalMeters: 2000, weeklyPoints: 5, joined_at: '2026-01-01T00:00:00Z' }];
    c.weeklyMeters = 1000; c.totalMeters = 2000; c.weeklyPoints = 5;
    evictPurged();
    assert.equal(c.members.length, 1, 'the member whose row carries a live uuid stayed');
    assert.equal(c.members[0].role, 'leader', 'and keeps the club');
    assert.equal(c.weeklyMeters, 1000, 'and their kilometres still count');

    c.members = [{ uid: 'sridhar', name: NAME2, role: 'member', aliases: [], weeklyMeters: 400, totalMeters: 900, weeklyPoints: 4, joined_at: '2026-01-02T00:00:00Z' }];
    c.weeklyMeters = 400; c.totalMeters = 900; c.weeklyPoints = 4;
    evictPurged();
    assert.equal(c.members.length, 0, 'a row that is nothing but the erased name is still taken out');
    assert.equal(c.weeklyMeters, 0, 'and its kilometres come off the club');
  });

  test('the join stores the membership, and the reply says so', async () => {
    noteTombstones([{ key: DEAD, names: [NAME2], purged_at: new Date().toISOString() }]);
    const res = await post('/api/player/crew/join', joinBody());
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true, 'the join is accepted');
    assert.equal(res.json.stored, true, 'and the reply says the roster row landed');
    assert.equal(res.json.pending, false);
    assert.equal(res.json.durable, true, 'with a database configured, the racer is told the truth');
    const writes = calls.filter((x) => x.method === 'POST' && x.url.includes('/crew_members'));
    assert.equal(writes.length, 1, 'the roster row was really offered to the database');
    assert.equal(writes[0].json[0].member_key, 'sridhar');
    assert.ok(writes[0].json[0].aliases.includes(NEW), 'with the live account uuid among its aliases');
  });

  test('a racer the purge erased is refused with the reason, not with a 200', async () => {
    noteTombstones([{ key: NEW, names: [NAME2], purged_at: new Date().toISOString() }]);
    const res = await post('/api/player/crew/join', joinBody());
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'racer_erased');
    assert.ok(!calls.some((x) => x.method === 'POST' && x.url.includes('/crew_members')), 'and nothing was written');
  });

  test('a refused write is reported as refused, not dressed up as a join', async () => {
    noteTombstones([{ key: DEAD, names: [NAME2], purged_at: new Date().toISOString() }]);
    responder = async (u, opts) => {
      if (u.startsWith(SB + '/rest/v1/crews?')) {
        return { ok: true, status: 200, json: async () => [{ id: 'jointest', tag: 'JNT', name: 'Join Test', motto: 'm', badge: 'bolt', color: '#fff', weekly_meters: 0, total_meters: 0, weekly_points: 0, seeded: false }] };
      }
      if (u.startsWith(SB + '/rest/v1/crew_members') && opts && opts.method === 'POST') {
        return { ok: false, status: 400, json: async () => ({ message: 'nope' }), text: async () => 'nope' };
      }
      return { ok: true, status: 201, json: async () => [], text: async () => '' };
    };
    const res = await post('/api/player/crew/join', joinBody());
    assert.equal(res.status, 200, 'the racer is still in the club for this session');
    assert.equal(res.json.ok, true);
    assert.equal(res.json.stored, false, 'but the reply does not pretend the roster row was stored');
    assert.equal(res.json.pending, false, 'it waited for the answer');
  });

  test('a deleted DEVICE identity is replaced, and the membership is stored under the new one', async () => {
    // A tombstoned KEY bars every row naming it - forever, by design. But a guest's
    // key is a device id the browser keeps sending, so erasing that account locked
    // the browser out of every club with no way back (the id is only generated when
    // it is missing). The racer stays erased; the person gets a new empty one.
    const OLD_PID = 'polddevice1';
    noteTombstones([{ key: OLD_PID, names: [], purged_at: new Date().toISOString() }]);

    const ids = { uid: OLD_PID, pid: OLD_PID, sbUid: '', name: NAME2 };
    const verdict = S.healErasedGuestIdentity(ids);
    assert.equal(verdict.erased, true);
    assert.equal(verdict.account, false, 'a device key is not an account');
    assert.match(verdict.freshPid, /^p[a-z0-9]+$/, 'a fresh device key is minted');
    assert.equal(ids.pid, verdict.freshPid, 'the request goes on as the new racer');
    assert.equal(ids.uid, verdict.freshPid);
    assert.notEqual(ids.pid, OLD_PID, 'and never as the erased one');

    const res = await post('/api/player/crew/join', { uid: OLD_PID, pid: OLD_PID, sbUid: '', name: NAME2, crewId: 'jointest' });
    assert.equal(res.status, 200, 'the join is accepted instead of dead-ending');
    assert.equal(res.json.ok, true);
    assert.equal(res.json.reset, true, 'and the client is told the racer starts fresh');
    assert.match(res.json.newPid, /^p[a-z0-9]+$/);
    const write = calls.find((x) => x.method === 'POST' && x.url.includes('/crew_members'));
    assert.ok(write, 'the roster row is written under the new key');
    assert.equal(write.json[0].member_key, res.json.newPid);
    assert.ok(!JSON.stringify(write.json).includes(OLD_PID), 'no row naming the erased key is ever written');
  });

  test('a deleted ACCOUNT is still refused, because its uuid is the account', async () => {
    noteTombstones([{ key: NEW, names: [NAME2], purged_at: new Date().toISOString() }]);
    const ids = { uid: NAME2, pid: 'sb:' + NEW, sbUid: NEW, name: NAME2 };
    const verdict = S.healErasedGuestIdentity(ids);
    assert.equal(verdict.erased, true);
    assert.equal(verdict.account, true, 'a uuid is an account, not a device');
    assert.equal(verdict.freshPid, '', 'no new identity is invented for it');
    const res = await post('/api/player/crew/join', Object.assign({}, ids, { crewId: 'jointest' }));
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'racer_erased');
    // and founding a club is refused the same way, instead of writing a club whose
    // leader's roster row can never be stored
    const made = await post('/api/player/crew/create', { uid: NAME2, pid: 'sb:' + NEW, sbUid: NEW, name: NAME2, crewName: 'Deleted Racer Club', tag: 'DRCL' });
    assert.equal(made.status, 403);
    assert.equal(made.json.error, 'racer_erased');
    assert.ok(!calls.some((x) => x.method === 'POST' && x.url.includes('/rest/v1/crews')), 'nothing was created');
  });

  test('a live identity is left completely alone', () => {
    noteTombstones([{ key: DEAD, names: [NAME2], purged_at: new Date().toISOString() }]);
    const ids = { uid: NAME2, pid: 'plivedevice1', sbUid: '', name: NAME2 };
    const verdict = S.healErasedGuestIdentity(ids);
    assert.equal(verdict.erased, false, 'the name is tombstoned but the device key is not');
    assert.equal(verdict.freshPid, '');
    assert.equal(ids.pid, 'plivedevice1', 'their identity is untouched');
    assert.ok(S.freshGuestPid().length > 8, 'the minted key looks like the client\'s own');
  });

  test('a driver name the purge recorded as a KEY does not lock the living account out', async () => {
    // THE USER'S CASE, to the letter. The client sends the driver name in the uid
    // slot (crewIdentity()), so a signed-in racer's roster row is keyed by the
    // display name. When that account is deleted, the purge's roster widening
    // records that display name as a KEY - and v159.1 then refused every later
    // join with racer_erased, for ever, for the same person signing up again.
    // A name is not an account, and a live account is never the erased racer.
    noteTombstones([{ key: 'sridhar', names: [NAME2], purged_at: new Date().toISOString() }]);
    const ids = { uid: NAME2, pid: 'sb:' + NEW, sbUid: NEW, name: NAME2 };
    const verdict = S.healErasedGuestIdentity(ids);
    assert.equal(verdict.erased, true, 'the tombstone does name something in the request');
    assert.equal(verdict.account, false, 'but the account is alive, so the racer is not erased');
    assert.equal(verdict.identity, NEW, 'the roster row is keyed on the live account');
    assert.equal(ids.uid, NEW, 'and the tombstoned name is not carried any further');

    const res = await post('/api/player/crew/join', Object.assign({}, ids, { crewId: 'jointest' }));
    assert.equal(res.status, 200, 'the join is accepted instead of dead-ending');
    assert.equal(res.json.ok, true);
    const write = calls.find((x) => x.method === 'POST' && x.url.includes('/crew_members'));
    assert.ok(write, 'and the roster row is written');
    assert.equal(write.json[0].member_key, NEW, 'keyed on the live account, not the tombstoned name');
    assert.ok(!(write.json[0].aliases || []).includes('sridhar'), 'no alias names it either');
  });

  test('a device key erased in a guest past does not refuse the account either', async () => {
    noteTombstones([{ key: 'polddevice1', names: [], purged_at: new Date().toISOString() }]);
    const ids = { uid: NAME2, pid: 'polddevice1', sbUid: NEW, name: NAME2 };
    const verdict = S.healErasedGuestIdentity(ids);
    assert.equal(verdict.account, false, 'a device key is never an account');
    assert.equal(ids.pid, 'sb:' + NEW, 'the erased device key is replaced by the account form');
    const res = await post('/api/player/crew/join', Object.assign({}, ids, { crewId: 'jointest' }));
    assert.equal(res.status, 200);
    const write = calls.find((x) => x.method === 'POST' && x.url.includes('/crew_members'));
    assert.ok(write, 'the roster row is written');
    assert.ok(!JSON.stringify(write.json).includes('polddevice1'), 'and never names the erased device');
  });

  test('a racer whose ONLY identity is a tombstoned driver name gets a device key too', async () => {
    // The shape a browser has with no device key at all (cleared storage, a private
    // window): uid falls back to the name and pid is empty, so the roster row would
    // be keyed on the name - and a tombstoned name drops that row for EVERY club.
    // This is the second way the user's "I cannot join ANY club" is reachable.
    noteTombstones([{ key: DEAD, names: [NAME2], purged_at: new Date().toISOString() }]);
    const ids = { uid: NAME2, pid: '', sbUid: '', name: NAME2 };
    const verdict = S.healErasedGuestIdentity(ids);
    assert.equal(verdict.erased, true, 'the name is tombstoned');
    assert.equal(verdict.account, false, 'a name is not an account');
    assert.match(verdict.freshPid, /^p[a-z0-9]+$/, 'a device key is minted for them');
    assert.equal(ids.uid, verdict.freshPid, 'and the request goes on keyed on it, not on the bare name');

    const res = await post('/api/player/crew/join', { uid: NAME2, pid: '', sbUid: '', name: NAME2, crewId: 'jointest' });
    assert.equal(res.status, 200, 'the join is accepted instead of writing nothing');
    assert.equal(res.json.reset, true);
    const write = calls.find((x) => x.method === 'POST' && x.url.includes('/crew_members'));
    assert.ok(write, 'the roster row is written instead of being dropped for naming a tombstoned name');
    assert.equal(write.json[0].member_key, res.json.newPid);
    assert.ok(!(write.json[0].aliases || []).includes('sridhar'), 'and no alias names it');
  });

  test('a name no tombstone names is left as the key', () => {
    noteTombstones([{ key: DEAD, names: [NAME2], purged_at: new Date().toISOString() }]);
    const ids = { uid: 'SOMEONEELSE', pid: '', sbUid: '', name: 'SOMEONEELSE' };
    const verdict = S.healErasedGuestIdentity(ids);
    assert.equal(verdict.erased, false);
    assert.equal(verdict.freshPid, '');
    assert.equal(ids.uid, 'SOMEONEELSE', 'nothing is invented for a living name');
  });

  test('a tombstone that names a LIVE account is cleared, and the join goes through', async () => {
    // THE TRAP THIS BREAKS. A tombstone can name an account that can still sign
    // in - a hand-erased key, an admin purge with the wrong id. Every join then
    // answered "this account was deleted" while signing in again handed back the
    // SAME uuid, so the advice repeated for ever. Auth is the authority: the user
    // is still there, so the tombstone is wrong and goes.
    noteTombstones([{ key: NEW, names: [NAME2], purged_at: new Date().toISOString() }]);
    responder = async (u) => {
      if (u.startsWith(SB + '/auth/v1/admin/users/')) return { ok: true, status: 200, json: async () => ({ id: NEW }), text: async () => '' };
      if (u.startsWith(SB + '/rest/v1/crews?')) {
        return { ok: true, status: 200, json: async () => [{ id: 'jointest', tag: 'JNT', name: 'Join Test', motto: 'm', badge: 'bolt', color: '#fff', weekly_meters: 0, total_meters: 0, weekly_points: 0, seeded: false }] };
      }
      return { ok: true, status: 201, json: async () => [] };
    };
    const res = await post('/api/player/crew/join', joinBody());
    assert.equal(res.status, 200, 'the join is accepted - the account is alive');
    assert.equal(res.json.ok, true);
    const cleared = calls.filter((x) => x.method === 'DELETE' && x.url.includes('sr_purged_players'));
    assert.ok(cleared.length >= 1, 'the stale tombstone row is deleted: ' + JSON.stringify(cleared.map((c) => c.url)));
    assert.ok(!purgedKeys.has(NEW), 'and the running server forgets the key at once');
    const write = calls.find((x) => x.method === 'POST' && x.url.includes('/crew_members'));
    assert.ok(write, 'the roster row is written');
    assert.ok(!JSON.stringify(write.json[0]).includes('"member_key":"' + NEW + '"') || write.json[0].member_key === NEW);
    // founding a club can no longer be refused for the same stale reason either
    calls.length = 0;
    const made = await post('/api/player/crew/create', { uid: NAME2, pid: 'sb:' + NEW, sbUid: NEW, name: NAME2, crewName: 'Living Racer Club', tag: 'LIVE' });
    assert.equal(made.status, 200, 'and the club can be founded');
  });

  test('an account check that cannot be made is reported, not guessed', async () => {
    noteTombstones([{ key: NEW, names: [NAME2], purged_at: new Date().toISOString() }]);
    responder = async (u) => {
      if (u.startsWith(SB + '/auth/v1/admin/users/')) return { ok: false, status: 500, json: async () => ({ message: 'auth down' }), text: async () => '' };
      if (u.startsWith(SB + '/rest/v1/crews?')) {
        return { ok: true, status: 200, json: async () => [{ id: 'jointest', tag: 'JNT', name: 'Join Test', motto: 'm', badge: 'bolt', color: '#fff', weekly_meters: 0, total_meters: 0, weekly_points: 0, seeded: false }] };
      }
      return { ok: true, status: 201, json: async () => [] };
    };
    const res = await post('/api/player/crew/join', joinBody());
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'account_check_failed', 'the racer is told the check failed, not that they are deleted');
    assert.ok(!calls.some((x) => x.method === 'DELETE'), 'and nothing is deleted on a guess');
  });

  test('the account check only ever runs for a tombstoned account', async () => {
    noteTombstones([{ key: DEAD, names: [NAME2], purged_at: new Date().toISOString() }]);
    const res = await post('/api/player/crew/join', joinBody());   // NEW is not tombstoned
    assert.equal(res.status, 200);
    assert.equal(calls.filter((x) => x.url.includes('/auth/v1/admin/users/')).length, 0,
      'a living account costs no extra round trip');
  });

  test('the account check answers from the status alone', async () => {
    responder = async () => ({ ok: true, status: 200, json: async () => ({ id: NEW }), text: async () => '' });
    assert.equal(await S.accountExistsInAuth(NEW), true, 'a user Supabase still has');
    responder = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    assert.equal(await S.accountExistsInAuth(NEW), false, 'a user it does not have');
    responder = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
    assert.equal(await S.accountExistsInAuth(NEW), null, 'a key that is not allowed to ask is not an answer');
    responder = async () => { throw new Error('offline'); };
    assert.equal(await S.accountExistsInAuth(NEW), null, 'nor is a network that is down');
    assert.equal(await S.accountExistsInAuth('sridhar'), null, 'and a display name is never asked about');
  });

  test('the client says why, and never hides it behind "Failed to join crew"', () => {
    assert.match(GAME, /function crewJoinErrorText/, 'the reason is turned into words');
    assert.match(GAME, /code === 'invalid_uid'/, 'an identity that never arrived says so');
    assert.match(GAME, /code === 'racer_erased'/, 'an erased racer is told what to do about it');
    assert.match(GAME, /code === 'crew_not_found'/, 'a club that is gone says so');
    assert.match(GAME, /res\.durable && !res\.stored && !res\.pending/, 'a write that did not land is not toasted as success');
    assert.match(GAME, /Could not reach the game server/, 'a network failure is named as one');
    assert.ok(!/toast\([^\n]*Failed to join crew/.test(GAME), 'the toast that hid every one of these is gone');
  });
});

describe('v163 — a tombstone is not the last word on a living account', () => {
  const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'clean-stale-tombstones.sql'), 'utf8');
  const GAME_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game.js'), 'utf8');

  test('the SQL tool removes only the tombstones that name a live account', () => {
    assert.equal((SCRIPT.match(/delete from/gi) || []).length, 1, 'exactly one delete statement');
    assert.match(SCRIPT, /delete from public\.sr_purged_players p/, 'and it is on the tombstone table');
    assert.match(SCRIPT, /from auth\.users u/, 'the live-account test reads auth.users');
    assert.match(SCRIPT, /regexp_replace\(lower\(p\.key\), '\^sb:', ''\)/, "it handles the 'sb:<uuid>' form");
    const beforeDelete = SCRIPT.slice(0, SCRIPT.indexOf('delete from'));
    assert.match(beforeDelete, /select p\.key, p\.names, p\.purged_at/, 'a preview comes first');
    assert.match(SCRIPT, /Ctrl\+A/, 'and it reminds the operator to select the whole file first');
    assert.match(SCRIPT, /RESTART THE GAME SERVER/, 'and that a running server must be restarted once');
    assert.match(SCRIPT, /no stats, no club, no race history/, 'and says what it never touches');
  });

  test('the client repairs a deleted account instead of handing back advice', () => {
    assert.match(GAME_SRC, /function crewSignedIn\(\)/, 'the client knows whether it holds a session');
    assert.match(GAME_SRC, /SRAccount\.logout\(\)/, 'it signs a deleted session out');
    assert.match(GAME_SRC, /guestAfterErase: true/, 'and retries the same click as a guest');
    assert.match(GAME_SRC, /account_check_failed/, 'an unreachable check is named, not guessed');
    assert.match(GAME_SRC, /const retriedAsGuest = /, 'the retry cannot loop for ever');
  });
});

describe('v158.8 — deleting a club is the leader\'s own action', () => {
  const http = require('node:http');
  const TOOL = fs.readFileSync(path.join(ROOT, 'scripts', 'delete-club.sql'), 'utf8');
  const GAME = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game.js'), 'utf8');
  const DEL_SRC = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/player/crew/delete'"), SERVER_SRC.indexOf("app.post('/api/player/crew/create'"));
  const MATE_U = '33333333-7777-4777-8777-333333333333';   // its own uuid: V belongs to the v158 seeding
  const LEADER = { uid: 'SRIDHAR', pid: 'sb:' + U, sbUid: U, name: 'SRIDHAR' };
  const MATE = { uid: 'MATE', pid: 'sb:' + MATE_U, sbUid: MATE_U, name: 'MATE' };
  let srv, base;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, json: await r.json() }; };
  const seedDeleted = () => {
    memCrews.set('deltest', {
      id: 'deltest', tag: 'DELT', name: 'Delete Test', motto: 'm', badge: 'bolt', color: '#fff',
      leaderUid: 'SRIDHAR', members: [
        { uid: 'SRIDHAR', name: 'SRIDHAR', role: 'leader', weeklyMeters: 1000, totalMeters: 3000, weeklyPoints: 9, aliases: ['sridhar', U], joined_at: '2026-01-01T00:00:00Z' },
        { uid: 'MATE', name: 'MATE', role: 'member', weeklyMeters: 500, totalMeters: 1500, weeklyPoints: 4, aliases: ['mate', MATE_U], joined_at: '2026-01-02T00:00:00Z' }
      ],
      weeklyMeters: 1500, totalMeters: 4500, weeklyPoints: 13
    });
    memPlayerCrew.set('SRIDHAR', 'deltest');
    memPlayerCrew.set(U, 'deltest');
    memPlayerCrew.set(MATE_U, 'deltest');
    memCrewAliases.set('sridhar', 'deltest');
    memCrewAliases.set(U, 'deltest');
    memCrewAliases.set(MATE_U, 'deltest');
    memCrewNameHints.set('sridhar', new Set(['deltest']));
    memClaimedCrewMilestones.set(crewClaimKey('deltest', 1, 'sridhar', '2026-W40'), true);
    memClaimedCrewMilestones.set(crewClaimKey('apex', 1, 'someone', '2026-W40'), true);
    forgetHydration('crew|deltest');
    hydrated.delete('crew|deltest');
  };

  before(async () => {
    await new Promise((r) => { srv = http.createServer(S.app); srv.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + srv.address().port; r(); }); });
  });
  after(async () => {
    if (srv) await new Promise((r) => srv.close(r));
    memCrews.delete('deltest');
  });
  afterEach(() => {
    memPlayerCrew.delete('SRIDHAR'); memPlayerCrew.delete(U); memPlayerCrew.delete(MATE_U);
    memCrewAliases.delete('sridhar'); memCrewAliases.delete(U); memCrewAliases.delete(MATE_U);
    memCrewNameHints.delete('sridhar');
    memClaimedCrewMilestones.delete(crewClaimKey('deltest', 1, 'sridhar', '2026-W40'));
    memCrews.delete('deltest');
  });
  beforeEach(() => {
    calls.length = 0;
    seedDeleted();
    responder = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' });
  });

  test('only the leader, and never a built-in club', async () => {
    const member = await post('/api/player/crew/delete', Object.assign({}, MATE, { crewId: 'deltest' }));
    assert.equal(member.status, 403);
    assert.equal(member.json.error, 'not_leader', 'a plain member cannot delete the club');
    const stranger = await post('/api/player/crew/delete', { uid: 'NOBODY', pid: 'p', sbUid: '', name: 'NOBODY', crewId: 'deltest' });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.json.error, 'not_leader');
    const seeded = await post('/api/player/crew/delete', Object.assign({}, LEADER, { crewId: 'apex' }));
    assert.equal(seeded.status, 403);
    assert.equal(seeded.json.error, 'seeded_club', 'the game\'s own clubs are not the leader\'s to delete');
    const unknown = await post('/api/player/crew/delete', Object.assign({}, LEADER, { crewId: 'nosuchclub' }));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, 'crew_not_found');
    assert.ok(!calls.some((c) => c.method === 'DELETE'), 'nothing was deleted by any of the refusals');
    assert.ok(memCrews.has('deltest'), 'and the club is still there');
  });

  test('the leader deletes it, and the running server forgets it everywhere', async () => {
    const res = await post('/api/player/crew/delete', Object.assign({}, LEADER, { crewId: 'deltest' }));
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.members, 2, 'the reply says how many racers were released');

    const dels = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    assert.ok(dels.some((u) => u.includes('/crews?') && u.includes('id=eq.deltest')), 'the club row is deleted');
    assert.ok(dels.some((u) => u.includes('/crew_members?') && u.includes('crew_id=eq.deltest')), 'its roster rows are deleted');
    assert.ok(dels.some((u) => u.includes('/crew_milestone_claims?') && u.includes('crew_id=eq.deltest')), 'its claims are deleted');
    assert.equal(dels.length, 3, 'and nothing else in the database is touched');
    assert.ok(!calls.some((c) => /player_stats|leaderboard|ghosts|player_wallet/.test(c.url)), 'no racer table is named');

    assert.ok(!memCrews.has('deltest'), 'the club is out of memory');
    assert.ok(!memPlayerCrew.has('SRIDHAR') && !memPlayerCrew.has(U) && !memPlayerCrew.has(MATE_U), 'every member is unbound from it');
    assert.ok(!memCrewAliases.has('sridhar') && !memCrewAliases.has(U) && !memCrewAliases.has(MATE_U), 'and their identity aliases are released');
    assert.ok(!memCrewNameHints.has('sridhar'), 'including the loose name hint');
    assert.ok(!memClaimedCrewMilestones.has(crewClaimKey('deltest', 1, 'sridhar', '2026-W40')), 'its claims leave memory too');
    assert.ok(memClaimedCrewMilestones.has(crewClaimKey('apex', 1, 'someone', '2026-W40')), 'another club\'s claims stay');

    const board = await get('/api/crews');
    assert.ok(!board.json.crews.some((c) => c.id === 'deltest'), 'the board no longer lists it');
    assert.ok(board.json.crews.some((c) => c.id === 'apex'), 'and still lists the clubs that are left');
    const page = await get('/api/crews/deltest');
    assert.equal(page.status, 404);
    assert.equal(page.json.error, 'crew_not_found', 'its page is gone');
    const mine = await get('/api/player/crew?' + new URLSearchParams(MATE).toString());
    assert.equal(mine.json.hasCrew, false, 'and its members are clubless');
  });

  test('the leader is recognised through the roster row, not just one field', () => {
    const club = { id: 'x', leaderUid: 'pabc', members: [{ uid: 'pabc', name: 'OLD NAME', role: 'leader', aliases: ['old name', U] }] };
    assert.deepEqual(S.crewLeaderKeys(club), ['pabc', 'old name', U], 'both the club field and the leader row count');
    assert.equal(S.callerLeadsCrew(club, { uid: 'pabc' }), true, 'the founder deletes their own club');
    assert.equal(S.callerLeadsCrew(club, { uid: 'x', sbUid: U }), true, 'and can still do it from a signed-in identity');
    assert.equal(S.callerLeadsCrew(club, { uid: 'mate', sbUid: MATE_U }), false, 'a member cannot');
    assert.equal(S.callerLeadsCrew(club, { uid: 'nobody' }), false, 'and neither can a stranger');
    assert.match(DEL_SRC, /if \(SEEDED_CREW_IDS\.has\(cid\)\)/, 'the built-in clubs are refused by id');
    assert.ok(DEL_SRC.indexOf('SEEDED_CREW_IDS.has(cid)') < DEL_SRC.indexOf("sbDelete('crews'"), 'and the refusal comes before any delete');
    assert.ok(DEL_SRC.indexOf('callerLeadsCrew(c, ids)') < DEL_SRC.indexOf("sbDelete('crews'"), 'so does the leader check');
    assert.match(DEL_SRC, /if \(sbOn\(\) && !removed\) return res\.status\(502\)/,
      'a database that refuses the club delete leaves the club intact instead of half-deleting it');
  });

  test('the SQL tool deletes one club, its roster and its claims - nothing else', () => {
    assert.match(TOOL, /create or replace function public\.sr_delete_club\(\s*p_club\s+text,\s*p_dry_run boolean default false\s*\)/);
    assert.match(TOOL, /'error', 'built_in_club'/, 'the game\'s own clubs are refused');
    assert.match(TOOL, /'error', 'club_not_found'/, 'an unknown club reports, never guesses');
    assert.match(TOOL, /'error', 'ambiguous_name'/, 'two clubs with the same name are never a coin toss');
    assert.match(TOOL, /if p_dry_run then/, 'a preview exists');
    assert.ok(TOOL.indexOf('if p_dry_run then') < TOOL.indexOf('delete from public.crew_milestone_claims'),
      'and it returns before anything is deleted');
    assert.match(TOOL, /delete from public\.crew_milestone_claims where crew_id = v_id/);
    assert.match(TOOL, /delete from public\.crew_members where crew_id = v_id/);
    assert.match(TOOL, /delete from public\.crews c where c\.id = v_id/);
    const deletes = TOOL.match(/delete from [a-z_.]+/g) || [];
    assert.equal(deletes.length, 3, 'three deletes, all of them scoped to the one club: ' + deletes.join(', '));
    assert.ok(!/insert into|update public/.test(TOOL.slice(TOOL.indexOf('as $$') + 5, TOOL.indexOf('end $$;'))),
      'the tool writes no tombstone and updates nothing');
    const body = TOOL.slice(TOOL.indexOf('as $$') + 5, TOOL.indexOf('end $$;'));
    assert.ok(!/player_stats|player_wallet|leaderboard|race_history|ghosts/.test(body),
      'a racer\'s own data is not named by one statement of it');
    assert.match(TOOL, /to_regclass\('public\.crew_members'\)/, 'a database without the roster table still runs');
    assert.match(TOOL, /revoke all on function public\.sr_delete_club\(text, boolean\) from anon/, 'service role only');
    assert.match(TOOL, /keeps showing it until it restarts/, 'and the operator is told what a running server does afterwards');
    assert.match(TOOL, /42883/, 'the file names the error a lone call gives before the function exists');
    assert.match(TOOL, /Ctrl\+A/, 'and tells the operator to select the whole file before pasting');
    assert.match(TOOL, /Run this WHOLE FILE once/, 'the run order is spelled out');
  });

  test('the in-game button is the leader\'s, and it warns before it deletes', () => {
    assert.match(GAME, /window\.deleteCrewAction = async function/);
    assert.match(GAME, /c\.isLeader \|\| \(c\.members \|\| \[\]\)\.some\(\(m\) => m\.role === 'leader' && crewRowIsMe\(m, ci\)\)/,
      'the button is rendered for the leader and nobody else');
    assert.match(GAME, /crew-danger-btn/, 'it is the dangerous-looking button');
    assert.match(GAME, /if \(!confirm\(q\)\) return;/, 'and it asks first');
    assert.match(GAME, /racer\$\{n === 1 \? '' : 's'\} will be removed from the club/, 'naming what happens to the racers in it');
    assert.match(GAME, /cannot be undone/, 'and that it is irreversible');
    assert.match(GAME, /function crewDeleteErrorText/, 'refusals come back as words');
    assert.match(GAME, /code === 'not_leader'/, 'starting with who may do this');
    assert.match(GAME, /openCrewModal\('join'\)/, 'afterwards the board without the club is shown');
  });
});
