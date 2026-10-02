// THE WHOLE GAME ON THE DEVICE (v166) — the app itself opens with no internet.
//
// v165 made the RACE need no server. This suite is about the other half: the app
// that has to load before any of that can run. It executes the real public/sw.js
// inside a small VM with a Cache API, a fetch that can be switched off, and the
// real files from public/ as the "network", then shuts the network down and boots
// the game the way an installed app does in aeroplane mode.
//
// What it pins:
//   1. COVERAGE - every local file index.html asks for is either in the precached
//      shell or in the car-model list, so a cold start cannot be missing a piece;
//   2. sw-icons.js matches the real icons and car-model folders (it is generated,
//      and this fails if it is stale);
//   3. install precaches the shell; with the network OFF, a navigation request
//      returns the saved lobby, and the client scripts come back from the cache;
//   4. live endpoints (/api/..., /version, ...) are never intercepted or stored;
//   5. SAVE FOR OFFLINE caches the heavy car model and reports honestly - both
//      when it succeeds and when a file cannot be downloaded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------------------------------------------------------------- fake browser
const ORIGIN = 'https://sridhar-drift.vercel.app';

class Req {
  constructor(url, opts) {
    this.url = String(url).startsWith('http') ? String(url) : ORIGIN + String(url).split('?')[0] + (String(url).includes('?') ? '?' + String(url).split('?')[1] : '');
    this.method = (opts && opts.method) || 'GET';
    this.mode = (opts && opts.mode) || 'cors';
  }
}
class Res {
  constructor(body, opts) {
    const o = opts || {};
    this._body = body == null ? '' : body;
    this.status = o.status == null ? 200 : o.status;
    this.ok = this.status >= 200 && this.status < 300;
    this.type = o.type || 'basic';
    this.headers = new Map(Object.entries(o.headers || {}));
  }
  clone() { return new Res(this._body, { status: this.status, type: this.type }); }
  text() { return Promise.resolve(Buffer.isBuffer(this._body) ? this._body.toString('utf8') : String(this._body)); }
}
class Cache {
  constructor() { this.map = new Map(); }
  key(req, ignoreSearch) {
    // a relative string is resolved against the worker's own origin, exactly as
    // caches.match('/js/game.js') does in a browser
    const u = new URL(req && req.url ? req.url : String(req), ORIGIN);
    if (ignoreSearch) u.search = '';
    return u.href;
  }
  match(req, opts) { return Promise.resolve(this.map.get(this.key(req, opts && opts.ignoreSearch)) || undefined); }
  put(req, res) { this.map.set(this.key(req), res); return Promise.resolve(); }
}

// every file the site serves, keyed by pathname (the query is ignored by the
// fake server, exactly like a static host)
function buildSite() {
  const site = new Map();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const abs = path.join(dir, f);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else site.set('/' + path.relative(PUB, abs).split(path.sep).join('/'), fs.readFileSync(abs));
    }
  };
  walk(PUB);
  site.set('/', site.get('/index.html'));
  site.set('/controller', site.get('/controller.html'));
  site.set('/replay', site.get('/replay.html'));
  return site;
}

// A service-worker-ish environment: the real sw.js runs in here.
function makeWorker(site) {
  const stores = new Map();              // cache name -> Cache
  const handlers = new Map();
  const clients = [{ postMessage: (m) => clients.log.push(m) }];
  clients.log = [];
  const state = { net: true, fetched: [] };

  const caches = {
    open: (name) => { if (!stores.has(name)) stores.set(name, new Cache()); return Promise.resolve(stores.get(name)); },
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name) => { stores.delete(name); return Promise.resolve(true); },
    match: async (req, opts) => {
      for (const c of stores.values()) { const hit = await c.match(req, opts); if (hit) return hit; }
      return undefined;
    }
  };
  const fetchShim = (input) => {
    const url = new URL(input && input.url ? input.url : String(input));
    state.fetched.push(url.pathname + url.search);
    if (!state.net) return Promise.reject(new Error('network down'));
    const body = site.get(url.pathname);
    if (body === undefined) return Promise.resolve(new Res('not found', { status: 404 }));
    if (input && input.signal && input.signal.aborted) return Promise.reject(new Error('aborted'));
    return Promise.resolve(new Res(body, { status: 200, type: 'basic' }));
  };

  const sandbox = {
    self: null,
    caches,
    fetch: fetchShim,
    Request: Req,
    Response: Res,
    URL,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    setTimeout, clearTimeout, Promise, console,
    importScripts: (u) => {
      const file = path.join(PUB, String(u).split('?')[0]);
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: u });
    }
  };
  sandbox.self = sandbox;
  sandbox.location = { origin: ORIGIN, href: ORIGIN + '/sw.js' };
  sandbox.clients = { matchAll: () => Promise.resolve(clients), claim: () => Promise.resolve() };
  sandbox.skipWaiting = () => Promise.resolve();
  sandbox.addEventListener = (type, fn) => { handlers.set(type, fn); };
  const context = vm.createContext(sandbox);

  // the worker's own globals, then its code
  vm.runInContext(read('public/sw-icons.js'), context, { filename: 'sw-icons.js' });
  vm.runInContext(read('public/sw.js'), context, { filename: 'sw.js' });

  // fire an event and collect what it decided to do
  async function fire(type, event) {
    const fn = handlers.get(type);
    if (!fn) return { responded: undefined, waited: [] };
    const waited = [];
    let responded;
    const ev = Object.assign({
      waitUntil: (p) => waited.push(p),
      respondWith: (p) => { responded = p; }
    }, event || {});
    fn(ev);
    await Promise.all(waited.map((p) => Promise.resolve(p).catch(() => {})));
    return { responded, waited };
  }
  return { fire, state, clients, stores, caches, sandbox };
}

