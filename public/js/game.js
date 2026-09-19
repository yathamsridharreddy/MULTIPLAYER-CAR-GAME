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

function loadPrefs() {
  try { return Object.assign({
    name: '', color: 0xe10600, cls: 'velocity', laps: 3, bot: true,
    quality: 'high', music: true, mute: false, fpsmeter: false, rm: false, cb: false, ar: true, ghost: false, racingLine: true, fx: true, lang: 'en', hdLobby: true
  }, JSON.parse(localStorage.getItem('sr_prefs') || '{}')); }
  catch (e) { return { name: '', color: 0xe10600, cls: 'velocity', laps: 3, bot: true, quality: 'high', music: true, mute: false, fpsmeter: false, racingLine: true }; }
}
let prefs = loadPrefs();
function savePrefs() { try { localStorage.setItem('sr_prefs', JSON.stringify(prefs)); } catch (e) {} }
try {
  if (!localStorage.getItem('sr_prefs') && prefs.botSkill == null) { prefs.botSkill = 0; savePrefs(); }
} catch (e) {}
if (prefs.botSkill == null) prefs.botSkill = 1;
if (!prefs.pid) { prefs.pid = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); savePrefs(); }
if (!prefs.name) { prefs.name = 'RACER-' + prefs.pid.slice(1, 5).toUpperCase(); savePrefs(); }

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
    g.fillStyle = base; g.fillRect(0, 0, 1, 1);
    const pix = g.getImageData(0, 0, 1, 1).data;
    const r0 = pix[0], g0 = pix[1], b0 = pix[2];
    const imgData = g.createImageData(256, 256);
    const buf = new Uint32Array(imgData.data.buffer);
    for (let i = 0; i < 256 * 256; i++) {
      const n = (Math.random() * 40 - 20) | 0;
      const r = clamp(r0 + n, 0, 255);
      const gCol = clamp(g0 + (n * 1.5 | 0), 0, 255);
      const b = clamp(b0 + n, 0, 255);
      buf[i] = (255 << 24) | (b << 16) | (gCol << 8) | r;
    }
    g.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(150, 150); tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function asphaltTexture(col) {
  return getCachedTexture("asphalt_" + col, () => {
    const c = document.createElement("canvas"); c.width = 256; c.height = 256;
    const g = c.getContext("2d");
    const imgData = g.createImageData(256, 256);
    const buf = new Uint32Array(imgData.data.buffer);
    for (let i = 0; i < 256 * 256; i++) {
      const v = (28 + Math.random() * 32) | 0;
      buf[i] = (255 << 24) | ((v + 3) << 16) | (v << 8) | v;
    }
    g.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(0.1, 0.1); tex.anisotropy = 8; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function shingleRoofTexture(baseCol) {
  return getCachedTexture("shingle_" + (baseCol || "#2a2f38"), () => {
    const c = document.createElement("canvas"); c.width = 128; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = baseCol || "#2a2f38"; g.fillRect(0, 0, 128, 128);
    for (let row = 0; row < 128; row += 16) {
      const off = (row / 16) % 2 === 0 ? 0 : 12;
      g.strokeStyle = "rgba(0,0,0,0.45)"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, row); g.lineTo(128, row); g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.12)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, row + 1); g.lineTo(128, row + 1); g.stroke();
      for (let col = off; col < 128; col += 24) {
        g.strokeStyle = "rgba(0,0,0,0.3)";
        g.beginPath(); g.moveTo(col, row); g.lineTo(col, row + 16); g.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3); tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function sidingTexture(baseCol) {
  return getCachedTexture("siding_" + (baseCol || "#e2e6ec"), () => {
    const c = document.createElement("canvas"); c.width = 128; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = baseCol || "#e2e6ec"; g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 12) {
      g.strokeStyle = "rgba(0,0,0,0.22)"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.25)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y + 2); g.lineTo(128, y + 2); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2); tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function brickTexture(baseCol) {
  return getCachedTexture("brick_" + (baseCol || "#8b3a2b"), () => {
    const c = document.createElement("canvas"); c.width = 128; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = baseCol || "#8b3a2b"; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = "#d6cbbe"; g.lineWidth = 2;
    for (let y = 0; y < 128; y += 16) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke();
      const off = (y / 16) % 2 === 0 ? 0 : 16;
      for (let x = off; x < 128; x += 32) {
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 16); g.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3); tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function woodPlankTexture(baseCol) {
  return getCachedTexture("wood_" + (baseCol || "#7d5836"), () => {
    const c = document.createElement("canvas"); c.width = 128; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = baseCol || "#7d5836"; g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 14) {
      g.strokeStyle = "rgba(0,0,0,0.35)"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke();
      g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(0, y + 1, 128, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2); tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function stoneTexture(baseCol) {
  return getCachedTexture("stone_" + (baseCol || "#727880"), () => {
    const c = document.createElement("canvas"); c.width = 128; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = baseCol || "#727880"; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = "rgba(0,0,0,0.35)"; g.lineWidth = 2;
    for (let y = 0; y < 128; y += 20) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke();
      const off = (y / 20) % 2 === 0 ? 0 : 20;
      for (let x = off; x < 128; x += 40) {
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 20); g.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3); tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function concreteTexture() {
  return getCachedTexture("concrete_pave", () => {
    const c = document.createElement("canvas"); c.width = 128; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = "#b0b6be"; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 400; i++) {
      const v = (Math.random() * 30 - 15) | 0;
      g.fillStyle = v > 0 ? `rgba(255,255,255,${v / 100})` : `rgba(0,0,0,${-v / 100})`;
      g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
    g.strokeStyle = "rgba(0,0,0,0.2)"; g.lineWidth = 2;
    g.strokeRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4); tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function windowGlassTexture(lit, night) {
  return getCachedTexture(`window_${lit ? 1 : 0}_${night ? 1 : 0}`, () => {
    const c = document.createElement("canvas"); c.width = 64; c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#f0f3f6"; g.fillRect(0, 0, 64, 64);
    g.fillStyle = lit ? (night ? "#ffd97a" : "#88c0d0") : (night ? "#121824" : "#334455");
    g.fillRect(6, 6, 24, 24); g.fillRect(34, 6, 24, 24);
    g.fillRect(6, 34, 24, 24); g.fillRect(34, 34, 24, 24);
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function doorTexture(baseCol) {
  return getCachedTexture("door_" + (baseCol || "#5c3a21"), () => {
    const c = document.createElement("canvas"); c.width = 64; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = baseCol || "#5c3a21"; g.fillRect(0, 0, 64, 128);
    g.strokeStyle = "rgba(0,0,0,0.3)"; g.lineWidth = 3;
    g.strokeRect(8, 10, 48, 50); g.strokeRect(8, 68, 48, 50);
    g.fillStyle = "#d4af37"; g.beginPath(); g.arc(52, 68, 3.5, 0, Math.PI * 2); g.fill();
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function garageDoorTexture() {
  return getCachedTexture("garage_door", () => {
    const c = document.createElement("canvas"); c.width = 128; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = "#f4f6f8"; g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 32) {
      g.strokeStyle = "#c0c8d0"; g.lineWidth = 2;
      g.strokeRect(6, y + 4, 54, 24); g.strokeRect(68, y + 4, 54, 24);
      g.strokeStyle = "#707880"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function neonSignTexture(text, col, bgCol) {
  return getCachedTexture(`neon_${text}_${col}`, () => {
    const c = document.createElement("canvas"); c.width = 256; c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = bgCol || "#0a0d14"; g.fillRect(0, 0, 256, 64);
    g.strokeStyle = col; g.lineWidth = 3; g.strokeRect(4, 4, 248, 56);
    g.fillStyle = col; g.font = "900 28px Arial Black, sans-serif"; g.textAlign = "center";
    g.fillText(text, 128, 42);
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
    return tex;
  });
}
function buildingTexture(seed, night) {
  return getCachedTexture(`bldg_${seed % 3}_${night ? 1 : 0}`, () => {
    const c = document.createElement("canvas"); c.width = 64; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = night ? ["#141a26", "#1a1626", "#10141f"][seed % 3] : ["#22303e", "#2c2a33", "#3a3f47"][seed % 3];
    g.fillRect(0, 0, 64, 128);
    for (let y = 6; y < 122; y += 10) for (let x = 5; x < 58; x += 10) {
      const r = Math.random();
      g.fillStyle = night
        ? (r < 0.5 ? (r < 0.2 ? "#ff4fd8" : "#39d5ff") : (r < 0.7 ? "#ffd97a" : "#0a0e18"))
        : (r < 0.24 ? "#ffd97a" : (r < 0.55 ? "#5f7488" : "#1b2530"));
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

let clouds = [];
let crowdFlashes = [];
let ambientBlimp = null;
let blimpAngle = 0;

function addClouds() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(255,255,255,0.9)";
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
  if (ambientBlimp) {
    blimpAngle += dt * 0.04;
    ambientBlimp.position.set(Math.cos(blimpAngle) * 230, 130 + Math.sin(blimpAngle * 2) * 8, Math.sin(blimpAngle) * 230);
    ambientBlimp.rotation.y = -blimpAngle - Math.PI / 2;
  }
  if (crowdFlashes.length > 0) {
    for (const fl of crowdFlashes) {
      if (fl.timer > 0) {
        fl.timer -= dt;
        fl.mesh.material.opacity = Math.max(0, fl.timer * 4.5);
      } else if (Math.random() < 0.035) {
        fl.timer = 0.18 + Math.random() * 0.12;
        fl.mesh.material.opacity = 0.95;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3D Surface & Track Geometry Engine
// ---------------------------------------------------------------------------
function getSurfaceY(map, x, z) {
  if (!map) return 0;
  let th = 0, latDist = 0;
  if (map.type === 'spline' && map.nearest) {
    const n = map.nearest(x, z);
    th = n.th;
    latDist = Math.abs(n.d);
  } else {
    th = Math.atan2(z, x);
    const rad = CORE.radialDistToTrack(x, z, map.a, map.b);
    latDist = Math.abs(rad.d);
  }
  const yRoad = CORE.getTrackElevation(map, th) + 0.08;
  if (latDist <= RH + 1.2) return yRoad;
  const yTerr = CORE.getTerrainHeight(map, x, z);
  const t = Math.min(1, (latDist - (RH + 1.2)) / 6.0);
  const w = t * t * (3 - 2 * t);
  return (1 - w) * yRoad + w * yTerr;
}

function ribbon3D(pts, offset, halfW, yOffset, mat, map) {
  const n = pts.length;
  const pos = [];
  const uvs = [];
  const idx = [];
  let cumLen = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    let tx = q.x - p.x, tz = q.z - p.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    const nx = -tz, nz = tx;
    const lx = p.x + nx * (offset - halfW), lz = p.z + nz * (offset - halfW);
    const rx = p.x + nx * (offset + halfW), rz = p.z + nz * (offset + halfW);
    let th = 0;
    if (map && map.type === "spline" && map.nearest) {
      th = map.nearest(p.x, p.z).th;
    } else {
      th = Math.atan2(p.z, p.x);
    }
    const roadY = map ? (CORE.getTrackElevation(map, th) + (yOffset || 0.08)) : (yOffset || 0.08);
    pos.push(rx, roadY, rz, lx, roadY, lz);
    const vCoord = cumLen * 0.08;
    uvs.push(1, vCoord, 0, vCoord);
    cumLen += L;
  }
  for (let i = 0; i < n; i++) {
    const a = 2 * i, b = 2 * i + 1, c = 2 * ((i + 1) % n), d = 2 * ((i + 1) % n) + 1;
    // Upward-facing winding
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat); m.receiveShadow = true;
  worldGroup.add(m); return m;
}

function getTrackPts(map, numPts) {
  const N = numPts || 512;
  if (map && map.type === "spline" && map.offsetPts) {
    return map.offsetPts(0, N);
  }
  const pts = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * PI2;
    pts.push({ x: A * Math.cos(th), z: B * Math.sin(th) });
  }
  return pts;
}

function getOffsetPts(map, offset, numPts) {
  const N = numPts || 512;
  if (map && map.type === "spline" && map.offsetPts) {
    return map.offsetPts(offset, N);
  }
  const pts = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * PI2;
    const ax = A + offset, bz = B + offset;
    pts.push({ x: ax * Math.cos(th), z: bz * Math.sin(th) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// 3D Continuous Terrain Mesh Generator
// ---------------------------------------------------------------------------
function build3DTerrain(map, T) {
  const W = 1600, H = 1600, SEGS = 140;
  const geo = new THREE.PlaneGeometry(W, H, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = [];
  const cGrass = new THREE.Color(T.ground || "#41702f");
  const cRock = new THREE.Color(T.night ? "#1e2430" : (map.theme === "desert" ? "#a66a42" : "#68727a"));
  const cSand = new THREE.Color("#d8b478");
  const cSnow = new THREE.Color("#f0f6fa");
  const tempCol = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = CORE.getTerrainHeight(map, x, z);
    pos.setY(i, y);

    if (map.theme === "snow") {
      tempCol.copy(cSnow).lerp(cRock, clamp((y - 12) / 20, 0, 0.45));
    } else if (map.theme === "desert") {
      tempCol.copy(cRock).lerp(cSand, clamp((10 - y) / 15, 0, 0.6));
    } else if (map.theme === "island") {
      if (y < 1.2) tempCol.copy(cSand);
      else tempCol.copy(cSand).lerp(cGrass, clamp((y - 1.2) / 6, 0, 1));
    } else if (map.theme === "neon") {
      tempCol.setHex(T.ground ? parseInt(T.ground.replace("#", "0x")) : 0x141821);
    } else {
      if (y > 9) tempCol.copy(cGrass).lerp(cRock, clamp((y - 9) / 10, 0, 0.7));
      else tempCol.copy(cGrass);
    }
    colors.push(tempCol.r, tempCol.g, tempCol.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: grassTexture(T.ground || (T.night ? "#141821" : "#41702f")),
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.05
  });
  const terrain = new THREE.Mesh(geo, mat);
  terrain.receiveShadow = true;
  worldGroup.add(terrain);

  if (T.ocean) {
    const waterGeo = new THREE.PlaneGeometry(3000, 3000, 32, 32);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x18a0b8,
      roughness: 0.2,
      metalness: 0.3,
      transparent: true,
      opacity: 0.88
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = -0.4;
    worldGroup.add(water);
  }
}

// ---------------------------------------------------------------------------
// 3D Elevated Track, Curbs, Dashes & Barriers
// ---------------------------------------------------------------------------
function build3DTrackAndRoad(map, T) {
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.8, side: THREE.DoubleSide });
  const asphaltMat = new THREE.MeshStandardMaterial({
    map: asphaltTexture(T.night ? "#16181e" : "#2a2d32"),
    roughness: 0.92,
    metalness: 0.05,
    side: THREE.DoubleSide
  });

  const pts = getTrackPts(map, 512);

  // 1. Road Surface Ribbon
  ribbon3D(pts, 0, RH, 0.08, asphaltMat, map);

  // 2. White Edge Lines
  ribbon3D(getOffsetPts(map, RH - 0.7, 512), 0, 0.18, 0.10, lineMat, map);
  ribbon3D(getOffsetPts(map, -(RH - 0.7), 512), 0, 0.18, 0.10, lineMat, map);

  // 3. Yellow/White Dashed Centerline
  {
    const dashGeo = new THREE.BoxGeometry(0.32, 0.03, 2.4);
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xf2e14c, roughness: 0.7 });
    const STEPS = 160, dashes = [];
    for (let i = 0; i < STEPS; i++) {
      if (i % 4 >= 2) continue;
      const idx = Math.floor((i / STEPS) * pts.length);
      const p = pts[idx], q = pts[(idx + 1) % pts.length];
      const yaw = Math.atan2(q.x - p.x, q.z - p.z);
      const dy = CORE.getTerrainHeight(map, q.x, q.z) - CORE.getTerrainHeight(map, p.x, p.z);
      const pitch = -Math.atan2(dy, Math.hypot(q.x - p.x, q.z - p.z) || 1);
      const y = CORE.getTerrainHeight(map, p.x, p.z);
      dashes.push({ x: p.x, y: y + 0.10, z: p.z, yaw, pitch });
    }
    const inst = new THREE.InstancedMesh(dashGeo, dashMat, dashes.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Euler = new THREE.Euler(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
    dashes.forEach((d, i) => {
      Euler.set(d.pitch, d.yaw, 0, "YXZ");
      Q.setFromEuler(Euler);
      M.compose(V.set(d.x, d.y, d.z), Q, S);
      inst.setMatrixAt(i, M);
    });
    inst.receiveShadow = true;
    worldGroup.add(inst);
  }

  // 4. Red & White Alternating Rumble Curbs
  {
    const curbGeo = new THREE.BoxGeometry(1.0, 0.08, 2.6);
    const curbR = new THREE.MeshStandardMaterial({ color: 0xc9302c, roughness: 0.85, side: THREE.DoubleSide });
    const curbW = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.85, side: THREE.DoubleSide });

    const makeCurbLine = (side) => {
      const cpts = getOffsetPts(map, (RH + 0.6) * side, 1024);
      const items = [];
      let acc = 0, lx = cpts[0].x, lz = cpts[0].z;
      for (let i = 1; i <= 1024; i++) {
        const p = cpts[i % 1024];
        acc += Math.hypot(p.x - lx, p.z - lz); lx = p.x; lz = p.z;
        if (acc >= 2.6) {
          acc = 0;
          const q = cpts[(i + 1) % 1024];
          const yaw = Math.atan2(q.x - p.x, q.z - p.z);
          const dy = CORE.getTerrainHeight(map, q.x, q.z) - CORE.getTerrainHeight(map, p.x, p.z);
          const pitch = -Math.atan2(dy, Math.hypot(q.x - p.x, q.z - p.z) || 1);
          const y = CORE.getTerrainHeight(map, p.x, p.z);
          items.push({ x: p.x, y: y + 0.10, z: p.z, yaw, pitch });
        }
      }
      const ir = new THREE.InstancedMesh(curbGeo, curbR, Math.ceil(items.length / 2));
      const iw = new THREE.InstancedMesh(curbGeo, curbW, Math.floor(items.length / 2));
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Euler = new THREE.Euler(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
      let ri = 0, wi = 0;
      items.forEach((it, ix) => {
        Euler.set(it.pitch, it.yaw, 0, "YXZ");
        Q.setFromEuler(Euler);
        M.compose(V.set(it.x, it.y, it.z), Q, S);
        if (ix % 2 === 0) ir.setMatrixAt(ri++, M); else iw.setMatrixAt(wi++, M);
      });
      ir.receiveShadow = iw.receiveShadow = true;
      worldGroup.add(ir, iw);
    };
    makeCurbLine(1); makeCurbLine(-1);
  }

  // 5. Solid Barriers + Rails along Boundary
  {
    const wallGeo = new THREE.BoxGeometry(0.5, 0.95, 2.7);
    const wallMat = new THREE.MeshStandardMaterial({ color: T.night ? 0x3a4050 : 0xb9bec4, roughness: 0.85 });
    const railGeo = new THREE.BoxGeometry(0.54, 0.14, 2.7);
    const railMat = new THREE.MeshStandardMaterial({ color: T.night ? 0x39d5ff : 0xc9302c, roughness: 0.6 });

    const makeWallLine = (side) => {
      const wpts = getOffsetPts(map, (RH + 3.65) * side, 1024);
      const items = [];
      let acc = 0, lx = wpts[0].x, lz = wpts[0].z;
      for (let i = 1; i <= 1024; i++) {
        const p = wpts[i % 1024];
        acc += Math.hypot(p.x - lx, p.z - lz); lx = p.x; lz = p.z;
        if (acc >= 2.6) {
          acc = 0;
          const q = wpts[(i + 1) % 1024];
          const yaw = Math.atan2(q.x - p.x, q.z - p.z);
          const dy = CORE.getTerrainHeight(map, q.x, q.z) - CORE.getTerrainHeight(map, p.x, p.z);
          const pitch = -Math.atan2(dy, Math.hypot(q.x - p.x, q.z - p.z) || 1);
          const y = CORE.getTerrainHeight(map, p.x, p.z);
          items.push({ x: p.x, y, z: p.z, yaw, pitch });
        }
      }
      const walls = new THREE.InstancedMesh(wallGeo, wallMat, items.length);
      const rails = new THREE.InstancedMesh(railGeo, railMat, items.length);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Euler = new THREE.Euler(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
      items.forEach((it, ix) => {
        Euler.set(it.pitch, it.yaw, 0, "YXZ");
        Q.setFromEuler(Euler);
        M.compose(V.set(it.x, it.y + 0.475, it.z), Q, S); walls.setMatrixAt(ix, M);
        M.compose(V.set(it.x, it.y + 1.02, it.z), Q, S); rails.setMatrixAt(ix, M);
      });
      walls.receiveShadow = rails.receiveShadow = true;
      worldGroup.add(walls, rails);
    };
    makeWallLine(1); makeWallLine(-1);
  }

  // 6. Start / Finish Gantry Banner
  {
    const p0 = pts[0], p1 = pts[1];
    const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    const y0 = CORE.getTerrainHeight(map, p0.x, p0.z);

    const c = document.createElement("canvas"); c.width = 160; c.height = 32;
    const g = c.getContext("2d");
    for (let i = 0; i < 10; i++) for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? "#101010" : "#f4f4f4";
      g.fillRect(i * 16, j * 16, 16, 16);
    }
    const tex = new THREE.CanvasTexture(c); tex.magFilter = THREE.NearestFilter; tex.encoding = THREE.sRGBEncoding;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(RH * 2, 2.6), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.75 }));
    line.rotation.x = -Math.PI / 2; line.rotation.z = -yaw; line.position.set(p0.x, y0 + 0.10, p0.z);
    worldGroup.add(line);

    const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8dbe2, metalness: 0.7, roughness: 0.35 });
    const poleGeo = new THREE.CylinderGeometry(0.28, 0.34, 8, 10);
    const nx = Math.cos(yaw), nz = -Math.sin(yaw);
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(p0.x + (-nz) * side * (RH + 1.4), y0 + 4, p0.z + (nx) * side * (RH + 1.4));
      pole.castShadow = true; worldGroup.add(pole);
    }
    const bc = document.createElement("canvas"); bc.width = 512; bc.height = 96;
    const bg = bc.getContext("2d");
    for (let i = 0; i < 32; i++) for (let j = 0; j < 2; j++) {
      bg.fillStyle = (i + j) % 2 ? "#111" : "#f2f2f2";
      bg.fillRect(i * 16, j * 12, 16, 12);
    }
    bg.fillStyle = "rgba(10,12,20,0.88)"; bg.fillRect(0, 24, 512, 72);
    bg.fillStyle = "#ffd479"; bg.font = "900 44px Arial Black, Arial"; bg.textAlign = "center";
    bg.fillText("START / FINISH", 256, 78);
    const btex = new THREE.CanvasTexture(bc); btex.encoding = THREE.sRGBEncoding;
    const bannerMesh = new THREE.Mesh(new THREE.PlaneGeometry(RH * 2 + 2.8, 2.2),
      new THREE.MeshStandardMaterial({ map: btex, side: THREE.DoubleSide, roughness: 0.7 }));
    bannerMesh.position.set(p0.x, y0 + 7.1, p0.z); bannerMesh.rotation.y = yaw;
    bannerMesh.castShadow = true; worldGroup.add(bannerMesh);
  }
}

// ---------------------------------------------------------------------------
// Procedural 3D Building & Architectural Generator
// ---------------------------------------------------------------------------
function buildHouseModel(b, seed, night, theme) {
  const grp = new THREE.Group();
  const w = b.w, d = b.d, h = b.h;

  // Solid foundation plinth extending deep underground (5m) so building sits firmly anchored on slopes
  const foundGeo = new THREE.BoxGeometry(w + 0.4, 5.0, d + 0.4);
  const foundMat = new THREE.MeshStandardMaterial({
    color: theme === "desert" ? 0x8a5b3a : (theme === "island" ? 0x9098a0 : 0x2e3238),
    roughness: 0.95
  });
  const foundation = new THREE.Mesh(foundGeo, foundMat);
  foundation.position.y = -2.5 + 0.1;
  foundation.receiveShadow = true;
  grp.add(foundation);

  if (theme === "neon") {
    // Urban Downtown High-Rise / Skyscraper Archetype
    const bMat = new THREE.MeshStandardMaterial({ map: buildingTexture(seed, true), roughness: 0.85, metalness: 0.2 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x161c28, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x0f131a, roughness: 0.95 });
    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [bMat, bMat, roofMat, roofMat, bMat, bMat]);
    bodyMesh.position.y = h / 2;
    bodyMesh.castShadow = bodyMesh.receiveShadow = true;
    grp.add(bodyMesh);

    const neonCols = ["#39d5ff", "#ff20c8", "#ffe600", "#00ff88", "#9933ff"];
    const signCol = neonCols[seed % neonCols.length];
    const signNames = ["RAMEN 24/7", "SPEED TUNE", "HOTEL NEON", "CYBER LOUNGE", "24/7 MART", "APEX BAR"];
    const signName = signNames[seed % signNames.length];
    const sTex = neonSignTexture(signName, signCol, "#080a10");
    const sMat = new THREE.MeshStandardMaterial({ map: sTex, emissiveMap: sTex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.6 });
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.75, 1.8), sMat);
    signMesh.position.set(0, 3.4, d / 2 + 0.08);
    grp.add(signMesh);

    const ph = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 3.2, d * 0.4), wallMat);
    ph.position.set(0, h + 1.6, 0); ph.castShadow = true; grp.add(ph);

    const hvac = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.4, 2.0), wallMat);
    hvac.position.set(w * 0.22, h + 0.7, d * 0.22); hvac.castShadow = true; grp.add(hvac);

    const antMat = new THREE.MeshStandardMaterial({ color: 0x8892a0, metalness: 0.8, roughness: 0.3 });
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.18, 9, 6), antMat);
    ant.position.set(0, h + 7.7, 0); grp.add(ant);

    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff1515 }));
    beacon.position.set(0, h + 12.2, 0); grp.add(beacon);

    return grp;
  }

  if (theme === "island") {
    // Coastal Modern Villa / Tropical Resort Archetype
    const stuccoMat = new THREE.MeshStandardMaterial({ color: 0xf8f9fa, roughness: 0.9 });
    const woodMat = new THREE.MeshStandardMaterial({ map: woodPlankTexture("#a67c52"), roughness: 0.85 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x225577, roughness: 0.2, metalness: 0.8 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stuccoMat);
    body.position.y = h / 2; body.castShadow = body.receiveShadow = true; grp.add(body);

    const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 0.35, d + 1.2), woodMat);
    roofSlab.position.y = h + 0.18; roofSlab.castShadow = true; grp.add(roofSlab);

    const bayWin = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, h * 0.55, 0.2), glassMat);
    bayWin.position.set(0, h * 0.55, d / 2 + 0.05); grp.add(bayWin);

    const pergola = new THREE.Mesh(new THREE.BoxGeometry(w * 0.45, 0.15, 3.2), woodMat);
    pergola.position.set(w * 0.25, h * 0.7, d / 2 + 1.6); grp.add(pergola);

    return grp;
  }

  if (theme === "desert") {
    // Southwestern Adobe & Frontier Outpost Archetype
    const adobeMat = new THREE.MeshStandardMaterial({ color: 0xd49b6a, roughness: 0.95 });
    const vigaMat = new THREE.MeshStandardMaterial({ color: 0x4a321f, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xb57c4c, roughness: 0.95 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [adobeMat, adobeMat, roofMat, roofMat, adobeMat, adobeMat]);
    body.position.y = h / 2; body.castShadow = body.receiveShadow = true; grp.add(body);

    const vigaGeo = new THREE.CylinderGeometry(0.14, 0.14, d + 0.8, 6);
    vigaGeo.rotateX(Math.PI / 2);
    for (let k = -2; k <= 2; k++) {
      const viga = new THREE.Mesh(vigaGeo, vigaMat);
      viga.position.set(k * (w * 0.18), h - 0.5, 0);
      grp.add(viga);
    }

    if (seed % 3 === 0) {
      const tankGeo = new THREE.CylinderGeometry(1.6, 1.6, 2.4, 10);
      const tankMat = new THREE.MeshStandardMaterial({ color: 0x6e4e37, roughness: 0.9 });
      const tank = new THREE.Mesh(tankGeo, tankMat);
      tank.position.set(w / 2 + 2.5, h + 1.5, 0); grp.add(tank);
    }
    return grp;
  }

  if (theme === "snow") {
    // Alpine Ski Chalet Archetype
    const logMat = new THREE.MeshStandardMaterial({ map: woodPlankTexture("#4a3525"), roughness: 0.9 });
    const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTexture("#757a82"), roughness: 0.95 });
    const snowMat = new THREE.MeshStandardMaterial({ color: 0xf4f8fb, roughness: 0.8 });
    const winMat = new THREE.MeshStandardMaterial({ map: windowGlassTexture(true, true), emissive: new THREE.Color(0xffaa33), emissiveIntensity: 1.2 });

    const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 1.8, d + 0.3), stoneMat);
    base.position.y = 0.9; base.receiveShadow = true; grp.add(base);

    const logBody = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), logMat);
    logBody.position.y = 1.8 + h / 2; logBody.castShadow = true; grp.add(logBody);

    const roofH = h * 0.75;
    const roofPrism = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) * 0.68, roofH, 4), snowMat);
    roofPrism.rotation.y = Math.PI / 4;
    roofPrism.position.y = 1.8 + h + roofH / 2 - 0.2;
    roofPrism.castShadow = true; grp.add(roofPrism);

    for (const side of [-1, 1]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.4), winMat);
      win.position.set(side * (w * 0.25), 2.8 + h * 0.3, d / 2 + 0.05);
      grp.add(win);
    }

    const balc = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.2, 1.5), logMat);
    balc.position.set(0, 1.8 + h * 0.5, d / 2 + 0.75); grp.add(balc);

    return grp;
  }

  // Highland Suburban & Rural House (Default)
  const sidingColors = ["#d8dfe6", "#f2ece4", "#a43828", "#546b58", "#4b5b73"];
  const sidingCol = sidingColors[seed % sidingColors.length];
  const wallMat = new THREE.MeshStandardMaterial({ map: sidingTexture(sidingCol), roughness: 0.88 });
  const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTexture("#727880"), roughness: 0.95 });
  const roofMat = new THREE.MeshStandardMaterial({ map: shingleRoofTexture(["#2e3440", "#4c3b2e", "#3b4252"][seed % 3]), roughness: 0.9 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.7 });
  const doorMat = new THREE.MeshStandardMaterial({ map: doorTexture("#4a2e18") });
  const winMat = new THREE.MeshStandardMaterial({ map: windowGlassTexture(true, false) });
  const garMat = new THREE.MeshStandardMaterial({ map: garageDoorTexture() });

  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.6, d + 0.4), stoneMat);
  plinth.position.y = 0.3; plinth.receiveShadow = true; grp.add(plinth);

  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  walls.position.y = 0.6 + h / 2; walls.castShadow = walls.receiveShadow = true; grp.add(walls);

  const roofH = h * 0.65;
  const roofMesh = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) * 0.64, roofH, 4), roofMat);
  roofMesh.rotation.y = Math.PI / 4;
  roofMesh.position.y = 0.6 + h + roofH / 2 - 0.25;
  roofMesh.castShadow = true; grp.add(roofMesh);

  const porchW = w * 0.42, porchD = 2.5;
  const porchDeck = new THREE.Mesh(new THREE.BoxGeometry(porchW, 0.25, porchD), trimMat);
  porchDeck.position.set(0, 0.35, d / 2 + porchD / 2); grp.add(porchDeck);

  const colGeo = new THREE.BoxGeometry(0.18, h * 0.65, 0.18);
  for (const cSide of [-1, 1]) {
    const col = new THREE.Mesh(colGeo, trimMat);
    col.position.set(cSide * (porchW / 2 - 0.2), 0.35 + (h * 0.65) / 2, d / 2 + porchD - 0.2);
    grp.add(col);
  }

  const porchAwning = new THREE.Mesh(new THREE.BoxGeometry(porchW + 0.3, 0.18, porchD + 0.3), roofMat);
  porchAwning.position.set(0, 0.35 + h * 0.65, d / 2 + porchD / 2); grp.add(porchAwning);

  const door = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.2), doorMat);
  door.position.set(0, 0.35 + 1.1, d / 2 + 0.05); grp.add(door);

  for (const wSide of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.4), winMat);
    win.position.set(wSide * (w * 0.3), 0.6 + h * 0.55, d / 2 + 0.05);
    grp.add(win);
  }

  const garW = w * 0.5, garH = h * 0.72, garD = d * 0.85;
  const garage = new THREE.Mesh(new THREE.BoxGeometry(garW, garH, garD), wallMat);
  garage.position.set(w / 2 + garW / 2, 0.6 + garH / 2, d / 2 - garD / 2);
  garage.castShadow = true; grp.add(garage);

  const garDoor = new THREE.Mesh(new THREE.PlaneGeometry(garW * 0.85, garH * 0.8), garMat);
  garDoor.position.set(w / 2 + garW / 2, 0.6 + (garH * 0.8) / 2, d / 2 + 0.05);
  grp.add(garDoor);

  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.8, h + roofH + 0.5, 0.8), brickTexture("#8b3a2b"));
  chimney.position.set(-w / 2 + 0.6, (h + roofH) / 2, 0);
  chimney.castShadow = true; grp.add(chimney);

  const drive = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 20.0), concreteTexture());
  drive.rotation.x = -Math.PI / 2;
  drive.position.set(w / 2 + garW / 2, 0.04, d / 2 + 10.0);
  drive.receiveShadow = true; grp.add(drive);

  return grp;
}

