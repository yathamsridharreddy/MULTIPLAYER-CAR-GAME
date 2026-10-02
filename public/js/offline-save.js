/* ============================================================================
   SRIDHAR RUSH — SAVE FOR OFFLINE (v166)

   Offline mode (v165) made the RACE need no server. This makes the APP need no
   server: the service worker keeps every file the lobby, the cars, the maps and
   the arrows are drawn from, so the game opens from the home screen with the
   phone in aeroplane mode.

   What this file does:
     - registers the service worker EARLY (not on window.load, so a racer who
       lands and immediately goes offline still gets it), and asks it how much of
       the game is already saved;
     - owns the lobby's SAVE FOR OFFLINE button: the page hands the job to the
       service worker, the worker reports progress back, and the result is said
       out loud ("Saved - you can play with no internet now");
     - keeps the status line honest - how many files of the whole game are on the
       device, and whether it is complete;
     - shows a "SAVED ON THIS DEVICE" chip once the game really is complete, so a
       racer knows the icon on their home screen works in a tunnel.

   Nothing here touches racing. If the browser has no service worker (or the page
   is served over plain http on a LAN where it cannot run), every function is a
   graceful no-op and the game behaves exactly as v165 did.
   ========================================================================== */
(function (global) {
  'use strict';
  const document = global.document;

  const REG_OPTS = { scope: '/' };
  let reg = null;
  let status = { have: 0, total: 0, ready: false, build: null };
  const listeners = new Set();

  function supported() {
    return !!global.navigator && 'serviceWorker' in global.navigator &&
      (global.location.protocol === 'https:' || global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1');
  }

  function emit() {
    for (const fn of listeners) { try { fn(status); } catch (e) {} }
    paint();
  }

  function onStatus(fn) { listeners.add(fn); try { fn(status); } catch (e) {} }
  function getStatus() { return status; }

  // ---- the lobby chip --------------------------------------------------------
  // Wiring happens inside paint(), guarded by a flag: whichever comes first - the
  // DOM being ready, the worker answering, or a click - the control ends up
  // attached exactly once, and never depends on an event that may already have
  // fired (which is how a button can end up looking right and doing nothing).
  function wireButton() {
    const btn = document.getElementById('sr-offline-btn');
    if (btn && !btn._srWired) { btn._srWired = true; btn.addEventListener('click', save); }
  }
  function paint() {
    wireButton();
    const chip = document.getElementById('sr-offline-chip');
    if (chip) chip.hidden = !(supported() && status.total && status.have >= status.total);
    const btn = document.getElementById('sr-offline-btn');
    if (btn) {
      const busy = btn.dataset.busy === '1';
      btn.disabled = busy || !supported();
      const label = btn.querySelector('.lbl') || btn.querySelector('[data-i18n]') || btn;
      if (busy) label.textContent = 'SAVING… ' + Math.round((status.have / Math.max(1, status.total)) * 100) + '%';
      else if (status.ready) label.textContent = 'SAVED FOR OFFLINE';
      else if (status.total) label.textContent = 'SAVE FOR OFFLINE (' + Math.round((status.have / status.total) * 100) + '%)';
      else label.textContent = 'SAVE FOR OFFLINE';
    }
  }

  function askStatus() {
    if (!supported() || !global.navigator.serviceWorker.controller) return;
    try { global.navigator.serviceWorker.controller.postMessage({ type: 'sr-offline-status' }); } catch (e) {}
  }

  function save() {
    if (!supported() || !global.navigator.serviceWorker.controller) {
      if (typeof global.toast === 'function') global.toast('Offline saving needs the installed app (or a secure https page).');
      return false;
    }
    const btn = document.getElementById('sr-offline-btn');
    if (btn) btn.dataset.busy = '1';
    paint();
    try { global.navigator.serviceWorker.controller.postMessage({ type: 'sr-offline-save' }); } catch (e) {}
    if (typeof global.toast === 'function') global.toast('Saving the game for offline play — keep this page open a moment…');
    return true;
  }

  // ---- the worker's reports --------------------------------------------------
  if (global.navigator && global.navigator.serviceWorker) {
    global.navigator.serviceWorker.addEventListener('message', (e) => {
      const d = (e && e.data) || {};
      if (d.type === 'sr-offline-progress') {
        status.have = d.done; status.total = d.total; status.ready = d.done >= d.total;
        emit();
      } else if (d.type === 'sr-offline-done') {
        status.have = d.done; status.total = d.total; status.ready = !!d.ok;
        const btn = document.getElementById('sr-offline-btn');
        if (btn) btn.dataset.busy = '0';
        emit();
        if (typeof global.toast === 'function') {
          global.toast(d.ok
            ? '🏁 Saved — SRIDHAR RUSH now plays with no internet at all.'
            : 'Saved ' + d.done + ' of ' + d.total + ' files. ' + (d.failed && d.failed.length ? 'Some did not download — try again on a better connection.' : ''));
        }
      } else if (d.type === 'sr-offline-status') {
        status = Object.assign({}, status, d);
        emit();
      }
    });
  }

  function register() {
    if (!supported()) { paint(); return; }
    global.navigator.serviceWorker.register('/sw.js', REG_OPTS).then((r) => {
      reg = r;
      if (global.navigator.serviceWorker.controller) askStatus();
      else global.navigator.serviceWorker.addEventListener('controllerchange', () => { askStatus(); paint(); }, { once: true });
      paint();
    }).catch(() => { paint(); });
  }

  // the button lives in the lobby DOM; wire it as soon as the DOM is there
  function wire() { paint(); }
  // wire NOW (a deferred script runs after the markup exists), and again on
  // DOMContentLoaded in case this file is ever loaded earlier: paint() is
  // idempotent, so whichever runs first wins and the other is a no-op.
  wire();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);

  const API = { supported, save, status: getStatus, onStatus, register, askStatus, isReady: () => !!(status && status.ready) };
  global.SROfflineSave = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

  register();
})(typeof window !== 'undefined' ? window : globalThis);
