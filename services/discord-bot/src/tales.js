// Tales of the hall: the Storyteller's record of a night that was not a boss.
//
// Charlie: "the Storyteller should also be able to recount server events like a
// game night or a fun rp event. those should be logged somewhere maybe the
// daily summaries in Saga. actually Saga should have a section or a way to
// filter to show just the storyteller's work."
//
// tellings.js hangs every telling off a boss. Most of what happens on this
// server is not a boss: a raid night, a wedding, a longship race, an argument
// about where the smelter goes. A tale is a telling with a DAY instead of a
// boss, and the day is what carries it onto the Saga, where it renders inside
// the episode for that night.
//
// THE VERBS (all require a real `<@Eilif>` mention in the content, all are
// answered with allowed_mentions pinned to none, and all are refused outside
// this guild and in a direct message):
//
//   @Eilif tale <Title>: <the tale>                    about today
//   @Eilif tale for yesterday <Title>: <the tale>      about a named day
//   @Eilif tale for last night <Title>: <the tale>     see resolveTaleDay
//   @Eilif tale for 2026-09-12 <Title>: <the tale>
//   @Eilif tale for Sep 12 <Title>: <the tale>
//   @Eilif tales                                       the last ten, numbered
//   @Eilif untale <n>                                  withdraw one
//   @Eilif retale <n>: <the tale>                      rewrite one, same title
//
// WHO MAY WRITE ONE, and this is the whole difference from `retell`. A telling
// is anyone's: any linked viking may tell a boss's fall. A tale is the
// Storyteller's, because it is a record of the hall rather than an account of a
// fight, and a record wants one hand. So: the viking who holds the office
// (db/2026-09-06_offices.sql), or a jarl of this hall. Everyone else gets one
// in-tone line pointing them at the Storyteller, and nothing is stored. With
// the offices table absent or its terms all closed there is simply no holder,
// and a jarl is the only writer.
//
// UNTRUSTED TEXT, handled exactly as tellings.js handles it: stored RAW minus
// control characters, capped at the column's own ceiling, and escaped at every
// point of DISPLAY instead (nameMd/safeText/clampEmbed on the Discord side,
// plain text nodes on the site side).
//
// ALWAYS ON. There is no flag: a hall with no Storyteller and no jarl typing
// has no tales, which is the same thing an off switch would give. Degrades
// gracefully before db/2026-09-06_tales.sql is applied: a missing table becomes
// an in-tone "not ready yet" reply, exactly like identity.js and tellings.js.

import { serviceClient } from './supabase.js';
import { nameMd, safeText, replyPayload, replySafeName, clipChars, GOLD } from './format.js';
import { MENTION_STRICT, clampEmbed } from './discord.js';
import { readCurrentOffice } from './storyteller.js';

/** The tale's own name. Matches tales_title_len in the migration. */
export const MAX_TALE_TITLE_CHARS = 80;
/**
 * The tale itself. Matches tales_text_len. Twice boss_tellings' ceiling because
 * a tale is an account of a whole evening rather than of one fight, and Discord
 * carries 4000 characters in a message from a nitro member.
 */
export const MAX_TALE_TEXT_CHARS = 4000;
/**
 * How many tales `@Eilif tales` lists, and therefore the highest `n` that
 * `untale` and `retale` can name. Ten rather than twenty: a tale is a
 * paragraph, not a line, and a numbered list of twenty of them is a wall.
 */
export const TALES_LIMIT = 10;
/**
 * One tale per member per two minutes. In process only: a restart forgets it,
 * which is the right trade (the rows are the real record, and this exists to
 * stop a burst, not to enforce a quota). Shorter than the retell cooldown
 * because the writer here is already an office holder or a jarl.
 */
export const TALE_COOLDOWN_MS = 2 * 60 * 1000;
const TALE_MEMORY_MAX = 200; // ten times the player cap, like identity.js

/**
 * THE HOUR "last night" TURNS OVER, in Central time.
 *
 * A tale filed in the small hours is about the evening that just ended, which
 * is the PREVIOUS Central day; once the sun is up the hall has turned over and
 * "last night" is read as the current day. Anyone who means a specific earlier
 * night says `for yesterday` or names the date, which is never ambiguous.
 */
export const LAST_NIGHT_HOUR = 6;

/** The community's timezone, and the one the Saga's episodes are bucketed by. */
export const TALE_TZ = 'America/Chicago';

// Same two probes tellings.js and storyteller.js carry, for the same reason: a
// constraint violation is a working table saying no, and must never be read as
// "the migration has not run".
const MISSING_TABLE =
  /relation .* does not exist|could not find the table|undefined table/i;
const MISSING_COLUMN = /discord_user_id|column .* does not exist|schema cache/i;

