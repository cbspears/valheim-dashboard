/**
 * The Get Started spine, as data.
 *
 * The page is one task ordered by time, numbered once, with a finish line in
 * the middle of it. Three facts about that shape are referred to from more than
 * one place, so they live here rather than being retyped:
 *
 *   - there are seven steps, and every step's eyebrow says which one it is;
 *   - joining is step five, and the server info card names that number in its
 *     own title, so the two cannot drift apart;
 *   - the Mac mod checklist is derived from `config/mods.ts`, never retyped, so
 *     a pack re-mint changes one file and the checklist follows.
 *
 * Everything here is pure. Nothing reads the network, the database or the
 * filesystem, and the two localStorage helpers are the only functions that
 * touch a browser API at all (both inside try/catch, both safe to call on a
 * server, where they no-op). Covered by `scripts/get-started.test.mjs`.
 */

/* ── the spine ─────────────────────────────────────────────────────────── */

/** How many numbered steps the get-in-tonight path has. One spine, one count. */
export const TOTAL_STEPS = 7;

/**
 * Joining is step five on every platform. The Mac path and the r2modman path
 * differ only in steps one to four; from the join onwards the page is shared,
 * which is what lets the server info card carry one number in its title.
 */
export const JOIN_STEP = 5;

/** The eyebrow above every step heading: "Step 3 of 7". */
export function stepLabel(n: number): string {
  return `Step ${n} of ${TOTAL_STEPS}`;
}

/**
 * The server info card's heading. It used to sit at the top of the page, where
 * the first control a newcomer could touch was the address, which is the one
 * thing they must not use before the mods are installed. It now sits under the
 * join step and says so.
 */
export const SERVER_INFO_TITLE = `Server info (you need this at step ${JOIN_STEP})`;

/* ── the platform chooser ──────────────────────────────────────────────── */

/**
 * One name per platform, used everywhere. The chooser used to shorten the Linux
 * button to "Linux / Deck" below `lg` while keeping "Linux and Steam Deck" as
 * its accessible name, which is a WCAG 2.5.3 failure: voice control cannot
 * address a button whose visible words are not in its name. One name is also
 * one fewer string to keep in step with the steps it selects.
 */
export const PLATFORMS = [
  { id: 'windows', name: 'Windows' },
  { id: 'linux', name: 'Linux and Steam Deck' },
  { id: 'mac', name: 'Mac' },
] as const;

export type PlatformId = (typeof PLATFORMS)[number]['id'];

/** A chooser value: one platform, or the escape hatch that shows all three. */
export type PlatformChoice = PlatformId | 'all';

/**
 * Windows, because it is what most of the warband plays and because a chooser
 * that opens on nothing is a chooser nobody notices. The Mac fork is one click
 * away and the "show all platforms" escape is under it.
 */
export const DEFAULT_PLATFORM: PlatformChoice = 'windows';

export const PLATFORM_STORAGE_KEY = 'eilif:get-started:platform';

export function isPlatformChoice(value: unknown): value is PlatformChoice {
  return value === 'all' || PLATFORMS.some((p) => p.id === value);
}

export function platformName(choice: PlatformChoice): string {
  return PLATFORMS.find((p) => p.id === choice)?.name ?? 'All platforms';
}

/**
 * The remembered choice, or null. Wrapped because localStorage throws outright
 * in a private window with site data blocked, and because it does not exist at
 * all while this module is being rendered on the server.
 */
export function readStoredPlatform(): PlatformChoice | null {
  try {
    const raw = window.localStorage.getItem(PLATFORM_STORAGE_KEY);
    return isPlatformChoice(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Remember an explicit choice. Silent when storage is unavailable.
 *
 * "Show all platforms" is deliberately NOT remembered. It is a momentary escape
 * hatch, and writing it over the reader's platform meant that leaving it again
 * had nothing to go back to: a Mac reader who opened all three paths and closed
 * them landed on Windows, and stayed there on every future visit. Skipping the
 * write leaves their own choice standing underneath it.
 */
export function storePlatform(choice: PlatformChoice): void {
  if (choice === 'all') return;
  try {
    window.localStorage.setItem(PLATFORM_STORAGE_KEY, choice);
  } catch {
    /* a browser that refuses storage still gets a working chooser */
  }
}

/**
 * The platform an in-page anchor asks for, or null.
 *
 * `#mac-setup` is what older Discord links name: the Mac section is now one
 * branch of one spine, so the hash selects the branch rather than scrolling to
 * an element that is hidden. Every other hash on the page (`#trouble`,
 * `#once-you-are-in`, `#update`) answers null, and the caller must treat that
 * as "no opinion" rather than "go back to the default" — jumping to the
 * troubleshooting used to silently return a Mac reader to Windows.
 */
export function platformFromHash(hash: string): PlatformId | null {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  if (clean === 'mac-setup') return 'mac';
  const panel = clean.startsWith('steps-') ? clean.slice('steps-'.length) : null;
  return panel && PLATFORMS.some((p) => p.id === panel) ? (panel as PlatformId) : null;
}

/* ── the Mac mod checklist ─────────────────────────────────────────────── */

/** One row of the hand-install checklist. */
export interface ChecklistMod {
  name: string;
  /** The version the pack pins. A row without one cannot be checked off. */
  version: string;
  url?: string;
}

/** The shape `config/mods.ts` hands over. Kept structural so nothing imports it. */
interface ModLike {
  name: string;
  version?: string;
  clientRequired: boolean;
  tentative?: boolean;
  url?: string;
}

/**
 * The mods a Mac player installs by hand, at the versions the pack pins.
 *
 * Macheim cannot read an r2modman profile code, so the Mac path is the one
 * place on the site where a player transcribes version numbers. Deriving the
 * list from `config/mods.ts` means the page cannot fall behind the pack: a
 * re-mint edits the config and this table follows. Mods with no pinned version
 * are dropped rather than shown as a blank a player has to guess at.
 *
 * Takes the array rather than importing it, so this module stays free of
 * config imports and can be tested on its own.
 */
export function checklistFrom(mods: readonly ModLike[]): ChecklistMod[] {
  return mods
    .filter((m) => m.clientRequired && !m.tentative && Boolean(m.version))
    .map((m) => ({ name: m.name, version: m.version as string, url: m.url }));
}
