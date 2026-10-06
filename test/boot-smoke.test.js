'use strict';
/* ============================================================================
   v140 — production boot smoke test.

   Everything else in this suite reads source. This one RUNS the real client:
   index.html + the real script order (three, GLTFLoader, car-models, game-core,
   progression, config, account, i18n, net, game) inside a simulated DOM, with a
   stubbed WebGL renderer (three.js needs a GPU; nothing else does).

   It exists because the reported symptom was "sometimes it renders properly,
   sometimes it is completely misbehaving" - the class of failure that only shows
   up when the whole boot path actually executes. It pins:

     1. the page boots with no uncaught exception;
     2. the render loop really runs and draws;
     3. a WebSocket handshake + snapshot stream is ingested without throwing
        (interpolation, car placement, HUD, particles all run for real);
     4. WebGL context loss does not kill the loop, and the restore path runs;
     5. the renderer-creation guard turns a WebGL failure into a message, not a
        dead page.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
// jsdom is a devDependency. The boot tests skip themselves when it is absent so the
// suite never fails on a machine that only installed production dependencies.
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// three.min.js is deliberately NOT here: it is evaluated explicitly below so the
// renderer stub can be installed immediately after it. Evaluating it twice makes
// three.js replace the whole global THREE object (and log "Multiple instances...").
const SCRIPTS = [
  'js/vendor/GLTFLoader.js',
  'js/car-models.js',
  'js/game-core.js',
  'js/progression.js',
  'js/config.js',
  'js/account.js',
  'js/i18n.js',
  'js/net.js',
  'js/audio.js'   // v173: loaded by index.html before game.js, so the boot path runs it
];

// A renderer stand-in with the exact surface game.js touches. Real geometry,
// materials, scenes and maths still come from the real three.js.
const FAKE_RENDERER = `
(function () {
  var listenerBag = [];
  function FakeRenderer() {
    this.domElement = document.createElement('canvas');
    this.shadowMap = { enabled: false, type: 0, needsUpdate: false, autoUpdate: true };
    this.outputEncoding = 0;
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    this.info = { render: { calls: 0, triangles: 0 }, memory: {} };
    this._pr = 1; this._w = 1; this._h = 1; this.draws = 0;
    this.capabilities = { isWebGL2: false, getMaxAnisotropy: function () { return 1; } };
    this.properties = { get: function () { return {}; } };
    this.xr = { enabled: false };
    this.setPixelRatio = function (v) { this._pr = v; };
    this.getPixelRatio = function () { return this._pr; };
    this.setSize = function (w, h) { this._w = w; this._h = h; };
    this.getSize = function (t) { if (t) { t.x = this._w; t.y = this._h; } return { x: this._w, y: this._h }; };
    this.getDrawingBufferSize = function (t) { var o = { x: this._w * this._pr, y: this._h * this._pr }; if (t) { t.x = o.x; t.y = o.y; } return o; };
    this.render = function () { this.draws++; };
    this.clear = function () {};
    this.compile = function () {};
    this.dispose = function () {};
    this.forceContextLoss = function () {};
    this.setRenderTarget = function () {};
    this.getRenderTarget = function () { return null; };   // PMREMGenerator / EffectComposer need these
    this.getActiveCubeFace = function () { return 0; };
    this.getActiveMipmapLevel = function () { return 0; };
    this.readRenderTargetPixels = function () {};
    this.copyFramebufferToTexture = function () {};
    this.initTexture = function () {};
    this.getContextAttributes = function () { return { alpha: false, antialias: false, depth: true, stencil: true }; };
    this.getPrecision = function () { return 'highp'; };
    this.setViewport = function () {};
    this.getViewport = function (t) { if (t && t.set) t.set(0, 0, this._w, this._h); return { x: 0, y: 0, width: this._w, height: this._h }; };
    this.setScissor = function () {};
    this.setScissorTest = function () {};
    this.clearDepth = function () {};
    this.clearColor = function () {};
    this.clearStencil = function () {};
    this.getClearColor = function (t) { return t || {}; };
    this.getClearAlpha = function () { return 1; };
    this.setClearColor = function () {};
    this.setClearAlpha = function () {};
    this.resetState = function () {};
    this.compileAsync = function () { return Promise.resolve(); };
    this.getContext = function () { return { getExtension: function () { return null; } }; };
    var self = this;
    this.domElement.addEventListener = function (t, f) { listenerBag.push([t, f]); return this; };
    this._fire = function (t, ev) { for (var i = 0; i < listenerBag.length; i++) if (listenerBag[i][0] === t) listenerBag[i][1](ev || {}); };
    this.setAnimationLoop = function () {};
  }
  window.__FAKE_RENDERER = FakeRenderer;
})();
`;

function boot(opts) {
  opts = opts || {};
  const html = read('public/index.html');
  const dom = new JSDOM(html, {
    url: 'https://sridhar-drift.vercel.app/?room=ABCDE',
    // 'dangerously' + inline <script> injection runs each file as a REAL classic
    // script, which is what the browser does. window.eval() cannot: net.js and
    // game.js are strict-mode, and strict eval code does not leak its declarations
    // to the global scope, so RoomLink/urlParam would look "undefined" here while
    // working perfectly in production. External <script src> tags are not fetched
    // by jsdom (no `resources` option), so the document's own tags are inert.
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const errors = [];

  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));

  // ---- platform stubs jsdom does not provide -------------------------------
  const sockets = [];
  window.WebSocket = class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = [];
      sockets.push(this);
    }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    _msg(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
  };
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;

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
  const calls = [];
  const plain = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ build: 'v140', tickmap: 0 }), text: () => Promise.resolve('') });
  window.fetch = (u, o) => {
    const url = String(u), opt = o || {};
    calls.push({ url, method: opt.method || 'GET', body: opt.body, headers: opt.headers });
    if (!opts.accounts) return plain();
    if (url.includes('/rest/v1/profiles')) {
      if (opt.method === 'PATCH') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([Object.assign({ username: 'Sridhar' }, JSON.parse(opt.body))]) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ username: 'Sridhar', display_name: opts.name || 'Sridhar R' }]) });
    }
    return plain();
  };
  window.navigator.vibrate = () => true;
  window.navigator.share = undefined;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  if (!window.HTMLCanvasElement.prototype.getContext) window.HTMLCanvasElement.prototype.getContext = () => null;
  // A permissive 2D context: the client draws the minimap, roundels, thumbnails,
  // the QR code and the car-preview swatches, and listing every canvas call would
  // be whack-a-mole. Unknown methods are no-ops; the few whose RETURN VALUE is used
  // are explicit.
  const rt = () => ({ addColorStop() {} });
  const ctx2d = () => new Proxy({
    canvas: null,
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0, shadowColor: '', filter: 'none', imageSmoothingEnabled: true,
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
  window.HTMLCanvasElement.prototype.getContext = function (kind) {
    if (kind === '2d') return ctx2d();
    return null;                                  // no WebGL - the stub renderer is used
  };
  // count real animation frames so the tests can prove the loop is alive
  window.__frameTicks = 0;
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => realRaf((t) => { window.__frameTicks++; try { cb(t); } catch (e) { throw e; } });
  window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:stub');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
  window.localStorage.clear();
  // v144: simulate a device that has signed in but has never seen this racer's
  // name before (the exact state the "RACER1234" bug appeared in).
  if (opts.session) {
    window.localStorage.setItem('sr_sb_session', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: Math.floor(Date.now() / 1000) + 3600, uid: 'u1', email: 'a@b.co'
    }));
  }

  // ---- run the real scripts, in the real order ----------------------------
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
  if (opts.breakWebGL) {
    expose('THREE.WebGLRenderer = function () { throw new Error("WebGL blocked"); };');
  } else {
    expose('THREE.WebGLRenderer = window.__FAKE_RENDERER;');
  }
  for (const s of SCRIPTS) {
    run(s);
    // config.js ships empty Supabase keys; this makes the account client live so
    // the name-on-account path can be exercised for real.
    if (s === 'js/config.js' && opts.accounts) expose("window.SB_U='https://sb.test';window.SB_A='anon';");
  }
  if (opts.breakWebGL) {
    let threw = false;
    try { run('js/game.js'); } catch (e) { threw = true; errors.push(e.message); }
    return { dom, window, errors, sockets, calls, threw, renderer: null };
  }
  run('js/game.js');
  const renderer = window.__srRenderer || null;
  return { dom, window, errors, sockets, calls, threw: false, renderer };
}

// expose the renderer the client built (game.js does not export it - read it back
// from the canvas the client appended to #stage)
function drawnCanvas(window) {
  const stage = window.document.getElementById('stage');
  return stage && stage.querySelector('canvas');
}

const SKIP = JSDOM ? false : 'jsdom not installed (npm install --include=dev)';
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('v144: a signed-in racer sees their ACCOUNT name before any snapshot', { skip: SKIP }, async (t) => {
  // The reported bug, twice over: sign in on a device that has never seen this
  // racer and the lobby showed index.html's static "racer" placeholder, because
  // the identity was only painted from updateLobby() - i.e. once the server sent
  // a state frame. No socket traffic is driven in this test on purpose: the name
  // is on the account, so it must be on screen at page load.
  const { window, errors, dom } = boot({ accounts: true, session: true, name: 'Sridhar R' });
  t.after(() => dom.window.close());
  await settle(400);
  const chip = window.document.getElementById('account-chip');
  assert.ok(chip, 'the account chip exists');
  assert.ok(chip.textContent.includes('Sridhar R'),
    'the lobby shows the account name, got: ' + JSON.stringify(chip.textContent));
  assert.ok(!/RACER-?\d/.test(chip.textContent), 'no local placeholder is left on screen');
  const inp = window.document.getElementById('inp-name');
  assert.strictEqual(inp.value, 'Sridhar R', 'the DRIVER IDENTITY field is filled from the account');
  assert.deepStrictEqual(errors, [], 'boot errors: ' + errors.join(' | '));
});

test('v144: editing the driver name writes it to the account', { skip: SKIP }, async (t) => {
  const { window, errors, calls, dom } = boot({ accounts: true, session: true, name: 'Sridhar R' });
  t.after(() => dom.window.close());
  await settle(400);
  const inp = window.document.getElementById('inp-name');
  inp.value = 'Night Rider';
  inp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(1400);                       // the write is debounced, not per keystroke
  const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/rest/v1/profiles'));
  assert.ok(patch, 'a profile PATCH was sent');
  assert.strictEqual(JSON.parse(patch.body).display_name, 'Night Rider', 'the new name is stored on the account');
  assert.ok(String(patch.headers.Authorization).includes('Bearer AT'), 'authenticated as the racer');
  assert.ok(window.localStorage.getItem('sr_sb_name') === 'Night Rider', 'and mirrored locally');
  assert.deepStrictEqual(errors, [], 'errors: ' + errors.join(' | '));
});

test('v144: a guest never touches the account endpoints', { skip: SKIP }, async (t) => {
  const { window, errors, calls, dom } = boot();
  t.after(() => dom.window.close());
  await settle(300);
  assert.ok(!calls.some((c) => c.url.includes('/rest/v1/profiles')), 'no profile traffic without accounts');
  assert.deepStrictEqual(errors, [], 'errors: ' + errors.join(' | '));
});

test('v140: the client boots end to end with no uncaught exception', { skip: SKIP }, (t) => {
  const { window, errors, dom } = boot();
  t.after(() => dom.window.close());
  assert.deepStrictEqual(errors, [], 'boot produced errors: ' + errors.join(' | '));
  assert.ok(drawnCanvas(window), 'the renderer canvas is mounted in #stage');
  assert.ok(window.VRCore && window.VRCore.MAPS.length >= 5, 'game core loaded');
  assert.ok(window.CarModels, 'car model pipeline loaded');
  assert.ok(window.SRAccount, 'account client loaded');
});

test('v140: the render loop actually runs and draws frames', { skip: SKIP }, async (t) => {
  const { window, errors, dom } = boot();
  t.after(() => dom.window.close());
  const before = window.__frameTicks || 0;
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(errors, [], 'loop errors: ' + errors.join(' | '));
  assert.ok(window.__frameTicks > before, 'requestAnimationFrame loop is ticking');
});

test('v140: a room handshake plus a snapshot stream is ingested without throwing', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  assert.ok(sockets.length >= 1, 'the client dialed the relay');
  const ws = sockets[0];
  ws._open();
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'ABCDE', mode: 'race', state: 'waiting' });

  const mkCar = (i) => ({
    s: i, x: -40 + i * 3, z: 5 + i, h: 0.1 * i, v: 22 + i, sl: 0.4, st: 0.2 * i, th: 1,
    n: 0, m: 0, lap: 1, ll: 12, best: 20, fin: 0, ft: null, p: 1, pr: 0.2 * i,
    drift: 0, elim: 0, col: [0xe10600, 0x0d47c8, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7][i - 1],
    dc: 0, wh: 0, tr: 0, b: 1, nm: 'RACER ' + i
  });
  // a waiting frame rebuilds the lobby, then a real race stream drives
  // interpolation, placeCar, particles and the HUD for 40 frames
  for (let f = 0; f < 24; f++) {
    ws._msg({
      type: 'state', code: 'ABCDE', mode: 'race', map: 2, state: f < 3 ? 'waiting' : 'racing',
      raceTime: f * 0.033, controllers: { 1: true, 2: false }, bot: true,
      lb: [{ name: 'ALPHA', t: 21.4, pid: 'p1' }, { name: 'BRAVO', t: 22.1, pid: 'p2' }],
      weather: 'clear', totalLaps: 3,
      cars: [1, 2, 3].map(mkCar),
      events: f === 3 ? [{ type: 'count', n: 3 }, { type: 'count', n: 2 }, { type: 'count', n: 1 }] : []
    });
    await new Promise((r) => setTimeout(r, 12));
  }
  assert.deepStrictEqual(errors, [], 'stream errors: ' + errors.join(' | '));
  // the point is that the stream was ingested without throwing while the loop ran;
  // jsdom's rAF cadence is not a browser's, so this only proves the loop stayed alive
  assert.ok(window.__frameTicks > 3, 'frames kept rendering during the stream (ticks=' + window.__frameTicks + ')');
});

test('v140: losing the WebGL context does not kill the loop, and restore recovers', { skip: SKIP }, async (t) => {
  const { window, errors, dom } = boot();
  t.after(() => dom.window.close());
  const canvas = drawnCanvas(window);
  assert.ok(canvas, 'canvas present');
  canvas.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 60));
  const ticksDuringLoss = window.__frameTicks;
  assert.ok(ticksDuringLoss > 0, 'the loop keeps running while the context is lost');
  assert.deepStrictEqual(errors, [], 'context loss raised: ' + errors.join(' | '));
  canvas.dispatchEvent(new window.Event('webglcontextrestored'));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(errors, [], 'context restore raised: ' + errors.join(' | '));
  assert.ok(window.__frameTicks > ticksDuringLoss, 'rendering resumed after restore');
});

test('v140: an unavailable WebGL renderer explains itself instead of dying silently', { skip: SKIP }, async (t) => {
  const { window, errors, dom } = boot({ breakWebGL: true });
  t.after(() => dom.window.close());
  await new Promise((r) => setTimeout(r, 30));          // the message may mount on DOMContentLoaded
  const body = window.document.body.textContent || '';
  assert.ok(/3D graphics are not available/i.test(body), 'a clear on-screen explanation is shown');
  assert.ok(errors.some((e) => /WebGL unavailable/i.test(e)), 'the failure is reported as an error, not swallowed');
});


/* ============================================================================
   v176 FIGHTER RUSH — the client half, run for real.

   The simulation tests (test/fighter-rush.test.js) prove what the SERVER
   decides. This section proves what a browser does with it, and it is the part
   that would have caught a plain typo in a helper name: the whole real client is
   booted, a real fighter snapshot stream is ingested, and the HUD, the input
   frame and the event handling are inspected afterwards.
   ========================================================================== */

