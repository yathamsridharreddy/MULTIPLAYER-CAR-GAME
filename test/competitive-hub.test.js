'use strict';
// ---------------------------------------------------------------------------
// v97 — THE COMPETITIVE HUB TOLD THE TRUTH ABOUT NOTHING.
//
// Reported symptom: TRACK RECORDS, DAILY CUP and FOUNDERS CUP were grey and dead,
// and GLOBAL RATING showed numbers that did not survive a second look.
//
// Three separate faults, all verified here:
//
// 1. IDENTITY. player_stats and its eleven sibling tables were declared
//    `user_id uuid references auth.users(id)`, and settlement keyed a guest by their
//    DISPLAY NAME. Postgres rejects a name in a uuid column with a 400, which every
//    fetch guard swallowed - so for anyone not signed in, rating, lap records,
//    achievements, seasons and both cups were read back empty and written nowhere.
//    Two racers who picked the same name also shared one career, and renaming
//    orphaned the old row on the board forever.
//
// 2. THE BOARDS. Each board used the database if it returned ANY row and RAM
//    otherwise, so one durable row hid every racer in the live session; names came
//    only from profiles, so every guest rendered as "RACER"; and total/userRank were
//    capped by the 100-row window, so a racer outside it got no rank at all and the
//    summary bar kept showing whoever had been rendered last.
//
// 3. THE CUPS. Both cup writes sent this race's lap and points with
//    resolution=merge-duplicates, which replaces the row - so the day's fastest lap
//    could regress to a slower one and the week's Founders Cup score was reset to a
//    single race on every finish.
//
// These tests drive the REAL server against a stubbed Supabase (the env vars are set
// before server.js is required, so sbOn() is true in this process only). The stub
// honours the filters, ordering and limits PostgREST would, because the whole point
// of fault 2 is what happens at the edge of a 100-row window.
// ---------------------------------------------------------------------------
process.env.SUPABASE_URL = 'https://fake.supabase.co';
const jwt = (role) => 'eyJhbGciOiJIUzI1NiJ9.' +
  Buffer.from(JSON.stringify({ role })).toString('base64').replace(/=+$/, '') + '.sig';
process.env.SUPABASE_SERVICE_ROLE = jwt('service_role');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const realFetch = global.fetch;
const SB = 'https://fake.supabase.co';
const calls = [];

let schema = { statsKey: 200, statsName: 200, compName: 200 }; // 200 = v97 migration applied
let db = {};
let dbTotal = null;
let writes = [];
let rpcs = [];

const json = (rows, status, headers) => ({
  ok: (status || 200) < 400,
  status: status || 200,
  headers: { get: (k) => ((headers || {})[String(k).toLowerCase()] || null) },
  json: async () => rows,
  text: async () => JSON.stringify(rows)
});

const eqVal = (v) => String(v == null ? '' : v).replace(/^eq\./, '');

function applyQuery(table, rows, q) {
  let out = Array.isArray(rows) ? rows.slice() : [];
  const uidF = q.get('user_id');
  if (uidF && uidF.startsWith('eq.')) out = out.filter((r) => String(r.user_id) === eqVal(uidF));
  else if (uidF && uidF.startsWith('in.')) {
    const list = uidF.slice(3).replace(/^\(/, '').replace(/\)$/, '').split(',');
    out = out.filter((r) => list.indexOf(String(r.user_id)) >= 0);
  }
  if (q.get('date_key')) out = out.filter((r) => String(r.date_key) === eqVal(q.get('date_key')));
  if (q.get('week_key')) out = out.filter((r) => String(r.week_key) === eqVal(q.get('week_key')));
  if (q.get('map')) out = out.filter((r) => Number(r.map) === Number(eqVal(q.get('map'))));
  const rating = q.get('rating');
  if (rating && rating.startsWith('gt.')) out = out.filter((r) => Number(r.rating) > Number(rating.slice(3)));

  const order = q.get('order');
  if (order) {
    const [colRaw, dirRaw] = String(order).split(',')[0].split('.');
    const dir = dirRaw === 'asc' ? 1 : -1;
    out.sort((a, b) => ((Number(a[colRaw]) || 0) - (Number(b[colRaw]) || 0)) * dir);
  }
  const limit = parseInt(q.get('limit'), 10);
  if (limit > 0) out = out.slice(0, limit);
  return out;
}

