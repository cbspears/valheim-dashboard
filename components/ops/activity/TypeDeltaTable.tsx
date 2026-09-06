// Last 24 h per event type, against the same type's 7 d daily average.

import { Panel, PanelEmpty } from './Panel';
import { ACTIVITY_GLOSSARY } from '@/lib/ops/glossary-activity';
import type { TypeDelta } from '@/lib/ops/activity';

function ratioText(d: TypeDelta): { text: string; tone: string } {
  if (d.ratio === null) {
    // No baseline at all. "Infinity times" would be a number where there is no
    // comparison to make, so the page says what is actually true instead.
    return d.recent > 0
      ? { text: 'first in 7 d', tone: 'text-frost' }
      : { text: 'none either window', tone: 'text-muted' };
  }
  if (d.ratio >= 2) return { text: `${d.ratio.toFixed(1)}x the daily average`, tone: 'text-raid' };
  if (d.ratio <= 0.5) return { text: `${d.ratio.toFixed(1)}x the daily average`, tone: 'text-frost' };
  return { text: `${d.ratio.toFixed(1)}x the daily average`, tone: 'text-ash-dim' };
}

export function TypeDeltaTable({ deltas }: { deltas: TypeDelta[] }) {
  return (
    <Panel
      title="By type, last 24 h against the week"
      entry={ACTIVITY_GLOSSARY['window-delta']}
      note="Events rows only. The 7 d column is divided by 7 to give a daily average, which is the only way the two windows compare."
    >
      {deltas.length === 0 ? (
        <PanelEmpty>
          No events rows in either window. With nobody on the server this is the correct reading,
          not a fault.
        </PanelEmpty>
      ) : (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[26rem] text-sm">
            <thead>
              <tr className="border-b border-rune text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-2 py-2 font-medium">Type</th>
                <th className="px-2 py-2 text-right font-medium">Last 24 h</th>
                <th className="px-2 py-2 text-right font-medium">Per day, 7 d</th>
                <th className="px-2 py-2 text-right font-medium">Move</th>
              </tr>
            </thead>
            <tbody>
              {deltas.map((d) => {
                const r = ratioText(d);
                return (
                  <tr key={d.type} className="border-b border-rune/50 last:border-0">
                    <td className="px-2 py-2 text-ash">{d.type}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-ash">{d.recent}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-ash-dim">
                      {d.baselinePerDay.toFixed(1)}
                      <span className="ml-1 text-xs text-muted">({d.baseline} total)</span>
                    </td>
                    <td className={`px-2 py-2 text-right text-xs ${r.tone}`}>{r.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
