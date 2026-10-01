'use strict';
/* ============================================================================
   v158.7/v158.8 — the club buttons, clicked in a real DOM.

   Everything else in this suite reads source. This one RUNS the page: the real
   index.html, the real script order, the real inline `onclick` handlers of the
   club modal, with only `fetch` stubbed (the API is the server's business and is
   covered by its own tests). It exists because "when I click JOIN CLUB I cannot
   join the club" is a claim about a CLICK, and the only honest way to answer it
   is to click the button the racer clicks and read the screen back.

   It pins:
     1. the JOIN CLUB tab renders the board, and the board's JOIN [TAG] button
        posts the racer's identity and the club to /api/player/crew/join;
     2. the toast names the club that was joined - and names the REASON for every
        failure, including a write the server refused to store;
     3. the MY CLUB tab shows the club the join answered with;
     4. DELETE THIS CLUB appears only for the leader, asks first, and posts.
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
  const calls = [];
  window.fetch = (u, o) => {
    const url = String(u), opt = o || {};
    calls.push({ url, method: opt.method || 'GET', body: opt.body, headers: opt.headers });
    const answer = opts.fetchStub ? opts.fetchStub(url, opt) : null;
    if (answer) return Promise.resolve({ ok: answer.status < 400, status: answer.status, json: () => (answer.throwJson ? Promise.reject(new Error('not json')) : Promise.resolve(answer.json)), text: () => Promise.resolve(answer.text || '') });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ build: 'v159', tickmap: 0 }), text: () => Promise.resolve('') });
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

const CLUB = { id: 'bhai', tag: 'BHAI', name: 'B.Tech Badithulu', motto: 'Push past', badge: 'bolt', color: '#ff3344', memberCount: 2, weeklyKm: 12, leaderName: 'SRIDHAR' };
const MINE = (leader) => ({
  ok: true, hasCrew: true,
  crew: {
    id: CLUB.id, tag: CLUB.tag, name: CLUB.name, motto: CLUB.motto, badge: CLUB.badge, color: CLUB.color,
    leaderUid: 'SRIDHAR', isLeader: !!leader, weeklyMeters: 12000, weeklyKm: 12, totalMeters: 30000, totalKm: 30,
    weeklyPoints: 5, weekKey: '2026-W40', resetsIn: '3d 6h', currentTier: 1, progressPct: 20, nextMilestone: 20000,
    milestones: [{ tier: 1, reqKm: 5, reward: { xp: 50, coins: 25 }, completed: true, claimed: false, canClaim: true }],
    members: [
      { uid: 'SRIDHAR', name: 'SRIDHAR', role: leader ? 'leader' : 'member', weeklyMeters: 9000, totalMeters: 20000, weeklyPoints: 3 },
      { uid: 'MATE', name: 'MATE', role: 'member', weeklyMeters: 3000, totalMeters: 10000, weeklyPoints: 2 }
    ]
  },
  presets: []
});

function boardStub(joinAnswer, opts) {
  opts = opts || {};
  return (url, request) => {
    const u = String(url);
    if (u.includes('/api/player/crew/join')) return joinAnswer;
    if (u.includes('/api/player/crew/delete')) return opts.deleteAnswer || { status: 200, json: { ok: true, crewId: CLUB.id, tag: CLUB.tag, name: CLUB.name, members: 2, durable: true, stored: true } };
    if (u.includes('/api/crews/')) return { status: 200, json: { ok: true, crew: MINE(opts.leader).crew } };
    if (u.includes('/api/crews')) return { status: 200, json: { ok: true, crews: [CLUB] } };
    if (u.includes('/api/player/crew')) return { status: 200, json: opts.hasCrew ? MINE(opts.leader) : { ok: true, hasCrew: false, crew: null, presets: [] } };
    return { status: 200, json: [] };
  };
}

function clickTab(window, tab) {
  const btn = window.document.getElementById('ctab-' + tab);
  assert.ok(btn, 'the ' + tab.toUpperCase() + ' tab exists in the page');
  btn.click();
}

function joinButton(window) {
  const body = window.document.getElementById('crew-body');
  return Array.from(body.querySelectorAll('button')).find((b) => /JOIN \[/.test(b.textContent));
}

const toast = (window) => window.document.getElementById('toast').textContent;

async function openJoinTab(window) {
  clickTab(window, 'join');
  await settle(60);
  return joinButton(window);
}

test('v159: CLUBS opens the club dialog on a fresh page, before any room snapshot', { skip: SKIP }, async (t) => {
  // THE BUG THIS PINS. Every club control is wired inside wireLobbyV2(), and the
  // only call to it was at the END of updateLobby() - i.e. after the first room
  // snapshot, and after ~50 DOM operations that can throw on the way there. A
  // visitor who had not entered a room (or whose lobby render threw before the
  // last line) had a CLUBS button with no click handler: clicking it did nothing
  // at all, which is reported as "I click JOIN CLUB and I cannot join a club".
  const { window, dom, errors } = boot({ fetchStub: boardStub({ status: 200, json: { ok: false, error: 'not_leader' } }) });
  t.after(() => dom.window.close());
  window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'p-abc123';");

  const btn = window.document.getElementById('crew-btn');
  assert.ok(btn, 'the CLUBS button is on the page');
  btn.click();
  await settle(80);
  const dlg = window.document.getElementById('crew-dlg');
  assert.equal(dlg.hidden, false, 'clicking CLUBS opens the dialog before any snapshot');
  assert.ok(window.document.getElementById('crew-body').textContent.length > 0, 'and it renders something');

  clickTab(window, 'join');
  await settle(80);
  assert.ok(joinButton(window), 'and the JOIN CLUB tab lists clubs to join');
  assert.deepEqual(errors, [], 'with no uncaught error on the way');
});

test('v158.7: clicking JOIN CLUB and then JOIN [TAG] joins the club, and says so', { skip: SKIP }, async (t) => {
  let joined = false;
  const { window, dom, calls } = boot({ fetchStub: (url) => {
    const u = String(url);
    if (u.includes('/api/player/crew/join')) { joined = true; return { status: 200, json: { ok: true, crewId: CLUB.id, tag: CLUB.tag, name: CLUB.name, member: { uid: 'SRIDHAR' }, durable: true, stored: true, pending: false } }; }
    if (u.includes('/api/player/crew')) return { status: 200, json: joined ? MINE(false) : { ok: true, hasCrew: false, crew: null, presets: [] } };
    if (u.includes('/api/crews')) return { status: 200, json: { ok: true, crews: [CLUB] } };
    return { status: 200, json: [] };
  } });
  t.after(() => dom.window.close());
  window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'p-abc123';");

  const btn = await openJoinTab(window);
  assert.ok(btn, 'the board renders a JOIN [TAG] button');
  assert.match(btn.textContent, /JOIN \[BHAI\]/, 'and it names the club tag');

  btn.click();
  await settle(120);
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/player/crew/join'));
  assert.ok(post, 'the click really posts to the join endpoint');
  const body = JSON.parse(post.body);
  assert.equal(body.crewId, 'bhai', 'with the club that was clicked');
  assert.equal(body.uid, 'p-abc123', 'and the racer identity the client owns (the device pid for a guest)');
  assert.equal(body.pid, 'p-abc123');
  assert.equal(body.name, 'SRIDHAR');
  assert.equal(toast(window), '🏁 Joined [BHAI] B.Tech Badithulu!', 'the toast names the club that was joined');

  const bodyEl = window.document.getElementById('crew-body');
  assert.match(bodyEl.textContent, /B\.Tech Badithulu/, 'and the club is on screen right after');
  assert.match(bodyEl.textContent, /CREW ROSTER|RACERS/, 'with its roster');
  assert.ok(window.document.getElementById('ctab-my').classList.contains('active'), 'the MY CLUB tab is the one shown');
});

test('v158.7: every refusal reaches the screen in words', { skip: SKIP }, async (t) => {
  const cases = [
    [{ status: 404, json: { ok: false, error: 'crew_not_found' } }, /no longer around/i],
    [{ status: 403, json: { ok: false, error: 'racer_erased' } }, /deleted[^]*?(reload|sign out)/i],
    [{ status: 400, json: { ok: false, error: 'invalid_uid' } }, /racer name was not sent/i],
    [{ status: 200, json: { ok: true, tag: 'BHAI', name: 'B.Tech Badithulu', durable: true, stored: false, pending: false, member: {} } }, /could not save you/i]
  ];
  for (const [answer, want] of cases) {
    const { window, dom } = boot({ fetchStub: boardStub(answer) });
    t.after(() => dom.window.close());
    window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'p-abc123';");
    const btn = await openJoinTab(window);
    btn.click();
    await settle(120);
    const said = toast(window);
    assert.match(said, want, 'the refusal is on screen in words: ' + said);
    assert.ok(!/Failed to join crew/.test(said), 'and never the sentence that hid all of these');
  }
});

test('v160: a deleted device racer is re-minted, and the browser adopts the new identity', { skip: SKIP }, async (t) => {
  // The join endpoint answers reset:true + newPid when the browser's stored device
  // key is the one a purge erased. If the client did not adopt it, the very next
  // request would arrive as the erased racer again and nothing would stick.
  const NEW_PID = 'pnewdevice99';
  let joined = false;
  const { window, dom, calls } = boot({ fetchStub: (url) => {
    const u = String(url);
    if (u.includes('/api/player/crew/join')) {
      joined = true;
      return { status: 200, json: { ok: true, crewId: CLUB.id, tag: CLUB.tag, name: CLUB.name, member: { uid: NEW_PID }, durable: true, stored: true, pending: false, newPid: NEW_PID, reset: true } };
    }
    if (u.includes('/api/player/crew')) return { status: 200, json: joined ? MINE(false) : { ok: true, hasCrew: false, crew: null, presets: [] } };
    if (u.includes('/api/crews/')) return { status: 200, json: { ok: true, crew: MINE(false).crew } };
    if (u.includes('/api/crews')) return { status: 200, json: { ok: true, crews: [CLUB] } };
    return { status: 200, json: [] };
  } });
  t.after(() => dom.window.close());
  window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'polddevice1';");

  const btn = await openJoinTab(window);
  btn.click();
  await settle(150);
  assert.equal(window.eval('prefs.pid'), NEW_PID, 'the new device identity is adopted');
  const stored = JSON.parse(window.localStorage.getItem('sr_prefs') || '{}');
  assert.equal(stored.pid, NEW_PID, 'and persisted, or a reload would present the erased one again');
  const read = calls.filter((c) => c.url.includes('/api/player/crew?')).pop();
  assert.ok(read && read.url.includes('pid=' + NEW_PID), 'the next request carries the new identity: ' + (read && read.url));
  assert.ok(!/polddevice1/.test(read ? read.url : ''), 'and never the erased one');
  assert.match(toast(window), /starts? fresh|old racer was deleted/i, 'and the racer is told their old racer is gone');
});

test('v163: a server that is not answering still says so - a click never ends in silence', { skip: SKIP }, async (t) => {
  // A cold Render instance answers 502 with an HTML body, so r.json() rejects and
  // the old catch said "check your connection" - a wrong answer to the wrong
  // question, and "nothing happened" is what "I cannot join the club" looks like.
  const { window, dom } = boot({ fetchStub: (url) => {
    const u = String(url);
    if (u.includes('/api/player/crew/join')) return { status: 502, throwJson: true, text: '<html>502 Bad Gateway</html>' };
    if (u.includes('/api/player/crew')) return { status: 200, json: { ok: true, hasCrew: false, crew: null, presets: [] } };
    if (u.includes('/api/crews/')) return { status: 200, json: { ok: true, crew: MINE(false).crew } };
    if (u.includes('/api/crews')) return { status: 200, json: { ok: true, crews: [CLUB] } };
    return { status: 200, json: [] };
  } });
  t.after(() => dom.window.close());
  window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'pdev1';");
  const btn = await openJoinTab(window);
  btn.click();
  await settle(200);
  assert.match(toast(window), /502|waking up|HTTP/i, 'the status is said out loud: ' + toast(window));
  assert.ok(!/check your connection/i.test(toast(window)), "and a wake-up is not blamed on the racer's connection");
  // ...and the tab keeps it after the toast has faded, because "I clicked and I
  // cannot join" is not reportable if the only trace disappears in four seconds.
  const note = dom.window.document.getElementById('crew-join-status');
  assert.ok(note && /502|waking up/i.test(note.textContent), 'the join tab keeps the reason: ' + (note && note.textContent));
});

test('v163: a refused join is written on the join tab, not only in a toast', { skip: SKIP }, async (t) => {
  const { window, dom } = boot({ fetchStub: (url) => {
    const u = String(url);
    if (u.includes('/api/player/crew/join')) return { status: 403, json: { ok: false, error: 'racer_erased' } };
    if (u.includes('/api/player/crew')) return { status: 200, json: { ok: true, hasCrew: false, crew: null, presets: [] } };
    if (u.includes('/api/crews/')) return { status: 200, json: { ok: true, crew: MINE(false).crew } };
    if (u.includes('/api/crews')) return { status: 200, json: { ok: true, crews: [CLUB] } };
    return { status: 200, json: [] };
  } });
  t.after(() => dom.window.close());
  window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'pdev1';");
  const btn = await openJoinTab(window);
  btn.click();
  await settle(200);
  const note = dom.window.document.getElementById('crew-join-status');
  assert.ok(note, 'the join tab carries a status line');
  assert.match(note.textContent, /deleted|sign out|reload/i, 'naming the refusal: ' + note.textContent);
  // and it survives closing and reopening the dialog
  window.eval("openCrewModal('join')");
  await settle(120);
  const again = dom.window.document.getElementById('crew-join-status');
  assert.ok(again && /deleted|sign out|reload/i.test(again.textContent), 'it is still there when the dialog is reopened');
});

test('v163: a join that lands is written on the tab too', { skip: SKIP }, async (t) => {
  const { window, dom } = boot({ fetchStub: (url) => {
    const u = String(url);
    if (u.includes('/api/player/crew/join')) return { status: 200, json: { ok: true, crewId: CLUB.id, tag: CLUB.tag, name: CLUB.name, member: { uid: 'pdev1' }, durable: true, stored: true, pending: false } };
    if (u.includes('/api/player/crew')) return { status: 200, json: MINE(false) };
    if (u.includes('/api/crews/')) return { status: 200, json: { ok: true, crew: MINE(false).crew } };
    if (u.includes('/api/crews')) return { status: 200, json: { ok: true, crews: [CLUB] } };
    return { status: 200, json: [] };
  } });
  t.after(() => dom.window.close());
  window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'pdev1';");
  const btn = await openJoinTab(window);
  btn.click();
  await settle(200);
  window.eval("prefs.name = 'SRIDHAR';");
  window.eval("openCrewModal('join')");
  await settle(120);
  const note = dom.window.document.getElementById('crew-join-status');
  assert.ok(note && /joined \[BHAI\] as SRIDHAR/i.test(note.textContent), 'the tab says which club took them: ' + (note && note.textContent));
});

test('v163: join, create and delete all read their answer through the one reader', { skip: SKIP }, async () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game.js'), 'utf8');
  assert.match(src, /async function clubJson\(/, 'there is one reader');
  assert.match(src, /function clubHttpText\(/, 'and one way to say what an HTTP status means');
  const posts = src.match(/clubJson\(`\$\{httpBase\(\)\}\/api\/player\/crew\/(join|create|delete)`/g) || [];
  assert.equal(posts.length, 3, 'every club POST goes through it: ' + posts.length);
  assert.ok(!/\.then\(r => r\.json\(\)\)[\s\S]{0,400}?Joined \[/.test(src),
    'no club POST answer is still read with a bare .json()');
});

test('v163: a deleted account is signed out and the same click still joins as a guest', { skip: SKIP }, async (t) => {
  // "Sign out and sign up again" is not advice a racer can act on while the dead
  // session is still in the browser - and signing in again returns the same
  // account id, so the refusal repeats for ever. The server has already asked
  // Supabase whether that account exists; a racer_erased answer means it does not,
  // so the client clears the dead session and joins as a guest in the same click.
  const bodies = [];
  const { window, dom } = boot({ fetchStub: (url, opt) => {
    const u = String(url);
    if (u.includes('/api/player/crew/join')) {
      bodies.push(JSON.parse((opt && opt.body) || '{}'));
      if (bodies.length === 1) return { status: 403, json: { ok: false, error: 'racer_erased' } };
      return { status: 200, json: { ok: true, crewId: CLUB.id, tag: CLUB.tag, name: CLUB.name, member: { uid: 'pdev1' }, durable: true, stored: true, pending: false } };
    }
    if (u.includes('/api/player/crew')) return { status: 200, json: MINE(false) };
    if (u.includes('/api/crews/')) return { status: 200, json: { ok: true, crew: MINE(false).crew } };
    if (u.includes('/api/crews')) return { status: 200, json: { ok: true, crews: [CLUB] } };
    return { status: 200, json: [] };
  } });
  t.after(() => dom.window.close());
  // a signed-in browser, as the real page has once a session exists
  window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'pdev1'; window.__ses = true;"
    + " window.SRAccount = { available: () => true, loggedIn: () => window.__ses,"
    + " uid: () => window.__ses ? '22222222-2222-4222-8222-222222222222' : null,"
    + " name: () => 'SRIDHAR', logout: () => { window.__ses = false; window.__loggedOut = true; } };");

  const btn = await openJoinTab(window);
  btn.click();
  await settle(300);
  assert.equal(window.eval('window.__loggedOut'), true, 'the dead session was cleared');
  assert.equal(bodies.length, 2, 'and the join was tried again in the same click');
  assert.equal(bodies[0].sbUid, '22222222-2222-4222-8222-222222222222', 'the first attempt was the account');
  assert.equal(bodies[1].sbUid, '', 'the second is a guest');
  assert.equal(bodies[1].pid, 'pdev1', 'with the device identity');
  // the success path switches to MY CLUB (the roster they just joined), so the
  // note lives on the join tab: reopen it and it is there.
  window.eval("openCrewModal('join')");
  await settle(120);
  const note = dom.window.document.getElementById('crew-join-status');
  assert.ok(note && /joined \[BHAI\]/i.test(note.textContent), 'and the tab says they are in: ' + (note && note.textContent));
  assert.match(note.textContent, /deleted account was signed out/i, 'with the reason they are a guest now');
});

test("v158.8: DELETE THIS CLUB is the leader's button, asks first, and posts", { skip: SKIP }, async (t) => {
  const { window, dom, calls } = boot({ fetchStub: boardStub({ status: 200, json: { ok: true, crewId: CLUB.id, tag: CLUB.tag, name: CLUB.name, members: 2, durable: true, stored: true } }, { leader: true, hasCrew: true }) });
  t.after(() => dom.window.close());
  window.eval("prefs.name = 'SRIDHAR'; prefs.pid = 'p-abc123';");
  clickTab(window, 'my');
  await settle(80);

  const del = window.document.getElementById('crew-delete-btn');
  assert.ok(del, 'the leader sees the delete button');
  assert.match(del.textContent, /DELETE THIS CLUB/);

  let asked = null;
  window.confirm = (q) => { asked = q; return false; };
  del.click();
  await settle(60);
  assert.match(String(asked), /B\.Tech Badithulu/, 'the confirmation names the club');
  assert.match(String(asked), /2 racers will be removed/, 'and what happens to the racers in it');
  assert.match(String(asked), /cannot be undone/i, 'and that it is irreversible');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.url.includes('/api/player/crew/delete')),
    'answering no deletes nothing');

  window.confirm = () => true;
  window.document.getElementById('crew-delete-btn').click();
  await settle(120);
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/player/crew/delete'));
  assert.ok(post, 'answering yes posts the delete');
  assert.equal(JSON.parse(post.body).crewId, 'bhai', 'for the club that was open');
  assert.match(toast(window), /Club \[BHAI\] B\.Tech Badithulu deleted/, 'and the screen says it went');
});

test('v158.8: a plain member is never offered the delete button', { skip: SKIP }, async (t) => {
  const { window, dom } = boot({ fetchStub: boardStub({ status: 200, json: { ok: false, error: 'not_leader' } }, { leader: false, hasCrew: true }) });
  t.after(() => dom.window.close());
  window.eval("prefs.name = 'MATE'; prefs.pid = 'p-mate';");
  clickTab(window, 'my');
  await settle(80);
  assert.equal(window.document.getElementById('crew-delete-btn'), null, 'no button for a member');
});
