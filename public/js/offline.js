/* ============================================================================
   SRIDHAR RUSH — OFFLINE MODE (v165)

   Racing with no internet at all.

   HOW IT WORKS. The whole race - the car physics, lap counting, checkpoints,
   pickups, the bots, the countdown - already lives in one isomorphic module
   (js/game-core.js, the same file the server runs). The browser has always
   shipped it; it simply never ran it. Every screen in the game is drawn from a
   stream of small JSON messages the server sends (`welcome`, `lobby`, `state`,
   `settle`), so offline mode is a LOCAL SERVER: this file runs that RaceRoom in
   the page at the same 30 Hz, feeds it the same input messages the client
   already sends, and hands the client the same messages it already knows how to
   render. Nothing about the car, the track or the HUD is duplicated or special-
   cased for offline - if it drives differently offline, one of the two cores has
   drifted, and a test compares them.

   WHAT IT DELIBERATELY DOES NOT DO. It never talks to the network, never writes
   a score anywhere, and never claims a reward. Offline times are personal: they
   are kept in localStorage as your own best, with the map and the weather, and
   they are not submitted to any leaderboard - the server accepts only races it
   simulated itself, and a client that could post its own time could post any
   time.

   USED BY: js/net.js picks this transport instead of the WebSocket when the
   racer chose OFFLINE or the browser has no connection. It exposes the same
   surface as RoomLink (connect / send / close / isOpen / status), so game.js
   does not know or care which one it is holding.
   ========================================================================== */
'use strict';

