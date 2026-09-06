// What the boss ledger actually says, as plain values a page can render without
// having to decide what an EMPTY read means.
//
// THE BUG THIS EXISTS TO PREVENT (T-3 audit, site-2). The Hall used to derive its
// headline from `bosses.find((b) => !b.is_killed) ?? null` alone: no unfelled boss
// meant "the saga is complete". `getBosses()` swallows a failed read and returns
// `[]`, so a Supabase outage — or a permission change like the one that already
// makes `players?select=*` return 42501 for anon — rendered "The saga is complete.
// Every forsaken one has fallen." next to "Felled so far: None yet." on a page that
// returned HTTP 200.
//
// An empty array is NOT a finished season. It is "the ledger did not answer", and
// it is also the honest state of a freshly wiped world before the reset rows land.
// Completion is claimable only when there are rows AND every one of them is killed.

import type { Boss } from './types';

export interface BossProgress {
  /** Rows the ledger actually returned. 0 = it did not answer (or is unmigrated). */
  total: number;
  /** The felled ones, in ledger order. */
  felled: Boss[];
  felledCount: number;
  /** The first unfelled Forsaken — the current objective — or null when none can be named. */
  next: Boss | null;
  /** TRUE only when the ledger was read AND every row in it is killed. */
  sagaComplete: boolean;
  /** TRUE when the read came back empty: neither an objective nor a victory may be claimed. */
  ledgerEmpty: boolean;
  /** Percentage felled, 0 when the ledger is empty (never a divide by zero). */
  percent: number;
}

/** Reduce the boss rows to what a page renders. Safe on null/undefined/[]. */
export function summarizeBosses(bosses: Boss[] | null | undefined): BossProgress {
  const rows = Array.isArray(bosses) ? bosses : [];
  const total = rows.length;
  const felled = rows.filter((b) => b.is_killed);
  const next = rows.find((b) => !b.is_killed) ?? null;
  return {
    total,
    felled,
    felledCount: felled.length,
    next,
    // Both halves are load-bearing: rows exist, and none of them is still standing.
    sagaComplete: total > 0 && next === null,
    ledgerEmpty: total === 0,
    percent: total > 0 ? Math.round((felled.length / total) * 100) : 0,
  };
}
