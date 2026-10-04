'use strict';
/* ============================================================================
   v173 — the racing audio library.

   Everything here runs against a fake Web Audio graph that COUNTS what was
   created, because the promises the implementation makes are mostly about
   restraint: decode each sample once, create each loop once, never build a node
   per animation frame, never fire an edge sound twice, and fall back quietly
   when the browser has no audio at all. A fake graph is the only way to assert
   that (a real one would be silent either way).
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* the manifest key for each shipped file, so tests can find a decoded buffer by
   the same name the game asks for it ('' -> the fetch stub tags the buffer) */
const ASSET_BY_URL = {
  '/assets/audio/race.mp3': 'music_race',
  '/assets/audio/engine_roar.mp3': 'engine_roar',
  '/assets/audio/engine_rev.mp3': 'engine_rev',
  '/assets/audio/engine_acceleration.mp3': 'engine_accel',
  '/assets/audio/nitro.mp3': 'nitro',
  '/assets/audio/speed_boost.mp3': 'boost',
  '/assets/audio/drift.mp3': 'drift',
  '/assets/audio/brake.mp3': 'brake',
  '/assets/audio/crash_01.mp3': 'crash_1',
  '/assets/audio/crash_02.mp3': 'crash_2',
  '/assets/audio/pass_by.mp3': 'pass_by',
  '/assets/audio/race_start.mp3': 'race_start'
};
const AUDIO_DIR = path.join(ROOT, 'public', 'assets', 'audio');
const AUDIO_JS = path.join(ROOT, 'public', 'js', 'audio.js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* --------------------------------------------------------------------------
   The fake browser
   -------------------------------------------------------------------------- */
/* the fake decoded waveform: deterministic, so a blend can be verified by value */
const SAMPLE = (i) => Math.sin(i * 0.017) * 0.5;

function makeHarness(opts) {
  opts = opts || {};
  const graph = { created: {}, sources: [], started: [], decoded: [], fetches: [] };
  const bump = (t) => { graph.created[t] = (graph.created[t] || 0) + 1; };

  function param(v) {
    const p = {
      value: v || 0, events: [],
      setValueAtTime(x) { this.value = x; this.events.push(['set', x]); return this; },
      linearRampToValueAtTime(x) { this.value = x; this.events.push(['lin', x]); return this; },
      exponentialRampToValueAtTime(x) { this.value = x; this.events.push(['exp', x]); return this; },
      setTargetAtTime(x) { this.value = x; this.events.push(['target', x]); return this; },
      cancelScheduledValues() { this.events.push(['cancel']); return this; }
    };
    return p;
  }

  function node(type, extra) {
    bump(type);
    const n = Object.assign({
      __type: type, connected: [], disconnected: false,
      connect(d) { this.connected.push(d); return d; },
      disconnect() { this.disconnected = true; }
    }, extra || {});
    return n;
  }

  const ctx = {
    __fake: true,
    state: opts.suspended ? 'suspended' : 'running',
    currentTime: 0,
    sampleRate: 48000,
    destination: node('destination'),
    createGain() { return node('gain', { gain: param(1) }); },
    createDynamicsCompressor() { return node('compressor', { threshold: param(0), ratio: param(0), knee: param(0) }); },
    createStereoPanner() { return node('panner', { pan: param(0) }); },
    createBiquadFilter() { return node('filter', { frequency: param(0), Q: param(0), type: '' }); },
    createBufferSource() {
      const src = node('bufferSource', {
        buffer: null, loop: false, loopStart: 0, loopEnd: 0,
        playbackRate: param(1), onended: null, startedAt: null, stopped: false,
        start(t, off) { this.startedAt = t; graph.started.push({ src: this, offset: off || 0 }); },
        stop() { this.stopped = true; }
      });
      graph.sources.push(src);
      return src;
    },
    decodeAudioData(ab, ok, bad) {
      const name = ab && ab.__name;
      if (opts.decodeFails) { if (bad) bad(new Error('decode failed')); return Promise.reject(new Error('decode failed')); }
      graph.decoded.push(name);
      const dur = (opts.durations && opts.durations[name]) || 2.0;
      const trueLen = Math.round(dur * 44100);
      const dataLen = Math.min(trueLen, 6 * 44100);   // long beds do not need 12 MB of test data
      const chans = [];
      for (let c = 0; c < 2; c++) {
        const a = new Float32Array(dataLen);
        for (let i = 0; i < dataLen; i++) a[i] = SAMPLE(i);
        chans.push(a);
      }
      const buf = {
        duration: dur, sampleRate: 44100, numberOfChannels: 2, length: trueLen, __name: name,
        getChannelData(c) { return chans[c] || chans[0]; }
      };
      if (ok) ok(buf);
      return Promise.resolve(buf);
    },
    createBuffer(channels, length, sampleRate) {
      const data = [];
      for (let c = 0; c < channels; c++) data.push(new Float32Array(length));
      return {
        numberOfChannels: channels, length: length, sampleRate: sampleRate,
        duration: length / sampleRate, __name: 'loop',
        getChannelData(c) { return data[c] || data[0]; }
      };
    },
    resume() { this.state = 'running'; return Promise.resolve(); },
    suspend() { this.state = 'suspended'; return Promise.resolve(); },
    close() { this.state = 'closed'; return Promise.resolve(); }
  };
  if (opts.mediaElementSource !== false) ctx.createMediaElementSource = () => node('mediaElementSource');

  function FakeAudio() {
    const el = {
      src: '', loop: false, preload: '', volume: 1, paused: true, currentTime: 0, duration: 129.646,
      plays: 0, pauses: 0, attributes: {},
      setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; },
      play() {
        this.plays++;
        if (opts.playRejects) return Promise.reject(new Error('NotAllowedError'));
        this.paused = false;
        return Promise.resolve();
      },
      pause() { this.pauses++; this.paused = true; },
      addEventListener() {}, removeEventListener() {}
    };
    return el;
  }

  const listeners = {};
  const doc = {
    hidden: false,
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {},
    createElement(tag) { return tag === 'audio' ? new FakeAudio() : { setAttribute() {}, removeAttribute() {} }; },
    fire(t, ev) { (listeners[t] || []).forEach((f) => f(ev || {})); }
  };
  const win = {
    AudioContext: opts.noAudioContext ? undefined : function () { return ctx; },
    Audio: opts.noAudioElement ? undefined : FakeAudio,
    document: doc,
    performance: { now: () => Date.now() },
    addEventListener(t, f) { doc.addEventListener(t, f); },
    fetch: (url) => {
      graph.fetches.push(url);
      if (opts.fetchFails) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({
        ok: true, status: 200,
        arrayBuffer: () => Promise.resolve({ __name: ASSET_BY_URL[String(url)] || String(url), byteLength: 1024 })
      });
    }
  };
  win.window = win;
  return { ctx, win, doc, graph, listeners, FakeAudio, listenerCount: () => Object.keys(listeners).reduce((a, k) => a + listeners[k].length, 0) };
}

