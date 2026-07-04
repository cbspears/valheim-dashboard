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

/**
 * Clean GsValheimStats' raw `killer` into a cause string. Creature killers arrive
 * as readable names ("Deathsquito") or localization tokens ("$enemy_greydwarf")
 * or clones ("Greydwarf(Clone)"); environmental killers as bare hit-type words
 * ("tree", "fall", "drowning"). We ONLY strip token noise here and pass the value
 * through — all saga phrasing lives in the frontend (lib/episodes.ts phraseDeath /
 * ENV_DEATHS, looked up case-insensitively), so this stays the single cleaning
 * point, not a second place that flavors death text.
 */
function humanizeKiller(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let k = raw.trim();
  if (!k) return null;
  k = k.replace(/\(Clone\)\s*$/i, '').trim();
  k = k.replace(/^\$(?:enemy|item|character)_/i, '').replace(/^\$/, '').trim();
  return k || null;
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

/**
 * Ingest GsValheimStatsClient `deathEvents[]` into the `events` table as `death`
 * rows carrying the REAL cause. The snapshot is cumulative and re-POSTed every
 * ~120s, so each death is deduped on (playerName + tsUtc) — a natural unique key
 * (a player can't die twice in the same instant) — stored as `metadata.gsDeathId`.
 */
async function ingestDeathEvents(rawEvents: unknown): Promise<void> {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) return;

  // Normalize + drop anything without the two fields we key on.
  const parsed = rawEvents
    .map((e) => {
      const d = e as Record<string, unknown>;
      const name = typeof d.playerName === 'string' ? d.playerName.trim() : '';
      const tsUtc = typeof d.tsUtc === 'string' ? d.tsUtc : '';
      if (!name || !tsUtc || Number.isNaN(Date.parse(tsUtc))) return null;
      const metadata: Record<string, unknown> = {
        gsDeathId: `${name}|${tsUtc}`,
        source: 'gs',
      };
      const cause = humanizeKiller(d.killer);
      if (cause) metadata.cause = cause;
      if (typeof d.killer === 'string' && d.killer.trim()) metadata.killer = d.killer.trim();
      if (typeof d.biome === 'string' && d.biome.trim()) metadata.biome = d.biome.trim();
      if (typeof d.lifeSec === 'number' && Number.isFinite(d.lifeSec)) metadata.lifeSec = Math.round(d.lifeSec);
      if (typeof d.killsThisLife === 'number' && Number.isFinite(d.killsThisLife)) {
        metadata.killsThisLife = Math.round(d.killsThisLife);
      }
      return { name, occurredIso: new Date(tsUtc).toISOString(), key: `${name}|${tsUtc}`, metadata };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (parsed.length === 0) return;

  const client = db();
  const keys = [...new Set(parsed.map((p) => p.key))];

  // Which of these deaths do we already have? (dedupe against prior snapshots)
  const { data: existing } = await client
    .from('events')
    .select('metadata')
    .eq('type', 'death')
    .in('metadata->>gsDeathId', keys);
  const seen = new Set(
    (existing ?? []).map((r) => (r.metadata as Record<string, unknown>)?.gsDeathId as string),
  );

  // Also collapse duplicates within this single payload.
  const fresh: typeof parsed = [];
  const localSeen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(p.key) || localSeen.has(p.key)) continue;
    localSeen.add(p.key);
    fresh.push(p);
  }
  if (fresh.length === 0) return;

  // Resolve (or create) a players row per name, mirroring the webhook.
  const names = [...new Set(fresh.map((p) => p.name))];
  const { data: players } = await client.from('players').select('id, character_name').in('character_name', names);
  const idByName = new Map<string, string>((players ?? []).map((p) => [p.character_name as string, p.id as string]));
  for (const name of names) {
    if (idByName.has(name)) continue;
    const first = fresh.find((p) => p.name === name)!;
    const { data: ins } = await client
      .from('players')
      .insert({ character_name: name, first_seen_at: first.occurredIso, last_seen_at: first.occurredIso, is_online: false })
      .select('id')
      .single();
    if (ins?.id) idByName.set(name, ins.id as string);
  }

  await client.from('events').insert(
    fresh.map((p) => ({
      type: 'death',
      player_id: idByName.get(p.name) ?? null,
      character_name: p.name,
      metadata: p.metadata,
      created_at: p.occurredIso,
    })),
  );
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

  // Client payloads (per-player stats): we consume `deathEvents` (real cause of
  // death — the thing only the client knows) and ack the rest. Everything else
  // (kills/skills/materials leaderboards) lands in a later pass.
  if (body.source !== 'server') {
    await ingestDeathEvents(body.deathEvents);
    return Response.json({ status: 'inserted' });
  }

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
