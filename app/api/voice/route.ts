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
import { companionCapabilities, voiceBatch } from '@/lib/voice';

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
  //
  // The poll doubles as the plugin's capability advertisement (2026-09-06): the
  // Companion sends `x-eilif-caps: targeting` and `x-eilif-plugin: <version>`, both
  // optional, both bounded and whitelisted by companionCapabilities() before they can
  // reach a jsonb column. An older Companion sends neither header and reports
  // `targeting: false`, which is the honest answer.
  //
  // The value is used TWICE, and only one of the two uses is load-bearing. Below, it
  // GATES delivery: a plugin that cannot address a line at one viking is not handed a
  // targeted one, because it would speak that private line to the whole hall. Here it
  // is written to the heartbeat purely so the cockpit can show which Companion is on
  // the box — that write is throttled to once a minute per instance, so what is stored
  // belongs to whichever caller won the slot and must never decide anything.
  const caps = companionCapabilities(
    request.headers.get('x-eilif-caps'),
    request.headers.get('x-eilif-plugin'),
  );
  await recordRouteHeartbeat('companion-voice', caps);

  const db = serviceClient();

  // Claim semantics: select the oldest queued rows, then flip them to
  // 'spoken' by id. Not a single atomic statement — supabase-js has no
  // `FOR UPDATE SKIP LOCKED`, and a real claim RPC would need a migration —
  // but in practice there is exactly one poller consuming this queue, so the
  // tiny select-then-update race (another poller claiming the same rows
  // between our select and update) is an accepted risk, not a real concern.
  // `meta` is selected for its optional `target` key ONLY (see lib/voice.ts). It is
  // never returned to the plugin as a whole: meta also carries bookkeeping the queue
  // writers use (`source`, `player_id`, milestone ids), and the in-game half has no
  // business seeing any of it.
  const { data: queued } = await db
    .from('voice_lines')
    .select('id, text, speaker, meta')
    .eq('status', 'queued')
    .order('queued_at', { ascending: true })
    .limit(MAX_LINES);

  const rows = queued ?? [];
  if (rows.length === 0) {
    return Response.json({ lines: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // EVERY claimed row is marked spoken, including one that is withheld below. A
  // withheld line is consumed, not re-queued: this select takes the three OLDEST queued
  // rows, so leaving targeted rows behind would park them at the head of the queue and
  // silence the hall entirely rather than lose one private line.
  const ids = rows.map((r) => r.id as string);
  await db
    .from('voice_lines')
    .update({ status: 'spoken', spoken_at: new Date().toISOString() })
    .in('id', ids);

  const batch = voiceBatch(
    rows.map((r) => ({
      id: r.id as string,
      text: r.text as string,
      speaker: r.speaker as string,
      meta: r.meta,
    })),
    caps,
  );

  // Vercel's runtime log is the only place this is visible, and it is worth a line: a
  // steady stream of these means somebody turned VOICE_TARGETING on in the bot while
  // the box still runs a Companion that cannot target. The line's TEXT is never logged
  // (it is surprise content, and the recipient's name is enough to act on).
  //
  // Control characters are flattened first, for the same reason SpeakerIdentity.Safe does
  // it in the plugin: a character name is attacker-writable at the Valheim handshake and
  // this log is read line by line, so a name carrying a newline could otherwise forge a
  // second log line. `meta.target` is already length-bounded to 64 by voiceTarget().
  for (const w of batch.withheld) {
    const name = w.target.replace(/[\u0000-\u001f\u007f]/g, ' ');
    console.warn(
      `[voice] withheld targeted line ${w.id} for "${name}": the polling Companion ` +
        `${caps.plugin ? `(${caps.plugin}) ` : ''}did not advertise targeting, and a targeted ` +
        `line must never be broadcast. Deploy Companion 0.3.3+ or unset VOICE_TARGETING in the bot.`,
    );
  }

  return Response.json({ lines: batch.lines }, { headers: { 'Cache-Control': 'no-store' } });
}
