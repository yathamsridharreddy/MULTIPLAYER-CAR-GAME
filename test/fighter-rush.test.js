'use strict';
/* ============================================================================
   v176 FIGHTER RUSH — authoritative simulation tests.

   Fighter Rush is a new mode: health, impact charge, three driving-borne
   attacks, eliminations and last-car-standing. Everything a player sees is
   decided by THIS code (shared/game-core.js), so this file drives the real
   simulation and checks what the server would broadcast.

   Two things this file is careful about:
     * every combat fact is asserted from the SERVER's numbers (events, hp,
       charge), never from anything a client could send;
     * the last sections prove the other modes are untouched, by re-running the
       same driving in a race room and a fighter room and comparing the cars
       tick for tick.
   ========================================================================== */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/game-core.js');

const FX = core.SRFighter.TUNE;
const DT = 1 / 30;

// ---- helpers ---------------------------------------------------------------
function makeRoom(n, mapId, mode) {
  const room = new core.RaceRoom('FIGHT' + n, mode || 'fighter', mapId || 0, n);
  // _begin() re-derives participation from the seats, exactly like the relay does
  // when a screen joins a seat - so a test room must occupy its seats for real.
  for (let i = 0; i < n; i++) { room.setSeat(i + 1, true); room.cars[i].participating = true; }
  return room;
}
// start() + run the 3 s countdown out, exactly like the server tick
function racing(room) {
  assert.equal(room.start(), true, 'the room started');
  for (let i = 0; i < 95; i++) room.update(DT);
  assert.equal(room.state, 'racing', 'countdown finished');
  return room;
}
function cleanFighter(room, hp) {
  room.events.length = 0;
  for (const c of room.cars) {
    c.vx = 0; c.vy = 0; c.slip = 0;
    room.setInput(c.slot, { steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false, attack: false });
  }
  for (const f of (room.fx ? room.fx.cars : [])) {
    f.hp = hp == null ? FX.HP : hp; f.chg = 0; f.combo = 0; f.comboT = 0; f.d = f.s = f.a = 0;
    f.air = 0; f.ay = 0; f.fvy = 0; f.ph = null; f.rise = 0; f.cool = 0; f.th = null;
    f.ram = 0; f.slam = false; f.atk = ''; f.hit = 0; f.iT = 0; f.dead = false; f._atkPrev = false;
    for (let k = 0; k < 6; k++) f.nmT[k] = 0;
  }
  if (room.fx) {
    room.fx.deaths = 0; room.fx.order.length = 0;
    room.fx.alive = room.cars.filter((c) => c.participating).length;
  }
  return room;
}
// the cars start on the grid, spaced along the track: that gives an on-road
// tangent to place them with, instead of inventing world coordinates.
function trackDir(room) {
  const a = room.cars[0], b = room.cars[1];
  let dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.hypot(dx, dz) || 1;
  return { dx: dx / L, dz: dz / L, heading: Math.atan2(dx / L, dz / L) };
}
// Nose-to-tail ram geometry. The cars keep the grid slots they were placed in
// (which is the one stretch of road the sim guarantees is clear), and only face
// along the track: the second grid slot is 4-8 m ahead of the first, which is
// exactly the ram's contact band once the closing speed is added.
function lineUp(room) {
  const d = trackDir(room);
  const a = room.cars[0], b = room.cars[1];
  a.heading = b.heading = d.heading;
  a.vx = a.vy = b.vx = b.vy = 0; a.slip = b.slip = 0;
  const gap = Math.hypot(a.x - b.x, a.z - b.z);
  assert.ok(gap > 4 && gap < 14, 'the grid gives a usable ram gap (' + gap.toFixed(1) + ' m)');
  assert.ok(Math.abs(a.forwardSpeed()) < 1, 'the test car is not already rolling');
  return { ...d, a, b, gap };
}
// side-by-side, `lat` metres apart across the road (near-miss geometry)
function abreast(room, lat) {
  const d = trackDir(room);
  const a = room.cars[0], b = room.cars[1];
  a.heading = b.heading = d.heading;
  a.x = b.x - d.dz * lat * -1;   // left of the track, perpendicular to (dx,dz)
  a.z = b.z - d.dx * lat;
  a.vx = a.vy = b.vx = b.vy = 0; a.slip = b.slip = 0;
  return { ...d, a, b };
}
function forward(car, speed) { car.heading = 0; car.vx = 0; car.vy = speed; car.slip = 0; }
function sideways(car, speed, lateral) { car.heading = 0; car.vx = lateral; car.vy = speed; }
function along(car, d, speed) { car.vx = d.dx * speed; car.vy = d.dz * speed; }
function eventsOf(room, type) { return room.events.filter((e) => e.type === type); }
function place(car, x, z, heading) { car.x = x; car.z = z; car.heading = heading; }
// One ram, start to finish: arm it, then let the sim close the gap and decide.
// The velocities are NEVER re-written mid-flight - the car-vs-car collision, the
// deceleration and the ram window are all part of what is being measured.
// Returns the first hit, whether the cars ever touched (disc radius 1.9 + the
// +-1.5 m body offsets = a 4.9 m centre gap) and the arming state.
function ramSequence(mineSpeed, theirSpeed, opts) {
  const room = cleanFighter(racing(makeRoom(2, 0)));
  const { a, b, dx, dz } = lineUp(room);
  const fa = room.fx.cars[0], fb = room.fx.cars[1];
  along(a, { dx, dz }, mineSpeed);
  along(b, { dx, dz }, theirSpeed);
  const hp0 = fb.hp;
  fa.chg = 100;
  room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: true });
  let contactTick = -1, armed = false;
  for (let i = 0; i < 45; i++) {
    room.update(DT);
    if (i === 0) room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: false });
    if (eventsOf(room, 'fxAtk').some((e) => e.kind === 'ram')) armed = true;
    if (contactTick < 0 && Math.hypot(a.x - b.x, a.z - b.z) <= 4.95) contactTick = i;
    const hit = eventsOf(room, 'fxHit');
    if (hit.length) return { hit: 1, dmg: hit[0].dmg, hpDrop: hp0 - fb.hp, tick: i, contactTick, armed, hp: fb.hp };
    if (opts && opts.stopAtContact && contactTick === i) break;
  }
  return { hit: 0, dmg: 0, hpDrop: hp0 - fb.hp, tick: -1, contactTick, armed, hp: fb.hp };
}
// three 40-damage blows kill a 100 HP car; step the i-frame window out between them
function kill(room, victimSlot, bySlot) {
  const v = room.cars[victimSlot - 1], vf = room.fx.cars[victimSlot - 1];
  let guard = 0;
  while (!vf.dead && guard++ < 20) { vf.iT = 0; core.SRFighter._hit(room, v, bySlot || 1, FX.MAX_HIT, 0, 0, 'ram'); }
  return guard;
}

