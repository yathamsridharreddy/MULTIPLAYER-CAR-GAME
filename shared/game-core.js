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
    steerRate: 2.1,
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

  // Car collision shape = CAPSULE (the car mesh is ~4.8 long x 1.9 wide, so a
  // single small circle let the long nose punch through obstacles while the
  // sides stopped on an invisible cushion). Segment ±CAP_L along the heading,
  // radius CAP_R.
  const CAR_CAP_L = 1.6, CAR_CAP_R = 0.95;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // capsule-vs-circle collision against every world collider (tires, trees,
  // buildings). Contact matches the visible car body from every angle, so
  // nothing invisible stops the car and the nose can never punch through.
  function resolveCarColliders(car, colliders, ev) {
    const dirX = Math.sin(car.heading), dirY = Math.cos(car.heading);
    for (const o of colliders) {
      if (o.r <= 0) continue;
      const rx = o.x - car.x, rz = o.z - car.z;
      const reach = CAR_CAP_L + CAR_CAP_R + o.r;
      if (rx * rx + rz * rz > reach * reach) continue;
      let t = rx * dirX + rz * dirY;
      if (t > CAR_CAP_L) t = CAR_CAP_L; else if (t < -CAR_CAP_L) t = -CAR_CAP_L;
      const px = car.x + dirX * t - o.x, pz = car.z + dirY * t - o.z;
      const d2 = px * px + pz * pz, rr = CAR_CAP_R + o.r;
      if (d2 >= rr * rr) continue;
      let nx, nz, d;
      if (d2 > 1e-6) { d = Math.sqrt(d2); nx = px / d; nz = pz / d; }
      else { nx = dirY; nz = -dirX; d = 0; }
      const pen = rr - d;
      car.x += nx * pen; car.z += nz * pen;
      const vn = car.vx * nx + car.vy * nz;
      if (vn < 0) {
        if (vn < -7) ev.crash = { x: o.x + nx * o.r, z: o.z + nz * o.r, s: Math.min(1, -vn / 22) };
        car.vx -= nx * vn * 1.5;
        car.vy -= nz * vn * 1.5;
        car.vx *= 0.55; car.vy *= 0.55;
      }
    }
  }

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

  // EXACT ellipse coordinate: lat L means the car sits on the offset ellipse
  // (a+L, b+L) — the SAME parametric family every ellipse-map visual is drawn
  // with (road edges ±8, curbs ±8.6, walls ±11.6). Using it for physics makes
  // drawn walls/curbs/road and collision agree at every angle (no ghost walls).
  function ellipseProj(x, z, a, b) {
    const f = (L) => { const u = x / (a + L), v = z / (b + L); return u * u + v * v - 1; };
    let lo = -Math.min(a, b) + 0.01, hi = 80;
    if (f(hi) > 0) hi = Math.max(Math.hypot(x, z), 200); // extreme fallback
    for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
    const L = (lo + hi) / 2;
    const ct = x / (a + L), st = z / (b + L);
    return { lat: L, cx: a * ct, cz: b * st };
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

    // (removed: stray invisible billboard collider — it had no visual mesh)
    const billboard = null;

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

    const hazards = [];
    [0.12, 0.38, 0.62, 0.88].forEach((f, i) => {
      const t = f * PI2;
      const px = a * Math.cos(t), pz = b * Math.sin(t);
      let tx = -a * Math.sin(t), tz = b * Math.cos(t); const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz, nz = tx; const side = (i % 2 ? 1 : -1) * (RH - 2.5);
      const x = px + nx * side, z = pz + nz * side;
      hazards.push({ x, z }); colliders.push({ x, z, r: 0.75 });
    });
    return { buildings, trees, mountains, colliders, billboard, hazards };
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
      this.driftScore = 0; this.eliminated = false;
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
      const st = trackStart(this.track, this.slot);
      this.x = st.x; this.z = st.z; this.heading = st.h;
      this.vx = 0; this.vy = 0;
      this.slip = 0;
      this.progress = 0; this.lastPhi = null;
      this.lap = 0; this.lapStart = raceTime; this.goTime = raceTime;
      this.lastLap = null; this.best = null;
      this.nitroMeter = 100; this.nitroActive = false;
      this.finished = false; this.finishTime = null;
      this._lb = false;
      this.driftScore = 0; this.eliminated = false; this.steerS = 0;
    }

    resetGrid(time) {
      const st = trackStart(this.track, this.slot);
      this.x = st.x; this.z = st.z; this.heading = st.h;
      this.vx = 0; this.vy = 0;
      this.slip = 0;
      this.progress = 0; this.lastPhi = null;
      this.lapStart = time;
      this.nitroMeter = 100;
    }

    isOffroad() {
      if (this.track.type === 'spline') return false; // spline path uses its own near.lat
      return Math.abs(ellipseProj(this.x, this.z, this.track.a, this.track.b).lat) > RH + 0.7;
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
      if (this.slip > 3.5 && Math.abs(fwd) > 6 && !this.finished) this.driftScore += this.slip * dt * 2;

      this.steerS += (inp.steer - this.steerS) * Math.min(1, dt * 9);
      const speedFactor = clamp(Math.abs(fwd) / 7, 0, 1);
      const agility = CFG.steerRate * this.cls.steer * speedFactor / (1 + Math.abs(fwd) * 0.022);
      let yaw = this.steerS * agility * (fwd >= 0 ? 1 : -1);
      if (inp.handbrake) yaw *= 1.5;
      this.heading -= yaw * dt;

      if (!held) {
        this.x += this.vx * dt;
        this.z += this.vy * dt;
      }

      resolveCarColliders(this, colliders, ev);

      // barrier walls keep the WHOLE car body on the circuit (props live
      // outside them) — nose, center and tail are all clamped
      const bc = clampCarToBarrier(this);
      if (bc && !ev.crash) ev.crash = bc;

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
      this.mode = ['coop','elim','drift'].includes(mode) ? mode : 'race';
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
      this.mode = ['coop','elim','drift'].includes(mode) ? mode : 'race';
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
      let steer = clamp(input.steer || 0, -1, 1);
      if (Math.abs(steer) < 0.06) steer = 0; // dead-zone: kills joystick/gyro noise so the car tracks straight
      this.inputs[slot] = {
        steer,
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
      const botActive = this.mode !== 'coop' && this.bot && !this.controllers[2];
      if (botActive) this.cars[1].setMeta('AI DRIVER', 0x0a84ff);
      this.cars[1].participating = this.mode !== 'coop' && (this.controllers[2] || botActive);
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
        if (this.mode === 'drift') return b.driftScore - a.driftScore;
        if (this.mode === 'elim') return (b.eliminated ? 0 : 1) - (a.eliminated ? 0 : 1) || b.totalProgress() - a.totalProgress();
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
        if (ev.lap && this.mode === 'elim') {
          const alive = this.cars.filter((c) => c.participating && !c.eliminated && c.slot !== car.slot);
          if (alive.length) {
            const last = alive.reduce((a, b) => (a.totalProgress() < b.totalProgress() ? a : b));
            last.eliminated = true; last.participating = false;
            this.events.push({ type: 'elim', slot: last.slot });
            this.setBanner(`❌ P${last.slot} ELIMINATED`);
          }
        }
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
            this.winner = this.mode === 'drift'
              ? (this.cars[0].driftScore >= this.cars[1].driftScore ? 1 : 2)
              : car.slot;
            const multi = this.participants().length > 1;
            this.setBanner(multi ? `PLAYER ${car.slot} WINS!` : `FINISH — ${fmtTime(car.finishTime)}`);
            this.events.push({ type: 'win', slot: car.slot, multi, t: r3(car.finishTime) });
          } else {
            this.events.push({ type: 'finished', slot: car.slot, t: r3(car.finishTime) });
          }
        }
      }

      // car-vs-car collision — each car is two circles (front + rear) matching
      // its length, so bumping is solid from every angle and cars can never
      // ghost through each other
      {
        const c1 = this.cars[0], c2 = this.cars[1];
        if (c1.participating && c2.participating && this.state !== 'waiting') {
          const discs = (c) => {
            const dx = Math.sin(c.heading), dz = Math.cos(c.heading);
            return [-1.5, 0, 1.5].map((o) => ({ x: c.x + dx * o, z: c.z + dz * o }));
          };
          let best = null;
          for (const p of discs(c1)) for (const q of discs(c2)) {
            const dx = q.x - p.x, dz = q.z - p.z;
            const d2 = dx * dx + dz * dz, rr = 1.9;
            if (d2 < rr * rr) {
              const d = Math.sqrt(d2) || 1e-3;
              const pen = rr - d;
              if (!best || pen > best.pen) best = { pen, nx: dx / d, nz: dz / d };
            }
          }
          if (best) {
            const push = best.pen / 2 + 0.001;
            c1.x -= best.nx * push; c1.z -= best.nz * push;
            c2.x += best.nx * push; c2.z += best.nz * push;
            const rvn = (c2.vx - c1.vx) * best.nx + (c2.vy - c1.vy) * best.nz;
            if (rvn < 0) {
              const j = -rvn * 0.6;
              c1.vx -= best.nx * j; c1.vy -= best.nz * j;
              c2.vx += best.nx * j; c2.vy += best.nz * j;
              c1.vx *= 0.97; c1.vy *= 0.97; c2.vx *= 0.97; c2.vy *= 0.97;
              if (rvn < -8) this.events.push({ type: 'crash', slot: c2.slot, x: r3((c1.x + c2.x) / 2), z: r3((c1.z + c2.z) / 2), s: r3(Math.min(1, -rvn / 24)) });
            }
            clampCarToBarrier(c1); clampCarToBarrier(c2);
          }
        }
      }

      if (this.state === 'racing' && this.mode === 'elim') {
        const alive = this.cars.filter((c) => c.participating);
        if (alive.length <= 1) {
          this.winner = alive[0] ? alive[0].slot : null;
          this.state = 'finished';
          this.setBanner(`🏆 P${this.winner} WINS THE DUEL!`);
          this.events.push({ type: 'results', order: this.standings().map((c) => ({ slot: c.slot, name: c.name, color: c.color, finished: c.finished, t: c.finishTime != null ? r3(c.finishTime) : null, best: c.best != null ? r3(c.best) : null, drift: Math.round(c.driftScore), elim: c.eliminated })) });
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
          th: r3(c.input.throttle),
          n: c.nitroActive ? 1 : 0,
          m: Math.round(c.nitroMeter),
          lap: c.lap,
          ll: c.lastLap != null ? r3(c.lastLap) : null,
          best: c.best != null ? r3(c.best) : null,
          fin: c.finished ? 1 : 0,
          ft: c.finishTime != null ? r3(c.finishTime) : null,
          drift: Math.round(c.driftScore),
          elim: c.eliminated ? 1 : 0,
          p: c.participating ? 1 : 0
        })),
        events: this.events.splice(0, this.events.length)
      };
    }
  }


  // ==================================================================
  // SPLINED TRACKS (Release 2) — additive; ellipse path untouched
  // ==================================================================
  function catmullRom(pts, samplesPer) {
    const out = []; const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      for (let j = 0; j < samplesPer; j++) {
        const t = j / samplesPer, t2 = t * t, t3 = t2 * t;
        out.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3)
        });
      }
    }
    return out;
  }
  function splineNearest(track, x, z, hint) {
    const P = track.points, N = P.length; let best = 1e18, bi = 0;
    if (hint != null) {
      for (let k = -30; k <= 30; k++) { const j = (hint + k + N * 4) % N; const dx = x - P[j].x, dz = z - P[j].z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = j; } }
    } else {
      for (let i = 0; i < N; i += 2) { const dx = x - P[i].x, dz = z - P[i].z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = i; } }
      for (let k = -2; k <= 2; k++) { const j = (bi + k + N) % N; const dx = x - P[j].x, dz = z - P[j].z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = j; } }
    }
    // project onto the two neighbouring segments -> EXACT perpendicular
    // distance to the drawn centerline (this is the same metric the road,
    // edge lines and fences are drawn with, so physics matches the visuals)
    let out = null;
    for (const i of [(bi - 1 + N) % N, bi]) {
      const a = P[i], b = P[(i + 1) % N];
      const ax = b.x - a.x, az = b.z - a.z;
      const len2 = (ax * ax + az * az) || 1;
      let t = ((x - a.x) * ax + (z - a.z) * az) / len2;
      t = clamp(t, 0, 1);
      const qx = a.x + ax * t, qz = a.z + az * t;
      const dx = x - qx, dz = z - qz;
      const d2 = dx * dx + dz * dz;
      if (!out || d2 < out.d2) {
        const L = Math.sqrt(len2);
        const tx = ax / L, tz = az / L;
        const lat = tx * (z - qz) - tz * (x - qx);
        out = { d2, lat, cx: qx, cz: qz, tx, tz, idx: i, along: (i + t) / N };
      }
    }
    return out;
  }
  function makeSplineTrack(ctrl) {
    const points = catmullRom(ctrl, 16);
    let mx = 0, mz = 0;
    points.forEach((p) => { mx = Math.max(mx, Math.abs(p.x)); mz = Math.max(mz, Math.abs(p.z)); });
    return { type: 'spline', points, a: mx, b: mz };
  }
  function makeSplineWorld(seed, track, theme) {
    const rnd = mulberry32(seed);
    const colliders = [], buildings = [], trees = [];
    const P = track.points;
    let placed = 0, attempts = 0;
    while (placed < 30 && attempts++ < 400) {
      const i = Math.floor(rnd() * P.length);
      const n = splineNearest(track, P[i].x, P[i].z);
      const side = rnd() < 0.5 ? 1 : -1;
      const off = (RH + 26 + rnd() * 70) * side;
      const x = n.cx + (-n.tz) * off, z = n.cz + (n.tx) * off;
      const w = 8 + rnd() * 10, d = 8 + rnd() * 10, h = (theme === 'neon' ? 18 : 10) + rnd() * 20;
      if (colliders.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + Math.hypot(w, d) / 2 + 4)) continue;
      buildings.push({ x, z, w, d, h, rot: rnd() * Math.PI, tex: placed % 3 });
      colliders.push({ x, z, r: Math.hypot(w, d) / 2 * 0.92 });
      placed++;
    }
    placed = 0; attempts = 0;
    while (placed < 110 && attempts++ < 900) {
      const i = Math.floor(rnd() * P.length);
      const n = splineNearest(track, P[i].x, P[i].z);
      const side = rnd() < 0.45 ? -1 : 1;
      const off = (RH + 6 + rnd() * 60) * side;
      const x = n.cx + (-n.tz) * off, z = n.cz + (n.tx) * off;
      if (colliders.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 3.2)) continue;
      const sc = 0.75 + rnd() * 0.9;
      trees.push({ x, z, s: sc, rot: rnd() * Math.PI, variant: placed % 2 });
      colliders.push({ x, z, r: 0.9 * sc });
      placed++;
    }
    const hazards = [];
    [0.12, 0.38, 0.62, 0.88].forEach((f, i) => {
      const idx = Math.floor(f * P.length); const p = P[idx], p2 = P[(idx + 1) % P.length];
      let tx = p2.x - p.x, tz = p2.z - p.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz, nz = tx; const side = (i % 2 ? 1 : -1) * (RH - 2.5);
      const x = p.x + nx * side, z = p.z + nz * side;
      hazards.push({ x, z }); colliders.push({ x, z, r: 0.75 });
    });
    return { buildings, trees, mountains: [], colliders, billboard: { x: P[0].x, z: P[0].z, rot: 0 }, hazards };
  }

  Car.prototype.updateSpline = function (dt, time, raceState, colliders) {
    const ev = { crash: null, lap: null, finish: null };
    const T = this.track, raw = this.input;
    const held = raceState === 'countdown';
    const inp = held ? { steer: raw.steer, throttle: 0, brake: 0, handbrake: true, nitro: false } : raw;
    const dirX = Math.sin(this.heading), dirY = Math.cos(this.heading);
    const rightX = dirY, rightY = -dirX;
    let speed = this.vx * dirX + this.vy * dirY;
    const near = T.nearest ? T.nearest(this.x, this.z) : splineNearest(T, this.x, this.z, this._nearIdx);
    if (!T.nearest) this._nearIdx = near.idx;
    const offroad = Math.abs(near.lat) > RH + 0.7;
    if (held) { this.vx = 0; this.vy = 0; this.slip = 0; }
    this.nitroActive = !!(inp.nitro && this.nitroMeter > 0 && inp.throttle > 0.1 && !this.finished);
    if (this.nitroActive) this.nitroMeter = Math.max(0, this.nitroMeter - CFG.nitroDrain * dt);
    else this.nitroMeter = Math.min(100, this.nitroMeter + CFG.nitroRegen * dt);
    let acc = 0;
    if (inp.throttle > 0.02) acc += inp.throttle * CFG.engineAccel * this.cls.acc;
    if (this.nitroActive) acc += CFG.nitroAccel;
    if (inp.brake > 0.02) acc += speed > 0.6 ? -inp.brake * CFG.brakeDecel : -inp.brake * CFG.reverseAccel;
    acc -= speed * 0.36; acc -= Math.sign(speed) * Math.min(Math.abs(speed), 1.7);
    if (offroad) acc -= speed * 1.5;
    if (this.finished) acc -= speed * 1.2;
    this.vx += dirX * acc * dt; this.vy += dirY * acc * dt;
    speed = this.vx * dirX + this.vy * dirY;
    let cap = speed >= 0 ? (offroad ? CFG.maxSpeedOffroad : CFG.maxSpeed * this.cls.top) : -CFG.reverseMax;
    if (speed >= 0 && this.nitroActive) cap += CFG.nitroCapBonus;
    if ((speed > 0 && speed > cap) || (speed < 0 && speed < cap)) { this.vx -= dirX * (speed - cap); this.vy -= dirY * (speed - cap); speed = cap; }
    const lat = this.vx * rightX + this.vy * rightY;
    const grip = inp.handbrake ? CFG.gripHandbrake : CFG.grip * this.cls.grip;
    const latAfter = lat * Math.max(0, 1 - grip * dt);
    const fwd = this.vx * dirX + this.vy * dirY;
    this.vx = dirX * fwd + rightX * latAfter; this.vy = dirY * fwd + rightY * latAfter;
    this.slip = Math.abs(lat);
    if (this.slip > 3.5 && Math.abs(fwd) > 6 && !this.finished) this.driftScore += this.slip * dt * 2;
    this.steerS += (inp.steer - this.steerS) * Math.min(1, dt * 9);
    const speedFactor = clamp(Math.abs(fwd) / 7, 0, 1);
    const agility = CFG.steerRate * this.cls.steer * speedFactor / (1 + Math.abs(fwd) * 0.022);
    let yaw = this.steerS * agility * (fwd >= 0 ? 1 : -1);
    if (inp.handbrake) yaw *= 1.5;
    this.heading -= yaw * dt;
    if (!held) { this.x += this.vx * dt; this.z += this.vy * dt; }
    resolveCarColliders(this, colliders, ev);
    // barrier — clamps the WHOLE car body (nose, center, tail) so no part of
    // the car can ever clip through the fence, at any angle
    const bc = clampCarToBarrier(this);
    if (bc && !ev.crash) ev.crash = bc;
    const dc = Math.hypot(this.x, this.z); if (dc > 900) { this.x *= 900 / dc; this.z *= 900 / dc; this.vx *= 0.5; this.vy *= 0.5; }
    const near3 = T.nearest ? T.nearest(this.x, this.z) : splineNearest(T, this.x, this.z, this._nearIdx);
    if (!T.nearest) this._nearIdx = near3.idx;
    const along = near3.along;
    if (this._along != null && raceState === 'racing' && !this.finished) { let d = along - this._along; if (d > 0.5) d -= 1; if (d < -0.5) d += 1; this.progress += d; }
    this._along = along;
    if (!this.finished && this.progress >= 1 - 1e-4) {
      const t = time - this.lapStart; this.lastLap = t; if (this.best == null || t < this.best) this.best = t;
      this.lap++; this.lapStart = time; this.progress -= 1;
      if (this.lap >= this.maxLaps) { this.finished = true; this.finishTime = time - this.goTime; ev.finish = { t: this.finishTime }; }
      else { ev.lap = { n: this.lap, t, isFinalNext: this.lap === this.maxLaps - 1 }; }
    } else if (this.progress <= -1) { this.progress += 1; }
    return ev;
  };
  const _carUpdate = Car.prototype.update;
  Car.prototype.update = function (dt, time, raceState, colliders) {
    if (this.track && this.track.type === 'spline') return this.updateSpline(dt, time, raceState, colliders);
    return _carUpdate.apply(this, arguments);
  };
  const _carReset = Car.prototype.resetState;
  Car.prototype.resetState = function (t) { this._along = null; this._nearIdx = null; return _carReset.apply(this, arguments); };
  const _bot = RaceRoom.prototype.botInput;
  RaceRoom.prototype.botInput = function () {
    if (this.track && this.track.type === 'spline') {
      const car = this.cars[1];
      const P = this.track.points;
      const n = this.track.nearest ? this.track.nearest(car.x, car.z) : splineNearest(this.track, car.x, car.z, car._nearIdx); if (!this.track.nearest) car._nearIdx = n.idx;
      const la = P[(n.idx + 10) % P.length];
      const desired = Math.atan2(la.x - car.x, la.z - car.z);
      let diff = desired - car.heading;
      while (diff > Math.PI) diff -= PI2; while (diff < -Math.PI) diff += PI2;
      const steer = clamp(-diff * 2.2, -1, 1);
      const throttle = clamp(0.94 - Math.abs(steer) * 0.45, 0.4, 0.94);
      return { steer, throttle, brake: 0, handbrake: false, nitro: Math.abs(steer) < 0.15 && Math.random() < 0.015 };
    }
    return _bot.call(this);
  };

  (function addSplineMaps() {
    const canyon = makeSplineTrack([
      { x: 130, z: 0 }, { x: 95, z: 70 }, { x: 20, z: 95 }, { x: -60, z: 80 },
      { x: -120, z: 40 }, { x: -95, z: -20 }, { x: -30, z: -35 }, { x: 20, z: -20 },
      { x: 60, z: -45 }, { x: 110, z: -60 }
    ]);
    canyon.theme = 'neon'; canyon.name = 'CANYON CHICANE';
    canyon.world = makeSplineWorld(4242, canyon, 'highland');
    const hairpin = makeSplineTrack([
      { x: 140, z: 0 }, { x: 100, z: 70 }, { x: 20, z: 92 }, { x: -60, z: 72 },
      { x: -125, z: 30 }, { x: -140, z: -30 }, { x: -90, z: -72 }, { x: -20, z: -60 },
      { x: 20, z: -84 }, { x: 90, z: -70 }, { x: 132, z: -40 }
    ]);
    hairpin.theme = 'island'; hairpin.name = 'HAIRPIN GP';
    hairpin.world = makeSplineWorld(777, hairpin, 'island');
    MAPS.push(canyon, hairpin);
  })();



  // ==================================================================
  // RADIAL TRACKS — robust distinct shapes (no nearest-point latch)
  // ==================================================================
  function makeRadialTrack(R0, harms, samples) {
    const centerR = (th) => { let r = R0; for (const h of harms) r += R0 * h.amp * Math.cos(h.k * th + (h.ph || 0)); return r; };
    const points = [];
    for (let i = 0; i < samples; i++) { const th = i / samples * PI2; const r = centerR(th); points.push({ x: Math.cos(th) * r, z: Math.sin(th) * r }); }
    let mx = 0, mz = 0; points.forEach((p) => { mx = Math.max(mx, Math.abs(p.x)); mz = Math.max(mz, Math.abs(p.z)); });
    const track = { type: 'spline', points, a: mx, b: mz, centerR, radial: true };
    // physics uses the SAME perpendicular-to-centerline metric the visuals are
    // drawn with (no more ray-vs-normal drift = no invisible walls on curves)
    track.nearest = (x, z) => splineNearest(track, x, z, null);
    return track;
  }

  (function buildRadialMaps() {
    const defs = [
      { R0: 112, harms: [{ k: 4, amp: 0.10 }], theme: 'neon',  name: 'NEON CITY' },
      { R0: 118, harms: [{ k: 3, amp: 0.14 }], theme: 'island', name: 'ISLAND MOTORFEST' },
      { R0: 122, harms: [{ k: 2, amp: 0.22 }], theme: 'desert', name: 'CANYON CHICANE' },
      { R0: 106, harms: [{ k: 3, amp: 0.16 }, { k: 5, amp: 0.05 }], theme: 'snow', name: 'HAIRPIN GP' }
    ];
    defs.forEach((d, i) => {
      const t = makeRadialTrack(d.R0, d.harms, 256);
      t.id = 1 + i; t.theme = d.theme; t.name = d.name;
      t.world = makeSplineWorld(1000 + i * 77, t, d.theme);
      MAPS[1 + i] = t;
    });
  })();

  // clamp the WHOLE car body (nose / center / tail probes) inside the track
  // barriers. The nose and tail may reach slightly further than the center
  // (they stop right at the fence/wall face). Returns crash data when the car
  // slams the fence hard. Also used after car-vs-car bumps so a bump can
  // never shove any part of a car through the fence.
  const PROBE_NOSE = 2.6, PROBE_TAIL = -2.4; // visual extents of the car mesh
  function clampCarToBarrier(car) {
    const T = car.track;
    if (!T) return null;
    const spline = T.type === 'spline';
    const limC = spline ? RH + 1.45 : RH + 2.4;  // car center limit
    const limP = spline ? RH + 2.4 : RH + 3.35;  // nose/tail limit = fence/wall inner face
    const dirX = Math.sin(car.heading), dirY = Math.cos(car.heading);
    const latOf = (px, pz) => {
      if (spline) {
        const n = T.nearest ? T.nearest(px, pz) : splineNearest(T, px, pz, null);
        return n.lat;
      }
      return ellipseProj(px, pz, T.a, T.b).lat;
    };
    // iterate: pushing along the center radial only approximately reduces an
    // angled probe's lat — 3 passes converge it fully
    let crash = null;
    for (let iter = 0; iter < 3; iter++) {
      let maxOver = 0, sign = 1;
      const probes = [[0, limC], [PROBE_NOSE, limP], [PROBE_TAIL, limP]];
      for (const pr of probes) {
        const lat = latOf(car.x + dirX * pr[0], car.z + dirY * pr[0]);
        const over = Math.abs(lat) - pr[1];
        if (over > maxOver) { maxOver = over; sign = lat > 0 ? 1 : -1; }
      }
      if (maxOver <= 0) break;
      if (spline) {
        // n points FROM the centerline TO the car -> pushing along -n moves
        // the car back toward the centerline (works on both sides)
        const c0 = T.nearest ? T.nearest(car.x, car.z) : splineNearest(T, car.x, car.z, car._nearIdx);
        if (!T.nearest) car._nearIdx = c0.idx;
        let nx = car.x - c0.cx, nz = car.z - c0.cz;
        const cd = Math.hypot(nx, nz) || 1; nx /= cd; nz /= cd;
        car.x -= nx * maxOver; car.z -= nz * maxOver;
        if (iter === 0) {
          const vAway = car.vx * nx + car.vy * nz; // outward speed (n = centerline->car)
          if (vAway > 0) {
            if (vAway > 9) crash = { x: car.x, z: car.z, s: Math.min(1, vAway / 26) };
            car.vx -= nx * vAway * 1.5; car.vy -= nz * vAway * 1.5;
            car.vx *= 0.9; car.vy *= 0.9;
          }
        }
      } else {
        // ellipse: n points FROM the centerline TO the car (exact parametric)
        const c0 = ellipseProj(car.x, car.z, T.a, T.b);
        let nx = car.x - c0.cx, nz = car.z - c0.cz;
        const cd = Math.hypot(nx, nz) || 1; nx /= cd; nz /= cd;
        car.x -= nx * maxOver; car.z -= nz * maxOver;
        if (iter === 0) {
          const vAway = car.vx * nx + car.vy * nz; // outward speed (n = centerline->car)
          if (vAway > 0) {
            if (vAway > 9) crash = { x: car.x, z: car.z, s: Math.min(1, vAway / 26) };
            car.vx -= nx * vAway * 1.5; car.vy -= nz * vAway * 1.5;
            car.vx *= 0.9; car.vy *= 0.9;
          }
        }
      }
    }
    return crash;
  }

  function trackStart(track, slot) {
    if (track.type === 'spline' && track.points) {
      const P = track.points, p0 = P[0], p1 = P[1];
      let tx = p1.x - p0.x, tz = p1.z - p0.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz, nz = tx; const side = slot === 1 ? -2.8 : 2.8;
      return { x: p0.x + nx * side - tx * 5, z: p0.z + nz * side - tz * 5, h: Math.atan2(tx, tz) };
    }
    return { x: track.a + (slot === 1 ? -2.8 : 2.8), z: -5, h: 0 };
  }

  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeRoomCode(rng) {
    const r = rng || Math.random;
    let s = '';
    for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(r() * CODE_ALPHABET.length)];
    return s;
  }

  return { CFG, MAPS, clamp, fmtTime, mulberry32, radialDistToTrack, ellipseProj, generateWorld, WORLD, Car, RaceRoom, ZERO_INPUT, makeRoomCode };
});
