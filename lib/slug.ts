// Canonical URL slugs — the ONE place viking/boss names become paths, so
// links from the roster, war-rooms, episodes, and timeline never drift.

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
