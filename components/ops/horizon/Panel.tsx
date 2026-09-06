// Shared presentational pieces for the "Coming up" tab.
//
// Every panel on the tab is a card with a heading, an <Explain/> button and a
// body, and nearly every number on it is either a countdown or an explicit
// "not reported". Those two shapes are here so fifteen panels cannot each invent
// their own version of them, which is how a page ends up saying "unknown",
// "n/a", "-" and "no data" in four places for the same fact.
//
// All Server Components. There is no interaction on this tab except the
// <Explain/> popover, which is the one client component the page loads.

import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Card, CardBody } from '@/components/ui';
import { Explain } from '@/components/ops/Explain';
import type { GlossaryEntry } from '@/lib/ops/glossary';
import { formatCountdownSec, formatDurationSec, untilSecFrom } from '@/lib/ops/window';

/** A card with a heading, an optional caption button, and an optional right-hand chip. */
export function HorizonCard({
  title,
  entry,
  icon,
  aside,
  children,
  className,
}: {
  title: string;
  entry?: GlossaryEntry;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      {/* flex-wrap plus min-w-0 on both halves: at 390 px a long card title and
          its right-hand chip together are wider than the card, and without the
          wrap the pair pushed the whole document 18 px sideways. The title
          truncates, the chip drops to its own line, and the page never scrolls
          horizontally. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-rune px-5 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {icon && <span className="shrink-0 text-gold">{icon}</span>}
          <h3 className="min-w-0 truncate font-display text-sm uppercase tracking-wide text-ash">
            {title}
          </h3>
          {entry && <Explain entry={entry} size="sm" className="ml-0.5 shrink-0" />}
        </div>
        {aside && <div className="min-w-0 shrink-0 text-xs text-muted">{aside}</div>}
      </div>
      <CardBody className="p-5 text-sm">{children}</CardBody>
    </Card>
  );
}

/** A label/value line. The value is right-aligned so a column of them reads as a column. */
export function Row({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-rune/50 py-1.5 last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span className={clsx('text-right text-sm tabular-nums', toneClass(tone) ?? 'text-ash')}>
        {value}
      </span>
      {hint && <span className="w-full text-xs text-muted">{hint}</span>}
    </div>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'gold';

function toneClass(tone: Tone | undefined): string | undefined {
  switch (tone) {
    case 'good':
      return 'text-online-glow';
    case 'warn':
      return 'text-raid';
    case 'bad':
      return 'text-death';
    case 'muted':
      return 'text-muted';
    case 'gold':
      return 'text-gold';
    default:
      return undefined;
  }
}

/** A small pill. Used for states, owners and source labels. */
export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: Tone }) {
  const cls =
    tone === 'good'
      ? 'border-online/40 bg-online/10 text-online-glow'
      : tone === 'warn'
        ? 'border-raid/40 bg-raid/10 text-raid'
        : tone === 'bad'
          ? 'border-death/40 bg-death/10 text-death'
          : tone === 'gold'
            ? 'border-gold-dim/50 bg-gold/10 text-gold'
            : 'border-rune bg-surface-raised text-muted';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium',
        cls,
      )}
    >
      {children}
    </span>
  );
}

/**
 * The one sentence this tab says whenever a number does not exist.
 *
 * It is a component rather than a string so no panel can quietly substitute a
 * zero for it. "The bot has not reported this yet" and "0 minutes banked" are
 * different facts and the second one is a lie.
 */
export function NotReported({ what, why }: { what: string; why?: string }) {
  return (
    <p className="text-xs text-frost">
      {what}
      {why && <span className="text-muted"> {why}</span>}
    </p>
  );
}

/**
 * A countdown to an instant, with its local stamp underneath.
 *
 * Rendered on the server, so it is correct at render time and then frozen: the
 * page's own header carries the render stamp and the refresh control. That is
 * deliberate. A ticking clock would need a client component on a page whose
 * whole point is that it costs no client JavaScript beyond one popover.
 */
export function Countdown({
  atMs,
  nowMs,
  stamp,
  estimated = false,
  emptyText = 'not scheduled',
}: {
  atMs: number | null;
  nowMs: number;
  /** The local wall-clock stamp, already formatted with its zone name. */
  stamp?: string | null;
  estimated?: boolean;
  emptyText?: string;
}) {
  if (atMs === null) {
    return <span className="text-frost">{emptyText}</span>;
  }
  const sec = untilSecFrom(nowMs, atMs) ?? 0;
  const overdue = sec < -30;
  return (
    <span className={clsx(overdue ? 'text-raid' : 'text-ash')}>
      {formatCountdownSec(sec)}
      {stamp && <span className="ml-2 text-xs text-muted">{stamp}</span>}
      {estimated && <span className="ml-2 text-xs text-muted">estimated</span>}
    </span>
  );
}

/** "2 h 10 m ago" with a tone, or the empty text. */
export function Since({
  sec,
  emptyText = 'never',
  tone,
}: {
  sec: number | null;
  emptyText?: string;
  tone?: Tone;
}) {
  if (sec === null) return <span className="text-frost">{emptyText}</span>;
  return <span className={toneClass(tone) ?? 'text-ash'}>{formatDurationSec(sec)} ago</span>;
}

/**
 * A progress bar with its own accessible name.
 *
 * Not the shared `Gauge` primitive: a gauge is one value against a ceiling with
 * warn and danger colours, and a deed at 95 percent of its threshold is a good
 * thing, not an amber one. Same markup discipline (role, bounds, spoken text),
 * opposite colour meaning.
 */
export function ProgressBar({
  fraction,
  label,
  valueText,
  className,
}: {
  fraction: number;
  label: string;
  valueText: string;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(0, (Number.isFinite(fraction) ? fraction : 0) * 100));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText}
      className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-rune', className)}
    >
      <div
        className={clsx('h-full rounded-full', pct >= 90 ? 'bg-gold' : 'bg-gold-dim')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** The tab's standard empty state: a sentence, never a blank card. */
export function Nothing({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}
