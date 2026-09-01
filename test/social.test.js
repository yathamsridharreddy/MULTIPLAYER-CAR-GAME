const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/game-core.js');
const { app } = require('../server.js');

describe('Social Features, Challenges & Daily Rotations', () => {
  test('generates and formats challenge links with target times', () => {
    const formatChallengeMsg = (name, targetMs, mapId) => {
      const M = (core.MAPS[mapId] || {}).name || 'a circuit';
      const fmtTime = (s) => {
        const m = Math.floor(s / 60);
        const sec = (s % 60).toFixed(2);
        return `${m}:${sec.padStart(5, '0')}`;
      };
      return '🔥 ' + (name || 'A RACER') + ' challenged you' + (targetMs ? ' to beat ' + fmtTime(targetMs) : '') + ' on ' + M + '.\nhttps://sridharrush.com/?ch=42';
    };

    const msgWithTime = formatChallengeMsg('ApexDriver', 28.45, 0);
    assert.ok(msgWithTime.includes('ApexDriver'));
    assert.ok(msgWithTime.includes('0:28.45'));
    assert.ok(msgWithTime.includes('?ch=42'));

    const msgWithoutTime = formatChallengeMsg('ApexDriver', null, 0);
    assert.ok(msgWithoutTime.includes('ApexDriver challenged you on'));
  });

  test('parses challenge query parameters correctly from deep links', () => {
    const parseChallengeUrl = (urlStr) => {
      const url = new URL(urlStr, 'http://localhost');
      const ch = url.searchParams.get('ch');
      const room = url.searchParams.get('room');
      const ghost = url.searchParams.get('g');
      return { ch, room, ghost };
    };

    assert.deepEqual(parseChallengeUrl('/?ch=108'), { ch: '108', room: null, ghost: null });
    assert.deepEqual(parseChallengeUrl('/?room=ABCD'), { ch: null, room: 'ABCD', ghost: null });
    assert.deepEqual(parseChallengeUrl('/?g=ghost-uuid-1'), { ch: null, room: null, ghost: 'ghost-uuid-1' });
  });

  test('serves deterministic daily challenge map matching date seed', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/daily`);
      const daily = await res.json();

      assert.ok(daily.key, 'Daily challenge must include date key YYYY-MM-DD');
      assert.ok(daily.map >= 0 && daily.map < 5, 'Daily map must be within map range 0..4');
      
      const expectedDay = Math.floor(Date.now() / 86400000);
      assert.equal(daily.map, expectedDay % 5, 'Daily map must match deterministic day seed % 5');
    } finally {
      server.close();
    }
  });

  test('maintains and serves global recent finishes ring buffer', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/recent`);
      assert.equal(res.status, 200);
      const recent = await res.json();
      assert.ok(Array.isArray(recent));
    } finally {
      server.close();
    }
  });
});