describe('Fighter Rush — mode identity and lifecycle', () => {
  test('the mode exists and every unknown mode still falls back to race', () => {
    assert.ok(core.MODES.includes('fighter'), 'fighter is a registered mode');
    assert.equal(core.normMode('fighter'), 'fighter');
    for (const m of ['race', 'coop', 'elim', 'drift']) assert.equal(core.normMode(m), m);
    for (const junk of ['FIGHTER', null, undefined, '', 'fighter ', 42, 'hacker']) {
      assert.equal(core.normMode(junk), 'race', 'hostile/absent mode name -> race: ' + String(junk));
    }
  });

  test('starting a fighter room builds fighter state: 100 HP each, nobody dead', () => {
    const room = racing(makeRoom(2, 0));
    assert.ok(room.fx, 'the fighter state exists');
    assert.equal(room.fx.cars.length, room.cap);
    for (const f of room.fx.cars) { assert.equal(f.hp, FX.HP); assert.equal(f.chg, 0); assert.equal(f.dead, false); }
    assert.equal(room.fx.alive, 2);
    assert.equal(room.fx.contest, true, 'two racers = a real contest');
    assert.equal(room.mode, 'fighter');
  });

  test('one racer alone practises instead of winning instantly', () => {
    const room = racing(makeRoom(1, 0));
    assert.equal(room.fx.contest, false);
    for (let i = 0; i < 60; i++) room.update(DT);
    assert.equal(room.state, 'racing', 'a lone fighter is not declared winner');
    assert.equal(eventsOf(room, 'results').length, 0);
  });

  test('a fighter match cannot be won by laps: race distance is forced out of the way', () => {
    const room = racing(makeRoom(2, 0));
    for (const c of room.cars) assert.ok(c.maxLaps > 100, 'maxLaps is parked (' + c.maxLaps + ')');
  });

  test('the wire snapshot carries fighter state only in a fighter room', () => {
    const f = racing(makeRoom(2, 0));
    const s = f.snapshot();
    assert.equal(s.mode, 'fighter');
    assert.ok(s.fm, 'fm block present');
    assert.equal(s.fm.alive, 2);
    assert.equal(s.fm.hpMax, 100);
    assert.equal(s.fm.cost, FX.COST);
    for (const c of s.cars) assert.ok(c.fx && typeof c.fx.hp === 'number', 'per-car fx present');

    for (const mode of ['race', 'coop', 'elim', 'drift']) {
      const r = racing(makeRoom(2, 0, mode));
      const rs = r.snapshot();
      assert.equal(rs.fm, undefined, mode + ': no fm block');
      assert.equal(r.fx, null, mode + ': no fighter state');
      for (const c of rs.cars) assert.equal(c.fx, undefined, mode + ': no per-car fx');
    }
  });
});

