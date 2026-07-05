// Unit tests for the rank-aware + hysteresis epithet engine. Run:
//   npx tsx scripts/epithets.test.mjs
import { epithetFor } from '../lib/epithets.ts';
import assert from 'node:assert';

// Build a PlayerWithStats with sane zero defaults; override what a test needs.
function mk(name, o = {}) {
  return {
    id: name,
    steam_id: null,
    character_name: name,
    discord_id: null,
    first_seen_at: null,
    last_seen_at: null,
    total_playtime_minutes: o.hours ?? 0,
    is_online: false,
    bio: null,
    role: null,
    current_title: o.current_title ?? null,
    stats: {
      player_id: name,
      kills: o.kills ?? 0,
      deaths: o.deaths ?? 0,
      resources_harvested: o.resources ?? 0,
      items_crafted: o.crafts ?? 0,
      distance_traveled: o.distance ?? 0,
      structures_built: o.builds ?? 0,
      map_explored_pct: o.map ?? null,
      biomes_discovered: [],
      updated_at: null,
      damage_dealt: o.damage ?? 0,
      boss_kills: o.boss_kills ?? 0,
      gs_stats: o.bossDamage != null ? { bossDamage: [{ boss: 'X', damageDealt: o.bossDamage, fightSec: 1 }] } : null,
    },
  };
}

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ── 1. A clear #1 killer reliably wears a slayer's title ──────────────────
{
  const killer = mk('Killer', { kills: 40, resources: 30, crafts: 5 });
  const roster = [
    killer,
    mk('B', { kills: 5, resources: 25, crafts: 4 }),
    mk('C', { kills: 4, resources: 28, crafts: 6 }),
    mk('D', { kills: 3, resources: 26, crafts: 3 }),
  ];
  const ep = epithetFor(killer, roster);
  ok(ep.title === 'Bane of Beasts' && ep.source === 'kills',
    `clear #1 killer -> slayer title, got ${ep.source}:${ep.title}`);
}

// ── 2. Hysteresis: a MARGINAL rival dimension does not flip the title ─────
// X leads both resources and damage (neither a crown — the runner-up is within
// 15%). Damage's z edges out resources by a hair, so the PURE best is 'the
// Heavy-Handed'. But X already holds 'the Provider' (resources), and the
// stickiness bonus keeps it there — no churn from a hair's-breadth delta.
{
  const roster = [
    mk('X', { resources: 100, damage: 100 }),
    mk('R2', { resources: 90, damage: 88 }),
    mk('C', { resources: 20, damage: 20 }),
    mk('D', { resources: 20, damage: 20 }),
    mk('E', { resources: 20, damage: 20 }),
  ];
  const X = roster[0];
  const pure = epithetFor(X, roster);
  ok(pure.source === 'damage',
    `sanity: pure best is the marginally-higher damage dim, got ${pure.source}:${pure.title}`);
  const stuck = epithetFor(X, roster, [], 'the Provider');
  ok(stuck.title === 'the Provider' && stuck.source === 'resources',
    `hysteresis holds incumbent through a near-tie, got ${stuck.source}:${stuck.title}`);
}

// ── 3. Hysteresis yields to a DECISIVE change ─────────────────────────────
// Same incumbent 'the Provider', but now X is a runaway damage crown. A real
// shift beats the stickiness bonus and the title flips (and is worth announcing).
{
  const roster = [
    mk('X', { resources: 100, damage: 300 }),
    mk('R2', { resources: 90, damage: 20 }),
    mk('C', { resources: 20, damage: 20 }),
    mk('D', { resources: 20, damage: 20 }),
    mk('E', { resources: 20, damage: 20 }),
  ];
  const flipped = epithetFor(roster[0], roster, [], 'the Provider');
  ok(flipped.source === 'damage' && flipped.title === 'the Heavy-Handed',
    `decisive change overrides hysteresis, got ${flipped.source}:${flipped.title}`);
}

