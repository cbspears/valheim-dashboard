'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { CalendarClock } from 'lucide-react';
import { gatheringCountdown, isGatheringImminent } from '@/lib/format';
import type { NextGathering } from '@/lib/next-gathering';

/** Stop showing a gathering this long after it was due to start. */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * The next gathering, as a small glowing pill in the nav bar's empty middle.
 *
 * The countdown arrives pre-computed from the server so the first client
 * render matches the HTML exactly (no hydration mismatch); a timer then keeps
 * it honest, which matters on the two pages that are prerendered at build
 * time and would otherwise show a frozen "in 13 days" forever.
 */
export function NextGatheringPill({
  gathering,
  className,
}: {
  gathering: NextGathering;
  className?: string;
}) {
  const { name, shortName, startsAt, href, external } = gathering;

  // null = "still showing what the server rendered". Set on mount and once a
  // minute after that.
  const [live, setLive] = useState<{ label: string; imminent: boolean; stale: boolean } | null>(
    null
  );

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      setLive({
        label: gatheringCountdown(startsAt, now),
        imminent: isGatheringImminent(startsAt, now),
        stale: now - new Date(startsAt).getTime() > STALE_AFTER_MS,
      });
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [startsAt]);

  // A prerendered page can outlive its gathering; drop the pill rather than
  // advertise a night that already happened.
  if (live?.stale) return null;

  const label = live?.label ?? gathering.label;
  const imminent = live?.imminent ?? gathering.imminent;

  const pill = (
    <>
      <CalendarClock size={13} className="shrink-0 text-gold" aria-hidden />
      <span className="truncate font-display text-gold-light">{shortName}</span>
      <span className="shrink-0 text-ash-dim">· {label}</span>
    </>
  );

  const classes = clsx(
    'gold-ring ember-pill inline-flex min-w-0 items-center gap-1.5 rounded-full border bg-gold/5 px-3 py-1 text-xs',
    'transition-colors hover:bg-gold/15',
    imminent ? 'ember-pill-soon border-gold' : 'border-gold-dim',
    className
  );

  const title = `${name} · ${label}`;
  const aria = `Next gathering: ${name}, ${label}`;

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={classes}
        title={title}
        aria-label={aria}
      >
        {pill}
      </a>
    );
  }

  return (
    <Link href={href} className={classes} title={title} aria-label={aria}>
      {pill}
    </Link>
  );
}
