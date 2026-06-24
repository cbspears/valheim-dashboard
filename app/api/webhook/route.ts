// Inbound game-event webhook.
//
// This is the single ingestion point that feeds live data into Supabase. Two
// producers call it:
//   1. The Valheim "Discord Connector" mod (server-side), forwarding events
//      (join / leave / death / boss / raid / chat ...).
//   2. Our Linux SFTP log poller, which tails the server log and replays the
//      same event shape for things the mod doesn't emit.
//
// SECURITY: this handler writes with the Supabase SERVICE ROLE key, which
// bypasses Row Level Security. It is therefore guarded by a shared secret
// (`x-webhook-secret`). The service role key is NEVER returned to the caller
// and NEVER logged — only generic, caller-safe messages leave this file.

import { createClient } from '@supabase/supabase-js';

// Always run on the Node.js runtime (we need the service role key + full SDK)
// and never cache — every webhook mutates state and must execute on request.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Shape of the JSON we accept. Everything except `type` is optional because
// not all events involve a player (e.g. a server-wide raid or chat broadcast).
interface WebhookPayload {
  type: string;
  characterName?: string;
  metadata?: Record<string, unknown>;
  worldDay?: number;
}

// A privileged client bound to the service role key. Created per request so we
// never hold the key in module scope longer than necessary. `persistSession`
// is off since this is a stateless server-to-server call.
function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(request: Request) {
  // ---- 1. Authenticate -----------------------------------------------------
  // Constant work either way; a missing or mismatched secret is rejected with a
  // generic 401 so we don't hint at why it failed.
  const provided = request.headers.get('x-webhook-secret');
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected || !provided || provided !== expected) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // ---- 2. Parse + validate body -------------------------------------------
  let body: WebhookPayload;
  try {
    body = (await request.json()) as WebhookPayload;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const type = typeof body?.type === 'string' ? body.type.trim() : '';
  if (!type) {
    return Response.json(
      { error: "'type' is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  // Normalize the optional fields up front.
  const characterName =
    typeof body.characterName === 'string' && body.characterName.trim()
      ? body.characterName.trim()
      : null;
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};
  const worldDay =
    typeof body.worldDay === 'number' && Number.isFinite(body.worldDay)
      ? Math.trunc(body.worldDay)
      : undefined;

  try {
    const db = serviceClient();
    const nowIso = new Date().toISOString();

    // ---- 3. Resolve / upsert the player ------------------------------------
    // Players are keyed by character_name (the only stable identifier the mod
    // reliably gives us). We look up the existing row, then either update its
    // presence or insert a fresh one.
    let playerId: string | null = null;

    if (characterName) {
      const { data: existing } = await db
        .from('players')
        .select('id')
        .eq('character_name', characterName)
        .maybeSingle();

      if (existing?.id) {
        playerId = existing.id as string;

        // Touch last_seen on every event from this player; only join/leave
        // flips the online flag.
        const update: Record<string, unknown> = { last_seen_at: nowIso };
        if (type === 'join') update.is_online = true;
        else if (type === 'leave') update.is_online = false;

        await db.from('players').update(update).eq('id', playerId);
      } else {
        // First time we've ever seen this character — create the row.
        const { data: inserted } = await db
          .from('players')
          .insert({
            character_name: characterName,
            first_seen_at: nowIso,
            last_seen_at: nowIso,
            is_online: type === 'join',
          })
          .select('id')
          .single();

        playerId = (inserted?.id as string) ?? null;
      }
    }

    // ---- 4. Record the event ------------------------------------------------
    // The events table is the immutable activity feed that powers the dashboard.
    await db.from('events').insert({
      type,
      player_id: playerId,
      character_name: characterName,
      metadata,
      // created_at is left to the column default (now()).
    });

    // ---- 5. Maintain sessions for join / leave -----------------------------
    if (type === 'join') {
      // Open a new session for this presence.
      await db.from('sessions').insert({
        player_id: playerId,
        character_name: characterName,
        joined_at: nowIso,
      });
    } else if (type === 'leave') {
      // Close the player's most recent still-open session (left_at is null) and
      // stamp its duration in whole minutes.
      let openQuery = db
        .from('sessions')
        .select('id, joined_at')
        .is('left_at', null)
        .order('joined_at', { ascending: false })
        .limit(1);

      // Prefer matching by player_id; fall back to character_name if the player
      // row somehow didn't resolve.
      openQuery = playerId
        ? openQuery.eq('player_id', playerId)
        : openQuery.eq('character_name', characterName);

      const { data: openSession } = await openQuery.maybeSingle();

      if (openSession?.id) {
        const joinedMs = new Date(openSession.joined_at as string).getTime();
        const durationMinutes = Math.max(
          0,
          Math.round((Date.now() - joinedMs) / 60000)
        );

        await db
          .from('sessions')
          .update({ left_at: nowIso, duration_minutes: durationMinutes })
          .eq('id', openSession.id);
      }
    }

    // ---- 6. Recompute the singleton server_status --------------------------
    // We refresh the live roster on join/leave (presence changed). worldDay can
    // ride along on any event (the mod tags boss/raid events with the day), so
    // we also persist it whenever provided.
    const presenceChanged = type === 'join' || type === 'leave';
    if (presenceChanged || worldDay !== undefined) {
      const statusUpdate: Record<string, unknown> = { updated_at: nowIso };

      if (presenceChanged) {
        // Source of truth for "who's online" is the players table.
        const { data: onlineRows } = await db
          .from('players')
          .select('character_name')
          .eq('is_online', true)
          .order('character_name');

        const currentPlayers = (onlineRows ?? [])
          .map((r) => r.character_name as string)
          .filter(Boolean);

        statusUpdate.current_players = currentPlayers;
        statusUpdate.player_count = currentPlayers.length;
        // The server is definitively online while anyone is connected. With an
        // empty roster we don't force it offline (the host may still be up) —
        // preserve whatever the heartbeat last set.
        if (currentPlayers.length > 0) statusUpdate.is_online = true;
      }

      if (worldDay !== undefined) statusUpdate.world_day = worldDay;

      // server_status is a single fixed row (id = 1).
      await db.from('server_status').update(statusUpdate).eq('id', 1);
    }

    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    // Never surface the service role key, connection strings, or stack traces.
    // Log a terse message server-side and return a caller-safe error.
    const message = err instanceof Error ? err.message : 'unexpected error';
    console.error('[webhook] failed to process event:', message);
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
