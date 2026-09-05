// Server identity & static facts. Edit here; the dashboard reads these directly.

export const SERVER_NAME = 'Eilif';
export const SERVER_TAGLINE = 'The Cozy Canon Playthrough';
export const SERVER_DESCRIPTION =
  'A modded Valheim dedicated server. Bosses gate progression — no sailing ahead of the longship, vikings.';

export const MAX_PLAYERS = 20; // matches ValheimPlus [Server] maxPlayers on the box (Charlie, 2026-09-05)
export const SERVER_HOST = 'GTXGaming';
export const WORLD_SEED = 'Yggdrasil'; // cosmetic — set to your real seed if you want it shown

// Optional external links shown around the dashboard. Leave '' to hide.
export const DISCORD_URL = '';

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
export const MODPACK_PROFILE_CODE = '01a0440c-b54a-8d15-5882-22f86a4333b4';

// Human-readable name for the pack the code above points at. Shown next to
// every copy of the code so a returning player can tell at a glance whether
// they are current. BUMP THIS EVERY TIME THE CODE IS RE-MINTED.
export const MODPACK_VERSION_LABEL = 'Pack v11 · Aug 27';

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
