'use strict';

// show runtime errors on screen instead of a silent black canvas
window.addEventListener('error', (e) => {
  let d = document.getElementById('boot-error');
  if (!d) {
    d = document.createElement('div');
    d.id = 'boot-error';
    d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:999;max-width:90vw;white-space:pre-wrap;' +
      'background:#200;color:#f88;font:12px monospace;padding:8px;border-radius:6px;';
    document.body.appendChild(d);
  }
  d.textContent = '⚠ ' + (e.message || e.error) + '\n' + (e.filename || '') + ':' + (e.lineno || '');
});

/* ============================================================
   SRIDHAR RUSH — online multiplayer screen client
   Renders the authoritative server simulation with smooth
   interpolation. 5 selectable themed maps rebuild the world.
   ============================================================ */

const CORE = window.VRCore;
// v54 tripwire: the #1 historic bug was a stale shared/game-core.js in the deploy
// repo (Vercel's build copies it over public/js every deploy). If the core is an
// old 3-map build while this client expects 5 radial maps, the client draws one
// circuit while the server simulates another = "car off the track". Fail LOUDLY.
if (!CORE || !CORE.MAPS || CORE.MAPS.length < 5 || !CORE.MAPS[1].radial) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#5a0000;color:#fff;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font:600 15px system-ui,sans-serif;letter-spacing:.3px;';
  d.textContent = '⚠ OLD GAME CORE DETECTED (3-map build). Update shared/game-core.js in the deploy repo from the latest release, then redeploy. Until then the drawn track and the server track disagree.';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(d));
}
const CFG = CORE.CFG;
const RH = CFG.roadHalf;
const PI2 = Math.PI * 2;
const INTERP_DELAY = 120;

let A = CORE.MAPS[0].a, B = CORE.MAPS[0].b;
let curMap = CORE.MAPS[0];

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const fmtTime = CORE.fmtTime;
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= PI2;
  while (d < -Math.PI) d += PI2;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 2600);

function themeSettings(theme) {
  if (theme === 'neon') return {
    bg: 0x070a16, fogNear: 160, fogFar: 620,
    skyTop: 0x04060f, skyHorizon: 0x33184d, skyBottom: 0x0a0a12,
    hemiSky: 0x4455cc, hemiGround: 0x141426, hemiInt: 0.4,
    sunColor: 0x99aaff, sunInt: 0.55, sunPos: [140, 220, 90],
    exposure: 1.1, night: true, ocean: false, palms: false, pines: false, ground: '#141821'
  };
  if (theme === 'island') return {
    bg: 0xffcf9a, fogNear: 300, fogFar: 900,
    skyTop: 0x27406f, skyHorizon: 0xff9a4d, skyBottom: 0xd8865a,
    hemiSky: 0xffc08a, hemiGround: 0x8a5a3a, hemiInt: 0.6,
    sunColor: 0xffa040, sunInt: 1.8, sunPos: [260, 90, 150],
    exposure: 1.12, night: false, ocean: true, palms: true, pines: false, ground: '#d8b478'
  };
  if (theme === 'desert') return {
    bg: 0xf2d3a0, fogNear: 300, fogFar: 950,
    skyTop: 0x2a7fd4, skyHorizon: 0xf2c078, skyBottom: 0xd8a060,
    hemiSky: 0xffd9a0, hemiGround: 0x9a6a3a, hemiInt: 0.65,
    sunColor: 0xffc060, sunInt: 1.9, sunPos: [240, 200, 120],
    exposure: 1.1, night: false, ocean: false, palms: true, pines: false, ground: '#d8a35c'
  };
  if (theme === 'snow') return {
    bg: 0xe8f0f6, fogNear: 300, fogFar: 900,
    skyTop: 0x7fb2e0, skyHorizon: 0xeef4f8, skyBottom: 0xdfe8ee,
    hemiSky: 0xdfeeff, hemiGround: 0xb8c8d4, hemiInt: 0.6,
    sunColor: 0xfff2e0, sunInt: 1.4, sunPos: [200, 220, 140],
    exposure: 1.08, night: false, ocean: false, palms: false, pines: true, ground: '#e8eef2'
  };
  return { // highland (default)
    bg: 0xd7e3ec, fogNear: 320, fogFar: 980,
    skyTop: 0x1d6fd6, skyHorizon: 0xdfe9f0, skyBottom: 0x98a196,
    hemiSky: 0xbfd8ff, hemiGround: 0x44543a, hemiInt: 0.5,
    sunColor: 0xffe3b8, sunInt: 1.5, sunPos: [210, 240, 110],
    exposure: 1.05, night: false, ocean: false, palms: false, pines: true, ground: '#41702f'
  };
}

// persistent sky / lights (updated per theme)
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: {
    top: { value: new THREE.Color(0x1d6fd6) },
    horizon: { value: new THREE.Color(0xdfe9f0) },
    bottom: { value: new THREE.Color(0x98a196) }
  },
  vertexShader: `
    varying vec3 vWorld;
    void main() {
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    varying vec3 vWorld;
    uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom;
    void main() {
      float h = normalize(vWorld).y;
      vec3 c = h > 0.0
        ? mix(horizon, top, pow(h, 0.55))
        : mix(horizon, bottom, pow(-h, 0.4));
      gl_FragColor = vec4(c, 1.0);
    }`
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(1500, 24, 12), skyMat));

const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x44543a, 0.5);
scene.add(hemi);
const sunLight = new THREE.DirectionalLight(0xffe3b8, 1.5);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -300; sunLight.shadow.camera.right = 300;
sunLight.shadow.camera.top = 260;   sunLight.shadow.camera.bottom = -260;
sunLight.shadow.camera.near = 40;   sunLight.shadow.camera.far = 900;
sunLight.shadow.bias = -0.00045;
scene.add(sunLight, sunLight.target);

const sunSprite = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,252,235,1)');
  grad.addColorStop(0.25, 'rgba(255,244,200,0.85)');
  grad.addColorStop(1, 'rgba(255,244,200,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const m = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), fog: false, depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.set(220, 220, 1);
  scene.add(s);
  return s;
})();

// world geometry lives in a group we rebuild per map
const worldGroup = new THREE.Group();
const puMeshes = []; // v59 pickup visuals
scene.add(worldGroup);

function makeEnvTexture(night) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  if (night) {
    grad.addColorStop(0, '#060a18'); grad.addColorStop(0.45, '#1a2340');
    grad.addColorStop(0.52, '#3a2a55'); grad.addColorStop(1, '#05050c');
  } else {
    grad.addColorStop(0, '#1668d8'); grad.addColorStop(0.42, '#8ec4f4');
    grad.addColorStop(0.5, '#f4e9d8'); grad.addColorStop(0.56, '#8d958c');
    grad.addColorStop(1, '#39422f');
  }
  g.fillStyle = grad; g.fillRect(0, 0, 512, 256);
  g.fillStyle = night ? 'rgba(255,120,220,0.5)' : 'rgba(255,255,255,0.95)';
  g.fillRect(0, 34, 512, 14); g.fillRect(0, 78, 512, 7);
  g.fillStyle = 'rgba(18,28,48,0.5)'; g.fillRect(0, 54, 512, 12);
  const sun = g.createRadialGradient(400, 62, 4, 400, 62, 92);
  sun.addColorStop(0, night ? 'rgba(220,230,255,1)' : 'rgba(255,255,245,1)');
  sun.addColorStop(1, 'rgba(255,246,210,0)');
  g.fillStyle = sun; g.fillRect(0, 0, 512, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}
let pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
function setEnvironment(night) {
  scene.environment = pmrem.fromEquirectangular(makeEnvTexture(night)).texture;
}

// ---------------------------------------------------------------------------
// v80 zero-lag textures & memory management
// ---------------------------------------------------------------------------
const _texCache = {};
function getCachedTexture(key, createFn) {
  if (_texCache[key]) return _texCache[key];
  const tex = createFn();
  tex._cached = true;
  _texCache[key] = tex;
  return tex;
}

