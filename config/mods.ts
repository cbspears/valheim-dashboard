// The server's mod list. Edit this file to update the mod half of /resources —
// the dashboard reads it directly (no database needed). Push to redeploy.
//
// Source of truth for launch night 2026-09-09: the Valheim 1.0 load test run that
// morning, which decided pack v12 and the server plugin set. It supersedes the
// 2026-08-27 boot log and the 2026-09-05 `scripts/verify-restart.sh` run recorded in
// docs/ARCHITECTURE.md 3.1. Keep `tentative` in sync with what's actually locked vs.
// still being piloted.
//
// VALHEIMPLUS IS BACK (Charlie, 2026-09-10). This reverses the 2026-09-09 "retired for
// good" note that stood here: Grantapher shipped ValheimPlus **10.0.2** that morning
// (`Grantapher/ValheimPlus_Grantapher_Temporary`), a real Valheim 1.0 build, and its
// CraftFromChest works, so chest crafting comes back through V+ and AzuCraftyBoxes stays
// retired. Pack v14 pins it and its row is re-added below, right after BepInExPack.
// BOTH STAND-INS GO OFF IN v14, because they would stack with V+: EilifPaths
// `[VPlusFallback]` (infinite fuel, station reach, no roof check, gathering/picking/loot,
// no weather damage, area repair, floating items, shared map, camera) and Eilif Companion
// `[ServerFallback]` (the raised player cap). The cap of 24 is now V+ `[Server]
// maxPlayers = 24` on the box, which is what config/server.ts MAX_PLAYERS points at.
// EilifPaths KEEPS its own features (paths, bed fire range, station attachment range,
// exploration radius, deep-water stamina); only its `[VPlusFallback]` section is off.
//
// PLANTEVERYTHING IS BACK TOO (2026-09-10), under a different owner. Advize has not
// published a Valheim 1.0 build, but `fedorovdgap/PlantEverything` 1.21.1 is Advize's own
// master branch republished (commit e4a628c, "Initial update to Valheim 1.0"): same plugin
// GUID, same cfg file, decompiled and vetted before it went in. Its row is unhidden below
// with the fedorovdgap author, version and url. It is an INTERIM pin: when Advize publishes
// an official 1.21.x the row moves back to his namespace. Pack v15 pins it.
//
// HIDDEN (`hidden: true`, bottom of ALL_MODS) SINCE 2026-09-09, and why. These are not
// deleted: each comes back by removing its `hidden` line once there is a reason to.
//   • PlantEverything was here until 2026-09-10; see the paragraph above.
//   • AzuCraftyBoxes dies at startup on 1.0 as well, and as of 2026-09-10 it is also
//     SUPERSEDED: ValheimPlus CraftFromChest does the chest crafting again. It stays
//     hidden rather than deleted (Charlie's hide-not-delete rule).
//   • WebMap: was out for a few hours on 2026-09-09; back at 11:42 CT as a locally
//     built 1.0 port.
//   • ServersideQoL is not loaded on 1.0 either.
//
// Client rows must state the version THE PACK PINS (decoded from the live pack
// code in config/server.ts), never the newest build in this repo. The v15 rows below
// were set ahead of the mint on 2026-09-10: `MODPACK_PROFILE_CODE` is still v14's
// until Charlie pastes the v15 code in, and this file and that code must ship in the
// same deploy. Player-facing copy carries no em or en dashes (CLAUDE.md copy doctrine).

export type ModCategory = 'Core' | 'QoL' | 'Content' | 'Balance';

export interface Mod {
  name: string;
  author: string;
  description: string;
  /** pinned version, if locked. Omit while still on "latest / verify at setup". */
  version?: string;
  category: ModCategory;
  /** required client-side too? (players must install it themselves) */
  clientRequired: boolean;
  /** not yet finalized — shown with a "Considering" marker. */
  tentative?: boolean;
  url?: string;
  /**
   * Installed once, not running tonight. A hidden row stays out of MODS (so the
   * Resources page, the Get Started Mac checklist and every count ignore it) but
   * keeps its copy and pin so it can come back with one deleted line. Say why in a
   * comment on the row and date it.
   */
  hidden?: boolean;
}

