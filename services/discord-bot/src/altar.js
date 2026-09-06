// Altar tellings: the hall speaks a boss's saga where the boss actually fell.
//
// When a forsaken goes down, /api/gs-ingest drops one pin of kind 'boss' at the
// centroid of the war party (app/api/gs-ingest/route.ts, always on, harmless
// data). This loop is what makes that pin mean something: a viking who walks
// back within forty metres of an altar whose boss has a chosen telling hears
// the opening line of that telling, and who told it.
//
// PRIVATE BY CONSTRUCTION. A telling read out to the whole server because one
// person wandered past an altar is noise, and worse, it is noise attributed to
// nobody in particular. So the line carries `meta.target` and is queued ONLY
// when the plugin can aim a line at one peer (VOICE_TARGETING=1). With
// targeting off this loop enqueues NOTHING at all rather than broadcasting; it
// says which of the two it is doing once, at startup, and then stays quiet.
//
// OFF BY DEFAULT. index.js only builds this when ALTAR_TELLINGS=1. The pin at
// the kill is the only always-on half.
//
// Reads: `pins`, `bosses`, `boss_tellings`, `player_positions`, `players`.
// Writes: one `voice_lines` row per telling spoken, and the bounded memory in
// state.json that stops the same viking hearing the same altar twice a day.

import { serviceClient } from './supabase.js';
import { clipChars } from './format.js';
import { ALTAR_TELLING_TAILS } from './voice.js';

/**
 * The pin kind the ingest writes and this loop reads. 'boss' is the vocabulary
 * lib/types.ts PinKind already names.
 */
export const ALTAR_PIN_KIND = 'boss';
/**
 * How an altar pin is named. MUST match lib/altar.ts altarPinName, which is
 * what actually writes the row; scripts/altar.test.mjs reads that file and
 * fails if the two ever drift.
 *
 * Not the bare boss name, deliberately. The `pin` branch of /api/webhook
 * REPLACES a pin by name (`delete ... ilike name`), so an altar called
 * "Bonemass" would be silently deleted the first time a viking shouted
 * `/pin Bonemass` at the spot, and the boss is already dead so nothing would
 * ever put it back.
 */
export const ALTAR_PIN_SUFFIX = ' altar';
/** Close enough to be standing at the altar rather than sailing past it. */
export const ALTAR_RADIUS_M = 40;
/** A position older than this is not where the viking is, it is where they were. */
export const POSITION_FRESH_MS = 90_000;
/** The same viking, the same altar, at most once a day. */
export const ALTAR_QUIET_MS = 24 * 3600 * 1000;
/** How much of the telling is spoken. The rest is on the war room page. */
export const FIRST_SENTENCE_MAX = 120;
/**
 * The ceiling on the WHOLE spoken line, tail included.
 *
 * The same 150 every other in-game pool in voice.js keeps, and it has to be
 * enforced on the composed string rather than on its halves: 120 characters of
 * telling plus "That is <a thirty-two character name> speaking. The rest is on
 * the page." is 196, which is a line running off the bottom of the screen. The
 * tail is never cut (it names the teller, which is the point of the line), so
 * the opening yields the room.
 */
export const ALTAR_LINE_MAX = 150;
/**
 * Bounded memory, oldest first, the rule relay.js and identity.js already use.
 * Ten times the player cap times a handful of altars.
 */
export const ALTAR_MEMORY_MAX = 200;

/** "Bonemass" to "Bonemass altar". */
export function altarPinName(bossName) {
  const clean = String(bossName ?? '').trim();
  return clean ? `${clean}${ALTAR_PIN_SUFFIX}` : '';
}

/** "Bonemass altar" back to "Bonemass", or null when it is not an altar pin. */
export function bossNameFromAltarPin(pinName) {
  const clean = String(pinName ?? '').trim();
  if (!clean.toLowerCase().endsWith(ALTAR_PIN_SUFFIX)) return null;
  const name = clean.slice(0, -ALTAR_PIN_SUFFIX.length).trim();
  return name || null;
}

/** Metres between two world points. Valheim's world is flat for this purpose. */
export function metresBetween(a, b) {
  const ax = Number(a?.x);
  const az = Number(a?.z);
  const bx = Number(b?.x);
  const bz = Number(b?.z);
  if (![ax, az, bx, bz].every(Number.isFinite)) return Infinity;
  return Math.hypot(ax - bx, az - bz);
}

/**
 * The first sentence of a telling, ready to be spoken.
 *
 * Cut at the first sentence end, so the hall hears a whole thought rather than
 * a hundred and twenty characters of one. A telling with no sentence end inside
 * the window (one long run-on, which players write) is clipped with an ellipsis
 * instead, because a spoken line has to end somewhere. Pure.
 */
