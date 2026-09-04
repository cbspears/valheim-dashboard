// Death-event ingestion for /api/gs-ingest — every producer, one file.
//
// THREE producers can report the same death, in any order:
//
//   1. the SFTP log poller (→ /api/webhook)  — knows only THAT someone died.
//      `events.metadata` is empty: no source, no cause. The server log line
//      ("ZDOID … 0:0") carries no cause at all.
//   2. GsValheimStatsClient's `deathEvents[]` (source:'client', this file's
//      ingestDeathEvents) — carries a `killer`, but the third-party mod reports
//      an UNATTRIBUTED damage-over-time death (campfire burning, freezing,
//      drowning) as the bare catch-all "enemyhit": the real cause is destroyed
//      at its source, before we ever see it.
//   3. OUR OWN plugin, EilifCompanionClient ≥0.2.0 (source:'eilif-death',
//      ingestEilifDeath) — Harmony-patches the LOCAL player's Player.OnDeath and
//      reads `Character.m_lastHit` directly, so it reports the exact
//      `HitData.HitType` word plus the attacker (when there is one). This is the
//      ONLY producer that can tell fire from freezing from an unseen foe.
//
// PRECEDENCE: eilif > gs > poller. Whoever writes the row first, the cause on
// the surviving row is the most authoritative one available, and there is
// always EXACTLY ONE row per death:
//
//   • poller row already there  → the eilif report UPGRADES it in place.
//   • gs row already there      → the eilif report UPGRADES its cause in place.
//   • eilif row already there   → a later gs death in the window is DROPPED.
//   • nothing there             → the eilif report inserts a fresh row.
//   • a later POLLER row        → already dropped upstream by /api/webhook's own
//     ±3-min death dedupe, so it never reaches this file.
//
// The ±3-minute window is the same one /api/webhook and the gs path already use.
//
// This module touches ONLY the `events` table. Death COUNTS for the collective
// deeds come from player_stats.deaths (lib/milestones deaths_total), which
// nothing here writes; the events rows feed "How We Die", the Saga and the
// per-viking death log, all of which read one row per death.

import type { SupabaseClient } from '@supabase/supabase-js';
import { CREATURES, capitalizeCreature } from '@/config/creatures';
import { sanitizeClientText, CLIENT_TEXT_MAX } from './gs-client';

/** ±3 min — the same death-dedupe window /api/webhook and the gs path use. */
export const DEDUPE_WINDOW_MS = 3 * 60_000;

/** Marker on `events.metadata` meaning "the cause on this row came from our
 *  own client plugin and must not be overwritten or double-counted." */
export const EILIF_CAUSE_SOURCE = 'eilif';

/**
 * Every value of Valheim's `HitData.HitType` enum, verbatim and in declaration
 * order — decompiled from `libs/assembly_valheim.dll` (game 0.221.12) with
 * ilspycmd; see `HitData.HitType : byte`. The plugin sends the enum NAME, so
 * this is the allowlist: a word that is not here is not a HitType we know, and
 * `parseEilifDeath` fails safe on it rather than letting an unmapped token
 * reach a rendering surface.
 *
 * Every entry must have a phrase in lib/episodes.ts ENV_DEATHS + ENV_DESC —
 * scripts/eilif-death.test.mjs asserts exactly that, so adding a value here
 * without adding its phrasing fails the test suite rather than shipping a raw
 * token to the Saga.
 */
export const HIT_TYPES = [
  'Undefined',
  'EnemyHit',
  'PlayerHit',
  'Fall',
  'Drowning',
  'Burning',
  'Freezing',
  'Poisoned',
  'Water',
  'Smoke',
  'EdgeOfWorld',
  'Impact',
  'Cart',
  'Tree',
  'Self',
  'Structural',
  'Turret',
  'Boat',
  'Stalagtite',
  'Catapult',
  'CinderFire',
  'AshlandsOcean',
] as const;

export type HitType = (typeof HIT_TYPES)[number];

const HIT_TYPE_BY_LOWER = new Map<string, HitType>(HIT_TYPES.map((h) => [h.toLowerCase(), h]));

/** Canonical HitType spelling for a case-insensitive word, or null if unknown. */
export function normalizeHitType(raw: unknown): HitType | null {
  if (typeof raw !== 'string') return null;
  return HIT_TYPE_BY_LOWER.get(raw.trim().toLowerCase()) ?? null;
}

