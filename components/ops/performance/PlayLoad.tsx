// The load the system has never actually seen.
//
// The pipeline has run with three concurrent players and the server is capped at
// twenty. Peak concurrency per day is the number to watch against that cap on
// launch night, and deaths per hour played is the one number on this page that
// is about the game rather than about the plumbing.

import { Users } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { Bars } from '@/components/ops/charts/Bars';
import { BUCKET_TZ, formatCount } from '@/lib/ops/window';
import { PERF_GLOSSARY } from '@/lib/ops/glossary-performance';
import { NoData, Note, Section, Stat, StatRow } from './kit';

export interface PlayLoadProps {
  /** Peak simultaneous sessions per UTC day, oldest first. */
  peakPerDay: number[];
  dayLabels: string[];
  /** The configured player cap, for the "against the cap" reading. */
  maxPlayers: number;
  playedHours24h: number;
  playedHours7d: number;
  deaths24h: number;
  deaths7d: number;
  deathsPerHour24h: number | null;
  deathsPerHour7d: number | null;
  openSessions: number;
}

function fmtHours(h: number): string {
  if (h <= 0) return '0 h';
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

function fmtRate(r: number | null): string {
  if (r === null) return 'no playtime';
  return `${r < 10 ? r.toFixed(2) : Math.round(r)} per hour`;
}

export function PlayLoad({
  peakPerDay,
  dayLabels,
  maxPlayers,
  playedHours24h,
  playedHours7d,
  deaths24h,
  deaths7d,
  deathsPerHour24h,
  deathsPerHour7d,
  openSessions,
}: PlayLoadProps) {
  const peak = Math.max(0, ...peakPerDay);
  return (
    <Section
      title="Play load"
      icon={<Users size={18} />}
      entry={PERF_GLOSSARY['peak-concurrency']}
      caption={`Peak simultaneous sessions per day and how hard the hall was used. Days are aligned in ${BUCKET_TZ}.`}
    >
      <div className="space-y-3">
        <StatRow cols={5}>
          <Stat
            label="Peak together"
            value={`${peak} of ${maxPlayers}`}
            window="best day, last 7 d"
            tone={peak >= maxPlayers ? 'warn' : 'normal'}
          />
          <Stat label="Viking-hours" value={fmtHours(playedHours24h)} window="last 24 h" tone="muted" />
          <Stat label="Viking-hours" value={fmtHours(playedHours7d)} window="last 7 d" tone="muted" />
          <Stat
            label="Deaths per hour"
            value={fmtRate(deathsPerHour24h)}
            window="last 24 h"
            entry={PERF_GLOSSARY['deaths-per-hour']}
            hint={`${formatCount(deaths24h)} death${deaths24h === 1 ? '' : 's'} over ${fmtHours(playedHours24h)}`}
          />
          <Stat
            label="Deaths per hour"
            value={fmtRate(deathsPerHour7d)}
            window="last 7 d"
            hint={`${formatCount(deaths7d)} death${deaths7d === 1 ? '' : 's'} over ${fmtHours(playedHours7d)}`}
          />
        </StatRow>

        <Card>
          <CardBody>
            <p className="mb-2 text-xs uppercase tracking-wider text-muted">
              Peak simultaneous sessions per day, last 7 d
            </p>
            {peak === 0 ? (
              <NoData>No sessions overlapped the last 7 d. Nobody has been on the server.</NoData>
            ) : (
              <Bars
                bars={peakPerDay.map((v, i) => ({
                  label: dayLabels[i] ?? '',
                  value: v,
                  partial: i === peakPerDay.length - 1,
                  hint: `${dayLabels[i]}: ${v} viking${v === 1 ? '' : 's'} at once`,
                }))}
                max={Math.max(maxPlayers, peak)}
                label="Peak simultaneous sessions per day, last 7 d, against the configured cap"
                className="text-gold"
                height={72}
              />
            )}
            <Note>
              The scale runs to the configured cap of {maxPlayers}, so a bar half the height of the chart is
              half a full hall. A session still open counts as running to now, and one spanning midnight
              counts in both days.
              {openSessions > 0 &&
                ` ${openSessions} session${openSessions === 1 ? ' is' : 's are'} open right now: if that number
                stays high overnight it is a leak rather than a record, and the Overview tab names it.`}
            </Note>
          </CardBody>
        </Card>

        <Note>
          Deaths per hour played is null and not zero when nobody played, because &quot;no deaths&quot; and
          &quot;nobody was on the server&quot; are opposite facts. There is no baseline yet: this world has
          run with three players. Record what launch night reads and compare against it.
        </Note>
      </div>
    </Section>
  );
}
