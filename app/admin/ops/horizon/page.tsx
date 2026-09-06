// /admin/ops/horizon: "Coming up".
//
// The Overview tab answers "is it working". The What-fired tab answers "what did
// it do". This one answers the question an operator asks at 22:50 on launch
// night: what happens next, and is any of it late?
//
// COMPOSITION ONLY. Every read is in ./data.ts and every calculation is in
// lib/ops/horizon.ts (pure, 249 assertions in lib/ops/horizon.test.mjs). This
// file gates on the cookie, calls one loader, calls the pure functions once
// each, and hands plain values to presentational components. Nothing below
// writes, posts, restarts or triggers anything: the cockpit is observational and
// this tab is the most observational part of it.
//
// THE RULE THAT SHAPES THE WHOLE PAGE. Several of these numbers live only inside
// the Discord bot's process (its cron hour, its banked online minutes, its relay
// cursor) and reach the cockpit through the heartbeat's `metrics.schedule`
// block, which does not exist until the bot is restarted by hand on the host.
// Every panel that depends on it renders "the bot has not reported this yet"
// rather than a zero, and the banner at the top says so once, plainly.

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { CalendarClock, Info, Timer } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { OpsNav } from '@/components/ops/OpsNav';
import { Explain } from '@/components/ops/Explain';
import { COOKIE_NAME, verifySession } from '@/lib/ops/auth';
import { formatAgeSec, ageSecFrom, formatDurationSec } from '@/lib/ops/window';
import {
  resolveSchedule,
  minGapRemainingSec,
  nextDawnWorldDay,
  ambientCadence,
  relayDrain,
  upcomingDeeds,
  titleContests,
  nextBoss,
  cadenceEta,
  mergeSchedule,
  launchMomentMs,
  launchStepStates,
  nextOpenSteps,
  nextDailyRun,
  nextOfDailyHours,
  stampInZone,
  MAP_CADENCE_SEC,
  LAUNCH_TZ,
  type ScheduleItem,
} from '@/lib/ops/horizon';
import { loadHorizonData, CLAIM_URGENT_MS, TITLES_CACHE_SEC } from './data';
import { HORIZON_GLOSSARY } from '@/lib/ops/glossary-horizon';
import { LaunchPanel } from '@/components/ops/horizon/LaunchPanel';
import { NextUpRail } from '@/components/ops/horizon/NextUpRail';
import {
  RecapCard,
  DawnCard,
  AmbientCard,
  VoiceQueueCard,
} from '@/components/ops/horizon/VoicePanels';
import { RelayPanel } from '@/components/ops/horizon/RelayPanel';
import { DeedsClose, NextBossCard } from '@/components/ops/horizon/DeedsPanel';
import { TitlesPanel } from '@/components/ops/horizon/TitlesPanel';
import { GatheringsPanel, ExpiringClaimsPanel } from '@/components/ops/horizon/CalendarPanel';
import {
  WatchdogPanel,
  LoopSchedulePanel,
  MapFramePanel,
  HostTimersPanel,
  type HostTimer,
} from '@/components/ops/horizon/SystemPanels';

// Auth-gated + always fresh; never statically rendered. Same three lines as the
// overview and the architecture page: one auth model for the whole segment.
export const dynamic = 'force-dynamic';

// robots noindex/nofollow is inherited from app/admin/ops/layout.tsx.
export const metadata: Metadata = {
  title: { absolute: 'Eilif · Ops Coming Up' },
};

