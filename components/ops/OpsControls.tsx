'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, LogOut } from 'lucide-react';
import { timeAgoShort } from './format';

/**
 * Header controls for the cockpit: a manual Refresh (router.refresh re-runs the
 * Server Component's data fetch) with a "last refreshed" readout, and Log out.
 * Observational only — no restart/mutate actions anywhere in the cockpit.
 */
export function OpsControls({ renderedAtIso }: { renderedAtIso: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [, force] = useState(0);

  // Re-render the relative "last refreshed" label every 15s without refetching.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function logout() {
    await fetch('/api/ops/logout', { method: 'POST' });
    router.push('/admin/ops/login');
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted" suppressHydrationWarning>
        Refreshed {timeAgoShort(renderedAtIso)}
      </span>
      <button
        onClick={refresh}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-rune bg-surface-raised px-3 py-1.5 text-xs font-medium text-ash-dim transition hover:border-gold-dim hover:text-ash disabled:opacity-50"
      >
        {/* The spin is the only motion on this site that carries state rather
            than decoration, so it is exempt from the reduced-motion stop in
            globals.css. The disabled button and its faded label say the same
            thing a second way. */}
        <RefreshCw
          size={14}
          className={pending ? 'animate-spin' : ''}
          data-motion={pending ? 'essential' : undefined}
        />
        Refresh
      </button>
      <button
        onClick={logout}
        className="inline-flex items-center gap-1.5 rounded-md border border-rune bg-surface-raised px-3 py-1.5 text-xs font-medium text-ash-dim transition hover:border-death hover:text-death"
      >
        <LogOut size={14} />
        Log out
      </button>
    </div>
  );
}
