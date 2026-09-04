const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, settleRace, dailyInfo, weeklyInfo } = require('../server.js');
const PROG = require('../shared/progression.js');
const CORE = require('../shared/game-core.js');

describe('Competitive Leaderboard, Anti-Cheat & Retention Math', () => {
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

  test('validates lap times against map-specific physical theoretical minimums (anti-cheat)', () => {
    // Check map 0 (Oval): minLap ~ 6.0s
    assert.strictEqual(PROG.isValidLapTime(0, 15.2), true);
    assert.strictEqual(PROG.isValidLapTime(0, 7.0), true);
    assert.strictEqual(PROG.isValidLapTime(0, 4.0), false, 'Under min lap should be rejected');
    assert.strictEqual(PROG.isValidLapTime(0, 0), false, 'Zero should be rejected');
    assert.strictEqual(PROG.isValidLapTime(0, -10), false, 'Negative should be rejected');
    assert.strictEqual(PROG.isValidLapTime(0, NaN), false, 'NaN should be rejected');
    assert.strictEqual(PROG.isValidLapTime(0, 700), false, 'Excessive time > 600s should be rejected');

    // Also supports millisecond values
    assert.strictEqual(PROG.isValidLapTime(0, 15200), true);
    assert.strictEqual(PROG.isValidLapTime(0, 4000), false);

    // Check map 1 (Grand Prix): minLap ~ 10.0s
    assert.strictEqual(PROG.isValidLapTime(1, 22.5), true);
    assert.strictEqual(PROG.isValidLapTime(1, 8.0), false, 'Under GP min lap should be rejected');

    // Check map 2 (Technical): minLap ~ 12.0s
    assert.strictEqual(PROG.isValidLapTime(2, 28.0), true);
    assert.strictEqual(PROG.isValidLapTime(2, 9.0), false, 'Under Technical min lap should be rejected');
  });

  test('weekly points calculation awards deterministic tier points with fastest lap bonus', () => {
    assert.strictEqual(PROG.weeklyPointsForPos(1, 2, false), 25);
    assert.strictEqual(PROG.weeklyPointsForPos(1, 2, true), 30); // 25 + 5 fastest lap
    assert.strictEqual(PROG.weeklyPointsForPos(2, 2, false), 18);
    assert.strictEqual(PROG.weeklyPointsForPos(3, 4, false), 15);
    assert.strictEqual(PROG.weeklyPointsForPos(4, 4, false), 12);
    assert.strictEqual(PROG.weeklyPointsForPos(5, 6, false), 10);
    assert.strictEqual(PROG.weeklyPointsForPos(6, 6, false), 8);
    assert.strictEqual(PROG.weeklyPointsForPos(7, 8, false), 5);
    assert.strictEqual(PROG.weeklyPointsForPos(0, 2, false), 0);
  });

  test('calculates global percentiles accurately', () => {
    assert.strictEqual(PROG.calculatePercentile(1, 100), 1.0);
    assert.strictEqual(PROG.calculatePercentile(50, 100), 50.0);
    assert.strictEqual(PROG.calculatePercentile(10, 1000), 1.0);
    assert.strictEqual(PROG.calculatePercentile(1, 1), 1.0);
    assert.strictEqual(PROG.calculatePercentile(1, 0), 1.0);
  });

  test('computes nearby ranking bracket ("Around Me") correctly', () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));

    // Target is rank #10 (id: 'p10') with radius 2 -> returns 5 items (indices 7 to 11, ranks 8 to 12)
    const mid = PROG.getNearbyBracket(list, 'p10', 2);
    assert.strictEqual(mid.targetRank, 10);
    assert.strictEqual(mid.bracket.length, 5);
    assert.strictEqual(mid.bracket[0].item.id, 'p8');
    assert.strictEqual(mid.bracket[0].rank, 8);
    assert.strictEqual(mid.bracket[2].item.id, 'p10');
    assert.strictEqual(mid.bracket[2].rank, 10);
    assert.strictEqual(mid.bracket[4].item.id, 'p12');
    assert.strictEqual(mid.bracket[4].rank, 12);

    // Target is rank #1 (id: 'p1') -> clamped at start (ranks 1 to 5)
    const top = PROG.getNearbyBracket(list, 'p1', 2);
    assert.strictEqual(top.targetRank, 1);
    assert.strictEqual(top.bracket.length, 5);
    assert.strictEqual(top.bracket[0].rank, 1);
    assert.strictEqual(top.bracket[4].rank, 5);

    // Target is rank #20 (id: 'p20') -> clamped at end (ranks 16 to 20)
    const bot = PROG.getNearbyBracket(list, 'p20', 2);
    assert.strictEqual(bot.targetRank, 20);
    assert.strictEqual(bot.bracket.length, 5);
    assert.strictEqual(bot.bracket[0].rank, 16);
    assert.strictEqual(bot.bracket[4].rank, 20);

    // Target not found -> returns top slice with targetRank = -1
    const unk = PROG.getNearbyBracket(list, 'unknown_player', 2);
    assert.strictEqual(unk.targetRank, -1);
    assert.strictEqual(unk.bracket.length, 5);
    assert.strictEqual(unk.bracket[0].rank, 1);
  });

  test('serves global rating leaderboard via /api/leaderboard?type=rating', async () => {
    const res = await httpGet('/api/leaderboard?type=rating');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.type, 'rating');
    assert.ok(Array.isArray(res.json.rows));
    assert.ok(res.json.rows.length > 0);
    const top = res.json.rows[0];
    assert.strictEqual(top.rank, 1);
    assert.ok(top.rating >= 1200);
    assert.ok(top.tier && top.tier.name);
  });

  test('serves map track record leaderboards via /api/leaderboard?type=time', async () => {
    const res = await httpGet('/api/leaderboard?type=time&map=0');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.type, 'time');
    assert.strictEqual(res.json.map, 0);
    assert.ok(Array.isArray(res.json.rows));
    assert.ok(res.json.rows.length > 0);
    const top = res.json.rows[0];
    assert.strictEqual(top.rank, 1);
    assert.ok(top.timeFormatted);
  });

  test('serves daily competition cup info via /api/competitions/daily', async () => {
    const res = await httpGet('/api/competitions/daily');
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.dateKey);
    assert.ok(res.json.mapName);
    assert.ok(res.json.endsInFormatted);
    assert.ok(Array.isArray(res.json.leaderboard));
    assert.strictEqual(res.json.rewards.first, '+150 XP, +100 Coins, Daily Champion Badge');
  });

  test('serves weekly Founders Cup competition via /api/competitions/weekly', async () => {
    const res = await httpGet('/api/competitions/weekly');
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.weekKey);
    assert.ok(res.json.endsInFormatted);
    assert.ok(Array.isArray(res.json.leaderboard));
    assert.strictEqual(res.json.name, 'Founders Cup');
  });

  test('serves aggregated competitive stats for a player profile via /api/player/competitive-stats', async () => {
    const res = await httpGet('/api/player/competitive-stats?uid=test_racer_1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.name, 'test_racer_1');
    assert.ok(res.json.rating >= 1000);
    assert.ok(res.json.tier && res.json.tier.name);
    assert.ok(typeof res.json.globalRank === 'number');
    assert.ok(typeof res.json.winRate === 'string');
    assert.ok(typeof res.json.bestTimes === 'object');
  });

  test('settles race results, records weekly points and daily challenge records authoritatively', async () => {
    const room = {
      code: 'TESTCOMP',
      map: 0,
      mapId: 0,
      mode: 'race',
      players: [
        { slot: 1, name: 'ChampionRacer', token: null, isBot: false },
        { slot: 2, name: 'RivalRacer', token: null, isBot: false },
      ],
      cars: [
        { id: 1, slot: 1, progress: 3, finished: true, finishTime: 47.7, best: 15.4, lapTimes: [16.5, 15.8, 15.4] },
        { id: 2, slot: 2, progress: 3, finished: true, finishTime: 50.6, best: 16.5, lapTimes: [17.2, 16.9, 16.5] },
      ],
      order: [
        { slot: 1, name: 'ChampionRacer', t: 47.7, best: 15.4, p: 1, finished: true, finishTime: 47.7, participating: true },
        { slot: 2, name: 'RivalRacer', t: 50.6, best: 16.5, p: 2, finished: true, finishTime: 50.6, participating: true },
      ],
      ai: false,
    };

    const settlement = await settleRace(room);
    assert.ok(Array.isArray(settlement));
    assert.strictEqual(settlement.length, 2);

    const p1 = settlement.find((s) => s.slot === 1);
    const p2 = settlement.find((s) => s.slot === 2);

    assert.strictEqual(p1.pos, 1);
    assert.strictEqual(p1.weeklyPts, 30); // 25 for 1st + 5 for fastest lap
    assert.ok(p1.rd > 0, 'Winner should gain rating');
    assert.ok(p1.xp > 0, 'Winner should gain XP');
    assert.ok(p1.coins > 0, 'Winner should gain coins');

    assert.strictEqual(p2.pos, 2);
    assert.strictEqual(p2.weeklyPts, 18); // 18 for 2nd
    assert.ok(p2.rd < 0, 'Loser should lose rating');

    // Check that weekly competition records were updated
    const wRes = await httpGet('/api/competitions/weekly?uid=ChampionRacer');
    assert.strictEqual(wRes.status, 200);
    const champEntry = wRes.json.leaderboard.find((e) => e.name === 'ChampionRacer');
    assert.ok(champEntry, 'Champion should appear in weekly leaderboard');
    assert.ok(champEntry.points >= 30);
    assert.ok(champEntry.wins >= 1);
  });
});
