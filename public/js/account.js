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

  window.SRAccount = {
    available: () => !!(url && key),
    loggedIn: () => !!(ses && ses.access_token),
    uid: () => (ses && ses.uid) || null,
    email: () => (ses && ses.email) || '',
    name: () => { try { return localStorage.getItem(NKEY) || ''; } catch (e) { return ''; } },
    setName: (n) => { try { localStorage.setItem(NKEY, String(n).slice(0, 16)); } catch (e) {} },

    // resolves the current session (refreshing the token if needed)
    async session() {
      if (!this.available()) return null;
      await ensure();
      return this.loggedIn() ? { uid: ses.uid, email: ses.email, name: this.name() } : null;
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
        return { ok: true };
      } catch (e) { return { error: 'NETWORK' }; }
    },

    logout() { save(null); },
  };
})();