// C0/C1 controls, zero-width joiners and the bidi overrides that let text
// render as something other than what it is. Line breaks are KEPT: a tale is
// prose and the Saga renders its blank-line paragraphs.
const CONTROL_CHARS_KEEP_BREAKS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
// A title and a name each go into one line of copy and into a spoken line, so
// they lose their breaks too.
const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** True when this error means db/2026-09-06_tales.sql has not run. */
export function talesNotMigrated(error) {
  if (!error) return false;
  // A constraint violation is a working table saying no. Never "not migrated",
  // whatever the message says.
  if (error.code === '23505' || error.code === '23514' || error.code === '23503') return false;
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST204') return true;
  return MISSING_TABLE.test(error.message || '');
}

// ── text ──────────────────────────────────────────────────────────────────

/**
 * A tale, made safe to STORE: no control or bidi characters, CRLF folded, runs
 * of blank lines collapsed to one, trimmed, and capped at the column's own
 * ceiling. Markdown is left exactly as typed, because it is escaped on display.
 */
export function cleanTaleText(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_KEEP_BREAKS, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // clipChars, not slice: a code-unit cut can strand a lone surrogate, and this
  // string goes into a JSON insert body. Postgres refuses an unpaired \uD83D
  // escape, so the whole tale would be lost.
  return clipChars(t, MAX_TALE_TEXT_CHARS);
}

/** A title: one line, no control characters, capped at the column's ceiling. */
export function cleanTaleTitle(raw) {
  const t = String(raw ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return clipChars(t, MAX_TALE_TITLE_CHARS);
}

/** A name, made safe to put in one line of copy or one spoken line. */
export function cleanName(raw, max = 48) {
  const t = String(raw ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return clipChars(t, max);
}

/** "Bren Bjornsson" to "Bren". */
export function firstName(name) {
  const t = cleanName(name);
  return t.split(' ')[0] || 'A viking';
}

// ── the Central-time day ──────────────────────────────────────────────────
//
// `tales.told_for` is a DATE, and the same America/Chicago calendar-day key the
// Saga buckets sessions by (lib/episodes.ts ctDayKey). Everything below works
// on that key as a string, so a tale never passes through a timezone
// conversion twice.

const CT_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TALE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const CT_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TALE_TZ,
  hour: '2-digit',
  hourCycle: 'h23',
});

/** "2026-09-06" for an instant, in Central time. */
export function ctDayKey(ms = Date.now()) {
  return CT_DAY_FMT.format(new Date(ms));
}

/** The hour of the day, 0 to 23, in Central time. */
export function ctHour(ms = Date.now()) {
  return Number(CT_HOUR_FMT.format(new Date(ms)));
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A day key, moved by whole days. Pure calendar arithmetic on the key itself
 * (through UTC, which has no offset to trip over), never on an instant, so
 * "the day before" is the day before across a daylight-saving change too.
 */
export function shiftDay(key, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + delta * 86_400_000,
  );
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** True when this key names a day that really exists (2026-02-31 does not). */
export function isRealDay(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
  );
}

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * The day a `for <...>` phrase names, or null when it names nothing readable.
 *
 * Accepted: today, tonight, yesterday, last night, 2026-09-12, "Sep 12",
 * "September 12 2026", "12 Sep". A month and a day with no year mean THIS
 * year's, and one that has not come round yet is refused rather than quietly
 * read as last year's. That rollback used to be here and it was wrong for this
 * hall: the world was made on 2026-09-09, so a bare "Sep 12" typed on the 6th
 * would have named a night in 2025 that nobody played, and filed it outside the
 * Saga's own seventy-day window where only the Storyteller's view would ever
 * show it. A writer who really does mean an earlier year writes the whole date,
 * and the refusal says so.
 *
 * Returns `{ day, status }`:
 *   ok         : `day` is a Central calendar day at or before today
 *   future     : `day` parsed but has not happened yet
 *   unreadable : nothing here names a day
 */
