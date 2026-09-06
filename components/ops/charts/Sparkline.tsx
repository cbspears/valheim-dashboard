// A sparkline: one series, no axes, no interaction, no library.
//
// Inline SVG on purpose. The cockpit is a Server Component tree and the charts
// are decoration on numbers that are already printed beside them, so shipping a
// charting runtime to the browser to draw twelve line segments would be the most
// expensive thing on the page. Everything here renders on the server and arrives
// as markup.
//
// THEME. Colors come from the app's Tailwind tokens through `currentColor`: the
// caller sets a text color class (text-gold, text-frost, text-death) and the
// stroke follows it. Nothing here hard-codes a hex value, so the chart cannot
// drift from the palette in app/globals.css.
//
// ACCESSIBILITY. A chart with no accessible name is noise to a screen reader, so
// `label` is required and becomes the SVG's aria-label. The numbers themselves
// always appear as text next to the chart on these pages; the sparkline is the
// shape, not the data.

import { clsx } from 'clsx';

export interface SparklineProps {
  /** The series, oldest first. Nulls are gaps and break the line. */
  values: (number | null)[];
  /** Accessible name, for example "Events per hour, last 24 h". Required. */
  label: string;
  /** Viewport width in px. The SVG scales to its container width regardless. */
  width?: number;
  /** Viewport height in px. */
  height?: number;
  /** Force the top of the scale. Defaults to the series maximum. */
  max?: number;
  /** Shade the area under the line at low opacity. */
  fill?: boolean;
  /** Mark the newest point with a dot. */
  showLast?: boolean;
  /** Wrapper classes. Set the text color here: the line inherits it. */
  className?: string;
}

export function Sparkline({
  values,
  label,
  width = 160,
  height = 36,
  max,
  fill = true,
  showLast = true,
  className,
}: SparklineProps) {
  const pad = 2;
  const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const top = Math.max(max ?? 0, ...finite, 0);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  // No data at all: draw the baseline so the row keeps its height and the empty
  // state is visibly empty rather than a collapsed gap.
  if (finite.length === 0 || values.length < 2) {
    return (
      <svg
        role="img"
        aria-label={`${label}: no data`}
        viewBox={`0 0 ${width} ${height}`}
        className={clsx('block h-9 w-full text-rune', className)}
        preserveAspectRatio="none"
      >
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="currentColor" strokeWidth={1} />
      </svg>
    );
  }

  const step = innerW / (values.length - 1);
  const y = (v: number) => {
    if (top <= 0) return height - pad;
    return pad + innerH - (v / top) * innerH;
  };

  // Split into runs of consecutive non-null points so a gap is a gap, not a
  // straight line drawn through missing hours.
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      run.push({ x: pad + i * step, y: y(v) });
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length > 0) runs.push(run);

  const lastRun = runs[runs.length - 1];
  const lastPoint = lastRun?.[lastRun.length - 1];

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      className={clsx('block h-9 w-full', className)}
      preserveAspectRatio="none"
    >
      {fill &&
        runs
          .filter((r) => r.length > 1)
          .map((r, i) => (
            <polygon
              key={`fill-${i}`}
              points={[
                `${r[0].x},${height - pad}`,
                ...r.map((p) => `${p.x},${p.y}`),
                `${r[r.length - 1].x},${height - pad}`,
              ].join(' ')}
              fill="currentColor"
              opacity={0.14}
            />
          ))}
      {runs.map((r, i) =>
        r.length > 1 ? (
          <polyline
            key={`line-${i}`}
            points={r.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <circle key={`dot-${i}`} cx={r[0].x} cy={r[0].y} r={1.5} fill="currentColor" />
        ),
      )}
      {showLast && lastPoint && <circle cx={lastPoint.x} cy={lastPoint.y} r={2} fill="currentColor" />}
    </svg>
  );
}
