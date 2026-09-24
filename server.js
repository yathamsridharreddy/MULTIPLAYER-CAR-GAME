'use strict';

/**
 * VELOCITY RUSH — online multiplayer server
 * -----------------------------------------
 * Server-authoritative race rooms:
 *   - A laptop (screen) creates a room and gets a 5-letter code.
 *   - A friend opens the game with that code -> their laptop joins as the
 *     second screen. Phones join as controllers (joysticks).
 *   - The server runs the car physics (shared/game-core.js) at 30 Hz and
 *     streams state snapshots to every screen; screens interpolate for
 *     smooth low-latency rendering.
 *
 * Deploy: game pages on Vercel (static), this server on Render/Railway.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const core = require('./shared/game-core.js');
const prog = require('./shared/progression.js'); // v73 XP/Elo/tier math

const PORT = parseInt(process.env.PORT || '3000', 10);
// Opt-in lean mode for tight free tiers (set LOW_BANDWIDTH=1): race snapshots
// 30->20 Hz and phone telemetry 6->3 Hz. Sim rate stays 30 Hz; interpolation
// keeps motion smooth, so gameplay feel is unchanged while bandwidth drops ~1/3.
const LOW_BW = process.env.LOW_BANDWIDTH === '1';
const TICK_MS = 1000 / core.CFG.tickHz;
const IDLE_ROOM_MS = 10 * 60 * 1000;

const app = express();
app.disable('x-powered-by');

// Global CORS & pre-flight handler for cross-origin frontend (e.g. Vercel -> Koyeb)
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, Prefer, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// v94 AUDIT-F5: baseline security headers. These three cannot break the game
// (no MIME sniffing to lose, no referrer-dependent flow, no camera/mic/geo/
// payment use) and cost nothing. CSP and frame-busting are deliberately opt-in
// via env: this app ships inline <script>/<style> blocks and is embedded in
// preview iframes, so a strict policy has to be verified against the real
// deployment before it is turned on - see README "Hardening".
//   CSP="default-src 'self'; ..."        -> sends that Content-Security-Policy
//   FRAME_DENY=1                         -> sends X-Frame-Options: DENY
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()');
  if (req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (process.env.CSP) res.set('Content-Security-Policy', process.env.CSP);
  if (process.env.FRAME_DENY) res.set('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json());

// ---------------------------------------------------------------------------
// v94 AUDIT-F1: /a and /ghost read their request bodies by hand so they can keep
// their own size caps (2 KB and 400 KB). But express.json() above has ALREADY
// parsed and drained any request whose Content-Type is application/json, so
// those handlers never saw a single 'data' event, never saw 'end', and therefore
// never responded - the socket stayed pinned until Node's 300 s requestTimeout.
// The shipped client sends text/plain, so this never bit in the browser, but any
// JSON POST (a monitor, an integration, curl, a proxy that normalises the header,
// or an attacker in a loop) hung one connection for five minutes each: a trivial
// connection-exhaustion DoS against a single-process Node server.
// readCappedBody() uses the already-parsed body when there is one, streams
// otherwise, and ALWAYS resolves - so a response is guaranteed either way.
// ---------------------------------------------------------------------------
function readCappedBody(req, limit, watchdogMs) {
  return new Promise((resolve) => {
    if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      const s = Object.keys(req.body).length ? JSON.stringify(req.body) : '{}';
      return resolve(s.slice(0, limit));
    }
    let b = typeof req.body === 'string' ? req.body : '';
    // body-parser marks a drained request with _body; `readable` goes false once
    // the stream has ended. Either way there is nothing left to listen for.
    if (b.length || req._body === true || req.readable === false) return resolve(b.slice(0, limit));
    let done = false, watchdog = null;
    const finish = () => { if (!done) { done = true; if (watchdog) clearTimeout(watchdog); resolve(b.slice(0, limit)); } };
    watchdog = setTimeout(finish, watchdogMs || 10000); // never hang, whatever the client does
    req.on('data', (c) => { if (b.length < limit) b += c; });
    req.on('end', finish);
    req.on('error', finish);
    req.on('aborted', finish);
  });
}

// ---------------------------------------------------------------------------
// v94 AUDIT-F2: ghost payloads are stored verbatim and later replayed in OTHER
// players' browsers. The replay viewer filtered junk, but the in-race ghost
// loader did not: `data[data.length - 1][0]` on a payload of [null] or ["x"]
// threw inside the victim's snapshot handler and froze their live race. Anyone
// could upload such a ghost and share the link. Validate at the source so every
// consumer - current and future - only ever sees finite numbers in range.
// Format is the recorder's own: [t, x, z, heading] rounded to 2 decimals.
// ---------------------------------------------------------------------------
function sanitizeGhostData(raw) {
  if (!Array.isArray(raw) || raw.length < 10 || raw.length > 4000) return null;
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (!Array.isArray(f) || f.length < 3 || f.length > 8) return null;
    const t = Number(f[0]), x = Number(f[1]), z = Number(f[2]), h = Number(f[3] != null ? f[3] : 0);
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(h)) return null;
    if (t < 0 || t > 36000 || Math.abs(x) > 1e4 || Math.abs(z) > 1e4 || Math.abs(h) > 1e3) return null;
    out[i] = [+t.toFixed(2), +x.toFixed(2), +z.toFixed(2), +h.toFixed(2)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// v80 analytics engine — privacy-friendly funnel, retention & telemetry
// Persisted locally to analytics.json; resilient to crashes and file errors.
// ---------------------------------------------------------------------------
const AN_FILE = path.join(__dirname, 'analytics.json');
const CLASS_TELE = { velocity: { pick: 0, win: 0, fin: 0, posSum: 0, tSum: 0 }, accelerator: { pick: 0, win: 0, fin: 0, posSum: 0, tSum: 0 }, grip: { pick: 0, win: 0, fin: 0, posSum: 0, tSum: 0 } };
function classPick(cls) { const c = CLASS_TELE[cls]; if (c) c.pick++; }
function classResult(cls, pos, t, won) { const c = CLASS_TELE[cls]; if (!c) return; c.fin++; c.posSum += pos; if (t != null) c.tSum += t; if (won) c.win++; }

let AN = {
  counts: {
    visits: 0, gameStarts: 0, racesStarted: 0, racesCompleted: 0, secondRaces: 0,
    multiplayerRaces: 0, controllersConnected: 0, challengesSent: 0, challengesAccepted: 0,
    shares: 0, installs: 0, errors: 0
  },
  uniques: {
    visitors: 0, gameStarters: 0, raceStarters: 0, raceCompleters: 0, secondRacers: 0,
    multiplayerPlayers: 0, controllerUsers: 0, challengeSenders: 0, challengeAcceptors: 0, sharers: 0
  },
  byMap: [0, 0, 0, 0, 0],
  byMode: { race: 0, tt: 0, practice: 0, coop: 0, elim: 0, drift: 0 },
  byShare: { wa: 0, tg: 0, link: 0, code: 0, card: 0, ghost: 0, cup: 0, daily: 0, challenge: 0 },
  cohorts: {}, // YYYY-MM-DD -> { size: 0, d1: 0, d7: 0, d30: 0 }
  users: {},   // pid -> { f: "YYYY-MM-DD", fIdx: int, l: "YYYY-MM-DD", lIdx: int, stages: {} }
  lastErr: []
};

// Load existing analytics if present
function loadAnalytics(filePath = AN_FILE) {
  try {
    if (fs.existsSync(filePath)) {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (saved && typeof saved === 'object') {
        if (saved.counts) Object.assign(AN.counts, saved.counts);
        if (saved.uniques) Object.assign(AN.uniques, saved.uniques);
        if (saved.byMap && typeof saved.byMap === 'object') Object.assign(AN.byMap, saved.byMap);
        if (saved.byMode) Object.assign(AN.byMode, saved.byMode);
        if (saved.byShare) Object.assign(AN.byShare, saved.byShare);
        if (saved.cohorts) Object.assign(AN.cohorts, saved.cohorts);
        if (saved.users) Object.assign(AN.users, saved.users);
        if (Array.isArray(saved.lastErr)) AN.lastErr = saved.lastErr.slice(-10);
      }
    }
  } catch (e) {
    console.warn('[analytics] Failed to load ' + filePath + ' — starting fresh in memory');
  }
}

function persistAnalytics(filePath = AN_FILE) {
  try {
    const data = {
      counts: AN.counts,
      uniques: AN.uniques,
      byMap: AN.byMap,
      byMode: AN.byMode,
      byShare: AN.byShare,
      cohorts: AN.cohorts,
      users: AN.users,
      lastErr: AN.lastErr
    };
    fs.writeFileSync(filePath, JSON.stringify(data));
  } catch (e) {
    console.warn('[analytics] Auto-save failed:', e.message);
  }
}

loadAnalytics(AN_FILE);

let anSaveTimer = null;
function scheduleAnalyticsSave() {
  if (anSaveTimer) return;
  anSaveTimer = setTimeout(() => {
    anSaveTimer = null;
    persistAnalytics(AN_FILE);
  }, 5000);
  if (anSaveTimer.unref) anSaveTimer.unref();
}

function dayIndex(d = new Date()) { return Math.floor(d.getTime() / 86400000); }
function dayString(d = new Date()) { return d.toISOString().slice(0, 10); }

function recordUserEvent(pid, stageKey, uniqueCounterKey) {
  if (!pid || typeof pid !== 'string') return;
  pid = pid.slice(0, 32);
  const now = new Date();
  const todayStr = dayString(now);
  const todayIdx = dayIndex(now);

  let user = AN.users[pid];
  if (!user) {
    user = { f: todayStr, fIdx: todayIdx, l: todayStr, lIdx: todayIdx, stages: {} };
    AN.users[pid] = user;
    if (!AN.cohorts[todayStr]) AN.cohorts[todayStr] = { size: 0, d1: 0, d7: 0, d30: 0 };
    AN.cohorts[todayStr].size++;

    // Bounded memory protection: cap users map to 15,000 entries
    const userKeys = Object.keys(AN.users);
    if (userKeys.length > 15000) {
      for (let i = 0; i < 1000; i++) delete AN.users[userKeys[i]];
    }
  } else {
    const dayDiff = todayIdx - (user.fIdx || todayIdx);
    if (dayDiff === 1 && !user.d1) {
      user.d1 = true;
      if (AN.cohorts[user.f]) AN.cohorts[user.f].d1++;
    } else if (dayDiff >= 7 && dayDiff <= 8 && !user.d7) {
      user.d7 = true;
      if (AN.cohorts[user.f]) AN.cohorts[user.f].d7++;
    } else if (dayDiff >= 30 && dayDiff <= 31 && !user.d30) {
      user.d30 = true;
      if (AN.cohorts[user.f]) AN.cohorts[user.f].d30++;
    }
    user.l = todayStr;
    user.lIdx = todayIdx;
  }

  if (stageKey && uniqueCounterKey && !user.stages[stageKey]) {
    user.stages[stageKey] = 1;
    if (AN.uniques[uniqueCounterKey] != null) AN.uniques[uniqueCounterKey]++;
  }
}

app.post('/a', async (req, res) => {
  const b = await readCappedBody(req, 2000); // v94 AUDIT-F1: also answers JSON POSTs, which used to hang
  {
    try {
      const j = JSON.parse(b || '{}');
      const pid = typeof j.pid === 'string' ? j.pid : null;
      const e = String(j.e || '');

      switch (e) {
        case 'visit':
          AN.counts.visits++;
          recordUserEvent(pid, 'v', 'visitors');
          break;
        case 'game_start':
          AN.counts.gameStarts++;
          recordUserEvent(pid, 'g', 'gameStarters');
          break;
        case 'race':
          AN.counts.racesStarted++;
          if (j.map >= 0 && j.map < 5) AN.byMap[j.map]++;
          if (j.mode && AN.byMode[j.mode] != null) AN.byMode[j.mode]++;
          recordUserEvent(pid, 'r', 'raceStarters');
          break;
        case 'fin':
          AN.counts.racesCompleted++;
          recordUserEvent(pid, 'f', 'raceCompleters');
          break;
        case 'second_race':
          AN.counts.secondRaces++;
          recordUserEvent(pid, 's', 'secondRacers');
          break;
        case 'multiplayer':
          AN.counts.multiplayerRaces++;
          recordUserEvent(pid, 'm', 'multiplayerPlayers');
          break;
        case 'ctrl':
          AN.counts.controllersConnected++;
          recordUserEvent(pid, 'c', 'controllerUsers');
          break;
        case 'ch_send':
          AN.counts.challengesSent++;
          recordUserEvent(pid, 'cs', 'challengeSenders');
          break;
        case 'ch_accept':
          AN.counts.challengesAccepted++;
          recordUserEvent(pid, 'ca', 'challengeAcceptors');
          break;
        case 'share':
          AN.counts.shares++;
          if (j.channel && typeof j.channel === 'string') {
            const chKey = j.channel.slice(0, 16);
            AN.byShare[chKey] = (AN.byShare[chKey] || 0) + 1;
          }
          recordUserEvent(pid, 'sh', 'sharers');
          break;
        case 'inst':
          AN.counts.installs++;
          break;
        case 'err':
          AN.counts.errors++;
          AN.lastErr.push({ m: String(j.m || 'error').slice(0, 140), ts: Date.now() });
          if (AN.lastErr.length > 10) AN.lastErr.shift();
          break;
      }
      scheduleAnalyticsSave();
    } catch (err) {
      // Malformed analytics must never crash or throw
    }
    res.json({ ok: true });
  }
});

app.get('/stats', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const clsOut = {};
  for (const k of Object.keys(CLASS_TELE)) {
    const c = CLASS_TELE[k];
    clsOut[k] = { pick: c.pick, win: c.win, fin: c.fin, avgPos: c.fin ? +(c.posSum / c.fin).toFixed(2) : null, avgTime: c.fin ? +(c.tSum / c.fin).toFixed(2) : null };
  }

  // Calculate funnel conversions with explicit denominators
  const u = AN.uniques, c = AN.counts;
  const visitorToGameStart = u.visitors > 0 ? +(u.gameStarters / u.visitors).toFixed(4) : 0;
  const gameStartToRace = u.gameStarters > 0 ? +(u.raceStarters / u.gameStarters).toFixed(4) : 0;
  const raceStartToCompletion = c.racesStarted > 0 ? +(c.racesCompleted / c.racesStarted).toFixed(4) : 0;
  const completionToSecondRace = u.raceCompleters > 0 ? +(u.secondRacers / u.raceCompleters).toFixed(4) : 0;
  const multiplayerConversion = u.raceStarters > 0 ? +(u.multiplayerPlayers / u.raceStarters).toFixed(4) : 0;
  const controllerConversion = u.visitors > 0 ? +(u.controllerUsers / u.visitors).toFixed(4) : 0;
  const challengeAcceptance = c.challengesSent > 0 ? +(c.challengesAccepted / c.challengesSent).toFixed(4) : 0;

  // Calculate biggest drop-off stage
  const drops = [
    { stage: 'visitor_to_game_start', drop: 1 - visitorToGameStart },
    { stage: 'game_start_to_race_start', drop: 1 - gameStartToRace },
    { stage: 'race_start_to_completion', drop: 1 - raceStartToCompletion },
    { stage: 'completion_to_second_race', drop: 1 - completionToSecondRace }
  ];
  let biggestDrop = drops[0];
  for (const d of drops) { if (d.drop > biggestDrop.drop) biggestDrop = d; }

  // Calculate server-derived retention rates across cohorts
  const todayIdx = dayIndex();
  let d1Eligible = 0, d1Retained = 0;
  let d7Eligible = 0, d7Retained = 0;
  let d30Eligible = 0, d30Retained = 0;

  for (const [dateStr, cohort] of Object.entries(AN.cohorts)) {
    const cIdx = dayIndex(new Date(dateStr));
    const age = todayIdx - cIdx;
    if (age >= 1) { d1Eligible += cohort.size || 0; d1Retained += cohort.d1 || 0; }
    if (age >= 7) { d7Eligible += cohort.size || 0; d7Retained += cohort.d7 || 0; }
    if (age >= 30) { d30Eligible += cohort.size || 0; d30Retained += cohort.d30 || 0; }
  }

  const d1Rate = d1Eligible > 0 ? +(d1Retained / d1Eligible).toFixed(4) : null;
  const d7Rate = d7Eligible > 0 ? +(d7Retained / d7Eligible).toFixed(4) : null;
  const d30Rate = d30Eligible > 0 ? +(d30Retained / d30Eligible).toFixed(4) : null;

  res.json({
    ok: true,
    // Top-level backwards compatibility fields
    visits: c.visits,
    controller: c.controllersConnected,
    races: c.racesStarted,
    finishes: c.racesCompleted,
    installs: c.installs,
    errors: c.errors,
    byMap: AN.byMap,
    classes: clsOut,
    settleFails,
    ghost429,
    lastErr: AN.lastErr,

    // Rich analytics models
    counts: c,
    uniques: u,
    funnel: {
      visitorToGameStartRate: visitorToGameStart,
      gameStartToRaceRate: gameStartToRace,
      raceStartToCompletionRate: raceStartToCompletion,
      completionToSecondRaceRate: completionToSecondRace,
      multiplayerConversionRate: multiplayerConversion,
      controllerConversionRate: controllerConversion,
      challengeAcceptanceRate: challengeAcceptance,
      biggestDropOff: {
        stage: biggestDrop.stage,
        dropPercentage: +(biggestDrop.drop * 100).toFixed(2)
      }
    },
    retention: {
      d1RetentionRate: d1Rate,
      d7RetentionRate: d7Rate,
      d30RetentionRate: d30Rate,
      cohorts: Object.entries(AN.cohorts).slice(-14).map(([date, c]) => {
        const cIdx = dayIndex(new Date(date));
        const age = todayIdx - cIdx;
        return {
          date,
          size: c.size,
          d1Rate: (age >= 1 && c.size > 0) ? +(c.d1 / c.size).toFixed(3) : null,
          d7Rate: (age >= 7 && c.size > 0) ? +(c.d7 / c.size).toFixed(3) : null,
          d30Rate: (age >= 30 && c.size > 0) ? +(c.d30 / c.size).toFixed(3) : null
        };
      })
    },
    byMode: AN.byMode,
    byShare: AN.byShare
  });
});

// Dynamic client config. For local runs the server URL is same-origin
// ("local"). The Vercel deploy overwrites this file at build time with the
// public URL of this server.
app.get('/js/config.js', (req, res) => {
  // v96: never cacheable - by the browser OR by any CDN in front of it. This
  // response decides whether racer accounts (and, before v96, whether the whole
  // CLUBS/BADGES/BOUNTIES/GARAGE row was even shown) exist for this client. It
  // has no ?v= parameter, so a copy cached before SUPABASE_URL/SUPABASE_ANON were
  // configured is indistinguishable from a good one and silently disables them
  // for that one browser - two racers in the same lobby then see different games.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  // Public (anon) Supabase values for the browser, when configured.
  const sbU = process.env.SUPABASE_URL || '', sbA = process.env.SUPABASE_ANON || '';
  const sb = (sbU && sbA) ? 'window.SUPABASE_URL = ' + JSON.stringify(sbU) + ';\nwindow.SUPABASE_ANON = ' + JSON.stringify(sbA) + ';\n' : '';
  const cw = process.env.COMMUNITY_WA || '', cd = process.env.COMMUNITY_DC || '';
  const com = (cw ? 'window.COMMUNITY_WA = ' + JSON.stringify(cw) + ';\n' : '') + (cd ? 'window.COMMUNITY_DC = ' + JSON.stringify(cd) + ';\n' : '');
  res.type('application/javascript').send('window.SERVER_URL = "local";\n' + sb + com);
});

// shared game core (deterministic world + physics constants for the client)
// NOTE: Express 5 requires { root } for sendFile — an absolute path alone 404s
app.get('/js/game-core.js', (req, res) => {
  res.sendFile(path.join('shared', 'game-core.js'), { root: __dirname });
});

// friendly aliases used by the QR code / shared links
app.get(['/controller', '/join', '/phone'], (req, res) => {
  const room = req.query.room ? `?room=${encodeURIComponent(req.query.room)}` : '';
  res.redirect('/controller.html' + room);
});
app.get(['/game', '/screen'], (req, res) => {
  const room = req.query.room ? `?room=${encodeURIComponent(req.query.room)}` : '';
  res.redirect('/' + room);
});

// HTML must never be cached, otherwise browsers keep stale ?v= script refs and
// the client geometry drifts from the server (car appears off-track).
//
// (js/config.js sets its own no-store inside its handler below - it is answered
// before this middleware ever runs.)
app.get(['/', '/index.html', '/controller.html', '/controller'], (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 65536 }); // v77 BUG-003: oversized frames rejected by the library

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();   // code -> { room, screens:Set<ws>, controllers:Map<ws,slot> }
const matchQueue = [];     // ws clients waiting for Quick-Play matchmaking
const clientsByWs = new Map(); // ws -> client (for matchmaking pairing)

// ---------------------------------------------------------------------------
// Leaderboard (per-map, persisted to disk where available)
// ---------------------------------------------------------------------------
const LB_FILE = path.join(__dirname, 'leaderboard.json');
let leaderboard = {};
try { leaderboard = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); } catch (e) { leaderboard = {}; }

function lbAdd(mapId, entry) {
  const list = leaderboard[mapId] || (leaderboard[mapId] = []);
  // Account-lite: a returning player (same pid) updates their entry instead of
  // adding a duplicate row; keeps the board a true "top players" list.
  if (entry.pid) {
    const i = list.findIndex((r) => r.pid === entry.pid);
    if (i >= 0) {
      const r = list[i];
      r.name = entry.name;
      if (entry.t != null && (r.t == null || entry.t < r.t)) r.t = entry.t;
      if (entry.best != null && (r.best == null || entry.best < r.best)) r.best = entry.best;
      r.ts = entry.ts;
    } else list.push(entry);
  } else list.push(entry);
  list.sort((a, b) => (a.t == null ? 1e9 : a.t) - (b.t == null ? 1e9 : b.t));
  leaderboard[mapId] = list.slice(0, 20);
  try { fs.writeFileSync(LB_FILE, JSON.stringify(leaderboard)); } catch (e) {}
}
function lbGet(mapId) { return (leaderboard[mapId] || []).slice(0, 5); }

// ---------------------------------------------------------------------------
// v39 "alive lobby": global recent-finishes feed + daily challenge.
// Purely additive endpoints; the race/snapshot pipeline is untouched.
// ---------------------------------------------------------------------------
const recentFinishes = []; // ring buffer of the latest finishes across rooms
function recentAdd(entry) { recentFinishes.push(entry); if (recentFinishes.length > 30) recentFinishes.shift(); }
app.get('/recent', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json(recentFinishes.slice(-8).reverse());
});

// deterministic map-of-the-day (same for everyone, rotates at UTC midnight)
function dailyInfo() {
  const day = Math.floor(Date.now() / 86400000);
  const key = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const mid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  const endsInMs = Math.max(0, mid - now.getTime());
  const m = Math.floor(endsInMs / 60000);
  const endsInFormatted = `${Math.floor(m / 60)}h ${m % 60}m`;
  return { map: day % 5, key, endsInMs, endsInFormatted };
}

// v44 Founders Cup & v80 Weekly Championship: resets every Monday 00:00 UTC
function weekStartUTC() {
  const d = new Date();
  const mondayShift = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - mondayShift * 86400000;
}

function currentWeekKey() {
  const ws = weekStartUTC();
  const wd = new Date(ws);
  const onejan = new Date(Date.UTC(wd.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((wd.getTime() - onejan.getTime()) / 86400000) + onejan.getUTCDay() + 1) / 7);
  return `${wd.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function weeklyInfo() {
  const ws = weekStartUTC();
  const nextMonday = ws + 7 * 86400000;
  const endsInMs = Math.max(0, nextMonday - Date.now());
  const totalHours = Math.floor(endsInMs / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const endsInFormatted = `${days}d ${hours}h`;
  return { weekKey: currentWeekKey(), weekStartMs: ws, nextWeekMs: nextMonday, endsInMs, endsInFormatted };
}

// ---------------------------------------------------------------------------
// v80 Competitive Leaderboards & Storage (In-Memory Fallback + Supabase Sync)
// ---------------------------------------------------------------------------
const memPlayerStats = new Map(); // uid -> { uid, name, rating, peak_rating, xp, races, wins, podiums, streak, best_streak, daily_days, last_daily }
const memDailyComp = new Map();   // date_key -> Map<uid, { user_id, name, map, best_lap_ms, races_today, updated_at }>
const memWeeklyComp = new Map();  // week_key -> Map<uid, { user_id, name, points, races_week, wins_week, best_lap_ms, updated_at }>

async function getRatingRank(targetUid, ratingValue) {
  if (sbOn()) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/player_stats?rating=gt.' + (ratingValue || 1000) + '&select=user_id', { headers: sbHdr() });
      if (r.ok) {
        const rows = await r.json();
        return (rows && Array.isArray(rows) ? rows.length : 0) + 1;
      }
    } catch (e) {}
  }
  // In-memory fallback calculation
  let higher = 0;
  for (const [uid, st] of memPlayerStats) {
    if (uid !== targetUid && (st.rating || 1000) > (ratingValue || 1000)) higher++;
  }
  return higher + 1;
}

app.get('/cup', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const ws = weekStartUTC();
  let rows = [];
  if (sbOn()) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/leaderboard?updated_at=gte.' + new Date(ws).toISOString() + '&order=time_ms.asc&limit=40&select=map,name,time_ms',
        { headers: { apikey: SB_ROLE, Authorization: 'Bearer ' + SB_ROLE } });
      if (r.ok) rows = (await r.json()).map((x) => ({ map: x.map, name: x.name, t: x.time_ms / 1000 }));
    } catch (e) { rows = []; }
  }
  if (!rows.length) {
    for (const [m, list] of Object.entries(leaderboard))
      for (const r of list) if ((r.ts || 0) >= ws) rows.push({ map: parseInt(m, 10), name: r.name, t: r.t });
    rows.sort((a, b) => (a.t || 1e9) - (b.t || 1e9));
  }
  res.json(rows.slice(0, 5));
});
app.get('/daily', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json(dailyInfo());
});
function startOfTodayUTC() { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }

// ---------------------------------------------------------------------------
// v80 REST API: Competitive Hub Endpoints (Rating, Circuit, Daily, Weekly, Player)
// ---------------------------------------------------------------------------
app.get('/api/leaderboard', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const type = String(req.query.type || 'rating').toLowerCase();
  const scope = String(req.query.scope || 'top').toLowerCase();
  const mapId = Math.max(0, Math.min(4, parseInt(req.query.map, 10) || 0));
  const uid = req.query.uid ? String(req.query.uid) : null;
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  // v97: a racer owns several identities (auth uuid, device pid, the 'sb:<uuid>'
  // form, and - on rows written before v97 - their display name). Match on all of
  // them, otherwise the board cannot find the very person asking about their rank.
  const idents = racerIdentities(req.query);

  if (type === 'time') {
    let rows = [];
    if (sbOn()) {
      try {
        const r = await fetch(SB_URL + '/rest/v1/leaderboard?map=eq.' + mapId + '&order=time_ms.asc&limit=100&select=name,pid,time_ms,updated_at', { headers: sbHdr() });
        if (r.ok) {
          const raw = await r.json();
          rows = raw.map((x, idx) => ({
            rank: idx + 1,
            name: x.name,
            pid: x.pid,
            t: x.time_ms / 1000,
            timeFormatted: core.fmtTime(x.time_ms / 1000),
            updatedAt: x.updated_at
          }));
        }
      } catch (e) {}
    }
    if (!rows.length) {
      const mem = (leaderboard[mapId] || []).slice();
      mem.sort((a, b) => (a.t == null ? 1e9 : a.t) - (b.t == null ? 1e9 : b.t));
      rows = mem.map((x, idx) => ({
        rank: idx + 1,
        name: x.name,
        pid: x.pid,
        t: x.t,
        timeFormatted: core.fmtTime(x.t),
        updatedAt: new Date(x.ts || Date.now()).toISOString()
      }));
    }
    let userRank = null;
    const myRec = rows.find((r) => rowMatchesIdentities({ uid: r.pid, name: r.name }, idents));
    if (myRec) userRank = rows.indexOf(myRec) + 1;
    const myRecKey = myRec ? (myRec.pid || myRec.name) : uid;
    const total = rows.length;
    let outRows = rows;
    if (scope === 'nearby' && myRecKey) {
      const resBracket = prog.getNearbyBracket(rows, myRecKey, 2);
      outRows = resBracket.bracket.map((b) => Object.assign({}, b.item, { rank: b.rank }));
      if (resBracket.targetRank > 0) userRank = resBracket.targetRank;
    } else {
      outRows = rows.slice(offset, offset + limit);
    }
    return res.json({ ok: true, type: 'time', map: mapId, total, userRank, rows: outRows });
  }

  // Rating / Wins / Races board
  // v97: the durable rows and this dyno's live session are MERGED, and a racer is
  // matched by every identity they own. Before this, a single Supabase row hid every
  // RAM row (so a guest mid-session was missing from their own board), names came only
  // from profiles (every guest rendered as "RACER"), and total/userRank were capped by
  // the 100-row window - which is why the numbers looked invented rather than earned.
  const byKey = new Map();
  const boardRow = (s, name) => {
    const rating = Number(s.rating) || 1000;
    const races = Number(s.races) || 0;
    const wins = Number(s.wins) || 0;
    return {
      uid: String(s.user_id != null ? s.user_id : (s.uid != null ? s.uid : '')),
      name: String(name || s.name || '').slice(0, 16) || 'RACER',
      rating: rating,
      tier: prog.tier(rating),
      level: prog.levelFromXp(Number(s.xp) || 0).level,
      xp: Number(s.xp) || 0,
      wins: wins,
      races: races,
      winRate: (races > 0 ? +((wins / races) * 100).toFixed(1) : 0) + '%',
      podiums: Number(s.podiums) || 0,
      streak: Number(s.streak) || 0,
      bestStreak: Number(s.best_streak) || 0,
      updatedAt: s.updated_at || null
    };
  };
  const putRow = (key, row, durable) => {
    if (!key) return;
    row.uid = key;
    const prev = byKey.get(key);
    if (!prev) { row._durable = !!durable; byKey.set(key, row); return; }
    // same racer from both sources: keep whichever side knows more races; on a tie
    // prefer the durable copy, then the higher rating. Names never get downgraded
    // to the placeholder.
    const better = (row.races || 0) > (prev.races || 0)
      || ((row.races || 0) === (prev.races || 0) && !!durable && !prev._durable)
      || ((row.races || 0) === (prev.races || 0) && !!durable === !!prev._durable && (row.rating || 0) > (prev.rating || 0));
    if (better) {
      if ((!row.name || row.name === 'RACER') && prev.name) row.name = prev.name;
      row._durable = !!durable;
      byKey.set(key, row);
    } else if ((!prev.name || prev.name === 'RACER') && row.name && row.name !== 'RACER') {
      prev.name = row.name;
    }
  };

  let dbTotal = 0;
  if (sbOn()) {
    try {
      let orderCol = 'rating.desc,wins.desc,races.asc';
      if (type === 'wins') orderCol = 'wins.desc,rating.desc,races.asc';
      else if (type === 'races') orderCol = 'races.desc,wins.desc';
      // asking for a column the schema does not have yet would 400 the whole read
      const nameCol = sbStatsHasName === true ? ',name' : '';
      const [stR, prR] = await Promise.all([
        fetch(SB_URL + '/rest/v1/player_stats?order=' + orderCol + '&limit=100&select=user_id,rating,xp,races,wins,podiums,streak,best_streak,updated_at' + nameCol,
          { headers: Object.assign(sbHdr(), { Range: '0-99', Prefer: 'count=exact' }) }),
        fetch(SB_URL + '/rest/v1/profiles?select=id,username', { headers: sbHdr() })
      ]);
      if (stR.ok) {
        const statsData = await stR.json();
        const cr = String(stR.headers.get('content-range') || '');
        const totPart = String(cr.split('/')[1] || '').trim();
        dbTotal = /^\d+$/.test(totPart) ? parseInt(totPart, 10) : (Array.isArray(statsData) ? statsData.length : 0);
        const profMap = {};
        if (prR.ok) (await prR.json()).forEach((p) => { profMap[p.id] = p.username; });
        (Array.isArray(statsData) ? statsData : []).forEach((s) => {
          putRow(String(s.user_id), boardRow(s, profMap[s.user_id] || s.name), true);
        });
      }
    } catch (e) {}
  }

  for (const [key, s] of memPlayerStats) putRow(String(key), boardRow(s, s.name), false);

  let allRows = Array.from(byKey.values());
  if (type === 'wins') allRows.sort((a, b) => (b.wins || 0) - (a.wins || 0) || (b.rating || 0) - (a.rating || 0));
  else if (type === 'races') allRows.sort((a, b) => (b.races || 0) - (a.races || 0) || (b.wins || 0) - (a.wins || 0));
  else allRows.sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.wins || 0) - (a.wins || 0));
  allRows.forEach((r, i) => { r.rank = i + 1; delete r._durable; });

  const myRow = allRows.find((r) => rowMatchesIdentities(r, idents));
  const myKey = myRow ? myRow.uid : (idents[0] || '');
  const total = Math.max(dbTotal, allRows.length);
  let userRank = myRow ? myRow.rank : null;
  let rankExact = !!myRow;
  let me = myRow ? { uid: myRow.uid, rank: myRow.rank, name: myRow.name, rating: myRow.rating, tier: myRow.tier, level: myRow.level, wins: myRow.wins, races: myRow.races, winRate: myRow.winRate } : null;

  // v97: ranked outside the fetched window, the old code reported no rank at all and
  // the client then showed whatever the last rendered row happened to hold. Ask the
  // database for the honest position instead.
  if (!userRank && idents.length && sbOn()) {
    try {
      const q = 'user_id=in.(' + idents.map(encodeURIComponent).join(',') + ')&select=user_id,rating,races,wins,xp' + (sbStatsHasName === true ? ',name' : '');
      const r = await fetch(SB_URL + '/rest/v1/player_stats?' + q, { headers: sbHdr() });
      if (r.ok) {
        const mine = (await r.json())[0];
        if (mine) {
          const rating = Number(mine.rating) || 1000;
          const races = Number(mine.races) || 0;
          const wins = Number(mine.wins) || 0;
          userRank = await getRatingRank(String(mine.user_id), rating);
          rankExact = true;
          me = {
            uid: String(mine.user_id),
            rank: userRank,
            name: String(mine.name || '').slice(0, 16) || 'YOU',
            rating: rating,
            tier: prog.tier(rating),
            level: prog.levelFromXp(Number(mine.xp) || 0).level,
            wins: wins, races: races,
            winRate: (races > 0 ? +((wins / races) * 100).toFixed(1) : 0) + '%'
          };
        }
      }
    } catch (e) {}
  }
  const userPercentile = userRank ? prog.calculatePercentile(userRank, total) : null;

  let outRows = allRows;
  if (scope === 'nearby' && myKey) {
    const resBracket = prog.getNearbyBracket(allRows, myKey, 2);
    outRows = resBracket.bracket.map((b) => Object.assign({}, b.item, { rank: b.rank }));
    if (resBracket.targetRank > 0) userRank = resBracket.targetRank;
  } else {
    outRows = allRows.slice(offset, offset + limit);
  }

  res.json({ ok: true, type, total, userRank, userPercentile, rankExact, me, rows: outRows });
});

app.get('/api/competitions/daily', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const dInfo = dailyInfo();
  const mapMeta = core.MAPS[dInfo.map] || core.MAPS[0];

  // v97: durable rows and this dyno's live session are MERGED, and a racer is named
  // from their own row when they have no profiles entry. Before this, one database row
  // hid every RAM row - so a racer who had just set the fastest daily time was missing
  // from the board they led - and every guest rendered as "RACER".
  const idents = racerIdentities(req.query);
  const byUid = new Map();
  const dailyRow = (x, name) => ({
    uid: String(x.user_id),
    name: String(name || x.name || '').slice(0, 16) || 'RACER',
    bestMs: x.best_lap_ms,
    bestTime: x.best_lap_ms / 1000,
    bestFormatted: core.fmtTime(x.best_lap_ms / 1000),
    racesToday: x.races_today || 1
  });
  const putDaily = (row) => {
    const prev = byUid.get(row.uid);
    if (!prev) { byUid.set(row.uid, row); return; }
    const a = row.bestMs == null ? Infinity : row.bestMs;
    const b = prev.bestMs == null ? Infinity : prev.bestMs;
    if (a < b) {
      if ((!row.name || row.name === 'RACER') && prev.name) row.name = prev.name;
      byUid.set(row.uid, row);
    } else if ((!prev.name || prev.name === 'RACER') && row.name && row.name !== 'RACER') {
      prev.name = row.name;
    }
  };

  if (sbOn()) {
    try {
      const nameCol = sbCompHasName === true ? ',name' : '';
      const [dcR, prR] = await Promise.all([
        fetch(SB_URL + '/rest/v1/daily_competition?date_key=eq.' + dInfo.key + '&order=best_lap_ms.asc&limit=40&select=user_id,map,best_lap_ms,races_today,updated_at' + nameCol, { headers: sbHdr() }),
        fetch(SB_URL + '/rest/v1/profiles?select=id,username', { headers: sbHdr() })
      ]);
      if (dcR.ok) {
        const raw = await dcR.json();
        const profMap = {};
        if (prR.ok) (await prR.json()).forEach((p) => { profMap[p.id] = p.username; });
        (Array.isArray(raw) ? raw : []).forEach((x) => putDaily(dailyRow(x, profMap[x.user_id] || x.name)));
      }
    } catch (e) {}
  }

  for (const x of (memDailyComp.get(dInfo.key) || new Map()).values()) putDaily(dailyRow(x, x.name));

  const entries = Array.from(byUid.values())
    .sort((a, b) => (a.bestMs == null ? Infinity : a.bestMs) - (b.bestMs == null ? Infinity : b.bestMs))
    .map((e, idx) => Object.assign({ rank: idx + 1 }, e));

  const topTime = entries.length > 0 ? entries[0].bestTime : null;
  let userEntry = null;
  if (idents.length) {
    const found = entries.find((e) => rowMatchesIdentities(e, idents));
    if (found) {
      const gap = topTime != null ? +(found.bestTime - topTime).toFixed(2) : 0;
      userEntry = {
        rank: found.rank,
        bestMs: found.bestMs,
        bestFormatted: found.bestFormatted,
        racesToday: found.racesToday,
        gapToFirst: gap <= 0 ? 'LEADER 👑' : `+${gap}s`
      };
    }
  }

  res.json({
    ok: true,
    dateKey: dInfo.key,
    map: dInfo.map,
    mapName: mapMeta.name,
    endsInMs: dInfo.endsInMs,
    endsInFormatted: dInfo.endsInFormatted,
    targetTime: topTime,
    targetFormatted: topTime != null ? core.fmtTime(topTime) : 'No time yet',
    rewards: {
      first: '+150 XP, +100 Coins, Daily Champion Badge',
      podium: '+100 XP, +50 Coins',
      finish: '+30 XP, +10 Coins'
    },
    userEntry,
    leaderboard: entries.slice(0, 20)
  });
});

app.get('/api/competitions/weekly', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const wInfo = weeklyInfo();

  // v97: same merge as the Daily Cup - the durable week plus this dyno's session,
  // one row per racer, real names, most points first.
  const idents = racerIdentities(req.query);
  const byUid = new Map();
  const weeklyRow = (x, name) => ({
    uid: String(x.user_id),
    name: String(name || x.name || '').slice(0, 16) || 'RACER',
    points: Number(x.points) || 0,
    races: Number(x.races_week) || 0,
    wins: Number(x.wins_week) || 0,
    bestLapMs: x.best_lap_ms,
    bestLapFormatted: x.best_lap_ms ? core.fmtTime(x.best_lap_ms / 1000) : null
  });
  const putWeekly = (row) => {
    const prev = byUid.get(row.uid);
    if (!prev) { byUid.set(row.uid, row); return; }
    if ((row.points || 0) > (prev.points || 0) || ((row.points || 0) === (prev.points || 0) && (row.wins || 0) > (prev.wins || 0))) {
      if ((!row.name || row.name === 'RACER') && prev.name) row.name = prev.name;
      byUid.set(row.uid, row);
    } else if ((!prev.name || prev.name === 'RACER') && row.name && row.name !== 'RACER') {
      prev.name = row.name;
    }
  };

  if (sbOn()) {
    try {
      const nameCol = sbCompHasName === true ? ',name' : '';
      const [wcR, prR] = await Promise.all([
        fetch(SB_URL + '/rest/v1/weekly_competition?week_key=eq.' + wInfo.weekKey + '&order=points.desc,wins_week.desc&limit=40&select=user_id,points,races_week,wins_week,best_lap_ms,updated_at' + nameCol, { headers: sbHdr() }),
        fetch(SB_URL + '/rest/v1/profiles?select=id,username', { headers: sbHdr() })
      ]);
      if (wcR.ok) {
        const raw = await wcR.json();
        const profMap = {};
        if (prR.ok) (await prR.json()).forEach((p) => { profMap[p.id] = p.username; });
        (Array.isArray(raw) ? raw : []).forEach((x) => putWeekly(weeklyRow(x, profMap[x.user_id] || x.name)));
      }
    } catch (e) {}
  }

  for (const x of (memWeeklyComp.get(wInfo.weekKey) || new Map()).values()) putWeekly(weeklyRow(x, x.name));

  const entries = Array.from(byUid.values())
    .sort((a, b) => (b.points || 0) - (a.points || 0) || (b.wins || 0) - (a.wins || 0))
    .map((e, idx) => Object.assign({ rank: idx + 1 }, e));

  let userEntry = null;
  if (idents.length) {
    const found = entries.find((e) => rowMatchesIdentities(e, idents));
    if (found) {
      userEntry = {
        rank: found.rank,
        points: found.points,
        races: found.races,
        wins: found.wins,
        tier: found.rank <= 3 ? 'PODIUM 🏆' : (found.rank <= 10 ? 'TOP 10 ⭐' : 'CONTENDER')
      };
    }
  }

  res.json({
    ok: true,
    name: 'Founders Cup',
    weekKey: wInfo.weekKey,
    endsInMs: wInfo.endsInMs,
    endsInFormatted: wInfo.endsInFormatted,
    rewards: {
      first: '500 Coins, 500 XP, Legendary Founder Neon',
      top3: '250 Coins, 300 XP, Gold Founders Rim',
      top10: '100 Coins, 150 XP'
    },
    userEntry,
    leaderboard: entries.slice(0, 20)
  });
});

app.get('/api/player/competitive-stats', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const targetId = req.query.uid || req.query.pid;
  if (!targetId) return res.status(400).json({ ok: false, error: 'missing_id' });

  let st = null, profName = 'RACER', records = [];
  if (sbOn()) {
    try {
      const [stR, prR, recR] = await Promise.all([
        fetch(SB_URL + '/rest/v1/player_stats?user_id=eq.' + encodeURIComponent(targetId) + '&select=*', { headers: sbHdr() }),
        fetch(SB_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(targetId) + '&select=username', { headers: sbHdr() }),
        fetch(SB_URL + '/rest/v1/player_map_records?user_id=eq.' + encodeURIComponent(targetId) + '&select=*', { headers: sbHdr() })
      ]);
      if (stR.ok) { const j = await stR.json(); st = j[0] || null; }
      if (prR.ok) { const j = await prR.json(); if (j[0]) profName = j[0].username; }
      if (recR.ok) { records = await recR.json(); }
    } catch (e) {}
  }

  if (!st) {
    st = memPlayerStats.get(targetId) || {
      name: targetId, rating: 1000, peak_rating: 1000, xp: 0, races: 0, wins: 0, podiums: 0, streak: 0, best_streak: 0
    };
  }

  const globalRank = await getRatingRank(targetId, st.rating || 1000);
  const totalPlayers = sbOn() ? (await getRatingRank('non-existent-uid', 0)) : Math.max(1, memPlayerStats.size);
  const percentile = prog.calculatePercentile(globalRank, totalPlayers);
  const tier = prog.tier(st.rating || 1000);
  const winRate = st.races > 0 ? +((st.wins / st.races) * 100).toFixed(1) : 0;
  const podiumRate = st.races > 0 ? +((st.podiums / st.races) * 100).toFixed(1) : 0;

  const statsObj = {
    rating: st.rating || 1000,
    peakRating: st.peak_rating || 1000,
    tier,
    globalRank,
    totalPlayers,
    percentile,
    races: st.races || 0,
    wins: st.wins || 0,
    winRate: winRate + '%',
    podiums: st.podiums || 0,
    podiumRate: podiumRate + '%',
    currentStreak: st.streak || 0,
    bestStreak: st.best_streak || 0,
    mapRecords: records.map((r) => ({
      map: r.map,
      name: (core.MAPS[r.map] || {}).name || ('Circuit ' + r.map),
      bestLapMs: r.best_lap_ms,
      bestLapFormatted: r.best_lap_ms ? core.fmtTime(r.best_lap_ms / 1000) : '--:--.--',
      races: r.races || 0,
      wins: r.wins || 0
    }))
  };

  res.json({
    ok: true,
    uid: targetId,
    name: profName !== 'RACER' ? profName : (st.name || targetId),
    rating: st.rating || 1000,
    tier,
    globalRank,
    winRate: winRate + '%',
    bestTimes: records.reduce((acc, r) => { acc[r.map] = core.fmtTime(r.best_lap_ms / 1000); return acc; }, {}),
    stats: statsObj
  });
});

// ---------------------------------------------------------------------------
// v81/v82 Rivals, Daily Missions, Streaks, Seasons, Badges & Retention API
// ---------------------------------------------------------------------------
const memPlayerMissions = new Map(); // `${dateKey}:${uid}` -> Map<missionId, { progress, completed, claimed }>
const memEquippedBadges = new Map(); // uid -> badgeId
const memRevengeTargets = new Map(); // identity key -> [ { targetUid, targetName, map, mapId, mapName, targetRating, issuedAt } ]

// ---------------------------------------------------------------------------
// v93 REVENGE MATCH FIX. Three things used to break the "settle the score on
// the track where you lost" flow:
//   1. shape  - settlement wrote { mapId } while the client read `.map`, so the
//      banner said "on Circuit" and accepting always forced map 0 (Highland).
//   2. reach  - settlement keyed the store by the verified Supabase uuid (or the
//      car's display name for guests) while the client polled by display name
//      (or prefs.pid), so the earned banner was usually never found at all.
//   3. range  - the map id was never clamped, so ?map=99 produced a record no
//      track could satisfy and setMap() silently refused.
// Every record now goes through one normalizer (both keys, real map name,
// clamped id) and is written under EVERY identity the racer is known by, using
// the same alias normalisation the club sync (v90) already relies on.
// ---------------------------------------------------------------------------
const REVENGE_MAX = 5;

// returns null when the id does not name a real track, so each caller can decide
// between "fall back to track 0" (records) and "refuse" (live room changes)
function validMapId(v) {
  const n = parseInt(v, 10);
  return (isFinite(n) && core.MAPS[n]) ? n : null;
}

function normalizeRevengeTarget(t) {
  if (!t || !t.targetUid) return null;
  const v = validMapId(t.map != null ? t.map : t.mapId);
  const mapId = v == null ? 0 : v; // a record always names a real track
  return {
    targetUid: String(t.targetUid).slice(0, 64),
    targetName: String(t.targetName || 'RIVAL').slice(0, 24),
    map: mapId,       // what the client has always read
    mapId,            // what settlement used to write - kept for compatibility
    mapName: (core.MAPS[mapId] || {}).name || 'Circuit',
    targetRating: parseInt(t.targetRating, 10) || 1000,
    issuedAt: t.issuedAt || new Date().toISOString()
  };
}

// Lookups tolerate the normalized alias keys (what the club sync uses) AND the
// raw strings, because pre-v93 records were stored under whatever the settlement
// happened to hold - a uuid for signed-in racers, a capitalized display name for
// guests - and those rows must keep resolving after the upgrade.
function revengeKeys(ids, strongOnly) {
  const out = (strongOnly ? crewStrongKeys(ids) : crewKeysFor(ids)).slice();
  const push = (v) => { const k = v == null ? '' : String(v).trim(); if (k && out.indexOf(k) === -1) out.push(k); };
  if (ids) {
    push(ids.uid); push(ids.sbUid); push(ids.pid);
    if (!strongOnly) push(ids.name);
    if (Array.isArray(ids.aliases)) for (const a of ids.aliases) push(a);
  }
  return out;
}

// store under every identity this racer owns (uuid, sb:uuid, device pid, name)
function addRevengeTarget(ids, target) {
  const rec = normalizeRevengeTarget(target);
  if (!rec) return null;
  for (const k of revengeKeys(ids, false)) {
    const list = memRevengeTargets.get(k) || [];
    const i = list.findIndex((x) => x && x.targetUid === rec.targetUid);
    if (i >= 0) list[i] = rec; else list.push(rec);
    memRevengeTargets.set(k, list.slice(-REVENGE_MAX));
  }
  return rec;
}

// read back through any of those identities, deduped, newest first
function readRevengeTargets(ids, strongOnly) {
  const keys = revengeKeys(ids, !!strongOnly);
  const out = []; const seen = {};
  for (const k of keys) {
    for (const t of (memRevengeTargets.get(k) || [])) {
      const rec = normalizeRevengeTarget(t);
      if (rec && !seen[rec.targetUid]) { seen[rec.targetUid] = 1; out.push(rec); }
    }
  }
  out.sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
  return out;
}

function clearRevengeTarget(ids, targetUid) {
  for (const k of revengeKeys(ids, false)) {
    const list = memRevengeTargets.get(k);
    if (list && list.length) memRevengeTargets.set(k, list.filter((t) => t && t.targetUid !== targetUid));
  }
}

// the identities settlement knows for a finished racer
function revengeIdsFor(entry, slot, uid, name) {
  return {
    uid,
    sbUid: entry && entry.uidBySlot ? entry.uidBySlot[slot] : null,
    pid: entry && entry.pidBySlot ? entry.pidBySlot[slot] : null,
    name: name || null
  };
}
const memWeeklyBounties = new Map(); // `${weekKey}:${uid}` -> Map<bountyId, { progress, completed, claimed }>

function getOrInitWeeklyBounties(wKey, uid) {
  const bounties = prog.getWeeklyBounties(wKey);
  const userMap = bountiesMap(wKey, uid); // v95: shared with the persistence layer
  return bounties.map((b) => {
    const state = userMap.get(b.id) || { progress: 0, completed: false, claimed: false };
    return Object.assign({}, b, state);
  });
}

async function getAllRatingRows() {
  let allRows = [];
  if (sbOn()) {
    try {
      const [stR, prR] = await Promise.all([
        fetch(SB_URL + '/rest/v1/player_stats?order=rating.desc,wins.desc,races.asc&limit=100&select=user_id,rating,xp,races,wins,podiums,streak,best_streak,updated_at', { headers: sbHdr() }),
        fetch(SB_URL + '/rest/v1/profiles?select=id,username', { headers: sbHdr() })
      ]);
      if (stR.ok) {
        const statsData = await stR.json();
        const profMap = {};
        if (prR.ok) (await prR.json()).forEach((p) => { profMap[p.id] = p.username; });
        allRows = statsData.map((s, idx) => ({
          rank: idx + 1,
          uid: s.user_id,
          name: profMap[s.user_id] || 'RACER',
          rating: s.rating || 1000,
          tier: prog.tier(s.rating || 1000),
          level: prog.levelFromXp(s.xp || 0).level,
          xp: s.xp || 0,
          wins: s.wins || 0,
          races: s.races || 0,
          winRate: (s.races > 0 ? +((s.wins / s.races) * 100).toFixed(1) : 0) + '%',
          podiums: s.podiums || 0,
          streak: s.streak || 0,
          bestStreak: s.best_streak || 0,
          updatedAt: s.updated_at
        }));
      }
    } catch (e) {}
  }

  if (!allRows.length) {
    const list = Array.from(memPlayerStats.values());
    list.sort((a, b) => (b.rating || 1000) - (a.rating || 1000) || (b.wins || 0) - (a.wins || 0));
    allRows = list.map((s, idx) => ({
      rank: idx + 1,
      uid: s.uid,
      name: s.name || 'RACER',
      rating: s.rating || 1000,
      tier: prog.tier(s.rating || 1000),
      level: prog.levelFromXp(s.xp || 0).level,
      xp: s.xp || 0,
      wins: s.wins || 0,
      races: s.races || 0,
      winRate: (s.races > 0 ? +((s.wins / s.races) * 100).toFixed(1) : 0) + '%',
      podiums: s.podiums || 0,
      streak: s.streak || 0,
      bestStreak: s.best_streak || 0
    }));
  }
  return allRows;
}

function getOrInitMissions(dateKey, uid) {
  const defs = prog.getDailyMissions(dateKey);
  const mMap = missionsMap(dateKey, uid); // v95: shared with the persistence layer
  return defs.map((d) => {
    const st = mMap.get(d.id) || { progress: 0, completed: false, claimed: false };
    return Object.assign({}, d, {
      progress: Math.min(d.goal, st.progress),
      completed: st.completed || st.progress >= d.goal,
      claimed: !!st.claimed
    });
  });
}

app.get('/api/player/rivals', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const targetId = req.query.uid || req.query.pid;
  if (!targetId) return res.status(400).json({ ok: false, error: 'missing_id' });

  const allRows = await getAllRatingRows();
  const rivalData = prog.getCompetitiveRival(allRows, targetId);

  res.json({
    ok: true,
    uid: targetId,
    myRank: rivalData.myRank,
    myRating: rivalData.myRating,
    nextRival: rivalData.nextRival,
    lowerRival: rivalData.lowerRival
  });
});

app.get('/api/player/missions', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid || 'guest';
  const today = new Date().toISOString().slice(0, 10);
  await hydrateMissions(today, uid); // v95: today's progress survives a redeploy
  const missions = getOrInitMissions(today, uid);
  res.json({
    ok: true,
    dateKey: today,
    missions
  });
});

app.post('/api/player/missions/claim', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const b = req.body || {};
  const uid = b.uid || b.pid;
  const missionId = b.missionId;
  const dateKey = b.dateKey || new Date().toISOString().slice(0, 10);
  if (!uid || !missionId) return res.status(400).json({ ok: false, error: 'missing_fields' });

  // v95: hydrate before judging the claim. Without this a redeploy between
  // finishing a mission and claiming it answered 404 not_found and the reward
  // the player had earned simply vanished.
  await hydrateMissions(dateKey, uid);
  const mKey = `${dateKey}:${uid}`;
  const mMap = memPlayerMissions.get(mKey);
  if (!mMap) return res.status(404).json({ ok: false, error: 'not_found' });

  const st = mMap.get(missionId);
  const def = prog.DAILY_MISSION_CATALOG.find((m) => m.id === missionId);
  if (!st || !def) return res.status(404).json({ ok: false, error: 'invalid_mission' });

  if (st.progress < def.goal && !st.completed) {
    return res.status(400).json({ ok: false, error: 'not_completed' });
  }
  if (st.claimed) {
    return res.status(400).json({ ok: false, error: 'already_claimed' });
  }

  st.completed = true;
  st.claimed = true;
  mMap.set(missionId, st);

  // v95 rule 4: a claim that only exists in RAM can be repeated after the next
  // restart, so the reward is only handed over once the row is durable.
  if (sbOn() && !(await persistMissions(dateKey, uid, mMap, [missionId]))) {
    st.claimed = false;
    mMap.set(missionId, st);
    return res.status(503).json({ ok: false, error: 'claim_not_saved' });
  }

  const pSt = memPlayerStats.get(uid);
  if (pSt) {
    pSt.xp = (pSt.xp || 0) + def.xp;
    memPlayerStats.set(uid, pSt);
  }

  res.json({
    ok: true,
    missionId,
    xpAwarded: def.xp,
    coinsAwarded: 0 // v115 coins retired
  });
});

app.get('/api/player/streak', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const targetId = req.query.uid || req.query.pid;
  if (!targetId) return res.status(400).json({ ok: false, error: 'missing_id' });

  let st = null;
  if (sbOn()) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/player_stats?user_id=eq.' + encodeURIComponent(targetId) + '&select=streak,best_streak,last_daily', { headers: sbHdr() });
      if (r.ok) { const rows = await r.json(); st = rows[0] || null; }
    } catch (e) {}
  }
  if (!st) {
    st = memPlayerStats.get(targetId) || { streak: 0, best_streak: 0, last_daily: '' };
  }

  const today = new Date().toISOString().slice(0, 10);
  const racedToday = st.last_daily === today;
  const milestoneInfo = prog.getStreakMilestoneInfo(st.streak || 0);

  res.json({
    ok: true,
    uid: targetId,
    currentStreak: st.streak || 0,
    bestStreak: st.best_streak || 0,
    racedToday,
    milestoneInfo
  });
});

app.get('/api/season', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid;
  const season = prog.getCurrentSeason();

  let userSeason = null;
  if (uid) {
    let st = null;
    if (sbOn()) {
      try {
        const r = await fetch(SB_URL + '/rest/v1/player_stats?user_id=eq.' + encodeURIComponent(uid) + '&select=rating,peak_rating,xp', { headers: sbHdr() });
        if (r.ok) { const rows = await r.json(); st = rows[0] || null; }
      } catch (e) {}
    }
    if (!st) st = memPlayerStats.get(uid) || { rating: 1000, peak_rating: 1000, xp: 0 };

    const rank = await getRatingRank(uid, st.rating || 1000);
    const tier = prog.tier(st.rating || 1000);
    const bandKey = tier.name.split(' ')[0];
    userSeason = {
      seasonId: season.seasonId,
      rating: st.rating || 1000,
      peakRating: st.peak_rating || 1000,
      rank,
      tier,
      previewRewards: season.rewards[bandKey] || season.rewards.BRONZE
    };
  }

  res.json({
    ok: true,
    season,
    userSeason
  });
});

app.get('/api/ghost/best', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const mapId = Math.max(0, Math.min(4, parseInt(req.query.map, 10) || 0));
  if (sbOn()) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/ghosts?map=eq.' + mapId + '&order=created_at.desc&limit=1&select=id,map,name,data', { headers: sbHdr() });
      if (r.ok) {
        const rows = await r.json();
        if (rows && rows.length) return res.json({ ok: true, ghost: rows[0] });
      }
    } catch (e) {}
  }
  return res.json({ ok: true, ghost: null });
});

// v82 Badges & Profile Showcase
app.get('/api/player/badges', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid || 'guest';
  let st = memPlayerStats.get(uid) || { rating: 1000, peak_rating: 1000, xp: 0, races: 0, wins: 0, streak: 0, best_streak: 0 };
  const badges = prog.evaluateBadges(st);
  await hydrateEquippedBadge(uid); // v95: the equipped badge survives a redeploy
  const equipped = memEquippedBadges.get(uid) || 'speed_demon';
  badges.forEach(b => {
    b.equipped = (b.id === equipped || b.badgeId === equipped);
  });
  res.json({ ok: true, badges, equippedBadge: equipped });
});

app.post('/api/player/badge/equip', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const b = req.body || {};
  const uid = req.query.uid || b.uid;
  const badgeId = req.query.badgeId || b.badgeId;
  if (!uid || !badgeId) return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
  const prevBadgeId = memEquippedBadges.get(uid) || null; // v95: written back as equipped=false
  memEquippedBadges.set(uid, badgeId);
  if (sbOn() && !(await persistEquippedBadge(uid, badgeId, prevBadgeId))) {
    if (prevBadgeId) memEquippedBadges.set(uid, prevBadgeId); else memEquippedBadges.delete(uid);
    return res.status(503).json({ ok: false, error: 'equip_not_saved' });
  }
  res.json({ ok: true, equippedBadge: badgeId });
});

// v82 Revenge Match Engine
app.get('/api/player/revenge', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const q = req.query || {};
  const uid = q.uid || q.pid;
  if (!uid && !q.sbUid && !q.name) return res.json({ ok: true, targets: [], revengeTargets: [] });
  // v93: the browser sends every identity it owns (like the club calls do), so a
  // target written under the verified uuid is still found when the poll arrives
  // with the display name or the device pid.
  const revQueryIds = { uid, sbUid: q.sbUid, pid: q.pid, name: q.name, aliases: q.aliases };
  await hydrateRevenge(revQueryIds, false); // v95: grudges survive the redeploy they were earned before
  const list = readRevengeTargets(revQueryIds);
  res.json({ ok: true, targets: list, revengeTargets: list });
});

app.post('/api/player/revenge/issue', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const b = req.body || {};
  const uid = req.query.uid || b.uid;
  const targetUid = req.query.targetUid || b.targetUid;
  const vm = validMapId(req.query.map != null ? req.query.map : (b.map != null ? b.map : b.mapId));
  const mapId = vm == null ? 0 : vm; // v93 clamped to a real track
  if (!uid || !targetUid) return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });

  const issueIds = { uid, sbUid: b.sbUid || req.query.sbUid, pid: b.pid || req.query.pid, name: b.name || req.query.name };
  await hydrateRevenge(issueIds, false); // v95: append to the durable list, not to an empty one
  const targetObj = addRevengeTarget(
    issueIds,
    { targetUid, targetName: b.targetName || 'RIVAL', map: mapId, targetRating: b.targetRating, issuedAt: new Date().toISOString() }
  );
  // v95: a challenge that only lives in RAM cannot be answered after a redeploy.
  // Best-effort (rule 3) - the share link works either way.
  if (targetObj) persistRevengeTarget(issueIds, targetObj).catch(() => {});
  const shareMsg = prog.formatCompetitiveShare('revenge_challenge', {
    mapName: targetObj.mapName,
    link: `https://sridharrush.com/?map=${targetObj.map}`
  });
  res.json({ ok: true, shareMsg, target: targetObj });
});

// ---------------------------------------------------------------------------
// v111 LIVE REVENGE - A GRUDGE IS A REQUEST, NOT A SOLO RACE
// ---------------------------------------------------------------------------
// Until now "accept revenge" painted the rival's track and clicked START, which
// raced BOTS: the rival was never involved, never asked, and never there. The
// readouts were not the only casualty - the instant start also inherited held
// keys from the previous race, which is the stuck-nitro, uncontrollable car.
//
// The flow now is the one a grudge actually implies:
//   1. the LOSER sees the revenge banner and sends a REQUEST (challenges row,
//      mode 'revenge', status 'pending') addressed to the racer who beat them;
//   2. the WINNER sees it - live as a toast + banner if online, or in the lobby
//      the next time they open the game - and accepts or declines;
//   3. only an accept creates the race: the server opens a private room, seats
//      BOTH racers (bots off), starts the countdown and tells each who the
//      rival is. If one side is offline the request waits as 'accepted' and
//      resumes itself the moment both sockets are online again.
// ---------------------------------------------------------------------------
const revengeClientsByKey = new Map(); // identity key -> Set<client> (live sockets)
const revengeRoomStarted = new Set();  // challenge ids already turned into a room

function registerRevengeClient(client, msg) {
  const keys = revengeKeys({ uid: msg.uid, sbUid: msg.sbUid, pid: msg.pid, name: msg.name }, false);
  client.idKeys = keys;
  client.idName = (msg.name != null) ? String(msg.name).slice(0, 24) : null;
  client.idPid = (msg.pid != null) ? String(msg.pid).slice(0, 64) : null;
  for (const k of keys) {
    const set = revengeClientsByKey.get(k) || new Set();
    set.add(client);
    revengeClientsByKey.set(k, set);
  }
}
function unregisterRevengeClient(client) {
  for (const k of (client.idKeys || [])) {
    const set = revengeClientsByKey.get(k);
    if (set) { set.delete(client); if (!set.size) revengeClientsByKey.delete(k); }
  }
  client.idKeys = null;
}
function onlineRevengeClient(uid, name) {
  for (const k of revengeKeys({ uid, name }, false)) {
    const set = revengeClientsByKey.get(k);
    if (set) for (const c of set) if (c && c.ws && c.ws.readyState === 1) return c;
  }
  return null;
}
function pushRevengeToIdentity(uid, name, payload) {
  let n = 0;
  for (const k of revengeKeys({ uid, name }, false)) {
    const set = revengeClientsByKey.get(k);
    if (!set) continue;
    for (const c of set) if (c && c.ws && c.ws.readyState === 1) { sendJSON(c.ws, payload); n++; }
  }
  return n;
}
async function sbInsertReturn(table, row) {
  if (!sbOn()) return null;
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: Object.assign(sbHdr(), { Prefer: 'return=representation' }),
      body: JSON.stringify([row]),
      signal: AbortSignal.timeout(SB_TIMEOUT_MS)
    });
    if (!r.ok) { sbWarnOnce(table + ':insert', 'insert into ' + table + ' failed: HTTP ' + r.status); return null; }
    const j = await r.json();
    return Array.isArray(j) && j[0] ? j[0] : null;
  } catch (e) { sbWarnOnce(table + ':insert', 'insert into ' + table + ' unreachable: ' + e.message); return null; }
}

// Both racers online + an accepted grudge = the race both of them signed up for.
async function startRevengeRoom(row) {
  if (!row || !row.id || revengeRoomStarted.has(row.id)) return null;
  const a = onlineRevengeClient(row.from_uid, row.from_name);
  const b = onlineRevengeClient(row.to_uid, null);
  if (!a || !b || a === b) return null;
  revengeRoomStarted.add(row.id);
  const map = validMapId(row.map);
  const entry = newRoom('race', map == null ? 0 : map, 6);
  entry.room.setBot(false);                       // head-to-head: no stand-ins
  entry.room.setLaps(parseInt(row.laps, 10) || 3);
  leaveCurrentRoom(a);
  leaveCurrentRoom(b);
  joinRoom(a, entry, 'screen', { name: a.idName || row.from_name, pid: a.idPid || undefined });
  joinRoom(b, entry, 'screen', { name: b.idName || undefined, pid: b.idPid || undefined });
  if (a.slot) entry.room.setPlayerMeta(a.slot, { name: a.idName || row.from_name });
  if (b.slot) entry.room.setPlayerMeta(b.slot, { name: b.idName || 'RIVAL' });
  entry.room.start();
  broadcastLobby(entry);
  sendJSON(a.ws, { type: 'revenge_start', code: entry.room.code, map: map == null ? 0 : map, rival: b.idName || 'RIVAL' });
  sendJSON(b.ws, { type: 'revenge_start', code: entry.room.code, map: map == null ? 0 : map, rival: a.idName || row.from_name || 'RIVAL' });
  sbUpsertRows('challenges', [{ id: row.id, status: 'done' }]).catch(() => {});
  return entry;
}
async function resumeAcceptedRevenge(client) {
  const raws = (client.idKeys || []).filter(Boolean);
  if (!raws.length) return;
  const inList = '(' + raws.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(',') + ')';
  const rows = await sbSelect('challenges',
    'mode=eq.revenge&status=eq.accepted&or=(from_uid.in.' + inList + ',to_uid.in.' + inList + ')' +
    '&select=id,from_uid,from_name,to_uid,map,laps,status&order=id.desc&limit=3');
  if (!rows) return;
  for (const r of rows) { try { await startRevengeRoom(r); } catch (e) {} }
}

app.post('/api/player/revenge/request', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const b = req.body || {};
  const ids = { uid: b.uid || req.query.uid, sbUid: b.sbUid || req.query.sbUid, pid: b.pid || req.query.pid, name: b.name || req.query.name };
  const fromUid = ids.uid || ids.pid || ids.name;
  const targetUid = b.targetUid;
  if (!fromUid) return res.status(400).json({ ok: false, error: 'MISSING_IDENTITY' });
  if (!targetUid) return res.status(400).json({ ok: false, error: 'MISSING_TARGET' });
  const vm = validMapId(b.map != null ? b.map : b.mapId);
  const row = await sbInsertReturn('challenges', {
    from_uid: String(fromUid).slice(0, 64),
    from_name: String(b.fromName || ids.name || 'A RACER').slice(0, 24),
    to_uid: String(targetUid).slice(0, 64),
    map: vm == null ? 0 : vm,
    mode: 'revenge',
    laps: parseInt(b.laps, 10) || 3,
    status: 'pending'
  });
  if (!row) return res.json({ ok: false, error: 'STORAGE_UNAVAILABLE' });
  pushRevengeToIdentity(targetUid, null, {
    type: 'revenge_request', id: row.id, from_name: row.from_name, map: row.map, laps: row.laps
  });
  res.json({ ok: true, id: row.id });
});

// Incoming revenge requests for every identity this browser owns.
app.get('/api/player/challenges', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const q = req.query || {};
  const raws = [...new Set([q.uid, q.sbUid, q.pid, q.name].filter(Boolean))].map(String);
  if (!raws.length) return res.json({ ok: true, rows: [] });
  const inList = '(' + raws.map((x) => '"' + x.replace(/"/g, '""') + '"').join(',') + ')';
  const rows = await sbSelect('challenges',
    'mode=eq.revenge&status=in.(pending,accepted)&to_uid=in.' + inList +
    '&select=id,from_uid,from_name,map,laps,status&order=id.desc&limit=5');
  if (rows && rows.length) for (const r of rows) if (r.status === 'accepted') { try { await startRevengeRoom(r); } catch (e) {} }
  res.json({ ok: true, rows: rows || [] });
});

app.post('/api/player/revenge/accept', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const b = req.body || {};
  const id = parseInt(b.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'MISSING_ID' });
  const rows = await sbSelect('challenges', 'id=eq.' + id + '&mode=eq.revenge&select=id,from_uid,from_name,to_uid,map,laps,status');
  const row = rows && rows[0];
  if (!row) return res.json({ ok: false, error: 'NOT_FOUND' });
  const raws = [...new Set([b.uid, b.sbUid, b.pid, b.name].filter(Boolean))].map(String);
  if (!raws.includes(String(row.to_uid))) return res.status(403).json({ ok: false, error: 'NOT_YOURS' });
  if (row.status === 'pending') await sbUpsertRows('challenges', [{ id: row.id, status: 'accepted' }]);
  row.status = 'accepted';
  const entry = await startRevengeRoom(row);
  if (!entry) pushRevengeToIdentity(row.from_uid, row.from_name, { type: 'revenge_accepted', id: row.id, by_name: b.name || null });
  res.json({ ok: true, started: !!entry, code: entry ? entry.room.code : null });
});

app.post('/api/player/revenge/decline', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const b = req.body || {};
  const id = parseInt(b.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'MISSING_ID' });
  const rows = await sbSelect('challenges', 'id=eq.' + id + '&mode=eq.revenge&select=id,to_uid,status');
  const row = rows && rows[0];
  if (!row) return res.json({ ok: false, error: 'NOT_FOUND' });
  const raws = [...new Set([b.uid, b.sbUid, b.pid, b.name].filter(Boolean))].map(String);
  if (!raws.includes(String(row.to_uid))) return res.status(403).json({ ok: false, error: 'NOT_YOURS' });
  await sbUpsertRows('challenges', [{ id: row.id, status: 'declined' }]);
  res.json({ ok: true });
});

// v82 Weekly Syndicate Bounties
app.get('/api/competitions/weekly/bounties', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid || 'guest';
  const wKey = currentWeekKey();
  await hydrateBounties(wKey, uid); // v95: this week's bounty progress survives a redeploy
  const bounties = getOrInitWeeklyBounties(wKey, uid);
  res.json({ ok: true, weekKey: wKey, bounties });
});

app.post('/api/competitions/weekly/bounties/claim', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const b = req.body || {};
  const uid = req.query.uid || b.uid;
  const bountyId = req.query.bountyId || b.bountyId;
  const wKey = (b && b.weekKey) || req.query.weekKey || currentWeekKey();
  if (!uid || !bountyId) return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });

  await hydrateBounties(wKey, uid); // v95: judge the claim against durable state
  const key = `${wKey}:${uid}`;
  const bMap = memWeeklyBounties.get(key) || new Map();
  const bState = bMap.get(bountyId);
  const bounties = prog.getWeeklyBounties(wKey);
  const def = bounties.find(bt => bt.id === bountyId);

  if (!def || !bState || !bState.completed || bState.claimed) {
    return res.status(400).json({ ok: false, error: bState && bState.claimed ? 'ALREADY_CLAIMED' : 'NOT_COMPLETED' });
  }

  bState.claimed = true;
  bMap.set(bountyId, bState);
  memWeeklyBounties.set(key, bMap);

  // v95 rule 4: roll the claim back unless it is durable
  if (sbOn() && !(await persistBounties(wKey, uid, bMap, [bountyId]))) {
    bState.claimed = false;
    bMap.set(bountyId, bState);
    return res.status(503).json({ ok: false, error: 'claim_not_saved' });
  }

  const st = memPlayerStats.get(uid) || { rating: 1000, peak_rating: 1000, xp: 0, streak: 0, best_streak: 0, races: 0, wins: 0, podiums: 0, daily_days: 0, last_daily: '' };
  st.xp = (st.xp || 0) + def.xp;
  memPlayerStats.set(uid, st);

  res.json({ ok: true, claimed: true, xpAwarded: def.xp, coinsAwarded: 0 }); // v115 coins retired
});

// v82 Expanded Multi-Target Ghost Endpoint
app.get('/api/ghost/target', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const mapId = Math.max(0, Math.min(4, parseInt(req.query.map, 10) || 0));
  const type = req.query.type || req.query.target || 'record';
  const uid = req.query.uid || req.query.pid;

  if (type === 'rival' && uid) {
    const allRows = await getAllRatingRows();
    const rival = prog.getCompetitiveRival(allRows, uid).nextRival;
    if (rival && rival.uid) {
      if (sbOn()) {
        try {
          const r = await fetch(SB_URL + '/rest/v1/ghosts?map=eq.' + mapId + '&order=created_at.desc&limit=1&select=id,map,name,data', { headers: sbHdr() });
          if (r.ok) {
            const rows = await r.json();
            if (rows && rows.length) return res.json({ ok: true, type: 'rival', targetType: 'rival', targetName: rival.name, ghost: rows[0], targetTime: 45000, samples: [{ s: 0, t: 0, x: 0, z: 0, r: 0, spd: 0 }] });
          }
        } catch (e) {}
      }
      return res.json({ ok: true, type: 'rival', targetType: 'rival', targetName: rival.name, ghost: null, targetTime: 45000, samples: [{ s: 0, t: 0, x: 0, z: 0, r: 0, spd: 0 }] });
    }
  }

  if (sbOn()) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/ghosts?map=eq.' + mapId + '&order=created_at.desc&limit=1&select=id,map,name,data', { headers: sbHdr() });
      if (r.ok) {
        const rows = await r.json();
        if (rows && rows.length) return res.json({ ok: true, type: 'record', targetType: 'record', targetName: rows[0].name || 'Track Record', ghost: rows[0], targetTime: 42000, samples: rows[0].data || [{ s: 0, t: 0, x: 0, z: 0, r: 0, spd: 0 }] });
      }
    } catch (e) {}
  }
  return res.json({
    ok: true,
    type: type,
    targetType: type,
    targetName: type === 'rival' ? 'Rival Ghost' : 'Track Record',
    targetTime: 44000,
    ghost: null,
    samples: [{ s: 0, t: 0, x: 0, z: 0, r: 0, spd: 0 }, { s: 1, t: 22.0, x: 10, z: 20, r: 1.5, spd: 50 }]
  });
});

// v82 Dynamic Prioritized Next Best Action Guide
app.get('/api/player/next-action', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid || 'guest';
  const today = new Date().toISOString().slice(0, 10);
  const st = memPlayerStats.get(uid) || { rating: 1000, peak_rating: 1000, xp: 0, streak: 0, best_streak: 0, last_daily: '' };
  const allRows = await getAllRatingRows();
  const rivals = prog.getCompetitiveRival(allRows, uid);
  const streakInfo = prog.getStreakMilestoneInfo(st.streak || 0);
  streakInfo.racedToday = st.last_daily === today;
  const missions = getOrInitMissions(today, uid);
  const tr = prog.tier(st.rating || 1000);

  const nextAction = prog.getNextBestAction({
    streakInfo,
    missions,
    rivals,
    nextTier: tr.next
  });

  res.json({ ok: true, action: nextAction, nextAction });
});

// ---------------------------------------------------------------------------
// v83 Racing Syndicate Crews API & In-Memory Storage
// ---------------------------------------------------------------------------
const memCrews = new Map([
  ['apex', {
    id: 'apex',
    tag: 'REDL',
    name: 'Redline Motorsport',
    motto: 'Push past the limit, hold the racing line',
    badge: '🏁',
    color: '#ff3344',
    leaderUid: null,
    members: [],
    weeklyMeters: 0,
    totalMeters: 0,
    weeklyPoints: 0,
    created_at: new Date().toISOString()
  }],
  ['drift', {
    id: 'drift',
    tag: 'AKNA',
    name: 'Akina SpeedStars',
    motto: 'Precision downhill touge apex mastery',
    badge: '⚡',
    color: '#00e5ff',
    leaderUid: null,
    members: [],
    weeklyMeters: 0,
    totalMeters: 0,
    weeklyPoints: 0,
    created_at: new Date().toISOString()
  }],
  ['viper', {
    id: 'viper',
    tag: 'MDNT',
    name: 'Midnight Club Tokyo',
    motto: 'Rule the asphalt under city neon',
    badge: '🌃',
    color: '#b388ff',
    leaderUid: null,
    members: [],
    weeklyMeters: 0,
    totalMeters: 0,
    weeklyPoints: 0,
    created_at: new Date().toISOString()
  }],
  ['titan', {
    id: 'titan',
    tag: 'VLCX',
    name: 'Veloce Grand Prix',
    motto: 'Pure racing pedigree and unmatched speed',
    badge: '🏎️',
    color: '#ffd479',
    leaderUid: null,
    members: [],
    weeklyMeters: 0,
    totalMeters: 0,
    weeklyPoints: 0,
    created_at: new Date().toISOString()
  }],
  ['ghost', {
    id: 'ghost',
    tag: 'MNZA',
    name: 'Monza Oversteer Works',
    motto: 'Flat-out through every chicane',
    badge: '🔥',
    color: '#ff6d00',
    leaderUid: null,
    members: [],
    weeklyMeters: 0,
    totalMeters: 0,
    weeklyPoints: 0,
    created_at: new Date().toISOString()
  }]
]);

const memPlayerCrew = new Map();

const memClaimedCrewMilestones = new Map(); // `${crewId}:${tier}:${weekKey}:${memberKey}` -> true

// ---------------------------------------------------------------------------
// v96 WEEKLY CLUB ROLLOVER
//
// These counters are named weeklyMeters / weeklyPoints and the UI has always
// labelled them "WEEKLY MILEAGE" and "GRAND PRIX PTS" - but nothing ever reset
// them. Before v95 that was invisible, because a redeploy wiped the club anyway.
// Persisting the counters made the bug permanent: the Grand Prix would never
// restart, and whoever led in week one would lead forever.
//
// The rollover is LAZY, not a timer. Every read and write path calls
// rollCrewWeek() first, and a club whose weekKey is not this week's has its
// weekly counters zeroed and its weekKey advanced. That survives a server which
// was down over the Monday boundary, needs no scheduler, and can never zero a
// week that is still running. Lifetime totals are never touched.
//
// The boundary is currentWeekKey() - Monday 00:00 UTC - the same one the
// Founders Cup, the Weekly Championship and the weekly bounties already use, so
// a racer's whole week resets at a single moment.
function rollCrewWeek(c) {
  if (!c) return c;
  const wk = currentWeekKey();
  if (c.weekKey === wk) return c;
  c.weeklyMeters = 0;
  c.weeklyPoints = 0;
  for (const m of (c.members || [])) { m.weeklyMeters = 0; m.weeklyPoints = 0; }
  c.weekKey = wk;
  return c;
}

// One claim-key format, shared by the display path, the claim endpoint and both
// hydrators. The week is part of a claim's identity now: a milestone is
// collectable once per member PER WEEK, and last week's claim must not block
// this week's.
function crewClaimKey(crewId, tier, memberKey, weekKey) {
  return `${crewId}:${tier}:${weekKey || currentWeekKey()}:${memberKey}`;
}

// ---------------------------------------------------------------------------
// v90 CLUB SYNC FIX — identity aliasing
//
// One human racer is known to this server by several DIFFERENT strings:
//   • the club APIs are called with `SRAccount.name() || prefs.pid`  (browser)
//   • race settlement keys on the Supabase UUID returned by verifyUid(token)
//   • settlement falls back to the in-race display name when there is no token
//   • the handshake carries the device pid (`sb:<uuid>` once signed in)
// Club membership used to be stored under ONLY the first of those, while race
// mileage was credited under the second/third. Result: exactly one member per
// club — whoever's two keys happened to coincide — ever showed distance and
// points; everybody else stayed pinned at 0.0 km / 0 pts no matter how much
// they raced.
//
// Now every identity a member is seen with is registered as an ALIAS of the
// same membership, and every club lookup (get / join / create / claim /
// settlement / lobby tag) resolves through the alias set.
// Strong aliases (account uuid, device pid, client uid) are unique per human
// and always win. The display name is only a WEAK hint, used solely when it
// maps to exactly one club, so two racers sharing a nickname can never have
// their mileage folded into the wrong club or the wrong roster row.
// ---------------------------------------------------------------------------
const memCrewAliases = new Map();   // normalized strong identity -> crewId (last write wins)
const memCrewNameHints = new Map(); // normalized display name -> Set<crewId> (weak)

function normCrewKey(v) {
  if (v == null) return '';
  let k = String(v).trim();
  if (!k) return '';
  if (k.slice(0, 3).toLowerCase() === 'sb:') k = k.slice(3); // identityPayload() pid form
  return k.slice(0, 64).toLowerCase();
}

// account/device scoped ids — these uniquely identify one human
function crewStrongKeys(ids) {
  const out = [];
  const push = (v) => { const k = normCrewKey(v); if (k && out.indexOf(k) === -1) out.push(k); };
  if (!ids) return out;
  push(ids.uid); push(ids.sbUid); push(ids.pid);
  if (Array.isArray(ids.aliases)) for (const a of ids.aliases) push(a);
  return out;
}

// everything we could look a racer up by: strong keys first, display name last
function crewKeysFor(ids) {
  const keys = crewStrongKeys(ids);
  const n = normCrewKey(ids && ids.name);
  if (n && keys.indexOf(n) === -1) keys.push(n);
  return keys;
}

function mergeAliases(list, extra) {
  const out = [];
  for (const v of (list || []).concat(extra || [])) { const k = normCrewKey(v); if (k && out.indexOf(k) === -1) out.push(k); }
  return out;
}

function bindCrewIdentities(crewId, ids) {
  if (!crewId) return [];
  const strong = crewStrongKeys(ids);
  for (const k of strong) memCrewAliases.set(k, crewId);
  const n = normCrewKey(ids && ids.name);
  if (n) {
    let set = memCrewNameHints.get(n);
    if (!set) { set = new Set(); memCrewNameHints.set(n, set); }
    set.add(crewId);
  }
  return strong;
}

function unbindCrewIdentities(crewId, ids) {
  if (!crewId) return;
  for (const k of crewStrongKeys(ids)) if (memCrewAliases.get(k) === crewId) memCrewAliases.delete(k);
  const n = normCrewKey(ids && ids.name);
  const set = n ? memCrewNameHints.get(n) : null;
  if (set) { set.delete(crewId); if (!set.size) memCrewNameHints.delete(n); }
}

// Membership lookups that MUTATE data (leaving an old club on join/create) must
// never guess from a display name: two racers can share a nickname, and acting
// on the wrong club would strip somebody else's roster row. Only account/device
// scoped ids are trusted here.
function findCrewIdStrong(ids) {
  if (!ids) return null;
  for (const raw of [ids.uid, ids.sbUid, ids.pid]) {
    if (raw && memPlayerCrew.has(String(raw))) {
      const cid = memPlayerCrew.get(String(raw));
      if (memCrews.has(cid)) return cid;
    }
  }
  for (const k of crewStrongKeys(ids)) {
    const cid = memCrewAliases.get(k);
    if (cid && memCrews.has(cid)) return cid;
  }
  return null;
}

// Read-only lookups (settlement, GET /api/player/crew) may additionally fall
// back to a display name, but ONLY when that name maps to exactly one club —
// an ambiguous nickname resolves to nothing rather than to a guess.
function findCrewId(ids) {
  const strong = findCrewIdStrong(ids);
  if (strong) return strong;
  const n = normCrewKey(ids && ids.name);
  if (n) {
    const set = memCrewNameHints.get(n);
    if (set && set.size === 1) {
      const only = set.values().next().value;
      if (memCrews.has(only)) return only;
    }
  }
  return null;
}

// the roster row for this racer inside a club (so we never create a duplicate)
function findCrewMember(crew, ids) {
  if (!crew || !Array.isArray(crew.members)) return null;
  const strong = crewStrongKeys(ids);
  const rowKeys = (m) => {
    const out = [];
    const mk = normCrewKey(m && m.uid); if (mk) out.push(mk);
    if (m && Array.isArray(m.aliases)) for (const a of m.aliases) { const k = normCrewKey(a); if (k && out.indexOf(k) === -1) out.push(k); }
    return out;
  };
  for (const m of crew.members) {
    if (rowKeys(m).some((k) => strong.indexOf(k) !== -1)) return m; // strong match wins
  }
  const nameKey = normCrewKey(ids && ids.name);
  if (nameKey) {
    // legacy rows the old settlement path created keyed by display name — only
    // used when exactly one row carries that name, never to pick between two
    const byName = crew.members.filter((m) => normCrewKey(m.uid) === nameKey);
    if (byName.length === 1) return byName[0];
  }
  return null;
}

// A racer who joins or founds a club while already sitting in a lobby should
// see their syndicate tag immediately, not only after the next state change.
function refreshLobbyCrewTags(ids) {
  const keys = crewKeysFor(ids);
  if (!keys.length) return 0;
  let refreshed = 0;
  for (const entry of rooms.values()) {
    let hit = false;
    for (const slot of entry.slotByWs.values()) {
      const car = entry.room && entry.room.cars[slot - 1];
      const slotKeys = crewKeysFor({
        uid: entry.uidBySlot ? entry.uidBySlot[slot] : null,
        pid: entry.pidBySlot ? entry.pidBySlot[slot] : null,
        name: car && car.name
      });
      if (slotKeys.some((k) => keys.indexOf(k) !== -1)) { hit = true; break; }
    }
    if (hit) { try { broadcastLobby(entry); refreshed++; } catch (e) {} }
  }
  return refreshed;
}

// stats/XP caches are keyed by the SETTLEMENT identity (UUID when a token was
// verified, otherwise the display name), never by the browser's club uid — so
// rewards have to be written to whichever of those keys actually exists.
// v97: ONE canonical key per racer for every player-scoped row.
// Signed-in racers key on their verified auth uuid; guests key on the device pid
// the client already sends. Settlement used to key on the bare display name, which
// merged every racer who happened to share a name into one rating, orphaned a whole
// career on every rename, and could never be found by the pid the leaderboard sends.
function canonicalRacerKey(ids) {
  if (!ids) return '';
  const sb = String(ids.sbUid == null ? '' : ids.sbUid).trim();
  if (sb) return sb.replace(/^sb:/, '');
  const pid = String(ids.pid == null ? '' : ids.pid).trim();
  if (pid) return pid.replace(/^sb:/, '');
  const name = String(ids.name == null ? '' : ids.name).trim();
  if (name) return 'name:' + name.slice(0, 16);
  return '';
}

// v97: every identity one request could be talking about, best first. A racer is
// found by auth uuid, by device pid, by the 'sb:<uuid>' form the client sends while
// signed in, and by name - because rows written before v97 are keyed by name.
function racerIdentities(q) {
  const out = [];
  const push = (v) => { const s = String(v == null ? '' : v).trim(); if (s && out.indexOf(s) < 0) out.push(s); };
  if (!q) return out;
  push(q.sbUid);
  push(q.uid);
  push(q.pid);
  if (q.pid) push(String(q.pid).replace(/^sb:/, ''));
  if (q.sbUid) push('sb:' + q.sbUid);
  if (q.uid) push(String(q.uid).replace(/^sb:/, ''));
  if (q.name) { push('name:' + String(q.name).trim().slice(0, 16)); push(q.name); }
  return out;
}

function rowMatchesIdentities(row, idents) {
  if (!row || !idents || !idents.length) return false;
  const uid = String(row.uid == null ? (row.user_id == null ? '' : row.user_id) : row.uid);
  const nm = String(row.name == null ? '' : row.name);
  return idents.some((k) => (uid && uid === k) || (nm && nm === k));
}

// v97: fold one racer's career into another (guest device row -> account row).
// Histories are disjoint, so counters add; ratings and peaks take the best.
function mergeStatsRows(primary, other) {
  const a = primary || null, b = other || null;
  if (!a) return Object.assign({}, b || {});
  if (!b) return Object.assign({}, a);
  const num = (v) => Number(v) || 0;
  const rating = Math.max(num(a.rating) || 1000, num(b.rating) || 1000);
  const lastDaily = String(a.last_daily || '') > String(b.last_daily || '') ? String(a.last_daily || '') : String(b.last_daily || '');
  return {
    uid: a.uid || b.uid,
    user_id: a.user_id || b.user_id,
    name: a.name || b.name || '',
    rating: rating,
    peak_rating: Math.max(num(a.peak_rating) || 1000, num(b.peak_rating) || 1000, rating),
    xp: num(a.xp) + num(b.xp),
    races: num(a.races) + num(b.races),
    wins: num(a.wins) + num(b.wins),
    podiums: num(a.podiums) + num(b.podiums),
    streak: num(a.streak),
    best_streak: Math.max(num(a.best_streak), num(b.best_streak)),
    daily_days: Math.max(num(a.daily_days), num(b.daily_days)),
    last_daily: lastDaily,
    challenges_done: num(a.challenges_done) + num(b.challenges_done),
    updated_at: a.updated_at || b.updated_at || new Date().toISOString()
  };
}

function resolveStatsKey(ids) {
  for (const raw of [ids && ids.sbUid, ids && ids.pid, ids && ids.name, ids && ids.uid]) {
    if (raw && memPlayerStats.has(String(raw))) return String(raw);
  }
  return canonicalRacerKey(ids) || (ids && ids.uid) || 'guest';
}

// v97: the board reads a racer's name straight off their stats row once the column
// exists. Sending it before the migration runs would 400 the whole upsert and lose
// the rating with it, so the boot probe decides.
let sbStatsHasName = null;      // null = not probed yet
let sbStatsKeyType = null;      // 'text' | 'uuid' | probe verdict
let sbCompHasName = null;       // daily_competition / weekly_competition name column
function withCompName(name, row) {
  if (sbCompHasName === true && name) row.name = String(name).slice(0, 16);
  return row;
}

// v97: a cup row is a running total for its period, and the database copy mirrors
// the RAM copy rather than holding a disjoint history - so merging takes the best
// lap, the most races and the most points, never a sum (that would double-count).
function mergeDailyRow(prev, row) {
  const a = prev || {}, b = row || {};
  const la = a.best_lap_ms == null ? null : Number(a.best_lap_ms);
  const lb = b.best_lap_ms == null ? null : Number(b.best_lap_ms);
  return {
    user_id: String(a.user_id != null ? a.user_id : (b.user_id != null ? b.user_id : '')),
    name: (a.name && a.name !== 'RACER') ? a.name : (b.name || a.name || 'RACER'),
    map: a.map != null ? a.map : b.map,
    best_lap_ms: la == null ? lb : (lb == null ? la : Math.min(la, lb)),
    races_today: Math.max(Number(a.races_today) || 0, Number(b.races_today) || 0),
    updated_at: a.updated_at || b.updated_at || new Date().toISOString()
  };
}

function mergeWeeklyRow(prev, row) {
  const a = prev || {}, b = row || {};
  const la = a.best_lap_ms == null ? null : Number(a.best_lap_ms);
  const lb = b.best_lap_ms == null ? null : Number(b.best_lap_ms);
  return {
    user_id: String(a.user_id != null ? a.user_id : (b.user_id != null ? b.user_id : '')),
    name: (a.name && a.name !== 'RACER') ? a.name : (b.name || a.name || 'RACER'),
    points: Math.max(Number(a.points) || 0, Number(b.points) || 0),
    races_week: Math.max(Number(a.races_week) || 0, Number(b.races_week) || 0),
    wins_week: Math.max(Number(a.wins_week) || 0, Number(b.wins_week) || 0),
    best_lap_ms: la == null ? lb : (lb == null ? la : Math.min(la, lb)),
    updated_at: a.updated_at || b.updated_at || new Date().toISOString()
  };
}

// v97: seed a racer's cup totals from the database the first time this dyno sees
// them in the period. Without this a restart resumes the Daily and Founders Cups
// from zero and the next write overwrites the week's real total with one race's
// worth of points - which is how a leader lost their standing mid-week.
async function hydrateDailyComp(dKey, uid) {
  if (!sbOn() || uid == null || uid === '') return false;
  const key = `dailycomp|${dKey}|${uid}`;
  if (!claimHydration(key)) return false;
  const rows = await sbSelect('daily_competition',
    'user_id=eq.' + encodeURIComponent(uid) + '&date_key=eq.' + encodeURIComponent(dKey) + '&select=user_id,map,best_lap_ms,races_today');
  if (!rows) { forgetHydration(key); return false; }
  const dayMap = memDailyComp.get(dKey) || new Map();
  for (const r of rows) {
    const k = String(r.user_id);
    dayMap.set(k, mergeDailyRow(dayMap.get(k), r));
  }
  memDailyComp.set(dKey, dayMap);
  return true;
}

async function hydrateWeeklyComp(wKey, uid) {
  if (!sbOn() || uid == null || uid === '') return false;
  const key = `weeklycomp|${wKey}|${uid}`;
  if (!claimHydration(key)) return false;
  const rows = await sbSelect('weekly_competition',
    'user_id=eq.' + encodeURIComponent(uid) + '&week_key=eq.' + encodeURIComponent(wKey) + '&select=user_id,points,races_week,wins_week,best_lap_ms');
  if (!rows) { forgetHydration(key); return false; }
  const wkMap = memWeeklyComp.get(wKey) || new Map();
  for (const r of rows) {
    const k = String(r.user_id);
    wkMap.set(k, mergeWeeklyRow(wkMap.get(k), r));
  }
  memWeeklyComp.set(wKey, wkMap);
  return true;
}

function sbStatsState() {
  return { keyType: sbStatsKeyType, hasName: sbStatsHasName === true, compHasName: sbCompHasName === true, probed: sbStatsHasName !== null };
}
function withStatsName(name, row) {
  if (sbStatsHasName === true && name) row.name = String(name).slice(0, 16);
  return row;
}

// v97: a guest who signs in must not leave a second career behind on the board.
async function mergeRacerIdentity(fromKey, toKey) {
  const from = String(fromKey == null ? '' : fromKey).trim();
  const to = String(toKey == null ? '' : toKey).trim();
  if (!from || !to || from === to) return false;
  const fromRow = memPlayerStats.get(from);
  if (fromRow) {
    memPlayerStats.set(to, mergeStatsRows(memPlayerStats.get(to), fromRow));
    memPlayerStats.delete(from);
  }
  if (!sbOn()) return !!fromRow;
  try {
    const q = 'user_id=in.(' + [from, to].map(encodeURIComponent).join(',') + ')&select=*';
    const r = await fetch(SB_URL + '/rest/v1/player_stats?' + q, { headers: sbHdr() });
    if (!r.ok) return !!fromRow;
    const rows = await r.json();
    const mine = rows.find((x) => String(x.user_id) === to);
    const old = rows.find((x) => String(x.user_id) === from);
    if (!old) return !!fromRow;
    const merged = mergeStatsRows(mine, old);
    merged.user_id = to;
    delete merged.uid;
    const ok = await sbUpsertRows('player_stats', [merged]);
    if (ok) { try { await fetch(SB_URL + '/rest/v1/player_stats?user_id=eq.' + encodeURIComponent(from), { method: 'DELETE', headers: sbHdr() }); } catch (e) {} }
    return ok;
  } catch (e) { return !!fromRow; }
}

app.get(['/api/crews', '/api/crews/leaderboard'], async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  // v95: the board lists EVERY club, so it needs the user-created ones too -
  // after a restart memory holds only the five seeded presets.
  await hydrateAllCrews();
  const wInfo = weeklyInfo();
  const crews = Array.from(memCrews.values()).map((c) => {
    rollCrewWeek(c); // v96: a club last driven before Monday starts this week at zero
    const mileInfo = prog.getCrewMilestoneInfo(c.weeklyMeters);
    return {
      id: c.id,
      tag: c.tag,
      name: c.name,
      motto: c.motto,
      badge: c.badge,
      color: c.color,
      memberCount: (c.members || []).length,
      weeklyMeters: c.weeklyMeters || 0,
      weeklyKm: +(c.weeklyMeters / 1000).toFixed(1),
      totalMeters: c.totalMeters || 0,
      totalKm: +(c.totalMeters / 1000).toFixed(1),
      weeklyPoints: c.weeklyPoints || 0,
      currentTier: mileInfo.currentTier,
      progressPct: mileInfo.progressPct,
      nextMilestone: mileInfo.nextMilestone
    };
  });
  crews.sort((a, b) => (b.weeklyMeters || 0) - (a.weeklyMeters || 0));
  const ranked = crews.map((c, i) => ({ rank: i + 1, ...c }));
  // v96: the board is weekly, so say when the week ends - otherwise the numbers
  // vanish on a Monday with no explanation.
  res.json({ ok: true, count: ranked.length, weekKey: wInfo.weekKey, resetsIn: wInfo.endsInFormatted, crews: ranked });
});

app.get('/api/player/crew', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid || 'guest';
  // v90: the same racer may reach this endpoint by username, device pid or
  // Supabase uuid depending on sign-in state and device — resolve them all.
  const ids = {
    uid,
    sbUid: typeof req.query.sbUid === 'string' ? req.query.sbUid : '',
    pid: typeof req.query.pid === 'string' ? req.query.pid : '',
    name: typeof req.query.name === 'string' ? req.query.name : ''
  };
  const crewId = await findCrewIdDurable(ids); // v95: survives the redeploy it was joined before
  if (!crewId || !memCrews.has(crewId)) {
    return res.json({ ok: true, hasCrew: false, crew: null, presets: prog.CREW_PRESETS });
  }
  const c = memCrews.get(crewId);
  rollCrewWeek(c); // v96
  const wInfo = weeklyInfo();
  const milestoneInfo = prog.getCrewMilestoneInfo(c.weeklyMeters || 0);
  const member = findCrewMember(c, ids) || { uid, name: 'RACER', role: 'member', weeklyMeters: 0, totalMeters: 0, weeklyPoints: 0, aliases: [] };
  const claimId = member.uid || uid; // canonical per-member claim key

  const milestones = milestoneInfo.milestones.map((m) => ({
    ...m,
    // v96: keyed by week, so a tier collected last week is collectable again
    claimed: !!memClaimedCrewMilestones.get(crewClaimKey(c.id, m.tier, normCrewKey(claimId) || claimId)),
    canClaim: m.completed && !memClaimedCrewMilestones.get(crewClaimKey(c.id, m.tier, normCrewKey(claimId) || claimId))
  }));

  res.json({
    ok: true,
    hasCrew: true,
    crew: {
      id: c.id,
      tag: c.tag,
      name: c.name,
      motto: c.motto,
      badge: c.badge,
      color: c.color,
      leaderUid: c.leaderUid,
      isLeader: c.leaderUid === uid,
      weeklyMeters: c.weeklyMeters,
      weeklyKm: +(c.weeklyMeters / 1000).toFixed(1),
      totalMeters: c.totalMeters,
      totalKm: +(c.totalMeters / 1000).toFixed(1),
      weeklyPoints: c.weeklyPoints,
      weekKey: wInfo.weekKey,
      resetsIn: wInfo.endsInFormatted,
      currentTier: milestoneInfo.currentTier,
      progressPct: milestoneInfo.progressPct,
      nextMilestone: milestoneInfo.nextMilestone,
      milestones,
      myContribution: member,
      members: c.members || []
    }
  });
});

app.post('/api/player/crew/join', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { uid, name, crewId, pid, sbUid } = req.body || {};
  if (!uid || typeof uid !== 'string') return res.status(400).json({ ok: false, error: 'invalid_uid' });
  const cid = String(crewId || '').trim().toLowerCase();
  if (cid && !memCrews.has(cid)) await hydrateCrew(cid); // v95: a club created before the restart
  if (!memCrews.has(cid)) return res.status(404).json({ ok: false, error: 'crew_not_found' });
  const str = (v) => (typeof v === 'string' ? v.slice(0, 64) : '');
  const ids = { uid, name: str(name), pid: str(pid), sbUid: str(sbUid) };

  // Remove from old crew — matched by any STRONG alias, not just the raw uid,
  // and the stale aliases pointing at the old club are released.
  const oldCrewId = findCrewIdStrong(ids);
  if (oldCrewId && oldCrewId !== cid && memCrews.has(oldCrewId)) {
    const oldCrew = memCrews.get(oldCrewId);
    const me = findCrewMember(oldCrew, ids);
    oldCrew.members = (oldCrew.members || []).filter((m) => m !== me);
    unbindCrewIdentities(oldCrewId, { uid, name: ids.name, pid: ids.pid, sbUid: ids.sbUid, aliases: me && me.aliases });
    // v95: delete the old roster row too, or the next hydration walks this racer
    // straight back into the club they just left
    if (me) deleteCrewMemberRow(oldCrewId, me).catch(() => {});
  }

  const targetCrew = memCrews.get(cid);
  rollCrewWeek(targetCrew); // v96: joining in a new week joins a fresh scoreboard
  targetCrew.members = targetCrew.members || [];
  let member = findCrewMember(targetCrew, ids);
  if (!member) {
    member = {
      uid,
      name: (name && typeof name === 'string') ? name.slice(0, 16) : 'RACER',
      role: 'member',
      weeklyMeters: 0,
      totalMeters: 0,
      weeklyPoints: 0,
      aliases: [],
      joined_at: new Date().toISOString()
    };
    targetCrew.members.push(member);
  }
  // v90: learn every identity this racer uses so settlement finds this row
  member.aliases = mergeAliases(member.aliases, bindCrewIdentities(cid, ids));
  if (name && typeof name === 'string') member.name = name.slice(0, 16);
  memPlayerCrew.set(uid, cid);
  refreshLobbyCrewTags(ids); // v90: show the new tag in any live lobby straight away
  // v95: make the membership durable (rule 3 - best-effort; joining still works
  // for this session if the database is unreachable)
  persistCrewWithMember(targetCrew, member).catch(() => {}); // v96: club row first (foreign key)
  res.json({ ok: true, crewId: cid, tag: targetCrew.tag, name: targetCrew.name, member });
});

app.post('/api/player/crew/create', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { uid, name, crewName, tag, motto, color, badge, pid, sbUid } = req.body || {};
  if (!uid || typeof uid !== 'string') return res.status(400).json({ ok: false, error: 'invalid_uid' });
  const idStr = (v) => (typeof v === 'string' ? v.slice(0, 64) : '');
  if (!prog.validCrewName(crewName)) return res.status(400).json({ ok: false, error: 'invalid_crew_name' });
  if (!prog.validCrewTag(tag)) return res.status(400).json({ ok: false, error: 'invalid_crew_tag' });

  const cleanTag = tag.trim().toUpperCase();
  const cleanName = crewName.trim();
  const crewId = cleanTag.toLowerCase();

  // check duplicate tag - v95: against every club that has ever existed, not just
  // the ones this process remembers. Without the hydrate a restart handed the same
  // 4-letter tag to a second club and split its roster.
  await hydrateAllCrews();
  for (const c of memCrews.values()) {
    if (c.tag === cleanTag) return res.status(409).json({ ok: false, error: 'tag_taken' });
  }

  // Remove from old crew (strong aliases only, same as /join)
  const founderIds = { uid, name: idStr(name), pid: idStr(pid), sbUid: idStr(sbUid) };
  const oldCrewId = findCrewIdStrong(founderIds);
  if (oldCrewId && memCrews.has(oldCrewId)) {
    const oldCrew = memCrews.get(oldCrewId);
    const me = findCrewMember(oldCrew, founderIds);
    oldCrew.members = (oldCrew.members || []).filter((m) => m !== me);
    unbindCrewIdentities(oldCrewId, { uid, name: founderIds.name, pid: founderIds.pid, sbUid: founderIds.sbUid, aliases: me && me.aliases });
    if (me) deleteCrewMemberRow(oldCrewId, me).catch(() => {}); // v95
  }

  const newCrew = {
    id: crewId,
    tag: cleanTag,
    name: cleanName,
    motto: (motto && typeof motto === 'string') ? motto.slice(0, 60) : 'Apex Velocity Syndicate',
    badge: (badge && typeof badge === 'string') ? badge.slice(0, 4) : '⚡',
    color: (color && typeof color === 'string') ? color : '#ff4444',
    leaderUid: uid,
    members: [{
      uid,
      name: (name && typeof name === 'string') ? name.slice(0, 16) : 'RACER',
      role: 'leader',
      weeklyMeters: 0,
      totalMeters: 0,
      weeklyPoints: 0,
      aliases: mergeAliases([], bindCrewIdentities(crewId, founderIds)), // v90 club sync
      joined_at: new Date().toISOString()
    }],
    weeklyMeters: 0,
    totalMeters: 0,
    weeklyPoints: 0,
    weekKey: currentWeekKey(), // v96: a new club starts in this week
    created_at: new Date().toISOString()
  };

  memCrews.set(crewId, newCrew);
  memPlayerCrew.set(uid, crewId);
  refreshLobbyCrewTags(founderIds); // v90: show the new tag in any live lobby straight away
  // v95: a founded club must outlive the process it was founded in
  persistCrewWithMember(newCrew, newCrew.members[0]).catch(() => {}); // v96: club row first (foreign key)

  res.json({ ok: true, crew: newCrew });
});

app.post('/api/player/crew/claim-milestone', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { uid, tier, pid, sbUid, name } = req.body || {};
  if (!uid || typeof uid !== 'string') return res.status(400).json({ ok: false, error: 'invalid_uid' });
  const tierNum = parseInt(tier, 10);
  const clStr = (v) => (typeof v === 'string' ? v.slice(0, 64) : '');
  const ids = { uid, pid: clStr(pid), sbUid: clStr(sbUid), name: clStr(name) };
  const crewId = await findCrewIdDurable(ids); // v90: any identity; v95: any boot
  if (!crewId || !memCrews.has(crewId)) return res.status(404).json({ ok: false, error: 'no_crew' });

  const crew = memCrews.get(crewId);
  // v96: roll BEFORE the gate check, or last week's kilometres unlock this
  // week's tier and pay out a reward nobody has earned yet.
  rollCrewWeek(crew);
  const mileDef = prog.CREW_MILESTONES.find((m) => m.tier === tierNum);
  if (!mileDef) return res.status(400).json({ ok: false, error: 'invalid_tier' });
  if ((crew.weeklyMeters || 0) < mileDef.reqMeters) return res.status(400).json({ ok: false, error: 'milestone_unreached' });

  // v90: the claim is keyed by the CANONICAL roster uid, so a member who
  // reached the endpoint through two different aliases still claims once.
  const claimMember = findCrewMember(crew, ids);
  // v95: keyed on the NORMALIZED roster identity, which is part of the primary
  // key of crew_milestone_claims - so a claim made before a restart is still a
  // claim afterwards, and cannot be collected twice.
  const claimMemberKey = normCrewKey((claimMember && claimMember.uid) || uid) || String(uid).slice(0, 64);
  // v96: the claim belongs to the week the kilometres were driven in - read off
  // the crew that rollCrewWeek() just stamped, never recomputed. Recomputing
  // would let a claim submitted at exactly Monday 00:00:00 UTC land in RAM under
  // the new week while its database row carried the old one, which is a reward
  // paid out twice.
  const claimWeek = crew.weekKey || currentWeekKey();
  const claimKey = crewClaimKey(crew.id, tierNum, claimMemberKey, claimWeek);
  if (memClaimedCrewMilestones.get(claimKey)) return res.status(400).json({ ok: false, error: 'already_claimed' });

  memClaimedCrewMilestones.set(claimKey, true);
  // v95 rule 4: the milestone pays XP and coins, so the claim only stands once it
  // is durable - otherwise the next restart hands the same reward out again.
  if (sbOn() && !(await persistCrewClaim(crew.id, tierNum, claimMemberKey, claimWeek))) {
    memClaimedCrewMilestones.delete(claimKey);
    return res.status(503).json({ ok: false, error: 'claim_not_saved' });
  }

  // award XP and coins to the stats row settlement actually writes to
  const statsKey = resolveStatsKey(ids);
  const st = memPlayerStats.get(statsKey) || { rating: 1000, peak_rating: 1000, xp: 0, streak: 0, best_streak: 0, races: 0, wins: 0, podiums: 0, daily_days: 0, last_daily: '' };
  st.xp = (st.xp || 0) + mileDef.reward.xp;
  memPlayerStats.set(statsKey, st);

  res.json({
    ok: true,
    tier: tierNum,
    reward: mileDef.reward,
    xpAwarded: mileDef.reward.xp,
    coinsAwarded: 0, // v115 coins retired
    newXp: st.xp
  });
});

// ---------------------------------------------------------------------------
// Optional Supabase persistence (v37): cross-device global leaderboard.
// Additive by design — without SUPABASE_URL + SUPABASE_SERVICE_ROLE env vars
// the file/memory leaderboard above is used and nothing else changes.
// Writes use the service role (server only); the browser never sees it.
// ---------------------------------------------------------------------------
const SB_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_ROLE = String(process.env.SUPABASE_SERVICE_ROLE || '');
const sbOn = () => !!(SB_URL && SB_ROLE && typeof fetch === 'function');

// ---------------------------------------------------------------------------
// v73 — server-authoritative player platform settlement (accounts, XP, Elo,
// history). Identity: screens optionally send their Supabase ACCESS TOKEN in
// hello; we verify it against Supabase Auth — a client-supplied uid is never
// trusted. All writes use the service role; RLS denies client writes.
// ---------------------------------------------------------------------------
const SB_ANON = String(process.env.SUPABASE_ANON || '');
const tokCache = new Map();
async function verifyUid(tok) {
  if (!sbOn() || typeof tok !== 'string' || tok.length < 20) return null;
  const hit = tokCache.get(tok);
  if (hit && hit.exp > Date.now()) return hit.uid;
  try {
    const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_ANON || SB_ROLE, Authorization: 'Bearer ' + tok } });
    if (!r.ok) return null;
    const j = await r.json();
    const uid = j && j.id ? String(j.id) : null;
    if (uid) { tokCache.set(tok, { uid, exp: Date.now() + 300000 }); if (tokCache.size > 800) tokCache.clear(); }
    return uid;
  } catch (e) { return null; }
}
const sbHdr = () => ({ apikey: SB_ROLE, Authorization: 'Bearer ' + SB_ROLE, 'Content-Type': 'application/json' });

// ---------------------------------------------------------------------------
// v95 AUDIT-P1: DURABLE PROGRESSION
// ---------------------------------------------------------------------------
// Until now, daily missions, weekly bounties, equipped badges, revenge targets
// and club rosters lived ONLY in the Maps declared above. A redeploy - which on
// Render happens on every push - wiped all of it: a racer who had driven 18 of
// 20 laps toward a mission came back to zero, and a completed-but-unclaimed
// reward was refused with NOT_COMPLETED because its row no longer existed.
//
// Design rules, each one deliberate:
//
//   1. Memory stays the hot cache. Reads are served from the Maps exactly as
//      before; the database is merged in ONCE per period per player after a boot
//      (the `hydrated` set), so the race loop never waits on a round trip.
//   2. Merges are MONOTONIC: progress takes the max, completed/claimed take the
//      OR. A claim can never be undone and progress can never go backwards, so
//      hydrating can neither erase laps already driven nor re-grant a reward.
//   3. Every call is bounded (SB_TIMEOUT_MS) and failure-tolerant: if Supabase
//      is slow or down the game plays on from memory, and the error is logged
//      once per table rather than once per request.
//   4. Reward CLAIMS are the one place a write must succeed. A claim that exists
//      only in RAM can be repeated after the next restart, so if the row cannot
//      be persisted the claim is rolled back and refused.
// ---------------------------------------------------------------------------
const SB_TIMEOUT_MS = 4000;
const sbWarned = new Set();
function sbWarnOnce(key, msg) {
  if (sbWarned.has(key)) return;
  sbWarned.add(key);
  console.warn('[db] ' + msg + ' (further "' + key + '" errors suppressed until restart)');
}

// Returns an array of rows, or null when the database is off/unreachable. Callers
// MUST treat null as "unknown" (fall back to memory), never as "empty" - reading
// an empty set back as truth would erase a player's progress on a network blip.
async function sbSelect(table, query) {
  if (!sbOn()) return null;
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + table + '?' + query, {
      headers: sbHdr(), signal: AbortSignal.timeout(SB_TIMEOUT_MS)
    });
    if (!r.ok) { sbWarnOnce(table + ':read', 'select from ' + table + ' failed: HTTP ' + r.status); return null; }
    const rows = await r.json();
    return Array.isArray(rows) ? rows : null;
  } catch (e) { sbWarnOnce(table + ':read', 'select from ' + table + ' unreachable: ' + e.message); return null; }
}

async function sbUpsertRows(table, rows) {
  if (!sbOn() || !rows || !rows.length) return false;
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/' + table, {
        method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(SB_TIMEOUT_MS)
      });
      if (r.ok) return true;
      const detail = (await r.text().catch(() => '')).slice(0, 200);
      sbWarnOnce(table + ':write', 'upsert into ' + table + ' failed: HTTP ' + r.status + ' ' + detail);
      if (r.status >= 400 && r.status < 500) return false; // rejected: a retry cannot help
    } catch (e) { sbWarnOnce(table + ':write', 'upsert into ' + table + ' unreachable: ' + e.message); }
    if (a === 0) await new Promise((rs) => setTimeout(rs, 250));
  }
  return false;
}

async function sbDelete(table, query) {
  if (!sbOn()) return false;
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + table + '?' + query, {
      method: 'DELETE', headers: sbHdr(), signal: AbortSignal.timeout(SB_TIMEOUT_MS)
    });
    if (r.ok) return true;
    sbWarnOnce(table + ':delete', 'delete from ' + table + ' failed: HTTP ' + r.status);
  } catch (e) { sbWarnOnce(table + ':delete', 'delete from ' + table + ' unreachable: ' + e.message); }
  return false;
}

// One merge per period per player per boot. A FAILED merge is forgotten so the
// next request retries, instead of serving stale RAM for the rest of the process.
const hydrated = new Set();
function claimHydration(key) {
  if (hydrated.has(key)) return false;
  if (hydrated.size > 100000) hydrated.clear(); // bounded like every other store
  hydrated.add(key);
  return true;
}
function forgetHydration(key) { hydrated.delete(key); }

function mergeProgressState(cur, row) {
  return {
    progress: Math.max(Number(cur && cur.progress) || 0, Number(row && row.progress) || 0),
    completed: !!((cur && cur.completed) || (row && row.completed)),
    claimed: !!((cur && cur.claimed) || (row && row.claimed))
  };
}
const ZERO_PROGRESS = () => ({ progress: 0, completed: false, claimed: false });

// ---- daily missions --------------------------------------------------------
function missionsMap(dateKey, uid) {
  const mKey = `${dateKey}:${uid}`;
  let mMap = memPlayerMissions.get(mKey);
  if (!mMap) {
    mMap = new Map();
    for (const d of prog.getDailyMissions(dateKey)) mMap.set(d.id, ZERO_PROGRESS());
    memPlayerMissions.set(mKey, mMap);
  }
  return mMap;
}

async function hydrateMissions(dateKey, uid) {
  if (!sbOn() || uid == null || uid === '') return false;
  const key = `missions|${dateKey}|${uid}`;
  if (!claimHydration(key)) return false;
  const rows = await sbSelect('player_missions',
    'user_id=eq.' + encodeURIComponent(uid) + '&date_key=eq.' + encodeURIComponent(dateKey) + '&select=mission_id,progress,completed,claimed');
  if (!rows) { forgetHydration(key); return false; }
  const mMap = missionsMap(dateKey, uid);
  for (const r of rows) {
    const id = String(r.mission_id);
    mMap.set(id, mergeProgressState(mMap.get(id) || ZERO_PROGRESS(), r));
  }
  return true;
}

async function persistMissions(dateKey, uid, mMap, ids) {
  if (!sbOn()) return false;
  const list = ids && ids.length ? ids : [...mMap.keys()];
  const now = new Date().toISOString();
  const rows = [];
  for (const id of list) {
    const st = mMap.get(id);
    if (!st) continue;
    rows.push({
      user_id: String(uid), date_key: String(dateKey), mission_id: String(id),
      progress: Math.max(0, Math.round(Number(st.progress) || 0)),
      completed: !!st.completed, claimed: !!st.claimed, updated_at: now
    });
  }
  return sbUpsertRows('player_missions', rows);
}

// ---- weekly bounties -------------------------------------------------------
function bountiesMap(wKey, uid) {
  const key = `${wKey}:${uid}`;
  let bMap = memWeeklyBounties.get(key);
  if (!bMap) {
    bMap = new Map();
    for (const b of prog.getWeeklyBounties(wKey)) bMap.set(b.id, ZERO_PROGRESS());
    memWeeklyBounties.set(key, bMap);
  }
  return bMap;
}

async function hydrateBounties(wKey, uid) {
  if (!sbOn() || uid == null || uid === '') return false;
  const key = `bounties|${wKey}|${uid}`;
  if (!claimHydration(key)) return false;
  const rows = await sbSelect('weekly_bounties',
    'user_id=eq.' + encodeURIComponent(uid) + '&week_key=eq.' + encodeURIComponent(wKey) + '&select=bounty_id,progress,completed,claimed');
  if (!rows) { forgetHydration(key); return false; }
  const bMap = bountiesMap(wKey, uid);
  for (const r of rows) {
    const id = String(r.bounty_id);
    bMap.set(id, mergeProgressState(bMap.get(id) || ZERO_PROGRESS(), r));
  }
  return true;
}

async function persistBounties(wKey, uid, bMap, ids) {
  if (!sbOn()) return false;
  const list = ids && ids.length ? ids : [...bMap.keys()];
  const now = new Date().toISOString();
  const rows = [];
  for (const id of list) {
    const st = bMap.get(id);
    if (!st) continue;
    rows.push({
      user_id: String(uid), week_key: String(wKey), bounty_id: String(id),
      progress: Math.max(0, Math.round(Number(st.progress) || 0)),
      completed: !!st.completed, claimed: !!st.claimed, updated_at: now
    });
  }
  return sbUpsertRows('weekly_bounties', rows);
}

// ---- equipped milestone badge ---------------------------------------------
async function hydrateEquippedBadge(uid) {
  if (!sbOn() || uid == null || uid === '') return null;
  const key = `badge|${uid}`;
  if (!claimHydration(key)) return memEquippedBadges.get(uid) || null;
  const rows = await sbSelect('player_badges',
    'user_id=eq.' + encodeURIComponent(uid) + '&equipped=eq.true&limit=1&select=badge_id');
  if (!rows) { forgetHydration(key); return memEquippedBadges.get(uid) || null; }
  const badgeId = rows[0] && rows[0].badge_id != null ? String(rows[0].badge_id) : null;
  if (badgeId && !memEquippedBadges.has(uid)) memEquippedBadges.set(uid, badgeId);
  return badgeId;
}

// ---- clubs / syndicates ----------------------------------------------------
// Clubs were the worst case in the audit: they had NO table at all, so every
// redeploy wiped every roster, every kilometre and every Grand Prix point, and a
// member who had driven 400 km for the club came back to 0.0 km. Counters here
// only ever grow, so the merge is monotonic (max) exactly like missions.
//
// week_key IS acted on as of v96: it decides whether a row's weekly numbers
// belong to this week at all (see applyCrewRow / applyMemberRow). Lifetime
// totals merge regardless; weekly counters merge only from a row stamped with
// the current week, so a stale row can never hand a club a head start.
const SEEDED_CREW_IDS = new Set((prog.CREW_PRESETS || []).map((p) => p.id));

function crewDbRow(c) {
  return {
    id: String(c.id),
    tag: String(c.tag || '').slice(0, 8),
    name: String(c.name || '').slice(0, 48),
    motto: c.motto ? String(c.motto).slice(0, 60) : null,
    badge: c.badge ? String(c.badge).slice(0, 8) : null,
    color: c.color ? String(c.color).slice(0, 16) : null,
    leader_uid: c.leaderUid != null ? String(c.leaderUid).slice(0, 64) : null,
    weekly_meters: Number(c.weeklyMeters) || 0,
    total_meters: Number(c.totalMeters) || 0,
    weekly_points: Math.round(Number(c.weeklyPoints) || 0),
    week_key: currentWeekKey(),
    seeded: SEEDED_CREW_IDS.has(String(c.id)),
    created_at: c.created_at || new Date().toISOString()
  };
}

function crewMemberDbRow(crewId, m) {
  const memberKey = normCrewKey(m && m.uid) || normCrewKey(m && m.name);
  if (!memberKey) return null; // no identity to key the row on - nothing to store
  return {
    crew_id: String(crewId),
    member_key: memberKey,
    name: m && m.name ? String(m.name).slice(0, 16) : null,
    role: m && m.role === 'leader' ? 'leader' : 'member',
    aliases: (m && Array.isArray(m.aliases) ? m.aliases : []).map((a) => String(a).slice(0, 64)).slice(0, 16),
    weekly_meters: Number(m && m.weeklyMeters) || 0,
    total_meters: Number(m && m.totalMeters) || 0,
    weekly_points: Math.round(Number(m && m.weeklyPoints) || 0),
    week_key: currentWeekKey(),
    joined_at: (m && m.joined_at) || new Date().toISOString()
  };
}

function applyCrewRow(r) {
  const cid = String((r && r.id) || '');
  if (!cid) return null;
  const wk = currentWeekKey();
  // v96: a row's weekly numbers belong to this week only if it says so. A row
  // written before Monday is history - merging it would give the club a lead it
  // did not earn this week. The lifetime total always merges.
  const rowIsThisWeek = String((r && r.week_key) || '') === wk;
  const c = memCrews.get(cid);
  if (!c) {
    // a user-created club this process has never seen: rebuild it from the row
    memCrews.set(cid, {
      id: cid,
      tag: String(r.tag || '').slice(0, 8),
      name: String(r.name || '').slice(0, 48),
      motto: r.motto || 'Apex Velocity Syndicate',
      badge: r.badge || '⚡',
      color: r.color || '#ff4444',
      leaderUid: r.leader_uid || null,
      members: [],
      weeklyMeters: rowIsThisWeek ? (Number(r.weekly_meters) || 0) : 0,
      totalMeters: Number(r.total_meters) || 0,
      weeklyPoints: rowIsThisWeek ? (Number(r.weekly_points) || 0) : 0,
      weekKey: wk,
      created_at: r.created_at || new Date().toISOString()
    });
    return memCrews.get(cid);
  }
  rollCrewWeek(c); // v96: memory first, so a week that ended while we were down is cleared
  c.totalMeters = Math.max(Number(c.totalMeters) || 0, Number(r.total_meters) || 0);
  if (rowIsThisWeek) {
    c.weeklyMeters = Math.max(Number(c.weeklyMeters) || 0, Number(r.weekly_meters) || 0);
    c.weeklyPoints = Math.max(Number(c.weeklyPoints) || 0, Number(r.weekly_points) || 0);
  }
  if (r.leader_uid && !c.leaderUid) c.leaderUid = r.leader_uid;
  if (!SEEDED_CREW_IDS.has(cid)) {
    // a user-created club: the database owns its wording, a restart must not
    // resurrect an older name because memory happened to hold one
    if (r.tag) c.tag = String(r.tag).slice(0, 8);
    if (r.name) c.name = String(r.name).slice(0, 48);
    if (r.motto != null) c.motto = String(r.motto).slice(0, 60);
    if (r.badge) c.badge = String(r.badge).slice(0, 8);
    if (r.color) c.color = String(r.color).slice(0, 16);
  }
  return c;
}

function applyMemberRow(r) {
  const cid = String((r && r.crew_id) || '');
  const c = memCrews.get(cid);
  const mk = String((r && r.member_key) || '');
  if (!c || !mk) return null;
  // v96: same rule as the club row - a member's weekly figures count only if the
  // row was written this week. Their lifetime total always counts.
  const rowIsThisWeek = String((r && r.week_key) || '') === currentWeekKey();
  c.members = c.members || [];
  let m = c.members.find((x) => normCrewKey(x.uid) === mk ||
    (Array.isArray(x.aliases) && x.aliases.some((a) => normCrewKey(a) === mk)));
  if (!m) {
    m = {
      uid: mk,
      name: r.name ? String(r.name).slice(0, 16) : 'RACER',
      role: r.role === 'leader' ? 'leader' : 'member',
      weeklyMeters: rowIsThisWeek ? (Number(r.weekly_meters) || 0) : 0,
      totalMeters: Number(r.total_meters) || 0,
      weeklyPoints: rowIsThisWeek ? (Number(r.weekly_points) || 0) : 0,
      aliases: [],
      joined_at: r.joined_at || new Date().toISOString()
    };
    c.members.push(m);
  } else {
    m.totalMeters = Math.max(Number(m.totalMeters) || 0, Number(r.total_meters) || 0);
    if (rowIsThisWeek) {
      m.weeklyMeters = Math.max(Number(m.weeklyMeters) || 0, Number(r.weekly_meters) || 0);
      m.weeklyPoints = Math.max(Number(m.weeklyPoints) || 0, Number(r.weekly_points) || 0);
    }
  }
  if (r.name && !m.name) m.name = String(r.name).slice(0, 16);
  m.aliases = mergeAliases(m.aliases, Array.isArray(r.aliases) ? r.aliases : []);
  // Rebuild the identity maps exactly as join/settlement would. Without this the
  // v90 club-sync fix silently regresses after every restart: rosters come back
  // but nothing resolves a racer to them, so mileage stops being credited.
  bindCrewIdentities(cid, { uid: m.uid, name: m.name, aliases: m.aliases });
  memPlayerCrew.set(m.uid, cid);
  return m;
}

// v96: a club's weekly total can never be less than the sum of its members'
// weeks. The two rows are written together, but a partial failure (or a club row
// stamped before a member raced) could leave them out of step, and the board
// would then under-report the club. Taking the larger of the two keeps the
// merge monotonic without ever inventing kilometres.
function reconcileCrewWeekly(c) {
  if (!c) return;
  let sumM = 0;
  let sumP = 0;
  for (const m of (c.members || [])) {
    sumM += Number(m.weeklyMeters) || 0;
    sumP += Number(m.weeklyPoints) || 0;
  }
  c.weeklyMeters = Math.max(Number(c.weeklyMeters) || 0, sumM);
  c.weeklyPoints = Math.max(Number(c.weeklyPoints) || 0, sumP);
}

async function hydrateCrew(crewId) {
  if (!sbOn() || !crewId) return false;
  const key = 'crew|' + crewId;
  if (!claimHydration(key)) return false;
  const [crewRows, memberRows, claimRows] = await Promise.all([
    sbSelect('crews', 'id=eq.' + encodeURIComponent(crewId) + '&select=*'),
    sbSelect('crew_members', 'crew_id=eq.' + encodeURIComponent(crewId) + '&select=*&limit=200'),
    // v96: only THIS week's claims. A tier collected last week is collectable
    // again, so loading history would wrongly block it (and grow without bound).
    sbSelect('crew_milestone_claims', 'crew_id=eq.' + encodeURIComponent(crewId) +
      '&week_key=eq.' + encodeURIComponent(currentWeekKey()) + '&select=tier,member_key,week_key&limit=1000')
  ]);
  if (crewRows === null || memberRows === null) { forgetHydration(key); return false; }
  if (crewRows[0]) applyCrewRow(crewRows[0]);
  if (memCrews.has(crewId)) for (const m of memberRows) applyMemberRow(m);
  reconcileCrewWeekly(memCrews.get(crewId));
  if (claimRows) for (const cl of claimRows) {
    // The query is already week-scoped; re-checking means a legacy row with no
    // week_key (or one left over from a previous week) can never block a claim
    // that this week has every right to pay out.
    if (String(cl.week_key || '') !== currentWeekKey()) continue;
    memClaimedCrewMilestones.set(crewClaimKey(cl.crew_id || crewId, cl.tier, cl.member_key, cl.week_key), true);
  }
  return true;
}

// The club board lists every club, so it needs all of them: crews, rosters and
// claims in three queries, once per boot.
async function hydrateAllCrews() {
  if (!sbOn()) return false;
  const key = 'crews|all';
  if (!claimHydration(key)) return false;
  const [crewRows, memberRows, claimRows] = await Promise.all([
    sbSelect('crews', 'select=*&limit=500'),
    sbSelect('crew_members', 'select=*&limit=5000'),
    sbSelect('crew_milestone_claims', 'week_key=eq.' + encodeURIComponent(currentWeekKey()) +
      '&select=crew_id,tier,member_key,week_key&limit=20000')
  ]);
  if (crewRows === null || memberRows === null) { forgetHydration(key); return false; }
  for (const r of crewRows) applyCrewRow(r);      // crews first: members attach to them
  for (const r of memberRows) applyMemberRow(r);
  for (const r of crewRows) reconcileCrewWeekly(memCrews.get(String(r.id))); // v96
  if (claimRows) for (const cl of claimRows) {
    if (String(cl.week_key || '') !== currentWeekKey()) continue; // see hydrateCrew
    memClaimedCrewMilestones.set(crewClaimKey(cl.crew_id, cl.tier, cl.member_key, cl.week_key), true);
  }
  return true;
}

// "Which club is this racer in?" - the question settlement and /api/player/crew
// both ask. Memory first (free), then the roster key, then the alias array, so a
// racer who joined before the restart is still recognised after it.
async function findCrewIdDurable(ids) {
  const local = findCrewId(ids);
  if (local && memCrews.has(local)) {
    // Awaited, not fire-and-forget: the caller is about to read the roster, the
    // kilometre counters or the milestone claims, and a claim that has not been
    // hydrated yet can be collected a second time. Cached per boot, so this costs
    // three small queries per club per process, not per request.
    await hydrateCrew(local);
    return local;
  }
  if (!sbOn()) return local;
  const keys = crewStrongKeys(ids).slice(0, 6);
  if (!keys.length) return local;
  const dk = 'crewfind|' + keys.join('|');
  if (!claimHydration(dk)) return findCrewId(ids);
  const enc = keys.map((k) => encodeURIComponent(k));
  let hits = await Promise.all(enc.map((k) => sbSelect('crew_members', 'member_key=eq.' + k + '&select=crew_id&limit=1')));
  if (hits.some((r) => r === null)) { forgetHydration(dk); return findCrewId(ids); }
  let hit = hits.find((r) => r && r.length && r[0].crew_id);
  if (!hit) {
    hits = await Promise.all(enc.map((k) => sbSelect('crew_members', 'aliases=cs.{' + k + '}&select=crew_id&limit=1')));
    if (hits.some((r) => r === null)) { forgetHydration(dk); return findCrewId(ids); }
    hit = hits.find((r) => r && r.length && r[0].crew_id);
  }
  if (!hit) return null;
  const cid = String(hit[0].crew_id);
  await hydrateCrew(cid);
  const crew = memCrews.get(cid);
  if (!crew) return null;
  bindCrewIdentities(cid, ids);
  if (ids && ids.uid) memPlayerCrew.set(String(ids.uid), cid);
  return cid;
}

async function persistCrewRow(c) { return c ? sbUpsertRows('crews', [crewDbRow(c)]) : false; }

// crew_members.crew_id has a FOREIGN KEY to crews(id), so the club row has to
// exist before the roster row is written. Every call site used to fire the two
// together with Promise.all, which on a brand-new club let the member insert win
// the race: Postgres rejected it with 23503, sbUpsertRows saw a 4xx and (rightly)
// did not retry, and the founder's roster row was simply never stored. The club
// then came back from a restart with an empty roster, or - if the club row lost
// its own race - not at all, and findCrewIdDurable() could not see that racer in
// any club. Sequential, and the roster row is skipped when there is no parent row
// to hang it from; the next settlement re-persists both.
async function persistCrewWithMember(c, m) {
  if (!c) return false;
  if (!(await persistCrewRow(c))) return false;
  if (!m) return true;
  return persistCrewMember(c.id, m);
}

async function persistCrewMember(crewId, m) {
  const row = crewMemberDbRow(crewId, m);
  return row ? sbUpsertRows('crew_members', [row]) : false;
}

// Leaving a club must delete the roster row, or the next hydration walks the
// racer straight back into the club they left.
async function deleteCrewMemberRow(crewId, m) {
  const row = crewMemberDbRow(crewId, m);
  if (!row) return false;
  return sbDelete('crew_members', 'crew_id=eq.' + encodeURIComponent(String(crewId)) +
    '&member_key=eq.' + encodeURIComponent(row.member_key));
}

// week_key is part of the claim's primary key as of v96, so it is passed in by
// the caller rather than recomputed here: the row must name the same week the
// in-memory claim key does, or the two disagree at the Monday boundary.
async function persistCrewClaim(crewId, tier, memberKey, weekKey) {
  return sbUpsertRows('crew_milestone_claims', [{
    crew_id: String(crewId), tier: Math.round(Number(tier) || 0),
    member_key: String(memberKey).slice(0, 64), week_key: String(weekKey || currentWeekKey())
  }]);
}

// ---------------------------------------------------------------------------
// v96 BOOT DIAGNOSTICS - "my club disappears after every deploy" has four causes
// and they look IDENTICAL from the lobby: only the five presets are on the board.
// Three of the four are silent. A read through the anon key returns an empty set
// rather than an error, so nothing is logged and the club board simply shows the
// presets; a missing table logs one line per table at the first write, which is
// easy to miss in a deploy log. These probes name the actual cause once at boot
// and publish it at /health, so it can be checked with a single curl instead of
// guessed at from a bug report.
// ---------------------------------------------------------------------------

// The service-role key is a JWT whose payload carries role:"service_role"; the
// anon key carries role:"anon". Pasting the anon key into SUPABASE_SERVICE_ROLE
// is easy to do and quietly disables every write (row-level security) while
// making every read return nothing instead of failing.
function serviceKeyRole(key) {
  try {
    const parts = String(key || '').split('.');
    if (parts.length < 2) return 'unknown';
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return typeof payload.role === 'string' && payload.role ? payload.role : 'unknown';
  } catch (e) { return 'unknown'; }
}

// A write probe that cannot write anything: POST an empty row. Postgres resolves
// the table first (404 when the migration was never run), then row-level security
// (401/403 when the key is the anon one), then the NOT NULL constraint on the
// primary key rejects the row (400). So the status alone identifies the cause and
// no row is ever inserted - which is why this is safe to run on a live database.
function classifySchemaProbe(status) {
  if (status === 404 || status === 406) return 'table_missing';
  if (status === 401 || status === 403) return 'key_rejected';
  if (status >= 500) return 'server_error';
  return 'ok';   // 400 = the table is there and this key may write to it
}

// v97: a read-only probe. Posting an empty row (probeSchemaWrite) is the right
// question for the club tables, but wrong here: against player_stats it would either
// insert junk or fail for a reason unrelated to what we are asking. A select answers
// "what type is this key column" and "does this column exist" without writing.
async function probeSchemaRead(table, query) {
  if (!sbOn()) return { status: 0, verdict: 'not_configured' };
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + table + '?' + query, {
      headers: sbHdr(), signal: AbortSignal.timeout(SB_TIMEOUT_MS)
    });
    await r.text().catch(() => '');
    return { status: r.status, verdict: classifySchemaProbe(r.status) };
  } catch (e) { return { status: 0, verdict: 'unreachable' }; }
}

async function probeSchemaWrite(table) {
  if (!sbOn()) return 'not_configured';
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + table, {
      method: 'POST', headers: sbHdr(), body: JSON.stringify([{}]),
      signal: AbortSignal.timeout(SB_TIMEOUT_MS)
    });
    await r.text().catch(() => '');
    return classifySchemaProbe(r.status);
  } catch (e) { return 'unreachable'; }
}

// Pure, so the whole decision table is testable without touching the network or
// the environment: given the key's role and the three probe results, name the
// cause. key_rejected outranks table_missing because a 403 is what an anon key
// gets even against tables that exist, and that is the more common mistake.
function persistenceVerdict(keyRole, probes) {
  const t = Array.isArray(probes) ? probes : [];
  if (keyRole === 'anon') return 'anon_key';
  if (t.includes('key_rejected')) return 'key_rejected';
  if (t.includes('table_missing')) return 'table_missing';
  if (t.includes('unreachable')) return 'unreachable';
  if (t.includes('server_error')) return 'server_error';
  if (t.length && t.every((x) => x === 'ok')) return 'ok';
  return 'unknown';
}

// Published at /health. Populated once at boot; `check` re-runs it on demand.
const persistenceHealth = {
  configured: false, keyRole: null, crews: null, crewMembers: null, crewClaims: null,
  playerStatsKeyType: null, playerStatsHasName: false, compHasName: false,
  verdict: 'not_configured', checkedAt: null
};

async function checkPersistenceHealth() {
  persistenceHealth.configured = sbOn();
  persistenceHealth.checkedAt = new Date().toISOString();
  if (!sbOn()) {
    persistenceHealth.verdict = 'not_configured';
    return persistenceHealth;
  }
  // SB_ROLE, not the env var: that is the key actually sent with every request.
  persistenceHealth.keyRole = serviceKeyRole(SB_ROLE);
  const [crews, members, claims] = await Promise.all([
    probeSchemaWrite('crews'), probeSchemaWrite('crew_members'), probeSchemaWrite('crew_milestone_claims')
  ]);
  persistenceHealth.crews = crews;
  persistenceHealth.crewMembers = members;
  persistenceHealth.crewClaims = claims;

  // v97: the competitive boards key on player_stats.user_id. While that column is a
  // uuid bound to auth.users, every guest identity is rejected - their rating, lap
  // records and achievements read back empty and are written nowhere, so the global
  // board only ever reflected signed-in accounts and reset with every dyno restart.
  const [statsKeyProbe, statsNameProbe] = await Promise.all([
    probeSchemaRead('player_stats', 'user_id=eq.sr-probe-not-a-uuid&select=user_id&limit=1'),
    probeSchemaRead('player_stats', 'select=name&limit=1')
  ]);
  sbStatsKeyType = statsKeyProbe.status === 200 ? 'text'
    : (statsKeyProbe.status === 400 ? 'uuid' : statsKeyProbe.verdict);
  sbStatsHasName = statsNameProbe.status === 200;
  const compNameProbe = await probeSchemaRead('daily_competition', 'select=name&limit=1');
  sbCompHasName = compNameProbe.status === 200;
  persistenceHealth.playerStatsKeyType = sbStatsKeyType;
  persistenceHealth.playerStatsHasName = sbStatsHasName;
  persistenceHealth.compHasName = sbCompHasName;

  persistenceHealth.verdict = persistenceVerdict(persistenceHealth.keyRole, [crews, members, claims]);

  const V = persistenceHealth.verdict;
  if (V === 'ok') {
    console.log('[velocity-rush] Club persistence verified: crews, crew_members and crew_milestone_claims are writable with the service-role key.');
    if (sbStatsKeyType === 'uuid') {
      console.warn('[velocity-rush] !! player_stats.user_id is still uuid, so a guest racer\'s rating, lap records and');
      console.warn('[velocity-rush] !! achievements cannot be saved - the Global Rating board only holds signed-in accounts.');
      console.warn('[velocity-rush] !! Run supabase-migration-v97.sql once in the Supabase SQL Editor to fix the boards.');
    } else if (sbStatsKeyType === 'text') {
      console.log('[velocity-rush] Competitive persistence verified: player_stats accepts every racer identity (' + (sbStatsHasName ? 'with names' : 'no name column yet') + ').');
    }
    if (!sbStatsHasName && sbStatsKeyType === 'text') {
      console.warn('[velocity-rush] !! player_stats has no name column - racers without a profiles row show as RACER on the board.');
    }
  } else if (V === 'anon_key' || V === 'key_rejected') {
    console.warn('[velocity-rush] !! SUPABASE_SERVICE_ROLE is not a service-role key (detected role: ' + persistenceHealth.keyRole + ').');
    console.warn('[velocity-rush] !! Row-level security rejects every write and returns an EMPTY set for every read, so the club');
    console.warn('[velocity-rush] !! board shows only the five presets and created clubs vanish on each restart - with no error.');
    console.warn('[velocity-rush] !! Use the service_role key: Supabase > Project Settings > API > service_role (secret).');
  } else if (V === 'table_missing') {
    console.warn('[velocity-rush] !! The club tables do not exist (' +
      ['crews:' + crews, 'crew_members:' + members, 'crew_milestone_claims:' + claims].join(', ') + ').');
    console.warn('[velocity-rush] !! Run supabase-migration-v96.sql once in the Supabase SQL Editor. Until then clubs, missions,');
    console.warn('[velocity-rush] !! bounties, badges and revenge targets live in RAM only and reset on every restart or redeploy.');
  } else if (V === 'unknown') {
    console.warn('[velocity-rush] !! The club-table probe was inconclusive (' + [crews, members, claims].join(', ') + ') - check the Supabase URL and key.');
  } else if (V === 'unreachable') {
    console.warn('[velocity-rush] !! Supabase is configured but unreachable from this process - progress stays in RAM until it answers.');
  } else {
    console.warn('[velocity-rush] !! Supabase returned ' + V + ' while probing the club tables - progress stays in RAM until that clears.');
  }
  return persistenceHealth;
}

// ---- revenge targets -------------------------------------------------------
// A grudge is kept under EVERY identity its owner is known by (account uuid,
// device pid, display name) so that any lookup finds it - that fan-out is what
// made revenge work across the five identity paths in v93. The database mirrors
// it exactly: one row per (owner identity, rival). That keeps the read path a
// plain per-identity select with no joins and no alias table to maintain.
const REVENGE_DB_KEYS = (ids, strongOnly) => revengeKeys(ids, !!strongOnly).slice(0, 8);

async function hydrateRevenge(ids, strongOnly) {
  if (!sbOn()) return false;
  const keys = REVENGE_DB_KEYS(ids, strongOnly);
  if (!keys.length) return false;
  const hyKey = 'revenge|' + keys.join('|');
  if (!claimHydration(hyKey)) return false;
  const cutoff = new Date(Date.now() - REVENGE_TTL_MS).toISOString();
  const found = await Promise.all(keys.map((k) => sbSelect('player_revenge',
    'owner_id=eq.' + encodeURIComponent(k) +
    '&issued_at=gte.' + encodeURIComponent(cutoff) +
    '&order=issued_at.desc&limit=' + REVENGE_MAX +
    '&select=target_id,target_name,map,target_rating,issued_at')));
  // Any key that failed to read means an incomplete picture: forget the marker so
  // the next poll asks again rather than serving half a grudge list for good.
  if (found.some((rows) => rows === null)) { forgetHydration(hyKey); return false; }
  for (let i = 0; i < keys.length; i++) {
    const byTarget = new Map();
    for (const t of (memRevengeTargets.get(keys[i]) || [])) {
      const rec = normalizeRevengeTarget(t);
      if (rec) byTarget.set(rec.targetUid, rec);
    }
    for (const row of found[i]) {
      const rec = normalizeRevengeTarget({
        targetUid: row.target_id, targetName: row.target_name, map: row.map,
        targetRating: row.target_rating, issuedAt: row.issued_at
      });
      if (!rec) continue;
      const cur = byTarget.get(rec.targetUid);
      if (!cur || String(rec.issuedAt) > String(cur.issuedAt)) byTarget.set(rec.targetUid, rec); // newest wins
    }
    if (byTarget.size) memRevengeTargets.set(keys[i], [...byTarget.values()].slice(-REVENGE_MAX));
  }
  return true;
}

async function persistRevengeTarget(ids, rec) {
  if (!sbOn() || !rec || !rec.targetUid) return false;
  const rows = REVENGE_DB_KEYS(ids, false).map((k) => ({
    owner_id: String(k).slice(0, 64),
    target_id: String(rec.targetUid).slice(0, 64),
    target_name: String(rec.targetName || 'RIVAL').slice(0, 24),
    map: Number.isFinite(rec.map) ? rec.map : 0,
    map_name: rec.mapName || null,
    target_rating: Math.round(Number(rec.targetRating) || 1000),
    status: 'open',
    issued_at: rec.issuedAt || new Date().toISOString()
  }));
  return sbUpsertRows('player_revenge', rows);
}

async function clearRevengeRows(ids, targetUid) {
  if (!sbOn() || !targetUid) return false;
  const keys = REVENGE_DB_KEYS(ids, false);
  const done = await Promise.all(keys.map((k) => sbDelete('player_revenge',
    'owner_id=eq.' + encodeURIComponent(k) + '&target_id=eq.' + encodeURIComponent(String(targetUid)))));
  return done.length > 0 && done.every(Boolean);
}

// Equipping is exclusive, so the previously equipped badge is written back as
// equipped=false in the same upsert - otherwise a restart would resurrect two.
async function persistEquippedBadge(uid, badgeId, prevBadgeId) {
  if (!sbOn()) return false;
  const rows = [{ user_id: String(uid), badge_id: String(badgeId), equipped: true }];
  if (prevBadgeId && prevBadgeId !== badgeId) {
    rows.push({ user_id: String(uid), badge_id: String(prevBadgeId), equipped: false });
  }
  return sbUpsertRows('player_badges', rows);
}
let settleFails = 0, ghost429 = 0; // v79 telemetry
async function withRetry(label, fn) { // v79 BUG-018: 3 attempts, exp backoff, no infinite retry
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fn();
      if (r && (r.ok || r.status === 400 || r.status === 409)) return true; // success or permanent
    } catch (e) { /* transient */ }
    if (a < 2) await new Promise((rs) => setTimeout(rs, 300 * Math.pow(2, a)));
  }
  settleFails++;
  console.error('[settle] FAILED after 3 attempts:', label);
  return false;
}
// v79 BUG-014: per-IP ghost upload bucket (10/min), bounded memory, periodic prune
const ghostRate = new Map();
const ghostPrune = setInterval(() => { const n = Date.now(); for (const [k, v] of ghostRate) if (n - v.t > 60000) ghostRate.delete(k); if (ghostRate.size > 10000) ghostRate.clear(); }, 300000);

