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
const cos = require('./shared/cosmetics.js'); // v75 garage catalog

const PORT = parseInt(process.env.PORT || '3000', 10);
// Opt-in lean mode for tight free tiers (set LOW_BANDWIDTH=1): race snapshots
// 30->20 Hz and phone telemetry 6->3 Hz. Sim rate stays 30 Hz; interpolation
// keeps motion smooth, so gameplay feel is unchanged while bandwidth drops ~1/3.
const LOW_BW = process.env.LOW_BANDWIDTH === '1';
const TICK_MS = 1000 / core.CFG.tickHz;
const IDLE_ROOM_MS = 10 * 60 * 1000;

const app = express();
app.disable('x-powered-by');
app.use(express.json());

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

app.post('/a', (req, res) => {
  let b = '';
  req.on('data', (c) => { if (b.length < 2000) b += c; });
  req.on('end', () => {
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
  });
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
if (!leaderboard[0] || !leaderboard[0].length) {
  leaderboard[0] = [{ name: 'APEX_HUNTER', pid: 'seed_pro_1', t: 42.15, ts: Date.now() }, { name: 'DRIFT_KING', pid: 'seed_pro_2', t: 44.30, ts: Date.now() }];
  leaderboard[1] = [{ name: 'DRIFT_KING', pid: 'seed_pro_2', t: 58.40, ts: Date.now() }];
  leaderboard[2] = [{ name: 'TURBO_VIPER', pid: 'seed_pro_3', t: 64.20, ts: Date.now() }];
}

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
const memPlayerStats = new Map([
  ['seed_pro_1', { uid: 'seed_pro_1', name: 'APEX_HUNTER', rating: 1650, peak_rating: 1650, xp: 4500, races: 28, wins: 22, podiums: 26, streak: 5, best_streak: 8 }],
  ['seed_pro_2', { uid: 'seed_pro_2', name: 'DRIFT_KING', rating: 1420, peak_rating: 1450, xp: 2800, races: 19, wins: 12, podiums: 16, streak: 2, best_streak: 4 }],
  ['seed_pro_3', { uid: 'seed_pro_3', name: 'TURBO_VIPER', rating: 1280, peak_rating: 1300, xp: 1900, races: 15, wins: 8, podiums: 11, streak: 1, best_streak: 3 }]
]); // uid -> { uid, name, rating, peak_rating, xp, races, wins, podiums, streak, best_streak, daily_days, last_daily }
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
    if (uid) {
      const uIdx = rows.findIndex((r) => r.pid === uid || r.name === uid);
      if (uIdx >= 0) userRank = uIdx + 1;
    }
    const total = rows.length;
    let outRows = rows;
    if (scope === 'nearby' && uid) {
      const resBracket = prog.getNearbyBracket(rows, uid, 2);
      outRows = resBracket.bracket.map((b) => Object.assign({}, b.item, { rank: b.rank }));
      if (resBracket.targetRank > 0) userRank = resBracket.targetRank;
    } else {
      outRows = rows.slice(offset, offset + limit);
    }
    return res.json({ ok: true, type: 'time', map: mapId, total, userRank, rows: outRows });
  }

  // Rating / Wins / Races board
  let allRows = [];
  if (sbOn()) {
    try {
      let orderCol = 'rating.desc,wins.desc,races.asc';
      if (type === 'wins') orderCol = 'wins.desc,rating.desc,races.asc';
      else if (type === 'races') orderCol = 'races.desc,wins.desc';

      const [stR, prR] = await Promise.all([
        fetch(SB_URL + '/rest/v1/player_stats?order=' + orderCol + '&limit=100&select=user_id,rating,xp,races,wins,podiums,streak,best_streak,updated_at', { headers: sbHdr() }),
        fetch(SB_URL + '/rest/v1/profiles?select=id,username', { headers: sbHdr() })
      ]);
      if (stR.ok) {
        const statsData = await stR.json();
        const profMap = {};
        if (prR.ok) (await prR.json()).forEach((p) => { profMap[p.id] = p.username; });
        allRows = statsData.map((s, idx) => {
          const lv = prog.levelFromXp(s.xp || 0).level;
          const tr = prog.tier(s.rating || 1000);
          const winRate = s.races > 0 ? +((s.wins / s.races) * 100).toFixed(1) : 0;
          return {
            rank: idx + 1,
            uid: s.user_id,
            name: profMap[s.user_id] || 'RACER',
            rating: s.rating || 1000,
            tier: tr,
            level: lv,
            xp: s.xp || 0,
            wins: s.wins || 0,
            races: s.races || 0,
            winRate: winRate + '%',
            podiums: s.podiums || 0,
            streak: s.streak || 0,
            bestStreak: s.best_streak || 0,
            updatedAt: s.updated_at
          };
        });
      }
    } catch (e) {}
  }

  if (!allRows.length) {
    const list = Array.from(memPlayerStats.values());
    if (type === 'wins') list.sort((a, b) => (b.wins || 0) - (a.wins || 0) || (b.rating || 1000) - (a.rating || 1000));
    else if (type === 'races') list.sort((a, b) => (b.races || 0) - (a.races || 0));
    else list.sort((a, b) => (b.rating || 1000) - (a.rating || 1000) || (b.wins || 0) - (a.wins || 0));

    allRows = list.map((s, idx) => {
      const lv = prog.levelFromXp(s.xp || 0).level;
      const tr = prog.tier(s.rating || 1000);
      const winRate = s.races > 0 ? +((s.wins / s.races) * 100).toFixed(1) : 0;
      return {
        rank: idx + 1,
        uid: s.uid,
        name: s.name || 'RACER',
        rating: s.rating || 1000,
        tier: tr,
        level: lv,
        xp: s.xp || 0,
        wins: s.wins || 0,
        races: s.races || 0,
        winRate: winRate + '%',
        podiums: s.podiums || 0,
        streak: s.streak || 0,
        bestStreak: s.best_streak || 0
      };
    });
  }

  const total = allRows.length;
  let userRank = null, userPercentile = null;
  if (uid) {
    const uIdx = allRows.findIndex((r) => r.uid === uid || r.name === uid);
    if (uIdx >= 0) {
      userRank = uIdx + 1;
      userPercentile = prog.calculatePercentile(userRank, total);
    }
  }

  let outRows = allRows;
  if (scope === 'nearby' && uid) {
    const resBracket = prog.getNearbyBracket(allRows, uid, 2);
    outRows = resBracket.bracket.map((b) => Object.assign({}, b.item, { rank: b.rank }));
    if (resBracket.targetRank > 0) userRank = resBracket.targetRank;
  } else {
    outRows = allRows.slice(offset, offset + limit);
  }

  res.json({ ok: true, type, total, userRank, userPercentile, rows: outRows });
});

