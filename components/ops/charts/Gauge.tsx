// A horizontal meter: one value against a ceiling, with optional thresholds.
//
// The cockpit has several numbers that only mean something against a limit: the
// Supabase free plan's 500 MB database and 1 GB storage, a heartbeat's age
// against the threshold that turns it stale, a voice line's queue age against
// the ten minutes that call it degraded. All of those are this component.
//
// It is role="meter", not role="img": a meter is exactly the ARIA role for a
// scalar inside a known range, and it gives a screen reader the value, the
// bounds and a spoken text rather than a picture with a caption.
//
// The bar changes color at the thresholds instead of always being gold, so the
// state is legible at a glance and not only from the number beside it. Colors
// are Tailwind token classes, never hex.

import { clsx } from 'clsx';

export interface GaugeProps {
  value: number;
  /** Top of the scale. Values above it clamp to full and are called out in the text. */
  max: number;
  /** Accessible name, for example "Database size against the free plan ceiling". */
  label: string;
  /** The value as the page prints it, with its unit: "312 MB of 500 MB". */
  valueText: string;
  /** Fraction of max (0 to 1) at which the bar turns amber. Default 0.7. */
  warnAt?: number;
  /** Fraction of max (0 to 1) at which the bar turns red. Default 0.9. */
  dangerAt?: number;
  /** Bar thickness in px. */
  height?: number;
  /** Wrapper classes. */
  className?: string;
}

export function Gauge({
  value,
  max,
  label,
  valueText,
  warnAt = 0.7,
  dangerAt = 0.9,
  height = 8,
  className,
}: GaugeProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const raw = Number.isFinite(value) ? Math.max(0, value) : 0;
  const fraction = raw / safeMax;
  const pct = Math.min(100, fraction * 100);
  const tone =
    fraction >= dangerAt ? 'bg-death' : fraction >= warnAt ? 'bg-raid' : 'bg-gold';

  return (
    <div className={clsx('w-full', className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(raw * 100) / 100}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuetext={valueText}
        className="w-full overflow-hidden rounded-full bg-surface-raised ring-1 ring-rune"
        style={{ height }}
      >
        <div className={clsx('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ash-dim">{valueText}</span>
        {fraction > 1 && <span className="font-medium text-death">over the ceiling</span>}
      </div>
    </div>
  );
}
