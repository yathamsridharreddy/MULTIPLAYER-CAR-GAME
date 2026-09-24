'use strict';
/* ============================================================================
   Client revenge / deep-link track resolution.

   The v93 bug: a revenge target written by the authoritative settlement carries
   { mapId }, while the banner and the ACCEPT button read `.map`. The result was
   a banner that said "on Circuit" and a revenge race that always started on
   map 0 (Highland) instead of the track the racer actually lost on. Shared
   revenge links (?map=N) were ignored entirely for the same class of reason.

   These helpers are pure, so they are lifted straight out of the shipped
   public/js/game.js (brace-matched) and exercised against the REAL track table.
   ========================================================================== */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const core = require('../shared/game-core.js');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/game.js'), 'utf8');

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' must exist in public/js/game.js');
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced body for ' + name);
}

const sandbox = { CORE: core, URLSearchParams, parseInt, isFinite };
vm.createContext(sandbox);
vm.runInContext(
  ['validMapId', 'revengeMapOf', 'resolveMapParam'].map(extract).join('\n') +
  '\n;globalThis.__api = { validMapId, revengeMapOf, resolveMapParam };',
  sandbox
);
const { validMapId, revengeMapOf, resolveMapParam } = sandbox.__api;
const LAST_MAP = core.MAPS.length - 1;

describe('Client Revenge & Deep-Link Track Resolution', () => {
  it('reads the track from a settlement-shaped revenge target (mapId only)', () => {
    // this is the exact record the settlement writes when you lose a rated race
    assert.equal(revengeMapOf({ targetUid: 'rival', targetName: 'RIVAL', mapId: 3 }), 3);
    assert.equal(revengeMapOf({ mapId: LAST_MAP }), LAST_MAP, 'the last track must resolve too');
    assert.equal(revengeMapOf({ mapId: 0 }), 0, 'map 0 is a real track, not "missing"');
  });

  it('the pre-v93 read (target.map || 0) lost the track entirely', () => {
    // exactly what the settlement writes when you lose a rated race
    const settlementRecord = { targetUid: 'rival-uuid', targetName: 'NEMESIS', mapId: 3 };
    assert.equal(settlementRecord.map || 0, 0, 'the old expression silently forced Highland');
    assert.equal(revengeMapOf(settlementRecord), 3, 'the resolver keeps the track you lost on');
  });

  it('prefers an explicit map and accepts numeric strings off the wire', () => {
    assert.equal(revengeMapOf({ map: 2, mapId: 3 }), 2);
    assert.equal(revengeMapOf({ mapId: '3' }), 3, 'JSON/HTTP values arrive as strings');
    assert.equal(revengeMapOf({ map: '1' }), 1);
  });

  it('falls back to track 0 for junk instead of an invalid map', () => {
    assert.equal(revengeMapOf(null), 0);
    assert.equal(revengeMapOf(undefined), 0);
    assert.equal(revengeMapOf({}), 0);
    assert.equal(revengeMapOf({ mapId: 99 }), 0, 'out of range clamps to a real track');
    assert.equal(revengeMapOf({ mapId: -3 }), 0);
    assert.equal(revengeMapOf({ mapId: 'lol' }), 0);
    assert.equal(revengeMapOf({ map: null, mapId: null }), 0);
  });

  it('validMapId distinguishes "track 0" from "no track"', () => {
    assert.equal(validMapId(0), 0);
    assert.equal(validMapId('0'), 0);
    assert.equal(validMapId(null), null);
    assert.equal(validMapId(99), null);
    assert.equal(validMapId(NaN), null);
  });

  it('honours ?map=N deep links from shared revenge challenges', () => {
    assert.equal(resolveMapParam('?map=3'), 3, 'the share link https://.../?map=3 must open track 3');
    assert.equal(resolveMapParam('?map=0'), 0);
    assert.equal(resolveMapParam('?room=AB12C&map=4'), 4, 'works alongside other params');
    assert.equal(resolveMapParam('?map=' + LAST_MAP), LAST_MAP);
  });

  it('rejects a deep link that names no real track', () => {
    assert.equal(resolveMapParam('?map=99'), null);
    assert.equal(resolveMapParam('?map=-1'), null);
    assert.equal(resolveMapParam('?map=abc'), null);
    assert.equal(resolveMapParam('?map='), null);
    assert.equal(resolveMapParam('?ch=12'), null, 'a challenge link carries no map');
    assert.equal(resolveMapParam(''), null);
    assert.equal(resolveMapParam(null), null);
  });
});
