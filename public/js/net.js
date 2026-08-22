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
  }
  status(s) { if (this.handlers.onStatus) this.handlers.onStatus(s); }
  connect(hello) {
    if (hello) this.hello = hello;
    this.closedByUser = false;
    this._dial();
  }
  _dial() {
    if (this.closedByUser) return;
    this.status('connecting');
    let ws;
    try { ws = new WebSocket(serverWsUrl()); } catch (e) { return this._retry(); }
    const self = this;
    ws.onopen = () => { if (self.hello) { try { ws.send(JSON.stringify(self.hello)); } catch (e) {} } };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'welcome') {
        self.ws = ws; self.open = true; self.delay = 800;
        self.status('connected');
        if (self.handlers.onWelcome) self.handlers.onWelcome(msg);
      } else if (self.open || msg.type === 'error' || msg.type === 'full') {
        if (self.handlers.onMessage) self.handlers.onMessage(msg);
      }
    };
    ws.onclose = () => {
      const wasOpen = self.open;
      self.open = false; self.ws = null;
      if (wasOpen && self.handlers.onMessage) self.handlers.onMessage({ type: 'disconnected' });
      self.status('reconnecting');
      self._retry();
    };
    ws.onerror = () => {};
  }
  _retry() {
    if (this.closedByUser) return;
    const self = this;
    setTimeout(() => self._dial(), this.delay);
    this.delay = Math.min(this.delay * 1.7, 8000);
  }
  send(msg) {
    if (this.open && this.ws) { try { this.ws.send(JSON.stringify(msg)); } catch (e) {} }
  }
  isOpen() { return this.open; }
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
