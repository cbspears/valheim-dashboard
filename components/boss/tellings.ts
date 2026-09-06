// Pure helpers for the war-room's saga slot. No React, no Supabase, so
// scripts/tellings-site.test.mjs can drive them directly.
//
// A boss may now carry several tellings (db/2026-09-06_boss_tellings.sql): the
// Skald's, written on the kill, and any a viking has told since with
// `@Eilif retell <Boss>: <text>`. Exactly one is `chosen`, and that is the one
// the page shows.

import type { BossTelling } from '@/lib/types';

/**
 * The telling the war-room shows: the chosen one, and otherwise the newest.
 *
 * The fallback is not decoration. `boss_tellings_one_chosen_idx` means choosing
 * a telling is two statements (clear the boss's flag, then set the new one), so
 * there is a real instant, and a real failure mode, in which a boss has rows and
 * none of them is chosen. Falling back to the newest keeps a saga on the page
 * through it.
 *
 * Rows arrive chosen-first, then newest first (lib/data.ts getBossTellings), so
 * the chosen one is inside the bounded window however old it is. The `find`
 * here does not depend on that ordering, which is the point: if the query ever
 * loses its `chosen` sort, this still shows the kept telling.
 */
export function pickTelling(tellings: BossTelling[]): BossTelling | null {
  if (!Array.isArray(tellings) || tellings.length === 0) return null;
  return tellings.find((t) => t.chosen) ?? tellings[0];
}

/**
 * The telling a vote ruled against (db/2026-09-06_telling_votes.sql).
 *
 * It gets its own heading rather than being folded in with the rest, because
 * "the hall voted and this is the other version" is a different thing from
 * "here are the older tellings", and a reader should be able to tell them
 * apart. Only ever ONE: the vote marks the runner-up and nothing else, so a
 * second apocryphal row would have to come from a hand edit; the first is used
 * and the rest fall through to the collapsed list.
 *
 * Never the telling on show. `standing` and `chosen` are independent columns
 * and a hand-written row could carry both, and the war-room must not print the
 * same paragraphs twice under two different headings.
 */
export function apocryphalTelling(
  tellings: BossTelling[],
  shown: BossTelling | null,
): BossTelling | null {
  if (!Array.isArray(tellings)) return null;
  return (
    tellings.find((t) => t.standing === 'apocryphal' && (!shown || t.id !== shown.id)) ?? null
  );
}

/** Everything except the one on show and the apocryphal one, in the order it came back. */
export function otherTellings(
  tellings: BossTelling[],
  shown: BossTelling | null,
  apocryphal: BossTelling | null = null,
): BossTelling[] {
  if (!Array.isArray(tellings)) return [];
  return tellings.filter((t) => t.id !== shown?.id && t.id !== apocryphal?.id);
}

// ── the Skald's draft ─────────────────────────────────────────────────────
//
// These three numbers are the site's half of the Storyteller's nudge clock, and
// they MUST read the same as services/discord-bot/src/storyteller.js: the bot
// nudges the holder a day after a kill (or a week after the term opened, for a
// boss that fell before it), and the page says the tale is overdue a further
// week after that. Duplicated rather than imported because the two run in
// different runtimes; scripts/offices-site.test.mjs pins them against the bot's
// own constants so they cannot drift apart unnoticed.

const NUDGE_AFTER_KILL_MS = 24 * 3600 * 1000;
const NUDGE_GRACE_MS = 7 * 24 * 3600 * 1000;
/** How long after the nudge was owed before the page says so out loud. */
export const DRAFT_STANDS_AFTER_MS = 7 * 24 * 3600 * 1000;

/** When the Storyteller was owed a nudge about this fall. Mirrors nudgeDueAt. */
export function nudgeDueAt(
  killedAt: string | null | undefined,
  officeSince: string | null | undefined,
): number | null {
  const killed = Date.parse(killedAt ?? '');
  const since = Date.parse(officeSince ?? '');
  if (!Number.isFinite(killed)) return Number.isFinite(since) ? since + NUDGE_GRACE_MS : null;
  if (!Number.isFinite(since)) return killed + NUDGE_AFTER_KILL_MS;
  return killed >= since ? killed + NUDGE_AFTER_KILL_MS : since + NUDGE_GRACE_MS;
}

/**
 * True when this fall has gone long enough untold that the page should say so.
 *
 * "Untold" means no VIKING has told it. The Skald writes one on every kill, so
 * a boss always has words on its page; the question this answers is whether
 * those words are still the machine's. The line it drives is a statement of
 * fact about the record and never a complaint about a person, which is why it
 * reads the same whether the office is held or vacant.
 *
 * GATED ON THE OFFICE EXISTING, and that gate is load-bearing rather than
 * decorative. The Storyteller ships OFF: STORYTELLER=1 is unset and
 * db/2026-09-06_offices.sql is unapplied, so `offices` answers PGRST205 and
 * lib/data.ts getOffices returns []. Without `officeKnown` this line reads only
 * the kill date, so every boss left untold for eight days would advertise an
 * office the hall does not have, on a war room that is supposed to render today
 * exactly as it rendered yesterday. `officeKnown` is "this hall has had a
 * Storyteller at some point", which is false for every database on earth until
 * the migration runs and a term is opened, and true from then on whether the
 * seat is filled or empty.
 */
export function wantsStoryteller({
  tellings,
  killedAt,
  officeKnown = false,
  officeSince = null,
  nowMs = Date.now(),
}: {
  tellings: BossTelling[];
  killedAt: string | null | undefined;
  /** Whether the hall has an office roll at all (offices.length > 0). */
  officeKnown?: boolean;
  officeSince?: string | null;
  nowMs?: number;
}): boolean {
  if (!officeKnown) return false;
  const told = (Array.isArray(tellings) ? tellings : []).some(
    (t) => t.source === 'player' || t.source === 'admin',
  );
  if (told) return false;
  const due = nudgeDueAt(killedAt, officeSince);
  if (due == null) return false;
  return nowMs >= due + DRAFT_STANDS_AFTER_MS;
}

/** "as told by Bren" / "as told by the Skald". */
export function byline(telling: BossTelling | null): string {
  if (!telling) return 'as told by the Skald';
  if (telling.source === 'skald') return 'as told by the Skald';
  const name = (telling.author_character ?? '').trim();
  return name ? `as told by ${name}` : 'as told by a viking';
}

/**
 * A telling, split into paragraphs on blank lines.
 *
 * Rendered as plain text nodes in <p> elements, never as markdown and never as
 * HTML: the text is whatever a player typed into a Discord message, stored raw
 * on purpose (services/discord-bot/src/tellings.js strips control characters
 * and caps the length, and nothing else). React escapes a text node, so `**` is
 * two asterisks here and a `<script>` is five words.
 */
export function splitParagraphs(text: string | null | undefined): string[] {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
