# Eilif Paths

Custom plugin for the **Eilif** community Valheim server ([dashboard](https://valheim-dashboard.vercel.app)).

Roads that matter: while you stand on a recognised surface, movement speed is multiplied and stamina drain is scaled, and it reverts the instant you step off.

| Surface | Speed | Movement stamina | Tools & weapons |
|---|---|---|---|
| Dirt paths (hoe) | ×1.4 | ×0.25 | ×1 |
| Paved roads | ×1.4 | ×0.25 | ×1 |
| Built floors (wood, stone, iron, hardwood) | ×1.4 | ×0.25 | ×0 |

All values configurable in `net.eilif.paths.cfg` (per surface: `movement`, `staminadrain`, `actionstamina`).

## Tools & weapons

The cheap stamina is for getting somewhere, not for working or fighting. Running, jumping, swimming, dodging and hauling a heavy load cost a quarter of the usual stamina on any recognised surface. Swinging a weapon or a tool does not: on a dirt path or a paved road an attack, a block, a drawn bow, a hammer, a hoe, a repair or a fishing line costs exactly what it costs anywhere else. On a floor you built yourself, all of that is free.

## Map discovery (1.6.0)

The map uncovers itself in a circle around you as you travel, and vanilla makes that circle the same size whether you are walking a forest track or crossing open water at sail. This widens it: half again as far on foot, and twice as far while you are on a ship. Standing on the deck counts, not just holding the rudder, so a whole crew charts the coast at the wider radius on one trip out.

Set `[Exploration] onFootMultiplier` and `sailingMultiplier` to retune it, or `enabled = false` for the vanilla radius. It scales whatever radius the game has in hand rather than setting a fixed number, so it stacks cleanly with anything else that touches the map. It is a client-side check: it fills in your own map, and nobody else's.

Retune it in whole steps, not tenths. The game uncovers the map in 64 metre squares and rounds up to a whole one, so the vanilla circle is 2 squares, the 1.5 default is 3 and the 2.0 default is 4. Anything between 1 and roughly 1.28 rounds back to the same 2 squares and does nothing you can see. If a small increase looks like it had no effect, that is because it had none.

## Stamina in deep water (1.6.0)

Vanilla does not regenerate any stamina at all while you are swimming, which is why a long crossing is a countdown rather than a swim. Now it does: the normal rate while you are treading water, and half the normal rate while you are actively swimming. Float for a moment and the bar comes back the way it does on a beach; keep stroking and it comes back slowly against the drain.

The cost of swimming is left exactly as it was. This only changes what you get back, never what a stroke takes, so the server's own swim drain setting stays the lever for how hard the water is. Set `[Swim] regenWhileTreading` and `regenWhileSwimming` to retune it, or `enabled = false` for vanilla.

## Beds

Vanilla makes you park a bed almost on top of the fire before it will let you claim it or sleep in it. This mod adds 8 metres of extra reach to that check, so a bed anywhere in a normal hall counts as having a fire nearby. Set `[Bed] extraFireRange` to 0 for vanilla behaviour, or raise it if you want more. It is a client-side check, so it only affects your own beds.

## Crafting stations

Vanilla gives a station upgrade about 5 metres to reach its station, which means chests, anvils, tanning racks and the rest end up crammed against the bench. This mod adds 10 metres to that reach, for every station in the game: workbench, forge, black forge, galdr table, artisan table, and whatever a future update brings. Both halves of the rule move together, so anywhere the game lets you place the piece is somewhere the station actually counts it towards its level. Set `[Workstation] extraAttachmentRange` to 0 for vanilla, or raise it if you want more. It is a client-side check.

Detects terrain the way *current* Valheim stores it (the Heightmap paint mask), replacing the abandoned Useful Paths mod whose detection broke years ago. Ships in the Eilif modpack. Nothing to configure.

## If ValheimPlus ever goes missing

Version 1.5.0 added a `[VPlusFallback]` section, **off by default**. It exists for one bad day: a Valheim update that leaves ValheimPlus behind. If the admin has to run the server without V+, flipping `Enabled = true` keeps the comforts V+ was providing: fuel that never runs out in fireplaces, ovens, hot tubs and shield generators, longer crafting-station reach with the roof check off, a gathering, pickable and loot bonus, and shared map exploration. While ValheimPlus is loaded every one of these stands down on its own, even with the key on, so the two never double up. You do not need to touch it; the server tells the plugin what to do.

Shared map exploration follows the `[Exploration]` on-foot multiplier, so a crew mate's part of the map fills in by exactly as much as your own does.

## Checking it loaded

The boot line in `BepInEx/LogOutput.log` reads:

```
[EilifPaths] Eilif Paths v1.6.0 loaded. ... Core patch classes: 8/8 applied.
[EilifPaths] tool/weapon stamina hooks: 9/9 applied.
```

`8/8` and `9/9` are the numbers to look for after any Valheim update. Anything less prints a `MISSING patch class` error naming the feature that stopped working.
