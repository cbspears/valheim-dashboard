// Unit tests for the Storyteller's tales (src/tales.js). No network, no Discord.
//
// Covers, in order:
//   1. the verb parser, in every form it accepts and the ones it must refuse
//   2. the day: today, yesterday, last night either side of 06:00 CT, an ISO
//      day, a named month, a future day, and a day that does not exist
//   3. the storage cleaners: control characters, caps read out of the migration,
//      paragraphs, surrogates
//   4. who may write one, and who may withdraw or rewrite one
//   5. the handler end to end against a stub database, including the office
//   6. the rate limit
//   7. the voice pool against the copy doctrine
//   8. the reply copy and the source itself against the same doctrine
//
// Run: node scripts/tales.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  LAST_NIGHT_HOUR,
  MAX_TALE_TEXT_CHARS,
  MAX_TALE_TITLE_CHARS,
  TALES_LIMIT,
  TALE_COOLDOWN_MS,
  TALE_VOICE_LINES,
  VOICE_NAME_CHARS,
  VOICE_TITLE_CHARS,
  addTale,
  cleanTaleText,
  cleanTaleTitle,
  createTales,
  ctDayKey,
  ctHour,
  dayLabel,
  deleteTale,
  firstName,
  isJarl,
  isRealDay,
  listTales,
  matchDayPrefix,
  mayEditTale,
  mayWriteTale,
  parseTales,
  renderTaleList,
  resolveTaleDay,
  rewriteTale,
  shiftDay,
  speakableTitle,
  taleAuthor,
  taleVoiceLine,
} from '../src/tales.js';
import { clampEmbed } from '../src/discord.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const silentLog = { info() {}, warn() {}, error() {} };
const BOT = 'BOT1';

// Two fixed instants, chosen so the whole "last night" rule is exercised on the
// same Central day. 2026-09-06 is a Sunday and Central is on CDT (UTC-5), so
// 10:59Z is 05:59 CT and 11:01Z is 06:01 CT.
const AT_0559_CT = Date.parse('2026-09-06T10:59:00Z');
const AT_0601_CT = Date.parse('2026-09-06T11:01:00Z');

// ── 1. The verb parser ────────────────────────────────────────────────────
{
  const p = (s) => parseTales(s, BOT);

  const a = p('<@BOT1> tale The Longship Race: we lost two boats and a barrel');
  eq(a?.verb, 'write', 'a tale is a write');
  eq(a.title, 'The Longship Race', 'the title is read off the front');
  eq(a.text, 'we lost two boats and a barrel', 'and the tale off the back');
  eq(a.dayText, null, 'with no day named, which means today');

  eq(p('<@!BOT1> tale A Night: x').title, 'A Night', 'a nickname mention is stripped too');
  eq(p('<@BOT1> TALE a night: x').title, 'a night', 'the verb is case insensitive');
  eq(p('<@BOT1>, tale A Night: x').title, 'A Night', 'leading punctuation is forgiven');
  eq(p('tale A Night: x <@BOT1>').title, 'A Night', 'the mention may come last');

  const nl = p('<@BOT1> tale The Long Dark:\nThe mist came in fast.\n\nThen it broke.');
  eq(nl.title, 'The Long Dark', 'a newline may stand in for the space after the colon');
  eq(nl.text, 'The mist came in fast.\n\nThen it broke.', 'and the paragraphs survive parsing');

  eq(p('<@BOT1> tale A Night: she said one thing: run').text, 'she said one thing: run',
    'only the FIRST colon splits');

  // every shape of `for <day>`
  eq(p('<@BOT1> tale for yesterday A Night: x').dayText, 'yesterday', 'for yesterday');
  eq(p('<@BOT1> tale for last night A Night: x').dayText, 'last night', 'for last night');
  eq(p('<@BOT1> tale for today A Night: x').dayText, 'today', 'for today');
  eq(p('<@BOT1> tale for tonight A Night: x').dayText, 'tonight', 'for tonight');
  eq(p('<@BOT1> tale for 2026-09-12 A Night: x').dayText, '2026-09-12', 'for an ISO day');
  eq(p('<@BOT1> tale for Sep 12 A Night: x').dayText, 'Sep 12', 'for a named month');
  eq(p('<@BOT1> tale for September 12, 2026 A Night: x').dayText, 'September 12 2026',
    'for a named month with a year');
  eq(p('<@BOT1> tale for 12 Sep A Night: x').dayText, '12 Sep', 'and the other way round');
  eq(p('<@BOT1> tale for LAST NIGHT A Night: x').dayText, 'LAST NIGHT', 'the day phrase is case insensitive');
  eq(p('<@BOT1> tale for yesterday A Night: x').title, 'A Night',
    'and the title still starts after the day');

  // a `for` that names no day is a REFUSAL, never a silent write to today
  const bad = p('<@BOT1> tale for the fallen: we buried them');
  eq(bad?.verb, 'write', 'a for with no day is still a recognised command');
  eq(bad.badDay, true, 'flagged so the handler can say so');
  eq(bad.title, '', 'and nothing is carried through as a title');

  // a tale with no words is still a command, so the writer is told why
  eq(p('<@BOT1> tale A Night').text, '', 'a bare title is still a write, with no text');
  eq(p('<@BOT1> tale A Night').title, 'A Night', 'and the title survives');
  eq(p('<@BOT1> tale A Night:').text, '', 'and so is a colon with nothing after it');
  eq(p('<@BOT1> tale').verb, 'write', 'a bare verb is still a write');
  eq(p('<@BOT1> tale').title, '', 'with nothing in it, so the handler answers rather than going silent');

  // A COLON PAST THE TITLE WINDOW. This used to fall through to the branch
  // above and be answered with "a tale needs a name and words", which discarded
  // a tale whose writer had supplied both halves.
  const long = p(`<@BOT1> tale ${'T'.repeat(130)}: and then we sailed`);
  eq(long.verb, 'write', 'an over-long name is still a write');
  eq(long.longTitle, true, 'flagged, so the handler can say which half is wrong');
  eq(long.text, '', 'and nothing is carried through as a tale');
  eq(p(`<@BOT1> tale ${'T'.repeat(100)}: x`).text, 'x',
    'while a merely long one still parses and is clipped with the writer watching');

  // A LINE BREAK WHERE A SPACE WOULD DO. Typing the verb and then the tale on
  // the next line is an ordinary shape for a long Discord message.
  eq(p('<@BOT1> tale\nThe Race: two boats').title, 'The Race', 'a break after the verb is fine');
  eq(p('<@BOT1> tale\nThe Race: two boats').text, 'two boats', 'and the tale still lands');
  eq(p('<@BOT1> tale for yesterday\nThe Race: x').dayText, 'yesterday',
    'a break after the day is fine too');
  eq(p('<@BOT1> tale for yesterday\nThe Race: x').title, 'The Race', 'and the title follows it');
  eq(p('<@BOT1> tale for\n2026-09-01 The Race: x').dayText, '2026-09-01',
    'and so is one after the word for');

  // the list verb, which must never parse as a write of a title called "s"
  eq(p('<@BOT1> tales').verb, 'list', '`tales` lists');
  eq(p('<@BOT1> tales please').verb, 'list', 'and forgives a trailing word');

  // untale / retale
  eq(p('<@BOT1> untale 2').verb, 'untale', '`untale` withdraws');
  eq(p('<@BOT1> untale 2').index, 2, 'and reads the number');
  eq(p('<@BOT1> untale #3').index, 3, 'a hash before the number is fine');
  eq(p('<@BOT1> untale').verb, 'untale', 'untale with no number is STILL a command');
  eq(p('<@BOT1> untale').index, null,
    'with no number, so the handler asks for one instead of answering with silence');

  const r = p('<@BOT1> retale 2: how it actually went');
  eq(r?.verb, 'retale', '`retale` rewrites');
  eq(r.index, 2, 'reads the number');
  eq(r.text, 'how it actually went', 'and the new words');
  eq(p('<@BOT1> retale 2').text, '', 'a number with no words is still a command');
  eq(p('<@BOT1> retale').verb, 'retale', 'and so is retale with no number at all');
  eq(p('<@BOT1> retale').index, null, 'which the handler answers by asking which tale');

  // and the things that must NOT be commands
  eq(p('<@BOT1> tell Bonemass: it went badly'), null, 'a boss telling belongs to tellings.js');
  eq(p('<@BOT1> retell Bonemass: x'), null, 'and so does a retell');
  eq(p('<@BOT1> tellings Bonemass'), null, 'and so does a telling list');
  eq(p('<@BOT1> keep Bonemass 2'), null, 'and so does keep');
  eq(p('<@BOT1> I am Bren'), null, 'an identity claim is not a tale');
  eq(p('<@BOT1> say: the hall is quiet'), null, 'the voice puppet is not a tale');
  eq(p('<@BOT1> what a tale that was'), null, 'an ordinary sentence is not a verb');
  eq(p('<@BOT1> taler of the hall'), null, 'and neither is a longer word that starts the same way');
  eq(p('<@BOT1>'), null, 'a bare mention is not a command');
  eq(p(''), null, 'and neither is nothing');
}

