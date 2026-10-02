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

/**
 * How many frames one replay is allowed to pull, at most.
 *
 * WHY THERE IS A CEILING AT ALL (2026-10-02, egress incident). The replay used
 * to walk EVERY archived day, one `<img src>` swap per position, and the
 * manifest had quietly grown to 951 of them at ~100 kB each. One press of play
 * was therefore on the order of ninety megabytes off Supabase Storage — from a
 * single visitor, on a bucket with no cache headers, repeated in full on the
 * next press. That is the single most expensive thing the site could do, and
 * nobody watching a season replay can see 951 distinct frames anyway: at the
 * scrubber's 700 ms cadence it would run for eleven minutes.
 *
 * 120 is chosen to be about a minute and a half of watching, which is what the
 * replay was always really showing, and to bound a play at roughly 12 MB
 * before the edge cache gets involved (and ~0 after it).
 */
export const MAX_REPLAY_FRAMES = 120;

/**
 * Thin `frames` down to at most `max`, evenly spaced, keeping the ends.
 *
 * STABLE, NOT RANDOM, and that is the load-bearing property. The sampled days
 * become the URLs the replay asks for (`/api/map/frame/0412`), so the same
 * manifest must always yield the same set — otherwise every play would miss
 * the edge cache on a fresh set of frames and we would be back to paying
 * Supabase for all of them.
 *
 * The first and last frames are always kept: the first is where the world
 * starts dark and the last is the day before Now, and losing either one is the
 * only way the replay can read wrong.
 *
 * `frames` is expected sorted by day ascending (getLiveMap does this); the
 * sample preserves whatever order it is given.
 */
export function sampleReplayFrames<T extends ReplayFrame>(
  frames: readonly T[],
  max: number = MAX_REPLAY_FRAMES,
): T[] {
  if (max <= 0) return [];
  const n = frames.length;
  if (n <= max) return frames.slice();
  if (max === 1) return [frames[n - 1]];
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    // Rounded, so the step is as even as an integer index allows; i=0 → 0 and
    // i=max-1 → n-1 exactly, which is what pins the two ends.
    out.push(frames[Math.round((i * (n - 1)) / (max - 1))]);
  }
  return out;
}
