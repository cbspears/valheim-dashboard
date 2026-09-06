# Changelog

## 1.5.0
- New `[VPlusFallback]` section, **off by default** (`Enabled = false`). It exists for one day: if a Valheim update leaves ValheimPlus behind and the server has to run without it, the admin flips this on and the crew keeps the comforts V+ was providing. When enabled and ValheimPlus is NOT loaded it provides: fuel that never runs out in fireplaces, ovens, hot tubs and shield generators (`InfiniteFireplaceFuel`, `InfiniteOvenFuel`, `InfiniteHotTubFuel`, `InfiniteShieldGeneratorFuel`); longer crafting-station build and attachment reach with the roof check off (`StationBuildRange` 30, `StationAttachmentRange` 20, `DisableStationRoofCheck`); a gathering, pickable and loot bonus (`GatheringBonusPercent`, `PickableBonusPercent`, `LootDropBonusPercent`, all 30); and shared map exploration (`ShareExploration`, `ShareExplorationRadius`). While ValheimPlus is loaded every one of these stands down automatically, even with `Enabled = true`, so the two never double up.
- Rebuild hardening. Movement patches now restore the walk-speed field in a finalizer, so an exception thrown inside the game's own movement code can no longer leave a player permanently sped up. Each tool-stamina hook is applied on its own so one changed game type costs one hook, not all nine. Patch bodies that run several times a frame are guarded so they can never throw into the game loop. The startup `patch classes applied: N/M` line counts against a fixed roster, so a patch the runtime could not load reads as a shortfall plus a `MISSING patch class <name>` error naming what stopped working, instead of a false all-clear.

## 1.4.0
- The stamina discount now covers movement only. Running, jumping, swimming, dodging and being encumbered still drain a quarter of vanilla on every recognised surface, but tools and weapons no longer ride along: attacks, blocking and parries, drawn bows and crossbows, reloads, building and piece removal, hoe and cultivator work, repairs, fishing and harpooning cost full vanilla stamina on dirt paths and paved roads, and nothing at all on built floors. Configurable per surface as `actionstamina` (1 = vanilla cost, 0 = free) alongside the existing `staminadrain`, which is now the movement multiplier. Every hook is applied on its own and logged at startup, and any that cannot be applied falls back to the safer multiplier: vanilla cost on paths and roads, a quarter on floors.

## 1.3.0
- Crafting stations: upgrades and attachments now connect from 10 metres further away, on every station in the game (workbench, forge, black forge, galdr table, artisan table, and anything a future update adds). Vanilla gives most attachment pieces 5 metres, so the default works out to about 15. The extra reach applies to both halves of the rule at once, where the game lets you place the piece and whether the station counts it towards its level, so a placement the game accepts is always one that actually upgrades the station. Configurable as `[Workstation] extraAttachmentRange` (0 restores vanilla), and any failure falls back to vanilla behaviour.

## 1.2.1
- Stamina drain on every surface is now a quarter of vanilla (x0.25) instead of zero. Zero drain also removed the stamina cost of fighting while standing on a floor, which the crew found too generous.

## 1.2.0
- Beds: the "you need a fire nearby" check now reaches 8 metres further than vanilla, so a bed no longer has to sit almost inside the hearth. Configurable as `[Bed] extraFireRange` (0 restores vanilla). The check is wrapped so any failure falls back to vanilla bed behaviour.

## 1.1.0
- One speed tier across every surface: x1.4 movement and zero stamina drain on dirt paths, paved roads, and all built floors.

## 1.0.0
- Initial release: a working replacement for the abandoned Useful Paths. Detects dirt paths and paved roads through the Heightmap paint mask, which is how current Valheim actually stores terrain paint, plus built floors through WearNTear.
