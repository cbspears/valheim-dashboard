// One-off backfill: carve the REAL war party onto the Eikthyr row.
//
// WHY THIS EXISTS. Eikthyr fell for real on 2026-08-28 03:49Z, but not one
// producer emitted a bossKillEvents[] entry — no server-side Emitter summary, no
// client summary — so the only thing that ever wrote bosses.fight_stats.fighters
// never fired. The milestone flip did its job (is_killed=true, players_present =
// the online roster) and left `fight_stats: { fighters: [], onlineAtKill: [...],
// source: 'gs-milestone' }`. An empty fighter set: the war-room fell back to the
// roster, which cannot tell a fighter from a bystander, and the Fight Record
// showed no top damage at all.
//
// The evidence was in the database the whole time. Every client posts its own
// per-boss damage into player_stats.gs_stats.bossDamage, and those are EFFECTIVE
// (baselined) totals — what was earned on THIS world, not lifetime imports. The
// route now folds those deltas as they arrive (lib/boss-damage.ts, wired into
// /api/gs-ingest), but that only works going forward. This script does the one
// historical fold the fix cannot reach back and do.
//
// WHY THE CURRENT TOTALS ARE THIS FIGHT. Eikthyr is the ONLY boss ever fought on
// this world (every other bosses row is still is_killed=false), so a player's
// entire effective Eikthyr damage was dealt in that one fight. This assumption is
// re-verified at runtime below and the script REFUSES to write if it stops
// holding — it is what makes "current total == this fight's damage" honest, and
// it is exactly why this is a one-off and not a reusable tool.
//
// SAFETY. DRY RUN by default (reads only, no writes of any kind). --execute is
// the only way to make it write, and even then it is idempotent: a fighter
// already carried in fight_stats.damage has been credited and is skipped, so a
// second run cannot double anybody's damage.
//
//   Node 20:  export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
//   Preview:  npx tsx scripts/backfill-eikthyr-fight.mjs
//   Write:    npx tsx scripts/backfill-eikthyr-fight.mjs --execute
//
// Run under `tsx` (not bare node) ON PURPOSE: it imports the very same
// foldClientDamage the live route uses, so this backfill and the ingest path can
// never drift into two different ideas of "never shrink". Everything else follows
// the plain-PostgREST-over-fetch pattern of scripts/launch-wipe.mjs (supabase-js
// is flaky under bare Node outside Next) — no extra dependency.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldClientDamage, bossDamageMap, CLIENT_DAMAGE_SOURCE } from '../lib/boss-damage.ts';
import { mapBossObject } from '../lib/gs-client.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const BOSS_NAME = 'Eikthyr';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const DRY_RUN = !EXECUTE;

// ── env (mirrors scripts/launch-wipe.mjs) ────────────────────────────────────
function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

function banner(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);
}

