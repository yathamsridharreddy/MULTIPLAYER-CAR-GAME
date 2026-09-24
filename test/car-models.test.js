'use strict';
/* ============================================================================
   v117 real-car model pipeline: registry, licensing and fallback contract.

   The pipeline is visual-only: physics, networking and collision never see a
   GLB. These tests pin the parts that must never regress:

   1. every shipped model has its asset files AND its license documentation
      on disk (an undocumented asset must never enter the build);
   2. the 8 selectable car ids map from the existing paint hexes, so the wire
      protocol stays model-agnostic (only the hex travels);
   3. loader scripts load before game.js;
   4. acquire() NEVER rejects - a missing/broken GLB resolves null and the
      procedural shell stays (the race must not depend on a download);
   5. the service worker does not precache multi-megabyte models.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HEX_IDS = {
  0xe10600: 'fury', 0x0a84ff: 'storm', 0xffd400: 'volt', 0x00a651: 'viper',
  0xff6a00: 'blaze', 0x7b2ff7: 'phantom', 0xffffff: 'ghost', 0x111111: 'reaper'
};

function loadCarModels() {
  const sandbox = { window: {}, console: { warn() {}, log() {}, error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/car-models.js'), sandbox, { filename: 'car-models.js' });
  return sandbox.window.CarModels;
}

test('car-models registry maps all 8 existing paint hexes to car ids', () => {
  const CM = loadCarModels();
  for (const [hex, id] of Object.entries(HEX_IDS)) {
    assert.strictEqual(CM.idForHex(Number(hex)), id, 'hex ' + hex);
  }
  assert.strictEqual(CM.idForHex(0x123456), null, 'unknown hex maps to nothing');
  assert.strictEqual(CM.idForHex(null), null);
});

test('every registered model ships its files on disk', () => {
  const CM = loadCarModels();
  const ids = Object.keys(CM.SOURCES);
  assert.ok(ids.length >= 1, 'at least one licensed model registered');
  for (const id of ids) {
    const url = CM.SOURCES[id].url;
    const gltfPath = path.join(ROOT, 'public', url);
    assert.ok(fs.existsSync(gltfPath), url + ' missing');
    const j = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
    // every buffer + image referenced by the glTF must exist beside it
    const dir = path.dirname(gltfPath);
    for (const b of j.buffers || []) {
      if (b.uri && !b.uri.startsWith('data:')) assert.ok(fs.existsSync(path.join(dir, b.uri)), b.uri);
    }
    const imgs = (j.images || []).map((i) => i.uri).filter((u) => u && !u.startsWith('data:'));
    for (const u of imgs) assert.ok(fs.existsSync(path.join(dir, u)), u);
    assert.ok(fs.statSync(gltfPath).size > 10000, 'suspiciously small gltf');
  }
});

test('every registered model ships license documentation (CC-BY/CC0 only)', () => {
  const CM = loadCarModels();
  for (const id of Object.keys(CM.SOURCES)) {
    const lic = CM.SOURCES[id].license || '';
    assert.ok(/^CC-(BY|0)/.test(lic), id + ' license must be CC-BY or CC0, got ' + lic);
    assert.ok(typeof CM.SOURCES[id].credit === 'string' && CM.SOURCES[id].credit.length > 20, id + ' credit');
    const f = path.join(ROOT, 'public/assets/cars', id, 'LICENSE.txt');
    assert.ok(fs.existsSync(f), 'missing ' + f);
    const txt = fs.readFileSync(f, 'utf8');
    assert.ok(/CC-BY|CC0/.test(txt), id + ' LICENSE.txt must state the license');
  }
  const credits = read('ASSETS-CREDITS.md');
  for (const id of Object.keys(CM.SOURCES)) assert.ok(credits.includes(id), 'ASSETS-CREDITS.md must list ' + id);
});

test('loader scripts load before game.js in index.html', () => {
  const html = read('public/index.html');
  const iThree = html.indexOf('js/vendor/three.min.js');
  const iLoader = html.indexOf('js/vendor/GLTFLoader.js');
  const iModels = html.indexOf('js/car-models.js');
  const iGame = html.indexOf('js/game.js');
  assert.ok(iThree < iLoader && iLoader < iModels && iModels < iGame, 'script order');
});

test('acquire() never rejects: missing loader or unknown id resolves null', async () => {
  const CM = loadCarModels();
  assert.strictEqual(await CM.acquire('fury', 0xe10600, 0), null, 'unregistered id -> null (procedural shell)');
  // registered id but THREE/GLTFLoader absent in this sandbox -> null, not throw
  assert.strictEqual(await CM.acquire('ghost', 0xffffff, 0), null, 'load failure must resolve null');
  CM.prefetch('ghost');   // must not throw
  CM.prefetch('fury');
});

test('game.js wires the swap without touching physics or the protocol', () => {
  const g = read('public/js/game.js');
  assert.ok(g.includes("CarModels.idForHex(cs.col)) || shellForHex(cs.col);"), 'placeCar hook');
  assert.ok(g.includes('function ensureCarShell('), 'id-keyed shell rebuild exists');
  assert.ok(g.includes('if (!old.isGlb && old.shellId === id) return;'), 'shell swap is id-keyed');
  assert.ok(g.includes('w.spin.rotation.x = v.spinAngle;'), 'v140: one forward spin sign for both rigs');
  assert.ok(g.includes('w.pivot.rotation.z = -cs.st * 0.42;'), 'glb steering axis');
  assert.ok(g.includes('function upgradeCarVisual('), 'upgrade helper');
  assert.ok(g.includes('function disposeCarVisual('), 'dispose helper');
  assert.ok(/const BUILD = 'v140';/.test(g), 'build marker');
  // physics core untouched by the pipeline
  const core = read('shared/game-core.js');
  assert.ok(!core.includes('CarModels') && !core.includes('GLTF'), 'game-core stays model-agnostic');
  const srv = read('server.js');
  assert.ok(!srv.includes('CarModels') && !srv.includes('.glb'), 'server stays model-agnostic');
});

test('v118: eight distinct silhouettes, one per selectable car id', () => {
  const g = read('public/js/game.js');
  const ids = ['fury', 'storm', 'volt', 'viper', 'blaze', 'phantom', 'ghost', 'reaper'];
  const start = g.indexOf('const SHELL_PROFILES = {');
  const end = g.indexOf('const meta = buildShellCar(', start);
  assert.ok(start > 0 && end > start, 'profile table present');
  const block = g.slice(start, end);
  const profiles = {};
  for (const id of ids) {
    const m = block.match(new RegExp('\\n    ' + id + ': \\{ pts: (\\[\\[[^\\]]*(?:\\][^\\]]*)*\\]\\])'));
    assert.ok(m, id + ' profile missing');
    profiles[id] = m[1].replace(/\s+/g, '');
  }
  const seen = new Set();
  for (const id of ids) {
    assert.ok(!seen.has(profiles[id]), id + ' silhouette must be unique');
    seen.add(profiles[id]);
  }
  // v136: procedural fallback all ghost to avoid damaged distinct shapes when GLB fails — all 8 share ghost shape, colours differ
  const HEXLIT = { fury: '0xe10600', storm: '0x0a84ff', volt: '0xffd400', viper: '0x00a651', blaze: '0xff6a00', phantom: '0x7b2ff7', ghost: '0xffffff', reaper: '0x111111' };
  for (const [id, lit] of Object.entries(HEXLIT)) {
    assert.ok(g.includes(lit + ": 'ghost'"), 'SHELL_BY_HEX ' + id + ' should be ghost (v136)');
  }
  // lobby thumbnails render per car id, not per class
  assert.ok(g.includes('url = renderCarPreview(hex, shellForHex(hex));'), 'card thumbs per id');
});

test('service worker does not precache car models (runtime cache only)', () => {
  const sw = read('public/sw.js');
  assert.ok(sw.includes("sridhar-rush-v140"), 'cache name bumped');
  const precache = sw.slice(0, sw.indexOf('self.addEventListener'));
  assert.ok(!precache.includes('assets/cars'), 'models must not be in the precache list');
});

/* ---------------------------------------------------------------------------
   v140 regression: "yellow car body is damaged".

   Root cause: two "yellow card" heuristics hid EVERY mesh whose material colour
   matched r>200 && g>170 && b<130. The yellow car's paint IS 0xffd400, so its own
   roof, hood, doors and pillars were switched off (holes everywhere) and the car
   read as wrecked. The real yellow card was the decal, already fixed in v127.
   These tests stop any colour test from coming back into the mesh-culling path.
   -------------------------------------------------------------------------- */
