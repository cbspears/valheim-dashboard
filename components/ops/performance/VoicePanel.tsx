// The in-game voice queue: what is waiting, what got spoken, and how long it took.
//
// A line is marked spoken the instant the Companion collects it from
// GET /api/voice, so the latency here is collection time and not speech time.
// That is stated on the panel rather than left to be inferred, because the two
// are easy to confuse and only one of them is measurable from this side.

import { Volume2 } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { Gauge } from '@/components/ops/charts/Gauge';
import { formatAgeSec, formatCount, formatDurationSec } from '@/lib/ops/window';
import type { VoiceQueueHealth } from '@/lib/ops/performance';
import { VOICE_STALLED_AFTER_SEC } from '@/lib/ops/performance';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { NoData, Note, ScrollTable, Section, Stat, StatRow, Td, Th, Tr } from './kit';

export interface VoicePanelProps {
  health: VoiceQueueHealth;
  window: string;
  /** Lines spoken in the last 24 h, for the short window beside the long one. */
  spoken24h: number;
  /** True when at least one viking is on the server right now. */
  playersOnline: number;
}

export function VoicePanel({ health, window, spoken24h, playersOnline }: VoicePanelProps) {
  const stalledTone = health.stalled === 0 ? 'good' : playersOnline > 0 ? 'bad' : 'warn';
  const oldest = health.oldestQueuedSec;

  return (
    <Section
      title="Voice queue"
      icon={<Volume2 size={18} />}
      entry={PERF_GLOSSARY['voice-speak']}
      caption="voice_lines: how long a queued line waits for the Companion to collect it, and what is still waiting."
    >
      <div className="space-y-3">
        <StatRow cols={5}>
          <Stat
            label="Queued"
            value={formatCount(health.queued)}
            window="right now, any age"
            tone={health.queued > 0 ? 'warn' : 'good'}
          />
          <Stat
            label="Stalled"
            value={formatCount(health.stalled)}
            window={`over ${Math.round(VOICE_STALLED_AFTER_SEC / 60)} min old`}
            tone={stalledTone}
            entry={PERF_GLOSSARY['voice-stalled']}
          />
          <Stat
            label="Oldest queued"
            value={oldest === null ? 'none' : formatAgeSec(oldest)}
            window="right now"
            tone={oldest !== null && oldest > VOICE_STALLED_AFTER_SEC ? 'bad' : 'normal'}
          />
          <Stat
            label="Spoken"
            value={formatCount(health.spokenInWindow)}
            window={window}
            tone="muted"
            hint={`${formatCount(spoken24h)} of them in the last 24 h.`}
          />
          <Stat
            label="Median wait"
            value={formatDurationSec(health.speakLatency.p50)}
            window={window}
            hint={`p90 ${formatDurationSec(health.speakLatency.p90)}, worst ${formatDurationSec(
              health.speakLatency.max,
            )}`}
          />
        </StatRow>

        <Card>
          <CardBody className="space-y-3">
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wider text-muted">
                Oldest queued line against the stall threshold
              </p>
              <Gauge
                value={oldest ?? 0}
                max={VOICE_STALLED_AFTER_SEC}
                warnAt={0.7}
                dangerAt={1}
                label="Age of the oldest queued voice line against the ten minute stall threshold"
                valueText={
                  oldest === null
                    ? `nothing queued, threshold ${Math.round(VOICE_STALLED_AFTER_SEC / 60)} min`
                    : `${formatDurationSec(oldest)} of ${Math.round(VOICE_STALLED_AFTER_SEC / 60)} min`
                }
              />
            </div>
            <p className="text-xs text-muted">
              {playersOnline === 0
                ? 'Nobody is on the server, so the Companion is not polling and a queued line will sit until somebody joins. That is correct behaviour, not a stall.'
                : `${playersOnline} viking${
                    playersOnline === 1 ? '' : 's'
                  } online, so the Companion should be collecting every few seconds. A line older than ${Math.round(
                    VOICE_STALLED_AFTER_SEC / 60,
                  )} minutes means it is polling but not speaking, or not polling at all.`}
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="pb-0 pt-4">
            <p className="text-xs uppercase tracking-wider text-muted">By kind, {window}</p>
          </CardBody>
          {health.byKind.length === 0 ? (
            <CardBody>
              <NoData>No lines were queued or spoken in this window.</NoData>
            </CardBody>
          ) : (
            <ScrollTable
              minWidth={560}
              head={
                <>
                  <Th>Kind</Th>
                  <Th right>Spoken</Th>
                  <Th right>Queued</Th>
                  <Th right>Median wait</Th>
                  <Th right>Worst wait</Th>
                </>
              }
            >
              {health.byKind.map((k) => (
                <Tr key={k.kind}>
                  <Td>{k.kind}</Td>
                  <Td right mono className={k.spoken === 0 ? 'text-muted' : undefined}>
                    {formatCount(k.spoken)}
                  </Td>
                  <Td right mono className={k.queued === 0 ? 'text-muted' : undefined}>
                    {formatCount(k.queued)}
                  </Td>
                  <Td right mono>{formatDurationSec(k.latency.p50)}</Td>
                  <Td right mono>{formatDurationSec(k.latency.max)}</Td>
                </Tr>
              ))}
            </ScrollTable>
          )}
          <CardBody className="pt-2">
            <Note>
              A line is marked spoken the moment the Companion collects it from GET /api/voice, so these are
              collection times. How long the words then take to appear on screen is not measurable from this
              side. voice_lines has no expiry column and nothing deletes a queued line, so an old queued line
              is one nobody ever came to collect.
            </Note>
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}
