'use strict';
/* ============================================================================
   v146 - the weather row looked broken.

   The CSS styled the card's title with positional selectors:

       .weather-btn span:first-child { font: 800 12px var(--font-display); ... }
       .weather-btn span:last-child  { font-size: 11px; color: #8fa2b8; }

   Those were written for a card whose FIRST child is the title, but on this row
   the first child is the ICON. So the icon was handed the display font, the
   title fell through to the browser's default button font (grey system text)
   and the description - actually the last child - got the muted style while a
   second line of its own wrapped underneath. All four cards were the same grey
   box, and the grip figure a racer compares between them was buried in prose.

   These tests pin the markup, the stylesheet and the label splitting.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const GAME = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game.js'), 'utf8');
const I18N = fs.readFileSync(path.join(ROOT, 'public', 'js', 'i18n.js'), 'utf8');

const WEATHERS = ['dry', 'wet', 'night', 'blizzard'];
const row = HTML.slice(HTML.indexOf('<div class="weather-row"'), HTML.indexOf('<!-- step 2 : car cards -->'));
const cardBlocks = row.split('<button class="weather-btn').slice(1);

// ---------------------------------------------------------------------------
// markup
// ---------------------------------------------------------------------------

test('v146: the weather row still offers all four conditions', () => {
  assert.strictEqual(cardBlocks.length, 4, 'four cards');
  WEATHERS.forEach((w) => {
    assert.ok(row.includes(`data-weather="${w}"`), `${w} card present`);
  });
});

test('v147: every part of a card has its own class (no positional spans at all)', () => {
  cardBlocks.forEach((b, i) => {
    assert.match(b, /class="wx-art"/, `card ${i} has its condition picture`);
    assert.match(b, /class="wx-head"/, `card ${i} groups icon + title into one row`);
    assert.match(b, /class="wx-ico"/, `card ${i} wraps its icon`);
    assert.match(b, /class="wx-name"[^>]*data-i18n=/, `card ${i} names its title`);
    assert.match(b, /class="wx-sub"[^>]*data-i18n=/, `card ${i} names its subtitle`);
    assert.ok(b.indexOf('wx-head') < b.indexOf('wx-sub'), `card ${i} puts the title row above the detail row`);
    assert.ok(b.indexOf('wx-art') < b.indexOf('wx-head'), `card ${i} paints the picture first`);
    // every span must be classed: an unclassed one is exactly what made the old
    // stylesheet guess with :first-child / :last-child
    const unclassed = (b.match(/<span(?![^>]*class=)[^>]*>/g) || []);
    assert.deepStrictEqual(unclassed, [], `card ${i} has no unclassed span: ` + unclassed.join(' '));
    // an icon floated beside a stacked text column is the layout that looked broken
    assert.ok(!/class="wx-txt"/.test(b), `card ${i} no longer stacks its text beside a floating icon`);
  });
});

test('v147: each condition has its own picture, shipped and precached', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  let total = 0;
  WEATHERS.forEach((w) => {
    const rel = 'public/img/weather/' + w + '.webp';
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' exists');
    const size = fs.statSync(path.join(ROOT, rel)).size;
    total += size;
    assert.ok(size < 60 * 1024, `${w}.webp is ${Math.round(size / 1024)}KB - keep the card art small`);
    assert.ok(sw.includes('/img/weather/' + w + '.webp'), `${w}.webp is precached`);
    assert.ok(row.includes(`data-weather="${w}"`), `${w} card present`);
  });
  assert.ok(total < 200 * 1024, `all four together are ${Math.round(total / 1024)}KB`);
});

test('v147: the text always has a scrim to sit on', () => {
  const block = CSS.slice(CSS.indexOf('.weather-row {'), CSS.indexOf('/* Car Cards */'));
  const scrim = block.slice(block.indexOf('.weather-btn::before'), block.indexOf('.weather-btn::after'));
  // two gradients: one from the reading edge (so the title and grip never sit on
  // raw asphalt) and one settling at the bottom (where the grip row lives). Both
  // are needed - a single flat wash either buries the picture or loses the text.
  assert.strictEqual((scrim.match(/linear-gradient\(/g) || []).length, 2, 'two gradients');
  assert.match(scrim, /rgba\(5, 8, 14, 0\.94\)/, 'dark at the reading edge');
  assert.match(scrim, /rgba\(5, 8, 14, 0\.16\)/, 'and clearing toward the picture side');
  assert.match(scrim, /rgba\(5, 8, 14, 0\.60\)/, 'with a settle at the bottom for the grip row');
  // the picture must sit UNDER the scrim, or the text loses its contrast
  const art = block.slice(block.indexOf('.weather-btn .wx-art'), block.indexOf('.weather-btn::before'));
  assert.match(art, /z-index:\s*0/, 'the picture is the bottom layer');
  assert.match(scrim, /z-index:\s*1/, 'the scrim sits above it');
  const head = block.slice(block.indexOf('.weather-btn .wx-head'), block.indexOf('.weather-btn .wx-ico'));
  assert.match(head, /z-index:\s*2/, 'and the content above both');
  // the picture has to stay visible: a scrim can never be the whole design
  assert.match(art, /opacity:\s*0\.9/, 'the artwork is not buried');
});

