// The window toggle and the kind filter, both as plain links.
//
// NO CLIENT JAVASCRIPT. The state these carry is two search params, and search
// params already have a control: a link. Marking this 'use client' to hold a
// useState would ship React state, a hydration pass and an event handler to do
// what an anchor tag does for free, and it would break the back button on the
// way. The page is force-dynamic, so following one of these re-renders the
// server component with the new window and nothing is stale.

import Link from 'next/link';
import { clsx } from 'clsx';
import { KIND_LABELS, type FiredKind } from '@/lib/ops/activity';

export type ActivityWindow = '24h' | '7d';

/** Build this page's URL for a given window and kind, dropping the defaults. */
export function activityHref(w: ActivityWindow, kind: FiredKind | 'all'): string {
  const params = new URLSearchParams();
  if (w !== '24h') params.set('w', w);
  if (kind !== 'all') params.set('kind', kind);
  const q = params.toString();
  return q ? `/admin/ops/activity?${q}` : '/admin/ops/activity';
}

const PILL =
  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition';
const ON = 'border-gold-dim bg-gold/10 text-gold-light';
const OFF = 'border-rune bg-surface text-ash-dim hover:border-rune-bright hover:text-ash';

export function WindowToggle({
  active,
  kind,
}: {
  active: ActivityWindow;
  kind: FiredKind | 'all';
}) {
  const options: { w: ActivityWindow; label: string }[] = [
    { w: '24h', label: 'Last 24 h' },
    { w: '7d', label: 'Last 7 d' },
  ];
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Time window">
      {options.map((o) => (
        <Link
          key={o.w}
          href={activityHref(o.w, kind)}
          aria-current={o.w === active ? 'true' : undefined}
          className={clsx(PILL, o.w === active ? ON : OFF)}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

export function KindFilter({
  window: w,
  active,
  counts,
  total,
}: {
  window: ActivityWindow;
  active: FiredKind | 'all';
  /** Only kinds with at least one row in the window, in the page's order. */
  counts: { kind: FiredKind; label: string; count: number }[];
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by kind">
      <Link
        href={activityHref(w, 'all')}
        aria-current={active === 'all' ? 'true' : undefined}
        className={clsx(PILL, active === 'all' ? ON : OFF)}
      >
        Everything
        <span className="text-muted">{total}</span>
      </Link>
      {counts.map((c) => (
        <Link
          key={c.kind}
          href={activityHref(w, c.kind)}
          aria-current={active === c.kind ? 'true' : undefined}
          className={clsx(PILL, active === c.kind ? ON : OFF)}
        >
          {c.label}
          <span className="text-muted">{c.count}</span>
        </Link>
      ))}
      {/* A filter whose kind has no rows in this window still has to be
          reachable and undoable, so it is shown even at zero. */}
      {active !== 'all' && !counts.some((c) => c.kind === active) && (
        <span className={clsx(PILL, ON)}>
          {/* KIND_LABELS, not the raw slug. This chip renders only when the
              active kind has no rows in the window, which is exactly when
              nothing else on the page is naming it, so printing "boss_kill"
              here next to chips reading "Joins" and "Map pins" put the one
              unreadable label on screen at the one moment it mattered. */}
          {KIND_LABELS[active]}
          <span className="text-muted">0</span>
        </span>
      )}
    </div>
  );
}
