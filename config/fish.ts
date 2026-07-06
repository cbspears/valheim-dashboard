// Fish prefab id -> display-name map. Purely data — edit this file to rename
// a species or add one that turns up in a live payload; nothing else needs to
// change. Follows the `config/mods.ts` pattern (no DB, dashboard reads it directly).
//
// ⚠️ NOT yet verified against a live GsValheimStatsClient payload. Best-effort
// mapping from the vanilla Valheim fish prefabs as of 2026-07-05 — `lib/gs-client.ts`
// logs any unrecognized `Fish*`-shaped pickup id at info level so gaps here
// self-report once someone actually fishes on the test world. Update freely.

/** Fish prefab id (as it appears in `pickups[].item`) -> display name. */
export const FISH: Record<string, string> = {
  Fish1: 'Perch',
  Fish2: 'Pike',
  Fish3: 'Tuna',
  Fish4_cave: 'Tetra',
  Fish5: 'Trollfish',
  Fish6: 'Giant Herring',
  Fish7: 'Grouper',
  Fish8: 'Coral Cod',
  Fish9: 'Anglerfish',
  Fish10: 'Northern Salmon',
  Fish11: 'Pufferfish',
  Fish12: 'Magmafish',
};

/** Prettify a fish prefab id for display, falling back to the raw id. */
export function fishName(id: string): string {
  return FISH[id] ?? id;
}