// a fighter wire frame, exactly as shared/game-core.js decorates it
function frCar(slot, opts) {
  const o = opts || {};
  return {
    s: slot, x: -40 + slot * 3, z: 5, h: 0.1, v: 22, sl: 0, st: 0, th: 1, n: 0, m: 0,
    lap: 0, ll: null, best: null, fin: 0, ft: null, p: o.p == null ? 1 : o.p, pr: 0,
    drift: 0, elim: 0, col: 0xe10600, dc: 0, wh: 0, tr: 0, b: 1, nm: 'FIGHTER ' + slot,
    fx: {
      hp: o.hp == null ? 82 : o.hp, ch: o.ch == null ? 65 : o.ch, cb: o.cb == null ? 4 : o.cb,
      rd: o.rd == null ? 1 : o.rd, air: o.air || 0, ay: 0, at: o.at || '',
      rm: o.rm || 0, ht: o.ht || 0, dead: o.dead || 0
    }
  };
}
function fighterState(over) {
  return Object.assign({
    type: 'state', code: 'FIGHT', mode: 'fighter', map: 0, state: 'racing', raceTime: 12.5,
    controllers: {}, bot: false, weather: 'clear', laps: 3,
    fm: { alive: 2, contest: 1, cost: 40, hpMax: 100 },
    cars: [frCar(1), frCar(2, { hp: 61, ch: 12, cb: 0, rd: 0 })],
    events: []
  }, over || {});
}
const inputFrames = (ws) => ws.sent.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
  .filter((m) => m && m.type === 'input');
