/**
 * Where the map pictures come from, and why they no longer come from Supabase
 * on every view.
 *
 * THE INCIDENT (2026-10-02). The Supabase project blew through its egress quota
 * and answered 402 to everything, which took the whole site down. Two habits
 * paid for most of it, and both were map/gallery pictures served straight off
 * `storage/v1/object/public/...`:
 *
 *   • Supabase Storage sets `cache-control: no-cache` on every public object
 *     (measured on current.webp, 2026-10-02), so no browser and no CDN in
 *     between ever kept a copy. Every view was a fresh ~156 kB off the bucket.
 *   • /map and /tv then made that worse on purpose: the composite's `src` was
 *     built as `current.webp?t=<updatedAt>`, which was meant as a cache-buster
 *     and worked perfectly — a unique URL defeats what little caching there was
 *     and guarantees a full re-download on every render and every /tv refresh.
 *
 * WHAT REPLACES IT. The map bucket stays public-read and nothing here needs the
 * service role: the browser just stops talking to Supabase directly. Every map
 * picture is addressed same-origin, through the two route handlers under
 * `app/api/map/`, which fetch the object once and answer with a real
 * `Cache-Control` so Vercel's edge serves the repeat views:
 *
 *   /api/map/current?v=<epoch seconds of the snapshot's own capturedAt>
 *   /api/map/frame/<NNNN>
 *
 * `v` is a VERSION, not a cache-buster. It is derived from the snapshot's own
 * timestamp (status.json `capturedAt`, which eilif-map-snapshot rewrites every
 * five minutes), so it is stable for as long as the picture is, and it changes
 * exactly when a new chart lands. Two visitors a minute apart ask for the same
 * URL and the second one is served by the edge.
 *
 * NO 'server-only' HERE, deliberately: lib/data builds these strings on the
 * server and components/map renders them on the client, so this module has to
 * be importable from both. It is pure string work — nothing is read, nothing is
 * fetched, no env secret is touched (NEXT_PUBLIC_SUPABASE_URL is public by
 * definition and is only read by the route handlers, below).
 */

/** The public prefix of the `map` bucket, under the Supabase project URL. */
export const MAP_BUCKET_PATH = '/storage/v1/object/public/map';

/**
 * The per-in-game-day frame prefix, as scripts/map-snapshot.mjs writes it into
 * `frames-manifest.json`. The manifest format is NOT changed by any of this —
 * the dashboard still reads `days` and `prefix` out of it exactly as before.
 * This constant exists so the frame route can rebuild the object path from a
 * day number alone, and so getLiveMap can notice when a manifest declares some
 * OTHER prefix and fall back to direct storage URLs rather than proxying a path
 * that does not exist (see lib/data getLiveMap).
 */
export const MAP_FRAME_PREFIX = 'frames-by-day/day-';

/** Zero-padded day number as the snapshotter names the file: 7 → "0007". */
export function framePad(day: number): string {
  return String(day).padStart(4, '0');
}

/** Absolute public URL of an object in the `map` bucket. Server-side use only
 *  in practice (the route handlers), but harmless anywhere. */
export function mapStorageUrl(objectPath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  return `${base}${MAP_BUCKET_PATH}/${objectPath}`;
}

/**
 * A stable version key for the live composite.
 *
 * Epoch SECONDS of the snapshot's own capture time, not `Date.now()`: the whole
 * point is that the key changes when the picture changes and at no other time.
 * Seconds (not milliseconds) because that is all the cadence needs and it keeps
 * the URL short; a timestamp that cannot be parsed yields `'0'`, which is a
 * perfectly good constant — the route's own `s-maxage` still bounds how long a
 * stale picture can be served.
 */
export function mapVersionKey(updatedAt: string | null | undefined): string {
  if (typeof updatedAt !== 'string') return '0';
  const ms = Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return '0';
  return String(Math.floor(ms / 1000));
}

/** Same-origin, version-stamped path to the live composite. */
export function mapCurrentSrc(updatedAt: string | null | undefined): string {
  return `/api/map/current?v=${mapVersionKey(updatedAt)}`;
}

/**
 * Same-origin path to one archived in-game-day frame.
 *
 * No `?v=` on this one, and none is wanted: a frame's day number IS its version.
 * Once day 412 has rolled over, `frames-by-day/day-0412.webp` never changes
 * again, so the URL is permanently addressable and the route can cache it hard.
 */
export function mapFrameSrc(day: number): string {
  return `/api/map/frame/${framePad(day)}`;
}

/**
 * The day number in a `/api/map/frame/<day>` segment, or null if it is not one.
 *
 * Strict on purpose. This is the only place a caller-supplied string becomes
 * part of a storage object path, so it accepts nothing but 1–4 digits naming a
 * day in 1..9999 — no slashes, no dots, no `..`, no leading `+`, nothing that
 * could walk out of `frames-by-day/`. (Day 0 does not exist: Valheim world days
 * start at 1, and the snapshotter only frames a day it could read.)
 */
export function parseFrameDay(raw: string | undefined | null): number | null {
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) return null;
  const day = Number(raw);
  if (!Number.isInteger(day) || day < 1 || day > 9999) return null;
  return day;
}
