// Pipeline delay: how long a fact takes to get from the game into the database.
//
// The headline panel of the tab. Everything here is the same statistic sliced
// four ways, because one median over the whole table would blend two producers
// with different physics and a few hundred backfilled rows that all read as
// zero. Presentational only: every number arrives computed.

import { Timer } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { Bars } from '@/components/ops/charts/Bars';
import { Sparkline } from '@/components/ops/charts/Sparkline';
import { formatCount, formatDurationSec } from '@/lib/ops/window';
import type {
  LagAudit,
  LagHistogramBin,
  LagSummary,
  PerfProducer,
  WorstLagRow,
} from '@/lib/ops/performance';
import { PRODUCER_LABELS } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { NoData, Note, ScrollTable, Section, Stat, StatRow, Td, Th, Tr } from './kit';

export interface LagPanelProps {
  day: LagSummary;
  week: LagSummary;
  audit24h: LagAudit;
  audit7d: LagAudit;
  histogram: LagHistogramBin[];
  /** p90 per UTC hour over the last 24 h. Null entries are hours with no rows. */
  hourlyP90: (number | null)[];
  hourLabels: string[];
  worst: WorstLagRow[];
  byProducer: { producer: PerfProducer; summary: LagSummary }[];
}

/** Under 30 s median is the floor the poller's own 20 s cadence sets. */
function toneForP50(sec: number | null): 'normal' | 'good' | 'warn' | 'bad' {
  if (sec === null) return 'normal';
  if (sec <= 30) return 'good';
  if (sec <= 90) return 'warn';
  return 'bad';
}