/* audio.js reads its platform from the global object (window, else globalThis),
   so each test installs a fresh fake there and re-requires the module: the
   manager keeps per-context state, and one test's graph must never leak into
   the next. */
function load(fake) {
  const keys = ['AudioContext', 'webkitAudioContext', 'Audio', 'document', 'performance', 'fetch', 'SRAudio', 'addEventListener'];
  const saved = {};
  for (const k of keys) saved[k] = globalThis[k];
  globalThis.window = fake.win;
  globalThis.AudioContext = fake.win.AudioContext;
  globalThis.Audio = fake.win.Audio;
  globalThis.document = fake.doc;
  globalThis.performance = fake.win.performance;
  globalThis.fetch = fake.win.fetch;
  globalThis.addEventListener = fake.win.addEventListener;
  delete require.cache[require.resolve(AUDIO_JS)];
  const mod = require(AUDIO_JS);
  return {
    SRAudio: mod,
    restore() {
      for (const k of keys) {
        if (saved[k] === undefined) delete globalThis[k];
        else globalThis[k] = saved[k];
      }
      delete globalThis.window;
      delete require.cache[require.resolve(AUDIO_JS)];
    }
  };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

/* a source's buffer is either the decoded asset or the seam-blended loop built
   from it - both know which asset they came from */
const srcOf = (fake, name) => fake.graph.sources.find((s) => s.buffer && (s.buffer.__asset === name || s.buffer.__name === name));
const allOf = (fake, name) => fake.graph.sources.filter((s) => s.buffer && (s.buffer.__asset === name || s.buffer.__name === name));

/* --------------------------------------------------------------------------
   1. Initialization
   -------------------------------------------------------------------------- */
test('v173 audio: initialises one context and one mixer, and re-ensuring is a no-op', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    assert.equal(SRAudio.ensure(), fake.ctx, 'ensure() returns the context');
    assert.ok(SRAudio.buses.master(), 'master bus exists');
    assert.ok(SRAudio.buses.sfx(), 'sfx bus exists');
    assert.ok(SRAudio.buses.music(), 'music bus exists');
    const gainsBefore = fake.graph.created.gain;
    assert.equal(SRAudio.ensure(), fake.ctx);
    SRAudio.ensure(); SRAudio.ensure();
    assert.equal(SRAudio.stats().contexts, 1, 'only one AudioContext is ever built');
    assert.equal(fake.graph.created.gain, gainsBefore, 're-ensuring builds no new nodes');
    // the audio library must ship the SAME build marker as the app that calls it
    const gameBuild = (read('public/js/game.js').match(/const BUILD = '(v\d+)'/) || [])[1];
    assert.equal(SRAudio.version, gameBuild);
  } finally { restore(); }
});

test('v173 audio: the buses are wired master -> compressor -> destination once', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    const master = SRAudio.buses.master();
    assert.equal(fake.graph.created.compressor, 1, 'exactly one compressor');
    assert.ok(master.connected.length === 1 && master.connected[0].__type === 'compressor',
      'master feeds the compressor');
    assert.ok(SRAudio.buses.sfx().connected[0] === master && SRAudio.buses.music().connected[0] === master,
      'both buses feed master');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   2. Manifest / paths / the real files
   -------------------------------------------------------------------------- */
test('v173 audio: the manifest names all twelve real assets at local paths', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    const expected = {
      music_race: 'race.mp3', engine_roar: 'engine_roar.mp3', engine_rev: 'engine_rev.mp3',
      engine_accel: 'engine_acceleration.mp3', nitro: 'nitro.mp3', boost: 'speed_boost.mp3',
      drift: 'drift.mp3', brake: 'brake.mp3', crash_1: 'crash_01.mp3', crash_2: 'crash_02.mp3',
      pass_by: 'pass_by.mp3', race_start: 'race_start.mp3'
    };
    const keys = Object.keys(SRAudio.MANIFEST);
    assert.equal(keys.length, 12, 'twelve entries');
    for (const [name, file] of Object.entries(expected)) {
      assert.equal(SRAudio.MANIFEST[name], '/assets/audio/' + file, name + ' path');
    }
    for (const p of Object.values(SRAudio.MANIFEST)) {
      assert.ok(p.startsWith('/assets/audio/'), 'local path only: ' + p);
      assert.ok(!/^https?:/i.test(p), 'no external URL: ' + p);
    }
  } finally { restore(); }
});

test('v173 audio: every file the manifest points at exists on disk (and nothing else is required)', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    for (const [name, url] of Object.entries(SRAudio.MANIFEST)) {
      const file = path.join(ROOT, 'public', url);
      assert.ok(fs.existsSync(file), name + ' -> ' + url + ' must exist');
      assert.ok(fs.statSync(file).size > 1000, name + ' is a real file, not a placeholder');
    }
    const onDisk = fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.mp3')).sort();
    assert.deepEqual(onDisk, ['brake.mp3', 'crash_01.mp3', 'crash_02.mp3', 'drift.mp3', 'engine_acceleration.mp3',
      'engine_rev.mp3', 'engine_roar.mp3', 'nitro.mp3', 'pass_by.mp3', 'race.mp3', 'race_start.mp3', 'speed_boost.mp3'],
      'the folder holds exactly the twelve shipped samples');
  } finally { restore(); }
});

test('v173 audio: loop regions were measured from the files (silent heads/tails skipped)', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    const L = SRAudio.LOOPS;
    // measured from the decoded files:
    //   speed_boost.mp3   1.800 s - audible 0.05..0.95, silence starts at 1.04
    //   engine_rev.mp3    3.082 s - audible to 2.55, 480 ms silent tail
    //   engine_roar.mp3   4.101 s - audible to 3.30, 340 ms silent tail
    //   race.mp3        129.646 s - level collapses at 126 s, silent from 126.5
    assert.ok(L.boost.start >= 0.04 && L.boost.end <= 0.98,
      'the boost loop stays inside the audible body and never reaches the 1.04 s silence');
    assert.ok(L.boost.end - L.boost.start >= 0.5, 'and is long enough not to sound like a buzz');
    assert.ok(L.engine_rev.end <= 2.6, 'the rev loop stops before its silent tail');
    assert.ok(L.engine_roar.end <= 3.35, 'the roar loop stops before its silent tail');
    assert.ok(L.music_race.end <= 125.5, 'music wraps while the track is still playing, not into the 4 s outro');
    assert.ok(L.music_race.start < 0.1);
    assert.ok(L.drift.start >= 0.4 && L.drift.end <= 64.2, 'the drift bed keeps its lead-in/tail out');
    assert.ok(L.engine_accel.end <= 28.4);
  } finally { restore(); }
});

