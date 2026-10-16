'use strict';
/* ============================================================================
   v177 — LOCAL DUEL: two seats, two drivers, no takeover.

   Reported symptoms, in the player's words:
     "local dual player joining and cars override, shaking is more,
      optimization needed, use 2 players only"
   This file pins the AUTHORITY side of the fix (the relay + the shared room
   model). The matching client side (the split camera and the setup state) lives
   in local-duel-view.test.js.

   What was wrong, and what these tests prove now:

     1. A Local Duel was created with the default capacity of SIX and with
        `bot: true`, so RaceRoom._begin() filled the four empty seats with AI
        cars. Pinned: a duel room holds exactly two cars, and with the AI fill
        off only the seated humans participate.
     2. Two phones scanning the SAME QR (the link carries the screen's own slot,
        &slot=1) both asked for seat 1. The second one closed the first one's
        socket and took the car, so the duel could never fill its second seat.
        Pinned: a live seat owned by a different phone is respected, the newcomer
        takes the free seat, and the first phone keeps driving its own car.
     3. Inputs must stay on their own car and must not be cross-wired.
   ========================================================================== */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/game-core.js');
const { rooms, newRoom, joinRoom, handleMessage, handleLeave } = require('../server.js');

function mockWS() {
  const ws = {
    readyState: 1, sent: [],
    send(d) { this.sent.push(typeof d === 'string' ? JSON.parse(d) : d); },
    close() { this.readyState = 3; if (this.onclose) this.onclose(); },
    lastSent() { return this.sent[this.sent.length - 1] || null; },
    findSent(type) { return this.sent.filter((m) => m && m.type === type); }
  };
  return ws;
}
function client(ws, pid, name) { return { ws, entry: null, slot: 0, role: null, pid, name }; }
// The exact payload the v177 client sends for Local Duel (game.js duelRoomOpts).
const DUEL_OPTS = { cap: 2, bot: false };

describe('v177 Local Duel — exactly two seats, and no AI fill', () => {
  beforeEach(() => { rooms.clear(); });

  test('a Local Duel room has two cars, not six', () => {
    const entry = newRoom('race', 0, 2);
    assert.equal(entry.room.cap, 2);
    assert.equal(entry.room.cars.length, 2);
    assert.deepEqual(Object.keys(entry.room.inputs).sort(), ['1', '2'], 'the input table is bounded by the cap');
  });

  test('the creating payload carries cap 2 and the AI fill off (and reaches the room)', async () => {
    const ws = mockWS();
    const host = client(ws, 'host-pid', 'HOST');
    await handleMessage(host, Object.assign({ type: 'create_room', mode: 'race', map: 0, laps: 3 }, DUEL_OPTS));
    const room = host.entry.room;
    assert.equal(room.cap, 2, 'the relay honoured the requested capacity');
    assert.equal(room.cars.length, 2);
    assert.equal(room.bot, false, 'no AI fill in a duel room');
  });

  test('a one-tap START builds the same two-seat room (on-demand path)', async () => {
    const ws = mockWS();
    const host = client(ws, 'host-pid', 'HOST');
    await handleMessage(host, { type: 'hello', role: 'screen', lobby: true, pid: 'host-pid' });
    await handleMessage(host, Object.assign({ type: 'start', mode: 'race', map: 0, laps: 3 }, DUEL_OPTS));
    const room = host.entry.room;
    assert.equal(room.cap, 2);
    assert.equal(room.cars.length, 2);
    assert.equal(room.bot, false);
  });

  test('without the duel payload the relay behaves exactly as before (6 seats, AI fill)', async () => {
    const ws = mockWS();
    const host = client(ws, 'host-pid', 'HOST');
    await handleMessage(host, { type: 'create_room', mode: 'race', map: 0, laps: 3, bot: true });
    const room = host.entry.room;
    assert.equal(room.cap, 6, 'every other mode keeps the 6-seat room');
    assert.equal(room.cars.length, 6);
    assert.equal(room.bot, true);
  });

  test('two seated humans and the AI fill off = exactly two participating cars', async () => {
    const ws = mockWS();
    const host = client(ws, 'host-pid', 'HOST');
    await handleMessage(host, Object.assign({ type: 'create_room', mode: 'race', map: 0, laps: 3 }, DUEL_OPTS));
    const entry = host.entry;
    // both phones scan the SAME QR, which carries the screen's own slot (&slot=1)
    const aws = mockWS();
    await handleMessage(client(aws, 'phone-1', 'P1'), { type: 'hello', role: 'controller', room: entry.room.code, pid: 'phone-1', slot: 1 });
    const cws = mockWS();
    const phone = client(cws, 'phone-2', 'P2');
    await handleMessage(phone, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'phone-2', slot: 1 });

    entry.room.start();
    for (let i = 0; i < 130; i++) entry.room.update(1 / 30);
    const parts = entry.room.cars.filter((c) => c.participating);
    assert.equal(parts.length, 2, 'two cars on the grid');
    assert.equal(entry.room.cars.filter((c) => c._bot).length, 0, 'and not one of them is an AI');
    assert.equal(parts[0].slot, 1);
    assert.equal(parts[1].slot, 2);
  });

  test('with one driver seated, exactly one car participates — which is why the client refuses to start silently', async () => {
    const ws = mockWS();
    const host = client(ws, 'host-pid', 'HOST');
    await handleMessage(host, Object.assign({ type: 'create_room', mode: 'race', map: 0, laps: 3 }, DUEL_OPTS));
    const room = host.entry.room;
    room.start();
    for (let i = 0; i < 130; i++) room.update(1 / 30);
    const parts = room.cars.filter((c) => c.participating);
    assert.equal(parts.length, 1, 'the old build filled this gap with an AI car; the room simply has one car now');
    assert.equal(parts[0].slot, 1);
    assert.equal(room.cars.filter((c) => c._bot).length, 0);
  });
});