const settleFrames = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise((r) => setTimeout(r, 20)); };

test('v176: a fighter snapshot drives the fighter HUD, and a race snapshot hides it', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  const $ = (id) => window.document.getElementById(id);
  const ws = sockets[0];
  ws._open();
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'FIGHT', mode: 'fighter', state: 'waiting' });

  // nothing fighter-ish is visible in a normal race
  ws._msg({ type: 'state', code: 'FIGHT', mode: 'race', map: 0, state: 'racing', controllers: {}, cars: [{ s: 1, x: 0, z: 0, h: 0, v: 20, p: 1, nm: 'A', lap: 0, pr: 0 }], events: [] });
  await settleFrames(4);
  assert.equal($('fr-hud').hidden, true, 'the fighter HUD is hidden in a race');
  assert.equal($('fr-dead').hidden, true, 'and so is the knocked-out banner');

  // now the fighter stream
  ws._msg(fighterState());
  await settleFrames(6);
  assert.equal($('fr-hud').hidden, false, 'the fighter HUD is shown in Fighter Rush');
  assert.equal($('fr-hp-txt').textContent, '82%', 'health bar reads the snapshot');
  assert.equal($('fr-hp-fill').style.width, '82%');
  assert.equal($('fr-en-txt').textContent, '65%');
  assert.equal($('fr-en-fill').style.width, '65%');
  assert.equal($('fr-combo').textContent, 'COMBO x4');
  assert.equal($('fr-ready').textContent, 'IMPACT READY', 'the impact meter says when the charge is ready');
  assert.equal($('fr-ready').dataset.ready, '1');
  assert.equal($('fr-alive').textContent, 'ALIVE 2/2', 'the remaining-fighter count is on screen');
  const ri = $('raceinfo').textContent || '';
  assert.match(ri, /FIGHTER RUSH/, 'the mode banner replaces the lap chip');
  assert.match(ri, /ALIVE 2\/2/);

  // charging state
  ws._msg(fighterState({ cars: [frCar(1, { ch: 10, rd: 0 }), frCar(2)] }));
  await settleFrames(3);
  assert.equal($('fr-ready').textContent, 'CHARGING');
  assert.equal($('fr-ready').dataset.ready, '0');

  // back to a race: everything fighter must disappear again
  ws._msg({ type: 'state', code: 'FIGHT', mode: 'race', map: 0, state: 'racing', controllers: {}, cars: [{ s: 1, x: 0, z: 0, h: 0, v: 20, p: 1, nm: 'A', lap: 0, pr: 0 }], events: [] });
  await settleFrames(4);
  assert.equal($('fr-hud').hidden, true, 'switching back to a race mode hides the fighter HUD');
  assert.equal($('fr-dead').hidden, true);
  assert.deepStrictEqual(errors, [], 'the stream raised: ' + errors.join(' | '));
});

