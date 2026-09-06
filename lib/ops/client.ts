// The cockpit's shared read-only database client.
//
// WHY THIS EXISTS SEPARATELY FROM lib/ops/db.ts. db.ts owns loadOpsData(), the
// overview's one big fetch, and keeps its Supabase client private. The v2 tabs
// (activity, horizon, performance, insights) each need their own bounded reads
// and must not grow db.ts into a shared file four tracks edit at once. So the
// client factory lives here, on its own, and db.ts is left exactly as it is.
//
// SERVICE ROLE, SERVER ONLY, READ ONLY BY CONVENTION. The key bypasses RLS and
// must never reach the browser, which is what the 'server-only' import enforces
// at build time: importing this from a Client Component is a build error, not a
// runtime surprise. Nothing in the cockpit writes. If a future panel ever needs
// to write, it does not get to do it through this file.
//
// A CONSEQUENCE FOR TESTS: because this module imports 'server-only', it cannot
// be loaded by a .test.mjs run through tsx. That is deliberate and it is the
// reason for the layering the v2 spec insists on: pure computation lives in
// lib/ops/<tab>.ts with no imports from here, and the fetching that feeds it
// lives in the route's own data module. The math is testable; the I/O is thin
// enough to read.

import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * A service-role client, or null when the environment is not configured.
 *
 * Null rather than a throw: an unconfigured cockpit must render a page that says
 * "database unreachable" (which is the honest signal) instead of returning a 500
 * that looks like the whole dashboard is down.
 */
export function opsServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Run one read and fall back rather than throwing.
 *
 * Every panel on these pages is independent: a failed read of `voice_lines` must
 * cost that one panel its numbers, not take the page down with it. Wrap each
 * query in this and give it the empty shape the panel knows how to render.
 *
 * READ `readTracker` BELOW BEFORE RELYING ON THIS ALONE. postgrest-js resolves
 * on a query failure rather than throwing, so this catch fires for a network
 * fault and almost nothing else, and the fallback it returns is indistinguishable
 * from a table with nothing in it.
 */
export async function safeRead<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// The read tracker lives in ./read-tracker, which imports nothing, so it can be
// unit-tested: this module imports 'server-only' and a .test.mjs cannot load it.
// Re-exported here because every caller already imports from this file.
export { readTracker, type ReadTracker } from './read-tracker';
