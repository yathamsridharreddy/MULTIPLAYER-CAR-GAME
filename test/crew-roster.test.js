'use strict';
/* ============================================================================
   v156 — "who is in which club", for everybody.

   The club directory used to be a list of names with a member COUNT on it: you
   could see that a club had eleven racers, but not one of their names until you
   had joined it yourself. A club tag on a car in a lobby is worth nothing if the
   only people who can find out what it stands for are its own members.

   So there is now a public roster: any racer can open any club and see who races
   in it. Two halves are tested here, because both can break the feature:

     1. the relay's answer — a public view with display names and roles, and NOT
        the identities it settles races by (uuid, device pid, alias list);
     2. the client's drawing of it — every member listed, the reader's own row
        marked, the leader first, and a name that tries to be HTML rendered as
        text (names are user input and they land in a table).
   ========================================================================== */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const S = require('../server.js');
const { app, memCrews, memPlayerCrew } = S;

let srv, base;
before(async () => {
  await new Promise((r) => { srv = http.createServer(app); srv.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + srv.address().port; r(); }); });
});
after(async () => { if (srv) await new Promise((r) => srv.close(r)); });

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, json: await res.json() };
};
const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

// a club with a leader and two members, each with a different week behind them.
// Display names carry the tag because two racers really can share a name, and a test
// that moves one between clubs has to be able to tell them apart.
async function seedClub() {
  const tag = 'T' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const names = { lead: 'LEAD_' + tag, mid: 'MID_' + tag, back: 'BACK_' + tag };
  const made = await post('/api/player/crew/create', {
    uid: 'roster-lead-' + tag, name: names.lead, crewName: 'Roster Test Squad',
    tag, motto: 'Everybody can see us', badge: 'bolt', color: '#00e5ff'
  });
  assert.equal(made.json.ok, true, 'the club was founded: ' + JSON.stringify(made.json));
  const id = made.json.crew.id;
  await post('/api/player/crew/join', { uid: 'roster-r2-' + tag, name: names.mid, crewId: id });
  await post('/api/player/crew/join', { uid: 'roster-r3-' + tag, name: names.back, crewId: id });
  const c = memCrews.get(id);
  c.weeklyMeters = 42000; c.totalMeters = 900000; c.weeklyPoints = 320;
  const byName = (n) => c.members.find((m) => m.name === n);
  byName(names.lead).weeklyMeters = 5000; byName(names.lead).totalMeters = 120000;
  byName(names.mid).weeklyMeters = 31000; byName(names.mid).totalMeters = 640000;
  byName(names.back).weeklyMeters = 6000; byName(names.back).totalMeters = 140000;
  for (const m of c.members) m.weeklyPoints = Math.round(m.weeklyMeters / 100);
  return { id, tag, names };
}

