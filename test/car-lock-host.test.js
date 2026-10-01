'use strict';
/* ============================================================================
   v155 — one car per racer, and one racer in charge of the race.

   Two rules, both enforced where they cannot be worked around:

     1. a car belongs to one racer. The colour IS the car in this game (it picks
        the model), so two seats holding one colour is two racers driving the
        same car. A racer arriving takes the first car nobody has; a racer
        changing car mid-lobby is refused a car somebody else is in.
     2. the room creator owns the circuit, the weather, the lap count and the AI
        rival. Everyone else in the room can pick a car and nothing else.

   The tests drive the real relay through handleMessage/joinRoom, so what is
   asserted is the authority the clients actually get, not a helper in isolation.
   ========================================================================== */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/game-core.js');
const { rooms, joinRoom, handleMessage, newRoom } = require('../server.js');

function createMockWS() {
  return {
    readyState: 1,
    sent: [],
    send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); },
    close() { this.readyState = 3; },
    lastSent() { return this.sent[this.sent.length - 1] || null; },
    findSent(type) { return this.sent.filter((m) => m && m.type === type); },
    errors(code) { return this.sent.filter((m) => m && m.type === 'error' && m.code === code); }
  };
}

// A screen joining a room the way the real client does: one `hello` carrying the
// racer's identity, which is what seats them AND what claims their car.
function seat(entry, pid, opts) {
  const ws = createMockWS();
  const client = { ws, entry: null, slot: 0, role: null, pid, name: pid };
  handleMessage(client, Object.assign({
    type: 'hello', role: 'screen', room: entry.room.code, pid, name: pid
  }, opts || {}));
  return client;
}

const carOf = (entry, client) => entry.room.cars[client.slot - 1];

