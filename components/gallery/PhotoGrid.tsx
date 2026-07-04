'use client';

import { useState, useEffect, useCallback } from 'react';
import { Camera, User, Clock, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { EmptyState, VikingLink } from '@/components/ui';
import { timeAgo } from '@/lib/format';
import type { GalleryPhoto } from '@/lib/types';

/** A gallery photo, with its "posted by" credit already resolved (or not) to
 *  a real viking — see `matchVikingName` in lib/slug.ts, applied by the page. */
type CreditedPhoto = GalleryPhoto & { matchedViking: string | null };

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
        message="Share a screenshot in Discord and tag the bot — it will land here with your name and the date."
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.url}
                alt={p.caption ?? `Photo by ${p.posted_by ?? 'a viking'}`}
                loading="lazy"
                className="w-full transition-opacity hover:opacity-95"
              />
            </button>
            <figcaption className="space-y-2 p-4">
              {p.caption && <p className="text-sm leading-relaxed text-ash-dim">{p.caption}</p>}
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-ash">
                  <User size={12} className="shrink-0 text-gold-dim" />
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={active.url}
              alt={active.caption ?? `Photo by ${active.posted_by ?? 'a viking'}`}
              className="max-h-[80vh] w-auto max-w-full rounded-[var(--radius-card)] border border-rune object-contain"
            />
            <figcaption className="mt-3 max-w-2xl text-center">
              {active.caption && <p className="text-sm text-ash">{active.caption}</p>}
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
