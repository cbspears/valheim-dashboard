// The #server relay's cursor against the newest row in the table.
//
// The failure this exists for is silent by construction: a relay tick that posts
// nothing is a success, so a cursor stuck behind a row it will never match looks
// exactly like a quiet evening. Both the heartbeat and the watchdog stayed green
// through the 2026-09-06 rehearsal that lost 21 of 43 rows.

import { Radio } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { formatAgeSec, formatCount } from '@/lib/ops/window';
import type { RelayBacklog } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { Note, Pill, Section, Stat, StatRow } from './kit';

export interface RelayPanelProps {
  backlog: RelayBacklog;
  /** The newest events.inserted_at the page read, for the "up to" line. */
  newestInsertedAt: string | null;
  newestAgeSec: number | null;
}

const STATE_COPY: Record<RelayBacklog['state'], { pill: string; tone: 'good' | 'warn' | 'bad' | 'info'; line: string }> = {
  unknown: {
    pill: 'Not reported',
    tone: 'info',
    line:
      'The Discord bot has not published a relay cursor in its heartbeat yet. The cursor block is added by ' +
      'services/discord-bot/src/heartbeat.js and reaches this page only after the bot is restarted by hand ' +
      'on the host. Until then the backlog cannot be measured, which is different from being zero.',
  },
  idle: {
    pill: 'Idle',
    tone: 'good',
    line: 'Every row inside this page window has been relayed. Nothing is waiting.',
  },
  working: {
    pill: 'Working',
    tone: 'good',
    line: 'A small backlog inside one tick of the 15 s relay loop. This is what a busy evening looks like.',
  },
  behind: {
    pill: 'Behind',
    tone: 'bad',
    line:
      'The cursor is more than 5 minutes or 50 rows behind. Check the relay sub-loop on the Overview tab ' +
      'for an error, then the bot journal on the host. A relay stalled on a 401, 403 or 404 holds its ' +
      'cursor deliberately rather than dropping rows, so the backlog drains once the cause is fixed.',
  },
};

export function RelayPanel({ backlog, newestInsertedAt, newestAgeSec }: RelayPanelProps) {
  const copy = STATE_COPY[backlog.state];
  return (
    <Section
      title="Relay backlog"
      icon={<Radio size={18} />}
      entry={PERF_GLOSSARY['relay-backlog']}
      caption="How far the #server relay's cursor is behind the newest row in the events table."
    >
      <div className="space-y-3">
        <StatRow cols={4}>
          <Stat
            label="State"
            value={copy.pill}
            window="right now"
            tone={copy.tone === 'good' ? 'good' : copy.tone === 'bad' ? 'bad' : 'muted'}
          />
          <Stat
            label="Rows waiting"
            value={backlog.state === 'unknown' ? 'unknown' : formatCount(backlog.pending)}
            window="last 7 d of rows"
            tone={backlog.pending > 50 ? 'bad' : 'normal'}
          />
          <Stat
            label="Oldest waiting"
            value={backlog.behindSec === null ? 'none' : formatAgeSec(backlog.behindSec)}
            window="right now"
            tone={backlog.behindSec !== null && backlog.behindSec > 300 ? 'bad' : 'normal'}
          />
          <Stat
            label="Newest row"
            value={newestAgeSec === null ? 'no rows' : formatAgeSec(newestAgeSec)}
            window="last 7 d"
            tone="muted"
            hint={newestInsertedAt ? `${newestInsertedAt.replace('T', ' ').slice(0, 19)}Z` : undefined}
          />
        </StatRow>

        <Card>
          <CardBody className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={copy.tone}>{copy.pill}</Pill>
              {backlog.cursorIso && (
                <span className="font-mono text-xs text-muted">
                  cursor {backlog.cursorIso.replace('T', ' ').slice(0, 19)}Z
                </span>
              )}
            </div>
            <p className="text-sm text-ash-dim">{copy.line}</p>
            {backlog.state !== 'unknown' && backlog.boundedByWindow && (
              <Note>
                The row count is taken from the rows this page already read, so it covers the last 7 d only.
                A backlog older than that would be under-reported here and would show on the Overview tab as
                a stale relay sub-loop instead.
              </Note>
            )}
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}
