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
    // slice to the row's own closing tag. A fixed width broke the moment the
    // buttons gained icons - the row was fine, the window was just too small.
    const row = HTML.slice(at, HTML.indexOf('</div>', HTML.indexOf('id="account-out"', at)));
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
function carSandbox() {
  // v145: the card list is built from baked portraits, so this harness needs no
  // THREE stub at all - and that is the point. These tests prove the picker cannot
  // be taken down by a picture, because there is no GPU work in the path any more.
  const made = [];
  const mkEl = (tag) => {
    const el = {
      tagName: tag, className: '', dataset: {}, style: {}, children: [], _html: '', _on: {},
      classList: {
        _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); }
      },
      get innerHTML() { return this._html; },
      set innerHTML(v) {
        this._html = String(v); this.children = [];
        if (/^\s*<svg/i.test(this._html)) {
          const child = mkEl('svg');
          child._html = this._html;
          const cls = /<svg[^>]*class="([^"]+)"/.exec(this._html);
          child.className = cls ? cls[1] : '';
          this.firstChild = child;
        }
      },
      querySelectorAll: () => [],
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      replaceWith(c) { const p = this.parent; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children[i] = c; } c.parent = p; },
      addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); },
      fire(t) { (this._on[t] || []).forEach((f) => f({ type: t })); }
    };
    made.push(el);
    return el;
  };
  const wrap = mkEl('div');
  const HEX2ID = { 0x111111: 'reaper', 0x222222: 'fury', 0x333333: 'storm' };
  const sb = {
    console,
    document: { createElement: mkEl, getElementById: (id) => (id === 'car-cards' ? wrap : null) },
    window: {},
    CarModels: { idForHex: (h) => HEX2ID[h | 0] || null },
    prefs: { quality: 'low', color: 0x222222 },
    CAR_COLORS: [0x111111, 0x222222, 0x333333],
    CAR_NAMES: [{ e: '', n: 'MIDNIGHT' }, { e: '', n: 'REDLINE' }, { e: '', n: 'AKINA' }],
    savePrefs() {}, applyMyColor() {}, sendMeta() {},
    $: (id) => (id === 'car-cards' ? wrap : null)
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  const extract = (name) => {
    const at = SRC.indexOf('function ' + name + '(');
    assert.ok(at > 0, name + ' exists in game.js');
    let depth = 0;
    for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
      if (SRC[j] === '{') depth++;
      else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(at, j + 1); }
    }
    throw new Error('could not extract ' + name);
  };
  // the id -> portrait table is a module-level const, not a function, so it has to
  // be carried over with them
  const artAt = SRC.indexOf('const CAR_ART = {');
  const artDecl = SRC.slice(artAt, SRC.indexOf('};', artAt) + 2);
  assert.ok(artAt > 0 && artDecl.length > 20, 'CAR_ART table found');
  // v155: the card list is drawn from the room - who is in which car - so the state
  // those helpers read has to come across too, exactly as it ships
  const lockAt = SRC.indexOf('// v155 — who is in the room, who runs it, and who is driving what.');
  const lockEnd = SRC.indexOf('function applyRoomRoster', lockAt);
  const lockDecls = SRC.slice(lockAt, lockEnd);
  assert.ok(lockAt > 0 && /let seatedInRoom/.test(lockDecls), 'v155 room state found');
  // v155: the card tag is translated, so the shipped dictionary and translator come too
  vm.runInContext(
    [artDecl, lockDecls, extract('carTakenBy'), extract('hexCss'), extract('carSwatch'),
      extract('carArtFor'), extract('buildCarCards')].join('\n') +
    '\n;globalThis.__api = { buildCarCards };',
    sb
  );
  vm.runInContext(require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8'),
    sb, { filename: 'i18n.js' });
  const tAt = SRC.indexOf('function tI18n(');
  assert.ok(tAt > 0, 'tI18n is in game.js');
  let tDepth = 0, tEnd = tAt;
  for (let j = SRC.indexOf('{', tAt); j < SRC.length; j++) {
    if (SRC[j] === '{') tDepth++;
    else if (SRC[j] === '}') { tDepth--; if (tDepth === 0) { tEnd = j + 1; break; } }
  }
  vm.runInContext(SRC.slice(tAt, tEnd) + '\n;globalThis.__i18nReady = true;', sb, { filename: 'tI18n.js' });
  sb.__wrap = wrap;
  sb.__cards = made;
  return sb;
}

describe('A car picture can never take the lobby down', () => {
  it('builds every card with no WebGL context available at all', () => {
    // v145: the picker makes no GL calls, so "no second context" is no longer a
    // degraded path, it is the only path. Previously this situation left cards
    // empty and could delete CLUBS/BADGES with it.
    const sb = carSandbox();
    assert.doesNotThrow(() => sb.__api.buildCarCards());
    const cards = sb.__wrap.children;
    assert.equal(cards.length, 3, 'every car is still offered');
    assert.ok(cards.every((c) => c.children.some((x) => x.className === 'mc-name')), 'every card is named');
    assert.ok(cards.some((c) => /active/.test(c.className)), 'the saved choice is still marked');
  });

  it('a portrait that fails to decode degrades that card, not the list', () => {
    const sb = carSandbox();
    sb.__api.buildCarCards();
    const cards = sb.__wrap.children;
    const img = cards[1].children.find((c) => c.className === 'car-thumb');
    img.fire('error');
    const pic = cards[1].children.find((c) => c.className === 'car-thumb' || c.className === 'car-swatch');
    assert.equal(pic.className, 'car-swatch', 'the broken card fell back to the drawn car');
    assert.match(pic.innerHTML, /<svg[^>]*viewBox="0 0 120 64"/, 'and it is a real car, not an empty box');
    assert.equal(cards.length, 3, 'and the other cards are untouched');
  });

  it('the card block does no GPU work at all (nothing to lose a context over)', () => {
    const start = SRC.indexOf('// ---- car-select card art ---');
    const block = SRC.slice(start, SRC.indexOf('function buildCarCards()'));
    assert.ok(!/WebGLRenderer|THREE\.|toDataURL/.test(block), 'the card block never touches WebGL');
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
