import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// supabase-js constructs a realtime client that needs a global WebSocket.
// Node 20 has none natively (Node 22+ does); we never use realtime, but the
// client won't construct without it — so polyfill once.
if (!globalThis.WebSocket) globalThis.WebSocket = ws;

// Read-only client (anon key, public-read RLS) used by the bot for relay/recap.
export function readClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
}

// Privileged client (service role) — ONLY for scripts/mark-boss.js writes.
export function serviceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}
