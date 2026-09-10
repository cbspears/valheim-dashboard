# Eilif Paths

> **Disclosure: this plugin was written with AI assistance** (Anthropic Claude, directed and reviewed by the Eilif server admin). It is listed under Thunderstore's "AI Generated" category for that reason. Source is public at the link in the manifest.


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

## Map discovery (1.6.0, widened in 1.7.1)

The map uncovers itself in a circle around you as you travel, and vanilla makes that circle the same size whether you are walking a forest track or crossing open water at sail. This widens it: twice as far on foot, and five times as far while you are on a ship. Standing on the deck counts, not just holding the rudder, so a whole crew charts the coast at the wider radius on one trip out.

Set `[Exploration] onFootMultiplier` and `sailingMultiplier` to retune it, or `enabled = false` for the vanilla radius. It scales whatever radius the game has in hand rather than setting a fixed number, so it stacks cleanly with anything else that touches the map. It is a client-side check: it fills in your own map, and nobody else's.

Retune it in whole steps, not tenths. The game uncovers the map in 64 metre squares and rounds up to a whole one, so the vanilla circle is 2 squares, the 2.0 on-foot default is 4 and the 5.0 sailing default is 8. Anything between 1 and roughly 1.28 rounds back to the same 2 squares and does nothing you can see. If a small increase looks like it had no effect, that is because it had none.

## Stamina in deep water (1.6.0)

Vanilla does not regenerate any stamina at all while you are swimming, which is why a long crossing is a countdown rather than a swim. Now it does: the normal rate while you are treading water, and half the normal rate while you are actively swimming. Float for a moment and the bar comes back the way it does on a beach; keep stroking and it comes back slowly against the drain.

The cost of swimming is left exactly as it was. This only changes what you get back, never what a stroke takes, so the server's own swim drain setting stays the lever for how hard the water is. Set `[Swim] regenWhileTreading` and `regenWhileSwimming` to retune it, or `enabled = false` for vanilla.

## Beds

Vanilla makes you park a bed almost on top of the fire before it will let you claim it or sleep in it. This mod adds 8 metres of extra reach to that check, so a bed anywhere in a normal hall counts as having a fire nearby. Set `[Bed] extraFireRange` to 0 for vanilla behaviour, or raise it if you want more. It is a client-side check, so it only affects your own beds.

## Crafting stations

Vanilla gives a station upgrade about 5 metres to reach its station, which means chests, anvils, tanning racks and the rest end up crammed against the bench. This mod adds 10 metres to that reach, for every station in the game: workbench, forge, black forge, galdr table, artisan table, and whatever a future update brings. Both halves of the rule move together, so anywhere the game lets you place the piece is somewhere the station actually counts it towards its level. Set `[Workstation] extraAttachmentRange` to 0 for vanilla, or raise it if you want more. It is a client-side check.

Detects terrain the way *current* Valheim stores it (the Heightmap paint mask), replacing the abandoned Useful Paths mod whose detection broke years ago. Ships in the Eilif modpack. Nothing to configure.

## The ValheimPlus comforts

ValheimPlus has no Valheim 1.0 build, so the `[VPlusFallback]` section is what keeps the comforts the crew is used to. It is **off by default** and the server tells you when to turn it on; while ValheimPlus is loaded every one of these stands down on its own, even with the key on, so the two can never double up.

With `Enabled = true` and no V+ present you get: fuel that never runs out in fireplaces, ovens, hot tubs and shield generators; longer crafting-station reach with the roof check off; a gathering, pickable and loot bonus; shared map exploration; and, from 1.7.0, the five below.

**No weather damage.** Rain and water erosion stop wearing your buildings down. Everything else about wear is untouched: a piece still collapses when its supports go, still takes Deep North snow load, still takes event damage, and still takes every point of combat damage. This is the rain, and only the rain.

**Area repair.** One hammer click repairs every damaged piece within 7.5 metres, not just the one under your crosshair. Each extra piece pays its own stamina and its own hammer durability, and passes the same ward and crafting-station checks a single repair does, so the sweep stops the moment you run out of either. Intact pieces are skipped. Set `AreaRepairRadius` to 0 for ordinary single-piece repair.

**Dropped items float.** Anything that lands in water stays on the surface instead of sinking out of reach. It applies to items that spawn while you are nearby; something already resting on a lake bed stays there.

**Camera zoom and field of view (1.7.1).** The third-person camera pulls back to 100 metres instead of the vanilla 6, on foot and at sea alike, and the field of view opens from 65 to 75. That is the camera the crew had under ValheimPlus, restored key for key: `CameraMaxZoom`, `CameraMaxZoomBoat` and `CameraFov`. Set any one of them to 0 for the vanilla number, which is the setting to reach for if a wider view makes you queasy. The zoom knobs are accepted between 1 and 100 metres and the field of view between 1 and 140, the same windows ValheimPlus enforced, so a typo cannot put the camera in orbit.

**Shout range.** Mirrors what ValheimPlus set, and it is worth being straight about what that buys on 1.0: the game already sends every `/s` shout to every player on the server, so the chat window is world-wide whether this is on or off. What the setting still covers is the older per-character range gate, which anything speaking through the game's Talker path is subject to. Normal and whispered chat are left exactly as vanilla has them.

**One caveat that applies to all of them, and to the older comforts too.** Valheim works an object out on whichever machine owns it, and that machine is a player's game, never the dedicated server: the server does not run this plugin. So a building only stops eroding while a viking who has this switched on is the nearest one to it, and an item only floats if it spawned while you were near it. With the whole crew on the same modpack that is invisible in practice, which is why it ships in the pack rather than as an optional extra.

Shared map exploration follows the `[Exploration]` on-foot multiplier, so a crew mate's part of the map fills in by exactly as much as your own does.

## Checking it loaded

The boot line in `BepInEx/LogOutput.log` reads:

```
[EilifPaths] Eilif Paths v1.7.1 loaded. ... Core patch classes: 8/8 applied.
[EilifPaths] tool/weapon stamina hooks: 9/9 applied.
```

`8/8` and `9/9` are the numbers to look for after any Valheim update. With `[VPlusFallback] Enabled = true` there is a third, `VPlusFallback patch classes: 17/17 applied.`, printed just above them. Anything less than any of those three prints a `MISSING patch class` error naming the feature that stopped working.
