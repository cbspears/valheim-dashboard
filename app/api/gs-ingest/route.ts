import { createClient } from '@supabase/supabase-js';
import {
  parseSelfSnapshot,
  parseSelfDistances,
  parseBossMilestones,
  parseBossKillEvents,
  type ParsedBossKill,
} from '@/lib/gs-client';

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

/** Merge the reporter's cumulative snapshot into player_stats (idempotent, GREATEST). */
async function ingestPlayerStats(body: Obj): Promise<void> {
  const s = parseSelfSnapshot(body);
  if (!s) return;

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
  if (!pid) return;

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
  if (!error) return;

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
async function ingestBossMilestones(body: Record<string, unknown>, roster: string[]): Promise<void> {
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

    // Guarded flip: .eq('is_killed', false) makes the re-POST a no-op and the
    // returned rows tell us whether WE were the one to fell it (→ emit event once).
    const { data: flipped } = await client
      .from('bosses')
      .update({ is_killed: true, killed_at: killedAt, players_present: roster })
      .eq('id', row.id)
      .eq('is_killed', false)
      .select('id');

    if (!flipped || flipped.length === 0) continue; // lost the race / already flipped

    await client.from('events').insert({
      type: 'boss',
      character_name: null,
      metadata: {
        boss: m.bossName,
        players: `${roster.length} viking${roster.length === 1 ? '' : 's'}`,
        milestoneKey: m.key,
        source: 'gs-milestone',
      },
      created_at: killedAt,
    });
  }
}

// Enrich a felled boss with the fight detail from bossKillEvents[] (emitted by
// BOTH the server and participating clients). Canonical home is bosses.fight_stats
// (jsonb) — renderable by the /boss "Full Record" surface. Order-independent and
// idempotent: dedupe on the boss's tsUtc, and prefer the report with the most
// participants (the server's server-wide view beats any single client's). If the
// fight_stats column doesn't exist yet (pre-migration), fall back to stashing the
// detail on the matching boss event row's metadata so nothing is lost.
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
    .select('id, name, fight_stats')
    .in('name', names);

  for (const row of rows ?? []) {
    const e = best.get(row.name as string);
    if (!e) continue;
    const incoming = {
      fightSec: e.fightSec,
      firstBlood: e.firstBlood,
      topDamagePlayer: e.topDamagePlayer,
      topDamage: e.topDamage,
      participants: e.participants,
      tsUtc: e.tsUtc,
      source,
    };
    const existing = (row as { fight_stats?: { tsUtc?: string; participants?: number } | null }).fight_stats ?? null;
    // Dedupe / prefer richer: skip when we already hold this fight with at least
    // as many participants.
    if (existing && existing.tsUtc === e.tsUtc && (existing.participants ?? 0) >= e.participants) continue;

    const { error } = await client.from('bosses').update({ fight_stats: incoming }).eq('id', row.id);
    if (!error) continue;

    // Graceful degradation (fight_stats column missing): merge onto the latest
    // boss event row for this boss instead.
    const { data: ev } = await client
      .from('events')
      .select('id, metadata')
      .eq('type', 'boss')
      .eq('metadata->>boss', e.bossName)
      .order('created_at', { ascending: false })
      .limit(1);
    const evRow = ev?.[0];
    if (evRow) {
      await client
        .from('events')
        .update({ metadata: { ...(evRow.metadata as Record<string, unknown>), fight: incoming } })
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
    await ingestDeathEvents(body.deathEvents);
    await ingestPlayerStats(body as Record<string, unknown>);
    // Client payloads also carry bossKillEvents (this client's view of a fight)
    // — enrich, but never flip a boss from a client (the server milestone owns that).
    await ingestBossKillEvents(body.bossKillEvents, 'client');
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

  // Boss detection: the server payload's milestones flip the bosses row (the
  // authoritative first-kill trigger); its own bossKillEvents add fight detail.
  await ingestBossMilestones(body, names ?? []);
  await ingestBossKillEvents(body.bossKillEvents, 'server');

  return Response.json({ status: 'inserted' });
}