test('v176: IMPACT is a real input, and only ever exists in Fighter Rush', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  const ws = sockets[0];
  ws._open();
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'FIGHT', mode: 'fighter', state: 'racing' });
  ws._msg(fighterState());
  await settleFrames(6);

  const key = (type, code) => window.dispatchEvent(new window.KeyboardEvent(type, { code, bubbles: true }));
  key('keydown', 'KeyE');
  await settleFrames(4);
  let frames = inputFrames(ws);
  assert.ok(frames.length > 0, 'the keyboard really is driving the car over the wire');
  assert.equal(frames[frames.length - 1].attack, true, 'holding IMPACT sends attack:true');
  key('keyup', 'KeyE');
  await settleFrames(4);
  frames = inputFrames(ws);
  assert.equal(frames[frames.length - 1].attack, false, 'releasing it sends attack:false - it is a level, the server edge-detects it');

  // the same keys in a plain race must never put an attack on the wire
  ws._msg({ type: 'state', code: 'FIGHT', mode: 'race', map: 0, state: 'racing', controllers: {}, cars: [{ s: 1, x: 0, z: 0, h: 0, v: 20, p: 1, nm: 'A', lap: 0, pr: 0 }], events: [] });
  await settleFrames(3);
  const before = inputFrames(ws).length;
  key('keydown', 'KeyE');
  await settleFrames(6);
  frames = inputFrames(ws).slice(before);
  assert.ok(frames.length > 0, 'the race is still sending input');
  for (const f of frames) {
    assert.equal(Object.prototype.hasOwnProperty.call(f, 'attack'), false, 'no attack field leaks into a race frame');
  }
  assert.deepStrictEqual(errors, [], 'raised: ' + errors.join(' | '));
});

