// OFFLINE MODE (v165) — racing with no internet at all.
//
// THE CONTRACT THIS PINS.
//   1. A race can be simulated entirely in the browser: the same CORE.RaceRoom the
//      server runs, driven by the same 30 Hz steps, producing the same messages.
//   2. The client's own transport switch picks that local link when the racer chose
//      OFFLINE or the browser has no connection - and never opens a socket for it.
//   3. Offline races submit nothing and claim no rewards: the settle row says so.
//   4. An offline browser is not bounced to the sign-in page (which needs the
//      network it does not have).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const OFFLINE_SRC = read('public/js/offline.js');
const GAME = read('public/js/game.js');
const PAGE = read('public/index.html');
const SW = read('public/sw.js');

// ---- a browser-ish sandbox with a real core, and no network at all -----------
function makeSandbox(opts) {
  const o = opts || {};
  const CORE = require(path.join(ROOT, 'shared/game-core.js'));
  const messages = [];
  const store = {};
  const toasts = [];
  const sandbox = {
    CORE,
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    navigator: { onLine: o.onLine === undefined ? false : o.onLine },
    performance: { now: () => Date.now() },
    toast: (t) => toasts.push(String(t)),
    // The loop is driven by the test, never by a timer: rAF is captured and the
    // test calls _tick() itself. No interval, so the runner can exit.
    requestAnimationFrame: (fn) => { sandbox.__raf = fn; return 1; },
    cancelAnimationFrame: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    SROffline: undefined,
    SROfflineLink: undefined
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(OFFLINE_SRC, sandbox);
  const link = new sandbox.SROfflineLink({ onMessage: (m) => messages.push(m) });
  return { sandbox, link, messages, toasts, store };
}

const HELLO = {
  type: 'hello', role: 'screen', room: null,
  name: 'SRIDHAR', pid: 'pdev1', color: 0xe10600, cls: 'grip', laps: 2, bot: false, botSkill: 1, sens: 1
};

test('an offline race runs: countdown, throttle, laps, finish - all in the page', () => {
  const { link, messages } = makeSandbox();
  assert.equal(link.connect(HELLO), true, 'the local link connects without any network');

  const types = messages.map((m) => m.type);
  assert.ok(types.includes('welcome'), 'the client is seated: ' + types.join(','));
  assert.ok(types.includes('lobby'), 'and gets a lobby: ' + types.join(','));
  const welcome = messages.find((m) => m.type === 'welcome');
  assert.equal(welcome.slot, 1, 'the racer holds slot 1');
  assert.ok(welcome.snapshot && welcome.snapshot.state === 'waiting', 'on a waiting grid');

  // the racer presses START (what the wizard sends)
  link.send(Object.assign({}, HELLO, { type: 'start', map: 0 }));
  assert.equal(link.room.state, 'countdown', 'the race starts with the same countdown the server runs');
  assert.ok(messages.some((m) => m.type === 'lobby' && m.state === 'countdown'), 'and the lobby is told');
  link._tick(1 / 30);
  const firstState = messages.filter((m) => m.type === 'state').pop();
  assert.equal(firstState.state, 'countdown', 'the first snapshot says the same thing');

  // race: the input is steered along the track (the same helper the AI uses) and
  // travels through the same 'input' message the client sends every frame
  let ticks = 0, sawRacing = false, travelled = 0, laps = 0, finished = false;
  const car = link.room.cars[0];
  let px = car.x, pz = car.z;
  for (let i = 0; i < 30 * 240 && !finished; i++) {
    link.send(Object.assign({ type: 'input' }, link.room.botInputFor(car)));
    link._tick(1 / 30);
    ticks++;
    // distance FROM THE GRID is the wrong measure - a car that laps comes back to it.
    // Count the road it actually covered.
    travelled += Math.hypot(car.x - px, car.z - pz);
    px = car.x; pz = car.z;
    const last = messages[messages.length - 1];
    if (last && last.type === 'state') {
      if (last.state === 'racing') sawRacing = true;
      const me = (last.cars || []).find((c) => c.s === 1);
      if (me) { laps = Math.max(laps, me.lap || 0); if (me.fin) finished = true; }
    }
  }
  assert.ok(sawRacing, 'the countdown handed over to racing');
  assert.ok(travelled > 300, 'the car actually drove the circuit: ' + travelled.toFixed(0) + ' m');
  assert.ok(laps >= 2, 'and the lap counter counted the laps it drove: ' + laps);
  assert.ok(finished || car.progress > 0.5, 'the race made real progress (finished=' + finished + ', progress=' + (car.progress || 0).toFixed(2) + ')');
  assert.ok(ticks > 0);
});

test('offline bots fill the grid, and the race still runs without a socket', () => {
  const { link, messages } = makeSandbox();
  link.connect(HELLO);
  link.send(Object.assign({}, HELLO, { type: 'start', map: 0, bot: true, laps: 1 }));
  assert.equal(link.room._botActive, true, 'the local room runs the same AI the server runs');
  const bots = link.room.cars.filter((c) => c._bot && c.participating);
  assert.ok(bots.length >= 1, 'bots take the empty seats: ' + bots.length);
  for (let i = 0; i < 30 * 20; i++) { link.send(Object.assign({ type: 'input' }, link.room.botInputFor(link.room.cars[0]))); link._tick(1 / 30); }
  const bot = bots[0];
  assert.ok(Math.hypot(bot.x - (link.room.track.a - 2.8), bot.z) > 5 || bot.progress > 0.01, 'and they drive');
  assert.ok(messages.some((m) => m.type === 'state' && m.state !== 'waiting'), 'with snapshots flowing');
});

test('an offline race submits nothing and claims no rewards', () => {
  const { link, messages, toasts } = makeSandbox();
  link.connect(Object.assign({}, HELLO, { laps: 1 }));
  link.send(Object.assign({}, HELLO, { type: 'start', map: 0, laps: 1 }));
  const car = link.room.cars[0];
  let finishedEvent = null;
  for (let i = 0; i < 30 * 600; i++) {
    link.send(Object.assign({ type: 'input' }, link.room.botInputFor(link.room.cars[0])));
    link._tick(1 / 30);
    if (link.room.state === 'finished') { finishedEvent = messages.filter((m) => m.type === 'settle').pop(); break; }
  }
  assert.ok(link.room.state === 'finished', 'the offline race can be finished');
  assert.ok(finishedEvent, 'and the client gets a settle message like it always does');
  const row = finishedEvent.rows[0];
  assert.equal(row.slot, 1);
  assert.equal(row.xp, 0, 'no XP is claimed');
  assert.equal(row.rd, 0, 'no rating is claimed');
  assert.equal(finishedEvent.local, true, 'and it is marked local');
  assert.ok(toasts.some((t) => /OFFLINE|OFF-LINE/i.test(t)), 'the racer is told where the time went: ' + JSON.stringify(toasts.slice(-2)));
});

test('the device keeps the offline best per map, and it is never sent anywhere', () => {
  const { link, sandbox, store } = makeSandbox();
  link.connect(Object.assign({}, HELLO, { laps: 1 }));
  link.send(Object.assign({}, HELLO, { type: 'start', map: 2, laps: 1 }));
  for (let i = 0; i < 30 * 600; i++) {
    link.send(Object.assign({ type: 'input' }, link.room.botInputFor(link.room.cars[0])));
    link._tick(1 / 30);
    if (link.room.state === 'finished') break;
  }
  const saved = JSON.parse(store['sr_offline_best'] || '{}');
  assert.ok(saved['2'] && saved['2'].time > 0, 'the best time is stored on this device: ' + JSON.stringify(saved));
  assert.equal(sandbox.SROffline.bestFor(2).time, saved['2'].time, 'and read back for the HUD');
  assert.equal(sandbox.SROffline.bestFor(0), null, 'a map that was never driven has no best');
});

test('the offline link answers the messages the client actually sends', () => {
  const { link, messages } = makeSandbox();
  link.connect(HELLO);
  for (const msg of [{ type: 'map', map: 1 }, { type: 'weather', weather: 'wet' }, { type: 'laps', laps: 5 }, { type: 'bot', bot: true },
    { type: 'meta', name: 'SRI', color: 0x00a651 }, { type: 'ready', on: true }, { type: 'record', record: false },
    { type: 'ping', t: 1 }, { type: 'horn' }]) {
    assert.equal(link.send(msg), true, msg.type + ' is accepted');
  }
  assert.equal(link.room.mapId, 1, 'the map choice landed on the local room');
  assert.equal(link.room.weather, 'wet');
  assert.equal(link.room.laps, 5);
  assert.equal(link.room.cars[0].name, 'SRI');
  const pong = messages.filter((m) => m.type === 'pong');
  assert.equal(pong.length, 1, 'the ping is answered locally');
  assert.ok(messages.some((m) => m.type === 'horn'), 'the horn still sounds');
  // online-only verbs say so instead of silently doing nothing
  assert.equal(link.send({ type: 'join_room', room: 'ABC12' }), true);
  assert.ok(messages.some((m) => m.type === 'error' && m.code === 'offline'), 'joining a room offline explains itself');
});

test('the client picks the local transport - and offline never dials a socket', () => {
  assert.match(GAME, /function offlineRequested\(\)/, 'there is one predicate for "race offline"');
  assert.match(GAME, /prefs\.mode3 === 'offline'/, 'the OFFLINE mode selects it');
  assert.match(GAME, /navigator\.onLine === false/, 'so does having no connection');
  assert.match(GAME, /const netLocal = \(typeof SROfflineLink === 'function'\) \? new SROfflineLink\(netHandlers\) : null;/,
    'the local link is built from the same handlers');
  assert.match(GAME, /if \(offlineRequested\(\) && netLocal\) \{ dropOnlineLink\(\); return netLocal; \}/,
    'and chosen first - and picking it drops a relay link the page had already opened');
  assert.match(GAME, /function dropOnlineLink\(\)/, 'there is one place that hangs up on the relay');
  assert.match(GAME, /if \(prefs\.mode3 === 'offline'\) dropOnlineLink\(\);/,
    'the OFFLINE button hangs up at the click, not at START');
  assert.match(GAME, /let netOnline = null;/, 'the online link is not even constructed until it is needed');
  assert.match(GAME, /t === netLocal && !t\.isOpen\(\)/, 'pressing START on a fresh offline link opens it instead of dropping the message');
  assert.match(PAGE, /data-m3="offline"/, 'the mode row carries the button');
  assert.match(PAGE, /js\/offline\.js\?v=\d+/, 'and the module is loaded');
  assert.match(SW, /'\/js\/offline\.js\?v=\d+'/, 'and precached, so a cold start with no network still has it');
});

test('an offline browser is not sent to the sign-in page it cannot load', () => {
  const gate = PAGE.slice(PAGE.indexOf('ACCOUNT GATE'), PAGE.indexOf('ACCOUNT GATE') + 1400);
  assert.match(gate, /navigator\.onLine === false/, 'the gate stands down when there is no network');
  assert.match(gate, /offline=1/, 'and when the racer asked for offline explicitly');
  // and the in-game hello path agrees
  assert.match(GAME, /if \(!offlineRequested\(\) && window\.SRAccount && SRAccount\.available\(\) && !SRAccount\.loggedIn\(\)\)/,
    'the hello gate does not bounce an offline racer to auth.html');
});

test('offline racing changes nothing about how the game is drawn or driven', () => {
  // The point of the local-loopback design: no second physics, no second HUD.
  assert.match(OFFLINE_SRC, /new CORE\.RaceRoom\(/, 'the offline room IS the server room');
  assert.match(OFFLINE_SRC, /room\.update\(dt\)/, 'driven by the same update');
  assert.match(OFFLINE_SRC, /room\.snapshot\(\)/, 'and the client renders the same snapshot');
  const code = OFFLINE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|EventSource/.test(code),
    'the offline module never touches the network');
  const tick = OFFLINE_SRC.match(/const TICK_HZ = (\d+)/);
  assert.ok(tick, 'a fixed tick rate');
  assert.equal(Number(tick[1]), require(path.join(ROOT, 'shared/game-core.js')).CFG.tickHz,
    'and it is the same rate the server simulates at');
});