test('v173 audio: decaying loops are seam-blended in memory, so the wrap has no click or gap', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['boost']);
    SRAudio.nitro.set(true);
    await tick(10);
    const src = srcOf(fake, 'boost');
    const L = SRAudio.LOOPS.boost;
    const xf = SRAudio.XFADE.boost;
    assert.ok(xf > 0, 'boost has a crossfade');
    assert.ok(Math.abs(src.buffer.duration - (L.end - L.start - xf)) < 0.01,
      'the loop body is shortened by exactly the crossfade length');
    assert.equal(src.loopStart, 0, 'the blended buffer loops whole');
    assert.ok(Math.abs(src.loopEnd - src.buffer.duration) < 1e-6);
    // the blend really blended: at i = 0 the crossfade weight is 0, so the first
    // sample IS the tail material (what played just before the wrap), not the head
    const xfSamples = Math.round(xf * 44100);
    const s0 = Math.round(L.start * 44100);
    const bodyLen = src.buffer.length;
    const data = src.buffer.getChannelData(0);
    assert.ok(data && data.length === bodyLen, 'a blended buffer was built');
    assert.ok(Math.abs(data[0] - SAMPLE(s0 + bodyLen)) < 1e-6, 'the seam starts on the tail material');
    const mid = Math.floor(xfSamples / 2), w = mid / xfSamples;
    const want = SAMPLE(s0 + mid) * w + SAMPLE(s0 + bodyLen + mid) * (1 - w);
    assert.ok(Math.abs(data[mid] - want) < 1e-6, 'and crossfades into the head across the fade');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   3. Volume controls + persistence
   -------------------------------------------------------------------------- */
test('v173 audio: volume controls clamp, apply to the buses, and report back', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    assert.deepEqual(SRAudio.setVolumes({ master: 150, music: -20, sfx: 42 }), { master: 100, music: 0, sfx: 42, muted: false });
    assert.equal(SRAudio.setVolumes({ master: 'banana' }).master, 100, 'garbage falls back to the default');
    assert.equal(SRAudio.setVolumes({ music: 70 }).music, 70);
    assert.equal(SRAudio.getVolumes().sfx, 42);
    assert.equal(SRAudio.buses.master().gain.value, 1, 'unmuted master is 1');
    SRAudio.setMuted(true);
    assert.equal(SRAudio.buses.master().gain.value, 0, 'mute zeroes the master');
    assert.equal(SRAudio.getVolumes().muted, true);
    SRAudio.setMuted(false);
    assert.equal(SRAudio.buses.master().gain.value, 1);
  } finally { restore(); }
});

test('v173 audio: the mixer volume scales the SFX bus, and the music bus sits below it', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    SRAudio.setVolumes({ master: 100, music: 70, sfx: 50 });
    assert.equal(SRAudio.buses.sfx().gain.value, 0.5);
    assert.ok(SRAudio.buses.music().gain.value < SRAudio.buses.sfx().gain.value,
      'music bus is trimmed under the SFX bus');
  } finally { restore(); }
});

test('v173 audio: prefs persistence goes through the game’s own store, never a second one', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    let store = { volMaster: 80, volMusic: 40, volSfx: 60, mute: true };
    SRAudio.attachPrefs({ read: () => store, write: (v) => { store = Object.assign({}, store, { volMaster: v.master, volMusic: v.music, volSfx: v.sfx }); } });
    assert.deepEqual(SRAudio.getVolumes(), { master: 80, music: 40, sfx: 60, muted: true }, 'reads the stored values on attach');
    SRAudio.setVolumes({ music: 90 });
    SRAudio.persist();
    assert.equal(store.volMusic, 90, 'persist() writes back through the adapter');
    assert.equal(store.volMaster, 80, 'untouched values survive the write');
    SRAudio.persist();
    assert.ok(true, 'persist() without throwing when there is no write path is fine too');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   4. Music (streamed, wrapped, one element)
   -------------------------------------------------------------------------- */
test('v173 audio: race music STREAMS from race.mp3 and is never decoded', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    assert.equal(SRAudio.music.play('race'), true);
    const el = SRAudio.music.element();
    assert.ok(el, 'a media element exists');
    assert.equal(el.src, '/assets/audio/race.mp3');
    assert.equal(el.preload, 'none', 'preload=none keeps the 4 MB track out of the decode path');
    assert.equal(el.plays, 1);
    await tick(10);
    assert.deepEqual(fake.graph.decoded, [], 'nothing was decoded for the music');
    assert.equal(SRAudio.buffer('music_race'), null);
  } finally { restore(); }
});

test('v173 audio: music start/stop keeps exactly one element and reports state', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    SRAudio.music.play('race');
    const first = SRAudio.music.element();
    SRAudio.music.play('race');
    SRAudio.music.play('race');
    assert.equal(SRAudio.music.element(), first, 'never a second element');
    assert.equal(first.plays, 3, 'the same element is resumed, not duplicated');
    assert.equal(SRAudio.music.playing(), true);
    assert.equal(SRAudio.music.wanted(), true);
    SRAudio.music.stop({ fade: 0 });
    await tick(160);
    assert.equal(first.paused, true, 'stop() pauses it');
    assert.equal(SRAudio.music.playing(), false);
    assert.equal(SRAudio.music.wanted(), false);
  } finally { restore(); }
});

test('v173 audio: the music loop wraps before the track’s faded outro, once, on time', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    SRAudio.music.play('race');
    const el = SRAudio.music.element();
    el.paused = false;
    el.duration = 129.646;
    el.currentTime = SRAudio.LOOPS.music_race.end - 5;
    SRAudio.tick();
    assert.ok(el.currentTime < SRAudio.LOOPS.music_race.end, 'not wrapped early');
    el.currentTime = SRAudio.LOOPS.music_race.end + 0.1;
    SRAudio.tick();
    assert.equal(el.currentTime, SRAudio.LOOPS.music_race.start, 'wrapped to the loop start');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   5. Engine
   -------------------------------------------------------------------------- */
test('v173 audio: the engine builds its three layers once and only automates afterwards', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['engine_roar', 'engine_rev', 'engine_accel']);
    SRAudio.engine.setActive(true);
    SRAudio.engine.update(0, 0, 0, false);
    const afterFirst = fake.graph.created.bufferSource;
    assert.equal(afterFirst, 3, 'one looped source per engine layer');
    for (let i = 0; i < 300; i++) SRAudio.engine.update(i / 300, i % 100 / 100, 1, false);
    assert.equal(fake.graph.created.bufferSource, afterFirst,
      '300 frames of engine updates created ZERO new sources');
    assert.equal(fake.graph.created.gain, 6,
      'no gain fan-out either (master, 2 buses, 3 layer gains)');
    const loops = SRAudio.stats().liveLoops.sort();
    assert.deepEqual(loops, ['eng_accel', 'eng_idle', 'eng_rev']);
    assert.equal(SRAudio.engine.sampleActive(), true);
  } finally { restore(); }
});

