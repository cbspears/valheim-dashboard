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

        {/* Desktop links */}
        <div className="hidden shrink-0 items-center gap-1 md:flex">
          {LINKS.map((l) =>
            l.cta ? (
              <Link
                key={l.href}
                href={l.href}
                className={clsx(
                  'ml-1.5 rounded-md border px-3.5 py-1.5 text-sm font-semibold tracking-wide transition-colors gold-ring',
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
                  'rounded-md px-3 py-1.5 text-sm font-medium tracking-wide transition-colors gold-ring',
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