// ---------------------------------------------------------------------------
// v94 AUDIT-F3: bounded memory. Every store below is either the fallback used
// when Supabase is not configured, or a cache that exists either way. NONE of
// them was ever evicted, so a process that stayed up grew without limit until
// the host OOM-killed it - and an OOM restart throws away everything they held
// anyway. Trimming is therefore strictly better than not trimming:
//   * period-keyed stores (daily/weekly cups, daily missions, weekly bounties)
//     drop periods that are over - pure dead weight, no live data touched;
//   * identity-keyed stores are FIFO-capped (a Map iterates in insertion order,
//     so the first keys are the oldest), generously, with a warning that tells
//     the operator the real fix is to configure Supabase.
// memCrews is deliberately NOT capped: seeded crews are inserted first, so FIFO
// would delete the built-in clubs before any user-created one.
// ---------------------------------------------------------------------------
const MEM_CAP = Math.max(1000, parseInt(process.env.MEM_CAP || '150000', 10) || 150000);
const AN_USER_CAP = Math.max(1000, parseInt(process.env.AN_USER_CAP || '250000', 10) || 250000);
const REVENGE_TTL_MS = 7 * 86400000; // a revenge target older than a week is stale by design

function capMap(m, cap, label) {
  if (!m || typeof m.size !== 'number' || m.size <= cap) return 0;
  const over = m.size - cap;
  let n = 0;
  for (const k of m.keys()) { if (n >= over) break; m.delete(k); n++; }
  if (n && !sbOn()) console.warn('[mem] ' + label + ': evicted ' + n + ' oldest of ' + (cap + over) + ' (cap ' + cap + '). Set SUPABASE_URL + SUPABASE_SERVICE_ROLE so progress survives restarts.');
  return n;
}

