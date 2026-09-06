// The same health question, asked in the reader's terms.
//
// A visitor does not see components, they see pages. If the roster is forty
// minutes old, the Hall is showing a hall that emptied forty minutes ago and
// nothing on that page says so. Each rung names the row or object behind it, so
// the answer to "which component" is one hop away on the Overview tab.

import { Layers } from 'lucide-react';
import { Card } from '@/components/ui';
import { formatAgeSec, formatDurationSec } from '@/lib/ops/window';
import type { FreshnessRung } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { Pill, ScrollTable, Section, Td, Th, Tr } from './kit';

const STATE_COPY: Record<FreshnessRung['state'], { text: string; tone: 'good' | 'warn' | 'bad' | 'info' }> = {
  fresh: { text: 'Fresh', tone: 'good' },
  aging: { text: 'Aging', tone: 'warn' },
  stale: { text: 'Stale', tone: 'bad' },
  unknown: { text: 'Unknown', tone: 'info' },
};

export function FreshnessLadder({ rungs }: { rungs: FreshnessRung[] }) {
  return (
    <Section
      title="What the site is showing"
      icon={<Layers size={18} />}
      entry={PERF_GLOSSARY['freshness-ladder']}
      caption="The age of the newest row or object behind each public surface, against that surface's own threshold."
    >
      <Card>
        <ScrollTable
          minWidth={680}
          head={
            <>
              <Th>Surface</Th>
              <Th>State</Th>
              <Th right>Age</Th>
              <Th right>Stale after</Th>
              <Th>Read from</Th>
            </>
          }
        >
          {rungs.map((r) => {
            const copy = STATE_COPY[r.state];
            return (
              <Tr key={r.surface}>
                <Td>{r.surface}</Td>
                <Td>
                  <Pill tone={copy.tone}>{copy.text}</Pill>
                </Td>
                <Td right mono className={r.ageSec === null ? 'text-muted' : undefined}>
                  {formatAgeSec(r.ageSec)}
                </Td>
                <Td right mono className="text-[11px] text-muted">
                  {formatDurationSec(r.staleAfterSec)}
                </Td>
                <Td mono className="text-[11px] text-muted">{r.source}</Td>
              </Tr>
            );
          })}
        </ScrollTable>
      </Card>
    </Section>
  );
}
