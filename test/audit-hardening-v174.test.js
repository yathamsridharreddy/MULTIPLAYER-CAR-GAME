'use strict';
/* ============================================================================
   v174 production audit — regression tests for the hardening fixes.

   Every case here reproduces a defect that was found and fixed during the full
   repository audit, and every one of them was reachable from a socket frame:

     AUDIT-174-1  `hello {map:'__proto__'}` built a room whose track was
                  Object.prototype. The 30 Hz tick loop then threw inside
                  lbGet() on EVERY frame, and because that throw escaped the
                  `for (const [code, entry] of rooms)` loop it silently froze
                  every other race on the server (one frame = server-wide
                  denial of service; the process only survived thanks to the
                  uncaughtException logger).
     AUDIT-174-2  `input {steer:'abc'}` (or {} / {} arrays / NaN) survived
                  clamp() as NaN and poisoned the car's whole state vector; the
                  snapshot then shipped nulls for x/z/heading/speed.
     AUDIT-174-3  `hello {cls:'__proto__'}` resolved CLASS_TELE['__proto__'] to
                  Object.prototype and `c.pick++` wrote NaN onto it — global
                  prototype pollution from one frame. The same truthiness test
                  in Car.setClass() handed a car a class with no physics numbers.
     AUDIT-174-4  `weather:'__proto__'` was accepted as a real condition.
     AUDIT-174-5  Racer names travelled from the name input into the sim
                  verbatim, and one client sink fed them to innerHTML.
     AUDIT-174-6  A leaderboard store keyed by a caller-supplied id could be
                  indexed with a prototype key (`leaderboard['__proto__']`).
   ========================================================================== */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../shared/game-core.js');
const { rooms, server, handleMessage, newRoom, lbGet, lbAdd, validMapId, classPick } = require('../server.js');

function mockWS() {
  return {
    readyState: 1,
    sent: [],
    send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); },
    close() { this.readyState = 3; }
  };
}

function screen(client, msg) {
  const ws = client.ws || mockWS();
  const c = { ws, entry: null, slot: 0, role: null, ...(client || {}) };
  handleMessage(c, msg);
  return c;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('AUDIT-174-1 — a wire map id can never become a prototype key', () => {
  beforeEach(() => { rooms.clear(); });

  for (const bad of ['__proto__', 'constructor', 'toString', 'valueOf', '99', '-1', 'NaN']) {
    test(`hello map ${JSON.stringify(bad)} falls back to circuit 0`, () => {
      const c = screen({}, { type: 'hello', role: 'screen', map: bad });
      assert.ok(c.entry, 'the racer still gets a room (never an error page)');
      assert.equal(c.entry.room.mapId, 0);
      assert.equal(c.entry.room.track, core.MAPS[0]);
      assert.ok(c.entry.room.state === 'waiting');
    });
  }

  test('a real map id still selects that circuit', () => {
    const c = screen({}, { type: 'hello', role: 'screen', map: 3 });
    assert.equal(c.entry.room.mapId, 3);
    assert.equal(c.entry.room.track, core.MAPS[3]);
  });

  test('the polluted room simulates instead of throwing', () => {
    const c = screen({}, { type: 'hello', role: 'screen', map: '__proto__' });
    const room = c.entry.room;
    room.setController(1, true);
    room.start();
    for (let i = 0; i < 120; i++) assert.doesNotThrow(() => room.update(1 / 30));
    const car = room.cars[0];
    assert.ok(Number.isFinite(car.x) && Number.isFinite(car.z), 'cars are on real numbers');
    assert.equal(room.snapshot().map, 0);
  });

  test('validMapId rejects prototype keys and accepts real ids', () => {
    assert.equal(validMapId('__proto__'), null);
    assert.equal(validMapId('constructor'), null);
    assert.equal(validMapId('2'), 2);
    assert.equal(validMapId(0), 0);
  });
});

describe('AUDIT-174-1/6 — the leaderboard store only ever holds real boards', () => {
  test('lbGet on a prototype key returns an empty board, not Object.prototype', () => {
    assert.deepEqual(lbGet('__proto__'), []);
    assert.deepEqual(lbGet('constructor'), []);
    assert.deepEqual(lbGet(NaN), []);
    assert.ok(Array.isArray(lbGet(0)));
  });

  test('lbAdd with a prototype key writes to circuit 0 and never to the prototype', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).length;
    lbAdd('__proto__', { name: 'AUDIT', pid: 'audit-174', t: 61.5, ts: Date.now() });
    assert.equal(Object.getOwnPropertyNames(Object.prototype).length, before, 'Object.prototype untouched');
    assert.ok(lbGet(0).some((r) => r.pid === 'audit-174'), 'the row landed on a real circuit');
  });

  test('a corrupt board entry cannot make lbGet throw', () => {
    assert.doesNotThrow(() => lbGet('hasOwnProperty'));
  });
});

