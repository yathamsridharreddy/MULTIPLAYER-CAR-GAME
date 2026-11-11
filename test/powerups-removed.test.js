'use strict';
// Fighter Rush pickups are intentional; these regressions verify server authority
// and isolation from ordinary race modes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const core = require('../shared/game-core.js');

test('server and browser simulations remain byte-identical', () => {
  assert.equal(read('public/js/game-core.js'), read('shared/game-core.js'));
});
test('Fighter Rush alone exposes authoritative pickups and inventory', () => {
  const r = new core.RaceRoom('FTRP1', 'fighter', 0, 2);
  r.setSeat(1, true); r.setSeat(2, true); assert.equal(r.start(), true);
  for (let i = 0; i < 95; i++) r.update(1 / 30);
  const snap = r.snapshot();
  assert.equal(snap.fm.pickups.length, 10);
  assert.ok(snap.fm.pickups.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)));
  assert.ok(r.fx.cars.every((f) => f.weapon === '' && f.ammo === 0));
});
test('ordinary races have no Fighter Rush state or combat events', () => {
  const r = new core.RaceRoom('RACE1', 'race', 0, 2);
  r.setController(1, true); r.setController(2, true); r.start();
  for (let i = 0; i < 120; i++) r.update(1 / 30);
  assert.equal(r.fx, null); assert.equal(r.snapshot().fm, undefined);
  assert.equal(r.events.some((e) => String(e.type).startsWith('fx')), false);
});
test('all five tracks remain drivable and finite in ordinary races', () => {
  for (let mapId = 0; mapId < 5; mapId++) {
    const r = new core.RaceRoom('DRV' + mapId, 'race', mapId, 2);
    r.setController(1, true); r.setController(2, true);
    r.setInput(1, { throttle: 1 }); assert.equal(r.start(), true);
    let top = 0;
    for (let i = 0; i < 420; i++) { r.update(1 / 30); top = Math.max(top, r.cars[0].speedKmh());
      for (const c of r.cars) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.heading)); }
    assert.equal(r.state, 'racing'); assert.ok(top > 60);
  }
});
test('nitro remains functional in ordinary races', () => {
  const run = (nitro) => { const r = new core.RaceRoom('NTR' + nitro, 'race', 0, 2); r.setController(1, true); r.setInput(1, { throttle: 1, nitro }); r.start(); let top = 0; for (let i = 0; i < 420; i++) { r.update(1 / 30); top = Math.max(top, r.cars[0].speedKmh()); } return top; };
  assert.ok(core.CFG.nitroAccel > 0); assert.ok(run(true) > run(false));
});
test('build marker agrees across client assets, worker and server', () => {
  const build = (read('public/js/game.js').match(/const BUILD = '(v\d+)'/) || [])[1];
  assert.ok(build);
  const newest = (read('README.md').match(/^- \*\*(v\d+)\*\* —/m) || [])[1];
  assert.equal(newest, build);
  assert.equal((read('public/js/audio.js').match(/const BUILD = '(v\d+)'/) || [])[1], build);
  assert.equal((read('public/sw.js').match(/const CACHE = 'sridhar-rush-(v\d+)'/) || [])[1], build);
  assert.equal((read('server.js').match(/build: '(v\d+)'/) || [])[1], build);
});
