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

  test('supports up to 6 phone controllers connecting to a 6-player room and rejects the 7th phone controller with full', () => {
    const entry = newRoom('race', 0, 6);
    assert.equal(entry.room.cap, 6);

    const screenWs = createMockWS();
    const screenClient = { ws: screenWs, entry: null, slot: 0, role: null, pid: 'screen-host' };
    joinRoom(screenClient, entry, 'screen', { pid: 'screen-host' });
    assert.equal(screenClient.slot, 1);

    const ctlClients = [];
    for (let slot = 1; slot <= 6; slot++) {
      const ctlWs = createMockWS();
      const ctlClient = { ws: ctlWs, entry: null, slot: 0, role: null, pid: `ctl-phone-${slot}` };
      joinRoom(ctlClient, entry, 'controller', { pid: `ctl-phone-${slot}` });
      ctlClients.push(ctlClient);

      assert.equal(ctlClient.slot, slot, `Phone controller ${slot} should be assigned slot ${slot}`);
      assert.equal(entry.room.controllers[slot], true, `Room controller slot ${slot} should be true`);
      assert.equal(entry.controllers.get(ctlWs), slot);
    }

    // 7th phone controller should receive 'full'
    const extraCtlWs = createMockWS();
    const extraCtlClient = { ws: extraCtlWs, entry: null, slot: 0, role: null, pid: 'ctl-phone-7' };
    joinRoom(extraCtlClient, entry, 'controller', { pid: 'ctl-phone-7' });

    const fullMsg = extraCtlWs.findSent('full');
    assert.equal(fullMsg.length, 1, '7th controller should receive full message');
    assert.equal(extraCtlClient.slot, 0, '7th controller should remain unassigned slot 0');
    assert.equal(extraCtlClient.entry, null, '7th controller entry should be null');
  });

  test('accepts rematch vote from mobile phone controller role', () => {
    const entry = newRoom('race', 0, 2);
    const screenWs1 = createMockWS();
    const screenClient1 = { ws: screenWs1, entry: null, slot: 0, role: null, pid: 'screen-1' };
    joinRoom(screenClient1, entry, 'screen', { pid: 'screen-1' });

    const screenWs2 = createMockWS();
    const screenClient2 = { ws: screenWs2, entry: null, slot: 0, role: null, pid: 'screen-2' };
    joinRoom(screenClient2, entry, 'screen', { pid: 'screen-2' });

    const ctlWs = createMockWS();
    const ctlClient = { ws: ctlWs, entry: null, slot: 0, role: null, pid: 'ctl-1' };
    joinRoom(ctlClient, entry, 'controller', { pid: 'ctl-1', slot: 1 });

    assert.equal(entry.rematch.size, 0);

    // Phone controller sends rematch message (1 vote out of 2 screens)
    handleMessage(ctlClient, { type: 'rematch' });
    assert.equal(entry.rematch.size, 1);
    assert.ok(entry.room.events.some((e) => e.type === 'rematch'));

    // Second screen sends rematch -> room restarts
    handleMessage(screenClient2, { type: 'rematch' });
    assert.equal(entry.rematch.size, 0);
    assert.equal(entry.room.state, 'countdown');
  });

  test('on-demand room creation: connects to lobby pool without creating room until create_room or start is triggered', () => {
    // 1. Client connects in lobby mode
    const lobbyWs = createMockWS();
    const lobbyClient = { ws: lobbyWs, entry: null, slot: 0, role: null, pid: 'racer-idle' };
    handleMessage(lobbyClient, { type: 'hello', role: 'screen', lobby: true, pid: 'racer-idle' });

    assert.equal(rooms.size, 0, 'No room should be created when client connects to lobby');
    assert.equal(lobbyClient.role, 'lobby');
    const welcome = lobbyWs.findSent('lobby_welcome');
    assert.equal(welcome.length, 1);

    // 2. Client triggers create_room
    handleMessage(lobbyClient, { type: 'create_room', mode: 'race', map: 1, laps: 3, pid: 'racer-idle', name: 'HostRacer' });
    assert.equal(rooms.size, 1, 'Room should now be created on-demand');
    assert.equal(lobbyClient.role, 'screen');
    assert.equal(lobbyClient.slot, 1);
    assert.ok(lobbyClient.entry);
    assert.equal(lobbyClient.entry.room.mapId, 1);

    const roomWelcome = lobbyWs.findSent('welcome');
    assert.equal(roomWelcome.length, 1);
    assert.equal(roomWelcome[0].slot, 1);
  });

  // ===========================================================================
  // v91 EXIT ROOM — leave the current room, then join or create another one
  // without a page reload. Previously the only way out was to reload: there was
  // no `leave` message and handleLeave() ran solely on socket close.
  // ===========================================================================
  test('leave detaches a screen from the room but keeps the socket in the lobby pool', () => {
    const entry = newRoom('race', 0, 6);
    const ws = createMockWS();
    const client = { ws, entry: null, slot: 0, role: null, uid: null };
    joinRoom(client, entry, 'screen', { pid: 'p_exiter', name: 'EXITER' });
    entry.uidBySlot[1] = 'verified-uid-exiter';
    assert.equal(client.slot, 1);

    handleMessage(client, { type: 'leave' });

    assert.equal(client.entry, null, 'detached from the room');
    assert.equal(client.role, 'lobby', 'parked in the lobby pool, ready to join or create');
    assert.equal(ws.readyState, 1, 'the socket must stay open — no page reload needed');
    assert.equal(entry.slotByWs.has(ws), false, 'seat released for the next racer');
    assert.equal(entry.room.seats[1], false, 'seat marked empty');
    assert.equal(entry.pidBySlot[1], undefined, 'device pid released (club sync must not leak to the next occupant)');
    assert.equal(entry.uidBySlot[1], undefined, 'verified uid released');
    assert.equal(entry.ratingBySlot[1], undefined, 'cached rating released');

    const ack = ws.findSent('lobby_welcome').pop();
    assert.ok(ack, 'the client is told the exit completed');
    assert.equal(ack.left, true);
    assert.equal(ack.room, entry.room.code);
  });

  test('an abandoned room is closed immediately so its 5-letter code can be reused', () => {
    const entry = newRoom('race', 0, 2);
    const code = entry.room.code;
    assert.equal(rooms.has(code), true);

    const ws = createMockWS();
    const client = { ws, entry: null, slot: 0, role: null };
    joinRoom(client, entry, 'screen', { pid: 'p_solo', name: 'SOLO' });
    handleMessage(client, { type: 'leave' });

    assert.equal(rooms.has(code), false, 'nobody left → the room is dropped at once');
  });

  test('join_room hops a racer into another room without reconnecting', () => {
    const first = newRoom('race', 0, 6);
    const second = newRoom('race', 0, 6);
    const ws = createMockWS();
    const client = { ws, entry: null, slot: 0, role: null };
    joinRoom(client, first, 'screen', { pid: 'p_hopper', name: 'HOPPER' });

    // sent lower-case on purpose: codes are matched case-insensitively
    handleMessage(client, { type: 'join_room', room: second.room.code.toLowerCase(), pid: 'p_hopper', name: 'HOPPER' });

    assert.equal(client.entry, second, 'now seated in the target room');
    assert.equal(client.slot, 1);
    assert.equal(second.pidBySlot[1], 'p_hopper', 'device pid captured again so club mileage keeps syncing');
    assert.equal(first.slotByWs.has(ws), false, 'old seat released');
    assert.equal(rooms.has(first.room.code), false, 'the abandoned room is closed');

    const welcome = ws.findSent('welcome').pop();
    assert.ok(welcome, 'the client is welcomed into the new room');
    assert.equal(welcome.code, second.room.code);
    assert.ok(welcome.snapshot, 'the new room state is pushed straight away');
  });

  test('join_room refuses an unknown code and keeps the racer in their current room', () => {
    const entry = newRoom('race', 0, 6);
    const ws = createMockWS();
    const client = { ws, entry: null, slot: 0, role: null };
    joinRoom(client, entry, 'screen', { pid: 'p_typo', name: 'TYPO' });

    handleMessage(client, { type: 'join_room', room: 'ZZZZZ' });

    assert.equal(client.entry, entry, 'still seated — a typo must never eject anybody');
    assert.equal(client.slot, 1);
    assert.equal(rooms.has(entry.room.code), true, 'the current room survives the failed hop');
    const err = ws.findSent('error').pop();
    assert.equal(err.code, 'join-failed');
    assert.equal(err.reason, 'no-room');
  });

  test('join_room refuses a full room instead of ejecting the racer', () => {
    const mine = newRoom('race', 0, 6);
    const full = newRoom('race', 0, 2);
    for (let i = 0; i < 2; i++) {
      joinRoom({ ws: createMockWS(), entry: null, slot: 0, role: null }, full, 'screen', { pid: 'p_full_' + i, name: 'FULL' + i });
    }
    const ws = createMockWS();
    const client = { ws, entry: null, slot: 0, role: null };
    joinRoom(client, mine, 'screen', { pid: 'p_blocked', name: 'BLOCKED' });

    handleMessage(client, { type: 'join_room', room: full.room.code });

    assert.equal(client.entry, mine, 'still in the original room');
    const err = ws.findSent('error').pop();
    assert.equal(err.code, 'join-failed');
    assert.equal(err.reason, 'full');
  });

  test('leave is idempotent for a racer already parked in the lobby pool', () => {
    const ws = createMockWS();
    const client = { ws, entry: null, slot: 0, role: null };
    handleMessage(client, { type: 'hello', role: 'screen', lobby: true, pid: 'p_idle' });
    assert.equal(client.role, 'lobby');

    handleMessage(client, { type: 'leave' });
    handleMessage(client, { type: 'leave' });

    assert.equal(client.role, 'lobby');
    assert.equal(client.entry, null);
    assert.equal(ws.readyState, 1);
    assert.ok(ws.findSent('lobby_welcome').length >= 3, 'every exit is acknowledged');
  });

  test('a phone controller that leaves is detached and acknowledged without lobby state', () => {
    const entry = newRoom('race', 0, 6);
    joinRoom({ ws: createMockWS(), entry: null, slot: 0, role: null }, entry, 'screen', { pid: 'p_screen', name: 'SCREEN' });

    const padWs = createMockWS();
    const pad = { ws: padWs, entry: null, slot: 0, role: null };
    joinRoom(pad, entry, 'controller', { pid: 'p_pad', slot: 1 });
    assert.equal(pad.role, 'controller');

    handleMessage(pad, { type: 'leave' });

    assert.equal(pad.entry, null);
    assert.equal(entry.controllers.has(padWs), false, 'pad detached from the slot');
    const ack = padWs.findSent('left').pop();
    assert.ok(ack, 'the pad gets a plain acknowledgement');
    assert.equal(ack.role, 'controller');
    assert.equal(padWs.findSent('lobby_welcome').length, 0, 'pads have no lobby pool state');
    assert.equal(rooms.has(entry.room.code), true, 'the screen is still seated, so the room stays open');
  });
});