(function (global) {
  const TICK_HZ = 30;
  const LOCAL_ROOM = 'LOCAL1';
  const BEST_KEY = 'sr_offline_best';

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function validMapId(v) { const n = parseInt(v, 10); return (n >= 0 && CORE.MAPS[n]) ? n : null; }

  // ---- personal bests, offline only -----------------------------------------
  // One small record per map: the best race time and the best lap. Nothing here
  // ever leaves the device.
  function readBests() {
    try { const j = JSON.parse(global.localStorage.getItem(BEST_KEY) || '{}'); return (j && typeof j === 'object') ? j : {}; }
    catch (e) { return {}; }
  }
  function writeBests(o) { try { global.localStorage.setItem(BEST_KEY, JSON.stringify(o)); } catch (e) {} }
  function bestFor(mapId) { return readBests()[String(mapId)] || null; }

  function SROfflineLink(handlers) {
    this.handlers = handlers || {};
    this.open = false;
    this.closedByUser = false;
    this.delay = 0;                 // RoomLink parity (the reconnect backoff)
    this.room = null;
    this.slot = 1;
    this.profile = {};
    this.settings = { map: 0, weather: 'dry', laps: 3, bot: false, botSkill: 1 };
    this._timer = null;
    this._acc = 0;
    this._last = 0;
    this._settled = false;
    this._onVisible = null;
  }

  SROfflineLink.prototype.status = function (s) { if (this.handlers.onStatus) this.handlers.onStatus(s); };
  SROfflineLink.prototype.isOpen = function () { return !!this.open; };
  SROfflineLink.prototype._emit = function (obj) {
    // never let one bad handler take the race down with it
    try { if (this.handlers.onMessage) this.handlers.onMessage(obj); } catch (e) {}
  };
  SROfflineLink.prototype._lobby = function () {
    const r = this.room;
    const car = r && r.cars[this.slot - 1];
    this._emit({
      type: 'lobby', cap: r ? r.cap : 1, weather: this.settings.weather, state: r ? r.state : 'waiting',
      laps: this.settings.laps, bot: !!this.settings.bot, local: true,
      players: [{
        slot: this.slot, name: (car && car.name) || this.profile.name || 'RACER',
        color: (car && car.color) != null ? car.color : this.profile.color,
        rating: null, ready: true, host: true, crewTag: null, crewBadge: null
      }]
    });
  };

  // The room is built from the same options the server builds it from, so an
  // offline race has the same track, weather, laps and bots as an online one.
  SROfflineLink.prototype._buildRoom = function () {
    const s = this.settings;
    const room = new CORE.RaceRoom(LOCAL_ROOM, 'race', s.map, 6, s.weather);
    room.setLaps(s.laps);
    room.setWeather(s.weather);
    room.setBot(!!s.bot);
    if (typeof room.setBotSkill === 'function') room.setBotSkill(s.botSkill);
    room.setSeat(this.slot, true);                 // my car is a human seat
    this._applyProfile(room);
    this.room = room;
    this._settled = false;
    return room;
  };

  // Everything the racer chose, applied to a room that already exists. The client
  // ships map/weather/laps/bot/botSkill with every START (identityPayload), so this
  // is the path an offline race set up in the wizard actually travels.
  SROfflineLink.prototype._applySettings = function (room) {
    const s = this.settings;
    try { room.setLaps(s.laps); room.setWeather(s.weather); room.setBot(!!s.bot); } catch (e) {}
    if (typeof room.setBotSkill === 'function') room.setBotSkill(s.botSkill);
    room.setSeat(this.slot, true);
    this._applyProfile(room);
  };

  SROfflineLink.prototype._applyProfile = function (room) {
    const p = this.profile || {};
    const car = room.cars[this.slot - 1];
    if (!car) return;
    const meta = { name: p.name, color: p.color, cls: p.cls };
    try { room.setPlayerMeta(this.slot, meta); } catch (e) {}
    if (p.name) car.name = String(p.name).slice(0, 16);
    if (p.color != null) car.color = p.color;
    if (p.cls) car.clsKey = p.cls;
    if (p.sens != null && typeof car.setSens === 'function') car.setSens(p.sens);
    if ((p.cos || p.title) && typeof car.setCos === 'function') car.setCos(p.cos, p.title);
  };

  SROfflineLink.prototype.connect = function (hello) {
    if (hello) {
      this.profile = {
        name: hello.name, color: hello.color, cls: hello.cls, sens: hello.sens,
        cos: hello.cos, title: hello.title, pid: hello.pid, tok: hello.tok
      };
      if (hello.map != null) { const m = validMapId(hello.map); if (m != null) this.settings.map = m; }
      if (hello.weather) this.settings.weather = hello.weather;
      if (hello.laps != null) this.settings.laps = Math.max(1, Math.min(20, num(hello.laps, 3)));
      if (hello.bot != null) this.settings.bot = !!hello.bot;
      if (hello.botSkill != null) this.settings.botSkill = num(hello.botSkill, 1);
    }
    this.closedByUser = false;
    this.open = true;
    // v166: NOT "connected" - there is no connection, and the lobby must say so.
    // The chip reads OFFLINE, so a racer never wonders why clubs and rooms are
    // quiet while the race itself is running perfectly.
    this.status('offline');
    this._buildRoom();
    // the two messages the client needs to consider itself seated in a room
    this._emit({ type: 'welcome', role: 'screen', slot: this.slot, code: LOCAL_ROOM, mode: 'race', controllers: {}, snapshot: this.room.snapshot() });
    this._lobby();
    this._startLoop();
    return true;
  };

  SROfflineLink.prototype.reconnect = function (hello) { return this.connect(hello); };

  SROfflineLink.prototype.close = function () {
    this.closedByUser = true;
    this.open = false;
    this._stopLoop();
    this.status('closed');
  };

  // ---- the tick loop --------------------------------------------------------
  // Fixed 30 Hz steps, accumulated from real time, exactly like the server's
  // setInterval - so the car is simulated at the same rate whether the racer is
  // online or not. A backgrounded tab pauses with it (rAF), which is what a
  // single player wants: no race runs on without them.
  SROfflineLink.prototype._startLoop = function () {
    if (this._timer) return;
    const self = this;
    const step = (now) => {
      const dt = (now - self._last) / 1000;
      self._last = now;
      self._acc += Math.min(0.25, Math.max(0, dt));      // a long pause must not teleport the field
      let guard = 0;
      while (self._acc >= 1 / TICK_HZ && guard++ < 8) { self._acc -= 1 / TICK_HZ; self._tick(1 / TICK_HZ); }
      self._timer = global.requestAnimationFrame(step);
    };
    if (typeof global.requestAnimationFrame === 'function') {
      this._last = global.performance ? global.performance.now() : Date.now();
      this._timer = global.requestAnimationFrame(step);
    } else {
      this._timer = setInterval(() => self._tick(1 / TICK_HZ), 1000 / TICK_HZ);
    }
  };
  SROfflineLink.prototype._stopLoop = function () {
    if (!this._timer) return;
    if (typeof global.cancelAnimationFrame === 'function' && typeof this._timer === 'number') global.cancelAnimationFrame(this._timer);
    else clearInterval(this._timer);
    this._timer = null;
  };

  // one authoritative step + one snapshot, the same pair the server produces
  SROfflineLink.prototype._tick = function (dt) {
    const room = this.room;
    if (!room) return;
    room.update(dt);
    const snap = room.snapshot();          // carries type:'state' and drains the events
    this._emit(snap);
    if (room.state === 'finished' && !this._settled) {
      this._settled = true;
      this._recordLocalResult();
    }
  };

  // ---- a finished offline race ----------------------------------------------
  // The results screen reads a settle row. Offline it carries no reward and says
  // so: no XP, no rating, nothing submitted.
  SROfflineLink.prototype._recordLocalResult = function () {
    const room = this.room;
    const car = room && room.cars[this.slot - 1];
    if (!car) return;
    const row = { slot: this.slot, xp: 0, rd: 0, coins: 0, local: true };
    this._emit({ type: 'settle', rows: [row], local: true });
    if (car.finishTime == null) return;
    const key = String(this.settings.map);
    const bests = readBests();
    const prev = bests[key] || null;
    const lap = car.best != null ? car.best : null;
    const better = !prev || car.finishTime < prev.time;
    if (better) {
      bests[key] = { time: car.finishTime, lap: lap != null ? lap : (prev && prev.lap) || null, at: Date.now(), weather: this.settings.weather };
      writeBests(bests);
      if (typeof global.toast === 'function') {
        global.toast('🏁 NEW OFFLINE BEST on ' + ((CORE.MAPS[this.settings.map] || {}).name || 'this circuit') + ' — ' + CORE.fmtTime(car.finishTime) + ' (saved on this device)');
      }
    } else if (typeof global.toast === 'function') {
      global.toast('🏁 OFF-LINE FINISH — ' + CORE.fmtTime(car.finishTime) + ' · your best here is ' + CORE.fmtTime(prev.time));
    }
  };

  // ---- messages the client sends, answered locally --------------------------
  SROfflineLink.prototype.send = function (msg) {
    if (!this.open || !msg || !msg.type) return false;
    const room = this.room;
    const car = room && room.cars[this.slot - 1];
    switch (msg.type) {
      case 'hello':
        return this.connect(msg);

      case 'create_room':
      case 'start': {
        this._readSettings(msg);
        // A changed map means a fresh track: rebuild rather than mutating, so the
        // room's cars start on the right grid of the right circuit. Anything else
        // (laps, weather, bots, car, name, sensitivity) is applied to the room we
        // already have - the client sends its whole setup with START.
        if (!room || room.mapId !== this.settings.map) this._buildRoom();
        else this._applySettings(room);
        this.room.start();
        this._lobby();
        return true;
      }

      case 'restart':
      case 'rematch':
        if (room) { room.restart(); this._settled = false; this._lobby(); }
        return true;

      case 'reset':
        if (room) { room.resetToWaiting(); this._settled = false; this._lobby(); }
        return true;

      case 'map': {
        const m = validMapId(msg.map);
        if (m == null) return false;
        this.settings.map = m;
        if (room && room.state === 'waiting') { this._buildRoom(); this._lobby(); }
        return true;
      }
      case 'weather':
        if (msg.weather) this.settings.weather = msg.weather;
        if (room) room.setWeather(this.settings.weather);
        this._lobby();
        return true;
      case 'laps':
        this.settings.laps = Math.max(1, Math.min(20, num(msg.laps, this.settings.laps)));
        if (room) room.setLaps(this.settings.laps);
        this._lobby();
        return true;
      case 'bot':
        this.settings.bot = !!msg.bot;
        if (room) room.setBot(this.settings.bot);
        this._lobby();
        return true;

      case 'meta':
        if (msg.name) this.profile.name = msg.name;
        if (msg.color != null) this.profile.color = msg.color;
        if (msg.cos || msg.title) { this.profile.cos = msg.cos; this.profile.title = msg.title; }
        if (room) this._applyProfile(room);
        return true;

      case 'input':
        // the same shape the server receives, straight into the same slot
        if (room) {
          room.inputs[this.slot] = {
            steer: num(msg.steer, 0), throttle: num(msg.throttle, 0), brake: num(msg.brake, 0),
            handbrake: !!msg.handbrake, nitro: !!msg.nitro
          };
        }
        return true;

      case 'horn':
        this._emit({ type: 'horn' });      // nobody else to hear it, but the racer does
        return true;

      case 'ping':
        this._emit({ type: 'pong', t: msg.t });
        return true;

      // nothing to ready up for, nothing recorded, no spectators to seat
      case 'ready':
      case 'record':
      case 'cam':
      case 'button':
        return true;

      case 'leave':
        if (room) { room.resetToWaiting(); this._settled = false; this._lobby(); }
        return true;

      // online-only verbs: say so rather than doing nothing at all
      case 'matchmake':
      case 'join_room':
        this._emit({ type: 'error', code: 'offline', msg: 'That needs the internet - this is an offline race.' });
        return true;

      default:
        return false;
    }
  };

  SROfflineLink.prototype._readSettings = function (msg) {
    const m = validMapId(msg.map); if (m != null) this.settings.map = m;
    if (msg.weather) this.settings.weather = msg.weather;
    if (msg.laps != null) this.settings.laps = Math.max(1, Math.min(20, num(msg.laps, this.settings.laps)));
    if (msg.bot != null) this.settings.bot = !!msg.bot;
    if (msg.botSkill != null) this.settings.botSkill = num(msg.botSkill, this.settings.botSkill);
    if (msg.name || msg.color != null || msg.cls || msg.cos || msg.title || msg.sens != null) {
      this.profile = Object.assign({}, this.profile, {
        name: msg.name || this.profile.name, color: msg.color != null ? msg.color : this.profile.color,
        cls: msg.cls || this.profile.cls, sens: msg.sens != null ? msg.sens : this.profile.sens,
        cos: msg.cos || this.profile.cos, title: msg.title || this.profile.title
      });
    }
  };

  global.SROfflineLink = SROfflineLink;
  global.SROffline = {
    link: function (handlers) { return new SROfflineLink(handlers); },
    bestFor: bestFor,
    bests: readBests,
    // true when this browser has no connection at all
    isOffline: function () { return global.navigator && global.navigator.onLine === false; },
    TICK_HZ: TICK_HZ
  };
})(typeof window !== 'undefined' ? window : globalThis);
