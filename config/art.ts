/*
  ============================================================
  EILIF ART MANIFEST — the single source of truth for the
  painterly Norse art overhaul (cozy longhalls, frozen colossus,
  cold blue-grey + warm amber).
  ============================================================

  THE LIGHT-SWITCH
  ----------------
  Every art-backed component (PageHeader, HomeHero, BossPortrait, the
  OG image in app/layout.tsx) asks this module for its image via `art(id)`.
  `art(id)` returns null for any id that is NOT listed in `ART_AVAILABLE`.
  While `ART_AVAILABLE` is EMPTY, every helper returns null and every page
  renders EXACTLY as it does today — zero visual change. This is what makes
  the `art-overhaul` branch safe to merge before the images exist.

  GO-LIVE (when the finished art lands)
  -------------------------------------
  The 24 finished images live inside a .docx handoff (image sits directly
  above its `NN_label` caption). To light the overhaul up:

    1. Drop the .docx somewhere reachable, then run:
         node scripts/extract-eilif-art.mjs <path/to/handoff.docx> --write-manifest
       It unzips the docx, pairs each embedded image with the label
       paragraph that follows it, copies each to
       public/images/eilif/<label>.jpg, and rewrites ART_AVAILABLE below
       to the list of ids it successfully extracted.
    2. Visually review the pages (npx next build && npx next start).
    3. Merge.

  If you ever need to add ids by hand, list them in ART_AVAILABLE exactly
  as the keys of EILIF_ART. Files are served from /images/eilif/<id>.jpg.
*/

export interface ArtAsset {
  /** Public path, served from /public. */
  file: string;
  /** Descriptive alt text (empty string for purely decorative). */
  alt: string;
  /**
   * True when the artwork already has the server title painted into it.
   * Such images must NEVER have text overlaid on top of them.
   */
  titleBakedIn?: boolean;
}

/** Resolved art reference handed to a next/image `src`/`alt`. */
export interface ArtRef {
  src: string;
  alt: string;
}

/**
 * All 24 finished ids. Files resolve to `/images/eilif/<id>.jpg`.
 * Keys are the canonical ids; the extractor writes these same ids into
 * ART_AVAILABLE.
 */
