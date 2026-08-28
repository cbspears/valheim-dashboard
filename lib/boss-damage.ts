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
// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER HALF OF THAT NIGHT: OBSERVED (BYSTANDER) DAMAGE — foldObservedDamage.
//
// The fallback above credits the REPORTER only, and on the Eikthyr kill that was
// still not the whole war party. In Valheim multiplayer damage is computed on
// whichever client OWNS the creature's ZDO (Character.RPC_Damage runs there), and
// the mod is designed around it — 0.2.0 changelog: "whichever client owns a
// creature records the damage EVERY player deals to it, attributed to the real
// attacker". ChÆrleif's client owned Eikthyr, so his payload carried his own 201
// points in players[0] AND Bren's and Lóa's shares as bystander entries. Nothing
// read those, and ~300 of the beast's 500 HP stayed unattributed.
//
// WHY THIS CANNOT DOUBLE-COUNT AGAINST THE REPORTER-OWN PATH. Because each blow
// is recorded by EXACTLY ONE client — the owner at the instant it landed. Own-
// entry damage is "blows my own client recorded"; bystander damage is "blows the
// observer's client recorded". The two sets are disjoint by construction, not by
// luck: Bren's own snapshot carries only what Bren's client owned, and ChÆrleif's
// observation of Bren carries only what ChÆrleif's client owned. No blow is in
// both, so folding both paths sums the fight rather than inflating it. (When two
// observers both watched a fight they still each report only their own share, and
// the per-observer ledger below keeps those shares separate.)
//
// WHY A PER-OBSERVER LEDGER. The observed numbers are CUMULATIVE per world and
// re-posted every ~120s, exactly like the reporter's own. There is no `prev` row
// to difference against here (this damage never touches player_stats — see
// below), so fight_stats carries its own memory: `observed[observer][player]` is
// the last cumulative reading THIS observer reported for THAT player on THIS
// boss. Each post credits `cum − prev` and only when positive. The ledger NEVER
// decreases: a smaller reading (a mod restart, a stale post, a re-post racing
// ahead) is ignored rather than written down, because lowering it would let the
// very same blows be credited a second time on the next post.
//
// WHY NO gs_baseline HERE. The reporter-own path differences BASELINED values so
// an imported veteran's lifetime damage on somebody else's server credits nothing.
// The observed numbers need no such zero-point: the mod's combat file is scoped
// per WORLD (and since 0.2.12 per character+world), so what a bystander is seen
// to have dealt is by construction damage dealt on THIS world — a veteran's
// other-server career simply is not in that file. Cross-server reuse of the whole
// payload is a different threat, and it is already gated in the route by the
// GS_EXPECTED_WORLD guard plus the log-poller presence cross-check
// (confirmOnThisServer) before any of this runs.
//
// NEVER INTO player_stats. Observed damage is a bystander's account of someone
// else's combat: it is proof enough for a fight record (a bystander cannot deal
// boss damage) and nowhere near enough for a career total, which stays
// reporter-own-entry-only so there is exactly one authoritative writer per row.
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
  /**
   * The OBSERVED-damage ledger: observer (reporting client) name → observed
   * fighter name → the last cumulative damage that observer reported for that
   * fighter ON THIS BOSS. Not a score — a high-water mark, the memory
   * foldObservedDamage differences each post against so a cumulative reading
   * re-posted every ~120s is credited exactly once. Grows only: a smaller
   * reading is ignored, never written down (see the module header).
   */
  observed?: Record<string, Record<string, number>>;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// Keys that must NEVER index a plain-object ledger / damage map: __proto__ (whose
// setter reparents the object) plus constructor / prototype (own-property shadows
// that corrupt every later read). No Valheim character is meaningfully named these
// — but a client payload is unauthenticated, and an attacker's `reporter:'__proto__'`
// reaching `ledger[who] ??= {}` in foldObservedDamage would otherwise write onto
// Object.prototype for the whole serverless instance's life. `name()` is the single
// gate every key here passes through (both the read side — readObserved/readDamage/
// readFighters — and the write side — foldClientDamage/foldObservedDamage), so
// rejecting them here closes the hole for all of them at once.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Non-empty trimmed string that is safe as an object key, or null. From jsonb. */
function name(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || UNSAFE_KEYS.has(t)) return null;
  return t;
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

