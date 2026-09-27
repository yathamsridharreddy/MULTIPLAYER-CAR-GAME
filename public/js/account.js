'use strict';
/* ============================================================================
   SRIDHAR RUSH — optional racer accounts (v37)
   Tiny Supabase auth client using plain fetch (no SDK, no extra download).
   Only active when the page provides window.SUPABASE_URL + window.SUPABASE_ANON
   (injected into js/config.js by the deploy). Without them, SRAccount
   reports available()=false and the game behaves exactly like before.
   ========================================================================== */
(function () {
  const url = String(window.SB_U || window.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(window.SB_A || window.SUPABASE_ANON || '');
  const SKEY = 'sr_sb_session';
  const NKEY = 'sr_sb_name';
  let ses = null;
  // v144: the driver name belongs to the ACCOUNT (profiles.display_name) so it
  // follows the racer to any device. NKEY above is only the local mirror the UI
  // can read synchronously; it is written from the profile, never the reverse.
  let prof = null;         // cached profiles row for profUid, or null = no row
  let profUid = '';        // which account the cache describes
  let profLoaded = false;  // true once a fetch has actually answered for profUid
  let hasDisplay = true;   // false once the DB proves it has no display_name column
  try { ses = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { ses = null; }

  function save(s) {
    ses = s;
    try { if (s) localStorage.setItem(SKEY, JSON.stringify(s)); else localStorage.removeItem(SKEY); } catch (e) {}
  }
  const hdrs = (tok) => ({ apikey: key, Authorization: 'Bearer ' + (tok || key), 'Content-Type': 'application/json' });
  const isExp = () => !ses || !ses.access_token || (ses.expires_at && (Date.now() / 1000) > ses.expires_at - 30);

  async function refresh() {
    if (!ses || !ses.refresh_token) return false;
    try {
      const r = await fetch(url + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: hdrs(), body: JSON.stringify({ refresh_token: ses.refresh_token }),
      });
      if (!r.ok) return false;
      const j = await r.json();
      save({
        access_token: j.access_token, refresh_token: j.refresh_token,
        expires_at: (Date.now() / 1000) + (j.expires_in || 3600),
        uid: (j.user && j.user.id) || ses.uid || '', email: (j.user && j.user.email) || ses.email || '',
      });
      return true;
    } catch (e) { return false; }
  }
  async function ensure() { if (!isExp()) return true; return refresh(); }

  // profiles.username is the unique HANDLE (DB CHECK: ^[A-Za-z0-9_]{3,16}$), so a
  // free-form driver name has to be reduced to one when that column is the only
  // place to put it.
  const handleFor = (n) => String(n == null ? '' : n).replace(/[^A-Za-z0-9_]/g, '_').replace(/_{2,}/g, '_').slice(0, 16);

  window.SRAccount = {
    available: () => !!(url && key),
    loggedIn: () => !!(ses && ses.access_token),
    uid: () => (ses && ses.uid) || null,
    token: () => (ses && ses.access_token) || null, // v73: sent to the relay for server-side verification
    email: () => (ses && ses.email) || '',
    name: () => { try { return localStorage.getItem(NKEY) || ''; } catch (e) { return ''; } },
    setName: (n) => { try { localStorage.setItem(NKEY, String(n).slice(0, 16)); } catch (e) {} },

    // v144: read the account's stored name (profiles.display_name, falling back to
    // the username handle). Returns the row, or null when the account has none.
    // A database that has not had supabase-migration-v144.sql run yet answers 400
    // for display_name, so the select retries without it instead of failing.
    async loadProfile(force) {
      if (!this.available() || !this.loggedIn() || !this.uid()) return null;
      await ensure();
      if (!ses || !ses.access_token) return null;
      if (!force && profLoaded && profUid === ses.uid) return prof;
      const cols = hasDisplay ? 'username,display_name' : 'username';
      try {
        const r = await fetch(url + '/rest/v1/profiles?id=eq.' + encodeURIComponent(ses.uid) + '&select=' + cols,
          { headers: hdrs(ses.access_token) });
        if (r.status === 400 && hasDisplay) { hasDisplay = false; return this.loadProfile(true); }
        if (!r.ok) return profLoaded ? prof : null;      // transient failure: keep what we had
        const rows = await r.json().catch(() => []);
        profUid = ses.uid;
        profLoaded = true;
        prof = (Array.isArray(rows) && rows[0]) || null;
        return prof;
      } catch (e) { return profLoaded ? prof : null; }
    },

    // v144: pull the account's name onto this device. This is the fix for a
    // signed-in racer seeing a placeholder ("RACER1234") on a fresh device: the
    // name is on the account, so it is known before anything is typed.
    async adoptName() {
      const p = await this.loadProfile();
      const n = String((p && (p.display_name || p.username)) || '').trim();
      if (n && n !== this.name()) this.setName(n);
      return n;
    },

    // v144: PATCH this account's own profile row (RLS "profiles own u").
    // Distinguishes "column missing" (pre-v144 database) from a real failure so
    // the caller can fall back instead of silently dropping the change.
    async _profileWrite(body) {
      try {
        const r = await fetch(url + '/rest/v1/profiles?id=eq.' + encodeURIComponent(ses.uid), {
          method: 'PATCH',
          headers: Object.assign(hdrs(ses.access_token), { Prefer: 'return=representation' }),
          body: JSON.stringify(body),
        });
        if (r.ok) {
          const rows = await r.json().catch(() => []);
          if (Array.isArray(rows) && rows.length) return { ok: true, row: rows[0] };
          return { error: 'NOROW' };                     // account has no profile row yet
        }
        const j = await r.json().catch(() => ({}));
        if (r.status === 400 && (j.code === 'PGRST204' || /column|schema cache/i.test(j.message || ''))) {
          return { error: 'NOCOLUMN' };
        }
        if (r.status === 409 || j.code === '23505') return { error: 'TAKEN' };
        return { error: j.message || ('FAIL ' + r.status) };
      } catch (e) { return { error: 'NETWORK' }; }
    },

    // v144: save a driver-name change TO THE ACCOUNT, so it is the same name on
    // the next device and after the next sign-in. Signed out, it stays local.
    async saveName(raw) {
      const name = String(raw == null ? '' : raw).trim().slice(0, 16);
      if (name.length < 2) return { error: 'BADNAME', msg: 'Driver name needs at least 2 characters.' };
      if (!this.loggedIn() || !this.uid()) { this.setName(name); return { ok: true, local: true }; }
      await ensure();
      if (!ses || !ses.access_token) return { error: 'NOAUTH' };
      const handle = handleFor(name);

      if (hasDisplay) {
        let r = await this._profileWrite({ display_name: name });
        if (r.error === 'NOROW') {
          // first save for this account: create the row, then store the name
          if (!(window.SRProg && SRProg.validUsername(handle))) {
            return { error: 'BADNAME', msg: 'Use 3+ letters, numbers or _ in the driver name.' };
          }
          const cr = await this.ensureProfile(handle);
          if (cr.error) return cr;
          r = await this._profileWrite({ display_name: name });
        }
        if (r.ok) { prof = r.row; profUid = ses.uid; profLoaded = true; this.setName(name); return { ok: true }; }
        if (r.error === 'TAKEN') return { error: 'TAKEN' };
        if (r.error !== 'NOCOLUMN') return r;
        hasDisplay = false;   // the v144 migration has not been run on this database
      }

      // Fallback (pre-v144 database): the name goes into the unique handle column,
      // which is what this client did before, so nothing regresses.
      if (!(window.SRProg && SRProg.validUsername(handle))) {
        return { error: 'BADNAME', msg: 'Use 3+ letters, numbers or _ in the driver name.' };
      }
      const cr = await this.ensureProfile(handle);
      if (cr.error) return cr;
      this.setName(name);
      return { ok: true };
    },

    // resolves the current session (refreshing the token if needed)
    async session() {
      if (!this.available()) return null;
      await ensure();
      if (!this.loggedIn()) return null;
      // v144: the account's name is authoritative. Adopting it HERE means every
      // caller - the lobby chip, identityPayload(), the club lookups - gets the
      // racer's real name without having to know where it is stored.
      await this.adoptName();
      return { uid: ses.uid, email: ses.email, name: this.name() };
    },

    async signup(email, password, name) {
      try {
        const r = await fetch(url + '/auth/v1/signup', {
          method: 'POST', headers: hdrs(), body: JSON.stringify({ email, password }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { error: j.msg || j.error_description || ('Signup failed (' + r.status + ')') };
        if (j.access_token) {
          save({
            access_token: j.access_token, refresh_token: j.refresh_token,
            expires_at: (Date.now() / 1000) + (j.expires_in || 3600),
            uid: (j.user && j.user.id) || j.id, email,
          });
          this.setName(name);
          prof = null; profUid = (j.user && j.user.id) || j.id || ''; profLoaded = false;
          return { ok: true };
        }
        // email confirmation enabled on the project -> user must confirm first
        return { error: 'CHECK_EMAIL', msg: 'Account created — confirm your email, then SIGN IN.' };
      } catch (e) { return { error: 'NETWORK' }; }
    },

    async login(email, password) {
      try {
        const r = await fetch(url + '/auth/v1/token?grant_type=password', {
          method: 'POST', headers: hdrs(), body: JSON.stringify({ email, password }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { error: j.error_description || j.msg || 'Sign-in failed — check email & password.' };
        save({
          access_token: j.access_token, refresh_token: j.refresh_token,
          expires_at: (Date.now() / 1000) + (j.expires_in || 3600),
          uid: (j.user && j.user.id) || '', email: (j.user && j.user.email) || email,
        });
        prof = null; profUid = ''; profLoaded = false;   // v144: new account, re-read its name
        return { ok: true };
      } catch (e) { return { error: 'NETWORK' }; }
    },

    // v73: bind a unique username to the authenticated identity.
    // RLS allows insert/update of OWN profile row only; the DB CHECK + UNIQUE
    // constraints are the server-side truth for validity & duplicates.
    async ensureProfile(username) {
      if (!this.loggedIn()) return { error: 'NOAUTH' };
      if (!(window.SRProg && window.SRProg.validUsername(username))) return { error: 'BADNAME' };
      await ensure();
      if (!ses || !ses.access_token) return { error: 'NOAUTH' };
      try {
        const r = await fetch(url + '/rest/v1/profiles', {
          method: 'POST',
          headers: Object.assign(hdrs(ses.access_token), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify({ id: this.uid(), username: String(username) }),
        });
        if (r.ok) return { ok: true };
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 || j.code === '23505') return { error: 'TAKEN' };
        return { error: j.message || ('FAIL ' + r.status) };
      } catch (e) { return { error: 'NETWORK' }; }
    },

    // v119: forgot-password flow (GoTrue REST, no SDK).
    // Sends the recovery mail; the link in it returns to /auth.html carrying
    // either #access_token=...&type=recovery (implicit) or a PKCE code that
    // leaves a recovery session behind - consumeRecovery() handles both.
    async recover(email) {
      try {
        const r = await fetch(url + '/auth/v1/recover', {
          method: 'POST', headers: hdrs(),
          body: JSON.stringify({ email, redirect_to: location.origin + '/auth.html' }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { error: j.msg || j.error_description || ('Could not send reset link (' + r.status + ')') };
        return { ok: true };
      } catch (e) { return { error: 'NETWORK' }; }
    },

    // v119: set a new password using the recovery session (PUT /auth/v1/user).
    async updatePassword(password) {
      await ensure();
      if (!ses || !ses.access_token) return { error: 'NOAUTH' };
      try {
        const r = await fetch(url + '/auth/v1/user', {
          method: 'PUT', headers: hdrs(ses.access_token), body: JSON.stringify({ password }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { error: j.msg || j.error_description || ('Password change failed (' + r.status + ')') };
        return { ok: true };
      } catch (e) { return { error: 'NETWORK' }; }
    },

    // v119: if the URL carries a recovery token (email link), adopt it as the
    // session and clean the address bar. Returns true when a recovery session
    // is now active, so the page can show the "set a new password" view.
    consumeRecovery() {
      try {
        const raw = location.hash.replace(/^#/, '') + '&' + location.search.replace(/^\?/, '');
        const q = new URLSearchParams(raw);
        if (q.get('type') !== 'recovery') return false;
        const at = q.get('access_token'), rt = q.get('refresh_token');
        if (at) {
          save({
            access_token: at, refresh_token: rt || '',
            expires_at: (Date.now() / 1000) + (Number(q.get('expires_in')) || 3600),
            uid: '', email: q.get('email') || '',
          });
        }
        history.replaceState(null, '', location.pathname);
        return !!(ses && ses.access_token);
      } catch (e) { return false; }
    },

    logout() {
      save(null);
      prof = null; profUid = ''; profLoaded = false;   // v144: never carry a name across accounts
      try { localStorage.removeItem(NKEY); } catch (e) {}
    },  // v122: clear name on sign out so lobby never shows previous racer
  };

  // v119: a stored-but-dead session must never strand the lobby. If the token
  // is expired and cannot be refreshed, clear it and send the racer back to
  // the account gate (main page only - the phone controller stays open).
  if (url && key && ses && isExp()) {
    refresh().then((ok) => {
      if (ok) return;
      save(null);
      const p = location.pathname;
      if (p === '/' || p === '/index.html' || p === '') location.replace('auth.html');
    });
  }
})();
