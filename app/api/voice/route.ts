// Voice queue — polled by the Eilif companion plugin (in-game) to fetch lines
// for the bot/NPC to speak. The Discord bot (or an admin script) queues rows
// into `voice_lines`; this endpoint hands out a batch and marks them spoken.
//
// SECURITY: reads with the Supabase SERVICE ROLE key (bypasses RLS — there is
// no public-read policy on voice_lines on purpose, lines are surprise content
// until spoken). Guarded by a shared secret (`x-voice-token`).

import { createClient } from '@supabase/supabase-js';
import { safeEqual } from '@/lib/ops/auth';
import { recordRouteHeartbeat } from '@/lib/ops/route-heartbeat';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_LINES = 3;

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function GET(request: Request) {
  const provided = request.headers.get('x-voice-token');
  const expected = process.env.VOICE_API_TOKEN;
  // Constant-time compare (lib/ops/auth safeEqual), like every other secret in
  // this codebase — it hashes both sides first, so it leaks neither content nor
  // length. Fail closed when the env is unset.
  if (!expected || !provided || !safeEqual(provided, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  // The in-game half's only liveness signal. EilifCompanion cannot POST a
  // heartbeat, but an AUTHED poll proves the plugin loaded and is running — the
  // failure this catches is a Companion that silently stops loading after a game
  // update, which today shows up nowhere except queued voice lines quietly
  // expiring. Recorded only after the token check and throttled to once a minute
  // per instance (this route is polled every few seconds), and it cannot throw.
  await recordRouteHeartbeat('companion-voice');

  const db = serviceClient();

  // Claim semantics: select the oldest queued rows, then flip them to
  // 'spoken' by id. Not a single atomic statement — supabase-js has no
  // `FOR UPDATE SKIP LOCKED`, and a real claim RPC would need a migration —
  // but in practice there is exactly one poller consuming this queue, so the
  // tiny select-then-update race (another poller claiming the same rows
  // between our select and update) is an accepted risk, not a real concern.
  const { data: queued } = await db
    .from('voice_lines')
    .select('id, text, speaker')
    .eq('status', 'queued')
    .order('queued_at', { ascending: true })
    .limit(MAX_LINES);

  const rows = queued ?? [];
  if (rows.length === 0) {
    return Response.json({ lines: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const ids = rows.map((r) => r.id as string);
  await db
    .from('voice_lines')
    .update({ status: 'spoken', spoken_at: new Date().toISOString() })
    .in('id', ids);

  return Response.json(
    {
      lines: rows.map((r) => ({ id: r.id, text: r.text, speaker: r.speaker })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
