'use strict';
/* ============================================================================
   v97 — THE COMPETITIVE HUB'S DEAD BUTTONS AND ITS LYING SUMMARY BAR.

   Reported: "Track Records, Daily Cup and Founders Cup are greyed out and cannot
   be clicked; Global Rating works but the values are not true."

   Cause 1 (this file): `wireCompetitiveHub()` was DEFINED and never called. No
   click handler was ever attached to any of the four tabs, nor to TOP 20 / NEARBY,
   the five track pills, or the two share buttons. GLOBAL RATING only looked alive
   because switchLobbyTab('rank') loads that one panel directly, and the other three
   sat in their flat inactive style - which reads as "disabled".

   Cause 2 (this file): the summary bar found the asker's row with
   `rows.find(r => r.rank === data.userRank)` inside the VISIBLE PAGE. Once the rank
   sat outside that page the lookup returned undefined, the tier and ELO elements
   were never touched, and the bar kept displaying the previous render's numbers -
   a rank that did not belong to the rating next to it.

   Cause 3 (server, covered by test/competitive-hub.test.js): identity and merging.

   game.js cannot run under Node (WebGL, DOM), so the real functions are lifted out
   of the shipped file by brace matching and run against a stub DOM - the same
   technique test/client-render-guard.test.js uses.
   ========================================================================== */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/game.js'), 'utf8');

function lift(signature) {
  const start = SRC.indexOf(signature);
  assert.ok(start !== -1, signature + ' must exist in public/js/game.js');
  let depth = 0, end = -1;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, signature + ' body must be balanced');
  return SRC.slice(start, end);
}

// --- a DOM stub that records what was wired and what was rendered ------------
function el(id) {
  return {
    id, hidden: false, textContent: '', innerHTML: '', style: {}, dataset: {},
    handlers: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) on = !this._set.has(c); on ? this._set.add(c) : this._set.delete(c); return on; },
      contains(c) { return this._set.has(c); }
    },
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    click() { assert.ok(this.handlers.click, this.id + ' has no click handler'); this.handlers.click(); }
  };
}

