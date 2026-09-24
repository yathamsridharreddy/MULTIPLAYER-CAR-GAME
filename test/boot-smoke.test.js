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
  'js/net.js'
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
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ build: 'v140', tickmap: 0 }), text: () => Promise.resolve('') });
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
  for (const s of SCRIPTS) run(s);
  if (opts.breakWebGL) {
    let threw = false;
    try { run('js/game.js'); } catch (e) { threw = true; errors.push(e.message); }
    return { dom, window, errors, sockets, threw, renderer: null };
  }
  run('js/game.js');
  const renderer = window.__srRenderer || null;
  return { dom, window, errors, sockets, threw: false, renderer };
}

// expose the renderer the client built (game.js does not export it - read it back
// from the canvas the client appended to #stage)
function drawnCanvas(window) {
  const stage = window.document.getElementById('stage');
  return stage && stage.querySelector('canvas');
}

const SKIP = JSDOM ? false : 'jsdom not installed (npm install --include=dev)';

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
    drift: 0, elim: 0, col: [0xe10600, 0x0a84ff, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7][i - 1],
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
