// Things that fired in the data and that nobody was ever told about.

import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Panel } from './Panel';
import { ACTIVITY_GLOSSARY } from '@/lib/ops/glossary-activity';
import { formatAgeSec } from '@/lib/ops/window';
import type { UnannouncedItem } from '@/lib/ops/activity';

/** Anything older than this has outlived the bot's 2 min announce loop by far. */
const CONCERN_SEC = 15 * 60;

export function UnannouncedPanel({ items }: { items: UnannouncedItem[] }) {
  const worrying = items.filter((i) => i.ageSec > CONCERN_SEC);
  return (
    <Panel
      title="Fired but never announced"
      entry={ACTIVITY_GLOSSARY.unannounced}
      note="Not windowed: a backlog does not stop being a backlog at 7 days. Oldest first."
    >
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-ash-dim">
          <CheckCircle2 size={16} className="text-online-glow" />
          Nothing is waiting to be announced.
        </p>
      ) : (
        <>
          {worrying.length > 0 && (
            <p className="mb-3 flex items-start gap-2 rounded border border-raid/40 bg-raid/10 px-3 py-2 text-xs text-raid">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                {worrying.length} of these {worrying.length === 1 ? 'is' : 'are'} older than 15
                minutes. The bot announce loop runs every 2 minutes, so this is a backlog, not a
                queue.
              </span>
            </p>
          )}
          <ul className="space-y-2.5">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className={i.ageSec > CONCERN_SEC ? 'text-raid' : 'text-ash'}>{i.what}</span>
                <span className="shrink-0 text-xs text-muted">
                  {formatAgeSec(i.ageSec)} · {i.table}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
