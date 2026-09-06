// The hall voice over the window: queued, spoken, and how long the wait was.

import { Panel, PanelEmpty } from './Panel';
import { ACTIVITY_GLOSSARY } from '@/lib/ops/glossary-activity';
import { Figure } from './Panel';
import { formatDurationSec, formatAgeSec } from '@/lib/ops/window';
import type { QueueBacklog, VoiceSummary } from '@/lib/ops/activity';

function Row({ items, heading }: { heading: string; items: { key: string; count: number }[] }) {
  return (
    <div>
      <h4 className="mb-2 text-xs uppercase tracking-wide text-muted">{heading}</h4>
      {items.length === 0 ? (
        <p className="text-xs text-muted">Nothing in this window.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((i) => (
            <li key={i.key} className="flex items-baseline justify-between gap-3">
              <span className="text-ash">{i.key}</span>
              <span className="shrink-0 tabular-nums text-ash-dim">{i.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VoicePanel({
  summary,
  backlog,
  windowText,
  playersOnline,
  className,
}: {
  summary: VoiceSummary;
  /**
   * The unspoken queue at ANY age, not just inside the window.
   *
   * `summary` is windowed and has to stay windowed; this is not. The panel's
   * "oldest line still waiting" figure used to come out of the windowed set,
   * which put a 7 d ceiling on the one number whose whole job is to grow: the
   * in-game plugin only polls while a player is connected, so a line queued
   * during a week nobody played is exactly the line that gets stuck.
   */
  backlog: QueueBacklog;
  windowText: string;
  playersOnline: number;
  className?: string;
}) {
  return (
    <Panel
      title="The hall voice"
      entry={ACTIVITY_GLOSSARY['voice-panel']}
      note={`voice_lines queued ${windowText}. The wait is spoken_at minus queued_at.`}
      className={className}
    >
      {summary.total === 0 ? (
        <PanelEmpty>
          No lines were queued in this window. Eilif speaks on dawn, on a Great Deed, on a crown and
          on an oath, so a quiet window with an empty hall is the expected reading.
          {backlog.oldest !== null && (
            <>
              {' '}
              One thing is still waiting from before this window, though: a {backlog.oldest.source}{' '}
              line queued {formatAgeSec(backlog.oldest.ageSec)} and never spoken.
            </>
          )}
        </PanelEmpty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure
              value={String(summary.total)}
              label={`${summary.total === 1 ? 'line' : 'lines'} queued, ${windowText}`}
            />
            <Figure value={String(summary.spoken)} label="spoken" tone="gold" />
            <Figure
              value={String(summary.queued)}
              label="still waiting"
              tone={summary.queued > 0 && playersOnline > 0 ? 'raid' : 'muted'}
            />
            <Figure
              value={formatDurationSec(summary.waitMedianSec)}
              label="median wait to be spoken"
            />
          </div>
          <div className="mt-3 text-xs text-muted">
            p90 wait {formatDurationSec(summary.waitP90Sec)}.{' '}
            {backlog.oldest !== null ? (
              <>
                Oldest line still waiting: {formatAgeSec(backlog.oldest.ageSec)} (a{' '}
                {backlog.oldest.source} line
                {backlog.oldest.beforeWindow ? `, queued before this window` : ''}).{' '}
                {backlog.waiting} waiting in all
                {backlog.olderThanWindow > 0
                  ? `, ${backlog.olderThanWindow} of them older than ${windowText.replace('last ', '')}`
                  : ''}
                .{' '}
                {playersOnline > 0
                  ? 'Somebody is online, so a growing queue means the in-game plugin is not polling.'
                  : 'Nobody is online, so a waiting queue is correct: the plugin only polls while a player is connected.'}
              </>
            ) : (
              'Nothing is waiting, at any age.'
            )}
          </div>
          <div className="mt-5 grid gap-6 sm:grid-cols-3">
            <Row
              heading="By status"
              items={summary.byStatus.map((s) => ({ key: s.status, count: s.count }))}
            />
            <Row heading="By kind" items={summary.byKind.map((s) => ({ key: s.kind, count: s.count }))} />
            <Row
              heading="By source"
              items={summary.bySource.map((s) => ({ key: s.source, count: s.count }))}
            />
          </div>
        </>
      )}
    </Panel>
  );
}
