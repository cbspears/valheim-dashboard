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
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
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
    return hitType === 'PlayerHit' ? `the hand of ${attacker}` : attacker;
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
  const biome = typeof body.biome === 'string' && body.biome.trim() ? body.biome.trim() : null;
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
    await client
      .from('events')
      .update({ metadata: eilifCausePatch(p, existing) })
      .eq('id', best.id);
    return { ok: true, status: 'upgraded', cause: p.cause };
  }

  // First to report this death. Resolve an EXISTING players row only — never
  // auto-create one from a client payload (the poller's join path owns that);
  // a brand-new player's first death simply isn't written until their row lands.
  const { data: players } = await client
    .from('players')
    .select('id')
    .eq('character_name', p.player)
    .limit(1);
  const pid = players?.[0]?.id as string | undefined;
  if (!pid) return { ok: false, status: 'ignored', reason: 'no players row yet', cause: p.cause };

  await client.from('events').insert({
    type: 'death',
    player_id: pid,
    character_name: p.player,
    metadata: p.metadata,
    created_at: p.occurredIso,
  });
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

  await client.from('events').insert(
    writable.map((p) => ({
      type: 'death',
      player_id: idByName.get(p.name)!,
      character_name: p.name,
      metadata: p.metadata,
      created_at: p.occurredIso,
    })),
  );

  // The log poller may race ahead of the client's 120s cycle and log the same
  // death first, but WITHOUT the real cause (no metadata.source, no cause). Now
  // that we have the authoritative cause row, drop any causeless poller-derived
  // death for the same character within ±3 minutes so it isn't double-counted.
  await Promise.all(
    writable.map(async (p) => {
      const t = Date.parse(p.occurredIso);
      const lo = new Date(t - DEDUPE_WINDOW_MS).toISOString();
      const hi = new Date(t + DEDUPE_WINDOW_MS).toISOString();
      await client
        .from('events')
        .delete()
        .eq('type', 'death')
        .eq('character_name', p.name)
        .gte('created_at', lo)
        .lte('created_at', hi)
        .is('metadata->>source', null)
        .is('metadata->>cause', null);
    }),
  );
}
