// The nav bar's "next gathering" pill, reduced to the handful of plain values
// the (client) pill component needs. Kept out of the component file so the
// root layout — a Server Component — can call the mapper without reaching
// across the client boundary.

import { gatheringCountdown, isGatheringImminent } from './format';
import type { UpcomingEvent } from './types';

/** How much of an event name fits in the pill before it gets an ellipsis. */
export const NAME_MAX = 24;

export interface NextGathering {
  /** Full name, used for the hover/screen-reader label. */
  name: string;
  /** Name trimmed to fit the pill. */
  shortName: string;
  /** ISO start of the next occurrence. */
  startsAt: string;
  /** Where the pill points: the Discord event when we have a link, else the World page's gatherings. */
  href: string;
  /** True when `href` leaves the site (Discord) — needs target/rel. */
  external: boolean;
  /** Server-computed "in 13 days" — the client refreshes it after mount. */
  label: string;
  /** Server-computed "a day out or nearer" — the client refreshes it too. */
  imminent: boolean;
}

/** Trim a long event name on a word-ish boundary and mark it with an ellipsis. */
export function shortenName(name: string, max: number = NAME_MAX): string {
  const trimmed = name.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // Only break on a space if it leaves most of the room used — otherwise a
  // long first word would shrink the label to almost nothing.
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * Turn the soonest upcoming event into pill props. Returns null when there is
 * nothing on the calendar (or the row has no name) — the nav then renders no
 * pill at all, exactly as it looked before this feature existed.
 */
export function toNextGathering(
  event: UpcomingEvent | null,
  now: number = Date.now()
): NextGathering | null {
  if (!event) return null;
  const name = event.name?.trim();
  if (!name || !event.next_at) return null;

  return {
    name,
    shortName: shortenName(name),
    startsAt: event.next_at,
    href: event.url ?? '/world#gatherings',
    external: Boolean(event.url),
    label: gatheringCountdown(event.next_at, now),
    imminent: isGatheringImminent(event.next_at, now),
  };
}