describe('v156 — a club roster anyone can read', () => {
  beforeEach(() => { memPlayerCrew.clear(); });

  test('a stranger with no club can read any club and see who is in it', async () => {
    const { id, names } = await seedClub();
    const { status, json } = await get('/api/crews/' + id);
    assert.equal(status, 200, 'the roster is public');
    assert.equal(json.ok, true);
    const c = json.crew;
    assert.equal(c.memberCount, 3, 'every member is counted');
    assert.equal(c.members.length, 3, 'and every member is listed');
    assert.deepEqual(c.members.map((m) => m.name).sort(), [names.back, names.lead, names.mid].sort());
    assert.equal(c.leaderName, names.lead, 'the club says who runs it');
    assert.equal(c.tag.length, 5, 'the roster carries the club identity, so the view can head itself');
    assert.ok(c.name && c.motto, 'and the name and motto');
    assert.equal(c.weeklyKm, 42, 'with the club weekly distance');
    assert.equal(c.weeklyPoints, 320, 'and its weekly points');
    assert.equal(typeof c.currentTier, 'number', 'and where it is on the milestone track');
  });

  test('the roster reads like a scoreboard: the leader, then this week\'s distance', async () => {
    const { id, names } = await seedClub();
    const { json } = await get('/api/crews/' + id);
    const rows = json.crew.members;
    assert.equal(rows[0].role, 'leader', 'the leader is first whatever the distance says');
    assert.equal(rows[0].name, names.lead);
    const rest = rows.slice(1).map((m) => m.weeklyKm);
    assert.deepEqual(rest, rest.slice().sort((a, b) => b - a), 'the rest is by distance, most first');
    assert.deepEqual(rows.slice(1).map((m) => m.name), [names.mid, names.back]);
  });

  test('the public row carries a name, a role and a contribution — nothing else', async () => {
    const { id, names } = await seedClub();
    const { json } = await get('/api/crews/' + id);
    const allowed = ['name', 'role', 'weeklyKm', 'totalKm', 'weeklyPoints', 'joinedAt', 'you'];
    for (const m of json.crew.members) {
      assert.deepEqual(Object.keys(m).sort(), allowed.slice().sort(),
        'a public row is exactly the public fields: ' + Object.keys(m).join());
    }
    // the settlement identities must never be published - they are how the relay
    // decides who a race counts for, and they are not the club's to hand out
    const raw = JSON.stringify(json);
    assert.doesNotMatch(raw, /roster-lead-|roster-r2-|roster-r3-/, 'no uid or pid reaches the client');
    assert.doesNotMatch(raw, /"aliases"/, 'and no alias list either');
    assert.equal(json.crew.members.find((m) => m.name === names.mid).weeklyKm, 31, 'their own week is right');
    assert.equal(json.crew.members.find((m) => m.name === names.mid).totalKm, 640, 'and their total too');
  });

  test('the reader\'s own row is marked, and only in a club they are actually in', async () => {
    const a = await seedClub();
    const b = await seedClub();
    const mine = await get(`/api/crews/${a.id}?uid=roster-r2-${a.tag}&name=${a.names.mid}`);
    const marked = mine.json.crew.members.filter((m) => m.you);
    assert.equal(marked.length, 1, 'exactly one row is me');
    assert.equal(marked[0].name, a.names.mid);
    // the same racer looking at a club they are not in is a stranger like any other
    const other = await get(`/api/crews/${b.id}?uid=roster-r2-${a.tag}&name=${a.names.mid}`);
    assert.equal(other.json.crew.members.filter((m) => m.you).length, 0, 'nobody is marked in a club I am not in');
    // and a reader who sends no identity at all marks nobody
    const anon = await get('/api/crews/' + a.id);
    assert.equal(anon.json.crew.members.filter((m) => m.you).length, 0, 'an anonymous look marks no rows');
  });

  test('a club that does not exist says so instead of inventing an empty one', async () => {
    const { status, json } = await get('/api/crews/no-such-club-anywhere');
    assert.equal(status, 404);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'crew_not_found');
  });

  test('the club directory lists every club with who runs it', async () => {
    const { id, names } = await seedClub();
    const { json } = await get('/api/crews');
    assert.equal(json.ok, true);
    const entry = json.crews.find((c) => c.id === id);
    assert.ok(entry, 'the new club is in the directory');
    assert.equal(entry.memberCount, 3, 'with its member count');
    assert.equal(entry.leaderName, names.lead, 'and the racer who runs it, so the list reads at a glance');
    // a seeded preset has no roster yet: the card must not name a leader who is not there
    const empty = json.crews.find((c) => c.id === 'apex');
    assert.ok(empty, 'the presets are still listed');
    assert.ok(empty.leaderName === null || typeof empty.leaderName === 'string', 'no crash on an empty club');
  });

  test('a club founds, fills and empties without the roster ever lying', async () => {
    const { id, tag, names } = await seedClub();
    const before = await get('/api/crews/' + id);
    assert.equal(before.json.crew.memberCount, 3);
    // one racer leaves for another club: the roster of both clubs has to follow
    const other = await seedClub();
    await post('/api/player/crew/join', { uid: 'roster-r3-' + tag, name: names.back, crewId: other.id });
    const a = await get('/api/crews/' + id);
    const b = await get('/api/crews/' + other.id);
    assert.equal(a.json.crew.memberCount, 2, 'they are out of the club they left');
    assert.equal(a.json.crew.members.some((m) => m.name === names.back), false, 'and off its roster');
    assert.equal(b.json.crew.memberCount, 4, 'and counted in the club they joined');
    assert.equal(b.json.crew.members.filter((m) => m.name === names.back).length, 1, 'exactly once');
  });
});

/* ---------------------------------------------------------------------------
   The client half: the shipped roster renderer, drawn against real club data.
   ------------------------------------------------------------------------- */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8');

function extractFn(name) {
  const at = SRC.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' is in game.js');
  let depth = 0;
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(at, j + 1); }
  }
  throw new Error('could not extract ' + name);
}

