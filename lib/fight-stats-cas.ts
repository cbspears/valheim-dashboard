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
//   • and a third case, which is not a filter at all: a rev nothing here can
//     name (a boolean, an object, a float that Postgres and JS print
//     differently). No filter would ever match it, so the helper refuses in one
//     read with a line that says so, rather than missing six times in silence.
//     See revOf.
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
 *   • 'gave-up'  — a read/write error, the rev moved under us
 *                  FIGHT_STATS_CAS_ATTEMPTS times, or the stored rev is a shape
 *                  no filter can match (revOf). One error line is logged and
 *                  the fact is dropped rather than forced over a fresher fold
 *                  (forcing it is the original bug). Same contract the un-CAS'd
 *                  writes kept for a failed update.
 *
 * WHAT 'gave-up' ACTUALLY COSTS, per caller — it is NOT the same everywhere, and
 * "the producer re-posts within ~120s" is only half true:
 *
 *   • ingestObservedBossDamage and ingestBossKillEvents DO self-heal. Both
 *     difference against state that lives in fight_stats itself (the observed
 *     high-water ledger; the stored MVP summary), so a write that never lands
 *     leaves that state where it was and the next ~120s snapshot re-credits the
 *     very same thing.
 *   • ingestBossDamageDeltas DOES NOT. Its delta is `nextGsStats − prevGsStats`
 *     taken across the player_stats upsert that has ALREADY committed, so once
 *     that row has advanced the delta is gone: the next post differences against
 *     the new row and computes zero for those blows. A 'gave-up' here loses that
 *     viking's damage from the fight record permanently — never double-counts
 *     it, which is the right direction to fail, but do not read the log line as
 *     "it will come back". If a boss's per-fighter damage looks short after a
 *     busy night, grep the ingest log for this label first.
 *
 * The kill itself is never at stake either way: ingestBossMilestones falls back
 * to a bare guarded flip when the compare-and-swap cannot land.
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

/**
 * The stored rev, as the compare-and-swap needs it: either a precondition it
 * can send, or a refusal.
 *
 *   • 'absent'      — `fight_stats->>rev` is SQL NULL, so the filter is
 *                     `is.null`. Postgres yields that for a NULL column, an
 *                     absent key, an explicit `{"rev":null}`, AND a fight_stats
 *                     that is not a JSON object at all (a bare string, a bare
 *                     array). It is the state of every row in production today:
 *                     nothing has ever stamped a rev there.
 *   • 'text'        — the rev EXACTLY as `->>` renders it. That projection is
 *                     TEXT, so the filter has to carry the value as Postgres
 *                     prints it, not as we would like it typed. `num` is what
 *                     the next rev counts up from.
 *   • 'unmatchable' — no filter this helper can send would match the row, so it
 *                     says so once, loudly, instead of missing six times in
 *                     silence. See foldFightStats below.
 *
 * WHAT CAN AND CANNOT BE MATCHED. Measured against Postgres 17 on 2026-09-06
 * (`select v ->> 'rev'` over each shape on the local stack), not assumed:
 *
 *     stored rev       `->>rev` renders    JS String(v)      verdict
 *     3                '3'                 '3'               text
 *     0                '0'                 '0'               text (never is.null)
 *     "3" (a string)   '3'                 '3'               text, and re-stamped
 *     1.0              '1.0'               '1'               unmatchable
 *     1e21             '1000000000000…'    '1e+21'           unmatchable
 *     true             'true'              'true'            unmatchable
 *     "abc"            'abc'               'abc'             unmatchable
 *     {"a":1}          '{"a": 1}'          '[object Object]' unmatchable
 *     [1]              '[1]'               '1'               unmatchable
 *
 * A NUMERIC STRING IS ACCEPTED AND HEALS ITSELF. If a row ever held
 * `{"rev": "7"}` — a hand-edit in the SQL editor, a restore, a future writer
 * that JSON-encodes its numbers — reading it as "no rev" would send
 * `fight_stats->>rev=is.null`, Postgres would answer zero rows (the projection
 * is the text '7'), and every writer from then on would miss six times and drop
 * its fact FOREVER, because nothing in the retry can move a rev it cannot
 * match. One boss's fight record would stop advancing with only a log line to
 * say so. Matching the text verbatim lands on the first attempt and re-stamps a
 * real number, so the row repairs itself.
 *
 * WHY THE OTHER MALFORMED SHAPES ARE REFUSED RATHER THAN GUESSED. For a float,
 * an object or an array, JS cannot reproduce Postgres' jsonb text rendering, so
 * any filter built from one would quietly match nothing. For `true` and `abc`
 * the rendering IS reproducible, but the filter value would then be a bare word
 * in a PostgREST query string, and four days before launch is not when to find
 * out how `eq.null`, `eq.true` and `eq.` are each parsed on the far side.
 * Refusing costs nothing that guessing would have earned: the outcome either
 * way is 'gave-up' with nothing written. Refusing just reaches it in one read
 * instead of six, and leaves an error line naming the boss and the stored value
 * rather than a fight record that silently stopped moving.
 *
 * So this does NOT heal those shapes. A row in one of them stays stuck until a
 * person sets the rev to an integer (or nulls fight_stats, which the launch
 * wipe already does). It stops being silent, which is the whole point.
 *
 * A finite integer rev is unaffected by any of this: `String(7) === '7'` is the
 * same filter it always was, asserted in scripts/fight-stats-cas.test.mjs §7.
 */
