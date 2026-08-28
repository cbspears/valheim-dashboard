// Client-damage fallback for bosses.fight_stats — the honest war party derived
// from what the vikings actually hit the beast for, when no MVP summary ever
// arrives.
//
// THE GAP THIS FILLS (real incident, the Eikthyr kill of 2026-08-28 03:49Z).
// bosses.fight_stats.fighters / topDamagePlayer only ever grew from
// bossKillEvents[] MVP summaries (ingestBossKillEvents in /api/gs-ingest), and on
// that night NOT ONE producer emitted a bossKillEvents entry — not the server-side
// Emitter, not a single client. The milestone flip fired correctly, the row went
// is_killed=true with the online roster on players_present, and fight_stats landed
// as `{ fighters: [], onlineAtKill: [...], source: 'gs-milestone' }`. An empty
// fighter set, so the war-room fell back to players_present (the roster — which
// cannot tell a fighter from a bystander standing at the base camp) and the Fight
// Record showed no top damage at all. Meanwhile ChÆrleif's own client HAD posted
// his real per-boss damage — 201 effective points against Eikthyr — straight into
// player_stats.gs_stats.bossDamage. The evidence was in the database the whole
// time; nothing was reading it.
//
// THE PRINCIPLE. A bystander cannot deal boss damage. So a POSITIVE per-boss
// damage delta on a client's own cumulative snapshot is proof — the same class of
// proof ingestBossKillEvents already trusts from firstBlood/topDamagePlayer — that
// this character swung at that boss. It is a strict SUBSET of the true fighters
// (a fighter who deals literally zero damage is invisible to it), so unioning it
// into `fighters` can only ever add someone real, never a bystander, and never
// shrinks the war party.
//
// WHY A DELTA AND NOT THE TOTAL. gs_stats.bossDamage is CUMULATIVE and re-posted
// every ~120s. Crediting the total on every post would re-count the same blows
// forever. The delta between the row as it was and the row as it now is, taken at
// the exact moment /api/gs-ingest merges a client snapshot, is precisely "what
// this viking landed since we last looked" — and because the merge is a per-key
// GREATEST (lib/gs-baseline mergeIntoRow), that delta is non-negative by
// construction and a stale / duplicate / out-of-order re-post yields exactly 0.
//
// WHY THE BASELINE MAKES THIS SAFE. The values differenced here are the EFFECTIVE
// (baselined) ones — `raw − gs_baseline` — so an imported veteran's lifetime
// damage against Eikthyr on somebody else's server contributes nothing: their
// first snapshot captures the zero-point, effective reads 0, and the delta is 0.
// The same holds for a baseline HOLE the moment it fills (raw − raw). We credit
// exactly what player_stats itself credits — no more, no less.
//
// PURE MODULE — no Supabase, no I/O, so scripts/gs-boss-damage.test.mjs can drive
// every rule directly and scripts/backfill-eikthyr-fight.mjs can reuse the very
// same fold. /api/gs-ingest owns the reads and writes.

import { mapBossObject } from './gs-client';

/**
 * The provenance stamp this module writes. Two jobs, and they are different:
 *
 *   • `fight_stats.source` — set only when the row had no fight detail at all,
 *     so a row born of this fallback says where it came from.
 *   • `fight_stats.topDamageFrom` — set on EVERY top-damage verdict we compute,
 *     and it is the flag that keeps us honest. A real MVP summary
 *     (ingestBossKillEvents) rewrites the scalars WITHOUT it, so the marker
 *     retires the instant a true verdict lands and we never touch the verdict
 *     again. `source` alone could not do this: the milestone flip stamps
 *     'gs-milestone' over whatever we set, which would have frozen our own
 *     verdict after a single fold.
 */
export const CLIENT_DAMAGE_SOURCE = 'gs-client-damage';

/**
 * bosses.fight_stats (jsonb). Single definition — /api/gs-ingest imports it
 * rather than keeping a second copy that can drift.
 */
