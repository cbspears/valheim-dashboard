// The war-room's saga slot, on the site side (components/boss/tellings.ts).
//
// Two things are worth pinning here, because both are load-bearing and neither
// is visible to tsc:
//   • WHICH telling the page shows, including the two fallbacks that keep a
//     saga on the page when the database is between states;
//   • that a telling is split into paragraphs the same way whatever line
//     endings a Discord client sent.
//
//   npx tsx scripts/tellings-site.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  byline,
  otherTellings,
  pickTelling,
  splitParagraphs,
} from '../components/boss/tellings.ts';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const telling = (over = {}) => ({
  id: 't1',
  boss_id: 'b3',
  author_character: 'Bren',
  text: 'It fell.',
  source: 'player',
  chosen: false,
  created_at: '2026-09-06T10:00:00Z',
  ...over,
});

// ── which telling the page shows ──────────────────────────────────────────
{
  eq(pickTelling([]), null, 'no tellings shows nothing, and the page falls back to bosses.retelling');
  eq(pickTelling(null), null, 'and a missing list is not a crash');

  const skald = telling({ id: 's1', source: 'skald', author_character: 'The Skald', chosen: true });
  const mine = telling({ id: 'p1', chosen: false, created_at: '2026-09-06T11:00:00Z' });
  eq(pickTelling([mine, skald]).id, 's1', 'the CHOSEN telling wins, even when it is older');

  // The window the partial unique index creates: choosing is two statements, so
  // a boss can briefly have rows and no chosen one. The newest keeps the page
  // whole through it. Rows arrive newest first.
  eq(pickTelling([mine, telling({ id: 'old', created_at: '2026-09-01T10:00:00Z' })]).id, 'p1',
    'with nothing chosen, the newest telling stands in');

  // The chosen row is found wherever it sits in the window, not only at the
  // front. getBossTellings sorts it to the front, and this must not quietly
  // start depending on that.
  const older = Array.from({ length: 5 }, (_, i) =>
    telling({ id: `n${i}`, created_at: `2026-09-0${i + 1}T10:00:00Z` }));
  eq(pickTelling([...older, telling({ id: 'kept', chosen: true })]).id, 'kept',
    'the chosen telling wins from anywhere in the list');

  const shown = pickTelling([mine, skald]);
  assert.deepStrictEqual(otherTellings([mine, skald], shown).map((t) => t.id), ['p1'],
    'and everything else is folded underneath, in order');
  passed++;
  eq(otherTellings([mine, skald], null).length, 2, 'with nothing shown, everything is an "other"');
  eq(otherTellings(null, null).length, 0, 'and a missing list is still not a crash');
}

// ── bylines ───────────────────────────────────────────────────────────────
{
  eq(byline(telling({ source: 'skald' })), 'as told by the Skald', 'a generated telling names the Skald');
  eq(byline(telling({ source: 'player', author_character: 'Bren' })), 'as told by Bren', 'a told one names the viking');
  eq(byline(telling({ source: 'player', author_character: '  ' })), 'as told by a viking', 'a blank name still reads');
  eq(byline(telling({ source: 'player', author_character: null })), 'as told by a viking', 'and so does a missing one');
  eq(byline(null), 'as told by the Skald', 'the bosses.retelling fallback is the Skald’s');
  for (const t of [telling(), telling({ source: 'skald' }), null]) {
    ok(!/[—–]/.test(byline(t)), 'no dash in a byline, per the copy doctrine');
  }
}

// ── the paragraph splitter ────────────────────────────────────────────────
{
  assert.deepStrictEqual(splitParagraphs('one\n\ntwo'), ['one', 'two'], 'a blank line starts a paragraph');
  passed++;
  assert.deepStrictEqual(splitParagraphs('one\r\n\r\ntwo'), ['one', 'two'], 'CRLF from a Windows client splits the same');
  passed++;
  assert.deepStrictEqual(splitParagraphs('one\n\n\n\ntwo'), ['one', 'two'], 'a run of blank lines is still one break');
  passed++;
  assert.deepStrictEqual(splitParagraphs('one\n\n  \n\ntwo'), ['one', 'two'], 'a whitespace-only line is a break, not a paragraph');
  passed++;
  assert.deepStrictEqual(splitParagraphs('  one line  '), ['one line'], 'a single paragraph is trimmed');
  passed++;
  assert.deepStrictEqual(splitParagraphs('one\ntwo'), ['one\ntwo'], 'a single newline stays inside its paragraph');
  passed++;
  assert.deepStrictEqual(splitParagraphs(''), [], 'empty text is no paragraphs');
  passed++;
  assert.deepStrictEqual(splitParagraphs('   \n\n  '), [], 'and neither is whitespace');
  passed++;
  assert.deepStrictEqual(splitParagraphs(null), [], 'a null retelling renders nothing, rather than throwing');
  passed++;
  assert.deepStrictEqual(splitParagraphs(undefined), [], 'and so does a missing one');
  passed++;

  // The text is player-typed and rendered as TEXT NODES. The splitter must not
  // interpret it, and the component must not either.
  const hostile = '<script>alert(1)</script>\n\n**not bold** [x](https://evil.example)';
  assert.deepStrictEqual(splitParagraphs(hostile), [
    '<script>alert(1)</script>',
    '**not bold** [x](https://evil.example)',
  ], 'markup and markdown pass through untouched, to be escaped by React');
  passed++;
}

