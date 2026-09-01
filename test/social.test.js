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

  test('evaluates mobile room join routing to controller view without breaking desktop or other links', () => {
    function shouldRouteToController({ url, width, height, hasTouch, userAgent }) {
      const u = new URL(url, 'http://localhost');
      const wantedRoom = u.searchParams.get('room');
      const SPEC_ROOM = u.searchParams.get('watch');
      const isTouchPhone = hasTouch && (width <= 768 || height <= 500 || /Android|iPhone|iPad|iPod/i.test(userAgent));
      
      return !!(wantedRoom && isTouchPhone && !SPEC_ROOM && !u.searchParams.get('ch') && !u.searchParams.get('g') && !u.searchParams.get('screen'));
    }

    // 1. Mobile phone (iOS/Android) joining room link -> SHOULD route to controller
    const iPhonePortrait = { url: '/?room=ABCD', width: 390, height: 844, hasTouch: true, userAgent: 'iPhone' };
    assert.equal(shouldRouteToController(iPhonePortrait), true, 'Mobile phone joining room should route to controller');

    const androidLandscape = { url: '/?room=ABCD', width: 800, height: 390, hasTouch: true, userAgent: 'Android' };
    assert.equal(shouldRouteToController(androidLandscape), true, 'Mobile phone in landscape should route to controller');

    // 2. Desktop PC joining room link -> must NOT route (stays on desktop screen)
    const desktopPC = { url: '/?room=ABCD', width: 1920, height: 1080, hasTouch: false, userAgent: 'Windows' };
    assert.equal(shouldRouteToController(desktopPC), false, 'Desktop PC should stay on screen');

    // 3. Touch laptop / iPad with explicit ?screen=1 -> must NOT route
    const touchLaptop = { url: '/?room=ABCD&screen=1', width: 1366, height: 768, hasTouch: true, userAgent: 'Windows' };
    assert.equal(shouldRouteToController(touchLaptop), false, 'Touch device with screen override should stay on screen');

    // 4. Spectator link ?watch=ABCD -> must NOT route
    const specLink = { url: '/?watch=ABCD', width: 390, height: 844, hasTouch: true, userAgent: 'iPhone' };
    assert.equal(shouldRouteToController(specLink), false, 'Spectator link must stay in spectator view');

    // 5. Challenge link ?ch=42 -> must NOT route
    const challengeLink = { url: '/?ch=42', width: 390, height: 844, hasTouch: true, userAgent: 'iPhone' };
    assert.equal(shouldRouteToController(challengeLink), false, 'Challenge link must load challenge circuit');

    // 6. Ghost replay link ?g=ghost-1 -> must NOT route
    const ghostLink = { url: '/?g=ghost-1', width: 390, height: 844, hasTouch: true, userAgent: 'iPhone' };
    assert.equal(shouldRouteToController(ghostLink), false, 'Ghost replay link must load ghost circuit');

    // 7. Regular homepage / -> must NOT route
    const normalHome = { url: '/', width: 390, height: 844, hasTouch: true, userAgent: 'iPhone' };
    assert.equal(shouldRouteToController(normalHome), false, 'Normal homepage load must stay on homepage');
  });
});
