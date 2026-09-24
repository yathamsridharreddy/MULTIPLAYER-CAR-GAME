'use strict';
// ---------------------------------------------------------------------------
// v95 AUDIT-P1 — durable progression.
//
// These tests drive the REAL server code against a stubbed Supabase: the env
// vars are set before server.js is required, so sbOn() is true in this process
// only (node --test gives every file its own process). The stub records every
// request the server makes and answers it, which is the only way to exercise
// these paths without a live project.
//
// What is being protected: a redeploy used to wipe missions, bounties and the
// equipped badge. A player who had driven 18 of 20 laps came back to zero, and a
// completed-but-unclaimed reward was refused with NOT_COMPLETED.
// ---------------------------------------------------------------------------
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const realFetch = global.fetch; // kept so the tests' own HTTP calls still work
const SB = 'https://fake.supabase.co';
const calls = [];
let responder = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' });

global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith(SB)) return realFetch(url, opts);
  calls.push({ url: u, method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {}, body: opts && opts.body ? JSON.parse(opts.body) : null });
  return responder(u, opts);
};

const S = require('../server.js');
const { app, hydrated, memPlayerMissions, memWeeklyBounties, memEquippedBadges, memRevengeTargets } = S;

const json = (rows, status) => ({ ok: status == null || status < 400, status: status || 200, json: async () => rows, text: async () => JSON.stringify(rows) });
const httpError = (status, body) => ({ ok: false, status, json: async () => ({}), text: async () => body || 'err' });
const posts = () => calls.filter((c) => c.method === 'POST');
const gets = () => calls.filter((c) => c.method === 'GET');

function reset() {
  calls.length = 0;
  hydrated.clear();
  responder = async () => json([]);
  memPlayerMissions.clear();
  memWeeklyBounties.clear();
  memEquippedBadges.clear();
  memRevengeTargets.clear();
  S.sbWarned.clear();
}

function listen() {
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const TODAY = new Date().toISOString().slice(0, 10);
const WEEK = S.currentWeekKey();
const UID = 'racer-1';

// Real catalog ids, so the tests cannot drift away from what the game ships.
const missionDefs = S.getOrInitMissions(TODAY, 'catalog-probe');
const bountyDefs = S.getOrInitWeeklyBounties(WEEK, 'catalog-probe');
// The daily catalog ROTATES by date, so nothing here may hardcode an id or a
// goal: every value is derived from whatever the game serves today.
const M0 = missionDefs.reduce((a, b) => (b.goal >= a.goal ? b : a), missionDefs[0]);
const B0 = bountyDefs.reduce((a, b) => (b.goal >= a.goal ? b : a), bountyDefs[0]);
const SENT_M = Math.max(1, Math.min(M0.goal, 3));
const SENT_M5 = Math.max(1, Math.min(M0.goal, 5));
const prog = require('../shared/progression.js');
// a real badge id that is not the default, so "equipped" is observable
const BADGE = (prog.evaluateBadges({ rating: 2400, xp: 99999, races: 999, wins: 999, podiums: 999, streak: 99, best_streak: 99 })
  .find((b) => b && b.id && b.id !== 'speed_demon') || {}).id || 'apex_predator';


describe('v95 database layer', () => {
  beforeEach(reset); // node:test's top-level beforeEach does not reach inside describe
  test('a failed read returns null (unknown), never an empty set', async () => {
    responder = async () => httpError(500);
    const rows = await S.sbSelect('player_missions', 'user_id=eq.x');
    assert.equal(rows, null, 'null means "ask again later"; [] would mean "this player has nothing"');
  });

  test('a successful read returns the rows', async () => {
    responder = async () => json([{ mission_id: 'm1', progress: 4 }]);
    const rows = await S.sbSelect('player_missions', 'user_id=eq.x');
    assert.deepEqual(rows, [{ mission_id: 'm1', progress: 4 }]);
    assert.match(gets()[0].url, /^https:\/\/fake\.supabase\.co\/rest\/v1\/player_missions\?/);
    assert.equal(gets()[0].headers.apikey, 'test-service-role', 'writes and reads use the service role, never the anon key');
  });

  test('a write retries once on a 5xx and succeeds', async () => {
    let n = 0;
    responder = async () => (++n === 1 ? httpError(503) : json([]));
    assert.equal(await S.sbUpsertRows('player_missions', [{ a: 1 }]), true);
    assert.equal(posts().length, 2, 'exactly one retry');
  });

  test('a write does NOT retry a 4xx rejection', async () => {
    responder = async () => httpError(400, 'invalid input');
    assert.equal(await S.sbUpsertRows('player_missions', [{ a: 1 }]), false);
    assert.equal(posts().length, 1, 'a schema/constraint rejection cannot be retried into success');
  });

  test('writes are upserts, so re-saving a row cannot duplicate it', async () => {
    responder = async () => json([]);
    await S.sbUpsertRows('player_missions', [{ user_id: UID, date_key: TODAY, mission_id: M0.id, progress: 1 }]);
    assert.match(posts()[0].headers.Prefer, /resolution=merge-duplicates/);
  });

  test('nothing is sent at all when there is nothing to send', async () => {
    assert.equal(await S.sbUpsertRows('player_missions', []), false);
    assert.equal(calls.length, 0);
  });
});

describe('v95 daily missions survive a redeploy', () => {
  beforeEach(reset); // node:test's top-level beforeEach does not reach inside describe
  test('progress is hydrated into an empty process', async () => {
    responder = async () => json([{ mission_id: M0.id, progress: SENT_M, completed: false, claimed: false }]);
    assert.equal(await S.hydrateMissions(TODAY, UID), true);
    const st = S.missionsMap(TODAY, UID).get(M0.id);
    assert.equal(st.progress, SENT_M, 'the laps driven before the restart are back');
  });

  test('the merge is monotonic — RAM progress never goes backwards', async () => {
    const ahead = M0.goal + 4; // RAM is further on than the stored row
    S.missionsMap(TODAY, UID).set(M0.id, { progress: ahead, completed: false, claimed: false });
    responder = async () => json([{ mission_id: M0.id, progress: 1, completed: false, claimed: false }]);
    await S.hydrateMissions(TODAY, UID);
    assert.equal(S.missionsMap(TODAY, UID).get(M0.id).progress, ahead, `max(${ahead}, 1) - never the stale database value`);
  });

  test('a claimed row stays claimed, so a reward cannot be granted twice', async () => {
    S.missionsMap(TODAY, UID).set(M0.id, { progress: M0.goal, completed: true, claimed: false });
    responder = async () => json([{ mission_id: M0.id, progress: M0.goal, completed: true, claimed: true }]);
    await S.hydrateMissions(TODAY, UID);
    const st = S.missionsMap(TODAY, UID).get(M0.id);
    assert.equal(st.claimed, true, 'OR of the two flags');
    assert.equal(st.completed, true);
  });

  test('a failed hydration is retried instead of being cached as empty', async () => {
    responder = async () => httpError(500);
    assert.equal(await S.hydrateMissions(TODAY, UID), false);
    assert.equal(S.missionsMap(TODAY, UID).get(M0.id).progress, 0, 'memory is untouched by a failure');

    responder = async () => json([{ mission_id: M0.id, progress: SENT_M, completed: false, claimed: false }]);
    assert.equal(await S.hydrateMissions(TODAY, UID), true, 'the next request asks again');
    assert.equal(S.missionsMap(TODAY, UID).get(M0.id).progress, SENT_M);
  });

  test('a second hydration is served from the cache (one round trip per player per day)', async () => {
    responder = async () => json([{ mission_id: M0.id, progress: 1, completed: false, claimed: false }]);
    await S.hydrateMissions(TODAY, UID);
    await S.hydrateMissions(TODAY, UID);
    await S.hydrateMissions(TODAY, UID);
    assert.equal(gets().length, 1, 'the race loop must not pay for a round trip per call');
  });

  test('GET /api/player/missions reports the durable progress', async () => {
    responder = async () => json([{ mission_id: M0.id, progress: SENT_M5, completed: false, claimed: false }]);
    const { server, base } = listen();
    try {
      const j = await (await fetch(`${base}/api/player/missions?uid=${UID}`)).json();
      assert.equal(j.ok, true);
      const row = j.missions.find((m) => m.id === M0.id);
      assert.equal(row.progress, SENT_M5, 'the endpoint reflects the database, not a fresh zero');
    } finally { server.close(); }
  });

  test('progress written by a race is persisted with the right shape', async () => {
    responder = async () => json([]);
    const mMap = S.missionsMap(TODAY, UID);
    mMap.set(M0.id, { progress: SENT_M, completed: false, claimed: false });
    assert.equal(await S.persistMissions(TODAY, UID, mMap, [M0.id]), true);
    const row = posts()[0].body[0];
    assert.match(posts()[0].url, /\/rest\/v1\/player_missions$/);
    assert.deepEqual(Object.keys(row).sort(), ['claimed', 'completed', 'date_key', 'mission_id', 'progress', 'updated_at', 'user_id'].sort());
    assert.equal(row.user_id, UID);
    assert.equal(row.date_key, TODAY);
    assert.equal(row.mission_id, M0.id);
    assert.equal(row.progress, SENT_M);
    assert.equal(typeof row.progress, 'number');
    assert.equal(row.completed, false);
    assert.equal(row.claimed, false);
    assert.ok(!Number.isNaN(Date.parse(row.updated_at)));
  });

  test('a claim is ROLLED BACK and refused when it cannot be saved', async () => {
    // read succeeds, write fails: the reward must not be handed over
    responder = async (u, o) => (o && o.method === 'POST' ? httpError(500) : json([]));
    S.missionsMap(TODAY, UID).set(M0.id, { progress: M0.goal, completed: true, claimed: false });
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/player/missions/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: UID, missionId: M0.id, dateKey: TODAY })
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'claim_not_saved');
      assert.equal(S.missionsMap(TODAY, UID).get(M0.id).claimed, false,
        'rolled back, so the player can claim again once the database is healthy');
    } finally { server.close(); }
  });

  test('a claim that IS saved goes through and writes claimed=true', async () => {
    responder = async () => json([]);
    S.missionsMap(TODAY, UID).set(M0.id, { progress: M0.goal, completed: true, claimed: false });
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/player/missions/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: UID, missionId: M0.id, dateKey: TODAY })
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
      assert.equal(S.missionsMap(TODAY, UID).get(M0.id).claimed, true);
      const written = posts().map((c) => c.body[0]).find((r) => r.mission_id === M0.id);
      assert.ok(written, 'the claim was written to player_missions');
      assert.equal(written.claimed, true);
    } finally { server.close(); }
  });

  test('an incomplete mission still cannot be claimed', async () => {
    responder = async () => json([]);
    S.missionsMap(TODAY, UID).set(M0.id, { progress: 0, completed: false, claimed: false });
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/player/missions/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: UID, missionId: M0.id, dateKey: TODAY })
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'not_completed');
      assert.equal(posts().length, 0, 'nothing is written for a refused claim');
    } finally { server.close(); }
  });
});

