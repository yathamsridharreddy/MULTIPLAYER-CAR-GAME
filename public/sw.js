/* ============================================================================
   SRIDHAR RUSH — service worker (v36)
   Makes the game installable (home-screen app) and loads repeat visits fast.
   Purely additive: if this file is missing/broken the site works exactly as before.

   Strategy:
   - HTML pages      -> network-first, fall back to cache when offline
   - versioned files -> cache-first (?v=XX in the URL makes old caches harmless)
   - /js/config.js, /version, /health, /lb -> never cached (live server data)
   - WebSocket traffic is untouched (service workers cannot see it)
   ========================================================================== */
const CACHE = 'sridhar-rush-v61';

const CORE = [
  '/', '/controller',
  '/css/style.css?v=50', '/css/controller.css?v=50',
  '/js/game-core.js?v=50', '/js/net.js?v=50', '/js/game.js?v=50', '/js/controller.js?v=50', '/js/account.js?v=50', '/js/i18n.js?v=50',
  '/js/vendor/three.min.js', '/js/vendor/qrcode.js',
  '/js/vendor/post/CopyShader.js', '/js/vendor/post/LuminosityHighPassShader.js',
  '/js/vendor/post/ShaderPass.js', '/js/vendor/post/EffectComposer.js',
  '/js/vendor/post/RenderPass.js', '/js/vendor/post/UnrealBloomPass.js',
  '/manifest.webmanifest', '/manifest-controller.webmanifest', '/replay', '/js/replay.js?v=50',
  '/icon.svg', '/img/icon-192.png', '/img/icon-512.png',
  '/img/map-highland.webp', '/img/map-neon.webp', '/img/map-island.webp',
  '/img/map-canyon.webp', '/img/map-snow.webp'
];

// live data — always straight from the network, never stored
const NOCACHE = ['/js/config.js', '/version', '/health', '/lb', '/recent', '/daily', '/cup'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'no-cache' }))))
      .catch(() => {})            // offline during install -> skip precache, keep old cache
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;      // external requests untouched
  if (NOCACHE.includes(url.pathname)) return;           // live endpoints untouched

  if (req.mode === 'navigate') {
    // HTML: fresh when online, cached copy when offline
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req.url, copy)); return res; })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  // static assets: cache-first, fill cache on miss
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
