import { MAP_FRAME_PREFIX, framePad, mapStorageUrl, parseFrameDay } from '@/lib/map-image';

/**
 * One archived in-game-day frame of the season replay, served same-origin.
 *
 * `GET /api/map/frame/0412` → the bytes of `map/frames-by-day/day-0412.webp`.
 *
 * THE DAY NUMBER IS THE VERSION. Once world day 412 has rolled over its frame
 * is never rewritten (scripts/map-snapshot.mjs upserts the CURRENT day's frame
 * through the day and then moves on), so this URL is permanently addressable
 * and gets a day at the edge. The one frame that can still change is the one
 * for today, which is why the window is a day rather than forever: a replay
 * showing yesterday's version of today's frame is invisible, a replay that
 * could never update would not be.
 *
 * NO DATA CACHE ON THE UPSTREAM FETCH, unlike /api/map/current. There are 951
 * of these objects today and one per in-game day forever after; pulling them
 * all into Next's data cache would be ~95 MB of it to save round trips the CDN
 * has already saved. `no-store` here means a CDN miss costs exactly one
 * Supabase read, and a CDN hit costs none.
 *
 * PATH SAFETY. `[day]` is the only caller-controlled thing that reaches a
 * storage path anywhere in this app. parseFrameDay (lib/map-image) accepts
 * nothing but 1–4 digits in 1..9999 and the path is then rebuilt from the
 * NUMBER, never from the caller's string, so there is no way to address an
 * object outside `frames-by-day/`. Public bucket, anon read, no service role:
 * the RLS model is untouched.
 */

/** A frame is immutable once its day has rolled over — see the note above. */
const CACHE_CONTROL = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800';

const ERROR_HEADERS = { 'Cache-Control': 'no-store' } as const;

export async function GET(
  _request: Request,
  context: { params: Promise<{ day: string }> },
): Promise<Response> {
  const { day: raw } = await context.params;
  const day = parseFrameDay(raw);
  if (day === null) {
    return new Response('bad frame', { status: 400, headers: ERROR_HEADERS });
  }

  let upstream: Response;
  try {
    upstream = await fetch(mapStorageUrl(`${MAP_FRAME_PREFIX}${framePad(day)}.webp`), {
      cache: 'no-store',
    });
  } catch {
    return new Response('frame unavailable', { status: 502, headers: ERROR_HEADERS });
  }

  if (!upstream.ok) {
    return new Response('frame unavailable', {
      status: upstream.status === 404 ? 404 : 502,
      headers: ERROR_HEADERS,
    });
  }

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
