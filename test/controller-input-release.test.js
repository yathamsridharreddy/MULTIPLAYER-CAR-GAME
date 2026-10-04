'use strict';
/* ============================================================================
   v174 production audit — the phone controller can never leave an input stuck.

   The pad is stateful: it re-sends `steer/throttle/brake/handbrake/nitro` at
   33 ms, so a control whose RELEASE is lost keeps driving the car until the
   phone is reloaded. The release handlers used to live only on the element that
   was pressed, which is safe only while pointer capture is actually held. If
   setPointerCapture() is unavailable (older WebKit) and the finger lifts outside
   the zone - or the phone fires blur/pagehide instead of pointerup - nothing on
   the element ever hears about it.

   The real makeStick()/holdButton()/releaseAll() are lifted out of the shipped
   controller.js and driven against a minimal fake DOM, so what is asserted is
   the wiring the browser gets, not a copy of it.
   ========================================================================== */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/controller.js'), 'utf8');

// brace-matched lift of a top-level function out of the shipped file
function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in public/js/controller.js`);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`${name} body is not balanced`);
}

function fakeEl() {
  const listeners = {};
  return {
    listeners,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    style: {},
    setPointerCapture(id) { this.captured = id; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t, ev) { (listeners[t] || []).forEach((f) => f(ev || {})); return (listeners[t] || []).length; }
  };
}

function harness() {
  const zone = fakeEl(), knob = fakeEl(), btn = fakeEl();
  const els = { 'zone-left': zone, 'knob-left': knob, 'btn-nitro': btn };
  const winListeners = {};
  const sent = [];
  const sandbox = {
    console,
    state: { steer: 0, throttle: 0, brake: 0, hb: false, nitro: false, slot: 1, full: false },
    net: { isOpen: () => true, send: (m) => sent.push(m) },
    vibrate() {},
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    $: (id) => els[id] || fakeEl(),
    window: {
      addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
      fire(t, ev) { (winListeners[t] || []).forEach((f) => f(ev || {})); return (winListeners[t] || []).length; }
    }
  };
  sandbox.window.window = sandbox.window;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    'const stickReleases = [];\nconst heldButtons = new Set();\n' +
    lift('makeStick') + '\n' + lift('holdButton') + '\n' + lift('releaseAll') + '\n' +
    'globalThis.__api = { stickReleases, heldButtons, makeStick, holdButton, releaseAll };',
    ctx
  );
  return { api: sandbox.__api, zone, knob, btn, sandbox, winListeners, sent };
}

describe('v174 — the controller can never leave an input stuck', () => {
  test('a stick releases when the finger lifts OUTSIDE the zone', () => {
    const h = harness();
    const seen = [];
    h.api.makeStick('zone-left', 'knob-left', (x, y) => seen.push([x, y]));

    h.zone.fire('pointerdown', { pointerId: 7, clientX: 100, clientY: 100, preventDefault() {} });
    h.zone.fire('pointermove', { pointerId: 7, clientX: 140, clientY: 100 });
    assert.ok(seen.length >= 2, 'the stick reports movement');
    assert.ok(seen[seen.length - 1][0] > 0.5, 'steering is applied');

    // the regression: the release lands on the window, not on the zone
    assert.ok(h.winListeners.pointerup && h.winListeners.pointerup.length > 0, 'a window-level release must be wired');
    h.sandbox.window.fire('pointerup', { pointerId: 7 });
    assert.deepEqual(seen[seen.length - 1], [0, 0], 'the stick snaps back to centre');
    assert.equal(h.zone.classList.contains('active'), false);
    assert.equal(h.knob.style.transform, 'translate(0px, 0px)');
  });

  test('a stick releases when pointer capture is lost', () => {
    const h = harness();
    const seen = [];
    h.api.makeStick('zone-left', 'knob-left', (x) => seen.push(x));
    h.zone.fire('pointerdown', { pointerId: 3, clientX: 0, clientY: 0, preventDefault() {} });
    h.zone.fire('pointermove', { pointerId: 3, clientX: 46, clientY: 0 });
    h.zone.fire('lostpointercapture', { pointerId: 3 });
    assert.equal(seen[seen.length - 1], 0, 'capture loss must not strand the steering');
  });

  test('a second finger cannot cancel the first finger\'s stick', () => {
    const h = harness();
    const seen = [];
    h.api.makeStick('zone-left', 'knob-left', (x) => seen.push(x));
    h.zone.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, preventDefault() {} });
    h.zone.fire('pointermove', { pointerId: 1, clientX: 40, clientY: 0 });
    const before = seen[seen.length - 1];
    h.sandbox.window.fire('pointerup', { pointerId: 2 });        // the OTHER finger
    assert.equal(seen[seen.length - 1], before, 'steering is unaffected by another pointer');
    h.sandbox.window.fire('pointerup', { pointerId: 1 });
    assert.equal(seen[seen.length - 1], 0, 'and the real finger still releases it');
  });

  test('a held button (nitro) releases on a window pointerup', () => {
    const h = harness();
    let down = 0, up = 0;
    h.api.holdButton('btn-nitro', () => { down++; }, () => { up++; });
    h.btn.fire('pointerdown', { pointerId: 9, preventDefault() {} });
    assert.equal(down, 1);
    assert.equal(h.btn.classList.contains('pressed'), true);
    h.sandbox.window.fire('pointerup', { pointerId: 9 });
    assert.equal(up, 1, 'the button must report its release');
    assert.equal(h.btn.classList.contains('pressed'), false);
    h.sandbox.window.fire('pointerup', { pointerId: 9 });        // duplicate event
    assert.equal(up, 1, 'a duplicate release is ignored');
  });

  test('releaseAll() zeroes everything and pushes a zeroed frame', () => {
    const h = harness();
    h.api.makeStick('zone-left', 'knob-left', (x) => { h.sandbox.state.steer = x; });
    h.api.holdButton('btn-nitro', () => { h.sandbox.state.nitro = true; }, () => { h.sandbox.state.nitro = false; });
    h.zone.fire('pointerdown', { pointerId: 4, clientX: 0, clientY: 0, preventDefault() {} });
    h.zone.fire('pointermove', { pointerId: 4, clientX: 46, clientY: 0 });
    h.btn.fire('pointerdown', { pointerId: 5, preventDefault() {} });
    h.sandbox.state.throttle = 1; h.sandbox.state.hb = true;

    h.api.releaseAll();

    const st = h.sandbox.state;
    assert.equal(st.steer, 0);
    assert.equal(st.throttle, 0);
    assert.equal(st.brake, 0);
    assert.equal(st.hb, false);
    assert.equal(st.nitro, false);
    assert.equal(h.btn.classList.contains('pressed'), false);
    const last = JSON.parse(JSON.stringify(h.sent[h.sent.length - 1]));   // cross-realm object
    assert.deepEqual(last, { type: 'input', steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false });
  });

  test('blur, pagehide and a hidden tab all run the release path', () => {
    // the listeners are registered on the window at load time
    assert.match(SRC, /window\.addEventListener\('blur', releaseAll\)/);
    assert.match(SRC, /window\.addEventListener\('pagehide', releaseAll\)/);
    const vis = SRC.slice(SRC.indexOf("document.addEventListener('visibilitychange'"));
    const hiddenBranch = vis.slice(0, vis.indexOf('return;'));
    assert.ok(hiddenBranch.includes('releaseAll()'),
      'hiding the tab must release every control, not only zero the numbers');
  });
});
