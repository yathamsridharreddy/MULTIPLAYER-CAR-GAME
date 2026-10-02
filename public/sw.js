/* ============================================================================
   SRIDHAR RUSH — service worker (v166)
   THE WHOLE GAME, SAVED ON THE DEVICE.

   v91 made the site installable and fast on repeat visits; v165 gave the game a
   mode that needs no server. v166 is the missing half: the app itself opens with
   no internet at all. A racer who opens the site once (or installs it) can turn
   on aeroplane mode, tap the icon, and the lobby, the cars, the maps, the arrows
   and the race are all there - because every file the first screen and a race
   need is fetched once and kept in this cache.

   Strategy:
   - SHELL: everything needed to boot the lobby AND race (scripts, styles, icons,
     map cards, car portraits, weather art, fonts). Pre-cached on install.
   - HEAVY: the 9.6 MB car model (gltf + bin + textures). Fetched by the racer's
     own "SAVE FOR OFFLINE" step (the page asks; progress is reported back), so
     an install stays light until it is asked for.
   - navigation      -> network-first, saved shell when the network is gone
                        (or does not answer within 4 s)
   - static assets   -> saved copy first, fill on miss
   - fonts           -> same, from fonts.googleapis.com / fonts.gstatic.com
   - /js/config.js   -> network-first with a saved copy for offline boots
   - /version, /api/*, /health, /lb ... -> never stored (live server data)
   - WebSocket traffic is untouched (service workers cannot see it)
   ========================================================================== */
const BUILD = 'v166';
const CACHE = 'sridhar-rush-' + BUILD;

// Everything a cold start with no internet must already have: the lobby, the car
// picker, the map cards, the arrow pad icons, the weather art and the whole game
// client. A test (test/offline-shell.test.js) fails if the page asks for a local
// file that is not covered here or in HEAVY.
const SHELL = [
  '/', '/controller', '/auth.html', '/replay',
  '/manifest.webmanifest', '/manifest-controller.webmanifest',
  '/css/style.css?v=166', '/css/controller.css?v=166',
  '/js/config.js',
  '/js/offline-save.js?v=166', '/js/offline.js?v=166',
  '/js/game-core.js?v=166', '/js/progression.js?v=166', '/js/net.js?v=166', '/js/game.js?v=166',
  '/js/controller.js?v=166', '/js/account.js?v=166', '/js/i18n.js?v=166', '/js/auth.js?v=166',
  '/js/replay.js?v=166', '/js/car-models.js?v=166',
  '/js/vendor/three.min.js', '/js/vendor/GLTFLoader.js?v=166', '/js/vendor/qrcode.js',
  '/js/vendor/post/CopyShader.js', '/js/vendor/post/LuminosityHighPassShader.js',
  '/js/vendor/post/ShaderPass.js', '/js/vendor/post/EffectComposer.js',
  '/js/vendor/post/RenderPass.js', '/js/vendor/post/UnrealBloomPass.js',
  // app icons
  '/icon.svg', '/img/icon-192.png', '/img/icon-512.png', '/img/icon-512-maskable.png', '/img/apple-touch-icon.png',
  // lobby art
  '/img/logo.png', '/img/lobby-bg.jpg',
  // the five circuit cards
  '/img/map-island.webp', '/img/map-neon.webp', '/img/map-canyon.webp', '/img/map-highland.webp', '/img/map-snow.webp',
  // car-select portraits
  '/img/cars/fury.webp', '/img/cars/storm.webp', '/img/cars/volt.webp', '/img/cars/viper.webp',
  '/img/cars/blaze.webp', '/img/cars/phantom.webp', '/img/cars/ghost.webp', '/img/cars/reaper.webp',
  // weather art (dry tarmac, rain, neon night, snow)
  '/img/weather/dry.webp', '/img/weather/wet.webp', '/img/weather/night.webp', '/img/weather/blizzard.webp',
  // the arrow pad (the rest of the two icon sets come from sw-icons.js)
  '/img/ico/arrow-down.svg', '/img/ico/arrow-left.svg', '/img/ico/arrow-right.svg', '/img/ico/arrow-up.svg',
  '/img/ico/nitro.svg'
];

// The icon sets and the car-model files are listed in sw-icons.js, which
// scripts/vercel-build.js regenerates from the directories on every build (and
// which is committed, so a plain `node server.js` has it too).
try { importScripts('/sw-icons.js?v=166'); } catch (err) {}
const ICON_FILES = (self.__SR_OFFLINE_FILES && self.__SR_OFFLINE_FILES.icons) || [];
const HEAVY = (self.__SR_OFFLINE_FILES && self.__SR_OFFLINE_FILES.heavy) || [];

// exposed for the offline-shell test (and for a console `__SR_OFFLINE_SHELL`)
self.__SR_OFFLINE_SHELL = SHELL;

// live data — always straight from the network, never stored
const NOCACHE = ['/version', '/health', '/lb', '/recent', '/daily', '/cup', '/ghost', '/a'];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

