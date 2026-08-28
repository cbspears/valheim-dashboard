import { createClient } from '@supabase/supabase-js';
import {
  parseSelfSnapshot,
  parseSelfDistances,
  parseBossMilestones,
  parseBossKillEvents,
  parseBossFighters,
  type ParsedBossKill,
} from '@/lib/gs-client';
import {
  applyBaseline,
  reconstructRawWeapons,
  mergeIntoRow,
  needsBaselineMigration,
  isMissingBaselineColumn,
  baseColumnsOnly,
  POISON_CAPS,
  MIGRATION_REQUIRED,
} from '@/lib/gs-baseline';
import {
  bossDamageDeltas,
  foldClientDamage,
  CLIENT_DAMAGE_SOURCE,
  type FightStats,
} from '@/lib/boss-damage';
import { evaluateAndRecord } from '@/lib/milestones';
import { ingestDeathEvents, ingestEilifDeath } from '@/lib/deaths';
import { rateLimit, ipFromRequest } from '@/lib/rate-limit';
import type { GsClientStats } from '@/lib/types';

// GsValheimStats ingest (v0) — the server-side Emitter POSTs here every ~120s
// (instantly on join/leave): { schemaVersion: 1, game: 'valheim', source: 'server',
// onlinePlayers, worldDay, milestones, ... }. This v0 consumes the presence +
// world-day facts (the authoritative "who is on, what day is it") and accepts
// client payloads with a 200 so the mod never retries (per-player stats land
// in a later iteration).
//
// Auth (split by source): server-side Emitter payloads (source:'server') MUST
// present a Bearer token equal to GS_EMITTER_TOKEN — a header-less or wrong-token
// server payload is rejected 401. Client payloads ('client' / 'client-map' /
// 'eilif-death') run on players' PCs and carry NO secret; they are instead gated
// by the world + server-presence cross-checks below. The server-side Emitter
// config Token must equal GS_EMITTER_TOKEN.
//
// 'eilif-death' is OUR OWN plugin (EilifCompanionClient ≥0.2.0) reporting one
// death with the real HitData.HitType + attacker — the cause the third-party
// GsValheimStatsClient flattens to "enemyhit". lib/deaths.ts owns the write and
// the cross-producer precedence.

export const dynamic = 'force-dynamic';

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/**
 * Guard against the Emitter's `onlinePlayers` roster going stale (real
 * incident 2026-07-04: a player relogged to a different character and the
 * Emitter kept reporting the OLD character name online for ~1h). The log
 * poller is a second, independent presence signal — if it has already
 * recorded a `leave` for a name MORE RECENTLY than any `join`, that name is
 * not actually online no matter what the Emitter's snapshot says. Everything
 * else stays Emitter-authoritative.
 *
 * One round trip: fetch every join/leave row for the candidate names, newest
 * first, and keep only the first (= most recent) row per name.
 */
async function dropStaleLeavers(
  client: ReturnType<typeof db>,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return names;
  const { data } = await client
    .from('events')
    .select('character_name, type, created_at')
    .in('character_name', names)
    .in('type', ['join', 'leave'])
    .order('created_at', { ascending: false });

  const latestTypeByName = new Map<string, string>();
  for (const row of data ?? []) {
    const name = row.character_name as string | null;
    if (!name || latestTypeByName.has(name)) continue; // first hit per name = most recent (desc order)
    latestTypeByName.set(name, row.type as string);
  }

  return names.filter((n) => latestTypeByName.get(n) !== 'leave');
}

/**
 * Presence cross-check: is this REPORTING character actually connected to THIS
 * server right now? Gates ALL client-payload ingestion (deaths, the per-player
 * stats merge, and boss-kill enrichment).
 *
 * WHY this exists, and why it is SEPARATE from warnOnWeaponCollision above:
 * warnOnWeaponCollision catches a character SWITCH on this same game client
 * poisoning the world-scoped weapons cache — a same-server problem, and only the
 * weapon breakdown. THIS guard catches a bigger, different threat. The third-party
 * GsValheimStatsClient mod self-reports which `World =` it tracks and which `Url =`
 * it POSTs to from LOCAL config it has NO way to verify against reality. If a
 * player takes their character (or their whole r2modman profile) onto a totally
 * DIFFERENT, unrelated Valheim server while that config still points at this
 * dashboard, everything they do over THERE — kills, deaths, builds, distance,
 * every stat column, because a Valheim character save travels with the player and
 * isn't server-locked — would faithfully merge into their Eilif player_stats row
 * as if it happened here. The existing GS_EXPECTED_WORLD check can't stop it: the
 * mod lies about the world name too (it's the same unverifiable local config).
 *
 * The one truth the client mod can't spoof is the `events` table's join/leave
 * rows, written by the log poller parsing THIS server's own LogOutput.log over
 * SFTP — completely decoupled from anything the mod self-reports. So we look the
 * reporter up there (same query shape as dropStaleLeavers).
 *
 * DELIBERATELY ONE-SIDED — it only ever acts on POSITIVE evidence of being
 * offline, never on absence of evidence:
 *   • No join/leave history at all → inconclusive → ACCEPT (a brand-new player,
 *     or the poller simply hasn't caught up, must never be wrongly blocked).
 *   • Most recent event is a `join` → ACCEPT (connected here now).
 *   • Most recent event is a `leave` within GRACE_MS of now → ACCEPT (covers the
 *     client's own ~120s emit cycle plus the poller's polling lag, so a genuinely
 *     online player's very last snapshot on their way out is never flagged).
 *   • Most recent event is a `leave` older than GRACE_MS → REJECT (this is real,
 *     independent proof they are not on this server right now).
 */