export default async function OpsHorizonPage() {
  // ---- Auth gate (fail closed) --------------------------------------------
  const store = await cookies();
  if (!verifySession(store.get(COOKIE_NAME)?.value)) {
    redirect('/admin/ops/login');
  }

  // ---- One loader, one clock ----------------------------------------------
  const data = await loadHorizonData();
  const nowMs = data.nowMs;

  // ---- Pure computation, once each ----------------------------------------
  const schedule = resolveSchedule(data.botSchedule, nowMs);

  const playersOnline = data.serverStatus?.current_players?.length ?? null;
  const worldDay = data.serverStatus?.world_day ?? null;

  const dawn = nextDawnWorldDay(worldDay, schedule.lastDawnDay, schedule.dawnEveryDays);
  const gapSec = minGapRemainingSec(data.newestVoiceQueuedAt, schedule.voiceMinGapMs, nowMs);
  const cadence = ambientCadence(
    schedule.ambientOnlineMinutes,
    schedule.voiceCadenceMinutes,
    gapSec,
  );
  const backlog = relayDrain(
    schedule.relayCursor,
    data.newestEventInsertedAt,
    data.relayPending,
    nowMs,
  );
  const deeds = upcomingDeeds(data.milestones, data.aggregates, 8);
  const unearned = data.milestones.filter((m) => !m.achieved_at).length;
  const contests = titleContests(data.titles);
  const boss = nextBoss(data.bosses, nowMs);
  const mapEta = cadenceEta(data.mapCapturedAt, MAP_CADENCE_SEC, nowMs);

  // ---- Launch day ---------------------------------------------------------
  // Every gathering, not the soonest one: getUpcomingEvents sorts ascending, so
  // anything scheduled before the 9th would push the launch gathering off index
  // 0 and the panel would silently claim no gathering was on the calendar.
  const moment = launchMomentMs(data.gatherings.map((g) => g.next_at));
  const pilotOverridesReverted =
    data.botFlags.recapChannelIsServer === null
      ? null
      : !data.botFlags.recapChannelIsServer &&
        !data.botFlags.milestoneChannelIsServer &&
        !data.botFlags.recapsStartPulledForward;
  const steps = launchStepStates({
    pilotOverridesReverted,
    preLaunchEventRows: data.preLaunchEventRows,
  });

  // ---- The two host timers, read off the unit files in services/ ----------
  const worldBackupNext = nextOfDailyHours(nowMs, [0, 6, 12, 18], 0, LAUNCH_TZ);
  const dbSnapshotNext = nextDailyRun(nowMs, 3, 30, LAUNCH_TZ);
  const hostTimers: HostTimer[] = [
    {
      name: 'World backup',
      unit: 'eilif-world-backup.timer',
      schedule: '00, 06, 12 and 18:00 local, plus up to 5 min of jitter',
      purpose: 'Pulls the world off the box into ~/valheim-world-backups, keeping the newest 14.',
      nextAtMs: worldBackupNext,
      lastSuccess:
        (data.heartbeats ?? []).find((h) => h.component === 'world-backup')?.last_success ?? null,
    },
    {
      name: 'Database snapshot',
      unit: 'eilif-db-snapshot.timer',
      schedule: '03:30 local, plus up to 10 min of jitter',
      purpose:
        'Dumps all 20 public tables to JSON, keeping the newest 30. Doubles as the free-plan keep-alive.',
      nextAtMs: dbSnapshotNext,
      lastSuccess:
        (data.heartbeats ?? []).find((h) => h.component === 'db-snapshot')?.last_success ?? null,
    },
  ];

  // ---- The merged rail ----------------------------------------------------
  const rail: ScheduleItem[] = mergeSchedule([
    {
      id: 'recap',
      label: 'Nightly recap to Discord',
      atMs: schedule.nextRecapAtMs,
      detail: `Cron 0 ${schedule.recapHour} * * * in ${schedule.recapTz}.`,
    },
    {
      id: 'dawn',
      label: `Dawn line, world day ${dawn?.day ?? 'unknown'}`,
      atMs: null,
      detail: dawn
        ? dawn.isToday
          ? 'Due on the current world day. It has no wall-clock time: it fires on the next voice tick with somebody in the hall.'
          : `${dawn.daysAway} world day${dawn.daysAway === 1 ? '' : 's'} out. World days are not wall-clock days, so there is no countdown.`
        : 'The world day is unknown, so the dawn cycle cannot be placed.',
      conditional: true,
    },
    {
      id: 'ambient',
      label: 'Ambient voice line',
      atMs:
        cadence.state === 'ready'
          ? nowMs
          : cadence.state === 'held-by-gap'
            ? nowMs + cadence.blockedByGapSec * 1000
            : null,
      detail:
        cadence.state === 'ready'
          ? 'The cadence is met and the min gap is clear.'
          : cadence.state === 'held-by-gap'
            ? 'The cadence is met; the hall just spoke too recently.'
            : cadence.state === 'accumulating'
              ? `${Math.ceil(cadence.minutesOwed ?? 0)} more minutes of someone online are owed, so there is no clock time.`
              : 'The bot has not reported its accumulator.',
      conditional: true,
    },
    ...(data.gatherings[0]
      ? [
          {
            id: 'gathering',
            label: `Gathering: ${data.gatherings[0].name}`,
            atMs: Date.parse(data.gatherings[0].next_at),
            detail: `${data.gatherings[0].user_count} interested on Discord.`,
          },
        ]
      : []),
    {
      id: 'map-frame',
      label: 'Map snapshot frame',
      atMs: mapEta.nextAtMs,
      detail: `The loop pulls the composite over SFTP every ${Math.round(MAP_CADENCE_SEC / 60)} min.`,
      estimated: true,
    },
    {
      id: 'world-backup',
      label: 'World backup (host timer)',
      atMs: worldBackupNext,
      detail: 'Read from eilif-world-backup.timer in the repo. The cockpit cannot see whether it runs.',
      estimated: true,
    },
    {
      id: 'db-snapshot',
      label: 'Database snapshot (host timer)',
      atMs: dbSnapshotNext,
      detail: 'Read from eilif-db-snapshot.timer in the repo. The cockpit cannot see whether it runs.',
      estimated: true,
    },
  ]);

  const scheduleAgeSec = ageSecFrom(nowMs, schedule.reportedAtMs);

  return (
    <div className="space-y-8">
      <OpsNav active="horizon" />

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <CalendarClock size={22} className="text-gold" />
          <div>
            <h1 className="heading-engraved text-2xl text-ash">Coming up</h1>
            <p className="text-sm text-muted">
              What is scheduled, what is queued, and what is close enough to a threshold to fire
              soon. Read only: nothing on this page triggers anything.
            </p>
          </div>
        </div>
        <p className="text-xs text-muted">
          Rendered {new Date(nowMs).toISOString()}. At most {data.queryCount} database reads plus{' '}
          {data.storageFetches} storage fetch in {Math.round(data.fetchMs)} ms.
        </p>
      </header>

      {!data.databaseReachable && (
        <Card>
          <CardBody className="text-sm text-death">
            The database is unreachable: the service role is not configured for this deployment.
            Every panel below is empty for that reason, not because nothing is scheduled.
          </CardBody>
        </Card>
      )}

      {/* The seeded-table sentinel. `milestones` and `bosses` are reference
          tables the launch wipe resets rather than empties, so a working
          database always answers with rows from at least one. Both empty means
          the reads through lib/data failed, and those loaders swallow their own
          errors, so this is the only place that can say so. */}
      {data.databaseReachable && !data.publicReadOk && (
        <Card>
          <CardBody className="text-sm text-death">
            The seeded reference tables (milestones, bosses) both came back empty, which a working
            database never does: the launch wipe resets those rows rather than deleting them. Treat
            every empty panel below as a failed read, not as an empty world. The deeds, next-boss,
            gathering and title panels are the ones fed through that path.
          </CardBody>
        </Card>
      )}

      {/* Launch */}
      <LaunchPanel nowMs={nowMs} moment={moment} next={nextOpenSteps(steps, 3)} all={steps} />

      {/* Where the numbers come from */}
      <Card>
        <CardBody className="flex flex-wrap items-start gap-3 py-3.5 text-sm">
          <Info size={16} className="mt-0.5 shrink-0 text-frost" />
          <div className="min-w-0 flex-1">
            <p className="text-ash-dim">
              {schedule.reported
                ? `The bot is reporting its own schedule${
                    scheduleAgeSec === null ? '' : `, computed ${formatAgeSec(scheduleAgeSec)}`
                  }. Every number below that only the bot can know is its value, not a default.`
                : data.heartbeats === null
                  ? 'The ops_heartbeats read itself failed, so nothing below is a report from the bot: the cron hour, the voice cadence and the loop intervals are the constants in the repo. This is the cockpit failing to read, not the bot going quiet, and the two look identical from here, which is why it is said plainly.'
                  : 'The bot has not reported its schedule yet, so the cron hour, the voice cadence and the loop intervals below are the constants in the repo, not the values running on the host. The relay cursor and the banked online minutes are not shown at all, because nothing outside that process knows them.'}
              <Explain
                entry={HORIZON_GLOSSARY['bot-schedule-source']}
                size="sm"
                className="ml-1.5"
              />
            </p>
            {!schedule.reported && data.heartbeats !== null && (
              <p className="mt-1 text-xs text-muted">
                The block arrives at the next restart of eilif-discord-bot on the host. That is
                Charlie&apos;s call, not a deploy&apos;s.
              </p>
            )}
            {data.companionCaps && (
              <p className="mt-1 text-xs text-muted">
                In-game Companion self-report: plugin {data.companionCaps.plugin ?? 'version not sent'},
                targeting {data.companionCaps.targeting ? 'supported' : 'not advertised'}. Read off
                the /api/voice poll, throttled to once a minute, so it is for display and never for
                a decision.
              </p>
            )}
          </div>
        </CardBody>
      </Card>

      {/* The rail */}
      <NextUpRail items={rail} nowMs={nowMs} />

      {/* Eilif's own clocks */}
      <section className="grid gap-5 lg:grid-cols-2">
        <RecapCard nowMs={nowMs} schedule={schedule} lastPoty={data.lastPoty} />
        <DawnCard
          schedule={schedule}
          dawn={dawn}
          worldDay={worldDay}
          playersOnline={playersOnline}
        />
        <AmbientCard
          schedule={schedule}
          cadence={cadence}
          newestVoiceQueuedAt={data.newestVoiceQueuedAt}
          nowMs={nowMs}
        />
        <VoiceQueueCard lines={data.voiceQueue} nowMs={nowMs} playersOnline={playersOnline} />
      </section>

      {/* The relay */}
      <RelayPanel
        nowMs={nowMs}
        schedule={schedule}
        backlog={backlog}
        newestEventInsertedAt={data.newestEventInsertedAt}
        newestEventReadable={data.newestEventReadable}
      />

      {/* What the hall is about to earn */}
      <section className="grid gap-5 lg:grid-cols-2">
        <DeedsClose
          deeds={deeds}
          count={unearned}
          publicReadOk={data.publicReadOk}
          rosterKnown={data.titles.length > 0}
        />
        <div className="space-y-5">
          <NextBossCard boss={boss} publicReadOk={data.publicReadOk} />
          <TitlesPanel
            contests={contests}
            rosterSize={data.titles.length}
            titlesIntervalMs={schedule.intervalsMs.titles ?? null}
            publicReadOk={data.publicReadOk}
            cacheSec={TITLES_CACHE_SEC}
          />
        </div>
      </section>

      {/* Calendar */}
      <section className="grid gap-5 lg:grid-cols-2">
        <GatheringsPanel
          gatherings={data.gatherings}
          nowMs={nowMs}
          publicReadOk={data.publicReadOk}
        />
        <ExpiringClaimsPanel claims={data.claims} nowMs={nowMs} urgentMs={CLAIM_URGENT_MS} />
      </section>

      {/* The machinery */}
      <section className="grid gap-5 lg:grid-cols-2">
        <WatchdogPanel row={data.watchdog} readable={data.watchdogReadable} nowMs={nowMs} />
        <MapFramePanel
          eta={mapEta}
          capturedAt={data.mapCapturedAt}
          worldDay={data.mapWorldDay}
          serverWorldDay={worldDay}
          revealedPct={data.mapRevealedPct}
          nowMs={nowMs}
        />
      </section>

      <LoopSchedulePanel
        loops={data.botSubLoops}
        schedule={schedule}
        nowMs={nowMs}
        heartbeatsReadable={data.heartbeats !== null}
      />

      <HostTimersPanel timers={hostTimers} nowMs={nowMs} />

      {/* Cost of this page */}
      <footer className="flex flex-wrap items-center gap-2 border-t border-rune pt-4 text-xs text-muted">
        <Timer size={13} aria-hidden="true" />
        <span>
          At most {data.queryCount} bounded database reads plus {data.storageFetches} storage fetch,
          in {formatDurationSec(data.fetchMs / 1000)} of wall clock, issued in one wave plus one
          dependent count. That is a ceiling, not a tally: eight of them sit behind 60 s caches (the
          deed aggregate and the title roster) and the request-level dedupe folds the repeats, so a
          render measured against production issued 19 cold and 13 warm. Every read carries an
          explicit limit; the windowed ones carry 7 d. Nothing on this page writes.
        </span>
        <span>
          Wall-clock times are printed in {LAUNCH_TZ}, which is the zone the bot and the host timers
          are configured in. Right now that is {stampInZone(nowMs, LAUNCH_TZ)}.
        </span>
      </footer>
    </div>
  );
}
