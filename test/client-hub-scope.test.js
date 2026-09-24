'use strict';

/* ============================================================================
   v107 — REAL-SCOPE client test for the Competitive Hub.

   Why this file exists
   --------------------
   test/client-competitive-hub.test.js lifts wireCompetitiveHub() out of game.js
   and evaluates it inside a sandbox that declares its OWN `let compActiveTab`.
   That is a fine test of the function, and it is completely blind to the scope of
   the state the function closes over in the SHIPPED file. Production proved it:

       Uncaught ReferenceError: compActiveTab is not defined
           game.js?v=106:6335     <- the FOUNDERS CUP click handler

   Line 6335 is the tWeekly handler and the state was declared at top level with
   `let`, 3,300 lines earlier, in the same file. A top-level `let` in a classic
   script does NOT become a property of the global object - it lives in the global
   LEXICAL environment of that one evaluation. Any handler that ends up resolving
   its scope chain against a different instance of the file (a stale body from the
   service-worker cache, the file evaluated twice on one page) finds no binding at
   all, and the browser says "is not defined" rather than the TDZ wording "cannot
   access before initialization" - which is what the racer's console showed.

   `var` at top level writes to the global object, so every copy of the file on the
   page shares ONE state and no scope chain can hide it. These tests execute the
   real public/js/game.js top to bottom in a stubbed browser realm and assert:

     1. the file evaluates and wires the hub without throwing
     2. the hub state is reachable from OUTSIDE the file (window.compActiveTab)
        <- the property that `let` did not have, and the actual regression guard
     3. clicking each of the four tabs, both scope buttons and a track pill really
        changes the state and really fetches
     4. wiring is idempotent and self-healing (opening LEADERBOARDS re-wires)
     5. a corrupt state value falls back to a visible board, not four hidden ones
     6. a host that cannot store progress SAYS SO in the hub and in the Clubs
        dialog, instead of showing an empty board and losing clubs silently
   ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GAME_JS = path.join(ROOT, 'public', 'js', 'game.js');

// ---------------------------------------------------------------------------
// Stub browser realm
// ---------------------------------------------------------------------------

function makeClassList(el) {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    _set: set
  };
}

// Set by bootGame: assigning innerHTML must materialise the ids inside it, because
// the page builds whole subtrees that way (the onboarding overlay's #ob-skip button
// is one of them) and later code does $('ob-skip').addEventListener(...).
let ID_REGISTRY = null;

function makeElement(id, tag) {
  const el = {
    id: id || '',
    tagName: (tag || 'div').toUpperCase(),
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    textContent: '',
    dataset: {},
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    children: [],
    parentNode: null,
    get parentElement() { return this.parentNode; },
    _listeners: {},
    classList: null,
    width: 300,
    height: 150,
    appendChild(c) {
      if (c && typeof c === 'object' && c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
      this.children.push(c);
      if (c && typeof c === 'object') c.parentNode = this;
      return c;
    },
    insertBefore(c, ref) {
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      if (c && typeof c === 'object') c.parentNode = this;
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      if (c && typeof c === 'object') c.parentNode = null;
      return c;
    },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = this._listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    setAttribute(k, v) { this.dataset[k] = v; },
    getAttribute(k) { return this.dataset[k] === undefined ? null : this.dataset[k]; },
    querySelectorAll() { return []; },
    // a real DOM has children; this file's top level pokes at a few of them
    // ($('prof-xp').querySelector('i').style.width), so hand back a stub child.
    querySelector(sel) {
      const key = '__q' + String(sel);
      if (!this[key]) { this[key] = makeElement('', 'i'); this.appendChild(this[key]); }
      return this[key];
    },
    closest() { return null; },
    focus() {},
    blur() {},
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    getContext() { return CTX2D; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 300, height: 150, bottom: 150, right: 300 }; }
  };
  el.classList = makeClassList(el);
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get: () => _html,
    set: (v) => {
      _html = String(v);
      if (!ID_REGISTRY) return;
      const re = /id="([^"]+)"/g;
      let m;
      while ((m = re.exec(_html)) !== null) ID_REGISTRY(m[1], el);
    }
  });
  return el;
}

// 2D context: the few methods whose RESULT is dereferenced need real shapes, the
// rest are no-ops.
const CTX2D = new Proxy({}, {
  get: (t, p) => {
    if (p === 'createRadialGradient' || p === 'createLinearGradient' || p === 'createPattern') {
      return () => ({ addColorStop() {}, setTransform() {} });
    }
    if (p === 'getImageData' || p === 'createImageData') {
      return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
    }
    if (p === 'measureText') return () => ({ width: 12, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
    if (p === 'canvas') return makeElement('', 'canvas');
    if (typeof p === 'string') return () => {};
    return undefined;
  },
  set: () => true
});

// THREE is only touched, never asserted on: any property is a chainable callable
function makeThreeStub() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get: (t, p) => {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'then') return undefined;         // never look thenable
      if (p === 'domElement') return makeElement('', 'canvas');
      if (p === 'length') return 0;
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
    set: () => true
  });
  return proxy;
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] || null,
    get length() { return m.size; },
    _map: m
  };
}

/**
 * Build a realm and evaluate the real game.js in it.
 * opts.health  - object returned by GET /health
 * opts.api     - (url) => body for every other fetch
 */
