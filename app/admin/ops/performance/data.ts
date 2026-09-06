// SERVER-ONLY reads for the Performance tab.
//
// This is the thin I/O half of the split docs/OPS-COCKPIT-V2.md §3 requires: the
// arithmetic lives in lib/ops/performance.ts (pure, 187 assertions), and nothing
// in here does any of it beyond assembling rows into the shapes those functions
// take. Keeping the two apart is what lets the whole tab be tested without a
// database, and it is why this file is deliberately boring.
//
// EVERY READ IS BOUNDED TWICE: a time window and an explicit .limit(), never
// above ROW_LIMIT. Counts use head:true so they transfer no rows at all. Nothing
// here writes, and nothing here issues a POST: the storage figures come from
// public-object HEADs and a bucket GET rather than the Storage API's list()
// (which is a POST), and the optional exact-size RPC is called with `get: true`
// so it is a GET too. The cockpit is observational and stays that way at the
// protocol level, not just by intention.
//
// TWO WAVES, NOT A CHAIN. Everything that can be asked for at once is asked for
// at once; only the storage object HEADs run second, because which objects to
// ask about is the answer to a first-wave read (the frames manifest and the
// newest gallery rows).
//
// AND TWO OF THE WAVES ARE CACHED, WHICH THE PAGE MEASURED ITS WAY INTO. The
// first cut issued 47 requests per render and the tab's own cost panel reported
// 2914 ms against a 2500 ms budget, from this machine, against production, with
// nobody online. Two groups were the bulk of it and neither needed to be live:
//
//   • the twenty head-only row counts, cached 60 s. They answer "how full is the
//     500 MB plan", and a minute-old exact count cannot change that answer.
//   • the storage measurement, cached 300 s. It reads objects that eilif-map-
//     snapshot rewrites every five minutes, so measuring more often than that
//     cannot produce a different number.
//
// Both return the instant they were computed, so the page prints how old each
// group is rather than implying it was measured just now, and the cost panel
// counts a cached group's requests only on the render that actually issued
// them. The remaining live reads are the ones where staleness would be a lie.

import 'server-only';
import { unstable_cache } from 'next/cache';
import { opsServiceClient, readTracker, safeRead } from '@/lib/ops/client';
import { COMPONENTS, type HeartbeatRow } from '@/lib/ops/health';
import { ROW_LIMIT, WINDOW_24H_MS, WINDOW_7D_MS, sinceIso, toMs } from '@/lib/ops/window';
import { MAP_STALE_AFTER_MS, STATS_STALE_AFTER_MS, mapFreshness } from '@/lib/data';
import type { LagRowLike, SessionRowLike, VoiceRowLike, BossRowLike } from '@/lib/ops/performance';

/**
 * The tables the budget panel counts.
 *
 * FIXED ON PURPOSE, and this is the maintenance cost of the panel: a table added
 * to db/ that is not added here goes uncounted, and the estimate quietly reads
 * low. The panel prints the list length beside the total so the omission is at
 * least visible. Ordered as in db/0000_initial_schema.sql and then by migration
 * date, so a reader can diff it against the directory listing.
 */
export const BUDGET_TABLES = [
  'players',
  'sessions',
  'events',
  'player_stats',
  'bosses',
  'roadmap',
  'server_status',
  'discord_events',
  'gallery_photos',
  'poty_history',
  'oaths',
  'voice_lines',
  'pins',
  'milestones',
  'title_history',
  'chat_lines',
  'player_positions',
  'ops_heartbeats',
  'identity_claims',
  'ops_alerts',
] as const;

/**
 * Newest gallery objects to weigh, and day frames to sample from the manifest.
 * Every one is an HTTP HEAD, so these are the two numbers that decide what the
 * storage measurement costs. Kept low because the values they feed are averaged
 * anyway: a fourth sampled day frame does not make the extrapolation better.
 */
const GALLERY_SAMPLE = 5;
const MAP_FRAME_SAMPLE = 2;

/** How long a cached group may be reused. See the header for the reasoning. */
const COUNTS_TTL_SEC = 60;
const STORAGE_TTL_SEC = 300;

/** The budget this page measures itself against (docs/OPS-COCKPIT-V2.md §7). */
export const PERF_RENDER_BUDGET_MS = 2500;