test('v173 audio: engine layers rise with throttle/rpm and fall at idle - smooth transitions only', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['engine_roar', 'engine_rev', 'engine_accel']);
    SRAudio.engine.setActive(true);
    // each layer source feeds its own gain, and the fake records the value the
    // automation moved it to - so the mix can be read straight off the graph
    const level = (name) => {
      const src = srcOf(fake, name);
      return src ? src.connected[0].gain.value : null;
    };
    SRAudio.engine.update(0, 0.22, 0, false);            // parked, engine running
    const idleAtRest = level('engine_roar');
    const accelAtRest = level('engine_accel');
    assert.ok(idleAtRest > 0.25, 'idle layer is present at a standstill');
    SRAudio.engine.update(1, 1, 1, false);               // flat out
    assert.ok(level('engine_roar') < idleAtRest, 'the idle layer ducks as speed rises');
    assert.ok(level('engine_accel') > accelAtRest, 'the acceleration layer comes up with throttle');
    assert.ok(level('engine_rev') > 0, 'and the high-rpm layer is present at the top end');
    SRAudio.engine.update(1, 0.6, 0.5, false);
    assert.ok(level('engine_rev') < 0.44, 'rev layer follows rpm, not just speed');
    SRAudio.engine.setActive(false);
    SRAudio.engine.update(1, 1, 1, false);
    assert.equal(SRAudio.engine.state().on, false, 'inactive engine reports silent');
    assert.ok(level('engine_rev') < 0.2, 'and its layers were ramped down');
  } finally { restore(); }
});

test('v173 audio: engine levels are automated on the existing gains, never rebuilt', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['engine_roar', 'engine_rev', 'engine_accel']);
    SRAudio.engine.setActive(true);
    SRAudio.engine.update(0, 0, 0, false);
    const sources = fake.graph.created.bufferSource;
    const gains = fake.graph.created.gain;
    const layers = fake.graph.sources.map((s) => s.connected[0].gain);
    for (let i = 0; i < 120; i++) SRAudio.engine.update(0.5, 0.5, 1, false);
    assert.equal(fake.graph.created.bufferSource, sources, 'no new sources');
    assert.equal(fake.graph.created.gain, gains, 'no new gains');
    assert.ok(layers.every((g) => g.events.length > 100), 'every frame is a ramp on an existing param');
    assert.ok(layers[0].events.every((e) => e[0] === 'target'), 'transitioned with setTargetAtTime, not jumped');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   6. Nitro / boost
   -------------------------------------------------------------------------- */
test('v173 audio: nitro ignition fires ONCE per activation, the boost layer sustains', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['nitro', 'boost']);
    const oneShots = () => allOf(fake, 'nitro').length;
    assert.equal(SRAudio.nitro.set(true), true, 'rising edge accepted');
    assert.equal(SRAudio.nitro.active(), true);
    await tick(10);
    assert.equal(oneShots(), 1, 'one ignition sample');
    const boostSources = allOf(fake, 'boost').length;
    for (let i = 0; i < 200; i++) SRAudio.nitro.set(true);     // held for 200 frames
    await tick(10);
    assert.equal(oneShots(), 1, 'holding nitro NEVER re-fires the ignition');
    assert.equal(SRAudio.nitro.edges(), 1);
    assert.equal(allOf(fake, 'boost').length, boostSources,
      'the sustained boost loop is created once, not per frame');
    SRAudio.nitro.set(false);
    assert.equal(SRAudio.nitro.active(), false);
    await tick(200);
    assert.ok(!SRAudio.stats().liveLoops.includes('boost'), 'boost loop is released when nitro ends');
  } finally { restore(); }
});

test('v173 audio: the boost loop uses the steady region of speed_boost.mp3 (no gaps)', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['nitro', 'boost']);
    SRAudio.nitro.set(true);
    await tick(10);
    const boost = srcOf(fake, 'boost');
    assert.ok(boost, 'boost source exists');
    assert.equal(boost.loop, true, 'it loops');
    assert.equal(boost.loopStart, 0, 'looping the blended buffer from its own zero');
    assert.ok(Math.abs(boost.loopEnd - boost.buffer.duration) < 1e-6);
    assert.ok(boost.buffer.duration > 0.5, 'the loop is long enough to sound continuous');
    assert.equal(fake.graph.started.find((s) => s.src === boost).offset, 0, 'started at the head of the blended loop');
  } finally { restore(); }
});

test('v173 audio: nitro ignition uses nitro.mp3 as a one-shot, with no loop', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['nitro']);
    SRAudio.nitro.set(true);
    await tick(10);
    const shot = srcOf(fake, 'nitro');
    assert.ok(shot);
    assert.equal(shot.loop, false, 'ignition is a transient');
    assert.equal(SRAudio.TRIMS.nitro.offset, 0.02, 'starts at the measured onset');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   7. Drift
   -------------------------------------------------------------------------- */
test('v173 audio: drift is one looping bed whose level follows slip intensity', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    SRAudio.drift.set(0.8);
    await tick(10);
    const drifts = () => allOf(fake, 'drift');
    assert.equal(drifts().length, 1, 'exactly one drift source');
    const src = drifts()[0];
    assert.equal(src.loop, true);
    assert.equal(src.loopStart, SRAudio.LOOPS.drift.start, 'the 12 MB drift bed keeps its raw region');
    for (let i = 0; i < 200; i++) SRAudio.drift.set(0.2 + (i % 5) / 10);
    assert.equal(drifts().length, 1, '200 frames of drifting created no new sources');
    assert.equal(SRAudio.drift.level() > 0, true);
    SRAudio.drift.set(0);
    assert.equal(SRAudio.drift.level(), 0);
    await tick(500);
    assert.ok(!SRAudio.stats().liveLoops.includes('drift'), 'the bed is released when the slide ends');
  } finally { restore(); }
});

