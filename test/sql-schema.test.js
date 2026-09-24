'use strict';
// ---------------------------------------------------------------------------
// The Supabase schema is edited by hand and run blind, in a web editor, against
// a production database. Nothing else in this suite touches Postgres, so a
// missing semicolon or an unbalanced dollar quote would only ever be discovered
// by whoever runs the file — mid-migration.
//
// These tests parse every .sql file in the repo with libpg-query, the actual
// Postgres parser compiled to WASM, including the plpgsql inside DO blocks and
// stored functions (where the migration's conditional logic lives).
//
// libpg-query is an OPTIONAL dependency: on a machine that could not fetch it the
// suite reports skipped rather than failed, so it can never block a deploy.
// ---------------------------------------------------------------------------
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let lint = null;
try {
  lint = require('../scripts/sql-lint.js');
} catch (e) { /* optional dependency absent */ }

const ROOT = path.resolve(__dirname, '..');
const SQL_FILES = fs.readdirSync(ROOT).filter((f) => f.endsWith('.sql')).sort();

describe('the Supabase schema parses as real Postgres', { skip: lint ? false : 'libpg-query not installed' }, () => {
  test('the repo actually ships SQL files to check', () => {
    assert.ok(SQL_FILES.length >= 3, `expected the setup plus both migrations, found ${SQL_FILES.length}`);
    assert.ok(SQL_FILES.includes('supabase-setup.sql'));
    assert.ok(SQL_FILES.includes('supabase-migration-v96.sql'));
  });

  for (const f of SQL_FILES) {
    test(`${f} parses (SQL and plpgsql)`, async () => {
      const sql = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const problems = await lint.lintSql(sql);
      assert.deepEqual(problems, [], `${f} does not parse:\n  ${problems.join('\n  ')}`);
    });
  }

  test('the migration the user runs blind is idempotent by construction', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase-migration-v96.sql'), 'utf8');
    // Every table it creates is guarded, every policy it makes is dropped first,
    // and both DO blocks check before they change anything. Without those guards
    // a second run throws, and a half-applied migration is worse than none.
    const creates = (sql.match(/create table(?!\s+if not exists)/gi) || []);
    assert.deepEqual(creates, [], 'every create table must be "if not exists"');
    const policies = (sql.match(/create policy/gi) || []).length;
    const drops = (sql.match(/drop policy if exists/gi) || []).length;
    assert.ok(drops >= policies, `${policies} policies created but only ${drops} dropped first`);
    assert.match(sql, /is distinct from 'crew_id,week_key,tier,member_key'/,
      'the primary-key swap must check the current key before dropping it');
  });

  test('the weekly claim primary key matches what the server writes', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase-migration-v96.sql'), 'utf8');
    const setup = fs.readFileSync(path.join(ROOT, 'supabase-setup.sql'), 'utf8');
    const PK = 'primary key (crew_id, week_key, tier, member_key)';
    assert.ok(sql.includes(PK), 'the migration widens the claim key to include the week');
    assert.ok(setup.includes(PK), 'and a fresh install is created that way too');
    // The server writes exactly these columns for a claim.
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(server, /crew_milestone_claims/, 'the server does write that table');
    for (const col of ['crew_id', 'tier', 'member_key', 'week_key']) {
      assert.ok(new RegExp(`${col}:`).test(server.slice(server.indexOf('async function persistCrewClaim'))),
        `persistCrewClaim still writes ${col}`);
    }
  });

  // --- negative controls: a linter that cannot fail is not a linter ---------
  test('the parser catches a plain SQL error', async () => {
    const problems = await lint.lintSql('create table t (id text); selekt 1 from t;');
    assert.ok(problems.length, 'a misspelled statement must be reported');
    assert.match(problems[0], /syntax error/);
  });

  test('the parser catches an unterminated dollar quote', async () => {
    const problems = await lint.lintSql("do $$ begin raise notice 'x';");
    assert.ok(problems.some((p) => /dollar-quoted/i.test(p)), 'an unclosed body must be reported');
  });

  test('the parser catches a plpgsql error inside a DO block', async () => {
    const problems = await lint.lintSql("do $$ begin rais notice 'hello'; end $$;");
    assert.ok(problems.some((p) => p.startsWith('plpgsql')), 'the body is checked, not just the SQL around it');
  });

  test('the parser catches an undeclared plpgsql variable', async () => {
    const problems = await lint.lintSql('do $$ begin v_nope := 1; end $$;');
    assert.ok(problems.some((p) => /not a known variable/i.test(p)));
  });

  test('the parser checks a function body against its own signature', async () => {
    // This is why the whole statement is parsed rather than the body alone:
    // `return 5` is only an error because the function declares RETURNS void.
    const problems = await lint.lintSql('create function f() returns void language plpgsql as $$ begin return 5; end $$;');
    assert.ok(problems.some((p) => /RETURN cannot have a parameter/i.test(p)));
    const fine = await lint.lintSql('create function g() returns json language plpgsql as $$ begin return json_build_object(\'ok\', true); end $$;');
    assert.deepEqual(fine, [], 'the same body is legal when the signature allows it');
  });

  test('statement splitting does not break on semicolons inside strings', () => {
    const stmts = lint.splitStatements("create policy p on t for select using (name = 'a;b'); select 1;");
    assert.equal(stmts.length, 2, 'the semicolon inside the literal is not a boundary');
    const dq = lint.splitStatements("do $$ begin raise notice 'hi;there'; end $$; select 2;");
    assert.equal(dq.length, 2, 'nor is one inside a dollar-quoted body');
  });
});
