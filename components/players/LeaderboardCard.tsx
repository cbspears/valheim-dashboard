import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Card, EmptyState } from '@/components/ui';

export interface LeaderboardEntry {
  id: string;
  name: string;
  /** pre-formatted display value */
  value: string;
}

/**
 * A single ranked board (top N). Presentational only — the page computes
 * the ranked entries and passes them in. Rank 1 is highlighted subtly in gold.
 */
export function LeaderboardCard({
  title,
  icon,
  accent = 'text-gold',
  entries,
  emptyMessage,
}: {
  title: string;
  icon: ReactNode;
  /** text-* color class for the header icon (e.g. 'text-death') */
  accent?: string;
  entries: LeaderboardEntry[];
  emptyMessage: string;
}) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
        <span className={accent}>{icon}</span>
        <h3 className="font-display text-sm uppercase tracking-wide text-ash">{title}</h3>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={<span className={clsx('opacity-60', accent)}>{icon}</span>}
          title="No deeds recorded"
          message={emptyMessage}
        />
      ) : (
        <ol className="flex-1">
          {entries.map((entry, i) => {
            const rank = i + 1;
            const first = rank === 1;
            return (
              <li
                key={entry.id}
                className={clsx(
                  'flex items-center gap-3 px-5 py-2.5',
                  i > 0 && 'border-t border-rune/60',
                  first && 'bg-gold/[0.05]'
                )}
              >
                <span
                  className={clsx(
                    'w-5 shrink-0 text-center font-display text-sm tabular-nums',
                    first ? 'text-gold-light' : 'text-gold-dim'
                  )}
                >
                  {rank}
                </span>
                <span
                  className={clsx(
                    'flex-1 truncate font-display text-sm',
                    first ? 'font-medium text-gold-light' : 'text-ash'
                  )}
                >
                  {entry.name}
                </span>
                <span
                  className={clsx(
                    'shrink-0 text-sm tabular-nums',
                    first ? 'text-gold' : 'text-ash-dim'
                  )}
                >
                  {entry.value}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