test('v173 audio: drift silently waits for its (large) sample instead of creating a second loop', async () => {
  const fake = makeHarness({ durations: { drift: 64.8 } });
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    for (let i = 0; i < 60; i++) SRAudio.drift.set(1);   // frame after frame before the decode lands
    await tick(20);
    const drifts = allOf(fake, 'drift');
    assert.equal(drifts.length, 1, 'the "arming" guard prevents a stampede of loads');
    assert.equal(fake.graph.fetches.filter((u) => u.includes('drift')).length, 1, 'fetched once');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   8. Brake
   -------------------------------------------------------------------------- */
test('v173 audio: braking is edge triggered, refractory, and ignores a light pedal', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['brake']);
    const brakes = () => allOf(fake, 'brake').length;
    SRAudio.TUNING.brakeCooldownMs = 0;
    assert.equal(SRAudio.brake.trigger(0.1), false, 'a brushed pedal is not a braking event');
    assert.equal(SRAudio.brake.trigger(0.9), true, 'a real pedal press fires');
    for (let i = 0; i < 240; i++) SRAudio.brake.trigger(0.9);      // HELD for 4 seconds
    assert.equal(SRAudio.brake.fires(), 1, 'a held brake never repeats');
    await tick(10);
    assert.equal(brakes(), 1, 'one sample for one press');
    SRAudio.brake.release();
    assert.equal(SRAudio.brake.trigger(0.8), true, 'releasing re-arms the edge');
    assert.equal(SRAudio.brake.fires(), 2);
  } finally { restore(); }
});

test('v173 audio: the brake refractory window throttles a pumping pedal', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['brake']);
    SRAudio.TUNING.brakeCooldownMs = 800;
    assert.equal(SRAudio.brake.trigger(1), true);
    SRAudio.brake.release();
    assert.equal(SRAudio.brake.trigger(1), false, 'inside the refractory window: ignored');
    SRAudio.brake._lastMs = Date.now() - 900;
    SRAudio.brake.release();
    assert.equal(SRAudio.brake.trigger(1), true, 'after the window: allowed again');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   9. Crash
   -------------------------------------------------------------------------- */
test('v173 audio: crashes alternate the two takes and ignore tiny contacts', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['crash_1', 'crash_2']);
    SRAudio.TUNING.crashMinGapMs = 0;
    assert.equal(SRAudio.crash(0.05, { local: true }), false, 'a graze is not a crash');
    assert.equal(SRAudio.crash(0.9, { local: true }), true);
    SRAudio.crashState._lastMs = -1e9;
    assert.equal(SRAudio.crash(0.9, { local: true }), true);
    SRAudio.crashState._lastMs = -1e9;
    assert.equal(SRAudio.crash(0.9, { local: true }), true);
    await tick(10);
    const used = fake.graph.sources.filter((s) => s.buffer && /^crash_/.test(s.buffer.__asset || s.buffer.__name))
      .map((s) => s.buffer.__asset || s.buffer.__name);
    assert.deepEqual(used, ['crash_1', 'crash_2', 'crash_1'], 'the two takes alternate');
  } finally { restore(); }
});

test('v173 audio: crash audio is rate limited, local is louder than remote', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['crash_1', 'crash_2']);
    SRAudio.TUNING.crashMinGapMs = 90;
    const accepted = [];
    for (let i = 0; i < 30; i++) accepted.push(SRAudio.crash(0.8, { local: true }));
    const played = accepted.filter(Boolean).length;
    assert.ok(played >= 1 && played < 30, 'a burst is throttled (played ' + played + '/30)');
    assert.ok(SRAudio.crashState.ignored() >= 1);
    // local vs remote gain, straight from the ducking constant
    assert.ok(SRAudio.TUNING.crashRemoteGain < 0.6, 'remote crashes are mixed well under the local one');
  } finally { restore(); }
});

test('v173 audio: a far-away rival crash is dropped instead of played at zero', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['crash_1']);
    SRAudio.TUNING.crashMinGapMs = 0;
    const before = SRAudio.crashState.plays();
    SRAudio.crash(0.9, { local: false, distance: 400 });
    assert.equal(SRAudio.crashState.plays(), before, 'no playback for an inaudible crash');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   10. Pass-by
   -------------------------------------------------------------------------- */
test('v173 audio: pass-by obeys its cooldown and pans with the geometry it is given', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['pass_by']);
    SRAudio.TUNING.passByCooldownMs = 2500;
    assert.equal(SRAudio.passBy({ pan: 0.6, volume: 0.8 }), true, 'first overtake plays');
    assert.equal(SRAudio.passBy({ pan: -0.6, volume: 0.8 }), false, 'a second car a moment later is throttled');
    SRAudio.passByState._lastMs = Date.now() - 3000;
    assert.equal(SRAudio.passBy({ pan: 0, volume: 0.5 }), true, 'after the cooldown it plays again');
    await tick(10);
    const pans = fake.graph.created.panner;
    assert.ok(pans >= 1, 'the pass-by is placed with a stereo panner');
    assert.equal(SRAudio.passByState.plays(), 2);
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   11. Countdown
   -------------------------------------------------------------------------- */
test('v173 audio: race_start.mp3 claims the countdown before the first "3"', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload(['race_start']);
    assert.equal(SRAudio.countdown.owned(), false, 'nothing owns the countdown yet');
    assert.equal(SRAudio.countdown.begin(), true, 'the sample claims it');
    assert.equal(SRAudio.countdown.owned(), true);
    assert.equal(SRAudio.countdown.started(), 1, 'and it starts immediately (preloaded in the lobby)');
    await tick(10);
    const src = srcOf(fake, 'race_start');
    assert.ok(src, 'the real countdown sample is playing');
    assert.equal(src.loop, false);
    SRAudio.countdown.end();
    assert.equal(SRAudio.countdown.owned(), false);
    assert.equal(SRAudio.countdown.started(), 0);
  } finally { restore(); }
});

test('v173 audio: a late-loading countdown sample starts part-way in, keeping GO! on the game clock', async () => {
  const fake = makeHarness({ durations: { race_start: 4.049 } });
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    // slow first request: the buffer only lands after we have already claimed
    let release; const gate = new Promise((r) => { release = r; });
    const realFetch = fake.win.fetch;
    fake.win.fetch = (url) => gate.then(() => realFetch(url));
    SRAudio.countdown.begin();
    assert.equal(SRAudio.countdown.owned(), true, 'ownership is synchronous, so no synth tick sneaks in');
    assert.equal(SRAudio.countdown.started(), 0, 'nothing has started yet');
    SRAudio.countdown._t0 = Date.now() - 900;    // pretend 0.9 s of countdown already elapsed
    release();
    await tick(30);
    const started = fake.graph.started.find((s) => s.src.buffer && (s.src.buffer.__asset === 'race_start' || s.src.buffer.__name === 'race_start'));
    assert.ok(started, 'it started once the bytes arrived');
    assert.ok(started.offset >= 0.8 && started.offset <= SRAudio.COUNT_GO_AT,
      'it skips the part of the sample that already went by (offset ' + started.offset + ')');
  } finally { restore(); }
});

