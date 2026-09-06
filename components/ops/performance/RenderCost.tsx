// What this page costs to draw.
//
// The cockpit is allowed to be expensive and not allowed to be silently
// expensive. Measured with performance.now() around the fetch block on the
// server, every render, so the budget is proved against real data rather than
// promised.

import { Timer } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { Gauge } from '@/components/ops/charts/Gauge';
import { formatCount, formatDurationSec, formatPercent } from '@/lib/ops/window';
import type { RenderCost as RenderCostShape } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { Note, Section, Stat, StatRow } from './kit';

export function RenderCost({
  cost,
  fraction,
  renderedAtIso,
  cachedRequests,
  cachedGroups,
}: {
  cost: RenderCostShape;
  fraction: number;
  renderedAtIso: string;
  /** Requests a cached group avoided on this render. */
  cachedRequests: number;
  /** One line per cached group: what it is and how old it is. */
  cachedGroups: { label: string; ageSec: number; ttlSec: number }[];
}) {
  return (
    <Section
      title="This page's own cost"
      icon={<Timer size={18} />}
      entry={PERF_GLOSSARY['render-cost']}
      caption="Measured on the server, this render, around the block that reads the database."
    >
      <div className="space-y-3">
        <StatRow cols={4}>
          <Stat
            label="Fetch time"
            value={formatDurationSec(cost.fetchMs / 1000)}
            window="this render"
            tone={fraction > 1 ? 'bad' : fraction > 0.7 ? 'warn' : 'good'}
          />
          <Stat
            label="Requests issued"
            value={formatCount(cost.queries)}
            window="this render"
            tone="muted"
            hint={
              cachedRequests > 0
                ? `${formatCount(cachedRequests)} more served from the data cache.`
                : 'Nothing was served from the cache on this render.'
            }
          />
          <Stat label="Rows transferred" value={formatCount(cost.rows)} window="this render" tone="muted" />
          <Stat
            label="Storage requests"
            value={formatCount(cost.storageRequests)}
            window="this render"
            tone="muted"
            hint={
              cost.storageRequests === 0
                ? 'The buckets were not re-weighed on this render.'
                : 'One bucket listing plus object HEADs.'
            }
          />
        </StatRow>

        <Card>
          <CardBody className="space-y-2">
            <Gauge
              value={cost.fetchMs}
              max={cost.budgetMs}
              label="This page's fetch time against its render budget"
              valueText={`${Math.round(cost.fetchMs)} ms of ${cost.budgetMs} ms (${formatPercent(fraction)})`}
            />
            {cachedGroups.length > 0 && (
              <ul className="space-y-0.5 text-[11px] text-muted">
                {cachedGroups.map((g) => (
                  <li key={g.label}>
                    {g.label}: measured{' '}
                    <span className="font-mono text-ash-dim">
                      {g.ageSec < 1 ? 'just now' : formatDurationSec(g.ageSec) + ' ago'}
                    </span>
                    , re-measured at most every {formatDurationSec(g.ttlSec)}.
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">
              Rendered at {renderedAtIso.replace('T', ' ').slice(0, 19)}Z. Every read is bounded by a time
              window and an explicit limit, and the row counts are head-only, so they transfer no rows at all.
              Nothing on this page writes: the storage figures come from public-object HEADs rather than the
              Storage API&apos;s object listing, which is a POST.
            </p>
            <Note>
              The budget is this tab&apos;s share of the 3 s the whole cockpit is held to. If it goes over, the
              fix is to drop a panel, not to raise the budget.
            </Note>
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}
