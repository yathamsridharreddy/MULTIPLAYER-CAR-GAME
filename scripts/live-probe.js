'use strict';
// ---------------------------------------------------------------------------
// live-probe.js — hostile-traffic smoke test against a RUNNING server.
//
//   npm run probe                      # probes http://127.0.0.1:3000
//   PROBE_URL=https://my.host npm run probe
//
// Unlike `npm test` (which boots app.js in-process), this hits the real HTTP +
// WebSocket surface the way a browser — or an attacker — would: malformed and
// oversized frames, absurd inputs, floods, junk JSON, path traversal, and a
// full physics-integrity lap. Every check has an expected outcome, so the
// report is a pass/fail list rather than a dump. Exit code 1 on any failure,
// which makes it usable in CI or a pre-deploy gate.
// ---------------------------------------------------------------------------
const WebSocket = require('ws');

const BASE = String(process.env.PROBE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const TIMEOUT = 8000;

const results = [];
let roomsAtStart = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null && detail !== '' ? '  — ' + detail : ''}`);
}
const get = async (p, opts) => {
  const t0 = Date.now();
  const res = await fetch(BASE + p, Object.assign({ signal: AbortSignal.timeout(TIMEOUT) }, opts || {}));
  return { res, ms: Date.now() - t0 };
};
const post = (p, body, type) => get(p, {
  method: 'POST',
  headers: { 'Content-Type': type || 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal WS client that records everything it receives and never throws.
function connect(path) {
  const ws = new WebSocket(WS_BASE + (path || '/ws')); // the server mounts the socket on /ws
  const inbox = [];
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())); } catch (e) { inbox.push({ raw: d.toString().slice(0, 60) }); } });
  ws.errors = [];
  ws.on('error', (e) => ws.errors.push(String(e && e.message)));
  ws.inbox = inbox;
  ws.wait = async (pred, ms) => {
    const until = Date.now() + (ms || 3000);
    while (Date.now() < until) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  };
  return ws;
}
// Resolves true/false instead of hanging forever: a refused upgrade leaves the
// event loop with nothing to do, and Node would exit silently mid-report.
async function opened(ws, ms) {
  if (ws.readyState === 1) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms || 4000);
    ws.once('open', () => { clearTimeout(t); resolve(true); });
    ws.once('close', () => { clearTimeout(t); resolve(false); });
    ws.once('error', () => { /* the close/timeout path resolves */ });
  });
}

const send = (ws, o) => { try { ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) { /* closed is a valid outcome */ } };

function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILURES:');
    failed.forEach((f) => console.log(`  ✗ ${f.name} — ${f.detail}`));
  }
  process.exit(failed.length ? 1 : 0);
}

(async () => {
  console.log(`\nProbing ${BASE}\n`);

  // ---- 1. liveness & build -------------------------------------------------
  console.log('1. Liveness');
  try {
    const { res, ms } = await get('/health');
    const j = await res.json();
    check('GET /health answers fast', res.status === 200 && ms < 1000, `${res.status} in ${ms}ms`);
    check('/health exposes memory gauges', !!(j.mem && typeof j.mem.heapMB === 'number' && j.mem.cap > 0),
      `heap ${j.mem && j.mem.heapMB}MB, persisted=${j.mem && j.mem.persisted}`);
    roomsAtStart = j.rooms;
    const v = await (await get('/version')).res.json();
    check('GET /version reports a build', /^v\d+$/.test(v.build || ''), `build ${v.build}, tickHz ${v.tickHz}`);
  } catch (e) { check('server reachable', false, e.message); process.exit(1); }

  // ---- 2. security headers -------------------------------------------------
  console.log('\n2. Security headers');
  const h = (await get('/')).res.headers;
  check('X-Content-Type-Options: nosniff', h.get('x-content-type-options') === 'nosniff');
  check('Referrer-Policy set', !!h.get('referrer-policy'), h.get('referrer-policy'));
  check('Permissions-Policy set', /camera=\(\)/.test(h.get('permissions-policy') || ''));

  // ---- 3. hostile HTTP ----------------------------------------------------
  console.log('\n3. Hostile HTTP (every request must be ANSWERED, quickly)');
  const junk = [
    ['POST /a with JSON (regression: used to hang)', () => post('/a', { e: 'visit', pid: 'probe' })],
    ['POST /a with text/plain (the client path)', () => post('/a', { e: 'visit', pid: 'probe' }, 'text/plain')],
    ['POST /a with truncated JSON', () => post('/a', '{"e":', 'text/plain')],
    ['POST /a with an empty body', () => post('/a', '', 'text/plain')],
    ['POST /a with a prototype-pollution key', () => post('/a', { e: '__proto__', pid: 'x', ['__proto__']: { admin: 1 } })],
    ['POST /a with a nested-object pid', () => post('/a', { pid: { $gt: '' } })],
    ['POST /a with a 1 MB body', () => post('/a', { e: 'visit', pad: 'x'.repeat(1024 * 1024) })],
    ['POST /ghost with JSON (regression: used to hang)', () => post('/ghost', { map: 0, name: 'P', data: [[0, 1, 2, 3]] })],
    ['POST /ghost with an XSS name', () => post('/ghost', { map: 0, name: '<img src=x onerror=alert(1)>', data: [] }, 'text/plain')],
    ['POST /ghost with map 99', () => post('/ghost', { map: 99, data: [1, 2, 3] }, 'text/plain')],
    ['POST /ghost with a 500 KB body', () => post('/ghost', { map: 0, data: 'x'.repeat(500 * 1024) }, 'text/plain')],
    ['GET /ghost without an id', () => get('/ghost')],
    ['GET /ghost with a 44-char id', () => get('/ghost?id=' + 'z'.repeat(44))],
    ['GET /lb on an out-of-range map', () => get('/lb?map=99')],
    ['GET a path-traversal asset', () => get('/../../etc/passwd')],
    ['GET an unknown route', () => get('/definitely-not-a-route')],
    ['POST /api/player/crew/create with a script name', () => post('/api/player/crew/create', { uid: 'probe', name: '<script>alert(1)</script>' })],
    ['POST /api/player/crew/create with a 2000-char name', () => post('/api/player/crew/create', { uid: 'probe', name: 'A'.repeat(2000) })],
    ['POST /api/player/missions/claim with no fields', () => post('/api/player/missions/claim', {})],
    ['POST /api/player/badge/equip with a bogus badge', () => post('/api/player/badge/equip', { uid: 'probe', badge: 'nope' })]
  ];
  for (const [name, fn] of junk) {
    try {
      const { res, ms } = await fn();
      const answered = ms < 2000;
      const sane = res.status < 500 || res.status === 503; // 503 = "no database configured" is a correct answer
      check(name, answered && sane, `${res.status} in ${ms}ms`);
    } catch (e) {
      check(name, false, /abort|timeout/i.test(e.message) ? 'TIMED OUT — the hang is back' : e.message);
    }
  }

  // ---- 4. WebSocket battery ----------------------------------------------
  console.log('\n4. WebSocket battery');
  const ws = connect();
  const up = await opened(ws);
  check('socket opens on /ws', up, up ? 'open' : `refused (${ws.errors.join('; ') || 'no error event'})`);
  if (!up) { report(); return; }

  for (const frame of ['not json at all', '{"type":', '[]', 'null', '{"type":"__proto__"}', Buffer.from([0xff, 0xfe, 0x00])]) {
    send(ws, frame);
  }
  await sleep(400);
  check('survives malformed frames', ws.readyState === 1, `${ws.errors.length} socket errors`);

  send(ws, 'x'.repeat(200 * 1024)); // over maxPayload (64 KB)
  const closed = await new Promise((r) => { const t = setTimeout(() => r('still open'), 1200); ws.once('close', (c) => { clearTimeout(t); r(c); }); });
  check('rejects an oversized frame with 1009', closed === 1009, `close code ${closed}`);

  const ws2 = connect();
  if (!(await opened(ws2))) { check('second socket opens', false, 'refused'); report(); return; }
  send(ws2, { type: 'hello' });
  const welcome = await ws2.wait((m) => m.type === 'lobby_welcome' || m.type === 'welcome');
  check('lobby hello is answered', !!welcome, welcome ? welcome.type : 'no reply');

  send(ws2, { type: 'create_room', mode: 'race', map: 2, laps: 3, name: 'PROBE', cls: 1 });
  const created = await ws2.wait((m) => m.type === 'welcome' && m.slot != null);
  check('create_room seats the player', !!created, created ? `slot ${created.slot}, code ${created.code}` : 'no welcome');

  // absurd inputs must be clamped by the authoritative sim, never trusted.
  // The race has to actually be RUNNING first, otherwise the speed/steer checks
  // below pass vacuously on a stationary car (a green tick that proves nothing).
  send(ws2, { type: 'ready', on: true });
  send(ws2, { type: 'start', mode: 'race', map: 2, laps: 3 });
  const started = await ws2.wait((m) => m.type === 'state' && (m.state === 'countdown' || m.state === 'racing'), 8000);
  check('the host can start the race', !!started, started ? 'state=' + started.state : 'never left waiting');
  const rolling = await ws2.wait((m) => m.type === 'state' && m.state === 'racing', 10000);
  check('the countdown completes and the sim runs', !!rolling, rolling ? 'racing' : 'stuck in countdown');
  ws2.inbox.length = 0; // judge only the snapshots produced while actually racing
  for (let i = 0; i < 40; i++) {
    send(ws2, { type: 'input', steer: 1e9, throttle: 1e9, brake: -1e9, handbrake: true, nitro: true });
    await sleep(50);
  }
  // wire format: type 'state', cars[] of { s:slot, x, z, h, v, st, th, lap, ... }
  const snaps = ws2.inbox.filter((m) => m.type === 'state');
  const slot = created && created.slot;
  const mine = snaps.map((s) => (s.cars || []).find((c) => c.s === slot)).filter(Boolean);
  const nums = (arr) => arr.filter((n) => Number.isFinite(n));
  const speeds = nums(mine.map((c) => Number(c.v)));
  const steers = nums(mine.map((c) => Number(c.st)));
  const throttles = nums(mine.map((c) => Number(c.th)));
  check('snapshots keep flowing', snaps.length > 20, `${snaps.length} snapshots, ${mine.length} with my car`);
  const moved = speeds.length > 0 && Math.max(...speeds) > 0.5;
  check('the car actually moved while being fed absurd input (else the clamps prove nothing)', moved,
    `peak ${speeds.length ? Math.max(...speeds).toFixed(2) : '?'} m/s over ${speeds.length} samples`);
  check('absurd throttle cannot produce a runaway speed', moved && Math.max(...speeds) < 90,
    `peak ${speeds.length ? Math.max(...speeds).toFixed(2) : '?'} m/s (hard cap ~78.6)`);
  check('absurd steering is clamped to [-1, 1]', steers.length > 0 && Math.min(...steers) >= -1 && Math.max(...steers) <= 1,
    `range [${steers.length ? Math.min(...steers).toFixed(2) : '?'}, ${steers.length ? Math.max(...steers).toFixed(2) : '?'}]`);
  check('absurd throttle is clamped to [0, 1]', throttles.every((t) => t >= -1 && t <= 1),
    `peak ${throttles.length ? Math.max(...throttles) : '?'}`);
  const wire = JSON.stringify(snaps);
  check('no NaN/Infinity ever reaches the wire', !/NaN|Infinity/.test(wire));
  check('the room runs the map the host asked for', snaps.length > 0 && snaps.every((s) => s.map === 2),
    `map ${snaps.length ? snaps[snaps.length - 1].map : '?'}`);
  check('the room runs the lap count the host asked for', snaps.length > 0 && snaps.every((s) => s.laps === 3),
    `laps ${snaps.length ? snaps[snaps.length - 1].laps : '?'} (setLaps only accepts 1/3/5)`);

  const before = ws2.inbox.length;
  for (let i = 0; i < 600; i++) send(ws2, { type: 'input', steer: 0, throttle: 1 });
  await sleep(1200);
  check('survives a 600-message flood', ws2.readyState === 1, `${ws2.inbox.length - before} replies after the flood`);

  send(ws2, { type: 'join_room', code: 'ZZZZZZ' });
  const joinErr = await ws2.wait((m) => /join|error|failed/.test(String(m.type)) && m.type !== 'welcome');
  check('joining a bogus room is refused cleanly', !!joinErr, joinErr ? joinErr.type + (joinErr.msg ? ': ' + joinErr.msg : '') : 'no reply');

  ws2.close(); ws.close();
  await sleep(200);

  // ---- 5. after the abuse ------------------------------------------------
  console.log('\n5. After the abuse');
  const { res } = await get('/health');
  const j = await res.json();
  check('server still healthy', res.status === 200 && j.ok === true, `rooms ${j.rooms}, heap ${j.mem.heapMB}MB`);
  check('the probe leaked no rooms', j.rooms <= roomsAtStart + 1,
    `${roomsAtStart} before, ${j.rooms} after (this probe creates 1; idle rooms are GC'd after 60s)`);

  report();
})().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