describe('Fighter Rush — energy comes from driving, never from a button', () => {
  test('holding IMPACT in a parked car earns nothing and is refused once per press', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    const f = room.fx.cars[0];
    for (let i = 0; i < 90; i++) { room.setInput(1, { steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false, attack: true }); room.update(DT); }
    assert.equal(Math.round(f.chg), 0, 'no charge without driving');
    assert.equal(f.hp, FX.HP);
    assert.equal(room.fx.cars[1].hp, FX.HP, 'no damage from a stationary button press');
    const no = eventsOf(room, 'fxNo');
    assert.equal(no.length, 1, 'one refusal per press, not one per tick');
    assert.equal(no[0].why, 'charge');
    assert.equal(eventsOf(room, 'fxHit').length, 0);
  });

  test('sustained speed builds charge; the same time sideways builds it faster', () => {
    const cruise = cleanFighter(racing(makeRoom(2, 0)));
    const cf = cruise.fx.cars[0];
    for (let i = 0; i < 30; i++) {
      forward(cruise.cars[0], 34);
      cruise.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: false });
      cruise.update(DT);
    }
    const cruiseGain = cf.chg;
    assert.ok(cruiseGain > 5, 'cruising at 34 m/s charges (' + cruiseGain.toFixed(1) + ')');

    const drift = cleanFighter(racing(makeRoom(2, 0)));
    const df = drift.fx.cars[0];
    for (let i = 0; i < 30; i++) {
      sideways(drift.cars[0], 22, 9);                       // tail out, still moving forward
      drift.setInput(1, { steer: 0.4, throttle: 1, brake: 0, handbrake: true, nitro: false, attack: false });
      drift.update(DT);
    }
    assert.ok(drift.cars[0].slip > FX.DRIFT_SLIP, 'the sim agrees this is a drift (slip ' + drift.cars[0].slip.toFixed(1) + ')');
    assert.ok(df.chg > cruiseGain * 1.4, 'drifting charges faster than cruising (' + df.chg.toFixed(1) + ' vs ' + cruiseGain.toFixed(1) + ')');
    assert.ok(df.chg <= 100, 'charge stays inside 0..100');
  });

  test('a real terrain crest launches the car, and the jump scores a combo step', () => {
    // MEASURED: on HIGHLAND RUSH the road profile falls away fastest around
    // (2.3, -85.0); a car crossing it above the speed gate goes light. The spot is
    // part of the map data, so this is as deterministic as the map itself.
    const room = cleanFighter(racing(makeRoom(2, 0)));
    const car = room.cars[0], f = room.fx.cars[0];
    const CREST = { x: 2.3, z: -85.0, heading: 1.559, back: 35, speed: 45 };
    const dx = Math.sin(CREST.heading), dz = Math.cos(CREST.heading);
    place(car, CREST.x - dx * CREST.back, CREST.z - dz * CREST.back, CREST.heading);
    car.vx = dx * CREST.speed; car.vy = dz * CREST.speed;
    let jumped = false;
    for (let i = 0; i < 90 && !jumped; i++) {
      if (f.air === 0 && f.cool <= 0) { car.vx = dx * CREST.speed; car.vy = dz * CREST.speed; }
      room.update(DT);
      jumped = eventsOf(room, 'fxJump').length > 0;
    }
    assert.ok(jumped, 'the crest launches a fast car');
    assert.ok(f.air > 0, 'and it is genuinely airborne');
    const combo = eventsOf(room, 'fxCombo');
    assert.equal(combo.some((e) => e.what === 'JUMP'), true, 'JUMP scores a combo step');
    assert.ok(f.combo >= 1, 'combo is running (' + f.combo + ')');
    const chgBeforeLanding = f.chg;
    for (let i = 0; i < 200 && f.air > 0; i++) { car.vx = dx * CREST.speed; car.vy = dz * CREST.speed; room.update(DT); }
    assert.equal(f.air, 0, 'landed');
    const air = eventsOf(room, 'fxAir');
    assert.equal(air.length >= 1, true, 'the landing is broadcast');
    assert.ok(air[air.length - 1].air > 0, 'with the airtime that earned it');
    assert.ok(f.chg >= chgBeforeLanding, 'airtime and the landing keep adding charge');
  });

  test('a near miss (a pass inside 4.6 m) scores too, and cannot be farmed every tick', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    const { a, b, dx, dz } = abreast(room, 3.5);              // 3.5 m apart across the road
    along(a, { dx, dz }, 30); along(b, { dx, dz }, 30);
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    assert.ok(d > FX.NEAR_D_MIN && d < FX.NEAR_D, 'inside the near-miss band (' + d.toFixed(2) + ' m)');
    room.update(DT);
    const near = eventsOf(room, 'fxCombo').filter((e) => e.what === 'NEAR MISS');
    assert.equal(near.length, 2, 'both racers score the pass');
    for (let i = 0; i < 30; i++) { along(a, { dx, dz }, 30); along(b, { dx, dz }, 30); room.update(DT); }
    const again = eventsOf(room, 'fxCombo').filter((e) => e.what === 'NEAR MISS');
    assert.equal(again.length, 2, 'the same pair cannot farm it inside the cooldown (' + FX.NEAR_CD + ' s)');
  });

  test('higher combo means a stronger next special, and being hit breaks it', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    const f = room.fx.cars[0];
    assert.equal(core.SRFighter._power(f), 1, 'no combo, no bonus');
    f.combo = 4; assert.ok(Math.abs(core.SRFighter._power(f) - 1.32) < 1e-9, '+8% per step');
    f.combo = 50; assert.ok(Math.abs(core.SRFighter._power(f) - (1 + FX.COMBO_POWER_CAP * FX.COMBO_POWER)) < 1e-9, 'the power bonus is capped');
    // the charge-recency bonus: a blow paid for by that skill hits +28% harder
    f.d = f.s = f.a = 0;
    assert.equal(core.SRFighter._bias(f, 'ram'), 1, 'no credit -> no bonus');
    f.s = 12; f.d = 0; f.a = 0;
    assert.ok(Math.abs(core.SRFighter._bias(f, 'ram') - (1 + FX.BIAS_BONUS)) < 1e-9, 'a speed-built charge rams +28% harder');
    f.d = 12; f.s = 0;
    assert.equal(core.SRFighter._bias(f, 'ram'), 1, 'and a drift-built charge gets no ram bonus');
    assert.ok(Math.abs(core.SRFighter._bias(f, 'drift') - (1 + FX.BIAS_BONUS)) < 1e-9, '...it gets the drift bonus instead');
    f.d = f.s = f.a = 0;
    f.combo = 7;
    core.SRFighter._hit(room, room.cars[0], 2, 5, 0, 0, 'ram');
    assert.equal(f.combo, 0, 'a hit resets the combo');
    assert.equal(f.comboT, 0);
  });
});

