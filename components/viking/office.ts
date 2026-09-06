// Pure helpers for hall offices on the site. No React, no Supabase, so
// scripts/offices-site.test.mjs can drive them directly.
//
// One read (lib/data.ts getOffices) answers three questions: who holds the
// office now, whether THIS viking holds it, and whether they held it before.
// Doing it here rather than in two queries means a viking page can never render
// "Storyteller of Eilif" beside a war-room that names someone else.

import type { Office } from '@/lib/types';

export const STORYTELLER = 'storyteller';

/** Case- and space-insensitive name key, mirroring the bot's own. */
function key(name: string | null | undefined): string {
  return String(name ?? '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * The open term, or null when the office is vacant.
 *
 * `until == null` is the whole test, because that is what the database's
 * partial unique index enforces: at most one row per office can carry it. Rows
 * arrive newest first, so the `find` picks the newest of a pair that should not
 * exist anyway rather than an arbitrary one.
 */
export function currentOffice(offices: Office[], office: string = STORYTELLER): Office | null {
  if (!Array.isArray(offices)) return null;
  return offices.find((o) => o?.office === office && o?.until == null) ?? null;
}

/** The current holder's character name, or null. */
export function currentHolder(offices: Office[], office: string = STORYTELLER): string | null {
  const held = currentOffice(offices, office);
  const name = (held?.holder_character ?? '').trim();
  return name || null;
}

/**
 * What to show beside a viking's epithet, or null when they have never held the
 * office.
 *
 * NOT AN EPITHET DIMENSION. lib/epithets.ts assigns one unique title per viking
 * from what they DO, and adding an office to that engine would let holding a
 * seat displace a title someone earned by dying to trolls. This sits beside the
 * epithet as a separate fact, and the epithet is untouched.
 *
 * A past term reads by its act ("Storyteller for the Bonemass act") because
 * that is how a hall remembers when something was, and falls back to a plain
 * line when the act was never recorded.
 */
export function officeLabelFor(
  offices: Office[],
  characterName: string | null | undefined,
  office: string = STORYTELLER,
): string | null {
  const want = key(characterName);
  if (!want || !Array.isArray(offices)) return null;

  const mine = offices.filter((o) => o?.office === office && key(o?.holder_character) === want);
  if (mine.length === 0) return null;

  if (mine.some((o) => o.until == null)) return 'Storyteller of Eilif';

  // Newest closed term wins: a viking who held the office twice is described by
  // the one the hall remembers most recently.
  const latest = [...mine].sort(
    (a, b) => Date.parse(b.since ?? '') - Date.parse(a.since ?? ''),
  )[0];
  const act = (latest?.act ?? '').trim();
  return act ? `Storyteller for the ${act} act` : 'Storyteller of Eilif, in an earlier act';
}
