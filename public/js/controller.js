'use strict';

/* ============================================================
   VELOCITY RUSH — online phone controller (joystick)
   Joins a race room via ?room=CODE (or by typing the code),
   streams input to the server, shows live telemetry.
   ============================================================ */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dz = (v) => (Math.abs(v) < 0.07 ? 0 : v);

const state = { steer: 0, throttle: 0, brake: 0, hb: false, nitro: false, slot: null, full: false };
function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

// ---------------------------------------------------------------------------
// Virtual joysticks
// ---------------------------------------------------------------------------
function makeStick(zoneId, knobId, onMove) {
  const zone = $(zoneId), knob = $(knobId);
  const R = 46;
  let activeId = null, ox = 0, oy = 0;

  zone.addEventListener('pointerdown', (e) => {
    if (activeId !== null) return;
    activeId = e.pointerId;
    try { zone.setPointerCapture(e.pointerId); } catch (err) {}
    ox = e.clientX; oy = e.clientY;
    zone.classList.add('active');
    vibrate(10);
    move(e);
    e.preventDefault();
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
    if (e.pointerId !== activeId) return;
    activeId = null;
    zone.classList.remove('active');
    knob.style.transform = 'translate(0px, 0px)';
    onMove(0, 0);
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
}

makeStick('zone-left', 'knob-left', (x) => { state.steer = x; });
makeStick('zone-right', 'knob-right', (_, y) => {
  state.throttle = clamp(-y, 0, 1);
  state.brake = clamp(y, 0, 1);
});

// ---------------------------------------------------------------------------
// Room connection
// ---------------------------------------------------------------------------
const statusEl = $('status');
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'pill ' + cls;
}

let lastBanner = '';
function showBanner(text) {
  const el = $('phone-banner');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => el.classList.remove('show'), 3200);
}

const net = new RoomLink({
  onWelcome(msg) {
    state.slot = msg.slot;
    document.body.dataset.player = msg.slot === 2 ? 'p2' : 'p1';
    $('player-label').textContent = msg.slot === 1 ? 'PLAYER 1' : 'PLAYER 2';
    $('player-label').style.display = '';
    $('room-tag').textContent = 'ROOM ' + msg.code;
    setStatus(`Connected · Player ${msg.slot}`, 'ok');
    $('pads').classList.remove('locked');
    vibrate(30);
  },
  onMessage(msg) {
    if (msg.type === 'full') {
      state.full = true;
      setStatus('Room full — 2 joysticks already connected', 'err');
      $('full-note').style.display = '';
      return;
    }
    if (msg.type === 'error' && msg.code === 'no-room') {
      setStatus('Room not found', 'err');
      showJoinScreen('Room not found — check the code on the laptop screen.');
      return;
    }
    if (msg.type === 'telemetry' && msg.data) {
      const d = msg.data;
      $('speed-val').textContent = d.speed;
      $('nitro-fill').style.width = (d.nitro || 0) + '%';
      const lapBits = [];
      if (d.mode === 'race') lapBits.push(`Lap ${d.lap || ''}`);
      if (d.rank && d.mode === 'race') lapBits.push(d.rank);
      if (d.lastLap) lapBits.push(`Last ${d.lastLap}`);
      if (d.best) lapBits.push(`Best ${d.best}`);
      $('lap-info').textContent = lapBits.join('  ·  ');
      if (d.state === 'countdown') setStatus('Get ready…', 'wait');
      else if (d.state === 'waiting') setStatus('Waiting in lobby…', 'wait');
      else setStatus(`Connected · Player ${state.slot}${d.rank ? ' · ' + d.rank : ''}`, 'ok');
      if (d.banner && d.banner !== lastBanner) {
        lastBanner = d.banner;
        showBanner(d.banner);
        vibrate(40);
      }
      return;
    }
    if (msg.type === 'disconnected') setStatus('Reconnecting…', 'err');
  },
  onStatus(s) {
    if (state.full) return;
    if (s === 'connected') setStatus(`Connected${state.slot ? ' · Player ' + state.slot : ''}`, 'ok');
    else if (s === 'connecting') setStatus('Connecting…', 'wait');
    else setStatus('Reconnecting…', 'err');
  }
});

function showJoinScreen(errText) {
  $('join-screen').style.display = 'flex';
  $('pads').classList.add('locked');
  if (errText) $('join-error').textContent = errText;
}

function joinRoom(code) {
  $('join-screen').style.display = 'none';
  setStatus('Connecting…', 'wait');
  net.connect({ type: 'hello', role: 'controller', room: code.toUpperCase().trim() });
}

const wantedRoom = urlParam('room');
if (wantedRoom) {
  joinRoom(wantedRoom);
} else {
  showJoinScreen('');
}

$('join-btn').addEventListener('click', () => {
  const code = $('room-input').value.trim();
  if (code.length >= 4) joinRoom(code);
  else $('join-error').textContent = 'Enter the 5-letter room code shown on the laptop.';
});
$('room-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
function holdButton(id, down, up) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => {
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.classList.add('pressed');
    vibrate(14);
    down();
    e.preventDefault();
  });
  const release = () => { el.classList.remove('pressed'); if (up) up(); };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
}

holdButton('btn-hb', () => { state.hb = true; }, () => { state.hb = false; });
holdButton('btn-nitro', () => { state.nitro = true; vibrate(25); }, () => { state.nitro = false; });
holdButton('btn-cam', () => net.send({ type: 'button', action: 'cam', pressed: true }));
holdButton('btn-reset', () => net.send({ type: 'button', action: 'reset', pressed: true }));
holdButton('btn-horn', () => net.send({ type: 'button', action: 'horn', pressed: true }));

// send input at ~30 Hz
setInterval(() => {
  if (!net.isOpen() || state.full || state.slot == null) return;
  net.send({
    type: 'input',
    steer: dz(state.steer),
    throttle: dz(state.throttle),
    brake: dz(state.brake),
    handbrake: state.hb,
    nitro: state.nitro
  });
}, 33);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    state.steer = state.throttle = state.brake = 0;
    state.hb = state.nitro = false;
    net.send({ type: 'input', steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false });
  }
});

// ---------------------------------------------------------------------------
// Fullscreen + orientation + wake lock
// ---------------------------------------------------------------------------
$('btn-full').addEventListener('click', async () => {
  vibrate(10);
  try { await document.documentElement.requestFullscreen(); } catch (e) {}
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) {}
  try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) {}
});

document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => { if (e.scale !== 1) e.preventDefault(); }, { passive: false });

function checkOrientation() {
  $('rotate-hint').classList.toggle('show', window.innerHeight > window.innerWidth);
}
window.addEventListener('resize', checkOrientation);
checkOrientation();