async function confirmOnThisServer(name: string): Promise<{ onServer: boolean; reason: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { onServer: true, reason: 'no reporter name to check' };

  const GRACE_MS = 5 * 60_000; // 5 min: client's ~120s emit cycle + log-poller polling lag

  const client = db();
  const { data } = await client
    .from('events')
    .select('type, created_at')
    .ilike('character_name', trimmed.replace(/[%_]/g, '\\$&'))
    .in('type', ['join', 'leave'])
    .order('created_at', { ascending: false })
    .limit(1);

  const latest = data?.[0];
  if (!latest) {
    // No positive evidence either way — never block on absence of evidence.
    return { onServer: true, reason: 'no join/leave history (new player or poller not caught up yet)' };
  }
  if (latest.type === 'join') {
    return { onServer: true, reason: 'most recent presence event is a join (connected here)' };
  }

  // Most recent event is a `leave`: accept inside the grace window, reject beyond it.
  const leftAt = Date.parse(latest.created_at as string);
  if (Number.isNaN(leftAt)) {
    return { onServer: true, reason: 'most recent event is a leave with an unparseable timestamp (inconclusive)' };
  }
  const ageMs = Date.now() - leftAt;
  if (ageMs <= GRACE_MS) {
    return { onServer: true, reason: `most recent event is a leave ${Math.round(ageMs / 1000)}s ago, within the 5-min grace window` };
  }
  return {
    onServer: false,
    reason: `most recent presence event is a leave ${Math.round(ageMs / 60_000)}m ago, beyond the 5-min grace window (not on this server)`,
  };
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

// ─── Client-map: automatic cartography (source:'client-map') ─────────────────
//
// The EilifCompanionClient BepInEx plugin (plugins/eilif-companion-client) posts
// the local player's explored-map % every ~5 min while on the server:
//   { schemaVersion:1, game:'valheim', source:'client-map', playerName, world, exploredPct }
// We write ONLY player_stats.map_explored_pct, with GREATEST semantics (exploration
// only ever grows, and a stale/duplicate post must never roll it back). The
// stats-parser webhook (app/api/webhook) also writes this column for the owner's
// own .fch profiles — both coexist because this branch touches map_explored_pct
// and nothing else, and the max() guard means whichever writer sees more wins.
//
// World guard uses the SAME GS_EXPECTED_WORLD convention as the client-stats path:
// if set and the payload world doesn't match, ignore (the caller already gates
// world mismatches too — this is defence in depth). Unset (pilot) = accept any.
async function ingestClientMap(body: Obj): Promise<{ ok: boolean; pct: number | null; player: string | null }> {
  const player = typeof body.playerName === 'string' ? body.playerName.trim() : '';
  const pctRaw = body.exploredPct;
  const pct = typeof pctRaw === 'number' && Number.isFinite(pctRaw) ? Math.min(100, Math.max(0, pctRaw)) : null;
  if (!player || pct === null) return { ok: false, pct: null, player: player || null };

  const client = db();
  const now = new Date().toISOString();

  // Resolve an EXISTING players row only — never auto-create from a client payload.
  // A new player's row lands via the poller join path first; until then, skip.
  const { data: found } = await client.from('players').select('id').eq('character_name', player).limit(1);
  const pid = (found?.[0]?.id as string | undefined) ?? undefined;
  if (!pid) return { ok: false, pct, player };

  // GREATEST: never let a lower reading (different world, older snapshot) overwrite a higher one.
  const { data: prevRows } = await client.from('player_stats').select('map_explored_pct').eq('player_id', pid).limit(1);
  const prevPct = num((prevRows?.[0] as Obj | undefined)?.map_explored_pct);
  const nextPct = Math.max(pct, prevPct);

  await client
    .from('player_stats')
    .upsert({ player_id: pid, map_explored_pct: nextPct, updated_at: now }, { onConflict: 'player_id' });
  return { ok: true, pct: nextPct, player };
}

// ─── Client per-player cumulative stats ──────────────────────────────────────
//
// The client mod's Emit() posts players[]: the FIRST element (name === reporter)
// is the local player and is the ONLY authoritative cumulative source — it carries
// `stats` (the raw .fch profile counters, keyed "vh_<StatType>"), `kills`,
// `deaths`, `bossKills`, plus weapon/creature/craft/pickup/boss breakdowns. Any
// further players[] entries are OTHER players observed by the reporter (partial
// combat only, no cumulative counters) — we deliberately ignore those here so a
// bystander's snapshot never clobbers someone's real totals. Result: exactly one
// authoritative writer per character, which makes the read-modify-write below
// race-free in practice.
//
// Snapshots are cumulative and re-posted every ~120s, so the merge is idempotent
// and uses GREATEST (never let a fresh character / profile reset roll counters
// backwards). The pure parse lives in lib/gs-client so it stays unit-testable.
//
// ⚠️ WORLD BASELINES (2026-08-23). Those cumulative numbers are LIFETIME totals
// carried inside the character file across every world and server it has ever
// visited — so an imported veteran used to arrive pre-loaded and flood the clan
// totals. The first snapshot a character posts is now captured as their
// zero-point (player_stats.gs_baseline) and everything below merges only
// `raw − baseline` (records: only values that BEAT the baselined record). See
// lib/gs-baseline.ts for the field-kind rules and the profile-reset detection.
// The columns downstream reads are unchanged in name and meaning — they simply
// now hold what was earned HERE. Requires db/2026-08-23_gs_baselines.sql.
//
// A zero-point is captured from the reporter's OWN entry and covers only the
// groups that entry CARRIED; anything absent is stored as an explicit HOLE that
// credits nothing until it first appears (gs_baseline.holes). So a payload the
// mod happens to emit without vh_Builds or without vh_Distance* still baselines
// and still writes — deferring on those was muting real players outright.

type Obj = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Best-effort weapon-collision monitor — LOG-ONLY, never blocks/mutates ingest.
 *
 * The third-party GsValheimStatsClient mod (closed-source, GUID
 * net.cproudlock.gsvalheimstatsclient) caches its per-weapon combat breakdown in
 * a LOCAL file on each player's PC named
 * `net.cproudlock.gsvalheimstatsclient.<WorldName>.weapons.tsv`. That cache is
 * scoped by WORLD NAME, not by Valheim character — so if one game client plays
 * character A on a world, then rolls a NEW character B on the SAME world without
 * clearing the file, B's weapon breakdown inherits A's leftover combat. The tell
 * is a byte-identical weapon tuple showing up under two different characters
 * (real incident: Testman & Testmantwo both reporting the same Crossbows entry
 * {kills:2, damageDealt:658, hardestHit:475, biggestSwing:475}). We can't patch
 * the mod's source; this just surfaces the contamination in the logs so an admin
 * can run the clear-the-file fix (see vault 05-Server/Server-Setup-Runbook.md).
 *
 * We flag when an incoming weapon entry EXACTLY matches an entry already stored
 * for a DIFFERENT player. damageDealt must clear a small noise floor first: the
 * degenerate opening of combat is genuinely coincidental across players (e.g.
 * everyone's very first Unarmed punch can read kills:1/damageDealt:1/
 * hardestHit:1/biggestSwing:1, or an early thrown rock lands identically), so an
 * exact tuple match there is not evidence of the cache leak. 10 damage sits
 * comfortably below any real weapon's first real kill yet far above those
 * 1/1/1/1-style coincidences, so real inherited entries (hundreds of damage)
 * always clear it while trivial first-swing collisions are ignored.
 *
 * Both sides of the comparison are RAW (pre-baseline) tuples: the incoming
 * snapshot as posted, and each stored row re-derived from its own baseline
 * (reconstructRawWeapons). The leak this hunts for happens in the mod's local
 * cache file, upstream of anything the dashboard does, so it is only visible in
 * the raw numbers — two rows with different baselines hold different effective
 * values for the very same inherited combat.
 */
async function warnOnWeaponCollision(
  client: ReturnType<typeof db>,
  pid: string,
  reporter: string,
  weapons: GsClientStats['weapons'],
): Promise<void> {
  const NOISE_FLOOR_DAMAGE = 10; // see doc comment — below this an identical tuple is plausibly coincidental
  const candidates = weapons.filter((w) => w.damageDealt > NOISE_FLOOR_DAMAGE);
  if (candidates.length === 0) return;

  // Cheap at 15-20 players: one scan of every OTHER stored player's breakdown.
  // gs_reporter carries that row's character name (written alongside gs_stats).
  const { data: others } = await client
    .from('player_stats')
    .select('player_id, gs_reporter, gs_stats, gs_baseline')
    .neq('player_id', pid);
  if (!others || others.length === 0) return;

  for (const row of others) {
    const otherName = (row.gs_reporter as string | null) ?? `player ${row.player_id}`;
    const otherWeapons = reconstructRawWeapons(row.gs_stats, row.gs_baseline);
    if (otherWeapons.length === 0) continue;
    for (const mine of candidates) {
      const twin = otherWeapons.some(
        (o) =>
          o &&
          o.weapon === mine.weapon &&
          o.kills === mine.kills &&
          o.damageDealt === mine.damageDealt &&
          o.hardestHit === mine.hardestHit &&
          o.biggestSwing === mine.biggestSwing,
      );
      if (twin) {
        console.warn(
          `[gs-ingest] WEAPON COLLISION: "${reporter}" and "${otherName}" share a byte-identical ` +
            `${mine.weapon} entry {kills:${mine.kills}, damageDealt:${mine.damageDealt}, ` +
            `hardestHit:${mine.hardestHit}, biggestSwing:${mine.biggestSwing}}. ` +
            `Known cause: a character switch on the same game client without clearing the local, ` +
            `world-scoped net.cproudlock.gsvalheimstatsclient.<World>.weapons.tsv cache (the mod ` +
            `scopes that file by world, not character). Fix: vault 05-Server/Server-Setup-Runbook.md.`,
        );
      }
    }
  }
}

/**
 * Merge the reporter's cumulative snapshot into player_stats (idempotent,
 * GREATEST). Returns true when a real stats merge happened (a self snapshot was
 * present and written) so the caller knows whether it's worth re-evaluating the
 * collective milestones — false means "nothing changed, skip".
 *
 * What lands in the columns is the SERVER-EARNED share of the snapshot:
 * `raw − gs_baseline` per counter, records only when they beat the baselined
 * record (lib/gs-baseline). The first snapshot from a character captures that
 * baseline and therefore contributes exactly zero — which is the point: a
 * veteran import starts level with everyone else.
 */
async function ingestPlayerStats(body: Obj): Promise<boolean> {
  const s = parseSelfSnapshot(body);
  if (!s) return false;

  const client = db();
  const now = new Date().toISOString();

  // Resolve an EXISTING players row only — never auto-create from a client payload.
  // A new reporter's row lands via the poller join path first; until then, skip.
  // Case-insensitive (escaped ilike, same as the webhook): a case/whitespace-skewed
  // reporter name must not silently drop the payload forever (R3).
  const escapedReporter = s.reporter.trim().replace(/[%_]/g, '\\$&');
  const { data: found } = await client
    .from('players')
    .select('id')
    .ilike('character_name', escapedReporter)
    .limit(1);
  const pid = (found?.[0]?.id as string | undefined) ?? undefined;
  if (!pid) {
    console.warn(`[gs-ingest] no players row for reporter "${s.reporter}" — payload skipped (row lands via poller join first)`);
    return false;
  }

  // Best-effort weapon-collision monitor (LOG-ONLY): flag if this reporter's
  // weapon breakdown byte-matches another character's — the sign of the
  // GsValheimStatsClient world-scoped weapons.tsv cache leaking across a
  // character switch. Compares RAW tuples on both sides (see the doc comment).
  // Wrapped like the evaluateAndRecord call below so a monitor failure can NEVER
  // fail the ingest, block it, or mutate any data. Skipped when the snapshot did
  // not come from the reporter's OWN players[] entry: a bystander entry holds the
  // reporter's observations OF OTHER PLAYERS, so matching it against those same
  // players' stored rows would flag the leak that isn't there.
  try {
    if (s.provenance.ownEntry) {
      await warnOnWeaponCollision(client, pid, s.reporter, s.gsStatsFull.weapons);
    }
  } catch (e) {
    console.error('[gs-ingest] weapon-collision monitor', e instanceof Error ? e.message : e);
  }

  // Read the current row: it carries this character's stored zero-point AND the
  // values to GREATEST against (only-writer-per-row makes the RMW safe).
  const { data: prevRows } = await client.from('player_stats').select('*').eq('player_id', pid).limit(1);
  const prev = (prevRows?.[0] ?? null) as Obj | null;

  // Hard prerequisite. An existing row that has no gs_baseline COLUMN (rather
  // than a null value) means the migration hasn't run — bail loudly instead of
  // writing numbers we can't account for.
  if (needsBaselineMigration(prev)) {
    console.error(MIGRATION_REQUIRED);
    return false;
  }

  // Distances (metres) from the .fch profile counters: total goes to the
  // dedicated distance_traveled column; the per-mode breakdown + raw vh_ subset
  // are folded into gs_stats so future leaderboards need no further ingest
  // change. Baselined like every other counter, then GREATEST-guarded below.
  const dist = parseSelfDistances(body);

  // ── world baseline: raw lifetime snapshot → what was earned HERE ───────────
  const { effective, nextBaseline, change, reason, deferred } = applyBaseline(s, dist, prev?.gs_baseline, now);

  // An incomplete / bystander-derived snapshot is not trusted to seed a
  // zero-point OR to be credited from — writing nothing is the whole point, so
  // return before touching the row (see lib/gs-baseline captureQualification).
  if (deferred) {
    console.warn(`[gs-ingest] SNAPSHOT DEFERRED for "${s.reporter}" — ${reason}`);
    return false;
  }

  if (change === 'capture') {
    console.info(
      `[gs-ingest] BASELINE CAPTURED for "${s.reporter}" — ${reason}. ` +
        `Zero-point: kills ${s.kills}, deaths ${s.deaths}, builds ${s.structuresBuilt}, ` +
        `crafts ${s.itemsCrafted}, damage ${s.damageDealt}.`,
    );
  } else if (change === 'rebaseline') {
    console.warn(
      `[gs-ingest] RE-BASELINED "${s.reporter}" — ${reason}. Reads as a fresh/reset profile reusing the ` +
        `name, so the zero-point was re-taken from this snapshot (kills ${s.kills}, deaths ${s.deaths}, ` +
        `builds ${s.structuresBuilt}). Already-earned column values are KEPT (GREATEST); this post credits nothing. ` +
        `The superseded zero-point is retained as a PERMANENT per-counter ceiling: any climb back toward it ` +
        `credits nothing, at any distance in time.`,
    );
  } else if (change === 'reset-pending') {
    console.warn(`[gs-ingest] PROFILE RESET? "${s.reporter}" — ${reason}.`);
  } else if (change === 'reset-cleared') {
    console.info(`[gs-ingest] reset streak cleared for "${s.reporter}" — ${reason}.`);
  } else if (change === 'repair') {
    console.warn(`[gs-ingest] BASELINE REPAIRED for "${s.reporter}" — ${reason}. Those fields credit nothing this cycle.`);
  }

  // Build the row: GREATEST on every column, per-key GREATEST inside gs_stats,
  // poison markers, and the zero-point when it changed. Shared with the tests —
  // there is exactly ONE implementation of this merge (lib/gs-baseline).
  const { row: full, flags } = mergeIntoRow(prev, effective, {
    playerId: pid,
    reporter: s.reporter,
    world: s.world,
    now,
    nextBaseline,
  });

  // Stat poison (DETECT, DON'T BLOCK): an implausible one-cycle leap is the
  // signature of a spoofed or poisoned snapshot. The merge still happens; the
  // jump is warned about here and stamped reversibly into gs_stats._flags.
  for (const f of flags) {
    console.warn(
      `[gs-ingest] STAT POISON? "${s.reporter}" ${f.field} jumped ${f.prev} → ${f.next} ` +
        `(+${f.next - f.prev}) in one cycle, beyond the +${POISON_CAPS[f.field]} sanity cap. ` +
        `Merged anyway (GREATEST) but flagged in gs_stats._flags for review.`,
    );
  }

  const { error } = await client.from('player_stats').upsert(full, { onConflict: 'player_id' });
  if (!error) {
    // Client-damage fallback: the row just advanced, so whatever boss damage it
    // gained is this post's honest contribution to those fights. Both sides of
    // the delta are in scope right here and NOWHERE ELSE — `prev` is the
    // pre-merge row and `full.gs_stats` is what was just written — which is why
    // the fold lives at this exact line and not in a later pass. Strictly after
    // the successful upsert (see ingestBossDamageDeltas: that ordering is what
    // makes double-crediting impossible) and wrapped, like every other
    // best-effort enrichment here, so it can never fail the stats ingest.
    try {
      await ingestBossDamageDeltas(client, s.reporter, prev?.gs_stats, full.gs_stats);
    } catch (e) {
      console.error('[gs-ingest] boss-damage fallback', e instanceof Error ? e.message : e);
    }
    return true;
  }
  if (isMissingBaselineColumn(error)) {
    console.error(MIGRATION_REQUIRED);
    return false;
  }

  // Graceful degradation: if the 2026-07-04 migration hasn't been applied yet,
  // the gs_* columns don't exist — retry with only the pre-existing base columns
  // so headline counters still land. Safe under baselining: with nowhere to store
  // a zero-point every snapshot computes an all-zero delta, and Math.max leaves
  // the existing values untouched. Counters stall rather than inflate — the loud
  // MIGRATION_REQUIRED line above says how to fix it.
  await client.from('player_stats').upsert(baseColumnsOnly(full, now), { onConflict: 'player_id' });
  return true;
}

/**
 * CLIENT-DAMAGE FALLBACK — the honest war party when no MVP summary ever comes.
 *
 * The gap this closes, in full, is documented at the top of lib/boss-damage.ts
 * (real incident: the Eikthyr kill of 2026-08-28 landed with fighters:[] because
 * not one producer emitted a bossKillEvents entry, while a client had already
 * posted its real per-boss damage into player_stats.gs_stats.bossDamage). The
 * short version: a bystander cannot deal boss damage, so a POSITIVE per-boss
 * damage delta is proof this character fought that boss — the same class of
 * evidence ingestBossKillEvents already trusts from firstBlood/topDamagePlayer,
 * and just as strictly a SUBSET of the true fighters.
 *
 * `prevGsStats` is the row's gs_stats as it was read BEFORE the merge;
 * `nextGsStats` is the blob we just wrote. Both are EFFECTIVE (baselined) values
 * and the merge between them is a per-key GREATEST, so the delta is non-negative
 * by construction, a re-post of the same cumulative snapshot yields exactly 0,
 * and an imported veteran's lifetime boss damage yields 0 as well (their first
 * snapshot became the zero-point). We credit precisely what player_stats credits.
 *
 * ⚠️ CALLED ONLY AFTER THE player_stats UPSERT SUCCEEDS. That ordering is the
 * whole anti-double-count guarantee: if the row never advanced, the next cycle
 * recomputes the same delta and folds it once. Folding first and failing the
 * upsert would credit the same blows again on every retry. The reverse failure —
 * upsert lands, this fold throws — loses a delta rather than inventing one, which
 * is the direction to fail in.
 *
 * Best-effort throughout, exactly like the milestone evaluator and the weapon
 * collision monitor: every error is logged with this file's prefix and swallowed.
 * Boss enrichment must never be able to fail a stats ingest.
 */
async function ingestBossDamageDeltas(
  client: ReturnType<typeof db>,
  rawReporter: string,
  prevGsStats: unknown,
  nextGsStats: unknown,
): Promise<void> {
  // Trim ONCE, here, so the name written into fighters, damage and
  // players_present is byte-identical across all three (a stray space would
  // otherwise read as a second, phantom viking on the next fold).
  const reporter = rawReporter.trim();
  if (!reporter) return;

  const deltas = bossDamageDeltas(prevGsStats, nextGsStats);
  if (deltas.size === 0) return; // nothing grew — no read, no write, no log noise

  // One read for every boss this post touched, then a read-modify-write per row —
  // the same shape ingestBossKillEvents uses. There is no is_killed filter on
  // purpose: pre-kill damage accrues so the record is complete the moment the
  // milestone flip lands (and that flip unions rather than replaces, see
  // ingestBossMilestones).
  const { data: rows, error: readErr } = await client
    .from('bosses')
    .select('id, name, fight_stats, players_present')
    .in('name', [...deltas.keys()]);
  if (readErr) {
    console.error(`[gs-ingest] boss-damage fallback: could not read bosses rows — ${readErr.message}`);
    return;
  }

  for (const row of rows ?? []) {
    const bossName = row.name as string;
    const delta = deltas.get(bossName);
    if (!delta) continue;

    const existing = ((row as { fight_stats?: FightStats | null }).fight_stats ?? null) as FightStats | null;
    const next = foldClientDamage(existing, reporter, delta);
    if (!next) continue; // nothing to fold (guarded inside the pure fold too)

    // Fold the reporter into players_present as well (union — grow only, never
    // blank/shrink), on the same reasoning ingestBossKillEvents folds its MVPs
    // in: someone who dealt damage to this boss was demonstrably there for it.
    const priorPresent = Array.isArray((row as { players_present?: unknown }).players_present)
      ? (row as { players_present: unknown[] }).players_present.filter((n): n is string => typeof n === 'string')
      : [];
    const presentSet = new Set<string>(priorPresent);
    presentSet.add(reporter);

    const patch: Record<string, unknown> = { fight_stats: next };
    if (presentSet.size > priorPresent.length) patch.players_present = [...presentSet];

    const { error } = await client.from('bosses').update(patch).eq('id', row.id);
    if (error) {
      // Includes the pre-migration "no fight_stats column" case. Logged, never
      // thrown: the next client post recomputes the delta from the row as it
      // then stands, so a transient failure self-heals rather than compounding.
      console.error(
        `[gs-ingest] boss-damage fallback: could not fold ${Math.round(delta)} damage from ` +
          `"${reporter}" into ${bossName} — ${error.message}`,
      );
      continue;
    }
    console.info(
      `[gs-ingest] boss-damage fallback: credited "${reporter}" +${Math.round(delta)} damage on ${bossName} ` +
        `(fighters now ${next.fighters?.length ?? 0}` +
        `${next.topDamageFrom === CLIENT_DAMAGE_SOURCE ? `, top damage "${next.topDamagePlayer}"` : ''}).`,
    );
  }
}

// ─── Boss detection ──────────────────────────────────────────────────────────
//
// Server payloads carry `milestones[]`; a boss-defeat milestone (a Valheim
// `defeated_*` global key) is the authoritative trigger. On FIRST sight (the
// bosses row still is_killed=false) we flip that row — is_killed=true,
// killed_at=now, players_present=the online roster from the SAME payload — and
// insert a type='boss' event mirroring scripts/mark-boss.js's shape
// ({ boss, players:"N vikings" }). That single flip cascades automatically:
//   bosses row → World timeline (BossTimeline) → /boss war-room → the Discord
//   bot's is_killed poll (@everyone) → saga (lib/episodes boss case).
// Idempotent: milestones re-POST every ~120s and re-fire wholesale on a fresh
// emitter deploy, so we only act while is_killed=false and only emit the event
// when our guarded UPDATE actually flips a row.
//
// `fighters` maps bosses.name → the TRUE fighter list derived from the same
// payload (parseBossFighters); `roster` is the reconciled online roster (the
// degrade-to fallback so a war party is never blanked).
async function ingestBossMilestones(
  body: Record<string, unknown>,
  roster: string[],
  fighters: Record<string, string[]>,
): Promise<void> {
  const milestones = parseBossMilestones(body);
  if (milestones.length === 0) return;

  const client = db();
  const names = [...new Set(milestones.map((m) => m.bossName))];
  // fight_stats comes along for the ride: the client-damage fallback may already
  // have carved real fighters (and a damage map) onto this row while it was still
  // unkilled — see ingestBossDamageDeltas. The seed below unions rather than
  // replaces, so that accrual survives the flip.
  const { data: rows } = await client
    .from('bosses')
    .select('id, name, is_killed, fight_stats')
    .in('name', names);
  const byName = new Map<string, { id: string; is_killed: boolean; fight_stats: FightStats | null }>(
    (rows ?? []).map((r) => [
      r.name as string,
      {
        id: r.id as string,
        is_killed: !!r.is_killed,
        fight_stats: ((r as { fight_stats?: FightStats | null }).fight_stats ?? null) as FightStats | null,
      },
    ]),
  );

  for (const m of milestones) {
    const row = byName.get(m.bossName);
    if (!row || row.is_killed) continue; // unknown boss (e.g. Forsaken VIII, the unrevealed 8th) or already felled

    const killedAt = m.tsUtc && !Number.isNaN(Date.parse(m.tsUtc)) ? new Date(m.tsUtc).toISOString() : new Date().toISOString();

    // TRUE fighters if we have any; degrade to the online roster ONLY when empty
    // (never blank a war party). The online roster is preserved separately on
    // fight_stats.onlineAtKill so the war-room can still honestly note who else
    // was in the realm without inflating the war-party.
    // Union with anything the client-damage fallback already proved fought this
    // beast (grow only — a war party is never shrunk). Those names are exactly as
    // earned as the ones derived from this payload: each was banked off a positive
    // per-boss damage delta, which a bystander cannot produce.
    const prior = byName.get(m.bossName)?.fight_stats ?? null;
    const priorFighters = Array.isArray(prior?.fighters)
      ? prior.fighters.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      : [];
    const fought = [...new Set([...priorFighters, ...(fighters[m.bossName] ?? [])])];
    const present = fought.length > 0 ? fought : roster;

    // Guarded flip: .eq('is_killed', false) makes the re-POST a no-op and the
    // returned rows tell us whether WE were the one to fell it (→ emit event once).
    // Keep this write to columns that always exist so a pre-migration fight_stats
    // column can never block the kill from registering.
    const { data: flipped } = await client
      .from('bosses')
      .update({ is_killed: true, killed_at: killedAt, players_present: present })
      .eq('id', row.id)
      .eq('is_killed', false)
      .select('id');

    if (!flipped || flipped.length === 0) continue; // lost the race / already flipped

    // Seed fight_stats with the fighter list + the online-roster-at-kill (both
    // best-effort so a missing column can't undo the flip above). ingestBossKillEvents
    // unions richer fight detail on top and preserves both fields.
    // Spread `prior` first so the seed ADDS to what the client-damage fallback
    // accrued (its damage map and its topDamageFrom marker) instead of wiping it.
    // `source` deliberately becomes 'gs-milestone' — this row's real provenance —
    // which is safe because the fallback's top-damage verdict is gated on
    // topDamageFrom, not on source (see lib/boss-damage CLIENT_DAMAGE_SOURCE).
    await client
      .from('bosses')
      .update({
        fight_stats: { ...(prior ?? {}), fighters: fought, onlineAtKill: roster, source: 'gs-milestone' },
      })
      .eq('id', row.id);

    await client.from('events').insert({
      type: 'boss',
      character_name: null,
      metadata: {
        boss: m.bossName,
        players: `${present.length} viking${present.length === 1 ? '' : 's'}`,
        milestoneKey: m.key,
        source: 'gs-milestone',
      },
      created_at: killedAt,
    });
  }
}

// (FightStats now lives in lib/boss-damage.ts — one definition, shared by this
// route, the client-damage fallback and the tests.)

// Enrich a felled boss with the fight detail from bossKillEvents[] (emitted by
// BOTH the server and participating clients). Canonical home is bosses.fight_stats
// (jsonb) — renderable by the /boss "Full Record" surface. Order-independent and
// idempotent: dedupe on the boss's tsUtc, and prefer the report with the most
// participants (the server's server-wide view beats any single client's).
//
// The fight-scoped MVPs (firstBlood + topDamagePlayer) are UNIONED into
// fight_stats.fighters and players_present — both are inherently a SUBSET of the
// true fighters (you can't draw first blood or deal the most damage without
// fighting), so unioning can only add real fighters, never a bystander, and
// never shrinks the honest war party set at the kill-time flip. We deliberately
// do NOT re-derive fighters from players[] here: that combat is cumulative per
// world (and per-career on clients), so applying it on every ~120s re-POST would
// let later/career damage bleed into an already-felled boss's war party. players[]
// damage is trusted only once, at the milestone flip (ingestBossMilestones).
// The online-roster-at-kill (fight_stats.onlineAtKill) is preserved untouched.
//
// If the fight_stats column doesn't exist yet (pre-migration), fall back to
// stashing the detail on the matching boss event row's metadata so nothing is lost.
async function ingestBossKillEvents(raw: unknown, source: 'server' | 'client'): Promise<void> {
  const events = parseBossKillEvents(raw);
  if (events.length === 0) return;

  // Collapse duplicates within this payload: one entry per boss, best participants.
  const best = new Map<string, ParsedBossKill>();
  for (const e of events) {
    const cur = best.get(e.bossName);
    if (!cur || e.participants > cur.participants) best.set(e.bossName, e);
  }

  const client = db();
  const names = [...best.keys()];
  const { data: rows } = await client
    .from('bosses')
    .select('id, name, fight_stats, players_present')
    .in('name', names);

  for (const row of rows ?? []) {
    const bossName = row.name as string;
    const e = best.get(bossName);
    if (!e) continue;
    const existing = ((row as { fight_stats?: FightStats | null }).fight_stats ?? null) as FightStats | null;
    const priorPresent = Array.isArray((row as { players_present?: unknown }).players_present)
      ? ((row as { players_present: unknown[] }).players_present.filter((n): n is string => typeof n === 'string'))
      : [];

    // Union the fighter set (monotonic — grows, never shrinks) with THIS fight's MVPs.
    const fightersSet = new Set<string>(existing?.fighters ?? []);
    if (e.firstBlood) fightersSet.add(e.firstBlood);
    if (e.topDamagePlayer) fightersSet.add(e.topDamagePlayer);
    const fightersOut = [...fightersSet];

    // Dedupe / prefer richer scalars: keep what we hold when it's this exact fight
    // with at least as many participants; else take the incoming report.
    const keepExisting = existing?.tsUtc === e.tsUtc && (existing?.participants ?? 0) >= e.participants;
    const scalars: FightStats = keepExisting
      ? {
          fightSec: existing?.fightSec,
          firstBlood: existing?.firstBlood ?? null,
          topDamagePlayer: existing?.topDamagePlayer ?? null,
          topDamage: existing?.topDamage,
          participants: existing?.participants,
          tsUtc: existing?.tsUtc,
          source: existing?.source ?? source,
        }
      : {
          fightSec: e.fightSec,
          firstBlood: e.firstBlood,
          topDamagePlayer: e.topDamagePlayer,
          topDamage: e.topDamage,
          participants: e.participants,
          tsUtc: e.tsUtc,
          source,
        };

    const nextFightStats: FightStats = {
      ...scalars,
      fighters: fightersOut,
      onlineAtKill: existing?.onlineAtKill, // preserved (seeded at the milestone flip)
      // Preserved too: the per-fighter damage the client-damage fallback banked
      // (lib/boss-damage). `scalars` is a whitelist, so anything not named here is
      // dropped — and dropping that map would delete the only record of who hit
      // this boss for how much whenever a late MVP summary arrived.
      ...(existing?.damage ? { damage: existing.damage } : {}),
      // topDamageFrom is deliberately NOT carried: THIS is the real verdict, so
      // the fallback's marker retires with it and we never recompute over it.
    };

    // Fold the MVPs into players_present (union — grow only, never blank/shrink).
    const presentSet = new Set<string>(priorPresent);
    if (e.firstBlood) presentSet.add(e.firstBlood);
    if (e.topDamagePlayer) presentSet.add(e.topDamagePlayer);
    const patch: Record<string, unknown> = { fight_stats: nextFightStats };
    if (presentSet.size > priorPresent.length) patch.players_present = [...presentSet];

    const { error } = await client.from('bosses').update(patch).eq('id', row.id);
    if (!error) continue;

    // Graceful degradation (fight_stats column missing): merge onto the latest
    // boss event row for this boss instead.
    const { data: ev } = await client
      .from('events')
      .select('id, metadata')
      .eq('type', 'boss')
      .eq('metadata->>boss', bossName)
      .order('created_at', { ascending: false })
      .limit(1);
    const evRow = ev?.[0];
    if (evRow) {
      await client
        .from('events')
        .update({ metadata: { ...(evRow.metadata as Record<string, unknown>), fight: nextFightStats } })
        .eq('id', evRow.id);
    }
  }
}

export async function POST(req: Request) {
  // Best-effort per-IP rate limit (see lib/rate-limit.ts) — first line of defence.
  if (!rateLimit(ipFromRequest(req))) {
    return Response.json({ error: 'rate limited' }, { status: 429 });
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
  // Allowlist the four recognized producers; an unknown `source` never falls
  // through to the client branch (default-deny, not default-client).
  if (
    body.source !== 'server' &&
    body.source !== 'client' &&
    body.source !== 'client-map' &&
    body.source !== 'eilif-death'
  ) {
    return Response.json({ error: 'unknown source' }, { status: 400 });
  }

  // Auth split: the server-side Emitter (source:'server') is the only privileged
  // producer — REQUIRE its Bearer token. Client payloads carry no secret (they run
  // on players' PCs) and fall through to the world + presence cross-checks.
  if (body.source === 'server') {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!process.env.GS_EMITTER_TOKEN || token !== process.env.GS_EMITTER_TOKEN) {
      return Response.json({ error: 'bad token' }, { status: 401 });
    }
  }

  // Client payloads (per-player stats): consume `deathEvents` (real cause of
  // death — the thing only the client knows) AND merge the reporter's cumulative
  // per-player stats into player_stats. Everything else is acked.
  //
  // World guard (opt-in): the client files stats under its own world name. If
  // GS_EXPECTED_WORLD is set and the payload's world doesn't match, skip both the
  // deaths and the stats merge so a client pointed at the wrong world can't
  // pollute this dashboard. Unset (pilot default) = accept any world.
  if (body.source !== 'server') {
    const expected = process.env.GS_EXPECTED_WORLD;
    const payloadWorld = typeof body.world === 'string' ? body.world : null;
    if (expected && payloadWorld && payloadWorld !== expected) {
      return Response.json({ status: 'ignored', reason: 'world mismatch' });
    }

    // Server-presence cross-check (see confirmOnThisServer): before ANY client
    // write — cartography (map_explored_pct), deaths, or the per-player stats
    // merge — require independent proof (the log poller's join/leave trail for
    // THIS server) that the character the payload writes for is actually
    // connected here right now. The client mod self-reports its target world +
    // POST URL from unverifiable local config, so a character/profile carried
    // onto a DIFFERENT server (config still pointed here) would otherwise pour
    // that other server's play into this dashboard, polluting every stat column.
    // On positive offline evidence we ack with 200 and drop the payload, so the
    // mod never retry-storms. One-sided: no name, or no positive offline
    // evidence, always falls through and ingests.
    //
    // The verified identity is the character the payload writes for: the map
    // plugin reports `playerName`, the stats/deaths client reports `reporter`.
    // (client-map used to run BEFORE this check — moved it under the guard so a
    // caller can't inflate an existing player's exploration % without proof.)
    //
    // Emergency kill switch (default enabled, matches the poller's EMIT_DEATHS
    // convention): this check is only as good as the log poller's own uptime, and
    // this project has had real SFTP/poller outages before (see vault
    // Server-Setup-Runbook) — during one, every online player's last-known event
    // can go stale, and confirmOnThisServer would start wrongly rejecting real
    // stats. Set PRESENCE_CHECK_ENABLED=false in Vercel's env vars to bypass this
    // check instantly (no redeploy of logic needed) if an outage is suspected of
    // causing false rejections; flip it back once the poller's confirmed healthy.
    const presenceCheckEnabled = (process.env.PRESENCE_CHECK_ENABLED || 'true').toLowerCase() !== 'false';
    const reporter = typeof body.reporter === 'string' ? body.reporter.trim() : '';
    const presenceName =
      body.source === 'client-map'
        ? (typeof body.playerName === 'string' ? body.playerName.trim() : '')
        : body.source === 'eilif-death'
          ? (typeof body.player === 'string' ? body.player.trim() : '')
          : reporter;
    if (presenceCheckEnabled && presenceName) {
      const presence = await confirmOnThisServer(presenceName);
      if (!presence.onServer) {
        console.warn(
          `[gs-ingest] PRESENCE REJECT: "${presenceName}" — ${presence.reason}. ` +
            `Ignoring this client payload (map %, deaths, per-player stats, boss-kill events) ` +
            `to protect Eilif stats from a mod profile reused on a different server. ` +
            `(Set PRESENCE_CHECK_ENABLED=false in Vercel if this looks like a false positive.)`,
        );
        return Response.json({ status: 'ignored', reason: 'not connected to this server' });
      }
    }

    // Authoritative death cause from OUR OWN client plugin (EilifCompanionClient
    // ≥0.2.0, plugins/eilif-companion-client). It Harmony-patches the local
    // player's Player.OnDeath and reads Character.m_lastHit, so it is the only
    // producer that can distinguish a campfire from a blizzard from an unseen
    // foe — the third-party GsValheimStatsClient reports every unattributed
    // damage-over-time death as the flat catch-all "enemyhit".
    //
    // Writes the `events` table ONLY (never player_stats): the collective-deed
    // death count comes from player_stats.deaths, so this path cannot move it.
    // Precedence + the ±3-min collapse against the gs and poller producers (in
    // BOTH arrival orders) lives in lib/deaths.ts — see the table at its top.
    if (body.source === 'eilif-death') {
      const r = await ingestEilifDeath(db(), body as Record<string, unknown>);
      return Response.json(
        r.ok
          ? { status: r.status, cause: r.cause ?? null }
          : { status: 'ignored', reason: r.reason ?? 'bad eilif-death payload' },
      );
    }

    // Automatic cartography from the client plugin: write only map_explored_pct (GREATEST).
    if (body.source === 'client-map') {
      const r = await ingestClientMap(body as Record<string, unknown>);
      return Response.json(
        r.ok ? { status: 'inserted', map_explored_pct: r.pct, player: r.player } : { status: 'ignored', reason: 'bad client-map payload' },
      );
    }

    await ingestDeathEvents(db(), body.deathEvents, reporter);
    const merged = await ingestPlayerStats(body as Record<string, unknown>);
    // Client payloads also carry bossKillEvents (this client's view of a fight)
    // — enrich, but never flip a boss from a client (the server milestone owns that).
    await ingestBossKillEvents(body.bossKillEvents, 'client');

    // Collective Milestones: re-evaluate the server-wide "Great Deeds" now the
    // per-player totals just advanced. Best-effort only — a milestone failure
    // (or a missing milestones table pre-migration) must NEVER fail the ingest.
    // Skipped entirely when nothing merged (no self snapshot this cycle).
    //
    // This call only RECORDS deeds (achieved_at + a Saga event) — it announces
    // nothing. The Discord bot owns the announcement, firing the embed and the
    // in-game voice line together, one deed per tick. So a cycle that crosses
    // five deeds at once writes five rows here and stays silent; the players
    // hear them spaced out over the following minutes. Safe to run on every
    // ~120s re-POST: the marking UPDATE is guarded on achieved_at is null.
    if (merged) {
      try {
        await evaluateAndRecord(db());
      } catch (e) {
        console.error('[milestones]', e instanceof Error ? e.message : e);
      }
    }
    return Response.json({ status: 'inserted' });
  }

  const client = db();
  const now = new Date().toISOString();
  const { names: rawNames, count } = parseOnline(body.onlinePlayers);
  const worldDay = typeof body.worldDay === 'number' ? Math.floor(body.worldDay) : undefined;

  // Reconcile against the log poller's join/leave trail before trusting the
  // Emitter's roster — see dropStaleLeavers() for why (stale-roster incident,
  // 2026-07-04). Everything else about the Emitter's snapshot stays authoritative.
  const names = rawNames ? await dropStaleLeavers(client, rawNames) : rawNames;

  if (names) {
    // The Emitter's roster (reconciled) is the truth: flip everyone else off, listed on.
    // Compute the offline set by ID in JS — never interpolate a character name (which
    // originates from a client-controlled roster) into a PostgREST filter string.
    const nameSet = new Set(names);
    const { data: onlineRows } = await client
      .from('players')
      .select('id, character_name')
      .eq('is_online', true);
    const goneIds = (onlineRows ?? [])
      .filter((r) => !nameSet.has(r.character_name as string))
      .map((r) => r.id as string);
    if (goneIds.length > 0) {
      await client.from('players').update({ is_online: false }).in('id', goneIds);
    }
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

  // Boss detection: the server payload's milestones flip the bosses row (the
  // authoritative first-kill trigger). players_present is set to the TRUE fighters
  // derived from THIS payload (players[] damage ∪ bossKillEvents MVPs), degrading
  // to the reconciled online roster only when no fighter is derivable. Its own
  // bossKillEvents then add the fight detail + fold the MVPs in.
  await ingestBossMilestones(body, names ?? [], parseBossFighters(body));
  await ingestBossKillEvents(body.bossKillEvents, 'server');

  return Response.json({ status: 'inserted' });
}
