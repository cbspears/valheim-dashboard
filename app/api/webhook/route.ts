// Inbound game-event webhook.
//
// This is the single ingestion point that feeds live data into Supabase. Two
// producers call it:
//   1. The Valheim "Discord Connector" mod (server-side), forwarding events
//      (join / leave / death / boss / raid / chat ...).
//   2. Our Linux SFTP log poller, which tails the server log and replays the
//      same event shape for things the mod doesn't emit, plus periodic `sync`
//      reconciliation of the live roster.
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
// not all events involve a player (e.g. a server-wide raid or a roster sync).
interface WebhookPayload {
  type: string;
  characterName?: string;
  metadata?: Record<string, unknown>;
  worldDay?: number;
  // ISO timestamp of when the event actually occurred (from the log line).
  // Lets the poller backfill accurate times instead of server-receive time.
  occurredAt?: string;
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

  // Honor an explicit event time if the producer supplies a valid ISO string;
  // otherwise stamp "now". Used for created_at, sessions, and last_seen.
  const occurredAt = (() => {
    if (typeof body.occurredAt === 'string') {
      const t = new Date(body.occurredAt);
      if (!Number.isNaN(t.getTime())) return t;
    }
    return new Date();
  })();
  const occurredIso = occurredAt.toISOString();

  try {
    const db = serviceClient();

    // ---- 2b. Roster reconciliation (`sync`) --------------------------------
    // A non-feed control message: metadata.online is the authoritative list of
    // character names currently connected. We set exactly those online and
    // everyone else offline, then refresh server_status. This self-heals the
    // "stuck online" case when a player drops without a clean leave line.
    if (type === 'sync') {
      const onlineNames = Array.isArray((metadata as Record<string, unknown>).online)
        ? ((metadata as Record<string, unknown>).online as unknown[])
            .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
            .map((n) => n.trim())
        : [];

      // Ensure each online name exists, then mark it online + seen.
      for (const name of onlineNames) {
        const { data: existing } = await db
          .from('players')
          .select('id')
          .eq('character_name', name)
          .maybeSingle();
        if (existing?.id) {
          await db
            .from('players')
            .update({ is_online: true, last_seen_at: occurredIso })
            .eq('id', existing.id);
        } else {
          await db.from('players').insert({
            character_name: name,
            first_seen_at: occurredIso,
            last_seen_at: occurredIso,
            is_online: true,
          });
        }
      }

      // Everyone not in the online set is offline.
      if (onlineNames.length > 0) {
        await db
          .from('players')
          .update({ is_online: false })
          .eq('is_online', true)
          .not('character_name', 'in', `(${onlineNames.map((n) => `"${n.replace(/"/g, '')}"`).join(',')})`);
      } else {
        await db.from('players').update({ is_online: false }).eq('is_online', true);
      }

      const statusUpdate: Record<string, unknown> = {
        updated_at: occurredIso,
        current_players: onlineNames,
        player_count: onlineNames.length,
      };
      // `serverOnline` lets the poller report host up/down explicitly.
      if (typeof (metadata as Record<string, unknown>).serverOnline === 'boolean') {
        statusUpdate.is_online = (metadata as Record<string, unknown>).serverOnline as boolean;
      } else if (onlineNames.length > 0) {
        statusUpdate.is_online = true;
      }
      if (worldDay !== undefined) statusUpdate.world_day = worldDay;

      await db.from('server_status').update(statusUpdate).eq('id', 1);
      return Response.json({ ok: true, synced: onlineNames.length }, { status: 200 });
    }

    // ---- 2c. Full stat suite (`stats`) -------------------------------------
    // Posted by the ServerCharacters .fch parser. metadata carries the parsed
    // columns; we resolve the player by character name (backfilling steam_id if
    // the filename provided one) and upsert their single player_stats row.
    if (type === 'stats') {
      if (!characterName) {
        return Response.json({ error: "'stats' requires characterName" }, { status: 400 });
      }
      const m = metadata as Record<string, unknown>;
      const num = (k: string): number => {
        const v = m[k];
        return typeof v === 'number' && Number.isFinite(v) ? v : 0;
      };
      const pct = ((): number | null => {
        const v = m.map_explored_pct;
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      })();
      const steamId = typeof m.steamId === 'string' && m.steamId.trim() ? m.steamId.trim() : null;

      // Find or create the player so stats have a row to hang off.
      const { data: existing } = await db
        .from('players')
        .select('id, steam_id')
        .eq('character_name', characterName)
        .maybeSingle();

      let playerId: string;
      if (existing?.id) {
        playerId = existing.id as string;
        if (steamId && !existing.steam_id) {
          await db.from('players').update({ steam_id: steamId }).eq('id', playerId);
        }
      } else {
        const { data: inserted } = await db
          .from('players')
          .insert({
            character_name: characterName,
            steam_id: steamId,
            first_seen_at: occurredIso,
            last_seen_at: occurredIso,
            is_online: false,
          })
          .select('id')
          .single();
        playerId = inserted!.id as string;
      }

      await db.from('player_stats').upsert(
        {
          player_id: playerId,
          kills: num('kills'),
          deaths: num('deaths'),
          resources_harvested: num('resources_harvested'),
          items_crafted: num('items_crafted'),
          distance_traveled: num('distance_traveled'),
          structures_built: num('structures_built'),
          map_explored_pct: pct,
          updated_at: occurredIso,
        },
        { onConflict: 'player_id' }
      );

      return Response.json({ ok: true, player: characterName }, { status: 200 });
    }

