// The server's mod list. Edit this file to update the Mods page — the dashboard
// reads it directly (no database needed). Push to redeploy.
//
// Source of truth: verified on the live server 2026-07-03 (see Obsidian note
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
      'The backbone tweak suite — raises the player cap, build-from-nearby-chests, infinite fuel, and dozens of light QoL toggles. The version must match the server exactly, so install it through the shared modpack.',
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
    name: 'Useful Paths',
    author: 'Menthus',
    description:
      'Run, jog, and walk faster — and burn less stamina — on paths, paved roads, and leveled ground. Makes the road network actually worth building. Configurable.',
    version: '1.5.0',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Menthus/Useful_Paths/',
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
    author: 'Blockspace (custom-built)',
    description:
      "The voice of the Hall itself — carries the in-game /oath swearing and speaks as Eilif. Built just for this server; nothing to install.",
    version: '0.1.0',
    category: 'Core',
    clientRequired: false,
  },

  // ── Server-only, piloting (feeds this dashboard — nothing to install) ─────
  {
    name: 'GsValheimStats Emitter',
    author: 'Proudlock_Technology',
    description:
      'Server-side eyes and ears — streams live presence and boss-kill data straight into this dashboard. Piloting now; nothing to install.',
    version: '0.2.4',
    category: 'Content',
    clientRequired: false,
    tentative: true,
    url: 'https://thunderstore.io/c/valheim/p/Proudlock_Technology/GsValheimStatsEmitter/',
  },
  {
    name: 'WebMap',
    author: 'Zevaryx (repack of h0tw1r3)',
    description:
      "Renders the living world map that feeds this site's Map page. Piloting now; server-side, nothing to install.",
    version: '2.7.1',
    category: 'Content',
    clientRequired: false,
    tentative: true,
    url: 'https://thunderstore.io/c/valheim/p/Zevaryx/WebMap/',
  },

  // ── Client-optional, piloting ──────────────────────────────────────────────
  {
    name: 'GsValheimStatsClient',
    author: 'Proudlock_Technology',
    description:
      'Richer per-viking stats — deaths, biomes explored, playtime — feeding the leaderboards. Optional while it pilots; install it if you want your name on the deeper stats pages.',
    version: '0.2.9',
    category: 'Content',
    clientRequired: true,
    tentative: true,
    url: 'https://thunderstore.io/c/valheim/p/Proudlock_Technology/GsValheimStatsClient/',
  },
];

export const MOD_CATEGORIES: ModCategory[] = ['Core', 'QoL', 'Content', 'Balance'];

/** Mods a player must install on their own machine (locked picks only). */
export const CLIENT_MODS: Mod[] = MODS.filter((m) => m.clientRequired && !m.tentative);