// ── 2. The day ────────────────────────────────────────────────────────────
{
  eq(ctDayKey(AT_0559_CT), '2026-09-06', 'the Central day of 05:59 CT is that day');
  eq(ctHour(AT_0559_CT), 5, 'and its Central hour is 5');
  eq(ctHour(AT_0601_CT), 6, 'while 06:01 CT is hour 6');

  // THE BOUNDARY. A tale filed in the small hours is about the night that just
  // ended; once the sun is up "last night" is read as the current day.
  eq(resolveTaleDay('last night', AT_0559_CT).day, '2026-09-05',
    'at 05:59 CT, last night is the previous Central day');
  eq(resolveTaleDay('last night', AT_0601_CT).day, '2026-09-06',
    'at 06:01 CT, last night is today');
  eq(LAST_NIGHT_HOUR, 6, 'and the hour that decides it is named, not buried');

  eq(resolveTaleDay(null, AT_0601_CT).day, '2026-09-06', 'no day named means today');
  eq(resolveTaleDay('', AT_0601_CT).day, '2026-09-06', 'and so does an empty one');
  eq(resolveTaleDay('today', AT_0559_CT).day, '2026-09-06', 'today is today at any hour');
  eq(resolveTaleDay('tonight', AT_0559_CT).day, '2026-09-06', 'and so is tonight');
  eq(resolveTaleDay('yesterday', AT_0559_CT).day, '2026-09-05', 'yesterday is the day before');
  eq(resolveTaleDay('yesterday', AT_0601_CT).day, '2026-09-05',
    'and it does not move with the clock, which is why it exists beside last night');

  eq(resolveTaleDay('2026-09-01', AT_0601_CT).day, '2026-09-01', 'an ISO day is taken as written');
  eq(resolveTaleDay('2026-9-1', AT_0601_CT).day, '2026-09-01', 'and a short one is padded');
  eq(resolveTaleDay('Sep 1', AT_0601_CT).day, '2026-09-01', 'a named month resolves');
  eq(resolveTaleDay('September 1', AT_0601_CT).day, '2026-09-01', 'spelled out too');
  eq(resolveTaleDay('1 Sep', AT_0601_CT).day, '2026-09-01', 'and the other way round');
  eq(resolveTaleDay('Sep 1st', AT_0601_CT).day, '2026-09-01', 'an ordinal suffix is forgiven');
  eq(resolveTaleDay('sep 1, 2025', AT_0601_CT).day, '2025-09-01', 'a year, when given, wins');
  // A MONTH AND A DAY WITH NO YEAR ARE THIS YEAR'S, AND NOTHING ELSE. This used
  // to roll silently back to last year, which on this server named a night in
  // 2025 that nobody played (the world was made on 2026-09-09) and filed the
  // tale outside the Saga's own seventy-day window, where only the
  // Storyteller's view would ever have shown it.
  eq(resolveTaleDay('Sep 12', AT_0601_CT).day, '2026-09-12', 'a bare month and day are this year');
  eq(resolveTaleDay('Sep 12', AT_0601_CT).status, 'future',
    'so one that has not come round yet is refused, not quietly filed a year back');
  eq(resolveTaleDay('Dec 25', AT_0601_CT).status, 'future', 'by any distance');
  eq(resolveTaleDay('September 12', AT_0601_CT).status, 'future', 'spelled out too');
  eq(resolveTaleDay('12 Sep', AT_0601_CT).status, 'future', 'and the other way round');
  eq(resolveTaleDay('Sep 12, 2025', AT_0601_CT).day, '2025-09-12',
    'while a writer who means an earlier year says so, and is taken at their word');

  // the two refusals
  eq(resolveTaleDay('2027-01-01', AT_0601_CT).status, 'future', 'a future day is refused');
  eq(resolveTaleDay('2026-09-07', AT_0601_CT).status, 'future', 'tomorrow included');
  eq(resolveTaleDay('2026-09-06', AT_0601_CT).status, 'ok', 'while today itself is fine');
  eq(resolveTaleDay('the fallen', AT_0601_CT).status, 'unreadable', 'and nonsense is unreadable');
  eq(resolveTaleDay('2026-02-31', AT_0601_CT).status, 'unreadable',
    'a day that does not exist is unreadable, not silently rolled into March');
  eq(resolveTaleDay('Feb 31', AT_0601_CT).status, 'unreadable', 'by either spelling');

  // the calendar arithmetic itself, across a month, a year and a DST change
  eq(shiftDay('2026-09-01', -1), '2026-08-31', 'a day before the first is the month before');
  eq(shiftDay('2026-01-01', -1), '2025-12-31', 'and the year before, at the turn');
  eq(shiftDay('2026-03-09', -1), '2026-03-08',
    'and the day after a spring-forward is still one day wide');
  eq(shiftDay('2026-11-02', -1), '2026-11-01', 'and so is the day after a fall-back');
  eq(shiftDay('nonsense', -1), null, 'a key that is not a key shifts to nothing');
  ok(isRealDay('2026-02-28') && !isRealDay('2026-02-29'), '2026 is not a leap year');
  ok(isRealDay('2024-02-29'), 'and 2024 is');

  // the prefix matcher, which is what keeps a mistyped date out of today
  eq(matchDayPrefix('yesterday A Night: x').spec, 'yesterday', 'a day phrase is taken off the front');
  eq(matchDayPrefix('yesterday A Night: x').rest, 'A Night: x', 'and the rest is handed back');
  eq(matchDayPrefix('the fallen: we buried them'), null, 'a word that is not a month is not a day');
  eq(matchDayPrefix('Bren and the wolves: x'), null, 'and neither is a name');
  eq(matchDayPrefix('May 5 Feast: x').spec, 'May 5', 'a month that is also a word still reads as a month');
}