/**
 * The stored observed-damage ledger, narrowed to real names and finite
 * non-negative numbers — same discipline as readDamage, for the same reason: this
 * blob round-trips through jsonb and a junk entry must read as "no prior
 * reading" (credit the full cumulative once) rather than poison the arithmetic.
 * Returns a fresh, detached copy so the caller can advance it in place.
 */
function readObserved(existing: FightStats | null): Record<string, Record<string, number>> {
  const raw = existing?.observed;
  const out: Record<string, Record<string, number>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [obs, byPlayer] of Object.entries(raw as Record<string, unknown>)) {
    const o = name(obs);
    if (!o || !byPlayer || typeof byPlayer !== 'object' || Array.isArray(byPlayer)) continue;
    const bucket: Record<string, number> = {};
    for (const [player, v] of Object.entries(byPlayer as Record<string, unknown>)) {
      const p = name(player);
      if (!p || !isFiniteNum(v) || v < 0) continue;
      bucket[p] = v;
    }
    if (Object.keys(bucket).length > 0) out[o] = bucket;
  }
  return out;
}

/**
 * Fold ONE observer's OBSERVED per-boss cumulative damage into a bosses row's
 * fight_stats — the bystander half of the Eikthyr incident, documented in full at
 * the top of this module.
 *
 * `playerCums` is that observer's reading, for THIS boss, of what each OTHER
 * viking has cumulatively dealt to it (lib/gs-client parseObservedBossDamage,
 * canonicalized against the roster by the route). For each of them:
 *
 *   • prev = the last reading this observer filed for that player on this boss
 *     (fight_stats.observed[observer][player], 0 when never seen).
 *   • delta = cum − prev. A POSITIVE delta is credited exactly as the
 *     reporter-own path credits its own delta — by calling foldClientDamage, so
 *     there is ONE implementation of the fighters/damage/verdict rules and not a
 *     second copy here that can drift — and the ledger advances to `cum`.
 *   • delta ≤ 0 changes nothing at all, and in particular DOES NOT lower the
 *     ledger. A smaller cumulative is a stale or restarted client, not a refund;
 *     writing it down would let the blows between it and the high-water mark be
 *     credited all over again on the next post.
 *
 * Returns NULL when nothing was credited (no positive delta, a nameless observer,
 * junk input) so the caller skips the write entirely rather than churn the row —
 * the same contract foldClientDamage keeps, and the reason a re-posted snapshot
 * is a true no-op down to the database.
 *
 * Every foldClientDamage guarantee therefore holds here too: `fighters` is a
 * monotonic union, `damage` accumulates and never decreases, the top-damage
 * verdict is recomputed ONLY while it is ours to recompute (a real MVP summary's
 * verdict is never overwritten), `source` is stamped only onto a row that had no
 * fight detail at all, and every other field is carried through untouched.
 */
export function foldObservedDamage(
  existing: FightStats | null,
  observer: string,
  playerCums: Record<string, number>,
): FightStats | null {
  const who = name(observer);
  if (!who) return null;
  if (!playerCums || typeof playerCums !== 'object' || Array.isArray(playerCums)) return null;

  const ledger = readObserved(existing);
  const mine = (ledger[who] ??= {});

  let next: FightStats | null = existing;
  let credited = false;

  for (const [rawPlayer, cum] of Object.entries(playerCums)) {
    const player = name(rawPlayer);
    if (!player || !isFiniteNum(cum) || cum <= 0) continue;

    // Read the prev from the LIVE ledger, not from `existing`: two keys that trim
    // to the same viking ("Bren" and "Bren ") must difference against each other,
    // not both against the stored reading and credit the same blows twice.
    const prev = mine[player] ?? 0;
    const delta = cum - prev;
    if (!(delta > 0)) continue; // stale, duplicate, or a shrunken reading — the ledger stands

    const folded = foldClientDamage(next, player, delta);
    if (!folded) continue; // defensive: the shared fold owns the rules, including its own refusals
    next = folded;
    mine[player] = cum;
    credited = true;
  }

  if (!credited || !next) return null;
  return { ...next, observed: ledger };
}