// Keys are either a bare period (`2026-09-19`, `2026-W38`) or `${period}:${uid}`.
// A period goes when it is neither among the newest `keep` NOR young enough to
// still be on screen (both forms sort chronologically as strings; the age check
// is what stops a single stale row from lingering forever in a quiet process).
function periodAgeMs(key) {
  const p = String(key).split(':')[0];
  const wk = p.match(/^(\d{4})-W(\d{2})$/);
  if (wk) return Date.now() - (Date.UTC(+wk[1], 0, 1) + (+wk[2] - 1) * 7 * 86400000);
  const t = Date.parse(p.length === 10 ? p + 'T00:00:00Z' : p);
  return Number.isFinite(t) ? Date.now() - t : Infinity; // unparseable -> treat as ancient
}

function pruneOldPeriods(m, keep, maxAgeMs, label) {
  if (!m || m.size === 0) return 0;
  const seen = new Set();
  for (const k of m.keys()) seen.add(String(k).split(':')[0]);
  const sorted = [...seen].sort();
  const tooMany = new Set(sorted.slice(0, Math.max(0, sorted.length - keep)));
  let n = 0;
  for (const k of m.keys()) {
    const p = String(k).split(':')[0];
    if (tooMany.has(p) || periodAgeMs(p) > maxAgeMs) { m.delete(k); n++; }
  }
  if (n) console.warn('[mem] ' + label + ': dropped ' + n + ' row(s) from finished period(s), keeping the newest ' + keep);
  return n;
}