function grassTexture(base) {
  return getCachedTexture('grass_' + base, () => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(${30 + Math.random() * 60},${80 + Math.random() * 80},${28 + Math.random() * 40},0.3)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 2.5);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(150, 150); tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function asphaltTexture(col) {
  return getCachedTexture('asphalt_' + col, () => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = col; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5200; i++) {
      const v = 28 + Math.random() * 46;
      g.fillStyle = `rgba(${v},${v},${v + 3},0.5)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 1.4, 1.4);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(0.1, 0.1); tex.anisotropy = 8; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function buildingTexture(seed, night) {
  return getCachedTexture(`bldg_${seed % 3}_${night ? 1 : 0}`, () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = night ? ['#141a26', '#1a1626', '#10141f'][seed % 3] : ['#22303e', '#2c2a33', '#3a3f47'][seed % 3];
    g.fillRect(0, 0, 64, 128);
    for (let y = 6; y < 122; y += 10) for (let x = 5; x < 58; x += 10) {
      const r = Math.random();
      g.fillStyle = night
        ? (r < 0.5 ? (r < 0.2 ? '#ff4fd8' : '#39d5ff') : (r < 0.7 ? '#ffd97a' : '#0a0e18'))
        : (r < 0.24 ? '#ffd97a' : (r < 0.55 ? '#5f7488' : '#1b2530'));
      g.fillRect(x, y, 6, 7);
    }
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}

function disposeHierarchy(obj) {
  if (!obj) return;
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => {
          if (m.map && !m.map._cached) m.map.dispose();
          m.dispose();
        });
      } else {
        if (child.material.map && !child.material.map._cached) child.material.map.dispose();
        child.material.dispose();
      }
    }
  });
}

function ellipseRing(rIn, rOut, segments) {
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, A + rOut, B + rOut, 0, PI2, false, 0);
  const hole = new THREE.Path();
  hole.absellipse(0, 0, A + rIn, B + rIn, 0, PI2, true, 0);
  shape.holes.push(hole);
  const geo = new THREE.ShapeGeometry(shape, segments || 96);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

const _im = new THREE.Matrix4(), _iq = new THREE.Quaternion(), _iup = new THREE.Vector3(0, 1, 0);
function instancedAlong(geo, mat, offset, stepLen, y, scaleY) {
  const ax = A + offset, bz = B + offset;
  const per = Math.PI * (3 * (ax + bz) - Math.sqrt((3 * ax + bz) * (ax + 3 * bz)));
  const N = Math.max(24, Math.round(per / stepLen));
  const inst = new THREE.InstancedMesh(geo, mat, N);
  for (let i = 0; i < N; i++) {
    const t = (i / N) * PI2;
    _iq.setFromAxisAngle(_iup, Math.atan2(-ax * Math.sin(t), bz * Math.cos(t)));
    _im.compose(new THREE.Vector3(ax * Math.cos(t), y, bz * Math.sin(t)), _iq, new THREE.Vector3(1, scaleY || 1, 1));
    inst.setMatrixAt(i, _im);
  }
  inst.receiveShadow = true;
  worldGroup.add(inst);
  return inst;
}

let clouds = [];
function addClouds() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (const [cx, cy, r] of [[40, 70, 26], [70, 60, 30], [95, 72, 22], [64, 80, 26]]) {
    g.beginPath(); g.arc(cx, cy, r, 0, PI2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  clouds = [];
  for (let i = 0; i < 7; i++) {
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.75, fog: false, depthWrite: false });
    const s = new THREE.Sprite(m);
    const a = (i / 7) * PI2;
    s.position.set(Math.cos(a) * (500 + i * 60), 260 + (i % 3) * 60, Math.sin(a) * (500 + i * 60));
    s.scale.set(180 + (i % 3) * 60, 60 + (i % 2) * 25, 1);
    worldGroup.add(s);
    clouds.push(s);
  }
}
function updateClouds(dt) {
  for (const s of clouds) {
    s.position.x += dt * 4;
    if (s.position.x > 950) s.position.x = -950;
  }
}

// ---------------------------------------------------------------------------
// buildWorld — rebuilds all themed geometry for a map
// ---------------------------------------------------------------------------

function centerline(map) {
  if (map.type === 'spline') return map.points;
  const out = [];
  for (let i = 0; i < 256; i++) { const t = i / 256 * PI2; out.push({ x: A * Math.cos(t), z: B * Math.sin(t) }); }
  return out;
}
function ribbon(pts, offset, halfW, y, mat) {
  const n = pts.length; const pos = []; const idx = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    let tx = q.x - p.x, tz = q.z - p.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    const nx = -tz, nz = tx;
    pos.push(p.x + nx * (offset + halfW), y, p.z + nz * (offset + halfW), p.x + nx * (offset - halfW), y, p.z + nz * (offset - halfW));
  }
  for (let i = 0; i < n; i++) { const a = 2 * i, b = 2 * i + 1, c = 2 * ((i + 1) % n), d = 2 * ((i + 1) % n) + 1; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat); m.receiveShadow = true;
  worldGroup.add(m); return m;
}
function buildSplineVisuals(map, T) {
  const cl = map.points;
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.8 });
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0xcfd6dd, metalness: 0.6, roughness: 0.4 });
  const FO = map.fenceOff != null ? map.fenceOff : RH + 2.5; // fence drawn ON the physical boundary
  if (map.offsetPts) {
    // v68 RADIAL-X: road, lines and fence come from the track's EXACT offset
    // curves — the very formula the physics barrier uses. Pixels and physics
    // can never diverge, so the car can never appear past the fence.
    ribbon(map.offsetPts(0, 512), 0, RH, 0.02, new THREE.MeshStandardMaterial({ map: asphaltTexture(T.night ? '#16181e' : '#2a2d32'), roughness: 0.92, metalness: 0.05 }));
    ribbon(map.offsetPts(RH - 0.7, 512), 0, 0.18, 0.045, lineMat);
    ribbon(map.offsetPts(-(RH - 0.7), 512), 0, 0.18, 0.045, lineMat);
    // v71: MAP-0-STYLE SOLID WALLS + RAILS along the exact curves — same
    // geometry/heights/colors as Highland's proven barrier (no thin rails).
    const wallGeo = new THREE.BoxGeometry(0.5, 0.95, 2.7);
    const wallMat = new THREE.MeshStandardMaterial({ color: T.night ? 0x3a4050 : 0xb9bec4, roughness: 0.85 });
    const railGeo = new THREE.BoxGeometry(0.54, 0.14, 2.7);
    const railMat = new THREE.MeshStandardMaterial({ color: T.night ? 0x39d5ff : 0xc9302c, roughness: 0.6 });
    const wallLine = (side) => {
      const pts = map.offsetPts((RH + 3.65) * side, 1024);
      const items = [];
      let acc = 0, lx = pts[0].x, lz = pts[0].z;
      for (let i = 1; i <= 1024; i++) {
        const p = pts[i % 1024];
        acc += Math.hypot(p.x - lx, p.z - lz); lx = p.x; lz = p.z;
        if (acc >= 2.6) { acc = 0; const q = pts[(i + 1) % 1024]; items.push({ x: p.x, z: p.z, yaw: Math.atan2(q.x - p.x, q.z - p.z) }); }
      }
      const walls = new THREE.InstancedMesh(wallGeo, wallMat, items.length);
      const rails = new THREE.InstancedMesh(railGeo, railMat, items.length);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), SC = new THREE.Vector3(1, 1, 1), V = new THREE.Vector3();
      items.forEach((it2, ix) => {
        Q.setFromAxisAngle(UP, it2.yaw);
        M.compose(V.set(it2.x, 0.475, it2.z), Q, SC); walls.setMatrixAt(ix, M);
        M.compose(V.set(it2.x, 1.02, it2.z), Q, SC); rails.setMatrixAt(ix, M);
      });
      walls.receiveShadow = rails.receiveShadow = true;
      worldGroup.add(walls, rails);
    };
    wallLine(1); wallLine(-1);
    // v72: Map-0-style red/white curbs at the road edges, along exact curves
    const curbGeo = new THREE.BoxGeometry(1.0, 0.07, 2.6);
    const curbR = new THREE.MeshStandardMaterial({ color: 0xc9302c, roughness: 0.9 });
    const curbW = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.9 });
    const curbLine = (side) => {
      const pts = map.offsetPts((RH + 0.6) * side, 1024);
      const items = [];
      let acc = 0, lx = pts[0].x, lz = pts[0].z;
      for (let i = 1; i <= 1024; i++) {
        const p = pts[i % 1024];
        acc += Math.hypot(p.x - lx, p.z - lz); lx = p.x; lz = p.z;
        if (acc >= 2.6) { acc = 0; const q = pts[(i + 1) % 1024]; items.push({ x: p.x, z: p.z, yaw: Math.atan2(q.x - p.x, q.z - p.z) }); }
      }
      const ir = new THREE.InstancedMesh(curbGeo, curbR, Math.ceil(items.length / 2));
      const iw = new THREE.InstancedMesh(curbGeo, curbW, Math.floor(items.length / 2));
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), SC = new THREE.Vector3(1, 1, 1), V = new THREE.Vector3();
      let ri = 0, wi = 0;
      items.forEach((it2, ix) => {
        Q.setFromAxisAngle(UP, it2.yaw);
        M.compose(V.set(it2.x, 0.045, it2.z), Q, SC);
        if (ix % 2 === 0) ir.setMatrixAt(ri++, M); else iw.setMatrixAt(wi++, M);
      });
      ir.receiveShadow = iw.receiveShadow = true;
      worldGroup.add(ir, iw);
    };
    curbLine(1); curbLine(-1);
  } else {
    ribbon(cl, 0, RH, 0.02, new THREE.MeshStandardMaterial({ map: asphaltTexture(T.night ? '#16181e' : '#2a2d32'), roughness: 0.92, metalness: 0.05 }));
    ribbon(cl, RH - 0.7, 0.18, 0.045, lineMat);
    ribbon(cl, -(RH - 0.7), 0.18, 0.045, lineMat);
    ribbon(cl, FO, 0.12, 0.34, fenceMat);
    ribbon(cl, -FO, 0.12, 0.34, fenceMat);
    ribbon(cl, FO, 0.1, 0.78, fenceMat);
    ribbon(cl, -FO, 0.1, 0.78, fenceMat);
  }
  const p0 = cl[0], p1 = cl[1];
  const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);
  const c = document.createElement('canvas'); c.width = 160; c.height = 32;
  const g = c.getContext('2d');
  for (let i = 0; i < 10; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#101010' : '#f4f4f4'; g.fillRect(i * 16, j * 16, 16, 16); }
  const tex = new THREE.CanvasTexture(c); tex.magFilter = THREE.NearestFilter; tex.encoding = THREE.sRGBEncoding;
  const line = new THREE.Mesh(new THREE.PlaneGeometry(RH * 2, 2.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }));
  line.rotation.x = -Math.PI / 2; line.rotation.z = -yaw; line.position.set(p0.x, 0.06, p0.z);
  worldGroup.add(line);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8dbe2, metalness: 0.7, roughness: 0.35 });
  const poleGeo = new THREE.CylinderGeometry(0.28, 0.34, 8, 10);
  const nx = Math.cos(yaw), nz = -Math.sin(yaw);
  for (const side of [-1, 1]) {
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(p0.x + (-nz) * side * (RH + 1.4), 4, p0.z + (nx) * side * (RH + 1.4));
    pole.castShadow = true; worldGroup.add(pole);
  }
  const bc = document.createElement('canvas'); bc.width = 512; bc.height = 96;
  const bg = bc.getContext('2d');
  for (let i = 0; i < 32; i++) for (let j = 0; j < 2; j++) { bg.fillStyle = (i + j) % 2 ? '#111' : '#f2f2f2'; bg.fillRect(i * 16, j * 12, 16, 12); }
  bg.fillStyle = 'rgba(10,12,20,0.88)'; bg.fillRect(0, 24, 512, 72);
  bg.fillStyle = '#ffd479'; bg.font = '900 44px Arial Black, Arial'; bg.textAlign = 'center'; bg.fillText('START / FINISH', 256, 78);
  const btex = new THREE.CanvasTexture(bc); btex.encoding = THREE.sRGBEncoding;
  const bannerMesh = new THREE.Mesh(new THREE.PlaneGeometry(RH * 2 + 2.8, 2.2), new THREE.MeshStandardMaterial({ map: btex, side: THREE.DoubleSide, roughness: 0.7 }));
  bannerMesh.position.set(p0.x, 7.1, p0.z); bannerMesh.rotation.y = yaw;
  bannerMesh.castShadow = true; worldGroup.add(bannerMesh);
}
function buildWorld(map) {
  curMap = map;
  A = map.a; B = map.b;
  const T = themeSettings(map.theme);
  const W = map.world;

  // v80 clear and properly dispose previous world GPU resources (prevents memory leak & map lag)
  while (worldGroup.children.length) {
    const child = worldGroup.children[0];
    worldGroup.remove(child);
    disposeHierarchy(child);
  }
  puMeshes.length = 0;
  if (CORE.pickupSpots) { // v59: visible power-ups at the SAME deterministic spots as the server
    CORE.pickupSpots(map).forEach((sp) => {
      let m;
      if (sp.type === 0) m = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 4), new THREE.MeshStandardMaterial({ color: 0x35e0ff, emissive: 0x35e0ff, emissiveIntensity: 1.4 }));
      else if (sp.type === 1) m = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), new THREE.MeshStandardMaterial({ color: 0x3ddc84, emissive: 0x3ddc84, emissiveIntensity: 1.0, transparent: true, opacity: 0.85 }));
      else m = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.16, 8, 18), new THREE.MeshStandardMaterial({ color: 0xff20c8, emissive: 0xff20c8, emissiveIntensity: 1.2 }));
      m.position.set(sp.x, 0.8, sp.z);
      worldGroup.add(m); puMeshes.push(m);
    });
  }

  // apply theme to sky/lights/fog
  scene.background = new THREE.Color(T.bg);
  scene.fog = new THREE.Fog(T.bg, T.fogNear, T.fogFar);
  skyMat.uniforms.top.value.setHex(T.skyTop);
  skyMat.uniforms.horizon.value.setHex(T.skyHorizon);
  skyMat.uniforms.bottom.value.setHex(T.skyBottom);
  hemi.color.setHex(T.hemiSky); hemi.groundColor.setHex(T.hemiGround); hemi.intensity = T.hemiInt;
  sunLight.color.setHex(T.sunColor); sunLight.intensity = T.sunInt;
  sunLight.position.set(T.sunPos[0], T.sunPos[1], T.sunPos[2]);
  sunSprite.position.copy(sunLight.position).normalize().multiplyScalar(1300);
  sunSprite.visible = !T.night;
  renderer.toneMappingExposure = T.exposure;
  setEnvironment(T.night);

  // ground (+ ocean for island)
  if (T.ocean) {
    const water = new THREE.Mesh(new THREE.CircleGeometry(1500, 64),
      new THREE.MeshStandardMaterial({ color: 0x18a0b8, roughness: 0.3, metalness: 0.15 }));
    water.rotation.x = -Math.PI / 2; water.position.y = -0.4;
    worldGroup.add(water);
    const island = new THREE.Mesh(new THREE.CircleGeometry(Math.max(A, B) + RH + 70, 64),
      new THREE.MeshStandardMaterial({ map: grassTexture('#b8a058'), roughness: 1 }));
    island.rotation.x = -Math.PI / 2; island.receiveShadow = true;
    worldGroup.add(island);
  } else {
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1500, 64),
      new THREE.MeshStandardMaterial({ map: grassTexture(T.ground || (T.night ? '#141821' : '#41702f')), roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    worldGroup.add(ground);
  }

  // road
  if (map.type !== 'spline') {
  const road = new THREE.Mesh(ellipseRing(-RH, RH, 128),
    new THREE.MeshStandardMaterial({ map: asphaltTexture(T.night ? '#16181e' : '#2a2d32'), roughness: 0.92, metalness: 0.05 }));
  road.position.y = 0.02; road.receiveShadow = true;
  worldGroup.add(road);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.8 });
  for (const off of [RH - 0.9, -RH + 0.55]) {
    const line = new THREE.Mesh(ellipseRing(off, off + 0.35, 128), lineMat);
    line.position.y = 0.045;
    worldGroup.add(line);
  }

  // center dashes
  {
    const geo = new THREE.BoxGeometry(0.32, 0.03, 2.4);
    const mat = new THREE.MeshStandardMaterial({ color: 0xf2e14c, roughness: 0.7 });
    const STEPS = 160, dashes = [];
    for (let i = 0; i < STEPS; i++) {
      if (i % 4 >= 2) continue;
      const t = (i / STEPS) * PI2;
      dashes.push({ x: A * Math.cos(t), z: B * Math.sin(t), yaw: Math.atan2(-A * Math.sin(t), B * Math.cos(t)) });
    }
    const inst = new THREE.InstancedMesh(geo, mat, dashes.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    dashes.forEach((d, i) => {
      q.setFromAxisAngle(up, d.yaw);
      m.compose(new THREE.Vector3(d.x, 0.05, d.z), q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(i, m);
    });
    worldGroup.add(inst);
  }

  // finish + start lines + gantry
  {
    const c = document.createElement('canvas'); c.width = 160; c.height = 32;
    const g = c.getContext('2d');
    for (let i = 0; i < 10; i++) for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? '#101010' : '#f4f4f4';
      g.fillRect(i * 16, j * 16, 16, 16);
    }
    const tex = new THREE.CanvasTexture(c); tex.magFilter = THREE.NearestFilter; tex.encoding = THREE.sRGBEncoding;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(RH * 2, 2.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }));
    line.rotation.x = -Math.PI / 2; line.position.set(A, 0.06, 0);
    worldGroup.add(line);

    const startLine = new THREE.Mesh(new THREE.PlaneGeometry(RH * 2, 0.6), new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 }));
    startLine.rotation.x = -Math.PI / 2; startLine.position.set(A, 0.055, -6);
    worldGroup.add(startLine);

    const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8dbe2, metalness: 0.7, roughness: 0.35 });
    const poleGeo = new THREE.CylinderGeometry(0.28, 0.34, 8, 10);
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(A + side * (RH + 1.4), 4, 0);
      pole.castShadow = true;
      worldGroup.add(pole);
    }
    const bc = document.createElement('canvas'); bc.width = 512; bc.height = 96;
    const bg = bc.getContext('2d');
    for (let i = 0; i < 32; i++) for (let j = 0; j < 2; j++) {
      bg.fillStyle = (i + j) % 2 ? '#111' : '#f2f2f2';
      bg.fillRect(i * 16, j * 12, 16, 12);
    }
    bg.fillStyle = 'rgba(10,12,20,0.88)'; bg.fillRect(0, 24, 512, 72);
    bg.fillStyle = '#ffd479'; bg.font = '900 44px Arial Black, Arial'; bg.textAlign = 'center';
    bg.fillText('START / FINISH', 256, 78);
    const btex = new THREE.CanvasTexture(bc); btex.encoding = THREE.sRGBEncoding;
    const bannerMesh = new THREE.Mesh(new THREE.PlaneGeometry(RH * 2 + 2.8, 2.2),
      new THREE.MeshStandardMaterial({ map: btex, side: THREE.DoubleSide, roughness: 0.7 }));
    bannerMesh.position.set(A, 7.1, 0);
    bannerMesh.castShadow = true;
    worldGroup.add(bannerMesh);
  }
  } else {
    buildSplineVisuals(map, T);
  }

  // buildings
  {
    const buildingMats = [0, 1, 2].map((i) => new THREE.MeshStandardMaterial({ map: buildingTexture(i, T.night), roughness: 0.9 }));
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.95 });
    for (const b of W.buildings) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d),
        [buildingMats[b.tex], buildingMats[(b.tex + 1) % 3], roofMat, roofMat, buildingMats[(b.tex + 2) % 3], buildingMats[b.tex]]);
      mesh.position.set(b.x, b.h / 2, b.z);
      mesh.rotation.y = b.rot;
      mesh.castShadow = mesh.receiveShadow = true;
      worldGroup.add(mesh);
    }
  }

  // trees: batch with InstancedMesh for zero-lag rendering (pines vs palms)
  {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: T.night ? 0x1d4d2a : 0x2e6b34, roughness: 1, flatShading: true });
    const leafMat2 = new THREE.MeshStandardMaterial({ color: T.night ? 0x256b3a : 0x3d8040, roughness: 1, flatShading: true });
    const count = (W.trees && W.trees.length) || 0;

    if (count > 0) {
      if (T.palms) {
        const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 4.8, 6);
        const frondGeo = new THREE.PlaneGeometry(2.6, 0.6);
        const frondMat = new THREE.MeshStandardMaterial({ color: 0x2f8f3a, roughness: 1, side: THREE.DoubleSide, flatShading: true });

        const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
        const frondInst = new THREE.InstancedMesh(frondGeo, frondMat, count * 7);
        trunkInst.castShadow = true;
        frondInst.castShadow = true;

        const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), S = new THREE.Vector3(), P = new THREE.Vector3();
        let frondIdx = 0;

        W.trees.forEach((tr, i) => {
          Q.setFromAxisAngle(UP, tr.rot);
          S.set(tr.s, tr.s, tr.s);
          P.set(tr.x, 2.4 * tr.s, tr.z);
          M.compose(P, Q, S);
          trunkInst.setMatrixAt(i, M);

          for (let f = 0; f < 7; f++) {
            const fYaw = tr.rot + (f / 7) * PI2;
            const fPitch = 0.75;
            const fDist = 1.2 * tr.s;
            const fx = tr.x + Math.sin(fYaw) * fDist;
            const fz = tr.z + Math.cos(fYaw) * fDist;
            const fy = 4.8 * tr.s;

            const fRot = new THREE.Euler(fPitch, fYaw, 0, 'YXZ');
            const fQ = new THREE.Quaternion().setFromEuler(fRot);
            M.compose(new THREE.Vector3(fx, fy, fz), fQ, S);
            frondInst.setMatrixAt(frondIdx++, M);
          }
        });
        trunkInst.instanceMatrix.needsUpdate = true;
        frondInst.instanceMatrix.needsUpdate = true;
        worldGroup.add(trunkInst, frondInst);
      } else {
        const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1.7, 6);
        const cone1Geo = new THREE.ConeGeometry(1.9, 4.4, 7);
        const cone2Geo = new THREE.ConeGeometry(1.35, 3.1, 7);

        const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
        const cone1Inst = new THREE.InstancedMesh(cone1Geo, leafMat, count);
        const cone2Inst = new THREE.InstancedMesh(cone2Geo, leafMat2, count);
        trunkInst.castShadow = true;
        cone1Inst.castShadow = true;
        cone2Inst.castShadow = true;

        const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), S = new THREE.Vector3(), P = new THREE.Vector3();
        W.trees.forEach((tr, i) => {
          Q.setFromAxisAngle(UP, tr.rot);
          S.set(tr.s, tr.s, tr.s);

          P.set(tr.x, 0.85 * tr.s, tr.z);
          M.compose(P, Q, S);
          trunkInst.setMatrixAt(i, M);

          P.set(tr.x, 3.4 * tr.s, tr.z);
          M.compose(P, Q, S);
          cone1Inst.setMatrixAt(i, M);

          P.set(tr.x, 5.3 * tr.s, tr.z);
          M.compose(P, Q, S);
          cone2Inst.setMatrixAt(i, M);
        });
        trunkInst.instanceMatrix.needsUpdate = true;
        cone1Inst.instanceMatrix.needsUpdate = true;
        cone2Inst.instanceMatrix.needsUpdate = true;
        worldGroup.add(trunkInst, cone1Inst, cone2Inst);
      }
    }
  }

  // mountains / volcano
  {
    for (const mt of W.mountains) {
      const mat = new THREE.MeshStandardMaterial({
        color: mt.volcano ? 0x6a4a3a : (T.night ? 0x2a3040 : 0x8598ab), roughness: 1, flatShading: true });
      const mtn = new THREE.Mesh(new THREE.ConeGeometry(mt.r, mt.h, 5), mat);
      mtn.position.set(Math.cos(mt.t) * mt.dist, mt.h / 2 - 6, Math.sin(mt.t) * mt.dist);
      mtn.rotation.y = mt.rot;
      worldGroup.add(mtn);
      if (mt.volcano) {
        const lava = new THREE.Mesh(new THREE.ConeGeometry(mt.r * 0.25, mt.h * 0.12, 5),
          new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff3300, emissiveIntensity: 1.4 }));
        lava.position.set(Math.cos(mt.t) * mt.dist, mt.h - 8, Math.sin(mt.t) * mt.dist);
        worldGroup.add(lava);
      }
    }

    // on-track tire-stack hazards (visible, solid, stop the car)
    if (W.hazards) {
      const hzTire = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9 });
      const hzRed = new THREE.MeshStandardMaterial({ color: 0xc9302c, roughness: 0.8 });
      const hzGeo = new THREE.CylinderGeometry(0.75, 0.78, 0.34, 14);
      for (const hz of W.hazards) {
        for (let k = 0; k < 4; k++) {
          const tire = new THREE.Mesh(hzGeo, k % 2 === 1 ? hzRed : hzTire);
          tire.position.set(hz.x, 0.17 + k * 0.34, hz.z);
          tire.castShadow = true;
          worldGroup.add(tire);
        }
      }
    }
  }

  // curbs + barriers
  {
  if (map.type !== 'spline') { // v72: ellipse-only decor must never leak onto spline maps
    const curbGeo = new THREE.BoxGeometry(1.0, 0.07, 2.6);
    const curbR = new THREE.MeshStandardMaterial({ color: 0xc9302c, roughness: 0.55 });
    const curbW = new THREE.MeshStandardMaterial({ color: 0xefefea, roughness: 0.55 });
    for (const off of [RH + 0.6, -RH - 0.6]) {
      const ax = A + off, bz = B + off;
      const per = Math.PI * (3 * (ax + bz) - Math.sqrt((3 * ax + bz) * (ax + 3 * bz)));
      const N = Math.round(per / 2.5);
      const ir = new THREE.InstancedMesh(curbGeo, curbR, Math.ceil(N / 2));
      const iw = new THREE.InstancedMesh(curbGeo, curbW, Math.floor(N / 2));
      let ri = 0, wi = 0;
      for (let i = 0; i < N; i++) {
        const t = (i / N) * PI2;
        _iq.setFromAxisAngle(_iup, Math.atan2(-ax * Math.sin(t), bz * Math.cos(t)));
        _im.compose(new THREE.Vector3(ax * Math.cos(t), 0.045, bz * Math.sin(t)), _iq, new THREE.Vector3(1, 1, 1));
        if (i % 2 === 0) ir.setMatrixAt(ri++, _im); else iw.setMatrixAt(wi++, _im);
      }
      ir.receiveShadow = iw.receiveShadow = true;
      worldGroup.add(ir, iw);
    }
    const wallGeo = new THREE.BoxGeometry(0.5, 0.95, 2.7);
    const wallMat = new THREE.MeshStandardMaterial({ color: T.night ? 0x3a4050 : 0xb9bec4, roughness: 0.85 });
    const railGeo = new THREE.BoxGeometry(0.54, 0.14, 2.7);
    const railMat = new THREE.MeshStandardMaterial({ color: T.night ? 0x39d5ff : 0xc9302c, roughness: 0.6 });
    // walls sit just outside the physics barrier (RH+2.4) plus car half-width,
    // so the car scrapes the wall face instead of clipping through it
    for (const off of [RH + 3.65, -RH - 3.65]) {
      instancedAlong(wallGeo, wallMat, off, 2.6, 0.5);
      instancedAlong(railGeo, railMat, off, 2.6, 1.02);
    }
  }
  }

  // sponsor ad boards (neon at night)
  {
    const brands = [['#e10600', 'NITRO'], ['#0a84ff', 'APEX'], ['#ffb800', 'TURBO'], ['#111', 'SRIDHAR'], ['#00a651', 'RUSH'], ['#7b2ff7', 'NEON'], ['#ff6a00', 'DRIFT'], ['#003d8f', 'PIT LANE']];
    brands.forEach((b, i) => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = b[0]; g.fillRect(0, 0, 512, 128);
      g.fillStyle = '#fff'; g.font = '900 72px Arial Black, Arial'; g.textAlign = 'center';
      g.fillText(b[1], 256, 92);
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
      const t = (i / brands.length) * PI2 + 0.35;
      const off = RH + 6.8;
      let x, z; // v72: spline maps place boards along the exact curve, not the bounding ellipse
      if (map.ptAt) { const p = map.ptAt(t), n = map.normAt(t); x = p.x + n.x * off; z = p.z + n.z * off; }
      else { x = (A + off) * Math.cos(t); z = (B + off) * Math.sin(t); }
      const m = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.7 });
      if (T.night) { m.emissive = new THREE.Color(0xffffff); m.emissiveMap = tex; m.emissiveIntensity = 0.7; }
      const board = new THREE.Mesh(new THREE.PlaneGeometry(11, 2.7), m);
      board.position.set(x, 1.5, z);
      board.rotation.y = Math.atan2(-x, -z);
      worldGroup.add(board);
    });
  }

  // floodlights (bright at night)
  {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3c4046, metalness: 0.6, roughness: 0.5 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff6da, emissive: 0xfff0c0, emissiveIntensity: T.night ? 3.2 : 2.2 });
    for (let i = 0; i < 10; i++) {
      const t = (i / 10) * PI2;
      const off = RH + 10;
      let x, z; // v72 spline-aware
      if (map.ptAt) { const p = map.ptAt(t), n = map.normAt(t); x = p.x + n.x * off; z = p.z + n.z * off; }
      else { x = (A + off) * Math.cos(t); z = (B + off) * Math.sin(t); }
      const grp = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 8, 8), poleMat);
      pole.position.y = 4; pole.castShadow = true;
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.4), lampMat);
      head.position.y = 8;
      grp.add(pole, head);
      grp.position.set(x, 0, z);
      grp.rotation.y = Math.atan2(-x, -z);
      worldGroup.add(grp);
    }
  }

  if (!T.night) addClouds();
  buildRacingLine(map);
  applyWeather(currentWeather);
}

// v83 Dynamic Visual Ghost Racing Line Spline
let racingLineMesh = null;
function buildRacingLine(map) {
  if (racingLineMesh) {
    worldGroup.remove(racingLineMesh);
    disposeHierarchy(racingLineMesh);
    racingLineMesh = null;
  }
  if (prefs && prefs.racingLine === false) return;

  const points = [];
  const colors = [];
  const numSamples = 256;

  for (let i = 0; i <= numSamples; i++) {
    const u = i / numSamples;
    let x = 0, z = 0, curvature = 0;
    if (map && map.type === 'spline' && map.ptAt) {
      const th = u * PI2;
      const p = map.ptAt(th);
      const pPrev = map.ptAt((th - 0.05 + PI2) % PI2);
      const pNext = map.ptAt((th + 0.05) % PI2);
      x = p.x; z = p.z;
      const dx1 = p.x - pPrev.x, dz1 = p.z - pPrev.z;
      const dx2 = pNext.x - p.x, dz2 = pNext.z - p.z;
      const a1 = Math.atan2(dx1, dz1), a2 = Math.atan2(dx2, dz2);
      let da = Math.abs(a2 - a1); if (da > Math.PI) da = PI2 - da;
      curvature = da / 0.1;
    } else if (map) {
      const th = u * PI2;
      x = map.a * Math.cos(th);
      z = map.b * Math.sin(th);
      const a = map.a, b = map.b;
      curvature = (a * b) / Math.pow(Math.pow(a * Math.sin(th), 2) + Math.pow(b * Math.cos(th), 2), 1.5) * 50;
    }

    points.push(new THREE.Vector3(x, 0.065, z));

    const color = new THREE.Color();
    if (curvature > 1.2) {
      color.setHex(0xff2a4d); // Hard Braking Zone (Red)
    } else if (curvature > 0.6) {
      color.setHex(0xffd479); // Apex Entry / Turn In (Gold)
    } else if (curvature < 0.25) {
      color.setHex(0x00e5ff); // Nitro Surge Straightaway (Cyan)
    } else {
      color.setHex(0x00ff66); // Apex Exit Acceleration (Green)
    }
    colors.push(color.r, color.g, color.b);
  }

  const ribbonGeo = new THREE.BufferGeometry();
  const verts = [];
  const ribbonColors = [];
  const width = 0.45;

  for (let i = 0; i < points.length; i++) {
    const p0 = points[i];
    const pNext = points[(i + 1) % points.length];
    const dx = pNext.x - p0.x, dz = pNext.z - p0.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len * width, nz = dx / len * width;

    verts.push(p0.x - nx, p0.y, p0.z - nz);
    verts.push(p0.x + nx, p0.y, p0.z + nz);

    const r = colors[i * 3], g = colors[i * 3 + 1], b = colors[i * 3 + 2];
    ribbonColors.push(r, g, b);
    ribbonColors.push(r, g, b);
  }

  const indices = [];
  for (let i = 0; i < points.length - 1; i++) {
    const base = i * 2;
    indices.push(base, base + 1, base + 2);
    indices.push(base + 1, base + 3, base + 2);
  }
  ribbonGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  ribbonGeo.setAttribute('color', new THREE.Float32BufferAttribute(ribbonColors, 3));
  ribbonGeo.setIndex(indices);

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  racingLineMesh = new THREE.Mesh(ribbonGeo, mat);
  worldGroup.add(racingLineMesh);
}

// v83 Dynamic Weather Visuals
let currentWeather = 'dry';
function applyWeather(weatherId) {
  currentWeather = weatherId || 'dry';
  const cond = (CORE.WEATHER_CONDITIONS && CORE.WEATHER_CONDITIONS[currentWeather]) || {
    name: 'Dry Asphalt', gripMod: 1.0, icon: '☀️'
  };

  const wChip = $('hud-weather');
  if (wChip) {
    wChip.className = 'weather-chip ' + currentWeather;
    if (currentWeather === 'wet') {
      wChip.textContent = '🌧️ WET (0.92x GRIP)';
    } else if (currentWeather === 'blizzard') {
      wChip.textContent = '❄️ BLIZZARD (0.88x GRIP)';
    } else if (currentWeather === 'night') {
      wChip.textContent = '🌃 MIDNIGHT NEON';
    } else {
      wChip.textContent = '☀️ DRY ASPHALT';
    }
  }

  const wBtns = document.querySelectorAll('.weather-btn');
  wBtns.forEach(b => {
    b.classList.toggle('active', b.dataset.weather === currentWeather);
  });
}

// initial world
buildWorld(CORE.MAPS[0]);
camera.position.set(A - 3, 3.4, -14);

// ---------------------------------------------------------------------------
// Car visuals (unchanged)
// ---------------------------------------------------------------------------
function createCar(paintColor, num, accent) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const paint = new THREE.MeshPhysicalMaterial({ color: paintColor, metalness: 0.6, roughness: 0.2, clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 1.0 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0c1118, metalness: 0.9, roughness: 0.08, clearcoat: 1 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x101216, metalness: 0.5, roughness: 0.6 });
  const s = new THREE.Shape();
  s.moveTo(-2.30, 0.16); s.lineTo(-2.42, 0.62); s.lineTo(-2.28, 0.92); s.lineTo(-1.10, 0.98);
  s.lineTo(-0.45, 1.16); s.lineTo(0.30, 1.00); s.lineTo(1.25, 0.66); s.lineTo(2.25, 0.50);
  s.lineTo(2.40, 0.26); s.lineTo(2.30, 0.14); s.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(s, { depth: 1.56, bevelEnabled: true, bevelThickness: 0.16, bevelSize: 0.16, bevelSegments: 4, steps: 1, curveSegments: 6 });
  bodyGeo.translate(0, 0, -0.78); bodyGeo.rotateY(-Math.PI / 2);
  body.add(new THREE.Mesh(bodyGeo, paint));
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), glass);
  canopy.scale.set(0.78, 0.42, 1.45); canopy.position.set(0, 0.88, -0.35);
  body.add(canopy);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.06, 0.55), carbon);
  wing.position.set(0, 1.35, -2.25); wing.rotation.x = -0.12; body.add(wing);
  for (const sx of [-0.95, 0.95]) {
    const end = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.6), paint);
    end.position.set(sx, 1.38, -2.25); body.add(end);
  }
  for (const sx of [-0.55, 0.55]) {
    const stay = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.08), carbon);
    stay.position.set(sx, 1.1, -2.3); stay.rotation.x = 0.35; body.add(stay);
  }
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.05, 0.5), carbon);
  splitter.position.set(0, 0.10, 2.62); body.add(splitter);
  for (const sx of [-1, 1]) {
    const can = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.4), carbon);
    can.position.set(sx * 1.0, 0.45, 2.2); can.rotation.z = sx * 0.5; can.rotation.y = -sx * 0.2; body.add(can);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 3.4), carbon);
    skirt.position.set(sx * 0.95, 0.2, -0.1); body.add(skirt);
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.6), carbon);
    intake.position.set(sx * 0.95, 0.55, -1.1); body.add(intake);
  }
  const diff = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.06, 0.6), carbon);
  diff.position.set(0, 0.16, -2.55); diff.rotation.x = 0.4; body.add(diff);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: 0xffeeb0, emissiveIntensity: 2.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff1111, emissive: 0xff1111, emissiveIntensity: 1.9 });
  for (const sx of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.22), headMat);
    head.position.set(sx * 0.62, 0.58, 2.42); head.rotation.y = -sx * 0.35; head.rotation.z = sx * 0.12; body.add(head);
    const stay = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.05), carbon);
    stay.position.set(sx * 0.88, 0.93, 0.55); body.add(stay);
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.16), carbon);
    mir.position.set(sx * 0.97, 0.96, 0.55); body.add(mir);
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.5), carbon);
    vent.position.set(sx * 0.38, 0.86, 1.35); vent.rotation.x = 0.28; body.add(vent);
  }
  const tailBar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.05), tailMat);
  tailBar.position.set(0, 0.78, -2.62); body.add(tailBar);
  const exGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.3, 10); exGeo.rotateX(Math.PI / 2);
  const exMat = new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.95, roughness: 0.3 });
  for (const sx of [-0.35, 0.35]) { const ex = new THREE.Mesh(exGeo, exMat); ex.position.set(sx, 0.35, -2.6); body.add(ex); }
  const rc = document.createElement('canvas'); rc.width = rc.height = 128;
  const rg = rc.getContext('2d');
  rg.fillStyle = '#f4f4f4'; rg.beginPath(); rg.arc(64, 64, 62, 0, PI2); rg.fill();
  rg.strokeStyle = '#111'; rg.lineWidth = 6; rg.stroke();
  rg.fillStyle = '#111'; rg.font = '900 78px Arial Black, Arial'; rg.textAlign = 'center'; rg.textBaseline = 'middle';
  rg.fillText(String(num || 1), 64, 70);
  const rTex = new THREE.CanvasTexture(rc); rTex.encoding = THREE.sRGBEncoding;
  const rGeo = new THREE.CircleGeometry(0.32, 24);
  for (const sx of [-1, 1]) {
    const r = new THREE.Mesh(rGeo, new THREE.MeshStandardMaterial({ map: rTex, roughness: 0.5 }));
    r.rotation.y = sx * Math.PI / 2; r.position.set(sx * 0.95, 0.62, 0.35); body.add(r);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 3.6), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }));
    stripe.position.set(sx * 0.96, 0.32, -0.1); body.add(stripe);
  }
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 20); wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.31, 12); hubGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.92 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 0.9, roughness: 0.3 });
  const calMat = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.4 });
  const capGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.32, 10); capGeo.rotateZ(Math.PI / 2);
  const wheels = [];
  [[0.98, 1.45], [-0.98, 1.45], [0.98, -1.45], [-0.98, -1.45]].forEach(([x, z], i) => {
    const pivot = new THREE.Group(); pivot.position.set(x, 0.35, z);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(wheelGeo, wheelMat), new THREE.Mesh(hubGeo, hubMat), new THREE.Mesh(capGeo, calMat));
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 0.3), calMat);
    cal.position.set(x > 0 ? -0.16 : 0.16, 0, 0.24);
    pivot.add(spin, cal);
    g.add(pivot);
    wheels.push({ pivot, spin, front: i < 2 });
  });
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, body, wheels, paint, hubMat, calMat };
}
const carVisuals = {}; // v76: lazy up to 6
const SLOT_HEX = [0xe10600, 0x0a84ff, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7];
const SLOT_ACC = [0xffd400, 0xff2038, 0x111111, 0xffffff, 0x111111, 0xffffff];
function ensureCarVisual(s) {
  if (!carVisuals[s]) { carVisuals[s] = Object.assign(createCar(SLOT_HEX[(s - 1) % 6], s, SLOT_ACC[(s - 1) % 6]), { spinAngle: 0 }); scene.add(carVisuals[s].group); }
  return carVisuals[s];
}
ensureCarVisual(1); ensureCarVisual(2);

// ---------------------------------------------------------------------------
// ===========================================================================
// v61 TIME TRIAL / PRACTICE + personal-best ghost delta (extends existing ghost)
// ===========================================================================
const TT = { on: false, practice: false, lastCmp: 0, done: false };
function alongOf(x, z) {
  if (curMap && curMap.type === 'spline' && curMap.nearest) return curMap.nearest(x, z).along;
  if (curMap) return ((Math.atan2(z / curMap.b, x / curMap.a) / PI2) + 1) % 1;
  return 0;
}
let ghostCum = null;
function buildGhostCum() {
  ghostCum = null;
  if (!ghostData || !ghostData.length || !curMap) return;
  const cum = []; let lap = 0, prev = 0;
  for (const sm of ghostData) {
    const al = alongOf(sm[1], sm[2]);
    if (prev - al > 0.5) lap++;
    prev = al;
    cum.push({ d: lap + al, t: sm[0] });
  }
  ghostCum = cum;
}
function ghostDelta(myTotalAlong, raceT) {
  if (!ghostCum || !ghostCum.length) return null;
  let lo = 0, hi = ghostCum.length - 1;
  if (myTotalAlong <= ghostCum[0].d) return ghostCum[0].t - raceT;
  if (myTotalAlong >= ghostCum[hi].d) return ghostCum[hi].t - raceT;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ghostCum[m].d < myTotalAlong) lo = m; else hi = m; }
  const a = ghostCum[lo], b = ghostCum[hi];
  const f = (myTotalAlong - a.d) / Math.max(1e-6, b.d - a.d);
  return (a.t + (b.t - a.t) * f) - raceT;
}
function ttHudUpdate(mine) {
  const el = $('tt-hud'); if (!el) return;
  if (!TT.on || !latest || latest.state !== 'racing') { el.style.display = 'none'; return; }
  el.style.display = '';
  const nowT = performance.now();
  if (el._hz && nowT - el._hz < 100) return; // v66: 10 Hz, not per-frame
  el._hz = nowT;
  const mapId = (latest.map != null) ? latest.map : builtMapId;
  let pb = null; try { pb = JSON.parse(localStorage.getItem('sr_best_' + mapId) || 'null'); } catch (e) {}
  let line2 = pb != null ? 'PB ' + fmtTime(pb) : (TT.practice ? 'PRACTICE — no records' : 'PB —');
  let line3 = el.dataset.cmp || '';
  // v62 live current-lap vs best-lap
  if (mine && latest) {
    if (TT.lapNum !== mine.lap) { TT.lapNum = mine.lap; TT.lapStart = latest.raceTime; }
    const mId2 = (latest.map != null) ? latest.map : builtMapId;
    const bl2 = Pget().bestLap; const bestLapT = bl2 && bl2[mId2] != null ? bl2[mId2] : null;
    if (bestLapT != null) {
      const cur = (latest.raceTime || 0) - (TT.lapStart || 0);
      const dLap = cur - bestLapT;
      el.dataset.lap = 'LAP ' + Math.min((mine.lap || 0) + 1, CFG.totalLaps) + '/' + CFG.totalLaps + ' · ' + fmtTime(cur) + ' vs ⚡' + fmtTime(bestLapT) + ' (' + (dLap >= 0 ? '+' : '-') + Math.abs(dLap).toFixed(2) + ')';
    } else el.dataset.lap = 'LAP ' + Math.min((mine.lap || 0) + 1, CFG.totalLaps) + '/' + CFG.totalLaps;
  }
  if (!TT.practice && ghostCum && mine && performance.now() - TT.lastCmp > 1000) {
    TT.lastCmp = performance.now();
    const d = ghostDelta((mine.lap || 0) + (mine.pr || 0), latest.raceTime);
    if (d != null) {
      const laps2 = (latest && latest.laps) || CFG.totalLaps;
      const nearEnd = mine && ((mine.lap || 0) + (mine.pr || 0)) > (laps2 - 0.25);
      line3 = (d < 0 ? (nearEnd ? 'NEW BEST PACE 🟢' : '-' + Math.abs(d).toFixed(2) + 's AHEAD 🟢') : '+' + d.toFixed(2) + 's BEHIND 🔴');
    }
    el.dataset.cmp = line3;
  }
  el.innerHTML = '<div class="tt-time">' + fmtTime(latest.raceTime || 0) + '</div><div class="tt-pb">' + line2 + '</div>' + (el.dataset.lap ? '<div class="tt-pb">' + el.dataset.lap + '</div>' : '') + (line3 ? '<div class="tt-cmp">' + line3 + '</div>' : '');
}
function showTTResults(order, finalT) {
  const ov = $('tt-overlay'); if (!ov || TT.done) return;
  TT.done = true;
  const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
  const M = (CORE.MAPS[mapId] || {}).name || 'TRACK';
  let best = null; try { best = JSON.parse(localStorage.getItem('sr_best_' + mapId) || 'null'); } catch (e) {}
  const isRecord = !TT.practice && finalT != null && (best == null || finalT < best);
  const oldBest = best;
  if (isRecord) { try { localStorage.setItem('sr_best_' + mapId, JSON.stringify(finalT)); } catch (e) {} }
  if (finalT != null) { try { localStorage.setItem('sr_last_' + mapId, JSON.stringify(finalT)); } catch (e) {} } // v62 your-last
  const p = Pget();
  const bestLap = p.bestLap && p.bestLap[mapId] != null ? p.bestLap[mapId] : null;
  const box = $('tt-body');
  if (TT.practice) {
    box.innerHTML = '<h2>🎮 PRACTICE COMPLETE</h2><div class="tt-line">TRACK: <b>' + M + '</b></div>' +
      '<div class="tt-line">TIME: <b>' + (finalT != null ? fmtTime(finalT) : '—') + '</b></div>' +
      '<div class="tt-dim">No records submitted — keep learning!</div>';
  } else {
    box.innerHTML = '<h2>⏱️ TIME TRIAL — ' + M + '</h2>' +
      '<div class="tt-line">FINAL TIME: <b>' + (finalT != null ? fmtTime(finalT) : 'DNF') + '</b></div>' +
      '<div class="tt-line">PERSONAL BEST: <b>' + (isRecord ? fmtTime(finalT) : (best != null ? fmtTime(best) : '—')) + '</b></div>' +
      (bestLap != null ? '<div class="tt-line">BEST LAP: <b>' + fmtTime(bestLap) + '</b></div>' : '') +
      (isRecord && oldBest != null ? '<div class="pb-note">🏆 NEW RECORD! OLD ' + fmtTime(oldBest) + ' → NEW ' + fmtTime(finalT) + ' · ' + (finalT - oldBest).toFixed(2) + 's</div>' :
        (!isRecord && best != null && finalT != null ? '<div class="tt-cmp">+' + (finalT - best).toFixed(2) + 's off your best</div>' : ''));
    if (isRecord) toast('🏆 NEW PERSONAL RECORD!');
  }
  ov.classList.remove('hidden');
}
// Ghost (race your best lap) — OFF by default, purely visual, no physics.
// Records your lap positions from server snapshots; replays a translucent ghost.
// ---------------------------------------------------------------------------
let ghostGroup = null, ghostData = null, ghostRec = [], ghostRecOn = false, ghostRecT = 0;
let remoteGhost = null; // v41: a friend's ghost loaded from a ?g= link
function ensureGhost() {
  if (ghostGroup) return ghostGroup;
  ghostGroup = new THREE.Group();
  // v62: lightweight car-shaped silhouette (two boxes), still purely visual
  const gm = new THREE.MeshBasicMaterial({ color: 0x8fd7ff, transparent: true, opacity: 0.3, depthWrite: false });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.2), gm);
  body.position.y = 0.45;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.45, 1.8), gm);
  cab.position.set(0, 0.92, -0.3);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 0.5), gm);
  wing.position.set(0, 1.15, -2.0);
  ghostGroup.add(body, cab, wing);
  ghostGroup.visible = false; scene.add(ghostGroup);
  return ghostGroup;
}
function loadGhost(mapId) {
  ghostData = null;
  const mode = localStorage.getItem('sr_ghost_mode') || 'pb';
  if (mode === 'off') return;
  try {
    const g = JSON.parse(localStorage.getItem('sr_ghost_' + mapId) || 'null');
    if (g && g.length) ghostData = g;
  } catch (e) {}
}
let ghostIdx = 0; // v66
function ghostStart(mapId) {
  const mode = localStorage.getItem('sr_ghost_mode') || 'pb';
  ghostRec = []; ghostRecT = 0; ghostRecOn = (mode !== 'off' && (!!prefs.ghost || TT.on)); // v61: TT always records
  loadGhost(mapId);
  if (remoteGhost && remoteGhost.map === mapId) ghostData = remoteGhost.data; // friend's ghost wins over local
  const show = mode !== 'off' && !!ghostData && (!!prefs.ghost || !!remoteGhost || (TT.on && !TT.practice)); // v61 PB ghost in TT
  if (show) ensureGhost(); // lazy-create the ghost car (fix: it was never created before)
  if (ghostGroup) ghostGroup.visible = show;
  if (show) buildGhostCum(); // v61
  TT.lastCmp = 0; TT.done = false; TT.lapNum = null; TT.lapStart = 0; ghostIdx = 0; // v66 const th = $('tt-hud'); if (th) { th.dataset.cmp = ''; th.dataset.lap = ''; }
}
function ghostRecord(t, x, z, h) {
  if (!ghostRecOn) return;
  if (t - ghostRecT < 0.1) return; ghostRecT = t;
  if (ghostRec.length < 4000) ghostRec.push([+t.toFixed(2), +x.toFixed(2), +z.toFixed(2), +h.toFixed(2)]);
}
function ghostSave(mapId, isBest) {
  if (!ghostRecOn || ghostRec.length < 10) return;
  if (isBest) { try { localStorage.setItem('sr_ghost_' + mapId, JSON.stringify(ghostRec)); } catch (e) {} }
  ghostRecOn = false;
}
function ghostUpdate(raceTime) {
  const chip = $('ghost-gap-chip');
  if (!ghostGroup) {
    if (chip) chip.style.display = 'none';
    return;
  }
  if (!ghostData || (!prefs.ghost && !remoteGhost)) {
    ghostGroup.visible = false;
    if (chip) chip.style.display = 'none';
    return;
  }
  ghostGroup.visible = true;
  // v66 moving index: O(1) amortized instead of full scan per frame
  if (ghostIdx >= ghostData.length || ghostData[ghostIdx][0] > raceTime) ghostIdx = 0;
  while (ghostIdx < ghostData.length - 1 && ghostData[ghostIdx + 1][0] < raceTime) ghostIdx++;
  const s = ghostData[ghostIdx][0] <= raceTime ? ghostData[ghostIdx] : ghostData[ghostData.length - 1];
  ghostGroup.position.set(s[1], 0, s[2]); ghostGroup.rotation.y = s[3];

  // Live in-race ghost delta indicator
  if (chip && latest && latest.cars) {
    const mine = latest.cars.find((c) => (c.slot || c.s) === mySlot);
    if (mine && ghostCum) {
      const d = ghostDelta((mine.lap || 0) + (mine.pr || 0), raceTime);
      if (d != null && Math.abs(d) < 40 && latest.state === 'racing') {
        chip.style.display = 'block';
        const ahead = d < 0;
        chip.className = 'ghost-gap-chip ' + (ahead ? 'ahead' : 'behind');
        chip.textContent = '👻 GHOST: ' + (ahead ? '-' : '+') + Math.abs(d).toFixed(2) + 's ' + (ahead ? '⚡' : '🔻');
      } else {
        chip.style.display = 'none';
      }
    } else {
      chip.style.display = 'none';
    }
  }
}

// ---------------------------------------------------------------------------
// Particles (unchanged)
// ---------------------------------------------------------------------------
function radialTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const softTex = radialTexture();
const smokePool = [];
for (let i = 0; i < 80; i++) {
  const mat = new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0, depthWrite: false });
  const spr = new THREE.Sprite(mat); spr.visible = false; scene.add(spr);
  smokePool.push({ spr, mat, life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0 });
}
function spawnSmoke(x, z, vx, vz) {
  const p = smokePool.find((q) => q.life <= 0); if (!p) return;
  p.life = p.maxLife = 0.7 + Math.random() * 0.5;
  p.spr.position.set(x + (Math.random() - 0.5) * 0.4, 0.3, z + (Math.random() - 0.5) * 0.4);
  p.vx = vx * 0.22 + (Math.random() - 0.5) * 1.6; p.vz = vz * 0.22 + (Math.random() - 0.5) * 1.6;
  p.vy = 0.8 + Math.random() * 1.2;
  p.spr.scale.setScalar(0.9 + Math.random() * 0.6); p.spr.visible = true;
}
const sparkPool = [];
for (let i = 0; i < 60; i++) {
  const mat = new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffa640 });
  const spr = new THREE.Sprite(mat); spr.visible = false; scene.add(spr);
  sparkPool.push({ spr, mat, life: 0, vx: 0, vy: 0, vz: 0 });
}
function spawnSparks(x, z, strength) {
  const n = Math.round(6 + strength * 14);
  for (let i = 0; i < n; i++) {
    const p = sparkPool.find((q) => q.life <= 0); if (!p) return;
    p.life = 0.35 + Math.random() * 0.4;
    p.spr.position.set(x, 0.5 + Math.random() * 0.5, z);
    p.vx = (Math.random() - 0.5) * 14 * strength + 2; p.vz = (Math.random() - 0.5) * 14 * strength + 2;
    p.vy = 2 + Math.random() * 6 * strength;
    p.spr.scale.setScalar(0.22 + Math.random() * 0.3); p.spr.visible = true;
  }
}
const flamePool = [];
for (let i = 0; i < 50; i++) {
  const mat = new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x63b8ff });
  const spr = new THREE.Sprite(mat); spr.visible = false; scene.add(spr);
  flamePool.push({ spr, mat, life: 0 });
}
function spawnFlame(wp) {
  const p = flamePool.find((q) => q.life <= 0); if (!p) return;
  p.life = 0.14 + Math.random() * 0.08;
  p.spr.position.copy(wp); p.spr.scale.setScalar(0.5 + Math.random() * 0.5); p.spr.visible = true;
}

// v83 Weather particles: water spray, snow spray, falling rain, blizzard snow
const waterSprayPool = [];
for (let i = 0; i < 50; i++) {
  const mat = new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0, depthWrite: false, color: 0x88d4f5 });
  const spr = new THREE.Sprite(mat); spr.visible = false; scene.add(spr);
  waterSprayPool.push({ spr, mat, life: 0, maxLife: 0.5, vx: 0, vy: 0, vz: 0 });
}
function spawnWaterSpray(x, z, vx, vz) {
  const p = waterSprayPool.find((q) => q.life <= 0); if (!p) return;
  p.life = p.maxLife = 0.35 + Math.random() * 0.25;
  p.spr.position.set(x + (Math.random() - 0.5) * 0.3, 0.2, z + (Math.random() - 0.5) * 0.3);
  p.vx = vx * 0.15 + (Math.random() - 0.5) * 2.2; p.vz = vz * 0.15 + (Math.random() - 0.5) * 2.2;
  p.vy = 1.2 + Math.random() * 1.8;
  p.spr.scale.setScalar(0.7 + Math.random() * 0.5); p.spr.visible = true;
}

const snowSprayPool = [];
for (let i = 0; i < 50; i++) {
  const mat = new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0, depthWrite: false, color: 0xeef5fc });
  const spr = new THREE.Sprite(mat); spr.visible = false; scene.add(spr);
  snowSprayPool.push({ spr, mat, life: 0, maxLife: 0.6, vx: 0, vy: 0, vz: 0 });
}
function spawnSnowSpray(x, z, vx, vz) {
  const p = snowSprayPool.find((q) => q.life <= 0); if (!p) return;
  p.life = p.maxLife = 0.45 + Math.random() * 0.3;
  p.spr.position.set(x + (Math.random() - 0.5) * 0.3, 0.2, z + (Math.random() - 0.5) * 0.3);
  p.vx = vx * 0.1 + (Math.random() - 0.5) * 1.8; p.vz = vz * 0.1 + (Math.random() - 0.5) * 1.8;
  p.vy = 0.8 + Math.random() * 1.4;
  p.spr.scale.setScalar(0.6 + Math.random() * 0.5); p.spr.visible = true;
}

const RAIN_COUNT = 250;
const rainGeo = new THREE.BufferGeometry();
const rainPos = new Float32Array(RAIN_COUNT * 3);
for (let i = 0; i < RAIN_COUNT; i++) {
  rainPos[i * 3] = (Math.random() - 0.5) * 120;
  rainPos[i * 3 + 1] = Math.random() * 40;
  rainPos[i * 3 + 2] = (Math.random() - 0.5) * 120;
}
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rainMat = new THREE.PointsMaterial({ color: 0x90caf9, size: 0.4, transparent: true, opacity: 0.75, depthWrite: false });
const rainParticles = new THREE.Points(rainGeo, rainMat);
rainParticles.visible = false;
scene.add(rainParticles);

const SNOW_COUNT = 300;
const snowGeo = new THREE.BufferGeometry();
const snowPos = new Float32Array(SNOW_COUNT * 3);
for (let i = 0; i < SNOW_COUNT; i++) {
  snowPos[i * 3] = (Math.random() - 0.5) * 120;
  snowPos[i * 3 + 1] = Math.random() * 35;
  snowPos[i * 3 + 2] = (Math.random() - 0.5) * 120;
}
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snowMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.55, transparent: true, opacity: 0.85, depthWrite: false });
const snowParticles = new THREE.Points(snowGeo, snowMat);
snowParticles.visible = false;
scene.add(snowParticles);

function updateParticles(dt) {
  for (const p of smokePool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.spr.visible = false; p.mat.opacity = 0; continue; }
    p.spr.position.x += p.vx * dt; p.spr.position.y += p.vy * dt; p.spr.position.z += p.vz * dt;
    p.vx *= (1 - 1.6 * dt); p.vz *= (1 - 1.6 * dt);
    p.spr.scale.addScalar(dt * 3.2);
    p.mat.opacity = 0.34 * (p.life / p.maxLife);
  }
  for (const p of sparkPool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.spr.visible = false; p.mat.opacity = 0; continue; }
    p.spr.position.x += p.vx * dt; p.spr.position.y += p.vy * dt; p.spr.position.z += p.vz * dt;
    p.vy -= 22 * dt;
    if (p.spr.position.y < 0.05) { p.spr.position.y = 0.05; p.vy *= -0.4; }
    p.mat.opacity = Math.min(1, p.life * 3);
  }
  for (const p of flamePool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.spr.visible = false; p.mat.opacity = 0; continue; }
    p.mat.opacity = Math.min(1, p.life * 9);
  }
  for (const p of waterSprayPool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.spr.visible = false; p.mat.opacity = 0; continue; }
    p.spr.position.x += p.vx * dt; p.spr.position.y += p.vy * dt; p.spr.position.z += p.vz * dt;
    p.vy -= 9.8 * dt;
    p.spr.scale.addScalar(dt * 2.0);
    p.mat.opacity = 0.45 * (p.life / p.maxLife);
  }
  for (const p of snowSprayPool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.spr.visible = false; p.mat.opacity = 0; continue; }
    p.spr.position.x += p.vx * dt; p.spr.position.y += p.vy * dt; p.spr.position.z += p.vz * dt;
    p.vy -= 4.2 * dt;
    p.spr.scale.addScalar(dt * 1.5);
    p.mat.opacity = 0.5 * (p.life / p.maxLife);
  }

  // Update weather rain/snow relative to camera
  if (currentWeather === 'wet') {
    rainParticles.visible = true;
    snowParticles.visible = false;
    const pos = rainGeo.attributes.position.array;
    const cx = camera.position.x, cz = camera.position.z;
    for (let i = 0; i < RAIN_COUNT; i++) {
      pos[i * 3 + 1] -= dt * 48;
      if (pos[i * 3 + 1] < 0) {
        pos[i * 3] = cx + (Math.random() - 0.5) * 90;
        pos[i * 3 + 1] = 28 + Math.random() * 10;
        pos[i * 3 + 2] = cz + (Math.random() - 0.5) * 90;
      }
    }
    rainGeo.attributes.position.needsUpdate = true;
  } else if (currentWeather === 'blizzard') {
    rainParticles.visible = false;
    snowParticles.visible = true;
    const pos = snowGeo.attributes.position.array;
    const cx = camera.position.x, cz = camera.position.z;
    const t = performance.now() * 0.001;
    for (let i = 0; i < SNOW_COUNT; i++) {
      pos[i * 3] += Math.sin(t + i) * dt * 4 - dt * 6;
      pos[i * 3 + 1] -= dt * 14;
      pos[i * 3 + 2] += Math.cos(t + i) * dt * 3;
      if (pos[i * 3 + 1] < 0) {
        pos[i * 3] = cx + (Math.random() - 0.5) * 90;
        pos[i * 3 + 1] = 25 + Math.random() * 10;
        pos[i * 3 + 2] = cz + (Math.random() - 0.5) * 90;
      }
    }
    snowGeo.attributes.position.needsUpdate = true;
  } else {
    rainParticles.visible = false;
    snowParticles.visible = false;
  }
}
const SKID_MAX = 1000;
const skidGeo = new THREE.PlaneGeometry(0.26, 0.95); skidGeo.rotateX(-Math.PI / 2);
const skidMesh = new THREE.InstancedMesh(skidGeo, new THREE.MeshBasicMaterial({ color: 0x0c0d10, transparent: true, opacity: 0.5, depthWrite: false }), SKID_MAX);
skidMesh.count = 0; scene.add(skidMesh);
let skidIdx = 0;
const _sm = new THREE.Matrix4(), _sq = new THREE.Quaternion(), _sup = new THREE.Vector3(0, 1, 0);
function spawnSkid(x, z, heading) {
  if (Math.abs(CORE.radialDistToTrack(x, z, A, B).d) > RH + 0.5) return;
  _sq.setFromAxisAngle(_sup, heading);
  _sm.compose(new THREE.Vector3(x, 0.035 + (skidIdx % 4) * 0.0015, z), _sq, new THREE.Vector3(1, 1, 1));
  skidMesh.setMatrixAt(skidIdx % SKID_MAX, _sm);
  skidIdx++;
  skidMesh.count = Math.min(SKID_MAX, skidIdx);
  skidMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// v2: identity, settings, ping, FPS, leaderboard
// ---------------------------------------------------------------------------
let pingMs = -1;
let fps = 0, fpsFrames = 0, fpsTime = 0;
let selectedMap = 0;
let viewMode = 'race';
let lastResults = null;

const CAR_COLORS = [0xe10600, 0x0a84ff, 0xffd400, 0x00a651, 0xff6a00, 0x7b2ff7, 0xffffff, 0x111111];
const CAR_NAMES = [
  { e: '🔴', n: 'FURY' }, { e: '🔵', n: 'STORM' }, { e: '🟡', n: 'VOLT' }, { e: '🟢', n: 'VIPER' },
  { e: '🟠', n: 'BLAZE' }, { e: '🟣', n: 'PHANTOM' }, { e: '⚪', n: 'GHOST' }, { e: '⚫', n: 'REAPER' }
];

function loadPrefs() {
  try { return Object.assign({
    name: '', color: 0xe10600, cls: 'velocity', laps: 3, bot: true,
    quality: 'high', music: true, mute: false, fpsmeter: false, rm: false, cb: false, ar: true, ghost: false, racingLine: true, fx: true, lang: 'en', hdLobby: true
  }, JSON.parse(localStorage.getItem('sr_prefs') || '{}')); }
  catch (e) { return { name: '', color: 0xe10600, cls: 'velocity', laps: 3, bot: true, quality: 'high', music: true, mute: false, fpsmeter: false, racingLine: true }; }
}
let prefs = loadPrefs();
function savePrefs() { try { localStorage.setItem('sr_prefs', JSON.stringify(prefs)); } catch (e) {} }
// v45: brand-new visitors start vs the ROOKIE bot so their first race is winnable;
// returning players keep whatever they chose (PRO remains the historic bot).
try {
  if (!localStorage.getItem('sr_prefs') && prefs.botSkill == null) { prefs.botSkill = 0; savePrefs(); }
} catch (e) {}
if (prefs.botSkill == null) prefs.botSkill = 1;
// Account-lite: a stable player id persisted on this device, so returning
// players update one leaderboard entry instead of creating duplicates.
if (!prefs.pid) { prefs.pid = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); savePrefs(); }
if (!prefs.name) { prefs.name = 'RACER-' + prefs.pid.slice(1, 5).toUpperCase(); savePrefs(); }
let myEq = null; // v75 server-validated equipped loadout (null = guest/local prefs)
async function loadEquipped() {
  const acc = window.SRAccount;
  if (!(acc && acc.loggedIn && acc.loggedIn())) { myEq = null; return; }
  const r = await sbGet('/rest/v1/player_equipped?user_id=eq.' + acc.uid() + '&select=car,paint,wheels,trail,decal,neon,title');
  myEq = (r && r[0]) || null;
}
function identityPayload() {
  // v37: a signed-in racer uses their Supabase id, so times follow them across devices
  let name = prefs.name, pid = prefs.pid;
  if (window.SRAccount && SRAccount.loggedIn() && SRAccount.uid()) {
    pid = 'sb:' + SRAccount.uid();
    name = SRAccount.name() || prefs.name;
  }
  // v75: signed-in racers race with their server-validated garage loadout
  let color = prefs.color, cos = prefs.cos || { decal: 0, wheels: 0, trail: 0 }, title = playerTitle().title;
  if (myEq && window.SRCos) {
    const car = SRCos.findCar(myEq.car);
    const paint = SRCos.PAINTS[myEq.paint || 0] || SRCos.PAINTS[0];
    color = paint.hex;
    cos = { decal: myEq.decal || 0, wheels: myEq.wheels || 0, trail: myEq.trail || 0, neon: myEq.neon || 0, sp: car.sp };
    title = myEq.title || title;
  }
  return { name, pid, color, cls: prefs.cls, laps: prefs.laps, bot: prefs.bot, botSkill: prefs.botSkill, map: selectedMap, weather: currentWeather, cos, title, tok: (window.SRAccount && SRAccount.token && SRAccount.token()) || undefined, chid: window.__chId || undefined }; // v73/v74/v83
}

function applyQuality(q) {
  const dpr = window.devicePixelRatio || 1;
  if (q === 'low') { renderer.setPixelRatio(1); sunLight.castShadow = false; }
  else if (q === 'med') { renderer.setPixelRatio(Math.min(dpr, 1.5)); sunLight.castShadow = true; }
  else { renderer.setPixelRatio(Math.min(dpr, 2)); sunLight.castShadow = true; }
}

// ---------------------------------------------------------------------------
// FX: subtle cinematic bloom (neon glow) + CSS vignette. Graphics-only, fully
// additive: if anything fails it silently falls back to the normal renderer.
// Only active on HIGH quality and when the FX toggle is on (default: on).
// ---------------------------------------------------------------------------
let fxComposer = null, fxFailed = false, fxLoading = null;
function fxActive() { return prefs.fx !== false && prefs.quality === 'high'; }
// v41: bloom scripts load on demand (LOW/MED users never download/compile them)
function loadFxScripts() {
  if (THREE.EffectComposer && THREE.UnrealBloomPass) return Promise.resolve();
  if (fxLoading) return fxLoading;
  const files = ['CopyShader.js', 'LuminosityHighPassShader.js', 'EffectComposer.js', 'ShaderPass.js', 'RenderPass.js', 'UnrealBloomPass.js'];
  fxLoading = files.reduce((p, f) => p.then(() => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'js/vendor/post/' + f; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  })), Promise.resolve()).catch(() => { fxFailed = true; });
  return fxLoading;
}
function initFX() {
  try {
    if (!THREE.EffectComposer || !THREE.RenderPass || !THREE.UnrealBloomPass) return;
    const c = new THREE.EffectComposer(renderer);
    c.addPass(new THREE.RenderPass(scene, camera));
    // strength 0.5 / radius 0.7 / threshold 0.55 -> neon rails & lights glow, dark asphalt stays clean
    c.addPass(new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.7, 0.55));
    c.setSize(window.innerWidth, window.innerHeight);
    fxComposer = c;
  } catch (e) { fxComposer = null; fxFailed = true; }
}
function renderMain() {
  if (fxActive() && !fxFailed) {
    if (fxComposer) { fxComposer.render(); return; }
    loadFxScripts().then(initFX); // plain render until the pass is ready
  }
  renderer.render(scene, camera);
}

// audio: master mute + simple synth music loop
let musicNodes = null;
function setAudio() {
  if (audio && audio.master) audio.master.gain.value = prefs.mute ? 0 : 0.7;
  if (prefs.music && audio && !musicNodes) startMusic();
  if (!prefs.music && musicNodes) { stopMusic(); }
}
function startMusic() {
  if (!audio || musicNodes) return;
  const ctx = audio.ctx;
  const mg = ctx.createGain(); mg.gain.value = 0.085; mg.connect(audio.master);   // low background music
  const BPM = 118, SPB = 60 / BPM, EIGHTH = SPB / 2;
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const m2f = (m) => 440 * Math.pow(2, (m - 69) / 12);
  let step = 0, nextT = ctx.currentTime + 0.1;

  function note(freq, t, dur, type, vol) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(mg); o.start(t); o.stop(t + dur + 0.05);
  }
  function kick(t) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g); g.connect(mg); o.start(t); o.stop(t + 0.2);
  }
  function hat(t) {
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
    const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource(); s.buffer = b;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    s.connect(f); f.connect(g); g.connect(mg); s.start(t);
  }
  function scheduleStep(s, t) {
    const bar = Math.floor(s / 8) % 4;
    const e = s % 8;
    const ch = chords[bar];
    if (e % 2 === 0) kick(t);
    if (e % 2 === 1) hat(t);
    if (e % 2 === 0) note(m2f(ch[0] - 12), t, 0.22, 'sawtooth', 0.25);
    note(m2f(ch[[0, 1, 2, 1, 0, 2, 1, 2][e]] + 12), t, 0.16, 'square', 0.08);
    if (e === 0) ch.forEach((m) => note(m2f(m), t, SPB * 3.8, 'sawtooth', 0.05));
  }
  const timer = setInterval(() => {
    while (nextT < ctx.currentTime + 0.2) { scheduleStep(step, nextT); nextT += EIGHTH; step++; }
  }, 60);
  musicNodes = { g: mg, timer };
}
function stopMusic() { if (musicNodes) { clearInterval(musicNodes.timer); try { musicNodes.g.disconnect(); } catch (e) {} musicNodes = null; } }


function wireLobbyV2() {
  const nameEl = $('inp-name');
  if (nameEl) {
    nameEl.value = prefs.name;
    nameEl.placeholder = identityPayload().name;
    nameEl.addEventListener('input', () => { prefs.name = nameEl.value.trim(); savePrefs(); sendMeta(); });
  }
  buildCarCards();
  // two-page lobby navigation
  const p1 = $('page1'), p2 = $('page2');
  const nb = $('next-btn'), bb = $('back-btn');
  if (nb) nb.addEventListener('click', () => { p1.style.display = 'none'; p2.style.display = ''; buildCarCards(); });
  if (bb) bb.addEventListener('click', () => { p2.style.display = 'none'; p1.style.display = ''; });
  document.querySelectorAll('.cls-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.cls === prefs.cls);
    b.addEventListener('click', () => {
      prefs.cls = b.dataset.cls; savePrefs();
      document.querySelectorAll('.cls-btn').forEach((x) => x.classList.toggle('active', x === b));
      sendMeta();
      const fbtn = $('friends-btn'); if (fbtn) fbtn.hidden = !s;
      if (s) loadEquipped();
    });
  });
  document.querySelectorAll('.laps-btn').forEach((b) => {
    b.classList.toggle('active', parseInt(b.dataset.laps, 10) === prefs.laps);
    b.addEventListener('click', () => {
      prefs.laps = parseInt(b.dataset.laps, 10); savePrefs();
      document.querySelectorAll('.laps-btn').forEach((x) => x.classList.toggle('active', x === b));
      net.send({ type: 'laps', laps: prefs.laps });
    });
  });
  const botEl = $('bot-toggle');
  if (botEl) {
    botEl.checked = !!prefs.bot;
    botEl.addEventListener('change', () => { prefs.bot = botEl.checked; savePrefs(); net.send({ type: 'bot', bot: prefs.bot }); });
  }
  document.querySelectorAll('.q-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.q === prefs.quality);
    b.addEventListener('click', () => {
      prefs.quality = b.dataset.q; savePrefs();
      document.querySelectorAll('.q-btn').forEach((x) => x.classList.toggle('active', x === b));
      applyQuality(prefs.quality);
      applyHD();
    });
  });
  // v45 AI difficulty
  const bskBtns = [$('bsk-rookie'), $('bsk-pro')];
  const paintBsk = () => { if (bskBtns[0]) bskBtns[0].classList.toggle('active', !prefs.botSkill); if (bskBtns[1]) bskBtns[1].classList.toggle('active', !!prefs.botSkill); };
  bskBtns.forEach((b, i) => { if (b) b.addEventListener('click', () => { prefs.botSkill = i; savePrefs(); paintBsk(); sendMeta(); }); });
  paintBsk();
  // v61 mode selection
  document.querySelectorAll('.mode3-btn').forEach((b) => {
    b.classList.toggle('active', (prefs.mode3 || 'mp') === b.dataset.m3);
    b.addEventListener('click', () => {
      prefs.mode3 = b.dataset.m3; savePrefs();
      document.querySelectorAll('.mode3-btn').forEach((x) => x.classList.toggle('active', x === b));
      const bt = $('bot-toggle'); if (bt) bt.checked = prefs.mode3 === 'mp';
    });
  });
  // v59 garage — cosmetic-only customization
  if (!prefs.cos) { prefs.cos = { decal: 0, wheels: 0, trail: 0 }; savePrefs(); }
  document.querySelectorAll('.cos-btn').forEach((b) => {
    const k = b.dataset.cos; const v = parseInt(b.dataset.v, 10);
    b.classList.toggle('active', (prefs.cos[k] || 0) === v);
    b.textContent = b.dataset.label || b.textContent; if (!cosUnlocked(k, v)) b.textContent = '🔒' + b.textContent.replace('🔒', '');
    b.addEventListener('click', () => {
      if (!cosUnlocked(k, v)) { toast('🔒 Unlocks at level ' + UNLOCK_LVL[k][v]); return; }
      prefs.cos[k] = v; savePrefs();
      document.querySelectorAll('.cos-btn[data-cos="' + k + '"]').forEach((x) => x.classList.toggle('active', x === b));
      sendMeta();
      const fbtn = $('friends-btn'); if (fbtn) fbtn.hidden = !s;
      if (s) loadEquipped();
    });
  });
  const muteEl = $('set-mute'); if (muteEl) { muteEl.checked = !!prefs.mute; muteEl.addEventListener('change', () => { prefs.mute = muteEl.checked; savePrefs(); setAudio(); }); }
  const musicEl = $('set-music'); if (musicEl) { musicEl.checked = !!prefs.music; musicEl.addEventListener('change', () => { prefs.music = musicEl.checked; savePrefs(); ensureAudio(); setAudio(); }); }
  const fpsEl = $('set-fps'); if (fpsEl) { fpsEl.checked = !!prefs.fpsmeter; fpsEl.addEventListener('change', () => { prefs.fpsmeter = fpsEl.checked; savePrefs(); }); }
  const rmEl = $('set-rm'); if (rmEl) { rmEl.checked = !!prefs.rm; rmEl.addEventListener('change', () => { prefs.rm = rmEl.checked; savePrefs(); }); }
  const cbEl = $('set-cb'); if (cbEl) { cbEl.checked = !!prefs.cb; cbEl.addEventListener('change', () => { prefs.cb = cbEl.checked; savePrefs(); }); }
  const arEl = $('set-ar'); if (arEl) { arEl.checked = !!prefs.ar; arEl.addEventListener('change', () => { prefs.ar = arEl.checked; savePrefs(); }); }
  const ghEl = $('set-ghost'); if (ghEl) { ghEl.checked = !!prefs.ghost; ghEl.addEventListener('change', () => { prefs.ghost = ghEl.checked; savePrefs(); if (prefs.ghost) ensureGhost(); if (ghostGroup) ghostGroup.visible = false; updateLobbyGhostBtn(); }); }
  const rlEl = $('set-racing-line'); if (rlEl) { rlEl.checked = prefs.racingLine !== false; rlEl.addEventListener('change', () => { prefs.racingLine = rlEl.checked; savePrefs(); if (curMap) buildRacingLine(curMap); toast(prefs.racingLine ? '🏎️ Racing Line Spline ON' : '🏎️ Racing Line Spline OFF'); }); }
  const fxEl = $('set-fx'); if (fxEl) { fxEl.checked = prefs.fx !== false; fxEl.addEventListener('change', () => { prefs.fx = fxEl.checked; savePrefs(); }); }
  // v57 HD lobby: pure CSS skin inside the (race-hidden) lobby overlay; the art
  // file lazy-loads 1.2 s after window.load so it never competes with boot/race.
  const hdEl = $('set-hd');
  if (hdEl) { hdEl.checked = prefs.hdLobby !== false; hdEl.addEventListener('change', () => { prefs.hdLobby = hdEl.checked; savePrefs(); applyHD(); }); }

  // v83 Weather Selection in Wizard
  document.querySelectorAll('.weather-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const w = b.dataset.weather;
      applyWeather(w);
      net.send({ type: 'weather', weather: w });
      toast(`Weather set to: ${w.toUpperCase()}`);
    });
  });

  // v83 Racing Syndicate Crews button & modal wiring
  const crewBtn = $('crew-btn');
  if (crewBtn) crewBtn.addEventListener('click', () => openCrewModal('my'));
  const crewClose = $('crew-close');
  if (crewClose) crewClose.addEventListener('click', () => { $('crew-dlg').hidden = true; });
  ['my', 'join', 'create', 'board'].forEach((t) => {
    const cTabBtn = $(`ctab-${t}`);
    if (cTabBtn) cTabBtn.addEventListener('click', () => openCrewModal(t));
  });

  // v81 Competitive Retention lobby buttons
  const rivalBtn = $('lcomp-rival-btn');
  if (rivalBtn) rivalBtn.addEventListener('click', () => { const qb = $('quickplay-btn'); if (qb) qb.click(); });
  const ghTogBtn = $('lobby-ghost-toggle-btn');
  function updateLobbyGhostBtn() {
    if (ghTogBtn) ghTogBtn.textContent = prefs.ghost ? '👻 GHOST: ON' : '👻 GHOST: OFF';
    const sGh = $('set-ghost'); if (sGh) sGh.checked = !!prefs.ghost;
  }
  if (ghTogBtn) {
    updateLobbyGhostBtn();
    ghTogBtn.addEventListener('click', () => {
      prefs.ghost = !prefs.ghost;
      savePrefs();
      updateLobbyGhostBtn();
      if (prefs.ghost) ensureGhost();
      if (ghostGroup) ghostGroup.visible = false;
      toast(prefs.ghost ? '👻 Ghost enabled for Time Attack' : '👻 Ghost disabled');
    });
  }
  const s1Btn = $('lobby-season-btn');
  if (s1Btn) {
    s1Btn.addEventListener('click', () => {
      const wTab = $('board-tab-weekly');
      if (wTab) wTab.click();
      const hub = $('comp-hub');
      if (hub) hub.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // ---- optional racer account (Supabase, v37) — purely additive ------------
  (function () {
    const line = $('account-line'); if (!line) return;
    if (!(window.SRAccount && SRAccount.available())) return;
    line.hidden = false;
    const chip = $('account-chip'), btn = $('account-btn'), out = $('account-out'), dlg = $('account-dlg');
    function paint(s) {
      if (s) { chip.textContent = '👤 ' + (s.name || (s.email || 'racer').split('@')[0]); btn.hidden = true; out.hidden = false; }
      else { chip.textContent = '👤 guest'; btn.hidden = false; out.hidden = true; }
      sendMeta();
      const fbtn = $('friends-btn'); if (fbtn) fbtn.hidden = !s;
      if (s) loadEquipped();
    }
    SRAccount.session().then((s) => { if (s && !SRAccount.name() && s.email) SRAccount.setName(s.email.split('@')[0]); paint(s); });
    btn.addEventListener('click', () => { dlg.hidden = false; $('acc-err').textContent = ''; });
    $('acc-close').addEventListener('click', () => { dlg.hidden = true; });
    out.addEventListener('click', () => { SRAccount.logout(); paint(null); toast('Signed out'); });
    function doIt(fn) {
      const err = $('acc-err'); err.textContent = '…';
      const em = $('acc-email').value.trim(), pw = $('acc-pass').value;
      const nm = ($('acc-name').value.trim() || prefs.name).slice(0, 14);
      fn(em, pw, nm).then(async (r) => {
        if (r.error === 'CHECK_EMAIL') { err.textContent = r.msg; return; }
        if (r.error) { err.textContent = r.error === 'NETWORK' ? 'Network error — try again.' : r.error; return; }
        if (!SRAccount.name()) SRAccount.setName(nm);
        // v73: bind a unique username to the account (server-validated by DB)
        const un = (nm || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16) || ('RACER_' + Math.floor(Math.random() * 9999));
        const pr = await SRAccount.ensureProfile(un);
        if (pr && pr.error === 'TAKEN') toast('⚠ Username taken — using a variant. Change it in your profile soon.');
        dlg.hidden = true;
        paint(await SRAccount.session());
        toast('Welcome, ' + un + '! 🏁');
      });
    }
    $('acc-signup').addEventListener('click', () => doIt((e, p, n) => SRAccount.signup(e, p, n)));
    $('acc-login').addEventListener('click', () => doIt((e, p) => SRAccount.login(e, p)));
  })();
  // ---------------------------------------------------------------------------
// v74/v80 — friends, challenges, shareable results, profile league/achievements
// ---------------------------------------------------------------------------
function parseGuestChallenge(urlSearch = location.search) {
  try {
    const u = new URLSearchParams(urlSearch);
    const pch = u.get('pch') || (u.get('ch') && !/^\d+$/.test(u.get('ch')) ? u.get('ch') : null);
    if (!pch) return null;
    let m = pch.match(/^(?:m)?([0-4])_(?:t)?(\d{3,7})_(.+)$/i);
    if (!m) m = pch.match(/(?:map:)?([0-4]):(?:t:)?(\d{3,7}):(?:name:)?(.+)/i);
    if (!m) return null;
    const map = parseInt(m[1], 10);
    const targetMs = parseInt(m[2], 10);
    const name = decodeURIComponent(m[3]).replace(/[<>]/g, '').trim().slice(0, 14) || 'A RACER';
    if (isNaN(map) || map < 0 || map > 4) return null;
    if (isNaN(targetMs) || targetMs < 1000 || targetMs > 600000) return null;
    return { map, targetMs, name, verified: false };
  } catch (e) {
    return null;
  }
}

function renderChallengeBanner(ch) {
  const b = $('challenge-banner');
  if (!b || !ch) return;
  const badge = $('ch-badge'), msg = $('ch-msg'), note = $('ch-note'), cta = $('ch-accept-btn');
  const M = (CORE.MAPS[ch.map] || {}).name || 'Circuit';
  const tStr = ch.targetMs ? fmtTime(ch.targetMs / 1000) : null;

  if (ch.verified) {
    if (badge) { badge.textContent = '🏆 VERIFIED CHALLENGE'; badge.className = 'ch-badge'; }
    if (msg) msg.textContent = `🔥 ${ch.name} challenges you${tStr ? ' to beat ' + tStr : ''} on ${M}!`;
    if (note) note.textContent = 'Official Supabase challenge • Win to claim rating & record';
  } else {
    if (badge) { badge.textContent = '🔥 PERSONAL CHALLENGE'; badge.className = 'ch-badge unverified'; }
    if (msg) msg.textContent = `⚔️ ${ch.name} wants you to beat ${tStr || 'their time'} on ${M}`;
    if (note) note.textContent = 'Personal challenge • Not a verified leaderboard result';
  }
  b.style.display = '';
  if (cta) {
    cta.onclick = () => {
      b.style.display = 'none';
      selectedMap = ch.map;
      const sb = $('start-btn'); if (sb) sb.click();
    };
  }
}

(function () {
  const numId = (location.search.match(/[?&]ch=(\d+)/) || [])[1];
  if (numId) {
    window.__chId = numId;
    (async () => {
      const ch = await sbGet('/rest/v1/challenges?id=eq.' + numId + '&select=from_name,map,mode,laps,target_ms,status');
      if (ch && ch[0] && ch[0].status === 'open') {
        selectedMap = ch[0].map;
        window.__activeChallenge = { map: ch[0].map, targetMs: ch[0].target_ms, name: ch[0].from_name, verified: true };
        renderChallengeBanner(window.__activeChallenge);
        track('ch_accept', ch[0].map, { chId: numId });
      }
    })();
    return;
  }

  const guestCh = parseGuestChallenge(location.search);
  if (guestCh) {
    window.__guestChallenge = guestCh;
    window.__activeChallenge = guestCh;
    selectedMap = guestCh.map;
    renderChallengeBanner(guestCh);
    track('ch_accept', guestCh.map, { guest: true });
  }
})();
async function createChallenge(targetMs, toUid) { // v78: toUid enables friend accept/decline
  const acc = window.SRAccount;
  if (!(acc && acc.loggedIn())) { toast('Sign in to create verified challenges'); const b = $('account-btn'); if (b) b.click(); return null; }
  const c = sbCfg(); if (!c.url) return null;
  try {
    const r = await fetch(c.url + '/rest/v1/challenges', {
      method: 'POST',
      headers: { apikey: c.anon, Authorization: 'Bearer ' + acc.token(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify([{ from_uid: acc.uid(), from_name: acc.name() || 'A RACER', map: selectedMap, mode: 'race', laps: prefs.laps || 1, target_ms: targetMs ? Math.round(targetMs * 1000) : null, to_uid: toUid || null }]),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const chId = j && j[0] ? j[0].id : null;
    if (chId) track('ch_send', selectedMap, { chId, targetMs, toUid: !!toUid });
    return chId;
  } catch (e) { return null; }
}
async function generateShareLink(myTime) {
  const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
  const acc = window.SRAccount;
  if (acc && acc.loggedIn() && myTime) {
    try {
      const id = await createChallenge(myTime);
      if (id) return { link: `${location.origin}/?ch=${id}`, verified: true };
    } catch (e) {}
  }
  const safeName = encodeURIComponent((prefs.name || 'A RACER').slice(0, 14));
  const targetMs = myTime ? Math.round(myTime * 1000) : 0;
  return { link: `${location.origin}/?pch=${mapId}_${targetMs}_${safeName}`, verified: false };
}
function copyChallengeLink(id, name, targetMs) {
  const M = (CORE.MAPS[selectedMap] || {}).name || 'a circuit';
  const msg = '🔥 ' + (name || 'A RACER') + ' challenged you' + (targetMs ? ' to beat ' + fmtTime(targetMs) : '') + ' on ' + M + '.\n' + location.origin + '/?ch=' + id;
  copyText(msg); toast('⚔️ Challenge link copied — send it!');
}
function openFriends() {
  const dlg = $('friends-dlg'); if (!dlg) return;
  dlg.hidden = false;
  const body = $('friends-body');
  const acc = window.SRAccount;
  if (!(acc && acc.loggedIn())) { body.innerHTML = '<div class="p-empty">Sign in to add friends, send challenges and build rivalries.</div>'; return; }
  const uid = acc.uid(), tok = acc.token();
  body.innerHTML = '<div class="p-empty">Loading…</div>';
  (async () => {
    const [mine, reqs] = await Promise.all([
      sbGet('/rest/v1/friends?or=(from_uid.eq.' + uid + ',to_uid.eq.' + uid + ')&status=eq.accepted&select=from_uid,to_uid', tok),
      sbGet('/rest/v1/friends?to_uid=eq.' + uid + '&status=eq.pending&select=id,from_uid', tok),
    ]);
    const fids = [];
    (mine || []).forEach((f) => fids.push(f.from_uid === uid ? f.to_uid : f.from_uid));
    let names = {};
    if (fids.length) { const p = await sbGet('/rest/v1/profiles?' + fids.map((f) => 'id=eq.' + f).join('&') + '&select=id,username'); (p || []).forEach((x) => { names[x.id] = x.username; }); }
    let html = '<div class="f-row"><input id="f-search" class="f-in" placeholder="search username…" maxlength="16"/><button id="f-add" class="ghost sm">ADD</button></div>';
    // v78 incoming challenges (accept/decline allowed by RLS "ch answer")
    const week = Date.now() - 7 * 86400000;
    const inch = await sbGet('/rest/v1/challenges?to_uid=eq.' + uid + '&status=eq.open&select=id,from_name,map,target_ms,created_at', tok);
    const live = (inch || []).filter((x) => new Date(x.created_at).getTime() > week);
    if (live.length) {
      html += '<div class="p-sub">⚔️ CHALLENGES FOR YOU</div>';
      live.forEach((x) => {
        html += '<div class="f-item"><span>🔥 ' + escapeHtml(x.from_name) + ' · ' + escapeHtml(((CORE.MAPS[x.map] || {}).name || 'CIRCUIT')) + (x.target_ms ? ' · beat ' + fmtTime(x.target_ms / 1000) : '') + '</span><span><button class="ghost sm ch-acc" data-id="' + x.id + '">✔</button> <button class="ghost sm ch-rej" data-id="' + x.id + '">✖</button></span></div>';
      });
    }
    if (reqs && reqs.length) {
      html += '<div class="p-sub">REQUESTS</div>';
      const rids = reqs.map((r) => 'id=eq.' + r.from_uid).join('&');
      const rp = await sbGet('/rest/v1/profiles?' + rids + '&select=id,username');
      const rn = {}; (rp || []).forEach((x) => { rn[x.id] = x.username; });
      reqs.forEach((r) => { html += '<div class="f-item"><span>' + escapeHtml(rn[r.from_uid] || 'RACER') + '</span><span><button class="ghost sm f-acc" data-id="' + r.id + '">✔</button> <button class="ghost sm f-rej" data-id="' + r.id + '">✖</button></span></div>'; });
    }
    html += '<div class="p-sub">FRIENDS</div>';
    if (!fids.length) html += '<div class="p-empty">No friends yet — search a username above.</div>';
    fids.forEach((f) => { html += '<div class="f-item"><span>' + escapeHtml(names[f] || 'RACER') + '</span><button class="ghost sm f-ch" data-uid="' + f + '" data-name="' + escapeHtml(names[f] || 'RACER') + '">⚔️ CHALLENGE</button></div>'; });
    body.innerHTML = html;
    $('f-add').addEventListener('click', async () => {
      const q = $('f-search').value.trim();
      const p = await sbGet('/rest/v1/profiles?username=ilike.' + encodeURIComponent(q) + '&select=id,username&limit=5');
      if (!p || !p.length) { toast('No racer named ' + q); return; }
      const t = p.find((x) => x.username.toLowerCase() === q.toLowerCase()) || p[0];
      if (t.id === uid) { toast('That is you 🙂'); return; }
      const c = sbCfg();
      const r = await fetch(c.url + '/rest/v1/friends', { method: 'POST', headers: { apikey: c.anon, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ from_uid: uid, to_uid: t.id }) });
      toast(r.ok ? '✉️ Request sent to ' + t.username : 'Request failed (already friends?)');
      openFriends();
    });
    body.querySelectorAll('.ch-acc').forEach((b) => b.addEventListener('click', async () => { const c = sbCfg(); await fetch(c.url + '/rest/v1/challenges?id=eq.' + b.dataset.id, { method: 'PATCH', headers: { apikey: c.anon, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'accepted' }) }); toast('⚔️ Challenge accepted — race!'); location.href = location.origin + '/?ch=' + b.dataset.id; }));
    body.querySelectorAll('.ch-rej').forEach((b) => b.addEventListener('click', async () => { const c = sbCfg(); await fetch(c.url + '/rest/v1/challenges?id=eq.' + b.dataset.id, { method: 'PATCH', headers: { apikey: c.anon, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'declined' }) }); openFriends(); }));
    body.querySelectorAll('.f-acc').forEach((b) => b.addEventListener('click', async () => { const c = sbCfg(); await fetch(c.url + '/rest/v1/friends?id=eq.' + b.dataset.id, { method: 'PATCH', headers: { apikey: c.anon, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'accepted' }) }); openFriends(); }));
    body.querySelectorAll('.f-rej').forEach((b) => b.addEventListener('click', async () => { const c = sbCfg(); await fetch(c.url + '/rest/v1/friends?id=eq.' + b.dataset.id, { method: 'PATCH', headers: { apikey: c.anon, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'rejected' }) }); openFriends(); }));
    body.querySelectorAll('.f-ch').forEach((b) => b.addEventListener('click', async () => {
      const id = await createChallenge(null, b.dataset.uid);
      if (id) copyChallengeLink(id, b.dataset.name || 'A RACER', null);
    }));
  })();
}
// ---------------------------------------------------------------------------
// v75 — GARAGE: collection, customization, coin shop (server-validated)
// ---------------------------------------------------------------------------
function garageData() {
  return (async () => {
    const acc = window.SRAccount;
    if (!(acc && acc.loggedIn())) return null;
    const uid = acc.uid();
    const [st, w, inv] = await Promise.all([
      sbGet('/rest/v1/player_stats?user_id=eq.' + uid + '&select=xp,wins,rating'),
      sbGet('/rest/v1/player_wallet?user_id=eq.' + uid + '&select=coins', acc.token()),
      sbGet('/rest/v1/player_inventory?user_id=eq.' + uid + '&select=item_id', acc.token()),
    ]);
    const s0 = (st && st[0]) || {};
    return {
      d: { level: (window.SRProg ? SRProg.levelFromXp(Number(s0.xp) || 0).level : 1), wins: s0.wins || 0, rating: s0.rating || 1000, owned: (inv || []).map((x) => x.item_id) },
      coins: (w && w[0] && Number(w[0].coins)) || 0
    };
  })();
}
function openGarage() {
  const dlg = $('garage-dlg'); if (!dlg) return;
  dlg.hidden = false;
  const body = $('garage-body');
  const acc = window.SRAccount;
  if (!(acc && acc.loggedIn())) { body.innerHTML = '<div class="p-empty">Sign in to open your garage — cars, paints, neon and more unlock as you race.</div>'; return; }
  body.innerHTML = '<div class="p-empty">Opening garage…</div>';
  (async () => {
    const gd = await garageData();
    if (!gd) return;
    const { d, coins } = gd;
    const eq = myEq || { car: 'street_runner', paint: 0, wheels: 0, trail: 0, decal: 0, neon: 0 };
    let html = '<div class="g-head">🪙 <b>' + coins + '</b> RUSH COINS <span class="g-hint">earn coins by racing · dailies · wins</span></div>';
    html += '<div class="p-sub">MY CARS</div><div class="g-cars">';
    for (const c of (window.SRCos ? SRCos.CARS : [])) {
      const un = SRCos.itemUnlocked(c.unlock, d, 'car:' + c.id);
      const sel = eq.car === c.id;
      html += '<div class="g-car' + (sel ? ' sel' : '') + '" style="border-color:' + (un ? SRCos.RARITY[c.rarity] : '#232c47') + '">' +
        '<div class="g-cn" style="color:' + SRCos.RARITY[c.rarity] + '">' + c.name + '</div>' +
        '<div class="g-cr">' + c.rarity.toUpperCase() + '</div>' +
        '<div class="g-bars">' + c.bars.map((b) => '<i style="width:' + (b * 10) + '%"></i>').join('') + '</div>' +
        (sel ? '<div class="g-st">SELECTED</div>' : un ? '<button class="ghost sm g-eq" data-car="' + c.id + '">SELECT</button>' : '<div class="g-lock">🔒 ' + SRCos.unlockText(c.unlock) + '</div>') +
        '</div>';
    }
    html += '</div>';
    const sect = (title, list, kind) => {
      let h = '<div class="p-sub">' + title + '</div><div class="g-items">';
      for (const it of list) {
        const un = SRCos.itemUnlocked(it.unlock, d, kind + ':' + it.id);
        const cur = eq[kind === 'paint' ? 'paint' : kind] === it.id;
        h += '<button class="g-it' + (cur ? ' sel' : '') + '" data-kind="' + kind + '" data-id="' + it.id + '" ' + (!un ? '' : '') + '>' +
          (it.hex != null ? '<i class="sw" style="background:#' + it.hex.toString(16).padStart(6, '0') + '"></i>' : '') +
          '<span>' + it.name + '</span>' +
          (cur ? '<em>✔</em>' : un ? '' : '<em class="lk">🔒 ' + SRCos.unlockText(it.unlock) + '</em>') + '</button>';
      }
      return h + '</div>';
    };
    html += sect('PAINT', SRCos.PAINTS, 'paint') + sect('WHEELS', SRCos.WHEELS, 'wheels') + sect('TRAILS', SRCos.TRAILS, 'trail') + sect('DECALS', SRCos.DECALS, 'decal') + sect('NEON', SRCos.NEONS, 'neon');
    body.innerHTML = html;
    body.querySelectorAll('.g-eq').forEach((b) => b.addEventListener('click', () => {
      net.send({ type: 'equip', eq: Object.assign({}, eq, { car: b.dataset.car }) });
    }));
    body.querySelectorAll('.g-it').forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.kind, id = parseInt(b.dataset.id, 10);
      const list = kind === 'paint' ? SRCos.PAINTS : kind === 'wheels' ? SRCos.WHEELS : kind === 'trail' ? SRCos.TRAILS : kind === 'decal' ? SRCos.DECALS : SRCos.NEONS;
      const it = list.find((x) => x.id === id);
      if (!it) return;
      if (!SRCos.itemUnlocked(it.unlock, d, kind + ':' + id)) {
        if (SRCos.isCoinItem(it.unlock)) { net.send({ type: 'buy', item: kind + ':' + id }); }
        else toast('🔒 ' + SRCos.unlockText(it.unlock));
        return;
      }
      net.send({ type: 'equip', eq: Object.assign({}, eq, { [kind]: id }) });
    }));
  })();
}
// v76 — room lobby panel (players / rating / ready / host)
let iAmReady = false;
function renderRoomLobby(e) {
  const el = $('room-players'); if (!el) return;
  const ps = e.players || [];
  $('room-count') && ($('room-count').textContent = ps.length + ' / ' + (e.cap || 6) + ' PLAYERS');
  el.innerHTML = ps.map((p) => {
    const crewBadge = p.crewTag ? `<span class="syndicate-tag">[${escapeHtml(p.crewTag)}]</span> ` : '';
    return '<div class="rp-row' + (p.slot === mySlot ? ' me' : '') + '"><span class="rp-slot">' + p.slot + '</span>' +
      '<span class="rp-name">' + crewBadge + escapeHtml(p.name) + (p.host ? ' 👑' : '') + '</span>' +
      '<span class="rp-rating">' + (p.rating != null ? p.rating : '—') + '</span>' +
      '<span class="rp-ready ' + (p.ready ? 'on' : '') + '">' + (p.ready ? 'READY' : 'NOT READY') + '</span></div>';
  }).join('') +
    (ps.length < (e.cap || 6) ? '<div class="rp-row empty"><span class="rp-slot">·</span><span class="rp-name dim">open slot — share the code</span></div>' : '');
  const rb = $('ready-btn');
  if (rb) { rb.hidden = ps.length < 3; rb.textContent = iAmReady ? '✅ READY' : '🏁 READY UP'; }
}
// v73 wiring: profile / ratings access points
(function () {
  const pc = $('profile-close'); if (pc) pc.addEventListener('click', () => { const d = $('profile-dlg'); if (d) d.hidden = true; });
  const fb = $('friends-btn'); if (fb) fb.addEventListener('click', openFriends);
  const gb = $('garage-btn'); if (gb) gb.addEventListener('click', openGarage);
  const rbtn = $('ready-btn'); if (rbtn) rbtn.addEventListener('click', () => { iAmReady = !iAmReady; net.send({ type: 'ready', on: iAmReady }); renderRoomLobby({ players: window.__lastLobby || [], cap: 6 }); });
  const gc = $('garage-close'); if (gc) gc.addEventListener('click', () => { const d = $('garage-dlg'); if (d) d.hidden = true; });
  const fc = $('friends-close'); if (fc) fc.addEventListener('click', () => { const d = $('friends-dlg'); if (d) d.hidden = true; });
})();
function showRatingTab() {
  compActiveTab = 'rate';
  loadCompetitiveHub();
  const setup = $('setup'); if (setup) setup.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
const tc = $('tut-close'); if (tc) tc.addEventListener('click', () => { $('tutorial').style.display = 'none'; try { localStorage.setItem('sr_tut', '1'); } catch (e) {} });

async function shareChallengeAction(channel = 'challenge') {
  if (!lastResults) return;
  const my = lastResults.find((c) => (c.slot || c.s) === mySlot);
  const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
  const mapName = (CORE.MAPS[mapId] || {}).name || 'Circuit';
  const myTime = (my && my.t != null) ? my.t : null;
  const timeStr = myTime != null ? fmtTime(myTime) : 'DNF';

  const { link, verified } = await generateShareLink(myTime);
  const rName = (prefs.name || 'A RACER').slice(0, 14);
  const msg = `🔥 ${rName} challenged you to beat ${timeStr} on ${mapName}!\nCan you beat my time? Race now: ${link}`;

  track('share', mapId, { channel, verified });
  if (navigator.share) {
    navigator.share({ text: msg }).catch(() => {});
  } else {
    copyText(msg);
    toast('⚔️ Challenge link copied — send it to a friend!');
  }
}

async function shareResultCardAction() {
  if (!lastResults) return;
  const my = lastResults.find((c) => (c.slot || c.s) === mySlot);
  const pos = lastResults.indexOf(my) + 1;
  const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
  const mapName = (CORE.MAPS[mapId] || {}).name || 'Circuit';
  const row = (pendingSettle || []).find((r) => r.slot === mySlot);
  const myTime = (my && my.t != null) ? my.t : null;
  const { link } = await generateShareLink(myTime);

  const card = '🏁 SRIDHAR RUSH\n' + (pos === 1 ? '1st PLACE' : 'P' + pos) +
               '\nMAP: ' + mapName +
               '\nTIME: ' + (myTime != null ? fmtTime(myTime) : 'DNF') +
               (row ? '\nRATING: ' + (row.rd > 0 ? '+' : '') + row.rd + '\nXP: +' + row.xp : '') +
               '\n\nCan you beat me? ' + link;
  track('share', mapId, { channel: 'card' });
  if (navigator.share) navigator.share({ text: card }).catch(() => {});
  else { copyText(card); toast('Result card copied!'); }
}

const chalBtn = $('res-challenge-btn');
if (chalBtn) chalBtn.addEventListener('click', () => shareChallengeAction('challenge_btn'));

const moreOptsBtn = $('more-opts-btn'), moreWrap = $('res-more-wrap');
if (moreOptsBtn && moreWrap) {
  moreOptsBtn.addEventListener('click', () => {
    moreWrap.hidden = !moreWrap.hidden;
    moreOptsBtn.textContent = moreWrap.hidden ? '⋯ MORE OPTIONS' : '▲ LESS OPTIONS';
  });
}

const shareEl = $('share-btn');
if (shareEl) shareEl.addEventListener('click', shareResultCardAction);

// v59 BEAT MY TIME challenge (ghost link + target time)
const btBtn = $('beat-btn');
if (btBtn) btBtn.addEventListener('click', () => {
  const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
  let g = null; try { g = JSON.parse(localStorage.getItem('sr_ghost_' + mapId) || 'null'); } catch (e) {}
  if (!g || !g.length) { toast('Enable 👻 Ghost & set a best lap first'); return; }
  btBtn.disabled = true;
  fetch(httpBase() + '/ghost', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ map: mapId, name: prefs.name, data: g }) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('x'))))
    .then((j) => {
      let best = null; try { best = JSON.parse(localStorage.getItem('sr_best_' + mapId) || 'null'); } catch (e) {}
      const msg = `⏱️ BEAT MY TIME on ${(CORE.MAPS[mapId] || {}).name || 'track'}: ${best != null ? fmtTime(best) : '—'}\n👻 Race my ghost: ${location.origin}/?g=${j.id}`;
      track('share', mapId, { channel: 'ghost' });
      if (navigator.share) navigator.share({ text: msg }).catch(() => {});
      else { copyText(msg); toast('Challenge copied — send it!'); }
    })
    .catch(() => toast('Needs the Supabase setup'))
    .finally(() => { btBtn.disabled = false; });
});

// v46: watchable replay link (same ghost upload, spectator page)
const rpBtn = $('replay-btn');
if (rpBtn) rpBtn.addEventListener('click', () => {
  const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
  let g = null; try { g = JSON.parse(localStorage.getItem('sr_ghost_' + mapId) || 'null'); } catch (e) {}
  if (!g || !g.length) { toast('Set a best lap first (enable 👻 Ghost in settings)'); return; }
  rpBtn.disabled = true;
  fetch(httpBase() + '/ghost', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ map: mapId, name: prefs.name, data: g }) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unavailable'))))
    .then((j) => { track('share', mapId, { channel: 'replay' }); copyText(location.origin + '/replay?g=' + j.id); toast('🎥 Replay link copied!'); })
    .catch(() => toast('Replays need the Supabase setup'))
    .finally(() => { rpBtn.disabled = false; });
});
  // v46: community links (configured via env; hidden otherwise)
  (function () {
    const row = $('community-row'); if (!row) return;
    const wa = window.C_WA || window.COMMUNITY_WA || '', dc = window.C_DC || window.COMMUNITY_DC || '';
    if (!wa && !dc) return;
    row.hidden = false;
    const a = $('comm-wa'), b = $('comm-dc');
    if (wa && a) a.href = wa; else if (a) a.style.display = 'none';
    if (dc && b) b.href = dc; else if (b) b.style.display = 'none';
  })();
}
function cbCol(slot) {
  return prefs.cb ? (slot === 1 ? 0xff9500 : 0x0072e6) : (slot === 1 ? 0xff5252 : 0x42a5f5);
}
function applyMyColor() {
  if (carVisuals[mySlot] && carVisuals[mySlot].paint) carVisuals[mySlot].paint.color.setHex(prefs.color);
}

// ---- live 3D car thumbnails for the car-select cards ----
let _prev = null;
function carPreviewRenderer() {
  if (_prev) return _prev;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(180, 110);
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x334, 1.1));
  const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(3, 4, 5); sc.add(dl);
  const cam = new THREE.PerspectiveCamera(38, 180 / 110, 0.1, 100);
  cam.position.set(5.2, 2.4, 6.0); cam.lookAt(0, 0.5, 0);
  const car = createCar(0xffffff, 1, 0xffd400);
  sc.add(car.group);
  _prev = { r, sc, cam, car };
  return _prev;
}
function buildCarCards() {
  const wrap = $('car-cards');
  if (!wrap) return;
  wrap.innerHTML = '';
  const P = carPreviewRenderer();
  CAR_COLORS.forEach((hex, i) => {
    P.car.paint.color.setHex(hex);
    P.r.render(P.sc, P.cam);
    const url = P.r.domElement.toDataURL();
    const nm = CAR_NAMES[i] || { e: '🏎️', n: 'RACER' };
    const b = document.createElement('button');
    b.className = 'car-card' + (hex === prefs.color ? ' active' : '');
    b.dataset.color = hex;
    b.innerHTML = `<img src="${url}" alt="car"/><div class="mc-name">${nm.n}</div>`;
    b.addEventListener('click', () => {
      prefs.color = hex; savePrefs();
      wrap.querySelectorAll('.car-card').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      applyMyColor(); sendMeta();
    });
    wrap.appendChild(b);
  });
}

// ---------------------------------------------------------------------------
// Room connection + snapshot buffer (unchanged)
// ---------------------------------------------------------------------------
let mySlot = 1;
let roomCode = '';
let latest = null;
const snaps = [];
let lastBannerSeq = 0;
let lastCountInt = 99;

// Adaptive interpolation delay: grows when the network delivers snapshots in
// bursts (mobile hotspots / free-tier hosting) so the render never starves
// and shakes. Healthy 30 Hz stream -> stays at 120 ms.
let interpDelay = INTERP_DELAY;
const snapGaps = [];
function interpState(slot) {
  if (snaps.length === 0) return null;
  const target = performance.now() - interpDelay;
  let ai = -1;
  for (let i = snaps.length - 1; i >= 0; i--) { if (snaps[i].t <= target) { ai = i; break; } }
  const carOf = (snap) => snap.cars[slot - 1];
  if (ai < 0) return carOf(snaps[0].snap);
  const a = snaps[ai]; const b = snaps[ai + 1];
  const ca = carOf(a.snap);
  if (!b) {
    // no newer snapshot yet (network gap): dead-reckon with the car's own
    // velocity for up to 130 ms instead of freezing (freeze = visible shake)
    const extra = clamp((target - a.t) / 1000, 0, 0.13);
    return { ...ca, s: slot, x: ca.x + Math.sin(ca.h) * ca.v * extra, z: ca.z + Math.cos(ca.h) * ca.v * extra };
  }
  const cb = carOf(b.snap);
  const alpha = clamp((target - a.t) / Math.max(1, b.t - a.t), 0, 1);
  return {
    s: slot, x: lerp(ca.x, cb.x, alpha), z: lerp(ca.z, cb.z, alpha), h: lerpAngle(ca.h, cb.h, alpha),
    v: lerp(ca.v, cb.v, alpha), sl: lerp(ca.sl, cb.sl, alpha), st: cb.st, th: cb.th,
    n: cb.n, m: cb.m, lap: cb.lap, ll: ca.ll, best: cb.best, fin: cb.fin, ft: cb.ft, p: cb.p, pr: cb.pr, drift: cb.drift || 0, elim: cb.elim || 0
  };
}
function standingsFrom(snap) {
  const cars = snap.cars.filter((c) => c.p === 1);
  return cars.slice().sort((a, b) => {
    if (a.fin && b.fin) return a.ft - b.ft;
    if (a.fin) return -1;
    if (b.fin) return 1;
    return (b.lap * PI2 + b.pr) - (a.lap * PI2 + a.pr);
  });
}
const ordinal = (n) => ['1st', '2nd', '3rd'][n - 1] || n + 'th';

let shakeAmp = 0;
function onCrashFX(x, z, strength) {
  spawnSparks(x, z, strength);
  shakeAmp = Math.min(0.8, shakeAmp + 0.14 + strength * 0.3);
  const f = $('hitflash');
  f.style.opacity = Math.min(0.55, 0.2 + strength * 0.4);
  clearTimeout(onCrashFX._t);
  onCrashFX._t = setTimeout(() => { f.style.opacity = 0; }, 140);
  if (strength > 0.35) beep(90 + Math.random() * 40, 0.18, 'sawtooth', 0.16);
}
function toast(text) {
  const el = $('toast'); el.textContent = text; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}
function setBanner(text) {
  const el = $('banner-text'); el.textContent = text;
  const b = $('banner'); b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  clearTimeout(setBanner._t); setBanner._t = setTimeout(() => b.classList.remove('show'), 4200);
}
function confetti() {
  if (prefs.rm) return;
  const c = $('confetti'); c.innerHTML = '';
  const colors = ['#ff5252', '#ffd479', '#42a5f5', '#3ddc84', '#ffffff'];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('i');
    p.style.left = (Math.random() * 100) + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.9) + 's';
    p.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
    c.appendChild(p);
  }
  setTimeout(() => { c.innerHTML = ''; }, 6500);
}
function showCount(txt) {
  const el = $('count-num'); el.textContent = txt;
  el.classList.toggle('go', txt === 'GO!');
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}
let pendingSettle = []; // v73 server-settled XP/rating rows
function showResults(order) {
  if (TT.on) return; // v61: TT/practice use their own overlay
  if (currentAcademyLesson) {
    try {
      const les = JSON.parse(localStorage.getItem('sr_academy_lessons') || '{}');
      les[currentAcademyLesson] = true;
      localStorage.setItem('sr_academy_lessons', JSON.stringify(les));
      toast('🎓 Academy Lesson Completed!');
    } catch (e) {}
    currentAcademyLesson = null;
    const hEl = $('academy-hint-banner'); if (hEl) hEl.style.display = 'none';
  }
  lastResults = order;
  const rows = $('results-rows'); rows.innerHTML = '';
  const medals = ['🥇', '🥈', ''];
  const winner = order[0];
  order.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'rrow' + (i === 0 ? ' win' : '');
    const colHex = '#' + (c.color != null ? c.color : (c.slot === 1 ? 0xe10600 : 0x0a84ff)).toString(16).padStart(6, '0');
    div.innerHTML = `<span class="medal">${medals[i] || ''}</span>` +
      `<span class="rname" style="color:${colHex}">${escapeHtml(c.name || ('PLAYER ' + c.slot))}</span>` +
      `<span class="rtime">${c.finished ? fmtTime(c.t) : 'DNF'}</span>` +
      `<span class="rbest">best lap ${c.best != null ? fmtTime(c.best) : '--:--.--'}</span>`;
    rows.appendChild(div);
  });
  $('results-title').textContent = winner ? `🏁 ${escapeHtml(winner.name || ('PLAYER ' + winner.slot))} WINS!` : '🏁 RACE RESULTS';
  // v65 full result summary: position/time/best lap/PB/rival gap/streak/board rank
  const rs = $('res-summary');
  if (rs && !TT.on) {
    const my = order.find((c) => (c.slot || c.s) === mySlot);
    if (my) {
      const p = Pget();
      const pos = order.indexOf(my) + 1;
      const mId3 = (latest && latest.map != null) ? latest.map : builtMapId;
      const pb3 = p.bestRace && p.bestRace[mId3];
      const rows3 = window.__lbRows || [];
      const boardRank = rows3.findIndex((r) => r.pid && r.pid === prefs.pid) + 1;
      const riv = p.rival;
      rs.innerHTML = '🏁 P' + pos + ' · ' + (my.finished ? fmtTime(my.t) : 'DNF') +
        (my.best != null ? ' · ⚡ lap ' + fmtTime(my.best) : '') +
        (pb3 != null ? ' · PB ' + fmtTime(pb3) : '') +
        (riv && riv.t != null && my.t != null ? ' · rival ' + (my.t - riv.t >= 0 ? '+' : '') + (my.t - riv.t).toFixed(2) + 's' : '') +
        ' · 🔥 streak ' + p.streak + (boardRank > 0 ? ' · board #' + boardRank : '');
    } else rs.innerHTML = '';
  }
  // v63 photo finish: genuine margin from server results
  const pf = $('photo-finish');
  if (pf) {
    const f = order.filter((c) => c.finished);
    if (f.length >= 2 && f[0].t != null && f[1].t != null && (f[1].t - f[0].t) <= 0.60) {
      const margin = f[1].t - f[0].t;
      pf.hidden = false;
      pf.innerHTML = '⚡ PHOTO FINISH — ' + escapeHtml(f[0].name || 'P' + f[0].slot) + ' ' + fmtTime(f[0].t) + ' vs ' + escapeHtml(f[1].name || 'P' + f[1].slot) + ' ' + fmtTime(f[1].t) + ' · margin <b>+' + margin.toFixed(3) + 's</b>';
      triggerPhotoFinish(margin, f[0].name || 'P' + f[0].slot, f[1].name || 'P' + f[1].slot);
    } else pf.hidden = true;
  }
  // v73 ranked ceremony: server-settled XP / rating / level / PR
  const cer = $('res-ceremony');
  if (cer) {
    const row = (pendingSettle || []).find((r) => r.slot === mySlot);
    if (row && window.SRProg) {
      const tr = SRProg.tier(row.ratingNew);
      cer.hidden = false;
      cer.innerHTML =
        '<div class="c-pos">P' + row.pos + '</div>' +
        '<div class="c-xp">+' + row.xp + ' XP</div>' +
        (row.rd ? '<div class="c-rd ' + (row.rd > 0 ? 'up' : 'dn') + '">' + (row.rd > 0 ? '+' : '') + row.rd + ' RATING</div>' : '<div class="c-rd mu">RATED · vs humans only</div>') +
        (row.levelUp ? '<div class="c-lvl">⬆ LEVEL ' + row.levelNew + '</div>' : '') +
        (row.pr ? '<div class="c-pr">🎉 PERSONAL RECORD</div>' : '') +
        (row.coins ? '<div class="c-xp" style="color:#ffd479">🪙 +' + row.coins + ' COINS</div>' : '') +
        (row.dailyXp ? '<div class="c-pr">📅 DAILY +150 XP</div>' : '') +
        (row.chDone ? '<div class="c-pr">⚔️ CHALLENGE COMPLETE +100</div>' : '') +
        (row.ach && row.ach.length ? '<div class="c-pr">' + row.ach.map((a) => a.icon + ' ' + a.name + ' +' + a.xp).join(' · ') + '</div>' : '') +
        '<div class="c-tier" style="color:' + tr.col + '">' + tr.name + ' · ' + row.ratingNew + '</div>';
    } else if (cer) cer.hidden = true;
  }
  // v80 Ranked Movement Card in results modal
  const rkCard = $('res-rank-card');
  if (rkCard) {
    const row = (pendingSettle || []).find((r) => r.slot === mySlot);
    if (row && row.ratingNew) {
      rkCard.hidden = false;
      const tr = window.SRProg ? SRProg.tier(row.ratingNew) : { name: 'BRONZE III', col: '#d09a6a', pct: 50 };
      const tb = $('rmc-tier-badge'); if (tb) { tb.textContent = tr.name; tb.style.color = tr.col; tb.style.borderColor = tr.col; }
      const rr = $('rmc-rank'); if (rr) rr.textContent = row.rankAfter ? '#' + row.rankAfter : '#--';
      const rdEl = $('rmc-rank-delta');
      if (rdEl) {
        if (row.rankDelta > 0) { rdEl.textContent = '▲ +' + row.rankDelta; rdEl.className = 'rank-up'; }
        else if (row.rankDelta < 0) { rdEl.textContent = '▼ ' + row.rankDelta; rdEl.className = 'rank-down'; }
        else { rdEl.textContent = '='; rdEl.className = ''; }
      }
      const rVal = $('rmc-rating'); if (rVal) rVal.textContent = row.ratingNew;
      const rDelta = $('rmc-rating-delta');
      if (rDelta) {
        rDelta.textContent = (row.rd > 0 ? '+' : '') + (row.rd || 0);
        rDelta.className = row.rd > 0 ? 'rank-up' : (row.rd < 0 ? 'rank-down' : '');
      }
      const rPts = $('rmc-pts'); if (rPts) rPts.textContent = '+' + (row.weeklyPts || 0);
      const rFill = $('rmc-prog-fill'); if (rFill) rFill.style.width = (tr.pct || 0) + '%';
      const rNext = $('rmc-next-txt');
      if (rNext) {
        rNext.textContent = (tr.next ? `${tr.pct}% to ${tr.next}` : 'Master League') + (row.percentile ? ` · Top ${row.percentile}% Globally` : '');
      }
    } else {
      rkCard.hidden = true;
    }
  }

  // v81 Rival Overtaken / Next Target Card
  const rivCard = $('res-rival-card');
  if (rivCard) {
    const row = (pendingSettle || []).find((r) => r.slot === mySlot);
    if (row && row.overtakenRival) {
      rivCard.hidden = false;
      const rTag = $('res-rival-tag'); if (rTag) rTag.textContent = '🎉 RIVAL OVERTAKEN!';
      const rGap = $('res-rival-gap'); if (rGap) rGap.textContent = `+#${row.rankDelta || 1} RANKS`;
      const rTxt = $('res-rival-text'); if (rTxt) rTxt.textContent = `You overtook ${escapeHtml(row.overtakenRival.rivalName)} (#${row.overtakenRival.previousRivalRank}) on the global ladder!`;
    } else if (row && row.rankAfter) {
      rivCard.hidden = false;
      const rTag = $('res-rival-tag'); if (rTag) rTag.textContent = '⚔️ CURRENT STANDING';
      const rGap = $('res-rival-gap'); if (rGap) rGap.textContent = `#${row.rankAfter}`;
      const rTxt = $('res-rival-text'); if (rTxt) rTxt.textContent = `Rating: ${row.ratingNew} (${row.rd >= 0 ? '+' : ''}${row.rd}) · Global Rank #${row.rankAfter}`;
    } else {
      rivCard.hidden = true;
    }
  }

  // v81 Ghost Comparison Card
  const ghCard = $('res-ghost-card');
  if (ghCard) {
    const myRow = order.find((c) => (c.slot || c.s) === mySlot);
    const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
    let pb = null; try { pb = JSON.parse(localStorage.getItem('sr_best_' + mapId) || 'null'); } catch (e) {}
    if (myRow && myRow.finished && myRow.t != null && pb != null) {
      ghCard.hidden = false;
      const delta = myRow.t - pb;
      const gDeltaEl = $('res-ghost-delta');
      const gTxtEl = $('res-ghost-text');
      if (delta < 0) {
        if (gDeltaEl) gDeltaEl.textContent = `${Math.abs(delta).toFixed(2)}s FASTER`;
        if (gTxtEl) gTxtEl.textContent = `⚡ Personal Best smashed! New circuit record: ${fmtTime(myRow.t)}`;
      } else {
        if (gDeltaEl) gDeltaEl.textContent = `+${delta.toFixed(2)}s vs PB`;
        if (gTxtEl) gTxtEl.textContent = `Ghost target: ${fmtTime(pb)} · You were ${delta.toFixed(2)}s off your best.`;
      }
    } else {
      ghCard.hidden = true;
    }
  }

  // v81 Daily Missions Updates
  const misCard = $('res-missions-card');
  if (misCard) {
    const row = (pendingSettle || []).find((r) => r.slot === mySlot);
    if (row && row.missionUpdates && row.missionUpdates.length) {
      misCard.hidden = false;
      const doneCount = row.missionUpdates.filter(m => m.completed).length;
      const mStatus = $('res-missions-status'); if (mStatus) mStatus.textContent = `${doneCount}/${row.missionUpdates.length} DONE`;
      const mList = $('res-missions-list');
      if (mList) {
        mList.innerHTML = row.missionUpdates.map(m => `
          <div class="res-mission-item ${m.completed ? 'completed' : ''}">
            <span>${m.icon || '🎯'} ${escapeHtml(m.title)} (${m.progress}/${m.goal})</span>
            <span>${m.justCompleted ? '🎉 COMPLETED! +' + m.xpAwarded + ' XP' : (m.completed ? '✅ Done' : '+' + (m.goal - m.progress) + ' to go')}</span>
          </div>
        `).join('');
      }
    } else {
      misCard.hidden = true;
    }
  }

  // v81 Daily Streak & Season Division Promo
  const strRow = $('res-streak-promo-row');
  if (strRow) {
    const row = (pendingSettle || []).find((r) => r.slot === mySlot);
    if (row && (row.streak || (row.divisionChange && row.divisionChange.changed))) {
      strRow.hidden = false;
      const sPill = $('res-streak-pill');
      if (sPill) sPill.textContent = `🔥 ${row.streak || 1}-Day Streak`;
      const pPill = $('res-promo-pill');
      if (pPill) {
        if (row.divisionChange && row.divisionChange.promoted) {
          pPill.hidden = false;
          pPill.textContent = `🎖️ PROMOTED TO ${row.divisionChange.toTier.toUpperCase()}!`;
        } else {
          pPill.hidden = true;
        }
      }
    } else {
      strRow.hidden = true;
    }
  }

  // v82 Revenge Match / Victory Card
  const revResCard = $('res-revenge-card');
  if (revResCard) {
    const row = (pendingSettle || []).find((r) => r.slot === mySlot);
    if (row && row.revengeAwarded) {
      revResCard.hidden = false;
      const rTag = $('res-revenge-tag'); if (rTag) rTag.textContent = '🎉 REVENGE VICTORY!';
      const rBadge = $('res-revenge-badge'); if (rBadge) rBadge.textContent = `+${row.revengeAwarded.xpBonus} XP · +${row.revengeAwarded.coinsBonus} 🪙`;
      const rTxt = $('res-revenge-text'); if (rTxt) rTxt.textContent = 'You defeated your rival and claimed the +50% Revenge Bounty!';
    } else if (row && row.pos > 1 && order.length > 1 && !latest.bot) {
      revResCard.hidden = false;
      const rTag = $('res-revenge-tag'); if (rTag) rTag.textContent = '⚔️ REVENGE OPPORTUNITY';
      const rBadge = $('res-revenge-badge'); if (rBadge) rBadge.textContent = '+50% BOUNTY';
      const rivalName = (order[0] && order[0].name) ? order[0].name : 'your rival';
      const rTxt = $('res-revenge-text'); if (rTxt) rTxt.textContent = `Defeated by ${escapeHtml(rivalName)}. Instant rematch to claim Revenge Bounty!`;
    } else {
      revResCard.hidden = true;
    }
  }

  // v82 Weekly Bounties Progress Card
  const bntResCard = $('res-bounties-card');
  if (bntResCard) {
    const row = (pendingSettle || []).find((r) => r.slot === mySlot);
    if (row && row.bountyUpdates && row.bountyUpdates.length) {
      bntResCard.hidden = false;
      const doneCount = row.bountyUpdates.filter(b => b.completed).length;
      const bStatus = $('res-bounties-status'); if (bStatus) bStatus.textContent = `${doneCount}/${row.bountyUpdates.length} DONE`;
      const bList = $('res-bounties-list');
      if (bList) {
        bList.innerHTML = row.bountyUpdates.map(b => `
          <div class="res-mission-item ${b.completed ? 'completed' : ''}">
            <span>${b.icon || '🏆'} ${escapeHtml(b.title)} (${b.progress}/${b.goal})</span>
            <span>${b.justCompleted ? '🎉 COMPLETED! +' + b.xpAwarded + ' XP' : (b.completed ? '✅ Done' : '+' + (b.goal - b.progress) + ' to go')}</span>
          </div>
        `).join('');
      }
    } else {
      bntResCard.hidden = true;
    }
  }

  // v83 Racing Syndicate Crew Contribution Card in results modal
  const crewResCard = $('res-crew-card');
  if (crewResCard) {
    const row = (pendingSettle || []).find((r) => r.slot === mySlot);
    if (row && row.crew) {
      crewResCard.hidden = false;
      const cTag = $('res-crew-tag'); if (cTag) cTag.textContent = `🏁 [${row.crew.tag}] SYNDICATE MILEAGE`;
      const cContrib = $('res-crew-contrib'); if (cContrib) cContrib.textContent = `+${row.crew.contribMeters}m / +${row.crew.contribPoints} PTS`;
      const cTxt = $('res-crew-text'); if (cTxt) cTxt.textContent = `Contributed +${row.crew.contribMeters}m (+${row.crew.contribPoints} Pts) to ${row.crew.name} weekly pool! Total: ${row.crew.totalWeeklyKm} km.`;
    } else {
      crewResCard.hidden = true;
    }
  }

  // v82 Polished Progression Reward Breakdown
  const rwdCard = $('res-rewards-breakdown');
  if (rwdCard) {
    const row = (pendingSettle || []).find((r) => r.slot === mySlot);
    if (row) {
      rwdCard.hidden = false;
      const xpVal = $('rb-xp-val'); if (xpVal) xpVal.textContent = `+${row.xp || 50} XP`;
      const coinVal = $('rb-coins-val'); if (coinVal) coinVal.textContent = `🪙 +${row.coins || 10}`;
      if (window.SRProg && row.levelNew) {
        const lvlInfo = SRProg.levelFromXp((Pget ? Pget().xp : 0) + (row.xp || 50));
        const lvlLbl = $('rb-level-lbl'); if (lvlLbl) lvlLbl.textContent = `LEVEL ${lvlInfo.level}`;
        const xpNext = $('rb-xp-next'); if (xpNext) xpNext.textContent = `${lvlInfo.currentXpInLevel}/${lvlInfo.xpForNextLevel} XP`;
        const barFill = $('rb-bar-fill'); if (barFill) barFill.style.width = `${Math.min(100, Math.round(lvlInfo.progressPct * 100))}%`;
      }
    } else {
      rwdCard.hidden = true;
    }
  }

  // v82 Auto Rematch 10s Countdown Timer
  startAutoRematchTimer();
  // v59 progression + personal-best celebration
  try {
    const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
    statBump('races');
    if (winner && (winner.slot || winner.s) === mySlot) statBump('wins');
    const myRow = order.find((c) => (c.slot || c.s) === mySlot);
    if (myRow && myRow.finished && myRow.t != null) {
      let pb = null; try { pb = JSON.parse(localStorage.getItem('sr_best_' + mapId) || 'null'); } catch (e) {}
      if (pb == null || myRow.t < pb) {
        try { localStorage.setItem('sr_best_' + mapId, JSON.stringify(myRow.t)); } catch (e) {}
        const d = document.createElement('div'); d.className = 'pb-note';
        d.textContent = '🎉 PERSONAL BEST on ' + ((CORE.MAPS[mapId] || {}).name || 'track') + '!';
        rows.appendChild(d);
      }
      if (dailyInfoCache && dailyInfoCache.map === mapId) {
        const top = (dailyRowsCache || [])[0];
        if (!top || myRow.t <= top.t) toast('✅ Daily challenge complete!');
        { const pp = Pget(); pp.daily++; pp.xp += 30; Psave(pp); }
      }
    }
    const ti = playerTitle();
    $('results-title').textContent += `  ·  Lv${ti.lv} ${ti.title}`;
    const v60 = v60OnResults(order, mapId);
    const podEl = $('podium-line');
    if (podEl) {
      if (v60 && v60.won) { podEl.hidden = false; podEl.textContent = '🏆 YOU WIN! · 1ST PLACE' + (v60.streak >= 2 ? ' · 🔥 streak ' + v60.streak : ''); }
      else podEl.hidden = true;
    }
    const moEl = $('motiv-line');
    if (moEl) moEl.textContent = v60 && v60.motiv ? v60.motiv : '';
    renderProfile();
  } catch (e) {}
  $('results').classList.remove('hidden'); { const gb = $('ghost-share-btn'); if (gb) gb.hidden = false; const pb = $('photo-btn'); if (pb) pb.hidden = false; const bb = $('beat-btn'); if (bb) bb.hidden = false; }
}

