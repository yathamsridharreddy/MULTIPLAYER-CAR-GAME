/* ============================================================
   VELOCITY RUSH — shared game core (isomorphic)
   Deterministic world generation + pure car physics + race
   room state machine. Runs identically on the Node server
   (authoritative simulation) and is unit-testable in isolation.
   ============================================================ */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.VRCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CFG = {
    trackA: 130,
    trackB: 85,
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

  const A = CFG.trackA, B = CFG.trackB, RH = CFG.roadHalf;
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

  function radialDistToTrack(x, z) {
    const t = Math.atan2(z, x);
    const re = (A * B) / Math.hypot(B * Math.cos(t), A * Math.sin(t));
    return { re, d: Math.hypot(x, z) - re };
  }

  // ------------------------------------------------------------------
  // World generation (identical everywhere via fixed seed)
  // ------------------------------------------------------------------
  function generateWorld(seed) {
    const rnd = mulberry32(seed == null ? CFG.worldSeed : seed);
    const colliders = [];
    const buildings = [];
    const trees = [];

    let placed = 0, attempts = 0;
    while (placed < 34 && attempts++ < 400) {
      const t = rnd() * PI2;
      const off = 22 + rnd() * 100;
      const re = (A * B) / Math.hypot(B * Math.cos(t), A * Math.sin(t));
      const r = re + off;
      const x = Math.cos(t) * r, z = Math.sin(t) * r;
      const w = 8 + rnd() * 10, d = 8 + rnd() * 10, h = 10 + rnd() * 26;
      if (colliders.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + Math.hypot(w, d) / 2 + 4)) continue;
      buildings.push({ x, z, w, d, h, rot: rnd() * Math.PI, tex: placed % 3 });
      colliders.push({ x, z, r: Math.hypot(w, d) / 2 * 0.92 });
      placed++;
    }

    placed = 0; attempts = 0;
    while (placed < 130 && attempts++ < 900) {
      const t = rnd() * PI2;
      const inside = rnd() < 0.42;
      const re = (A * B) / Math.hypot(B * Math.cos(t), A * Math.sin(t));
      const off = inside ? -(RH + 6 + rnd() * 48) : (RH + 6 + rnd() * 85);
      const r = re + off;
      if (r < 6) continue;
      const x = Math.cos(t) * r, z = Math.sin(t) * r;
      if (Math.abs(x - A) < 24 && Math.abs(z) < 24) continue;
      if (colliders.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 3.2)) continue;
      const s = 0.75 + rnd() * 0.9;
      trees.push({ x, z, s, rot: rnd() * Math.PI, variant: placed % 2 });
      colliders.push({ x, z, r: 0.9 * s });
      placed++;
    }

    // billboard near the start line
    colliders.push({ x: A + 16, z: 14, r: 4 });
    const billboard = { x: A + 16, z: 14, rot: -Math.PI / 2 + 0.25 };

    const mountains = [];
    for (let i = 0; i < 14; i++) {
      mountains.push({
        t: (i / 14) * PI2 + rnd() * 0.3,
        dist: 680 + rnd() * 280,
        h: 120 + rnd() * 190,
        r: 90 + rnd() * 110,
        rot: rnd() * Math.PI
      });
    }

    return { buildings, trees, mountains, colliders, billboard };
  }

  const WORLD = generateWorld(CFG.worldSeed);

  // ------------------------------------------------------------------
  // Car physics (pure — no rendering)
  // ------------------------------------------------------------------
  const ZERO_INPUT = () => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false });

  class Car {
    constructor(slot, startX) {
      this.slot = slot;
      this.startX = startX;
      this.input = ZERO_INPUT();
      this.participating = slot === 1;
      this.resetState(0);
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
    }

    // arcade "back to grid" — keeps lap count & best times
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
      return Math.abs(radialDistToTrack(this.x, this.z).d) > RH + 0.7;
    }

    forwardSpeed() {
      return this.vx * Math.sin(this.heading) + this.vy * Math.cos(this.heading);
    }

    speedKmh() { return Math.abs(this.forwardSpeed()) * 3.6; }

    totalProgress() { return this.lap * PI2 + this.progress; }

    update(dt, time, raceState, colliders) {
      const ev = { crash: null, lap: null, finish: null };
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
      if (inp.throttle > 0.02) acc += inp.throttle * CFG.engineAccel;
      if (this.nitroActive) acc += CFG.nitroAccel;
      if (inp.brake > 0.02) acc += speed > 0.6 ? -inp.brake * CFG.brakeDecel : -inp.brake * CFG.reverseAccel;
      acc -= speed * 0.36;
      acc -= Math.sign(speed) * Math.min(Math.abs(speed), 1.7);
      if (offroad) acc -= speed * 1.5;
      if (this.finished) acc -= speed * 1.2;

      this.vx += dirX * acc * dt;
      this.vy += dirY * acc * dt;

      speed = this.vx * dirX + this.vy * dirY;
      let cap = speed >= 0 ? (offroad ? CFG.maxSpeedOffroad : CFG.maxSpeed) : -CFG.reverseMax;
      if (speed >= 0 && this.nitroActive) cap += CFG.nitroCapBonus;
      if ((speed > 0 && speed > cap) || (speed < 0 && speed < cap)) {
        this.vx -= dirX * (speed - cap);
        this.vy -= dirY * (speed - cap);
        speed = cap;
      }

      const lat = this.vx * rightX + this.vy * rightY;
      const grip = inp.handbrake ? CFG.gripHandbrake : CFG.grip;
      const latAfter = lat * Math.max(0, 1 - grip * dt);
      const fwd = this.vx * dirX + this.vy * dirY;
      this.vx = dirX * fwd + rightX * latAfter;
      this.vy = dirY * fwd + rightY * latAfter;
      this.slip = Math.abs(lat);

      const speedFactor = clamp(Math.abs(fwd) / 7, 0, 1);
      const agility = CFG.steerRate * speedFactor / (1 + Math.abs(fwd) * 0.022);
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
        if (this.lap >= CFG.totalLaps) {
          this.finished = true;
          this.finishTime = time - this.goTime;
          ev.finish = { t: this.finishTime };
        } else {
          ev.lap = { n: this.lap, t, isFinalNext: this.lap === CFG.totalLaps - 1 };
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
    constructor(code, mode) {
      this.code = code;
      this.mode = mode === 'coop' ? 'coop' : 'race';
      this.state = 'waiting';       // waiting | countdown | racing | finished
      this.raceTime = 0;
      this.countVal = 0;
      this.countTimer = 0;
      this.cars = [new Car(1, A - 2.8), new Car(2, A + 2.8)];
      this.inputs = { 1: ZERO_INPUT(), 2: ZERO_INPUT() };
      this.controllers = { 1: false, 2: false };
      this.winner = null;
      this.events = [];
      this.banner = { text: '', seq: 0 };
      this.bannerSeq = 0;
      this.lastActivity = Date.now();
    }

    participants() {
      return this.cars.filter((c) => c.participating);
    }

    setMode(mode) {
      if (this.state !== 'waiting') return false;
      this.mode = mode === 'coop' ? 'coop' : 'race';
      return true;
    }

    setController(slot, connected) {
      this.controllers[slot] = connected;
      this.lastActivity = Date.now();
    }

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
      this.cars.forEach((c) => c.resetState(0));
      this.cars[0].participating = true;
      this.cars[1].participating = this.mode === 'race' && this.controllers[2];
      this.state = 'countdown';
      this.countVal = 3;
      this.countTimer = 0;
      this.events.push({ type: 'count', n: 3 });
      this.lastActivity = Date.now();
      return true;
    }

    resetCar(slot) {
      const car = this.cars[slot - 1];
      if (car) car.resetGrid(this.raceTime);
    }

    resetToWaiting() {
      this.state = 'waiting';
      this.raceTime = 0;
      this.winner = null;
      this.cars.forEach((c) => c.resetState(0));
      this.banner = { text: '', seq: ++this.bannerSeq };
    }

    setBanner(text) {
      this.banner = { text, seq: ++this.bannerSeq };
    }

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

      this.applyInputs();

      for (const car of this.cars) {
        if (this.mode === 'coop' && car.slot === 2) continue;
        const ev = car.update(dt, this.raceTime, this.state, WORLD.colliders);
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

      // everyone done (or 12s after first finish) -> results
      if (this.state === 'racing' && this.winner) {
        const ps = this.participants();
        const allDone = ps.every((c) => c.finished);
        const firstFinishedAt = Math.min(...ps.filter((c) => c.finished).map((c) => c.finishTime + c.goTime));
        if (allDone || this.raceTime - firstFinishedAt > 12) {
          this.state = 'finished';
          const order = this.standings().map((c) => ({
            slot: c.slot, finished: c.finished, t: c.finishTime != null ? r3(c.finishTime) : null, best: c.best != null ? r3(c.best) : null
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
        code: this.code,
        raceTime: r3(this.raceTime),
        count: this.state === 'countdown' ? r3(this.countVal + (1 - this.countTimer)) : null,
        winner: this.winner,
        controllers: { 1: this.controllers[1], 2: this.controllers[2] },
        banner: this.banner,
        cars: this.cars.map((c) => ({
          s: c.slot,
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

  // ------------------------------------------------------------------
  // Room codes
  // ------------------------------------------------------------------
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeRoomCode(rng) {
    const r = rng || Math.random;
    let s = '';
    for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(r() * CODE_ALPHABET.length)];
    return s;
  }

  return { CFG, clamp, fmtTime, mulberry32, radialDistToTrack, generateWorld, WORLD, Car, RaceRoom, ZERO_INPUT, makeRoomCode };
});
