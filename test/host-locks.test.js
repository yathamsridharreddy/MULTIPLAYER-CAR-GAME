'use strict';
/* ============================================================================
   v155 — the client half of "the room creator owns the race".

   The relay is the authority: a joiner who hand-writes a map or weather message
   gets refused. This file is about the other half of the same rule, the one the
   racer actually feels — in a room somebody else created, the circuit, the
   weather, the lap count and the AI rival are drawn LOCKED, so the control on
   screen is not a button that looks like it works and then silently does nothing.

   The real block ships inside public/js/game.js, so it is cut out of the shipped
   file and run against the real wizard markup held in a jsdom document. Nothing
   is re-implemented here: if the block stops locking something, this goes red.
   ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8');
const BLOCK_AT = '// v155 — who is in the room, who runs it, and who is driving what.';

// a top-level function out of the shipped file, braces matched from its opening line
// (the lock notes call tI18n, and that has to be the shipped implementation, not a copy)
function extract(name) {
  const at = SRC.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' is in game.js');
  let depth = 0;
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(at, j + 1); }
  }
  throw new Error('could not extract ' + name);
}

// the shipped room-state block: the state, the roster, the taken cars, the locks
function roomBlock() {
  const at = SRC.indexOf(BLOCK_AT);
  const end = SRC.indexOf('function buildCarCards', at);
  assert.ok(at > 0 && end > at, 'the v155 room-state block is in game.js');
  return SRC.slice(at, end);
}

// the wizard controls the locks act on, laid out the way index.html has them
const WIZARD = `
  <div id="map-cards">
    <button class="map-card" data-map="0">C1</button>
    <button class="map-card" data-map="1">C2</button>
  </div>
  <div id="weather-cards">
    <button class="weather-btn" data-weather="dry">dry</button>
    <button class="weather-btn" data-weather="wet">wet</button>
  </div>
  <button class="laps-btn" data-laps="1">1</button>
  <button class="laps-btn" data-laps="3">3</button>
  <button id="bot-toggle" class="toggle"></button>
  <button id="bsk-rookie"></button>
  <button id="bsk-pro"></button>
  <p class="host-only-note" data-setting="map" hidden></p>
  <p class="host-only-note" data-setting="laps" hidden></p>
  <p class="host-car-note" hidden></p>
`;

function boot(opts) {
  const dom = new JSDOM('<!doctype html><body>' + WIZARD + '</body>');
  const { document } = dom.window;
  const sandbox = {
    document, window: dom.window, console,
    prefs: { laps: 3, bot: false, color: 0x0d47c8 },
    mySlot: 1,
    savePrefs() {}, applyMyColor() {}, paintLaps() {}, paintBotToggle() {},
    applyWeather() {}, buildCarCards() {}
  };
  vm.createContext(sandbox);
  // the shipped dictionary, so the notes can be checked in every locale the site has
  if (opts && opts.dict) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8'),
    sandbox, { filename: 'i18n.js' });
  vm.runInContext(extract('tI18n') + '\n' + roomBlock() +
    '\n;globalThis.__t = {' +
    ' seat: function (s, a, h) { seatedInRoom = s; amHost = a; roomHostName = h || ""; },' +
    ' roster: applyRoomRoster, locks: applyRoomLocks, release: releaseRoomState,' +
    ' taken: carTakenBy, cars: carsTaken,' +
    ' isHost: function () { return amHost; }, isSeated: function () { return seatedInRoom; },' +
    ' setLang: function (l) { prefs.lang = l; } };',
    sandbox, { filename: 'room-state.js' });
  const t = sandbox.__t;
  const els = (sel) => Array.from(document.querySelectorAll(sel));
  const locked = () => els('#map-cards .map-card').concat(els('#weather-cards .weather-btn'))
    .concat(els('.laps-btn')).concat(els('#bot-toggle')).concat(els('#bsk-rookie, #bsk-pro'))
    .every((el) => el.disabled);
  const wantLocked = () => els('#map-cards .map-card').concat(els('#weather-cards .weather-btn'))
    .concat(els('.laps-btn')).concat(els('#bot-toggle')).concat(els('#bsk-rookie, #bsk-pro'));
  return { t, document, els, locked, wantLocked };
}

test('v155: joining somebody else\'s room locks the four settings the creator owns', () => {
  const { t, els, wantLocked } = boot();
  t.seat(true, false, 'HOST_A');
  t.locks();
  for (const el of wantLocked()) {
    assert.equal(el.disabled, true, 'a locked control cannot be pressed: ' + el.className + '#' + el.id);
    assert.match(el.className, /locked/, 'and it is drawn as locked, not merely broken');
  }
  // the racer is told who to ask, and that picking a car is still theirs to do
  const note = els('.host-only-note');
  assert.ok(note.every((n) => n.hidden === false), 'every locked group explains itself');
  assert.match(note[0].textContent, /HOST_A/, 'the note names the racer who runs the room');
  assert.match(note[0].textContent, /circuit/, 'and the setting it belongs to');
  assert.match(note[0].textContent, /pick your car/, 'and says what the racer can still do');
  assert.equal(els('.host-car-note')[0].hidden, false, 'the car row is never locked');
});

test('v155: the creator\'s own room leaves all four controls live', () => {
  const { t, els, wantLocked } = boot();
  t.seat(true, true, 'ME');
  t.locks();
  for (const el of wantLocked()) {
    assert.equal(el.disabled, false, 'the host can still change their own race: ' + el.className + '#' + el.id);
    assert.doesNotMatch(el.className, /locked/);
  }
  assert.ok(els('.host-only-note').every((n) => n.hidden === true), 'and nothing is explained away');
  assert.equal(els('.host-car-note')[0].hidden, false, 'the host picks a car too');
});

test('v155: setting up on your own leaves every control yours', () => {
  const { t, els, wantLocked } = boot();
  t.seat(false, false, '');
  t.locks();
  for (const el of wantLocked()) assert.equal(el.disabled, false, 'a solo setup locks nothing');
  assert.ok(els('.host-only-note').every((n) => n.hidden === true));
  assert.equal(els('.host-car-note')[0].hidden, true, 'and the car row is not in room mode');
});

test('v155: leaving the room hands the controls back', () => {
  const { t, els, wantLocked } = boot();
  t.seat(true, false, 'HOST_A');
  t.locks();
  assert.equal(wantLocked()[0].disabled, true, 'locked while in the room');
  t.release();
  for (const el of wantLocked()) assert.equal(el.disabled, false, 'and free again once out of it');
  assert.ok(els('.host-only-note').every((n) => n.hidden === true), 'the notes go with it');
  assert.equal(els('.host-car-note')[0].hidden, true);
});

test('v155: the taken-car list comes from the room roster, and never holds my own car', () => {
  const { t } = boot();
  t.roster([
    { slot: 1, name: 'ME', color: 0x0d47c8, host: true },
    { slot: 2, name: 'RIVAL_92', color: 0xe10600, host: false }
  ], 6, { laps: 5, bot: true, weather: 'wet' });
  // (the entry is created inside the vm, so compare its fields, not its prototype chain)
  const rival = t.taken(0xe10600);
  assert.ok(rival, 'somebody else\'s car is marked as theirs');
  assert.equal(rival.name, 'RIVAL_92', 'by name');
  assert.equal(rival.slot, 2, 'and by seat');
  assert.equal(t.taken(0x0d47c8), null, 'my own car is never marked taken against me');
  assert.equal(t.taken(0x00a651), null, 'and a free car is free');
  assert.equal(t.cars.size, 1, 'the legend holds one entry per taken car');
});

test('v155: the lock notes are translated, not English-only', () => {
  const { t, els } = boot({ dict: true });
  t.seat(true, false, 'HOST_A');
  const seen = {};
  for (const lang of ['en', 'te', 'hi', 'es']) {
    // prefs.lang is what tI18n reads, so this is the language the page is drawn in
    t.setLang(lang);
    t.locks();
    const notes = els('.host-only-note').map((n) => n.textContent);
    for (const txt of notes) {
      assert.ok(txt.length > 10, 'the note is written in ' + lang);
      assert.doesNotMatch(txt, /\{\w+\}/, 'no {placeholder} is left behind in ' + lang);
      assert.match(txt, /HOST_A/, 'and it still names the racer who runs the room (' + lang + ')');
    }
    assert.equal(new Set(notes).size > 1, true, 'the four settings are named separately in ' + lang);
    seen[lang] = notes[0];
  }
  assert.notEqual(seen.en, seen.es, 'a Spanish page does not read English');
  assert.notEqual(seen.en, seen.te, 'and neither does a Telugu one');
});

test('v155: a roster with no host on it hands nobody the host powers', () => {
  const { t, wantLocked } = boot();
  // defensive: the lobby handler marks us seated (we hold a seat), but if the roster it
  // carries never flags a host, the safe direction is to leave every setting locked -
  // never to make a racer a host by accident.
  t.seat(true, true, 'ME');                    // seated, and believing we are the host
  t.roster([{ slot: 1, name: 'ME', color: 0x0d47c8 }], 6, {});
  assert.equal(t.isSeated(), true, 'we are still in the room');
  assert.equal(t.isHost(), false, 'but a roster with no host flag makes nobody the host');
  t.locks();
  for (const el of wantLocked()) assert.equal(el.disabled, true, 'so the settings stay locked');
});
