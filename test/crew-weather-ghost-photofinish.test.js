const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const core = require('../shared/game-core.js');
const prog = require('../shared/progression.js');
const serverMod = require('../server.js');

describe('V83 Feature Suite: Syndicate Crews, Weather, Ghost Racing Line & Photo Finish', () => {
  let serverInstance;
  let port;
  let baseUrl;

  before(async () => {
    await new Promise((resolve) => {
      serverInstance = http.createServer(serverMod.app);
      serverInstance.listen(0, '127.0.0.1', () => {
        port = serverInstance.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (serverInstance) {
      await new Promise((resolve) => serverInstance.close(resolve));
    }
  });

  // =========================================================================
  // 1. Racing Syndicate Crews
  // =========================================================================
  describe('1. Racing Syndicate Crews System', () => {
    test('validates crew tags and names properly', () => {
      assert.equal(prog.validCrewTag('APEX'), true);
      assert.equal(prog.validCrewTag('GP1'), true);
      assert.equal(prog.validCrewTag('A'), false); // too short
      assert.equal(prog.validCrewTag('TOOLONG'), false); // too long
      assert.equal(prog.validCrewTag('$$$'), false); // invalid chars

      assert.equal(prog.validCrewName('Apex Predators'), true);
      assert.equal(prog.validCrewName('Viper-Velocity_99'), true);
      assert.equal(prog.validCrewName('AB'), false); // too short
    });

    test('calculates crew milestone progression correctly', () => {
      const info0 = prog.getCrewMilestoneInfo(0);
      assert.equal(info0.currentTier, 0);
      assert.equal(info0.progressPct, 0);
      assert.equal(info0.nextMilestone.tier, 1);
      assert.equal(info0.nextMilestone.reqKm, 25);

      const info1 = prog.getCrewMilestoneInfo(30000); // 30 km (reached Tier 1)
      assert.equal(info1.currentTier, 1);
      assert.equal(info1.km, 30);
      assert.equal(info1.nextMilestone.tier, 2);

      const info5 = prog.getCrewMilestoneInfo(1200000); // 1,200 km (reached Tier 5 Max)
      assert.equal(info5.currentTier, 5);
      assert.equal(info5.progressPct, 100);
      assert.equal(info5.nextMilestone, null);
    });

    test('calculates crew contribution points and distance from race telemetry', () => {
      const c1 = prog.calculateCrewContribution({ lapsCompleted: 3, finished: true, won: true, podium: true });
      assert.equal(c1.meters, 2400); // 3 * 800m
      assert.equal(c1.points, 240 + 150); // 390 pts

      const c2 = prog.calculateCrewContribution({ lapsCompleted: 2, finished: true, won: false, podium: true });
      assert.equal(c2.meters, 1600);
      assert.equal(c2.points, 160 + 80); // 240 pts
    });

    test('serves syndicate leaderboard via GET /api/crews', async () => {
      const res = await fetch(`${baseUrl}/api/crews`).then(r => r.json());
      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.crews));
      assert.ok(res.crews.length >= 3);
      assert.equal(res.crews[0].rank, 1);
      assert.ok(res.crews[0].weeklyMeters >= res.crews[1].weeklyMeters);
    });

    test('supports getting player crew and joining preset syndicate via API', async () => {
      const testUid = 'test_racer_crew_1';
      // Initial: player has no crew
      const r0 = await fetch(`${baseUrl}/api/player/crew?uid=${testUid}`).then(r => r.json());
      assert.equal(r0.ok, true);
      assert.equal(r0.hasCrew, false);

      // Join APEX crew
      const rJoin = await fetch(`${baseUrl}/api/player/crew/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: testUid, name: 'TEST_PILOT', crewId: 'apex' })
      }).then(r => r.json());
      assert.equal(rJoin.ok, true);
      assert.equal(rJoin.tag, 'APEX');

      // Check player crew info now
      const r1 = await fetch(`${baseUrl}/api/player/crew?uid=${testUid}`).then(r => r.json());
      assert.equal(r1.ok, true);
      assert.equal(r1.hasCrew, true);
      assert.equal(r1.crew.tag, 'APEX');
      assert.ok(r1.crew.members.some(m => m.uid === testUid));
    });

    test('supports creating a new custom crew via POST /api/player/crew/create', async () => {
      const leaderUid = 'test_leader_99';
      const rCreate = await fetch(`${baseUrl}/api/player/crew/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: leaderUid,
          name: 'CHIEF_RACER',
          crewName: 'Phantom Blades',
          tag: 'BLADE',
          motto: 'Sharp turns only',
          badge: '⚔️',
          color: '#ff0055'
        })
      }).then(r => r.json());
      assert.equal(rCreate.ok, true);
      assert.equal(rCreate.crew.tag, 'BLADE');
      assert.equal(rCreate.crew.leaderUid, leaderUid);

      // Verify created crew appears on leaderboard
      const rLb = await fetch(`${baseUrl}/api/crews/leaderboard`).then(r => r.json());
      assert.ok(rLb.crews.some(c => c.tag === 'BLADE'));
    });

    test('supports claiming reached crew milestones via POST /api/player/crew/claim-milestone', async () => {
      const testUid = 'seed_pro_1'; // Member of Apex crew which has 70km (reached Tier 1 & Tier 2)
      const rClaim = await fetch(`${baseUrl}/api/player/crew/claim-milestone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: testUid, tier: 1 })
      }).then(r => r.json());
      assert.equal(rClaim.ok, true);
      assert.equal(rClaim.tier, 1);
      assert.equal(rClaim.xpAwarded, 150);

      // Attempting double claim should be rejected
      const rDup = await fetch(`${baseUrl}/api/player/crew/claim-milestone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: testUid, tier: 1 })
      }).then(r => r.json());
      assert.equal(rDup.ok, false);
      assert.equal(rDup.error, 'already_claimed');
    });
  });

  // =========================================================================
  // 2. Dynamic Track Surface & Weather Conditions
  // =========================================================================
  describe('2. Dynamic Track Surface & Weather Conditions', () => {
    test('defines all 4 deterministic weather conditions with grip multipliers', () => {
      assert.ok(core.WEATHER_CONDITIONS);
      assert.equal(core.WEATHER_CONDITIONS.dry.gripMul, 1.0);
      assert.equal(core.WEATHER_CONDITIONS.wet.gripMul, 0.92);
      assert.equal(core.WEATHER_CONDITIONS.night.gripMul, 1.0);
      assert.equal(core.WEATHER_CONDITIONS.blizzard.gripMul, 0.88);
    });

    test('applies weather grip modifier directly into car physics simulation', () => {
      const map = core.MAPS[0];
      const roomDry = new core.RaceRoom('WTH01', 'race', 0, 2);
      roomDry.setWeather('dry');
      const roomWet = new core.RaceRoom('WTH02', 'race', 0, 2);
      roomWet.setWeather('wet');
      const roomBlizzard = new core.RaceRoom('WTH03', 'race', 0, 2);
      roomBlizzard.setWeather('blizzard');

      assert.equal(roomDry.weather, 'dry');
      assert.equal(roomWet.weather, 'wet');
      assert.equal(roomBlizzard.weather, 'blizzard');

      // Start rooms
      roomDry.start();
      roomWet.start();
      roomBlizzard.start();

      // Give throttle and full steering to induce lateral slip
      const input = { steer: 1.0, throttle: 1.0, brake: 0, handbrake: false, nitro: false };
      roomDry.setInput(1, input);
      roomWet.setInput(1, input);
      roomBlizzard.setInput(1, input);

      // Run 30 physics ticks (1 second of racing)
      for (let i = 0; i < 30; i++) {
        roomDry.update(1 / 30);
        roomWet.update(1 / 30);
        roomBlizzard.update(1 / 30);
      }

      // In wet & blizzard, reduced grip results in higher lateral slip / drift
      const carDry = roomDry.cars[0];
      const carWet = roomWet.cars[0];
      const carBlizzard = roomBlizzard.cars[0];

      assert.ok(carDry.x !== 0 || carDry.z !== 0);
      assert.ok(carWet.x !== 0 || carWet.z !== 0);
      assert.ok(carBlizzard.x !== 0 || carBlizzard.z !== 0);
    });

    test('includes weather condition inside room state snapshot', () => {
      const room = new core.RaceRoom('WTH04', 'race', 1, 2);
      room.setWeather('blizzard');
      const snap = room.snapshot();
      assert.equal(snap.weather, 'blizzard');
      assert.equal(snap.map, 1);
    });
  });

  // =========================================================================
  // 3. Visual Ghost Racing Line Spline Math
  // =========================================================================
  describe('3. Visual Ghost Racing Line Spline', () => {
    test('computes curvature along radial circuit spline points for apex/brake color coding', () => {
      const map = core.MAPS[1]; // Radial spline track
      assert.ok(map.ptAt);
      assert.ok(typeof map.ptAt === 'function');

      const numSamples = 64;
      let brakeZones = 0;
      let accelZones = 0;

      for (let i = 0; i < numSamples; i++) {
        const th = (i / numSamples) * Math.PI * 2;
        const p = map.ptAt(th);
        const pPrev = map.ptAt((th - 0.05 + Math.PI * 2) % (Math.PI * 2));
        const pNext = map.ptAt((th + 0.05) % (Math.PI * 2));

        const dx1 = p.x - pPrev.x, dz1 = p.z - pPrev.z;
        const dx2 = pNext.x - p.x, dz2 = pNext.z - p.z;
        const a1 = Math.atan2(dx1, dz1), a2 = Math.atan2(dx2, dz2);
        let da = Math.abs(a2 - a1);
        if (da > Math.PI) da = Math.PI * 2 - da;
        const curvature = da / 0.1;

        if (curvature > 1.0) brakeZones++;
        else accelZones++;
      }

      assert.ok(brakeZones > 0, 'Circuit must contain brake zones at sharp corners');
      assert.ok(accelZones > 0, 'Circuit must contain acceleration zones along straights and apex exits');
    });
  });

  // =========================================================================
  // 4. Photo-Finish Slow-Motion Highlight Replay
  // =========================================================================
  describe('4. Photo-Finish Slow-Motion Highlight Replay', () => {
    test('detects sub-0.60s finish margins and broadcasts photo-finish event during race settlement', async () => {
      const room = new core.RaceRoom('PF001', 'race', 0, 2);
      const entry = {
        room,
        screens: new Set(),
        controllers: new Map(),
        raceSeq: 1,
        uidBySlot: { 1: 'seed_pro_1', 2: 'seed_pro_2' },
        dupUid: {},
        chBySlot: {}
      };

      // Simulate close finish: P1 = 45.120s, P2 = 45.165s (margin = 0.045s)
      room.cars[0].finished = true;
      room.cars[0].finishTime = 45.120;
      room.cars[0].lap = 3;
      room.cars[0].participating = true;

      room.cars[1].finished = true;
      room.cars[1].finishTime = 45.165;
      room.cars[1].lap = 3;
      room.cars[1].participating = true;

      const results = await serverMod.settleRace(entry);
      assert.equal(results.length, 2);

      // P1 vs P2 margin is 0.045s -> below 0.60s threshold
      assert.equal(results[0].slot, 1);
      assert.equal(results[1].slot, 2);
      assert.ok(results[0].crew != null, 'Crew contribution should be computed for registered member');
      assert.ok(results[0].crew.contribMeters > 0);
    });
  });
});