function capAnUsers(max) {
  const keys = Object.keys(AN.users);
  if (keys.length <= max) return 0;
  keys.sort((a, b) => (((AN.users[a] || {}).lIdx) || 0) - (((AN.users[b] || {}).lIdx) || 0)); // oldest last-seen first
  const drop = keys.slice(0, keys.length - max);
  for (const k of drop) delete AN.users[k];
  return drop.length;
}

function sweepMemory() {
  let evicted = 0;
  try {
    const DAY = 86400000;
    evicted += pruneOldPeriods(memDailyComp, 3, 3 * DAY, 'memDailyComp');          // a daily cup is history after 3 days
    evicted += pruneOldPeriods(memWeeklyComp, 3, 21 * DAY, 'memWeeklyComp');       // keep this week + the two before it
    evicted += pruneOldPeriods(memPlayerMissions, 3, 3 * DAY, 'memPlayerMissions'); // keyed per day per player - the worst offender
    evicted += pruneOldPeriods(memWeeklyBounties, 3, 21 * DAY, 'memWeeklyBounties');
    for (const m of memDailyComp.values()) evicted += capMap(m, MEM_CAP, 'memDailyComp<day>');
    for (const m of memWeeklyComp.values()) evicted += capMap(m, MEM_CAP, 'memWeeklyComp<week>');
    evicted += capMap(memPlayerStats, MEM_CAP, 'memPlayerStats');
    evicted += capMap(memEquippedBadges, MEM_CAP, 'memEquippedBadges');
    evicted += capMap(memPlayerCrew, MEM_CAP, 'memPlayerCrew');
    evicted += capMap(memClaimedCrewMilestones, MEM_CAP, 'memClaimedCrewMilestones');
    evicted += capMap(memCrewAliases, MEM_CAP, 'memCrewAliases');
    evicted += capMap(memCrewNameHints, MEM_CAP, 'memCrewNameHints');
    evicted += capMap(memRevengeTargets, MEM_CAP, 'memRevengeTargets');
    // revenge lists carry their own timestamp: forget targets nobody can act on
    const now = Date.now();
    for (const [k, list] of memRevengeTargets) {
      if (!Array.isArray(list)) { memRevengeTargets.delete(k); evicted++; continue; }
      const kept = list.filter((t) => t && now - Date.parse(t.issuedAt) < REVENGE_TTL_MS);
      if (kept.length !== list.length) {
        evicted += list.length - kept.length;
        if (kept.length) memRevengeTargets.set(k, kept); else memRevengeTargets.delete(k);
      }
    }
    evicted += capAnUsers(AN_USER_CAP);
    if (evicted > 0) scheduleAnalyticsSave();
  } catch (e) { /* a janitor must never take the process down with it */ }
  return evicted;
}
const memSweep = setInterval(sweepMemory, 600000); // every 10 minutes
if (memSweep.unref) memSweep.unref(); // never hold the event loop open (tests, graceful shutdown)
if (ghostPrune.unref) ghostPrune.unref();
function ghostLimited(ip) {
  const n = Date.now(); const e = ghostRate.get(ip);
  if (!e || n - e.t > 60000) { ghostRate.set(ip, { c: 1, t: n }); return false; }
  if (e.c >= 10) return true;
  e.c++; return false;
}
async function settleRace(entryOrRoom) {
  if (!entryOrRoom) return [];
  const entry = (entryOrRoom.room ? entryOrRoom : {
    room: entryOrRoom,
    screens: new Set(),
    specs: new Set(),
    controllers: new Map(),
    uidBySlot: {},
    ratingBySlot: {},
    dupUid: {},
    _settled: false
  });
  entry.screens = entry.screens || new Set();
  entry.specs = entry.specs || new Set();
  if (entry.noRecord) return [];                 // practice/TT never settle
  const room = entry.room;
  if (room.mode !== 'race' && room.mode !== 'elim') return [];   // rated formats only
  const order = room.standings ? room.standings().filter((c) => c.participating) : (room.order || room.cars || []);
  const humans = [];
  for (const c of order) {
    let uid = entry.uidBySlot && entry.uidBySlot[c.slot];
    if (!uid) {
      const pl = (room.players || []).find((p) => p.slot === (c.slot || c.s));
      const isBot = !!(pl && pl.isBot) || !!c.bot || !!c.isBot;
      if (!isBot) {
        // v97: a guest's career keys on the device pid the client sends. Display
        // names collide between racers and change at will, so they made ratings,
        // lap records and achievements both shared and unfindable.
        const pid = entry.pidBySlot ? entry.pidBySlot[c.slot] : '';
        const nm = (pl && pl.name) || c.name || '';
        uid = canonicalRacerKey({ pid: pid, name: nm }) || ('player_' + (c.slot || c.s));
      }
    }
    if (uid && (!entry.dupUid || !entry.dupUid[c.slot])) humans.push({ c, uid });
  } // v77 BUG-001 dedupe
  if (!humans.length) return [];
  const rated = humans.length >= 2 && (!room.participants || room.participants().length === humans.length); // v76: all-human races rate (1v1 unchanged)
  const today = new Date().toISOString().slice(0, 10);
  let dailyMap = -1; try { dailyMap = dailyInfo().map; } catch (e) {}
  const uids = humans.map((h) => h.uid);
  const uq = uids.length === 1 ? 'user_id=eq.' + encodeURIComponent(uids[0]) : 'user_id=in.(' + uids.map(encodeURIComponent).join(',') + ')';
  let stats = {}, recs = {}, achHave = {}, mapCount = {}, seasXp = {}, season = null;
  if (sbOn()) {
    try { const r = await fetch(SB_URL + '/rest/v1/seasons?order=id.desc&limit=1&select=id,name,end_at', { headers: sbHdr() }); if (r.ok) { const j = await r.json(); season = j[0] || null; } } catch (e) {}
    try { const r = await fetch(SB_URL + '/rest/v1/player_stats?' + uq + '&select=user_id,rating,peak_rating,xp,streak,best_streak,races,wins,podiums,daily_days,last_daily,challenges_done', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { stats[x.user_id] = x; }); } catch (e) {}
    let invRows = {};
    try { const r = await fetch(SB_URL + '/rest/v1/player_inventory?' + uq + '&select=user_id,item_id', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { (invRows[x.user_id] = invRows[x.user_id] || []).push(x.item_id); }); } catch (e) {}
    try { const r = await fetch(SB_URL + '/rest/v1/player_map_records?' + uq + '&select=user_id,map', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { mapCount[x.user_id] = (mapCount[x.user_id] || 0) + 1; }); } catch (e) {}
    try { const r = await fetch(SB_URL + '/rest/v1/player_achievements?' + uq + '&select=user_id,ach', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { (achHave[x.user_id] = achHave[x.user_id] || {})[x.ach] = true; }); } catch (e) {}
    try { const r = await fetch(SB_URL + '/rest/v1/player_seasons?' + uq + (season ? '&season_id=eq.' + season.id : '') + '&select=user_id,xp', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { seasXp[x.user_id] = Number(x.xp) || 0; }); } catch (e) {}
    try { const r = await fetch(SB_URL + '/rest/v1/player_map_records?' + uq + '&map=eq.' + room.mapId + '&select=user_id,best_lap_ms,best_race_ms,races,wins', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { recs[x.user_id] = x; }); } catch (e) {}
  } else {
    humans.forEach((h) => {
      stats[h.uid] = memPlayerStats.get(h.uid) || { rating: 1000, peak_rating: 1000, xp: 0, streak: 0, best_streak: 0, races: 0, wins: 0, podiums: 0, daily_days: 0, last_daily: '', challenges_done: 0 };
    });
  }
  const rowsOut = [];
  for (let i = 0; i < humans.length; i++) {
    const h = humans[i];
    const pos = order.indexOf(h.c) + 1;
    const st = stats[h.uid] || { rating: 1000, peak_rating: 1000, xp: 0, streak: 0, best_streak: 0, races: 0, wins: 0, podiums: 0, daily_days: 0, last_daily: '', challenges_done: 0 };
    let rd = 0;
    if (rated) {
      if (humans.length === 2) { const other = humans[1 - i]; rd = prog.eloDelta(st.rating, (stats[other.uid] || { rating: 1000 }).rating, pos === 1 ? 1 : 0); }
      else { // v76: mean of pairwise Elo vs every other human (reduces to classic K=32 in 1v1)
        let sum = 0;
        for (let j = 0; j < humans.length; j++) {
          if (j === i) continue;
          const oj = humans[j]; const posJ = order.indexOf(oj.c) + 1;
          sum += prog.eloDelta(st.rating, (stats[oj.uid] || { rating: 1000 }).rating, pos < posJ ? 1 : 0);
        }
        rd = Math.round(sum / (humans.length - 1));
      }
    }
    const xpBase = prog.xpForRace(h.c.finished, pos, order.length);
    const win = pos === 1, podium = pos <= Math.min(3, order.length);
    const rawLapMs = h.c.best != null ? Math.round(h.c.best * 1000) : (h.c.lapTimes && h.c.lapTimes.length ? Math.round(Math.min(...h.c.lapTimes) * 1000) : null);
    const lapMs = (rawLapMs && prog.isValidLapTime(room.mapId != null ? room.mapId : (room.map || 0), rawLapMs)) ? rawLapMs : null; // v80 anti-cheat min-time filter
    const raceMs = (h.c.finished && h.c.finishTime != null) ? Math.round(h.c.finishTime * 1000) : (h.c.t != null ? Math.round(h.c.t * 1000) : null);
    const prev = recs[h.uid];
    const pr = !!lapMs && (!prev || prev.best_lap_ms == null || lapMs < prev.best_lap_ms);

    // v80 Competitive rank movement
    const allRatingRowsBefore = await getAllRatingRows();
    const myRivalBefore = prog.getCompetitiveRival(allRatingRowsBefore, h.uid).nextRival;
    const rankBefore = await getRatingRank(h.uid, st.rating || 1000);

    // daily reward: first finish on today's map (server-tracked, once per UTC day)
    let dailyXp = 0, dailyDays = st.daily_days || 0, lastDaily = st.last_daily || '';
    if (h.c.finished && room.mode === 'race' && (room.mapId != null ? room.mapId : room.map) === dailyMap && lastDaily !== today) { dailyXp = 150; dailyDays += 1; lastDaily = today; }

    // v97: both cups are running totals, so the durable copy is read back before
    // this race is added to it. Otherwise a restart resumes from zero and the write
    // below replaces the day's best lap and the week's points with this race alone.
    await Promise.all([hydrateDailyComp(today, h.uid), hydrateWeeklyComp(currentWeekKey(), h.uid)]);

    // v80 daily competition tracking
    let dailyCompRow = null;
    if (lapMs != null && room.mode === 'race' && (room.mapId != null ? room.mapId : room.map) === dailyMap) {
      const dKey = today;
      const dayMap = memDailyComp.get(dKey) || new Map();
      const existing = dayMap.get(h.uid);
      dayMap.set(h.uid, mergeDailyRow(existing, {
        user_id: h.uid, name: h.c.name || 'RACER', map: (room.mapId != null ? room.mapId : room.map),
        best_lap_ms: lapMs, races_today: ((existing && existing.races_today) || 0) + 1,
        updated_at: new Date().toISOString()
      }));
      memDailyComp.set(dKey, dayMap);
      dailyCompRow = dayMap.get(h.uid);
    }

    // v80 weekly championship points & tracking
    const isFastestLap = lapMs != null && order.every((o) => o === h.c || !o.best || (h.c.best && h.c.best <= o.best));
    const weeklyPts = rated ? prog.weeklyPointsForPos(pos, humans.length, isFastestLap) : 0;
    const wKey = currentWeekKey();
    let weeklyCompRow = null;
    if (weeklyPts > 0 || lapMs != null) {
      const wkMap = memWeeklyComp.get(wKey) || new Map();
      const existingWk = wkMap.get(h.uid);
      wkMap.set(h.uid, mergeWeeklyRow(existingWk, {
        user_id: h.uid, name: h.c.name || 'RACER',
        points: ((existingWk && existingWk.points) || 0) + weeklyPts,
        races_week: ((existingWk && existingWk.races_week) || 0) + 1,
        wins_week: ((existingWk && existingWk.wins_week) || 0) + (win ? 1 : 0),
        best_lap_ms: lapMs,
        updated_at: new Date().toISOString()
      }));
      memWeeklyComp.set(wKey, wkMap);
      weeklyCompRow = wkMap.get(h.uid);
    }

    // v95: merge durable progress in BEFORE evaluating it, so a redeploy mid-day
    // does not restart this racer's mission and bounty counters from zero (and so
    // the just-completed rewards below are not granted twice for the same lap).
    await Promise.all([hydrateMissions(today, h.uid), hydrateBounties(wKey, h.uid)]);

    // v81 Daily Missions progress evaluation
    const activeMissions = getOrInitMissions(today, h.uid);
    const telemetry = {
      finished: !!h.c.finished,
      won: win,
      nitroCount: h.c.nitroCount || (h.c.nitro ? 1 : 0),
      isDailyCup: room.mode === 'race' && (room.mapId != null ? room.mapId : room.map) === dailyMap,
      isPersonalBest: pr,
      humanRacers: humans.length,
      collisions: h.c.collisions || 0
    };
    const mKey = `${today}:${h.uid}`;
    const mMap = memPlayerMissions.get(mKey) || new Map();
    const missionUpdates = [];
    let missionBonusXp = 0, missionBonusCoins = 0;
    for (const m of activeMissions) {
      const prevProg = (mMap.get(m.id) || {}).progress || 0;
      const newProg = Math.min(m.goal, prog.evaluateMissionProgress(m.id, prevProg, telemetry));
      const wasCompleted = (mMap.get(m.id) || {}).completed || prevProg >= m.goal;
      const nowCompleted = wasCompleted || newProg >= m.goal;
      const justCompleted = !wasCompleted && nowCompleted;
      let mEarnedXp = 0, mEarnedCoins = 0;
      if (justCompleted) {
        mEarnedXp = m.xp;
        mEarnedCoins = 0;
        missionBonusXp += m.xp;
        missionBonusCoins += m.coins;
      }
      mMap.set(m.id, { progress: newProg, completed: nowCompleted, claimed: (mMap.get(m.id) || {}).claimed || justCompleted });
      missionUpdates.push({
        id: m.id,
        title: m.title,
        goal: m.goal,
        prevProgress: prevProg,
        progress: newProg,
        completed: nowCompleted,
        justCompleted,
        xpAwarded: mEarnedXp,
        coinsAwarded: mEarnedCoins,
        icon: m.icon
      });
    }
    memPlayerMissions.set(mKey, mMap);

    // v81 Daily streak transition
    const streakTransition = prog.evaluateStreakTransition(st.last_daily, today, st.streak || 0, st.best_streak || 0);
    const streakNew = streakTransition.streak;
    const bestStreakNew = streakTransition.bestStreak;
    const streakInfo = prog.getStreakMilestoneInfo(streakNew);
    lastDaily = today;

    // v82 Weekly Syndicate Bounties
    const activeBounties = getOrInitWeeklyBounties(wKey, h.uid);
    const bKey = `${wKey}:${h.uid}`;
    const bMap = memWeeklyBounties.get(bKey) || new Map();
    const bountyUpdates = [];
    let bountyBonusXp = 0, bountyBonusCoins = 0;
    for (const b of activeBounties) {
      const prevBProg = (bMap.get(b.id) || {}).progress || 0;
      const newBProg = Math.min(b.goal, prog.evaluateWeeklyBountyProgress(b.id, prevBProg, {
        lapsCompleted: (h.c.lapTimes ? h.c.lapTimes.length : 2),
        finished: !!h.c.finished,
        won: win,
        humanRacers: humans.length,
        weeklyPts,
        nitroCount: h.c.nitroCount || (h.c.nitro ? 1 : 0),
        collisions: h.c.collisions || 0
      }));
      const wasBComp = (bMap.get(b.id) || {}).completed || prevBProg >= b.goal;
      const nowBComp = wasBComp || newBProg >= b.goal;
      const justBComp = !wasBComp && nowBComp;
      let bEarnedXp = 0, bEarnedCoins = 0;
      if (justBComp) {
        bEarnedXp = b.xp;
        bEarnedCoins = 0;
        bountyBonusXp += b.xp;
        bountyBonusCoins += b.coins;
      }
      bMap.set(b.id, { progress: newBProg, completed: nowBComp, claimed: (bMap.get(b.id) || {}).claimed || justBComp });
      bountyUpdates.push({
        id: b.id,
        title: b.title,
        goal: b.goal,
        progress: newBProg,
        completed: nowBComp,
        justCompleted: justBComp,
        xpAwarded: bEarnedXp,
        coinsAwarded: bEarnedCoins,
        icon: b.icon
      });
    }
    memWeeklyBounties.set(bKey, bMap);

    // v95 rule 3: make this race's progression durable without delaying the
    // results screen. Best-effort by design - settlement has already awarded
    // coins and rating through the RPCs, and a database blip must not turn a
    // finished race into a failed one. Failure is logged once per table.
    Promise.all([persistMissions(today, h.uid, mMap), persistBounties(wKey, h.uid, bMap)])
      .catch((e) => sbWarnOnce('settle:progress', 'progress persistence failed: ' + (e && e.message)));

    // v82 Revenge match evaluation
    let revengeAwarded = null;
    // v93: look the grudge up through every strong identity this racer owns, not
    // just the settlement uid, and read the normalized record shape.
    const revIds = revengeIdsFor(entry, h.c.slot, h.uid, h.c.name);
    // v95: awaited on purpose - beating a rival only pays the revenge bonus if the
    // grudge is still on record, and after a redeploy that record is in the
    // database, not in RAM.
    await hydrateRevenge(revIds, true);
    const revList = readRevengeTargets(revIds, true);
    if (win && revList.length && humans.length >= 2) {
      const targetOpponent = humans.find(o => o.uid !== h.uid && revList.some(rt => rt.targetUid === o.uid));
      if (targetOpponent) {
        const revEval = prog.evaluateRevengeMatch(targetOpponent.uid, h.uid, { xp: xpBase, coins: 0 }); // v115 coins retired
        if (revEval.revenge) {
          revengeAwarded = {
            targetUid: targetOpponent.uid,
            targetName: targetOpponent.c.name || 'RIVAL',
            xpBonus: revEval.xpBonus,
            coinsBonus: revEval.coinsBonus
          };
          clearRevengeTarget(revIds, targetOpponent.uid); // v93 consumed under every identity
          clearRevengeRows(revIds, targetOpponent.uid).catch(() => {}); // v95 and under every database row
        }
      }
    } else if (!win && rated && humans.length >= 2) {
      const winnerHuman = humans.find((_, idx) => order.indexOf(humans[idx].c) === 0);
      if (winnerHuman && winnerHuman.uid !== h.uid) {
        // v93: same normalized record + same identity set as every other writer,
        // so the track you lost on is the track the banner offers.
        const newGrudge = addRevengeTarget(revIds, {
          targetUid: winnerHuman.uid,
          targetName: winnerHuman.c.name || 'RIVAL',
          map: room.mapId,
          targetRating: (stats[winnerHuman.uid] || {}).rating || 1000,
          issuedAt: new Date().toISOString()
        });
        if (newGrudge) persistRevengeTarget(revIds, newGrudge).catch(() => {}); // v95
      }
    }

    // challenge completion: server verifies map/mode/target against the stored row
    let chXp = 0, chDone = false;
    const chid = entry.chBySlot && entry.chBySlot[h.c.slot];
    if (chid && h.c.finished && raceMs != null && sbOn()) {
      try {
        const r = await fetch(SB_URL + '/rest/v1/challenges?id=eq.' + chid + '&select=id,map,mode,target_ms,status', { headers: sbHdr() });
        if (r.ok) {
          const ch = (await r.json())[0];
          if (ch && ch.status === 'open' && ch.map === room.mapId && ch.mode === room.mode && (!ch.target_ms || raceMs < ch.target_ms)) {
            await fetch(SB_URL + '/rest/v1/challenges?id=eq.' + chid, { method: 'PATCH', headers: sbHdr(), body: JSON.stringify({ status: 'done', winner_uid: h.uid }) });
            chXp = 100; chDone = true;
          }
        }
      } catch (e) {}
    }
    // achievements: computed ONLY from authoritative stats/history
    const d = { wins: (st.wins || 0) + (win ? 1 : 0), streak: streakNew, podiums: (st.podiums || 0) + (podium ? 1 : 0), mapsPlayed: mapCount[h.uid] || 0, daily_days: dailyDays, challenges_done: (st.challenges_done || 0) + (chDone ? 1 : 0), races: (st.races || 0) + 1, peak_rating: Math.max(st.peak_rating || 1000, (st.rating || 1000) + rd) };
    const newAch = [];
    for (const a of prog.ACHIEVEMENTS) { if (!(achHave[h.uid] && achHave[h.uid][a.id]) && a.test(d)) newAch.push(a); }
    let achXp = 0; for (const a of newAch) achXp += a.xp;
    // v75 Rush Coins (server-awarded; never client-submitted)
    const coins = 0; // v115: the coin economy retired with the garage
    const xpTotal = xpBase + dailyXp + chXp + achXp + missionBonusXp + bountyBonusXp + (revengeAwarded ? revengeAwarded.xpBonus : 0);
    const xpOld = Number(st.xp || 0), xpNew = xpOld + xpTotal;
    const lvlOld = prog.levelFromXp(xpOld).level, lvlNew = prog.levelFromXp(xpNew).level;
    const ratingNew = (st.rating || 1000) + rd;
    const key = (room.code || 'RACE') + '-' + (entry.raceSeq || 0) + '-' + (h.c.slot || i + 1); // idempotent (race_key)

    // v80 calculate rank after delta
    const rankAfter = await getRatingRank(h.uid, ratingNew);
    const rankDelta = rankBefore - rankAfter; // positive = climbed higher rank

    // v81 Rival overtake & division transition checks
    const overtakenRival = prog.detectRivalOvertake(rankBefore, rankAfter, myRivalBefore);
    const divisionChange = prog.checkDivisionTransition(st.rating || 1000, ratingNew);

    // v82 Badges evaluation
    const statsForBadges = {
      wins: (st.wins || 0) + (win ? 1 : 0),
      streak: streakNew,
      best_streak: bestStreakNew,
      top_speed: h.c.maxSpeed ? Math.round(h.c.maxSpeed * 3.6) : 180,
      rivals_passed: (st.rivals_passed || 0) + (overtakenRival ? 1 : 0),
      ghosts_beaten: (st.ghosts_beaten || 0) + (pr ? 1 : 0),
      clean_races: (st.clean_races || 0) + (h.c.finished && !h.c.collisions ? 1 : 0),
      nitro_count: (st.nitro_count || 0) + (h.c.nitroCount || (h.c.nitro ? 1 : 0))
    };
    const badgeEvaluations = prog.evaluateBadges(statsForBadges);

    // v83 Racing Syndicate Crews contribution
    // v90 FIX: resolve the club and the roster row through EVERY identity this
    // racer is known by (verified Supabase uuid, device pid, client uid, and
    // the in-race display name). Previously only `h.uid` was tried, so a guest
    // whose club row was keyed by device pid while settlement keyed by display
    // name was silently dropped — their club showed one member's distance and
    // points and everybody else stayed at zero.
    let crewUpdate = null;
    const crewSlot = h.c.slot || (i + 1);
    const crewIds = {
      uid: h.uid,
      sbUid: entry.uidBySlot ? entry.uidBySlot[crewSlot] : null,
      pid: entry.pidBySlot ? entry.pidBySlot[crewSlot] : null,
      name: h.c.name
    };
    // v95: awaited on purpose. findCrewId() alone reads RAM, which after a
    // redeploy holds five empty seeded presets - so every member's kilometres
    // would silently stop counting until they re-joined their own club.
    const crewId = await findCrewIdDurable(crewIds);
    if (crewId && memCrews.has(crewId)) {
      const cr = memCrews.get(crewId);
      rollCrewWeek(cr); // v96: the first race after Monday opens a new week
      const lapsDone = (h.c.lapTimes ? h.c.lapTimes.length : (h.c.finished ? (room.laps || 3) : 1));
      const contrib = prog.calculateCrewContribution({ lapsCompleted: lapsDone, finished: !!h.c.finished, won: win, podium });
      cr.weeklyMeters = (cr.weeklyMeters || 0) + contrib.meters;
      cr.totalMeters = (cr.totalMeters || 0) + contrib.meters;
      cr.weeklyPoints = (cr.weeklyPoints || 0) + contrib.points;

      cr.members = cr.members || [];
      let mRec = findCrewMember(cr, crewIds);
      if (mRec) {
        mRec.weeklyMeters = (mRec.weeklyMeters || 0) + contrib.meters;
        mRec.totalMeters = (mRec.totalMeters || 0) + contrib.meters;
        mRec.weeklyPoints = (mRec.weeklyPoints || 0) + contrib.points;
        if (h.c.name) mRec.name = String(h.c.name).slice(0, 16); // keep the roster label current
        mRec.lastRaceAt = new Date().toISOString();
      } else {
        mRec = {
          uid: h.uid,
          name: h.c.name || 'RACER',
          role: 'member',
          weeklyMeters: contrib.meters,
          totalMeters: contrib.meters,
          weeklyPoints: contrib.points,
          aliases: [],
          joined_at: new Date().toISOString()
        };
        cr.members.push(mRec);
      }
      // remember every key seen for this racer so the next race matches too
      mRec.aliases = mergeAliases(mRec.aliases, bindCrewIdentities(cr.id, crewIds));
      // v95: credit the kilometres durably. Fire-and-forget by design (rule 3):
      // settlement has already paid coins and rating, and the results screen must
      // not wait on two more round trips per finisher.
      persistCrewWithMember(cr, mRec).catch(() => {}); // v96: club row first (foreign key)
      crewUpdate = {
        id: cr.id,
        tag: cr.tag,
        name: cr.name,
        badge: cr.badge,
        color: cr.color,
        contribMeters: contrib.meters,
        contribPoints: contrib.points,
        totalWeeklyMeters: cr.weeklyMeters,
        totalWeeklyKm: +(cr.weeklyMeters / 1000).toFixed(1)
      };
    }

    // update in-memory stats cache
    memPlayerStats.set(h.uid, {
      uid: h.uid,
      name: h.c.name || 'RACER',
      rating: ratingNew,
      peak_rating: Math.max(st.peak_rating || 1000, ratingNew),
      xp: xpNew,
      races: (st.races || 0) + 1,
      wins: (st.wins || 0) + (win ? 1 : 0),
      podiums: (st.podiums || 0) + (podium ? 1 : 0),
      streak: streakNew,
      best_streak: bestStreakNew,
      daily_days: dailyDays,
      last_daily: lastDaily,
      updated_at: new Date().toISOString()
    });

    let failed = false;
    if (sbOn()) {
      const step = (label, fn) => { return withRetry(label + ':' + key, fn).then((ok) => { if (!ok) failed = true; }); };
      await step('history', () => fetch(SB_URL + '/rest/v1/race_history', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
        body: JSON.stringify([{ race_key: key, user_id: h.uid, map: room.mapId, mode: room.mode, position: pos, players: order.length, duration_ms: raceMs, best_lap_ms: lapMs, rating_delta: rd, xp: xpTotal }]) }));
      await step('stats', () => fetch(SB_URL + '/rest/v1/player_stats', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([withStatsName(h.c.name, { user_id: h.uid, races: (st.races || 0) + 1, wins: (st.wins || 0) + (win ? 1 : 0), podiums: (st.podiums || 0) + (podium ? 1 : 0), xp: xpNew, rating: ratingNew, peak_rating: Math.max(st.peak_rating || 1000, ratingNew), streak: streakNew, best_streak: bestStreakNew, daily_days: dailyDays, last_daily: lastDaily, challenges_done: (st.challenges_done || 0) + (chDone ? 1 : 0), updated_at: new Date().toISOString() })]) }));
      await step('records', () => fetch(SB_URL + '/rest/v1/player_map_records', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ user_id: h.uid, map: room.mapId, races: (prev ? (prev.races || 0) : 0) + 1, wins: (prev ? (prev.wins || 0) : 0) + (win ? 1 : 0), best_lap_ms: (prev && prev.best_lap_ms != null && (lapMs == null || prev.best_lap_ms < lapMs)) ? prev.best_lap_ms : lapMs, best_race_ms: (prev && prev.best_race_ms != null && (raceMs == null || prev.best_race_ms < raceMs)) ? prev.best_race_ms : raceMs }]) }));
      if (newAch.length) await step('ach', () => fetch(SB_URL + '/rest/v1/player_achievements', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
        body: JSON.stringify(newAch.map((a) => ({ user_id: h.uid, ach: a.id }))) }));
      if (season) await step('season', () => fetch(SB_URL + '/rest/v1/player_seasons', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ user_id: h.uid, season_id: season.id, rating: ratingNew, xp: (seasXp[h.uid] || 0) + xpTotal }]) }));

      // v80 Supabase sync for daily and weekly competitions
      if (lapMs != null && room.mode === 'race' && room.mapId === dailyMap) {
        // v97: the day's accumulated best lap and race count, not this race's - a
        // merge-duplicates upsert replaces the whole row.
        const dc = dailyCompRow || { best_lap_ms: lapMs, races_today: 1 };
        await step('daily_comp', () => fetch(SB_URL + '/rest/v1/daily_competition', { method: 'POST',
          headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify([withCompName(h.c.name, { date_key: today, user_id: h.uid, map: room.mapId, best_lap_ms: dc.best_lap_ms, races_today: dc.races_today || 1 })]) }));
      }
      if (weeklyPts > 0) {
        // v97: the week's accumulated total. Writing weeklyPts alone reset every
        // racer's Founders Cup score to their last race on every finish.
        const wc = weeklyCompRow || { points: weeklyPts, races_week: 1, wins_week: win ? 1 : 0, best_lap_ms: lapMs };
        await step('weekly_comp', () => fetch(SB_URL + '/rest/v1/weekly_competition', { method: 'POST',
          headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify([withCompName(h.c.name, { week_key: wKey, user_id: h.uid, points: wc.points, races_week: wc.races_week || 1, wins_week: wc.wins_week || 0, best_lap_ms: wc.best_lap_ms })]) }));
      }
      // v79 BUG-016: atomic coin increment, ledger-ref idempotent (safe to retry)
      const coinsNew = null; // v115: wallet writes retired
      if (failed) broadcastScreens(entry, { type: 'settle-warn', slot: h.c.slot }); // v79 BUG-018: never silent
    }
    rowsOut.push({
        slot: h.c.slot || (i + 1), pos, xp: xpTotal, rd, ratingNew, levelNew: lvlNew, levelUp: lvlNew > lvlOld, pr,
        dailyXp, chDone, coins, coinsNew: null,
      rankBefore, rankAfter, rankDelta, weeklyPts,
      overtakenRival,
      divisionChange,
      revengeAwarded,
      streak: streakNew,
      bestStreak: bestStreakNew,
      streakInfo,
      missionUpdates,
      bountyUpdates,
      badges: badgeEvaluations,
      crew: crewUpdate,
      ach: newAch.map((a) => ({ id: a.id, name: a.name, icon: a.icon, xp: a.xp })),
      seasonId: season ? season.id : null
    });
  }

  // v83 Photo-Finish detection (margin < 0.60s between 1st and 2nd place)
  let photoFinish = null;
  if (order.length >= 2 && order[0] && order[1] && order[0].finished && order[1].finished && order[0].finishTime != null && order[1].finishTime != null) {
    const margin = Math.abs(order[1].finishTime - order[0].finishTime);
    if (margin > 0 && margin <= 0.60) {
      photoFinish = {
        detected: true,
        winnerName: order[0].name || 'P1',
        winnerSlot: order[0].slot,
        runnerUpName: order[1].name || 'P2',
        runnerUpSlot: order[1].slot,
        margin: +margin.toFixed(3),
        marginMs: Math.round(margin * 1000),
        formattedMargin: '+' + margin.toFixed(3) + 's'
      };
      broadcastScreens(entry, { type: 'photo-finish', ...photoFinish });
    }
  }

  broadcastScreens(entry, { type: 'settle', rows: rowsOut, photoFinish });
  return rowsOut;
}

