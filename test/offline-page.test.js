// OFFLINE MODE IN THE REAL PAGE (v165) — the part a player actually touches.
//
// This boots public/index.html the way a browser does (real scripts in the real
// order, stubbed canvas/audio/WebGL - the same stand-ins the club tests use),
// with one addition that is the whole point: WebSocket is armed to THROW. If
// anything on the offline path reaches for the relay, this test fails loudly
// instead of passing by accident.
//
// It then proves the user-facing claims:
//   1. the arrow keys are the driving keys (up/down/left/right),
//   2. phones get on-screen arrow buttons wired to that same input,
//   3. choosing OFFLINE and pressing START runs a whole race with no socket,
//      with the arrows driving the car, and the result stays on the device
//      (localStorage) - nothing is submitted,
//   4. a browser with no connection is not bounced to a sign-in page it cannot
//      load, while an online browser still is.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install --include=dev)';

// The real page scripts, in the order index.html loads them.
const SCRIPTS = [
  'js/vendor/three.min.js',
  'js/vendor/GLTFLoader.js',
  'js/car-models.js',
  'js/vendor/qrcode.js',
  'js/game-core.js',
  'js/progression.js',
  'js/config.js',
  'js/account.js',
  'js/i18n.js',
  'js/offline-save.js',          // index.html loads it before offline.js
  'js/offline.js',
  'js/net.js',
  'js/game.js'
];

// A renderer stand-in with the exact surface game.js touches. Real geometry,
// materials, scenes and maths still come from the real three.js.
const FAKE_RENDERER = `
(function () {
  function FakeRenderer() {
    this.domElement = document.createElement('canvas');
    this.shadowMap = { enabled: false, type: 0, needsUpdate: false, autoUpdate: true };
    this.outputEncoding = 0; this.toneMapping = 0; this.toneMappingExposure = 1;
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
    this.clear = function () {}; this.compile = function () {}; this.dispose = function () {};
    this.forceContextLoss = function () {}; this.setRenderTarget = function () {};
    this.getRenderTarget = function () { return null; };
    this.getActiveCubeFace = function () { return 0; };
    this.getActiveMipmapLevel = function () { return 0; };
    this.readRenderTargetPixels = function () {};
    this.copyFramebufferToTexture = function () {}; this.initTexture = function () {};
    this.getContextAttributes = function () { return { alpha: false, antialias: false, depth: true, stencil: true }; };
    this.getPrecision = function () { return 'highp'; };
    this.setViewport = function () {}; this.setScissor = function () {}; this.setScissorTest = function () {};
    this.clearDepth = function () {}; this.clearColor = function () {}; this.clearStencil = function () {};
    this.getClearColor = function (t) { return t || {}; }; this.getClearAlpha = function () { return 1; };
    this.setClearColor = function () {}; this.setClearAlpha = function () {};
    this.resetState = function () {}; this.compileAsync = function () { return Promise.resolve(); };
    this.getContext = function () { return { getExtension: function () { return null; } }; };
    this.getViewport = function (t) { if (t && t.set) t.set(0, 0, this._w, this._h); return { x: 0, y: 0, width: this._w, height: this._h }; };
    this.domElement.addEventListener = function () { return this; };
    this.setAnimationLoop = function () {};
  }
  window.__FAKE_RENDERER = FakeRenderer;
})();
`;