type RevPrecondition =
  | { kind: 'absent' }
  | { kind: 'text'; text: string; num: number }
  | { kind: 'unmatchable'; stored: string };

function revOf(existing: FightStats | null): RevPrecondition {
  const v = (existing as { rev?: unknown } | null | undefined)?.rev;
  // Undefined key, explicit null, or a fight_stats that is not an object at all
  // (a string/array has no `.rev` in JS, and `->>` is SQL NULL for it too).
  if (v === undefined || v === null) return { kind: 'absent' };
  if (typeof v === 'number') {
    // Only a SAFE INTEGER is guaranteed to render identically on both sides.
    // 1.0 prints as '1.0' in Postgres and '1' in JS; 1e21 prints as
    // '1000000000000000000000' and '1e+21'. Both were measured.
    if (Number.isSafeInteger(v)) return { kind: 'text', text: String(v), num: v };
    return { kind: 'unmatchable', stored: `the number ${v}` };
  }
  if (typeof v === 'string') {
    // A string that reads as a finite number: match it verbatim (that is what
    // `->>` returns for a JSON string) and count up from its value.
    if (v.trim() !== '' && Number.isFinite(Number(v))) return { kind: 'text', text: v, num: Number(v) };
    return { kind: 'unmatchable', stored: `the string ${JSON.stringify(v)}` };
  }
  return { kind: 'unmatchable', stored: `a JSON ${Array.isArray(v) ? 'array' : typeof v}` };
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

    // READ THE REV BEFORE THE FOLD RUNS, not after (2026-09-06). `existing` is
    // handed to caller-supplied code, and the precondition this whole helper
    // rests on must be taken from the row as it was READ. None of today's four
    // folds mutates it (they all rebuild — lib/boss-damage readFighters,
    // readDamage and readObserved each return fresh objects), but a fold that
    // ever did would move `priorRev` out from under the compare-and-swap: the
    // filter would name a rev the row does not carry, every attempt would match
    // zero rows, and the writer would give up and drop its fact with no error
    // anywhere. Reading first costs nothing and removes the trap.
    const priorRev = revOf(existing);
    const folded = fold(existing, row);
    if (!folded) return 'noop';

    // A rev this helper cannot name in a filter (see revOf above). Every attempt
    // would match zero rows, so the six retries are pure waste and the operator
    // would be left with the generic "another writer won every attempt" line for
    // a row nobody is contending. Say what is actually wrong, once, and stop.
    // The fold has already been run, so a caller with a degraded path (see
    // ingestBossKillEvents' events-row fallback) still has its product.
    if (priorRev.kind === 'unmatchable') {
      console.error(
        `[gs-ingest] ${label}: boss ${bossId} carries a fight_stats.rev this writer cannot compare ` +
          `against — ${priorRev.stored}. Nothing was written and nothing will be until someone sets ` +
          `that rev to a whole number (or nulls the row's fight_stats, which re-seeds it cleanly). ` +
          `Only a rev written by this helper, or a numeric string, can be matched — see revOf in ` +
          `lib/fight-stats-cas.ts.`,
      );
      return 'gave-up';
    }

    // The counter is stamped onto the fold's OUTPUT, after it returns, so it
    // cannot be forgotten by a fold that rebuilds from a whitelist of keys
    // (planBossKillUpdate does exactly that). It counts up from the rev captured
    // above, never from anything the fold produced.
    const next: FightStats = { ...folded, rev: (priorRev.kind === 'text' ? priorRev.num : 0) + 1 };

    const patch: Record<string, unknown> = { fight_stats: next, ...(opts.extraPatch?.(row, next) ?? {}) };

    let q = client.from('bosses').update(patch).eq('id', bossId);
    for (const [column, value] of Object.entries(opts.extraFilter ?? {})) {
      q = q.eq(column, value);
    }
    // THE COMPARE-AND-SWAP. PostgREST JSON-path filter on the jsonb column: the
    // update only touches the row if its rev is still the one we folded onto.
    q =
      priorRev.kind === 'absent'
        ? q.is('fight_stats->>rev', null)
        : q.eq('fight_stats->>rev', priorRev.text);

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

  // THE LINE SOMEBODY READS AT 11PM. It used to end "the producer re-posts its
  // cumulative snapshot within ~120s", which is true of two callers and false of
  // the third — and the false one is the case where the reassurance matters,
  // because that fact is gone for good. The per-caller truth belongs here and
  // not only in the TSDoc above, since this string is what reaches the log.
  console.error(
    `[gs-ingest] ${label}: gave up on boss ${bossId} after ${FIGHT_STATS_CAS_ATTEMPTS} compare-and-swap misses — ` +
      `another writer won every attempt. The fact was dropped rather than overwriting a fresher fold. ` +
      `Whether it comes back depends on which caller this is, so do not assume it does: ` +
      `"observed boss damage" and "bossKillEvents" both re-credit from state kept inside fight_stats ` +
      `and DO return on the next ~120s snapshot; "boss-damage fallback" does NOT — its delta was taken ` +
      `across a player_stats row that has already advanced, so those blows are gone from the fight ` +
      `record for good. The kill itself is never at stake. See FoldFightStatsOutcome in ` +
      `lib/fight-stats-cas.ts.`,
  );
  return 'gave-up';
}