export interface StorageBucketReport {
  bucket: string;
  /** Whether the bucket exists at all, per GET /storage/v1/bucket. */
  present: boolean;
  /** Objects the estimate is built from. Null when it could not be counted. */
  objects: number | null;
  /** Estimated total bytes. Null when nothing could be weighed. */
  bytes: number | null;
  /** How many objects were actually measured (the rest are extrapolated). */
  sampled: number;
  /** One line saying how the number was arrived at. Printed on the panel. */
  method: string;
}

export interface HeartbeatLogRow {
  component: string;
  sampled_at: string;
  age_sec: number | null;
}

/** What the cached storage group returns, including when it was measured. */
interface StorageGroup {
  storage: StorageBucketReport[];
  mapStatusLastModified: string | null;
  newestGalleryAt: string | null;
  requests: number;
  measuredAtMs: number;
}

/** What the cached row-count group returns. */
interface CountsGroup {
  counts: Record<string, number | null>;
  requests: number;
  measuredAtMs: number;
}

export interface PerformanceData {
  nowMs: number;
  /** False when the service role is unconfigured: the page says so and renders. */
  configured: boolean;

  /** events over 7 d, newest first. Serves lag, ingest rate, deaths and growth. */
  events: LagRowLike[];
  eventsTruncated: boolean;
  /** sessions over 7 d, plus any still open. */
  sessions: SessionRowLike[];
  /** voice_lines queued inside 7 d. */
  voiceWindow: VoiceRowLike[];
  /** Every line still queued, at any age. */
  voiceQueued: VoiceRowLike[];
  /** Great Deeds, for announce latency. */
  milestones: { title: string | null; achieved_at: string | null; announced_at: string | null }[];
  /** Oaths, for announce latency. */
  oaths: { character_name: string | null; sworn_at: string | null; announced_at: string | null }[];
  heartbeats: HeartbeatRow[];
  bosses: BossRowLike[];
  serverStatusUpdatedAt: string | null;

  /** Row counts per table, null where the count could not be read. */
  tableCounts: Record<string, number | null>;
  /** Age of those counts in seconds: they are cached, and the panel says so. */
  countsAgeSec: number;
  /** Newest row behind each public surface, for the freshness ladder. */
  newestGalleryAt: string | null;
  mapStatusLastModified: string | null;
  mapStale: boolean;
  statsStaleAfterSec: number;
  mapStaleAfterSec: number;

  storage: StorageBucketReport[];
  /** Age of the storage measurement in seconds. */
  storageAgeSec: number;
  /** Bytes reported by db/2026-09-06_ops_db_size_rpc.sql, when it is applied. */
  exactDbBytes: number | null;
  exactStorageBytes: number | null;

  /** Heartbeat history, when db/2026-09-06_ops_heartbeat_log.sql is applied. */
  heartbeatLog: HeartbeatLogRow[];
  heartbeatLogPresent: boolean;

  fetchMs: number;
  /** Requests actually issued on THIS render. Cached groups count zero. */
  queries: number;
  /** Requests a cached group made when it was last computed, for context. */
  cachedQueries: number;
  rowsRead: number;
  storageRequests: number;
  /**
   * Live reads that did not come back, by table name. Empty is healthy.
   *
   * A refused query resolves rather than throwing, so without this a broken
   * read renders as a percentile of "no data" and a count of zero, which is
   * what a healthy quiet week also looks like. See readTracker in
   * lib/ops/client.ts.
   */
  failedReads: string[];
}

/** An empty bundle, so an unconfigured cockpit renders a page and not a 500. */
function emptyData(nowMs: number, fetchMs: number): PerformanceData {
  return {
    nowMs,
    configured: false,
    events: [],
    eventsTruncated: false,
    sessions: [],
    voiceWindow: [],
    voiceQueued: [],
    milestones: [],
    oaths: [],
    heartbeats: [],
    bosses: [],
    serverStatusUpdatedAt: null,
    tableCounts: Object.fromEntries(BUDGET_TABLES.map((t) => [t, null])),
    countsAgeSec: 0,
    newestGalleryAt: null,
    mapStatusLastModified: null,
    mapStale: true,
    statsStaleAfterSec: STATS_STALE_AFTER_MS / 1000,
    mapStaleAfterSec: MAP_STALE_AFTER_MS / 1000,
    storage: [],
    storageAgeSec: 0,
    exactDbBytes: null,
    exactStorageBytes: null,
    heartbeatLog: [],
    heartbeatLogPresent: false,
    fetchMs,
    queries: 0,
    cachedQueries: 0,
    rowsRead: 0,
    storageRequests: 0,
    // Unconfigured is not a failed read: the page says so above, once.
    failedReads: [],
  };
}