function updateLobby(snap) {
  if (SPEC_ROOM) { const ov = $('overlay'); if (ov && latest && latest.state !== 'waiting') ov.classList.add('hidden'); }
  $('room-code').textContent = snap.code;
  const gameLink = location.origin + '/?room=' + snap.code + '&map=' + (snap.map != null ? snap.map : selectedMap); // v64 per-map OG
  const phoneLink = location.origin + '/controller?room=' + snap.code;
  $('game-link').textContent = gameLink;
  $('ctrl-url').textContent = phoneLink;
  drawQR(phoneLink);
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === snap.mode));
  document.querySelectorAll('.map-card').forEach((b) => b.classList.toggle('active', parseInt(b.dataset.map, 10) === snap.map));
  if (snap.map != null) selectedMap = snap.map;
  const parts = [];
  if (snap.controllers[1]) parts.push('📱 P1 joystick');
  if (snap.controllers[2]) parts.push('📱 P2 joystick');
  if (snap.bot) parts.push('🤖 AI driver');
  $('lobby-status').textContent = parts.length ? 'Connected: ' + parts.join(' · ') : 'Waiting for joysticks (or drive with keyboard)…';
  const isTouchDev = typeof window !== 'undefined' && (('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0));
  const mobBar = $('mob-choice-bar');
  if (mobBar && isTouchDev && !wantedRoom && !SPEC_ROOM) {
    mobBar.style.display = 'flex';
  }
  renderLeaderboard(snap);
  if (!lobbyWired) { lobbyWired = true; wireLobbyV2(); }
}
let lobbyWired = false;
let lastLb = null; // cached — server now sends the leaderboard at 1 Hz only
function renderLeaderboard(snap) {
  // v64 close-rank motivation from real board data
  const lm = $('lb-motiv');
  if (lm) {
    const rows = (snap.lb) || window.__lbRows || [];
    const myBest = (Pget().bestRace || {})[selectedMap];
    if (rows.length && myBest != null) {
      const above = rows.filter((r) => r.t < myBest);
      const target = above.length ? above[above.length - 1] : null;
      const myRank = rows.findIndex((r) => r.pid && r.pid === prefs.pid) + 1;
      const below = rows.filter((r) => r.t > myBest);
      const chaser = below.length ? below[0] : null;
      if (target) lm.textContent = 'YOU ' + (myRank > 0 ? '#' + myRank : '') + ' · BEAT ' + target.name + ' by ' + (myBest - target.t).toFixed(2) + 's' + (chaser ? ' · ' + chaser.name + ' is ' + (chaser.t - myBest).toFixed(2) + 's behind YOU' : '');
      else lm.textContent = myRank === 1 ? '👑 YOU LEAD THIS BOARD' : 'YOU ' + (myRank > 0 ? '#' + myRank : '#' + (rows.length + 1)) + ' — set a faster lap to climb!';
    } else lm.textContent = '';
  }
  if (snap.lb) window.__lbRows = snap.lb;
  const el = $('leaderboard');
  if (!el) return;
  if (snap.lb) lastLb = snap.lb;
  const rows = lastLb || [];
  if (!rows.length) { el.innerHTML = '<div class="lb-empty">No times yet on this circuit — set the first!</div>'; return; }
  el.innerHTML = rows.map((r, i) => {
    const me = r.pid && r.pid === prefs.pid;
    return `<div class="lb-row${me ? ' me' : ''}"><span class="lb-pos">${i + 1}</span><span class="lb-name">${escapeHtml(r.name)}${me ? ' ★' : ''}</span><span class="lb-time">${fmtTime(r.t)}</span></div>`;
  }).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// v39 "alive lobby": recent-finishes ticker + daily challenge panel.
// Additive & silent on failure — an older server simply shows neither.
// ---------------------------------------------------------------------------
function httpBase() {
  let cfg = String(window.SERVER_URL || 'local').trim();
  if (cfg === 'local') return '';
  if (!/^(https?):\/\//i.test(cfg)) cfg = 'https://' + cfg;
  return cfg.replace(/\/+$/, '');
}
let dailyInfoCache = null;
async function pollLobbyExtras() {
  if (document.hidden) return;
  const ovL = $('overlay'); if (ovL && ovL.classList.contains('hidden')) return; // v65: no lobby polling mid-race
  const base = httpBase();
  try { const r = await fetch(base + '/recent'); if (r.ok) renderRecent(await r.json()); } catch (e) {}
  try { const c = await fetch(base + '/cup'); if (c.ok) renderCup(await c.json()); } catch (e) {}
  try {
    if (!dailyInfoCache) {
      const d = await fetch(base + '/daily'); if (!d.ok) return;
      dailyInfoCache = await d.json();
      paintDailyHeader();
    }
    const lb = await fetch(base + '/lb?map=' + dailyInfoCache.map + '&daily=1');
    if (lb.ok) renderDailyBoard(await lb.json());
  } catch (e) {}
  fetchAndRenderRetention().catch(() => {});
}

let autoRematchTimerId = null;
let autoRematchSeconds = 10;
function clearAutoRematchTimer() {
  if (autoRematchTimerId) {
    clearInterval(autoRematchTimerId);
    autoRematchTimerId = null;
  }
  const tEl = $('rematch-timer');
  if (tEl) tEl.textContent = '';
}

function startAutoRematchTimer() {
  clearAutoRematchTimer();
  autoRematchSeconds = 10;
  const tEl = $('rematch-timer');
  if (tEl) tEl.textContent = `(${autoRematchSeconds}s)`;
  autoRematchTimerId = setInterval(() => {
    autoRematchSeconds--;
    if (autoRematchSeconds <= 0) {
      clearAutoRematchTimer();
      const rBtn = $('rematch-btn');
      if (rBtn && !$('results').classList.contains('hidden')) {
        rBtn.click();
      }
    } else {
      if (tEl) tEl.textContent = `(${autoRematchSeconds}s)`;
    }
  }, 1000);
}

let retentionPollBusy = false;
async function fetchAndRenderRetention() {
  if (retentionPollBusy) return;
  retentionPollBusy = true;
  const base = httpBase();
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');
  try {
    const [rivRes, misRes, strRes, seaRes, nahRes, revRes] = await Promise.all([
      fetch(`${base}/api/player/rivals?uid=${encodeURIComponent(uid)}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/player/missions?uid=${encodeURIComponent(uid)}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/player/streak?uid=${encodeURIComponent(uid)}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/season?uid=${encodeURIComponent(uid)}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/player/next-action?uid=${encodeURIComponent(uid)}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/player/revenge?uid=${encodeURIComponent(uid)}`).then(r => r.json()).catch(() => null)
    ]);

    // 0. Next Best Action hero
    const nahCard = $('next-action-hero');
    if (nahCard && nahRes && nahRes.ok && nahRes.action) {
      const act = nahRes.action;
      const bTitle = $('nah-title'); if (bTitle) bTitle.textContent = act.title;
      const bDesc = $('nah-desc'); if (bDesc) bDesc.textContent = act.desc;
      const bBtn = $('nah-btn');
      if (bBtn) {
        bBtn.textContent = act.cta;
        bBtn.onclick = () => {
          if (act.actionKey === 'academy') {
            const ab = $('academy-btn'); if (ab) ab.click();
          } else if (act.actionKey === 'daily' || act.actionKey === 'streak') {
            const dp = $('daily-play'); if (dp) dp.click();
            const sb = $('start-btn'); if (sb) sb.click();
          } else if (act.actionKey === 'revenge') {
            const ra = $('rev-accept-btn'); if (ra) ra.click();
          } else {
            const qp = $('quickplay-btn'); if (qp) qp.click();
          }
        };
      }
      nahCard.style.display = '';
    }

    // 0.5 Active Revenge match banner
    const revBanner = $('revenge-banner');
    if (revBanner && revRes && revRes.ok && revRes.targets && revRes.targets.length) {
      const topRev = revRes.targets[0];
      const rMsg = $('rev-msg');
      if (rMsg) rMsg.textContent = `Settle the score against ${escapeHtml(topRev.targetName || 'Rival')} on ${((CORE.MAPS[topRev.map] || {}).name || 'Circuit')} (+50% XP & Coins)!`;
      const rBtn = $('rev-accept-btn');
      if (rBtn) {
        rBtn.onclick = () => {
          selectedMap = topRev.map || 0;
          net.send({ type: 'map', map: selectedMap });
          revBanner.style.display = 'none';
          const sb = $('start-btn'); if (sb) sb.click();
        };
      }
      revBanner.style.display = '';
    } else if (revBanner) {
      revBanner.style.display = 'none';
    }

    // 1. Rivals card
    const rivCard = $('lobby-rival-card');
    if (rivCard && rivRes && rivRes.ok && rivRes.rivals) {
      const nr = rivRes.rivals.nextRival;
      const cr = rivRes.rivals.chaserRival;
      const nrRank = $('lcomp-rival-rank');
      const nrName = $('lcomp-rival-name');
      const nrGap = $('lcomp-rival-gap');
      if (nr) {
        if (nrRank) nrRank.textContent = `#${nr.rank}`;
        if (nrName) nrName.textContent = nr.name;
        if (nrGap) nrGap.textContent = `${nr.ratingGap} rating pts ahead`;
      } else if (cr) {
        if (nrRank) nrRank.textContent = `#${cr.rank}`;
        if (nrName) nrName.textContent = cr.name;
        if (nrGap) nrGap.textContent = `${cr.ratingGap} rating pts behind`;
      } else {
        if (nrRank) nrRank.textContent = `#1`;
        if (nrName) nrName.textContent = 'Ladder Leader';
        if (nrGap) nrGap.textContent = 'Defend your rank';
      }
    }

    // 2. Daily Missions card
    const misCard = $('lobby-missions-card');
    if (misCard && misRes && misRes.ok && misRes.missions) {
      const doneCount = misRes.missions.filter(m => m.completed).length;
      const mCount = $('lcomp-missions-count');
      if (mCount) mCount.textContent = `${doneCount}/${misRes.missions.length}`;
      const mList = $('lcomp-missions-list');
      if (mList) {
        mList.innerHTML = misRes.missions.map(m => {
          const pct = Math.min(100, Math.round((m.progress / m.goal) * 100));
          return `
            <div class="lcomp-m-row">
              <div class="lcomp-m-header">
                <span>${m.icon || '🎯'} ${escapeHtml(m.title)}</span>
                <span>${m.progress}/${m.goal} ${m.completed ? '✅' : ''}</span>
              </div>
              <div class="lcomp-m-bar">
                <div class="lcomp-m-fill ${m.completed ? 'done' : ''}" style="width:${pct}%"></div>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // 3. Streak & Milestones
    if (strRes && strRes.ok) {
      const sBadge = $('lcomp-streak-badge');
      if (sBadge) sBadge.textContent = `DAY ${strRes.currentStreak || 1}`;
      const sTxt = $('lcomp-streak-txt');
      if (sTxt) sTxt.textContent = strRes.racedToday ? '🔥 Streak maintained today!' : '🏁 Race today to maintain streak';
      const sMs = $('lcomp-streak-milestone');
      if (sMs && strRes.milestoneInfo) {
        sMs.textContent = strRes.milestoneInfo.nextMilestone ? `Next: ${strRes.milestoneInfo.nextMilestone}-Day Milestone (+${strRes.milestoneInfo.rewardXp} XP)` : 'Max milestone achieved!';
      }
    }

    // 4. Season info
    if (seaRes && seaRes.ok && seaRes.season) {
      const sBtn = $('lobby-season-btn');
      if (sBtn) sBtn.textContent = `🏆 S${seaRes.season.seasonId} LADDER`;
    }
  } catch (e) {
  } finally {
    retentionPollBusy = false;
  }
}

// v82 Driving Academy Modal Controller
let currentAcademyLesson = null;
async function openDrivingAcademy() {
  const dlg = $('academy-dlg');
  if (!dlg) return;
  const body = $('academy-body');
  if (!body) return;
  dlg.hidden = false;
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');
  let completed = false;
  try {
    const res = await fetch(`${httpBase()}/api/player/badges?uid=${encodeURIComponent(uid)}`).then(r => r.json());
    if (res && res.ok && res.badges) {
      const lp = res.badges.find(b => b.id === 'pro_license' || b.badgeId === 'pro_license');
      if (lp && lp.tierLevel >= 1) completed = true;
    }
  } catch (e) {}

  const lessons = (window.SRProg && SRProg.ACADEMY_LESSONS) ? SRProg.ACADEMY_LESSONS : [
    { id: 'lesson_1_steering', title: 'Apex & Precision Steering', desc: 'Master the racing line: steer smoothly around apexes without hitting outer barriers.' },
    { id: 'lesson_2_nitro', title: 'Nitro Exit Acceleration', desc: 'Trigger Nitro boosts out of high-speed turns to reach top straightaway velocity.' },
    { id: 'lesson_3_drafting', title: 'Slipstream & Clean Overtake', desc: 'Follow the target car in its aerodynamic slipstream draft and execute a clean pass.' }
  ];

  let completedLessons = {};
  try { completedLessons = JSON.parse(localStorage.getItem('sr_academy_lessons') || '{}'); } catch (e) {}
  const allLessonsDone = lessons.every(l => completedLessons[l.id] || completed);

  let html = lessons.map((les, idx) => {
    const isDone = completed || completedLessons[les.id];
    return `
      <div class="academy-lesson-card ${isDone ? 'completed' : ''}">
        <div class="alc-info">
          <span class="alc-title">${idx + 1}. ${les.icon || '🎯'} ${escapeHtml(les.title)}</span>
          <span class="alc-desc">${escapeHtml(les.desc)}</span>
          <span class="alc-reward">Reward: +${les.rewardXp || 50} XP · +${les.rewardCoins || 50} 🪙</span>
        </div>
        <button class="alc-btn" onclick="startAcademyLesson('${les.id}')">${isDone ? '✅ COMPLETED' : 'START LESSON'}</button>
      </div>
    `;
  }).join('');

  if (completed) {
    html += `
      <div class="license-cert-card">
        <div class="lcc-title">🎖️ OFFICIAL PRO RACER LICENSE</div>
        <div class="lcc-sub">Certified Driver · Ready for Competitive Ranked, Revenge Duels &amp; Founders Cup</div>
      </div>
    `;
  } else {
    html += `
      <div class="license-cert-card">
        <div class="lcc-title">🎓 PRO LICENSE EXAMINATION</div>
        <div class="lcc-sub">Complete all 3 lessons to earn your official Pro Racing License + 200 Rush Coins &amp; 200 XP!</div>
        <button id="academy-claim-btn" class="big-cta" ${allLessonsDone ? '' : ''}>🏆 CLAIM PRO RACING LICENSE</button>
      </div>
    `;
  }
  body.innerHTML = html;
  const cBtn = $('academy-claim-btn');
  if (cBtn) {
    cBtn.onclick = async () => {
      cBtn.disabled = true;
      cBtn.textContent = 'Claiming…';
      try {
        const res = await fetch(`${httpBase()}/api/player/license/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid })
        }).then(r => r.json());
        if (res && res.ok) {
          toast('🎉 PRO RACING LICENSE EARNED! +200 Rush Coins & +200 XP!');
          openDrivingAcademy();
          fetchAndRenderRetention();
        } else {
          toast(res.msg || 'License claimed!');
        }
      } catch (e) {
        toast('Connection error claiming license.');
      }
    };
  }
}

window.startAcademyLesson = function(lessonId) {
  const dlg = $('academy-dlg'); if (dlg) dlg.hidden = true;
  currentAcademyLesson = lessonId;
  selectedMap = 0;
  net.send({ type: 'map', map: 0 });
  const hintEl = $('academy-hint-banner');
  if (hintEl) {
    hintEl.style.display = '';
    if (lessonId === 'lesson_1_steering') hintEl.textContent = '🎓 LESSON 1: Apex Steering — Steer smoothly through turns using WASD / Left Joystick!';
    else if (lessonId === 'lesson_2_nitro') hintEl.textContent = '🎓 LESSON 2: Nitro Exit — Tap Nitro / Shift out of hairpins to reach 180+ km/h!';
    else hintEl.textContent = '🎓 LESSON 3: Race Speed — Complete a clean fast lap without barrier collisions!';
  }
  toast(`🎓 Starting Academy Lesson! Follow the track guide.`);
  const sb = $('start-btn'); if (sb) sb.click();
};

// v82 Milestone Badges Modal Controller
async function openBadgesShowcase() {
  const dlg = $('badges-dlg');
  if (!dlg) return;
  const body = $('badges-body');
  if (!body) return;
  dlg.hidden = false;
  body.innerHTML = '<div style="color:#8b93a8; text-align:center; padding:20px;">Loading badges…</div>';
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');
  try {
    const res = await fetch(`${httpBase()}/api/player/badges?uid=${encodeURIComponent(uid)}`).then(r => r.json());
    if (res && res.ok && res.badges) {
      body.innerHTML = `
        <div class="badges-grid">
          ${res.badges.map(b => {
            const unlocked = b.tierLevel > 0;
            const pct = Math.min(100, Math.round((b.progress / Math.max(1, b.target)) * 100));
            return `
              <div class="badge-card ${unlocked ? 'unlocked' : ''}">
                <div class="bc-icon">${b.icon || '🎖️'}</div>
                <div class="bc-title">${escapeHtml(b.title)}</div>
                <div class="bc-tier">${unlocked ? 'Tier ' + b.tierLevel + ' (' + b.tierName + ')' : 'Locked'}</div>
                <div class="bc-desc">${escapeHtml(b.desc)}</div>
                <div class="bc-bar-wrap"><div class="bc-bar-fill" style="width:${pct}%"></div></div>
                <div style="font-size:10px; color:#8b93a8;">${b.progress}/${b.target}</div>
                ${unlocked ? `<button class="bc-btn ${b.equipped ? 'active' : ''}" onclick="equipMilestoneBadge('${b.badgeId}')">${b.equipped ? '⭐ EQUIPPED' : 'EQUIP'}</button>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
  } catch (e) {
    body.innerHTML = '<div style="color:#ff5252; text-align:center; padding:20px;">Failed to load badges.</div>';
  }
}

window.equipMilestoneBadge = async function(badgeId) {
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');
  try {
    const res = await fetch(`${httpBase()}/api/player/badge/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, badgeId })
    }).then(r => r.json());
    if (res && res.ok) {
      toast(`🎖️ Equipped badge: ${badgeId}!`);
      openBadgesShowcase();
    }
  } catch (e) {}
};