describe('AUDIT-174-3 — class telemetry cannot be tricked into prototype pollution', () => {
  test('classPick ignores prototype keys', () => {
    classPick('__proto__');
    classPick('constructor');
    assert.equal('pick' in {}, false, 'no pick counter leaked onto Object.prototype');
  });

  test('Car.setClass only accepts real classes', () => {
    const room = new core.RaceRoom('CLS001', 'race', 0, 2);
    const car = room.cars[0];
    const def = car.cls;
    car.setClass('__proto__');
    car.setClass('constructor');
    car.setClass({});
    assert.equal(car.cls, def, 'a car keeps its real class');
    car.setClass('grip');
    assert.equal(car.cls.name, 'GRIP', 'a real class is still applied');
  });
});

describe('AUDIT-174-4 — weather must be a real condition', () => {
  test('prototype keys are refused, real ones accepted', () => {
    const room = new core.RaceRoom('WTH174', 'race', 0, 2);
    assert.equal(room.setWeather('__proto__'), false);
    assert.equal(room.setWeather('constructor'), false);
    assert.equal(room.weather, 'dry');
    assert.equal(room.setWeather('wet'), true);
    assert.equal(room.weather, 'wet');
  });

  test('a bad weather can never turn the grip modifier into NaN', () => {
    const room = new core.RaceRoom('WTH175', 'race', 0, 2);
    room.weather = '__proto__';              // forced past the setter on purpose
    room.setController(1, true);
    room.start();
    room.setInput(1, { steer: 0, throttle: 1 });
    for (let i = 0; i < 120; i++) room.update(1 / 30);
    const car = room.cars[0];
    assert.ok(Number.isFinite(car.x) && Number.isFinite(car.slip) && Number.isFinite(car.vx));
  });
});

