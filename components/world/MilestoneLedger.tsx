import { Trophy, CheckCircle2, CircleDashed } from 'lucide-react';
import { Card, CardBody, EmptyState } from '@/components/ui';
import { shortDate } from '@/lib/format';
import { renderLine, formatMetricValue, type MilestoneSummary } from '@/lib/milestones';

/**
 * The full Great Deeds ledger for /world: everything the warband has achieved
 * together (with dates + the tally at the moment it crossed) and everything
 * still ahead (with live progress). Reads as a companion to the boss roadmap —
 * the boss timeline is the story; this is the shared scoreboard.
 */
export function MilestoneLedger({ summary }: { summary: MilestoneSummary }) {
  const { achieved, upcoming } = summary;

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
                    <span className="font-display text-base text-gold-light">{m.title}</span>
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

      {/* Upcoming */}
      <Card>
        <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
          <span className="text-gold-dim">
            <CircleDashed size={16} />
          </span>
          <h3 className="font-display text-sm uppercase tracking-wide text-ash">
            On the horizon · {upcoming.length}
          </h3>
        </div>
        <CardBody className="p-0">
          {upcoming.length === 0 ? (
            <EmptyState
              icon={<Trophy size={24} />}
              title="Every deed earned"
              message="The warband has reached every milestone set for it. New deeds can be added any time."
            />
          ) : (
            <ul className="divide-y divide-rune">
              {upcoming.map(({ milestone: m, value, pct }) => (
                <li key={m.id} className="px-5 py-3.5">
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <span className="font-display text-sm text-ash">{m.title}</span>
                    <span className="shrink-0 font-display text-sm text-gold-light">{pct}%</span>
                  </div>
                  <div
                    className="h-2.5 w-full overflow-hidden rounded-full border border-rune bg-pitch"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Progress toward ${m.title}`}
                  >
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-gold-dim via-gold to-gold-light transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    {formatMetricValue(m.metric, value)} of {formatMetricValue(m.metric, m.threshold)}
                    {m.equivalence ? ` · ${m.equivalence}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