async function get(pathAndQuery) {
  const res = await fetch(`${REST}/${pathAndQuery}`, { headers: AUTH });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${pathAndQuery} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Only ever called from the --execute branch.
async function patch(pathAndQuery, body) {
  const res = await fetch(`${REST}/${pathAndQuery}`, {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PATCH ${pathAndQuery} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  console.log('====================================================================');
  console.log(` Eikthyr fight backfill — ${EXECUTE ? 'EXECUTE (writes)' : 'DRY RUN (read-only)'}`);
  console.log('====================================================================');

  // ── 1. The bosses rows, and the assumption this whole script rests on ──────
  banner('Bosses — is Eikthyr really the only fight this world has had?');
  const bosses = await get('bosses?select=id,name,is_killed,killed_at,players_present,fight_stats');
  const target = bosses.find((b) => b.name === BOSS_NAME) ?? null;
  const otherKilled = bosses.filter((b) => b.name !== BOSS_NAME && b.is_killed).map((b) => b.name);
  for (const b of bosses) {
    console.log(`  ${String(b.name).padEnd(16)} ${b.is_killed ? `KILLED ${b.killed_at}` : 'not killed'}`);
  }
  if (!target) {
    console.error(`\nNo bosses row named "${BOSS_NAME}" — nothing to backfill.`);
    process.exit(1);
  }
  if (otherKilled.length > 0) {
    // The premise has expired: with a second boss felled, a player's cumulative
    // per-boss totals no longer describe one fight and this script must not guess.
    console.error(`\n⛔ Other bosses have been felled since (${otherKilled.join(', ')}).`);
    console.error('   "current effective total == this one fight" no longer holds. Refusing to run.');
    process.exit(1);
  }
  console.log(`\n  ✓ ${BOSS_NAME} is the only felled boss — current effective totals ARE this fight.`);

  banner(`${BOSS_NAME} row — BEFORE`);
  console.log(`  players_present: ${JSON.stringify(target.players_present)}`);
  console.log(`  fight_stats:     ${JSON.stringify(target.fight_stats)}`);

  // ── 2. Every player's effective Eikthyr damage ─────────────────────────────
  banner('player_stats — effective bossDamage per viking');
  const stats = await get('player_stats?select=player_id,gs_reporter,gs_stats');
  const players = await get('players?select=id,character_name');
  const nameById = new Map(players.map((p) => [p.id, p.character_name]));

  const contributions = [];
  for (const row of stats) {
    // gs_reporter is the character name written alongside gs_stats; fall back to
    // the players row so a null reporter still resolves to a real viking.
    const who = (row.gs_reporter || nameById.get(row.player_id) || '').trim();
    const map = bossDamageMap(row.gs_stats);
    const damage = Object.entries(map)
      .filter(([raw]) => mapBossObject(raw) === BOSS_NAME)
      .reduce((a, [, v]) => a + v, 0);
    const label = who || `(unnamed player ${row.player_id})`;
    if (!who || damage <= 0) {
      console.log(`  ${label.padEnd(20)} —  (no ${BOSS_NAME} damage recorded)`);
      continue;
    }
    console.log(`  ${label.padEnd(20)} ${String(Math.round(damage)).padStart(8)} damage`);
    contributions.push({ who, damage });
  }

  // Highest first, ties on name — the same ordering the live fold uses, so the
  // derived verdict below matches what /api/gs-ingest would have produced.
  contributions.sort((a, b) => b.damage - a.damage || a.who.localeCompare(b.who));

  if (contributions.length === 0) {
    console.log(`\n  No viking has any recorded ${BOSS_NAME} damage — nothing to fold.`);
    return;
  }

  // ── 3. Fold (in memory) exactly as the live route would ────────────────────
  const alreadyCredited = new Set(
    Object.keys(target.fight_stats?.damage ?? {}).map((n) => String(n).trim()),
  );
  let next = target.fight_stats ?? null;
  const folded = [];
  const skipped = [];
  for (const { who, damage } of contributions) {
    // Idempotence: a name already carried in fight_stats.damage has been credited
    // (by the live route, or by an earlier run of this script). Re-folding it
    // would ADD the same damage a second time — foldClientDamage accumulates by
    // design — so it is skipped, and a second --execute run is a no-op.
    if (alreadyCredited.has(who)) {
      skipped.push(who);
      continue;
    }
    const out = foldClientDamage(next, who, damage);
    if (!out) continue;
    next = out;
    folded.push(who);
  }

  banner('DERIVED fight_stats');
  if (skipped.length > 0) {
    console.log(`  already credited (skipped): ${skipped.join(', ')}\n`);
  }
  console.log(`  fighters:        ${JSON.stringify(next?.fighters ?? [])}`);
  console.log(`  damage:          ${JSON.stringify(next?.damage ?? {})}`);
  console.log(`  topDamagePlayer: ${next?.topDamagePlayer ?? '(none)'}`);
  console.log(`  topDamage:       ${next?.topDamage ?? '(none)'}`);
  console.log(`  topDamageFrom:   ${next?.topDamageFrom ?? '(not ours — an MVP summary owns the verdict)'}`);
  console.log(`  source:          ${next?.source ?? '(none)'}`);
  if (next?.topDamageFrom !== CLIENT_DAMAGE_SOURCE && next?.topDamagePlayer) {
    console.log('\n  NOTE: a real MVP summary already carved the top-damage verdict — left untouched.');
  }

  // players_present: union only (grow, never shrink) — same rule as the route.
  const priorPresent = Array.isArray(target.players_present)
    ? target.players_present.filter((n) => typeof n === 'string' && n.trim())
    : [];
  const presentSet = new Set(priorPresent);
  for (const who of next?.fighters ?? []) presentSet.add(who);
  const presentGrew = presentSet.size > priorPresent.length;
  console.log(`\n  players_present: ${JSON.stringify([...presentSet])}${presentGrew ? '  (grew)' : '  (unchanged)'}`);

  if (folded.length === 0) {
    console.log('\n  Nothing new to fold — every damage-dealer is already credited.');
    return;
  }

  if (DRY_RUN) {
    banner('DRY RUN — nothing was written');
    console.log('  No PATCH was issued. Re-run with --execute to write the fold above.');
    return;
  }

  // ── 4. --execute: one guarded write ────────────────────────────────────────
  banner('WRITE');
  const body = { fight_stats: next };
  if (presentGrew) body.players_present = [...presentSet];
  // Guarded on the row's own id — this only ever touches the one Eikthyr row.
  const [written] = await patch(`bosses?id=eq.${encodeURIComponent(target.id)}`, body);
  console.log(`  fight_stats:     ${JSON.stringify(written?.fight_stats)}`);
  console.log(`  players_present: ${JSON.stringify(written?.players_present)}`);
  console.log(`\n  Folded ${folded.length} fighter(s): ${folded.join(', ')}`);
}

main().catch((e) => {
  console.error('\nbackfill-eikthyr-fight failed:', e.message);
  process.exit(1);
});