/**
 * Clean a raw killer into a display cause.
 *
 * Creature killers arrive in three spellings — a localization token
 * ("$enemy_serpent", which is literally what `Character.m_name` holds), a prefab
 * clone name ("Greydwarf(Clone)"), or an already-readable name ("Deathsquito").
 * We strip the token/clone noise and then look the remainder up in
 * config/creatures.ts so all three land on ONE display name ("Serpent" — the
 * bucket config/creatures.ts maps the token to; HowWeDie.tsx renders it as
 * "The Sea Serpent" in the UI).
 *
 * An unmapped creature is never dropped and never rendered raw: a `$token`
 * input falls back to its capitalized stripped form, and a plain readable name
 * passes through with the producer's own casing preserved (GsValheimStatsClient
 * sends Title Case, e.g. "Neck").
 *
 * All saga PHRASING still lives in lib/episodes.ts (phraseDeath / ENV_DEATHS,
 * looked up case-insensitively) — this stays the single cleaning point, not a
 * second place that flavors death text.
 */
export function humanizeKiller(raw: unknown): string | null {
  // Attacker-controlled input (client payloads carry no token), and this string
  // ends up in a Discord message, an in-game voice line and the Saga — so it is
  // stripped of rich-text tags + control characters and capped at 48 chars
  // BEFORE any of the creature mapping below. See sanitizeClientText.
  const trimmed = sanitizeClientText(raw);
  if (!trimmed) return null;
  const wasToken = trimmed.startsWith('$');

  let k = trimmed.replace(/\(Clone\)\s*$/i, '').trim();
  k = k.replace(/^\$(?:enemy|item|character)_/i, '').replace(/^\$/, '').trim();
  if (!k) return null;

  // hasOwnProperty, not a bare index: a creature token that happens to spell an
  // Object.prototype member ("constructor", "toString") would otherwise resolve
  // to an inherited function and be returned as if it were a display name.
  const key = k.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CREATURES, key)) return CREATURES[key];
  // A token had no readable casing to preserve, so give it some; a name that
  // arrived readable keeps exactly the casing its producer chose.
  return wasToken ? capitalizeCreature(k) : k;
}

/**
 * The cause string for one eilif death report.
 *
 * • A named attacker wins — that is the whole point of the plugin ("taken by a
 *   Serpent" beats "struck down by an unseen foe").
 * • PlayerHit with a named attacker becomes "the hand of <Name>": phraseDeath()
 *   routes any cause starting with "the " through its `felled by …` branch, so
 *   this reads "Sven was felled by the hand of Bjorn" instead of the nonsense
 *   "Sven was taken by a Bjorn" a bare player name would produce.
 * • With no attacker, the cause is the lowercased HitType word — the vocabulary
 *   lib/episodes.ts ENV_DEATHS already speaks ("burning" → "lost to the
 *   flames", "freezing" → "frozen in the cold").
 */
export function eilifCause(hitType: HitType, attacker: string | null): string {
  if (attacker) {
    const named = hitType === 'PlayerHit' ? `the hand of ${attacker}` : attacker;
    // The attacker is already capped at 48 by humanizeKiller; the "the hand of "
    // prefix would push it past that, so cap the finished cause too. hitType is
    // not capped because it cannot be long — it comes from the HIT_TYPES
    // allowlist, so an unknown word never reaches here at all.
    return named.length > CLIENT_TEXT_MAX ? named.slice(0, CLIENT_TEXT_MAX).trim() : named;
  }
  return hitType.toLowerCase();
}

export type ParsedEilifDeath = {
  player: string;
  occurredIso: string;
  /** Natural unique key: a player cannot die twice in the same instant. */
  key: string;
  hitType: HitType;
  attacker: string | null;
  biome: string | null;
  cause: string;
  metadata: Record<string, unknown>;
};

/**
 * Validate + normalize one `source:'eilif-death'` payload. Returns null (and the
 * caller ignores the post) when anything load-bearing is missing or unknown —
 * an unrecognized HitType from a future game version must fail safe rather than
 * write a row whose cause would render as a raw token, and must NOT claim the
 * eilif precedence that would then suppress the gs report.
 */
