import { Crown } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, EmptyState, VikingLink } from '@/components/ui';
import { LeaderboardCard } from '@/components/players/LeaderboardCard';
import type { PotyHistoryEntry } from '@/lib/types';

/** Short Central-time date label, e.g. "Jun 18". */
function crownDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
}

/**
 * The Player-of-the-Day archive: a chronological "crowning log" alongside a
 * "most crowned" tally. Presentational — the page passes the rows (newest
 * first); the tally is derived here across the full set handed in.
 */
export function PotyArchive({ entries }: { entries: PotyHistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Crown size={28} />}
          title="No champions crowned yet"
          message="Once the nightly saga recaps begin, each day's Player of the Day will be enshrined here."
        />
      </Card>
    );
  }

  // Most-crowned tally across every archived day.
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.character_name, (counts.get(e.character_name) ?? 0) + 1);
  }
  const tally = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, count]) => ({ id: name, name, value: `${count}×` }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* The crowning log (newest first) */}
      <Card className="flex flex-col lg:col-span-2">
        <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
          <span className="text-gold">
            <Crown size={16} />
          </span>
          <h3 className="font-display text-sm uppercase tracking-wide text-ash">
            The Crowning Log
          </h3>
        </div>
        <ol className="flex-1">
          {entries.slice(0, 12).map((e, i) => (
            <li
              key={e.id}
              className={clsx(
                'flex items-center gap-3 px-5 py-2.5',
                i > 0 && 'border-t border-rune/60'
              )}
            >
              <span className="w-12 shrink-0 font-display text-xs tabular-nums text-gold-dim">
                {crownDate(e.awarded_at)}
              </span>
              <span className="flex-1 truncate font-display text-sm text-ash">
                <VikingLink
                  name={e.character_name}
                  className="gold-ring rounded-sm transition-colors hover:text-gold-light"
                />
              </span>
              <span className="shrink-0 truncate text-xs text-ash-dim">
                {e.award_label}
              </span>
            </li>
          ))}
        </ol>
      </Card>

      {/* Most crowned — who's worn the crown the most */}
      <LeaderboardCard
        title="Most Crowned"
        icon={<Crown size={16} />}
        accent="text-gold"
        entries={tally}
        emptyMessage="No champions yet."
      />
    </div>
  );
}
