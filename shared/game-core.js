/* ============================================================
   SRIDHAR RUSH — shared game core (isomorphic)
   Deterministic world generation + pure car physics + race
   room state machine. Runs identically on the Node server
   (authoritative simulation) and is unit-testable in isolation.
   Supports 3 selectable maps (track shape + themed world).
   ============================================================ */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.VRCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CFG = {
    roadHalf: 8,
    maxSpeed: 47,
    maxSpeedOffroad: 15,
    engineAccel: 24,
    brakeDecel: 34,
    reverseAccel: 11,
    reverseMax: 9,
    steerRate: 2.35,
    grip: 7.0,
    gripHandbrake: 1.6,
    carRadius: 1.25,
    nitroAccel: 21,
    nitroCapBonus: 14,
    nitroDrain: 34,
    nitroRegen: 9,
    totalLaps: 3,
    worldSeed: 1337,
    tickHz: 30
  };

  const RH = CFG.roadHalf;
  const PI2 = Math.PI * 2;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtTime = (t) => {
    if (t == null || !isFinite(t)) return '--:--.--';
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  };

  // deterministic RNG so server + every client build the same world
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- the three maps: track ellipse (a,b) + theme + tuning ----
  const MAPS = [
    { id: 0, name: 'HIGHLAND RUSH', theme: 'highland', a: 130, b: 85 },   // Forza-style day, forests+mountains
    { id: 1, name: 'NEON CITY',     theme: 'neon',     a: 108, b: 100 },  // CarX-style night city
    { id: 2, name: 'ISLAND MOTORFEST', theme: 'island', a: 152, b: 76 }   // Crew-style tropical island
  ];

  // car classes: stat trade-offs (top speed / acceleration / grip+steer)
  const CAR_CLASSES = {
    velocity:    { name: 'VELOCITY',    top: 1.12, acc: 0.95, grip: 0.95, steer: 0.95 },
    accelerator: { name: 'ACCELERATOR', top: 0.97, acc: 1.22, grip: 1.0,  steer: 1.0 },
    grip:        { name: 'GRIP',        top: 0.98, acc: 1.0,  grip: 1.3,  steer: 1.18 }
  };

  function radialDistToTrack(x, z, a, b) {
    const t = Math.atan2(z, x);
    const re = (a * b) / Math.hypot(b * Math.cos(t), a * Math.sin(t));
    return { re, d: Math.hypot(x, z) - re };
  }

  // ------------------------------------------------------------------
  // World generation (identical everywhere via fixed seed)
  // ------------------------------------------------------------------
  function generateWorld(seed, a, b, theme) {
    const rnd = mulberry32(seed == null ? CFG.worldSeed : seed);
    const colliders = [];
    const buildings = [];
    const trees = [];

    // city maps get denser/taller buildings; island gets huts; highland medium
    const bCount = theme === 'neon' ? 44 : 32;
    const bHMin = theme === 'neon' ? 18 : 10;
    const bHVar = theme === 'neon' ? 30 : 22;
    let placed = 0, attempts = 0;
    while (placed < bCount && attempts++ < 500) {
      const t = rnd() * PI2;
      const off = 22 + rnd() * 100;
      const re = (a * b) / Math.hypot(b * Math.cos(t), a * Math.sin(t));
      const r = re + off;
      const x = Math.cos(t) * r, z = Math.sin(t) * r;
      const w = 8 + rnd() * 10, d = 8 + rnd() * 10, h = bHMin + rnd() * bHVar;
      if (colliders.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + Math.hypot(w, d) / 2 + 4)) continue;
      buildings.push({ x, z, w, d, h, rot: rnd() * Math.PI, tex: placed % 3 });
      colliders.push({ x, z, r: Math.hypot(w, d) / 2 * 0.92 });
      placed++;
    }

    // island => mostly palms (trees), highland => pines, neon => few trees
    const tCount = theme === 'island' ? 150 : (theme === 'neon' ? 40 : 120);
    placed = 0; attempts = 0;
    while (placed < tCount && attempts++ < 1000) {
      const t = rnd() * PI2;
      const inside = rnd() < 0.42;
      const re = (a * b) / Math.hypot(b * Math.cos(t), a * Math.sin(t));
      const off = inside ? -(RH + 6 + rnd() * 48) : (RH + 6 + rnd() * 85);
      const r = re + off;
      if (r < 6) continue;
      const x = Math.cos(t) * r, z = Math.sin(t) * r;
      if (Math.abs(x - a) < 24 && Math.abs(z) < 24) continue;
      if (colliders.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 3.2)) continue;
      const s = 0.75 + rnd() * 0.9;
      trees.push({ x, z, s, rot: rnd() * Math.PI, variant: placed % 2 });
      colliders.push({ x, z, r: 0.9 * s });
      placed++;
    }

    colliders.push({ x: a + 16, z: 14, r: 4 });
    const billboard = { x: a + 16, z: 14, rot: -Math.PI / 2 + 0.25 };

    const mountains = [];
    const mCount = theme === 'island' ? 4 : 14;   // island = one volcano + few hills
    for (let i = 0; i < mCount; i++) {
      mountains.push({
        t: (i / mCount) * PI2 + rnd() * 0.3,
        dist: 680 + rnd() * 280,
        h: (theme === 'island' && i === 0 ? 320 : 120 + rnd() * 190),
        r: 90 + rnd() * 110,
        rot: rnd() * Math.PI,
        volcano: theme === 'island' && i === 0
      });
    }

    return { buildings, trees, mountains, colliders, billboard };
  }

  // build a world for each map
  MAPS.forEach((m, i) => { m.world = generateWorld(CFG.worldSeed + i * 777, m.a, m.b, m.theme); });
  const WORLD = MAPS[0].world;

  // ------------------------------------------------------------------
  // Car physics (pure — no rendering)
  // ------------------------------------------------------------------
  const ZERO_INPUT = () => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false });

  class Car {
    constructor(slot, startX, track) {
      this.slot = slot;
      this.startX = startX;
      this.track = track || MAPS[0];
      this.cls = CAR_CLASSES.velocity;
      this.maxLaps = CFG.totalLaps;
      this.input = ZERO_INPUT();
      this.participating = slot === 1;
      this.name = 'PLAYER ' + slot;
      this.color = slot === 1 ? 0xe10600 : 0x0a84ff;
      this.resetState(0);
    }

    setTrack(track) {
      this.track = track;
      this.startX = track.a + (this.slot === 1 ? -2.8 : 2.8);
    }

    setClass(key) { if (CAR_CLASSES[key]) this.cls = CAR_CLASSES[key]; }
    setMeta(name, color) {
      if (name) this.name = String(name).slice(0, 14);
      if (color != null) this.color = color;
    }

    resetState(raceTime) {
      this.x = this.startX; this.z = -5;
      this.heading = 0;
      this.vx = 0; this.vy = 0;
      this.slip = 0;
      this.progress = 0; this.lastPhi = null;
      this.lap = 0; this.lapStart = raceTime; this.goTime = raceTime;
      this.lastLap = null; this.best = null;
      this.nitroMeter = 100; this.nitroActive = false;
      this.finished = false; this.finishTime = null;
      this._lb = false;
    }

    resetGrid(time) {
      this.x = this.startX; this.z = -5;
      this.heading = 0;
      this.vx = 0; this.vy = 0;
      this.slip = 0;
      this.progress = 0; this.lastPhi = null;
      this.lapStart = time;
      this.nitroMeter = 100;
    }

    isOffroad() {
      return Math.abs(radialDistToTrack(this.x, this.z, this.track.a, this.track.b).d) > RH + 0.7;
    }

    forwardSpeed() {
      return this.vx * Math.sin(this.heading) + this.vy * Math.cos(this.heading);
    }

    speedKmh() { return Math.abs(this.forwardSpeed()) * 3.6; }

    totalProgress() { return this.lap * PI2 + this.progress; }

    update(dt, time, raceState, colliders) {
      const ev = { crash: null, lap: null, finish: null };
      const A = this.track.a, B = this.track.b;
      const raw = this.input;
      const held = raceState === 'countdown';
      const inp = held
        ? { steer: raw.steer, throttle: 0, brake: 0, handbrake: true, nitro: false }
        : raw;

      const dirX = Math.sin(this.heading), dirY = Math.cos(this.heading);
      const rightX = dirY, rightY = -dirX;

      let speed = this.vx * dirX + this.vy * dirY;
      const offroad = this.isOffroad();

      if (held) { this.vx = 0; this.vy = 0; this.slip = 0; }

      this.nitroActive = !!(inp.nitro && this.nitroMeter > 0 && inp.throttle > 0.1 && !this.finished);
      if (this.nitroActive) this.nitroMeter = Math.max(0, this.nitroMeter - CFG.nitroDrain * dt);
      else this.nitroMeter = Math.min(100, this.nitroMeter + CFG.nitroRegen * dt);

      let acc = 0;
      if (inp.throttle > 0.02) acc += inp.throttle * CFG.engineAccel * this.cls.acc;
      if (this.nitroActive) acc += CFG.nitroAccel;
      if (inp.brake > 0.02) acc += speed > 0.6 ? -inp.brake * CFG.brakeDecel : -inp.brake * CFG.reverseAccel;
      acc -= speed * 0.36;
      acc -= Math.sign(speed) * Math.min(Math.abs(speed), 1.7);
      if (offroad) acc -= speed * 1.5;
      if (this.finished) acc -= speed * 1.2;

      this.vx += dirX * acc * dt;
      this.vy += dirY * acc * dt;

      speed = this.vx * dirX + this.vy * dirY;
      let cap = speed >= 0 ? (offroad ? CFG.maxSpeedOffroad : CFG.maxSpeed * this.cls.top) : -CFG.reverseMax;
      if (speed >= 0 && this.nitroActive) cap += CFG.nitroCapBonus;
      if ((speed > 0 && speed > cap) || (speed < 0 && speed < cap)) {
        this.vx -= dirX * (speed - cap);
        this.vy -= dirY * (speed - cap);
        speed = cap;
      }

      const lat = this.vx * rightX + this.vy * rightY;
      const grip = inp.handbrake ? CFG.gripHandbrake : CFG.grip * this.cls.grip;
      const latAfter = lat * Math.max(0, 1 - grip * dt);
      const fwd = this.vx * dirX + this.vy * dirY;
      this.vx = dirX * fwd + rightX * latAfter;
      this.vy = dirY * fwd + rightY * latAfter;
      this.slip = Math.abs(lat);

      const speedFactor = clamp(Math.abs(fwd) / 7, 0, 1);
      const agility = CFG.steerRate * this.cls.steer * speedFactor / (1 + Math.abs(fwd) * 0.022);
      let yaw = inp.steer * agility * (fwd >= 0 ? 1 : -1);
      if (inp.handbrake) yaw *= 1.5;
      this.heading -= yaw * dt;

      if (!held) {
        this.x += this.vx * dt;
        this.z += this.vy * dt;
      }

      for (const o of colliders) {
        const dx = this.x - o.x, dz = this.z - o.z;
        const rr = o.r + CFG.carRadius;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
          this.x = o.x + nx * rr;
          this.z = o.z + nz * rr;
          const vn = this.vx * nx + this.vy * nz;
          if (vn < 0) {
            if (vn < -7) ev.crash = { x: o.x + nx * o.r, z: o.z + nz * o.r, s: Math.min(1, -vn / 22) };
            this.vx -= nx * vn * 1.5;
            this.vy -= nz * vn * 1.5;
            this.vx *= 0.55; this.vy *= 0.55;
          }
        }
      }

      // barrier walls keep the car on the circuit (props live outside them)
      const rd = radialDistToTrack(this.x, this.z, A, B);
      const lim = RH + 2.4;
      if (Math.abs(rd.d) > lim) {
        const cur = Math.hypot(this.x, this.z) || 1;
        const nx = this.x / cur, nz = this.z / cur;
        const target = rd.re + (rd.d > 0 ? lim : -lim);
        const sc = target / cur;
        this.x *= sc; this.z *= sc;
        const vr = this.vx * nx + this.vy * nz;
        if ((rd.d > 0 && vr > 0) || (rd.d < 0 && vr < 0)) {
          this.vx -= nx * vr * 1.6;
          this.vy -= nz * vr * 1.6;
          this.vx *= 0.9; this.vy *= 0.9;
        }
      }

      const dc = Math.hypot(this.x, this.z);
      if (dc > 900) {
        this.x *= 900 / dc;
        this.z *= 900 / dc;
        this.vx *= 0.5; this.vy *= 0.5;
      }

      // lap progress
      const phi = Math.atan2(this.z / B, this.x / A);
      if (this.lastPhi != null && raceState === 'racing' && !this.finished) {
        let dphi = phi - this.lastPhi;
        if (dphi > Math.PI) dphi -= PI2;
        if (dphi < -Math.PI) dphi += PI2;
        this.progress += dphi;
      }
      this.lastPhi = phi;
      if (!this.finished && this.progress >= PI2 - 1e-3) {
        const t = time - this.lapStart;
        this.lastLap = t;
        if (this.best == null || t < this.best) this.best = t;
        this.lap++;
        this.lapStart = time;
        this.progress -= PI2;
        if (this.lap >= this.maxLaps) {
          this.finished = true;
          this.finishTime = time - this.goTime;
          ev.finish = { t: this.finishTime };
        } else {
          ev.lap = { n: this.lap, t, isFinalNext: this.lap === this.maxLaps - 1 };
        }
      } else if (this.progress <= -PI2) {
        this.progress += PI2;
      }

      return ev;
    }
  }

  // ------------------------------------------------------------------
  // Race room — authoritative server-side orchestration
  // ------------------------------------------------------------------
  const r3 = (v) => Math.round(v * 1000) / 1000;

  class RaceRoom {
    constructor(code, mode, mapId) {
      this.code = code;
      this.mode = mode === 'coop' ? 'coop' : 'race';
      this.mapId = (mapId != null && MAPS[mapId]) ? mapId : 0;
      this.track = MAPS[this.mapId];
      this.state = 'waiting';
      this.raceTime = 0;
      this.countVal = 0;
      this.countTimer = 0;
      this.cars = [new Car(1, this.track.a - 2.8, this.track), new Car(2, this.track.a + 2.8, this.track)];
      this.inputs = { 1: ZERO_INPUT(), 2: ZERO_INPUT() };
      this.controllers = { 1: false, 2: false };
      this.laps = CFG.totalLaps;
      this.bot = false;
      this.winner = null;
      this.events = [];
      this.banner = { text: '', seq: 0 };
      this.bannerSeq = 0;
      this.lastActivity = Date.now();
    }

    setLaps(n) {
      if (this.state !== 'waiting') return false;
      n = parseInt(n, 10);
      if (![1, 3, 5].includes(n)) return false;
      this.laps = n;
      return true;
    }

    setBot(on) {
      if (this.state !== 'waiting') return false;
      this.bot = !!on;
      return true;
    }

    setPlayerMeta(slot, meta) {
      const car = this.cars[slot - 1];
      if (car && meta) car.setMeta(meta.name, meta.color);
      if (car && meta && meta.cls) car.setClass(meta.cls);
    }

    participants() { return this.cars.filter((c) => c.participating); }

    setMode(mode) {
      if (this.state !== 'waiting') return false;
      this.mode = mode === 'coop' ? 'coop' : 'race';
      return true;
    }

    setMap(mapId) {
      if (this.state !== 'waiting') return false;
      if (!MAPS[mapId]) return false;
      this.mapId = mapId;
      this.track = MAPS[mapId];
      this.cars.forEach((c) => { c.setTrack(this.track); c.resetState(0); });
      return true;
    }

    setController(slot, connected) { this.controllers[slot] = connected; this.lastActivity = Date.now(); }

    setInput(slot, input) {
      this.inputs[slot] = {
        steer: clamp(input.steer || 0, -1, 1),
        throttle: clamp(input.throttle || 0, 0, 1),
        brake: clamp(input.brake || 0, 0, 1),
        handbrake: !!input.handbrake,
        nitro: !!input.nitro
      };
      this.lastActivity = Date.now();
    }

    start() {
      if (this.state === 'countdown' || this.state === 'racing') return false;
      this.raceTime = 0;
      this.winner = null;
      this.banner = { text: '', seq: ++this.bannerSeq };
      this.cars.forEach((c) => { c.maxLaps = this.laps; c.resetState(0); });
      this.cars[0].participating = true;
      const botActive = this.mode === 'race' && this.bot && !this.controllers[2];
      if (botActive) this.cars[1].setMeta('AI DRIVER', 0x0a84ff);
      this.cars[1].participating = this.mode === 'race' && (this.controllers[2] || botActive);
      this._botActive = botActive;
      this.state = 'countdown';
      this.countVal = 3;
      this.countTimer = 0;
      this.events.push({ type: 'count', n: 3 });
      this.lastActivity = Date.now();
      return true;
    }

    resetCar(slot) { const car = this.cars[slot - 1]; if (car) car.resetGrid(this.raceTime); }

    resetToWaiting() {
      this.state = 'waiting';
      this.raceTime = 0;
      this.winner = null;
      this.cars.forEach((c) => c.resetState(0));
      this.banner = { text: '', seq: ++this.bannerSeq };
    }

    setBanner(text) { this.banner = { text, seq: ++this.bannerSeq }; }

    applyInputs() {
      const i1 = this.inputs[1], i2 = this.inputs[2];
      if (this.mode === 'coop') {
        const s1 = i1.steer, s2 = i2.steer;
        const steer = Math.abs(s1) >= Math.abs(s2) ? s1 : s2;
        this.cars[0].input = {
          steer,
          throttle: Math.max(i1.throttle, i2.throttle),
          brake: Math.max(i1.brake, i2.brake),
          handbrake: i1.handbrake || i2.handbrake,
          nitro: i1.nitro || i2.nitro
        };
      } else {
        this.cars[0].input = i1;
        this.cars[1].input = i2;
      }
    }

    standings() {
      const cars = this.participants();
      return cars.slice().sort((a, b) => {
        if (a.finished && b.finished) return a.finishTime - b.finishTime;
        if (a.finished) return -1;
        if (b.finished) return 1;
        return b.totalProgress() - a.totalProgress();
      });
    }

    botInput() {
      const car = this.cars[1];
      const a = this.track.a, b = this.track.b;
      const phi = Math.atan2(car.z / b, car.x / a);
      const la = phi + 0.10;
      const tx = a * Math.cos(la), tz = b * Math.sin(la);
      const desired = Math.atan2(tx - car.x, tz - car.z);
      let diff = desired - car.heading;
      while (diff > Math.PI) diff -= PI2;
      while (diff < -Math.PI) diff += PI2;
      const steer = clamp(-diff * 2.2, -1, 1);
      const throttle = clamp(0.94 - Math.abs(steer) * 0.45, 0.4, 0.94);
      return { steer, throttle, brake: 0, handbrake: false, nitro: Math.abs(steer) < 0.15 && Math.random() < 0.015 };
    }

    update(dt) {
      if (this.state === 'waiting' || this.state === 'finished') return;
      this.raceTime += dt;
      this.lastActivity = Date.now();

      if (this.state === 'countdown') {
        this.countTimer += dt;
        if (this.countTimer >= 1) {
          this.countTimer -= 1;
          this.countVal--;
          if (this.countVal > 0) {
            this.events.push({ type: 'count', n: this.countVal });
          } else {
            this.state = 'racing';
            this.cars.forEach((c) => { c.lapStart = this.raceTime; c.goTime = this.raceTime; });
            this.events.push({ type: 'go' });
          }
        }
      }

      if (this._botActive && this.state === 'racing') this.inputs[2] = this.botInput();
      this.applyInputs();
      const colliders = this.track.world.colliders;

      for (const car of this.cars) {
        if (this.mode === 'coop' && car.slot === 2) continue;
        const ev = car.update(dt, this.raceTime, this.state, colliders);
        if (ev.crash) this.events.push({ type: 'crash', slot: car.slot, x: r3(ev.crash.x), z: r3(ev.crash.z), s: r3(ev.crash.s) });
        if (ev.lap) {
          if (ev.lap.isFinalNext) {
            this.events.push({ type: 'finallap', slot: car.slot });
            this.setBanner(`P${car.slot}: FINAL LAP!`);
          } else {
            this.events.push({ type: 'lap', slot: car.slot, n: ev.lap.n, t: r3(ev.lap.t), best: car.best === ev.lap.t });
          }
        }
        if (ev.finish) {
          if (!this.winner) {
            this.winner = car.slot;
            const multi = this.participants().length > 1;
            this.setBanner(multi ? `PLAYER ${car.slot} WINS!` : `FINISH — ${fmtTime(car.finishTime)}`);
            this.events.push({ type: 'win', slot: car.slot, multi, t: r3(car.finishTime) });
          } else {
            this.events.push({ type: 'finished', slot: car.slot, t: r3(car.finishTime) });
          }
        }
      }

      if (this.state === 'racing' && this.winner) {
        const ps = this.participants();
        const allDone = ps.every((c) => c.finished);
        const firstFinishedAt = Math.min(...ps.filter((c) => c.finished).map((c) => c.finishTime + c.goTime));
        if (allDone || this.raceTime - firstFinishedAt > 12) {
          this.state = 'finished';
          const order = this.standings().map((c) => ({
            slot: c.slot, name: c.name, color: c.color, finished: c.finished,
            t: c.finishTime != null ? r3(c.finishTime) : null, best: c.best != null ? r3(c.best) : null
          }));
          this.events.push({ type: 'results', order });
        }
      }
    }

    snapshot() {
      return {
        type: 'state',
        state: this.state,
        mode: this.mode,
        map: this.mapId,
        code: this.code,
        raceTime: r3(this.raceTime),
        count: this.state === 'countdown' ? r3(this.countVal + (1 - this.countTimer)) : null,
        winner: this.winner,
        laps: this.laps,
        bot: !!this._botActive,
        controllers: { 1: this.controllers[1], 2: this.controllers[2] },
        banner: this.banner,
        cars: this.cars.map((c) => ({
          s: c.slot,
          nm: c.name,
          col: c.color,
          x: r3(c.x), z: r3(c.z), h: r3(c.heading),
          v: r3(c.forwardSpeed()),
          sl: r3(c.slip),
          pr: r3(c.progress),
          st: r3(c.input.steer),
          n: c.nitroActive ? 1 : 0,
          m: Math.round(c.nitroMeter),
          lap: c.lap,
          ll: c.lastLap != null ? r3(c.lastLap) : null,
          best: c.best != null ? r3(c.best) : null,
          fin: c.finished ? 1 : 0,
          ft: c.finishTime != null ? r3(c.finishTime) : null,
          p: c.participating ? 1 : 0
        })),
        events: this.events.splice(0, this.events.length)
      };
    }
  }

  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeRoomCode(rng) {
    const r = rng || Math.random;
    let s = '';
    for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(r() * CODE_ALPHABET.length)];
    return s;
  }

  return { CFG, MAPS, clamp, fmtTime, mulberry32, radialDistToTrack, generateWorld, WORLD, Car, RaceRoom, ZERO_INPUT, makeRoomCode };
});