app.get('/api/competitions/daily', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const dInfo = dailyInfo();
  const uid = req.query.uid ? String(req.query.uid) : null;
  const mapMeta = core.MAPS[dInfo.map] || core.MAPS[0];

  let entries = [];
  if (sbOn()) {
    try {
      const [dcR, prR] = await Promise.all([
        fetch(SB_URL + '/rest/v1/daily_competition?date_key=eq.' + dInfo.key + '&order=best_lap_ms.asc&limit=40&select=user_id,map,best_lap_ms,races_today,updated_at', { headers: sbHdr() }),
        fetch(SB_URL + '/rest/v1/profiles?select=id,username', { headers: sbHdr() })
      ]);
      if (dcR.ok) {
        const raw = await dcR.json();
        const profMap = {};
        if (prR.ok) (await prR.json()).forEach((p) => { profMap[p.id] = p.username; });
        entries = raw.map((x, idx) => ({
          rank: idx + 1,
          uid: x.user_id,
          name: profMap[x.user_id] || 'RACER',
          bestMs: x.best_lap_ms,
          bestTime: x.best_lap_ms / 1000,
          bestFormatted: core.fmtTime(x.best_lap_ms / 1000),
          racesToday: x.races_today
        }));
      }
    } catch (e) {}
  }

  if (!entries.length) {
    const dayMap = memDailyComp.get(dInfo.key) || new Map();
    const list = Array.from(dayMap.values());
    list.sort((a, b) => a.best_lap_ms - b.best_lap_ms);
    entries = list.map((x, idx) => ({
      rank: idx + 1,
      uid: x.user_id,
      name: x.name || 'RACER',
      bestMs: x.best_lap_ms,
      bestTime: x.best_lap_ms / 1000,
      bestFormatted: core.fmtTime(x.best_lap_ms / 1000),
      racesToday: x.races_today || 1
    }));
  }

  const topTime = entries.length > 0 ? entries[0].bestTime : null;
  let userEntry = null;
  if (uid) {
    const found = entries.find((e) => e.uid === uid || e.name === uid);
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
  const uid = req.query.uid ? String(req.query.uid) : null;

  let entries = [];
  if (sbOn()) {
    try {
      const [wcR, prR] = await Promise.all([
        fetch(SB_URL + '/rest/v1/weekly_competition?week_key=eq.' + wInfo.weekKey + '&order=points.desc,wins_week.desc&limit=40&select=user_id,points,races_week,wins_week,best_lap_ms,updated_at', { headers: sbHdr() }),
        fetch(SB_URL + '/rest/v1/profiles?select=id,username', { headers: sbHdr() })
      ]);
      if (wcR.ok) {
        const raw = await wcR.json();
        const profMap = {};
        if (prR.ok) (await prR.json()).forEach((p) => { profMap[p.id] = p.username; });
        entries = raw.map((x, idx) => ({
          rank: idx + 1,
          uid: x.user_id,
          name: profMap[x.user_id] || 'RACER',
          points: x.points,
          races: x.races_week,
          wins: x.wins_week,
          bestLapMs: x.best_lap_ms,
          bestLapFormatted: x.best_lap_ms ? core.fmtTime(x.best_lap_ms / 1000) : null
        }));
      }
    } catch (e) {}
  }

  if (!entries.length) {
    const wkMap = memWeeklyComp.get(wInfo.weekKey) || new Map();
    const list = Array.from(wkMap.values());
    list.sort((a, b) => b.points - a.points || b.wins_week - a.wins_week);
    entries = list.map((x, idx) => ({
      rank: idx + 1,
      uid: x.user_id,
      name: x.name || 'RACER',
      points: x.points,
      races: x.races_week,
      wins: x.wins_week,
      bestLapMs: x.best_lap_ms,
      bestLapFormatted: x.best_lap_ms ? core.fmtTime(x.best_lap_ms / 1000) : null
    }));
  }

  let userEntry = null;
  if (uid) {
    const found = entries.find((e) => e.uid === uid || e.name === uid);
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
// v81/v82 Rivals, Daily Missions, Streaks, Seasons, Badges & Academy API
// ---------------------------------------------------------------------------
const memPlayerMissions = new Map(); // `${dateKey}:${uid}` -> Map<missionId, { progress, completed, claimed }>
const memPlayerLicense = new Map();  // uid -> { completed, at }
const memEquippedBadges = new Map(); // uid -> badgeId
const memRevengeTargets = new Map(); // uid -> [ { targetUid, targetName, mapId, targetRating, issuedAt } ]
const memWeeklyBounties = new Map(); // `${weekKey}:${uid}` -> Map<bountyId, { progress, completed, claimed }>

function getOrInitWeeklyBounties(wKey, uid) {
  const bounties = prog.getWeeklyBounties(wKey);
  const key = `${wKey}:${uid}`;
  let userMap = memWeeklyBounties.get(key);
  if (!userMap) {
    userMap = new Map();
    for (const b of bounties) {
      userMap.set(b.id, { progress: 0, completed: false, claimed: false });
    }
    memWeeklyBounties.set(key, userMap);
  }
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
  const mKey = `${dateKey}:${uid}`;
  let mMap = memPlayerMissions.get(mKey);
  const defs = prog.getDailyMissions(dateKey);
  if (!mMap) {
    mMap = new Map();
    defs.forEach((d) => {
      mMap.set(d.id, { progress: 0, completed: false, claimed: false });
    });
    memPlayerMissions.set(mKey, mMap);
  }
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

  const pSt = memPlayerStats.get(uid);
  if (pSt) {
    pSt.xp = (pSt.xp || 0) + def.xp;
    memPlayerStats.set(uid, pSt);
  }

  res.json({
    ok: true,
    missionId,
    xpAwarded: def.xp,
    coinsAwarded: def.coins
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

// v82 Driving Academy / License Completion
app.post('/api/player/license/complete', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const b = req.body || {};
  const uid = req.query.uid || b.uid;
  if (!uid) return res.status(400).json({ ok: false, error: 'MISSING_UID' });

  const existing = memPlayerLicense.get(uid);
  if (existing) {
    return res.json({ ok: true, alreadyCompleted: true, bonus: prog.LICENSE_COMPLETION_BONUS });
  }

  memPlayerLicense.set(uid, { completed: true, completedAt: new Date().toISOString() });
  const st = memPlayerStats.get(uid) || { rating: 1000, peak_rating: 1000, xp: 0, streak: 0, best_streak: 0, races: 0, wins: 0, podiums: 0, daily_days: 0, last_daily: '' };
  st.xp = (st.xp || 0) + prog.LICENSE_COMPLETION_BONUS.xp;
  memPlayerStats.set(uid, st);

  return res.json({
    ok: true,
    claimed: true,
    completed: true,
    coinsAwarded: prog.LICENSE_COMPLETION_BONUS.coins,
    xpAwarded: prog.LICENSE_COMPLETION_BONUS.xp,
    bonus: prog.LICENSE_COMPLETION_BONUS
  });
});

// v82 Badges & Profile Showcase
app.get('/api/player/badges', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid || 'guest';
  let st = memPlayerStats.get(uid) || { rating: 1000, peak_rating: 1000, xp: 0, races: 0, wins: 0, streak: 0, best_streak: 0 };
  const badges = prog.evaluateBadges(Object.assign({}, st, { license_done: !!memPlayerLicense.get(uid) }));
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
  memEquippedBadges.set(uid, badgeId);
  res.json({ ok: true, equippedBadge: badgeId });
});

// v82 Revenge Match Engine
app.get('/api/player/revenge', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid;
  const list = (uid && memRevengeTargets.get(uid)) || [];
  res.json({ ok: true, targets: list, revengeTargets: list });
});

app.post('/api/player/revenge/issue', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const b = req.body || {};
  const uid = req.query.uid || b.uid;
  const targetUid = req.query.targetUid || b.targetUid;
  const mapId = Math.max(0, parseInt(req.query.map || b.map || 0, 10));
  if (!uid || !targetUid) return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });

  const curRevs = memRevengeTargets.get(uid) || [];
  const targetObj = {
    targetUid,
    targetName: b.targetName || 'RIVAL',
    map: mapId,
    mapId,
    targetRating: parseInt(b.targetRating || 1000, 10),
    issuedAt: new Date().toISOString()
  };
  if (!curRevs.some(rt => rt.targetUid === targetUid)) {
    curRevs.push(targetObj);
    memRevengeTargets.set(uid, curRevs.slice(-5));
  }
  const shareMsg = prog.formatCompetitiveShare('revenge_challenge', {
    mapName: (core.MAPS[mapId] || {}).name || 'Circuit',
    link: `https://sridharrush.com/?map=${mapId}`
  });
  res.json({ ok: true, shareMsg, target: targetObj });
});

