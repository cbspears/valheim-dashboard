// The Storyteller's work, on the site side (lib/tales.ts, lib/episodes.ts, and
// the two reads and three components that render them).
//
// Four things are load-bearing here and none of them is visible to tsc:
//   • a tale lands on the RIGHT NIGHT, including a night that crosses UTC
//     midnight, which is the whole reason `told_for` is a Central calendar day
//     and not a timestamp;
//   • the filter merges two kinds of writing into one column in one order;
//   • player-written text is rendered as PLAIN PARAGRAPHS and never as markup;
//   • both reads survive a database where db/2026-09-06_tales.sql has not run.
//
//   npx tsx scripts/tales-site.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  daysAgoCtKey,
  splitTaleParagraphs,
  taleByline,
  taleDayLabel,
  talesByDay,
  storytellerWork,
} from '../lib/tales.ts';
import { buildEpisodes } from '../lib/episodes.ts';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const tale = (over = {}) => ({
  id: 't1',
  title: 'The Longship Race',
  text: 'Two boats went out. One came back.',
  author_character: 'Bren',
  told_for: '2026-09-05',
  created_at: '2026-09-06T02:00:00Z',
  ...over,
});

const telling = (over = {}) => ({
  id: 'b1',
  boss_id: 'boss-bonemass',
  author_character: 'Ivar',
  text: 'We lost the shieldwall twice.',
  source: 'player',
  chosen: false,
  created_at: '2026-09-04T20:00:00Z',
  ...over,
});

// ── the day label ─────────────────────────────────────────────────────────
{
  eq(taleDayLabel('2026-09-12'), 'Sat, Sep 12, 2026', 'a day key renders as a day');
  eq(taleDayLabel('2026-09-12', false), 'Sat, Sep 12', 'and without its year when the card already dates itself');

  // THE OFF-BY-ONE THIS EXISTS TO PREVENT. `new Date('2026-09-12')` is UTC
  // midnight, and rendering THAT instant in America/Chicago says September 11:
  // a tale about Saturday night would be labelled Friday on the one surface
  // whose whole job is to say which night it was.
  const naive = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date('2026-09-12'));
  ok(/Sep 11/.test(naive), 'the naive route really does slip a day (this is the bug being guarded)');
  ok(/Sep 12/.test(taleDayLabel('2026-09-12')), 'and the label does not');

  eq(taleDayLabel('2026-01-01'), 'Thu, Jan 1, 2026', 'the turn of the year is right');
  eq(taleDayLabel('2024-02-29'), 'Thu, Feb 29, 2024', 'and a leap day is a real day');
  eq(taleDayLabel(null), 'an unknown night', 'a missing key is not a crash');
  eq(taleDayLabel('nonsense'), 'an unknown night', 'and neither is a broken one');
  eq(taleDayLabel('2026-13-01'), 'an unknown night', 'nor a month that does not exist');

  // The window key the Saga hands getTales. A day key changes once a day, which
  // is what makes it a usable cache key.
  const now = Date.parse('2026-09-06T11:01:00Z'); // 06:01 CT
  eq(daysAgoCtKey(0, now), '2026-09-06', 'zero days back is today, in Central');
  eq(daysAgoCtKey(1, now), '2026-09-05', 'one day back is yesterday');
  eq(daysAgoCtKey(70, now), '2026-06-28', 'and seventy is seventy');
  eq(daysAgoCtKey(70, now), daysAgoCtKey(70, now + 60_000),
    'and a minute later it is the same key, which is the point');
}

// ── paragraphs, and the byline ────────────────────────────────────────────
{
  assert.deepStrictEqual(splitTaleParagraphs('one\n\ntwo'), ['one', 'two'], 'a blank line splits');
  passed++;
  assert.deepStrictEqual(splitTaleParagraphs('one\r\n\r\ntwo'), ['one', 'two'],
    'whatever line endings the Discord client sent');
  passed++;
  assert.deepStrictEqual(splitTaleParagraphs('one\ntwo'), ['one\ntwo'],
    'a single break is a line inside one paragraph, not a new one');
  passed++;
  assert.deepStrictEqual(splitTaleParagraphs('  \n\n  one  \n\n  '), ['one'],
    'empty paragraphs are dropped and the rest is trimmed');
  passed++;
  assert.deepStrictEqual(splitTaleParagraphs(null), [], 'a missing tale is no paragraphs');
  passed++;

  // Markdown and markup are STORED raw and rendered as text nodes, so they come
  // through here untouched. React is what makes that safe, and the component
  // tests below are what pin it.
  assert.deepStrictEqual(splitTaleParagraphs('**bold** <script>x</script>'),
    ['**bold** <script>x</script>'], 'markup is carried through as words');
  passed++;

  eq(taleByline('Bren'), 'Bren', 'a tale reads under its author');
  eq(taleByline('  '), 'the Storyteller', 'and a nameless one under the office');
  eq(taleByline(null), 'the Storyteller', 'as does a missing one');
}