describe('Fighter Rush — the three attacks', () => {
  test('DRIFT IMPACT: fires while drifting, spends the charge, damages and knocks back nearby rivals', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    const a = room.cars[0], b = room.cars[1], fa = room.fx.cars[0], fb = room.fx.cars[1];
    fa.chg = 100;
    const gap = Math.hypot(a.x - b.x, a.z - b.z);
    assert.ok(gap < FX.DRIFT_R, 'the grid starts the pair inside the shockwave (' + gap.toFixed(1) + ' m)');
    sideways(a, 22, 10);
    const hp0 = fb.hp, vx0 = b.vx, vy0 = b.vy;
    room.setInput(1, { steer: 0.5, throttle: 1, brake: 0, handbrake: true, nitro: false, attack: true });
    room.update(DT);

    const atk = eventsOf(room, 'fxAtk');
    assert.equal(atk.length, 1);
    assert.equal(atk[0].kind, 'drift');
    assert.equal(atk[0].slot, 1);
    assert.equal(atk[0].armed, 0, 'a drift impact happens now, it is not armed for later');
    assert.equal(Math.round(fa.chg), 60, 'it spends exactly one attack worth of charge');
    const hit = eventsOf(room, 'fxHit');
    assert.equal(hit.length, 1, 'one hit event');
    assert.equal(hit[0].slot, 2);
    assert.equal(hit[0].kind, 'drift');
    assert.ok(hit[0].dmg > 0 && hit[0].dmg <= FX.MAX_HIT, 'damage is inside 1..MAX_HIT (' + hit[0].dmg + ')');
    assert.ok(Math.abs((hp0 - fb.hp) - hit[0].dmg) < 1, 'the broadcast damage is the damage that was applied');
    assert.equal(fb.dead, false);
    assert.ok(Math.hypot(b.vx - vx0, b.vy - vy0) > 3, 'the victim is actually pushed by the impulse');
  });

  test('one IMPACT press is one hit, and i-frames stop a second one inside the window', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    const a = room.cars[0], b = room.cars[1], fb = room.fx.cars[1];
    const blow = () => {
      // re-place the pair inside the shockwave each time: a real knockback shoves
      // the victim out of range, which is the whole point of the knockback.
      const d = trackDir(room);
      a.heading = b.heading = d.heading;
      a.x = b.x - d.dx * 3; a.z = b.z - d.dz * 3;
      room.fx.cars[0].chg = 100;
      sideways(a, 18, 10);
      room.setInput(1, { steer: 0.5, throttle: 1, brake: 0, handbrake: true, nitro: false, attack: false });
      room.update(DT);
      room.setInput(1, { steer: 0.5, throttle: 1, brake: 0, handbrake: true, nitro: false, attack: true });
      room.update(DT);
    };
    blow();
    const first = eventsOf(room, 'fxHit');
    assert.equal(first.length, 1, 'the first impact lands');
    const hp1 = fb.hp;
    room.events.length = 0;
    blow();                                                   // immediately again
    assert.equal(eventsOf(room, 'fxHit').length, 0, 'no second hit inside the i-frame window');
    assert.equal(fb.hp, hp1);
    assert.ok(fb.iT > 0, 'the target is still inside i-frames');
    for (let i = 0; i < Math.ceil(FX.I_FRAMES / DT) + 2; i++) { room.update(DT); }
    assert.ok(fb.iT <= 0, 'i-frames expired (' + fb.iT + ')');
    room.events.length = 0;
    blow();
    assert.equal(eventsOf(room, 'fxHit').length, 1, 'and then the target can be hit again');
  });

  test('SPEED RAM: refused below the arm speed, and never a free hit while parked', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    const fa = room.fx.cars[0], fb = room.fx.cars[1];
    fa.chg = 100;
    forward(room.cars[0], 12);                              // too slow to arm
    room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: true });
    room.update(DT);
    assert.equal(eventsOf(room, 'fxAtk').length, 0, 'no attack at 12 m/s');
    const no = eventsOf(room, 'fxNo');
    assert.equal(no.length, 1);
    assert.equal(no[0].why, 'context');
    assert.equal(Math.round(fa.chg), 100, 'a refused attack costs nothing');
    assert.equal(fb.hp, FX.HP);
  });

  test('SPEED RAM: arming, contact, damage, knockback and the charge cost', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    const { a, b, dx, dz } = lineUp(room);
    const fa = room.fx.cars[0], fb = room.fx.cars[1];
    along(b, { dx, dz }, 6); along(a, { dx, dz }, 26);
    fa.chg = 100;
    room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: true });
    room.update(DT);
    const armed = eventsOf(room, 'fxAtk').filter((e) => e.kind === 'ram');
    assert.equal(armed.length, 1, 'a ram was armed');
    assert.equal(armed[0].armed, 1);
    assert.equal(Math.round(fa.chg), 60, 'arming spends the charge');
    assert.ok(fa.ram > 0, 'the ram has a window to land');
    assert.equal(fb.hp, FX.HP, 'no damage before contact');

    const hp0 = fb.hp, vx0 = b.vx, vy0 = b.vy;
    for (let i = 0; i < 30 && !eventsOf(room, 'fxHit').length; i++) {
      along(a, { dx, dz }, 26); along(b, { dx, dz }, 6);
      room.update(DT);
    }
    const hit = eventsOf(room, 'fxHit');
    assert.equal(hit.length, 1, 'contact landed the ram');
    assert.equal(hit[0].kind, 'ram');
    assert.equal(hit[0].by, 1);
    assert.ok(hit[0].dmg > 10, 'a 20 m/s closing speed is a real hit (' + hit[0].dmg + ')');
    assert.ok(hit[0].dmg <= FX.MAX_HIT);
    assert.ok(Math.abs((hp0 - fb.hp) - hit[0].dmg) < 1);
    assert.ok(Math.hypot(b.vx - vx0, b.vy - vy0) > 3, 'knockback applied to the victim');
    assert.equal(fa.ram, 0, 'a landed ram is spent');
    assert.ok(Math.hypot(a.vx, a.vy) < 26, 'ramming costs the rammer speed too');
  });

  test('SPEED RAM damage comes from CLOSING speed, not from raw speed', () => {
    // The rammer is at 26 m/s in every one of these; only the victim's motion
    // changes. MEASURED (see the harness): closing 21.0 -> 31.7 HP, 15.2 -> 20.5,
    // 10.0 -> 10.5, 26.4 -> 40 (the MAX_HIT ceiling).
    const slow = ramSequence(26, 18), mid = ramSequence(26, 12), fast = ramSequence(26, 6), parked = ramSequence(26, 0);
    for (const r of [slow, mid, fast, parked]) assert.equal(r.hit, 1, 'each of these is a real ram');
    assert.ok(slow.dmg < mid.dmg, 'the faster the victim is already going, the less it hurts (' + slow.dmg + ' < ' + mid.dmg + ')');
    assert.ok(mid.dmg < fast.dmg, '(' + mid.dmg + ' < ' + fast.dmg + ')');
    assert.ok(fast.dmg < parked.dmg, '(' + fast.dmg + ' < ' + parked.dmg + ')');
    assert.ok(parked.dmg >= slow.dmg * 3, 'a car that is driving away takes a fraction of the same blow (' + slow.dmg + ' vs ' + parked.dmg + ')');
    assert.ok(Math.abs(parked.hpDrop - parked.dmg) < 1, 'the broadcast damage is the damage applied');
  });

  test('a slow nudge at first contact is not a ram at all', () => {
    // closing 2 m/s: the cars touch, and that touch deals nothing. (The collision
    // response can create a real closing speed afterwards - that is physical, and
    // that hit is a genuine impact.)
    const r = ramSequence(26, 24, { stopAtContact: true });
    assert.ok(r.armed, 'the ram was armed: arming is about speed, landing is about contact');
    assert.ok(r.contactTick >= 0, 'the two cars did touch');
    assert.equal(r.hit, 0, 'touching at 2 m/s deals no damage');
    assert.equal(r.hpDrop, 0);
    assert.equal(r.hp, FX.HP);
  });

  test('SPEED RAM: no single blow is ever more than MAX_HIT, however fast the contact', () => {
    const r = ramSequence(60, 0);
    assert.equal(r.hit, 1);
    assert.equal(r.dmg, FX.MAX_HIT, 'a 60 m/s ram is clamped at ' + FX.MAX_HIT);
    assert.ok(Math.abs(r.hpDrop - FX.MAX_HIT) < 1);
    assert.ok(r.dmg < FX.HP, 'a great ram can never one-shot a full-health car');
    assert.equal(r.hp, FX.HP - FX.MAX_HIT);
  });

  test('AIR SLAM: only arms once genuinely airborne, then hits the landing zone', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    const a = room.cars[0], fa = room.fx.cars[0], fb = room.fx.cars[1];
    fa.chg = 100;
    fa.air = 0.02;                                            // a bump, not airtime
    room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: true });
    room.update(DT);
    assert.equal(eventsOf(room, 'fxAtk').length, 0, 'not enough airtime to be a slam');
    assert.equal(Math.round(fa.chg), 100, 'still nothing spent');
    assert.equal(eventsOf(room, 'fxNo')[0].why, 'context');

    // now genuinely airborne: the launch helper the terrain crest path uses.
    // 14 m/s and a 3 m/s launch arc land the car ~8.5 m down the road, which is
    // still beside the second grid slot - the slam zone has to reach it.
    cleanFighter(room);
    fa.chg = 100;
    const d = trackDir(room);
    a.heading = d.heading;
    along(a, d, 14);
    core.SRFighter._launch(room, a, fa, 3);
    for (let i = 0; i < 5; i++) { along(a, d, 14); room.update(DT); }   // climb past the arm threshold
    assert.ok(fa.air > FX.SLAM_ARM_AIR, 'above the slam threshold (' + fa.air.toFixed(3) + ' s)');
    room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: true });
    room.update(DT);
    const armed = eventsOf(room, 'fxAtk').filter((e) => e.kind === 'air');
    assert.equal(armed.length, 1, 'the slam is armed on the way down');
    assert.equal(armed[0].armed, 1);
    assert.equal(Math.round(fa.chg), 60, 'arming costs the charge');
    assert.equal(fa.slam, true);
    assert.equal(fb.hp, FX.HP, 'nothing is damaged until the wheels touch');

    const hp0 = fb.hp;
    for (let i = 0; i < 300 && fa.air > 0; i++) { along(a, d, 14); room.update(DT); }
    const gap = Math.hypot(a.x - room.cars[1].x, a.z - room.cars[1].z);
    assert.equal(fa.air, 0, 'landed');
    assert.equal(fa.slam, false, 'the slam was consumed by the landing');
    const slam = eventsOf(room, 'fxAtk').filter((e) => e.kind === 'slam');
    assert.equal(slam.length, 1, 'the landing produced an impact zone');
    assert.ok(slam[0].air > 0, 'it reports the airtime that earned it');
    assert.ok(gap < FX.SLAM_R, 'the pair is inside the zone (' + gap.toFixed(1) + ' m of ' + FX.SLAM_R + ')');
    const hit = eventsOf(room, 'fxHit');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].kind, 'slam');
    assert.ok(hit[0].dmg > 0 && hit[0].dmg <= FX.MAX_HIT, 'slam damage ' + hit[0].dmg);
    assert.ok(Math.abs((hp0 - fb.hp) - hit[0].dmg) < 1);
  });

  test('the landing zone damages exactly the cars inside SLAM_R', () => {
    const room = cleanFighter(racing(makeRoom(3, 0)));
    const a = room.cars[0], fa = room.fx.cars[0], fb = room.fx.cars[1], ff = room.fx.cars[2];
    const d = trackDir(room);
    // A landed here: B is 5 m away (inside 8.5 m), C is 20 m away (outside)
    room.cars[1].x = a.x + d.dx * 5; room.cars[1].z = a.z + d.dz * 5;
    room.cars[2].x = a.x + d.dx * 20; room.cars[2].z = a.z + d.dz * 20;
    assert.ok(Math.hypot(a.x - room.cars[1].x, a.z - room.cars[1].z) < FX.SLAM_R);
    assert.ok(Math.hypot(a.x - room.cars[2].x, a.z - room.cars[2].z) > FX.SLAM_R);
    core.SRFighter._slam(room, a, fa, 0.8);
    const hits = eventsOf(room, 'fxHit');
    assert.equal(hits.length, 1, 'only the car inside the zone took damage');
    assert.equal(hits[0].slot, 2);
    assert.equal(hits[0].kind, 'slam');
    assert.equal(ff.hp, FX.HP, 'the car outside the zone is untouched');
    assert.ok(fb.hp < FX.HP, 'the car inside it is not');
    const zones = eventsOf(room, 'fxAtk').filter((e) => e.kind === 'slam');
    assert.equal(zones.length, 1, 'the impact zone is announced');
    assert.equal(zones[0].r, FX.SLAM_R);
  });

  test('the attack that comes out depends on how you are driving, not on a weapon menu', () => {
    const kinds = [];
    // drifting
    let room = cleanFighter(racing(makeRoom(2, 0)));
    room.fx.cars[0].chg = 100; sideways(room.cars[0], 22, 10);
    room.setInput(1, { steer: 0.5, throttle: 1, brake: 0, handbrake: true, nitro: false, attack: true });
    room.update(DT);
    kinds.push(eventsOf(room, 'fxAtk')[0] && eventsOf(room, 'fxAtk')[0].kind);
    // fast and level
    room = cleanFighter(racing(makeRoom(2, 0)));
    room.fx.cars[0].chg = 100; forward(room.cars[0], 30);
    room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: true });
    room.update(DT);
    kinds.push(eventsOf(room, 'fxAtk')[0] && eventsOf(room, 'fxAtk')[0].kind);
    // in the air
    room = cleanFighter(racing(makeRoom(2, 0)));
    room.fx.cars[0].chg = 100; forward(room.cars[0], 30);
    core.SRFighter._launch(room, room.cars[0], room.fx.cars[0], 6);
    for (let i = 0; i < 5; i++) { forward(room.cars[0], 30); room.update(DT); }
    room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: true });
    room.update(DT);
    kinds.push(eventsOf(room, 'fxAtk')[0] && eventsOf(room, 'fxAtk')[0].kind);
    assert.deepEqual(kinds, ['drift', 'ram', 'air']);
  });
});

