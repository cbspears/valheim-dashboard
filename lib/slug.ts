// Canonical URL slugs — the ONE place viking/boss names become paths, so
// links from the roster, war-rooms, episodes, and timeline never drift.

import type { Boss } from './types';

interface NamedRosterEntry {
  character_name: string;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "Astrid Shieldmaiden" -> /viking/astrid-shieldmaiden */
export const vikingPath = (characterName: string) => `/viking/${slugify(characterName)}`;

/** "The Elder" -> /boss/the-elder */
export const bossPath = (bossName: string) => `/boss/${slugify(bossName)}`;

/**
 * Some surfaces (the client-mod's `gs_stats.bossDamage`) name a boss with a
 * raw prefab-ish token ("$enemy_bonemass") rather than its display name, so a
 * blind `bossPath(raw)` can 404. Resolve against the real `bosses` table by
 * slug first; only link when it actually matches a known forsaken.
 */
export function matchBossName(raw: string | null | undefined, bosses: Boss[]): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const target = slugify(trimmed);
  const hit = bosses.find((b) => slugify(b.name) === target);
  return hit?.name ?? null;
}

/**
 * Credits like a gallery photo's "posted by" or a boss depiction's poster
 * arrive as a Discord display name, which doesn't always match a viking's
 * in-game `character_name` exactly. Resolve loosely (exact name first, then
 * first-token) the same way the viking page attributes photos to a viking —
 * only link when we're reasonably sure, so we never send someone to a 404.
 */
export function matchVikingName(
  raw: string | null | undefined,
  roster: NamedRosterEntry[]
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  const exact = roster.find((p) => p.character_name.trim().toLowerCase() === lower);
  if (exact) return exact.character_name;

  const token = lower.split(/\s+/)[0];
  if (!token) return null;
  const hit = roster.find(
    (p) => p.character_name.trim().split(/\s+/)[0]?.toLowerCase() === token
  );
  return hit?.character_name ?? null;
}
