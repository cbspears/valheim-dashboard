import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// supabase-js constructs a realtime client that needs a global WebSocket.
// Node 20 has none natively (Node 22+ does); we never use realtime, but the
// client won't construct without it — so polyfill once.
if (!globalThis.WebSocket) globalThis.WebSocket = ws;

// Read-only client (anon key, public-read RLS) used by the bot for relay/recap.
// Every Supabase call the bot makes — every postgrest read AND every storage
// upload for the gallery — goes through this fetch. Without a deadline a stalled
// TCP connection hangs the loop that owns it forever, and the ops cockpit only
// ever sees "loop never finished". 15 s is generous for a Free-plan round trip
// (the gallery uploads a WebP resized to 1600 px, a few hundred KB at most) and
// short enough that a launch-night hiccup costs one tick, not the evening.
const FETCH_TIMEOUT_MS = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS) || 15_000;

// WHY THIS IS NOT `AbortSignal.timeout` (launch-eve review, 2026-09-06).
//
// `AbortSignal.timeout()` aborts with a **TimeoutError** DOMException. The
// installed postgrest-js (2.108.2) decides whether a failed fetch may be
// retried with `fetchError?.name === 'AbortError' || fetchError?.code ===
// 'ABORT_ERR'` — and a TimeoutError is neither (its `code` is the DOMException
// legacy number 23). So the deadline did not stop the request, it started
// another one: GET is on postgrest's retryable list, DEFAULT_MAX_RETRIES is 3
// and the backoff is 1 s, 2 s, 4 s, each attempt getting a FRESH deadline.
//
// Measured against a stub server that never answers, with the deadline set to
// 1500 ms: 13,004 ms elapsed and FOUR requests reached the server. At the
// shipped 15 s that is 4 x 15 s + 7 s = 67 s for one stalled read — about four
// and a half relay ticks, not the one the comment above promises, and
// `safe('relay')` prints "previous tick still running" for every one of them.
//
// Aborting with a real AbortError makes postgrest rethrow immediately, so the
// deadline means what it says. Retries on genuine NETWORK errors (a DNS blip, a
// reset socket) are untouched and still happen — only "we already waited the
// whole budget" stops being something worth waiting for three more times.
//
// The timer is deliberately never cleared: like AbortSignal.timeout it must stay
// armed while the RESPONSE BODY streams, not just until the headers land. It is
// unref'd so a pending deadline can never hold the process open.
function deadlineError() {
  return new DOMException(
    `Supabase request exceeded the ${FETCH_TIMEOUT_MS} ms deadline (SUPABASE_FETCH_TIMEOUT_MS)`,
    'AbortError',
  );
}
// Exported only for scripts/supabase-deadline.test.mjs, which has to prove the
// abort reason is an AbortError and that a caller-supplied signal does not
// disarm the deadline. Nothing else should call it directly.
export function fetchWithDeadline(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(deadlineError()), FETCH_TIMEOUT_MS);
  timer.unref?.();

  // Compose the caller's signal by hand rather than through AbortSignal.any:
  // the old code fell back to `init.signal ?? deadline` where that helper was
  // missing, which silently DROPPED the deadline for any call that passed a
  // signal of its own. AbortController is on every Node this service supports.
  const caller = init.signal;
  if (caller) {
    if (caller.aborted) {
      clearTimeout(timer);
      return fetch(url, init);
    }
    const onAbort = () => { clearTimeout(timer); controller.abort(caller.reason); };
    caller.addEventListener('abort', onAbort, { once: true });
    return fetch(url, { ...init, signal: controller.signal }).finally(() => {
      caller.removeEventListener('abort', onAbort);
    });
  }
  return fetch(url, { ...init, signal: controller.signal });
}
const CLIENT_OPTIONS = {
  auth: { persistSession: false },
  global: { fetch: fetchWithDeadline },
};

export function readClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, CLIENT_OPTIONS);
}

// Privileged client (service role) — ONLY for scripts/mark-boss.js writes.
export function serviceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, CLIENT_OPTIONS);
}