test('v147: every card still carries its condition\'s accent', () => {
  const block = CSS.slice(CSS.indexOf('.weather-row {'), CSS.indexOf('/* Car Cards */'));
  const accents = WEATHERS.map((w) => {
    const m = block.match(new RegExp('\\.weather-btn\\[data-weather="' + w + '"\\]\\s*\\{[^}]*--wx:\\s*(#[0-9a-f]{6})'));
    assert.ok(m, `${w} declares an accent`);
    return m[1].toLowerCase();
  });
  assert.strictEqual(new Set(accents).size, 4, 'the four accents are distinct: ' + accents.join(', '));
  WEATHERS.forEach((w) => {
    assert.ok(new RegExp(`\\[data-weather="${w}"\\][^{]*\\{[^}]*--wx-art:\\s*url`).test(block), `${w} points at its picture`);
  });
});

test('v146: the icon is decorative and the button is a real button', () => {
  cardBlocks.forEach((b, i) => {
    assert.match(b, /type="button"/, `card ${i} cannot submit a form`);
    assert.match(b, /class="ico weather-ico"[^>]*data-i="weather-/, `card ${i} has a weather icon`);
    assert.match(b, /aria-hidden="true"/, `card ${i} hides the decorative icon`);
  });
});

test('v146: every weather card key is translated in all four languages', () => {
  const keys = ['wDry', 'wDrySub', 'wWet', 'wWetSub', 'wNight', 'wNightSub', 'wBlizzard', 'wBlizzardSub'];
  const langs = ['en', 'te', 'hi', 'es'];
  langs.forEach((l) => {
    const at = I18N.indexOf(`\n  ${l}: {`);
    assert.ok(at > 0, `${l} block exists`);
    const next = I18N.indexOf('\n  }', at);
    const block = I18N.slice(at, next);
    keys.forEach((k) => {
      assert.ok(new RegExp(`\\b${k}:`).test(block), `${l} translates ${k}`);
    });
  });
});

// ---------------------------------------------------------------------------
// stylesheet
// ---------------------------------------------------------------------------

test('v146: the stylesheet no longer styles weather cards by position', () => {
  const block = CSS.slice(CSS.indexOf('.weather-row {'), CSS.indexOf('/* Car Cards */'));
  assert.ok(!/\.weather-btn\s+span:first-child/.test(block), 'no span:first-child');
  assert.ok(!/\.weather-btn\s+span:last-child/.test(block), 'no span:last-child');
  assert.ok(!/\.weather-btn\.active\s+span:first-child/.test(block), 'no positional active rule');
  // every part the markup uses must actually be styled - a class in the HTML with
  // no rule is exactly how this row broke in the first place
  for (const cls of ['.wx-art', '.wx-head', '.wx-ico', '.wx-name', '.wx-sub', '.wx-grip', '.wx-desc']) {
    assert.ok(block.includes(cls), `${cls} is styled`);
  }
});

test('v146: the chosen card is obvious without relying on hover', () => {
  const block = CSS.slice(CSS.indexOf('.weather-row {'), CSS.indexOf('/* Car Cards */'));
  assert.ok(/\.weather-btn\.active\s*\{[\s\S]*?border-color:\s*rgba\(var\(--wx-rgb\)/.test(block),
    'the active border takes the accent');
  assert.ok(/\.weather-btn\.active \{/.test(block) && /border-left-color:\s*var\(--wx\)/.test(block),
    'the active card lights its accent rail');
  assert.ok(/\.weather-btn\.active\s+\.wx-name\s*\{\s*color:\s*var\(--wx\)/.test(block),
    'the active title turns the accent colour');
  assert.ok(/\.weather-btn:focus-visible/.test(block), 'keyboard focus is visible');
});

test('v146: the title uses the display font and the description stays quiet', () => {
  const block = CSS.slice(CSS.indexOf('.weather-row {'), CSS.indexOf('/* Car Cards */'));
  const name = block.slice(block.indexOf('.weather-btn .wx-name'), block.indexOf('.weather-btn .wx-sub'));
  assert.match(name, /var\(--font-display\)/, 'the title is display type');
  assert.match(name, /font:\s*800/, 'and bold');
  const desc = block.slice(block.indexOf('.weather-btn .wx-desc'), block.indexOf('.weather-btn .wx-sub:not'));
  // muted, but lifted a step so it still reads over a photograph
  assert.match(desc, /color:\s*#a9bad0/i, 'the description is muted but legible over the picture');
  assert.match(desc, /text-shadow:/i, 'and carries a shadow for contrast');
});

test('v146: the row reflows on a phone instead of leaving one card stranded', () => {
  const block = CSS.slice(CSS.indexOf('.weather-row {'), CSS.indexOf('/* Car Cards */'));
  assert.ok(/@media \(max-width: 900px\)[\s\S]*?\.weather-row\s*\{\s*grid-template-columns:\s*repeat\(2/.test(block),
    'two even columns from tablet down (never three and a stray)');
  assert.ok(/@media \(max-width: 420px\)[\s\S]*?\.weather-row\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(block),
    'one column on a narrow phone');
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(block), 'motion can be turned off');
});

test('v146: the icon tile sets the icon size, not the other way round', () => {
  const block = CSS.slice(CSS.indexOf('.weather-row {'), CSS.indexOf('/* Car Cards */'));
  assert.match(block, /\.weather-btn \.wx-ico \{[^}]*font-size:\s*17px/, 'the tile sizes the icon');
  assert.match(block, /\.weather-ico \{ color: var\(--wx, var\(--cyber-cyan\)\); \}/, 'the icon takes the accent');
  // the HUD chip keeps its own icon colour: --wx is only defined on the cards
  assert.match(CSS, /\.weather-ico \{ color: var\(--wx, var\(--cyber-cyan\)\); \}/, 'chip falls back to cyan');
  assert.ok(/\.weather-chip \.ico \{ font-size: 1\.15em/.test(CSS), 'the chip rule is untouched');
});

// ---------------------------------------------------------------------------
// label splitting
// ---------------------------------------------------------------------------

function loadDecorator() {
  const at = GAME.indexOf('function decorateWeatherCards()');
  assert.ok(at > 0, 'decorateWeatherCards is in game.js');
  let depth = 0, end = at;
  for (let j = GAME.indexOf('{', at); j < GAME.length; j++) {
    if (GAME[j] === '{') depth++;
    else if (GAME[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  const src = GAME.slice(at, end);

  const mkEl = (tag) => ({
    tagName: tag, className: '', _text: '', children: [], classList: {
      _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }
    },
    // a real element's textContent is the concatenation of its children's, which is
    // exactly why the decorator has to recognise its own output on a second pass
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
    },
    set textContent(v) { this._text = String(v); if (this.children !== undefined) this.children.length = 0; },
    appendChild(c) { this.children.push(c); return c; }
  });

  const sandbox = {
    console,
    document: {
      createElement: mkEl,
      querySelectorAll: () => sandbox.__subs
    },
    __subs: []
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__go = decorateWeatherCards;', sandbox);

  // a stand-in for the real <span class="wx-sub" data-i18n="wDrySub">
  const sub = (text) => { const el = mkEl('span'); el.className = 'wx-sub'; el.textContent = text; el.children = []; return el; };

  return { run: () => sandbox.__go(), setSubs: (s) => { sandbox.__subs = s; }, sub, mkEl };
}

test('v146: the grip figure is split out of the label into its own chip', () => {
  const d = loadDecorator();
  const el = d.sub('1.00x Grip · Optimal Track Pace');
  d.setSubs([el]);
  d.run();
  assert.strictEqual(el.children.length, 2, 'chip + description');
  assert.strictEqual(el.children[0].className, 'wx-grip');
  assert.strictEqual(el.children[0].textContent, '1.00x Grip');
  assert.strictEqual(el.children[1].className, 'wx-desc');
  assert.strictEqual(el.children[1].textContent, 'Optimal Track Pace');
  assert.ok(el.classList.contains('wx-split'), 'the row is marked as split');
});

test('v146: every language splits on its own separator, in its own order', () => {
  const d = loadDecorator();
  const cases = [
    ['1.00x Grip · Optimal Track Pace', '1.00x Grip', 'Optimal Track Pace'],   // en
    ['0.92x గ్రిప్ · నీటి తుంపర్లు', '0.92x గ్రిప్', 'నీటి తుంపర్లు'],               // te
    ['1.00x Agarre · Ritmo Óptimo', '1.00x Agarre', 'Ritmo Óptimo'],          // es
  ];
  cases.forEach(([label, grip, desc]) => {
    const el = d.sub(label);
    d.setSubs([el]);
    d.run();
    assert.strictEqual(el.children[0].textContent, grip, 'grip extracted from ' + label);
    assert.strictEqual(el.children[1].textContent, desc, 'description extracted from ' + label);
  });
});

test('v146: a label with no separator is left exactly as it is', () => {
  const d = loadDecorator();
  const el = d.sub('Glowing Cyber Luminescence');
  d.setSubs([el]);
  d.run();
  assert.strictEqual(el.children.length, 0, 'nothing was invented');
  assert.strictEqual(el.textContent, 'Glowing Cyber Luminescence', 'text untouched');
  assert.ok(!el.classList.contains('wx-split'), 'not marked as split');
});

test('v146: splitting is idempotent, and undoes itself if the language changes', () => {
  const d = loadDecorator();
  const el = d.sub('1.00x Grip · Optimal Track Pace');
  d.setSubs([el]);
  d.run();
  const first = el.children.slice();
  d.run();                                     // a second applyI18n pass (e.g. another repaint)
  assert.strictEqual(el.children.length, 2, 'still two parts');
  assert.strictEqual(el.children[0], first[0], 'the same nodes, not rebuilt on every repaint');
  assert.strictEqual(el.children[0].textContent, '1.00x Grip', 'and the text is unchanged');

  // a language whose label has no separator must not leave a stale chip behind
  el.textContent = 'Opas Trasa';               // what applyI18n would write
  el.children = [];
  d.run();
  assert.strictEqual(el.children.length, 0, 'the chip is gone');
  assert.strictEqual(el.textContent, 'Opas Trasa', 'the plain label is shown instead');
});

test('v146: the split is driven by the translated text, never a hardcoded table', () => {
  // if the grip values were hardcoded, a new language or a tweaked balance number
  // would silently disagree with the label the player reads
  const at = GAME.indexOf('function decorateWeatherCards()');
  const body = GAME.slice(at, GAME.indexOf('\n}', at));
  // the comment above it quotes an example label, so compare against the CODE only
  const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/0\.9\dx|1\.00x|0\.88x/.test(code), 'the decorator holds no grip values of its own');
  assert.ok(/indexOf\('·'\)/.test(code), 'the separator is looked up in the label it was given');
  // the multipliers themselves live in the physics core, where they belong
  const core = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game-core.js'), 'utf8');
  assert.ok(/gripMul/.test(core), 'the real grip figures come from the core');
});

test('v146: the split runs both from the i18n pass and at boot', () => {
  const applyAt = GAME.indexOf('function applyI18n()');
  const applyBody = GAME.slice(applyAt, GAME.indexOf('function computeStreak'));
  assert.ok(/decorateWeatherCards\(\)/.test(applyBody), 'applyI18n decorates the cards');
  // and once more from the boot IIFE, because applyI18n returns early without SRI18N
  const bootAt = GAME.indexOf('// v44 wiring: language cycler + cup share');
  const boot = GAME.slice(bootAt, bootAt + 1200);
  assert.ok(/decorateWeatherCards\(\)/.test(boot), 'the boot path decorates them too');
  assert.ok(/if \(!window\.SRI18N\) return;/.test(GAME), 'applyI18n still bails out without the bundle');
});
