'use strict';
// ---------------------------------------------------------------------------
// v94 production audit — regression tests for the hardening fixes.
//
//   AUDIT-F1  /a and /ghost hung forever on application/json (express.json had
//             already drained the stream, so the hand-rolled reader never saw
//             'end'). A loop of JSON POSTs was a connection-exhaustion DoS.
//   AUDIT-F2  Ghost uploads were stored verbatim; one junk frame threw inside
//             the victim's snapshot handler and froze their live race.
//   AUDIT-F3  Twelve in-memory stores plus AN.users were never evicted — a
//             long-lived process grew until the host OOM-killed it.
//   AUDIT-F4  buy/equip swallowed every failure in an empty catch, so a click
//             did nothing at all when Supabase was not configured.
//   AUDIT-F5  No security headers were sent.
// ---------------------------------------------------------------------------
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const path = require('path');
const {
  app, AN, handleMessage,
  readCappedBody, sanitizeGhostData, sweepMemory, capMap, pruneOldPeriods, periodAgeMs, capAnUsers,
  memPlayerMissions, memWeeklyBounties, memDailyComp, memWeeklyComp, memRevengeTargets,
  MEM_CAP, durabilityReport
} = require('../server.js');

const SB_OFF = !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE;

function listen() {
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// A stand-in for a request whose stream has NOT been consumed yet.
function liveStream(chunks) {
  const req = new EventEmitter();
  req.readable = true;
  setImmediate(() => { for (const c of chunks) req.emit('data', c); req.emit('end'); });
  return req;
}

describe('AUDIT-F1 — request bodies always produce a response', () => {
  test('uses the body express.json already parsed', async () => {
    const out = await readCappedBody({ body: { e: 'visit', pid: 'p1' } }, 2000);
    assert.deepEqual(JSON.parse(out), { e: 'visit', pid: 'p1' });
  });

  test('an empty parsed object resolves as {} instead of waiting for a stream that is gone', async () => {
    const t0 = Date.now();
    const out = await readCappedBody({ body: {}, _body: true, readable: false }, 2000);
    assert.equal(out, '{}');
    assert.ok(Date.now() - t0 < 200, 'must not wait on the watchdog');
  });

  test('honours the size cap on a parsed body', async () => {
    const out = await readCappedBody({ body: { s: 'x'.repeat(5000) } }, 100);
    assert.equal(out.length, 100);
  });

  test('streams a request the JSON parser skipped (the shipped client sends text/plain)', async () => {
    const out = await readCappedBody(liveStream(['{"e":"vi', 'sit"}']), 2000);
    assert.deepEqual(JSON.parse(out), { e: 'visit' });
  });

  test('a drained stream resolves immediately rather than hanging', async () => {
    const req = new EventEmitter();
    req.readable = false;
    const t0 = Date.now();
    const out = await readCappedBody(req, 2000);
    assert.equal(out, '');
    assert.ok(Date.now() - t0 < 200);
  });

  test('the watchdog answers even if the client never finishes sending', async () => {
    const req = new EventEmitter();
    req.readable = true;
    const t0 = Date.now();
    const out = await readCappedBody(req, 2000, 80);
    assert.equal(out, '');
    const waited = Date.now() - t0;
    assert.ok(waited >= 70 && waited < 1500, `watchdog fired late/early: ${waited}ms`);
  });

  test('POST /a with Content-Type: application/json is answered (was an 8s+ hang)', async () => {
    const { server, base } = listen();
    const before = AN.counts.visits;
    try {
      const t0 = Date.now();
      const res = await fetch(`${base}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ e: 'visit', pid: 'audit-json' }),
        signal: AbortSignal.timeout(4000) // fails the test instead of hanging it
      });
      const ms = Date.now() - t0;
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.ok(ms < 1500, `JSON analytics POST took ${ms}ms — the hang is back`);
      assert.equal(AN.counts.visits, before + 1, 'the parsed body must actually be processed');
    } finally { server.close(); }
  });

  test('POST /a with text/plain still works (the client path must not regress)', async () => {
    const { server, base } = listen();
    const before = AN.counts.racesStarted;
    try {
      const res = await fetch(`${base}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ e: 'race', map: 3, pid: 'audit-plain' }),
        signal: AbortSignal.timeout(4000)
      });
      assert.equal(res.status, 200);
      assert.equal(AN.counts.racesStarted, before + 1);
      assert.equal(AN.byMap[3] >= 1, true);
    } finally { server.close(); }
  });

  test('POST /a with malformed JSON is answered, never thrown', async () => {
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{"e":',
        signal: AbortSignal.timeout(4000)
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    } finally { server.close(); }
  });

  test('POST /ghost with Content-Type: application/json is answered', async (t) => {
    if (!SB_OFF) return t.skip('Supabase is configured; the 503 branch does not apply');
    const { server, base } = listen();
    try {
      const t0 = Date.now();
      const res = await fetch(`${base}/ghost`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ map: 0, name: 'AUDIT', data: [[0, 1, 2, 3]] }),
        signal: AbortSignal.timeout(4000)
      });
      assert.equal(res.status, 503, 'no database configured -> unavailable, but ANSWERED');
      assert.ok(Date.now() - t0 < 1500, 'ghost upload must not hang');
    } finally { server.close(); }
  });
});

