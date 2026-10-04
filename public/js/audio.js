'use strict';
/* ============================================================================
   SRIDHAR RUSH — v173 centralized audio system (window.SRAudio).

   One AudioContext, one mixer, one place that knows about the twelve real
   racing samples in /assets/audio/. The rest of the client asks this module
   for sound; nothing else opens an AudioContext or creates a sample source.

   Design rules this file exists to enforce:
     - samples are decoded ONCE and cached (map keyed by asset name); a failed
       asset is remembered so it is not re-fetched in a loop;
     - every continuous sound (engine layers, boost, drift) is a small set of
       PERSISTENT looped sources whose gain/rate are automated. No node is ever
       created per animation frame;
     - edge-triggered sounds (nitro ignition, brake, crash, pass-by, countdown)
       are one-shots with rate limits, so a held key or a physics tick storm can
       never machine-gun them;
     - race.mp3 is STREAMED through an <audio> element (4 MB, 129 s - decoding
       it would cost ~45 MB of PCM); drift.mp3 is decoded (64 s bed, looped
       sample-accurately);
     - everything degrades: no AudioContext, a blocked autoplay, a 404 or a
       decode failure all leave the game fully playable, and the legacy
       oscillator sounds in game.js keep working as the fallback layer.

   Volume routing (master -> bus -> sound) is shared with the legacy synth
   audio, which connects to SRAudio.buses.sfx(), so the mixer sliders move both
   the samples and the old beeps and there is only one volume system.
   ========================================================================== */
