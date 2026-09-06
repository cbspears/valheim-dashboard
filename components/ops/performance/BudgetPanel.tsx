// The free plan: 500 MB of database, 1 GB of storage, and what is left.
//
// This is the only thing in the system watching the constraint that actually
// ends the project. Every total here is labelled an estimate ON THE NUMBER, not
// in a footnote, because the exact size needs pg_database_size() and PostgREST
// has no route to SQL. The row counts underneath the estimate are exact and are
// worth reading on their own.

import { Database, HardDrive } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { Explain } from '@/components/ops/Explain';
import { Bars } from '@/components/ops/charts/Bars';
import { Gauge } from '@/components/ops/charts/Gauge';
import { formatBytes, formatCount, formatDurationSec, formatPercent } from '@/lib/ops/window';
import type { ByteEstimate, GrowthProjection } from '@/lib/ops/performance';
import { FREE_PLAN_DB_BYTES, FREE_PLAN_STORAGE_BYTES, BASELINE_DB_BYTES } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { NoData, Note, ScrollTable, Section, Stat, Td, Th, Tr } from './kit';

export interface StorageReport {
  bucket: string;
  present: boolean;
  objects: number | null;
  bytes: number | null;
  sampled: number;
  method: string;
}

export interface GrowthSeries {
  table: string;
  perDay: number[];
  bytesPerRow: number;
}

export interface BudgetPanelProps {
  estimate: ByteEstimate;
  /** Exact bytes from the (unapplied) size RPC. Null until it is applied. */
  exactDbBytes: number | null;
  exactStorageBytes: number | null;
  storage: StorageReport[];
  growth: GrowthProjection;
  growthSeries: GrowthSeries[];
  dayLabels: string[];
  /** Age of the cached row counts, seconds. Printed so nothing looks live. */
  countsAgeSec: number;
  /** Age of the cached storage measurement, seconds. */
  storageAgeSec: number;
}

