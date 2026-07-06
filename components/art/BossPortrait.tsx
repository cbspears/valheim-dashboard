import Image from 'next/image';
import { clsx } from 'clsx';
import { Check, HelpCircle } from 'lucide-react';
import { bossPortraitArt } from '@/config/art';

export type BossPortraitStatus = 'defeated' | 'next' | 'locked';

/**
 * 2:3 boss portrait card in a rune-border frame with an inner shadow.
 *
 * States:
 *   - defeated : full colour + a subtle gold ✓ badge
 *   - next     : gold highlight ring (the current objective)
 *   - locked   : desaturated + darkened via CSS filter
 *   - mystery  : when the boss has NO portrait art (the Deep North 8th boss,
 *                or any portrait id not yet in ART_AVAILABLE) — a frosted
 *                placeholder with a big "???". Chosen automatically whenever
 *                `bossPortraitArt(name)` returns null, so the whole feature is
 *                a no-op while the manifest is empty.
 *
 * Sizes are driven by the container; pass a width via `className`
 * (e.g. "w-28") — the 2:3 aspect is enforced internally.
 */
export function BossPortrait({
  name,
  status,
  className,
  /** Hide the little status badge (e.g. when the parent shows its own). */
  hideBadge = false,
}: {
  name: string;
  status: BossPortraitStatus;
  className?: string;
  hideBadge?: boolean;
}) {
  const ref = bossPortraitArt(name);
  const mystery = ref === null;

  return (
    <div
      className={clsx(
        // rune-border frame + inner shadow, reused from the design system
        'relative aspect-[2/3] overflow-hidden rounded-[var(--radius-card)] border',
        'shadow-[inset_0_0_24px_-6px_rgba(0,0,0,0.85)]',
        status === 'next'
          ? 'border-gold ring-2 ring-gold/50 shadow-[0_0_26px_-6px_rgba(200,149,42,0.6),inset_0_0_24px_-6px_rgba(0,0,0,0.85)]'
          : 'border-rune',
        className,
      )}
    >
      {mystery ? (
        // ── Mystery placeholder — frosted, no art ──────────────────────────
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-raised/70 backdrop-blur-sm">
          <span
            aria-hidden
            className="font-display text-4xl tracking-widest text-muted"
          >
            ???
          </span>
          <span className="sr-only">{name} — portrait unknown</span>
          <HelpCircle size={18} className="text-muted/70" aria-hidden />
        </div>
      ) : (
        <>
          <Image
            src={ref.src}
            alt={ref.alt}
            fill
            loading="lazy"
            sizes="(max-width: 640px) 40vw, 200px"
            className={clsx(
              'object-cover transition-[filter]',
              status === 'locked' && 'grayscale brightness-[0.55]',
            )}
          />
          {/* Bottom vignette so any parent caption stays legible on the art. */}
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-1/3"
            style={{ background: 'linear-gradient(rgba(6,8,12,0), rgba(6,8,12,0.7))' }}
          />
          {/* Defeated badge — subtle gold check. */}
          {!hideBadge && status === 'defeated' && (
            <span
              className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border border-gold-dim/70 bg-pitch/70 text-gold-light backdrop-blur-sm"
              title="Felled"
            >
              <Check size={13} />
            </span>
          )}
        </>
      )}
    </div>
  );
}