// ── the render itself never opts out of escaping ──────────────────────────
{
  const src = readFileSync(new URL('../components/boss/BossTellings.tsx', import.meta.url), 'utf8');
  // The `=` matters: the component's own comment says the word out loud, and a
  // check that a FILE never mentions an escape hatch is not the same check as
  // one that it never uses it.
  ok(!/dangerouslySetInnerHTML\s*=/.test(src), 'the war-room never injects a telling as HTML');
  ok(/splitParagraphs\(/.test(src), 'it renders paragraphs rather than one welded block');
  ok(/fallback/.test(src), 'and it still takes the bosses.retelling fallback');

  // The fallback path is what makes this deployable ahead of the migration.
  const data = readFileSync(new URL('../lib/data.ts', import.meta.url), 'utf8');
  ok(/if \(error\) return \[\];/.test(data), 'getBossTellings answers a missing table with an empty list');
  ok(/BOSS_TELLINGS_PUBLIC_COLS/.test(data), 'and reads a named column list');
  const cols = /const BOSS_TELLINGS_PUBLIC_COLS =\s*'([^']*)'/.exec(data);
  ok(cols, 'the column list is a literal this test can read');
  ok(!/author_discord_id/.test(cols[1]),
    'which never asks for author_discord_id, because anon has no grant on it');
  for (const needed of ['id', 'boss_id', 'author_character', 'text', 'source', 'chosen', 'created_at']) {
    ok(cols[1].includes(needed), `and does ask for ${needed}, which BossTelling declares`);
  }

  // CHOSEN FIRST, then newest, then bounded. The order of those three is what
  // keeps the bound honest: sorting by date alone would let a deliberately kept
  // telling age out past twenty newer ones, and the page would go back to
  // showing the newest, silently undoing `@Eilif keep <Boss> <n>`.
  const query = data.slice(data.indexOf('export const getBossTellings'));
  const body = query.slice(0, query.indexOf('});') + 3);
  ok(/\.order\('chosen', \{ ascending: false \}\)/.test(body),
    'getBossTellings sorts the chosen telling to the front');
  ok(body.indexOf("order('chosen'") < body.indexOf("order('created_at'"),
    'ahead of the date sort, or the bound could still drop it');
  ok(/\.limit\(20\)/.test(body), 'and still bounds the window at twenty');

  // TWO MIGRATIONS, ONE READ, AND THE FALLBACK IS THE LOAD-BEARING HALF.
  //
  // `standing` belongs to db/2026-09-06_telling_votes.sql, which is UNAPPLIED:
  // production answers a select naming it with 42703. Worse than a missing
  // column, boss_tellings has had its blanket SELECT grant revoked to hide
  // author_discord_id, and Postgres does not extend a column grant to a column
  // added later, so naming `standing` unconditionally would cost the war room
  // EVERY telling rather than one heading. Deleting the second read is
  // invisible to tsc, invisible to a build against a database that HAS the
  // column, and fatal against the one that does not, which is the database the
  // site is deployed against today. So it is pinned here.
  ok(/BOSS_TELLINGS_PUBLIC_COLS_V2/.test(data), 'getBossTellings names a second, wider column list');
  const colsV2 = /const BOSS_TELLINGS_PUBLIC_COLS_V2 = `\$\{BOSS_TELLINGS_PUBLIC_COLS\}, standing`/.test(data);
  ok(colsV2, 'which is the first list plus standing, rather than a second hand-typed copy of it');
  ok(/const withStanding = await read\(BOSS_TELLINGS_PUBLIC_COLS_V2\);/.test(body),
    'it asks for standing first');
  ok(/if \(!withStanding\.error\) return/.test(body),
    'and only keeps that answer when the read did not fail');
  const afterGuard = body.slice(body.indexOf('if (!withStanding.error) return'));
  ok(/await read\(BOSS_TELLINGS_PUBLIC_COLS\)/.test(afterGuard),
    'a failed read asks AGAIN without the column, which is what keeps the war room whole before the migration');
  ok(afterGuard.indexOf('if (error) return [];') > 0,
    'and only an empty list when even that fails');

  // The page must not have kept its own copy of the old render.
  const page = readFileSync(new URL('../app/boss/[slug]/page.tsx', import.meta.url), 'utf8');
  ok(/<BossTellings/.test(page), 'the war-room renders the tellings component');
  ok(!/The Skald&apos;s Retelling|The Skald's Retelling/.test(page),
    'and no longer carries a second, frozen copy of the saga card');
}

console.log(`tellings-site.test: ${passed} assertions passed`);
