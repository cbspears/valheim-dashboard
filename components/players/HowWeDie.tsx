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

// Raw death cause → saga-flavored label. Keyed lowercase (matches lib/episodes.ts'
// convention of lowercasing the cause before lookup): creature/boss causes arrive
// Title Case from gs-ingest's humanizeKiller() ("Greyling", "Neck"), while
// environmental causes arrive as bare, lowercase Valheim HitType words ("fall",
// "tree", "drowning" — see lib/episodes.ts ENV_DEATHS/ENV_DESC for the full
// vocabulary). Lowercasing both sides at lookup time means either casing lands
// on the same row instead of silently splitting into two.
const CAUSE_LABELS: Record<string, string> = {
  // --- Creatures / bosses ---
  neck: 'A neck. A literal neck.',
  greyling: 'Greylings',
  greydwarf: 'Greydwarfs',
  greydwarfbrute: 'Greydwarf brutes',
  greydwarfshaman: 'Greydwarf shamans',
  boar: 'A boar. Somehow.',
  deer: 'A deer. Genuinely.',
  troll: 'Trolls',
  skeleton: 'Skeletons',
  draugr: 'Draugr',
  wraith: 'Wraiths',
  abomination: 'Abominations',
  leech: 'Leeches',
  tick: 'Ticks',
  bat: 'Cave bats',
  surtling: 'Surtlings',
  eikthyr: 'Eikthyr',
  'the elder': 'The Elder',
  bonemass: 'Bonemass',
  moder: 'Moder',
  yagluth: 'Yagluth',
  serpent: 'The Serpent',
  // --- Environmental (HitType) causes — mirrors lib/episodes.ts ENV_DEATHS/ENV_DESC ---
  tree: 'Betrayed by a tree',
  fall: 'Gravity',
  falling: 'Gravity',
  drowning: 'The sea',
  drowned: 'The sea',
  drown: 'The sea',
  water: 'The sea',
  fire: 'Their own campfire',
  burning: 'Their own campfire',
  smoke: 'Their own hearth-smoke',
  freezing: 'The cold itself',
  cold: 'The cold itself',
  poison: "The swamp's poison",
  poisoned: "The swamp's poison",
  stalagmite: 'Skewered from above',
  stalagtite: 'Skewered from above',
  impact: 'A merciless landing',
  cartcollision: 'Run down by their own cart',
  structural: 'Falling timber',
  turret: 'Friendly ballista fire',
  boat: 'Went down with the ship',
  self: 'Their own hand',
  edgeofworld: 'The edge of the world',
  ashlandsocean: 'The boiling seas of Ashlands',
  ashlandsoceanfloor: 'The boiling seas of Ashlands',
  lava: 'Molten rock',
};