// v82 Weekly Syndicate Bounties Modal Controller
async function openBountiesModal() {
  const dlg = $('bounties-dlg');
  if (!dlg) return;
  const body = $('bounties-body');
  if (!body) return;
  dlg.hidden = false;
  body.innerHTML = '<div style="color:#8b93a8; text-align:center; padding:20px;">Loading bounties…</div>';
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');
  try {
    const res = await fetch(`${httpBase()}/api/competitions/weekly/bounties?uid=${encodeURIComponent(uid)}`).then(r => r.json());
    if (res && res.ok && res.bounties) {
      body.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:10px;">
          ${res.bounties.map(b => {
            const pct = Math.min(100, Math.round((b.progress / b.goal) * 100));
            return `
              <div class="res-mission-item ${b.completed ? 'completed' : ''}" style="padding:10px;">
                <div style="display:flex; flex-direction:column; gap:4px; text-align:left;">
                  <b style="font-size:13px; color:#fff;">${b.icon || '🏆'} ${escapeHtml(b.title)}</b>
                  <span style="font-size:11px; color:#8b93a8;">${escapeHtml(b.desc)}</span>
                  <div class="lcomp-m-bar" style="width:180px;"><div class="lcomp-m-fill ${b.completed ? 'done' : ''}" style="width:${pct}%"></div></div>
                  <span style="font-size:10.5px; color:#ffd479;">Rewards: +${b.xpReward} XP · +${b.coinReward} 🪙 · +${b.ptsReward} Pts</span>
                </div>
                <div>
                  ${b.completed && !b.claimed ? `<button class="alc-btn" onclick="claimWeeklyBountyReward('${b.id}')">🎁 CLAIM</button>` : (b.claimed ? '<span style="color:#7ee78a; font-weight:800;">CLAIMED</span>' : `<span style="color:#cfd6dd;">${b.progress}/${b.goal}</span>`)}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
  } catch (e) {
    body.innerHTML = '<div style="color:#ff5252; text-align:center; padding:20px;">Failed to load bounties.</div>';
  }
}

window.claimWeeklyBountyReward = async function(bountyId) {
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');
  try {
    const res = await fetch(`${httpBase()}/api/competitions/weekly/bounties/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, bountyId })
    }).then(r => r.json());
    if (res && res.ok) {
      toast(`🏆 Bounty claimed! +${res.xpAwarded} XP · +${res.coinsAwarded} Coins!`);
      openBountiesModal();
      fetchAndRenderRetention();
    }
  } catch (e) {
    toast('Error claiming bounty.');
  }
};

