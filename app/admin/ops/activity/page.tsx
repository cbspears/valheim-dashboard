import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ListChecks, Database } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { OpsNav } from '@/components/ops/OpsNav';
import { Explain } from '@/components/ops/Explain';
import { FailedReads } from '@/components/ops/FailedReads';
import { COOKIE_NAME, verifySession } from '@/lib/ops/auth';
import {
  countByType,
  compareWindows,
  countsByKind,
  deathCauses,
  deathsByViking,
  filterTimeline,
  isFiredKind,
  longestQuietGap,
  longestSilenceWhileOnline,
  loudestBucket,
  mergeTimeline,
  onlineIntervals,
  producerSplit,
  queueBacklog,
  unannouncedItems,
  voiceBreakdown,
  KIND_LABELS,
  type FiredKind,
} from '@/lib/ops/activity';
import {
  countInBuckets,
  dayBuckets,
  formatCount,
  hourBuckets,
  toMs,
  windowLabel,
  WINDOW_24H_MS,
  WINDOW_7D_MS,
} from '@/lib/ops/window';
import { loadActivityData } from './data';
import { WindowToggle, KindFilter, type ActivityWindow } from '@/components/ops/activity/Filters';
import { VolumeChart } from '@/components/ops/activity/VolumeChart';
import { TypeDeltaTable } from '@/components/ops/activity/TypeDeltaTable';
import { ProducerSplit } from '@/components/ops/activity/ProducerSplit';
import { DeathCauses } from '@/components/ops/activity/DeathCauses';
import { VoicePanel } from '@/components/ops/activity/VoicePanel';
import { UnannouncedPanel } from '@/components/ops/activity/UnannouncedPanel';
import { Silences } from '@/components/ops/activity/Silences';
import { Timeline } from '@/components/ops/activity/Timeline';
import { ACTIVITY_GLOSSARY } from '@/lib/ops/glossary-activity';

// Auth-gated + always fresh; never statically rendered. Same three lines as the
// overview and the architecture page: one auth model for the whole segment.
export const dynamic = 'force-dynamic';

// robots noindex/nofollow is inherited from app/admin/ops/layout.tsx.
export const metadata: Metadata = {
  title: { absolute: 'Eilif · Ops What Fired' },
};

/** The feed's render cap. The counts above it are computed over the whole window. */
const FEED_LIMIT = 200;