// strip JS comments so a test can inspect CODE, not the prose that explains it
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('v140: no colour heuristic may ever cull a car mesh (yellow car must stay whole)', () => {
  const g = stripComments(read('public/js/game.js'));
  const cm = stripComments(read('public/js/car-models.js'));

  // the exact pattern that broke the yellow paint (0xffd400 -> r255 g212 b0)
  const YELLOW_TEST = /r\s*>\s*200\s*&&\s*g\s*>\s*170\s*&&\s*b\s*<\s*130/;
  assert.ok(!YELLOW_TEST.test(g), 'yellow colour heuristic must be gone from game.js');
  assert.ok(!YELLOW_TEST.test(cm), 'no colour heuristic in car-models.js');
  assert.ok(!/[^\w]isYellow/.test(g), 'no isYellow flag left in game.js');
  assert.ok(!/[^\w]isYellow/.test(cm), 'no isYellow flag left in car-models.js');
  // nothing in placeCar may switch a mesh off because of the colour it happens to be
  const pcStart = g.indexOf('function placeCar(');
  const pcEnd = g.indexOf('// ---- network smoothing', pcStart);
  // (the only legit getHex in placeCar is the paint proxy compare; no colour *channels* may be read)
  assert.ok(!/>>\s*16/.test(g.slice(pcStart, pcEnd)), 'placeCar must not extract colour channels');
});

