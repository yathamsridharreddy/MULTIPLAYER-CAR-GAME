'use strict';
/* ============================================================================
   Lobby guest features must not depend on the optional account SDK.

   THE BUG (reported from a live lobby): two racers in the SAME room, one could
   open CLUBS and the other had no CLUBS button at all.

   #account-line holds CLUBS, BADGES, BOUNTIES and GARAGE alongside SIGN IN, and
   it ships `hidden` in index.html. The only code that ever revealed it was the
   racer-account IIFE, which returned early unless SRAccount.available() — i.e.
   unless window.SB_U and window.SB_A had been injected into js/config.js at
   deploy time and account.js had loaded. When they had not, four guest features
   disappeared for that one browser while a friend in the same lobby kept them.

   Clubs, badges, bounties and the garage are guest features: the server keys them
   by device pid or display name, and since v95 those rows are durable for
   signed-out racers too. Only signing in needs the SDK.

   The two helpers below are lifted straight out of the shipped public/js/game.js
   (brace-matched) and exercised against a fake DOM, so the truth table is pinned
   without a browser.
   ========================================================================== */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

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

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  ['accountRowVisibility', 'applyAccountRowVisibility'].map(extract).join('\n') +
  '\n;globalThis.__api = { accountRowVisibility, applyAccountRowVisibility };',
  sandbox
);
const { accountRowVisibility, applyAccountRowVisibility } = sandbox.__api;

// index.html ships the row hidden, with SIGN IN visible and SIGN OUT / FRIENDS
// hidden. Every fake-DOM test starts from that exact state.
function lobbyDom() {
  const els = {};
  for (const id of ['account-line', 'account-chip', 'account-btn', 'account-out', 'friends-btn',
                    'crew-btn', 'badges-btn', 'bounties-btn']) {
    els[id] = { id, hidden: false, textContent: '' };
  }
  els['account-line'].hidden = true;   // as shipped
  els['friends-btn'].hidden = true;    // as shipped
  els['account-out'].hidden = true;    // as shipped
  return els;
}

