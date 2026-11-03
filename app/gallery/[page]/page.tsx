import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { GalleryPageView } from '@/components/gallery/GalleryPageView';
import { getGalleryPage } from '@/lib/data';
import { galleryPageCount, parseGalleryPage } from '@/lib/gallery';
import { SERVER_NAME, GALLERY_PAGE_SIZE } from '@/config/server';

// PAGES 2 AND ON OF THE GALLERY (2026-11-03). The page number is a path
// segment, not `?page=`, because reading `searchParams` opts a route out of
// ISR entirely (the measurement is written up in app/events/page.tsx). Same
// sixty seconds as page 1, so a new photo pushes every page along within the
// minute.
export const revalidate = 60;

// A page that did not exist at build time (the 217th photo opens page 10)
// still renders on demand and is then cached like the rest, rather than 404ing
// until the next deploy.
export const dynamicParams = true;

/**
 * Pages 2 to the last, counted from the exact row total at build time. Page 1
 * is /gallery and is not listed here. A database that cannot be reached at
 * build yields a total of 0, one page, and an empty list, which is a build
 * that succeeds and pages that render on first request instead.
 */
export async function generateStaticParams() {
  const { total } = await getGalleryPage(1, GALLERY_PAGE_SIZE);
  const pages = galleryPageCount(total, GALLERY_PAGE_SIZE);
  return Array.from({ length: Math.max(0, pages - 1) }, (_, i) => ({ page: String(i + 2) }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ page: string }>;
}): Promise<Metadata> {
  const { page } = await params;
  const n = parseGalleryPage(page);
  return {
    title: n ? `Gallery · Page ${n}` : 'Gallery',
    description: `Screenshots and moments from the ${SERVER_NAME} warband.`,
  };
}

export default async function GalleryNumberedPage({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const { page } = await params;
  const n = parseGalleryPage(page);
  if (n === null) notFound();
  // One page, one address: /gallery/1 is page 1's second name, so it sends the
  // reader (and any crawler) to /gallery for good.
  if (n === 1) permanentRedirect('/gallery');
  return <GalleryPageView page={n} />;
}
