/**
 * Boss altars: where a forsaken actually fell, and how that becomes a map pin.
 *
 * When /api/gs-ingest flips a boss to killed it knows two things nothing else
 * does: who the war party was, and (through `player_positions`) roughly where
 * they were standing. One pin of kind 'boss' at their centroid turns that into
 * a place on the atlas, and gives the Discord bot's altar-tellings loop
 * (services/discord-bot/src/altar.js) somewhere to speak the saga.
 *
 * Every function here is pure so the arithmetic is testable without a database
 * (lib/altar.test.mjs). The route does the reads and the insert.
 */

/**
 * Valheim's world size constant, in metres. The same number the `pin` branch of
 * app/api/webhook/route.ts and the /tv display already use; all three project
 * the same way, and worldToMap below is the one definition the ingest reads.
 */
export const WORLD_RADIUS = 10000;

/** A position is only evidence of where someone stood if it is recent. */
export const ALTAR_POSITION_FRESH_MS = 5 * 60 * 1000;

/** How an altar pin is named. Mirrored by the bot's ALTAR_PIN_SUFFIX. */
export const ALTAR_PIN_SUFFIX = ' altar';

/** The pin kind an altar carries. */
export const ALTAR_PIN_KIND = 'boss';

export interface WorldPoint {
  x: number;
  z: number;
}

/**
 * World coordinates to 0-1 fractions of the map image.
 *
 * IDENTICAL to the expression in app/api/webhook/route.ts's `pin` branch, on
 * purpose: a pin dropped here and a pin shouted in-game have to land in the
 * same place on the same picture, and two projections that agree today and
 * drift next month would be invisible until someone noticed the altars were
 * off. Clamped, so a position outside the world edge charts at the edge instead
 * of off the image.
 */
export function worldToMap(worldX: number, worldZ: number): { x: number; y: number } {
  return {
    x: Math.min(1, Math.max(0, (worldX + WORLD_RADIUS) / (2 * WORLD_RADIUS))),
    y: Math.min(1, Math.max(0, (WORLD_RADIUS - worldZ) / (2 * WORLD_RADIUS))),
  };
}

/** "Bonemass" to "Bonemass altar". Empty for an unusable name. */
export function altarPinName(bossName: string | null | undefined): string {
  const clean = String(bossName ?? '').trim();
  return clean ? `${clean}${ALTAR_PIN_SUFFIX}` : '';
}

/**
 * The positions that count as "where the war party was standing": one per
 * character, finite coordinates, and stamped inside the freshness window.
 *
 * A stamp in the FUTURE is refused rather than trusted. `player_positions
 * .updated_at` is producer-supplied through /api/webhook (the poller passes the
 * log line's own time), and lib/event-time.ts exists because a far-future
 * producer timestamp has frozen this pipeline before.
 */
export function freshPositions<T extends { x?: unknown; z?: unknown; updated_at?: string | null }>(
  rows: T[] | null | undefined,
  nowMs: number,
  windowMs: number = ALTAR_POSITION_FRESH_MS,
): T[] {
  return (rows ?? []).filter((r) => {
    const x = Number(r?.x);
    const z = Number(r?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const at = Date.parse(r?.updated_at ?? '');
    if (!Number.isFinite(at)) return false;
    return at <= nowMs + windowMs && nowMs - at <= windowMs;
  });
}

/**
 * The middle of the war party. A plain mean rather than a median: the input is
 * a handful of people standing around one altar, and the mean of five vikings
 * in a clearing is the clearing. Null when there is nothing to average.
 */
export function centroidOf(points: { x?: unknown; z?: unknown }[] | null | undefined): WorldPoint | null {
  const usable = (points ?? [])
    .map((p) => ({ x: Number(p?.x), z: Number(p?.z) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
  if (usable.length === 0) return null;
  const sum = usable.reduce((acc, p) => ({ x: acc.x + p.x, z: acc.z + p.z }), { x: 0, z: 0 });
  return { x: sum.x / usable.length, z: sum.z / usable.length };
}

/**
 * Everything the altar pin needs, or null when the kill left no usable trace of
 * where it happened (nobody's position was fresh, which is the ordinary case
 * for a kill reported by a client whose companion plugin is not emitting).
 *
 * Pure. The route reads `player_positions` for the war party and hands the rows
 * straight in.
 */
export function altarPinFor<T extends { character_name?: string | null; x?: unknown; z?: unknown; updated_at?: string | null }>(
  bossName: string,
  positions: T[] | null | undefined,
  { nowMs = Date.now(), windowMs = ALTAR_POSITION_FRESH_MS }: { nowMs?: number; windowMs?: number } = {},
): { name: string; world_x: number; world_z: number; x: number; y: number } | null {
  const name = altarPinName(bossName);
  if (!name) return null;
  const centre = centroidOf(freshPositions(positions, nowMs, windowMs));
  if (!centre) return null;
  const { x, y } = worldToMap(centre.x, centre.z);
  return { name, world_x: centre.x, world_z: centre.z, x, y };
}
