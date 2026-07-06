# Spec — Angler Tracking + Collective Milestones (2026-07-05)

> Build decisions from the 2026-07-05 engagement-ideas session (research + spec
> also in the Mac Obsidian vault: `Documents/Main/30-Personal/projects/Valheim-SuperServer/`).
> Everything below was verified against this repo as of 2026-07-05
> (`lib/gs-client.ts`, `app/api/gs-ingest/route.ts`, `db/2026-07-03_voice_lines.sql`,
> `db/2026-07-04_gs_player_stats.sql`, `scripts/gs-client.test.mjs`).

Decisions (Charlie, 2026-07-05):
- ✅ **BUILD: Angler leaderboard & fishing tracking** (dashboard)
- ✅ **BUILD: Collective Milestones** — announced in-server (voice + center-screen) AND tracked on dashboard, with real-world equivalences ("that's the length of Norway")
- ⏸️ **HOLD: Server Firsts** (revisit later — the milestone engine below is designed so firsts bolt on)
- 🗓️ **LATER: The Regatta** (scope when ready — v1/v2 sketch at bottom)
- 🗓️ **LATER: Communal Tithe Chest** (once the world is live — zero-tech: norms + a labeled chest + map pin)

---

## Feature 1 — Angler leaderboard & fishing tracking

