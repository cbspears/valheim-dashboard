// Server-side data access layer.
// All dashboard pages import typed query functions from here so that
// Supabase specifics stay in one place (easy to evolve / swap later).
//
// Reads use the public anon key against RLS "public read" policies.
// Pages that render this data should set `export const dynamic = 'force-dynamic'`
// so live values (online players, server status) are fresh on every request.
// Pages with nothing live on them (the ledger, the saga, the atlas, the oath
// wall) instead set `export const revalidate = 60` and are served from the ISR
// cache — see each page for the staleness it accepts.
//
// THREE THINGS ABOUT THAT ISR THAT ARE EASY TO GET WRONG:
//
//   • 60 s is the FLOOR, not the ceiling. Next serves stale-while-revalidate:
//     the first request after the window expires gets the OLD render and only
//     kicks off the new one. On a busy night nobody notices; on a quiet route
//     the staleness is bounded by the gap between visitors.
//   • FIVE MINUTES IN THE READER'S BROWSER, not sixty seconds. Making a page
//     static also turns on Next's client Router Cache for it: production answers
//     every static route with `x-nextjs-stale-time: 300` and the dynamic routes
//     with no such header at all. That is THIRTEEN data-bearing URLs, not five:
//     the eight /boss/<slug> pages carry the same 300, because /boss/[slug] is
//     `revalidate = 60` with generateStaticParams. (/mods and /get-started carry
//     it too and do not matter — they render config, not the database.) Measured
//     on the live site 2026-09-06: 300 on /world /events /map /oath /gallery and
//     /boss/eikthyr, no such header on / or /players. So
//     a viking who reaches /world through the NavBar — a `next/link` client
//     navigation, which is how the site is actually used — is served the RSC
//     payload their browser already has, for up to 300 s, WITHOUT asking the
//     server. Each page below says a change "shows up within the minute"; that
//     is true of the server's copy and not of a tab that has already been there.
//     A hard reload (or a fresh tab, or curl) is the only thing that beats it,
//     which is also why the launch-morning wipe check at docs/LAUNCH-DAY.md
//     the closing block of step 20 must be run on a page that was never opened before the wipe —
//     otherwise it can read "the page did not turn" while the server is fine.
//   • A WORLD WIPE NEEDS A WARM-UP, AND COUNTING REQUESTS IS THE WRONG CHECK.
//     `revalidate` pages are prerendered AT BUILD TIME, so whatever the database
//     held when `vercel deploy` ran is baked into the deployment — and docs/LAUNCH-DAY.md
//     deploys at step 19 and wipes at step 20. There is no invalidator anywhere
//     in this repo (nothing calls revalidateTag/revalidatePath; the tags below
//     are decorative), so after a wipe the ISR routes have to be walked until
//     they show the new world, or the first viking of the new season reads the
//     old one's ledger.
//
//     WALK THEM BY CONTENT, NOT BY COUNT. Regeneration is asynchronous, and how
//     long it takes is a property of the machine, not of the code — which is
//     exactly why counting requests is the wrong check. Both measurements, so
//     nobody over-waits or under-waits from one anecdote:
//
//       - PRODUCTION, /world polled every few seconds (2026-09-06): HIT at
//         age 54, then STALE at age 61 (the window had expired; that request
//         served the old render and kicked off the rebuild), then the very next
//         request seven seconds later was a HIT at age 5 — the new render was
//         already up, about two seconds after the stale one. On Vercel, one
//         stale answer then fresh.
//       - A COLD LOCAL `next start` against a loaded local stack, same day:
//         STALE, then STALE again three seconds later, and only the third
//         request carried the new number. The renderer is simply slower there.
//
//     So do not count to two, or to three. Reload until the page itself says the
//     world is new — no boss felled, an empty ledger — which is what
//     docs/LAUNCH-DAY.md the closing block of step 20 asks for, and redeploy if it will not turn.
//
//     /world lags longest, because it sits behind TWO independent 60 s caches:
//     the page's own ISR window and getMilestoneAggregates' `unstable_cache`
//     below. A regeneration that lands while that data-cache entry is still warm
//     renders the OLD world's Great Deeds and then parks THAT for another
//     minute, so the ledger can trail the wipe by ~2 minutes even when the boss
//     timeline has already turned over. Judge /world on its Great Deeds numbers,
//     not on its boss row.
//
//     The routes are /world, /events, /gallery, /oath, /map and the eight
//     /boss/<slug> pages. Dynamic routes (/, /players, /viking/[slug], /tv,
//     /admin/ops, every /api/*) are not affected and need no warm-up.
//
// PER-REQUEST DEDUPE (2026-09-06). Every loader below is wrapped in React
// `cache()`, so a page that reaches for the same data twice pays for it once.
// Two things are worth knowing about how far that reaches, both measured on an
// instrumented scratch build rather than assumed:
//
//   • Next already memoizes IDENTICAL fetches inside one render, so the plain
//     loaders were in practice deduped before this. `cache()` makes it explicit
//     and independent of that behaviour.
//   • It does NOT span generateMetadata and the page body — those render in
//     separate cache scopes — and it does NOT apply in Route Handlers at all.
//     Where that mattered the call sites were fixed instead: the windowed
//     loaders quantise their cutoff (see windowStartIso, which is what actually
//     took /viking/[slug] from 9 round trips to 8), and /api/titles derives its
//     online set from the roster it already fetched rather than reading
//     `players` a second time.

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import type {
  Player,
  PlayerStats,
  PlayerWithStats,
  GameSession,
  GameEvent,
  Boss,
  BossTelling,
  ServerStatus,
  DiscordEvent,
  UpcomingEvent,
  GalleryPhoto,
  PotyHistoryEntry,
  Oath,
  Milestone,
  Office,
  PinKind,
} from './types';
import { AGGREGATE_STAT_COLUMNS, computeAggregates, type Aggregates } from './milestones';

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
}