function bootGame(opts = {}) {
  const els = new Map();        // every element getElementById has handed out
  const createdEls = new Map(); // only elements document.createElement built
  const fetchLog = [];
  const docListeners = {};
  const bodyEl = makeElement('body', 'body');   // built first: el() parents into it

  // An element's id can be assigned after creation (document.createElement +
  // el.id = 'hub-persist-warn'), and the tests look those banners up by id, so
  // every element this realm hands out registers itself the moment it is named.
  const mkEl = (id, tag, sink) => {
    const e = makeElement(id, tag);
    let cur = id || '';
    const register = (v) => { els.set(v, e); if (sink) sink.set(v, e); };
    if (cur) register(cur);
    Object.defineProperty(e, 'id', {
      configurable: true,
      enumerable: true,
      get: () => cur,
      set: (v) => { cur = String(v); if (cur) register(cur); }
    });
    return e;
  };
  // Build the page's real element set out of public/index.html: ids, classes, the
  // hidden attribute and data-* values. document.getElementById then behaves like a
  // browser (null for an id the page does not have), which matters because the hub
  // and Clubs code both test `if ($('...'))` before creating a banner.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const tagRe = /<([a-zA-Z0-9-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let tm;
  while ((tm = tagRe.exec(html)) !== null) {
    const attrs = tm[2] || '';
    const idm = /(?:^|\s)id="([^"]+)"/.exec(attrs);
    if (!idm || els.has(idm[1])) continue;
    const e = mkEl(idm[1], tm[1]);
    els.set(idm[1], e);
    const cm = /(?:^|\s)class="([^"]+)"/.exec(attrs);
    if (cm) cm[1].split(/\s+/).filter(Boolean).forEach((c) => e.classList.add(c));
    if (/(?:^|\s)hidden(?:\s|=|$)/.test(attrs)) { e.hidden = true; e.classList.add('hidden'); }
    const dm = /data-([a-z0-9-]+)="([^"]*)"/g;
    let d;
    while ((d = dm.exec(attrs)) !== null) {
      e.dataset[d[1].replace(/-([a-z0-9])/g, (x, y) => y.toUpperCase())] = d[2];
    }
    bodyEl.appendChild(e);
  }

  // test-facing: create-on-demand, so a test can build a node the page lacks
  ID_REGISTRY = (nid, parent) => {
    if (!els.has(nid)) els.set(nid, mkEl(nid));
    if (parent) parent.appendChild(els.get(nid));
  };

  const el = (id) => {
    if (!els.has(id)) {
      const e = mkEl(id);
      els.set(id, e);
      bodyEl.appendChild(e);
    }
    return els.get(id);
  };
  const pageEl = (id) => (els.has(id) ? els.get(id) : null);

  // The hub panels start exactly as index.html ships them: the leaderboard pane is
  // hidden until LEADERBOARDS is clicked, and only the time board's placeholder is
  // in the DOM. Anything the test needs to see "open" it opens itself.
  el('pane-rank').classList.add('hidden');

  const document = {
    readyState: 'complete',
    body: bodyEl,
    documentElement: makeElement('html', 'html'),
    head: makeElement('head', 'head'),
    getElementById: (id) => (id === undefined || id === null ? null : pageEl(String(id))),
    createElement: (tag) => mkEl('', tag, createdEls),
    querySelectorAll: (sel) => {
      // the five track pills exist in index.html with data-map="0..4"
      if (sel === '.mf-pill') {
        return [0, 1, 2, 3, 4].map((i) => {
          const id = '__mf-pill-' + i;
          if (!els.has(id)) { const p = makeElement(id); p.dataset.map = String(i); els.set(id, p); }
          return els.get(id);
        });
      }
      if (sel === '.dlg') return [el('crew-dlg')];
      return [];
    },
    querySelector: () => null,
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener: () => {},
    visibilityState: 'visible',
    hidden: false
  };

  const sandbox = {
    console: {
      _warnings: [],
      log() {}, info() {}, debug() {},
      warn(...a) { this._warnings.push(a.map(String).join(' ')); },
      error(...a) { this._warnings.push('ERROR ' + a.map(String).join(' ')); }
    },
    document,
    navigator: { userAgent: 'node-test', language: 'en-US', onLine: true, maxTouchPoints: 0, vibrate() {} },
    location: { origin: 'http://hub.test', href: 'http://hub.test/', search: '', hash: '', pathname: '/', protocol: 'http:', host: 'hub.test', replace() {}, assign() {} },
    history: { replaceState() {}, pushState() {} },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    performance: { now: () => Date.now(), timeOrigin: 0 },
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,          // fake timers: nothing keeps the process alive
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: (type, fn) => { (docListeners['window:' + type] = docListeners['window:' + type] || []).push(fn); },
    removeEventListener: () => {},
    open: () => null,
    alert() {}, confirm: () => true, prompt: () => null,
    THREE: makeThreeStub(),
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    crypto: require('node:crypto').webcrypto,
    Blob: class { constructor(p) { this.parts = p; } },
    FormData: class { append() {} get() { return null; } },
    Event: class Event { constructor(t) { this.type = t; } },
    CustomEvent: class CustomEvent { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    WebSocket: class {
      constructor(url) { this.url = url; this.readyState = 0; }
      send() {} close() { this.readyState = 3; } addEventListener() {} removeEventListener() {}
    },
    AudioContext: class {
      constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sampleRate = 48000; }
      createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
      createOscillator() { return { type: 'sine', frequency: { value: 440, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
      createBufferSource() { return { buffer: null, loop: false, connect() {}, start() {}, stop() {}, playbackRate: { value: 1 } }; }
      createBiquadFilter() { return { type: 'lowpass', frequency: { value: 1000, setValueAtTime() {} }, Q: { value: 1 }, connect() {} }; }
      createDynamicsCompressor() { return { connect() {}, threshold: { value: -24 }, knee: { value: 30 }, ratio: { value: 12 }, attack: { value: 0 }, release: { value: 0.25 } }; }
      createStereoPanner() { return { pan: { value: 0, setValueAtTime() {} }, connect() {} }; }
      createConvolver() { return { buffer: null, connect() {} }; }
      createWaveShaper() { return { curve: null, connect() {} }; }
      createAnalyser() { return { fftSize: 2048, frequencyBinCount: 1024, getByteFrequencyData() {}, connect() {} }; }
      decodeAudioData() { return Promise.resolve({ duration: 1, length: 48000, sampleRate: 48000, numberOfChannels: 2, getChannelData: () => new Float32Array(48000) }); }
      resume() { this.state = 'running'; return Promise.resolve(); }
      suspend() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    },
    fetch: (url, init) => {
      const u = String(url);
      fetchLog.push({ url: u, init: init || null });
      const jsonRes = (body) => ({
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
        clone() { return this; }
      });
      // What a STATIC host (Vercel serving public/ with no Express) returns for an
      // unknown path: 200 OK with the SPA's index.html in it. opts.health may be an
      // object, a function of the url, or null for "HTML, not the server".
      const htmlRes = () => ({
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
        text: () => Promise.resolve('<!doctype html><html><head><title>Sridhar Rush</title>'),
        clone() { return this; }
      });
      if (u.indexOf('/health') >= 0) {
        const h = typeof opts.health === 'function'
          ? opts.health(u)
          : (opts.health === undefined ? { ok: true, persistence: { verdict: 'ok', playerStatsKeyType: 'text' } } : opts.health);
        return Promise.resolve(h === null ? htmlRes() : jsonRes(h));
      }
      return Promise.resolve(jsonRes(opts.api ? (opts.api(u, init) || {}) : {}));
    },
    // net.js is a separate <script>; game.js only sends and subscribes through it
    net: {
      connected: false,
      send() {}, on() {}, off() {}, close() {}, ws: null,
      state: null, room: null
    },
    // account.js / i18n.js are optional at this point in the file
    SRAccount: { name: () => '', uid: () => '', token: () => '', signedIn: () => false, ready: Promise.resolve() },
    VRCore: null
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);

  // Load the page's real scripts in index.html's order. Every one of them is a
  // classic deferred script sharing one realm, which is the whole point: the hub
  // state has to be visible to all of them, not just to one file's own scope.
  const errors = [];
  const FILES = [
    'public/js/game-core.js',
    'public/js/progression.js',
    'public/js/cosmetics.js',
    'public/js/account.js',
    'public/js/i18n.js',
    'public/js/net.js',
    'public/js/game.js'
  ];
  FILES.forEach((f) => {
    try {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    } catch (e) {
      errors.push(e);
    }
  });

  return {
    ctx,
    sandbox,
    errors,
    els,
    el,
    createdEls,
    created: (id) => createdEls.get(id),
    fetchLog,
    docListeners,
    warnings: sandbox.console._warnings,
    /** run an expression in the realm, as a separate script would */
    eval: (code) => vm.runInContext(code, ctx, { filename: 'test-probe.js' }),
    /** fire every 'click' listener attached to an element, like a real click */
    click(idOrEl) {
      const e = typeof idOrEl === 'string' ? els.get(idOrEl) : idOrEl;
      assert.ok(e, 'no such element to click: ' + idOrEl);
      const fns = (e._listeners && e._listeners.click) || [];
      const ev = { target: e, currentTarget: e, preventDefault() {}, stopPropagation() {} };
      fns.forEach((f) => f(ev));
      return fns.length;
    },
    listenerCount(idOrEl, type) {
      const e = typeof idOrEl === 'string' ? els.get(idOrEl) : idOrEl;
      return e && e._listeners && e._listeners[type || 'click'] ? e._listeners[type || 'click'].length : 0;
    }
  };
}

/** let every queued promise (fetch chains, .then banners) settle */
async function settle(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ===========================================================================

test('game.js evaluates in a stubbed browser realm without a module-scope ReferenceError', () => {
  const g = bootGame();
  // Dumped on demand: HUB_DEBUG=1 node --test test/client-hub-scope.test.js
  if (process.env.HUB_DEBUG) {
    g.errors.forEach((e) => process.stderr.write('BOOT ERROR: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ') + '\n'));
  }
  const scopeErrors = g.errors.filter((e) => /is not defined|Cannot access .* before initialization/.test(String(e && e.message)));
  assert.deepStrictEqual(scopeErrors.map((e) => e.message), [], 'the shipped file threw a scope error at top level');
});

test('hub state is reachable from OUTSIDE the file (the bug: a top-level `let` is not)', () => {
  const g = bootGame();
  // A separate script - which is exactly what a second instance of game.js is -
  // can only see state that lives on the global object.
  assert.strictEqual(g.eval('typeof window.compActiveTab'), 'string', 'window.compActiveTab must exist for cross-instance handlers');
  assert.strictEqual(g.eval('window.compActiveTab'), 'rate');
  assert.strictEqual(g.eval('window.compScope'), 'top');
  assert.strictEqual(g.eval('window.compSelectedMap'), 0);
});

test('hub state is declared with var (global object), never let/const', () => {
  const src = fs.readFileSync(GAME_JS, 'utf8');
  ['compActiveTab', 'compScope', 'compSelectedMap'].forEach((name) => {
    assert.ok(
      new RegExp('^var ' + name + ' =', 'm').test(src),
      name + ' must be a top-level `var` (column 0) so it lands on globalThis'
    );
    assert.ok(
      !new RegExp('^(let|const) ' + name + '\\b', 'm').test(src),
      name + ' must not be a script-scope let/const: a handler attached by another instance cannot see it'
    );
    assert.ok(src.includes('window.' + name + ' = ' + name + ';'), name + ' must be mirrored onto window');
  });
});

test('the four hub tabs are wired at load and each click switches the board', async () => {
  const g = bootGame();
  await settle();

  ['board-tab-rate', 'board-tab-time', 'board-tab-daily', 'board-tab-weekly'].forEach((id) => {
    assert.strictEqual(g.listenerCount(id, 'click'), 1, id + ' must have exactly one click handler');
  });

  g.click('board-tab-weekly');          // FOUNDERS CUP - the tab in the bug report
  assert.strictEqual(g.eval('window.compActiveTab'), 'weekly');
  g.click('board-tab-daily');
  assert.strictEqual(g.eval('window.compActiveTab'), 'daily');
  g.click('board-tab-time');
  assert.strictEqual(g.eval('window.compActiveTab'), 'time');
  g.click('board-tab-rate');
  assert.strictEqual(g.eval('window.compActiveTab'), 'rate');

  const cups = g.fetchLog.filter((f) => /\/cup|\/daily|\/api\/leaderboard/.test(f.url));
  assert.ok(cups.length >= 1, 'clicking a tab must fetch its board');
});

test('scope buttons and track pills update shared state, not a dead local copy', () => {
  const g = bootGame();
  assert.strictEqual(g.click('scope-nearby'), 1);
  assert.strictEqual(g.eval('window.compScope'), 'nearby');
  assert.strictEqual(g.click('scope-top'), 1);
  assert.strictEqual(g.eval('window.compScope'), 'top');

  const pill = g.els.get('__mf-pill-3');
  assert.ok(pill, 'track pills must exist and be wired');
  assert.strictEqual(g.listenerCount(pill, 'click'), 1);
  g.click(pill);
  assert.strictEqual(g.eval('window.compSelectedMap'), 3);
});

test('wiring is idempotent and self-healing: reopening LEADERBOARDS never double-attaches', () => {
  const g = bootGame();
  g.eval('wireLobbyV2()');                    // the lazy lobby wiring, as the page runs it
  assert.strictEqual(g.listenerCount('ltab-rank', 'click'), 1, 'LEADERBOARDS tab must be clickable');
  const before = g.listenerCount('board-tab-time', 'click');
  g.eval('window.__compWired = false;');      // pretend the first wiring never happened
  g.click('ltab-rank');                       // the racer opens the panel
  const after = g.listenerCount('board-tab-time', 'click');
  assert.ok(after >= 1, 'opening LEADERBOARDS must (re)wire the tabs');
  assert.ok(after - before <= 1, 'a healed re-wire must not stack handlers: ' + before + ' -> ' + after);

  g.click('ltab-rank');                       // and again: flag is set, nothing added
  assert.strictEqual(g.listenerCount('board-tab-time', 'click'), after);
});

test('opening LEADERBOARDS wires the hub even when the load-time wiring was skipped', () => {
  const g = bootGame();
  g.eval('wireLobbyV2()');
  // Simulate a device where the load-time call was swallowed: clear the flag and
  // the element listeners, then open the panel the way a racer does.
  g.eval('window.__compWired = false;');
  ['board-tab-rate', 'board-tab-time', 'board-tab-daily', 'board-tab-weekly'].forEach((id) => {
    const e = g.els.get(id);
    if (e) e._listeners.click = [];
  });
  g.click('ltab-rank');
  assert.strictEqual(g.listenerCount('board-tab-weekly', 'click'), 1, 'FOUNDERS CUP must be clickable after opening the panel');
  g.click('board-tab-weekly');
  assert.strictEqual(g.eval('window.compActiveTab'), 'weekly');
});

test('a corrupt state value falls back to a visible board instead of four hidden ones', async () => {
  const g = bootGame();
  await settle();
  g.eval('window.compActiveTab = "nonsense"; compActiveTab = "nonsense"; window.compScope = "sideways"; compScope = "sideways"; window.compSelectedMap = -7; compSelectedMap = -7;');
  await g.eval('loadCompetitiveHub()');
  await settle();
  assert.strictEqual(g.eval('window.compActiveTab'), 'rate');
  assert.strictEqual(g.eval('window.compScope'), 'top');
  assert.strictEqual(g.eval('window.compSelectedMap'), 0);
  assert.strictEqual(g.el('rate-board').hidden, false, 'the rating board must be the one left visible');
  assert.strictEqual(g.el('leaderboard').hidden, true);
});

test('the hub state and its wiring are globals, so no function scope can trap them', () => {
  const g = bootGame();
  // This is the regression guard for the v106 build: the state and the wiring were
  // declared inside wireLobbyV2(), which made them function-local and produced
  // "compActiveTab is not defined" in the top-level click handlers. A file-scope
  // declaration is reachable from every other script on the page.
  ['compActiveTab', 'compScope', 'compSelectedMap'].forEach((n) => {
    assert.strictEqual(g.eval('typeof window.' + n) === 'undefined', false, 'window.' + n + ' must exist');
    assert.notStrictEqual(g.eval('typeof ' + n), 'undefined', n + ' must resolve globally');
  });
  assert.strictEqual(g.eval('typeof ensureCompetitiveWired'), 'function', 'ensureCompetitiveWired must be a global');
  assert.strictEqual(g.eval('typeof wireCompetitiveHub'), 'function');
  assert.strictEqual(g.eval('typeof loadCompetitiveHub'), 'function');
  assert.strictEqual(g.eval('window.__compWired'), true);
});

test('another script on the page can drive the hub, as an inline handler would', async () => {
  const g = bootGame();
  await settle();
  g.eval('compActiveTab = "daily"; window.compActiveTab = "daily";'); // e.g. window.showRatingTab() callers
  await g.eval('loadCompetitiveHub()');
  await settle();
  assert.strictEqual(g.el('daily-board-view').hidden, false, 'the cup board must be the visible one');
  assert.strictEqual(g.el('rate-board').hidden, true);
  assert.ok(g.fetchLog.some((f) => /\/cup|\/daily/.test(f.url)), 'the daily board must be fetched');
});

test('a host that cannot store progress says so in the hub instead of showing an empty board', async () => {
  const g = bootGame({ health: { ok: true, persistence: { verdict: 'table_missing', playerStatsKeyType: 'text' } } });
  await g.eval('loadCompetitiveHub()');
  await settle();
  const warn = g.created('hub-persist-warn');
  assert.ok(warn, 'the hub must publish the persistence verdict');
  assert.match(warn.textContent, /MEMORY-ONLY/i);
  assert.match(warn.textContent, /supabase-migration-v98\.sql/);
});

test('a uuid player_stats key is named as the reason guest results are missing', async () => {
  const g = bootGame({ health: { ok: true, persistence: { verdict: 'ok', playerStatsKeyType: 'uuid' } } });
  await g.eval('loadCompetitiveHub()');
  await settle();
  const warn = g.created('hub-persist-warn');
  assert.ok(warn, 'the hub must warn when guest identities are rejected');
  assert.match(warn.textContent, /v98/);
});

test('a healthy host shows no warning at all', async () => {
  const g = bootGame({ health: { ok: true, persistence: { verdict: 'ok', playerStatsKeyType: 'text' } } });
  await g.eval('loadCompetitiveHub()');
  await settle();
  assert.strictEqual(g.created('hub-persist-warn'), undefined, 'no banner when persistence is verified');
});

test('the Clubs dialog explains why a created club disappeared after a redeploy', async () => {
  const g = bootGame({ health: { ok: true, persistence: { verdict: 'table_missing' } } });
  const box = g.el('crew-dlg');                // <div id="crew-dlg" class="dlg">
  const body = g.el('crew-body');
  box.appendChild(body);                      // #crew-body's parent is the dialog
  await g.eval('openCrewModal("my")');
  await settle();
  const warn = g.created('crew-persist-warn');
  assert.ok(warn, 'the Clubs dialog must publish the verdict');
  assert.match(warn.textContent + warn.innerHTML, /TEMPORARY/i);
  assert.match(warn.innerHTML, /supabase-migration-v98\.sql/);
  assert.strictEqual(box.children.indexOf(warn) < box.children.indexOf(body), true, 'the banner sits above the club list');
});

test('the Clubs dialog stays clean when club storage is verified', async () => {
  const g = bootGame({ health: { ok: true, persistence: { verdict: 'ok' } } });
  const box = g.el('crew-dlg');
  const body = g.el('crew-body');
  box.appendChild(body);
  await g.eval('openCrewModal("my")');
  await settle();
  assert.strictEqual(g.created('crew-persist-warn'), undefined);
});
test('a static host with no server behind it says so, instead of showing an empty board', async () => {
  // Vercel serves public/ with no Express in it: /api/health and /health both come
  // back 200 with index.html. Without this the hub shows "no times yet" and the
  // Clubs dialog shows five presets, and neither is distinguishable from a quiet
  // server - which is how a whole missing backend goes unreported.
  const g = bootGame({ health: () => null });
  await g.eval('loadCompetitiveHub()');
  await settle();
  const warn = g.created('hub-persist-warn');
  assert.ok(warn, 'the hub must report that no server answered');
  assert.match(warn.textContent, /NO GAME SERVER/i);
  assert.match(warn.textContent, /SERVER_URL/);
  assert.ok(g.fetchLog.some((f) => f.url.indexOf('/api/health') >= 0), 'must probe /api/health first');
});

test('/health is the fallback when /api/health is not routed', async () => {
  const g = bootGame({
    health: (u) => (u.indexOf('/api/health') >= 0 ? null : { ok: true, persistence: { verdict: 'table_missing' } })
  });
  await g.eval('loadCompetitiveHub()');
  await settle();
  const warn = g.created('hub-persist-warn');
  assert.ok(warn, 'the fallback must still produce a verdict');
  assert.match(warn.textContent, /MEMORY-ONLY/i);
  const order = g.fetchLog.filter((f) => f.url.indexOf('/health') >= 0).map((f) => f.url);
  assert.ok(order.length >= 2 && order[0].indexOf('/api/health') >= 0 && order[1].indexOf('/api/') < 0,
    'tries /api/health then /health, got: ' + order.join(' , '));
});

test('the Clubs dialog names a missing backend as the reason clubs cannot be kept', async () => {
  const g = bootGame({ health: () => null });
  const box = g.el('crew-dlg');
  const body = g.el('crew-body');
  box.appendChild(body);
  await g.eval('openCrewModal("my")');
  await settle();
  const warn = g.created('crew-persist-warn');
  assert.ok(warn, 'a created club that cannot be stored must be announced');
  assert.match(warn.innerHTML, /no game server answered/i);
});

test('an HTML answer is never mistaken for a healthy server', async () => {
  const g = bootGame({ health: () => null });
  const j = await g.eval('fetchServerHealth()');
  assert.strictEqual(j, null, 'a 200 whose body is HTML must not pass as the health payload');
  assert.strictEqual(await g.eval('checkCrewPersistence()'), 'no_server');
});

// Exported for ad-hoc probing: node -e "require('./test/client-hub-scope.test.js').bootGame()"
module.exports = { bootGame, settle };
