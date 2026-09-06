import Link from 'next/link';
import { clsx } from 'clsx';

/**
 * Story's two views, as two links.
 *
 * Deliberately links and not a client component: the whole difference between
 * the views is which rows are read, and an address is something a reader can
 * bookmark and send to someone. There is no state here to keep.
 *
 * TWO ROUTES AND NOT A `?by=` ON ONE. Reading `searchParams` is a request-time
 * API, so it would opt /events out of its build-time prerender and put six
 * Supabase reads on every view of Story (measured 2026-09-06: the route
 * moved from `○ (Static)` with a 1m revalidate to `ƒ (Dynamic)`, and answered
 * `Cache-Control: private, no-cache`). Two static routes cost nothing and are
 * both served from the edge.
 *
 * The labels say plainly which half of Story each one is; the flavour lives
 * in the section subtitle above them (CLAUDE.md copy doctrine).
 */
export function StorytellerToggle({ active }: { active: 'all' | 'storyteller' }) {
  const base =
    'gold-ring rounded-full px-3.5 py-1.5 text-xs font-medium tracking-wide transition-colors';
  const on = 'bg-gold/15 text-gold-light';
  const off = 'text-muted hover:text-ash';

  return (
    <nav
      aria-label="Which part of the story to show"
      className="inline-flex gap-1 rounded-full border border-rune bg-surface-raised p-1"
    >
      <Link
        href="/events"
        aria-current={active === 'all' ? 'page' : undefined}
        className={clsx(base, active === 'all' ? on : off)}
      >
        Everything
      </Link>
      <Link
        href="/events/storyteller"
        aria-current={active === 'storyteller' ? 'page' : undefined}
        className={clsx(base, active === 'storyteller' ? on : off)}
      >
        Written by the warband
      </Link>
    </nav>
  );
}
