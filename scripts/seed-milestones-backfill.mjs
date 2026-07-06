// Collective Milestones backfill guard.
//
// On the FIRST deploy against a non-zero world, the evaluator would cross many
// thresholds at once and Eilif would announce a storm of "Great Deeds" that
// already happened silently. This script pre-stamps every ALREADY-passed
// milestone as achieved AND announced (meta.backfill = true) so the live
// evaluator/bot only ever speak deeds crossed AFTER the backfill — the genuinely
// new ones.
//
// It reuses the SAME pure aggregate maths as the live evaluator (lib/milestones
// computeAggregates + evaluateMilestones), so a backfilled threshold is exactly
// one the evaluator would also have fired — no drift. Idempotent: only rows that
// are still unachieved (achieved_at is null) are touched, so it's safe to re-run.
//
//   Node 20:  export NVM_DIR=~/.config/nvm && . $NVM_DIR/nvm.sh && nvm use 20
//   Run:      npx tsx scripts/seed-milestones-backfill.mjs
//
// Requires the migration (db/2026-07-05_milestones.sql) to be applied first —
// if the table is missing it prints a note and exits without writing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAggregates, evaluateMilestones } from '../lib/milestones.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── env (mirrors scripts/backfill-identity.js) ───────────────────────────────
function loadEnv() {
  const file = path.join(__dirname, '..', '.env.local');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = loadEnv();
const URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

async function rest(method, pathq, body, extraHeaders) {
  const res = await fetch(`${URL}/rest/v1/${pathq}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  // Definitions (probe: a 404/relation-missing means the migration isn't applied).
  const defsRes = await rest('GET', 'milestones?select=*&order=sort');
  if (!defsRes.ok) {
    console.log('⚠️  milestones table not found — apply db/2026-07-05_milestones.sql first, then re-run.');
    console.log(`    (${defsRes.status} ${JSON.stringify(defsRes.data)})`);
    process.exit(0);
  }
  const defs = defsRes.data || [];

  // One batch of reads → the aggregate inputs (same shape the evaluator uses).
  const [statsRes, sessionsRes, playersRes] = await Promise.all([
    rest('GET', 'player_stats?select=*'),
    rest('GET', 'sessions?select=*'),
    rest('GET', 'players?select=character_name,is_online'),
  ]);
  const stats = statsRes.data || [];
  const sessions = sessionsRes.data || [];
  const onlineNames = new Set(
    (playersRes.data || []).filter((p) => p.is_online && p.character_name).map((p) => p.character_name),
  );

  const aggregates = computeAggregates({ stats, sessions, onlineNames });
  const crossed = evaluateMilestones(defs, aggregates); // unachieved + already >= threshold

  const now = new Date().toISOString();
  let applied = 0;
  for (const { def, value } of crossed) {
    const achievedValue = Math.round(value);
    // Guard achieved_at is null in the filter too, so a concurrent run / re-run
    // never re-stamps a row (idempotent).
    const patch = await rest(
      'PATCH',
      `milestones?id=eq.${encodeURIComponent(def.id)}&achieved_at=is.null`,
      { achieved_at: now, achieved_value: achievedValue, announced_at: now, meta: { backfill: true } },
      { Prefer: 'return=representation' },
    );
    if (patch.ok) {
      applied++;
      console.log(`  backfilled  ${def.id.padEnd(18)} ${def.metric} = ${achievedValue} (≥ ${def.threshold})  "${def.title}"`);
    } else {
      console.log(`  FAILED      ${def.id} — ${patch.status} ${JSON.stringify(patch.data)}`);
    }
  }

  console.log('\n── milestones backfill report ───────────────────────────');
  console.log(`  definitions        : ${defs.length}`);
  console.log(`  already achieved   : ${defs.filter((d) => d.achieved_at).length}`);
  console.log(`  crossed (this run) : ${crossed.length}`);
  console.log(`  backfilled silent  : ${applied}`);
  console.log('  aggregate snapshot :');
  for (const [k, v] of Object.entries(aggregates)) {
    console.log(`    ${k.padEnd(22)} ${Math.round(v).toLocaleString('en-US')}`);
  }
  console.log('─────────────────────────────────────────────────────────');
  console.log('Only deeds crossed AFTER this run will announce.');
}

main().catch((e) => {
  console.error('backfill failed:', e.message);
  process.exit(1);
});
