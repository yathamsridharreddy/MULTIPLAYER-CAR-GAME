'use strict';

/* ============================================================================
   v110 — THE LAP COUNTER SHOWED A RACE THAT WAS NOT BEING RUN.

   A five-lap race displayed "LAP 4/3". The race itself was correct: every race
   start stamps each car with the room length (room.laps, chosen 1/3/5 in the
   lobby), so the finish line, the final-lap toast and the results all agreed
   with the chosen distance. Only the READOUTS were wrong - the HUD lap line,
   the raceinfo lap chip, both standings lists and the phone controller's
   telemetry string all formatted against CFG.totalLaps, the default room
   length, which is 3 and never changes.

   The live distance is published on every server snapshot as `laps`, so the
   client now reads it through one accessor (raceLapsTotal) and the server
   formats against room.laps. These tests pin both sides, and pin the race
   logic so a future "fix" cannot trade one for the other.
   ========================================================================== */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const GAME = read('public/js/game.js');
const CORE = read('public/js/game-core.js');
const SERVER = read('server.js');

const HELPER_RE = /function raceLapsTotal\(\) \{[\s\S]*?\n\}/;

test('game.js reads the live race distance through one accessor', () => {
  const m = HELPER_RE.exec(GAME);
  assert.ok(m, 'raceLapsTotal() must exist - every lap readout goes through it');
  const body = m[0];
  assert.match(body, /latest && latest\.laps/,
    'the server snapshot is the authoritative race length');
  assert.match(body, /prefs && prefs\.laps/,
    'before a snapshot arrives (lobby, solo), the chosen preference wins');
  assert.match(body, /CFG\.totalLaps/,
    'and the config default is only the last resort');
});

test('no lap readout reads the config constant directly any more', () => {
  // Remove the accessor; nothing else in the client may mention the constant,
  // because any remaining mention is a readout showing the default, not the race.
  const stripped = GAME.replace(HELPER_RE, '');
  const lines = stripped.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('CFG.totalLaps') && !l.trim().startsWith('//'));
  assert.deepEqual(lines, [],
    'a lap readout still formats against the default: line ' + lines.map((l) => l[0]).join(', '));
});

test('all four client readouts clamp against the live length', () => {
  assert.match(GAME, /Math\.min\(\(mine\.lap \|\| 0\) \+ 1, LT\)/,
    'the time-trial HUD lap line');
  assert.match(GAME, /Math\.min\(mine\.lap \+ 1, LT\)/,
    'the raceinfo lap chip');
  const rows = GAME.match(/Math\.min\(c\.lap \+ 1, LT\)/g) || [];
  assert.ok(rows.length >= 2,
    'both standings lists (row builder and the P1 panel) must clamp, found ' + rows.length);
  assert.match(GAME, /const laps2 = raceLapsTotal\(\);/,
    'and the ghost-pace "near end of race" check compares against the real length');
});

test('the phone controller is told the room length, not the default', () => {
  const fn = /function controllerTelemetry\([\s\S]*?\n\}/.exec(SERVER);
  assert.ok(fn, 'controllerTelemetry must exist');
  assert.match(fn[0], /lap: `\$\{Math\.min\(car\.lap \+ 1, room\.laps\)\}\/\$\{room\.laps\}`/,
    'the telemetry lap string must format against room.laps');
  assert.ok(!/core\.CFG\.totalLaps/.test(fn[0]),
    'controllerTelemetry must not mention the config default at all');
});

test('the race logic still runs room.laps - the fix must not touch it', () => {
  assert.match(CORE, /this\.cars\.forEach\(\(c\) => \{ c\.maxLaps = this\.laps; c\.resetState\(0\); \}\)/,
    'each race start stamps every car with the room length');
  assert.match(CORE, /if \(this\.lap >= this\.maxLaps\)/,
    'and a car finishes against its own stamped length');
  assert.match(CORE, /laps: this\.laps,/,
    'the snapshot publishes the length so every client can display it');
  assert.match(CORE, /if \(!\[1, 3, 5\]\.includes\(n\)\) return false;/,
    'the lobby offers 1, 3 or 5 laps');
});
