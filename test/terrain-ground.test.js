// The car must drive ON the ground the player sees.
//
// THE BUG THIS PINS. build3DTerrain() draws Map 0 as a PlaneGeometry(1600,1600,140,140)
// - one height per grid point, flat triangles in between - while the car's visual Y came
// from the analytic heightfield, blended from the road to the terrain over 6 units
// where the drawn terrain blends over 26. Beside the track the two disagree by metres:
// measured on Map 0, 28% of the map had the car BELOW the ground it was drawn on, worst
// case 3.79 m, which is what "the car is fully hiding below the grass" looks like.
//
// This test builds the REAL geometry with the vendored three.js and the REAL
// CORE.getTerrainHeight, feeds it to the real buildTerrainSample(), and then asks the
// real getSurfaceY() where the car would be - for every map, over the whole drivable
// area. Two independent ways of knowing the drawn ground are used: an exact
// index-buffer barycentric lookup (the renderer's own triangles) and the sampler's
// closed form.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GAME = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game.js'), 'utf8');
const CORE = require(path.join(ROOT, 'shared', 'game-core.js'));
const THREE = require(path.join(ROOT, 'public', 'js', 'vendor', 'three.min.js'));

let client = null;   // the client's own functions, extracted below
function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' must exist in game.js');
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}

// the client's own functions, running against the real core
client = new Function('CORE', 'RH', [
  extractFn(GAME, 'buildTerrainSample'),
  extractFn(GAME, 'drawnGroundY'),
  extractFn(GAME, 'getSurfaceY'),
  'return { buildTerrainSample, drawnGroundY, getSurfaceY, sample: () => terrainSample };'
].join('\n'))(CORE, CORE.CFG.roadHalf);

// the exact mesh build3DTerrain draws - same numbers, read from its source, so this
// test follows the mesh if the resolution is ever changed
const meshConsts = GAME.match(/const W = (\d+), H = (\d+), SEGS = (\d+);/);
assert.ok(meshConsts, 'build3DTerrain declares its plane size');
const W = Number(meshConsts[1]), SEGS = Number(meshConsts[3]);

function drawnGeometry(map) {
  const geo = new THREE.PlaneGeometry(W, W, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, CORE.getTerrainHeight(map, pos.getX(i), pos.getZ(i)));
  return geo;
}

// the drawn ground, straight out of the renderer's own index buffer - no shared
// assumption with drawnGroundY()
function groundFromIndexBuffer(geo, x, z) {
  const pos = geo.attributes.position, idx = geo.index.array;
  for (let t = 0; t < idx.length; t += 3) {
    const p0 = idx[t], p1 = idx[t + 1], p2 = idx[t + 2];
    const ax = pos.getX(p0), az = pos.getZ(p0);
    const bx = pos.getX(p1), bz = pos.getZ(p1);
    const cx = pos.getX(p2), cz = pos.getZ(p2);
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue;
    const l0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const l1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const l2 = 1 - l0 - l1;
    if (l0 >= -1e-9 && l1 >= -1e-9 && l2 >= -1e-9) {
      return l0 * pos.getY(p0) + l1 * pos.getY(p1) + l2 * pos.getY(p2);
    }
  }
  return null;
}

// the track's own parameter at a point - spline maps read it from nearest(), not atan2
function trackAt(map, x, z) {
  return (map.type === 'spline' && map.nearest) ? map.nearest(x, z).th : Math.atan2(z, x);
}
function roadPoint(map, th, off) {
  if (map.type === 'spline' && map.point) return map.point(th, off);
  return CORE.radialDistToTrack(Math.cos(th), Math.sin(th), map.a, map.b);
}
function ribbonY(map, x, z) { return CORE.getTrackElevation(map, trackAt(map, x, z)) + 0.08; }

function latDistOf(map, x, z) {
  if (map.type === 'spline' && map.nearest) return Math.abs(map.nearest(x, z).d);
  return Math.abs(CORE.radialDistToTrack(x, z, map.a, map.b).d);
}

test('the car is never below the ground it is drawn on (every map, whole drivable area)', () => {
  for (const map of CORE.MAPS) {
    const geo = drawnGeometry(map);
    client.buildTerrainSample(geo);
    assert.ok(client.sample(), 'the terrain grid feeds the client sampler');
    let checked = 0, worst = -Infinity, worstAt = null, nan = 0;
    const R = 700, N = 220;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = -R + (2 * R * i) / N, z = -R + (2 * R * j) / N;
        const ground = client.drawnGroundY(x, z);
        if (ground == null) continue;
        const car = client.getSurfaceY(map, x, z);
        checked++;
        if (!Number.isFinite(car)) { nan++; continue; }
        const buried = ground - car;             // > 0: the drawn ground is above the car
        if (buried > worst) { worst = buried; worstAt = [x.toFixed(1), z.toFixed(1)]; }
      }
    }
    assert.ok(checked > 40000, 'sampled the map: ' + checked);
    assert.equal(nan, 0, 'no NaN surface heights');
    assert.ok(worst <= 1e-6, `map ${map.id}: the car is buried by ${worst.toFixed(2)} m at ${worstAt}`);
  }
});

