// The two silences: the longest gap in the window, and the longest gap that
// happened while somebody was actually connected.
//
// THIS PANEL DOES NOT RAISE AN ALARM, AND THE FIRST CUT DID. It banded the
// online silence in the danger tone over ten minutes and told the reader to go
// find the missing producer. That is a false alarm by construction: a session's
// own join row sits at the start of the online stretch and its leave row at the
// end, `events` records only join, leave, death, boss, raid and chat, and a
// viking who spends an evening mining writes nothing in between. So an ordinary
// quiet session always reports its full length as a silence. It fired on real
// data: Loa's 2 h 35 m solo session on Aug 30 was drawn in red with remediation
// copy while every producer was healthy.
//
// The measurement is worth keeping. The alarm was not. What the panel does now
// is say WHICH of the two shapes it is looking at, using `wholeStretch`: a
// silence that runs the whole stretch is a quiet session, and a silence bounded
// on both sides by rows inside a stretch that was otherwise writing is the one
// that is worth a second look.

import { EarOff, Users } from 'lucide-react';
import { Panel } from './Panel';
import { Explain } from '@/components/ops/Explain';
import { ACTIVITY_GLOSSARY } from '@/lib/ops/glossary-activity';
import { GLOSSARY } from '@/lib/ops/glossary';
import { formatAgeSec, formatDurationSec } from '@/lib/ops/window';
import { stampUtc } from '@/lib/ops/window';
import type { QuietGap, Silence } from '@/lib/ops/activity';

/**
 * Long enough to be worth a second look, and ONLY when the silence sits inside
 * a stretch that was writing rows on both sides of it. Never a colour on its
 * own: see the header.
 */
const SILENCE_NOTE_SEC = 10 * 60;

function reading(s: Silence): string {
  if (s.wholeStretch) {
    return (
      'Nothing was written between the join and the leave, which is what an ordinary quiet ' +
      'session looks like. The events table records joins, leaves, deaths, boss kills, raids ' +
      'and chat, so a viking mining or sailing writes no rows at all.'
    );
  }
  if (s.sec > SILENCE_NOTE_SEC) {
    return (
      'This gap sits inside a stretch that was writing rows on both sides of it, and it ran ' +
      'longer than ten minutes. Usually still just quiet play. Worth a second look if several ' +
      'vikings were on: compare the producer split for the same window.'
    );
  }
  return 'Nothing unusual. Vikings sailing quietly write no rows for minutes at a time.';
}

export function Silences({
  gap,
  silence,
  onlineMinutes,
  windowText,
  nowMs,
}: {
  gap: QuietGap | null;
  silence: Silence | null;
  /** Total minutes anybody was connected inside the window. */
  onlineMinutes: number;
  windowText: string;
  /** The page's render clock, so "ended N ago" agrees with the feed. */
  nowMs: number;
}) {
  return (
    <Panel
      title="Silences"
      entry={ACTIVITY_GLOSSARY.silence}
      note={`The longest stretches with no events row, ${windowText}. Somebody was connected for ${Math.round(onlineMinutes)} min of this window.`}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted">
            <Users size={13} />
            While somebody was online
          </h4>
          {silence === null ? (
            <p className="text-sm text-muted">
              Nobody was connected at any point in this window, so there is no silence to measure.
              That is not a clean bill of health, it is an empty hall.
            </p>
          ) : (
            <>
              <p className="font-display text-2xl text-ash">{formatDurationSec(silence.sec)}</p>
              <p className="mt-1 text-xs text-muted">
                {stampUtc(silence.startMs)} to {stampUtc(silence.endMs)}
                {silence.open
                  ? ', and it is still running'
                  : `, which ended ${formatAgeSec((nowMs - silence.endMs) / 1000)}`}
                . The online stretch it sits in ran {formatDurationSec(silence.stretchSec)}.
              </p>
              <p className="mt-2 text-xs text-ash-dim">{reading(silence)}</p>
            </>
          )}
        </div>
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted">
            <EarOff size={13} />
            The whole window
          </h4>
          {gap === null ? (
            <p className="text-sm text-muted">The window is empty, so there is nothing to measure.</p>
          ) : (
            <>
              <p className="font-display text-2xl text-ash-dim">{formatDurationSec(gap.sec)}</p>
              <p className="mt-1 text-xs text-muted">
                {stampUtc(gap.startMs)} to {stampUtc(gap.endMs)}
                {gap.open
                  ? ', and it is still running'
                  : `, which ended ${formatAgeSec((nowMs - gap.endMs) / 1000)}`}
              </p>
              <p className="mt-2 text-xs text-muted">
                Long stretches here are normal. An empty server writes nothing, so this number mostly
                measures how quiet the week was. Read the panel on the left instead.
              </p>
            </>
          )}
        </div>
      </div>
      <p className="mt-4 flex flex-wrap items-center gap-1 border-t border-rune pt-3 text-xs text-muted">
        <span className="text-ash-dim">What neither number can do.</span> Tell quiet play from a
        producer that stopped writing. Both look identical in this table, so read these as
        description, not as a verdict, and take the verdict from the producer split above.
        <Explain entry={GLOSSARY['quiet-gap']} size="sm" />
      </p>
    </Panel>
  );
}
