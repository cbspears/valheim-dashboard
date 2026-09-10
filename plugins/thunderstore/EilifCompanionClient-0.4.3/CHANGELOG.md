# Changelog

## 0.4.3
- Profile counters now come from the all-time bucket. Valheim 1.0 keeps ten stat buckets per character and the game's own accessor hands back the achievement-eligible one whenever achievements are allowed; that bucket is empty for anyone who played modded before, and it stops counting the moment a character is flagged, so most vikings posted zero builds and zero distance. 0.4.3 reads bucket 0 directly (lifetime, only ever goes up).
- Kills and deaths are no longer posted. The dashboard takes kills from the per-world weapon breakdown and deaths from its own death events; a lifetime counter beside those made the dashboard flip its zero-point every few minutes. What this reporter sends is now exactly: builds placed, crafts made, distance travelled (total, walked, run, sailed, flown). The README's disclosure is updated to match.

## 0.4.2
- No code change. Same plugin as 0.4.1, re-released so the README carries the AI-assistance disclosure at the top and the Thunderstore listing can be filed under the AI Generated category, as the Valheim community's rules ask. If you are on 0.4.1 there is nothing new to gain; the pack pins 0.4.2 only so that everyone is on the listed version.

## 0.4.1
- Explored-map percentage works on Valheim 1.0 again. 1.0 changed the minimap's fog store from a plain array to a BitArray; 0.4.0 and every earlier build read it as the old array, came up empty, and quietly posted nothing, so no viking's map percentage reached the dashboard on launch night. 0.4.1 reads either shape, and if a future game version changes it again the plugin now logs one warning naming what it found instead of going silent. No change to what is collected, no other feature touched.

## 0.4.0
- Raw profile-stats reporter. On Valheim 1.0 the third-party stats mod stopped filling the dashboard's stat counters, so the kill, death, build, distance and craft boards (and the collective Great Deeds that read them) went blank. This version reads those counters straight off your own local player profile with the game's own accessor and posts them to the community dashboard on the same five-minute cadence as the map percentage, and once more on logout. Posted: your total kills and deaths, your builds placed, your crafts made, and your distance travelled (total, walked, run, sailed, flown). Nothing per-item, nothing about position, inventory or other players. It uses the same dashboard URL and token already in your config; with no URL configured it sends nothing. New toggle `[Stats] Enabled` (default true) turns it off. No change to the map, death or tombstone features.
- Version constant corrected. The published 0.3.4 build carried an internal version string still reading 0.3.3, so its load line in the log said 0.3.3 while the package was 0.3.4. The 0.4.0 build reports 0.4.0 everywhere.

## 0.3.4
- Rebuilt against Valheim 1.0 (build 25185596, 2026-09-09). Required, not cosmetic: 1.0 renumbered the game's `GlobalKeys` enum, and C# bakes enum values into the compiled plugin, so the 0.3.3 build tests the wrong world key on a 1.0 server and the tombstone keep-list would never engage there. 0.3.4 reads `deathkeepequip` correctly on 1.0. No source changes, nothing new collected, same three patches, same config keys. Use 0.3.4 on 1.0 servers; 0.3.3 stays correct only for 0.221.x.

## 0.3.3
- Startup health line hardened for the Valheim 1.0 rebuild. The `patch classes applied: N/M` line now counts against a fixed roster of the three patches instead of the classes the runtime managed to load, so a patch that fails to load because a game type changed reads `2/3` plus one `MISSING patch class <name>` error naming what stopped working, instead of a false `2/2`. No change to what is collected or how the tombstone keep-list behaves.

## 0.3.2
- The map-percentage post now carries the **reporting character's own name** as well, exactly as death reports have since 0.3.1. It is the same name that was already in the message, sent a second time so the dashboard can confirm a reading came from the character it belongs to and refuse one posted for somebody else. Nothing new is collected and nothing changes for you.

## 0.3.1
- Death reports now carry the **reporting character's own name** alongside the victim's, so the dashboard can tell a genuine self-report from one posted by somebody else. For you this changes nothing, since the two names are always yours, but it lets the server refuse a death filed for a player who did not file it. Nothing new is collected: it is the same character name the map-percentage post has always sent.
- Each Harmony patch is now applied on its own, in its own guard, and the plugin logs `patch classes applied: N/M` at startup. If a future Valheim update changes one of the three hooks, the other two keep working and the log says exactly which one failed instead of the plugin going quietly half-dead.

## 0.3.0
- Tombstone keep-list: on a world where the vanilla `deathkeepequip` global key is set, your weapons, shield, torch, tools and ammo stay on you instead of going into the grave; resources, food and loot still drop. Implemented as a Harmony prefix/finalizer pair on `Inventory.MoveInventoryToGrave` that temporarily reuses the game's own "equipped items are spared" filter, so a failed patch degrades to exact vanilla behaviour. Inert on any server that has not set that key. Configurable (and disableable) via `[Death] KeepItemTypes`.

## 0.2.0
- Death reporter: on your character's death, posts the game's true kill record (hit type, attacker name, biome) so the dashboard logs honest causes. Same endpoint, same off-by-default behavior, fully wrapped so it can never affect gameplay.

## 0.1.1
- Resubmission with full data-disclosure README and source link. No code changes.

## 0.1.0
- Initial release: explored-map % → Eilif community dashboard Cartographer board.
