'use strict';
/* ============================================================================
   v177 — LOCAL DUEL, client side: the split camera, the view's lifetime, and
   the setup state that stops the mode starting with one silent car.

   This runs the REAL client (index.html + the real script order, with the same
   renderer stub the boot-smoke suite uses) so the split path is exercised for
   real: two viewports, two half-cameras, real snapshots, the real rAF loop.

   The bug it pins, traced in the shipped build: the split renderer aimed the ONE
   shared camera with

       _aimPos.set(cx, 0, cz);      // the wire has x/z/heading, never a height
       camera.position.y = 2.7;     // an ABSOLUTE world height

   On HIGHLAND RUSH (terrain -8.46 m .. +3.90 m, 24 % of the racing line above
   2.7 m) the split view was therefore drawn from inside the ground for a quarter
   of every lap, and it skipped the chase-cam smoothing, the camera mode, the
   shake decay and the glLost guard entirely.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPTS = ['js/vendor/GLTFLoader.js', 'js/car-models.js', 'js/game-core.js', 'js/progression.js',
  'js/config.js', 'js/account.js', 'js/i18n.js', 'js/net.js', 'js/audio.js'];

// One definition of the renderer stub in the repo: reuse boot-smoke's, wrapped so
// this suite can count the draws and the shadow rebuilds each frame really gets.
const SMOKE = read('test/boot-smoke.test.js');
const MARK = 'const FAKE_RENDERER = `';
const FAKE_RENDERER = SMOKE.slice(SMOKE.indexOf(MARK) + MARK.length, SMOKE.indexOf('`;\n', SMOKE.indexOf(MARK)));
const WRAP = `
THREE.WebGLRenderer = function (o) {
  var r = new window.__FAKE_RENDERER(o);
  window.__rend = r;
  var orig = r.render;
  r.render = function (sc, cam) {
    // only the world view: the same renderer also draws boot/debug previews, and
    // those are not frames of the race (they used to inflate the draw counts)
    var main = false;
    try { main = (sc === scene && cam === camera); } catch (e) { main = false; }
    if (main) {
      // where each car is drawn at THIS instant: the halves are compared against
      // the car positions of their own frame, not against where the cars ended up
      var c1 = null, c2 = null;
      try {
        var v1 = carVisuals[1], v2 = carVisuals[2];
        c1 = v1 ? { x: v1.netInit ? v1.netX : v1.group.position.x, z: v1.netInit ? v1.netZ : v1.group.position.z } : null;
        c2 = v2 ? { x: v2.netInit ? v2.netX : v2.group.position.x, z: v2.netInit ? v2.netZ : v2.group.position.z } : null;
      } catch (e) {}
      window.__renderLog.push({
        tick: window.__frameTicks, shadowAuto: r.shadowMap.autoUpdate, c1: c1, c2: c2,
        x: cam.position.x, y: cam.position.y, z: cam.position.z, fov: cam.fov, aspect: cam.aspect
      });
    } else {
      window.__otherRenders = (window.__otherRenders || 0) + 1;
    }
    return orig.apply(r, arguments);
  };
  return r;
};
window.__renderLog = [];
window.__probe = {
  camera: function () { return camera; }, split: function () { return splitScreen; }, view: function () { return viewMode; },
  heldKeys: function () { return Array.from(keys); }, touch: function () { return touchInput; }
};
`;

function boot() {
  const dom = new JSDOM(read('public/index.html'), {
    url: 'https://sridhar-drift.vercel.app/', runScripts: 'dangerously', pretendToBeVisual: true
  });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
  const sockets = [];
  window.WebSocket = class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    _msg(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
    payloads(type) {
      return this.sent.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
        .filter((m) => m && m.type === type);
    }
  };
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
  const ap = () => new Proxy({ value: 0 }, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
  const an = (x) => new Proxy(Object.assign({ connect() { return this; }, disconnect() {}, start() {}, stop() {}, gain: ap(), frequency: ap(), Q: ap(), detune: ap(), threshold: ap(), ratio: ap(), knee: ap(), attack: ap(), release: ap(), delayTime: ap(), pan: ap(), curve: null, oversample: 'none', type: '', buffer: null, loop: false, playbackRate: ap(), positionX: ap(), positionY: ap(), positionZ: ap() }, x || {}), { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = an(); this.listener = an({}); }
    createGain() { return an(); } createOscillator() { return an(); } createBiquadFilter() { return an(); }
    createDynamicsCompressor() { return an(); } createWaveShaper() { return an(); } createPanner() { return an(); }
    createStereoPanner() { return an(); } createConvolver() { return an(); } createAnalyser() { return an({ fftSize: 1024, frequencyBinCount: 512 }); }
    createBufferSource() { return an(); }
    createBuffer(c, l) { return { getChannelData: () => new Float32Array(l), length: l, numberOfChannels: c, sampleRate: 48000, duration: l / 48000 }; }
    resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); } close() { return Promise.resolve(); } decodeAudioData() { return Promise.resolve({}); }
  };
  window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ build: 'v177' }), text: () => Promise.resolve('') });
  window.navigator.vibrate = () => true;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  if (!window.HTMLCanvasElement.prototype.getContext) window.HTMLCanvasElement.prototype.getContext = () => null;
  const rt = () => ({ addColorStop() {} });
  const ctx2d = () => new Proxy({
    canvas: null, fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0,
    shadowColor: '', filter: 'none', imageSmoothingEnabled: true,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }),
    measureText: () => ({ width: 10 }), createRadialGradient: rt, createLinearGradient: rt, createPattern: () => ({}),
    getTransform: () => ({}), isPointInPath: () => false
  }, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
  window.HTMLCanvasElement.prototype.getContext = function (kind) { return kind === '2d' ? ctx2d() : null; };
  window.__frameTicks = 0;
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => realRaf((t) => { window.__frameTicks++; return cb(t); });
  window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:stub');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
  window.localStorage.clear();
  const run = (rel) => { const el = window.document.createElement('script'); el.textContent = read('public/' + rel); window.document.head.appendChild(el); };
  const expose = (s) => { const el = window.document.createElement('script'); el.textContent = s; window.document.head.appendChild(el); };
  expose(FAKE_RENDERER);
  run('js/vendor/three.min.js');
  expose(WRAP);
  for (const s of SCRIPTS) run(s);
  run('js/game.js');
  const ws = sockets[0];
  ws._open();
  ws._msg({ type: 'welcome', role: 'lobby', slot: 0, code: null, mode: null, state: null });
  return { dom, window, ws, errors };
}

// ---- shared fixtures -------------------------------------------------------
const MAP0 = { a: 95, b: 62 };
function carOnTrack(slot, th, speed) {
  const x = MAP0.a * Math.cos(th), z = MAP0.b * Math.sin(th);
  const dx = -MAP0.a * Math.sin(th), dz = MAP0.b * Math.cos(th);
  const L = Math.hypot(dx, dz);
  return {
    s: slot, x: +x.toFixed(3), z: +z.toFixed(3), h: +Math.atan2(dx / L, dz / L).toFixed(4),
    v: speed, sl: 0, st: 0, th: 1, n: 0, m: 0, lap: 0, ll: null, best: null, fin: 0, ft: null,
    p: 1, pr: 0.4, drift: 0, elim: 0, col: slot === 1 ? 0xe10600 : 0x0d47c8, dc: 0, wh: 0, tr: 0,
    ne: 0, sp: 0, b: 1, nm: 'P' + slot
  };
}
function stateMsg(cars, f, controllers, mode) {
  return {
    type: 'state', code: 'H8WT6', mode: mode || 'race', map: 0, state: 'racing', raceTime: f / 30,
    count: null, controllers: controllers || { 1: true, 2: true }, laps: 3, bot: false, cars, events: []
  };
}
// A snapshot is only ingested once the client holds a seat: RoomLink's onWelcome
// sets `acceptingStates`, so every test has to take a seat first, exactly as the
// relay's join does. (Skipping this made the first draft of these tests measure a
// frozen camera and call it smooth.)
function seat(ws, slot, code, mode) {
  ws._msg({ type: 'welcome', role: 'screen', slot: slot || 1, code: code || 'H8WT6', mode: mode || 'race', state: 'waiting' });
}
// drive the real interpolation + placement + render stack for `n` relay frames
async function stream(ws, n, fn) {
  for (let f = 0; f < n; f++) { ws._msg(fn(f)); await sleep(28); }
}

const SKIP = JSDOM ? false : 'jsdom not installed (npm install --include=dev)';

test('v177: the LOCAL DUEL card asks for a two-seat, AI-free race and shows the setup state', { skip: SKIP }, async (t) => {
  const { dom, window, ws, errors } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  await sleep(60);
  const modes = ws.payloads('mode');
  assert.equal(modes.length, 1, 'one mode message');
  assert.equal(modes[0].mode, 'race', 'Local Duel keeps the plain-race simulation the relay already runs');
  assert.equal(window.__probe.split(), true, 'split view on');
  const setup = window.document.getElementById('duel-setup');
  const divider = window.document.getElementById('split-divider');
  assert.equal(setup.hidden, false, 'the setup state is visible');
  assert.notEqual(divider.style.display, 'none', 'the divider is shown');
  assert.match(window.document.getElementById('duel-setup-line').textContent, /P1 CAR 1/);
  assert.match(window.document.getElementById('duel-setup-line').textContent, /P2 CAR 2/);
  assert.deepEqual(errors, []);
});

test('v177: START builds a 2-seat room and never starts a silent one-car duel', { skip: SKIP }, async (t) => {
  const { dom, window, ws } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  window.document.getElementById('start-btn').click();
  await sleep(120);
  assert.equal(ws.payloads('start').length, 0, 'no start message: nobody to race yet');
  const creates = ws.payloads('create_room');
  assert.equal(creates.length, 1, 'the room is created (its QR is what the phones need)');
  assert.equal(creates[0].cap, 2, 'two seats');
  assert.equal(creates[0].bot, false, 'and no AI fill — the old build shipped bot:true and started with six cars');
  assert.match(window.document.getElementById('duel-setup-line').textContent, /waiting for the 2nd driver/i);
});

test('v177: with one driver the second press is required, and a new arrival asks again', { skip: SKIP }, async (t) => {
  const { dom, window, ws, errors } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  seat(ws, 1);
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 2, state: 'waiting', laps: 3, bot: false });
  await stream(ws, 4, (f) => stateMsg([carOnTrack(1, 0.3, 0), carOnTrack(2, 0.32, 0)], f, { 1: true }));

  window.document.getElementById('start-btn').click();
  await sleep(50);
  assert.equal(ws.payloads('start').length, 0, 'one driver is not a race: START is refused');
  assert.match(window.document.getElementById('duel-setup-line').textContent, /press START again to race alone/i);

  // the driver phone drops: the setup changed, so a confirmation given for the
  // old setup must not be reused for the new one
  ws._msg({ type: 'controller-left', slot: 1 });
  await stream(ws, 3, (f) => stateMsg([carOnTrack(1, 0.3, 0), carOnTrack(2, 0.32, 0)], f, {}));
  assert.doesNotMatch(window.document.getElementById('duel-setup-line').textContent, /press START again to race alone/i,
    'the stale confirmation is cleared when the setup changes');
  window.document.getElementById('start-btn').click();
  await sleep(50);
  assert.equal(ws.payloads('start').length, 0, 'and START is refused again');
  window.document.getElementById('start-btn').click();
  await sleep(50);
  assert.equal(ws.payloads('start').length, 1, 'the second press starts the one-driver race explicitly');
  assert.equal(window.__probe.split(), true);
  assert.deepEqual(errors, []);
});

test('v177: with both seats driven START goes straight through, carrying the 2-seat payload', { skip: SKIP }, async (t) => {
  const { dom, window, ws } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  seat(ws, 1);
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 2, state: 'waiting', laps: 3, bot: false });
  await stream(ws, 4, (f) => stateMsg([carOnTrack(1, 0.3, 0), carOnTrack(2, 0.32, 0)], f, { 1: true, 2: true }));
  window.document.getElementById('start-btn').click();
  await sleep(60);
  const starts = ws.payloads('start');
  assert.equal(starts.length, 1, 'both drivers connected: no extra press needed');
  assert.equal(starts[0].cap, 2);
  assert.equal(starts[0].bot, false);
});

test('v177: the split camera is drawn from above the road, one half per player, one shadow pass', { skip: SKIP }, async (t) => {
  const { dom, window, ws, errors } = boot();
  t.after(() => dom.window.close());
  const core = require(path.join(ROOT, 'shared/game-core.js'));
  await sleep(300);
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 2, state: 'racing', laps: 3, bot: false });
  window.__renderLog.length = 0;
  let th = 0.35;
  await stream(ws, 36, (f) => {
    th += (28 / 30) / 95;
    return stateMsg([carOnTrack(1, th, 28), carOnTrack(2, th + 0.03, 27.5)], f);
  });
  const log = window.__renderLog.slice();
  assert.ok(log.length > 20, 'the split view rendered frames (' + log.length + ' draws)');
  const T = core.MAPS[0];
  let worst = Infinity, best = -Infinity;
  for (const r of log) {
    const g = core.getTerrainHeight(T, r.x, r.z);
    worst = Math.min(worst, r.y - g);
    best = Math.max(best, r.y - g);
  }
  // the shipped build put the camera at y = 2.7 in world space: -0.6 m here, i.e. under the road
  assert.ok(worst > 0.5, 'every split render is above the ground (min ' + worst.toFixed(2) + ' m, shipped build: -0.59 m)');
  assert.ok(best < 6, 'and never floating high over the car (max ' + best.toFixed(2) + ' m)');

  // one draw per half, and never a third: a stale split flag would double every frame
  const perTick = new Map();
  for (const r of log) perTick.set(r.tick, (perTick.get(r.tick) || 0) + 1);
  assert.equal(Math.max(...perTick.values()), 2, 'exactly the two halves are drawn');
  assert.ok(perTick.size > 8, 'over ' + perTick.size + ' rendered frames');

  // both halves share the one sun, so the shadow map must not be rebuilt twice
  assert.equal(log.filter((r) => r.shadowAuto === false).length, log.length, 'shadow rebuild suppressed for the halves');
  assert.equal(window.__rend.shadowMap.autoUpdate, true, 'and restored for single-view frames');

  const half = 2 * (window.innerWidth / window.innerHeight);
  assert.ok(Math.abs(log[log.length - 1].aspect - half) < 1e-6, 'each half uses the half-screen projection');
  assert.ok(Math.abs(window.__probe.camera().aspect - (window.innerWidth / window.innerHeight)) < 1e-6,
    'the full-screen projection is restored afterwards');
  assert.deepEqual(errors, []);
});

test('v177: the two halves follow their own car, at their own height, without snapping', { skip: SKIP }, async (t) => {
  const { dom, window, ws } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  seat(ws, 1);
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 2, state: 'racing', laps: 3, bot: false });
  // the two cars are put far apart on the circuit, so "which half is showing which
  // car" cannot be a matter of luck
  const GAP = 1.2;
  let th = 0.4;
  const cars = [];        // the car positions each frame was rendered against
  window.__renderLog.length = 0;
  await stream(ws, 30, (f) => {
    th += (28 / 30) / 95;
    const msg = stateMsg([carOnTrack(1, th, 28), carOnTrack(2, th + GAP, 28)], f);
    cars.push({ c1: carOnTrack(1, th, 28), c2: carOnTrack(2, th + GAP, 28) });
    return msg;
  });
  const log = window.__renderLog.slice();
  const byTick = new Map();
  for (const r of log) { if (!byTick.has(r.tick)) byTick.set(r.tick, []); byTick.get(r.tick).push(r); }
  const pairs = [...byTick.values()].filter((v) => v.length === 2);
  assert.ok(pairs.length > 8, 'two draws per frame for ' + pairs.length + ' frames');

  // the half that is drawn FIRST must always have car 1 in front of it, and the
  // second half car 2: this is the slot binding "P1 drives car 1, P2 car 2"
  let ok = 0, swapped = 0, off = 0, sameHeight = 0;
  const heights = [];
  for (let i = 3; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    const c1 = a.c1, c2 = a.c2;
    if (!c1 || !c2) { off++; continue; }
    const dA = Math.hypot(a.x - c1.x, a.z - c1.z);
    const dA2 = Math.hypot(a.x - c2.x, a.z - c2.z);
    const dB = Math.hypot(b.x - c2.x, b.z - c2.z);
    const dB2 = Math.hypot(b.x - c1.x, b.z - c1.z);
    if (dA < dA2 && dB < dB2 && dA < 30 && dB < 30) ok++; else swapped++;
    if (Math.abs(a.y - b.y) < 0.02) sameHeight++;
    heights.push(Math.abs(a.y - b.y));
  }
  assert.equal(swapped, 0, 'each half frames its own car, every frame (' + ok + ' frames, ' + off + ' unplaceable)');
  assert.ok(ok > 8, 'and it did so for a real run of frames (' + ok + ')');
  // A camera pinned to one world height (the shipped build wrote y = 2.7) reports
  // the SAME height in both halves of EVERY frame. Two cars can pass two points of
  // equal terrain height by coincidence, so this allows a few frames - it does not
  // allow a constant height.
  assert.ok(sameHeight <= Math.max(2, Math.floor(pairs.length * 0.1)),
    'the two halves sit at their own heights over their own pieces of road (' + sameHeight + '/' + pairs.length + ' frames matched by coincidence)');
  const meanDy = heights.reduce((a, b) => a + b, 0) / heights.length;
  assert.ok(meanDy > 0.1, 'the average height gap between the halves is ' + meanDy.toFixed(2) + ' m, not 0');

  // no per-frame snap once the two half-cameras are warm
  const carStep = 28 / 30;
  let maxStep = 0;
  for (let i = 4; i < pairs.length; i++) {
    for (const k of [0, 1]) {
      maxStep = Math.max(maxStep, Math.hypot(pairs[i][k].x - pairs[i - 1][k].x, pairs[i][k].z - pairs[i - 1][k].z));
    }
  }
  assert.ok(maxStep < carStep * 1.3, 'the camera moves no further per frame than the car does (' + maxStep.toFixed(2) + ' m against ' + carStep.toFixed(2) + ' m)');
});

test('v177: leaving Local Duel clears the split view, and re-entering starts it clean', { skip: SKIP }, async (t) => {
  const { dom, window, ws } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  const click = (m) => window.document.querySelector('.mode-btn[data-mode="' + m + '"]').click();
  click('split');
  seat(ws, 1);
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 2, state: 'racing', laps: 3, bot: false });
  await stream(ws, 8, (f) => stateMsg([carOnTrack(1, 0.3 + f / 900, 20), carOnTrack(2, 0.33 + f / 900, 20)], f));

  click('fighter');
  await stream(ws, 8, (f) => stateMsg([carOnTrack(1, 0.4 + f / 900, 20), carOnTrack(2, 0.43 + f / 900, 20)], f, { 1: true, 2: true }, 'fighter'));
  assert.equal(window.__probe.split(), false, 'the split view is off after leaving the mode');
  assert.equal(window.document.getElementById('split-divider').style.display, 'none');
  assert.equal(window.document.getElementById('duel-setup').hidden, true);
  window.__renderLog.length = 0;
  const t0 = window.__frameTicks;
  await stream(ws, 8, (f) => stateMsg([carOnTrack(1, 0.4 + f / 900, 20), carOnTrack(2, 0.43 + f / 900, 20)], f, { 1: true, 2: true }, 'fighter'));
  const perTick = new Map();
  for (const r of window.__renderLog) perTick.set(r.tick, (perTick.get(r.tick) || 0) + 1);
  assert.ok(window.__frameTicks > t0);
  assert.equal(Math.max(...perTick.values()), 1, 'one draw per frame again, not two');

  // re-entering must not resurrect a stale half-camera: it re-arms and draws twice
  click('split');
  window.__renderLog.length = 0;
  await stream(ws, 6, (f) => stateMsg([carOnTrack(1, 0.5 + f / 900, 20), carOnTrack(2, 0.53 + f / 900, 20)], f));
  const perTick2 = new Map();
  for (const r of window.__renderLog) perTick2.set(r.tick, (perTick2.get(r.tick) || 0) + 1);
  assert.equal(Math.max(...perTick2.values()), 2, 'the split view is armed again');
});

test('v177: a 2-seat race room reopens in split view, while a 6-seat room never does', { skip: SKIP }, async (t) => {
  const { dom, window, ws } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  // no mode card was pressed in this session (a reload): the ROOM decides
  seat(ws, 1);
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 6, state: 'waiting', laps: 3, bot: false });
  await stream(ws, 3, (f) => stateMsg([carOnTrack(1, 0.3, 0)], f, { 1: true }));
  assert.equal(window.__probe.split(), false, 'a six-seat room is not a Local Duel');
  assert.equal(window.document.getElementById('duel-setup').hidden, true);

  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 2, state: 'waiting', laps: 3, bot: false });
  await stream(ws, 3, (f) => stateMsg([carOnTrack(1, 0.3, 0)], f, { 1: true }));
  assert.equal(window.__probe.split(), true, 'the 2-seat race room is a Local Duel room');
  assert.equal(window.document.getElementById('duel-setup').hidden, false);
  assert.equal(window.document.getElementById('split-divider').style.display, '');
});

test('v177: a held key is released on blur, on hiding the tab, and when the race ends', { skip: SKIP }, async (t) => {
  const { dom, window, ws } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'H8WT6', mode: 'race', state: 'racing' });
  await stream(ws, 6, (f) => stateMsg([carOnTrack(1, 0.3 + f / 900, 20)], f, { 1: false }));
  const lastInput = () => { const all = ws.payloads('input'); return all[all.length - 1] || null; };
  const held = () => window.__probe.heldKeys();

  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyW' }));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyD' }));
  await stream(ws, 6, (f) => stateMsg([carOnTrack(1, 0.35 + f / 900, 20)], f, { 1: false }));
  assert.equal(lastInput().throttle, 1, 'the key was being sent');
  assert.ok(lastInput().steer > 0, 'and the steering key too');

  assert.deepEqual(held().sort(), ['KeyD', 'KeyW'], 'both keys are held');
  window.dispatchEvent(new window.Event('blur'));
  await stream(ws, 6, (f) => stateMsg([carOnTrack(1, 0.4 + f / 900, 20)], f, { 1: false }));
  assert.equal(lastInput().throttle, 0, 'blur released the throttle');
  assert.equal(lastInput().steer, 0, 'blur released the steering');
  assert.deepEqual(held(), [], 'and no key is left held');

  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyW' }));
  await stream(ws, 6, (f) => stateMsg([carOnTrack(1, 0.45 + f / 900, 20)], f, { 1: false }));
  assert.equal(lastInput().throttle, 1, 'held again');
  Object.defineProperty(window.document, 'hidden', { value: true, configurable: true });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  await stream(ws, 4, (f) => stateMsg([carOnTrack(1, 0.5 + f / 900, 20)], f, { 1: false }));
  assert.equal(lastInput().throttle, 0, 'hiding the tab released the throttle (no keyup ever fires)');

  Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyW' }));
  await stream(ws, 6, (f) => stateMsg([carOnTrack(1, 0.55 + f / 900, 20)], f, { 1: false }));
  assert.equal(lastInput().throttle, 1, 'driving again after coming back');
  // the race ends: the key that finished the race must not hold throttle through the results
  ws._msg(Object.assign(stateMsg([carOnTrack(1, 0.6, 20)], 40, { 1: false }), { state: 'finished' }));
  await sleep(40);
  ws._msg(Object.assign(stateMsg([carOnTrack(1, 0.6, 20)], 41, { 1: false }), { state: 'finished' }));
  await sleep(40);
  assert.deepEqual(held(), [], 'the chequered flag released every held input');
  assert.equal(window.__probe.touch().u, 0, 'and every on-screen pedal');
});

test('v177: a lost WebGL context stops the split renders, and the restore brings them back', { skip: SKIP }, async (t) => {
  const { dom, window, ws, errors } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  seat(ws, 1);
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 2, state: 'racing', laps: 3, bot: false });
  await stream(ws, 4, (f) => stateMsg([carOnTrack(1, 0.3 + f / 900, 20), carOnTrack(2, 0.33 + f / 900, 20)], f));
  assert.ok(window.__renderLog.length > 0, 'rendering while the context is healthy');

  // the renderer canvas carries the v141 handlers; the stub collects them
  window.__rend._fire('webglcontextlost', { preventDefault() {} });
  const ticks = window.__frameTicks;
  window.__renderLog.length = 0;
  await stream(ws, 6, (f) => stateMsg([carOnTrack(1, 0.4 + f / 900, 20), carOnTrack(2, 0.43 + f / 900, 20)], f));
  assert.ok(window.__frameTicks > ticks, 'the loop keeps ticking through the loss');
  // the shipped split path called renderer.render() with no glLost guard at all:
  // drawing into a dead context is what turns a recoverable loss into a hang
  assert.equal(window.__renderLog.length, 0, 'no frame is drawn into the lost context (single view OR split)');

  window.__rend._fire('webglcontextrestored', {});
  await stream(ws, 4, (f) => stateMsg([carOnTrack(1, 0.5 + f / 900, 20), carOnTrack(2, 0.53 + f / 900, 20)], f));
  const perTick = new Map();
  for (const r of window.__renderLog) perTick.set(r.tick, (perTick.get(r.tick) || 0) + 1);
  assert.equal(Math.max(...perTick.values()), 2, 'both halves are drawn again after the restore');
  assert.deepEqual(errors, [], 'and the restore raised nothing: ' + errors.join(' | '));
});

test('v177: an odd, TV-shaped viewport keeps both halves and a valid projection', { skip: SKIP }, async (t) => {
  const { dom, window, ws, errors } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  seat(ws, 1);
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 2, state: 'racing', laps: 3, bot: false });
  // 1080p-class TV window with an odd height: the two halves must still cover the
  // whole canvas with no seam and no zero/NaN aspect (a split half of 0 divides)
  Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 1081, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
  window.__renderLog.length = 0;
  await stream(ws, 6, (f) => stateMsg([carOnTrack(1, 0.3 + f / 900, 20), carOnTrack(2, 0.33 + f / 900, 20)], f));
  const perTick = new Map();
  for (const r of window.__renderLog) perTick.set(r.tick, (perTick.get(r.tick) || 0) + 1);
  assert.equal(Math.max(...perTick.values()), 2, 'two halves at the TV size');
  const log = window.__renderLog.slice();
  for (const r of log) {
    assert.ok(isFinite(r.aspect) && r.aspect > 0.5, 'half aspect is finite: ' + r.aspect);
    assert.ok(isFinite(r.y), 'camera height is finite');
  }
  assert.ok(Math.abs(log[log.length - 1].aspect - (1920 / Math.floor(1081 / 2))) < 1e-6, 'each half is 1920 x ' + Math.floor(1081 / 2));
  assert.ok(Math.abs(window.__probe.camera().aspect - (1920 / 1081)) < 1e-6, 'the full-screen projection is restored for single view');
  assert.equal(window.__rend._w, 1920, 'the renderer was resized to the TV window');
  assert.deepEqual(errors, []);
});

test('v177: a screen that owns seat 2 counts itself as the second driver', { skip: SKIP }, async (t) => {
  const { dom, window, ws } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  // a second screen joined a two-seat race room: it drives car 2 itself
  seat(ws, 2);
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'OTHER', host: true, ready: false, color: 0xe10600 }, { slot: 2, name: 'ME', host: false, ready: false, color: 0x0d47c8 }], cap: 2, state: 'waiting', laps: 3, bot: false });
  await stream(ws, 4, (f) => stateMsg([carOnTrack(1, 0.3, 0), carOnTrack(2, 0.33, 0)], f, { 1: true }));
  const line = window.document.getElementById('duel-setup-line').textContent;
  assert.match(line, /both drivers connected/, 'a phone on car 1 plus this screen on car 2 is a full duel: ' + line);
  window.document.getElementById('start-btn').click();
  await sleep(60);
  assert.equal(ws.payloads('start').length, 1, 'START goes straight through');
});

test('v177: Reduced Motion keeps the split view, and the controls with it', { skip: SKIP }, async (t) => {
  const { dom, window, ws, errors } = boot();
  t.after(() => dom.window.close());
  await sleep(300);
  window.eval('prefs.rm = true; prefs.fx = false;');   // reduced motion + no glow pass
  window.document.querySelector('.mode-btn[data-mode="split"]').click();
  seat(ws, 1);
  ws._msg({ type: 'lobby', players: [{ slot: 1, name: 'HOST', host: true, ready: false, color: 0xe10600 }], cap: 2, state: 'racing', laps: 3, bot: false });
  window.__renderLog.length = 0;
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyW' }));
  await stream(ws, 8, (f) => stateMsg([carOnTrack(1, 0.3 + f / 900, 20), carOnTrack(2, 0.33 + f / 900, 20)], f, { 1: false }));
  const perTick = new Map();
  for (const r of window.__renderLog) perTick.set(r.tick, (perTick.get(r.tick) || 0) + 1);
  assert.equal(Math.max(...perTick.values()), 2, 'both halves still render with reduced motion');
  const inputs = ws.payloads('input');
  assert.ok(inputs.length > 0 && inputs[inputs.length - 1].throttle === 1, 'and the keyboard still drives');
  assert.deepEqual(errors, []);
});