global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith(SB)) return realFetch(url, opts);
  const method = (opts && opts.method) || 'GET';
  calls.push({ url: u, method, body: opts && opts.body ? JSON.parse(opts.body) : null });
  const parsed = new URL(u);
  const table = parsed.pathname.split('/').pop();
  const q = parsed.searchParams;

  if (parsed.pathname.indexOf('/rpc/') !== -1) {
    // the coin functions answer {ok:true, coins:N}; anything else makes settlement
    // retry three times with backoff, which is what a guest saw in production
    const args = opts && opts.body ? JSON.parse(opts.body) : {};
    rpcs.push({ fn: parsed.pathname.split('/').pop(), args });
    return json({ ok: true, coins: 1000 + (Number(args.p_delta) || 0) }, 200);
  }

  if (method === 'POST') {
    const rows = opts && opts.body ? JSON.parse(opts.body) : null;
    // the boot probe posts a single empty row: 400 then means "the table exists and
    // this key may write to it", and nothing is ever inserted
    const isProbe = Array.isArray(rows) && rows.length === 1 && Object.keys(rows[0] || {}).length === 0;
    if (isProbe) return json({ message: 'null value in column "id" violates not-null constraint' }, 400);
    if (rows) writes.push({ table, rows });
    return json([], 201);
  }
  if (method === 'DELETE') return json([], 204);

  // the boot probes that ask about the schema itself
  if (table === 'player_stats' && q.get('user_id') === 'eq.sr-probe-not-a-uuid') return json([], schema.statsKey);
  if (table === 'player_stats' && q.get('select') === 'name') return json([], schema.statsName);
  if (table === 'daily_competition' && q.get('select') === 'name') return json([], schema.compName);

  // a uuid column rejects a non-uuid filter value exactly like PostgREST does
  const UUID_TABLES = ['player_stats', 'player_map_records', 'race_history', 'player_achievements',
    'player_seasons', 'player_wallet', 'player_inventory', 'player_equipped', 'coin_ledger',
    'daily_competition', 'weekly_competition', 'season_rewards_claimed'];
  const uidF = q.get('user_id');
  if (schema.statsKey === 400 && UUID_TABLES.indexOf(table) >= 0 && uidF && uidF.startsWith('eq.')
      && !/^[0-9a-f-]{36}$/i.test(eqVal(uidF))) {
    return json({ message: 'invalid input syntax for type uuid' }, 400);
  }

  const rows = applyQuery(table, db[table], q);
  const hdrs = {};
  if (table === 'player_stats' && dbTotal != null) {
    hdrs['content-range'] = (rows.length ? '0-' + (rows.length - 1) : '*') + '/' + dbTotal;
  }
  return json(rows, 200, hdrs);
};

const S = require('../server.js');
const CORE = require('../shared/game-core.js');
const {
  app, settleRace, memPlayerStats, memDailyComp, memWeeklyComp, hydrated,
  canonicalRacerKey, racerIdentities, rowMatchesIdentities,
  mergeStatsRows, mergeDailyRow, mergeWeeklyRow,
  withStatsName, withCompName, sbStatsState, checkPersistenceHealth, persistenceHealth
} = S;

let server, baseUrl;
const get = (path) => new Promise((resolve, reject) => {
  http.get(baseUrl + path, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (e) { reject(e); } });
  }).on('error', reject);
});

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const statRow = (user_id, rating, extra) => Object.assign({
  user_id, rating, xp: 0, races: 9, wins: 5, podiums: 6, streak: 0, best_streak: 0
}, extra || {});