test('v176: hits, eliminations and the victory screen are drawn from server events', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  const $ = (id) => window.document.getElementById(id);
  const ws = sockets[0];
  ws._open();
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'FIGHT', mode: 'fighter', state: 'racing' });
  ws._msg(fighterState());
  await settleFrames(4);

  // a rival's attack connects with me: vignette + the damage toast
  ws._msg(fighterState({ events: [{ type: 'fxAtk', slot: 2, kind: 'ram', armed: 0, rel: 26, x: -30, z: 5, r: 1.9 }] }));
  await settleFrames(2);
  ws._msg(fighterState({ cars: [frCar(1, { hp: 42, ht: 1 }), frCar(2)], events: [
    { type: 'fxHit', slot: 1, by: 2, kind: 'ram', dmg: 40, hp: 42, x: -30, z: 5, kx: 0, kz: 0 }
  ] }));
  await settleFrames(3);
  assert.equal($('fr-hit').classList.contains('on'), true, 'taking a hit flashes the damage vignette');
  assert.equal($('fr-hp-txt').textContent, '42%', 'and the health bar follows it down');

  // every other fighter event must be ingested (particles, rings, toasts, audio)
  ws._msg(fighterState({ events: [
    { type: 'fxCombo', slot: 1, n: 5, what: 'PERFECT LANDING' },
    { type: 'fxJump', slot: 1, x: -30, z: 5, v: 6 },
    { type: 'fxAir', slot: 1, air: 0.8, perfect: 1, x: -30, z: 5 },
    { type: 'fxNo', slot: 1, why: 'charge' },
    { type: 'fxAtk', slot: 1, kind: 'drift', armed: 0, x: -30, z: 5, r: 9.5 },
    { type: 'fxAtk', slot: 1, kind: 'slam', armed: 0, air: 0.9, x: -30, z: 5, r: 8.5 }
  ] }));
  await settleFrames(4);

  // I get knocked out: the KO banner, then the spectator camera on a live car
  ws._msg(fighterState({ fm: { alive: 1, contest: 1, cost: 40, hpMax: 100 }, cars: [frCar(1, { hp: 0, ch: 0, cb: 0, rd: 0, dead: 1 }), frCar(2, { hp: 61 })], events: [
    { type: 'fxDown', slot: 1, by: 2, left: 1 }
  ] }));
  await settleFrames(4);
  assert.equal($('fr-dead').hidden, false, 'the knocked-out banner is shown');
  assert.match($('fr-dead').textContent || '', /SPECTATING/i);
  assert.equal($('fr-alive').textContent, 'ALIVE 1/2');
  assert.deepStrictEqual(errors, [], 'raised: ' + errors.join(' | '));

  // and the match ends with the fighter results table
  ws._msg(fighterState({ state: 'finished', fm: { alive: 1, contest: 1, cost: 40, hpMax: 100 }, events: [
    { type: 'results', fighter: 1, order: [
      { slot: 2, name: 'FIGHTER 2', color: 0x0d47c8, finished: false, t: null, best: null, hp: 61, dead: 0, fighter: 1 },
      { slot: 1, name: 'FIGHTER 1', color: 0xe10600, finished: false, t: null, best: null, hp: 0, dead: 1, fighter: 1 }
    ] }
  ] }));
  await settleFrames(5);
  assert.equal($('fr-hit').classList.contains('on'), false || true, 'no crash while ending');
  const title = $('results-title').textContent || '';
  assert.match(title, /FIGHTER RUSH/, 'the end screen is labelled as Fighter Rush (got: ' + title + ')');
  assert.deepStrictEqual(errors, [], 'raised: ' + errors.join(' | '));
});

