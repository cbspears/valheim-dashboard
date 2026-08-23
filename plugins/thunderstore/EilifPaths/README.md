# Eilif Paths

Custom plugin for the **Eilif** community Valheim server ([dashboard](https://valheim-dashboard.vercel.app)).

Roads that matter: while you stand on a recognised surface, movement speed is multiplied and stamina drain is scaled — and it reverts the instant you step off.

| Surface | Speed | Stamina drain |
|---|---|---|
| Dirt paths (hoe) | ×1.4 | ×0 |
| Paved roads | ×1.4 | ×0 |
| Built floors (wood, stone, iron, hardwood) | ×1.4 | ×0 |

All values configurable in `net.eilif.paths.cfg` (per surface: `movement`, `staminadrain`).

## Beds

Vanilla makes you park a bed almost on top of the fire before it will let you claim it or sleep in it. This mod adds 8 metres of extra reach to that check, so a bed anywhere in a normal hall counts as having a fire nearby. Set `[Bed] extraFireRange` to 0 for vanilla behaviour, or raise it if you want more. It is a client-side check, so it only affects your own beds.

Detects terrain the way *current* Valheim stores it (the Heightmap paint mask), replacing the abandoned Useful Paths mod whose detection broke years ago. Ships in the Eilif modpack — nothing to configure.