describe('AUDIT-174-2 — a socket can only ever send numbers as input', () => {
  const hostile = [
    { steer: 'abc', throttle: {}, brake: [] },
    { steer: NaN, throttle: Infinity, brake: -Infinity },
    { steer: null, throttle: undefined, brake: '0.5' },
    { steer: [1, 2], throttle: true, brake: () => 1 }
  ];

  for (const [i, frame] of hostile.entries()) {
    test(`hostile input frame #${i + 1} keeps the car on real numbers`, () => {
      const room = new core.RaceRoom('INP' + i, 'race', 0, 2);
      room.setController(1, true);
      room.start();
      for (let t = 0; t < 200; t++) room.update(1 / 30);   // out of the countdown
      room.setInput(1, { ...frame, handbrake: true, nitro: true });
      const stored = room.inputs[1];
      assert.ok(Number.isFinite(stored.steer) && Number.isFinite(stored.throttle) && Number.isFinite(stored.brake),
        'every stored input term is a finite number');
      for (let t = 0; t < 90; t++) assert.doesNotThrow(() => room.update(1 / 30));
      const car = room.cars[0];
      assert.ok(Number.isFinite(car.x) && Number.isFinite(car.z) && Number.isFinite(car.heading));
      const snap = room.snapshot();
      assert.ok(Number.isFinite(snap.cars[0].x) && Number.isFinite(snap.cars[0].z), 'the wire carries numbers, not null');
    });
  }

  test('valid input is still applied verbatim', () => {
    const room = new core.RaceRoom('INPOK', 'race', 0, 2);
    room.setInput(1, { steer: 0.5, throttle: 0.75, brake: 0.25, handbrake: true, nitro: true });
    const s = room.inputs[1];
    assert.equal(s.steer, 0.5);
    assert.equal(s.throttle, 0.75);
    assert.equal(s.brake, 0.25);
    assert.equal(s.handbrake, true);
    assert.equal(s.nitro, true);
  });

  test('the per-car backstop puts a NaN car back on the grid (ellipse physics)', () => {
    const room = new core.RaceRoom('NAN174', 'race', 0, 2);
    room.setController(1, true);
    room.start();
    for (let t = 0; t < 100; t++) room.update(1 / 30);
    const car = room.cars[0];
    car.x = NaN; car.z = NaN; car.heading = NaN;   // whatever produced it, it must not stick
    room.update(1 / 30);
    assert.ok(Number.isFinite(car.x) && Number.isFinite(car.z) && Number.isFinite(car.heading),
      'NaN never survives a tick');
  });

  // maps 1-4 are spline circuits and run a SECOND physics implementation, reached
  // through a patched Car.update. The ellipse backstop did not cover them.
  for (const mapId of [1, 2, 3, 4]) {
    test(`the per-car backstop also covers spline circuit ${mapId}`, () => {
      const room = new core.RaceRoom('NANSP' + mapId, 'race', mapId, 2);
      room.setController(1, true);
      room.start();
      for (let t = 0; t < 100; t++) room.update(1 / 30);
      const car = room.cars[0];
      car.vx = NaN; car.vy = Infinity;
      room.update(1 / 30);
      assert.ok(Number.isFinite(car.vx) && Number.isFinite(car.vy) && Number.isFinite(car.x) && Number.isFinite(car.z),
        'a spline car never stays non-finite either');
      // and a room that has STOPPED simulating (finished) still guards its cars
      room.state = 'finished';
      car.x = NaN;
      room.update(1 / 30);
      assert.ok(Number.isFinite(car.x), 'a finished room still publishes snapshots, so it still guards');
    });
  }

  test('physics fuzz: extreme input, teleports and injected NaN across every circuit', () => {
    // 12 maps x modes x 400 ticks of 30 Hz racing with hostile input, a teleport to
    // 1e7 units and an injected Infinity - no car may ever go non-finite and no tick
    // may throw. (The full audit run used 3600 ticks per seed.)
    for (let seed = 1; seed <= 12; seed++) {
      const room = new core.RaceRoom('FZ' + seed, ['race', 'elim', 'drift', 'coop'][seed % 4], seed % 5, 6);
      for (let sl = 1; sl <= 6; sl++) room.setController(sl, true);
      room.start();
      const rng = core.mulberry32(seed * 7919);
      for (let t = 0; t < 400; t++) {
        if (t % 40 === 0) {
          for (let sl = 1; sl <= 6; sl++) {
            room.setInput(sl, {
              steer: (rng() * 2 - 1) * (rng() < 0.05 ? 1e6 : 1),
              throttle: rng(), brake: rng() < 0.2 ? 1 : 0,
              handbrake: rng() < 0.1, nitro: rng() < 0.3
            });
          }
        }
        if (t === 100) { const c = room.cars[2]; c.x = 1e7; c.z = -1e7; }
        if (t === 200) { const c = room.cars[3]; c.vx = Infinity; c.vy = NaN; }
        assert.doesNotThrow(() => room.update(1 / 30), `seed ${seed} tick ${t}`);
        for (const c of room.cars) {
          assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.heading) &&
                    Number.isFinite(c.vx) && Number.isFinite(c.vy) && Number.isFinite(c.slip),
            `seed ${seed} tick ${t} slot ${c.slot} went non-finite`);
        }
      }
    }
  });
});