describe('v177 Local Duel — seat ownership (a phone may never lose its car to another phone)', () => {
  beforeEach(() => { rooms.clear(); });

  async function duelRoom() {
    const ws = mockWS();
    const host = client(ws, 'host-pid', 'HOST');
    await handleMessage(host, Object.assign({ type: 'create_room', mode: 'race', map: 0, laps: 3 }, DUEL_OPTS));
    return host.entry;
  }

  test('two phones asking for seat 1 (the QR carries &slot=1) end up on seats 1 and 2', async () => {
    const entry = await duelRoom();
    const aWs = mockWS(); const phoneA = client(aWs, 'phone-A', 'P1');
    const bWs = mockWS(); const phoneB = client(bWs, 'phone-B', 'P2');
    await handleMessage(phoneA, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'phone-A', slot: 1 });
    await handleMessage(phoneB, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'phone-B', slot: 1 });

    assert.equal(phoneA.slot, 1, 'the first phone keeps the seat it claimed');
    assert.equal(aWs.readyState, 1, 'and its socket is still open');
    assert.equal(phoneB.slot, 2, 'the second phone is moved to the free seat instead of stealing seat 1');
    assert.equal(entry.room.controllers[1], true);
    assert.equal(entry.room.controllers[2], true, 'both seats are driven — which the old build could never reach');
  });

  test('the same phone reconnecting still replaces its own stale socket (v77 behaviour kept)', async () => {
    const entry = await duelRoom();
    const oldWs = mockWS(); const oldPhone = client(oldWs, 'phone-A', 'P1');
    await handleMessage(oldPhone, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'phone-A', slot: 1 });
    const newWs = mockWS(); const newPhone = client(newWs, 'phone-A', 'P1');
    await handleMessage(newPhone, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'phone-A', slot: 1 });
    assert.equal(newPhone.slot, 1);
    assert.equal(oldWs.readyState, 3, 'the stale socket for the same physical phone was closed');
    assert.equal(entry.room.controllers[1], true);
  });

  test('a third phone in a two-seat room is refused, not seated on someone else', async () => {
    const entry = await duelRoom();
    for (const s of [1, 2]) {
      const ws = mockWS();
      await handleMessage(client(ws, 'pid-' + s, 'P' + s), { type: 'hello', role: 'controller', room: entry.room.code, pid: 'pid-' + s, slot: s });
    }
    const thirdWs = mockWS();
    const third = client(thirdWs, 'pid-3', 'P3');
    await handleMessage(third, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'pid-3', slot: 1 });
    assert.equal(third.slot, 0);
    assert.equal(thirdWs.findSent('full').length, 1, 'the phone is told the room is full');
    assert.equal(entry.room.controllers[1], true, 'and no live seat was taken from a driver');
    assert.equal(entry.room.controllers[2], true);
  });

  test('a controller leaving zeroes its input and hands the car to nobody', async () => {
    const entry = await duelRoom();
    const ws1 = mockWS(); const p1 = client(ws1, 'pid-1', 'P1');
    const ws2 = mockWS(); const p2 = client(ws2, 'pid-2', 'P2');
    await handleMessage(p1, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'pid-1', slot: 1 });
    await handleMessage(p2, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'pid-2', slot: 2 });
    entry.room.start();
    for (let i = 0; i < 130; i++) entry.room.update(1 / 30);

    handleLeave(p2);
    assert.equal(entry.room.controllers[2], false, 'seat 2 has no controller');
    const input = entry.room.inputs[2];
    assert.equal(input.throttle, 0);
    assert.equal(input.steer, 0);
    assert.equal(entry.room.cars.filter((c) => c._bot).length, 0, 'the empty seat is not handed to an AI');
    assert.equal(entry.room.cars[1].participating, true, 'car 2 stays in the race, parked');
  });
});