/** Content-Length from a HEAD, or null. Never throws, never reads a body. */
async function headBytes(url: string): Promise<{ bytes: number | null; lastModified: string | null }> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return { bytes: null, lastModified: null };
    const len = res.headers.get('content-length');
    const n = len === null ? null : Number.parseInt(len, 10);
    return {
      bytes: n !== null && Number.isFinite(n) ? n : null,
      lastModified: res.headers.get('last-modified'),
    };
  } catch {
    return { bytes: null, lastModified: null };
  }
}

/** Pick up to `n` evenly spread members of a list, always including the ends. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  if (n <= 0) return [];
  if (n === 1) return [items[items.length - 1]];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  }
  return [...new Set(out)];
}

const meanOf = (xs: (number | null)[]): number | null => {
  const clean = xs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return clean.length === 0 ? null : clean.reduce((a, b) => a + b, 0) / clean.length;
};

// ════════════════════════════════════════════════════════════════════════════
// The two cached groups
// ════════════════════════════════════════════════════════════════════════════

/**
 * Exact row counts for every table in BUDGET_TABLES, cached for COUNTS_TTL_SEC.
 *
 * head:true means each of these transfers a COUNT and no rows at all. They are
 * issued together so the group costs one round trip's latency rather than
 * twenty, and the whole group is then reused for a minute: the question it feeds
 * is "how full is a 500 MB plan", which a sixty-second-old exact count answers
 * exactly as well as a fresh one.
 */
const loadTableCounts = unstable_cache(
  async (): Promise<CountsGroup> => {
    const client = opsServiceClient();
    if (!client) {
      return {
        counts: Object.fromEntries(BUDGET_TABLES.map((t) => [t, null])),
        requests: 0,
        measuredAtMs: Date.now(),
      };
    }
    const pairs = await Promise.all(
      BUDGET_TABLES.map((table) =>
        safeRead(async () => {
          const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
          if (error) return [table, null] as const;
          return [table, count ?? null] as const;
        }, [table, null] as readonly [string, number | null]),
      ),
    );
    return {
      counts: Object.fromEntries(pairs) as Record<string, number | null>,
      requests: BUDGET_TABLES.length,
      measuredAtMs: Date.now(),
    };
  },
  ['ops-perf-table-counts'],
  { revalidate: COUNTS_TTL_SEC, tags: ['ops-perf'] },
);

/**
 * Both storage buckets weighed, cached for STORAGE_TTL_SEC.
 *
 * SAMPLED, AND IT SAYS SO ON THE PANEL. There is no GET route that returns a
 * bucket's total size: object listing is a POST and this page issues none, so
 * the map bucket is weighed by measuring current.webp and status.json directly
 * and extrapolating the per-day archive from a couple of sampled days, and the
 * gallery by measuring the newest photos and averaging over the row count.
 *
 * Cached for five minutes because eilif-map-snapshot rewrites these objects
 * every five minutes: measuring more often cannot produce a different number,
 * and each measurement is a dozen HTTP round trips.
 */
