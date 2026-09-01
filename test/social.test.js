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

  test('parses and validates guest personal challenges while rejecting malformed inputs and maintaining unverified status', () => {
    function parseGuestChallenge(urlSearch) {
      try {
        const u = new URLSearchParams(urlSearch);
        const pch = u.get('pch') || (u.get('ch') && !/^\d+$/.test(u.get('ch')) ? u.get('ch') : null);
        if (!pch) return null;
        let m = pch.match(/^(?:m)?([0-4])_(?:t)?(\d{3,7})_(.+)$/i);
        if (!m) m = pch.match(/(?:map:)?([0-4]):(?:t:)?(\d{3,7}):(?:name:)?(.+)/i);
        if (!m) return null;
        const map = parseInt(m[1], 10);
        const targetMs = parseInt(m[2], 10);
        const name = decodeURIComponent(m[3]).replace(/[<>]/g, '').trim().slice(0, 14) || 'A RACER';
        if (isNaN(map) || map < 0 || map > 4) return null;
        if (isNaN(targetMs) || targetMs < 1000 || targetMs > 600000) return null;
        return { map, targetMs, name, verified: false };
      } catch (e) {
        return null;
      }
    }

    // 1. Valid standard guest challenge
    const validPch = parseGuestChallenge('?pch=0_38420_ApexDriver');
    assert.deepEqual(validPch, {
      map: 0,
      targetMs: 38420,
      name: 'ApexDriver',
      verified: false
    }, 'Must correctly parse valid guest personal challenge');

    // 2. Valid with prefix m0_t42000
    const validPrefixed = parseGuestChallenge('?pch=m1_t42000_Vortex');
    assert.deepEqual(validPrefixed, {
      map: 1,
      targetMs: 42000,
      name: 'Vortex',
      verified: false
    });

    // 3. Valid with fallback map:X:t:Y
    const validColon = parseGuestChallenge('?pch=map:2:t:55120:name:Speedy');
    assert.deepEqual(validColon, {
      map: 2,
      targetMs: 55120,
      name: 'Speedy',
      verified: false
    });

    // 4. Sanitizes XSS characters from name
    const xssAttempt = parseGuestChallenge('?pch=0_30000_%3Cscript%3EHacker%3C%2Fscript%3E');
    assert.equal(xssAttempt.name, 'scriptHacker/s', 'Angle brackets must be stripped and length capped');

    // 5. Rejects out-of-bounds map IDs (> 4 or < 0)
    assert.equal(parseGuestChallenge('?pch=5_38000_Driver'), null, 'Map 5 must be rejected');
    assert.equal(parseGuestChallenge('?pch=-1_38000_Driver'), null, 'Negative map must be rejected');

    // 6. Rejects out-of-bounds target times (< 1000ms or > 600000ms)
    assert.equal(parseGuestChallenge('?pch=0_500_Cheater'), null, '500ms target must be rejected');
    assert.equal(parseGuestChallenge('?pch=0_999999999_Driver'), null, 'Unrealistic huge time must be rejected');
    assert.equal(parseGuestChallenge('?pch=0_-38000_Driver'), null, 'Negative time must be rejected');

    // 7. Rejects malformed strings
    assert.equal(parseGuestChallenge('?pch=invalid_random_string'), null);
    assert.equal(parseGuestChallenge('?pch='), null);
    assert.equal(parseGuestChallenge(''), null);
  });

  test('formats actionable result-to-challenge share links with context and prevents bare homepage leaks', () => {
    function generateSharePayload({ myTime, mapId, racerName, isAuth, authChId }) {
      const M = (core.MAPS[mapId] || {}).name || 'Circuit';
      const fmtTime = (s) => {
        const m = Math.floor(s / 60);
        const sec = (s % 60).toFixed(2);
        return `${m}:${sec.padStart(5, '0')}`;
      };
      const timeStr = myTime != null ? fmtTime(myTime) : 'DNF';
      let link;

      if (isAuth && authChId) {
        link = `https://sridharrush.com/?ch=${authChId}`;
      } else {
        const safeName = encodeURIComponent((racerName || 'A RACER').slice(0, 14));
        const targetMs = myTime ? Math.round(myTime * 1000) : 0;
        link = `https://sridharrush.com/?pch=${mapId}_${targetMs}_${safeName}`;
      }

      const msg = `🔥 ${racerName || 'A RACER'} challenged you to beat ${timeStr} on ${M}!\nCan you beat my time? Race now: ${link}`;
      return { msg, link };
    }

    // Guest share link test
    const guestShare = generateSharePayload({ myTime: 38.42, mapId: 0, racerName: 'ApexDriver', isAuth: false });
    assert.ok(guestShare.msg.includes('ApexDriver challenged you'));
    assert.ok(guestShare.msg.includes('0:38.42'));
    assert.ok(guestShare.msg.toLowerCase().includes('highland rush'));
    assert.ok(guestShare.link.includes('?pch=0_38420_ApexDriver'));
    assert.notEqual(guestShare.link, 'https://sridharrush.com/', 'Must never share bare homepage URL');

    // Authenticated share link test
    const authShare = generateSharePayload({ myTime: 38.42, mapId: 0, racerName: 'ApexDriver', isAuth: true, authChId: 77 });
    assert.ok(authShare.link.includes('?ch=77'));
    assert.notEqual(authShare.link, 'https://sridharrush.com/');
  });

  test('translates on-screen mobile solo touch inputs accurately into deterministic 30Hz input frame', () => {
    function buildInputFrame(keysSet, touchInput, gamepadInput) {
      let steer = (keysSet.has('ArrowLeft') || keysSet.has('KeyA') || touchInput.l ? -1 : 0) +
                  (keysSet.has('ArrowRight') || keysSet.has('KeyD') || touchInput.r ? 1 : 0);
      let throttle = (keysSet.has('ArrowUp') || keysSet.has('KeyW') || touchInput.u) ? 1 : 0;
      let brake = (keysSet.has('ArrowDown') || keysSet.has('KeyS') || touchInput.d) ? 1 : 0;
      let handbrake = keysSet.has('Space'), nitro = keysSet.has('ShiftLeft') || keysSet.has('ShiftRight') || touchInput.nitro;

      if (gamepadInput) {
        if (gamepadInput.steer) steer = gamepadInput.steer;
        throttle = Math.max(throttle, gamepadInput.throttle);
        brake = Math.max(brake, gamepadInput.brake);
        handbrake = handbrake || gamepadInput.handbrake;
        nitro = nitro || gamepadInput.nitro;
      }
      return { steer, throttle, brake, handbrake, nitro };
    }

    // 1. Touch steer left + gas
    const touchLeftGas = buildInputFrame(new Set(), { l: 1, r: 0, u: 1, d: 0, nitro: false }, null);
    assert.deepEqual(touchLeftGas, { steer: -1, throttle: 1, brake: 0, handbrake: false, nitro: false });

    // 2. Touch steer right + nitro
    const touchRightNitro = buildInputFrame(new Set(), { l: 0, r: 1, u: 1, d: 0, nitro: true }, null);
    assert.deepEqual(touchRightNitro, { steer: 1, throttle: 1, brake: 0, handbrake: false, nitro: true });

    // 3. Touch brake
    const touchBrake = buildInputFrame(new Set(), { l: 0, r: 0, u: 0, d: 1, nitro: false }, null);
    assert.deepEqual(touchBrake, { steer: 0, throttle: 0, brake: 1, handbrake: false, nitro: false });

    // 4. Desktop keyboard overrides when present
    const kbDrive = buildInputFrame(new Set(['KeyW', 'KeyD', 'ShiftLeft']), { l: 0, r: 0, u: 0, d: 0, nitro: false }, null);
    assert.deepEqual(kbDrive, { steer: 1, throttle: 1, brake: 0, handbrake: false, nitro: true });
  });

  test('generates valid WhatsApp and Telegram lobby invite URLs with room parameters', () => {
    function getLobbyShareUrls({ origin, roomCode, gameLink }) {
      const link = gameLink || (roomCode ? `${origin}/?room=${roomCode}` : `${origin}/`);
      const waMsg = `🏎️ Race with me in Sridhar Rush! Join my room here: ${link}`;
      const waUrl = 'https://wa.me/?text=' + encodeURIComponent(waMsg);

      const tgText = '🏎️ Race with me in Sridhar Rush!';
      const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(tgText)}`;

      return { waUrl, tgUrl, link };
    }

    const { waUrl, tgUrl, link } = getLobbyShareUrls({
      origin: 'https://sridharrush.com',
      roomCode: 'ALPHA',
      gameLink: 'https://sridharrush.com/?room=ALPHA&map=2'
    });

    assert.ok(waUrl.startsWith('https://wa.me/?text='));
    assert.ok(waUrl.includes(encodeURIComponent('https://sridharrush.com/?room=ALPHA&map=2')));
    assert.ok(tgUrl.startsWith('https://t.me/share/url?url='));
    assert.ok(tgUrl.includes(encodeURIComponent('https://sridharrush.com/?room=ALPHA&map=2')));
    assert.ok(tgUrl.includes(encodeURIComponent('🏎️ Race with me in Sridhar Rush!')));
  });
});