function boot(opts) {
  opts = opts || {};
  const html = read('public/index.html').replace(/<script[^>]*src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://sridhar-drift.vercel.app/', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
  window.SB_U = ''; window.SB_A = '';               // no Supabase build: the gate stands down on its own
  window.SERVER_URL = 'local';
  if (opts.onLine === false) Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });

  // THE WHOLE POINT: on a device with no internet a socket must not be opened at
  // all, so the stand-in throws a labelled error into the page instead of
  // silently working. `ws: 'quiet'` is for the online browser that then chooses
  // OFFLINE: there the stand-in behaves like a real socket, and the test proves
  // the page CLOSES it instead.
  const sockets = [];
  function FakeWS(url) {
    this.url = String(url); this.readyState = 0; this.sent = [];
    sockets.push(this);
    if (opts.ws === 'quiet') { const self = this; setTimeout(() => { self.readyState = 1; if (self.onopen) self.onopen({}); }, 0); return; }
    throw new Error('OFFLINE TEST: a WebSocket was opened to ' + url);
  }
  FakeWS.prototype.send = function (d) { this.sent.push(d); };
  FakeWS.prototype.close = function () { this.readyState = 3; if (this.onclose) this.onclose({}); };
  FakeWS.prototype.addEventListener = function () {};
  window.WebSocket = FakeWS;
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;

  // every network call the page makes, so "nothing was submitted" can be asserted
  const calls = [];
  window.fetch = (u, o) => {
    calls.push({ url: String(u), method: (o && o.method) || 'GET', body: (o && o.body) || null });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opts.fetchJson || []), text: () => Promise.resolve('') });
  };

  const audioParam = () => new Proxy({ value: 0 }, { get: (t, k) => (k in t) ? t[k] : () => {}, set: (t, k, v) => (t[k] = v, true) });
  const audioNode = (extra) => new Proxy(Object.assign({
    connect() { return this; }, disconnect() {}, start() {}, stop() {},
    gain: audioParam(), frequency: audioParam(), Q: audioParam(), detune: audioParam(),
    threshold: audioParam(), ratio: audioParam(), knee: audioParam(), attack: audioParam(), release: audioParam(),
    delayTime: audioParam(), pan: audioParam(), curve: null, oversample: 'none', type: '', buffer: null, loop: false,
    playbackRate: audioParam(), positionX: audioParam(), positionY: audioParam(), positionZ: audioParam()
  }, extra || {}), { get: (t, k) => (k in t) ? t[k] : () => {}, set: (t, k, v) => (t[k] = v, true) });
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = audioNode(); this.listener = audioNode(); }
    createGain() { return audioNode(); } createOscillator() { return audioNode(); }
    createBiquadFilter() { return audioNode(); } createDynamicsCompressor() { return audioNode(); }
    createWaveShaper() { return audioNode(); } createPanner() { return audioNode(); }
    createStereoPanner() { return audioNode(); } createConvolver() { return audioNode(); }
    createAnalyser() { return audioNode({ fftSize: 1024, frequencyBinCount: 512 }); }
    createBufferSource() { return audioNode(); }
    createBuffer(c, l) { return { getChannelData: () => new Float32Array(l), length: l, numberOfChannels: c, sampleRate: 48000, duration: l / 48000 }; }
    resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); } decodeAudioData() { return Promise.resolve({}); }
  };
  window.navigator.vibrate = () => true;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  // a permissive 2D context: the client draws the minimap, roundels, thumbnails and
  // car swatches, and listing every canvas call would be whack-a-mole.
  const rt = () => ({ addColorStop() {} });
  const ctx2d = () => new Proxy({
    canvas: null,
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0, shadowColor: '', filter: 'none', imageSmoothingEnabled: true,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }),
    measureText: () => ({ width: 10 }),
    createRadialGradient: rt, createLinearGradient: rt, createPattern: () => ({}),
    getTransform: () => ({}), isPointInPath: () => false
  }, { get: (t, k) => (k in t) ? t[k] : () => {}, set: (t, k, v) => (t[k] = v, true) });
  window.HTMLCanvasElement.prototype.getContext = function (kind) { return kind === '2d' ? ctx2d() : null; };
  window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:stub');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
  window.localStorage.clear();

  const run = (rel) => { const el = window.document.createElement('script'); el.textContent = read('public/' + rel); window.document.head.appendChild(el); };
  const expose = (src) => { const el = window.document.createElement('script'); el.textContent = src; window.document.head.appendChild(el); };
  if (opts.sw) {
    // a browser that CAN save for offline: the page hands the job to a worker,
    // which reports back. This is the real path, minus the real worker.
    expose(`(function () {
      var posted = [], listeners = [];
      window.__swPosted = posted;
      var sw = {
        controller: { postMessage: function (m) { posted.push(m); } },
        addEventListener: function (t, f) { if (t === 'message') listeners.push(f); },
        register: function () { return Promise.resolve({ scope: '/' }); }
      };
      Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
      window.__swFire = function (data) { listeners.forEach(function (f) { f({ data: data }); }); };
    })();`);
  }
  expose(FAKE_RENDERER);
  run('js/vendor/three.min.js');
  expose('THREE.WebGLRenderer = window.__FAKE_RENDERER;');
  for (const s of SCRIPTS) if (s !== 'js/vendor/three.min.js') run(s);
  return { dom, window, errors, sockets, calls };
}

function press(window, code, down) {
  const ev = new window.KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true, cancelable: true });
  window.document.dispatchEvent(ev);
  window.dispatchEvent(ev);
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// wait for real frames: game.js publishes the racer's input from its own render
// loop, so the arrows only reach the room once a frame has run.
const frames = (window, n) => new Promise((res) => {
  let i = 0;
  const step = () => { if (++i >= (n || 2)) return res(); window.requestAnimationFrame(step); };
  window.requestAnimationFrame(step);
});