function rosterSandbox(lang) {
  const sb = {
    console,
    prefs: { lang: lang || 'en' },
    // the two markup helpers the roster leans on: the real ones live in the icon
    // sprite and badge tables, and all this view needs is that they emit a node
    icoSpan: (n, tone) => '<span class="ico ' + (tone || '') + '" data-i="' + n + '"></span>',
    badgeMarkup: (b) => '<span class="badge" data-i="' + (b || 'race-flag') + '"></span>'
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8'), sb, { filename: 'i18n.js' });
  sb.SRI18N = sb.window.SRI18N;
  vm.runInContext(extractFn('tI18n') + '\n' + extractFn('escapeHtml') + '\n' + extractFn('crewRosterHtml') +
    '\n;globalThis.__html = crewRosterHtml;', sb, { filename: 'roster.js' });
  return sb;
}

const club = (over) => Object.assign({
  id: 'live', tag: 'LIVE', name: 'Live Test Squad', motto: 'Everybody can see us',
  badge: 'bolt', color: '#00e5ff', memberCount: 3, weeklyKm: 42, weeklyPoints: 320, totalKm: 900,
  currentTier: 2, progressPct: 40, nextMilestone: { tier: 3, reqKm: 150 }, resetsIn: '2d 4h',
  leaderName: 'APEX_KING',
  members: [
    { name: 'APEX_KING', role: 'leader', weeklyKm: 5, totalKm: 120, weeklyPoints: 50, joinedAt: '2026-01-01', you: false },
    { name: 'MID_PACK', role: 'member', weeklyKm: 31, totalKm: 640, weeklyPoints: 310, joinedAt: '2026-02-01', you: true },
    { name: 'BACKMARKER', role: 'member', weeklyKm: 6, totalKm: 140, weeklyPoints: 60, joinedAt: '2026-03-01', you: false }
  ]
}, over || {});

describe('v156 — the roster the racer actually sees', () => {
  test('lists every member, marks me, and crowns the leader', () => {
    const sb = rosterSandbox();
    const html = sb.__html(club(), { backTab: 'join' });
    for (const m of club().members) assert.match(html, new RegExp('>' + m.name + '<'), 'every member is on the roster: ' + m.name);
    assert.match(html, /is-me/, 'my row is highlighted');
    assert.match(html, /\(YOU\)/, 'and says it is mine');
    assert.match(html, /LEADER/, 'the leader is labelled');
    assert.match(html, /MEMBER/, 'and so are the rest');
    assert.match(html, /APEX_KING/, 'the club names who runs it');
    assert.match(html, /31 km/, "each racer's week is shown");
    assert.match(html, /data-back="join"/, 'BACK returns to the list the racer came from');
  });

  test('a club with nobody in it says so instead of drawing an empty table', () => {
    const sb = rosterSandbox();
    const html = sb.__html(club({ memberCount: 0, members: [], leaderName: null }), { backTab: 'board' });
    assert.doesNotMatch(html, /<table/, 'no empty table');
    assert.match(html, /No racers in this club yet/, 'the reader is told');
    assert.match(html, /data-back="board"/, 'and BACK still returns to the standings');
  });

  test('a racer name can never become markup', () => {
    const sb = rosterSandbox();
    const html = sb.__html(club({
      members: [{ name: '<img src=x onerror=alert(1)>', role: 'member', weeklyKm: 1, totalKm: 1, weeklyPoints: 1, you: false }]
    }));
    assert.doesNotMatch(html, /<img/, 'the name is text, never a tag');
    assert.match(html, /&lt;img/, 'escaped, and still readable');
  });

  test('a club name and motto from the server are escaped too', () => {
    const sb = rosterSandbox();
    const html = sb.__html(club({ name: '<script>bad()</script>', motto: '" onload="x', leaderName: '<b>nope</b>' }));
    assert.doesNotMatch(html, /<script>/, 'no script tag survives');
    assert.doesNotMatch(html, /<b>nope<\/b>/, 'and a leader name is text');
  });

  test('the roster is translated, not English-only', () => {
    const en = rosterSandbox('en').__html(club());
    const es = rosterSandbox('es').__html(club());
    const te = rosterSandbox('te').__html(club());
    assert.notEqual(en, es, 'a Spanish page reads Spanish');
    assert.notEqual(en, te, 'and a Telugu page reads Telugu');
    for (const html of [en, es, te]) {
      assert.doesNotMatch(html, /\{\w+\}/, 'no {placeholder} is left on screen');
      assert.doesNotMatch(html, /undefined/, 'and no field the server did not send');
    }
  });

  test('both ways in to a club open the same roster', () => {
    // the club list ("who is in this one?") and the championship table both have to
    // reach the roster view, or half the racers never find it
    const bare = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(bare, /openCrewRoster\('\$\{cr\.id\}', 'join'\)/, 'the club card offers WHO IS IN');
    assert.match(bare, /openCrewRoster\('\$\{cr\.id\}', 'board'\)/, 'and so does the standings table');
    assert.match(bare, /window\.openCrewRoster = async function/, 'and the view is reachable from the markup');
  });
});
