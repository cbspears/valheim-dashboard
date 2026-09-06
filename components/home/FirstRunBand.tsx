'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Compass, X } from 'lucide-react';

/**
 * The Hall's first-run band (UX plan, proposal 2).
 *
 * app/page.tsx used to carry no route to /get-started at all: on a phone the
 * only way in was the tenth item behind the nav's hamburger, so a stranger's
 * first screen said nothing about being new. This band is that route, in the
 * most valuable band on the page, directly under the hero.
 *
 * DISMISSAL IS A CONVENIENCE, NEVER A GATE. The server snapshot below is
 * hard-coded to "not dismissed", so the band is in the HTML and in the first
 * client render for everyone; it only disappears once the browser reports a
 * dismissal this viewer made. Every failure mode of localStorage (a private
 * window, blocked site data, an accessor that throws) is caught and answered
 * with `false`, which is the state a viewer who has never dismissed it must
 * see. `readDismissed` is exported so scripts/hall-first-run.test.mjs can run
 * it against a throwing store and prove that, rather than pattern-match it.
 */

/** Namespaced so it cannot collide with anything else this origin stores. */
export const DISMISS_KEY = 'eilif:hall:first-run-dismissed';

/** True only when this browser holds a dismissal. Never throws. */
export function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    // Storage unreachable (private window, blocked cookies, no window at all).
    // Show the band: a viewer who has not dismissed it must always see it.
    return false;
  }
}

/**
 * Dismissed in this tab, held in memory as well as in storage so that closing
 * the band still works when the write fails. It outlives a client-side
 * navigation away from the Hall and back, and dies with the page, which is the
 * same lifetime the storage-less fallback had before.
 */
let dismissedThisVisit = false;

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Dismissing it in another tab counts as dismissing it here.
  window.addEventListener('storage', onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

function getSnapshot(): boolean {
  return dismissedThisVisit || readDismissed();
}

/**
 * The server, and the client's hydrating render, always paint the band. React
 * re-reads getSnapshot after hydration and hides it then if this browser holds
 * a dismissal, so the worst case for a returning viking is one frame of a band
 * they have seen before, and the worst case for a stranger is nothing at all.
 */
function getServerSnapshot(): boolean {
  return false;
}

function dismiss(): void {
  dismissedThisVisit = true;
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // Nothing to do: the band closes for this visit and returns on the next.
  }
  for (const notify of listeners) notify();
}

export function FirstRunBand() {
  const dismissed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (dismissed) return null;

  return (
    // Solid `bg-surface` under the gold wash, like every card on the page: the
    // body carries a photographic background, and a translucent band would put
    // body copy over whatever the fjord happens to be doing behind it.
    <section
      aria-labelledby="first-run-heading"
      className="relative overflow-hidden rounded-[var(--radius-card)] border border-gold-dim/60 bg-surface bg-gradient-to-r from-gold/10 via-gold/[0.06] to-transparent p-5 shadow-[0_0_30px_-14px_rgba(200,149,42,0.5)] sm:p-6"
    >
      {/* One line plus a button on a wide screen; the button drops under the
          words on a phone. The right padding is the dismiss control's corner. */}
      <div className="flex flex-col gap-4 pr-10 lg:flex-row lg:items-center lg:justify-between lg:gap-10 lg:pr-12">
        <div className="min-w-0">
          <h2
            id="first-run-heading"
            className="font-display text-lg tracking-wide text-gold-light"
          >
            New to Eilif? Start here
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-ash">
            Install the modpack and log on. About 15 minutes, no experience needed.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            href="/get-started"
            className="gold-ring inline-flex min-h-11 items-center gap-2.5 rounded-md bg-gold px-5 py-3 font-display text-base tracking-wide text-night transition-colors hover:bg-gold-light"
          >
            <Compass size={18} />
            Get Started
          </Link>
          {/* Quiet second door for the reader whose only question is the mods. */}
          <Link
            href="/resources#mods"
            className="gold-ring inline-flex min-h-11 items-center rounded text-sm text-ash-dim transition-colors hover:text-gold-light"
          >
            What mods do I need?
          </Link>
        </div>
      </div>

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss the getting started notice"
        className="gold-ring absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-md text-muted transition-colors hover:text-ash sm:h-10 sm:w-10"
      >
        <X size={16} />
      </button>
    </section>
  );
}
