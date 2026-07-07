'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Silent heartbeat for TV Mode. The /tv page is `force-dynamic`, so calling
 * router.refresh() re-runs its Server Components (roster, pulse, map, chronicle)
 * and swaps in fresh data without a hard reload — nothing on a game-night TV
 * ever needs to be touched. Self-contained to components/tv so the whole
 * feature can be deleted in one sweep if it's ever deprecated.
 */
export function TvRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      // Skip work while the tab/monitor is hidden; resume when it's shown again.
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        router.refresh();
      }
    }, intervalMs);

    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
