import { createClient } from '@supabase/supabase-js';

// GsValheimStats ingest (v0) — the server-side Emitter POSTs here every ~120s
// (instantly on join/leave): { schemaVersion: 1, game: 'valheim', source: 'server',
// onlinePlayers, worldDay, milestones, ... }. This v0 consumes the presence +
// world-day facts (the authoritative "who is on, what day is it") and accepts
// client payloads with a 200 so the mod never retries (per-player stats land
// in a later iteration).
//
// Auth (v0): the Emitter's Token is currently blank on the server (config only
// reloads at restart). If an Authorization header IS sent it must match
// VOICE_API_TOKEN; hardening to REQUIRED happens at the next server restart.

export const dynamic = 'force-dynamic';

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/** onlinePlayers arrives as string[] | {name}[] | number — normalize defensively. */
function parseOnline(v: unknown): { names: string[] | null; count: number | null } {
  if (Array.isArray(v)) {
    const names = v
      .map((x) => (typeof x === 'string' ? x : (x as { name?: unknown })?.name))
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    return { names, count: names.length };
  }
  if (typeof v === 'number' && Number.isFinite(v)) return { names: null, count: v };
  return { names: null, count: null };
}

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!process.env.VOICE_API_TOKEN || token !== process.env.VOICE_API_TOKEN) {
      return Response.json({ error: 'bad token' }, { status: 401 });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }
  if (body?.schemaVersion !== 1 || body?.game !== 'valheim') {
    return Response.json({ error: 'unexpected payload' }, { status: 400 });
  }

  // Client payloads (per-player stats): acknowledged, consumed in a later pass.
  if (body.source !== 'server') return Response.json({ status: 'inserted' });

  const client = db();
  const now = new Date().toISOString();
  const { names, count } = parseOnline(body.onlinePlayers);
  const worldDay = typeof body.worldDay === 'number' ? Math.floor(body.worldDay) : undefined;

  if (names) {
    // The Emitter's roster is the truth: flip everyone else off, listed on.
    await client.from('players').update({ is_online: false }).eq('is_online', true)
      .not('character_name', 'in', `(${names.map((n) => `"${n.replace(/"/g, '')}"`).join(',') || '""'})`);
    if (names.length > 0) {
      await client.from('players').update({ is_online: true, last_seen_at: now })
        .in('character_name', names);
    }
  }

  const statusUpdate: Record<string, unknown> = { is_online: true, updated_at: now };
  if (names) { statusUpdate.current_players = names; statusUpdate.player_count = names.length; }
  else if (count !== null) statusUpdate.player_count = count;
  if (worldDay !== undefined) statusUpdate.world_day = worldDay;
  await client.from('server_status').update(statusUpdate).eq('id', 1);

  return Response.json({ status: 'inserted' });
}
