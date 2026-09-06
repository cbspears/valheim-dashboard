// How many rows the pipeline wrote per hour, and which half wrote them.
//
// The rate answers "was it busy"; the split answers "was it whole". A producer
// that stops writing shows up here hours before its heartbeat threshold trips,
// because a heartbeat says the process is alive and this says it is doing work.

import { Gauge } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { Bars } from '@/components/ops/charts/Bars';
import { BUCKET_TZ, formatCount, formatRatePerHour, WINDOW_24H_MS, WINDOW_7D_MS } from '@/lib/ops/window';
import { PRODUCER_LABELS, type PerfProducer } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { NoData, Note, ScrollTable, Section, Td, Th, Tr } from './kit';

export interface IngestRatesProps {
  hourLabels: string[];
  /** Total rows per UTC hour over the last 24 h. Last bucket is the partial one. */
  hourly: number[];
  /** Per-producer rows per hour, same buckets. */
  hourlyByProducer: Record<PerfProducer, number[]>;
  totals24h: Record<PerfProducer, number>;
  totals7d: Record<PerfProducer, number>;
  producers: PerfProducer[];
}

export function IngestRates({
  hourLabels,
  hourly,
  hourlyByProducer,
  totals24h,
  totals7d,
  producers,
}: IngestRatesProps) {
  const total24 = producers.reduce((s, p) => s + totals24h[p], 0);
  const total7 = producers.reduce((s, p) => s + totals7d[p], 0);

  return (
    <Section
      title="Ingest rate"
      icon={<Gauge size={18} />}
      entry={PERF_GLOSSARY['lag-producer']}
      caption={`Event rows written per hour, and which producer wrote them. Buckets are aligned in ${BUCKET_TZ}.`}
    >
      <div className="space-y-3">
        <Card>
          <CardBody>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-wider text-muted">Rows per hour, last 24 h</p>
              <p className="text-xs text-ash-dim">
                <span className="font-mono text-ash">{formatCount(total24)}</span> rows,{' '}
                {formatRatePerHour(total24, WINDOW_24H_MS)}, last 24 h
              </p>
            </div>
            {total24 === 0 ? (
              <NoData>
                Nothing was written in the last 24 h. With no players online that is the expected reading,
                not a fault.
              </NoData>
            ) : (
              <Bars
                bars={hourly.map((v, i) => ({
                  label: hourLabels[i],
                  value: v,
                  partial: i === hourly.length - 1,
                  hint: `${hourLabels[i]} ${BUCKET_TZ}: ${v} row${v === 1 ? '' : 's'}${
                    i === hourly.length - 1 ? ' (hour still running)' : ''
                  }`,
                }))}
                label="Event rows per hour, last 24 h"
                className="text-gold"
                height={80}
              />
            )}
            <Note>
              The last bar is the hour still in progress and is drawn muted, so it is not read as a drop.
            </Note>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="pb-0 pt-4">
            <p className="text-xs uppercase tracking-wider text-muted">By producer (derived from the row shape)</p>
          </CardBody>
          <ScrollTable
            minWidth={620}
            head={
              <>
                <Th>Producer</Th>
                <Th right>Rows, last 24 h</Th>
                <Th right>Rows, last 7 d</Th>
                <Th right>Rate, last 24 h</Th>
                <Th>Per hour, last 24 h</Th>
              </>
            }
          >
            {producers.map((p) => {
              const series = hourlyByProducer[p] ?? [];
              const silent = totals24h[p] === 0 && totals7d[p] > 0;
              return (
                <Tr key={p}>
                  <Td>
                    <span className={silent ? 'text-raid' : undefined}>{PRODUCER_LABELS[p]}</span>
                    {silent && (
                      <span className="ml-2 text-[11px] text-raid">wrote nothing in the last 24 h</span>
                    )}
                  </Td>
                  <Td right mono className={totals24h[p] === 0 ? 'text-muted' : undefined}>
                    {formatCount(totals24h[p])}
                  </Td>
                  <Td right mono className={totals7d[p] === 0 ? 'text-muted' : undefined}>
                    {formatCount(totals7d[p])}
                  </Td>
                  <Td right mono className="text-[11px] text-muted">
                    {formatRatePerHour(totals24h[p], WINDOW_24H_MS)}
                  </Td>
                  <Td className="w-40">
                    {series.some((v) => v > 0) ? (
                      <Bars
                        bars={series.map((v, i) => ({
                          label: hourLabels[i],
                          value: v,
                          partial: i === series.length - 1,
                        }))}
                        label={`${PRODUCER_LABELS[p]} rows per hour, last 24 h`}
                        className="text-frost"
                        height={26}
                        hideAxis
                      />
                    ) : (
                      <span className="text-[11px] text-muted">nothing in this window</span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </ScrollTable>
          <CardBody className="pt-2">
            <Note>
              {formatCount(total7)} rows over the last 7 d, {formatRatePerHour(total7, WINDOW_7D_MS)}.
              Unattributed rows are not a fault: they are event types the derivation rules in
              lib/ops/performance.ts do not yet name.
            </Note>
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}
