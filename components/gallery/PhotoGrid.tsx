import { Camera, User, Clock } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { timeAgo } from '@/lib/format';
import type { GalleryPhoto } from '@/lib/types';

/** Masonry grid of community photos. Uses plain <img> so any image host works. */
export function PhotoGrid({ photos }: { photos: GalleryPhoto[] }) {
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
    <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 [&>*]:mb-4">
      {photos.map((p) => (
        <figure
          key={p.id}
          className="card-surface break-inside-avoid overflow-hidden rounded-[var(--radius-card)] transition-colors hover:border-rune-bright"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={p.url}
            alt={p.caption ?? `Photo by ${p.posted_by ?? 'a viking'}`}
            loading="lazy"
            className="w-full"
          />
          <figcaption className="space-y-2 p-4">
            {p.caption && <p className="text-sm leading-relaxed text-ash-dim">{p.caption}</p>}
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-ash">
                <User size={12} className="shrink-0 text-gold-dim" />
                <span className="truncate">{p.posted_by ?? 'Unknown viking'}</span>
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
  );
}
