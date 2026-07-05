import type { Metadata } from 'next';
import { Images, Camera, MessageSquare, Sparkles } from 'lucide-react';
import { SectionHeader, Card, CardBody, Badge } from '@/components/ui';
import { PhotoGrid } from '@/components/gallery/PhotoGrid';
import { getGalleryPhotos, getAllPlayers } from '@/lib/data';
import { resolvePhotoViking } from '@/lib/slug';
import { SERVER_NAME, DISCORD_BOT_HANDLE } from '@/config/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Gallery',
  description: `Screenshots and moments from the ${SERVER_NAME} warband.`,
};

export default async function GalleryPage() {
  const [photos, roster] = await Promise.all([getGalleryPhotos(), getAllPlayers()]);
  // Credits arrive as a Discord display name. Prefer the explicit Discord↔
  // character link (`@Eilif I am ...`) so "Charlie"-posted photos link to
  // Chærlie once claimed; fall back to loose name matching for unlinked posters.
  const photosWithCredit = photos.map((p) => ({
    ...p,
    matchedViking: resolvePhotoViking(p, roster),
  }));

  return (
    <div>
      <SectionHeader
        title="The Gallery"
        subtitle="Screenshots and sagas from the warband."
        icon={<Images size={22} />}
        action={
          <Badge tone="neutral">
            {photos.length} {photos.length === 1 ? 'photo' : 'photos'}
          </Badge>
        }
      />

      {/* How to add — prominent, gold-accented explainer */}
      <Card className="mb-8 border-l-2 border-l-gold">
        <CardBody>
          <div className="mb-3 flex items-center gap-2">
            <Sparkles size={18} className="text-gold" />
            <h2 className="font-display text-base tracking-wide text-ash">Add your own</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                1
              </span>
              <p className="text-sm leading-relaxed text-ash-dim">
                <Camera size={14} className="mr-1 inline align-text-bottom text-gold-dim" />
                Take a screenshot in-game.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                2
              </span>
              <p className="text-sm leading-relaxed text-ash-dim">
                <MessageSquare size={14} className="mr-1 inline align-text-bottom text-gold-dim" />
                Post it in Discord and tag{' '}
                <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                  {DISCORD_BOT_HANDLE}
                </span>
                . Any text you add becomes the caption.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                3
              </span>
              <p className="text-sm leading-relaxed text-ash-dim">
                <Images size={14} className="mr-1 inline align-text-bottom text-gold-dim" />
                It lands here with your name and the date.
              </p>
            </div>
          </div>
        </CardBody>
      </Card>

      <PhotoGrid photos={photosWithCredit} />
    </div>
  );
}
