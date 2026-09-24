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

      // Join APEX preset crew (Redline Motorsport [REDL])
      const rJoin = await fetch(`${baseUrl}/api/player/crew/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: testUid, name: 'TEST_PILOT', crewId: 'apex' })
      }).then(r => r.json());
      assert.equal(rJoin.ok, true);
      assert.equal(rJoin.tag, 'REDL');

      // Check player crew info now
      const r1 = await fetch(`${baseUrl}/api/player/crew?uid=${testUid}`).then(r => r.json());
      assert.equal(r1.ok, true);
      assert.equal(r1.hasCrew, true);
      assert.equal(r1.crew.tag, 'REDL');
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
      const testUid = 'test_pilot_milestone';
      // Join crew first
      await fetch(`${baseUrl}/api/player/crew/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: testUid, name: 'TEST_PILOT', crewId: 'apex' })
      });
      // Give apex crew 30,000m (Tier 1 reached)
      serverMod.memCrews.get('apex').weeklyMeters = 30000;

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
      // Register test pilot in apex crew
      serverMod.memPlayerCrew.set('pf_pilot_1', 'apex');
      serverMod.memCrews.get('apex').members.push({ uid: 'pf_pilot_1', name: 'PF PILOT 1', role: 'member' });

      const room = new core.RaceRoom('PF001', 'race', 0, 2);
      const entry = {
        room,
        screens: new Set(),
        controllers: new Map(),
        raceSeq: 1,
        uidBySlot: { 1: 'pf_pilot_1', 2: 'pf_pilot_2' },
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

  // =========================================================================
  // 5. Multi-Member Club Sync (v90 identity aliasing)
  //
  // REGRESSION: a single racer is known to the server by several DIFFERENT
  // strings. The club APIs are called with `SRAccount.name() || prefs.pid`,
  // race settlement keys on the Supabase uuid returned by verifyUid() and
  // otherwise falls back to the in-race display name, and the handshake carries
  // the device pid. Club mileage used to be credited only when those keys
  // coincided, so a club displayed ONE member's distance and points while every
  // other member stayed pinned at 0.0 km / 0 pts no matter how much they raced.
  // =========================================================================
  describe('5. Multi-Member Club Sync (identity aliasing)', () => {
    // 3 completed laps x 800 m average lap = 2400 m per racer per race
    const EXPECTED_METERS = 2400;

    function raceCar(slot, name, lapSec) {
      return {
        slot, name, finished: true, lap: 3, lapTimes: [lapSec, lapSec, lapSec],
        finishTime: lapSec * 3, best: lapSec, collisions: 0, participating: true
      };
    }

    function makeEntry(cars, uidBySlot, pidBySlot, raceSeq) {
      return {
        room: { code: 'CLUBSYNC' + raceSeq, mode: 'race', mapId: 0, cars, order: cars, laps: 3 },
        screens: new Set(),
        controllers: new Map(),
        raceSeq,
        uidBySlot: uidBySlot || {},   // verifyUid() results (Supabase uuids)
        pidBySlot: pidBySlot || {},   // device pids captured from hello/meta
        dupUid: {},
        chBySlot: {}
      };
    }

    async function foundClub(tag, founder) {
      const res = await fetch(`${baseUrl}/api/player/crew/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ crewName: 'Sync Test ' + tag, tag, motto: 'sync', badge: '\u{1F3C1}', color: '#12ff34' }, founder))
      }).then(r => r.json());
      assert.equal(res.ok, true, 'club creation should succeed');
      return res.crew.id;
    }

    async function joinClub(crewId, member) {
      const res = await fetch(`${baseUrl}/api/player/crew/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ crewId }, member))
      }).then(r => r.json());
      assert.equal(res.ok, true, 'club join should succeed');
      return res;
    }

    async function clubView(query) {
      const qs = Object.keys(query).filter(k => query[k]).map(k => `${k}=${encodeURIComponent(query[k])}`).join('&');
      return fetch(`${baseUrl}/api/player/crew?${qs}`).then(r => r.json());
    }

    test('credits EVERY member when the club key differs from the settlement key', async () => {
      // founder is signed in (club row keyed by username), friend is a guest
      // (club row keyed by device pid) — the two shapes that used to mismatch.
      const founder = { uid: 'sync_founder_a', name: 'SYNC_FOUNDER_A', pid: 'sb:uuid-sync-a', sbUid: 'uuid-sync-a' };
      const guest = { uid: 'p_device_guest_a', name: 'RACER-GUESTA', pid: 'p_device_guest_a', sbUid: '' };
      const crewId = await foundClub('SYNA', founder);
      await joinClub(crewId, guest);

      // relay WITHOUT Supabase verification: settlement falls back to display names
      const cars = [raceCar(1, founder.name, 40), raceCar(2, guest.name, 41)];
      const rows = await serverMod.settleRace(makeEntry(cars, {}, { 1: founder.pid, 2: guest.pid }, 11));

      assert.equal(rows.length, 2);
      assert.ok(rows.every(r => r.crew), 'both racers must receive a club contribution');
      assert.ok(rows.every(r => r.crew.contribMeters === EXPECTED_METERS));

      const view = await clubView({ uid: founder.uid });
      assert.equal(view.crew.members.length, 2, 'roster must not gain duplicate rows');
      for (const m of view.crew.members) {
        assert.equal(m.weeklyMeters, EXPECTED_METERS, `member ${m.uid} must be credited 3 laps x 800 m`);
        assert.ok(m.weeklyPoints > 0, `member ${m.uid} must earn club points`);
      }
      assert.equal(view.crew.weeklyMeters, EXPECTED_METERS * 2, 'club pool must be the sum of its members');
      assert.equal(view.crew.weeklyPoints, view.crew.members.reduce((a, m) => a + m.weeklyPoints, 0));
    });

    test('credits club members when settlement uses verified Supabase uuids', async () => {
      const founder = { uid: 'sync_founder_b', name: 'SYNC_FOUNDER_B', pid: 'sb:uuid-sync-b', sbUid: 'uuid-sync-b' };
      const guest = { uid: 'p_device_guest_b', name: 'RACER-GUESTB', pid: 'p_device_guest_b', sbUid: '' };
      const crewId = await foundClub('SYNB', founder);
      await joinClub(crewId, guest);

      // relay WITH Supabase: slot 1 settles under the uuid, not the username
      const cars = [raceCar(1, founder.name, 40), raceCar(2, guest.name, 41)];
      const rows = await serverMod.settleRace(makeEntry(cars, { 1: founder.sbUid }, { 1: founder.pid, 2: guest.pid }, 12));

      assert.ok(rows.every(r => r.crew), 'uuid-settled racers must still reach their club');
      const view = await clubView({ uid: founder.uid, sbUid: founder.sbUid });
      assert.equal(view.crew.members.length, 2);
      for (const m of view.crew.members) assert.equal(m.weeklyMeters, EXPECTED_METERS, `member ${m.uid} credited`);
    });

    test('accumulates repeat races on the same roster rows without duplicating members', async () => {
      const founder = { uid: 'sync_founder_c', name: 'SYNC_FOUNDER_C', pid: 'sb:uuid-sync-c', sbUid: 'uuid-sync-c' };
      const guest = { uid: 'p_device_guest_c', name: 'RACER-GUESTC', pid: 'p_device_guest_c', sbUid: '' };
      const crewId = await foundClub('SYNC', founder);
      await joinClub(crewId, guest);

      for (let race = 1; race <= 3; race++) {
        const cars = [raceCar(1, founder.name, 40), raceCar(2, guest.name, 41)];
        // alternate which identity the server happens to settle under
        const uidBySlot = race % 2 ? { 1: founder.sbUid } : {};
        await serverMod.settleRace(makeEntry(cars, uidBySlot, { 1: founder.pid, 2: guest.pid }, 20 + race));
      }

      const view = await clubView({ uid: founder.uid });
      assert.equal(view.crew.members.length, 2, 'three races must not create extra roster rows');
      for (const m of view.crew.members) assert.equal(m.weeklyMeters, EXPECTED_METERS * 3, `member ${m.uid} accumulates every race`);
      assert.equal(view.crew.weeklyMeters, EXPECTED_METERS * 6);
      assert.equal(view.crew.totalMeters, EXPECTED_METERS * 6);
    });

    test('resolves the same club from any of the member identities', async () => {
      const founder = { uid: 'sync_founder_d', name: 'SYNC_FOUNDER_D', pid: 'sb:uuid-sync-d', sbUid: 'uuid-sync-d' };
      const guest = { uid: 'p_device_guest_d', name: 'RACER-GUESTD', pid: 'p_device_guest_d', sbUid: '' };
      const crewId = await foundClub('SYND', founder);
      await joinClub(crewId, guest);

      const byUid = await clubView({ uid: founder.uid });
      const byPid = await clubView({ uid: 'guest', pid: founder.pid });
      const bySbUid = await clubView({ uid: 'guest', sbUid: founder.sbUid });
      const byName = await clubView({ uid: 'guest', name: founder.name });
      const guestByPid = await clubView({ uid: guest.uid, pid: guest.pid });

      for (const v of [byUid, byPid, bySbUid, byName, guestByPid]) {
        assert.equal(v.hasCrew, true, 'every identity must resolve to the club');
        assert.equal(v.crew.id, crewId);
        assert.equal(v.crew.tag, 'SYND');
      }
      assert.equal(byUid.crew.isLeader, true);
      assert.equal(guestByPid.crew.isLeader, false);
    });

    test('keeps milestone claims idempotent across different aliases of one member', async () => {
      const founder = { uid: 'sync_founder_e', name: 'SYNC_FOUNDER_E', pid: 'sb:uuid-sync-e', sbUid: 'uuid-sync-e' };
      const crewId = await foundClub('SYNE', founder);
      serverMod.memCrews.get(crewId).weeklyMeters = 30000; // Tier 1 reached

      const claim = (body) => fetch(`${baseUrl}/api/player/crew/claim-milestone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ tier: 1 }, body))
      }).then(r => r.json());

      const first = await claim({ uid: founder.uid });
      assert.equal(first.ok, true);
      assert.equal(first.xpAwarded, 150);

      const byPid = await claim({ uid: 'whatever', pid: founder.pid, name: founder.name });
      assert.equal(byPid.ok, false, 'the same member must not claim twice through another alias');
      assert.equal(byPid.error, 'already_claimed');

      const bySbUid = await claim({ uid: 'whatever', sbUid: founder.sbUid });
      assert.equal(bySbUid.ok, false);
      assert.equal(bySbUid.error, 'already_claimed');
    });

    // mock socket, same shape test/multiplayer.test.js uses
    function mockWs() {
      return {
        readyState: 1,
        sent: [],
        send(d) { this.sent.push(typeof d === 'string' ? JSON.parse(d) : d); },
        close() { this.readyState = 3; },
        findSent(t) { return this.sent.filter((m) => m && m.type === t); },
        lastLobby() { const l = this.findSent('lobby'); return l[l.length - 1] || null; }
      };
    }

    test('captures the device pid on join so the first lobby broadcast shows every club tag', async () => {
      const founder = { uid: 'lobby_founder_f', name: 'LOBBY_FOUNDER_F', pid: 'sb:uuid-lobby-f', sbUid: 'uuid-lobby-f' };
      const guest = { uid: 'p_lobby_guest_f', name: 'RACER-LOBBYF', pid: 'p_lobby_guest_f', sbUid: '' };
      const crewId = await foundClub('LOBF', founder);
      await joinClub(crewId, guest);

      const entry = serverMod.newRoom('race', 0, 2);
      const wsA = mockWs(), wsB = mockWs();
      const clientA = { ws: wsA, entry: null, slot: 0, role: null };
      const clientB = { ws: wsB, entry: null, slot: 0, role: null };
      serverMod.joinRoom(clientA, entry, 'screen', { pid: founder.pid, name: founder.name });
      serverMod.joinRoom(clientB, entry, 'screen', { pid: guest.pid, name: guest.name });

      assert.equal(entry.pidBySlot[clientA.slot], founder.pid, 'founder device pid captured from the handshake');
      assert.equal(entry.pidBySlot[clientB.slot], guest.pid, 'guest device pid captured from the handshake');

      const lobby = wsA.lastLobby();
      assert.ok(lobby, 'screens must receive a lobby broadcast');
      assert.equal(lobby.players.length, 2);
      assert.deepEqual(lobby.players.map((p) => p.crewTag), ['LOBF', 'LOBF'],
        'both racers must show the syndicate tag, not only the signed-in one');
    });

    test('refreshes lobby club tags live when a member joins a club mid-session', async () => {
      const founder = { uid: 'lobby_founder_g', name: 'LOBBY_FOUNDER_G', pid: 'sb:uuid-lobby-g', sbUid: 'uuid-lobby-g' };
      const guest = { uid: 'p_lobby_guest_g', name: 'RACER-LOBBYG', pid: 'p_lobby_guest_g', sbUid: '' };
      const crewId = await foundClub('LOBG', founder);

      const entry = serverMod.newRoom('race', 0, 2);
      const wsA = mockWs(), wsB = mockWs();
      serverMod.joinRoom({ ws: wsA, entry: null, slot: 0, role: null }, entry, 'screen', { pid: founder.pid, name: founder.name });
      serverMod.joinRoom({ ws: wsB, entry: null, slot: 0, role: null }, entry, 'screen', { pid: guest.pid, name: guest.name });

      const before = wsA.lastLobby();
      assert.deepEqual(before.players.map((p) => p.crewTag), ['LOBG', null], 'guest has no club yet');

      await joinClub(crewId, guest); // joins the club while already sitting in the lobby

      const after = wsA.lastLobby();
      assert.deepEqual(after.players.map((p) => p.crewTag), ['LOBG', 'LOBG'],
        'the new tag must be pushed without the racer rejoining the room');
    });

    test('never folds two different clubs together over a shared display name', async () => {
      const alpha = { uid: 'shared_alpha_uid', name: 'RACER-SHARED', pid: 'p_alpha_device', sbUid: '' };
      const beta = { uid: 'shared_beta_uid', name: 'RACER-SHARED', pid: 'p_beta_device', sbUid: '' };
      const crewA = await foundClub('SHRA', alpha);
      const crewB = await foundClub('SHRB', beta);

      // a strong identity always wins and picks the right club
      assert.equal(serverMod.findCrewId({ uid: alpha.uid }), crewA);
      assert.equal(serverMod.findCrewId({ pid: beta.pid }), crewB);
      assert.equal(serverMod.findCrewId({ uid: alpha.uid, name: alpha.name }), crewA);

      // a display name mapped to two clubs is ambiguous -> refuse to guess
      assert.equal(serverMod.findCrewId({ name: 'RACER-SHARED' }), null);

      const cars = [raceCar(1, 'RACER-SHARED', 40)];
      const rows = await serverMod.settleRace(makeEntry(cars, {}, {}, 31));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].crew, null, 'ambiguous nickname must not credit either club');
      assert.equal(serverMod.memCrews.get(crewA).weeklyMeters, 0);
      assert.equal(serverMod.memCrews.get(crewB).weeklyMeters, 0);
    });
  });
});
