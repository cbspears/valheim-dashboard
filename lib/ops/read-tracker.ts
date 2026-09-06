// Which of a page's reads did not come back, by name.
//
// NO IMPORTS, ON PURPOSE. It is re-exported from ./client, which every cockpit
// data module already imports, but it lives here because ./client imports
// 'server-only' and a .test.mjs run through tsx cannot load that. The layering
// rule the v2 spec insists on applies to this file as much as to a percentile:
// pure computation is testable, I/O is thin enough to read.
//
/**
 * Which of a page's reads did not come back, by name.
 *
 * THE BUG THIS EXISTS FOR, which cost the v2 build a high-severity finding on
 * one tab and shipped silently on two others. `await client.from('events')...`
 * RESOLVES when PostgREST refuses the query: a revoked grant, a renamed column,
 * a statement timeout and a 5xx all come back as `{ data: null, error }` and
 * throw nothing. So `safeRead(fn, [])` returns `[]`, `data ?? []` returns `[]`,
 * and a page built on those arrays says "nothing fired in the last 24 h" over a
 * database holding six hundred rows it could not see. On launch night that is
 * the difference between "the hall is quiet" and "the cockpit is blind", and
 * the two look identical.
 *
 * A read is only honest if it can say "I could not read". This is the smallest
 * thing that lets a page say it: each read names itself and reports its `error`,
 * the page prints the names of everything that failed, and the arrays stay the
 * shape every panel already knows how to render, so nothing downstream changes.
 *
 * Two ways in, both needed, because a read can fail in two ways:
 *   • `read(name, fn, fallback)` replaces `safeRead` and catches a real throw.
 *   • `noteError(name, error)` is called inside the read with PostgREST's own
 *     error, which is the case that never throws.
 *
 * Names are for the operator, so they are table names, not variable names.
 */
export interface ReadTracker {
  /** Names of the reads that did not return their rows. Empty is healthy. */
  readonly failed: string[];
  /** Run a named read, recording it as failed if it throws. */
  read<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T>;
  /** Record a named read as failed when PostgREST hands back an error. */
  noteError(name: string, error: unknown): void;
}

export function readTracker(): ReadTracker {
  const failed: string[] = [];
  const mark = (name: string) => {
    if (!failed.includes(name)) failed.push(name);
  };
  return {
    failed,
    async read<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
      try {
        return await fn();
      } catch {
        mark(name);
        return fallback;
      }
    },
    noteError(name: string, error: unknown): void {
      if (error) mark(name);
    },
  };
}
