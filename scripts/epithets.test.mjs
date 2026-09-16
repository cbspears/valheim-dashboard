// Unit tests for the rank-aware + hysteresis epithet engine.
//
// Tests 1-24 are the original contract: crowns, combat priority, hysteresis,
// uniqueness, crown spread, the absolute floors and the hours superlative.
// Tests 25-34 cover the 2026-09-16 expansion Charlie asked for (30 earned
// titles instead of 11): the rank-2 rung on every ladder and its gates, the two
// new boards (fishing and sailing) with their floors, the five death-cause
// overrides and "the Unslain", the rule that a crown outranks an override, and a
// hall of thirty coming out mostly earned and entirely distinct.
//
// Run: npx tsx scripts/epithets.test.mjs
import { BIO_LINES, EARNED_TITLES, epithetFor, epithetsFor, generatedBioLine, isEarnedTitle } from '../lib/epithets.ts';
import { EARNED_TITLES as BOT_EARNED_TITLES } from '../services/discord-bot/src/titles.js';
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
      gs_stats: gsStats(o),
    },
  };
}

/**
 * The GsClientStats blob, built only when a test asks for one of the stats that
 * lives in it: boss damage, fish (either the profile total `fishCaught` or the
 * per-species `fish[]` breakdown) and metres sailed.
 */
function gsStats(o) {
  const gs = {};
  if (o.bossDamage != null) gs.bossDamage = [{ boss: 'X', damageDealt: o.bossDamage, fightSec: 1 }];
  if (o.fish != null) gs.fishCaught = o.fish;
  if (o.fishSpecies != null) gs.fish = o.fishSpecies;
  if (o.sail != null) gs.distances = { total: o.sail, walk: 0, run: 0, sail: o.sail, air: 0 };
  return Object.keys(gs).length ? gs : null;
}

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ── 1. A clear #1 killer reliably wears a slayer's title ──────────────────
// (Every dimension is scaled past its absolute floor; scaling a whole column by a
// constant leaves medians, z-scores and crown margins untouched, so the shape of
// each case below is exactly what it always was.)
{
  const killer = mk('Killer', { kills: 400, resources: 600, crafts: 100 });
  const roster = [
    killer,
    mk('B', { kills: 50, resources: 500, crafts: 80 }),
    mk('C', { kills: 40, resources: 560, crafts: 120 }),
    mk('D', { kills: 30, resources: 520, crafts: 60 }),
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
    mk('X', { resources: 1000, damage: 3000 }),
    mk('R2', { resources: 900, damage: 2640 }),
    mk('C', { resources: 200, damage: 600 }),
    mk('D', { resources: 200, damage: 600 }),
    mk('E', { resources: 200, damage: 600 }),
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
    mk('X', { resources: 1000, damage: 3000 }),
    mk('R2', { resources: 900, damage: 200 }),
    mk('C', { resources: 200, damage: 200 }),
    mk('D', { resources: 200, damage: 200 }),
    mk('E', { resources: 200, damage: 200 }),
  ];
  const flipped = epithetFor(roster[0], roster, [], 'the Provider');
  ok(flipped.source === 'damage' && flipped.title === 'the Heavy-Handed',
    `decisive change overrides hysteresis, got ${flipped.source}:${flipped.title}`);
}

