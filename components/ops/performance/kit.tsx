// The small presentational pieces every panel on the Performance tab is built
// from. Server Components, no state, no client JavaScript: props in, markup out.
//
// It exists so that fourteen panels cannot each invent their own idea of what a
// section heading, a labelled number or a "no data in this window" line looks
// like. The one rule they all enforce is the copy rule from
// docs/OPS-COCKPIT-V2.md §6: a number is never printed without its unit and its
// window, so `Stat` takes `window` as a required prop and `Metric` prints "no
// data" rather than 0 when it is given null.

import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Card, CardBody } from '@/components/ui';
import { Explain } from '@/components/ops/Explain';
import type { GlossaryEntry } from '@/lib/ops/glossary';

/** A page section: heading, optional caption, optional Explain, then content. */
export function Section({
  title,
  caption,
  icon,
  entry,
  children,
}: {
  title: string;
  caption?: string;
  icon?: ReactNode;
  entry?: GlossaryEntry;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <div className="flex items-center gap-2.5">
          {icon && <span className="text-gold">{icon}</span>}
          <h2 className="font-display text-sm uppercase tracking-wide text-ash">{title}</h2>
          {entry && <Explain entry={entry} size="sm" />}
        </div>
        {caption && <p className="mt-0.5 text-xs text-muted">{caption}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * One number with its label, its unit and the window it was measured over.
 *
 * `window` is required and not optional on purpose. Every figure on these pages
 * carries its window in the text, not only in a heading three cards up, and the
 * only way to make that stick across fourteen panels is to make it impossible to
 * render a number without one.
 */
export function Stat({
  label,
  value,
  window,
  tone = 'normal',
  entry,
  hint,
}: {
  label: string;
  value: string;
  window: string;
  tone?: 'normal' | 'good' | 'warn' | 'bad' | 'muted';
  entry?: GlossaryEntry;
  hint?: string;
}) {
  const toneCls = {
    normal: 'text-ash',
    good: 'text-online-glow',
    warn: 'text-raid',
    bad: 'text-death',
    muted: 'text-muted',
  }[tone];
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
        {entry && <Explain entry={entry} size="sm" />}
      </div>
      <div className={clsx('mt-0.5 font-mono text-xl leading-tight', toneCls)}>{value}</div>
      <div className="text-[11px] text-muted">{window}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ash-dim">{hint}</div>}
    </div>
  );
}

/** A responsive row of Stats inside one card. */
export function StatRow({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 5 }) {
  const colCls = {
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-2 lg:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
    5: 'sm:grid-cols-2 lg:grid-cols-5',
  }[cols];
  return (
    <Card>
      <CardBody className={clsx('grid grid-cols-1 gap-x-6 gap-y-5', colCls)}>{children}</CardBody>
    </Card>
  );
}

/** A short explanatory line under a panel: how the number was arrived at. */
export function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <p className={clsx('mt-2 text-[11px] leading-relaxed', tone === 'warn' ? 'text-raid' : 'text-muted')}>
      {children}
    </p>
  );
}

/** The one empty state, so "no data" reads the same on every panel. */
export function NoData({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

/** A table that scrolls horizontally rather than letting the page scroll. */
export function ScrollTable({
  head,
  children,
  minWidth = 640,
}: {
  head: ReactNode;
  children: ReactNode;
  minWidth?: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-rune text-xs uppercase tracking-wider text-muted">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, right = false }: { children: ReactNode; right?: boolean }) {
  return <th className={clsx('px-4 py-2.5 font-medium', right && 'text-right')}>{children}</th>;
}

export function Td({
  children,
  right = false,
  mono = false,
  className,
}: {
  children: ReactNode;
  right?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td className={clsx('px-4 py-2 align-top', right && 'text-right', mono && 'font-mono', className)}>
      {children}
    </td>
  );
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr className="border-b border-rune/40 last:border-0">{children}</tr>;
}

/** A small state pill, for panel-local states the shared StateChip does not cover. */
export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'good' | 'warn' | 'bad' | 'neutral' | 'info';
}) {
  const cls = {
    good: 'bg-online/10 text-online-glow border-online/40',
    warn: 'bg-raid/10 text-raid border-raid/40',
    bad: 'bg-death/10 text-death border-death/40',
    info: 'bg-frost/10 text-frost border-frost/40',
    neutral: 'bg-surface-raised text-muted border-rune',
  }[tone];
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide',
        cls,
      )}
    >
      {children}
    </span>
  );
}
