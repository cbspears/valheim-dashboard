import type { ReactNode } from 'react';
import Image from 'next/image';
import { art, isTitleBakedIn, HEADER_ART } from '@/config/art';

/**
 * Full-width home hero.
 *
 * Rendering priority:
 *   1. Hero art (02, title baked in) available → paint the 21:9
 *      doorway/colossus art with NO text overlay (the title is in the art).
 *      On narrow viewports swap to the 16:9 asset (07) so the crop keeps the
 *      subject in frame; if 07 has clean text space (not baked in) the "Eilif"
 *      title is overlaid, otherwise never. The live status strip is preserved
 *      beneath the art exactly as today.
 *   2. Neither hero asset available → render `fallback` (the current
 *      /banner-eilif.webp hero block, status strip included) EXACTLY as today.
 *
 * Passing the current hero JSX as `fallback` keeps the page byte-identical
 * while the manifest is empty.
 */
export function HomeHero({
  fallback,
  statusStrip,
}: {
  /** The existing full hero block (banner image + status strip). */
  fallback: ReactNode;
  /** The live status strip, re-rendered beneath the art when art is present. */
  statusStrip: ReactNode;
}) {
  const hero = art(HEADER_ART.hero); // 02 — 21:9, title baked in
  const heroSmall = art(HEADER_ART.heroSmall); // 07 — 16:9, clean text space

  // No art at all → current hero, untouched.
  if (!hero && !heroSmall) return <>{fallback}</>;

  // Prefer the baked-in 21:9 title card for large screens; fall back to the
  // small asset if only it is present.
  const primary = hero ?? heroSmall!;
  const primaryId = hero ? HEADER_ART.hero : HEADER_ART.heroSmall;
  const small = heroSmall ?? hero!;
  const smallId = heroSmall ? HEADER_ART.heroSmall : HEADER_ART.hero;

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-gold-dim/40 shadow-[0_0_50px_-14px_rgba(200,149,42,0.45)]">
      {/* Small screens: 16:9 crop, tuned to keep the subject framed. */}
      <div className="relative aspect-video w-full sm:hidden">
        <Image
          src={small.src}
          alt={small.alt}
          fill
          priority
          sizes="100vw"
          className="object-cover"
          style={{ objectPosition: 'center 35%' }}
        />
        {!isTitleBakedIn(smallId) && <HeroTitleOverlay />}
      </div>

      {/* Larger screens: 21:9 crop, object-position keeps the doorway +
          colossus in frame when cropped. */}
      <div className="relative hidden w-full sm:block" style={{ aspectRatio: '21 / 9' }}>
        <Image
          src={primary.src}
          alt={primary.alt}
          fill
          priority
          sizes="(max-width: 1152px) 100vw, 1152px"
          className="object-cover"
          style={{ objectPosition: 'center 40%' }}
        />
        {!isTitleBakedIn(primaryId) && <HeroTitleOverlay />}
      </div>

      {/* Live status strip beneath the art — unchanged from the current hero. */}
      {statusStrip}
    </div>
  );
}

/**
 * Fallback title overlay — only used when a hero asset does NOT have the title
 * baked in (i.e. asset 07). Mirrors the existing engraved type treatment.
 */
function HeroTitleOverlay() {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center text-center"
      style={{ background: 'linear-gradient(rgba(6,8,12,0.15), rgba(6,8,12,0.65))' }}
    >
      <h1 className="heading-engraved px-4 text-4xl text-ash sm:text-5xl lg:text-6xl">Eilif</h1>
    </div>
  );
}
