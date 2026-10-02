'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Camera, User, Clock, MapPin, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { EmptyState, VikingLink } from '@/components/ui';
import { timeAgo } from '@/lib/format';
import type { GalleryPhoto } from '@/lib/types';
import { MAP_ENABLED } from '@/config/server';

/** A gallery photo, with its "posted by" credit already resolved (or not) to
 *  a real viking — see `matchVikingName` in lib/slug.ts, applied by the page. */
type CreditedPhoto = GalleryPhoto & { matchedViking: string | null };

/**
 * GRID AND LIGHTBOX `sizes`, AND WHY THEY MATTER MORE THAN THEY LOOK.
 *
 * These strings are what stop the browser assuming each photo is viewport-wide
 * and pulling the biggest rung in the srcset. The grid is a 1/2/3-column
 * masonry (the `columns-*` classes below), so a tile is roughly a third of the
 * page on a desktop and lands on the 640–1080 px rungs instead of the 1600 px
 * source. The lightbox is capped by `max-w-5xl` (1024 px), so it asks for about
 * that and tops out at the source's own width.
 */
const GRID_SIZES = '(min-width: 1024px) 30vw, (min-width: 640px) 48vw, 94vw';
const LIGHTBOX_SIZES = '(min-width: 1024px) 1024px, 100vw';

/**
 * How many tiles load eagerly. Three is the first row on a desktop and more
 * than the first row anywhere narrower; everything after it is lazy, which on
 * a wall of 132 photos is the difference between a page view costing three
 * images and a page view costing all of them.
 */
const EAGER_TILES = 3;

/**
 * Supabase serves every gallery photo today, but a row could in principle
 * carry some other URL (an older ingest, a hand-inserted link). next/image
 * answers 400 for a src outside `images.remotePatterns`, which would be a
 * broken tile rather than an expensive one, so anything unrecognised is passed
 * through unoptimized — exactly the behaviour this file had before.
 */
function isOptimizable(url: string): boolean {
  return /^https:\/\/[^/]+\.supabase\.co\/storage\/v1\/object\/public\/gallery\/[^?]+$/.test(url);
}

/** Intrinsic size for the aspect-ratio reservation. gallery_photos carries the
 *  real width/height for every row the bot has ever written (it resizes to a
 *  1600 px edge and records what came out); the fallback is only for a row that
 *  predates those columns. */
const dims = (p: { width?: number | null; height?: number | null }) => ({
  width: p.width && p.width > 0 ? p.width : 1600,
  height: p.height && p.height > 0 ? p.height : 900,
});

/** A small "linked to a map place" tag → the map. Rendered when the photo's
 *  caption named a pinned place (gallery ↔ map link). */
