'use strict';
/* ============================================================================
   v144 - the driver name belongs to the ACCOUNT, not to the browser.

   The reported bug: a racer signs in and the lobby still shows a placeholder
   ("RACER1234"), so it looks like the wrong account is signed in - and if they
   rename themselves, the change lives only on that one device.

   Pins, in the order the bug bites:
     1. session() adopts the account's stored name (so the first paint after
        sign-in is already correct);
     2. the name comes from profiles.display_name, falling back to the unique
        username handle on a database without the v144 column;
     3. a rename PATCHes the account's own row, on the debounced path shared by
        every edit surface;
     4. SIGN IN never writes the profile - previously it upserted the row with
        whatever the device had locally, which could rename the account;
     5. signing out drops the cached name so it can never leak to the next
        racer on a shared device;
     6. the schema carries display_name, and the migration is idempotent.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const GAME = read('public/js/game.js');
const HTML = read('public/index.html');

// A sandbox whose fetch answers the endpoints account.js actually uses, so the
// behaviour can be exercised rather than string-matched.
function sandbox(opts) {
  const o = opts || {};
  const calls = [];
  const store = Object.assign({
    sr_sb_session: JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: Math.floor(Date.now() / 1000) + 3600, uid: 'u1', email: 'a@b.co'
    })
  }, o.store || {});
  const profileRow = o.profile === undefined ? { username: 'Sridhar', display_name: 'Sridhar R' } : o.profile;
  const s = {
    console: { warn() {}, log() {}, error() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    location: { origin: 'https://x.test', pathname: '/', hash: '', search: '' },
    history: { replaceState() {} },
    URLSearchParams,
    setTimeout, clearTimeout,
    fetch: async (u, opt) => {
      const url = String(u);
      calls.push({ url, opt: opt || {} });
      if (url.includes('/auth/v1/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: 'u1', email: 'a@b.co' } }) };
      }
      if (url.includes('/rest/v1/profiles')) {
        if (o.noColumn && url.includes('display_name') && !(opt && opt.method === 'PATCH')) {
          return { ok: false, status: 400, json: async () => ({ code: '42703', message: 'column profiles.display_name does not exist' }) };
        }
        if ((opt && opt.method) === 'PATCH') {
          if (o.noColumn) return { ok: false, status: 400, json: async () => ({ code: 'PGRST204', message: "Could not find the 'display_name' column" }) };
          if (o.patchStatus && o.patchStatus !== 200) {
            return { ok: false, status: o.patchStatus, json: async () => (o.patchBody || { message: 'conflict' }) };
          }
          if (o.noRow) return { ok: true, status: 200, json: async () => [] };
          const body = JSON.parse(opt.body);
          return { ok: true, status: 200, json: async () => ([Object.assign({ username: 'Sridhar' }, body)]) };
        }
        return { ok: true, status: 200, json: async () => (profileRow ? [profileRow] : []) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };
  s.window = s;
  s.SRProg = { validUsername: (u) => typeof u === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(u) };
  s.SB_U = 'https://sb.test'; s.SB_A = 'anon';
  vm.createContext(s);
  vm.runInContext(read('public/js/account.js'), s, { filename: 'account.js' });
  return { sb: s, calls, store };
}

test('v144: session() adopts the name stored on the account', async () => {
  const { sb, store } = sandbox();
  const s = await sb.SRAccount.session();
  assert.equal(s.name, 'Sridhar R', 'the account display name is returned');
  assert.equal(sb.SRAccount.name(), 'Sridhar R', 'and mirrored locally for the UI to read');
  assert.equal(store.sr_sb_name, 'Sridhar R', 'the local mirror is what the lobby reads');
});

test('v144: the account name wins over whatever this device had stored', async () => {
  const { sb } = sandbox({ store: { sr_sb_name: 'RACER1234' } });
  assert.equal(sb.SRAccount.name(), 'RACER1234', 'precondition: local placeholder');
  await sb.SRAccount.session();
  assert.equal(sb.SRAccount.name(), 'Sridhar R', 'the account name replaces the placeholder');
});

test('v144: an account with only a username handle still names the racer', async () => {
  const { sb } = sandbox({ profile: { username: 'Sridhar', display_name: null } });
  const s = await sb.SRAccount.session();
  assert.equal(s.name, 'Sridhar', 'falls back to the unique handle');
});

test('v144: loadProfile tolerates a database without the display_name column', async () => {
  const { sb, calls } = sandbox({ noColumn: true, profile: { username: 'Sridhar' } });
  const s = await sb.SRAccount.session();
  assert.equal(s.name, 'Sridhar', 'the retry without display_name succeeds');
  const profileCalls = calls.filter((c) => c.url.includes('/rest/v1/profiles'));
  assert.ok(profileCalls.some((c) => /select=username$/.test(c.url)), 'retried with username only');
  assert.ok(profileCalls.some((c) => c.url.includes('select=username,display_name')), 'tried display_name first');
});

test('v144: saveName() PATCHes the account row with the bearer token', async () => {
  const { sb, calls } = sandbox();
  const r = await sb.SRAccount.saveName('SR Racer');
  assert.equal(r.ok, true);
  const patch = calls.find((c) => c.opt.method === 'PATCH');
  assert.ok(patch, 'a PATCH was sent');
  assert.ok(patch.url.includes('/rest/v1/profiles?id=eq.u1'), 'targets this racer\'s own row: ' + patch.url);
  assert.equal(JSON.parse(patch.opt.body).display_name, 'SR Racer', 'the free-form name is stored as-is');
  assert.ok(String(patch.opt.headers.Authorization).includes('Bearer AT'), 'authenticated as the racer');
  assert.equal(sb.SRAccount.name(), 'SR Racer', 'mirrored locally too');
});

test('v144: saveName() refuses a name the account cannot hold', async () => {
  const { sb, calls } = sandbox();
  const r = await sb.SRAccount.saveName('A');
  assert.equal(r.error, 'BADNAME');
  assert.ok(!calls.some((c) => c.opt.method === 'PATCH'), 'nothing was written');
});

test('v144: saveName() reports a taken name instead of silently renaming', async () => {
  const { sb } = sandbox({ patchStatus: 409, patchBody: { code: '23505', message: 'duplicate key' } });
  const r = await sb.SRAccount.saveName('Sridhar');
  assert.equal(r.error, 'TAKEN');
});

test('v144: saveName() falls back to the handle on an unmigrated database', async () => {
  const { sb, calls } = sandbox({ noColumn: true });
  const r = await sb.SRAccount.saveName('SR Racer');
  assert.equal(r.ok, true, 'the name still saves');
  const upsert = calls.find((c) => c.opt.method === 'POST');
  assert.ok(upsert, 'wrote through the username column instead');
  assert.equal(JSON.parse(upsert.opt.body).username, 'SR_Racer', 'reduced to a valid handle');
});

test('v144: signed out, a name change stays local and writes nothing', async () => {
  const { sb, calls } = sandbox({ store: { sr_sb_session: 'null' } });
  const r = await sb.SRAccount.saveName('Solo Racer');
  assert.equal(r.ok, true);
  assert.equal(r.local, true, 'flagged as local-only');
  assert.ok(!calls.some((c) => c.opt.method === 'PATCH'), 'no request without a session');
});

test('v144: logout() forgets the cached account name', () => {
  const { sb, store } = sandbox();
  sb.SRAccount.setName('Sridhar R');
  sb.SRAccount.logout();
  assert.equal(sb.SRAccount.name(), '', 'name cleared');
  assert.ok(!store.sr_sb_name, 'nothing left on the device');
});

// ---- the client wiring -----------------------------------------------------
test('v144: SIGN IN never writes the profile - only CREATE does', () => {
  const doIt = GAME.slice(GAME.indexOf('function doIt(fn, isLogin)'), GAME.indexOf('function handleName('));
  assert.ok(doIt.length > 0, 'the account dialog handler exists');
  const loginBranch = doIt.slice(doIt.indexOf('if (isLogin)'), doIt.indexOf('// CREATE:'));
  assert.ok(loginBranch.includes('adoptName()'), 'sign-in adopts the account name');
  assert.ok(!loginBranch.includes('ensureProfile('), 'sign-in must not upsert the profile row');
  const createBranch = doIt.slice(doIt.indexOf('// CREATE:'));
  assert.ok(createBranch.includes('ensureProfile('), 'sign-up binds the handle');
});

test('v144: every place a driver name can be edited saves it to the account', () => {
  assert.ok(/function persistDriverName\(\)/.test(GAME), 'one shared writer exists');
  // the field is bound once, at boot - binding it inside wireLobbyV2() (which only
  // runs on the first server snapshot) left it inert until a state frame arrived.
  const bind = GAME.slice(GAME.indexOf('function bindDriverNameField()'), GAME.indexOf('function paintIdentity()'));
  assert.ok(bind.includes('_srNameBound'), 'binding is idempotent');
  assert.ok(bind.includes('persistDriverName()'), 'the DRIVER IDENTITY field persists to the account');
  const inp = GAME.slice(GAME.indexOf("const nameEl = $('inp-name')"));
  assert.ok(inp.slice(0, 400).includes('bindDriverNameField()'), 'the lobby uses the shared binding');
  assert.ok(!inp.slice(0, 400).includes("addEventListener('input'"), 'and does not bind a second handler');
  const accField = GAME.slice(GAME.indexOf("const nameField = $('acc-name')"));
  assert.ok(accField.slice(0, 400).includes('persistDriverName()'), 'the account dialog field persists');
  assert.ok(!/function doIt\(fn\) \{/.test(GAME), 'no older one-argument handler left behind');
});

test('v144: the identity is painted at page load, not on the first snapshot', () => {
  // the reported symptom: the lobby showed index.html\'s static "👤 racer" until
  // the server sent a state frame (updateLobby -> wireLobbyV2).
  const at = GAME.indexOf("paintIdentity");
  assert.ok(at > 0, 'paintIdentity exists');
  const hook = GAME.indexOf("document.addEventListener('DOMContentLoaded', paintIdentity)");
  assert.ok(hook > 0, 'it runs at boot');
  const boot = GAME.slice(hook, hook + 200);
  assert.ok(boot.includes('else paintIdentity()'), 'and immediately when the DOM is already parsed');
  const wired = GAME.indexOf('if (!lobbyWired) { lobbyWired = true; wireLobbyV2(); }');
  assert.ok(wired > 0, 'the lazy lobby wiring is unchanged');
  assert.ok(GAME.indexOf('paintIdentity') < wired, 'the identity paint is not behind that gate');
});

test('v144: the account dialog opens showing the current name', () => {
  const at = GAME.indexOf('if (btn) btn.addEventListener');
  const block = GAME.slice(at, at + 700);
  assert.ok(block.includes("nEl.value = acc.name() || prefs.name"), 'field prefilled from the account');
  assert.ok(block.includes('acc-err'), 'and the error line is cleared');
});

test('v144: the profile dialog prefers the display name', () => {
  assert.ok(GAME.includes('select=username,display_name'), 'reads the display name');
  const at = GAME.indexOf('const pName =');
  assert.ok(at > 0, 'display-name resolution exists');
  const block = GAME.slice(at, at + 200);
  assert.ok(block.includes('p.display_name || p.username'), 'display name wins, handle is the fallback');
  assert.ok(block.includes('escapeHtml(pName)') || GAME.includes('escapeHtml(pName)'), 'rendered escaped');
});

test('v144: index.html does not hard-code a placeholder as the driver name', () => {
  const input = HTML.slice(HTML.indexOf('id="inp-name"'), HTML.indexOf('id="inp-name"') + 300);
  assert.ok(!/value="/.test(input), 'the field starts empty and is filled from the account');
});

// ---- schema ---------------------------------------------------------------
test('v144: profiles carries display_name in both the schema and the migration', () => {
  const setup = read('supabase-setup.sql');
  assert.ok(/create table if not exists public\.profiles/.test(setup), 'profiles is declared');
  const block = setup.slice(setup.indexOf('create table if not exists public.profiles'));
  assert.ok(block.slice(0, 900).includes('display_name text'), 'display_name declared on the table');
  const mig = read('supabase-migration-v144.sql');
  assert.ok(mig.includes('add column display_name text'), 'migration adds the column');
  assert.ok(/add column if not exists display_name/.test(mig) || /if not exists \(/.test(mig), 'idempotent');
  assert.ok(mig.includes('display_name = username'), 'existing accounts are backfilled so no name changes');
  assert.ok(mig.includes("profiles own u") || mig.includes('Row level security'), 'RLS is addressed');
});
