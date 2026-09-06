// The four panels behind Eilif's own clocks: the nightly recap, the dawn line,
// the ambient cadence, and the queue the in-game half drains.
//
// They are one file because they share a single fact that has to be stated the
// same way in all four: three of the numbers on them (banked online minutes, the
// last dawn day, the relay cursor) live in the bot's state.json and reach the
// cockpit only through the heartbeat's `metrics.schedule` block. Until the bot
// is restarted on the host that block does not exist, and every one of these
// panels renders "the bot has not reported this yet" instead of a zero.

import { MessageSquare, Sunrise, Waves, ListOrdered } from 'lucide-react';
import { clsx } from 'clsx';
import {
  formatDurationSec,
  formatCount,
  ageSecFrom,
  formatAgeSec,
} from '@/lib/ops/window';
import {
  clockInZone,
  stampInZone,
  ymdStartMs,
  type ResolvedSchedule,
  type DawnNext,
  type AmbientCadence,
} from '@/lib/ops/horizon';
import type { PotyRow, QueuedVoiceLine } from '@/app/admin/ops/horizon/data';
import { HORIZON_GLOSSARY } from '@/lib/ops/glossary-horizon';
import { HorizonCard, Row, Countdown, Chip, NotReported, Nothing, ProgressBar } from './Panel';

/** The one sentence every panel here uses for a value only the bot knows. */
const BOT_SILENT = 'The bot has not reported this yet.';
const BOT_SILENT_WHY =
  'The schedule block reaches the cockpit at the next restart of eilif-discord-bot on the host.';

// ── the nightly recap ───────────────────────────────────────────────────────

export function RecapCard({
  nowMs,
  schedule,
  lastPoty,
}: {
  nowMs: number;
  schedule: ResolvedSchedule;
  /** Null when the poty_history read failed; [] when it read fine and found nothing. */
  lastPoty: PotyRow[] | null;
}) {
  const potyUnreadable = lastPoty === null;
  const newest = lastPoty?.[0] ?? null;
  const ranSec = ageSecFrom(nowMs, newest?.awarded_at);
  // Read in the bot's zone, not UTC: index.js parses RECAPS_START with no
  // trailing Z, so it means local midnight there. See ymdStartMs.
  const gateStartMs = ymdStartMs(schedule.recapsStart, schedule.recapTz);
  const gated = gateStartMs !== null && gateStartMs > nowMs;

  return (
    <HorizonCard
      title="Next recap"
      entry={HORIZON_GLOSSARY['next-recap']}
      icon={<MessageSquare size={15} />}
      aside={schedule.reported ? <Chip tone="good">reported by the bot</Chip> : <Chip>repo defaults</Chip>}
    >
      <div className="space-y-0">
        <Row
          label="Fires"
          value={
            <Countdown
              atMs={schedule.nextRecapAtMs}
              nowMs={nowMs}
              stamp={
                schedule.nextRecapAtMs === null
                  ? null
                  : `${stampInZone(schedule.nextRecapAtMs, schedule.recapTz)}`
              }
              emptyText={`${String(schedule.recapHour).padStart(2, '0')}:00 ${schedule.recapTz}, no countdown`}
            />
          }
          hint={
            schedule.nextRecapSource === 'bot'
              ? "The bot computed this instant in its own zone, which is the one the cron fires against."
              : schedule.nextRecapSource === 'computed'
                ? `Computed here from ${String(schedule.recapHour).padStart(2, '0')}:00 ${schedule.recapTz}. The bot has not reported its own next-run instant.`
                : `The zone ${schedule.recapTz} could not be resolved, so no countdown is shown rather than a wrong one.`
          }
        />
        <Row
          label="Cron"
          value={`0 ${schedule.recapHour} * * * (${schedule.recapTz})`}
          tone="muted"
        />
        <Row
          label="Posts to"
          value={schedule.recapChannel ? `#${schedule.recapChannel}` : 'not reported'}
          tone={schedule.recapChannel === 'server' ? 'warn' : undefined}
          hint={
            schedule.recapChannel === 'server'
              ? 'This is the rehearsal pilot override. Step 20b of the runbook puts it back to #valheim.'
              : schedule.recapChannel === null
                ? BOT_SILENT_WHY
                : undefined
          }
        />
        <Row
          label="Launch gate"
          value={
            schedule.recapsStart
              ? gated
                ? `silent until ${schedule.recapsStart}`
                : `open since ${schedule.recapsStart}`
              : schedule.reported
                ? 'none set'
                : 'not reported'
          }
          tone={gated ? 'warn' : undefined}
          hint={
            gated
              ? 'RECAPS_START holds the recap silent. No recap is expected before that date, so an empty archive below is correct.'
              : schedule.reported
                ? undefined
                : `${BOT_SILENT_WHY} RECAPS_START is a pilot override that step 20b of the runbook clears.`
          }
        />
        <Row
          label="Last one that actually ran"
          value={
            newest ? (
              <span>
                {formatAgeSec(ranSec)}
                <span className="ml-2 text-xs text-muted">
                  {newest.award_label} {newest.character_name}
                </span>
              </span>
            ) : potyUnreadable ? (
              <span className="text-raid">could not read</span>
            ) : (
              <span className="text-frost">none in the last 7 d</span>
            )
          }
          hint={
            newest
              ? `World day ${newest.world_day ?? 'unknown'}. Proof from poty_history, which the bot writes on every recap it posts.`
              : potyUnreadable
                ? // Never the alarm on a failed read. "No recap has run" is the
                  // single most alarming sentence this card can say, and saying
                  // it because the query broke is exactly the false alarm the
                  // panel exists to prevent.
                  'The poty_history read failed, so whether a recap ran is unknown. This is not the same as no recap having run.'
                : gated
                  ? 'Expected: the recap is gated until the launch date.'
                  : 'No Player of the Day archived in the last 7 d. A scheduled cron and a cron that ran are different facts.'
          }
        />
      </div>
    </HorizonCard>
  );
}

