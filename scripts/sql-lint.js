'use strict';
// ---------------------------------------------------------------------------
// SQL lint — parses every .sql file in this repo with the REAL Postgres grammar.
//
// Why this exists: the Supabase schema is edited by hand and run blind in a web
// editor against a production database. A missing semicolon or an unbalanced
// dollar quote is only discovered there, by the person running it. `node --test`
// cannot catch that, because nothing in the test suite touches Postgres.
//
// It uses libpg-query (the Postgres parser itself, compiled to WASM), so it also
// validates the plpgsql inside `do $$ ... $$` blocks and stored functions —
// which is where the migration's conditional logic actually lives.
//
//   node scripts/sql-lint.js            # lint every .sql file in the repo
//   node scripts/sql-lint.js a.sql ...  # lint specific files
//
// libpg-query is an OPTIONAL dependency: if it is not installed, this script
// says so and exits 0, so a machine without it is not blocked.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

let lib;
try {
  lib = require('libpg-query');
} catch (e) {
  console.log('sql-lint: libpg-query is not installed - skipping (npm i libpg-query to enable).');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');

function sqlFiles() {
  const args = process.argv.slice(2);
  if (args.length) return args.map((a) => path.resolve(a));
  return fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(ROOT, f));
}

// Split into statements, honouring single-quoted strings and dollar quotes, then
// keep the ones whose body is plpgsql: DO blocks, functions and procedures.
//
// The whole STATEMENT is handed to the parser, not just the body, so the real
// signature is in scope. Wrapping a body in a synthetic `RETURNS void` function
// instead reports "RETURN cannot have a parameter in function returning void"
// for every function that legitimately returns json - which is what spend_coins
// and earn_coins do.
function splitStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {                       // string literal, '' is an escaped quote
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } break; }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { // line comment
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') { // block comment
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === '$') {                       // dollar quote: $$ or $tag$
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close === -1 ? sql.length : close + m[0].length;
        continue;
      }
    }
    if (ch === ';') {
      out.push({ text: sql.slice(start, i + 1), at: start });
      i++;
      start = i;
      continue;
    }
    i++;
  }
  if (sql.slice(start).trim()) out.push({ text: sql.slice(start), at: start });
  return out;
}

const PLPGSQL_STMT = /^\s*(do|create\s+(or\s+replace\s+)?(function|procedure))\b/i;

function plpgsqlStatements(sql) {
  return splitStatements(sql)
    .filter((st) => st.text.includes('$') && PLPGSQL_STMT.test(st.text));
}

const lineOf = (sql, at) => sql.slice(0, at).split('\n').length;

function fmtErr(sql, e, at) {
  const where = e && (e.lineNumber || (at != null ? lineOf(sql, at) : null));
  const near = e && e.cursorPosition != null
    ? '\n    ' + String(sql.split('\n')[(where || 1) - 1] || '').trim().slice(0, 110)
    : '';
  return `line ${where || '?'}: ${(e && (e.message || String(e))) || 'parse error'}${near}`;
}

// Lint a SQL string: returns a list of human-readable problems (empty = clean).
async function lintSql(sql) {
  const problems = [];

  try {
    await lib.parse(sql);
  } catch (e) {
    problems.push('SQL ' + fmtErr(sql, e, null));
  }

  for (const st of plpgsqlStatements(sql)) {
    try {
      await lib.parsePlPgSQL(st.text);
    } catch (e) {
      problems.push('plpgsql ' + fmtErr(sql, e, st.at));
    }
  }

  return problems;
}

async function lintFile(file) {
  const problems = await lintSql(fs.readFileSync(file, 'utf8'));
  return problems;
}

module.exports = { lintSql, lintFile, splitStatements, plpgsqlStatements };

if (require.main !== module) return;

(async () => {
  const files = sqlFiles();
  let bad = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) { console.log(`FAIL ${f} (missing)`); bad++; continue; }
    const problems = await lintFile(f);
    const name = path.relative(ROOT, f) || path.basename(f);
    if (problems.length) {
      bad++;
      console.log(`FAIL ${name}`);
      for (const p of problems) console.log('   ' + p);
    } else {
      console.log(`ok   ${name}`);
    }
  }
  if (bad) {
    console.log(`\n${bad} of ${files.length} SQL file(s) failed to parse.`);
    process.exit(1);
  }
  console.log(`\n${files.length} SQL file(s) parse cleanly against the Postgres grammar.`);
})();