// ------------------------------------------------------------------ 1. coverage
test('every local file the lobby asks for is saved for offline', () => {
  const html = read('public/index.html');
  const w = makeWorker(buildSite());
  const shell = w.sandbox.__SR_OFFLINE_SHELL;
  const icons = w.sandbox.__SR_OFFLINE_FILES;
  assert.ok(Array.isArray(shell) && shell.length > 20, 'the worker declares its shell (' + shell.length + ')');
  const covered = new Set([...shell, ...icons.icons, ...icons.heavy].map((u) => u.split('?')[0]));

  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u))
    .map((u) => '/' + u.replace(/^\.\//, '').replace(/^\//, '').replace(/\?.*$/, ''));
  assert.ok(refs.length > 20, 'the page references its assets (' + refs.length + ')');
  const missing = refs.filter((u) => !u.endsWith('.html') && !covered.has(u));
  assert.deepEqual(missing, [], 'these would 404 on a cold start with no internet: ' + JSON.stringify(missing));
  // and the heavy half is the car model the race itself needs
  assert.ok(icons.heavy.some((u) => /CarConcept\.gltf$/.test(u)), 'the car model is in the offline set');
  assert.ok(icons.heavy.some((u) => /CarConcept\.data\.bin$/.test(u)), 'and its geometry payload');
});

test('every URL in the offline set really exists on this deploy', () => {
  // A typo here is invisible until a racer is in a tunnel: the save reports
  // "some files did not download" for ever and the chip never appears. So every
  // entry is resolved against the real files (plus the three rewrites the host
  // serves: /, /controller, /replay).
  const site = buildSite();
  const w = makeWorker(site);
  const urls = [...w.sandbox.__SR_OFFLINE_SHELL, ...w.sandbox.__SR_OFFLINE_FILES.icons, ...w.sandbox.__SR_OFFLINE_FILES.heavy];
  const missing = [...new Set(urls)].filter((u) => !site.has(u.split('?')[0]));
  assert.deepEqual(missing, [], 'these are listed for offline but do not exist: ' + JSON.stringify(missing));
  assert.ok(urls.length > 200, 'the set is the whole game (' + urls.length + ' files)');
});

test('sw-icons.js matches the icons and car-model files on disk', () => {
  const listed = new Function('self', read('public/sw-icons.js') + '; return self.__SR_OFFLINE_FILES;')({});
  const dir = (d) => fs.readdirSync(path.join(PUB, d)).filter((f) => fs.statSync(path.join(PUB, d, f)).isFile()).sort().map((f) => '/' + d + '/' + f);
  assert.deepEqual(listed.icons.slice().sort(), dir('img/ico').concat(dir('img/ico-mono')).sort(),
    'every drawn icon is listed (regenerate with node scripts/vercel-build.js)');
  assert.deepEqual(listed.heavy.slice().sort(), dir('assets/cars/ghost').sort(),
    'every car-model file is listed - the .bin holds the geometry');
});

test('the version marker is v166 everywhere the deploy is identified', () => {
  assert.match(read('public/js/game.js'), /const BUILD = 'v166';/);
  assert.match(read('public/sw.js'), /const BUILD = 'v166';/);
  assert.match(read('public/sw.js'), /const CACHE = 'sridhar-rush-' \+ BUILD;/);
  assert.match(read('server.js'), /build: 'v166'/);
  const html = read('public/index.html');
  assert.doesNotMatch(html, /\?v=165/, 'no asset reference is left on the old build');
  assert.match(html, /js\/offline-save\.js\?v=166/);
  assert.match(html, /js\/offline\.js\?v=166/);
  assert.match(read('public/auth.html'), /\?v=166/);
  assert.match(read('public/controller.html'), /\?v=166/);
});