async function sbUpsert(mapId, entry) {
  if (!sbOn() || !entry.pid || entry.t == null) return;
  const pid = String(entry.pid);
  try {
    // keep the player's BEST time (read existing, write the minimum)
    const q = await fetch(SB_URL + '/rest/v1/leaderboard?map=eq.' + mapId + '&pid=eq.' + encodeURIComponent(pid) + '&select=time_ms',
      { headers: { apikey: SB_ROLE, Authorization: 'Bearer ' + SB_ROLE } });
    let t = Math.round(entry.t * 1000);
    if (q.ok) { const rows = await q.json(); if (rows && rows.length && rows[0].time_ms < t) t = rows[0].time_ms; }
    await fetch(SB_URL + '/rest/v1/leaderboard', {
      method: 'POST',
      headers: {
        apikey: SB_ROLE, Authorization: 'Bearer ' + SB_ROLE, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{ map: mapId, pid, name: String(entry.name || 'RACER').slice(0, 16), time_ms: t }]),
    });
    sbCache.t = 0; // invalidate top-5 cache
  } catch (e) { /* leaderboard persistence must never break a race */ }
}

let sbCache = { key: -1, t: 0, rows: null };
async function sbTop(mapId, daily) {
  if (!sbOn()) return null;
  const now = Date.now();
  const ck = mapId + (daily ? 100 : 0);
  if (sbCache.key === ck && sbCache.rows && now - sbCache.t < 5000) return sbCache.rows;
  try {
    let q = SB_URL + '/rest/v1/leaderboard?map=eq.' + mapId + '&order=time_ms.asc&limit=5&select=name,pid,time_ms';
    if (daily) q += '&updated_at=gte.' + new Date(startOfTodayUTC()).toISOString();
    const r = await fetch(q, { headers: { apikey: SB_ROLE, Authorization: 'Bearer ' + SB_ROLE } });
    if (!r.ok) return null;
    const rows = await r.json();
    const out = rows.map((x) => ({ name: x.name, pid: x.pid, t: x.time_ms / 1000 }));
    sbCache = { key: ck, t: now, rows: out };
    return out;
  } catch (e) { return null; }
}
// CORS-friendly HTTP endpoint so the lobby can show the global board directly.
app.get('/lb', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const m = parseInt(req.query.map, 10);
  const mapId = isNaN(m) ? 0 : m;
  const daily = req.query.daily === '1';
  if (sbOn()) { const rows = await sbTop(mapId, daily); if (rows) return res.json(rows); }
  let rows = leaderboard[mapId] || [];
  if (daily) rows = rows.filter((r) => (r.ts || 0) >= startOfTodayUTC());
  res.json(rows.slice(0, 5));
});