test('v140: placeCar never traverses/hides meshes per frame (yellow fix + stutter fix)', () => {
  const g = read('public/js/game.js');
  const start = g.indexOf('function placeCar(slot, cs, dt) {');
  const end = g.indexOf('// ---- network smoothing', start);
  assert.ok(start > 0 && end > start, 'placeCar body found');
  const body = g.slice(start, end);
  assert.ok(!body.includes('traverse('), 'placeCar must not traverse the hierarchy (it runs every frame for every car)');
  assert.ok(!body.includes('.visible=false'), 'placeCar must not hide meshes');
});

test('v140: mesh culling happens once per build, by name, and protects paint', () => {
  const raw = read('public/js/car-models.js');
  const cm = stripComments(raw);
  assert.ok(cm.includes('const INTERIOR_WORDS ='), 'interior word list present');
  assert.ok(/if \(isPaint\) return;/.test(cm), 'paint materials are explicitly protected from culling');
  const build = raw.indexOf('function build(id, paintHex, bodyIdx) {');
  const cullStart = raw.indexOf('const INTERIOR_WORDS');
  const cullEnd = raw.indexOf('const paintMats = []');
  assert.ok(build > 0 && cullStart > build && cullEnd > cullStart, 'cull pass lives inside build()');
  const cull = stripComments(raw.slice(cullStart, cullEnd));
  assert.ok(!cull.includes('getHex'), 'cull pass must not inspect colours');
  assert.ok(!/m\.color|material\.color/.test(cull), 'cull pass must not read material colours');
  assert.ok(cull.includes("!nm.startsWith('body')"), 'body panels survive the interior filter');
  assert.ok(cull.includes("nm.includes('license')"), 'licence plate culled at build time (the real yellow card)');
  assert.ok(cull.includes('model.traverse('), 'cull walk present');
  // and the per-frame path must not duplicate it
  const g = read('public/js/game.js');
  assert.ok(!g.includes('v.body.traverse'), 'no per-frame mesh walk left in game.js');
});

/* The cull rule is now the single source of truth for what a car looks like, so it
   is executed here against the REAL glTF graph: what survives is exactly what the
   player sees, and no body panel may be in the hidden set. */