export interface FightStats {
  fightSec?: number;
  firstBlood?: string | null;
  topDamagePlayer?: string | null;
  topDamage?: number;
  participants?: number;
  tsUtc?: string;
  source?: string;
  /** The TRUE fighters — monotonic union, grows only (never blanked/shrunk). */
  fighters?: string[];
  /** The reconciled online roster at kill time (seeded at the milestone flip). */
  onlineAtKill?: string[];
  /** fighter name → boss damage credited to this fight by the client-damage fallback. */
  damage?: Record<string, number>;
  /** CLIENT_DAMAGE_SOURCE while the top-damage verdict is ours to recompute. */
  topDamageFrom?: string;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Non-empty trimmed string, or null. Everything here comes from jsonb. */
function name(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * `gs_stats.bossDamage` (`[{ boss, damageDealt, fightSec }]`) → `{ boss: damage }`,
 * keyed by the RAW creature gameObject name the mod reports ('Eikthyr', 'gd_king',
 * …) — the mapping to `bosses.name` happens later, once.
 *
 * Defensive on every field: this blob round-trips through jsonb written from a
 * third-party mod's payload, and a shape we don't recognize must read as "no
 * damage" (credit nothing), never throw.
 */
export function bossDamageMap(gsStats: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = (gsStats as { bossDamage?: unknown } | null | undefined)?.bossDamage;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const boss = name((row as { boss?: unknown }).boss);
    const dmg = (row as { damageDealt?: unknown }).damageDealt;
    if (!boss || !isFiniteNum(dmg) || dmg <= 0) continue;
    // Duplicate entries for one boss shouldn't happen (mergeGsStats folds by
    // key), but max-on-dupe matches how every other breakdown in this codebase
    // collapses them — and it keeps the delta monotonic if one ever appears.
    out[boss] = Math.max(out[boss] ?? 0, dmg);
  }
  return out;
}

/**
 * What one client post actually ADDED, per boss: `after − before` over the two
 * bossDamage maps, keyed by `bosses.name`.
 *
 * `before` is the row as it was read pre-merge; `after` is the row about to be
 * written (post per-key GREATEST). Only strictly-positive deltas survive:
 *   • absent from `after`     → nothing to say.
 *   • unchanged / smaller     → 0 or negative → dropped (an idempotent re-post,
 *     or a stale snapshot the GREATEST merge already refused).
 *   • a boss key we can't map → dropped (mini-bosses like Serpent, and anything
 *     a future game update adds that BOSS_OBJECT_TO_NAME doesn't know yet).
 *
 * Two raw keys that map to the same bosses.name are summed, so a "(Clone)"
 * suffixed variant lands on the same row rather than racing it.
 */
export function bossDamageDeltas(prevGsStats: unknown, nextGsStats: unknown): Map<string, number> {
  const before = bossDamageMap(prevGsStats);
  const after = bossDamageMap(nextGsStats);
  const deltas = new Map<string, number>();
  for (const [raw, now] of Object.entries(after)) {
    const delta = now - (before[raw] ?? 0);
    if (!(delta > 0)) continue;
    const bossName = mapBossObject(raw);
    if (!bossName) continue;
    deltas.set(bossName, (deltas.get(bossName) ?? 0) + delta);
  }
  return deltas;
}

/** The stored fighter list, narrowed to real names and deduped. */
function readFighters(existing: FightStats | null): string[] {
  const raw = existing?.fighters;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const n = name(v);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** The stored damage map, narrowed to real names and finite non-negative numbers. */
function readDamage(existing: FightStats | null): Record<string, number> {
  const raw = existing?.damage;
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = name(k);
    if (!n || !isFiniteNum(v) || v < 0) continue;
    out[n] = v;
  }
  return out;
}

/**
 * Is the top-damage verdict ours to (re)compute?
 *
 * ONLY when nobody has carved a real one: the slot is empty, or the standing
 * verdict is one WE wrote (topDamageFrom). An MVP summary's verdict — the
 * fight's own record of who struck hardest, which knows things a cumulative
 * career total never can — is never overwritten. That is the whole contract with
 * ingestBossKillEvents, and it holds in both arrival orders: a summary landing
 * after us drops the marker along with our number, and we stand down for good.
 */
function verdictIsOurs(existing: FightStats | null): boolean {
  if (!name(existing?.topDamagePlayer)) return true;
  return existing?.topDamageFrom === CLIENT_DAMAGE_SOURCE;
}

/**
 * Fold one viking's boss-damage delta into a bosses row's fight_stats.
 *
 * Returns the next fight_stats, or NULL when there is nothing to do — a
 * non-positive delta or a nameless reporter — so the caller can skip the write
 * entirely rather than churn the row.
 *
 * Every existing guarantee is kept:
 *   • `fighters` is a monotonic union — the reporter is added, nobody is removed.
 *   • `damage` accumulates per name and never decreases.
 *   • every other field (fightSec, firstBlood, tsUtc, participants, onlineAtKill,
 *     the roster-at-kill) is carried through untouched.
 *   • `source` is only stamped onto a row that had no fight detail at all.
 *
 * DELIBERATELY INDIFFERENT TO is_killed. Damage accrues before the kill lands so
 * the record is complete the moment it does — a two-session grind against
 * Bonemass has its war party already carved when the milestone finally fires.
 * (ingestBossMilestones unions rather than replaces at that flip, so the seed
 * cannot blank what accrued.)
 */
export function foldClientDamage(
  existing: FightStats | null,
  reporter: string,
  delta: number,
): FightStats | null {
  const who = name(reporter);
  if (!who || !isFiniteNum(delta) || delta <= 0) return null;

  const fighters = readFighters(existing);
  if (!fighters.includes(who)) fighters.push(who);

  const damage = readDamage(existing);
  damage[who] = (damage[who] ?? 0) + delta;

  const next: FightStats = { ...(existing ?? {}), fighters, damage };

  if (verdictIsOurs(existing)) {
    // Highest damage wins; ties break on name so two equal scores always produce
    // the same row and a re-post is a genuine no-op rather than a coin flip.
    const top = Object.entries(damage).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top) {
      next.topDamagePlayer = top[0];
      next.topDamage = Math.round(top[1]);
      next.topDamageFrom = CLIENT_DAMAGE_SOURCE;
    }
  }

  // Provenance for a row this fallback brought into being. An existing source —
  // 'gs-milestone' from the kill flip, 'server'/'client' from a real fight report
  // — is the truth about where the row came from and is left alone.
  if (!name(next.source)) next.source = CLIENT_DAMAGE_SOURCE;

  return next;
}
