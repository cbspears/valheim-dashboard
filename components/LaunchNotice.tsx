import { TriangleAlert } from 'lucide-react';
import { LAUNCH_NOTICE } from '@/config/server';

/**
 * The one loud banner on the site. Renders nothing at all unless
 * `LAUNCH_NOTICE` in config/server.ts is non-empty, so it costs nothing to
 * leave mounted at the top of the Hall and Get Started year-round.
 *
 * Deliberately not dismissible: it exists for the days when a player who
 * misses it cannot join the server.
 */
export function LaunchNotice() {
  const notice = LAUNCH_NOTICE.trim();
  if (!notice) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-[var(--radius-card)] border border-gold-dim bg-gold/10 px-4 py-3.5 sm:px-5"
    >
      <TriangleAlert size={18} className="mt-0.5 shrink-0 text-gold" />
      <div className="min-w-0">
        <p className="font-display text-sm tracking-wide text-gold-light">Read this first</p>
        <p className="mt-1 text-sm leading-relaxed text-ash">{notice}</p>
      </div>
    </div>
  );
}