export function firstSentence(text, max = FIRST_SENTENCE_MAX) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  const end = flat.slice(0, max + 1).search(/[.!?](\s|$)/);
  if (end >= 0) return flat.slice(0, end + 1).trim();
  if (flat.length <= max) return flat;
  // clipChars, not slice: a code-unit cut can strand a lone surrogate, and this
  // string goes into a JSON insert body (the same reason every cap in format.js
  // moved off slice).
  return `${clipChars(flat, max - 1)}…`;
}

// Small, pure 31-multiplier string hash, stable across runs. Mirrors format.js,
// tellings.js and storyteller.js.
function hashString(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** "Bren Bjornsson" to "Bren"; 'The Skald' stays whole. */
function tellerName(name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'whoever was there';
  if (/^the\b/i.test(clean)) return clipChars(clean, 32);
  return clipChars(clean.split(' ')[0], 32);
}

/**
 * The whole spoken line: the opening of the telling, then who told it.
 * Pure and seeded, so the same viking at the same altar hears the same line if
 * they come back a day later, and two altars do not both use the same tail.
 *
 * NEVER LONGER THAN ALTAR_LINE_MAX. The opening is re-cut to whatever the tail
 * leaves it, because the two pieces are chosen independently and the sum of
 * their own caps is well over the ceiling. The floor keeps a pathological tail
 * from squeezing the telling down to nothing, and the final clip makes the cap
 * a property of this function rather than of the pool it happens to draw from.
 */
export function altarLine(tellingText, author, seed = null) {
  const opening = firstSentence(tellingText);
  if (!opening) return '';
  const key = seed ?? `${author}|${opening}`;
  const tail = ALTAR_TELLING_TAILS[hashString(key) % ALTAR_TELLING_TAILS.length].replace(
    /\{teller\}/g,
    () => tellerName(author),
  );
  const room = Math.max(24, ALTAR_LINE_MAX - tail.length - 1);
  const cut = opening.length <= room ? opening : `${clipChars(opening, room - 1)}…`;
  return clipChars(`${cut} ${tail}`, ALTAR_LINE_MAX);
}

/** The memory key for one viking at one altar. */
export function altarKey(characterName, pinId) {
  return `${String(characterName ?? '').toLowerCase().trim()}|${pinId}`;
}

/** True when this viking has not been told at this altar inside the quiet window. */
export function altarIsDue(memory, key, nowMs = Date.now(), quietMs = ALTAR_QUIET_MS) {
  const at = Date.parse(memory?.[key] ?? '');
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= quietMs;
}

/**
 * Remember that this viking heard this altar, and keep the memory bounded.
 * Oldest first, the same eviction rule identity.js and tellings.js use: object
 * keys iterate in insertion order and every hit is re-inserted, so the front is
 * the least recently spoken. Mutates and returns `memory`.
 */
export function rememberAltar(memory, key, nowMs = Date.now(), max = ALTAR_MEMORY_MAX) {
  delete memory[key]; // re-insert at the back
  memory[key] = new Date(nowMs).toISOString();
  const keys = Object.keys(memory);
  for (let i = 0; keys.length - i > max; i++) delete memory[keys[i]];
  return memory;
}

/**
 * Who is standing at an altar and owed its telling, right now.
 *
 * Pure: everything it needs is passed in, so the whole selection rule is
 * testable without a clock, a database or a gateway.
 *
 *   altars    [{ id, name, bossId, x, z }]         boss pins, world coordinates
 *   positions [{ character_name, x, z, updated_at }]
 *   online    Set or array of the character names actually in the realm
 *   tellings  Map/object of bossId -> { text, author }
 *
 * One viking gets at most ONE line per pass, at the NEAREST qualifying altar:
 * two altars within forty metres of each other is a strange world, but a viking
 * hearing two sagas at once is a bug in any world.
 */
export function altarCandidates({
  altars = [],
  positions = [],
  online = [],
  tellings = {},
  memory = {},
  nowMs = Date.now(),
  radius = ALTAR_RADIUS_M,
  freshMs = POSITION_FRESH_MS,
  quietMs = ALTAR_QUIET_MS,
} = {}) {
  const onlineSet = new Set(
    (online instanceof Set ? [...online] : online || []).map((n) => String(n).toLowerCase().trim()),
  );
  const out = [];

  for (const pos of positions || []) {
    const name = String(pos?.character_name ?? '').trim();
    if (!name || !onlineSet.has(name.toLowerCase())) continue;
    const at = Date.parse(pos?.updated_at ?? '');
    if (!Number.isFinite(at) || nowMs - at > freshMs) continue;
    // A position stamped in the future is a producer clock problem, not a
    // viking standing at an altar tomorrow; treat it as unusable.
    if (at - nowMs > freshMs) continue;

    let best = null;
    for (const altar of altars || []) {
      const telling = tellings?.[altar?.bossId];
      if (!telling?.text) continue;
      const distance = metresBetween(pos, altar);
      if (distance > radius) continue;
      if (!altarIsDue(memory, altarKey(name, altar.id), nowMs, quietMs)) continue;
      if (!best || distance < best.distance) best = { altar, telling, distance };
    }
    if (best) out.push({ character: name, ...best });
  }

  // Deterministic order, so a tick that is cut short does the same work twice
  // rather than a different half each time.
  return out.sort((a, b) => a.character.toLowerCase().localeCompare(b.character.toLowerCase()));
}

// ── the loop ──────────────────────────────────────────────────────────────

export function createAltarTellings({
  db: injectedDb,
  state,
  saveState,
  log = console,
  radius = ALTAR_RADIUS_M,
}) {
  const db = injectedDb ?? serviceClient();
  const targeting = () => process.env.VOICE_TARGETING === '1';

  function memory() {
    if (!state.altar || typeof state.altar !== 'object') state.altar = {};
    if (!state.altar.told || typeof state.altar.told !== 'object') state.altar.told = {};
    return state.altar.told;
  }

  async function enqueue(text, meta) {
    const { error } = await db.from('voice_lines').insert({
      text,
      kind: 'event',
      meta,
      status: 'queued',
      queued_at: new Date().toISOString(),
    });
    if (error) log.warn?.(`[altar] voice line not queued: ${error.message}`);
    return !error;
  }

  /** The boss altars on the map, resolved to the boss they belong to. */
  async function readAltars() {
    const { data, error } = await db
      .from('pins')
      .select('id, name, world_x, world_z')
      .eq('kind', ALTAR_PIN_KIND)
      .limit(50);
    if (error) throw new Error(`altar pins: ${error.message}`);
    return data ?? [];
  }

  async function readChosenTellings() {
    const { data, error } = await db
      .from('boss_tellings')
      .select('boss_id, text, author_character, source')
      .eq('chosen', true)
      .limit(50);
    if (error) {
      // Before db/2026-09-06_boss_tellings.sql there are no tellings to speak,
      // which is a quiet loop rather than a failing one.
      if (error.code === '42P01' || error.code === 'PGRST205') return null;
      throw new Error(`chosen tellings: ${error.message}`);
    }
    return data ?? [];
  }

  async function tick(nowMs = Date.now()) {
    // The hard gate. Without targeting this line would be spoken to the whole
    // server, which is the wrong message entirely, so the loop does nothing.
    if (!targeting()) return 0;

    const altarRows = await readAltars();
    if (altarRows.length === 0) return 0;

    const chosen = await readChosenTellings();
    if (!chosen || chosen.length === 0) return 0;

    const { data: bossRows, error: bossErr } = await db.from('bosses').select('id, name');
    if (bossErr) throw new Error(`bosses: ${bossErr.message}`);
    const bossIdByName = new Map(
      (bossRows ?? []).map((b) => [String(b.name ?? '').toLowerCase().trim(), b.id]),
    );

    const altars = altarRows
      .map((p) => {
        const bossName = bossNameFromAltarPin(p.name);
        const bossId = bossName ? bossIdByName.get(bossName.toLowerCase()) : null;
        return bossId ? { id: p.id, name: p.name, bossId, x: p.world_x, z: p.world_z } : null;
      })
      .filter(Boolean);
    if (altars.length === 0) return 0;

    const tellings = {};
    for (const row of chosen) {
      if (!row?.boss_id || !row?.text) continue;
      tellings[row.boss_id] = {
        text: row.text,
        author: row.source === 'skald' ? 'The Skald' : row.author_character,
      };
    }

    const freshSince = new Date(nowMs - POSITION_FRESH_MS).toISOString();
    const [posRes, onlineRes] = await Promise.all([
      db.from('player_positions').select('character_name, x, z, updated_at').gte('updated_at', freshSince),
      db.from('players').select('character_name').eq('is_online', true),
    ]);
    if (posRes.error) throw new Error(`player positions: ${posRes.error.message}`);
    if (onlineRes.error) throw new Error(`online roster: ${onlineRes.error.message}`);

    const told = memory();
    const due = altarCandidates({
      altars,
      positions: posRes.data ?? [],
      online: (onlineRes.data ?? []).map((p) => p.character_name).filter(Boolean),
      tellings,
      memory: told,
      nowMs,
      radius,
    });
    if (due.length === 0) return 0;

    let spoken = 0;
    for (const c of due) {
      const line = altarLine(c.telling.text, c.telling.author, `${c.character}|${c.altar.id}`);
      if (!line) continue;
      // Remembered BEFORE the write, so a queue that fails cannot make the same
      // viking hear the same altar again on the next tick sixty seconds later.
      // A missed telling is a small loss; a stutter at the altar is not.
      rememberAltar(told, altarKey(c.character, c.altar.id), nowMs);
      const ok = await enqueue(line, {
        source: 'altar_telling',
        target: c.character,
        pin: c.altar.name,
        boss_id: c.altar.bossId,
        metres: Math.round(c.distance),
      });
      if (ok) spoken += 1;
    }
    await saveState();
    if (spoken) log.info?.(`[altar] spoke ${spoken} telling(s) at an altar`);
    return spoken;
  }

  return { tick, _memory: memory };
}