describe('Lobby guest features survive a missing account SDK', () => {
  it('the account row is shown whatever the account state', () => {
    for (const on of [false, true]) {
      for (const signIn of [false, true]) {
        assert.equal(accountRowVisibility(on, signIn).line, true,
          `accountsOn=${on} signedIn=${signIn}: CLUBS lives in this row, so it is always visible`);
      }
    }
  });

  it('with no account SDK the sign-in controls are hidden but the row is not', () => {
    const v = accountRowVisibility(false, false);
    assert.equal(v.line, true);
    assert.equal(v.signIn, false, 'signing in is impossible, so do not offer it');
    assert.equal(v.signOut, false);
    assert.equal(v.friends, false, 'the friends list needs an account uuid');
  });

  it('with accounts configured a guest sees SIGN IN and a member sees SIGN OUT + FRIENDS', () => {
    const guest = accountRowVisibility(true, false);
    assert.deepEqual([guest.signIn, guest.signOut, guest.friends], [true, false, false]);
    const member = accountRowVisibility(true, true);
    assert.deepEqual([member.signIn, member.signOut, member.friends], [false, true, true]);
  });

  it('THE REPORTED BUG: no SDK still leaves CLUBS reachable in the lobby', () => {
    const els = lobbyDom();
    applyAccountRowVisibility(accountRowVisibility(false, false), (id) => els[id]);
    assert.equal(els['account-line'].hidden, false,
      'the row that holds CLUBS is revealed even though accounts are unavailable');
    assert.equal(els['crew-btn'].hidden, false, 'and the CLUBS button itself is untouched');
    assert.equal(els['badges-btn'].hidden, false);
    assert.equal(els['bounties-btn'].hidden, false);
    assert.equal(els['account-btn'].hidden, true, 'only the account controls are gated');
    assert.equal(els['friends-btn'].hidden, true);
  });

  it('the same call with accounts available shows SIGN IN', () => {
    const els = lobbyDom();
    applyAccountRowVisibility(accountRowVisibility(true, false), (id) => els[id]);
    assert.equal(els['account-line'].hidden, false);
    assert.equal(els['account-btn'].hidden, false);
    assert.equal(els['account-out'].hidden, true);
  });

  it('signing in swaps SIGN IN for SIGN OUT without hiding the row', () => {
    const els = lobbyDom();
    applyAccountRowVisibility(accountRowVisibility(true, false), (id) => els[id]);
    applyAccountRowVisibility(accountRowVisibility(true, true), (id) => els[id]);
    assert.equal(els['account-line'].hidden, false, 'the row survives the transition');
    assert.equal(els['account-btn'].hidden, true);
    assert.equal(els['account-out'].hidden, false);
    assert.equal(els['friends-btn'].hidden, false);
  });

  it('a missing element is skipped instead of throwing', () => {
    const els = lobbyDom();
    delete els['friends-btn'];
    delete els['account-out'];
    assert.doesNotThrow(() => applyAccountRowVisibility(accountRowVisibility(true, true), (id) => els[id]));
    assert.equal(els['account-line'].hidden, false);
  });

  it('the old gate that hid the row is gone from the shipped client', () => {
    // This exact line is what deleted four features for one browser.
    assert.ok(!SRC.includes('if (!(window.SRAccount && SRAccount.available())) return;'),
      'the availability early-return must not come back');
    assert.ok(!/const line = \$\('account-line'\); if \(!line\) return;/.test(SRC),
      'the row reveal must not depend on the element lookup short-circuiting an account check');
  });

  it('the row is revealed BEFORE the account check can bail out', () => {
    const reveal = SRC.indexOf('applyAccountRowVisibility(accountRowVisibility(accountsOn, signedIn), $)');
    const bail = SRC.indexOf('if (!accountsOn) return;');
    assert.ok(reveal !== -1 && bail !== -1, 'both statements must exist');
    assert.ok(reveal < bail, 'reveal first, then bail - the opposite order is the bug');
  });

  it('the CLUBS wiring is not inside the account block', () => {
    const acctStart = SRC.indexOf('// ---- optional racer account (Supabase, v37)');
    const crewWiring = SRC.indexOf("const crewBtn = $('crew-btn');");
    assert.ok(acctStart !== -1 && crewWiring !== -1);
    assert.ok(crewWiring < acctStart,
      'the click handler is bound before, and independently of, the account IIFE');
  });

  it('index.html really does keep CLUBS in the gated row (this is why it broke)', () => {
    const at = HTML.indexOf('id="account-line"');
    assert.ok(at !== -1, 'the row exists');
    assert.match(HTML.slice(at - 60, at + 40), /hidden/, 'and it ships hidden, so JS must reveal it');
    const row = HTML.slice(at, at + 900);
    for (const id of ['crew-btn', 'badges-btn', 'bounties-btn', 'account-btn']) {
      assert.ok(row.includes('id="' + id + '"'), `${id} lives in the account row`);
    }
  });
});

