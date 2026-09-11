// Server identity & static facts. Edit here; the dashboard reads these directly.

export const SERVER_NAME = 'Eilif';
export const SERVER_TAGLINE = 'The Cozy Canon Playthrough';
export const SERVER_DESCRIPTION =
  'A modded Valheim dedicated server. Bosses gate progression. No sailing ahead of the longship, vikings.';

export const MAX_PLAYERS = 24; // enforced by ValheimPlus [Server] maxPlayers = 24 on the box (pack v14, 2026-09-10); Eilif Companion [ServerFallback] is parked
export const SERVER_HOST = 'GTXGaming';
export const WORLD_SEED = 'Yggdrasil'; // cosmetic — set to your real seed if you want it shown

// Optional external links shown around the dashboard. Leave '' to hide.
export const DISCORD_URL = '';

// The explored-world map (/map). Was OFF for a few hours on 2026-09-09: WebMap 2.7.1 broke on
// Valheim 1.0 (its routed-RPC prefix throws on every raid and global-key send)
// and came off the box, so no new frames arrive. While false the Map tab is
// hidden from the nav and the deep links to /map render as plain text; the page
// itself still answers by URL with a paused notice. Flip to true once WebMap or
// a replacement renders on 1.0 and eilif-map-snapshot is running again.
export const MAP_ENABLED = true;

// The bot's @handle in Discord — shown in the Gallery's "how to add" explainer.
export const DISCORD_BOT_HANDLE = '@Eilif';
// Public connect address shown on the Hall + Get Started page.
export const SERVER_ADDRESS = '191.101.30.229:6028';
// Join password, shown on Get Started. Charlie's call (2026-08-22): the page is
// public but that's fine — friends-and-family server. Case-sensitive in Valheim.
export const SERVER_PASSWORD = 'Leroy';

// Shared r2modman / Thunderstore Mod Manager profile code. Once you publish the
// version-pinned modpack, paste its code here and the Get Started page switches
// to the one-click "import this code" flow. Leave '' until then.
export const MODPACK_PROFILE_CODE = '01a091da-8c79-c55e-5bac-6536036590b3';

// Human-readable name for the pack the code above points at. Shown next to
// every copy of the code so a returning player can tell at a glance whether
// they are current. BUMP THIS EVERY TIME THE CODE IS RE-MINTED.
export const MODPACK_VERSION_LABEL = 'Pack v17 · Sep 11';

// A short, urgent notice shown as a gold banner at the top of the Hall and Get
// Started. Leave '' and no banner renders anywhere. Set it for launch week
// (Steam auto-updating everyone to Valheim 1.0 on Sept 9) or any other "read
// this before you play" moment, then blank it again when it's over.
//
// Plain sentences only, no markup. Keep it to two or three lines; the whole
// point is that people actually read it.
// Example of the register only. This one is a HOLD-ON-THE-OLD-VERSION notice
// and is NOT the Sept 2026 posture: Charlie's decision of record (2026-09-05)
// is that the server moves to 1.0 the same day, so nobody switches Valheim
// back. Read the live string below, not this, for what we actually told people.
//   'Sept 9: Steam updates Valheim to 1.0 automatically. Eilif stays on the
//    old version until the mods are rebuilt. Before you play, switch Valheim
//    back: Steam, Library, right-click Valheim, Properties, Betas. Do not
//    re-install the pack.'
export const LAUNCH_NOTICE = ''; // Charlie 2026-09-05: no site banner for launch week. The drafted text lives in the vault note 10-Launch-Comms-2026-09-09.md.

// ── Excluded characters ─────────────────────────────────────────────────────
//
// Characters that must not appear on any competitive or public surface: the
// leaderboards, the roster, Player of the Day, the title registry, Great Deed
// evaluation and progress, the /api/boards in-game sign feed, and presence.
// The first case is "Steward", an alt used to run errands in the hall — its
// sessions and stats are real, but the boards ask "which of the VIKINGS is
// ahead" and an alt is not one of them.
//
// THE DATABASE FLAG IS THE SOURCE OF TRUTH: `players.excluded`
// (db/2026-09-11_players_excluded.sql). This list is the FALLBACK, and it exists
// for the two cases the flag cannot cover:
//   1. before that migration is applied (the column does not exist yet, so every
//      read that names it fails and the site falls back to reading without it);
//   2. raw-query sites that never join `players` at all — sessions and events are
//      keyed by `character_name`, and the Discord bot tallies them by name.
// Either condition is enough: lib/excluded.ts treats `excluded === true` OR a
// name in this list as excluded.
//
// Names are matched case- and whitespace-insensitively (Valheim names are
// case-sensitive, but a typo here must not silently un-exclude anybody).
// The Discord bot mirrors this list — it cannot import TypeScript — via the
// EXCLUDED_CHARACTER_NAMES env var, defaulting to the same value. Change one,
// change the other, then `sudo systemctl restart eilif-discord-bot`.
export const EXCLUDED_CHARACTER_NAMES: readonly string[] = ['Steward'];
