import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// supabase-js constructs a realtime client that needs a global WebSocket.
// Node 20 has none natively (Node 22+ does); we never use realtime, but the
// client won't construct without it — so polyfill once.
if (!globalThis.WebSocket) globalThis.WebSocket = ws;

// Read-only client (anon key, public-read RLS) used by the bot for relay/recap.
// Every Supabase read the bot makes (relay, bosses, milestones, recap, voice)
// goes through this fetch. Without a deadline a stalled TCP connection hangs the
// loop that owns it forever, and the ops cockpit only ever sees "loop never
// finished". 15 s is generous for a Free-plan round trip and short enough that a
// launch-night hiccup costs one tick, not the evening.
const FETCH_TIMEOUT_MS = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS) || 15_000;
function fetchWithDeadline(url, init = {}) {
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = init.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([init.signal, deadline])
    : (init.signal ?? deadline);
  return fetch(url, { ...init, signal });
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
