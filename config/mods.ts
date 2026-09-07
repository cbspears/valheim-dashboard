// The server's mod list. Edit this file to update the mod half of /resources —
// the dashboard reads it directly (no database needed). Push to redeploy.
//
// Source of truth: verified against the live server boot log 2026-08-27 (see Obsidian note
// `05-Server/Mods/Selected-Mods.md`), server-side versions re-checked against the
// 2026-09-05 `scripts/verify-restart.sh` run recorded in docs/ARCHITECTURE.md 3.1.
// Keep `tentative` in sync with what's actually locked vs. still being piloted.
//
// Client rows must state the version THE PACK PINS (decoded from the live pack
// code in config/server.ts), never the newest build in this repo. Player-facing
// copy carries no em or en dashes (CLAUDE.md copy doctrine).

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
}

export const MODS: Mod[] = [
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
    name: 'ValheimPlus (Grantapher fork)',
    author: 'Grantapher',
    description:
      'The backbone tweak suite: raises the player cap, infinite fuel, and dozens of light QoL toggles. The version must match the server exactly, so install it through the shared modpack.',
    // 9.17.1, NOT 0.9.17.1. This page tells players to install "matching the
    // versions below", and 9.17.1 is what a mod manager offers: pack v11's
    // export.r2x pins Grantapher-ValheimPlus_Grantapher_Temporary 9.17.1 and the
    // Thunderstore package API reports latest 9.17.1 (both checked 2026-09-05).
    // 0.9.17.1 is the assembly version the box logs. It lives in
    // docs/ARCHITECTURE.md 3.1 ("Version on the box") and is not selectable
    // anywhere. Get Started's Mac list (app/get-started/page.tsx) says 9.17.1 and
    // calls this page authoritative, so the two must not disagree.
    version: '9.17.1',
    category: 'Core',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Grantapher/ValheimPlus_Grantapher_Temporary/',
  },
  {
    name: 'PlantEverything',
    author: 'Advize',
    description:
      'Plant and harvest every flower, sapling, and crop with the cultivator, so you can raise proper farms and managed forests. Yields stay vanilla.',
    version: '1.20.0',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Advize/PlantEverything/',
  },
  {
    // VERSION = WHAT THE PACK SHIPS, not what the repo has built, same rule as the
    // Eilif Companion Client row below. Pack v11 pins **1.4.0**, so that is what this
    // row says and it stays 1.4.0 until pack v12 is minted and its code is live in
    // config/server.ts. 1.5.0 is published on Thunderstore; 1.6.0 is built and staged
    // in this repo (plugins/thunderstore/EilifPaths-1.6.0/) and not yet uploaded.
    //
    // THE DESCRIPTION BELOW IS AHEAD OF THE PIN, DELIBERATELY, AND IT IS THE ONE THING
    // HERE THAT NEEDS A DECISION. It names the 1.6.0 behaviours (the wider map
    // discovery and stamina in water) because v12 is what pins 1.6.0 and this page is
    // written for the pack the crew will be on. Until v12 is minted and deployed, a
    // player reading /resources is promised two things their client does not do. Either
    // ship this row WITH the v12 mint, or revert the last two sentences to the 1.4.0
    // copy kept here:
    //   'Beds also accept a fire 8 metres further off, and crafting upgrades attach 10
    //    metres further out at every station. Replaces the abandoned Useful Paths, whose
    //    path detection broke years ago. Ships in the modpack.'
    name: 'Eilif Paths',
    author: 'cbspears (custom-built)',
    description:
      'Dirt paths, paved roads, and floors you have built move you 40% faster, and running, jumping, swimming and hauling on them cost a quarter of the usual stamina. Tools and weapons are left out: a swing, a block, a drawn bow or a hoe costs normal stamina on a path or road, and nothing at all on a floor you built. The map now uncovers in a wider circle as you travel, half again as wide on foot and twice as wide while you are on a ship, deck or helm. Stamina also comes back in deep water, at the normal rate while you tread and half rate while you swim, without making the swim itself any cheaper. Beds accept a fire 8 metres further off, and crafting upgrades attach 10 metres further out at every station. Replaces the abandoned Useful Paths, whose path detection broke years ago. Ships in the modpack.',
    version: '1.4.0',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Eilif/EilifPaths/',
  },

  // ── Server-only, confirmed (nothing for players to install) ───────────────
  {
    name: 'ServersideQoL',
    author: 'ArgusMagnus',
    description:
      'Server-only comforts: infinite building and farming stamina, and doors that swing shut behind you. Vanilla clients work fine, so there is nothing to install.',
    version: '1.8.0',
    category: 'QoL',
    clientRequired: false,
    url: 'https://thunderstore.io/c/valheim/p/ArgusMagnus/ServersideQoL/',
  },
  {
    name: 'Eilif Companion',
    author: 'cbspears (custom-built)',
    // Death rules: keep-gear is the world's own Casual setting (the panel tier,
    // verified 2026-09-05 by scripts/verify-restart.sh). The plugin re-asserts
    // the same rule on every boot as belt and braces, so the copy below credits
    // the world, not the mod, and says plainly that only WORN gear stays:
    // `deathkeepequip` keeps equipped items, the rest still drops to a tombstone
    // (plugins/eilif-companion/README.md).
    description:
      "The voice of the Hall itself: it carries the in-game /oath swearing and speaks as Eilif. It also holds the world's death rule steady, so the gear you are wearing stays with you when you fall and the rest waits in your tombstone. Built just for this server; nothing to install.",
    version: '0.3.2',
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
  {
    name: 'WebMap',
    author: 'Zevaryx (repack of h0tw1r3)',
    description:
      "Renders the living world map that feeds this site's Map page. Server-side, nothing to install.",
    version: '2.7.1',
    category: 'Content',
    clientRequired: false,
    url: 'https://thunderstore.io/c/valheim/p/Zevaryx/WebMap/',
  },

  // ── Client-side, ships in the modpack ──────────────────────────────────────────────
  {
    name: 'AzuCraftyBoxes',
    author: 'Azumatt',
    description:
      'Craft and build using materials straight out of nearby chests, out to 20 metres (the server sets the range). Replaces the ValheimPlus chest-crafting feature, which broke in a live test. The mod also has a hotkey, Alt+O, that quietly switches all chest pulling off with no message to tell you. The current modpack ships that key unbound, so it cannot happen to you. If you are on an older pack and your crafting suddenly stops seeing chests, press Alt+O again to switch pulling back on, or update your pack. The server runs it too and checks the version, so anyone without it cannot join. Ships in the modpack.',
    version: '1.8.15',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Azumatt/AzuCraftyBoxes/',
  },
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
    // versions on every "Start modded", so the honest answer is the version pack
    // v11 pins, which is 0.2.0. EilifCompanionClient **0.3.2** IS published on
    // Thunderstore (checked 2026-09-05 against
    // thunderstore.io/api/experimental/package/Eilif/EilifCompanionClient/, which
    // reports latest 0.3.2 published that day), but the pack of record still pins
    // 0.2.0, so no player is running 0.3.2 yet. Bump this row to 0.3.2 only when
    // pack v12 is minted and its code is live in config/server.ts. Advertising it
    // earlier promises players gameplay they do not have: the tombstone keep-list
    // (0.3.0) and the self-binding `reporter` field on death reports (0.3.1).
    name: 'Eilif Companion Client',
    author: 'cbspears (custom-built)',
    description:
      'Your explored-map percentage flows to the Cartographer leaderboard automatically while you play, with no setup and nothing to upload. It also names exactly what killed you the moment you die, the creature or the hazard, so How We Die and the Saga show the real cause instead of a guess. Ships in the modpack.',
    version: '0.2.0',
    category: 'Content',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Eilif/EilifCompanionClient/',
  },
];

export const MOD_CATEGORIES: ModCategory[] = ['Core', 'QoL', 'Content', 'Balance'];

/** Mods a player must install on their own machine (locked picks only). */
export const CLIENT_MODS: Mod[] = MODS.filter((m) => m.clientRequired && !m.tentative);