/** Read one search param, tolerating the array form Next hands over. */
function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function OpsActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // ---- Auth gate (fail closed) --------------------------------------------
  const store = await cookies();
  if (!verifySession(store.get(COOKIE_NAME)?.value)) {
    redirect('/admin/ops/login');
  }

  // ---- Filters, validated before anything reads them ----------------------
  const params = await searchParams;
  const win: ActivityWindow = one(params.w) === '7d' ? '7d' : '24h';
  const rawKind = one(params.kind);
  const kind: FiredKind | 'all' = isFiredKind(rawKind) ? rawKind : 'all';

  // ---- Load (one Promise.all, everything bounded to 7 d) ------------------
  // The database block times itself inside loadActivityData(). The whole-page
  // number is deliberately NOT measured here: performance.now() inside a
  // component body is an impure call and the repo's react-hooks/purity rule
  // rejects it, correctly. Wall-clock page time is measured from outside, with a
  // timed GET against a scratch build.
  const data = await loadActivityData();
  const nowMs = data.nowMs;

  const windowMs = win === '7d' ? WINDOW_7D_MS : WINDOW_24H_MS;
  const sinceMs = nowMs - windowMs;
  const windowText = windowLabel(windowMs);

  // ---- Compute (every line below is a tested pure function) ---------------
  const allRows = mergeTimeline({
    events: data.events,
    voiceLines: data.voiceLines,
    milestones: data.milestones,
    titles: data.titles,
    poty: data.poty,
    oaths: data.oaths,
    pins: data.pins,
    photos: data.photos,
    alerts: data.alerts,
  });

  const windowRows = filterTimeline(allRows, { sinceMs, nowMs });
  const kindCounts = countsByKind(windowRows);
  const matchedRows = filterTimeline(allRows, { sinceMs, nowMs, kind });
  const feedRows = matchedRows.slice(0, FEED_LIMIT);

  const filterText = kind === 'all' ? 'Everything' : KIND_LABELS[kind];

  // Volume follows the active kind filter so the chart and the feed under it can
  // never disagree about what is being counted.
  const buckets = win === '7d' ? dayBuckets(nowMs, 7) : hourBuckets(nowMs, 24);
  const bucketCounts = countInBuckets(matchedRows.map((r) => r.atMs), buckets);
  // excludePartial: the last bucket is the current, incomplete one. The chart
  // draws it muted so nobody compares it with the full ones, so naming it the
  // loudest hour a line below would contradict the caption.
  const loudest = loudestBucket(bucketCounts, buckets, { excludePartial: true });
  const partialCount = bucketCounts[bucketCounts.length - 1] ?? 0;

  // The type comparison is always 24 h against the 7 d daily average, whichever
  // window the page is showing: comparing 7 d with its own average would be a
  // tautology.
  const events24 = data.events.filter((e) => {
    const t = toMs(e.created_at);
    return t !== null && t >= nowMs - WINDOW_24H_MS;
  });
  const deltas = compareWindows(countByType(events24), countByType(data.events), 7);

  const eventsInWindow = data.events.filter((e) => {
    const t = toMs(e.created_at);
    return t !== null && t >= sinceMs;
  });
  const deaths = eventsInWindow.filter((e) => e.type.toLowerCase() === 'death');

  const voiceInWindow = data.voiceLines.filter((v) => {
    const t = toMs(v.queued_at);
    return t !== null && t >= sinceMs;
  });
  const voice = voiceBreakdown(voiceInWindow, nowMs);
  // The backlog reads EVERY line the query returned, in window or not: the read
  // deliberately returns unspoken lines of any age, because a line stuck for
  // nine days is more stuck than one stuck for six, not less.
  const backlog = queueBacklog(data.voiceLines, nowMs, sinceMs);

  const unannounced = unannouncedItems({ milestones: data.milestones, oaths: data.oaths }, nowMs);

  // Silence is measured against `events` only, not the merged timeline: a title
  // or a crown is written by the bot on its own schedule and would break a
  // silence that the game pipeline is in fact still failing to write through.
  const eventTimes = eventsInWindow.map((e) => e.created_at);
  const gap = longestQuietGap(eventTimes, sinceMs, nowMs);
  const intervals = onlineIntervals(data.sessions, sinceMs, nowMs);
  const silence = longestSilenceWhileOnline(eventTimes, intervals, nowMs);
  const onlineMinutes = intervals.reduce((n, i) => n + (i.endMs - i.startMs) / 60000, 0);
  const openSessions = data.sessions.filter((s) => !s.left_at).length;

  const shares = producerSplit(windowRows);

  return (
    <div className="space-y-8">
      <OpsNav active="activity" />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <ListChecks size={22} className="mt-0.5 shrink-0 text-gold" />
          <div className="max-w-xl">
            <h1 className="heading-engraved text-2xl text-ash">What fired</h1>
            <p className="text-sm text-muted">
              Everything the pipeline actually did, merged from nine tables into one feed.
              Observational only, with no controls here.
            </p>
          </div>
        </div>
        <WindowToggle active={win} kind={kind} />
      </header>

      {!data.configured ? (
        <Card>
          <CardBody className="flex items-start gap-3 text-sm text-raid">
            <Database size={18} className="mt-0.5 shrink-0" />
            <span>
              The database is unreachable from this render: NEXT_PUBLIC_SUPABASE_URL or
              SUPABASE_SERVICE_ROLE_KEY is not set in this environment. Nothing below would be
              trustworthy, so nothing below is shown.
            </span>
          </CardBody>
        </Card>
      ) : (
        <>
          {/* Above the numbers it invalidates: a read that PostgREST refused
              arrives as an empty array, and every panel below would render it
              as a quiet window. */}
          <FailedReads failed={data.failedReads} total={data.cost.queries} />

          {/* Roll-up ribbon: the four numbers that answer "was it busy". */}
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-rune bg-surface px-3 py-1 text-ash-dim">
              <span className="font-semibold text-ash">{formatCount(windowRows.length)}</span>{' '}
              {windowRows.length === 1 ? 'row' : 'rows'} fired, {windowText}
            </span>
            <span className="rounded-full border border-rune bg-surface px-3 py-1 text-ash-dim">
              <span className="font-semibold text-ash">{formatCount(eventsInWindow.length)}</span>{' '}
              of them {eventsInWindow.length === 1 ? 'an events row' : 'events rows'}
            </span>
            <span className="rounded-full border border-rune bg-surface px-3 py-1 text-ash-dim">
              <span className="font-semibold text-ash">{Math.round(onlineMinutes)}</span> min with
              somebody online
            </span>
            <span className="rounded-full border border-rune bg-surface px-3 py-1 text-ash-dim">
              <span className="font-semibold text-ash">{openSessions}</span>{' '}
              {openSessions === 1 ? 'session' : 'sessions'} open right now
            </span>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <VolumeChart
              buckets={buckets}
              counts={bucketCounts}
              loudest={loudest}
              partialCount={partialCount}
              bucketNoun={win === '7d' ? 'day' : 'hour'}
              windowText={windowText}
              filterText={filterText}
              total={matchedRows.length}
              truncated={data.eventsTruncated}
            />
            <Silences
              gap={gap}
              silence={silence}
              onlineMinutes={onlineMinutes}
              windowText={windowText}
              nowMs={nowMs}
            />
            <ProducerSplit shares={shares} windowText={windowText} total={windowRows.length} />
            <TypeDeltaTable deltas={deltas} />
            <DeathCauses
              causes={deathCauses(deaths)}
              byViking={deathsByViking(deaths)}
              windowText={windowText}
              total={deaths.length}
            />
            <UnannouncedPanel items={unannounced} />
            <VoicePanel
              summary={voice}
              backlog={backlog}
              windowText={windowText}
              playersOnline={openSessions}
              className="lg:col-span-2"
            />
          </div>

          <section className="space-y-3">
            <KindFilter
              window={win}
              active={kind}
              counts={kindCounts}
              total={windowRows.length}
            />
            <Timeline
              rows={feedRows}
              nowMs={nowMs}
              window={win}
              windowText={windowText}
              filterText={filterText}
              matched={matchedRows.length}
              limit={FEED_LIMIT}
            />
          </section>

          <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rune pt-4 text-xs text-muted">
            <span className="flex items-center gap-1">
              What this page cost
              <Explain entry={ACTIVITY_GLOSSARY['page-cost']} size="sm" align="end" />
            </span>
            <span>
              {data.cost.queries} queries, {formatCount(data.cost.rows)} rows,{' '}
              {Math.round(data.cost.fetchMs)} ms in the database.
            </span>
            <span>
              Read at {new Date(nowMs).toISOString()}. Every read is bounded to 7 d and an explicit
              row limit; the 24 h view is sliced from the same rows.
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