const OFFLINE_FALLBACK = '<!doctype html><meta charset="utf-8"><title>SRIDHAR RUSH — offline</title>'
  + '<body style="background:#05070c;color:#e8f6ff;font:600 15px/1.6 system-ui,sans-serif;padding:32px">'
  + '<h1 style="font-size:18px">This screen was not saved for offline play</h1>'
  + '<p>Open SRIDHAR RUSH once with internet, then use <b>SAVE FOR OFFLINE</b> in the lobby.</p></body>';

function shellList() { return SHELL.concat(ICON_FILES); }
function allList() { return SHELL.concat(ICON_FILES).concat(HEAVY); }

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try { await precache(shellList(), { quiet: true }); } catch (err) {}   // offline during install -> keep what we have
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ---- saving for offline -----------------------------------------------------
// Fetch every URL once and keep it. Already-cached entries are skipped, so a
// second save is instant and a failed download can simply be retried.
async function precache(list, opts) {
  const o = opts || {};
  const cache = await caches.open(CACHE);
  const failed = [];
  let done = 0;
  for (const url of list) {
    try {
      const hit = await cache.match(url);
      if (!hit) {
        const res = await fetch(new Request(url, { cache: 'no-cache' }));
        if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
        await cache.put(url, res.clone());
      }
    } catch (err) {
      failed.push(url);
    }
    done++;
    if (!o.quiet && (done % 4 === 0 || failed.length)) broadcast({ type: 'sr-offline-progress', done, total: list.length });
    if (o.quiet && failed.length > 2) break;      // install: do not hammer a dead network
  }
  return { done, total: list.length, failed };
}

async function saveEverything(source) {
  const list = allList().filter((u) => u !== '/js/config.js');
  broadcast({ type: 'sr-offline-progress', done: 0, total: list.length, started: true });
  const cache = await caches.open(CACHE);
  const failed = [];
  let done = 0;
  for (const url of list) {
    try {
      const hit = await cache.match(url);
      if (!hit) {
        const res = await fetch(new Request(url, { cache: 'no-cache' }));
        if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
        await cache.put(url, res.clone());
      }
    } catch (err) {
      failed.push(url);
    }
    done++;
    if (done % 3 === 0 || failed.length) broadcast({ type: 'sr-offline-progress', done, total: list.length });
  }
  const msg = { type: 'sr-offline-done', ok: failed.length === 0, done, total: list.length, failed: failed.slice(0, 12) };
  broadcast(msg);
  if (source && source.postMessage) { try { source.postMessage(msg); } catch (e) {} }
}

async function offlineStatus() {
  const cache = await caches.open(CACHE);
  const list = allList().filter((u) => u !== '/js/config.js');
  let have = 0;
  for (const u of list) if (await cache.match(u)) have++;
  return { type: 'sr-offline-status', build: BUILD, have, total: list.length, ready: have >= list.length };
}

async function broadcast(msg) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (const c of clients) { try { c.postMessage(msg); } catch (e) {} }
  } catch (e) {}
}

self.addEventListener('message', (e) => {
  const d = (e && e.data) || {};
  if (d.type === 'sr-offline-save') {
    e.waitUntil(saveEverything(e.source || null));
  } else if (d.type === 'sr-offline-status') {
    e.waitUntil((async () => {
      const st = await offlineStatus();
      const reply = (e.ports && e.ports[0]) || null;
      if (reply) { try { reply.postMessage(st); } catch (err) {} }
      if (e.source && e.source.postMessage) { try { e.source.postMessage(st); } catch (err) {} }
    })());
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) {
    // fonts: the theme's own typefaces, kept for offline like everything else
    if (FONT_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(e, { opaque: true }));
    return;                                            // other external requests untouched
  }
  if (NOCACHE.includes(url.pathname) || url.pathname.startsWith('/api/')) return;   // live endpoints untouched

  // 1. the HTML shell — fresh when the network answers, saved copy when it does not
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
        const res = await fetch(req, ctl ? { signal: ctl.signal } : undefined);
        if (timer) clearTimeout(timer);
        if (res && res.ok) { try { cache.put(req.url, res.clone()); } catch (err) {} return res; }
        throw new Error('HTTP ' + (res && res.status));
      } catch (err) {
        const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('/')) || (await cache.match('/index.html'));
        if (hit) return hit;
        return new Response(OFFLINE_FALLBACK, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // 2. the deploy's config (Supabase keys): fresh online, saved copy offline
  if (url.pathname === '/js/config.js') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) { try { cache.put('/js/config.js', res.clone()); } catch (err) {} return res; }
        throw new Error('HTTP ' + (res && res.status));
      } catch (err) {
        const hit = await cache.match('/js/config.js');
        if (hit) return hit;
        return new Response('window.SB_U="";window.SB_A="";', { headers: { 'Content-Type': 'application/javascript' } });
      }
    })());
    return;
  }

  // 3. every other static asset: saved copy first, fill the cache on a miss
  e.respondWith(cacheFirst(e, {}));
});

async function cacheFirst(e, opts) {
  const req = e.request;
  const cache = await caches.open(CACHE);
  const hit = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // opaque (cross-origin, no-cors) responses are still worth keeping: that is
    // what a Google Fonts file is, and offline it is exactly what we need.
    if (res && (res.ok || (opts.opaque && res.type === 'opaque'))) { try { cache.put(req, res.clone()); } catch (err) {} }
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}
