const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { app, AN, persistAnalytics, loadAnalytics } = require('../server.js');

describe('Analytics Engine & Funnel Tracking', () => {
  const testStoragePath = path.join(__dirname, 'test-analytics.json');

  beforeEach(() => {
    // Reset in-memory state for clean tests
    AN.counts = {
      visits: 0,
      gameStarts: 0,
      racesStarted: 0,
      racesCompleted: 0,
      secondRaces: 0,
      multiplayerRaces: 0,
      controllersConnected: 0,
      challengesSent: 0,
      challengesAccepted: 0,
      shares: 0,
      installs: 0,
      errors: 0
    };
    AN.uniques = {
      visitors: 0,
      gameStarters: 0,
      raceStarters: 0,
      raceCompleters: 0,
      secondRacers: 0,
      multiplayerPlayers: 0,
      controllerUsers: 0,
      challengeSenders: 0,
      challengeAcceptors: 0,
      sharers: 0
    };
    AN.seen = {
      visitors: new Set(),
      gameStarters: new Set(),
      raceStarters: new Set(),
      raceCompleters: new Set(),
      secondRacers: new Set(),
      multiplayerPlayers: new Set(),
      controllerUsers: new Set(),
      challengeSenders: new Set(),
      challengeAcceptors: new Set(),
      sharers: new Set()
    };
    AN.users = {};
    AN.cohorts = {};
    AN.byMap = [0, 0, 0, 0, 0];
    AN.byMode = { race: 0, tt: 0, practice: 0, coop: 0, elim: 0, drift: 0 };
    AN.byShare = { wa: 0, tg: 0, link: 0, code: 0, card: 0, ghost: 0, cup: 0, daily: 0, challenge: 0 };
    AN.lastErr = null;

    if (fs.existsSync(testStoragePath)) {
      try { fs.unlinkSync(testStoragePath); } catch (e) {}
    }
  });

  test('deduplicates unique users while counting total events', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // User 1 visits 3 times, starts 2 races
      for (let i = 0; i < 3; i++) {
        await fetch(`http://127.0.0.1:${port}/a`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ e: 'visit', pid: 'user-001' })
        });
      }
      for (let i = 0; i < 2; i++) {
        await fetch(`http://127.0.0.1:${port}/a`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ e: 'race', map: 1, pid: 'user-001' })
        });
      }

      // User 2 visits 1 time, starts 1 race
      await fetch(`http://127.0.0.1:${port}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ e: 'visit', pid: 'user-002' })
      });
      await fetch(`http://127.0.0.1:${port}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ e: 'race', map: 2, pid: 'user-002' })
      });

      const res = await fetch(`http://127.0.0.1:${port}/stats`);
      const stats = await res.json();

      assert.equal(stats.ok, true);
      assert.equal(stats.counts.visits, 4, 'Total visit events should be 4');
      assert.equal(stats.uniques.visitors, 2, 'Unique visitors should be 2');
      assert.equal(stats.counts.racesStarted, 3, 'Total race events should be 3');
      assert.equal(stats.uniques.raceStarters, 2, 'Unique race starters should be 2');
      assert.equal(stats.byMap[1], 2);
      assert.equal(stats.byMap[2], 1);
    } finally {
      server.close();
    }
  });

  test('calculates funnel conversion rates and biggest drop-off stage', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // 10 visitors -> 8 game starters -> 4 race starters -> 2 completions -> 1 second race
      for (let i = 1; i <= 10; i++) {
        const pid = `p-${i}`;
        await fetch(`http://127.0.0.1:${port}/a`, {
          method: 'POST',
          body: JSON.stringify({ e: 'visit', pid })
        });
        if (i <= 8) {
          await fetch(`http://127.0.0.1:${port}/a`, {
            method: 'POST',
            body: JSON.stringify({ e: 'game_start', pid })
          });
        }
        if (i <= 4) {
          await fetch(`http://127.0.0.1:${port}/a`, {
            method: 'POST',
            body: JSON.stringify({ e: 'race', map: 0, pid })
          });
        }
        if (i <= 2) {
          await fetch(`http://127.0.0.1:${port}/a`, {
            method: 'POST',
            body: JSON.stringify({ e: 'fin', map: 0, pid })
          });
        }
        if (i <= 1) {
          await fetch(`http://127.0.0.1:${port}/a`, {
            method: 'POST',
            body: JSON.stringify({ e: 'second_race', map: 0, pid })
          });
        }
      }

      const res = await fetch(`http://127.0.0.1:${port}/stats`);
      const stats = await res.json();

      assert.equal(stats.funnel.visitorToGameStartRate, 0.8); // 8 / 10
      assert.equal(stats.funnel.gameStartToRaceRate, 0.5); // 4 / 8
      assert.equal(stats.funnel.raceStartToCompletionRate, 0.5); // 2 / 4
      assert.equal(stats.funnel.completionToSecondRaceRate, 0.5); // 1 / 2

      // Biggest drop off: 50% drop in gameStartToRace, raceStartToCompletion, completionToSecondRace vs 20% in visitorToGameStart
      assert.equal(stats.funnel.biggestDropOff.dropPercentage, 50);
    } finally {
      server.close();
    }
  });

  test('calculates server-derived retention cohorts across D1, D7, and D30 with null for immature horizons', async () => {
    // Setup cohorts of various ages: today (0 days old), 2 days old, 10 days old, 35 days old
    const today = new Date().toISOString().slice(0, 10);
    const d2Ago = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const d10Ago = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const d35Ago = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);

    AN.cohorts[today] = { size: 50, d1: 0, d7: 0, d30: 0 };
    AN.cohorts[d2Ago] = { size: 100, d1: 60, d7: 0, d30: 0 };
    AN.cohorts[d10Ago] = { size: 100, d1: 50, d7: 30, d30: 0 };
    AN.cohorts[d35Ago] = { size: 100, d1: 40, d7: 20, d30: 10 };

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/stats`);
      const stats = await res.json();

      // Aggregate rates:
      // D1 eligible = d2Ago(100) + d10Ago(100) + d35Ago(100) = 300; D1 retained = 60 + 50 + 40 = 150 -> 0.5
      assert.equal(stats.retention.d1RetentionRate, 0.5);
      // D7 eligible = d10Ago(100) + d35Ago(100) = 200; D7 retained = 30 + 20 = 50 -> 0.25
      assert.equal(stats.retention.d7RetentionRate, 0.25);
      // D30 eligible = d35Ago(100) = 100; D30 retained = 10 -> 0.1
      assert.equal(stats.retention.d30RetentionRate, 0.1);

      // Verify individual cohort maturation checks:
      const todayCohort = stats.retention.cohorts.find((c) => c.date === today);
      assert.equal(todayCohort.d1Rate, null, '0-day-old cohort D1 rate must be null');
      assert.equal(todayCohort.d7Rate, null, '0-day-old cohort D7 rate must be null');
      assert.equal(todayCohort.d30Rate, null, '0-day-old cohort D30 rate must be null');

      const d2Cohort = stats.retention.cohorts.find((c) => c.date === d2Ago);
      assert.equal(d2Cohort.d1Rate, 0.6, '2-day-old cohort D1 rate should be 0.6');
      assert.equal(d2Cohort.d7Rate, null, '2-day-old cohort D7 rate must be null');
      assert.equal(d2Cohort.d30Rate, null, '2-day-old cohort D30 rate must be null');

      const d10Cohort = stats.retention.cohorts.find((c) => c.date === d10Ago);
      assert.equal(d10Cohort.d1Rate, 0.5, '10-day-old cohort D1 rate should be 0.5');
      assert.equal(d10Cohort.d7Rate, 0.3, '10-day-old cohort D7 rate should be 0.3');
      assert.equal(d10Cohort.d30Rate, null, '10-day-old cohort D30 rate must be null');

      const d35Cohort = stats.retention.cohorts.find((c) => c.date === d35Ago);
      assert.equal(d35Cohort.d1Rate, 0.4);
      assert.equal(d35Cohort.d7Rate, 0.2);
      assert.equal(d35Cohort.d30Rate, 0.1);
    } finally {
      server.close();
    }
  });

  test('tracks Founders Cup share with channel cup and increments share counters', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ e: 'share', channel: 'cup', pid: 'user-cup-1' })
      });
      assert.equal(res.status, 200);

      const statsRes = await fetch(`http://127.0.0.1:${port}/stats`);
      const stats = await statsRes.json();

      assert.equal(stats.counts.shares, 1);
      assert.equal(stats.uniques.sharers, 1);
      assert.equal(stats.byShare.cup, 1, 'AN.byShare.cup should be incremented');
    } finally {
      server.close();
    }
  });

  test('handles malformed, invalid, and huge payloads gracefully without crashing', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const badBodies = [
        'not valid json',
        '',
        JSON.stringify(null),
        JSON.stringify(12345),
        JSON.stringify({ e: {} }),
        JSON.stringify({ e: 'unknown_event_123', pid: 'x'.repeat(500) }),
        JSON.stringify({ e: 'race', map: 'NaN' })
      ];

      for (const body of badBodies) {
        const res = await fetch(`http://127.0.0.1:${port}/a`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body
        });
        assert.equal(res.status, 200);
        const json = await res.json();
        assert.equal(json.ok, true);
      }

      const statsRes = await fetch(`http://127.0.0.1:${port}/stats`);
      assert.equal(statsRes.status, 200);
    } finally {
      server.close();
    }
  });

  test('persists analytics data to JSON file and reloads safely on startup', () => {
    AN.counts.visits = 42;
    AN.counts.racesStarted = 17;
    AN.uniques.visitors = 12;
    AN.users = { 'user-1': { firstSeen: 20000, days: [20000, 20001] } };
    AN.cohorts = { '2026-09-01': { size: 10, d1: 5, d7: 2, d30: 1 } };
    AN.byMap = { '0': 10, '1': 7 };

    persistAnalytics(testStoragePath);
    assert.equal(fs.existsSync(testStoragePath), true);

    // Wipe memory
    AN.counts.visits = 0;
    AN.counts.racesStarted = 0;
    AN.uniques.visitors = 0;
    AN.users = {};
    AN.cohorts = {};
    AN.byMap = {};

    loadAnalytics(testStoragePath);

    assert.equal(AN.counts.visits, 42);
    assert.equal(AN.counts.racesStarted, 17);
    assert.equal(AN.uniques.visitors, 12);
    assert.equal(AN.cohorts['2026-09-01'].size, 10);
    assert.equal(AN.cohorts['2026-09-01'].d1, 5);
    assert.equal(AN.byMap['0'], 10);

    // Cleanup
    try { fs.unlinkSync(testStoragePath); } catch (e) {}
  });

  test('tracks phone controller connections with PID attribution and deduplicates unique controllers on reconnect', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // 1. Phone 1 connects for the first time
      const res1 = await fetch(`http://127.0.0.1:${port}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ e: 'ctrl', pid: 'ctrl-phone-alpha' })
      });
      assert.equal(res1.status, 200);

      let stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
      assert.equal(stats.counts.controllersConnected, 1, 'Event count should increment to 1');
      assert.equal(stats.uniques.controllerUsers, 1, 'Unique controller users should be 1');

      // 2. Phone 1 reconnects (e.g. after sleep / refresh) with the same PID
      await fetch(`http://127.0.0.1:${port}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ e: 'ctrl', pid: 'ctrl-phone-alpha' })
      });

      stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
      assert.equal(stats.counts.controllersConnected, 2, 'Total controller connections should increment to 2');
      assert.equal(stats.uniques.controllerUsers, 1, 'Unique controller users must stay 1 on reconnect');

      // 3. Phone 2 connects with a distinct PID
      await fetch(`http://127.0.0.1:${port}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ e: 'ctrl', pid: 'ctrl-phone-beta' })
      });

      stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
      assert.equal(stats.counts.controllersConnected, 3, 'Total controller connections should be 3');
      assert.equal(stats.uniques.controllerUsers, 2, 'Unique controller users should increment to 2');
    } finally {
      server.close();
    }
  });

  test('verifies cold module require loads existing analytics.json without TDZ ReferenceError', () => {
    const defaultAnPath = path.join(__dirname, '..', 'analytics.json');
    const mockData = {
      counts: { visits: 1337, racesStarted: 420 },
      uniques: { visitors: 999 },
      cohorts: { '2026-08-01': { size: 50, d1: 25, d7: 10, d30: 5 } }
    };
    fs.writeFileSync(defaultAnPath, JSON.stringify(mockData));

    // Clear require cache and re-require server to simulate clean cold start
    delete require.cache[require.resolve('../server.js')];
    const reloadedServer = require('../server.js');

    assert.equal(reloadedServer.AN.counts.visits, 1337, 'Cold require must restore saved visit counts');
    assert.equal(reloadedServer.AN.counts.racesStarted, 420, 'Cold require must restore saved race counts');
    assert.equal(reloadedServer.AN.uniques.visitors, 999, 'Cold require must restore unique visitor counts');
    assert.equal(reloadedServer.AN.cohorts['2026-08-01'].size, 50);

    // Cleanup default file
    try { fs.unlinkSync(defaultAnPath); } catch (e) {}
  });
});
