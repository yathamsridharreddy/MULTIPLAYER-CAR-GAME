'use strict';

/* RoomLink — WebSocket client for the online multiplayer server. */

function serverWsUrl() {
  let cfg = (window.SERVER_URL || 'local').trim();
  if (cfg === 'local') {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }
  // Tolerate env values saved without a scheme (e.g. "app.up.railway.app")
  if (!/^(https?|wss?):\/\//i.test(cfg)) cfg = 'https://' + cfg;
  cfg = cfg.replace(/\/+$/, '');
  return cfg.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/ws';
}

class RoomLink {
  constructor(handlers) {
    this.handlers = handlers || {};
    this.ws = null;
    this.open = false;
    this.hello = null;
    this.delay = 800;
    this.closedByUser = false;
    this._retryTimer = null;
    // v140 PRODUCTION FIX — connection generation.
    // Every dial gets a generation number and every socket callback checks it.
    // Before this, a socket that was still CONNECTING when a retry fired stayed
    // alive with live handlers: its onmessage could publish `welcome` from the dead
    // attempt, and its onclose reset open/ws on the *current* connection - which
    // nulled the live socket and triggered yet another retry. That is a reconnect
    // storm: duplicate joins, players appearing twice, cars teleporting, and the UI
    // flapping between connected and reconnecting. A stale socket is now inert and
    // is closed as soon as it tries to talk.
    this._gen = 0;
    this._watchdog = null;
    this._pending = null;      // the socket currently dialing (this.ws is set on welcome)
    // v140: liveness. A mobile socket can be half-open - the OS or a carrier NAT
    // drops it with no FIN, so no close event ever fires and the peer has no idea.
    // We watch the inbound stream instead: a connected link is never silent (the
    // server pushes snapshots at 30 Hz and answers our ping every 2 s), so silence
    // on a supposedly open socket means it is dead and we must re-dial.
    this._lastRx = 0;
    this._liveness = null;
  }
  _armLiveness() {
    if (this._liveness) return;
    const self = this;
    this._liveness = setInterval(() => {
      if (!self.open) { self._lastRx = performance.now(); return; }
      if (performance.now() - self._lastRx > 15000) {
        // silent for 15 s: retire this socket and dial again (the epoch guard in
        // _dial() makes the replacement safe even if the old one wakes up later)
        self._lastRx = performance.now();
        self.status('reconnecting');
        self._dial();
      }
    }, 3000);
  }
  status(s) { if (this.handlers.onStatus) this.handlers.onStatus(s); }
  connect(hello) {
    if (hello) this.hello = hello;
    this.closedByUser = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._dial();
  }
  _dial() {
    if (this.closedByUser) return;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
    // retire whatever came before - BOTH the live socket and any dial still in
    // flight (this.ws is only assigned once a welcome arrives, so a CONNECTING
    // socket would otherwise survive the re-dial with its handlers intact)
    const gen = ++this._gen;
    for (const old of [this.ws, this._pending]) {
      if (!old) continue;
      try { old.onopen = old.onmessage = old.onclose = old.onerror = null; old.close(); } catch (e) {}
    }
    this.ws = null; this._pending = null;
    this.open = false;
    this.status('connecting');
    this._armLiveness();
    let ws;
    try { ws = new WebSocket(serverWsUrl()); } catch (e) { return this._retry(); }
    this._pending = ws;
    const self = this;
    const retire = () => { if (self._pending === ws) self._pending = null; };
    // a dial that never produces a welcome (cold free-tier server, a dropped SYN on
    // mobile, a proxy that swallows the upgrade) used to hang on "connecting"
    // forever. Now it is abandoned and retried with the normal backoff.
    this._watchdog = setTimeout(() => {
      if (gen !== self._gen || self.open) return;
      retire();
      try { ws.close(); } catch (e) {}
      self._retry();
    }, 15000);
    const stale = () => { if (gen !== self._gen) { try { ws.close(); } catch (e) {} return true; } return false; };
    ws.onopen = () => {
      if (stale()) return;
      if (self.hello) { try { ws.send(JSON.stringify(self.hello)); } catch (e) {} }
    };
    ws.onmessage = (ev) => {
      if (stale()) return;
      self._lastRx = performance.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'auth-required') {          // v121: server rejected a guest
        try { if (window.SRAccount && SRAccount.logout) SRAccount.logout(); } catch (e) {}
        try { location.replace('auth.html'); } catch (e) {}
        return;
      }
      if (msg.type === 'welcome' || msg.type === 'lobby_welcome') {
        self._pending = null;
        self.ws = ws; self.open = true; self.delay = 800; self._lastRx = performance.now();
        if (self._watchdog) { clearTimeout(self._watchdog); self._watchdog = null; }
        self.status('connected');
        if (self.handlers.onWelcome) self.handlers.onWelcome(msg);
      } else if (self.open || msg.type === 'error' || msg.type === 'full') {
        if (self.handlers.onMessage) self.handlers.onMessage(msg);
      }
    };
    ws.onclose = () => {
      if (gen !== self._gen) return;               // a retired socket must not touch live state
      retire();
      const wasOpen = self.open;
      self.open = false; self.ws = null;
      if (self._watchdog) { clearTimeout(self._watchdog); self._watchdog = null; }
      if (wasOpen && self.handlers.onMessage) self.handlers.onMessage({ type: 'disconnected' });
      self.status('reconnecting');
      self._retry();
    };
    ws.onerror = () => {};
  }
  _retry() {
    if (this.closedByUser) return;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    const self = this;
    this._retryTimer = setTimeout(() => self._dial(), this.delay);
    this.delay = Math.min(this.delay * 1.7, 8000);
  }
  send(msg) {
    if (this.open && this.ws && this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(JSON.stringify(msg)); } catch (e) {} }
  }
  close() {
    this.closedByUser = true;
    this._gen++;                                    // retire in-flight dials too
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
    for (const w of [this.ws, this._pending]) {
      if (!w) continue;
      try { w.onopen = w.onmessage = w.onclose = w.onerror = null; w.close(); } catch (e) {}
    }
    this.ws = null; this._pending = null;
    this.open = false;
    if (this._liveness) { clearInterval(this._liveness); this._liveness = null; }
    this.status('disconnected');
  }
  // v140: used on returning from a backgrounded tab, where the socket can be a
  // half-open zombie that never fires close and leaves the race rendering a dead world.
  reconnect(hello) {
    if (this.open) return;
    this.connect(hello);
  }
  isOpen() { return this.open && this.ws && this.ws.readyState === WebSocket.OPEN; }
}

function urlParam(name) {
  try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}