// ── attaching a tale to its night ─────────────────────────────────────────
{
  const grouped = talesByDay([
    tale({ id: 'a', told_for: '2026-09-05', created_at: '2026-09-06T02:00:00Z' }),
    tale({ id: 'b', told_for: '2026-09-05', created_at: '2026-09-05T23:00:00Z' }),
    tale({ id: 'c', told_for: '2026-09-01' }),
  ]);
  eq(grouped.size, 2, 'two nights carry tales');
  assert.deepStrictEqual(grouped.get('2026-09-05').map((t) => t.id), ['b', 'a'],
    'and a night reads oldest first, because two tales of one night are a sequence');
  passed++;
  eq(talesByDay([tale({ told_for: 'nonsense' })]).size, 0, 'a broken day key is dropped, not crashed on');
  eq(talesByDay(null).size, 0, 'and a missing list is not a crash');

  // A PostgREST `date` comes back as '2026-09-05'; a caller that built one from
  // a timestamp would hand '2026-09-05T00:00:00'. Both are the same night.
  eq(talesByDay([tale({ told_for: '2026-09-05T00:00:00' })]).size, 1,
    'a timestamp-shaped day still finds its night');
}

// ── the episode carries the tales of ITS night ────────────────────────────
{
  // THE NIGHT THAT CROSSES UTC MIDNIGHT, which is why told_for is a Central
  // calendar day. This session runs 20:00 to 23:30 CT on Saturday 2026-09-05,
  // which is 2026-09-06T01:00Z to 04:30Z: a UTC reading would file it on the
  // 6th, and the tale about it would land on the wrong card or on none.
  const sessions = [{
    character_name: 'Bren',
    joined_at: '2026-09-06T01:00:00Z',
    left_at: '2026-09-06T04:30:00Z',
    duration_minutes: 210,
  }];
  const eps = buildEpisodes(sessions, [], [], [], [
    tale({ id: 'a', told_for: '2026-09-05', title: 'The Long Dark' }),
    tale({ id: 'b', told_for: '2026-09-06', title: 'The Wrong Night' }),
  ]);
  eq(eps.length, 1, 'one night of play is one episode');
  eq(eps[0].tales.length, 1, 'and it carries the tale told ABOUT it');
  eq(eps[0].tales[0].title, 'The Long Dark', 'which is the Central-time night, not the UTC one');
  eq(eps[0].tales[0].by, 'Bren', 'with its byline');
  ok(eps[0].tales[0].text.includes('Two boats'), 'and its words');

  // Two tales of one night, oldest first.
  const two = buildEpisodes(sessions, [], [], [], [
    tale({ id: 'a', told_for: '2026-09-05', title: 'Second', created_at: '2026-09-06T09:00:00Z' }),
    tale({ id: 'b', told_for: '2026-09-05', title: 'First', created_at: '2026-09-06T08:00:00Z' }),
  ]);
  assert.deepStrictEqual(two[0].tales.map((t) => t.title), ['First', 'Second'],
    'two tales of one night read in the order they were written');
  passed++;

  // A tale with no words, or no name, is not a tale.
  const junk = buildEpisodes(sessions, [], [], [], [
    tale({ id: 'a', told_for: '2026-09-05', title: '   ' }),
    tale({ id: 'b', told_for: '2026-09-05', text: '  ' }),
  ]);
  eq(junk[0].tales.length, 0, 'a nameless or wordless tale never reaches a card');

  // BACKWARD COMPATIBLE. Every existing caller passes four arguments or fewer.
  const old = buildEpisodes(sessions, [], [], []);
  eq(old.length, 1, 'the old four-argument call still builds episodes');
  assert.deepStrictEqual(old[0].tales, [], 'and every episode carries an empty list rather than undefined');
  passed++;

  // A TALE DOES NOT OPEN AN EPISODE. A night nobody played has no card, so its
  // tale is only reachable from the Storyteller's own view. Pinned here because
  // it is a deliberate limit and not an oversight.
  const orphan = buildEpisodes(sessions, [], [], [], [tale({ told_for: '2026-08-01' })]);
  eq(orphan.length, 1, 'a tale about a night with no sessions opens no episode');
  eq(orphan[0].tales.length, 0, 'and does not attach itself to a different one');
}