// ── 3. The storage cleaners ───────────────────────────────────────────────
{
  eq(cleanTaleText('  it went badly  '), 'it went badly', 'a tale is trimmed');
  eq(cleanTaleText('one\r\ntwo'), 'one\ntwo', 'CRLF folds to a single break');
  eq(cleanTaleText('one\n\n\n\ntwo'), 'one\n\ntwo', 'runs of blank lines collapse to one');
  eq(cleanTaleText('a\nb'), 'a\nb', 'a single line break survives, because prose has lines');
  eq(cleanTaleText('spaced   out'), 'spaced out', 'runs of spaces collapse');
  eq(cleanTaleText(''), '', 'empty stays empty');
  eq(cleanTaleText('   \n  \n '), '', 'and so does whitespace only');
  eq(cleanTaleText(null), '', 'a non-string is empty, never a crash');
  eq(cleanTaleText('**bold** and _under_'), '**bold** and _under_', 'markdown is stored as typed');

  // control and bidi characters never reach the table
  const hostile = cleanTaleText('good \u0000\u202Eevil\u200B\uFEFF end');
  ok(!/[\u0000\u202E\u200B\uFEFF]/.test(hostile), 'control and bidi characters are stripped');
  eq(hostile, 'good evil end', 'and nothing else about the line changes');

  // a title is ONE line, always
  eq(cleanTaleTitle('  The  Long   Dark \n more '), 'The Long Dark more', 'a title collapses to one line');
  eq(cleanTaleTitle('A\u202ENight'), 'A Night', 'and a bidi override becomes a plain space');
  eq(cleanTaleTitle(null), '', 'a missing title is empty, never a crash');

  // ...and both ceilings are the COLUMN's, read out of the migration rather
  // than asserted against themselves. A constant that drifted past the check
  // would move the refusal from this clip to the database, where it arrives as
  // a failed insert and a lost tale.
  const migration = readFileSync(
    new URL('../../../db/2026-09-06_tales.sql', import.meta.url),
    'utf8',
  );
  const titleCap = migration.match(/char_length\(btrim\(title\)\)\s*between\s*1\s*and\s*(\d+)/);
  const textCap = migration.match(/char_length\(btrim\(text\)\)\s*between\s*1\s*and\s*(\d+)/);
  ok(titleCap && textCap, 'the migration carries a length check on both columns');
  eq(MAX_TALE_TITLE_CHARS, Number(titleCap[1]), 'and the bot clips a title at exactly that number');
  eq(MAX_TALE_TEXT_CHARS, Number(textCap[1]), 'and a tale at exactly that number');
  eq(MAX_TALE_TITLE_CHARS, 80, 'which is 80 for a title');
  eq(MAX_TALE_TEXT_CHARS, 4000, 'and 4000 for the tale');
  ok(/between 1 and/.test(migration), 'and the check refuses an EMPTY one at the same time');

  eq(cleanTaleText('x'.repeat(9000)).length, MAX_TALE_TEXT_CHARS, 'a long tale is capped');
  eq(cleanTaleTitle('x'.repeat(200)).length, MAX_TALE_TITLE_CHARS, 'and so is a long title');

  // the cap must never strand half a character (a lone surrogate breaks the
  // JSON insert body outright — Postgres refuses an unpaired \uD83D)
  const emoji = cleanTaleText('a'.repeat(MAX_TALE_TEXT_CHARS - 1) + '\u{1F600}');
  ok(!/[\uD800-\uDBFF]$/.test(emoji), 'the cap never leaves a lone high surrogate');
  ok(emoji.length <= MAX_TALE_TEXT_CHARS, 'and still respects the ceiling');
  const emojiTitle = cleanTaleTitle('a'.repeat(MAX_TALE_TITLE_CHARS - 1) + '\u{1F600}');
  ok(!/[\uD800-\uDBFF]$/.test(emojiTitle), 'nor does the title cap');

  // clipChars counts UTF-16 code units and Postgres counts code points, so the
  // clip is always at least as strict as the check. Worth pinning: a cap that
  // was looser than the constraint would lose the tale at the database.
  const astral = cleanTaleText('\u{1F600}'.repeat(4000));
  ok([...astral].length <= MAX_TALE_TEXT_CHARS, 'an all-astral tale is inside the column check too');

  eq(firstName('Bren Bjornsson'), 'Bren', 'a first name is the first token');
  eq(firstName('  '), 'A viking', 'and a blank one falls back');
  eq(taleAuthor({ author_character: 'Bren' }), 'Bren', 'a tale reads under its author');
  eq(taleAuthor({}), 'The Storyteller', 'and a nameless one under the office');

  eq(dayLabel('2026-09-12'), 'Saturday, September 12, 2026', 'a day renders as a day');
  // new Date('2026-09-12') is UTC midnight, and rendering THAT in Central time
  // says the 11th. The label is built from the key's own numbers for that
  // reason, and this is the assertion that keeps it that way.
  ok(/September 12/.test(dayLabel('2026-09-12')), 'and never slips a day backwards');
  eq(dayLabel('nonsense'), 'an unknown day', 'and a broken key is not a crash');
}

