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
import { matchPinInCaption } from '@/lib/pin-match';
import { rateLimit, ipFromRequest } from '@/lib/rate-limit';
import { safeEqual } from '@/lib/ops/auth';

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
  // `oath` only — the sworn text, forwarded verbatim from the /oath chat
  // command via the log poller.
  text?: string;
  // `chat` only — a mirrored in-game shout for the /tv chat rail.
  message?: string;
  // `pos` only — raw WORLD coordinates + biome for a live player position.
  x?: number;
  z?: number;
  biome?: string;
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
  // ---- 0. Rate limit (best-effort, per-IP) --------------------------------
  if (!rateLimit(ipFromRequest(request))) {
    return Response.json({ error: 'rate limited' }, { status: 429 });
  }

  // ---- 1. Authenticate -----------------------------------------------------
  const provided = request.headers.get('x-webhook-secret');
  const expected = process.env.WEBHOOK_SECRET;
  // Constant-time (lib/ops/auth safeEqual hashes both sides first, so it leaks
  // neither content nor length) — the same compare /api/boards, /api/ops/* and
  // the login route already use. Still fails closed when the env is unset.
  if (!expected || !provided || !safeEqual(provided, expected)) {
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
        const { data: existing, error: lookupErr } = await db
          .from('players')
          .select('id')
          .eq('character_name', name)
          .limit(1)
          .maybeSingle();
        // A failed lookup must not be read as "no such player" — that would
        // insert a DUPLICATE players row for someone who already exists.
        if (lookupErr) {
          console.error(`[webhook] sync: players lookup for "${name}" failed — ${lookupErr.message}`);
          continue;
        }
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

      // Everyone not in the online set is offline. Compute the offline set by ID
      // in JS — never interpolate a character name (client-controlled) into a
      // PostgREST filter string.
      const onlineSet = new Set(onlineNames);
      const { data: currentlyOnline } = await db
        .from('players')
        .select('id, character_name')
        .eq('is_online', true);
      const goneIds = (currentlyOnline ?? [])
        .filter((r) => !onlineSet.has(r.character_name as string))
        .map((r) => r.id as string);
      if (goneIds.length > 0) {
        await db.from('players').update({ is_online: false }).in('id', goneIds);
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

    // ---- 2c. Full stat suite (`stats`) — RETIRED, NO-OP ---------------------
    //
    // ⛔ DELIBERATELY WRITES NOTHING. This path used to upsert the ServerCharacters
    // .fch parser's numbers straight into player_stats with a plain SET — no
    // GREATEST, no world baseline. Those numbers are the character file's LIFETIME
    // totals, carried across every world and server that character has ever
    // visited, so every post OVERWROTE the server-earned values that
    // /api/gs-ingest is at pains to compute: a single stats post could replace a
    // viking's honest Eilif kills with an imported lifetime figure — or, worse,
    // silently roll every column BACKWARDS to whatever the .fch happened to say.
    //
    // Its only producer, the eilif-stats-parser.service, has been stopped and
    // permanently disabled (2026-08-23). The route stayed a loaded gun: anything
    // that could reach /api/webhook with the shared secret could still fire it.
    // So the branch is now an accepted, logged no-op — a 200 keeps any straggler
    // client from retry-storming, and the warning names the retired service so
    // a resurrected copy is obvious in the logs within one cycle.
    //
    // The stat columns this used to write are owned end-to-end by /api/gs-ingest
    // (GsValheimStatsClient snapshots, world-baselined, GREATEST-merged). Do not
    // revive this branch — reinstate the parser through /api/gs-ingest instead,
    // so it goes through lib/gs-baseline like every other writer.
    //
    // map_explored_pct is the one column with NO single owner, and retiring this
    // branch is why: /api/gs-ingest's client-map path writes it, but only for
    // players running the EilifCompanionClient plugin. Everyone else's
    // exploration % now has no writer at all — it simply stays where it was
    // (that path is GREATEST-guarded, so nothing regresses; it just stops
    // advancing). Live with it, or give the column a real server-side source —
    // do NOT bring back a lifetime-totals SET to fill the gap.
    if (type === 'stats') {
      console.warn(
        `[webhook] DEPRECATED 'stats' payload ACCEPTED AND IGNORED` +
          (characterName ? ` for "${characterName}"` : '') +
          `. Its only producer (eilif-stats-parser.service) was retired on 2026-08-23; this path wrote ` +
          `lifetime .fch profile totals into player_stats with a plain SET, destroying world-baselined, ` +
          `server-earned values. Nothing was written. If you are seeing this line, something is still ` +
          `posting type:'stats' — find it and stop it (see app/api/webhook/route.ts §2c).`
      );
      return Response.json(
        { ok: true, ignored: true, deprecated: "type:'stats' is retired — nothing was written" },
        { status: 200 }
      );
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

    // ---- 2e. In-game sworn oath (`oath`) ------------------------------------
    // Forwarded by the log poller from the Eilif companion plugin's /oath
    // command. Replace semantics: swearing again overwrites the prior oath.
    // A player never fails to be recorded — if the character name doesn't
    // match a known player we still insert it, unmatched, for a manual fix.
    if (type === 'oath') {
      const oathCharacterName = characterName;
      let oathText = typeof body.text === 'string' ? body.text.trim() : '';
      if (!oathCharacterName || !oathText) {
        return Response.json(
          { error: "'oath' requires non-empty characterName and text" },
          { status: 400 }
        );
      }

      // ---- Identity link (one-time claim code) -----------------------------
      // The FIRST whitespace-delimited token of the oath may be a one-time code
      // the Discord bot minted into identity_claims. If it matches the code
      // alphabet AND a live claim exists (unconsumed, unexpired), this is the
      // single place a code is consumed: we bind the SHOUTER's character to that
      // Discord identity and strip the code so the remainder is the real oath.
      // Fully isolated in try/catch — a linking failure must NEVER fail the oath.
      const firstToken = oathText.split(/\s+/)[0] ?? '';
      if (/^[A-HJ-NP-Z2-9]{6}$/.test(firstToken)) {
        try {
          // ATOMICALLY claim the code: a single UPDATE ... WHERE consumed_at IS
          // NULL AND expires_at > now() RETURNING is the whole check-and-consume,
          // so two simultaneous shouts of the same code can't both win — the
          // second finds it already consumed and gets no row back. (Only the
          // requester ever sees the code — it's DM'd — but this closes the
          // check-then-consume race regardless.) The reassignment below is
          // idempotent; if it ever failed mid-way the claim is spent and the
          // player just requests a fresh code.
          const nowIso = new Date().toISOString();
          const { data: claimed, error: claimErr } = await db
            .from('identity_claims')
            .update({ consumed_at: nowIso, linked_character: oathCharacterName })
            .eq('code', firstToken)
            .is('consumed_at', null)
            .gt('expires_at', nowIso)
            .select('discord_user_id, discord_username')
            .limit(1)
            .maybeSingle();
          if (claimErr) {
            // Not "no live claim" — a real failure. Log it and fall through: the
            // oath is still recorded, and the (unspent) code can be re-shouted.
            console.error(`[webhook] identity claim lookup failed — ${claimErr.message}`);
          }

          if (claimed) {
            const discordUserId = claimed.discord_user_id as string;
            const discordUsername = (claimed.discord_username as string | null) ?? null;

            // (a) Find the shouter's row FIRST, because whether we may bind at
            // all depends on what is already on it.
            const escapedShouter = oathCharacterName.replace(/[%_]/g, (c) => `\\${c}`);
            const { data: shouter, error: shouterErr } = await db
              .from('players')
              .select('id, discord_user_id')
              .ilike('character_name', escapedShouter)
              .limit(1)
              .maybeSingle();
            if (shouterErr) {
              // players_character_name_key is case-SENSITIVE, so this ilike can
              // legitimately match more than one row (and did error before the
              // .limit(1) above). Never treat a failure as "no such player" —
              // that would insert a second row for an existing character.
              console.error(`[webhook] identity link: shouter lookup failed — ${shouterErr.message}`);
              throw shouterErr; // caught below; the oath itself still records
            }

            // (a2) TAKEOVER GUARD. Valheim allows duplicate character names and
            // never verifies them, so anyone can roll a character called "Alice",
            // join, and shout their own claim code as her. This used to overwrite
            // the row's discord_user_id unconditionally — a one-shout identity
            // takeover that then pulled her stats, deaths and pins under the
            // attacker's Discord account. A character already bound to a DIFFERENT
            // Discord id is now refused; re-linking to the SAME id (a re-shout, a
            // reinstall, a fresh code) stays allowed, as does binding a character
            // nobody has claimed.
            const boundTo = (shouter?.discord_user_id as string | null) ?? null;
            if (boundTo && boundTo !== discordUserId) {
              console.warn(
                `[identity] refused relink of "${oathCharacterName}" — already linked to Discord ` +
                  `${boundTo}, claim code was minted for ${discordUserId}. An admin must release it ` +
                  `(update players set discord_user_id = null where id = '${shouter?.id}') before it can move.`,
              );
              // The claim is already consumed (that UPDATE is the atomic
              // check-and-consume), so say so plainly: the bot surfaces this
              // status to the person who asked for the code.
              return Response.json(
                {
                  ok: false,
                  linked: false,
                  status: 'character_already_linked',
                  character: oathCharacterName,
                  detail:
                    'That character is already linked to a different Discord account. An admin has to release it first.',
                },
                { status: 409 },
              );
            }

            // (b) Release this Discord id from any character it was previously on.
            await db
              .from('players')
              .update({ discord_user_id: null, discord_username: null })
              .eq('discord_user_id', discordUserId);

            // (c) Bind it to the shouter's character row (create it if missing —
            // the shouter is provably in-game right now).
            if (shouter?.id) {
              await db
                .from('players')
                .update({ discord_user_id: discordUserId, discord_username: discordUsername })
                .eq('id', shouter.id);
            } else {
              await db.from('players').insert({
                character_name: oathCharacterName,
                discord_user_id: discordUserId,
                discord_username: discordUsername,
                first_seen_at: occurredIso,
                last_seen_at: occurredIso,
                is_online: false,
              });
            }

            // (d) Strip the code token AND the separator the instructions tell
            // players to type. The bot's DM and the /oath page both read
            // "/s /oath <CODE> — your vow, one line", and stripping only the code
            // left the em dash on the front of the stored oath: Lóa's live oath
            // reads "— I SWEAR TO ALWAYS WANDER OFF" on the signature wall, in
            // the Saga episodes and in the Discord embed.
            oathText = oathText.slice(firstToken.length).replace(/^[\s\u2014\u2013\-:]+/, '').trim();
          }
        } catch (e) {
          console.error('[webhook] identity link skipped:', e instanceof Error ? e.message : 'error');
        }
      }

      // Belt and braces for the same separator problem: a player who types the
      // dash from the instructions WITHOUT a live code (already consumed, or
      // swearing again later) would otherwise store "— I SWEAR …" verbatim. The
      // character class is exactly the separators the instructions can produce —
      // an oath's real first character is never one of them.
      oathText = oathText.replace(/^[\s\u2014\u2013\-:]+/, '').trim();

      // Link-only swear: if stripping the code left no oath text, we're done.
      if (!oathText) {
        return Response.json({ ok: true, linked: true }, { status: 200 });
      }

      // Escape ilike wildcards (% _) so the character name is matched literally.
      const escapedName = oathCharacterName.replace(/[%_]/g, (c) => `\\${c}`);

      const { data: player, error: playerErr } = await db
        .from('players')
        .select('id, character_name')
        .ilike('character_name', escapedName)
        .limit(1)
        .maybeSingle();
      if (playerErr) {
        // Fall through to the unmatched path rather than losing the oath — but
        // SAY SO, because a silent failure here is indistinguishable from "we
        // have never seen this viking" and quietly files a real oath as orphaned.
        console.error(
          `[webhook] oath: players lookup for "${oathCharacterName}" failed — ${playerErr.message}. ` +
            `Recording the oath as unmatched.`,
        );
      }

      const canonicalName = (player?.character_name as string | undefined) ?? oathCharacterName;
      const playerId = (player?.id as string | undefined) ?? null;

      // Replace semantics: drop any prior oath tied to this player (or, absent
      // a player match, this same character name) before inserting the new one.
      if (playerId) {
        await db.from('oaths').delete().eq('player_id', playerId);
      } else {
        await db
          .from('oaths')
          .delete()
          .is('player_id', null)
          .ilike('character_name', canonicalName.replace(/[%_]/g, (c) => `\\${c}`));
      }

      await db.from('oaths').insert({
        character_name: canonicalName,
        player_id: playerId,
        oath_text: oathText,
        match_status: playerId ? 'exact' : 'unmatched',
        source: 'ingame',
        sworn_at: occurredIso,
      });

      return Response.json({ ok: true }, { status: 200 });
    }

    // ---- 2f. In-game pin (`pin`) ---------------------------------------------
    // Forwarded by the log poller from the Eilif companion plugin's Harmony
    // patch on Chat.OnNewChatMessage (needs the plugin — unlike /oath this
    // can't be captured mod-free, since a world position isn't in the console
    // echo). Replace semantics: re-pinning the same name (case-insensitive)
    // moves it. WORLD_RADIUS is Valheim's world size constant (10000m); the
    // orientation (which axis maps to image up/down) is a best guess pending
    // live calibration against a real pin.
    if (type === 'pin') {
      const pinCharacterName = characterName;
      const pinName = typeof metadata.name === 'string' ? metadata.name.trim() : '';
      const pinKind = metadata.kind === 'base' ? 'base' : 'poi';
      const worldX = typeof metadata.worldX === 'number' ? metadata.worldX : null;
      const worldZ = typeof metadata.worldZ === 'number' ? metadata.worldZ : null;
      if (!pinCharacterName || !pinName || worldX === null || worldZ === null) {
        return Response.json(
          { error: "'pin' requires non-empty characterName, metadata.name, metadata.worldX, metadata.worldZ" },
          { status: 400 }
        );
      }

      const WORLD_RADIUS = 10000;
      const x = Math.min(1, Math.max(0, (worldX + WORLD_RADIUS) / (2 * WORLD_RADIUS)));
      const y = Math.min(1, Math.max(0, (WORLD_RADIUS - worldZ) / (2 * WORLD_RADIUS)));

      const { data: status, error: statusErr } = await db
        .from('server_status')
        .select('world_day')
        .eq('id', 1)
        .maybeSingle();
      if (statusErr) console.error(`[webhook] pin: server_status read failed — ${statusErr.message}`);
      const day = (status?.world_day as number | undefined) ?? 1;

      await db.from('pins').delete().ilike('name', pinName.replace(/[%_]/g, (c) => `\\${c}`));
      const { data: newPin } = await db
        .from('pins')
        .insert({
          name: pinName,
          kind: pinKind,
          by_character_name: pinCharacterName,
          world_x: worldX,
          world_z: worldZ,
          x,
          y,
          day,
        })
        .select('id')
        .single();

      // ---- Retro-match (BIDIRECTIONAL): back-fill photos that named this place
      // before it was pinned. Photo-first / pin-later works because a caption
      // mentioning an unpinned place stays unlinked until the pin shows up. We
      // scan not-yet-linked photos whose caption contains the new name (narrowed
      // by ilike, then confirmed with the same word-boundary rule as the bot).
      // Best-effort + isolated: if pin_id isn't live yet, or anything fails, the
      // pin is still created — this never fails the request.
      if (newPin?.id) {
        try {
          const like = `%${pinName.replace(/[%_]/g, (c) => `\\${c}`)}%`;
          const { data: candidates } = await db
            .from('gallery_photos')
            .select('id, caption')
            .is('pin_id', null)
            .ilike('caption', like);
          const toLink = (candidates ?? [])
            .filter((p) => matchPinInCaption(p.caption as string | null, [{ id: newPin.id as string, name: pinName }]))
            .map((p) => p.id as string);
          if (toLink.length > 0) {
            await db.from('gallery_photos').update({ pin_id: newPin.id }).in('id', toLink);
          }
        } catch (e) {
          console.error('[webhook] pin retro-match skipped:', e instanceof Error ? e.message : 'error');
        }
      }

      return Response.json({ ok: true }, { status: 200 });
    }

    // ---- 2g. In-game shout mirrored to the TV chat rail (`chat`) ------------
    // Forwarded by the log poller at its single deduped Discord-mirror point
    // (only the shouts the mirror itself posts land here — never a superset).
    // Stored solely for the /tv chat rail: chat never creates a players row and
    // never enters the `events` feed. Best-effort — a bad line is a 400, not a
    // pipeline stall.
    if (type === 'chat') {
      const chatCharacterName = characterName;
      const chatMessage =
        typeof body.message === 'string' ? body.message.trim().slice(0, 300) : '';
      if (!chatCharacterName || !chatMessage) {
        return Response.json(
          { error: "'chat' requires non-empty characterName and message" },
          { status: 400 }
        );
      }

      await db.from('chat_lines').insert({
        character_name: chatCharacterName,
        message: chatMessage,
        created_at: occurredIso,
      });

      return Response.json({ ok: true }, { status: 200 });
    }

    // ---- 2h. Live player position (`pos`) -----------------------------------
    // Forwarded by the log poller from the Eilif companion plugin's [EILIF_POS]
    // line (~60s per online player). One upserted row per character carrying the
    // RAW world coordinates (no fraction conversion here — the /tv display
    // converts, replicating the pin math). DISPLAY DECREE: these render on /tv
    // only, never on the public atlas.
    if (type === 'pos') {
      const posCharacterName = characterName;
      const posX = typeof body.x === 'number' && Number.isFinite(body.x) ? body.x : null;
      const posZ = typeof body.z === 'number' && Number.isFinite(body.z) ? body.z : null;
      const posBiome =
        typeof body.biome === 'string' && body.biome.trim() ? body.biome.trim() : null;
      if (!posCharacterName || posX === null || posZ === null) {
        return Response.json(
          { error: "'pos' requires non-empty characterName and finite x, z" },
          { status: 400 }
        );
      }

      await db.from('player_positions').upsert(
        {
          character_name: posCharacterName,
          x: posX,
          z: posZ,
          biome: posBiome,
          updated_at: occurredIso,
        },
        { onConflict: 'character_name' }
      );

      return Response.json({ ok: true }, { status: 200 });
    }

    // ---- 2i. Death dedupe (defense in depth) --------------------------------
    // Two producers can both report the same death: the canonical
    // GsValheimStatsClient path (metadata.source === 'gs', carries a real
    // cause) and the legacy SFTP log-poller path (parses "ZDOID ... 0:0" log
    // lines, metadata is empty — the server log has no cause). When both are
    // live at once each death would otherwise produce two rows (and two
    // Discord posts). If a death for this character already exists within
    // +/-3 minutes of this one (either order, any metadata), treat this as
    // the same death and skip the insert + every downstream side-effect.
    if (type === 'death' && characterName) {
      const DEDUPE_WINDOW_MS = 3 * 60 * 1000;
      const lowerBound = new Date(occurredAt.getTime() - DEDUPE_WINDOW_MS).toISOString();
      const upperBound = new Date(occurredAt.getTime() + DEDUPE_WINDOW_MS).toISOString();
      const { data: dupe, error: dupeErr } = await db
        .from('events')
        .select('id')
        .eq('type', 'death')
        .eq('character_name', characterName)
        .gte('created_at', lowerBound)
        .lte('created_at', upperBound)
        .limit(1)
        .maybeSingle();
      // A failed dedupe read reads exactly like "no duplicate" and would write a
      // second death row for one death — the thing this block exists to prevent.
      if (dupeErr) console.error(`[webhook] death dedupe read failed — ${dupeErr.message}`);
      if (dupe?.id) {
        return Response.json({ ok: true, deduped: true }, { status: 200 });
      }
    }

    // ---- 2h. Replay guard for presence events -------------------------------
    // The log poller redelivers its WHOLE batch when any call in a tick fails
    // (at-least-once), so the same join/leave can arrive twice. `leave` is
    // naturally idempotent (it closes the newest open session; a second one finds
    // none) and `death` has the ±3-min dedupe above — but `join` used to insert a
    // fresh events row AND a fresh open session every time, so one retried tick
    // opened a second, never-closed session and double-counted the arrival.
    //
    // The key is exact: the poller stamps `occurredAt` from the log line itself,
    // so a replay is byte-identical to the original. A genuine re-join a second
    // later has a different timestamp and is NOT suppressed.
    //
    // Section 3 (the player's last_seen / is_online update) still runs on a
    // replay — it is idempotent, and re-asserting presence is harmless. Only the
    // APPENDING work, sections 4 and 5, is skipped.
    let isPresenceReplay = false;
    if ((type === 'join' || type === 'leave') && characterName) {
      const { data: already, error: replayErr } = await db
        .from('events')
        .select('id')
        .eq('type', type)
        .eq('character_name', characterName)
        .eq('created_at', occurredIso)
        .limit(1)
        .maybeSingle();
      if (replayErr) {
        // Unreadable → fall through and record it. A duplicated join is a smaller
        // problem than a missed one.
        console.error(`[webhook] replay check failed — ${replayErr.message}`);
      } else if (already?.id) {
        console.log(`[webhook] replay ignored ${type} ${characterName} ${occurredIso}`);
        isPresenceReplay = true;
      }
    }

    // ---- 3. Resolve / upsert the player ------------------------------------
    let playerId: string | null = null;

    if (characterName) {
      const { data: existing, error: existingErr } = await db
        .from('players')
        .select('id')
        .eq('character_name', characterName)
        .limit(1)
        .maybeSingle();
      // Never fall through to the INSERT on an error — that mints a duplicate
      // players row for a viking who already exists (and players_character_name_key
      // would then reject it, losing the event entirely).
      if (existingErr) {
        console.error(`[webhook] players lookup for "${characterName}" failed — ${existingErr.message}`);
        return Response.json({ error: 'internal_error' }, { status: 500 });
      }

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

    // A redelivered presence event stops here: the row and the session already
    // exist, and section 3 has just re-asserted the (idempotent) presence state.
    if (isPresenceReplay) {
      return Response.json({ ok: true, duplicate: true }, { status: 200 });
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
      // Second half of the replay guard. The events check above catches an exact
      // redelivery; this catches the near-miss — a retry whose timestamp shifted,
      // or a join arriving while a session for this character is still open (the
      // poller's own reconnect can produce one). Without it a replay leaves a
      // second session that never closes and inflates playtime forever.
      let openForThisJoin: { id: string; joined_at: string } | null = null;
      if (characterName || playerId) {
        let q = db.from('sessions').select('id, joined_at').is('left_at', null)
          .order('joined_at', { ascending: false })
          .limit(1);
        q = playerId ? q.eq('player_id', playerId) : q.eq('character_name', characterName);
        const { data: open, error: openErr } = await q.maybeSingle();
        if (openErr) console.error(`[webhook] join: open-session check failed — ${openErr.message}`);
        openForThisJoin = (open as { id: string; joined_at: string } | null) ?? null;
      }
      const REJOIN_GRACE_MS = 60_000;
      const openIsSameJoin =
        openForThisJoin !== null &&
        Math.abs(occurredAt.getTime() - new Date(openForThisJoin.joined_at).getTime()) <= REJOIN_GRACE_MS;

      if (openIsSameJoin) {
        console.log(`[webhook] replay ignored join session ${characterName} ${occurredIso}`);
      } else {
        await db.from('sessions').insert({
          player_id: playerId,
          character_name: characterName,
          joined_at: occurredIso,
        });
      }
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

      const { data: openSession, error: openErr } = await openQuery.maybeSingle();
      if (openErr) console.error(`[webhook] leave: open-session lookup failed — ${openErr.message}`);

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
