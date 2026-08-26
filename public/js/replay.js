'use strict';
/* ============================================================================
   SRIDHAR RUSH — ghost replay viewer (v46)
   Standalone 2D spectator page: /replay?g=ID draws a friend's lap top-down.
   Reads the same /ghost endpoint the game uses; cannot affect the game.
   ========================================================================== */
(function () {
  const CORE = window.VRCore;
  const $ = (id) => document.getElementById(id);
  const id = new URLSearchParams(location.search).get('g');
  const err = (m) => { const e = $('err'); e.hidden = false; e.textContent = m; };
  if (!id) { err('No replay id in the link.'); return; }

  let base = String(window.SERVER_URL || 'local').trim();
  if (base === 'local') base = '';
  else if (!/^(https?):\/\//i.test(base)) base = 'https://' + base;
  base = base.replace(/\/+$/, '');

  fetch(base + '/ghost?id=' + encodeURIComponent(id))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('404'))))
    .then(start)
    .catch(() => err('Replay not found (the link may be old).'));

  function start(g) {
    // v63: invalid replay data can never crash the client
    const data = (Array.isArray(g.data) ? g.data : []).filter((s) => Array.isArray(s) && s.length >= 3 && s.every((v) => typeof v === 'number' && isFinite(v))).slice(0, 4000);
    if (data.length < 2) { const e = $('who'); if (e) e.textContent = 'Invalid replay data'; return; }
    const map = CORE.MAPS[g.map] || CORE.MAPS[0];
    $('who').textContent = (g.name || 'RACER') + ' · ' + map.name;
    $('open-game').href = '/?g=' + id;

    // ---- track path (centerline) ----
    let path = [];
    if (map.track && map.track.points) path = map.track.points;
    else for (let i = 0; i < 240; i++) { const a = (i / 240) * Math.PI * 2; path.push({ x: map.a * Math.cos(a), z: map.b * Math.sin(a) }); }
    const cv = $('cv'), ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const bound = Math.max(map.a, map.b) * 1.18;
    const S = Math.min(W, H) / (2 * bound);
    const cx = W / 2, cy = H / 2;
    const X = (x) => cx + x * S, Y = (z) => cy + z * S;

    function drawTrack() {
      ctx.clearRect(0, 0, W, H);
      // asphalt ribbon
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = '#10141f'; ctx.lineWidth = 16 * S * 2 * 0.5 + 26;
      strokePath();
      ctx.strokeStyle = 'rgba(53,224,255,.5)'; ctx.lineWidth = 2;
      strokePath(3); // neon outer hint
      ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1.5; ctx.setLineDash([10, 12]);
      strokePath(); ctx.setLineDash([]);
      // start line
      const p0 = path[0], p1 = path[1];
      const ang = Math.atan2(p1.z - p0.z, p1.x - p0.x) + Math.PI / 2;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(X(p0.x + Math.cos(ang) * 9), Y(p0.z + Math.sin(ang) * 9));
      ctx.lineTo(X(p0.x - Math.cos(ang) * 9), Y(p0.z - Math.sin(ang) * 9));
      ctx.stroke();
    }
    function strokePath(off) {
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) { const p = path[i]; const x = X(p.x), y = Y(p.z); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.closePath(); ctx.stroke();
      if (off) { /* second inner glow pass skipped for perf */ }
    }

    // ---- playback ----
    const lastT = data[data.length - 1][0];
    let t = 0, playing = true, speed = 1, prev = performance.now(), idx = 0;
    const trail = [];
    const scrub = $('scrub');

    function sample(tt) {
      while (idx < data.length - 1 && data[idx + 1][0] < tt) idx++;
      const a = data[idx], b = data[Math.min(idx + 1, data.length - 1)];
      const f = b[0] > a[0] ? Math.min(1, Math.max(0, (tt - a[0]) / (b[0] - a[0]))) : 0;
      return { x: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f, h: a[3] + (b[3] - a[3]) * f };
    }

    function frame(now) {
      const dt = (now - prev) / 1000; prev = now;
      if (playing) { t += dt * speed; if (t >= lastT) { t = lastT; playing = false; $('play').textContent = '🔁'; } }
      const s = sample(t);
      trail.push(s); if (trail.length > 50) trail.shift();

      drawTrack();
      // trail
      for (let i = 0; i < trail.length; i++) {
        const p = trail[i];
        ctx.fillStyle = 'rgba(143,215,255,' + (i / trail.length) * 0.35 + ')';
        ctx.beginPath(); ctx.arc(X(p.x), Y(p.z), 3, 0, 7); ctx.fill();
      }
      // car
      ctx.save();
      ctx.translate(X(s.x), Y(s.z)); ctx.rotate(-s.h);
      ctx.shadowColor = '#35e0ff'; ctx.shadowBlur = 14;
      ctx.fillStyle = '#8fd7ff';
      ctx.fillRect(-5, -9, 10, 18);
      ctx.restore();

      $('hud').textContent = (g.name || 'RACER') + '  ·  ' + t.toFixed(1) + 's / ' + lastT.toFixed(1) + 's';
      scrub.value = Math.round((t / lastT) * 1000);
      requestAnimationFrame(frame);
    }

    $('play').addEventListener('click', () => {
      if (t >= lastT) { t = 0; idx = 0; trail.length = 0; }
      playing = !playing; $('play').textContent = playing ? '⏸' : '▶';
    });
    $('spd').addEventListener('click', () => { speed = speed === 1 ? 2 : 1; $('spd').textContent = '×' + speed; });
    scrub.addEventListener('input', () => { t = (scrub.value / 1000) * lastT; idx = 0; trail.length = 0; });

    requestAnimationFrame(frame);
  }
})();