export function resolveTaleDay(spec, nowMs = Date.now()) {
  const today = ctDayKey(nowMs);
  const raw = String(spec ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,]+$/, '');
  if (!raw) return { day: today, status: 'ok' };

  let day = null;
  if (raw === 'today' || raw === 'tonight') {
    day = today;
  } else if (raw === 'yesterday') {
    day = shiftDay(today, -1);
  } else if (raw === 'last night') {
    day = ctHour(nowMs) < LAST_NIGHT_HOUR ? shiftDay(today, -1) : today;
  } else {
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    if (iso) {
      const key = `${iso[1]}-${pad2(Number(iso[2]))}-${pad2(Number(iso[3]))}`;
      day = isRealDay(key) ? key : null;
    } else {
      const named =
        /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(raw) ??
        // "12 Sep" reads the same way round for anyone who writes dates the
        // other way; the month word is what tells the two apart.
        (() => {
          const m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?(?:,? (\d{4}))?$/.exec(raw);
          return m ? [m[0], m[2], m[1], m[3]] : null;
        })();
      if (named && MONTHS[named[1]]) {
        const mo = MONTHS[named[1]];
        const dayNum = Number(named[2]);
        const year = named[3] ? Number(named[3]) : Number(today.slice(0, 4));
        const key = `${year}-${pad2(mo)}-${pad2(dayNum)}`;
        // A bare month and day are read in the current year and nowhere else.
        // If that day has not come round yet the `future` check below refuses
        // it, which is the whole rule this file promises.
        day = isRealDay(key) ? key : null;
      }
    }
  }

  if (!day) return { day: null, status: 'unreadable' };
  if (day > today) return { day, status: 'future' };
  return { day, status: 'ok' };
}

/**
 * Pull a `for <day>` prefix off the front of a command, or null when what
 * follows `for` is not a day at all.
 *
 * Only the four shapes resolveTaleDay reads are matched here, and a word that
 * is not one of them leaves this as null so the handler can say so, rather than
 * quietly filing a mistyped date under today. The cost is that a tale whose
 * TITLE starts with the word "for" has to name its day first, which the refusal
 * says out loud.
 */
export function matchDayPrefix(text) {
  const s = String(text ?? '');
  const phrase = /^(last night|yesterday|tonight|today)\b[ \t]*/i.exec(s);
  if (phrase) return { spec: phrase[1], rest: s.slice(phrase[0].length) };

  const iso = /^(\d{4}-\d{1,2}-\d{1,2})\b[ \t]*/.exec(s);
  if (iso) return { spec: iso[1], rest: s.slice(iso[0].length) };

  const md = /^([a-z]{3,9})\.?[ \t]+(\d{1,2})(?:st|nd|rd|th)?(?:[ \t]*,?[ \t]*(\d{4}))?\b[ \t]*/i.exec(s);
  if (md && MONTHS[md[1].toLowerCase()]) {
    return { spec: `${md[1]} ${md[2]}${md[3] ? ` ${md[3]}` : ''}`, rest: s.slice(md[0].length) };
  }

  const dm = /^(\d{1,2})(?:st|nd|rd|th)?[ \t]+([a-z]{3,9})\.?(?:[ \t]*,?[ \t]*(\d{4}))?\b[ \t]*/i.exec(s);
  if (dm && MONTHS[dm[2].toLowerCase()]) {
    return { spec: `${dm[1]} ${dm[2]}${dm[3] ? ` ${dm[3]}` : ''}`, rest: s.slice(dm[0].length) };
  }

  return null;
}

// ── the verbs ─────────────────────────────────────────────────────────────

/**
 * Pull a tale verb out of a mention message, or null if it is not one.
 * Returns { verb: 'write' | 'list' | 'untale' | 'retale', ... }.
 *
 * Anchored at the start of what is left after the mention is stripped, so an
 * ordinary sentence that happens to contain "tale" is not a command. The `\b`
 * after the alternation is what keeps `tales` from parsing as `tale` plus a
 * title called "s": there is no word boundary between the `e` and the `s`, so
 * the shorter verb cannot win.
 *
 * `tell`, `retell` and `tellings` belong to tellings.js and are not matched
 * here, so the two handlers never answer the same message.
 */
