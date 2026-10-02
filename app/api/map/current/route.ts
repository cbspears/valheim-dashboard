import { mapStorageUrl } from '@/lib/map-image';

/**
 * The live world composite, served same-origin so something can cache it.
 *
 * `GET /api/map/current?v=<version>` → the bytes of `map/current.webp`.
 *
 * WHY A PROXY AND NOT next/image (2026-10-02). The gallery goes through Vercel's
 * image optimizer because 132 photos are immutable and want transcoding; this
 * one object is rewritten every five minutes by eilif-map-snapshot and is
 * already a tuned WebP, so there is nothing to transcode and an optimizer entry
 * per snapshot would just move the cost onto Vercel's image quota. What it
 * actually needs is an edge cache, and that only needs a `Cache-Control` —
 * which Supabase Storage refuses to give it (`cache-control: no-cache` on every
 * public object, measured).
 *
 * `v` IS READ, AND DELIBERATELY NOT FORWARDED. The caller stamps the snapshot's
 * own `capturedAt` into it (lib/map-image mapCurrentSrc), so the URL changes
 * when, and only when, a new chart lands. It is the CDN cache key; upstream
 * always gets the same plain object URL. Reading it also keeps the handler
 * dynamic, which matters: a GET route handler that touches nothing request-
 * shaped is a candidate for static generation, and a statically generated map
 * would show the build-time picture forever.
 *
 * TWO LAYERS, ON PURPOSE:
 *   • `next: { revalidate }` on the upstream fetch — one Supabase read per
 *     window for the whole deployment, not one per edge region. It is one small
 *     object, so it sits in the data cache comfortably.
 *   • `Cache-Control: s-maxage` on the response — Vercel's edge answers every
 *     repeat view, including /tv's sixty-second refresh, without waking this
 *     function at all.
 *
 * ANON ONLY. The bucket is public-read and stays that way; no service role, no
 * cookies, no auth of any kind is involved, so nothing here changes the RLS
 * model. The handler can reach exactly one object and takes no path input.
 */

/** Matched to the snapshot cadence: eilif-map-snapshot re-uploads every 5 min. */
const UPSTREAM_REVALIDATE_SEC = 240;

/**
 * `s-maxage=240` is that same cadence at the edge; `stale-while-revalidate=600`
 * keeps a quiet hour from ever paying the full round trip on the first view.
 * `max-age=60` is the browser's share — small, because the version key already
 * makes a changed picture a changed URL, so this only governs how fast a
 * long-open tab re-asks for a URL it is still being shown.
 */
const CACHE_CONTROL = 'public, max-age=60, s-maxage=240, stale-while-revalidate=600';

/** A failure must never be cached as if it were a map. */
const ERROR_HEADERS = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: Request): Promise<Response> {
  // Read (and discard) the version key — see the note above on why.
  void new URL(request.url).searchParams.get('v');

  let upstream: Response;
  try {
    upstream = await fetch(mapStorageUrl('current.webp'), {
      next: { revalidate: UPSTREAM_REVALIDATE_SEC },
    });
  } catch {
    return new Response('map unavailable', { status: 502, headers: ERROR_HEADERS });
  }

  if (!upstream.ok) {
    // 404 means the world has not been charted yet (a fresh wipe); anything
    // else is Supabase having a bad day. Both are "no picture", neither is ours.
    return new Response('map unavailable', {
      status: upstream.status === 404 ? 404 : 502,
      headers: ERROR_HEADERS,
    });
  }

  // Buffered rather than streamed: the composite is ~156 kB, and a buffered
  // body is what lets the fetch above be cached at all.
  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/webp',
      'Content-Length': String(body.byteLength),
      'Cache-Control': CACHE_CONTROL,
    },
  });
}
