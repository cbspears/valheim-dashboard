// The server's mod list. Edit this file to update the mod half of /resources —
// the dashboard reads it directly (no database needed). Push to redeploy.
//
// Source of truth for launch night 2026-09-09: the Valheim 1.0 load test run that
// morning, which decided pack v12 and the server plugin set. It supersedes the
// 2026-08-27 boot log and the 2026-09-05 `scripts/verify-restart.sh` run recorded in
// docs/ARCHITECTURE.md 3.1. Keep `tentative` in sync with what's actually locked vs.
// still being piloted.
//
// VALHEIMPLUS IS RETIRED FOR GOOD (Charlie, 2026-09-09). Its row was DELETED from this
// file, not hidden: the Grantapher fork has no Valheim 1.0 build, the author has been
// silent since 2026-02-06, and the server is not going back to it. Everything the crew
// used it for now lives in our own two plugins, and that is the permanent arrangement:
// the raised player cap in Eilif Companion `[ServerFallback]`, and the comforts (infinite
// fuel, station reach, no roof check, the gathering, picking and loot bonuses, no weather
// damage, area repair, floating items, shout range) in EilifPaths `[VPlusFallback]`.
// Do not re-add a ValheimPlus row.
//
// HIDDEN (`hidden: true`, bottom of ALL_MODS) SINCE 2026-09-09, and why. These are not
// deleted: each comes back by removing its `hidden` line once a 1.0 build exists.
//   • PlantEverything and AzuCraftyBoxes both die at startup on 1.0, so neither ships
//     in pack v12. There is no chest-crafting mod on the server tonight.
//   • WebMap: was out for a few hours; back at 11:42 CT as a locally built 1.0 port.
//   • ServersideQoL is not loaded on 1.0 either.
//
// Client rows must state the version THE PACK PINS (decoded from the live pack
// code in config/server.ts), never the newest build in this repo. The v12 rows below
// were set ahead of the mint on launch morning: `MODPACK_PROFILE_CODE` is still v11's
// until Charlie pastes the v12 code in, and this file and that code must ship in the
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
    version: '5.4.2333',
    category: 'Core',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/denikson/BepInExPack_Valheim/',
  },
  {
    // VERSION = WHAT THE PACK SHIPS, not what the repo has built, same rule as the
    // Eilif Companion Client row below. Pack v12 pins **1.7.0**, uploaded to
    // Thunderstore 2026-09-09 12:04 CT; the four new [VPlusFallback] comforts named
    // in the copy below are 1.7.0 code.
    //
    // The description is the launch-day text from docs/LAUNCH-DAY.md step 19, which
    // takes over the two comforts the deleted ValheimPlus row used to carry (the
    // raised cap is Eilif Companion's half; the fuel, station reach and gathering
    // bonus are this mod's `[VPlusFallback]`), plus one sentence for what 1.6.0 added:
    // the wider map discovery and stamina in deep water.
    name: 'Eilif Paths',
    author: 'cbspears (custom-built)',
    description:
      'Dirt paths, paved roads, and floors you have built move you 40% faster, and running, jumping, swimming and hauling on them cost a quarter of the usual stamina. Tools and weapons are left out: a swing, a block, a drawn bow or a hoe costs normal stamina on a path or road, and nothing at all on a floor you built. New in this pack: the map uncovers in a wider circle as you travel, half again as wide on foot and twice as wide while you are on a ship, and stamina comes back in deep water, at the normal rate while you tread and half rate while you swim, without making the swim itself any cheaper. Beds also accept a fire 8 metres further off, and crafting upgrades attach 10 metres further out at every station. With ValheimPlus gone this mod also carries the comforts it used to hold: fires, ovens, hot tubs and shield generators burn without fuel, workbenches build out to 30 metres and need no roof, and gathering, picking and loot all run 30% richer. It now carries three more of them as well: rain no longer erodes your buildings, one hammer click repairs everything damaged within 7.5 metres, and dropped items float instead of sinking out of reach. Those last ones run on whichever machine owns the ground, so a fire or a berry bush close to the world’s first spawn behaves the old way. Replaces the abandoned Useful Paths, whose path detection broke years ago. Ships in the modpack.',
    version: '1.7.0',
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
    // 0.3.3 on the box for launch night (the 1.0 rebuild). Its `[ServerFallback]` is
    // what holds the hall at 24 now that ValheimPlus is gone, which is why the copy
    // below says so and why config/server.ts MAX_PLAYERS points here.
    description:
      "The voice of the Hall itself: it carries the in-game /oath swearing and speaks as Eilif. It holds the world's death rule steady, so the gear you are wearing stays with you when you fall and the rest waits in your tombstone. With ValheimPlus gone it is also what keeps the hall's doors wide, holding the server at 24 vikings instead of the ten Valheim allows on its own. Built just for this server; nothing to install.",
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
    // pins. Pack v12 pins **0.3.4**, the Valheim 1.0 rebuild cut on 2026-09-09: 1.0
    // renumbered the game's GlobalKeys enum, so only 0.3.4 reads `deathkeepequip`
    // correctly and only 0.3.4 actually engages the tombstone keep-list on a 1.0
    // server. The keep-list is the one player-visible thing this bump buys, which is
    // why the copy names it and why this row must not go out ahead of the v12 code
    // in config/server.ts.
    name: 'Eilif Companion Client',
    author: 'cbspears (custom-built)',
    description:
      'Your explored-map percentage flows to the Cartographer leaderboard automatically while you play, with no setup and nothing to upload. It names exactly what killed you the moment you die, the creature or the hazard, so How We Die and the Saga show the real cause instead of a guess. New in this pack: a keep-list, so the tools and gear a viking cannot afford to lose stay on you through a death that would otherwise scatter them. Ships in the modpack.',
    version: '0.3.4',
    category: 'Content',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Eilif/EilifCompanionClient/',
  },
  // ── Hidden since 2026-09-09: not running on the 1.0 box, not in pack v12 ────
  // Each row keeps its last known-good pin and copy. Remove `hidden: true` (and
  // re-add the pack pin in scripts/mint-pack.mjs) when the author ships a 1.0 build.
  {
    // Dies at startup on 1.0 (ServerSync reads ZRoutedRpc.Everybody, now a const).
    name: 'PlantEverything',
    author: 'Advize',
    description:
      'Plant and harvest every flower, sapling, and crop with the cultivator, so you can raise proper farms and managed forests. Yields stay vanilla.',
    version: '1.20.0',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Advize/PlantEverything/',
    hidden: true,
  },
  {
    // Same ServerSync failure as PlantEverything; dead on both server and client.
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
