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

  // ---- Competitive Anti-Cheat: Theoretical Minimum Lap Times (seconds) ----
  const THEORETICAL_MIN_LAP_SEC = { 0: 6.0, 1: 10.0, 2: 12.0, 3: 11.0, 4: 15.0, 5: 14.0, 6: 18.0 };
  function isValidLapTime(mapId, lapTime) {
    if (typeof lapTime !== 'number' || isNaN(lapTime) || lapTime <= 0) return false;
    const tSec = lapTime >= 1000 ? lapTime / 1000 : lapTime;
    const minSec = THEORETICAL_MIN_LAP_SEC[mapId] || 5.5;
    return tSec >= minSec && tSec <= 600; // between physical min and 10 minutes
  }

  // ---- Weekly Championship Points Formula ----
  // Points: 1st: 25, 2nd: 18, 3rd: 15, 4th: 12, 5th: 10, 6th: 8, 7+: 5 + 5 pts for fastest lap in race
  const WEEKLY_POS_PTS = [0, 25, 18, 15, 12, 10, 8];
  function weeklyPointsForPos(pos, players, hasFastestLap) {
    if (!pos || pos < 1) return 0;
    const base = pos <= 6 ? (WEEKLY_POS_PTS[pos] || 5) : 5;
    return base + (hasFastestLap ? 5 : 0);
  }

  // ---- Competitive Ranking Math & Percentiles ----
  function rankScore(rating, wins, races) {
    const r = Math.max(0, parseInt(rating, 10) || 1000);
    const w = Math.max(0, parseInt(wins, 10) || 0);
    const rc = Math.max(0, parseInt(races, 10) || 0);
    const eff = Math.max(0, 9999 - Math.min(rc, 9999));
    return r * 1000000000 + w * 10000 + eff;
  }

  function calculatePercentile(rank, totalPlayers) {
    if (!totalPlayers || totalPlayers <= 1 || rank <= 1) return 1.0;
    return Math.max(0.1, Math.min(99.9, +((rank / totalPlayers) * 100).toFixed(1)));
  }

  function getNearbyBracket(rows, targetId, windowSize = 2) {
    if (!Array.isArray(rows) || rows.length === 0) return { targetRank: -1, bracket: [] };
    const idx = rows.findIndex((r) => (r.id === targetId || r.uid === targetId || r.user_id === targetId || r.pid === targetId || r.name === targetId));
    const span = windowSize * 2 + 1;
    if (idx === -1) {
      const slice = rows.slice(0, Math.min(rows.length, span));
      return { targetRank: -1, bracket: slice.map((item, i) => ({ rank: i + 1, item })) };
    }
    const start = Math.max(0, Math.min(idx - windowSize, Math.max(0, rows.length - span)));
    const end = Math.min(rows.length, start + span);
    return {
      targetRank: idx + 1,
      bracket: rows.slice(start, end).map((item, i) => ({ rank: start + i + 1, item }))
    };
  }

  // =========================================================================
  // v81 COMPETITIVE RETENTION: RIVALS, GHOSTS, MISSIONS, STREAKS & SEASONS
  // =========================================================================

  // ---- 1. Competitive Rivals ----
  function getCompetitiveRival(rows, targetId) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { rank: null, myRank: null, myRating: 1000, nextRival: null, lowerRival: null, chaserRival: null };
    }
    const idx = rows.findIndex((r) => (r.id === targetId || r.uid === targetId || r.user_id === targetId || r.pid === targetId || r.name === targetId));
    if (idx === -1) {
      // If target not in list, fallback to comparing against bottom/top
      const top = rows[0];
      const nr = top ? {
        rank: 1,
        name: top.name || 'TOP RACER',
        rating: top.rating || 1000,
        gap: Math.max(0, (top.rating || 1000) - 1000),
        ratingGap: Math.max(0, (top.rating || 1000) - 1000),
        uid: top.uid || top.id || top.user_id
      } : null;
      return {
        rank: rows.length + 1,
        myRank: rows.length + 1,
        myRating: 1000,
        nextRival: nr,
        lowerRival: null,
        chaserRival: null
      };
    }
    const me = rows[idx];
    const myRating = me.rating || 1000;
    const myRank = idx + 1;

    let nextRival = null;
    if (idx > 0) {
      const r = rows[idx - 1];
      const gap = Math.max(0, (r.rating || 1000) - myRating);
      nextRival = {
        rank: idx,
        name: r.name || 'RACER',
        uid: r.uid || r.id || r.user_id,
        rating: r.rating || 1000,
        gap,
        ratingGap: gap
      };
    }

    let lowerRival = null;
    if (idx < rows.length - 1) {
      const r = rows[idx + 1];
      const gap = Math.max(0, myRating - (r.rating || 1000));
      lowerRival = {
        rank: idx + 2,
        name: r.name || 'RACER',
        uid: r.uid || r.id || r.user_id,
        rating: r.rating || 1000,
        gap,
        ratingGap: gap
      };
    }

    return {
      rank: myRank,
      myRank,
      myRating,
      nextRival,
      lowerRival,
      chaserRival: lowerRival
    };
  }

  function detectRivalOvertake(oldRank, newRank, rivalBefore) {
    if (!rivalBefore || !oldRank || !newRank) return null;
    const targetRank = rivalBefore.rank != null ? rivalBefore.rank : (rivalBefore.previousRivalRank || rivalBefore.rivalRank);
    if (newRank < oldRank && newRank <= targetRank) {
      return {
        overtaken: true,
        rivalName: rivalBefore.name || rivalBefore.rivalName || 'Rival',
        rivalRank: targetRank,
        previousRivalRank: targetRank,
        newPlayerRank: newRank,
        newRank,
        oldRank
      };
    }
    return null;
  }

  // ---- 2. Daily Missions (Deterministic 3 per UTC day) ----
  const DAILY_MISSION_CATALOG = [
    { id: 'finish_2_races', title: 'Finish 2 Races', desc: 'Complete 2 full races on any circuit', goal: 2, xp: 60, coins: 30, icon: '🏁' },
    { id: 'win_1_race', title: 'Victory Rush', desc: 'Win 1 race against rivals or bots', goal: 1, xp: 80, coins: 40, icon: '🏆' },
    { id: 'use_nitro_5', title: 'Nitro Surge', desc: 'Trigger Nitro boost 5 times in races', goal: 5, xp: 50, coins: 25, icon: '⚡' },
    { id: 'play_daily_cup', title: 'Daily Cup Entry', desc: 'Set a lap time in the Daily Cup challenge', goal: 1, xp: 75, coins: 35, icon: '📅' },
    { id: 'beat_pb', title: 'Break Your Limits', desc: 'Set a new Personal Record on any circuit', goal: 1, xp: 90, coins: 45, icon: '📈' },
    { id: 'race_human', title: 'Rivalry Duel', desc: 'Complete a multiplayer race vs human racers', goal: 1, xp: 70, coins: 35, icon: '⚔️' },
    { id: 'clean_drive', title: 'Apex Master', desc: 'Finish a race with flawless track precision', goal: 1, xp: 65, coins: 30, icon: '🎯' }
  ];

  function getDailyMissions(dateKey) {
    const key = typeof dateKey === 'string' && dateKey.length >= 10 ? dateKey.slice(0, 10) : new Date().toISOString().slice(0, 10);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    const seed = Math.abs(h);

    const pool = DAILY_MISSION_CATALOG.slice();
    const missions = [];
    for (let i = 0; i < 3 && pool.length > 0; i++) {
      const idx = (seed + i * 13) % pool.length;
      missions.push(Object.assign({}, pool.splice(idx, 1)[0]));
    }
    return missions;
  }

  function evaluateMissionProgress(missionId, currentVal, telemetry) {
    const cur = Math.max(0, parseInt(currentVal, 10) || 0);
    if (!telemetry) return cur;
    switch (missionId) {
      case 'finish_2_races':
      case 'finish_3_races':
        return cur + (telemetry.finished ? 1 : 0);
      case 'win_1_race':
        return cur + (telemetry.won ? 1 : 0);
      case 'win_1_mp':
        return cur + (telemetry.won && (telemetry.humanRacers == null || telemetry.humanRacers >= 2) ? 1 : 0);
      case 'use_nitro_5':
      case 'nitro_5_times':
        return cur + Math.max(0, parseInt(telemetry.nitroCount, 10) || (telemetry.nitro ? 1 : 0));
      case 'play_daily_cup':
      case 'daily_cup_race':
        return cur + (telemetry.isDailyCup && telemetry.finished ? 1 : 0);
      case 'beat_pb':
      case 'beat_personal_best':
        return cur + (telemetry.isPersonalBest ? 1 : 0);
      case 'race_human':
        return cur + (telemetry.humanRacers >= 2 && telemetry.finished ? 1 : 0);
      case 'clean_drive':
      case 'clean_race_no_crash':
        return cur + (telemetry.finished && !telemetry.collisions ? 1 : 0);
      default:
        return cur;
    }
  }

  // ---- 3. Daily Engagement Streaks & Milestones ----
  const STREAK_MILESTONES = [
    { days: 3, xp: 100, coins: 50, title: '🔥 Hot Streak' },
    { days: 7, xp: 300, coins: 150, title: '⚡ Silver Runner' },
    { days: 14, xp: 500, coins: 300, title: '👑 Gold Veteran' },
    { days: 30, xp: 1000, coins: 750, title: '💎 Diamond Legend' }
  ];

  function getStreakMilestoneInfo(streak) {
    streak = Math.max(0, parseInt(streak, 10) || 0);
    const hitMilestone = STREAK_MILESTONES.find(m => m.days === streak);
    let next = null;
    for (const m of STREAK_MILESTONES) {
      if (m.days > streak) {
        next = Object.assign({}, m, { daysRemaining: m.days - streak });
        break;
      }
    }
    const achieved = STREAK_MILESTONES.filter((m) => streak >= m.days);
    return {
      currentStreak: streak,
      milestoneReached: !!hitMilestone,
      currentMilestoneDays: hitMilestone ? hitMilestone.days : null,
      rewardXp: hitMilestone ? hitMilestone.xp : (next ? next.xp : 0),
      rewardCoins: hitMilestone ? hitMilestone.coins : (next ? next.coins : 0),
      nextMilestone: next ? next.days : null,
      nextMilestoneObj: next,
      achievedMilestones: achieved
    };
  }

  function evaluateStreakTransition(lastRaceDateStr, todayDateStr, currentStreak, bestStreak) {
    const cur = Math.max(0, parseInt(currentStreak, 10) || 0);
    const best = Math.max(cur, parseInt(bestStreak, 10) || 0);
    const today = todayDateStr ? todayDateStr.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const last = lastRaceDateStr ? lastRaceDateStr.slice(0, 10) : '';

    if (!last) {
      return { streak: 1, bestStreak: Math.max(best, 1), changed: true, continued: true, racedToday: true };
    }
    if (last === today) {
      return { streak: cur || 1, bestStreak: Math.max(best, cur || 1), changed: false, continued: false, racedToday: true };
    }

    const tDate = new Date(today + 'T00:00:00Z');
    const lDate = new Date(last + 'T00:00:00Z');
    const diffDays = Math.round((tDate.getTime() - lDate.getTime()) / 86400000);

    if (diffDays === 1) {
      const newStreak = cur + 1;
      return { streak: newStreak, bestStreak: Math.max(best, newStreak), changed: true, continued: true, racedToday: true };
    }
    // Missed a day or more: non-punitive fresh start at 1
    return { streak: 1, bestStreak: best, changed: true, continued: false, reset: true, racedToday: true };
  }

  // ---- 4. Competitive Season Progression ----
  const SEASON_REWARDS = {
    BRONZE: { coins: 100, xp: 200, title: 'Bronze Challenger' },
    SILVER: { coins: 250, xp: 400, title: 'Silver Competitor' },
    GOLD: { coins: 500, xp: 750, title: 'Gold Champion' },
    PLATINUM: { coins: 750, xp: 1200, title: 'Platinum Master' },
    DIAMOND: { coins: 1000, xp: 1800, title: 'Diamond Grandmaster' },
    MASTER: { coins: 1500, xp: 2500, title: 'Apex Legend' }
  };

  function getCurrentSeason(nowMs) {
    const now = nowMs ? new Date(nowMs) : new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth(); // 0-indexed
    const seasonNumber = (year - 2026) * 12 + month + 1;
    const seasonId = `S${Math.max(1, seasonNumber)}`;
    const seasonName = `SEASON ${String(Math.max(1, seasonNumber)).padStart(2, '0')}`;

    const startMs = Date.UTC(year, month, 1);
    const nextMonthYear = month === 11 ? year + 1 : year;
    const nextMonth = month === 11 ? 0 : month + 1;
    const endMs = Date.UTC(nextMonthYear, nextMonth, 1);

    const endsInMs = Math.max(0, endMs - now.getTime());
    const totalHours = Math.floor(endsInMs / 3600000);
    const daysLeft = Math.floor(totalHours / 24);
    const hoursLeft = totalHours % 24;
    const endsInFormatted = `${daysLeft}d ${hoursLeft}h`;

    return {
      seasonId,
      seasonNumber: Math.max(1, seasonNumber),
      seasonName,
      status: 'active',
      startMs,
      endMs,
      daysLeft,
      endsInMs,
      endsInFormatted,
      rewards: SEASON_REWARDS
    };
  }

  function checkDivisionTransition(oldRating, newRating) {
    const oTier = tier(oldRating || 1000);
    const nTier = tier(newRating || 1000);

    if (nTier.name !== oTier.name) {
      const isPromo = (newRating || 1000) > (oldRating || 1000);
      return {
        changed: true,
        promoted: isPromo,
        demoted: !isPromo,
        oldTier: oTier.name,
        newTier: nTier.name,
        fromTier: oTier.name,
        toTier: nTier.name,
        col: nTier.col
      };
    }
    return { changed: false, promoted: false, demoted: false, oldTier: oTier.name, newTier: nTier.name, fromTier: oTier.name, toTier: nTier.name, col: nTier.col };
  }

  // ---- 5. Social Share Messages ----
  function formatCompetitiveShare(type, data) {
    data = data || {};
    const link = data.link || 'https://sridharrush.com';
    const trackName = data.mapName || 'Circuit';
    const timeStr = data.timeFormatted || '00:00.00';
    const rankStr = data.rank ? `#${data.rank}` : '#1';

    switch (type) {
      case 'rival_overtake':
        return `⚔️ I just overtook ${data.rivalName || 'my rival'} to claim ${rankStr} on Sridhar Rush! Can you beat my rating of ${data.rating || 1000}? Race now: ${link}`;
      case 'beat_ghost':
      case 'ghost_beaten':
        return `👻 I just crushed the ghost record on ${trackName} with a blistering ${data.delta || timeStr}! Can you beat my ghost? Race here: ${link}`;
      case 'tier_promotion':
      case 'division_promo':
        return `🎖️ Just got PROMOTED to ${data.tier || data.tierName || 'GOLD'} in Sridhar Rush Season ${data.seasonNumber || 1}! Think you can pass me? ${link}`;
      case 'streak_milestone':
        return `🔥 ${data.days || 7}-day RACING STREAK on Sridhar Rush! Join the grid and challenge my leaderboard rank: ${link}`;
      case 'personal_record':
      case 'pb_improvement':
        return `🎉 New Personal Best! Set ${timeStr} on ${trackName} in Sridhar Rush. Can you beat it? ${link}`;
      case 'daily_cup':
        return `📅 I set ${timeStr} in today's Daily Cup on Sridhar Rush! Race today's challenge: ${link}`;
      case 'revenge_challenge':
        return `⚔️ REVENGE MATCH: You beat me on ${trackName} — think you can do it again? Accept my revenge challenge: ${link}`;
      case 'license_complete':
        return `🎓 Just earned my Pro Racing License on Sridhar Rush! Think you can out-drive a certified racer? ${link}`;
      default:
        return `🏁 Race with me in Sridhar Rush! Real-time 3D competitive arcade racing: ${link}`;
    }
  }

  // ---- 6. Driving Academy / Onboarding License ----
  const ACADEMY_LESSONS = [
    {
      id: 'lesson_1_steering',
      title: 'Apex & Precision Steering',
      desc: 'Master the racing line: steer smoothly around apexes without hitting outer barriers.',
      targetMs: 25000,
      rewardXp: 50,
      rewardCoins: 50,
      icon: '🎯'
    },
    {
      id: 'lesson_2_nitro',
      title: 'Nitro Exit Acceleration',
      desc: 'Trigger Nitro boosts out of high-speed turns to reach top straightaway velocity.',
      targetMs: 20000,
      rewardXp: 75,
      rewardCoins: 50,
      icon: '⚡'
    },
    {
      id: 'lesson_3_drafting',
      title: 'Slipstream & Clean Overtake',
      desc: 'Follow the target car in its aerodynamic slipstream draft and execute a clean pass.',
      targetMs: 18000,
      rewardXp: 75,
      rewardCoins: 100,
      icon: '🏎️'
    }
  ];

  const LICENSE_COMPLETION_BONUS = {
    xp: 200,
    coins: 200,
    title: 'Licensed Pro',
    badgeId: 'pro_license'
  };

  // ---- 7. Milestone Badges & Showcase ----
  const BADGE_DEFINITIONS = [
    {
      id: 'speed_demon',
      name: 'Speed Demon',
      icon: '⚡',
      desc: 'Achieve blistering top speed in a competitive race',
      tiers: [
        { level: 1, name: 'Bronze', req: 160, label: '160 km/h', xp: 50, coins: 25 },
        { level: 2, name: 'Silver', req: 190, label: '190 km/h', xp: 100, coins: 50 },
        { level: 3, name: 'Gold', req: 220, label: '220 km/h', xp: 200, coins: 100 },
        { level: 4, name: 'Diamond', req: 250, label: '250 km/h', xp: 400, coins: 200 }
      ]
    },
    {
      id: 'apex_predator',
      name: 'Apex Predator',
      icon: '🏆',
      desc: 'Win official multiplayer races against human rivals',
      tiers: [
        { level: 1, name: 'Bronze', req: 5, label: '5 Wins', xp: 75, coins: 50 },
        { level: 2, name: 'Silver', req: 20, label: '20 Wins', xp: 150, coins: 100 },
        { level: 3, name: 'Gold', req: 50, label: '50 Wins', xp: 300, coins: 200 },
        { level: 4, name: 'Diamond', req: 100, label: '100 Wins', xp: 600, coins: 400 }
      ]
    },
    {
      id: 'streak_king',
      name: 'Streak King',
      icon: '🔥',
      desc: 'Maintain a consecutive daily racing streak',
      tiers: [
        { level: 1, name: 'Bronze', req: 3, label: '3-Day Streak', xp: 50, coins: 25 },
        { level: 2, name: 'Silver', req: 7, label: '7-Day Streak', xp: 150, coins: 75 },
        { level: 3, name: 'Gold', req: 14, label: '14-Day Streak', xp: 300, coins: 150 },
        { level: 4, name: 'Diamond', req: 30, label: '30-Day Streak', xp: 750, coins: 350 }
      ]
    },
    {
      id: 'rival_slayer',
      name: 'Rival Slayer',
      icon: '⚔️',
      desc: 'Overtake rivals ahead of you on the global rating ladder',
      tiers: [
        { level: 1, name: 'Bronze', req: 3, label: '3 Rivals Passed', xp: 60, coins: 30 },
        { level: 2, name: 'Silver', req: 10, label: '10 Rivals Passed', xp: 120, coins: 60 },
        { level: 3, name: 'Gold', req: 25, label: '25 Rivals Passed', xp: 250, coins: 125 },
        { level: 4, name: 'Diamond', req: 50, label: '50 Rivals Passed', xp: 500, coins: 250 }
      ]
    },
    {
      id: 'phantom_master',
      name: 'Phantom Master',
      icon: '👻',
      desc: 'Beat personal best and competitor ghost lap times',
      tiers: [
        { level: 1, name: 'Bronze', req: 3, label: '3 Ghosts Beaten', xp: 50, coins: 25 },
        { level: 2, name: 'Silver', req: 10, label: '10 Ghosts Beaten', xp: 100, coins: 50 },
        { level: 3, name: 'Gold', req: 25, label: '25 Ghosts Beaten', xp: 200, coins: 100 },
        { level: 4, name: 'Diamond', req: 50, label: '50 Ghosts Beaten', xp: 450, coins: 225 }
      ]
    },
    {
      id: 'clean_driver',
      name: 'Clean Driver',
      icon: '🎯',
      desc: 'Complete full race circuits without a single wall or car collision',
      tiers: [
        { level: 1, name: 'Bronze', req: 3, label: '3 Clean Races', xp: 50, coins: 25 },
        { level: 2, name: 'Silver', req: 10, label: '10 Clean Races', xp: 100, coins: 50 },
        { level: 3, name: 'Gold', req: 25, label: '25 Clean Races', xp: 200, coins: 100 },
        { level: 4, name: 'Diamond', req: 50, label: '50 Clean Races', xp: 450, coins: 225 }
      ]
    },
    {
      id: 'nitro_junkie',
      name: 'Nitro Junkie',
      icon: '🚀',
      desc: 'Deploy Nitro boosts across all racing circuits',
      tiers: [
        { level: 1, name: 'Bronze', req: 25, label: '25 Boosts', xp: 40, coins: 20 },
        { level: 2, name: 'Silver', req: 100, label: '100 Boosts', xp: 100, coins: 50 },
        { level: 3, name: 'Gold', req: 250, label: '250 Boosts', xp: 220, coins: 110 },
        { level: 4, name: 'Diamond', req: 500, label: '500 Boosts', xp: 500, coins: 250 }
      ]
    },
    {
      id: 'pro_license',
      name: 'Licensed Pro',
      icon: '🎓',
      desc: 'Graduate from the Driving Academy with full racing certification',
      tiers: [
        { level: 1, name: 'Certified', req: 1, label: 'Academy Graduate', xp: 200, coins: 200 }
      ]
    }
  ];

  function evaluateBadges(stats) {
    stats = stats || {};
    const wins = Math.max(0, parseInt(stats.wins, 10) || 0);
    const streak = Math.max(0, parseInt(stats.streak || stats.best_streak, 10) || 0);
    const topSpeed = Math.max(0, parseInt(stats.top_speed || stats.maxSpeed, 10) || 0);
    const rivalsPassed = Math.max(0, parseInt(stats.rivals_passed || stats.rivalsOvertaken, 10) || 0);
    const ghostsBeaten = Math.max(0, parseInt(stats.ghosts_beaten, 10) || 0);
    const cleanRaces = Math.max(0, parseInt(stats.clean_races, 10) || 0);
    const nitroCount = Math.max(0, parseInt(stats.nitro_count, 10) || 0);
    const licenseDone = !!(stats.license_done || stats.academy_done);

    const values = {
      speed_demon: topSpeed,
      apex_predator: wins,
      streak_king: streak,
      rival_slayer: rivalsPassed,
      phantom_master: ghostsBeaten,
      clean_driver: cleanRaces,
      nitro_junkie: nitroCount,
      pro_license: licenseDone ? 1 : 0
    };

    return BADGE_DEFINITIONS.map((def) => {
      const curVal = values[def.id] || 0;
      let unlockedTier = null;
      let nextTier = null;

      for (let i = 0; i < def.tiers.length; i++) {
        const t = def.tiers[i];
        if (curVal >= t.req) {
          unlockedTier = t;
        } else if (!nextTier) {
          nextTier = t;
        }
      }

      const maxReq = def.tiers[def.tiers.length - 1].req;
      const progressPct = Math.min(100, Math.round((curVal / (nextTier ? nextTier.req : maxReq)) * 100));

      return {
        id: def.id,
        name: def.name,
        icon: def.icon,
        desc: def.desc,
        currentValue: curVal,
        unlocked: !!unlockedTier,
        tierLevel: unlockedTier ? unlockedTier.level : 0,
        tierName: unlockedTier ? unlockedTier.name : 'Locked',
        nextTier: nextTier ? { level: nextTier.level, name: nextTier.name, req: nextTier.req, label: nextTier.label } : null,
        progressPct,
        formattedLabel: unlockedTier ? `${def.name} (${unlockedTier.name})` : `${def.name} (Locked)`
      };
    });
  }

  // ---- 8. Weekly Syndicate Bounties ----
  const WEEKLY_BOUNTY_CATALOG = [
    { id: 'weekly_laps_15', title: 'Circuit Endurance', desc: 'Complete 15 full race laps this week', goal: 15, xp: 200, coins: 100, icon: '🔄' },
    { id: 'weekly_wins_3', title: 'Weekly Dominion', desc: 'Win 3 rated multiplayer matches', goal: 3, xp: 250, coins: 150, icon: '👑' },
    { id: 'weekly_pts_100', title: 'Points Collector', desc: 'Accumulate 100 weekly championship points', goal: 100, xp: 300, coins: 200, icon: '🏆' },
    { id: 'weekly_nitro_20', title: 'Boost Veteran', desc: 'Trigger Nitro boost 20 times this week', goal: 20, xp: 180, coins: 90, icon: '⚡' },
    { id: 'weekly_clean_5', title: 'Flawless Pace', desc: 'Finish 5 races without hitting barriers', goal: 5, xp: 220, coins: 120, icon: '🎯' }
  ];

  function getWeeklyBounties(weekKey) {
    const key = typeof weekKey === 'string' && weekKey.length >= 6 ? weekKey : '2026-W36';
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    const seed = Math.abs(h);

    const pool = WEEKLY_BOUNTY_CATALOG.slice();
    const bounties = [];
    for (let i = 0; i < 3 && pool.length > 0; i++) {
      const idx = (seed + i * 17) % pool.length;
      bounties.push(Object.assign({}, pool.splice(idx, 1)[0]));
    }
    return bounties;
  }

  function evaluateWeeklyBountyProgress(bountyId, currentVal, telemetry) {
    const cur = Math.max(0, parseInt(currentVal, 10) || 0);
    if (!telemetry) return cur;
    switch (bountyId) {
      case 'weekly_laps_15':
        return cur + (telemetry.lapsCompleted || (telemetry.finished ? 2 : 1));
      case 'weekly_wins_3':
        return cur + (telemetry.won && telemetry.humanRacers >= 2 ? 1 : 0);
      case 'weekly_pts_100':
        return cur + Math.max(0, parseInt(telemetry.weeklyPts, 10) || 0);
      case 'weekly_nitro_20':
        return cur + Math.max(0, parseInt(telemetry.nitroCount, 10) || 0);
      case 'weekly_clean_5':
        return cur + (telemetry.finished && !telemetry.collisions ? 1 : 0);
      default:
        return cur;
    }
  }

  // ---- 9. Revenge Match Evaluation ----
  function evaluateRevengeMatch(targetUid, winnerUid, baseReward) {
    baseReward = baseReward || { xp: 100, coins: 25 };
    const isRevengeSuccess = targetUid && winnerUid && targetUid !== winnerUid;
    if (!isRevengeSuccess) return { revenge: false, xpBonus: 0, coinsBonus: 0 };
    const xpBonus = Math.round(baseReward.xp * 0.5);
    const coinsBonus = Math.round(baseReward.coins * 0.5);
    return {
      revenge: true,
      xpBonus,
      coinsBonus,
      totalXp: baseReward.xp + xpBonus,
      totalCoins: baseReward.coins + coinsBonus
    };
  }

  // ---- 10. Prioritized Next Best Action Guide ----
  function getNextBestAction(playerContext) {
    playerContext = playerContext || {};
    const { streakInfo, missions, rivals, licenseDone, nextTier } = playerContext;

    if (!licenseDone) {
      return {
        id: 'license',
        title: 'Complete Driving Academy',
        desc: 'Earn your official Pro License + 200 starter Coins & 200 XP!',
        actionType: 'academy',
        cta: '🎓 START ACADEMY',
        badge: 'NEW RACER'
      };
    }

    if (streakInfo && !streakInfo.racedToday) {
      return {
        id: 'streak',
        title: `Protect Your ${streakInfo.currentStreak || 1}-Day Streak`,
        desc: `Race once today to progress toward the ${streakInfo.nextMilestone || 3}-Day Milestone!`,
        actionType: 'quickplay',
        cta: '🔥 RACE TO KEEP STREAK',
        badge: 'DAILY BONUS'
      };
    }

    if (missions && Array.isArray(missions)) {
      const claimable = missions.find(m => m.completed && !m.claimed);
      if (claimable) {
        return {
          id: 'mission_claim',
          title: `Claim ${claimable.title}`,
          desc: `Ready to collect +${claimable.xp} XP and +${claimable.coins} Coins!`,
          actionType: 'claim_mission',
          cta: '🎁 CLAIM MISSION',
          badge: 'REWARD READY'
        };
      }
      const almostDone = missions.find(m => !m.completed && (m.goal - m.progress) === 1);
      if (almostDone) {
        return {
          id: 'mission_finish',
          title: `Finish ${almostDone.title}`,
          desc: `Only 1 more to complete: ${almostDone.desc}`,
          actionType: 'quickplay',
          cta: '🎯 COMPLETE MISSION',
          badge: 'ALMOST DONE'
        };
      }
    }

    if (rivals && rivals.nextRival && rivals.nextRival.ratingGap <= 25) {
      return {
        id: 'rival_overtake',
        title: `Overtake ${rivals.nextRival.name} (#${rivals.nextRival.rank})`,
        desc: `Only ${rivals.nextRival.ratingGap} rating points behind! Win to take their rank.`,
        actionType: 'ranked',
        cta: '⚔️ RACE RIVAL',
        badge: 'RIVAL NEAR'
      };
    }

    return {
      id: 'climb_ranked',
      title: 'Climb Ranked Ladder',
      desc: nextTier ? `Compete in Rated multiplayer to advance toward ${nextTier}!` : 'Dominate the Global Rating Leaderboard!',
      actionType: 'quickplay',
      cta: '⚡ PLAY RANKED',
      badge: 'LADDER'
    };
  }

  // ---- 11. Racing Syndicate Crews ----
  const CREW_MILESTONES = [
    { tier: 1, reqKm: 25,  reqMeters: 25000,   name: 'Rookie Milestone',    reward: { xp: 150, coins: 75, badge: '🔰' }, desc: '25 km team mileage' },
    { tier: 2, reqKm: 75,  reqMeters: 75000,   name: 'Club Division',      reward: { xp: 350, coins: 150, title: 'SYNDICATE ROOKIE' }, desc: '75 km team mileage' },
    { tier: 3, reqKm: 200, reqMeters: 200000,  name: 'Pro Circuit',        reward: { xp: 750, coins: 350, paint: 'neon_crew' }, desc: '200 km team mileage' },
    { tier: 4, reqKm: 500, reqMeters: 500000,  name: 'Elite Grand Prix',   reward: { xp: 1500, coins: 750, rim: 'syndicate_gold' }, desc: '500 km team mileage' },
    { tier: 5, reqKm: 1000, reqMeters: 1000000, name: 'Apex Legends',      reward: { xp: 3000, coins: 1500, title: 'APEX SYNDICATE' }, desc: '1,000 km team mileage' }
  ];

  const CREW_PRESETS = [
    { id: 'apex', tag: 'APEX', name: 'Apex Predators', motto: 'Speed is our only law', badge: '⚡', color: '#ff4444' },
    { id: 'drift', tag: 'DRIFT', name: 'Drift Syndicate', motto: 'Sideways is the fastest way', badge: '🌀', color: '#00e5ff' },
    { id: 'viper', tag: 'VIPER', name: 'Viper Velocity', motto: 'Strike first, strike fast', badge: '🐍', color: '#00e676' },
    { id: 'titan', tag: 'TITAN', name: 'Titan Motorsports', motto: 'Unstoppable mechanical force', badge: '🛡️', color: '#ffb300' },
    { id: 'ghost', tag: 'GHOST', name: 'Phantom Syndicate', motto: 'Leave only shadows behind', badge: '👻', color: '#b388ff' }
  ];

  function validCrewTag(tag) {
    return typeof tag === 'string' && /^[A-Z0-9]{2,5}$/.test(tag.trim().toUpperCase());
  }

  function validCrewName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9 _-]{3,24}$/.test(name.trim());
  }

  function getCrewMilestoneInfo(totalMeters) {
    const meters = Math.max(0, parseInt(totalMeters, 10) || 0);
    const km = +(meters / 1000).toFixed(1);
    let currentTier = 0;
    let nextMilestone = CREW_MILESTONES[0];

    for (let i = 0; i < CREW_MILESTONES.length; i++) {
      if (meters >= CREW_MILESTONES[i].reqMeters) {
        currentTier = CREW_MILESTONES[i].tier;
        nextMilestone = CREW_MILESTONES[i + 1] || null;
      }
    }

    let progressPct = 100;
    let prevMeters = 0;
    if (nextMilestone) {
      if (currentTier > 0) {
        prevMeters = CREW_MILESTONES[currentTier - 1].reqMeters;
      }
      const span = nextMilestone.reqMeters - prevMeters;
      progressPct = Math.min(100, Math.max(0, Math.round(((meters - prevMeters) / span) * 100)));
    }

    return {
      currentTier,
      totalMeters,
      km,
      nextMilestone,
      progressPct,
      milestones: CREW_MILESTONES.map(m => ({
        ...m,
        completed: meters >= m.reqMeters
      }))
    };
  }

  function calculateCrewContribution(raceTelemetry) {
    if (!raceTelemetry) return { meters: 0, points: 0 };
    const laps = Math.max(0, parseInt(raceTelemetry.lapsCompleted || (raceTelemetry.finished ? 2 : 1), 10));
    const trackLapMeters = 800; // Average track lap distance in meters
    const meters = laps * trackLapMeters;
    const points = Math.round(meters / 10) + (raceTelemetry.won ? 150 : (raceTelemetry.podium ? 80 : 30));
    return { meters, points };
  }

  return {
    startOf, levelFromXp, xpForRace, eloDelta, tier, validUsername, K, BANDS, ACHIEVEMENTS,
    SEASON_LEN_DAYS, seasonCountdown, THEORETICAL_MIN_LAP_SEC, isValidLapTime,
    WEEKLY_POS_PTS, weeklyPointsForPos, rankScore, calculatePercentile, getNearbyBracket,
    getCompetitiveRival, detectRivalOvertake,
    DAILY_MISSION_CATALOG, getDailyMissions, getDeterministicDailyMissions: getDailyMissions, evaluateMissionProgress,
    STREAK_MILESTONES, getStreakMilestoneInfo, evaluateStreakTransition,
    SEASON_REWARDS, getCurrentSeason, checkDivisionTransition,
    formatCompetitiveShare, formatShareMessage: formatCompetitiveShare,
    ACADEMY_LESSONS, LICENSE_COMPLETION_BONUS,
    BADGE_DEFINITIONS, evaluateBadges,
    WEEKLY_BOUNTY_CATALOG, getWeeklyBounties, evaluateWeeklyBountyProgress,
    evaluateRevengeMatch, getNextBestAction,
    CREW_MILESTONES, CREW_PRESETS, validCrewTag, validCrewName, getCrewMilestoneInfo, calculateCrewContribution
  };
});
