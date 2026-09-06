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
  { href: '/commands', label: 'Commands' },
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
          tabs. It only appears from lg up: at md the ten tabs already use the
          whole bar, and `min-w-0` + `truncate` mean that even here the pill
          gives up width rather than pushing anything.
        */}
        {nextGathering && (
          <div className="hidden min-w-0 flex-1 justify-center lg:flex">
            <NextGatheringPill gathering={nextGathering} className="max-w-full" />
          </div>
        )}

        {/*
          Desktop links. The tabs turn on at md (768px), and at their full lg
          spacing the nine-tab row measured 668px. With the 75px wordmark and
          the 16px bar gap that was 759px of content in the 720px box a 768px
          viewport gives it. 24px of the overrun is swallowed by the bar's own
          right padding, so the visible symptom was a 15px horizontal scroll on
          every page, from 768px through 782px (it cleared at 783px).

          Tighter gap/padding and normal tracking below lg took that row to
          561px, which bought 68px of headroom.

          The tenth tab (Commands, 2026-09-06) spends all of it. With that tab
          added and the md styling left as it was, restyling the row in the live
          DOM at 768px took it from 541px to 635px, so the bar wanted 722px of
          the 720px box and the band was back. Below lg the label therefore also
          drops to text-xs and the horizontal padding to px-1.5 (px-2 on the
          CTA). At lg every value is restored, so the desktop bar is unchanged.

          Re-measured against a real build on 2026-09-06 (Chromium 141 via
          Playwright 1.59.1), which is the number to trust:

            768px and 800px : tab row 545px, bar content 620px of the 720px
                              box, so 100px of headroom
            1024px          : tab row 777px, bar content 852px of 976px

          documentElement.scrollWidth === clientWidth on all 65 page/width
          pairs: /commands, /get-started, /mods, /oath and /world at 360, 390,
          414, 768, 775, 782, 783, 800, 900, 1024, 1152, 1280 and 1440px.

          Re-measure before loosening any of this or adding an eleventh tab, and
          note that a 820px-only check does not catch the regression: the band
          ran from 768px to 782px and cleared at 783px.
        */}
        <div className="hidden shrink-0 items-center gap-0.5 md:flex lg:gap-1">
          {LINKS.map((l) =>
            l.cta ? (
              <Link
                key={l.href}
                href={l.href}
                className={clsx(
                  'ml-1 rounded-md border px-2 py-1.5 text-xs font-semibold tracking-normal transition-colors gold-ring lg:ml-1.5 lg:px-3.5 lg:text-sm lg:tracking-wide',
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
                  'rounded-md px-1.5 py-1.5 text-xs font-medium tracking-normal transition-colors gold-ring lg:px-3 lg:text-sm lg:tracking-wide',
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
