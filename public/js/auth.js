'use strict';
/* ============================================================================
   SRIDHAR RUSH — account gate controller (v119)
   Drives auth.html: SIGN IN / CREATE ACCOUNT / FORGOT PASSWORD / SET NEW
   PASSWORD. Talks only to SRAccount (plain GoTrue REST, no SDK). On success
   the racer is sent on to the game; the game itself never learns about this
   page beyond the redirect gate in index.html.
   ========================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const VIEWS = ['view-signin', 'view-signup', 'view-forgot', 'view-reset', 'view-confirm', 'view-sent', 'view-noauth'];
  let next = '/';

  function show(id) {
    VIEWS.forEach((v) => { const el = $(v); if (el) el.hidden = v !== id; });
    VIEWS.forEach((v) => {
      const tab = document.querySelector('[data-tab="' + v + '"]');
      if (tab) tab.classList.toggle('active', v === id);
    });
    const msg = $('msg'); if (msg) { msg.textContent = ''; msg.className = 'a-msg'; }
  }
  function msg(text, kind) {
    const m = $('msg'); if (!m) return;
    m.textContent = text || '';
    m.className = 'a-msg' + (kind ? ' ' + kind : '');
  }
  function busy(btnId, on) {
    const b = $(btnId); if (!b) return;
    b.disabled = on;
    b.classList.toggle('busy', on);
  }
  const val = (id) => String($(id) && $(id).value || '').trim();
  const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

  function go() { location.replace(next); }

  function wire() {
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('next')) next = q.get('next');
      if (!/^[\w./?&=-]+$/.test(next) || next.startsWith('//')) next = '/';
    } catch (e) { next = '/'; }

    document.querySelectorAll('[data-tab]').forEach((t) => {
      t.addEventListener('click', () => show(t.getAttribute('data-tab')));
    });

    // ---- sign in ----
    $('f-signin').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = val('si-email'), pw = val('si-pass');
      if (!okEmail(email)) return msg('Enter a valid email address.', 'err');
      if (!pw) return msg('Enter your password.', 'err');
      busy('si-go', true);
      const r = await SRAccount.login(email, pw);
      busy('si-go', false);
      if (r.ok) return go();
      msg(r.error === 'NETWORK' ? 'Network error — try again.' : String(r.error), 'err');
    });

    // ---- create account ----
    $('f-signup').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = val('su-email'), pw = val('su-pass'), pw2 = val('su-pass2'), name = val('su-name');
      if (!okEmail(email)) return msg('Enter a valid email address.', 'err');
      if (pw.length < 8) return msg('Password must be at least 8 characters.', 'err');
      if (pw !== pw2) return msg('Passwords do not match.', 'err');
      if (!/^[A-Za-z0-9 _.-]{3,16}$/.test(name)) return msg('Racer name: 3-16 characters (letters, numbers, space, _ . -).', 'err');
      busy('su-go', true);
      const r = await SRAccount.signup(email, pw, name);
      busy('su-go', false);
      if (r.ok) return go();
      if (r.error === 'CHECK_EMAIL') { $('cf-text').textContent = r.msg || 'Account created — confirm your email, then SIGN IN.'; return show('view-confirm'); }
      msg(r.error === 'NETWORK' ? 'Network error — try again.' : String(r.error || r.msg || 'Signup failed.'), 'err');
    });

    // ---- forgot password ----
    $('f-forgot').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = val('fg-email');
      if (!okEmail(email)) return msg('Enter the email you signed up with.', 'err');
      busy('fg-go', true);
      const r = await SRAccount.recover(email);
      busy('fg-go', false);
      if (r.ok) { $('sent-text').textContent = 'Password reset link sent to ' + email + '. Open it on this device to set a new password.'; return show('view-sent'); }
      msg(r.error === 'NETWORK' ? 'Network error — try again.' : String(r.error), 'err');
    });

    // ---- set new password (arrived from the recovery mail) ----
    $('f-reset').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const pw = val('rs-pass'), pw2 = val('rs-pass2');
      if (pw.length < 8) return msg('Password must be at least 8 characters.', 'err');
      if (pw !== pw2) return msg('Passwords do not match.', 'err');
      busy('rs-go', true);
      const r = await SRAccount.updatePassword(pw);
      busy('rs-go', false);
      if (r.ok) { msg('Password updated — entering the game…', 'ok'); return setTimeout(go, 600); }
      msg(r.error === 'NOAUTH' ? 'Recovery link expired — request a new one.' : String(r.error), 'err');
    });

    // v120: eye toggles - reveal/hide any password field
    document.querySelectorAll('.a-eye').forEach((b) => {
      b.addEventListener('click', () => {
        const inp = $(b.getAttribute('data-eye'));
        if (!inp) return;
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        b.classList.toggle('on', show);
        b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        b.setAttribute('aria-pressed', show ? 'true' : 'false');
        inp.focus({ preventScroll: true });
      });
    });

    $('to-signin') && $('to-signin').addEventListener('click', () => show('view-signin'));
    $('noauth-enter') && $('noauth-enter').addEventListener('click', go);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    wire();
    if (!window.SRAccount || !SRAccount.available()) return show('view-noauth');
    if (SRAccount.consumeRecovery()) return show('view-reset');
    const s = await SRAccount.session();
    if (s) return go();
    const q = new URLSearchParams(location.search);
    show(q.get('mode') === 'signup' ? 'view-signup' : 'view-signin');
  });
})();