// ---------------------------------------------------------------------------
// The other half of the fix: js/config.js is generated at deploy time and has no
// ?v= parameter, so a cached copy from before the Supabase values were injected
// is indistinguishable from a good one - and it disables accounts for that
// browser only. Neither the browser, nor a CDN edge, nor the service worker may
// hold on to it.
// ---------------------------------------------------------------------------
describe('js/config.js can never be served stale', () => {
  it('the service worker refuses to store it', () => {
    const nocache = SW.slice(SW.indexOf('const NOCACHE'));
    assert.match(nocache, /'\/js\/config\.js'/, 'config.js is in the never-cache list');
    const core = SW.slice(SW.indexOf('const CORE'), SW.indexOf('const NOCACHE'));
    assert.ok(!core.includes('config.js'), 'and it is not precached either');
  });

  it('the server sends it no-store', async () => {
    const { app } = require('../server.js');
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/js/config.js`);
      assert.equal(res.status, 200, 'the file is served');
      const cc = String(res.headers.get('cache-control') || '');
      assert.match(cc, /no-store/, `config.js must be no-store, got "${cc}"`);
      assert.match(cc, /max-age=0/);
      const body = await res.text();
      assert.match(body, /window\.SERVER_URL/, 'and it is the generated config');
    } finally { server.close(); }
  });

  it('both config shapes are understood by the account client', () => {
    // Two writers, one reader. scripts/vercel-build.js emits window.SB_U/SB_A at
    // build time; the server route emits window.SUPABASE_URL/SUPABASE_ANON at
    // request time. account.js must accept either, or one of the two deploys
    // silently has no accounts - and before v96 that also hid the CLUBS row.
    const acct = fs.readFileSync(path.join(ROOT, 'public/js/account.js'), 'utf8');
    assert.match(acct, /window\.SB_U\s*\|\|\s*window\.SUPABASE_URL/, 'reads the URL from either name');
    assert.match(acct, /window\.SB_A\s*\|\|\s*window\.SUPABASE_ANON/, 'and the anon key from either name');
    const build = fs.readFileSync(path.join(ROOT, 'scripts/vercel-build.js'), 'utf8');
    assert.match(build, /window\.SB_U=/, 'the build script still writes SB_U');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(srv, /window\.SUPABASE_URL = /, 'and the server route still writes SUPABASE_URL');
  });

  it('the account row does not depend on the config arriving at all', () => {
    // The whole point of the fix: an empty config.js must cost the racer SIGN IN,
    // not CLUBS. Assert the shipped client never gates the row on availability.
    const fnStart = SRC.indexOf('function wireLobbyV2()');
    const body = SRC.slice(fnStart, SRC.indexOf("const nameEl = $('inp-name');", fnStart));
    const reveal = body.indexOf('applyAccountRowVisibility(');
    const bail = body.indexOf('if (!accountsOn) return;');
    assert.ok(reveal !== -1 && bail !== -1);
    assert.ok(reveal < bail, 'reveal the row, then bail - never the other way round');
  });

  it('the HTML routes stay no-store too (stale ?v= refs drift the geometry)', async () => {
    const { app } = require('../server.js');
    const server = app.listen(0);
    try {
      for (const p of ['/', '/controller.html']) {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
        assert.match(String(res.headers.get('cache-control') || ''), /no-store/, p);
      }
      // A versioned asset is still cacheable - only config.js and HTML are not.
      const js = await fetch(`http://127.0.0.1:${server.address().port}/js/game.js?v=104`);
      assert.ok(!/no-store/.test(String(js.headers.get('cache-control') || '')),
        'versioned files keep their normal caching');
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// The other mechanism that produces exactly this report: buildCarCards() creates
// a SECOND WebGL context, and it used to run before the CLUBS button was wired.
// A GPU on the browser's blocklist, hardware acceleration off, the per-page
// context limit, or a context lost mid-session all make that throw - which
// unwound wireLobbyV2() and left the buttons unwired and the row unrevealed.
// These tests run the real shipped functions against a stub renderer that fails.
// ---------------------------------------------------------------------------
function carSandbox(rendererThrows) {
  const made = [];
  const el = () => {
    const e = {
      className: '', dataset: {}, innerHTML: '', children: made,
      addEventListener() {}, setAttribute() {},
      appendChild(c) { made.push(c); return c; },
      querySelectorAll() { return []; }
    };
    return e;
  };
  const wrap = el();
  let ctorCalls = 0;
  const sb = {
    console: { warn() {}, log() {}, error() {} },
    $: (id) => (id === 'car-cards' ? wrap : null),
    document: { createElement: () => el() },
    CAR_COLORS: ['#ff3344', '#00e5ff', '#ffd479'],
    CAR_NAMES: [{ e: '🏎️', n: 'REDLINE' }, { e: '⚡', n: 'AKINA' }, { e: '🌃', n: 'MIDNIGHT' }],
    prefs: { color: '#00e5ff', cos: {} },
    savePrefs() {}, applyMyColor() {}, sendMeta() {}, toast() {},
    createCar: () => ({ group: {}, paint: { color: { setHex() {} } } }),
    shellForHex: () => 'ghost', disposeCarVisual() {}, BODY_FOR_CLASS: { velocity: 0 },
    THREE: {
      WebGLRenderer: function () {
        ctorCalls++;
        if (rendererThrows) throw new Error('Error creating WebGL context');
        return { setSize() {}, render() {}, domElement: { toDataURL: () => 'data:image/png;base64,AAA' } };
      },
      Scene: function () { this.add = () => {}; },
      HemisphereLight: function () {},
      DirectionalLight: function () { this.position = { set() {} }; },
      PerspectiveCamera: function () { this.position = { set() {} }; this.lookAt = () => {}; }
    },
    __wrap: wrap,
    __ctorCalls: () => ctorCalls,
    __cards: made
  };
  vm.createContext(sb);
  vm.runInContext(
    'let _prev = null; let _prevFailed = false;\n' +
    ['carPreviewRenderer', 'renderCarPreview', 'buildCarCards'].map(extract).join('\n') +
    '\n;globalThis.__api = { carPreviewRenderer, buildCarCards };',
    sb
  );
  return sb;
}

describe('A failing 3D car preview cannot take the lobby down', () => {
  it('builds every car card as a swatch when the WebGL context fails', () => {
    const sb = carSandbox(true);
    assert.doesNotThrow(() => sb.__api.buildCarCards(),
      'the picker must still be built - this throw is what used to delete CLUBS');
    assert.equal(sb.__cards.length, 3, 'all three cars are offered');
    for (const c of sb.__cards) {
      assert.ok(!c.innerHTML.includes('<img'), 'no preview image without a context');
      assert.match(c.innerHTML, /mc-swatch/, 'a colour swatch instead');
      assert.match(c.innerHTML, /REDLINE|AKINA|MIDNIGHT/, 'and the car is still named');
    }
    assert.ok(sb.__cards.some((c) => /active/.test(c.className)), 'the saved choice is still marked');
  });

  it('does not retry a renderer that already failed', () => {
    const sb = carSandbox(true);
    assert.equal(sb.__api.carPreviewRenderer(), null, 'null, not a throw');
    sb.__api.buildCarCards();
    sb.__api.buildCarCards();
    assert.equal(sb.__ctorCalls(), 1,
      'one attempt, then remembered - retrying would throw on every lobby visit');
  });

  it('still renders real 3D previews when the context works', () => {
    const sb = carSandbox(false);
    sb.__api.buildCarCards();
    assert.equal(sb.__cards.length, 3);
    for (const c of sb.__cards) {
      assert.match(c.innerHTML, /<img src="data:image\/png/, 'the swatch is only a fallback');
      assert.ok(!c.innerHTML.includes('mc-swatch'));
    }
  });

  it('a context lost mid-render degrades that card instead of emptying the list', () => {
    const sb = carSandbox(false);
    // the renderer is created fine, then toDataURL starts throwing (lost context)
    sb.__api.carPreviewRenderer();
    const orig = sb.THREE.WebGLRenderer;
    sb.THREE.WebGLRenderer = function () {
      const r = new orig();
      r.domElement.toDataURL = () => { throw new Error('CONTEXT_LOST_WEBGL'); };
      return r;
    };
    vm.runInContext('_prev = null; _prevFailed = false;', sb);
    assert.doesNotThrow(() => sb.__api.buildCarCards());
    assert.equal(sb.__cards.length, 3, 'every card survives a lost context');
    assert.ok(sb.__cards.every((c) => /mc-swatch/.test(c.innerHTML)));
  });

  it('the guest wiring runs before anything that creates a WebGL context', () => {
    const fnStart = SRC.indexOf('function wireLobbyV2()');
    assert.ok(fnStart !== -1);
    const crew = SRC.indexOf("const crewBtn = $('crew-btn');", fnStart);
    const reveal = SRC.indexOf('applyAccountRowVisibility(accountRowVisibility(accountsOn, signedIn), $)', fnStart);
    const previews = SRC.indexOf('buildCarCards();', fnStart);
    assert.ok(crew !== -1 && reveal !== -1 && previews !== -1, 'all three must be in wireLobbyV2');
    assert.ok(crew < previews, 'CLUBS is wired before the car previews are built');
    assert.ok(reveal < previews, 'and the row is revealed before them too');
  });

  it('each critical block is isolated, so one failure cannot take out the next', () => {
    const fnStart = SRC.indexOf('function wireLobbyV2()');
    // Up to the first statement that follows both critical blocks. Slicing to the
    // next `function ` would stop inside the account IIFE, which contains one.
    const body = SRC.slice(fnStart, SRC.indexOf("const nameEl = $('inp-name');", fnStart));
    assert.match(body, /catch \(e\) \{ console\.warn\('\[lobby\] club wiring failed'/);
    assert.match(body, /catch \(e\) \{ console\.warn\('\[lobby\] account row wiring failed'/);
    const clubTry = body.indexOf('try {');
    const clubCatch = body.indexOf("club wiring failed");
    const acctTry = body.indexOf('try {', clubCatch);
    assert.ok(clubTry < clubCatch && clubCatch < acctTry,
      'two separate try/catch blocks, in order');
  });
});
