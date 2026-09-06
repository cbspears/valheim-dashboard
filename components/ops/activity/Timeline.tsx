// The merged feed: everything that fired, newest first, with the raw row behind
// a <details> on every entry.
//
// <details> and not a modal, on purpose. It is the only expand-in-place control
// that works with no JavaScript at all, it is keyboard operable and announced
// correctly for free, and it keeps this whole page a Server Component. Two
// hundred rows each carrying a modal trigger would be two hundred client
// components on a page an operator refreshes all night.
//
// Rows are grouped under a UTC day heading so a 7 d feed does not read as one
// undifferentiated column of times.

import { clsx } from 'clsx';
import { Panel } from './Panel';
import { ACTIVITY_GLOSSARY } from '@/lib/ops/glossary-activity';
import { formatAgeSec } from '@/lib/ops/window';
import { clockUtc, dayUtc } from '@/lib/ops/window';
import { KIND_LABELS, PRODUCER_LABELS, type FiredKind, type FiredRow } from '@/lib/ops/activity';

/** One tone per kind, from the app's palette. Never a hex value. */
const KIND_TONE: Record<FiredKind, string> = {
  join: 'text-online-glow',
  leave: 'text-offline',
  death: 'text-death',
  boss_kill: 'text-boss',
  raid: 'text-raid',
  chat: 'text-muted',
  voice: 'text-frost',
  deed: 'text-gold-light',
  title: 'text-gold-light',
  poty: 'text-gold-light',
  oath: 'text-frost',
  pin: 'text-ash-dim',
  photo: 'text-ash-dim',
  alert: 'text-raid',
  other: 'text-muted',
};

export function Timeline({
  rows,
  nowMs,
  window: win,
  windowText,
  filterText,
  matched,
  limit,
}: {
  /** Already filtered and already capped at `limit`. */
  rows: FiredRow[];
  nowMs: number;
  /** Which window is showing, so the empty state cannot suggest the one already on. */
  window: '24h' | '7d';
  windowText: string;
  filterText: string;
  /** How many rows matched before the render cap, so truncation can be honest. */
  matched: number;
  limit: number;
}) {
  const truncated = matched > rows.length;

  // Group into UTC days, preserving the newest-first order.
  const days: { day: string; rows: FiredRow[] }[] = [];
  for (const r of rows) {
    const day = dayUtc(r.atMs);
    const last = days[days.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else days.push({ day, rows: [r] });
  }

  return (
    <Panel
      title="The firing timeline"
      entry={ACTIVITY_GLOSSARY['fired-timeline']}
      note={
        <>
          {filterText}, {windowText}, newest first.{' '}
          {truncated
            ? `Showing the newest ${rows.length} of ${matched} matching rows (the render cap is ${limit}).`
            : `${matched} matching ${matched === 1 ? 'row' : 'rows'}.`}
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted">
          {/* Do not offer a window that is already on. The first cut said "widen
              the window to 7 d" on the 7 d view, which is advice the reader has
              already taken. */}
          Nothing matched in this window.{' '}
          {win === '24h'
            ? 'Widen the window to 7 d, or clear the kind filter, before reading this as an outage: '
            : 'Clear the kind filter before reading this as an outage: this is already the widest window the page reads. '}
          the silences panel above is the number that tells you whether the quiet is real.
        </p>
      ) : (
        <div className="space-y-5">
          {days.map((group) => (
            <div key={group.day}>
              <h4 className="mb-2 border-b border-rune pb-1 text-xs uppercase tracking-wide text-muted">
                {group.day} UTC
              </h4>
              <ol className="space-y-1.5">
                {group.rows.map((r) => (
                  <li key={r.id} className="border-b border-rune/40 pb-1.5 last:border-0">
                    {/* Narrow screens get two lines: the stamps on one, the
                        sentence on its own full-width line below. Keeping the
                        label in the same flex row at 390 px wrapped it to one
                        word per line, which is how a feed becomes unreadable. */}
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                        {clockUtc(r.atMs)}
                      </span>
                      <span
                        className={clsx(
                          'shrink-0 text-xs uppercase tracking-wide',
                          KIND_TONE[r.kind],
                        )}
                      >
                        {KIND_LABELS[r.kind]}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted sm:order-last">
                        {formatAgeSec(Math.max(0, (nowMs - r.atMs) / 1000))}
                      </span>
                      <span className="order-last w-full min-w-0 text-ash sm:order-none sm:ml-0 sm:w-auto sm:flex-1">
                        {r.label}
                      </span>
                    </div>
                    {r.detail && (
                      <p className="mt-0.5 text-xs text-ash-dim sm:pl-[3.6rem]">{r.detail}</p>
                    )}
                    <div className="mt-0.5 sm:pl-[3.6rem]">
                      <details className="group">
                        <summary className="cursor-pointer list-none text-xs text-muted transition hover:text-ash-dim">
                          <span className="group-open:hidden">raw row</span>
                          <span className="hidden group-open:inline">hide raw row</span>
                          <span className="ml-2 text-rune-bright">
                            {PRODUCER_LABELS[r.producer]}
                          </span>
                        </summary>
                        <pre className="mt-1 overflow-x-auto rounded border border-rune bg-pitch px-2.5 py-2 text-xs leading-relaxed text-ash-dim">
{JSON.stringify(
  { at: r.at, kind: r.kind, who: r.who, producer: r.producer, raw: r.raw ?? null },
  null,
  2,
)}
                        </pre>
                      </details>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
