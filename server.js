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

// ---------------------------------------------------------------------------
// v40 lite analytics — aggregate counters only. No IPs, no cookies, no
// personal data; a privacy-friendly pulse on how the game is used.
// ---------------------------------------------------------------------------
// v64 class balance telemetry (aggregate only, no personal data)
const CLASS_TELE = { velocity: { pick: 0, win: 0, fin: 0, posSum: 0, tSum: 0 }, accelerator: { pick: 0, win: 0, fin: 0, posSum: 0, tSum: 0 }, grip: { pick: 0, win: 0, fin: 0, posSum: 0, tSum: 0 } };
function classPick(cls) { const c = CLASS_TELE[cls]; if (c) c.pick++; }
function classResult(cls, pos, t, won) { const c = CLASS_TELE[cls]; if (!c) return; c.fin++; c.posSum += pos; if (t != null) c.tSum += t; if (won) c.win++; }
const AN = { visits: 0, controller: 0, races: 0, finishes: 0, installs: 0, errors: 0, lastErr: [], byMap: [0, 0, 0, 0, 0] };
app.post('/a', (req, res) => {
  let b = '';
  req.on('data', (c) => { if (b.length < 500) b += c; });
  req.on('end', () => {
    try {
      const j = JSON.parse(b || '{}');
      if (j.e === 'visit') AN.visits++;
      else if (j.e === 'ctrl') AN.controller++;
      else if (j.e === 'race') { AN.races++; if (j.map >= 0 && j.map < 5) AN.byMap[j.map]++; }
      else if (j.e === 'fin') AN.finishes++;
      else if (j.e === 'inst') AN.installs++;
      else if (j.e === 'err') {
        AN.errors++;
        AN.lastErr.push({ m: String(j.m || 'error').slice(0, 140), ts: Date.now() });
        if (AN.lastErr.length > 10) AN.lastErr.shift();
      }
    } catch (e) {}
    res.json({ ok: true });
  });
});
app.get('/stats', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const clsOut = {};
  for (const k of Object.keys(CLASS_TELE)) { const c = CLASS_TELE[k]; clsOut[k] = { pick: c.pick, win: c.win, fin: c.fin, avgPos: c.fin ? +(c.posSum / c.fin).toFixed(2) : null, avgTime: c.fin ? +(c.tSum / c.fin).toFixed(2) : null }; }
  res.json(Object.assign({ classes: clsOut }, AN));
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
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();   // code -> { room, screens:Set<ws>, controllers:Map<ws,slot> }
const matchQueue = [];     // ws clients waiting for Quick-Play matchmaking
const clientsByWs = new Map(); // ws -> client (for matchmaking pairing)

// ---------------------------------------------------------------------------
// Leaderboard (per-map, persisted to disk where available)
// ---------------------------------------------------------------------------
const fs = require('fs');
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
  return { map: day % 5, key: new Date().toISOString().slice(0, 10) };
}
// v44 Founders Cup: best times across ALL maps since Monday 00:00 UTC
function weekStartUTC() {
  const d = new Date();
  const mondayShift = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - mondayShift * 86400000;
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
async function settleRace(entry) {
  if (!sbOn() || entry.noRecord) return;                 // practice/TT never settle
  const room = entry.room;
  if (room.mode !== 'race' && room.mode !== 'elim') return;   // rated formats only
  const order = room.standings().filter((c) => c.participating);
  const humans = [];
  for (const c of order) { const uid = entry.uidBySlot && entry.uidBySlot[c.slot]; if (uid) humans.push({ c, uid }); }
  if (!humans.length) return;
  const rated = humans.length >= 2 && room.participants().length === humans.length; // v76: all-human races rate (1v1 unchanged)
  const today = new Date().toISOString().slice(0, 10);
  let dailyMap = -1; try { dailyMap = dailyInfo().map; } catch (e) {}
  const uids = humans.map((h) => h.uid);
  const uq = uids.map((u) => 'user_id=eq.' + u).join('&');
  let stats = {}, recs = {}, achHave = {}, mapCount = {}, seasXp = {}, season = null;
  try { const r = await fetch(SB_URL + '/rest/v1/seasons?order=id.desc&limit=1&select=id,name,end_at', { headers: sbHdr() }); if (r.ok) { const j = await r.json(); season = j[0] || null; } } catch (e) {}
  try { const r = await fetch(SB_URL + '/rest/v1/player_stats?' + uq + '&select=user_id,rating,peak_rating,xp,streak,best_streak,races,wins,podiums,daily_days,last_daily,challenges_done', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { stats[x.user_id] = x; }); } catch (e) {}
  let wallet = {};
  try { const r = await fetch(SB_URL + '/rest/v1/player_wallet?' + uq + '&select=user_id,coins', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { wallet[x.user_id] = Number(x.coins) || 0; }); } catch (e) {}
  let invRows = {};
  try { const r = await fetch(SB_URL + '/rest/v1/player_inventory?' + uq + '&select=user_id,item_id', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { (invRows[x.user_id] = invRows[x.user_id] || []).push(x.item_id); }); } catch (e) {}
  try { const r = await fetch(SB_URL + '/rest/v1/player_map_records?' + uq + '&select=user_id,map', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { mapCount[x.user_id] = (mapCount[x.user_id] || 0) + 1; }); } catch (e) {}
  try { const r = await fetch(SB_URL + '/rest/v1/player_achievements?' + uq + '&select=user_id,ach', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { (achHave[x.user_id] = achHave[x.user_id] || {})[x.ach] = true; }); } catch (e) {}
  try { const r = await fetch(SB_URL + '/rest/v1/player_seasons?' + uq + (season ? '&season_id=eq.' + season.id : '') + '&select=user_id,xp', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { seasXp[x.user_id] = Number(x.xp) || 0; }); } catch (e) {}
  try { const r = await fetch(SB_URL + '/rest/v1/player_map_records?' + uq + '&map=eq.' + room.mapId + '&select=user_id,best_lap_ms,best_race_ms,races,wins', { headers: sbHdr() }); if (r.ok) (await r.json()).forEach((x) => { recs[x.user_id] = x; }); } catch (e) {}
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
    const lapMs = h.c.best != null ? Math.round(h.c.best * 1000) : null;
    const raceMs = (h.c.finished && h.c.finishTime != null) ? Math.round(h.c.finishTime * 1000) : null;
    const prev = recs[h.uid];
    const pr = !!lapMs && (!prev || prev.best_lap_ms == null || lapMs < prev.best_lap_ms);
    // daily reward: first finish on today's map (server-tracked, once per UTC day)
    let dailyXp = 0, dailyDays = st.daily_days || 0, lastDaily = st.last_daily || '';
    if (h.c.finished && room.mode === 'race' && room.mapId === dailyMap && lastDaily !== today) { dailyXp = 150; dailyDays += 1; lastDaily = today; }
    // challenge completion: server verifies map/mode/target against the stored row
    let chXp = 0, chDone = false;
    const chid = entry.chBySlot && entry.chBySlot[h.c.slot];
    if (chid && h.c.finished && raceMs != null) {
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
    const d = { wins: (st.wins || 0) + (win ? 1 : 0), streak: win ? (st.streak || 0) + 1 : 0, podiums: (st.podiums || 0) + (podium ? 1 : 0), mapsPlayed: mapCount[h.uid] || 0, daily_days: dailyDays, challenges_done: (st.challenges_done || 0) + (chDone ? 1 : 0), races: (st.races || 0) + 1, peak_rating: Math.max(st.peak_rating || 1000, (st.rating || 1000) + rd) };
    const newAch = [];
    for (const a of prog.ACHIEVEMENTS) { if (!(achHave[h.uid] && achHave[h.uid][a.id]) && a.test(d)) newAch.push(a); }
    let achXp = 0; for (const a of newAch) achXp += a.xp;
    // v75 Rush Coins (server-awarded; never client-submitted)
    let coins = 0;
    if (h.c.finished) coins += cos.COINS.finish;
    if (win) coins += cos.COINS.win; else if (podium) coins += cos.COINS.podium;
    if (dailyXp) coins += cos.COINS.daily;
    const coinsNew = (wallet[h.uid] || 0) + coins;
    const xpTotal = xpBase + dailyXp + chXp + achXp;
    const xpOld = Number(st.xp || 0), xpNew = xpOld + xpTotal;
    const lvlOld = prog.levelFromXp(xpOld).level, lvlNew = prog.levelFromXp(xpNew).level;
    const ratingNew = (st.rating || 1000) + rd;
    const streakNew = win ? (st.streak || 0) + 1 : 0;
    rowsOut.push({ slot: h.c.slot, pos, xp: xpTotal, rd, ratingNew, levelNew: lvlNew, levelUp: lvlNew > lvlOld, pr, dailyXp, chDone, coins, coinsNew, ach: newAch.map((a) => ({ id: a.id, name: a.name, icon: a.icon, xp: a.xp })), seasonId: season ? season.id : null });
    const key = room.code + '-' + (entry.raceSeq || 0) + '-' + h.c.slot; // idempotent
    try {
      await fetch(SB_URL + '/rest/v1/race_history', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
        body: JSON.stringify([{ race_key: key, user_id: h.uid, map: room.mapId, mode: room.mode, position: pos, players: order.length, duration_ms: raceMs, best_lap_ms: lapMs, rating_delta: rd, xp: xpTotal }]) });
      await fetch(SB_URL + '/rest/v1/player_stats', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ user_id: h.uid, races: (st.races || 0) + 1, wins: (st.wins || 0) + (win ? 1 : 0), podiums: (st.podiums || 0) + (podium ? 1 : 0), xp: xpNew, rating: ratingNew, peak_rating: Math.max(st.peak_rating || 1000, ratingNew), streak: streakNew, best_streak: Math.max(st.best_streak || 0, streakNew), daily_days: dailyDays, last_daily: lastDaily, challenges_done: (st.challenges_done || 0) + (chDone ? 1 : 0), updated_at: new Date().toISOString() }]) });
      await fetch(SB_URL + '/rest/v1/player_map_records', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ user_id: h.uid, map: room.mapId, races: (prev ? (prev.races || 0) : 0) + 1, wins: (prev ? (prev.wins || 0) : 0) + (win ? 1 : 0), best_lap_ms: (prev && prev.best_lap_ms != null && (lapMs == null || prev.best_lap_ms < lapMs)) ? prev.best_lap_ms : lapMs, best_race_ms: (prev && prev.best_race_ms != null && (raceMs == null || prev.best_race_ms < raceMs)) ? prev.best_race_ms : raceMs }]) });
      await fetch(SB_URL + '/rest/v1/player_wallet', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ user_id: h.uid, coins: coinsNew, updated_at: new Date().toISOString() }]) });
      if (newAch.length) await fetch(SB_URL + '/rest/v1/player_achievements', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
        body: JSON.stringify(newAch.map((a) => ({ user_id: h.uid, ach: a.id }))) });
      if (season) await fetch(SB_URL + '/rest/v1/player_seasons', { method: 'POST',
        headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ user_id: h.uid, season_id: season.id, rating: ratingNew, xp: (seasXp[h.uid] || 0) + xpTotal }]) });
    } catch (e) { /* settlement must never break a race */ }
  }
  broadcastScreens(entry, { type: 'settle', rows: rowsOut });
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
  let b = '';
  req.on('data', (c) => { if (b.length < 400000) b += c; });
  req.on('end', async () => {
    if (!sbOn()) return res.status(503).json({ error: 'unavailable' });
    try {
      const j = JSON.parse(b || '{}');
      const map = parseInt(j.map, 10);
      if (!(map >= 0 && map < 5) || !Array.isArray(j.data) || j.data.length < 10 || j.data.length > 4000)
        return res.status(400).json({ error: 'bad' });
      const id = Math.random().toString(36).slice(2, 8);
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
  const entry = { room: new core.RaceRoom(code, mode, mapId, cap), screens: new Set(), controllers: new Map(), lbSent: false, rematch: new Set(), noRecord: false, specs: new Set(), lastState: 'waiting', raceSeq: 0, _settled: false, uidBySlot: {}, chBySlot: {}, slotByWs: new Map(), ready: new Set(), ratingBySlot: {} };
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
  for (const s of entry.screens) {
    if (s !== except && s.readyState === 1) { try { s.send(data); } catch (e) {} }
  }
  for (const s of entry.specs) { // v64 spectators: read-only receivers
    if (s !== except && s.readyState === 1) { try { s.send(data); } catch (e) {} }
  }
}

function broadcastLobby(entry) { // v76: player list with rating + ready
  const room = entry.room;
  const players = [];
  for (const [ws, slot] of entry.slotByWs) {
    const c = room.cars[slot - 1];
    players.push({ slot, name: (c && c.name) || 'RACER', rating: entry.ratingBySlot[slot] || null, ready: entry.ready.has(ws), host: slot === 1 });
  }
  players.sort((a, b) => a.slot - b.slot);
  broadcastScreens(entry, { type: 'lobby', players, cap: room.cap, state: room.state });
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

function joinRoom(client, entry, role) {
  const room = entry.room;
  client.entry = entry;
  client.role = role;

  if (role === 'controller') {
    const slot = !room.controllers[1] ? 1 : (!room.controllers[2] ? 2 : 0);
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
    if (!slot) { sendJSON(client.ws, { type: 'full' }); entry.screens.delete(client.ws); client.entry = null; setTimeout(() => { try { client.ws.close(); } catch (e) {} }, 500); return; }
    client.slot = slot;
    entry.slotByWs.set(client.ws, slot);
    room.setSeat(slot, true);
    broadcastLobby(entry);
    sendJSON(client.ws, {
      type: 'welcome', role, slot: client.slot, code: room.code, mode: room.mode,
      controllers: { 1: room.controllers[1], 2: room.controllers[2] },
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
        client.entry = entry; client.role = 'spec'; entry.specs.add(client.ws);
        sendJSON(client.ws, { type: 'joined', role: 'spec', slot: 0 });
      } else {
        joinRoom(client, entry, msg.role === 'controller' ? 'controller' : 'screen');
      }
      if (client.role === 'screen' && client.slot) {
        const room = entry.room;
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
            try { const r = await fetch(SB_URL + '/rest/v1/player_stats?user_id=eq.' + uid + '&select=rating', { headers: sbHdr() }); if (r.ok) { const j = await r.json(); if (j[0]) entry.ratingBySlot[client.slot] = j[0].rating; } } catch (e) {}
            broadcastLobby(entry);
          }
        }); // v76
        if (msg.chid) entry.chBySlot[client.slot] = String(parseInt(msg.chid, 10) || ''); // v74 challenge link
      }
      break;
    }

    case 'map':
      if (client.entry && client.role === 'screen' && (client.entry.screens.size < 3 || client.slot === 1)) client.entry.room.setMap(msg.map); // v76 host-only 3+
      break;

    case 'meta':
      if (client.entry && client.role === 'screen' && client.slot) {
        client.entry.room.setPlayerMeta(client.slot, msg);
        if (msg.cos || msg.title) client.entry.room.cars[client.slot - 1].setCos(msg.cos, msg.title); // v59
        if (msg.botSkill != null) client.entry.room.setBotSkill(parseInt(msg.botSkill, 10)); // v45
      }
      break;

    case 'laps':
      if (client.entry && client.role === 'screen' && (client.entry.screens.size < 3 || client.slot === 1)) client.entry.room.setLaps(msg.laps); // v76
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
            title: String(eq.title || '').slice(0, 24)
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
          const [wR, iR] = await Promise.all([
            fetch(SB_URL + '/rest/v1/player_wallet?user_id=eq.' + uid + '&select=coins', { headers: sbHdr() }),
            fetch(SB_URL + '/rest/v1/player_inventory?user_id=eq.' + uid + '&item_id=eq.' + kind + ':' + id + '&select=item_id', { headers: sbHdr() }),
          ]);
          const have = iR.ok ? (await iR.json()).length : 0;
          if (have) return sendJSON(client.ws, { type: 'buy-err', msg: 'owned' });
          const coins = wR.ok ? (((await wR.json())[0] || {}).coins || 0) : 0;
          if (coins < it.unlock.v) return sendJSON(client.ws, { type: 'buy-err', msg: 'need ' + it.unlock.v + ' coins' });
          await fetch(SB_URL + '/rest/v1/player_wallet', { method: 'POST',
            headers: Object.assign(sbHdr(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
            body: JSON.stringify([{ user_id: uid, coins: coins - it.unlock.v, updated_at: new Date().toISOString() }]) });
          await fetch(SB_URL + '/rest/v1/player_inventory', { method: 'POST',
            headers: Object.assign(sbHdr(), { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
            body: JSON.stringify([{ user_id: uid, item_id: kind + ':' + id }]) });
          sendJSON(client.ws, { type: 'bought', item: kind + ':' + id, coins: coins - it.unlock.v });
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
          if (client.slot !== 1) { sendJSON(client.ws, { type: 'need-ready', msg: 'host starts 3+ player races' }); break; }
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
    if (!still) {
      entry.room.setController(client.slot, false);
      entry.room.setInput(client.slot, core.ZERO_INPUT());
      broadcastScreens(entry, { type: 'controller-left', slot: client.slot });
    }
  } else if (client.role === 'screen') {
    entry.screens.delete(client.ws);
    const sl = entry.slotByWs.get(client.ws);
    if (sl) { entry.slotByWs.delete(client.ws); entry.ready.delete(client.ws); if (entry.room.state === 'waiting') entry.room.setSeat(sl, false); broadcastLobby(entry); }
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
setInterval(() => {
  tickCount++;
  const dt = 1 / core.CFG.tickHz;
  const now = Date.now();

  for (const [code, entry] of rooms) {
    const room = entry.room;
    room.update(dt);

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
    if (entry.screens.size === 0 && entry.controllers.size === 0 && now - room.lastActivity > IDLE_ROOM_MS) {
      rooms.delete(code);
      console.log(`[room ${code}] closed (idle)`);
    }
  }
}, TICK_MS);

app.get('/health', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, rooms: rooms.size, tickHz: core.CFG.tickHz });
});
// build marker — lets you verify at a glance that frontend + server run the
// SAME version (version drift between them causes "ghost" physics bugs)
app.get('/version', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ build: 'v76', tickHz: core.CFG.tickHz, geom: core.GEOM_ID, lowBw: LOW_BW });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[velocity-rush] multiplayer server on http://0.0.0.0:${PORT} (${core.CFG.tickHz} Hz sim)`);
});
