// Valheim creature localization token / prefab name -> display name.
//
// Death reports name their killer with the creature's `Character.m_name`, which
// in vanilla Valheim is a LOCALIZATION TOKEN, not a readable name — the game
// itself renders it through `Localization.Localize(m_name)` (verified against
// `Character.GetHoverName()` in assembly_valheim 0.221.12). Mods and the
// third-party GsValheimStatsClient sometimes send the readable name or the
// prefab clone name instead. `humanizeKiller()` in lib/deaths.ts strips the
// `$enemy_` / `(Clone)` noise and then looks the remainder up HERE, so all
// three spellings of the same creature land on one display name:
//
//   "$enemy_serpent"   ─┐
//   "Serpent(Clone)"    ├─→  "Serpent" (one bucket with the gs producer; HowWeDie renders the label)
//   "serpent"          ─┘
//
// Purely data, same doctrine as config/fish.ts: edit this file to rename a
// creature or add one that turns up in a live payload; nothing else changes.
// An UNMAPPED key is never dropped and never rendered raw — it falls back to
// the capitalized stripped token ("greydwarfbrute" -> "Greydwarfbrute"), so a
// creature missing from this map is visible (and obviously in need of an
// entry) rather than silently lost.
//
// Keys are lowercase, post-strip. Boss display names deliberately match
// lib/episodes.ts BOSSES ("the elder", "moder", "yagluth", "the queen",
// "fader", "eikthyr", "bonemass") so a boss death phrases as "felled by The
// Elder" rather than "taken by a The Elder".

/** Lowercased, `$enemy_`-stripped creature token -> display name. */
export const CREATURES: Record<string, string> = {
  // ── Meadows ────────────────────────────────────────────────────────────────
  boar: 'Boar',
  deer: 'Deer',
  neck: 'Neck',
  greyling: 'Greyling',

  // ── Black Forest ───────────────────────────────────────────────────────────
  greydwarf: 'Greydwarf',
  greydwarfbrute: 'Greydwarf Brute',
  greydwarfshaman: 'Greydwarf Shaman',
  skeleton: 'Skeleton',
  ghost: 'Ghost',
  troll: 'Troll',

  // ── Swamp ──────────────────────────────────────────────────────────────────
  draugr: 'Draugr',
  draugrelite: 'Draugr Elite',
  blob: 'Blob',
  blobelite: 'Oozer',
  leech: 'Leech',
  wraith: 'Wraith',
  surtling: 'Surtling',
  abomination: 'Abomination',

  // ── Mountain ───────────────────────────────────────────────────────────────
  wolf: 'Wolf',
  fenring: 'Fenring',
  fenringcultist: 'Cultist',
  hatchling: 'Drake',
  stonegolem: 'Stone Golem',
  ulv: 'Ulv',
  bat: 'Bat',

  // ── Plains ─────────────────────────────────────────────────────────────────
  goblin: 'Fuling',
  goblinbrute: 'Fuling Berserker',
  goblinshaman: 'Fuling Shaman',
  lox: 'Lox',
  deathsquito: 'Deathsquito',
  growth: 'Growth',

  // ── Ocean ──────────────────────────────────────────────────────────────────
  serpent: 'Serpent',

  // ── Mistlands ──────────────────────────────────────────────────────────────
  seeker: 'Seeker',
  seekerbrute: 'Seeker Soldier',
  seekerbrood: 'Seeker Brood',
  gjall: 'Gjall',
  tick: 'Tick',
  dvergr: 'Dvergr',
  dvergrrogue: 'Dvergr Rogue',
  dvergrmage: 'Dvergr Mage',
  hare: 'Hare',

  // ── Ashlands ───────────────────────────────────────────────────────────────
  // Token spellings here are best-effort (the crew has not reached Ashlands on
  // Eilif yet, so none of these has been seen in a live payload). Anything wrong
  // simply falls back to the capitalized token and can be corrected in place.
  asksvin: 'Asksvin',
  morgen: 'Morgen',
  volture: 'Volture',
  charred_melee: 'Charred Warrior',
  charred_archer: 'Charred Marksman',
  charred_mage: 'Charred Warlock',
  charredmelee: 'Charred Warrior',

  // ── The Forsaken (bosses) ──────────────────────────────────────────────────
  eikthyr: 'Eikthyr',
  gdking: 'The Elder',
  bonemass: 'Bonemass',
  dragon: 'Moder',
  goblinking: 'Yagluth',
  seekerqueen: 'The Queen',
  fader: 'Fader',
};

/** Capitalize the first letter — the honest fallback for an unmapped token. */
export function capitalizeCreature(raw: string): string {
  return raw.length ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
}

/** Display name for a lowercased, stripped creature token (null if unmapped).
 *  hasOwnProperty, not a bare index — a token spelling an Object.prototype
 *  member ("constructor") must read as unmapped, not as an inherited function. */
export function creatureName(strippedLower: string): string | null {
  return Object.prototype.hasOwnProperty.call(CREATURES, strippedLower)
    ? CREATURES[strippedLower]
    : null;
}
