// /admin/ops/performance
//
// How long each hop of the pipeline takes, and how much of the free plan is
// left. Composition only: every read is in ./data.ts, every calculation is in
// lib/ops/performance.ts (pure, 187 assertions), and every panel is a
// presentational component under components/ops/performance/.
//
// WHY THAT SPLIT IS WORTH THE FILE COUNT. This page draws fourteen panels off
// one fetch. Written inline it would be nine hundred lines in which the
// arithmetic, the markup and the I/O were impossible to tell apart, and none of
// the arithmetic would be testable. Split, the whole tab's maths runs in a plain
// .mjs through tsx in under a second, and this file reads as an outline.

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { Gauge as GaugeIcon, BookOpen } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { OpsNav } from '@/components/ops/OpsNav';
import { OpsControls } from '@/components/ops/OpsControls';
import { FailedReads } from '@/components/ops/FailedReads';
import { COOKIE_NAME, verifySession } from '@/lib/ops/auth';
import { COMPONENTS } from '@/lib/ops/health';
import { MAX_PLAYERS } from '@/config/server';
import {
  BUCKET_TZ,
  WINDOW_24H_MS,
  WINDOW_7D_MS,
  ageSecFrom,
  dayBuckets,
  hourBuckets,
  sinceIso,
  toMs,
  windowLabel,
} from '@/lib/ops/window';
import {
  FREE_PLAN_DB_BYTES,
  PERF_PRODUCERS,
  ROW_BYTES,
  announceLatency,
  bossRevRows,
  deathsPerHourPlayed,
  estimateTableBytes,
  freshnessLadder,
  heartbeatPressure,
  lagAudit,
  lagByProducer,
  lagHistogram,
  lagPerBucket,
  lagSeconds,
  lagSummary,
  peakConcurrencyPerBucket,
  percentilePerBucket,
  playedHoursInWindow,
  producerCountsPerBucket,
  producerTotals,
  projectGrowth,
  relayBacklog,
  renderCostFraction,
  rowsPerDay,
  spokenSince,
  voiceQueueHealth,
  withoutBackfilled,
  worstLagRows,
} from '@/lib/ops/performance';
import { loadPerformanceData, newestInsertedAt, PERF_RENDER_BUDGET_MS } from './data';
import { LagPanel } from '@/components/ops/performance/LagPanel';
import { IngestRates } from '@/components/ops/performance/IngestRates';
import { RelayPanel } from '@/components/ops/performance/RelayPanel';
import { LatencyPanel } from '@/components/ops/performance/LatencyPanel';
import { VoicePanel } from '@/components/ops/performance/VoicePanel';
import { HeartbeatGauges } from '@/components/ops/performance/HeartbeatGauges';
import { RouteHeartbeats } from '@/components/ops/performance/RouteHeartbeats';
import { BudgetPanel } from '@/components/ops/performance/BudgetPanel';
import { PlayLoad } from '@/components/ops/performance/PlayLoad';
import { BossRevisions } from '@/components/ops/performance/BossRevisions';
import { FreshnessLadder } from '@/components/ops/performance/FreshnessLadder';
import { RenderCost } from '@/components/ops/performance/RenderCost';
import { allPerfEntries } from '@/lib/ops/glossary-performance';

// Auth-gated + always fresh; never statically rendered. Same lines as every
// other page in this segment: one auth model for the whole cockpit.
export const dynamic = 'force-dynamic';

// robots noindex/nofollow is inherited from app/admin/ops/layout.tsx.
export const metadata: Metadata = {
  title: { absolute: 'Eilif · Ops Performance' },
};

/** Tables that grow with play. player_positions is one row per viking, in place. */
const GROWTH_TABLES: { table: string; at: 'events' | 'sessions' | 'voice' }[] = [
  { table: 'events', at: 'events' },
  { table: 'sessions', at: 'sessions' },
  { table: 'voice_lines', at: 'voice' },
];

/** The throttle in lib/ops/route-heartbeat.ts, in seconds. Kept in step by hand. */
const ROUTE_HEARTBEAT_THROTTLE_SEC = 60;

