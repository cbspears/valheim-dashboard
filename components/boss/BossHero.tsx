import { clsx } from 'clsx';
import { Crown, Moon } from 'lucide-react';
import { Badge } from '@/components/ui';
import { shortDate } from '@/lib/format';
import type { Boss } from '@/lib/types';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** War-room hero header — lit gold when felled, dim and unlit while the altar still waits. */
export function BossHero({
  boss,
  index,
  total,
}: {
  boss: Boss;
  /** 0-based position in the boss order, for the "Forsaken VII of VIII" eyebrow. */
  index?: number;
  total?: number;
}) {
  const killed = boss.is_killed;

  // The eyebrow used to read THE ALTAR AWAITS, which the card below it and the
  // status chip beside it both said again. It now carries the one fact this
  // page never stated: where this boss sits in the chain. The biome is
  // deliberately NOT repeated here — the badge two lines below is already the
  // biome chip, and the card body names it a third time, which is the same
  // say-it-three-times fault this eyebrow was rewritten to fix.
  const place =
    index != null && total != null && index >= 0 && index < total
      ? `Forsaken ${ROMAN[index] ?? index + 1} of ${ROMAN[total - 1] ?? total}`
      : null;

  return (
    <div
      className={clsx(
        'card-surface relative overflow-hidden p-6 sm:p-8',
        killed && 'border-gold-dim/60 shadow-[0_0_40px_-14px_rgba(200,149,42,0.4)]'
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted">
            {place ?? (killed ? 'War room' : 'The altar awaits')}
          </p>
          <h1
            className={clsx(
              'mt-1 font-display text-3xl sm:text-4xl',
              killed ? 'text-ash' : 'text-ash-dim'
            )}
          >
            {boss.name}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone={killed ? 'frost' : 'offline'}>{boss.biome}</Badge>
            {killed && (
              <span className="inline-flex items-center gap-1.5 font-display text-sm text-gold-light">
                <Crown size={14} />
                Felled &middot; {shortDate(boss.killed_at)}
              </span>
            )}
            {!killed && (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted">
                <Moon size={14} />
                Unmet, unfought
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
