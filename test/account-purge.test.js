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

const { test, describe, beforeEach, after } = require('node:test');
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
  lbAdd, sbUpsert, hydrateMissions, hydrated, claimHydration
} = S;

const U = '11111111-2222-4333-8444-555555555555';   // the account being deleted
const SB_U = 'sb:' + U;                              // the form a signed-in client sends
const V = '99999999-8888-4777-8666-555555555555';   // the racer next to them, who stays
const NAME = 'GHOST_RIDER';
const PID = 'device-pid-abc123';                     // the same account's device identity

const ROOT = path.resolve(__dirname, '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase-migration-v158.sql'), 'utf8');

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

    const lead = body.slice(body.indexOf('update public.crews c'), body.indexOf('$sql$ using v_claims, v_crews;'));
    assert.match(lead, /where c\.id = any\(\$2\)/, 'the leadership repair is scoped the same way');
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
