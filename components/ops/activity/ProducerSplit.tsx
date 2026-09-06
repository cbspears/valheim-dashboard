// Who wrote the window's rows. Derived, and it says so.

import { Panel, PanelEmpty } from './Panel';
import { ACTIVITY_GLOSSARY } from '@/lib/ops/glossary-activity';
import { formatPercent } from '@/lib/ops/window';
import { PRODUCER_NOTES, type ProducerShare } from '@/lib/ops/activity';

export function ProducerSplit({
  shares,
  windowText,
  total,
}: {
  shares: ProducerShare[];
  windowText: string;
  total: number;
}) {
  return (
    <Panel
      title="Split by producer"
      entry={ACTIVITY_GLOSSARY['producer-split']}
      note={`Every row in the timeline, ${windowText}. Attribution is derived from the row shape, not read from a source column.`}
    >
      {shares.length === 0 ? (
        <PanelEmpty>Nothing was written in this window, so there is nothing to attribute.</PanelEmpty>
      ) : (
        <ul className="space-y-3">
          {shares.map((s) => (
            <li key={s.producer}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={s.producer === 'unknown' ? 'text-raid' : 'text-ash'}>{s.label}</span>
                <span className="shrink-0 tabular-nums text-ash-dim">
                  {s.count} <span className="text-muted">of {total}</span>{' '}
                  <span className="text-muted">({formatPercent(s.share)})</span>
                </span>
              </div>
              {/* A plain proportion bar, not a chart: one value against one
                  total needs no axis and no legend. */}
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised ring-1 ring-rune">
                <div
                  className={`h-full rounded-full ${s.producer === 'unknown' ? 'bg-raid' : 'bg-gold'}`}
                  style={{ width: `${Math.max(1, s.share * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted">{PRODUCER_NOTES[s.producer]}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