const loadStorage = unstable_cache(
  async (): Promise<StorageGroup> => {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const mapPublic = `${base}/storage/v1/object/public/map`;
    const client = opsServiceClient();
    let requests = 0;

    const [buckets, manifest, current, status, gallery, galleryCount] = await Promise.all([
      // The one Storage endpoint that answers over GET. Object listing is a POST
      // and is deliberately not used anywhere on this page.
      safeRead(async () => {
        requests++;
        const res = await fetch(`${base}/storage/v1/bucket`, {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`,
          },
          cache: 'no-store',
        });
        if (!res.ok) return [] as { id: string }[];
        return (await res.json()) as { id: string }[];
      }, [] as { id: string }[]),

      safeRead(async () => {
        requests++;
        const res = await fetch(`${mapPublic}/frames-manifest.json`, { cache: 'no-store' });
        if (!res.ok) return null;
        return (await res.json()) as { days?: number[] };
      }, null as { days?: number[] } | null),

      (async () => {
        requests++;
        return headBytes(`${mapPublic}/current.webp`);
      })(),

      (async () => {
        requests++;
        return headBytes(`${mapPublic}/status.json`);
      })(),

      safeRead(async () => {
        if (!client) return [];
        requests++;
        const { data } = await client
          .from('gallery_photos')
          .select('url, posted_at')
          .order('posted_at', { ascending: false })
          .limit(GALLERY_SAMPLE);
        return (data ?? []) as { url: string | null; posted_at: string | null }[];
      }, [] as { url: string | null; posted_at: string | null }[]),

      safeRead(async () => {
        if (!client) return null;
        requests++;
        const { count, error } = await client.from('gallery_photos').select('*', { count: 'exact', head: true });
        return error ? null : (count ?? null);
      }, null as number | null),
    ]);

    const days = Array.isArray(manifest?.days) ? (manifest.days as number[]) : [];
    const sampleDays = spread(days, MAP_FRAME_SAMPLE);
    const urls = gallery.map((g) => g.url).filter((u): u is string => typeof u === 'string' && u.length > 0);

    const [frameSizes, fogSizes, gallerySizes] = await Promise.all([
      Promise.all(
        sampleDays.map((d) => {
          requests++;
          return headBytes(`${mapPublic}/frames-by-day/day-${String(d).padStart(4, '0')}.webp`);
        }),
      ),
      Promise.all(
        sampleDays.map((d) => {
          requests++;
          return headBytes(`${mapPublic}/frames-fog/day-${String(d).padStart(4, '0')}.png`);
        }),
      ),
      Promise.all(
        urls.map((u) => {
          requests++;
          return headBytes(u);
        }),
      ),
    ]);

    const bucketIds = new Set(buckets.map((b) => b.id));
    const meanFrame = meanOf(frameSizes.map((f) => f.bytes));
    const meanFog = meanOf(fogSizes.map((f) => f.bytes));
    const fixedMapBytes = (current.bytes ?? 0) + (status.bytes ?? 0);
    const mapBytes =
      days.length === 0
        ? current.bytes
        : meanFrame === null && meanFog === null
          ? null
          : fixedMapBytes + days.length * ((meanFrame ?? 0) + (meanFog ?? 0));

    const meanPhoto = meanOf(gallerySizes.map((g) => g.bytes));
    const galleryBytes = meanPhoto === null || galleryCount === null ? null : meanPhoto * galleryCount;
    const weighed = gallerySizes.filter((g) => g.bytes !== null).length;

    return {
      storage: [
        {
          bucket: 'map',
          present: bucketIds.has('map'),
          objects: days.length === 0 ? null : days.length * 2 + 3,
          bytes: mapBytes,
          sampled: 2 + frameSizes.length + fogSizes.length,
          method:
            days.length === 0
              ? 'current.webp weighed directly. No frames manifest, so the day archive could not be counted.'
              : `current.webp and status.json weighed directly. ${days.length} in-game days of frames, ` +
                `estimated from ${sampleDays.length} sampled day frame${sampleDays.length === 1 ? '' : 's'} ` +
                'and the matching fog masks.',
        },
        {
          bucket: 'gallery',
          present: bucketIds.has('gallery'),
          objects: galleryCount,
          bytes: galleryBytes,
          sampled: weighed,
          method:
            galleryCount === null
              ? 'gallery_photos could not be counted, so nothing could be extrapolated.'
              : `${weighed} of the newest photos weighed directly, then averaged across the ` +
                `${galleryCount} gallery_photos row${galleryCount === 1 ? '' : 's'}.`,
        },
      ],
      mapStatusLastModified: status.lastModified ? new Date(status.lastModified).toISOString() : null,
      newestGalleryAt: gallery[0]?.posted_at ?? null,
      requests,
      measuredAtMs: Date.now(),
    };
  },
  ['ops-perf-storage'],
  { revalidate: STORAGE_TTL_SEC, tags: ['ops-perf'] },
);

// ════════════════════════════════════════════════════════════════════════════
// The live reads
// ════════════════════════════════════════════════════════════════════════════

export async function loadPerformanceData(): Promise<PerformanceData> {
  const startedAt = performance.now();
  const nowMs = Date.now();
  const client = opsServiceClient();
  if (!client) return emptyData(nowMs, performance.now() - startedAt);

  const since7d = sinceIso(nowMs, WINDOW_7D_MS);
  let queries = 0;
  // Every live read below names itself here, so a query PostgREST refuses reads
  // as "this table did not answer" rather than as an empty table. The cached
  // count and storage groups are not tracked: both already return null on error
  // and their panels render that as "no data" instead of as a zero.
  const track = readTracker();

  const [
    events,
    sessions,
    voiceWindow,
    voiceQueued,
    milestones,
    oaths,
    heartbeats,
    bosses,
    serverStatus,
    heartbeatLog,
    exact,
    countsGroup,
    storageGroup,
  ] = await Promise.all([
    // events over 7 d. Ordered by inserted_at (the indexed insertion-order
    // column) rather than created_at, so this is the same index scan the relay
    // uses and any truncation cut falls on the OLDEST rows.
    track.read('events', async () => {
      queries++;
      const { data, error } = await client
        .from('events')
        .select('type, character_name, created_at, inserted_at, metadata')
        .gte('inserted_at', since7d)
        .order('inserted_at', { ascending: false })
        .limit(ROW_LIMIT);
      track.noteError('events', error);
      return (data ?? []) as LagRowLike[];
    }, [] as LagRowLike[]),

    // Sessions that started inside the window, plus every session still open at
    // any age: an open session is what a concurrency sweep needs, and an old one
    // is what a leak looks like.
    track.read('sessions', async () => {
      queries += 2;
      const [inWindow, open] = await Promise.all([
        client
          .from('sessions')
          .select('character_name, joined_at, left_at')
          .gte('joined_at', since7d)
          .order('joined_at', { ascending: false })
          .limit(ROW_LIMIT),
        client
          .from('sessions')
          .select('character_name, joined_at, left_at')
          .is('left_at', null)
          .order('joined_at', { ascending: false })
          .limit(200),
      ]);
      const seen = new Set<string>();
      const merged: SessionRowLike[] = [];
      for (const r of [...(inWindow.data ?? []), ...(open.data ?? [])] as SessionRowLike[]) {
        const key = `${r.character_name ?? ''}|${r.joined_at ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
      // Two queries under one name: either one failing loses rows from the
      // same set, so either one failing is the whole read failing.
      track.noteError('sessions', inWindow.error ?? open.error);
      return merged;
    }, [] as SessionRowLike[]),

    track.read('voice_lines (window)', async () => {
      queries++;
      const { data, error } = await client
        .from('voice_lines')
        .select('kind, status, queued_at, spoken_at, meta')
        .gte('queued_at', since7d)
        .order('queued_at', { ascending: false })
        .limit(ROW_LIMIT);
      track.noteError('voice_lines (window)', error);
      return (data ?? []) as VoiceRowLike[];
    }, [] as VoiceRowLike[]),

    track.read('voice_lines (queued)', async () => {
      queries++;
      const { data, error } = await client
        .from('voice_lines')
        .select('kind, status, queued_at, spoken_at, meta')
        .eq('status', 'queued')
        .order('queued_at', { ascending: true })
        .limit(100);
      track.noteError('voice_lines (queued)', error);
      return (data ?? []) as VoiceRowLike[];
    }, [] as VoiceRowLike[]),

    // milestones is a definition table of a few dozen rows, so the whole
    // achieved set is cheaper than a windowed read, and the announce lag of an
    // old deed still matters.
    track.read('milestones', async () => {
      queries++;
      const { data, error } = await client
        .from('milestones')
        .select('title, achieved_at, announced_at')
        .not('achieved_at', 'is', null)
        .order('achieved_at', { ascending: false })
        .limit(50);
      track.noteError('milestones', error);
      return (data ?? []) as PerformanceData['milestones'];
    }, [] as PerformanceData['milestones']),

    track.read('oaths', async () => {
      queries++;
      const { data, error } = await client
        .from('oaths')
        .select('character_name, sworn_at, announced_at')
        .order('sworn_at', { ascending: false })
        .limit(200);
      track.noteError('oaths', error);
      return (data ?? []) as PerformanceData['oaths'];
    }, [] as PerformanceData['oaths']),

    track.read('ops_heartbeats', async () => {
      queries++;
      const { data, error } = await client
        .from('ops_heartbeats')
        .select('component, status, last_success, last_attempt, error_summary, metrics, version, instance, updated_at')
        .limit(20);
      track.noteError('ops_heartbeats', error);
      return (data ?? []) as unknown as HeartbeatRow[];
    }, [] as HeartbeatRow[]),

    track.read('bosses', async () => {
      queries++;
      const { data, error } = await client
        .from('bosses')
        .select('name, sort_order, is_killed, killed_at, fight_stats')
        .order('sort_order', { ascending: true })
        .limit(20);
      track.noteError('bosses', error);
      return (data ?? []) as BossRowLike[];
    }, [] as BossRowLike[]),

    track.read('server_status', async () => {
      queries++;
      const { data, error } = await client.from('server_status').select('is_online, updated_at').limit(1);
      track.noteError('server_status', error);
      return (data?.[0] ?? null) as { is_online: boolean | null; updated_at: string | null } | null;
    }, null as { is_online: boolean | null; updated_at: string | null } | null),

    // Optional history table, absent until db/2026-09-06_ops_heartbeat_log.sql
    // is applied by hand. The read then errors and yields null, and the panel
    // says "no history yet" rather than drawing a flat line at zero.
    safeRead(async () => {
      queries++;
      const { data, error } = await client
        .from('ops_heartbeat_log')
        .select('component, sampled_at, age_sec')
        .gte('sampled_at', sinceIso(nowMs, WINDOW_24H_MS))
        .order('sampled_at', { ascending: true })
        .limit(ROW_LIMIT);
      if (error) return null;
      return (data ?? []) as HeartbeatLogRow[];
    }, null as HeartbeatLogRow[] | null),

    // Optional exact sizes. GET, not POST: the function is declared `stable` in
    // db/2026-09-06_ops_db_size_rpc.sql precisely so PostgREST serves it over
    // GET, which keeps every request this page makes a read at the protocol
    // level. Absent until that migration is applied, and null until then.
    safeRead(async () => {
      queries++;
      const { data, error } = await client.rpc('ops_size_report', {}, { get: true });
      if (error || !data) return null;
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
      if (!row) return null;
      const db = Number(row.database_bytes);
      const st = Number(row.storage_bytes);
      return {
        databaseBytes: Number.isFinite(db) ? db : null,
        storageBytes: Number.isFinite(st) ? st : null,
      };
    }, null as { databaseBytes: number | null; storageBytes: number | null } | null),

    loadTableCounts(),
    loadStorage(),
  ]);

  // A cached group's requests count toward this render only if it actually ran.
  // Comparing its measurement stamp against this render's start is exact: a
  // group served from the cache carries the stamp of the render that computed it.
  const countsRan = countsGroup.measuredAtMs >= nowMs;
  const storageRan = storageGroup.measuredAtMs >= nowMs;

  const rowsRead =
    events.length +
    sessions.length +
    voiceWindow.length +
    voiceQueued.length +
    milestones.length +
    oaths.length +
    heartbeats.length +
    bosses.length +
    (serverStatus ? 1 : 0) +
    (heartbeatLog?.length ?? 0);

  // Map freshness through lib/data.ts's own rule rather than a second one here.
  const { stale: mapStale } = mapFreshness(storageGroup.mapStatusLastModified, nowMs);

  return {
    nowMs,
    configured: true,
    events,
    eventsTruncated: events.length >= ROW_LIMIT,
    sessions,
    voiceWindow,
    voiceQueued,
    milestones,
    oaths,
    heartbeats,
    bosses,
    serverStatusUpdatedAt: serverStatus?.updated_at ?? null,
    tableCounts: countsGroup.counts,
    countsAgeSec: Math.max(0, (nowMs - countsGroup.measuredAtMs) / 1000),
    newestGalleryAt: storageGroup.newestGalleryAt,
    mapStatusLastModified: storageGroup.mapStatusLastModified,
    mapStale,
    statsStaleAfterSec: STATS_STALE_AFTER_MS / 1000,
    mapStaleAfterSec: MAP_STALE_AFTER_MS / 1000,
    storage: storageGroup.storage,
    storageAgeSec: Math.max(0, (nowMs - storageGroup.measuredAtMs) / 1000),
    exactDbBytes: exact?.databaseBytes ?? null,
    exactStorageBytes: exact?.storageBytes ?? null,
    heartbeatLog: heartbeatLog ?? [],
    heartbeatLogPresent: heartbeatLog !== null,
    fetchMs: performance.now() - startedAt,
    queries: queries + (countsRan ? countsGroup.requests : 0) + (storageRan ? storageGroup.requests : 0),
    cachedQueries:
      (countsRan ? 0 : countsGroup.requests) + (storageRan ? 0 : storageGroup.requests),
    rowsRead,
    storageRequests: storageRan ? storageGroup.requests : 0,
    failedReads: track.failed,
  };
}

/** The component registry rows this page draws a pressure gauge for. */
export function gaugeableComponents() {
  return COMPONENTS.filter((c) => c.staleAfterSec > 0);
}

/** Newest `inserted_at` across the rows already in memory. */
export function newestInsertedAt(rows: LagRowLike[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    const t = toMs(r.inserted_at ?? null);
    if (t !== null && t > bestMs) {
      bestMs = t;
      best = r.inserted_at as string;
    }
  }
  return best;
}
