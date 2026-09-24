// v117 — real-car model pipeline (VISUAL ONLY).
// Physics, networking, collision, spawn/respawn and camera code never touch this
// file; it only produces drop-in replacements for the procedural car visual that
// placeCar() already knows how to drive ({group, body, wheels, paint, ...}).
//
// Licensing: every entry in SOURCES must carry a license + credit string that is
// mirrored in public/assets/cars/<id>/LICENSE.txt and ASSETS-CREDITS.md.
// Models whose license cannot be documented must never be added here.
(function () {
  'use strict';

  // ---- registry: car id -> asset + rig hints + attribution -------------------
  // v128: every car uses the same proven CarConcept GLB (ghost) with its own paint colour.
  // This satisfies "remodel every car like ghost car model with their colours" — 8 distinct
  // colours, one shared CC-BY-4.0 asset, no new downloads, no physics change.
  const GHOST_SRC = {
    url: 'assets/cars/ghost/CarConcept.gltf',
    license: 'CC-BY-4.0',
    credit: 'CarConcept - Khronos Group glTF-Sample-Assets (CC-BY-4.0), based on a public-domain concept car by Unity Fan (Sketchfab).',
    paintRe: /paint/i,
    wheelRe: /^Wheel(Front|Rear)(L|R)$/i,
    headRe: /^Headlight$/i,
    tailRe: /^Brakelight$/i,
    hubRe: /^Rim[12]$/i,
    glassRe: /^Glass$/i,
    brakeRe: /^Brake$/i            // v139: the red caliper - the "trail" cosmetic paints this
  };
  const SOURCES = {
    fury: { ...GHOST_SRC },
    storm: { ...GHOST_SRC },
    volt: { ...GHOST_SRC },
    viper: { ...GHOST_SRC },
    blaze: { ...GHOST_SRC },
    phantom: { ...GHOST_SRC },
    ghost: { ...GHOST_SRC },
    reaper: { ...GHOST_SRC }
  };

  // The 8 selectable cars keep their existing ids; the wire still carries only
  // the paint hex (cs.col), so the server/network layer stays model-agnostic.
  const HEX2ID = {
    0xe10600: 'fury', 0x0a84ff: 'storm', 0xffd400: 'volt', 0x00a651: 'viper',
    0xff6a00: 'blaze', 0x7b2ff7: 'phantom', 0xffffff: 'ghost', 0x111111: 'reaper'
  };

  const cache = new Map();    // url -> Promise<gltf>  (one download shared by all 8 colours)
  const warned = new Set();

  function idForHex(h) { return (h == null) ? null : (HEX2ID[h | 0] || null); }
  function hasModel(id) { return Object.prototype.hasOwnProperty.call(SOURCES, id); }

  function warnOnce(id, err) {
    if (warned.has(id)) return; warned.add(id);
    console.warn('[car-models] ' + id + ': GLB unavailable, procedural shell kept -', (err && err.message) || err);
  }

  function load(id) {
    if (!hasModel(id)) return Promise.reject(new Error('no model registered for ' + id));
    const url = SOURCES[id].url;
    if (cache.has(url)) return cache.get(url);
    const p = new Promise((resolve, reject) => {
      if (typeof THREE === 'undefined' || !THREE.GLTFLoader) return reject(new Error('THREE.GLTFLoader not present'));
      new THREE.GLTFLoader().load(url, resolve, undefined, reject);
    });
    cache.set(url, p);
    p.catch(() => cache.delete(url));
    return p;
  }

  // ---- build one drivable visual wrapper around a cached model --------------
  function build(id, paintHex, bodyIdx) {
    return load(id).then((gltf) => {
      const S = SOURCES[id];
      const src = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      if (!src) throw new Error('empty gltf scene');
      const model = src.clone(true); // v136 fix: clone per car — shared scene caused damaged bodies (except blue last-built)

      // layering: group (game transform, owned by placeCar)
      //           -> off  (grounding/centring translation, game space)
      //           -> bob  (the "body" space: decals/neon + suspension bob)
      //           -> root (uniform scale) -> yaw (PI)
      //              CarConcept already -90° X in glTF, so no extra tilt
      const group = new THREE.Group();
      const off = new THREE.Group();
      const bob = new THREE.Group();
      const root = new THREE.Group();
      // v123 FIX: CarConcept glTF already carries a -90° X rotation at its root
      // (BodyUnderside matrix). The old code added another -90°, double-tilting the
      // car to stand on its nose (the screenshot). Keep only the yaw flip.
      // v124 FIX: front/back swapped — after baked -90° X the model already faces +Z.
      // Keeping PI made it face -Z (front looked like back). Use 0.
      const yaw = new THREE.Group(); yaw.rotation.y = 0;
      yaw.add(model); root.add(yaw); bob.add(root); off.add(bob); group.add(off);

      // normalise: 4.6 m long, centred on X/Z, tyres resting on y = 0
      root.scale.setScalar(1);
      group.updateMatrixWorld(true);
      let box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const s = 4.6 / Math.max(size.x, size.z, 0.001);
      root.scale.setScalar(s);
      group.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(root);
      const c = box.getCenter(new THREE.Vector3());
      off.position.set(-c.x, -box.min.y, -c.z);
      group.updateMatrixWorld(true);

      // ---- wheel rig (v139 rewrite) -----------------------------------------
      // The asset ships its FRONT WHEELS ALREADY TURNED: WheelFrontL/R carry a baked
      // automotive steering angle in their node matrix (axle points (0.87, 0, 0.50)
      // = 30 deg off lateral, and a different euler on each side). v117..v138 wrote
      // the live steering into pivot.rotation.z, which does NOT cancel that bake -
      // assigning one euler component leaves the other two - so while driving
      // straight the front wheels sat cocked ~21-26 deg AND cambered (axle gained a
      // +/-0.24..0.27 vertical component), differently left and right. That is the
      // "cars not going correctly" the player sees: crooked, mismatched front wheels.
      //
      // The rig is therefore rebuilt so the authored pose is preserved but the baked
      // steering is removed, and the live rotations sit on their own clean groups:
      //
      //   pivot                position only, identity rotation (the wheel centre)
      //     steer              live steering, about the pivot's local Z (world up)
      //       rest             authored pose, baked steer removed -> axle along +X
      //         spin           live rolling, about the true axle (local X)
      //           rim, tyre, disc ...   (all roll)
      //         brake pad      stays in `rest`: a caliper must never spin
      //
      // Afterwards the GLB axles point along local +X and up is local +Z, exactly like
      // the procedural rig, so one set of drive numbers works for both.
      const wheels = [];
      model.traverse((o) => {
        if (!o.name || !S.wheelRe.test(o.name)) return;
        const baked = o.quaternion.clone();
        const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(baked).normalize();
        // parent frame has Z up, so the baked steering angle is this atan2
        const bakedSteer = Math.atan2(axle.y, axle.x);
        const rest = new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(0, 0, 1), -bakedSteer)
          .multiply(baked);
        const steerG = new THREE.Group();
        const restG = new THREE.Group(); restG.quaternion.copy(rest);
        const spinG = new THREE.Group();
        const pads = [], rolling = [];
        while (o.children.length) {
          const c = o.children[0];
          o.remove(c);
          if (/pad/i.test(c.name || '')) pads.push(c); else rolling.push(c);
        }
        rolling.forEach((c) => spinG.add(c));
        pads.forEach((c) => restG.add(c));
        restG.add(spinG);
        steerG.add(restG);
        o.add(steerG);
        o.quaternion.identity();       // the pivot is a position holder now
        wheels.push({ pivot: steerG, spin: spinG, front: /front/i.test(o.name), side: /L$/i.test(o.name) ? -1 : 1 });
      });

      // v138: the ONLY mesh-level culling left in the whole pipeline. It runs once per
      // build, on names only - never on colour. Rationale:
      //  * the licence plate is the yellow card that used to sit in front of the car,
      //    so it goes (the plate mesh is named "License Plate" / material "License");
      //  * the interior is invisible from outside and costs fill rate, so it goes too;
      //  * EVERY outer panel, glass, light and wheel stays, otherwise the car renders
      //    with holes and reads as "damaged" (the v126 colour heuristic did exactly
      //    that to the yellow car, whose paint 0xffd400 matched its yellow test).
      // The paint materials are explicitly protected: a /paint/i material is never
      // culled, so no car can ever lose its body again.
      const INTERIOR_WORDS = /interior|dash|steering|pedal|seat|floor|floormat|cage|engine/;
      model.traverse((o)=>{
        if(!o.isMesh) return;
        const nm=(o.name||'').toLowerCase();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const matNames = mats.map((m) => ((m && m.name) || '').toLowerCase());
        const isPaint = matNames.some((n) => /paint/.test(n));
        if (isPaint) return;                                   // never cull body paint
        if(nm.includes('license')||nm.includes('plate')||matNames.some((n)=>n.includes('license'))){ o.visible=false; return; }
        if(INTERIOR_WORDS.test(nm) && !nm.startsWith('body')) o.visible=false;
        // v139: the wiper pair is 24 336 triangles - 14% of the whole car - for a part
        // the size of a pencil. Cars ship with a clean windscreen instead.
        if(/wiper/.test(nm)) o.visible=false;
      });
      // ---- materials --------------------------------------------------------
      // Anything a player can cosmetically recolour (or that must not be shared)
      // is cloned per car; the expensive kit is rebuilt as a plain standard
      // material. `swap` repoints every mesh that used the shared source material.
      const swap = (from, to) => {
        if (!from || !to || from === to) return;
        model.traverse((o) => {
          if (!o.isMesh) return;
          if (Array.isArray(o.material)) o.material = o.material.map((x) => (x === from ? to : x));
          else if (o.material === from) o.material = to;
        });
      };
      // v139 PERF: MeshPhysicalMaterial only pays for the features its values ask for,
      // but the asset asks for a lot - Paint 1 has clearcoat 1.0 and the paint variants
      // carry iridescence 0.5-0.8. Zeroing them removes the clearcoat/iridescence shader
      // paths from every body panel (the largest thing on screen) with no visible loss.
      const conform = (m) => {
        if (!m) return m;
        m.clearcoat = 0; m.clearcoatRoughness = 0;
        m.iridescence = 0; m.iridescenceIOR = 1; m.sheen = 0;
        m.transmission = 0; m.thickness = 0;   // see the glass note below
        m.needsUpdate = true;
        return m;
      };
      const paintMats = [], seen = new Set();
      let headMat = null, tailMat = null, hubMat = null, glassMat = null, brakeMat = null;
      model.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const matNames = mats.map((m) => ((m && m.name) || '').toLowerCase()).join(' ');
        // v139 PERF: the wheels are 67 000 of the car's 213 000 triangles and they cost
        // the same again in the shadow pass, for a shadow that sits under the car and is
        // already drawn by the contact patch. Only the big panels cast. The wheel test
        // has to look at the MATERIALS too: the tyres are unnamed nodes whose only
        // identity is their Tireside/Tiretread materials.
        o.castShadow = !/wheel|brake|rim|tire|tyre|tread|disc|mirror|handle|gasket|wiper/.test(((o.name || '') + ' ' + matNames).toLowerCase());
        mats.forEach((mt) => {
          if (!mt || seen.has(mt.uuid)) return; seen.add(mt.uuid);
          const n = mt.name || '';
          if (S.headRe.test(n)) headMat = headMat || mt;
          else if (S.tailRe.test(n)) tailMat = tailMat || mt;
          if (S.hubRe && S.hubRe.test(n)) hubMat = hubMat || mt;
          if (S.glassRe && S.glassRe.test(n)) glassMat = glassMat || mt;
          if (S.brakeRe && S.brakeRe.test(n)) brakeMat = brakeMat || mt;
          if (S.paintRe.test(n)) paintMats.push(mt);
        });
      });
      const clonedPaint = paintMats.map((m) => {
        const cm = conform(m.clone());
        swap(m, cm);
        return cm;
      });
      if (headMat) { const hm = conform(headMat.clone()); swap(headMat, hm); headMat = hm; }
      if (tailMat) { const tm = conform(tailMat.clone()); swap(tailMat, tm); tailMat = tm; }

      // v139 THE GLASS. KHR_materials_transmission = 1 promoted the windscreen to
      // MeshPhysicalMaterial and switched on the transmission shader path (the most
      // expensive material in the scene), and with the interior culled the player
      // looked straight through a hollow cabin. Tinted, OPAQUE glass on the cheap
      // path instead: the shell reads as a solid car again and the shader is standard.
      if (glassMat) {
        glassMat.transmission = 0; glassMat.thickness = 0;   // also on the cached source
        const gm = glassMat.clone();
        gm.name = 'Glass';
        gm.transmission = 0; gm.thickness = 0;
        gm.transparent = false; gm.opacity = 1; gm.depthWrite = true;
        gm.color.setHex(0x0d1626);
        gm.metalness = 0.92; gm.roughness = 0.06;
        if (gm.emissive) gm.emissive.setHex(0x000000);
        gm.envMapIntensity = 2.0;
        gm.needsUpdate = true;
        swap(glassMat, gm);
        glassMat = gm;
      }

      // v139: rims and calipers are separately owned by each racer. They used to be the
      // asset's SHARED materials, so one player picking a wheel/trail cosmetic recoloured
      // everybody's car, and the caliper material the trail cosmetic wrote to was not
      // even attached to the model (the choice silently did nothing).
      if (hubMat) { const hm = conform(hubMat.clone()); swap(hubMat, hm); hubMat = hm; }
      if (brakeMat) { const bm = conform(brakeMat.clone()); swap(brakeMat, bm); brakeMat = bm; }

      // rolling radius straight off the real tyre instead of a guess, so the spin
      // rate of the wheels matches the ground speed exactly (no visible slipping)
      let wheelR = 0.36 * s;
      if (wheels.length) {
        group.updateMatrixWorld(true);
        const wb = new THREE.Box3().setFromObject(wheels[0].pivot);
        wheelR = Math.min(0.6, Math.max(0.2, (wb.max.y - wb.min.y) / 2));
      }

      // paint proxy: placeCar() only ever calls paint.color.getHex()/setHex()
      const col = new THREE.Color(paintHex == null ? 0xffffff : paintHex);
      clonedPaint.forEach((m) => { if (m.color) m.color.copy(col); });
      const nativeSet = col.setHex.bind(col);
      col.setHex = (h) => { nativeSet(h); clonedPaint.forEach((m) => { if (m.color) m.color.setHex(h); }); return col; };

      headMat = headMat || new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: 0xfff0c0, emissiveIntensity: 2.6 });
      tailMat = tailMat || new THREE.MeshStandardMaterial({ color: 0xff1515, emissive: 0xff1515, emissiveIntensity: 1.8 });

      const wrap = {
        isGlb: true, carId: id,
        group: group, body: bob, wheels: wheels,
        paint: { color: col },
        headMat: headMat, tailMat: tailMat,
        hubMat: hubMat || new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 0.9, roughness: 0.3 }),
        calMat: brakeMat || new THREE.MeshStandardMaterial({ color: 0x8a1010, metalness: 0.6, roughness: 0.4 }),
        glassMat: glassMat || new THREE.MeshPhysicalMaterial({ color: 0x0a101d, metalness: 0.9, roughness: 0.05 }),
        bodyIdx: bodyIdx | 0, decalY: 1.02, hasWing: false, wheelR: wheelR,
        spinAngle: 0,
        dispose() {
          clonedPaint.forEach((m) => m.dispose());
          headMat.dispose(); tailMat.dispose();
          if (glassMat) glassMat.dispose();
          if (hubMat) hubMat.dispose();
          if (brakeMat) brakeMat.dispose();
          group.traverse((o) => { if (o.isMesh && Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); });
        }
      };
      return wrap;
    });
  }

  // Resolves a wrapper, or null -> caller keeps the procedural shell (fallback).
  function acquire(id, paintHex, bodyIdx) {
    if (!hasModel(id)) return Promise.resolve(null);
    return build(id, paintHex, bodyIdx).catch((e) => { warnOnce(id, e); return null; });
  }

  function prefetch(id) {
    if (!hasModel(id)) return;
    load(id).catch((e) => warnOnce(id, e));
  }

  window.CarModels = { SOURCES: SOURCES, HEX2ID: HEX2ID, idForHex: idForHex, hasModel: hasModel, acquire: acquire, prefetch: prefetch, cached: () => cache.size };
})();