describe('v95 weekly bounties survive a redeploy', () => {
  beforeEach(reset); // node:test's top-level beforeEach does not reach inside describe
  test('progress is hydrated into an empty process', async () => {
    responder = async () => json([{ bounty_id: B0.id, progress: 6, completed: false, claimed: false }]);
    assert.equal(await S.hydrateBounties(WEEK, UID), true);
    assert.equal(S.bountiesMap(WEEK, UID).get(B0.id).progress, 6);
  });

  test('the write targets weekly_bounties with week_key', async () => {
    responder = async () => json([]);
    const bMap = S.bountiesMap(WEEK, UID);
    bMap.set(B0.id, { progress: 2, completed: false, claimed: false });
    assert.equal(await S.persistBounties(WEEK, UID, bMap, [B0.id]), true);
    assert.match(posts()[0].url, /\/rest\/v1\/weekly_bounties$/);
    assert.equal(posts()[0].body[0].week_key, WEEK);
    assert.equal(posts()[0].body[0].bounty_id, B0.id);
  });

  test('a bounty claim is rolled back when it cannot be saved', async () => {
    responder = async (u, o) => (o && o.method === 'POST' ? httpError(500) : json([]));
    S.bountiesMap(WEEK, UID).set(B0.id, { progress: B0.goal, completed: true, claimed: false });
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/competitions/weekly/bounties/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: UID, bountyId: B0.id, weekKey: WEEK })
      });
      assert.equal(res.status, 503);
      assert.equal(S.bountiesMap(WEEK, UID).get(B0.id).claimed, false);
    } finally { server.close(); }
  });

  test('a saved bounty claim persists claimed=true', async () => {
    responder = async () => json([]);
    S.bountiesMap(WEEK, UID).set(B0.id, { progress: B0.goal, completed: true, claimed: false });
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/competitions/weekly/bounties/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: UID, bountyId: B0.id, weekKey: WEEK })
      });
      assert.equal(res.status, 200);
      assert.equal(S.bountiesMap(WEEK, UID).get(B0.id).claimed, true);
      assert.ok(posts().some((c) => /weekly_bounties/.test(c.url) && c.body[0].claimed === true));
    } finally { server.close(); }
  });
});

