const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const cos = require('../shared/cosmetics.js');

describe('Garage Cosmetics & Economy System', () => {
  test('maintains catalog integrity across all item categories', () => {
    assert.equal(cos.CARS.length, 6);
    assert.equal(cos.PAINTS.length, 8);
    assert.equal(cos.WHEELS.length, 4);
    assert.equal(cos.TRAILS.length, 4);
    assert.equal(cos.DECALS.length, 6);
    assert.equal(cos.NEONS.length, 4);

    // Verify each car has required properties
    for (const car of cos.CARS) {
      assert.ok(car.id);
      assert.ok(car.name);
      assert.ok(car.rarity);
      assert.ok(car.unlock);
      assert.ok(Array.isArray(car.bars));
    }

    // Default starter items should be free
    assert.equal(cos.CARS[0].unlock.t, 'free');
    assert.equal(cos.PAINTS[0].unlock.t, 'free');
    assert.equal(cos.WHEELS[0].unlock.t, 'free');
    assert.equal(cos.TRAILS[0].unlock.t, 'free');
    assert.equal(cos.DECALS[0].unlock.t, 'free');
    assert.equal(cos.NEONS[0].unlock.t, 'free');
  });

  test('validates unlock criteria for level, wins, rating, and achievements', () => {
    const neonFang = cos.CARS.find((c) => c.id === 'neon_fang'); // Level 5
    assert.equal(cos.itemUnlocked(neonFang.unlock, { level: 4 }), false);
    assert.equal(cos.itemUnlocked(neonFang.unlock, { level: 5 }), true);

    const desertFox = cos.CARS.find((c) => c.id === 'desert_fox'); // Wins 10
    assert.equal(cos.itemUnlocked(desertFox.unlock, { wins: 9 }), false);
    assert.equal(cos.itemUnlocked(desertFox.unlock, { wins: 10 }), true);

    const nightFury = cos.CARS.find((c) => c.id === 'night_fury'); // Rating 1200
    assert.equal(cos.itemUnlocked(nightFury.unlock, { rating: 1199 }), false);
    assert.equal(cos.itemUnlocked(nightFury.unlock, { rating: 1200 }), true);

    const rushDecal = cos.DECALS.find((d) => d.id === 5); // Ach first_blood
    assert.equal(cos.itemUnlocked(rushDecal.unlock, { ach: [] }), false);
    assert.equal(cos.itemUnlocked(rushDecal.unlock, { ach: ['first_blood'] }), true);
  });

  test('coin-purchasable items require inventory ownership in player profile', () => {
    const pearlPaint = cos.PAINTS.find((p) => p.name === 'PEARL'); // 300 coins
    assert.equal(cos.isCoinItem(pearlPaint.unlock), true);

    // Unowned coin item is locked
    assert.equal(cos.itemUnlocked(pearlPaint.unlock, { owned: [] }, 'paint:6'), false);

    // Owned coin item is unlocked
    assert.equal(cos.itemUnlocked(pearlPaint.unlock, { owned: ['paint:6'] }, 'paint:6'), true);

    const fireTrail = cos.TRAILS.find((t) => t.name === 'FIRE'); // 800 coins
    assert.equal(cos.itemUnlocked(fireTrail.unlock, { owned: ['paint:6'] }, 'trail:3'), false);
    assert.equal(cos.itemUnlocked(fireTrail.unlock, { owned: ['trail:3'] }, 'trail:3'), true);
  });

  test('formats unlock criteria labels and coin values clearly', () => {
    assert.equal(cos.unlockText({ t: 'free' }), 'FREE');
    assert.equal(cos.unlockText({ t: 'level', v: 8 }), 'LEVEL 8');
    assert.equal(cos.unlockText({ t: 'wins', v: 25 }), 'WIN 25 RACES');
    assert.equal(cos.unlockText({ t: 'league', v: 1350 }), 'REACH 1350 RATING');
    assert.equal(cos.unlockText({ t: 'coins', v: 500 }), '🪙 500');
  });

  test('provides correct default fallback when querying unknown car id', () => {
    const defaultCar = cos.findCar('non_existent_car_id');
    assert.equal(defaultCar.id, 'street_runner');

    const knownCar = cos.findCar('volt_gt');
    assert.equal(knownCar.id, 'volt_gt');
  });
});
