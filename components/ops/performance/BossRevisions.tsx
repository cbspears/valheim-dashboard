// Compare-and-swap traffic on bosses.fight_stats.
//
// This is the one row in the database written by genuinely concurrent writers:
// the client-damage fold, the observed-damage fold and the kill flip all
// read-modify-write the same jsonb blob, guarded by
// `fight_stats->>rev=eq.<what we read>` in lib/fight-stats-cas.ts. The rev is a
// traffic counter for that contention and this is the only place it is visible.

import { Swords } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { formatCount } from '@/lib/ops/window';
import type { BossRevRow } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { Note, Pill, ScrollTable, Section, Td, Th, Tr } from './kit';

const REV_COPY: Record<BossRevRow['revKind'], { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' | 'info' }> = {
  number: { text: 'stamped', tone: 'good' },
  absent: { text: 'not stamped', tone: 'neutral' },
  none: { text: 'never written', tone: 'neutral' },
  odd: { text: 'unmatchable', tone: 'bad' },
};

export function BossRevisions({ rows }: { rows: BossRevRow[] }) {
  const odd = rows.filter((r) => r.revKind === 'odd');
  const stamped = rows.filter((r) => r.revKind === 'number');
  return (
    <Section
      title="Fight record writes"
      icon={<Swords size={18} />}
      entry={PERF_GLOSSARY['boss-rev']}
      caption="The compare-and-swap revision counter on each boss's fight_stats blob."
    >
      <Card>
        <ScrollTable
          minWidth={620}
          head={
            <>
              <Th>Boss</Th>
              <Th>Fight record</Th>
              <Th right>Revision</Th>
              <Th right>Fighters</Th>
              <Th>Top damage from</Th>
            </>
          }
        >
          {rows.map((r) => {
            const copy = REV_COPY[r.revKind];
            return (
              <Tr key={r.name}>
                <Td>
                  <span className={r.isKilled ? 'text-ash' : 'text-muted'}>{r.name}</span>
                  {r.isKilled && r.killedAt && (
                    <span className="ml-2 text-xs text-muted">
                      felled {r.killedAt.slice(0, 10)}
                    </span>
                  )}
                </Td>
                <Td>
                  <Pill tone={copy.tone}>{copy.text}</Pill>
                </Td>
                <Td right mono className={r.rev === null ? 'text-muted' : undefined}>
                  {r.rev === null ? 'none' : formatCount(r.rev)}
                </Td>
                <Td right mono className={r.fighters === null ? 'text-muted' : undefined}>
                  {r.fighters === null ? 'none' : formatCount(r.fighters)}
                </Td>
                <Td className="text-xs text-muted">{r.topDamageFrom ?? 'not recorded'}</Td>
              </Tr>
            );
          })}
        </ScrollTable>
        <CardBody className="pt-3">
          {odd.length > 0 ? (
            <Note tone="warn">
              {odd.map((r) => r.name).join(', ')} carr{odd.length === 1 ? 'ies' : 'y'} a revision that is not a
              number. The compare-and-swap filter can never match it, so every write to that row gives up
              forever. Set it back to an integer, or null the whole fight_stats blob, in the SQL editor.
            </Note>
          ) : (
            <Note>
              {stamped.length === 0
                ? 'No boss carries a revision yet. Every fight record in production predates the counter, which is expected and is not a fault: the first fold after a kill stamps rev 1.'
                : `${formatCount(stamped.length)} boss${stamped.length === 1 ? '' : 'es'} carr${
                    stamped.length === 1 ? 'ies' : 'y'
                  } a revision. A revision that climbs during a fight is the fold working; one that holds still while damage is still being reported means writes are losing the race and giving up.`}
            </Note>
          )}
        </CardBody>
      </Card>
    </Section>
  );
}
