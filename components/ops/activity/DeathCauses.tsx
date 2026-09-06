// How the hall died, and who did the dying.

import { Panel, PanelEmpty } from './Panel';
import { ACTIVITY_GLOSSARY } from '@/lib/ops/glossary-activity';
import { formatPercent } from '@/lib/ops/window';

export function DeathCauses({
  causes,
  byViking,
  windowText,
  total,
}: {
  causes: { cause: string; count: number }[];
  byViking: { who: string; count: number }[];
  windowText: string;
  total: number;
}) {
  const unrecorded = causes.find((c) => c.cause === 'cause not recorded')?.count ?? 0;
  return (
    <Panel
      title="Deaths"
      entry={ACTIVITY_GLOSSARY['death-causes']}
      note={`${total} ${total === 1 ? 'death' : 'deaths'}, ${windowText}.`}
    >
      {total === 0 ? (
        <PanelEmpty>No deaths in this window. Either nobody played, or nobody fell.</PanelEmpty>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs uppercase tracking-wide text-muted">By cause</h4>
            <ul className="space-y-1.5">
              {causes.map((c) => (
                <li key={c.cause} className="flex items-baseline justify-between gap-3">
                  <span className={c.cause === 'cause not recorded' ? 'text-raid' : 'text-ash'}>
                    {c.cause}
                  </span>
                  <span className="shrink-0 tabular-nums text-ash-dim">{c.count}</span>
                </li>
              ))}
            </ul>
            {unrecorded > 0 && (
              <p className="mt-2 text-xs text-raid">
                {formatPercent(unrecorded / total)} of these deaths carry no cause. That is the log
                poller reading a ZDOID line, which has none. A high share means the Companion client
                is not reporting.
              </p>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-xs uppercase tracking-wide text-muted">By viking</h4>
            <ul className="space-y-1.5">
              {byViking.map((v) => (
                <li key={v.who} className="flex items-baseline justify-between gap-3">
                  <span className="text-ash">{v.who}</span>
                  <span className="shrink-0 tabular-nums text-ash-dim">{v.count}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  );
}