/** One-line saga observation keyed off the deadliest cause (lowercase, same convention as CAUSE_LABELS). */
const CAUSE_OBSERVATION: Record<string, string> = {
  neck: 'Even the shallows of the Meadows are not as safe as they look.',
  greyling: 'The little ones swarm, and the swarm adds up.',
  greydwarf: 'The forest claims more vikings than any boss.',
  greydwarfbrute: 'The forest sends its biggest sons when the little ones fail.',
  greydwarfshaman: 'The shamans hit from range — and vikings keep forgetting that.',
  boar: 'The mightiest raiders, felled by the humblest of beasts.',
  deer: 'The mightiest raiders, felled by the humblest of beasts.',
  troll: 'The trolls of the Black Forest exact a heavy toll.',
  skeleton: 'The old bones of the crypts still hunger for company.',
  draugr: 'The restless dead of the swamps drag the living down with them.',
  wraith: 'The dead of the swamp do not stay buried.',
  abomination: 'The swamp grows its own monsters, given enough time.',
  leech: 'It is not the monsters of the swamp that kill — it is the water.',
  tick: 'Small, patient, and everywhere in the plains.',
  bat: 'The dark places of the caves are never quite empty.',
  surtling: 'Fire finds every viking who gets careless near the forge.',
  eikthyr: 'Even the first of the forsaken has claimed a warrior or two.',
  'the elder': 'Even the Elder has tasted viking blood, and asks for more.',
  bonemass: 'The swamp’s guardian is patient, and heavy-handed.',
  moder: 'The mountain queen does not forgive a missed dodge.',
  yagluth: 'The plains’ lord takes his due from the reckless.',
  serpent: 'The Serpent rules the storm-waters, and the drowned know it well.',
  tree: 'More vikings fall to their own axes than to any beast.',
  fall: 'The cliffs of Eilif have taken more warriors than any warband.',
  falling: 'The cliffs of Eilif have taken more warriors than any warband.',
  drowning: 'The cold sea keeps its dead, and it is never satisfied.',
  drowned: 'The cold sea keeps its dead, and it is never satisfied.',
  drown: 'The cold sea keeps its dead, and it is never satisfied.',
  water: 'The cold sea keeps its dead, and it is never satisfied.',
  fire: 'A warrior who cannot master the hearth will not master the North.',
  burning: 'A warrior who cannot master the hearth will not master the North.',
  smoke: 'Even a warm hall can turn on a careless viking.',
  freezing: 'The North does not warm for anyone, warrior or not.',
  cold: 'The North does not warm for anyone, warrior or not.',
  poison: 'The swamp keeps a slower, patient kind of death.',
  poisoned: 'The swamp keeps a slower, patient kind of death.',
  stalagmite: 'The caves strike from above as often as from the dark.',
  stalagtite: 'The caves strike from above as often as from the dark.',
  impact: 'Not every death in Eilif comes with a killer worth naming.',
  cartcollision: 'A viking’s own cart is no less dangerous than a troll.',
  structural: 'Even a hall raised by viking hands can turn against them.',
  turret: 'A ballista does not know friend from foe.',
  boat: 'The sea takes ship and sailor together, when it wants to.',
  self: 'Some deaths carry no one’s name but the fallen’s own.',
  edgeofworld: 'The world of Eilif has an edge, and someone always finds it.',
  ashlandsocean: 'The Ashlands do not cool for anyone.',
  ashlandsoceanfloor: 'The Ashlands do not cool for anyone.',
  lava: 'The fire below is patient, and always waiting.',
};

/** Title-case fallback label for a cause string we haven't mapped yet — used
 * so a real, present cause always gets its own honest row instead of
 * silently vanishing into "Unwitnessed" (that bucket is reserved for a truly
 * empty/absent cause — see the tally loop below). */
function capitalize(raw: string): string {
  return raw.length ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
}

function labelFor(causeKey: string, rawExample: string): string {
  return CAUSE_LABELS[causeKey] ?? capitalize(rawExample);
}

export function HowWeDie({ deaths }: { deaths: GameEvent[] }) {
  // Tally causes, keyed lowercase so "Fall" and "fall" land on the same row.
  // ONLY a truly empty/absent cause collapses into UNRECORDED — that bucket
  // means "no cause was recorded," not "a cause we don't recognize yet." A
  // present-but-unmapped cause string still gets its own honest row (see
  // labelFor's capitalize() fallback) so future mod vocabulary is visible
  // instead of silently vanishing into the unknown bucket.
  const counts = new Map<string, number>();
  const rawExampleByCause = new Map<string, string>();
  const byViking = new Map<string, number>();
  for (const e of deaths) {
    const raw = typeof e.metadata?.cause === 'string' ? (e.metadata.cause as string).trim() : '';
    const cause = raw ? raw.toLowerCase() : UNRECORDED;
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
    if (raw && !rawExampleByCause.has(cause)) rawExampleByCause.set(cause, raw);
    if (e.character_name) {
      byViking.set(e.character_name, (byViking.get(e.character_name) ?? 0) + 1);
    }
  }

  // Real (recorded) causes lead the story, ranked by count. The unrecorded
  // bucket is always last, however large — it isn't a cause, it's an absence
  // of data, and shouldn't visually compete with real ones.
  const realRows = [...counts.entries()]
    .filter(([cause]) => cause !== UNRECORDED)
    .map(([cause, count]) => ({
      cause,
      label: labelFor(cause, rawExampleByCause.get(cause) ?? cause),
      count,
      unrecorded: false as const,
    }))
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