test('v140: cull rule against the real glTF keeps every outer body panel', () => {
  const gltfPath = path.join(ROOT, 'public/assets/cars/ghost/CarConcept.gltf');
  const j = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
  const matName = (i) => (j.materials[i] && j.materials[i].name) || '';
  const INTERIOR_WORDS = /interior|dash|steering|pedal|seat|floor|floormat|cage|engine/;

  const hidden = [], kept = [];
  for (const node of j.nodes) {
    if (node.mesh == null) continue;
    const nm = (node.name || j.meshes[node.mesh].name || '').toLowerCase();
    const mats = (j.meshes[node.mesh].primitives || []).map((p) => matName(p.material));
    const matNames = mats.map((n) => n.toLowerCase());
    const isPaint = matNames.some((n) => /paint/.test(n));
    let hide = false;
    if (!isPaint) {
      if (nm.includes('license') || nm.includes('plate') || matNames.some((n) => n.includes('license'))) hide = true;
      else if (INTERIOR_WORDS.test(nm) && !nm.startsWith('body')) hide = true;
    }
    (hide ? hidden : kept).push(node.name || j.meshes[node.mesh].name);
  }

  // the real yellow card (licence plate) is culled...
  assert.ok(hidden.includes('License Plate'), 'licence plate must be hidden');
  // ...and every panel a player reads as "the car body" survives
  for (const panel of ['BodyRoofPanel', 'BodyPanelsColor2', 'BodyHood', 'BodyPillars', 'BodyHoodTopgrill',
    'BodyDoorRColor1', 'BodyDoorRColor2', 'BodyDoorLColor1', 'BodyDoorLColor2', 'BodyRearPanelsColor1',
    'BodyHeadlights', 'BodyTaillights', 'BodyWindshield', 'BodyDoorRWindow', 'BodyDoorLWindow', 'BodyRearwindow']) {
    assert.ok(!hidden.includes(panel), panel + ' must never be culled (it is the car body)');
  }
  // no mesh carrying a paint material may ever be culled - this is what broke the yellow car
  for (const node of j.nodes) {
    if (node.mesh == null) continue;
    const matNames = (j.meshes[node.mesh].primitives || []).map((p) => matName(p.material).toLowerCase());
    if (!matNames.some((n) => /paint/.test(n))) continue;
    assert.ok(!hidden.includes(node.name), 'paint mesh ' + node.name + ' was culled');
  }
  // and the cull is a strict subset: the car is never emptied
  assert.ok(kept.length > hidden.length, 'more meshes kept than hidden (kept ' + kept.length + ', hidden ' + hidden.length + ')');
});

/* ---------------------------------------------------------------------------
   v140 regression: "the game is not going correctly with cars".

   The player's complaint was the wheels. Two independent defects, both measured
   against the real asset rather than guessed:

   1. the GLB's FRONT WHEELS SHIP PRE-TURNED (axle.=(0.866, -0.5, 0) in the pivot's
      parent frame = 30 deg, and a different euler each side). v117..v138 wrote the
      live steering into the pivot's rotation.z, which zeroes ONE euler term and
      leaves the other two - so driving straight the front wheels sat 21-26 deg off
      lateral and cambered, asymmetrically. The rig now carries the authored pose in
      a `rest` group with the baked steering removed, so the live steering is a clean
      yaw about the vertical and the wheels point straight when the input is zero.
   2. the GLB wheels were driven with -spinAngle, which rolls every wheel BACKWARDS
      while the car drives forwards.
   -------------------------------------------------------------------------- */
const THREE = (() => { global.self = global; return require('../public/js/vendor/three.min.js'); })();

function wheelNodes() {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/cars/ghost/CarConcept.gltf'), 'utf8'));
  return j.nodes.filter((n) => /^Wheel(Front|Rear)(L|R)$/.test(n.name || ''));
}

