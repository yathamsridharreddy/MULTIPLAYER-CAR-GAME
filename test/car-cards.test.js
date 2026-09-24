'use strict';
/* ============================================================================
   v141 — "cars pictures not visible": the car-select cards rendered EMPTY.

   The card falls back to a colour swatch whenever a 3D thumbnail is unavailable
   (LOW quality skips the second WebGL context on purpose). That swatch was built
   with `background:${hex}` where hex is a NUMBER, so the template literal emitted
   the decimal string "14747136" - not a CSS <color>. The browser dropped the
   declaration and the card was a transparent box: eight empty cards with nothing
   but the colour dot and the name.

   These tests build the REAL cards in a DOM and check every branch is visible.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'game.js'), 'utf8');

// pull the three functions out of game.js and run them with a tiny fake DOM, so the
// test exercises the shipping code rather than a copy of it
function loadCardBuilder(opts) {
  opts = opts || {};
  const start = SRC.indexOf('// ---- live 3D car thumbnails for the car-select cards ----');
  const end = SRC.indexOf('// ---------------------------------------------------------------------------', SRC.indexOf('function buildCarCards()'));
  assert.ok(start > 0 && end > start, 'card builder block found');
  const block = SRC.slice(start, end);

  const made = [];
  const mkEl = (tag) => {
    const el = {
      tagName: tag, className: '', dataset: {}, innerHTML: '', style: {}, children: [],
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      querySelectorAll: () => [],
      appendChild(c) { this.children.push(c); return c; },
      addEventListener() {}
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
    THREE: {
      WebGLRenderer: opts.noGL
        ? function () { throw new Error('no second context in this test'); }
        : function () {
            this.domElement = { toDataURL: () => 'data:image/png;base64,' + 'A'.repeat(300) };
            this.setSize = () => {}; this.setPixelRatio = () => {};
            this.render = () => {}; this.dispose = () => {}; this.forceContextLoss = () => {};
          },
      Scene: function () { this.add = () => {}; this.remove = () => {}; },
      HemisphereLight: function () {}, DirectionalLight: function () { this.position = { set() {} }; },
      PerspectiveCamera: function () { this.position = { set() {} }; this.lookAt = () => {}; }
    },
    localStorage: { getItem: () => opts.prefs || null },
    prefs: opts.prefs === '{"quality":"low"}' ? { quality: 'low', color: 0xe10600 } : { quality: 'high', color: 0x0a84ff },
    // stubs the module reaches for
    scene: { add() {}, remove() {} },
    disposeCarVisual: () => {},
    createCar: () => ({ group: { x: 1 }, paint: { color: { setHex() {} } } }),
    shellForHex: () => 'ghost',
    savePrefs() {}, applyMyColor() {}, sendMeta() {}, $: (id) => (id === 'car-cards' ? wrap : null)
  };
  sandbox.CAR_COLORS = [0xe10600, 0x0a84ff, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7, 0xffffff, 0x111111];
  sandbox.CAR_NAMES = [
    { e: '🔴', n: 'FURY' }, { e: '🔵', n: 'STORM' }, { e: '🟡', n: 'VOLT' }, { e: '🟢', n: 'VIPER' },
    { e: '🟠', n: 'BLAZE' }, { e: '🟣', n: 'PHANTOM' }, { e: '⚪', n: 'GHOST' }, { e: '⚫', n: 'REAPER' }
  ];
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(block +
    '\n;globalThis.__build = buildCarCards;' +
    '\nglobalThis.__peek = () => ({ prev: _prev, cacheSize: _prevCache.size, failed: _prevFailed });',
    sandbox, { filename: 'cards.js' });
  return { build: sandbox.__build, peek: sandbox.__peek, wrap, made, sandbox };
}

test('v141: every car card carries a VISIBLE picture (never an empty box)', () => {
  const { build, wrap } = loadCardBuilder();
  build();
  assert.strictEqual(wrap.children.length, 8, 'eight cards');
  for (const card of wrap.children) {
    const html = card.innerHTML;
    assert.ok(html.length > 0, 'card has content');
    const hasImg = /<img[^>]+src="[^"]+"/.test(html);
    const hasSwatch = /class="car-swatch"/.test(html);
    assert.ok(hasImg || hasSwatch, 'card must render either a thumbnail or a silhouette: ' + html.slice(0, 90));
  }
});

test('v141: the fallback swatch paints a VALID css colour (the reported bug)', () => {
  // LOW quality is the path that produced the empty cards
  const { build, wrap } = loadCardBuilder({ prefs: '{"quality":"low"}', noGL: true });
  build();
  assert.strictEqual(wrap.children.length, 8, 'eight cards in the fallback path');
  wrap.children.forEach((card, i) => {
    const html = card.innerHTML;
    assert.ok(/class="car-swatch"/.test(html), 'card ' + i + ' uses the silhouette fallback');
    // a bare decimal number (the old bug) or 0x notation must never appear as a colour
    assert.ok(!/(fill|stroke|background|color)\s*[:=]\s*"?0x/i.test(html), 'no 0x-prefixed colour: ' + html.slice(0, 80));
    // the paint colour is applied as a #rrggbb value
    const fills = html.match(/fill="(#[0-9a-f]{6})"/gi) || [];
    assert.ok(fills.length >= 1, 'card ' + i + ' paints the car with a #rrggbb colour');
  });
  // and specifically: the decimal-string bug
  const allHtml = wrap.children.map((c) => c.innerHTML).join(' ');
  assert.ok(!/background:\d/.test(allHtml), 'a raw decimal must never be used as a CSS colour');
  assert.ok(!/background:0x/.test(allHtml), 'nor 0x notation');
});

test('v141: each fallback swatch uses ITS OWN car colour', () => {
  const { build, wrap } = loadCardBuilder({ prefs: '{"quality":"low"}', noGL: true });
  build();
  const expected = [0xe10600, 0x0a84ff, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7, 0xffffff, 0x111111]
    .map((h) => '#' + h.toString(16).padStart(6, '0'));
  wrap.children.forEach((card, i) => {
    assert.ok(card.innerHTML.includes(expected[i]), 'card ' + i + ' paints ' + expected[i]);
    assert.strictEqual(card.dataset.color, expected[i],
      'card ' + i + ' exposes its paint as a CSS colour');
  });
});

test('v141: the swatch is a car silhouette, not a plain colour block', () => {
  const { build, wrap } = loadCardBuilder({ prefs: '{"quality":"low"}', noGL: true });
  build();
  const html = wrap.children[0].innerHTML;
  assert.ok(/<svg/.test(html), 'vector car');
  assert.ok(/viewBox="0 0 120 64"/.test(html), 'stable viewBox');
  const wheels = html.match(/<circle[^>]*r="8\.8"/g) || [];
  assert.strictEqual(wheels.length, 2, 'two wheels');
  const hubs = html.match(/<circle[^>]*r="3\.2"/g) || [];
  assert.strictEqual(hubs.length, 2, 'two hubs');
  assert.ok(/<path[^>]*fill="#e10600"/.test(html), 'body painted in the car colour');
});

test('v141: hexCss converts a paint number to a usable CSS colour', () => {
  const { sandbox } = loadCardBuilder();
  const f = sandbox.hexCss;
  assert.strictEqual(f(0xe10600), '#e10600');
  assert.strictEqual(f(0x0a84ff), '#0a84ff');
  assert.strictEqual(f(0xffffff), '#ffffff');
  assert.strictEqual(f(0x000000), '#000000');
  assert.strictEqual(f(0x00a651), '#00a651');
  // defensive: junk must not produce "NaN"-style colours
  assert.strictEqual(f(null), '#ffffff');
  assert.strictEqual(f(undefined), '#ffffff');
  assert.strictEqual(f(NaN), '#ffffff');
});

test('v141: the card picture area is styled so both branches share one box', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  assert.ok(/\.car-thumb,\s*\.car-swatch\s*\{/.test(css), 'both branches styled together');
  assert.ok(/aspect-ratio:\s*120\s*\/\s*64/.test(css), 'fixed aspect ratio (no layout shift)');
  assert.ok(/\.car-swatch[\s\S]{0,400}height:\s*84px/.test(css), 'fallback height for browsers without aspect-ratio');
});

test('v141: leaving LOW quality brings the real 3D thumbnails back', () => {
  const src = SRC;
  // the old guard read window._prev, which is never set (a top-level `let` is not a
  // window property), so the preview context was never released and never restored
  assert.ok(!/if\(window\._prev\)/.test(src), 'the broken window._prev guard is gone');
  assert.ok(/function disposeCarPreview\(/.test(src), 'preview dispose helper exists');
  // LOW no longer refuses the thumbnail: it renders it once and releases the context
  const low = src.slice(src.indexOf("if (q === 'low')"), src.indexOf("} else if (q === 'med')"));
  assert.ok(!/_prevFailed = true/.test(low), 'LOW must not disable thumbnails any more');
  assert.ok(/disposeCarPreview\(true\)/.test(low), 'LOW hands the GPU back after the thumbnails are cached');
  const med = src.slice(src.indexOf("} else if (q === 'med')"), src.indexOf('function fxActive'));
  assert.ok((med.match(/_prevFailed = false/g) || []).length >= 2, 'HIGH and MED re-allow thumbnails');
  // and the cache must be cleared whenever the context is dropped
  assert.ok(/disposeCarPreview\(\)[\s\S]{0,80}_prevFailed = false/.test(src), 'context restore rebuilds the preview');
});

test('v141: thumbnails are cached (no re-render per panel open)', () => {
  assert.ok(/_prevCache/.test(SRC), 'preview cache present');
  assert.ok(/const hit = _prevCache\.get\(cacheKey\)/.test(SRC), 'cache is read before rendering');
  assert.ok(/if \(url && url\.length > 64\) \{ _prevCache\.set\(cacheKey, url\)/.test(SRC), 'a blank data URL is never cached');
});


test('v141: LOW quality still shows REAL car pictures, then releases the GL context', () => {
  const { build, wrap, peek } = loadCardBuilder({ prefs: '{"quality":"low"}' });
  build();
  // every card got a rendered thumbnail, not the fallback silhouette
  for (const card of wrap.children) {
    assert.ok(/<img class="car-thumb" src="data:image\/png/.test(card.innerHTML), 'card shows a rendered picture');
    assert.ok(!/car-swatch/.test(card.innerHTML), 'and not the silhouette');
  }
  // and the one-shot context was handed back (no standing GPU cost on a low-end device)
  const after = peek();
  assert.strictEqual(after.prev, null, 'preview context released after the one-shot render');
  assert.ok(after.cacheSize >= 8, 'the pictures are cached for later openings: ' + after.cacheSize);
});

test('v141: without a usable GPU the cards fall back to a drawn car, never an empty box', () => {
  const { build, wrap } = loadCardBuilder({ prefs: '{"quality":"high"}', noGL: true });
  build();
  assert.strictEqual(wrap.children.length, 8);
  for (const card of wrap.children) {
    assert.ok(/<svg class="car-swatch"/.test(card.innerHTML), 'silhouette shown');
    assert.ok(/viewBox="0 0 120 64"/.test(card.innerHTML), 'with a real drawing');
  }
});


test('v141: every glass shape stays INSIDE the body outline (no panes poking out of the roof)', () => {
  const src = SRC;
  const svgFn = src.slice(src.indexOf('function hexCss(hex) {'), src.indexOf('function disposeCarPreview'));
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
