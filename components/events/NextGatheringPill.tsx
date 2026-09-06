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
 * Central, the way every other event time on the site is written. The long
 * form ("Sat, Jun 27 · 7:00 PM CT") is `formatEventWhen` in lib/format.ts and
 * is what the cards use; the pill needs the weekday and the hour and nothing
 * else, because it has a nav bar's worth of room and the date is the part a
 * reader can work out for themselves from "in 3 days".
 */
const EVENT_TZ = 'America/Chicago';

/** ISO -> "Wed 5:30 PM CT", or '' when the date will not parse. */
function gatheringWhen(iso: string): string {
  try {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat('en-US', { timeZone: EVENT_TZ, weekday: 'short' }).format(d);
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: EVENT_TZ,
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
    return `${day} ${time} CT`;
  } catch {
    return '';
  }
}

/**
 * The next gathering, as a small glowing pill in the nav bar's empty middle.
 *
 * IT SHOWS THE FACTS, NOT THE NAME. It used to lead with the event's own name,
 * which is the first thing a 24-character budget eats: "DEEP NORTH LAUNC… ·
 * in 3 days" spent the whole pill on an ellipsis and kept only the generic
 * half. When it falls, it now falls back to the day and the hour, which are
 * the two things a reader actually needs; the full name is still on the hover
 * title and in the screen-reader label.
 *
 * WHERE IT POINTS IS STILL OPEN. Plan item 39 asks for the Hall's `#coming-up`;
 * that anchor does not exist (verified 2026-09-06: no `coming-up` id anywhere
 * under app/, components/, lib/ or config/), and the destination itself is set
 * in `lib/next-gathering.ts` (`event.url ?? '/world#gatherings'`), which
 * Proposal 6 also wants to move. Until the Hall grows the anchor, the pill
 * keeps pointing at the Discord event, which is at least a real place.
 *
 * The countdown arrives pre-computed from the server so the first client
 * render matches the HTML exactly (no hydration mismatch); a timer then keeps
 * it honest, which matters on the two pages that are prerendered at build
 * time and would otherwise show a frozen "in 13 days" forever. `gatheringWhen`
 * needs no such care: it is a fixed instant rendered in a fixed zone, so the
 * server and the browser always agree on it.
 */
export function NextGatheringPill({
  gathering,
  className,
  dense = false,
}: {
  gathering: NextGathering;
  className?: string;
  /**
   * The nav bar's copy, where the pill shares a row with nine tabs and folds
   * to fit. The drawer, which has a whole phone width to itself, leaves this
   * off and shows the whole line. See the fold order below.
   */
  dense?: boolean;
}) {
  const { name, startsAt, href, external } = gathering;

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
  const when = gatheringWhen(startsAt);

  // WHAT FOLDS AWAY, AND IN WHICH ORDER. In the bar the pill gets whatever the
  // tabs leave: 164px at 1024 and 292px at 1280 and up (measured 2026-09-06
  // against a real build). The whole line wants about 310px, so it never fits
  // there, and the parts fold from the least useful end:
  //   the words "Next gathering" only ever show in the drawer, where the pill
  //     has a whole phone width and the calendar icon has less to say;
  //   the day and hour show from xl (292px of room, and the line is 210px);
  //   the countdown always shows, because it is the smallest and the most
  //     human of the three.
  // Nothing is lost by folding: the name, the day and the countdown are all in
  // the label a screen reader reads and in the title a mouse hovers.
  const inBarOnly = clsx('shrink-0', dense && 'hidden');
  const fromXl = clsx('shrink-0', dense && 'hidden xl:inline');
  const pill = (
    <>
      <CalendarClock size={13} className="shrink-0 text-gold" aria-hidden />
      <span className={clsx(inBarOnly, 'text-ash-dim')}>Next gathering</span>
      <span className={clsx(inBarOnly, 'text-rune-bright')} aria-hidden>
        ·
      </span>
      {when && <span className={clsx(fromXl, 'font-display text-gold-light')}>{when}</span>}
      {when && (
        <span className={clsx(fromXl, 'text-rune-bright')} aria-hidden>
          ·
        </span>
      )}
      <span className="truncate text-ash-dim">{label}</span>
    </>
  );

  const classes = clsx(
    'gold-ring ember-pill inline-flex min-w-0 items-center gap-1.5 rounded-full border bg-gold/5 px-3 py-1 text-xs',
    'transition-colors hover:bg-gold/15',
    imminent ? 'ember-pill-soon border-gold' : 'border-gold-dim',
    className
  );

  // Built from the parts that exist. `gatheringWhen` returns '' when the date
  // will not parse, and joining unconditionally put an empty segment into both
  // strings ("Deep North Launch Night ·  · in 3 days"), which a screen reader
  // reads as a stumble on the one label that is meant to carry everything the
  // pill folded away.
  const facts = [name, when, label].filter(Boolean);
  const title = facts.join(' · ');
  const aria = `Next gathering: ${facts.join(', ')}`;

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