test('v140: the asset really does ship its front wheels pre-turned', () => {
  const wheels = wheelNodes();
  assert.strictEqual(wheels.length, 4, 'four wheel nodes');
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const off = {};
  for (const n of wheels) {
    m.fromArray(n.matrix);
    m.decompose(p, q, sc);
    const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
    off[n.name] = Math.atan2(axle.y, axle.x) * 180 / Math.PI;
  }
  // front wheels carry a real baked steering angle; rear wheels are straight
  assert.ok(Math.abs(off.WheelFrontL) > 20, 'WheelFrontL baked steer, got ' + off.WheelFrontL.toFixed(1) + ' deg');
  assert.ok(Math.abs(off.WheelFrontR) > 20, 'WheelFrontR baked steer, got ' + off.WheelFrontR.toFixed(1) + ' deg');
  assert.ok(Math.abs(off.WheelRearL) < 0.01, 'WheelRearL is straight, got ' + off.WheelRearL.toFixed(3));
  assert.ok(Math.abs(off.WheelRearR) < 0.01, 'WheelRearR is straight, got ' + off.WheelRearR.toFixed(3));
});

test('v140: the rest group removes the baked steer, so the axle ends exactly lateral', () => {
  const wheels = wheelNodes();
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  for (const n of wheels) {
    m.fromArray(n.matrix);
    m.decompose(p, q, sc);
    // the exact three lines used in car-models.js build()
    const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
    const bakedSteer = Math.atan2(axle.y, axle.x);
    const rest = new THREE.Quaternion().setFromAxisAngle(Z, -bakedSteer).multiply(q);

    const out = new THREE.Vector3(1, 0, 0).applyQuaternion(rest);
    assert.ok(Math.abs(out.x - 1) < 1e-6 && Math.abs(out.y) < 1e-6 && Math.abs(out.z) < 1e-6,
      n.name + ' axle must end up exactly +X, got ' + out.toArray().map((v) => v.toFixed(6)));
  }
});

test('v140: the OLD steering write really did leave the front wheels crooked (documents the bug)', () => {
  const wheels = wheelNodes().filter((n) => /Front/.test(n.name));
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  for (const n of wheels) {
    m.fromArray(n.matrix);
    m.decompose(p, q, sc);
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    e.z = 0;                                     // what pivot.rotation.z = 0 did
    const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromEuler(e));
    const offX = Math.acos(Math.max(-1, Math.min(1, axle.x))) * 180 / Math.PI;
    assert.ok(offX > 15, n.name + ' used to sit ' + offX.toFixed(1) + ' deg off lateral');
    assert.ok(Math.abs(axle.y) > 0.1, n.name + ' used to be cambered too (y=' + axle.y.toFixed(3) + ')');
  }
});

test('v140: the rig is pivot -> steer -> rest -> spin, calipers outside the spin group', () => {
  const cm = stripComments(read('public/js/car-models.js'));
  assert.ok(cm.includes('const steerG = new THREE.Group();'), 'steer group');
  assert.ok(cm.includes('const restG = new THREE.Group(); restG.quaternion.copy(rest);'), 'rest group holds the authored pose');
  assert.ok(/pads\.forEach\(\(c\) => restG\.add\(c\)\);/.test(cm), 'calipers are added to rest, not to the rolling group');
  assert.ok(/rolling\.forEach\(\(c\) => spinG\.add\(c\)\);/.test(cm), 'rim/tyre/disc roll');
  assert.ok(/if \(\/pad\/i\.test\(c\.name \|\| ''\)\) pads\.push\(c\); else rolling\.push\(c\);/.test(cm), 'pad split rule');
  assert.ok(cm.includes('o.quaternion.identity();'), 'the pivot is left as a pure position holder');
  assert.ok(cm.includes('wheels.push({ pivot: steerG, spin: spinG'), 'the game drives the clean groups');
});

test('v140: wheels roll FORWARD with a positive angle on both rigs', () => {
  const g = stripComments(read('public/js/game.js'));
  assert.ok(/w\.spin\.rotation\.x = v\.spinAngle;/.test(g), 'single, forward sign for both rigs');
  assert.ok(!/rotation\.x = v\.isGlb \? -v\.spinAngle/.test(g), 'the backwards GLB sign must be gone');
  // rolling radius comes from the tyre itself, not a guessed constant
  assert.ok(read('public/js/car-models.js').includes('setFromObject(wheels[0].pivot)'), 'wheelR measured from the built wheel');
});