export function parseEilifDeath(body: Record<string, unknown>): ParsedEilifDeath | null {
  const player = typeof body.player === 'string' ? body.player.trim() : '';
  if (!player) return null;

  const tsUtc = typeof body.tsUtc === 'string' ? body.tsUtc.trim() : '';
  if (!tsUtc || Number.isNaN(Date.parse(tsUtc))) return null;

  const hitType = normalizeHitType(body.hitType);
  if (!hitType) return null;

  const attacker = humanizeKiller(body.attacker);
  // Same treatment as the attacker: capped, tag-stripped, control-char-free.
  const biome = sanitizeClientText(body.biome);
  const cause = eilifCause(hitType, attacker);

  const metadata: Record<string, unknown> = {
    eilifDeathId: `${player}|${tsUtc}`,
    source: EILIF_CAUSE_SOURCE,
    causeSource: EILIF_CAUSE_SOURCE,
    cause,
    hitType,
  };
  if (attacker) metadata.attacker = attacker;
  if (biome) metadata.biome = biome;

  const pos = body.pos as Record<string, unknown> | undefined;
  if (pos && typeof pos === 'object') {
    const x = pos.x;
    const z = pos.z;
    if (typeof x === 'number' && Number.isFinite(x) && typeof z === 'number' && Number.isFinite(z)) {
      metadata.pos = { x: Math.round(x), z: Math.round(z) };
    }
  }

  return {
    player,
    occurredIso: new Date(tsUtc).toISOString(),
    key: `${player}|${tsUtc}`,
    hitType,
    attacker,
    biome,
    cause,
    metadata,
  };
}

/** The cause fields an eilif report stamps onto an existing (gs / poller) row. */
function eilifCausePatch(p: ParsedEilifDeath, existing: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    eilifDeathId: p.key,
    causeSource: EILIF_CAUSE_SOURCE,
    cause: p.cause,
    hitType: p.hitType,
  };
  if (p.attacker) next.attacker = p.attacker;
  // Only fill a biome we actually have — never blank one the other producer knew.
  if (p.biome) next.biome = p.biome;
  // `source` deliberately keeps whoever CREATED the row (or stays absent for a
  // poller row); `causeSource` is what says where the cause came from.
  return next;
}

export type EilifDeathResult = {
  ok: boolean;
  status: 'inserted' | 'upgraded' | 'duplicate' | 'ignored';
  reason?: string;
  cause?: string;
};

// ── The atomic write (db/2026-09-04_ingest_death.sql) ────────────────────────
//
// THE RACE THIS CLOSES. Every launch player runs BOTH producers, and both
// Harmony-patch Player.OnDeath and POST immediately — so the two reports for one
// death arrive within the ~100-400 ms each handler spends between its dedupe
// SELECT and its INSERT. Both read "nothing nearby", both insert, and the death
// is counted twice everywhere rows are counted (#server relay, How We Die, the
// Saga, the per-viking log, the recap's "most deaths" award). Observed live: 4
// of 10 dual-producer deaths in the pilot duplicated.
//
// The fix is a Postgres function that takes pg_advisory_xact_lock on the
// character and re-runs the ±3-min window check INSIDE the transaction, so the
// second writer sees the first writer's row. Everything below is the client
// half: call it, CHECK the result, and fall back to the old (racy but working)
// path when the function isn't there yet.
//
// DEPLOY-SAFE IN EITHER ORDER. If the migration has not been applied, the rpc
// fails with 42883 (undefined_function) — or PostgREST's PGRST202, which is what
// supabase-js actually surfaces when the schema cache has no such function — and
// we run exactly the code that runs today. No death is lost either way; the race
// simply stays open until both halves are live.

/** Postgres `undefined_function`, and PostgREST's schema-cache equivalent. */
const RPC_MISSING_CODES = new Set(['42883', 'PGRST202']);

type IngestDeathOutcome = 'inserted' | 'upgraded' | 'dropped' | 'duplicate' | 'ignored';

type RpcResult =
  | { ok: true; status: IngestDeathOutcome }
  | { ok: false; missing: boolean; message: string };

let warnedRpcMissing = false;

/**
 * Call `ingest_death` for ONE death. Never throws: any failure comes back as
 * `{ ok:false }` and the caller runs the legacy path instead.
 */