// ── the dawn line ───────────────────────────────────────────────────────────

export function DawnCard({
  schedule,
  dawn,
  worldDay,
  playersOnline,
}: {
  schedule: ResolvedSchedule;
  dawn: DawnNext | null;
  worldDay: number | null;
  playersOnline: number | null;
}) {
  return (
    <HorizonCard
      title="Next dawn line"
      entry={HORIZON_GLOSSARY['next-dawn']}
      icon={<Sunrise size={15} />}
      aside={`every ${schedule.dawnEveryDays} world days`}
    >
      {dawn === null ? (
        <NotReported
          what="The world day is not known, so the dawn cycle cannot be placed."
          why="server_status.world_day is written by the in-game emitter."
        />
      ) : (
        <div className="space-y-0">
          <Row
            label="Next dawn"
            value={
              dawn.isToday ? (
                <span className="text-gold">world day {dawn.day}, due now</span>
              ) : (
                <span>
                  world day {dawn.day}
                  <span className="ml-2 text-xs text-muted">
                    {dawn.daysAway} world day{dawn.daysAway === 1 ? '' : 's'} on
                  </span>
                </span>
              )
            }
          />
          <Row label="World is on" value={`day ${worldDay ?? 'unknown'}`} tone="muted" />
          <Row
            label="Last dawn spoken"
            value={
              schedule.lastDawnDay === null ? (
                <span className="text-frost">not reported</span>
              ) : (
                `world day ${schedule.lastDawnDay}`
              )
            }
            hint={
              schedule.lastDawnDay === null
                ? schedule.reported
                  ? 'The bot has never spoken a dawn line on this world.'
                  : BOT_SILENT_WHY
                : dawn.spokenToday
                  ? "Today's dawn line has already been spoken."
                  : undefined
            }
          />
          <Row
            label="Population gate"
            value={
              playersOnline === null ? (
                <span className="text-frost">unknown</span>
              ) : playersOnline > 0 ? (
                <span className="text-online-glow">{playersOnline} in the hall</span>
              ) : (
                <span className="text-muted">empty hall</span>
              )
            }
            hint="A dawn line is never spoken to an empty hall. On a dawn day with nobody online it simply waits."
          />
        </div>
      )}
    </HorizonCard>
  );
}

// ── the ambient cadence ─────────────────────────────────────────────────────

