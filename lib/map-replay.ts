/**
 * Timeline math for the map replay: WHEN does each named place show up?
 *
 * The correlation is day↔day, not clock↔clock. Both sides of the comparison are
 * the same number from the same source — Valheim's in-game world day, published
 * by the GsValheimStats emitter into `server_status.world_day`:
 *
 *   • a frame's `day` is the world day the snapshotter was archiving when it
 *     wrote `frames-by-day/day-NNNN.webp` (scripts/map-snapshot.mjs), and
 *   • a pin's `day` is the world day read out of `server_status` at the instant
 *     the `/pin` shout was ingested (app/api/webhook/route.ts).
 *
 * So no wall-clock conversion is needed or wanted. (The frames manifest carries
 * no per-frame capture time anyway — only `days`, `prefix`, and one global
 * `updatedAt` — so a real-time correlation would have to be invented, and it
 * would be strictly worse: a snapshot is upserted repeatedly through a world
 * day and only freezes at rollover, so its file mtime is the day's END, which
 * would push a pin named early on day N onto the day N+1 frame.)
 *
 * A place appears on the first archived frame at or after the day it was named,
 * which handles sparse archives (server down on day 4 → a day-4 pin surfaces on
 * the day-5 frame) and pins named after the last archived frame (they belong to
 * "Now" only).
 */

/** Just the fields the timeline needs — `LiveMapFrame` satisfies this. */
export interface ReplayFrame {
  day: number;
}

/** Just the fields the timeline needs — `LivePin` satisfies this. */
export interface ReplayPin {
  id: string;
  day: number | null;
}

/** How a marker reads on the frame being shown. */
export type PinPhase = 'new' | 'established';

/**
 * Map of pin id → the replay position where that pin first appears.
 *
 * Positions match the replay scrubber: `0..frames.length-1` are the archived
 * days and `frames.length` is "Now". `frames` must be sorted by day ascending
 * (getLiveMap does this). Pins with no recorded day are omitted entirely —
 * there is no honest place to put them on the timeline, so they only show up at
 * "Now", exactly as they do today.
 */
export function pinAppearanceByFrame(
  frames: readonly ReplayFrame[],
  pins: readonly ReplayPin[],
): Map<string, number> {
  const nowIndex = frames.length;
  const appearance = new Map<string, number>();
  for (const pin of pins) {
    const day = pin.day;
    if (day === null || day === undefined || !Number.isFinite(day)) continue;
    const i = frames.findIndex((f) => f.day >= day);
    appearance.set(pin.id, i === -1 ? nowIndex : i);
  }
  return appearance;
}

/**
 * How a pin reads at replay position `pos`: `'new'` on the very frame it was
 * named (worth a highlight — this is the moment), `'established'` on every
 * later frame, and `null` when it does not exist yet (or has no day at all).
 */
export function pinPhaseAt(
  appearance: ReadonlyMap<string, number>,
  pinId: string,
  pos: number,
): PinPhase | null {
  const at = appearance.get(pinId);
  if (at === undefined || at > pos) return null;
  return at === pos ? 'new' : 'established';
}
