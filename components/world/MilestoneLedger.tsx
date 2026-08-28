import { Trophy } from 'lucide-react';
import { Card, CardBody, EmptyState } from '@/components/ui';
import { shortDate } from '@/lib/format';
import {
  renderLine,
  formatMetricValue,
  metricInfo,
  groupUpcomingChains,
  type MilestoneSummary,
} from '@/lib/milestones';

/**
 * The Great Deeds ledger for /world, split into its two independently
 * renderable halves so the page can stand them side by side as their own
 * columns (earned | on the horizon) instead of stacking one card pair.
 *
 * Both halves take the whole MilestoneSummary rather than just their own
 * slice: each needs to know whether the OTHER half is empty to tell "nothing
 * earned yet / every deed earned" apart from "no deeds are tracked at all"
 * (a fresh world before the milestones seed), which want different copy.
 *
 * Reads as a companion to the boss roadmap — the boss timeline is the story;
 * this is the shared scoreboard.
 */

/** True when no milestone rows exist at all (pre-seed), not merely none earned. */
function noDeedsTracked(summary: MilestoneSummary): boolean {
  return summary.achieved.length === 0 && summary.upcoming.length === 0;
}

const NOTHING_TRACKED_MESSAGE =
  'Milestones are server-wide goals: total distance sailed, foes felled, hours lived, timber raised. Once the warband is under way, earned and upcoming deeds will both be listed here.';

/**
 * Everything the warband has achieved together, most recent first, with the
 * date it crossed and the tally at that moment.
 */
export function EarnedDeeds({ summary }: { summary: MilestoneSummary }) {
  const { achieved } = summary;

  return (
    <Card>
      <CardBody className="p-0">
        {achieved.length === 0 ? (
          <EmptyState
            icon={<Trophy size={28} />}
            title={noDeedsTracked(summary) ? 'No deeds tracked yet' : 'Nothing earned yet'}
            message={
              noDeedsTracked(summary)
                ? NOTHING_TRACKED_MESSAGE
                : "The first milestone is still ahead, and every viking's tally counts toward it."
            }
          />
        ) : (
          <ul className="divide-y divide-rune">
            {achieved.map((m) => (
              <li key={m.id} className="px-5 py-3.5">
                <div className="flex items-baseline justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-muted">
                      {metricInfo(m.metric).label}
                    </p>
                    <span className="font-display text-base text-gold-light">{m.title}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted">{shortDate(m.achieved_at)}</span>
                </div>
                <p className="mt-0.5 text-sm italic text-ash-dim">
                  &ldquo;{renderLine(m.line, m.achieved_value ?? m.threshold)}&rdquo;
                </p>
                <p className="mt-1 text-xs text-muted">
                  {formatMetricValue(m.metric, m.achieved_value ?? m.threshold)}
                  {m.equivalence ? ` · ${m.equivalence}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Everything still ahead — one row per tracked metric, nearest unearned tier
 * only. Several deeds are just tiers of the same tracker (e.g. three sailing
 * distances), so showing the nearest unearned tier per tracker (instead of
 * every tier at once) is what's actually being progressed right now; the
 * further tiers trail it as a short "then:" list.
 */
export function HorizonDeeds({ summary }: { summary: MilestoneSummary }) {
  const chains = groupUpcomingChains(summary.upcoming);

  return (
    <Card>
      <CardBody className="p-0">
        {chains.length === 0 ? (
          <EmptyState
            icon={<Trophy size={28} />}
            title={noDeedsTracked(summary) ? 'No deeds tracked yet' : 'Every deed earned'}
            message={
              noDeedsTracked(summary)
                ? NOTHING_TRACKED_MESSAGE
                : 'The warband has reached every milestone set for it. New deeds can be added any time.'
            }
          />
        ) : (
          <ul className="divide-y divide-rune">
            {chains.map((chain) => (
              <li key={chain.metric} className="px-5 py-3.5">
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <span className="font-display text-sm text-ash">{chain.label}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {formatMetricValue(chain.metric, chain.value)}
                  </span>
                </div>
                <div
                  className="h-2.5 w-full overflow-hidden rounded-full border border-rune bg-pitch"
                  role="progressbar"
                  aria-valuenow={chain.next.pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Progress toward ${chain.next.milestone.title}`}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-gold-dim via-gold to-gold-light transition-all"
                    style={{ width: `${chain.next.pct}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs italic text-ash-dim">
                  next: &ldquo;{chain.next.milestone.title}&rdquo; · at{' '}
                  {formatMetricValue(chain.metric, chain.next.milestone.threshold)}
                  {chain.next.milestone.equivalence ? ` · ${chain.next.milestone.equivalence}` : ''} ·{' '}
                  <span className="not-italic text-gold-light">{chain.next.pct}%</span>
                </p>
                {chain.laterTiers.length > 0 && (
                  <p className="mt-1 text-[11px] text-muted">
                    then: {chain.laterTiers.map((m) => m.title).join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