describe('AUDIT-F2 — ghost payloads are validated before they reach another player', () => {
  const frame = (t, x, z, h) => [t, x, z, h];
  const good = (n) => Array.from({ length: n }, (_, i) => frame(i * 0.1, 10 + i * 0.01, -5 + i * 0.01, 1.57));

  test('accepts the recorder format and normalises it to 2 decimals', () => {
    const out = sanitizeGhostData([[0.123456, 1.987654, -2.555555, 3.14159]].concat(good(11)));
    assert.ok(Array.isArray(out) && out.length === 12);
    assert.deepEqual(out[0], [0.12, 1.99, -2.56, 3.14]);
    assert.ok(out.every((f) => f.length === 4 && f.every((v) => typeof v === 'number' && Number.isFinite(v))));
  });

  test('rejects the payloads that used to freeze a victim’s race', () => {
    assert.equal(sanitizeGhostData(null), null);
    assert.equal(sanitizeGhostData({}), null);
    assert.equal(sanitizeGhostData('nope'), null);
    assert.equal(sanitizeGhostData(good(9)), null, 'fewer than 10 frames');
    assert.equal(sanitizeGhostData(good(4001)), null, 'more than 4000 frames');
    assert.equal(sanitizeGhostData(Array(12).fill(null)), null, 'null frames');
    assert.equal(sanitizeGhostData(Array(12).fill('x')), null, 'string frames');
    assert.equal(sanitizeGhostData(Array(12).fill({ a: 1 })), null, 'object frames');
    assert.equal(sanitizeGhostData(Array(12).fill([1, 2])), null, 'truncated frames');
    assert.equal(sanitizeGhostData(good(11).concat([[NaN, 1, 2, 3]])), null, 'NaN');
    assert.equal(sanitizeGhostData(good(11).concat([[Infinity, 1, 2, 3]])), null, 'Infinity');
    assert.equal(sanitizeGhostData(good(11).concat([['abc', 1, 2, 3]])), null, 'non-numeric strings');
    // numeric strings are coerced, never stored as strings - what reaches the DB
    // (and another player's render loop) is always real finite numbers
    const coerced = sanitizeGhostData(good(11).concat([['0.5', '1', '2', '3']]));
    assert.ok(coerced, 'numeric strings are acceptable input');
    assert.ok(coerced.every((f) => f.every((v) => typeof v === 'number' && Number.isFinite(v))), 'and become numbers');
    assert.deepEqual(coerced[11], [0.5, 1, 2, 3]);
  });

  test('rejects values outside any real lap', () => {
    assert.equal(sanitizeGhostData(good(11).concat([[-1, 0, 0, 0]])), null, 'negative time');
    assert.equal(sanitizeGhostData(good(11).concat([[99999, 0, 0, 0]])), null, 'absurd time');
    assert.equal(sanitizeGhostData(good(11).concat([[1, 1e9, 0, 0]])), null, 'absurd coordinate');
    assert.equal(sanitizeGhostData(good(11).concat([[1, 0, 0, 1e9]])), null, 'absurd heading');
  });

  test('a heading-less frame still passes (3 numbers is enough to draw a ghost)', () => {
    const out = sanitizeGhostData(Array.from({ length: 12 }, (_, i) => [i * 0.1, i, -i]));
    assert.ok(out && out.length === 12);
    assert.deepEqual(out[3], [0.3, 3, -3, 0]);
  });
});