export function BudgetPanel({
  estimate,
  exactDbBytes,
  exactStorageBytes,
  storage,
  growth,
  growthSeries,
  dayLabels,
  countsAgeSec,
  storageAgeSec,
}: BudgetPanelProps) {
  const dbBytes = exactDbBytes ?? estimate.totalBytes;
  const dbExact = exactDbBytes !== null;
  const dbFraction = dbBytes / FREE_PLAN_DB_BYTES;

  const storageMeasured = storage.filter((s) => s.bytes !== null);
  const storageSum = storageMeasured.reduce((sum, s) => sum + (s.bytes ?? 0), 0);
  const storageBytes = exactStorageBytes ?? (storageMeasured.length === 0 ? null : storageSum);
  const storageExact = exactStorageBytes !== null;
  const storageFraction = storageBytes === null ? 0 : storageBytes / FREE_PLAN_STORAGE_BYTES;

  const totalRows = estimate.tables.reduce((s, t) => s + (t.rows ?? 0), 0);
  const growthMax = Math.max(1, ...growthSeries.flatMap((g) => g.perDay));

  return (
    <Section
      title="Free plan budget"
      icon={<Database size={18} />}
      entry={PERF_GLOSSARY['db-budget']}
      caption="Supabase free plan: 500 MB of database and 1 GB of storage. Nothing else in the system watches either."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card>
            <CardBody className="space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Database size={15} className="text-gold" />
                <p className="text-xs uppercase tracking-wider text-muted">Database</p>
                <Explain entry={PERF_GLOSSARY['db-exact']} size="sm" />
              </div>
              <Gauge
                value={dbBytes}
                max={FREE_PLAN_DB_BYTES}
                label="Database size against the 500 MB free plan ceiling"
                valueText={`${dbExact ? '' : 'estimated '}${formatBytes(dbBytes)} of ${formatBytes(
                  FREE_PLAN_DB_BYTES,
                )} (${formatPercent(dbFraction)})`}
              />
              <p className="text-xs text-ash-dim">
                {dbExact ? (
                  <>Exact, from the applied size function.</>
                ) : (
                  <>
                    An <span className="font-semibold text-ash">estimate</span>:{' '}
                    {formatCount(totalRows)} exact rows across {estimate.tables.length} tables at documented
                    per-row byte constants, plus a {formatBytes(BASELINE_DB_BYTES)} floor for the catalogs and
                    the auth, storage and realtime schemas an empty project already carries.
                  </>
                )}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>
                  Rows: <span className="font-mono text-ash-dim">{formatBytes(estimate.tableBytes)}</span>
                </span>
                <span>
                  Baseline: <span className="font-mono text-ash-dim">{formatBytes(BASELINE_DB_BYTES)}</span>
                </span>
                <span>
                  Headroom:{' '}
                  <span className="font-mono text-ash-dim">
                    {formatBytes(Math.max(0, FREE_PLAN_DB_BYTES - dbBytes))}
                  </span>
                </span>
              </div>
              <p className="text-xs text-muted">
                Row counts taken {countsAgeSec < 1 ? 'just now' : `${formatDurationSec(countsAgeSec)} ago`},
                re-counted at most once a minute.
              </p>
              {estimate.unreadable.length > 0 && (
                <Note tone="warn">
                  Could not count: {estimate.unreadable.join(', ')}. Those tables contribute nothing to the
                  total above, so it reads low.
                </Note>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-2.5">
              <div className="flex items-center gap-1.5">
                <HardDrive size={15} className="text-gold" />
                <p className="text-xs uppercase tracking-wider text-muted">Storage</p>
                <Explain entry={PERF_GLOSSARY['storage-budget']} size="sm" />
              </div>
              {storageBytes === null ? (
                <NoData>
                  Neither bucket could be weighed. The objects are read over HTTP HEAD on the public URLs, so
                  a bucket turned private reads unknown here rather than wrong.
                </NoData>
              ) : (
                <Gauge
                  value={storageBytes}
                  max={FREE_PLAN_STORAGE_BYTES}
                  label="Storage used against the 1 GB free plan ceiling"
                  valueText={`${storageExact ? '' : 'sampled '}${formatBytes(storageBytes)} of ${formatBytes(
                    FREE_PLAN_STORAGE_BYTES,
                  )} (${formatPercent(storageFraction, 1)})`}
                />
              )}
              <p className="text-xs text-muted">
                Weighed {storageAgeSec < 1 ? 'just now' : `${formatDurationSec(storageAgeSec)} ago`}, and
                re-weighed at most every five minutes: the map snapshot rewrites these objects on that
                cadence, so measuring more often cannot produce a different number.
              </p>
              <ul className="space-y-1.5 text-xs">
                {storage.map((s) => (
                  <li key={s.bucket}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-ash-dim">
                        {s.bucket}
                        {!s.present && <span className="ml-1.5 text-death">bucket not found</span>}
                      </span>
                      <span className="font-mono text-ash">
                        {s.bytes === null ? 'unknown' : formatBytes(s.bytes)}
                        {s.objects !== null && (
                          <span className="ml-1.5 text-xs text-muted">
                            {formatCount(s.objects)} objects
                          </span>
                        )}
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed text-muted">{s.method}</p>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardBody className="space-y-2">
            <div className="flex items-center gap-1.5">
              <p className="text-xs uppercase tracking-wider text-muted">Growth, last 7 d</p>
            </div>
            <StatRowInline>
              <Stat
                label="Rate"
                value={growth.bytesPerDay === 0 ? 'not growing' : `${formatBytes(growth.bytesPerDay)}/day`}
                window="mean, last 7 d"
                entry={PERF_GLOSSARY['growth-projection']}
              />
              <Stat
                label="Until the ceiling"
                value={
                  growth.overCeiling
                    ? 'already past it'
                    : growth.daysToCeiling === null
                      ? 'not projected'
                      : horizonLabel(growth.daysToCeiling)
                }
                window="at that rate"
                tone={
                  growth.overCeiling
                    ? 'bad'
                    : growth.daysToCeiling !== null && growth.daysToCeiling < 30
                      ? 'warn'
                      : 'normal'
                }
                hint={
                  growth.daysToCeiling === null && !growth.overCeiling
                    ? 'Nothing grew in the window, so there is nothing to extend forward.'
                    : undefined
                }
              />
              <Stat
                label="Tables watched"
                value={formatCount(growthSeries.length)}
                window="the ones that grow with play"
                tone="muted"
                hint="player_positions is excluded: one row per viking, overwritten in place."
              />
            </StatRowInline>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {growthSeries.map((g) => (
                <div key={g.table}>
                  <p className="mb-1 text-xs text-muted">
                    {g.table}{' '}
                    <span className="text-ash-dim">
                      {formatCount(g.perDay.reduce((a, b) => a + b, 0))} rows, last 7 d
                    </span>
                  </p>
                  <Bars
                    bars={g.perDay.map((v, i) => ({
                      label: dayLabels[i] ?? '',
                      value: v,
                      partial: i === g.perDay.length - 1,
                      hint: `${dayLabels[i]}: ${v} row${v === 1 ? '' : 's'}`,
                    }))}
                    max={growthMax}
                    label={`Rows added to ${g.table} per day, last 7 d`}
                    className="text-frost"
                    height={40}
                  />
                </div>
              ))}
            </div>
            <Note>
              7 d of pre-launch data is a floor, not a forecast: twenty players will not write at the rate
              three did. Re-read this a day after launch.
            </Note>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex items-center gap-1.5 pb-0 pt-4">
            <p className="text-xs uppercase tracking-wider text-muted">
              Exact row counts, all {estimate.tables.length} tables
            </p>
          </CardBody>
          <ScrollTable
            minWidth={560}
            head={
              <>
                <Th>Table</Th>
                <Th right>Rows</Th>
                <Th right>Bytes per row</Th>
                <Th right>Estimated size</Th>
              </>
            }
          >
            {[...estimate.tables]
              .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
              .map((t) => (
                <Tr key={t.table}>
                  <Td>
                    {t.table}
                    {t.assumedRowSize && (
                      <span className="ml-2 text-xs text-raid">no per-row constant, default used</span>
                    )}
                  </Td>
                  <Td right mono className={t.rows === null ? 'text-death' : t.rows === 0 ? 'text-muted' : undefined}>
                    {t.rows === null ? 'unreadable' : formatCount(t.rows)}
                  </Td>
                  <Td right mono className="text-xs text-muted">{t.bytesPerRow} B</Td>
                  <Td right mono>{t.bytes === null ? 'unknown' : formatBytes(t.bytes)}</Td>
                </Tr>
              ))}
          </ScrollTable>
          <CardBody className="pt-2">
            <Note>
              The row counts are exact (head-only COUNT queries that transfer no rows). The byte columns are
              the estimate. The table list is fixed in app/admin/ops/performance/data.ts: a table added to
              db/ and not added there goes uncounted and the total reads low.
            </Note>
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}

/**
 * A projection in words a person can act on.
 *
 * The arithmetic answer at today's pre-launch rate is 248,497 days, which is six
 * hundred years and is not an answer: a number that large only tells the reader
 * the projection has stopped meaning anything. Everything past five years is
 * therefore said as "more than five years away", which is the true content of it.
 */
function horizonLabel(days: number): string {
  if (days < 90) return `${formatCount(days)} days`;
  if (days < 730) return `about ${formatCount(Math.round(days / 30))} months`;
  if (days < 1825) return `about ${formatCount(Math.round(days / 365))} years`;
  return 'more than 5 years away';
}

/** A three-across stat row that lives inside an existing card. */
function StatRowInline({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">{children}</div>;
}