// v82 Weekly Syndicate Bounties
app.get('/api/competitions/weekly/bounties', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid || 'guest';
  const wKey = currentWeekKey();
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

  const st = memPlayerStats.get(uid) || { rating: 1000, peak_rating: 1000, xp: 0, streak: 0, best_streak: 0, races: 0, wins: 0, podiums: 0, daily_days: 0, last_daily: '' };
  st.xp = (st.xp || 0) + def.xp;
  memPlayerStats.set(uid, st);

  res.json({ ok: true, claimed: true, xpAwarded: def.xp, coinsAwarded: def.coins });
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
  const licenseDone = !!memPlayerLicense.get(uid);
  const tr = prog.tier(st.rating || 1000);

  const nextAction = prog.getNextBestAction({
    streakInfo,
    missions,
    rivals,
    licenseDone,
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
    tag: 'APEX',
    name: 'Apex Predators',
    motto: 'Speed is our only law',
    badge: '⚡',
    color: '#ff4444',
    leaderUid: 'seed_pro_1',
    members: [
      { uid: 'seed_pro_1', name: 'APEX_HUNTER', role: 'leader', weeklyMeters: 42000, totalMeters: 185000, weeklyPoints: 5200 },
      { uid: 'seed_pro_3', name: 'TURBO_VIPER', role: 'member', weeklyMeters: 28000, totalMeters: 94000, weeklyPoints: 3100 }
    ],
    weeklyMeters: 70000,
    totalMeters: 279000,
    weeklyPoints: 8300,
    created_at: new Date(Date.now() - 14 * 86400000).toISOString()
  }],
  ['drift', {
    id: 'drift',
    tag: 'DRIFT',
    name: 'Drift Syndicate',
    motto: 'Sideways is the fastest way',
    badge: '🌀',
    color: '#00e5ff',
    leaderUid: 'seed_pro_2',
    members: [
      { uid: 'seed_pro_2', name: 'DRIFT_KING', role: 'leader', weeklyMeters: 38000, totalMeters: 142000, weeklyPoints: 4600 }
    ],
    weeklyMeters: 38000,
    totalMeters: 142000,
    weeklyPoints: 4600,
    created_at: new Date(Date.now() - 10 * 86400000).toISOString()
  }],
  ['viper', {
    id: 'viper',
    tag: 'VIPER',
    name: 'Viper Velocity',
    motto: 'Strike first, strike fast',
    badge: '🐍',
    color: '#00e676',
    leaderUid: null,
    members: [],
    weeklyMeters: 18000,
    totalMeters: 64000,
    weeklyPoints: 2100,
    created_at: new Date(Date.now() - 7 * 86400000).toISOString()
  }],
  ['titan', {
    id: 'titan',
    tag: 'TITAN',
    name: 'Titan Motorsports',
    motto: 'Unstoppable mechanical force',
    badge: '🛡️',
    color: '#ffb300',
    leaderUid: null,
    members: [],
    weeklyMeters: 12000,
    totalMeters: 45000,
    weeklyPoints: 1500,
    created_at: new Date(Date.now() - 5 * 86400000).toISOString()
  }],
  ['ghost', {
    id: 'ghost',
    tag: 'GHOST',
    name: 'Phantom Syndicate',
    motto: 'Leave only shadows behind',
    badge: '👻',
    color: '#b388ff',
    leaderUid: null,
    members: [],
    weeklyMeters: 9000,
    totalMeters: 32000,
    weeklyPoints: 1100,
    created_at: new Date(Date.now() - 3 * 86400000).toISOString()
  }]
]);