// ── a Supabase stub ───────────────────────────────────────────────────────
//
// Enough PostgREST for this module: insert().select().single(),
// update().eq(), delete().eq(), select().order().order().order().limit(),
// select().eq().maybeSingle() and select().eq().is().maybeSingle().
function fakeDb({
  rows = [],
  players = [],
  office = null,
  tableError = null,
  officeError = null,
} = {}) {
  const state = { tales: [...rows], voice: [], seq: 0, officeReads: 0 };
  const err = (t) => (tableError && t === 'tales' ? tableError : null);

  function taleQuery() {
    const sorts = [];
    const sorted = () => {
      const out = [...state.tales];
      out.sort((a, b) => {
        for (const [col, asc] of sorts) {
          const av = a[col];
          const bv = b[col];
          if (av === bv) continue;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      return out;
    };
    const api = {
      order(col, opts = {}) { sorts.push([col, opts.ascending !== false]); return api; },
      limit(n) { return Promise.resolve({ data: sorted().slice(0, n), error: null }); },
      then(res, rej) { return Promise.resolve({ data: sorted(), error: null }).then(res, rej); },
    };
    return api;
  }

  return {
    state,
    from(table) {
      const e = err(table);
      return {
        select() {
          if (e) {
            const stub = {
              eq: () => stub, is: () => stub, order: () => stub,
              limit: () => Promise.resolve({ data: null, error: e }),
              single: () => Promise.resolve({ data: null, error: e }),
              maybeSingle: () => Promise.resolve({ data: null, error: e }),
              then: (r) => Promise.resolve({ data: null, error: e }).then(r),
            };
            return stub;
          }
          if (table === 'tales') return taleQuery();
          if (table === 'players') {
            return {
              eq: (_c, v) => ({
                maybeSingle: () => Promise.resolve({
                  data: players.find((p) => p.discord_user_id === v) ?? null, error: null,
                }),
              }),
            };
          }
          if (table === 'offices') {
            const api = {
              eq: () => api,
              is: () => api,
              maybeSingle: () => {
                state.officeReads++;
                return Promise.resolve({ data: office, error: officeError });
              },
            };
            return api;
          }
          return { then: (r) => Promise.resolve({ data: [], error: null }).then(r) };
        },
        insert(row) {
          if (e) {
            return {
              select: () => ({ single: () => Promise.resolve({ data: null, error: e }) }),
              then: (r) => Promise.resolve({ error: e }).then(r),
            };
          }
          if (table === 'voice_lines') {
            state.voice.push(row);
            return Promise.resolve({ error: null });
          }
          // `g` for generated, so a stub id can never collide with a seeded one.
          const saved = { id: `g${++state.seq}`, created_at: new Date().toISOString(), ...row };
          state.tales.unshift(saved);
          return { select: () => ({ single: () => Promise.resolve({ data: { id: saved.id }, error: null }) }) };
        },
        update(patch) {
          const api = {
            _preds: [],
            eq(col, val) { api._preds.push([col, val]); return api; },
            then(res, rej) {
              if (e) return Promise.resolve({ error: e }).then(res, rej);
              for (const r of state.tales.filter((x) => api._preds.every(([c, v]) => x[c] === v))) {
                Object.assign(r, patch);
              }
              return Promise.resolve({ error: null }).then(res, rej);
            },
          };
          return api;
        },
        delete() {
          const api = {
            _preds: [],
            eq(col, val) { api._preds.push([col, val]); return api; },
            then(res, rej) {
              if (e) return Promise.resolve({ error: e }).then(res, rej);
              state.tales = state.tales.filter((x) => !api._preds.every(([c, v]) => x[c] === v));
              return Promise.resolve({ error: null }).then(res, rej);
            },
          };
          return api;
        },
      };
    },
  };
}

const tale = (over = {}) => ({
  id: 't1',
  title: 'The Longship Race',
  text: 'It went badly.',
  author_character: 'Bren',
  author_discord_id: 'D1',
  told_for: '2026-09-05',
  created_at: '2026-09-05T22:00:00Z',
  ...over,
});

// ── the message stub ──────────────────────────────────────────────────────
function fakeMessage({
  content,
  authorId = 'D1',
  member = undefined,
  guildId = 'G1',
  displayName = 'Bren of Discord',
  guild = { id: 'G1' },
}) {
  const sent = [];
  const reacts = [];
  const m =
    member === undefined
      ? {
          user: { id: authorId }, guild: { id: guildId }, displayName,
          permissions: { has: () => false }, roles: { cache: { has: () => false } },
        }
      : member;
  return {
    sent,
    reacts,
    author: { bot: false, id: authorId, username: 'teller', globalName: displayName },
    content,
    guild,
    guildId,
    member: m,
    mentions: { has: () => true },
    reply: async (p) => { sent.push(p); return {}; },
    react: async (e) => { reacts.push(e); },
  };
}

const plain = (id, guild = 'G1') => ({
  user: { id }, guild: { id: guild },
  permissions: { has: () => false }, roles: { cache: { has: () => false } },
});
const admin = (id, perm, guild = 'G1') => ({
  user: { id }, guild: { id: guild },
  permissions: { has: (p) => p === perm }, roles: { cache: { has: () => false } },
});
const roled = (id, role, guild = 'G1') => ({
  user: { id }, guild: { id: guild },
  permissions: { has: () => false }, roles: { cache: { has: (r) => r === role } },
});

// ── 4. Who may write, withdraw and rewrite ────────────────────────────────
{
  const G = { guildId: 'G1', storytellerDiscordId: 'HOLDER' };

  // THE WRITE GATE. Two people, and nobody else.
  ok(mayWriteTale(plain('HOLDER'), G), 'the Storyteller may write a tale');
  ok(mayWriteTale(admin('OWNER', 'Administrator'), G), 'an Administrator may');
  ok(mayWriteTale(admin('MOD', 'ManageGuild'), G), 'and so may Manage Server');
  ok(mayWriteTale(roled('MOD2', 'R7'), { ...G, adminRoleIds: ['R7'] }),
    'and an ADMIN_ROLE_IDS role does too');
  ok(!mayWriteTale(plain('VIKING'), G), 'a linked viking with no office may NOT');
  ok(!mayWriteTale(plain('STRANGER'), G), 'and neither may anyone else');
  ok(!mayWriteTale(null, G), 'a direct message has no member, so it has no authority');

  // THE GUILD PIN. `member.permissions` is authority in the guild the message
  // came from, so without it the owner of any other guild the bot sits in
  // could write into this hall's record.
  ok(!mayWriteTale(admin('OWNER', 'Administrator', 'G9'), G),
    'an admin of ANOTHER guild may not write here');
  ok(!mayWriteTale(plain('HOLDER', 'G9'), G),
    'and the office itself does not travel: it belongs to this hall');
  ok(mayWriteTale(admin('OWNER', 'Administrator', 'G9'), { storytellerDiscordId: 'HOLDER' }),
    'with no GUILD_ID set at all there is nothing to pin to, which is the pre-pin behaviour');

  // NO OFFICE AT ALL: the offices table absent, or every term closed.
  ok(!mayWriteTale(plain('HOLDER'), { guildId: 'G1' }),
    'with no holder, the viking who used to hold it is just a viking');
  ok(mayWriteTale(admin('OWNER', 'Administrator'), { guildId: 'G1' }),
    'and a jarl is the only writer left');

  // isJarl is the same three-way check the rest of the bot uses.
  ok(isJarl(admin('X', 'Administrator'), { guildId: 'G1' }), 'a jarl is an Administrator');
  ok(isJarl(admin('X', 'ManageGuild'), { guildId: 'G1' }), 'or Manage Server');
  ok(!isJarl(plain('HOLDER'), { guildId: 'G1' }), 'and the office alone does not make one');

  // THE EDIT GATE: the author too, and the author from anywhere.
  const mine = tale({ author_discord_id: 'AUTHOR' });
  ok(mayEditTale(plain('AUTHOR'), mine, G), 'the author may withdraw their own tale');
  ok(mayEditTale(plain('AUTHOR', 'G9'), mine, G),
    'from anywhere, because the tale is theirs wherever they stand');
  ok(mayEditTale(plain('HOLDER'), mine, G), 'the Storyteller may withdraw anyone’s');
  ok(mayEditTale(admin('OWNER', 'Administrator'), mine, G), 'and so may a jarl');
  ok(!mayEditTale(plain('SOMEONE'), mine, G), 'a bystander may not');
  ok(!mayEditTale(plain('SOMEONE'), mine, { guildId: 'G1' }),
    'and neither may anyone with no office and no permission');
  ok(!mayEditTale(plain('AUTHOR'), tale({ author_discord_id: null }), G),
    'a tale with no author id credits nobody, so the author rule cannot fire');
}

// ── 5. The handler, end to end ────────────────────────────────────────────
{
  const OFFICE = { id: 'o1', office: 'storyteller', holder_character: 'Bren', holder_discord_id: 'HOLDER' };

  // The Storyteller writes one about today.
  {
    const db = fakeDb({ office: OFFICE, players: [{ discord_user_id: 'HOLDER', character_name: 'Bren Bjornsson' }] });
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
    const msg = fakeMessage({ content: '<@BOT1> tale The Longship Race: two boats and a barrel', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(msg);
    eq(db.state.tales.length, 1, 'the tale is stored');
    eq(db.state.tales[0].title, 'The Longship Race', 'with its title');
    eq(db.state.tales[0].author_character, 'Bren Bjornsson', 'bylined to the linked character');
    eq(db.state.tales[0].author_discord_id, 'HOLDER', 'and carrying the writer, server side');
    eq(db.state.tales[0].told_for, ctDayKey(), 'about today, in Central time');
    eq(db.state.voice.length, 1, 'and one line is spoken in the hall');
    eq(db.state.voice[0].kind, 'event', 'as an event line');
    eq(db.state.voice[0].meta.source, 'tale', 'tagged as a tale');
    ok(db.state.voice[0].text.includes('Bren'), 'naming the teller');
    ok(msg.reacts.includes('📜'), 'and the message is marked with a scroll');
    const embed = msg.sent[0]?.embeds?.[0];
    ok(embed, 'the writer gets a confirmation embed');
    ok(embed.title.includes('Longship'), 'titled for the tale');
    ok(/Bren/.test(embed.description), 'naming who set it down');
    ok(/two boats and a barrel/.test(embed.description), 'and quoting the first of it');
    assert.deepStrictEqual(msg.sent[0].allowedMentions, { parse: [], repliedUser: false });
    passed++;
  }

  // A jarl who has never linked a viking is credited by their display name.
  {
    const db = fakeDb({ office: OFFICE });
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
    await tales.handleMessage(fakeMessage({
      content: '<@BOT1> tale The Wedding: they danced until the fire went out',
      authorId: 'JARL',
      member: { ...admin('JARL', 'Administrator'), displayName: 'Charlie' },
    }));
    eq(db.state.tales.length, 1, 'a jarl may write one without a linked viking');
    eq(db.state.tales[0].author_character, 'Charlie', 'credited by their server display name');
  }

  // Anyone else is told whose job it is, and NOTHING is stored.
  {
    const db = fakeDb({ office: OFFICE, players: [{ discord_user_id: 'VIKING', character_name: 'Ivar' }] });
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
    const msg = fakeMessage({ content: '<@BOT1> tale My Night: it was mine', authorId: 'VIKING', member: plain('VIKING') });
    await tales.handleMessage(msg);
    eq(db.state.tales.length, 0, 'a linked viking with no office writes nothing');
    ok(/Storyteller keeps the tales/.test(msg.sent[0]?.content ?? ''), 'and is told whose job it is');
    ok(/Ask them to write it down/.test(msg.sent[0]?.content ?? ''), 'in one line, in tone');

    const unlinked = fakeMessage({ content: '<@BOT1> tale My Night: mine', authorId: 'NOBODY', member: plain('NOBODY') });
    await tales.handleMessage(unlinked);
    eq(db.state.tales.length, 0, 'and an unlinked stranger writes nothing either');
  }

  // A DIRECT MESSAGE, and a message from another guild, are both refused before
  // anything is parsed.
  {
    const db = fakeDb({ office: OFFICE });
    process.env.GUILD_ID = 'G1';
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
    const dm = fakeMessage({ content: '<@BOT1> tale A Night: x', authorId: 'HOLDER', member: null, guild: null });
    await tales.handleMessage(dm);
    eq(dm.sent.length, 0, 'a direct message is answered with silence, not a refusal');
    const other = fakeMessage({ content: '<@BOT1> tale A Night: x', authorId: 'HOLDER', member: plain('HOLDER', 'G9'), guildId: 'G9', guild: { id: 'G9' } });
    await tales.handleMessage(other);
    eq(other.sent.length, 0, 'and so is another guild');
    eq(db.state.tales.length, 0, 'neither writes a row');
    delete process.env.GUILD_ID;
  }

  // A future night is refused, and an unreadable day is refused, with words.
  {
    const db = fakeDb({ office: OFFICE });
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
    const future = fakeMessage({ content: '<@BOT1> tale for 2099-01-01 A Night: x', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(future);
    eq(db.state.tales.length, 0, 'a tale about a night that has not happened is refused');
    ok(/has not happened yet/.test(future.sent[0]?.content ?? ''), 'and says so');

    const nonsense = fakeMessage({ content: '<@BOT1> tale for the fallen: we buried them', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(nonsense);
    eq(db.state.tales.length, 0, 'and so is a day nobody can read');
    ok(/could not read that day/.test(nonsense.sent[0]?.content ?? ''), 'naming the forms it does read');
    ok(/for yesterday/.test(nonsense.sent[0]?.content ?? ''), 'including yesterday');

    const wordless = fakeMessage({ content: '<@BOT1> tale A Night', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(wordless);
    eq(db.state.tales.length, 0, 'a tale with no words is not stored');
    ok(/needs a name and words/.test(wordless.sent[0]?.content ?? ''), 'and the writer is told which half is missing');
  }

  // THE THREE REFUSALS THAT USED TO BE WRONG OR SILENT.
  {
    const db = fakeDb({ office: OFFICE });
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });

    // A name longer than the parser's window: the writer supplied both halves,
    // so "a tale needs a name and words" would have been a lie.
    const longName = fakeMessage({
      content: `<@BOT1> tale ${'T'.repeat(130)}: and then we sailed home`,
      authorId: 'HOLDER', member: plain('HOLDER'),
    });
    await tales.handleMessage(longName);
    eq(db.state.tales.length, 0, 'an over-long name stores nothing');
    ok(/name runs too long/.test(longName.sent[0]?.content ?? ''), 'and says which half is wrong');
    ok(!/needs a name and words/.test(longName.sent[0]?.content ?? ''),
      'rather than blaming the writer for words they did supply');

    // A bare month and day that has not come round yet.
    const bareFuture = fakeMessage({
      content: '<@BOT1> tale for Dec 25 The Feast: it was long',
      authorId: 'HOLDER', member: plain('HOLDER'),
    });
    await tales.handleMessage(bareFuture);
    eq(db.state.tales.length, 0, 'a bare month and day in the future stores nothing');
    ok(/has not happened yet/.test(bareFuture.sent[0]?.content ?? ''), 'and is refused');
    ok(/whole date/.test(bareFuture.sent[0]?.content ?? ''),
      'telling a writer who meant an earlier year how to say so');

    // `untale` and `retale` with no number at all.
    const noNum = fakeMessage({ content: '<@BOT1> untale', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(noNum);
    eq(noNum.sent.length, 1, 'untale with no number is answered, never with silence');
    ok(/Which tale/.test(noNum.sent[0]?.content ?? ''), 'by asking which one');
    ok(/@Eilif tales/.test(noNum.sent[0]?.content ?? ''), 'and where the numbers come from');

    const noNumR = fakeMessage({ content: '<@BOT1> retale', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(noNumR);
    eq(noNumR.sent.length, 1, 'and so is retale with no number');
    ok(/Which tale/.test(noNumR.sent[0]?.content ?? ''), 'the same way');
  }

  // `tales` lists, and is open to the hall.
  {
    const db = fakeDb({
      rows: [
        tale({ id: 'a', title: 'The Wedding', told_for: '2026-09-01', created_at: '2026-09-01T20:00:00Z' }),
        tale({ id: 'b', title: 'The Longship Race', told_for: '2026-09-05', created_at: '2026-09-05T20:00:00Z' }),
      ],
    });
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
    const msg = fakeMessage({ content: '<@BOT1> tales', authorId: 'STRANGER', member: plain('STRANGER') });
    await tales.handleMessage(msg);
    const embed = msg.sent[0]?.embeds?.[0];
    ok(embed, 'any member may read the list');
    ok(embed.description.indexOf('Longship') < embed.description.indexOf('Wedding'),
      'and it is newest night first');
    eq(db.state.officeReads, 0, 'listing never even asks who the Storyteller is');

    const empty = fakeDb();
    const t2 = createTales({ client: { user: { id: BOT } }, db: empty, log: silentLog });
    const m2 = fakeMessage({ content: '<@BOT1> tales', authorId: 'STRANGER', member: plain('STRANGER') });
    await t2.handleMessage(m2);
    ok(/quill is dry/.test(m2.sent[0]?.content ?? ''), 'an empty hall gets the empty state, in tone');
  }

  // untale and retale: the numbers are the list's numbers, and the gate holds.
  {
    const rows = [
      tale({ id: 'a', title: 'The Wedding', author_discord_id: 'HOLDER', told_for: '2026-09-01' }),
      tale({ id: 'b', title: 'The Race', author_discord_id: 'OTHER', told_for: '2026-09-05' }),
    ];
    const db = fakeDb({ rows, office: OFFICE });
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });

    // a bystander may not
    const nope = fakeMessage({ content: '<@BOT1> untale 1', authorId: 'STRANGER', member: plain('STRANGER') });
    await tales.handleMessage(nope);
    eq(db.state.tales.length, 2, 'a bystander withdraws nothing');
    ok(/Storyteller keeps the tales/.test(nope.sent[0]?.content ?? ''), 'and is told so');

    // the author of the SECOND tale may withdraw their own
    const own = fakeMessage({ content: '<@BOT1> untale 1', authorId: 'OTHER', member: plain('OTHER') });
    await tales.handleMessage(own);
    eq(db.state.tales.length, 1, 'the author withdraws their own');
    eq(db.state.tales[0].id, 'a', 'and the number named the newest night, which was theirs');
    ok(/off the Saga/.test(own.sent[0]?.content ?? ''), 'and is told it is gone');

    // out of range
    const far = fakeMessage({ content: '<@BOT1> untale 9', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(far);
    eq(db.state.tales.length, 1, 'a number past the end withdraws nothing');
    ok(/from 1 to 1/.test(far.sent[0]?.content ?? ''), 'and says what the range is');

    // retale keeps the title and the day
    const re = fakeMessage({ content: '<@BOT1> retale 1: it went better than that', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(re);
    eq(db.state.tales[0].text, 'it went better than that', 'the Storyteller rewrites the words');
    eq(db.state.tales[0].title, 'The Wedding', 'the title is untouched');
    eq(db.state.tales[0].told_for, '2026-09-01', 'and so is the night');
    eq(db.state.voice.length, 0, 'a rewrite speaks no new line in the hall');

    const bare = fakeMessage({ content: '<@BOT1> retale 1', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(bare);
    ok(/rewrite needs words/.test(bare.sent[0]?.content ?? ''), 'a rewrite with no words says so');
  }

  // THE OFFICE IS READ ONCE A MINUTE, not once a message.
  {
    const db = fakeDb({ office: OFFICE });
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
    for (let i = 0; i < 5; i++) {
      await tales.handleMessage(fakeMessage({ content: '<@BOT1> tale', authorId: 'STRANGER', member: plain('STRANGER') }));
    }
    eq(db.state.officeReads, 1, 'five refusals cost one office read, not five');

    // ...AND IT EXPIRES. Without this the cache could be "forever" and every
    // assertion above would still pass, so an election would never be seen by a
    // bot that had already read the office once.
    const realNow = Date.now;
    try {
      const at = realNow.call(Date);
      Date.now = () => at + 61_000;
      await tales.handleMessage(fakeMessage({ content: '<@BOT1> tale', authorId: 'STRANGER', member: plain('STRANGER') }));
      eq(db.state.officeReads, 2, 'a minute later the office is read again, so an election lands');
    } finally {
      Date.now = realNow;
    }
  }

  // An offices table that is not there is a hall with no Storyteller, never a
  // failure: a jarl still writes, and nobody else does.
  {
    const db = fakeDb({ officeError: { code: 'PGRST205', message: "Could not find the table 'public.offices' in the schema cache" } });
    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
    const jarl = fakeMessage({ content: '<@BOT1> tale The Wedding: they danced', authorId: 'JARL', member: { ...admin('JARL', 'Administrator'), displayName: 'Charlie' } });
    await tales.handleMessage(jarl);
    eq(db.state.tales.length, 1, 'a jarl writes with no offices table at all');
    const nobody = fakeMessage({ content: '<@BOT1> tale Mine: x', authorId: 'VIKING', member: plain('VIKING') });
    await tales.handleMessage(nobody);
    eq(db.state.tales.length, 1, 'and nobody else does');
  }

  // Pre-migration, every path is a clean skip and NOTHING throws.
  {
    const missing = { code: 'PGRST205', message: "Could not find the table 'public.tales' in the schema cache" };
    const db = fakeDb({ tableError: missing, office: OFFICE });
    eq((await addTale(db, { title: 't', text: 'x', author: 'a', discordId: 'D', toldFor: '2026-09-05' })).notReady,
      true, 'addTale reports not-ready rather than throwing');
    eq((await listTales(db)).notReady, true, 'and so does listTales');
    eq((await deleteTale(db, 'x')).notReady, true, 'and deleteTale');
    eq((await rewriteTale(db, 'x', 'y')).notReady, true, 'and rewriteTale');

    const db2 = fakeDb({ tableError: { code: '42P01', message: 'relation "public.tales" does not exist' }, office: OFFICE });
    eq((await listTales(db2)).notReady, true, '42P01 is the same skip');

    const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
    const msg = fakeMessage({ content: '<@BOT1> tale A Night: x', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(msg);
    ok(/ledgers are still being carved/.test(msg.sent[0]?.content ?? ''),
      'and before the migration the write says so in tone');
    const list = fakeMessage({ content: '<@BOT1> tales', authorId: 'HOLDER', member: plain('HOLDER') });
    await tales.handleMessage(list);
    ok(/ledgers are still being carved/.test(list.sent[0]?.content ?? ''), 'as does the list');
  }

  // A CONSTRAINT VIOLATION IS NOT A MISSING TABLE. Postgres names the table in
  // both, so a check that matched the name alone would tell the Storyteller
  // their tale was filed when the constraint had just refused it.
  {
    for (const v of [
      { code: '23514', message: 'new row for relation "tales" violates check constraint "tales_title_len"' },
      { code: '23505', message: 'duplicate key value violates unique constraint "tales_pkey"' },
    ]) {
      const db = fakeDb({ tableError: v });
      await assert.rejects(
        () => addTale(db, { title: 't', text: 'x', author: 'a', discordId: 'D', toldFor: '2026-09-05' }),
        /insert tale/,
        `${v.code} is a real error, not a table that does not exist`,
      );
      passed++;
    }
  }
}

// ── 6. The rate limit ─────────────────────────────────────────────────────
{
  const OFFICE = { id: 'o1', office: 'storyteller', holder_character: 'Bren', holder_discord_id: 'HOLDER' };
  const db = fakeDb({ office: OFFICE });
  const tales = createTales({ client: { user: { id: BOT } }, db, log: silentLog });
  const write = (n) => fakeMessage({ content: `<@BOT1> tale Night ${n}: it happened`, authorId: 'HOLDER', member: plain('HOLDER') });

  await tales.handleMessage(write(1));
  eq(db.state.tales.length, 1, 'the first tale lands');
  const second = write(2);
  await tales.handleMessage(second);
  eq(db.state.tales.length, 1, 'a second inside two minutes does not');
  ok(/still fresh in the hall/.test(second.sent[0]?.content ?? ''), 'and the writer is told to wait');

  ok(tales._cooldownLeftMs('HOLDER') > 0, 'the cooldown is running for that member');
  eq(tales._cooldownLeftMs('SOMEONE_ELSE'), 0, 'and it is per member, not per hall');
  eq(TALE_COOLDOWN_MS, 2 * 60 * 1000, 'two minutes, as the README says');

  // A REFUSED tale must never spend the cooldown: a Storyteller whose day was
  // unreadable has to be able to fix it and try again immediately.
  const db2 = fakeDb({ office: OFFICE });
  const t2 = createTales({ client: { user: { id: BOT } }, db: db2, log: silentLog });
  await t2.handleMessage(fakeMessage({ content: '<@BOT1> tale for 2099-01-01 A Night: x', authorId: 'HOLDER', member: plain('HOLDER') }));
  eq(t2._cooldownLeftMs('HOLDER'), 0, 'a refused tale costs no cooldown');
  await t2.handleMessage(fakeMessage({ content: '<@BOT1> tale A Night: x', authorId: 'HOLDER', member: plain('HOLDER') }));
  eq(db2.state.tales.length, 1, 'so the corrected one lands straight away');
}

// ── 7. The voice pool against the copy doctrine ───────────────────────────
{
  ok(TALE_VOICE_LINES.length >= 5 && TALE_VOICE_LINES.length <= 6,
    `the pool is five to six lines, got ${TALE_VOICE_LINES.length}`);
  ok(new Set(TALE_VOICE_LINES).size === TALE_VOICE_LINES.length, 'no line is written twice');

  for (const line of TALE_VOICE_LINES) {
    ok(!line.includes('—'), `em dash in "${line}"`);
    ok(!line.includes('–'), `en dash in "${line}"`);
    ok(!line.includes(';'), `semicolon in "${line}"`);
    ok(!line.includes('!'), `exclamation in "${line}"`);
    ok(!/\p{Extended_Pictographic}/u.test(line), `emoji in "${line}"`);
    ok(line.includes('{firstName}'), `"${line}" names the teller`);
    ok(line.includes('{title}'), `"${line}" names the tale`);
    for (const token of line.match(/\{[^}]*\}/g) || []) {
      ok(['{firstName}', '{title}'].includes(token), `"${token}" has no substitution, in "${line}"`);
    }
    const rendered = line.replace(/\{firstName\}/g, 'Bren').replace(/\{title\}/g, 'The Longship Race');
    ok(!/[{}]/.test(rendered), `a token survived the fill: ${rendered}`);
    // Spoken center-screen by the Companion: the in-game doctrine cap is 150.
    ok(rendered.length <= 150, `${rendered.length} chars (cap 150): ${rendered}`);
  }

  // THE ARITHMETIC, NOT A SAMPLE. Every template spends its own words plus a
  // title clipped to VOICE_TITLE_CHARS, and whatever is left is the room a name
  // has. A pool whose tightest line leaves less than VOICE_NAME_CHARS ships a
  // line past the cap, so check the budget itself: a sample name (the old test
  // used 'Bjornsdottir', twelve characters) cannot see this coming.
  for (const line of TALE_VOICE_LINES) {
    const fixed = line.replace(/\{firstName\}/g, '').replace(/\{title\}/g, '').length;
    const budget = 150 - fixed - VOICE_TITLE_CHARS;
    ok(budget >= VOICE_NAME_CHARS,
      `"${line}" leaves ${budget} characters for a name, and a name may be ${VOICE_NAME_CHARS}`);
  }

  // THE WORST CASE A WRITER CAN ACTUALLY PRODUCE: a one-word name as long as
  // cleanName will pass (48), which covers a 32-character Discord display name
  // (the byline for a jarl who never linked a viking) with room to spare.
  const longTitle = 'T'.repeat(VOICE_TITLE_CHARS);
  for (const line of TALE_VOICE_LINES) {
    const worst = line
      .replace(/\{firstName\}/g, 'N'.repeat(VOICE_NAME_CHARS))
      .replace(/\{title\}/g, longTitle);
    ok(worst.length <= 150, `a long name and a long title still fit: ${worst.length} chars`);
  }
  for (const name of ['N'.repeat(48), 'N'.repeat(32), 'Bjornsdottir']) {
    for (let i = 0; i < TALE_VOICE_LINES.length * 4; i++) {
      const line = taleVoiceLine(name, 'T'.repeat(400), `seed${i}`);
      ok(line.length <= 150, `a ${name.length}-character name still fits: ${line.length} chars`);
    }
  }
  // ...and the real filler really does clip to that ceiling.
  const spoken = taleVoiceLine('Bjornsdottir', 'T'.repeat(400), 'seed');
  ok(spoken.length <= 150, `the filled line is inside the cap: ${spoken.length} chars`);
  eq(speakableTitle('T'.repeat(400)).length, VOICE_TITLE_CHARS, 'a title is clipped for the voice');
  eq(speakableTitle('The "Long" Night'), 'The Long Night', 'and its quotes are stripped');
  eq(speakableTitle('A ‘quoted’ “night”'), 'A quoted night', 'curly ones too');
  eq(speakableTitle('   '), 'a tale of the hall', 'and an empty one still says something');

  // The chooser is stable and covers the pool.
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(taleVoiceLine('Bren', 'A Night', `seed${i}`));
  eq(seen.size, TALE_VOICE_LINES.length, `every line is reachable, saw ${seen.size}`);
  eq(taleVoiceLine('Bren', 'A Night', 'k'), taleVoiceLine('Bren', 'A Night', 'k'),
    'the same seed always speaks the same line');

  // A hostile name or title never reaches the hall with control characters.
  const hostile = taleVoiceLine('Bren\u202Eevil\nsecond line', 'A\nNight\u0000', 'k');
  ok(!/[\n\u202E\u0000]/.test(hostile), 'a hostile name cannot break the voice line onto a second line');
}

// ── 8. The reply copy, and the source, against the same doctrine ──────────
{
  // The list embed is inside Discord's ceilings even when every tale is at its
  // own ceiling, because clampEmbed is what actually posts it.
  const many = Array.from({ length: TALES_LIMIT }, (_, i) =>
    tale({ id: `n${i}`, title: 'T'.repeat(MAX_TALE_TITLE_CHARS), text: 'x'.repeat(MAX_TALE_TEXT_CHARS) }));
  const embed = clampEmbed(renderTaleList(many));
  ok(embed.description.length <= 4096, `the list description fits an embed (${embed.description.length})`);
  ok(embed.title.length <= 256, 'and so does its title');
  eq(TALES_LIMIT, 10, 'and the list is the ten the README promises');

  // Charlie's doctrine, swept over the module's own player-visible copy. Only
  // comment lines, journal lines and parser tokens are exempt, exactly as
  // scripts/tellings.test.mjs case 8 sweeps tellings.js.
  const isNotPlayerCopy = (line) =>
    /^\s*(\/\/|\*|\/\*)/.test(line) ||
    /log\.(info|warn|error)\?\./.test(line) ||
    /\.match\(|\.replace\(|RegExp|new Error\(/.test(line);

  const src = readFileSync(new URL('../src/tales.js', import.meta.url), 'utf8');
  const offenders = [];
  src.split('\n').forEach((raw, i) => {
    if (isNotPlayerCopy(raw)) return;
    const code = raw.replace(/(^|[^:])\/\/.*$/, '$1');
    if (/[—–]/.test(code)) offenders.push(`tales.js:${i + 1}: ${code.trim()}`);
  });
  ok(offenders.length === 0, `no em/en dash in the reply copy, found: ${JSON.stringify(offenders.slice(0, 3))}`);

  // The four locks this module shares with every other mention handler.
  ok(/mentions\?\.has\(client\.user, MENTION_STRICT\)/.test(src), 'it gates on an explicit mention');
  ok(/if \(!message\.guild\) return;/.test(src), 'it refuses a direct message');
  ok(/if \(guildId && message\.guildId !== guildId\) return;/.test(src), 'it refuses another guild');
  ok(/allowedMentions: \{ parse: \[\], repliedUser: false \}/.test(src), 'and its embed replies ping nobody');
  // Every player-typed string that reaches Discord goes through format.js.
  ok(/nameMd\(/.test(src) && /safeText\(/.test(src), 'player-typed text is escaped on display');
  ok(!/function escapeMd\(/.test(src), 'and it does not carry its own frozen copy of the escape');
  // The office is READ, never guessed at, and it comes from the module that owns it.
  ok(/from '\.\/storyteller\.js'/.test(src), 'the holder is resolved through storyteller.js');
  ok(/readCurrentOffice\(/.test(src), 'by its own lookup, rather than a second copy of the query');
  // No feature flag: the office is the gate.
  ok(!/process\.env\.TALES/.test(src), 'there is no TALES flag to be half-set');
}

console.log(`tales.test: ${passed} assertions passed`);