// v83 Racing Syndicate Crews Modal Controller
async function openCrewModal(tab = 'my') {
  const dlg = $('crew-dlg');
  if (!dlg) return;
  const body = $('crew-body');
  if (!body) return;
  dlg.hidden = false;

  ['my', 'join', 'create', 'board'].forEach(t => {
    const btn = $(`ctab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
  });

  body.innerHTML = '<div style="color:#8b93a8; text-align:center; padding:30px;">Loading Syndicate…</div>';
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');

  if (tab === 'my') {
    try {
      const res = await fetch(`${httpBase()}/api/player/crew?uid=${encodeURIComponent(uid)}`).then(r => r.json());
      if (res && res.ok && res.hasCrew && res.crew) {
        const c = res.crew;
        body.innerHTML = `
          <div class="crew-hero-card" style="border-color:${c.color || '#00e5ff'};">
            <div class="chc-header">
              <div class="chc-title">
                <span class="syndicate-tag" style="background:${c.color || '#ff3366'};">[${escapeHtml(c.tag)}]</span>
                <span class="chc-name">${c.badge || '⚡'} ${escapeHtml(c.name)}</span>
              </div>
              <span style="font:800 11px Orbitron; color:#ffd479;">${c.isLeader ? '👑 LEADER' : 'MEMBER'}</span>
            </div>
            <div class="chc-motto">"${escapeHtml(c.motto || 'Speed is our only law')}"</div>
            <div class="chc-stats">
              <div class="chc-stat-col"><span>WEEKLY MILEAGE</span><b>${c.weeklyKm} km</b></div>
              <div class="chc-stat-col"><span>GRAND PRIX PTS</span><b>${c.weeklyPoints}</b></div>
              <div class="chc-stat-col"><span>TOTAL MILEAGE</span><b>${c.totalKm} km</b></div>
            </div>
          </div>

          <div class="crew-milestone-track">
            <div class="cmt-header">
              <span>WEEKLY SYNDICATE MILESTONES (TIER ${c.currentTier}/5)</span>
              <span>${c.progressPct}% TO NEXT</span>
            </div>
            <div class="cmt-bar-wrap"><div class="cmt-bar-fill" style="width:${c.progressPct}%;"></div></div>
            <div class="cmt-list">
              ${c.milestones.map(m => `
                <div class="cmt-item ${m.completed ? 'completed' : ''}">
                  <b>T${m.tier} · ${m.reqKm}km</b>
                  <span>+${m.reward.xp} XP · +${m.reward.coins} 🪙</span>
                  ${m.canClaim ? `<button class="cmt-claim-btn" onclick="claimCrewMilestoneReward(${m.tier})">CLAIM</button>` : (m.claimed ? '<span class="cmt-claim-btn claimed">CLAIMED</span>' : `<span>${m.completed ? '✅ REACHED' : m.reqKm + 'km'}</span>`)}
                </div>
              `).join('')}
            </div>
          </div>

          <div style="margin-top:16px;">
            <div style="font:800 12px Orbitron; color:#fff; margin-bottom:8px;">👥 CREW ROSTER (${c.members.length} RACERS)</div>
            <table class="crew-lb-table">
              <thead><tr><th>RACER</th><th>ROLE</th><th>WEEKLY DISTANCE</th><th>POINTS</th></tr></thead>
              <tbody>
                ${c.members.map(m => `
                  <tr>
                    <td><b>${escapeHtml(m.name)}</b> ${m.uid === uid ? '<span style="color:#00e5ff;">(YOU)</span>' : ''}</td>
                    <td><span style="color:${m.role === 'leader' ? '#ffd479' : '#8b93a8'}; font-weight:700;">${m.role.toUpperCase()}</span></td>
                    <td class="clb-km">${(m.weeklyMeters / 1000).toFixed(1)} km</td>
                    <td style="color:#ffd479; font-weight:700;">+${m.weeklyPoints || 0}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      } else {
        body.innerHTML = `
          <div style="text-align:center; padding:30px 10px;">
            <div style="font-size:36px; margin-bottom:10px;">🏁</div>
            <h3 style="font:800 16px Orbitron; color:#fff; margin-bottom:6px;">NO RACING SYNDICATE YET</h3>
            <p style="font-size:12px; color:#8b93a8; max-width:400px; margin:0 auto 18px;">Join a top racing syndicate to pool weekly mileage, unlock exclusive team milestone rewards, and compete in the Syndicate Grand Prix!</p>
            <div style="display:flex; justify-content:center; gap:10px;">
              <button class="big-cta" onclick="openCrewModal('join')">⚡ JOIN A SYNDICATE</button>
              <button class="ghost" onclick="openCrewModal('create')">➕ CREATE CREW</button>
            </div>
          </div>
        `;
      }
    } catch (e) {
      body.innerHTML = '<div style="color:#ff5252; text-align:center; padding:20px;">Failed to load crew.</div>';
    }
  } else if (tab === 'join') {
    try {
      const res = await fetch(`${httpBase()}/api/crews`).then(r => r.json());
      const crews = (res && res.crews) || [];
      body.innerHTML = `
        <div style="margin-bottom:12px; font:700 12px Orbitron; color:#7ee7ff;">SELECT A PUBLIC SYNDICATE TO JOIN:</div>
        <div class="crew-preset-grid">
          ${crews.map(cr => `
            <div class="crew-preset-card" style="border-color:${cr.color || 'rgba(255,255,255,0.1)'};">
              <div class="cpc-head">
                <span class="syndicate-tag" style="background:${cr.color || '#ff3366'};">[${escapeHtml(cr.tag)}]</span>
                <span class="cpc-name">${cr.badge || '⚡'} ${escapeHtml(cr.name)}</span>
              </div>
              <div class="cpc-motto">"${escapeHtml(cr.motto)}"</div>
              <div class="cpc-stats">👥 ${cr.memberCount} Racers · ${cr.weeklyKm} km this week</div>
              <button class="cpc-btn" onclick="joinCrewAction('${cr.id}')">JOIN [${escapeHtml(cr.tag)}]</button>
            </div>
          `).join('')}
        </div>
      `;
    } catch (e) {
      body.innerHTML = '<div style="color:#ff5252; text-align:center; padding:20px;">Failed to load syndicates.</div>';
    }
  } else if (tab === 'create') {
    body.innerHTML = `
      <form class="crew-form" id="crew-create-form" onsubmit="handleCreateCrewSubmit(event)">
        <label>
          SYNDICATE NAME (3-20 characters):
          <input id="cf-name" class="name-input" maxlength="20" placeholder="e.g. Velocity Phantoms" required />
        </label>
        <label>
          CREW TAG (2-5 uppercase letters/numbers):
          <input id="cf-tag" class="name-input" maxlength="5" placeholder="e.g. PHNTM" style="text-transform:uppercase;" required />
        </label>
        <label>
          MOTTO / SLOGAN:
          <input id="cf-motto" class="name-input" maxlength="50" placeholder="e.g. Masters of the Apex" />
        </label>
        <label>
          BADGE ICON:
          <select id="cf-badge" class="name-input" style="background:#141c30; color:#fff;">
            <option value="⚡">⚡ Lightning</option>
            <option value="🌀">🌀 Vortex</option>
            <option value="🐍">🐍 Viper</option>
            <option value="🛡️">🛡️ Shield</option>
            <option value="👻">👻 Phantom</option>
            <option value="🔥">🔥 Flame</option>
            <option value="👑">👑 Crown</option>
          </select>
        </label>
        <label>
          SYNDICATE THEME COLOR:
          <input id="cf-color" type="color" value="#00e5ff" style="width:100%; height:38px; background:none; border:none; cursor:pointer;" />
        </label>
        <p id="cf-err" style="color:#ff5252; font-size:11px; margin:0;"></p>
        <button type="submit" class="big-cta" style="margin-top:10px;">🚀 CREATE RACING SYNDICATE</button>
      </form>
    `;
  } else if (tab === 'board') {
    try {
      const res = await fetch(`${httpBase()}/api/crews/leaderboard`).then(r => r.json());
      const crews = (res && res.crews) || [];
      body.innerHTML = `
        <div style="margin-bottom:10px; font:700 12px Orbitron; color:#ffd479;">🏆 WEEKLY SYNDICATE GRAND PRIX STANDINGS</div>
        <table class="crew-lb-table">
          <thead><tr><th>RANK</th><th>SYNDICATE</th><th>RACERS</th><th>WEEKLY DISTANCE</th><th>POINTS</th></tr></thead>
          <tbody>
            ${crews.map(cr => `
              <tr>
                <td class="clb-rank">#${cr.rank}</td>
                <td class="clb-crew">
                  <span class="syndicate-tag" style="background:${cr.color || '#ff3366'};">[${escapeHtml(cr.tag)}]</span>
                  <b>${cr.badge || '⚡'} ${escapeHtml(cr.name)}</b>
                </td>
                <td>👥 ${cr.memberCount}</td>
                <td class="clb-km">${cr.weeklyKm} km</td>
                <td style="color:#ffd479; font-weight:800;">${cr.weeklyPoints}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (e) {
      body.innerHTML = '<div style="color:#ff5252; text-align:center; padding:20px;">Failed to load leaderboard.</div>';
    }
  }
}

window.claimCrewMilestoneReward = async function(tier) {
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');
  try {
    const res = await fetch(`${httpBase()}/api/player/crew/claim-milestone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, tier })
    }).then(r => r.json());
    if (res && res.ok) {
      toast(`🎉 Tier ${tier} Milestone Claimed! +${res.xpAwarded} XP · +${res.coinsAwarded} Coins!`);
      openCrewModal('my');
      fetchAndRenderRetention();
    } else {
      toast(res.error || 'Could not claim milestone');
    }
  } catch (e) {
    toast('Error claiming crew milestone');
  }
};

window.joinCrewAction = async function(crewId) {
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');
  const name = prefs.name || 'RACER';
  try {
    const res = await fetch(`${httpBase()}/api/player/crew/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, name, crewId })
    }).then(r => r.json());
    if (res && res.ok) {
      toast(`🏁 Joined [${res.tag}] ${res.name}!`);
      openCrewModal('my');
    } else {
      toast(res.error || 'Failed to join crew');
    }
  } catch (e) {
    toast('Error joining crew');
  }
};

window.handleCreateCrewSubmit = async function(e) {
  e.preventDefault();
  const uid = (window.SRAccount && typeof window.SRAccount.name === 'function' && window.SRAccount.name()) ? window.SRAccount.name() : (prefs.pid || prefs.name || 'guest');
  const name = prefs.name || 'RACER';
  const crewName = $('cf-name').value.trim();
  const tag = $('cf-tag').value.trim().toUpperCase();
  const motto = $('cf-motto').value.trim();
  const badge = $('cf-badge').value;
  const color = $('cf-color').value;

  try {
    const res = await fetch(`${httpBase()}/api/player/crew/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, name, crewName, tag, motto, badge, color })
    }).then(r => r.json());
    if (res && res.ok) {
      toast(`🏁 Syndicate [${res.crew.tag}] ${res.crew.name} Created!`);
      openCrewModal('my');
    } else {
      const errEl = $('cf-err');
      if (errEl) errEl.textContent = res.error === 'tag_taken' ? 'Tag is already taken!' : (res.error || 'Validation error');
    }
  } catch (e) {
    const errEl = $('cf-err');
    if (errEl) errEl.textContent = 'Connection error creating crew.';
  }
};

// Wire up modal openers and close buttons
const acadBtn = $('academy-btn'); if (acadBtn) acadBtn.addEventListener('click', openDrivingAcademy);
const acadClose = $('academy-close'); if (acadClose) acadClose.addEventListener('click', () => { $('academy-dlg').hidden = true; });
const bdgBtn = $('badges-btn'); if (bdgBtn) bdgBtn.addEventListener('click', openBadgesShowcase);
const bdgClose = $('badges-close'); if (bdgClose) bdgClose.addEventListener('click', () => { $('badges-dlg').hidden = true; });
const bntBtn = $('bounties-btn'); if (bntBtn) bntBtn.addEventListener('click', openBountiesModal);
const bntClose = $('bounties-close'); if (bntClose) bntClose.addEventListener('click', () => { $('bounties-dlg').hidden = true; });

// Wire up Ghost selector cycling
const GHOST_MODES = ['pb', 'rival', 'record', 'off'];
let currentGhostModeIdx = 0;
const ghostToggleBtn = $('lobby-ghost-toggle-btn');
if (ghostToggleBtn) {
  ghostToggleBtn.addEventListener('click', () => {
    currentGhostModeIdx = (currentGhostModeIdx + 1) % GHOST_MODES.length;
    const mode = GHOST_MODES[currentGhostModeIdx];
    try { localStorage.setItem('sr_ghost_mode', mode); } catch (e) {}
    const labels = {
      pb: '👻 GHOST: PB (ON)',
      rival: '👻 GHOST: RIVAL',
      record: '👑 GHOST: RECORD',
      off: '🚫 GHOST: OFF'
    };
    ghostToggleBtn.textContent = labels[mode] || '👻 GHOST: PB';
    toast(`Ghost target set to: ${mode.toUpperCase()}`);
  });
}
function renderRecent(rows) {
  const el = $('recent-line'); if (!el) return;
  if (!rows || !rows.length) { el.hidden = true; return; }
  const r = rows[0];
  const mn = (CORE.MAPS[r.map] && CORE.MAPS[r.map].name) || 'CIRCUIT';
  el.hidden = false;
  el.textContent = '🏁 ' + r.name + ' just finished ' + mn + ' — ' + fmtTime(r.t) +
    (rows.length > 1 ? '  ·  +' + (rows.length - 1) + ' more recent' : '');
}
function paintDailyHeader() {
  const box = $('daily-box'); if (!box || !dailyInfoCache) return;
  const M = CORE.MAPS[dailyInfoCache.map];
  box.hidden = false;
  $('daily-title').textContent = (tI18n('daily') || '📅 DAILY CHALLENGE') + ' — ' + (M ? M.name : 'CIRCUIT');
  const b = $('daily-play'); if (b) b.onclick = () => net.send({ type: 'map', map: dailyInfoCache.map });
  const ds = $('daily-share'); if (ds) ds.onclick = () => { track('share', dailyInfoCache && dailyInfoCache.map, { channel: 'daily' }); const top = (dailyRowsCache || [])[0]; const msg = `📅 DAILY CHALLENGE — ${(CORE.MAPS[dailyInfoCache.map] || {}).name || ''}\n🎯 ${top ? 'Target ' + fmtTime(top.t) : 'No time yet'}\nBeat it: ${location.origin}/`; if (navigator.share) navigator.share({ text: msg }).catch(() => {}); else { copyText(msg); toast('Daily challenge copied!'); } };
}
let dailyRowsCache = [];
function renderDailyBoard(rows) {
  dailyRowsCache = rows || [];
  const el = $('daily-lb'); if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = '<div class="lb-empty">No times today yet — set the first!</div>'; const m0 = $('daily-meta'); if (m0) m0.textContent = '🎯 No target yet — set the first time!'; return; }
  el.innerHTML = rows.map((r, i) =>
    '<div class="lb-row"><span class="lb-pos">' + (i + 1) + '</span><span class="lb-name">' +
    escapeHtml(r.name) + '</span><span class="lb-time">' + fmtTime(r.t) + '</span></div>').join('');
  const meta = $('daily-meta'); // v59 target / your time / rank / % behind
  if (meta) {
    const me = rows.find((r) => r.pid && prefs.pid && r.pid === prefs.pid) || rows.find((r) => r.name === prefs.name);
    if (!me) meta.textContent = '🎯 Target ' + fmtTime(rows[0].t) + ' · No time yet — race now!';
    else {
      const gap = ((me.t - rows[0].t) / Math.max(0.001, rows[0].t)) * 100;
      meta.textContent = '🎯 Target ' + fmtTime(rows[0].t) + ' · You #' + (rows.indexOf(me) + 1) + ' ' + fmtTime(me.t) + (rows.indexOf(me) === 0 ? ' 👑' : ' (+' + gap.toFixed(1) + '%)');
    }
    meta.textContent += ' · 🎁 +150 XP first finish · ⏳ ' + utcResetCountdown();
  } else if (meta) meta.textContent += ' · 🎁 +150 XP first finish · ⏳ ' + utcResetCountdown();
}
function utcResetCountdown() {
  const now = new Date();
  const mid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  const m = Math.floor((mid - now.getTime()) / 60000);
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function weekResetCountdown() {
  const now = new Date();
  const day = now.getUTCDay(); // Monday reset
  const d = (8 - ((day + 6) % 7)) % 7 || 7;
  const mon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d, 0, 0, 0);
  return Math.max(0, Math.floor((mon - now.getTime()) / 86400000)) + 'd';
}
setInterval(pollLobbyExtras, 8000);
setTimeout(pollLobbyExtras, 1200);

