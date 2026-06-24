// The server's installed mod list. Edit this file to update the Mods page —
// the dashboard reads it directly (no database needed). Push to redeploy.

export type ModCategory = 'Core' | 'QoL' | 'Content' | 'Balance';

export interface Mod {
  name: string;
  author: string;
  description: string;
  version: string;
  category: ModCategory;
  /** required client-side too? (players must install) */
  clientRequired: boolean;
  url?: string;
}

export const MODS: Mod[] = [
  {
    name: 'BepInExPack Valheim',
    author: 'denikson',
    description: 'The mod loader framework everything else runs on. Required on client and server.',
    version: '5.4.2202',
    category: 'Core',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/denikson/BepInExPack_Valheim/',
  },
  {
    name: 'ValheimPlus',
    author: 'ValheimPlus Team',
    description: 'Massive config-driven tweak suite — build anywhere, stack sizes, stamina, carry weight, and more.',
    version: '0.9.13',
    category: 'Core',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/ValheimPlus/ValheimPlus/',
  },
  {
    name: 'Discord Connector',
    author: 'nwesterhausen',
    description: 'Relays joins, leaves, deaths, boss kills, and chat from the server to our Discord. Server-only.',
    version: '3.1.0',
    category: 'Core',
    clientRequired: false,
    url: 'https://thunderstore.io/c/valheim/p/nwesterhausen/DiscordConnector/',
  },
  {
    name: 'PlantEverything',
    author: 'Advize',
    description: 'Plant and grow every seed, sapling, and vegetable — proper farms and tree harvesting.',
    version: '1.16.0',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/Advize/PlantEverything/',
  },
  {
    name: 'EquipmentAndQuickSlots',
    author: 'RandyKnapp',
    description: 'Adds three quick-use slots and separate equipment slots so your inventory breathes.',
    version: '2.1.11',
    category: 'QoL',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/RandyKnapp/EquipmentAndQuickSlots/',
  },
  {
    name: 'EpicLoot',
    author: 'RandyKnapp',
    description: 'Magic items, rarities, enchanting, and loot drops. Gives the late game real chase gear.',
    version: '0.10.4',
    category: 'Content',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/RandyKnapp/EpicLoot/',
  },
  {
    name: 'Useful Trophies',
    author: 'WonderfulMods',
    description: 'Turn boss & creature trophies into wearable trinkets with passive bonuses.',
    version: '1.5.2',
    category: 'Content',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/WonderfulMods/UsefulTrophies/',
  },
  {
    name: 'Better Archery',
    author: 'ishid4',
    description: 'Reworked bow handling, quivers, and arrow physics for the rangers among us.',
    version: '3.4.0',
    category: 'Balance',
    clientRequired: true,
    url: 'https://thunderstore.io/c/valheim/p/ishid4/BetterArchery/',
  },
];

export const MOD_CATEGORIES: ModCategory[] = ['Core', 'QoL', 'Content', 'Balance'];
