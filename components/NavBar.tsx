'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { clsx } from 'clsx';
import { Menu, X } from 'lucide-react';
import { SERVER_NAME } from '@/config/server';
import { NextGatheringPill } from '@/components/events/NextGatheringPill';
import type { NextGathering } from '@/lib/next-gathering';

const LINKS = [
  { href: '/', label: 'Hall' },
  { href: '/players', label: 'Vikings' },
  { href: '/world', label: 'World' },
  { href: '/map', label: 'Map' },
  { href: '/events', label: 'Saga' },
  { href: '/mods', label: 'Mods' },
  { href: '/gallery', label: 'Gallery' },
  { href: '/oath', label: 'Oath' },
  { href: '/get-started', label: 'Get Started', cta: true },
];

export function NavBar({ nextGathering }: { nextGathering?: NextGathering | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-50 border-b border-rune bg-pitch/85 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="group flex shrink-0 items-center gap-2.5"
          onClick={() => setOpen(false)}
        >
          <span className="text-xl text-gold transition-transform group-hover:scale-110">⚔</span>
          <span className="font-display text-base tracking-wide text-ash sm:text-lg">
            {SERVER_NAME}
          </span>
        </Link>

        {/*
          Next gathering — fills the dead space between the wordmark and the
          tabs. It only appears from lg up: at md the nine tabs already use the
          whole bar, and `min-w-0` + `truncate` mean that even here the pill
          gives up width rather than pushing anything.
        */}
        {nextGathering && (
          <div className="hidden min-w-0 flex-1 justify-center lg:flex">
            <NextGatheringPill gathering={nextGathering} className="max-w-full" />
          </div>
        )}

        {/*
          Desktop links. The nine tabs turn on at md (768px), and at their full
          lg spacing the row measures 668px. With the 75px wordmark and the
          16px bar gap that is 759px of content in the 720px box a 768px
          viewport gives it. 24px of the overrun is swallowed by the bar's own
          right padding, so the visible symptom was a 15px horizontal scroll on
          every page, from 768px through 782px (it clears at 783px).

          Tighter gap/padding and normal tracking below lg take the row to
          561px, so the bar needs 652px of 720px at 768px: 68px of headroom.
          Every value is restored at lg, where the row is 668px again and the
          desktop bar is unchanged.

          All figures measured in a real build, not estimated. Re-measure
          before loosening any of this, and note that a 820px-only check does
          not catch the regression: the band ends at 782px.
        */}
        <div className="hidden shrink-0 items-center gap-0.5 md:flex lg:gap-1">
          {LINKS.map((l) =>
            l.cta ? (
              <Link
                key={l.href}
                href={l.href}
                className={clsx(
                  'ml-1 rounded-md border px-2.5 py-1.5 text-sm font-semibold tracking-normal transition-colors gold-ring lg:ml-1.5 lg:px-3.5 lg:tracking-wide',
                  isActive(l.href)
                    ? 'border-gold bg-gold/20 text-gold-light'
                    : 'border-gold-dim bg-gold/10 text-gold-light hover:border-gold hover:bg-gold/20'
                )}
              >
                {l.label}
              </Link>
            ) : (
              <Link
                key={l.href}
                href={l.href}
                className={clsx(
                  'rounded-md px-2 py-1.5 text-sm font-medium tracking-normal transition-colors gold-ring lg:px-3 lg:tracking-wide',
                  isActive(l.href)
                    ? 'bg-gold/10 text-gold-light'
                    : 'text-ash-dim hover:bg-surface-raised hover:text-ash'
                )}
              >
                {l.label}
              </Link>
            )
          )}
        </div>

        {/* Mobile toggle */}
        <button
          className="rounded-md p-2 text-ash-dim hover:text-ash md:hidden gold-ring"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle navigation"
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </nav>

      {/* Mobile menu */}
      {open && (
        <div className="border-t border-rune bg-pitch/95 px-4 py-2 md:hidden">
          {/* The gathering can't fit in the bar at this width, so it rides at
              the top of the drawer instead of disappearing on phones. */}
          {nextGathering && (
            <div className="flex py-1.5">
              <NextGatheringPill gathering={nextGathering} className="max-w-full" />
            </div>
          )}
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={clsx(
                'mt-1 block rounded-md px-3 py-2.5 text-sm font-medium',
                l.cta
                  ? 'border border-gold-dim bg-gold/10 font-semibold text-gold-light'
                  : isActive(l.href)
                    ? 'bg-gold/10 text-gold-light'
                    : 'text-ash-dim hover:text-ash'
              )}
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </header>
  );
}
