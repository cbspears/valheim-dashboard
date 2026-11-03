import type { Metadata } from 'next';
import { GalleryPageView } from '@/components/gallery/GalleryPageView';
import { SERVER_NAME } from '@/config/server';

// SIXTY SECONDS OF ISR (2026-09-06). Photos arrive through the Discord bot,
// minutes apart at best, so a per-request read bought nothing. A screenshot
// posted now appears here within the minute.
//
// PAGE 1 OF THE GALLERY (2026-11-03). The newest 24; the older ones are at
// /gallery/2 and on (app/gallery/[page]/page.tsx). The body lives in
// components/gallery/GalleryPageView.tsx so both routes render the same page.
export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Gallery',
  description: `Screenshots and moments from the ${SERVER_NAME} warband.`,
};

export default function GalleryPage() {
  return <GalleryPageView page={1} />;
}