// v40 analytics beacons (aggregate-only server counters; fire-and-forget)
// v43: also carries client-side crash reports so /stats shows them remotely
let lastErrSent = '';
function track(e, map, m) {
  if (e === 'err') { if (m === lastErrSent) return; lastErrSent = m; } // no beacon loops on repeat errors
  try {
    const pId = (typeof prefs !== 'undefined' && prefs && prefs.pid) ? prefs.pid : null;
    let body = { e, map, pid: pId };
    if (typeof m === 'object' && m !== null) {
      body = Object.assign(body, m);
    } else if (m !== undefined) {
      body.m = m;
    }
    fetch(httpBase() + '/a', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).catch(() => {});
  } catch (err) {}
}
track('visit');
window.addEventListener('appinstalled', () => track('inst'));
window.addEventListener('error', (ev) => track('err', undefined, String((ev && ev.message) || 'error')));
window.addEventListener('unhandledrejection', (ev) => track('err', undefined, 'promise: ' + String((ev.reason && ev.reason.message) || ev.reason || 'rejection')));

// ---------------------------------------------------------------------------
// v48 achievements (device-local medals) + photo-finish share. Purely additive.
// ---------------------------------------------------------------------------
const ACH_DEFS = [
  { id: 'firstwin', icon: '🥇', name: 'First Win' },
  { id: 'streak3', icon: '🔥', name: '3-Day Streak' },
  { id: 'fastlap', icon: '⚡', name: 'Lap Under 0:30' },
  { id: 'ghostwin', icon: '👻', name: 'Ghost Beaten' },
  { id: 'allmaps', icon: '🌍', name: 'All 5 Circuits' },
];
function evalAchievements(facts, have) {
  const out = [];
  if (facts.wins >= 1 && !have.firstwin) out.push('firstwin');
  if (facts.streak >= 3 && !have.streak3) out.push('streak3');
  if (facts.fastLap && !have.fastlap) out.push('fastlap');
  if (facts.ghostBeat && !have.ghostwin) out.push('ghostwin');
  if ((facts.mapsDone || []).length >= 5 && !have.allmaps) out.push('allmaps');
  return out;
}
function achLoad() { try { return JSON.parse(localStorage.getItem('sr_ach') || '{}'); } catch (e) { return {}; } }
// ===========================================================================
// v60 RETENTION ENGINE — device-local profile built ONLY from server race
// events (results/lap/crash). No frontend-claimed results; no pay-to-win.
// ===========================================================================
function Pget() {
  let p = null; try { p = JSON.parse(localStorage.getItem('sr_prof') || 'null'); } catch (e) {}
  if (!p) p = { races: 0, wins: 0, loss: 0, pod: 0, xp: 0, ach: {}, mis: {}, streak: 0, streakMax: 0, play: 0, maps: {}, bestRace: {}, bestLap: {}, daily: 0, cleanWin: 0, ghostWin: 0, misDone: 0, week: null, last: null, rival: null };
  return p;
}
function Psave(p) { try { localStorage.setItem('sr_prof', JSON.stringify(p)); } catch (e) {} }
function levelOf(xp) { return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1; }
const TITLES = ['ROOKIE', 'RACER', 'PRO', 'ELITE', 'LEGEND'];
function titleOf(p) { return TITLES[Math.min(TITLES.length - 1, Math.floor((levelOf(p.xp) - 1) / 2))]; }
const ACHV = [
  ['race1', '🏁', 'First Race', 'complete a race', (p) => p.races >= 1],
  ['win1', '🏆', 'First Win', 'win a race', (p) => p.wins >= 1],
  ['pod10', '🥇', 'Podium Hunter', '10 podiums', (p) => p.pod >= 10],
  ['streak5', '🔥', 'Hot Driver', '5 win streak', (p) => p.streakMax >= 5],
  ['lap30', '⚡', 'Speed Demon', 'lap under 0:30', (p) => Object.values(p.bestLap).some((t) => t < 30)],
  ['race25', '🏎️', 'Road Warrior', '25 races', (p) => p.races >= 25],
  ['win50', '👑', 'Champion', '50 wins', (p) => p.wins >= 50],
  ['clean', '🎯', 'Perfect Run', 'win without crashing', (p) => p.cleanWin],
  ['maps5', '🌍', 'World Tour', 'race all 5 maps', (p) => Object.keys(p.maps).length >= 5],
  ['ghost1', '👻', 'Ghost Buster', 'beat a shared ghost', (p) => p.ghostWin],
  ['daily1', '📅', 'Daily Driver', 'complete a daily', (p) => p.daily >= 1],
  ['mission3', '🎯', 'Mission Pro', '3 missions done', (p) => p.misDone >= 3],
  ['lvl5', '⭐', 'Rising Star', 'reach level 5', (p) => levelOf(p.xp) >= 5],
  ['lvl10', '🌟', 'Veteran', 'reach level 10', (p) => levelOf(p.xp) >= 10],
];
const MISSIONS = [
  ['m_r3', '🏁 Complete 3 races', (p) => p.races, 3],
  ['m_w2', '🏆 Win 2 races', (p) => p.wins, 2],
  ['m_l40', '⚡ Lap under 0:40', (p) => (Object.values(p.bestLap).some((t) => t < 40) ? 1 : 0), 1],
  ['m_p3', '🥇 3 podiums', (p) => p.pod, 3],
  ['m_one5', '🛣️ 5 races on one map', (p) => Math.max(0, ...Object.values(p.maps).concat([0])), 5],
];
const UNLOCK_LVL = { trail: [1, 2, 4], decal: [1, 3, 6], wheels: [1, 5, 8] }; // value -> required level
function cosUnlocked(k, v) { const arr = UNLOCK_LVL[k]; return v < arr.length && levelOf(Pget().xp) >= arr[v]; }
function weekKey() { const d = new Date(); const onejan = new Date(d.getFullYear(), 0, 1); const w = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7); return d.getFullYear() + '-W' + w; }
let v60Race = { crashed: false, start: 0, counted: false };
function v60OnGo() { v60Race = { crashed: false, start: performance.now(), counted: false }; }
function v60OnCrashMine() { v60Race.crashed = true; }
function v60OnBestLap(mapId, t) {
  const p = Pget();
  if (p.bestLap[mapId] == null || t < p.bestLap[mapId]) { p.bestLap[mapId] = t; p.xp += 10; Psave(p); }
}
function v60OnResults(order, mapId) {
  const p = Pget();
  const mine = order.find((c) => (c.slot || c.s) === mySlot);
  if (!mine || v60Race.counted || TT.on) return null; // v61: TT/practice don't farm stats
  v60Race.counted = true;
  const won = order[0] && (order[0].slot || order[0].s) === mySlot && mine.finished;
  const pod = mine.finished && order.slice(0, 3).some((c) => (c.slot || c.s) === mySlot);
  p.races++; p.maps[mapId] = (p.maps[mapId] || 0) + 1;
  p.play += Math.round((performance.now() - v60Race.start) / 1000);
  if (won) { p.wins++; p.streak++; p.streakMax = Math.max(p.streakMax, p.streak); if (!v60Race.crashed) p.cleanWin = 1; }
  else { p.loss++; p.streak = 0; }
  if (pod) p.pod++;
  if (mine.finished && mine.t != null && (p.bestRace[mapId] == null || mine.t < p.bestRace[mapId])) { p.bestRace[mapId] = mine.t; p.xp += 40; }
  p.xp += 20 + (won ? 50 : 0) + (pod ? 30 : 0);
  const wk = weekKey();
  if (!p.week || p.week.k !== wk) p.week = { k: wk, races: 0, wins: 0, best: null };
  p.week.races++; if (won) p.week.wins++;
  if (mine.finished && mine.t != null && (p.week.best == null || mine.t < p.week.best)) p.week.best = mine.t;
  // missions
  MISSIONS.forEach(([id]) => { if (!p.mis[id]) p.mis[id] = 0; });
  let newMis = 0;
  MISSIONS.forEach(([id, , fn, goal]) => { if (!p.mis[id] && fn(p) >= goal) { p.mis[id] = 1; newMis++; } });
  if (newMis) { p.misDone += newMis; p.xp += 75 * newMis; }
  // achievements
  const news = [];
  ACHV.forEach(([id]) => { if (!p.ach[id]) { const d = ACHV.find((a) => a[0] === id); if (d[4](p)) { p.ach[id] = 1; p.xp += 100; news.push(d); } } });
  p.last = Date.now();
  Psave(p);
  // motivation (one line, real data only)
  let motiv = '';
  if (won && p.streak >= 2) motiv = '🔥 ' + p.streak + ' WIN STREAK!';
  else if (!won && mine.finished && mine.t != null) {
    const pb = p.bestRace[mapId];
    if (pb != null && mine.t - pb < 1.5 && mine.t > pb) motiv = '⏱️ Only ' + (mine.t - pb).toFixed(2) + 's from your personal best!';
  }
  news.forEach((d) => toast('🏅 ' + d[2] + ' unlocked!'));
  return { won, pod, motiv, news, streak: p.streak };
}
const MAP_DIFF = [1, 2, 2, 3, 3]; // v60 map selector info
function fillMapMeta() {
  const p = Pget();
  document.querySelectorAll('.map-btn').forEach((b) => {
    const m = parseInt(b.dataset.map, 10);
    let el = b.querySelector('.map-meta');
    if (!el) { el = document.createElement('div'); el.className = 'map-meta'; b.appendChild(el); }
    const best = p.bestRace[m];
    const bl = p.bestLap && p.bestLap[m];
    let lastT = null; try { lastT = JSON.parse(localStorage.getItem('sr_last_' + m) || 'null'); } catch (e) {}
    el.textContent = '⭐'.repeat(MAP_DIFF[m] || 1) + (best != null ? ' · 🏁 ' + fmtTime(best) : ' · no time yet') + (bl != null ? ' · ⚡ ' + fmtTime(bl) : '') + (lastT != null ? ' · LAST ' + fmtTime(lastT) : '') + ' · ' + (p.maps[m] || 0) + ' races · ⏱️ TT · 🎮 ALL MODES';
  });
}
function renderProfile() {
  const box = $('profile-box'); if (!box) return;
  const p = Pget();
  const lv = levelOf(p.xp);
  $('prof-title').textContent = 'Lv' + lv + ' ' + titleOf(p);
  const wr = p.races ? Math.round((p.wins / p.races) * 100) : 0;
  const favMap = Object.entries(p.maps).sort((a, b) => b[1] - a[1])[0];
  $('prof-grid').innerHTML =
    '<span>🏎️ RACES <b>' + p.races + '</b></span><span>🏆 WINS <b>' + p.wins + '</b></span>' +
    '<span>🥇 PODIUMS <b>' + p.pod + '</b></span><span>📈 WIN RATE <b>' + wr + '%</b></span>' +
    '<span>🔥 STREAK <b>' + p.streak + '</b></span><span>🕹️ TIME <b>' + Math.round(p.play / 60) + 'm</b></span>' +
    (favMap ? '<span>❤️ FAV <b>' + ((CORE.MAPS[favMap[0]] || {}).name || '').split(' ')[0] + '</b></span>' : '') +
    '<span>📅 DAILIES <b>' + p.daily + '</b></span>';
  const need = 100 * lv * lv, base = 100 * (lv - 1) * (lv - 1);
  const pct = Math.min(100, Math.round(((p.xp - base) / (need - base)) * 100));
  const xb = $('prof-xp'); xb.querySelector('i').style.width = pct + '%';
  $('prof-xp-txt').textContent = 'LEVEL ' + lv + ' · ' + p.xp + ' / ' + need + ' XP';
  $('prof-ach').innerHTML = ACHV.map(([id, ic, nm, ds]) => '<span class="ach' + (p.ach[id] ? ' on' : '') + '" title="' + nm + ' — ' + ds + '">' + ic + '</span>').join('');
  $('prof-mis').innerHTML = MISSIONS.map(([id, nm, fn, goal]) => {
    const cur = Math.min(goal, fn(p));
    return '<div class="mis' + (p.mis[id] ? ' done' : '') + '">' + nm + ' <b>' + cur + '/' + goal + '</b>' + (p.mis[id] ? ' ✅' : '') + '</div>';
  }).join('');
  // weekly summary
  const wk = $('weekly-box');
  if (wk) {
    if (p.week && p.week.races > 0) {
      wk.hidden = false;
      $('weekly-txt').innerHTML = '🏁 ' + p.week.races + ' races · 🏆 ' + p.week.wins + ' wins' + (p.week.best != null ? ' · ⚡ best ' + fmtTime(p.week.best) : '') + ' · 🏅 ' + Object.keys(p.ach).length + '/' + ACHV.length;
    } else wk.hidden = true;
  }
  // rival (from cached leaderboard rows when available)
  renderRival(p);
  const br = $('beat-rival');
  if (br) br.onclick = () => {
    if (p.rival && p.rival.map != null) {
      net.send({ type: 'map', map: p.rival.map });
      selectedMap = p.rival.map;
      toast('⚔️ Rival\'s track loaded — START when ready!');
    }
  };
  if (typeof document !== 'undefined' && document.querySelectorAll) fillMapMeta();
  // welcome back (once per session, >12h away, non-annoying single line)
  const wb = $('welcome-back');
  if (wb && p.last && Date.now() - p.last > 12 * 3600 * 1000 && !window.__wbShown) {
    window.__wbShown = true;
    wb.hidden = false;
    wb.textContent = '👋 WELCOME BACK! ' + (p.rival ? 'Rival ' + p.rival.name + ' is ' + (p.rival.t != null ? fmtTime(p.rival.t) : '') + ' · ' : '') + 'Streak ' + p.streak + ' · Daily challenge available!';
  }
}
function renderRival(p) {
  const el = $('prof-rival'); if (!el) return;
  const rows = dailyRowsCache && dailyRowsCache.length ? dailyRowsCache : (window.__lbRows || []);
  const mapId = (dailyInfoCache && dailyInfoCache.map) || selectedMap || 0;
  const myBest = p.bestRace[mapId];
  const above = rows.filter((r) => !(r.pid && r.pid === prefs.pid)).filter((r) => myBest == null || r.t < myBest);
  const rival = above.length ? above[above.length - 1] : (rows[0] && !(rows[0].pid === prefs.pid) ? rows[0] : null);
  if (rival) {
    p.rival = { name: rival.name, t: rival.t, map: mapId }; Psave(p);
    el.innerHTML = '️ RIVAL: <b>' + escapeHtml(rival.name) + '</b> ' + fmtTime(rival.t) + (myBest != null ? ' · you ' + (myBest - rival.t >= 0 ? '+' : '') + (myBest - rival.t).toFixed(2) + 's' : ' · set a time to challenge!');
  } else el.innerHTML = '⚔️ Rival appears when the board has times.';
}
// v59 lightweight progression: device-local stats -> level + title (cosmetic only)
function statLoad() { try { return JSON.parse(localStorage.getItem('sr_stats') || '{}'); } catch (e) { return {}; } }
function statBump(k) { const st = statLoad(); st[k] = (st[k] || 0) + 1; try { localStorage.setItem('sr_stats', JSON.stringify(st)); } catch (e) {} return st; }
function playerTitle() {
  const st = statLoad();
  const pts = (st.races || 0) * 10 + (st.wins || 0) * 25 + Object.keys(achLoad()).length * 50;
  const lv = Math.floor(Math.sqrt(Math.max(0, pts) / 25)) + 1;
  const T = ['ROOKIE', 'RACER', 'PRO', 'ELITE', 'LEGEND'];
  return { lv, title: T[Math.min(T.length - 1, Math.floor((lv - 1) / 2))] };
}
function paintAchievements() {
  const row = $('ach-row'); if (!row) return;
  const have = achLoad();
  row.innerHTML = ACH_DEFS.map((a) =>
    '<span class="ach' + (have[a.id] ? ' on' : '') + '" title="' + a.name + '">' + a.icon + '</span>').join('');
}

let hdLoaded = false;
function applyHD() {
  const on = prefs.hdLobby !== false && prefs.quality !== 'low';
  document.body.classList.toggle('hd', on);
  if (on && !hdLoaded) {
    hdLoaded = true;
    const kick = () => setTimeout(() => {
      const im = new Image();
      im.onload = () => { const el = $('lobby-bg'); if (el) el.style.backgroundImage = "url('img/lobby-bg.jpg')"; };
      im.src = 'img/lobby-bg.jpg';
    }, 1200);
    if (document.readyState === 'complete') kick(); else window.addEventListener('load', kick);
  }
}
function achCheck(extra) {
  extra = extra || {};
  try {
    if (extra.map != null) {
      let maps = JSON.parse(localStorage.getItem('sr_maps_done') || '[]');
      if (!maps.includes(extra.map)) { maps.push(extra.map); localStorage.setItem('sr_maps_done', JSON.stringify(maps)); }
    }
    if (extra.win) localStorage.setItem('sr_wins', String((parseInt(localStorage.getItem('sr_wins') || '0', 10) || 0) + 1));
    if (extra.lapT != null && extra.lapT < 30) localStorage.setItem('sr_fastlap', '1');
    const days = JSON.parse(localStorage.getItem('sr_days') || '[]');
    const facts = {
      wins: parseInt(localStorage.getItem('sr_wins') || '0', 10) || 0,
      streak: computeStreak(days, new Date().toISOString().slice(0, 10)),
      fastLap: !!localStorage.getItem('sr_fastlap'),
      ghostBeat: !!extra.ghostBeat,
      mapsDone: JSON.parse(localStorage.getItem('sr_maps_done') || '[]'),
    };
    const have = achLoad();
    const news = evalAchievements(facts, have);
    if (news.length) {
      const now = Date.now();
      news.forEach((id) => { have[id] = now; });
      localStorage.setItem('sr_ach', JSON.stringify(have));
      news.forEach((id) => { const d = ACH_DEFS.find((a) => a.id === id); if (d) toast('🎖️ ' + d.name + ' unlocked!'); });
    }
    paintAchievements();
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// v44: lobby i18n (EN/TE/HI) + Founders Cup panel + 🔥 streak badge. Additive.
// ---------------------------------------------------------------------------
function tI18n(k) {
  const D = window.SRI18N; if (!D) return null;
  const L = D[prefs.lang] || D.en;
  return L[k] || D.en[k] || null;
}
function applyI18n() {
  if (!window.SRI18N) return;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const s = tI18n(el.getAttribute('data-i18n'));
    if (s) el.textContent = s;
  });
  const lb = $('lang-btn'); if (lb) lb.textContent = '🌐 ' + (window.SRI18N_LABEL[prefs.lang] || 'EN');
  paintDailyHeader();
}
// pure + testable: consecutive play days ending today (or yesterday if not yet played today)
function computeStreak(days, todayStr) {
  const set = new Set(days);
  let n = 0;
  const d = new Date(todayStr + 'T00:00:00Z');
  if (!set.has(todayStr)) d.setUTCDate(d.getUTCDate() - 1);
  for (;;) {
    const k = d.toISOString().slice(0, 10);
    if (!set.has(k)) break;
    n++; d.setUTCDate(d.getUTCDate() - 1);
    if (n > 365) break;
  }
  return n;
}
function updateStreak() {
  const el = $('streak-badge'); if (!el) return;
  let days = []; try { days = JSON.parse(localStorage.getItem('sr_days') || '[]'); } catch (e) {}
  const n = computeStreak(days, new Date().toISOString().slice(0, 10));
  if (n >= 2) { el.hidden = false; el.textContent = '🔥' + n; el.title = n + ' day streak'; }
  else el.hidden = true;
}
function recordPlayDay() {
  try {
    const k = new Date().toISOString().slice(0, 10);
    let days = JSON.parse(localStorage.getItem('sr_days') || '[]');
    if (!days.includes(k)) { days.push(k); localStorage.setItem('sr_days', JSON.stringify(days.slice(-40))); }
  } catch (e) {}
  updateStreak();
}
function renderCup(rows) {
  const box = $('cup-box'); if (!box) return;
  if (!rows || !rows.length) { box.hidden = true; return; }
  box.hidden = false;
  $('cup-lb').innerHTML = rows.map((r, i) =>
    '<div class="lb-row"><span class="lb-pos">' + (i + 1) + '</span><span class="lb-name">' +
    escapeHtml(r.name) + ' · ' + escapeHtml(((CORE.MAPS[r.map] || {}).name || '')) +
    '</span><span class="lb-time">' + fmtTime(r.t) + '</span></div>').join('');
}
// v44 wiring: language cycler + cup share
(function () {
  const langBtn = $('lang-btn');
  if (langBtn) langBtn.addEventListener('click', () => {
    const order = ['en', 'te', 'hi'];
    prefs.lang = order[(order.indexOf(prefs.lang || 'en') + 1) % 3];
    savePrefs(); applyI18n();
  });
  const cupBtn = $('cup-share');
  if (cupBtn) cupBtn.addEventListener('click', () => {
    track('share', undefined, { channel: 'cup' });
    const top = $('cup-lb') && $('cup-lb').querySelector('.lb-time');
    const msg = '🏆 Sridhar Rush FOUNDERS CUP this week' + (top ? ' — best: ' + top.textContent : '') + '! Beat it: ' + location.origin + '/';
    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
  });
  applyI18n();
  updateStreak();
  paintAchievements();
  applyHD();
  renderProfile();
  fillMapMeta();
})();

// v48 photo-finish: render results + logo into a downloadable PNG
(function () {
  const phBtn = $('photo-btn'); if (!phBtn) return;
  phBtn.addEventListener('click', () => {
    try {
      const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
      track('share', mapId, { channel: 'photo' });
      const M = CORE.MAPS[mapId] || CORE.MAPS[0];
      const c = document.createElement('canvas'); c.width = 1080; c.height = 1080;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, 1080);
      grad.addColorStop(0, '#0a0f1e'); grad.addColorStop(0.55, '#141a2e'); grad.addColorStop(1, '#05070c');
      g.fillStyle = grad; g.fillRect(0, 0, 1080, 1080);
      g.textAlign = 'center';
      g.fillStyle = '#35e0ff'; g.font = '700 64px Orbitron, "Segoe UI", sans-serif';
      g.fillText('SRIDHAR RUSH', 540, 160);
      g.fillStyle = '#ff2038'; g.font = '700 40px Orbitron, "Segoe UI", sans-serif';
      g.fillText(M.name, 540, 225);
      g.fillStyle = '#e8ecf2'; g.font = '700 46px "Segoe UI", sans-serif';
      (lastResults || []).slice(0, 5).forEach((r, i) => {
        g.fillText((i + 1) + '.  ' + (r.name || 'P' + r.slot) + '   ' + (r.t != null ? fmtTime(r.t) : 'DNF'), 540, 400 + i * 74);
      });
      g.fillStyle = 'rgba(232,236,242,.65)'; g.font = '30px "Segoe UI", sans-serif';
      g.fillText(new Date().toLocaleDateString() + '  ·  race your friends at sridhar-drift.vercel.app', 540, 1016);
      const save = () => {
        const a = document.createElement('a');
        a.download = 'sridhar-rush-results.png';
        a.href = c.toDataURL('image/png');
        a.click();
        toast('📸 Photo saved — share it!');
      };
      const logo = new Image();
      logo.onload = () => { try { g.drawImage(logo, 440, 780, 200, 200); } catch (e) {} save(); };
      logo.onerror = save;
      logo.src = 'img/logo.png';
    } catch (e) { toast('Photo unavailable'); }
  });
})();

// v41 "race my ghost" deep link: ?g=ID loads a friend's ghost for the matching map
(function () {
  const id = new URLSearchParams(location.search).get('g');
  if (!id) return;
  fetch(httpBase() + '/ghost?id=' + encodeURIComponent(id))
    .then((r) => (r.ok ? r.json() : null))
    .then((g) => {
      if (g && Array.isArray(g.data) && g.data.length > 9) {
        remoteGhost = { map: g.map, data: g.data };
        // v51 fix: a ghost link must also switch the room to the ghost's map,
        // otherwise the friend races the wrong circuit and never sees the ghost.
        const pick = () => { if (net.isOpen()) net.send({ type: 'map', map: g.map }); };
        pick(); setTimeout(pick, 1500);
        const mn = (CORE.MAPS[g.map] || {}).name || '';
        toast('👻 Racing ' + (g.name || 'a friend') + "'s ghost on " + mn + '!');
      }
    })
    .catch(() => {});
})();

let qrDrawnFor = '';
function drawQR(url) {
  if (qrDrawnFor === url) return;
  qrDrawnFor = url;
  try {
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    const n = qr.getModuleCount();
    const canvas = $('qr-canvas');
    const px = Math.floor(196 / n);
    const size = px * n;
    canvas.width = canvas.height = size + px * 4;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#101014';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + 2) * px, (r + 2) * px, px, px);
  } catch (e) {}
}

function processEvents(snap) {
  for (const e of snap.events || []) {
    switch (e.type) {
      case 'count': showCount(String(e.n)); beep(392, 0.14, 'square', 0.24); break;
      case 'go': showCount('GO!'); beep(784, 0.5, 'square', 0.28); ghostStart(snap.map != null ? snap.map : builtMapId); v60OnGo(); break;
      case 'crash': onCrashFX(e.x, e.z, e.s); if (e.slot === mySlot) v60OnCrashMine(); break;
      case 'lap':
        if (e.slot === mySlot) { ghostSave(snap.map != null ? snap.map : builtMapId, !!e.best); recordPlayDay(); achCheck({ map: snap.map, lapT: e.t }); }
        if (e.slot === mySlot && e.best) v60OnBestLap(snap.map != null ? snap.map : builtMapId, e.t);
        toast(`P${e.slot} lap ${e.n} — ${fmtTime(e.t)}${e.best ? '  ★ BEST' : ''}`); break;
      case 'finallap': toast(`🔥 P${e.slot}: FINAL LAP!`); beep(660, 0.14, 'square', 0.2); break;
      case 'elim': setBanner(`❌ P${e.slot} ELIMINATED`); beep(160, 0.3, 'sawtooth', 0.2); break;
      case 'win':
        if (e.slot === mySlot) {
          track('fin', snap.map != null ? snap.map : builtMapId);
          achCheck({ win: true, map: snap.map });
        }
        setBanner(e.multi ? `🏁 PLAYER ${e.slot} WINS!` : `🏁 FINISH — ${fmtTime(e.t)}`); confetti(); winJingle(); break;
      case 'pu': { const nm = ['⚡ BOOST', '🛡️ SHIELD', '🌀 SLOW'][e.ptype] || 'PU'; toast(`P${e.slot} grabbed ${nm}!`); beep(980, 0.12, 'square', 0.2); break; }
      case 'respawn': if (e.slot === mySlot) { toast('🔄 Back on track'); beep(220, 0.2, 'sawtooth', 0.18); } break;
      case 'rematch': toast(`🔁 Rematch vote ${e.n}/${e.total}`); break;
      case 'finished':
        if (e.slot === mySlot) {
          track('fin', snap.map != null ? snap.map : builtMapId);
          let gb = false;
          if (remoteGhost && remoteGhost.map === (snap.map != null ? snap.map : builtMapId) && remoteGhost.data.length) {
            const gt = remoteGhost.data[remoteGhost.data.length - 1][0];
            gb = e.t != null && e.t < gt;
          }
          achCheck({ map: snap.map, finishT: e.t, ghostBeat: gb });
          if (gb) { const pp = Pget(); pp.ghostWin = 1; Psave(pp); }
          if (TT.on) {
            // v61: save PB ghost from this genuine server-timed run when it's a new best
            const mId = snap.map != null ? snap.map : builtMapId;
            let prevBest = null; try { prevBest = JSON.parse(localStorage.getItem('sr_best_' + mId) || 'null'); } catch (e2) {}
            if (!TT.practice && e.t != null && (prevBest == null || e.t < prevBest) && ghostRec.length > 10) {
              try { localStorage.setItem('sr_ghost_' + mId, JSON.stringify(ghostRec)); } catch (e2) {}
            }
            showTTResults(null, e.t);
          }
        }
        toast(`P${e.slot} finished — ${fmtTime(e.t)}`); break;
      case 'results': showResults(e.order); break;
    }
  }
  if (snap.banner && snap.banner.seq !== lastBannerSeq && snap.banner.text) lastBannerSeq = snap.banner.seq;
}

const wantedRoom = urlParam('room');
const SPEC_ROOM = urlParam('watch'); // v64 read-only spectator

// Route mobile phone/touch devices opening a room link to the mobile controller pad
(function () {
  if (typeof window === 'undefined') return;
  const isTouchPhone = ('ontouchstart' in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0))
    && (window.innerWidth <= 768 || window.innerHeight <= 500 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
  if (wantedRoom && isTouchPhone && !SPEC_ROOM && !urlParam('ch') && !urlParam('g') && !urlParam('screen')) {
    location.replace('/controller.html?room=' + encodeURIComponent(wantedRoom));
  }
})();
// build marker — must match the server's /version build. If the website and
// the relay run different code you get "ghost" physics; show a warning then.
const BUILD = 'v78';
(function () {
  try {
    const cfg = window.SERVER_URL || 'local';
    const base = cfg === 'local' ? location.origin : cfg.replace(/\/$/, '');
    fetch(base + '/version').then((r) => r.json()).then((v) => {
      // Only a GEOMETRY mismatch is dangerous (it caused the old off-track bug).
      // A build-tag difference alone just means some newer features are absent
      // on one side; the race itself is safe, so don't nag with a banner.
      const geomMismatch = v && v.geom && CORE.GEOM_ID && v.geom !== CORE.GEOM_ID;
      // v77 BUG-011: cosmetic-only deploys — reload idle tabs on BUILD mismatch (once per build)
      if (!geomMismatch && v && v.build && v.build !== BUILD && !sessionStorage.getItem('sr_br_' + v.build) && (!latest || latest.state === 'waiting')) {
        sessionStorage.setItem('sr_br_' + v.build, '1');
        location.replace(location.pathname + '?r=' + Date.now());
        return;
      }
      if (geomMismatch) {
        const key = 'sr_reload_' + (v.build || 'x');
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1');
          location.replace(location.pathname + '?r=' + Date.now());
          return;
        }
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;background:#b26a00;color:#fff;text-align:center;padding:7px;font:600 13px system-ui,sans-serif;letter-spacing:.4px;';
        d.textContent = '⚠ UPDATE STUCK — press ⌘⇧R (hard refresh) once to load the newest tracks';
        document.body.appendChild(d);
      }
    }).catch(() => {});
  } catch (e) {}
})();

const net = new RoomLink({
  onWelcome(msg) {
    mySlot = msg.slot; roomCode = msg.code;
    $('slot-badge').textContent = `YOU ARE PLAYER ${mySlot}`;
    $('slot-badge').className = mySlot === 1 ? 'slot-badge c1' : 'slot-badge c2';
    $('slot-badge').style.display = '';
    setNetBanner(true);
    applyMyColor();
    const qb = $('quickplay-btn');
    if (qb) { qb.disabled = false; qb.textContent = '⚡ QUICK PLAY — find a rival'; }
    if (msg.snapshot) ingestSnapshot(msg.snapshot);
  },
  onMessage(msg) {
    switch (msg.type) {
      case 'state': ingestSnapshot(msg); break;
      case 'lobby': window.__lastLobby = msg.players || []; renderRoomLobby(msg); break;
      case 'weather': if (msg.weather != null) applyWeather(msg.weather); break;
      case 'photo-finish': if (msg.margin != null) triggerPhotoFinish(msg.margin, msg.winnerName, msg.runnerUpName); break;
      case 'need-ready': toast('⚠ ' + (msg.msg || 'not ready yet')); break;
      case 'full': toast('⚠ Room is full (6 max)'); break;
      case 'joined': if (msg.role === 'spec' && !SPEC_ROOM) { mySlot = 0; document.body.classList.add('spec'); toast('👁️ Race in progress — spectating. Drive the next race!'); } break;
      case 'settle': pendingSettle = msg.rows || []; break;
      case 'settle-warn': toast('⚠ Reward sync delayed — server retrying safely.'); break;
      case 'equipped': myEq = msg.eq || myEq; if (typeof sendMeta === 'function') sendMeta(); if (!$('garage-dlg').hidden) openGarage(); toast('🏎️ Loadout equipped'); break;
      case 'bought': toast('🛍️ Purchased! (' + msg.coins + ' coins left)'); if (!$('garage-dlg').hidden) openGarage(); break;
      case 'buy-err': toast('⚠ ' + (msg.msg || 'purchase failed')); break;
      case 'equip-err': toast('⚠ Locked — keep racing to unlock!'); break;
      case 'controller-joined': setConnected(msg.slot, true); toast(`📱 Player ${msg.slot} joystick connected`); break;
      case 'controller-left': setConnected(msg.slot, false); toast(`Player ${msg.slot} joystick disconnected`); break;
      case 'horn': playHorn(); break;
      case 'cam': if (msg.slot === mySlot) cycleCamera(); break;
      case 'pong': {
        const rtt = performance.now() - (msg.t || performance.now());
        pingMs = pingMs < 0 ? rtt : pingMs * 0.7 + rtt * 0.3;
        break;
      }
      case 'searching': {
        const b = $('quickplay-btn');
        if (b) { b.disabled = true; b.textContent = '🔎 Searching for a rival…'; }
        break;
      }
      case 'matched': {
        const b = $('quickplay-btn');
        if (b) { b.disabled = false; b.textContent = '⚡ QUICK PLAY — find a rival'; }
        toast('⚡ Match found!');
        break;
      }
      case 'error': if (msg.code === 'no-room') showRoomError('Room not found — it may have closed. Create a new one!'); break;
      case 'disconnected': setNetBanner(false); break;
    }
  },
  onStatus(s) {
    setNetBanner(s === 'connected');
    $('lobby-conn').textContent = s === 'connected' ? '🟢 connected' : (s === 'connecting' ? '🟡 connecting…' : '🔴 reconnecting…');
  }
});
setInterval(() => { if (net.isOpen()) net.send({ type: 'ping', t: performance.now() }); }, 2000);

