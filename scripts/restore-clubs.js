#!/usr/bin/env node
'use strict';
/* ============================================================================
   v158 RECOVERY - rebuild the club tables from a running server's memory.

   A purge can leave a club row deleted while the game server still holds the
   club (and its roster) in RAM. Until that process restarts, its public club API
   is a complete copy of what the database lost, so this script reads it and
   prints the SQL that puts the rows back:

       node scripts/restore-clubs.js https://your-server-host > restore-clubs.sql

   then paste restore-clubs.sql into the Supabase SQL Editor and run it.

   What comes back exactly: the club row itself - id, tag, name, motto, badge,
   colour, weekly/total metres and weekly points are served raw by /api/crews.
   What comes back to the nearest 0.1 km: each member's own weekly and lifetime
   distance, because the public roster reports kilometres (it deliberately never
   exposes an account uuid, a device pid or the alias list - a public endpoint
   must not leak identities). Member identities are therefore absent by design:
   rows are keyed by the display name the roster shows, and the game re-attaches
   the real keys the next time that racer joins or finishes a race.

   Nothing here writes to the database. It only prints SQL.
   ========================================================================== */
const http = require('http');

const BASE = String(process.argv[2] || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('usage: node scripts/restore-clubs.js <server-url>  > restore-clubs.sql');
  process.exit(2);
}

// Node 18+ has fetch; older Node gets a tiny http client so this never breaks
function get(url) {
  if (typeof fetch === 'function') return fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : http;
    mod.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// The five clubs the server seeds itself (game-core CREW_PRESETS); they must
// stay flagged seeded or a later purge repair would treat them as user-made.
// Read from the shipped core so this list cannot drift from the server's.
let SEEDED = new Set();
try {
  const presets = require('../shared/progression.js').CREW_PRESETS || require('../public/js/progression.js').CREW_PRESETS || [];
  SEEDED = new Set(presets.map((p) => String(p.id)));
} catch (e) { SEEDED = new Set(['apex', 'drift', 'viper', 'titan', 'ghost']); }
if (!SEEDED.size) SEEDED = new Set(['apex', 'drift', 'viper', 'titan', 'ghost']);
const q = (v) => {
  if (v == null || v === '') return 'null';
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.round(v));
  return "'" + String(v).replace(/'/g, "''").replace(/[\u0000-\u001f]/g, ' ').slice(0, 200) + "'";
};
// the server's normCrewKey(): trim, drop an 'sb:' prefix, lowercase, cap at 64
const memberKey = (name) => String(name == null ? '' : name).trim().replace(/^sb:/i, '').toLowerCase().slice(0, 64);

(async () => {
  const list = await get(BASE + '/api/crews');
  const crews = (list && list.crews) || [];
  const weekKey = (list && list.weekKey) || '';
  const rosters = [];
  for (const c of crews) {
    try {
      const one = await get(BASE + '/api/crews/' + encodeURIComponent(c.id));
      rosters.push({ crew: c, detail: one && one.crew ? one.crew : null });
    } catch (e) {
      console.error('-- WARNING: could not read the roster of ' + c.id + ': ' + e.message);
      rosters.push({ crew: c, detail: null });
    }
  }

  const out = [];
  out.push('-- ============================================================================');
  out.push('-- SRIDHAR RUSH - club restore (generated ' + new Date().toISOString() + ')');
  out.push('-- from ' + BASE);
  out.push('-- ' + crews.length + ' club(s), week ' + (weekKey || 'unknown'));
  out.push('-- Idempotent: re-running it updates the same rows.');
  out.push('-- ============================================================================');
  out.push('');
  out.push('begin;');
  out.push('');

  for (const { crew, detail } of rosters) {
    const id = String(crew.id);
    out.push('-- ' + (crew.name || id) + ' [' + (crew.tag || '') + ']' + (SEEDED.has(id) ? ' (built-in)' : ''));
    out.push(
      'insert into public.crews (id, tag, name, motto, badge, color, weekly_meters, total_meters, weekly_points, week_key, seeded, created_at) values (' +
      [q(id), q(crew.tag), q(crew.name), q(crew.motto), q(crew.badge), q(crew.color),
        q(Number(crew.weeklyMeters) || 0), q(Number(crew.totalMeters) || 0), q(Number(crew.weeklyPoints) || 0),
        q(weekKey), SEEDED.has(id) ? 'true' : 'false', 'now()'].join(', ') + ')'
    );
    out.push('  on conflict (id) do update set');
    out.push('    tag = excluded.tag, name = excluded.name, motto = excluded.motto, badge = excluded.badge,');
    out.push('    color = excluded.color, weekly_meters = excluded.weekly_meters,');
    out.push('    total_meters = excluded.total_meters, weekly_points = excluded.weekly_points,');
    out.push('    seeded = excluded.seeded;');

    const members = (detail && Array.isArray(detail.members)) ? detail.members : [];
    for (const m of members) {
      const key = memberKey(m.name);
      if (!key) continue;
      const weekly = Math.round((Number(m.weeklyKm) || 0) * 1000);
      const total = Math.round((Number(m.totalKm) || 0) * 1000);
      out.push(
        'insert into public.crew_members (crew_id, member_key, name, role, aliases, weekly_meters, total_meters, weekly_points, week_key, joined_at) values (' +
        [q(id), q(key), q(String(m.name || 'RACER').slice(0, 16)), m.role === 'leader' ? "'leader'" : "'member'", "'{}'",
          q(weekly), q(total), q(Number(m.weeklyPoints) || 0), q(weekKey), q(m.joinedAt || null) === 'null' ? 'now()' : q(m.joinedAt)].join(', ') + ')'
      );
      out.push('  on conflict (crew_id, member_key) do update set');
      out.push('    name = excluded.name, role = excluded.role, weekly_meters = excluded.weekly_meters,');
      out.push('    total_meters = excluded.total_meters, weekly_points = excluded.weekly_points,');
      out.push('    week_key = excluded.week_key;');
    }
    if (members.length) out.push('-- ' + members.length + ' member(s) restored for ' + id);
    out.push('');
  }

  // the leader: the roster marks one, but the club row's leader_uid is an
  // identity the public API never sends. Point it at the leader's name key so
  // the row is coherent; the game rewrites the real key when they next race.
  const leaders = rosters.filter(({ detail }) => detail && Array.isArray(detail.members) && detail.members.some((m) => m.role === 'leader'));
  if (leaders.length) {
    out.push('-- the leader key follows the name the roster shows, until the game');
    out.push('-- re-persists the club on the next race (it still holds the real identity)');
    for (const { crew, detail } of leaders) {
      const lead = detail.members.find((m) => m.role === 'leader');
      out.push("update public.crews set leader_uid = " + q(memberKey(lead && lead.name)) +
        " where id = " + q(String(crew.id)) + ';');
    }
    out.push('');
  }

  out.push('commit;');
  out.push('');
  out.push('-- verify:');
  out.push('--   select c.id, c.name, c.weekly_meters, c.total_meters, count(m.*) as members');
  out.push('--     from public.crews c left join public.crew_members m on m.crew_id = c.id');
  out.push('--    group by c.id, c.name, c.weekly_meters, c.total_meters order by c.id;');
  out.push('');

  process.stdout.write(out.join('\n'));
})().catch((e) => {
  console.error('could not read ' + BASE + ': ' + e.message);
  console.error('the server must be running (and NOT restarted since the purge - its memory is the source)');
  process.exit(1);
});
