// Compare-and-swap for bosses.fight_stats — the one writer every fold goes through.
//
// THE BUG THIS CLOSES (reproduced by `npm run smoke`, 2026-09-05).
// Four places in /api/gs-ingest wrote fight_stats, and all four did the same
// thing: SELECT the row, fold the new fact into the blob in TypeScript, then
// `update({ fight_stats: next }).eq('id', row.id)` unconditionally. That is a
// read-modify-write with no guard, and the ingest is not serial: twenty clients
// re-POST their CUMULATIVE snapshot every ~120s (plus duplicate re-POSTs, plus
// the server Emitter, plus the observed-damage half of the same payload), so two
// requests touching the same boss interleave as
//
//     A reads {damage:{Astrid:196}} … B reads {damage:{Astrid:196}}
//     A writes {damage:{Astrid:331}} … B writes {damage:{Astrid:196+…}}
//
// and B's write silently discards A's fold. The smoke run showed it exactly:
// the ingest log credited Astrid +82, +114 and +135 on Eikthyr (331 in total)
// and the stored per-fighter damage was 196 — short by the last fold — with the
// boss total short by the same 135. Two invariants failed on it, "Eikthyr
// per-fighter damage attributed correctly" and "Eikthyr damage total not
// double-counted".
//
// WHY A REV INSIDE THE JSON AND NOT A COLUMN. A `version` column, a row lock, or
// a jsonb_set() RPC would each be the textbook answer and each needs a migration
// applied by hand against production (see CLAUDE.md — there is no migration
// runner here, and this lands four days before launch). A monotonically
// increasing integer stored INSIDE the fight_stats blob needs none: PostgREST
// can filter on a JSON path, so the update carries its own precondition
//
//     PATCH /bosses?id=eq.<id>&fight_stats->>rev=eq.<the rev we read>
//
// and Postgres decides the race, not us. A writer whose rev has moved on matches
// ZERO rows, learns it lost from the empty representation, re-reads and re-folds
// against what is actually stored. Nothing is lost, because the fold is re-run
// on the fresh row rather than replayed from a stale one.
//
//   • `fight_stats->>rev=eq.N` when the row we read carried a rev.
//   • `fight_stats->>rev=is.null` when it did not — `->>` yields SQL NULL both
//     for a missing key and for a NULL fight_stats, which is precisely the "no
//     rev yet" state (a legacy row, a freshly seeded boss, or a row the launch
//     wipe blanked). The first writer to stamp rev=1 wins and every other
//     contender misses and retries.
//
// WHAT THIS DOES NOT DO. It does not make the folds atomic across bosses, and it
// does not serialise anything: it detects a lost update and redoes the work.
// That is enough here because every fold is pure, idempotent-by-construction and
// re-runnable — `foldClientDamage` credits a delta computed once from the
// payload, `foldObservedDamage` differences against a high-water ledger read out
// of the row itself, and `planBossKillUpdate` derives everything from `existing`
// plus the report. Re-running any of them on a FRESHER `existing` yields the
// same fact folded onto more history, which is the correct answer.
//
// Nothing player-facing reads `rev` — every consumer of fight_stats (app/boss,
// lib/types, services/discord-bot recap/format/retelling/bosspoll/chronicle)
// reads named keys only, so an extra integer is inert.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FightStats } from '@/lib/boss-damage';

/** How many times a writer re-reads and re-folds before it gives up and logs. */
export const FIGHT_STATS_CAS_ATTEMPTS = 6;

/** Backoff between CAS misses, jittered so two contenders do not re-collide in lockstep. */
const BACKOFF_MIN_MS = 25;
const BACKOFF_MAX_MS = 150;

/** The boss row as every fold sees it — always the FRESH read, never a stale one. */
export interface FightStatsRow {
  id: string;
  is_killed: boolean;
  fight_stats: FightStats | null;
  players_present: string[];
}

/**
 * What happened.
 *   • 'written'  — the CAS landed; the row now holds what the fold returned.
 *   • 'noop'     — the fold declined (nothing to credit, or the row's state means
 *                  this writer has no work). No write was attempted.
 *   • 'gave-up'  — a read/write error, or the rev moved under us
 *                  FIGHT_STATS_CAS_ATTEMPTS times. One error line is logged and
 *                  the fact is dropped; the producer re-POSTs its cumulative
 *                  snapshot within ~120s, so this self-heals rather than
 *                  compounding (the same contract the un-CAS'd writes kept for a
 *                  failed update).
 */
export type FoldFightStatsOutcome = 'written' | 'noop' | 'gave-up';

