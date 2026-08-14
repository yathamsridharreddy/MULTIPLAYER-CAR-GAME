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
   VELOCITY RUSH — online multiplayer screen client
   Renders the authoritative server simulation with smooth
   interpolation. Physics runs on the server; this page is a
   synchronized viewer + HUD + FX layer.
   ============================================================ */

const CORE = window.VRCore;
const CFG = CORE.CFG;
const A = CFG.trackA, B = CFG.trackB, RH = CFG.roadHalf;
const PI2 = Math.PI * 2;
const INTERP_DELAY = 120;   // ms behind the server for smooth interpolation

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
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd7e3ec);
scene.fog = new THREE.Fog(0xd7e3ec, 320, 980);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 2600);
camera.position.set(A - 3, 3.4, -14);

function makeEnvTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#1668d8');
  grad.addColorStop(0.42, '#8ec4f4');
  grad.addColorStop(0.50, '#f4e9d8');
  grad.addColorStop(0.56, '#8d958c');
  grad.addColorStop(1.0, '#39422f');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 256);
  // bright softbox strips -> sharp highlight streaks on car paint
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillRect(0, 34, 512, 14);
  g.fillRect(0, 78, 512, 7);
  g.fillStyle = 'rgba(18,28,48,0.5)';
  g.fillRect(0, 54, 512, 12);
  g.fillStyle = 'rgba(255,255,255,0.65)';
  for (const pt of [[90, 105, 60, 13], [300, 95, 80, 15], [430, 115, 50, 11]]) {
    g.beginPath(); g.ellipse(pt[0], pt[1], pt[2], pt[3], 0, 0, PI2); g.fill();
  }
  const sun = g.createRadialGradient(400, 62, 4, 400, 62, 92);
  sun.addColorStop(0, 'rgba(255,255,245,1)');
  sun.addColorStop(0.25, 'rgba(255,240,195,0.95)');
  sun.addColorStop(1, 'rgba(255,240,195,0)');
  g.fillStyle = sun; g.fillRect(0, 0, 512, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromEquirectangular(makeEnvTexture()).texture;
  pmrem.dispose();
}

const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x44543a, 0.5);
scene.add(hemi);

const sunLight = new THREE.DirectionalLight(0xffe3b8, 1.5);
sunLight.position.set(210, 240, 110);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -280; sunLight.shadow.camera.right = 280;
sunLight.shadow.camera.top = 250;   sunLight.shadow.camera.bottom = -250;
sunLight.shadow.camera.near = 40;   sunLight.shadow.camera.far = 900;
sunLight.shadow.bias = -0.00045;
scene.add(sunLight, sunLight.target);