describe('AUDIT-174-5 — racer text is cleaned before it enters the sim', () => {
  test('tags and control codes are stripped, unicode is kept', () => {
    const room = new core.RaceRoom('TXT174', 'race', 0, 2);
    const car = room.cars[0];
    car.setMeta('<img src=x onerror=alert(1)>', 0x00ff00, 'pid');
    assert.equal(car.name.includes('<'), false);
    assert.equal(car.name.includes('>'), false);
    car.setMeta('RAJ\u0000ESH', 0x00ff00, 'pid');
    assert.equal(car.name, 'RAJESH', 'control codes are dropped');
    car.setMeta('SH\u00c9R\ud83c\udfc1', 0x00ff00, 'pid');
    assert.equal(car.name, 'SH\u00c9R\ud83c\udfc1', 'accents and emoji survive');
    car.setMeta('', 0x00ff00, 'pid');
    assert.equal(car.name, 'SH\u00c9R\ud83c\udfc1', 'an empty name never wipes the label');
  });

  test('cosmetic titles are cleaned the same way', () => {
    const room = new core.RaceRoom('TXT175', 'race', 0, 2);
    room.cars[0].setCos({ decal: 0 }, '<b>x</b>');
    assert.equal(room.cars[0].title.includes('<'), false);
  });

  test('the client never writes a rival name into innerHTML unescaped', () => {
    const src = fs.readFileSync(path.join(__dirname, '../public/js/game.js'), 'utf8');
    assert.ok(src.includes('escapeHtml(p.rival.name)'),
      'the welcome-back banner must escape the rival name it renders with innerHTML');
    // and the helper it relies on does escape the dangerous characters
    const start = src.indexOf('function escapeHtml(s) {');
    assert.notEqual(start, -1, 'escapeHtml must exist');
    const body = src.slice(start, src.indexOf('\n}', start) + 2);
    const fn = new Function('return (' + body.replace('function escapeHtml', 'function') + ')')();
    assert.equal(fn('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(fn('A&B"C\'D'), 'A&amp;B&quot;C&#39;D');
  });
});

describe('AUDIT-174-1 — one broken room cannot freeze the rest of the server', () => {
  beforeEach(() => { rooms.clear(); });

  test('a room whose update throws is skipped, every other race keeps ticking', async () => {
    const bad = newRoom('race', 0, 2);
    const good = newRoom('race', 0, 2);
    const badWS = mockWS(), goodWS = mockWS();
    bad.screens.add(badWS);
    good.screens.add(goodWS);
    good.room.setController(1, true);
    good.room.start();                                  // 30 Hz snapshots while racing
    bad.room.update = () => { throw new TypeError('simulated corrupt room'); };

    const realError = console.error;                     // keep the expected report out of the test log
    const reports = [];
    console.error = (...a) => reports.push(a.join(' '));
    try { await delay(400); } finally { console.error = realError; }   // ~12 ticks at 30 Hz

    const goodTicks = goodWS.sent.filter((m) => m && m.type === 'state').length;
    assert.ok(goodTicks > 4, `the healthy room must keep receiving snapshots (saw ${goodTicks})`);
    assert.ok(bad._tickErrAt, 'the failing room is reported, not silently swallowed');
    assert.equal(badWS.sent.length, 0, 'the broken room sends nothing rather than garbage');
    assert.ok(reports.some((r) => r.includes('tick error')), 'the operator is told which room failed');

    rooms.delete(bad.room.code);
    rooms.delete(good.room.code);
  });
});

describe('AUDIT-174-8 — only the room creator drives the room', () => {
  beforeEach(() => { rooms.clear(); });

  // host = the lowest occupied slot; the second racer is a visitor
  function twoRacers() {
    const entry = newRoom('race', 0, 6);
    const host = screen({}, { type: 'hello', role: 'screen', room: entry.room.code, pid: 'h', name: 'HOST' });
    const guest = screen({}, { type: 'hello', role: 'screen', room: entry.room.code, pid: 'g', name: 'GUEST' });
    return { entry, host, guest };
  }

  test('a visitor cannot reset the room out from under a live race', () => {
    const { entry, host, guest } = twoRacers();
    host.entry.room.start();
    const t0 = entry.room.raceTime;
    guest.entry.room.raceTime = 12.5;                 // pretend the race is underway
    handleMessage(guest, { type: 'reset' });
    assert.equal(entry.room.state, 'countdown', 'the race is still on');
    assert.equal(entry.room.raceTime, 12.5, 'nothing was rewound');
    const refusals = guest.ws.sent.filter((m) => m && m.type === 'error' && m.code === 'host-only');
    assert.equal(refusals.length, 1, 'the visitor is told why, not ignored');
    assert.equal(refusals[0].setting, 'reset');
    assert.equal(refusals[0].host, 'HOST');
    handleMessage(host, { type: 'reset' });
    assert.equal(entry.room.state, 'waiting', 'the host can still reset the room');
  });

  test('a visitor cannot restart the race, the host can', () => {
    const { entry, host, guest } = twoRacers();
    entry.room.setController(1, true);
    entry.room.start();
    handleMessage(guest, { type: 'restart' });
    assert.equal(entry.room.state, 'countdown', 'the visitor changed nothing');
    assert.equal(guest.ws.sent.filter((m) => m && m.code === 'host-only' && m.setting === 'restart').length, 1);
    entry.room.resetToWaiting();
    handleMessage(host, { type: 'restart' });
    assert.equal(entry.room.state, 'countdown', 'the host can restart');
  });

  test('a visitor cannot change the race mode, the host can', () => {
    const { entry, host, guest } = twoRacers();
    handleMessage(guest, { type: 'mode', mode: 'elim' });
    assert.equal(entry.room.mode, 'race', 'mode unchanged');
    assert.equal(guest.ws.sent.filter((m) => m && m.code === 'host-only' && m.setting === 'mode').length, 1);
    handleMessage(host, { type: 'mode', mode: 'drift' });
    assert.equal(entry.room.mode, 'drift', 'the host owns the mode');
  });
});

describe('AUDIT-174-9 — a socket cannot flood the relay', () => {
  test('over-budget frames are dropped and the connection stays usable', async () => {
    const WebSocket = require('ws');                    // the same library the server speaks
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    const c = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let pongs = 0;
    c.on('message', (raw) => { try { if (JSON.parse(raw.toString()).type === 'pong') pongs++; } catch (e) {} });
    await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });
    try {
      for (let i = 0; i < 900; i++) c.send(JSON.stringify({ type: 'ping', t: i }));
      await delay(600);
      assert.ok(pongs > 0, 'the flood is throttled, not thrown away wholesale');
      assert.ok(pongs < 900, `the relay must cap a single socket (saw ${pongs} of 900 answered)`);
      await delay(600);                                  // let the window roll over
      const before = pongs;
      c.send(JSON.stringify({ type: 'ping', t: 9999 }));
      await delay(300);
      assert.ok(pongs > before, 'the socket keeps working after the flood');
    } finally {
      c.close();
      await new Promise((res) => server.close(res));
    }
  });
});

