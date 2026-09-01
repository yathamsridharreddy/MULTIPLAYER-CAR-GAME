const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/game-core.js');
const { rooms, joinRoom, handleMessage, handleLeave, newRoom } = require('../server.js');

function createMockWS() {
  const ws = {
    readyState: 1, // OPEN
    sent: [],
    send(data) {
      this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
    },
    close() {
      this.readyState = 3; // CLOSED
    },
    lastSent() {
      return this.sent[this.sent.length - 1] || null;
    },
    findSent(type) {
      return this.sent.filter((m) => m && m.type === type);
    }
  };
  return ws;
}

describe('Authoritative Multiplayer Simulation & Rooms', () => {
  beforeEach(() => {
    rooms.clear();
  });

  test('supports 1 to 6 players in a room (MAX_CARS = 6)', () => {
    const entry = newRoom('race', 0, 6);
    assert.equal(entry.room.cap, 6);
    assert.equal(entry.room.cars.length, 6);

    const clients = [];
    for (let slot = 1; slot <= 6; slot++) {
      const ws = createMockWS();
      const client = { ws, entry: null, slot: 0, role: null, pid: `p-slot-${slot}`, name: `Racer ${slot}` };
      joinRoom(client, entry, 'screen', { pid: `p-slot-${slot}`, name: `Racer ${slot}` });
      clients.push(client);

      assert.equal(client.slot, slot, `Client ${slot} should be assigned slot ${slot}`);
      assert.equal(entry.room.seats[slot], true, `Slot ${slot} seat should be active`);
      assert.equal(entry.slotByWs.get(ws), slot);
    }

    // 7th player should be rejected with 'full'
    const extraWs = createMockWS();
    const extraClient = { ws: extraWs, entry: null, slot: 0, role: null, pid: 'p-slot-7', name: 'Racer 7' };
    joinRoom(extraClient, entry, 'screen', { pid: 'p-slot-7', name: 'Racer 7' });
    const fullMsg = extraWs.findSent('full');
    assert.equal(fullMsg.length, 1);
    assert.equal(extraClient.slot, 0);
  });

  test('applies steering and throttle inputs across all 6 slots in RaceRoom', () => {
    const room = new core.RaceRoom('TEST6P', 'race', 0, 6);
    for (let i = 0; i < 6; i++) {
      room.cars[i].participating = true;
      room.setInput(i + 1, {
        throttle: 1.0,
        steer: (i % 2 === 0 ? 0.5 : -0.5),
        brake: 0,
        handbrake: false,
        nitro: false
      });
    }

    room.state = 'racing';
    const initialPositions = room.cars.map((c) => ({ x: c.x, z: c.z, speed: c.forwardSpeed() }));

    // Advance physics simulation
    for (let tick = 0; tick < 30; tick++) {
      room.update(1 / 30);
    }

    for (let i = 0; i < 6; i++) {
      const car = room.cars[i];
      assert.ok(car.forwardSpeed() > 0, `Slot ${i + 1} car should have accelerated (speed=${car.forwardSpeed()})`);
      assert.notEqual(car.x, initialPositions[i].x, `Slot ${i + 1} car x position should have changed`);
      assert.notEqual(car.z, initialPositions[i].z, `Slot ${i + 1} car z position should have changed`);
    }
  });

  test('pairs mobile phone controller with screen room without crashing', () => {
    const entry = newRoom('race', 0, 4);
    const screenWs = createMockWS();
    const screenClient = { ws: screenWs, entry: null, slot: 0, role: null, pid: 'screen-pid-1' };
    joinRoom(screenClient, entry, 'screen', { pid: 'screen-pid-1' });

    assert.equal(screenClient.slot, 1);

    // Mobile controller connects to pair with slot 1
    const ctlWs = createMockWS();
    const ctlClient = { ws: ctlWs, entry: null, slot: 0, role: null, pid: 'ctrl-pid-1' };
    
    // Test that joinRoom with controller role succeeds without ReferenceError
    assert.doesNotThrow(() => {
      joinRoom(ctlClient, entry, 'controller', { pid: 'ctrl-pid-1', slot: 1 });
    });

    assert.equal(ctlClient.slot, 1);
    assert.equal(entry.controllers.get(ctlWs), 1);
    
    // Verify phone controller input forwarding
    handleMessage(ctlClient, { type: 'input', throttle: 0.8, steer: -0.3, brake: 0 });
    assert.equal(entry.room.inputs[1].throttle, 0.8);
    assert.equal(entry.room.inputs[1].steer, -0.3);
  });

  test('replaces old controller socket when phone reconnects with same PID', () => {
    const entry = newRoom('race', 0, 4);
    const screenWs = createMockWS();
    const screenClient = { ws: screenWs, entry: null, slot: 0, role: null, pid: 'screen-pid-1' };
    joinRoom(screenClient, entry, 'screen', { pid: 'screen-pid-1' });

    const ctlWs1 = createMockWS();
    const ctlClient1 = { ws: ctlWs1, entry: null, slot: 0, role: null, pid: 'ctrl-pid-42' };
    joinRoom(ctlClient1, entry, 'controller', { pid: 'ctrl-pid-42' });

    assert.equal(ctlClient1.slot, 1);
    assert.equal(entry.controllers.get(ctlWs1), 1);
    assert.equal(entry.controllerPids['ctrl-pid-42'], ctlWs1);

    // Phone reconnects with fresh socket but same PID
    const ctlWs2 = createMockWS();
    const ctlClient2 = { ws: ctlWs2, entry: null, slot: 0, role: null, pid: 'ctrl-pid-42' };
    joinRoom(ctlClient2, entry, 'controller', { pid: 'ctrl-pid-42' });

    assert.equal(ctlClient2.slot, 1);
    assert.equal(entry.controllers.get(ctlWs2), 1);
    assert.equal(entry.controllerPids['ctrl-pid-42'], ctlWs2);
    assert.equal(ctlWs1.readyState, 3, 'Old socket should be closed on reconnect');
  });

  test('handles spectators without taking player slots or mutating race', () => {
    const entry = newRoom('race', 0, 2);
    
    // Add 2 active players to fill the 2-cap room
    const p1 = { ws: createMockWS(), entry: null, slot: 0, role: null, pid: 'p1' };
    const p2 = { ws: createMockWS(), entry: null, slot: 0, role: null, pid: 'p2' };
    joinRoom(p1, entry, 'screen', { pid: 'p1' });
    joinRoom(p2, entry, 'screen', { pid: 'p2' });

    assert.equal(p1.slot, 1);
    assert.equal(p2.slot, 2);

    // Connect a spectator via handleMessage hello
    const specWs = createMockWS();
    const specClient = { ws: specWs, entry: null, slot: 0, role: null, pid: 'spec1' };
    handleMessage(specClient, { type: 'hello', role: 'spec', room: entry.room.code });

    assert.equal(specClient.slot, 0, 'Spectator must have slot 0');
    assert.equal(entry.specs.size, 1);
    assert.equal(entry.slotByWs.size, 2, 'Player slot count should remain 2');

    // Spectator receives joined confirmation
    const joined = specWs.findSent('joined');
    assert.equal(joined.length, 1);
    assert.equal(joined[0].role, 'spec');
  });

  test('recycles vacated slots when players leave cleanly', () => {
    const entry = newRoom('race', 0, 3);
    const p1 = { ws: createMockWS(), entry: null, slot: 0, role: null, pid: 'p1' };
    const p2 = { ws: createMockWS(), entry: null, slot: 0, role: null, pid: 'p2' };
    const p3 = { ws: createMockWS(), entry: null, slot: 0, role: null, pid: 'p3' };

    joinRoom(p1, entry, 'screen', { pid: 'p1' });
    joinRoom(p2, entry, 'screen', { pid: 'p2' });
    joinRoom(p3, entry, 'screen', { pid: 'p3' });

    assert.equal(p1.slot, 1);
    assert.equal(p2.slot, 2);
    assert.equal(p3.slot, 3);

    // Player 2 leaves
    handleLeave(p2);
    assert.equal(entry.room.seats[2], false);
    assert.equal(entry.slotByWs.has(p2.ws), false);

    // New Player 4 joins and should be allocated the vacated slot 2
    const p4 = { ws: createMockWS(), entry: null, slot: 0, role: null, pid: 'p4', name: 'NewRival' };
    joinRoom(p4, entry, 'screen', { pid: 'p4', name: 'NewRival' });

    assert.equal(p4.slot, 2, 'New player should reuse slot 2');
    assert.equal(entry.room.seats[2], true);
  });

  test('differentiates solo-vs-AI from genuine 2+ human multiplayer matches', () => {
    function evaluateIsMultiplayer(latest, TT = { on: false }) {
      return !TT.on && latest && latest.cars && (
        (latest.cars.filter((c) => c && c.p === 1).length >= 2 && !latest.bot) ||
        (latest.controllers && Object.values(latest.controllers).filter(Boolean).length >= 2)
      );
    }

    // 1. Solo player vs AI bot: 2 cars present, but latest.bot is true
    const soloVsBotSnapshot = {
      bot: true,
      controllers: { 1: false, 2: false },
      cars: [
        { s: 1, p: 1 },
        { s: 2, p: 1 } // AI bot
      ]
    };
    assert.equal(evaluateIsMultiplayer(soloVsBotSnapshot), false, 'Solo vs AI must NOT be classified as multiplayer');

    // 2. Practice / Time-Trial mode: TT.on = true
    assert.equal(evaluateIsMultiplayer(soloVsBotSnapshot, { on: true }), false, 'Time trial / practice must NOT be multiplayer');

    // 3. 2 human screen players (no bot): 2 cars present, latest.bot is false
    const twoHumanScreens = {
      bot: false,
      controllers: { 1: false, 2: false },
      cars: [
        { s: 1, p: 1 },
        { s: 2, p: 1 }
      ]
    };
    assert.equal(evaluateIsMultiplayer(twoHumanScreens), true, '2 human players MUST be classified as multiplayer');

    // 4. Local Duel: 2 phone controllers connected to single screen
    const twoPhoneControllers = {
      bot: false,
      controllers: { 1: true, 2: true },
      cars: [
        { s: 1, p: 1 },
        { s: 2, p: 1 }
      ]
    };
    assert.equal(evaluateIsMultiplayer(twoPhoneControllers), true, 'Dual phone controller duel MUST be classified as multiplayer');
  });
});