describe('AUDIT-F3 — in-memory stores are bounded', () => {
  test('capMap evicts the OLDEST entries first', () => {
    const m = new Map();
    for (let i = 0; i < 10; i++) m.set('k' + i, i);
    const evicted = capMap(m, 4, 'test-store');
    assert.equal(evicted, 6);
    assert.equal(m.size, 4);
    assert.deepEqual([...m.keys()], ['k6', 'k7', 'k8', 'k9']);
  });

  test('capMap is a no-op under the cap', () => {
    const m = new Map([['a', 1]]);
    assert.equal(capMap(m, 10, 'test-store'), 0);
    assert.equal(m.size, 1);
    assert.equal(capMap(null, 10, 'nope'), 0, 'tolerates a missing store');
  });

  const YEAR = 365 * 86400000; // large maxAge -> exercises the "newest N periods" rule on its own

  test('pruneOldPeriods keeps the newest periods of `${period}:${uid}` keys', () => {
    const m = new Map([
      ['2026-09-01:u1', {}], ['2026-09-01:u2', {}],
      ['2026-09-02:u1', {}],
      ['2026-09-19:u3', {}], ['2026-09-19:u4', {}]
    ]);
    const dropped = pruneOldPeriods(m, 1, YEAR, 'test-missions');
    assert.equal(dropped, 3, 'both 09-01 rows and the 09-02 row');
    assert.deepEqual([...m.keys()], ['2026-09-19:u3', '2026-09-19:u4'], 'only the newest period survives');
    // keep=2 must retain the two newest periods, not just today's
    const m2 = new Map([['2026-09-01:u1', {}], ['2026-09-18:u2', {}], ['2026-09-19:u3', {}]]);
    assert.equal(pruneOldPeriods(m2, 2, YEAR, 'test-missions-2'), 1);
    assert.deepEqual([...m2.keys()], ['2026-09-18:u2', '2026-09-19:u3']);
  });

  test('pruneOldPeriods also handles bare period keys and week keys', () => {
    const days = new Map([['2026-09-01', new Map()], ['2026-09-02', new Map()], ['2026-09-19', new Map()]]);
    assert.equal(pruneOldPeriods(days, 1, YEAR, 'test-daily'), 2);
    assert.deepEqual([...days.keys()], ['2026-09-19']);

    const weeks = new Map([['2025-W52', new Map()], ['2026-W01', new Map()], ['2026-W38', new Map()]]);
    assert.equal(pruneOldPeriods(weeks, 2, YEAR, 'test-weekly'), 1);
    assert.deepEqual([...weeks.keys()], ['2026-W01', '2026-W38'], 'week keys sort chronologically across years');
  });

  test('a lone stale period is pruned on age, and a fresh one is kept', () => {
    const today = new Date().toISOString().slice(0, 10);
    const m = new Map([['2020-01-01:u1', {}], [today + ':u2', {}]]);
    assert.equal(pruneOldPeriods(m, 10, 3 * 86400000, 'test-age'), 1, 'keep=10 would not have caught it');
    assert.deepEqual([...m.keys()], [today + ':u2']);
    assert.equal(periodAgeMs('2020-01-01') > 3 * 86400000, true);
    assert.equal(periodAgeMs(today) < 86400000, true);
    assert.equal(periodAgeMs('2026-W01') < periodAgeMs('2025-W01'), true, 'week keys age in the right order');
    assert.equal(periodAgeMs('garbage'), Infinity, 'an unparseable period is treated as ancient');
  });

  test('capAnUsers drops the visitors who have been gone longest', () => {
    const saved = AN.users;
    AN.users = {
      old: { lIdx: 1 }, mid: { lIdx: 5 }, fresh: { lIdx: 9 }, broken: {}
    };
    try {
      assert.equal(capAnUsers(2), 2);
      assert.deepEqual(Object.keys(AN.users).sort(), ['fresh', 'mid']);
    } finally { AN.users = saved; }
  });

  test('sweepMemory clears finished periods and stale revenge targets, keeps live data', () => {
    const today = new Date().toISOString().slice(0, 10);
    const mKey = (d, u) => `${d}:${u}`;
    const seeded = {
      missions: [mKey('2020-01-01', 'audit-old'), mKey(today, 'audit-new')],
      bounties: [`${'2020'}-W01:audit-old`],
      revenge: ['audit-revenge-stale', 'audit-revenge-fresh', 'audit-revenge-junk']
    };
    memPlayerMissions.set(seeded.missions[0], new Map([[1, { progress: 1 }]]));
    memPlayerMissions.set(seeded.missions[1], new Map([[1, { progress: 2 }]]));
    memWeeklyBounties.set(seeded.bounties[0], new Map([[1, { progress: 1 }]]));
    memDailyComp.set('2020-01-01', new Map());
    memDailyComp.set(today, new Map());
    memWeeklyComp.set('2020-W01', new Map());
    memRevengeTargets.set(seeded.revenge[0], [{ targetUid: 'x', issuedAt: new Date(Date.now() - 30 * 86400000).toISOString() }]);
    memRevengeTargets.set(seeded.revenge[1], [{ targetUid: 'y', issuedAt: new Date().toISOString() }]);
    memRevengeTargets.set(seeded.revenge[2], 'not-an-array');

    try {
      sweepMemory();
      assert.equal(memPlayerMissions.has(seeded.missions[0]), false, 'a 2020 mission row is dead weight');
      assert.equal(memPlayerMissions.has(seeded.missions[1]), true, 'today’s missions must survive');
      assert.equal(memWeeklyBounties.has(seeded.bounties[0]), false);
      assert.equal(memDailyComp.has('2020-01-01'), false);
      assert.equal(memDailyComp.has(today), true);
      assert.equal(memWeeklyComp.has('2020-W01'), false);
      assert.equal(memRevengeTargets.has(seeded.revenge[0]), false, 'revenge older than 7 days expires');
      assert.equal(memRevengeTargets.has(seeded.revenge[1]), true, 'a live revenge target survives');
      assert.equal(memRevengeTargets.has(seeded.revenge[2]), false, 'a corrupt entry is dropped, not crashed on');
    } finally {
      seeded.missions.forEach((k) => memPlayerMissions.delete(k));
      seeded.bounties.forEach((k) => memWeeklyBounties.delete(k));
      seeded.revenge.forEach((k) => memRevengeTargets.delete(k));
      memDailyComp.delete('2020-01-01');
      memWeeklyComp.delete('2020-W01');
    }
  });

  test('sweepMemory is safe to call on an empty process', () => {
    assert.doesNotThrow(() => sweepMemory());
    assert.ok(MEM_CAP >= 1000, 'the cap must be a real number even if MEM_CAP is nonsense');
  });
});

