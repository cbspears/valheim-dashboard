// The relay cursor and its backlog.
//
// This is the panel the 2026-09-06 rehearsal earned. Twenty-one of forty-three
// rows never reached #server while every heartbeat on the Overview tab read
// healthy, because the relay's loop was ticking perfectly and its CURSOR was the
// thing that was wrong. A backlog is the only visible symptom of that failure,
// and nothing else in the system watches for it.

import { Radio } from 'lucide-react';
import { formatCount, formatDurationSec, ageSecFrom, formatAgeSec } from '@/lib/ops/window';
import {
  RELAY_BATCH,
  RELAY_TICK_MS,
  type RelayDrain as RelayDrainResult,
  type ResolvedSchedule,
} from '@/lib/ops/horizon';
import { HORIZON_GLOSSARY } from '@/lib/ops/glossary-horizon';
import { HorizonCard, Row, Chip, NotReported, type Tone } from './Panel';

const STATE_COPY: Record<RelayDrainResult['state'], { label: string; tone: Tone }> = {
  unknown: { label: 'cursor not reported', tone: 'muted' },
  idle: { label: 'caught up', tone: 'good' },
  working: { label: 'draining', tone: 'gold' },
  behind: { label: 'behind', tone: 'bad' },
};

export function RelayPanel({
  nowMs,
  schedule,
  backlog,
  newestEventInsertedAt,
  newestEventReadable,
}: {
  nowMs: number;
  schedule: ResolvedSchedule;
  backlog: RelayDrainResult;
  newestEventInsertedAt: string | null;
  /**
   * False when the events read itself failed. Without it a broken read and a
   * table with no rows both print "no rows", and on this panel the first one
   * would make a stalled relay look caught up.
   */
  newestEventReadable: boolean;
}) {
  const s = STATE_COPY[backlog.state];
  const tickSec = Math.round(RELAY_TICK_MS / 1000);

  return (
    <HorizonCard
      title="Relay cursor and backlog"
      entry={HORIZON_GLOSSARY['relay-cursor']}
      icon={<Radio size={15} />}
      aside={<Chip tone={s.tone}>{s.label}</Chip>}
    >
      {backlog.state === 'unknown' ? (
        <>
          <NotReported
            what="The relay cursor has not been reported."
            why="It lives in the bot's state.json and reaches the cockpit only through the heartbeat's schedule block, which arrives at the next restart of eilif-discord-bot."
          />
          <div className="mt-3 space-y-0">
            <Row
              label="Newest row in events"
              value={
                newestEventInsertedAt ? (
                  formatAgeSec(ageSecFrom(nowMs, newestEventInsertedAt))
                ) : newestEventReadable ? (
                  <span className="text-frost">no rows</span>
                ) : (
                  <span className="text-raid">could not read</span>
                )
              }
              hint="Without a cursor to compare it against, this is only the age of the newest event, not a backlog."
            />
          </div>
        </>
      ) : (
        <div className="space-y-0">
          <Row
            label="Rows the relay has not reached"
            value={
              backlog.pending === null ? (
                <span className="text-frost">count unavailable</span>
              ) : backlog.pending === 0 ? (
                <span className="text-online-glow">none</span>
              ) : (
                <span className={backlog.state === 'behind' ? 'text-death' : 'text-gold'}>
                  {formatCount(backlog.pending)}
                </span>
              )
            }
            hint={`Every row written after the cursor. The relay reads all types and steps over the ones it does not recognise, so this is rows not yet examined, not rows refused.`}
          />
          <Row
            label="Cursor is behind the newest row by"
            value={
              backlog.behindSec === null ? (
                <span className="text-frost">unknown</span>
              ) : backlog.behindSec < 1 ? (
                <span className="text-online-glow">nothing, it is in step</span>
              ) : (
                <span className={backlog.behindSec > 300 ? 'text-death' : undefined}>
                  {formatDurationSec(backlog.behindSec)}
                </span>
              )
            }
            hint="Measured against the newest row that exists, not against the clock: a quiet hall is not a late relay."
          />
          {backlog.drainSec !== null && (
            <Row
              label="Time to drain at the current rate"
              value={`about ${formatDurationSec(backlog.drainSec)}`}
              hint={`${RELAY_BATCH} rows per tick, one tick every ${tickSec} s, so a healthy relay clears ${RELAY_BATCH * (60 / tickSec)} rows a minute.`}
            />
          )}
          <Row
            label="Cursor last moved"
            value={
              backlog.cursorAgeSec === null ? (
                <span className="text-frost">unknown</span>
              ) : (
                formatDurationSec(backlog.cursorAgeSec) + ' ago'
              )
            }
            hint="This is not lateness. A cursor that has not moved in days is a hall nobody has played in, which is why the backlog above is measured against the newest row rather than against the clock."
          />
          <Row
            label="Cursor"
            value={<span className="font-mono text-xs">{schedule.relayCursor}</span>}
            tone="muted"
            hint="events.inserted_at high-water mark, held verbatim by the bot so it is never round-tripped through a Date."
          />
          <Row
            label="Newest row in events"
            value={
              newestEventInsertedAt ? (
                <span className="font-mono text-xs">{newestEventInsertedAt}</span>
              ) : newestEventReadable ? (
                <span className="text-frost">no rows</span>
              ) : (
                <span className="text-raid">could not read</span>
              )
            }
            tone="muted"
            hint={
              newestEventReadable
                ? undefined
                : 'The events read failed, so the "behind by" figure above has nothing to measure against and is not a verdict on the relay.'
            }
          />
        </div>
      )}
    </HorizonCard>
  );
}
