import type { ReactNode } from 'react';
import Image from 'next/image';
import { clsx } from 'clsx';
import { headerArt, type HeaderSlot } from '@/config/art';

/**
 * Art-backed page-header band.
 *
 * Wraps a page's existing <SectionHeader> (passed as `children`). When the
 * art for `slot` is available it paints the image behind the header inside a
 * fixed-height band with a dark gradient scrim so the engraved heading text
 * stays readable on top. When the art is NOT available (the manifest is empty,
 * or this slot's image hasn't landed), it renders `children` verbatim — no
 * band, no wrapper, no visual change whatsoever.
 *
 * `prominent` = taller band (used on the Oath page).
 */
export function PageHeader({
  slot,
  children,
  prominent = false,
  objectPosition = 'center',
}: {
  slot: HeaderSlot;
  children: ReactNode;
  prominent?: boolean;
  /** CSS object-position for the cropped art, e.g. "center 30%". */
  objectPosition?: string;
}) {
  const ref = headerArt(slot);

  // Graceful no-op: no art → the page renders exactly as it does today.
  if (!ref) return <>{children}</>;

  return (
    <div
      className={clsx(
        'relative mb-8 overflow-hidden rounded-[var(--radius-card)] border border-rune',
        prominent
          ? 'min-h-[240px] sm:min-h-[300px] lg:min-h-[340px]'
          : 'min-h-[160px] sm:min-h-[220px] lg:min-h-[260px]',
      )}
    >
      <Image
        src={ref.src}
        alt={ref.alt}
        fill
        sizes="(max-width: 1152px) 100vw, 1152px"
        className="object-cover"
        style={{ objectPosition }}
      />
      {/* Dark gradient scrim so SectionHeader text stays readable on the art. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(rgba(10,15,25,0.55), rgba(10,15,25,0.78))',
        }}
      />
      {/* The existing SectionHeader, unchanged, floated on top of the art.
          Its trailing rune-divider is hidden here since the band's own edge
          already frames it. */}
      <div className="absolute inset-0 flex flex-col justify-end px-5 py-5 sm:px-7 sm:py-6 [&_hr.rune-divider]:hidden [&_.mb-5]:mb-0">
        {children}
      </div>
    </div>
  );
}