describe('v97 competitive hub — identity, boards and cup totals', () => {
  before(async () => {
    await new Promise((r) => { server = app.listen(0, () => { baseUrl = 'http://127.0.0.1:' + server.address().port; r(); }); });
  });
  after(async () => { if (server) await new Promise((r) => server.close(r)); });

  beforeEach(async () => {
    memPlayerStats.clear();
    memDailyComp.clear();
    memWeeklyComp.clear();
    hydrated.clear();
    db = {};
    dbTotal = null;
    writes = [];
    rpcs = [];
    calls.length = 0;
    schema = { statsKey: 200, statsName: 200, compName: 200 };
    await checkPersistenceHealth();   // flags follow the schema this test declared
  });

  // ---- 1. one canonical identity per racer ---------------------------------
  describe('canonical racer identity', () => {
    test('a verified account keys on its bare uuid, whichever form it arrives in', () => {
      assert.equal(canonicalRacerKey({ sbUid: UUID_A, pid: 'sb:' + UUID_A, name: 'SRI' }), UUID_A);
      assert.equal(canonicalRacerKey({ pid: 'sb:' + UUID_A }), UUID_A, 'the signed-in pid form collapses to the same row');
    });

    test('a guest keys on the device pid, never the display name', () => {
      assert.equal(canonicalRacerKey({ pid: 'p3k9x2ab1c2d', name: 'SRI' }), 'p3k9x2ab1c2d');
    });

    test('the name is a last resort and is namespaced so it cannot collide with a pid', () => {
      assert.equal(canonicalRacerKey({ name: 'SRI' }), 'name:SRI');
      assert.equal(canonicalRacerKey({}), '');
      assert.equal(canonicalRacerKey(null), '');
    });

    test('racerIdentities carries every form a row could be stored under', () => {
      const ids = racerIdentities({ uid: UUID_A, sbUid: UUID_A, pid: 'sb:' + UUID_A, name: 'SRI' });
      assert.ok(ids.indexOf(UUID_A) >= 0, 'bare uuid');
      assert.ok(ids.indexOf('sb:' + UUID_A) >= 0, 'the pid form the client sends while signed in');
      assert.ok(ids.indexOf('name:SRI') >= 0, 'rows written before v97 are keyed by name');
      assert.ok(ids.indexOf('SRI') >= 0, 'and matched by display name');
      assert.deepEqual(racerIdentities(null), []);
    });

    test('a guest asking by pid finds their row, and never somebody else', () => {
      const ids = racerIdentities({ uid: 'p3k9x2ab', pid: 'p3k9x2ab', name: 'SRI' });
      assert.ok(rowMatchesIdentities({ uid: 'p3k9x2ab', name: 'SRI' }, ids));
      assert.ok(rowMatchesIdentities({ uid: 'other', name: 'SRI' }, ids), 'a pre-v97 row keyed by name');
      assert.ok(!rowMatchesIdentities({ uid: 'other', name: 'OTHER' }, ids));
      assert.ok(!rowMatchesIdentities(null, ids));
    });

    test('two racers who pick the same display name no longer share one career', () => {
      assert.notEqual(canonicalRacerKey({ pid: 'pAAAA', name: 'SRI' }), canonicalRacerKey({ pid: 'pBBBB', name: 'SRI' }),
        'the old key was the bare name, so these were one row');
    });
  });

  // ---- 2. merging one racer's two rows -------------------------------------
  describe('career merge (guest row folded into the account row)', () => {
    test('disjoint histories add, ratings take the best, a name is never lost', () => {
      const m = mergeStatsRows(
        { user_id: UUID_A, rating: 1180, peak_rating: 1200, xp: 500, races: 9, wins: 4, podiums: 6, streak: 0, best_streak: 3, name: '' },
        { user_id: 'pGUEST', rating: 1240, peak_rating: 1240, xp: 300, races: 5, wins: 1, podiums: 2, streak: 2, best_streak: 2, name: 'SRI' }
      );
      assert.equal(m.races, 14);
      assert.equal(m.wins, 5);
      assert.equal(m.xp, 800);
      assert.equal(m.rating, 1240, 'rating is a skill level, not a sum');
      assert.equal(m.peak_rating, 1240);
      assert.equal(m.best_streak, 3);
      assert.equal(m.streak, 0, 'the live account streak wins');
      assert.equal(m.name, 'SRI');
    });

    test('merging with nothing on either side is safe', () => {
      assert.equal(mergeStatsRows(null, { races: 3 }).races, 3);
      assert.equal(mergeStatsRows({ races: 3 }, null).races, 3);
      assert.deepEqual(mergeStatsRows(null, null), {});
    });
  });

  // ---- 3. cup rows are running totals --------------------------------------
  describe('cup row merges', () => {
    test('the daily cup keeps the FASTEST lap of the day, not the latest', () => {
      const m = mergeDailyRow({ user_id: 'pA', best_lap_ms: 41200, races_today: 4, name: 'SRI' },
                              { user_id: 'pA', best_lap_ms: 43900, races_today: 1 });
      assert.equal(m.best_lap_ms, 41200);
      assert.equal(m.races_today, 4, 'a mirror, not a disjoint history - never summed');
      assert.equal(m.name, 'SRI');
    });

    test('a null lap on either side does not wipe the real one', () => {
      assert.equal(mergeDailyRow({ best_lap_ms: null }, { best_lap_ms: 41200 }).best_lap_ms, 41200);
      assert.equal(mergeDailyRow({ best_lap_ms: 41200 }, { best_lap_ms: null }).best_lap_ms, 41200);
    });

    test('the founders cup keeps the MOST points of the week, not the last race', () => {
      const m = mergeWeeklyRow({ user_id: 'pA', points: 180, races_week: 9, wins_week: 3, best_lap_ms: 45000 },
                               { user_id: 'pA', points: 25, races_week: 1, wins_week: 1, best_lap_ms: 41200 });
      assert.equal(m.points, 180, 'the old write reset the week to 25 on every finish');
      assert.equal(m.races_week, 9);
      assert.equal(m.wins_week, 3);
      assert.equal(m.best_lap_ms, 41200);
    });
  });

  // ---- 4. the boot probe tells the truth about the schema ------------------
  describe('schema probe', () => {
    test('a v97 database reports text keys and both name columns', () => {
      const st = sbStatsState();
      assert.equal(st.keyType, 'text');
      assert.equal(st.hasName, true);
      assert.equal(st.compHasName, true);
      assert.equal(persistenceHealth.playerStatsKeyType, 'text');
      assert.equal(persistenceHealth.verdict, 'ok');
    });

    test('a pre-v97 database is named as uuid, which is why guest results vanish', async () => {
      schema = { statsKey: 400, statsName: 400, compName: 400 };
      await checkPersistenceHealth();
      const st = sbStatsState();
      assert.equal(st.keyType, 'uuid', 'Postgres rejects a pid in a uuid column with a 400');
      assert.equal(st.hasName, false);
      assert.equal(st.compHasName, false);
    });

    test('/health publishes it, so the cause is readable without a log dive', async () => {
      schema = { statsKey: 400, statsName: 400, compName: 400 };
      await checkPersistenceHealth();
      const res = await get('/health');
      assert.equal(res.status, 200);
      assert.equal(res.json.persistence.playerStatsKeyType, 'uuid');
      assert.equal(res.json.persistence.playerStatsHasName, false);
      assert.equal(res.json.persistence.compHasName, false);
    });

    test('a missing table or a rejected key is reported, not guessed as uuid', async () => {
      schema.statsKey = 404;
      await checkPersistenceHealth();
      assert.equal(sbStatsState().keyType, 'table_missing');
      schema.statsKey = 403;
      await checkPersistenceHealth();
      assert.equal(sbStatsState().keyType, 'key_rejected');
    });

    test('the name column is only sent once the probe has seen it', async () => {
      assert.equal(withStatsName('SRI', { user_id: 'pA' }).name, 'SRI');
      assert.equal(withCompName('SRI', { user_id: 'pA' }).name, 'SRI');
      schema = { statsKey: 200, statsName: 400, compName: 400 };
      await checkPersistenceHealth();
      // an unknown column would 400 the whole upsert and lose the rating with it
      assert.equal(withStatsName('SRI', { user_id: 'pA' }).name, undefined);
      assert.equal(withCompName('SRI', { user_id: 'pA' }).name, undefined);
      assert.equal(withStatsName('', { user_id: 'pA' }).name, undefined, 'and never an empty name');
    });
  });

  // ---- 5. the global rating board ------------------------------------------
  describe('GET /api/leaderboard?type=rating', () => {
    test('merges the durable rows with the live session instead of hiding one behind the other', async () => {
      db.player_stats = [statRow(UUID_A, 1400, { xp: 900, races: 20, wins: 12 })];
      db.profiles = [{ id: UUID_A, username: 'SRI' }];
      memPlayerStats.set('pGUEST', { uid: 'pGUEST', name: 'ASH', rating: 1250, xp: 400, races: 8, wins: 3, podiums: 5, streak: 1, best_streak: 2 });

      const res = await get('/api/leaderboard?type=rating');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.rows.map((r) => r.name), ['SRI', 'ASH'], 'the guest mid-session was invisible before v97');
      assert.equal(res.json.rows[0].rank, 1);
      assert.equal(res.json.rows[1].rank, 2);
    });

    test('one racer present in both sources appears once, with the better-informed row', async () => {
      db.player_stats = [statRow('pA', 1300, { xp: 700, races: 30, wins: 18, name: 'SRI' })];
      db.profiles = [];
      memPlayerStats.set('pA', { uid: 'pA', name: 'SRI', rating: 1100, xp: 100, races: 3, wins: 1, podiums: 1, streak: 1, best_streak: 1 });

      const res = await get('/api/leaderboard?type=rating');
      assert.equal(res.json.rows.length, 1, 'not two careers for one racer');
      assert.equal(res.json.rows[0].races, 30);
      assert.equal(res.json.rows[0].rating, 1300);
      assert.equal(res.json.total, 1);
    });

    test('a racer with no profiles row is named from their own stats row', async () => {
      db.player_stats = [statRow('pA', 1300, { races: 4, name: 'ASH' })];
      db.profiles = [];
      const res = await get('/api/leaderboard?type=rating');
      assert.equal(res.json.rows[0].name, 'ASH', 'used to render as RACER next to a real rating');
    });

    test('reports the true field size, not the size of the fetched window', async () => {
      db.player_stats = [statRow(UUID_A, 1500), statRow(UUID_B, 1450)];
      dbTotal = 137;
      db.profiles = [];
      const res = await get('/api/leaderboard?type=rating');
      assert.equal(res.json.total, 137, 'percentile and rank were computed against 2 before');
      assert.equal(res.json.rows.length, 2);
    });

    test('finds the asker by device pid and returns their own row', async () => {
      db.player_stats = [statRow(UUID_A, 1500), statRow('pGUEST', 1450, { name: 'ASH' })];
      db.profiles = [{ id: UUID_A, username: 'SRI' }];
      const res = await get('/api/leaderboard?type=rating&uid=pGUEST&pid=pGUEST&name=ASH');
      assert.equal(res.json.userRank, 2, 'the client sends a pid; rows used to be keyed by name');
      assert.equal(res.json.rankExact, true);
      assert.equal(res.json.me.uid, 'pGUEST');
      assert.equal(res.json.me.rating, 1450);
      assert.equal(res.json.me.name, 'ASH');
      assert.equal(res.json.me.tier.name, res.json.rows[1].tier.name, 'the bar and the row must agree');
      assert.equal(res.json.rows[1].rating, 1450);
    });

    test('finds a signed-in asker whose row is stored under the sb: pid form', async () => {
      db.player_stats = [statRow(UUID_A, 1500)];
      db.profiles = [{ id: UUID_A, username: 'SRI' }];
      const res = await get('/api/leaderboard?type=rating&uid=' + UUID_A + '&sbUid=' + UUID_A + '&pid=sb%3A' + UUID_A + '&name=SRI');
      assert.equal(res.json.userRank, 1);
      assert.equal(res.json.me.name, 'SRI');
      assert.equal(res.json.me.uid, UUID_A);
    });

    test('a racer outside the 100-row window gets their real rank, not nothing', async () => {
      const field = [];
      for (let i = 0; i < 120; i++) field.push(statRow('p' + i, 2000 - i * 5));
      db.player_stats = field;                    // p100 rates 1500: 100 racers sit above them
      dbTotal = 120;
      db.profiles = [];

      const res = await get('/api/leaderboard?type=rating&uid=p100&pid=p100');
      assert.equal(res.json.rows.length, 20, 'the page is still 20 rows');
      assert.ok(!res.json.rows.some((r) => r.uid === 'p100'), 'and the asker is not on it');
      assert.equal(res.json.userRank, 101, 'counted from the whole field, not the window');
      assert.equal(res.json.rankExact, true);
      assert.equal(res.json.me.rating, 1500);
      assert.equal(res.json.total, 120);
    });

    test('says so honestly when the asker has no row at all', async () => {
      db.player_stats = [statRow(UUID_A, 1500)];
      db.profiles = [];
      const res = await get('/api/leaderboard?type=rating&uid=pNOBODY&pid=pNOBODY');
      assert.equal(res.json.userRank, null);
      assert.equal(res.json.me, null);
      assert.equal(res.json.rankExact, false, 'the client clears the bar rather than showing stale numbers');
    });

    test('nearby scope brackets the asker rather than the top of the field', async () => {
      db.player_stats = [
        statRow('p1', 1900), statRow('p2', 1800), statRow('p3', 1700), statRow('p4', 1600), statRow('p5', 1500),
        statRow('p6', 1450), statRow('p7', 1400), statRow('p8', 1300), statRow('p9', 1200)
      ];
      db.profiles = [];
      const res = await get('/api/leaderboard?type=rating&scope=nearby&uid=p7&pid=p7');
      assert.equal(res.json.userRank, 7);
      const uids = res.json.rows.map((r) => r.uid);
      assert.deepEqual(uids, ['p5', 'p6', 'p7', 'p8', 'p9'], 'the bracket around the asker');
      assert.ok(uids.indexOf('p1') < 0, 'not the top of the field, which is all the old default scope showed');
    });

    test('still answers from RAM alone when the database has nothing', async () => {
      db.player_stats = [];
      db.profiles = [];
      memPlayerStats.set('pA', { uid: 'pA', name: 'ASH', rating: 1250, xp: 400, races: 8, wins: 3, podiums: 5, streak: 1, best_streak: 2 });
      const res = await get('/api/leaderboard?type=rating');
      assert.equal(res.json.rows.length, 1);
      assert.equal(res.json.rows[0].name, 'ASH');
      assert.equal(res.json.rows[0].winRate, '37.5%');
    });

    test('wins and races boards sort on their own metric after the merge', async () => {
      db.player_stats = [];
      db.profiles = [];
      memPlayerStats.set('pA', { uid: 'pA', name: 'A', rating: 1000, xp: 0, races: 40, wins: 2, podiums: 3 });
      memPlayerStats.set('pB', { uid: 'pB', name: 'B', rating: 1000, xp: 0, races: 10, wins: 9, podiums: 9 });
      assert.equal((await get('/api/leaderboard?type=wins')).json.rows[0].name, 'B');
      assert.equal((await get('/api/leaderboard?type=races')).json.rows[0].name, 'A');
    });
  });

  // ---- 6. track records -----------------------------------------------------
  describe('GET /api/leaderboard?type=time', () => {
    test('finds the asker by pid among the record holders', async () => {
      db.leaderboard = [
        { name: 'SRI', pid: 'pFAST', map: 0, time_ms: 41200, updated_at: '2026-09-01T00:00:00Z' },
        { name: 'ASH', pid: 'pSLOW', map: 0, time_ms: 44900, updated_at: '2026-09-01T00:00:00Z' }
      ];
      const res = await get('/api/leaderboard?type=time&map=0&uid=pSLOW&pid=pSLOW&name=ASH');
      assert.equal(res.json.userRank, 2, 'a record is stored under the pid the client sends');
      assert.equal(res.json.rows[0].name, 'SRI');
      assert.equal(res.json.rows[0].timeFormatted, CORE.fmtTime(41.2));
    });
  });

  // ---- 7. the two cups ------------------------------------------------------
  describe('GET /api/competitions/daily and /weekly', () => {
    test('the daily cup merges the durable day with the live session', async () => {
      const day = new Date().toISOString().slice(0, 10);
      db.daily_competition = [{ user_id: UUID_A, date_key: day, map: 0, best_lap_ms: 40100, races_today: 6, name: 'SRI' }];
      db.profiles = [];
      memDailyComp.set(day, new Map([['pGUEST', { user_id: 'pGUEST', name: 'ASH', map: 0, best_lap_ms: 41500, races_today: 2 }]]));

      const res = await get('/api/competitions/daily?uid=pGUEST&pid=pGUEST&name=ASH');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.leaderboard.map((e) => e.name), ['SRI', 'ASH']);
      assert.equal(res.json.userEntry.rank, 2, 'the asker is found by pid');
      assert.equal(res.json.userEntry.bestFormatted, CORE.fmtTime(41.5));
      assert.equal(res.json.targetFormatted, CORE.fmtTime(40.1));
    });

    test('the daily cup keeps one row per racer and the fastest lap across both sources', async () => {
      const day = new Date().toISOString().slice(0, 10);
      db.daily_competition = [{ user_id: 'pA', date_key: day, map: 0, best_lap_ms: 43900, races_today: 1, name: 'SRI' }];
      db.profiles = [];
      memDailyComp.set(day, new Map([['pA', { user_id: 'pA', name: 'SRI', map: 0, best_lap_ms: 41200, races_today: 4 }]]));
      const res = await get('/api/competitions/daily?uid=pA&pid=pA');
      assert.equal(res.json.leaderboard.length, 1);
      assert.equal(res.json.leaderboard[0].bestMs, 41200);
      assert.equal(res.json.leaderboard[0].racesToday, 4);
      assert.equal(res.json.userEntry.rank, 1);
    });

    test('the founders cup merges the durable week with the live session, most points first', async () => {
      const wk = S.currentWeekKey();
      db.weekly_competition = [{ user_id: UUID_A, week_key: wk, points: 220, races_week: 12, wins_week: 5, best_lap_ms: 41000, name: 'SRI' }];
      db.profiles = [];
      memWeeklyComp.set(wk, new Map([['pGUEST', { user_id: 'pGUEST', name: 'ASH', points: 310, races_week: 9, wins_week: 7, best_lap_ms: 42000 }]]));

      const res = await get('/api/competitions/weekly?uid=pGUEST&pid=pGUEST');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.leaderboard.map((e) => e.name), ['ASH', 'SRI'], 'the live session leader was invisible before');
      assert.equal(res.json.userEntry.rank, 1);
      assert.equal(res.json.userEntry.points, 310);
    });
  });

  // ---- 8. settlement --------------------------------------------------------
  describe('settleRace', () => {
    const entryWith = (pidBySlot, uidBySlot) => ({
      room: {
        code: 'V97TEST', map: 0, mapId: 0, mode: 'race',
        players: [
          { slot: 1, name: 'SRI', isBot: false },
          { slot: 2, name: 'SRI', isBot: false }      // same display name, different device
        ],
        cars: [], ai: false,
        standings: () => ([
          { slot: 1, name: 'SRI', participating: true, finished: true, finishTime: 47.7, best: 15.4, lapTimes: [15.4] },
          { slot: 2, name: 'SRI', participating: true, finished: true, finishTime: 50.6, best: 16.5, lapTimes: [16.5] }
        ])
      },
      screens: new Set(), specs: new Set(), controllers: new Map(),
      uidBySlot: uidBySlot || {}, pidBySlot: pidBySlot || {}, ratingBySlot: {}, dupUid: {}, _settled: false
    });

    test('keys a guest career by device pid, so two racers named SRI stay two racers', async () => {
      const out = await settleRace(entryWith({ 1: 'pDEVICE_A', 2: 'pDEVICE_B' }));
      assert.equal(out.length, 2);
      assert.ok(memPlayerStats.has('pDEVICE_A'), 'stats land under the device pid');
      assert.ok(memPlayerStats.has('pDEVICE_B'));
      assert.ok(!memPlayerStats.has('SRI'), 'the old key merged them into one career');
      assert.equal(memPlayerStats.get('pDEVICE_A').name, 'SRI', 'and the name is still carried');
      assert.notEqual(memPlayerStats.get('pDEVICE_A').rating, memPlayerStats.get('pDEVICE_B').rating,
        'the winner and the loser moved apart, which one shared row could never do');
    });

    test('a verified account still keys on its uuid', async () => {
      await settleRace(entryWith({ 1: 'pDEVICE_A', 2: 'pDEVICE_B' }, { 1: UUID_A }));
      assert.ok(memPlayerStats.has(UUID_A));
      assert.ok(memPlayerStats.has('pDEVICE_B'));
      assert.ok(!memPlayerStats.has('pDEVICE_A'), 'the account row supersedes the device row for that slot');
    });

    test('writes the week ACCUMULATED total to the founders cup, not this race alone', async () => {
      const wk = S.currentWeekKey();
      memWeeklyComp.set(wk, new Map([['pDEVICE_A', { user_id: 'pDEVICE_A', name: 'SRI', points: 180, races_week: 9, wins_week: 3, best_lap_ms: 41200 }]]));
      hydrated.add('weeklycomp|' + wk + '|pDEVICE_A');       // already seeded, as it would be mid-week
      hydrated.add('weeklycomp|' + wk + '|pDEVICE_B');
      hydrated.add('dailycomp|' + new Date().toISOString().slice(0, 10) + '|pDEVICE_A');
      hydrated.add('dailycomp|' + new Date().toISOString().slice(0, 10) + '|pDEVICE_B');

      await settleRace(entryWith({ 1: 'pDEVICE_A', 2: 'pDEVICE_B' }));

      const mine = writes.filter((w) => w.table === 'weekly_competition').map((w) => w.rows[0])
        .find((r) => r.user_id === 'pDEVICE_A');
      assert.ok(mine, 'the cup row is written');
      assert.ok(mine.points > 180, 'the week keeps accumulating, got ' + mine.points);
      assert.ok(mine.races_week >= 10, 'race count is the week total, got ' + mine.races_week);
      assert.equal(mine.best_lap_ms, 15400, 'and the lap is this racer\'s best, in ms');
    });

    test('seeds the week from the database after a restart instead of resuming at zero', async () => {
      const wk = S.currentWeekKey();
      db.weekly_competition = [{ user_id: 'pDEVICE_A', week_key: wk, points: 180, races_week: 9, wins_week: 3, best_lap_ms: 41200 }];

      await settleRace(entryWith({ 1: 'pDEVICE_A', 2: 'pDEVICE_B' }));

      const seeded = memWeeklyComp.get(wk).get('pDEVICE_A');
      assert.ok(seeded, 'this racer has a weekly row');
      assert.ok(seeded.points > 180, 'the durable week was read back before adding to it, got ' + seeded.points);
      assert.ok(seeded.races_week >= 10, 'got ' + seeded.races_week);
      const written = writes.filter((w) => w.table === 'weekly_competition').map((w) => w.rows[0])
        .find((r) => r.user_id === 'pDEVICE_A');
      assert.ok(written.points > 180, 'and the write carries the total, not the single race');
    });

    test('the daily cup write keeps the day\'s fastest lap across races', async () => {
      const day = new Date().toISOString().slice(0, 10);
      memDailyComp.set(day, new Map([['pDEVICE_A', { user_id: 'pDEVICE_A', name: 'SRI', map: 0, best_lap_ms: 14100, races_today: 3 }]]));
      hydrated.add('dailycomp|' + day + '|pDEVICE_A');
      hydrated.add('dailycomp|' + day + '|pDEVICE_B');
      hydrated.add('weeklycomp|' + S.currentWeekKey() + '|pDEVICE_A');
      hydrated.add('weeklycomp|' + S.currentWeekKey() + '|pDEVICE_B');

      await settleRace(entryWith({ 1: 'pDEVICE_A', 2: 'pDEVICE_B' }));

      const dc = writes.filter((w) => w.table === 'daily_competition').map((w) => w.rows[0]);
      if (!dc.length) {
        assert.notEqual(S.dailyInfo().map, 0, 'the daily cup only tracks today\'s map, which is not map 0 today');
        return;
      }
      const mine = dc.find((r) => r.user_id === 'pDEVICE_A');
      assert.equal(mine.best_lap_ms, 14100, 'a slower lap this race must not replace the day\'s best');
      assert.equal(mine.races_today, 4);
    });

    test('sends the racer name on the stats and cup rows once the schema has the column', async () => {
      assert.equal(sbStatsState().hasName, true);
      const wk = S.currentWeekKey();
      hydrated.add('weeklycomp|' + wk + '|pDEVICE_A');
      hydrated.add('weeklycomp|' + wk + '|pDEVICE_B');
      hydrated.add('dailycomp|' + new Date().toISOString().slice(0, 10) + '|pDEVICE_A');
      hydrated.add('dailycomp|' + new Date().toISOString().slice(0, 10) + '|pDEVICE_B');

      await settleRace(entryWith({ 1: 'pDEVICE_A', 2: 'pDEVICE_B' }));

      const stats = writes.filter((w) => w.table === 'player_stats').map((w) => w.rows[0]);
      assert.ok(stats.some((r) => r.user_id === 'pDEVICE_A' && r.name === 'SRI'), 'named on the stats row');
      const wc = writes.filter((w) => w.table === 'weekly_competition').map((w) => w.rows[0]);
      assert.ok(wc.length && wc.every((r) => r.name === 'SRI'), 'named on the cup rows too');
    });

    test('v115: settlement never calls the wallet RPCs again', async () => {
      await settleRace(entryWith({ 1: 'pDEVICE_A', 2: 'pDEVICE_B' }));
      const earned = rpcs.filter((r) => r.fn === 'earn_coins');
      assert.equal(earned.length, 0, 'v115: the coin economy retired with the garage - no wallet RPCs');
    });

    test('omits the name column entirely on a pre-v97 schema, so the upsert still lands', async () => {
      schema = { statsKey: 400, statsName: 400, compName: 400 };
      await checkPersistenceHealth();
      assert.equal(sbStatsState().hasName, false);

      await settleRace(entryWith({ 1: 'pDEVICE_A', 2: 'pDEVICE_B' }));

      const stats = writes.filter((w) => w.table === 'player_stats').map((w) => w.rows[0]);
      assert.ok(stats.length > 0, 'the rating is still written');
      assert.ok(stats.every((r) => r.name === undefined), 'an unknown column would 400 the whole row');
    });
  });
});
