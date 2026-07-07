import { createClient } from '@supabase/supabase-js';
import {
  parseSelfSnapshot,
  parseSelfDistances,
  parseBossMilestones,
  parseBossKillEvents,
  parseBossFighters,
  type ParsedBossKill,
} from '@/lib/gs-client';
import { evaluateAndRecord } from '@/lib/milestones';
import type { GsClientStats } from '@/lib/types';

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
    .eq('character_name', trimmed)
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

  // The log poller may race ahead of the client's 120s cycle and log the same
  // death first, but WITHOUT the real cause (no metadata.source, no cause). Now
  // that we have the authoritative cause row, drop any causeless poller-derived
  // death for the same character within ±3 minutes so it isn't double-counted.
  await Promise.all(
    fresh.map(async (p) => {
      const t = Date.parse(p.occurredIso);
      const lo = new Date(t - 3 * 60_000).toISOString();
      const hi = new Date(t + 3 * 60_000).toISOString();
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

  // Resolve (or create) the players row for this character (mirrors the deaths/stats paths).
  const { data: found } = await client.from('players').select('id').eq('character_name', player).limit(1);
  let pid = (found?.[0]?.id as string | undefined) ?? undefined;
  if (!pid) {
    const { data: ins } = await client
      .from('players')
      .insert({ character_name: player, first_seen_at: now, last_seen_at: now, is_online: false })
      .select('id')
      .single();
    pid = ins?.id as string | undefined;
  }
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
    .select('player_id, gs_reporter, gs_stats')
    .neq('player_id', pid);
  if (!others || others.length === 0) return;

  for (const row of others) {
    const otherName = (row.gs_reporter as string | null) ?? `player ${row.player_id}`;
    const otherWeapons = ((row.gs_stats as GsClientStats | null)?.weapons ?? []) as GsClientStats['weapons'];
    if (!Array.isArray(otherWeapons) || otherWeapons.length === 0) continue;
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
 */
async function ingestPlayerStats(body: Obj): Promise<boolean> {
  const s = parseSelfSnapshot(body);
  if (!s) return false;

  const client = db();
  const now = new Date().toISOString();

  // Resolve (or create) the players row for the reporter (mirrors the deaths path).
  const { data: found } = await client
    .from('players')
    .select('id')
    .eq('character_name', s.reporter)
    .limit(1);
  let pid = (found?.[0]?.id as string | undefined) ?? undefined;
  if (!pid) {
    const { data: ins } = await client
      .from('players')
      .insert({ character_name: s.reporter, first_seen_at: now, last_seen_at: now, is_online: false })
      .select('id')
      .single();
    pid = ins?.id as string | undefined;
  }
  if (!pid) return false;

  // Best-effort weapon-collision monitor (LOG-ONLY): flag if this reporter's
  // weapon breakdown byte-matches another character's — the sign of the
  // GsValheimStatsClient world-scoped weapons.tsv cache leaking across a
  // character switch. Wrapped like the evaluateAndRecord call below so a monitor
  // failure can NEVER fail the ingest, block it, or mutate any data.
  try {
    await warnOnWeaponCollision(client, pid, s.reporter, s.gsStats.weapons);
  } catch (e) {
    console.error('[gs-ingest] weapon-collision monitor', e instanceof Error ? e.message : e);
  }

  // Read the current row so we can GREATEST cumulative counters and avoid a
  // reset/rollback writing lower numbers (only-writer-per-row makes this safe).
  const { data: prevRows } = await client.from('player_stats').select('*').eq('player_id', pid).limit(1);
  const prev = (prevRows?.[0] ?? null) as Obj | null;
  const prevNum = (k: string): number => num(prev?.[k]);

  // Distances (metres) from the .fch profile counters: total goes to the
  // dedicated distance_traveled column; the per-mode breakdown + raw vh_ subset
  // are folded into gs_stats so future leaderboards need no further ingest
  // change. Same GREATEST guard so a profile reset can't roll it backwards.
  const dist = parseSelfDistances(body);

  // Keep the richer gs_stats blob unless this snapshot advances (guards resets).
  const advancing = s.damageDealt >= prevNum('damage_dealt');
  const baseGs = advancing ? s.gsStats : ((prev?.gs_stats as Obj | undefined) ?? s.gsStats);
  const gsStats: Obj = { ...(baseGs as Obj) };
  if (dist) {
    gsStats.distances = { total: dist.distanceTraveled, walk: dist.walk, run: dist.run, sail: dist.sail, air: dist.air };
    gsStats.distancesRaw = dist.raw;
  }

  const full: Obj = {
    player_id: pid,
    kills: Math.max(s.kills, prevNum('kills')),
    deaths: Math.max(s.deaths, prevNum('deaths')),
    resources_harvested: Math.max(s.resourcesHarvested, prevNum('resources_harvested')),
    items_crafted: Math.max(s.itemsCrafted, prevNum('items_crafted')),
    structures_built: Math.max(s.structuresBuilt, prevNum('structures_built')),
    distance_traveled: Math.max(dist?.distanceTraveled ?? 0, prevNum('distance_traveled')),
    damage_dealt: Math.max(s.damageDealt, prevNum('damage_dealt')),
    boss_kills: Math.max(s.bossKills, prevNum('boss_kills')),
    longest_life_sec: Math.max(s.longestLifeSec, prevNum('longest_life_sec')),
    best_kills_before_death: Math.max(s.bestKillsBeforeDeath, prevNum('best_kills_before_death')),
    gs_stats: gsStats,
    gs_reporter: s.reporter,
    gs_world: s.world,
    gs_updated_at: now,
    updated_at: now,
  };

  const { error } = await client.from('player_stats').upsert(full, { onConflict: 'player_id' });
  if (!error) return true;

  // Graceful degradation: if the 2026-07-04 migration hasn't been applied yet,
  // the gs_* columns don't exist — retry with only the pre-existing base columns
  // so headline counters still land.
  const base: Obj = {
    player_id: full.player_id,
    kills: full.kills,
    deaths: full.deaths,
    resources_harvested: full.resources_harvested,
    items_crafted: full.items_crafted,
    structures_built: full.structures_built,
    distance_traveled: full.distance_traveled,
    updated_at: now,
  };
  await client.from('player_stats').upsert(base, { onConflict: 'player_id' });
  return true;
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
  const { data: rows } = await client
    .from('bosses')
    .select('id, name, is_killed')
    .in('name', names);
  const byName = new Map<string, { id: string; is_killed: boolean }>(
    (rows ?? []).map((r) => [r.name as string, { id: r.id as string, is_killed: !!r.is_killed }]),
  );

  for (const m of milestones) {
    const row = byName.get(m.bossName);
    if (!row || row.is_killed) continue; // unknown boss (e.g. Bog Witch) or already felled

    const killedAt = m.tsUtc && !Number.isNaN(Date.parse(m.tsUtc)) ? new Date(m.tsUtc).toISOString() : new Date().toISOString();

    // TRUE fighters if we have any; degrade to the online roster ONLY when empty
    // (never blank a war party). The online roster is preserved separately on
    // fight_stats.onlineAtKill so the war-room can still honestly note who else
    // was in the realm without inflating the war-party.
    const fought = fighters[m.bossName] ?? [];
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
    await client
      .from('bosses')
      .update({ fight_stats: { fighters: fought, onlineAtKill: roster, source: 'gs-milestone' } })
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

type FightStats = {
  fightSec?: number;
  firstBlood?: string | null;
  topDamagePlayer?: string | null;
  topDamage?: number;
  participants?: number;
  tsUtc?: string;
  source?: string;
  fighters?: string[];
  onlineAtKill?: string[];
};

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

    // Automatic cartography from the client plugin: write only map_explored_pct (GREATEST).
    if (body.source === 'client-map') {
      const r = await ingestClientMap(body as Record<string, unknown>);
      return Response.json(
        r.ok ? { status: 'inserted', map_explored_pct: r.pct, player: r.player } : { status: 'ignored', reason: 'bad client-map payload' },
      );
    }

    // Server-presence cross-check (see confirmOnThisServer): before merging ANY
    // client-reported stats, require independent proof — the log poller's
    // join/leave trail for THIS server — that the reporter is actually connected
    // here right now. The client mod self-reports its target world + POST URL from
    // unverifiable local config, so a character/profile carried onto a DIFFERENT
    // server (config still pointed here) would otherwise pour that other server's
    // play into this dashboard, polluting every stat column. Mirrors the world-
    // mismatch early-return above: on positive offline evidence we ack with 200
    // and drop the payload, so the mod never retry-storms. One-sided: no reporter
    // name, or no positive offline evidence, always falls through and ingests.
    const reporter = typeof body.reporter === 'string' ? body.reporter.trim() : '';
    if (reporter) {
      const presence = await confirmOnThisServer(reporter);
      if (!presence.onServer) {
        console.warn(
          `[gs-ingest] PRESENCE REJECT: "${reporter}" — ${presence.reason}. ` +
            `Ignoring this client payload (deaths, per-player stats, boss-kill events) ` +
            `to protect Eilif stats from a mod profile reused on a different server.`,
        );
        return Response.json({ status: 'ignored', reason: 'not connected to this server' });
      }
    }

    await ingestDeathEvents(body.deathEvents);
    const merged = await ingestPlayerStats(body as Record<string, unknown>);
    // Client payloads also carry bossKillEvents (this client's view of a fight)
    // — enrich, but never flip a boss from a client (the server milestone owns that).
    await ingestBossKillEvents(body.bossKillEvents, 'client');

    // Collective Milestones: re-evaluate the server-wide "Great Deeds" now the
    // per-player totals just advanced. Best-effort only — a milestone failure
    // (or a missing milestones table pre-migration) must NEVER fail the ingest.
    // Skipped entirely when nothing merged (no self snapshot this cycle).
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

  // Boss detection: the server payload's milestones flip the bosses row (the
  // authoritative first-kill trigger). players_present is set to the TRUE fighters
  // derived from THIS payload (players[] damage ∪ bossKillEvents MVPs), degrading
  // to the reconciled online roster only when no fighter is derivable. Its own
  // bossKillEvents then add the fight detail + fold the MVPs in.
  await ingestBossMilestones(body, names ?? [], parseBossFighters(body));
  await ingestBossKillEvents(body.bossKillEvents, 'server');

  return Response.json({ status: 'inserted' });
}
