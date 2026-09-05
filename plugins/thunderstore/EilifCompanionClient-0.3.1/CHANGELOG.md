# Changelog

## 0.3.1
- Death reports now carry the **reporting character's own name** alongside the victim's, so the dashboard can tell a genuine self-report from one posted by somebody else. For you this changes nothing — the two names are always yours — but it lets the server refuse a death filed for a player who did not file it. Nothing new is collected: it is the same character name the map-percentage post has always sent.
- Each Harmony patch is now applied on its own, in its own guard, and the plugin logs `patch classes applied: N/M` at startup. If a future Valheim update changes one of the three hooks, the other two keep working and the log says exactly which one failed instead of the plugin going quietly half-dead.

## 0.3.0
- Tombstone keep-list: on a world where the vanilla `deathkeepequip` global key is set, your weapons, shield, torch, tools and ammo stay on you instead of going into the grave; resources, food and loot still drop. Implemented as a Harmony prefix/finalizer pair on `Inventory.MoveInventoryToGrave` that temporarily reuses the game's own "equipped items are spared" filter, so a failed patch degrades to exact vanilla behaviour. Inert on any server that has not set that key. Configurable (and disableable) via `[Death] KeepItemTypes`.

## 0.2.0
- Death reporter: on your character's death, posts the game's true kill record (hit type, attacker name, biome) so the dashboard logs honest causes. Same endpoint, same off-by-default behavior, fully wrapped so it can never affect gameplay.

## 0.1.1
- Resubmission with full data-disclosure README and source link. No code changes.

## 0.1.0
- Initial release: explored-map % → Eilif community dashboard Cartographer board.