export function parseTales(content, botId) {
  const stripped = String(content ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/^[\s,.:!]+/, '')
    .trim();

  const m = stripped.match(/^(tales|untale|retale|tale)\b([\s\S]*)$/i);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  // `\s` and not `[ \t]`: writing the verb on one line and the tale on the next
  // is an ordinary shape for a long Discord message, and it used to fall through
  // to "a tale needs a name and words", which blames the writer for words they
  // did supply. The same reason `for` below accepts a break after it.
  const rest = m[2].replace(/^\s+/, '');

  if (verb === 'tales') return { verb: 'list' };

  if (verb === 'untale') {
    const body = rest.replace(/^[\s:]+/, '').split('\n')[0].trim();
    const um = body.match(/^#?(\d{1,3})\b/);
    // No number is STILL a recognised command, and gets told what is missing.
    // This used to return null, so `@Eilif untale` was answered with silence
    // while its own sibling `retale 3` was answered with a sentence.
    return { verb: 'untale', index: um ? parseInt(um[1], 10) : null };
  }

  if (verb === 'retale') {
    const body = rest.replace(/^[ \t]*/, '');
    const rm = body.match(/^#?(\d{1,3})[ \t]*:[ \t]*\n?([\s\S]+)$/);
    if (rm) return { verb: 'retale', index: parseInt(rm[1], 10), text: rm[2] };
    // A number with nothing after it, or nothing at all, is still a recognised
    // command, so the viking is told what is missing instead of getting
    // silence, which is the one thing a command with this many shapes must
    // never answer with.
    const bare = body.match(/^#?(\d{1,3})[\s:]*$/);
    if (bare) return { verb: 'retale', index: parseInt(bare[1], 10), text: '' };
    return { verb: 'retale', index: null, text: '' };
  }

  // write: [for <day>] <Title>: <the tale>
  let body = rest;
  let dayText = null;
  const forM = body.match(/^for\b\s+([\s\S]*)$/i);
  if (forM) {
    const found = matchDayPrefix(forM[1]);
    if (!found) {
      return {
        verb: 'write',
        dayText: forM[1].split('\n')[0].trim().slice(0, 40),
        badDay: true,
        title: '',
        text: '',
      };
    }
    dayText = found.spec;
    body = found.rest.replace(/^\s*/, '');
  }

  // The title runs to the FIRST colon, so a colon inside the tale is safe. 120
  // rather than 80 so a slightly long title still parses and is clipped with
  // the writer watching, instead of falling through to the "no words" branch.
  const tm = body.match(/^([^:\n]{1,120}):[ \t]*\n?([\s\S]+)$/);
  if (!tm) {
    // A COLON THAT SITS BEYOND THAT WINDOW is a name nobody meant as a name.
    // It used to drop through to the branch below and be answered with "a tale
    // needs a name and words", discarding a tale whose writer had supplied
    // both; say what is actually wrong instead.
    const colon = body.split('\n')[0].indexOf(':');
    if (colon > 120) return { verb: 'write', dayText, longTitle: true, title: '', text: '' };
    // A name with no words, or nothing at all, is STILL a recognised command:
    // the writer is told what is missing instead of getting silence, which is
    // the one thing a command with this many shapes must never answer with.
    const bare = body.split('\n')[0].replace(/[:\s]+$/, '').trim();
    return { verb: 'write', dayText, title: bare, text: '' };
  }
  return { verb: 'write', dayText, title: tm[1].trim(), text: tm[2] };
}

// ── the in-game voice ─────────────────────────────────────────────────────
//
// Spoken center-screen by the Companion plugin, so the doctrine caps these at
// 150 characters once {firstName} and {title} are filled. Scanned in
// scripts/tales.test.mjs alongside every other pool.
export const TALE_VOICE_LINES = [
  '{firstName} has written a tale of the hall: {title}. The stones will keep it.',
  'A new tale is set down by {firstName}: {title}. The hall will hear it.',
  '{firstName} keeps the record. {title} is written, and it stands.',
  'The Storyteller has been at work. {firstName} sets down {title}.',
  '{firstName} adds {title} to the tales of Eilif. Nothing told here is lost.',
  'Word of {title} goes into the record, told by {firstName}.',
];

/** How much of a title the spoken line carries. */
export const VOICE_TITLE_CHARS = 60;
/**
 * How much of a NAME the spoken line carries.
 *
 * The doctrine caps a spoken line at 150 characters. The tightest template in
 * the pool below spends 59 of those on its own words and 60 on the title,
 * leaving 31, while `firstName` will hand over up to 48 characters and a
 * Discord display name (the byline for a jarl who never linked a viking) runs
 * to 32. So the name is clipped HERE, and scripts/tales.test.mjs computes the
 * tightest budget in the pool and fails if a new line ever leaves less than
 * this, rather than trusting anyone to do that arithmetic by hand.
 */
export const VOICE_NAME_CHARS = 28;

// Small, pure 31-multiplier string hash, stable across runs. Mirrors format.js,
// retelling.js, tellings.js and storyteller.js so seeded choice reads the same
// way everywhere.
function hashString(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * A title, made safe to SPEAK. Quotes go: the plugin renders the line as one
 * string on screen and a stray quote inside a sentence about a quote reads as
 * damage. Clipped to VOICE_TITLE_CHARS so the longest honest title still leaves
 * room for the rest of the line under the 150-character ceiling.
 */
export function speakableTitle(raw) {
  const t = cleanName(raw, MAX_TALE_TITLE_CHARS)
    .replace(/["'‘’“”«»]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clipChars(t, VOICE_TITLE_CHARS) || 'a tale of the hall';
}

/** The line the hall hears when a tale is written. */
export function taleVoiceLine(characterName, title, seed = null) {
  const key = seed ?? `${characterName}|${title}`;
  const tpl = TALE_VOICE_LINES[hashString(key) % TALE_VOICE_LINES.length];
  return tpl
    .replace(/\{firstName\}/g, clipChars(firstName(characterName), VOICE_NAME_CHARS))
    .replace(/\{title\}/g, speakableTitle(title));
}

// ── the list ──────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * "Saturday, September 12, 2026" for a day KEY.
 *
 * Formatted from the key's own numbers rather than by parsing it into a Date
 * and formatting that: `new Date('2026-09-12')` is UTC midnight, and rendering
 * that instant in Central time says September 11. The year is always shown,
 * because a month and a day with no year can resolve to last year and the
 * writer has to be able to see that it did.
 */
export function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return 'an unknown day';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(at.getTime())) return 'an unknown day';
  return `${WEEKDAYS[at.getUTCDay()]}, ${MONTH_NAMES[mo - 1]} ${d}, ${y}`;
}

/** The byline a tale reads under, on Discord and on the site alike. */
export function taleAuthor(row) {
  return cleanName(row?.author_character) || 'The Storyteller';
}

/**
 * The numbered list of the hall's tales, as an embed description. Numbering is
 * the order the rows come back in (newest day first), which is the same order
 * `untale <n>` and `retale <n>` count in.
 */
export function renderTaleList(rows, { limit = TALES_LIMIT } = {}) {
  const lines = [];
  rows.forEach((row, i) => {
    lines.push(
      `**${i + 1}.** ${safeText(row.title, 60)} · ${nameMd(taleAuthor(row))} · ${dayLabel(row.told_for)}`,
    );
    lines.push(safeText(row.text, 90));
  });
  return {
    title: rows.length === 1 ? 'One tale of the hall' : `Tales of the hall (${rows.length})`,
    description: lines.join('\n'),
    color: GOLD,
    footer: { text: `The last ${limit}. Rewrite one with: @Eilif retale <number>: <the tale>` },
  };
}

// ── database ──────────────────────────────────────────────────────────────

/** Write one tale. */
export async function addTale(db, { title, text, author, discordId, toldFor }) {
  const { data, error } = await db
    .from('tales')
    .insert({
      title,
      text,
      author_character: author ?? null,
      author_discord_id: discordId ?? null,
      told_for: toldFor,
    })
    .select('id')
    .single();
  if (error) {
    if (talesNotMigrated(error)) return { notReady: true, id: null };
    throw new Error(`insert tale: ${error.message}`);
  }
  return { notReady: false, id: data?.id ?? null };
}

/**
 * The hall's tales, newest day first and newest within a day.
 *
 * Ordered by `told_for` before `created_at` because the list is a record of
 * NIGHTS, and a tale written today about last Tuesday belongs under Tuesday
 * rather than at the top. `id` breaks the last tie so two tales filed in the
 * same second are numbered the same way on every call and `untale 2` always
 * means the same row.
 */
export async function listTales(db, limit = TALES_LIMIT) {
  const { data, error } = await db
    .from('tales')
    .select('id, title, text, author_character, author_discord_id, told_for, created_at')
    .order('told_for', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) {
    if (talesNotMigrated(error)) return { notReady: true, rows: [] };
    throw new Error(`list tales: ${error.message}`);
  }
  return { notReady: false, rows: data ?? [] };
}

/** Withdraw one tale. */
export async function deleteTale(db, id) {
  const { error } = await db.from('tales').delete().eq('id', id);
  if (error) {
    if (talesNotMigrated(error)) return { notReady: true, ok: false };
    throw new Error(`delete tale: ${error.message}`);
  }
  return { notReady: false, ok: true };
}

/** Rewrite one tale's words, keeping its title and its day. */
export async function rewriteTale(db, id, text) {
  const { error } = await db.from('tales').update({ text }).eq('id', id);
  if (error) {
    if (talesNotMigrated(error)) return { notReady: true, ok: false };
    throw new Error(`rewrite tale: ${error.message}`);
  }
  return { notReady: false, ok: true };
}

// ── permissions ───────────────────────────────────────────────────────────

/**
 * A jarl of THIS hall: the same three-way check the voice puppet uses
 * (voice.js mayPuppet), `keep` uses (tellings.js mayKeepTelling) and the
 * election uses (storyteller.js mayHoldElection), including the guild pin.
 * `member.permissions` is authority in the guild the message came from, not in
 * this one, so without the pin the owner of any other guild the bot is in could
 * write into our hall's record.
 */
export function isJarl(member, { guildId = null, adminRoleIds = [] } = {}) {
  if (!member) return false; // a direct message has no member, so it has no permissions
  if (guildId && member.guild?.id !== guildId) return false;
  if (member.permissions?.has?.('Administrator')) return true;
  if (member.permissions?.has?.('ManageGuild')) return true;
  return adminRoleIds.some((id) => member.roles?.cache?.has?.(id));
}

/**
 * Who may write a tale: the Storyteller of Eilif while the office is held, or a
 * jarl of this hall. Nobody else, and that is the point of the office.
 *
 * The Storyteller check sits BELOW the guild pin, exactly as it does in
 * tellings.js mayKeepTelling: the office belongs to THIS hall, so its authority
 * has to be exercised from inside it.
 */
export function mayWriteTale(
  member,
  { guildId = null, adminRoleIds = [], storytellerDiscordId = null } = {},
) {
  if (!member) return false;
  if (guildId && member.guild?.id !== guildId) return false;
  const senderId = member?.user?.id ?? member?.id ?? null;
  if (storytellerDiscordId && senderId && String(storytellerDiscordId) === senderId) return true;
  return isJarl(member, { guildId, adminRoleIds });
}

/**
 * Who may withdraw or rewrite one: the viking who wrote it, the Storyteller, or
 * a jarl.
 *
 * The author check sits ABOVE the guild pin, and unlike the two below it,
 * because a tale is theirs wherever they are standing. The handler refuses a
 * direct message before this is ever reached, so that is belt and braces; it
 * matches mayKeepTelling, which is the point.
 */
export function mayEditTale(
  member,
  tale,
  { guildId = null, adminRoleIds = [], storytellerDiscordId = null } = {},
) {
  const authorId = tale?.author_discord_id;
  const senderId = member?.user?.id ?? member?.id ?? null;
  if (authorId && senderId && String(authorId) === senderId) return true;
  return mayWriteTale(member, { guildId, adminRoleIds, storytellerDiscordId });
}

// ── the handler ───────────────────────────────────────────────────────────

export function createTales({ client, log = console, db: injectedDb }) {
  // `injectedDb` is a test seam, the same one createVoiceEngine, createTellings
  // and createStoryteller use. Production passes nothing and builds the real
  // service client.
  const db = injectedDb ?? serviceClient();

  // Pinned to this hall for the reasons identity.js, gallery.js and tellings.js
  // are: this module writes with the service role and answers in a channel, and
  // "Public Bot" in the Developer Portal is still on.
  const guildId = process.env.GUILD_ID || null;
  const adminRoleIds = String(process.env.ADMIN_ROLE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // discordId to the ms of that member's last accepted tale.
  const lastTaleAt = new Map();

  // THE STORYTELLER, cached for a minute. The holder changes at an election,
  // never while a viking is typing, so one read serves every verb for a minute.
  // Unlike tellings.js this is never gated on a flag: a tale is the office's
  // whole reason to exist, so the office is always consulted. A missing table
  // is a hall with no Storyteller, which leaves a jarl as the only writer.
  const OFFICE_CACHE_MS = 60_000;
  let officeCache = { at: 0, holder: null };
  async function storyteller() {
    if (officeCache.at && Date.now() - officeCache.at < OFFICE_CACHE_MS) return officeCache.holder;
    let holder = null;
    try {
      const { notReady, office } = await readCurrentOffice(db);
      if (!notReady && office) {
        holder = {
          character: office.holder_character ?? null,
          discordId: office.holder_discord_id ?? null,
        };
      }
    } catch (e) {
      log.warn?.(`[tales] could not read the office: ${e.message}`);
    }
    officeCache = { at: Date.now(), holder };
    return holder;
  }

  function cooldownLeftMs(discordId) {
    const at = lastTaleAt.get(discordId);
    if (typeof at !== 'number') return 0;
    const left = TALE_COOLDOWN_MS - (Date.now() - at);
    return left > 0 ? left : 0;
  }

  function rememberTale(discordId) {
    lastTaleAt.set(discordId, Date.now());
    if (lastTaleAt.size <= TALE_MEMORY_MAX) return;
    // Map iterates in insertion order and every entry is re-inserted on a
    // successful tale, so the front of the map is the least recently used.
    for (const key of lastTaleAt.keys()) {
      lastTaleAt.delete(key);
      if (lastTaleAt.size <= TALE_MEMORY_MAX) break;
    }
  }

  // parse: [] (format.js replyPayload) so nothing this bot echoes can ping the
  // hall, and the embed replies below carry the same allowedMentions by hand.
  const reply = (message, content) => message.reply(replyPayload(content)).catch(() => {});
  const replyEmbed = (message, embed) =>
    message
      .reply({
        embeds: [clampEmbed(embed)],
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(() => {});

  const NOT_READY = 'The Hall’s ledgers are still being carved. Ask again shortly.';
  const NOT_YOURS =
    'The Storyteller keeps the tales of the hall. Ask them to write it down.';

  /** The sender's own viking, from their confirmed Discord link. */
  async function resolveSenderPlayer(discordId) {
    const { data, error } = await db
      .from('players')
      .select('id, character_name')
      .eq('discord_user_id', discordId)
      .maybeSingle();
    if (error) {
      if (MISSING_COLUMN.test(error.message)) return { notReady: true, player: null };
      throw new Error(`players: ${error.message}`);
    }
    return { notReady: false, player: data ?? null };
  }

  /**
   * The name a tale is filed under: the character the writer's Discord is
   * linked to, and otherwise their server display name.
   *
   * The fallback is what makes the office usable on night one. A jarl who has
   * never shouted the rune in-game still has to be able to write the hall's
   * record, and crediting them by the name the hall sees in Discord is a truer
   * byline than leaving it blank.
   */
  async function bylineFor(message) {
    const { notReady, player } = await resolveSenderPlayer(message.author.id);
    if (notReady) return { notReady: true, name: null };
    const linked = cleanName(player?.character_name);
    if (linked) return { notReady: false, name: linked };
    const display =
      message.member?.displayName ??
      message.member?.nickname ??
      message.author?.globalName ??
      message.author?.username;
    return { notReady: false, name: cleanName(display) || null };
  }

  async function queueVoiceLine(text, meta) {
    const { error } = await db.from('voice_lines').insert({
      text,
      kind: 'event',
      meta,
      status: 'queued',
      queued_at: new Date().toISOString(),
    });
    // The tale is already recorded; a voice line that will not queue is worth a
    // journal line and nothing more.
    if (error) log.warn?.(`[tales] voice line not queued: ${error.message}`);
    return !error;
  }

  async function handleWrite({ message, cmd, holder }) {
    if (cmd.longTitle) {
      await reply(
        message,
        'That name runs too long for a tale. Keep it under 80 characters, mark where the name ' +
          'ends with a colon, and put the rest in the tale itself.',
      );
      return;
    }
    if (cmd.badDay) {
      await reply(
        message,
        'I could not read that day. Name it as `for yesterday`, `for last night`, ' +
          '`for 2026-09-12` or `for Sep 12`. A tale whose title begins with the word ' +
          '"for" has to name its day first.',
      );
      return;
    }

    const left = cooldownLeftMs(message.author.id);
    if (left > 0) {
      await reply(
        message,
        'Your last tale is still fresh in the hall. Let it settle a couple of minutes, then write another.',
      );
      return;
    }

    const title = cleanTaleTitle(cmd.title);
    const text = cleanTaleText(cmd.text);
    if (!title || !text) {
      await reply(
        message,
        'A tale needs a name and words. Try `@Eilif tale The Longship Race: how it actually went`.',
      );
      return;
    }

    const { day, status } = resolveTaleDay(cmd.dayText);
    if (status === 'unreadable') {
      await reply(
        message,
        'I could not read that day. Name it as `for yesterday`, `for last night`, ' +
          '`for 2026-09-12` or `for Sep 12`.',
      );
      return;
    }
    if (status === 'future') {
      await reply(
        message,
        'That night has not happened yet. A tale is a record, so name a night that is already ' +
          'behind us. For one in an earlier year, write the whole date, as `for 2025-12-25`.',
      );
      return;
    }

    const { notReady, name } = await bylineFor(message);
    if (notReady) {
      await reply(message, NOT_READY);
      return;
    }

    const added = await addTale(db, {
      title,
      text,
      author: name,
      discordId: message.author.id,
      toldFor: day,
    });
    if (added.notReady) {
      await reply(message, NOT_READY);
      return;
    }
    rememberTale(message.author.id);

    const byline = name || (holder?.character ?? null) || 'The Storyteller';
    await replyEmbed(message, {
      title: safeText(title, 80),
      description:
        `**${nameMd(byline)}** set this down for ${dayLabel(day)}.\n\n_${safeText(text, 200)}_`,
      color: GOLD,
      footer: { text: 'It joins that night on the Saga. See them all with: @Eilif tales' },
    });
    await message.react('📜').catch(() => {});

    await queueVoiceLine(taleVoiceLine(byline, title, added.id), {
      source: 'tale',
      tale_id: added.id,
      title,
      told_for: day,
      by: byline,
    });

    log.info?.(`[tales] ${byline} wrote "${title}" for ${day}`);
  }

  async function handleList({ message }) {
    const { notReady, rows } = await listTales(db);
    if (notReady) {
      await reply(message, NOT_READY);
      return;
    }
    if (!rows.length) {
      await reply(
        message,
        'No tale has been written yet. The Storyteller’s quill is dry.',
      );
      return;
    }
    await replyEmbed(message, renderTaleList(rows));
  }

  async function pickTale(message, index) {
    const { notReady, rows } = await listTales(db);
    if (notReady) {
      await reply(message, NOT_READY);
      return { row: null, done: true };
    }
    const row = rows[index - 1];
    if (!row) {
      await reply(
        message,
        rows.length
          ? `There are ${rows.length} tales in the list. Name one of them, from 1 to ${rows.length}.`
          : 'No tale has been written yet. The Storyteller’s quill is dry.',
      );
      return { row: null, done: true };
    }
    return { row, done: false };
  }

  async function handleUntale({ message, cmd, holder }) {
    if (!Number.isInteger(cmd.index)) {
      await reply(
        message,
        'Which tale? Name it by number, as `@Eilif untale 2`. `@Eilif tales` lists them.',
      );
      return;
    }
    const { row, done } = await pickTale(message, cmd.index);
    if (done) return;

    if (
      !mayEditTale(message.member, row, {
        guildId,
        adminRoleIds,
        storytellerDiscordId: holder?.discordId ?? null,
      })
    ) {
      await reply(message, NOT_YOURS);
      return;
    }

    let res;
    try {
      res = await deleteTale(db, row.id);
    } catch (e) {
      log.warn?.(`[tales] could not withdraw tale ${row.id}: ${e.message}`);
      await reply(message, 'That tale could not be withdrawn just now. Try again in a moment.');
      return;
    }
    if (res.notReady) {
      await reply(message, NOT_READY);
      return;
    }
    await reply(
      message,
      `"${replySafeName(row.title)}" is off the Saga. The night stands as it did before it was written.`,
    );
    await message.react('📜').catch(() => {});
    log.info?.(`[tales] ${message.author.id} withdrew tale ${row.id}`);
  }

  async function handleRetale({ message, cmd, holder }) {
    if (!Number.isInteger(cmd.index)) {
      await reply(
        message,
        'Which tale? Name it by number, as `@Eilif retale 2: how it actually went`. ' +
          '`@Eilif tales` lists them.',
      );
      return;
    }
    const text = cleanTaleText(cmd.text);
    if (!text) {
      await reply(
        message,
        'A rewrite needs words. Try `@Eilif retale 1: how it actually went`.',
      );
      return;
    }

    const { row, done } = await pickTale(message, cmd.index);
    if (done) return;

    if (
      !mayEditTale(message.member, row, {
        guildId,
        adminRoleIds,
        storytellerDiscordId: holder?.discordId ?? null,
      })
    ) {
      await reply(message, NOT_YOURS);
      return;
    }

    let res;
    try {
      res = await rewriteTale(db, row.id, text);
    } catch (e) {
      log.warn?.(`[tales] could not rewrite tale ${row.id}: ${e.message}`);
      await reply(message, 'That tale could not be rewritten just now. Try again in a moment.');
      return;
    }
    if (res.notReady) {
      await reply(message, NOT_READY);
      return;
    }
    await replyEmbed(message, {
      title: safeText(row.title, 80),
      description: `Rewritten for ${dayLabel(row.told_for)}.\n\n_${safeText(text, 200)}_`,
      color: GOLD,
      footer: { text: 'The name and the night are unchanged. See them all with: @Eilif tales' },
    });
    await message.react('📜').catch(() => {});
    log.info?.(`[tales] ${message.author.id} rewrote tale ${row.id}`);
  }

  async function handleMessage(message) {
    try {
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user, MENTION_STRICT)) return;
      if (!message.guild) return;
      if (guildId && message.guildId !== guildId) return;

      const cmd = parseTales(message.content, client.user.id);
      if (!cmd) return;

      // Listing is open to the hall: the tales are on the public Saga already,
      // and a viking who cannot read the numbers cannot ask for a correction.
      if (cmd.verb === 'list') {
        await handleList({ message });
        return;
      }

      const holder = await storyteller();
      if (
        cmd.verb === 'write' &&
        !mayWriteTale(message.member, {
          guildId,
          adminRoleIds,
          storytellerDiscordId: holder?.discordId ?? null,
        })
      ) {
        await reply(message, NOT_YOURS);
        return;
      }

      if (cmd.verb === 'write') await handleWrite({ message, cmd, holder });
      else if (cmd.verb === 'untale') await handleUntale({ message, cmd, holder });
      else if (cmd.verb === 'retale') await handleRetale({ message, cmd, holder });
    } catch (e) {
      log.error?.(`[tales] ${e.message}`);
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
    log.info?.(
      '[tales] active: `@Eilif tale <Title>: <text>`, `@Eilif tales`, `@Eilif untale <n>`, `@Eilif retale <n>: <text>`',
    );
  }

  return { attach, handleMessage, _cooldownLeftMs: cooldownLeftMs, _rememberTale: rememberTale };
}