export function LagPanel({
  day,
  week,
  audit24h,
  audit7d,
  histogram,
  hourlyP90,
  hourLabels,
  worst,
  byProducer,
}: LagPanelProps) {
  const histMax = Math.max(1, ...histogram.map((b) => b.count));
  // The percentiles above are computed over rows the backfill did not touch, so
  // this line explains a window that reads "no data" while rows plainly exist.
  const allBackfilled7d = audit7d.measured > 0 && audit7d.backfilled === audit7d.measured;
  const measuredNote =
    audit24h.backfilled > 0 || audit7d.backfilled > 0
      ? `${formatCount(audit7d.backfilled)} of the ${formatCount(audit7d.measured)} rows with both stamps over ` +
        '7 d were backfilled by the inserted_at migration on 2026-09-05: their inserted_at was copied from ' +
        'created_at, so they carry a fabricated 0 s and are left out of every figure above.' +
        (allBackfilled7d
          ? ' That is every row in the window, which is why the 7 d columns read no data rather than 0 s. The'
            + ' first delay measured after the migration will fill them in.'
          : ' The remaining rows are the measurement.')
      : null;

  return (
    <Section
      title="Pipeline delay"
      icon={<Timer size={18} />}
      entry={PERF_GLOSSARY['lag-window']}
      caption="events.inserted_at minus events.created_at. The delay between a thing happening in the world and the site knowing about it."
    >
      <div className="space-y-3">
        <StatRow cols={5}>
          <Stat
            label="Median"
            value={formatDurationSec(day.p50)}
            window="last 24 h"
            tone={toneForP50(day.p50)}
          />
          <Stat label="p90" value={formatDurationSec(day.p90)} window="last 24 h" />
          <Stat label="p95" value={formatDurationSec(day.p95)} window="last 24 h" />
          <Stat label="Worst" value={formatDurationSec(day.max)} window="last 24 h" />
          <Stat
            label="Rows measured"
            value={formatCount(day.n)}
            window="last 24 h"
            tone="muted"
            hint={day.n === 0 ? 'Nothing was written in this window.' : undefined}
          />
        </StatRow>

        <StatRow cols={5}>
          <Stat
            label="Median"
            value={formatDurationSec(week.p50)}
            window="last 7 d"
            tone={toneForP50(week.p50)}
          />
          <Stat label="p90" value={formatDurationSec(week.p90)} window="last 7 d" />
          <Stat label="p95" value={formatDurationSec(week.p95)} window="last 7 d" />
          <Stat label="Worst" value={formatDurationSec(week.max)} window="last 7 d" />
          <Stat
            label="Backfilled"
            value={formatCount(audit7d.backfilled)}
            window="last 7 d"
            tone={audit7d.backfilled > 0 ? 'warn' : 'muted'}
            entry={PERF_GLOSSARY['lag-backfill']}
          />
        </StatRow>

        {measuredNote && <Note tone="warn">{measuredNote}</Note>}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card>
            <CardBody>
              <p className="mb-2 text-xs uppercase tracking-wider text-muted">
                p90 per hour, last 24 h (UTC)
              </p>
              {hourlyP90.every((v) => v === null) ? (
                <NoData>No events landed in the last 24 h, so there is nothing to plot.</NoData>
              ) : (
                <>
                  <Sparkline
                    values={hourlyP90}
                    label="Pipeline delay p90 per hour, last 24 h, in seconds"
                    className="text-gold"
                  />
                  <div className="mt-1 flex justify-between text-[10px] text-muted">
                    <span>{hourLabels[0]}</span>
                    <span>{hourLabels[Math.floor((hourLabels.length - 1) / 2)]}</span>
                    <span>{hourLabels[hourLabels.length - 1]}</span>
                  </div>
                  <Note>
                    Gaps are hours with no events at all, and are drawn as gaps rather than as zero.
                    Peak hourly p90:{' '}
                    {formatDurationSec(
                      Math.max(...hourlyP90.filter((v): v is number => v !== null), 0),
                    )}
                    .
                  </Note>
                </>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <p className="mb-2 text-xs uppercase tracking-wider text-muted">
                Where the delay falls, last 7 d
              </p>
              {histogram.every((b) => b.count === 0) ? (
                <NoData>No rows carried both stamps in the last 7 d.</NoData>
              ) : (
                <>
                  <Bars
                    bars={histogram.map((b) => ({
                      label: b.toSec === null ? `${b.fromSec}+` : `${b.fromSec}`,
                      value: b.count,
                      hint: `${b.label}: ${b.count} row${b.count === 1 ? '' : 's'}`,
                    }))}
                    max={histMax}
                    label="Event rows by pipeline delay band, last 7 d"
                    className="text-frost"
                    height={72}
                  />
                  <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
                    {histogram
                      .filter((b) => b.count > 0)
                      .map((b) => (
                        <li key={b.label}>
                          {b.label}: <span className="font-mono text-ash-dim">{formatCount(b.count)}</span> rows
                        </li>
                      ))}
                  </ul>
                </>
              )}
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardBody className="pb-0 pt-4">
            <div className="flex items-center gap-1.5">
              <p className="text-xs uppercase tracking-wider text-muted">Delay by producer, last 7 d</p>
            </div>
          </CardBody>
          <ScrollTable
            minWidth={560}
            head={
              <>
                <Th>Producer</Th>
                <Th right>Rows</Th>
                <Th right>Median</Th>
                <Th right>p90</Th>
                <Th right>Worst</Th>
              </>
            }
          >
            {byProducer.map(({ producer, summary }) => (
              <Tr key={producer}>
                <Td>{PRODUCER_LABELS[producer]}</Td>
                <Td right mono className={summary.n === 0 ? 'text-muted' : undefined}>
                  {formatCount(summary.n)}
                </Td>
                <Td right mono>{formatDurationSec(summary.p50)}</Td>
                <Td right mono>{formatDurationSec(summary.p90)}</Td>
                <Td right mono>{formatDurationSec(summary.max)}</Td>
              </Tr>
            ))}
          </ScrollTable>
          <CardBody className="pt-2">
            <Note>
              Attribution is derived from the row shape, not recorded: events has no source column. Client
              ingest writes at real now, the log poller writes 20 s to 30 s late by design, so the two are
              never averaged together here.
            </Note>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="pb-0 pt-4">
            <p className="text-xs uppercase tracking-wider text-muted">The five slowest rows, last 7 d</p>
          </CardBody>
          {worst.length === 0 ? (
            <CardBody>
              <NoData>No rows carried both stamps in the last 7 d.</NoData>
            </CardBody>
          ) : (
            <ScrollTable
              minWidth={620}
              head={
                <>
                  <Th right>Delay</Th>
                  <Th>Event</Th>
                  <Th>Viking</Th>
                  <Th>Producer time</Th>
                  <Th>Landed</Th>
                </>
              }
            >
              {worst.map((w) => (
                <Tr key={`${w.insertedAt}-${w.type}-${w.characterName ?? ''}`}>
                  <Td right mono className="text-ash">{formatDurationSec(w.lagSec)}</Td>
                  <Td>{w.type ?? 'unknown'}</Td>
                  <Td>{w.characterName ?? 'the hall'}</Td>
                  <Td mono className="text-[11px] text-muted">{w.createdAt.replace('T', ' ').slice(0, 19)}Z</Td>
                  <Td mono className="text-[11px] text-muted">{w.insertedAt.replace('T', ' ').slice(0, 19)}Z</Td>
                </Tr>
              ))}
            </ScrollTable>
          )}
        </Card>

        <Note>
          Last 24 h: {formatCount(audit24h.measured)} of {formatCount(audit24h.total)} rows carried both
          stamps. {formatCount(audit24h.missingInsertedAt)} had no inserted_at (written before the column
          existed) and {formatCount(audit24h.clamped)} had a producer clock ahead of the database, which is
          clamped to 0 s rather than counted as negative delay.
        </Note>
      </div>
    </Section>
  );
}
