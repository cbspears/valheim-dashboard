// Unit tests for the identity-mismatch release statement.
// Run: npx tsx lib/ops/release-sql.test.mjs
import assert from 'node:assert';
import { sqlQuote, releaseBindingSql } from './release-sql.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); passed++; };

// ── sqlQuote ──────────────────────────────────────────────────────────────
{
  eq(sqlQuote('Eilif'), "'Eilif'", 'a plain name is just quoted');
  eq(sqlQuote("Sig'run"), "'Sig''run'", "an apostrophe is doubled, not left to break the statement");
  eq(sqlQuote("O''Ranger"), "'O''''Ranger'", 'already-doubled quotes are doubled again (no double-unescape)');
  eq(sqlQuote(''), "''", 'an empty name is an empty literal, not a syntax error');
  eq(sqlQuote('Bjørn Járnsíða'), "'Bjørn Járnsíða'", 'non-ASCII passes through untouched');
  eq(sqlQuote('100% Mead'), "'100% Mead'", 'percent is not a SQL metacharacter here and is left alone');
  eq(sqlQuote('a\nb'), "'a\nb'", 'a newline stays inside the literal');

  // The point of the exercise: a name crafted to close the literal and append a
  // statement must come out as ONE inert string.
  const hostile = "x'; drop table players; --";
  const quoted = sqlQuote(hostile);
  eq(quoted, "'x''; drop table players; --'", 'a crafted name is neutralised into a single literal');
  // Every quote in the output is either the opening one, the closing one, or
  // part of a doubled pair — i.e. the literal never closes early.
  const inner = quoted.slice(1, -1);
  ok(inner.split("'").length % 2 === 1 && !/(^|[^'])'([^']|$)/.test(inner),
    'no lone quote survives inside the literal, so it cannot terminate early');
}

// ── releaseBindingSql ─────────────────────────────────────────────────────
{
  eq(
    releaseBindingSql(['Loa']),
    "update players set steam_id = null where character_name = 'Loa';",
    'one name gives one statement',
  );

  // The finding this module exists for: two mismatched vikings must both be
  // released, or an admin runs the block, sees the page go quiet for one, and
  // leaves the other frozen without knowing it.
  const two = releaseBindingSql(['Loa', 'Bjorn']);
  eq(two.split('\n').length, 2, 'two distinct names give two statements');
  ok(two.includes("character_name = 'Loa';") && two.includes("character_name = 'Bjorn';"),
    'and both names appear');

  const repeated = releaseBindingSql(['Loa', 'Bjorn', 'Loa', 'Loa']);
  eq(repeated.split('\n').length, 2, 'repeat rows for the same viking collapse to one statement');
  eq(repeated, two, 'and the order is first-seen, matching the newest-first table');

  eq(releaseBindingSql([]), '', 'no rows gives no statements (the page renders its empty state instead)');

  ok(releaseBindingSql(["Sig'run"]).includes("'Sig''run'"),
    'the escaping is applied through the list builder, not only when called directly');
}

console.log(`release-sql.test: ${passed} assertions passed`);
