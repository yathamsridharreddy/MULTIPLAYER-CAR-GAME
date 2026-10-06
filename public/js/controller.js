'use strict';

/* SRIDHAR RUSH — phone controller (joystick) with gyro steering + haptics. */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dz = (v) => (Math.abs(v) < 0.07 ? 0 : v);

const state = { steer: 0, throttle: 0, brake: 0, hb: false, nitro: false, impact: false, slot: null, full: false, gyro: false };
let ctrlMode = '';   // v176: the room's authoritative mode, from telemetry
let vibOn = true; try { vibOn = localStorage.getItem('sr_vib') !== '0'; } catch (e) {}
function vibrate(ms) { try { if (vibOn && navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

// ---------------------------------------------------------------------------
// v40 haptics: phone buzzes on game events. Pure function => unit-testable.
// Returns vibration patterns for a telemetry frame; `prev` carries memory.
// ---------------------------------------------------------------------------
function hapticEvents(d, prev) {
  const out = [];
  if (d.state && d.state !== prev.state) {
    if (d.state === 'racing') out.push([60, 40, 60]);      // GO!
    if (d.state === 'finished') out.push([120, 60, 120]);  // chequered flag
    prev.state = d.state;
  }
  if (typeof d.speed === 'number') {
    if (prev.speed != null && prev.speed > 45 && prev.speed - d.speed > 28) out.push(70); // hard impact
    prev.speed = d.speed;
  }
  if (d.nitroOn && !prev.nitro) out.push(18);              // nitro kick
  prev.nitro = !!d.nitroOn;
  return out;
}
const hPrev = { state: '', speed: null, nitro: false };

// ---- virtual joysticks ----
// v174 AUDIT: the pad sends its STATE every 33 ms, so a control that never
// receives its release is not a cosmetic glitch - the car keeps steering,
// boosting or handbraking until the phone is reloaded. The release handlers used
// to live only on the element that was pressed, which is correct only while
// pointer capture is held: if setPointerCapture() is unavailable (older WebKit)
// and the finger lifts outside the zone, no pointerup ever reaches it. Every
// control now also listens on the window, on lostpointercapture, and is force
// released by releaseAll() (window blur / pagehide / tab hidden).
const stickReleases = [];
function makeStick(zoneId, knobId, onMove) {
  const zone = $(zoneId), knob = $(knobId);
  const R = 46;
  let activeId = null, ox = 0, oy = 0;
  zone.addEventListener('pointerdown', (e) => {
    if (activeId !== null) return;
    activeId = e.pointerId;
    try { zone.setPointerCapture(e.pointerId); } catch (err) {}
    ox = e.clientX; oy = e.clientY; zone.classList.add('active'); vibrate(10); move(e); e.preventDefault();
  });
  function move(e) {
    let dx = e.clientX - ox, dy = e.clientY - oy;
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    onMove(dx / R, dy / R);
  }
  zone.addEventListener('pointermove', (e) => { if (e.pointerId === activeId) move(e); });
  const end = (e) => {
    if (e && e.pointerId != null && e.pointerId !== activeId) return;   // another finger's event
    if (activeId === null) return;                                      // already released
    activeId = null; zone.classList.remove('active');
    knob.style.transform = 'translate(0px, 0px)'; onMove(0, 0);
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
  zone.addEventListener('lostpointercapture', end);   // v174: capture can be taken away at any time
  window.addEventListener('pointerup', end);          // v174: the finger may lift outside the zone
  window.addEventListener('pointercancel', end);
  stickReleases.push(() => end(null));
}
makeStick('zone-left', 'knob-left', (x) => { if (!state.gyro) state.steer = x; });
makeStick('zone-right', 'knob-right', (_, y) => { state.throttle = clamp(-y, 0, 1); state.brake = clamp(y, 0, 1); });

// ---- gyro steering ----
let gyroBase = null;
function onGyro(e) {
  if (!state.gyro || e.gamma == null) return;
  if (gyroBase == null) gyroBase = e.gamma;
  state.steer = clamp((e.gamma - gyroBase) / 26, -1, 1);
}
function enableGyro() {
  const need = (typeof DeviceOrientationEvent !== 'undefined') && DeviceOrientationEvent.requestPermission;
  const done = () => { window.addEventListener('deviceorientation', onGyro); state.gyro = true; gyroBase = null; };
  if (need) DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') done(); }).catch(() => {});
  else done();
}
function disableGyro() { state.gyro = false; state.steer = 0; window.removeEventListener('deviceorientation', onGyro); }

// ---- buttons ----
const heldButtons = new Set();
function holdButton(id, down, up) {
  const el = $(id);
  const release = (e) => {
    if (el._holdPid == null) return;                                   // not held
    if (e && e.pointerId != null && e.pointerId !== el._holdPid) return; // another finger's event
    el._holdPid = null;
    el.classList.remove('pressed'); heldButtons.delete(el);
    if (up) up();
  };
  el.addEventListener('pointerdown', (e) => {
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el._holdPid = e.pointerId; heldButtons.add(el);
    el.classList.add('pressed'); vibrate(14); down(); e.preventDefault();
  });
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);   // v174
  window.addEventListener('pointerup', release);        // v174
  window.addEventListener('pointercancel', release);
}
holdButton('btn-hb', () => { state.hb = true; }, () => { state.hb = false; });
holdButton('btn-nitro', () => { state.nitro = true; vibrate(30); }, () => { state.nitro = false; });
// v176 FIGHTER RUSH: IMPACT. A press is sent straight away (not on the next 33 ms
// tick) so a quick tap is never swallowed, and the server decides whether the
// attack was legal - the phone only ever reports the intent.
holdButton('btn-impact', () => { state.impact = true; vibrate(25); sendInput(); }, () => { state.impact = false; });
holdButton('btn-cam', () => net.send({ type: 'button', action: 'cam', pressed: true }));
holdButton('btn-reset', () => net.send({ type: 'button', action: 'reset', pressed: true }));
holdButton('btn-horn', () => net.send({ type: 'button', action: 'horn', pressed: true }));
const gyroBtn = $('btn-gyro');
if (gyroBtn) gyroBtn.addEventListener('click', () => {
  if (state.gyro) { disableGyro(); gyroBtn.classList.remove('on'); }
  else { enableGyro(); gyroBtn.classList.add('on'); vibrate(20); }
});

// ---- connection ----
const statusEl = $('status');
function setStatus(t, c) { statusEl.textContent = t; statusEl.className = 'pill ' + c; }
let lastBanner = '';
function showBanner(t) {
  const el = $('phone-banner'); el.textContent = t;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(showBanner._t); showBanner._t = setTimeout(() => el.classList.remove('show'), 3200);
  vibrate(40);
}

const net = new RoomLink({
  onWelcome(msg) {
    state.slot = msg.slot;
    $('pads').classList.remove('locked');
    document.body.dataset.player = 'p' + msg.slot;
    $('player-label').textContent = 'PLAYER ' + msg.slot;
    $('player-label').style.display = '';
    $('room-tag').textContent = 'ROOM ' + msg.code;
    setStatus('Connected · Player ' + msg.slot, 'ok');
    vibrate(30);
  },
  onMessage(msg) {
    if (msg.type === 'full') { state.full = true; setStatus('Room full — max joysticks already', 'err'); $('full-note').style.display = ''; return; }
    if (msg.type === 'error' && msg.code === 'no-room') { setStatus('Room not found', 'err'); showJoinScreen('Room not found — check the code.'); return; }
    if (msg.type === 'telemetry' && msg.data) {
      const d = msg.data;
      $('speed-val').textContent = d.speed;
      $('nitro-fill').style.width = (d.nitro || 0) + '%';
      const bits = [];
      ctrlMode = d.mode || '';
      // v176: the IMPACT control exists only while a Fighter Rush match is running
      const imp = $('btn-impact');
      if (imp) {
        const want = ctrlMode === 'fighter';
        if (imp.hidden === want) imp.hidden = !want;
      }
      if (d.mode === 'race' || d.mode === 'elim' || d.mode === 'drift') bits.push('Lap ' + (d.lap || ''));
      if (d.rank) bits.push(d.rank);
      if (d.best) bits.push('Best ' + d.best);
      $('lap-info').textContent = bits.join('  ·  ');
      if (d.state === 'countdown') {
        setStatus('Get ready…', 'wait');
        const rm = $('ctrl-rematch-wrap'); if (rm) rm.style.display = 'none';
      } else if (d.state === 'finished') {
        setStatus('Race finished!', 'ok');
        const rm = $('ctrl-rematch-wrap'); if (rm) rm.style.display = 'flex';
        const rmb = $('ctrl-rematch-btn'); if (rmb) rmb.textContent = '🔁 REMATCH NOW';
      } else {
        setStatus('Connected · Player ' + state.slot + (d.rank ? ' · ' + d.rank : ''), 'ok');
        const rm = $('ctrl-rematch-wrap'); if (rm) rm.style.display = 'none';
      }
    if (d.banner && d.banner !== lastBanner) { lastBanner = d.banner; showBanner(d.banner); }
    for (const p of hapticEvents(d, hPrev)) vibrate(p);
    return;
    }
    if (msg.type === 'disconnected') setStatus('Reconnecting…', 'err');
    if (msg.type === 'pong' && typeof msg.t === 'number') { const rtt = performance.now() - msg.t; ctrlLat = ctrlLat < 0 ? rtt : ctrlLat * 0.7 + rtt * 0.3; const lb = $('lat-badge'); if (lb) { lb.hidden = false; lb.textContent = Math.round(ctrlLat) + ' ms'; lb.className = 'pill ' + (ctrlLat < 90 ? 'ok' : ctrlLat < 180 ? 'wait' : 'err'); } }
  },
  onStatus(s) {
    if (state.full) return;
    if (s === 'connected') setStatus('Connected' + (state.slot ? ' · Player ' + state.slot : ''), 'ok');
    else if (s === 'connecting') setStatus('Connecting…', 'wait');
    else { setStatus('Reconnecting…', 'err'); const rb = $('reconnect-btn'); if (rb) rb.hidden = false; }
    const rb2 = $('reconnect-btn'); if (rb2 && s === 'connected') rb2.hidden = true;
  }
});

// v174 AUDIT: the single "let go of everything" path. It zeroes the pad state,
// both sticks, every held button, and pushes the zeroed frame straight away - so a
// phone that is locked, backgrounded, swiped away or loses focus cannot leave a
// car driving itself on the track.
function releaseAll() {
  state.steer = state.throttle = state.brake = 0;
  state.hb = state.nitro = false; state.impact = false;   // v176
  heldButtons.forEach((el) => el.classList.remove('pressed'));
  heldButtons.clear();
  for (const rel of stickReleases) rel();
  if (net.isOpen() && !state.full && state.slot != null) {
    try { net.send({ type: 'input', steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false }); } catch (e) {}
  }
}
window.addEventListener('blur', releaseAll);
window.addEventListener('pagehide', releaseAll);

function showJoinScreen(err) { $('join-screen').style.display = 'flex'; $('pads').classList.add('locked'); if (err) $('join-error').textContent = err; }
function ctrlPid() { try { let p = localStorage.getItem('sr_ctrl_pid'); if (!p) { p = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); localStorage.setItem('sr_ctrl_pid', p); } return p; } catch (e) { return null; } } // v77 BUG-008
function joinRoom(code, slot) {
  $('join-screen').style.display = 'none';
  $('pads').classList.remove('locked');
  setStatus('Connecting…', 'wait');
  const hello = { type: 'hello', role: 'controller', room: code.toUpperCase().trim(), pid: ctrlPid() };
  if (slot != null && !isNaN(parseInt(slot, 10))) hello.slot = parseInt(slot, 10);
  net.connect(hello);
}

const wantedRoom = urlParam('room');
const wantedSlot = urlParam('slot');
if (wantedRoom) joinRoom(wantedRoom, wantedSlot); else showJoinScreen('');
$('join-btn').addEventListener('click', () => { const c = $('room-input').value.trim(); if (c.length >= 4) joinRoom(c, wantedSlot); else $('join-error').textContent = 'Enter the 5-letter room code.'; });
$('room-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });

// send input at ~30 Hz
function sendInput() {
  if (!net.isOpen() || state.full || state.slot == null) return;
  const frame = { type: 'input', steer: dz(state.steer), throttle: dz(state.throttle), brake: dz(state.brake), handbrake: state.hb, nitro: state.nitro };
  if (ctrlMode === 'fighter') frame.attack = state.impact;   // v176: only in Fighter Rush
  net.send(frame);
}
setInterval(sendInput, 33);

// v140 PRODUCTION FIX — a phone that slept is not necessarily still connected.
// This used to only zero the stick on hide. On most phones the socket is a zombie
// after a screen lock (no close event), so the player came back to a controller that
// looked connected but sent every input into the void - the car simply did not move.
// Now a real absence forces a fresh dial (RoomLink's generation guard makes that safe)
// and the liveness watchdog in net.js covers the case where the sleep was short.
let ctrlHiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    ctrlHiddenAt = performance.now();
    releaseAll();          // v174: also clears the sticks and held buttons
    return;
  }
  const away = ctrlHiddenAt ? (performance.now() - ctrlHiddenAt) : 0;
  ctrlHiddenAt = 0;
  if (away > 3000 && state.slot != null && !state.full) {
    setStatus('Reconnecting…', 'wait');
    net.delay = 400;
    net.connect({ type: 'hello', role: 'controller', room: (wantedRoom || '').toUpperCase().trim(), pid: ctrlPid(), slot: state.slot });
  }
});

