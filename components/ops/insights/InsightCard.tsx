// One insight, rendered. Presentational: props in, markup out, no reads.
//
// THE SHAPE OF A CARD, and why it is always the same three things:
//   1. A severity chip, so the reader can triage the strip without reading it.
//   2. A headline, which is one sentence and says the thing.
//   3. An evidence line, which carries the numbers, their units, their window
//      and the threshold that made this fire. The headline is the claim; the
//      evidence is how to disagree with it.
// Plus an <Explain/> button carrying the card's own caption, because the owner's
// request was for explanations of what each thing is, and a card that appears on
// a bad night with no caption is the worst possible time to learn a new term.
//
// The chip labels are verbs, not levels: Act, Watch, Good, Info. "Critical" and
// "warning" describe the message; an operator at 2 am wants to be told what to
// do with it.

import { clsx } from 'clsx';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { Card, CardBody } from '@/components/ui';
import { Explain } from '@/components/ops/Explain';
import type { Insight, InsightSeverity } from '@/lib/ops/insights';

const SEVERITY: Record<InsightSeverity, { label: string; chip: string; edge: string }> = {
  critical: {
    label: 'Act',
    chip: 'bg-death/10 text-death border-death/40',
    edge: 'border-l-death/70',
  },
  warn: {
    label: 'Watch',
    chip: 'bg-raid/10 text-raid border-raid/40',
    edge: 'border-l-raid/70',
  },
  good: {
    label: 'Good',
    chip: 'bg-online/10 text-online-glow border-online/40',
    edge: 'border-l-online/60',
  },
  info: {
    label: 'Info',
    chip: 'bg-frost/10 text-frost border-frost/40',
    edge: 'border-l-frost/50',
  },
};

export function InsightCard({ insight }: { insight: Insight }) {
  const s = SEVERITY[insight.severity];
  return (
    <Card className={clsx('border-l-2', s.edge)}>
      <CardBody className="flex h-full flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <span
            className={clsx(
              'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
              s.chip,
            )}
          >
            {s.label}
          </span>
          <Explain entry={insight.explain} align="end" />
        </div>

        <p className="text-sm font-medium leading-snug text-ash">{insight.headline}</p>
        <p className="text-xs leading-relaxed text-ash-dim">{insight.evidence}</p>

        {insight.link && (
          <Link
            href={insight.link.href}
            className="mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium text-gold-dim transition hover:text-gold"
          >
            {insight.link.label}
            <ArrowRight size={12} aria-hidden="true" />
          </Link>
        )}
      </CardBody>
    </Card>
  );
}
