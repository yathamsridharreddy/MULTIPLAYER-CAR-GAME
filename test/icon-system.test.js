'use strict';
/* ============================================================================
   v149 — the icon system, finished.

   v142 replaced the emoji in a handful of HUD elements. The rest of the chrome
   was still emoji: 149 glyphs in index.html, 55 distinct, drawn by whatever emoji
   font the visitor's device happens to ship (Apple vs Segoe vs Noto) and shown as
   a tofu box where the font lacks the codepoint. The kit had 28 icon pairs and
   only 10 were actually placed.

   What this file enforces:
     1. no emoji anywhere in the chrome, on any of the four pages
     2. every icon the pages reference exists in BOTH families and has a mask rule
     3. the Lucide half is on the same 128 grid and is tintable like the rest
     4. the app icon is a real mark, not a font glyph, and the manifest declares a
        genuinely padded maskable icon
     5. the regression that keeps coming back: no stylesheet rule may pick an
        element's part by POSITION (`span:first-child`), because that is how the
        weather row and the mode buttons broke
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const PAGES = ['public/index.html', 'public/controller.html', 'public/auth.html', 'public/replay.html'];
const PAGES_SRC = PAGES.map((p) => ({ p, s: read(p) }));
const CSS = read('public/css/style.css');
const I18N = read('public/js/i18n.js');
const SW = read('public/sw.js');
const MANIFEST = JSON.parse(read('public/manifest.webmanifest'));

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2705}\u{274C}\u{26A0}]/u;

// Emoji that were deliberately KEPT, with the reason. Anything not on this list
// fails the test - that is the point.
const KEPT = {
  'public/index.html': ['🐢', '🐇'],          // the steering-sensitivity ends: a slow
                                              // tortoise and a quick hare read better
                                              // as metaphor than as any icon
  'public/controller.html': [],               // the iPhone tip is chrome too - it is wired now
  'public/auth.html': [],
  'public/replay.html': []
};

// ---------------------------------------------------------------------------
// 1. chrome is emoji-free
// ---------------------------------------------------------------------------

test('v149: no page renders an emoji in its chrome', () => {
  for (const { p, s } of PAGES_SRC) {
    const found = [...new Set((s.match(new RegExp(EMOJI.source, 'gu')) || []))];
    const allowed = KEPT[p] || [];
    const leftover = found.filter((e) => !allowed.includes(e));
    assert.deepStrictEqual(leftover, [],
      `${p} still carries emoji: ${leftover.join(' ')}`);
  }
});

test('v149: every kept emoji is one we decided to keep', () => {
  // guard against someone adding a new emoji and quietly allowlisting it here
  const allow = Object.values(KEPT).flat();
  assert.deepStrictEqual(allow.sort(), ['🐇', '🐢'], 'the keep-list is exactly the two');
});

test('v149: the replaced chrome carries a real icon instead', () => {
  const { s } = PAGES_SRC.find((x) => x.p === 'public/index.html');
  // Spot-check the controls that were showing emoji, keyed by the i18n label -
  // those are the strings the user actually read on screen. The icon is a SIBLING
  // span immediately before the translated one.
  for (const [key, icon] of [['clubs', 'race-flag'], ['badges', 'medal'], ['bounties', 'trophy'],
    ['tabSett', 'gear'], ['tabRank', 'trophy'], ['camBtn', 'camera'],
    ['restart', 'refresh'], ['start', 'race-flag']]) {
    const re = new RegExp(`data-i="${icon}"[^>]*></span><span[^>]*data-i18n="${key}"`);
    assert.match(s, re, `${key} should carry the ${icon} icon`);
  }
  const iconCount = (s.match(/class="ico[^"]*" data-i="/g) || []).length;
  assert.ok(iconCount >= 100, `the chrome should be wired with icons, found ${iconCount}`);
});

test('v149: an icon never sits inside a data-i18n element', () => {
  // applyI18n() writes textContent, which deletes child elements - the icon has to
  // be a sibling of the translated span, never inside it
  for (const { p, s } of PAGES_SRC) {
    const leaves = s.match(/<([a-z0-9]+)((?:"[^"]*"|[^>"])*)>([^<]*)<\/\1>/gi) || [];
    for (const leaf of leaves) {
      if (!/data-i18n/.test(leaf)) continue;
      assert.ok(!/class="ico/.test(leaf), `${p}: an icon is inside a data-i18n element: ${leaf.slice(0, 110)}`);
    }
  }
});

test('v149: i18n labels no longer carry emoji either', () => {
  // the dictionary is written four times over; an emoji left there would reappear
  // the moment the page is translated
  const keys = new Set();
  for (const { s } of PAGES_SRC) {
    for (const m of s.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) keys.add(m[1]);
  }
  const offenders = [];
  for (const key of keys) {
    for (const m of I18N.matchAll(new RegExp(`\\b${key}: '([^']*)'`, 'g'))) {
      if (EMOJI.test(m[1])) offenders.push(`${key} = ${m[1]}`);
    }
  }
  assert.deepStrictEqual(offenders, [], 'i18n labels still carry emoji:\n  ' + offenders.join('\n  '));
});

// ---------------------------------------------------------------------------
// 2. every referenced icon exists and is styled
// ---------------------------------------------------------------------------

test('v149: every icon the pages reference ships in both families with a mask rule', () => {
  const names = new Set();
  for (const { s } of PAGES_SRC) {
    for (const m of s.matchAll(/data-i="([a-z0-9-]+)"/g)) names.add(m[1]);
  }
  assert.ok(names.size >= 40, `the chrome uses a real set, found ${names.size}`);
  for (const n of names) {
    assert.ok(exists(`public/img/ico/${n}.svg`), `colour icon missing: ${n}`);
    assert.ok(exists(`public/img/ico-mono/${n}.svg`), `mono icon missing: ${n}`);
    assert.match(CSS, new RegExp(`\\.ico\\[data-i="${n}"\\]`), `no mask rule for ${n}`);
  }
});

test('v149: the mask rules and the icon files agree in both directions', () => {
  const ruled = new Set([...CSS.matchAll(/\.ico\[data-i="([a-z0-9-]+)"\]/g)].map((m) => m[1]));
  const mono = fs.readdirSync(path.join(ROOT, 'public/img/ico-mono'))
    .filter((f) => f.endsWith('.svg')).map((f) => f.replace('.svg', ''));
  for (const r of ruled) assert.ok(mono.includes(r), `CSS masks a missing icon: ${r}`);
  assert.ok(ruled.size === mono.length,
    `every mono icon should be reachable: ${ruled.size} rules vs ${mono.length} files`);
});

test('v149: the Lucide half is on the house grid and tintable', () => {
  const lucide = fs.readFileSync(path.join(ROOT, 'tools/icon-forge/lucide_icons.py'), 'utf8');
  const names = [...lucide.matchAll(/^\s*'([a-z0-9-]+)': \('/gm)].map((m) => m[1]);
  assert.ok(names.length >= 40, `the bridge should define the generic set, found ${names.length}`);
  for (const n of names) {
    const mono = read(`public/img/ico-mono/${n}.svg`);
    assert.match(mono, /viewBox="0 0 128 128"/, `${n}: must land on the same 128 grid as the house icons`);
    assert.match(mono, /stroke="currentColor"/, `${n}: a mask must take currentColor`);
    assert.ok(!/stroke="#[0-9a-f]{3}/i.test(mono), `${n}: must not hardcode a paint colour`);
    assert.match(mono, /lucide_icons\.py/, `${n}: must carry its ISC provenance header`);
  }
});

test('v149: the identity icons stay hand-drawn', () => {
  // these are the site's own language and must not be swapped for a generic glyph
  const forge = read('tools/icon-forge/make_icons.py');
  for (const n of ['racing-car', 'race-flag', 'helmet', 'nitro', 'speedometer',
    'steering-wheel', 'trophy', 'crown', 'swords', 'ghost', 'target', 'stopwatch']) {
    assert.match(forge, new RegExp(`@icon\\('${n}'\\)`), `${n} must stay hand-drawn in make_icons.py`);
  }
});

// ---------------------------------------------------------------------------
// 3. the app icon defects
// ---------------------------------------------------------------------------

test('v149: the app mark is real geometry, not a font glyph', () => {
  const svg = read('public/icon.svg');
  assert.ok(!/<text/i.test(svg),
    'icon.svg must not draw a font glyph - it is the manifest icon, and a device without ' +
    'that emoji renders a tofu box');
  assert.ok(!EMOJI.test(svg), 'icon.svg still contains an emoji character');
  assert.match(svg, /<path[^>]*d="M/, 'it should be drawn from path geometry');
  assert.match(svg, /viewBox="0 0 128 128"/, 'and scale cleanly (no raster inside)');
  assert.ok(!/data:image\/(png|jpe?g)/.test(svg), 'no raster embedded in the master');
});

test('v149: the manifest ships a genuinely padded maskable icon', () => {
  const icons = MANIFEST.icons;
  const any = icons.filter((i) => (i.purpose || 'any') === 'any');
  const maskable = icons.filter((i) => (i.purpose || '').includes('maskable'));
  assert.ok(any.length >= 2, 'there should be more than one "any" icon (192 and 512)');
  assert.ok(maskable.length >= 1, 'a maskable icon is required for Android');
  // Android crops a maskable icon to a circle: pointing at the same file as `any`
  // means the artwork gets its edges cut off
  for (const m of maskable) {
    for (const a of any) {
      assert.notStrictEqual(m.src, a.src,
        'a maskable icon must not reuse the "any" file - it needs its own safe-zone padding');
    }
    assert.ok(exists('public' + m.src), `manifest points at a missing icon: ${m.src}`);
  }
});

test('v149: every page declares an icon and an apple-touch icon', () => {
  for (const { p, s } of PAGES_SRC) {
    assert.match(s, /<link rel="icon"/, `${p} has no favicon`);
    assert.ok(!/data:image\/svg\+xml,<svg[^>]*><text/.test(s),
      `${p} still uses an emoji data-URI as its favicon`);
    assert.match(s, /<link rel="apple-touch-icon" href="img\/apple-touch-icon\.png"/,
      `${p} should declare the apple-touch icon (iOS ignores everything else)`);
  }
  assert.ok(exists('public/img/apple-touch-icon.png'), 'and the file must exist');
  assert.ok(exists('public/img/icon-512-maskable.png'), 'and the maskable file too');
});

test('v149: the app icons are precached, and the controller css URL matches the worker', () => {
  for (const f of ['/img/icon-512-maskable.png', '/img/apple-touch-icon.png']) {
    assert.ok(SW.includes(f), `${f} should be precached`);
  }
  // the worker precaches a URL with a version query - the page must request the
  // SAME url, or the precache entry is dead weight and the file never cache-busts
  for (const { p, s } of PAGES_SRC) {
    for (const m of s.matchAll(/(?:href|src)="([^"]*\.(?:css|js)\?v=\d+)"/g)) {
      const url = '/' + m[1].replace(/^\.?\//, '');
      assert.ok(SW.includes(`'${url}'`) || !SW.includes(url.split('?')[0] + '?'),
        `${p} requests ${url}, which is not the URL the worker precaches`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. the recurring regression
// ---------------------------------------------------------------------------

test('v149: nothing is styled by position any more', () => {
  // `span:first-child` was written for a card whose first child is the title. The
  // weather row put the ICON first and the row rendered as unstyled grey boxes; the
  // mode buttons survived by luck until their emoji became an icon span. Ban it.
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');   // comments are not code
  const offenders = [...bare.matchAll(/^[^{]*\bspan:(?:first|last)-child[^{]*\{/gm)]
    .map((m) => m[0].trim());
  assert.deepStrictEqual(offenders, [],
    'positional selectors are a trap: give the part its own class instead\n  ' + offenders.join('\n  '));
});

test('v149: keyboard focus is visible on the controls people actually tab to', () => {
  const focus = CSS.match(/:focus-visible/g) || [];
  assert.ok(focus.length >= 10, `focus styling is still thin (${focus.length} rules)`);
  // one blanket rule covers the interactive elements that had no ring at all
  assert.match(CSS, /button:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--cyber-cyan\)/,
    'buttons should get the house focus ring');
});

// ---------------------------------------------------------------------------
// 5. the runtime half: JS must not paint emoji back into the chrome
// ---------------------------------------------------------------------------

const GAME = read('public/js/game.js');

test('v149: game.js never writes an emoji into a chrome element', () => {
  // The markup was clean while the UI still looked emoji-driven, because Chrome
  // labels are re-rendered at runtime: `chip.textContent = '👤 ' + name` both put
  // the emoji back AND deleted the icon span that was sitting in the markup.
  const CHROME_IDS = ['account-chip', 'quickplay-btn', 'lobby-conn', 'lang-btn',
    'results-title', 'daily-title', 'lobby-ghost-toggle-btn', 'ready-btn',
    'ghost-gap-chip', 'streak-badge', 'lobby-season-btn', 'res-rival-tag',
    'res-revenge-tag', 'res-crew-tag', 'weekly-txt', 'ghost-toggle-btn'];
  const offenders = [];
  const lines = GAME.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!EMOJI.test(line)) continue;
    // look at this line and the one before it - assignments are often wrapped
    const window = lines.slice(Math.max(0, i - 1), i + 1).join(' ');
    if (CHROME_IDS.some((id) => window.includes(id))) offenders.push(`${i + 1}: ${line.trim().slice(0, 110)}`);
  }
  assert.deepStrictEqual(offenders, [],
    'chrome labels are rendered from data, so emoji in these assignments reappear on screen\n  '
    + offenders.join('\n  '));
});

test('v149: every icon game.js renders is a real icon', () => {
  // icoSpan('name') and setIcoIcon(el, 'name') both resolve through the stylesheet,
  // so a typo would render as an invisible empty span - no error, just a missing
  // glyph. Check every name against the files.
  const names = new Set();
  for (const m of GAME.matchAll(/icoSpan\('([a-z0-9-]+)'/g)) names.add(m[1]);
  // setIcoIcon(el, 'name') or setIcoIcon(el, cond ? 'a' : 'b') - read the argument
  // list up to the matching paren, then every string literal in it. A loose regex
  // here happily runs past the call and picks up unrelated literals.
  for (const m of GAME.matchAll(/setIcoIcon\(/g)) {
    let i = m.index + m[0].length, depth = 1;
    while (i < GAME.length && depth) {
      if (GAME[i] === '(') depth++;
      else if (GAME[i] === ')') depth--;
      i++;
    }
    for (const lit of GAME.slice(m.index, i).matchAll(/'([a-z0-9-]+)'/g)) names.add(lit[1]);
  }
  assert.ok(names.size >= 8, `game.js should render several icons, found ${names.size}`);
  assert.ok(!names.has('none'), 'the extraction itself is wrong if it reads "none"');
  for (const n of names) {
    assert.ok(exists(`public/img/ico-mono/${n}.svg`), `game.js renders "${n}" but there is no such icon`);
    assert.match(CSS, new RegExp(`\\.ico\\[data-i="${n}"\\]`), `game.js renders "${n}" with no mask rule`);
  }
});

test('v149: the labels game.js writes into have somewhere to put them', () => {
  // setIcoLabel() falls back to writing the whole element's textContent - which
  // would delete the icon - when it cannot find a label node. Any chrome element
  // the code relabels must therefore ship an .lbl or a data-i18n span.
  const relabelled = ['account-chip', 'lobby-conn', 'lang-btn', 'ghost-gap-chip',
    'lobby-ghost-toggle-btn', 'lobby-season-btn', 'results-title', 'daily-title', 'ready-btn'];
  const html = PAGES_SRC.find((x) => x.p === 'public/index.html').s;
  for (const id of relabelled) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at !== -1, `#${id} should exist in index.html`);
    const body = html.slice(at, html.indexOf('</button>', at) === -1
      ? html.indexOf('</div>', at) : Math.min(
        html.indexOf('</button>', at) + 9, html.indexOf('</div>', at) + 6));
    assert.match(body, /class="lbl"|data-i18n="/,
      `#${id} is relabelled by the code, so it needs a .lbl or data-i18n label node`);
  }
});

// ---------------------------------------------------------------------------
// 6. the data-driven chrome: mission / achievement / bounty catalogues
// ---------------------------------------------------------------------------

const PROG = read('public/js/progression.js');

test('v149: the catalogues carry icon names, not emoji', () => {
  // These are rendered from DATA, so cleaning the markup was never going to reach
  // them - the profile tiles, the mission rows and the badge cards all read their
  // glyph out of these tables. One entry (challenger) carried a lone U+FE0F, an
  // empty glyph that rendered as nothing at all.
  const offenders = [];
  for (const [file, src] of [['progression.js', PROG], ['game.js', GAME]]) {
    for (const m of src.matchAll(/icon: '([^']*)'/g)) {
      if (/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F]/u.test(m[1])) {
        offenders.push(`${file}: icon: '${m[1]}'`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], 'catalogues still carry emoji glyphs:\n  ' + offenders.join('\n  '));
});

// the text of a `const NAME = [` ... `\n];` array - slicing by indexOf alone is a
// trap: evalAchievements is defined ABOVE ACHV, so the slice came back empty and
// the test passed on nothing.
function arrayBlock(src, name) {
  const at = src.indexOf(`const ${name} = [`);
  assert.ok(at !== -1, `${name} not found`);
  const end = src.indexOf('\n];', at);
  assert.ok(end !== -1, `${name} is not terminated`);
  return src.slice(at, end);
}

test('v149: every icon a catalogue names exists', () => {
  const names = new Set();
  for (const src of [PROG, GAME]) {
    for (const m of src.matchAll(/icon: '([a-z0-9-]+)'/g)) names.add(m[1]);
  }
  for (const name of ['ACHV', 'MISSIONS', 'ACH_DEFS']) {
    for (const m of arrayBlock(GAME, name).matchAll(/'([a-z0-9-]+)',\s*'[A-Z]/g)) names.add(m[1]);
  }
  assert.ok(names.size >= 20, `the catalogues should name a real set, found ${names.size}`);
  for (const n of names) {
    assert.ok(exists(`public/img/ico-mono/${n}.svg`), `catalogue names "${n}" but there is no such icon`);
    assert.match(CSS, new RegExp(`\\.ico\\[data-i="${n}"\\]`), `"${n}" has no mask rule`);
  }
});

test('v149: the achievement tiles are all distinct', () => {
  // two of the fourteen used to be the same 🎯 ("Perfect Run" and "Mission Pro"),
  // which reads as a placeholder rather than an achievement
  const icons = [...arrayBlock(GAME, 'ACHV').matchAll(/'([a-z0-9-]+)',\s*'[A-Z]/g)].map((m) => m[1]);
  assert.ok(icons.length >= 14, `expected the 14 tiles, found ${icons.length}`);
  assert.strictEqual(new Set(icons).size, icons.length,
    `two achievements share an icon: ${icons.join(' ')}`);
});

test('v149: the club emblem still accepts what is already stored', () => {
  // New clubs store an icon name. Clubs created before the picker changed stored a
  // single emoji, and those rows are still in the database - the renderer has to
  // handle both, and the server must not truncate a name to four characters.
  assert.match(GAME, /function badgeMarkup\(badge, fallback\)/, 'the dual-mode renderer exists');
  assert.match(GAME, /BADGE_ICONS\.includes\(b\) \? icoSpan\(b\)/, 'names render as icons');
  assert.match(GAME, /badge-emoji/, 'and anything else still renders as text');
  assert.match(read('server.js'), /\/\^\[a-z0-9-\]\{1,16\}\$\//,
    'the server sanitiser must let an icon name through whole');
});

test('v151: an icon field is never written into markup as text', () => {
  // The bug the user actually saw: the account row printed the words "medal flame
  // bolt ghost globe". The catalogues had been switched to icon NAMES, but two
  // renderers still concatenated the field straight into HTML, so the name itself
  // became the visible text. An icon field may only be read through icoSpan(),
  // setIcoIcon(), setIcoLabel() or badgeMarkup() - never concatenated.
  const offenders = [];
  for (const [file, src] of [['game.js', GAME], ['progression.js', PROG]]) {
    for (const line of src.split('\n')) {
      if (!/\.icon\b/.test(line)) continue;
      if (/icoSpan\(|setIcoIcon\(|icon:\s|def\.icon\b.*icoSpan|'\s*\+\s*def\.icon/.test(line)) continue;
      if (/^\s*(\/\/|\*)/.test(line)) continue;                 // a comment is not code
      offenders.push(`${file}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'an icon field is being rendered without an icon element:\n  ' + offenders.join('\n  '));
});

test('v151: the account row shows icons, not icon names', () => {
  // the exact regression from the screenshot
  const block = GAME.slice(GAME.indexOf("const row = $('ach-row')"), GAME.indexOf("const row = $('ach-row')") + 320);
  assert.match(block, /icoSpan\(a\.icon\)/, 'the achievement strip must build an icon element');
  assert.ok(!/'\s*\+\s*a\.icon\s*\+/.test(block), 'and must not concatenate the name');
});

test('v151: the chrome states an icon size, so glyphs are not 1em of 11px', () => {
  // 1em of a small button label was an 11px icon - smaller than the text beside it
  for (const sel of ['.ghost.sm .ico', '.ltab .ico', '.lsec-title .ico', '.mode3-btn .ico']) {
    assert.ok(CSS.includes(sel), `no icon size declared for ${sel}`);
  }
  const sizes = [...CSS.matchAll(/\.(?:ghost|ltab|btab|lsec-title|mode3-btn)[^{]*\.ico[^{]*\{[^}]*font-size:\s*([\d.]+)px/g)]
    .map((m) => parseFloat(m[1]));
  assert.ok(sizes.length >= 4, `expected several declared sizes, found ${sizes.length}`);
  assert.ok(Math.min(...sizes) >= 13, `the smallest chrome icon is ${Math.min(...sizes)}px - too small to read`);
});