// Explicit column list for public player reads — every players column EXCEPT
// `steam_id`, which is a real external Steam account id the public site never
// uses. Paired with a REVOKE SELECT (steam_id) ... FROM anon migration so a
// direct PostgREST call with the (public) anon key can't harvest it either.
// (discord_user_id/discord_username stay readable — the viking page needs them.)
const PLAYERS_PUBLIC_COLS =
  'id, character_name, discord_id, first_seen_at, last_seen_at, total_playtime_minutes, is_online, bio, role, discord_user_id, discord_username, current_title, title_updated_at';

export const getServerStatus = cache(async (): Promise<ServerStatus | null> => {
  const { data } = await db().from('server_status').select('*').eq('id', 1).single();
  return (data as ServerStatus) ?? null;
});

/**
 * How long `server_status.updated_at` may go without a refresh before the site
 * stops presenting the live stats as live. The GsValheimStats Emitter rewrites
 * that row every 120 s while the server runs, so 15 minutes is ~7 missed
 * cycles: the Emitter (closed source, no 1.0 statement — audit mods-7) has
 * stopped, not hiccuped. `is_online` is kept honest separately by the log
 * poller, which reads joins and leaves out of the server log and does not
 * depend on the Emitter at all.
 */
export const STATS_STALE_AFTER_MS = 15 * 60 * 1000;

export interface StatsFreshness {
  /** True only when the server reads as online but the stats feed has gone quiet. */
  statsStale: boolean;
  /** Age of `server_status.updated_at` in ms; null when it is missing or unreadable. */
  statsAgeMs: number | null;
}

/**
 * Is the live stats feed (Emitter → server_status) keeping up with a server
 * that is actually up? An offline server is its own story and never counts as
 * stale — the Hearth already says the hall sleeps. An online server with no
 * usable timestamp at all counts as stale: there is no evidence the feed is
 * running, and the site must degrade honestly rather than imply it is.
 */
export function statsFreshness(
  status: ServerStatus | null,
  now: number = Date.now()
): StatsFreshness {
  if (!status || !status.is_online) {
    return { statsStale: false, statsAgeMs: ageMs(status?.updated_at ?? null, now) };
  }
  const age = ageMs(status.updated_at, now);
  if (age === null) return { statsStale: true, statsAgeMs: null };
  return { statsStale: age > STATS_STALE_AFTER_MS, statsAgeMs: age };
}

/** Milliseconds between `iso` and `now`, or null when `iso` can't be read. Never negative. */
function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, now - t);
}

/**
 * Who is sailing right now, by name.
 *
 * DERIVED, NOT QUERIED (2026-09-06). This was its own `is_online = true` read,
 * and every route that wanted it — the Hall, the Vikings page, /api/titles,
 * /api/status — already had the whole roster in flight beside it. `players` is
 * one row per viking (twenty of them), so the second query bought nothing but a
 * round trip and a race: the roster and the online set were two reads of one
 * table, and a join landing between them showed a viking online in one and
 * absent from the other. Filtering the roster we already have cannot disagree
 * with itself.
 *
 * Sorted by name in JS rather than by Postgres. No consumer depends on the exact
 * collation — the Hall and /tv print the list, the Vikings page and /api/titles
 * build a Set from it, and `server_status.current_players` (which /api/status
 * prefers) is written by the webhook, not here.
 */
export const getOnlinePlayers = cache(async (): Promise<Player[]> => {
  const roster = await getAllPlayers();
  return roster
    .filter((p) => p.is_online)
    .sort((a, b) => a.character_name.localeCompare(b.character_name));
});

/**
 * Who is sailing right now, names only.
 *
 * For callers that do NOT already have the roster in flight — `/api/status`
 * above all. Route Handlers get none of the per-request memoization a page
 * render gets, so there `getOnlinePlayers()` is not a free filter of something
 * already fetched: it is a full-roster read, every public column of every
 * viking, on an endpoint that is CORS-open, `no-store`, and polled by
 * scripts/map-snapshot.mjs and any external widget. Measured against production:
 * two bytes for `is_online = true` with an empty hall, 2,008 bytes for the whole
 * roster of five, roughly 16 KB at a mid-season forty. This read stays small
 * whatever the roster does, and the two callers of it only ever want names.
 */
