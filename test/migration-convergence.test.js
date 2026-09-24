'use strict';

/* ============================================================================
   v98 — the convergent migration must be runnable from ANY database state.

   supabase-migration-v96.sql began with

       drop policy if exists "missions own read" on public.player_missions;

   IF EXISTS applies to the POLICY, not to the TABLE. On a database created before
   the progression tables existed - a real production database, reported as

       ERROR: 42P01: relation "public.player_missions" does not exist

   - that first line aborted the whole script, so the club tables it was meant to
   create were still missing afterwards and the failure looked like "the migration
   did nothing". Nothing in the suite caught it: sql-schema.test.js parses the file
   with libpg-query, and a statement that is perfectly valid Postgres can still
   reference a table the target database does not have.

   These tests check the properties that make a migration safe to hand to somebody
   who is going to paste it into a web editor against a production database and
   click Run exactly once:

     1. it creates every table the server reads or writes
     2. it creates the same tables and the same policies as supabase-setup.sql, so
        the convergent migration and the canonical schema cannot drift apart
     3. no statement references a table before that table is created  <- the 42P01
     4. every create policy is preceded by a drop policy if exists, so the file can
        be run twice
     5. the uuid -> text relaxation happens before any policy is created, because a
        policy comparing auth.uid()::text cannot be built over a uuid column
   ========================================================================== */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const V98 = read('supabase-migration-v98.sql');
const SETUP = read('supabase-setup.sql');
const SERVER = read('server.js');

/** strip comments so a table name inside prose is not counted as a reference */
function stripComments(sql) {
  return sql.split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

const V98_CODE = stripComments(V98);
const SETUP_CODE = stripComments(SETUP);

function tablesCreated(sql) {
  const out = new Set();
  const re = /create table if not exists\s+(?:public\.)?([a-z_]+)/g;
  let m;
  while ((m = re.exec(sql)) !== null) out.add(m[1]);
  return out;
}

function policiesOf(sql) {
  const out = [];
  const re = /create policy\s+"([^"]+)"\s+on\s+(?:public\.)?([a-z_]+)/g;
  let m;
  while ((m = re.exec(sql)) !== null) out.push({ name: m[1], table: m[2] });
  return out;
}