// ---- Air Slam on the REAL maps -------------------------------------------------
// The slam tests above arm it with the launch helper so the geometry stays pinned.
// These drive a real circuit the way a competent player does - pure pursuit on the
// centreline, full throttle, nitro - and let the map's own crests do the rest. This
// is the whole chain with nothing synthetic in it: terrain launch -> airtime past the
// arming threshold -> a landing zone on the road -> damage.
function pursuit(car, T, lead) {
  const th = T.nearest(car.x, car.z).th;
  const e = 1e-3, p0 = T.ptAt(th), p1 = T.ptAt(th + e);
  const perRad = Math.hypot(p1.x - p0.x, p1.z - p0.z) / e;
  const tgt = T.ptAt(th + lead / Math.max(1e-6, perRad));
  const want = Math.atan2(tgt.x - car.x, tgt.z - car.z);
  let err = want - car.heading;
  while (err > Math.PI) err -= Math.PI * 2; while (err < -Math.PI) err += Math.PI * 2;
  return Math.max(-1, Math.min(1, -err * 2.2));
}
// Drive until a real slam has been landed. The rival shadows the leader 6.5 m across
// the road while it is airborne: inside the 8.5 m impact zone, outside the 3.8 m
// car-to-car contact band, so the ONLY thing that can hurt it is the slam.
function realSlam(mapId, maxTicks) {
  const T = core.MAPS[mapId];
  const room = cleanFighter(racing(makeRoom(2, mapId)));
  const a = room.cars[0], b = room.cars[1], fa = room.fx.cars[0], fb = room.fx.cars[1];
  const out = { jumps: 0, maxAir: 0, armed: null, zone: null, hit: null, preHit: 0 };
  for (let i = 0; i < maxTicks; i++) {
    const press = fa.air > FX.SLAM_ARM_AIR && fa.chg >= FX.COST && !fa.slam;
    const chgBefore = fa.chg;
    room.setInput(1, { steer: pursuit(a, T, 12), throttle: 1, brake: 0, handbrake: false, nitro: true, attack: press });
    room.setInput(2, { steer: 0, throttle: 0, brake: 1, handbrake: true, nitro: false, attack: false });
    room.update(DT);
    if (press && fa.atk === 'air' && out.armedDrop == null) out.armedDrop = chgBefore - fa.chg;
    if (fa.air > out.maxAir) out.maxAir = fa.air;
    if (fa.air > FX.SLAM_ARM_AIR) {
      const th = T.nearest(a.x, a.z).th, n = T.normAt(th);
      b.x = a.x + n.x * 6.5; b.z = a.z + n.z * 6.5; b.vx = b.vy = 0;
    }
    for (const ev of room.events) {
      if (ev.type === 'fxJump') out.jumps++;
      else if (ev.type === 'fxAtk' && ev.kind === 'air' && !out.armed) out.armed = ev;
      else if (ev.type === 'fxAtk' && ev.kind === 'slam' && !out.zone) out.zone = ev;
      else if (ev.type === 'fxHit') { if (out.zone) out.hit = ev; else out.preHit++; }
    }
    room.events.length = 0;
    if (out.hit) break;
  }
  return { a, b, fa, fb, out };
}

