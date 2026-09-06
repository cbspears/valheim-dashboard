// Announce latency: the gap between a thing happening and Discord hearing it.
//
// Two ledgers with the same shape, and one number that matters more than the
// percentiles: the age of the oldest row that happened and was never announced.
// A deed that fired into silence is invisible on every other page.

import { Megaphone } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { formatAgeSec, formatCount, formatDurationSec } from '@/lib/ops/window';
import type { LatencySummary } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { NoData, Note, Section, Stat, StatRow } from './kit';

export interface LatencyLedger {
  label: string;
  /** The table and the two columns, printed so an operator knows where to look. */
  source: string;
  summary: LatencySummary;
  /** What "pending" means for this ledger, in the reader's terms. */
  pendingNoun: string;
  window: string;
}

export interface LatencyPanelProps {
  ledgers: LatencyLedger[];
}

/** Past this the bot's 2 minute announce loop is not merely late, it is stuck. */
const PENDING_ALARM_SEC = 15 * 60;

export function LatencyPanel({ ledgers }: LatencyPanelProps) {
  return (
    <Section
      title="Announce latency"
      icon={<Megaphone size={18} />}
      entry={PERF_GLOSSARY['announce-latency']}
      caption="How long between a deed or an oath landing in the database and the bot posting it. The bot polls on a two minute loop."
    >
      <div className="space-y-3">
        {ledgers.map((l) => {
          const s = l.summary;
          const alarming = s.oldestPendingSec !== null && s.oldestPendingSec > PENDING_ALARM_SEC;
          return (
            <div key={l.label} className="space-y-2">
              <StatRow cols={5}>
                <Stat label={l.label} value={formatCount(s.n)} window={`announced, ${l.window}`} tone="muted" />
                <Stat label="Median" value={formatDurationSec(s.p50)} window={l.window} />
                <Stat label="p90" value={formatDurationSec(s.p90)} window={l.window} />
                <Stat label="Worst" value={formatDurationSec(s.max)} window={l.window} />
                <Stat
                  label={`Waiting ${l.pendingNoun}`}
                  value={formatCount(s.pending)}
                  window="right now"
                  tone={alarming ? 'bad' : s.pending > 0 ? 'warn' : 'good'}
                  hint={
                    s.oldestPendingSec === null
                      ? 'Nothing is waiting.'
                      : `Oldest ${formatAgeSec(s.oldestPendingSec)}.`
                  }
                />
              </StatRow>
              <Card>
                <CardBody className="py-3">
                  {s.n === 0 && s.pending === 0 ? (
                    <NoData>
                      Nothing in {l.source} inside {l.window}. That is a quiet week, not a fault.
                    </NoData>
                  ) : (
                    <p className="text-xs text-muted">
                      Read from {l.source}. {formatCount(s.n)} announced, {formatCount(s.pending)} still waiting.
                      {alarming
                        ? ` The oldest has been waiting ${formatAgeSec(
                            s.oldestPendingSec,
                          )}, which is well past the bot's two minute loop: check the announcer sub-loops on the Overview tab.`
                        : ''}
                    </p>
                  )}
                </CardBody>
              </Card>
            </div>
          );
        })}
        <Note>
          A pending row is not a slow row, it is an unannounced one: it happened, and as far as Discord is
          concerned it did not.
        </Note>
      </div>
    </Section>
  );
}
