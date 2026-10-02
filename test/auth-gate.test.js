'use strict';
/* ============================================================================
   v119 account gate: sign up / sign in / forgot password between the main
   page and the game, with NO guest play on configured deploys.

   Pins:
   1. the recovery flows in account.js (recover / updatePassword /
      consumeRecovery) speak correct GoTrue REST and store sessions;
   2. index.html redirects to auth.html before any game script runs, but only
      when Supabase keys are configured (dev copies stay usable);
   3. the phone controller and replay viewer stay gate-free (room-code join);
   4. auth.html is a light standalone page (no three.js / game.js) styled by
      the shared site stylesheet;
   5. the service worker precaches the gate and never caches config.js.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function accountSandbox(loc, preStore) {
  const calls = [];
  const store = Object.assign({}, preStore || {});
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    location: Object.assign({ origin: 'https://x.test', pathname: '/auth.html', hash: '', search: '' }, loc || {}),
    history: { replaceState() {} },
    URLSearchParams,
    fetch: async (u, opt) => {
      calls.push({ url: String(u), opt: opt || {} });
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: 'u1', email: 'a@b.co' } })
      };
    }
  };
  sandbox.window = sandbox;
  sandbox.SB_U = 'https://sb.test'; sandbox.SB_A = 'anon';
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/account.js'), sandbox, { filename: 'account.js' });
  return { sb: sandbox, calls, store };
}

test('recover() posts a GoTrue recovery request with a redirect back to the gate', async () => {
  const { sb, calls } = accountSandbox();
  const r = await sb.SRAccount.recover('racer@example.com');
  assert.strictEqual(r.ok, true);
  const c = calls.find((x) => x.url.endsWith('/auth/v1/recover'));
  assert.ok(c, 'recover endpoint called');
  assert.strictEqual(c.opt.method, 'POST');
  const body = JSON.parse(c.opt.body);
  assert.strictEqual(body.email, 'racer@example.com');
  assert.ok(String(body.redirect_to).includes('/auth.html'), 'redirect_to points at the gate');
});

test('updatePassword() PUTs the new password with the bearer token', async () => {
  const { sb, calls, store } = accountSandbox({}, {
    sr_sb_session: JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_at: Math.floor(Date.now() / 1000) + 600, uid: 'u1', email: 'a@b.co' })
  });
  const r = await sb.SRAccount.updatePassword('new-pass-123');
  assert.strictEqual(r.ok, true);
  const c = calls.find((x) => x.url.endsWith('/auth/v1/user'));
  assert.ok(c, 'user endpoint called');
  assert.strictEqual(c.opt.method, 'PUT');
  assert.strictEqual(JSON.parse(c.opt.body).password, 'new-pass-123');
  assert.ok(c.opt.headers.Authorization.includes('Bearer AT'), 'bearer session token sent');
});

test('consumeRecovery() adopts a recovery token from the email link', () => {
  const { sb, store } = accountSandbox({ hash: '#access_token=RAT&refresh_token=RRT&expires_in=3600&type=recovery' });
  assert.strictEqual(sb.SRAccount.consumeRecovery(), true);
  const ses = JSON.parse(store.sr_sb_session);
  assert.strictEqual(ses.access_token, 'RAT');
  // without type=recovery nothing is adopted
  const b = accountSandbox({ hash: '#access_token=X&type=signup' });
  assert.strictEqual(b.sb.SRAccount.consumeRecovery(), false);
});

test('login() stores the session under the key the index gate checks', async () => {
  const { sb, store } = accountSandbox();
  const r = await sb.SRAccount.login('a@b.co', 'pw12345678');
  assert.strictEqual(r.ok, true);
  assert.ok(store.sr_sb_session, 'session persisted');
  const idx = read('public/index.html');
  assert.ok(idx.includes("localStorage.getItem('sr_sb_session')"), 'gate reads the same key');
});

test('index.html gates the game behind auth.html, after config, before game boot', () => {
  const idx = read('public/index.html');
  const iCfg = idx.indexOf('<script src="js/config.js"></script>');
  const iGate = idx.indexOf('v119 ACCOUNT GATE');
  const iGame = idx.indexOf('js/game.js');
  assert.ok(iCfg > 0 && iGate > iCfg && iGame > iGate, 'gate runs after config, before game.js');
  assert.ok(idx.includes("location.replace('auth.html?next='"), 'redirect to the gate');
  assert.ok(idx.includes("String(window.SB_U || '').trim() && String(window.SB_A || '').trim()"), 'only on configured deploys');
});

test('phone controller and replay stay gate-free', () => {
  for (const f of ['public/controller.html', 'public/replay.html']) {
    const t = read(f);
    assert.ok(!t.includes('auth.html?next'), f + ' must not redirect to the gate');
  }
});

test('auth.html is a light standalone gate styled by the shared stylesheet', () => {
  const a = read('public/auth.html');
  assert.ok(a.includes('css/style.css'), 'shared stylesheet');
  assert.ok(a.includes('js/config.js') && a.includes('js/account.js') && a.includes('js/auth.js'), 'gate scripts');
  assert.ok(!a.includes('three.min.js') && !a.includes('game.js'), 'no game engine on the gate');
  for (const v of ['view-signin', 'view-signup', 'view-forgot', 'view-reset', 'view-confirm', 'view-sent', 'view-noauth']) {
    assert.ok(a.includes('id="' + v + '"'), v + ' present');
  }
  assert.ok(a.includes('Forgot password?'), 'forgot-password entry point');
  // v120: every password field carries an eye visibility toggle
  for (const fid of ['si-pass', 'su-pass', 'su-pass2', 'rs-pass', 'rs-pass2']) {
    assert.ok(a.includes('data-eye="' + fid + '"'), 'eye toggle for ' + fid);
  }
  const aj = read('public/js/auth.js');
  assert.ok(aj.includes("querySelectorAll('.a-eye')"), 'eye toggles wired');
});

test('service worker precaches the gate but never the injected config', () => {
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/auth.html'"), 'gate precached');
  // version-agnostic: pinning a literal here means every release breaks this file
  assert.ok(/\/js\/auth\.js\?v=\d+/.test(sw), 'gate controller precached');
  assert.ok(sw.includes("NOCACHE = ['/js/config.js'"), 'config stays live');
  assert.ok(/const CACHE = 'sridhar-rush-v\d+'/.test(sw), 'cache name is versioned');
});

test('v121: the server refuses guest handshakes; controllers stay open', () => {
  const srv = read('server.js');
  assert.ok(srv.includes('async function handleMessage'), 'handler async for the gate');
  assert.ok(srv.includes("msg.role !== 'controller' && sbOn() && !client.uid"), 'gate condition');
  assert.ok(srv.includes("{ type: 'auth-required' }"), 'auth-required response');
  assert.ok(srv.includes('await verifyUid(msg.tok)'), 'JWT verified before any slot');
  const net = read('public/js/net.js');
  assert.ok(net.includes("msg.type === 'auth-required'"), 'client honours auth-required');
  assert.ok(net.includes("location.replace('auth.html')"), 'client bounces to the gate');
  const g = read('public/js/game.js');
  assert.ok(g.includes('SRAccount.available() && !SRAccount.loggedIn()'), 'sendHello guard');
  assert.ok(!g.includes("'👤 guest'"), 'no guest chip string');
  assert.ok(!g.includes("prefs.name || 'guest'"), 'no guest identity fallback');
});

test('v122: sign out returns to the gate and clears name', () => {
  const acc = read('public/js/account.js');
  assert.ok(acc.includes("localStorage.removeItem(NKEY)"), 'logout clears stored name');
  const g = read('public/js/game.js');
  assert.ok(g.includes("location.replace('auth.html')") && g.includes('account-out'), 'sign out bounces to the gate');
});

test('the game itself stays auth-agnostic', () => {
  const g = read('public/js/game.js');
  // v121: game.js now bounces unauthenticated sockets to the gate via SRAccount,
  // but does NOT implement its own localStorage gate (that's index.html's job).
  assert.ok(g.includes('auth.html'), 'game.js bounces unauthenticated to the gate (v121)');
  assert.ok(g.includes('SRAccount.available()'), 'uses account API, not raw localStorage gate');
  assert.ok(!g.includes("localStorage.getItem('sr_sb_session')"), 'game.js does not duplicate the index gate');
  assert.ok(/const BUILD = 'v\d+';/.test(g), 'build marker');
});