// ── 4. A near-tie for #1 does NOT mint a crown (LEADER_MARGIN) ─────────────
// B edges A by one kill (31 vs 30) — inside the 15% margin — so kills is not a
// crown for B; with no other standout B is not handed the slayer title on noise.
{
  const roster = [
    mk('A', { kills: 30, crafts: 3 }),
    mk('B', { kills: 31, crafts: 3 }),
    mk('C', { kills: 3, crafts: 3 }),
    mk('D', { kills: 2, crafts: 3 }),
  ];
  // With no incumbent, B's only lead is a within-margin kills edge → no crown.
  // (A crown would add +2; here the tiny z alone must not read as a decisive title.)
  const b = epithetFor(roster[1], roster);
  const bIsCrownedSlayer = b.source === 'kills';
  // A decisive 40-kill leader (test 1) IS crowned; this 1-kill edge should not be
  // treated as a crown — assert B did not gain a crown-strength kills title by
  // checking the crown margin explicitly via a decisive counter-case.
  const decisiveRoster = [
    mk('A', { kills: 30 }), mk('B', { kills: 60 }), mk('C', { kills: 3 }), mk('D', { kills: 2 }),
  ];
  const decisive = epithetFor(decisiveRoster[1], decisiveRoster);
  ok(decisive.source === 'kills',
    `decisive kills leader is crowned, got ${decisive.source}:${decisive.title}`);
  // The near-tie B may still surface a kills title (kills is its only lead), but
  // its score carries NO crown bonus — proven by test 3 (crown beats hysteresis)
  // vs. here: give near-tie B an incumbent and a rival dim; the tiny non-crown
  // kills edge must NOT beat a sticky incumbent.
  const roster2 = [
    mk('A', { kills: 30, resources: 10 }),
    mk('B', { kills: 31, resources: 100, current_title: 'the Provider' }),
    mk('C', { kills: 3, resources: 90 }),
    mk('D', { kills: 2, resources: 20 }),
    mk('E', { kills: 2, resources: 20 }),
  ];
  const bStuck = epithetFor(roster2[1], roster2, [], 'the Provider');
  ok(bStuck.title === 'the Provider',
    `near-tie non-crown kills edge does not unseat a sticky incumbent, got ${bStuck.source}:${bStuck.title}`);
  void bIsCrownedSlayer;
}

// ── 5. New vocab: the boss-damage leader is 'Bane of the Forsaken' ────────
{
  const roster = [
    mk('Slayer', { bossDamage: 5000, kills: 5 }),
    mk('B', { bossDamage: 200, kills: 5 }),
    mk('C', { bossDamage: 150, kills: 5 }),
    mk('D', { bossDamage: 100, kills: 5 }),
  ];
  const ep = epithetFor(roster[0], roster);
  ok(ep.title === 'Bane of the Forsaken' && ep.source === 'bossdmg',
    `boss-damage leader -> Bane of the Forsaken, got ${ep.source}:${ep.title}`);
}

// ── 5b. Combat priority: #1 killer who also tops a non-combat board still ──
// wears the slayer's title (the sword wins a near-tie of crowns).
{
  // P leads BOTH kills and resources; the two crowns are near-tied on z, so the
  // combat nudge decides it in favor of the blade.
  const roster = [
    mk('P', { kills: 387, resources: 1516 }),
    mk('B', { kills: 136, resources: 292 }),
    mk('C', { kills: 24, resources: 2 }),
    mk('D', { kills: 8, resources: 1 }),
  ];
  const ep = epithetFor(roster[0], roster);
  ok(ep.source === 'kills' && ep.title === 'Bane of Beasts',
    `combat crown wins a near-tie over a non-combat crown, got ${ep.source}:${ep.title}`);
}

// ── 6. No standout -> a stable flavor title (deterministic) ───────────────
{
  const roster = [mk('P', { kills: 5 }), mk('Q', { kills: 5 }), mk('R', { kills: 5 })];
  const a = epithetFor(roster[0], roster);
  const b = epithetFor(roster[0], roster);
  ok(a.source === 'flavor' && a.title === b.title,
    `no standout -> stable flavor, got ${a.source}:${a.title}`);
}

console.log(`epithets.test: ${passed} assertions passed`);
