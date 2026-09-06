// Pure helpers for the Storyteller's work on the Saga. No React, no Supabase,
// so scripts/tales-site.test.mjs can drive them directly.
//
// Two surfaces are built out of these:
//   • the episode card, which carries the tales told about that night
//     (lib/episodes.ts attaches them, components/events/EpisodeList.tsx renders
//     them under "As the Storyteller tells it");
//   • /events/storyteller, which is every tale and every player telling in one
//     column, newest first.

import type { BossTelling, Tale } from './types';

// ── the day ───────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * "Sat, Sep 12, 2026" for a `tales.told_for` day KEY.
 *
 * BUILT FROM THE KEY'S OWN NUMBERS, never by parsing it into a Date and
 * formatting that. `new Date('2026-09-12')` is UTC midnight, and rendering that
 * instant in America/Chicago says September 11: a tale about Saturday night
 * would be labelled Friday on the one page whose whole job is to say which
 * night it was. `told_for` is a calendar day and carries no instant, so there
 * is nothing here to convert.
 *
 * The year is optional because an episode card already dates itself and a tale
 * inside it would only repeat the number; the Storyteller's own view shows it,
 * because a tale can be filed about a night in a previous year.
 */
export function taleDayLabel(key: string | null | undefined, withYear = true): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return 'an unknown night';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12) return 'an unknown night';
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(at.getTime())) return 'an unknown night';
  const stem = `${WEEKDAYS[at.getUTCDay()]}, ${MONTHS[mo - 1]} ${d}`;
  return withYear ? `${stem}, ${y}` : stem;
}

const CT_KEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The Central calendar day `days` days back, as a `YYYY-MM-DD` key.
 *
 * What the Saga hands `getTales({ sinceDay })`, so the tales it reads cover the
 * same stretch of the season as the sessions and events beside them. A day key
 * only changes once a day, which also makes it a far better cache key than an
 * instant: see lib/data.ts windowStartIso for the same problem solved the same
 * way one unit coarser.
 */
export function daysAgoCtKey(days: number, nowMs = Date.now()): string {
  return CT_KEY_FMT.format(new Date(nowMs - days * 86_400_000));
}

// ── prose ─────────────────────────────────────────────────────────────────

/**
 * A tale, split into paragraphs on blank lines.
 *
 * Rendered as plain text nodes in <p> elements, never as markdown and never as
 * HTML: the text is whatever the Storyteller typed into a Discord message,
 * stored raw on purpose (services/discord-bot/src/tales.js strips control
 * characters and caps the length, and nothing else). React escapes a text node,
 * so `**` is two asterisks here and a `<script>` is five words.
 *
 * Deliberately a second copy of components/boss/tellings.ts splitParagraphs
 * rather than an import: that module is the war room's, this one is the Saga's,
 * and neither should acquire a dependency on the other's shape. Both are pinned
 * by their own tests.
 */
export function splitTaleParagraphs(text: string | null | undefined): string[] {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** "Bren" / "the Storyteller" when the roster name was lost. */
export function taleByline(author: string | null | undefined): string {
  const name = (author ?? '').trim();
  return name || 'the Storyteller';
}

// ── attaching tales to their night ────────────────────────────────────────

/**
 * Tales grouped by the night they are about, oldest first within a night.
 *
 * `told_for` is already an America/Chicago calendar day and so is an episode's
 * key, so this is a string comparison and never a timezone conversion. Oldest
 * first inside a day because two tales of one night read as a sequence.
 */
export function talesByDay(tales: Tale[]): Map<string, Tale[]> {
  const out = new Map<string, Tale[]>();
  for (const t of Array.isArray(tales) ? tales : []) {
    const key = typeof t?.told_for === 'string' ? t.told_for.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const list = out.get(key);
    if (list) list.push(t);
    else out.set(key, [t]);
  }
  for (const list of out.values()) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }
  return out;
}

// ── the Storyteller's own view ────────────────────────────────────────────

/** One card on `/events/storyteller`. */
export type StorytellerEntry =
  | {
      kind: 'tale';
      id: string;
      /** when it was written, which is what the column is ordered by */
      at: string;
      title: string;
      text: string;
      by: string;
      /** the night it is about */
      day: string;
    }
  | {
      kind: 'telling';
      id: string;
      at: string;
      text: string;
      by: string;
      /** the forsaken it is about, or null when the boss row is unknown */
      boss: string | null;
      /** true when this is the telling the war room shows */
      kept: boolean;
    };

/**
 * Every tale and every viking-written boss telling, newest first.
 *
 * ORDERED BY WHEN IT WAS WRITTEN, not by what it is about. A tale carries two
 * dates (the night, and the moment the Storyteller set it down) and a telling
 * carries only one, so `created_at` is the only key both can be sorted on
 * honestly. Each tale card still says which night it is about, which is the
 * information ordering by `told_for` would have carried.
 *
 * The Skald's own tellings are NOT here: this view answers "what have the
 * vikings written", and the machine's draft is not a viking's work. That is the
 * same rule components/boss/tellings.ts wantsStoryteller reads a fall by.
 */
export function storytellerWork(
  tales: Tale[],
  tellings: BossTelling[],
  bosses: { id: string; name: string }[] = [],
): StorytellerEntry[] {
  const bossName = new Map((bosses ?? []).map((b) => [b.id, b.name] as const));

  const entries: StorytellerEntry[] = [];
  for (const t of Array.isArray(tales) ? tales : []) {
    if (!t?.id) continue;
    entries.push({
      kind: 'tale',
      id: t.id,
      at: t.created_at,
      title: (t.title ?? '').trim(),
      text: t.text ?? '',
      by: taleByline(t.author_character),
      day: typeof t.told_for === 'string' ? t.told_for.slice(0, 10) : '',
    });
  }
  for (const t of Array.isArray(tellings) ? tellings : []) {
    if (!t?.id) continue;
    // Belt and braces: getPlayerTellings already asks the database for source
    // 'player', and this view must not start showing the Skald if that filter
    // is ever loosened.
    if (t.source === 'skald') continue;
    entries.push({
      kind: 'telling',
      id: t.id,
      at: t.created_at,
      text: t.text ?? '',
      by: taleByline(t.author_character),
      boss: bossName.get(t.boss_id) ?? null,
      kept: t.chosen === true,
    });
  }

  entries.sort((a, b) => {
    const at = Date.parse(b.at) - Date.parse(a.at);
    if (at) return at;
    // A stable tie-break, so two rows written in the same second render in the
    // same order on every build of this page.
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return entries;
}

// There is deliberately no `isStorytellerView(searchParams.by)` here any more.
// The filter used to be `/events?by=storyteller`, and reading `searchParams` to
// answer it cost the Saga its build-time prerender and put six Supabase reads
// on every request. The two views are two static routes instead:
// app/events/page.tsx and app/events/storyteller/page.tsx.
