// Player retellings of a boss fall.
//
// Charlie: "I want to be able to update the boss kill stories with manual
// retellings that players make. the auto generated one is fine but I want to be
// able to update it later."
//
// The Skald still writes one saga per kill (retelling.js). This module lets a
// viking write another, from Discord, and makes theirs the one the war-room
// shows. Nothing is ever overwritten: every telling is a row in
// `boss_tellings` (db/2026-09-06_boss_tellings.sql) and exactly one of them
// carries `chosen`.
//
// THE VERBS (all require a real `<@Eilif>` mention in the content, and all are
// answered with allowed_mentions pinned to none):
//
//   @Eilif retell <Boss>: <your telling>     tell it, and make it the one shown
//   @Eilif tell <Boss>: <your telling>       the same verb, shorter
//   @Eilif tellings <Boss>                   list what has been told, numbered
//   @Eilif keep <Boss> <n>                   choose telling n from that list
//
// A newline may stand in for the space after the colon, so a viking can write a
// paragraph on the next line. The boss may be named or slugged, in any case:
// "Bonemass", "bonemass", "the-elder", "The Elder" all resolve.
//
// IDENTITY-GATED, exactly like the oath ingest: the telling is credited to the
// character the SENDER's Discord account is linked to (players.discord_user_id,
// set by shouting the `/oath <CODE>` rune in-game), never to a name typed in
// the message. A viking who has not linked yet is told how, and nothing is
// written.
//
// UNTRUSTED TEXT. `text` is whatever a player typed into Discord. It is stored
// RAW (minus control characters) on purpose, so the war-room can render it as
// prose, and it is escaped at every point of DISPLAY instead: safeText/nameMd
// on the Discord side (format.js), plain text nodes on the site side. The one
// thing done at storage time is the length cap and the control-character strip,
// because neither is a display concern.
//
// Gated behind TELLINGS (on unless TELLINGS=0). Degrades gracefully before
// db/2026-09-06_boss_tellings.sql is applied: a missing table becomes an
// in-tone "not ready yet" reply, exactly like identity.js.

import { serviceClient } from './supabase.js';
import { nameMd, safeText, replyPayload, replySafeName, clipChars, GOLD } from './format.js';
import { MENTION_STRICT, clampEmbed } from './discord.js';

// Discord's own message ceiling, and the check constraint on the column. A
// telling that fitted in the message that carried it fits in the table.
export const MAX_TELLING_CHARS = 2000;
// How many tellings a boss shows, and therefore the highest `n` that `keep`
// can name. The war-room reads the same 20 (lib/data.ts getBossTellings).
export const TELLINGS_LIMIT = 20;
// One retell per member per five minutes. In process only: a restart forgets
// it, which is the right trade (the rows are the real record, and this exists
// to stop a burst, not to enforce a quota). Mirrors identity.js CLAIM_COOLDOWN.
export const RETELL_COOLDOWN_MS = 5 * 60 * 1000;
const RETELL_MEMORY_MAX = 200; // ten times the player cap, like identity.js

// "The table is not there yet." Deliberately does NOT match on the table's
// NAME. Postgres names the table in messages that mean the exact opposite —
//   new row for relation "boss_tellings" violates check constraint "boss_tellings_text_len"
//   duplicate key value violates unique constraint "boss_tellings_one_chosen_idx"
// — and reading either of those as "not migrated" would answer a working table
// with "the ledgers are still being carved", and would tell a viking their
// telling was filed when the constraint had just refused it. Error CODES are
// checked first (see notMigrated); this is the fallback for a client that hands
// back nothing but a message.
const MISSING_TABLE =
  /relation .* does not exist|could not find the table|undefined table/i;
const MISSING_COLUMN = /discord_user_id|column .* does not exist|schema cache/i;

// C0/C1 controls, zero-width joiners and the bidi overrides that let text
// render as something other than what it is. Line breaks are KEPT: a telling
// is prose and the war-room renders its blank-line paragraphs.
const CONTROL_CHARS_KEEP_BREAKS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
// A name goes into one line of copy and into an in-game voice line, so it loses
// its breaks too.
const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/**
 * A telling, made safe to STORE: no control or bidi characters, CRLF folded,
 * runs of blank lines collapsed to one, trimmed, and capped at the column's own
 * ceiling. Markdown is left exactly as typed, because it is escaped on display.
 */