describe('v177 Local Duel — input isolation between the two drivers', () => {
  beforeEach(() => { rooms.clear(); });

  async function twoDriverDuel() {
    const ws = mockWS();
    const host = client(ws, 'host-pid', 'HOST');
    await handleMessage(host, Object.assign({ type: 'create_room', mode: 'race', map: 0, laps: 3 }, DUEL_OPTS));
    const entry = host.entry;
    // the realistic two-phone setup: the P1 QR (slot 1) and the second phone
    // joining the same code gives the relay the first free seat it can find
    const ws1 = mockWS(); const p1 = client(ws1, 'pid-1', 'P1');
    const ws2 = mockWS(); const p2 = client(ws2, 'pid-2', 'P2');
    await handleMessage(p1, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'pid-1', slot: 1 });
    await handleMessage(p2, { type: 'hello', role: 'controller', room: entry.room.code, pid: 'pid-2' });
    assert.equal(p1.slot, 1);
    assert.equal(p2.slot, 2, 'the second phone took the free seat');
    return { entry, host, p1, p2 };
  }

  test('simultaneous opposite inputs stay on their own car', async () => {
    const { entry, p1, p2 } = await twoDriverDuel();
    await handleMessage(p1, { type: 'input', steer: 1, throttle: 1, brake: 0 });
    await handleMessage(p2, { type: 'input', steer: -1, throttle: 0.5, brake: 0 });

    assert.equal(entry.room.inputs[1].steer, 1);
    assert.equal(entry.room.inputs[1].throttle, 1);
    assert.equal(entry.room.inputs[2].steer, -1);
    assert.equal(entry.room.inputs[2].throttle, 0.5);

    entry.room.start();
    for (let i = 0; i < 130; i++) entry.room.update(1 / 30);
    entry.room.applyInputs();
    assert.equal(entry.room.cars[0].input.steer, 1, 'car 1 steers right');
    assert.equal(entry.room.cars[1].input.steer, -1, 'car 2 steers left');

    for (let i = 0; i < 45; i++) entry.room.update(1 / 30);
    assert.notEqual(entry.room.cars[0].x, entry.room.cars[1].x, 'the two cars drive independently');
    const h1 = entry.room.cars[0].heading, h2 = entry.room.cars[1].heading;
    assert.ok(h1 !== h2, 'and their headings differ under opposite steering');
  });

  test('the screen cannot write into a seat a phone owns', async () => {
    const { entry, host, p2 } = await twoDriverDuel();
    // seat 1 is driven by a phone: the screen's own keyboard must not fight it
    await handleMessage(host, { type: 'input', steer: -1, throttle: 1, brake: 0 });
    assert.notEqual(entry.room.inputs[1].steer, -1, 'the screen input was ignored for the owned seat');

    // the owner can still drive its own car
    await handleMessage(p2, { type: 'input', steer: 0.4, throttle: 1, brake: 0 });
    assert.equal(entry.room.inputs[2].steer, 0.4);
  });

  test('repeated start / reset / start leaves two cars, two drivers and no ghost player', async () => {
    const { entry, p1, p2 } = await twoDriverDuel();
    for (let round = 0; round < 3; round++) {
      entry.room.start();
      for (let i = 0; i < 130; i++) entry.room.update(1 / 30);
      assert.equal(entry.room.cars.length, 2, 'round ' + round + ': still two cars');
      assert.equal(entry.room.cars.filter((c) => c.participating).length, 2, 'round ' + round + ': both cars race');
      assert.equal(entry.room.cars.filter((c) => c._bot).length, 0, 'round ' + round + ': no AI appeared');
      assert.deepEqual(Object.keys(entry.room.controllers).filter((k) => entry.room.controllers[k]).map(Number).sort(), [1, 2],
        'round ' + round + ': the same two phones still own the same two seats');
      await handleMessage(p1, { type: 'input', steer: 0, throttle: 1, brake: 0 });
      await handleMessage(p2, { type: 'input', steer: 0, throttle: 1, brake: 0 });
      entry.room.resetToWaiting();
      assert.equal(entry.room.state, 'waiting', 'round ' + round + ': back in the lobby state');
      assert.equal(entry.room.winner, null);
      assert.ok(entry.room.cars.every((c) => c.lap === 0 && !c.finished && c.forwardSpeed() === 0),
        'round ' + round + ': every car is back on the grid');
    }
  });

  test('a duel room never carries fighter state, and a plain room is untouched by the duel rules', async () => {
    const { entry } = await twoDriverDuel();
    entry.room.start();
    assert.equal(entry.room.fx, null, 'no fighter state in a race room');
    assert.equal(entry.room.mode, 'race');
    const other = newRoom('race', 0, 6);
    assert.equal(other.room.cap, 6, 'other modes keep six seats');
    assert.equal(other.room.cars.length, 6);
  });
});
