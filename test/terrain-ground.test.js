// The car must drive ON the ground the player sees.
//
// THE BUG THIS PINS. build3DTerrain() draws the world as a PlaneGeometry: one height
// per grid point, flat triangles in between - while the car's visual Y came from the
// analytic heightfield, blended from the road to the terrain over 6 units where the
// drawn terrain blends over 26. Beside the track the two disagree by metres: measured on
// Map 0, 28% of the map had the car BELOW the ground it was drawn on, worst case 3.79 m,
// which is what "the car is fully hiding below the grass" looks like.
//
// THE V168 SIDE OF THE SAME COIN. "Never below the ground" is only right OFF the road.
// On Map 0 the drawn terrain climbs metres above the asphalt where the road is a
// cutting, and the coarse mesh used to hang over the outer lane; a car placed with the
// max() rule therefore got lifted up the bank and looked off the road - the reported
// "the car is going down the road". So: ON the asphalt the ribbon is the surface, off
// it the drawn ground is, and the barrier keeps the whole car on the asphalt.
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
  // v168: the ellipse reads the angle of the FOOT of the perpendicular, which is where
  // ribbon3D takes the road's height - not the angle of the point itself.
  if (map.type === 'spline' && map.nearest) return map.nearest(x, z).th;
  const pr = CORE.ellipseProj(x, z, map.a, map.b);
  return Math.atan2(pr.cz, pr.cx);
}
function roadPoint(map, th, off) {
  if (map.type === 'spline' && map.point) return map.point(th, off);
  return CORE.radialDistToTrack(Math.cos(th), Math.sin(th), map.a, map.b);
}
// a point 'lat' metres to one side of the centreline, along the track's own normal
function lateralPoint(map, th, side, lat) {
  if (map.type === 'spline' && map.point) return map.point(th, side * lat);
  const k = Math.hypot(Math.cos(th) / map.a, Math.sin(th) / map.b);
  const nx = (Math.cos(th) / map.a) / k, nz = (Math.sin(th) / map.b) / k;
  return { x: map.a * Math.cos(th) + side * nx * lat, z: map.b * Math.sin(th) + side * nz * lat };
}
function ribbonY(map, x, z) { return CORE.getTrackElevation(map, trackAt(map, x, z)) + 0.08; }

function latDistOf(map, x, z) {
  // v168: the ellipse measures lateral distance with the projection the barrier clamp
  // uses, not the ray from the centre (they differ by metres near the diagonals).
  if (map.type === 'spline' && map.nearest) return Math.abs(map.nearest(x, z).d);
  return Math.abs(CORE.ellipseProj(x, z, map.a, map.b).lat);
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
      // off the road, past the shoulder ramp, the car sits exactly on the drawn ground
      assert.ok(Math.abs(car - ground) < 1e-6,
        `at ${x.toFixed(1)},${z.toFixed(1)} the car is ${(car - ground).toFixed(3)} m off the drawn grass`);
    }
  }
  assert.ok(checked > 5000, 'sampled the grass: ' + checked);
});

test('ON THE ROAD the car rides the asphalt, not the bank beside it (v168)', () => {
  // v164 made the car take max(drawn ground, ribbon) everywhere. That is right where the
  // ground is what is drawn. It is wrong ON the road: the terrain mesh is coarse, so
  // beside a cutting or an embankment it can interpolate metres above the asphalt, and
  // the max() then lifted the car up the grass - "the car is going down the road" from
  // the driver's seat. On the ribbon the car must ride the ribbon.
  for (const map of CORE.MAPS) {
    const geo = drawnGeometry(map);
    client.buildTerrainSample(geo);
    const RH = CORE.CFG.roadHalf;
    let checked = 0, worst = 0, worstAt = null;
    for (let th = 0; th < Math.PI * 2; th += 0.01) {
      for (const side of [1, -1]) {
        for (const lat of [0, RH / 2, RH - 0.2]) {
          const pt = lateralPoint(map, th, side, lat);
          if (latDistOf(map, pt.x, pt.z) > RH) continue;        // on the asphalt
          const car = client.getSurfaceY(map, pt.x, pt.z);
          const road = ribbonY(map, pt.x, pt.z);                // what the ribbon drew here
          const d = Math.abs(car - road);
          checked++;
          if (d > worst) { worst = d; worstAt = 'lat ' + lat.toFixed(1) + ' at ' + th.toFixed(2); }
        }
      }
    }
    assert.ok(checked > 600, 'sampled the asphalt on map ' + map.id + ': ' + checked);
    // a few centimetres is the ribbon itself: it is drawn as a chord between two
    // stations while this reference is the analytic elevation at the point. What must
    // never happen is the metres of lift the coarse terrain mesh used to add.
    assert.ok(worst < 0.06,
      'map ' + map.id + ': the car rides ' + worst.toFixed(3) + ' m off the asphalt (' + worstAt + ')');
  }
});