    // ---- 2d. Discord scheduled-events sync (`events_sync`) ------------------
    // The bot posts the guild's current scheduled events; we upsert them and
    // remove any Discord-sourced rows that have vanished. Manually-seeded demo
    // rows (discord_event_id IS NULL) are never touched here.
    if (type === 'events_sync') {
      const raw = Array.isArray((metadata as Record<string, unknown>).events)
        ? ((metadata as Record<string, unknown>).events as Array<Record<string, unknown>>)
        : [];

      const num = (v: unknown, d: number) =>
        typeof v === 'number' && Number.isFinite(v) ? v : d;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

      const events = raw.filter(
        (e) => e && typeof e.discord_event_id === 'string' && typeof e.name === 'string' && e.starts_at
      );

      for (const e of events) {
        await db.from('discord_events').upsert(
          {
            discord_event_id: e.discord_event_id as string,
            name: e.name as string,
            description: str(e.description),
            host: str(e.host),
            location: str(e.location),
            starts_at: e.starts_at as string,
            ends_at: str(e.ends_at),
            status: (str(e.status) as string) ?? 'scheduled',
            user_count: num(e.user_count, 0),
            cover_url: str(e.cover_url),
            url: str(e.url),
            recurrence: str(e.recurrence),
            recurrence_days: typeof e.recurrence_days === 'number' ? e.recurrence_days : null,
            updated_at: occurredIso,
          },
          { onConflict: 'discord_event_id' }
        );
      }

      // Drop Discord-sourced rows no longer present (leave demo rows alone).
      const ids = events.map((e) => (e.discord_event_id as string).replace(/"/g, ''));
      let del = db.from('discord_events').delete().not('discord_event_id', 'is', null);
      if (ids.length > 0) {
        del = del.not('discord_event_id', 'in', `(${ids.map((i) => `"${i}"`).join(',')})`);
      }
      await del;

      return Response.json({ ok: true, synced: events.length }, { status: 200 });
    }

    // ---- 3. Resolve / upsert the player ------------------------------------
    let playerId: string | null = null;

    if (characterName) {
      const { data: existing } = await db
        .from('players')
        .select('id')
        .eq('character_name', characterName)
        .maybeSingle();

      if (existing?.id) {
        playerId = existing.id as string;
        const update: Record<string, unknown> = { last_seen_at: occurredIso };
        if (type === 'join') update.is_online = true;
        else if (type === 'leave') update.is_online = false;
        await db.from('players').update(update).eq('id', playerId);
      } else {
        const { data: inserted } = await db
          .from('players')
          .insert({
            character_name: characterName,
            first_seen_at: occurredIso,
            last_seen_at: occurredIso,
            is_online: type === 'join',
          })
          .select('id')
          .single();
        playerId = (inserted?.id as string) ?? null;
      }
    }

    // ---- 4. Record the event ------------------------------------------------
    await db.from('events').insert({
      type,
      player_id: playerId,
      character_name: characterName,
      metadata,
      created_at: occurredIso,
    });

    // ---- 5. Maintain sessions for join / leave -----------------------------
    if (type === 'join') {
      await db.from('sessions').insert({
        player_id: playerId,
        character_name: characterName,
        joined_at: occurredIso,
      });
    } else if (type === 'leave') {
      let openQuery = db
        .from('sessions')
        .select('id, joined_at')
        .is('left_at', null)
        .order('joined_at', { ascending: false })
        .limit(1);

      openQuery = playerId
        ? openQuery.eq('player_id', playerId)
        : openQuery.eq('character_name', characterName);

      const { data: openSession } = await openQuery.maybeSingle();

      if (openSession?.id) {
        const joinedMs = new Date(openSession.joined_at as string).getTime();
        const durationMinutes = Math.max(
          0,
          Math.round((occurredAt.getTime() - joinedMs) / 60000)
        );
        await db
          .from('sessions')
          .update({ left_at: occurredIso, duration_minutes: durationMinutes })
          .eq('id', openSession.id);
      }
    }

    // ---- 6. Recompute the singleton server_status --------------------------
    const presenceChanged = type === 'join' || type === 'leave';
    if (presenceChanged || worldDay !== undefined) {
      const statusUpdate: Record<string, unknown> = { updated_at: occurredIso };

      if (presenceChanged) {
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
        if (currentPlayers.length > 0) statusUpdate.is_online = true;
      }

      if (worldDay !== undefined) statusUpdate.world_day = worldDay;

      await db.from('server_status').update(statusUpdate).eq('id', 1);
    }

    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected error';
    console.error('[webhook] failed to process event:', message);
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
