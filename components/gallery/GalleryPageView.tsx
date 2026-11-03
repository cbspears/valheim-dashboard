import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Images, Camera, MessageSquare, ChevronLeft, ChevronRight } from 'lucide-react';
import { SectionHeader, Card, CardBody, Badge, EmptyState } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { PhotoGrid } from '@/components/gallery/PhotoGrid';
import { getGalleryPage, getAllPlayers } from '@/lib/data';
import { galleryPageCount, galleryPageHref } from '@/lib/gallery';
import { resolvePhotoViking } from '@/lib/slug';
import { DISCORD_BOT_HANDLE, GALLERY_PAGE_SIZE } from '@/config/server';

// ONE PAGE OF THE GALLERY (2026-11-03). /gallery and /gallery/[page] both
// render this, so the two route files stay thin and cannot drift apart: the
// header, the grid, the pager and the how-to are the same on every page, and
// only the 24 photos between them change.

const PAGER_LINK =
  'gold-ring inline-flex items-center gap-1 rounded-md border border-rune bg-surface-raised px-3 py-1.5 font-display text-sm text-ash transition-colors hover:border-gold-dim hover:text-gold-light';
const PAGER_DEAD =
  'inline-flex items-center gap-1 rounded-md border border-rune/50 px-3 py-1.5 font-display text-sm text-ash-dim/50';

/**
 * Newer, where we are, Older. The wall is newest first, so Prev and Next
 * would say less than the direction in time does. At either end the missing
 * direction is a plain span rather than a link, so there is nothing to tab
 * to and nothing that leads nowhere. A one-page gallery has no pager at all.
 */
function GalleryPager({ page, pageCount }: { page: number; pageCount: number }) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Gallery pages" className="mt-8 flex items-center justify-between gap-3">
      {page > 1 ? (
        <Link href={galleryPageHref(page - 1)} rel="prev" className={PAGER_LINK}>
          <ChevronLeft size={16} aria-hidden />
          Newer
        </Link>
      ) : (
        <span aria-disabled="true" className={PAGER_DEAD}>
          <ChevronLeft size={16} aria-hidden />
          Newer
        </span>
      )}
      <span className="font-display text-sm text-ash" aria-current="page">
        Page {page} of {pageCount}
      </span>
      {page < pageCount ? (
        <Link href={galleryPageHref(page + 1)} rel="next" className={PAGER_LINK}>
          Older
          <ChevronRight size={16} aria-hidden />
        </Link>
      ) : (
        <span aria-disabled="true" className={PAGER_DEAD}>
          Older
          <ChevronRight size={16} aria-hidden />
        </span>
      )}
    </nav>
  );
}

export async function GalleryPageView({ page }: { page: number }) {
  const [{ photos, total }, roster] = await Promise.all([
    getGalleryPage(page, GALLERY_PAGE_SIZE),
    getAllPlayers(),
  ]);
  const pageCount = galleryPageCount(total, GALLERY_PAGE_SIZE);
  // Page 1 always renders, empty or not, because an empty gallery has its own
  // launch-night state below. Any later page with nothing on it is a page that
  // does not exist (yet), so it is a 404 rather than a blank wall.
  if (page > 1 && (photos.length === 0 || page > pageCount)) notFound();

  // Credits arrive as a Discord display name. Prefer the explicit Discord↔
  // character link (`@Eilif I am ...`) so "Charlie"-posted photos link to
  // Chærlie once claimed; fall back to loose name matching for unlinked posters.
  const photosWithCredit = photos.map((p) => ({
    ...p,
    matchedViking: resolvePhotoViking(p, roster),
  }));

  return (
    <div>
      <PageHeader slot="gallery">
        <SectionHeader
          as="h1"
          title="The Gallery"
          icon={<Images size={22} />}
          action={
            <Badge tone="neutral">
              {total} {total === 1 ? 'photo' : 'photos'}
            </Badge>
          }
        />
      </PageHeader>

      {photosWithCredit.length === 0 ? (
        /* The launch-night gallery. An empty grid that only says it is empty is
           a dead end, so this one names the next step and opens the how-to. */
        <Card>
          <EmptyState
            icon={<Camera size={28} />}
            title="No pictures yet"
            message="Be the first: post a screenshot in Discord and tag Eilif. It lands here with your name and the date."
            action={
              <a
                href="#add-your-own"
                className="gold-ring rounded-md font-display text-sm text-gold-light transition-colors hover:text-gold"
              >
                How to add one
              </a>
            }
          />
        </Card>
      ) : (
        <>
          <PhotoGrid photos={photosWithCredit} />
          <GalleryPager page={page} pageCount={pageCount} />
        </>
      )}

      {/* HOW TO ADD, BELOW THE GRID AND FOLDED SHUT. It used to stand above it,
          which put the first photo below the fold on a phone. The photos are
          what the page is; this is how to join them. Open from the start while
          the wall is empty, because then it is the only thing to read. */}
      <details id="add-your-own" open={photosWithCredit.length === 0} className="mt-8 scroll-mt-20">
        <summary className="gold-ring cursor-pointer rounded-md border border-rune bg-surface-raised px-4 py-3 font-display text-sm text-ash transition-colors hover:border-gold-dim hover:text-gold-light">
          Put your own screenshots here
        </summary>
        <Card className="mt-4 border-l-2 border-l-gold">
          <CardBody>
            {/* No heading here. The <summary> above already says "Put your own
                screenshots here"; an "Add your own" h2 one line below it is two
                headings for one idea, which is the same duplication the plan
                strikes out elsewhere. The disclosure keeps its name. */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                  1
                </span>
                <p className="text-sm leading-relaxed text-ash-dim">
                  <Camera size={14} className="mr-1 inline align-text-bottom text-gold" />
                  Take a screenshot in-game.
                </p>
              </div>
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                  2
                </span>
                <p className="text-sm leading-relaxed text-ash-dim">
                  <MessageSquare size={14} className="mr-1 inline align-text-bottom text-gold" />
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
                  <Images size={14} className="mr-1 inline align-text-bottom text-gold" />
                  It lands here with your name and the date.
                </p>
              </div>
            </div>
          </CardBody>
        </Card>
      </details>
    </div>
  );
}
