// A retrying `fetch` for every supabase-js client on the Vercel side.
//
// WHY THIS EXISTS. Supabase's REST edge (PostgREST behind Kong) kills a cold
// path's thread at exactly 5 s and answers **HTTP 504** — about 0.25 % of our
// function calls, worst on the rarely-hit endpoints, and unrelated to load.
// supabase-js treats a 504 as a perfectly valid HTTP response: it hands the
// route `{ data: null, error }` and the page renders "no data" for a request
// that was never actually refused. postgrest-js retries NETWORK errors on GET,
// but a 5xx is not a network error, so nothing retries it today. The only cure
// is a fetch that tries again — wired in at each `createClient(url, key,
// { global: { fetch } })` site.
//
// Sibling of `services/discord-bot/src/supabase.js` (`fetchWithDeadline`), and
// it inherits that file's hard-won rule: the per-attempt deadline is a manual
// AbortController, never `AbortSignal.timeout`, because the latter aborts with
// a **TimeoutError** which postgrest-js does not recognize as an abort — it
// then starts the request again with a fresh deadline each time, so a 15 s
// budget measured 67 s and four requests against a stub that never answers.

export type RetryingFetchOptions = {
  /** Extra attempts after the first. Default 2 (3 attempts total). */
  retries?: number;
  /** First backoff step; each retry triples it. Default 250 ms → 250, 750. */
  baseDelayMs?: number;
  /** Per-attempt deadline. Default 8 s (Vercel's function budget is 10 s). */
  deadlineMs?: number;
  /** Injectable for tests. Default the global fetch. */
  fetchImpl?: typeof fetch;
  /** One line per retry. Default console.warn. */
  log?: (msg: string) => void;
};

/** Gateway-shaped failures: the request never reached Postgres, or its answer never came back. */
const RETRYABLE_STATUS = new Set([502, 503, 504]);
/** The one Prefer token that makes a write idempotent: an upsert keyed on a conflict target. */
const UPSERT_PREFER = 'resolution=merge-duplicates';

function headerValue(headers: HeadersInit | null | undefined, name: string): string {
  if (!headers) return '';
  const wanted = name.toLowerCase();
  // supabase-js passes a plain object; a Request carries a Headers; callers may pass pairs.
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? '';
  if (Array.isArray(headers)) {
    return headers.filter(([k]) => k.toLowerCase() === wanted).map(([, v]) => v).join(', ');
  }
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === wanted);
  return hit ? String(hit[1]) : '';
}

/**
 * The whole retry policy, as a pure function so it is testable without a socket.
 *
 * `status` is null for a thrown error (socket reset, DNS blip, our own deadline).
 * A plain INSERT must never be retried: `events` has no conflict target, so a
 * re-sent insert whose first attempt actually landed duplicates the row.
 */
export function shouldRetry(
  method: string,
  headers: HeadersInit | null | undefined,
  status: number | null | undefined,
): boolean {
  const m = (method || 'GET').toUpperCase();
  const idempotent =
    m === 'GET' ||
    m === 'HEAD' ||
    headerValue(headers, 'prefer').toLowerCase().includes(UPSERT_PREFER);
  if (!idempotent) return false;
  if (status == null) return true;
  return RETRYABLE_STATUS.has(status);
}

function abortError(message: string): Error {
  // A real AbortError (not a TimeoutError) — see the header note.
  return typeof DOMException !== 'undefined'
    ? new DOMException(message, 'AbortError')
    : Object.assign(new Error(message), { name: 'AbortError' });
}

/** Path only — a PostgREST query string carries filter values (names, ids, tokens). */
function safePath(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw).pathname;
  } catch {
    return String(raw).split('?')[0];
  }
}

export function retryingFetch(opts: RetryingFetchOptions = {}): typeof fetch {
  const {
    retries = 2,
    baseDelayMs = 250,
    deadlineMs = 8_000,
    fetchImpl = fetch,
    log = (msg: string) => console.warn(msg),
  } = opts;

  return async function retrying(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const asRequest = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const method = (init?.method ?? asRequest?.method ?? 'GET').toUpperCase();
    const headers = init?.headers ?? asRequest?.headers;
    const callerSignal = init?.signal ?? asRequest?.signal ?? null;
    // supabase-js always sends a string body; a stream can only be read once, so
    // re-sending it would send nothing. Never retry one.
    const body = init?.body;
    const replayable = (body == null || typeof body === 'string') && asRequest?.body == null;

    for (let attempt = 1; ; attempt++) {
      if (callerSignal?.aborted) throw callerSignal.reason ?? abortError('request aborted by caller');

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(abortError(`Supabase request exceeded the ${deadlineMs} ms per-attempt deadline`)),
        deadlineMs,
      );
      const onCallerAbort = () => controller.abort(callerSignal!.reason);
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

      let res: Response | null = null;
      let err: unknown = null;
      try {
        res = await fetchImpl(input, { ...init, signal: controller.signal });
      } catch (e) {
        err = e;
      } finally {
        // Unlike the bot's single-shot fetch, the timer is cleared here: this
        // controller is per ATTEMPT, and once we have decided to KEEP a
        // response, a late deadline would abort a body we are about to parse.
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      }

      // The caller's own abort always wins — it is a decision, not a failure.
      if (callerSignal?.aborted) {
        if (err) throw err;
        return res as Response;
      }

      const status = res ? res.status : null;
      const lastAttempt = attempt > retries;
      if (lastAttempt || !replayable || !shouldRetry(method, headers, status)) {
        if (err) throw err;
        return res as Response;
      }

      const why = res ? `HTTP ${status}` : `${(err as Error)?.name ?? 'Error'}: ${(err as Error)?.message ?? String(err)}`;
      log(`[supabase-fetch] retry ${attempt}/${retries} ${method} ${safePath(input)} — ${why}`);

      // 250 ms, then 750 ms, plus ≤20 % jitter so 13 clients that all trip on
      // the same cold path do not come back in lockstep.
      const delay = baseDelayMs * 3 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay + Math.random() * delay * 0.2));
    }
  };
}
