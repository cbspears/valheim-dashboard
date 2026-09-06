// The four panels about the machinery rather than about the world: the
// watchdog's next window, the bot's loop schedule, the map frame projection, and
// the two host timers the cockpit deliberately admits it cannot see.

import { ShieldAlert, Repeat, Map as MapIcon, HardDriveDownload } from 'lucide-react';
import { clsx } from 'clsx';
import {
  formatCountdownSec,
  formatAgeSec,
  formatDurationSec,
  ageSecFrom,
  untilSecFrom,
  formatPercent,
} from '@/lib/ops/window';
import {
  stampInZone,
  nextWatchdogAlertAt,
  cadenceEta,
  WATCHDOG_REALERT_HOURS,
  MAP_CADENCE_SEC,
  LAUNCH_TZ,
  type ResolvedSchedule,
  type CadenceEta,
} from '@/lib/ops/horizon';
import type { WatchdogRow, LoopMetricRow } from '@/app/admin/ops/horizon/data';
import { HORIZON_GLOSSARY } from '@/lib/ops/glossary-horizon';
import { HorizonCard, Row, Chip, Nothing, NotReported } from './Panel';

// ── the watchdog ────────────────────────────────────────────────────────────

export function WatchdogPanel({
  row,
  readable,
  nowMs,
}: {
  row: WatchdogRow | null;
  /**
   * False when the ops_alerts read failed. A null row then means "unknown", not
   * "the watchdog has never fired", and those are opposite readings: the second
   * one is reassuring and would be a lie.
   */
  readable: boolean;
  nowMs: number;
}) {
  const alerting = row?.state === 'alerting';
  const nextAt = nextWatchdogAlertAt(row?.last_alert_at);

  return (
    <HorizonCard
      title="Watchdog re-alert window"
      entry={HORIZON_GLOSSARY['watchdog-window']}
      icon={<ShieldAlert size={15} />}
      aside={
        row ? (
          <Chip tone={alerting ? 'bad' : 'good'}>{row.state ?? 'unknown'}</Chip>
        ) : readable ? undefined : (
          <Chip tone="warn">not readable</Chip>
        )
      }
    >
      {!row && !readable ? (
        <NotReported
          what="The ops_alerts read failed, so the watchdog's state is unknown."
          why="Deliberately not shown as 'no alerts': that reads as an all-clear and this is not one."
        />
      ) : !row ? (
        <NotReported
          what="There is no watchdog row."
          why="The route writes one on its first run. Until then it answers 5xx rather than alerting with no memory."
        />
      ) : (
        <div className="space-y-0">
          <Row
            label="What is unhealthy"
            value={
              row.signature ? (
                <span className="font-mono text-xs text-death">{row.signature}</span>
              ) : (
                <span className="text-online-glow">nothing</span>
              )
            }
          />
          <Row
            label="In this state for"
            value={formatDurationSec(ageSecFrom(nowMs, row.since))}
            hint="Measured from when the current state began, which survives a world wipe: ops_alerts is not touched by it."
          />
          <Row
            label="Alerts sent while unhealthy"
            value={row.alert_count ?? 0}
            tone={(row.alert_count ?? 0) > 0 ? 'warn' : undefined}
            hint="The counter is the number of alerts posted since the pipeline last went unhealthy, and it is reset to zero on recovery. Zero next to a recent last message means that message was the all-clear, not an alert."
          />
          <Row
            label={alerting ? 'May post again' : 'Would next be allowed to post'}
            value={
              nextAt === null ? (
                <span className="text-frost">never posted</span>
              ) : (
                <span>
                  {formatCountdownSec(untilSecFrom(nowMs, nextAt))}
                  <span className="ml-2 text-xs text-muted">
                    {stampInZone(nextAt, LAUNCH_TZ)} {LAUNCH_TZ}
                  </span>
                </span>
              )
            }
            hint={`At most one re-alert every ${WATCHDOG_REALERT_HOURS} h while it stays unhealthy. It also posts immediately on a change of signature, and once on recovery.`}
          />
          <Row
            label={alerting ? 'Last alert posted' : 'Last message posted'}
            value={formatAgeSec(ageSecFrom(nowMs, row.last_alert_at))}
            tone="muted"
            hint={
              alerting
                ? 'The newest alert for the state it is in now.'
                : 'In the ok state this is the recovery message, which is the last thing the watchdog had to say.'
            }
          />
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        The route is pinged every 15 min by GitHub Actions, not by this machine, so it keeps working
        while Charlie&apos;s PC is off.
      </p>
    </HorizonCard>
  );
}

// ── the bot's loops ─────────────────────────────────────────────────────────

/** Cockpit key to the interval key the bot reports it under. */
const LOOP_INTERVAL_KEY: Record<string, string> = {
  relay: 'relay',
  bosses: 'bosses',
  'events-sync': 'events',
  'identity-confirm': 'identityConfirm',
  'voice-queue': 'voice',
  'title-evaluator': 'titles',
  'milestone-evaluator': 'milestones',
  'boss-polls': 'bossPolls',
};

/** Loops with no timer of their own: Discord event handlers, which never tick. */
const EVENT_DRIVEN = new Set(['gallery-ingest', 'oath-ingest', 'identity-link']);

/**
 * Loops on a calendar rather than an interval. The weekly Chronicle is a
 * node-cron job (Sunday, CHRONICLE_HOUR, default 20:00 local), so an "every N
 * minutes" column would be wrong for it rather than merely unknown.
 */
const CRON_DRIVEN: Record<string, string> = {
  'weekly-chronicle': 'Sundays, 20:00 local',
};

export function LoopSchedulePanel({
  loops,
  schedule,
  nowMs,
  heartbeatsReadable,
}: {
  loops: Record<string, LoopMetricRow>;
  schedule: ResolvedSchedule;
  nowMs: number;
  /** False when the ops_heartbeats read failed, which is not the same as a silent bot. */
  heartbeatsReadable: boolean;
}) {
  const keys = Object.keys(loops).sort();
  const enabled = keys.filter((k) => loops[k]?.enabled).length;

  return (
    <HorizonCard
      title="Bot loops and when each is next due"
      entry={HORIZON_GLOSSARY['loop-schedule']}
      icon={<Repeat size={15} />}
      aside={keys.length === 0 && !heartbeatsReadable ? 'not readable' : `${enabled} of ${keys.length} on`}
    >
      {keys.length === 0 && !heartbeatsReadable ? (
        <NotReported
          what="The ops_heartbeats read failed, so the bot's loops could not be listed."
          why="This says nothing about the bot: it is the cockpit that could not read, not the bot that went quiet."
        />
      ) : keys.length === 0 ? (
        <NotReported
          what="The bot has not reported any loops."
          why="Check the discord-bot row on the Overview tab."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-left text-xs">
            <thead>
              <tr className="border-b border-rune text-muted">
                <th className="py-1.5 pr-3 font-normal">Loop</th>
                <th className="py-1.5 pr-3 font-normal">Every</th>
                <th className="py-1.5 pr-3 font-normal">Last success</th>
                <th className="py-1.5 font-normal">Next due</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const loop = loops[key] ?? {};
                const intervalMs = schedule.intervalsMs[LOOP_INTERVAL_KEY[key] ?? key] ?? null;
                const lastSec = ageSecFrom(nowMs, loop.lastSuccessAt);
                const due =
                  intervalMs && loop.lastSuccessAt
                    ? Date.parse(loop.lastSuccessAt) + intervalMs
                    : null;
                const dueSec = due === null ? null : untilSecFrom(nowMs, due);
                const late = dueSec !== null && intervalMs !== null && dueSec < -(intervalMs / 1000);
                const eventDriven = EVENT_DRIVEN.has(key);
                const cronLabel = CRON_DRIVEN[key];
                return (
                  <tr key={key} className="border-b border-rune/40 last:border-0">
                    <td className="py-1.5 pr-3">
                      <span className={loop.enabled ? 'text-ash' : 'text-muted'}>{key}</span>
                      {!loop.enabled && <span className="ml-2 text-muted">off by flag</span>}
                      {loop.lastError && (
                        <span className="ml-2 text-death">error: {loop.lastError}</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-muted">
                      {eventDriven
                        ? 'on a message'
                        : cronLabel
                          ? cronLabel
                          : intervalMs
                            ? formatDurationSec(intervalMs / 1000)
                            : 'not reported'}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-ash-dim">
                      {loop.lastSuccessAt ? formatAgeSec(lastSec) : <span className="text-frost">never</span>}
                    </td>
                    <td className={clsx('py-1.5 tabular-nums', late ? 'text-raid' : 'text-ash-dim')}>
                      {eventDriven
                        ? 'no timer'
                        : cronLabel
                          ? 'weekly'
                          : dueSec === null
                            ? <span className="text-frost">unknown</span>
                            : formatCountdownSec(dueSec)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Enabled is what is actually running, which is not always what the flag asked for: a failed
        boss-polls seed leaves the flag on and the loop asleep.
        {schedule.intervalsReported
          ? ' Intervals are the ones the bot reported from the host.'
          : ' Intervals are the defaults in services/discord-bot/src/index.js, not values read off the host: an overridden TITLES_INTERVAL_MS would make the next-due column wrong until the bot reports.'}
      </p>
    </HorizonCard>
  );
}

// ── the map frame ───────────────────────────────────────────────────────────

export function MapFramePanel({
  eta,
  capturedAt,
  worldDay,
  serverWorldDay,
  revealedPct,
  nowMs,
}: {
  eta: CadenceEta;
  capturedAt: string | null;
  worldDay: number | null;
  serverWorldDay: number | null;
  revealedPct: number | null;
  nowMs: number;
}) {
  const dayMismatch =
    worldDay !== null && serverWorldDay !== null && worldDay !== serverWorldDay;

  return (
    <HorizonCard
      title="Next map frame"
      entry={HORIZON_GLOSSARY['map-frame']}
      icon={<MapIcon size={15} />}
      aside={`every ${Math.round(MAP_CADENCE_SEC / 60)} min`}
    >
      {capturedAt === null ? (
        <NotReported
          what="map/status.json could not be read."
          why="Older snapshot loops did not write it. The map itself may still be current."
        />
      ) : (
        <div className="space-y-0">
          <Row
            label="Last frame charted"
            value={formatAgeSec(ageSecFrom(nowMs, capturedAt))}
            hint="From the snapshot loop's own status.json, not from the object's last-modified header: Supabase leaves that untouched when an upsert writes byte-identical content, which is what happens for days when nobody plays."
          />
          <Row
            label="Next frame expected"
            value={
              eta.untilSec === null ? (
                <span className="text-frost">unknown</span>
              ) : (
                <span className={eta.state === 'overdue' ? 'text-raid' : undefined}>
                  {formatCountdownSec(eta.untilSec)}
                </span>
              )
            }
            hint="Projected from the last run plus the cadence. The loop's phase is whatever its last run set, so this is an estimate, not a schedule."
          />
          <Row
            label="World day framed"
            value={
              worldDay === null ? (
                <span className="text-frost">not recorded</span>
              ) : (
                <span className={dayMismatch ? 'text-raid' : undefined}>day {worldDay}</span>
              )
            }
            hint={
              dayMismatch
                ? `The server is on day ${serverWorldDay}. A snapshotter framing a different world is what left a phantom day-64 frame after the 2026-08-23 wipe.`
                : undefined
            }
          />
          <Row
            label="Map revealed"
            value={revealedPct === null ? <span className="text-frost">not recorded</span> : formatPercent(revealedPct, 1)}
            tone="muted"
          />
        </div>
      )}
    </HorizonCard>
  );
}

// ── the two timers on Charlie's PC ──────────────────────────────────────────

export interface HostTimer {
  name: string;
  unit: string;
  schedule: string;
  purpose: string;
  /** The next fire time derived from the unit file, epoch ms. Null when unresolvable. */
  nextAtMs: number | null;
  /** A heartbeat row, if this timer ever grows one. Null today for both. */
  lastSuccess: string | null;
}

export function HostTimersPanel({ timers, nowMs }: { timers: HostTimer[]; nowMs: number }) {
  return (
    <HorizonCard
      title="Host timers"
      entry={HORIZON_GLOSSARY['host-timers']}
      icon={<HardDriveDownload size={15} />}
      aside={<Chip tone="warn">not observable</Chip>}
    >
      {timers.length === 0 ? (
        <Nothing>No host timers are described.</Nothing>
      ) : (
        <>
          <p className="mb-3 text-xs text-raid">
            Neither of these sends a heartbeat, so the cockpit cannot see whether they ran. The
            schedule below is read from the unit files in the repo, not from the host.
          </p>
          <ol className="divide-y divide-rune/60">
            {timers.map((t) => (
              <li key={t.unit} className="py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm text-ash">{t.name}</span>
                  <span className="shrink-0 text-sm tabular-nums text-ash-dim">
                    {t.nextAtMs === null ? (
                      <span className="text-frost">no countdown</span>
                    ) : (
                      formatCountdownSec(untilSecFrom(nowMs, t.nextAtMs))
                    )}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  <span className="font-mono">{t.unit}</span>, {t.schedule}
                  {t.nextAtMs !== null && (
                    <>
                      {'. Next expected '}
                      {stampInZone(t.nextAtMs, LAUNCH_TZ)} {LAUNCH_TZ}
                    </>
                  )}
                  . {t.purpose}
                </p>
                <p className="mt-0.5 text-xs">
                  {t.lastSuccess ? (
                    <span className="text-online-glow">
                      Heartbeat {formatAgeSec(ageSecFrom(nowMs, t.lastSuccess))}.
                    </span>
                  ) : (
                    <span className="text-frost">
                      No heartbeat row. Verify by hand with systemctl list-timers on the host.
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted">
            The Supabase project is on the free plan: no automated backups, no point-in-time
            recovery. These two timers are the only copies of the world and the data.
          </p>
        </>
      )}
    </HorizonCard>
  );
}

/** Re-exported so the page can build a map ETA without importing two modules. */
export { cadenceEta };
