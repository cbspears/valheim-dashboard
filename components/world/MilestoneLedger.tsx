import { Trophy, CheckCircle2, CircleDashed } from 'lucide-react';
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
 * The full Great Deeds ledger for /world: everything the warband has achieved
 * together (with dates + the tally at the moment it crossed) and everything
 * still ahead. "Ahead" is grouped into one row per tracked metric — several
 * deeds are just tiers of the same tracker (e.g. three sailing distances), so
 * showing the nearest unearned tier per tracker (instead of every tier at
 * once) is what's actually being progressed right now. Reads as a companion
 * to the boss roadmap — the boss timeline is the story; this is the shared
 * scoreboard.
 */
export function MilestoneLedger({ summary }: { summary: MilestoneSummary }) {
  const { achieved, upcoming } = summary;
  const chains = groupUpcomingChains(upcoming);

  if (achieved.length === 0 && upcoming.length === 0) {
    return (
      <Card>
        <CardBody className="p-0">
          <EmptyState
            icon={<Trophy size={28} />}
            title="No deeds tracked yet"
            message="Great Deeds are server-wide milestones — total distance sailed, foes felled, hours lived, timber raised. Once the warband is under way, earned and upcoming deeds will both be listed here."
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* Achieved */}
      <Card>
        <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
          <span className="text-gold">
            <CheckCircle2 size={16} />
          </span>
          <h3 className="font-display text-sm uppercase tracking-wide text-ash">
            Earned · {achieved.length}
          </h3>
        </div>
        <CardBody className="p-0">
          {achieved.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={24} />}
              title="Nothing earned yet"
              message="The first Great Deed is still ahead — every viking's tally counts toward it."
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

      {/* Upcoming — one row per tracked metric, nearest unearned tier only */}
      <Card>
        <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
          <span className="text-gold-dim">
            <CircleDashed size={16} />
          </span>
          <h3 className="font-display text-sm uppercase tracking-wide text-ash">
            On the horizon · {chains.length} {chains.length === 1 ? 'tracker' : 'trackers'}, {upcoming.length}{' '}
            {upcoming.length === 1 ? 'deed' : 'deeds'}
          </h3>
        </div>
        <CardBody className="p-0">
          {chains.length === 0 ? (
            <EmptyState
              icon={<Trophy size={24} />}
              title="Every deed earned"
              message="The warband has reached every milestone set for it. New deeds can be added any time."
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
    </div>
  );
}