export const getOnlinePlayerNames = cache(async (): Promise<string[]> => {
  const { data } = await db()
    .from('players')
    .select('character_name')
    .eq('is_online', true)
    .order('character_name')
    .limit(500);
  return ((data as { character_name: string }[]) ?? []).map((r) => r.character_name);
});

/**
 * The whole roster, longest-played first. The roster of record for the site:
 * the Hall, the Vikings page, the gallery byline, every war-room and
 * `getOnlinePlayers` below all read it, and React `cache()` means one render
 * pays for it once.
 *
 * BOUNDED AT 500, AND LOUD ABOUT IT (2026-09-06). Its siblings were capped for
 * the 2026-07-25 incident, when a webhook insert race forked `players` to 325
 * duplicate rows in a week and every render carried all of them. This one was
 * left unbounded, and the same commit widened it further by deriving
 * `getOnlinePlayers` from it, so an incident would be paid for on more pages
 * than before. 500 is twenty-five times the player cap and well above that
 * incident, so it is a transfer bound and not a filter.
 *
 * The one thing a cap could cost here is a viking: the sort is by playtime, so
 * above 500 rows a brand-new arrival with no minutes is the first to fall off
 * the end, and `getOnlinePlayers` would then say the hall is emptier than it
 * is. That must never happen quietly, so hitting the cap logs. If that line
 * ever appears, `players` has forked and the roster needs deduping by
 * character_name (db/2026-07-25_players_unique_name.sql) before anything on the
 * site can be trusted.
 */
const ALL_PLAYERS_LIMIT = 500;

export const getAllPlayers = cache(async (): Promise<Player[]> => {
  const { data } = await db()
    .from('players')
    .select(PLAYERS_PUBLIC_COLS)
    .order('total_playtime_minutes', { ascending: false })
    .limit(ALL_PLAYERS_LIMIT);
  const rows = (data as Player[]) ?? [];
  if (rows.length >= ALL_PLAYERS_LIMIT) {
    console.error(
      `[data] getAllPlayers hit its ${ALL_PLAYERS_LIMIT}-row cap. The players table has forked ` +
        `(config/server.ts caps the hall at twenty); vikings past the cap are missing from the roster ` +
        `AND from the online list. Dedupe players by character_name before trusting the site.`,
    );
  }
  return rows;
});

export const getPlayersWithStats = cache(async (): Promise<PlayerWithStats[]> => {
  const [players, stats] = await Promise.all([getAllPlayers(), getAllStats()]);
  const byPlayer = new Map(stats.map((s) => [s.player_id, s]));
  return players.map((p) => ({ ...p, stats: byPlayer.get(p.id) ?? null }));
});

/**
 * Every viking's cumulative stat row, whole.
 *
 * Still `select('*')` on purpose: the Vikings page and each viking page render
 * the `gs_stats` blob itself (weapons, pickups, per-boss damage), so unlike the
 * milestone aggregate — which needs eight numbers and now asks for
 * AGGREGATE_STAT_COLUMNS — there is nothing here to narrow without breaking a
 * surface. Bounded at 500 all the same (2026-09-06): this is the widest row in
 * the schema, measured at 2.56 KB per viking, and it feeds four routes. `players`
 * caps at twenty, so five hundred is far above any honest number and exists only
 * so a forked-row incident (db/2026-07-25_players_unique_name.sql — 325 duplicate
 * rows in one week) cannot turn every /players and /viking render into an
 * unbounded transfer.
 */
export const getAllStats = cache(async (): Promise<PlayerStats[]> => {
  const { data } = await db().from('player_stats').select('*').limit(500);
  return (data as PlayerStats[]) ?? [];
});