test('v173 audio: race_start.mp3 really is a complete 3-2-1-GO (measured, not assumed)', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    // The four onsets measured from the shipped file are 0.02 / 1.02 / 2.03 / 3.02 s
    // and the fourth is the long one (the GO). The manager encodes the GO instant
    // so a late start can be aligned; this pins the constant to the file's shape.
    assert.equal(SRAudio.COUNT_GO_AT, 3.02);
    const dur = 4.049;
    assert.ok(dur - SRAudio.COUNT_GO_AT > 0.8, 'the GO has ~1 s of tail in the file');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   12. Autoplay / visibility / rejection recovery
   -------------------------------------------------------------------------- */
test('v173 audio: a rejected play() is swallowed, counted, and retried after a gesture', async () => {
  const fake = makeHarness({ playRejects: true });
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    SRAudio.music.play('race');
    await tick(20);
    assert.equal(SRAudio.stats().blocked, 1, 'the rejection is recorded, not thrown');
    assert.equal(SRAudio.music.wanted(), true, 'the game still believes music should play');
    fake.win.fetch = fake.win.fetch;
    const el = SRAudio.music.element();
    el.play = function () { this.plays++; this.paused = false; return Promise.resolve(); };
    SRAudio.unlock();                       // the gesture the browser was waiting for
    await tick(20);
    assert.equal(el.paused, false, 'music comes back after the gesture');
    assert.equal(el.plays, 2);
  } finally { restore(); }
});

test('v173 audio: unlock() resumes a suspended context and never throws without one', () => {
  const fake = makeHarness({ suspended: true });
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    assert.equal(fake.ctx.state, 'suspended');
    assert.equal(SRAudio.unlock(), true);
    assert.equal(fake.ctx.state, 'running', 'unlock resumes the context');
  } finally { restore(); }
  const none = makeHarness({ noAudioContext: true });
  const second = load(none);
  try {
    assert.equal(second.SRAudio.ensure(), null);
    assert.equal(second.SRAudio.available(), false);
    assert.equal(second.SRAudio.unlock(), false, 'no context, no throw');
    assert.equal(second.SRAudio.music.play('race'), false);
    assert.equal(second.SRAudio.countdown.begin(), false);
  } finally { second.restore(); }
});

test('v173 audio: hiding the tab pauses the music and suspends the graph; returning resumes it', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    SRAudio.music.play('race');
    const el = SRAudio.music.element();
    fake.doc.hidden = true;
    fake.doc.fire('visibilitychange');
    assert.equal(el.paused, true, 'hidden tab is silent');
    fake.doc.hidden = false;
    fake.doc.fire('visibilitychange');
    await tick(10);
    assert.equal(el.paused, false, 'visible tab resumes');
    assert.equal(fake.ctx.state, 'running');
  } finally { restore(); }
});

test('v173 audio: gesture listeners are installed once, not per ensure()', () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure(); SRAudio.ensure(); SRAudio.unlock(); SRAudio.ensure();
    const before = fake.listenerCount();
    SRAudio.ensure();
    assert.equal(fake.listenerCount(), before, 'no listener accumulation');
    assert.ok(fake.listenerCount() <= 4, 'at most pointerdown/keydown/touchstart/visibilitychange');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   13. Fallbacks
   -------------------------------------------------------------------------- */
test('v173 audio: no Web Audio at all leaves every call harmless', async () => {
  const fake = makeHarness({ noAudioContext: true });
  const { SRAudio, restore } = load(fake);
  try {
    assert.equal(SRAudio.ensure(), null);
    assert.equal(SRAudio.available(), false);
    assert.equal(await SRAudio.load('nitro'), null);
    assert.equal(SRAudio.play('nitro', {}), null);
    SRAudio.engine.setActive(true);
    SRAudio.engine.update(1, 1, 1, true);
    SRAudio.nitro.set(true);
    SRAudio.drift.set(1);
    SRAudio.brake.trigger(1);
    SRAudio.crash(0.9, { local: true });
    SRAudio.passBy({});
    SRAudio.countdown.begin();
    SRAudio.countdown.end();
    SRAudio.music.play('race');
    SRAudio.music.stop({});
    SRAudio.tick();
    assert.ok(true, 'nothing threw');
    assert.equal(SRAudio.stats().contexts, 0);
  } finally { restore(); }
});

test('v173 audio: a 404 is remembered as failed so the game stops asking for it', async () => {
  const fake = makeHarness({ fetchFails: true });
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.load('pass_by');
    await SRAudio.load('pass_by');
    await SRAudio.preload(['pass_by']);
    assert.deepEqual(SRAudio.stats().failed, ['pass_by']);
    assert.equal(fake.graph.fetches.filter((u) => u.includes('pass_by')).length, 1, 'one attempt, ever');
    assert.equal(SRAudio.sampleState('pass_by'), 'failed');
    await SRAudio.load('crash_1');
    assert.equal(SRAudio.crash(1, { local: true }), false, 'and the caller is told so it can fall back');
  } finally { restore(); }
});