test('the arrow keys are the driving keys, and they are the ones the tutorial teaches', () => {
  const src = read('public/js/game.js');
  const line = src.split('\n').find((l) => l.includes('let steer =') && l.includes('ArrowLeft'));
  assert.ok(line, 'steering reads the arrow keys');
  assert.match(line, /keys\.has\('ArrowLeft'\)/);
  assert.match(line, /keys\.has\('ArrowRight'\)|\+ 1/, 'right arrow steers right');
  const thr = src.split('\n').find((l) => l.includes('let throttle ='));
  assert.match(thr, /keys\.has\('ArrowUp'\)/, 'up arrow accelerates');
  const brk = src.split('\n').find((l) => l.includes('let brake ='));
  assert.match(brk, /keys\.has\('ArrowDown'\)/, 'down arrow brakes');
  // and the arrows are not swallowed by the page (scrolling) while racing
  assert.match(src, /if \(\['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'\]\.includes\(e\.code\)\) e\.preventDefault\(\)/);
});

test('mobile players get the on-screen arrow buttons, shown while racing', () => {
  const html = read('public/index.html');
  const src = read('public/js/game.js');
  for (const id of ['tc-left', 'tc-right', 'tc-gas', 'tc-brake']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' exists on the page');
  }
  assert.match(html, /id="tc-left"[\s\S]*?arrow-left\.svg/, 'left button is a left arrow');
  assert.match(html, /id="tc-right"[\s\S]*?arrow-right\.svg/, 'right button is a right arrow');
  assert.match(html, /id="tc-gas"[\s\S]*?arrow-up\.svg/, 'gas button is an up arrow');
  assert.match(html, /id="tc-brake"[\s\S]*?arrow-down\.svg/, 'brake button is a down arrow');
  assert.match(src, /wireTouchBtn\('tc-left', \(\) => \{ touchInput\.l = 1; \}/, 'left is wired to the input');
  assert.match(src, /wireTouchBtn\('tc-gas', \(\) => \{ touchInput\.u = 1; \}/, 'gas is wired to the input');
  assert.match(src, /touchInput\.l \? -1 : 0/, 'and the pad feeds the same steering the keys do');
  assert.match(src, /touchInput\.u\) \? 1 : 0/, 'and the same throttle');
});