export function AmbientCard({
  schedule,
  cadence,
  newestVoiceQueuedAt,
  nowMs,
}: {
  schedule: ResolvedSchedule;
  cadence: AmbientCadence;
  newestVoiceQueuedAt: string | null;
  nowMs: number;
}) {
  const gapMinutes = Math.round(schedule.voiceMinGapMs / 60000);
  const banked = cadence.minutesAccumulated;
  const fraction = banked === null ? 0 : Math.min(1, banked / schedule.voiceCadenceMinutes);
  const stateLabel: Record<AmbientCadence['state'], { text: string; tone: 'good' | 'warn' | 'muted' }> = {
    unknown: { text: 'not reported', tone: 'muted' },
    accumulating: { text: 'banking online time', tone: 'muted' },
    'held-by-gap': { text: 'held by the min gap', tone: 'warn' },
    ready: { text: 'ready to speak', tone: 'good' },
  };
  const s = stateLabel[cadence.state];

  return (
    <HorizonCard
      title="Ambient voice slot"
      entry={HORIZON_GLOSSARY['ambient-cadence']}
      icon={<Waves size={15} />}
      aside={<Chip tone={s.tone}>{s.text}</Chip>}
    >
      <div className="space-y-0">
        <Row
          label="Online time banked"
          value={
            banked === null ? (
              <span className="text-frost">not reported</span>
            ) : (
              <span>
                {banked.toFixed(0)} min
                <span className="text-muted"> of {schedule.voiceCadenceMinutes} min</span>
              </span>
            )
          }
        />
        {banked !== null && (
          <div className="pt-1.5 pb-2">
            <ProgressBar
              fraction={fraction}
              label="Online time banked toward the next ambient line"
              valueText={`${banked.toFixed(0)} of ${schedule.voiceCadenceMinutes} minutes`}
            />
          </div>
        )}
        <Row
          label="Still owed on the cadence"
          value={
            cadence.minutesOwed === null ? (
              <span className="text-frost">not reported</span>
            ) : cadence.minutesOwed === 0 ? (
              <span className="text-online-glow">nothing, the cadence is met</span>
            ) : (
              `${Math.ceil(cadence.minutesOwed)} min of someone online`
            )
          }
          hint="The accumulator only advances while at least one viking is connected, and an event line resets it to zero."
        />
        <Row
          label={`Global min gap (${gapMinutes} min)`}
          value={
            cadence.blockedByGapSec > 0 ? (
              <span className="text-raid">{formatDurationSec(cadence.blockedByGapSec)} still owed</span>
            ) : (
              <span className="text-online-glow">clear</span>
            )
          }
          hint={
            newestVoiceQueuedAt
              ? `Measured from the newest voice line of any kind, queued ${formatAgeSec(ageSecFrom(nowMs, newestVoiceQueuedAt))}.`
              : 'No voice line has ever been queued, which voice.js treats as a clear gap.'
          }
        />
        {cadence.state === 'unknown' && (
          <div className="pt-2">
            <NotReported what={BOT_SILENT} why={BOT_SILENT_WHY} />
          </div>
        )}
      </div>
    </HorizonCard>
  );
}

// ── the queue itself ────────────────────────────────────────────────────────

export function VoiceQueueCard({
  lines,
  nowMs,
  playersOnline,
}: {
  /** Null when the voice_lines read failed; [] when it read fine and found nothing. */
  lines: QueuedVoiceLine[] | null;
  nowMs: number;
  playersOnline: number | null;
}) {
  const rows = lines ?? [];
  const oldest = rows[0] ?? null;
  const oldestSec = ageSecFrom(nowMs, oldest?.queued_at);
  const stale = oldestSec !== null && oldestSec > 600;

  return (
    <HorizonCard
      title="Voice queue"
      entry={HORIZON_GLOSSARY['voice-queue']}
      icon={<ListOrdered size={15} />}
      aside={lines === null ? 'not readable' : `${formatCount(rows.length)} waiting`}
    >
      {lines === null ? (
        <NotReported
          what="The voice_lines read failed, so the queue depth is unknown."
          why="An empty queue and an unreadable one look the same from outside, so this card refuses to say either."
        />
      ) : rows.length === 0 ? (
        <Nothing>Nothing queued. Every line the bot has written has been spoken.</Nothing>
      ) : (
        <>
          <p className={clsx('mb-3 text-xs', stale ? 'text-raid' : 'text-muted')}>
            Oldest waiting {formatDurationSec(oldestSec)}.{' '}
            {stale
              ? playersOnline && playersOnline > 0
                ? 'Past ten minutes with a viking connected: the Companion is not draining the queue.'
                : 'The hall is empty, so nothing is polling. This clears when somebody joins.'
              : 'The Companion polls every few seconds while a viking is connected.'}
          </p>
          <ol className="divide-y divide-rune/60">
            {rows.slice(0, 20).map((l) => {
              const source = typeof l.meta?.source === 'string' ? l.meta.source : null;
              const template = typeof l.meta?.template === 'string' ? l.meta.template : null;
              return (
                <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                  <Chip>{l.kind ?? 'unknown kind'}</Chip>
                  {source && <span className="text-xs text-muted">source {source}</span>}
                  {template && <span className="text-xs text-muted">{template}</span>}
                  <span className="ml-auto text-xs tabular-nums text-ash-dim">
                    {formatAgeSec(ageSecFrom(nowMs, l.queued_at))}
                  </span>
                </li>
              );
            })}
          </ol>
          {rows.length > 20 && (
            <p className="mt-2 text-xs text-muted">
              Showing the 20 oldest of {formatCount(rows.length)} read (the read itself is capped at
              100).
            </p>
          )}
          <p className="mt-3 text-xs text-muted">
            Line text is never rendered here. Lines are surprise content until spoken, which is why
            voice_lines has no public read policy.
          </p>
        </>
      )}
    </HorizonCard>
  );
}

/** Local clock label, exported so the page can print the bot's zone once. */
export function zoneClock(atMs: number, tz: string): string {
  return clockInZone(atMs, tz);
}
