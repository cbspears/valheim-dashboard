'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Invisible heartbeat for the Hall. Re-fetches the page's Server Components on an
 * interval via router.refresh() so live values (online players, server status, the
 * recent saga) stay fresh without a hard reload — client state and scroll are kept.
 */
export function AutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      // Only refresh while the tab is visible to avoid pointless work in the background.
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        router.refresh();
      }
    }, intervalMs);

    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