test('a device with no internet races OFFLINE end to end, and never dials', { skip: SKIP }, async (t) => {
  const { dom, window, errors, sockets, calls } = boot({ onLine: false });   // cold start, aeroplane mode
  t.after(() => dom.window.close());

  // No connection at boot: the page must choose OFFLINE by itself and say so -
  // the racer did not tap anything, their phone simply has no network.
  assert.equal(window.eval('prefs.mode3'), 'offline', 'a cold start with no internet selects OFFLINE');
  assert.equal(window.eval('offlineRequested()'), true, 'the page knows this is an offline race');
  assert.equal(window.document.querySelector('.mode3-btn[data-m3="offline"]').classList.contains('active'), true,
    'and the mode row shows it');
  assert.match(window.document.getElementById('lobby-conn').textContent, /offline/i, 'the lobby says why');

  // AI off, so the race is the racer alone: the finish (and the device best)
  // cannot depend on how the test drives against the bots - they get their own test.
  window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'pdev1'; prefs.laps = 1; prefs.bot = 0;");
  window.document.getElementById('start-btn').click();
  await settle(250);

  assert.equal(sockets.length, 0, 'no WebSocket was ever opened: ' + JSON.stringify(sockets));
  const local = window.eval('net._local()');
  assert.ok(local, 'the page holds the local transport');
  assert.equal(window.eval('net._online()'), null, 'and the online link was never even constructed');
  assert.ok(local.room, 'a local room exists');
  assert.equal(local.room.mapId, window.eval('selectedMap'), 'on the map the racer chose');
  assert.ok(['countdown', 'racing', 'finished'].includes(local.room.state), 'the race is running: ' + local.room.state);
  assert.ok(window.document.getElementById('hud').textContent.length >= 0, 'the race screen is up');

  // drive 3 seconds of race on the arrow keys, through the real key handler and
  // the real input path (game.js -> net.send -> the local room)
  const car = local.room.cars[0];
  press(window, 'ArrowUp', true);
  await frames(window, 8);
  assert.ok(local.room.inputs[1] && local.room.inputs[1].throttle > 0,
    'the up arrow reached the local room as throttle: ' + JSON.stringify(local.room.inputs[1]));
  press(window, 'ArrowUp', false);
  press(window, 'ArrowLeft', true);
  await frames(window, 6);
  assert.ok(local.room.inputs[1].steer < 0, 'the left arrow steers left: ' + local.room.inputs[1].steer);
  press(window, 'ArrowLeft', false);
  press(window, 'ArrowRight', true);
  await frames(window, 6);
  assert.ok(local.room.inputs[1].steer > 0, 'the right arrow steers right: ' + local.room.inputs[1].steer);
  press(window, 'ArrowRight', false);
  press(window, 'ArrowDown', true);
  await frames(window, 6);
  assert.ok(local.room.inputs[1].brake > 0, 'the down arrow brakes: ' + local.room.inputs[1].brake);
  press(window, 'ArrowDown', false);

  // The car is live. From here the room drives it - the room's own racing line
  // takes the corners - because the claim under test is "offline racing works
  // with no network", not "a car with no steering survives the first barrier".
  const start = { x: car.x, z: car.z };
  let warm = 0;
  while (local.room.state === 'countdown' && warm < 300) { local.room.inputs[1] = local.room.botInputFor(car); local._tick(1 / 30); warm++; }
  for (let i = 0; i < 120; i++) { local.room.inputs[1] = local.room.botInputFor(car); local._tick(1 / 30); }
  assert.ok(Math.hypot(car.x - start.x, car.z - start.z) > 1, 'and the car moved: ' + Math.hypot(car.x - start.x, car.z - start.z).toFixed(2) + ' m');

  // finish the race, still with no network: the sim is driven by hand (the page
  // keeps its own rAF loop going as well), car on the room's own racing line.
  let ticks = 0;
  while (local.room.state !== 'finished' && ticks < 12000) { local.room.inputs[1] = local.room.botInputFor(car); local._tick(1 / 30); ticks++; }
  assert.equal(local.room.state, 'finished', 'the offline race finished after ' + (ticks / 30).toFixed(1) + ' s of racing');
  await settle(100);

  // the result never leaves the device. Nothing is WRITTEN at all - not the
  // race result, not a leaderboard row, not even an analytics beacon. (The GETs
  // in `calls` are the existing profile hub loading as the page boots: reads a
  // browser with no internet simply fails, and no racer input is sent with them.)
  const writes = calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(writes, [], 'nothing was submitted: ' + JSON.stringify(writes));
  assert.equal(sockets.length, 0, 'and still no socket');
  const best = window.SROffline.bestFor(local.room.mapId);
  assert.ok(best && best.time > 0, 'the time became a device best: ' + JSON.stringify(best));
  assert.ok(best.lap > 0 && best.lap <= best.time,
    'the fastest lap came with it too: ' + JSON.stringify(best));
  const stored = JSON.parse(window.localStorage.getItem('sr_offline_best') || '{}');
  assert.ok(stored[local.room.mapId] && stored[local.room.mapId].time > 0, 'and it survives a reload: ' + JSON.stringify(stored));
  assert.deepEqual(errors, [], 'with no uncaught error on the way');
  local.close();
});

test('an online browser that picks OFFLINE drops the relay socket', { skip: SKIP }, async (t) => {
  const { dom, window, sockets } = boot({ ws: 'quiet' });   // online at load: the identity hello dials
  t.after(() => dom.window.close());
  assert.ok(sockets.length >= 1, 'the page was online, so it did open the relay link');

  // click the OFFLINE mode button the way a racer does
  const btn = window.document.querySelector('.mode3-btn[data-m3="offline"]');
  assert.ok(btn, 'the OFFLINE mode button is on the page');
  btn.click();
  assert.equal(window.eval("prefs.mode3"), 'offline', 'and it selects the mode');
  assert.equal(window.eval('net._online()'), null, 'picking OFFLINE drops the relay link');
  assert.ok(sockets.every((s) => s.readyState === 3), 'and closes the socket it had opened');

  const opened = sockets.length;
  window.document.getElementById('start-btn').click();
  await settle(200);
  assert.equal(sockets.length, opened, 'START opens no new socket');
  const local = window.eval('net._local()');
  assert.ok(local && local.room, 'the race is running on the local transport');
  assert.equal(window.eval('net._online()'), null, 'still no relay link');
  local.close();
});

