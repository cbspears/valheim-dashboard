// The insights strip: the paragraph on top of the overview's wall of facts.
//
// THE CONTRACT (docs/OPS-COCKPIT-V2.md §4, frozen so two tracks could build
// against it at once). The overview mounts this and plumbs nothing:
//
//     <InsightsStrip nowMs={data.nowMs} />
//
//   1. It fetches its own data. No props carry rows.
//   2. It renders its own <section>, heading and empty state. The caller wraps
//      it in nothing.
//   3. It never throws. Every read is wrapped, and a total failure renders one
//      card rather than taking the overview down with it.
//   4. It renders something for every state. Nothing worth flagging is a quiet
//      card, never null: a strip that vanishes reads as a broken strip.
//   5. It costs at most six queries in one Promise.all, inside the overview's
//      3 s budget rather than beside it.
//
// It is the ONLY export the overview may import from this folder.
//
// WHAT IS ON THE PAGE BESIDES THE CARDS, and why each line is there:
//   • "Also flagged" catches insights that fired but did not fit the card limit,
//     so raising the limit is never the difference between seeing a warning and
//     not seeing it.
//   • "Checked and not flagged" names the rules that ran on real data and came
//     back clear. That is a claim about the rules, not about the world, and it
//     is what stops a short strip from reading as an unexamined one.
//   • The footer prints how many reads were issued, how many of them RETURNED,
//     and the wall clock for them, so the strip's own cost is visible rather
//     than hidden inside the page's, and a partial read failure is visible even
//     before its card is read.

import { Sparkles } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { Explain } from '@/components/ops/Explain';
import { InsightCard } from './InsightCard';
import { loadInsights } from './loadInsights';
import {
  buildInsights,
  checksNotFlagged,
  rankInsights,
  MAX_CARDS,
  type Insight,
} from '@/lib/ops/insights';
import { BUCKET_TZ } from '@/lib/ops/window';

export interface InsightsStripProps {
  /** The page's render clock, so every panel agrees on "now". Pass data.nowMs. */
  nowMs: number;
  /** Maximum cards to render. Default 4. Values above 6 are clamped to 6. */
  limit?: number;
  /** Extra wrapper classes. The overview passes none today. */
  className?: string;
}

/** The caption for the strip itself, opened from the heading. */
const STRIP_EXPLAIN = {
  id: 'insights-strip',
  title: 'What matters right now',
  what:
    'Fourteen rules run against six bounded reads (events over 7 d, ops_heartbeats, server_status, milestones, player_stats, and players first seen this week). Each rule has a window and a numeric threshold, both printed on the card it produces. A rule whose read did not return is skipped rather than counting the empty result as a zero, and the footer says how many of the six came back.',
  why:
    'The rest of this page is a wall of true facts with no ordering. This strip reads the same data and says which of those facts is worth acting on first, so launch night starts with a sentence instead of a scan.',
  healthy:
    'One or two cards, none of them Act or Watch. A single "the last 24 h look normal" card is the quietest healthy state and carries the three numbers behind it.',
  whenRed:
    'Work top down: the cards are ordered by severity, then by how recently the evidence happened. Each card links to the tab that shows the whole picture behind it.',
  link: {
    href: 'https://github.com/cbspears/valheim-dashboard/blob/main/docs/OPS-COCKPIT-V2.md',
    label: 'Cockpit v2 plan',
  },
};

export async function InsightsStrip({ nowMs, limit = 4, className }: InsightsStripProps) {
  // Rule 3, made structural: nothing below this line may reach the overview as
  // an exception. loadInsights() already swallows per-read failures; this catches
  // anything else (a shape the pure code did not expect, say) so the worst case
  // is a strip that says it could not compute, on a page that still renders.
  let cards: Insight[] = [];
  let all: Insight[] = [];
  let clear: string[] = [];
  let ms = 0;
  let queries = 0;
  let returned = 0;
  try {
    const loaded = await loadInsights(nowMs);
    ms = loaded.ms;
    queries = loaded.queries;
    returned = loaded.returned;
    all = buildInsights(loaded.input);
    cards = rankInsights(all, limit);
    clear = checksNotFlagged(loaded.input, all);
  } catch {
    cards = [];
    all = [];
  }

  const overflow = all.filter((i) => !cards.some((c) => c.id === i.id));

  return (
    <section className={className} aria-labelledby="ops-insights-heading">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Sparkles size={18} className="text-gold" />
        <h2
          id="ops-insights-heading"
          className="font-display text-sm uppercase tracking-wide text-ash"
        >
          What matters right now
        </h2>
        <Explain entry={STRIP_EXPLAIN} size="md" />
        <span className="text-xs text-muted">
          {all.length} {all.length === 1 ? 'signal' : 'signals'}, last 24 h and last 7 d
        </span>
      </div>

      {cards.length === 0 ? (
        // Reached only if the try block threw outright. loadInsights() failing
        // its reads produces the "insights unavailable" card instead, which is a
        // different and more informative state.
        <Card>
          <CardBody className="text-sm text-ash-dim">
            The insights strip could not be computed for this render. Every other panel on this page
            is unaffected.
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {cards.map((i) => (
            <InsightCard key={i.id} insight={i} />
          ))}
        </div>
      )}

      {overflow.length > 0 && (
        <p className="mt-2.5 text-xs text-ash-dim">
          <span className="font-semibold text-muted">Also flagged: </span>
          {overflow.map((i) => i.headline).join(' ')}
        </p>
      )}

      {clear.length > 0 && (
        <p className="mt-1.5 text-xs text-muted">
          <span className="font-semibold">Checked and not flagged: </span>
          {clear.join(', ')}.
        </p>
      )}

      <p className="mt-1.5 text-xs text-muted">
        {queries === 0
          ? 'No reads were issued: the database client is not configured in this deployment.'
          : `${queries} bounded reads issued in ${Math.round(ms)} ms, ${returned} of them returned. Hour and day buckets are aligned in ${BUCKET_TZ}. At most ${MAX_CARDS} cards are ever shown.`}
      </p>
    </section>
  );
}