async function callIngestDeath(
  client: SupabaseClient,
  args: {
    name: string;
    playerId: string | null;
    occurredIso: string;
    metadata: Record<string, unknown>;
    mode: 'eilif' | 'gs';
  },
): Promise<RpcResult> {
  // A test double (or a client built before this migration existed) may not have
  // rpc at all — treat that exactly like "function not deployed".
  if (typeof client.rpc !== 'function') return { ok: false, missing: true, message: 'no rpc on client' };

  let data: unknown;
  let error: { code?: string; message?: string } | null = null;
  try {
    const res = await client.rpc('ingest_death', {
      p_name: args.name,
      p_player_id: args.playerId,
      p_at: args.occurredIso,
      p_metadata: args.metadata,
      p_mode: args.mode,
    });
    data = res.data;
    error = res.error;
  } catch (e) {
    return { ok: false, missing: false, message: e instanceof Error ? e.message : 'rpc threw' };
  }

  if (error) {
    const code = error.code ?? '';
    const message = error.message ?? 'rpc failed';
    const missing =
      RPC_MISSING_CODES.has(code) ||
      /ingest_death/i.test(message) ||
      /schema cache/i.test(message);
    if (missing && !warnedRpcMissing) {
      warnedRpcMissing = true;
      console.warn(
        '[deaths] ingest_death() is not in the database yet — falling back to the ' +
          'select-then-insert path (two simultaneous reports of one death can still ' +
          'both insert). Apply db/2026-09-04_ingest_death.sql to close the race.',
      );
    }
    return { ok: false, missing, message };
  }

  // `returns text` comes back as a bare string.
  const status = typeof data === 'string' ? data : '';
  if (status === 'inserted' || status === 'upgraded' || status === 'dropped' || status === 'duplicate' || status === 'ignored') {
    if (warnedRpcMissing) {
      warnedRpcMissing = false; // the migration landed — say so once if it drops out again
    }
    return { ok: true, status };
  }
  return { ok: false, missing: false, message: `unexpected ingest_death result: ${JSON.stringify(data)}` };
}

/** Resolve an EXISTING players row id (never auto-create one from a client payload). */
async function findPlayerId(client: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await client.from('players').select('id').eq('character_name', name).limit(1);
  if (error) {
    console.error(`[deaths] players lookup for "${name}" failed — ${error.message}`);
    return null;
  }
  return (data?.[0]?.id as string | undefined) ?? null;
}

/**
 * Ingest ONE death reported by our own client plugin (source:'eilif-death').
 * Writes to `events` only. See the precedence table at the top of this file.
 */
