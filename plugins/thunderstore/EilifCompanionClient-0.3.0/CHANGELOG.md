# Changelog

## 0.3.0
- Tombstone keep-list: on a world where the vanilla `deathkeepequip` global key is set, your weapons, shield, torch, tools and ammo stay on you instead of going into the grave; resources, food and loot still drop. Implemented as a Harmony prefix/finalizer pair on `Inventory.MoveInventoryToGrave` that temporarily reuses the game's own "equipped items are spared" filter, so a failed patch degrades to exact vanilla behaviour. Inert on any server that has not set that key. Configurable (and disableable) via `[Death] KeepItemTypes`.

## 0.2.0
- Death reporter: on your character's death, posts the game's true kill record (hit type, attacker name, biome) so the dashboard logs honest causes. Same endpoint, same off-by-default behavior, fully wrapped so it can never affect gameplay.

## 0.1.1
- Resubmission with full data-disclosure README and source link. No code changes.

## 0.1.0
- Initial release: explored-map % → Eilif community dashboard Cartographer board.
