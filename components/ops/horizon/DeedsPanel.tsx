// What the hall is about to earn: the Great Deeds nearest their thresholds, and
// the next Forsaken still standing.
//
// Both are read through the same functions the site and the evaluator use
// (lib/milestones summarizeMilestones, lib/data getMilestoneAggregates), so a
// bar here and a bar on the Hall page can never disagree about how close a deed
// is. That matters more than it sounds: a deed crossing fires a Discord embed
// and an in-game voice line together, and an ops page that says 95 percent while
// the evaluator is about to fire at 100 is an ops page nobody checks twice.

import { Trophy, Swords } from 'lucide-react';
import { formatDurationSec } from '@/lib/ops/window';
import type { DeedProgress, NextBoss } from '@/lib/ops/horizon';
import { HORIZON_GLOSSARY } from '@/lib/ops/glossary-horizon';
import { HorizonCard, Chip, Nothing, NotReported, ProgressBar, Row } from './Panel';

export function DeedsClose({
  deeds,
  count,
  publicReadOk,
  rosterKnown,
}: {
  deeds: DeedProgress[];
  count: number;
  /** False when the public read path returned nothing at all. See data.ts. */
  publicReadOk: boolean;
  /** False when no viking rows came back, so every aggregate below is zero by construction. */
  rosterKnown: boolean;
}) {
  return (
    <HorizonCard
      title="Great Deeds nearest their thresholds"
      entry={HORIZON_GLOSSARY['deeds-close']}
      icon={<Trophy size={15} />}
      aside={publicReadOk ? `${count} unearned` : 'not readable'}
    >
      {deeds.length === 0 && !publicReadOk ? (
        <NotReported
          what="The milestones table returned no rows, and so did the other seeded tables."
          why="That is a broken read path rather than a hall with nothing left to earn, so no progress is shown."
        />
      ) : deeds.length === 0 ? (
        <Nothing>
          Every Great Deed defined has been earned, or the milestones table has not been seeded.
        </Nothing>
      ) : (
        <>
          {!rosterKnown && (
            <p className="mb-3 text-xs text-raid">
              No viking rows came back, so every figure below is zero by construction rather than by
              measurement. Right after the launch wipe that is correct. At any other time it means
              the players or player_stats read failed.
            </p>
          )}
          {/* THE DEED NAME LEADS, NOT THE METRIC (fixed 2026-09-06). Three of
              the eight deeds nearest their thresholds are on deaths_total today,
              so leading with the metric label printed "Deaths / Deaths / Deaths"
              down the card and read like a duplicate-render bug. The deed is the
              identity; the metric is its unit. */}
          <ol className="space-y-3.5">
            {deeds.map((d) => (
              <li key={d.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="min-w-0 text-sm text-ash">{d.title}</span>
                  <span className="shrink-0 text-sm tabular-nums text-gold">{d.pct}%</span>
                </div>
                <div className="mt-1.5">
                  <ProgressBar
                    fraction={d.pct / 100}
                    label={`${d.title}, measured in ${d.metricLabel}`}
                    valueText={`${d.valueLabel} of ${d.thresholdLabel}, ${d.pct} percent`}
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  <span className="text-ash-dim">needs {d.remainingLabel} more</span>
                  {' to reach '}
                  {d.thresholdLabel}
                  {'. Now at '}
                  {d.valueLabel}
                  {'. Counts '}
                  <span className="text-ash-dim">{d.metricLabel.toLowerCase()}</span>
                  {d.metricDescription ? `: ${d.metricDescription}.` : '.'}
                </p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted">
            The aggregate behind these bars is cached for 60 s, so a percentage can read one minute
            behind the evaluator that will actually fire the deed.
          </p>
        </>
      )}
    </HorizonCard>
  );
}

export function NextBossCard({ boss, publicReadOk }: { boss: NextBoss; publicReadOk: boolean }) {
  return (
    <HorizonCard
      title="Next Forsaken"
      entry={HORIZON_GLOSSARY['next-boss']}
      icon={<Swords size={15} />}
      aside={boss.total === 0 && !publicReadOk ? 'not readable' : `${boss.felled} of ${boss.total} felled`}
    >
      {boss.total === 0 && !publicReadOk ? (
        <NotReported
          what="The bosses table returned no rows, and so did the other seeded tables."
          why="The bosses table is seeded and the launch wipe resets it rather than emptying it, so no rows means the read failed."
        />
      ) : boss.total === 0 ? (
        <Nothing>The bosses table is empty.</Nothing>
      ) : boss.next === null ? (
        <Nothing>All {boss.total} Forsaken are down. There is nothing left on the ladder.</Nothing>
      ) : (
        <div className="space-y-0">
          <Row
            label="Standing next"
            value={
              <span>
                {boss.next.name}
                {boss.next.biome && <span className="ml-2 text-xs text-muted">{boss.next.biome}</span>}
              </span>
            }
            tone="gold"
            hint="The lowest sort_order row still marked is_killed false."
          />
          <Row
            label="Last one to fall"
            value={
              boss.lastFelled ? (
                <span>
                  {boss.lastFelled.name}
                  <span className="ml-2 text-xs text-muted">
                    {formatDurationSec(boss.sinceLastSec)} ago
                  </span>
                </span>
              ) : (
                <span className="text-frost">none yet on this world</span>
              )
            }
          />
          <div className="flex flex-wrap gap-1.5 pt-3">
            {Array.from({ length: boss.total }, (_, i) => (
              <Chip key={i} tone={i < boss.felled ? 'gold' : 'muted'}>
                {i < boss.felled ? 'felled' : 'standing'}
              </Chip>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            A kill fires four things at once: the boss watcher, the Skald retelling, the
            boss_kills_total Great Deed, and a Discord poll if boss polls are on.
          </p>
        </div>
      )}
    </HorizonCard>
  );
}