export function cleanTellingText(raw) {
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
  // escape, so the whole telling would be lost. Same reason every cap in
  // format.js moved off slice.
  return clipChars(t, MAX_TELLING_CHARS);
}

/** A character name, made safe to put in one line of copy or one voice line. */
function cleanName(raw, max = 48) {
  const t = String(raw ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return clipChars(t, max);
}

/** "Bren Bjornsson" to "Bren". */
export function firstName(name) {
  const t = cleanName(name);
  return t.split(' ')[0] || 'A viking';
}

/**
 * Mirrors lib/slug.ts slugify, so `@Eilif retell the-elder:` resolves to the
 * same boss the URL /boss/the-elder does. Kept here rather than imported
 * because that module is TypeScript and this service is plain Node.
 */
export function slugifyBossName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks, as lib/slug.ts folds them
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const normName = (s) => String(s ?? '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

/**
 * Resolve a typed boss to a row.
 *   exact     : the name, or its slug, matches one boss
 *   partial   : the text is a prefix of, or contained in, exactly one boss name
 *   ambiguous : more than one boss answers to it (candidates are named back)
 *   unknown   : nothing does
 * Case, spacing and the Norse diacritics all fold away first.
 */
export function matchBoss(query, bosses) {
  const rows = Array.isArray(bosses) ? bosses : [];
  const q = normName(query);
  if (!q) return { boss: null, status: 'unknown', candidates: [] };
  const qSlug = slugifyBossName(query);

  for (const b of rows) {
    if (normName(b.name) === q) return { boss: b, status: 'exact', candidates: [] };
  }
  if (qSlug) {
    for (const b of rows) {
      if (slugifyBossName(b.name) === qSlug) return { boss: b, status: 'exact', candidates: [] };
    }
  }

  // "bone" for Bonemass, "queen" for The Queen. Prefix first: "the" must not
  // silently resolve to whichever forsaken happens to sort first.
  const starts = rows.filter((b) => normName(b.name).startsWith(q));
  const pool = starts.length ? starts : rows.filter((b) => normName(b.name).includes(q));
  if (pool.length === 1) return { boss: pool[0], status: 'partial', candidates: [] };
  if (pool.length > 1) {
    return { boss: null, status: 'ambiguous', candidates: pool.map((b) => b.name) };
  }
  return { boss: null, status: 'unknown', candidates: [] };
}

/**
 * Pull a telling verb out of a mention message, or null if it is not one.
 * Returns { verb: 'retell' | 'list' | 'keep', boss, text?, index? }.
 *
 * Anchored at the start of what is left after the mention is stripped, so an
 * ordinary sentence that happens to contain the word "tell" is not a command.
 * The `\b` after the alternation is what keeps `tellings` from parsing as
 * `tell` plus a boss called "ings": there is no word boundary between the `l`
 * and the `i`, so the shorter verb cannot win. Listing the longer verbs first
 * is for the reader, not for the regex engine.
 */
export function parseTellings(content, botId) {
  const stripped = String(content ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/^[\s,.:!]+/, '')
    .trim();

  const m = stripped.match(/^(retellings|tellings|retell|tell|keep)\b([\s\S]*)$/i);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const rest = m[2].replace(/^[ \t]+/, '');

  if (verb === 'tellings' || verb === 'retellings') {
    const boss = rest.replace(/^[\s:]+/, '').split('\n')[0].trim().replace(/[?!.]+$/, '');
    return boss ? { verb: 'list', boss } : null;
  }

  if (verb === 'keep') {
    // `keep <Boss> <n>` — the number is the LAST token, so a boss name with
    // spaces in it ("keep The Elder 2") still works.
    const body = rest.replace(/^[\s:]+/, '').split('\n')[0].trim();
    const km = body.match(/^([\s\S]+?)[\s#]+(\d{1,3})$/);
    if (!km) return null;
    const boss = km[1].trim();
    const index = parseInt(km[2], 10);
    return boss && Number.isFinite(index) ? { verb: 'keep', boss, index } : null;
  }

  // retell / tell: `<Boss>: <text>`, where the space after the colon may be a
  // newline. A colon inside the telling itself is safe, because only the FIRST
  // one splits.
  const body = rest.replace(/^[\s]*/, '');
  const rm = body.match(/^([^:\n]{1,80}):[ \t]*\n?([\s\S]+)$/);
  if (!rm) {
    // A boss with no telling after it is still a recognised command, so the
    // viking gets told what is missing instead of silence.
    const bare = body.split('\n')[0].replace(/[:\s]+$/, '').trim();
    return bare ? { verb: 'retell', boss: bare, text: '' } : null;
  }
  return { verb: 'retell', boss: rm[1].trim(), text: rm[2] };
}

// ── the in-game voice ─────────────────────────────────────────────────────
//
// Spoken center-screen by the Companion plugin, so the doctrine caps these at
// 150 characters once {firstName} and {boss} are filled. Scanned in
// scripts/tellings.test.mjs alongside every other pool.
export const TELLING_VOICE_LINES = [
  '{firstName} has told the fall of {boss}. The hall will hear it.',
  '{firstName} set down a new telling of {boss}. It stands in the record.',
  'The fall of {boss} is told again, by {firstName}. Listen well.',
  '{firstName} carved another verse for {boss}. The saga grows.',
  'A new account of {boss} reaches the hall, in the voice of {firstName}.',
];

// Small, pure 31-multiplier string hash, stable across runs. Mirrors format.js
// and retelling.js so seeded choice reads the same way everywhere.
function hashString(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** The line the hall hears when a viking tells a boss's fall. */
export function tellingVoiceLine(characterName, bossName, seed = null) {
  const key = seed ?? `${characterName}|${bossName}`;
  const tpl = TELLING_VOICE_LINES[hashString(key) % TELLING_VOICE_LINES.length];
  return tpl
    .replace(/\{firstName\}/g, firstName(characterName))
    .replace(/\{boss\}/g, cleanName(bossName, 32) || 'the forsaken');
}

// ── the list ──────────────────────────────────────────────────────────────

/** "just now" / "3 hours ago" / "2 days ago". No date library in this service. */
export function shortAge(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'at an unknown hour';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 90) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  if (day < 45) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mon = Math.round(day / 30);
  return `${mon} month${mon === 1 ? '' : 's'} ago`;
}

/** The byline a telling reads under, on Discord and on the site alike. */
export function tellingAuthor(row) {
  if (row?.source === 'skald') return 'The Skald';
  const name = cleanName(row?.author_character);
  return name || 'A viking';
}

/**
 * The numbered list of a boss's tellings, as an embed description. Numbering is
 * the order the rows come back in (newest first), which is the same order
 * `keep <Boss> <n>` counts in.
 */
export function renderTellingList(bossName, rows, now = Date.now()) {
  const lines = [];
  rows.forEach((row, i) => {
    const mark = row.chosen ? ' · shown on the war room' : '';
    lines.push(
      `**${i + 1}.** ${nameMd(tellingAuthor(row))} · ${shortAge(row.created_at, now)}${mark}`,
    );
    lines.push(safeText(row.text, 80));
  });
  return {
    title: `Tellings of ${cleanName(bossName, 40)}`,
    description: lines.join('\n'),
    color: GOLD,
    footer: { text: 'Choose one with: @Eilif keep <Boss> <number>' },
  };
}

// ── database ──────────────────────────────────────────────────────────────

/** True when this error means db/2026-09-06_boss_tellings.sql has not run. */
function notMigrated(error) {
  if (!error) return false;
  // A constraint violation is a working table saying no. Never "not migrated",
  // whatever the message says.
  if (isChosenTaken(error) || error.code === '23514' || error.code === '23503') return false;
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST204') return true;
  return MISSING_TABLE.test(error.message || '');
}

/**
 * True when `boss_tellings_one_chosen_idx` refused the write: another telling
 * of this boss already carries the flag. Not a failure, an answer — it is how
 * the Skald's hook asks "is anything chosen?" and takes no for a reply without
 * a read-then-write window in between.
 */
function isChosenTaken(error) {
  if (!error) return false;
  if (error.code === '23505') return true;
  return /duplicate key value|unique constraint/i.test(error.message || '');
}

/**
 * Insert one telling. ALWAYS unchosen: the partial unique index means only one
 * row per boss may carry the flag, so setting it is a separate step that can
 * fail without costing the telling itself.
 */
export async function addTelling(db, { bossId, author, discordId, text, source }) {
  const { data, error } = await db
    .from('boss_tellings')
    .insert({
      boss_id: bossId,
      author_character: author ?? null,
      author_discord_id: discordId ?? null,
      text,
      source,
      chosen: false,
    })
    .select('id')
    .single();
  if (error) {
    if (notMigrated(error)) return { notReady: true, id: null };
    throw new Error(`insert telling: ${error.message}`);
  }
  return { notReady: false, id: data?.id ?? null };
}

/**
 * Make one telling the boss's chosen one. Two statements, in this order,
 * because `boss_tellings_one_chosen_idx` will not let two rows hold the flag at
 * once: clear the boss's flag, then set this row's. A failure between them
 * leaves the boss with no chosen telling, and the war room falls back to the
 * newest, which is the same row this was about to name.
 *
 * Two vikings retelling the same boss in the same instant can interleave those
 * four statements so the second `set` finds the flag already taken. That is one
 * retry, not an error: clear and set again. A second loss is reported as
 * `ok: false` rather than retried forever, and the caller says "filed with the
 * others" instead of "it now stands".
 */
export async function setChosen(db, bossId, tellingId, { attempts = 2 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const cleared = await db
      .from('boss_tellings')
      .update({ chosen: false })
      .eq('boss_id', bossId)
      .eq('chosen', true);
    if (cleared.error) {
      if (notMigrated(cleared.error)) return { notReady: true, ok: false };
      throw new Error(`clear chosen: ${cleared.error.message}`);
    }
    const { error } = await db
      .from('boss_tellings')
      .update({ chosen: true })
      .eq('id', tellingId);
    if (!error) return { notReady: false, ok: true };
    if (notMigrated(error)) return { notReady: true, ok: false };
    if (!isChosenTaken(error)) throw new Error(`set chosen: ${error.message}`);
  }
  return { notReady: false, ok: false };
}

/**
 * Take the chosen flag ONLY IF no telling of this boss holds it, in one
 * statement. The partial unique index does the deciding, so there is no window
 * between asking and writing: if another telling already stands, the write is
 * refused and that is the answer. This is how a regenerated Skald saga is filed
 * UNDER a viking's account instead of over it.
 */
export async function claimChosen(db, tellingId) {
  const { error } = await db
    .from('boss_tellings')
    .update({ chosen: true })
    .eq('id', tellingId);
  if (!error) return { notReady: false, claimed: true };
  if (notMigrated(error)) return { notReady: true, claimed: false };
  if (isChosenTaken(error)) return { notReady: false, claimed: false };
  throw new Error(`claim chosen: ${error.message}`);
}

/**
 * This boss's tellings: the chosen one FIRST, then the rest newest first.
 *
 * Chosen-first is not cosmetic. The window is bounded (a boss retold two
 * hundred times must not hand back two hundred rows), so ordering by date alone
 * would let a deliberately kept telling age out of the list — the war room
 * would quietly show the newest one instead, and `keep` could not even name the
 * kept row again to put it back. lib/data.ts getBossTellings orders the same
 * way for the same reason. The chosen row is marked in the numbered list, so a
 * reader can see why it sits at the top.
 */
export async function listTellings(db, bossId, limit = TELLINGS_LIMIT) {
  const { data, error } = await db
    .from('boss_tellings')
    .select('id, boss_id, author_character, author_discord_id, text, source, chosen, created_at')
    .eq('boss_id', bossId)
    .order('chosen', { ascending: false })
    .order('created_at', { ascending: false })
    // Tie-break, so two tellings written in the same second are numbered the
    // same way on every call and `keep 2` always means the same row.
    .order('id', { ascending: false })
    .limit(limit);
  if (error) {
    if (notMigrated(error)) return { notReady: true, rows: [] };
    throw new Error(`list tellings: ${error.message}`);
  }
  return { notReady: false, rows: data ?? [] };
}

/**
 * THE SKALD'S HOOK, called by retelling.js after it writes bosses.retelling.
 *
 * Records the generated saga as a telling too, and marks it chosen ONLY if the
 * boss has no chosen telling yet. A regeneration therefore never displaces a
 * viking's own account: it is filed underneath it, where `@Eilif tellings` can
 * still find it. "Only if" is the partial unique index's word, not this
 * function's — it inserts unchosen and then CLAIMS the flag, so there is no
 * instant between asking and writing in which a viking's telling could land and
 * be stood down.
 *
 * Honours TELLINGS=0, so that flag turns the whole feature off (verbs and rows
 * alike) rather than only the verbs.
 *
 * Best-effort by contract: every failure is reported, none is thrown, so the
 * boss announcement and the retelling write are never affected.
 */
export async function recordSkaldTelling({ db, boss, text, log = console }) {
  if (process.env.TELLINGS === '0') return { wrote: false, reason: 'disabled' };
  if (!db || !boss?.id) return { wrote: false, reason: 'no client' };
  const clean = cleanTellingText(text);
  if (!clean) return { wrote: false, reason: 'empty' };
  try {
    const { notReady, id } = await addTelling(db, {
      bossId: boss.id,
      author: 'The Skald',
      discordId: null,
      text: clean,
      source: 'skald',
    });
    if (notReady) return { wrote: false, reason: 'not-migrated' };

    let chosen = false;
    if (id) {
      const claim = await claimChosen(db, id);
      if (claim.notReady) return { wrote: true, id, chosen: false };
      chosen = claim.claimed;
    }
    log.info?.(
      `[tellings] filed the Skald telling of ${boss.name}${chosen ? ' (chosen)' : ' (a player telling still stands)'}`,
    );
    return { wrote: true, id, chosen };
  } catch (e) {
    log.warn?.(`[tellings] could not file the Skald's telling: ${e.message}`);
    return { wrote: false, reason: e.message };
  }
}

// ── permissions ───────────────────────────────────────────────────────────

/**
 * Who may choose which telling stands: the viking who told it, or a jarl of
 * this hall. The admin half is the SAME check the voice puppet uses
 * (voice.js mayPuppet), including the guild pin: `member.permissions` is
 * authority in the guild the message came from, not in this one, so without it
 * the owner of any other guild the bot is in could re-choose our war room's
 * saga.
 */
export function mayKeepTelling(member, telling, { guildId = null, adminRoleIds = [] } = {}) {
  const authorId = telling?.author_discord_id;
  const senderId = member?.user?.id ?? member?.id ?? null;
  if (authorId && senderId && authorId === senderId) return true;
  if (!member) return false; // a direct message has no member, so it has no permissions
  if (guildId && member.guild?.id !== guildId) return false;
  if (member.permissions?.has?.('Administrator')) return true;
  if (member.permissions?.has?.('ManageGuild')) return true;
  return adminRoleIds.some((id) => member.roles?.cache?.has?.(id));
}

// ── the handler ───────────────────────────────────────────────────────────

export function createTellings({ client, log = console, db: injectedDb }) {
  // `injectedDb` is a test seam, the same one createVoiceEngine and
  // createIdentityLink use. Production passes nothing and builds the real
  // service client.
  const db = injectedDb ?? serviceClient();

  // Pinned to this hall for the reasons identity.js and gallery.js are: this
  // module writes with the service role and answers in a channel, and "Public
  // Bot" in the Developer Portal is still on.
  const guildId = process.env.GUILD_ID || null;
  const adminRoleIds = String(process.env.ADMIN_ROLE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // discordId to the ms of that member's last accepted retell.
  const lastTellAt = new Map();

  function cooldownLeftMs(discordId) {
    const at = lastTellAt.get(discordId);
    if (typeof at !== 'number') return 0;
    const left = RETELL_COOLDOWN_MS - (Date.now() - at);
    return left > 0 ? left : 0;
  }

  function rememberTell(discordId) {
    lastTellAt.set(discordId, Date.now());
    if (lastTellAt.size <= RETELL_MEMORY_MAX) return;
    // Map iterates in insertion order and every entry is re-inserted on a
    // successful retell, so the front of the map is the least recently used.
    for (const key of lastTellAt.keys()) {
      lastTellAt.delete(key);
      if (lastTellAt.size <= RETELL_MEMORY_MAX) break;
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
  const NOT_KNOWN =
    'The Hall does not yet know you. Link your viking first: `@Eilif I am <YourViking>` ' +
    '(or `@Eilif join`), then shout the rune it gives you in-game.';

  // The roster of the forsaken changes when a migration runs, never while a
  // viking is typing, so one read serves every verb for a minute. That also
  // caps what an ordinary sentence can cost: `@Eilif tell me about Bonemass`
  // parses as a retell of a boss nobody has, and without this each one would
  // spend its own service-role query before answering "I do not know that one".
  const BOSS_CACHE_MS = 60_000;
  let bossCache = { at: 0, rows: null };

  async function fetchBosses() {
    if (bossCache.rows && Date.now() - bossCache.at < BOSS_CACHE_MS) return bossCache.rows;
    const { data, error } = await db.from('bosses').select('id, name, sort_order').order('sort_order');
    if (error) throw new Error(`bosses query: ${error.message}`);
    bossCache = { at: Date.now(), rows: data ?? [] };
    return bossCache.rows;
  }

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

  function nameTheEight(bosses) {
    const names = bosses.map((b) => b.name).filter(Boolean);
    return names.length ? names.join(', ') : 'none that I can read just now';
  }

  async function queueVoiceLine(text, meta) {
    const { error } = await db.from('voice_lines').insert({
      text,
      kind: 'event',
      meta,
      status: 'queued',
      queued_at: new Date().toISOString(),
    });
    // The telling is already recorded; a voice line that will not queue is
    // worth a journal line and nothing more.
    if (error) log.warn?.(`[tellings] voice line not queued: ${error.message}`);
    return !error;
  }

  async function handleRetell({ message, boss, cmd }) {
    const left = cooldownLeftMs(message.author.id);
    if (left > 0) {
      await reply(
        message,
        'Your last telling is still fresh in the hall. Let it settle a few minutes, then tell another.',
      );
      return;
    }

    const clean = cleanTellingText(cmd.text);
    if (!clean) {
      await reply(
        message,
        `A telling needs words. Try \`@Eilif retell ${boss.name}: how the fight really went\`.`,
      );
      return;
    }

    const { notReady, player } = await resolveSenderPlayer(message.author.id);
    if (notReady) {
      await reply(message, NOT_READY);
      return;
    }
    if (!player) {
      await reply(message, NOT_KNOWN);
      await message.react('❓').catch(() => {});
      return;
    }

    const added = await addTelling(db, {
      bossId: boss.id,
      author: player.character_name,
      discordId: message.author.id,
      text: clean,
      source: 'player',
    });
    if (added.notReady) {
      await reply(message, NOT_READY);
      return;
    }
    rememberTell(message.author.id);

    // The telling is already stored and the cooldown already spent, so nothing
    // from here on may cost the viking their reply. A swap that fails leaves
    // the boss with rows and no chosen one, and the war room falls back to the
    // newest, which is this telling — so the page is right either way and only
    // the wording of the confirmation changes.
    let chosen = false;
    if (added.id) {
      try {
        const res = await setChosen(db, boss.id, added.id);
        chosen = res.ok;
      } catch (e) {
        log.warn?.(`[tellings] telling ${added.id} was stored but not chosen: ${e.message}`);
      }
    }

    await replyEmbed(message, {
      title: `A new telling of ${cleanName(boss.name, 40)}`,
      description:
        `**${nameMd(player.character_name)}** told it, and ${
          chosen ? 'it now stands on the war room page' : 'it is filed with the others'
        }.\n\n_${safeText(clean, 200)}_`,
      color: GOLD,
      footer: { text: 'See them all with: @Eilif tellings <Boss>' },
    });
    await message.react('📜').catch(() => {});

    await queueVoiceLine(tellingVoiceLine(player.character_name, boss.name, added.id), {
      source: 'telling',
      telling_id: added.id,
      boss: boss.name,
      by: player.character_name,
    });

    log.info?.(
      `[tellings] ${player.character_name} retold ${boss.name}: ${clean.slice(0, 60)}`,
    );
  }

  async function handleList({ message, boss }) {
    const { notReady, rows } = await listTellings(db, boss.id);
    if (notReady) {
      await reply(message, NOT_READY);
      return;
    }
    if (!rows.length) {
      await reply(
        message,
        `No one has told the fall of ${replySafeName(boss.name)} yet. Be the first: ` +
          `\`@Eilif retell ${boss.name}: your telling\`.`,
      );
      return;
    }
    await replyEmbed(message, renderTellingList(boss.name, rows));
  }

  async function handleKeep({ message, boss, cmd }) {
    const { notReady, rows } = await listTellings(db, boss.id);
    if (notReady) {
      await reply(message, NOT_READY);
      return;
    }
    const row = rows[cmd.index - 1];
    if (!row) {
      await reply(
        message,
        rows.length
          ? `There are ${rows.length} tellings of ${replySafeName(boss.name)}. Name one of them, from 1 to ${rows.length}.`
          : `No one has told the fall of ${replySafeName(boss.name)} yet.`,
      );
      return;
    }
    if (!mayKeepTelling(message.member, row, { guildId, adminRoleIds })) {
      await reply(
        message,
        'Only the viking who told it, or a jarl of this hall, may choose which telling stands.',
      );
      return;
    }
    let res;
    try {
      res = await setChosen(db, boss.id, row.id);
    } catch (e) {
      // Answer the viking rather than falling through to the handler's catch,
      // which would log and leave the message unanswered.
      log.warn?.(`[tellings] could not choose telling ${row.id}: ${e.message}`);
      await reply(message, 'That telling could not be set just now. Try again in a moment.');
      return;
    }
    if (res.notReady) {
      await reply(message, NOT_READY);
      return;
    }
    if (!res.ok) {
      await reply(
        message,
        'Another telling was chosen at the same moment. Look again with `@Eilif tellings ' +
          `${replySafeName(boss.name)}\`.`,
      );
      return;
    }
    await reply(
      message,
      `Telling ${cmd.index} of ${replySafeName(boss.name)}, by ${replySafeName(tellingAuthor(row))}, now stands on the war room page.`,
    );
    await message.react('📜').catch(() => {});
    log.info?.(`[tellings] ${message.author.id} chose telling ${row.id} for ${boss.name}`);
  }

  async function handleMessage(message) {
    try {
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user, MENTION_STRICT)) return;
      if (!message.guild) return;
      if (guildId && message.guildId !== guildId) return;

      const cmd = parseTellings(message.content, client.user.id);
      if (!cmd) return;

      const bosses = await fetchBosses();
      const match = matchBoss(cmd.boss, bosses);
      if (match.status === 'ambiguous') {
        await reply(
          message,
          // Each name is made safe on its OWN. replySafeName caps at 32
          // characters (Discord's nickname limit), so running it over the
          // joined list would cut the sentence mid-name and invent a forsaken
          // who does not exist: "Bonemass or Moder or Forsaken VI".
          `More than one of the forsaken answers to that. Did you mean ${match.candidates
            .map(replySafeName)
            .join(' or ')}?`,
        );
        return;
      }
      if (!match.boss) {
        await reply(
          message,
          `I do not know that one. The forsaken are: ${nameTheEight(bosses)}. ` +
            'Name one of them, like `@Eilif retell Bonemass: your telling`.',
        );
        return;
      }

      if (cmd.verb === 'retell') await handleRetell({ message, boss: match.boss, cmd });
      else if (cmd.verb === 'list') await handleList({ message, boss: match.boss });
      else if (cmd.verb === 'keep') await handleKeep({ message, boss: match.boss, cmd });
    } catch (e) {
      log.error?.(`[tellings] ${e.message}`);
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
    log.info?.(
      '[tellings] active: `@Eilif retell <Boss>: <text>`, `@Eilif tellings <Boss>`, `@Eilif keep <Boss> <n>`',
    );
  }

  return { attach, handleMessage, _cooldownLeftMs: cooldownLeftMs, _rememberTell: rememberTell };
}
