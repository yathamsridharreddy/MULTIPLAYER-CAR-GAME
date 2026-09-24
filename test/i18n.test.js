'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('Full-Game Internationalization (i18n) Engine', () => {
  // Load public/js/i18n.js in a clean VM context
  const i18nCode = fs.readFileSync(path.join(__dirname, '../public/js/i18n.js'), 'utf8');
  const sandbox = { window: {}, localStorage: { getItem: () => 'en' } };
  vm.createContext(sandbox);
  vm.runInContext(i18nCode, sandbox);

  const SRI18N = sandbox.window.SRI18N;
  const tI18n = sandbox.window.tI18n;

  it('defines dictionary objects for all supported languages: en, te, hi, es', () => {
    assert.ok(SRI18N, 'SRI18N dictionary object exists');
    assert.ok(SRI18N.en, 'English dictionary exists');
    assert.ok(SRI18N.te, 'Telugu dictionary exists');
    assert.ok(SRI18N.hi, 'Hindi dictionary exists');
    assert.ok(SRI18N.es, 'Spanish dictionary exists');
  });

  it('contains critical keys across all dictionaries', () => {
    const requiredKeys = [
      'tagline', 'roomLabel', 'copy', 'install', 'signin', 'signout',
      'exitRoom', 'leftRoom', 'joiningRoom', 'createAnotherConfirm',
      'tabRace', 'tabRank', 'tabProf', 'tabSett',
      'clubs', 'badges', 'bounties', 'friends', 'garage',
      'quickplay', 'nextRival', 'dailyMissions', 'racingStreak',
      'modeRivalRush', 'modeSoloRush', 'modeSplit', 'modeElim', 'modeDrift',
      'inviteFriend', 'phoneController', 'setup',
      'leaderboard', 'compHub', 'globalRating', 'trackRecords', 'dailyCup', 'foundersCup',
      'driverProfile', 'settings',
      'sensLabel', 'sensHint', 'sensReset', 'sensResetDone', // v92 steering sensitivity slider
      'revengeBannerText', 'revengeAcceptToast', 'mapHostOnly', 'mapInRace', 'rivalTrackLoaded', // v93 revenge track
      'selectMode', 'modeMultiplayer', 'modeTimeTrial', 'modePractice',
      'mapTitle', 'mapHighland', 'mapNeon', 'mapIsland', 'mapCanyon', 'mapHairpin',
      'weatherTitle', 'wDry', 'wWet', 'wNight', 'wBlizzard',
      'carTitle', 'idTitle', 'racerNamePlaceholder', 'start',
      'raceResults', 'rematch', 'challengeFriend', 'changeCircuit', 'lobby',
      'rankedMovement', 'globalRank', 'rating', 'weeklyPts', 'raceRewardsLevel',
      'myGarage', 'badgesTitle', 'bountiesTitle', 'clubsTitle', 'racerProfile', 'racerAccount',
      'ctrlSteer', 'ctrlGasBrake', 'ctrlNitro', 'ctrlDrift', 'ctrlRematch', 'ctrlJoinTitle',
      'ghostReplay', 'raceThisGhost'
    ];

    ['en', 'te', 'hi', 'es'].forEach(lang => {
      const dict = SRI18N[lang];
      assert.ok(dict, `Dictionary for ${lang} must exist`);
      requiredKeys.forEach(k => {
        assert.ok(dict[k], `Language '${lang}' is missing key: '${k}'`);
      });
    });
  });

  it('translates correctly with tI18n for different languages', () => {
    assert.equal(tI18n('start', null, 'en'), '🏁 START RACE');
    assert.equal(tI18n('start', null, 'te'), '🏁 రేస్ ప్రారంభించండి');
    assert.equal(tI18n('start', null, 'hi'), '🏁 रेस शुरू करें');
    assert.equal(tI18n('start', null, 'es'), '🏁 INICIAR CARRERA');
  });

  it('interpolates string placeholders correctly', () => {
    assert.equal(
      tI18n('eliminated', { slot: 2 }, 'en'),
      '❌ P2 ELIMINATED'
    );
    assert.equal(
      tI18n('eliminated', { slot: 2 }, 'te'),
      '❌ P2 తొలగించబడ్డారు'
    );
    assert.equal(
      tI18n('eliminated', { slot: 2 }, 'hi'),
      '❌ P2 बाहर हो गए'
    );
    assert.equal(
      tI18n('eliminated', { slot: 2 }, 'es'),
      '❌ P2 ELIMINADO'
    );
    assert.equal(
      tI18n('tier', { tier: 3, tierName: 'GOLD' }, 'en'),
      'Tier 3 (GOLD)'
    );
  });

  it('falls back gracefully to english when given unknown language or unknown key', () => {
    assert.equal(tI18n('start', null, 'unknown_lang'), '🏁 START RACE');
    assert.equal(tI18n('totally_non_existent_key_xyz', null, 'en'), 'totally_non_existent_key_xyz');
  });
});