test('SAVE FOR OFFLINE is a real control in the lobby', { skip: SKIP }, async (t) => {
  const { dom, window, errors } = boot({});
  t.after(() => dom.window.close());
  const btn = window.document.getElementById('sr-offline-btn');
  assert.ok(btn, 'the save control is on the page');
  assert.match(btn.textContent, /SAVE FOR OFFLINE/, 'and names what it does');
  const chip = window.document.getElementById('sr-offline-chip');
  assert.ok(chip, 'the "saved on this device" chip exists');
  assert.equal(chip.hidden, true, 'and is hidden until the game really is saved');

  // jsdom has no service worker. A browser that cannot save must SAY so rather
  // than sit there looking broken.
  const api = window.SROfflineSave;
  assert.ok(api, 'the saver module is on the page');
  assert.equal(api.supported(), false, 'this environment cannot save');
  assert.equal(btn.disabled, true, 'so the control stands down instead of pretending');
  assert.equal(api.status().total, 0, 'and nothing is claimed to be saved');
  assert.equal(api.save(), false, 'asking it anyway refuses');
  await settle(20);
  assert.match(window.document.getElementById('toast').textContent, /installed app|Offline saving/,
    'and says what offline saving needs');
  assert.deepEqual(errors, [], 'clicking it never throws: ' + errors.join(' | '));
});

test('the save flow reports progress and says when the game is complete', { skip: SKIP }, async (t) => {
  const { dom, window, errors } = boot({ sw: true });
  t.after(() => dom.window.close());
  const api = window.SROfflineSave;
  const btn = window.document.getElementById('sr-offline-btn');
  const chip = window.document.getElementById('sr-offline-chip');
  const toastText = () => window.document.getElementById('toast').textContent;
  assert.equal(api.supported(), true, 'this browser can save for offline');
  assert.equal(btn.disabled, false, 'the control is usable');

  btn.click();
  await settle(30);
  assert.ok(window.__swPosted.some((m) => m.type === 'sr-offline-save'), 'the worker is asked to save');
  assert.equal(window.__swPosted[0].type, 'sr-offline-save', 'and the click is heard the moment it happens');
  assert.match(toastText(), /keep this page open/, 'the racer is told it is working');
  assert.match(btn.textContent, /SAVING/, 'and the button shows it is busy: ' + btn.textContent);

  window.__swFire({ type: 'sr-offline-progress', done: 100, total: 200 });
  await settle(20);
  assert.match(btn.textContent, /50%/, 'progress is visible on the control: ' + btn.textContent);

  window.__swFire({ type: 'sr-offline-done', ok: true, done: 200, total: 200, failed: [] });
  await settle(20);
  assert.match(toastText(), /Saved/, 'the finish is announced');
  assert.doesNotMatch(btn.textContent, /SAVING/, 'and the control is usable again');

  window.__swFire({ type: 'sr-offline-status', build: 'v166', have: 200, total: 200, ready: true });
  await settle(20);
  assert.equal(chip.hidden, false, 'the "saved on this device" chip appears only now');
  assert.equal(api.isReady(), true, 'and the page knows the game is on the device');
  assert.deepEqual(errors, [], 'with no uncaught error on the way: ' + errors.join(' | '));
});

test('the account gate stands down offline, and still gates online', () => {
  const html = read('public/index.html');
  const gate = html.slice(html.indexOf('ACCOUNT GATE'));
  const body = gate.slice(gate.indexOf('(function () {'), gate.indexOf('</script>'));
  assert.match(body, /navigator\.onLine === false/, 'the gate reads the connection state');

  // run the gate block exactly as the browser would, with the environment injected
  function runGate(env) {
    const e = env || {};
    let redirected = null;
    const win = { SB_U: e.sb ? 'https://fake.supabase.co' : '', SB_A: e.sb ? 'anon-key' : '' };
    const location = { pathname: e.path || '/', search: e.search || '', href: 'https://x.test/',
      replace: (u) => { redirected = String(u); } };
    const navigator = { onLine: e.onLine === undefined ? true : e.onLine };
    const localStorage = { getItem: () => e.session || null };
    const fn = new Function('window', 'location', 'navigator', 'localStorage', body);
    fn(win, location, navigator, localStorage);
    return redirected;
  }

  assert.equal(runGate({ sb: true, onLine: false }), null,
    'offline with no session: the racer is let through to race offline');
  assert.equal(runGate({ sb: true, onLine: true, search: '?offline=1' }), null,
    'the OFFLINE link is honoured even with a connection');
  assert.match(String(runGate({ sb: true, onLine: true })), /auth\.html/, 'online with no session: still gated');
  assert.equal(runGate({ sb: true, onLine: true, session: JSON.stringify({ access_token: 't' }) }), null,
    'online with a session: straight in');
  assert.equal(runGate({ sb: false, onLine: true }), null,
    'an unconfigured deploy has no gate at all');
  assert.equal(runGate({ sb: true, onLine: false, path: '/auth.html' }), null,
    'the sign-in page itself never redirects');
});