describe('v115 — the garage & coin economy are fully retired', () => {
  test('no buy/equip handler or wallet RPC remains in the server', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(!/case 'buy'/.test(src), 'buy handler gone');
    assert.ok(!/case 'equip'/.test(src), 'equip handler gone');
    assert.ok(!/earn_coins|spend_coins/.test(src), 'wallet RPCs gone');
  });
  test('the client ships no garage UI, catalog or coin rows', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const gj = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8');
    assert.ok(!/garage-dlg|garage-btn/.test(html), 'garage markup gone');
    assert.ok(!/openGarage|SRCos|loadEquipped/.test(gj), 'garage code gone');
    assert.ok(!/COINS/.test(gj), 'no coin UI strings in the client');
    assert.ok(/let iAmReady = false;/.test(gj), 'v116: lobby ready-state declaration intact');
    assert.ok(/function renderRoomLobby/.test(gj) && /function openFriends/.test(gj), 'lobby functions intact');
  });
});

describe('AUDIT-F5 — baseline security headers and an honest health check', () => {
  test('every response carries the zero-risk headers', async () => {
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.match(res.headers.get('permissions-policy') || '', /camera=\(\)/);
      assert.equal(res.headers.get('content-security-policy'), null, 'CSP stays opt-in via env');
      assert.equal(res.headers.get('x-frame-options'), null, 'frame-busting stays opt-in via env');
    } finally { server.close(); }
  });

  test('the headers apply to the app shell too, not just the API', async () => {
    const { server, base } = listen();
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(4000) });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    } finally { server.close(); }
  });

  test('the boot log states plainly what a restart will destroy', () => {
    const lines = durabilityReport();
    assert.ok(Array.isArray(lines) && lines.length >= 3);
    const text = lines.join('\n');
    assert.match(text, /MEM_CAP|Memory: cap \d+/);
    if (SB_OFF) {
      assert.match(text, /SUPABASE_URL/, 'names the missing env vars');
      assert.match(text, /RAM-ONLY/, 'says progress is RAM-only');
      assert.match(text, /LOST on every restart/i, 'says what happens');
      assert.ok(lines.some((l) => l.startsWith('!!')), 'and it is loud (warn-level lines)');
    } else {
      assert.match(text, /Supabase connected/, 'confirms the database is in use');
      assert.match(text, /clubs/, 'v95: clubs are persisted now, and the report says so');
      assert.match(text, /missions/, 'as are missions');
      assert.match(text, /supabase-migration-v98\.sql/, 'and it points at the migration the schema needs');
    }
  });

  test('/health reports memory gauges and whether progress is durable', async () => {
    const { server, base } = listen();
    try {
      const j = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })).json();
      assert.equal(j.ok, true);
      assert.equal(typeof j.rooms, 'number');
      assert.ok(j.mem, 'the memory gauge block is present');
      assert.equal(typeof j.mem.heapMB, 'number');
      assert.equal(typeof j.mem.rssMB, 'number');
      assert.equal(j.mem.cap, MEM_CAP);
      assert.equal(typeof j.mem.players, 'number');
      assert.equal(typeof j.mem.anUsers, 'number');
      if (SB_OFF) assert.equal(j.mem.persisted, false, 'without Supabase, /health must say progress is RAM-only');
    } finally { server.close(); }
  });
});