// ── the filter: one column, newest first ──────────────────────────────────
{
  const bosses = [
    { id: 'boss-bonemass', name: 'Bonemass' },
    { id: 'boss-elder', name: 'The Elder' },
  ];
  const entries = storytellerWork(
    [
      tale({ id: 'tale-old', created_at: '2026-09-01T10:00:00Z' }),
      tale({ id: 'tale-new', created_at: '2026-09-07T10:00:00Z' }),
    ],
    [
      telling({ id: 'tell-mid', created_at: '2026-09-05T10:00:00Z', chosen: true }),
      telling({ id: 'tell-old', boss_id: 'boss-elder', created_at: '2026-09-02T10:00:00Z' }),
    ],
    bosses,
  );
  assert.deepStrictEqual(
    entries.map((e) => e.id),
    ['tale-new', 'tell-mid', 'tell-old', 'tale-old'],
    'the two kinds interleave, newest written first',
  );
  passed++;
  eq(entries[0].kind, 'tale', 'a tale knows it is a tale');
  eq(entries[1].kind, 'telling', 'and a telling knows it is a telling');
  eq(entries[1].boss, 'Bonemass', 'a telling resolves its boss name for the war-room link');
  eq(entries[2].boss, 'The Elder', 'each from its own row');
  eq(entries[1].kept, true, 'and says when it is the one the war room shows');
  eq(entries[2].kept, false, 'and when it is not');
  eq(entries[0].day, '2026-09-05', 'a tale carries the night it is about');
  eq(entries[0].by, 'Bren', 'and both carry a byline');
  eq(entries[1].by, 'Ivar', 'from their own author');

  // A boss the roster does not know leaves the card unlinked rather than
  // sending a reader to a 404.
  const unknown = storytellerWork([], [telling({ boss_id: 'boss-nobody' })], bosses);
  eq(unknown[0].boss, null, 'an unknown boss id links to nothing');

  // THE SKALD IS NOT A VIKING. getPlayerTellings filters in the database; this
  // is the second lock, so loosening that filter cannot quietly fill this view
  // with machine text.
  const withSkald = storytellerWork([], [telling({ id: 's1', source: 'skald' }), telling({ id: 'p1' })], bosses);
  assert.deepStrictEqual(withSkald.map((e) => e.id), ['p1'], 'a Skald telling never reaches this view');
  passed++;

  eq(storytellerWork([], [], []).length, 0, 'nothing written is an empty view, not a crash');
  eq(storytellerWork(null, null, null).length, 0, 'and neither are missing lists');

  // Two rows written in the same instant still order the same way every build,
  // or the ISR render would flicker between two orders for no reason.
  const tied = storytellerWork(
    [tale({ id: 'aaa', created_at: '2026-09-05T10:00:00Z' })],
    [telling({ id: 'zzz', created_at: '2026-09-05T10:00:00Z' })],
    bosses,
  );
  assert.deepStrictEqual(tied.map((e) => e.id), ['zzz', 'aaa'], 'a tie breaks on id, stably');
  passed++;
}

