import { Skull } from 'lucide-react';
import { clsx } from 'clsx';
import { Card } from '@/components/ui';
import type { GameEvent } from '@/lib/types';

/** Raw death cause → saga-flavored label. Unknown causes fall to "The mists". */
const CAUSE_LABELS: Record<string, string> = {
  Tree: 'Betrayed by a tree',
  Fall: 'Gravity',
  Drowning: 'The sea',
  Fire: 'Their own campfire',
  Greydwarf: 'Greydwarfs',
  Troll: 'Trolls',
  Skeleton: 'Skeletons',
  Draugr: 'Draugr',
  Leech: 'Leeches',
  'The Elder': 'The Elder',
  Serpent: 'The Serpent',
  Boar: 'A boar. Somehow.',
};

/** One-line saga observation keyed off the deadliest cause. */
const CAUSE_OBSERVATION: Record<string, string> = {
  Tree: 'More vikings fall to their own axes than to any beast.',
  Fall: 'The cliffs of Eilif have taken more warriors than any warband.',
  Drowning: 'The cold sea keeps its dead, and it is never satisfied.',
  Fire: 'A warrior who cannot master the hearth will not master the North.',
  Greydwarf: 'The forest claims more vikings than any boss.',
  Troll: 'The trolls of the Black Forest exact a heavy toll.',
  Skeleton: 'The old bones of the crypts still hunger for company.',
  Draugr: 'The restless dead of the swamps drag the living down with them.',
  Leech: 'It is not the monsters of the swamp that kill — it is the water.',
  'The Elder': 'Even the Elder has tasted viking blood, and asks for more.',
  Serpent: 'The Serpent rules the storm-waters, and the drowned know it well.',
  Boar: 'The mightiest raiders, felled by the humblest of beasts.',
};

function labelFor(cause: string): string {
  return CAUSE_LABELS[cause] ?? 'The mists';
}

export function HowWeDie({ deaths }: { deaths: GameEvent[] }) {
  // Tally raw causes.
  const counts = new Map<string, number>();
  const byViking = new Map<string, number>();
  for (const e of deaths) {
    const cause = typeof e.metadata?.cause === 'string' ? (e.metadata.cause as string) : 'Unknown';
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
    if (e.character_name) {
      byViking.set(e.character_name, (byViking.get(e.character_name) ?? 0) + 1);
    }
  }

  const rows = [...counts.entries()]
    .map(([cause, count]) => ({ cause, label: labelFor(cause), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const total = deaths.length;
  const top = rows[0];
  const max = top?.count ?? 1;
  const observation = top ? CAUSE_OBSERVATION[top.cause] ?? 'The North collects its due, one viking at a time.' : '';

  // Deadliest viking — only called out if one name clearly dominates.
  const tally = [...byViking.entries()].sort((a, b) => b[1] - a[1]);
  const deadliest =
    tally.length > 0 && tally[0][1] >= 3 && (tally.length === 1 || tally[0][1] > tally[1][1])
      ? { name: tally[0][0], count: tally[0][1] }
      : null;

  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
        <span className="text-death">
          <Skull size={16} />
        </span>
        <h3 className="font-display text-sm uppercase tracking-wide text-ash">How We Die</h3>
      </div>

      {total === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted">
          Not a single viking has fallen. The Norns are patient — this will not last.
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-5">
          <p className="text-sm text-ash-dim">
            <span className="font-display text-gold-light">{total}</span> deaths recorded across the
            realms. {observation}
          </p>

          <ul className="flex flex-col gap-2">
            {rows.map((r) => {
              const pct = Math.round((r.count / max) * 100);
              return (
                <li key={r.cause} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate font-display text-sm text-ash">
                    {r.label}
                  </span>
                  <div className="relative h-5 flex-1 overflow-hidden rounded-sm bg-surface-raised/50">
                    <div
                      className={clsx(
                        'h-full rounded-sm',
                        r.cause === top.cause ? 'bg-death/70' : 'bg-death/40'
                      )}
                      style={{ width: `${Math.max(pct, 4)}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-sm tabular-nums text-ash-dim">
                    {r.count}
                  </span>
                </li>
              );
            })}
          </ul>

          {deadliest && (
            <p className="border-t border-rune/60 pt-3 text-xs text-muted">
              <span className="font-display text-ash-dim">{deadliest.name}</span> has died{' '}
              {deadliest.count} times — more than any other viking. Valhalla knows the way.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
