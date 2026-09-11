// The bot's half of "does this character belong on a public board?".
//
// A MIRROR OF lib/excluded.ts, not an import: this service is plain ESM JavaScript
// and the site's rule lives in TypeScript under a Next.js path alias, so there is
// no way to require it. The two files must therefore be kept in step by hand —
// same rule, same fallback, same name folding.
//
// THE RULE. A character is excluded when the database flag says so
// (`players.excluded === true`, db/2026-09-11_players_excluded.sql) OR when its
// name is on the fallback list. Either signal alone is decisive, which is what
// makes the rollout safe in any order: the flag is authoritative once the
// migration is applied, and the name list works before it is — and works at the
// many bot reads that never touch `players` at all (sessions, events and every
// per-name tally are keyed by `character_name`).
//
// THE LIST. `EXCLUDED_CHARACTER_NAMES` in the bot's .env, a comma-separated list,
// defaulting to the same value as config/server.ts. Change it in both places, then
//   sudo systemctl restart eilif-discord-bot
// Read once at import: the bot is a long-running process restarted on config
// changes anyway, and re-reading per tick would make the boards depend on when a
// tick happened to fire.

const DEFAULT_EXCLUDED = ['Steward'];

/** Trimmed + case-folded, the same comparison key lib/excluded.ts uses. */
function nameKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

function loadNames() {
  const raw = process.env.EXCLUDED_CHARACTER_NAMES;
  // An UNSET var means "use the default". An explicitly EMPTY var means "exclude
  // nobody" — a deliberate, greppable way to turn the whole mechanism off without
  // editing code, and distinct from forgetting to set it.
  const list = raw === undefined ? DEFAULT_EXCLUDED : String(raw).split(',');
  return new Set(list.map(nameKey).filter(Boolean));
}

// Resolved on FIRST USE rather than at import, so a test (or a boot sequence that
// loads dotenv after the module graph) still sees the env it set. Cached after
// that: see the note above about ticks not deciding what the boards show.
let cachedKeys = null;
function keys() {
  if (!cachedKeys) cachedKeys = loadNames();
  return cachedKeys;
}

/** Drop the memoized list — for tests that vary EXCLUDED_CHARACTER_NAMES. */
export function resetExcludedCache() {
  cachedKeys = null;
}

/** The configured names (folded), for logging and the ops heartbeat. */
export function excludedNames() {
  return [...keys()];
}

/** Is this character name on the fallback list? Blank is never excluded. */
export function isExcludedName(name) {
  const key = nameKey(name);
  return key !== '' && keys().has(key);
}

/**
 * Is this row excluded? `excluded === true` OR a listed name.
 *
 * Deliberately NOT `!== false`: a row read without the column — every select that
 * does not ask for it, and every read at all before the migration lands — carries
 * `undefined`, and treating that as excluded would empty every board.
 */
export function isExcluded(row) {
  if (!row) return false;
  if (row.excluded === true) return true;
  return isExcludedName(row.character_name ?? row.name);
}

/** Drop every excluded row, preserving order. */
export function filterExcluded(rows) {
  return (rows || []).filter((r) => !isExcluded(r));
}

/**
 * Strip excluded names out of a plain { name: value } tally, returning a new
 * object. The bot builds these everywhere — hours, deaths, kill deltas, crafts —
 * and they are the input to the recap boards and the Player-of-the-Day draw.
 */
export function withoutExcluded(tally) {
  const out = {};
  for (const [name, value] of Object.entries(tally || {})) {
    if (isExcludedName(name)) continue;
    out[name] = value;
  }
  return out;
}
