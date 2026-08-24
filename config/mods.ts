// The server's mod list. Edit this file to update the Mods page — the dashboard
// reads it directly (no database needed). Push to redeploy.
//
// Source of truth: verified against the live server boot log 2026-08-22 (see Obsidian note
// `05-Server/Mods/Selected-Mods.md`). Keep `tentative` in sync with what's
// actually locked vs. still being piloted.

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
      'The mod loader everything else runs on. A mod manager installs it for you automatically — you rarely touch it directly.',
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
    version: '0.9.17.1',
    category: 'Core',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Grantapher/ValheimPlus_Grantapher_Temporary/',
  },
  {
    name: 'PlantEverything',
    author: 'Advize',
    description:
      'Plant and harvest every flower, sapling, and crop with the cultivator — proper farms and managed forests. Yields stay vanilla.',
    version: '1.20.0',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Advize/PlantEverything/',
  },
  {
    name: 'Eilif Paths',
    author: 'cbspears (custom-built)',
    description:
      'Roads that matter: +40% speed and stamina drain cut to a quarter on dirt paths, paved roads, and built floors (wood, stone, iron). Replaces the abandoned Useful Paths, whose path detection broke years ago. Also gives beds 8 metres of extra reach on the fire-nearby check, so you no longer have to shove your bed into the hearth, and lets crafting upgrades attach from 10 metres further out at every station, not just the workbench. Ships in the modpack.',
    version: '1.3.0',
    category: 'QoL',
    clientRequired: true,
    url: 'https://github.com/cbspears/valheim-dashboard/tree/main/plugins/eilif-paths',
  },

  // ── Server-only, confirmed (nothing for players to install) ───────────────
  {
    name: 'ServersideQoL',
    author: 'ArgusMagnus',
    description:
      'Server-only comforts: infinite building and farming stamina, and doors that swing shut behind you. Vanilla clients work fine — nothing to install.',
    version: '1.8.0',
    category: 'QoL',
    clientRequired: false,
    url: 'https://thunderstore.io/c/valheim/p/ArgusMagnus/ServersideQoL/',
  },
  {
    name: 'Eilif Companion',
    author: 'cbspears (custom-built)',
    description:
      "The voice of the Hall itself — carries the in-game /oath swearing and speaks as Eilif. Built just for this server; nothing to install.",
    version: '0.2.0',
    category: 'Core',
    clientRequired: false,
  },

  // ── Server-only, confirmed (feeds this dashboard — nothing to install) ────
  {
    name: 'GsValheimStats Emitter',
    author: 'Proudlock_Technology',
    description:
      'Streams live presence and boss-kill data straight into this dashboard — the live roster and boss timeline run on it. Server-side, nothing to install.',
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
      'Craft and build using materials straight out of nearby chests, out to 20 metres (the server sets the range). Replaces the ValheimPlus chest-crafting feature, which broke in a live test. The server runs it too and checks the version, so anyone without it cannot join. Ships in the modpack.',
    version: '1.8.15',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Azumatt/AzuCraftyBoxes/',
  },
  {
    name: 'GsValheimStatsClient',
    author: 'Proudlock_Technology',
    description:
      'Richer per-viking stats — kills and deaths, damage dealt, weapon records — feeding the leaderboards and your viking page. Ships in the modpack.',
    version: '0.2.12',
    category: 'Content',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Proudlock_Technology/GsValheimStatsClient/',
  },
  {
    name: 'Eilif Companion Client',
    author: 'cbspears (custom-built)',
    description:
      'Your explored-map percentage flows to the Cartographer leaderboard automatically while you play, with no setup and nothing to upload. It also names exactly what killed you the moment you die, the creature or the hazard, so How We Die and the Saga show the real cause instead of a guess. Ships in the modpack.',
    version: '0.2.0',
    category: 'Content',
    clientRequired: true,
    url: 'https://github.com/cbspears/valheim-dashboard/tree/main/plugins/eilif-companion-client',
  },
];

export const MOD_CATEGORIES: ModCategory[] = ['Core', 'QoL', 'Content', 'Balance'];

/** Mods a player must install on their own machine (locked picks only). */
export const CLIENT_MODS: Mod[] = MODS.filter((m) => m.clientRequired && !m.tentative);