describe('AUDIT-F6 — the client and the server cannot drift apart', () => {
  // The authoritative simulation is shared by copying the same file into both
  // trees. If they ever diverge, the client predicts one physics and the server
  // simulates another - rubber-banding, desync and "impossible" leaderboard
  // times. They were byte-identical at audit time; this keeps them that way.
  const pairs = ['game-core.js', 'progression.js', 'cosmetics.js'];

  for (const f of pairs) {
    test(`${f} is byte-identical in shared/ and public/js/`, () => {
      const a = fs.readFileSync(path.join(__dirname, '..', 'shared', f));
      const b = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f));
      assert.equal(a.equals(b), true,
        `${f} differs between shared/ and public/js/ - copy one over the other before shipping`);
    });
  }

  test('every versioned asset in the HTML matches the service worker precache', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
    const sw = fs.readFileSync(path.join(__dirname, '..', 'public/sw.js'), 'utf8');
    const htmlVers = [...new Set([...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]))];
    const swVers = [...new Set([...sw.matchAll(/\?v=(\d+)/g)].map((m) => m[1]))];
    assert.equal(htmlVers.length, 1, `index.html mixes asset versions: ${htmlVers.join(', ')}`);
    assert.deepEqual(swVers, htmlVers, 'the service worker precaches a different asset version than the page loads');
    assert.match(sw, new RegExp(`sridhar-rush-v${htmlVers[0]}`), 'the cache name must match the asset version');
  });

  test('server.js declares no duplicate top-level function names', () => {
    // Duplicate `function foo()` declarations are legal JS: the LAST one silently
    // wins. That is exactly how the v95 persistence layer nearly shipped calling
    // the leaderboard's sbUpsert(mapId, entry) instead of its own row writer -
    // every write would have gone nowhere and no test would have failed unless it
    // drove the real code. Duplicate const/let is a SyntaxError, so functions are
    // the only silent case.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const names = [...src.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
    const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    assert.deepEqual(dupes, [], `duplicate top-level functions shadow each other: ${dupes.join(', ')}`);
    assert.ok(names.length > 50, `only found ${names.length} functions - the scan pattern is broken`);
  });

  test('the client bundles declare no duplicate top-level function names either', () => {
    // Same silent-shadowing hazard as server.js, and a worse place for it: these
    // files run in a browser with no test harness around them, so a shadowed
    // function is only noticed as a feature that quietly does nothing.
    const files = ['public/js/game.js', 'public/js/controller.js', 'public/js/net.js',
                   'public/js/account.js', 'public/js/replay.js', 'public/js/i18n.js'];
    let scanned = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const names = [...src.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
      scanned += names.length;
      const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      assert.deepEqual(dupes, [], `${f} has duplicate top-level functions: ${dupes.join(', ')}`);
    }
    assert.ok(scanned > 100, `only found ${scanned} functions across ${files.length} files - the scan is broken`);
  });

  test('the client BUILD marker and the server /version agree', async () => {
    const game = fs.readFileSync(path.join(__dirname, '..', 'public/js/game.js'), 'utf8');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const clientBuild = (game.match(/const BUILD = '(v\d+)'/) || [])[1];
    const serverBuild = (srv.match(/build: '(v\d+)'/) || [])[1];
    assert.ok(clientBuild && serverBuild, 'both build markers must exist');
    assert.equal(clientBuild, serverBuild,
      `client BUILD ${clientBuild} != server ${serverBuild} - idle tabs would reload-loop on mismatch`);
  });
});
