import Link from 'next/link';
import { Trophy, ArrowRight } from 'lucide-react';
import { Card, CardHeader, CardBody, EmptyState } from '@/components/ui';
import { timeAgo } from '@/lib/format';
import { renderLine, formatMetricValue, metricInfo, type MilestoneSummary } from '@/lib/milestones';

/**
 * The Hall's "Great Deeds" card — the collective-milestone counterpart to the
 * Hearth. Shows the deed the warband most recently earned together, plus a
 * progress bar toward the nearest one still ahead. Copy says plainly what it is;
 * the flavor lives in the deed lines + the empty state.
 */
export function GreatDeedsCard({ summary }: { summary: MilestoneSummary }) {
  const { latest, next, achieved, upcoming } = summary;
  const total = achieved.length + upcoming.length;

  return (
    <Card>
      <CardHeader
        title="Milestones"
        icon={<Trophy size={16} />}
        action={
          <Link
            href="/world"
            className="gold-ring inline-flex items-center gap-1 rounded text-xs font-medium text-gold-light hover:text-gold-light/80"
          >
            The ledger <ArrowRight size={13} />
          </Link>
        }
      />
      <CardBody className="space-y-4">
        {total === 0 ? (
          <EmptyState
            icon={<Trophy size={28} />}
            title="No deeds tracked yet"
            message="Server-wide milestones, from distance sailed to foes felled to timber raised, are tallied here as the warband reaches them together."
          />
        ) : (
          <>
            {latest ? (
              <div>
                <p className="text-xs uppercase tracking-wider text-muted">Latest deed</p>
                <p className="mt-1 font-display text-base text-gold-light">{latest.title}</p>
                <p className="mt-0.5 text-sm italic text-ash-dim">
                  &ldquo;{renderLine(latest.line, latest.achieved_value ?? latest.threshold)}&rdquo;
                </p>
                {latest.equivalence && <p className="mt-1 text-xs text-muted">{latest.equivalence}</p>}
                <p className="mt-1.5 text-xs text-muted">
                  {timeAgo(latest.achieved_at)} · {achieved.length} of {total} deeds earned
                </p>
              </div>
            ) : (
              <p className="text-sm text-ash-dim">
                No deeds earned yet, but the first is already within reach. Sail, fight, and build on.
              </p>
            )}

            {next && (
              <>
                <hr className="rune-divider" />
                <div>
                  <div className="mb-2 flex items-end justify-between gap-3">
                    <span className="text-sm text-ash-dim">
                      <span className="text-xs uppercase tracking-wider text-muted">Next deed · </span>
                      <span className="font-display text-ash">{next.milestone.title}</span>
                    </span>
                    <span className="font-display text-sm text-gold-light">{next.pct}%</span>
                  </div>
                  <div
                    className="h-3 w-full overflow-hidden rounded-full border border-rune bg-pitch"
                    role="progressbar"
                    aria-valuenow={next.pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Progress toward ${next.milestone.title}`}
                  >
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-gold-dim via-gold to-gold-light shadow-[0_0_12px_-2px_rgba(232,184,75,0.6)] transition-all"
                      style={{ width: `${next.pct}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    {metricInfo(next.milestone.metric).label} ·{' '}
                    {formatMetricValue(next.milestone.metric, next.value)} of{' '}
                    {formatMetricValue(next.milestone.metric, next.milestone.threshold)}
                  </p>
                </div>
              </>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