describe('AUDIT-174-10 — a refused guest is routed to the supported path', () => {
  const game = fs.readFileSync(path.join(__dirname, '../public/js/game.js'), 'utf8');

  test('backToLobbyAction() leaves the room for a visitor and resets for the host', () => {
    assert.match(game, /function backToLobbyAction\(\) \{\s*\n\s*if \(seatedInRoom && !amHost\) \{ exitRoom\(\); return true; \}/,
      'a visitor must go through the supported leave path, not a reset the relay will refuse');
  });

  test('every results-screen "back to lobby" control uses it', () => {
    // menu / change circuit / exit / try again / restart / time-trial exits
    const uses = (game.match(/backToLobbyAction\(\)/g) || []).length;
    assert.ok(uses >= 8, `expected the guard on every lobby-returning control, found ${uses} uses`);
    for (const marker of ["$('menu-btn').addEventListener", 'trkBtn', "$('exit-btn')", 'rstBtn', 'ttAgain', 'ttExit', 'ttLb']) {
      const at = game.indexOf(marker);
      assert.notEqual(at, -1, marker + ' must exist');
      const handler = game.slice(at, at + 700);
      assert.ok(handler.includes('backToLobbyAction()'), marker + ' must respect the room creator');
    }
  });

  test('the race-mode buttons are locked for a visitor, like the other room settings', () => {
    assert.match(game, /\['\.mode-btn', locked\]/, 'mode is a room setting in v174');
  });
});

describe('AUDIT-174-11 — nothing the service worker precaches can 404', () => {
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  test('every CORE entry is backed by a real file or a route the server serves', () => {
    const core = sw.slice(sw.indexOf('const CORE = ['), sw.indexOf('];', sw.indexOf('const CORE = [')));
    const urls = [...core.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(urls.length > 40, `the precache list looks truncated (${urls.length} entries)`);
    const routeFiles = { '/': 'index.html', '/controller': 'controller.html', '/replay': 'replay.html' };
    for (const u of urls) {
      const clean = u.split('?')[0];
      if (routeFiles[clean]) {
        assert.ok(fs.existsSync(path.join(__dirname, '../public', routeFiles[clean])), clean + ' has no page');
        continue;
      }
      assert.ok(fs.existsSync(path.join(__dirname, '../public', clean)),
        `sw.js precaches ${u} but nothing serves it - addAll() would abort the whole precache`);
    }
  });

  test('/replay is served by the Node server, not only by the Vercel rewrite', () => {
    // the client shares `${origin}/replay?g=ID`, so every hosting target needs it
    assert.match(server, /app\.get\(\['\/replay'\]/, 'server.js must route /replay like vercel.json does');
    assert.match(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'), /"\/replay"/);
  });

  test('the service worker only stores a GOOD navigation response', () => {
    const nav = sw.slice(sw.indexOf("req.mode === 'navigate'"), sw.indexOf("req.mode === 'navigate'") + 700);
    assert.ok(/if \(res && res\.ok\)/.test(nav), 'a 500 must never be cached as the app shell');
  });

  test('robots.txt ships with the site', () => {
    const robots = fs.readFileSync(path.join(__dirname, '../public/robots.txt'), 'utf8');
    assert.match(robots, /User-agent: \*/);
    assert.match(robots, /Disallow: \/api\//);
  });
});