// ---------------------------------------------------------------------------
// v41 "race my ghost" links: ghosts live in Supabase (public read; writes only
// through the server). Without Supabase configured -> 503, client hides feature.
// ---------------------------------------------------------------------------
app.post('/ghost', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0]; // v79
  if (ghostLimited(ip)) { ghost429++; return res.status(429).json({ error: 'rate' }); } // v79 BUG-014
  const b = await readCappedBody(req, 400000); // v94 AUDIT-F1: JSON POSTs used to hang here
  if (!sbOn()) return res.status(503).json({ error: 'unavailable' });
  try {
    const j = JSON.parse(b || '{}');
    const map = parseInt(j.map, 10);
    const data = sanitizeGhostData(j.data); // v94 AUDIT-F2: reject junk frames, store clean numbers
    if (!(map >= 0 && map < 5) || !data) return res.status(400).json({ error: 'bad' });
    const id = require('crypto').randomBytes(6).toString('hex'); // v79 N-08: 12-hex, collision-resistant
    const r = await fetch(SB_URL + '/rest/v1/ghosts', {
      method: 'POST',
      headers: { apikey: SB_ROLE, Authorization: 'Bearer ' + SB_ROLE, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify([{ id, map, name: String(j.name || 'RACER').slice(0, 16), data }]),
    });
    if (!r.ok) return res.status(500).json({ error: 'db' });
    res.json({ id });
  } catch (e) { res.status(400).json({ error: 'bad' }); }
});
app.get('/ghost', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (!sbOn()) return res.status(503).json({ error: 'unavailable' });
  const id = String(req.query.id || '').replace(/[^a-z0-9]/i, '').slice(0, 12);
  if (!id) return res.status(400).json({ error: 'bad' });
  try {
    const r = await fetch(SB_URL + '/rest/v1/ghosts?id=eq.' + id + '&select=map,name,data',
      { headers: { apikey: SB_ROLE, Authorization: 'Bearer ' + SB_ROLE } });
    if (!r.ok) return res.status(404).json({ error: 'nf' });
    const rows = await r.json();
    if (!rows.length) return res.status(404).json({ error: 'nf' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'db' }); }
});