describe('v95 the equipped badge survives a redeploy', () => {
  beforeEach(reset); // node:test's top-level beforeEach does not reach inside describe
  test('the equipped badge is read back from the database', async () => {
    responder = async () => json([{ badge_id: BADGE }]);
    assert.equal(await S.hydrateEquippedBadge(UID), BADGE);
    assert.equal(memEquippedBadges.get(UID), BADGE);
    assert.match(gets()[0].url, /player_badges\?user_id=eq\.racer-1&equipped=eq\.true/);
  });

  test('hydration never overwrites a badge already equipped in RAM', async () => {
    memEquippedBadges.set(UID, 'speed_demon');
    responder = async () => json([{ badge_id: BADGE }]);
    await S.hydrateEquippedBadge(UID);
    assert.equal(memEquippedBadges.get(UID), 'speed_demon', 'the live choice wins over the stored one');
  });

  test('equipping writes the new badge AND clears the old one', async () => {
    responder = async () => json([]);
    assert.equal(await S.persistEquippedBadge(UID, BADGE, 'speed_demon'), true);
    const rows = posts()[0].body;
    assert.equal(rows.length, 2, 'exclusive equip: two rows in one upsert');
    assert.notEqual(BADGE, 'speed_demon', 'the test badge must differ from the default for this to mean anything');
    assert.deepEqual(rows.find((r) => r.badge_id === BADGE), { user_id: UID, badge_id: BADGE, equipped: true });
    assert.deepEqual(rows.find((r) => r.badge_id === 'speed_demon'), { user_id: UID, badge_id: 'speed_demon', equipped: false });
  });

  test('re-equipping the same badge does not write a redundant clear', async () => {
    responder = async () => json([]);
    await S.persistEquippedBadge(UID, BADGE, BADGE);
    assert.equal(posts()[0].body.length, 1);
  });

  test('POST /api/player/badge/equip is rolled back when the write fails', async () => {
    memEquippedBadges.set(UID, 'speed_demon');
    responder = async (u, o) => (o && o.method === 'POST' ? httpError(500) : json([]));
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/player/badge/equip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: UID, badgeId: BADGE })
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'equip_not_saved');
      assert.equal(memEquippedBadges.get(UID), 'speed_demon', 'the old badge stays equipped, not a phantom new one');
    } finally { server.close(); }
  });

  test('GET /api/player/badges serves the stored badge after a restart', async () => {
    responder = async () => json([{ badge_id: BADGE }]);
    const { server, base } = listen();
    try {
      const j = await (await fetch(`${base}/api/player/badges?uid=${UID}`)).json();
      assert.equal(j.ok, true);
      assert.equal(j.equippedBadge, BADGE);
      assert.equal(j.equippedBadge, BADGE);
      assert.ok(j.badges.some((b) => b.equipped && (b.id === BADGE || b.badgeId === BADGE)),
        'the badge list marks the stored badge as equipped');
    } finally { server.close(); }
  });
});

describe('v95 revenge grudges survive a redeploy', () => {
  beforeEach(reset);
  const IDS = { uid: 'acc-uuid-1', sbUid: 'acc-uuid-1', pid: 'device-pid-9', name: 'RACER ONE' };
  const rival = { targetUid: 'rival-7', targetName: 'FASTFOX', map: 2, targetRating: 1450 };
  const row = (over) => Object.assign({
    target_id: 'rival-7', target_name: 'FASTFOX', map: 2, target_rating: 1450,
    issued_at: new Date().toISOString()
  }, over || {});

  test('a grudge is fanned out to one row per identity', async () => {
    responder = async () => json([]);
    const rec = S.normalizeRevengeTarget(rival);
    assert.equal(await S.persistRevengeTarget(IDS, rec), true);
    const keys = S.revengeKeys(IDS, false);
    assert.ok(keys.length >= 3, `expected the uuid, pid and name identities, got ${keys.length}`);
    const written = posts()[0].body;
    assert.equal(written.length, keys.length, 'one row per identity, in a single request');
    assert.deepEqual(written.map((r) => r.owner_id).sort(), keys.slice().sort());
    assert.deepEqual(Object.keys(written[0]).sort(),
      ['issued_at', 'map', 'map_name', 'owner_id', 'status', 'target_id', 'target_name', 'target_rating'].sort());
    assert.equal(written[0].target_id, 'rival-7');
    assert.equal(written[0].map, 2);
    assert.equal(written[0].target_rating, 1450);
    assert.equal(written[0].status, 'open');
  });

  test('hydration reads every identity in parallel and rebuilds the list', async () => {
    responder = async () => json([row()]);
    assert.equal(await S.hydrateRevenge(IDS, false), true);
    const keys = S.revengeKeys(IDS, false);
    assert.equal(gets().length, keys.length, 'one select per identity, no joins');
    for (const k of keys) {
      const list = S.memRevengeTargets.get(k);
      assert.ok(list && list.length === 1, `identity ${k} got its grudge back`);
      assert.equal(list[0].targetUid, 'rival-7');
      assert.equal(list[0].map, 2, 'the track you lost on is the track the banner offers');
      assert.equal(list[0].targetName, 'FASTFOX');
    }
  });

  test('expired grudges are excluded by the query, not filtered after the fact', async () => {
    responder = async () => json([]);
    await S.hydrateRevenge(IDS, false);
    const cutoff = decodeURIComponent(gets()[0].url.split('issued_at=gte.')[1].split('&')[0]);
    const ageDays = (Date.now() - Date.parse(cutoff)) / 86400000;
    assert.ok(ageDays > 6.9 && ageDays < 7.1, `cutoff is 7 days back, got ${ageDays.toFixed(2)}`);
    assert.match(gets()[0].url, /order=issued_at\.desc/);
    assert.match(gets()[0].url, /limit=5/, 'REVENGE_MAX bounds the read');
  });

  test('GET /api/player/revenge returns the grudge earned before the restart', async () => {
    responder = async () => json([row()]);
    const { server, base } = listen();
    try {
      const j = await (await fetch(`${base}/api/player/revenge?uid=acc-uuid-1&name=RACER%20ONE`)).json();
      assert.equal(j.ok, true);
      const list = j.revengeTargets || j.targets;
      assert.equal(list.length, 1, 'a fresh process still knows who beat you');
      assert.equal(list[0].targetUid, 'rival-7');
      assert.equal(list[0].map, 2);
    } finally { server.close(); }
  });

  test('a partially failed read is retried instead of serving half a grudge list', async () => {
    let n = 0;
    responder = async () => (++n === 1 ? json([row()]) : httpError(500));
    assert.equal(await S.hydrateRevenge(IDS, false), false, 'one key failed -> the whole hydration is not trusted');
    assert.equal(S.memRevengeTargets.size, 0, 'nothing half-applied');

    n = 0;
    responder = async () => json([row()]);
    assert.equal(await S.hydrateRevenge(IDS, false), true, 'the next poll asks again');
    assert.ok(S.memRevengeTargets.get('acc-uuid-1'), 'and now the grudge is there');
  });

  test('a newer grudge in RAM wins over the stored row', async () => {
    const fresh = new Date().toISOString();
    const older = new Date(Date.now() - 3600000).toISOString();
    S.memRevengeTargets.set('acc-uuid-1', [S.normalizeRevengeTarget(Object.assign({}, rival, { map: 4, issuedAt: fresh }))]);
    responder = async () => json([row({ map: 1, issued_at: older })]);
    await S.hydrateRevenge(IDS, false);
    assert.equal(S.memRevengeTargets.get('acc-uuid-1')[0].map, 4, 'the live record is kept, the stale row is not');
  });

  test('consuming a grudge deletes every identity row', async () => {
    responder = async () => json([]);
    assert.equal(await S.clearRevengeRows(IDS, 'rival-7'), true);
    const dels = calls.filter((c) => c.method === 'DELETE');
    assert.equal(dels.length, S.revengeKeys(IDS, false).length);
    assert.match(dels[0].url, /\/rest\/v1\/player_revenge\?owner_id=eq\./);
    assert.match(dels[0].url, /target_id=eq\.rival-7/);
  });

  test('identities are URL-encoded, so a name with spaces and & cannot break the query', async () => {
    responder = async () => json([]);
    await S.hydrateRevenge({ uid: 'a b&c=d', name: 'RACER ONE' }, false);
    assert.ok(gets().length >= 2, 'every identity gets its own select');
    const values = [];
    for (const g of gets()) {
      const raw = g.url.split('owner_id=eq.')[1];
      assert.ok(raw, `the query carries an owner_id: ${g.url}`);
      const val = raw.split('&')[0]; // a raw & inside the value would truncate here
      assert.ok(!/\s/.test(val), `no unencoded whitespace reached the wire: ${val}`);
      values.push(decodeURIComponent(val));
    }
    // revengeKeys() fans out over BOTH the normalized form (normCrewKey: trimmed,
    // 'sb:' stripped, lowercased) and the raw string, exactly as the in-memory
    // store does - so both spellings must have been queried, intact.
    assert.ok(values.some((v) => v === 'a b&c=d'), `the & and = survived encoding: ${values.join(' | ')}`);
    assert.ok(values.some((v) => /racer one/i.test(v)), `the display-name identity was queried: ${values.join(' | ')}`);
  });
});