/** every table name the server sends to PostgREST, by either call style */
function serverTables() {
  const out = new Set();
  let m;
  const rest = /rest\/v1\/([a-z_]+)/g;
  while ((m = rest.exec(SERVER)) !== null) out.add(m[1]);
  const helper = /\bsb[A-Za-z]+\(\s*'([a-z_]{3,})'/g;
  while ((m = helper.exec(SERVER)) !== null) out.add(m[1]);
  out.delete('rpc');           // /rest/v1/rpc/<function>, not a table
  return out;
}

describe('v98 convergent migration', () => {
  test('creates every table the server reads or writes', () => {
    const created = tablesCreated(V98_CODE);
    const missing = [...serverTables()].filter((t) => !created.has(t)).sort();
    assert.deepStrictEqual(missing, [],
      'the server touches tables the migration never creates: ' + missing.join(', '));
  });

  test('creates exactly the canonical schema - no drift from supabase-setup.sql', () => {
    const a = [...tablesCreated(V98_CODE)].sort();
    const b = [...tablesCreated(SETUP_CODE)].sort();
    assert.deepStrictEqual(a, b, 'v98 and setup.sql must define the same tables');
    assert.ok(a.length >= 25, 'expected the full schema, found ' + a.length);
  });

  test('carries every policy from supabase-setup.sql, and no others', () => {
    const key = (p) => p.name + '@' + p.table;
    const a = policiesOf(V98_CODE).map(key).sort();
    const b = policiesOf(SETUP_CODE).map(key).sort();
    assert.deepStrictEqual(a, b, 'the policy set must survive the transform intact');
    assert.equal(new Set(a).size, a.length, 'a policy must not be created twice');
  });

  test('no statement references a table before that table is created (the 42P01 bug)', () => {
    // Every policy statement - the drop as much as the create - names a table, and
    // Postgres resolves that name immediately. This is exactly what v96 got wrong.
    const lines = V98_CODE.split('\n');
    const createdAt = new Map();
    lines.forEach((l, i) => {
      const m = /create table if not exists\s+(?:public\.)?([a-z_]+)/.exec(l);
      if (m && !createdAt.has(m[1])) createdAt.set(m[1], i);
    });
    const bad = [];
    lines.forEach((l, i) => {
      const m = /^(?:drop|create)\s+policy\s+(?:if exists\s+)?"[^"]+"\s+on\s+(?:public\.)?([a-z_]+)/.exec(l.trim());
      if (!m) return;
      const at = createdAt.get(m[1]);
      if (at === undefined) bad.push(`line ${i + 1}: policy on "${m[1]}" which this file never creates`);
      else if (at > i) bad.push(`line ${i + 1}: policy on "${m[1]}" before its create table at line ${at + 1}`);
    });
    assert.deepStrictEqual(bad, [], bad.join('\n'));
  });

  test('every create policy is preceded by a drop policy if exists, so it can be re-run', () => {
    const norm = V98_CODE.replace(/\s+/g, ' ');
    const unguarded = policiesOf(V98_CODE).filter((p) => {
      const drop = `drop policy if exists "${p.name}" on public.${p.table};`;
      const create = norm.indexOf(`create policy "${p.name}" on public.${p.table}`);
      const before = norm.lastIndexOf(drop.replace(/\s+/g, ' '), create);
      return before < 0 || create - before > 200;
    });
    assert.deepStrictEqual(unguarded.map((p) => p.name), [],
      'a create policy without an adjacent drop is a second-run failure: ' + unguarded.map((p) => p.name).join(', '));
  });

  test('relaxes uuid -> text BEFORE any policy is created', () => {
    const firstPolicy = V98_CODE.indexOf('create policy');
    const relaxA = V98_CODE.indexOf("array['player_missions', 'weekly_bounties', 'player_badges']");
    const relaxB = V98_CODE.indexOf("'player_stats',");
    assert.ok(firstPolicy > 0, 'the file must create policies');
    assert.ok(relaxA > 0 && relaxA < firstPolicy, 'the v96 relaxation loop must run first');
    assert.ok(relaxB > 0 && relaxB < firstPolicy, 'the v97 relaxation loop must run first');
    // a policy comparing auth.uid()::text over a uuid column is a hard error, so the
    // eight identity-bound policies must be dropped before their columns are altered
    const firstDrop = V98_CODE.indexOf('drop policy if exists "missions own read"');
    assert.ok(firstDrop > 0 && firstDrop < relaxA, 'identity-bound policies must be dropped before the alter');
  });

  test('covers all fifteen identity columns, not just the ones that broke first', () => {
    const expected = [
      'player_missions', 'weekly_bounties', 'player_badges',
      'player_stats', 'player_map_records', 'race_history', 'player_achievements',
      'player_seasons', 'player_wallet', 'player_inventory', 'player_equipped',
      'coin_ledger', 'daily_competition', 'weekly_competition', 'season_rewards_claimed'
    ];
    const missing = expected.filter((t) => !V98_CODE.includes(`'${t}'`));
    assert.deepStrictEqual(missing, [], 'not relaxed: ' + missing.join(', '));
  });

  test('drops the uuid coin-function overloads before recreating them with text', () => {
    const dropEarn = V98_CODE.indexOf('drop function if exists public.earn_coins(uuid');
    const dropSpend = V98_CODE.indexOf('drop function if exists public.spend_coins(uuid');
    const createEarn = V98_CODE.indexOf('create or replace function public.earn_coins(p_uid text');
    assert.ok(dropEarn >= 0 && dropSpend >= 0, 'both legacy overloads must be dropped');
    assert.ok(createEarn > dropEarn, 'dropping after recreating would leave two ambiguous overloads');
  });

  test('adds the board name columns the server probes for at boot', () => {
    ['player_stats', 'daily_competition', 'weekly_competition'].forEach((t) => {
      assert.match(V98_CODE, new RegExp(
        'alter table if exists public\\.' + t + '\\s+add column if not exists name text not null default \'\';'),
        t + '.name must be added');
    });
  });

  test('widens the club milestone claim key to include the week', () => {
    assert.match(V98_CODE, /pk_cols is distinct from 'crew_id,week_key,tier,member_key'/);
    assert.match(V98_CODE, /add primary key \(crew_id, week_key, tier, member_key\)/);
  });

  test('the superseded migrations say so, and point here', () => {
    ['supabase-migration-v94.sql', 'supabase-migration-v96.sql', 'supabase-migration-v97.sql'].forEach((f) => {
      const head = read(f).split('\n').slice(0, 20).join('\n');
      assert.match(head, /supabase-migration-v98\.sql/,
        f + ' must tell the reader that v98 supersedes it - otherwise the 42P01 failure repeats');
    });
  });

  test('the README sends an existing project to v98, not to a two-file sequence', () => {
    const readme = read('README.md');
    assert.match(readme, /supabase-migration-v98\.sql/);
    const at = readme.indexOf('supabase-migration-v98.sql');
    assert.ok(at > 0);
  });

  /* ======================================================================== *
   * The 42P01 came back a SECOND time, on a line that was already guarded:
   *
   *   if to_regclass('public.player_revenge') is not null
   *      and not exists (select 1 from public.player_revenge) then
   *
   *   ERROR: 42P01: relation "public.player_revenge" does not exist
   *   QUERY: to_regclass('public.player_revenge') is not null and not exists (...)
   *
   * plpgsql parses the WHOLE condition before evaluating any of it, so the
   * to_regclass() short-circuit never got a chance: the static table reference on
   * the second line was resolved at parse time. Anything that inspects a table
   * which may be missing has to go through EXECUTE.
   *
   * scripts/sql-lint.js cannot catch this class at all - libpg-query validates the
   * outer statement and treats a DO body as an opaque string, which is also why a
   * build placeholder (__CONV_ROWS__) once shipped inside one and linted clean.
   * These tests are the coverage for that blind spot.
   * ======================================================================== */

  /** Text between two `-- N. heading` section markers. */
  function sectionOf(sql, startHeading, endHeading) {
    const a = sql.indexOf('-- ' + startHeading);
    assert.ok(a >= 0, 'v98 lost its "' + startHeading + '" heading');
    const b = sql.indexOf('-- ' + endHeading, a + 1);
    assert.ok(b > a, 'v98 lost its "' + endHeading + '" heading after "' + startHeading + '"');
    return sql.slice(a, b);
  }

  /** Columns of a canonical table: [{ name, rest }] with rest = type + modifiers. */
  function columnsOf(table) {
    const src = SETUP_CODE;
    const head = 'create table if not exists public.' + table + ' (';
    const start = src.indexOf(head);
    if (start < 0) return [];
    let depth = 0;
    let end = -1;
    for (let k = start + head.length - 1; k < src.length; k++) {
      const ch = src[k];
      if (ch === "'") { k++; while (k < src.length && src[k] !== "'") k++; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { end = k; break; } }
    }
    assert.ok(end > start, 'unbalanced parentheses in the definition of ' + table);
    const body = src.slice(start + head.length, end);
    const parts = [];
    depth = 0;
    let cur = '';
    for (let k = 0; k < body.length; k++) {
      const ch = body[k];
      if (ch === "'") { cur += ch; k++; while (k < body.length && body[k] !== "'") { cur += body[k]; k++; } cur += "'"; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else { cur += ch; }
    }
    parts.push(cur);
    const cols = [];
    for (const raw of parts) {
      const part = raw.replace(/\s+/g, ' ').trim();
      if (!part) continue;
      if (/^(primary key|unique|foreign key|check|constraint|exclude)\b/i.test(part)) continue;
      const m = /^"?([a-z_][a-z0-9_]*)"?\s+(.+)$/i.exec(part);
      if (m) cols.push({ name: m[1], rest: m[2] });
    }
    return cols;
  }

  /** Each DO block: { tag, body }. */
  function doBlocks() {
    const out = [];
    const re = /\bdo\s+(\$[a-z_]*\$)([\s\S]*?)\1\s*;/gi;
    let m;
    while ((m = re.exec(V98))) out.push({ tag: m[1], body: m[2] });
    return out;
  }

  /**
   * plpgsql body with comments AND string literals blanked. Dollar-quoted literals
   * matter most: section 3 embeds 165 `add column if not exists ...` strings, and
   * counting their `if` as control flow would make every balance check meaningless.
   */
  function skeleton(body) {
    return body
      .replace(/--[^\n]*/g, ' ')
      .replace(/\$\$[\s\S]*?\$\$/g, "''")
      .replace(/'(?:[^']|'')*'/g, "''")
      .toLowerCase();
  }

  test('no build placeholder ever reaches a shipped SQL file', () => {
    for (const f of ['supabase-migration-v98.sql', 'supabase-setup.sql']) {
      const sql = read(f);
      assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(sql),
        f + ' still contains a build placeholder - lint cannot see it inside a DO body');
    }
  });

  test('section 3 converges every column of every canonical table', () => {
    const section = sectionOf(V98, '3. converge columns', '4. converge indexes');
    const have = new Map();
    // lazy up to the next $$, because a CHECK constraint may contain a bare $
    const rowRe = /\(\$\$(\w+)\$\$, \$\$(\w+)\$\$, \$\$([\s\S]*?)\$\$, \$\$([\s\S]*?)\$\$\)/g;
    let m;
    while ((m = rowRe.exec(section))) {
      have.set(m[1] + '.' + m[2], { strict: m[3], loose: m[4] });
      const pre = 'alter table public.' + m[1] + ' add column if not exists ' + m[2] + ' ';
      assert.ok(m[3].startsWith(pre), m[1] + '.' + m[2] + ' strict DDL does not target that column');
      assert.ok(m[4].startsWith(pre), m[1] + '.' + m[2] + ' loose DDL does not target that column');
    }
    const missing = [];
    for (const t of tablesCreated(SETUP_CODE)) {
      for (const c of columnsOf(t)) {
        if (!have.has(t + '.' + c.name)) missing.push(t + '.' + c.name);
      }
    }
    assert.deepEqual(missing, [],
      'a table that already exists keeps its old shape, so every canonical column ' +
      'must be added if absent: ' + missing.join(', '));
    assert.ok(have.size >= 150, 'expected the whole schema, converged ' + have.size + ' columns');
  });

  test('section 3 falls back to a nullable column instead of failing', () => {
    const section = sectionOf(V98, '3. converge columns', '4. converge indexes');
    // a not-null column with no default cannot be added to a table that has rows
    const strictOnly = [...section.matchAll(/\(\$\$(\w+)\$\$, \$\$(\w+)\$\$, \$\$([^$]*not null[^$]*)\$\$, \$\$([^$]*)\$\$\)/g)]
      .filter((m) => !/default|generated/.test(m[3]));
    assert.ok(strictOnly.length > 0, 'expected some not-null-without-default columns');
    for (const m of strictOnly) {
      assert.ok(!/not null/.test(m[4]),
        m[1] + '.' + m[2] + ' loose fallback still says not null, so it would fail the same way');
    }
    assert.match(section, /exception when others then/, 'the strict attempt must be wrapped in a savepoint');
    assert.match(section, /raise notice 'column converge skipped/, 'a column that cannot be added must be reported');
  });

  test('section 4 converges every canonical index, guarded', () => {
    const want = new Set();
    const idxRe = /create index if not exists (\w+)\s+on public\.(\w+)\s*\(([^;]*)\);/g;
    let m;
    while ((m = idxRe.exec(SETUP_CODE))) want.add(m[2] + '.' + m[1]);
    const section = sectionOf(V98, '4. converge indexes', '5. identity columns');
    const have = new Set();
    const rowRe = /\(\$\$(\w+)\$\$, \$\$create index if not exists \1 on public\.(\w+)\s*\(([^$]*)\)\$\$\)/g;
    while ((m = rowRe.exec(section))) have.add(m[2] + '.' + m[1]);
    const missing = [...want].filter((k) => !have.has(k)).sort();
    assert.deepEqual(missing, [], 'index convergence is missing: ' + missing.join(', '));
    assert.match(section, /raise notice 'index skipped/, 'a failing index must be reported, not fatal');
  });

  test('no IF condition anywhere in v98 names a table statically (the 42P01 class)', () => {
    const offenders = [];
    for (const { tag, body } of doBlocks()) {
      const skel = skeleton(body).replace(/\bend\s+if\b/g, ' endif ');
      const ifRe = /(?:^|[\s;])if([\s\S]*?)\bthen\b/g;
      let m;
      while ((m = ifRe.exec(skel))) {
        const cond = m[1];
        const hit = /(?:\bfrom\b|\bjoin\b|\bupdate\b|\binto\b|\bon\b)\s+public\.\w+/.exec(cond);
        if (hit) offenders.push(tag + ': ' + cond.replace(/\s+/g, ' ').trim().slice(0, 90));
      }
    }
    assert.deepEqual(offenders, [],
      'plpgsql parses a whole IF condition before evaluating it, so to_regclass() on ' +
      'the same line cannot short-circuit a static table reference - this is the ' +
      'player_revenge 42P01. Inspect possibly-missing tables with EXECUTE.');
  });

  test('the old-shape player_revenge check goes through EXECUTE', () => {
    const section = sectionOf(V98, '1. old-shape player_revenge', '2. the canonical schema');
    assert.match(section, /if to_regclass\('public\.player_revenge'\) is null then/,
      'existence must be probed with to_regclass(), which returns null instead of throwing');
    assert.match(section, /execute 'select exists \(select 1 from public\.player_revenge\)' into has_rows/,
      'the row check must be dynamic SQL, so the name resolves at run time');
    assert.match(section, /execute 'drop table public\.player_revenge cascade'/,
      'the drop must be dynamic too, so it is never planned against a missing table');
    assert.match(section, /raise notice 'player_revenge has rows/,
      'a populated old-shape table must be reported, not silently dropped');
  });

  test('every plpgsql body in v98 is structurally balanced', () => {
    const blocks = doBlocks();
    assert.ok(blocks.length >= 6, 'expected at least 6 DO blocks, found ' + blocks.length);
    const count = (skel, re) => (skel.match(re) || []).length;
    for (const { tag, body } of blocks) {
      const skel = skeleton(body);
      const endIfs = count(skel, /\bend\s+if\b/g);
      // `end if` contains the token `if`; blank it so it is not counted twice
      // skeleton() has already blanked every string literal, so the only `if`
      // tokens left are real control flow - including `if exists (select ...)`
      const ifs = count(skel.replace(/\bend\s+if\b/g, ' endif '), /(?:^|[\s;])if\b/g);
      const endLoops = count(skel, /\bend\s+loop\b/g);
      const loops = count(skel.replace(/\bend\s+loop\b/g, ' endloop '), /\bloop\b/g);
      const begins = count(skel, /\bbegin\b/g);
      const plainEnds = count(skel, /\bend\b(?!\s+(?:if|loop|case)\b)/g);
      assert.strictEqual(ifs, endIfs, tag + ': ' + ifs + ' IF vs ' + endIfs + ' END IF');
      assert.strictEqual(loops, endLoops, tag + ': ' + loops + ' LOOP vs ' + endLoops + ' END LOOP');
      assert.strictEqual(begins, plainEnds, tag + ': ' + begins + ' BEGIN vs ' + plainEnds + ' END');
    }
  });

  test('dollar-quoted bodies are balanced and nested tags differ', () => {
    const tags = [...V98.matchAll(/\$[a-z_]*\$/g)].map((m) => m[0]);
    assert.strictEqual(tags.length % 2, 0,
      'an odd number of dollar tags means an unterminated body somewhere');
    const stack = [];
    for (const t of tags) {
      if (stack.length && stack[stack.length - 1] === t) stack.pop();
      else {
        assert.ok(!stack.includes(t),
          t + ' reused while still open - a body nested inside another needs its own tag');
        stack.push(t);
      }
    }
    assert.deepEqual(stack, [], 'unclosed dollar-quoted body: ' + stack.join(', '));
  });

  test('the in-game fix instructions name v98, never a superseded file', () => {
    // The banners a racer actually sees said "run supabase-migration-v96.sql (then
    // v97)" long after both files were known to abort with 42P01 on a database
    // older than v94 - the game was instructing the exact run that cannot work.
    // Whatever the UI says has to be the file that converges from any state.
    const js = read('public/js/game.js');
    const fixes = [...js.matchAll(/Fix once: run[^'\n]*/g)].map((m) => m[0]);
    assert.ok(fixes.length >= 3,
      'expected the three racer-facing fix strings (clubs, boards, uuid), found ' + fixes.length);
    for (const f of fixes) {
      assert.match(f, /supabase-migration-v98\.sql/,
        'a banner tells a racer to run something other than the convergent file: ' + f);
      assert.ok(!/v9[467]\.sql/.test(f),
        'a banner still sends racers to a file that aborts with 42P01: ' + f);
    }
  });

});
