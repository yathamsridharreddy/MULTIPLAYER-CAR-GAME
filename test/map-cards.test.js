'use strict';
/* ============================================================================
   v148 - the circuit cards.

   They had the same shape of problem the weather row had: the picture sat in an
   inset thumbnail inside a grey box, every card's accent was the same cyan, and
   the layout could go ragged - "ISLAND MOTORFEST" wrapped onto a second line and
   its card grew taller than the four beside it.

   The circuit is now the card: the picture is full-bleed at a fixed height, each
   circuit has its own accent, the title block reserves two lines so the row can
   never come out uneven, and .card-row uses auto-fit so five circuits fill the
   row instead of leaving an empty track at the end.

   The name/sub styles are deliberately SCOPED to .map-card, because the car cards
   share .mc-name and are built in game.js - one test below exists purely to catch
   a change here that damages them.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');

const CIRCUITS = [
  { n: 0, art: 'highland', name: 'HIGHLAND RUSH' },
  { n: 1, art: 'neon', name: 'NEON CITY' },
  { n: 2, art: 'island', name: 'ISLAND MOTORFEST' },
  { n: 3, art: 'canyon', name: 'CANYON CHICANE' },
  { n: 4, art: 'snow', name: 'HAIRPIN GP' }
];

const row = HTML.slice(HTML.indexOf('<div class="card-row" id="map-cards">'),
  HTML.indexOf('<!-- step 1.5'));
const cards = row.split('<button class="map-card').slice(1);
// the map-card rules only: this slice starts at the v148 block so the SHARED
// .mc-name rule that lives just above it is not mistaken for a leaked scoped rule
const block = CSS.slice(CSS.indexOf('/* ---- Circuit cards (v148)'), CSS.indexOf('/* Weather Condition Cards */'));
const rowBlock = CSS.slice(CSS.indexOf('.card-row {'), CSS.indexOf('/* Weather Condition Cards */'));

// ---------------------------------------------------------------------------
// markup
// ---------------------------------------------------------------------------

test('v148: all five circuits are still offered, in order', () => {
  assert.strictEqual(cards.length, 5, 'five circuit cards');
  CIRCUITS.forEach((c) => {
    assert.ok(row.includes(`data-map="${c.n}"`), `circuit ${c.n} present`);
    assert.ok(row.includes(`>${c.name.split(' ')[0]}`), `circuit ${c.n} keeps its name`);
  });
});

test('v148: every card shows its own circuit picture, and the file exists', () => {
  CIRCUITS.forEach((c) => {
    const rel = `public/img/map-${c.art}.webp`;
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' exists');
    const size = fs.statSync(path.join(ROOT, rel)).size;
    assert.ok(size > 4096, rel + ' is not a stub');
    assert.ok(size < 60 * 1024, `${c.art}.webp is ${Math.round(size / 1024)}KB - keep it small`);
  });
  cards.forEach((c, i) => {
    assert.ok(c.includes(`img/map-${CIRCUITS[i].art}.webp`), `card ${i} points at its circuit picture`);
    assert.match(c, /alt="[^"]+"/, `card ${i} has alt text`);
  });
});

test('v148: the two text lines are wrapped so they can be laid out as one block', () => {
  cards.forEach((c, i) => {
    assert.match(c, /<div class="mc-text">/, `card ${i} groups its text`);
    assert.match(c, /class="mc-name"[^>]*data-i18n=/, `card ${i} has a translatable title`);
    assert.match(c, /class="mc-sub"[^>]*data-i18n=/, `card ${i} has a translatable subtitle`);
    assert.ok(c.indexOf('mc-name') < c.indexOf('mc-sub'), `card ${i} orders title before subtitle`);
  });
});

// ---------------------------------------------------------------------------
// stylesheet
// ---------------------------------------------------------------------------

test('v148: the circuit is the card - the picture is full-bleed, not an inset thumbnail', () => {
  assert.match(block, /\.map-card\s*\{[^}]*padding:\s*0;/, 'no inner padding around the picture');
  assert.match(block, /\.map-card img\s*\{[^}]*width:\s*100%/, 'the picture spans the card');
  assert.match(block, /\.map-card img\s*\{[^}]*border-radius:\s*0/, 'the card radius clips it instead');
  assert.match(block, /\.map-card\s*\{[^}]*overflow:\s*hidden/, 'so the corners stay rounded');
});