const memPlayerCrew = new Map([
  ['seed_pro_1', 'apex'],
  ['seed_pro_2', 'drift'],
  ['seed_pro_3', 'apex']
]);

const memClaimedCrewMilestones = new Map(); // `${crewId}:${milestoneTier}:${uid}` -> true

app.get(['/api/crews', '/api/crews/leaderboard'], async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const crews = Array.from(memCrews.values()).map((c) => {
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
  res.json({ ok: true, count: ranked.length, crews: ranked });
});

app.get('/api/player/crew', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const uid = req.query.uid || req.query.pid || 'guest';
  const crewId = memPlayerCrew.get(uid);
  if (!crewId || !memCrews.has(crewId)) {
    return res.json({ ok: true, hasCrew: false, crew: null, presets: prog.CREW_PRESETS });
  }
  const c = memCrews.get(crewId);
  const milestoneInfo = prog.getCrewMilestoneInfo(c.weeklyMeters || 0);
  const member = (c.members || []).find((m) => m.uid === uid) || { uid, name: 'RACER', role: 'member', weeklyMeters: 0, totalMeters: 0, weeklyPoints: 0 };

  const milestones = milestoneInfo.milestones.map((m) => ({
    ...m,
    claimed: !!memClaimedCrewMilestones.get(`${c.id}:${m.tier}:${uid}`),
    canClaim: m.completed && !memClaimedCrewMilestones.get(`${c.id}:${m.tier}:${uid}`)
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
  const { uid, name, crewId } = req.body || {};
  if (!uid || typeof uid !== 'string') return res.status(400).json({ ok: false, error: 'invalid_uid' });
  const cid = String(crewId || '').trim().toLowerCase();
  if (!memCrews.has(cid)) return res.status(404).json({ ok: false, error: 'crew_not_found' });

  // Remove from old crew
  const oldCrewId = memPlayerCrew.get(uid);
  if (oldCrewId && memCrews.has(oldCrewId)) {
    const oldCrew = memCrews.get(oldCrewId);
    oldCrew.members = (oldCrew.members || []).filter((m) => m.uid !== uid);
  }

  const targetCrew = memCrews.get(cid);
  targetCrew.members = targetCrew.members || [];
  const existingMember = targetCrew.members.find((m) => m.uid === uid);
  if (!existingMember) {
    targetCrew.members.push({
      uid,
      name: (name && typeof name === 'string') ? name.slice(0, 16) : 'RACER',
      role: 'member',
      weeklyMeters: 0,
      totalMeters: 0,
      weeklyPoints: 0,
      joined_at: new Date().toISOString()
    });
  }
  memPlayerCrew.set(uid, cid);
  res.json({ ok: true, crewId: cid, tag: targetCrew.tag, name: targetCrew.name });
});

app.post('/api/player/crew/create', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { uid, name, crewName, tag, motto, color, badge } = req.body || {};
  if (!uid || typeof uid !== 'string') return res.status(400).json({ ok: false, error: 'invalid_uid' });
  if (!prog.validCrewName(crewName)) return res.status(400).json({ ok: false, error: 'invalid_crew_name' });
  if (!prog.validCrewTag(tag)) return res.status(400).json({ ok: false, error: 'invalid_crew_tag' });

  const cleanTag = tag.trim().toUpperCase();
  const cleanName = crewName.trim();
  const crewId = cleanTag.toLowerCase();

  // check duplicate tag
  for (const c of memCrews.values()) {
    if (c.tag === cleanTag) return res.status(409).json({ ok: false, error: 'tag_taken' });
  }

  // Remove from old crew
  const oldCrewId = memPlayerCrew.get(uid);
  if (oldCrewId && memCrews.has(oldCrewId)) {
    const oldCrew = memCrews.get(oldCrewId);
    oldCrew.members = (oldCrew.members || []).filter((m) => m.uid !== uid);
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
      joined_at: new Date().toISOString()
    }],
    weeklyMeters: 0,
    totalMeters: 0,
    weeklyPoints: 0,
    created_at: new Date().toISOString()
  };

  memCrews.set(crewId, newCrew);
  memPlayerCrew.set(uid, crewId);

  res.json({ ok: true, crew: newCrew });
});