// ------------------------------------------------------- 2. the boot with no net
test('install saves the shell, and a cold start with no internet boots from it', async () => {
  const site = buildSite();
  const w = makeWorker(site);

  const install = await w.fire('install', {});
  await Promise.all(install.waited);
  const cache = await w.caches.open('sridhar-rush-v166');
  assert.ok(await cache.match('/index.html') || await cache.match('/'), 'the lobby was saved at install');
  assert.ok(await cache.match('/js/game.js?v=166'), 'and the game client');

  // ---- aeroplane mode -------------------------------------------------------
  w.state.net = false;
  const nav = await w.fire('fetch', { request: new Req('/', { mode: 'navigate' }) });
  const page = await nav.responded;
  assert.equal(page.status, 200, 'the page still answers');
  const body = await page.text();
  assert.match(body, /sr-offline-btn/, 'and it is the real lobby, with the save control on it');
  assert.match(body, /js\/game\.js\?v=166/, 'the client script tag is there');
  assert.doesNotMatch(body, /This screen was not saved/, 'the fallback page is not used when the shell was saved');

  for (const url of ['/js/game.js?v=166', '/js/offline.js?v=166', '/js/offline-save.js?v=166', '/js/vendor/three.min.js',
    '/css/style.css?v=166', '/img/ico-mono/check.svg', '/img/ico/arrow-left.svg', '/img/map-island.webp',
    '/img/cars/fury.webp', '/manifest.webmanifest']) {
    const r = await w.fire('fetch', { request: new Req(url) });
    const got = await r.responded;
    assert.ok(got && got.ok, url + ' comes back from the saved copy (got ' + (got && got.status) + ')');
    assert.ok((await got.text()).length > 20, url + ' has real content');
  }

  // config.js: the deploy's keys online, a safe empty copy offline
  const cfg = await w.fire('fetch', { request: new Req('/js/config.js') });
  const cfgBody = await (await cfg.responded).text();
  assert.match(cfgBody, /SB_U/, 'the offline config still defines the globals the client reads');

  // an unsaved screen says so instead of showing a lie
  const miss = await w.fire('fetch', { request: new Req('/img/never-saved.png') });
  assert.equal((await miss.responded).status, 504, 'an unsaved asset fails quietly');

  // live endpoints are never touched or stored
  for (const live of ['/api/player/crew', '/version', '/health', '/lb', '/a']) {
    const r = await w.fire('fetch', { request: new Req(live) });
    assert.equal(r.responded, undefined, live + ' is left to the network');
  }
  assert.equal(await cache.match('/version'), undefined, 'and never written to the cache');
});

test('a page that was never saved gets the honest fallback, not a blank screen', async () => {
  const site = buildSite();
  const w = makeWorker(site);
  w.state.net = false;
  const nav = await w.fire('fetch', { request: new Req('/some-screen-not-in-the-shell.html', { mode: 'navigate' }) });
  const page = await nav.responded;
  assert.equal(page.status, 503);
  assert.match(await page.text(), /SAVE FOR OFFLINE/, 'it tells the racer how to fix it');
});

// --------------------------------------------------------- 3. SAVE FOR OFFLINE
test('SAVE FOR OFFLINE caches the car model and reports honestly', async () => {
  const site = buildSite();
  const w = makeWorker(site);
  await w.fire('install', {});
  const cache = await w.caches.open('sridhar-rush-v166');
  assert.equal(await cache.match('/assets/cars/ghost/CarConcept.gltf'), undefined,
    'the 9.6 MB car model is NOT dragged down at install');
  assert.ok(await cache.match('/img/ico-mono/check.svg'), 'the small icon sets are, so the dashboard has no holes offline');

  const saved = await w.fire('message', { type: 'sr-offline-save', data: { type: 'sr-offline-save' } });
  await Promise.all(saved.waited);
  assert.ok(await cache.match('/assets/cars/ghost/CarConcept.gltf'), 'the save fetches the car model');
  assert.ok(await cache.match('/assets/cars/ghost/CarConcept.data.bin'), 'and its geometry');
  assert.ok(await cache.match('/img/ico-mono/check.svg'), 'and every icon');
  const done = w.clients.log.filter((m) => m.type === 'sr-offline-done').pop();
  assert.ok(done, 'the racer is told the result');
  assert.equal(done.ok, true, 'and it says the game is complete: ' + JSON.stringify(done.failed));
  const progress = w.clients.log.filter((m) => m.type === 'sr-offline-progress');
  assert.ok(progress.length > 1, 'with progress while it works');

  // the status the lobby shows
  const st = await w.fire('message', {
    type: 'sr-offline-status', data: { type: 'sr-offline-status' },
    source: { postMessage: (m) => w.clients.log.push(m) }            // the page that asked
  });
  const status = w.clients.log.filter((m) => m.type === 'sr-offline-status').pop();
  assert.ok(status.ready, 'the app reports itself ready for a no-internet start: ' + JSON.stringify(status));
  assert.ok(status.have >= status.total, status.have + '/' + status.total);
  assert.ok(st.waited.length >= 0);
});