test('off the road the car sits exactly on the drawn ground', () => {
  const map = CORE.MAPS[0];                       // HIGHLAND RUSH - the reported map
  const geo = drawnGeometry(map);
  client.buildTerrainSample(geo);
  const RH = CORE.CFG.roadHalf;
  let checked = 0;
  // the band that was worst before the fix, plus the open field
  for (let lat = RH + 2.0; lat <= 40; lat += 0.7) {
    for (let th = 0; th < Math.PI * 2; th += 0.01) {
      const rad = roadPoint(map, th, 0);
      const scale = (rad.re + lat) / Math.max(1e-6, rad.re);
      const x = Math.cos(th) * scale * rad.re, z = Math.sin(th) * scale * rad.re;
      if (latDistOf(map, x, z) < RH + 1.2) continue;   // the kerb ramp is checked below
      const car = client.getSurfaceY(map, x, z);
      const ground = client.drawnGroundY(x, z);
      if (ground == null) continue;
      checked++;
      assert.ok(Math.abs(car - ground) < 1e-6,
        `at ${x.toFixed(1)},${z.toFixed(1)} the car is ${(car - ground).toFixed(3)} m off the drawn grass`);
    }
  }
  assert.ok(checked > 5000, 'sampled the grass: ' + checked);
});

test('on the road the car rides the asphalt ribbon', () => {
  for (const map of CORE.MAPS) {
    const geo = drawnGeometry(map);
    client.buildTerrainSample(geo);
    const RH = CORE.CFG.roadHalf;
    for (let th = 0; th < Math.PI * 2; th += 0.02) {
      const x = (map.a - 2) * Math.cos(th), z = (map.b - 2) * Math.sin(th);   // 2 m inside the road edge
      if (latDistOf(map, x, z) > RH) continue;
      const car = client.getSurfaceY(map, x, z);
      const ribbon = ribbonY(map, x, z);
      // On the asphalt the car sits on the ribbon, except where the coarse terrain
      // beside the road interpolates a little ABOVE it - and there the car rides the
      // ground, because the ground is what is drawn. Either way it is never under a
      // surface the player can see.
      const expected = Math.max(ribbon, client.drawnGroundY(x, z));
      assert.ok(Math.abs(car - expected) < 1e-6,
        `map ${map.id}: car ${car.toFixed(3)} vs the visible surface ${expected.toFixed(3)} at ${x.toFixed(0)},${z.toFixed(0)}`);
      assert.ok(car >= ribbon - 1e-6,
        `map ${map.id}: the car sank ${(ribbon - car).toFixed(3)} m under the asphalt at ${x.toFixed(0)},${z.toFixed(0)}`);
    }
  }
});

test('the sampler agrees with the renderer triangle for triangle', () => {
  const map = CORE.MAPS[0];
  const geo = drawnGeometry(map);
  client.buildTerrainSample(geo);
  let checked = 0;
  const rnd = CORE.mulberry32(20261002);
  for (let k = 0; k < 4000; k++) {
    const x = (rnd() * 2 - 1) * 600, z = (rnd() * 2 - 1) * 600;
    const mine = client.drawnGroundY(x, z);
    const theirs = groundFromIndexBuffer(geo, x, z);
    if (mine == null || theirs == null) continue;
    checked++;
    assert.ok(Math.abs(mine - theirs) < 1e-4,
      `at ${x.toFixed(2)},${z.toFixed(2)}: sampler ${mine.toFixed(4)} vs the renderer's triangle ${theirs.toFixed(4)}`);
  }
  assert.ok(checked > 3900, 'checked ' + checked);
});

test('outside the terrain, and before it is built, nothing invents a height', () => {
  const map = CORE.MAPS[0];
  const geo = drawnGeometry(map);
  client.buildTerrainSample(geo);
  assert.equal(client.drawnGroundY(-900, 0), null, 'west of the plane');
  assert.equal(client.drawnGroundY(0, 900), null, 'south of the plane');
  // before the grid exists the analytic field is still answered (no NaN, no crash)
  const before = new Function('CORE', 'RH', [extractFn(GAME, 'drawnGroundY'), extractFn(GAME, 'getSurfaceY'),
    'return (m, x, z) => getSurfaceY(m, x, z);'].join('\n'))(CORE, CORE.CFG.roadHalf);
  const y = before(map, 0, 0);
  assert.ok(Number.isFinite(y), 'a finite surface height before the terrain exists: ' + y);
});

test('this is a real difference, not a rounding one (why the test exists)', () => {
  // What the client used to do: blend from the road to the ANALYTIC field over 6 units
  // starting at RH + 1.2, ignoring the mesh the player is looking at.
  const map = CORE.MAPS[0];
  const geo = drawnGeometry(map);
  client.buildTerrainSample(geo);
  const RH = CORE.CFG.roadHalf;
  const oldFormula = (x, z) => {
    const lat = latDistOf(map, x, z);
    const yRoad = ribbonY(map, x, z);
    if (lat <= RH + 1.2) return yRoad;
    const yTerr = CORE.getTerrainHeight(map, x, z);
    const t = Math.min(1, (lat - (RH + 1.2)) / 6.0);
    const w = t * t * (3 - 2 * t);
    return (1 - w) * yRoad + w * yTerr;
  };
  let worst = 0, worstAt = null;
  for (let i = 0; i < 200; i++) {
    for (let j = 0; j < 200; j++) {
      const x = -400 + 800 * (i / 200), z = -400 + 800 * (j / 200);
      const ground = client.drawnGroundY(x, z);
      if (ground == null) continue;
      const d = Math.max(ground, CORE.getTerrainHeight(map, x, z)) - oldFormula(x, z);
      if (d > worst) { worst = d; worstAt = [x.toFixed(1), z.toFixed(1)]; }
    }
  }
  assert.ok(worst > 1.0,
    `the old placement put the car ${worst.toFixed(2)} m under the drawn ground at ${worstAt} on Map 0`);
});
