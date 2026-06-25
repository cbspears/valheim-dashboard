// The server's mod list. Edit this file to update the Mods page — the dashboard
// reads it directly (no database needed). Push to redeploy.
//
// Source of truth: the Obsidian note `05-Server/Mods/Selected-Mods.md`. Keep
// `tentative` in sync with what's actually locked vs. still being decided.

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

  // ── Still being finalized (server-side — nothing for players to install) ──
  {
    name: 'ServersideQoL',
    author: 'ArgusMagnus',
    description:
      'Server-only comforts: infinite building/farming stamina, auto-closing doors, and chest sorting. Vanilla clients work fine — nothing to install.',
    category: 'QoL',
    clientRequired: false,
    tentative: true,
    url: 'https://thunderstore.io/c/valheim/p/ArgusMagnus/ServersideQoL/',
  },
  {
    name: 'ServerCharacters',
    author: 'Smoothbrain',
    description:
      'Keeps each character saved on the server (auto-backups, no tampering) — and feeds the per-player stats you see across this dashboard. Server-side.',
    category: 'Core',
    clientRequired: false,
    tentative: true,
    url: 'https://thunderstore.io/c/valheim/p/Smoothbrain/ServerCharacters/',
  },
];

export const MOD_CATEGORIES: ModCategory[] = ['Core', 'QoL', 'Content', 'Balance'];

/** Mods a player must install on their own machine (locked picks only). */
export const CLIENT_MODS: Mod[] = MODS.filter((m) => m.clientRequired && !m.tentative);