describe('v155 — one car, one racer', () => {
  beforeEach(() => { rooms.clear(); });

  test('a racer arriving in an occupied car is moved to a free one', () => {
    const entry = newRoom('race', 0, 6);
    const first = seat(entry, 'p-1', { color: 0xe10600 });
    assert.equal(carOf(entry, first).color, 0xe10600, 'the first racer keeps the car they asked for');

    // second racer saved the same car in their preferences
    const second = seat(entry, 'p-2', { color: 0xe10600 });
    assert.notEqual(carOf(entry, second).color, 0xe10600, 'a taken car is never handed to a second racer');
    assert.ok(core.CAR_PALETTE.includes(carOf(entry, second).color), 'and they get a real car from the palette');

    // ...and they are told, rather than silently driving something else
    const told = second.ws.errors('car-taken');
    assert.equal(told.length, 1, 'the arriving racer is told their car was taken');
    assert.equal(told[0].wanted, 0xe10600, 'the refusal names the car they wanted');
    assert.equal(told[0].assigned, true, 'and says the car they got is a substitution');
    assert.equal(told[0].color, carOf(entry, second).color, 'the car they are actually in');
    assert.equal(told[0].slot, 1, 'and who has the one they wanted');
  });

  test('every racer on the grid ends up in a different car', () => {
    const entry = newRoom('race', 0, 6);
    // all six saves the same favourite car - a realistic worst case after a
    // rebalance, and the case that used to put six identical cars on the grid
    const clients = [];
    for (let i = 1; i <= 6; i++) clients.push(seat(entry, 'p-' + i, { color: 0xe10600 }));
    const colors = clients.map((c) => carOf(entry, c).color);
    assert.equal(new Set(colors).size, 6, `six racers, six cars (got ${colors.map((h) => h.toString(16)).join()})`);
    for (const hex of colors) assert.ok(core.CAR_PALETTE.includes(hex), 'every car is one of the game\'s cars');
  });

  test('changing into a car somebody else is driving is refused', () => {
    const entry = newRoom('race', 0, 6);
    const a = seat(entry, 'p-a', { color: 0xe10600 });
    const b = seat(entry, 'p-b', { color: 0x0a84ff });
    assert.equal(carOf(entry, b).color, 0x0a84ff);

    handleMessage(b, { type: 'meta', name: 'B', color: 0xe10600 });
    assert.equal(carOf(entry, b).color, 0x0a84ff, 'the taken car is not handed over');
    const refused = b.ws.errors('car-taken');
    assert.equal(refused.length, 1, 'and the racer is told');
    assert.equal(refused[0].slot, 1, 'with the seat that has it');
    assert.equal(refused[0].assigned, false, 'this was a change, not an arrival');

    // the rest of the identity still applies - only the car was refused
    assert.equal(carOf(entry, b).name, 'B');
  });

  test('an unclaimed car is anybody\'s to take, and a racer keeps their own', () => {
    const entry = newRoom('race', 0, 6);
    const a = seat(entry, 'p-a', { color: 0xe10600 });
    const b = seat(entry, 'p-b', { color: 0x0a84ff });

    handleMessage(b, { type: 'meta', name: 'B', color: 0x00a651 });
    assert.equal(carOf(entry, b).color, 0x00a651, 'a free car can be taken');
    assert.equal(b.ws.errors('car-taken').length, 0, 'and no refusal is sent for it');

    // re-sending your own colour is not a conflict with yourself
    handleMessage(b, { type: 'meta', name: 'B', color: 0x00a651 });
    assert.equal(carOf(entry, b).color, 0x00a651);
    assert.equal(b.ws.errors('car-taken').length, 0, 'a racer never conflicts with their own car');
    assert.equal(carOf(entry, a).color, 0xe10600, 'and A is untouched');
  });

  test('a seat that leaves frees its car for the next racer', () => {
    const entry = newRoom('race', 0, 6);
    const a = seat(entry, 'p-a', { color: 0xe10600 });
    const b = seat(entry, 'p-b', { color: 0x0a84ff });
    assert.equal(b.slot, 2);
    // A leaves: drop their seat the way the relay does
    entry.slotByWs.delete(a.ws);
    entry.room.setSeat(1, false);
    const c = seat(entry, 'p-c', { color: 0xe10600 });
    assert.equal(carOf(entry, c).color, 0xe10600, 'the freed car can be picked up by the new arrival');
  });

  test('a car that changes hands is rebroadcast, so no browser shows a stale grid', () => {
    const entry = newRoom('race', 0, 6);
    const a = seat(entry, 'p-a', { color: 0xe10600 });
    const b = seat(entry, 'p-b', { color: 0x0a84ff });
    a.ws.sent.length = 0; b.ws.sent.length = 0;

    // B moves into a free car: everyone's roster has to follow, or A's card list would
    // still say B is in the blue car
    handleMessage(b, { type: 'meta', name: 'B', color: 0x00a651 });
    const seenByA = a.ws.findSent('lobby');
    assert.ok(seenByA.length >= 1, 'the other racer is told the car moved');
    const rosterA = seenByA[seenByA.length - 1].players;
    assert.equal(rosterA.find((p) => p.slot === 2).color, 0x00a651, 'and the roster carries the new car');
    assert.equal(rosterA.find((p) => p.slot === 1).color, 0xe10600, 'while the other car is unchanged');
  });

  test("a joiner's hello cannot move the room's circuit, weather, laps or AI", () => {
    const entry = newRoom('race', 0, 6);
    // the creator's hello does set the room up - that is how the room is configured
    seat(entry, 'p-host', { color: 0xe10600, weather: 'wet', laps: 5, bot: true, botSkill: 0 });
    assert.equal(entry.room.weather, 'wet', "the creator's weather holds");
    assert.equal(entry.room.laps, 5, "the creator's lap count holds");
    assert.equal(entry.room.bot, true, "the creator's AI rival holds");
    assert.equal(entry.room.botSkill, 0, "and the creator's AI difficulty");

    // the joiner arrives with their own saved setup. The relay must ignore it: the room
    // is already running the host's choices, and a hello is not a settings change.
    seat(entry, 'p-join', { color: 0x0a84ff, weather: 'blizzard', laps: 1, bot: false, botSkill: 1, map: 3 });
    assert.equal(entry.room.weather, 'wet', 'a joiner cannot change the weather');
    assert.equal(entry.room.laps, 5, 'a joiner cannot change the race length');
    assert.equal(entry.room.bot, true, 'a joiner cannot change the AI rival');
    assert.equal(entry.room.mapId, 0, 'a joiner cannot change the circuit');
    assert.equal(entry.room.botSkill, 0, 'and not the AI difficulty either');

    // ...and the joiner is still seated in the car they asked for
    const joiner = entry.room.cars[1];
    assert.equal(joiner.color, 0x0a84ff, 'the joiner is still given their own car');
    assert.equal(joiner.name, 'p-join', 'and their own name');
  });

  test('the lobby roster carries every racer\'s car, so the cards can show it', () => {
    const entry = newRoom('race', 0, 6);
    const a = seat(entry, 'p-a', { color: 0xe10600 });
    const b = seat(entry, 'p-b', { color: 0x0a84ff });
    const lobby = a.ws.findSent('lobby').pop();
    assert.ok(lobby, 'the lobby is broadcast');
    for (const p of lobby.players) {
      const seatCar = entry.room.cars[p.slot - 1];
      assert.equal(p.color, seatCar.color, `slot ${p.slot}'s car is in the roster`);
    }
    assert.equal(lobby.players.filter((p) => p.host).length, 1, 'exactly one host');
    assert.equal(lobby.players.find((p) => p.host).slot, 1, 'the room creator hosts');
  });
});

