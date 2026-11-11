'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/game-core.js');
const DT = 1 / 30;
function liveRoom() {
  const r = new core.RaceRoom('WEAP1', 'fighter', 0, 2);
  r.setSeat(1, true); r.setSeat(2, true);
  r.start(); for (let i = 0; i < 95; i++) r.update(DT);
  return r;
}
describe('Fighter Rush authoritative weapons and Shield', () => {
  test('weapons/pickups are Fighter-only and published in the fighter snapshot', () => {
    const r = liveRoom(), s = r.snapshot();
    assert.equal(s.fm.pickups.length, 10);
    assert.deepEqual(Object.keys(core.SRFighter.WEAPONS).sort(), ['machinegun', 'mine', 'rocket', 'shockwave']);
    const normal = new core.RaceRoom('RACE1', 'race', 0, 2).snapshot();
    assert.equal(normal.fm, undefined);
  });
  test('pickup grants one weapon slot and another type replaces it', () => {
    const r = liveRoom(), car = r.cars[0], f = r.fx.cars[0];
    for (const [kind, ammo] of [['rocket', 3], ['mine', 2]]) {
      const p = r.fx.pickups.find((x) => x.kind === kind);
      p.active = true; car.x = p.x; car.z = p.z;
      core.SRFighter._powerups(r, car, f, DT);
      assert.equal(f.weapon, kind); assert.equal(f.ammo, ammo);
    }
  });
  test('rocket fires on a tap and projectile damage is server-authoritative', () => {
    const r = liveRoom(), car = r.cars[0], f = r.fx.cars[0], target = r.cars[1];
    f.weapon = 'rocket'; f.ammo = 3;
    target.x = car.x + Math.sin(car.heading) * 10; target.z = car.z + Math.cos(car.heading) * 10;
    r.setInput(1, { weapon: true }); r.setInput(1, { weapon: false }); r.applyInputs();
    core.SRFighter._powerups(r, car, f, DT);
    assert.equal(f.ammo, 2); assert.equal(r.fx.projectiles.length, 1);
    const hp = r.fx.cars[1].hp;
    for (let i = 0; i < 40; i++) core.SRFighter._projectiles(r, DT);
    assert.ok(r.fx.cars[1].hp < hp);
  });
  test('machine gun auto-fires at its server cooldown while held', () => {
    const r = liveRoom(), car = r.cars[0], f = r.fx.cars[0];
    f.weapon = 'machinegun'; f.ammo = 30;
    r.setInput(1, { weapon: true });
    let previous = f.ammo;
    for (let i = 0; i < 12; i++) { r.applyInputs(); core.SRFighter._powerups(r, car, f, DT); }
    assert.ok(f.ammo < previous);
    assert.ok(r.fx.projectiles.length > 1);
  });
  test('shield is activated by ability input and blocks damage', () => {
    const r = liveRoom(), car = r.cars[0], f = r.fx.cars[0];
    r.setInput(1, { ability: true }); r.applyInputs();
    core.SRFighter._powerups(r, car, f, DT);
    assert.ok(f.shieldT > 0);
    const hp = f.hp;
    core.SRFighter._hit(r, car, 2, 30, 1, 1, 'test');
    assert.equal(f.hp, hp);
    assert.ok(r.events.some((e) => e.type === 'fxBlocked'));
  });
  test('combat messages do not activate in ordinary race mode', () => {
    const r = new core.RaceRoom('RACE2', 'race', 0, 2);
    r.setInput(1, { weapon: true, ability: true, attack: true });
    assert.equal(r.inputs[1].weapon, false);
    assert.equal(r.inputs[1].ability, false);
    assert.equal(r.inputs[1].attack, false);
  });
});
