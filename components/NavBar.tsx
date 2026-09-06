'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Menu, X } from 'lucide-react';
import { SERVER_NAME } from '@/config/server';
import { NextGatheringPill } from '@/components/events/NextGatheringPill';
import type { NextGathering } from '@/lib/next-gathering';

/**
 * Eight tabs and the call to action.
 *
 * Mods and Commands became one Resources tab on 2026-09-06; /mods and
 * /commands still answer, as 308s to /resources#mods and /resources#commands
 * (next.config.ts), so a bookmark or an older Discord link still lands. Saga
 * became Story in the same pass, which is a label change only: the route is
 * still /events.
 *
 * Every href here must also be a page in `SITE_PAGES` (config/commands.ts) —
 * scripts/commands-page.test.mjs fails when the nav and the register disagree.
 */
const LINKS = [
  { href: '/', label: 'Hall' },
  { href: '/players', label: 'Vikings' },
  { href: '/world', label: 'World' },
  { href: '/map', label: 'Map' },
  { href: '/events', label: 'Story' },
  { href: '/gallery', label: 'Gallery' },
  { href: '/oath', label: 'Oath' },
  { href: '/resources', label: 'Resources' },
  { href: '/get-started', label: 'Get Started', cta: true },
];

/**
 * The drawer leads with Get Started, keeping its bordered treatment.
 * On a phone the nav is the only route to it, and it was the last of ten rows,
 * under nine labels a newcomer cannot yet decode. The desktop order is left
 * alone, where rightmost gold is where the eye ends up anyway.
 */
const DRAWER_LINKS = [...LINKS.filter((l) => l.cta), ...LINKS.filter((l) => !l.cta)];

/** The drawer's id, so the toggle's aria-controls can name it. */
const DRAWER_ID = 'mobile-nav';

export function NavBar({ nextGathering }: { nextGathering?: NextGathering | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  // Escape closes the drawer and hands focus back to the control that opened
  // it, so a keyboard user is not left at the top of a menu that is gone.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <header className="sticky top-0 z-50 border-b border-rune bg-pitch/85 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        {/* Tab stop 1 on every page. Without `gold-ring` it drew Chromium's
            own 1px outline while every other control got the house 2px gold. */}
        <Link
          href="/"
          className="gold-ring group flex shrink-0 items-center gap-2.5 rounded-md"
          onClick={() => setOpen(false)}
        >
          <span className="text-xl text-gold transition-transform group-hover:scale-110">⚔</span>
          <span className="font-display text-base tracking-wide text-ash sm:text-lg">
            {SERVER_NAME}
          </span>
        </Link>

        {/*
          Next gathering — fills the dead space between the wordmark and the
          tabs. It only appears from lg up: at md the tabs already use the
          whole bar, and `min-w-0` + `truncate` mean that even here the pill
          gives up width rather than pushing anything.
        */}
        {nextGathering && (
          <div className="hidden min-w-0 flex-1 justify-center lg:flex">
            <NextGatheringPill gathering={nextGathering} className="max-w-full" dense />
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

          The tenth tab (Commands, 2026-09-06) spent all of it, so below lg the
          label also drops to text-xs and the horizontal padding to px-1.5
          (px-2 on the CTA). At lg every value is restored, so the desktop bar
          is unchanged.

          Merging Mods and Commands into Resources (2026-09-06) took the row
          back to nine items and handed 49px of it back. Re-measured against a
          real build the same day (Chromium 147.0.7727.15 via Playwright
          1.59.1), which is the number to trust:

            768, 783 and 800px : tab row 496px, wordmark + row 571px of the
                                 720px box a 768px viewport gives, so 149px
                                 of headroom
            1024px             : tab row 705px, wordmark + row 780px of 976px

          documentElement.scrollWidth === clientWidth on all 117 page/width
          pairs: /, /resources, /get-started, /oath, /world, /players,
          /events, /gallery and /map at 360, 390, 414, 768, 775, 782, 783,
          800, 900, 1024, 1152, 1280 and 1440px.

          Re-measure before loosening any of this or adding a tenth tab, and
          note that a 820px-only check does not catch the regression: the band
          ran from 768px to 782px and cleared at 783px.
        */}
        <div className="hidden shrink-0 items-center gap-0.5 md:flex lg:gap-1">
          {LINKS.map((l) =>
            l.cta ? (
              <Link
                key={l.href}
                href={l.href}
                aria-current={isActive(l.href) ? 'page' : undefined}
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
                aria-current={isActive(l.href) ? 'page' : undefined}
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

        {/* Mobile toggle. p-3 around a 20px icon is a 44px target, the floor
            for a control this important on a phone, and `aria-expanded` plus
            `aria-controls` are what announce the drawer's state at all. */}
        <button
          ref={toggleRef}
          type="button"
          className="gold-ring rounded-md p-3 text-ash-dim hover:text-ash md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle navigation"
          aria-expanded={open}
          aria-controls={DRAWER_ID}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </nav>

      {/* Mobile menu. Always in the document so `aria-controls` names something
          real; `hidden` takes it out of the tab order and the a11y tree when
          it is closed, exactly as unmounting did. */}
      <div
        id={DRAWER_ID}
        hidden={!open}
        className="border-t border-rune bg-pitch/95 px-4 py-2 md:hidden"
      >
        {/* The gathering can't fit in the bar at this width, so it rides at
            the top of the drawer instead of disappearing on phones. */}
        {nextGathering && (
          <div className="flex py-1.5">
            <NextGatheringPill gathering={nextGathering} className="max-w-full" />
          </div>
        )}
        {DRAWER_LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            onClick={() => setOpen(false)}
            aria-current={isActive(l.href) ? 'page' : undefined}
            className={clsx(
              // px-3 py-3 on a 20px line is a 44px row.
              'gold-ring mt-1 block rounded-md px-3 py-3 text-sm font-medium',
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
    </header>
  );
}