describe('v97 Competitive Hub — the buttons are wired', () => {
  it('the shipped file wires the hub AT FILE SCOPE, not from inside a function', () => {
    // A definition with no call site is invisible to a syntax check and to every
    // other test in the suite: the page loads, the panel renders, nothing responds.
    // v106 found the subtler version - the call site existed, but it and the hub
    // state sat INSIDE wireLobbyV2(), while wireCompetitiveHub() and
    // loadCompetitiveHub() are declared at file scope. A closure resolves its free
    // variables where the function was DEFINED, so every tab handler went looking
    // for compActiveTab in the global scope and threw:
    //     Uncaught ReferenceError: compActiveTab is not defined    game.js:6335
    // Placement is asserted twice: statically here, and at runtime by
    // test/client-hub-scope.test.js, which boots the real page in a stubbed browser
    // and clicks the tabs. Indentation and a lifted-function sandbox cannot see a
    // nesting bug - only execution can.
    const calls = SRC.match(/wireCompetitiveHub\(\)/g) || [];
    assert.ok(calls.length >= 2, 'expected a definition AND a call, found ' + calls.length);
    assert.match(SRC, /try \{\n\s*wireCompetitiveHub\(\);/,
      'the call must be guarded, so a failure there cannot take the rest of the wiring with it');

    assert.match(SRC, /^function ensureCompetitiveWired\(\) \{/m,
      'ensureCompetitiveWired must be declared at column 0: inside wireLobbyV2 it is function-local and unreachable');
    assert.equal((SRC.match(/^ensureCompetitiveWired\(\);$/gm) || []).length, 1,
      'exactly one column-0 call, so the hub is wired even when the lobby wiring never runs');
    assert.match(SRC, /initLobbyTabs\(\);\n[\s\S]{0,1400}?^\s+ensureCompetitiveWired\(\);/m,
      'plus an early call beside the lobby tabs, so the tabs are live as soon as the lobby is');
    assert.match(SRC, /if \(t === 'rank'\) \{ ensureCompetitiveWired\(\); loadCompetitiveHub\(\); \}/,
      'plus a self-healing call every time LEADERBOARDS is opened');

    ['compActiveTab', 'compScope', 'compSelectedMap'].forEach((n) => {
      assert.match(SRC, new RegExp('^var ' + n + ' =', 'm'), n + ' must be a column-0 var (global object)');
      assert.ok(!new RegExp('^(let|const) ' + n + ' ', 'm').test(SRC), n + ' must not be a script-scope let/const');
      assert.ok(SRC.includes('window.' + n + ' = ' + n + ';'), n + ' must be mirrored onto window');
    });

    const at = SRC.indexOf('var compActiveTab =');
    assert.ok(at > SRC.indexOf('const $ ='), 'after the DOM helper it uses');
    assert.ok(at < SRC.indexOf('async function loadCompetitiveHub()'), 'before the loader that reads it');
    assert.ok(at < SRC.indexOf('\nframe();'), 'before the render loop starts');
    // The wiring must not depend on the tail of the file evaluating cleanly: the
    // lobby wires it early, and opening LEADERBOARDS re-wires it regardless.
    assert.ok(SRC.indexOf('ensureCompetitiveWired();') < SRC.indexOf('var compActiveTab =') === false ||
      /if \(t === 'rank'\) \{ ensureCompetitiveWired\(\);/.test(SRC),
      'a self-healing call must exist for devices where the tail never ran');
  });

  it('binds a click handler to all four tabs, both scopes, every track pill and both share buttons', () => {
    const els = {};
    const ids = ['board-tab-rate', 'board-tab-time', 'board-tab-daily', 'board-tab-weekly',
      'scope-top', 'scope-nearby', 'comp-wa-share', 'comp-tg-share', 'pane-rank'];
    ids.forEach((id) => { els[id] = el(id); });
    els['pane-rank'].classList.add('hidden');          // the hub is not open at load

    const pills = [0, 1, 2, 3, 4].map((m) => { const p = el('pill' + m); p.dataset.map = String(m); return p; });
    const loads = [];
    const opened = [];

    const sandbox = {
      console, URLSearchParams, encodeURIComponent,
      prefs: { name: 'SRI', pid: 'p3k9x2ab' },
      document: { querySelectorAll: (sel) => (sel === '.mf-pill' ? pills : []) },
      window: { open: (u) => opened.push(u) },
      location: { origin: 'https://example.test' },
      track: () => {},
      selectedMap: 0,
      $: (id) => els[id] || null
    };
    vm.createContext(sandbox);
    vm.runInContext(
      'let compActiveTab = "rate"; let compScope = "top"; let compSelectedMap = 0;\n' +
      'const loads = [];\n' +
      'function loadCompetitiveHub() { loads.push(compActiveTab); }\n' +
      lift('function wireCompetitiveHub() {') + '\n' +
      'globalThis.__wire = wireCompetitiveHub; globalThis.__loads = loads;\n' +
      'globalThis.__state = () => ({ compActiveTab, compScope, compSelectedMap });',
      sandbox);

    sandbox.__wire();

    ids.slice(0, 8).forEach((id) => assert.ok(els[id].handlers.click, id + ' was never wired'));
    pills.forEach((p) => assert.ok(p.handlers.click, 'a track pill was never wired'));
    assert.deepEqual(Array.from(sandbox.__loads), [], 'the hidden panel must not cost a request on page load');

    // and the handlers do the thing a racer expects
    els['board-tab-time'].click();
    assert.equal(sandbox.__state().compActiveTab, 'time', 'TRACK RECORDS was dead before v97');
    els['board-tab-daily'].click();
    assert.equal(sandbox.__state().compActiveTab, 'daily', 'DAILY CUP was dead before v97');
    els['board-tab-weekly'].click();
    assert.equal(sandbox.__state().compActiveTab, 'weekly', 'FOUNDERS CUP was dead before v97');
    els['board-tab-rate'].click();
    assert.equal(sandbox.__state().compActiveTab, 'rate');
    assert.deepEqual(Array.from(sandbox.__loads), ['time', 'daily', 'weekly', 'rate'], 'each click reloads the board');

    els['scope-nearby'].click();
    assert.equal(sandbox.__state().compScope, 'nearby', 'NEARBY was dead too');
    assert.ok(els['scope-nearby'].classList.contains('active') && !els['scope-top'].classList.contains('active'));

    pills[3].click();
    assert.equal(sandbox.__state().compSelectedMap, 3, 'the track filter was dead too');
    assert.ok(pills[3].classList.contains('active') && !pills[0].classList.contains('active'));

    els['comp-wa-share'].click();
    els['comp-tg-share'].click();
    assert.equal(opened.length, 2, 'both share buttons open a share sheet');
    assert.match(opened[0], /^https:\/\/wa\.me\//);
    assert.match(opened[1], /^https:\/\/t\.me\/share\/url/);
  });

  it('loads the board immediately when the hub panel is already open', () => {
    const els = { 'pane-rank': el('pane-rank') };               // visible: no 'hidden' class
    const sandbox = {
      console, URLSearchParams, encodeURIComponent, prefs: {}, track: () => {}, selectedMap: 0,
      document: { querySelectorAll: () => [] }, window: { open: () => {} }, location: { origin: 'x' },
      $: (id) => els[id] || null
    };
    vm.createContext(sandbox);
    vm.runInContext(
      'let compActiveTab = "rate"; let compScope = "top"; let compSelectedMap = 0;\n' +
      'const loads = [];\nfunction loadCompetitiveHub() { loads.push(compActiveTab); }\n' +
      lift('function wireCompetitiveHub() {') + '\nglobalThis.__wire = wireCompetitiveHub; globalThis.__loads = loads;',
      sandbox);
    sandbox.__wire();
    assert.deepEqual(Array.from(sandbox.__loads), ['rate'], 'an open panel is filled rather than left blank');
  });
});

describe('v97 Competitive Hub — the board is asked who is asking', () => {
  const runQuery = (identity) => {
    const sandbox = { URLSearchParams, crewIdentity: () => identity };
    vm.createContext(sandbox);
    vm.runInContext(lift('function boardIdentityQuery() {') + '\nglobalThis.__q = boardIdentityQuery;', sandbox);
    return sandbox.__q();
  };

  it('a guest asks with the device pid the server actually stores their row under', () => {
    const qs = new URLSearchParams(runQuery({ uid: 'p3k9x2ab', pid: 'p3k9x2ab', sbUid: '', name: 'SRI' }));
    assert.equal(qs.get('uid'), 'p3k9x2ab');
    assert.equal(qs.get('pid'), 'p3k9x2ab');
    assert.equal(qs.get('name'), 'SRI');
    assert.equal(qs.get('sbUid'), null);
  });

  it('a signed-in racer asks with the uuid, the sb: form and the name', () => {
    const U = '11111111-1111-4111-8111-111111111111';
    const qs = new URLSearchParams(runQuery({ uid: 'SRI', pid: 'sb:' + U, sbUid: U, name: 'SRI' }));
    assert.equal(qs.get('uid'), U, 'the bare uuid comes first: that is the durable key');
    assert.equal(qs.get('sbUid'), U);
    assert.equal(qs.get('pid'), 'sb:' + U);
    assert.equal(qs.get('name'), 'SRI');
  });

  it('degrades to nothing rather than sending empty parameters', () => {
    assert.equal(runQuery({ uid: '', pid: '', sbUid: '', name: '' }), '');
  });

  it('every board call in the hub sends that identity', () => {
    const hub = lift('async function loadCompetitiveHub() {');
    assert.equal((hub.match(/boardIdentityQuery\(\)/g) || []).length, 1, 'resolved once per load');
    assert.equal((hub.match(/idq \? '&'/g) || []).length, 2, 'both leaderboard calls');
    assert.equal((hub.match(/idq \? '\?'/g) || []).length, 2, 'both cup calls');
    assert.ok(!/const uid = \(acc && acc\.loggedIn/.test(hub), 'the old single-identity lookup is gone');
  });
});

describe('v97 Competitive Hub — the summary bar shows the asker, not the last render', () => {
  const runRender = (data) => {
    const els = {};
    ['comp-user-bar', 'cub-rank', 'cub-tier', 'cub-val', 'board'].forEach((id) => { els[id] = el(id); });
    const sandbox = {
      escapeHtml: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      $: (id) => els[id] || null
    };
    vm.createContext(sandbox);
    vm.runInContext(lift('function renderCompetitiveRatingBoard(data, container) {') + '\nglobalThis.__r = renderCompetitiveRatingBoard;', sandbox);
    sandbox.__r(data, els.board);
    return els;
  };

  const tier = { name: 'GOLD II', col: '#ffd479' };
  const page = [
    { rank: 21, uid: 'p21', name: 'TWENTYONE', rating: 1300, level: 9, tier, winRate: '50%' },
    { rank: 22, uid: 'p22', name: 'TWENTYTWO', rating: 1290, level: 8, tier, winRate: '40%' }
  ];

  it('reads the tier and rating from the asker\'s own row when their rank is off the page', () => {
    const els = runRender({
      rows: page, userRank: 37, rankExact: true,
      me: { uid: 'pME', rank: 37, name: 'SRI', rating: 1180, tier: { name: 'SILVER I', col: '#c0d0e0' }, level: 6, wins: 4, races: 9, winRate: '44.4%' }
    });
    assert.equal(els['comp-user-bar'].hidden, false);
    assert.equal(els['cub-rank'].textContent, '#37');
    assert.equal(els['cub-tier'].textContent, 'SILVER I', 'before v97 this stayed GOLD II from the page');
    assert.equal(els['cub-val'].textContent, '1180 ELO', 'and this stayed 1300');
    assert.equal(els['cub-tier'].style.color, '#c0d0e0');
  });

  it('clears the bar instead of leaving the previous racer\'s numbers on screen', () => {
    const els = runRender({ rows: page, userRank: 5, me: null });
    assert.equal(els['comp-user-bar'].hidden, true);
    assert.equal(els['cub-rank'].textContent, '', 'a stale rank next to a hidden bar is how a wrong number survives');
    assert.equal(els['cub-tier'].textContent, '');
    assert.equal(els['cub-val'].textContent, '');
  });

  it('clears the bar when there is no rank at all', () => {
    const els = runRender({ rows: page, userRank: null, me: null, rankExact: false });
    assert.equal(els['comp-user-bar'].hidden, true);
    assert.equal(els['cub-val'].textContent, '');
  });

  it('still falls back to the page row for an older server that sends no me', () => {
    const els = runRender({ rows: page, userRank: 22 });
    assert.equal(els['comp-user-bar'].hidden, false);
    assert.equal(els['cub-rank'].textContent, '#22');
    assert.equal(els['cub-val'].textContent, '1290 ELO');
  });

  it('stars and highlights the asker\'s own row, matched by identity', () => {
    const els = runRender({
      rows: page, userRank: 37,
      me: { uid: 'p22', rank: 37, name: 'SRI', rating: 1290, tier, level: 8 }
    });
    const html = els.board.innerHTML;
    assert.ok(html.indexOf('TWENTYTWO ★') >= 0, 'the row that is actually me');
    assert.ok(html.indexOf('TWENTYONE ★') < 0, 'not whoever sits at rank 37 of the page');
    assert.equal((html.match(/lb-row me/g) || []).length, 1);
  });

  it('renders an empty board without touching the summary bar', () => {
    const els = runRender({ rows: [], userRank: null, me: null });
    assert.match(els.board.innerHTML, /No rated racers yet/);
    assert.equal(els['comp-user-bar'].hidden, true);
  });
});

describe('build markers', () => {
  it('client build, server build, asset version and sw cache all agree', () => {
    // Four numbers that must move together. A half-done bump is not cosmetic: a
    // server/client mismatch makes every idle tab reload, and an sw.js left on the
    // previous version keeps precaching the OLD body under the OLD cache name -
    // which is how a racer ends up running yesterday's game.js after a deploy.
    const clientBuild = /const BUILD = '(v\d+)';/.exec(SRC);
    assert.ok(clientBuild, 'game.js must carry a BUILD marker');
    const srv = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const serverBuild = /res\.json\(\{ build: '(v\d+)'/.exec(srv);
    assert.ok(serverBuild, 'server.js /version must carry a build marker');
    assert.equal(serverBuild[1], clientBuild[1], 'a mismatch makes every idle tab reload');

    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const assetV = /\?v=(\d+)/.exec(html);
    assert.ok(assetV, 'index.html must cache-bust its assets');
    assert.equal('v' + assetV[1], clientBuild[1], 'the asset version must match the build');

    const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
    assert.match(sw, new RegExp("const CACHE = 'sridhar-rush-v" + assetV[1] + "'"),
      'the service-worker cache must be keyed to the same version');
    assert.ok(!new RegExp('\\?v=' + (Number(assetV[1]) - 1) + '\\b').test(html + sw),
      'no previous-version asset may be left in the page or the precache list');
  });

  it('the tab buttons look pressable, not disabled', () => {
    const css = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
    assert.match(css, /\.btab:hover/, 'the flat dim state is what read as "greyed out"');
    assert.match(css, /\.btab:focus-visible/);
    assert.match(css, /\.btab\.active:hover/, 'the active tab must not lose its highlight on hover');
  });
});