test('v140: the glass is opaque and standard (no transmission shader, no see-through cabin)', () => {
  const cm = read('public/js/car-models.js');
  assert.ok(/gm\.transmission = 0;/.test(cm), 'transmission off on the car glass');
  assert.ok(!cm.includes('trahsmission'), 'sanity');
  assert.ok(/gm\.transparent = false;/.test(cm), 'opaque glass hides the culled interior');
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/cars/ghost/CarConcept.gltf'), 'utf8'));
  assert.ok(JSON.stringify(j.extensionsUsed).includes('KHR_materials_transmission'), 'asset really does ship a transmissive windscreen');
});

test('v140: only the big panels cast shadows, and the wipers are gone', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/cars/ghost/CarConcept.gltf'), 'utf8'));
  const cm = read('public/js/car-models.js');
  const m = cm.match(/o\.castShadow = !\/([^\/]+)\/\.test\(\(\(o\.name \|\| ''\) \+ ' ' \+ matNames\)\.toLowerCase\(\)\);/);
  assert.ok(m, 'shadow rule present and material-aware');
  const re = new RegExp(m[1]);
  const matName = (i) => ((j.materials[i] || {}).name || '').toLowerCase();
  // run the rule over the real graph, exactly as build() does
  const casts = {};
  for (const n of j.nodes) {
    if (n.mesh == null) continue;
    const nm = (n.name || j.meshes[n.mesh].name || '').toLowerCase();
    const mn = (j.meshes[n.mesh].primitives || []).map((p) => matName(p.material)).join(' ');
    casts[n.name || j.meshes[n.mesh].name] = !re.test(nm + ' ' + mn);
  }
  for (const n of ['WheelFrontLRim', 'WheelFrontLBrakePad', 'WheelRearRRim']) {
    assert.ok(!casts[n], n + ' must stay out of the shadow pass');
  }
  for (const n of ['BodyRoofPanel', 'BodyHood', 'BodyPillars', 'BodyPanelsColor2', 'BodyWindshield']) {
    assert.ok(casts[n], n + ' must still cast a shadow');
  }
  // the tyres are unnamed nodes identified only by their materials - they must be caught
  const tyreNodes = j.nodes.filter((n) => n.mesh != null &&
    (j.meshes[n.mesh].primitives || []).some((p) => /tire/.test(matName(p.material))));
  assert.ok(tyreNodes.length >= 4, 'four tyres in the asset, found ' + tyreNodes.length);
  for (const n of tyreNodes) {
    const nm = (n.name || j.meshes[n.mesh].name || '').toLowerCase();
    const mn = (j.meshes[n.mesh].primitives || []).map((p) => matName(p.material)).join(' ');
    assert.ok(re.test(nm + ' ' + mn), 'tyre (unnamed, material-identified) must not cast a shadow');
  }
  assert.ok(/if\(\/wiper\/\.test\(nm\)\) o\.visible=false;/.test(cm), 'wipers culled (24 336 tris)');
  const meshOf = (name) => j.nodes.find((n) => n.name === name).mesh;
  const tris = j.meshes[meshOf('BodyWindshieldWipers')].primitives
    .reduce((s, p) => s + j.accessors[p.indices].count / 3, 0);
  assert.ok(tris > 20000, 'wiper mesh is ' + tris + ' triangles');
});

/* ---------------------------------------------------------------------------
   v140 integration: run the REAL build() over a faithful reconstruction of the
   asset (real node names, real hierarchy, real transforms, real material names
   and types) and inspect the rig it produces. This is the closest thing to
   "load the car in a browser" that can run without a DOM: it catches anything
   that throws, and it pins the structure the game drives.
   -------------------------------------------------------------------------- */
