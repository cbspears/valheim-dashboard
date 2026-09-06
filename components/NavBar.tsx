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
 * Seven tabs and the call to action, in F-pattern priority.
 *
 * Mods and Commands became one Resources tab on 2026-09-06; /mods and
 * /commands still answer, as 308s to /resources#mods and /resources#commands
 * (next.config.ts), so a bookmark or an older Discord link still lands. Saga
 * became Story in the same pass, which is a label change only: the route is
 * still /events.
 *
 * The Oath tab went the same way later that day. The wall is now the "Oaths
 * sworn" section under the roster on /players, and /oath is a 308 to
 * /players#oaths. Ten flat tabs had no grouping and nothing told a newcomer
 * which one mattered; seven leaves the record of the world on the left and
 * the one thing a stranger should press on the right.
 *
 * Every href here must also be a page in `SITE_PAGES` (config/commands.ts) —
 * scripts/commands-page.test.mjs fails when the nav and the register disagree,
 * and it holds this list at seven plus the call to action, because an eighth
 * tab means re-measuring the 768px band the comment below records.
 */
const LINKS = [
  { href: '/', label: 'Hall' },
  { href: '/players', label: 'Vikings' },
  { href: '/world', label: 'World' },
  { href: '/map', label: 'Map' },
  { href: '/events', label: 'Story' },
  { href: '/gallery', label: 'Gallery' },
  { href: '/resources', label: 'Resources' },
  { href: '/get-started', label: 'Get Started', cta: true },
];

/**
 * The drawer inverts the desktop order: Get Started as a full-width gold
 * button first, a divider, then the seven tabs. On a phone the nav is the only
 * route to it, and it used to be the last of ten rows, under nine labels a
 * newcomer cannot yet decode. The divider is what makes the button read as the
 * one action rather than the first of eight equal rows. The desktop order is
 * left alone, where rightmost gold is where the eye ends up anyway.
 */
const DRAWER_CTA = LINKS.find((l) => l.cta);
const DRAWER_TABS = LINKS.filter((l) => !l.cta);

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
          back to nine items, and folding the Oath tab into /players later the
          same day took it to eight (seven tabs and the CTA). Re-measured
          against a real build after that fold, which is the number to trust:

            768, 783 and 800px : tab row 454px, wordmark + row 529px of the
                                 720px box a 768px viewport gives, so 191px
                                 of headroom
            1024px             : tab row 642px, wordmark + row 717px of 976px
            1440px             : tab row 642px in a bar capped at 1152px
                                 (max-w-6xl), so the row stops growing at lg

          documentElement.scrollWidth === clientWidth on all 104 page/width
          pairs: /, /players, /world, /map, /events, /gallery, /resources and
          /get-started at 360, 390, 414, 768, 775, 782, 783, 800, 900, 1024,
          1152, 1280 and 1440px.

          Re-measure before loosening any of this or adding an eighth tab (the
          tripwire holds the count at seven plus the CTA for that reason), and
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
        {DRAWER_CTA && (
          <Link
            href={DRAWER_CTA.href}
            onClick={() => setOpen(false)}
            aria-current={isActive(DRAWER_CTA.href) ? 'page' : undefined}
            // px-3 py-3 on a 20px line is a 44px row, and `block` makes it the
            // full width of the drawer rather than a label with a box round it.
            className="gold-ring mt-1 block rounded-md border border-gold-dim bg-gold/15 px-3 py-3 text-center text-sm font-semibold text-gold-light"
          >
            {DRAWER_CTA.label}
          </Link>
        )}

        {/* The one rule of this drawer: the button above, the record below. */}
        <hr className="my-2 border-t border-rune" />

        {DRAWER_TABS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            onClick={() => setOpen(false)}
            aria-current={isActive(l.href) ? 'page' : undefined}
            className={clsx(
              'gold-ring mt-1 block rounded-md px-3 py-3 text-sm font-medium',
              isActive(l.href) ? 'bg-gold/10 text-gold-light' : 'text-ash-dim hover:text-ash'
            )}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </header>
  );
}