{
  const geo = new THREE.SphereGeometry(1500, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top:     { value: new THREE.Color(0x1d6fd6) },
      horizon: { value: new THREE.Color(0xdfe9f0) },
      bottom:  { value: new THREE.Color(0x98a196) }
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
  scene.add(new THREE.Mesh(geo, mat));
}
{
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,252,235,1)');
  grad.addColorStop(0.25, 'rgba(255,244,200,0.85)');
  grad.addColorStop(1, 'rgba(255,244,200,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), fog: false, depthWrite: false });
  const spr = new THREE.Sprite(mat);
  spr.position.copy(sunLight.position).normalize().multiplyScalar(1300);
  spr.scale.set(220, 220, 1);
  scene.add(spr);
}

// ---------------------------------------------------------------------------
// Track + world (deterministic — identical to the server's simulation)
// ---------------------------------------------------------------------------
function grassTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#41702f'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(${30 + Math.random() * 40},${85 + Math.random() * 70},${28 + Math.random() * 30},0.35)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 2.5);
  }
  g.fillStyle = 'rgba(255,255,240,0.05)';
  for (let x = 0; x < 256; x += 64) g.fillRect(x, 0, 32, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(150, 150);
  tex.anisotropy = 4;
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}
function concreteTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#8d9298'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 6000; i++) {
    const v = 120 + Math.random() * 60;
    g.fillStyle = `rgba(${v},${v},${v},0.3)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.4, 1.4);
  }
  g.strokeStyle = 'rgba(70,74,80,0.5)'; g.lineWidth = 1.2;
  for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(0, i * 51 + 25); g.lineTo(256, i * 51 + 25); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}
{
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1500, 64),
    new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // concrete paddock apron around the circuit
  const apronShape = new THREE.Shape();
  apronShape.absellipse(0, 0, A + RH + 14, B + RH + 14, 0, PI2, false, 0);
  const apronHole = new THREE.Path();
  apronHole.absellipse(0, 0, A - RH - 10, B - RH - 10, 0, PI2, true, 0);
  apronShape.holes.push(apronHole);
  const apronGeo = new THREE.ShapeGeometry(apronShape, 96);
  apronGeo.rotateX(-Math.PI / 2);
  const apron = new THREE.Mesh(apronGeo, new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.95 }));
  apron.position.y = 0.012;
  apron.receiveShadow = true;
  scene.add(apron);
}

function ellipseRing(rIn, rOut, segments) {
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, A + rOut, B + rOut, 0, Math.PI * 2, false, 0);
  const hole = new THREE.Path();
  hole.absellipse(0, 0, A + rIn, B + rIn, 0, Math.PI * 2, true, 0);
  shape.holes.push(hole);
  const geo = new THREE.ShapeGeometry(shape, segments || 96);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function asphaltTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#2a2d32'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i++) {
    const v = 28 + Math.random() * 46;
    g.fillStyle = `rgba(${v},${v},${v + 3},0.5)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.4, 1.4);
  }
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(18,20,24,${0.08 + Math.random() * 0.16})`;
    g.beginPath();
    g.ellipse(Math.random() * 256, Math.random() * 256, 8 + Math.random() * 22, 6 + Math.random() * 14, Math.random() * 3, 0, PI2);
    g.fill();
  }
  g.strokeStyle = 'rgba(14,15,17,0.4)'; g.lineWidth = 0.7;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    let x = Math.random() * 256, y = Math.random() * 256;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) { x += (Math.random() - 0.5) * 30; y += (Math.random() - 0.5) * 30; g.lineTo(x, y); }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.1, 0.1);
  tex.anisotropy = 8;
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

{
  const road = new THREE.Mesh(
    ellipseRing(-RH, RH, 128),
    new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.92, metalness: 0.05 })
  );
  road.position.y = 0.02;
  road.receiveShadow = true;
  scene.add(road);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.8 });
  for (const off of [RH - 0.9, -RH + 0.55]) {
    const line = new THREE.Mesh(ellipseRing(off, off + 0.35, 128), lineMat);
    line.position.y = 0.045;
    scene.add(line);
  }
}

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
  scene.add(inst);
}

{
  const c = document.createElement('canvas'); c.width = 160; c.height = 32;
  const g = c.getContext('2d');
  for (let i = 0; i < 10; i++) for (let j = 0; j < 2; j++) {
    g.fillStyle = (i + j) % 2 ? '#101010' : '#f4f4f4';
    g.fillRect(i * 16, j * 16, 16, 16);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.encoding = THREE.sRGBEncoding;
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(RH * 2, 2.6),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 })
  );
  line.rotation.x = -Math.PI / 2;
  line.position.set(A, 0.06, 0);
  scene.add(line);
}

// ---- white START line at the grid (behind the finish line) ----
{
  const startLine = new THREE.Mesh(
    new THREE.PlaneGeometry(RH * 2, 0.6),
    new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 })
  );
  startLine.rotation.x = -Math.PI / 2;
  startLine.position.set(A, 0.055, -6);
  scene.add(startLine);

  // "START" road text just behind the start line
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0)'; g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#f4f4f4'; g.font = '900 44px Arial Black, Arial'; g.textAlign = 'center';
  g.fillText('START', 128, 48);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  const stGeo = new THREE.PlaneGeometry(6, 1.5);
  stGeo.rotateX(-Math.PI / 2);   // lay flat (text top now points -Z)
  stGeo.rotateY(Math.PI);        // spin 180 in-plane so it reads driving +Z
  const startText = new THREE.Mesh(
    stGeo,
    new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.7 })
  );
  startText.position.set(A, 0.057, -9);
  scene.add(startText);
}

{
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8dbe2, metalness: 0.7, roughness: 0.35 });
  const poleGeo = new THREE.CylinderGeometry(0.28, 0.34, 8, 10);
  for (const side of [-1, 1]) {
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(A + side * (RH + 1.4), 4, 0);
    pole.castShadow = true;
    scene.add(pole);
  }
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  for (let i = 0; i < 32; i++) for (let j = 0; j < 2; j++) {
    g.fillStyle = (i + j) % 2 ? '#111' : '#f2f2f2';
    g.fillRect(i * 16, j * 12, 16, 12);
  }
  g.fillStyle = 'rgba(10,12,20,0.88)';
  g.fillRect(0, 24, 512, 72);
  g.fillStyle = '#ffd479';
  g.font = '900 44px Arial Black, Arial';
  g.textAlign = 'center';
  g.fillText('START / FINISH', 256, 78);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  const bannerMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(RH * 2 + 2.8, 2.2),
    new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.7 })
  );
  bannerMesh.position.set(A, 7.1, 0);
  bannerMesh.rotation.y = 0;
  bannerMesh.castShadow = true;
  scene.add(bannerMesh);
}

// scenery from the deterministic world layout
function buildingTexture(seed) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = ['#22303e', '#2c2a33', '#3a3f47'][seed % 3];
  g.fillRect(0, 0, 64, 128);
  for (let y = 6; y < 122; y += 10) {
    for (let x = 5; x < 58; x += 10) {
      const r = Math.random();
      g.fillStyle = r < 0.24 ? '#ffd97a' : (r < 0.55 ? '#5f7488' : '#1b2530');
      g.fillRect(x, y, 6, 7);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

{
  const W = CORE.WORLD;
  const buildingMats = [0, 1, 2].map((i) => new THREE.MeshStandardMaterial({ map: buildingTexture(i), roughness: 0.9 }));
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.95 });
  for (const b of W.buildings) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(b.w, b.h, b.d),
      [buildingMats[b.tex], buildingMats[(b.tex + 1) % 3], roofMat, roofMat, buildingMats[(b.tex + 2) % 3], buildingMats[b.tex]]
    );
    mesh.position.set(b.x, b.h / 2, b.z);
    mesh.rotation.y = b.rot;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  }

  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1.7, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2e6b34, roughness: 1, flatShading: true });
  const leafMat2 = new THREE.MeshStandardMaterial({ color: 0x3d8040, roughness: 1, flatShading: true });
  const cone1 = new THREE.ConeGeometry(1.9, 4.4, 7);
  const cone2 = new THREE.ConeGeometry(1.35, 3.1, 7);
  for (const tr of W.trees) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.y = 0.85;
    const l1 = new THREE.Mesh(cone1, tr.variant ? leafMat : leafMat2); l1.position.y = 3.4;
    const l2 = new THREE.Mesh(cone2, leafMat); l2.position.y = 5.3;
    tree.add(trunk, l1, l2);
    tree.scale.setScalar(tr.s);
    tree.position.set(tr.x, 0, tr.z);
    tree.rotation.y = tr.rot;
    tree.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(tree);
  }

  for (const mt of W.mountains) {
    const mtn = new THREE.Mesh(
      new THREE.ConeGeometry(mt.r, mt.h, 5),
      new THREE.MeshStandardMaterial({ color: 0x8598ab, roughness: 1, flatShading: true })
    );
    mtn.position.set(Math.cos(mt.t) * mt.dist, mt.h / 2 - 6, Math.sin(mt.t) * mt.dist);
    mtn.rotation.y = mt.rot;
    scene.add(mtn);
  }

  {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#0c1020'; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#2b355c'; g.lineWidth = 8; g.strokeRect(6, 6, 500, 116);
    g.fillStyle = '#ff5252'; g.font = '900 58px Arial Black, Arial'; g.textAlign = 'center';
    g.fillText('VELOCITY RUSH', 256, 82);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 5),
      new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.85 })
    );
    board.position.set(W.billboard.x, 4.4, W.billboard.z);
    board.rotation.y = W.billboard.rot;
    board.castShadow = true;
    scene.add(board);
    const legGeo = new THREE.CylinderGeometry(0.16, 0.16, 4.4, 6);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x444a55, roughness: 0.8 });
    for (const dx of [-7, 7]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(W.billboard.x - dx * Math.cos(0.25), 2.2, W.billboard.z + dx * Math.sin(0.25) * -1);
      leg.castShadow = true;
      scene.add(leg);
    }
  }
}

// ---------------------------------------------------------------------------
// Circuit realism: curbs, barriers, grid, ads, lights, palms, grandstand
// ---------------------------------------------------------------------------
const _im = new THREE.Matrix4(), _iq = new THREE.Quaternion(), _iup = new THREE.Vector3(0, 1, 0);
function instancedAlong(geo, mat, offset, stepLen, y, scaleY) {
  const ax = A + offset, bz = B + offset;
  const per = Math.PI * (3 * (ax + bz) - Math.sqrt((3 * ax + bz) * (ax + 3 * bz)));
  const N = Math.max(24, Math.round(per / stepLen));
  const inst = new THREE.InstancedMesh(geo, mat, N);
  for (let i = 0; i < N; i++) {
    const t = (i / N) * PI2;
    const yaw = Math.atan2(-ax * Math.sin(t), bz * Math.cos(t));
    _iq.setFromAxisAngle(_iup, yaw);
    _im.compose(new THREE.Vector3(ax * Math.cos(t), y, bz * Math.sin(t)), _iq, new THREE.Vector3(1, scaleY || 1, 1));
    inst.setMatrixAt(i, _im);
  }
  inst.receiveShadow = true;
  scene.add(inst);
  return inst;
}

{
  // red/white rumble curbs on both road edges
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
      const yaw = Math.atan2(-ax * Math.sin(t), bz * Math.cos(t));
      _iq.setFromAxisAngle(_iup, yaw);
      _im.compose(new THREE.Vector3(ax * Math.cos(t), 0.045, bz * Math.sin(t)), _iq, new THREE.Vector3(1, 1, 1));
      if (i % 2 === 0) ir.setMatrixAt(ri++, _im); else iw.setMatrixAt(wi++, _im);
    }
    ir.receiveShadow = iw.receiveShadow = true;
    scene.add(ir, iw);
  }

  // concrete barrier walls + red top rail
  const wallGeo = new THREE.BoxGeometry(0.5, 0.95, 2.7);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.85 });
  const railGeo = new THREE.BoxGeometry(0.54, 0.14, 2.7);
  const railMat = new THREE.MeshStandardMaterial({ color: 0xc9302c, roughness: 0.6 });
  for (const off of [RH + 3.2, -RH - 3.2]) {
    instancedAlong(wallGeo, wallMat, off, 2.6, 0.5);
    instancedAlong(railGeo, railMat, off, 2.6, 1.02);
  }
}

// starting grid slots
{
  const gridMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.7 });
  for (const [gx, gz] of [[A - 2.8, -9], [A + 2.8, -15], [A - 2.8, -21], [A + 2.8, -27]]) {
    const slot = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 5), gridMat);
    slot.rotation.x = -Math.PI / 2;
    slot.position.set(gx, 0.05, gz);
    scene.add(slot);
  }
}

// sponsor ad boards around the outside
{
  const brands = [['#e10600', 'NITRO'], ['#0a84ff', 'APEX'], ['#ffb800', 'TURBO'], ['#111', 'SRIDHAR'], ['#00a651', 'RUSH'], ['#7b2ff7', 'VELOCITY'], ['#ff6a00', 'DRIFT'], ['#003d8f', 'PIT LANE']];
  brands.forEach((b, i) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = b[0]; g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#fff'; g.font = '900 72px Arial Black, Arial'; g.textAlign = 'center';
    g.fillText(b[1], 256, 92);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    const t = (i / brands.length) * PI2 + 0.35;
    const off = RH + 6.8;
    const x = (A + off) * Math.cos(t), z = (B + off) * Math.sin(t);
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 2.7),
      new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.7 })
    );
    board.position.set(x, 1.5, z);
    board.rotation.y = Math.atan2(-x, -z);
    board.castShadow = true;
    scene.add(board);
  });
}

// floodlight poles
{
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3c4046, metalness: 0.6, roughness: 0.5 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff6da, emissive: 0xfff0c0, emissiveIntensity: 2.2 });
  for (let i = 0; i < 10; i++) {
    const t = (i / 10) * PI2;
    const off = RH + 10;
    const x = (A + off) * Math.cos(t), z = (B + off) * Math.sin(t);
    const grp = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 8, 8), poleMat);
    pole.position.y = 4;
    pole.castShadow = true;
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.4), lampMat);
    head.position.y = 8;
    grp.add(pole, head);
    grp.position.set(x, 0, z);
    grp.rotation.y = Math.atan2(-x, -z);
    scene.add(grp);
  }
}

// palm trees (Asphalt vibe)
{
  const rnd = CORE.mulberry32(1234);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5a34, roughness: 1 });
  const frondMat = new THREE.MeshStandardMaterial({ color: 0x2f8f3a, roughness: 1, side: THREE.DoubleSide, flatShading: true });
  const frondGeo = new THREE.PlaneGeometry(2.6, 0.6);
  for (let i = 0; i < 16; i++) {
    const t = rnd() * PI2;
    const inside = rnd() < 0.4;
    const off = inside ? -(RH + 14 + rnd() * 26) : (RH + 12 + rnd() * 30);
    const x = (A + off) * Math.cos(t), z = (B + off) * Math.sin(t);
    if (Math.abs(x - A) < 26 && Math.abs(z) < 26) continue;
    const palm = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, 4.8, 6), trunkMat);
    trunk.position.y = 2.4;
    trunk.rotation.z = (rnd() - 0.5) * 0.16;
    trunk.castShadow = true;
    palm.add(trunk);
    for (let f = 0; f < 7; f++) {
      const fr = new THREE.Mesh(frondGeo, frondMat);
      fr.position.y = 4.8;
      fr.rotation.y = (f / 7) * PI2;
      fr.rotation.x = 0.75;
      fr.translateY(0); fr.translateZ(1.2);
      fr.castShadow = true;
      palm.add(fr);
    }
    palm.position.set(x, 0, z);
    scene.add(palm);
  }
}

// grandstand near the start line
{
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  const cols = ['#e10600', '#ffffff', '#0a84ff', '#ffb800'];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 64; x++) {
    g.fillStyle = cols[(x + y) % 4];
    g.fillRect(x * 4, y * 16, 4, 16);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  const stand = new THREE.Mesh(
    new THREE.BoxGeometry(6, 4, 46),
    [new THREE.MeshStandardMaterial({ color: 0x565b62, roughness: 0.9 }), new THREE.MeshStandardMaterial({ color: 0x565b62, roughness: 0.9 }),
     new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }), new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.9 }),
     new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 })]
  );
  stand.position.set(A + RH + 20, 2.2, 0);
  stand.rotation.z = -0.32;
  stand.castShadow = stand.receiveShadow = true;
  scene.add(stand);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, 48), new THREE.MeshStandardMaterial({ color: 0xe8e8ea, roughness: 0.5, metalness: 0.4 }));
  roof.position.set(A + RH + 20, 6.4, 0);
  roof.castShadow = true;
  scene.add(roof);
}

// tire stacks at corner exits
{
  const tireGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.34, 12);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9 });
  const redMat = new THREE.MeshStandardMaterial({ color: 0xc9302c, roughness: 0.8 });
  for (const t of [0.6, 2.5, 3.7, 5.6]) {
    const off = RH + 4.4;
    const x = (A + off) * Math.cos(t), z = (B + off) * Math.sin(t);
    for (let k = 0; k < 3; k++) {
      const tire = new THREE.Mesh(tireGeo, k === 1 ? redMat : tireMat);
      tire.position.set(x, 0.2 + k * 0.34, z);
      tire.castShadow = true;
      scene.add(tire);
    }
  }
}

// drifting clouds
const clouds = [];
{
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (const [cx, cy, r] of [[40, 70, 26], [70, 60, 30], [95, 72, 22], [64, 80, 26]]) {
    g.beginPath(); g.arc(cx, cy, r, 0, PI2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  for (let i = 0; i < 7; i++) {
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.75, fog: false, depthWrite: false });
    const s = new THREE.Sprite(m);
    const a = (i / 7) * PI2;
    s.position.set(Math.cos(a) * (500 + i * 60), 260 + (i % 3) * 60, Math.sin(a) * (500 + i * 60));
    s.scale.set(180 + (i % 3) * 60, 60 + (i % 2) * 25, 1);
    scene.add(s);
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
// Car visuals
// ---------------------------------------------------------------------------
function createCar(paintColor, num, accent) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);

  const paint = new THREE.MeshPhysicalMaterial({
    color: paintColor, metalness: 0.6, roughness: 0.2,
    clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 1.0
  });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0c1118, metalness: 0.9, roughness: 0.08, clearcoat: 1 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x101216, metalness: 0.5, roughness: 0.6 });

  // sleek GT body from extruded side profile
  const s = new THREE.Shape();
  s.moveTo(-2.30, 0.16);
  s.lineTo(-2.42, 0.62);
  s.lineTo(-2.28, 0.92);
  s.lineTo(-1.10, 0.98);
  s.lineTo(-0.45, 1.16);
  s.lineTo(0.30, 1.00);
  s.lineTo(1.25, 0.66);
  s.lineTo(2.25, 0.50);
  s.lineTo(2.40, 0.26);
  s.lineTo(2.30, 0.14);
  s.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(s, {
    depth: 1.56, bevelEnabled: true, bevelThickness: 0.16, bevelSize: 0.16,
    bevelSegments: 4, steps: 1, curveSegments: 6
  });
  bodyGeo.translate(0, 0, -0.78);
  bodyGeo.rotateY(-Math.PI / 2);
  body.add(new THREE.Mesh(bodyGeo, paint));

  // bubble canopy
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), glass);
  canopy.scale.set(0.78, 0.42, 1.45);
  canopy.position.set(0, 0.88, -0.35);
  body.add(canopy);

  // GT wing + endplates + stays
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.06, 0.55), carbon);
  wing.position.set(0, 1.35, -2.25); wing.rotation.x = -0.12;
  body.add(wing);
  for (const sx of [-0.95, 0.95]) {
    const end = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.6), paint);
    end.position.set(sx, 1.38, -2.25); body.add(end);
  }
  for (const sx of [-0.55, 0.55]) {
    const stay = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.08), carbon);
    stay.position.set(sx, 1.1, -2.3); stay.rotation.x = 0.35; body.add(stay);
  }

  // splitter, canards, skirts, intakes, diffuser (outside the beveled shell)
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.05, 0.5), carbon);
  splitter.position.set(0, 0.10, 2.62); body.add(splitter);
  for (const sx of [-1, 1]) {
    const can = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.4), carbon);
    can.position.set(sx * 1.0, 0.45, 2.2);
    can.rotation.z = sx * 0.5; can.rotation.y = -sx * 0.2;
    body.add(can);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 3.4), carbon);
    skirt.position.set(sx * 0.95, 0.2, -0.1); body.add(skirt);
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.6), carbon);
    intake.position.set(sx * 0.95, 0.55, -1.1); body.add(intake);
  }
  const diff = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.06, 0.6), carbon);
  diff.position.set(0, 0.16, -2.55); diff.rotation.x = 0.4; body.add(diff);

  // lights + exhausts + mirrors + vents
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: 0xffeeb0, emissiveIntensity: 2.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff1111, emissive: 0xff1111, emissiveIntensity: 1.9 });
  for (const sx of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.22), headMat);
    head.position.set(sx * 0.62, 0.58, 2.42);
    head.rotation.y = -sx * 0.35; head.rotation.z = sx * 0.12;
    body.add(head);
    const stay = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.05), carbon);
    stay.position.set(sx * 0.88, 0.93, 0.55); body.add(stay);
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.16), carbon);
    mir.position.set(sx * 0.97, 0.96, 0.55); body.add(mir);
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.5), carbon);
    vent.position.set(sx * 0.38, 0.86, 1.35); vent.rotation.x = 0.28;
    body.add(vent);
  }
  const tailBar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.05), tailMat);
  tailBar.position.set(0, 0.78, -2.62); body.add(tailBar);
  const exGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.3, 10);
  exGeo.rotateX(Math.PI / 2);
  const exMat = new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.95, roughness: 0.3 });
  for (const sx of [-0.35, 0.35]) {
    const ex = new THREE.Mesh(exGeo, exMat);
    ex.position.set(sx, 0.35, -2.6); body.add(ex);
  }

  // race number roundels + side stripes
  const rc = document.createElement('canvas'); rc.width = rc.height = 128;
  const rg = rc.getContext('2d');
  rg.fillStyle = '#f4f4f4'; rg.beginPath(); rg.arc(64, 64, 62, 0, PI2); rg.fill();
  rg.strokeStyle = '#111'; rg.lineWidth = 6; rg.stroke();
  rg.fillStyle = '#111'; rg.font = '900 78px Arial Black, Arial'; rg.textAlign = 'center'; rg.textBaseline = 'middle';
  rg.fillText(String(num || 1), 64, 70);
  const rTex = new THREE.CanvasTexture(rc);
  rTex.encoding = THREE.sRGBEncoding;
  const rGeo = new THREE.CircleGeometry(0.32, 24);
  for (const sx of [-1, 1]) {
    const r = new THREE.Mesh(rGeo, new THREE.MeshStandardMaterial({ map: rTex, roughness: 0.5 }));
    r.rotation.y = sx * Math.PI / 2;
    r.position.set(sx * 0.95, 0.62, 0.35);
    body.add(r);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 3.6),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }));
    stripe.position.set(sx * 0.96, 0.32, -0.1);
    body.add(stripe);
  }

  // wheels + colored calipers + center-lock caps
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 20);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.31, 12);
  hubGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.92 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 0.9, roughness: 0.3 });
  const calMat = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.4 });
  const capGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.32, 10);
  capGeo.rotateZ(Math.PI / 2);
  const wheels = [];
  [[0.98, 1.45], [-0.98, 1.45], [0.98, -1.45], [-0.98, -1.45]].forEach(([x, z], i) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.35, z);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(wheelGeo, wheelMat), new THREE.Mesh(hubGeo, hubMat), new THREE.Mesh(capGeo, calMat));
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 0.3), calMat);
    cal.position.set(x > 0 ? -0.16 : 0.16, 0, 0.24);
    pivot.add(spin, cal);
    g.add(pivot);
    wheels.push({ pivot, spin, front: i < 2 });
  });

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, body, wheels };
}

const carVisuals = {
  1: Object.assign(createCar(0xe10600, 1, 0xffd400), { spinAngle: 0 }),
  2: Object.assign(createCar(0x0a84ff, 2, 0xff2038), { spinAngle: 0 })
};
scene.add(carVisuals[1].group, carVisuals[2].group);

// ---------------------------------------------------------------------------
// Particles: smoke, sparks, nitro flames, skid marks
// ---------------------------------------------------------------------------
function radialTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const softTex = radialTexture();

const smokePool = [];
for (let i = 0; i < 80; i++) {
  const mat = new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0, depthWrite: false });
  const spr = new THREE.Sprite(mat);
  spr.visible = false;
  scene.add(spr);
  smokePool.push({ spr, mat, life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0 });
}
function spawnSmoke(x, z, vx, vz) {
  const p = smokePool.find((s) => s.life <= 0);
  if (!p) return;
  p.life = p.maxLife = 0.7 + Math.random() * 0.5;
  p.spr.position.set(x + (Math.random() - 0.5) * 0.4, 0.3, z + (Math.random() - 0.5) * 0.4);
  p.vx = vx * 0.22 + (Math.random() - 0.5) * 1.6;
  p.vz = vz * 0.22 + (Math.random() - 0.5) * 1.6;
  p.vy = 0.8 + Math.random() * 1.2;
  p.spr.scale.setScalar(0.9 + Math.random() * 0.6);
  p.spr.visible = true;
}

const sparkPool = [];
for (let i = 0; i < 60; i++) {
  const mat = new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffa640 });
  const spr = new THREE.Sprite(mat);
  spr.visible = false;
  scene.add(spr);
  sparkPool.push({ spr, mat, life: 0, vx: 0, vy: 0, vz: 0 });
}
function spawnSparks(x, z, strength) {
  const n = Math.round(6 + strength * 14);
  for (let i = 0; i < n; i++) {
    const p = sparkPool.find((s) => s.life <= 0);
    if (!p) return;
    p.life = 0.35 + Math.random() * 0.4;
    p.spr.position.set(x, 0.5 + Math.random() * 0.5, z);
    p.vx = (Math.random() - 0.5) * 14 * strength + 2;
    p.vz = (Math.random() - 0.5) * 14 * strength + 2;
    p.vy = 2 + Math.random() * 6 * strength;
    p.spr.scale.setScalar(0.22 + Math.random() * 0.3);
    p.spr.visible = true;
  }
}

const flamePool = [];
for (let i = 0; i < 50; i++) {
  const mat = new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x63b8ff });
  const spr = new THREE.Sprite(mat);
  spr.visible = false;
  scene.add(spr);
  flamePool.push({ spr, mat, life: 0 });
}
function spawnFlame(wp) {
  const p = flamePool.find((s) => s.life <= 0);
  if (!p) return;
  p.life = 0.14 + Math.random() * 0.08;
  p.spr.position.copy(wp);
  p.spr.scale.setScalar(0.5 + Math.random() * 0.5);
  p.spr.visible = true;
}

function updateParticles(dt) {
  for (const p of smokePool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.spr.visible = false; p.mat.opacity = 0; continue; }
    p.spr.position.x += p.vx * dt;
    p.spr.position.y += p.vy * dt;
    p.spr.position.z += p.vz * dt;
    p.vx *= (1 - 1.6 * dt); p.vz *= (1 - 1.6 * dt);
    p.spr.scale.addScalar(dt * 3.2);
    p.mat.opacity = 0.34 * (p.life / p.maxLife);
  }
  for (const p of sparkPool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.spr.visible = false; p.mat.opacity = 0; continue; }
    p.spr.position.x += p.vx * dt;
    p.spr.position.y += p.vy * dt;
    p.spr.position.z += p.vz * dt;
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
}

const SKID_MAX = 1000;
const skidGeo = new THREE.PlaneGeometry(0.26, 0.95);
skidGeo.rotateX(-Math.PI / 2);
const skidMesh = new THREE.InstancedMesh(
  skidGeo,
  new THREE.MeshBasicMaterial({ color: 0x0c0d10, transparent: true, opacity: 0.5, depthWrite: false }),
  SKID_MAX
);
skidMesh.count = 0;
scene.add(skidMesh);
let skidIdx = 0;
const _sm = new THREE.Matrix4(), _sq = new THREE.Quaternion(), _sup = new THREE.Vector3(0, 1, 0);
function spawnSkid(x, z, heading) {
  if (Math.abs(CORE.radialDistToTrack(x, z).d) > RH + 0.5) return;
  _sq.setFromAxisAngle(_sup, heading);
  _sm.compose(new THREE.Vector3(x, 0.035 + (skidIdx % 4) * 0.0015, z), _sq, new THREE.Vector3(1, 1, 1));
  skidMesh.setMatrixAt(skidIdx % SKID_MAX, _sm);
  skidIdx++;
  skidMesh.count = Math.min(SKID_MAX, skidIdx);
  skidMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Room connection + snapshot buffer
// ---------------------------------------------------------------------------
let mySlot = 1;
let roomCode = '';
let latest = null;               // latest snapshot
const snaps = [];                // {t, snap}
let lastBannerSeq = 0;
let lastCountInt = 99;

function interpState(slot) {
  if (snaps.length === 0) return null;
  const target = performance.now() - INTERP_DELAY;
  let ai = -1;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].t <= target) { ai = i; break; }
  }
  const carOf = (snap) => snap.cars[slot - 1];
  if (ai < 0) return carOf(snaps[0].snap);
  const a = snaps[ai];
  const b = snaps[ai + 1];
  const ca = carOf(a.snap);
  if (!b) return ca;
  const cb = carOf(b.snap);
  const alpha = clamp((target - a.t) / Math.max(1, b.t - a.t), 0, 1);
  return {
    s: slot,
    x: lerp(ca.x, cb.x, alpha),
    z: lerp(ca.z, cb.z, alpha),
    h: lerpAngle(ca.h, cb.h, alpha),
    v: lerp(ca.v, cb.v, alpha),
    sl: lerp(ca.sl, cb.sl, alpha),
    st: cb.st,
    n: cb.n, m: cb.m, lap: cb.lap, ll: ca.ll, best: cb.best,
    fin: cb.fin, ft: cb.ft, p: cb.p, pr: cb.pr
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

// ---- HUD/UI state ----
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
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

function setBanner(text) {
  const el = $('banner-text');
  el.textContent = text;
  const b = $('banner');
  b.classList.remove('show');
  void b.offsetWidth;
  b.classList.add('show');
  clearTimeout(setBanner._t);
  setBanner._t = setTimeout(() => b.classList.remove('show'), 4200);
}

function confetti() {
  const c = $('confetti');
  c.innerHTML = '';
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
  const el = $('count-num');
  el.textContent = txt;
  el.classList.toggle('go', txt === 'GO!');
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function showResults(order) {
  const rows = $('results-rows');
  rows.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉'];
  const winner = order[0];
  order.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'rrow' + (i === 0 ? ' win' : '');
    div.innerHTML = `<span class="medal">${medals[i] || ''}</span>` +
      `<span class="rname" style="color:${c.slot === 1 ? '#ff6b6b' : '#64b5f6'}">PLAYER ${c.slot}</span>` +
      `<span class="rtime">${c.finished ? fmtTime(c.t) : 'DNF'}</span>` +
      `<span class="rbest">best lap ${c.best != null ? fmtTime(c.best) : '--:--.--'}</span>`;
    rows.appendChild(div);
  });
  $('results-title').textContent = winner ? `🏁 PLAYER ${winner.slot} WINS!` : '🏁 RACE RESULTS';
  $('results').classList.remove('hidden');
}

function updateLobby(snap) {
  $('room-code').textContent = snap.code;
  const gameLink = location.origin + '/?room=' + snap.code;
  const phoneLink = location.origin + '/controller?room=' + snap.code;
  $('game-link').textContent = gameLink;
  $('ctrl-url').textContent = phoneLink;
  drawQR(phoneLink);

  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === snap.mode);
  });

  const parts = [];
  if (snap.controllers[1]) parts.push('📱 P1 joystick');
  if (snap.controllers[2]) parts.push('📱 P2 joystick');
  $('lobby-status').textContent = parts.length ? 'Connected: ' + parts.join(' · ') : 'Waiting for joysticks (or drive with keyboard)…';
}

let qrDrawnFor = '';
function drawQR(url) {
  if (qrDrawnFor === url) return;
  qrDrawnFor = url;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const canvas = $('qr-canvas');
    const px = Math.floor(196 / n);
    const size = px * n;
    canvas.width = canvas.height = size + px * 4;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#101014';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) g.fillRect((c + 2) * px, (r + 2) * px, px, px);
      }
    }
  } catch (e) {}
}

function processEvents(snap) {
  for (const e of snap.events || []) {
    switch (e.type) {
      case 'count':
        showCount(String(e.n));
        beep(392, 0.14, 'square', 0.24);
        break;
      case 'go':
        showCount('GO!');
        beep(784, 0.5, 'square', 0.28);
        break;
      case 'crash':
        onCrashFX(e.x, e.z, e.s);
        break;
      case 'lap':
        toast(`P${e.slot} lap ${e.n} — ${fmtTime(e.t)}${e.best ? '  ★ BEST' : ''}`);
        break;
      case 'finallap':
        toast(`🔥 P${e.slot}: FINAL LAP!`);
        beep(660, 0.14, 'square', 0.2);
        break;
      case 'win':
        setBanner(e.multi ? `🏁 PLAYER ${e.slot} WINS!` : `🏁 FINISH — ${fmtTime(e.t)}`);
        confetti();
        winJingle();
        break;
      case 'finished':
        toast(`P${e.slot} finished — ${fmtTime(e.t)}`);
        break;
      case 'results':
        showResults(e.order);
        break;
    }
  }
  if (snap.banner && snap.banner.seq !== lastBannerSeq && snap.banner.text) {
    lastBannerSeq = snap.banner.seq;
    // banner visuals are driven by win/finallap events already
  }
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
const wantedRoom = urlParam('room');
const net = new RoomLink({
  onWelcome(msg) {
    mySlot = msg.slot;
    roomCode = msg.code;
    $('slot-badge').textContent = `YOU ARE PLAYER ${mySlot}`;
    $('slot-badge').className = mySlot === 1 ? 'slot-badge c1' : 'slot-badge c2';
    $('slot-badge').style.display = '';
    setNetBanner(true);
    if (msg.snapshot) ingestSnapshot(msg.snapshot);
  },
  onMessage(msg) {
    switch (msg.type) {
      case 'state':
        ingestSnapshot(msg);
        break;
      case 'controller-joined':
        setConnected(msg.slot, true);
        toast(`📱 Player ${msg.slot} joystick connected`);
        break;
      case 'controller-left':
        setConnected(msg.slot, false);
        toast(`Player ${msg.slot} joystick disconnected`);
        break;
      case 'horn':
        playHorn();
        break;
      case 'cam':
        if (msg.slot === mySlot) cycleCamera();
        break;
      case 'error':
        if (msg.code === 'no-room') showRoomError('Room not found — it may have closed. Create a new one!');
        break;
      case 'disconnected':
        setNetBanner(false);
        break;
    }
  },
  onStatus(s) {
    setNetBanner(s === 'connected');
    $('lobby-conn').textContent = s === 'connected' ? '🟢 connected' : (s === 'connecting' ? '🟡 connecting…' : '🔴 reconnecting…');
  }
});
net.connect({ type: 'hello', role: 'screen', room: wantedRoom || null });

function showRoomError(text) {
  $('room-error').textContent = text;
  $('room-error').style.display = '';
  // offer a fresh room
  setTimeout(() => {
    net.closedByUser = false;
    net.connect({ type: 'hello', role: 'screen', room: null });
  }, 1200);
}

function ingestSnapshot(snap) {
  snaps.push({ t: performance.now(), snap });
  if (snaps.length > 150) snaps.splice(0, snaps.length - 150);
  latest = snap;
  processEvents(snap);

  // lobby <-> race transitions
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
}
function setNetBanner(ok) { $('net-banner').classList.toggle('hidden', ok); }

// ---------------------------------------------------------------------------
// Keyboard fallback (drives your own car when your phone isn't connected)
// ---------------------------------------------------------------------------
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  ensureAudio();
  if (e.code === 'KeyC') cycleCamera();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

let kbAccum = 0;
function maybeSendKeyboard(dt) {
  if (!latest || !net.isOpen()) return;
  if (latest.state !== 'racing' && latest.state !== 'countdown') return;
  if (latest.controllers[mySlot]) return;   // phone is driving
  kbAccum += dt;
  if (kbAccum < 0.033) return;
  kbAccum = 0;
  const steer = (keys.has('ArrowLeft') || keys.has('KeyA') ? -1 : 0) + (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0);
  const throttle = (keys.has('ArrowUp') || keys.has('KeyW')) ? 1 : 0;
  const brake = (keys.has('ArrowDown') || keys.has('KeyS')) ? 1 : 0;
  net.send({ type: 'input', steer, throttle, brake, handbrake: keys.has('Space'), nitro: keys.has('ShiftLeft') || keys.has('ShiftRight') });
}

// ---------------------------------------------------------------------------
// Camera — adaptive dual-car framing, FOV kick, shake
// ---------------------------------------------------------------------------
let camMode = 0;
const lookTarget = new THREE.Vector3(A - 2.8, 1, 0);
function cycleCamera() { camMode = (camMode + 1) % 3; }

function updateCamera(dt, mine, rival) {
  if (!mine) return;
  const dir = new THREE.Vector3(Math.sin(mine.h), 0, Math.cos(mine.h));
  let desired, look, sepFov = 0;

  const dual = rival && rival.p === 1 && camMode !== 2 && latest && latest.state !== 'waiting';

  if (camMode === 2) {
    desired = new THREE.Vector3(mine.x, 0, mine.z).addScaledVector(dir, 0.4).add(new THREE.Vector3(0, 1.18, 0));
    look = new THREE.Vector3(mine.x, 0, mine.z).addScaledVector(dir, 40).add(new THREE.Vector3(0, 1.0, 0));
  } else if (dual) {
    const mid = new THREE.Vector3((mine.x + rival.x) / 2, 0, (mine.z + rival.z) / 2);
    const sep = Math.hypot(mine.x - rival.x, mine.z - rival.z);
    const dist = clamp(8.6 + sep * 0.78, 8.6, 32);
    const height = clamp(3.2 + sep * 0.30, 3.2, 12);
    desired = mid.clone().addScaledVector(dir, -dist).add(new THREE.Vector3(0, height, 0));
    look = mid.clone().addScaledVector(dir, 3).add(new THREE.Vector3(0, 1, 0));
    sepFov = clamp(sep * 0.55, 0, 16);
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
  const amp = shakeAmp + baseShake;
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
  const el = $('arrow');
  if (!rival || rival.p !== 1 || !latest || latest.state === 'waiting') { el.style.display = 'none'; return; }
  _av.set(rival.x, 1.2, rival.z);
  const toOther = _av.clone().sub(camera.position);
  camera.getWorldDirection(_cd);
  const inFront = toOther.dot(_cd) > 0;
  _av.project(camera);
  if (inFront && Math.abs(_av.x) < 0.92 && Math.abs(_av.y) < 0.86) { el.style.display = 'none'; return; }
  let sx = _av.x, sy = -_av.y;
  if (!inFront) { sx = -sx; sy = -sy; }
  const ang = Math.atan2(sy, sx);
  const W = window.innerWidth / 2 - 56, H = window.innerHeight / 2 - 56;
  const t = Math.min(W / Math.max(1e-6, Math.abs(Math.cos(ang))), H / Math.max(1e-6, Math.abs(Math.sin(ang))));
  el.style.display = 'flex';
  el.style.left = (window.innerWidth / 2 + Math.cos(ang) * t * 0.94) + 'px';
  el.style.top = (window.innerHeight / 2 + Math.sin(ang) * t * 0.94) + 'px';
  el.style.transform = `translate(-50%,-50%) rotate(${ang}rad)`;
  el.classList.toggle('p2', rival.s === 2);
  el.classList.toggle('p1', rival.s === 1);
  el.querySelector('.dist').textContent = Math.round(Math.hypot(rival.x - camera.position.x, rival.z - camera.position.z)) + 'm';
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
let audio = null;
function ensureAudio() {
  if (audio) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);

  const engines = [0, 1].map(() => {
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'square';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ctx.createGain(); g.gain.value = 0;
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
    o1.start(); o2.start();
    return { o1, o2, g, lp };
  });

  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.9;
  const skidGain = ctx.createGain(); skidGain.gain.value = 0;
  noise.connect(bp); bp.connect(skidGain); skidGain.connect(master);
  noise.start();

  const noise2 = ctx.createBufferSource(); noise2.buffer = buf; noise2.loop = true;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1900;
  const nitroGain = ctx.createGain(); nitroGain.gain.value = 0;
  noise2.connect(hp); hp.connect(nitroGain); nitroGain.connect(master);
  noise2.start();

  audio = { ctx, master, engines, skidGain, nitroGain };
}

function beep(freq, dur = 0.15, type = 'square', vol = 0.22) {
  ensureAudio();
  if (!audio) return;
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
    if (!cs || cs.p !== 1) { e.g.gain.setTargetAtTime(0, t, 0.1); return; }
    const sp = clamp(Math.abs(cs.v) / CFG.maxSpeed, 0, 1);
    const gear = Math.min(4, Math.floor(sp * 5));
    const frac = sp * 5 - gear;
    const rpm = 0.22 + 0.78 * frac;
    const freq = 52 + rpm * 165 + sp * 46;
    e.o1.frequency.setTargetAtTime(freq, t, 0.05);
    e.o2.frequency.setTargetAtTime(freq * 0.5 + 1, t, 0.05);
    e.lp.frequency.setTargetAtTime(500 + sp * 2200, t, 0.1);
    let vol = 0.03 + sp * 0.14 + (cs.n ? 0.05 : 0);
    if (i === 1) {
      const dist = camera.position.distanceTo(new THREE.Vector3(cs.x, 0, cs.z));
      vol *= clamp(1 - dist / 160, 0, 1) * 0.8;
    }
    e.g.gain.setTargetAtTime(vol, t, 0.08);
  });
  const skidAmt = (mine && mine.sl > 4.5 && Math.abs(mine.v) > 6) ? clamp(mine.sl * 0.018, 0, 0.2) : 0;
  audio.skidGain.gain.setTargetAtTime(skidAmt, t, 0.06);
  audio.nitroGain.gain.setTargetAtTime((mine && mine.n) || (rival && rival.n) ? 0.1 : 0, t, 0.08);
}

// ---------------------------------------------------------------------------
// Car placement + FX from interpolated state
// ---------------------------------------------------------------------------
function placeCar(slot, cs, dt) {
  const v = carVisuals[slot];
  if (!cs) return;
  v.group.visible = cs.p === 1;
  if (!v.group.visible) return;

  v.group.position.set(cs.x, 0, cs.z);
  v.group.rotation.y = cs.h;

  v.body.rotation.z = lerp(v.body.rotation.z, clamp(-cs.sl * 0.042, -0.17, 0.17), Math.min(1, dt * 8));
  const sp = clamp(Math.abs(cs.v) / CFG.maxSpeed, 0, 1);
  v.body.position.y = Math.sin(performance.now() * 0.016 + slot * 3) * 0.008 * sp;

  v.spinAngle += cs.v * dt / 0.35;
  for (const w of v.wheels) {
    w.spin.rotation.x = v.spinAngle;
    if (w.front) w.pivot.rotation.y = -cs.st * 0.42;
  }

  // rear-wheel world positions for smoke/skid (local rear wheels at ±0.98, z=-1.45)
  if (cs.sl > 4.5 && Math.abs(cs.v) > 6) {
    for (const side of [-0.98, 0.98]) {
      const wx = cs.x + side * Math.cos(cs.h) - 1.45 * Math.sin(cs.h);
      const wz = cs.z - side * Math.sin(cs.h) - 1.45 * Math.cos(cs.h);
      if (Math.random() < 0.5) spawnSmoke(wx, wz, Math.sin(cs.h) * cs.v, Math.cos(cs.h) * cs.v);
      spawnSkid(wx, wz, cs.h);
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
// HUD
// ---------------------------------------------------------------------------
const minimap = $('minimap');
const mctx = minimap.getContext('2d');
const MSCALE = 62 / (A + RH + 4);

function drawMinimap(mine, rival) {
  const w = minimap.width, h = minimap.height;
  mctx.clearRect(0, 0, w, h);
  mctx.save();
  mctx.translate(w / 2, h / 2);
  mctx.strokeStyle = 'rgba(255,255,255,0.16)';
  mctx.lineWidth = (RH * 2) * MSCALE;
  mctx.beginPath();
  mctx.ellipse(0, 0, A * MSCALE, B * MSCALE, 0, 0, Math.PI * 2);
  mctx.stroke();
  mctx.strokeStyle = 'rgba(255,255,255,0.5)';
  mctx.lineWidth = 1;
  mctx.stroke();
  mctx.strokeStyle = '#fff';
  mctx.lineWidth = 2;
  mctx.beginPath();
  mctx.moveTo((A - RH) * MSCALE, 0);
  mctx.lineTo((A + RH) * MSCALE, 0);
  mctx.stroke();
  for (const cs of [mine, rival]) {
    if (!cs || cs.p !== 1) continue;
    mctx.fillStyle = cs.s === 1 ? '#ff5252' : '#42a5f5';
    mctx.beginPath();
    mctx.arc(cs.x * MSCALE, cs.z * MSCALE, 3.4, 0, Math.PI * 2);
    mctx.fill();
  }
  mctx.restore();
}

function updateHUD(mine, rival) {
  if (!latest || !mine) return;
  $('speed-val').textContent = Math.round(Math.abs(mine.v) * 3.6);
  $('gear').textContent = mine.v < -0.5 ? 'R' : (Math.abs(mine.v) < 0.4 ? 'N' : 'D');
  $('nitro-fill').style.width = (mine.m || 0) + '%';
  $('nitro-fill').classList.toggle('burn', mine.n === 1);

  const order = standingsFrom(latest);
  const myRank = order.findIndex((c) => c.s === mySlot);
  $('raceinfo').innerHTML =
    `<span id="lapchip">LAP ${Math.min(mine.lap + 1, CFG.totalLaps)}<small>/${CFG.totalLaps}</small></span>` +
    (order.length > 1 && myRank >= 0 ? `<span id="poschip" class="${mySlot === 1 ? 'c1' : 'c2'}">${ordinal(myRank + 1).toUpperCase()}</span>` : '');

  const row = (c) => `L${Math.min(c.lap + 1, CFG.totalLaps)}  ${c.ll != null ? fmtTime(c.ll) : '--:--.--'}  <span class="dim">best ${c.best != null ? fmtTime(c.best) : '--:--.--'}</span>`;
  $('lap-p1').innerHTML = `<b style="color:#ff6b6b">P1</b> ${row(latest.cars[0])}`;
  if (latest.mode === 'race') {
    $('lap-p2').style.display = '';
    $('lap-p2').innerHTML = `<b style="color:#64b5f6">P2</b> ${latest.cars[1].p === 1 ? row(latest.cars[1]) : '<span class="dim">waiting…</span>'}`;
  } else {
    $('lap-p2').style.display = 'none';
  }

  $('speedlines').style.opacity = clamp((Math.abs(mine.v) - 26) / 34, 0, 0.6);
  drawMinimap(mine, rival);
}

// synced countdown numbers (server-driven float)
function updateCountdownVisual() {
  if (!latest || latest.state !== 'countdown' || latest.count == null) return;
  const n = Math.max(1, Math.ceil(latest.count));
  if (n !== lastCountInt) {
    lastCountInt = n;
    showCount(String(n));
    beep(392, 0.14, 'square', 0.24);
  }
}

// ---------------------------------------------------------------------------
// Lobby buttons
// ---------------------------------------------------------------------------
$('start-btn').addEventListener('click', () => { ensureAudio(); net.send({ type: 'start' }); });
$('rematch-btn').addEventListener('click', () => { $('results').classList.add('hidden'); net.send({ type: 'start' }); });
$('menu-btn').addEventListener('click', () => { $('results').classList.add('hidden'); net.send({ type: 'reset' }); });
document.querySelectorAll('.mode-btn').forEach((b) => {
  b.addEventListener('click', () => net.send({ type: 'mode', mode: b.dataset.mode }));
});
$('copy-code').addEventListener('click', () => { copyText($('room-code').textContent); toast('Room code copied!'); });
const exitBtn = $('exit-btn');
if (exitBtn) exitBtn.addEventListener('click', () => net.send({ type: 'reset' }));
$('copy-game-link').addEventListener('click', () => { copyText($('game-link').textContent); toast('Game link copied — send it to your friend!'); });
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
window.addEventListener('pointerdown', ensureAudio, { passive: true });

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  const mine = interpState(mySlot);
  const rival = interpState(mySlot === 1 ? 2 : 1);

  if (latest && latest.state === 'countdown') updateCountdownVisual();

  placeCar(1, interpState(1), dt);
  placeCar(2, interpState(2), dt);
  updateParticles(dt);
  updateClouds(dt);
  updateCamera(dt, mine, rival);
  updateArrow(rival);
  updateAudio(mine, rival);
  updateHUD(mine, rival);
  maybeSendKeyboard(dt);

  renderer.render(scene, camera);
}
frame();