(function (root) {
  if (!root) return;

  const BUILD = 'v174';

  /* ---------- the twelve real assets (local paths only, never a CDN) ------- */
  const MANIFEST = {
    music_race: '/assets/audio/race.mp3',
    engine_roar: '/assets/audio/engine_roar.mp3',
    engine_rev: '/assets/audio/engine_rev.mp3',
    engine_accel: '/assets/audio/engine_acceleration.mp3',
    nitro: '/assets/audio/nitro.mp3',
    boost: '/assets/audio/speed_boost.mp3',
    drift: '/assets/audio/drift.mp3',
    brake: '/assets/audio/brake.mp3',
    crash_1: '/assets/audio/crash_01.mp3',
    crash_2: '/assets/audio/crash_02.mp3',
    pass_by: '/assets/audio/pass_by.mp3',
    race_start: '/assets/audio/race_start.mp3'
  };

  /* ---------- loop regions measured from the files themselves --------------
     speed_boost.mp3 is 1.800 s with 60 ms of lead-in and ~490 ms of decayed
     tail; looping the whole file would drop out every 1.8 s, so the loop runs
     0.07 -> 1.28 s where the boost texture is steady.
     engine_roar.mp3 (4.101 s) and engine_rev.mp3 (3.082 s) are one-shot revs
     that fade to silence at the end (roar: ~210 ms tail, rev: ~370 ms), so the
     loops cut before the fade instead of replaying the hole.
     engine_acceleration.mp3 is a 28.56 s evolving layer, drift.mp3 a 64.8 s
     skid bed - both trimmed only to skip lead-in/lead-out.
     race.mp3 is streamed and wrapped by hand at 127.5 s, before its 1.79 s
     faded outro, so a race never runs into silence.                           */
  const LOOPS = {
    engine_roar: { start: 0.10, end: 3.30 },
    engine_rev: { start: 0.20, end: 2.55 },
    engine_accel: { start: 0.08, end: 28.30 },
    boost: { start: 0.05, end: 0.95 },
    drift: { start: 0.45, end: 64.10 },
    music_race: { start: 0.02, end: 125.00 }
  };

  /* Crossfade applied when a loop is built in memory (never to the file):
     several of these samples are swells that fade away, so a plain loop would
     either click at the seam or drop into the decayed tail. The first N ms of
     the loop are blended with the material that follows the loop's end, which
     makes the wrap continuous. drift.mp3 is left alone on purpose - it is a
     12 MB decode and an evolving noise bed whose two ends already sit within
     0.56x of each other. */
  const XFADE = { engine_roar: 0.03, engine_rev: 0.03, engine_accel: 0.05, boost: 0.02 };

  /* start offset per one-shot: skips the measured silence at the head of the
     file so the transient lands on the frame the event happened.             */
  const TRIMS = {
    nitro: { offset: 0.02, gain: 0.85 },
    boost: { offset: 0.07, gain: 0.75 },
    brake: { offset: 0.12, gain: 1.60 },     // brake.mp3 peaks at 0.31 - quiet by design
    crash_1: { offset: 0.04, gain: 0.95 },
    crash_2: { offset: 0.05, gain: 0.95 },
    pass_by: { offset: 0.16, gain: 0.90 },
    race_start: { offset: 0.00, gain: 1.00 },
    music_race: { gain: 0.55 }
  };

  const COUNT_GO_AT = 3.02;        // measured 4th onset of race_start.mp3 - the "GO!"
  const TUNING = {
    crashMinStrength: 0.12,        // below this the collision is noise, not a crash
    crashMinGapMs: 90,             // hard anti-machine-gun gap between any two crashes
    crashRemoteGain: 0.42,         // a rival's crash is background, mine is the event
    crashFadeDistance: 140,        // metres at which a remote crash is inaudible
    passByCooldownMs: 2500,
    brakeCooldownMs: 800,
    brakeMinAmount: 0.45
  };

  const noop = function () {};
  const nowMs = function () {
    if (root.performance && typeof root.performance.now === 'function') return root.performance.now();
    return Date.now();
  };
  const clamp01 = function (v) { return v > 0 ? (v < 1 ? v : 1) : 0; };
  const num = function (v, d) { const n = Number(v); return isFinite(n) ? n : d; };
  const clampVol = function (v, d) {
    const n = Number(v);
    if (!isFinite(n)) return d;
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  /* ------------------------------------------------------------------------
     State
     ------------------------------------------------------------------------ */
  let ctx = null;
  let masterGain = null, sfxBus = null, musicBus = null, comp = null;
  let masterVol = 1, musicVol = 0.7, sfxVol = 1, muted = false;
  let musicScale = 0.55;           // bus trim so music sits under the engine
  let sfxScale = 1.0;

  const buffers = Object.create(null);      // name -> AudioBuffer
  const failures = Object.create(null);     // name -> true (do not retry forever)
  const pending = Object.create(null);      // name -> Promise
  const loops = Object.create(null);        // key  -> { src, gain, name, ... }
  const active = [];                        // live one-shot sources (bounded, cleaned on ended)

  let prefsAdapter = null;
  let gesturesBound = false;
  let visibilityBound = false;
  let pendingResume = false;                // a play() was rejected - retry on gesture

  const stats = {
    contexts: 0, decodes: 0, decodesFailed: 0, fetches: 0,
    oneShots: 0, loopsCreated: 0, duplicatePrevented: 0, blocked: 0
  };

  /* ------------------------------------------------------------------------
     Context + mixer
     ------------------------------------------------------------------------ */
  function ensure() {
    if (ctx) return ctx;
    const Ctor = root.AudioContext || root.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch (e) { ctx = null; return null; }
    stats.contexts++;
    try {
      const dst = ctx.destination;
      comp = ctx.createDynamicsCompressor();
      if (comp.threshold) comp.threshold.value = -14;
      if (comp.ratio) comp.ratio.value = 5;
      masterGain = ctx.createGain();
      sfxBus = ctx.createGain();
      musicBus = ctx.createGain();
      sfxBus.connect(masterGain);
      musicBus.connect(masterGain);
      masterGain.connect(comp);
      comp.connect(dst);
      applyVolumes();
      bindGestures();
      bindVisibility();
    } catch (e) { /* a half-built context is still better than a throw */ }
    return ctx;
  }

  function available() { return !!(ctx && ctx.state !== 'closed'); }

  function applyVolumes() {
    const m = muted ? 0 : masterVol;
    if (masterGain) masterGain.gain.value = m;
    if (sfxBus) sfxBus.gain.value = sfxVol * sfxScale;
    if (musicBus) musicBus.gain.value = musicVol * musicScale;
    if (musicEl && !mediaAttached) musicEl.volume = clamp01(m * musicVol * musicScale);
  }

  function setVolumes(v) {
    if (v && typeof v === 'object') {
      if (v.master != null) masterVol = clamp01(clampVol(v.master, 100) / 100);
      if (v.music != null) musicVol = clamp01(clampVol(v.music, 70) / 100);
      if (v.sfx != null) sfxVol = clamp01(clampVol(v.sfx, 100) / 100);
    }
    applyVolumes();
    return getVolumes();
  }
  function getVolumes() {
    return {
      master: Math.round(masterVol * 100),
      music: Math.round(musicVol * 100),
      sfx: Math.round(sfxVol * 100),
      muted: muted
    };
  }
  function setMuted(on) { muted = !!on; applyVolumes(); return muted; }

  /* The game's own preference store (localStorage sr_prefs) stays the single
     source of truth: this module only reads/writes through the adapter.      */
  function attachPrefs(adapter) {
    prefsAdapter = adapter || null;
    if (prefsAdapter && typeof prefsAdapter.read === 'function') {
      const p = prefsAdapter.read() || {};
      setVolumes({ master: p.volMaster, music: p.volMusic, sfx: p.volSfx });
      muted = !!p.mute;
      applyVolumes();
    }
    return getVolumes();
  }
  function persist() {
    if (!prefsAdapter || typeof prefsAdapter.write !== 'function') return;
    try { prefsAdapter.write(getVolumes()); } catch (e) {}
  }

  /* ------------------------------------------------------------------------
     Loading + decoding (once per asset, cached, failures remembered)
     ------------------------------------------------------------------------ */
  function load(name) {
    if (buffers[name]) return Promise.resolve(buffers[name]);
    if (failures[name]) return Promise.resolve(null);
    if (pending[name]) return pending[name];
    const url = MANIFEST[name];
    if (!url || !ensure()) return Promise.resolve(null);
    const fetcher = root.fetch;
    if (typeof fetcher !== 'function') { failures[name] = true; return Promise.resolve(null); }

    stats.fetches++;
    pending[name] = fetcher(url, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('http ' + (res && res.status));
        if (typeof res.arrayBuffer !== 'function') throw new Error('no arrayBuffer');
        return res.arrayBuffer();
      })
      .then(function (ab) { return decode(ab); })
      .then(function (buf) {
        if (!buf || !buf.duration) throw new Error('empty buffer');
        buffers[name] = buf;
        stats.decodes++;
        delete pending[name];
        return buf;
      })
      .catch(function () {
        stats.decodesFailed++;
        failures[name] = true;
        delete pending[name];
        return null;
      });
    return pending[name];
  }

  function decode(arrayBuffer) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const ok = function (b) { if (!settled) { settled = true; resolve(b); } };
      const bad = function (e) { if (!settled) { settled = true; reject(e || new Error('decode')); } };
      try {
        const p = ctx.decodeAudioData(arrayBuffer, ok, bad);
        if (p && typeof p.then === 'function') p.then(ok, bad);
      } catch (e) { bad(e); }
    });
  }

  function preload(list) {
    const names = Array.isArray(list) ? list : Object.keys(MANIFEST);
    const jobs = [];
    for (let i = 0; i < names.length; i++) jobs.push(load(names[i]));
    return Promise.all(jobs).catch(function () { return []; });
  }

  function buffer(name) { return buffers[name] || null; }

  /* 'ready' | 'pending' | 'failed' — callers use this to decide whether they
     still need their legacy fallback sound (a failed asset never comes back). */
  function sampleState(name) {
    if (buffers[name]) return 'ready';
    if (failures[name]) return 'failed';
    return 'pending';
  }

  /* ------------------------------------------------------------------------
     One-shots
     ------------------------------------------------------------------------ */
  function playBuffer(name, opts) {
    const o = opts || {};
    const buf = buffers[name];
    if (!buf || !ctx) return null;
    if (ctx.state === 'suspended') { resumeSoon(); return null; }
    const trim = TRIMS[name] || {};
    let src = null, gain = null, pan = null;
    try {
      src = ctx.createBufferSource();
      src.buffer = buf;
      const off = num(o.offset, trim.offset || 0);
      const rate = Math.max(0.25, Math.min(4, num(o.rate, 1)));
      src.playbackRate.value = rate;
      if (o.loop) {
        const L = o.loop === true ? null : o.loop;
        src.loop = true;
        if (L) { src.loopStart = L.start; src.loopEnd = L.end; }
      }
      gain = ctx.createGain();
      const g = clamp01(num(o.gain, 1)) * (trim.gain != null ? trim.gain : 1);
      gain.gain.value = g;
      let tail = gain;
      if (o.pan && typeof ctx.createStereoPanner === 'function') {
        pan = ctx.createStereoPanner();
        pan.pan.value = Math.max(-1, Math.min(1, num(o.pan, 0)));
        gain.connect(pan);
        tail = pan;
      }
      tail.connect(o.bus || sfxBus);
      src.connect(gain);
      const startedAt = ctx.currentTime;
      src.start(startedAt, Math.max(0, Math.min(off, Math.max(0, buf.duration - 0.01))));
      if (!o.loop && o.duration) src.stop(startedAt + o.duration);
      stats.oneShots++;
      const rec = { src: src, gain: gain };
      active.push(rec);
      if (active.length > 48) { const old = active.shift(); try { old.src.stop(); } catch (e) {} }
      src.onended = function () {
        try { src.disconnect(); } catch (e) {}
        try { gain.disconnect(); } catch (e) {}
        if (pan) { try { pan.disconnect(); } catch (e) {} }
        const i = active.indexOf(rec);
        if (i >= 0) active.splice(i, 1);
      };
    } catch (e) {
      try { if (src) src.disconnect(); } catch (e2) {}
      try { if (gain) gain.disconnect(); } catch (e2) {}
      return null;
    }
    return src;
  }

  /* Build the in-memory, seam-blended loop for an asset (once). Returns the raw
     decoded buffer when there is nothing to blend or anything goes wrong. */
  const loopBuffers = Object.create(null);
  function loopBuffer(name) {
    if (loopBuffers[name]) return loopBuffers[name];
    const src = buffers[name];
    const L = LOOPS[name];
    if (!src || !L || !ctx || typeof ctx.createBuffer !== 'function' || typeof src.getChannelData !== 'function') return null;
    const xf = Math.round((XFADE[name] || 0) * src.sampleRate);
    if (xf <= 0) return null;                       // nothing to blend: use the raw region
    try {
      const s0 = Math.round(L.start * src.sampleRate);
      const s1 = Math.round(L.end * src.sampleRate);
      const len = s1 - s0 - xf;
      if (len <= xf * 2) return null;
      const out = ctx.createBuffer(src.numberOfChannels, len, src.sampleRate);
      for (let c = 0; c < src.numberOfChannels; c++) {
        const inD = src.getChannelData(c), outD = out.getChannelData(c);
        for (let i = 0; i < len; i++) outD[i] = inD[s0 + i];
        for (let i = 0; i < xf; i++) {
          const w = i / xf;                      // 0 at the seam, 1 after the fade
          outD[i] = inD[s0 + i] * w + inD[s0 + len + i] * (1 - w);
        }
      }
      try { out.__asset = name; } catch (e) {}   // lets callers/tests see which asset a loop came from
      loopBuffers[name] = out;
      return out;
    } catch (e) { return null; }
  }

  /* persistent looped source, at most ONE per key, created on first use */
  function ensureLoop(key, name, opts) {
    const existing = loops[key];
    if (existing && existing.alive) { stats.duplicatePrevented++; return existing; }
    if (!ctx) return null;
    const o = opts || {};
    const L = o.loop || LOOPS[name] || null;
    const blended = o.loop ? null : loopBuffer(name);
    const buf = blended || buffers[name];
    if (!buf) return null;
    const wholeBufferLoop = !!blended;              // the seam already lives inside it
    let src = null, gain = null;
    try {
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      if (wholeBufferLoop) { src.loopStart = 0; src.loopEnd = buf.duration; }
      else if (L) { src.loopStart = L.start; src.loopEnd = L.end; }
      src.playbackRate.value = num(o.rate, 1);
      gain = ctx.createGain();
      gain.gain.value = 0;
      const tail = o.target || sfxBus;
      src.connect(gain);
      gain.connect(tail);
      try { src.start(0, wholeBufferLoop ? 0 : (L ? L.start : 0)); } catch (e) { src.start(0); }
      const rec = { src: src, gain: gain, name: name, key: key, alive: true, level: 0, rate: num(o.rate, 1), bus: tail };
      loops[key] = rec;
      stats.loopsCreated++;
      return rec;
    } catch (e) {
      try { if (src) src.disconnect(); } catch (e2) {}
      try { if (gain) gain.disconnect(); } catch (e2) {}
      return null;
    }
  }

  function setLoopLevel(rec, level, tau) {
    if (!rec || !rec.alive) return;
    const v = clamp01(level);
    rec.level = v;
    try { rec.gain.gain.setTargetAtTime(v, ctx.currentTime, tau || 0.05); }
    catch (e) { rec.gain.gain.value = v; }
  }
  function setLoopRate(rec, rate) {
    if (!rec || !rec.alive || !ctx) return;
    const r = Math.max(0.25, Math.min(4, rate));
    try { rec.src.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.08); }
    catch (e) { rec.src.playbackRate.value = r; }
  }
  function killLoop(key) {
    const rec = loops[key];
    if (!rec) return;
    rec.alive = false;
    try { rec.src.stop(); } catch (e) {}
    try { rec.src.disconnect(); } catch (e) {}
    try { rec.gain.disconnect(); } catch (e) {}
    delete loops[key];
  }

  /* ------------------------------------------------------------------------
     Engine — three sample layers driven by one car's live state
       roar  : idle / low speed presence
       accel : throttle and mid-range pull
       rev   : high-rpm top end
     ------------------------------------------------------------------------ */
  const ENGINE_PRELOAD = ['engine_roar', 'engine_accel', 'engine_rev'];
  const engine = {
    _want: false,
    _on: false,
    _speed: 0, _rpm: 0, _throttle: 0, _nitro: false,

    update: function (speed01, rpm01, throttle01, nitroOn) {
      this._write(speed01, rpm01, throttle01, nitroOn);
      const live = available() && this._want;
      if (!live) { this._silence(); this._on = false; return; }
      if (!this._ensureLayers()) { this._on = false; return; }
      this._on = true;
      const t = ctx.currentTime;
      const sp = clamp01(speed01), rpm = clamp01(rpm01), th = clamp01(throttle01);
      const idle = clamp01(1 - sp * 2.1);
      const top = clamp01((rpm - 0.42) / 0.58);
      const nitroLift = this._nitro ? 0.10 : 0;

      const gIdle = 0.34 * (0.55 + 0.45 * idle) + 0.10 * (1 - th);
      const gAccel = 0.16 + 0.62 * th * (0.30 + 0.70 * sp);
      const gRev = 0.44 * top + nitroLift;

      const lr = gIdle, la = gAccel, lv = gRev;
      ramp(loops.eng_idle, lr, t);
      ramp(loops.eng_accel, la, t);
      ramp(loops.eng_rev, lv, t);
      setLoopRate(loops.eng_idle, 0.72 + 0.50 * rpm);
      setLoopRate(loops.eng_accel, 0.85 + 0.42 * rpm + (this._nitro ? 0.06 : 0));
      setLoopRate(loops.eng_rev, 0.92 + 0.46 * rpm);
    },
    _write: function (speed01, rpm01, throttle01, nitroOn) {
      this._speed = clamp01(speed01); this._rpm = clamp01(rpm01);
      this._throttle = clamp01(throttle01); this._nitro = !!nitroOn;
    },
    /* partial loads are fine: whatever arrived plays, and if nothing did the
       legacy synth engine stays the sound (see sampleActive()) */
    _ensureLayers: function () {
      if (buffers.engine_roar) ensureLoop('eng_idle', 'engine_roar');
      if (buffers.engine_accel) ensureLoop('eng_accel', 'engine_accel');
      if (buffers.engine_rev) ensureLoop('eng_rev', 'engine_rev');
      return !!(loops.eng_idle || loops.eng_accel || loops.eng_rev);
    },
    /* true when the real samples are the sound you hear (so the legacy synth
       engine must stay silent for this car) */
    sampleActive: function () { return !!(this._on && (loops.eng_idle || loops.eng_accel || loops.eng_rev)); },
    setActive: function (on) { this._want = !!on; },
    _silence: function () {
      if (!ctx) return;
      const t = ctx.currentTime;
      ramp(loops.eng_idle, 0, t); ramp(loops.eng_accel, 0, t); ramp(loops.eng_rev, 0, t);
    },
    stop: function () {
      this._want = false;
      killLoop('eng_idle'); killLoop('eng_accel'); killLoop('eng_rev');
      this._on = false;
    },
    /* keyboard/controller input is 0..1; the sim reports speed and throttle */
    state: function () {
      return { speed: this._speed, rpm: this._rpm, throttle: this._throttle, nitro: this._nitro, on: this._on };
    }
  };
  function ramp(rec, level, t) {
    if (!rec || !rec.alive) return;
    const v = clamp01(level);
    try { rec.gain.gain.setTargetAtTime(v, t, 0.045); } catch (e) { rec.gain.gain.value = v; }
  }

  /* ------------------------------------------------------------------------
     Nitro / boost
       nitro.mp3  : ignition, ONE per activation edge
       speed_boost: sustained layer, loops inside its steady region
     ------------------------------------------------------------------------ */
  const nitro = {
    _on: false,
    _edges: 0,
    set: function (on) {
      const want = !!on;
      if (want === this._on) {
        /* still sustained: keep the loop alive but never re-fire the ignition */
        if (want) this._sustain();
        return false;
      }
      this._on = want;
      if (want) {
        this._edges++;
        playBuffer('nitro', { gain: 0.9 });
        load('boost').then(function () {
          if (nitro._on) { ensureLoop('boost', 'boost'); setLoopLevel(loops.boost, 1, 0.03); }
        });
        this._sustain();
      } else {
        /* stop immediately: a 60 ms ramp is the shortest click-free stop */
        if (loops.boost) { setLoopLevel(loops.boost, 0, 0.02); setTimeout(function () { if (!nitro._on) killLoop('boost'); }, 140); }
      }
      return want;
    },
    _sustain: function () {
      if (!loops.boost) { ensureLoop('boost', 'boost'); setLoopLevel(loops.boost, 1, 0.03); }
    },
    active: function () { return this._on; },
    edges: function () { return this._edges; },
    stop: function () { this._on = false; killLoop('boost'); }
  };

  /* ------------------------------------------------------------------------
     Drift — one looped bed whose level is the slip intensity
     ------------------------------------------------------------------------ */
  const drift = {
    _level: 0,
    _fadeTimer: null,
    _arming: false,
    _pendingStop: null,
    set: function (intensity01) {
      const v = clamp01(intensity01);
      this._level = v;
      if (!available()) return;
      if (v <= 0.001) { this._release(); return; }
      if (loops.drift) {
        /* steady state: automation only, no allocation, no new nodes */
        setLoopLevel(loops.drift, 0.12 + 0.88 * v, 0.08);
        setLoopRate(loops.drift, 0.88 + 0.24 * v);
        return;
      }
      if (this._arming) return;
      this._arming = true;
      load('drift').then(function () {
        drift._arming = false;
        if (drift._level <= 0.001) return;
        if (!loops.drift) ensureLoop('drift', 'drift');
        setLoopLevel(loops.drift, 0.12 + 0.88 * drift._level, 0.08);
        setLoopRate(loops.drift, 0.88 + 0.24 * drift._level);
      });
    },
    _release: function () {
      if (!loops.drift) return;
      setLoopLevel(loops.drift, 0, 0.10);
      if (this._fadeTimer) clearTimeout(this._fadeTimer);
      this._fadeTimer = setTimeout(function () { if (drift._level <= 0.001) killLoop('drift'); }, 400);
    },
    level: function () { return this._level; },
    sampleActive: function () { return !!(loops.drift && loops.drift.level > 0.001); },
    stop: function () { this._level = 0; killLoop('drift'); }
  };

  /* ------------------------------------------------------------------------
     Brake — edge triggered, refractory, needs meaningful braking
     ------------------------------------------------------------------------ */
  const brake = {
    _down: false,
    _lastMs: -1e9,
    _fires: 0,
    trigger: function (amount) {
      const a = clamp01(amount);
      const meaningful = a >= TUNING.brakeMinAmount;
      const t = nowMs();
      if (!meaningful) { this._down = false; return false; }
      const isEdge = !this._down;
      this._down = true;
      if (!isEdge) return false;                                   // held: never repeats
      if (t - this._lastMs < TUNING.brakeCooldownMs) return false;  // pump-safe
      this._lastMs = t;
      this._fires++;
      load('brake').then(function () { if (brake._down) playBuffer('brake', { gain: 0.9 }); });
      return true;
    },
    release: function () { this._down = false; },
    fires: function () { return this._fires; },
    isDown: function () { return this._down; }
  };

  /* ------------------------------------------------------------------------
     Crash — alternate the two takes, rate limit, local is loud
     ------------------------------------------------------------------------ */
  const crash = {
    _next: 0,
    _lastMs: -1e9,
    _plays: 0,
    _ignored: 0,
    play: function (strength, opts) {
      const o = opts || {};
      const s = num(strength, 0);
      if (s < TUNING.crashMinStrength) { this._ignored++; return false; }
      const t = nowMs();
      if (t - this._lastMs < TUNING.crashMinGapMs) { this._ignored++; return false; }
      this._lastMs = t;
      const name = this._next === 0 ? 'crash_1' : 'crash_2';
      if (sampleState(name) === 'failed') { this._ignored++; return false; }  // caller falls back
      this._next = 1 - this._next;
      let gain = 0.35 + 0.65 * clamp01(s);
      let pan = 0;
      if (o.local) {
        gain = Math.min(1, gain * 1.15);
      } else {
        const d = Math.max(0, num(o.distance, 0));
        const atten = clamp01(1 - d / TUNING.crashFadeDistance);
        pan = Math.max(-0.85, Math.min(0.85, num(o.pan, 0)));
        gain *= TUNING.crashRemoteGain * atten;
      }
      if (gain <= 0.02) { this._ignored++; return false; }
      this._plays++;
      load(name).then(function () { playBuffer(name, { gain: gain, pan: pan }); });
      return true;
    },
    plays: function () { return this._plays; },
    ignored: function () { return this._ignored; },
    _reset: function () { this._lastMs = -1e9; }
  };

  /* ------------------------------------------------------------------------
     Opponent pass-by — cooldown lives here, the caller supplies the geometry
     ------------------------------------------------------------------------ */
  const passBy = {
    _lastMs: -1e9,
    _plays: 0,
    play: function (opts) {
      const o = opts || {};
      const t = nowMs();
      if (t - this._lastMs < TUNING.passByCooldownMs) return false;
      this._lastMs = t;
      this._plays++;
      load('pass_by').then(function () {
        playBuffer('pass_by', { gain: num(o.volume, 0.8), pan: num(o.pan, 0), rate: num(o.rate, 1) });
      });
      return true;
    },
    plays: function () { return this._plays; },
    ready: function () { return nowMs() - this._lastMs >= TUNING.passByCooldownMs; }
  };

  /* ------------------------------------------------------------------------
     Countdown — race_start.mp3 owns the 3-2-1-GO
       begin() runs BEFORE the first "3" is announced. It claims the countdown
       synchronously, so game.js never emits a synthetic 440 Hz tick that the
       real sample would then talk over. If BOTH the buffer and its load fail,
       ownership is handed back and the synth ticks resume.
     ------------------------------------------------------------------------ */
  const countdown = {
    _owned: false,
    _t0: 0,
    _src: null,
    _startedCount: 0,
    begin: function () {
      this.end();
      if (!ensure()) return false;
      resumeSoon();                                     // a race start is a user gesture in practice
      if (failures.race_start) return false;
      this._owned = true;
      this._t0 = nowMs();
      if (!buffers.race_start) { load('race_start').then(function () { countdown._start(); }); return true; }
      this._start();
      return true;
    },
    _start: function () {
      if (!this._owned || this._startedCount > 0) return;
      const buf = buffers.race_start;
      if (!buf || !buf.duration) {
        if (failures.race_start) { this._owned = false; return; }   // asset is gone → synth ticks
        return;
      }
      const elapsed = Math.max(0, (nowMs() - this._t0) / 1000);
      /* start late = start further in, so the sample's own "GO!" (3.02 s) still
         lands on the same wall-clock instant as the server's go event */
      const off = elapsed > 0.35 ? Math.min(elapsed, COUNT_GO_AT - 0.05) : 0;
      this._startedCount++;
      this._src = playBuffer('race_start', { offset: off, gain: 1, duration: Math.max(0.2, buf.duration - off) });
    },
    owned: function () { return this._owned; },
    active: function () { return !!(this._owned && this._startedCount > 0 && this._src); },
    end: function () {
      this._owned = false;
      this._startedCount = 0;
      if (this._src) { try { this._src.stop(); } catch (e) {} try { this._src.disconnect(); } catch (e) {} this._src = null; }
    },
    started: function () { return this._startedCount; }
  };

  /* ------------------------------------------------------------------------
     Music — race.mp3, streamed, hand-wrapped before its faded outro
     ------------------------------------------------------------------------ */
  let musicEl = null;
  let mediaAttached = false;
  let mediaNode = null;
  let musicWanted = false;
  let musicSeam = false;

  function ensureMusicEl() {
    if (musicEl) return musicEl;
    let el = null;
    try {
      if (typeof root.Audio === 'function') el = new root.Audio();
      else if (root.document && root.document.createElement) el = root.document.createElement('audio');
    } catch (e) { el = null; }
    if (!el) return null;
    el.src = MANIFEST.music_race;
    el.loop = false;                    // wrapped by hand at LOOPS.music_race.end
    el.preload = 'none';                // streamed: never decode this 4 MB track
    try { el.setAttribute('playsinline', ''); } catch (e) {}
    musicEl = el;
    attachMedia();
    applyVolumes();
    return el;
  }

  function attachMedia() {
    if (!musicEl || mediaAttached || !ctx) return;
    if (typeof ctx.createMediaElementSource !== 'function') return;
    try {
      mediaNode = ctx.createMediaElementSource(musicEl);
      mediaNode.connect(musicBus);
      mediaAttached = true;
      applyVolumes();
    } catch (e) { mediaNode = null; mediaAttached = false; }
  }

  const music = {
    play: function (track) {
      if (track && track !== 'race') return false;
      ensure();
      const el = ensureMusicEl();
      if (!el) return false;
      attachMedia();
      if (!ctx) return false;
      musicWanted = true;
      if (ctx.state === 'suspended') resumeSoon();
      try {
        const p = el.play();
        if (p && typeof p.catch === 'function') {
          p.catch(function () { pendingResume = true; stats.blocked++; });
        }
      } catch (e) { pendingResume = true; stats.blocked++; }
      return true;
    },
    stop: function (opts) {
      musicWanted = false;
      const o = opts || {};
      const fade = num(o.fade, 0.6);
      const el = musicEl;
      if (!el) return;
      if (mediaAttached && musicBus) {
        const t = ctx.currentTime;
        try {
          musicBus.gain.cancelScheduledValues(t);
          musicBus.gain.setValueAtTime(musicBus.gain.value, t);
          musicBus.gain.linearRampToValueAtTime(0, t + fade);
          musicBus.gain.setTargetAtTime(musicVol * musicScale, t + fade + 0.05, 0.2);
          setTimeout(function () { if (!musicWanted) { try { el.pause(); } catch (e) {} } }, fade * 1000 + 120);
          return;
        } catch (e) { /* fall through to the hard stop */ }
      }
      try { el.pause(); } catch (e) {}
    },
    playing: function () { return !!(musicEl && !musicEl.paused && musicWanted); },
    element: function () { return musicEl; },
    /* called from the frame loop: one comparison, no allocation */
    tick: function () {
      const el = musicEl;
      if (!el || !musicWanted || el.paused || !el.duration) return;
      const L = LOOPS.music_race;
      if (!musicSeam && el.currentTime >= L.end) {
        musicSeam = true;
        /* one short dip across the seek: the track is streamed, so the wrap is a
           seek rather than a sample-accurate loop, and this hides the seam */
        try { musicBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.012); } catch (e) {}
        try { el.currentTime = L.start; } catch (e) {}
        setTimeout(function () {
          musicSeam = false;
          if (ctx && musicBus) { try { musicBus.gain.setTargetAtTime(musicVol * musicScale, ctx.currentTime, 0.05); } catch (e) {} }
        }, 110);
      }
    },
    wanted: function () { return musicWanted; }
  };

  /* ------------------------------------------------------------------------
     Autoplay / visibility
     ------------------------------------------------------------------------ */
  function bindGestures() {
    if (gesturesBound || !root.addEventListener) return;
    gesturesBound = true;
    const onGesture = function () { unlock(); };
    try {
      root.addEventListener('pointerdown', onGesture, { passive: true });
      root.addEventListener('keydown', onGesture, { passive: true });
      root.addEventListener('touchstart', onGesture, { passive: true });
    } catch (e) {
      root.addEventListener('pointerdown', onGesture);
      root.addEventListener('keydown', onGesture);
    }
  }

  function resumeSoon() {
    if (!ctx || ctx.state !== 'suspended') return;
    try { const p = ctx.resume(); if (p && p.catch) p.catch(noop); } catch (e) {}
  }

  function unlock() {
    ensure();
    if (!ctx) return false;
    if (ctx.state === 'suspended') resumeSoon();
    if (pendingResume && musicWanted) {
      pendingResume = false;
      music.play('race');
    }
    return true;
  }

  function bindVisibility() {
    if (visibilityBound || !root.document || !root.document.addEventListener) return;
    visibilityBound = true;
    root.document.addEventListener('visibilitychange', function () {
      if (!ctx) return;
      if (root.document.hidden) {
        try { const p = ctx.suspend(); if (p && p.catch) p.catch(noop); } catch (e) {}
        if (musicEl && musicWanted) { try { musicEl.pause(); } catch (e) {} }
      } else {
        resumeSoon();
        if (musicWanted && musicEl) {
          const p = musicEl.play();
          if (p && p.catch) p.catch(function () { pendingResume = true; stats.blocked++; });
        }
      }
    });
  }

  /* ------------------------------------------------------------------------
     Frame hook — the only per-frame call, and it is O(1)
     ------------------------------------------------------------------------ */
  function tick() {
    music.tick();
    if (musicEl && !mediaAttached) applyVolumes();
  }

  /* ------------------------------------------------------------------------
     Lifecycle
     ------------------------------------------------------------------------ */
  function dispose() {
    countdown.end();
    engine.stop();
    nitro.stop();
    drift.stop();
    const loopKeys = Object.keys(loops);
    for (let i = 0; i < loopKeys.length; i++) killLoop(loopKeys[i]);
    if (musicEl) { try { musicEl.pause(); } catch (e) {} try { musicEl.removeAttribute('src'); } catch (e) {} }
    musicWanted = false;
    for (let i = 0; i < active.length; i++) {
      try { active[i].src.stop(); } catch (e) {}
      try { active[i].src.disconnect(); } catch (e) {}
      try { active[i].gain.disconnect(); } catch (e) {}
    }
    active.length = 0;
    if (mediaNode) { try { mediaNode.disconnect(); } catch (e) {} mediaNode = null; }
    if (ctx) { try { const p = ctx.close(); if (p && p.catch) p.catch(noop); } catch (e) {} }
    ctx = null; masterGain = null; sfxBus = null; musicBus = null; comp = null;
    musicEl = null; mediaAttached = false;
    for (const k in buffers) delete buffers[k];
    for (const k in loopBuffers) delete loopBuffers[k];
    for (const k in failures) delete failures[k];
    for (const k in pending) delete pending[k];
    pendingResume = false;
  }

  const SRAudio = {
    version: BUILD,
    MANIFEST: MANIFEST,
    LOOPS: LOOPS,
    XFADE: XFADE,
    TRIMS: TRIMS,
    TUNING: TUNING,
    COUNT_GO_AT: COUNT_GO_AT,
    ensure: ensure,
    unlock: unlock,
    available: available,
    ctx: function () { return ctx; },
    buses: {
      master: function () { return masterGain; },
      sfx: function () { return sfxBus; },
      music: function () { return musicBus; }
    },
    setVolumes: setVolumes,
    getVolumes: getVolumes,
    setMuted: setMuted,
    attachPrefs: attachPrefs,
    persist: persist,
    preload: preload,
    load: load,
    buffer: buffer,
    sampleState: sampleState,
    play: playBuffer,
    engine: engine,
    nitro: nitro,
    drift: drift,
    brake: brake,
    crash: crash.play.bind(crash),
    crashState: crash,
    passBy: passBy.play.bind(passBy),
    passByState: passBy,
    countdown: countdown,
    music: music,
    tick: tick,
    resetCounters: function () {
      crash._lastMs = -1e9; passBy._lastMs = -1e9; brake._lastMs = -1e9;
      nitro._edges = 0; crash._plays = 0; crash._ignored = 0; passBy._plays = 0; brake._fires = 0;
    },
    stats: function () {
      return {
        contexts: stats.contexts, decodes: stats.decodes, decodesFailed: stats.decodesFailed,
        fetches: stats.fetches, oneShots: stats.oneShots, loopsCreated: stats.loopsCreated,
        duplicatePrevented: stats.duplicatePrevented, blocked: stats.blocked,
        loaded: Object.keys(buffers), failed: Object.keys(failures),
        activeOneShots: active.length, liveLoops: Object.keys(loops)
      };
    },
    dispose: dispose
  };

  /* legacy hook: game.js's synth music bed must follow the same music slider */
  Object.defineProperty(SRAudio, 'musicScale', {
    get: function () { return musicScale; },
    set: function (v) { musicScale = clamp01(num(v, 0.55)); applyVolumes(); }
  });

  root.SRAudio = SRAudio;
  if (typeof module !== 'undefined' && module.exports) module.exports = SRAudio;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