$('btn-full').addEventListener('click', async () => {
  vibrate(10);
  try { await document.documentElement.requestFullscreen(); } catch (e) {}
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) {}
  try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) {}
});

const scrBtn = $('btn-screen-mode');
if (scrBtn) {
  const r = urlParam('room') || '';
  scrBtn.href = '/?room=' + encodeURIComponent(r) + '&screen=1';
}
document.addEventListener('contextmenu', (e) => e.preventDefault());

// v40: vibration toggle + tiny privacy-friendly analytics beacon
const vibBtn = $('btn-vib');
if (vibBtn) {
  const paintVib = () => vibBtn.classList.toggle('on', vibOn);
  paintVib();
  vibBtn.addEventListener('click', () => {
    vibOn = !vibOn;
    try { localStorage.setItem('sr_vib', vibOn ? '1' : '0'); } catch (e) {}
    paintVib();
    if (vibOn) vibrate(20);
  });
}
function trackCtl(e, m) {
  try {
    let cfg = String(window.SERVER_URL || 'local').trim();
    if (cfg !== 'local') {
      if (!/^(https?):\/\//i.test(cfg)) cfg = 'https://' + cfg;
      cfg = cfg.replace(/\/+$/, '');
    } else cfg = '';
    const pid = ctrlPid();
    let body = { e, pid };
    if (typeof m === 'object' && m !== null) Object.assign(body, m);
    else if (m !== undefined) body.m = m;
    fetch(cfg + '/a', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).catch(() => {});
  } catch (err) {}
}
let ctrlLat = -1;
setInterval(() => { try { net.send({ type: 'ping', t: performance.now() }); } catch (e) {} }, 2000); // v59 latency badge
const rcBtn = typeof document !== 'undefined' && document.getElementById('reconnect-btn');
if (rcBtn) rcBtn.addEventListener('click', () => location.reload()); // v59 clear reconnect
trackCtl('ctrl');
// v43: crash reports from the phone pad too
let lastErrCtl = '';
window.addEventListener('error', (ev) => { const m = String((ev && ev.message) || 'error'); if (m === lastErrCtl) return; lastErrCtl = m; trackCtl('err', m); });
window.addEventListener('unhandledrejection', (ev) => trackCtl('err', 'promise: ' + String((ev.reason && ev.reason.message) || ev.reason || 'rejection')));

// v82: 1-tap Rematch from mobile phone controller
const ctrlRematch = $('ctrl-rematch-btn');
if (ctrlRematch) {
  ctrlRematch.addEventListener('click', () => {
    vibrate(40);
    net.send({ type: 'rematch' });
    ctrlRematch.textContent = '✅ REMATCH REQUESTED';
  });
}

// v45: iOS install hint (iPhones have no native install prompt)
(function () {
  if (typeof window.tI18n === 'function') {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const s = window.tI18n(el.getAttribute('data-i18n'));
      if (s) el.textContent = s;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const s = window.tI18n(el.getAttribute('data-i18n-placeholder'));
      if (s) el.placeholder = s;
    });
  }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;

  let seen = false; try { seen = !!localStorage.getItem('sr_ios_hint'); } catch (e) {}
  const el = $('ios-hint'); if (!el || !isIOS || seen) return;
  el.hidden = false;
  const done = () => { el.hidden = true; try { localStorage.setItem('sr_ios_hint', '1'); } catch (e) {} };
  const x = $('ios-hint-x'); if (x) x.addEventListener('click', done);
  setTimeout(done, 12000);
})();
document.addEventListener('touchmove', (e) => { if (e.scale != null && e.scale !== 1) e.preventDefault(); }, { passive: false });
function checkOrientation() { $('rotate-hint').classList.toggle('show', window.innerHeight > window.innerWidth); }
window.addEventListener('resize', checkOrientation);
checkOrientation();