function buildFakeScene(THREE) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/cars/ghost/CarConcept.gltf'), 'utf8'));
  const mats = j.materials.map((m) => {
    const name = m.name || '';
    if (/glass/i.test(name)) return new THREE.MeshPhysicalMaterial({ name, transmission: 1, roughness: 0, metalness: 0 });
    if (/paint/i.test(name)) return new THREE.MeshPhysicalMaterial({ name, color: 0x884400, clearcoat: 1, metalness: 0.6, roughness: 0.3 });
    return new THREE.MeshStandardMaterial({ name: name || 'None' });
  });
  const objs = j.nodes.map((n) => {
    let o;
    if (n.mesh != null) {
      const prim = (j.meshes[n.mesh].primitives || [])[0] || {};
      const mt = mats[prim.material] || mats[0];
      o = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), mt);
    } else {
      o = new THREE.Group();
    }
    if (n.name) o.name = n.name;
    return o;
  });
  j.nodes.forEach((n, i) => {
    if (n.matrix) objs[i].applyMatrix4(new THREE.Matrix4().fromArray(n.matrix));
    else {
      if (n.translation) objs[i].position.fromArray(n.translation);
      if (n.rotation) objs[i].quaternion.fromArray(n.rotation);
      if (n.scale) objs[i].scale.fromArray(n.scale);
    }
    (n.children || []).forEach((c) => objs[i].add(objs[c]));
  });
  const scene = new THREE.Group();
  (j.scenes[j.scene || 0].nodes || []).forEach((r) => scene.add(objs[r]));
  return { scene, wheels: ['WheelFrontL', 'WheelFrontR', 'WheelRearL', 'WheelRearR'] };
}

function acquireFake(THREE, scene) {
  const sandbox = {
    window: {}, console: { warn() {}, log() {}, error() {} }, Promise, Math, Array, Object, isFinite,
  };
  sandbox.THREE = Object.create(THREE);      // real three, plus a stubbed loader
  sandbox.THREE.GLTFLoader = class { load(url, onLoad) { onLoad({ scene }); } };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/car-models.js'), sandbox, { filename: 'car-models.js' });
  return sandbox.window.CarModels.acquire('ghost', 0xffd400, 1);
}

test('v140: build() survives the real graph and produces a drivable rig', async () => {
  const { scene } = buildFakeScene(THREE);
  const wrap = await acquireFake(THREE, scene);
  assert.ok(wrap && wrap.isGlb, 'a GLB wrapper is produced (no throw, no fallback)');
  assert.strictEqual(wrap.wheels.length, 4, 'four wheels are rigged');
  assert.ok(wrap.wheelR > 0.2 && wrap.wheelR < 0.6, 'rolling radius sane: ' + wrap.wheelR.toFixed(3));
  assert.ok(wrap.group.children.length === 1, 'single visual root');
  // the game drives pivot (steering) + spin (rolling) - both must exist and be groups
  for (const w of wrap.wheels) {
    assert.ok(w.pivot && w.pivot.isGroup, 'steer group');
    assert.ok(w.spin && w.spin.isGroup, 'spin group');
    assert.strictEqual(typeof w.front, 'boolean');
  }
});