export interface FoldFightStatsOptions {
  /** Prefix for the log lines this helper emits. */
  label?: string;
  /**
   * Columns to write ALONGSIDE fight_stats in the same statement. Called with the
   * FRESH row and the folded blob on every attempt, so a players_present union
   * recomputed here unions against what is actually stored, not a stale read.
   */
  extraPatch?: (row: FightStatsRow, next: FightStats) => Record<string, unknown> | null | undefined;
  /**
   * Extra equality preconditions ANDed onto the CAS — the milestone flip's
   * `is_killed=false` guard, which is what makes the kill exactly-once. A miss
   * caused by one of these looks identical to a rev miss, so the fold must also
   * inspect `row` and return null when the guard can no longer hold (that is the
   * 'noop' = "somebody else already flipped it" signal).
   */
  extraFilter?: Record<string, unknown>;
  /** Test seam: the jittered backoff between attempts. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The stored rev, or null when this row has never been stamped. */
function revOf(existing: FightStats | null): number | null {
  const v = existing?.rev;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Read → fold → compare-and-swap one boss's fight_stats, retrying the whole
 * cycle (read included) whenever another writer got there first.
 *
 * `fold` MUST be pure and re-runnable: it is called once per attempt, on a
 * freshly read `existing`, and its return value is what gets stored. Returning
 * null means "nothing to do" and skips the write entirely.
 *
 * The caller never sets `rev`; this helper stamps `existing.rev + 1` onto
 * whatever the fold returns, so a fold that whitelists its output keys (as
 * planBossKillUpdate deliberately does) cannot drop the counter.
 */
export async function foldFightStats(
  client: SupabaseClient,
  bossId: string,
  fold: (existing: FightStats | null, row: FightStatsRow) => FightStats | null,
  opts: FoldFightStatsOptions = {},
): Promise<FoldFightStatsOutcome> {
  const label = opts.label ?? 'fight_stats';
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= FIGHT_STATS_CAS_ATTEMPTS; attempt++) {
    const { data, error } = await client
      .from('bosses')
      .select('id, is_killed, fight_stats, players_present')
      .eq('id', bossId)
      .limit(1);
    if (error) {
      console.error(`[gs-ingest] ${label}: could not read boss ${bossId} — ${error.message}`);
      return 'gave-up';
    }
    const raw = (data ?? [])[0] as Record<string, unknown> | undefined;
    if (!raw) {
      // The row vanished mid-flight (a launch wipe, a reseed). Nothing to fold onto.
      return 'noop';
    }
    const row: FightStatsRow = {
      id: String(raw.id),
      is_killed: raw.is_killed === true,
      fight_stats: ((raw.fight_stats ?? null) as FightStats | null),
      players_present: Array.isArray(raw.players_present)
        ? (raw.players_present as unknown[]).filter((n): n is string => typeof n === 'string')
        : [],
    };

    const existing = row.fight_stats;
    const folded = fold(existing, row);
    if (!folded) return 'noop';

    // The counter is stamped HERE, after the fold, so it cannot be forgotten by a
    // fold that rebuilds its output from a whitelist of keys.
    const priorRev = revOf(existing);
    const next: FightStats = { ...folded, rev: (priorRev ?? 0) + 1 };

    const patch: Record<string, unknown> = { fight_stats: next, ...(opts.extraPatch?.(row, next) ?? {}) };

    let q = client.from('bosses').update(patch).eq('id', bossId);
    for (const [column, value] of Object.entries(opts.extraFilter ?? {})) {
      q = q.eq(column, value);
    }
    // THE COMPARE-AND-SWAP. PostgREST JSON-path filter on the jsonb column: the
    // update only touches the row if its rev is still the one we folded onto.
    q = priorRev === null ? q.is('fight_stats->>rev', null) : q.eq('fight_stats->>rev', String(priorRev));

    const { data: written, error: writeErr } = await q.select('id');
    if (writeErr) {
      console.error(`[gs-ingest] ${label}: could not write fight_stats for boss ${bossId} — ${writeErr.message}`);
      return 'gave-up';
    }
    if ((written?.length ?? 0) > 0) return 'written';

    // Zero rows: somebody else moved the rev between our read and our write (or an
    // extraFilter precondition stopped holding). Re-read and re-fold — never
    // re-issue the same write, which is exactly how the fold got lost before.
    if (attempt < FIGHT_STATS_CAS_ATTEMPTS) {
      await sleep(BACKOFF_MIN_MS + Math.floor(Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS + 1)));
    }
  }

  console.error(
    `[gs-ingest] ${label}: gave up on boss ${bossId} after ${FIGHT_STATS_CAS_ATTEMPTS} compare-and-swap misses — ` +
      `another writer won every attempt. The fact was dropped rather than overwriting a fresher fold; ` +
      `the producer re-posts its cumulative snapshot within ~120s.`,
  );
  return 'gave-up';
}
