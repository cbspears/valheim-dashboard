// The overview's headline verdict, PURE (reports + findings in, one sentence out).
//
// WHY IT EXISTS. /admin/ops answers "what is the state of every moving part" in
// about forty numbers, and on launch night the question is not any of those
// forty. It is "do I need to do something right now". That answer was only ever
// derivable by reading the whole page, which is the opposite of what an ops page
// is for. This computes it from what the page already has: the component reports
// from lib/ops/health.ts and the findings from lib/ops/consistency.ts. It adds
// no queries and reads nothing.
//
// THE ONE RULE IT INHERITS: never green on absence. An unknown component is not
// evidence of health, so a roster carrying unknowns can never reach 'clear'. It
// lands on 'watch', which says out loud that something is unproven rather than
// fine. That is the same discipline computeState() applies one level down.
//
// PURE and dependency-free apart from the two type imports, so it unit-tests
// without a database: lib/ops/overview.test.mjs.

import { STATE_RANK, type ComponentReport, type HealthState } from './health';
import type { Finding, Severity } from './consistency';

/**
 * Four levels, worst last. They are deliberately not the same words as the
 * component states: this is about what the operator should do, not about what
 * one component is doing.
 *
 *   clear      nothing is wrong and nothing is unproven.
 *   watch      nothing is broken, but something is unknown, noted as info, or
 *              has not reported at all. Not proven fine, which is the point.
 *   attention  a warning-level check has fired. It will matter, it is not on fire.
 *   incident   a component is stale or degraded, or a critical check has fired.
 *              The headline still separates the two: stale means silent, and
 *              degraded means it reported inside its window WITH an error, so
 *              it is a process that is up and failing rather than one that is
 *              down. Telling an operator a running process "is not running"
 *              sends them to look for a dead thing that is alive.
 */
export type OpsVerdictLevel = 'clear' | 'watch' | 'attention' | 'incident';

export interface OpsVerdict {
  level: OpsVerdictLevel;
  /** Three or four words. The answer to "is everything fine". */
  headline: string;
  /** One line of evidence, with counts. The page appends the read time. */
  detail: string;
  /** How many components are in each state right now. */
  counts: Record<HealthState, number>;
  /** Total components in the roster, including the bot loops. */
  total: number;
  /** Worst component state present, by STATE_RANK. */
  worstState: HealthState;
  /** Keys that are stale or degraded, worst first then alphabetical. */
  brokenKeys: string[];
  /** Keys that are unknown, alphabetical. Reported, never counted as broken. */
  unknownKeys: string[];
  /** Open findings by severity, and the total. */
  findings: Record<Severity, number>;
  openFindings: number;
}

const EMPTY_COUNTS: Record<HealthState, number> = {
  healthy: 0,
  degraded: 0,
  stale: 0,
  disabled: 0,
  unknown: 0,
};

/** English list: "a", "a and b", "a, b and c", "a, b and 2 more". */
export function joinNames(names: string[], max = 3): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  const head = names.slice(0, max);
  const rest = names.length - head.length;
  if (rest > 0) return `${head.join(', ')} and ${rest} more`;
  return `${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`;
}

/** "1 check" / "3 checks". Small enough to inline, used four times. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Reduce the whole page to one verdict.
 *
 * Ordering of the rules is the whole design, so it is written out rather than
 * nested: a critical check and a stale component are the same level, because
 * both mean a pipeline is not running and neither can be left until morning.
 */
export function summarizeOps(input: {
  reports: ComponentReport[];
  findings: Finding[];
}): OpsVerdict {
  const { reports, findings } = input;

  const counts: Record<HealthState, number> = { ...EMPTY_COUNTS };
  for (const r of reports) counts[r.state] += 1;

  const worstState = reports.reduce<HealthState>(
    (worst, r) => (STATE_RANK[r.state] > STATE_RANK[worst] ? r.state : worst),
    'healthy',
  );

  const staleOnly = reports.filter((r) => r.state === 'stale');
  const broken = reports
    .filter((r) => r.state === 'stale' || r.state === 'degraded')
    .sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || a.label.localeCompare(b.label));
  const brokenKeys = broken.map((r) => r.label);
  const unknownKeys = reports
    .filter((r) => r.state === 'unknown')
    .map((r) => r.label)
    .sort((a, b) => a.localeCompare(b));

  const fCounts: Record<Severity, number> = { critical: 0, warn: 0, info: 0 };
  for (const f of findings) fCounts[f.severity] += 1;
  const openFindings = findings.length;

  // An empty roster is the same class of fact as an unknown component: nothing
  // reported, so nothing is proven. It cannot reach 'clear' either.
  const emptyRoster = reports.length === 0;

  // ── Level ────────────────────────────────────────────────────────────────
  let level: OpsVerdictLevel;
  if (fCounts.critical > 0 || broken.length > 0) level = 'incident';
  else if (fCounts.warn > 0) level = 'attention';
  else if (fCounts.info > 0 || counts.unknown > 0 || emptyRoster) level = 'watch';
  else level = 'clear';

  // ── Headline ─────────────────────────────────────────────────────────────
  const headline =
    level === 'incident'
      ? staleOnly.length > 0
        ? 'Something is not running'
        : broken.length > 0
          ? 'Something is running and failing'
          : 'Something is broken in the data'
      : level === 'attention'
        ? 'Something needs a look'
        : level === 'watch'
          ? emptyRoster
            ? 'Nothing is reporting'
            : 'Running, with things to note'
          : 'All clear';

  // ── Detail: counts first, because they are the evidence ──────────────────
  const parts: string[] = [];
  parts.push(
    emptyRoster
      ? 'No components in the roster at all, so nothing on this page is evidence of health'
      : `${counts.healthy} of ${reports.length} components healthy right now`,
  );
  if (broken.length > 0) {
    const stale = staleOnly.length;
    const degraded = broken.length - stale;
    const words: string[] = [];
    if (stale > 0) words.push(`${stale} stale`);
    if (degraded > 0) words.push(`${degraded} degraded`);
    parts.push(`${words.join(', ')} (${joinNames(brokenKeys)})`);
  }
  if (counts.unknown > 0) {
    parts.push(`${counts.unknown} unknown (${joinNames(unknownKeys)}), which is not the same as healthy`);
  }
  if (counts.disabled > 0) parts.push(`${counts.disabled} switched off on purpose`);

  const findingWords: string[] = [];
  if (fCounts.critical > 0) findingWords.push(`${fCounts.critical} critical`);
  if (fCounts.warn > 0) findingWords.push(`${fCounts.warn} warning`);
  if (fCounts.info > 0) findingWords.push(`${fCounts.info} info`);
  parts.push(
    openFindings === 0
      ? 'No consistency checks open'
      : `${plural(openFindings, 'check')} open (${findingWords.join(', ')})`,
  );

  return {
    level,
    headline,
    detail: `${parts.join('. ')}.`,
    counts,
    total: reports.length,
    worstState,
    brokenKeys,
    unknownKeys,
    findings: fCounts,
    openFindings,
  };
}