describe('v95 clubs survive the redeploy that used to wipe them', () => {
  beforeEach(reset);
  const CID = 'testclub';
  const MEMBER = 'racer-1';

  // Clubs are module-level state shared by the whole file: build a private one
  // and tear it down, so no test inherits another's roster.
  function teardown() {
    S.memCrews.delete(CID);
    S.memPlayerCrew.delete(MEMBER);
    for (const [k, v] of S.memCrewAliases) if (v === CID) S.memCrewAliases.delete(k);
    for (const [k, set] of S.memCrewNameHints) if (set && set.delete) set.delete(CID);
    for (const k of [...S.memClaimedCrewMilestones.keys()]) if (k.startsWith(CID + ':')) S.memClaimedCrewMilestones.delete(k);
  }
  beforeEach(teardown);

  const crewRow = (over) => Object.assign({
    id: CID, tag: 'TSTC', name: 'Test Club', motto: 'm', badge: '🏁', color: '#ff4444',
    leader_uid: MEMBER, weekly_meters: 40000, total_meters: 90000, weekly_points: 55,
    week_key: WEEK, seeded: false, created_at: new Date().toISOString()
  }, over || {});
  const memberRow = (over) => Object.assign({
    crew_id: CID, member_key: MEMBER, name: 'RACER ONE', role: 'member',
    aliases: ['device-pid-9', 'racer one'], weekly_meters: 12000, total_meters: 30000,
    weekly_points: 20, week_key: WEEK, joined_at: new Date().toISOString()
  }, over || {});

  test('a club row maps to the exact columns the migration creates', () => {
    const c = { id: CID, tag: 'TSTC', name: 'Test Club', motto: 'm', badge: '🏁', color: '#ff4444',
      leaderUid: MEMBER, members: [], weeklyMeters: 1500, totalMeters: 2500, weeklyPoints: 7,
      created_at: new Date().toISOString() };
    const row = S.crewDbRow(c);
    assert.deepEqual(Object.keys(row).sort(),
      ['badge', 'color', 'created_at', 'id', 'leader_uid', 'motto', 'name', 'seeded', 'tag',
       'total_meters', 'week_key', 'weekly_meters', 'weekly_points'].sort());
    assert.equal(row.seeded, false);
    assert.equal(row.week_key, WEEK, 'the week is recorded even though nothing rolls over yet');
    assert.equal(S.crewDbRow(Object.assign({}, c, { id: 'apex' })).seeded, true, 'the five presets are marked seeded');
  });

  test('a roster row carries every alias, so identity resolution survives', () => {
    const row = S.crewMemberDbRow(CID, { uid: MEMBER, name: 'RACER ONE', role: 'member',
      aliases: ['device-pid-9', 'RACER ONE'], weeklyMeters: 5, totalMeters: 9, weeklyPoints: 1 });
    assert.equal(row.crew_id, CID);
    assert.equal(row.member_key, MEMBER);
    assert.deepEqual(row.aliases, ['device-pid-9', 'RACER ONE']);
    assert.equal(S.crewMemberDbRow(CID, { uid: '', name: '' }), null, 'a member with no identity is not stored');
  });

  test('hydration rebuilds counters, roster AND the identity maps', async () => {
    responder = async (u) => (u.includes('/crews?') ? json([crewRow()])
      : u.includes('crew_milestone_claims') ? json([{ crew_id: CID, tier: 1, member_key: MEMBER, week_key: WEEK }])
      : json([memberRow()]));
    S.memCrews.set(CID, { id: CID, tag: 'TSTC', name: 'Test Club', members: [], weeklyMeters: 0, totalMeters: 0, weeklyPoints: 0 });
    assert.equal(await S.hydrateCrew(CID), true);
    const c = S.memCrews.get(CID);
    assert.equal(c.weeklyMeters, 40000, 'the kilometres driven before the restart are back');
    assert.equal(c.totalMeters, 90000);
    assert.equal(c.weeklyPoints, 55);
    assert.equal(c.members.length, 1);
    assert.equal(c.members[0].weeklyMeters, 12000);
    assert.deepEqual(c.members[0].aliases.includes('device-pid-9'), true);
    assert.equal(S.memClaimedCrewMilestones.get(S.crewClaimKey(CID, 1, MEMBER)), true, 'milestone claims come back too');
    assert.equal(c.weekKey, WEEK, 'and the club is stamped with the week its counters belong to');
    // the v90 sync fix depends on these maps: without them settlement cannot find
    // the roster row and mileage silently stops counting
    assert.equal(S.findCrewId({ uid: MEMBER }), CID, 'findCrewId resolves the roster uid');
    assert.equal(S.findCrewId({ uid: 'device-pid-9' }), CID, 'and the device pid alias');
    assert.equal(S.findCrewId({ name: 'RACER ONE' }), CID, 'and the display name hint');
    assert.equal(S.memPlayerCrew.get(MEMBER), CID);
  });

  test('counters merge monotonically - hydration can never reduce them', async () => {
    // weekKey: WEEK because these are counters driven THIS week - that is what
    // settlement always leaves behind, and it is what makes the merge monotonic
    // instead of a rollover. A club whose week has ended is a different test.
    S.memCrews.set(CID, { id: CID, tag: 'TSTC', name: 'Test Club', weekKey: WEEK, members: [
      { uid: MEMBER, name: 'RACER ONE', role: 'member', weeklyMeters: 30000, totalMeters: 99000, weeklyPoints: 9, aliases: [] }
    ], weeklyMeters: 80000, totalMeters: 80000, weeklyPoints: 40 });
    responder = async (u) => (u.includes('/crews?') ? json([crewRow()]) : json([memberRow()]));
    await S.hydrateCrew(CID);
    const c = S.memCrews.get(CID);
    assert.equal(c.weeklyMeters, 80000, 'max(80000, 40000) - RAM was ahead, so RAM stays');
    assert.equal(c.weeklyPoints, 55, 'max(40, 55) - the database was ahead, so it wins');
    assert.equal(c.totalMeters, 90000, 'max(80000, 90000)');
    assert.equal(c.members[0].weeklyMeters, 30000, 'max(30000, 12000)');
    assert.equal(c.members[0].totalMeters, 99000, 'lifetime totals merge regardless of week');
  });

  test('a user-created club this process has never seen is materialised for the board', async () => {
    responder = async (u) => (u.includes('/crews?') ? json([crewRow()])
      : u.includes('crew_milestone_claims') ? json([]) : json([memberRow()]));
    assert.equal(S.memCrews.has(CID), false, 'not in memory: this is a fresh process');
    assert.equal(await S.hydrateAllCrews(), true);
    assert.equal(S.memCrews.has(CID), true, 'the club exists again');
    const c = S.memCrews.get(CID);
    assert.equal(c.name, 'Test Club');
    assert.equal(c.tag, 'TSTC');
    assert.equal(c.members.length, 1, 'with its roster');
    assert.equal(c.weeklyMeters, 40000);
  });

  test('findCrewIdDurable falls back to the alias array when the roster key misses', async () => {
    responder = async (u) => {
      if (u.includes('member_key=eq.')) return json([]);              // not found by roster key
      if (u.includes('aliases=cs.')) return json([{ crew_id: CID }]); // found by alias
      return json([]);
    };
    S.memCrews.set(CID, { id: CID, tag: 'TSTC', name: 'Test Club', members: [], weeklyMeters: 0, totalMeters: 0, weeklyPoints: 0 });
    const found = await S.findCrewIdDurable({ uid: 'brand-new-uuid', pid: 'device-pid-9', name: 'RACER ONE' });
    assert.equal(found, CID, 'a racer who joined under another identity is still recognised');
    assert.ok(gets().some((g) => /aliases=cs\.%7B|aliases=cs\.\{/.test(g.url)), 'the alias containment query ran');
  });

  test('leaving a club deletes its roster row, so hydration cannot walk you back in', async () => {
    responder = async () => json([]);
    assert.equal(await S.deleteCrewMemberRow(CID, { uid: MEMBER, name: 'R', aliases: [] }), true);
    const del = calls.find((c) => c.method === 'DELETE');
    assert.match(del.url, /\/rest\/v1\/crew_members\?crew_id=eq\.testclub&member_key=eq\.racer-1/);
  });

  test('joining a club that only exists in the database works', async () => {
    responder = async (u) => (u.includes('/crews?') ? json([crewRow()]) : json([]));
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/player/crew/join`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: MEMBER, name: 'RACER ONE', crewId: CID, pid: 'device-pid-9' })
      });
      const j = await res.json();
      assert.equal(res.status, 200, `expected a seat in the club, got ${res.status} ${JSON.stringify(j)}`);
      assert.equal(j.ok, true);
      assert.equal(j.crewId, CID);
      assert.ok(posts().some((c) => /\/crews$/.test(c.url.split('?')[0])), 'the club row was written');
      assert.ok(posts().some((c) => /crew_members$/.test(c.url.split('?')[0]) && c.body[0].member_key === MEMBER),
        'and so was the roster row');
    } finally { server.close(); }
  });

  test('a milestone claim is rolled back and refused when it cannot be saved', async () => {
    S.memCrews.set(CID, { id: CID, tag: 'TSTC', name: 'Test Club', leaderUid: null, weekKey: WEEK, members: [
      { uid: MEMBER, name: 'RACER ONE', role: 'member', weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5, aliases: [] }
    ], weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5 });
    S.bindCrewIdentities(CID, { uid: MEMBER, name: 'RACER ONE' });
    responder = async (u, o) => (o && o.method === 'POST' ? httpError(500) : json([]));
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/player/crew/claim-milestone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: MEMBER, tier: 1 })
      });
      assert.equal(res.status, 503, 'the reward is not handed over on a promise');
      assert.equal((await res.json()).error, 'claim_not_saved');
      assert.equal(S.memClaimedCrewMilestones.has(S.crewClaimKey(CID, 1, MEMBER)), false,
        'rolled back, so the member can claim again once the database is healthy');
    } finally { server.close(); }
  });

  test('a milestone claim that IS saved cannot be collected twice', async () => {
    S.memCrews.set(CID, { id: CID, tag: 'TSTC', name: 'Test Club', leaderUid: null, weekKey: WEEK, members: [
      { uid: MEMBER, name: 'RACER ONE', role: 'member', weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5, aliases: [] }
    ], weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5 });
    S.bindCrewIdentities(CID, { uid: MEMBER, name: 'RACER ONE' });
    responder = async () => json([]);
    const { server, base } = listen();
    try {
      const first = await fetch(`${base}/api/player/crew/claim-milestone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: MEMBER, tier: 1 })
      });
      assert.equal(first.status, 200);
      const written = posts().map((c) => c.body && c.body[0]).find((r) => r && r.crew_id === CID && r.tier === 1);
      assert.ok(written, 'the claim was written to crew_milestone_claims');
      assert.equal(written.member_key, MEMBER);
      assert.equal(written.week_key, WEEK);

      // a restart: memory is wiped, only the database remembers
      S.memClaimedCrewMilestones.clear();
      S.hydrated.clear();
      responder = async (u) => (u.includes('crew_milestone_claims') ? json([{ crew_id: CID, tier: 1, member_key: MEMBER, week_key: WEEK }]) : json([]));
      const second = await fetch(`${base}/api/player/crew/claim-milestone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: MEMBER, tier: 1 })
      });
      assert.equal(second.status, 400, 'the same milestone cannot be paid out twice');
      assert.equal((await second.json()).error, 'already_claimed');
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// v96 — the weekly rollover.
//
// The counters were always CALLED weekly and the UI always labelled them
// "WEEKLY MILEAGE" / "GRAND PRIX PTS", but nothing reset them. Persisting them
// in v95 would have made that permanent: one club would lead forever. These
// tests pin the boundary - Monday 00:00 UTC, the same week the Founders Cup and
// the weekly bounties use - from both sides: a week that has ended must clear,
// and a week that is still running must not.
// ---------------------------------------------------------------------------
function weekKeyOf(d) {
  const mondayShift = (d.getUTCDay() + 6) % 7;
  const ws = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - mondayShift * 86400000;
  const wd = new Date(ws);
  const onejan = new Date(Date.UTC(wd.getUTCFullYear(), 0, 1));
  const n = Math.ceil((((wd.getTime() - onejan.getTime()) / 86400000) + onejan.getUTCDay() + 1) / 7);
  return `${wd.getUTCFullYear()}-W${String(n).padStart(2, '0')}`;
}
const LAST_WEEK = weekKeyOf(new Date(Date.now() - 7 * 86400000));

describe('v96 club counters roll over every Monday', () => {
  beforeEach(reset);
  const CID = 'weekclub';
  const MEMBER = 'racer-week';

  function teardown() {
    S.memCrews.delete(CID);
    S.memPlayerCrew.delete(MEMBER);
    for (const [k, v] of S.memCrewAliases) if (v === CID) S.memCrewAliases.delete(k);
    for (const [k, set] of S.memCrewNameHints) if (set && set.delete) set.delete(CID);
    for (const k of [...S.memClaimedCrewMilestones.keys()]) if (k.startsWith(CID + ':')) S.memClaimedCrewMilestones.delete(k);
  }
  beforeEach(teardown);

  const crewRow = (over) => Object.assign({
    id: CID, tag: 'WEEK', name: 'Week Club', motto: 'm', badge: '🏁', color: '#ff4444',
    leader_uid: MEMBER, weekly_meters: 40000, total_meters: 900000, weekly_points: 55,
    week_key: WEEK, seeded: false, created_at: new Date().toISOString()
  }, over || {});
  const memberRow = (over) => Object.assign({
    crew_id: CID, member_key: MEMBER, name: 'RACER WEEK', role: 'member', aliases: ['week-pid'],
    weekly_meters: 12000, total_meters: 300000, weekly_points: 20, week_key: WEEK,
    joined_at: new Date().toISOString()
  }, over || {});

  test('the week key really is last week (the fixture would be vacuous otherwise)', () => {
    assert.notEqual(LAST_WEEK, WEEK, 'LAST_WEEK must differ from the live week');
    assert.equal(S.currentWeekKey(), WEEK, 'and the server agrees on what this week is');
  });

  test('rollCrewWeek clears a finished week and leaves a running one alone', () => {
    const c = { id: CID, weekKey: LAST_WEEK, weeklyMeters: 40000, weeklyPoints: 55, totalMeters: 900000,
      members: [{ uid: MEMBER, weeklyMeters: 12000, weeklyPoints: 20, totalMeters: 300000 }] };
    S.rollCrewWeek(c);
    assert.equal(c.weeklyMeters, 0, 'the club starts the new week at zero');
    assert.equal(c.weeklyPoints, 0);
    assert.equal(c.members[0].weeklyMeters, 0, 'and so does every member');
    assert.equal(c.members[0].weeklyPoints, 0);
    assert.equal(c.totalMeters, 900000, 'a lifetime total is never reset');
    assert.equal(c.members[0].totalMeters, 300000);
    assert.equal(c.weekKey, WEEK, 'the week is stamped, so this only happens once');

    c.weeklyMeters = 7000; c.members[0].weeklyMeters = 7000;
    S.rollCrewWeek(c);
    S.rollCrewWeek(c);
    assert.equal(c.weeklyMeters, 7000, 'rolling again inside the same week changes nothing');
    assert.equal(c.members[0].weeklyMeters, 7000);
  });

  test('a club whose week has ended cannot be read as still leading', () => {
    const c = { id: CID, weekKey: LAST_WEEK, weeklyMeters: 999999, weeklyPoints: 999, totalMeters: 5, members: [] };
    S.rollCrewWeek(c);
    assert.equal(c.weeklyMeters, 0, 'the Grand Prix restarts');
  });

  test('counters carried in RAM with no week stamp are treated as a finished week', () => {
    // v95 left clubs with counters and no weekKey. Treating an unstamped week as
    // current would resurrect pre-rollover numbers forever; treating it as stale
    // costs one reset, once, on the deploy that introduces the boundary.
    const c = { id: CID, weeklyMeters: 50000, weeklyPoints: 80, totalMeters: 50000, members: [] };
    S.rollCrewWeek(c);
    assert.equal(c.weeklyMeters, 0);
    assert.equal(c.weekKey, WEEK);
  });

  test('a club row from last week reloads empty for this week but keeps its history', async () => {
    responder = async (u) => (u.includes('/crews?') ? json([crewRow({ week_key: LAST_WEEK, weekly_meters: 40000, weekly_points: 55 })])
      : u.includes('crew_milestone_claims') ? json([]) : json([memberRow({ week_key: LAST_WEEK })]));
    assert.equal(await S.hydrateCrew(CID), true);
    const c = S.memCrews.get(CID);
    assert.equal(c.weeklyMeters, 0, 'last week\'s 40 km is not this week\'s head start');
    assert.equal(c.weeklyPoints, 0);
    assert.equal(c.totalMeters, 900000, 'the lifetime total survives the boundary');
    assert.equal(c.weekKey, WEEK);
    assert.equal(c.members.length, 1, 'the roster is untouched by a rollover');
    assert.equal(c.members[0].weeklyMeters, 0, 'member weekly figures are last week\'s too');
    assert.equal(c.members[0].totalMeters, 300000, 'but their lifetime total is not');
    assert.equal(S.findCrewId({ uid: 'week-pid' }), CID, 'identity binding still works across the boundary');
  });

  test('a club row from THIS week still merges monotonically', async () => {
    responder = async (u) => (u.includes('/crews?') ? json([crewRow({ week_key: WEEK, weekly_meters: 40000 })])
      : u.includes('crew_milestone_claims') ? json([]) : json([memberRow({ week_key: WEEK })]));
    await S.hydrateCrew(CID);
    const c = S.memCrews.get(CID);
    assert.equal(c.weeklyMeters, 40000, 'a live week is restored, not zeroed');
    assert.equal(c.weekKey, WEEK);
  });

  test('a club row that under-reports cannot rank below the sum of its members', async () => {
    // Both rows are written together, but a partial failure can leave the club
    // row behind. The board must not under-report a club for that.
    responder = async (u) => (u.includes('/crews?') ? json([crewRow({ week_key: WEEK, weekly_meters: 1000, weekly_points: 2 })])
      : u.includes('crew_milestone_claims') ? json([]) : json([memberRow({ week_key: WEEK, weekly_meters: 12000, weekly_points: 20 })]));
    await S.hydrateCrew(CID);
    const c = S.memCrews.get(CID);
    assert.equal(c.weeklyMeters, 12000, 'max(club row, sum of member weeks)');
    assert.equal(c.weeklyPoints, 20);
  });

  test('a stale member row cannot inflate the club through reconciliation', async () => {
    responder = async (u) => (u.includes('/crews?') ? json([crewRow({ week_key: WEEK, weekly_meters: 40000, weekly_points: 55 })])
      : u.includes('crew_milestone_claims') ? json([]) : json([memberRow({ week_key: LAST_WEEK, weekly_meters: 999999 })]));
    await S.hydrateCrew(CID);
    assert.equal(S.memCrews.get(CID).weeklyMeters, 40000, 'a member from last week contributes nothing');
  });

  test('last week\'s milestone claim does not block this week\'s', async () => {
    S.memCrews.set(CID, { id: CID, tag: 'WEEK', name: 'Week Club', leaderUid: null, weekKey: WEEK,
      members: [{ uid: MEMBER, name: 'RACER WEEK', role: 'member', weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5, aliases: [] }],
      weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5 });
    S.bindCrewIdentities(CID, { uid: MEMBER, name: 'RACER WEEK' });
    // a restart: only the database remembers, and what it remembers is LAST week
    S.memClaimedCrewMilestones.set(S.crewClaimKey(CID, 1, MEMBER, LAST_WEEK), true);
    responder = async (u) => (u.includes('crew_milestone_claims')
      ? json([{ crew_id: CID, tier: 1, member_key: MEMBER, week_key: LAST_WEEK }]) : json([]));
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/player/crew/claim-milestone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: MEMBER, tier: 1 })
      });
      assert.equal(res.status, 200, 'the tier is collectable again in a new week');
      assert.equal((await res.json()).xpAwarded, 150);
      assert.ok(S.memClaimedCrewMilestones.has(S.crewClaimKey(CID, 1, MEMBER, WEEK)), 'and this week is now marked');
      const written = posts().map((c) => c.body && c.body[0]).find((r) => r && r.crew_id === CID && r.tier === 1);
      assert.equal(written.week_key, WEEK, 'the new claim is written against this week');
    } finally { server.close(); }
  });

  test('claims are loaded week-scoped, and a row with no week cannot block anything', async () => {
    responder = async (u) => (u.includes('crew_milestone_claims')
      ? json([{ crew_id: CID, tier: 1, member_key: MEMBER, week_key: '' },
              { crew_id: CID, tier: 2, member_key: MEMBER }])
      : u.includes('/crews?') ? json([crewRow()]) : json([memberRow()]));
    await S.hydrateCrew(CID);
    const q = gets().map((c) => c.url).find((u) => u.includes('crew_milestone_claims'));
    assert.match(q, /week_key=eq\./, 'the query asks for this week only');
    assert.ok(q.includes(encodeURIComponent(WEEK)), 'and names it');
    // Scoped to this club: the claim map is module state that reset() does not
    // clear, so a global size check would depend on which suite ran first.
    const mine = [...S.memClaimedCrewMilestones.keys()].filter((k) => k.startsWith(CID + ':'));
    assert.deepEqual(mine, [],
      'a legacy empty week_key and a missing one are both ignored, never treated as this week');
  });

  test('a milestone claimed in a week that has ended cannot be claimed on its kilometres', async () => {
    // 30 km of LAST week's driving must not unlock this week's 25 km tier.
    S.memCrews.set(CID, { id: CID, tag: 'WEEK', name: 'Week Club', leaderUid: null, weekKey: LAST_WEEK,
      members: [{ uid: MEMBER, name: 'RACER WEEK', role: 'member', weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5, aliases: [] }],
      weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5 });
    S.bindCrewIdentities(CID, { uid: MEMBER, name: 'RACER WEEK' });
    responder = async () => json([]);
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/player/crew/claim-milestone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: MEMBER, tier: 1 })
      });
      assert.equal(res.status, 400, 'the week rolled over before the gate was checked');
      assert.equal((await res.json()).error, 'milestone_unreached');
      assert.equal(S.memCrews.get(CID).weeklyMeters, 0, 'and the club is now on the new week');
      assert.equal(S.memCrews.get(CID).totalMeters, 30000, 'lifetime total intact');
    } finally { server.close(); }
  });

  test('the club endpoints tell the client which week it is looking at', async () => {
    responder = async (u) => (u.includes('crew_milestone_claims') ? json([])
      : u.includes('/crews?') ? json([crewRow()]) : json([memberRow()]));
    const { server, base } = listen();
    try {
      const board = await (await fetch(`${base}/api/crews`)).json();
      assert.equal(board.weekKey, WEEK, 'the board names the week');
      assert.match(board.resetsIn, /^\d+d \d+h$/, 'and says when it ends, like the Founders Cup does');
      const mine = await (await fetch(`${base}/api/player/crew?uid=${MEMBER}`)).json();
      assert.equal(mine.crew.weekKey, WEEK, 'the club panel does too');
      assert.match(mine.crew.resetsIn, /^\d+d \d+h$/);
      assert.ok(mine.crew.milestones.every((m) => typeof m.claimed === 'boolean'), 'milestone state is still served');
    } finally { server.close(); }
  });

  test('the database row and the RAM key name the same week', async () => {
    // The week is read off the crew that rollCrewWeek() stamped, never
    // recomputed: a claim submitted at exactly Monday 00:00:00 UTC would
    // otherwise land in RAM under the new week and in the database under the
    // old one - which is the same reward paid out twice.
    S.memCrews.set(CID, { id: CID, tag: 'WEEK', name: 'Week Club', leaderUid: null, weekKey: WEEK,
      members: [{ uid: MEMBER, name: 'RACER WEEK', role: 'member', weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5, aliases: [] }],
      weeklyMeters: 30000, totalMeters: 30000, weeklyPoints: 5 });
    S.bindCrewIdentities(CID, { uid: MEMBER, name: 'RACER WEEK' });
    responder = async () => json([]);
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/api/player/crew/claim-milestone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: MEMBER, tier: 1 })
      });
      assert.equal(res.status, 200);
      const written = posts().map((c) => c.body && c.body[0]).find((r) => r && r.crew_id === CID && r.tier === 1);
      assert.ok(written, 'the claim was persisted');
      assert.equal(written.week_key, WEEK, 'against this week');
      assert.ok(S.memClaimedCrewMilestones.has(S.crewClaimKey(CID, 1, MEMBER, written.week_key)),
        'and the key held in RAM is built from the very week the row records');
      assert.equal(S.memCrews.get(CID).weekKey, written.week_key, 'as is the club the kilometres belong to');
    } finally { server.close(); }
  });

  test('a claim key carries the week, so one tier is two claims in two weeks', () => {
    const a = S.crewClaimKey(CID, 1, MEMBER, LAST_WEEK);
    const b = S.crewClaimKey(CID, 1, MEMBER, WEEK);
    assert.notEqual(a, b, 'different weeks are different claims');
    assert.equal(S.crewClaimKey(CID, 1, MEMBER), b, 'and an omitted week means this week');
    assert.equal(a.split(':').length, 4, 'crewId:tier:weekKey:memberKey');
  });
});

// ---------------------------------------------------------------------------
// v96 — "the club I created disappears after every update".
//
// Four causes, one symptom: the board shows only the five presets. Three of them
// are silent, because a read through the anon key returns an EMPTY SET rather
// than an error. These tests cover the two things the server can do about it:
// write the rows in an order the schema accepts, and name the cause instead of
// leaving it to be guessed from a bug report.
// ---------------------------------------------------------------------------
const jwt = (role) => 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  Buffer.from(JSON.stringify({ role, ref: 'abcdefghijklm' })).toString('base64url') + '.c2ln';

describe('v96 why a created club disappears', () => {
  beforeEach(reset);

  test('the club row is written BEFORE the roster row (foreign key)', async () => {
    // crew_members.crew_id references crews(id). Firing both together let the
    // member insert win the race on a brand-new club, Postgres rejected it with
    // 23503, and the founder's roster row was never stored.
    responder = async () => json([]);
    const ok = await S.persistCrewWithMember(
      { id: 'ordclub', tag: 'ORDC', name: 'Order Club', members: [], weeklyMeters: 0, totalMeters: 0, weeklyPoints: 0 },
      { uid: 'racer-ord', name: 'RACER ORD', aliases: [], weeklyMeters: 0, totalMeters: 0, weeklyPoints: 0 }
    );
    assert.equal(ok, true);
    const order = posts().map((c) => c.url.split('?')[0].split('/').pop());
    assert.deepEqual(order, ['crews', 'crew_members'], 'parent row first, then the row that points at it');
  });

  test('no roster row is attempted when the club row is rejected', async () => {
    responder = async (u) => (u.includes('/crews') ? httpError(400, 'rejected') : json([]));
    const ok = await S.persistCrewWithMember(
      { id: 'ordclub', tag: 'ORDC', name: 'Order Club', members: [] },
      { uid: 'racer-ord', name: 'RACER ORD', aliases: [] }
    );
    assert.equal(ok, false);
    assert.equal(posts().length, 1, 'the orphan row is never sent - it could only be rejected');
    assert.match(posts()[0].url, /\/crews$/);
  });

  test('a club with no roster row to write still persists the club', async () => {
    responder = async () => json([]);
    const ok = await S.persistCrewWithMember({ id: 'soloclub', tag: 'SOLO', name: 'Solo', members: [] }, null);
    assert.equal(ok, true);
    assert.deepEqual(posts().map((c) => c.url.split('?')[0].split('/').pop()), ['crews']);
  });

  test('the role is read out of a real Supabase key', () => {
    assert.equal(S.serviceKeyRole(jwt('service_role')), 'service_role');
    assert.equal(S.serviceKeyRole(jwt('anon')), 'anon', 'the mistake that silently disables everything');
    assert.equal(S.serviceKeyRole('test-service-role'), 'unknown', 'not a JWT at all');
    assert.equal(S.serviceKeyRole(''), 'unknown');
    assert.equal(S.serviceKeyRole('a.b'), 'unknown', 'a JWT-shaped string with junk inside');
    assert.equal(S.serviceKeyRole(null), 'unknown');
  });

  test('probe statuses map to causes', () => {
    assert.equal(S.classifySchemaProbe(404), 'table_missing', 'the migration was never run');
    assert.equal(S.classifySchemaProbe(406), 'table_missing');
    assert.equal(S.classifySchemaProbe(401), 'key_rejected');
    assert.equal(S.classifySchemaProbe(403), 'key_rejected', 'row-level security: an anon key');
    assert.equal(S.classifySchemaProbe(500), 'server_error');
    assert.equal(S.classifySchemaProbe(400), 'ok', 'reached the table and was allowed to try');
  });

  test('the verdict names the cause, worst first', () => {
    const ok3 = ['ok', 'ok', 'ok'];
    assert.equal(S.persistenceVerdict('service_role', ok3), 'ok');
    assert.equal(S.persistenceVerdict('anon', ok3), 'anon_key',
      'an anon key outranks everything - it produces empty reads and no errors');
    assert.equal(S.persistenceVerdict('service_role', ['ok', 'key_rejected', 'table_missing']), 'key_rejected',
      'a 403 is what an anon key gets even against tables that exist');
    assert.equal(S.persistenceVerdict('service_role', ['table_missing', 'table_missing', 'table_missing']), 'table_missing');
    assert.equal(S.persistenceVerdict('unknown', ['ok', 'unreachable', 'ok']), 'unreachable');
    assert.equal(S.persistenceVerdict('unknown', ['ok', 'server_error', 'ok']), 'server_error');
    assert.equal(S.persistenceVerdict('unknown', []), 'unknown');
  });

  test('the write probe posts an empty row, which cannot insert anything', async () => {
    responder = async () => json([], 400);
    const verdict = await S.probeSchemaWrite('crews');
    assert.equal(verdict, 'ok');
    const probe = posts()[0];
    assert.deepEqual(probe.body, [{}], 'an empty object: the NOT NULL primary key rejects it');
    assert.equal(probe.method, 'POST');
  });

  test('a healthy project verifies at boot', async () => {
    responder = async () => json([], 400);   // every probe reaches the table
    const h = await S.checkPersistenceHealth();
    assert.equal(h.verdict, 'ok');
    assert.equal(h.configured, true);
    assert.deepEqual([h.crews, h.crewMembers, h.crewClaims], ['ok', 'ok', 'ok']);
    assert.equal(posts().length, 3, 'all three club tables are probed');
  });

  test('an unmigrated project is named, not silently ignored', async () => {
    responder = async () => httpError(404, 'Could not find the table public.crews');
    const h = await S.checkPersistenceHealth();
    assert.equal(h.verdict, 'table_missing');
    assert.equal(h.crews, 'table_missing');
  });

  test('an unreachable project is named', async () => {
    responder = async () => { throw new Error('network down'); };
    const h = await S.checkPersistenceHealth();
    assert.equal(h.verdict, 'unreachable');
  });

  test('/health publishes the verdict so it can be checked with one curl', async () => {
    responder = async () => httpError(404);
    await S.checkPersistenceHealth();
    const { server, base } = listen();
    try {
      const h = await (await fetch(`${base}/health`)).json();
      assert.ok(h.persistence, 'the persistence block is exposed');
      assert.equal(h.persistence.verdict, 'table_missing');
      assert.equal(h.persistence.crews, 'table_missing');
      const body = JSON.stringify(h);
      assert.ok(!body.includes(S.SB_ROLE || 'test-service-role'), 'and it leaks no key material');
    } finally { server.close(); }
  });
});