test('v173 audio: a decode failure does not retry in a loop either', async () => {
  const fake = makeHarness({ decodeFails: true });
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.load('crash_2');
    await SRAudio.load('crash_2');
    assert.equal(SRAudio.sampleState('crash_2'), 'failed');
    assert.equal(fake.graph.fetches.filter((u) => u.includes('crash_02')).length, 1);
    assert.ok(SRAudio.stats().decodesFailed >= 1);
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   14. Cleanup / dispose
   -------------------------------------------------------------------------- */
test('v173 audio: dispose stops every source, empties the caches and closes the context', async () => {
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    SRAudio.ensure();
    await SRAudio.preload();
    SRAudio.engine.setActive(true);
    SRAudio.engine.update(1, 1, 1, true);
    SRAudio.nitro.set(true);
    SRAudio.drift.set(1);
    SRAudio.music.play('race');
    await tick(10);
    assert.ok(SRAudio.stats().liveLoops.length >= 3);
    SRAudio.dispose();
    const after = SRAudio.stats();
    assert.deepEqual(after.liveLoops, [], 'no loop survives dispose');
    assert.equal(after.activeOneShots, 0, 'no one-shot leaks');
    assert.deepEqual(after.loaded, [], 'buffers are released');
    assert.equal(fake.ctx.state, 'closed', 'the context is closed');
    assert.ok(fake.graph.sources.filter((s) => s.loop).every((s) => s.stopped),
      'every looped source was stopped');
  } finally { restore(); }
});

/* --------------------------------------------------------------------------
   15. The client integration (game.js is the only caller)
   -------------------------------------------------------------------------- */
test('v173 audio: game.js routes every sample through SRAudio and owns no second context', () => {
  const game = read('public/js/game.js');
  assert.ok(/<script defer src="js\/audio\.js\?v=\d+"><\/script>/.test(read('public/index.html')) ||
    read('public/index.html').includes('js/audio.js'), 'audio.js is loaded by the page');
  assert.ok(/window\.SRAudio/.test(game) || /sampleAudio\(\)/.test(game), 'game.js talks to the manager');
  assert.equal((game.match(/new Ctx\(\)/g) || []).length, 1,
    'the only place game.js may build a context is the no-SRAudio fallback');
  assert.ok(/A\.countdown\.begin\(\)/.test(game), 'the countdown is claimed');
  assert.ok(/A\.music\.play\('race'\)/.test(game), 'race music is started');
  assert.ok(/A\.music\.stop\(\{ fade:/.test(game), 'and stopped');
});

test('v173 audio: the countdown sample claims the count BEFORE the first "3" is shown', () => {
  const game = read('public/js/game.js');
  const claim = game.indexOf('A.countdown.begin()');
  const events = game.indexOf('processEvents(snap);', game.indexOf('function ingestSnapshot'));
  assert.ok(claim > 0 && events > 0, 'both exist');
  assert.ok(claim < events, 'the claim runs before processEvents() can announce "3"');
  // and the synth tick refuses to fire while the sample owns the count
  const tickFn = game.slice(game.indexOf('function soundCountdownTick'));
  assert.ok(tickFn.slice(0, 400).includes('countdown.owned()'),
    'soundCountdownTick bails out when the sample owns the countdown (no residual 440 Hz tick)');
  assert.ok(!/beep\(440/.test(game.slice(game.indexOf('min(3, Math.ceil(latest.count))'), game.indexOf('min(3, Math.ceil(latest.count))') + 200)),
    'no beep next to the countdown visual update');
});

test('v173 audio: the visual countdown is 3-2-1-GO, never a phantom 4', () => {
  const game = read('public/js/game.js');
  const m = game.match(/const n = Math\.max\(1, Math\.min\(3, Math\.ceil\(latest\.count\) - 1\)\);/);
  assert.ok(m, 'the display turns the server count into the digit 1..3');
  // the server sends count = countVal + (1 - countTimer), so the value runs one
  // ABOVE the digit: 3.0..4.0 is the "3", 2.0..3.0 the "2", 1.0..2.0 the "1".
  const shown = (count) => Math.max(1, Math.min(3, Math.ceil(count) - 1));
  assert.equal(shown(4.0), 3, 'a fresh countdown shows 3, not the phantom 4');
  assert.equal(shown(3.9), 3);
  assert.equal(shown(3.0), 2, 'the boundary at 3.0 belongs to the "2" (countVal already decremented)');
  assert.equal(shown(2.0), 1);
  assert.equal(shown(1.0), 1);
  // walk the whole authoritative countdown at 30 Hz and check the sequence
  const seen = [];
  for (let step = 0; step < 90; step++) {
    const t = step / 30;
    const countVal = 3 - Math.floor(t);
    const countTimer = t - Math.floor(t);
    if (countVal < 1) break;
    const n = shown(Math.round((countVal + (1 - countTimer)) * 1000) / 1000);
    if (seen[seen.length - 1] !== n) seen.push(n);
  }
  assert.deepEqual(seen, [3, 2, 1], 'the racer sees 3, then 2, then 1 - and then the GO event');
  // and the authoritative sim is untouched by the display fix
  const core = read('shared/game-core.js');
  assert.ok(/count: this\.state === 'countdown' \? r3\(this\.countVal \+ \(1 - this\.countTimer\)\) : null/.test(core),
    'the server/client countdown value is unchanged');
});

test('v173 audio: the countdown beeps are not duplicated in the event switch', () => {
  const game = read('public/js/game.js');
  const cases = game.slice(game.indexOf("case 'count':"), game.indexOf("case 'go':") + 200);
  assert.ok(!/beep\(/.test(cases), 'the count/go events no longer add a second beep on top of showCount()');
  assert.ok(/showCount\(String\(e\.n\)\)/.test(cases));
  assert.ok(/showCount\(tI18n\('countdownGo'\)/.test(cases));
});

test('v173 audio: race music is only wanted while a race is live', () => {
  const game = read('public/js/game.js');
  const idx = game.indexOf("A.music.play('race')");
  const around = game.slice(Math.max(0, idx - 500), idx);
  assert.ok(/const racing = snap && \(snap\.state === 'countdown' \|\| snap\.state === 'racing'\)/.test(around),
    'music is gated on the race states');
  assert.ok(/A\.music\.stop\(\{ fade:/.test(game), 'and stopped when leaving them');
  assert.ok(/prefs\.music && !prefs\.mute && !raceIsAudible\(\)/.test(game),
    'the synth bed is a lobby bed: it stays out of a live race');
});

test('v173 audio: engine audio follows the LOCAL car and the samples replace (never stack on) the synth', () => {
  const game = read('public/js/game.js');
  const fn = game.slice(game.indexOf('function updateAudio('), game.indexOf('function updateAudio(') + 6000);
  assert.ok(/mine && mine\.p === 1/.test(fn), 'the sample engine is driven by the local car only');
  assert.ok(/A\.engine\.update\(sp, rpm, thr, !!mine\.n\)/.test(fn));
  assert.ok(/A\.nitro\.set\(!!mine\.n\)/.test(fn));
  assert.ok(/A\.drift\.set\(slip\)/.test(fn));
  assert.ok(/A\.brake\.trigger\(amount\)/.test(fn));
  assert.ok(/i === 0 && sampleEngine/.test(fn), 'the legacy synth engine for MY car is muted while samples play');
  assert.ok(/sampleDrift/.test(fn) && /sampleNitro/.test(fn), 'legacy skid/turbine fall silent when the samples do');
});

test('v173 audio: drift is triggered by slip, not by steering input', () => {
  const game = read('public/js/game.js');
  const fn = game.slice(game.indexOf('function updateAudio('), game.indexOf('function updateAudio(') + 6000);
  assert.ok(/mine\.sl > 3\.5 && Math\.abs\(mine\.v\) > 6/.test(fn), 'slip and speed decide, not the steering value');
  assert.ok(!/slip[\s\S]{0,80}mine\.st/.test(fn), 'the steering field is not part of the drift test');
});

test('v173 audio: crash and pass-by plumbing uses the existing events, throttled', () => {
  const game = read('public/js/game.js');
  assert.ok(/onCrashFX\(e\.x, e\.z, e\.s, e\.slot === mySlot\)/.test(game), 'the existing crash event carries locality');
  assert.ok(/A\.crash\(strength, opts\)/.test(game));
  assert.ok(/passByAccum < 0\.1/.test(game), 'pass-by checks run at 10 Hz, not per frame');
  assert.ok(/PASS_BY_MIN_GAP/.test(game) && /PASS_BY_MAX_DIST/.test(game), 'with a meaningful-gap and a range limit');
  assert.ok(!/function onCrashFX[\s\S]{0,800}physics/i.test(game), 'no second collision system was born');
});

/* --------------------------------------------------------------------------
   16. Mixer UI + i18n + version surfaces
   -------------------------------------------------------------------------- */
test('v173 audio: the mixer sliders exist, are labelled, and are wired to the manager', () => {
  const html = read('public/index.html');
  for (const id of ['set-vol-master', 'set-vol-music', 'set-vol-sfx']) {
    assert.ok(html.includes('id="' + id + '"'), id + ' slider exists');
  }
  const game = read('public/js/game.js');
  assert.ok(/'set-vol-master', 'volMaster'/.test(game), 'master slider wired');
  assert.ok(/'set-vol-music', 'volMusic'/.test(game), 'music slider wired');
  assert.ok(/'set-vol-sfx', 'volSfx'/.test(game), 'sfx slider wired');
  assert.ok(/prefs\[key\] = Math\.max\(0, Math\.min\(100, v\)/.test(game), 'values are clamped before they are stored');
  assert.ok(/A\.setVolumes\(volumePrefs\(\)\)/.test(game), 'the sliders reach the audio manager');
  const css = read('public/css/style.css');
  assert.ok(/#set-vol-master::-webkit-slider-thumb/.test(css), 'styled like the rest of the settings tab');
});

test('v173 audio: the mixer labels are translated in all four languages', () => {
  const i18n = read('public/js/i18n.js');
  for (const key of ['masterVolume', 'musicVolume', 'sfxVolume']) {
    const hits = (i18n.match(new RegExp('\\b' + key + ':', 'g')) || []).length;
    assert.equal(hits, 4, key + ' is translated 4 times (en/te/hi/es)');
  }
});

test('v173 audio: the build stamp is consistent across every surface that caches assets', () => {
  const game = read('public/js/game.js');
  const sw = read('public/sw.js');
  const html = read('public/index.html');
  const srv = read('server.js');
  const build = (game.match(/const BUILD = '(v\d+)'/) || [])[1];
  assert.ok(/^v\d+$/.test(build), 'game.js must carry a build marker');
  assert.ok(Number(build.slice(1)) >= 173, 'the audio release bumped the build (returning users must fetch the new client)');
  assert.equal((sw.match(/const CACHE = 'sridhar-rush-(v\d+)'/) || [])[1], build);
  assert.equal((srv.match(/build: '(v\d+)'/) || [])[1], build);
  assert.equal((game.match(/const BUILD = '(v\d+)'/) || [])[1], build);
  for (const m of html.matchAll(/\?v=(\d+)/g)) assert.equal(m[1], String(build).slice(1), 'stale asset ref in index.html');
  for (const m of sw.matchAll(/\?v=(\d+)/g)) assert.equal(m[1], String(build).slice(1), 'stale asset ref in sw.js');
  for (const f of ['auth.html', 'controller.html', 'replay.html']) {
    for (const m of read('public/' + f).matchAll(/\?v=(\d+)/g)) assert.equal(m[1], String(build).slice(1), 'stale asset ref in ' + f);
  }
});

test('v173 audio: the service worker never precaches audio and never intercepts Range requests', () => {
  const sw = read('public/sw.js');
  const core = sw.slice(sw.indexOf('const CORE = ['), sw.indexOf('];', sw.indexOf('const CORE = [')));
  assert.ok(!/assets\/audio/.test(core), 'the samples are NOT precached');
  assert.ok(/url\.pathname\.startsWith\('\/assets\/audio\/'\) \|\| req\.headers\.get\('range'\)/.test(sw),
    'audio and any Range request bypass the cache entirely');
  assert.ok(/js\/audio\.js\?v=\d+/.test(core), 'but the audio MANAGER itself is precached like the rest of the client');
});

test('v173 audio: index.html loads audio.js before the code that calls it', () => {
  const html = read('public/index.html');
  const audio = html.indexOf('js/audio.js?v=');
  const game = html.indexOf('js/game.js?v=');
  assert.ok(audio > 0 && game > 0);
  assert.ok(audio < game, 'audio.js is parsed first');
  assert.ok(/defer/.test(html.slice(audio - 40, audio)), 'deferred like its siblings (order preserved)');
});

test('v173 audio: nothing in the client points at a remote audio CDN', () => {
  const combined = read('public/js/audio.js') + read('public/js/game.js');
  assert.ok(!/https?:\/\/[^'"]*\.mp3/.test(combined), 'every sample URL is local');
  assert.ok(!/new Audio\(\s*['"]http/.test(combined));
});

test('v173 audio: every manager call game.js makes actually exists (no silent typo)', () => {
  const game = read('public/js/game.js');
  const fake = makeHarness();
  const { SRAudio, restore } = load(fake);
  try {
    const props = new Set();
    for (const m of game.matchAll(/\bA\.([A-Za-z_][A-Za-z0-9_]*)/g)) props.add(m[1]);
    for (const m of game.matchAll(/\bSRAudio\.([A-Za-z_][A-Za-z0-9_]*)/g)) props.add(m[1]);
    assert.ok(props.size >= 15, 'the scan found the client\'s audio surface');
    for (const k of props) assert.ok(k in SRAudio, 'game.js calls SRAudio.' + k + ' but the manager has no such member');
    for (const m of game.matchAll(/\bA\.([a-zA-Z]+)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const obj = SRAudio[m[1]];
      assert.ok(obj && typeof obj === 'object', 'game.js uses A.' + m[1] + ' as an object');
      assert.ok(typeof obj[m[2]] === 'function', 'game.js calls A.' + m[1] + '.' + m[2] + '()');
    }
  } finally { restore(); }
});

test('v173 audio: the legacy synth sounds hang off the SFX bus, so one slider moves everything', () => {
  const game = read('public/js/game.js');
  // ensureAudio() must take the SFX bus from the manager instead of building its
  // own destination chain, or the mixer would be a second volume system.
  assert.ok(/let master = \(A && A\.buses && A\.buses\.sfx\) \? A\.buses\.sfx\(\) : null;/.test(game),
    'ensureAudio asks the manager for the SFX bus');
  assert.ok(/osc\.connect\(g\); g\.connect\(audio\.master\);/.test(game),
    'legacy one-shots still connect to that bus');
  assert.ok(/mg\.connect\(bus\)/.test(game), 'the legacy music bed connects to the MUSIC bus');
});