// v61 TT overlay actions
const ttAgain = $('tt-again'); if (ttAgain) ttAgain.addEventListener('click', () => { $('tt-overlay').classList.add('hidden'); TT.done = false; net.send({ type: 'restart' }); });
const ttExit = $('tt-exit'); if (ttExit) ttExit.addEventListener('click', () => { $('tt-overlay').classList.add('hidden'); TT.on = false; TT.practice = false; net.send({ type: 'reset' }); const pb2 = $('practice-bar'); if (pb2) pb2.hidden = true; });
const ttLb = $('tt-lb'); if (ttLb) ttLb.addEventListener('click', () => { $('tt-overlay').classList.add('hidden'); TT.on = false; net.send({ type: 'reset' }); });
const prx = $('practice-exit'); if (prx) prx.addEventListener('click', () => { const te = $('tt-exit'); if (te) te.click(); });
const ttShare = $('tt-share'); if (ttShare) ttShare.addEventListener('click', () => {
  const mapId = (latest && latest.map != null) ? latest.map : builtMapId;
  track('share', mapId, { channel: 'tt' });
  let best = null; try { best = JSON.parse(localStorage.getItem('sr_best_' + mapId) || 'null'); } catch (e) {}
  const msg = '⏱️ TIME TRIAL — ' + ((CORE.MAPS[mapId] || {}).name || '') + '\n🏁 ' + (best != null ? fmtTime(best) : '—') + '\nBeat it: ' + location.origin + '/';
  if (navigator.share) navigator.share({ text: msg }).catch(() => {}); else { copyText(msg); toast('Copied!'); }
});
function sendHello() {
  if (SPEC_ROOM) {
    net.connect({ type: 'hello', role: 'spec', room: SPEC_ROOM });
    document.body.classList.add('spec');
    const chip = document.createElement('div'); chip.id = 'spec-chip';
    chip.innerHTML = '👁️ SPECTATING · <button id="spec-leave">LEAVE</button>';
    document.body.appendChild(chip);
    setTimeout(() => { const b = $('spec-leave'); if (b) b.addEventListener('click', () => { location.href = '/'; }); }, 0);
    return;
  }
  net.connect(Object.assign({ type: 'hello', role: 'screen', room: wantedRoom || null }, identityPayload()));
}
function sendMeta() { if (net.isOpen()) net.send(Object.assign({ type: 'meta' }, identityPayload())); }
// v64 first-run onboarding: 15-20 s, input-driven, skippable, remembered
(function () {
  if (SPEC_ROOM) return;
  let done = false; try { done = !!localStorage.getItem('sr_onboard'); } catch (e) {}
  if (done) return;
  const steps = [
    { t: '💻 This browser is your console', k: [] },
    { t: '📱 Scan the QR — your phone becomes the controller (or use keys)', k: [] },
    { t: '🕹️ STEER — press A / D (or ← →)', k: ['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight'] },
    { t: '⛽ ACCELERATE — hold W', k: ['KeyW', 'ArrowUp'] },
    { t: '🔥 NITRO — press SHIFT', k: ['ShiftLeft', 'ShiftRight'] },
    { t: '🌀 DRIFT — press SPACE', k: ['Space'] },
  ];
  let i = 0, timer = null;
  const ov = document.createElement('div');
  ov.id = 'onboard';
  ov.innerHTML = '<div class="ob-card"><div id="ob-text"></div><div class="ob-skip">tap or press the key · <button id="ob-skip">SKIP</button></div></div>';
  document.body.appendChild(ov);
  const finish = () => { try { localStorage.setItem('sr_onboard', '1'); } catch (e) {} window.removeEventListener('keydown', onKey); ov.remove(); if (timer) clearTimeout(timer); };
  const show = () => {
    if (i >= steps.length) { finish(); return; }
    $('ob-text').textContent = (i + 1) + '/4 · ' + steps[i].t;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { i++; show(); }, 6000);
  };
  const onKey = (e) => { if (steps[i] && steps[i].k.includes(e.code)) { i++; show(); } };
  $('ob-skip').addEventListener('click', finish);
  ov.addEventListener('pointerdown', () => { i++; show(); });
  window.addEventListener('keydown', onKey);
  show();
})();
sendHello();

// Quick-Play matchmaking (additive — existing create/join-by-code flows untouched)
const qpBtn = $('quickplay-btn');
if (qpBtn) qpBtn.addEventListener('click', () => {
  if (!net.isOpen()) return;
  qpBtn.disabled = true; qpBtn.textContent = '🔎 Searching…';
  net.send({ type: 'matchmake' });
  setTimeout(() => { // v59: never leave players stuck searching
    if (qpBtn.disabled && latest && latest.state === 'waiting') {
      toast('No rival found — racing AI 🤖');
      net.send({ type: 'start' });
      qpBtn.disabled = false; qpBtn.textContent = '⚡ QUICK PLAY — find a rival';
    }
  }, 8000);
});

function showRoomError(text) {
  $('room-error').textContent = text;
  $('room-error').style.display = '';
  setTimeout(() => { net.closedByUser = false; net.connect({ type: 'hello', role: 'screen', room: null }); }, 1200);
}

let builtMapId = 0;
function ingestSnapshot(snap) {
  const now = performance.now();
  if (snaps.length > 0) {
    snapGaps.push(now - snaps[snaps.length - 1].t);
    if (snapGaps.length > 40) snapGaps.shift();
    if (snapGaps.length >= 10) {
      const mean = snapGaps.reduce((a, b) => a + b, 0) / snapGaps.length;
      const jitter = snapGaps.reduce((a, b) => a + Math.abs(b - mean), 0) / snapGaps.length;
      interpDelay = clamp(120 + jitter * 1.6, 120, 260);
    }
  }
  snaps.push({ t: now, snap });
  if (snaps.length > 150) snaps.splice(0, snaps.length - 150);
  latest = snap;
  processEvents(snap);

  // rebuild world when the room's map changes (while waiting)
  if (snap.map != null && snap.map !== builtMapId && snap.state === 'waiting') {
    builtMapId = snap.map;
    buildWorld(CORE.MAPS[snap.map]);
    camera.position.set(A - 3, 3.4, -14);
    lookTarget.set(A - 2.8, 1, 0);
  }

  // v83 Dynamic weather synchronization from snapshot
  if (snap.weather != null && snap.weather !== currentWeather) {
    applyWeather(snap.weather);
  }

  if (exitBtn) exitBtn.style.display = snap.state === 'waiting' ? 'none' : '';
  const overlay = $('overlay');
  if (snap.state === 'waiting') {
    overlay.classList.remove('hidden');
    $('results').classList.add('hidden');
    updateLobby(snap);
  } else {
    overlay.classList.add('hidden');
  }
}

function setConnected(slot, on) {
  const pill = $(`pill-p${slot}`);
  if (pill) pill.classList.toggle('on', on);
  if (lastModeLabels === 'coop') {
    $('pill-p1').classList.toggle('on', $('pill-p1').classList.contains('on') || $('pill-p2').classList.contains('on'));
  }
}
let lastModeLabels = '';
function updateModeLabels(mode) {
  if (!mode || mode === lastModeLabels) return;
  lastModeLabels = mode;
  const pill1 = $('pill-p1'), pill2 = $('pill-p2');
  if (mode === 'coop') {
    pill1.querySelector('span').textContent = 'CO-OP · 1 CAR';
    pill2.style.display = 'none';
  } else {
    pill1.querySelector('span').textContent = 'PLAYER 1';
    pill2.querySelector('span').textContent = 'PLAYER 2';
    pill2.style.display = '';
  }
}
function setNetBanner(ok) { $('net-banner').classList.toggle('hidden', ok); }

// ---------------------------------------------------------------------------
// Keyboard fallback (unchanged)
// ---------------------------------------------------------------------------
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code); ensureAudio();
  if (e.code === 'KeyC') cycleCamera();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
let kbAccum = 0;

// v80 mobile solo on-screen touch controls
const touchInput = { l: 0, r: 0, u: 0, d: 0, nitro: false };
function wireTouchBtn(id, downFn, upFn) {
  const el = $(id);
  if (!el) return;
  const down = (e) => { e.preventDefault(); el.classList.add('active'); downFn(); };
  const up = (e) => { e.preventDefault(); el.classList.remove('active'); upFn(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
wireTouchBtn('tc-left', () => { touchInput.l = 1; }, () => { touchInput.l = 0; });
wireTouchBtn('tc-right', () => { touchInput.r = 1; }, () => { touchInput.r = 0; });
wireTouchBtn('tc-gas', () => { touchInput.u = 1; }, () => { touchInput.u = 0; });
wireTouchBtn('tc-brake', () => { touchInput.d = 1; }, () => { touchInput.d = 0; });
wireTouchBtn('tc-nitro', () => { touchInput.nitro = true; }, () => { touchInput.nitro = false; });

// USB/BT gamepad (additive — only used when a pad is connected, keyboard still works)
function readGamepad() {
  if (!navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  for (const gp of pads) {
    if (!gp || !gp.connected) continue;
    const dz = (v) => (Math.abs(v) < 0.1 ? 0 : v);
    const steer = dz(gp.axes[0] || 0) + ((gp.buttons[14] && gp.buttons[14].pressed) ? -1 : 0) + ((gp.buttons[15] && gp.buttons[15].pressed) ? 1 : 0);
    const throttle = gp.buttons[7] ? gp.buttons[7].value : ((gp.buttons[0] && gp.buttons[0].pressed) ? 1 : 0);
    const brake = gp.buttons[6] ? gp.buttons[6].value : ((gp.buttons[1] && gp.buttons[1].pressed) ? 1 : 0);
    const handbrake = !!(gp.buttons[2] && gp.buttons[2].pressed);
    const nitro = !!((gp.buttons[5] && gp.buttons[5].pressed) || (gp.buttons[3] && gp.buttons[3].pressed));
    if (steer || throttle || brake || handbrake || nitro || (gp.axes[0] && Math.abs(gp.axes[0]) > 0.05)) return { steer: Math.max(-1, Math.min(1, steer)), throttle, brake, handbrake, nitro };
  }
  return null;
}
function maybeSendKeyboard(dt) {
  if (SPEC_ROOM) return; // v64 spectators never send input
  if (!latest || !net.isOpen()) return;
  if (latest.state !== 'racing' && latest.state !== 'countdown') return;
  if (latest.controllers && latest.controllers[mySlot]) return;
  kbAccum += dt;
  if (kbAccum < 0.033) return;
  kbAccum = 0;
  let steer = (keys.has('ArrowLeft') || keys.has('KeyA') || touchInput.l ? -1 : 0) + (keys.has('ArrowRight') || keys.has('KeyD') || touchInput.r ? 1 : 0);
  let throttle = (keys.has('ArrowUp') || keys.has('KeyW') || touchInput.u) ? 1 : 0;
  let brake = (keys.has('ArrowDown') || keys.has('KeyS') || touchInput.d) ? 1 : 0;
  let handbrake = keys.has('Space'), nitro = keys.has('ShiftLeft') || keys.has('ShiftRight') || touchInput.nitro;
  const gp = readGamepad();
  if (gp) {
    if (gp.steer) steer = gp.steer;
    throttle = Math.max(throttle, gp.throttle);
    brake = Math.max(brake, gp.brake);
    handbrake = handbrake || gp.handbrake;
    nitro = nitro || gp.nitro;
  }
  net.send({ type: 'input', steer, throttle, brake, handbrake, nitro });
}

// ---------------------------------------------------------------------------
// Camera (unchanged)
// ---------------------------------------------------------------------------
let camMode = 0;
let splitScreen = false;
const lookTarget = new THREE.Vector3(A - 2.8, 1, 0);
function cycleCamera() { camMode = (camMode + 1) % 3; }
function aimChaseInstant(cs) {
  const v = carVisuals[cs.s];
  const cx = (v && v.netInit) ? v.netX : cs.x, cz = (v && v.netInit) ? v.netZ : cs.z, ch = (v && v.netInit) ? v.netH : cs.h;
  const dir = new THREE.Vector3(Math.sin(ch), 0, Math.cos(ch));
  const pos = new THREE.Vector3(cx, 0, cz);
  camera.position.copy(pos).addScaledVector(dir, -8.2);
  camera.position.y = 3.2;
  camera.lookAt(pos.clone().addScaledVector(dir, 5).add(new THREE.Vector3(0, 1.1, 0)));
}
function renderSplit(dt) {
  const w = window.innerWidth, h = window.innerHeight, hh = Math.floor(h / 2);
  camera.aspect = w / hh; camera.updateProjectionMatrix();
  const c1 = interpState(1), c2 = interpState(2);
  renderer.setScissorTest(true);
  renderer.setViewport(0, h - hh, w, hh); renderer.setScissor(0, h - hh, w, hh);
  if (c1) aimChaseInstant(c1);
  renderer.render(scene, camera);
  renderer.setViewport(0, 0, w, hh); renderer.setScissor(0, 0, w, hh);
  if (c2) aimChaseInstant(c2);
  renderer.render(scene, camera);
  renderer.setScissorTest(false);
}
let photoFinishActive = false;
let photoFinishTimer = 0;
function triggerPhotoFinish(margin, winnerName, runnerUpName) {
  photoFinishActive = true;
  photoFinishTimer = 3.2;

  const flash = $('photo-finish-flash');
  if (flash) {
    flash.classList.add('flash');
    setTimeout(() => flash.classList.remove('flash'), 120);
  }

  const banner = $('photo-finish-banner');
  if (banner) {
    banner.style.display = 'block';
    const mEl = $('pf-margin');
    if (mEl) mEl.textContent = '+' + margin.toFixed(3) + 's';
    const tEl = $('pf-title');
    if (tEl) tEl.textContent = `${escapeHtml(winnerName || 'P1')} VS ${escapeHtml(runnerUpName || 'P2')}`;
    setTimeout(() => { banner.style.display = 'none'; }, 3200);
  }
}

function updateCamera(dt, mine, rival) {
  if (photoFinishActive && photoFinishTimer > 0) {
    photoFinishTimer -= dt;
    if (photoFinishTimer <= 0) photoFinishActive = false;
    const finishPos = (curMap && curMap.points) ? curMap.points[0] : { x: A, z: 0 };
    const pfCamPos = new THREE.Vector3(finishPos.x + 6.5, 1.8, finishPos.z - 4.2);
    const pfLookTarget = new THREE.Vector3(finishPos.x, 0.6, finishPos.z);
    camera.position.lerp(pfCamPos, 1 - Math.exp(-6 * dt));
    lookTarget.lerp(pfLookTarget, 1 - Math.exp(-8 * dt));
    camera.lookAt(lookTarget);
    return;
  }
  if (!mine) return;
  // follow the SAME smoothed positions the car meshes use, so camera and
  // car never fight each other (that fight reads as shaking)
  const vMe = carVisuals[mine.s], vRi = rival ? carVisuals[rival.s] : null;
  if (vMe && vMe.netInit) mine = { ...mine, x: vMe.netX, z: vMe.netZ, h: vMe.netH };
  if (rival && vRi && vRi.netInit) rival = { ...rival, x: vRi.netX, z: vRi.netZ, h: vRi.netH };
  const dir = new THREE.Vector3(Math.sin(mine.h), 0, Math.cos(mine.h));
  let desired, look, sepFov = 0;
  const dual = rival && rival.p === 1 && camMode !== 2 && latest && latest.state !== 'waiting';
  if (camMode === 2) {
    desired = new THREE.Vector3(mine.x, 0, mine.z).addScaledVector(dir, 0.4).add(new THREE.Vector3(0, 1.18, 0));
    look = new THREE.Vector3(mine.x, 0, mine.z).addScaledVector(dir, 40).add(new THREE.Vector3(0, 1.0, 0));
  } else if (dual) {
    // broadcast cam: scale distance/height/FOV with the gap so BOTH cars stay in frame
    const mid = new THREE.Vector3((mine.x + rival.x) / 2, 0, (mine.z + rival.z) / 2);
    const sep = Math.hypot(mine.x - rival.x, mine.z - rival.z);
    const ax = Math.sin(mine.h) + Math.sin(rival.h), az = Math.cos(mine.h) + Math.cos(rival.h);
    const dl = Math.hypot(ax, az) || 1;
    const dir = new THREE.Vector3(ax / dl, 0, az / dl);
    const dist = clamp(8 + sep * 0.55, 8, 55);
    const height = clamp(3.5 + sep * 0.5, 3.5, 34);
    desired = mid.clone().addScaledVector(dir, -dist).add(new THREE.Vector3(0, height, 0));
    look = mid.clone().add(new THREE.Vector3(0, 0.5, 0));
    sepFov = clamp(sep * 0.6, 0, 26);
  } else if (camMode === 1) {
    desired = new THREE.Vector3(mine.x, 0, mine.z).addScaledVector(dir, -14).add(new THREE.Vector3(0, 6.2, 0));
    look = new THREE.Vector3(mine.x, 0, mine.z).addScaledVector(dir, 2).add(new THREE.Vector3(0, 1, 0));
  } else {
    desired = new THREE.Vector3(mine.x, 0, mine.z).addScaledVector(dir, -8.2).add(new THREE.Vector3(0, 3.2, 0));
    look = new THREE.Vector3(mine.x, 0, mine.z).addScaledVector(dir, 5).add(new THREE.Vector3(0, 1.1, 0));
  }
  desired.y = Math.max(desired.y, 0.5);
  const k = camMode === 2 ? 1 : 1 - Math.exp(-5.2 * dt);
  camera.position.lerp(desired, k);
  lookTarget.lerp(look, 1 - Math.exp(-9 * dt));
  const sp = clamp(Math.abs(mine.v) / CFG.maxSpeed, 0, 1.3);
  const baseShake = sp > 0.72 ? (sp - 0.72) * 0.05 : 0;
  shakeAmp = Math.max(0, shakeAmp - shakeAmp * 4.2 * dt);
  const amp = prefs.rm ? 0 : (shakeAmp + baseShake);
  if (amp > 0.001) {
    camera.position.x += (Math.random() - 0.5) * amp;
    camera.position.y += (Math.random() - 0.5) * amp * 0.6;
    camera.position.z += (Math.random() - 0.5) * amp;
  }
  camera.lookAt(lookTarget);
  const fovTarget = 62 + sp * 13 + (mine.n ? 6 : 0) + (dual ? sepFov : 0);
  if (Math.abs(camera.fov - fovTarget) > 0.05) {
    camera.fov = lerp(camera.fov, fovTarget, 1 - Math.exp(-4.5 * dt));
    camera.updateProjectionMatrix();
  }
}
const _av = new THREE.Vector3(), _cd = new THREE.Vector3();
function updateArrow(rival) {
  const el = hEl('arrow');
  if (!rival || rival.p !== 1 || !latest || latest.state === 'waiting') { hStyle(el, 'display', 'none'); return; }
  if (el.__sdisplay === 'none') return; // v66: skip math while hidden
  const vRi = carVisuals[rival.s];
  _av.set((vRi && vRi.netInit) ? vRi.netX : rival.x, 1.2, (vRi && vRi.netInit) ? vRi.netZ : rival.z);
  const toOther = _av.clone().sub(camera.position);
  camera.getWorldDirection(_cd);
  const inFront = toOther.dot(_cd) > 0;
  _av.project(camera);
  if (inFront && Math.abs(_av.x) < 0.92 && Math.abs(_av.y) < 0.86) { hStyle(el, 'display', 'none'); return; }
  let sx = _av.x, sy = -_av.y;
  if (!inFront) { sx = -sx; sy = -sy; }
  const ang = Math.atan2(sy, sx);
  const W = window.innerWidth / 2 - 56, H = window.innerHeight / 2 - 56;
  const t = Math.min(W / Math.max(1e-6, Math.abs(Math.cos(ang))), H / Math.max(1e-6, Math.abs(Math.sin(ang))));
  hStyle(el, 'display', 'flex');
  hStyle(el, 'left', (window.innerWidth / 2 + Math.cos(ang) * t * 0.94) + 'px');
  hStyle(el, 'top', (window.innerHeight / 2 + Math.sin(ang) * t * 0.94) + 'px');
  hStyle(el, 'transform', `translate(-50%,-50%) rotate(${ang}rad)`);
  const isP2 = rival.s === 2, isP1 = rival.s === 1;
  if (el.__p2 !== isP2) { el.__p2 = isP2; el.classList.toggle('p2', isP2); }
  if (el.__p1 !== isP1) { el.__p1 = isP1; el.classList.toggle('p1', isP1); }
  if (!el.__dist) el.__dist = el.querySelector('.dist');
  hText(el.__dist, Math.round(Math.hypot(rival.x - camera.position.x, rival.z - camera.position.z)) + 'm');
}

// ---------------------------------------------------------------------------
// Audio (unchanged)
// ---------------------------------------------------------------------------
let audio = null;
function distCurve(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = (1 + k) * x / (1 + k * Math.abs(x));
  }
  return c;
}
function ensureAudio() {
  if (audio) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 6;
  master.disconnect(); master.connect(comp); comp.connect(ctx.destination);

  // Racing-engine synth: 3 harmonically-related oscs -> waveshaper grit -> resonant
  // body -> throttle-opening lowpass, plus a bandpassed exhaust-noise layer.
  const engines = [0, 1].map(() => {
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';              // fundamental
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.detune.value = 9;  // thick octave
    const o3 = ctx.createOscillator(); o3.type = 'square';                 // sub rumble
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.28;
    const g3 = ctx.createGain(); g3.gain.value = 0.34;
    const shaper = ctx.createWaveShaper(); shaper.curve = distCurve(2.5); shaper.oversample = '4x';
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 420; body.Q.value = 1.1; body.gain.value = 7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 0.7;
    const engGain = ctx.createGain(); engGain.gain.value = 0;
    o1.connect(g1); o2.connect(g2); o3.connect(g3);
    g1.connect(shaper); g2.connect(shaper); g3.connect(shaper);
    shaper.connect(body); body.connect(lp); lp.connect(engGain); engGain.connect(master);
    // exhaust turbulence
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const ex = ctx.createBufferSource(); ex.buffer = nb; ex.loop = true;
    const exBp = ctx.createBiquadFilter(); exBp.type = 'bandpass'; exBp.frequency.value = 900; exBp.Q.value = 0.8;
    const exGain = ctx.createGain(); exGain.gain.value = 0;
    ex.connect(exBp); exBp.connect(exGain); exGain.connect(engGain);
    o1.start(); o2.start(); o3.start(); ex.start();
    return { o1, o2, o3, lp, body, engGain, exBp, exGain };
  });

  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.9;
  const skidGain = ctx.createGain(); skidGain.gain.value = 0;
  noise.connect(bp); bp.connect(skidGain); skidGain.connect(master); noise.start();
  const noise2 = ctx.createBufferSource(); noise2.buffer = buf; noise2.loop = true;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1900;
  const nitroGain = ctx.createGain(); nitroGain.gain.value = 0;
  noise2.connect(hp); hp.connect(nitroGain); nitroGain.connect(master); noise2.start();
  audio = { ctx, master, engines, skidGain, nitroGain };
  setAudio();   // apply mute + start low background music
}
function beep(freq, dur = 0.15, type = 'square', vol = 0.22) {
  ensureAudio(); if (!audio) return;
  const ctx = audio.ctx;
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g); g.connect(audio.master);
  o.start(); o.stop(ctx.currentTime + dur + 0.05);
}
function playHorn() { beep(415, 0.35, 'triangle', 0.28); }
function winJingle() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.24, 'triangle', 0.26), i * 150)); }
function updateAudio(mine, rival) {
  if (!audio) return;
  if (audio.ctx.state === 'suspended') { audio.ctx.resume(); return; }
  const t = audio.ctx.currentTime;
  [mine, rival].forEach((cs, i) => {
    const e = audio.engines[i];
    if (!cs || cs.p !== 1) { e.engGain.gain.setTargetAtTime(0, t, 0.1); return; }
    const sp = clamp(Math.abs(cs.v) / CFG.maxSpeed, 0, 1);
    const thr = clamp((cs.th != null ? cs.th : sp) + (cs.n ? 0.4 : 0), 0, 1);
    // gear-boxed RPM: revs climb within a gear, drop on shift
    const gear = Math.min(5, Math.floor(sp * 6));
    const frac = sp * 6 - gear;
    const rpm = 0.18 + 0.82 * frac;
    const f0 = 50 + rpm * 190 + thr * 22;          // fundamental ~50–260 Hz
    e.o1.frequency.setTargetAtTime(f0, t, 0.04);
    e.o2.frequency.setTargetAtTime(f0 * 2.01, t, 0.04);
    e.o3.frequency.setTargetAtTime(f0 * 0.5, t, 0.05);
    e.lp.frequency.setTargetAtTime(320 + rpm * 2600 + thr * 1400, t, 0.08);
    e.body.frequency.setTargetAtTime(f0 * 2.2, t, 0.08);
    e.exBp.frequency.setTargetAtTime(f0 * 4 + 400, t, 0.08);
    e.exGain.gain.setTargetAtTime(0.05 + thr * 0.22 + rpm * 0.1, t, 0.08);
    let vol = 0.05 + sp * 0.1 + thr * 0.12 + (cs.n ? 0.05 : 0);
    if (i === 1) {
      const dist = camera.position.distanceTo(new THREE.Vector3(cs.x, 0, cs.z));
      vol *= clamp(1 - dist / 160, 0, 1) * 0.8;
    }
    e.engGain.gain.setTargetAtTime(vol, t, 0.07);
  });
  const skidAmt = (mine && mine.sl > 4.5 && Math.abs(mine.v) > 6) ? clamp(mine.sl * 0.018, 0, 0.2) : 0;
  audio.skidGain.gain.setTargetAtTime(skidAmt, t, 0.06);
  audio.nitroGain.gain.setTargetAtTime((mine && mine.n) || (rival && rival.n) ? 0.1 : 0, t, 0.08);
}

// ---------------------------------------------------------------------------
// Car placement (unchanged)
// ---------------------------------------------------------------------------
// v59 cosmetic-only customization (no physics fields touched, ever)
const DECAL_COLORS = [0, 0xffffff, 0xff6a00, 0x111111];
const WHEEL_HUBS = [0xb9bec7, 0xe8f4ff, 0xd4af37];
const TRAIL_COLS = [0x35e0ff, 0xff20c8, 0xffd400];
function applyCos(v, dc, wh, tr, ne, sp) {
  const key = dc + '|' + wh + '|' + tr + '|' + (ne || 0) + '|' + (sp || 0);
  if (v.cosKey === key) return;
  v.cosKey = key;
  if (v.neonMesh) { v.body.remove(v.neonMesh); v.neonMesh = null; }
  if (v.spoiler) { v.body.remove(v.spoiler); v.spoiler = null; }
  const neHex = (ne && window.SRCos && SRCos.NEONS[ne]) ? SRCos.NEONS[ne].hex : 0;
  if (neHex) { const nm = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 4.6), new THREE.MeshBasicMaterial({ color: neHex, transparent: true, opacity: 0.5 })); nm.rotation.x = -Math.PI / 2; nm.position.y = 0.12; v.body.add(nm); v.neonMesh = nm; }
  if (sp) { const sm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.5), new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.5, metalness: 0.6 })); sm.position.set(0, 1.25, -2.1); v.body.add(sm); v.spoiler = sm; }
  if (v.decalGroup) { v.body.remove(v.decalGroup); v.decalGroup = null; }
  if (dc > 0) {
    const dg = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: DECAL_COLORS[dc] || 0xffffff, roughness: 0.35, metalness: 0.2 });
    if (dc === 1) { for (const sx of [-0.35, 0.35]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 3.2), mat); b.position.set(sx, 1.02, 0.2); dg.add(b); } }
    else if (dc === 2) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.02, 1.1), new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0xff3300, emissiveIntensity: 0.7 })); b.position.set(0, 1.0, 1.5); dg.add(b); }
    else { for (let i = 0; i < 6; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 0.18), i % 2 ? mat : new THREE.MeshStandardMaterial({ color: 0xffffff })); b.position.set(-0.5 + (i % 3) * 0.5, 1.36, -2.25); dg.add(b); } }
    v.body.add(dg); v.decalGroup = dg;
  }
  if (v.hubMat) v.hubMat.color.setHex(WHEEL_HUBS[wh] || WHEEL_HUBS[0]);
  if (v.calMat) v.calMat.color.setHex(TRAIL_COLS[tr] || TRAIL_COLS[0]);
}
function placeCar(slot, cs, dt) {
  const v = carVisuals[slot];
  if (!cs) return;
  if (cs.col != null && v.paint && v.paint.color.getHex() !== cs.col) v.paint.color.setHex(cs.col);
  applyCos(v, cs.dc || 0, cs.wh || 0, cs.tr || 0, cs.ne || 0, cs.sp || 0); // v59 cosmetics / v75 neon+spoiler
  v.group.visible = cs.p === 1;
  if (!v.group.visible) { v.netInit = false; return; }
  // ---- network smoothing: exponentially follow the interpolated snapshot
  // position. Absorbs snapshot jitter / bursty delivery so the car never
  // shakes, and never overshoots a hard stop (e.g. hitting a tire wall).
  if (!v.netInit) { v.netX = cs.x; v.netZ = cs.z; v.netH = cs.h; v.netInit = true; }
  const expMove = Math.abs(cs.v) * dt;
  const dx = cs.x - v.netX, dz = cs.z - v.netZ;
  const dist = Math.hypot(dx, dz);
  if (dist > expMove * 6 + 2.5 || !isFinite(dist)) {       // reset/teleport: snap
    v.netX = cs.x; v.netZ = cs.z; v.netH = cs.h;
  } else {
    const k = 1 - Math.exp(-dt / (typeof pingMs !== 'undefined' && pingMs > 220 ? 0.09 : 0.04)); // v71: calmer follow on high ping
    v.netX += dx * k; v.netZ += dz * k;
    let dh = cs.h - v.netH; while (dh > Math.PI) dh -= PI2; while (dh < -Math.PI) dh += PI2;
    v.netH += dh * k;
  }
  // ---- render-time physics clamp: the smoothed display position must obey
  // the SAME bounds as the server sim, otherwise render lag visually slides
  // the car through fences/tires for a few frames (the old "passthrough").
  {
    const T = curMap;
    if (T && T.world) {
      // v68: track-owned spec — identical to the server's barrier limits
      const spline = T.type === 'spline';
      const limC = spline ? (T.limC != null ? T.limC : RH + 2.4) : RH + 2.4;
      const limP = spline ? (T.limP != null ? T.limP : RH + 3.35) : RH + 3.35;
      const dirX = Math.sin(v.netH), dirZ = Math.cos(v.netH);
      if (spline && T.nearest) {
        // v68 RADIAL-X: same exact engine as the server (true distance +
        // exact normals + converge + hard guarantee) — the displayed car can
        // never sit past the drawn fence, at any angle or smoothing lag.
        // v69 perf: warm-started windowed queries + fast reject when the car
        // is mid-road (nose can reach at most center-distance + 2.6).
        const probes = [[0, limC], [2.6, limP], [-2.4, limP]];
        const nC = T.nearest(v.netX, v.netZ, v._th); v._th = nC.th;
        if (!(nC.d <= limC && nC.d + 2.6 <= limP)) {
          for (let iter = 0; iter < 3; iter++) {
            let maxOver = 0, pnx = 0, pnz = 0;
            for (const pr of probes) {
              const n = T.nearest(v.netX + dirX * pr[0], v.netZ + dirZ * pr[0], v._th);
              const over = n.d - pr[1];
              if (over > maxOver) { maxOver = over; pnx = n.nx; pnz = n.nz; }
            }
            if (maxOver <= 1e-7) break;
            v.netX -= pnx * maxOver; v.netZ -= pnz * maxOver;
          }
          for (let it = 0; it < 6; it++) {
            let worst = 0;
            for (const pr of probes) {
              const n = T.nearest(v.netX + dirX * pr[0], v.netZ + dirZ * pr[0], v._th);
              const over = n.d - pr[1];
              if (over > worst) worst = over;
              if (over > 1e-7) { v.netX -= n.nx * over; v.netZ -= n.nz * over; }
            }
            if (worst <= 1e-7) break;
          }
          let worst = 0;
          for (const pr of probes) { const n = T.nearest(v.netX + dirX * pr[0], v.netZ + dirZ * pr[0], v._th); if (n.d - pr[1] > worst) worst = n.d - pr[1]; }
          if (worst > 1e-4) { const nc = T.nearest(v.netX, v.netZ, v._th); v.netX = nc.cx; v.netZ = nc.cz; v._th = nc.th; } // hard guarantee
        }
      } else {
        const proj = (px, pz) => CORE.ellipseProj(px, pz, T.a, T.b);
        // Map 0: v53 2-pass converge (historic behavior, untouched)
        for (let iter = 0; iter < 2; iter++) {
          let maxOver = 0, sx = 0, sz = 0;
          for (const pr of [[0, limC], [2.6, limP], [-2.4, limP]]) {
            const n = proj(v.netX + dirX * pr[0], v.netZ + dirZ * pr[0]);
            const over = Math.abs(n.lat) - pr[1];
            if (over > maxOver) {
              maxOver = over;
              const cd = Math.hypot(v.netX - n.cx, v.netZ - n.cz) || 1;
              sx = (v.netX - n.cx) / cd; sz = (v.netZ - n.cz) / cd;
            }
          }
          if (maxOver <= 0) break;
          v.netX -= sx * maxOver; v.netZ -= sz * maxOver;
        }
      }
      const rr = 0.95 + 0.75; // capsule side + tire
      for (const hz of T.world.hazards) {
        const hx = v.netX - hz.x, hzz = v.netZ - hz.z;
        const d2 = hx * hx + hzz * hzz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          v.netX = hz.x + (hx / d) * rr; v.netZ = hz.z + (hzz / d) * rr;
        }
      }
    }
  }
  v.group.position.set(v.netX, 0, v.netZ);
  v.group.rotation.y = v.netH;
  v.body.rotation.z = lerp(v.body.rotation.z, clamp(-cs.sl * 0.042, -0.17, 0.17), Math.min(1, dt * 8));
  const sp = clamp(Math.abs(cs.v) / CFG.maxSpeed, 0, 1);
  v.body.position.y = Math.sin(performance.now() * 0.016 + slot * 3) * 0.008 * sp;
  v.spinAngle += cs.v * dt / 0.35;
  for (const w of v.wheels) {
    w.spin.rotation.x = v.spinAngle;
    if (w.front) w.pivot.rotation.y = -cs.st * 0.42;
  }
  if (cs.sl > 4.5 && Math.abs(cs.v) > 6) {
    for (const side of [-0.98, 0.98]) {
      const wx = v.netX + side * Math.cos(v.netH) - 1.45 * Math.sin(v.netH);
      const wz = v.netZ - side * Math.sin(v.netH) - 1.45 * Math.cos(v.netH);
      if (Math.random() < 0.5) spawnSmoke(wx, wz, Math.sin(cs.h) * cs.v, Math.cos(cs.h) * cs.v);
      spawnSkid(wx, wz, cs.h);
    }
  }
  // v83 Weather tire spray (rain water spray / blizzard snow kickup)
  if (Math.abs(cs.v) > 7) {
    if (currentWeather === 'wet' && Math.random() < 0.6) {
      for (const side of [-0.98, 0.98]) {
        const wx = v.netX + side * Math.cos(v.netH) - 1.45 * Math.sin(v.netH);
        const wz = v.netZ - side * Math.sin(v.netH) - 1.45 * Math.cos(v.netH);
        spawnWaterSpray(wx, wz, Math.sin(cs.h) * cs.v, Math.cos(cs.h) * cs.v);
      }
    } else if (currentWeather === 'blizzard' && Math.random() < 0.6) {
      for (const side of [-0.98, 0.98]) {
        const wx = v.netX + side * Math.cos(v.netH) - 1.45 * Math.sin(v.netH);
        const wz = v.netZ - side * Math.sin(v.netH) - 1.45 * Math.cos(v.netH);
        spawnSnowSpray(wx, wz, Math.sin(cs.h) * cs.v, Math.cos(cs.h) * cs.v);
      }
    }
  }
  if (cs.n === 1) {
    for (const sx of [-0.55, 0.55]) {
      const fx = cs.x + sx * Math.cos(cs.h) - 2.45 * Math.sin(cs.h);
      const fz = cs.z - sx * Math.sin(cs.h) - 2.45 * Math.cos(cs.h);
      spawnFlame(new THREE.Vector3(fx, 0.42, fz));
    }
  }
}