export const EILIF_ART: Record<string, ArtAsset> = {
  '00_reference_style_image': {
    file: '/images/eilif/00_reference_style_image.jpg',
    alt: 'Eilif — a painterly Norse longhall beneath a frozen sky',
    titleBakedIn: true,
  },
  '01_cozy_longhall_fjord_cliff': {
    file: '/images/eilif/01_cozy_longhall_fjord_cliff.jpg',
    alt: 'A warm-lit longhall perched on a fjord cliff at dusk',
  },
  '02_longhall_doorway_title_card': {
    file: '/images/eilif/02_longhall_doorway_title_card.jpg',
    alt: 'Eilif — the open doorway of a longhall, a frozen colossus beyond',
    titleBakedIn: true,
  },
  '03_three_longships_title_card': {
    file: '/images/eilif/03_three_longships_title_card.jpg',
    alt: 'Eilif — three longships setting out across a cold sea',
    titleBakedIn: true,
  },
  '04_empty_snowfield_runestone': {
    file: '/images/eilif/04_empty_snowfield_runestone.jpg',
    alt: 'A lone runestone standing in an empty snowfield',
  },
  '05_frozen_fjord_dawn_aurora': {
    file: '/images/eilif/05_frozen_fjord_dawn_aurora.jpg',
    alt: 'Dawn aurora over a frozen fjord',
  },
  '06_frozen_giant_colossus': {
    file: '/images/eilif/06_frozen_giant_colossus.jpg',
    alt: 'A frozen giant colossus looming over the snow',
  },
  '07_longhall_snowy_night_text_space': {
    file: '/images/eilif/07_longhall_snowy_night_text_space.jpg',
    alt: 'A longhall glowing warm against a snowy night',
  },
  '08_longhall_interior_hearth_v1': {
    file: '/images/eilif/08_longhall_interior_hearth_v1.jpg',
    alt: 'The warm hearth inside a longhall',
  },
  '09_illustrated_fantasy_map': {
    file: '/images/eilif/09_illustrated_fantasy_map.jpg',
    alt: 'An illustrated fantasy map of the known world',
  },
  '10_longhall_interior_hearth_v2': {
    file: '/images/eilif/10_longhall_interior_hearth_v2.jpg',
    alt: 'Vikings gathered around the hearth of a longhall',
  },
  '11_overworld_vista': {
    file: '/images/eilif/11_overworld_vista.jpg',
    alt: 'A sweeping vista over the frozen overworld',
  },
  '12_skald_storytelling': {
    file: '/images/eilif/12_skald_storytelling.jpg',
    alt: 'A skald telling tales by firelight',
  },
  '13_craftsman_workbench_forge': {
    file: '/images/eilif/13_craftsman_workbench_forge.jpg',
    alt: "A craftsman's workbench and glowing forge",
  },
  '14_hall_of_deeds': {
    file: '/images/eilif/14_hall_of_deeds.jpg',
    alt: 'The hall of deeds, hung with trophies of great feats',
  },
  '15_viking_oath_scene': {
    file: '/images/eilif/15_viking_oath_scene.jpg',
    alt: 'Vikings swearing an oath by candlelight',
  },
  '16_new_frontier_longship': {
    file: '/images/eilif/16_new_frontier_longship.jpg',
    alt: 'A longship bound for a new frontier at first light',
  },
  '17_eikthyr_boss_portrait': {
    file: '/images/eilif/17_eikthyr_boss_portrait.jpg',
    alt: 'Eikthyr, the antlered stag of the Meadows',
  },
  '18_the_elder_boss_portrait': {
    file: '/images/eilif/18_the_elder_boss_portrait.jpg',
    alt: 'The Elder, the ancient treant of the Black Forest',
  },
  '19_bonemass_boss_portrait': {
    file: '/images/eilif/19_bonemass_boss_portrait.jpg',
    alt: 'Bonemass, the fetid horror of the Swamp',
  },
  '20_moder_boss_portrait': {
    file: '/images/eilif/20_moder_boss_portrait.jpg',
    alt: 'Moder, the dragon queen of the Mountains',
  },
  '21_yagluth_boss_portrait': {
    file: '/images/eilif/21_yagluth_boss_portrait.jpg',
    alt: 'Yagluth, the fallen god of the Plains',
  },
  '22_seeker_queen_boss_portrait': {
    file: '/images/eilif/22_seeker_queen_boss_portrait.jpg',
    alt: 'The Queen, seeker matriarch of the Mistlands',
  },
  '23_fader_boss_portrait': {
    file: '/images/eilif/23_fader_boss_portrait.jpg',
    alt: 'Fader, the herald of the Ashlands',
  },
};

/**
 * ────────────────────────────────────────────────────────────
 * THE LIGHT-SWITCH — keep EMPTY until the finished art lands.
 * The extractor rewrites this array (see the header comment).
 * List ids exactly as they appear as keys of EILIF_ART.
 * ────────────────────────────────────────────────────────────
 */
export const ART_AVAILABLE: string[] = [
  '00_reference_style_image',
  '01_cozy_longhall_fjord_cliff',
  '02_longhall_doorway_title_card',
  '03_three_longships_title_card',
  '04_empty_snowfield_runestone',
  '05_frozen_fjord_dawn_aurora',
  '06_frozen_giant_colossus',
  '07_longhall_snowy_night_text_space',
  '08_longhall_interior_hearth_v1',
  '09_illustrated_fantasy_map',
  '10_longhall_interior_hearth_v2',
  '11_overworld_vista',
  '12_skald_storytelling',
  '13_craftsman_workbench_forge',
  '14_hall_of_deeds',
  '15_viking_oath_scene',
  '16_new_frontier_longship',
  '17_eikthyr_boss_portrait',
  '18_the_elder_boss_portrait',
  '19_bonemass_boss_portrait',
  '20_moder_boss_portrait',
  '21_yagluth_boss_portrait',
  '22_seeker_queen_boss_portrait',
  '23_fader_boss_portrait',
];

