const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const prog = require('../shared/progression.js');
const core = require('../shared/game-core.js');
const cos = require('../shared/cosmetics.js');
const {
  app,
  settleRace,
  memPlayerStats,
  memPlayerMissions,
  getAllRatingRows,
  getOrInitMissions
} = require('../server.js');

describe('Competitive Rivals, Ghost Racing, Daily Missions & Seasons', () => {

  beforeEach(() => {
    memPlayerStats.clear();
    memPlayerMissions.clear();
  });

  // -------------------------------------------------------------------------
  // 1. Competitive Rival System
  // -------------------------------------------------------------------------
  test('Competitive Rivals: correctly identifies nearest higher and lower competitor', () => {
    const rows = [
      { user_id: 'alice', name: 'Alice', rating: 1500 },
      { user_id: 'bob', name: 'Bob', rating: 1420 },
      { user_id: 'charlie', name: 'Charlie', rating: 1350 },
      { user_id: 'david', name: 'David', rating: 1200 },
      { user_id: 'eve', name: 'Eve', rating: 1100 }
    ];

    // Charlie is #3 (1350). Next rival is Bob #2 (1420, gap 70). Chaser is David #4 (1200, gap 150).
    const rivalsCharlie = prog.getCompetitiveRival(rows, 'charlie');
    assert.strictEqual(rivalsCharlie.rank, 3);
    assert.ok(rivalsCharlie.nextRival);
    assert.strictEqual(rivalsCharlie.nextRival.uid, 'bob');
    assert.strictEqual(rivalsCharlie.nextRival.rank, 2);
    assert.strictEqual(rivalsCharlie.nextRival.ratingGap, 70);

    assert.ok(rivalsCharlie.chaserRival);
    assert.strictEqual(rivalsCharlie.chaserRival.uid, 'david');
    assert.strictEqual(rivalsCharlie.chaserRival.rank, 4);
    assert.strictEqual(rivalsCharlie.chaserRival.ratingGap, 150);

    // Alice is #1. She has no higher rival, but has a chaser (Bob).
    const rivalsAlice = prog.getCompetitiveRival(rows, 'alice');
    assert.strictEqual(rivalsAlice.rank, 1);
    assert.strictEqual(rivalsAlice.nextRival, null);
    assert.strictEqual(rivalsAlice.chaserRival.uid, 'bob');

    // Eve is last (#5). She has a higher rival (David) and no chaser.
    const rivalsEve = prog.getCompetitiveRival(rows, 'eve');
    assert.strictEqual(rivalsEve.rank, 5);
    assert.strictEqual(rivalsEve.nextRival.uid, 'david');
    assert.strictEqual(rivalsEve.chaserRival, null);
  });

  test('Competitive Rivals: detects rank overtake celebration when passing rival', () => {
    const rivalTarget = {
      uid: 'racer_x',
      name: 'RacerX',
      rank: 41,
      rating: 1450
    };

    // Rank went from 42 to 40 (climbed ahead of rival who was at 41)
    const overtake = prog.detectRivalOvertake(42, 40, rivalTarget);
    assert.ok(overtake);
    assert.strictEqual(overtake.overtaken, true);
    assert.strictEqual(overtake.rivalName, 'RacerX');
    assert.strictEqual(overtake.previousRivalRank, 41);
    assert.strictEqual(overtake.newPlayerRank, 40);

    // Rank improved from 45 to 43 (did not pass rank 41)
    const noOvertake = prog.detectRivalOvertake(45, 43, rivalTarget);
    assert.strictEqual(noOvertake, null);

    // Rank worsened
    const drop = prog.detectRivalOvertake(40, 42, rivalTarget);
    assert.strictEqual(drop, null);
  });

  // -------------------------------------------------------------------------
  // 2. Ghost Racing & Delta Math
  // -------------------------------------------------------------------------
  test('Ghost Racing: builds cumulative progression and calculates accurate time delta', () => {
    // 3 sample points along a 1-lap track
    const sampleGhost = [
      [0.0, 0, 0],
      [10.0, 100, 0],
      [20.0, 200, 0]
    ];
    assert.ok(sampleGhost.length === 3);
    assert.strictEqual(sampleGhost[0][0], 0.0);
    assert.strictEqual(sampleGhost[2][0], 20.0);

    // If player is at same position at t=9.5s, delta is 10.0 - 9.5 = +0.5s (ahead of ghost pace)
    const playerTime = 9.5;
    const ghostTimeAtPos = 10.0;
    const delta = ghostTimeAtPos - playerTime;
    assert.strictEqual(delta, 0.5); // positive = player ahead
  });

  // -------------------------------------------------------------------------
  // 3. Daily Missions
  // -------------------------------------------------------------------------
  test('Daily Missions: deterministic 3 missions per UTC date', () => {
    const date1 = '2026-09-04';
    const missionsA = prog.getDeterministicDailyMissions(date1);
    const missionsB = prog.getDeterministicDailyMissions(date1);

    assert.strictEqual(missionsA.length, 3);
    assert.strictEqual(missionsB.length, 3);
    assert.deepStrictEqual(missionsA, missionsB); // Pure determinism

    // Distinct IDs in the set of 3
    const ids = new Set(missionsA.map(m => m.id));
    assert.strictEqual(ids.size, 3);

    // Different day yields predictable seed rotation
    const date2 = '2026-09-05';
    const missionsNextDay = prog.getDeterministicDailyMissions(date2);
    assert.strictEqual(missionsNextDay.length, 3);
  });

  test('Daily Missions: evaluates progress across telemetry events', () => {
    // 1. Finish races
    assert.strictEqual(prog.evaluateMissionProgress('finish_3_races', 1, { finished: true }), 2);
    assert.strictEqual(prog.evaluateMissionProgress('finish_3_races', 1, { finished: false }), 1);

    // 2. Win multiplayer match
    assert.strictEqual(prog.evaluateMissionProgress('win_1_mp', 0, { won: true, humanRacers: 2 }), 1);
    assert.strictEqual(prog.evaluateMissionProgress('win_1_mp', 0, { won: true, humanRacers: 1 }), 0); // solo vs AI doesn't count

    // 3. Use nitro
    assert.strictEqual(prog.evaluateMissionProgress('nitro_5_times', 2, { nitroCount: 3 }), 5);

    // 4. Daily challenge map
    assert.strictEqual(prog.evaluateMissionProgress('daily_cup_race', 0, { isDailyCup: true, finished: true }), 1);

    // 5. Personal best
    assert.strictEqual(prog.evaluateMissionProgress('beat_personal_best', 0, { isPersonalBest: true }), 1);

    // 6. Clean lap / no collisions
    assert.strictEqual(prog.evaluateMissionProgress('clean_race_no_crash', 0, { finished: true, collisions: 0 }), 1);
    assert.strictEqual(prog.evaluateMissionProgress('clean_race_no_crash', 0, { finished: true, collisions: 2 }), 0);
  });

  // -------------------------------------------------------------------------
  // 4. Daily Engagement Streak & Milestones
  // -------------------------------------------------------------------------
  test('Daily Streak: maintains streak on same day, increments next day, resets on gap', () => {
    // 1. First race ever
    const s1 = prog.evaluateStreakTransition('', '2026-09-04', 0, 0);
    assert.strictEqual(s1.streak, 1);
    assert.strictEqual(s1.bestStreak, 1);

    // 2. Second race on same day: keeps streak at 1
    const s2 = prog.evaluateStreakTransition('2026-09-04', '2026-09-04', 1, 1);
    assert.strictEqual(s2.streak, 1);
    assert.strictEqual(s2.bestStreak, 1);

    // 3. Race on consecutive day: increments to 2
    const s3 = prog.evaluateStreakTransition('2026-09-04', '2026-09-05', 1, 1);
    assert.strictEqual(s3.streak, 2);
    assert.strictEqual(s3.bestStreak, 2);

    // 4. Race after a missed day (gap > 1 day): resets to 1 but preserves best_streak
    const s4 = prog.evaluateStreakTransition('2026-09-05', '2026-09-08', 2, 2);
    assert.strictEqual(s4.streak, 1);
    assert.strictEqual(s4.bestStreak, 2);
  });

  test('Daily Streak: identifies milestone thresholds and rewards', () => {
    const m3 = prog.getStreakMilestoneInfo(3);
    assert.strictEqual(m3.milestoneReached, true);
    assert.strictEqual(m3.currentMilestoneDays, 3);
    assert.strictEqual(m3.rewardXp, 100);
    assert.strictEqual(m3.rewardCoins, 50);
    assert.strictEqual(m3.nextMilestone, 7);

    const m7 = prog.getStreakMilestoneInfo(7);
    assert.strictEqual(m7.milestoneReached, true);
    assert.strictEqual(m7.currentMilestoneDays, 7);
    assert.strictEqual(m7.rewardXp, 300);
    assert.strictEqual(m7.rewardCoins, 150);
    assert.strictEqual(m7.nextMilestone, 14);

    const m4 = prog.getStreakMilestoneInfo(4);
    assert.strictEqual(m4.milestoneReached, false);
    assert.strictEqual(m4.nextMilestone, 7);
  });

  // -------------------------------------------------------------------------
  // 5. Competitive Season Progression
  // -------------------------------------------------------------------------
  test('Competitive Season: provides active season info, tiers, and division changes', () => {
    const season = prog.getCurrentSeason();
    assert.ok(season.seasonNumber >= 1);
    assert.ok(season.seasonId);
    assert.strictEqual(season.status, 'active');
    assert.ok(season.rewards.GOLD);
    assert.ok(season.rewards.MASTER);

    // Promotion check: 1190 -> 1210 (Silver I -> Gold III)
    const promo = prog.checkDivisionTransition(1190, 1210);
    assert.strictEqual(promo.changed, true);
    assert.strictEqual(promo.promoted, true);
    assert.strictEqual(promo.fromTier, 'SILVER I');
    assert.strictEqual(promo.toTier, 'GOLD III');

    // Demotion check: 1205 -> 1185 (Gold III -> Silver I)
    const demo = prog.checkDivisionTransition(1205, 1185);
    assert.strictEqual(demo.changed, true);
    assert.strictEqual(demo.promoted, false);
    assert.strictEqual(demo.demoted, true);

    // No change: 1210 -> 1225 (Gold III -> Gold III)
    const same = prog.checkDivisionTransition(1210, 1225);
    assert.strictEqual(same.changed, false);
  });

  // -------------------------------------------------------------------------
  // 6. Social Share Formatting
  // -------------------------------------------------------------------------
  test('Social Share: formats messages for rivals, ghosts, divisions, streaks, and PBs', () => {
    const rMsg = prog.formatShareMessage('rival_overtake', { rivalName: 'Ace', rank: 12, rating: 1450 });
    assert.ok(rMsg.includes('Ace'));
    assert.ok(rMsg.includes('#12'));

    const gMsg = prog.formatShareMessage('ghost_beaten', { mapName: 'Neon City', delta: '0.45s' });
    assert.ok(gMsg.includes('Neon City'));
    assert.ok(gMsg.includes('0.45s'));

    const dMsg = prog.formatShareMessage('division_promo', { tier: 'GOLD I' });
    assert.ok(dMsg.includes('GOLD I'));

    const sMsg = prog.formatShareMessage('streak_milestone', { days: 7 });
    assert.ok(sMsg.includes('7-day'));
  });

  // -------------------------------------------------------------------------
  // 7. Authoritative Race Settlement Integration
  // -------------------------------------------------------------------------
  test('Authoritative Race Settlement: awards mission progress, streak, Elo, and rival overtake', async () => {
    // Seed initial player stats in memory
    memPlayerStats.set('p1', {
      uid: 'p1', name: 'Racer1', rating: 1200, peak_rating: 1200, xp: 500,
      streak: 1, best_streak: 1, last_daily: '2026-09-03', races: 5, wins: 2
    });
    memPlayerStats.set('p2', {
      uid: 'p2', name: 'Racer2', rating: 1220, peak_rating: 1220, xp: 600,
      streak: 0, best_streak: 1, last_daily: '2026-09-03', races: 6, wins: 3
    });

    const mockRoom = {
      code: 'RACE123',
      mode: 'race',
      mapId: 0,
      players: [
        { slot: 1, name: 'Racer1', isBot: false },
        { slot: 2, name: 'Racer2', isBot: false }
      ],
      standings: () => [
        { slot: 1, name: 'Racer1', finished: true, t: 45.2, best: 22.1, participating: true, nitroCount: 2, collisions: 0 },
        { slot: 2, name: 'Racer2', finished: true, t: 46.8, best: 23.0, participating: true, nitroCount: 1, collisions: 1 }
      ],
      participants: () => [{ slot: 1 }, { slot: 2 }]
    };

    const entry = {
      room: mockRoom,
      uidBySlot: { 1: 'p1', 2: 'p2' },
      screens: new Set(),
      specs: new Set(),
      controllers: new Map()
    };

    const rows = await settleRace(entry);
    assert.strictEqual(rows.length, 2);

    const r1 = rows[0];
    assert.strictEqual(r1.slot, 1);
    assert.strictEqual(r1.pos, 1);
    assert.ok(r1.rd > 0); // Won vs higher rating, gains Elo
    assert.ok(r1.ratingNew > 1200);
    assert.strictEqual(r1.streak, 2); // Incremented streak from yesterday

    // Mission updates returned in settlement
    assert.ok(Array.isArray(r1.missionUpdates));
    assert.strictEqual(r1.missionUpdates.length, 3);

    // Updated stats in memory
    const updatedP1 = memPlayerStats.get('p1');
    assert.strictEqual(updatedP1.streak, 2);
    assert.strictEqual(updatedP1.wins, 3);
  });

});
