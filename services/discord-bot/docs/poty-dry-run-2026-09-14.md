# Player of the Day — dry run, 2026-09-14

What the **new notability draw** would have crowned on the last four evenings, next to what the
**old fixed-priority draw** actually crowned. **No database was written and no service restarted**:
every number below comes from the nightly snapshots in `~/valheim-db-backups/<stamp>/`
(`player_stats.json`, `players.json`, `sessions.json`, `events.json`, `bosses.json`,
`poty_history.json`) for 09-10 … 09-14, replayed through the two exported `selectPlayerOfDay`
functions.

## How the replay was built

| Input | Source |
|---|---|
| stat deltas (kills, builds, crafts, resources, distance, sail, fish, damage, map %) | difference between consecutive `player_stats.json` snapshots |
| hours, the 20-minute gate, the 5-day attendance count | `sessions.json`, clipped to the real recap window |
| deaths + causes | `events.json` `type='death'`, through the same `collapseDeathRows` 10 s fold |
| bosses | `bosses.json`, `fight_stats.fighters` first, `players_present` as the legacy fallback |
| progression standing | `map_explored_pct` + kills, each normalised to the clan maximum |
| rotation history | the OLD draw sees the real `poty_history`; the NEW draw sees **its own** earlier crowns from this replay, so its rotation and Steadfast cadence rules are exercised honestly |
| `dayDeltas` ring buffer | built forward across the replay, so night 1 has **no** baseline and `surprise = 1` |

Two honest caveats about the replay itself:

- **The delta window is shifted ~4.5 h from the recap window.** The recap runs at 23:00 CT
  (04:00 Z) and diffs its own `state.json` baseline; the backups are taken at ~03:3x CT. So a
  night's *stat deltas* here cover 03:3x CT → 03:3x CT while its *hours, deaths and bosses* cover
  the true 23:00 → 23:00 window. Rankings are unaffected in practice; exact numbers move a little.
- **The personal baseline starts cold.** Night 1 has zero prior days and night 2 has one, so
  `surprise = 1` for both and clan share alone decides. Only nights 3 and 4 exercise the spike term.

## The table

| Night (23:00 CT) | Old winner + angle | New winner + angle + why | Top 3 alternatives (new) |
|---|---|---|---|
| **2026-09-10**<br>world day 69 · 24 active | **Okkrleif** · 💀 The Bold<br>(23 deaths) | **Fjällhnot** · ⚔️ Monster-Hunter<br>`hunter, surprise 1.0x, share 0.23, rot 1.00`<br>170 kills, 16.4 h, 0 deaths | Sauðbítr · hunter (0.503)<br>Lóa · hunter (0.471)<br>Fjällhnot · ironhide (0.450) |
| **2026-09-11**<br>world day 105 · 14 active | **Thorfinn** · ⚔️ Monster-Hunter<br>(109 kills) | **Zærø** · 🌄 The Steadfast<br>`steadfast, surprise 1.0x, share 0.00, rot 1.00`<br>3 of the last 5 days, 2.6 h, 18th of 25 | S'aeien · most_explored (0.486)<br>Sködir · most_explored (0.418)<br>Hel · most_explored (0.400) |
| **2026-09-12**<br>world day 151 · 24 active | **Okkrleif** · 👑 Boss-Slayer<br>(The Elder) | **Okkrleif** · 👑 Boss-Slayer<br>`boss_kill, surprise 1.0x, share 1.00, rot 1.00`<br>The Elder, Black Forest | Rosir · boss_kill (1.100)<br>Fjällhnot · boss_kill (1.100)<br>Sködir · boss_kill (1.100) |
| **2026-09-13**<br>world day 197 · 23 active | **Yonk** · 💀 The Bold<br>(19 deaths) | **Psifour** · 🪓 The Woodcutter<br>`woodcutter, surprise 10.0x, share 0.31, rot 1.00`<br>9,245 resources, 7.8 h, 0 deaths | Charleif · builder (2.189)<br>Charleif · smith (2.120)<br>Yunter · woodcutter (2.021) |

### The blurbs those crowns would have posted