function buildProceduralNeighborhood(map, T, W) {
  if (!W || !W.buildings) return;
  W.buildings.forEach((b, i) => {
    const hMesh = buildHouseModel(b, i, T.night, map.theme);
    const y = CORE.getTerrainHeight(map, b.x, b.z);

    let trackX = 0, trackZ = 0;
    if (map.type === "spline" && map.nearest) {
      const n = map.nearest(b.x, b.z);
      trackX = n.cx; trackZ = n.cz;
    } else {
      const th = Math.atan2(b.z, b.x);
      trackX = A * Math.cos(th); trackZ = B * Math.sin(th);
    }
    const faceYaw = Math.atan2(trackX - b.x, trackZ - b.z);

    hMesh.position.set(b.x, y, b.z);
    hMesh.rotation.y = faceYaw;
    worldGroup.add(hMesh);
  });
}

// ---------------------------------------------------------------------------
// Roadside Furniture, Signs, Streetlights & Horizon Mountains
// ---------------------------------------------------------------------------
function buildRoadsideInfrastructure(map, T, W) {
  const pts = getTrackPts(map, 512);

  // 1. Instanced Streetlights along Outer Road Shoulder
  {
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.18, 7.5, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3d434d, metalness: 0.7, roughness: 0.35 });
    const lampGeo = new THREE.BoxGeometry(1.6, 0.35, 0.5);
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfffaed,
      emissive: map.theme === "neon" ? 0x39d5ff : 0xffe899,
      emissiveIntensity: T.night ? 3.5 : 2.0
    });

    const numLights = 32;
    const lightPoles = new THREE.InstancedMesh(poleGeo, poleMat, numLights);
    const lightHeads = new THREE.InstancedMesh(lampGeo, lampMat, numLights);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Euler = new THREE.Euler(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);

    for (let i = 0; i < numLights; i++) {
      const u = i / numLights;
      const idx = Math.floor(u * pts.length);
      const p = pts[idx], q = pts[(idx + 1) % pts.length];
      let tx = q.x - p.x, tz = q.z - p.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz, nz = tx;
      const x = p.x + nx * (RH + 2.2);
      const z = p.z + nz * (RH + 2.2);
      const y = CORE.getTerrainHeight(map, x, z);
      const yaw = Math.atan2(tx, tz);

      Euler.set(0, yaw, 0); Q.setFromEuler(Euler);
      M.compose(V.set(x, y + 3.75, z), Q, S); lightPoles.setMatrixAt(i, M);
      M.compose(V.set(x - nx * 0.6, y + 7.4, z - nz * 0.6), Q, S); lightHeads.setMatrixAt(i, M);
    }
    lightPoles.castShadow = true;
    worldGroup.add(lightPoles, lightHeads);
  }

  // 2. Sponsor Advertising Billboards
  {
    const brands = [
      ["#e10600", "NITRO"], ["#0a84ff", "APEX"], ["#ffb800", "TURBO"],
      ["#111", "SRIDHAR"], ["#00a651", "RUSH"], ["#7b2ff7", "NEON"],
      ["#ff6a00", "DRIFT"], ["#003d8f", "PIT LANE"]
    ];
    brands.forEach((b, i) => {
      const c = document.createElement("canvas"); c.width = 512; c.height = 128;
      const g = c.getContext("2d");
      g.fillStyle = b[0]; g.fillRect(0, 0, 512, 128);
      g.fillStyle = "#fff"; g.font = "900 72px Arial Black, Arial"; g.textAlign = "center";
      g.fillText(b[1], 256, 92);
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;

      const t = (i / brands.length) * PI2 + 0.35;
      const off = RH + 6.8;
      let x, z;
      if (map.ptAt) { const p = map.ptAt(t), n = map.normAt(t); x = p.x + n.x * off; z = p.z + n.z * off; }
      else { x = (A + off) * Math.cos(t); z = (B + off) * Math.sin(t); }
      const y = CORE.getTerrainHeight(map, x, z);

      const m = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.7 });
      if (T.night) { m.emissive = new THREE.Color(0xffffff); m.emissiveMap = tex; m.emissiveIntensity = 0.7; }
      const board = new THREE.Mesh(new THREE.PlaneGeometry(11, 2.7), m);
      board.position.set(x, y + 3.4, z);
      board.rotation.y = Math.atan2(-x, -z);
      board.castShadow = true;
      worldGroup.add(board);

      const postMat = new THREE.MeshStandardMaterial({ color: 0x4a4d52, metalness: 0.6, roughness: 0.4 });
      const postGeo = new THREE.CylinderGeometry(0.16, 0.22, 6, 8);
      const postYaw = Math.atan2(-x, -z);
      const pxOff = Math.cos(postYaw) * 3.8, pzOff = -Math.sin(postYaw) * 3.8;
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(x + pxOff * side, y + 1.8, z + pzOff * side);
        post.castShadow = true;
        worldGroup.add(post);
      }
    });
  }

  // 3. Mountains & Distant Horizon Formations
  if (W && W.mountains) {
    for (const mt of W.mountains) {
      const mat = new THREE.MeshStandardMaterial({
        color: mt.volcano ? 0x6a4a3a : (T.night ? 0x2a3040 : (map.theme === "desert" ? "#9e623a" : 0x8598ab)),
        roughness: 1,
        flatShading: true
      });
      const mx = Math.cos(mt.t) * mt.dist, mz = Math.sin(mt.t) * mt.dist;
      const my = CORE.getTerrainHeight(map, mx, mz);
      const mtn = new THREE.Mesh(new THREE.ConeGeometry(mt.r, mt.h, 6), mat);
      mtn.position.set(mx, my + mt.h / 2 - 6, mz);
      mtn.rotation.y = mt.rot;
      worldGroup.add(mtn);

      if (mt.volcano) {
        const lava = new THREE.Mesh(new THREE.ConeGeometry(mt.r * 0.25, mt.h * 0.12, 6),
          new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff3300, emissiveIntensity: 1.6 }));
        lava.position.set(mx, my + mt.h - 8, mz);
        worldGroup.add(lava);
      }
    }
  }

  // 4. On-Track Tire-Stack Hazards (solid & stop the car)
  if (W && W.hazards) {
    const hzTire = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9 });
    const hzRed = new THREE.MeshStandardMaterial({ color: 0xc9302c, roughness: 0.8 });
    const hzGeo = new THREE.CylinderGeometry(0.75, 0.78, 0.34, 14);
    for (const hz of W.hazards) {
      const hy = CORE.getTerrainHeight(map, hz.x, hz.z);
      for (let k = 0; k < 4; k++) {
        const tire = new THREE.Mesh(hzGeo, k % 2 === 1 ? hzRed : hzTire);
        tire.position.set(hz.x, hy + 0.17 + k * 0.34, hz.z);
        tire.castShadow = true;
        worldGroup.add(tire);
      }
    }
  }

  // 5. Trackside Spectator Grandstands (Parallel Along Track Outer Verge)
  {
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x2b303c, roughness: 0.9 });
    const seatR = new THREE.MeshStandardMaterial({ color: 0xc9302c, roughness: 0.7 });
    const seatB = new THREE.MeshStandardMaterial({ color: 0x0a84ff, roughness: 0.7 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x1a1e26, roughness: 0.5, metalness: 0.5 });
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0xb0b6c2, metalness: 0.85, roughness: 0.25 });
    const bannerMat = new THREE.MeshStandardMaterial({ color: 0x0a84ff, emissive: 0x064d99, emissiveIntensity: 0.4 });

    const makeTracksideGrandstand = (uAlong) => {
      const gGrp = new THREE.Group();
      const idx0 = Math.floor(uAlong * pts.length) % pts.length;
      const idx1 = (idx0 + 10) % pts.length;
      const p0 = pts[idx0], p1 = pts[idx1];
      let tx = p1.x - p0.x, tz = p1.z - p0.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz, nz = tx; // outward normal (side of track)

      const standOffset = RH + 14.5;
      const gx = p0.x + nx * standOffset, gz = p0.z + nz * standOffset;
      const gy = CORE.getTerrainHeight(map, gx, gz);
      const yaw = Math.atan2(tx, tz);

      // Main structural base plinth
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(10.0, 4.0, 44.0), concreteMat);
      plinth.position.set(-1.0, -1.9, 0); gGrp.add(plinth);

      // Stepped spectator seating rows (length 42m along Z, stepping up away from track towards -X)
      for (let tier = 0; tier < 6; tier++) {
        const stepX = 2.8 - tier * 1.1;
        const stepY = 0.45 + tier * 0.75;
        const step = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.75, 42.0), concreteMat);
        step.position.set(stepX, stepY, 0);
        step.castShadow = step.receiveShadow = true;
        gGrp.add(step);

        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.25, 41.6), tier % 2 === 0 ? seatR : seatB);
        seat.position.set(stepX - 0.1, stepY + 0.45, 0);
        gGrp.add(seat);
      }

      // Trackside safety barrier & sponsor parapet wall along front edge
      const parapet = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 42.4), bannerMat);
      parapet.position.set(3.6, 0.7, 0); gGrp.add(parapet);

      // Back wall support
      const backWall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 7.5, 43.0), concreteMat);
      backWall.position.set(-5.0, 3.8, 0); backWall.castShadow = true; gGrp.add(backWall);

      // Cantilevered stadium canopy roof extending forward over seats towards the track
      const roof = new THREE.Mesh(new THREE.BoxGeometry(11.2, 0.35, 44.0), roofMat);
      roof.position.set(-0.6, 8.2, 0); roof.rotation.z = -0.09; roof.castShadow = true;
      gGrp.add(roof);

      // Steel support pillars along back wall
      const pGeo = new THREE.CylinderGeometry(0.24, 0.28, 8.5, 8);
      for (const pz of [-19.0, -9.5, 0, 9.5, 19.0]) {
        const pillar = new THREE.Mesh(pGeo, pillarMat);
        pillar.position.set(-4.8, 4.25, pz); pillar.castShadow = true;
        gGrp.add(pillar);
      }

      // Spectator crowd camera flash sprites
      for (let tier = 0; tier < 6; tier++) {
        const rowX = 2.7 - tier * 1.1;
        const rowY = 1.3 + tier * 0.75;
        for (let k = -7; k <= 7; k++) {
          if (Math.random() < 0.28) {
            const flSprite = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
            flSprite.position.set(rowX, rowY, k * 2.8 + (Math.random() - 0.5));
            flSprite.scale.set(1.4, 1.4, 1.4);
            gGrp.add(flSprite);
            crowdFlashes.push({ mesh: flSprite, timer: 0 });
          }
        }
      }

      gGrp.position.set(gx, gy, gz);
      gGrp.rotation.y = yaw;
      worldGroup.add(gGrp);
    };

    // Place grandstands on the side of the main straightaway
    makeTracksideGrandstand(0.04);
    makeTracksideGrandstand(0.94);
  }

  // 6. Coastal Yachts in Island Motorfest
  if (T.ocean) {
    const yMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.3, metalness: 0.2 });
    const deckMat = new THREE.MeshStandardMaterial({ map: woodPlankTexture("#a67c52"), roughness: 0.8 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x112233, roughness: 0.1, metalness: 0.9 });
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x8a929e, metalness: 0.9, roughness: 0.2 });

    [[-180, -220, 0.4], [210, -280, 2.1]].forEach(([yx, yz, yRot]) => {
      const yacht = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.BoxGeometry(7, 3.2, 22), yMat); hull.position.y = 1.0; yacht.add(hull);
      const deck = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.2, 21.6), deckMat); deck.position.y = 2.65; yacht.add(deck);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(5.2, 2.4, 9.0), yMat); cabin.position.set(0, 3.8, -2.0); yacht.add(cabin);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(5.3, 1.2, 8.0), glassMat); glass.position.set(0, 4.0, -1.8); yacht.add(glass);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 16, 8), mastMat); mast.position.set(0, 10.5, 2.0); yacht.add(mast);
      yacht.position.set(yx, -0.2, yz); yacht.rotation.y = yRot;
      worldGroup.add(yacht);
    });
  }

  // 7. Cyberpunk Atmospheric Blimp in Neon City
  if (map.theme === 'neon') {
    const blimp = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x181e28, roughness: 0.5, metalness: 0.8 });
    const hullGeo = new THREE.SphereGeometry(12, 16, 12);
    hullGeo.scale(1.0, 1.0, 2.8);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    blimp.add(hull);

    const gonMat = new THREE.MeshStandardMaterial({ color: 0x0e1118, metalness: 0.9, roughness: 0.3 });
    const gondola = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3.0, 14.0), gonMat);
    gondola.position.set(0, -11.5, 0);
    blimp.add(gondola);

    // Giant neon digital ad screen on hull sides
    const adMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      emissive: 0x00d4ff,
      emissiveIntensity: 1.8,
      roughness: 0.2
    });
    for (const sx of [-11.8, 11.8]) {
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6.0, 22.0), adMat);
      screen.position.set(sx, 0, 0);
      blimp.add(screen);
    }

    // Tail fins
    const finMat = new THREE.MeshStandardMaterial({ color: 0xff0055, emissive: 0xff0055, emissiveIntensity: 0.6 });
    for (let f = 0; f < 4; f++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 8.0, 6.0), finMat);
      fin.position.set(Math.sin(f * Math.PI / 2) * 8.5, Math.cos(f * Math.PI / 2) * 8.5, -24.0);
      fin.rotation.z = f * Math.PI / 2;
      blimp.add(fin);
    }

    blimp.position.set(0, 130, 0);
    worldGroup.add(blimp);
    ambientBlimp = blimp;
  }
}