function newRoom(mode, mapId, cap) { // v76: configurable capacity (2..6)
  let code;
  do { code = core.makeRoomCode(); } while (rooms.has(code));
  const entry = { room: new core.RaceRoom(code, mode, mapId, cap), screens: new Set(), controllers: new Map(), lbSent: false, rematch: new Set(), noRecord: false, specs: new Set(), lastState: 'waiting', raceSeq: 0, _settled: false, uidBySlot: {}, pidBySlot: {}, chBySlot: {}, slotByWs: new Map(), ready: new Set(), ratingBySlot: {}, dupUid: {}, controllerPids: {} };
  rooms.set(code, entry);
  console.log(`[room ${code}] created (${entry.room.mode}, map ${entry.room.mapId})`);
  return entry;
}

function sendJSON(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function broadcastScreens(entry, obj, except) {
  const data = JSON.stringify(obj);
  if (entry.screens) {
    for (const s of entry.screens) {
      if (s !== except && s.readyState === 1) { try { s.send(data); } catch (e) {} }
    }
  }
  if (entry.specs) {
    for (const s of entry.specs) { // v64 spectators: read-only receivers
      if (s !== except && s.readyState === 1) { try { s.send(data); } catch (e) {} }
    }
  }
}

function hostSlot(entry) { let h = 0; for (const s of entry.slotByWs.values()) if (!h || s < h) h = s; return h; } // v77 BUG-006
function broadcastLobby(entry) { // v76: player list with rating + ready
  const room = entry.room;
  const players = [];
  for (const [ws, slot] of entry.slotByWs) {
    const c = room.cars[slot - 1];
    const uid = entry.uidBySlot[slot];
    // v90: club tag resolved from uuid / device pid / display name so every
    // member shows their syndicate badge in the lobby, not just signed-in ones
    const crewId = findCrewId({ uid, pid: entry.pidBySlot ? entry.pidBySlot[slot] : null, name: c && c.name });
    const crew = crewId ? memCrews.get(crewId) : null;
    players.push({
      slot,
      name: (c && c.name) || 'RACER',
      crewTag: crew ? crew.tag : null,
      crewBadge: crew ? crew.badge : null,
      rating: entry.ratingBySlot[slot] || null,
      ready: entry.ready.has(ws),
      host: slot === hostSlot(entry)
    });
  }
  players.sort((a, b) => a.slot - b.slot);
  broadcastScreens(entry, { type: 'lobby', players, cap: room.cap, weather: room.weather || 'dry', state: room.state });
}
function controllerTelemetry(entry, ws, slot) {
  const room = entry.room;
  const car = room.cars[slot - 1];
  const ps = room.participants();
  const order = room.standings();
  const rank = order.indexOf(car);
  sendJSON(ws, {
    type: 'telemetry',
    data: {
      speed: Math.round(car.speedKmh()),
      lap: `${Math.min(car.lap + 1, room.laps)}/${room.laps}`,   // v110: the race length this room is actually running
      lastLap: car.lastLap != null ? core.fmtTime(car.lastLap) : null,
      best: car.best != null ? core.fmtTime(car.best) : null,
      mode: room.mode,
      nitro: Math.round(car.nitroMeter),
      nitroOn: !!car.nitroActive,
      state: room.state,
      rank: rank >= 0 ? ['1st', '2nd', '3rd'][rank] || '' : '',
      banner: room.banner.text
    }
  });
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
  const client = { ws, role: null, slot: null, entry: null, isAlive: true };
  clientsByWs.set(ws, client);

  ws.on('message', (raw) => {
    client.isAlive = true;             // v140: any traffic proves the peer is there
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    Promise.resolve(handleMessage(client, msg)).catch(() => {});
  });
  ws.on('pong', () => { client.isAlive = true; });
  const drop = () => {
    if (client._dropped) return;       // close+error both fire: reap exactly once
    client._dropped = true;
    const i = matchQueue.indexOf(ws); if (i >= 0) matchQueue.splice(i, 1);
    clientsByWs.delete(ws); unregisterRevengeClient(client); handleLeave(client);
  };
  ws.on('close', drop);
  ws.on('error', drop);
});

// v140 PRODUCTION FIX — WebSocket heartbeat.
// There was none, so a socket that died without a FIN (phone asleep, wifi->cellular
// handover, a proxy idle-timeout) stayed "connected" forever: the room kept a
// frozen ghost car in the standings, the slot was never freed, and the client -
// which never received a close event - kept rendering a dead world as if the race
// were live. That is the server half of "sometimes the site is completely
// misbehaving". A ping every 20 s with a terminate on a missed pong hands the
// socket to the existing close path, which frees the slot and tells the room.
const HEARTBEAT_MS = 20000;
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const c = clientsByWs.get(ws);
    if (c && c.isAlive === false) { try { ws.terminate(); } catch (e) {} continue; }
    if (c) c.isAlive = false;
    try { ws.ping(); } catch (e) { try { ws.terminate(); } catch (e2) {} }
  }
}, HEARTBEAT_MS);
wsHeartbeat.unref && wsHeartbeat.unref();
wss.on('close', () => clearInterval(wsHeartbeat));

function joinRoom(client, entry, role, msg) {
  const room = entry.room;
  client.entry = entry;
  client.role = role;

  if (role === 'controller') {
    // v77 BUG-008: one physical phone = one controller slot (pid-keyed; stale socket replaced)
    const pid = (msg && typeof msg.pid === 'string' && msg.pid) ? String(msg.pid).slice(0, 24) : null;
    if (pid) {
      entry.controllerPids = entry.controllerPids || {};
      const oldWs = entry.controllerPids[pid];
      if (oldWs && oldWs !== client.ws && oldWs.readyState === 1) {
        const oldSlot = entry.controllers.get(oldWs);
        try { oldWs.close(); } catch (e) {}
        if (oldSlot) { entry.controllers.delete(oldWs); room.setController(oldSlot, false); }
      }
      entry.controllerPids[pid] = client.ws;
    }

    // Explicit slot requested by screen's QR code (e.g. &slot=2 on laptop 2)
    let slot = 0;
    const reqSlot = (msg && msg.slot != null) ? parseInt(msg.slot, 10) : 0;
    if (reqSlot >= 1 && reqSlot <= room.cap) {
      // If requested slot already had an old controller socket, clean it up
      for (const [ws, s] of entry.controllers.entries()) {
        if (s === reqSlot && ws !== client.ws) {
          try { ws.close(); } catch (e) {}
          entry.controllers.delete(ws);
          room.setController(reqSlot, false);
        }
      }
      slot = reqSlot;
    } else {
      // Otherwise assign first open controller slot
      for (let s = 1; s <= room.cap; s++) {
        if (!room.controllers[s]) {
          slot = s;
          break;
        }
      }
    }
    if (!slot) {
      sendJSON(client.ws, { type: 'full' });
      client.entry = null;
      setTimeout(() => { try { client.ws.close(); } catch (e) {} }, 500);
      return;
    }
    client.slot = slot;
    entry.controllers.set(client.ws, slot);
    room.setController(slot, true);
    sendJSON(client.ws, { type: 'welcome', role, slot, code: room.code, mode: room.mode, state: room.state });
    broadcastScreens(entry, { type: 'controller-joined', slot });
  } else {
    entry.screens.add(client.ws);
    const taken = new Set(entry.slotByWs.values());
    let slot = 0; for (let ss = 1; ss <= room.cap; ss++) if (!taken.has(ss)) { slot = ss; break; }
    if (!slot) {
      if (room.state !== 'waiting') { // v79 BUG-017: race in progress -> spectator fallback (no retry loop)
        if (entry.specs.size >= 16) { sendJSON(client.ws, { type: 'error', code: 'spec-full' }); entry.screens.delete(client.ws); client.entry = null; setTimeout(() => { try { client.ws.close(); } catch (e) {} }, 300); return; } // v79 N-07
        entry.screens.delete(client.ws);
        entry.specs.add(client.ws); client.role = 'spec'; client.slot = 0;
        sendJSON(client.ws, { type: 'joined', role: 'spec', slot: 0 });
        sendJSON(client.ws, { type: 'spec-fallback', code: room.code });
        return;
      }
      sendJSON(client.ws, { type: 'full' }); entry.screens.delete(client.ws); client.entry = null; setTimeout(() => { try { client.ws.close(); } catch (e) {} }, 500); return;
    }
    client.slot = slot;
    entry.slotByWs.set(client.ws, slot);
    // v90 club sync: the device pid must be known BEFORE the first lobby
    // broadcast, otherwise this racer's syndicate tag cannot be resolved yet
    if (msg && typeof msg.pid === 'string' && msg.pid) {
      entry.pidBySlot = entry.pidBySlot || {};
      entry.pidBySlot[slot] = msg.pid.slice(0, 64);
    }
    room.setSeat(slot, true);
    broadcastLobby(entry);
    sendJSON(client.ws, {
      type: 'welcome', role, slot: client.slot, code: room.code, mode: room.mode,
      controllers: Object.assign({}, room.controllers),
      snapshot: room.snapshot()
    });
  }
}