const AVAILABLE = new Set(ART_AVAILABLE);

/**
 * True once ANY art has landed. Integration sites that would otherwise render
 * an always-visible element (e.g. a BossPortrait "mystery" placeholder) gate
 * on this so that while the manifest is EMPTY nothing new renders at all —
 * the zero-visual-change guarantee. Once art exists, the mystery fallback is
 * allowed to show for individual bosses that still lack a portrait (the Deep
 * North 8th boss, or any not yet extracted).
 */
export const ART_ENABLED = ART_AVAILABLE.length > 0;

/**
 * Resolve an art id to a { src, alt } ref, or null if the id is unknown
 * or not yet listed in ART_AVAILABLE. This null is the graceful-degrade
 * contract: every art component renders its fallback when it gets null.
 */
export function art(id: string | null | undefined): ArtRef | null {
  if (!id) return null;
  if (!AVAILABLE.has(id)) return null;
  const asset = EILIF_ART[id];
  if (!asset) return null;
  return { src: asset.file, alt: asset.alt };
}

/** True when the art for `id` has the title baked in (never overlay text). */
export function isTitleBakedIn(id: string | null | undefined): boolean {
  if (!id) return false;
  return Boolean(EILIF_ART[id]?.titleBakedIn);
}

/**
 * Route / slot → header art id. The keys are stable slot names the pages
 * pass to <PageHeader id={HEADER_ART.players} />, etc.
 */
export const HEADER_ART = {
  players: '10_longhall_interior_hearth_v2',
  world: '11_overworld_vista',
  map: '09_illustrated_fantasy_map',
  events: '12_skald_storytelling',
  mods: '13_craftsman_workbench_forge',
  gallery: '14_hall_of_deeds',
  oath: '15_viking_oath_scene',
  'get-started': '16_new_frontier_longship',
  /** Home hero (title baked in). */
  hero: '02_longhall_doorway_title_card',
  /** Small-screen hero fallback with clean text space. */
  heroSmall: '07_longhall_snowy_night_text_space',
  /** Open Graph / social card (title baked in). */
  og: '00_reference_style_image',
} as const;

export type HeaderSlot = keyof typeof HEADER_ART;

/** Resolve a header slot to its art ref (or null while unavailable). */
export function headerArt(slot: HeaderSlot): ArtRef | null {
  return art(HEADER_ART[slot]);
}

/**
 * Boss display name → portrait id. Names are matched case-insensitively.
 * Any boss not in this map (e.g. the 8th / Deep North boss) has no portrait
 * and BossPortrait renders its "mystery" placeholder instead.
 */
export const BOSS_PORTRAIT: Record<string, string> = {
  eikthyr: '17_eikthyr_boss_portrait',
  'the elder': '18_the_elder_boss_portrait',
  bonemass: '19_bonemass_boss_portrait',
  moder: '20_moder_boss_portrait',
  yagluth: '21_yagluth_boss_portrait',
  'the queen': '22_seeker_queen_boss_portrait',
  fader: '23_fader_boss_portrait',
};

/** Portrait id for a boss name, or null if none is mapped. */
export function bossPortraitId(name: string | null | undefined): string | null {
  if (!name) return null;
  return BOSS_PORTRAIT[name.trim().toLowerCase()] ?? null;
}

/**
 * Boss portrait art ref for a boss name, or null. Null means the caller
 * (BossPortrait) should render the frosted "???" mystery placeholder — this
 * covers both "portrait id not mapped" (Deep North boss) and "mapped but the
 * image isn't in ART_AVAILABLE yet".
 */
export function bossPortraitArt(name: string | null | undefined): ArtRef | null {
  return art(bossPortraitId(name));
}
