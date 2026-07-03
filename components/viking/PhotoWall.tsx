import { Camera } from 'lucide-react';
import { Card, EmptyState } from '@/components/ui';
import type { GalleryPhoto } from '@/lib/types';

export function PhotoWall({ photos, first }: { photos: GalleryPhoto[]; first: string }) {
  if (photos.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Camera size={26} />}
          title="No sagas in silver"
          message={`${first} has shared no images to the hall — yet.`}
        />
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {photos.map((photo) => (
        <figure
          key={photo.id}
          className="card-surface group relative aspect-square overflow-hidden p-0"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.url}
            alt={photo.caption ?? `A scene shared by ${first}`}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
          {photo.caption && (
            <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-pitch/95 via-pitch/60 to-transparent px-3 pb-2 pt-6 text-xs text-ash opacity-0 transition-opacity group-hover:opacity-100">
              {photo.caption}
            </figcaption>
          )}
        </figure>
      ))}
    </div>
  );
}
