import { clsx } from 'clsx';
import { Crown, Moon } from 'lucide-react';
import { Badge } from '@/components/ui';
import { shortDate } from '@/lib/format';
import type { Boss } from '@/lib/types';

/** War-room hero header — lit gold when felled, dim and unlit while the altar still waits. */
export function BossHero({ boss }: { boss: Boss }) {
  const killed = boss.is_killed;

  return (
    <div
      className={clsx(
        'card-surface relative overflow-hidden p-6 sm:p-8',
        killed && 'border-gold-dim/60 shadow-[0_0_40px_-14px_rgba(200,149,42,0.4)]'
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted">
            {killed ? 'The War-Room' : 'The Altar Awaits'}
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
