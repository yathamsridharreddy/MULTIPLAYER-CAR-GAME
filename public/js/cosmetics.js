/* ============================================================================
   SRIDHAR RUSH — garage catalog & economy (v75)
   Isomorphic: server validates unlocks/purchases; client renders the shop.
   Cosmetics are ALWAYS cosmetic — no item changes physics (classes stay the
   only performance choice, and they are free).
   Monetization-ready: every item carries price/currency; today currency is
   only "coins" (or null). Premium currency can be added later without
   redesigning anything.
   ========================================================================== */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.SRCos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- soft currency economy (server-awarded only) ----
  const COINS = { finish: 120, win: 80, podium: 40, daily: 100, firstWinDay: 50 };

  const RARITY = { starter: '#9fb0c4', rare: '#39d5ff', epic: '#b26aFF', legendary: '#ffd479' };

  // unlock: {t:'free'} | {t:'level',v} | {t:'wins',v} | {t:'league',v} | {t:'ach',v} | {t:'coins',v}
  const CARS = [
    { id: 'street_runner', name: 'STREET RUNNER', rarity: 'starter',   color: 0xe10600, sp: 0, unlock: { t: 'free' },            bars: [6, 5, 5] },
    { id: 'neon_fang',     name: 'NEON FANG',     rarity: 'rare',      color: 0x39d5ff, sp: 0, unlock: { t: 'level', v: 5 },     bars: [7, 6, 6] },
    { id: 'desert_fox',    name: 'DESERT FOX',    rarity: 'rare',      color: 0xd09a6a, sp: 0, unlock: { t: 'wins', v: 10 },     bars: [6, 7, 6] },
    { id: 'night_fury',    name: 'NIGHT FURY',    rarity: 'epic',      color: 0x7b2ff7, sp: 1, unlock: { t: 'league', v: 1200 }, bars: [8, 7, 7] },
    { id: 'volt_gt',       name: 'VOLT GT',       rarity: 'epic',      color: 0x00a651, sp: 1, unlock: { t: 'level', v: 12 },    bars: [7, 8, 7] },
    { id: 'apex_x',        name: 'APEX X',        rarity: 'legendary', color: 0xffd400, sp: 1, unlock: { t: 'wins', v: 25 },     bars: [9, 8, 8] }
  ];

  const PAINTS = [
    { id: 0, name: 'CRIMSON',  hex: 0xe10600, unlock: { t: 'free' } },
    { id: 1, name: 'AZURE',    hex: 0x0a84ff, unlock: { t: 'free' } },
    { id: 2, name: 'SUN',      hex: 0xffd400, unlock: { t: 'free' } },
    { id: 3, name: 'JADE',     hex: 0x00a651, unlock: { t: 'level', v: 3 } },
    { id: 4, name: 'EMBER',    hex: 0xff6a00, unlock: { t: 'level', v: 4 } },
    { id: 5, name: 'VIOLET',   hex: 0x7b2ff7, unlock: { t: 'level', v: 6 } },
    { id: 6, name: 'PEARL',    hex: 0xffffff, unlock: { t: 'coins', v: 300 } },
    { id: 7, name: 'SHADOW',   hex: 0x111111, unlock: { t: 'coins', v: 300 } }
  ];
  const WHEELS = [
    { id: 0, name: 'SPORT',  unlock: { t: 'free' } },
    { id: 1, name: 'CHROME', unlock: { t: 'level', v: 3 } },
    { id: 2, name: 'GOLD',   unlock: { t: 'level', v: 8 } },
    { id: 3, name: 'NEON',   unlock: { t: 'coins', v: 500 } }
  ];
  const TRAILS = [
    { id: 0, name: 'CYAN', unlock: { t: 'free' } },
    { id: 1, name: 'PINK', unlock: { t: 'free' } },
    { id: 2, name: 'GOLD', unlock: { t: 'level', v: 6 } },
    { id: 3, name: 'FIRE', unlock: { t: 'coins', v: 800 } }
  ];
  const DECALS = [
    { id: 0, name: 'NONE',     unlock: { t: 'free' } },
    { id: 1, name: 'STRIPES',  unlock: { t: 'free' } },
    { id: 2, name: 'FLAME',    unlock: { t: 'level', v: 4 } },
    { id: 3, name: 'CHECK',    unlock: { t: 'level', v: 7 } },
    { id: 4, name: 'LIGHTNING',unlock: { t: 'coins', v: 300 } },
    { id: 5, name: 'RUSH',     unlock: { t: 'ach', v: 'first_blood' } }
  ];
  const NEONS = [
    { id: 0, name: 'OFF',  hex: 0x000000, unlock: { t: 'free' } },
    { id: 1, name: 'BLUE', hex: 0x39d5ff, unlock: { t: 'level', v: 6 } },
    { id: 2, name: 'PINK', hex: 0xff2d95, unlock: { t: 'coins', v: 400 } },
    { id: 3, name: 'GREEN',hex: 0x3ddc84, unlock: { t: 'coins', v: 400 } }
  ];

  function unlockText(u) {
    if (!u || u.t === 'free') return 'FREE';
    if (u.t === 'level') return 'LEVEL ' + u.v;
    if (u.t === 'wins') return 'WIN ' + u.v + ' RACES';
    if (u.t === 'league') return 'REACH ' + u.v + ' RATING';
    if (u.t === 'ach') return 'ACHIEVEMENT';
    if (u.t === 'coins') return '🪙 ' + u.v;
    return '';
  }

  // d = { level, wins, rating, ach:[ids], owned:[itemIds] } — authoritative on server
  function itemUnlocked(u, d, key) {
    if (!u || u.t === 'free') return true;
    d = d || {};
    if (u.t === 'level') return (d.level || 1) >= u.v;
    if (u.t === 'wins') return (d.wins || 0) >= u.v;
    if (u.t === 'league') return (d.rating || 1000) >= u.v;
    if (u.t === 'ach') return !!(d.ach || []).includes(u.v);
    if (u.t === 'coins') return !!(d.owned || []).includes(key); // coin items need purchase
    return false;
  }
  const isCoinItem = (u) => !!(u && u.t === 'coins');

  function findCar(id) { return CARS.find((c) => c.id === id) || CARS[0]; }

  return { COINS, RARITY, CARS, PAINTS, WHEELS, TRAILS, DECALS, NEONS, unlockText, itemUnlocked, isCoinItem, findCar };
});
