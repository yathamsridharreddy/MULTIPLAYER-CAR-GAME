'use strict';
/* ============================================================================
   v140 — connection reliability (the "sometimes it just misbehaves" class of bug).

   The client socket layer had no protection against a socket that outlives its
   purpose. A dial that was still CONNECTING when a retry fired kept its handlers:
   it could publish `welcome` from a dead attempt, and its `close` reset the state
   of the LIVE connection (nulling it and triggering yet another retry). Result:
   reconnect storms, duplicate joins, phantom players, cars jumping, and a UI that
   flaps between connected and reconnecting.

   These tests drive a fake WebSocket through that exact sequence.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'net.js'), 'utf8');

function makeEnv() {
  const sockets = [];
  const timers = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;           // CONNECTING
      this.sent = [];
      sockets.push(this);
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    send(d) { this.sent.push(d); }
    // test helpers
    _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    _msg(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
    _die() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  // the real WebSocket exposes these as statics and net.js compares against them
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  const sandbox = {
    console,
    JSON, Math, Promise, Object, Array, String, isFinite, Date,
    performance: { now: () => Date.now() },
    location: { protocol: 'https:', host: 'example.test', search: '' },
    navigator: {},
    document: {},
    URLSearchParams: class { get() { return null; } },
    window: { SERVER_URL: 'local' },
    WebSocket: FakeWebSocket,
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearInterval: (t) => { if (t) t.cleared = true; },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, setTimeout: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC + '\n;globalThis.__RoomLink = RoomLink;', sandbox, { filename: 'net.js' });
  return { sandbox, RoomLink: sandbox.__RoomLink, sockets, timers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('v140: reconnecting never leaves two live sockets (the reconnect-storm bug)', async () => {
  const { RoomLink, sockets } = makeEnv();
  const statuses = [];
  const link = new RoomLink({ onStatus: (s) => statuses.push(s) });
  link.connect({ type: 'hello' });
  assert.strictEqual(sockets.length, 1, 'first dial');
  const first = sockets[0];

  // dial again while the first socket is still CONNECTING (a retry fired, or the
  // user pressed play again). The old socket must be retired, not left running.
  link.connect({ type: 'hello' });
  assert.strictEqual(sockets.length, 2, 'second dial');
  assert.strictEqual(first.readyState, 3, 'the superseded socket is closed');

  // and it must be INERT: its callbacks were detached, so it cannot publish
  let welcomed = 0;
  link.handlers.onWelcome = () => welcomed++;
  const second = sockets[1];
  second._open();
  first._msg({ type: 'welcome', slot: 1 });        // zombie talks: must be ignored
  assert.strictEqual(welcomed, 0, 'a retired socket cannot deliver welcome');
  assert.strictEqual(link.open, false, 'still not connected');

  second._msg({ type: 'welcome', slot: 2 });
  assert.strictEqual(welcomed, 1, 'the live socket connects normally');
  assert.strictEqual(link.open, true);
  assert.strictEqual(statuses.filter((s) => s === 'connected').length, 1);
  await flush();
});

test('v140: a dead socket cannot tear down the live connection', async () => {
  const { RoomLink, sockets } = makeEnv();
  const msgs = [];
  const link = new RoomLink({ onMessage: (m) => msgs.push(m.type) });
  link.connect({ type: 'hello' });
  const first = sockets[0];
  link.connect({ type: 'hello' });           // supersede it
  const live = sockets[1];
  live._open();
  live._msg({ type: 'welcome', slot: 1 });
  assert.strictEqual(link.isOpen(), true);

  first._die();                              // the old socket finally notices it died
  assert.strictEqual(link.open, true, 'the LIVE connection must not be nulled by a stale close');
  assert.strictEqual(link.ws, live, 'and its socket reference must be intact');
  assert.ok(!msgs.includes('disconnected'), 'no phantom disconnect for the live link');
  await flush();
});

test('v140: a dial that never answers is abandoned and retried (no infinite "connecting")', async () => {
  const { RoomLink, sockets, timers } = makeEnv();
  const link = new RoomLink({});
  link.connect({ type: 'hello' });
  assert.strictEqual(sockets.length, 1);
  const watch = timers.find((t) => t.setTimeout && t.ms === 15000);
  assert.ok(watch, 'a connect watchdog is armed');
  watch.fn();                                // the dial never produced a welcome
  assert.strictEqual(sockets[0].readyState, 3, 'the silent socket is closed');
  const retry = timers.filter((t) => t.setTimeout && !t.cleared).pop();
  assert.ok(retry, 'a retry was scheduled');
  await flush();
});

test('v140: the watchdog is cleared once a welcome arrives', async () => {
  const { RoomLink, sockets, timers } = makeEnv();
  const link = new RoomLink({});
  link.connect({ type: 'hello' });
  const watch = timers.find((t) => t.setTimeout && t.ms === 15000);
  sockets[0]._open();
  sockets[0]._msg({ type: 'welcome', slot: 1 });
  assert.ok(watch.cleared, 'watchdog disarmed after connecting');
  assert.strictEqual(link.isOpen(), true);
});

test('v140: silence on an open socket triggers a re-dial (zombie socket detector)', async () => {
  const { RoomLink, sockets, timers } = makeEnv();
  const link = new RoomLink({});
  link.connect({ type: 'hello' });
  const live = sockets[0];
  live._open();
  live._msg({ type: 'welcome', slot: 1 });     // this stamps _lastRx
  const liveness = timers.find((t) => !t.setTimeout && t.ms === 3000);
  assert.ok(liveness, 'liveness interval armed');

  // pretend 20 s of silence passed while the socket still claims to be open
  const realNow = link._lastRx;
  link._lastRx = realNow - 20000;
  liveness.fn();
  await flush();
  assert.strictEqual(sockets.length, 2, 'a fresh dial replaces the silent socket');
  assert.strictEqual(live.readyState, 3, 'the zombie was closed');
});

test('v140: close() retires everything and stops the timers', async () => {
  const { RoomLink, sockets, timers } = makeEnv();
  const link = new RoomLink({});
  link.connect({ type: 'hello' });
  sockets[0]._open();
  sockets[0]._msg({ type: 'welcome', slot: 1 });
  const liveness = timers.find((t) => !t.setTimeout && t.ms === 3000);
  link.close();
  assert.strictEqual(link.open, false);
  assert.strictEqual(link.isOpen(), false);
  assert.ok(liveness.cleared, 'liveness interval cleared on close');
  assert.strictEqual(link.closedByUser, true);
  // and a late callback from the closed socket changes nothing
  sockets[0]._msg({ type: 'welcome', slot: 9 });
  assert.strictEqual(link.open, false, 'a closed link never resurrects itself');
});
