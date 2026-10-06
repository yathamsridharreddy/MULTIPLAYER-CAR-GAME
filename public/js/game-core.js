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

  // v83: Dynamic track surface conditions & weather multipliers
  const WEATHER_CONDITIONS = {
    dry: { id: 'dry', name: 'Dry Asphalt', gripMul: 1.0, dragMul: 1.0, icon: '☀️' },
    wet: { id: 'wet', name: 'Wet Rain', gripMul: 0.92, dragMul: 1.02, icon: '🌧️' },
    night: { id: 'night', name: 'Midnight Neon', gripMul: 1.0, dragMul: 1.0, icon: '🌙' },
    blizzard: { id: 'blizzard', name: 'Alpine Blizzard', gripMul: 0.88, dragMul: 1.05, icon: '❄️' }
  };

  // Car collision shape = CAPSULE (the car mesh is ~4.8 long x 1.9 wide, so a
  // single small circle let the long nose punch through obstacles while the
  // sides stopped on an invisible cushion). Segment ±CAP_L along the heading,
  // radius CAP_R.
  const CAR_CAP_L = 1.6, CAR_CAP_R = 0.95;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // v174 AUDIT. Two classes of wire value used to slip past a plain truthiness
  // test and reach the shared simulation:
  //   * own() - `MAPS['__proto__']`, `CAR_CLASSES['constructor']` and friends are
  //     truthy, so a hostile frame could hand a room Object.prototype as its
  //     track or a car a class with no physics numbers (NaN cars, and a tick
  //     that threw inside the server's 30 Hz loop).
  //   * num() - `clamp('abc', -1, 1)` is NaN, so one bad controller frame used to
  //     poison a car's whole state vector (the snapshot then shipped nulls).
  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const num = (v, fallback) => { const x = Number(v); return isFinite(x) ? x : (fallback || 0); };
  // A track id must be a real, own, integer key of MAPS - anything else is 0.
  function realMapId(id) { const i = (typeof id === 'number') ? id : parseInt(id, 10); return (Number.isInteger(i) && own(MAPS, i)) ? i : null; }
  // Racer-visible text from a socket: keep every printable character (unicode,
  // emoji, punctuation) but drop control codes and angle brackets, so no
  // downstream HTML sink can ever be handed a tag.
  const cleanText = (s, max) => String(s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
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

  // v169 — MAP 0: the fence is the limit, and the shoulder is LEVEL with the road.
  // The strip between the asphalt and the fence used to be a bank: measured around
  // the ellipse against the mesh the player sees, the ground there runs from metres
  // ABOVE the asphalt (where the road is a cutting) to metres BELOW it (where it is
  // an embankment), because the terrain field measured "how far off the road" along
  // the ray from the middle of the oval while the barrier measured a true
  // perpendicular - and because its flat corridor stopped at RH + 1.2. A car out
  // there therefore climbed the grass or dropped behind the kerb, which is what
  // "the car is going down the road" looks like from the driver's seat.
  // Now the corridor is flattened over the whole drivable width (see
  // getTerrainHeight), so the shoulder is the same height as the asphalt, and the
  // limit is the DRAWN fence: the wall line sits at RH + 3.65 (inner face 11.4,
  // built in the client's barrier pass), so the nose/tail stop at 11.35 - the v56
  // corridor - and the car can use the full width of the road again.
  // Maps 1-4 keep their own spec: a fence is DRAWN at their limit too.
  MAPS[0].limC = RH + 2.4;          // 10.40 - the old corridor, unchanged
  MAPS[0].limP = RH + 3.35;         // 11.35 - nose/tail stop just inside the fence

  // car classes: stat trade-offs (top speed / acceleration / grip+steer)
  const SLOT_COLS = [0xe10600, 0x0d47c8, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7]; // v76 · v157: the blue is a DEEP blue, not the light azure it was
  // v155: every car the wizard offers, in the order the cards are drawn. The seat
  // defaults above are the first six of it. Exported so the server can hand out a
  // free car when the one a joiner asked for is already on the grid, without the
  // two sides ever disagreeing about what the list is.
  const CAR_PALETTE = [0xe10600, 0x0d47c8, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7, 0xffffff, 0x111111];
  const CAR_CLASSES = {
    velocity:    { name: 'VELOCITY',    top: 1.12, acc: 0.95, grip: 0.95, steer: 0.95 },
    accelerator: { name: 'ACCELERATOR', top: 0.97, acc: 1.22, grip: 1.0,  steer: 1.0 },
    grip:        { name: 'GRIP',        top: 0.98, acc: 1.0,  grip: 1.3,  steer: 1.18 }
  };

  function radialDistToTrack(x, z, a, b) {
    const t = Math.atan2(z, x);
    const denom = Math.hypot(b * Math.cos(t), a * Math.sin(t));
    const re = denom > 0 ? (a * b) / denom : a;
    return { re, d: Math.hypot(x, z) - re };
  }

  // Exact deterministic 3D elevation profile for every track
  function getTrackElevation(track, th) {
    if (!track) return 0;
    const id = track.id != null ? track.id : 0;
    if (id === 1) return 6.5 * Math.sin(2 * th + 0.3) + 3.2 * Math.cos(3 * th) - 1.8 * Math.sin(th);
    if (id === 2) return 7.8 * Math.sin(th - 0.4) + 4.0 * Math.cos(2 * th) + 1.6 * Math.sin(4 * th);
    if (id === 3) return 10.5 * Math.sin(th + 0.8) + 4.8 * Math.cos(2 * th + 1.2) - 2.8 * Math.sin(3 * th);
    if (id === 4) return 12.5 * Math.sin(th - 1.0) + 5.8 * Math.cos(2 * th) + 3.2 * Math.sin(3 * th + 0.5);
    // Map 0 / default (Highland)
    return 4.8 * Math.sin(th) + 2.5 * Math.cos(2 * th - 0.4) - 1.2 * Math.sin(3 * th);
  }

  // Exact deterministic continuous 3D terrain heightfield with smooth track blending
  function getTerrainHeight(track, x, z) {
    if (!track) return 0;
    const id = track.id != null ? track.id : 0;
    let th = 0, latDist = 0;
    if (track.type === 'spline' && track.nearest) {
      const n = track.nearest(x, z);
      th = n.th;
      latDist = Math.abs(n.d);
    } else {
      // v168: the ELLIPSE reads the same projection the barrier clamp uses, and takes
      // the road's height at the FOOT of the perpendicular - which is the height
      // ribbon3D draws at that cross-section. Measuring along the ray from the centre
      // and reading the elevation at the point's own angle put the road corridor up to
      // ~2.6 m out of line with the drawn ribbon on the diagonals: the coarse terrain
      // mesh then hung over the asphalt, and the car riding it looked off the road.
      const pr = ellipseProj(x, z, track.a, track.b);
      th = Math.atan2(pr.cz, pr.cx);
      latDist = Math.abs(pr.lat);
    }
    const yRoad = getTrackElevation(track, th);
    let yNat = 0;
    if (id === 1) {
      yNat = 0.5 * Math.sin(x * 0.02) * Math.cos(z * 0.02);
    } else if (id === 2) {
      yNat = Math.max(-1.5, 12.0 * Math.sin(x * 0.011) * Math.cos(z * 0.011) + 16.0 * Math.sin(x * 0.005 + z * 0.007) - 4.5);
    } else if (id === 3) {
      yNat = 14.0 * Math.sin(x * 0.012) + 16.0 * Math.cos(z * 0.014) + 7.0 * Math.sin((x - z) * 0.022);
    } else if (id === 4) {
      yNat = 20.0 * Math.sin(x * 0.009 + 1.0) * Math.cos(z * 0.009) + 14.0 * Math.sin(z * 0.016 - 0.5) + 6.0 * Math.cos((x + z) * 0.02);
    } else {
      yNat = 8.0 * Math.sin(x * 0.014 + 0.5) * Math.cos(z * 0.016 - 0.3) + 13.0 * Math.sin(x * 0.006 - z * 0.008) + 4.5 * Math.cos((x + z) * 0.024);
    }
    // v169: on the ellipse the flat corridor runs out past the fence (RH + 3.65), so
    // the whole strip the car may drive - asphalt, kerb line, grass shoulder - and the
    // ground the fence stands on are all level with the road. The spline tracks keep
    // their own margin. Beyond the corridor the hillside blends in as before.
    const ellipseTrack = !(track.type === 'spline' && track.nearest);
    const roadMargin = ellipseTrack ? RH + 9.0 : RH + 1.2;
    const blendDist = 26.0;
    if (latDist <= roadMargin) return yRoad - 0.08;
    if (latDist >= roadMargin + blendDist) return yNat;
    const t = (latDist - roadMargin) / blendDist;
    const w = t * t * (3 - 2 * t);
    return (1 - w) * (yRoad - 0.08) + w * yNat;
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
  const ZERO_INPUT = () => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false, attack: false });
  // v176: the one place a mode string is validated. 'fighter' is Fighter Rush;
  // every other value behaves exactly as it always did (anything unknown = 'race').
  const MODES = ['race', 'coop', 'elim', 'drift', 'fighter'];
  function normMode(m) { return (typeof m === 'string' && MODES.indexOf(m) > 0) ? m : 'race'; }

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
      this.color = slot === 1 ? 0xe10600 : 0x0d47c8;
      this.sens = 1; // v92 per-driver steering sensitivity, 0.5-1.5, applied in the authoritative sim
      this.resetState(0);
    }

    setTrack(track) {
      this.track = track;
      this.startX = track.a + (this.slot === 1 ? -2.8 : 2.8);
    }

    setClass(key) { if (own(CAR_CLASSES, key)) this.cls = CAR_CLASSES[key]; } // v174: own keys only
    // v92 STEERING SENSITIVITY. The client sends its slider value; it is clamped
    // here because nothing from a socket is trusted. The gain term only ever
    // REDUCES lock from the baseline, so cranking the slider up buys a quicker
    // wheel but never extra cornering grip over a default driver.
    setSens(v) { const n = parseFloat(v); this.sens = isFinite(n) ? clamp(n, 0.5, 1.5) : 1; }
    setMeta(name, color, pid) {
      if (name) { const c = cleanText(name, 14); if (c) this.name = c; } // v174: strip tags/control codes
      if (typeof color === 'number' && isFinite(color)) this.color = Math.floor(color) & 0xffffff; // v65 sanitize
      if (pid) this.pid = String(pid).slice(0, 24); // stable account-lite id
    }
    setCos(cos, title) {
      // v112: keep EVERY cosmetic the snapshot publishes. The v59 version kept
      // only decal/wheels/trail, so neon underglow and the sp spoiler - both
      // readable in the snapshot and both purchasable in the shop - were
      // silently dropped here and never reached any screen. cos.b is the new
      // body-shell index (0..5, see SRCos.BODIES).
      if (cos) this.cos = { decal: cos.decal | 0, wheels: cos.wheels | 0, trail: cos.trail | 0, neon: cos.neon | 0, sp: cos.sp | 0, b: Math.max(0, Math.min(5, cos.b | 0)) };
      if (title) { const ct = cleanText(title, 10); if (ct) this.title = ct; } // v174: same rule as names
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

    // v174 AUDIT: nothing non-finite may survive a tick. NaN passes through every
    // clamp, JSON turns it into `null` on the wire, and every screen then draws a
    // car at null coordinates. Recover by putting the car back on the grid.
    // Returns true when a recovery happened.
    guardFinite(time) {
      if (isFinite(this.x) && isFinite(this.z) && isFinite(this.heading) &&
          isFinite(this.vx) && isFinite(this.vy) && isFinite(this.slip)) return false;
      this.resetState(time);
      return true;
    }

    update(dt, time, raceState, colliders, room) {
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
      const wGrip = (room && own(WEATHER_CONDITIONS, room.weather)) ? (WEATHER_CONDITIONS[room.weather].gripMul || 1.0) : 1.0; // v174
      const grip = (inp.handbrake ? CFG.gripHandbrake : CFG.grip * this.cls.grip) * wGrip;
      const latAfter = lat * Math.max(0, 1 - grip * dt);
      const fwd = this.vx * dirX + this.vy * dirY;
      this.vx = dirX * fwd + rightX * latAfter;
      this.vy = dirY * fwd + rightY * latAfter;
      this.slip = Math.abs(lat);
      if (this.slip > 3.5 && Math.abs(fwd) > 6 && !this.finished) this.driftScore += this.slip * dt * 2;

      // v92 steering sensitivity: gain softens the lock, rate sets how fast it is reached
      const sGain = Math.min(1, 0.6 + 0.4 * (this.sens || 1));
      const sRate = 9 * (0.45 + 0.55 * (this.sens || 1));
      this.steerS += (clamp(inp.steer * sGain, -1, 1) - this.steerS) * Math.min(1, dt * sRate);
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

      // v174 AUDIT: last line of defence - see guardFinite(). Told to the race as
      // a respawn, which every client already knows how to draw.
      if (this.guardFinite(time)) ev.respawn = { slot: this.slot };

      return ev;
    }
  }

  // ------------------------------------------------------------------
  // Race room — authoritative server-side orchestration
  // ------------------------------------------------------------------
  const r3 = (v) => Math.round(v * 1000) / 1000;

  class RaceRoom {
    constructor(code, mode, mapId, maxSlots, weather) {
      this.code = code;
      this.mode = normMode(mode);
      this.fx = null;            // v176: Fighter Rush state, only ever built in that mode
      const wantMap = realMapId(mapId); // v174: own keys only - '__proto__' is not a circuit
      this.mapId = wantMap == null ? 0 : wantMap;
      this.weather = (weather && own(WEATHER_CONDITIONS, weather)) ? weather : 'dry';
      this.track = MAPS[this.mapId];
      this.state = 'waiting';
      this.botSkill = 1; // v45: PRO by default = byte-identical historic bot unless a client opts to ROOKIE
      this.raceTime = 0;
      this.countVal = 0;
      this.countTimer = 0;
      // v76: 1-6 player slots (physics unchanged; slot 1-2 layout identical to v75)
      this.cap = Math.max(2, Math.min(6, parseInt(maxSlots, 10) || 2));
      this.cars = [];
      this.inputs = {}; this.controllers = {}; this.seats = {};
      for (let s = 1; s <= this.cap; s++) {
        const c = new Car(s, this.track.a - 2.8, this.track);
        c.color = SLOT_COLS[(s - 1) % SLOT_COLS.length];
        this.cars.push(c);
        this.inputs[s] = ZERO_INPUT(); this.controllers[s] = false; this.seats[s] = false;
      }
      this.laps = CFG.totalLaps;
      this.bot = false;
      this.winner = null;
      this.events = [];
      this.banner = { text: '', seq: 0 };
      this.bannerSeq = 0;
      this.lastActivity = Date.now();
    }

    setWeather(w) {
      if (this.state !== 'waiting') return false;
      if (own(WEATHER_CONDITIONS, w)) { // v174: own keys only
        this.weather = w;
        return true;
      }
      return false;
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
    // v45: AI difficulty. 1 = PRO (identical to historic bot), 0 = ROOKIE
    // (slower, no nitro) so first-time players can taste a win.
    setBotSkill(v) { this.botSkill = v ? 1 : 0; }

    setPlayerMeta(slot, meta) {
      const car = this.cars[slot - 1];
      if (car && meta) car.setMeta(meta.name, meta.color, meta.pid);
      if (car && meta && meta.cls) car.setClass(meta.cls);
      if (car && meta) car.setSens(meta.sens != null ? meta.sens : 1); // v92 absent = default
    }

    participants() { return this.cars.filter((c) => c.participating); }

    setMode(mode) {
      if (this.state !== 'waiting') return false;
      this.mode = normMode(mode);
      return true;
    }

    setMap(mapId) {
      if (this.state !== 'waiting') return false;
      const id = realMapId(mapId); // v174: own keys only
      if (id == null) return false;
      this.mapId = id;
      this.track = MAPS[id];
      this.cars.forEach((c) => { c.setTrack(this.track); c.resetState(0); });
      return true;
    }

    setController(slot, connected) { this.controllers[slot] = connected; this.lastActivity = Date.now(); }
    setSeat(slot, on) { if (slot >= 1 && slot <= this.cap) this.seats[slot] = !!on; } // v76 human screen seat

    setInput(slot, input) {
      let steer = clamp(num(input.steer), -1, 1); // v174: numbers only, never NaN
      if (Math.abs(steer) < 0.06) steer = 0; // dead-zone: kills joystick/gyro noise so the car tracks straight
      this.inputs[slot] = {
        steer,
        throttle: clamp(num(input.throttle), 0, 1),
        brake: clamp(num(input.brake), 0, 1),
        handbrake: !!input.handbrake,
        nitro: !!input.nitro,
        attack: !!input.attack       // v176: Fighter Rush "IMPACT" - an attempt, never proof of a hit
      };
      this.lastActivity = Date.now();
    }

    start() {
      if (this.state === 'countdown' || this.state === 'racing') return false;
      return this._begin();
    }
    // v61 quick restart: full reset without reconnect (Time Trial / Practice)
    restart() {
      if (this.state === 'countdown') return false;
      return this._begin();
    }
    _begin() {
      this.raceTime = 0;
      this.winner = null;
      this.banner = { text: '', seq: ++this.bannerSeq };
      this.cars.forEach((c) => { c.maxLaps = this.laps; c.resetState(0); }); // v76 N-player
      const botOn = this.mode !== 'coop' && this.bot;
      for (const c of this.cars) {
        if (c.slot === 1) { c.participating = true; c._bot = false; continue; }
        const human = !!(this.controllers[c.slot] || this.seats[c.slot]);
        c.participating = this.mode !== 'coop' && (human || botOn);
        c._bot = this.mode !== 'coop' && !human && botOn;
        if (c._bot) {
          const BOT_NAMES = ['REDLINE_ACE', 'TAKUMI_86', 'PHANTOM_GT', 'VORTEX_99', 'SHADOW_PILOT', 'STORM_VALKYRIE', 'APEX_HUNTER'];
          const botName = BOT_NAMES[(c.slot - 1) % BOT_NAMES.length];
          c.setMeta(botName, 0x0d47c8);
          c.setSens(1); // v92 bots never inherit a human's sensitivity
        }
      }
      this._botActive = botOn;
      if (this.mode === 'fighter') fighter.begin(this);   // v176: combat state for this race only
      this.state = 'countdown';
      this.countVal = 3;
      this.countTimer = 0;
      this.events.push({ type: 'count', n: 3 });
      this.lastActivity = Date.now();
      return true;
    }

    resetCar(slot) { const car = this.cars[slot - 1]; if (car) car.resetGrid(this.raceTime); }

    resetToWaiting() {
      if (this.mode === 'fighter') this.fx = null;        // v176: leave no fighter state behind
      this.state = 'waiting';
      this.raceTime = 0;
      this.winner = null;
      this.cars.forEach((c) => c.resetState(0));
      this.banner = { text: '', seq: ++this.bannerSeq };
    }

    setBanner(text) { this.banner = { text, seq: ++this.bannerSeq }; }

    applyInputs() {
      if (this.mode === 'coop') {
        const i1 = this.inputs[1] || ZERO_INPUT(), i2 = this.inputs[2] || ZERO_INPUT();
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
        for (let s = 1; s <= this.cap; s++) {
          if (this.cars[s - 1]) this.cars[s - 1].input = this.inputs[s] || ZERO_INPUT();
        }
      }
      // v176 FIGHTER RUSH: an eliminated car is disabled - its phone keeps sending
      // frames, so the mask lives at the one place the sim reads input. Dead code
      // in every other mode (this.fx is null unless a fighter race is running).
      if (this.fx) for (const f of this.fx.cars) {
        if (f.dead) { const c = this.cars[f.slot - 1]; if (c) c.input = ZERO_INPUT(); }
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

    botInputFor(car) { // v76: bots may occupy any slot
      if (this.track && this.track.type === 'spline') {
        const P = this.track.points;
        const n = this.track.nearest ? this.track.nearest(car.x, car.z, car._th) : splineNearest(this.track, car.x, car.z, car._nearIdx);
        if (this.track.nearest) car._th = n.th; else car._nearIdx = n.idx;
        const la = P[(n.idx + 10) % P.length];
        const desired = Math.atan2(la.x - car.x, la.z - car.z);
        let diff = desired - car.heading;
        while (diff > Math.PI) diff -= PI2; while (diff < -Math.PI) diff += PI2;
        const steer = clamp(-diff * 2.2, -1, 1);
        const bCap = this.botSkill ? 0.94 : 0.72; const throttle = clamp(bCap - Math.abs(steer) * 0.45, 0.4, bCap);
        return { steer, throttle, brake: 0, handbrake: false, nitro: !!this.botSkill && Math.abs(steer) < 0.15 && Math.random() < 0.015 };
      }
      const a = this.track.a, b = this.track.b;
      const phi = Math.atan2(car.z / b, car.x / a);
      const la = phi + 0.10;
      const tx = a * Math.cos(la), tz = b * Math.sin(la);
      const desired = Math.atan2(tx - car.x, tz - car.z);
      let diff = desired - car.heading;
      while (diff > Math.PI) diff -= PI2;
      while (diff < -Math.PI) diff += PI2;
      const steer = clamp(-diff * 2.2, -1, 1);
      const bCap2 = this.botSkill ? 0.94 : 0.72; /* v45: ROOKIE tops out slower */ const throttle = clamp(bCap2 - Math.abs(steer) * 0.45, 0.4, bCap2);
      return { steer, throttle, brake: 0, handbrake: false, nitro: !!this.botSkill && Math.abs(steer) < 0.15 && Math.random() < 0.015 };
    }
    botInput() { return this.botInputFor(this.cars[1]); }

    update(dt) {
      if (this.state === 'waiting' || this.state === 'finished') {
        // v174 AUDIT: a room that is not simulating still publishes snapshots
        // (the lobby grid, the results screen), so its cars are still checked.
        for (const car of this.cars) car.guardFinite(this.raceTime);
        return;
      }
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

      if (this._botActive && this.state === 'racing') for (const c of this.cars) if (c._bot && c.participating) this.inputs[c.slot] = this.botInputFor(c); // v76
      this.applyInputs();
      const colliders = this.track.world.colliders;

      for (const car of this.cars) {
        if (this.mode === 'coop' && car.slot === 2) { car.guardFinite(this.raceTime); continue; } // v174: skipped, not unguarded
        const ev = car.update(dt, this.raceTime, this.state, colliders, this);
        if (ev.crash) this.events.push({ type: 'crash', slot: car.slot, x: r3(ev.crash.x), z: r3(ev.crash.z), s: r3(ev.crash.s) });
        if (ev.respawn) this.events.push({ type: 'respawn', slot: ev.respawn.slot }); // v59
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
              ? this.participants().reduce((a, b) => (a.driftScore >= b.driftScore ? a : b)).slot // v76 N-player
              : car.slot;
            const multi = this.participants().length > 1;
            this.setBanner(multi ? `PLAYER ${car.slot} WINS!` : `FINISH — ${fmtTime(car.finishTime)}`);
            this.events.push({ type: 'win', slot: car.slot, multi, t: r3(car.finishTime) });
          } else {
            this.events.push({ type: 'finished', slot: car.slot, t: r3(car.finishTime) });
          }
        }
      }

      // v176 FIGHTER RUSH: the combat layer runs here - after every car has moved
      // for this tick (so the airtime model sees final positions) and BEFORE the
      // car-vs-car separation below, so a Speed Ram is judged on real contact
      // rather than on cars the physics has already pushed apart. One call, behind
      // the mode check; every other mode reaches the collision block unchanged.
      if (this.mode === 'fighter') fighter.tick(this, dt);

      // car-vs-car collision — each car is two circles (front + rear) matching
      // its length, so bumping is solid from every angle and cars can never
      // ghost through each other
      {
        for (let ci = 0; ci < this.cars.length; ci++) for (let cj = ci + 1; cj < this.cars.length; cj++) { // v76: all 15 pairs at 6p
        const c1 = this.cars[ci], c2 = this.cars[cj];
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
      }

      // v68 final barrier audit (maps 1-4): no matter what moved a car this
      // tick, nothing may sit outside the exact boundary when the snapshot is
      // emitted. One cheap exact-field pass per car (instant no-op when inside).
      if (this.track.type === 'spline') for (const car of this.cars) clampCarToBarrier(car);

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
      const snap = {
        type: 'state',
        state: this.state,
        mode: this.mode,
        map: this.mapId,
        weather: this.weather || 'dry',
        code: this.code,
        raceTime: r3(this.raceTime),
        count: this.state === 'countdown' ? r3(this.countVal + (1 - this.countTimer)) : null,
        winner: this.winner,
        laps: this.laps,
        bot: !!this._botActive,
          controllers: Object.assign({}, this.controllers), // v76 N slots
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
          p: c.participating ? 1 : 0,
          dc: (c.cos && c.cos.decal) || 0, wh: (c.cos && c.cos.wheels) || 0, tr: (c.cos && c.cos.trail) || 0, ne: (c.cos && c.cos.neon) || 0, sp: (c.cos && c.cos.sp) || 0, b: (c.cos && c.cos.b) || 0, ti: c.title || ''
        })),
        events: this.events.splice(0, this.events.length)
      };
      // v176: fighter fields exist only while this room IS a fighter room, so no
      // other mode's wire format gains a byte (see test/fighter-rush.test.js).
      if (this.mode === 'fighter') fighter.decorate(this, snap);
      return snap;
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
        out = { d2, d: Math.sqrt(d2), lat, cx: qx, cz: qz, tx, tz, idx: i, along: (i + t) / N };
      }
    }
    return out;
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
    // On-track tire-stack obstacles for maps 1-4 — VISIBLE (rendered as tire
    // stacks in game.js) AND solid (collider at the same x,z), exactly like
    // map 0. Placed on the racing line so they read as intentional obstacles.
    const hazards = [];
    const hzf = track.hazardFracs || [0.12, 0.38, 0.62, 0.88]; // v69 per-map layouts
    const side0 = track.hazardSide0 || 0;
    hzf.forEach((f, i) => {
      const idx = Math.floor(f * P.length); const p = P[idx], p2 = P[(idx + 1) % P.length];
      let tx = p2.x - p.x, tz = p2.z - p.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz, nz = tx; const side = ((i + side0) % 2 ? 1 : -1) * (RH - 2.5);
      const x = p.x + nx * side, z = p.z + nz * side;
      hazards.push({ x, z }); colliders.push({ x, z, r: 0.75 });
    });
    // v70: themed horizon for maps 1-4 (was empty) — same language as Map 0:
    // island = volcano + hills, desert = mesas, neon/snow = peak ring
    const mountains = [];
    const mCount = theme === 'island' ? 4 : (theme === 'desert' ? 10 : 14);
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
    return { buildings, trees, mountains, colliders, billboard: { x: P[0].x, z: P[0].z, rot: 0 }, hazards };
  }

  Car.prototype.updateSpline = function (dt, time, raceState, colliders, room) {
    const ev = { crash: null, lap: null, finish: null };
    const T = this.track, raw = this.input;
    const held = raceState === 'countdown';
    const inp = held ? { steer: raw.steer, throttle: 0, brake: 0, handbrake: true, nitro: false } : raw;
    const dirX = Math.sin(this.heading), dirY = Math.cos(this.heading);
    const rightX = dirY, rightY = -dirX;
    let speed = this.vx * dirX + this.vy * dirY;
    const near = T.nearest ? T.nearest(this.x, this.z, this._th) : splineNearest(T, this.x, this.z, this._nearIdx); // v69 warm start
    if (!T.nearest) this._nearIdx = near.idx;
    const offroad = (T.type === 'spline' ? near.d : Math.abs(near.lat)) > 6.35 ? true : (T.type !== 'spline' && Math.abs(near.lat) > RH + 0.7); // v56: drag begins when wheels cross the white line
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
    const weatherGripMod = (room && own(WEATHER_CONDITIONS, room.weather)) ? (WEATHER_CONDITIONS[room.weather].gripMul || 1.0) : 1.0; // v174
    const grip = (inp.handbrake ? CFG.gripHandbrake : CFG.grip * this.cls.grip) * weatherGripMod;
    const latAfter = lat * Math.max(0, 1 - grip * dt);
    const fwd = this.vx * dirX + this.vy * dirY;
    this.vx = dirX * fwd + rightX * latAfter; this.vy = dirY * fwd + rightY * latAfter;
    this.slip = Math.abs(lat);
    if (this.slip > 3.5 && Math.abs(fwd) > 6 && !this.finished) this.driftScore += this.slip * dt * 2;
    // v92 steering sensitivity: gain softens the lock, rate sets how fast it is reached
    const sGain = Math.min(1, 0.6 + 0.4 * (this.sens || 1));
    const sRate = 9 * (0.45 + 0.55 * (this.sens || 1));
    this.steerS += (clamp(inp.steer * sGain, -1, 1) - this.steerS) * Math.min(1, dt * sRate);
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
    const near3 = T.nearest ? T.nearest(this.x, this.z, this._th) : splineNearest(T, this.x, this.z, this._nearIdx);
    if (!T.nearest) this._nearIdx = near3.idx;
    if (T.nearest) this._th = near3.th; // v69 warm start
    const along = near3.along;
    // v59 safe respawn: stuck >3s or far outside -> last valid checkpoint, zero velocity
    if (raceState === 'racing' && !this.finished) {
      if (Math.abs(near3.lat) < 5) { this._safeT = (this._safeT || 0) + dt; if (this._safeT > 1.5) { this._safeT = 0; this._safe = { x: this.x, z: this.z, h: this.heading }; } }
      const spdNow = Math.abs(this.forwardSpeed());
      this._stuck = (spdNow < 1.2 && Math.abs(near3.lat) > 2) ? (this._stuck || 0) + dt : 0;
      // v68: a driver actively giving throttle at the fence is NOT stuck —
      // quick 3 s rescue only when coasting/parked; throttle-pinned gets 8 s.
      const stuckLimit = raw.throttle > 0.15 ? 8 : 3;
      if ((this._stuck > stuckLimit || Math.abs(near3.lat) > 25) && this._safe && this.participating) {
        this.x = this._safe.x; this.z = this._safe.z; this.heading = this._safe.h;
        this.vx = 0; this.vy = 0; this._stuck = 0; this._nearIdx = null; this._th = null;
        ev.respawn = { slot: this.slot };
      }
    }
    if (this._along != null && raceState === 'racing' && !this.finished) { let d = along - this._along; if (d > 0.5) d -= 1; if (d < -0.5) d += 1; this.progress += d; }
    this._along = along;
    if (!this.finished && this.progress >= 1 - 1e-4) {
      const t = time - this.lapStart; this.lastLap = t; if (this.best == null || t < this.best) this.best = t;
      this.lap++; this.lapStart = time; this.progress -= 1;
      if (this.lap >= this.maxLaps) { this.finished = true; this.finishTime = time - this.goTime; ev.finish = { t: this.finishTime }; }
      else { ev.lap = { n: this.lap, t, isFinalNext: this.lap === this.maxLaps - 1 }; }
    } else if (this.progress <= -1) { this.progress += 1; }
    // v174 AUDIT: this is the SECOND physics implementation (spline circuits, i.e.
    // maps 1-4) and it is reached through a patched Car.update, so the NaN backstop
    // at the end of the ellipse code never ran here - four of the five tracks would
    // have kept a non-finite car forever. Same rule: recover, tell the race.
    if (this.guardFinite(time)) ev.respawn = ev.respawn || { slot: this.slot };
    return ev;
  };
  const _carUpdate = Car.prototype.update;
  Car.prototype.update = function (dt, time, raceState, colliders, room) {
    if (this.track && this.track.type === 'spline') return this.updateSpline(dt, time, raceState, colliders, room);
    return _carUpdate.apply(this, arguments);
  };
  const _carReset = Car.prototype.resetState;
  Car.prototype.resetState = function (t) { this._along = null; this._nearIdx = null; this._th = null; return _carReset.apply(this, arguments); };
  // v76: spline bot logic merged into botInputFor above




  // ==================================================================
  // v68 RADIAL-X — maps 1-4 rebuilt from scratch. EXACT analytic track
  // field: r(θ) is a trig polynomial with closed-form r, r′, r″, so the
  // nearest point / true distance / exact normal for ANY query point are
  // solved analytically (coarse scan + safeguarded Newton). No polyline,
  // no vertex ambiguity, no sagitta error — physics and visuals consume
  // the SAME field, so the drawn fence IS the physical barrier to
  // machine precision. Escape is impossible by construction (see
  // clampCarToBarrier hard guarantee).
  // ==================================================================
  function makeRadialTrack(R0, harms, samples) {
    const rOf   = (th) => { let r = R0; for (const h of harms) r += R0 * h.amp * Math.cos(h.k * th + (h.ph || 0)); return r; };
    const drOf  = (th) => { let r = 0;  for (const h of harms) r -= R0 * h.amp * h.k * Math.sin(h.k * th + (h.ph || 0)); return r; };
    const d2rOf = (th) => { let r = 0;  for (const h of harms) r -= R0 * h.amp * h.k * h.k * Math.cos(h.k * th + (h.ph || 0)); return r; };
    const ptAt  = (th) => { const r = rOf(th), c = Math.cos(th), s = Math.sin(th); return { x: c * r, z: s * r }; };
    const tanAt = (th) => { const r = rOf(th), dr = drOf(th), c = Math.cos(th), s = Math.sin(th); return { x: dr * c - r * s, z: dr * s + r * c }; };
    // outward unit normal (curve is star-shaped around the origin: n̂·P > 0)
    const normAt = (th) => {
      const t = tanAt(th), L = Math.hypot(t.x, t.z) || 1;
      let nx = t.z / L, nz = -t.x / L;
      const p = ptAt(th);
      if (nx * p.x + nz * p.z < 0) { nx = -nx; nz = -nz; }
      return { x: nx, z: nz };
    };
    // precomputed coarse table (512 exact samples) — nearest queries scan
    // these with pure arithmetic, then refine analytically
    const COARSE = 512, coarse = [];
    for (let i = 0; i < COARSE; i++) coarse.push(ptAt(i / COARSE * PI2));

    const refine = (th0, x, z) => {
      // safeguarded Newton on f(θ) = |P(θ)−X|²  →  f′ = 2(P−X)·P′
      let th = th0;
      for (let it = 0; it < 16; it++) {
        const c = Math.cos(th), s = Math.sin(th);
        const r = rOf(th), dr = drOf(th), d2r = d2rOf(th);
        const px = c * r, pz = s * r;
        const tx = dr * c - r * s, tz = dr * s + r * c;           // P′(θ)
        const ax = d2r * c - 2 * dr * s - r * c, az = d2r * s + 2 * dr * c - r * s; // P″(θ)
        const dx = px - x, dz = pz - z;
        const f1 = 2 * (dx * tx + dz * tz);
        const f2 = 2 * (tx * tx + tz * tz + dx * ax + dz * az);
        if (Math.abs(f2) < 1e-9) break;
        const step = Math.max(-0.25, Math.min(0.25, f1 / f2));
        th -= step;
        if (Math.abs(step) < 1e-11) break;
      }
      return th;
    };

    // EXACT field query: true nearest point, true distance, exact outward
    // normal, signed lateral (outward > 0), θ, sample idx and lap-along.
    // v69 perf: windowed coarse scan. Cars move ~2 m/tick (≈0.02 rad), so a
    // ±40-sample window (≈1 rad of track) around the previous θ finds the
    // nearest point with 81 distance checks instead of 512. Falls back to the
    // full scan for teleports / far points (respawn, injections, stray cars).
    const scanWin = (x, z, i0, i1) => {
      let best = 1e18, bi = 0, second = 1e18, si = 0, third = 1e18, ti = 0;
      for (let i = i0; i <= i1; i++) {
        const j = (i + COARSE * 4) % COARSE;
        const dx = x - coarse[j].x, dz = z - coarse[j].z, d2 = dx * dx + dz * dz;
        if (d2 < best) { third = second; ti = si; second = best; si = bi; best = d2; bi = j; }
        else if (d2 < second) { third = second; ti = si; second = d2; si = j; }
        else if (d2 < third) { third = d2; ti = j; }
      }
      return [best, bi, si, ti];
    };
    const field = (x, z, hint) => {
      let w = null;
      if (hint != null) {
        const hc = Math.round(hint / PI2 * COARSE);
        w = scanWin(x, z, hc - 40, hc + 40);
        if (w[0] > 2500) w = null; // >50 m from the window -> full scan
      }
      if (!w) w = scanWin(x, z, 0, COARSE - 1);
      const best = w[0], bi = w[1], si = w[2], ti = w[3];
      let bth = 0, bd2 = 1e18;
      for (const ci of [bi, si, ti]) {
        const th = refine(ci / COARSE * PI2, x, z);
        const p = ptAt(th), dx = p.x - x, dz = p.z - z, d2 = dx * dx + dz * dz;
        if (d2 < bd2) { bd2 = d2; bth = th; }
      }
      let th = bth % PI2; if (th < 0) th += PI2;
      const p = ptAt(th), n = normAt(th);
      const dx = x - p.x, dz = z - p.z;
      const d = Math.sqrt(bd2);
      const lat = dx * n.x + dz * n.z; // |lat| === d exactly at the true nearest point
      return { th, d, lat, cx: p.x, cz: p.z, nx: n.x, nz: n.z, idx: Math.round(th / PI2 * samples) % samples, along: th / PI2 };
    };

    const points = [];
    for (let i = 0; i < samples; i++) { const th = i / samples * PI2; const r = rOf(th); points.push({ x: Math.cos(th) * r, z: Math.sin(th) * r }); }
    let mx = 0, mz = 0; points.forEach((p) => { mx = Math.max(mx, Math.abs(p.x)); mz = Math.max(mz, Math.abs(p.z)); });
    const track = { type: 'spline', points, a: mx, b: mz, centerR: rOf, ptAt, normAt, radial: true };
    // v68 AUTHORITATIVE BOUNDARY SPEC — one source of truth on the track object.
    // roadHalf = asphalt half-width; limC = max car-center lateral;
    // limP = max nose/tail reach; fenceOff = visible fence inner face == limP.
    track.roadHalf = RH;          // 8.0 asphalt half-width (visual road)
    // v71: maps 1-4 use MAP 0's exact barrier numbers & wall system —
    // the proven, trusted collider behavior, on the exact analytic field.
    track.limC = RH + 2.4;        // 10.4 = Map 0 center limit (identical)
    track.limP = RH + 3.35;       // 11.35 = Map 0 nose/tail limit (identical)
    track.fenceOff = track.limP;  // visible wall inner face === physical nose limit (MUST equal limP)
    track.nearest = field;
    // exact offset curves for visuals — road edges, lines and fences are drawn
    // from the SAME formula physics uses (zero divergence by construction)
    track.offsetPts = (off, nPts) => {
      const out = [];
      for (let i = 0; i < nPts; i++) { const th = i / nPts * PI2; const p = ptAt(th), n = normAt(th); out.push({ x: p.x + n.x * off, z: p.z + n.z * off }); }
      return out;
    };
    return track;
  }

  (function buildRadialMaps() {
    // v69: maps 1-4 are FULLY NEW circuits — new shapes (harmonic signatures),
    // new obstacle layouts, new scenery seeds. Map 0 untouched.
    const defs = [
      { R0: 110, harms: [{ k: 3, amp: 0.09, ph: 0.8 }, { k: 5, amp: 0.045, ph: 2.1 }], theme: 'neon',   name: 'NEON CITY',        hz: [0.16, 0.41, 0.63, 0.87] },
      { R0: 117, harms: [{ k: 2, amp: 0.13, ph: 0.5 }, { k: 4, amp: 0.05,  ph: 1.2 }], theme: 'island', name: 'ISLAND MOTORFEST', hz: [0.10, 0.35, 0.60, 0.85] },
      { R0: 121, harms: [{ k: 2, amp: 0.16, ph: 1.9 }, { k: 3, amp: 0.09,  ph: 0.4 }], theme: 'desert', name: 'CANYON CHICANE',   hz: [0.14, 0.39, 0.64, 0.89] },
      { R0: 105, harms: [{ k: 3, amp: 0.15, ph: 2.6 }, { k: 6, amp: 0.04,  ph: 0.9 }], theme: 'snow',   name: 'HAIRPIN GP',       hz: [0.18, 0.43, 0.68, 0.93] }
    ];
    defs.forEach((d, i) => {
      const t = makeRadialTrack(d.R0, d.harms, 256);
      t.id = 1 + i; t.theme = d.theme; t.name = d.name;
      t.hazardFracs = d.hz; t.hazardSide0 = i % 2; // v69 fresh layouts (v175: power-up layout removed)
      t.world = makeSplineWorld(3000 + i * 131, t, d.theme); // v69 new scenery seed
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
    const dirX = Math.sin(car.heading), dirY = Math.cos(car.heading);
    if (T.type !== 'spline') {
      // ===== MAP 0 — the ellipse barrier =====
      // v168: the numbers live on the track (MAPS[0].limC/limP) so the server sim
      // and the client's render clamp read ONE source of truth. The fallback is
      // the old v56 corridor, for a track object built before this spec.
      const limC = T.limC != null ? T.limC : RH + 2.4;
      const limP = T.limP != null ? T.limP : RH + 3.35;
      let crash = null;
      for (let iter = 0; iter < 3; iter++) {
        let maxOver = 0, sign = 1;
        const probes = [[0, limC], [PROBE_NOSE, limP], [PROBE_TAIL, limP]];
        for (const pr of probes) {
          const lat = ellipseProj(car.x + dirX * pr[0], car.z + dirY * pr[0], T.a, T.b).lat;
          const over = Math.abs(lat) - pr[1];
          if (over > maxOver) { maxOver = over; sign = lat > 0 ? 1 : -1; }
        }
        if (maxOver <= 0) break;
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
      return crash;
    }

    // ===== MAPS 1-4 — v68 RADIAL-X exact engine =====
    // Mirrors Map 0's rock-solid 3-pass convergence with center normal
    const limC = T.limC, limP = T.limP;
    const probes = [[0, limC], [PROBE_NOSE, limP], [PROBE_TAIL, limP]];
    let crash = null;
    for (let iter = 0; iter < 3; iter++) {
      let maxOver = 0;
      for (const pr of probes) {
        const px = car.x + dirX * pr[0], pz = car.z + dirY * pr[0];
        const n = T.nearest(px, pz, car._th);
        if (pr[0] === 0) car._th = n.th;
        const over = n.d - pr[1];
        if (over > maxOver) maxOver = over;
      }
      if (maxOver <= 0) break;
      const c0 = T.nearest(car.x, car.z, car._th);
      car._th = c0.th;
      let nx = car.x - c0.cx, nz = car.z - c0.cz;
      const cd = Math.hypot(nx, nz) || 1;
      nx /= cd; nz /= cd;
      car.x -= nx * maxOver; car.z -= nz * maxOver;
      if (iter === 0) {
        const vAway = car.vx * nx + car.vy * nz; // outward speed towards barrier
        if (vAway > 0) {
          if (vAway > 9) crash = { x: car.x, z: car.z, s: Math.min(1, vAway / 26) };
          car.vx -= nx * vAway * 1.5; car.vy -= nz * vAway * 1.5;
          car.vx *= 0.9; car.vy *= 0.9;
        }
      }
    }
    return crash;
  }

  function trackStart(track, slot) {
    if (track.type === 'spline' && track.points) {
      const P = track.points, p0 = P[0], p1 = P[1];
      let tx = p1.x - p0.x, tz = p1.z - p0.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz, nz = tx;
      const row = Math.floor((slot - 1) / 2), side = (slot % 2 === 1 ? -2.8 : 2.8); // v76 2-wide grid
      return { x: p0.x + nx * side - tx * (5 + row * 5.5), z: p0.z + nz * side - tz * (5 + row * 5.5), h: Math.atan2(tx, tz) };
    }
    const row = Math.floor((slot - 1) / 2), side = (slot % 2 === 1 ? -2.8 : 2.8); // v76
    return { x: track.a + side, z: -5 - row * 5.5, h: 0 };
  }

  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeRoomCode(rng) {
    const r = rng || Math.random;
    let s = '';
    for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(r() * CODE_ALPHABET.length)];
    return s;
  }

  // ==================================================================
  // v176 FIGHTER RUSH — "your driving is your weapon"
  //
  // A self-contained combat layer that rides ON TOP of the existing simulation.
  //   * every entry point begins with isActive(room), i.e. mode === 'fighter';
  //   * every value it owns lives in room.fx, which is null in every other mode
  //     and is dropped the moment the room goes back to the lobby;
  //   * it never edits the car physics: it READS speed, slip and the terrain, and
  //     the only writes it makes to a car are a knockback impulse and the
  //     elimination flags the 'elim' mode already uses.
  // Isolation is proven in test/fighter-rush.test.js (a race run in each existing
  // mode is compared against the same race with this layer absent).
  //
  // Charge is earned by DRIVING: sustained speed, real slip (the same slip the
  // drift score uses), genuine airtime off the terrain and near misses. Nothing
  // here rewards holding a button - the thresholds are all "you are going fast",
  // "you are sideways", "you are in the air".
  //
  // AIRTIME uses the only vertical information the sim has: the road profile.
  // A car leaves the ground when the surface falls away faster than gravity can
  // pull it down: v^2*k > g, where k is the crest's curvature. Measured purely
  // from the two previous height samples, that test is exactly
  //   (riseRate(t-1) - riseRate(t)) > g*dt
  // so it costs one terrain sample per car per tick and no extra state.
  // ==================================================================
  const FX = {
    HP: 100,
    COST: 40,               // impact charge (0..100) one attack spends
    SPEED_MIN: 21,          // m/s (~76 km/h) where speed starts building charge
    SPEED_RATE: 9,          // charge per second at/above that speed
    DRIFT_RATE: 13,         // charge per second while genuinely sideways
    DRIFT_SLIP: 3.5,        // the sim's own "this is a drift" slip value
    NEAR_D: 4.6,            // a pass closer than this is a near miss...
    NEAR_D_MIN: 2.9,        // ...but touching is not
    NEAR_CD: 1.6,           // seconds before the same pair can score one again
    COMBO_WINDOW: 5,        // seconds of good driving a combo survives
    COMBO_MAX: 20,
    COMBO_CHG: 4,           // charge a combo step adds
    COMBO_POWER: 0.08,      // each combo step: +8% attack power (capped below)
    COMBO_POWER_CAP: 9,     // counted combo steps for power (so max +72%)
    BIAS_BONUS: 0.28,       // +28% when the charge came mostly from that skill
    G: 9.81,                // gravity, for the launch test AND the arc
    AIR_MIN_SPEED: 12,      // m/s: too slow to leave the ground
    AIR_MIN: 0.28,          // airtime that counts as a real jump
    AIR_LAT: 6.5,           // only the road corridor is trusted for a launch
    SLAM_ARM_AIR: 0.12,     // airtime after which IMPACT becomes an Air Slam
    DRIFT_USE_SLIP: 4.5,    // slip required to fire a Drift Impact
    DRIFT_USE_SPEED: 8,     // m/s required to fire a Drift Impact
    DRIFT_R: 9.5, DRIFT_DMG: 17,
    RAM_TIME: 1.6,          // seconds a Speed Ram stays armed
    RAM_SPEED: 20,          // m/s required to arm one
    RAM_R: 1.9,             // the physics' own disc radius, reused for contact
    RAM_MIN_REL: 4.5,       // closing speed below this is a nudge, not a ram
    RAM_K: 1.5, RAM_MAX: 34, RAM_MIN_DMG: 4,
    RAM_AIR_REL: 14,        // a ram this hard throws both cars into the air
    SLAM_R: 8.5, SLAM_DMG: 21, SLAM_AIR_REF: 0.9,
    KB_BASE: 5.5, KB_PER_DMG: 0.6, KB_MAX: 17,
    I_FRAMES: 0.45,         // one hit per target per attack, never a per-tick trickle
    MAX_HIT: 40,            // no single blow - however well driven - is more than 40% of HP
    HIT_FLASH: 0.5
  };
  const RAM_OFFS = [-1.5, 0, 1.5];   // must match the car-vs-car disc layout

  const fighter = {
    MODE: 'fighter',
    TUNE: FX,

    // The one gate. Everything below returns immediately unless this is true.
    isActive: function (room) { return !!room && room.mode === 'fighter'; },

    // ---- lifecycle ---------------------------------------------------------
    begin: function (room) {
      const cars = [];
      for (let i = 0; i < room.cap; i++) {
        cars.push({
          slot: i + 1,
          hp: FX.HP, chg: 0, combo: 0, comboT: 0,
          d: 0, s: 0, a: 0,                 // charge built by drift / speed / air
          air: 0, ay: 0, fvy: 0, ph: null, rise: 0, cool: 0, th: null,   // airtime
          ram: 0, slam: false, atk: '', hit: 0, iT: 0, dead: false,
          driftT: 0, driftCounted: false,
          nmT: [0, 0, 0, 0, 0, 0], _atkPrev: false, _botT: 1.5
        });
      }
      room.fx = { cars, alive: 0, contest: false, deaths: 0, order: [] };
      let fighters = 0;
      for (const c of room.cars) if (c.participating) fighters++;
      room.fx.alive = fighters;
      room.fx.contest = fighters >= 2;      // a lone driver practises, they do not "win" instantly
      // Fighter Rush is not a lap race: the primary objective is last car standing,
      // so no car may complete a race distance and stop driving mid-fight.
      for (const c of room.cars) c.maxLaps = 9999;
      return room.fx;
    },

    // ---- per-tick combat ---------------------------------------------------
    tick: function (room, dt) {
      if (!this.isActive(room) || !room.fx || room.state !== 'racing') return;
      const cars = room.cars, fx = room.fx;
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i], f = fx.cars[i];
        if (!f) continue;
        if (f.hit > 0) f.hit -= dt;
        if (f.iT > 0) f.iT -= dt;
        if (f.dead) { this._wreck(car); continue; }
        this._air(room, car, f, dt);
        this._earn(room, car, f, dt);
        this._decay(f, dt);
        this._attack(room, car, f, dt);
        this._ram(room, car, f, dt);
      }
      this._nearMisses(room, dt);
      this._win(room);
    },

    // ---- airtime: jumps are real, and they come from the terrain ----------
    _air: function (room, car, f, dt) {
      const track = room.track;
      if (!track) return;
      const h = getTerrainHeight(track, car.x, car.z);
      // Lateral distance from the centreline. Inside the corridor the surface IS the
      // road profile; outside it the road blends into the natural terrain, and that
      // blend is where the height samples step (measured: 1-14 m/s of apparent
      // "slope change" on a car at walking pace). A crest is only trusted on the road.
      const lat = this._lat(room, car, f);
      if (f.air > 0) {
        f.fvy -= FX.G * dt;
        f.ay += f.fvy * dt;
        f.air += dt;
        if (f.ay > h) return;                       // still flying
        const air = f.air;
        f.air = 0; f.ay = 0; f.fvy = 0; f.rise = 0; f.ph = h; f.cool = 0.5;
        if (air < FX.AIR_MIN) return;
        const sp = Math.abs(car.forwardSpeed());
        if (f.slam) { f.slam = false; f.atk = ''; this._slam(room, car, f, air); return; }
        const clean = car.slip < 3.2 && sp > FX.SPEED_MIN * 0.7;
        this._step(room, car, f, clean ? 'land' : 'landrough', clean ? 'PERFECT LANDING' : 'LANDING');
        room.events.push({ type: 'fxAir', slot: car.slot, air: r3(air), perfect: clean ? 1 : 0, x: r3(car.x), z: r3(car.z) });
        return;
      }
      const rise = f.ph == null ? 0 : (h - f.ph) / dt;
      if (f.cool > 0) f.cool -= dt;
      if (Math.abs(lat) > FX.AIR_LAT) { f.rise = rise; f.ph = h; return; }
      // v^2 * curvature > g, written with the two samples we already have, plus the
      // guards that make it a CREST rather than a sampling artefact: the car must be
      // fast, the ground must not already have been falling, it must be falling
      // clearly now, and the car must have touched down recently enough to be on it.
      // The threshold is a fraction of gravity rather than all of it, because the
      // 30 Hz sampling smooths a crest: measured on the real circuits with a
      // full-throttle driver on the racing line, 0.6 gives HAIRPIN GP (the hilliest
      // circuit) ~3.9 launches per lap and NEON CITY ~1.2, always between 160 and
      // 187 km/h - and exactly 0 spurious launches below 12 m/s, because the blend
      // artefacts that produced those all live outside the road corridor.
      if (f.ph != null && f.cool <= 0 && Math.abs(car.forwardSpeed()) > FX.AIR_MIN_SPEED &&
          f.rise > -0.25 && (f.rise - rise) > FX.G * dt * 0.6) {
        f.air = 0.0001; f.ay = h; f.fvy = Math.max(0, Math.min(9, f.rise));
        this._step(room, car, f, 'jump', 'JUMP');
        room.events.push({ type: 'fxJump', slot: car.slot, x: r3(car.x), z: r3(car.z), v: r3(f.fvy) });
      }
      f.rise = rise; f.ph = h;
    },

    // ---- charge: earned by driving, never by holding a button --------------
    _earn: function (room, car, f, dt) {
      const sp = Math.abs(car.forwardSpeed());
      if (sp > FX.SPEED_MIN) {
        const k = Math.min(1, (sp - FX.SPEED_MIN) / 12);
        const g = FX.SPEED_RATE * k * dt;
        f.chg = Math.min(100, f.chg + g); f.s += g;
      }
      if (car.slip > FX.DRIFT_SLIP && sp > 6) {
        const k = Math.min(1, (car.slip - FX.DRIFT_SLIP) / 6 + 0.35);
        const g = FX.DRIFT_RATE * k * dt;
        f.chg = Math.min(100, f.chg + g); f.d += g;
        f.driftT += dt;
        if (f.driftT > 1.1 && !f.driftCounted) { f.driftCounted = true; this._step(room, car, f, 'drift', 'DRIFT'); }
      } else { f.driftT = 0; f.driftCounted = false; }
      if (f.air > 0) {                                // airtime is worth something too
        const g = FX.SPEED_RATE * 0.5 * dt;
        f.chg = Math.min(100, f.chg + g); f.a += g;
      }
    },

    _decay: function (f, dt) {
      if (f.comboT > 0) { f.comboT -= dt; if (f.comboT <= 0) { f.combo = 0; f.comboT = 0; } }
    },

    _step: function (room, car, f, what, label) {
      f.combo = Math.min(FX.COMBO_MAX, f.combo + 1);
      f.comboT = FX.COMBO_WINDOW;
      f.chg = Math.min(100, f.chg + FX.COMBO_CHG);
      room.events.push({ type: 'fxCombo', slot: car.slot, n: f.combo, what: label || what });
    },

    _power: function (f) {
      return 1 + Math.min(f.combo, FX.COMBO_POWER_CAP) * FX.COMBO_POWER;
    },
    _bias: function (f, kind) {
      const tot = f.d + f.s + f.a;
      if (tot <= 0.001) return 1;
      const share = kind === 'drift' ? f.d / tot : (kind === 'ram' ? f.s / tot : f.a / tot);
      return 1 + FX.BIAS_BONUS * share;
    },

    // ---- attacks -----------------------------------------------------------
    _attack: function (room, car, f, dt) {
      const inp = car.input || ZERO_INPUT();
      const pressed = !!inp.attack;
      const rising = pressed && !f._atkPrev;
      f._atkPrev = pressed;
      let want = rising;
      if (!want && car._bot) {                 // the AI fights too (solo / short-handed rooms)
        f._botT -= dt;
        if (f._botT <= 0 && f.chg >= FX.COST) { want = true; f._botT = 1.4 + Math.random() * 1.6; }
      }
      if (!want) return;
      if (f.chg < FX.COST) {
        if (rising) room.events.push({ type: 'fxNo', slot: car.slot, why: 'charge' });
        return;
      }
      const sp = Math.abs(car.forwardSpeed());
      if (f.air > FX.SLAM_ARM_AIR) {                       // airborne -> Air Slam, armed now
        f.chg -= FX.COST; f.slam = true; f.atk = 'air';
        room.events.push({ type: 'fxAtk', slot: car.slot, kind: 'air', armed: 1, x: r3(car.x), z: r3(car.z), r: FX.SLAM_R });
        return;
      }
      if (car.slip > FX.DRIFT_USE_SLIP && sp > FX.DRIFT_USE_SPEED) { this._driftImpact(room, car, f); return; }
      if (sp > FX.RAM_SPEED) {
        f.chg -= FX.COST; f.ram = FX.RAM_TIME; f.atk = 'ram';
        room.events.push({ type: 'fxAtk', slot: car.slot, kind: 'ram', armed: 1, x: r3(car.x), z: r3(car.z) });
        return;
      }
      // the attack depends on HOW you are driving - a stationary car has none
      if (rising) room.events.push({ type: 'fxNo', slot: car.slot, why: 'context' });
    },

    _driftImpact: function (room, car, f) {
      f.chg -= FX.COST;
      f.atk = 'drift'; f.hit = 0;
      const dmg = FX.DRIFT_DMG * this._power(f) * this._bias(f, 'drift');
      room.events.push({ type: 'fxAtk', slot: car.slot, kind: 'drift', armed: 0, x: r3(car.x), z: r3(car.z), r: FX.DRIFT_R });
      this._area(room, car, f, FX.DRIFT_R, dmg, 'drift');
    },

    _slam: function (room, car, f, air) {
      const gain = Math.min(1.5, air / FX.SLAM_AIR_REF);
      const dmg = FX.SLAM_DMG * this._power(f) * this._bias(f, 'air') * (0.7 + 0.5 * gain);
      room.events.push({ type: 'fxAtk', slot: car.slot, kind: 'slam', armed: 0, air: r3(air), x: r3(car.x), z: r3(car.z), r: FX.SLAM_R });
      this._area(room, car, f, FX.SLAM_R, dmg, 'slam');
    },

    // 360-degree shockwave: everything alive inside R takes it, everything just
    // outside R earned the dodge.
    _area: function (room, car, f, R, dmg, kind) {
      for (const o of room.cars) {
        if (o === car || !o.participating) continue;
        const of = room.fx.cars[o.slot - 1];
        if (!of || of.dead) continue;
        const dx = o.x - car.x, dz = o.z - car.z;
        const d = Math.hypot(dx, dz);
        if (d < R) {
          const fall = 1 - 0.45 * (d / R);
          const nx = dx / (d || 1), nz = dz / (d || 1);
          const J = Math.min(FX.KB_MAX, FX.KB_BASE + dmg * FX.KB_PER_DMG * 0.6);
          this._hit(room, o, car.slot, dmg * fall, nx * J, nz * J, kind);
        } else if (d < R * 1.9) {
          this._step(room, o, of, 'dodge', 'DODGED');
        }
      }
    },

    // Speed Ram: the hit is a real contact, and its damage is the closing speed.
    _ram: function (room, car, f, dt) {
      if (f.ram <= 0) return;
      f.ram -= dt;
      if (f.ram <= 0) { f.ram = 0; if (f.atk === 'ram') f.atk = ''; return; }
      const dirX = Math.sin(car.heading), dirZ = Math.cos(car.heading);
      for (const o of room.cars) {
        if (o === car || !o.participating) continue;
        const of = room.fx.cars[o.slot - 1];
        if (!of || of.dead) continue;
        const odx = Math.sin(o.heading), odz = Math.cos(o.heading);
        let best = null;
        for (const a of RAM_OFFS) for (const b of RAM_OFFS) {
          const px = car.x + dirX * a, pz = car.z + dirZ * a;
          const qx = o.x + odx * b, qz = o.z + odz * b;
          const dx = qx - px, dz = qz - pz;
          const d2 = dx * dx + dz * dz;
          if (d2 < FX.RAM_R * FX.RAM_R) {
            const d = Math.sqrt(d2) || 1e-3;
            const pen = FX.RAM_R - d;
            if (!best || pen > best.pen) best = { pen, nx: dx / d, nz: dz / d };
          }
        }
        if (!best) continue;
        const rel = Math.max(0, -((o.vx - car.vx) * best.nx + (o.vy - car.vy) * best.nz));
        if (rel < FX.RAM_MIN_REL) continue;            // a slow bump must NOT ram
        const dmg = clamp((rel - FX.RAM_MIN_REL) * FX.RAM_K, 0, FX.RAM_MAX) * this._power(f) * this._bias(f, 'ram');
        if (dmg < FX.RAM_MIN_DMG) continue;
        const J = Math.min(FX.KB_MAX, FX.KB_BASE + dmg * FX.KB_PER_DMG * 0.7);
        this._hit(room, o, car.slot, dmg, best.nx * J, best.nz * J, 'ram');
        if (rel > FX.RAM_AIR_REL) this._launch(room, o, of, rel * 0.16);   // a hard ram lifts both cars
        car.vx *= 0.88; car.vy *= 0.88;                                    // ...and costs the rammer speed
        room.events.push({ type: 'fxAtk', slot: car.slot, kind: 'ram', armed: 0, rel: r3(rel), x: r3(o.x), z: r3(o.z), r: FX.RAM_R });
        f.ram = 0; f.atk = '';
        break;
      }
    },

    // lateral distance to the centreline (0 in the middle of the road)
    _lat: function (room, car, f) {
      const T = room.track;
      if (!T) return 99;
      if (T.type === 'spline' && T.nearest) {
        const n = T.nearest(car.x, car.z, f.th);
        f.th = n.th;
        return n.lat;
      }
      return ellipseProj(car.x, car.z, T.a, T.b).lat;
    },

    _launch: function (room, car, f, vUp) {
      if (f.air > 0 || !room.track) return;
      const h = getTerrainHeight(room.track, car.x, car.z);
      f.air = 0.0001; f.ay = h; f.fvy = Math.max(0, Math.min(9, vUp)); f.ph = h; f.rise = 0;
    },

    // ---- damage & elimination (authoritative: the client never sends any of this)
    _hit: function (room, victim, bySlot, dmg, kx, kz, kind) {
      const vf = room.fx.cars[victim.slot - 1];
      if (!vf || vf.dead || vf.iT > 0 || !(dmg > 0)) return 0;
      if (dmg > FX.MAX_HIT) dmg = FX.MAX_HIT;      // a great combo must not one-shot a full-health car
      vf.iT = FX.I_FRAMES;
      vf.hit = FX.HIT_FLASH;
      vf.hp = Math.max(0, vf.hp - dmg);
      vf.combo = 0; vf.comboT = 0;                 // being hit breaks the combo
      victim.vx += kx; victim.vy += kz;            // fighter-only knockback impulse
      room.events.push({
        type: 'fxHit', slot: victim.slot, by: bySlot, kind,
        dmg: Math.round(dmg), hp: Math.round(vf.hp),
        x: r3(victim.x), z: r3(victim.z), kx: r3(kx), kz: r3(kz)
      });
      if (vf.hp <= 0) {
        vf.dead = true; vf.ram = 0; vf.slam = false; vf.atk = '';
        victim.eliminated = true; victim.participating = false;   // the same flags 'elim' already uses
        room.fx.deaths++;
        room.fx.order.push(victim.slot);
        room.fx.alive = Math.max(0, room.fx.alive - 1);
        room.events.push({ type: 'fxDown', slot: victim.slot, by: bySlot, left: room.fx.alive });
        room.setBanner('💥 P' + victim.slot + ' ELIMINATED');
      }
      return dmg;
    },

    // a knocked-out car is a wreck: no input (masked in applyInputs), rolling to a stop
    _wreck: function (car) {
      car.vx *= 0.93; car.vy *= 0.93; car.slip *= 0.9;
    },

    _nearMisses: function (room, dt) {
      const cars = room.cars, fx = room.fx;
      for (let i = 0; i < cars.length; i++) {
        const a = cars[i], fa = fx.cars[i];
        if (!fa || fa.dead || !a.participating) continue;
        for (let j = i + 1; j < cars.length; j++) {
          const b = cars[j], fb = fx.cars[j];
          if (!fb || fb.dead || !b.participating) continue;
          if (fa.nmT[b.slot - 1] > 0 || fb.nmT[a.slot - 1] > 0) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d >= FX.NEAR_D || d <= FX.NEAR_D_MIN) continue;
          if (Math.abs(a.forwardSpeed()) > FX.SPEED_MIN * 0.75) { this._step(room, a, fa, 'near', 'NEAR MISS'); fa.nmT[b.slot - 1] = FX.NEAR_CD; }
          if (Math.abs(b.forwardSpeed()) > FX.SPEED_MIN * 0.75) { this._step(room, b, fb, 'near', 'NEAR MISS'); fb.nmT[a.slot - 1] = FX.NEAR_CD; }
        }
      }
      for (const f of fx.cars) for (let k = 0; k < 6; k++) if (f.nmT[k] > 0) f.nmT[k] -= dt;
    },

    // ---- last car standing -------------------------------------------------
    _win: function (room) {
      const fx = room.fx;
      let alive = 0;
      for (const c of room.cars) { const f = fx.cars[c.slot - 1]; if (f && !f.dead && c.participating) alive++; }
      fx.alive = alive;
      if (!fx.contest || alive > 1) return;
      room.winner = null;
      for (const c of room.cars) { const f = fx.cars[c.slot - 1]; if (f && !f.dead && c.participating) room.winner = c.slot; }
      room.state = 'finished';
      room.setBanner(room.winner ? '🏆 FIGHTER RUSH — P' + room.winner + ' WINS' : '🏆 FIGHTER RUSH — DRAW');
      room.events.push({ type: 'results', order: this.results(room), fighter: 1 });
    },

    results: function (room) {
      const fx = room.fx;
      const row = (c) => {
        const f = fx.cars[c.slot - 1];
        return {
          slot: c.slot, name: c.name, color: c.color, finished: false, t: null,
          best: c.best != null ? r3(c.best) : null,
          hp: f ? Math.round(f.hp) : 0, dead: f && f.dead ? 1 : 0, fighter: 1
        };
      };
      const hpOf = (c) => { const f = fx.cars[c.slot - 1]; return f ? f.hp : 0; };
      const alive = room.cars
        .filter((c) => { const f = fx.cars[c.slot - 1]; return f && !f.dead && c.participating; })
        .sort((a, b) => (hpOf(b) - hpOf(a)) || (b.totalProgress() - a.totalProgress()));
      const out = alive.map(row);
      for (let i = fx.order.length - 1; i >= 0; i--) {       // last eliminated = best of the dead
        const c = room.cars[fx.order[i] - 1];
        if (c) out.push(row(c));
      }
      return out;
    },

    decorate: function (room, snap) {
      const fx = room.fx;
      snap.fm = {
        alive: fx ? fx.alive : 0,
        contest: fx && fx.contest ? 1 : 0,
        cost: FX.COST, hpMax: FX.HP
      };
      for (const c of snap.cars) {
        const f = fx ? fx.cars[c.s - 1] : null;
        c.fx = f ? {
          hp: Math.round(f.hp), ch: Math.round(f.chg), cb: f.combo,
          rd: f.chg >= FX.COST ? 1 : 0,
          air: f.air > 0 ? 1 : 0, ay: r3(f.ay),
          at: f.atk || '', rm: f.ram > 0 ? 1 : 0,
          ht: f.hit > 0 ? 1 : 0, dead: f.dead ? 1 : 0
        } : null;
      }
    }
  };

  // Geometry fingerprint: client and server must agree on track layout. If a
  // browser caches an old game-core, its drawn track won't match the server's
  // car positions; the client detects this via /version.geom and forces reload.
  const GEOM_ID = (function () {
    const s = JSON.stringify(MAPS.map((m) => ({ i: m.id, t: m.theme, a: m.a, b: m.b, y: m.type || 'e', c: m.world.colliders.length, h: m.world.hazards.length, k: 9, L: m.limC || 0 }))); // k=barrier gen (v69 new circuits), L=boundary spec
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  })();

  return { CFG, MAPS, MODES, normMode, clamp, fmtTime, mulberry32, radialDistToTrack, ellipseProj, generateWorld, WORLD, Car, RaceRoom, ZERO_INPUT, makeRoomCode, GEOM_ID, WEATHER_CONDITIONS, getTrackElevation, getTerrainHeight, CAR_PALETTE, SRFighter: fighter };
});
