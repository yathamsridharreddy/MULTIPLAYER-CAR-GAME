const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const prog = require('../shared/progression.js');

describe('Progression Math & Authoritative Settlement', () => {
  test('calculates correct level, XP progression, and level spans', () => {
    // Level 1: 0 XP
    const lv1 = prog.levelFromXp(0);
    assert.equal(lv1.level, 1);
    assert.equal(lv1.cur, 0);
    assert.equal(lv1.span, 100);
    assert.equal(lv1.pct, 0);

    // Level 2: 100 XP -> span = 250 - 100 = 150
    const lv2 = prog.levelFromXp(100);
    assert.equal(lv2.level, 2);
    assert.equal(lv2.cur, 0);
    assert.equal(lv2.span, 150);

    // Level 2 midpoint: 175 XP -> 75 / 150 = 50%
    const lv2Mid = prog.levelFromXp(175);
    assert.equal(lv2Mid.level, 2);
    assert.equal(lv2Mid.cur, 75);
    assert.equal(lv2Mid.pct, 50);

    // Level 5: 700 XP (startOf(5) = 25 * 4 * 7 = 700)
    const lv5 = prog.levelFromXp(700);
    assert.equal(lv5.level, 5);
  });

  test('calculates race XP with finish, podium, and win bonuses', () => {
    // DNF gives 0 XP
    assert.equal(prog.xpForRace(false, 1, 2), 0);

    // 1st place in 2-player race: finish(100) + podium(100) + win(150) = 350 XP
    assert.equal(prog.xpForRace(true, 1, 2), 350);

    // 2nd place in 4-player race: finish(100) + podium(100) = 200 XP
    assert.equal(prog.xpForRace(true, 2, 4), 200);

    // 4th place in 6-player race: finish(100) = 100 XP
    assert.equal(prog.xpForRace(true, 4, 6), 100);
  });

  test('computes Elo delta symmetrically with K-factor scaling', () => {
    // Equal ratings: 1000 vs 1000 -> win yields +16, loss yields -16
    const winEqual = prog.eloDelta(1000, 1000, 1);
    const lossEqual = prog.eloDelta(1000, 1000, 0);
    assert.equal(winEqual, 16);
    assert.equal(lossEqual, -16);

    // High rating beating low rating: 1400 vs 1000 -> win yields smaller gain
    const winFavored = prog.eloDelta(1400, 1000, 1);
    assert.ok(winFavored < 10, 'Favored player should gain fewer rating points');

    // Underdog beating favorite: 1000 vs 1400 -> win yields larger gain
    const winUnderdog = prog.eloDelta(1000, 1400, 1);
    assert.ok(winUnderdog > 25, 'Underdog should gain large rating boost');
  });

  test('maps rating to league tiers and divisions accurately', () => {
    const bronze = prog.tier(1000);
    assert.equal(bronze.name, 'BRONZE III');

    const silver = prog.tier(1100);
    assert.equal(silver.name, 'SILVER III');

    const gold = prog.tier(1200);
    assert.equal(gold.name, 'GOLD III');

    const diamond = prog.tier(1550);
    assert.ok(diamond.name.startsWith('DIAMOND'));

    const master = prog.tier(1750);
    assert.equal(master.name, 'MASTER');
    assert.equal(master.next, null);
  });

  test('validates server-computed achievements triggers', () => {
    const achMap = {};
    for (const a of prog.ACHIEVEMENTS) achMap[a.id] = a;

    // First blood triggers at 1 win
    assert.equal(achMap.first_blood.test({ wins: 0 }), false);
    assert.equal(achMap.first_blood.test({ wins: 1 }), true);

    // Hot streak triggers at 3 streak
    assert.equal(achMap.hot_streak.test({ streak: 2 }), false);
    assert.equal(achMap.hot_streak.test({ streak: 3 }), true);

    // World tour triggers at 5 distinct maps
    assert.equal(achMap.world_tour.test({ mapsPlayed: 4 }), false);
    assert.equal(achMap.world_tour.test({ mapsPlayed: 5 }), true);

    // Climber triggers at peak rating >= 1100
    assert.equal(achMap.climber.test({ peak_rating: 1099 }), false);
    assert.equal(achMap.climber.test({ peak_rating: 1100 }), true);
  });

  test('validates username sanitization and character restrictions', () => {
    assert.equal(prog.validUsername('SpeedRacer'), true);
    assert.equal(prog.validUsername('pro_123'), true);
    assert.equal(prog.validUsername('ab'), false, 'Too short (< 3 chars)');
    assert.equal(prog.validUsername('toolongusernamethatisnotvalid'), false, 'Too long (> 16 chars)');
    assert.equal(prog.validUsername('bad user!'), false, 'Special chars / spaces rejected');
  });
});