// ---------------------------------------------------------------------------
// Instanced Flora & Biome Vegetation
// ---------------------------------------------------------------------------
function buildBiomeVegetation(map, T, W) {
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: T.night ? 0x1d4d2a : 0x2e6b34, roughness: 1, flatShading: true });
  const leafMat2 = new THREE.MeshStandardMaterial({ color: T.night ? 0x256b3a : 0x3d8040, roughness: 1, flatShading: true });
  const count = (W && W.trees && W.trees.length) || 0;

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
        const ty = CORE.getTerrainHeight(map, tr.x, tr.z);
        Q.setFromAxisAngle(UP, tr.rot);
        S.set(tr.s, tr.s, tr.s);
        P.set(tr.x, ty + 2.4 * tr.s, tr.z);
        M.compose(P, Q, S);
        trunkInst.setMatrixAt(i, M);

        for (let f = 0; f < 7; f++) {
          const fYaw = tr.rot + (f / 7) * PI2;
          const fPitch = 0.75;
          const fDist = 1.2 * tr.s;
          const fx = tr.x + Math.sin(fYaw) * fDist;
          const fz = tr.z + Math.cos(fYaw) * fDist;
          const fy = ty + 4.8 * tr.s;

          const fRot = new THREE.Euler(fPitch, fYaw, 0, "YXZ");
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
        const ty = CORE.getTerrainHeight(map, tr.x, tr.z);
        Q.setFromAxisAngle(UP, tr.rot);
        S.set(tr.s, tr.s, tr.s);

        P.set(tr.x, ty + 0.85 * tr.s, tr.z);
        M.compose(P, Q, S);
        trunkInst.setMatrixAt(i, M);

        P.set(tr.x, ty + 3.4 * tr.s, tr.z);
        M.compose(P, Q, S);
        cone1Inst.setMatrixAt(i, M);

        P.set(tr.x, ty + 5.3 * tr.s, tr.z);
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

// ---------------------------------------------------------------------------
// buildWorld — rebuilds all themed geometry for a map
// ---------------------------------------------------------------------------
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
  crowdFlashes = [];
  ambientBlimp = null;

  puMeshes.length = 0;
  if (CORE.pickupSpots) { // v59: visible power-ups at deterministic spots
    CORE.pickupSpots(map).forEach((sp) => {
      let m;
      if (sp.type === 0) m = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 4), new THREE.MeshStandardMaterial({ color: 0x35e0ff, emissive: 0x35e0ff, emissiveIntensity: 1.4 }));
      else if (sp.type === 1) m = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), new THREE.MeshStandardMaterial({ color: 0x3ddc84, emissive: 0x3ddc84, emissiveIntensity: 1.0, transparent: true, opacity: 0.85 }));
      else m = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.16, 8, 18), new THREE.MeshStandardMaterial({ color: 0xff20c8, emissive: 0xff20c8, emissiveIntensity: 1.2 }));
      const py = CORE.getTerrainHeight(map, sp.x, sp.z);
      m.position.set(sp.x, py + 0.8, sp.z);
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

  // 1. 3D Continuous Terrain with Biome Shading & Ocean
  build3DTerrain(map, T);

  // 2. 3D Elevated Track Ribbon, Edges, Dashed Line, Curbs & Barriers
  build3DTrackAndRoad(map, T);

  // 3. Procedural 3D Houses, Buildings & Neighborhoods
  buildProceduralNeighborhood(map, T, W);

  // 4. Roadside Infrastructure (Streetlights, Billboards, Mountain Horizons, Hazards)
  buildRoadsideInfrastructure(map, T, W);

  // 5. Instanced Biome Flora & Trees
  buildBiomeVegetation(map, T, W);

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

    points.push(new THREE.Vector3(x, (map ? CORE.getTerrainHeight(map, x, z) : 0) + 0.065, z));

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
// Car visuals (AAA High-Definition Procedural GT Supercar)
// ---------------------------------------------------------------------------
function createCar(paintColor, num, accent) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const paint = new THREE.MeshPhysicalMaterial({
    color: paintColor,
    metalness: 0.68,
    roughness: 0.18,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.25
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0a101d,
    metalness: 0.9,
    roughness: 0.05,
    clearcoat: 1.0,
    transparent: true,
    opacity: 0.82
  });
  const carbon = new THREE.MeshStandardMaterial({
    color: 0x121418,
    metalness: 0.5,
    roughness: 0.45
  });
  const s = new THREE.Shape();
  s.moveTo(-2.30, 0.16); s.lineTo(-2.42, 0.62); s.lineTo(-2.28, 0.92); s.lineTo(-1.10, 0.98);
  s.lineTo(-0.45, 1.16); s.lineTo(0.30, 1.00); s.lineTo(1.25, 0.66); s.lineTo(2.25, 0.50);
  s.lineTo(2.40, 0.26); s.lineTo(2.30, 0.14); s.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(s, { depth: 1.56, bevelEnabled: true, bevelThickness: 0.16, bevelSize: 0.16, bevelSegments: 4, steps: 1, curveSegments: 6 });
  bodyGeo.translate(0, 0, -0.78); bodyGeo.rotateY(-Math.PI / 2);
  body.add(new THREE.Mesh(bodyGeo, paint));

  // Sculpted aerodynamic cockpit canopy
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), glass);
  canopy.scale.set(0.78, 0.42, 1.45); canopy.position.set(0, 0.88, -0.35);
  body.add(canopy);

  // Carbon high-downforce rear aerodynamic wing
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

  // Front carbon splitter with aerodynamic side winglets
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

  // Rear aerodynamic diffuser channels
  const diff = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.06, 0.6), carbon);
  diff.position.set(0, 0.16, -2.55); diff.rotation.x = 0.4; body.add(diff);

  // Dual projector LED headlights & transparent lens cover
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: 0xfff0c0, emissiveIntensity: 2.8 });
  const headLensMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, roughness: 0.1 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff1515, emissive: 0xff1515, emissiveIntensity: 2.0 });

  for (const sx of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.22), headMat);
    head.position.set(sx * 0.62, 0.58, 2.42); head.rotation.y = -sx * 0.35; head.rotation.z = sx * 0.12; body.add(head);
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.11, 0.24), headLensMat);
    lens.position.set(sx * 0.62, 0.58, 2.43); lens.rotation.y = -sx * 0.35; lens.rotation.z = sx * 0.12; body.add(lens);
    const stay = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.05), carbon);
    stay.position.set(sx * 0.88, 0.93, 0.55); body.add(stay);
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.16), carbon);
    mir.position.set(sx * 0.97, 0.96, 0.55); body.add(mir);
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.5), carbon);
    vent.position.set(sx * 0.38, 0.86, 1.35); vent.rotation.x = 0.28; body.add(vent);
  }

  // Full-width continuous LED brake lightbar + high-mount brake light
  const tailBar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.05), tailMat);
  tailBar.position.set(0, 0.78, -2.62); body.add(tailBar);
  const highBrake = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.04, 0.04), tailMat);
  highBrake.position.set(0, 1.15, -1.82); body.add(highBrake);

  // Dual stainless steel exhaust pipes with blued titanium finish
  const exGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.3, 10); exGeo.rotateX(Math.PI / 2);
  const exMat = new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.95, roughness: 0.25 });
  for (const sx of [-0.35, 0.35]) { const ex = new THREE.Mesh(exGeo, exMat); ex.position.set(sx, 0.35, -2.6); body.add(ex); }

  // Race Number roundel decal
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

  // Multi-spoke alloy wheels with ventilated brake discs and colored calipers
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 20); wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.31, 12); hubGeo.rotateZ(Math.PI / 2);
  const discGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.04, 16); discGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.92 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 0.9, roughness: 0.3 });
  const discMat = new THREE.MeshStandardMaterial({ color: 0xb0b5bc, metalness: 0.92, roughness: 0.28 });
  const calMat = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.4, roughness: 0.35 });
  const capGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.32, 10); capGeo.rotateZ(Math.PI / 2);
  const wheels = [];
  [[0.98, 1.45], [-0.98, 1.45], [0.98, -1.45], [-0.98, -1.45]].forEach(([x, z], i) => {
    const pivot = new THREE.Group(); pivot.position.set(x, 0.35, z);
    const spin = new THREE.Group();
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.set(x > 0 ? -0.1 : 0.1, 0, 0);
    spin.add(new THREE.Mesh(wheelGeo, wheelMat), new THREE.Mesh(hubGeo, hubMat), new THREE.Mesh(capGeo, calMat), disc);
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 0.3), calMat);
    cal.position.set(x > 0 ? -0.16 : 0.16, 0, 0.24);
    pivot.add(spin, cal);
    g.add(pivot);
    wheels.push({ pivot, spin, front: i < 2 });
  });
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, body, wheels, paint, hubMat, calMat, headMat, tailMat, glassMat: glass };
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
  const gy = curMap ? getSurfaceY(curMap, s[1], s[2]) : 0; ghostGroup.position.set(s[1], gy, s[2]); ghostGroup.rotation.y = s[3];

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
// Particles
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
  const py = (curMap ? CORE.getTerrainHeight(curMap, x, z) : 0) + 0.3; p.spr.position.set(x + (Math.random() - 0.5) * 0.4, py, z + (Math.random() - 0.5) * 0.4);
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
    const py = (curMap ? CORE.getTerrainHeight(curMap, x, z) : 0) + 0.5; p.spr.position.set(x, py + Math.random() * 0.5, z);
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
function spawnFlame(x, y, z) {
  const p = flamePool.find((q) => q.life <= 0); if (!p) return;
  p.life = 0.14 + Math.random() * 0.08;
  if (typeof x === 'object' && x !== null) {
    p.spr.position.copy(x);
  } else {
    p.spr.position.set(x, y, z);
  }
  p.spr.scale.setScalar(0.5 + Math.random() * 0.5); p.spr.visible = true;
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
  const wy = (curMap ? getSurfaceY(curMap, x, z) : 0) + 0.2;
  p.spr.position.set(x + (Math.random() - 0.5) * 0.3, wy, z + (Math.random() - 0.5) * 0.3);
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
  const sy = (curMap ? getSurfaceY(curMap, x, z) : 0) + 0.2;
  p.spr.position.set(x + (Math.random() - 0.5) * 0.3, sy, z + (Math.random() - 0.5) * 0.3);
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
    const groundY = curMap ? CORE.getTerrainHeight(curMap, p.spr.position.x, p.spr.position.z) : 0; if (p.spr.position.y < groundY + 0.05) { p.spr.position.y = groundY + 0.05; p.vy *= -0.4; }
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
const _sm = new THREE.Matrix4(), _sq = new THREE.Quaternion(), _sup = new THREE.Vector3(0, 1, 0), _spos = new THREE.Vector3(), _sone = new THREE.Vector3(1, 1, 1);
function spawnSkid(x, z, heading) {
  let latDist = 0;
  if (curMap && curMap.type === 'spline' && curMap.nearest) {
    latDist = Math.abs(curMap.nearest(x, z).d);
  } else {
    latDist = Math.abs(CORE.radialDistToTrack(x, z, A, B).d);
  }
  if (latDist > RH + 0.5) return;
  const roadY = curMap ? getSurfaceY(curMap, x, z) : 0.035;
  _sq.setFromAxisAngle(_sup, heading);
  _spos.set(x, roadY + 0.02 + (skidIdx % 4) * 0.0015, z);
  _sm.compose(_spos, _sq, _sone);
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

// ---------------------------------------------------------------------------
// v90 CLUB SYNC FIX — one racer, many identity strings.
// The club APIs used to send ONLY `SRAccount.name() || prefs.pid`, while the
// server credits race mileage against the verified Supabase uuid (or, without
// Supabase, the in-race display name). Only the member whose two keys happened
// to coincide was ever credited, so a club showed one racer's distance and
// points while everybody else stayed at 0.0 km / 0 pts. Every club call now
// ships ALL identities this browser owns and the server aliases them together.
// ---------------------------------------------------------------------------
function crewIdentity() {
  const signedIn = !!(window.SRAccount && typeof SRAccount.loggedIn === 'function' && SRAccount.loggedIn() && SRAccount.uid && SRAccount.uid());
  const sbUid = signedIn ? String(SRAccount.uid()) : '';
  return {
    uid: (window.SRAccount && typeof SRAccount.name === 'function' && SRAccount.name()) ? SRAccount.name() : (prefs.pid || prefs.name || 'guest'),
    pid: signedIn ? ('sb:' + sbUid) : (prefs.pid || ''), // exactly what identityPayload() sends
    sbUid,
    name: prefs.name || ''
  };
}
function crewQuery(ci) {
  return Object.keys(ci).filter((k) => ci[k]).map((k) => k + '=' + encodeURIComponent(ci[k])).join('&');
}
function crewRowIsMe(m, ci) {
  if (!m) return false;
  const strip = (v) => String(v).replace(/^sb:/i, '').trim().toLowerCase();
  const mine = [ci.uid, ci.pid, ci.sbUid, ci.name].filter(Boolean).map(strip);
  const row = [m.uid].concat(m.aliases || []).filter(Boolean).map(strip);
  return row.some((r) => r && mine.indexOf(r) !== -1);
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
  if (nb) nb.addEventListener('click', () => { ensureRoomCreated(); p1.style.display = 'none'; p2.style.display = ''; buildCarCards(); });
  if (bb) bb.addEventListener('click', () => { p2.style.display = 'none'; p1.style.display = ''; });
  document.querySelectorAll('.cls-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.cls === prefs.cls);
    b.addEventListener('click', () => {
      prefs.cls = b.dataset.cls; savePrefs();
      document.querySelectorAll('.cls-btn').forEach((x) => x.classList.toggle('active', x === b));
      sendMeta();
      const isAuth = (window.SRAccount && typeof SRAccount.loggedIn === 'function' && SRAccount.loggedIn());
      const fbtn = $('friends-btn'); if (fbtn) fbtn.hidden = !isAuth;
      if (isAuth) loadEquipped();
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
      const isAuth = (window.SRAccount && typeof SRAccount.loggedIn === 'function' && SRAccount.loggedIn());
      const fbtn = $('friends-btn'); if (fbtn) fbtn.hidden = !isAuth;
      if (isAuth) loadEquipped();
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
      switchLobbyTab('rank');
      const wTab = $('board-tab-weekly');
      if (wTab) wTab.click();
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
  if (!(acc && acc.loggedIn())) {
    body.innerHTML = '<div class="p-empty">' + (tI18n('accountSub') || 'Sign in to open your garage — cars, paints, neon and more unlock as you race.') + '<br><br><button id="g-signin" class="big-cta">' + (tI18n('signin') || 'SIGN IN / CREATE ACCOUNT') + '</button></div>';
    const b = $('g-signin'); if (b) b.addEventListener('click', () => { dlg.hidden = true; const ab = $('account-btn'); if (ab) ab.click(); });
    return;
  }
  body.innerHTML = '<div class="p-empty">' + (tI18n('loadingCircuit') || 'Opening garage…') + '</div>';
  (async () => {
    const gd = await garageData();
    if (!gd) return;
    const { d, coins } = gd;
    const eq = myEq || { car: 'street_runner', paint: 0, wheels: 0, trail: 0, decal: 0, neon: 0 };
    let html = '<div class="g-head">🪙 <b>' + coins + '</b> ' + (tI18n('rushCoins') || 'RUSH COINS') + ' <span class="g-hint">earn coins by racing · dailies · wins</span></div>';
    html += '<div class="p-sub">' + (tI18n('myCars') || 'MY CARS') + '</div><div class="g-cars">';
    for (const c of (window.SRCos ? SRCos.CARS : [])) {
      const un = SRCos.itemUnlocked(c.unlock, d, 'car:' + c.id);
      const sel = eq.car === c.id;
      html += '<div class="g-car' + (sel ? ' sel' : '') + '" style="border-color:' + (un ? SRCos.RARITY[c.rarity] : '#232c47') + '">' +
        '<div class="g-cn" style="color:' + SRCos.RARITY[c.rarity] + '">' + c.name + '</div>' +
        '<div class="g-cr">' + c.rarity.toUpperCase() + '</div>' +
        '<div class="g-bars">' + c.bars.map((b) => '<i style="width:' + (b * 10) + '%"></i>').join('') + '</div>' +
        (sel ? '<div class="g-st">' + (tI18n('selected') || 'SELECTED') + '</div>' : un ? '<button class="ghost sm g-eq" data-car="' + c.id + '">' + (tI18n('select') || 'SELECT') + '</button>' : '<div class="g-lock">🔒 ' + SRCos.unlockText(c.unlock) + '</div>') +
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
    html += sect(tI18n('paint') || 'PAINT', SRCos.PAINTS, 'paint') +
      sect(tI18n('wheelsCat') || 'WHEELS', SRCos.WHEELS, 'wheels') +
      sect(tI18n('trailsCat') || 'TRAILS', SRCos.TRAILS, 'trail') +
      sect(tI18n('decalsCat') || 'DECALS', SRCos.DECALS, 'decal') +
      sect(tI18n('neonCat') || 'NEON', SRCos.NEONS, 'neon');
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
  if (!e) return;
  const el = $('room-players'); if (!el) return;
  const ps = e.players || [];
  const rc = $('room-count');
  if (rc) rc.textContent = (typeof tI18n === 'function' ? tI18n('playersCount', { count: ps.length, cap: e.cap || 6 }) : null) || (ps.length + ' / ' + (e.cap || 6) + ' PLAYERS');
  el.innerHTML = ps.map((p) => {
    const crewBadge = p.crewTag ? `<span class="syndicate-tag">[${escapeHtml(p.crewTag)}]</span> ` : '';
    const readyTxt = p.ready ? ((typeof tI18n === 'function' ? tI18n('ready') : null) || 'READY') : ((typeof tI18n === 'function' ? tI18n('notReady') : null) || 'NOT READY');
    return '<div class="rp-row' + (p.slot === mySlot ? ' me' : '') + '"><span class="rp-slot">' + p.slot + '</span>' +
      '<span class="rp-name">' + crewBadge + escapeHtml(p.name) + (p.host ? ' 👑' : '') + '</span>' +
      '<span class="rp-rating">' + (p.rating != null ? p.rating : '—') + '</span>' +
      '<span class="rp-ready ' + (p.ready ? 'on' : '') + '">' + readyTxt + '</span></div>';
  }).join('') +
    (ps.length < (e.cap || 6) ? '<div class="rp-row empty"><span class="rp-slot">·</span><span class="rp-name dim">' + ((typeof tI18n === 'function' ? tI18n('openSlot') : null) || 'open slot — share the code') + '</span></div>' : '');
  const rb = $('ready-btn');
  if (rb) { rb.hidden = ps.length < 3; rb.textContent = iAmReady ? ('✅ ' + ((typeof tI18n === 'function' ? tI18n('ready') : null) || 'READY')) : ('🏁 ' + ((typeof tI18n === 'function' ? tI18n('readyUp') : null) || 'READY UP')); }
}
window.renderRoomLobby = renderRoomLobby;
// v73 wiring: profile / ratings access points
(function () {
  const pc = $('profile-close'); if (pc) pc.addEventListener('click', () => { const d = $('profile-dlg'); if (d) d.hidden = true; });
  const fb = $('friends-btn'); if (fb) fb.addEventListener('click', openFriends);
  const gb = $('garage-btn'); if (gb) gb.addEventListener('click', openGarage);
  const rbtn = $('ready-btn'); if (rbtn) rbtn.addEventListener('click', () => { iAmReady = !iAmReady; net.send({ type: 'ready', on: iAmReady }); renderRoomLobby({ players: window.__lastLobby || [], cap: 6 }); });
  const gc = $('garage-close'); if (gc) gc.addEventListener('click', () => { const d = $('garage-dlg'); if (d) d.hidden = true; });
  const fc = $('friends-close'); if (fc) fc.addEventListener('click', () => { const d = $('friends-dlg'); if (d) d.hidden = true; });

  // Generic backdrop dismissal for all modal dialogs
  document.querySelectorAll('.dlg').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target === d) { d.hidden = true; d.classList.add('hidden'); }
    });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.dlg').forEach((d) => { d.hidden = true; d.classList.add('hidden'); });
      const tut = $('tutorial'); if (tut) tut.style.display = 'none';
    }
  });
})();
function switchLobbyTab(t) {
  const tabs = ['race', 'rank', 'prof', 'sett'];
  tabs.forEach(other => {
    const b = $(`ltab-${other}`);
    const p = $(`pane-${other}`);
    if (b) b.classList.toggle('active', other === t);
    if (p) p.classList.toggle('hidden', other !== t);
  });
  if (t === 'rank') loadCompetitiveHub();
}

function initLobbyTabs() {
  ['race', 'rank', 'prof', 'sett'].forEach(t => {
    const btn = $(`ltab-${t}`);
    if (btn) btn.addEventListener('click', () => switchLobbyTab(t));
  });
}
initLobbyTabs();

function showRatingTab() {
  switchLobbyTab('rank');
  compActiveTab = 'rate';
  loadCompetitiveHub();
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
    n: cb.n, m: cb.m, lap: cb.lap, ll: ca.ll, best: cb.best, fin: cb.fin, ft: cb.ft, p: cb.p, pr: cb.pr,
    drift: cb.drift || 0, elim: cb.elim || 0,
    col: cb.col != null ? cb.col : ca.col,
    dc: cb.dc != null ? cb.dc : ca.dc,
    wh: cb.wh != null ? cb.wh : ca.wh,
    tr: cb.tr != null ? cb.tr : ca.tr,
    ne: cb.ne != null ? cb.ne : ca.ne,
    sp: cb.sp != null ? cb.sp : ca.sp,
    nm: cb.nm || ca.nm || ''
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
  shakeAmp = Math.min(0.35, shakeAmp + 0.05 + strength * 0.15);
  const f = $('hitflash');
  f.style.opacity = Math.min(0.55, 0.2 + strength * 0.4);
  clearTimeout(onCrashFX._t);
  onCrashFX._t = setTimeout(() => { f.style.opacity = 0; }, 140);
  if (strength > 0.35) beep(75, 0.12, 'sine', 0.18);
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
function confetti(intensity = 'gold') {
  if (prefs.rm) return;
  const c = $('confetti'); if (!c) return;
  c.innerHTML = '';
  const colors = intensity === 'gold'
    ? ['#ffd479', '#ffaa00', '#ffffff', '#00f0ff', '#ffe699']
    : ['#ff5252', '#ffd479', '#42a5f5', '#3ddc84', '#ffffff'];
  const count = intensity === 'gold' ? 110 : 55;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.style.left = (Math.random() * 100) + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.8) + 's';
    p.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
    p.style.width = (6 + Math.random() * 6) + 'px';
    p.style.height = (10 + Math.random() * 8) + 'px';
    c.appendChild(p);
  }
  setTimeout(() => { if (c) c.innerHTML = ''; }, 6500);
}
function soundUiClick() {
  if (prefs.mute) return;
  try {
    ensureAudio(); if (!audio || !audio.ctx) return;
    const ctx = audio.ctx, t = ctx.currentTime;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(750, t);
    osc.frequency.exponentialRampToValueAtTime(350, t + 0.04);
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    osc.connect(g); g.connect(audio.master);
    osc.start(t); osc.stop(t + 0.05);
  } catch (e) {}
}
function soundCountdownTick(isGo) {
  if (prefs.mute) return;
  try {
    ensureAudio(); if (!audio || !audio.ctx) return;
    const ctx = audio.ctx, t = ctx.currentTime;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = isGo ? 'sawtooth' : 'triangle';
    osc.frequency.setValueAtTime(isGo ? 880 : 440, t);
    if (isGo) osc.frequency.exponentialRampToValueAtTime(1760, t + 0.3);
    g.gain.setValueAtTime(isGo ? 0.3 : 0.18, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (isGo ? 0.35 : 0.16));
    osc.connect(g); g.connect(audio.master);
    osc.start(t); osc.stop(t + (isGo ? 0.38 : 0.18));
  } catch (e) {}
}
let countTimer = null;
function showCount(txt) {
  const el = $('count-num'); if (!el) return;
  if (countTimer) { clearTimeout(countTimer); countTimer = null; }
  el.textContent = txt;
  const isGo = txt === 'GO!' || txt === (tI18n('countdownGo') || 'GO!');
  el.classList.toggle('go', isGo);
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
  soundCountdownTick(isGo);
  countTimer = setTimeout(() => {
    el.classList.remove('pop');
    el.textContent = '';
    countTimer = null;
  }, isGo ? 1200 : 850);
}
function clearCount() {
  const el = $('count-num'); if (!el) return;
  if (countTimer) { clearTimeout(countTimer); countTimer = null; }
  el.classList.remove('pop');
  el.textContent = '';
}
let pendingSettle = []; // v73 server-settled XP/rating rows
function showResults(order) {
  if (TT.on) return; // v61: TT/practice use their own overlay
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
  // Podium celebration & fanfare
  const myRes = order.find((c) => (c.slot || c.s) === mySlot);
  if (myRes) {
    const myPos = order.indexOf(myRes) + 1;
    if (myPos === 1) {
      confetti('gold');
      winJingle(true);
    } else if (myPos === 2 || myPos === 3) {
      confetti('silver');
      winJingle(false);
    }
  }
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
  const gameLink = location.origin + '/?room=' + snap.code;
  const phoneLink = location.origin + '/controller?room=' + snap.code + (mySlot ? '&slot=' + mySlot : '');
  $('game-link').textContent = gameLink;
  $('ctrl-url').textContent = phoneLink;
  drawQR(phoneLink);
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === snap.mode));
  document.querySelectorAll('.map-card').forEach((b) => b.classList.toggle('active', parseInt(b.dataset.map, 10) === snap.map));
  if (snap.map != null) selectedMap = snap.map;
  const parts = [];
  if (snap.controllers[1]) parts.push('📱 P1 joystick');
  if (snap.controllers[2]) parts.push('📱 P2 joystick');
  if (snap.bot) parts.push('🏎️ Pro Rival Driver');
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
          if (act.actionKey === 'daily' || act.actionKey === 'streak' || act.id === 'streak') {
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

// v82 Milestone Badges Modal Controller
async function openBadgesShowcase() {
  const dlg = $('badges-dlg');
  if (!dlg) return;
  const body = $('badges-body');
  if (!body) return;
  dlg.hidden = false;
  body.innerHTML = '<div style="color:#8b93a8; text-align:center; padding:20px;">' + (tI18n('loadingCircuit') || 'Loading badges…') + '</div>';
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
                <div class="bc-tier">${unlocked ? (tI18n('tier', { tier: b.tierLevel, tierName: b.tierName }) || ('Tier ' + b.tierLevel + ' (' + b.tierName + ')')) : (tI18n('locked') || 'Locked')}</div>
                <div class="bc-desc">${escapeHtml(b.desc)}</div>
                <div class="bc-bar-wrap"><div class="bc-bar-fill" style="width:${pct}%"></div></div>
                <div style="font-size:10px; color:#8b93a8;">${b.progress}/${b.target}</div>
                ${unlocked ? `<button class="bc-btn ${b.equipped ? 'active' : ''}" onclick="equipMilestoneBadge('${b.badgeId}')">${b.equipped ? ('⭐ ' + (tI18n('equipped') || 'EQUIPPED')) : (tI18n('equip') || 'EQUIP')}</button>` : ''}
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
      toast(tI18n('equippedBadge', { badge: badgeId }) || `🎖️ Equipped badge: ${badgeId}!`);
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
  body.innerHTML = '<div style="color:#8b93a8; text-align:center; padding:20px;">' + (tI18n('loadingCircuit') || 'Loading bounties…') + '</div>';
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
                  <span style="font-size:10.5px; color:#ffd479;">${tI18n('rewardsText', { xp: b.xpReward, coins: b.coinReward, pts: b.ptsReward }) || `Rewards: +${b.xpReward} XP · +${b.coinReward} 🪙 · +${b.ptsReward} Pts`}</span>
                </div>
                <div>
                  ${b.completed && !b.claimed ? `<button class="alc-btn" onclick="claimWeeklyBountyReward('${b.id}')">🎁 ${tI18n('claimBounty') || 'CLAIM'}</button>` : (b.claimed ? `<span style="color:#7ee78a; font-weight:800;">${tI18n('claimed') || 'CLAIMED'}</span>` : `<span style="color:#cfd6dd;">${b.progress}/${b.goal}</span>`)}
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
      toast(tI18n('claimedBounty', { xp: res.xpAwarded, coins: res.coinsAwarded }) || `🏆 Bounty claimed! +${res.xpAwarded} XP · +${res.coinsAwarded} Coins!`);
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

  body.innerHTML = '<div style="color:#8b93a8; text-align:center; padding:30px;">' + (tI18n('loadingCircuit') || 'Loading Syndicate…') + '</div>';
  const ci = crewIdentity(); // v90: resolve the club from every identity we own

  if (tab === 'my') {
    try {
      const res = await fetch(`${httpBase()}/api/player/crew?${crewQuery(ci)}`).then(r => r.json());
      if (res && res.ok && res.hasCrew && res.crew) {
        const c = res.crew;
        body.innerHTML = `
          <div class="crew-hero-card" style="border-color:${c.color || '#00e5ff'};">
            <div class="chc-header">
              <div class="chc-title">
                <span class="syndicate-tag" style="background:${c.color || '#ff3366'};">[${escapeHtml(c.tag)}]</span>
                <span class="chc-name">${c.badge || '⚡'} ${escapeHtml(c.name)}</span>
              </div>
              <span style="font:800 11px Orbitron; color:#ffd479;">${c.isLeader ? ('👑 ' + (tI18n('leader') || 'LEADER')) : (tI18n('member') || 'MEMBER')}</span>
            </div>
            <div class="chc-motto">"${escapeHtml(c.motto || 'Speed is our only law')}"</div>
            <div class="chc-stats">
              <div class="chc-stat-col"><span>${tI18n('weeklyMileage') || 'WEEKLY MILEAGE'}</span><b>${c.weeklyKm} km</b></div>
              <div class="chc-stat-col"><span>${tI18n('grandPrixPts') || 'GRAND PRIX PTS'}</span><b>${c.weeklyPoints}</b></div>
              <div class="chc-stat-col"><span>${tI18n('totalMileage') || 'TOTAL MILEAGE'}</span><b>${c.totalKm} km</b></div>
            </div>
          </div>

          <div class="crew-milestone-track">
            <div class="cmt-header">
              <span>${tI18n('weeklyMilestones', { tier: c.currentTier }) || `WEEKLY SYNDICATE MILESTONES (TIER ${c.currentTier}/5)`}</span>
              <span>${tI18n('pctToNext', { pct: c.progressPct }) || `${c.progressPct}% TO NEXT`}</span>
            </div>
            <div class="cmt-bar-wrap"><div class="cmt-bar-fill" style="width:${c.progressPct}%;"></div></div>
            <div class="cmt-list">
              ${c.milestones.map(m => `
                <div class="cmt-item ${m.completed ? 'completed' : ''}">
                  <b>T${m.tier} · ${m.reqKm}km</b>
                  <span>+${m.reward.xp} XP · +${m.reward.coins} 🪙</span>
                  ${m.canClaim ? `<button class="cmt-claim-btn" onclick="claimCrewMilestoneReward(${m.tier})">${tI18n('claimBounty') || 'CLAIM'}</button>` : (m.claimed ? `<span class="cmt-claim-btn claimed">${tI18n('claimed') || 'CLAIMED'}</span>` : `<span>${m.completed ? '✅ REACHED' : m.reqKm + 'km'}</span>`)}
                </div>
              `).join('')}
            </div>
          </div>

          <div style="margin-top:16px;">
            <div style="font:800 12px Orbitron; color:#fff; margin-bottom:8px;">${tI18n('crewRoster', { count: c.members.length }) || `👥 CREW ROSTER (${c.members.length} RACERS)`}</div>
            <table class="crew-lb-table">
              <thead><tr><th>${tI18n('racerTh') || 'RACER'}</th><th>${tI18n('roleTh') || 'ROLE'}</th><th>${tI18n('weeklyDistTh') || 'WEEKLY DISTANCE'}</th><th>${tI18n('pointsTh') || 'POINTS'}</th></tr></thead>
              <tbody>
                ${c.members.map(m => `
                  <tr>
                    <td><b>${escapeHtml(m.name)}</b> ${crewRowIsMe(m, ci) ? '<span style="color:#00e5ff;">(YOU)</span>' : ''}</td>
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
            <h3 style="font:800 16px Orbitron; color:#fff; margin-bottom:6px;">${tI18n('noClubYet') || 'NO MOTORSPORT CLUB YET'}</h3>
            <p style="font-size:12px; color:#8b93a8; max-width:400px; margin:0 auto 18px;">${tI18n('noClubDesc') || 'Join a top motorsport club to pool weekly mileage, unlock exclusive team milestone rewards, and compete in the Club Championship!'}</p>
            <div style="display:flex; justify-content:center; gap:10px;">
              <button class="big-cta" onclick="openCrewModal('join')">${tI18n('joinClubBtn') || '⚡ JOIN A MOTORSPORT CLUB'}</button>
              <button class="ghost" onclick="openCrewModal('create')">${tI18n('foundClubBtn') || '➕ FOUND A CLUB'}</button>
            </div>
          </div>
        `;
      }
    } catch (e) {
      body.innerHTML = '<div style="color:#ff5252; text-align:center; padding:20px;">Failed to load club.</div>';
    }
  } else if (tab === 'join') {
    try {
      const res = await fetch(`${httpBase()}/api/crews`).then(r => r.json());
      const crews = (res && res.crews) || [];
      body.innerHTML = `
        <div style="margin-bottom:12px; font:700 12px Orbitron; color:#7ee7ff;">${tI18n('selectClubJoin') || 'SELECT A MOTORSPORT CLUB TO JOIN:'}</div>
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
      body.innerHTML = '<div style="color:#ff5252; text-align:center; padding:20px;">Failed to load clubs.</div>';
    }
  } else if (tab === 'create') {
    body.innerHTML = `
      <form class="crew-form" id="crew-create-form" onsubmit="handleCreateCrewSubmit(event)">
        <label>
          CLUB NAME (3-20 characters):
          <input id="cf-name" class="name-input" maxlength="20" placeholder="e.g. Redline Pro Racing" required />
        </label>
        <label>
          CLUB TAG (2-5 uppercase letters/numbers):
          <input id="cf-tag" class="name-input" maxlength="5" placeholder="e.g. REDL" style="text-transform:uppercase;" required />
        </label>
        <label>
          MOTTO / SLOGAN:
          <input id="cf-motto" class="name-input" maxlength="50" placeholder="e.g. Push past the limit, hold the line" />
        </label>
        <label>
          BADGE ICON:
          <select id="cf-badge" class="name-input" style="background:#141c30; color:#fff;">
            <option value="🏁">🏁 Checkered Flag</option>
            <option value="⚡">⚡ Lightning Bolt</option>
            <option value="🏎️">🏎️ Grand Prix</option>
            <option value="🌀">🌀 Vortex</option>
            <option value="🔥">🔥 Flame</option>
            <option value="👑">👑 Crown</option>
          </select>
        </label>
        <label>
          CLUB THEME COLOR:
          <input id="cf-color" type="color" value="#ff3344" style="width:100%; height:38px; background:none; border:none; cursor:pointer;" />
        </label>
        <p id="cf-err" style="color:#ff5252; font-size:11px; margin:0;"></p>
        <button type="submit" class="big-cta" style="margin-top:10px;">🚀 FOUND MOTORSPORT CLUB</button>
      </form>
    `;
  } else if (tab === 'board') {
    try {
      const res = await fetch(`${httpBase()}/api/crews/leaderboard`).then(r => r.json());
      const crews = (res && res.crews) || [];
      body.innerHTML = `
        <div style="margin-bottom:10px; font:700 12px Orbitron; color:#ffd479;">🏆 WEEKLY CLUB CHAMPIONSHIP STANDINGS</div>
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
  const ci = crewIdentity(); // v90 club sync
  try {
    const res = await fetch(`${httpBase()}/api/player/crew/claim-milestone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, ci, { name: prefs.name || 'RACER', tier }))
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
  const ci = crewIdentity(); // v90 club sync
  const name = prefs.name || 'RACER';
  try {
    const res = await fetch(`${httpBase()}/api/player/crew/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, ci, { name, crewId }))
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
  const ci = crewIdentity(); // v90 club sync
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
      body: JSON.stringify(Object.assign({}, ci, { name, crewName, tag, motto, badge, color }))
    }).then(r => r.json());
    if (res && res.ok) {
      toast(`🏁 Club [${res.crew.tag}] ${res.crew.name} Created!`);
      openCrewModal('my');
    } else {
      const errEl = $('cf-err');
      if (errEl) {
        if (res.error === 'tag_taken') errEl.textContent = '❌ Club Tag is already taken by another syndicate!';
        else if (res.error === 'invalid_crew_name') errEl.textContent = '❌ Club Name must be 3-30 characters (letters, numbers, spaces, and punctuation)!';
        else if (res.error === 'invalid_crew_tag') errEl.textContent = '❌ Club Tag must be 2-5 letters/numbers (e.g. APEX, F1, SPEED)!';
        else errEl.textContent = '❌ ' + (res.error || 'Validation error');
      }
    }
  } catch (e) {
    const errEl = $('cf-err');
    if (errEl) errEl.textContent = 'Connection error creating crew.';
  }
};

window.openCrewModal = openCrewModal;
window.openBadgesShowcase = openBadgesShowcase;
window.openBountiesModal = openBountiesModal;

// Wire up modal openers and close buttons
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
function tI18n(k, params) {
  const lang = (typeof prefs !== 'undefined' && prefs.lang) || 'en';
  const D = window.SRI18N || {};
  const L = D[lang] || D.en || {};
  let res = L[k] != null ? L[k] : ((D.en && D.en[k] != null) ? D.en[k] : k);
  if (params && typeof params === 'object') {
    Object.keys(params).forEach((p) => {
      res = String(res).replace(new RegExp('\\{' + p + '\\}', 'g'), params[p]);
    });
  }
  return res;
}
function applyI18n() {
  if (!window.SRI18N) return;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const s = tI18n(el.getAttribute('data-i18n'));
    if (s) el.textContent = s;
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const s = tI18n(el.getAttribute('data-i18n-html'));
    if (s) el.innerHTML = s;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const s = tI18n(el.getAttribute('data-i18n-placeholder'));
    if (s) el.placeholder = s;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const s = tI18n(el.getAttribute('data-i18n-title'));
    if (s) el.title = s;
  });
  const lb = $('lang-btn'); if (lb) lb.textContent = '🌐 ' + ((window.SRI18N_LABEL && window.SRI18N_LABEL[prefs.lang]) || (prefs.lang || 'EN').toUpperCase());
  paintDailyHeader();
  if (typeof renderProfile === 'function') renderProfile();
  if (typeof fetchAndRenderRetention === 'function') fetchAndRenderRetention();
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
    const order = ['en', 'te', 'hi', 'es'];
    prefs.lang = order[(order.indexOf(prefs.lang || 'en') + 1) % order.length];
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
      case 'count': showCount(String(e.n)); beep(440, 0.16, 'sine', 0.22); break;
      case 'go': showCount(tI18n('countdownGo') || 'GO!'); beep(880, 0.35, 'sine', 0.25); ghostStart(snap.map != null ? snap.map : builtMapId); v60OnGo(); break;
      case 'crash': onCrashFX(e.x, e.z, e.s); if (e.slot === mySlot) v60OnCrashMine(); break;
      case 'lap':
        if (e.slot === mySlot) { ghostSave(snap.map != null ? snap.map : builtMapId, !!e.best); recordPlayDay(); achCheck({ map: snap.map, lapT: e.t }); }
        if (e.slot === mySlot && e.best) v60OnBestLap(snap.map != null ? snap.map : builtMapId, e.t);
        toast(`P${e.slot} lap ${e.n} — ${fmtTime(e.t)}${e.best ? '  ★ BEST' : ''}`); break;
      case 'finallap': toast(`🔥 P${e.slot}: ` + (tI18n('finalLap') || 'FINAL LAP!')); beep(659.25, 0.22, 'sine', 0.22); break;
      case 'elim': setBanner(tI18n('eliminated', { slot: e.slot }) || `❌ P${e.slot} ELIMINATED`); beep(220, 0.35, 'triangle', 0.22); break;
      case 'win':
        if (e.slot === mySlot) {
          track('fin', snap.map != null ? snap.map : builtMapId);
          achCheck({ win: true, map: snap.map });
        }
        setBanner(e.multi ? (tI18n('playerWins', { slot: e.slot }) || `🏁 PLAYER ${e.slot} WINS!`) : (tI18n('finishTime', { time: fmtTime(e.t) }) || `🏁 FINISH — ${fmtTime(e.t)}`)); confetti(); winJingle(); break;
      case 'pu': { const nm = ['⚡ BOOST', '🛡️ SHIELD', '🌀 SLOW'][e.ptype] || 'PU'; toast(`P${e.slot} grabbed ${nm}!`); beep(880, 0.12, 'sine', 0.2); setTimeout(() => beep(1318.5, 0.18, 'sine', 0.2), 60); break; }
      case 'respawn': if (e.slot === mySlot) { toast('🔄 Back on track'); beep(330, 0.2, 'triangle', 0.18); } break;
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

// Route mobile devices explicitly requesting controller pad (?controller=1)
(function () {
  if (typeof window === 'undefined') return;
  if (wantedRoom && urlParam('controller')) {
    location.replace('/controller.html?room=' + encodeURIComponent(wantedRoom));
  }
})();
// build marker — must match the server's /version build. If the website and
// the relay run different code you get "ghost" physics; show a warning then.
const BUILD = 'v91';
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
        const u = new URL(location.href);
        u.searchParams.set('r', Date.now());
        location.replace(u.pathname + u.search + u.hash);
        return;
      }
      if (geomMismatch) {
        const key = 'sr_reload_' + (v.build || 'x');
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1');
          const u = new URL(location.href);
          u.searchParams.set('r', Date.now());
          location.replace(u.pathname + u.search + u.hash);
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
    if (msg.role === 'lobby' || msg.type === 'lobby_welcome' || !msg.code || msg.slot === 0) {
      mySlot = 0; roomCode = '·····';
      clearRoomHop();      // v91: the exit completed (or we are parked in the pool)
      syncRoomButtons();
      const sb = $('slot-badge'); if (sb) sb.style.display = 'none';
      setNetBanner(true);
      applyMyColor();
      const gl = $('game-link'); if (gl) gl.textContent = 'Click CREATE or SET UP RACE to generate room link';
      const cu = $('ctrl-url'); if (cu) cu.textContent = 'Create a room to connect phone controller';
      const qb = $('quickplay-btn'); if (qb) { qb.disabled = false; qb.textContent = '⚡ QUICK PLAY — find a rival'; }
      return;
    }
    mySlot = msg.slot; roomCode = msg.code;
    clearRoomHop();      // v91: create/join hop confirmed by the relay
    syncRoomButtons();
    const sb = $('slot-badge');
    if (sb) {
      sb.textContent = `YOU ARE PLAYER ${mySlot}`;
      sb.className = mySlot === 1 ? 'slot-badge c1' : 'slot-badge c2';
      sb.style.display = '';
    }
    setNetBanner(true);
    applyMyColor();
    const phoneLink = location.origin + '/controller?room=' + roomCode + '&slot=' + mySlot;
    const ctrlUrlEl = $('ctrl-url');
    if (ctrlUrlEl) ctrlUrlEl.textContent = phoneLink;
    drawQR(phoneLink);
    const qb = $('quickplay-btn');
    if (qb) { qb.disabled = false; qb.textContent = '⚡ QUICK PLAY — find a rival'; }
    if (msg.snapshot) ingestSnapshot(msg.snapshot);
  },
  onMessage(msg) {
    switch (msg.type) {
      case 'state': ingestSnapshot(msg); break;
      case 'lobby': {
        window.__lastLobby = msg.players || [];
        if (typeof renderRoomLobby === 'function') renderRoomLobby(msg);
        else if (typeof window.renderRoomLobby === 'function') window.renderRoomLobby(msg);
        break;
      }
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
      case 'lobby_welcome': {
        $('room-code').textContent = '·····';
        const gl = $('game-link'); if (gl) gl.textContent = 'Click CREATE or SET UP RACE to generate room link';
        const cu = $('ctrl-url'); if (cu) cu.textContent = 'Create a room to connect phone controller';
        break;
      }
      case 'error':
        if (msg.code === 'no-room') showRoomError('Room not found — it may have closed. Create a new one!');
        else if (msg.code === 'join-failed') {
          // v91: the relay refused the hop, so we are still seated where we were
          clearRoomHop();
          const why = msg.reason === 'full'
            ? ((typeof tI18n === 'function' ? tI18n('joinRoomFull', { code: msg.room }) : null) || ('⚠ Room ' + (msg.room || '') + ' is full (6 max)'))
            : (msg.reason === 'already-in-room'
              ? ((typeof tI18n === 'function' ? tI18n('joinRoomAlready') : null) || 'You are already in that room')
              : ((typeof tI18n === 'function' ? tI18n('joinRoomMissing', { code: msg.room }) : null) || ('⚠ Room ' + (msg.room || '') + ' not found — it may have closed')));
          toast(why);
          syncRoomButtons();
        }
        break;
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
  if (wantedRoom) {
    net.connect(Object.assign({ type: 'hello', role: 'screen', room: wantedRoom }, identityPayload()));
  } else {
    net.connect(Object.assign({ type: 'hello', role: 'screen', lobby: true, room: null }, identityPayload()));
  }
}
// ---------------------------------------------------------------------------
// v91 EXIT ROOM — step out of the current room and join or create another one
// without a page reload (the socket, session and garage loadout stay intact).
// Relays older than build v90 don't understand `leave` / `join_room`, so every
// hop arms a fallback that reloads if the server never confirms the move.
// ---------------------------------------------------------------------------
let roomHopTimer = null;
let roomHopPending = false;
function clearRoomHop() {
  roomHopPending = false;
  if (roomHopTimer) { clearTimeout(roomHopTimer); roomHopTimer = null; }
}
function armRoomHop(fallbackUrl) {
  clearRoomHop();
  roomHopPending = true;
  roomHopTimer = setTimeout(() => {
    roomHopTimer = null;
    if (roomHopPending) { roomHopPending = false; location.href = fallbackUrl; }
  }, 1600);
}
function inARoom() { return !!(roomCode && roomCode !== '·····'); }
function syncRoomButtons() {
  const lb = $('leave-room-btn');
  if (lb) lb.hidden = !inARoom();
}
function exitRoom() {
  const from = roomCode;
  if (!net.isOpen()) { location.href = '/'; return; }
  net.send({ type: 'leave' });
  armRoomHop('/');
  // optimistic: the relay answers with lobby_welcome and onWelcome finishes the reset
  mySlot = 0; roomCode = '·····';
  syncRoomButtons();
  const sb = $('slot-badge'); if (sb) sb.style.display = 'none';
  toast((typeof tI18n === 'function' ? tI18n('leftRoom') : null) || '🚪 Left the room — create or join another');
  track('room_exit', selectedMap, { room: from });
}
function ensureRoomCreated() {
  if (!roomCode || roomCode === '·····') {
    net.send(Object.assign({ type: 'create_room', mode: viewMode === 'split' ? 'race' : 'race', map: selectedMap, laps: (prefs && prefs.laps) || 3 }, identityPayload()));
  }
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
    clearCount();
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
  const tag = e.target && e.target.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
  if (isInput) return; // Allow normal typing with spaces and arrows in all dialog inputs

  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code); ensureAudio();
  if (e.code === 'KeyC') cycleCamera();
});
window.addEventListener('keyup', (e) => {
  const tag = e.target && e.target.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
  if (isInput) return;
  keys.delete(e.code);
});
let kbAccum = 0;

// v80 mobile solo on-screen touch controls
const touchInput = { l: 0, r: 0, u: 0, d: 0, nitro: false };
function wireTouchBtn(id, downFn, upFn) {
  const el = $(id);
  if (!el) return;
  const down = (e) => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    el.classList.add('active');
    downFn();
  };
  const up = (e) => {
    e.preventDefault();
    el.classList.remove('active');
    upFn();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
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
// Camera (v84 Modern Dynamic Player-Anchored Chase System)
// ---------------------------------------------------------------------------
let camMode = 0;
let splitScreen = false;
const lookTarget = new THREE.Vector3(A - 2.8, 1, 0);
let smoothedCamAngle = 0;
let camInit = false;
const CAM_MODE_NAMES = ['CHASE CAM', 'CLOSE CAM', 'HOOD CAM', 'HELI CAM'];

function cycleCamera() {
  camMode = (camMode + 1) % 4;
  toast('🎥 ' + CAM_MODE_NAMES[camMode]);
}

const _pfCamPos = new THREE.Vector3();
const _pfLookTarget = new THREE.Vector3();
const _camCarPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camDesired = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const _camProxOffset = new THREE.Vector3();
const _camProxLook = new THREE.Vector3();
const _camMidRel = new THREE.Vector3();
const _camUpVec = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _aimPos = new THREE.Vector3();

function aimChaseInstant(cs) {
  const v = carVisuals[cs.s];
  const cx = (v && v.netInit) ? v.netX : cs.x, cz = (v && v.netInit) ? v.netZ : cs.z, ch = (v && v.netInit) ? v.netH : cs.h;
  smoothedCamAngle = ch;
  camInit = true;
  _aimDir.set(Math.sin(ch), 0, Math.cos(ch));
  _aimPos.set(cx, 0, cz);
  camera.position.copy(_aimPos).addScaledVector(_aimDir, -7.6);
  camera.position.y = 2.7;
  lookTarget.copy(_aimPos).addScaledVector(_aimDir, 6.0).add(_camUpVec.set(0, 1.15, 0));
  camera.lookAt(lookTarget);
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
  renderer.setViewport(0, 0, w, h);
  renderer.setScissor(0, 0, w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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
    const mVal = typeof margin === 'number' ? margin : (parseFloat(margin) || 0);
    if (mEl) mEl.textContent = '+' + mVal.toFixed(3) + 's';
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
    const finishY = curMap ? CORE.getTerrainHeight(curMap, finishPos.x, finishPos.z) : 0; _pfCamPos.set(finishPos.x + 6.5, finishY + 1.8, finishPos.z - 4.2); _pfLookTarget.set(finishPos.x, finishY + 0.6, finishPos.z);
    camera.position.lerp(_pfCamPos, 1 - Math.exp(-6 * dt));
    lookTarget.lerp(_pfLookTarget, 1 - Math.exp(-8 * dt));
    camera.lookAt(lookTarget);
    return;
  }

  // 1. Lobby & Garage 3D Cinematic Showcase Orbit
  if (latest && latest.state === 'waiting') {
    const vMe = mine ? carVisuals[mine.s] : carVisuals[1];
    const targetX = (vMe && vMe.netInit) ? vMe.netX : (mine ? mine.x : (curMap ? curMap.a - 3 : 0));
    const targetZ = (vMe && vMe.netInit) ? vMe.netZ : (mine ? mine.z : -6);
    const targetY = (vMe && vMe.group) ? vMe.group.position.y : (curMap ? getSurfaceY(curMap, targetX, targetZ) : 0);
    const t = performance.now() * 0.00042;
    const orbitRadius = 7.4;
    const orbitHeight = targetY + 2.0 + Math.sin(t * 0.9) * 0.35;
    _camDesired.set(
      targetX + Math.cos(t) * orbitRadius,
      orbitHeight,
      targetZ + Math.sin(t) * orbitRadius
    );
    _camLook.set(targetX, targetY + 0.75, targetZ);
    camera.position.lerp(_camDesired, 1 - Math.exp(-4.2 * dt));
    lookTarget.lerp(_camLook, 1 - Math.exp(-7.5 * dt));
    camera.lookAt(lookTarget);
    if (Math.abs(camera.fov - 58) > 0.05) {
      camera.fov = lerp(camera.fov, 58, 1 - Math.exp(-4.0 * dt));
      camera.updateProjectionMatrix();
    }
    return;
  }

  // 2. Starting Grid Countdown Pan (Dramatic 3.. 2.. 1.. Camera Sweep)
  if (latest && latest.state === 'countdown' && latest.count != null) {
    const vMe = mine ? carVisuals[mine.s] : carVisuals[1];
    const targetX = (vMe && vMe.netInit) ? vMe.netX : (mine ? mine.x : (curMap ? curMap.a : 0));
    const targetZ = (vMe && vMe.netInit) ? vMe.netZ : (mine ? mine.z : 0);
    const targetH = (vMe && vMe.netInit) ? vMe.netH : (mine ? mine.h : 0);
    const targetY = (vMe && vMe.group) ? vMe.group.position.y : (curMap ? getSurfaceY(curMap, targetX, targetZ) : 0);
    const countRatio = clamp(latest.count / 3.0, 0, 1);
    const panAngle = targetH + countRatio * 1.8 - 0.2;
    const panDist = 6.2 + countRatio * 2.8;
    const panHeight = targetY + 1.4 + (1 - countRatio) * 1.3;
    _camDesired.set(
      targetX - Math.sin(panAngle) * panDist,
      panHeight,
      targetZ - Math.cos(panAngle) * panDist
    );
    _camLook.set(
      targetX + Math.sin(targetH) * (2.0 + (1 - countRatio) * 4.0),
      targetY + 0.9,
      targetZ + Math.cos(targetH) * (2.0 + (1 - countRatio) * 4.0)
    );
    camera.position.lerp(_camDesired, 1 - Math.exp(-5.5 * dt));
    lookTarget.lerp(_camLook, 1 - Math.exp(-8.5 * dt));
    camera.lookAt(lookTarget);
    const cdFov = 56 + (1 - countRatio) * 6;
    if (Math.abs(camera.fov - cdFov) > 0.05) {
      camera.fov = lerp(camera.fov, cdFov, 1 - Math.exp(-4.5 * dt));
      camera.updateProjectionMatrix();
    }
    return;
  }

  // 3. Post-Race Victory Podium Celebration Orbit
  if (latest && latest.state === 'finished') {
    const vMe = mine ? carVisuals[mine.s] : carVisuals[1];
    const targetX = (vMe && vMe.netInit) ? vMe.netX : (mine ? mine.x : (curMap ? curMap.a : 0));
    const targetZ = (vMe && vMe.netInit) ? vMe.netZ : (mine ? mine.z : 0);
    const targetY = (vMe && vMe.group) ? vMe.group.position.y : (curMap ? getSurfaceY(curMap, targetX, targetZ) : 0);
    const t = performance.now() * 0.00055;
    const orbitRadius = 6.6;
    _camDesired.set(
      targetX + Math.cos(t) * orbitRadius,
      targetY + 2.2 + Math.sin(t * 1.1) * 0.35,
      targetZ + Math.sin(t) * orbitRadius
    );
    _camLook.set(targetX, targetY + 0.7, targetZ);
    camera.position.lerp(_camDesired, 1 - Math.exp(-4.8 * dt));
    lookTarget.lerp(_camLook, 1 - Math.exp(-8.0 * dt));
    camera.lookAt(lookTarget);
    if (Math.abs(camera.fov - 58) > 0.05) {
      camera.fov = lerp(camera.fov, 58, 1 - Math.exp(-4.0 * dt));
      camera.updateProjectionMatrix();
    }
    return;
  }

  if (!mine) return;

  // Follow the visual smoothed position of MY car (solid local player anchor)
  const vMe = carVisuals[mine.s], vRi = rival ? carVisuals[rival.s] : null;
  const mineX = (vMe && vMe.netInit) ? vMe.netX : mine.x;
  const mineZ = (vMe && vMe.netInit) ? vMe.netZ : mine.z;
  const mineH = (vMe && vMe.netInit) ? vMe.netH : mine.h;
  const rivalX = (vRi && vRi.netInit) ? vRi.netX : (rival ? rival.x : 0);
  const rivalZ = (vRi && vRi.netInit) ? vRi.netZ : (rival ? rival.z : 0);

  const mineY = (vMe && vMe.group) ? vMe.group.position.y : (curMap ? getSurfaceY(curMap, mineX, mineZ) : 0); _camCarPos.set(mineX, mineY, mineZ);

  // Smooth heading angle to eliminate jerky rotation
  if (!camInit) {
    smoothedCamAngle = mineH;
    camInit = true;
  } else {
    smoothedCamAngle = lerpAngle(smoothedCamAngle, mineH, 1 - Math.exp(-7.5 * dt));
  }

  _camDir.set(Math.sin(smoothedCamAngle), 0, Math.cos(smoothedCamAngle));
  const sp = clamp(Math.abs(mine.v || 0) / CFG.maxSpeed, 0, 1.3);

  _camProxOffset.set(0, 0, 0);
  _camProxLook.set(0, 0, 0);
  let dynamicFovBoost = 0;

  // Intelligent Proximity Framing: Subtle, cinematic framing bias ONLY when rival is within close battle range (< 22m)
  if (rival && rival.p === 1 && latest && latest.state !== 'waiting' && camMode === 0) {
    const sep = Math.hypot(mineX - rivalX, mineZ - rivalZ);
    if (sep < 22) {
      const proxFactor = (1 - sep / 22);
      // Subtle lateral blend toward competitor (max 10% bias, keeping YOUR car as 90% anchor)
      _camMidRel.set(rivalX - mineX, 0, rivalZ - mineZ).multiplyScalar(0.10 * proxFactor);
      _camProxOffset.copy(_camMidRel);
      _camProxLook.copy(_camMidRel).multiplyScalar(1.2);
      dynamicFovBoost = proxFactor * 4.0;
    }
  }

  if (camMode === 0) {
    // Mode 0: Dynamic Third-Person Chase Cam (Default AAA Racing Standard)
    const dist = 7.6 + sp * 0.9;
    const height = 2.7 - sp * 0.25;
    _camDesired.copy(_camCarPos)
      .addScaledVector(_camDir, -dist)
      .add(_camUpVec.set(0, height, 0))
      .add(_camProxOffset);
    _camLook.copy(_camCarPos)
      .addScaledVector(_camDir, 6.0 + sp * 3.0)
      .add(_camUpVec.set(0, 1.15, 0))
      .add(_camProxLook);
  } else if (camMode === 1) {
    // Mode 1: Close Street / Action Chase Cam
    const dist = 5.2 + sp * 0.5;
    const height = 1.9;
    _camDesired.copy(_camCarPos)
      .addScaledVector(_camDir, -dist)
      .add(_camUpVec.set(0, height, 0))
      .add(_camProxOffset);
    _camLook.copy(_camCarPos)
      .addScaledVector(_camDir, 5.0 + sp * 2.0)
      .add(_camUpVec.set(0, 1.05, 0))
      .add(_camProxLook);
  } else if (camMode === 2) {
    // Mode 2: Hood / Front Bumper Cam (First-Person Perspective)
    _camDesired.copy(_camCarPos)
      .addScaledVector(_camDir, 0.45)
      .add(_camUpVec.set(0, 1.15, 0));
    _camLook.copy(_camCarPos)
      .addScaledVector(_camDir, 35.0)
      .add(_camUpVec.set(0, 1.0, 0));
  } else {
    // Mode 3: Helicopter / Tactical Overview Cam
    _camDesired.copy(_camCarPos)
      .addScaledVector(_camDir, -14.0)
      .add(_camUpVec.set(0, 6.8, 0));
    _camLook.copy(_camCarPos)
      .addScaledVector(_camDir, 4.0)
      .add(_camUpVec.set(0, 0.8, 0));
  }

  _camDesired.y = Math.max(_camDesired.y, 0.45);
  const posLerpRate = camMode === 2 ? 1 : (1 - Math.exp(-6.8 * dt));
  camera.position.lerp(_camDesired, posLerpRate);
  lookTarget.lerp(_camLook, 1 - Math.exp(-10.0 * dt));

  // Subtle speed vibration (disabled when Reduced Motion is toggled)
  const baseShake = sp > 0.85 ? (sp - 0.85) * 0.03 : 0;
  shakeAmp = Math.max(0, shakeAmp - shakeAmp * 8.5 * dt);
  const amp = prefs.rm ? 0 : (shakeAmp + baseShake);
  if (amp > 0.001) {
    camera.position.x += (Math.random() - 0.5) * amp;
    camera.position.y += (Math.random() - 0.5) * amp * 0.4;
    camera.position.z += (Math.random() - 0.5) * amp;
  }

  camera.lookAt(lookTarget);

  // Dynamic FOV with speed sensation & nitro
  const baseFov = camMode === 2 ? 68 : (camMode === 1 ? 64 : 60);
  const fovTarget = baseFov + sp * 11 + (mine.n ? 5.5 : 0) + dynamicFovBoost;
  if (Math.abs(camera.fov - fovTarget) > 0.04) {
    camera.fov = lerp(camera.fov, fovTarget, 1 - Math.exp(-4.8 * dt));
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
  const master = ctx.createGain(); master.gain.value = 0.65; master.connect(ctx.destination);
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 6;
  master.disconnect(); master.connect(comp); comp.connect(ctx.destination);

  // High-Fidelity Supercar Engine Synthesizer:
  // Combines warm sub-bass rumble, tuned triangle body, and smooth lowpass filtration.
  const engines = [0, 1].map(() => {
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';              // warm fundamental
    const o2 = ctx.createOscillator(); o2.type = 'triangle';              // smooth mid-range body
    const o3 = ctx.createOscillator(); o3.type = 'sine';                  // deep sub-bass purr
    const g1 = ctx.createGain(); g1.gain.value = 0.32;
    const g2 = ctx.createGain(); g2.gain.value = 0.28;
    const g3 = ctx.createGain(); g3.gain.value = 0.36;
    const shaper = ctx.createWaveShaper(); shaper.curve = distCurve(1.2); shaper.oversample = '4x';
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 240; body.Q.value = 0.75; body.gain.value = 3;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 450; lp.Q.value = 0.65;
    const engGain = ctx.createGain(); engGain.gain.value = 0;
    o1.connect(g1); o2.connect(g2); o3.connect(g3);
    g1.connect(shaper); g2.connect(shaper); g3.connect(body);
    shaper.connect(body); body.connect(lp); lp.connect(engGain); engGain.connect(master);
    o1.start(); o2.start(); o3.start();
    return { o1, o2, o3, lp, body, engGain };
  });

  // Soft granular tire skid noise (bandpassed pink noise, zero harshness)
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 1.0;
  const skidGain = ctx.createGain(); skidGain.gain.value = 0;
  noise.connect(bp); bp.connect(skidGain); skidGain.connect(master); noise.start();

  // Smooth nitro turbine surge
  const noise2 = ctx.createBufferSource(); noise2.buffer = buf; noise2.loop = true;
  const nitroFilter = ctx.createBiquadFilter(); nitroFilter.type = 'bandpass'; nitroFilter.frequency.value = 1200; nitroFilter.Q.value = 0.8;
  const nitroGain = ctx.createGain(); nitroGain.gain.value = 0;
  noise2.connect(nitroFilter); nitroFilter.connect(nitroGain); nitroGain.connect(master); noise2.start();

  audio = { ctx, master, engines, skidGain, nitroGain };
  setAudio();   // apply mute + start low background music
}
function beep(freq, dur = 0.16, type = 'sine', vol = 0.22) {
  ensureAudio(); if (!audio) return;
  const ctx = audio.ctx;
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
  const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = freq * 2;
  const g = ctx.createGain();
  const g2 = ctx.createGain(); g2.gain.value = 0.25;
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g); o2.connect(g2); g2.connect(g); g.connect(audio.master);
  o.start(); o2.start(); o.stop(ctx.currentTime + dur + 0.05); o2.stop(ctx.currentTime + dur + 0.05);
}
function playHorn() {
  ensureAudio(); if (!audio) return;
  const ctx = audio.ctx;
  [440, 554.37].forEach((f) => {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.24, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g); g.connect(audio.master);
    o.start(); o.stop(ctx.currentTime + 0.38);
  });
}
function winJingle(isFirst = true) {
  if (prefs.mute) return;
  const notes = isFirst ? [523.25, 659.25, 783.99, 1046.50, 1318.51] : [440, 554.37, 659.25, 880];
  notes.forEach((f, i) => setTimeout(() => {
    ensureAudio(); if (!audio) return;
    const ctx = audio.ctx;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.42);
    o.connect(g); g.connect(audio.master);
    o.start(); o.stop(ctx.currentTime + 0.45);
  }, i * 130));
}
function updateAudio(mine, rival) {
  if (!audio) return;
  if (audio.ctx.state === 'suspended') { audio.ctx.resume(); return; }
  const t = audio.ctx.currentTime;
  [mine, rival].forEach((cs, i) => {
    const e = audio.engines && audio.engines[i];
    if (!e) return;
    if (!cs || cs.p !== 1) { e.engGain.gain.setTargetAtTime(0, t, 0.1); return; }
    const sp = clamp(Math.abs(cs.v) / CFG.maxSpeed, 0, 1);
    const thr = clamp((cs.th != null ? cs.th : sp) + (cs.n ? 0.35 : 0), 0, 1);
    // Smooth 6-speed progression
    const gear = Math.min(5, Math.floor(sp * 6));
    const frac = sp * 6 - gear;
    const rpm = 0.22 + 0.78 * frac;
    const f0 = 50 + rpm * 140 + thr * 16;          // fundamental ~50–206 Hz (rich, deep baritone)
    e.o1.frequency.setTargetAtTime(f0, t, 0.05);
    e.o2.frequency.setTargetAtTime(f0 * 1.5, t, 0.05);
    e.o3.frequency.setTargetAtTime(f0 * 0.5, t, 0.05);
    e.lp.frequency.setTargetAtTime(260 + rpm * 1200 + thr * 600, t, 0.08);
    e.body.frequency.setTargetAtTime(f0 * 1.8, t, 0.08);
    let vol = 0.035 + sp * 0.08 + thr * 0.09 + (cs.n ? 0.03 : 0);
    if (i === 1) {
      const dist = Math.hypot(camera.position.x - cs.x, camera.position.z - cs.z);
      vol *= clamp(1 - dist / 160, 0, 1) * 0.7;
    }
    e.engGain.gain.setTargetAtTime(vol, t, 0.07);
  });
  const skidAmt = (mine && mine.sl > 5.0 && Math.abs(mine.v) > 7) ? clamp((mine.sl - 5.0) * 0.025, 0, 0.12) : 0;
  audio.skidGain.gain.setTargetAtTime(skidAmt, t, 0.06);
  audio.nitroGain.gain.setTargetAtTime((mine && mine.n) || (rival && rival.n) ? 0.07 : 0, t, 0.08);
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
        // Maps 1-4: 2-pass converge matching Map 0
        const nC = T.nearest(v.netX, v.netZ, v._th); v._th = nC.th;
        if (!(nC.d <= limC && nC.d + 2.6 <= limP)) {
          for (let iter = 0; iter < 2; iter++) {
            let maxOver = 0;
            for (let pIdx = 0; pIdx < 3; pIdx++) {
              const pr0 = pIdx === 0 ? 0 : (pIdx === 1 ? 2.6 : -2.4);
              const pr1 = pIdx === 0 ? limC : limP;
              const px = v.netX + dirX * pr0, pz = v.netZ + dirZ * pr0;
              const n = T.nearest(px, pz, v._th);
              const over = n.d - pr1;
              if (over > maxOver) maxOver = over;
            }
            if (maxOver <= 0) break;
            const c0 = T.nearest(v.netX, v.netZ, v._th);
            v._th = c0.th;
            let sx = v.netX - c0.cx, sz = v.netZ - c0.cz;
            const cd = Math.hypot(sx, sz) || 1;
            sx /= cd; sz /= cd;
            v.netX -= sx * maxOver; v.netZ -= sz * maxOver;
          }
        }
      } else {
        const proj = (px, pz) => CORE.ellipseProj(px, pz, T.a, T.b);
        // Map 0: v53 2-pass converge (historic behavior, untouched)
        for (let iter = 0; iter < 2; iter++) {
          let maxOver = 0, sx = 0, sz = 0;
          for (let pIdx = 0; pIdx < 3; pIdx++) {
            const pr0 = pIdx === 0 ? 0 : (pIdx === 1 ? 2.6 : -2.4);
            const pr1 = pIdx === 0 ? limC : limP;
            const n = proj(v.netX + dirX * pr0, v.netZ + dirZ * pr0);
            const over = Math.abs(n.lat) - pr1;
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
  const curY = curMap ? getSurfaceY(curMap, v.netX, v.netZ) : 0;
  const fwdDirX = Math.sin(v.netH), fwdDirZ = Math.cos(v.netH);
  const yFwd = curMap ? getSurfaceY(curMap, v.netX + fwdDirX * 1.5, v.netZ + fwdDirZ * 1.5) : 0;
  const yBwd = curMap ? getSurfaceY(curMap, v.netX - fwdDirX * 1.5, v.netZ - fwdDirZ * 1.5) : 0;
  const roadPitch = -Math.atan2(yFwd - yBwd, 3.0);

  const latDirX = Math.cos(v.netH), latDirZ = -Math.sin(v.netH);
  const yRight = curMap ? getSurfaceY(curMap, v.netX + latDirX * 1.0, v.netZ + latDirZ * 1.0) : 0;
  const yLeft = curMap ? getSurfaceY(curMap, v.netX - latDirX * 1.0, v.netZ - latDirZ * 1.0) : 0;
  const roadRoll = Math.atan2(yRight - yLeft, 2.0);

  v.group.position.set(v.netX, curY, v.netZ);
  v.group.rotation.y = v.netH;

  // Dynamic body roll, suspension pitch, and terrain grade
  const isBraking = (cs.th != null && cs.th < 0) || (cs.v < -0.2) || (slot === mySlot && keys.has('KeyS'));
  if (v.tailMat) {
    v.tailMat.emissiveIntensity = isBraking ? 3.6 : 1.8;
    v.tailMat.color.setHex(isBraking ? 0xff0000 : 0xff1515);
  }
  const accelSquat = (cs.th > 0 ? (cs.n ? -0.045 : -0.025) : 0);
  const brakeDive = isBraking ? 0.042 : 0;
  const pitchTarget = roadPitch + accelSquat + brakeDive;
  v.body.rotation.x = lerp(v.body.rotation.x, pitchTarget, Math.min(1, dt * 7.5));
  v.body.rotation.z = lerp(v.body.rotation.z, clamp(roadRoll - cs.sl * 0.052, -0.38, 0.38), Math.min(1, dt * 9.0));
  const sp = clamp(Math.abs(cs.v) / CFG.maxSpeed, 0, 1);
  v.body.position.y = Math.sin(performance.now() * 0.016 + slot * 3) * 0.008 * sp;
  v.spinAngle += cs.v * dt / 0.35;
  for (const w of v.wheels) {
    w.spin.rotation.x = v.spinAngle;
    if (w.front) {
      w.pivot.rotation.y = -cs.st * 0.42;
      w.pivot.rotation.z = -cs.st * 0.12; // Dynamic front wheel camber angle
    }
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
      const fy = curMap ? CORE.getTerrainHeight(curMap, fx, fz) : 0; spawnFlame(fx, fy + 0.42, fz);
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
    const isMe = cs.s === mySlot;
    const col = '#' + cbCol(cs.s).toString(16).padStart(6, '0');
    if (isMe) {
      // Distinct glowing ring around YOUR car
      mctx.strokeStyle = '#ffffff';
      mctx.lineWidth = 1.8;
      mctx.beginPath();
      mctx.arc(cs.x * MSCALE, cs.z * MSCALE, 5.2, 0, Math.PI * 2);
      mctx.stroke();
    }
    mctx.fillStyle = col;
    mctx.beginPath();
    mctx.arc(cs.x * MSCALE, cs.z * MSCALE, isMe ? 4.2 : 3.2, 0, Math.PI * 2);
    mctx.fill();
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
  const c1 = latest.cars && latest.cars[0], c2 = latest.cars && latest.cars[1];
  if (latest.mode !== 'coop') {
    hText(hudPill1, (c1 && c1.nm) || 'PLAYER 1');
    hText(hudPill2, (c2 && c2.nm) || 'PLAYER 2');
  } else {
    hText(hudPill1, 'CO-OP · ' + ((c1 && c1.nm) || 'YOU'));
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
  if (n !== lastCountInt) { lastCountInt = n; showCount(String(n)); beep(440, 0.16, 'sine', 0.22); }
}

// ---------------------------------------------------------------------------
// Lobby buttons (+ map selection)
// ---------------------------------------------------------------------------
$('start-btn').addEventListener('click', () => {
  clearCount();
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
  const humanRival = latest && latest.cars && latest.cars.filter((c) => c && c.p === 1 && c.s !== mySlot).length > 0 && !latest.bot;
  if (humanRival) { net.send({ type: 'rematch' }); toast('🔁 Rematch requested — waiting for rival…'); }
  else net.send({ type: 'start' });
  track('second_race', selectedMap);
  track('race', selectedMap);
  if (humanRival) track('multiplayer', selectedMap);
});
const rstBtn = $('restart-btn');
if (rstBtn) rstBtn.addEventListener('click', () => { // v61 quick restart (no reload/reconnect)
  clearAutoRematchTimer();
  clearCount();
  const ov = $('tt-overlay'); if (ov) ov.classList.add('hidden');
  TT.done = false;
  net.send({ type: 'restart' });
});
const trkBtn = $('track-btn');
if (trkBtn) trkBtn.addEventListener('click', () => { clearAutoRematchTimer(); clearCount(); $('results').classList.add('hidden'); net.send({ type: 'reset' }); const nb = $('next-btn'); if (nb) setTimeout(() => nb.click(), 150); });
$('menu-btn').addEventListener('click', () => { clearAutoRematchTimer(); clearCount(); $('results').classList.add('hidden'); net.send({ type: 'reset' }); });
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
const createRoomBtn = $('create-room-btn');
if (createRoomBtn) {
  createRoomBtn.addEventListener('click', () => {
    // v91: creating while seated leaves the old room first (the relay drops it),
    // so confirm before abandoning a live race
    if (inARoom()) {
      const q = (typeof tI18n === 'function' ? tI18n('createAnotherConfirm', { code: roomCode }) : null)
        || ('Leave room ' + roomCode + ' and create a new one?');
      if (!confirm(q)) return;
      net.send(Object.assign({ type: 'create_room', mode: 'race', map: selectedMap, laps: (prefs && prefs.laps) || 3 }, identityPayload()));
      armRoomHop('/');
      toast((typeof tI18n === 'function' ? tI18n('creatingRoom') : null) || '🏎️ Creating a new room…');
      return;
    }
    ensureRoomCreated();
    toast('🏎️ Room created! Share the code to invite friends.');
  });
}
const joinRoomBtn = $('join-room-btn');
if (joinRoomBtn) {
  joinRoomBtn.addEventListener('click', () => {
    const promptMsg = (typeof tI18n === 'function' ? tI18n('enterRoomCode') : null) || 'Enter 5-letter Room Code to join:';
    const code = prompt(promptMsg);
    if (code && code.trim().length >= 4) {
      const cleanCode = code.trim().toUpperCase();
      const isMobileTouch = ('ontouchstart' in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0)) && (window.innerWidth <= 768 || window.innerHeight <= 500 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
      const reloadUrl = '/?room=' + encodeURIComponent(cleanCode) + (isMobileTouch ? '&screen=1' : '');
      if (net.isOpen()) {
        // v91: hop rooms on the live socket — no reload, no lost session state
        net.send(Object.assign({ type: 'join_room', room: cleanCode }, identityPayload()));
        armRoomHop(reloadUrl);
        toast((typeof tI18n === 'function' ? tI18n('joiningRoom', { code: cleanCode }) : null) || ('🔑 Joining room ' + cleanCode + '…'));
      } else {
        location.href = reloadUrl;
      }
    }
  });
}
const exitBtn = $('exit-btn');
if (exitBtn) exitBtn.addEventListener('click', () => net.send({ type: 'reset' }));
const leaveRoomBtn = $('leave-room-btn');
if (leaveRoomBtn) leaveRoomBtn.addEventListener('click', () => exitRoom()); // v91
syncRoomButtons();
const camBtn = $('cam-btn');
if (camBtn) camBtn.addEventListener('click', cycleCamera);
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
document.addEventListener('click', (e) => {
  const b = e.target && e.target.closest('button, .mob-choice-btn, .ltab, .btab, .ctab, .mf-pill, .map-card, .weather-btn, .car-card');
  if (b) soundUiClick();
}, { passive: true });
frame();