test('a save that cannot download everything says so, and can be retried', async () => {
  const site = buildSite();
  site.delete('/assets/cars/ghost/CarConcept.data.bin');       // the big one fails
  const w = makeWorker(site);
  await w.fire('install', {});
  const saved = await w.fire('message', { type: 'sr-offline-save', data: { type: 'sr-offline-save' } });
  await Promise.all(saved.waited);
  const done = w.clients.log.filter((m) => m.type === 'sr-offline-done').pop();
  assert.equal(done.ok, false, 'the result is honest');
  assert.ok(done.failed.some((u) => /CarConcept\.data\.bin/.test(u)), 'and names what failed: ' + JSON.stringify(done.failed));

  // the file comes back, the retry completes and caches nothing twice
  site.set('/assets/cars/ghost/CarConcept.data.bin', Buffer.from('<geometry>'));
  const before = w.state.fetched.length;
  const retry = await w.fire('message', { type: 'sr-offline-save', data: { type: 'sr-offline-save' } });
  await Promise.all(retry.waited);
  const done2 = w.clients.log.filter((m) => m.type === 'sr-offline-done').pop();
  assert.equal(done2.ok, true, 'the retry finishes the job: ' + JSON.stringify(done2.failed));
  const fetchedInRetry = w.state.fetched.slice(before);
  assert.deepEqual(fetchedInRetry, ['/assets/cars/ghost/CarConcept.data.bin'],
    'and it fetches exactly what was missing, nothing else: ' + JSON.stringify(fetchedInRetry));
});

// ------------------------------------------------------------- 4. the page half
test('the lobby owns the save control, and the old late registration is gone', () => {
  const html = read('public/index.html');
  assert.match(html, /id="sr-offline-btn"/, 'the button exists');
  assert.match(html, /SAVE FOR OFFLINE/, 'and says what it does');
  assert.match(html, /id="sr-offline-chip"/, 'there is a chip for "this game is on the device"');
  assert.match(html, /js\/offline-save\.js\?v=166/, 'the saver script is loaded');
  // the service worker is registered BEFORE load by offline-save.js - a racer who
  // lands and goes offline straight away must still get the game saved
  const saver = read('public/js/offline-save.js');
  assert.match(saver, /navigator\.serviceWorker\.register\('\/sw\.js'/, 'the saver registers the worker');
  assert.doesNotMatch(saver, /addEventListener\('load'/, 'not on window.load');
  assert.match(saver, /sr-offline-save/, 'and asks it to save');
  assert.doesNotMatch(html, /serviceWorker\.register/, 'the old inline registration is gone');
  assert.match(read('public/css/style.css'), /#sr-offline-chip/, 'the chip is styled');
});

test('a browser with no connection never fights itself with reloads', () => {
  const game = read('public/js/game.js');
  const guard = game.slice(game.indexOf("fetch(base + '/version')") - 500, game.indexOf("fetch(base + '/version')"));
  assert.match(guard, /navigator\.onLine === false\) return;/, 'the build/geometry reload guard stands down offline');
  // and the lobby says OFFLINE rather than pretending to be connected
  assert.match(game, /offline — no internet/, 'the lobby chip names the state');
  assert.match(read('public/js/offline.js'), /this\.status\('offline'\);/, 'the local link announces it');
  // the mode is preselected on a cold offline start
  assert.match(game, /function paintOfflineBoot\(\)/, 'there is one place that paints the offline boot');
  assert.match(game, /addEventListener\('offline', \(\) => \{/, 'and the connection dying mid-session is handled');
  assert.match(game, /addEventListener\('online', \(\) => \{/, 'and so is it coming back');
  // picking OFFLINE while online points the racer at the one step that makes the
  // APP work offline too
  assert.match(game, /SROfflineSave\.isReady\(\)/, 'the OFFLINE button knows whether the game is saved');
  assert.match(game, /SAVE FOR OFFLINE \(top of the lobby\)/, 'and says where to press');
});
