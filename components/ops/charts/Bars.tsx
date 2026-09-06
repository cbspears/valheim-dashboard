// A column chart: one bar per bucket, no library, no interaction.
//
// This is the shape most of the cockpit's history wants: counts per hour over
// the last 24 h, counts per day over the last 7 d. It takes the bucket labels
// with the values so the axis and the data cannot get out of step, and it prints
// only the first, middle and last label, because twenty-four tick labels at this
// size are unreadable.
//
// Same theme and accessibility contract as Sparkline: color comes from the
// caller's text class through `currentColor`, and `label` is required and
// becomes the accessible name. Each bar also carries a <title>, which is the one
// piece of hover behaviour available without any JavaScript at all.

import { clsx } from 'clsx';

export interface BarDatum {
  /** Axis label for this bucket, for example "14:00" or "Sep 06". */
  label: string;
  value: number;
  /** Optional longer text for the bar's tooltip. Defaults to "<label>: <value>". */
  hint?: string;
  /** Draw this bar in a muted tone: use it for the current, incomplete bucket. */
  partial?: boolean;
}

export interface BarsProps {
  bars: BarDatum[];
  /** Accessible name, for example "Events per hour, last 24 h". Required. */
  label: string;
  /** Force the top of the scale. Defaults to the largest value present. */
  max?: number;
  /** Chart height in px, excluding the axis labels. */
  height?: number;
  /** Wrapper classes. Set the text color here: the bars inherit it. */
  className?: string;
  /** Hide the three axis labels under the chart. */
  hideAxis?: boolean;
}

export function Bars({ bars, label, max, height = 64, className, hideAxis = false }: BarsProps) {
  const values = bars.map((b) => (Number.isFinite(b.value) ? b.value : 0));
  const top = Math.max(max ?? 0, ...values, 1);

  if (bars.length === 0) {
    return (
      <div className={clsx('text-xs text-muted', className)} role="img" aria-label={`${label}: no data`}>
        No data in this window.
      </div>
    );
  }

  // Only three labels: first, middle, last. Anything denser is unreadable at the
  // width these charts live in, and the accessible name already carries the window.
  const axisIdx = new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1]);

  return (
    <div className={clsx('w-full', className)}>
      <div
        role="img"
        aria-label={`${label}. Peak ${Math.max(...values)} in one bucket across ${bars.length} buckets.`}
        className="flex w-full items-end gap-px"
        style={{ height }}
      >
        {bars.map((b, i) => {
          const v = Number.isFinite(b.value) ? b.value : 0;
          // A non-zero bucket never renders as nothing: 2px is the floor, so
          // "one event this hour" and "no events this hour" look different.
          const pct = v <= 0 ? 0 : Math.max(2, (v / top) * 100);
          return (
            <div
              key={`${b.label}-${i}`}
              className="flex h-full flex-1 items-end"
              title={b.hint ?? `${b.label}: ${v}`}
            >
              <div
                className={clsx(
                  'w-full rounded-t-[2px]',
                  v <= 0 ? 'bg-rune' : 'bg-current',
                  b.partial && 'opacity-50',
                )}
                style={{ height: `${pct}%`, minHeight: v <= 0 ? 1 : undefined }}
              />
            </div>
          );
        })}
      </div>
      {!hideAxis && (
        <div className="mt-1 flex w-full gap-px text-[10px] text-muted">
          {bars.map((b, i) => (
            <span key={`ax-${b.label}-${i}`} className="flex-1 text-center">
              {axisIdx.has(i) ? b.label : ' '}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
