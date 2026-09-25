# Living Boards — the marker vocabulary

Every board `GET /api/boards` carries, and the sign marker that claims it. Copy this
list into `plugins/eilif-boards/README.md` and the vault how-to
(`08-Dashboard/06-Living-Boards.md`) when the next plugin build ships.

The source of truth is `lib/boards.ts` (`BOARD_KEYS` / `STAT_KEYS`), and the feed now
serves it as a flat top-level `keys: string[]` on the payload — so a plugin can claim
any `[board:<key>]` whose key appears in `keys`, and any `[board:<key>:leader]` whose
key appears in `leaders`, without being rebuilt the next time a board is added.

Keys are **append-only and never re-spelled** (`builds`, not `built`): a sign standing
in the world is already claimed with the old spelling.

## Markers

```
[board:kills]      [board:deaths]     [board:builds]     [board:resources]
[board:explored]   [board:distance]   [board:damage]     [board:hours]
[board:crafts]     [board:fish]       [board:titles]     [board:deeds]
[board:day]

[board:kills:leader]   <- any of the TEN stat markers, with ":leader" added
```

`titles`, `deeds` and `day` have no `:leader` form — Living Titles is alphabetical
(colouring a first name would invent a winner), Great Deeds is a warband total, not a
race, and the world day belongs to the world.

## The ten ranked stat boards

| Key | Header on the plank | The number | Dashboard board |
|---|---|---|---|
| `kills` | Kills | `player_stats.kills` | Kills |
| `deaths` | Deaths | `player_stats.deaths` | Deaths |
| `builds` | Builds | `player_stats.structures_built` | Built |
| `resources` | Resources | `player_stats.resources_harvested` | Resources |
| `explored` | Explored | `player_stats.map_explored_pct`, `31.9%` | Explored |
| `distance` | Distance | `player_stats.distance_traveled`, `84.2 km` | Distance |
| `damage` | Damage | `player_stats.damage_dealt`, `1,842` | Damage |
| `hours` | Hours | sessions-derived playtime, `12.5 h` | Hours |
| `crafts` | Crafts | `player_stats.items_crafted`, `1,842` | Crafted |
| `fish` | Catches | total catches, `1,842` | Anglers |

Four of those are new (2026-09-13), one line each:

- **`damage` → "Damage"** — cumulative damage dealt (`player_stats.damage_dealt`),
  rendered as a thousands-separated count.
- **`hours` → "Hours"** — playtime derived live from `sessions` exactly as /players
  derives it (closed sessions at their recorded duration plus the open one for a viking
  currently online; `players.total_playtime_minutes` is never written by the live
  pipeline), rendered as one-decimal hours, `12.5 h`.
- **`crafts` → "Crafts"** — items crafted (`player_stats.items_crafted`), a count.
- **`fish` → "Catches"** — total catches, the number the Anglers board counts: the
  GREATER of the per-species `gs_stats.fish` sum and the profile's own
  `gs_stats.fishCaught`. The key is `fish`, the header word is **Catches**.

`day` → **"Day"** (2026-09-25, asked for by a player) is `server_status.world_day`, the
same number the Hall page shows, rendered as the accented value with no name beside it
and with no thousands separator (the Hall page and the game both say `Day 1042`).
It is the only board that changes without anyone playing: a Valheim day is about thirty
real minutes, so it costs roughly two sign rewrites an hour. A day under 1 (or an
unreadable `server_status`) renders `no entries yet` rather than "Day 0", and the feed
never fails over it — the read is guarded in the route and passes null.

Two notes the same as for the original six: a metric at 0 / null is skipped rather than
printed (an untouched board says `no entries yet` instead of listing five zeros), and
every board string is capped at `BOARD_CHAR_BUDGET` (200 chars) by dropping whole
trailing rows.

## Payload shape

```jsonc
{
  "generatedAt": "2026-09-13T18:04:11.204Z",
  "boards": { "kills": "…", "hours": "<b>Hours</b>\nAstrid <color=#f2c14e>12.5 h</color>\nBjorn 5.0 h", "…": "…" },
  "leaders": { "kills": "…", "hours": "<b>Hours</b>\nAstrid <color=#f2c14e>12.5 h</color>", "…": "…" },
  "keys": ["kills","deaths","builds","resources","explored","distance","damage","hours","crafts","fish","titles","deeds","day"],
  "data": { "players": [ /* … + playtimeMin, fishCaught */ ], "deeds": { "achieved": 7, "total": 36, "latest": { "…": "…" } } }
}
```

Backward compatible: the deployed EilifBoards 0.2.0 binds the eight fields it declares
(`kills deaths builds resources explored distance titles deeds`) and ignores everything
else, so the four new boards, the four new plaques and `keys` are invisible to it until
the next plugin build claims them.
