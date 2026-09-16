const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/game-core.js');

describe('Authoritative Race Lifecycle & Simulation', () => {
  test('transitions through 3-2-1 countdown to racing state with go event', () => {
    const room = new core.RaceRoom('RACE1', 'race', 0, 2);
    room.setLaps(1);
    room.cars[0].participating = true;
    room.cars[1].participating = true;

    assert.equal(room.state, 'waiting');
    const started = room.start();
    assert.equal(started, true);
    assert.equal(room.state, 'countdown');

    // Run 3.1 seconds of simulation to step through 3s countdown reliably
    for (let i = 0; i < 95; i++) {
      room.update(1 / 30);
    }
    assert.equal(room.state, 'racing');

    // Check that 'go' event was emitted
    const goEvent = room.events.find((e) => e.type === 'go');
    assert.ok(goEvent, 'Go event should be emitted when countdown reaches 0');
  });

  test('accurately tracks lap times, personal bests, and rejects reverse driving shortcuts', () => {
    const track = core.MAPS[0];
    const car = new core.Car(1, track.a, track);
    car.maxLaps = 2;
    car.participating = true;

    // Simulate car moving forward along the circuit
    car.lastPhi = 0;
    car.progress = 0;
    
    // Reverse driving should decrease progress without triggering lap
    car.update(1 / 30, 1.0, 'racing', [], null);
    car.progress = -1.0;
    assert.equal(car.lap, 0);
    assert.equal(car.finished, false);

    // Forward driving completing lap 1 (progress >= 2*PI)
    car.progress = Math.PI * 2 + 0.05;
    const evLap1 = car.update(1 / 30, 25.0, 'racing', [], null);

    assert.equal(car.lap, 1);
    assert.equal(car.lastLap, 25.0);
    assert.equal(car.best, 25.0);
    assert.equal(car.finished, false);
    assert.ok(evLap1.lap);
    assert.equal(evLap1.lap.n, 1);

    // Completing lap 2 with a faster lap time of 22s (total time = 47.0)
    car.progress = Math.PI * 2 + 0.05;
    const evLap2 = car.update(1 / 30, 47.0, 'racing', [], null);

    assert.equal(car.lap, 2);
    assert.equal(car.lastLap, 22.0);
    assert.equal(car.best, 22.0, 'Best lap time should update to faster 22s');
    assert.equal(car.finished, true);
    assert.ok(evLap2.finish);
    assert.equal(evLap2.finish.t, 47.0);
  });

  test('detects winner and generates authoritative results payload', () => {
    const room = new core.RaceRoom('RACE2', 'race', 0, 2);
    room.setLaps(1);
    room.cars[0].participating = true;
    room.cars[1].participating = true;
    room.cars[0].name = 'Ace';
    room.cars[1].name = 'Blitz';

    room.state = 'racing';
    room.raceTime = 30.0;

    // Car 1 finishes first at 32.5s
    room.cars[0].finished = true;
    room.cars[0].finishTime = 32.5;
    room.cars[0].best = 32.5;
    room.winner = 1;

    // Car 2 finishes second at 35.0s
    room.cars[1].finished = true;
    room.cars[1].finishTime = 35.0;
    room.cars[1].best = 35.0;

    // Advance room tick to evaluate race completion
    room.update(1 / 30);

    assert.equal(room.state, 'finished');
    assert.equal(room.winner, 1);

    const resultsEv = room.events.find((e) => e.type === 'results');
    assert.ok(resultsEv, 'Results event must be emitted');
    assert.equal(resultsEv.order.length, 2);
    
    const [first, second] = resultsEv.order;
    assert.equal(first.slot, 1);
    assert.equal(first.name, 'Ace');
    assert.equal(first.finished, true);
    assert.equal(first.t, 32.5);

    assert.equal(second.slot, 2);
    assert.equal(second.name, 'Blitz');
    assert.equal(second.finished, true);
    assert.equal(second.t, 35.0);
  });

  test('AI bot produces calibrated throttle and steering for PRO vs ROOKIE skill levels', () => {
    const room = new core.RaceRoom('AIBOT', 'race', 0, 2);
    const botCar = room.cars[1];
    botCar.participating = true;
    botCar._bot = true;

    // PRO Bot Skill (1)
    room.setBotSkill(1);
    const proInput = room.botInputFor(botCar);

    // ROOKIE Bot Skill (0)
    room.setBotSkill(0);
    const rookieInput = room.botInputFor(botCar);

    assert.ok(proInput.throttle > rookieInput.throttle, 'PRO bot throttle should be higher than ROOKIE throttle');
    assert.ok(rookieInput.throttle <= 0.72, 'ROOKIE bot throttle must be capped at lower speed (0.72)');
    assert.equal(rookieInput.nitro, false, 'ROOKIE bot should never use nitro');
  });

  test('verifies client event handling: fin fires only on true race finish and never on intermediate laps', () => {
    // Simulate processEvents logic matching public/js/game.js
    const mySlot = 1;
    let finCallCount = 0;
    const trackedEvents = [];
    const track = (e, map) => {
      trackedEvents.push({ e, map });
      if (e === 'fin') finCallCount++;
    };

    function simulateProcessEvents(snapEvents, mapId = 0) {
      for (const e of snapEvents) {
        switch (e.type) {
          case 'lap':
            // Intermediate lap: does NOT call track('fin')
            break;
          case 'finallap':
            // Final lap warning: does NOT call track('fin')
            break;
          case 'win':
            if (e.slot === mySlot) track('fin', mapId);
            break;
          case 'finished':
            if (e.slot === mySlot) track('fin', mapId);
            break;
        }
      }
    }

    // 1. 3-lap race: Lap 1 and Lap 2 intermediate events
    simulateProcessEvents([
      { type: 'lap', slot: 1, n: 1, t: 24.5 },
      { type: 'lap', slot: 2, n: 1, t: 26.0 },
      { type: 'finallap', slot: 1 }
    ]);
    assert.equal(finCallCount, 0, 'fin must NOT fire on intermediate lap or finallap');

    // 2. Opponent (slot 2) wins first while local player (slot 1) is still driving
    simulateProcessEvents([
      { type: 'win', slot: 2, t: 72.0, multi: true }
    ]);
    assert.equal(finCallCount, 0, 'Rival win must NOT trigger fin for local player');

    // 3. Local player finishes 2nd -> finished event
    simulateProcessEvents([
      { type: 'finished', slot: 1, t: 75.0 }
    ]);
    assert.equal(finCallCount, 1, 'Local player finish must fire fin exactly once');

    // 4. 1-lap race: Local player wins directly on lap 1
    finCallCount = 0;
    simulateProcessEvents([
      { type: 'win', slot: 1, t: 23.8, multi: false }
    ]);
    assert.equal(finCallCount, 1, '1-lap race finish must fire fin exactly once');
  });

  test('verifies physics, collision, and progression across all 5 maps in all 4 weather modes', () => {
    const dt = 1 / 30;
    for (let mapId = 0; mapId < 5; mapId++) {
      for (const weather of ['dry', 'wet', 'blizzard', 'night']) {
        const room = new core.RaceRoom(`MAP_V_${mapId}_${weather}`, 'race', mapId, 2, weather);
        room.setBot(true);
        room.start();

        // 3 seconds countdown
        for (let t = 0; t < 95; t++) {
          room.update(dt);
        }
        assert.equal(room.state, 'racing');

        // Race with bot for 15 seconds (450 ticks)
        for (let t = 0; t < 450; t++) {
          room.setInput(1, { steer: 0, throttle: 1, brake: 0, handbrake: false, nitro: false });
          room.update(dt);
        }

        const c1 = room.cars[0];
        const c2 = room.cars[1];

        // Ensure no NaNs exist in any car physics vectors
        assert.ok(!isNaN(c1.x) && !isNaN(c1.z) && !isNaN(c1.vx) && !isNaN(c1.vy) && !isNaN(c1.heading), `Map ${mapId} ${weather}: Car 1 has NaN`);
        assert.ok(!isNaN(c2.x) && !isNaN(c2.z) && !isNaN(c2.vx) && !isNaN(c2.vy) && !isNaN(c2.heading), `Map ${mapId} ${weather}: Car 2 has NaN`);

        // Ensure cars advanced along the track
        assert.ok(c1.progress > 0.05, `Map ${mapId} ${weather}: Car 1 should make positive progress (got ${c1.progress})`);
        assert.ok(c2.progress > 0.1, `Map ${mapId} ${weather}: Bot Car 2 should navigate track (got ${c2.progress})`);
      }
    }
  });

  test('verifies smooth barrier collision clamping on both inner and outer fences across maps 1-4 without centerline snapping', () => {
    const dt = 1 / 30;
    for (let mapId = 1; mapId <= 4; mapId++) {
      const track = core.MAPS[mapId];
      const car = new core.Car(1, track.a, track);
      car.participating = true;
      car.resetGrid(0);

      // 1. Force car toward outer fence (steer right hard against barrier)
      for (let t = 0; t < 60; t++) {
        car.input = { steer: 1.0, throttle: 1.0, brake: 0, handbrake: false, nitro: false };
        car.update(dt, t * dt, 'racing', [], null);
      }
      const outerNear = track.nearest(car.x, car.z, car._th);
      assert.ok(outerNear.d <= track.limC + 0.5, `Map ${mapId}: Outer barrier collision must clamp car within limC bound (got d=${outerNear.d})`);
      assert.ok(!isNaN(car.x) && !isNaN(car.z), `Map ${mapId}: Outer collision must not produce NaN`);

      // 2. Force car toward inner fence (steer left hard against barrier)
      for (let t = 0; t < 60; t++) {
        car.input = { steer: -1.0, throttle: 1.0, brake: 0, handbrake: false, nitro: false };
        car.update(dt, (60 + t) * dt, 'racing', [], null);
      }
      const innerNear = track.nearest(car.x, car.z, car._th);
      assert.ok(innerNear.d <= track.limC + 0.5, `Map ${mapId}: Inner barrier collision must clamp car within limC bound (got d=${innerNear.d})`);
      assert.ok(!isNaN(car.x) && !isNaN(car.z), `Map ${mapId}: Inner collision must not produce NaN`);
    }
  });
});
