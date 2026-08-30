/* ============================================================================
   SRIDHAR RUSH — progression math (v73)
   Isomorphic: used by the authoritative server (settlement) and by the
   client (display only). The client can NEVER change XP/rating — it only
   renders what the server settles.
   ========================================================================== */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.SRProg = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // XP curve: level L starts at 25*(L-1)*(L+2) XP
  //   L1: 0 · L2: 100 · L3: 250 · L4: 450 · L5: 700 … (gap grows +50 each level)
  const startOf = (L) => 25 * (L - 1) * (L + 2);
  function levelFromXp(xp) {
    xp = Math.max(0, Math.floor(Number(xp) || 0));
    let L = 1;
    while (L < 999 && startOf(L + 1) <= xp) L++;
    const cur = xp - startOf(L);
    const span = startOf(L + 1) - startOf(L);
    return { level: L, cur, span, pct: Math.max(0, Math.min(100, Math.round((100 * cur) / span))) };
  }

  // Race XP: finish 100 · podium +100 · win +150  (a win totals 350)
  function xpForRace(finished, pos, players) {
    if (!finished) return 0;
    let xp = 100;
    if (pos >= 1 && pos <= Math.min(3, Math.max(1, players))) xp += 100;
    if (pos === 1) xp += 150;
    return xp;
  }

  // Elo, K = 32. score: 1 = win, 0 = loss.
  const K = 32;
  function eloDelta(ra, rb, score) {
    const e = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    return Math.round(K * (score - e));
  }

  // Rank tiers (cosmetic ladder for the competitive loop)
  function tier(r) {
    r = Number(r) || 1000;
    if (r >= 1700) return { name: 'DIAMOND',  col: '#7ee7ff' };
    if (r >= 1500) return { name: 'PLATINUM', col: '#bfe8df' };
    if (r >= 1300) return { name: 'GOLD',     col: '#ffd479' };
    if (r >= 1100) return { name: 'SILVER',   col: '#cfd6dd' };
    return { name: 'BRONZE', col: '#d09a6a' };
  }

  // Username rules — mirrored by a DB CHECK constraint (server-side truth)
  const validUsername = (u) => typeof u === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(u);

  return { startOf, levelFromXp, xpForRace, eloDelta, tier, validUsername, K };
});