// ---------------------------------------------------------------------------
// HUD (minimap now uses current A/B)
// ---------------------------------------------------------------------------
const minimap = $('minimap');
const mctx = minimap.getContext('2d');
function drawMinimap(mine, rival) {
  const w = minimap.width, h = minimap.height;
  const MSCALE = 62 / (Math.max(A, B) + RH + 4);
  mctx.clearRect(0, 0, w, h);
  mctx.save();
  mctx.translate(w / 2, h / 2);
  mctx.strokeStyle = 'rgba(255,255,255,0.16)';
  mctx.lineWidth = (RH * 2) * MSCALE;
  mctx.beginPath();
  if (curMap && curMap.type === 'spline') { curMap.points.forEach((p, i) => { const X = p.x * MSCALE, Z = p.z * MSCALE; if (i === 0) mctx.moveTo(X, Z); else mctx.lineTo(X, Z); }); mctx.closePath(); }
  else mctx.ellipse(0, 0, A * MSCALE, B * MSCALE, 0, 0, Math.PI * 2);
  mctx.stroke();
  mctx.strokeStyle = 'rgba(255,255,255,0.5)'; mctx.lineWidth = 1; mctx.stroke();
  mctx.strokeStyle = '#fff'; mctx.lineWidth = 2;
  mctx.beginPath();
  if (curMap && curMap.type === 'spline') { const p0 = curMap.points[0]; mctx.moveTo(p0.x * MSCALE - 4, p0.z * MSCALE); mctx.lineTo(p0.x * MSCALE + 4, p0.z * MSCALE); }
  else { mctx.moveTo((A - RH) * MSCALE, 0); mctx.lineTo((A + RH) * MSCALE, 0); }
  mctx.stroke();
  for (const cs of (latest ? latest.cars.filter((c) => c.p === 1) : [mine])) { // v76
    if (!cs || cs.p !== 1) continue;
    mctx.fillStyle = '#' + cbCol(cs.s).toString(16).padStart(6, '0');
    mctx.beginPath(); mctx.arc(cs.x * MSCALE, cs.z * MSCALE, 3.4, 0, Math.PI * 2); mctx.fill();
  }
  mctx.restore();
}
// v49 smoothness pass: HUD refs cached once; DOM written ONLY when the value
// changes (innerHTML rebuilds at 60 fps were the main jank source).
const HUD = {};
let frameFlip = false; // v66
const hEl = (id) => HUD[id] || (HUD[id] = $(id));
function hText(el, v) { if (el && el.__t !== v) { el.__t = v; el.textContent = v; } }
function hHTML(el, v) { if (el && el.__h !== v) { el.__h = v; el.innerHTML = v; } }
function hStyle(el, k, v) { if (el && el['__s' + k] !== v) { el['__s' + k] = v; el.style[k] = v; } }
let hudPill1 = null, hudPill2 = null;
function updateHUD(mine, rival) {
  if (!latest || !mine) return;
  updateModeLabels(latest.mode);
  if (!hudPill1) { const p1 = hEl('pill-p1'), p2 = hEl('pill-p2'); hudPill1 = p1 && p1.querySelector('span'); hudPill2 = p2 && p2.querySelector('span'); }
  const c1 = latest.cars[0], c2 = latest.cars[1];
  if (latest.mode !== 'coop') {
    hText(hudPill1, c1.nm || 'PLAYER 1');
    hText(hudPill2, c2.nm || 'PLAYER 2');
  } else {
    hText(hudPill1, 'CO-OP · ' + (c1.nm || 'YOU'));
  }
  const pingEl = hEl('ping-badge');
  if (pingEl) {
    if (pingMs < 0) { hText(pingEl, '… ms'); if (pingEl.__c !== 'ping') { pingEl.__c = 'ping'; pingEl.className = 'ping'; } }
    else {
      const p = Math.round(pingMs);
      hText(pingEl, p + ' ms');
      const cls = 'ping ' + (p < 90 ? 'good' : p < 180 ? 'ok' : 'bad');
      if (pingEl.__c !== cls) { pingEl.__c = cls; pingEl.className = cls; }
      // v71 honest diagnostics: tell the player what high ping means
      pingEl.title = p < 180 ? 'Round-trip time to the race server' : 'HIGH PING = your network route to the server (distance/Wi-Fi), not a game bug. Try 5 GHz Wi-Fi or a closer network.';
    }
  }
  const fpsEl = hEl('fps-meter');
  if (fpsEl) {
    if (prefs.fpsmeter) { hStyle(fpsEl, 'display', ''); hText(fpsEl, fps + ' FPS'); }
    else hStyle(fpsEl, 'display', 'none');
  }
  hText(hEl('speed-val'), String(Math.round(Math.abs(mine.v) * 3.6)));
  hText(hEl('gear'), mine.v < -0.5 ? 'R' : (Math.abs(mine.v) < 0.4 ? 'N' : 'D'));
  hText(hEl('pu-chip'), (mine.pb ? '⚡' : '') + (mine.ps ? '🛡️' : '') + (mine.pl ? '🌀' : '')); // v59
  // v63 close-race intensity chip
  const gc = hEl('gap-chip');
  if (gc) {
    if (latest && latest.state === 'racing' && mine && rival && mine.p === 1 && rival.p === 1) {
      if (!gc._t || performance.now() - gc._t > 500) {
        gc._t = performance.now();
        const dP = ((mine.lap || 0) + (mine.pr || 0)) - ((rival.lap || 0) + (rival.pr || 0));
        const lapEst = Math.max(18, (Pget().bestLap || {})[(latest.map != null) ? latest.map : builtMapId] || 25);
        const gap = Math.abs(dP) * lapEst;
        if (gap > 0.05 && gap < 2.5) hText(gc, Math.abs(gap).toFixed(2) + 's ' + (dP > 0 ? 'AHEAD' : 'BEHIND'));
        else hText(gc, '');
      }
    } else hText(gc, '');
  }
  const nf = hEl('nitro-fill');
  hStyle(nf, 'width', (mine.m || 0) + '%');
  const burn = mine.n === 1;
  if (nf && nf.__burn !== burn) { nf.__burn = burn; nf.classList.toggle('burn', burn); }
  const order = standingsFrom(latest);
  const myRank = order.findIndex((c) => c.s === mySlot);
  let raceStr =
    `<span id="lapchip">LAP ${Math.min(mine.lap + 1, CFG.totalLaps)}<small>/${CFG.totalLaps}</small></span>` +
    (order.length > 1 && myRank >= 0 ? `<span id="poschip" class="${mySlot === 1 ? 'c1' : 'c2'}">${ordinal(myRank + 1).toUpperCase()}</span>` : '');
  if (latest.mode === 'drift') raceStr += `<span id="poschip" class="${mySlot === 1 ? 'c1' : 'c2'}">DRIFT ${mine.drift || 0}</span>`;
  hHTML(hEl('raceinfo'), raceStr);
  const row = (c) => `L${Math.min(c.lap + 1, CFG.totalLaps)}  ${c.ll != null ? fmtTime(c.ll) : '--:--.--'}  <span class="dim">best ${c.best != null ? fmtTime(c.best) : '--:--.--'}</span>`;
  // v76 live ranking from authoritative snapshot (finished first, then progress)
  const rankCols = ['#ff6b6b', '#64b5f6', '#ffd479', '#7ee78a', '#ff8ae2', '#7ee7ff'];
  const val = (c) => (c.fin ? 1e7 - (c.ft || 0) : (c.pr || 0));
  const ord2 = latest.cars.filter((c) => c.p === 1).slice().sort((a, b) => val(b) - val(a));
  hHTML(hEl('lap-p1'), ord2.map((c, i) => `<b style="color:${rankCols[i % 6]}">${i + 1}</b> ${c.s === mySlot ? 'YOU' : escapeHtml(c.nm || ('P' + c.s))} <span class="dim">L${Math.min(c.lap + 1, CFG.totalLaps)}</span>`).join('<br>'));
  hStyle(hEl('lap-p2'), 'display', 'none');
  hStyle(hEl('speedlines'), 'opacity', String(prefs.rm ? 0 : clamp((Math.abs(mine.v) - 26) / 34, 0, 0.6)));
  const isTouchDev = typeof window !== 'undefined' && (('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0));
  const showTouch = isTouchDev && latest && (latest.state === 'racing' || latest.state === 'countdown') && (!latest.controllers || !latest.controllers[mySlot]) && !SPEC_ROOM;
  hStyle(hEl('touch-controls'), 'display', showTouch ? 'flex' : 'none');
  frameFlip = !frameFlip; if (frameFlip) drawMinimap(mine, rival); // v66: half-rate minimap
}
function updateCountdownVisual() {
  if (!latest || latest.state !== 'countdown' || latest.count == null) return;
  const n = Math.max(1, Math.ceil(latest.count));
  if (n !== lastCountInt) { lastCountInt = n; showCount(String(n)); beep(392, 0.14, 'square', 0.24); }
}

// ---------------------------------------------------------------------------
// Lobby buttons (+ map selection)
// ---------------------------------------------------------------------------
$('start-btn').addEventListener('click', () => {
  ensureAudio();
  const mode3 = prefs.mode3 || 'mp';
  TT.on = mode3 !== 'mp'; TT.practice = mode3 === 'practice'; TT.done = false;
  if (TT.on) { net.send({ type: 'bot', bot: false }); net.send({ type: 'record', record: !TT.practice }); }
  else net.send({ type: 'record', record: true });
  net.send({ type: 'start' });
  const p = Pget();
  if (p && p.races >= 1) track('second_race', selectedMap);
  track('race', selectedMap);
  const isMultiplayer = !TT.on && latest && latest.cars && (
    (latest.cars.filter((c) => c && c.p === 1).length >= 2 && !latest.bot) ||
    (latest.controllers && Object.values(latest.controllers).filter(Boolean).length >= 2)
  );
  if (isMultiplayer) {
    track('multiplayer', selectedMap);
  }
  const pb = $('practice-bar'); if (pb) pb.hidden = !TT.practice;
});
// ---------------------------------------------------------------------------
// v73 — persistent platform UI: profile, rating board, ceremony actions
// Reads use the anon key (RLS public read); history uses the user's own token
// (RLS own-row read). Writes happen ONLY on the relay (service role).
// ---------------------------------------------------------------------------
function sbCfg() { return { url: String(window.SUPABASE_URL || '').replace(/\/+$/, ''), anon: String(window.SUPABASE_ANON || '') }; }
async function sbGet(path, userTok) {
  const c = sbCfg(); if (!c.url) return null;
  try {
    const r = await fetch(c.url + path, { headers: { apikey: c.anon, Authorization: 'Bearer ' + (userTok || c.anon) } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
function openProfile() {
  const dlg = $('profile-dlg'); if (!dlg) return;
  dlg.hidden = false;
  const body = $('profile-body');
  const acc = window.SRAccount;
  if (!(acc && acc.available && acc.available() && acc.loggedIn())) {
    body.innerHTML = '<div class="p-empty">Create a free racer account to build a permanent racing identity: rating, XP, history, records.<br><br><button id="p-signin" class="big-cta">SIGN IN / CREATE ACCOUNT</button></div>';
    const b = $('p-signin'); if (b) b.addEventListener('click', () => { dlg.hidden = true; const ab = $('account-btn'); if (ab) ab.click(); });
    return;
  }
  body.innerHTML = '<div class="p-empty">Loading career…</div>';
  (async () => {
    const uid = acc.uid(), tok = acc.token();
    const [prof, stats, recs, hist, achs, seas, psea, peq] = await Promise.all([
      sbGet('/rest/v1/profiles?id=eq.' + uid + '&select=username'),
      sbGet('/rest/v1/player_stats?user_id=eq.' + uid),
      sbGet('/rest/v1/player_map_records?user_id=eq.' + uid + '&order=races.desc'),
      sbGet('/rest/v1/race_history?user_id=eq.' + uid + '&order=created_at.desc&limit=8', tok),
      sbGet('/rest/v1/player_achievements?user_id=eq.' + uid + '&select=ach,unlocked_at'),
      sbGet('/rest/v1/seasons?order=id.desc&limit=1&select=id,name,end_at'),
      sbGet('/rest/v1/player_seasons?user_id=eq.' + uid + '&select=season_id,rating,xp'),
      sbGet('/rest/v1/player_equipped?user_id=eq.' + uid + '&select=car,neon,title'),
    ]);
    const p = (prof && prof[0]) || { username: acc.name() || 'RACER' };
    const st = (stats && stats[0]) || { races: 0, wins: 0, podiums: 0, xp: 0, rating: 1000, peak_rating: 1000, streak: 0 };
    const lv = window.SRProg ? SRProg.levelFromXp(st.xp) : { level: 1, pct: 0, cur: 0, span: 100 };
    const tr = window.SRProg ? SRProg.tier(st.rating) : { name: 'BRONZE III', col: '#d09a6a' };
    const season = seas && seas[0]; const mySeason = psea && psea.find((x) => season && x.season_id === season.id);
    const wr = st.races ? Math.round(100 * st.wins / st.races) : 0;
    const eqCar = (window.SRCos && peq && peq[0]) ? SRCos.findCar(peq[0].car) : null;
    let badgeInfo = null;
    try {
      const bRes = await fetch(`${httpBase()}/api/player/badges?uid=${encodeURIComponent(uid)}`).then(r => r.json());
      if (bRes && bRes.ok && bRes.badges) {
        badgeInfo = bRes.badges.find(b => b.equipped);
      }
    } catch (e) {}

    let html = '<div class="p-head"><div class="p-name">' + escapeHtml(p.username) + (eqCar ? ' <span class="p-car" style="color:' + SRCos.RARITY[eqCar.rarity] + '">🏎️ ' + eqCar.name + '</span>' : '') + (badgeInfo ? ' <span class="p-car" style="color:#ffd479">🎖️ ' + badgeInfo.name + ' (' + badgeInfo.tierName + ')</span>' : '') + '</div>' +
      '<div class="p-tier" style="color:' + tr.col + '">' + tr.name + ' · ' + st.rating + ' <i>peak ' + st.peak_rating + '</i></div>' +
      '<div class="p-level">' + tr.name.split(' ')[0] + ' PROGRESS<div class="p-bar"><i style="width:' + (tr.pct || 0) + '%"></i></div></div>' +
      (tr.next ? '<div class="p-xp" style="text-align:center">Next: ' + tr.next + '</div>' : '') +
      (season ? '<div class="p-xp" style="text-align:center">🌞 ' + season.name + ' · ' + (window.SRProg ? SRProg.seasonCountdown(season.end_at) : '') + (mySeason ? ' · season rating ' + mySeason.rating : '') + '</div>' : '') +
      '<div class="p-level">LEVEL ' + lv.level + '<div class="p-bar"><i style="width:' + lv.pct + '%"></i></div><span class="p-xp">' + lv.cur + '/' + lv.span + ' XP</span></div>' +
      '<div style="text-align:center; margin-top:6px;"><button id="prof-badges-btn" class="ghost sm">🎖️ MANAGE BADGES</button></div></div>' +
      '<div class="p-grid">' +
      '<div><b>' + st.races + '</b><span>RACES</span></div><div><b>' + st.wins + '</b><span>WINS</span></div>' +
      '<div><b>' + st.podiums + '</b><span>PODIUMS</span></div><div><b>' + wr + '%</b><span>WIN RATE</span></div>' +
      '<div><b>🔥' + st.streak + '</b><span>STREAK</span></div><div><b>' + st.best_streak + '</b><span>BEST</span></div></div>';
    if (recs && recs.length) {
      html += '<div class="p-sub">MAP RECORDS</div><div class="p-recs">';
      recs.forEach((r) => { const m = (CORE.MAPS[r.map] || {}).name || ('MAP ' + r.map); html += '<div class="p-rec"><span>' + escapeHtml(m) + '</span><b>' + (r.best_lap_ms ? fmtTime(r.best_lap_ms / 1000) : '--:--.--') + '</b><i>' + r.wins + 'W/' + r.races + 'R</i></div>'; });
      html += '</div>';
    }
    if (hist && hist.length) {
      html += '<div class="p-sub">RECENT RACES</div><div class="p-hist">';
      hist.forEach((h) => { const m = (CORE.MAPS[h.map] || {}).name || ('MAP ' + h.map); html += '<div class="p-hrow"><span>P' + h.position + '/' + h.players + '</span><em>' + escapeHtml(m) + ' · ' + h.mode + '</em><b>' + (h.rating_delta > 0 ? '+' : '') + h.rating_delta + '</b><i>+' + h.xp + ' XP</i></div>'; });
      html += '</div>';
    }
    if (achs && achs.length && window.SRProg) {
      html += '<div class="p-sub">ACHIEVEMENTS</div><div class="p-recs">';
      achs.forEach((a) => { const def = SRProg.ACHIEVEMENTS.find((x) => x.id === a.ach); html += '<div class="p-rec"><span>' + (def ? def.icon : '🏅') + ' ' + escapeHtml(def ? def.name : a.ach) + '</span><i>' + new Date(a.unlocked_at).toLocaleDateString() + '</i></div>'; });
      html += '</div>';
    }
    if (!st.races) html += '<div class="p-empty">No settled races yet — your career starts at the next finish line. 🏁</div>';
    body.innerHTML = html;
    const pbb = $('prof-badges-btn');
    if (pbb) pbb.onclick = () => { dlg.hidden = true; openBadgesShowcase(); };
  })();
}
let compActiveTab = 'rate'; // 'rate' | 'time' | 'daily' | 'weekly'
let compScope = 'top';      // 'top' | 'nearby'
let compSelectedMap = 0;

async function loadCompetitiveHub() {
  const base = httpBase();
  const acc = window.SRAccount;
  const uid = (acc && acc.loggedIn && acc.loggedIn()) ? acc.uid() : (prefs.pid || prefs.name);

  const tRate = $('board-tab-rate'), tTime = $('board-tab-time'), tDaily = $('board-tab-daily'), tWeekly = $('board-tab-weekly');
  const rateB = $('rate-board'), timeB = $('leaderboard'), dailyB = $('daily-board-view'), weeklyB = $('weekly-board-view');
  const mapWrap = $('map-filter-wrap');

  if (tRate) tRate.classList.toggle('active', compActiveTab === 'rate');
  if (tTime) tTime.classList.toggle('active', compActiveTab === 'time');
  if (tDaily) tDaily.classList.toggle('active', compActiveTab === 'daily');
  if (tWeekly) tWeekly.classList.toggle('active', compActiveTab === 'weekly');

  if (rateB) rateB.hidden = compActiveTab !== 'rate';
  if (timeB) timeB.hidden = compActiveTab !== 'time';
  if (dailyB) dailyB.hidden = compActiveTab !== 'daily';
  if (weeklyB) weeklyB.hidden = compActiveTab !== 'weekly';
  if (mapWrap) mapWrap.hidden = compActiveTab !== 'time';

  try {
    if (compActiveTab === 'rate') {
      if (rateB) rateB.innerHTML = '<div class="lb-empty">Loading global rankings…</div>';
      const r = await fetch(`${base}/api/leaderboard?type=rating&scope=${compScope}${uid ? '&uid=' + encodeURIComponent(uid) : ''}`);
      if (!r.ok) throw new Error('fetch error');
      const data = await r.json();
      renderCompetitiveRatingBoard(data, rateB);
    } else if (compActiveTab === 'time') {
      if (timeB) timeB.innerHTML = '<div class="lb-empty">Loading circuit records…</div>';
      const r = await fetch(`${base}/api/leaderboard?type=time&map=${compSelectedMap}&scope=${compScope}${uid ? '&uid=' + encodeURIComponent(uid) : ''}`);
      if (!r.ok) throw new Error('fetch error');
      const data = await r.json();
      renderCompetitiveTimeBoard(data, timeB);
    } else if (compActiveTab === 'daily') {
      if (dailyB) dailyB.innerHTML = '<div class="lb-empty">Loading Daily Cup…</div>';
      const r = await fetch(`${base}/api/competitions/daily${uid ? '?uid=' + encodeURIComponent(uid) : ''}`);
      if (!r.ok) throw new Error('fetch error');
      const data = await r.json();
      renderCompetitiveDailyBoard(data, dailyB);
    } else if (compActiveTab === 'weekly') {
      if (weeklyB) weeklyB.innerHTML = '<div class="lb-empty">Loading Founders Cup…</div>';
      const r = await fetch(`${base}/api/competitions/weekly${uid ? '?uid=' + encodeURIComponent(uid) : ''}`);
      if (!r.ok) throw new Error('fetch error');
      const data = await r.json();
      renderCompetitiveWeeklyBoard(data, weeklyB);
    }
  } catch (err) {
    const activeEl = compActiveTab === 'rate' ? rateB : (compActiveTab === 'time' ? timeB : (compActiveTab === 'daily' ? dailyB : weeklyB));
    if (activeEl) activeEl.innerHTML = '<div class="lb-empty">Rankings offline — race to set the first score!</div>';
  }
}

function renderCompetitiveRatingBoard(data, container) {
  if (!container) return;
  const rows = data.rows || [];
  if (!rows.length) { container.innerHTML = '<div class="lb-empty">No rated racers yet — win a 1v1 to claim #1!</div>'; return; }

  const uBar = $('comp-user-bar');
  if (uBar) {
    if (data.userRank) {
      uBar.hidden = false;
      const rEl = $('cub-rank'); if (rEl) rEl.textContent = '#' + data.userRank;
      const tEl = $('cub-tier');
      const uRow = rows.find((r) => r.rank === data.userRank);
      if (tEl && uRow && uRow.tier) {
        tEl.textContent = uRow.tier.name;
        tEl.style.color = uRow.tier.col;
        tEl.style.borderColor = uRow.tier.col;
      }
      const vEl = $('cub-val'); if (vEl && uRow) vEl.textContent = uRow.rating + ' ELO';
    } else {
      uBar.hidden = true;
    }
  }

  container.innerHTML = rows.map((r) => {
    const isMe = data.userRank === r.rank;
    const tierName = (r.tier && r.tier.name) || 'BRONZE III';
    const tierCol = (r.tier && r.tier.col) || '#d09a6a';
    return `<div class="lb-row${isMe ? ' me' : ''}">` +
      `<span class="lb-pos">#${r.rank}</span>` +
      `<span class="lb-name">${escapeHtml(r.name)} <i>Lv${r.level || 1}</i> <span class="tier-badge" style="color:${tierCol};border-color:${tierCol}">${tierName}</span></span>` +
      `<span class="lb-val" style="color:${tierCol}">${r.rating}</span>` +
      `<span class="lb-time">${r.winRate || '0%'}</span>` +
      `</div>`;
  }).join('');
}

function renderCompetitiveTimeBoard(data, container) {
  if (!container) return;
  const rows = data.rows || [];
  if (!rows.length) { container.innerHTML = '<div class="lb-empty">No track times yet on this circuit — set the record!</div>'; return; }

  container.innerHTML = rows.map((r, i) => {
    const isMe = data.userRank === r.rank;
    const gap = (i === 0 || !rows[0].t || !r.t) ? '' : ` (+${(r.t - rows[0].t).toFixed(2)}s)`;
    return `<div class="lb-row${isMe ? ' me' : ''}">` +
      `<span class="lb-pos">#${r.rank}</span>` +
      `<span class="lb-name">${escapeHtml(r.name)}${isMe ? ' ★' : ''}</span>` +
      `<span class="lb-time">${r.timeFormatted}${gap}</span>` +
      `</div>`;
  }).join('');
}

function renderCompetitiveDailyBoard(data, container) {
  if (!container) return;
  const rows = data.leaderboard || [];
  if (!rows.length) { container.innerHTML = `<div class="lb-empty">No daily times today on ${data.mapName || 'circuit'} — be the first!</div>`; return; }

  container.innerHTML = `<div class="daily-meta" style="margin-bottom:6px">📅 ${data.mapName || 'DAILY'} · ⏳ Ends in ${data.endsInFormatted || ''} · 🎁 +150 XP</div>` +
    rows.map((r) => {
      const isMe = data.userEntry && data.userEntry.rank === r.rank;
      return `<div class="lb-row${isMe ? ' me' : ''}">` +
        `<span class="lb-pos">#${r.rank}</span>` +
        `<span class="lb-name">${escapeHtml(r.name)}${isMe ? ' ★' : ''}</span>` +
        `<span class="lb-time">${r.bestFormatted || r.time}</span>` +
        `</div>`;
    }).join('');
}

function renderCompetitiveWeeklyBoard(data, container) {
  if (!container) return;
  const rows = data.leaderboard || [];
  if (!rows.length) { container.innerHTML = `<div class="lb-empty">Founders Cup in progress — race to earn points!</div>`; return; }

  container.innerHTML = `<div class="daily-meta" style="margin-bottom:6px">🏆 FOUNDERS CUP (${data.weekKey || 'THIS WEEK'}) · ⏳ Ends in ${data.endsInFormatted || ''}</div>` +
    rows.map((r) => {
      const isMe = data.userEntry && data.userEntry.rank === r.rank;
      return `<div class="lb-row${isMe ? ' me' : ''}">` +
        `<span class="lb-pos">#${r.rank}</span>` +
        `<span class="lb-name">${escapeHtml(r.name)}${isMe ? ' ★' : ''} <i>${r.wins || 0}W</i></span>` +
        `<span class="lb-val" style="color:#ffd479">${r.points} PTS</span>` +
        `</div>`;
    }).join('');
}

function wireCompetitiveHub() {
  const tRate = $('board-tab-rate'), tTime = $('board-tab-time'), tDaily = $('board-tab-daily'), tWeekly = $('board-tab-weekly');
  const sTop = $('scope-top'), sNear = $('scope-nearby');

  if (tRate) tRate.addEventListener('click', () => { compActiveTab = 'rate'; loadCompetitiveHub(); });
  if (tTime) tTime.addEventListener('click', () => { compActiveTab = 'time'; loadCompetitiveHub(); });
  if (tDaily) tDaily.addEventListener('click', () => { compActiveTab = 'daily'; loadCompetitiveHub(); });
  if (tWeekly) tWeekly.addEventListener('click', () => { compActiveTab = 'weekly'; loadCompetitiveHub(); });

  if (sTop) sTop.addEventListener('click', () => { compScope = 'top'; sTop.classList.add('active'); if (sNear) sNear.classList.remove('active'); loadCompetitiveHub(); });
  if (sNear) sNear.addEventListener('click', () => { compScope = 'nearby'; sNear.classList.add('active'); if (sTop) sTop.classList.remove('active'); loadCompetitiveHub(); });

  document.querySelectorAll('.mf-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mf-pill').forEach((b) => b.classList.toggle('active', b === btn));
      compSelectedMap = parseInt(btn.dataset.map, 10) || 0;
      loadCompetitiveHub();
    });
  });

  const cWa = $('comp-wa-share');
  if (cWa) {
    cWa.addEventListener('click', () => {
      const rName = (prefs.name || 'A RACER').slice(0, 14);
      const msg = `🏆 I'm racing on Sridhar Rush! Check out the live competitive rankings and challenge me: ${location.origin}/`;
      track('share', selectedMap, { channel: 'wa' });
      window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
    });
  }

  const cTg = $('comp-tg-share');
  if (cTg) {
    cTg.addEventListener('click', () => {
      const text = `🏆 Race with me on Sridhar Rush and climb the global competitive leaderboard!`;
      track('share', selectedMap, { channel: 'tg' });
      window.open(`https://t.me/share/url?url=${encodeURIComponent(location.origin + '/')}&text=${encodeURIComponent(text)}`, '_blank');
    });
  }

  loadCompetitiveHub();
}
$('rematch-btn').addEventListener('click', () => {
  clearAutoRematchTimer();
  $('results').classList.add('hidden');
  const humanRival = latest && latest.cars && latest.cars[1] && latest.cars[1].p === 1 && !latest.bot;
  if (humanRival) { net.send({ type: 'rematch' }); toast('🔁 Rematch requested — waiting for rival…'); }
  else net.send({ type: 'start' });
  track('second_race', selectedMap);
  track('race', selectedMap);
  if (humanRival) track('multiplayer', selectedMap);
});
const rstBtn = $('restart-btn');
if (rstBtn) rstBtn.addEventListener('click', () => { // v61 quick restart (no reload/reconnect)
  clearAutoRematchTimer();
  const ov = $('tt-overlay'); if (ov) ov.classList.add('hidden');
  TT.done = false;
  net.send({ type: 'restart' });
});
const trkBtn = $('track-btn');
if (trkBtn) trkBtn.addEventListener('click', () => { clearAutoRematchTimer(); $('results').classList.add('hidden'); net.send({ type: 'reset' }); const nb = $('next-btn'); if (nb) setTimeout(() => nb.click(), 150); });
$('menu-btn').addEventListener('click', () => { clearAutoRematchTimer(); $('results').classList.add('hidden'); net.send({ type: 'reset' }); });
document.querySelectorAll('.map-card').forEach((b) => b.addEventListener('click', () => {
  selectedMap = parseInt(b.dataset.map, 10);
  document.querySelectorAll('.map-card').forEach((x) => x.classList.toggle('active', x === b));
  net.send({ type: 'map', map: selectedMap });
}));
document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => {
  const m = b.dataset.mode;
  viewMode = m;
  document.querySelectorAll('.mode-btn').forEach((x) => x.classList.toggle('active', x === b));
  if (m === 'split') { splitScreen = true; net.send({ type: 'mode', mode: 'race' }); toast('🏁 LOCAL DUEL — connect 2 phones, press START'); }
  else { splitScreen = false; net.send({ type: 'mode', mode: m }); }
  const div = $('split-divider'); if (div) div.style.display = splitScreen ? '' : 'none';
}));
document.querySelectorAll('.map-btn').forEach((b) => b.addEventListener('click', () => net.send({ type: 'map', map: parseInt(b.dataset.map, 10) })));
$('copy-code').addEventListener('click', () => { copyText($('room-code').textContent); toast('Room code copied!'); track('share', undefined, { channel: 'code' }); });
const exitBtn = $('exit-btn');
if (exitBtn) exitBtn.addEventListener('click', () => net.send({ type: 'reset' }));
$('copy-game-link').addEventListener('click', () => { copyText($('game-link').textContent); toast('Game link copied — send it to your friend!'); track('share', selectedMap, { channel: 'link' }); });

const waShareBtn = $('wa-share');
if (waShareBtn) {
  waShareBtn.addEventListener('click', () => {
    const link = ($('game-link') && $('game-link').textContent) ? $('game-link').textContent : (roomCode ? `${location.origin}/?room=${roomCode}` : `${location.origin}/`);
    const msg = `🏎️ Race with me in Sridhar Rush! Join my room here: ${link}`;
    track('share', selectedMap, { channel: 'wa' });
    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
  });
}

const tgShareBtn = $('tg-share');
if (tgShareBtn) {
  tgShareBtn.addEventListener('click', () => {
    const link = ($('game-link') && $('game-link').textContent) ? $('game-link').textContent : (roomCode ? `${location.origin}/?room=${roomCode}` : `${location.origin}/`);
    const text = '🏎️ Race with me in Sridhar Rush!';
    track('share', selectedMap, { channel: 'tg' });
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`, '_blank');
  });
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (fxComposer) fxComposer.setSize(window.innerWidth, window.innerHeight);
});
const unlockAudio = () => {
  ensureAudio();
  if (audio && audio.ctx && audio.ctx.state === 'suspended') {
    audio.ctx.resume().catch(() => {});
  }
};
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('touchstart', unlockAudio, { passive: true });
window.addEventListener('touchend', unlockAudio, { passive: true });

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let arCooldown = 0;
function adaptRes() {
  if (!prefs.ar) return;
  arCooldown--;
  if (arCooldown > 0) return;
  const dpr = window.devicePixelRatio || 1;
  const cur = renderer.getPixelRatio();
  if (fps < 48 && cur > 1) { renderer.setPixelRatio(Math.max(1, cur - 0.5)); arCooldown = 3; } // v55: adapt earlier
  else if (fps >= 48 && fps <= 52 && cur > 1.25) { renderer.setPixelRatio(Math.max(1.25, cur - 0.25)); arCooldown = 6; } // v66 mid-band trim
  else if (fps > 57 && cur < Math.min(dpr, 2)) { renderer.setPixelRatio(Math.min(Math.min(dpr, 2), cur + 0.5)); arCooldown = 3; }
}
// v50 auto smoothness ladder (only when Adaptive resolution is ON):
// sustained <45 FPS on HIGH -> drop glow, then shadows, for this session.
// Manual choices in Settings always win again on next load.
function autoTune(fpsNow, st) {
  if (fpsNow < 52) st.low++; else st.low = 0; // v55: 50-52 FPS + glow = dips; shed glow in that band
  if (st.low < 3) return null;
  st.low = 0;
  if (!st.fxOff) { st.fxOff = true; return 'fx'; }
  if (!st.shOff) { st.shOff = true; return 'shadows'; }
  return null;
}
const autoSt = { low: 0, fxOff: false, shOff: false };
const clock = new THREE.Clock();
applyQuality(prefs.quality);
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  fpsFrames++; fpsTime += dt;
  if (fpsTime >= 1) {
    fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; adaptRes();
    if (prefs.ar && prefs.quality === 'high') {
      const act = autoTune(fps, autoSt);
      if (act === 'fx') {
        prefs.fx = false;
        const fxEl = $('set-fx'); if (fxEl) fxEl.checked = false;
        toast('⚡ Glow auto-off for smoothness (Settings to re-enable)');
      } else if (act === 'shadows') {
        sunLight.castShadow = false;
        toast('⚡ Shadows auto-off for smoothness');
      }
    }
  }
  const mine = interpState(mySlot);
  let rival = null; // v76: nearest other racer
  if (latest && latest.cars) {
    const myC = latest.cars[mySlot - 1];
    const others = latest.cars.filter((c) => c.p === 1 && c.s !== mySlot);
    if (others.length) { others.sort((a, b) => Math.abs((a.pr || 0) - (myC ? myC.pr : 0)) - Math.abs((b.pr || 0) - (myC ? myC.pr : 0))); rival = interpState(others[0].s); }
  }
  if (latest && latest.state === 'countdown') updateCountdownVisual();
  for (let s = 1; s <= 6; s++) { const cs = interpState(s); if (cs && cs.p === 1) { ensureCarVisual(s); placeCar(s, cs, dt); } else if (carVisuals[s]) carVisuals[s].group.visible = false; } // v76
  if (latest && latest.state === 'racing') {
    if (mine) ghostRecord(latest.raceTime, mine.x, mine.z, mine.h);
    ghostUpdate(latest.raceTime);
  } else if (ghostGroup) ghostGroup.visible = false;
  updateParticles(dt);
  for (let i = 0; i < puMeshes.length; i++) { puMeshes[i].rotation.y += dt * 2.2; puMeshes[i].position.y = 0.8 + Math.sin(performance.now() / 300 + i * 2) * 0.12; if (latest && latest.pu) puMeshes[i].visible = latest.pu[i] === '1'; }
  updateClouds(dt);
  updateArrow(rival);
  updateAudio(mine, rival);
  updateHUD(mine, rival);
  ttHudUpdate(mine); // v61
  maybeSendKeyboard(dt);
  if (splitScreen) { renderSplit(dt); } else { updateCamera(dt, mine, rival); renderMain(); }
  if (!bootHidden) {
    bootHidden = true;
    const bs = document.getElementById('boot-splash');
    if (bs) { bs.classList.add('done'); setTimeout(() => bs.remove(), 600); }
    track('game_start');
  }
}
let bootHidden = false;
frame();