export default async function OpsPerformancePage() {
  // ---- Auth gate (fail closed) --------------------------------------------
  const store = await cookies();
  if (!verifySession(store.get(COOKIE_NAME)?.value)) {
    redirect('/admin/ops/login');
  }

  const data = await loadPerformanceData();
  const nowMs = data.nowMs;
  const since24hMs = nowMs - WINDOW_24H_MS;
  const since24hIso = sinceIso(nowMs, WINDOW_24H_MS);

  const hours = hourBuckets(nowMs, 24);
  const days = dayBuckets(nowMs, 7);
  const hourLabels = hours.map((b) => b.label);
  const dayLabels = days.map((b) => b.label);

  // ---- Pipeline delay -----------------------------------------------------
  // The 24 h slice is taken in memory off the 7 d read rather than as a second
  // query: one bounded read, two windows.
  const events7d = data.events;
  const events24h = events7d.filter((r) => {
    const t = toMs(r.inserted_at ?? r.created_at);
    return t !== null && t >= since24hMs;
  });

  // Every delay statistic is computed over rows the backfill did not touch. A
  // backfilled row carries inserted_at = created_at, so it reads as exactly 0 s
  // and, on a quiet week, sets the median for a pipeline that was never
  // measured. The audit below still counts them, and the panel says how many.
  const measured24h = withoutBackfilled(events24h);
  const measured7d = withoutBackfilled(events7d);

  const lag24h = lagSummary(lagSeconds(measured24h));
  const lag7d = lagSummary(lagSeconds(measured7d));
  const hourlyP90 = percentilePerBucket(lagPerBucket(measured24h, hours), 90);
  const lagPerProducer = lagByProducer(measured7d);
  const byProducer = PERF_PRODUCERS.map((producer) => ({
    producer,
    summary: lagPerProducer[producer],
  }));

  // ---- Ingest rate --------------------------------------------------------
  const hourlyByProducer = producerCountsPerBucket(events24h, hours);
  const hourlyTotals = hours.map((_, i) =>
    PERF_PRODUCERS.reduce((sum, p) => sum + (hourlyByProducer[p]?.[i] ?? 0), 0),
  );

  // ---- Relay backlog ------------------------------------------------------
  // The cursor rides in the discord-bot heartbeat's metrics. Production
  // publishes metrics.schedule.relayCursor as of 2026-09-06 (verified against
  // the live ops_heartbeats row), and metrics.relay.lastInsertedAt is accepted
  // as well because a bot that has not restarted onto that block, or one that
  // mirrors its own state directly, would carry the second shape instead. When
  // NEITHER is present the panel says the cursor has not been published rather
  // than reading as idle: an unmeasured backlog is not an empty one.
  const botHeartbeat = data.heartbeats.find((h) => h.component === 'discord-bot');
  const relayCursor = readRelayCursor(botHeartbeat?.metrics);
  const backlog = relayBacklog(relayCursor, events7d, nowMs);
  const newestIns = newestInsertedAt(events7d);

  // ---- Announce latency ---------------------------------------------------
  const deedLatency = announceLatency(
    data.milestones,
    (m) => m.achieved_at,
    (m) => m.announced_at,
    nowMs,
  );
  const oathsInWindow = data.oaths.filter((o) => (o.sworn_at ?? '') >= sinceIso(nowMs, WINDOW_7D_MS));
  const oathLatency = announceLatency(
    oathsInWindow,
    (o) => o.sworn_at,
    (o) => o.announced_at,
    nowMs,
  );

  // ---- Voice --------------------------------------------------------------
  const voiceHealth = voiceQueueHealth(data.voiceQueued, data.voiceWindow, nowMs);
  // The 7 d latencies are the honest ones on a hall this quiet, but "spoken in
  // the last 24 h" is the number that answers whether Eilif is talking tonight.
  // Taken in memory off the same rows: no second query.
  const voiceSpoken24h = spokenSince(data.voiceWindow, since24hMs);
  const playersOnline = countOnlineSessions(data.sessions);

  // ---- Heartbeat pressure -------------------------------------------------
  const historyByComponent = groupHistory(data.heartbeatLog, hours);
  const gaugeRows = COMPONENTS.filter((c) => c.staleAfterSec > 0).map((c) => {
    const hb = data.heartbeats.find((h) => h.component === c.key);
    // Respect each component's own source, exactly as buildHealth() does. The
    // server emitter is a third-party mod that cannot POST a heartbeat at all,
    // so its liveness is INFERRED from how fresh server_status is; reading
    // ops_heartbeats for it would report "never reported" forever about a
    // component that is working.
    const lastSuccess =
      c.source === 'server_status' ? data.serverStatusUpdatedAt : (hb?.last_success ?? null);
    return {
      key: c.key,
      label: c.label,
      subtitle: c.subtitle,
      cadenceSec: c.expectedCadenceSec,
      inferred: c.source === 'server_status',
      pressure: heartbeatPressure(nowMs, lastSuccess, c.staleAfterSec),
      version: hb?.version ?? null,
      error: hb?.error_summary ?? null,
      history: historyByComponent[c.key] ?? hours.map(() => null),
    };
  });

  // ---- Route heartbeats ---------------------------------------------------
  const routeRows = [
    {
      component: 'boards-plugin',
      label: 'Boards signs',
      route: 'GET /api/boards',
      purpose: 'EilifBoards polls for the leaderboard strings it paints onto in-game signs.',
    },
    {
      component: 'companion-voice',
      label: 'In-game voice',
      route: 'GET /api/voice',
      purpose: "EilifCompanion polls for lines to speak, and advertises what it can do while it does.",
    },
  ].map((r) => {
    const hb = data.heartbeats.find((h) => h.component === r.component);
    return {
      ...r,
      status: hb?.status ?? null,
      ageSec: ageSecFrom(nowMs, hb?.last_success ?? null),
      error: hb?.error_summary ?? null,
      metrics: describeMetrics(hb?.metrics),
    };
  });

  // ---- Free plan budget ---------------------------------------------------
  const estimate = estimateTableBytes(data.tableCounts);
  const growthSeries = GROWTH_TABLES.map(({ table, at }) => ({
    table,
    bytesPerRow: ROW_BYTES[table] ?? 0,
    perDay: rowsPerDay(
      at === 'events'
        ? events7d.map((r) => r.inserted_at ?? r.created_at)
        : at === 'sessions'
          ? data.sessions.map((s) => s.joined_at)
          : data.voiceWindow.map((v) => v.queued_at),
      days,
    ),
  }));
  const bytesPerDay = days.map((_, i) =>
    growthSeries.reduce((sum, g) => sum + (g.perDay[i] ?? 0) * g.bytesPerRow, 0),
  );
  // The last bucket is the day still in progress and would drag the mean down.
  const growth = projectGrowth(
    bytesPerDay.slice(0, -1),
    data.exactDbBytes ?? estimate.totalBytes,
    FREE_PLAN_DB_BYTES,
  );

  // ---- Play load ----------------------------------------------------------
  const peakPerDay = peakConcurrencyPerBucket(data.sessions, days, nowMs);
  const playedHours24h = playedHoursInWindow(data.sessions, since24hMs, nowMs, nowMs);
  const playedHours7d = playedHoursInWindow(data.sessions, nowMs - WINDOW_7D_MS, nowMs, nowMs);
  const deaths24h = events24h.filter((e) => e.type === 'death').length;
  const deaths7d = events7d.filter((e) => e.type === 'death').length;

  // ---- Freshness ladder ---------------------------------------------------
  const rungs = freshnessLadder([
    {
      surface: 'Hall roster and Hearth',
      source: 'server_status.updated_at',
      ageSec: ageSecFrom(nowMs, data.serverStatusUpdatedAt),
      staleAfterSec: data.statsStaleAfterSec,
    },
    {
      surface: 'Saga feed and Events',
      source: 'events.inserted_at',
      ageSec: ageSecFrom(nowMs, newestIns),
      staleAfterSec: 24 * 3600,
    },
    {
      surface: 'Map',
      source: 'map/status.json (last-modified)',
      ageSec: ageSecFrom(nowMs, data.mapStatusLastModified),
      staleAfterSec: data.mapStaleAfterSec,
      staleOverride: data.mapStale,
    },
    {
      surface: 'Gallery',
      source: 'gallery_photos.posted_at',
      ageSec: ageSecFrom(nowMs, data.newestGalleryAt),
      staleAfterSec: 14 * 24 * 3600,
    },
    {
      surface: "Eilif's voice",
      source: 'voice_lines.spoken_at',
      ageSec: ageSecFrom(nowMs, newestSpokenAt(data.voiceWindow)),
      staleAfterSec: 7 * 24 * 3600,
    },
  ]);

  // ---- This page's own cost ----------------------------------------------
  const cost = {
    fetchMs: data.fetchMs,
    queries: data.queries,
    rows: data.rowsRead,
    storageRequests: data.storageRequests,
    budgetMs: PERF_RENDER_BUDGET_MS,
  };

  return (
    <div className="space-y-8">
      <OpsNav active="performance" />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <GaugeIcon size={22} className="text-gold" />
          <div>
            <h1 className="heading-engraved text-2xl text-ash">Performance</h1>
            <p className="text-sm text-muted">
              How long each hop of the pipeline takes, and how much of the free plan is left. Every number
              carries its window; buckets are aligned in {BUCKET_TZ}.
            </p>
          </div>
        </div>
        <OpsControls renderedAtIso={new Date(nowMs).toISOString()} />
      </header>

      {!data.configured && (
        <Card>
          <CardBody className="text-sm text-death">
            The database is unreachable or the service role is not configured, so every panel below reads as
            unknown. That is the honest signal, not an outage of the site itself.
          </CardBody>
        </Card>
      )}

      {/* Above every number it invalidates. A refused query resolves rather than
          throwing, so a broken read would otherwise render as a quiet week: a
          percentile of "no data" and a rate of zero. */}
      <FailedReads failed={data.failedReads} total={data.queries} />

      <LagPanel
        day={lag24h}
        week={lag7d}
        audit24h={lagAudit(events24h)}
        audit7d={lagAudit(events7d)}
        histogram={lagHistogram(lagSeconds(measured7d))}
        hourlyP90={hourlyP90}
        hourLabels={hourLabels}
        worst={worstLagRows(measured7d, 5)}
        byProducer={byProducer}
      />

      <IngestRates
        hourLabels={hourLabels}
        hourly={hourlyTotals}
        hourlyByProducer={hourlyByProducer}
        totals24h={producerTotals(events24h)}
        totals7d={producerTotals(events7d)}
        producers={PERF_PRODUCERS}
      />

      <RelayPanel
        backlog={backlog}
        newestInsertedAt={newestIns}
        newestAgeSec={ageSecFrom(nowMs, newestIns)}
      />

      <LatencyPanel
        ledgers={[
          {
            label: 'Great Deeds',
            source: 'milestones.achieved_at and milestones.announced_at',
            summary: deedLatency,
            pendingNoun: 'to be told',
            window: 'all achieved deeds',
          },
          {
            label: 'Oaths',
            source: 'oaths.sworn_at and oaths.announced_at',
            summary: oathLatency,
            pendingNoun: 'to be told',
            window: windowLabel(WINDOW_7D_MS),
          },
        ]}
      />

      <VoicePanel
        health={voiceHealth}
        window={windowLabel(WINDOW_7D_MS)}
        spoken24h={voiceSpoken24h}
        playersOnline={playersOnline}
      />

      <HeartbeatGauges
        rows={gaugeRows}
        historyPresent={data.heartbeatLogPresent}
        hourLabels={hourLabels}
      />

      <RouteHeartbeats rows={routeRows} throttleSec={ROUTE_HEARTBEAT_THROTTLE_SEC} />

      <BudgetPanel
        estimate={estimate}
        exactDbBytes={data.exactDbBytes}
        exactStorageBytes={data.exactStorageBytes}
        storage={data.storage}
        growth={growth}
        growthSeries={growthSeries}
        dayLabels={dayLabels}
        countsAgeSec={data.countsAgeSec}
        storageAgeSec={data.storageAgeSec}
      />

      <PlayLoad
        peakPerDay={peakPerDay}
        dayLabels={dayLabels}
        maxPlayers={MAX_PLAYERS}
        playedHours24h={playedHours24h}
        playedHours7d={playedHours7d}
        deaths24h={deaths24h}
        deaths7d={deaths7d}
        deathsPerHour24h={deathsPerHourPlayed(deaths24h, playedHours24h)}
        deathsPerHour7d={deathsPerHourPlayed(deaths7d, playedHours7d)}
        openSessions={playersOnline}
      />

      <BossRevisions rows={bossRevRows(data.bosses)} />

      <FreshnessLadder rungs={rungs} />

      <RenderCost
        cost={cost}
        fraction={renderCostFraction(cost)}
        renderedAtIso={new Date(nowMs).toISOString()}
        cachedRequests={data.cachedQueries}
        cachedGroups={[
          { label: 'Table row counts', ageSec: data.countsAgeSec, ttlSec: 60 },
          { label: 'Storage measurement', ageSec: data.storageAgeSec, ttlSec: 300 },
        ]}
      />

      {/* The same captions as the info buttons, in one list, so the text is
          reachable without hunting for the button that owns it. */}
      <section>
        <div className="mb-3 flex items-center gap-2.5">
          <BookOpen size={18} className="text-gold" />
          <h2 className="font-display text-sm uppercase tracking-wide text-ash">
            What everything on this page means
          </h2>
        </div>
        <Card>
          <CardBody>
            <dl className="space-y-4">
              {allPerfEntries().map((e) => (
                <div key={e.id}>
                  <dt className="text-sm font-medium text-ash">{e.title}</dt>
                  <dd className="mt-0.5 space-y-1 text-xs leading-relaxed text-ash-dim">
                    <p>{e.what}</p>
                    <p>
                      <span className="text-online-glow">Healthy: </span>
                      {e.healthy}
                    </p>
                    <p>
                      <span className="text-raid">When it is not: </span>
                      {e.whenRed}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      </section>

      <p className="pt-2 text-xs text-muted">
        Read live with the service role at render time, {windowLabel(WINDOW_24H_MS)} and{' '}
        {windowLabel(WINDOW_7D_MS)}. Every read is bounded by a window and an explicit limit, and nothing on
        this page writes. Events read since {since24hIso.slice(0, 10)}.
        {data.eventsTruncated &&
          ' The events read hit its row ceiling, so the 7 d numbers cover the newest rows only.'}
      </p>
    </div>
  );
}

/**
 * The relay cursor, wherever the bot files it.
 *
 * Two shapes are accepted on purpose: `metrics.schedule.relayCursor` is the
 * block services/discord-bot/src/heartbeat.js publishes, which production has
 * carried since the bot restarted on 2026-09-06, and
 * `metrics.relay.lastInsertedAt` is what a direct mirror of the bot's own state
 * would look like, which is what a bot on older code would report. With neither
 * present this returns null and the panel says the cursor has not been published
 * rather than reading as idle.
 */
function readRelayCursor(metrics: unknown): string | null {
  if (metrics === null || typeof metrics !== 'object') return null;
  const m = metrics as Record<string, unknown>;
  const schedule = m.schedule;
  if (schedule !== null && typeof schedule === 'object') {
    const c = (schedule as Record<string, unknown>).relayCursor;
    if (typeof c === 'string' && c.length > 0) return c;
  }
  const relay = m.relay;
  if (relay !== null && typeof relay === 'object') {
    const r = relay as Record<string, unknown>;
    for (const key of ['lastInsertedAt', 'lastEventAt', 'cursor']) {
      const v = r[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

/** Sessions with no leave stamp: vikings the database believes are still on. */
function countOnlineSessions(sessions: { left_at?: string | null }[]): number {
  return sessions.filter((s) => (s.left_at ?? null) === null).length;
}

function newestSpokenAt(rows: { spoken_at?: string | null }[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    const t = toMs(r.spoken_at ?? null);
    if (t !== null && t > bestMs) {
      bestMs = t;
      best = r.spoken_at as string;
    }
  }
  return best;
}

/**
 * Heartbeat metrics as printable key/value pairs, shallow only.
 *
 * Shallow on purpose: these rows are written by lib/ops/route-heartbeat.ts with
 * a small flat object, and a nested blob rendered raw on an ops page is how a
 * secret ends up on a screen. Anything that is not a string, number or boolean
 * is described by its type rather than printed.
 */
function describeMetrics(metrics: unknown): { key: string; value: string }[] {
  if (metrics === null || typeof metrics !== 'object') return [];
  return Object.entries(metrics as Record<string, unknown>)
    .slice(0, 6)
    .map(([key, v]) => ({
      key,
      value:
        typeof v === 'string'
          ? v.length > 40
            ? `${v.slice(0, 40)}...`
            : v
          : typeof v === 'number' || typeof v === 'boolean'
            ? String(v)
            : Array.isArray(v)
              ? `${v.length} entries`
              : v === null
                ? 'null'
                : 'object',
    }));
}

/**
 * p90 heartbeat age per hour, per component, from the optional history table.
 *
 * Returns an empty map when the table is absent, which is the state until
 * db/2026-09-06_ops_heartbeat_log.sql is applied by hand. Every panel that reads
 * it renders "no history yet" rather than a flat line at zero.
 */
function groupHistory(
  log: { component: string; sampled_at: string; age_sec: number | null }[],
  buckets: { startMs: number; endMs: number }[],
): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  if (log.length === 0 || buckets.length === 0) return out;
  const width = buckets[0].endMs - buckets[0].startMs;
  const first = buckets[0].startMs;
  const acc: Record<string, number[][]> = {};
  for (const row of log) {
    const t = toMs(row.sampled_at);
    if (t === null || row.age_sec === null) continue;
    const idx = Math.floor((t - first) / width);
    if (idx < 0 || idx >= buckets.length) continue;
    acc[row.component] ??= buckets.map(() => []);
    acc[row.component][idx].push(row.age_sec);
  }
  for (const [component, groups] of Object.entries(acc)) {
    out[component] = percentilePerBucket(groups, 90);
  }
  return out;
}
