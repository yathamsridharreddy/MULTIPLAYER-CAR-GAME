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
const AN = { visits: 0, controller: 0, races: 0, finishes: 0, installs: 0, byMap: [0, 0, 0, 0, 0] };
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
    } catch (e) {}
    res.json({ ok: true });
  });
});
app.get('/stats', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json(AN);
});

// Dynamic client config. For local runs the server URL is same-origin
// ("local"). The Vercel deploy overwrites this file at build time with the
// public URL of this server.
app.get('/js/config.js', (req, res) => {
  // Public (anon) Supabase values for the browser, when configured.
  const sbU = process.env.SUPABASE_URL || '', sbA = process.env.SUPABASE_ANON || '';
  const sb = (sbU && sbA) ? 'window.SUPABASE_URL = ' + JSON.stringify(sbU) + ';\nwindow.SUPABASE_ANON = ' + JSON.stringify(sbA) + ';\n' : '';
  res.type('application/javascript').send('window.SERVER_URL = "local";\n' + sb);
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

function newRoom(mode, mapId) {
  let code;
  do { code = core.makeRoomCode(); } while (rooms.has(code));
  const entry = { room: new core.RaceRoom(code, mode, mapId), screens: new Set(), controllers: new Map(), lbSent: false };
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
    client.slot = entry.screens.size === 1 ? 1 : 2;
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
        entry = newRoom(msg.mode === 'coop' ? 'coop' : 'race', msg.map);
      }
      joinRoom(client, entry, msg.role === 'controller' ? 'controller' : 'screen');
      if (client.role === 'screen' && client.slot) {
        const room = entry.room;
        if (msg.laps != null) room.setLaps(msg.laps);
        if (msg.bot != null) room.setBot(msg.bot);
        if (msg.name || msg.color || msg.cls) room.setPlayerMeta(client.slot, msg);
      }
      break;
    }

    case 'map':
      if (client.entry && client.role === 'screen') client.entry.room.setMap(msg.map);
      break;

    case 'meta':
      if (client.entry && client.role === 'screen' && client.slot)
        client.entry.room.setPlayerMeta(client.slot, msg);
      break;

    case 'laps':
      if (client.entry && client.role === 'screen') client.entry.room.setLaps(msg.laps);
      break;

    case 'bot':
      if (client.entry && client.role === 'screen') client.entry.room.setBot(msg.bot);
      break;

    case 'input': {
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

    case 'start':
      if (client.entry && client.role === 'screen') client.entry.room.start();
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
          const entry = newRoom('race', 0);
          joinRoom(cA, entry, 'screen');
          joinRoom(cB, entry, 'screen');
          sendJSON(wsA, { type: 'matched', code: entry.room.code });
          sendJSON(wsB, { type: 'matched', code: entry.room.code });
        }
      }
      break;
    }

    case 'ping':
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
  }

  const empty = entry.screens.size === 0 && entry.controllers.size === 0;
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

    // record finishes to the per-map leaderboard (once per car per race)
    for (const car of room.cars) {
      if (car.finished && car.finishTime != null && !car._lb) {
        car._lb = true;
        lbAdd(room.mapId, { name: car.name, pid: car.pid || null, t: car.finishTime, best: car.best, ts: now });
        sbUpsert(room.mapId, { name: car.name, pid: car.pid || null, t: car.finishTime });
        recentAdd({ name: car.name, map: room.mapId, t: car.finishTime, ts: now });
      }
    }

    if (entry.screens.size > 0) {
      // Bandwidth: the lobby is idle -> 5 Hz is plenty there; races keep the
      // full 30 Hz so gameplay quality is unchanged. Leaderboard piggybacks
      // at 1 Hz instead of every snapshot (clients cache the last one).
      const inRace = room.state !== 'waiting';
      const sendNow = inRace ? (!LOW_BW || tickCount % 3 !== 0) : tickCount % 6 === 0;
      if (sendNow) {
        const snapObj = room.snapshot();
        if (tickCount % 30 === 0 || !entry.lbSent) { snapObj.lb = lbGet(room.mapId); entry.lbSent = true; }
        const snap = JSON.stringify(snapObj);
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
  res.json({ build: 'v40', tickHz: core.CFG.tickHz, geom: core.GEOM_ID, lowBw: LOW_BW });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[velocity-rush] multiplayer server on http://0.0.0.0:${PORT} (${core.CFG.tickHz} Hz sim)`);
});
