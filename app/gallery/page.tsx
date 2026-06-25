import type { Metadata } from 'next';
import { Images } from 'lucide-react';
import { SectionHeader, Badge } from '@/components/ui';
import { PhotoGrid } from '@/components/gallery/PhotoGrid';
import { getGalleryPhotos } from '@/lib/data';
import { SERVER_NAME } from '@/config/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Gallery',
  description: `Screenshots and moments from the ${SERVER_NAME} warband.`,
};

export default async function GalleryPage() {
  const photos = await getGalleryPhotos();

  return (
    <div>
      <SectionHeader
        title="The Gallery"
        subtitle="Screenshots and sagas from the warband. Post a picture in Discord and tag the bot to add yours."
        icon={<Images size={22} />}
        action={
          <Badge tone="neutral">
            {photos.length} {photos.length === 1 ? 'photo' : 'photos'}
          </Badge>
        }
      />
      <div className="mt-2">
        <PhotoGrid photos={photos} />
      </div>
    </div>
  );
}