test('v140: rim rolls, caliper does not, and the front pivot steers about the vertical', async () => {
  const { scene } = buildFakeScene(THREE);
  const wrap = await acquireFake(THREE, scene);
  const front = wrap.wheels.find((w) => w.front && /L$/.test(w.pivot.parent.name));
  assert.ok(front, 'front-left wheel found');
  // the rim/tyre roll with the wheel, the caliper stays on the upright
  assert.ok(front.spin.getObjectByName('WheelFrontLRim'), 'rim is inside the rolling group');
  assert.ok(!front.spin.getObjectByName('WheelFrontLBrakePad'), 'caliper must NOT roll');
  assert.ok(front.pivot.getObjectByName('WheelFrontLBrakePad'), 'caliper still exists on the upright');
  // steering is a yaw about the parent's vertical: the rest pose must already put the
  // axle lateral, so rotating the pivot's Z afterwards keeps it horizontal
  wrap.group.updateMatrixWorld(true);
  const axleBefore = new THREE.Vector3(1, 0, 0).applyQuaternion(front.spin.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(Math.abs(axleBefore.y) < 1e-6, 'axle is horizontal before steering (y=' + axleBefore.y.toFixed(6) + ')');
  assert.ok(Math.abs(axleBefore.z) < 1e-6, 'axle is lateral before steering (z=' + axleBefore.z.toFixed(6) + ')');
  front.pivot.rotation.z = -0.3;                       // what placeCar writes
  wrap.group.updateMatrixWorld(true);
  const axleAfter = new THREE.Vector3(1, 0, 0).applyQuaternion(front.spin.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(Math.abs(axleAfter.y) < 1e-6, 'steering never lifts the axle off the horizontal');
  assert.ok(Math.abs(axleAfter.z) > 0.05, 'steering yaws the wheel (z=' + axleAfter.z.toFixed(3) + ')');
  assert.ok(Math.abs(axleAfter.z) < 0.4, 'steering stays within the lock');
});

test('v140: build() output keeps every paint panel visible and costs far less geometry', async () => {
  const { scene } = buildFakeScene(THREE);
  const wrap = await acquireFake(THREE, scene);
  const hidden = [], shown = [];
  wrap.group.traverse((o) => { if (o.isMesh) (o.visible ? shown : hidden).push(o.name); });
  for (const panel of ['BodyRoofPanel', 'BodyHood', 'BodyPillars', 'BodyDoorLColor1', 'BodyPanelsColor2']) {
    assert.ok(shown.includes(panel), panel + ' must stay visible on the built car');
  }
  assert.ok(hidden.includes('License Plate'), 'plate culled');
  assert.ok(hidden.includes('BodyWindshieldWipers'), 'wipers culled');
  assert.ok(hidden.includes('InteriorSeatsFrame1'), 'interior culled');
  // glass is opaque now: no transmission, no see-through cabin
  const glass = wrap.group.getObjectByName('BodyWindshield');
  assert.ok(glass, 'windscreen still on the car');
  assert.strictEqual(glass.material.transmission, 0, 'no transmission on the car glass');
  assert.strictEqual(glass.material.transparent, false, 'glass is opaque');
  // paint was recoloured to this car's hex
  const hood = wrap.group.getObjectByName('BodyHood');
  assert.strictEqual(hood.material.color.getHex(), 0xffd400, 'paint takes the car colour');
  // and the paint proxy placeCar uses must repaint the panels
  wrap.paint.color.setHex(0x00a651);
  assert.strictEqual(hood.material.color.getHex(), 0x00a651, 'setHex on the proxy repaints the car');
});

/* ---------------------------------------------------------------------------
   v140: the WHITE car never became the real model.

   Every procedural shell is built with carId 'ghost' (v136), and the white paint
   0xffffff also maps to the id 'ghost'. Both upgrade gates skipped the work when
   the id matched, so a white car - one of the eight colours in the paint picker -
   stayed the low-poly shell for the whole race while every other car loaded the
   GLB. The gates now ask whether the slot already shows this GLB.
   -------------------------------------------------------------------------- */
test('v140: a white car (id "ghost") is not mistaken for an already-upgraded shell', () => {
  const g = stripComments(read('public/js/game.js'));
  assert.ok(!/if \(!old \|\| old\.glbPending \|\| old\.carId === id\) return;/.test(g),
    'the id-only early return must be gone from upgradeCarVisual');
  assert.ok(/if \(old\.isGlb && old\.carId === id\) return;/.test(g),
    'upgradeCarVisual skips only a GLB that already matches');
  assert.ok(!/if \(wantId && v\.carId !== wantId && !v\.glbPending\)/.test(g),
    'placeCar must not gate on the bare car id');
  assert.ok(/if \(wantId && !v\.glbPending && !\(v\.isGlb && v\.carId === wantId\)\)/.test(g),
    'placeCar gates on "already the right GLB"');
  // and the white paint really does map to the ghost id that the shells carry
  const CM = loadCarModels();
  assert.strictEqual(CM.idForHex(0xffffff), 'ghost', 'white -> ghost id');
  assert.ok(/0xffffff: 'ghost'/.test(g), 'and the procedural shells are ghost too');
});