describe('v155 — the room creator owns the race settings', () => {
  beforeEach(() => { rooms.clear(); });

  test('map, weather, laps and bot are refused to everyone but the host', () => {
    const entry = newRoom('race', 0, 6);
    const host = seat(entry, 'p-host');
    const joiner = seat(entry, 'p-join');
    assert.equal(host.slot, 1, 'the room creator has the first seat');
    assert.equal(joiner.slot, 2);

    handleMessage(joiner, { type: 'map', map: 3 });
    assert.equal(entry.room.mapId, 0, 'a joiner cannot move the room to another circuit');
    handleMessage(joiner, { type: 'weather', weather: 'wet' });
    assert.notEqual(entry.room.weather, 'wet', 'a joiner cannot change the weather');
    handleMessage(joiner, { type: 'laps', laps: 5 });
    assert.notEqual(entry.room.laps, 5, 'a joiner cannot change the race length');
    handleMessage(joiner, { type: 'bot', bot: true });
    assert.equal(!!entry.room.bot, false, 'a joiner cannot turn the AI rival on');

    // each refusal says which setting it was and what the room is really running
    const refusals = joiner.ws.errors('host-only');
    assert.equal(refusals.length, 4, 'every refused change is reported');
    assert.deepEqual(refusals.map((r) => r.setting).sort(), ['bot', 'laps', 'map', 'weather']);
    assert.equal(refusals.find((r) => r.setting === 'map').value, 0, 'the refusal carries the room\'s track');
    assert.equal(refusals.find((r) => r.setting === 'laps').value, entry.room.laps);
    assert.equal(refusals.find((r) => r.setting === 'map').host, 'p-host', 'and names the racer in charge');
  });

  test('the host changes all four', () => {
    const entry = newRoom('race', 0, 6);
    const host = seat(entry, 'p-host');
    seat(entry, 'p-join');   // a second racer, so the host is a host among others

    handleMessage(host, { type: 'map', map: 3 });
    assert.equal(entry.room.mapId, 3);
    handleMessage(host, { type: 'weather', weather: 'wet' });
    assert.equal(entry.room.weather, 'wet', 'the host picks the weather');
    handleMessage(host, { type: 'laps', laps: 5 });
    assert.equal(entry.room.laps, 5, 'the host picks the race length');
    handleMessage(host, { type: 'bot', bot: true });
    assert.equal(!!entry.room.bot, true, 'the host picks whether the AI rival runs');
    assert.equal(host.ws.errors('host-only').length, 0, 'the host is never refused');
  });

  test('a racer on their own still owns everything', () => {
    // the single-player case: setting up your own race must not lock you out
    const entry = newRoom('race', 0, 6);
    const solo = seat(entry, 'p-solo');
    handleMessage(solo, { type: 'map', map: 2 });
    handleMessage(solo, { type: 'weather', weather: 'night' });
    handleMessage(solo, { type: 'laps', laps: 1 });
    handleMessage(solo, { type: 'bot', bot: true });
    assert.equal(entry.room.mapId, 2);
    assert.equal(entry.room.weather, 'night');
    assert.equal(entry.room.laps, 1);
    assert.equal(!!entry.room.bot, true, 'a lone racer can turn the AI rival on');
    assert.equal(solo.ws.errors('host-only').length, 0, 'the only racer in the room is the host');
  });

  test('a phone controller cannot drive the race settings either', () => {
    const entry = newRoom('race', 0, 6);
    const host = seat(entry, 'p-host');
    seat(entry, 'p-join');
    const ws = createMockWS();
    const phone = { ws, entry: null, slot: 0, role: null, pid: 'p-phone' };
    joinRoom(phone, entry, 'controller', { pid: 'p-phone', slot: 2 });
    assert.equal(phone.role, 'controller');
    handleMessage(phone, { type: 'map', map: 4 });
    assert.equal(entry.room.mapId, 0, 'a controller is not a screen and cannot set the track');
    handleMessage(phone, { type: 'bot', bot: true });
    assert.equal(!!entry.room.bot, false, 'nor the AI rival');
    assert.equal(host.slot, 1);
  });

  test('the host role follows the seat when the creator leaves', () => {
    // the lowest occupied seat hosts, so a room is never left without one
    const entry = newRoom('race', 0, 6);
    const first = seat(entry, 'p-first');
    const second = seat(entry, 'p-second');
    handleMessage(second, { type: 'map', map: 4 });
    assert.equal(entry.room.mapId, 0, 'the second racer is not the host while the creator is here');

    entry.slotByWs.delete(first.ws);      // the creator leaves
    entry.room.setSeat(1, false);
    handleMessage(second, { type: 'map', map: 4 });
    assert.equal(entry.room.mapId, 4, 'the remaining racer inherits the room and can run it');
  });
});
