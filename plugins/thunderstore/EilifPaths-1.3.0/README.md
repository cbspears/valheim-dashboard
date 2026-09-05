# Eilif Paths

Custom plugin for the **Eilif** community Valheim server ([dashboard](https://valheim-dashboard.vercel.app)).

Roads that matter: while you stand on a recognised surface, movement speed is multiplied and stamina drain is scaled — and it reverts the instant you step off.

| Surface | Speed | Stamina drain |
|---|---|---|
| Dirt paths (hoe) | ×1.4 | ×0.25 |
| Paved roads | ×1.4 | ×0.25 |
| Built floors (wood, stone, iron, hardwood) | ×1.4 | ×0.25 |

All values configurable in `net.eilif.paths.cfg` (per surface: `movement`, `staminadrain`).

## Beds

Vanilla makes you park a bed almost on top of the fire before it will let you claim it or sleep in it. This mod adds 8 metres of extra reach to that check, so a bed anywhere in a normal hall counts as having a fire nearby. Set `[Bed] extraFireRange` to 0 for vanilla behaviour, or raise it if you want more. It is a client-side check, so it only affects your own beds.

## Crafting stations

Vanilla gives a station upgrade about 5 metres to reach its station, which means chests, anvils, tanning racks and the rest end up crammed against the bench. This mod adds 10 metres to that reach, for every station in the game: workbench, forge, black forge, galdr table, artisan table, and whatever a future update brings. Both halves of the rule move together, so anywhere the game lets you place the piece is somewhere the station actually counts it towards its level. Set `[Workstation] extraAttachmentRange` to 0 for vanilla, or raise it if you want more. It is a client-side check.

Detects terrain the way *current* Valheim stores it (the Heightmap paint mask), replacing the abandoned Useful Paths mod whose detection broke years ago. Ships in the Eilif modpack — nothing to configure.