export async function ingestEilifDeath(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<EilifDeathResult> {
  const p = parseEilifDeath(body);
  if (!p) return { ok: false, status: 'ignored', reason: 'bad eilif-death payload' };

  // Resolve an EXISTING players row only — never auto-create one from a client
  // payload (the poller's join path owns that). Looked up BEFORE the write so
  // the atomic function has everything it needs in one round trip; an upgrade
  // doesn't need it, so a null id is passed through rather than short-circuiting.
  const pid = await findPlayerId(client, p.player);

  const rpc = await callIngestDeath(client, {
    name: p.player,
    playerId: pid,
    occurredIso: p.occurredIso,
    metadata: p.metadata,
    mode: 'eilif',
  });

  if (rpc.ok) {
    console.info(`[deaths] eilif death for "${p.player}" at ${p.occurredIso} → ${rpc.status} (atomic rpc).`);
    switch (rpc.status) {
      case 'inserted':
        return { ok: true, status: 'inserted', cause: p.cause };
      case 'upgraded':
        return { ok: true, status: 'upgraded', cause: p.cause };
      case 'duplicate':
        return { ok: true, status: 'duplicate', reason: 'already reported', cause: p.cause };
      default:
        // 'ignored' — nothing nearby to upgrade and no players row to hang a new
        // row on. Self-heals: the poller's join path creates the row.
        return { ok: false, status: 'ignored', reason: 'no players row yet', cause: p.cause };
    }
  }
  if (!rpc.missing) {
    console.error(`[deaths] ingest_death(eilif) failed — ${rpc.message}. Falling back to select-then-insert.`);
  }
  return ingestEilifDeathFallback(client, p, pid);
}

/**
 * The pre-2026-09-04 path: SELECT the window, then UPDATE or INSERT. Racy by
 * construction (two simultaneous reports of one death can both insert), kept
 * ONLY so a deploy that lands before db/2026-09-04_ingest_death.sql behaves
 * exactly as it does today instead of dropping deaths on the floor.
 */
async function ingestEilifDeathFallback(
  client: SupabaseClient,
  p: ParsedEilifDeath,
  pid: string | null,
): Promise<EilifDeathResult> {
  // Idempotency across retries: the exact same report a second time is a no-op.
  const { data: sameReport } = await client
    .from('events')
    .select('id')
    .eq('type', 'death')
    .eq('metadata->>eilifDeathId', p.key)
    .limit(1);
  if (sameReport && sameReport.length > 0) {
    return { ok: true, status: 'duplicate', reason: 'already reported', cause: p.cause };
  }

  const t = Date.parse(p.occurredIso);
  const lo = new Date(t - DEDUPE_WINDOW_MS).toISOString();
  const hi = new Date(t + DEDUPE_WINDOW_MS).toISOString();

  // Any death already recorded for this viking inside the window is THE SAME
  // death — whoever wrote it. Upgrade it rather than adding a second row.
  const { data: nearby } = await client
    .from('events')
    .select('id, created_at, metadata')
    .eq('type', 'death')
    .eq('character_name', p.player)
    .gte('created_at', lo)
    .lte('created_at', hi)
    .order('created_at', { ascending: true });

  // A row that ALREADY carries an eilif-authored cause is a DIFFERENT death:
  // the plugin fires exactly once per death (Player.OnDeath is m_dead-guarded)
  // and true replays were caught by the exact eilifDeathId check above. Two
  // genuine deaths ±3 min apart (the classic corpse-run double-death) must
  // produce two rows — so eilif-authored rows are never upgrade candidates
  // and never make this report a "duplicate".
  const rows = (nearby ?? []).filter(
    (r) => (r.metadata as Record<string, unknown> | null)?.causeSource !== EILIF_CAUSE_SOURCE,
  );

  if (rows.length > 0) {
    // Nearest in time is the best match when several are somehow in range.
    let best = rows[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const r of rows) {
      const delta = Math.abs(Date.parse(r.created_at as string) - t);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = r;
      }
    }
    const existing = ((best.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    const { error: upErr } = await client
      .from('events')
      .update({ metadata: eilifCausePatch(p, existing) })
      .eq('id', best.id);
    if (upErr) {
      console.error(`[deaths] eilif cause upgrade for "${p.player}" failed — ${upErr.message}`);
      return { ok: false, status: 'ignored', reason: 'write failed', cause: p.cause };
    }
    console.info(`[deaths] eilif death for "${p.player}" at ${p.occurredIso} → upgraded (fallback path).`);
    return { ok: true, status: 'upgraded', cause: p.cause };
  }

  // First to report this death. `pid` was resolved by the caller from an
  // EXISTING players row only — never auto-created from a client payload (the
  // poller's join path owns that); a brand-new player's first death simply
  // isn't written until their row lands.
  if (!pid) return { ok: false, status: 'ignored', reason: 'no players row yet', cause: p.cause };

  const { error: insErr } = await client.from('events').insert({
    type: 'death',
    player_id: pid,
    character_name: p.player,
    metadata: p.metadata,
    created_at: p.occurredIso,
  });
  if (insErr) {
    console.error(`[deaths] eilif death insert for "${p.player}" failed — ${insErr.message}`);
    return { ok: false, status: 'ignored', reason: 'write failed', cause: p.cause };
  }
  console.info(`[deaths] eilif death for "${p.player}" at ${p.occurredIso} → inserted (fallback path).`);
  return { ok: true, status: 'inserted', cause: p.cause };
}

/**
 * Ingest GsValheimStatsClient `deathEvents[]` into the `events` table as `death`
 * rows carrying its best-known cause. The snapshot is cumulative and re-POSTed
 * every ~120s, so each death is deduped on (playerName + tsUtc) — a natural
 * unique key — stored as `metadata.gsDeathId`.
 *
 * Deaths our own plugin already reported inside the ±3-min window are DROPPED
 * here: the eilif row holds a strictly better cause (this producer would only
 * add its generic "enemyhit"), and a second row would double-count the death in
 * "How We Die", the Saga and the per-viking death log.
 */
export async function ingestDeathEvents(
  client: SupabaseClient,
  rawEvents: unknown,
  reporter: string,
): Promise<void> {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) return;

  // A client may only report its OWN deaths (a client mod can't witness the true
  // cause of anyone else's death). Drop anything not authored by the reporting
  // character — with no reporter name to trust, drop everything.
  const owner = reporter.trim();

  // Normalize + drop anything without the two fields we key on (and anything the
  // reporter didn't author).
  const parsed = rawEvents
    .map((e) => {
      const d = e as Record<string, unknown>;
      const name = typeof d.playerName === 'string' ? d.playerName.trim() : '';
      const tsUtc = typeof d.tsUtc === 'string' ? d.tsUtc : '';
      if (!name || name !== owner || !tsUtc || Number.isNaN(Date.parse(tsUtc))) return null;
      const metadata: Record<string, unknown> = {
        gsDeathId: `${name}|${tsUtc}`,
        source: 'gs',
      };
      // Every free-text field here is attacker-controlled (client payloads carry
      // no token) and renders into Discord / the Saga / in-game voice, so all
      // three are tag-stripped and capped at 48 chars — see sanitizeClientText.
      const cause = humanizeKiller(d.killer);
      if (cause) metadata.cause = cause;
      const rawKiller = sanitizeClientText(d.killer);
      if (rawKiller) metadata.killer = rawKiller;
      const biome = sanitizeClientText(d.biome);
      if (biome) metadata.biome = biome;
      if (typeof d.lifeSec === 'number' && Number.isFinite(d.lifeSec)) metadata.lifeSec = Math.round(d.lifeSec);
      if (typeof d.killsThisLife === 'number' && Number.isFinite(d.killsThisLife)) {
        metadata.killsThisLife = Math.round(d.killsThisLife);
      }
      return { name, occurredIso: new Date(tsUtc).toISOString(), key: `${name}|${tsUtc}`, metadata };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (parsed.length === 0) return;

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

  // ── Atomic path (db/2026-09-04_ingest_death.sql) ─────────────────────────
  // One rpc per death: the ±3-min eilif-precedence check and the insert happen
  // together, under a per-character advisory lock, so the eilif report racing
  // this one cannot slip between them. Resolve the players rows first — the
  // function needs the id to insert with (and returns 'ignored' without one).
  const namesAll = [...new Set(fresh.map((p) => p.name))];
  const { data: rosterRows, error: rosterErr } = await client
    .from('players')
    .select('id, character_name')
    .in('character_name', namesAll);
  if (rosterErr) console.error(`[deaths] gs players lookup failed — ${rosterErr.message}`);
  const idByNameAll = new Map<string, string>(
    (rosterRows ?? []).map((r) => [r.character_name as string, r.id as string]),
  );

  // Oldest first, so when two deaths in one payload compete for the same eilif
  // report the pairing is deterministic — the same rule the fallback applies.
  const ordered = [...fresh].sort((a, b) => Date.parse(a.occurredIso) - Date.parse(b.occurredIso));

  const insertedViaRpc: typeof fresh = [];
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    const rpc = await callIngestDeath(client, {
      name: p.name,
      playerId: idByNameAll.get(p.name) ?? null,
      occurredIso: p.occurredIso,
      metadata: p.metadata,
      mode: 'gs',
    });
    if (!rpc.ok) {
      if (!rpc.missing) {
        console.error(`[deaths] ingest_death(gs) failed — ${rpc.message}. Falling back to select-then-insert.`);
      }
      // Only the deaths NOT already handled above go down the legacy path, so a
      // mid-batch failure can never write one of them twice.
      await ingestDeathEventsFallback(client, ordered.slice(i));
      return;
    }
    if (rpc.status === 'inserted') {
      insertedViaRpc.push(p);
    } else if (rpc.status === 'dropped') {
      console.info(
        `[deaths] gs death for "${p.name}" at ${p.occurredIso} dropped (atomic rpc) — our own plugin ` +
          `already reported this death with the authoritative HitType cause (±3 min).`,
      );
    }
  }
  if (insertedViaRpc.length > 0) {
    console.info(`[deaths] ${insertedViaRpc.length} gs death row(s) inserted (atomic rpc).`);
    await dropCauselessPollerTwins(client, insertedViaRpc);
  }
}

/**
 * The pre-2026-09-04 gs path: read the eilif rows for the whole batch, pair them
 * in JS, then batch-INSERT. Racy by construction, kept ONLY so a deploy landing
 * before db/2026-09-04_ingest_death.sql behaves exactly as it does today.
 */
async function ingestDeathEventsFallback(
  client: SupabaseClient,
  fresh: { name: string; occurredIso: string; key: string; metadata: Record<string, unknown> }[],
): Promise<void> {
  if (fresh.length === 0) return;

  // EILIF PRECEDENCE (arrival order must not matter): our own plugin may have
  // reported these same deaths already, with the real cause. One query covering
  // the whole batch's time span, then a per-death ±3-min check in JS.
  const times = fresh.map((p) => Date.parse(p.occurredIso));
  const names = [...new Set(fresh.map((p) => p.name))];
  const { data: eilifRows } = await client
    .from('events')
    .select('character_name, created_at')
    .eq('type', 'death')
    .eq('metadata->>causeSource', EILIF_CAUSE_SOURCE)
    .in('character_name', names)
    .gte('created_at', new Date(Math.min(...times) - DEDUPE_WINDOW_MS).toISOString())
    .lte('created_at', new Date(Math.max(...times) + DEDUPE_WINDOW_MS).toISOString());

  const eilifTimesByName = new Map<string, number[]>();
  for (const r of eilifRows ?? []) {
    const n = r.character_name as string | null;
    const at = Date.parse(r.created_at as string);
    if (!n || Number.isNaN(at)) continue;
    const list = eilifTimesByName.get(n) ?? [];
    list.push(at);
    eilifTimesByName.set(n, list);
  }

  // Pair 1:1, nearest-first: each eilif row can cover at most ONE gs death, so
  // two rapid genuine deaths with only one eilif report still record both (the
  // uncovered gs twin inserts). Sort by time so pairing is deterministic.
  const sortedFresh = [...fresh].sort((a, b) => Date.parse(a.occurredIso) - Date.parse(b.occurredIso));
  const writable0 = sortedFresh.filter((p) => {
    const t = Date.parse(p.occurredIso);
    const pool = eilifTimesByName.get(p.name) ?? [];
    let bestIdx = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const delta = Math.abs(pool[i] - t);
      if (delta <= DEDUPE_WINDOW_MS && delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      pool.splice(bestIdx, 1); // consumed — cannot cover a second gs death
      console.info(
        `[gs-ingest] gs death for "${p.name}" at ${p.occurredIso} dropped — our own plugin already ` +
          `reported this death with the authoritative HitType cause (±3 min).`,
      );
      return false;
    }
    return true;
  });
  if (writable0.length === 0) return;

  // Resolve EXISTING players only — never auto-create a row from a client payload.
  // A brand-new player gets their row from the poller's join path first; until then
  // we skip their death writes (self-heals on the next cycle).
  const writableNames = [...new Set(writable0.map((p) => p.name))];
  const { data: players } = await client
    .from('players')
    .select('id, character_name')
    .in('character_name', writableNames);
  const idByName = new Map<string, string>((players ?? []).map((p) => [p.character_name as string, p.id as string]));

  const writable = writable0.filter((p) => idByName.has(p.name));
  if (writable.length === 0) return;

  const { error: insErr } = await client.from('events').insert(
    writable.map((p) => ({
      type: 'death',
      player_id: idByName.get(p.name)!,
      character_name: p.name,
      metadata: p.metadata,
      created_at: p.occurredIso,
    })),
  );
  if (insErr) {
    console.error(`[deaths] gs death insert failed — ${insErr.message}`);
    return;
  }
  console.info(`[deaths] ${writable.length} gs death row(s) inserted (fallback path).`);

  await dropCauselessPollerTwins(client, writable);
}

/**
 * The log poller may race ahead of the client's 120s cycle and log the same
 * death first, but WITHOUT the real cause (no metadata.source, no cause). Now
 * that we have the authoritative cause row, drop any causeless poller-derived
 * death for the same character within ±3 minutes so it isn't double-counted.
 *
 * Shared by both write paths (atomic rpc + fallback) so they cannot drift.
 */
async function dropCauselessPollerTwins(
  client: SupabaseClient,
  written: { name: string; occurredIso: string }[],
): Promise<void> {
  await Promise.all(
    written.map(async (p) => {
      const t = Date.parse(p.occurredIso);
      const lo = new Date(t - DEDUPE_WINDOW_MS).toISOString();
      const hi = new Date(t + DEDUPE_WINDOW_MS).toISOString();
      const { error } = await client
        .from('events')
        .delete()
        .eq('type', 'death')
        .eq('character_name', p.name)
        .gte('created_at', lo)
        .lte('created_at', hi)
        .is('metadata->>source', null)
        .is('metadata->>cause', null);
      if (error) console.error(`[deaths] causeless poller-twin cleanup for "${p.name}" failed — ${error.message}`);
    }),
  );
}