describe('Fighter Rush — Air Slam on the real maps', () => {
  test('a racing driver launches off a real crest, arms it in the air and damages the car it lands beside', () => {
    const { fa, fb, out } = realSlam(3, 30 * 100);             // CANYON CHICANE
    assert.ok(out.jumps >= 1, 'a real crest launched the car (' + out.jumps + ' jumps)');
    assert.ok(out.maxAir > FX.SLAM_ARM_AIR, 'with real airtime (' + out.maxAir.toFixed(2) + ' s)');
    assert.ok(out.armed, 'IMPACT pressed in the air armed the slam');
    assert.equal(out.armed.armed, 1);
    assert.ok(out.armedDrop > FX.COST * 0.9, 'and it spent the charge (' + Math.round(out.armedDrop) + ' of ' + FX.COST + ')');
    assert.ok(out.zone, 'the landing produced an impact zone');
    assert.equal(out.zone.r, FX.SLAM_R);
    assert.ok(out.zone.air > 0.3, 'the zone reports the airtime that earned it (' + out.zone.air + ' s)');
    assert.ok(out.hit, 'the car beside the landing was caught by it');
    assert.equal(out.hit.kind, 'slam');
    assert.equal(out.hit.slot, 2);
    assert.ok(out.hit.dmg > 0 && out.hit.dmg <= FX.MAX_HIT, 'slam damage ' + out.hit.dmg);
    // the wire event rounds the damage, the health itself stays exact
    assert.equal(Math.round(fb.hp), FX.HP - out.hit.dmg, 'the broadcast hp matches the blow');
    assert.ok(Math.abs((FX.HP - fb.hp) - out.hit.dmg) < 1, 'and the exact health agrees');
    assert.ok(out.hit.kx || out.hit.kz, 'and it knocked the car sideways');
    assert.equal(out.preHit, 0, 'nothing touched before the slam - the 6.5 m shadow never made contact');
  });

  test('the circuits that launch a car are the circuits a slam can be landed on', () => {
    // Measured with the driver above over two laps at full throttle + nitro:
    //   HIGHLAND RUSH 0 launches; NEON CITY 4 (161-180 km/h) but all under the
    //   arming threshold; ISLAND MOTORFEST 5 (189-198), CANYON CHICANE 7 (189-190)
    //   and HAIRPIN GP 6 (129-189) all give 0.4-0.6 s of air, and a slam landed on
    //   each of those three.
    for (const mapId of [2, 3, 4]) {
      const { out } = realSlam(mapId, 30 * 140);
      assert.ok(out.jumps >= 1, 'map ' + mapId + ' launches a fast car');
      assert.ok(out.maxAir > FX.SLAM_ARM_AIR, 'map ' + mapId + ' gives a slam real airtime (' + out.maxAir.toFixed(2) + ' s)');
    }
  });
});