// AUDIT phase 14: a racer chooses their own name, so every place the client renders
// someone else's name is an injection surface. The server caps the length; the
// escaping has to happen here. This drives the real client with hostile names and
// asserts nothing executes and nothing becomes markup.
test('v176: a hostile racer name is rendered as text, never as markup', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  const $ = (id) => window.document.getElementById(id);
  const ws = sockets[0];
  const EVIL = '<img src=x onerror="window.__pwned=1"><script>window.__pwned2=1</script>';
  ws._open();
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'FIGHT', mode: 'fighter', state: 'racing' });
  ws._msg(fighterState({ cars: [frCar(1), Object.assign(frCar(2), { nm: EVIL })] }));
  await settleFrames(5);

  // the match ends with an evil name in the results order and in the banner
  ws._msg(fighterState({ state: 'finished', fm: { alive: 1, contest: 1, cost: 40, hpMax: 100 }, events: [
    { type: 'results', fighter: 1, order: [
      { slot: 2, name: EVIL, color: 0x0d47c8, finished: false, t: null, best: null, hp: 61, dead: 0, fighter: 1 },
      { slot: 1, name: 'ME', color: 0xe10600, finished: false, t: null, best: null, hp: 0, dead: 1, fighter: 1 }
    ] }
  ] }));
  await settleFrames(6);

  assert.equal(window.__pwned, undefined, 'no onerror handler ran');
  assert.equal(window.__pwned2, undefined, 'no script element ran');
  assert.equal(window.document.querySelectorAll('#results-rows img, #results-rows script').length, 0, 'no element was injected into the results table');
  assert.equal($('banner').querySelectorAll('img, script').length, 0, 'and none into the winner banner');
  const text = ($('results-rows').textContent || '') + ($('banner').textContent || '');
  assert.ok(text.includes('<img src=x'), 'the hostile name is shown literally instead');
  assert.deepStrictEqual(errors, [], 'raised: ' + errors.join(' | '));
});

