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

  // v74 ranked leagues: bands with III/II/I divisions + progress to next
  const BANDS = [
    { min: 1000, name: 'BRONZE',   col: '#d09a6a' },
    { min: 1100, name: 'SILVER',   col: '#cfd6dd' },
    { min: 1200, name: 'GOLD',     col: '#ffd479' },
    { min: 1350, name: 'PLATINUM', col: '#bfe8df' },
    { min: 1500, name: 'DIAMOND',  col: '#7ee7ff' },
    { min: 1700, name: 'MASTER',   col: '#ff8ae2' }
  ];
  function tier(r) {
    r = Number(r) || 1000;
    let bi = 0;
    for (let i = 0; i < BANDS.length; i++) if (r >= BANDS[i].min) bi = i;
    const b = BANDS[bi];
    const top = bi + 1 < BANDS.length ? BANDS[bi + 1].min : 1900;
    if (b.name === 'MASTER') {
      return { name: 'MASTER', col: b.col, div: '', pct: Math.max(0, Math.min(100, Math.round((100 * (r - 1700)) / 200))), next: null, bandMin: 1700, bandTop: 1900 };
    }
    const span = (top - b.min) / 3;
    let di = Math.min(2, Math.floor((r - b.min) / span));
    const div = ['III', 'II', 'I'][di];
    const dMin = b.min + di * span, dTop = b.min + (di + 1) * span;
    return { name: b.name + ' ' + div, col: b.col, div, pct: Math.max(0, Math.min(100, Math.round((100 * (r - dMin)) / (dTop - dMin)))), next: di < 2 ? b.name + ' ' + ['III', 'II', 'I'][di + 1] : BANDS[bi + 1].name + ' III', bandMin: dMin, bandTop: dTop };
  }

  // Username rules — mirrored by a DB CHECK constraint (server-side truth)
  const validUsername = (u) => typeof u === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(u);

  // v74 server-computed achievements (grants XP; unlocked at settlement only)
  const ACHIEVEMENTS = [
    { id: 'first_blood',  icon: '🏆', name: 'FIRST BLOOD',  xp: 50,  test: (d) => d.wins >= 1 },
    { id: 'hot_streak',   icon: '🔥', name: 'HOT STREAK',   xp: 75,  test: (d) => d.streak >= 3 },
    { id: 'podium_10',    icon: '🥇', name: 'PODIUM',       xp: 100, test: (d) => d.podiums >= 10 },
    { id: 'world_tour',   icon: '🌍', name: 'WORLD TOUR',   xp: 100, test: (d) => d.mapsPlayed >= 5 },
    { id: 'daily_driver', icon: '📅', name: 'DAILY DRIVER', xp: 100, test: (d) => d.daily_days >= 7 },
    { id: 'challenger',   icon: '️', name: 'CHALLENGER',   xp: 100, test: (d) => d.challenges_done >= 10 },
    { id: 'rated_10',     icon: '🏁', name: 'COMPETITOR',   xp: 50,  test: (d) => d.races >= 10 },
    { id: 'climber',      icon: '📈', name: 'CLIMBER',      xp: 75,  test: (d) => d.peak_rating >= 1100 }
  ];

  // Seasons: deterministic current-season lookup against the seasons table row
  const SEASON_LEN_DAYS = 90;
  function seasonCountdown(endIso) {
    const ms = new Date(endIso).getTime() - Date.now();
    if (!(ms > 0)) return 'ended';
    const d = Math.floor(ms / 86400000);
    return 'Ends in ' + d + ' day' + (d === 1 ? '' : 's');
  }

  return { startOf, levelFromXp, xpForRace, eloDelta, tier, validUsername, K, BANDS, ACHIEVEMENTS, SEASON_LEN_DAYS, seasonCountdown };
});