describe('Fighter Rush — elimination, spectators and the win condition', () => {
  test('0 HP eliminates: the car is dead, the count drops, the event says who is left', () => {
    const room = cleanFighter(racing(makeRoom(3, 0)));
    const bf = room.fx.cars[1];
    room.events.length = 0;
    kill(room, 2);
    assert.equal(bf.dead, true);
    assert.equal(bf.hp, 0);
    assert.equal(room.cars[1].eliminated, true, 'the existing elimination flag is reused');
    assert.equal(room.cars[1].participating, false);
    assert.equal(room.fx.alive, 2, 'three fought, two are left');
    const down = eventsOf(room, 'fxDown');
    assert.equal(down.length, 1);
    assert.equal(down[0].slot, 2);
    assert.equal(down[0].by, 1);
    assert.equal(down[0].left, 2);
    assert.equal(room.state, 'racing', 'the match continues for the others');
    assert.equal(eventsOf(room, 'results').length, 0);
  });

  test('a dead car cannot attack, cannot be finished twice, and rolls to a stop', () => {
    // three cars: killing one must NOT end the match, so the wreck's own tick
    // (masked input + roll-to-a-stop) is actually the thing under test.
    const room = cleanFighter(racing(makeRoom(3, 0)));
    const b = room.cars[2], bf = room.fx.cars[2];
    kill(room, 3);
    assert.equal(room.state, 'racing', 'the fight carries on without it');
    room.events.length = 0;
    bf.chg = 100;
    room.setInput(3, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: true });
    for (let i = 0; i < 90; i++) room.update(DT);
    assert.equal(eventsOf(room, 'fxAtk').length, 0, 'a wreck never attacks');
    assert.equal(eventsOf(room, 'fxHit').length, 0, 'and never damages anyone');
    assert.equal(bf.hp, 0, 'a wreck cannot be pushed below zero');
    const masked = b.input;
    assert.equal(masked.attack, false, 'the server masks a dead racer\'s input');
    assert.equal(masked.throttle, 0, 'and its throttle');
    // the wreck coasts to a stop instead of driving away
    b.vx = 30; b.vy = 30;
    const v0 = Math.hypot(b.vx, b.vy);
    room.update(DT);
    assert.ok(Math.hypot(b.vx, b.vy) < v0, 'the wreck is slowed, not driven');
  });

  test('the last car standing wins, with a fighter results table', () => {
    const room = cleanFighter(racing(makeRoom(3, 0)));
    kill(room, 2);
    kill(room, 3);
    room.update(DT);                                          // _win runs on the tick
    assert.equal(room.fx.alive, 1);
    assert.equal(room.winner, 1);
    assert.equal(room.state, 'finished');
    assert.match(String(room.banner && room.banner.text), /P1 WINS/);
    const res = eventsOf(room, 'results');
    assert.equal(res.length, 1, 'the finishing message goes out once');
    assert.equal(res[0].fighter, 1, 'and it is flagged as a fighter result');
    const order = res[0].order;
    assert.equal(order.length, 3, 'every fighter is in the table');
    assert.equal(order[0].slot, 1, 'the survivor is first');
    assert.equal(order[0].dead, 0);
    assert.equal(order[0].hp, 100);
    assert.equal(order[1].slot, 3, 'the last one eliminated is the best of the dead');
    assert.equal(order[2].slot, 2);
    for (const r of order) assert.equal(r.fighter, 1);
    assert.equal(room.fx.alive, 1);
  });

  test('a room that empties (disconnect) cannot hang: the survivor wins on the next tick', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    room.cars[1].participating = false;                        // the rival's socket dropped
    room.update(DT);
    assert.equal(room.fx.alive, 1);
    assert.equal(room.winner, 1);
    assert.equal(room.state, 'finished');
  });

  test('a dead fighter is still broadcast, flagged, so screens can show the spectator view', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    kill(room, 2);
    const s = room.snapshot();
    const b = s.cars.find((c) => c.s === 2);
    assert.ok(b, 'the wreck is still in the stream');
    assert.equal(b.fx.dead, 1);
    assert.equal(b.fx.hp, 0);
    assert.equal(s.fm.alive, 1);
  });
});