// ── TWO STATIC ROUTES, NOT A `?by=` ON ONE ────────────────────────────────
//
// The filter shipped first as /events?by=storyteller, and `searchParams` is a
// request-time API: reading it moved /events from `○ (Static)` with a 1m
// revalidate to `ƒ (Dynamic)`, dropped it out of the prerender manifest and put
// all six of its Supabase reads on every request (measured on a scratch build,
// 2026-09-06). This is the guard on that regression coming back.
{
  // Both pages EXPLAIN this in a comment, so grade the code and not the prose,
  // the way section "the page and the three components" below does.
  const code = (p) =>
    src(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const saga = code('app/events/page.tsx');
  ok(!/searchParams/.test(saga),
    '/events reads no searchParams, which is what keeps its build-time prerender');
  ok(/export default async function EventsPage\(\)/.test(saga), 'so its component takes no props');

  const view = code('app/events/storyteller/page.tsx');
  ok(/export const revalidate = 60;/.test(view), 'the filtered view is its own ISR route');
  ok(!/searchParams/.test(view), 'and reads no searchParams either');

  const toggle = src('components/events/StorytellerToggle.tsx');
  ok(/href="\/events"/.test(toggle), 'the toggle points at the Saga');
  ok(/href="\/events\/storyteller"/.test(toggle), 'and at the filtered route');
  ok(!/\?by=/.test(toggle.replace(/\/\*[\s\S]*?\*\//g, ' ')),
    'and nothing links to the old query-string address');
}

// ── the two reads ─────────────────────────────────────────────────────────
{
  const data = src('lib/data.ts');

  // getTales must never select author_discord_id: the column is REVOKEd from
  // anon, so `select('*')` would fail outright with "permission denied".
  const cols = /const TALES_PUBLIC_COLS = '([^']+)'/.exec(data);
  ok(cols, 'lib/data.ts names the columns getTales reads');
  ok(!cols[1].includes('author_discord_id'), 'and author_discord_id is not one of them');
  for (const c of ['id', 'title', 'text', 'author_character', 'told_for', 'created_at']) {
    ok(cols[1].includes(c), `it reads ${c}, which the site renders`);
  }

  // ...and the migration grants exactly that list to anon, so the two agree.
  const migration = src('db/2026-09-06_tales.sql');
  const grant = /grant select \(\s*([^)]+)\) on public\.tales to anon/.exec(migration);
  ok(grant, 'the migration grants a column list to anon');
  const granted = grant[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepStrictEqual(
    granted,
    cols[1].split(',').map((s) => s.trim()).sort(),
    'and it is the same list the site asks for',
  );
  passed++;
  ok(/revoke select on public\.tales from anon/.test(migration),
    'with the blanket table grant revoked first, or the column grants do nothing');
  ok(!granted.includes('author_discord_id'), 'and the Discord id is not in it');

  const talesRead = data.slice(data.indexOf('const readTales = cache('), data.indexOf('export async function getTales'));
  ok(/if \(error\) return \[\];/.test(talesRead),
    'a failed read returns an empty list, so a Saga renders without its tales rather than not at all');
  ok(/gte\('told_for', sinceDay\)/.test(talesRead), 'the window is a day compared against a day');
  ok(/\.limit\(limit\)/.test(talesRead), 'and the read is bounded');
  ok(/PGRST205/.test(data) && /42P01/.test(data),
    'lib/data.ts still explains which errors a missing table answers with');

  // The object-shaped signature must not be the cached one: React cache() keys
  // on argument identity, so a fresh object every call would never dedupe.
  ok(/export async function getTales\(\{/.test(data), 'getTales takes an options object');
  ok(/return readTales\(sinceDay \?\? '', limit\);/.test(data),
    'and hands scalars to the cached read, which is the only reason it dedupes');

  const playerTellings = data.slice(
    data.indexOf('export const getPlayerTellings = cache('),
    data.indexOf('const TALES_PUBLIC_COLS'),
  );
  ok(playerTellings.length > 100, 'getPlayerTellings is where this test thinks it is');
  ok(/\.eq\('source', 'player'\)/.test(playerTellings),
    'it asks the DATABASE for viking tellings, rather than filtering the Skald out afterwards');
  ok(/\.limit\(limit\)/.test(playerTellings), 'and it is bounded');
  ok(/if \(error\) return \[\];/.test(playerTellings), 'and tolerates the table not existing');
  ok(/BOSS_TELLINGS_PUBLIC_COLS_V2/.test(playerTellings) && /BOSS_TELLINGS_PUBLIC_COLS\)/.test(playerTellings),
    'reusing the same two column lists, so a war room and this view can never disagree about what is public');
}

// ── the page and the three components ─────────────────────────────────────
{
  const page = src('app/events/page.tsx');
  const view = src('app/events/storyteller/page.tsx');
  ok(/export const revalidate = 60;/.test(page), 'the Saga keeps its sixty seconds');
  ok(/<StorytellerToggle active="all"/.test(page) && /<StorytellerToggle active="storyteller"/.test(view),
    'both views carry the toggle, so neither is a dead end');
  ok(/buildEpisodes\(sessions, sagaEvents, oaths, pins, tales\)/.test(page),
    'the episode builder is handed the tales');
  ok(/getTales\(\{ sinceDay: daysAgoCtKey\(WINDOW_DAYS\)/.test(page),
    'over the same window as the sessions beside them');
  ok(/getTales\(\{ limit: 200 \}\)/.test(view),
    'while the Storyteller view reads them all, because it is the record of everything written');
  ok(/getPlayerTellings\(60\)/.test(view), 'alongside the vikings own tellings');
  ok(!/getPlayerTellings/.test(page), 'which the Saga itself never pays for');

  const list = src('components/events/EpisodeList.tsx');
  ok(/<EpisodeTales tales=\{ep\.tales\} \/>/.test(list), 'the episode card renders its tales');

  const tales = src('components/events/EpisodeTales.tsx');
  ok(/As the Storyteller tells it/.test(tales), 'under the heading the design asks for');
  ok(/splitTaleParagraphs\(t\.text\)/.test(tales), 'as paragraphs');

  // A SINGLE LINE BREAK IS THE WRITER'S. splitTaleParagraphs breaks on BLANK
  // lines and the bot deliberately keeps single ones, so without this class the
  // browser collapses a three-line recap into one run-on sentence.
  ok(/whitespace-pre-line/.test(tales), 'and the breaks inside a paragraph survive');

  const work = src('components/events/StorytellerWork.tsx');
  ok(/whitespace-pre-line/.test(work), 'the filtered view keeps them too');
  ok(/No tale has been written yet\./.test(work), 'the empty state is the one in the doctrine voice');
  ok(/quill is dry/.test(work), 'quill and all');
  ok(/bossPath\(e\.boss\)/.test(work), 'a telling links to its war room');

  // Comments are for the next engineer and are exempt from both sweeps below,
  // exactly as scripts/commands-page.test.mjs section 4 has it. Which also
  // means the comments in those files may NAME the thing they promise not to
  // do, and this test still grades the code.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  // PLAYER TEXT IS NEVER MARKUP. This is the assertion that matters most on
  // this page: everything rendered here was typed into Discord by a person.
  for (const f of [
    'components/events/EpisodeTales.tsx',
    'components/events/StorytellerWork.tsx',
    'components/events/EpisodeList.tsx',
    'components/events/StorytellerToggle.tsx',
    'app/events/page.tsx',
    'app/events/storyteller/page.tsx',
  ]) {
    ok(!/dangerouslySetInnerHTML/.test(stripComments(src(f))), `${f} never sets raw HTML`);
  }

  // Copy doctrine (CLAUDE.md): no em dashes, no en dashes, no exclamation
  // marks in anything a reader reads.
  let strings = 0;
  for (const f of [
    'components/events/EpisodeTales.tsx',
    'components/events/StorytellerWork.tsx',
    'components/events/StorytellerToggle.tsx',
    'app/events/page.tsx',
    'app/events/storyteller/page.tsx',
  ]) {
    const body = stripComments(src(f));
    const nodes = [...body.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((m) => m[1]);
    const props = [...body.matchAll(/(?:title|subtitle|label|message|aria-label)=["']([^"']+)["']/g)].map((m) => m[1]);
    for (const s of [...nodes, ...props]) {
      ok(!s.includes('—'), `no em dash in ${f}: ${JSON.stringify(s.slice(0, 60))}`);
      ok(!s.includes('–'), `no en dash in ${f}: ${JSON.stringify(s.slice(0, 60))}`);
      ok(!s.includes('!'), `no exclamation mark in ${f}: ${JSON.stringify(s.slice(0, 60))}`);
      strings++;
    }
  }
  ok(strings > 10, `the copy was really scanned (${strings} strings)`);
}

console.log(`tales-site.test: ${passed} assertions passed`);