### Data reality (verified)
- `skills[]` in the client snapshot carries `{ skill: 'Fishing', level }` — **but `parseSelfSnapshot` keeps only the top-12 skills by level**, so a viking with 12 better skills silently loses their Fishing entry. Parser must retain Fishing explicitly.
- `pickups[]` carries per-item pickup counts — fish are items, so species counts ride along — **but the parser currently reduces `pickups` to a single `resourcesHarvested` sum and discards the breakdown.** Needs a parser addition.
- Fish sizes/weights are NOT in the data (star-level isn't distinguished in pickups). Big-catch bragging = ceremonial weigh-in shouts later (`/s /catch Tuna`), same capture path as `/oath`. Out of scope v1.

### Changes (effort S — no DB migration; fish lives inside the existing `gs_stats` jsonb)

**`lib/gs-client.ts`:**
1. Add `FISH_ITEM_IDS` set. ⚠️ Verify prefab ids from a LIVE payload the first time someone fishes on the test world (expected shape: `Fish1`…`Fish12` prefabs — log unknown `Fish*` ids at info so the map self-reports gaps). Display names go in a new `config/fish.ts` (Perch, Pike, Tuna, Coral Cod, Anglerfish, Giant Herring, Grouper, Northern Salmon, Pufferfish, Magmafish, Trollfish…), following the `config/mods.ts` pattern.
2. In `parseSelfSnapshot`: build `fish = pickups.filter(p => FISH_ITEM_IDS.has(p.item))` → add `fish: [{item, count}]` (sorted desc, no cap — ≤12 species) to `gsStats`.
3. Skills fix: `skills.slice(0, 12)` → top-12 **plus** the Fishing entry if it fell outside (dedupe).
4. Update `scripts/gs-client.test.mjs`: payload gains `{ item: 'Fish3', count: 4 }` in pickups + a 13-skill list with Fishing at rank 13; assert `gsStats.fish` and Fishing retention. (Also assert fish still counts inside `resourcesHarvested` — don't double-subtract.)

**Dashboard:**
- Vikings page: **"Anglers of Eilif"** leaderboard card — rank by Fishing skill level (`gs_stats->skills`), tiebreak by total catches (`gs_stats->fish` sum). Same card chrome as Master Builder / Cartographer.
- Viking profile (`/viking/[slug]`): fishing block in the Feats of Arms section — skill level, total catches, per-species counts (species icons greyed until caught → doubles as a personal fishing log; a server-wide species grid is the natural Firsts bolt-on later, currently on hold).

---

## Feature 2 — Collective Milestones ("Great Deeds")

One engine: definition rows → evaluator on ingest → fan-out to in-game voice + center-screen, Discord, Saga feed, dashboard. Designed so Server Firsts can later become rows in the same system.

### Schema (`db/2026-07-XX_milestones.sql`)
```sql
-- Collective milestones ("Great Deeds"): server-wide aggregate thresholds.
-- Definitions seeded here; achieved/announced state lives on the row.
-- Follows the oaths.announced_at pattern for bot cross-posting.
create table public.milestones (
  id text primary key,                  -- slug: 'sail-norway'
  metric text not null,                 -- evaluator key, see lib/milestones.ts
  threshold numeric not null,
  title text not null,                  -- "The Length of Norway"
  line text not null,                   -- voice/TTS text, {value} interpolated
  equivalence text,                     -- "≈ Lindesnes to North Cape"
  sort integer not null default 0,
  achieved_at timestamptz,              -- evaluator sets (idempotency guard)
  achieved_value numeric,
  announced_at timestamptz,             -- bot cross-post tracking (oaths pattern)
  meta jsonb not null default '{}'::jsonb
);
alter table public.milestones enable row level security;
-- public read like bosses/roadmap (definitions are fun to see upcoming;
-- if upcoming ones should be a surprise, gate the SELECT policy to achieved_at is not null)
```

### Evaluator (`lib/milestones.ts` + hook in `/api/gs-ingest`)
- Metric map, v1 restricted to **already-persisted columns** (no new counters needed):
  - `sail_total` / `walk_run_total` — sum of per-player distance columns (2026-07-04 distance migration; metres)
  - `deaths_total`, `kills_total`, `boss_kills_total`, `damage_total`, `resources_total`, `crafts_total`, `builds_total` — sums over `player_stats`
  - `playtime_total_hours` — sum over `sessions`
  - `explored_avg_pct` — avg `map_explored_pct`
  - (v2 option: persist a small raw `vh_*` subset — TreeChops, FoodEaten, ArrowsShot, PortalsUsed — during the stats merge to unlock tree/feast/arrow milestones; or sum `gs_stats->materials` jsonb for Wood/Stone specifically.)
- Hook: end of the client-stats merge branch in `app/api/gs-ingest/route.ts` (fits next-task #4 "rest of the client per-player stats merge"). One aggregate query → check unachieved rows where `threshold <= value` → set `achieved_at`/`achieved_value`.
- **Announce cap:** max 1 milestone announced per ingest cycle (queue the rest for subsequent cycles) — snapshots every ~120s make bursts otherwise possible.
- **Backfill guard:** first deploy against non-zero totals would fire many rows at once — seed script marks already-passed thresholds `achieved_at = now(), announced_at = now(), meta.backfill = true` (silent), so only *new* deeds speak. ⚠️ Demo data: seed definitions but zero the achieved state on the launch wipe list (tracker).

### Fan-out on achievement
1. **In-game voice:** insert into `voice_lines` — `kind 'event'`, speaker 'Eilif', `meta: {milestone: id}` (Companion polls `/api/voice`, confirmed mechanism). Center-screen text rides the same Companion path it already uses.
2. **Discord:** bot polls `milestones` for `achieved_at is not null and announced_at is null` → rich embed (title, line, equivalence, progress toward the *next* deed) → sets `announced_at` (oaths pattern; new small loop in `services/discord-bot`).
3. **Saga:** insert an `events` row (`type: 'milestone'`) so it lands in the feed/Episodes.
4. **Dashboard:** Hall gets a **"Great Deeds"** card next to Hearth — last deed achieved + progress bar to the next (nearest unachieved by %). Full ledger (achieved + upcoming) fits on `/world` under the roadmap.

### Starter definitions (flavor numbers ≈, all editable in the seed)
| metric | threshold | title / line | equivalence |
|---|---|---|---|
| sail_total | 122,000 m | **Crossing the Skagerrak** — "The fleet has sailed as far as Norway is from Denmark." | ≈ Skagen → Kristiansand |
| sail_total | 1,750,000 m | **The Length of Norway** — "Together we have sailed the length of Norway itself." | ≈ Lindesnes → North Cape |
| sail_total | 1,900,000 m | **The Iceland Crossing** — "Leif's own voyage: Bergen to Reykjavík." | ≈ Bergen → Reykjavík |
| sail_total | 5,600,000 m | **The Road to Vinland** — "As far as the vikings ever sailed: to Vinland." | ≈ Norway → Newfoundland |
| walk_run_total | 42,195 m | **The First Marathon** — "A marathon on foot, between all of us." | ≈ Athens, 490 BC |
| walk_run_total | 800,000 m | **The Pilgrims' Way** — "We have walked the Camino de Santiago." | ≈ the full Camino Francés |
| deaths_total | 13 | **A Full Longtable** — "Thirteen seats now filled at Valhalla's table." | one full mead-bench |
| deaths_total | 100 | **A Village of the Fallen** — "One hundred deaths. A village's worth of vikings." | pop. of a small Norse village |
| kills_total | 1,000 | **The First Thousand** — "A thousand foes lie behind us." | — |
| kills_total | 10,000 | **Stamford Bridge** — "Ten thousand slain — a battle to end an age." | ≈ combatants at Stamford Bridge, 1066 |
| damage_total | 600,000 | **A Thousand Trolls' Worth** — "Enough fury to fell a thousand trolls." | 1,000 × troll (600 HP) |
| resources_total | 100,000 | **The Great Hoard** — "A hundred thousand goods gathered." | — |
| builds_total | 10,000 | **Stave by Stave** — "Ten thousand pieces raised — a stave church's worth of work." | ≈ a stave church's timbers |
| playtime_total_hours | 1,000 | **Forty Days at Sea** — "A thousand hours lived in this world." | ≈ 40 days and nights |
| explored_avg_pct | 25 | **The Charted Quarter** — "A quarter of Midgard now known to us." | — |

(Thresholds are guesses at good pacing for 15–20 players — expect to tune after a few weeks of real data. Distances are metres, matching `vh_Distance*`.)

### Rebalance — 2026-07-06 (`db/2026-07-06_milestones_rebalance.sql`)

The starter table above (15 deeds) was **lopsided**: 6 of 15 (40%) were "distance
travelled" (4 `sail_total` + 2 `walk_run_total`), while `boss_kills_total` and
`crafts_total` had **zero** deeds and `damage`/`resources`/`builds`/`playtime`/
`explored` had only one each — Charlie's note: "way too many just running
milestones." Rebalanced to **28 deeds, ~2–3 per category, none over 3**:

- **Distance → 3** (was 6): kept the most evocative early/mid/late equivalences —
  *The First Marathon* (foot), *The Length of Norway* + *The Road to Vinland*
  (sea). Dropped *Crossing the Skagerrak*, *The Iceland Crossing*, *The Pilgrims' Way*.
- **NEW Boss Slaying** (`boss_kills_total`, 3): first boss → half the roster → all 8,
  matching the real `bosses` table (Eikthyr … Yagluth … the Queen … Fader … the
  Bog Witch of the Deep North; 8 total, the last lands post-launch).
- **NEW Crafting** (`crafts_total`, 3): 500 / 2,500 / 10,000 — least-certain
  thresholds (observed craft counts run low; watch and tune).
- **`deaths_total` / `kills_total`** unchanged (2 tiers each).
- **`damage` / `resources` / `builds` / `playtime` / `explored`** each 1 → 3 (added an
  "achievable soon" tier + a harder endgame tier; `explored_avg_pct` kept inside
  0–100 at 10 / 25 / 50).

The migration deletes all 15 old rows (pilot achieved/announced state was slated
for the pre-launch wipe anyway) and re-seeds the 28. Applied to prod
(`syuwavxpmtdmxupxjzje`) 2026-07-06; `lib/milestones.ts` untouched (nothing
hardcodes milestone ids — pure data change). Thresholds calibrated against the
live pilot's real testers (Testmantwo/Psifour/Steve/Testman), **not** the stale
`Chærlie` junk `player_stats` row (kills 1526 / structures_built 27207 /
`gs_updated_at` NULL) — recurring junk (a near-identical row was deleted once in
commit `4ff40f1`); it needs cleaning again before it skews live aggregates.

### Effort
Angler: **S** (parser + tests + two dashboard surfaces). Milestones: **M** (migration + evaluator + bot loop + 2 dashboard surfaces + seed content). No client-mod work; nothing at risk from Valheim 1.0.

---

## Parked (scope later)

**The Regatta** — v1 zero-new-tech: course between pinned points, starting horn via `voice_lines`, finishes as `/s /finish` shouts (oath-capture path) → timestamps → results page + winner title. v2: Companion "race mode" streaming positions at 2–5s cadence during events → live boats on the map page + replay. (Live positions are NOT in the ~120s snapshots — v2 is a real Companion extension.)

**Communal Tithe Chest** — labeled chest at the portal hub + "tithe your surplus after boss night" norm + map pin/photo album. Optional later: Companion watches chest contents → "the Well runs low / provides" line on Hearth.

**Server Firsts** — on hold; when revived, firsts become rows in the milestones engine (`metric: 'first_kill:Troll'` style) with per-species detection from `gs_stats->creatureKills` deltas + `bossKillEvents.firstBlood`.
