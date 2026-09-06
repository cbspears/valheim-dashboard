// How much of each component's silence budget is used.
//
// The Overview's state chip is a cliff: healthy right up to the threshold, then
// stale. A component sitting at 92% of its window has been in a slow decline
// nothing could show. These are the same facts as fractions, which is the one
// form in which a decline is visible before it becomes an incident.

import { HeartPulse } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { Gauge } from '@/components/ops/charts/Gauge';
import { Sparkline } from '@/components/ops/charts/Sparkline';
import { Explain } from '@/components/ops/Explain';
import { formatAgeSec, formatDurationSec, formatPercent } from '@/lib/ops/window';
import { HEADROOM_WARN_FRACTION } from '@/lib/ops/health';
import type { HeartbeatPressure } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { Note, Pill, Section } from './kit';

export interface HeartbeatGaugeRow {
  key: string;
  label: string;
  subtitle?: string;
  cadenceSec: number;
  /** True when liveness is inferred from a data freshness rather than a beat. */
  inferred?: boolean;
  pressure: HeartbeatPressure;
  /** Version string off the heartbeat row, when it reports one. */
  version: string | null;
  /** Sanitized error summary off the heartbeat row. */
  error: string | null;
  /**
   * p90 age per hour over the last 24 h, from ops_heartbeat_log. Empty when the
   * history table is not applied, which is the state on day one.
   */
  history: (number | null)[];
}

export interface HeartbeatGaugesProps {
  rows: HeartbeatGaugeRow[];
  historyPresent: boolean;
  hourLabels: string[];
}

const BAND_PILL: Record<HeartbeatPressure['band'], { text: string; tone: 'good' | 'warn' | 'bad' | 'info' }> = {
  quiet: { text: 'Quiet', tone: 'good' },
  tightening: { text: 'Tightening', tone: 'warn' },
  over: { text: 'Over', tone: 'bad' },
  unknown: { text: 'No signal yet', tone: 'info' },
};

export function HeartbeatGauges({ rows, historyPresent, hourLabels }: HeartbeatGaugesProps) {
  return (
    <Section
      title="Silence budget"
      icon={<HeartPulse size={18} />}
      entry={PERF_GLOSSARY['heartbeat-pressure']}
      caption="Each component's time since its last success, against the threshold that would turn it stale."
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows.map((r) => {
          const p = r.pressure;
          const band = BAND_PILL[p.band];
          return (
            <Card key={r.key}>
              <CardBody className="space-y-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ash">{r.label}</p>
                    {r.subtitle && <p className="text-[11px] text-muted">{r.subtitle}</p>}
                  </div>
                  <Pill tone={band.tone}>{band.text}</Pill>
                </div>

                <Gauge
                  value={p.ageSec ?? 0}
                  max={p.staleAfterSec}
                  warnAt={HEADROOM_WARN_FRACTION}
                  dangerAt={0.9}
                  label={`${r.label} time since last success against its stale threshold`}
                  valueText={
                    p.ageSec === null
                      ? `never reported, threshold ${formatDurationSec(p.staleAfterSec)}`
                      : `${formatDurationSec(p.ageSec)} of ${formatDurationSec(p.staleAfterSec)}` +
                        (p.fraction === null ? '' : ` (${formatPercent(p.fraction)})`)
                  }
                />

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                  <span>
                    Last success{' '}
                    <span className="font-mono text-ash-dim">{formatAgeSec(p.ageSec)}</span>
                  </span>
                  <span>
                    Expected every{' '}
                    <span className="font-mono text-ash-dim">{formatDurationSec(r.cadenceSec)}</span>
                  </span>
                  {r.inferred && <span>Inferred from data freshness, not a heartbeat</span>}
                  {r.version && (
                    <span>
                      Version <span className="font-mono text-ash-dim">{r.version}</span>
                    </span>
                  )}
                </div>

                {r.error && <p className="text-[11px] text-death">Last error: {r.error}</p>}

                {historyPresent ? (
                  r.history.every((v) => v === null) ? (
                    <p className="text-[11px] text-muted">No samples for this component in the last 24 h.</p>
                  ) : (
                    <div>
                      <Sparkline
                        values={r.history}
                        label={`${r.label} heartbeat age per hour, last 24 h, in seconds`}
                        className="text-frost"
                        height={28}
                      />
                      <div className="mt-0.5 flex justify-between text-[10px] text-muted">
                        <span>{hourLabels[0]}</span>
                        <span>p90 age per hour, last 24 h</span>
                        <span>{hourLabels[hourLabels.length - 1]}</span>
                      </div>
                    </div>
                  )
                ) : null}
              </CardBody>
            </Card>
          );
        })}
      </div>

      {!historyPresent && (
        <div className="mt-2 flex items-start gap-1.5">
          <Explain entry={PERF_GLOSSARY['heartbeat-history']} size="sm" />
          <Note>
          No history is charted because there is none to chart: ops_heartbeats holds exactly one upserted row
          per component, so a component&apos;s uptime over a week does not exist in this database.
          db/2026-09-06_ops_heartbeat_log.sql adds an append-only sample table with a pruning function and is
            written but UNAPPLIED. Applying it is a manual step and nothing here does it.
          </Note>
        </div>
      )}
    </Section>
  );
}