> **2026-09-10** — Fjällhnot cut down 170 foes today. The crows of the realm follow that name now, fat and grateful.
>
> **2026-09-11** — 3 of the last 5 days in the hall for Zærø. The saga is not written by the swiftest alone.
>
> **2026-09-12** — Okkrleif stood over **The Elder** while the **Black Forest** went quiet. Skål.
>
> **2026-09-13** — Psifour hauled 9,245 pieces home, 10x a normal day for them.

## What changed, and why

- **Two of four death crowns are gone.** 09-10 and 09-13 both went to 💀 The Bold under the old
  priority list (23 and 19 deaths). Under the new draw, The Bold has to own the death board
  outright **and** out-score every other angle by 20% on the same notability scale, and it may not
  repeat two nights running. On both nights a bigger story existed and won.
- **The epic night is untouched.** 09-12 is a boss kill and both draws agree, which is the point:
  epics are tier 3, exempt from rotation, and never displaced by a spike or by perseverance.
- **Perseverance found someone real.** On 09-11, Zærø sat 18th of 25 in clan progression and had
  been in the hall 3 of the last 5 days. That is exactly the crown Charlie described, and it fires
  at most once a week per viking and once every three nights overall — on 09-13 that cadence rule
  blocked a second Steadfast and the Woodcutter took the night instead.
- **The old draw's blind spots are visible in the alternatives.** On 09-11 the runners-up are three
  Trailblazer (map-delta) candidates — a whole category of "something interesting happened" that the
  old thresholds (`most_explored` needed a brand-new biome) could never see.

## ⚠️ The 09-12 → 09-13 delta is polluted, and so is 09-13 → 09-14

**Do not read the last two nights' numbers as gameplay.** Two repair/migration events land inside
them:

1. **Builds, crafts and resources were frozen at 0 for nearly everyone until 09-13.** The
   "empty GS list is a HOLE, not a zero" fix (deployed 09-13) plus
   `db/2026-09-13_drop_profile_zero_points.sql` unfroze them. Psifour goes `0 → 9,245` resources and
   `0 → 1,122` builds across a single snapshot pair; Charleif goes `0 → 6,048` builds. Those are
   **lifetime** totals arriving at once, not one night's work.
2. **Kills switched source on 09-13** (Companion Client 0.4.5, `killsSource: 'profile'`). Charleif
   goes `223 → 972`, Kætiløy `211 → 1,250`, Yonk `237 → 729` in one step.

Consequences for this table, stated plainly:

- The 09-13 winner (**Psifour · The Woodcutter, 9,245 resources, "10x a normal day"**) is an artefact
  of the repair, not a night of chopping. `surprise` is pinned at the `SURPRISE_CAP` of 10 for
  *every* stat candidate that night, which is the cap doing its job — without it the score would be
  unbounded.
- Conversely, nights 09-10 and 09-11 could only ever be decided by kills / deaths / hours / map,
  because builds, crafts and resources were identically zero for the whole clan. The Builder, the
  Smith, the Angler and the Wayfarer had no data to win on. **The first genuinely representative
  night for the new draw is the first full night after 09-14.**

A live re-run after a few clean nights is the real acceptance test; this replay proves the wiring,
the rotation, the tiers and the gate, not the flavour of the outcome.

## Knobs, if any of the above reads wrong

All of them live at the top of `services/discord-bot/src/recap.js`:

| Knob | Value | Effect |
|---|---|---|
| `SURPRISE_EXP` (A) | 0.6 | weight on the personal spike |
| `SHARE_EXP` (B) | 0.4 | weight on the clan share |
| `SURPRISE_CAP` | 10 | ceiling on a spike, which the polluted nights above hit |
| `NUDGE` / `NUDGE_HOURS` | 0.1 / 4 h | the activity nudge, capped at +10% so it is never decisive |
| `MIN_ELIGIBLE_HOURS` | 20 min | the activity gate |
| `FLOORS` | kills 15 · builds 60 · crafts 15 · resources 150 · distance 3 km · sail 2 km · fish 3 · damage 2000 · map 0.4 pct | the minimum absolute delta per angle |
| `STEADFAST` tier | 1 | perseverance beats routine stat wins and never an epic. Setting the tier to 0 would make it compete on score instead — the one knob most likely to want tuning after a few live nights |
| `BOLD.margin` | 1.2 | how far ahead a death night must be before it takes the crown |
| rotation | ×0.5 same viking ≤3 nights · ×0.67 same angle ≤2 nights | epics exempt |