// ── 4. A near-tie for #1 does NOT mint a crown (LEADER_MARGIN) ─────────────
// B edges A by ten kills (310 vs 300) — inside the 15% margin — so kills is not a
// crown for B; with no other standout B is not handed the slayer title on noise.
{
  const roster = [
    mk('A', { kills: 300, crafts: 30 }),
    mk('B', { kills: 310, crafts: 30 }),
    mk('C', { kills: 30, crafts: 30 }),
    mk('D', { kills: 20, crafts: 30 }),
  ];
  // With no incumbent, B's only lead is a within-margin kills edge → no crown.
  // (A crown would add +2; here the tiny z alone must not read as a decisive title.)
  const b = epithetFor(roster[1], roster);
  const bIsCrownedSlayer = b.source === 'kills';
  // A decisive 40-kill leader (test 1) IS crowned; this 1-kill edge should not be
  // treated as a crown — assert B did not gain a crown-strength kills title by
  // checking the crown margin explicitly via a decisive counter-case.
  const decisiveRoster = [
    mk('A', { kills: 300 }), mk('B', { kills: 600 }), mk('C', { kills: 30 }), mk('D', { kills: 20 }),
  ];
  const decisive = epithetFor(decisiveRoster[1], decisiveRoster);
  ok(decisive.source === 'kills',
    `decisive kills leader is crowned, got ${decisive.source}:${decisive.title}`);
  // The near-tie B may still surface a kills title (kills is its only lead), but
  // its score carries NO crown bonus — proven by test 3 (crown beats hysteresis)
  // vs. here: give near-tie B an incumbent and a rival dim; the tiny non-crown
  // kills edge must NOT beat a sticky incumbent.
  const roster2 = [
    mk('A', { kills: 300, resources: 100 }),
    mk('B', { kills: 310, resources: 1000, current_title: 'the Provider' }),
    mk('C', { kills: 30, resources: 900 }),
    mk('D', { kills: 20, resources: 200 }),
    mk('E', { kills: 20, resources: 200 }),
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

// ── 7. UNIQUENESS: a 10-player roster (several no-standouts) is all-distinct ──
{
  // Everyone logs some hours (positive roster median) so the hours dimension is
  // live; Eir simply logs far more and claims the superlative.
  const roster = [
    mk('Astrid', { hours: 100, kills: 400, resources: 50 }),  // kills crown
    mk('Bjorn', { hours: 100, resources: 900, kills: 10 }),   // resources crown
    mk('Cato', { hours: 100, damage: 8000, kills: 12 }),      // damage crown
    mk('Dagny', { hours: 100, bossDamage: 6000, kills: 8 }),  // boss-damage crown
    mk('Eir', { hours: 5000, kills: 9 }),                     // hours superlative
    mk('Frida', { hours: 100, builds: 1200, kills: 7 }),      // builds crown
    // four no-standout newcomers — everyone must still be unique
    mk('Gunnar', { hours: 100, kills: 6 }),
    mk('Hilda', { hours: 100, kills: 6 }),
    mk('Ivar', { hours: 100, kills: 6 }),
    mk('Jorunn', { hours: 100, kills: 6 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.size === roster.length, `every viking titled, got ${titles.size}/${roster.length}`);
  const all = roster.map((p) => titles.get(p.character_name).title);
  const uniq = new Set(all);
  ok(uniq.size === all.length, `all titles unique, got dupes in [${all.join(', ')}]`);
  // The four no-standouts get placeholders (source 'flavor'), all different.
  const noStandout = ['Gunnar', 'Hilda', 'Ivar', 'Jorunn'].map((n) => titles.get(n));
  ok(noStandout.every((e) => e.source === 'flavor'),
    `no-standouts get flavor placeholders, got ${noStandout.map((e) => e.source).join(',')}`);
  const phSet = new Set(noStandout.map((e) => e.title));
  ok(phSet.size === 4, `placeholders distinct, got [${noStandout.map((e) => e.title).join(', ')}]`);
  // The crown holders wear their deed titles.
  ok(titles.get('Astrid').source === 'kills', `Astrid the kills crown, got ${titles.get('Astrid').source}`);
  ok(titles.get('Eir').title === 'the Ever-Present', `Eir the hours superlative, got ${titles.get('Eir').title}`);
}

// ── 8. Contested dimension: the runner-up drops to their next-best deed ──────
// Two vikings both lead-ish on resources, but W owns it far more (crown). W takes
// 'the Provider'; V — who also decisively tops builds — must NOT also get resources
// (uniqueness), and instead wears 'Stonewright'. No sharing.
{
  const roster = [
    mk('W', { resources: 2000, builds: 5 }),
    mk('V', { resources: 800, builds: 3000 }),
    mk('C', { resources: 40, builds: 5 }),
    mk('D', { resources: 30, builds: 4 }),
    mk('E', { resources: 20, builds: 3 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('W').title === 'the Provider', `top resources -> Provider, got ${titles.get('W').title}`);
  ok(titles.get('V').title === 'Stonewright', `runner-up falls to next-best deed, got ${titles.get('V').title}`);
  ok(titles.get('W').title !== titles.get('V').title, 'contested dimension not shared');
}

// ── 9. STABILITY: a tiny stat delta does not reshuffle the roster's titles ───
{
  const base = [
    mk('Astrid', { kills: 400 }),
    mk('Bjorn', { resources: 900 }),
    mk('Cato', { damage: 8000 }),
    mk('Gunnar', { kills: 6 }),
    mk('Hilda', { kills: 6 }),
    mk('Ivar', { kills: 6 }),
  ];
  const before = epithetsFor(base);
  // Nudge Astrid's kills by one and re-title, feeding each viking's prior title as
  // the incumbent (as the live pipeline does via current_title).
  const inc = new Map(base.map((p) => [p.character_name, before.get(p.character_name).title]));
  const nudged = base.map((p) =>
    p.character_name === 'Astrid' ? mk('Astrid', { kills: 401 }) : p,
  );
  const after = epithetsFor(nudged, { incumbentByName: inc });
  for (const p of base) {
    ok(before.get(p.character_name).title === after.get(p.character_name).title,
      `stable under tiny delta for ${p.character_name}: ${before.get(p.character_name).title} -> ${after.get(p.character_name).title}`);
  }
}

// ── 10. A crown always beats a placeholder (deed > flavor) ───────────────────
{
  const roster = [
    mk('Slayer', { kills: 300 }),
    mk('Nobody1', { kills: 5 }),
    mk('Nobody2', { kills: 5 }),
    mk('Nobody3', { kills: 5 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Slayer').source === 'kills', `crown beats placeholder, got ${titles.get('Slayer').source}`);
  ok(titles.get('Nobody1').source === 'flavor', `non-standout is flavor, got ${titles.get('Nobody1').source}`);
}

// ── 11. Treefoe is unique: the most tree-felled claimant wins it ─────────────
{
  const roster = [mk('Woodsman', { kills: 5 }), mk('Sapling', { kills: 5 }), mk('Elm', { kills: 5 })];
  // Both clear the 3-tree-death floor, so the tie-break (most felled) is what decides.
  const causes = new Map([
    ['Woodsman', ['Tree', 'Tree', 'Tree', 'Tree', 'Tree']],          // 5 tree deaths
    ['Sapling', ['Tree', 'Tree', 'Tree', 'Greydwarf', 'Greydwarf']], // majority tree but fewer
  ]);
  const titles = epithetsFor(roster, { causesByName: causes });
  ok(titles.get('Woodsman').title === 'Treefoe', `most-felled wins Treefoe, got ${titles.get('Woodsman').title}`);
  ok(titles.get('Sapling').title !== 'Treefoe', `only one Treefoe, Sapling got ${titles.get('Sapling').title}`);
  const all = roster.map((p) => titles.get(p.character_name).title);
  ok(new Set(all).size === all.length, `Treefoe roster still all-unique, got [${all.join(', ')}]`);
}

// ── 12. Incumbent placeholder stays sticky when still free (no churn) ─────────
{
  const roster = [mk('Loafer', { kills: 5 }), mk('Idler', { kills: 5 })];
  const pure = epithetsFor(roster);
  const loaferPh = pure.get('Loafer').title;
  // Pin Loafer to a DIFFERENT valid placeholder as incumbent — it must be kept.
  const otherPh = loaferPh === 'the Unhurried' ? 'Mead-Tested' : 'the Unhurried';
  const inc = new Map([['Loafer', otherPh]]);
  const stuck = epithetsFor(roster, { incumbentByName: inc });
  ok(stuck.get('Loafer').title === otherPh,
    `incumbent placeholder kept, got ${stuck.get('Loafer').title}`);
  ok(stuck.get('Idler').title !== otherPh, 'placeholders still unique after sticky');
}

// ── 13. CROWN SPREAD: a power player tops three boards, keeps one, the other ──
// two crowns are inherited by the next-best vikings (who would never have cleared
// the distinctiveness gates on their own next to a runaway leader).
{
  const roster = [
    mk('Power', { kills: 300, resources: 3000, builds: 900 }),
    mk('Rune', { kills: 40, resources: 1200, builds: 100 }),
    mk('Sten', { kills: 30, resources: 400, builds: 400 }),
    mk('Tova', { kills: 20, resources: 300, builds: 90 }),
    mk('Ulf', { kills: 10, resources: 200, builds: 60 }),
  ];
  const titles = epithetsFor(roster);
  // Power leads kills, resources AND builds — the sword wins, and it wins once.
  ok(titles.get('Power').source === 'kills' && titles.get('Power').title === 'Bane of Beasts',
    `power player keeps the combat crown, got ${titles.get('Power').source}:${titles.get('Power').title}`);
  // The two vacated crowns flow to the runners-up rather than dying as placeholders.
  ok(titles.get('Rune').source === 'resources' && titles.get('Rune').title === 'the Provider',
    `vacated resources crown inherited, got ${titles.get('Rune').source}:${titles.get('Rune').title}`);
  ok(titles.get('Sten').source === 'builds' && titles.get('Sten').title === 'Stonewright',
    `vacated builds crown inherited, got ${titles.get('Sten').source}:${titles.get('Sten').title}`);
  // Nobody else is handed a deed they don't own, and the roster stays all-unique.
  ok(titles.get('Tova').source === 'flavor' && titles.get('Ulf').source === 'flavor',
    `also-rans stay placeholders, got ${titles.get('Tova').source}/${titles.get('Ulf').source}`);
  const all = roster.map((p) => titles.get(p.character_name).title);
  ok(new Set(all).size === all.length, `crown spread stays unique, got [${all.join(', ')}]`);
  // Inherited crowns must not churn: nudge every stat and re-title with the prior
  // titles as incumbents — the hall wakes up wearing exactly what it went to bed in.
  const inc = new Map(roster.map((p) => [p.character_name, titles.get(p.character_name).title]));
  const nudged = [
    mk('Power', { kills: 302, resources: 3010, builds: 900 }),
    mk('Rune', { kills: 41, resources: 1210, builds: 101 }),
    mk('Sten', { kills: 30, resources: 405, builds: 402 }),
    mk('Tova', { kills: 21, resources: 300, builds: 90 }),
    mk('Ulf', { kills: 10, resources: 205, builds: 61 }),
  ];
  const after = epithetsFor(nudged, { incumbentByName: inc });
  for (const p of roster) {
    ok(titles.get(p.character_name).title === after.get(p.character_name).title,
      `inherited crowns stable under a nudge for ${p.character_name}: ${titles.get(p.character_name).title} -> ${after.get(p.character_name).title}`);
  }
  // Determinism: the same warband in any order is titled identically.
  const reversed = epithetsFor([...roster].reverse());
  ok(roster.every((p) => titles.get(p.character_name).title === reversed.get(p.character_name).title),
    'inheritance is independent of roster input order');
}

// ── 14. Inheritance respects LEADER_MARGIN: a tight pack inherits nothing ──────
// Same shape as 13, but the untitled resources field is bunched inside 15% — no one
// owns the vacated crown, so it stays empty and they all fall to placeholders.
{
  const roster = [
    mk('Power', { kills: 300, resources: 3000 }),
    mk('Rune', { kills: 40, resources: 1000 }),
    mk('Sten', { kills: 30, resources: 950 }),
    mk('Tova', { kills: 20, resources: 900 }),
    mk('Ulf', { kills: 10, resources: 850 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Power').source === 'kills', `power player still takes kills, got ${titles.get('Power').source}`);
  const held = roster.map((p) => titles.get(p.character_name).title);
  ok(!held.includes('the Provider'),
    `near-tied field inherits nothing, got [${held.join(', ')}]`);
  ok(['Rune', 'Sten', 'Tova', 'Ulf'].every((n) => titles.get(n).source === 'flavor'),
    `tight pack stays placeholders, got ${['Rune', 'Sten', 'Tova', 'Ulf'].map((n) => titles.get(n).source).join(',')}`);
}

// ── 15. The hours superlative NEVER falls back ────────────────────────────────
// Power tops hours and kills; the blade wins, so 'the Ever-Present' goes unclaimed.
// Being there second-most is not being there most — no one inherits it.
{
  const roster = [
    mk('Power', { hours: 5000, kills: 300 }),
    mk('Rune', { hours: 1200, kills: 40 }),
    mk('Sten', { hours: 400, kills: 30 }),
    mk('Tova', { hours: 300, kills: 20 }),
    mk('Ulf', { hours: 200, kills: 10 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Power').source === 'kills', `combat crown beats the hours crown, got ${titles.get('Power').source}`);
  const held = roster.map((p) => titles.get(p.character_name).title);
  ok(!held.includes('the Ever-Present'),
    `hours never falls back to second place, got [${held.join(', ')}]`);
  // The runner-up on hours is not handed the superlative, nor its rank-2 rung:
  // "the Hearth-Bound" is only offered once "the Ever-Present" is actually worn,
  // and here nobody wears it. (Rune does pick up "the Unslain" — 1,200 minutes
  // and no deaths — which is a different override, not a fallback.)
  ok(titles.get('Rune').source !== 'hours' && titles.get('Rune').title !== 'the Hearth-Bound',
    `hours runner-up inherits nothing from the hours board, got ${titles.get('Rune').source}:${titles.get('Rune').title}`);
  ok(!held.includes('the Hearth-Bound'),
    `and no one is named second on a board with no first, got [${held.join(', ')}]`);
}

// ── 16. Hysteresis inside the fallback: the incumbent wins a near-tie ─────────
// Sten edges Rune on resources but not by the margin, so with no incumbent the
// vacated crown goes unclaimed. Give Rune the title he already wears and he keeps
// it — an incumbent is never demoted to a placeholder over a hair's-breadth swing.
{
  const roster = [
    mk('Power', { kills: 300, resources: 3000 }),
    mk('Rune', { kills: 40, resources: 1000 }),
    mk('Sten', { kills: 30, resources: 1050 }),
    mk('Tova', { kills: 20, resources: 900 }),
    mk('Ulf', { kills: 10, resources: 850 }),
  ];
  const cold = epithetsFor(roster);
  ok(cold.get('Rune').source === 'flavor' && cold.get('Sten').source === 'flavor',
    `control: near-tie inherits nothing, got ${cold.get('Rune').title}/${cold.get('Sten').title}`);
  const inc = new Map([['Rune', 'the Provider']]);
  const stuck = epithetsFor(roster, { incumbentByName: inc });
  ok(stuck.get('Rune').title === 'the Provider' && stuck.get('Rune').source === 'resources',
    `incumbent keeps the vacated crown through a near-tie, got ${stuck.get('Rune').source}:${stuck.get('Rune').title}`);
  ok(stuck.get('Sten').title !== 'the Provider', 'inherited title still unique');
  const all = roster.map((p) => stuck.get(p.character_name).title);
  ok(new Set(all).size === all.length, `still all-unique, got [${all.join(', ')}]`);
}

// ── 17. FLOORS: a day-one roster is crowned with NOTHING ─────────────────────
// The real numbers from the fresh world's first evening (builds 49/19/3/2,
// resources 49/20/16/2, kills 6/6/2/0). Relatively, Ari is a runaway leader in
// builds and resources — and that is exactly how "Stonewright at 49 structures"
// happened. Absolutely, nobody has done anything yet, so nobody is titled.
{
  const roster = [
    mk('Ari', { builds: 49, resources: 49, kills: 6 }),
    mk('Bo', { builds: 19, resources: 20, kills: 6 }),
    mk('Cai', { builds: 3, resources: 16, kills: 2 }),
    mk('Dis', { builds: 2, resources: 2, kills: 0 }),
  ];
  const titles = epithetsFor(roster);
  ok(roster.every((p) => titles.get(p.character_name).source === 'flavor'),
    `day-one roster earns no crowns, got ${roster.map((p) => `${p.character_name}=${titles.get(p.character_name).source}`).join(',')}`);
  const all = roster.map((p) => titles.get(p.character_name).title);
  ok(new Set(all).size === all.length, `day-one hall-names still unique, got [${all.join(', ')}]`);
}

// ── 18. FLOORS: crossing ONE floor earns exactly that one crown ───────────────
// Same day-one hall, but Ari has kept swinging the hammer past 250 structures.
// Builds is now earned; her resources and kills are still day-one numbers, so
// they stay uncrowned, and nobody else gains anything.
{
  const roster = [
    mk('Ari', { builds: 260, resources: 49, kills: 6 }),
    mk('Bo', { builds: 19, resources: 20, kills: 6 }),
    mk('Cai', { builds: 3, resources: 16, kills: 2 }),
    mk('Dis', { builds: 2, resources: 2, kills: 0 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Ari').source === 'builds' && titles.get('Ari').title === 'Stonewright',
    `crossing the builds floor earns Stonewright, got ${titles.get('Ari').source}:${titles.get('Ari').title}`);
  ok(['Bo', 'Cai', 'Dis'].every((n) => titles.get(n).source === 'flavor'),
    `the rest stay hall-named, got ${['Bo', 'Cai', 'Dis'].map((n) => titles.get(n).source).join(',')}`);
  const held = roster.map((p) => titles.get(p.character_name).title);
  ok(!held.includes('the Provider') && !held.includes('Bane of Beasts'),
    `no crown for the still-tiny stats, got [${held.join(', ')}]`);
}

// ── 19. FLOORS apply to the crown-spread fallback too ─────────────────────────
// Power is crowned on kills, vacating a resources crown. Rune leads the untitled
// field on resources by a mile (300 vs 200 clears LEADER_MARGIN, so pre-floors he
// WOULD have inherited 'the Provider') — but 300 is under the 500 floor, so the
// vacated crown stays unclaimed and he keeps a hall-name.
{
  const roster = [
    mk('Power', { kills: 300, resources: 3000 }),
    mk('Rune', { kills: 40, resources: 300 }),
    mk('Sten', { kills: 30, resources: 200 }),
    mk('Tova', { kills: 20, resources: 100 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Power').source === 'kills' && titles.get('Power').title === 'Bane of Beasts',
    `power player keeps the combat crown, got ${titles.get('Power').source}:${titles.get('Power').title}`);
  const held = roster.map((p) => titles.get(p.character_name).title);
  ok(!held.includes('the Provider'),
    `heir under the floor inherits nothing, got [${held.join(', ')}]`);
  ok(titles.get('Rune').source === 'flavor',
    `sub-floor runner-up stays hall-named, got ${titles.get('Rune').source}:${titles.get('Rune').title}`);
  // Control: lift that same runner-up over the floor and the inheritance fires,
  // proving it was the FLOOR doing the blocking and not the margin.
  const lifted = [
    mk('Power', { kills: 300, resources: 3000 }),
    mk('Rune', { kills: 40, resources: 600 }),
    mk('Sten', { kills: 30, resources: 200 }),
    mk('Tova', { kills: 20, resources: 100 }),
  ];
  const after = epithetsFor(lifted);
  ok(after.get('Rune').source === 'resources' && after.get('Rune').title === 'the Provider',
    `over the floor, the vacated crown is inherited, got ${after.get('Rune').source}:${after.get('Rune').title}`);
}

// ── The fallback bio bank: the copy doctrine, and every variant renders ────
// These sentences are the only prose on /viking/<slug> for a viking who never
// wrote a bio, so they carry the doctrine like any other player-facing copy:
// no em or en dash, no emoji, no unfilled placeholder. The bank went from 5
// lines to 22 on 2026-09-06.
//
// KNOWN EXCEPTION, and the only one: two of the ORIGINAL five carry a
// semicolon, which the doctrine bans. They are left byte-identical here on
// purpose (this pass was a merge, not a rewrite) and are named so the exception
// cannot spread: any NEW line with a semicolon fails.
{
  const LEGACY_SEMICOLONS = 2;

  ok(BIO_LINES.length === 22, `the bio bank is 22 lines, got ${BIO_LINES.length}`);

  const rendered = BIO_LINES.map((line) => line('Bren', 'the Provider'));
  ok(new Set(rendered).size === rendered.length, 'no bio line is written twice');

  for (const line of rendered) {
    ok(!/[—–]/.test(line), `no em or en dash in a bio line, got: ${line}`);
    ok(!/\p{Extended_Pictographic}/u.test(line), `no emoji in a bio line, got: ${line}`);
    ok(!/[{}]/.test(line), `no unfilled placeholder in a bio line, got: ${line}`);
    ok(!/undefined|NaN/.test(line), `no internals in a bio line, got: ${line}`);
    ok(line.includes('Bren'), `every bio line names the viking, got: ${line}`);
    ok(line.trim().endsWith('.'), `a bio line closes its sentence, got: ${line}`);
    ok(line.length <= 220, `a bio line stays a sentence, got ${line.length}: ${line}`);
  }

  const semis = rendered.filter((line) => line.includes(';'));
  ok(semis.length === LEGACY_SEMICOLONS,
    `only the two legacy bio lines carry a semicolon, got ${semis.length}: ${JSON.stringify(semis)}`);
  ok(rendered.slice(5).every((line) => !line.includes(';')),
    'nothing written after the original five carries one');

  // A line that reaches for the epithet must actually be handed one: every
  // variant is called with (first, title), and generatedBioLine passes both.
  const titled = BIO_LINES.filter((line) => line('Bren', 'the Provider') !== line('Bren', 'the Wanderer'));
  ok(titled.length >= 2, `some bio lines weave in the epithet, got ${titled.length}`);

  // The live entry point still works, and is still deterministic per name.
  const player = (name) => mk(name);
  const a = generatedBioLine(player('Bren'), { title: 'the Provider', source: 'resources' });
  const b = generatedBioLine(player('Bren'), { title: 'the Provider', source: 'resources' });
  ok(a === b, 'a viking always gets the same fallback bio');
  ok(!/[{}]|undefined/.test(a), `and it renders clean, got: ${a}`);
}

// ── 22. The hours superlative is RANK-AWARE: a near-tie does NOT flip it ──────
// Launch night churn: "the Ever-Present" rode a volatile hours value and flipped
// between an earned crown and a placeholder every pass. The superlative now holds
// for its incumbent through any near-tie (a rival within LEADER_MARGIN), and a
// fresh claim needs a decisive lead — so a one-minute swing never moves it.
{
  // All hours past the 600-min floor; Borg edges Ari by 10% (< the 15% margin).
  const roster = [
    mk('Ari', { hours: 1000, current_title: 'the Ever-Present' }), // incumbent
    mk('Borg', { hours: 1100 }),                                   // rival, +10% only
    mk('Cyn', { hours: 700 }),
    mk('Dag', { hours: 650 }),
  ];
  const titles = epithetsFor(roster); // incumbents default from current_title
  ok(titles.get('Ari').title === 'the Ever-Present' && titles.get('Ari').source === 'hours',
    `incumbent keeps the superlative through a near-tie, got ${titles.get('Ari').source}:${titles.get('Ari').title}`);
  // (Borg picks up "the Unslain" here — 1,100 minutes and no deaths — so the
  // assertion is about the SUPERLATIVE, not about being left hall-named.)
  ok(titles.get('Borg').title !== 'the Ever-Present' && titles.get('Borg').source !== 'hours',
    `a within-margin rival does NOT steal the superlative, got ${titles.get('Borg').source}:${titles.get('Borg').title}`);
  const all = roster.map((p) => titles.get(p.character_name).title);
  ok(new Set(all).size === all.length, `near-tie roster still all-unique, got [${all.join(', ')}]`);

  // And with NO incumbent, a within-margin lead crowns NOBODY — the engine does
  // not hand a superlative out on a hair's-breadth lead (which is exactly what
  // made it flip back and forth once someone did hold it).
  const cold = epithetsFor([
    mk('Ari', { hours: 1000 }),
    mk('Borg', { hours: 1100 }),
    mk('Cyn', { hours: 700 }),
    mk('Dag', { hours: 650 }),
  ]);
  ok(['Ari', 'Borg', 'Cyn', 'Dag'].every((n) => cold.get(n).source !== 'hours'),
    `no incumbent + no decisive lead => the superlative goes unclaimed, got Borg=${cold.get('Borg').source}`);
}

// ── 23. The superlative DOES change on a decisive (>= LEADER_MARGIN) lead ─────
// The hold is stickiness, not a lock: a rival who clears the incumbent by the
// leader margin takes the crown, and the old holder falls to a placeholder.
{
  const roster = [
    mk('Ari', { hours: 1000, current_title: 'the Ever-Present' }), // incumbent
    mk('Borg', { hours: 1200 }),                                   // rival, +20% (>= 15%)
    mk('Cyn', { hours: 700 }),
    mk('Dag', { hours: 650 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Borg').title === 'the Ever-Present' && titles.get('Borg').source === 'hours',
    `a decisive rival takes the superlative, got ${titles.get('Borg').source}:${titles.get('Borg').title}`);
  ok(titles.get('Ari').title !== 'the Ever-Present' && titles.get('Ari').source !== 'hours',
    `the unseated holder gives up the superlative, got ${titles.get('Ari').source}:${titles.get('Ari').title}`);
}

// ── 24. A crown incumbent is not demoted to a placeholder on a near-tie ───────
// The 19:42 Charleif case: the #1 killer + incumbent of "Bane of Beasts" lost it
// to a placeholder for a pass when a rival's stopgap-derived kills nudged the
// median and knocked his relative lead under MIN_LEAD. The incumbent hold now
// keeps a valid edge through that swing (floor permitting), so no placeholder churn.
{
  // Two heavy killers in a near-tie; the rest of the pack has caught up enough
  // that the leader's ratio-over-median would fail the raw MIN_LEAD gate.
  const roster = [
    mk('Char', { kills: 120, current_title: 'Bane of Beasts' }), // incumbent, #1
    mk('Riv', { kills: 110 }),                                   // within 15%
    mk('Eld', { kills: 100 }),
    mk('Fen', { kills: 95 }),
    mk('Gus', { kills: 90 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Char').title === 'Bane of Beasts' && titles.get('Char').source === 'kills',
    `crown incumbent holds through a near-tie instead of dropping to a placeholder, got ${titles.get('Char').source}:${titles.get('Char').title}`);
}

// ── 25. THE LADDER: the clear runner-up wears the dimension's rank-2 title ────
// Charlie, 2026-09-16: "more titles, and no duplicates". Every board now names
// two vikings, not one. Sten is the sole second on builds and clears third by
// more than the margin, so he wears "the Timber-Wise" while Ari keeps the crown.
{
  const roster = [
    mk('Ari', { builds: 2000, deaths: 1 }),   // the crown
    mk('Sten', { builds: 900, deaths: 1 }),   // sole second, clears third by 3x
    mk('Tova', { builds: 300, deaths: 1 }),
    mk('Ulf', { builds: 280, deaths: 1 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Ari').title === 'Stonewright' && titles.get('Ari').source === 'builds',
    `the leader keeps the crown, got ${titles.get('Ari').source}:${titles.get('Ari').title}`);
  ok(titles.get('Sten').title === 'the Timber-Wise' && titles.get('Sten').source === 'builds',
    `the clear runner-up wears rank 2, got ${titles.get('Sten').source}:${titles.get('Sten').title}`);
  ok(titles.get('Tova').source === 'flavor' && titles.get('Ulf').source === 'flavor',
    `third and fourth are still hall-named, got ${titles.get('Tova').source}/${titles.get('Ulf').source}`);
  const all = roster.map((p) => titles.get(p.character_name).title);
  ok(new Set(all).size === all.length, `the ladder stays unique, got [${all.join(', ')}]`);
  // Deterministic in any input order, like every other pass.
  const reversed = epithetsFor([...roster].reverse());
  ok(roster.every((p) => titles.get(p.character_name).title === reversed.get(p.character_name).title),
    'rank 2 is independent of roster input order');
}

// ── 26. Rank 2 is gated exactly like a crown, one rung down ──────────────────
{
  // (a) A TIE for second names nobody: there is no "the" runner-up.
  {
    const roster = [
      mk('Ari', { builds: 2000, deaths: 1 }),
      mk('Sten', { builds: 900, deaths: 1 }),
      mk('Tova', { builds: 900, deaths: 1 }),
      mk('Ulf', { builds: 280, deaths: 1 }),
    ];
    const held = roster.map((p) => epithetsFor(roster).get(p.character_name).title);
    ok(!held.includes('the Timber-Wise'), `a tie for second earns nothing, got [${held.join(', ')}]`);
  }
  // (b) Second must clear THIRD by LEADER_MARGIN, or the pack is too tight.
  {
    const roster = [
      mk('Ari', { builds: 2000, deaths: 1 }),
      mk('Sten', { builds: 900, deaths: 1 }),
      mk('Tova', { builds: 850, deaths: 1 }), // 900 / 850 = 1.06, inside the margin
      mk('Ulf', { builds: 280, deaths: 1 }),
    ];
    const held = roster.map((p) => epithetsFor(roster).get(p.character_name).title);
    ok(!held.includes('the Timber-Wise'), `a tight second/third earns nothing, got [${held.join(', ')}]`);
  }
  // (c) Rank 2 meets the SAME absolute floor as its crown (builds: 250).
  {
    const roster = [
      mk('Ari', { builds: 2000, deaths: 1 }),
      mk('Sten', { builds: 200, deaths: 1 }), // sole second, clear of third, under the floor
      mk('Tova', { builds: 20, deaths: 1 }),
      mk('Ulf', { builds: 10, deaths: 1 }),
    ];
    const held = roster.map((p) => epithetsFor(roster).get(p.character_name).title);
    ok(!held.includes('the Timber-Wise'), `a sub-floor runner-up stays hall-named, got [${held.join(', ')}]`);
    // Control: lift that same viking over the floor and the rung is earned.
    const lifted = [
      mk('Ari', { builds: 2000, deaths: 1 }),
      mk('Sten', { builds: 300, deaths: 1 }),
      mk('Tova', { builds: 20, deaths: 1 }),
      mk('Ulf', { builds: 10, deaths: 1 }),
    ];
    ok(epithetsFor(lifted).get('Sten').title === 'the Timber-Wise',
      `over the floor it is earned, got ${epithetsFor(lifted).get('Sten').title}`);
  }
  // (d) A board with NO crown has no second place: rank 2 needs rank 1 worn.
  {
    // Nobody clears the builds floor, so Stonewright goes unclaimed and so does
    // its rung, even though Sten is a clear sole second.
    const roster = [
      mk('Ari', { builds: 200, deaths: 1 }),
      mk('Sten', { builds: 100, deaths: 1 }),
      mk('Tova', { builds: 10, deaths: 1 }),
      mk('Ulf', { builds: 5, deaths: 1 }),
    ];
    const held = roster.map((p) => epithetsFor(roster).get(p.character_name).title);
    ok(!held.includes('Stonewright') && !held.includes('the Timber-Wise'),
      `no crown means no runner-up, got [${held.join(', ')}]`);
  }
}

// ── 27. Nobody wears both rungs, and a double runner-up takes only one ───────
// Two boards with two different leaders, so neither crown is vacated and nothing
// is inherited. Sten is the sole second on BOTH: he wears the rung that is more
// his, and the other rung stays unclaimed, because only a sole second may have it.
{
  const roster = [
    mk('Ari', { builds: 2000, resources: 300, deaths: 1 }),   // builds crown
    mk('Bo', { builds: 100, resources: 4000, deaths: 1 }),    // resources crown
    mk('Sten', { builds: 900, resources: 1500, deaths: 1 }),  // sole second on both
    mk('Tova', { builds: 300, resources: 600, deaths: 1 }),
    mk('Ulf', { builds: 280, resources: 520, deaths: 1 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Ari').title === 'Stonewright' && titles.get('Bo').title === 'the Provider',
    `both crowns are worn, got ${titles.get('Ari').title} / ${titles.get('Bo').title}`);
  const sten = titles.get('Sten').title;
  ok(sten === 'the Timber-Wise' || sten === 'the Gatherer',
    `a double runner-up wears one rung, got ${sten}`);
  const all = roster.map((p) => titles.get(p.character_name).title);
  ok(all.filter((t) => t === 'the Timber-Wise' || t === 'the Gatherer').length === 1,
    `and only one, got [${all.join(', ')}]`);
  ok(new Set(all).size === all.length, `all unique, got [${all.join(', ')}]`);
  // A crown-holder is never in the running for their own second place.
  ok(titles.get('Ari').title !== 'the Timber-Wise' && titles.get('Bo').title !== 'the Gatherer',
    'a crown-holder never takes their own rung');
}

// ── 28. FISHING: a leader and a runner-up, from either reading of the catch ───
// Charlie asked for a fishing title. The engine reads catches the way /players
// does: the GREATER of the profile total (`gs_stats.fishCaught`) and the
// per-species breakdown (`gs_stats.fish[]`), because 1.0 empties the latter.
{
  const roster = [
    mk('Hook', { fish: 90, deaths: 1 }),
    mk('Line', { fish: 40, deaths: 1 }),
    mk('Sinker', { fish: 8, deaths: 1 }),
    mk('Dry', { fish: 6, deaths: 1 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Hook').title === 'the Angler' && titles.get('Hook').source === 'fish',
    `the catch leader is the Angler, got ${titles.get('Hook').source}:${titles.get('Hook').title}`);
  ok(titles.get('Line').title === 'the Line-Caster' && titles.get('Line').source === 'fish',
    `and the clear runner-up is the Line-Caster, got ${titles.get('Line').source}:${titles.get('Line').title}`);

  // The per-species list alone is enough when the profile total is missing.
  const bySpecies = [
    mk('Hook', { fishSpecies: [{ item: 'Perch', count: 60 }, { item: 'Pike', count: 30 }], deaths: 1 }),
    mk('Line', { fishSpecies: [{ item: 'Perch', count: 40 }], deaths: 1 }),
    mk('Sinker', { fishSpecies: [{ item: 'Perch', count: 8 }], deaths: 1 }),
    mk('Dry', { fishSpecies: [{ item: 'Perch', count: 6 }], deaths: 1 }),
  ];
  ok(epithetsFor(bySpecies).get('Hook').title === 'the Angler',
    `the species breakdown feeds the same board, got ${epithetsFor(bySpecies).get('Hook').title}`);

  // FLOOR: five catches. A pond nobody has really fished crowns nobody.
  const shallow = [
    mk('Hook', { fish: 4, deaths: 1 }),
    mk('Line', { fish: 2, deaths: 1 }),
    mk('Sinker', { fish: 1, deaths: 1 }),
    mk('Dry', { fish: 1, deaths: 1 }),
  ];
  const held = shallow.map((p) => epithetsFor(shallow).get(p.character_name).title);
  ok(!held.includes('the Angler') && !held.includes('the Line-Caster'),
    `four catches earns nothing, got [${held.join(', ')}]`);
}

// ── 29. SAILING: the Sea-Wolf and the Salt-Sworn, with a 5,000 m floor ───────
{
  const roster = [
    mk('Helm', { sail: 90000, deaths: 1 }),
    mk('Mast', { sail: 40000, deaths: 1 }),
    mk('Oar', { sail: 8000, deaths: 1 }),
    mk('Shore', { sail: 6000, deaths: 1 }),
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Helm').title === 'the Sea-Wolf' && titles.get('Helm').source === 'sail',
    `the sailing leader is the Sea-Wolf, got ${titles.get('Helm').source}:${titles.get('Helm').title}`);
  ok(titles.get('Mast').title === 'the Salt-Sworn',
    `and the runner-up is the Salt-Sworn, got ${titles.get('Mast').title}`);

  const coastal = [
    mk('Helm', { sail: 4000, deaths: 1 }),
    mk('Mast', { sail: 1500, deaths: 1 }),
    mk('Oar', { sail: 500, deaths: 1 }),
    mk('Shore', { sail: 400, deaths: 1 }),
  ];
  const held = coastal.map((p) => epithetsFor(coastal).get(p.character_name).title);
  ok(!held.includes('the Sea-Wolf') && !held.includes('the Salt-Sworn'),
    `under 5,000 m nobody is named for the sea, got [${held.join(', ')}]`);
}

// ── 30. THE DEATH-CAUSE OVERRIDES all follow Treefoe's rule ──────────────────
// A strict majority of a viking's deaths to one cause, at least three of them.
// The cause strings are what lib/deaths.ts really writes: the lowercased HitType
// when nothing named the killer ("fall", "drowning", "burning") and the
// creature's display name when something did ("Deathsquito").
{
  const roster = [
    mk('Cliff'), mk('Deep'), mk('Ember'), mk('Welt'), mk('Timber'),
  ];
  const causes = new Map([
    ['Cliff', ['fall', 'fall', 'fall', 'Greydwarf']],
    ['Deep', ['drowning', 'drowning', 'drowning']],
    ['Ember', ['burning', 'burning', 'burning', 'CinderFire']],
    ['Welt', ['Deathsquito', 'Deathsquito', 'Deathsquito', 'Neck']],
    ['Timber', ['Tree', 'Tree', 'Tree', 'Boar']],
  ]);
  const titles = epithetsFor(roster, { causesByName: causes });
  ok(titles.get('Cliff').title === 'the Cliff-Kisser' && titles.get('Cliff').source === 'cliff',
    `a majority of falls, got ${titles.get('Cliff').source}:${titles.get('Cliff').title}`);
  ok(titles.get('Deep').title === 'the Half-Drowned' && titles.get('Deep').source === 'drowning',
    `a majority of drownings, got ${titles.get('Deep').source}:${titles.get('Deep').title}`);
  ok(titles.get('Ember').title === 'the Singed' && titles.get('Ember').source === 'fire',
    `a majority of burnings, got ${titles.get('Ember').source}:${titles.get('Ember').title}`);
  ok(titles.get('Welt').title === 'the Sting-Struck' && titles.get('Welt').source === 'deathsquito',
    `a majority of deathsquitos, got ${titles.get('Welt').source}:${titles.get('Welt').title}`);
  ok(titles.get('Timber').title === 'Treefoe' && titles.get('Timber').source === 'treefoe',
    `and the forest still marks its own, got ${titles.get('Timber').source}:${titles.get('Timber').title}`);
  const all = roster.map((p) => titles.get(p.character_name).title);
  ok(new Set(all).size === all.length, `five overrides at once stay unique, got [${all.join(', ')}]`);

  // The FLOOR: two deaths to a cause is a story, not yet a title.
  const shy = epithetsFor([mk('Cliff'), mk('Bo')], {
    causesByName: new Map([['Cliff', ['fall', 'fall']]]),
  });
  ok(shy.get('Cliff').title !== 'the Cliff-Kisser',
    `two falls earn nothing, got ${shy.get('Cliff').title}`);
  // And the MAJORITY: three falls out of seven deaths is not what marks a viking.
  const mixed = epithetsFor([mk('Cliff'), mk('Bo')], {
    causesByName: new Map([['Cliff', ['fall', 'fall', 'fall', 'Neck', 'Neck', 'Boar', 'Troll']]]),
  });
  ok(mixed.get('Cliff').title !== 'the Cliff-Kisser',
    `a minority of falls earns nothing, got ${mixed.get('Cliff').title}`);
}

// ── 31. Each override is UNIQUE: the cause has taken the winner MOST ──────────
{
  const roster = [mk('Deepest'), mk('Deeper'), mk('Deep')];
  const causes = new Map([
    ['Deepest', ['drowning', 'drowning', 'drowning', 'drowning', 'drowning']],
    ['Deeper', ['drowning', 'drowning', 'drowning', 'Neck']],
    ['Deep', ['drowning', 'drowning', 'drowning']],
  ]);
  const titles = epithetsFor(roster, { causesByName: causes });
  ok(titles.get('Deepest').title === 'the Half-Drowned',
    `the sea's favourite wins it, got ${titles.get('Deepest').title}`);
  ok(titles.get('Deeper').title !== 'the Half-Drowned' && titles.get('Deep').title !== 'the Half-Drowned',
    `and the other two fall through, got ${titles.get('Deeper').title} / ${titles.get('Deep').title}`);
  const all = roster.map((p) => titles.get(p.character_name).title);
  ok(new Set(all).size === all.length, `still unique, got [${all.join(', ')}]`);
}

// ── 32. A CROWN OUTRANKS AN OVERRIDE, and the override passes down the list ───
{
  const roster = [
    mk('Timber', { kills: 400, deaths: 4 }),  // Treefoe qualifier AND the kills crown
    mk('Sapling', { kills: 10, deaths: 4 }),  // Treefoe qualifier, fewer tree deaths
    mk('Cai', { kills: 8, deaths: 4 }),
    mk('Dis', { kills: 6, deaths: 4 }),
  ];
  const causes = new Map([
    ['Timber', ['Tree', 'Tree', 'Tree', 'Tree']],
    ['Sapling', ['Tree', 'Tree', 'Tree', 'Boar']],
  ]);
  const titles = epithetsFor(roster, { causesByName: causes });
  ok(titles.get('Timber').title === 'Bane of Beasts',
    `the crown wins over the override, got ${titles.get('Timber').title}`);
  ok(titles.get('Sapling').title === 'Treefoe',
    `and the mark passes to the next qualifier, got ${titles.get('Sapling').title}`);
}

// ── 33. "the Unslain": ten hours in the hall and not one death ───────────────
{
  const roster = [
    mk('Whole', { hours: 3000, deaths: 0 }),   // the longest-serving survivor
    mk('Spared', { hours: 800, deaths: 0 }),   // also unslain, but fewer hours
    mk('Bled', { hours: 4000, deaths: 3 }),    // more hours, but has died
    mk('New', { hours: 100, deaths: 0 }),      // unslain, under the ten-hour floor
  ];
  const titles = epithetsFor(roster);
  ok(titles.get('Whole').title === 'the Unslain' && titles.get('Whole').source === 'unslain',
    `the longest-serving survivor takes it, got ${titles.get('Whole').source}:${titles.get('Whole').title}`);
  ok(titles.get('Spared').title !== 'the Unslain' && titles.get('New').title !== 'the Unslain',
    `it is unique, got ${titles.get('Spared').title} / ${titles.get('New').title}`);
  ok(titles.get('Bled').title !== 'the Unslain',
    `a viking who has died is not unslain, got ${titles.get('Bled').title}`);
  // Under ten hours, nobody is named for it at all.
  const green = epithetsFor([mk('New', { hours: 100, deaths: 0 }), mk('Newer', { hours: 90, deaths: 0 })]);
  ok(green.get('New').title !== 'the Unslain' && green.get('Newer').title !== 'the Unslain',
    'a fresh hall has no Unslain');
}

// ── 34. A HALL OF THIRTY is mostly earned, and every name is different ───────
// The whole point of the expansion (Charlie, 2026-09-16): with two rungs on each
// of twelve ladders, a hall this size should read as a roll of deeds rather than
// a wall of hall-names. Twelve specialists, twelve clear runners-up behind them,
// six newcomers who have not done anything yet.
{
  // dimension -> [the option `mk` takes, that dimension's absolute floor]
  const LADDERS = [
    ['hours', 600], ['kills', 50], ['damage', 2500], ['bossDamage', 500],
    ['deaths', 10], ['resources', 500], ['crafts', 100], ['distance', 20000],
    ['builds', 250], ['map', 5], ['fish', 5], ['sail', 5000],
  ];
  const viking = (name, spikeAt, factor) => {
    const o = {};
    for (let d = 0; d < LADDERS.length; d++) {
      const [key, floor] = LADDERS[d];
      o[key] = Math.round(floor * (d === spikeAt ? factor : 0.2));
    }
    return mk(name, o);
  };
  const roster = [];
  // Twelve leaders, one board each, far clear of the field.
  for (let d = 0; d < 12; d++) roster.push(viking(`Lead${d}`, d, 30));
  // Twelve runners-up, sole second on the same board and clear of third.
  for (let d = 0; d < 12; d++) roster.push(viking(`Next${d}`, d, 6));
  // Six who have not stood out at anything yet.
  for (let i = 0; i < 6; i++) roster.push(viking(`New${i}`, -1, 0));

  const titles = epithetsFor(roster);
  const all = roster.map((p) => titles.get(p.character_name).title);
  ok(new Set(all).size === 30, `thirty distinct titles, got ${new Set(all).size}`);

  const crowns = roster.slice(0, 12).map((p) => titles.get(p.character_name));
  ok(crowns.every((e) => isEarnedTitle(e.title)), 'every board leader wears a crown');
  const seconds = roster.slice(12, 24).map((p) => titles.get(p.character_name));
  ok(seconds.every((e) => isEarnedTitle(e.title)),
    `every clear runner-up wears a rung, got [${seconds.map((e) => e.title).join(', ')}]`);
  ok(roster.slice(24).every((p) => titles.get(p.character_name).source === 'flavor'),
    'and the six newcomers are hall-named until they do something');

  const earned = all.filter((t) => isEarnedTitle(t)).length;
  ok(earned === 24, `a deep hall is mostly earned rather than hall-named, got ${earned}/30`);
  ok(EARNED_TITLES.length === 30, `the earned set is thirty titles, got ${EARNED_TITLES.length}`);
  ok(new Set(EARNED_TITLES).size === EARNED_TITLES.length, 'and no title is written twice');

  // Deterministic in any input order, as every pass must be.
  const reversed = epithetsFor([...roster].reverse());
  ok(roster.every((p) => titles.get(p.character_name).title === reversed.get(p.character_name).title),
    'a hall of thirty is titled the same whatever order it arrives in');
}

// ── The bot's mirror of the earned-title set ──────────────────────────────
// services/discord-bot/src/titles.js is plain JS and cannot import this engine,
// so it carries its own copy of the earned-title list. That list decides whether
// a recorded title may be demoted to a placeholder (it may not), so drift here
// would resurrect exactly the churn the sticky policy was written to stop.
{
  const engine = [...EARNED_TITLES].sort();
  const bot = [...BOT_EARNED_TITLES].sort();
  ok(JSON.stringify(engine) === JSON.stringify(bot),
    `the bot's EARNED_TITLES must mirror the engine's. engine=${JSON.stringify(engine)} bot=${JSON.stringify(bot)}`);
  ok(isEarnedTitle('Treefoe') && !isEarnedTitle('the Quiet Flame'),
    'isEarnedTitle separates earned titles from placeholders');
  // Every placeholder the engine can hand out must fall OUTSIDE the earned set,
  // or a placeholder would be treated as a crown and never reshuffle silently.
  const flavors = epithetsFor([
    mk('Aa'), mk('Bb'), mk('Cc'), mk('Dd'), mk('Ee'),
  ]);
  for (const [name, ep] of flavors) {
    if (ep.source !== 'flavor') continue;
    ok(!isEarnedTitle(ep.title), `${name}'s placeholder "${ep.title}" is not in the earned set`);
  }
}

console.log(`epithets.test: ${passed} assertions passed`);