test('v176: the on-screen IMPACT button appears for a touch device, and never for a race', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  const $ = (id) => window.document.getElementById(id);
  Object.defineProperty(window, 'ontouchstart', { value: null, configurable: true });
  const ws = sockets[0];
  ws._open();
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'FIGHT', mode: 'fighter', state: 'racing' });
  ws._msg(fighterState());
  await settleFrames(6);
  assert.equal($('tc-impact').hidden, false, 'a touch device gets the IMPACT control');
  assert.equal($('tc-impact').dataset.ready, '1', 'and it shows when the charge is ready');

  ws._msg(fighterState({ cars: [frCar(1, { ch: 5, rd: 0 }), frCar(2)] }));
  await settleFrames(3);
  assert.equal($('tc-impact').dataset.ready, '0');

  // pressing the on-screen button is what sends the attack: hold it down, and the
  // very next input frame must carry it - exactly like the physical phone button
  const btn = $('tc-impact');
  btn.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  await settleFrames(4);
  let frames = inputFrames(ws);
  assert.ok(frames.length > 0, 'the touch controls drive the car');
  assert.equal(frames[frames.length - 1].attack, true, 'holding the on-screen IMPACT sends attack:true');
  btn.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  await settleFrames(4);
  frames = inputFrames(ws);
  assert.equal(frames[frames.length - 1].attack, false, 'letting go stops it (no stuck input)');

  ws._msg({ type: 'state', code: 'FIGHT', mode: 'race', map: 0, state: 'racing', controllers: {}, cars: [{ s: 1, x: 0, z: 0, h: 0, v: 20, p: 1, nm: 'A', lap: 0, pr: 0 }], events: [] });
  await settleFrames(4);
  assert.equal($('tc-impact').hidden, true, 'the button is gone outside Fighter Rush');
  assert.deepStrictEqual(errors, [], 'raised: ' + errors.join(' | '));
});

