'use strict';
// v175: the power-up system was removed on purpose. These tests exist so the
// removal cannot silently rot (half a feature left behind) and so nothing else
// was taken with it - the five circuits must still be drivable and nitro, the
// boost the PLAYER holds on purpose, must still work.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const core = require('../shared/game-core.js');

const SIM = read('shared/game-core.js');
const CLIENT_SIM = read('public/js/game-core.js');
const GAME = read('public/js/game.js');
const INDEX = read('public/index.html');

test('v175: the power-up system is gone from the authoritative simulation', () => {
  for (const token of ['pickup', 'puTick', 'puCollect', 'puB', 'puSh', 'puS', 'pickupSpots', 'pickupFracs']) {
    assert.equal(SIM.includes(token), false, `game-core.js still mentions ${token}`);
  }
  assert.equal(core.pickupSpots, undefined, 'pickupSpots must not be exported any more');
  assert.equal(Object.keys(core).includes('pickupSpots'), false);
});

test('v175: the browser copy of the sim matches the server copy byte for byte', () => {
  assert.equal(CLIENT_SIM, SIM, 'public/js/game-core.js is generated from shared/game-core.js');
});

test('v175: a room carries no power-up state and the wire carries no power-up fields', () => {
  const room = new core.RaceRoom('NOPWR1', 'race', 0, 4);
  assert.equal('pickups' in room, false, 'no pickup list on the room');
  const car = room.cars[0];
  for (const k of ['puB', 'puS', 'puSh']) assert.equal(k in car, false, `car still has ${k}`);
  room.setController(1, true);
  room.start();
  for (let t = 0; t < 120; t++) room.update(1 / 30);
  const snap = room.snapshot();
  assert.equal('pu' in snap, false, 'the snapshot must not publish a pickup string');
  assert.equal(snap.events.some((e) => e.type === 'pu'), false, 'no pu events may be emitted');
  for (const c of snap.cars) {
    for (const k of ['pb', 'ps', 'pl']) assert.equal(k in c, false, `car entry still has ${k}`);
  }
});

test('v175: every circuit is still drivable after the layout data lost its pickup fractions', () => {
  for (let mapId = 0; mapId < 5; mapId++) {
    const room = new core.RaceRoom('DRV' + mapId, 'race', mapId, 2);
    room.setController(1, true);
    room.setController(2, true);
    for (const s of [1, 2]) room.setInput(s, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: 0 });
    room.start();
    let top = 0;
    for (let t = 0; t < 420; t++) {
      room.update(1 / 30);
      top = Math.max(top, room.cars[0].speedKmh());
      for (const c of room.cars) {
        assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.heading), `map ${mapId} went non-finite`);
      }
    }
    assert.equal(room.state, 'racing', `map ${mapId} never reached racing`);
    assert.ok(top > 60, `map ${mapId}: a full-throttle car only reached ${top.toFixed(1)} km/h`);
  }
});

test('v175: nitro (the boost the player holds on purpose) is untouched and still faster', () => {
  assert.ok(core.CFG.nitroAccel > 0 && core.CFG.nitroDrain > 0 && core.CFG.nitroCapBonus > 0, 'nitro tuning must survive');
  const run = (nitro) => {
    const room = new core.RaceRoom('NTR' + nitro, 'race', 0, 2);
    room.setController(1, true);
    room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro });
    room.start();
    let top = 0;
    for (let t = 0; t < 420; t++) { room.update(1 / 30); top = Math.max(top, room.cars[0].speedKmh()); }
    return top;
  };
  const withNitro = run(1);
  const without = run(0);
  assert.ok(withNitro > without, `nitro must still add speed (${withNitro.toFixed(1)} vs ${without.toFixed(1)} km/h)`);
  assert.ok(withNitro > 150, 'a nitro run must still be quick');
});

test('v175: the client no longer builds, animates, announces or displays power-ups', () => {
  for (const token of ['puMeshes', 'pickupSpots', 'pu-chip', 'ptype', 'CORE.getTerrainHeight(map, sp.x']) {
    assert.equal(GAME.includes(token), false, `game.js still mentions ${token}`);
  }
  assert.equal(INDEX.includes('pu-chip'), false, 'the HUD slot is gone');
  assert.ok(INDEX.includes('id="gear"'), 'the rest of the speed read-out must stay');
  assert.ok(INDEX.includes('id="speed-sub"'));
  // the pickup toast was the only 'pu' protocol handler on the client
  assert.equal(/case 'pu':/.test(GAME), false);
});

test('v175: the geometry fingerprint no longer counts power-ups', () => {
  const geomBlock = SIM.slice(SIM.indexOf('const GEOM_ID = (function'), SIM.indexOf('return (h >>> 0).toString(36)'));
  assert.equal(geomBlock.includes('p: 3'), false, 'the power-up term is gone from the fingerprint');
  assert.match(core.GEOM_ID, /^[0-9a-z]+$/, 'GEOM_ID still hashes to something usable');
  // a changed GEOM_ID is what makes an old cached client reload against a new server
  assert.notEqual(core.GEOM_ID, '', 'GEOM_ID must not be empty');
});

test('v175: the removal is documented and the version moved with it', () => {
  const readme = read('README.md');
  assert.match(readme, /- \*\*v175\*\* — the power-ups are gone/);
  const build = (GAME.match(/const BUILD = '(v\d+)'/) || [])[1];
  // v176: the version moved again, so this asserts the intent instead of the digit -
  // the marker must have advanced past v175, the newest README entry must be that
  // same version, and every caching surface must agree with it.
  const newest = (readme.match(/^- \*\*(v\d+)\*\* —/m) || [])[1];
  assert.notEqual(build, 'v175', 'the client changed, so returning users must be sent a new build');
  assert.equal(newest, build, 'the newest README entry documents the build that ships');
  const audio = read('public/js/audio.js');
  assert.equal((audio.match(/const BUILD = '(v\d+)'/) || [])[1], build);
  assert.equal((read('public/sw.js').match(/const CACHE = 'sridhar-rush-(v\d+)'/) || [])[1], build);
  assert.equal((read('server.js').match(/build: '(v\d+)'/) || [])[1], build);
});