test('MAP 0: the whole drivable width - asphalt AND shoulder out to the fence - is level (v169)', () => {
  // The reported bug twice over. First the ground between the asphalt and the fence was a
  // bank (metres above the road at a cutting, metres below it at an embankment), so a car
  // out there climbed the grass or dropped behind the kerb. v168 answered that by moving
  // the limit in to the asphalt edge - which is not the fix either: the fence is the
  // barrier the player can see, and the car has to be able to use the strip up to it.
  // The fix is the ground: the terrain's flat corridor now covers the full drivable width
  // (getTerrainHeight: RH + 9 for the ellipse), so asphalt, kerb line, grass shoulder and
  // the ground the fence stands on are all at the road's own height.
  const map = CORE.MAPS[0];
  const geo = drawnGeometry(map);
  client.buildTerrainSample(geo);
  const RH = CORE.CFG.roadHalf;
  const fenceInner = RH + 3.65 - 0.25;          // the wall box is 0.5 wide, centred there
  assert.ok(map.limP <= fenceInner,
    'MAP 0: the nose stops inside the drawn fence (limP ' + map.limP + ' vs inner face ' + fenceInner + ')');
  assert.ok(map.limP > fenceInner - 0.5,
    'MAP 0: and it really reaches the fence, not the middle of the road (limP ' + map.limP + ')');
  let checked = 0, worstCar = 0, worstUp = 0, worstDown = 0, atCar = null, atDown = null;
  for (let i = 0; i < 1440; i++) {
    const th = i / 1440 * Math.PI * 2;
    for (const side of [1, -1]) {
      for (let lat = 0; lat < fenceInner; lat += 0.25) {
        const pt = lateralPoint(map, th, side, lat);
        const latNow = latDistOf(map, pt.x, pt.z);
        if (latNow > fenceInner) continue;
        const road = ribbonY(map, pt.x, pt.z);
        const grass = client.drawnGroundY(pt.x, pt.z);
        if (grass == null) continue;
        checked++;
        const car = Math.abs(client.getSurfaceY(map, pt.x, pt.z) - road);
        if (car > worstCar) { worstCar = car; atCar = 'lat ' + latNow.toFixed(1) + ' at ' + (th * 180 / Math.PI).toFixed(0) + 'deg'; }
        const up = grass - road;                     // > 0: grass drawn above the road
        if (up > worstUp) worstUp = up;
        const down = road - grass;                   // > 0: ground below the road level
        if (down > worstDown) { worstDown = down; atDown = 'lat ' + latNow.toFixed(1) + ' at ' + (th * 180 / Math.PI).toFixed(0) + 'deg'; }
      }
    }
  }
  assert.ok(checked > 25000, 'sampled the drivable width: ' + checked);
  assert.ok(worstUp < 0.05, 'the grass never rises above the road inside the drivable width (worst +' + worstUp.toFixed(2) + ' m)');
  assert.ok(worstDown < 0.35,
    'the ground never dives below the road inside the drivable width (worst ' + worstDown.toFixed(2) + ' m at ' + atDown + ')');
  assert.ok(worstCar < 0.25,
    'the car rides the road over the whole width (worst ' + worstCar.toFixed(2) + ' m at ' + atCar + ')');
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
