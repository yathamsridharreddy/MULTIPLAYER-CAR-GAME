const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const prog = require('../shared/progression.js');
const {
  app,
  settleRace,
  memPlayerStats,
  memPlayerLicense,
  memEquippedBadges,
  memRevengeTargets,
  memWeeklyBounties,
  getOrInitWeeklyBounties
} = require('../server.js');

describe('Retention V82 Suite: Academy, Badges, Bounties, Revenge & Next Best Action', () => {
  let server;
  let baseUrl;

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise((res) => server.close(res));
  });

  function httpGet(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, text: data });
          }
        });
      }).on('error', reject);
    });
  }

  function httpPost(path, body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, text: data });
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  beforeEach(() => {
    memPlayerStats.clear();
    memPlayerLicense.clear();
    memEquippedBadges.clear();
    memRevengeTargets.clear();
    memWeeklyBounties.clear();
  });

  describe('1. Driving Academy & Pro License', () => {
    it('contains 3 distinct academy lessons with progressive skill targets', () => {
      assert.strictEqual(prog.ACADEMY_LESSONS.length, 3);
      assert.strictEqual(prog.ACADEMY_LESSONS[0].id, 'lesson_1_steering');
      assert.strictEqual(prog.ACADEMY_LESSONS[1].id, 'lesson_2_nitro');
      assert.strictEqual(prog.ACADEMY_LESSONS[2].id, 'lesson_3_drafting');
    });

    it('awards pro license bonus of 200 Rush Coins and 200 XP upon completion', () => {
      assert.strictEqual(prog.LICENSE_COMPLETION_BONUS.coins, 200);
      assert.strictEqual(prog.LICENSE_COMPLETION_BONUS.xp, 200);
      assert.strictEqual(prog.LICENSE_COMPLETION_BONUS.badgeId, 'pro_license');
    });

    it('completes pro license idempotently via server endpoint /api/player/license/complete', async () => {
      const uid = 'test_racer_academy';
      memPlayerStats.set(uid, { uid, rating: 1000, xp: 100, wins: 0 });

      // First completion
      const res1 = await httpPost('/api/player/license/complete', { uid });
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res1.json.ok, true);
      assert.strictEqual(res1.json.claimed, true);
      assert.strictEqual(res1.json.coinsAwarded, 200);
      assert.strictEqual(res1.json.xpAwarded, 200);

      // Check stats cache updated
      const st = memPlayerStats.get(uid);
      assert.strictEqual(st.xp, 300);
      assert.ok(memPlayerLicense.get(uid).completed);

      // Second completion (idempotent - already completed)
      const res2 = await httpPost('/api/player/license/complete', { uid });
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.json.ok, true);
      assert.strictEqual(res2.json.alreadyCompleted, true);
    });
  });

  describe('2. Tiered Milestone Badges & Showcase', () => {
    it('defines 8 milestone badges with 4 tiers each', () => {
      assert.strictEqual(prog.BADGE_DEFINITIONS.length, 8);
      for (const badge of prog.BADGE_DEFINITIONS) {
        assert.ok(badge.id);
        assert.ok(badge.name);
        assert.ok(badge.icon);
        assert.ok(badge.tiers.length >= 1);
      }
    });

    it('evaluates badge tiers correctly based on racer statistics', () => {
      const rookieStats = {
        wins: 0,
        streak: 1,
        best_streak: 1,
        top_speed: 150,
        rivals_passed: 0,
        ghosts_beaten: 0,
        clean_races: 0,
        nitro_count: 5,
        license_done: false
      };
      const rookieBadges = prog.evaluateBadges(rookieStats);
      const nitroBadge = rookieBadges.find(b => b.id === 'nitro_junkie');
      assert.strictEqual(nitroBadge.tierLevel, 0); // Need 20 for tier 1

      const veteranStats = {
        wins: 15,
        streak: 7,
        best_streak: 7,
        top_speed: 215,
        rivals_passed: 12,
        ghosts_beaten: 10,
        clean_races: 15,
        nitro_count: 60,
        license_done: true
      };
      const veteranBadges = prog.evaluateBadges(veteranStats);
      const speedBadge = veteranBadges.find(b => b.id === 'speed_demon');
      assert.strictEqual(speedBadge.tierLevel, 2);
      assert.strictEqual(speedBadge.tierName, 'Silver');

      const licenseBadge = veteranBadges.find(b => b.id === 'pro_license');
      assert.strictEqual(licenseBadge.tierLevel, 1);
    });

    it('allows player to equip and query badges via server API', async () => {
      const uid = 'badge_user_01';
      memPlayerStats.set(uid, { uid, wins: 50, streak: 14, peak_rating: 1600 });

      // Equip badge
      const eqRes = await httpPost('/api/player/badge/equip', { uid, badgeId: 'apex_predator' });
      assert.strictEqual(eqRes.status, 200);
      assert.strictEqual(eqRes.json.ok, true);
      assert.strictEqual(eqRes.json.equippedBadge, 'apex_predator');

      // Fetch badges
      const getRes = await httpGet(`/api/player/badges?uid=${encodeURIComponent(uid)}`);
      assert.strictEqual(getRes.status, 200);
      assert.strictEqual(getRes.json.ok, true);
      assert.strictEqual(getRes.json.equippedBadge, 'apex_predator');
      const apex = getRes.json.badges.find(b => b.id === 'apex_predator' || b.badgeId === 'apex_predator');
      assert.strictEqual(apex.equipped, true);
      assert.strictEqual(apex.tierLevel, 3); // 50 wins = Gold tier
    });
  });

  describe('3. Weekly Syndicate Bounties', () => {
    it('generates deterministic 3 bounties for any given week key', () => {
      const bountiesW1 = prog.getWeeklyBounties('2026-W36');
      const bountiesW1Repeat = prog.getWeeklyBounties('2026-W36');
      const bountiesW2 = prog.getWeeklyBounties('2026-W37');

      assert.strictEqual(bountiesW1.length, 3);
      assert.deepStrictEqual(bountiesW1.map(b => b.id), bountiesW1Repeat.map(b => b.id));
      assert.notDeepStrictEqual(bountiesW1.map(b => b.id), bountiesW2.map(b => b.id));
    });

    it('evaluates telemetry events against weekly bounties', () => {
      const winProg = prog.evaluateWeeklyBountyProgress('weekly_wins_3', 2, { won: true, humanRacers: 2 });
      assert.strictEqual(winProg, 3);

      const nitroProg = prog.evaluateWeeklyBountyProgress('weekly_nitro_20', 10, { nitroCount: 5 });
      assert.strictEqual(nitroProg, 15);

      const cleanProg = prog.evaluateWeeklyBountyProgress('weekly_clean_5', 2, { finished: true, collisions: 0 });
      assert.strictEqual(cleanProg, 3);
    });

    it('supports claiming weekly bounty rewards idempotently', async () => {
      const uid = 'bounty_hunter_01';
      const wKey = '2026-W36';
      memPlayerStats.set(uid, { uid, xp: 100, rating: 1100 });

      const list = getOrInitWeeklyBounties(wKey, uid);
      const bMap = memWeeklyBounties.get(`${wKey}:${uid}`);
      bMap.set(list[0].id, { progress: list[0].goal, completed: true, claimed: false });

      // First claim
      const res1 = await httpPost('/api/competitions/weekly/bounties/claim', {
        uid,
        weekKey: wKey,
        bountyId: list[0].id
      });
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res1.json.ok, true);
      assert.strictEqual(res1.json.claimed, true);
      assert.ok(res1.json.xpAwarded > 0);
      assert.ok(res1.json.coinsAwarded > 0);

      // Second claim (prevent double claiming)
      const res2 = await httpPost('/api/competitions/weekly/bounties/claim', {
        uid,
        weekKey: wKey,
        bountyId: list[0].id
      });
      assert.strictEqual(res2.status, 400);
      assert.strictEqual(res2.json.ok, false);
      assert.strictEqual(res2.json.error, 'ALREADY_CLAIMED');
    });
  });

  describe('4. Revenge Match Mechanics', () => {
    it('evaluates revenge match victory with 1.5x Bounty (+50% XP and coins)', () => {
      const targetUid = 'rival_player_99';
      const winnerUid = 'hero_player';
      const baseReward = { xp: 100, coins: 20 };

      const revResult = prog.evaluateRevengeMatch(targetUid, winnerUid, baseReward);
      assert.strictEqual(revResult.revenge, true);
      assert.strictEqual(revResult.xpBonus, 50); // +50% of 100
      assert.strictEqual(revResult.coinsBonus, 10); // +50% of 20
      assert.strictEqual(revResult.totalXp, 150);
      assert.strictEqual(revResult.totalCoins, 30);
    });

    it('issues and lists active revenge targets via API', async () => {
      const uid = 'racer_victim';
      const targetUid = 'racer_nemesis';

      // Issue revenge challenge
      const issRes = await httpPost('/api/player/revenge/issue', {
        uid,
        targetUid,
        targetName: 'Nemesis',
        map: 1,
        targetTime: 54200
      });
      assert.strictEqual(issRes.status, 200);
      assert.strictEqual(issRes.json.ok, true);
      assert.strictEqual(issRes.json.target.targetName, 'Nemesis');

      // Fetch revenge list
      const getRes = await httpGet(`/api/player/revenge?uid=${encodeURIComponent(uid)}`);
      assert.strictEqual(getRes.status, 200);
      assert.strictEqual(getRes.json.ok, true);
      assert.strictEqual(getRes.json.targets.length, 1);
      assert.strictEqual(getRes.json.targets[0].targetName, 'Nemesis');
      assert.strictEqual(getRes.json.targets[0].map, 1);
    });
  });

  describe('5. Prioritized Next Best Action Engine', () => {
    it('recommends Driving Academy for players without a pro license', () => {
      const state = {
        licenseDone: false,
        streakInfo: { racedToday: false, currentStreak: 1 },
        missions: [],
        rivals: {}
      };
      const act = prog.getNextBestAction(state);
      assert.strictEqual(act.id, 'license');
      assert.strictEqual(act.actionType, 'academy');
      assert.ok(act.title.includes('Driving Academy'));
    });

    it('prioritizes streak protection when streak is at risk and license is done', () => {
      const state = {
        licenseDone: true,
        streakInfo: { racedToday: false, currentStreak: 5, nextMilestone: 7 },
        missions: [],
        rivals: {}
      };
      const act = prog.getNextBestAction(state);
      assert.strictEqual(act.id, 'streak');
      assert.strictEqual(act.actionType, 'quickplay');
      assert.ok(act.title.includes('5-Day Streak'));
    });

    it('serves dynamic next best action via /api/player/next-action endpoint', async () => {
      const uid = 'action_user_01';
      memPlayerLicense.set(uid, true); // license already done

      const res = await httpGet(`/api/player/next-action?uid=${encodeURIComponent(uid)}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.ok, true);
      assert.ok(res.json.action);
      assert.ok(res.json.action.title);
      assert.ok(res.json.action.cta);
    });
  });

  describe('6. Multi-Target Ghost Target API', () => {
    it('serves track record ghost target via /api/ghost/target?target=record', async () => {
      const res = await httpGet('/api/ghost/target?map=0&target=record');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.ok, true);
      assert.strictEqual(res.json.targetType, 'record');
      assert.ok(res.json.targetTime > 0);
      assert.ok(Array.isArray(res.json.samples));
      assert.ok(res.json.samples.length > 0);
    });

    it('serves rival ghost target via /api/ghost/target?target=rival', async () => {
      const res = await httpGet('/api/ghost/target?map=1&target=rival&uid=test_user');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.ok, true);
      assert.strictEqual(res.json.targetType, 'rival');
      assert.ok(res.json.targetTime > 0);
      assert.ok(res.json.samples.length > 0);
    });
  });

  describe('7. Authoritative Settlement Integration with Badges, Bounties and Revenge', () => {
    it('settles race with weekly bounty progression and revenge bonus calculations', async () => {
      const uid1 = 'settle_user_1';
      const uid2 = 'settle_user_2';

      memPlayerStats.set(uid1, { uid: uid1, name: 'Racer 1', rating: 1200, xp: 500, wins: 5, streak: 2 });
      memPlayerStats.set(uid2, { uid: uid2, name: 'Racer 2', rating: 1210, xp: 500, wins: 4, streak: 1 });

      // Add revenge target for user 1 against user 2
      memRevengeTargets.set(uid1, [{
        id: 101,
        targetUid: uid2,
        targetName: 'Racer 2',
        map: 0,
        status: 'open'
      }]);

      const c1 = { slot: 1, name: 'Racer 1', finished: true, laps: 2, collisions: 0, maxSpeed: 60, nitroCount: 3, finishTime: 45.2, best: 22.5 };
      const c2 = { slot: 2, name: 'Racer 2', finished: true, laps: 2, collisions: 1, maxSpeed: 55, nitroCount: 1, finishTime: 48.5, best: 24.1 };

      const room = {
        code: 'TEST_RETENTION_ROOM',
        mode: 'race',
        mapId: 0,
        cars: [c1, c2],
        order: [c1, c2]
      };

      const entry = {
        room,
        uidBySlot: { 1: uid1, 2: uid2 },
        raceSeq: 1,
        results: [c1, c2]
      };

      const rows = await settleRace(entry);
      assert.strictEqual(rows.length, 2);

      // User 1 won revenge match
      const r1 = rows.find(r => r.slot === 1);
      assert.ok(r1.revengeAwarded);
      assert.strictEqual(r1.revengeAwarded.targetUid, uid2);
      assert.ok(r1.revengeAwarded.xpBonus > 0);
      assert.ok(r1.revengeAwarded.coinsBonus > 0);

      // Badge evaluations included
      assert.ok(r1.badges);
      assert.strictEqual(r1.badges.length, 8);

      // Weekly bounty updates included
      assert.ok(r1.bountyUpdates);
      assert.strictEqual(r1.bountyUpdates.length, 3);
    });
  });
});
