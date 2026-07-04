import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Card, EmptyState, VikingLink } from '@/components/ui';

export interface LeaderboardEntry {
  id: string;
  name: string;
  /** pre-formatted display value */
  value: string;
  /** optional secondary line under the name, e.g. "mostly by sea" */
  subtitle?: string;
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
  emptyTitle = 'No deeds recorded',
  subtitle,
}: {
  title: string;
  icon: ReactNode;
  /** text-* color class for the header icon (e.g. 'text-death') */
  accent?: string;
  entries: LeaderboardEntry[];
  emptyMessage: string;
  /** headline shown above `emptyMessage` when there are no entries */
  emptyTitle?: string;
  /** small in-tone note under the title, always shown (e.g. explaining a data source that isn't live yet) */
  subtitle?: string;
}) {
  return (
    <Card className="flex flex-col">
      <div className="flex flex-col gap-0.5 border-b border-rune px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className={accent}>{icon}</span>
          <h3 className="font-display text-sm uppercase tracking-wide text-ash">{title}</h3>
        </div>
        {subtitle && <p className="pl-[1.65rem] text-xs text-muted">{subtitle}</p>}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={<span className={clsx('opacity-60', accent)}>{icon}</span>}
          title={emptyTitle}
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
                <span className="min-w-0 flex-1">
                  <span
                    className={clsx(
                      'block truncate font-display text-sm',
                      first ? 'font-medium text-gold-light' : 'text-ash'
                    )}
                  >
                    <VikingLink
                      name={entry.name}
                      className="gold-ring rounded-sm transition-colors hover:text-gold-light"
                    />
                  </span>
                  {entry.subtitle && (
                    <span className="block truncate text-xs text-muted">{entry.subtitle}</span>
                  )}
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
