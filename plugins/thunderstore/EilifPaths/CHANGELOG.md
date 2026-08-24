# Changelog

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
