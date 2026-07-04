import { Skull } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, VikingLink } from '@/components/ui';
import type { GameEvent } from '@/lib/types';

/**
 * Sentinel key for deaths with no recorded cause. Most of these are historical,
 * log-derived deaths captured before the death-cause mod rolled out — the
 * cause isn't a mysterious category, it's genuinely lost to time. Kept
 * distinct from real causes so it never gets confused with one.
 */
const UNRECORDED = '__unrecorded__';

/** Raw death cause → saga-flavored label. Causes we haven't mapped yet also fall to UNRECORDED. */
const CAUSE_LABELS: Record<string, string> = {
  Tree: 'Betrayed by a tree',
  Fall: 'Gravity',
  Drowning: 'The sea',
  Fire: 'Their own campfire',
  Neck: 'A neck. A literal neck.',
  Greyling: 'Greylings',
  Greydwarf: 'Greydwarfs',
  GreydwarfBrute: 'Greydwarf brutes',
  GreydwarfShaman: 'Greydwarf shamans',
  Boar: 'A boar. Somehow.',
  Deer: 'A deer. Genuinely.',
  Troll: 'Trolls',
  Skeleton: 'Skeletons',
  Draugr: 'Draugr',
  Wraith: 'Wraiths',
  Abomination: 'Abominations',
  Leech: 'Leeches',
  Tick: 'Ticks',
  Bat: 'Cave bats',
  Surtling: 'Surtlings',
  Eikthyr: 'Eikthyr',
  'The Elder': 'The Elder',
  Bonemass: 'Bonemass',
  Moder: 'Moder',
  Yagluth: 'Yagluth',
  Serpent: 'The Serpent',
};

/** One-line saga observation keyed off the deadliest cause. */
const CAUSE_OBSERVATION: Record<string, string> = {
  Tree: 'More vikings fall to their own axes than to any beast.',
  Fall: 'The cliffs of Eilif have taken more warriors than any warband.',
  Drowning: 'The cold sea keeps its dead, and it is never satisfied.',
  Fire: 'A warrior who cannot master the hearth will not master the North.',
  Neck: 'Even the shallows of the Meadows are not as safe as they look.',
  Greyling: 'The little ones swarm, and the swarm adds up.',
  Greydwarf: 'The forest claims more vikings than any boss.',
  GreydwarfBrute: 'The forest sends its biggest sons when the little ones fail.',
  GreydwarfShaman: 'The shamans hit from range — and vikings keep forgetting that.',
  Boar: 'The mightiest raiders, felled by the humblest of beasts.',
  Deer: 'The mightiest raiders, felled by the humblest of beasts.',
  Troll: 'The trolls of the Black Forest exact a heavy toll.',
  Skeleton: 'The old bones of the crypts still hunger for company.',
  Draugr: 'The restless dead of the swamps drag the living down with them.',
  Wraith: 'The dead of the swamp do not stay buried.',
  Abomination: 'The swamp grows its own monsters, given enough time.',
  Leech: 'It is not the monsters of the swamp that kill — it is the water.',
  Tick: 'Small, patient, and everywhere in the plains.',
  Bat: 'The dark places of the caves are never quite empty.',
  Surtling: 'Fire finds every viking who gets careless near the forge.',
  Eikthyr: 'Even the first of the forsaken has claimed a warrior or two.',
  'The Elder': 'Even the Elder has tasted viking blood, and asks for more.',
  Bonemass: 'The swamp’s guardian is patient, and heavy-handed.',
  Moder: 'The mountain queen does not forgive a missed dodge.',
  Yagluth: 'The plains’ lord takes his due from the reckless.',
  Serpent: 'The Serpent rules the storm-waters, and the drowned know it well.',
};

function labelFor(cause: string): string {
  return CAUSE_LABELS[cause] ?? 'Unwitnessed';
}

export function HowWeDie({ deaths }: { deaths: GameEvent[] }) {
  // Tally raw causes. Anything without a recorded cause — or with a cause
  // string we haven't mapped to a label — collapses into the UNRECORDED
  // bucket, since we can't tell those apart from "genuinely unknown."
  const counts = new Map<string, number>();
  const byViking = new Map<string, number>();
  for (const e of deaths) {
    const raw = typeof e.metadata?.cause === 'string' ? (e.metadata.cause as string) : '';
    const cause = raw && CAUSE_LABELS[raw] ? raw : UNRECORDED;
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
    if (e.character_name) {
      byViking.set(e.character_name, (byViking.get(e.character_name) ?? 0) + 1);
    }
  }

  // Real (recorded) causes lead the story, ranked by count. The unrecorded
  // bucket is always last, however large — it isn't a cause, it's an absence
  // of data, and shouldn't visually compete with real ones.
  const realRows = [...counts.entries()]
    .filter(([cause]) => cause !== UNRECORDED)
    .map(([cause, count]) => ({ cause, label: labelFor(cause), count, unrecorded: false as const }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const unrecordedCount = counts.get(UNRECORDED) ?? 0;
  const unrecordedRow =
    unrecordedCount > 0
      ? { cause: UNRECORDED, label: 'Unwitnessed', count: unrecordedCount, unrecorded: true as const }
      : null;

  const rows = unrecordedRow ? [...realRows, unrecordedRow] : realRows;

  const total = deaths.length;
  const top = realRows[0];
  const max = top?.count ?? 1;
  const observation = top
    ? CAUSE_OBSERVATION[top.cause] ?? 'The North collects its due, one viking at a time.'
    : 'No cause has yet been witnessed and recorded — the reaper keeps his ledger closed.';

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
              // The unrecorded bucket is scaled against itself, not the real
              // causes' max — otherwise its (often large) historical count
              // would dwarf every real cause's bar and bury the story.
              const pct = r.unrecorded ? 100 : Math.round((r.count / max) * 100);
              return (
                <li
                  key={r.cause}
                  className={clsx('flex items-center gap-3', r.unrecorded && 'opacity-60')}
                  title={r.unrecorded ? 'Before the ravens kept watch — no cause was recorded.' : undefined}
                >
                  <span
                    className={clsx(
                      'w-40 shrink-0 truncate font-display text-sm',
                      r.unrecorded ? 'italic text-muted' : 'text-ash'
                    )}
                  >
                    {r.label}
                  </span>
                  <div className="relative h-5 flex-1 overflow-hidden rounded-sm bg-surface-raised/50">
                    <div
                      className={clsx(
                        'h-full rounded-sm',
                        r.unrecorded
                          ? 'border border-dashed border-rune bg-surface-raised/80'
                          : top && r.cause === top.cause
                            ? 'bg-death/70'
                            : 'bg-death/40'
                      )}
                      style={{ width: `${Math.max(pct, 4)}%` }}
                    />
                  </div>
                  <span
                    className={clsx(
                      'w-8 shrink-0 text-right text-sm tabular-nums',
                      r.unrecorded ? 'text-muted' : 'text-ash-dim'
                    )}
                  >
                    {r.count}
                  </span>
                </li>
              );
            })}
          </ul>

          {unrecordedRow && (
            <p className="text-xs italic text-muted">
              {unrecordedRow.count} unwitnessed — before the ravens kept watch, these falls went
              unrecorded. The count is true; the cause is lost to time.
            </p>
          )}

          {deadliest && (
            <p className="border-t border-rune/60 pt-3 text-xs text-muted">
              <VikingLink
                name={deadliest.name}
                className="gold-ring rounded-sm font-display text-ash-dim transition-colors hover:text-gold-light"
              />{' '}
              has died {deadliest.count} times — more than any other viking. Valhalla knows the
              way.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