test('v148: the picture is ONE height on every card', () => {
  // a per-card picture height is how the row went ragged in the first place
  assert.match(block, /\.map-card\s*\{[^}]*grid-template-rows:\s*118px\s+1fr/, 'a fixed picture row');
  assert.match(block, /\.map-card img\s*\{[^}]*height:\s*118px/, 'and a matching fixed picture height');
  assert.ok(!/height:\s*auto/.test(block.slice(block.indexOf('.map-card img'), block.indexOf('.map-card::before'))),
    'the picture height is never left to the file');
});

test('v148: the title reserves two lines, so no card can grow taller than its neighbours', () => {
  const name = block.slice(block.indexOf('.map-card .mc-name'), block.indexOf('.map-card .mc-sub'));
  assert.match(name, /min-height:\s*2\.4em/,
    'the longest name ("ISLAND MOTORFEST") must not be able to change the card height');
  assert.match(name, /line-height:\s*1\.2/, 'and the reserved height is line-height based');
});

test('v148: each circuit carries its own accent, and they are all different', () => {
  const accents = CIRCUITS.map((c) => {
    const m = block.match(new RegExp('\\.map-card\\[data-map="' + c.n + '"\\]\\s*\\{\\s*--mc:\\s*(#[0-9a-f]{6})'));
    assert.ok(m, `circuit ${c.n} declares an accent`);
    return m[1].toLowerCase();
  });
  assert.strictEqual(new Set(accents).size, 5, 'five distinct accents: ' + accents.join(', '));
  CIRCUITS.forEach((c) => {
    assert.ok(new RegExp(`data-map="${c.n}"[^{]*\\{[^}]*--mc-rgb`).test(block),
      `circuit ${c.n} accent can also paint translucently`);
  });
  // and the old hardcoded cyan active state is gone
  assert.ok(!/\.map-card\.active\s*\{[^}]*var\(--cyber-cyan\)/.test(block),
    'the active card uses its own accent, not cyan for everything');
});

test('v148: the active card and keyboard focus are both obvious', () => {
  assert.match(block, /\.map-card\.active\s*\{[^}]*border-color:\s*rgba\(var\(--mc-rgb\)/,
    'the active border takes the circuit accent');
  assert.match(block, /\.map-card\.active \.mc-name\s*\{[^}]*color:\s*var\(--mc\)/,
    'so does the title');
  assert.match(block, /\.map-card\.active::before\s*\{\s*opacity:\s*1/, 'the accent spine lights up');
  assert.match(block, /\.map-card:focus-visible/, 'keyboard focus is visible');
});

test('v148: five circuits fill the row instead of leaving an empty track', () => {
  assert.match(rowBlock, /\.card-row\s*\{[^}]*repeat\(auto-fit,\s*minmax\(172px,\s*1fr\)\)/,
    'auto-fit collapses the unused track');
  assert.ok(!/repeat\(auto-fill/.test(rowBlock), 'auto-fill left the row short of the panel edge');
});

test('v148: the picture settles into the card instead of stopping on a hard edge', () => {
  assert.match(block, /\.map-card::after\s*\{[\s\S]*?linear-gradient\(180deg/, 'a fade under the picture');
});

test('v148: the car cards are NOT damaged by any of this', () => {
  // the car cards are built in game.js and share .mc-name; they depend on the
  // shared base rule for their font, and on their own rule for the centring
  assert.match(CSS, /^\.mc-name\s*\{[^}]*font:\s*800 12px var\(--font-display\)/m,
    'the shared title rule still sets the display font');
  assert.match(CSS, /\.car-card \.mc-name\s*\{\s*text-align:\s*center;\s*\}/,
    'the car card title is still centred');
  // every new title rule must be scoped, or it lands on the car cards too
  const unscoped = block.match(/^\.mc-(name|sub)\s*\{/m);
  assert.strictEqual(unscoped, null, 'no unscoped .mc-name/.mc-sub rule in the map block');
});