export const getRecentEvents = cache(async (limit = 20): Promise<GameEvent[]> => {
  const { data } = await db()
    .from('events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data as GameEvent[]) ?? [];
});

export const getAllEvents = cache(async (limit = 200): Promise<GameEvent[]> => {
  const { data } = await db()
    .from('events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data as GameEvent[]) ?? [];
});

export const getRecentSessions = cache(async (limit = 50): Promise<GameSession[]> => {
  const { data } = await db()
    .from('sessions')
    .select('*')
    .order('joined_at', { ascending: false })
    .limit(limit);
  return (data as GameSession[]) ?? [];
});

export interface LiveMapFrame {
  day: number;
  url: string;
}

/**
 * How long the live map composite may go without a refresh before /map stops
 * calling it live. scripts/map-snapshot.mjs re-uploads `map/current.webp` every
 * 5 minutes, so 6 hours is ~72 missed cycles — the WebMap plugin, the SFTP
 * pull, or the snapshot service itself has stopped (audit mods-8), not a blip.
 */
export const MAP_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface LiveMap {
  url: string;
  /** `last-modified` of current.webp, i.e. when the composite was last charted. */
  updatedAt: string | null;
  frames: LiveMapFrame[];
  /** True when the composite is older than MAP_STALE_AFTER_MS, or its age is unknown. */
  stale: boolean;
  /** Age of the composite in ms; null when `last-modified` is missing or unreadable. */
  ageMs: number | null;
}

/**
 * Is the map composite still being refreshed? An unreadable or absent
 * `last-modified` counts as stale: freshness can't be proven, and a paused map
 * shown as live is exactly the lie this guard exists to prevent. The archived
 * day frames are unaffected — the timelapse keeps working either way.
 */
export function mapFreshness(
  updatedAt: string | null,
  now: number = Date.now()
): { stale: boolean; ageMs: number | null } {
  const age = ageMs(updatedAt, now);
  if (age === null) return { stale: true, ageMs: null };
  return { stale: age > MAP_STALE_AFTER_MS, ageMs: age };
}

/** The live fog-masked world map snapshot + the per-in-game-day frame archive. */
export const getLiveMap = cache(async (): Promise<LiveMap | null> => {
  const bucket = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/map`;
  const url = `${bucket}/current.webp`;
  try {
    // THREE OBJECTS, ONE ROUND TRIP'S WORTH OF WALL CLOCK (2026-09-06). These
    // used to run one after another — HEAD current.webp, then the manifest, then
    // status.json — and on the instrumented scratch build that chain WAS /map's
    // time to first byte: 115 + 35 + 173 ms of a ~330 ms render, with the page's
    // two Supabase reads already finished and waiting. They do not depend on each
    // other (the HEAD's only output is a fallback `last-modified`, read after all
    // three settle), so they are fired together and the page pays for the slowest
    // one instead of the sum. `allSettled`, not `all`: a missing manifest or a
    // missing status.json has always been survivable (older snapshot loops wrote
    // neither) and must not take the live map down with it.
    //
    // `revalidate: 60`, not `no-store`. These three objects are rewritten by
    // eilif-map-snapshot every FIVE minutes, so a sixty-second floor on how
    // often the site re-reads them cannot make the page any staler than the
    // pipeline behind it already is — and `no-store` was doing real damage
    // beyond the wasted round trips: one no-store fetch opts the whole route out
    // of static rendering, which is why /map could not be given the 60 s ISR
    // window /world and /events now have. Matched to that window on purpose, so
    // the page and the objects it describes expire together.
    const opts = { next: { revalidate: 60 } } as const;
    const [headR, mfR, stR] = await Promise.allSettled([
      fetch(url, { method: 'HEAD', ...opts }),
      fetch(`${bucket}/frames-manifest.json`, opts),
      fetch(`${bucket}/status.json`, opts),
    ]);

    // No composite = no live map, exactly as before. This is the one hard gate.
    if (headR.status !== 'fulfilled' || !headR.value.ok) return null;
    const head = headR.value;

    let frames: LiveMapFrame[] = [];
    if (mfR.status === 'fulfilled' && mfR.value.ok) {
      try {
        const m = (await mfR.value.json()) as { days?: number[]; prefix?: string };
        frames = (m.days ?? [])
          .filter((d) => Number.isFinite(d))
          .sort((a, b) => a - b)
          .map((day) => ({
            day,
            url: `${bucket}/${m.prefix ?? 'frames-by-day/day-'}${String(day).padStart(4, '0')}.webp`,
          }));
      } catch {
        /* unreadable manifest — live-only */
      }
    }

    // Freshness: prefer the snapshot loop's own status.json (written on EVERY
    // run with the capture time). The object's last-modified header is NOT a
    // liveness signal: Supabase leaves it untouched when an upsert writes
    // byte-identical content, which is exactly what happens for days on end
    // when nobody plays (the composite never changes). Fall back to the header
    // only when status.json is missing (older snapshot loop).
    let updatedAt: string | null = null;
    if (stR.status === 'fulfilled' && stR.value.ok) {
      try {
        const j = (await stR.value.json()) as { capturedAt?: string };
        if (typeof j.capturedAt === 'string' && Number.isFinite(Date.parse(j.capturedAt))) {
          updatedAt = j.capturedAt;
        }
      } catch {
        /* fall through to the header */
      }
    }
    if (!updatedAt) updatedAt = head.headers.get('last-modified');
    return { url, updatedAt, frames, ...mapFreshness(updatedAt) };
  } catch {
    return null;
  }
});

/**
 * The start of a rolling `days`-day window, as an ISO string, with the clock
 * quantised to the minute.
 *
 * WHY QUANTISE (2026-09-06). These windows go straight into the PostgREST URL,
 * so a raw `Date.now()` makes every call a different URL — and two calls a few
 * milliseconds apart in one request are then two different reads that nothing
 * can dedupe. That is exactly what /viking/[slug] was doing: its generateMetadata
 * and its page body both ask for 70 days of deaths, and React's `cache()` does
 * NOT span those two (they render in separate cache scopes in Next 16 — measured,
 * not assumed). Flooring to the minute makes the two URLs identical, which is all
 * Next's own fetch memoization needs to collapse them into one round trip; it
 * also gives the ISR data cache a key that is stable for a minute instead of one
 * that changes on every render. The cost is that a 70-day boundary can sit up to
 * 60 s behind — the window is six million seconds wide.
 */
function windowStartIso(days: number): string {
  const minute = 60_000;
  const now = Math.floor(Date.now() / minute) * minute;
  return new Date(now - days * 86_400_000).toISOString();
}

export interface LivePin {
  id: string;
  name: string;
  /**
   * The kind the ATLAS can draw. `pins.kind` is wider than this (lib/types.ts
   * PinKind); getPins folds everything that is not a base to the
   * place-of-interest mark, because that is the glyph the renderer would use
   * anyway. Read `pinKind` when the real value matters.
   */
  kind: 'base' | 'poi';
  /**
   * The row's true `pins.kind`, including 'boss' for a fallen forsaken's altar.
   * Optional so a caller that does not care is unaffected.
   */
  pinKind?: PinKind;
  by_character_name: string | null;
  x: number;
  y: number;
  day: number | null;
}

/**
 * Real player-placed pins on the live map (via in-game /pin).
 *
 * Bounded at 1000 (2026-09-06): every other list read in this file carries a
 * limit and this one did not. A pin is a deliberate act — six exist today and a
 * whole season might add a few hundred — so the cap is far above any honest
 * number, and it exists only so a runaway producer (a /pin loop, a spammer)
 * cannot turn every /map and /viking render into an unbounded transfer. Oldest
 * first, so the cap drops the newest pins rather than rewriting the atlas.
 */
export const getPins = cache(async (): Promise<LivePin[]> => {
  const { data } = await db()
    .from('pins')
    .select('id, name, kind, by_character_name, x, y, day')
    .order('created_at', { ascending: true })
    .limit(1000);
  // NARROWED AT THE BOUNDARY, not typed as a wish. `pins.kind` is the wider
  // PinKind vocabulary (lib/types.ts) and now carries 'boss' for the altars
  // /api/gs-ingest charts at a kill, while the atlas draws exactly two glyphs
  // (components/map/ZoomableMap.tsx MarkerGlyph, which is a `base ? ... : ...`).
  // Casting a 'boss' row to LivePin would have made this file claim the page
  // renders something it cannot; folding every other kind to the mark the
  // renderer actually uses says the true thing instead, and `pinKind` keeps the
  // real value for the callers that care which is which. Teaching the map a
  // third glyph is a change to those components, not to this cast.
  const rows = (data ?? []) as (Omit<LivePin, 'kind'> & { kind: PinKind })[];
  return rows.map((p) => ({
    ...p,
    kind: p.kind === 'base' ? ('base' as const) : ('poi' as const),
    pinKind: p.kind,
  }));
});

/**
 * Pins as the Saga episode builder needs them: name + kind + author + the
 * created_at instant, so each place can be bucketed to its America/Chicago
 * calendar day. Oldest first. Separate from getPins() (which powers the live
 * map and omits created_at) so neither caller drags the other's columns.
 */
export const getPinsForEpisodes = cache(async (days = 70): Promise<
  { name: string; kind: string | null; by_character_name: string | null; created_at: string }[]
> => {
  const since = windowStartIso(days);
  const { data } = await db()
    .from('pins')
    .select('name, kind, by_character_name, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(2000);
  return (
    (data as { name: string; kind: string | null; by_character_name: string | null; created_at: string }[]) ??
    []
  );
});

/** The sworn oaths, oldest first (the Oath page + Hall teaser). */
export const getOaths = cache(async (): Promise<Oath[]> => {
  const { data } = await db()
    .from('oaths')
    .select('*')
    .order('sworn_at', { ascending: true })
    .limit(100);
  return (data as Oath[]) ?? [];
});

/** All sessions from the last `days` days, oldest first (attendance calendar, episodes). */
export const getSessionsSince = cache(async (days = 70): Promise<GameSession[]> => {
  const since = windowStartIso(days);
  const { data } = await db()
    .from('sessions')
    .select('*')
    .gte('joined_at', since)
    .order('joined_at', { ascending: true })
    .limit(2000);
  return (data as GameSession[]) ?? [];
});

/**
 * Live-computed total playtime per character, in minutes, from session rows.
 *
 * The `players.total_playtime_minutes` column is only as fresh as whatever
 * last wrote it (historically the demo seed); the real log-poller pipeline
 * doesn't currently maintain it, so it reads back as 0 for every real viking
 * even though sessions with real durations exist. Deriving it here from the
 * sessions the pages already fetch keeps "Hours Logged" / "Total Time"
 * truthful without touching the poller.
 *
 * Sessions with a `duration_minutes` are trusted as-is. A session still open
 * (`left_at` null) only counts elapsed time (`joined_at` -> now) if the
 * character is *currently online* per `players.is_online` — i.e. it's
 * genuinely their live session. Any other open session (the poller missed a
 * `leave`, so it never closed) is dropped rather than guessed at — crediting
 * it with elapsed real time would count an overnight AFK/disconnect, or a
 * stale session left behind by a since-ended one, as active playtime.
 *
 * @param onlineNames character_names currently online (from the `players`
 *   table), used to decide which open session, if any, is still live.
 */
export function playtimeMinutesByCharacter(
  sessions: GameSession[],
  onlineNames: ReadonlySet<string> = new Set()
): Map<string, number> {
  const byName = new Map<string, GameSession[]>();
  for (const s of sessions) {
    if (!s.character_name) continue;
    const arr = byName.get(s.character_name) ?? [];
    arr.push(s);
    byName.set(s.character_name, arr);
  }

  const now = Date.now();
  const totals = new Map<string, number>();
  for (const [name, list] of byName) {
    const sorted = [...list].sort(
      (a, b) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime()
    );
    let total = 0;
    sorted.forEach((s, i) => {
      if (s.duration_minutes != null) {
        total += s.duration_minutes;
        return;
      }
      // Open session: only the most recent one, for a character currently
      // online, counts as live. Earlier/stale dangling opens are unknown
      // duration — skip rather than overcount.
      if (i === sorted.length - 1 && onlineNames.has(name)) {
        total += Math.max(0, Math.round((now - new Date(s.joined_at).getTime()) / 60_000));
      }
    });
    totals.set(name, total);
  }
  return totals;
}

/** Events from the last `days` days, oldest first; optionally filtered by type. */
export const getEventsSince = cache(async (days = 70, types?: string[]): Promise<GameEvent[]> => {
  const since = windowStartIso(days);
  let q = db().from('events').select('*').gte('created_at', since);
  if (types?.length) q = q.in('type', types);
  const { data } = await q.order('created_at', { ascending: true }).limit(2000);
  return (data as GameEvent[]) ?? [];
});

/**
 * Sessions still open (no `left_at`).
 *
 * NO CALLERS TODAY (checked 2026-09-06: `grep -rn getActiveSessions` over
 * *.ts/*.tsx outside node_modules returns only this definition). The perf pass
 * wrapped it in cache() and bounded it along with its neighbours, which is
 * harmless but makes the limit below look load-bearing when it is not. Kept
 * because open-session state is a thing the ops cockpit keeps almost needing;
 * delete it freely if it is still unused after launch.
 */
export const getActiveSessions = cache(async (): Promise<GameSession[]> => {
  const { data } = await db()
    .from('sessions')
    .select('*')
    .is('left_at', null)
    .order('joined_at', { ascending: false })
    // Open sessions should never outnumber the player cap. Two hundred is
    // already proof the poller has been missing `leave` lines, and reading ten
    // thousand of them would say nothing the first two hundred do not.
    .limit(200);
  return (data as GameSession[]) ?? [];
});

export const getBosses = cache(async (): Promise<Boss[]> => {
  const { data } = await db().from('bosses').select('*').order('sort_order');
  return (data as Boss[]) ?? [];
});

// Explicit column list for public telling reads: every boss_tellings column
// EXCEPT `author_discord_id`, which is the Discord account of whoever told it.
// Paired with a REVOKE SELECT ... / GRANT SELECT (cols) migration exactly like
// PLAYERS_PUBLIC_COLS above, so this is not merely tidy: `select('*')` here
// would fail outright with "permission denied for column author_discord_id".
const BOSS_TELLINGS_PUBLIC_COLS = 'id, boss_id, author_character, text, source, chosen, created_at';
// The same list plus `standing`, which arrived in a LATER migration
// (db/2026-09-06_telling_votes.sql). Named separately rather than appended,
// because a column that does not exist yet makes the whole read fail: the
// query below asks for this one first and falls back to the list above.
const BOSS_TELLINGS_PUBLIC_COLS_V2 = `${BOSS_TELLINGS_PUBLIC_COLS}, standing`;

/**
 * The tellings of one boss's fall (db/2026-09-06_boss_tellings.sql): the
 * `chosen` one FIRST, then the rest newest first. The war-room shows the first
 * and collapses the rest.
 *
 * BOUNDED AT 20 because the rows are player-written and unbounded in number: a
 * boss retold two hundred times must not turn its war-room into a two-hundred
 * paragraph page. The Discord side lists the same 20 in the same order, so
 * `@Eilif keep <Boss> <n>` can always name what the page can show.
 *
 * CHOSEN FIRST IS WHAT MAKES THE BOUND SAFE. Ordering by date alone would let a
 * deliberately kept telling age out of the window once twenty newer ones
 * arrived, and the page would quietly go back to showing the newest — silently
 * undoing `@Eilif keep`, which is the one thing this feature exists to do.
 *
 * TOLERATES THE TABLE NOT EXISTING. This migration is unapplied at the time of
 * writing and is applied by hand, so the deployed site must render correctly
 * against a database without it: PostgREST answers PGRST205 ("Could not find
 * the table ... in the schema cache") and psql answers 42P01, and either way
 * this returns [] and the page falls back to `bosses.retelling` exactly as it
 * did before. Every other error (a network blip, a revoked grant) takes the
 * same path for the same reason: a war-room that renders without its saga is
 * better than one that does not render.
 */
export const getBossTellings = cache(async (bossId: string): Promise<BossTelling[]> => {
  if (!bossId) return [];
  const read = (cols: string) =>
    db()
      .from('boss_tellings')
      .select(cols)
      .eq('boss_id', bossId)
      .order('chosen', { ascending: false })
      .order('created_at', { ascending: false })
      // Tie-break on id, so two tellings written in the same second are ordered
      // the same way here and in the bot's numbered list.
      .order('id', { ascending: false })
      .limit(20);

  // TWO MIGRATIONS, ONE READ. `standing` belongs to db/2026-09-06_telling_votes
  // .sql, which can be applied long after the table itself. Asking for a column
  // that does not exist fails the WHOLE query, so a war-room that named it
  // unconditionally would lose every telling on the page the moment the second
  // file was late. Ask for it, and on any error ask again without it: the only
  // thing a hall running one migration loses is the apocryphal heading.
  const withStanding = await read(BOSS_TELLINGS_PUBLIC_COLS_V2);
  if (!withStanding.error) return (withStanding.data as unknown as BossTelling[]) ?? [];
  const { data, error } = await read(BOSS_TELLINGS_PUBLIC_COLS);
  if (error) return [];
  return (data as unknown as BossTelling[]) ?? [];
});

// Explicit column list for public office reads: every offices column EXCEPT
// `holder_discord_id`, which is the Discord account behind the office. Paired
// with the REVOKE SELECT ... / GRANT SELECT (cols) in db/2026-09-06_offices.sql
// exactly like BOSS_TELLINGS_PUBLIC_COLS above, so `select('*')` here would
// fail outright with "permission denied for column holder_discord_id".
const OFFICES_PUBLIC_COLS = 'id, office, holder_character, since, until, elected_by, act, created_at';

/**
 * The roll of hall offices (db/2026-09-06_offices.sql), newest term first.
 *
 * ONE READ SERVES BOTH READERS. A viking's page needs to know whether they hold
 * the office now and whether they have held it before; a war-room needs the
 * current holder's name. Both are answered from the same short list by the pure
 * helpers in components/viking/office.ts, rather than by two queries that could
 * disagree with each other inside one render.
 *
 * BOUNDED AT 50 because a term is a deliberate act and fifty of them is more
 * saga than this server will ever have. Newest first, so the cap drops ancient
 * history rather than the term that is actually open.
 *
 * TOLERATES THE TABLE NOT EXISTING, for the same reason getBossTellings does:
 * this migration is applied by hand, and a site rendered against a database
 * without it must simply show no office rather than fail to render.
 */
export const getOffices = cache(async (): Promise<Office[]> => {
  const { data, error } = await db()
    .from('offices')
    .select(OFFICES_PUBLIC_COLS)
    .order('since', { ascending: false })
    .limit(50);
  if (error) return [];
  return (data as unknown as Office[]) ?? [];
});

/**
 * Upcoming community events for the dashboard. Recurring rows (recurrence_days)
 * are rolled forward to their next future occurrence, so weekly nights never
 * look stale; one-offs that have passed are dropped (unless still active).
 * Sorted soonest-first.
 */
export const getUpcomingEvents = cache(async (limit = 10): Promise<UpcomingEvent[]> => {
  const { data } = await db()
    .from('discord_events')
    .select('*')
    .in('status', ['scheduled', 'active'])
    .order('starts_at', { ascending: true });

  const rows = (data as DiscordEvent[]) ?? [];
  const now = Date.now();
  const DAY = 86_400_000;
  const upcoming: UpcomingEvent[] = [];

  for (const ev of rows) {
    let nextMs = new Date(ev.starts_at).getTime();
    if (ev.recurrence_days && ev.recurrence_days > 0) {
      // advance to the next occurrence at or after now
      if (nextMs < now) {
        const step = ev.recurrence_days * DAY;
        nextMs += Math.ceil((now - nextMs) / step) * step;
      }
    } else if (nextMs < now) {
      // a one-off in the past — keep only while it's still ongoing
      const ongoing =
        ev.status === 'active' || (ev.ends_at != null && new Date(ev.ends_at).getTime() > now);
      if (!ongoing) continue;
    }
    upcoming.push({ ...ev, next_at: new Date(nextMs).toISOString() });
  }

  upcoming.sort((a, b) => new Date(a.next_at).getTime() - new Date(b.next_at).getTime());
  return upcoming.slice(0, limit);
});

/**
 * The single soonest gathering, for the nav bar's pill.
 *
 * The nav renders inside the root layout, i.e. on EVERY route — including the
 * two pages that are prerendered at build time (/mods, /get-started). An
 * uncached read here would drag both of them into per-request rendering, so
 * this one goes through the data cache with a five-minute life. Every other
 * page already sets `dynamic = 'force-dynamic'` and is unaffected.
 */
export const getNextEvent = unstable_cache(
  async (): Promise<UpcomingEvent | null> => {
    const [next] = await getUpcomingEvents(1);
    return next ?? null;
  },
  ['nav-next-event'],
  { revalidate: 300, tags: ['discord-events'] }
);

export const getGalleryPhotos = cache(async (limit = 60): Promise<GalleryPhoto[]> => {
  // Embed the linked map pin (place name) so the Gallery can show a place tag.
  // Falls back to a plain select if the pin_id column/FK isn't live yet
  // (db/2026-07-04_gallery_pin_link.sql not applied), so pages never crash.
  const withPin = await db()
    .from('gallery_photos')
    .select('*, pin:pins(name, kind)')
    .order('posted_at', { ascending: false })
    .limit(limit);
  if (!withPin.error) return (withPin.data as GalleryPhoto[]) ?? [];

  const { data } = await db()
    .from('gallery_photos')
    .select('*')
    .order('posted_at', { ascending: false })
    .limit(limit);
  return (data as GalleryPhoto[]) ?? [];
});

export interface PinPhoto {
  id: string;
  url: string;
  caption: string | null;
  posted_by: string | null;
  posted_at: string;
}

/**
 * Photos linked to a map pin, keyed by pin_id — powers the map's place panel.
 * Returns an empty map if the pin_id column isn't live yet (pre-migration).
 */
export const getPhotosByPin = cache(async (): Promise<Record<string, PinPhoto[]>> => {
  const { data, error } = await db()
    .from('gallery_photos')
    .select('id, url, caption, posted_by, posted_at, pin_id')
    .not('pin_id', 'is', null)
    .order('posted_at', { ascending: true })
    .limit(1000);
  if (error || !data) return {};
  const byPin: Record<string, PinPhoto[]> = {};
  for (const row of data as (PinPhoto & { pin_id: string })[]) {
    (byPin[row.pin_id] ??= []).push({
      id: row.id,
      url: row.url,
      caption: row.caption,
      posted_by: row.posted_by,
      posted_at: row.posted_at,
    });
  }
  return byPin;
});

/**
 * Player-of-the-Day archive (newest first). The bot writes one row per evening
 * recap; the Vikings page renders a log + derives a "most crowned" tally.
 */
export const getPotyArchive = cache(async (limit = 120): Promise<PotyHistoryEntry[]> => {
  const { data } = await db()
    .from('poty_history')
    .select('*')
    .order('awarded_at', { ascending: false })
    .limit(limit);
  return (data as PotyHistoryEntry[]) ?? [];
});

/**
 * Collective Milestones ("Great Deeds"), ordered for display. Returns [] when
 * the table isn't live yet (db/2026-07-05_milestones.sql not applied) so the
 * Hall + World surfaces render an empty state instead of crashing.
 */
export const getMilestones = cache(async (): Promise<Milestone[]> => {
  const { data, error } = await db().from('milestones').select('*').order('sort', { ascending: true });
  if (error) return []; // pre-migration (missing table) — degrade to empty
  return (data as Milestone[]) ?? [];
});

/**
 * The live server-wide aggregate for every milestone metric, computed with the
 * SAME pure maths as the evaluator (lib/milestones), so the dashboard's progress
 * bars match what the evaluator will fire. One batch of reads: all player_stats,
 * a wide window of sessions (for the playtime derivation), and the online roster.
 */
async function loadMilestoneAggregates(): Promise<Aggregates> {
  const [statsRes, sessions, online, bosses] = await Promise.all([
    // Only the columns the metrics actually read (AGGREGATE_STAT_COLUMNS). The
    // wide `select('*')` this replaced carried every player's whole gs_stats
    // blob twice over: measured at 12.8 KB for five vikings, i.e. ~51 KB at a
    // full hall of twenty, on a card that renders eight progress bars.
    db().from('player_stats').select(AGGREGATE_STAT_COLUMNS),
    getSessionsSince(400),
    getOnlinePlayers(),
    // boss_kills_total counts DISTINCT Forsaken felled (bosses.is_killed), not
    // the sum of each viking's repeatable boss-kill counter — see
    // AggregateInput.bossesKilled. Fetched here so the /world progress bars show
    // exactly the number the evaluator will fire on.
    getBosses(),
  ]);
  const stats = (statsRes.data as Record<string, unknown>[] | null) ?? [];
  const onlineNames = new Set(online.map((p) => p.character_name));
  const bossesKilled = bosses.filter((b) => b.is_killed).length;
  return computeAggregates({ stats, sessions, onlineNames, bossesKilled });
}

/**
 * ONE MINUTE OF STALENESS, DELIBERATELY (2026-09-06).
 *
 * This is the most expensive read on the site — four queries, one of them four
 * hundred days of sessions — and it is on the Hall, which every open tab
 * re-renders every sixty seconds by itself (components/home/AutoRefresh). Twenty
 * vikings plus their friends with the Hall open is a few hundred of these an
 * hour, all computing the same eight numbers, against a Supabase free plan whose
 * egress is the budget that runs out first.
 *
 * What the reader loses: a Great Deed progress bar can sit up to 60 s behind.
 * Nothing on the page announces a deed — `getMilestones()` (uncached) supplies
 * the achieved rows and the Discord bot owns the announcement — so the worst
 * visible effect is a bar reading 97 % for another minute. The live half of the
 * Hall (who is sailing, the server pulse, the saga feed) is untouched and still
 * read fresh on every request.
 */
export const getMilestoneAggregates = unstable_cache(
  loadMilestoneAggregates,
  ['milestone-aggregates'],
  { revalidate: 60, tags: ['milestones'] },
);
