# Eilif Paths

Custom plugin for the **Eilif** community Valheim server ([dashboard](https://valheim-dashboard.vercel.app)).

Roads that matter: while you stand on a recognised surface, movement speed is multiplied and stamina drain is scaled — and it reverts the instant you step off.

| Surface | Speed | Stamina drain |
|---|---|---|
| Dirt paths (hoe) | ×1.4 | ×0 |
| Paved roads | ×1.4 | ×0 |
| Built floors (wood, stone, iron, hardwood) | ×1.4 | ×0 |

All values configurable in `net.eilif.paths.cfg` (per surface: `movement`, `staminadrain`).

Detects terrain the way *current* Valheim stores it (the Heightmap paint mask), replacing the abandoned Useful Paths mod whose detection broke years ago. Ships in the Eilif modpack — nothing to configure.
