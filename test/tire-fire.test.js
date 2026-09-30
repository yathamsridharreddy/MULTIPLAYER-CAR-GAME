'use strict';
/* ============================================================================
   v152 — tire fire replaces the black skid marks.

   The other tests in this suite read source. This one RUNS the client: the real
   index.html, the real script order, real three.js and a stubbed renderer (three
   needs a GPU, nothing else does). It then drives a real snapshot stream and
   inspects the scene graph the client built — because "the fire appears on the
   tires that are actually slipping, follows the car, and stops when the slide
   ends" cannot be proved by reading source.

   The fires are located by finding the car the client actually rendered (by its
   paint colour) and reading its wheel pivots out of the scene, so the assertions
   hold against the real geometry rather than against a guess at where the car is.

   What it pins:
     1. the black skid-mark system is gone, and nothing spawns it
     2. while a car is sliding, fire appears at ITS rear tire contact patches —
        for a remote car as well as the local one
     3. while a car is gripping, there is no fire anywhere near it
     4. the front tires only join in once the slide is deep
     5. when the slide stops the fire goes out promptly, rather than burning down
        its full lifetime
     6. six cars drifting at once stay inside the pool
     7. nothing feeds back into the simulation or the wire protocol
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = [
  'js/vendor/GLTFLoader.js', 'js/car-models.js', 'js/game-core.js', 'js/progression.js',
  'js/config.js', 'js/account.js', 'js/i18n.js', 'js/net.js'
];

// comments are not code - the v152 note above the effect names the old colour on
// purpose, and asserting against it would fail on the explanation of the removal
const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The tire-fire palette (flames, embers, sparks). Every one of these belongs to the
// fire and to nothing else - the nitro flames are blue, the smoke is grey, the
// weather spray is blue or white, the headlights are 0xfff2c0/0xff2020 - so matching
// on colour isolates the effect in a scene that also holds every other pool.
const FIRE = [0xfff6dd, 0xffdd82, 0xffa939, 0xff7d1f, 0xff7a1f, 0xff4d12, 0xe0300a, 0xffe9a8, 0xffc25c];
// the three kinds use disjoint palettes, so a particle's colour says exactly which
// layer it belongs to - no guessing from size or position
const FLAME_COLS = [0xfff6dd, 0xffdd82, 0xffa939, 0xff7d1f];
const EMBER_COLS = [0xff7a1f, 0xff4d12, 0xe0300a];
const SPARK_COLS = [0xffe9a8, 0xffc25c];

// The renderer stand-in. `render(scene)` keeps a handle on the scene so a test can
// inspect what the client actually built - that is the whole point here.
const FAKE_RENDERER = `
(function () {
  function FakeRenderer() {
    this.domElement = document.createElement('canvas');
    this.shadowMap = { enabled: false, type: 0, needsUpdate: false, autoUpdate: true };
    this.info = { render: { calls: 0, triangles: 0 }, memory: {} };
    this.capabilities = { isWebGL2: false, getMaxAnisotropy: function () { return 1; } };
    this.properties = { get: function () { return {}; } };
    this.xr = { enabled: false };
    this._pr = 1; this._w = 1; this._h = 1; this.draws = 0; this.scene = null;
    this.setPixelRatio = function (v) { this._pr = v; };
    this.getPixelRatio = function () { return this._pr; };
    this.setSize = function (w, h) { this._w = w; this._h = h; };
    this.getSize = function () { return { x: this._w, y: this._h }; };
    this.getDrawingBufferSize = function () { return { x: this._w, y: this._h }; };
    this.render = function (scene, camera) { this.draws++; this.scene = scene; window.__capScene = scene; window.__capCamera = camera; };
    this.getContext = function () { return { getExtension: function () { return null; } }; };
    this.setAnimationLoop = function () {};
    ['clear','compile','dispose','forceContextLoss','setRenderTarget','setViewport','setScissor',
     'setScissorTest','clearDepth','clearColor','clearStencil','setClearColor','setClearAlpha',
     'resetState','initTexture','copyFramebufferToTexture','readRenderTargetPixels'].forEach(function (m) {
      FakeRenderer.prototype[m] = function () {};
    });
    this.getRenderTarget = function () { return null; };
    this.getActiveCubeFace = function () { return 0; };
    this.getActiveMipmapLevel = function () { return 0; };
    this.getContextAttributes = function () { return { alpha: false, depth: true, stencil: true }; };
    this.getPrecision = function () { return 'highp'; };
    this.getClearColor = function (t) { return t || {}; };
    this.getClearAlpha = function () { return 1; };
    this.compileAsync = function () { return Promise.resolve(); };
    this._fire = function () {};
  }
  window.__FAKE_RENDERER = FakeRenderer;
})();
`;

function ctx2d() {
  // A permissive 2D context: the client draws the minimap, roundels, thumbnails,
  // the QR code and the terrain grass noise. Unknown methods are no-ops; the ones
  // whose RETURN VALUE is used have to be real, and createImageData is one of them
  // (the terrain builder reads .data.buffer straight off it).
  const rt = () => ({ addColorStop() {} });
  return new Proxy({
    canvas: null,
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0, shadowColor: '', filter: 'none',
    imageSmoothingEnabled: true,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }),
    measureText: () => ({ width: 10 }),
    createRadialGradient: rt,
    createLinearGradient: rt,
    createPattern: () => ({}),
    getTransform: () => ({}),
    isPointInPath: () => false
  }, {
    get(t, k) { return (k in t) ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; }
  });
}

function boot() {
  const dom = new JSDOM(read('public/index.html'), {
    url: 'https://sridhar-drift.vercel.app/?room=ABCDE',
    runScripts: 'dangerously', pretendToBeVisual: true
  });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));

  const sockets = [];
  window.WebSocket = class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    _open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    _msg(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
  };
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;
  window.HTMLCanvasElement.prototype.getContext = function (kind) { return kind === '2d' ? ctx2d() : null; };

  // ---- the rest of the platform surface the client touches at boot ----------
  const audioParam = () => new Proxy({ value: 0 }, {
    get(t, k) { return (k in t) ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; }
  });
  const audioNode = (extra) => new Proxy(Object.assign({
    connect() { return this; }, disconnect() {}, start() {}, stop() {},
    gain: audioParam(), frequency: audioParam(), Q: audioParam(), detune: audioParam(),
    threshold: audioParam(), ratio: audioParam(), knee: audioParam(), attack: audioParam(), release: audioParam(),
    delayTime: audioParam(), pan: audioParam(), curve: null, oversample: 'none', type: '', buffer: null, loop: false,
    playbackRate: audioParam(), positionX: audioParam(), positionY: audioParam(), positionZ: audioParam()
  }, extra || {}), {
    get(t, k) { return (k in t) ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; }
  });
  window.AudioContext = class {
    constructor() {
      this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000;
      this.destination = audioNode();
      this.listener = audioNode({ positionX: audioParam(), positionY: audioParam(), positionZ: audioParam() });
    }
    createGain() { return audioNode(); }
    createOscillator() { return audioNode(); }
    createBiquadFilter() { return audioNode(); }
    createDynamicsCompressor() { return audioNode(); }
    createWaveShaper() { return audioNode(); }
    createPanner() { return audioNode(); }
    createStereoPanner() { return audioNode(); }
    createConvolver() { return audioNode(); }
    createAnalyser() { return audioNode({ fftSize: 1024, frequencyBinCount: 512 }); }
    createBufferSource() { return audioNode(); }
    createBuffer(c, l) { return { getChannelData: () => new Float32Array(l), length: l, numberOfChannels: c, sampleRate: 48000, duration: l / 48000 }; }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({}); }
  };
  window.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ build: 'v152', tickmap: 0, ok: true }),
    text: () => Promise.resolve('')
  });
  window.navigator.vibrate = () => true;
  window.matchMedia = window.matchMedia || (() => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}
  }));

  window.__frameTicks = 0;
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => realRaf((t) => { window.__frameTicks++; cb(t); });
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {};
  window.localStorage.clear();

  const run = (rel) => {
    const el = window.document.createElement('script');
    el.textContent = read('public/' + rel);
    window.document.head.appendChild(el);
  };
  const expose = (src) => {
    const el = window.document.createElement('script');
    el.textContent = src;
    window.document.head.appendChild(el);
  };
  expose(FAKE_RENDERER);
  run('js/vendor/three.min.js');
  expose('THREE.WebGLRenderer = window.__FAKE_RENDERER;');
  for (const s of SCRIPTS) run(s);
  run('js/game.js');
  return { dom, window, errors, sockets };
}

// A car as the server replicates it. `sl` is the physics slip that gates the fire.
// `col` is chosen outside CAR_COLORS so the test can find the car it put on the
// track by its paint colour alone.
const mkCar = (s, extra) => Object.assign({
  s, x: 0, z: 0, h: 0, v: 24, sl: 0.4, st: 0, th: 1, n: 0, m: 0, lap: 1, ll: 12,
  best: 20, fin: 0, ft: null, p: 1, pr: 0.2, drift: 0, elim: 0, col: 0xe10600,
  dc: 0, wh: 0, tr: 0, b: 1, nm: 'RACER ' + s
}, extra || {});

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// every live particle sprite the client is currently drawing
function fireSprites(window) {
  const scene = window.__capScene;
  if (!scene) return [];
  const out = [];
  scene.traverse((o) => {
    if (o.isSprite && o.visible && o.material && o.material.opacity > 0.01 && FIRE.includes(o.material.color.getHex())) {
      out.push({
        x: o.position.x, y: o.position.y, z: o.position.z,
        len: o.scale.x, wid: o.scale.y, rot: o.material.rotation,
        col: o.material.color.getHex()
      });
    }
  });
  return out;
}

// The car the client actually drew for a given paint colour, with the world
// position of its four wheel pivots. Reading the rig back out of the scene means
// the assertions hold where the car really is, including the render-time track
// clamp that placeCar() applies - not where the raw snapshot said it was.
function carRig(window, color) {
  const scene = window.__capScene;
  if (!scene) return null;
  scene.updateMatrixWorld(true);
  let found = null;
  scene.traverse((g) => {
    if (found || !g.isGroup || g.children.length < 4) return;
    const pivots = g.children.filter((c) => c.isGroup && c.children.length === 2 && c.children[0].isGroup);
    if (pivots.length !== 4) return;
    let paint = null;
    g.traverse((o) => {
      if (paint == null && o.isMesh && o.material && o.material.color && o.material.color.getHex() === color) paint = o.material.color.getHex();
    });
    if (paint !== color) return;
    const wheels = pivots.map((p) => {
      const wp = new window.THREE.Vector3();
      p.getWorldPosition(wp);
      return { x: wp.x, z: wp.z, front: p.position.z > 0 };   // local +z is the car's nose
    });
    found = { wheels, group: g };
  });
  return found;
}

const nearWheel = (sprites, w, r) => sprites.filter((s) => Math.hypot(s.x - w.x, s.z - w.z) <= r);

// count how many fire particles sit on a given axle of a given car
function axleFire(window, color, front) {
  const rig = carRig(window, color);
  if (!rig) return null;
  const sprites = fireSprites(window);
  let n = 0;
  for (const w of rig.wheels) {
    if (!!w.front !== !!front) continue;
    n += nearWheel(sprites, w, 2.4).length;
  }
  return n;
}

const SKIP = JSDOM ? false : 'jsdom not installed (npm install --include=dev)';

// feed a race stream: slots 1 and 2, each with its own slip curve
async function drive(window, sockets, frames, cars) {
  const ws = sockets[0];
  ws._open();
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'ABCDE', mode: 'race', state: 'waiting' });
  for (let f = 0; f < frames; f++) {
    ws._msg({
      type: 'state', code: 'ABCDE', mode: 'race', map: 2, state: 'racing',
      raceTime: f * 0.033, controllers: { 1: true, 2: false }, bot: false, weather: 'clear',
      totalLaps: 3, lb: [], events: [],
      cars: cars.map((c) => mkCar(c.s, Object.assign({}, c, {
        sl: typeof c.sl === 'function' ? c.sl(f) : c.sl
      })))
    });
    await settle(14);
  }
}

const LOCAL_COL = 0x00ffff;      // cyan   - the local racer
const REMOTE_COL = 0xff00ff;     // magenta- the remote racer. Neither is in CAR_COLORS,
const FIELD_COLS = [0x00ffff, 0xff00ff, 0x00ff88, 0x8f00ff, 0x00ffcc, 0xff00aa];

test('v152: the black skid-mark system is gone', () => {
  const GAME = bare(read('public/js/game.js'));
  assert.ok(!/skidMesh|spawnSkid|SKID_MAX/.test(GAME),
    'the black marks (an InstancedMesh of near-black quads) must be removed, not just unused');
  assert.ok(!/0x0c0d10/.test(GAME), 'and their near-black colour with them');
  assert.match(GAME, /tireFire\(slot, cs, v, dt\)/, 'the fire took over the trigger site');
});

test('v152: the effect is driven by the existing physics slip, per car', () => {
  const GAME = bare(read('public/js/game.js'));
  const at = GAME.indexOf('function tireFire(slot, cs, v, dt)');
  const body = GAME.slice(at, at + 1400);
  // the same signal the skid marks used, so it lights up exactly when the car slides
  assert.match(body, /cs\.sl > 4\.5/, 'uses the physics slip threshold');
  assert.match(body, /Math\.abs\(cs\.v\) > 6/, 'and the speed gate');
  assert.match(body, /cs\.sl > 3\.6/, 'with a lower release threshold so it cannot strobe');
  assert.match(body, /slot === mySlot/, 'the local car is distinguished from remote cars');
  assert.match(body, /extinguishTireFire\(slot\)/, 'and a hooked-up tire puts its fire out');
  // emission is on a timer, so the effect cannot scale with frame rate or with
  // how many cars are on the road
  assert.match(body, /st\.acc \+= dt/, 'emission is time-based');
});

test('v152: nothing about the physics or the wire protocol changed', () => {
  // the effect is presentation only: the simulation and the replicated snapshot
  // fields must not know it exists
  for (const f of ['shared/game-core.js', 'public/js/game-core.js']) {
    assert.ok(!/tireFire|spawnTireFire|WHEEL_TX/.test(read(f)), `${f} must not know about the effect`);
  }
  const GAME = bare(read('public/js/game.js'));
  for (const m of GAME.matchAll(/net\.send\(\{[^}]*\}\)/g)) {
    assert.ok(!/fire|ember|spark|smoke/i.test(m[0]), 'no effect state goes over the wire: ' + m[0].slice(0, 60));
  }
  // and the fire writes nothing back into the car state it reads
  const at = GAME.indexOf('function tireFire(slot, cs, v, dt)');
  const body = GAME.slice(at, at + 2600);
  for (const bad of [/cs\.sl\s*=/, /cs\.v\s*=/, /cs\.h\s*=/, /cs\.x\s*=/, /cs\.z\s*=/]) {
    assert.ok(!bad.test(body), 'the effect must not write back to the car state: ' + bad);
  }
});

test('v152: a sliding car lights its own rear tires (single player)', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  await drive(window, sockets, 26, [
    { s: 1, x: 0, z: 0, v: 26, sl: 13, col: LOCAL_COL },      // the player, sliding hard
    { s: 2, x: 60, z: 0, v: 26, sl: 0.4, col: REMOTE_COL }     // a rival, gripping
  ]);
  assert.deepStrictEqual(errors, [], 'stream errors: ' + errors.join(' | '));
  assert.ok(carRig(window, LOCAL_COL), 'the sliding car was rendered');
  const rear = axleFire(window, LOCAL_COL, false);
  assert.ok(rear >= 4, `the sliding car's rear tires should be alight (${rear} particles)`);
  assert.strictEqual(carRig(window, LOCAL_COL).wheels.filter((w) => !w.front).length, 2, 'two rear wheels');
  assert.strictEqual(axleFire(window, REMOTE_COL, false), 0, 'a gripping car must not burn');

  // Streak guard. Two failure modes matter here and they pull in opposite directions:
  // particles too small to read (the bug this project keeps rediscovering), and round
  // puffs instead of the smears a sliding tire actually leaves. A sprite's scale is in
  // world units, so these are metres - the game's own smoke puffs are 0.9-1.5 across.
  const flames = flamesOf(window);
  assert.ok(fireSprites(window).length >= 4, 'the sliding car produced particles');
  const widths = flames.map((p) => p.wid).sort((a, b) => a - b);
  const lens = flames.map((p) => p.len).sort((a, b) => b - a);
  assert.ok(flames.length, 'no flame-layer particles at all');
  assert.ok(widths[widths.length - 1] >= 0.2, `the widest streak is only ${widths[widths.length - 1].toFixed(2)} units wide`);
  assert.ok(lens[0] >= 1.2, `the longest streak is only ${lens[0].toFixed(2)} units - too short to read as motion`);
  assert.ok(lens[0] <= 5, `a ${lens[0].toFixed(2)} unit streak is a wall of light, not a trail`);
  // and the SHORTEST one, which is the regression this project has hit before: a
  // particle scaled down until it is a speck of noise rather than a smear of fire.
  // Even a front tire that is only just washing out has to leave a visible trail.
  assert.ok(lens[lens.length - 1] >= 0.9,
    `the shortest streak is ${lens[lens.length - 1].toFixed(2)} units - that is a dot, not a streak`);
  const ratios = flames.map((p) => p.len / p.wid).sort((a, b) => a - b);
  const median = ratios[ratios.length >> 1];
  assert.ok(median >= 3, `the median flame is ${median.toFixed(1)}x longer than it is wide - barely a smear`);
});

test('v152: a sliding REMOTE car lights its own rear tires (multiplayer)', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  // now the REMOTE car is the one sliding and the local car is gripping. The fire
  // has to follow the car that is actually slipping, not the player's own.
  await drive(window, sockets, 26, [
    { s: 1, x: 0, z: 0, v: 26, sl: 0.4, col: LOCAL_COL },
    { s: 2, x: 60, z: 0, v: 26, sl: 13, col: REMOTE_COL }
  ]);
  assert.deepStrictEqual(errors, [], 'stream errors: ' + errors.join(' | '));
  assert.ok(carRig(window, REMOTE_COL), 'the remote car was rendered');
  const rear = axleFire(window, REMOTE_COL, false);
  assert.ok(rear >= 4, `the remote car's rear tires should be alight (${rear} particles)`);
  assert.strictEqual(axleFire(window, LOCAL_COL, false), 0, 'the local car, which is gripping, must not burn');
});

test('v152: the gripping front tires only join in on a deep slide', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  // sl 6 is over the 4.5 lighting threshold but well short of the wash-out point,
  // so the rear axle burns and the front axle is still gripping. Sampled early:
  // particles thrown off the rear tires travel backwards at ~26 m/s, so after a
  // while a few of them are legitimately down near the front wheels.
  await drive(window, sockets, 7, [
    { s: 1, x: 0, z: 0, v: 26, sl: 6, col: LOCAL_COL },
    { s: 2, x: 60, z: 0, v: 26, sl: 0.4, col: REMOTE_COL }
  ]);
  assert.deepStrictEqual(errors, [], 'stream errors: ' + errors.join(' | '));
  const rear = axleFire(window, LOCAL_COL, false);
  const front = axleFire(window, LOCAL_COL, true);
  assert.ok(rear >= 2, `a moderate slide should still burn the rear tires (${rear} particles)`);
  assert.strictEqual(front, 0, `the front tires are still gripping (${front} particles)`);
});

test('v152: the fire goes out when the slide ends, it does not burn down slowly', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  // 10 frames sliding, then the car hooks up, then 20 more frames (280 ms). An
  // ember is thrown with 0.42-0.82 s of life and a spark with 0.22-0.48 s, so
  // without the extinguish clamp the last second of sliding would still be
  // glowing here. With it, everything is clamped to 0.12 s and is long gone.
  await drive(window, sockets, 30, [
    { s: 1, x: 0, z: 0, v: 26, sl: (f) => (f < 10 ? 13 : 0.5), col: LOCAL_COL },
    { s: 2, x: 60, z: 0, v: 26, sl: 0.4, col: REMOTE_COL }
  ]);
  assert.deepStrictEqual(errors, [], 'stream errors: ' + errors.join(' | '));
  const rig = carRig(window, LOCAL_COL);
  const sprites = fireSprites(window);
  let byTheCar = 0;
  for (const w of rig.wheels) byTheCar += nearWheel(sprites, w, 2.4).length;
  assert.ok(byTheCar <= 2, `the fire should be out, ${byTheCar} particles still on the tires`);
});

// The flames are the trail: long, low, and always on the tire. Embers and sparks are
// thrown off it and are small, so length and aiming are judged on the flames alone.
const flamesOf = (window) => fireSprites(window).filter((p) => FLAME_COLS.includes(p.col));
const medianOf = (a) => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[v.length >> 1] : NaN; };

test('v152: the streaks are aimed down the car\'s own travel', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  // the car drives straight down +z and slides: heading 0 means its forward is +z, so
  // every streak it leaves has to run back along -z, projected into the camera's plane
  await drive(window, sockets, 20, [
    { s: 1, x: 0, z: 0, v: 26, sl: 8, col: LOCAL_COL },
    { s: 2, x: 60, z: 0, v: 26, sl: 0.4, col: REMOTE_COL }
  ]);
  assert.deepStrictEqual(errors, [], 'stream errors: ' + errors.join(' | '));
  const cam = window.__capCamera;
  assert.ok(cam && cam.matrixWorld, 'the client rendered through a real camera');
  // the streak is a billboard: material.rotation spins it about the view axis, so its
  // long axis ends up along (cos rot * cameraRight + sin rot * cameraUp) in the world.
  // Reconstructing that from the camera's own matrix is an independent check of the
  // aiming - a rotation left at zero would put the streak across the car, not behind it.
  const e = cam.matrixWorld.elements;
  const rgt = [e[0], e[1], e[2]], up = [e[4], e[5], e[6]];
  const back = [0, 0, -1];                      // heading 0 -> forward is +z
  const expected = Math.atan2(
    back[0] * up[0] + back[1] * up[1] + back[2] * up[2],
    back[0] * rgt[0] + back[1] * rgt[1] + back[2] * rgt[2]
  );
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const errs = flamesOf(window).map((p) => Math.abs(wrap(p.rot - expected)));
  assert.ok(errs.length >= 4, `not enough flames to judge (${errs.length})`);
  const close = errs.filter((v) => v < 0.4).length;
  assert.ok(close / errs.length >= 0.85,
    `only ${close}/${errs.length} streaks point down the car's travel (median error ${medianOf(errs).toFixed(2)} rad)`);
  assert.ok(medianOf(errs) < 0.25, `median aiming error ${medianOf(errs).toFixed(2)} rad`);
});

test('v152: the smear lengthens with speed', { skip: SKIP }, async (t) => {
  // a motion smear has to scale with the speed the tire is carrying, otherwise it is
  // a decal rather than motion. Same slide in both runs, only the speed differs.
  const slow = boot();
  t.after(() => { slow.dom.window.close(); });
  await drive(slow.window, slow.sockets, 20, [
    { s: 1, x: 0, z: 0, v: 8, sl: 8, col: LOCAL_COL },
    { s: 2, x: 60, z: 0, v: 8, sl: 0.4, col: REMOTE_COL }
  ]);
  const fast = boot();
  t.after(() => { fast.dom.window.close(); });
  await drive(fast.window, fast.sockets, 20, [
    { s: 1, x: 0, z: 0, v: 30, sl: 8, col: LOCAL_COL },
    { s: 2, x: 60, z: 0, v: 30, sl: 0.4, col: REMOTE_COL }
  ]);
  assert.deepStrictEqual(slow.errors, [], 'slow run: ' + slow.errors.join(' | '));
  assert.deepStrictEqual(fast.errors, [], 'fast run: ' + fast.errors.join(' | '));
  const a = medianOf(flamesOf(slow.window).map((p) => p.len));
  const b = medianOf(flamesOf(fast.window).map((p) => p.len));
  assert.ok(isFinite(a) && isFinite(b), `lengths missing (${a}, ${b})`);
  assert.ok(b > a * 1.25, `smear barely grew with speed: ${a.toFixed(2)} at 8 m/s vs ${b.toFixed(2)} at 30 m/s`);
});

test('v152: the whole field can drift without the pool running away', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  await drive(window, sockets, 22, FIELD_COLS.map((col, i) => ({
    s: i + 1, x: i * 40, z: 0, v: 26, sl: 14, col
  })));
  assert.deepStrictEqual(errors, [], 'stream errors: ' + errors.join(' | '));
  let lit = 0;
  for (const col of FIELD_COLS) if (axleFire(window, col, false) >= 2) lit++;
  assert.ok(lit >= 5, `six cars are drifting, only ${lit} look lit`);
  // the tire-fire pool is a hard ceiling of 240 sprites; with every other pool in
  // the game also running, the scene must stay far short of unbounded
  const total = fireSprites(window).length;
  assert.ok(total <= 240, `${total} fire particles alive - the pool is not bounding it`);
});