app.post('/api/player/crew/claim-milestone', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { uid, tier } = req.body || {};
  if (!uid || typeof uid !== 'string') return res.status(400).json({ ok: false, error: 'invalid_uid' });
  const tierNum = parseInt(tier, 10);
  const crewId = memPlayerCrew.get(uid);
  if (!crewId || !memCrews.has(crewId)) return res.status(404).json({ ok: false, error: 'no_crew' });

  const crew = memCrews.get(crewId);
  const mileDef = prog.CREW_MILESTONES.find((m) => m.tier === tierNum);
  if (!mileDef) return res.status(400).json({ ok: false, error: 'invalid_tier' });
  if ((crew.weeklyMeters || 0) < mileDef.reqMeters) return res.status(400).json({ ok: false, error: 'milestone_unreached' });

  const claimKey = `${crew.id}:${tierNum}:${uid}`;
  if (memClaimedCrewMilestones.get(claimKey)) return res.status(400).json({ ok: false, error: 'already_claimed' });

  memClaimedCrewMilestones.set(claimKey, true);

  // award XP and coins
  const st = memPlayerStats.get(uid) || { rating: 1000, peak_rating: 1000, xp: 0, streak: 0, best_streak: 0, races: 0, wins: 0, podiums: 0, daily_days: 0, last_daily: '' };
  st.xp = (st.xp || 0) + mileDef.reward.xp;
  memPlayerStats.set(uid, st);

  res.json({
    ok: true,
    tier: tierNum,
    reward: mileDef.reward,
    xpAwarded: mileDef.reward.xp,
    coinsAwarded: mileDef.reward.coins,
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
      if (pl && !pl.isBot) uid = pl.name || ('player_' + (c.slot || c.s));
      else if (!c.bot && !c.isBot) uid = c.name || ('player_' + (c.slot || c.s));
    }
    if (uid && (!entry.dupUid || !entry.dupUid[c.slot])) humans.push({ c, uid });
  } // v77 BUG-001 dedupe
  if (!humans.length) return [];
  const rated = humans.length >= 2 && (!room.participants || room.participants().length === humans.length); // v76: all-human races rate (1v1 unchanged)
  const today = new Date().toISOString().slice(0, 10);
  let dailyMap = -1; try { dailyMap = dailyInfo().map; } catch (e) {}
  const uids = humans.map((h) => h.uid);
  const uq = uids.map((u) => 'user_id=eq.' + u).join('&');
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

    // v80 daily competition tracking
    if (lapMs != null && room.mode === 'race' && (room.mapId != null ? room.mapId : room.map) === dailyMap) {
      const dKey = today;
      const dayMap = memDailyComp.get(dKey) || new Map();
      const existing = dayMap.get(h.uid);
      const bestToday = (existing && existing.best_lap_ms < lapMs) ? existing.best_lap_ms : lapMs;
      dayMap.set(h.uid, { user_id: h.uid, name: h.c.name || 'RACER', map: (room.mapId != null ? room.mapId : room.map), best_lap_ms: bestToday, races_today: (existing ? existing.races_today : 0) + 1, updated_at: new Date().toISOString() });
      memDailyComp.set(dKey, dayMap);
    }

    // v80 weekly championship points & tracking
    const isFastestLap = lapMs != null && order.every((o) => o === h.c || !o.best || (h.c.best && h.c.best <= o.best));
    const weeklyPts = rated ? prog.weeklyPointsForPos(pos, humans.length, isFastestLap) : 0;
    const wKey = currentWeekKey();
    if (weeklyPts > 0 || lapMs != null) {
      const wkMap = memWeeklyComp.get(wKey) || new Map();
      const existingWk = wkMap.get(h.uid);
      const bestWk = (existingWk && existingWk.best_lap_ms && existingWk.best_lap_ms < lapMs) ? existingWk.best_lap_ms : lapMs;
      wkMap.set(h.uid, {
        user_id: h.uid, name: h.c.name || 'RACER',
        points: (existingWk ? existingWk.points : 0) + weeklyPts,
        races_week: (existingWk ? existingWk.races_week : 0) + 1,
        wins_week: (existingWk ? existingWk.wins_week : 0) + (win ? 1 : 0),
        best_lap_ms: bestWk,
        updated_at: new Date().toISOString()
      });
      memWeeklyComp.set(wKey, wkMap);
    }

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
        mEarnedCoins = m.coins;
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
        bEarnedCoins = b.coins;
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

    // v82 Revenge match evaluation
    let revengeAwarded = null;
    const revList = memRevengeTargets.get(h.uid) || [];
    if (win && revList.length && humans.length >= 2) {
      const targetOpponent = humans.find(o => o.uid !== h.uid && revList.some(rt => rt.targetUid === o.uid));
      if (targetOpponent) {
        const revEval = prog.evaluateRevengeMatch(targetOpponent.uid, h.uid, { xp: xpBase, coins: cos.COINS.win });
        if (revEval.revenge) {
          revengeAwarded = {
            targetUid: targetOpponent.uid,
            targetName: targetOpponent.c.name || 'RIVAL',
            xpBonus: revEval.xpBonus,
            coinsBonus: revEval.coinsBonus
          };
          memRevengeTargets.set(h.uid, revList.filter(rt => rt.targetUid !== targetOpponent.uid));
        }
      }
    } else if (!win && rated && humans.length >= 2) {
      const winnerHuman = humans.find((_, idx) => order.indexOf(humans[idx].c) === 0);
      if (winnerHuman && winnerHuman.uid !== h.uid) {
        const curRevs = memRevengeTargets.get(h.uid) || [];
        if (!curRevs.some(rt => rt.targetUid === winnerHuman.uid)) {
          curRevs.push({
            targetUid: winnerHuman.uid,
            targetName: winnerHuman.c.name || 'RIVAL',
            mapId: room.mapId,
            targetRating: (stats[winnerHuman.uid] || {}).rating || 1000,
            issuedAt: new Date().toISOString()
          });
          memRevengeTargets.set(h.uid, curRevs.slice(-5));
        }
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
    let coins = 0;
    if (h.c.finished) coins += cos.COINS.finish;
    if (win) coins += cos.COINS.win; else if (podium) coins += cos.COINS.podium;
    if (dailyXp) coins += cos.COINS.daily;
    coins += missionBonusCoins + bountyBonusCoins + (revengeAwarded ? revengeAwarded.coinsBonus : 0);
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
      nitro_count: (st.nitro_count || 0) + (h.c.nitroCount || (h.c.nitro ? 1 : 0)),
      license_done: !!memPlayerLicense.get(h.uid)
    };
    const badgeEvaluations = prog.evaluateBadges(statsForBadges);

    // v83 Racing Syndicate Crews contribution
    let crewUpdate = null;
    const crewId = memPlayerCrew.get(h.uid);
    if (crewId && memCrews.has(crewId)) {
      const cr = memCrews.get(crewId);
      const lapsDone = (h.c.lapTimes ? h.c.lapTimes.length : (h.c.finished ? (room.laps || 3) : 1));
      const contrib = prog.calculateCrewContribution({ lapsCompleted: lapsDone, finished: !!h.c.finished, won: win, podium });
      cr.weeklyMeters = (cr.weeklyMeters || 0) + contrib.meters;
      cr.totalMeters = (cr.totalMeters || 0) + contrib.meters;
      cr.weeklyPoints = (cr.weeklyPoints || 0) + contrib.points;

      cr.members = cr.members || [];
      let mRec = cr.members.find(m => m.uid === h.uid);
      if (mRec) {
        mRec.weeklyMeters = (mRec.weeklyMeters || 0) + contrib.meters;
        mRec.totalMeters = (mRec.totalMeters || 0) + contrib.meters;
        mRec.weeklyPoints = (mRec.weeklyPoints || 0) + contrib.points;
      } else {
        cr.members.push({
          uid: h.uid,
          name: h.c.name || 'RACER',
          role: 'member',
          weeklyMeters: contrib.meters,
          totalMeters: contrib.meters,
          weeklyPoints: contrib.points,
          joined_at: new Date().toISOString()
        });
      }
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
        body: JSON.stringify([{ user_id: h.uid, races: (st.races || 0) + 1, wins: (st.wins || 0) + (win ? 1 : 0), podiums: (st.podiums || 0) + (podium ? 1 : 0), xp: xpNew, rating: ratingNew, peak_rating: Math.max(st.peak_rating || 1000, ratingNew), streak: streakNew, best_streak: bestStreakNew, daily_days: dailyDays, last_daily: lastDaily, challenges_done: (st.challenges_done || 0) + (chDone ? 1 : 0), updated_at: new Date().toISOString() }]) }));
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
        await step('daily_comp', () => fetch(SB_URL + '/rest/v1/daily_competition', { method: 'POST',
          headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify([{ date_key: today, user_id: h.uid, map: room.mapId, best_lap_ms: lapMs, races_today: 1 }]) }));
      }
      if (weeklyPts > 0) {
        await step('weekly_comp', () => fetch(SB_URL + '/rest/v1/weekly_competition', { method: 'POST',
          headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify([{ week_key: wKey, user_id: h.uid, points: weeklyPts, races_week: 1, wins_week: win ? 1 : 0, best_lap_ms: lapMs }]) }));
      }
      // v79 BUG-016: atomic coin increment, ledger-ref idempotent (safe to retry)
      let coinsNew = null;
      if (coins > 0) {
        for (let a = 0; a < 3 && coinsNew == null; a++) {
          try {
            const r = await fetch(SB_URL + '/rest/v1/rpc/earn_coins', { method: 'POST',
              headers: Object.assign(sbHdr(), { Prefer: 'return=representation' }),
              body: JSON.stringify({ p_uid: h.uid, p_delta: coins, p_ref: key, p_reason: 'race' }) });
            if (r.ok) { const j = await r.json(); const row = Array.isArray(j) ? j[0] : j; if (row && row.ok) coinsNew = row.coins; }
            else if (r.status === 400) break; // permanent validation failure
          } catch (e) { /* transient */ }
          if (coinsNew == null && a < 2) await new Promise((rs) => setTimeout(rs, 300 * Math.pow(2, a)));
        }
        if (coinsNew == null) failed = true;
      }
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
app.post('/ghost', (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0]; // v79
  if (ghostLimited(ip)) { ghost429++; return res.status(429).json({ error: 'rate' }); } // v79 BUG-014
  let b = '';
  req.on('data', (c) => { if (b.length < 400000) b += c; });
  req.on('end', async () => {
    if (!sbOn()) return res.status(503).json({ error: 'unavailable' });
    try {
      const j = JSON.parse(b || '{}');
      const map = parseInt(j.map, 10);
      if (!(map >= 0 && map < 5) || !Array.isArray(j.data) || j.data.length < 10 || j.data.length > 4000)
        return res.status(400).json({ error: 'bad' });
      const id = require('crypto').randomBytes(6).toString('hex'); // v79 N-08: 12-hex, collision-resistant
      const r = await fetch(SB_URL + '/rest/v1/ghosts', {
        method: 'POST',
        headers: { apikey: SB_ROLE, Authorization: 'Bearer ' + SB_ROLE, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify([{ id, map, name: String(j.name || 'RACER').slice(0, 16), data: j.data }]),
      });
      if (!r.ok) return res.status(500).json({ error: 'db' });
      res.json({ id });
    } catch (e) { res.status(400).json({ error: 'bad' }); }
  });
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
  const entry = { room: new core.RaceRoom(code, mode, mapId, cap), screens: new Set(), controllers: new Map(), lbSent: false, rematch: new Set(), noRecord: false, specs: new Set(), lastState: 'waiting', raceSeq: 0, _settled: false, uidBySlot: {}, chBySlot: {}, slotByWs: new Map(), ready: new Set(), ratingBySlot: {}, dupUid: {}, controllerPids: {} };
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
    const crewId = uid ? memPlayerCrew.get(uid) : null;
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
      lap: `${Math.min(car.lap + 1, core.CFG.totalLaps)}/${core.CFG.totalLaps}`,
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
  const client = { ws, role: null, slot: null, entry: null };
  clientsByWs.set(ws, client);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    handleMessage(client, msg);
  });
  const drop = () => { const i = matchQueue.indexOf(ws); if (i >= 0) matchQueue.splice(i, 1); clientsByWs.delete(ws); handleLeave(client); };
  ws.on('close', drop);
  ws.on('error', drop);
});

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
    let slot = 0;
    for (let s = 1; s <= room.cap; s++) {
      if (!room.controllers[s]) {
        slot = s;
        break;
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
    room.setSeat(slot, true);
    broadcastLobby(entry);
    sendJSON(client.ws, {
      type: 'welcome', role, slot: client.slot, code: room.code, mode: room.mode,
      controllers: Object.assign({}, room.controllers),
      snapshot: room.snapshot()
    });
  }
}

function handleMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'hello': {
      if (client.entry) return;
      let entry = null;
      if (msg.room) {
        entry = rooms.get(String(msg.room).toUpperCase().trim());
        if (!entry) { sendJSON(client.ws, { type: 'error', code: 'no-room' }); return; }
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
        if (msg.weather != null) room.setWeather(msg.weather);
        if (msg.laps != null) room.setLaps(msg.laps);
        if (msg.bot != null) room.setBot(msg.bot);
        if (msg.record === false) entry.noRecord = true; // v61 practice
        if (msg.botSkill != null) room.setBotSkill(parseInt(msg.botSkill, 10)); // v45
        if (msg.name || msg.color || msg.cls) room.setPlayerMeta(client.slot, msg);
        if (msg.cls) { classPick(msg.cls); room.cars[client.slot - 1].clsKey = msg.cls; } // v64 telemetry
        if (msg.cos || msg.title) room.cars[client.slot - 1].setCos(msg.cos, msg.title); // v59
        // v73: verify the racer's Supabase token server-side -> authoritative uid
        if (msg.tok) verifyUid(msg.tok).then(async (uid) => {
          if (uid && client.entry) {
            client.uid = uid; entry.uidBySlot[client.slot] = uid;
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

    case 'map':
      if (client.entry && client.role === 'screen' && (client.entry.screens.size < 3 || client.slot === hostSlot(client.entry))) client.entry.room.setMap(msg.map); // v76/v77 host-only 3+
      break;

    case 'weather':
      if (client.entry && client.role === 'screen' && (client.entry.screens.size < 3 || client.slot === hostSlot(client.entry))) {
        client.entry.room.setWeather(msg.weather);
        broadcastScreens(client.entry, { type: 'weather', weather: client.entry.room.weather });
      }
      break;

    case 'meta':
      if (client.entry && client.role === 'screen' && client.slot) {
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
      client.msgs = (client.msgs || 0) + 1; if (client.msgs > 240) { try { client.ws.close(); } catch (e) {} return; } // v76 spam guard
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

    case 'equip': { // v75: server validates every unlock before writing equipped
      if (client.role !== 'screen' || !client.uid) break;
      (async () => {
        try {
          const uid = client.uid, eq = msg.eq || {};
          const [stR, invR] = await Promise.all([
            fetch(SB_URL + '/rest/v1/player_stats?user_id=eq.' + uid + '&select=xp,wins,rating', { headers: sbHdr() }),
            fetch(SB_URL + '/rest/v1/player_inventory?user_id=eq.' + uid + '&select=item_id', { headers: sbHdr() }),
          ]);
          const st = stR.ok ? ((await stR.json())[0] || {}) : {};
          const owned = invR.ok ? (await invR.json()).map((x) => x.item_id) : [];
          const d = { level: prog.levelFromXp(Number(st.xp) || 0).level, wins: st.wins || 0, rating: st.rating || 1000, owned };
          const car = cos.findCar(String(eq.car || 'street_runner'));
          if (!cos.itemUnlocked(car.unlock, d, 'car:' + car.id)) return sendJSON(client.ws, { type: 'equip-err', msg: 'locked car' });
          const pick = (list, kind, cur) => {
            const it = list.find((x) => x.id === (parseInt(cur, 10) || 0));
            if (!it) return 0;
            return cos.itemUnlocked(it.unlock, d, kind + ':' + it.id) ? it.id : 0;
          };
          const out = {
            user_id: uid, car: car.id,
            paint: pick(cos.PAINTS, 'paint', eq.paint),
            wheels: pick(cos.WHEELS, 'wheels', eq.wheels),
            trail: pick(cos.TRAILS, 'trail', eq.trail),
            decal: pick(cos.DECALS, 'decal', eq.decal),
            neon: pick(cos.NEONS, 'neon', eq.neon),
            title: String(eq.title || '').replace(/[<>"'&\\]/g, '').slice(0, 24) // v77 BUG-010
          };
          await fetch(SB_URL + '/rest/v1/player_equipped', { method: 'POST',
            headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
            body: JSON.stringify([out]) });
          sendJSON(client.ws, { type: 'equipped', eq: out });
        } catch (e) {}
      })();
      break;
    }
    case 'buy': { // v75: coin purchases; wallet check happens server-side only
      if (client.role !== 'screen' || !client.uid) break;
      (async () => {
        try {
          const uid = client.uid;
          const m = String(msg.item || '').match(/^(paint|wheels|trail|decal|neon):(\d+)$/);
          if (!m) return;
          const kind = m[1], id = parseInt(m[2], 10);
          const list = kind === 'paint' ? cos.PAINTS : kind === 'wheels' ? cos.WHEELS : kind === 'trail' ? cos.TRAILS : kind === 'decal' ? cos.DECALS : cos.NEONS;
          const it = list.find((x) => x.id === id);
          if (!it || !cos.isCoinItem(it.unlock)) return;
          // v77 BUG-005: single atomic DB transaction (balance check + decrement + insert)
          const r = await fetch(SB_URL + '/rest/v1/rpc/spend_coins', {
            method: 'POST', headers: Object.assign(sbHdr(), { Prefer: 'return=representation' }),
            body: JSON.stringify({ p_uid: uid, p_amount: it.unlock.v, p_item: kind + ':' + id }),
          });
          const j = r.ok ? await r.json() : null;
          const row = Array.isArray(j) ? j[0] : j;
          if (!row || !row.ok) return sendJSON(client.ws, { type: 'buy-err', msg: row && row.err === 'funds' ? 'need ' + it.unlock.v + ' coins' : row && row.err === 'owned' ? 'already owned' : 'purchase failed' });
          sendJSON(client.ws, { type: 'bought', item: kind + ':' + id, coins: row.coins });
        } catch (e) {}
      })();
      break;
    }
    case 'ready': { // v76
      if (client.entry && client.role === 'screen') {
        if (msg.on) client.entry.ready.add(client.ws); else client.entry.ready.delete(client.ws);
        broadcastLobby(client.entry);
      }
      break;
    }
    case 'start':
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

    // v59 rematch voting: when every connected screen votes, reuse the room
    case 'rematch':
      if (client.entry && client.role === 'screen') {
        const en = client.entry;
        en.rematch.add(client.ws);
        en.room.events.push({ type: 'rematch', n: en.rematch.size, total: en.screens.size });
        if (en.rematch.size >= Math.max(1, en.screens.size)) { en.rematch.clear(); en.room.start(); }
      }
      break;

    case 'mode':
      if (client.entry && client.role === 'screen') client.entry.room.setMode(msg.mode);
      break;

    case 'reset':
      if (client.entry && client.role === 'screen') client.entry.room.resetToWaiting();
      break;

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
      sendJSON(client.ws, { type: 'searching', waiting: matchQueue.length });
      if (matchQueue.length >= 2) {
        const wsA = matchQueue.shift(), wsB = matchQueue.shift();
        const cA = clientsByWs.get(wsA), cB = clientsByWs.get(wsB);
        if (cA && cB) {
          const entry = newRoom('race', 0, 6); // v76
          joinRoom(cA, entry, 'screen');
          joinRoom(cB, entry, 'screen');
          sendJSON(wsA, { type: 'matched', code: entry.room.code });
          sendJSON(wsB, { type: 'matched', code: entry.room.code });
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
    if (entry.screens.size === 0 && entry.controllers.size === 0 && now - (entry.lastHuman || 0) > IDLE_ROOM_MS) {
      rooms.delete(code); // v77 BUG-004: bots can no longer keep abandoned rooms alive
      console.log(`[room ${code}] closed (idle)`);
    }
  }
}, TICK_MS);
if (tickInterval.unref) tickInterval.unref();

app.get('/health', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, rooms: rooms.size, tickHz: core.CFG.tickHz });
});
// build marker — lets you verify at a glance that frontend + server run the
// SAME version (version drift between them causes "ghost" physics bugs)
app.get('/version', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ build: 'v78', tickHz: core.CFG.tickHz, geom: core.GEOM_ID, lowBw: LOW_BW });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[velocity-rush] multiplayer server on http://0.0.0.0:${PORT} (${core.CFG.tickHz} Hz sim)`);
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
  newRoom,
  settleRace,
  dailyInfo,
  weeklyInfo,
  memPlayerStats,
  memDailyComp,
  memWeeklyComp,
  memPlayerMissions,
  memPlayerLicense,
  memEquippedBadges,
  memRevengeTargets,
  memWeeklyBounties,
  getOrInitWeeklyBounties,
  getAllRatingRows,
  getOrInitMissions,
  memCrews,
  memPlayerCrew,
  memClaimedCrewMilestones
};