export const ALL_MODS: Mod[] = [
  // ── Confirmed ────────────────────────────────────────────────────────────
  {
    name: 'BepInExPack Valheim',
    author: 'denikson',
    description:
      'The mod loader everything else runs on. A mod manager installs it for you automatically, so you rarely touch it directly.',
    version: '5.4.2350',
    category: 'Core',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/denikson/BepInExPack_Valheim/',
  },
  {
    // Back in the pack 2026-09-10 (Charlie). Grantapher's 10.0.2 is the first real
    // Valheim 1.0 build of the fork and its CraftFromChest works, which is what
    // decided it. The server runs the same version with `enforceMod` on, so a client
    // on any other V+ version is refused: this row's version and the pack pin must
    // never drift apart. The comforts named here are the SERVER-side settings of
    // record, and they are why EilifPaths `[VPlusFallback]` is off in v14.
    name: 'ValheimPlus',
    author: 'Grantapher (fork of the ValheimPlus team)',
    description:
      'The all-round comfort mod, the source of most of the small kindnesses you feel every session. Craft and build straight out of the chests around you, out to 30 metres from the workbench area. Rain no longer wears down what you have built, one hammer swing repairs everything damaged within 7.5 metres, you can place pieces from 12 metres away, taking a piece back down refunds every resource it cost, and pieces can be placed freely rather than only where the game usually allows. Fires and furnishings warm you out to 20 metres. Workbenches and other stations reach 30 metres and need no roof, and upgrades attach from 20 metres out. Fires, ovens and torches burn without fuel. Gathering and picking run 30% richer. Dropped items float instead of sinking and wait an hour before they fade. The map is shared, so exploration and pins spread to everyone, and carts and boats show on it too. The camera pulls back to 100 metres with a wider view. You can sleep in any bed nobody has claimed. Hold LeftAlt to snap building pieces to a grid, F7 turns snapping on and off, F6 sets the default. The server checks the version, so everyone needs exactly this one. Ships in the modpack.',
    version: '10.0.2',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Grantapher/ValheimPlus_Grantapher_Temporary/',
  },
  {
    // VERSION = WHAT THE PACK SHIPS, not what the repo has built, same rule as the
    // Eilif Companion Client row below. Pack v14 pins **1.7.1**, unchanged from v13.
    //
    // 2026-09-10: `[VPlusFallback]` is OFF in v14 now that ValheimPlus 10.0.2 is back
    // (the two would stack), so every sentence about the comforts it used to stand in
    // for is gone from the copy below and lives on the ValheimPlus row instead. What
    // stays here is this mod's own work: paths, roads and floors, the bed fire range,
    // the extra station attachment range, the wider map discovery and deep-water stamina.
    name: 'Eilif Paths',
    author: 'cbspears (custom-built)',
    description:
      'Dirt paths, paved roads, and floors you have built move you 40% faster, and running, jumping, swimming and hauling on them cost a quarter of the usual stamina. Tools and weapons are left out: a swing, a block, a drawn bow or a hoe costs normal stamina on a path or road, and nothing at all on a floor you built. It does two more things: the map uncovers in a wider circle as you travel, twice as wide on foot and five times as wide while you are on a ship, and stamina comes back in deep water, at the normal rate while you tread and half rate while you swim, without making the swim itself any cheaper. Beds also accept a fire 8 metres further off, and crafting upgrades attach 10 metres further out at every station. Replaces the abandoned Useful Paths, whose path detection broke years ago. Ships in the modpack.',
    version: '1.7.1',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Eilif/EilifPaths/',
  },

  // ── Server-only, confirmed (nothing for players to install) ───────────────
  {
    name: 'Eilif Companion',
    author: 'cbspears (custom-built)',
    // Death rules: keep-gear is the world's own Casual setting (the panel tier,
    // verified 2026-09-05 by scripts/verify-restart.sh). The plugin re-asserts
    // the same rule on every boot as belt and braces, so the copy below credits
    // the world, not the mod, and says plainly that only WORN gear stays:
    // `deathkeepequip` keeps equipped items, the rest still drops to a tombstone
    // (plugins/eilif-companion/README.md).
    //
    // 0.3.3 on the box since launch night (the 1.0 rebuild), unchanged in v14.
    // 2026-09-10: its `[ServerFallback]` is PARKED. ValheimPlus 10.0.2 is back and
    // `[Server] maxPlayers = 24` holds the hall again, so the cap sentence is out of
    // the copy below and config/server.ts MAX_PLAYERS points at V+, not here.
    description:
      "The voice of the Hall itself: it carries the in-game /oath swearing and speaks as Eilif. It holds the world's death rule steady, so the gear you are wearing stays with you when you fall and the rest waits in your tombstone. Built just for this server; nothing to install.",
    version: '0.3.3',
    category: 'Core',
    clientRequired: false,
  },

  {
    name: 'Eilif Boards',
    author: 'cbspears (custom-built)',
    description:
      'Turns any sign into a living leaderboard. Write [board:kills] on a sign and it fills in with the top five within a few minutes, then keeps itself current about once a minute. The same works for [board:deaths], [board:builds], [board:resources], [board:explored], [board:distance], plus [board:titles] and [board:deeds]. Add :leader to any of the six ranked boards, like [board:kills:leader], for a small plaque naming just the champion. Write anything else on the sign to take it back. Server-side, nothing to install.',
    version: '0.2.0',
    category: 'Content',
    clientRequired: false,
  },

  // ── Server-only, confirmed (feeds this dashboard — nothing to install) ────
  {
    name: 'GsValheimStats Emitter',
    author: 'Proudlock_Technology',
    description:
      'Streams live presence and boss-kill data straight into this dashboard. The live roster and the boss timeline run on it. Server-side, nothing to install.',
    version: '0.2.4',
    category: 'Content',
    clientRequired: false,
    url: 'https://thunderstore.io/c/valheim/p/Proudlock_Technology/GsValheimStatsEmitter/',
  },

  // ── Client-side, ships in the modpack ──────────────────────────────────────────────
  {
    name: 'GsValheimStatsClient',
    author: 'Proudlock_Technology',
    description:
      'Richer per-viking stats: kills and deaths, damage dealt, weapon records. They feed the leaderboards and your viking page. Ships in the modpack.',
    version: '0.2.12',
    category: 'Content',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Proudlock_Technology/GsValheimStatsClient/',
  },
  {
    // VERSION = WHAT THE PACK SHIPS, not what the repo has built. This page tells a
    // player which mods they are running, and r2modman reinstalls the pinned pack
    // versions on every "Start modded", so the honest answer is the version the pack
    // pins. Pack v14 pins **0.4.2**, cut 2026-09-10 (0.4.0 plus the 1.0 map-percentage fix; 0.4.2 re-release adds the AI-assistance disclosure): it reads your own Valheim 1.0
    // profile counters (kills, deaths, builds, crafts, distance) and posts them with
    // the rest, which is what refills the kill, death, build and distance boards that
    // went quiet when 1.0 moved those counters. That is the one player-visible thing
    // this bump buys, which is why the copy names it and why this row must not go out
    // ahead of the v14 code in config/server.ts. 0.3.4 (the 1.0 rebuild that made the
    // tombstone keep-list work) is still the floor underneath it.
    name: 'Eilif Companion Client',
    author: 'cbspears (custom-built)',
    description:
      'Your explored-map percentage flows to the Cartographer leaderboard automatically while you play, with no setup and nothing to upload. It names exactly what killed you the moment you die, the creature or the hazard, so How We Die and the Saga show the real cause instead of a guess. It also carries a keep-list, so the tools and gear a viking cannot afford to lose stay on you through a death that would otherwise scatter them. New in this pack: it reads your own kills, deaths, builds, crafts and distance travelled straight off your character and sends them along, so those boards fill in again. Ships in the modpack.',
    version: '0.4.2',
    category: 'Content',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Eilif/EilifCompanionClient/',
  },
  {
    // Added 2026-09-10 (Charlie). Client-only; nothing on the server runs it.
    //
    // WHY THE PACK PINS ITS CFG, and do not "tidy" this away: Unshamed's own
    // defaults switch ON four settings that wipe the character's cheat flag -
    // `Clear On Load`, `Clear On Save`, `Clear After Command` and `Clear Cheat
    // Stat`. That is cheat-flag washing: it would let a viking who typed a dev
    // command claim achievements anyway, and it edits the character file to do it.
    // Eilif wants none of that, so `scripts/pack-templates/config/Azumatt.Unshamed.cfg.tmpl`
    // pins all four **Off** and leaves only `Ignore Modded Flag` on, which is the
    // single thing this mod is here for. The copy below promises exactly that, so
    // if the cfg ever changes, this row has to change with it.
    //
    // Optional in the minter: `--unshamed 1.0.0`, absent from a render that does
    // not ask for it (it was not in pack v11, so there is no baseline).
    name: 'Unshamed',
    author: 'Azumatt',
    description:
      'Valheim 1.0 switches Steam achievements off for anyone running mods, whatever the mods actually do. This turns them back on for a modded client, and only that. Real cheating still counts against you exactly as it does in plain Valheim: cheat commands, spawned items and cheated worlds all disqualify you, and the settings the modpack ships keep it that way. If you already earned achievements while they were blocked, type unshamed retro in the console to see the list and claim them. Ships in the modpack.',
    version: '1.0.0',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Azumatt/Unshamed/',
  },
  {
    // UNHIDDEN 2026-09-10, under a new owner. Advize's 1.20.0 dies at startup on 1.0
    // (its ServerSync reads ZRoutedRpc.Everybody, now a const) and Advize has published
    // nothing since. fedorovdgap/PlantEverything 1.21.1 is Advize's OWN master branch
    // republished (commit e4a628c, "Initial update to Valheim 1.0"): same plugin GUID
    // advize.PlantEverything, same cfg file, internal version 1.21.0. Decompiled and
    // vetted before it went in the pack. Pack v15 pins it as `--no-plant --plant-fork
    // 1.21.1`; when Advize ships an official 1.21.x this row goes back to his namespace
    // and the minter flags go back to `--plant <ver>`.
    name: 'PlantEverything',
    author: 'fedorovdgap (unofficial 1.0 rebuild of Advize\'s mod)',
    description:
      'Plant and harvest every flower, sapling, and crop with the cultivator, so you can raise proper farms and managed forests. Yields stay vanilla. Advize, who wrote it, has not published a Valheim 1.0 build yet, so the modpack ships this rebuild of his code in the meantime and will move back to his release when it arrives. The server runs it too and checks the version, so anyone without it cannot join. Ships in the modpack.',
    version: '1.21.1',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/fedorovdgap/PlantEverything/',
  },
  // ── Hidden since 2026-09-09: not running on the 1.0 box, not in pack v15 ────
  // Each row keeps its last known-good pin and copy. Remove `hidden: true` (and
  // re-add the pack pin in scripts/mint-pack.mjs) when the author ships a 1.0 build.
  {
    // Same ServerSync failure as PlantEverything; dead on both server and client.
    // SUPERSEDED 2026-09-10: ValheimPlus 10.0.2 is back in pack v14 and its
    // CraftFromChest does the chest crafting (30 metres, checked from the workbench
    // area), so this mod is not coming back even if Azumatt ships a 1.0 build. It
    // stays hidden rather than deleted, per the hide-not-delete rule.
    name: 'AzuCraftyBoxes',
    author: 'Azumatt',
    description:
      'Craft and build using materials straight out of nearby chests, out to 20 metres (the server sets the range). Replaces the ValheimPlus chest-crafting feature. The mod also has a hotkey, Alt+O, that quietly switches all chest pulling off with no message to tell you. The modpack ships that key unbound, so it cannot happen to you. The server runs it too and checks the version, so anyone without it cannot join. Ships in the modpack.',
    version: '1.8.15',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Azumatt/AzuCraftyBoxes/',
    hidden: true,
  },
  {
    // Its Start coroutine calls World.GetRootPath(FileSource), removed in 1.0.
    name: 'ServersideQoL',
    author: 'ArgusMagnus',
    description:
      'Server-only comforts: infinite building and farming stamina, and doors that swing shut behind you. Vanilla clients work fine, so there is nothing to install.',
    version: '1.8.0',
    category: 'QoL',
    clientRequired: false,
    url: 'https://thunderstore.io/c/valheim/p/ArgusMagnus/ServersideQoL/',
    hidden: true,
  },
  {
    // Back on the box 2026-09-09 11:42 as a 1.0 port: upstream PR #24 (bekcarts) plus
    // our fix for its player-list packet (postfix on ZNet.WritePlayerInfo instead of
    // the old SendPlayerList transpiler, and m_playfabId = ""). Same 2.7.1 version
    // string; DLL md5 8360f7d5. Source: scratchpad webmap-port (not in this repo yet).
    name: 'WebMap',
    author: 'Zevaryx (repack of h0tw1r3)',
    description:
      "Renders the living world map that feeds this site's Map page. Server-side, nothing to install.",
    version: '2.7.1',
    category: 'Content',
    clientRequired: false,
    url: 'https://thunderstore.io/c/valheim/p/Zevaryx/WebMap/',
  },
];

/** What the site shows: every mod that is actually running tonight. */
export const MODS: Mod[] = ALL_MODS.filter((m) => !m.hidden);

export const MOD_CATEGORIES: ModCategory[] = ['Core', 'QoL', 'Content', 'Balance'];

/** Mods a player must install on their own machine (locked picks only). */
export const CLIENT_MODS: Mod[] = MODS.filter((m) => m.clientRequired && !m.tentative);