async function handleMessage(client, msg) {   // v121: async for the no-guest handshake gate
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'hello': {
      if (client.entry) return;
      // v121 NO-GUEST ENFORCEMENT: on deploys with Supabase configured, every
      // non-controller socket must prove a racer account (valid Supabase JWT)
      // before it gets a slot, lobby presence or a spectator seat. Phones stay
      // open: a controller is a joystick for a room an authenticated racer made.
      // Sockets already verified earlier in their life (lobby -> join) pass.
      if (msg.role !== 'controller' && sbOn() && !client.uid) {
        const uid = (typeof msg.tok === 'string' && msg.tok.length >= 20) ? await verifyUid(msg.tok) : null;
        if (!uid) {
          sendJSON(client.ws, { type: 'auth-required' });
          setTimeout(() => { try { client.ws.close(); } catch (e) {} }, 400);
          return;
        }
        client.uid = uid;
      }
      if (msg.role !== 'controller') {
        registerRevengeClient(client, msg);          // v111 live revenge registry
        resumeAcceptedRevenge(client).catch(() => {}); // an accepted grudge resumes when both are online
      }
      let entry = null;
      if (msg.room) {
        entry = rooms.get(String(msg.room).toUpperCase().trim());
        if (!entry) { sendJSON(client.ws, { type: 'error', code: 'no-room' }); return; }
      } else if (msg.lobby) {
        // v88 on-demand: user connects to lobby pool without creating a 30Hz simulation room
        client.role = 'lobby';
        sendJSON(client.ws, { type: 'lobby_welcome', role: 'lobby', online: clientsByWs.size, activeRooms: rooms.size });
        return;
      } else {
        entry = newRoom(msg.mode === 'coop' ? 'coop' : 'race', msg.map, msg.mode === 'coop' ? 2 : 6); // v76
      }
      if (msg.role === 'spec') {
        if (entry.specs.size >= 16) { sendJSON(client.ws, { type: 'error', code: 'spec-full' }); setTimeout(() => { try { client.ws.close(); } catch (e) {} }, 300); return; } // v79 N-07
        client.entry = entry; client.role = 'spec'; entry.specs.add(client.ws);
        sendJSON(client.ws, { type: 'joined', role: 'spec', slot: 0 });
      } else {
        joinRoom(client, entry, msg.role === 'controller' ? 'controller' : 'screen', msg);
      }
      if (client.role === 'screen' && client.slot) {
        const room = entry.room;
        if (msg.pid) { entry.pidBySlot = entry.pidBySlot || {}; entry.pidBySlot[client.slot] = String(msg.pid).slice(0, 64); } // v90 club sync
        if (msg.weather != null) room.setWeather(msg.weather);
        if (msg.laps != null) room.setLaps(msg.laps);
        if (msg.bot != null) room.setBot(msg.bot);
        if (msg.record === false) entry.noRecord = true; // v61 practice
        if (msg.botSkill != null) room.setBotSkill(parseInt(msg.botSkill, 10)); // v45
        if (msg.name || msg.color || msg.cls || msg.sens != null) room.setPlayerMeta(client.slot, msg); // v92 sensitivity rides along
        if (msg.cls) { classPick(msg.cls); room.cars[client.slot - 1].clsKey = msg.cls; } // v64 telemetry
        if (msg.cos || msg.title) room.cars[client.slot - 1].setCos(msg.cos, msg.title); // v59
        // v73: verify the racer's Supabase token server-side -> authoritative uid
        if (msg.tok) verifyUid(msg.tok).then(async (uid) => {
          if (uid && client.entry) {
            client.uid = uid; entry.uidBySlot[client.slot] = uid;
            // v97: this racer just proved an account. Fold the device-keyed career
            // into the account row so the board does not show them twice.
            const guestKey = entry.pidBySlot ? entry.pidBySlot[client.slot] : '';
            if (guestKey && guestKey !== uid && guestKey.replace(/^sb:/, '') !== uid) mergeRacerIdentity(guestKey, uid).catch(() => {});
            // v79 BUG-013: safe session takeover — only a LIVE, recently-pinging
            // socket of the same uid blocks; a half-dead one is replaced cleanly.
            entry.uidWs = entry.uidWs || {};
            const other = entry.uidWs[uid];
            let dup = false;
            if (other && other.ws !== client.ws) {
              const fresh = other.ws.readyState === 1 && (Date.now() - (other.lastPing || 0) < 45000);
              if (fresh) dup = true;
              else { try { other.ws.close(); } catch (e) {} delete entry.uidBySlot[other.slot]; delete entry.ratingBySlot[other.slot]; delete entry.dupUid[other.slot]; }
            }
            entry.dupUid[client.slot] = dup; // v77 anti-self-play preserved
            entry.uidWs[uid] = { ws: client.ws, slot: client.slot, lastPing: Date.now() };
            try { const r = await fetch(SB_URL + '/rest/v1/player_stats?user_id=eq.' + uid + '&select=rating', { headers: sbHdr() }); if (r.ok) { const j = await r.json(); if (j[0]) entry.ratingBySlot[client.slot] = j[0].rating; } } catch (e) {}
            broadcastLobby(entry);
          }
        }); // v76
        if (msg.chid) entry.chBySlot[client.slot] = String(parseInt(msg.chid, 10) || ''); // v74 challenge link
      }
      break;
    }

    case 'create_room': {
      if (client.entry) {
        const old = client.entry;
        handleLeave(client);
        if (old.screens.size === 0 && old.controllers.size === 0) rooms.delete(old.room.code);
      }
      const mode = msg.mode === 'coop' ? 'coop' : (['elim', 'drift'].includes(msg.mode) ? msg.mode : 'race');
      const mapId = parseInt(msg.map, 10) || 0;
      const cap = mode === 'coop' ? 2 : (parseInt(msg.cap, 10) || 6);
      const entry = newRoom(mode, mapId, cap);
      joinRoom(client, entry, 'screen', msg);
      if (client.slot) {
        const room = entry.room;
        if (msg.pid) { entry.pidBySlot = entry.pidBySlot || {}; entry.pidBySlot[client.slot] = String(msg.pid).slice(0, 64); } // v90 club sync
        if (msg.weather != null) room.setWeather(msg.weather);
        if (msg.laps != null) room.setLaps(msg.laps);
        if (msg.bot != null) room.setBot(msg.bot);
        if (msg.record === false) entry.noRecord = true;
        if (msg.botSkill != null) room.setBotSkill(parseInt(msg.botSkill, 10));
        if (msg.name || msg.color || msg.cls || msg.sens != null) room.setPlayerMeta(client.slot, msg); // v92 sensitivity rides along
        if (msg.cls) { classPick(msg.cls); room.cars[client.slot - 1].clsKey = msg.cls; }
        if (msg.cos || msg.title) room.cars[client.slot - 1].setCos(msg.cos, msg.title);
        if (msg.tok) verifyUid(msg.tok).then(async (uid) => {
          if (uid && client.entry) {
            client.uid = uid; entry.uidBySlot[client.slot] = uid;
            // v97: same as the start path - fold the device-keyed career into the
            // account row so this racer does not appear twice on the boards.
            const guestKey2 = entry.pidBySlot ? entry.pidBySlot[client.slot] : '';
            if (guestKey2 && guestKey2 !== uid && guestKey2.replace(/^sb:/, '') !== uid) mergeRacerIdentity(guestKey2, uid).catch(() => {});
            entry.uidWs = entry.uidWs || {};
            const other = entry.uidWs[uid];
            let dup = false;
            if (other && other.ws !== client.ws) {
              const fresh = other.ws.readyState === 1 && (Date.now() - (other.lastPing || 0) < 45000);
              if (fresh) dup = true;
              else { try { other.ws.close(); } catch (e) {} delete entry.uidBySlot[other.slot]; delete entry.ratingBySlot[other.slot]; delete entry.dupUid[other.slot]; }
            }
            entry.dupUid[client.slot] = dup;
            entry.uidWs[uid] = { ws: client.ws, slot: client.slot, lastPing: Date.now() };
            try { const r = await fetch(SB_URL + '/rest/v1/player_stats?user_id=eq.' + uid + '&select=rating', { headers: sbHdr() }); if (r.ok) { const j = await r.json(); if (j[0]) entry.ratingBySlot[client.slot] = j[0].rating; } } catch (e) {}
            broadcastLobby(entry);
          }
        });
      }
      break;
    }

    case 'map': {
      if (!client.entry || client.role !== 'screen') break;
      const en = client.entry;
      // v93: an id that names no track is ignored rather than clamped to 0 -
      // silently moving a room to Highland would be worse than doing nothing,
      // and the 30 Hz snapshot repaints the client's wizard either way.
      const wantMap = validMapId(msg.map);
      if (wantMap == null) break;
      if (en.screens.size < 3 || client.slot === hostSlot(en)) { // v76/v77 host-only 3+
        // setMap() only works while the room is waiting; say so instead of nothing
        if (!en.room.setMap(wantMap)) sendJSON(client.ws, { type: 'error', code: 'map-in-race', map: en.room.mapId });
      } else {
        sendJSON(client.ws, { type: 'error', code: 'map-host-only', map: en.room.mapId }); // v93
      }
      break;
    }

    case 'weather':
      if (client.entry && client.role === 'screen' && (client.entry.screens.size < 3 || client.slot === hostSlot(client.entry))) {
        client.entry.room.setWeather(msg.weather);
        broadcastScreens(client.entry, { type: 'weather', weather: client.entry.room.weather });
      }
      break;

    case 'meta':
      if (client.entry && client.role === 'screen' && client.slot) {
        if (msg.pid) { client.entry.pidBySlot = client.entry.pidBySlot || {}; client.entry.pidBySlot[client.slot] = String(msg.pid).slice(0, 64); } // v90 club sync
        client.entry.room.setPlayerMeta(client.slot, msg);
        if (msg.cos || msg.title) client.entry.room.cars[client.slot - 1].setCos(msg.cos, msg.title); // v59
        if (msg.botSkill != null) client.entry.room.setBotSkill(parseInt(msg.botSkill, 10)); // v45
      }
      break;

    case 'laps':
      if (client.entry && client.role === 'screen' && (client.entry.screens.size < 3 || client.slot === hostSlot(client.entry))) client.entry.room.setLaps(msg.laps); // v76/v77
      break;

    case 'bot':
      if (client.entry && client.role === 'screen') client.entry.room.setBot(msg.bot);
      break;

    // v61: practice flag + quick restart (screen-controlled, no reconnect)
    case 'record':
      if (client.entry && client.role === 'screen') client.entry.noRecord = msg.record === false;
      break;
    case 'restart':
      if (client.entry && client.role === 'screen') client.entry.room.restart();
      break;

    case 'input': {
      const nowSec = Math.floor(Date.now() / 1000);
      if (client._msgSec !== nowSec) { client._msgSec = nowSec; client._msgCount = 0; }
      client._msgCount = (client._msgCount || 0) + 1;
      if (client._msgCount > 180) return; // throttle flood
      if (!client.entry) return;
      const room = client.entry.room;
      if (client.role === 'controller' && client.slot) {
        room.setInput(client.slot, msg);
      } else if (client.role === 'screen' && client.slot) {
        // laptop keyboard may drive its own car while no phone is connected
        if (!room.controllers[client.slot]) room.setInput(client.slot, msg);
      }
      break;
    }

    case 'ready': { // v76
      if (client.entry && client.role === 'screen') {
        if (msg.on) client.entry.ready.add(client.ws); else client.entry.ready.delete(client.ws);
        broadcastLobby(client.entry);
      }
      break;
    }
    case 'start': {
      if (!client.entry && (client.role === 'screen' || client.role === 'lobby')) {
        const mode = msg.mode === 'coop' ? 'coop' : 'race';
        const entry = newRoom(mode, validMapId(msg.map), mode === 'coop' ? 2 : 6); // v93 the chosen track, not map 0
        joinRoom(client, entry, 'screen', msg);
        // v93: the client now ships its identity with start, so an on-demand room
        // seats the real driver (name / class / colour / sensitivity / laps)
        // instead of the seat defaults.
        if (client.slot) {
          if (msg.pid) { entry.pidBySlot = entry.pidBySlot || {}; entry.pidBySlot[client.slot] = String(msg.pid).slice(0, 64); }
          if (msg.laps != null) entry.room.setLaps(msg.laps);
          if (msg.bot != null) entry.room.setBot(msg.bot);
          if (msg.weather != null) entry.room.setWeather(msg.weather);
          if (msg.name || msg.color || msg.cls || msg.sens != null) entry.room.setPlayerMeta(client.slot, msg);
          if (msg.cos || msg.title) entry.room.cars[client.slot - 1].setCos(msg.cos, msg.title);
        }
      }
      if (client.entry && client.role === 'screen') {
        const en = client.entry;
        if (en.screens.size >= 3) {
          if (client.slot !== hostSlot(en)) { sendJSON(client.ws, { type: 'need-ready', msg: 'host starts 3+ player races' }); break; } // v77 BUG-006
          let allReady = true;
          for (const ws of en.screens) if (ws !== client.ws && !en.ready.has(ws)) allReady = false;
          if (!allReady) { sendJSON(client.ws, { type: 'need-ready', msg: 'waiting for all racers to ready up' }); break; }
        }
        en.rematch && en.rematch.clear(); en.ready.clear(); en.room.start(); broadcastLobby(en);
      }
      break;
    }

    // v59 rematch voting: when every connected screen/controller votes, reuse the room
    case 'rematch':
      if (client.entry) {
        const en = client.entry;
        const voteKey = client.slot || client.ws;
        en.rematch.add(voteKey);
        en.room.events.push({ type: 'rematch', n: en.rematch.size, total: Math.max(1, en.screens.size) });
        if (en.rematch.size >= Math.max(1, en.screens.size)) { en.rematch.clear(); en.room.start(); }
      }
      break;

    case 'mode':
      if (client.entry && client.role === 'screen') client.entry.room.setMode(msg.mode);
      break;

    case 'reset':
      if (client.entry && client.role === 'screen') client.entry.room.resetToWaiting();
      break;

    case 'leave': {
      // v91: explicit room exit. The socket stays open and the racer is parked
      // back in the lobby pool, ready to CREATE or JOIN another room.
      const info = leaveCurrentRoom(client);
      if (info && info.prevRole === 'controller') {
        // phones get a plain acknowledgement — the pad UI has no lobby state
        sendJSON(client.ws, { type: 'left', role: 'controller', room: info.code, slot: info.slot });
        break;
      }
      client.role = 'lobby';
      sendJSON(client.ws, {
        type: 'lobby_welcome', role: 'lobby', left: true,
        room: info ? info.code : null, slot: info ? info.slot : 0,
        online: clientsByWs.size, activeRooms: rooms.size
      });
      break;
    }

    case 'join_room': {
      // v91: hop to another room by code without a page reload. The target is
      // validated BEFORE anything is torn down, so a typo or a full room never
      // throws the racer out of the seat they already have. The join itself
      // reuses the hello path (slot assignment, pid capture for club sync,
      // token verification, snapshot, lobby broadcast).
      const code = String(msg.room || msg.code || '').toUpperCase().trim();
      const target = code ? rooms.get(code) : null;
      if (!target) {
        sendJSON(client.ws, { type: 'error', code: 'join-failed', reason: 'no-room', room: code });
        return;
      }
      if (client.entry === target) {
        sendJSON(client.ws, { type: 'error', code: 'join-failed', reason: 'already-in-room', room: code });
        return;
      }
      const seated = target.slotByWs ? target.slotByWs.size : 0;
      const cap = (target.room && target.room.cap) || 6;
      if (seated >= cap) {
        sendJSON(client.ws, { type: 'error', code: 'join-failed', reason: 'full', room: code });
        return;
      }
      leaveCurrentRoom(client);
      handleMessage(client, Object.assign({}, msg, { type: 'hello', role: 'screen', room: code }));
      break;
    }

    case 'button': {
      if (!client.entry || client.role !== 'controller' || !client.slot) return;
      const entry = client.entry;
      if (msg.action === 'horn') {
        broadcastScreens(entry, { type: 'horn', slot: client.slot });
      } else if (msg.action === 'reset') {
        entry.room.resetCar(client.slot);
        broadcastScreens(entry, { type: 'car-reset', slot: client.slot });
      } else if (msg.action === 'cam') {
        broadcastScreens(entry, { type: 'cam', slot: client.slot });
      }
      break;
    }

    case 'matchmake': {
      // Quick-Play: queue this screen; when two are waiting, pair them into a
      // fresh room (each becomes a driver screen). Purely additive.
      if (client.entry) {
        // A fresh client auto-created an empty room on hello; leave it so we
        // can pair. If the room already has other people, ignore the request.
        const entry = client.entry;
        const empty = entry.screens.size <= 1 && entry.controllers.size === 0 && entry.room.state === 'waiting';
        if (!empty) return;
        entry.screens.delete(client.ws);
        client.entry = null; client.role = null; client.slot = null;
        if (entry.screens.size === 0 && entry.controllers.size === 0) rooms.delete(entry.room.code);
      }
      if (!matchQueue.includes(client.ws)) matchQueue.push(client.ws);
      // Clean dead or closed sockets from matchQueue
      for (let i = matchQueue.length - 1; i >= 0; i--) {
        const ws = matchQueue[i];
        if (!ws || ws.readyState !== 1 || !clientsByWs.has(ws)) matchQueue.splice(i, 1);
      }
      sendJSON(client.ws, { type: 'searching', waiting: matchQueue.length });
      if (matchQueue.length >= 2) {
        const wsA = matchQueue.shift(), wsB = matchQueue.shift();
        const cA = clientsByWs.get(wsA), cB = clientsByWs.get(wsB);
        if (cA && cB && wsA.readyState === 1 && wsB.readyState === 1) {
          const entry = newRoom('race', 0, 6); // v76
          joinRoom(cA, entry, 'screen');
          joinRoom(cB, entry, 'screen');
          sendJSON(wsA, { type: 'matched', code: entry.room.code });
          sendJSON(wsB, { type: 'matched', code: entry.room.code });
        } else {
          if (cA && wsA.readyState === 1) matchQueue.unshift(wsA);
          if (cB && wsB.readyState === 1) matchQueue.unshift(wsB);
        }
      }
      break;
    }

    case 'ping':
      client.msgs = 0; // v76 rate window reset
      client.lastPing = Date.now(); // v79 BUG-013
      if (client.entry && client.uid && client.entry.uidWs && client.entry.uidWs[client.uid]) client.entry.uidWs[client.uid].lastPing = Date.now();
      sendJSON(client.ws, { type: 'pong', t: msg.t });
      break;
  }
}

function handleLeave(client) {
  const qIdx = matchQueue.indexOf(client.ws);
  if (qIdx !== -1) matchQueue.splice(qIdx, 1);

  const entry = client.entry;
  if (!entry) return;
  client.entry = null;

  if (client.role === 'controller' && client.slot) {
    const still = [...entry.controllers.values()].some((s, i) =>
      s === client.slot && [...entry.controllers.keys()][i] !== client.ws);
    entry.controllers.delete(client.ws);
    if (entry.controllerPids) for (const [p, w] of Object.entries(entry.controllerPids)) if (w === client.ws) delete entry.controllerPids[p]; // v79 BUG-015
    if (!still) {
      entry.room.setController(client.slot, false);
      entry.room.setInput(client.slot, core.ZERO_INPUT());
      broadcastScreens(entry, { type: 'controller-left', slot: client.slot });
    }
  } else if (client.role === 'screen') {
    entry.screens.delete(client.ws);
    const sl = entry.slotByWs.get(client.ws);
    if (sl) {
      entry.slotByWs.delete(client.ws); entry.ready.delete(client.ws);
      delete entry.uidBySlot[sl]; delete entry.ratingBySlot[sl]; delete entry.dupUid[sl]; // v77 BUG-002
      if (entry.pidBySlot) delete entry.pidBySlot[sl]; // v90 club sync
      if (client.uid && entry.uidWs && entry.uidWs[client.uid] && entry.uidWs[client.uid].ws === client.ws) delete entry.uidWs[client.uid]; // v79
      if (entry.room.state === 'waiting') entry.room.setSeat(sl, false);
      broadcastLobby(entry);
    }
  } else if (client.role === 'spec') {
    entry.specs.delete(client.ws);
  }

  const empty = entry.screens.size === 0 && entry.controllers.size === 0 && entry.specs.size === 0;
  if (empty && Date.now() - entry.room.lastActivity > 60 * 1000) {
    rooms.delete(entry.room.code);
    console.log(`[room ${entry.room.code}] closed (empty)`);
  }
}

// ---------------------------------------------------------------------------
// v91 EXIT ROOM — leave the current room without dropping the socket
//
// Until now the only way out of a room was to reload the page: there was no
// `leave` message, handleLeave() ran solely on socket close, and the floating
// EXIT button merely reset the starting grid. Exiting is now explicit, so a
// racer can step out and straight into another room (or found a new one) while
// keeping their session, garage loadout and club identity intact.
// ---------------------------------------------------------------------------
function leaveCurrentRoom(client) {
  const entry = client.entry;
  if (!entry) return null;
  const prevRole = client.role;
  const slot = client.slot || 0;
  const code = entry.room.code;
  handleLeave(client); // frees slot, uid/pid maps, ready state; re-broadcasts the lobby
  client.entry = null; client.role = null; client.slot = 0; client.uid = null;
  // a room nobody is left in is closed immediately, so its 5-letter code stops
  // being advertised as live and can be handed out again
  if (entry.screens.size === 0 && entry.controllers.size === 0 && entry.specs.size === 0) {
    rooms.delete(code);
    console.log(`[room ${code}] closed (everyone left)`);
  }
  return { entry, code, slot, prevRole };
}

// ---------------------------------------------------------------------------
// Game loop — advance every room, stream snapshots + telemetry
// ---------------------------------------------------------------------------
let tickCount = 0;
const tickInterval = setInterval(() => {
  tickCount++;
  const dt = 1 / core.CFG.tickHz;
  const now = Date.now();

  for (const [code, entry] of rooms) {
    const room = entry.room;
    room.update(dt);
    if (entry.screens.size === 0) room.events.length = 0; // v77 BUG-004: unwatched rooms must not accumulate events
    const hasHumans = entry.screens.size > 0 || entry.controllers.size > 0;
    if (hasHumans) entry.lastHuman = now;

    // v73: race sequencing + one-time authoritative settlement per race
    if (room.state === 'countdown' && entry.lastState !== 'countdown') { entry.raceSeq = (entry.raceSeq || 0) + 1; entry._settled = false; }
    entry.lastState = room.state;
    if (room.state === 'finished' && !entry._settled) { entry._settled = true; settleRace(entry); }

    // record finishes to the per-map leaderboard (once per car per race)
    for (const car of room.cars) {
      if (car.finished && car.finishTime != null && !car._lb) {
        car._lb = true;
        { // v64 class result telemetry
          const order = room.standings(); const pos = order.indexOf(car) + 1;
          classResult(car.clsKey || 'velocity', pos || order.length, car.finishTime, pos === 1);
        }
        if (!entry.noRecord) {
          lbAdd(room.mapId, { name: car.name, pid: car.pid || null, t: car.finishTime, best: car.best, ts: now });
        sbUpsert(room.mapId, { name: car.name, pid: car.pid || null, t: car.finishTime });
        }
        recentAdd({ name: car.name, map: room.mapId, t: car.finishTime, ts: now });
      }
    }

    if (entry.screens.size > 0) {
      // Bandwidth: the lobby is idle -> 5 Hz is plenty there; races keep the
      // full 30 Hz so gameplay quality is unchanged. Leaderboard piggybacks
      // at 1 Hz instead of every snapshot (clients cache the last one).
      const inRace = room.state !== 'waiting';
      const sendNow = inRace ? (!LOW_BW || tickCount % 2 !== 0) : tickCount % 6 === 0; // v71: 15 Hz snapshots in lean mode (was 10)
      if (sendNow) {
        const snapObj = room.snapshot();
        if (tickCount % 30 === 0 || !entry.lbSent) { snapObj.lb = lbGet(room.mapId); entry.lbSent = true; }
        const snap = JSON.stringify(snapObj);
        for (const s of entry.specs) { // v64 spectators receive snapshots too
          if (s.readyState === 1) { try { s.send(snap); } catch (e) {} }
        }
        for (const s of entry.screens) {
          if (s.readyState === 1) { try { s.send(snap); } catch (e) {} }
        }
      }
    }

    // telemetry to phones every 5 ticks (~6.7 Hz), 10 in lean mode
    if (tickCount % (LOW_BW ? 10 : 5) === 0 && entry.controllers.size > 0) {
      for (const [ws, slot] of entry.controllers) controllerTelemetry(entry, ws, slot);
    }

    // garbage-collect abandoned rooms
    if (entry.screens.size === 0 && entry.controllers.size === 0 && (now - (entry.room.lastActivity || 0) > 60 * 1000 || now - (entry.lastHuman || 0) > IDLE_ROOM_MS)) {
      rooms.delete(code); // v77 BUG-004: bots can no longer keep abandoned rooms alive
      console.log(`[room ${code}] closed (idle)`);
    }
  }
}, TICK_MS);
if (tickInterval.unref) tickInterval.unref();

app.get(['/health', '/api/health'], (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  // v94 AUDIT-F3: memory + durability gauges. Uptime platforms poll this, so an
  // operator can watch the fallback stores fill BEFORE the host OOM-kills the
  // process - and `persisted:false` says plainly that progress lives only in RAM.
  const mu = process.memoryUsage();
  res.json({
    ok: true, rooms: rooms.size, tickHz: core.CFG.tickHz,
    mem: {
      heapMB: +(mu.heapUsed / 1048576).toFixed(1),
      rssMB: +(mu.rss / 1048576).toFixed(1),
      players: memPlayerStats.size,
      missions: memPlayerMissions.size,
      bounties: memWeeklyBounties.size,
      crews: memCrews.size,
      crewMembers: memPlayerCrew.size,
      revenge: memRevengeTargets.size,
      anUsers: Object.keys(AN.users).length,
      cap: MEM_CAP,
      persisted: sbOn()
    },
    // v96: WHY nothing is persisting, when nothing is. `verdict` is one of
    // ok | not_configured | anon_key | key_rejected | table_missing |
    // unreachable | server_error. No secret material - only the key's role name.
    persistence: persistenceHealth
  });
});
// build marker — lets you verify at a glance that frontend + server run the
// SAME version (version drift between them causes "ghost" physics bugs)
app.get('/version', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ build: 'v140', tickHz: core.CFG.tickHz, geom: core.GEOM_ID, lowBw: LOW_BW });
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled Rejection:', reason);
});

// v94 AUDIT: say plainly, at boot, what survives a restart. Several progression
// subsystems have no database persistence wired up at all yet, and without
// Supabase NOTHING does - an operator would otherwise find out only when players
// start losing clubs, coins and ratings after a redeploy.
function durabilityReport() {
  const lines = [];
  if (!sbOn()) {
    lines.push('!! SUPABASE_URL / SUPABASE_SERVICE_ROLE are not set - running RAM-ONLY.');
    lines.push('!! Accounts, coins, inventory, ratings, leaderboards, daily/weekly cups, clubs,');
    lines.push('!!   missions, bounties, badges and ghosts are LOST on every restart or redeploy.');
    lines.push('!! Fine for local play; not acceptable for a public site. See README > Supabase setup.');
  } else {
    lines.push('Supabase connected: accounts, coins, inventory, ratings, leaderboards, cups, ghosts,');
    lines.push('  clubs, daily missions, weekly bounties, equipped badges and revenge targets persist.');
    lines.push('  Needs the v96 schema - run supabase-migration-v96.sql once if this project predates it.');
  }
  lines.push(`Memory: cap ${MEM_CAP} entries/store, ${AN_USER_CAP} analytics visitors, swept every 10 min (gauges at /health).`);
  return lines;
}

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[velocity-rush] multiplayer server on http://0.0.0.0:${PORT} (${core.CFG.tickHz} Hz sim)`);
    for (const l of durabilityReport()) {
      if (l.startsWith('!!')) console.warn('[velocity-rush] ' + l); else console.log('[velocity-rush] ' + l);
    }
    // v96: name the reason progress is not durable, if it is not. The old probe
    // could only tell "crew_members is readable" from "it is not", and a read
    // through the anon key returns an empty set - readable - while every write is
    // rejected and every club silently disappears at the next restart.
    checkPersistenceHealth().catch(() => {});
  });
}

module.exports = {
  app,
  server,
  rooms,
  AN,
  persistAnalytics,
  loadAnalytics,
  joinRoom,
  handleMessage,
  handleLeave,
  leaveCurrentRoom,
  newRoom,
  settleRace,
  dailyInfo,
  weeklyInfo,
  memPlayerStats,
  memDailyComp,
  memWeeklyComp,
  memPlayerMissions,
  memEquippedBadges,
  memRevengeTargets,
  addRevengeTarget,
  readRevengeTargets,
  clearRevengeTarget,
  normalizeRevengeTarget,
  revengeKeys,
  validMapId,
  revengeIdsFor,
  memWeeklyBounties,
  getOrInitWeeklyBounties,
  getAllRatingRows,
  getOrInitMissions,
  memCrews,
  memPlayerCrew,
  memClaimedCrewMilestones,
  memCrewAliases,
  memCrewNameHints,
  findCrewId,
  findCrewIdStrong,
  refreshLobbyCrewTags,
  findCrewMember,
  crewKeysFor,
  crewStrongKeys,
  normCrewKey,
  rollCrewWeek,
  crewClaimKey,
  reconcileCrewWeekly,
  bindCrewIdentities,
  unbindCrewIdentities,
  mergeAliases,
  leaderboard,
  // v94 audit hardening - exported so the tests can exercise them directly
  readCappedBody,
  sanitizeGhostData,
  sweepMemory,
  capMap,
  pruneOldPeriods,
  periodAgeMs,
  capAnUsers,
  MEM_CAP,
  AN_USER_CAP,
  durabilityReport,
  // v95 durable progression - exported so the tests can drive them with a stubbed
  // fetch (the only way to exercise the Supabase paths without a live project)
  sbOn,
  sbSelect,
  sbUpsertRows,
  sbDelete,
  sbWarnOnce,
  sbWarned,
  hydrated,
  missionsMap,
  bountiesMap,
  mergeProgressState,
  hydrateMissions,
  persistMissions,
  hydrateBounties,
  persistBounties,
  hydrateEquippedBadge,
  persistEquippedBadge,
  hydrateRevenge,
  persistRevengeTarget,
  clearRevengeRows,
  hydrateCrew,
  hydrateAllCrews,
  findCrewIdDurable,
  persistCrewRow,
  persistCrewMember,
  persistCrewWithMember,
  serviceKeyRole,
  classifySchemaProbe,
  persistenceVerdict,
  probeSchemaWrite,
  probeSchemaRead,
  checkPersistenceHealth,
  sbStatsState,
  canonicalRacerKey,
  racerIdentities,
  rowMatchesIdentities,
  mergeStatsRows,
  withStatsName,
  mergeRacerIdentity,
  mergeDailyRow,
  mergeWeeklyRow,
  hydrateDailyComp,
  hydrateWeeklyComp,
  withCompName,
  persistenceHealth,
  deleteCrewMemberRow,
  persistCrewClaim,
  crewDbRow,
  crewMemberDbRow,
  applyCrewRow,
  applyMemberRow,
  SEEDED_CREW_IDS,
  currentWeekKey
};