describe('Fighter Rush — isolation from every other mode', () => {
  const OTHERS = ['race', 'coop', 'elim', 'drift'];

  test('an attack flag in a non-fighter room does nothing at all', () => {
    for (const mode of OTHERS) {
      const room = cleanFighter(racing(makeRoom(3, 0, mode)));
      for (let i = 0; i < 90; i++) {
        room.setInput(1, { steer: 0.3, throttle: 1, brake: 0, handbrake: i % 3 === 0, nitro: true, attack: true });
        room.setInput(2, { steer: -0.2, throttle: 1, brake: 0, handbrake: false, nitro: false, attack: true });
        room.update(DT);
      }
      assert.equal(room.fx, null, mode + ': no fighter state was ever created');
      const fighterEvents = ['fxAtk', 'fxHit', 'fxDown', 'fxNo', 'fxCombo', 'fxJump', 'fxAir']
        .reduce((n, t) => n + eventsOf(room, t).length, 0);
      assert.equal(fighterEvents, 0, mode + ': no fighter event was emitted');
      const s = room.snapshot();
      assert.equal(s.fm, undefined, mode + ': no fm on the wire');
      assert.ok(isFinite(room.cars[0].lap) && room.cars[0].lap >= 0, mode + ': lap logic still sane');
      assert.ok(room.cars.every((c) => isFinite(c.x) && isFinite(c.forwardSpeed())), mode + ': physics still finite');
      const keys = Object.keys(s.cars[0]);
      for (const k of ['fx', 'hp', 'ch', 'cb', 'rd', 'dead']) assert.equal(keys.includes(k), false, mode + ': car key ' + k + ' leaked');
    }
  });

  test('fighter driving does not change the ordinary race lifecycle', () => {
    // the same 6 s of driving in a race room and in a fighter room: position,
    // speed, lap, progress and drift score must agree tick for tick.
    const drive = (room) => {
      const trail = [];
      for (let i = 0; i < 180; i++) {
        room.setInput(1, { steer: Math.sin(i / 20) * 0.25, throttle: 1, brake: 0, handbrake: i % 40 > 34, nitro: i % 2 === 0, attack: i % 7 === 0 });
        room.setInput(2, { steer: -0.1, throttle: 0.7, brake: 0, handbrake: false, nitro: false, attack: true });
        room.update(DT);
        const c = room.cars[0];
        trail.push([Math.round(c.x * 1000), Math.round(c.z * 1000), Math.round(c.forwardSpeed() * 1000), c.lap, Math.round(c.progress * 1000), Math.round(c.driftScore * 1000)]);
      }
      return trail;
    };
    const raceTrail = drive(cleanFighter(racing(makeRoom(3, 0, 'race'))));
    const fightTrail = drive(cleanFighter(racing(makeRoom(3, 0, 'fighter'))));
    const diverge = fightTrail.findIndex((row, i) => JSON.stringify(row) !== JSON.stringify(raceTrail[i]));
    assert.equal(diverge, -1, 'car 1 drove identically in both modes' + (diverge >= 0 ? ' (first difference at tick ' + diverge + ')' : ''));
  });

  test('a fighter room cannot be created by an unknown mode name', () => {
    const room = new core.RaceRoom('X1', 'fighterish', 0, 2);
    assert.equal(room.mode, 'race');
    assert.equal(room.fx, null);
    assert.equal(core.SRFighter.isActive(room), false);
  });
});

describe('Fighter Rush — robustness', () => {
  test('600 ticks of chaotic combat never produce a non-finite or out-of-range value', () => {
    const room = racing(makeRoom(4, 1));
    for (let i = 0; i < 600; i++) {
      for (const c of room.cars) {
        room.setInput(c.slot, {
          steer: Math.sin(i / 7 + c.slot) * 1.5, throttle: i % 5 === 0 ? -1 : 1, brake: i % 11 === 0 ? 1 : 0,
          handbrake: i % 13 === 0, nitro: true, attack: i % 17 === 0
        });
      }
      room.update(DT);
      const s = room.snapshot();
      for (const c of s.cars) {
        for (const k of ['x', 'z', 'h', 'v', 'sl', 'p']) assert.ok(Number.isFinite(c[k]), 'car.' + k + ' finite at tick ' + i);
        assert.ok(Number.isFinite(c.fx.hp) && c.fx.hp >= 0 && c.fx.hp <= 100, 'hp in range');
        assert.ok(Number.isFinite(c.fx.ch) && c.fx.ch >= 0 && c.fx.ch <= 100, 'charge in range');
        assert.ok(c.fx.cb >= 0);
      }
      assert.ok(s.fm.alive >= 0 && s.fm.alive <= 4, 'alive count in range');
    }
    assert.ok(room.fx.alive <= 4);
  });

  test('a wipe leaves no winner instead of a bogus one', () => {
    const room = cleanFighter(racing(makeRoom(2, 0)));
    kill(room, 1, 0);
    kill(room, 2, 0);
    room.winner = 5;                                          // pretend a stale winner is set
    room.update(DT);
    assert.equal(room.fx.alive, 0, 'everyone is out');
    assert.equal(room.winner, null, 'nobody left -> no winner');
    assert.match(String(room.banner && room.banner.text), /NO SURVIVORS|DRAW/);
  });

  test('the tuning table is inside sane bounds', () => {
    assert.ok(FX.HP > 0 && FX.COST > 0 && FX.COST < FX.HP);
    assert.ok(FX.MAX_HIT > 0 && FX.MAX_HIT <= FX.HP, 'a blow can never exceed a full health bar');
    assert.ok(FX.RAM_MIN_REL > 0 && FX.RAM_K > 0);
    assert.ok(FX.SLAM_R > 0 && FX.DRIFT_R > 0 && FX.RAM_R > 0);
    assert.ok(FX.I_FRAMES > 0 && FX.COMBO_MAX > FX.COMBO_POWER_CAP);
  });
});