function PlaceTag({ name }: { name: string }) {
  // Map paused (config/server.ts MAP_ENABLED): keep the place name, drop the link.
  if (!MAP_ENABLED) {
    return (
      <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-gold-dim/50 bg-gold/10 px-2 py-0.5 text-xs font-medium text-gold-light">
        <MapPin size={11} className="shrink-0" />
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return (
    <Link
      href="/map"
      onClick={(e) => e.stopPropagation()}
      className="gold-ring inline-flex max-w-full items-center gap-1 rounded-full border border-gold-dim/50 bg-gold/10 px-2 py-0.5 text-xs font-medium text-gold-light transition-colors hover:border-gold hover:bg-gold/20"
      title={`See ${name} on the map`}
    >
      <MapPin size={11} className="shrink-0" />
      <span className="truncate">{name}</span>
    </Link>
  );
}

/** Masonry grid of community photos. Click a photo to open it full-size in a lightbox. */
export function PhotoGrid({ photos }: { photos: CreditedPhoto[] }) {
  const [index, setIndex] = useState<number | null>(null);
  const isOpen = index !== null;
  const active = isOpen ? photos[index] : null;

  const close = useCallback(() => setIndex(null), []);
  const step = useCallback(
    (dir: number) =>
      setIndex((i) => (i === null ? i : (i + dir + photos.length) % photos.length)),
    [photos.length]
  );

  // Keyboard: Esc closes, arrows navigate. Lock body scroll while open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, close, step]);

  if (photos.length === 0) {
    return (
      <EmptyState
        icon={<Camera size={28} />}
        title="No pictures yet"
        message="Share a screenshot in Discord and tag the bot. It lands here with your name and the date."
      />
    );
  }

  return (
    <>
      <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 [&>*]:mb-4">
        {photos.map((p, i) => (
          <figure
            key={p.id}
            className="card-surface break-inside-avoid overflow-hidden rounded-[var(--radius-card)] transition-colors hover:border-rune-bright"
          >
            <button
              type="button"
              onClick={() => setIndex(i)}
              className="gold-ring block w-full cursor-zoom-in"
              aria-label={`Expand photo${p.posted_by ? ` by ${p.posted_by}` : ''}`}
            >
              <Image
                src={p.url}
                alt={p.caption ?? `Photo by ${p.posted_by ?? 'a viking'}`}
                {...dims(p)}
                sizes={GRID_SIZES}
                loading={i < EAGER_TILES ? 'eager' : 'lazy'}
                unoptimized={!isOptimizable(p.url)}
                className="h-auto w-full transition-opacity hover:opacity-95"
              />
            </button>
            <figcaption className="space-y-2 p-4">
              {p.caption && <p className="text-sm leading-relaxed text-ash-dim">{p.caption}</p>}
              {p.pin?.name && <PlaceTag name={p.pin.name} />}
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-ash">
                  <User size={12} className="shrink-0 text-gold" />
                  <VikingLink
                    name={p.matchedViking}
                    className="gold-ring truncate rounded-sm transition-colors hover:text-gold-light"
                  >
                    {p.posted_by ?? 'Unknown viking'}
                  </VikingLink>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-muted">
                  <Clock size={12} />
                  {timeAgo(p.posted_at)}
                </span>
              </div>
            </figcaption>
          </figure>
        ))}
      </div>

      {/* ── Lightbox ─────────────────────────────────────────────────────── */}
      {active && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={active.caption ?? 'Photo'}
          onClick={close}
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-pitch/92 p-4 backdrop-blur-sm sm:p-8"
        >
          {/* Close */}
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="gold-ring absolute right-4 top-4 rounded-full border border-rune bg-pitch/70 p-2 text-ash-dim hover:text-ash"
          >
            <X size={20} />
          </button>

          {/* Prev / next (only when there's more than one) */}
          {photos.length > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  step(-1);
                }}
                aria-label="Previous photo"
                className="gold-ring absolute left-2 top-1/2 -translate-y-1/2 rounded-full border border-rune bg-pitch/70 p-2 text-ash-dim hover:text-ash sm:left-4"
              >
                <ChevronLeft size={24} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  step(1);
                }}
                aria-label="Next photo"
                className="gold-ring absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-rune bg-pitch/70 p-2 text-ash-dim hover:text-ash sm:right-4"
              >
                <ChevronRight size={24} />
              </button>
            </>
          )}

          {/* Image + caption — clicks inside don't close */}
          <figure
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-full max-w-5xl cursor-default flex-col items-center"
          >
            <Image
              src={active.url}
              alt={active.caption ?? `Photo by ${active.posted_by ?? 'a viking'}`}
              {...dims(active)}
              sizes={LIGHTBOX_SIZES}
              unoptimized={!isOptimizable(active.url)}
              className="h-auto max-h-[80vh] w-auto max-w-full rounded-[var(--radius-card)] border border-rune object-contain"
            />
            <figcaption className="mt-3 max-w-2xl text-center">
              {active.caption && <p className="text-sm text-ash">{active.caption}</p>}
              {active.pin?.name && (
                <div className="mt-2 flex justify-center">
                  <PlaceTag name={active.pin.name} />
                </div>
              )}
              <p className="mt-1 text-xs text-muted">
                <VikingLink
                  name={active.matchedViking}
                  className="gold-ring rounded-sm text-gold-light transition-colors hover:text-gold"
                >
                  {active.posted_by ?? 'Unknown viking'}
                </VikingLink>
                {' · '}
                {timeAgo(active.posted_at)}
                {photos.length > 1 && (
                  <span className="ml-2 tabular-nums">
                    {index! + 1} / {photos.length}
                  </span>
                )}
              </p>
            </figcaption>
          </figure>
        </div>
      )}
    </>
  );
}
