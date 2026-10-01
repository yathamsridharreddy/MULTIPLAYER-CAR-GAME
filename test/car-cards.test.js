'use strict';
/* ============================================================================
   Car-select cards.

   v141 fixed the cards rendering EMPTY: the fallback swatch was assembled with
   `background:${hex}` where hex is a NUMBER, so the template literal emitted the
   decimal string "14747136" - not a CSS <color>. The browser dropped the
   declaration and the card was a transparent box.

   v145 changed WHAT the card shows: the picture is a baked portrait of the car
   (public/img/cars/<id>.webp) instead of a live render into a second WebGL
   context - identical on every device, no GPU context to lose, nothing to draw at
   open. The vector swatch stays as the fallback, so v141's guarantee still holds:
   a card is never empty.

   These tests build the REAL cards in a DOM and check every branch is visible,
   and that every picture they reference exists on disk.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game.js'), 'utf8');
const CAR_IDS = ['fury', 'storm', 'volt', 'viper', 'blaze', 'phantom', 'ghost', 'reaper'];
const HEX2ID = { 0xe10600: 'fury', 0x0a84ff: 'storm', 0xffd400: 'volt', 0x00a651: 'viper',
  0xff6a00: 'blaze', 0x7b2ff7: 'phantom', 0xffffff: 'ghost', 0x111111: 'reaper' };

// pull the real card block out of game.js and run it with a tiny fake DOM, so the
// test exercises the shipping code rather than a copy of it
function loadCardBuilder(opts) {
  opts = opts || {};
  const start = SRC.indexOf('// ---- car-select card art ---');
  const end = SRC.indexOf('// ---------------------------------------------------------------------------',
    SRC.indexOf('function buildCarCards()'));
  assert.ok(start > 0 && end > start, 'card builder block found');
  const block = SRC.slice(start, end);

  const made = [];
  const mkEl = (tag) => {
    const el = {
      tagName: tag, className: '', dataset: {}, style: {}, children: [], _html: '', _on: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      get innerHTML() { return this._html; },
      set innerHTML(v) {
        this._html = String(v);
        this.children = [];
        // the real code assigns markup to a holder and then reads firstChild
        if (/^\s*<svg/i.test(this._html)) {
          const child = mkEl('svg');
          child._html = this._html;          // set the field, not the setter (that recursed)
          // a real DOM would carry the markup's class onto the element
          const cls = /<svg[^>]*class="([^"]+)"/.exec(this._html);
          child.className = cls ? cls[1] : '';
          this.firstChild = child;
        }
      },
      querySelectorAll: () => [],
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      replaceWith(c) { const p = this.parent; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children[i] = c; } c.parent = p; },
      addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); },
      fire(t) { (this._on[t] || []).forEach((f) => f({ type: t })); },
      setAttribute(k, v) { this._attrs = this._attrs || {}; this._attrs[k] = String(v); },
      removeAttribute(k) { if (this._attrs) delete this._attrs[k]; },
      getAttribute(k) { return this._attrs ? this._attrs[k] : undefined; },
      hasAttribute(k) { return !!(this._attrs && k in this._attrs); }
    };
    made.push(el);
    return el;
  };
  const wrap = mkEl('div');
  const doc = { createElement: mkEl, getElementById: () => wrap };
  const sandbox = {
    console,
    document: doc,
    window: {},
    CarModels: { idForHex: (h) => HEX2ID[h | 0] || null },
    prefs: { quality: 'high', color: 0x0a84ff },
    savePrefs() {}, applyMyColor() {}, sendMeta() {}, toast() {},
    $: (id) => (id === 'car-cards' ? wrap : null)
  };
  sandbox.CAR_COLORS = [0xe10600, 0x0a84ff, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7, 0xffffff, 0x111111];
  sandbox.CAR_NAMES = [
    { e: '🔴', n: 'FURY' }, { e: '🔵', n: 'STORM' }, { e: '🟡', n: 'VOLT' }, { e: '🟢', n: 'VIPER' },
    { e: '🟠', n: 'BLAZE' }, { e: '🟣', n: 'PHANTOM' }, { e: '⚪', n: 'GHOST' }, { e: '⚫', n: 'REAPER' }
  ];
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // v155: the card tag is translated ("YOUR CAR"), so the shipped translator and its
  // dictionary run here too - the tag the racer reads is the tag this test asserts.
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8'),
    sandbox, { filename: 'i18n.js' });
  const tAt = SRC.indexOf('function tI18n(');
  assert.ok(tAt > 0, 'tI18n is in game.js');
  let tDepth = 0, tEnd = tAt;
  for (let j = SRC.indexOf('{', tAt); j < SRC.length; j++) {
    if (SRC[j] === '{') tDepth++;
    else if (SRC[j] === '}') { tDepth--; if (tDepth === 0) { tEnd = j + 1; break; } }
  }
  vm.runInContext(SRC.slice(tAt, tEnd), sandbox, { filename: 'tI18n.js' });
  assert.ok(sandbox.window.SRI18N && sandbox.window.SRI18N.en, 'the dictionary loaded');

  // v155: the roster the cards are drawn from is a const in this block, and a const in a
  // vm context does not land on the sandbox object - expose it through a closure so the
  // tests can hand the card builder a room and watch what it does with it.
  vm.runInContext(block +
    '\n;globalThis.__build = buildCarCards;globalThis.__art = carArtFor;' +
    'globalThis.__state = { cars: carsTaken, setSeated: function (v) { seatedInRoom = v; } };',
    sandbox, { filename: 'cards.js' });
  return { build: sandbox.__build, art: sandbox.__art, wrap, made, sandbox };
}

// ---- v155: a car belongs to one racer -------------------------------------
  // The card list is drawn from the room roster, so these run the real buildCarCards
  // against the real v155 state that ships in game.js.
function loadWithRoster(roster) {
  const h = loadCardBuilder();
  // the legend: colour -> the racer holding it
  h.sandbox.__state.cars.clear();
  for (const [color, holder] of roster) h.sandbox.__state.cars.set(color, holder);
  return h;
}

test('v155: a car another racer holds is marked, named and not selectable', () => {
    const h = loadWithRoster([[0xe10600, { slot: 2, name: 'RIVAL_92' }]]);
    h.build();
    const cards = h.wrap.children;
    const taken = cards.find((c) => c.dataset.color === '#e10600');
    assert.ok(taken, 'the taken car is still on the grid, so racers can see it is taken');
    assert.match(taken.className, /taken/, 'and it is marked as taken');
    assert.equal(taken.disabled, true, 'a taken car cannot be chosen');
    const tag = taken.children.find((c) => c.className === 'car-tag');
    assert.ok(tag, 'the card says who has it');
    assert.equal(tag.textContent, 'RIVAL_92', 'by name');
    // the other cars are untouched and still selectable
    for (const c of cards.filter((x) => x !== taken)) {
      assert.doesNotMatch(c.className, /taken/);
      assert.ok(!c.disabled, 'a free car is selectable');
    }
  });

test('v155: every free car stays free, and my own car is marked as mine', () => {
    const h = loadWithRoster([[0xe10600, { slot: 2, name: 'RIVAL_92' }]]);
    h.sandbox.__state.setSeated(true);          // seated in a room: cars have owners
    h.build();
    const mine = h.wrap.children.find((c) => c.dataset.color === '#0a84ff');   // the pref colour
    assert.match(mine.className, /active/, 'the saved choice is still marked');
    const tag = mine.children.find((c) => c.className === 'car-tag');
    assert.equal(tag.textContent, 'YOUR CAR', 'and says it is yours');
  });

test('v155: clicking a taken car does not steal it', () => {
    const h = loadWithRoster([[0xe10600, { slot: 2, name: 'RIVAL_92' }]]);
    h.build();
    const taken = h.wrap.children.find((c) => c.dataset.color === '#e10600');
    const before = h.sandbox.prefs.color;
    taken.fire('click');
    assert.equal(h.sandbox.prefs.color, before, 'the click is refused locally too');
    assert.doesNotMatch(taken.className, /active/, 'and it never becomes the chosen car');
  });

test('v155: with no room, no car is ever marked as taken', () => {
    const h = loadCardBuilder();
    h.build();
    for (const c of h.wrap.children) {
      assert.doesNotMatch(c.className, /taken/, 'solo setup offers every car');
      assert.ok(!c.disabled);
    }
  });

// the card's picture element, whichever branch produced it
function pictureOf(card) {
  return card.children.find((c) => c.className === 'car-thumb' || c.className === 'car-swatch');
}

test('v145: every card shows a portrait, and the file behind it EXISTS on disk', () => {
  const { build, wrap } = loadCardBuilder();
  build();
  assert.strictEqual(wrap.children.length, 8, 'eight cards');
  wrap.children.forEach((card, i) => {
    const pic = pictureOf(card);
    assert.ok(pic, `card ${i} has a picture area`);
    if (pic.className === 'car-thumb') {
      const rel = String(pic.src || '').replace(/^\//, '');
      assert.ok(fs.existsSync(path.join(ROOT, 'public', rel)), `card ${i} points at a real file: ${pic.src}`);
      assert.ok(fs.statSync(path.join(ROOT, 'public', rel)).size > 1024, `card ${i} picture is not a stub`);
    } else {
      assert.ok(/<svg/.test(pic.innerHTML), `card ${i} fell back to the drawn car`);
    }
    assert.ok(card.children.some((c) => c.className === 'mc-name'), `card ${i} shows its name`);
  });
});

test('v145: each card shows ITS OWN car, in the order the game lists them', () => {
  const { build, wrap, art } = loadCardBuilder();
  build();
  CAR_IDS.forEach((id, i) => {
    assert.strictEqual(art(sandboxHex(i)), `img/cars/${id}.webp`, `card ${i} is ${id}`);
    const src = wrap.children[i].children.find((c) => c.className === 'car-thumb').src;
    assert.strictEqual(src, `img/cars/${id}.webp`, `card ${i} shows ${id}`);
  });
  function sandboxHex(i) { return [0xe10600, 0x0a84ff, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7, 0xffffff, 0x111111][i]; }
});

test('v145: a picture that FAILS to load degrades to the drawn car, never an empty box', () => {
  // the v141 contract, still enforced: a missing/blocked/failed image must leave a
  // real drawing in the card rather than a blank rectangle
  const { build, wrap } = loadCardBuilder();
  build();
  const card = wrap.children[3];
  const img = card.children.find((c) => c.className === 'car-thumb');
  img.fire('error');
  const after = pictureOf(card);
  assert.ok(after, 'the card still has a picture area');
  assert.strictEqual(after.className, 'car-swatch', 'the fallback replaced the broken image');
  assert.ok(/<svg/.test(after.innerHTML), 'and it is a real drawing');
  assert.ok(/viewBox="0 0 120 64"/.test(after.innerHTML), 'with the stable viewBox');
  assert.ok(card.children.some((c) => c.className === 'mc-name'), 'the name survived the swap');
});

test('v145: the fallback swatch paints a VALID css colour (the original bug)', () => {
  // force the fallback path: no id mapping means no portrait to show
  const { build, wrap, sandbox } = loadCardBuilder();
  sandbox.CarModels.idForHex = () => null;
  build();
  assert.strictEqual(wrap.children.length, 8, 'eight cards on the fallback path');
  wrap.children.forEach((card, i) => {
    const pic = pictureOf(card);
    assert.strictEqual(pic.className, 'car-swatch', `card ${i} uses the silhouette fallback`);
    assert.ok(!/(fill|stroke|background|color)\s*[:=]\s*"?0x/i.test(pic.innerHTML), 'no 0x-prefixed colour');
    const fills = pic.innerHTML.match(/fill="(#[0-9a-f]{6})"/gi) || [];
    assert.ok(fills.length >= 1, `card ${i} paints the car with a #rrggbb colour`);
  });
  const all = wrap.children.map((c) => pictureOf(c).innerHTML).join(' ');
  assert.ok(!/background:\d/.test(all), 'a raw decimal must never be used as a CSS colour');
});

test('v145: each fallback swatch uses ITS OWN car colour', () => {
  const { build, wrap, sandbox } = loadCardBuilder();
  sandbox.CarModels.idForHex = () => null;
  build();
  const expected = [0xe10600, 0x0a84ff, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7, 0xffffff, 0x111111]
    .map((h) => '#' + h.toString(16).padStart(6, '0'));
  wrap.children.forEach((card, i) => {
    assert.ok(pictureOf(card).innerHTML.includes(expected[i]), `card ${i} paints ${expected[i]}`);
    assert.strictEqual(card.dataset.color, expected[i], `card ${i} exposes its paint as a CSS colour`);
  });
});

test('v145: the swatch is still a car silhouette, not a plain colour block', () => {
  const { build, wrap, sandbox } = loadCardBuilder();
  sandbox.CarModels.idForHex = () => null;
  build();
  const html = pictureOf(wrap.children[0]).innerHTML;
  assert.ok(/<svg/.test(html), 'vector car');
  assert.ok(/viewBox="0 0 120 64"/.test(html), 'stable viewBox');
  assert.strictEqual((html.match(/<circle[^>]*r="8\.8"/g) || []).length, 2, 'two wheels');
  assert.strictEqual((html.match(/<circle[^>]*r="3\.2"/g) || []).length, 2, 'two hubs');
  assert.ok(/<path[^>]*fill="#e10600"/.test(html), 'body painted in the car colour');
});

test('v145: hexCss converts a paint number to a usable CSS colour', () => {
  const { sandbox } = loadCardBuilder();
  const f = sandbox.hexCss;
  assert.strictEqual(f(0xe10600), '#e10600');
  assert.strictEqual(f(0x0a84ff), '#0a84ff');
  assert.strictEqual(f(0xffffff), '#ffffff');
  assert.strictEqual(f(0x000000), '#000000');
  assert.strictEqual(f(null), '#ffffff');
  assert.strictEqual(f(undefined), '#ffffff');
  assert.strictEqual(f(NaN), '#ffffff');
});

test('v145: the card picture area is styled so every branch shares one box', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  assert.ok(/\.car-thumb,\s*\.car-swatch\s*\{/.test(css), 'all branches styled together');
  assert.ok(/aspect-ratio:\s*120\s*\/\s*64/.test(css), 'fixed aspect ratio (no layout shift)');
  assert.ok(/\.car-swatch\s*\{\s*object-fit:\s*contain/.test(css), 'the vector fallback sits inside its box');
  assert.ok(/\.car-thumb[\s\S]{0,200}object-fit:\s*cover/.test(css), 'the portrait fills its box');
  assert.ok(/\.car-swatch[\s\S]{0,400}height:\s*84px/.test(css), 'fallback height for browsers without aspect-ratio');
});

test('v145: the picker no longer spends a second WebGL context', () => {
  // the live-preview pipeline existed only for these cards; with baked portraits it
  // is dead weight and a GPU context the phone cannot spare
  for (const gone of ['carPreviewRenderer', 'renderCarPreview', 'disposeCarPreview', '_prevCache', '_prevFailed']) {
    assert.ok(!SRC.includes(gone), gone + ' should be gone from game.js');
  }
  const block = SRC.slice(SRC.indexOf('// ---- car-select card art ---'), SRC.indexOf('function buildCarCards()'));
  assert.ok(!/WebGLRenderer|THREE\./.test(block), 'the card block does not touch WebGL');
});

test('v145: the portraits ship with the app and are small enough to precache', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  let total = 0;
  for (const id of CAR_IDS) {
    const rel = `public/img/cars/${id}.webp`;
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' exists');
    const size = fs.statSync(path.join(ROOT, rel)).size;
    total += size;
    assert.ok(size < 60 * 1024, `${id}.webp is ${Math.round(size / 1024)}KB - keep the card art small`);
    assert.ok(sw.includes(`/img/cars/${id}.webp`), `${id}.webp is precached`);
  }
  assert.ok(total < 200 * 1024, `all eight portraits together are ${Math.round(total / 1024)}KB`);
});

test('v141: every glass shape stays INSIDE the body outline (no panes poking out of the roof)', () => {
  const src = SRC;
  const svgFn = src.slice(src.indexOf('function hexCss(hex) {'),
    src.indexOf('// v145: the car cards show a rendered portrait'));
  const mod = new Function(svgFn + '; return { carSwatch };')();
  const svg = mod.carSwatch(0xe10600);

  // flatten the body path and the canopy path, then sample the canopy corners
  const flatten = (d) => {
    const toks = d.match(/[MLQCZ]|-?\d*\.?\d+/gi);
    const pts = []; let i = 0, px = 0, py = 0;
    const num = () => parseFloat(toks[i++]);
    while (i < toks.length) {
      const t = toks[i++].toUpperCase();
      if (t === 'M') { px = num(); py = num(); pts.push([px, py]); }
      else if (t === 'L') { px = num(); py = num(); pts.push([px, py]); }
      else if (t === 'Q') {
        const cx = num(), cy = num(), x = num(), y = num();
        for (let s = 1; s <= 16; s++) {
          const u = s / 16;
          pts.push([(1 - u) * (1 - u) * px + 2 * (1 - u) * u * cx + u * u * x,
                    (1 - u) * (1 - u) * py + 2 * (1 - u) * u * cy + u * u * y]);
        }
        px = x; py = y;
      }
    }
    return pts;
  };
  const inPoly = (pts, x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };

  const body = flatten(svg.match(/<path d="(M10[^"]+)"/)[1]);
  const glassMatch = svg.match(/<path d="(M44[^"]+)"/);
  assert.ok(glassMatch, 'canopy path present');
  const glass = flatten(glassMatch[1]);

  // sample the canopy densely: EVERY point must be inside the body paint
  let outside = 0, samples = 0;
  for (const [gx, gy] of glass) {
    for (const off of [[0, 0], [0.15, 0.15], [0.3, 0.3]]) {
      const x = gx + off[0], y = gy + off[1];
      samples++;
      if (!inPoly(body, x, y)) outside++;
    }
  }
  assert.strictEqual(outside, 0, outside + '/' + samples + ' canopy samples fell outside the body outline');

  // and the pillar band must sit inside the canopy's horizontal span
  const pillar = svg.match(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/);
  assert.ok(pillar, 'B-pillar band present');
  const px0 = parseFloat(pillar[1]), pw = parseFloat(pillar[2]);
  assert.ok(px0 >= 44 && px0 + pw <= 61.01, 'pillar band within the canopy top edge: ' + px0 + '+' + pw);
});
