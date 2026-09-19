'use strict';
/* ============================================================================
   Client render-loop guards.

   The browser render code in public/js/game.js is not runnable under Node
   (WebGL, DOM), but its snapshot interpolator is pure maths over a buffer, so
   we lift the REAL function out of game.js and exercise it here.

   Regression locked by this file: after v91's EXIT ROOM, `mySlot` becomes 0
   while the buffer can still hold the previous room's snapshots. The old code
   did `snap.cars[slot - 1].x` on a missing car and threw
   "Cannot read properties of undefined (reading 'x')", which killed the
   requestAnimationFrame loop and froze the whole game behind the lobby.
   ========================================================================== */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- lift interpState() out of the shipped client, brace-matched -----------
function extractInterpState() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/game.js'), 'utf8');
  const start = src.indexOf('function interpState(slot) {');
  assert.ok(start !== -1, 'interpState must exist in public/js/game.js');
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, 'interpState body must be balanced');
  return src.slice(start, end);
}

// --- run it with the same module-scope helpers game.js provides ------------
function makeHarness() {
  const sandbox = {
    performance: { now: () => 0 },
    INTERP_DELAY: 120,
    interpDelay: 120,
    snaps: [],
    snapGaps: [],
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    lerp: (a, b, t) => a + (b - a) * t,
    lerpAngle: (a, b, t) => {
      let d = b - a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return a + d * t;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractInterpState() + '\n;globalThis.__interp = interpState;', sandbox);
  return sandbox;
}

const car = (slot, x) => ({ s: slot, x, z: 0, h: 0, v: 10, sl: 0, st: 0, th: 0, n: 0, m: 0, lap: 0, ll: null, best: null, fin: false, ft: null, p: 1, pr: x, col: 0, dc: 0 });

describe('Client Snapshot Interpolator Guards', () => {
  it('returns null instead of throwing for a slot absent from every buffered snapshot', () => {
    const h = makeHarness();
    // exactly the EXIT ROOM crash: two-car room buffered, then the lobby slot 0
    h.snaps.push({ t: -200, snap: { cars: [car(1, 10), car(2, 20)] } });
    h.snaps.push({ t: -100, snap: { cars: [car(1, 11), car(2, 21)] } });

    assert.doesNotThrow(() => h.__interp(0), 'slot 0 must not throw on a stale room buffer');
    assert.equal(h.__interp(0), null);
    assert.doesNotThrow(() => h.__interp(6), 'an empty seat must not throw either');
    assert.equal(h.__interp(6), null);
  });

  it('still dead-reckons a present slot when only one snapshot is buffered', () => {
    const h = makeHarness();
    h.performance.now = () => 0;
    // heading pi/2 -> velocity points along +x; v = 10
    h.snaps.push({ t: -200, snap: { cars: [Object.assign(car(1, 100), { h: Math.PI / 2 })] } });
    const out = h.__interp(1);
    assert.ok(out, 'an existing slot must interpolate');
    // target = -120ms, snapshot at -200ms -> extra = 80ms of dead-reckoning
    assert.ok(Math.abs(out.x - 100.8) < 1e-6, 'must extrapolate along the heading, got ' + out.x);
    assert.equal(out.s, 1);
  });

  it('blends between two snapshots the same way as before the hardening', () => {
    // snapshot().cars is always a fixed 6-seat array (cars.map over every seat,
    // s: c.slot), so slots 1-6 always resolve; only slot 0 has no car.
    const h = makeHarness();
    h.performance.now = () => 0;
    const seats = (x1, x2) => {
      const cs = [];
      for (let s = 1; s <= 6; s++) cs.push(car(s, s === 1 ? x1 : s === 2 ? x2 : 0));
      return cs;
    };
    h.snaps.push({ t: -200, snap: { cars: seats(50, 60) } });
    h.snaps.push({ t: -50, snap: { cars: seats(80, 61) } });
    const out = h.__interp(1);
    assert.ok(out);
    // target = -120ms -> alpha = 80/150 = 0.5333; x = lerp(50, 80, a) = 66
    assert.ok(Math.abs(out.x - 66) < 1e-6, 'expected 66, got ' + out.x);
    assert.equal(out.s, 1);
    assert.equal(h.__interp(0), null, 'slot 0 is not a car in the wire format');
  });

  it('returns null on an empty buffer and on snapshots newer than the target', () => {
    const h = makeHarness();
    assert.equal(h.__interp(1), null);

    const h2 = makeHarness();
    h2.snaps.push({ t: 50, snap: { cars: [car(1, 7)] } }); // arrives after the interp target
    assert.equal(h2.__interp(0), null, 'missing slot on the ai < 0 path must be null');
    assert.equal(h2.__interp(1).x, 7, 'present slot on the ai < 0 path still interpolates');
  });
});