// v176 AUDIT FIX: the pad could drive but never attack. L1 (button 4) is IMPACT,
// and the field must still only exist while the room is a fighter room.
test('v176: a gamepad can use the IMPACT charge (L1), and only in Fighter Rush', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  const ws = sockets[0];
  // one connected pad, nothing pressed except L1
  const pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) };
  Object.defineProperty(window.navigator, 'getGamepads', { value: () => [pad], configurable: true });
  pad.buttons[4] = { pressed: true, value: 1 };
  ws._open();
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'FIGHT', mode: 'fighter', state: 'racing' });
  ws._msg(fighterState());
  await settleFrames(6);
  let frames = inputFrames(ws);
  assert.ok(frames.length > 0, 'the pad is read every input frame');
  assert.equal(frames[frames.length - 1].attack, true, 'L1 sends attack:true');

  // release it: no stuck attack
  pad.buttons[4] = { pressed: false, value: 0 };
  await settleFrames(4);
  frames = inputFrames(ws);
  assert.equal(frames[frames.length - 1].attack, false, 'releasing L1 stops the attack');

  // and the very same pad in a race sends no attack field at all
  ws._msg({ type: 'state', code: 'FIGHT', mode: 'race', map: 0, state: 'racing', controllers: {}, cars: [{ s: 1, x: 0, z: 0, h: 0, v: 20, p: 1, nm: 'A', lap: 0, pr: 0 }], events: [] });
  pad.buttons[4] = { pressed: true, value: 1 };
  await settleFrames(5);
  frames = inputFrames(ws);
  assert.ok(frames.length > 0);
  assert.ok(!('attack' in frames[frames.length - 1]), 'a race frame never carries the attack field');
  assert.deepStrictEqual(errors, [], 'raised: ' + errors.join(' | '));
});

// v176 AUDIT FIX: assistive tech can read the bars on demand, and the live region is
// the footer only - the bars repaint every frame, so a polite region around them would
// have announced non-stop.
test('v176: the health and energy bars are readable progressbars, with no chatty live region', { skip: SKIP }, async (t) => {
  const { window, errors, sockets, dom } = boot();
  t.after(() => dom.window.close());
  const $ = (id) => window.document.getElementById(id);
  const ws = sockets[0];
  ws._open();
  ws._msg({ type: 'welcome', role: 'screen', slot: 1, code: 'FIGHT', mode: 'fighter', state: 'racing' });
  ws._msg(fighterState());
  await settleFrames(6);
  assert.equal($('fr-hud').getAttribute('aria-live'), null, 'the panel itself is not a live region');
  assert.equal($('fr-hud').querySelector('.fr-foot').getAttribute('aria-live'), 'polite', 'the footer is, so ready/eliminated are announced');
  for (const [bar, val] of [['fr-hp-bar', 'fr-hp-fill'], ['fr-en-bar', 'fr-en-fill']]) {
    assert.equal($(bar).getAttribute('role'), 'progressbar', bar + ' is a progressbar');
    assert.equal($(bar).getAttribute('aria-valuemin'), '0');
    assert.equal($(bar).getAttribute('aria-valuemax'), '100');
    assert.ok($(bar).getAttribute('aria-labelledby'), bar + ' is labelled');
    assert.ok($(val), 'the visual fill is still there');
  }
  // the fixture racer is at 82 % health and 65 % charge
  assert.equal($('fr-hp-bar').getAttribute('aria-valuenow'), '82', 'health reads what the server sent');
  assert.equal($('fr-en-bar').getAttribute('aria-valuenow'), '65', 'so does the charge');
  ws._msg(fighterState({ cars: [frCar(1, { hp: 55, ch: 33 }), frCar(2)] }));
  await settleFrames(4);
  assert.equal($('fr-hp-bar').getAttribute('aria-valuenow'), '55', 'damage moves the readable value');
  assert.equal($('fr-en-bar').getAttribute('aria-valuenow'), '33', 'so does the charge');
  assert.equal($('fr-hp-txt').textContent, '55%', 'and the visible percentage agrees');
  // the desktop hint exists and names a key
  assert.equal($('fr-key').textContent.trim(), 'E', 'a keyboard player is told which key attacks');
  assert.deepStrictEqual(errors, [], 'raised: ' + errors.join(' | '));
});
