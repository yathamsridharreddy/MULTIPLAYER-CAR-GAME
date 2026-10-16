'use strict';
/* ============================================================================
   v178 - THE ACCOUNT NAME ON SCREEN.

   Reported: "the user account name is not visualising correctly - it shows
   something like racer".

   Reproduced with the real client (index.html + the real script order) against a
   fake Supabase REST that answers exactly what account.js asks for. Two different
   bugs were producing one symptom:

     1. THE DEVICE LABEL WAS WRITTEN TO THE ACCOUNT. `prefs.name` starts life as a
        label the browser generated for an anonymous device ("RACER-9F3A"). v144
        treated a profiles read that had NOT ANSWERED (an expired token, an RLS
        refusal, offline) as "this account has no name yet" and pushed that label
        into the account - so the racer's name on every screen became the
        placeholder, and stayed that way after the next page load, on every device.
        Same story for an account with no profile row at all: the label was POSTed.
     2. THE LOBBY CHIP WENT STALE. It was painted at boot and from the account
        dialog only, so renaming yourself left the previous name sitting there.

   Both are pinned here, along with the v144 behaviour that must survive: the
   account's name wins, and a name the racer actually chose still travels to the
   account.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPTS = ['js/vendor/GLTFLoader.js', 'js/car-models.js', 'js/game-core.js', 'js/progression.js',
  'js/config.js', 'js/account.js', 'js/i18n.js', 'js/net.js', 'js/audio.js'];

// one definition of the renderer stub in the repo (boot-smoke's), as the other
// jsdom suites do
const SMOKE = read('test/boot-smoke.test.js');
const MARK = 'const FAKE_RENDERER = `';
const FAKE_RENDERER = SMOKE.slice(SMOKE.indexOf(MARK) + MARK.length, SMOKE.indexOf('`;\n', SMOKE.indexOf(MARK)));

// ---------------------------------------------------------------------------
// boot the real page with a fake Supabase behind it.
//   opts.profile   the profiles row for this account, or null for "no row yet"
//   opts.readFails number of profile reads that answer 401 first ('always' for all)
//   opts.prefs     what this browser already had in sr_prefs (device labels etc.)
// ---------------------------------------------------------------------------
function boot(opts) {
  opts = opts || {};
  let profile = opts.profile === undefined ? { id: 'u1', username: 'SRIDHAR', display_name: 'SRIDHAR R' } : opts.profile;
  const calls = [];       // every request account.js made
  const writes = [];      // profile writes that actually landed
  const created = [];
  let reads = 0;

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
  };
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;

  const audioParam = () => new Proxy({ value: 0 }, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
  const audioNode = (extra) => new Proxy(Object.assign({
    connect() { return this; }, disconnect() {}, start() {}, stop() {}, gain: audioParam(), frequency: audioParam(),
    Q: audioParam(), detune: audioParam(), threshold: audioParam(), ratio: audioParam(), knee: audioParam(),
    attack: audioParam(), release: audioParam(), delayTime: audioParam(), pan: audioParam(), curve: null,
    oversample: 'none', type: '', buffer: null, loop: false, playbackRate: audioParam(),
    positionX: audioParam(), positionY: audioParam(), positionZ: audioParam()
  }, extra || {}), { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = audioNode(); this.listener = audioNode({}); }
    createGain() { return audioNode(); } createOscillator() { return audioNode(); } createBiquadFilter() { return audioNode(); }
    createDynamicsCompressor() { return audioNode(); } createWaveShaper() { return audioNode(); } createPanner() { return audioNode(); }
    createStereoPanner() { return audioNode(); } createConvolver() { return audioNode(); } createAnalyser() { return audioNode({ fftSize: 1024, frequencyBinCount: 512 }); }
    createBufferSource() { return audioNode(); } createBuffer(c, l) { return { getChannelData: () => new Float32Array(l), length: l, numberOfChannels: c, sampleRate: 48000, duration: l / 48000 }; }
    resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); } close() { return Promise.resolve(); } decodeAudioData() { return Promise.resolve({}); }
  };

  const rsp = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') });
  const plain = () => rsp(200, { build: 'v178', tickHz: 30 });
  window.fetch = (u, o) => {
    const url = String(u), opt = o || {}, method = opt.method || 'GET';
    calls.push({ url, method, body: opt.body, headers: opt.headers });
    if (url.includes('/auth/v1/token') || url.includes('/auth/v1/signup')) {
      return rsp(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: 'u1', email: 'sridhar@example.com' } });
    }
    if (url.includes('/rest/v1/profiles')) {
      if (method === 'GET') {
        reads++;
        const fails = opts.readFails === 'always' || (typeof opts.readFails === 'number' && reads <= opts.readFails);
        if (fails) return rsp(401, { message: 'JWT expired' });
        return rsp(200, profile ? [profile] : []);
      }
      if (method === 'PATCH') {
        const body = JSON.parse(opt.body);
        if (!profile) return rsp(200, []);                    // an account with no row yet
        Object.assign(profile, body);
        writes.push(body);
        return rsp(200, [profile]);
      }
      if (method === 'POST') {
        const body = JSON.parse(opt.body);
        created.push(body);
        if (!profile) profile = Object.assign({ id: 'u1' }, body);
        return rsp(201, {});
      }
    }
    return plain();
  };

  window.navigator.vibrate = () => true;
  window.navigator.share = undefined;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  if (!window.HTMLCanvasElement.prototype.getContext) window.HTMLCanvasElement.prototype.getContext = () => null;
  const rt = () => ({ addColorStop() {} });
  const ctx2d = () => new Proxy({
    canvas: null, fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    shadowBlur: 0, shadowColor: '', filter: 'none', imageSmoothingEnabled: true,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }),
    measureText: () => ({ width: 10 }), createRadialGradient: rt, createLinearGradient: rt,
    createPattern: () => ({}), getTransform: () => ({}), isPointInPath: () => false
  }, { get(t, k) { return (k in t) ? t[k] : () => {}; }, set(t, k, v) { t[k] = v; return true; } });
  window.HTMLCanvasElement.prototype.getContext = function (kind) { return kind === '2d' ? ctx2d() : null; };
  window.__frameTicks = 0;
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => realRaf((t) => { window.__frameTicks++; cb(t); });
  window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:stub');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});

  window.localStorage.clear();
  // signed in, but this browser has never seen the racer's name (the exact state
  // the bug appeared in) unless the test says otherwise
  window.localStorage.setItem('sr_sb_session', JSON.stringify({
    access_token: 'AT', refresh_token: 'RT', expires_at: Math.floor(Date.now() / 1000) + 3600,
    uid: 'u1', email: 'sridhar@example.com'
  }));
  if (opts.prefs) window.localStorage.setItem('sr_prefs', JSON.stringify(opts.prefs));

  const run = (rel) => { const el = window.document.createElement('script'); el.textContent = read('public/' + rel); window.document.head.appendChild(el); };
  const expose = (src) => { const el = window.document.createElement('script'); el.textContent = src; window.document.head.appendChild(el); };
  expose(FAKE_RENDERER);
  run('js/vendor/three.min.js');
  expose('THREE.WebGLRenderer = window.__FAKE_RENDERER;');
  for (const s of SCRIPTS) {
    run(s);
    // config.js ships empty keys; this is the deploy's injection, and account.js
    // reads them as it loads
    if (s === 'js/config.js') expose("window.SB_U='https://sb.test';window.SB_A='anon';");
  }
  run('js/game.js');

  const chip = () => window.document.getElementById('account-chip').textContent.trim();
  const field = () => window.document.getElementById('inp-name').value;
  const profileWrites = () => calls.filter((c) => c.url.includes('/rest/v1/profiles') && c.method !== 'GET');
  return { dom, window, errors, calls, writes, created, chip, field, profileWrites, row: () => profile, readCount: () => reads };
}

const SKIP = JSDOM ? false : 'jsdom not installed (npm install --include=dev)';

// ---------------------------------------------------------------------------
// the primitive the fix is built on
// ---------------------------------------------------------------------------
function accountSandbox(opts) {
  const o = opts || {};
  const store = {
    sr_sb_session: JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: Math.floor(Date.now() / 1000) + 3600,
      uid: 'u1', email: 'sridhar@example.com'
    })
  };
  const s = {
    console: { warn() {}, log() {}, error() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    location: { origin: 'https://x.test', pathname: '/', hash: '', search: '' },
    history: { replaceState() {} },
    URLSearchParams, setTimeout, clearTimeout,
    fetch: async (u, opt) => {
      const url = String(u);
      if (url.includes('/auth/v1/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: 'u1', email: 'a@b.co' } }) };
      }
      if (url.includes('/rest/v1/profiles')) {
        if (o.readFails) return { ok: false, status: 401, json: async () => ({ message: 'JWT expired' }) };
        return { ok: true, status: 200, json: async () => (o.rows === undefined ? [{ username: 'SRIDHAR', display_name: 'SRIDHAR R' }] : o.rows) };
      }
      if ((opt && opt.method) === 'PATCH') return { ok: true, status: 200, json: async () => ([{ username: 'SRIDHAR' }]) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };
  s.window = s;
  s.SRProg = { validUsername: (u) => typeof u === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(u) };
  s.SB_U = 'https://sb.test'; s.SB_A = 'anon';
  vm.createContext(s);
  vm.runInContext(read('public/js/account.js'), s, { filename: 'account.js' });
  return s;
}

test('v178: session() reports whether the account ANSWERED the name question', async () => {
  const ok = accountSandbox();
  assert.equal((await ok.SRAccount.session()).known, true, 'a row answered: the name is known');
  const empty = accountSandbox({ rows: [] });
  const s2 = await empty.SRAccount.session();
  assert.equal(s2.known, true, 'an account with no row still ANSWERED - it has no name yet');
  assert.equal(s2.name, '', 'and carries no name');
  const failed = accountSandbox({ readFails: true });
  const s3 = await failed.SRAccount.session();
  assert.equal(s3.known, false, 'a read that failed is NOT an answer: the name is unknown');
  assert.equal(failed.SRAccount.nameKnown(), false, 'and the client can ask directly');
  assert.equal(ok.SRAccount.nameKnown(), true);
});

// ---------------------------------------------------------------------------
// the reported symptom
// ---------------------------------------------------------------------------
test('v178: a signed-in racer sees the ACCOUNT name in the lobby', { skip: SKIP }, async (t) => {
  const b = boot({});
  t.after(() => b.dom.window.close());
  await settle(400);
  assert.equal(b.chip(), 'SRIDHAR R', 'the account name is on screen');
  assert.equal(b.field(), 'SRIDHAR R', 'and in the DRIVER IDENTITY field');
  assert.deepEqual(b.errors, [], 'boot errors: ' + b.errors.join(' | '));
});

test('v178: a device label the browser generated is NEVER written to the account', { skip: SKIP }, async (t) => {
  // the reported bug, in the state a real device is in: sr_prefs predates this fix,
  // so there is no "generated" flag - the label is recognised from the pid instead.
  const b = boot({ profile: null, prefs: { name: 'RACER-9F3A', pid: 'p9f3a', bot: true } });
  t.after(() => b.dom.window.close());
  await settle(600);
  assert.deepEqual(b.profileWrites(), [],
    'nothing may be written to the account: a generated label is not an identity');
  assert.deepEqual(b.created, [], 'not even a profile row');
  assert.equal(b.window.localStorage.getItem('sr_sb_name') || '', '', 'no account name was adopted from the label');
  assert.ok(!/^RACER-/i.test(b.chip()),
    'the chip must not present the device label as the account name, got: ' + JSON.stringify(b.chip()));
  assert.equal(b.chip(), 'sridhar', 'it shows the part of the account it CAN read instead');
  assert.deepEqual(b.errors, [], 'errors: ' + b.errors.join(' | '));
});

test('v178: a failed profile read can never rename the account', { skip: SKIP }, async (t) => {
  const b = boot({ profile: { id: 'u1', username: 'SRIDHAR', display_name: 'SRIDHAR' }, readFails: 'always', prefs: { name: 'RACER-9F3A', pid: 'p9f3a' } });
  t.after(() => b.dom.window.close());
  await settle(600);
  assert.deepEqual(b.profileWrites(), [], 'an unanswered read writes NOTHING');
  assert.equal(b.row().display_name, 'SRIDHAR', 'the account still carries its own name');
  assert.ok(!/^RACER-/i.test(b.chip()), 'the chip does not fake an account name: ' + JSON.stringify(b.chip()));
});

test('v178: an unreadable account name is retried and the lobby corrects itself', { skip: SKIP }, async (t) => {
  const b = boot({ profile: { id: 'u1', username: 'SRIDHAR', display_name: 'SRIDHAR R' }, readFails: 3, prefs: { name: 'RACER-9F3A', pid: 'p9f3a' } });
  t.after(() => b.dom.window.close());
  await settle(400);
  assert.equal(b.chip(), 'sridhar', 'while the read has not answered, no invented racer name');
  assert.ok(b.readCount() >= 1, 'the profile was read');
  await settle(3400);                       // the retry lands 3 s later
  assert.ok(b.readCount() >= 2, 'the read was retried (reads: ' + b.readCount() + ')');
  assert.equal(b.chip(), 'SRIDHAR R', 'and the racer\'s real name appears with no action from them');
  assert.equal(b.field(), 'SRIDHAR R', 'the DRIVER IDENTITY field follows');
  assert.deepEqual(b.profileWrites(), [], 'still nothing written to the account');
  assert.deepEqual(b.errors, [], 'errors: ' + b.errors.join(' | '));
});

test('v178: a name the racer CHOSE still travels to the account', { skip: SKIP }, async (t) => {
  // the v144 feature stays: an account with no name yet is seeded - but only from a
  // name a human chose, and only when the account actually answered
  const b = boot({ profile: null, prefs: { name: 'SRIDHAR', pid: 'p9f3a', nameAuto: false } });
  t.after(() => b.dom.window.close());
  await settle(600);
  const patch = b.writes.find((w) => w.display_name);
  assert.ok(patch, 'the chosen name was written to the account');
  assert.equal(patch.display_name, 'SRIDHAR');
  assert.deepEqual(b.created.map((c) => c.username), ['SRIDHAR'], 'and bound as the handle');
  assert.equal(b.chip(), 'SRIDHAR', 'the lobby shows it');
});

test('v178: renaming in the lobby shows the new name at once, and stores it', { skip: SKIP }, async (t) => {
  const b = boot({});
  t.after(() => b.dom.window.close());
  await settle(400);
  assert.equal(b.chip(), 'SRIDHAR R', 'precondition: the account name is on screen');
  const inp = b.window.document.getElementById('inp-name');
  inp.value = 'NIGHT RIDER';
  inp.dispatchEvent(new b.window.Event('input', { bubbles: true }));
  assert.equal(b.chip(), 'NIGHT RIDER', 'the lobby chip follows the rename immediately (it used to go stale)');
  await settle(1400);                       // the account write is debounced by 900 ms
  const patch = b.writes.find((w) => w.display_name === 'NIGHT RIDER');
  assert.ok(patch, 'and the account was told');
  assert.deepEqual(b.errors, [], 'errors: ' + b.errors.join(' | '));
});
