// The shared frame every panel on this tab sits in: a card, a title, the caption
// button beside the title, and an optional one-line note under it.
//
// It exists so that "every number gets an explanation" is structurally true
// rather than a thing each panel has to remember. A panel cannot be added
// without an entry, because `entry` is a required prop.

import type { ReactNode } from 'react';
import { Card, CardBody } from '@/components/ui';
import { Explain } from '@/components/ops/Explain';
import type { GlossaryEntry } from '@/lib/ops/glossary';

export function Panel({
  title,
  entry,
  note,
  action,
  children,
  className,
}: {
  title: string;
  /** Required: a panel with no caption is the thing this tab exists to fix. */
  entry: GlossaryEntry;
  /** One line under the title. Say the window here. */
  note?: ReactNode;
  /** Optional control on the title row, for example a filter. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rune px-5 py-3.5">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1 font-display text-sm uppercase tracking-wide text-ash">
            {title}
            <Explain entry={entry} size="sm" />
          </h3>
          {note && <p className="mt-1 text-xs text-muted">{note}</p>}
        </div>
        {action}
      </div>
      <CardBody className="text-sm">{children}</CardBody>
    </Card>
  );
}

/** The one-line "nothing here, and here is what that means" body of a panel. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

/** A number with its unit, over its label. The unit is never optional. */
export function Figure({
  value,
  label,
  tone = 'ash',
}: {
  value: string;
  label: string;
  tone?: 'ash' | 'gold' | 'death' | 'raid' | 'frost' | 'muted';
}) {
  const toneCls = {
    ash: 'text-ash',
    gold: 'text-gold-light',
    death: 'text-death',
    raid: 'text-raid',
    frost: 'text-frost',
    muted: 'text-muted',
  }[tone];
  return (
    <div>
      <div className={`font-display text-xl ${toneCls}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}
