// The two components that cannot report for themselves.
//
// EilifBoards and the Companion's voice queue both run inside Valheim on the GTX
// host and neither can POST a heartbeat: one has no HTTP write path at all and
// the other has no token to spare. Both authenticate to a route we own on a
// known cadence, so lib/ops/route-heartbeat.ts records the poll as the liveness
// signal. This panel says exactly what that record contains, because what it
// does NOT contain (a duration) is the thing an operator would otherwise assume.

import { PlugZap } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { formatAgeSec } from '@/lib/ops/window';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { Note, Pill, ScrollTable, Section, Td, Th, Tr } from './kit';

export interface RouteHeartbeatRow {
  component: string;
  label: string;
  /** The route whose authenticated poll writes the row. */
  route: string;
  /** What the plugin is doing when it polls. */
  purpose: string;
  status: string | null;
  ageSec: number | null;
  error: string | null;
  /** Metrics the route passed through, already sanitized upstream. */
  metrics: { key: string; value: string }[];
}

export interface RouteHeartbeatsProps {
  rows: RouteHeartbeatRow[];
  /** The throttle in lib/ops/route-heartbeat.ts, seconds. */
  throttleSec: number;
}

export function RouteHeartbeats({ rows, throttleSec }: RouteHeartbeatsProps) {
  return (
    <Section
      title="Route heartbeats"
      icon={<PlugZap size={18} />}
      entry={PERF_GLOSSARY['route-heartbeat']}
      caption="Liveness for the two in-game plugins, recorded by the routes they poll rather than reported by the plugins."
    >
      <Card>
        <ScrollTable
          minWidth={760}
          head={
            <>
              <Th>Component</Th>
              <Th>Recorded by</Th>
              <Th>State</Th>
              <Th right>Last poll</Th>
              <Th>What the row carries</Th>
            </>
          }
        >
          {rows.map((r) => {
            const unknown = r.ageSec === null;
            const stale = r.ageSec !== null && r.ageSec > 300;
            return (
              <Tr key={r.component}>
                <Td>
                  <div className="text-ash">{r.label}</div>
                  <div className="text-xs text-muted">{r.purpose}</div>
                </Td>
                <Td mono className="text-xs text-ash-dim">{r.route}</Td>
                <Td>
                  <Pill tone={unknown ? 'info' : stale ? 'bad' : 'good'}>
                    {unknown ? 'Never polled' : stale ? 'Stale' : 'Polling'}
                  </Pill>
                  {r.error && <div className="mt-1 text-xs text-death">{r.error}</div>}
                </Td>
                <Td right mono>{formatAgeSec(r.ageSec)}</Td>
                <Td>
                  {r.metrics.length === 0 ? (
                    <span className="text-xs text-muted">a timestamp only</span>
                  ) : (
                    <ul className="space-y-0.5 text-xs text-ash-dim">
                      {r.metrics.map((m) => (
                        <li key={m.key}>
                          <span className="text-muted">{m.key}</span>{' '}
                          <span className="font-mono">{m.value}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Td>
              </Tr>
            );
          })}
        </ScrollTable>
        <CardBody className="pt-3">
          <Note>
            No duration is recorded anywhere: what the route writes is a timestamp and the fact that the poll
            authenticated. The write is throttled to once per {throttleSec} s per serverless instance, so the
            age above is an upper bound and the real poll is up to {throttleSec} s more recent than it says.
            The row is written only after the token check passes, so an unauthenticated prober can never make
            a component look alive.
          </Note>
        </CardBody>
      </Card>
    </Section>
  );
}
