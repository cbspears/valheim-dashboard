// The master register: every word the hall answers to, every word it speaks
// back, and every page it keeps.
//
// THE RULE THIS FILE LIVES BY. Every entry is derived from code that is running
// today, and every entry names the file and the symbols it came from in
// `source`. Nothing here is aspirational, nothing is invented, and nothing
// behind a feature flag that ships OFF is listed.
// `scripts/commands-page.test.mjs` is the tripwire: it reads the bot's own parse
// regexes, its permission helpers, the plugin's shout prefixes, the flag
// defaults in index.js and the channel routing in the deployed .env, and it
// fails when a verb has no entry, when an audience contradicts the gate that
// enforces it, when a notice claims a channel it does not post to, when a
// `source` cites a symbol that is not there, or when the copy drifts out of
// doctrine.
//
// WHAT IS DELIBERATELY ABSENT.
//   • `@Eilif oath / bio / role` (services/discord-bot/src/oaths.js) is gated
//     behind OATH_INGEST, which is `=== '1'` in index.js and is not set on the
//     live bot. The in-game `/s /oath` path below is a different code path
//     entirely (app/api/webhook/route.ts) and IS live.
//   • The weekly chronicle, boss polls, the Storyteller office, telling votes
//     and altar tellings all ship off (WEEKLY_CHRONICLE, BOSS_POLLS,
//     STORYTELLER, TELLING_VOTES, ALTAR_TELLINGS).
//
// WHERE THINGS LAND. Five announcements route by env var (RECAP_CHANNEL,
// MILESTONE_CHANNEL, OATH_CHANNEL, BOSS_CHANNEL and TITLE_CHANNEL). Their CODE
// default is `valheim`; the rehearsal pilot overrode them to `server` in the
// deployed bot's .env, and `scripts/cutover-env.sh --apply` (docs/LAUNCH-DAY.md
// step 20b) removes those overrides at launch and sets TITLE_CHANNEL, at which
// point all five go back to #valheim.
//
// **Re-pointed to #valheim on 2026-09-09 as launch-day step 20b's fourth item,
// the one cutover-env.sh does not print.** Until `--apply` has actually run on
// the box, this file is deliberately AHEAD of the live .env, so the tripwire
// fails on exactly those five entries and on nothing else. That failure is the
// expected state between this edit and the cutover, and it clears itself the
// moment 20b runs. Do not "fix" it by putting #server back.
//
// The four feed notices with no channelVar (the death feed, arrivals, raids and
// the shout mirror) are NOT part of that move: they ride the relay's own feed
// channel and CHAT_CHANNEL_ID, and they stay in #server.
//
// The tripwire resolves each var out of index.js and the live .env and fails
// when the two disagree with what is written here.
//
// COPY DOCTRINE (CLAUDE.md): titles say plainly what a thing is; the Norse
// register lives in subtitles and empty states. No em dashes, no en dashes, no
// exclamation marks. The tripwire checks all three, here and on the page.

/**
 * Who may use a command.
 *
 * "an admin" is the set `voice.js mayPuppet` and `tellings.js mayKeepTelling`
 * both test for: Administrator, Manage Server, or a role id in ADMIN_ROLE_IDS.
 * It is deliberately NOT "the owner": a moderator with Manage Server is in it.
 */
export type Audience =
  | 'any member'
  | 'a linked viking'
  | 'the viking who told it, or an admin'
  | 'the Storyteller, or an admin of the hall'
  | 'the viking who wrote it, the Storyteller, or an admin'
  | 'an admin of the hall';

type Base = {
  /** stable anchor id, unique across the whole registry */
  id: string;
  /** the file and symbols this entry was derived from */
  source: string;
  /** the env flag that gates it, when one does */
  flag?: string;
};

/** The shape both typed things share: a command line and what it does. */
type TypedCommand = Base & {
  /** the exact line, mention or slash included */
  text: string;
  /** the part that is actually worth copying, when it is not the whole line */
  copy?: string;
  /** other spellings of the same verb that the parser also accepts */
  also?: string[];
  who: Audience;
  what: string;
  example: string;
  note?: string;
};

/** Something a player types in Discord. `copy` is what goes AFTER the mention. */
export type DiscordCommand = TypedCommand & { kind: 'discord' };

/**
 * Something a player does inside the game.
 *
 * `how` says which of the two ways it is done, because they are not the same
 * act and the page must not tell a viking to shout a thing that is written:
 *   'shout' (the default) leads with /s, because proximity chat never reaches
 *     the dedicated server and the Companion's hooks only fire on a shout.
 *   'sign'  is the whole text of a plain wooden sign, which the Boards plugin
 *     reads off the world itself. Nothing is typed into chat at all.
 */
export type GameShout = TypedCommand & { kind: 'in-game'; how?: 'shout' | 'sign' };

/** Something the hall says to the player, unprompted. */
export type Notification = Base & {
  kind: 'notification';
  /** plain name of the thing */
  text: string;
  /** where it appears */
  where: string;
  /** what triggers it */
  trigger: string;
  /** how often */
  cadence: string;
  /**
   * The Discord channel it posts to, as the DEPLOYED bot routes it today.
   * Omitted for anything that is spoken in game, sent as a DM, or written to a
   * page rather than posted. `where` must name it as `#channel`.
   */
  channel?: 'server' | 'valheim';
  /** the env var that routes it by NAME, when one does */
  channelVar?: string;
  /** the env var that routes it by channel ID, when one does */
  channelIdVar?: string;
};

/** A page of this site. */
export type SitePage = Base & {
  kind: 'page';
  /** the path */
  text: string;
  /** the nav label, or the heading for a page with no tab */
  label: string;
  what: string;
};

export type RegistryEntry = DiscordCommand | GameShout | Notification | SitePage;

// ── In Discord ─────────────────────────────────────────────────────────────
// Every one of these needs a REAL mention: type @, pick Eilif from the popup.
// Typing the letters by hand looks the same and does nothing (the handlers all
// gate on message.mentions.has, discord.js MENTION_STRICT).

export const DISCORD_COMMANDS: DiscordCommand[] = [
  {
    kind: 'discord',
    id: 'i-am',
    text: '@Eilif I am <YourVikingName>',
    copy: 'I am ',
    who: 'any member',
    what: 'Eilif carves you a six letter rune and whispers it to you in a private message. Shout that rune in game and your Discord is bound to the viking you are playing, so your deeds, photos and title all gather under one name.',
    example: '@Eilif I am Bren Bjornsson',
    note: 'The rune fades after twenty minutes. Ask again within the first minute and Eilif tells you the rune you already hold is still good; wait longer than that and it carves you a fresh one.',
    source: 'services/discord-bot/src/identity.js parseIdentity, mintClaim, mintCooldownLeftMs',
    flag: 'IDENTITY_LINK',
  },
  {
    kind: 'discord',
    id: 'join',
    text: '@Eilif join',
    copy: 'join',
    who: 'any member',
    what: 'The same rite without naming a viking up front. Whichever viking you are playing when you shout the rune becomes yours.',
    example: '@Eilif join',
    source: 'services/discord-bot/src/identity.js parseIdentity',
    flag: 'IDENTITY_LINK',
  },
  {
    kind: 'discord',
    id: 'who-am-i',
    text: '@Eilif who am I',
    copy: 'who am I',
    who: 'any member',
    what: 'Eilif answers with the viking the hall has you bound to, or tells you how to bind one.',
    example: '@Eilif who am I',
    source: 'services/discord-bot/src/identity.js parseIdentity, currentLink',
    flag: 'IDENTITY_LINK',
  },
  {
    kind: 'discord',
    id: 'retell',
    text: '@Eilif retell <Boss>: <your telling>',
    copy: 'retell ',
    also: ['@Eilif tell <Boss>: <your telling>'],
    who: 'a linked viking',
    what: 'Files your account of that boss falling and makes it the one the war room shows, in place of the Skald’s. Nothing is overwritten: every telling is kept, and yours becomes the one that stands.',
    example: '@Eilif retell Bonemass: we lost the raft twice before the swamp let us through',
    note: 'Bind your Discord first, because Eilif files the telling against your viking. Up to 2000 characters, and one telling every five minutes. The boss can be written any way: Bonemass, bonemass, The Elder and the-elder all work. A newline may stand in for the space after the colon, so you can write a paragraph.',
    source: 'services/discord-bot/src/tellings.js parseTellings, handleRetell, resolveSenderPlayer',
    flag: 'TELLINGS',
  },
  {
    kind: 'discord',
    id: 'tellings',
    text: '@Eilif tellings <Boss>',
    copy: 'tellings ',
    also: ['@Eilif retellings <Boss>'],
    who: 'any member',
    what: 'Lists what has been told of that fall, numbered, up to twenty. The number is what you hand to keep.',
    example: '@Eilif tellings Bonemass',
    source: 'services/discord-bot/src/tellings.js parseTellings, handleList',
    flag: 'TELLINGS',
  },
  {
    kind: 'discord',
    id: 'keep',
    text: '@Eilif keep <Boss> <n>',
    copy: 'keep ',
    who: 'the viking who told it, or an admin',
    what: 'Makes telling number n the one the war room shows. The numbers come from the list above. You may always re-choose your own; an admin of the hall may choose anyone’s.',
    example: '@Eilif keep The Elder 2',
    source: 'services/discord-bot/src/tellings.js parseTellings, handleKeep, mayKeepTelling',
    flag: 'TELLINGS',
  },
  {
    kind: 'discord',
    id: 'tale',
    text: '@Eilif tale <Title>: <your tale>',
    copy: 'tale ',
    also: ['@Eilif tale for yesterday <Title>: <your tale>', '@Eilif tale for Sep 12 <Title>: <your tale>'],
    who: 'the Storyteller, or an admin of the hall',
    what: 'Writes a tale of the hall about a night that was not a boss: a game night, an RP evening, whatever happened. It appears on Story inside that night’s episode, and again under Written by the warband.',
    example: '@Eilif tale for last night The Longship Race: two boats, one barrel, and Bren in the water',
    note: 'With no day named it is about today. Name one with `for yesterday`, `for last night`, `for 2026-09-12` or `for Sep 12`; a night in the future is refused, and a bare month and day are read in the current year, so write the whole date when you mean an earlier one. Up to 4000 characters and an 80-character title, one tale every two minutes. A line break may stand in for any of the spaces, so you can write paragraphs.',
    source: 'services/discord-bot/src/tales.js parseTales, handleWrite, mayWriteTale',
  },
  {
    kind: 'discord',
    id: 'tales',
    text: '@Eilif tales',
    copy: 'tales',
    who: 'any member',
    what: 'Lists the last ten tales of the hall, numbered, newest night first. The number is what you hand to untale or retale.',
    example: '@Eilif tales',
    source: 'services/discord-bot/src/tales.js parseTales, handleList',
  },
  {
    kind: 'discord',
    id: 'untale',
    text: '@Eilif untale <n>',
    copy: 'untale ',
    who: 'the viking who wrote it, the Storyteller, or an admin',
    what: 'Takes tale number n off Story. The numbers come from the list above.',
    example: '@Eilif untale 2',
    source: 'services/discord-bot/src/tales.js parseTales, handleUntale, mayEditTale',
  },
  {
    kind: 'discord',
    id: 'retale',
    text: '@Eilif retale <n>: <the tale>',
    copy: 'retale ',
    who: 'the viking who wrote it, the Storyteller, or an admin',
    what: 'Rewrites the words of tale number n, keeping its name and the night it is about.',
    example: '@Eilif retale 2: how it actually went',
    source: 'services/discord-bot/src/tales.js parseTales, handleRetale, mayEditTale',
  },
  {
    kind: 'discord',
    id: 'gallery',
    text: '@Eilif <your caption> (with an image attached)',
    copy: '',
    who: 'any member',
    what: 'The picture is copied into the hall’s own store and appears on the Gallery, with your words as its caption. If the caption names a place someone has pinned, the photo is tied to that pin on the map. Eilif reacts with a frame when it lands.',
    example: '@Eilif the longhouse at last, roof and all',
    // WORDED SO THE PAGE CANNOT LIE (T-3 audit site-6). This used to read "Works
    // in any channel of the hall, because no gallery channel is set" -- a claim
    // about the bot's .env, which the site never sees and Vercel has no variable
    // for. Any channel of the hall IS the setting (Charlie, 2026-09-06:
    // CHANNEL_GALLERY stays unset), so the fact stays; the reason it was true,
    // which the site cannot stand behind, is gone. scripts/commands-page.test.mjs
    // holds "any channel" to the deployed bot's env, so if that decision is ever
    // reversed the tripwire goes red instead of the page going quietly wrong.
    note: 'Works in any channel of the hall. Images up to 12 MB, and a few at a time. An admin can pull a photo back down by reacting with a bin on the post.',
    source: 'services/discord-bot/src/gallery.js createGalleryIngest, handleMessage, galleryChannelId',
    flag: 'GALLERY_INGEST',
  },
  {
    kind: 'discord',
    id: 'say',
    text: '@Eilif say: <line>',
    copy: 'say: ',
    who: 'an admin of the hall',
    what: 'Eilif speaks your line in game, center screen, to everyone online. Administrator, Manage Server or an admin role is enough; anyone else is told it is for admins.',
    example: '@Eilif say: the mead is warm and the gate is open',
    source: 'services/discord-bot/src/voice.js createVoiceEngine, handleMessage, mayPuppet',
    flag: 'VOICE_ENGINE',
  },
];

// ── In the game ────────────────────────────────────────────────────────────
// TWO DIFFERENT ACTS, and `how` on each entry says which one it is.
//
//   how: 'shout' (the default) must be SHOUTED. Proximity chat never reaches
//   the dedicated server, so a plain line is never seen by the hall; the
//   plugin's hooks only fire on Talker.Type.Shout.
//
//   how: 'sign' is not chat at all. The marker is the WHOLE text of a plain
//   wooden sign, and EilifBoards reads it off the world (SignBoards.cs
//   MarkerRe is anchored, so a sign that merely mentions a marker inside a
//   sentence is left alone). Shouting one of these does nothing whatsoever.
//
// The section subtitle below has to keep saying both, and the tripwire holds
// every entry to its own `how`.

export const GAME_SHOUTS: GameShout[] = [
  {
    kind: 'in-game',
    id: 'oath-first',
    text: '/s /oath <RUNE> <your vow, one line>',
    copy: '/s /oath ',
    who: 'any member',
    what: 'Swears your vow onto the oath wall and binds your Discord to the viking you are playing. This is the shout the rune from @Eilif I am is for.',
    example: '/s /oath K7M2QP I will not sail ahead of the longship',
    note: 'It must be a shout. Lead with /s or the line never leaves the campfire.',
    source: 'plugins/eilif-companion/src/OathCapture.cs OathPrefix; app/api/webhook/route.ts oath, isClaimCode',
  },
  {
    kind: 'in-game',
    id: 'oath-again',
    text: '/s /oath <your new vow>',
    copy: '/s /oath ',
    who: 'any member',
    what: 'Swearing again replaces the vow on the wall. Your latest oath is the one that stands, and no rune is needed for this one.',
    example: '/s /oath the swamp took my shield and I went back for it',
    note: 'It replaces the vow filed under the viking you are playing, so it is the name in game that decides whose oath changes, not your Discord.',
    source: 'plugins/eilif-companion/src/OathCapture.cs OathPrefix; app/api/webhook/route.ts oath, identityOf',
  },
  {
    kind: 'in-game',
    id: 'oath-link-only',
    text: '/s /oath <RUNE>',
    copy: '/s /oath ',
    who: 'any member',
    what: 'The rune on its own, with nothing after it. Binds your Discord and leaves the vow you already swore exactly as it stands, with no second ceremony.',
    example: '/s /oath K7M2QP',
    note: 'This is the form Eilif hands you when you ask to be bound and the wall already carries your oath.',
    source: 'app/api/webhook/route.ts oath, link-only swear; services/discord-bot/src/identity.js alreadySworn, rune',
  },
  {
    kind: 'in-game',
    id: 'pin-poi',
    text: '/s /pin <Place name>',
    copy: '/s /pin ',
    who: 'any member',
    what: 'Drops a marker where you are standing onto the hall’s map, as a place worth knowing. Name it well: a photo whose caption names the same place is tied to the pin.',
    example: '/s /pin The Dark Chapel',
    note: 'A name that is already pinned is moved rather than doubled, so standing somewhere better and shouting the same name again is how you correct a pin.',
    source: 'plugins/eilif-companion/src/EilifCompanionPlugin.cs Patch_OnNewChatMessage_Pin, PinRe; app/api/webhook/route.ts pins',
  },
  {
    kind: 'in-game',
    id: 'pin-base',
    text: '/s /pin base <Place name>',
    copy: '/s /pin base ',
    who: 'any member',
    what: 'The same marker, recorded as a base rather than a point of interest. The word base is the only keyword the shout takes; everything else is the name.',
    example: '/s /pin base Odinshold',
    source: 'plugins/eilif-companion/src/EilifCompanionPlugin.cs Patch_OnNewChatMessage_Pin, PinRe',
  },
  {
    kind: 'in-game',
    id: 'shout-mirror',
    text: '/s <anything that is not a command>',
    copy: '/s ',
    who: 'any member',
    what: 'A shout that does not begin with a slash is mirrored one way into Discord, so the vikings who are not logged on still hear the hall. It never touches the saga or this site.',
    example: '/s the greydwarves found the portal again',
    note: 'Anything starting with a slash is treated as a command, so a shout of /foo reaches Discord as nothing at all.',
    source: 'plugins/eilif-companion/src/OathCapture.cs OathCapture, Prefix; services/log-poller/src/index.js chatChannelId',
  },

  // ── the board signs ──────────────────────────────────────────────────────
  // Written, not shouted. Everything below is derived from the marker regex in
  // SignBoards.cs, the key list in BoardsFeed.cs and the strings lib/boards.ts
  // renders, and the tripwire reads all three.
  {
    kind: 'in-game',
    how: 'sign',
    id: 'board-stat',
    text: '[board:kills]',
    also: [
      '[board:deaths]',
      '[board:builds]',
      '[board:resources]',
      '[board:explored]',
      '[board:distance]',
    ],
    who: 'any member',
    what: 'Turns an ordinary sign into a live leaderboard. Build a sign, write the marker as the whole of its text, and the top five for that stat appear on it with the leader accented. Write anything else on the sign and it is yours again.',
    example: '[board:resources]',
    note: 'This one is written on a sign, never shouted. It has to be the plain wooden sign you can write on, and the marker has to be the sign’s whole text: a sign that only mentions a marker inside a sentence stays yours. Case and stray spaces do not matter. A newly marked sign is found within about five minutes, and every board redraws about once a minute after that.',
    source:
      'plugins/eilif-boards/src/SignBoards.cs MarkerRe, ParseMarker; plugins/eilif-boards/src/BoardsFeed.cs BoardKeys, Canonical; plugins/eilif-boards/src/EilifBoardsPlugin.cs ScanSeconds, PollSeconds; lib/boards.ts statBoard, TOP_N',
  },
  {
    kind: 'in-game',
    how: 'sign',
    id: 'board-leader',
    text: '[board:kills:leader]',
    also: [
      '[board:deaths:leader]',
      '[board:builds:leader]',
      '[board:resources:leader]',
      '[board:explored:leader]',
      '[board:distance:leader]',
    ],
    who: 'any member',
    what: 'The same six stats as a one line plaque: the heading, whoever leads it, and their number, with no runners up. Write the other marker on the same sign to turn a plaque back into a full board.',
    example: '[board:distance:leader]',
    note: 'Written on a sign, never shouted. Only those six take the leader ending. There is no leader of Living Titles and no leader of Great Deeds, so a sign written that way is not a marker at all and stays yours.',
    source:
      'plugins/eilif-boards/src/BoardsFeed.cs BoardKeys, Claim, Leader, Stats; lib/boards.ts buildLeaders, leaderPlaque',
  },
  {
    kind: 'in-game',
    how: 'sign',
    id: 'board-titles',
    text: '[board:titles]',
    who: 'any member',
    what: 'Every titled viking on one plank, in alphabetical order, each with the title they carry. It is a roll rather than a race, so nobody on it is accented.',
    example: '[board:titles]',
    note: 'Written on a sign, never shouted. A viking who has not earned a title yet is left off until they do.',
    source:
      'plugins/eilif-boards/src/BoardsFeed.cs BoardKeys, Titles; lib/boards.ts titlesBoard, MAX_TITLE_CHARS',
  },
  {
    kind: 'in-game',
    how: 'sign',
    id: 'board-deeds',
    text: '[board:deeds]',
    who: 'any member',
    what: 'Where the warband stands on Great Deeds: how many of them are earned out of all there are, and the name of the newest one.',
    example: '[board:deeds]',
    note: 'Written on a sign, never shouted. This one counts for all of you at once, so there is nobody to name on it.',
    source:
      'plugins/eilif-boards/src/BoardsFeed.cs BoardKeys, Deeds; lib/boards.ts deedsBoard, DeedsSummary',
  },
];

// ── What the hall says to you ──────────────────────────────────────────────
// Cadences are the code's own constants and, where the deployed .env overrides
// one, the deployed value: the log poller reads the server log every 20 s
// (services/log-poller/src/index.js intervalMs), the bot relays every 15 s
// (POLL_INTERVAL_MS in its .env), and the Companion plugin asks for queued
// lines every 120 s (EilifCompanionPlugin.cs PollSeconds). "Inside about a
// minute" is derived from those three, not measured against production.

export const NOTIFICATIONS: Notification[] = [
  {
    kind: 'notification',
    id: 'death-feed',
    text: 'The death feed',
    where: 'Discord, in #server',
    trigger: 'A viking falls, with the thing that felled them named',
    cadence: 'As it happens, inside about a minute',
    channel: 'server',
    source: 'services/discord-bot/src/format.js formatFeedEvent, death; services/discord-bot/src/relay.js tick',
  },
  {
    kind: 'notification',
    id: 'arrivals',
    text: 'Arrivals and departures',
    where: 'Discord, in #server',
    trigger: 'Someone enters or leaves the realm',
    cadence: 'As it happens, inside about a minute',
    channel: 'server',
    source: 'services/discord-bot/src/format.js formatFeedEvent, join, leave; services/discord-bot/src/relay.js tick',
  },
  {
    kind: 'notification',
    id: 'raids',
    text: 'Raid warnings',
    where: 'Discord, in #server',
    trigger: 'A raid begins on the server',
    cadence: 'As it happens, inside about a minute',
    channel: 'server',
    source: 'services/discord-bot/src/format.js formatFeedEvent, raid; services/discord-bot/src/relay.js tick',
  },
  {
    kind: 'notification',
    id: 'shout-mirror-feed',
    text: 'The shout mirror',
    where: 'Discord, in #server',
    trigger: 'Someone shouts in game with /s, and the shout is not a slash command',
    cadence: 'As it happens, inside about a minute',
    channel: 'server',
    channelIdVar: 'CHAT_CHANNEL_ID',
    source: 'services/log-poller/src/index.js chatChannelId; plugins/eilif-companion/src/OathCapture.cs OathCapture',
  },
  {
    kind: 'notification',
    id: 'boss-fall',
    text: 'The first fall of a boss',
    where: 'Discord, in #valheim, with everyone called',
    trigger: 'One of the Forsaken is felled for the first time',
    cadence: 'Once per boss, checked every thirty seconds',
    channel: 'valheim',
    channelVar: 'BOSS_CHANNEL',
    source: 'services/discord-bot/src/bosses.js createBossWatcher; services/discord-bot/src/format.js formatBossKill',
  },
  {
    kind: 'notification',
    id: 'skald',
    text: 'The Skald’s account',
    where: 'On that boss’s war room page',
    trigger: 'A boss falls, and Eilif writes the saga of the fight from what it recorded',
    cadence: 'Once per fall, and it stands until a viking answers it with a telling',
    source: 'services/discord-bot/src/retelling.js createSkald, recordSkaldTelling',
  },
  {
    kind: 'notification',
    id: 'recap',
    text: 'The daily recap',
    where: 'Discord, in #valheim',
    trigger: 'The day closes: hours kept, vikings fallen, and the Player of the Day',
    cadence: 'Once a night at 23:00 America/Chicago',
    channel: 'valheim',
    channelVar: 'RECAP_CHANNEL',
    source: 'services/discord-bot/src/recap.js schedule, postRecap',
  },
  {
    kind: 'notification',
    id: 'great-deeds',
    text: 'Great Deeds',
    where: 'Discord, in #valheim, and spoken in game',
    trigger: 'The warband crosses a threshold that belongs to all of you at once',
    cadence: 'One deed at a time, with a minute of quiet between them',
    channel: 'valheim',
    channelVar: 'MILESTONE_CHANNEL',
    source: 'services/discord-bot/src/milestones.js createMilestonesAnnouncer, DEFAULT_MIN_GAP_MS',
    flag: 'MILESTONES_ANNOUNCE',
  },
  {
    kind: 'notification',
    id: 'titles',
    text: 'Title proclamations',
    where: 'Discord, in #valheim, and spoken in game',
    trigger: 'Your standing against the warband shifts far enough to earn you a new epithet',
    cadence: 'Checked every ten minutes, and rare by design',
    channel: 'valheim',
    channelVar: 'TITLE_CHANNEL',
    source: 'services/discord-bot/src/titles.js createTitlesAnnouncer',
    flag: 'TITLES_ANNOUNCE',
  },
  {
    kind: 'notification',
    id: 'oath-echo',
    text: 'The oath echo',
    where: 'Spoken in game, and posted to Discord in #valheim',
    trigger: 'You shout an oath',
    cadence: 'Once per oath, straight away',
    channel: 'valheim',
    channelVar: 'OATH_CHANNEL',
    source: 'services/discord-bot/src/voice.js checkOathEchoes, OATH_ECHO_LINES',
    flag: 'VOICE_ENGINE',
  },
  {
    kind: 'notification',
    id: 'telling-echo',
    text: 'The telling echo',
    where: 'Spoken in game',
    trigger: 'Someone files a telling of a boss falling',
    cadence: 'Once per telling',
    source: 'services/discord-bot/src/tellings.js TELLING_VOICE_LINES',
    flag: 'TELLINGS',
  },
  {
    kind: 'notification',
    id: 'tale-echo',
    text: 'The tale echo',
    where: 'Spoken in game',
    trigger: 'The Storyteller writes a tale of the hall',
    cadence: 'Once per tale, and never on a rewrite',
    source: 'services/discord-bot/src/tales.js TALE_VOICE_LINES',
  },
  {
    kind: 'notification',
    id: 'voice-ambient',
    text: 'The Voice of the Hall',
    where: 'Spoken in game, center screen',
    trigger:
      'Eilif has something to say to a hall that is not empty. Roughly one line in four reads a sworn oath back to the viking who swore it, and a nearly empty hall gets a closer, quieter pool',
    cadence: 'About one line per two hours of someone being online, and never within thirty minutes of any other line',
    source: 'services/discord-bot/src/voice.js CADENCE_MINUTES, DEFAULT_MIN_GAP_MS, pickAmbient',
    flag: 'VOICE_ENGINE',
  },
  {
    kind: 'notification',
    id: 'voice-dawn',
    text: 'Dawn lines',
    where: 'Spoken in game, center screen',
    trigger: 'Light comes back to Eilif and someone is there to see it',
    cadence: 'Once on every third world day, on its own clock',
    source: 'services/discord-bot/src/voice.js DAWN, DAWN_EVERY_DAYS, checkDawn',
    flag: 'VOICE_ENGINE',
  },
  {
    kind: 'notification',
    id: 'voice-poty',
    text: 'The Player of the Day crown',
    where: 'Spoken in game',
    trigger: 'The evening recap crowns someone',
    cadence: 'Once a night, with the recap',
    source: 'services/discord-bot/src/voice.js announcePoty; services/discord-bot/src/recap.js onPotyCrowned',
    flag: 'VOICE_ENGINE',
  },
  {
    kind: 'notification',
    id: 'voice-death-tiers',
    text: 'Death milestone lines',
    where: 'Spoken in game',
    trigger: 'Your own count of deaths crosses a tier',
    cadence: 'At your twentieth death, your fiftieth, your hundredth, and every hundred after that',
    source: 'services/discord-bot/src/voice.js deathTier, DEATH_TIER_STEP, deathMilestoneLine',
    flag: 'VOICE_ENGINE',
  },
  {
    kind: 'notification',
    id: 'rune-dm',
    text: 'Your rune, in a private message',
    where: 'Discord, a direct message from Eilif',
    trigger: 'You ask to be bound with @Eilif I am or @Eilif join',
    cadence: 'Once per ask, straight away',
    source: 'services/discord-bot/src/identity.js createIdentityLink, rune, alreadySworn',
    flag: 'IDENTITY_LINK',
  },
  {
    kind: 'notification',
    id: 'binding-dm',
    text: 'The binding confirmation',
    where: 'Discord, a direct message from Eilif',
    trigger: 'The hall consumes the rune you shouted and your saga is linked',
    cadence: 'Once, checked every thirty seconds',
    source: 'services/discord-bot/src/identity.js createIdentityConfirmations, tick',
    flag: 'IDENTITY_LINK',
  },
];

// ── The pages ──────────────────────────────────────────────────────────────

export const SITE_PAGES: SitePage[] = [
  {
    kind: 'page',
    id: 'page-hall',
    text: '/',
    label: 'Hall',
    // Names the way in first. Since 2026-09-06 the Hall opens with the first
    // run band and the boss progress card, and this row is the register a
    // newcomer reads at the top of Resources: it has to say that the front
    // page carries the route in, not only the standings.
    what: 'The way in for a new viking, who is online now, boss progress, the Great Deeds standing, the latest story and what is coming up.',
    source: 'app/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-players',
    text: '/players',
    label: 'Vikings',
    what: 'Every warrior who has set foot on these shores, the oaths they have sworn, the leaderboards, the attendance grid and how we die.',
    source: 'app/players/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-oath',
    // A section of the Vikings page since 2026-09-06, not a page of its own.
    // /oath still answers: next.config.ts sends it here, anchor and all, so a
    // bookmark or an older Discord link still lands on the wall.
    text: '/players#oaths',
    label: 'Oaths sworn',
    what: 'A section of the Vikings page, not a page of its own: the wall of every vow sworn in the hall, newest first, with how to swear yours and bind your Discord to your viking.',
    source: 'app/players/page.tsx SignatureWall',
  },
  {
    kind: 'page',
    id: 'page-world',
    text: '/world',
    label: 'World',
    // Says the same thing the page itself now says. Valheim does not gate a
    // biome behind a boss, so the register must not claim it does either.
    what: 'Which Forsaken have fallen and which one is next, with the ledger of Great Deeds earned and still ahead. Clearing them in order is our rule, not the game’s.',
    source: 'app/world/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-map',
    text: '/map',
    label: 'Map',
    what: 'The known world, fogged to only what the warband has charted, with your pins on it and a replay of how it was uncovered.',
    source: 'app/map/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-events',
    text: '/events',
    label: 'Story',
    what: 'Each night the vikings gather becomes a chapter, with the running feed of everything the hall recorded.',
    source: 'app/events/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-storyteller',
    text: '/events/storyteller',
    label: 'Written by the warband',
    what: 'The same story, filtered to what vikings wrote themselves: every tale of a night, and every telling of a boss falling.',
    source: 'app/events/storyteller/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-gallery',
    text: '/gallery',
    label: 'Gallery',
    what: 'Screenshots the warband tagged into Discord, credited to the viking who posted them and tied to the map where a caption names a pin.',
    source: 'app/gallery/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-resources',
    text: '/resources',
    label: 'Resources',
    // One page since 2026-09-06, when Mods and Commands merged. /mods and
    // /commands still answer: next.config.ts redirects them here, to #mods and
    // #commands, so a bookmark or an older Discord link still lands.
    what: 'What every page of this site holds, the words we use, the modpack, and every command the hall answers to.',
    source: 'app/resources/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-get-started',
    text: '/get-started',
    label: 'Get Started',
    what: 'Install the mods, then join, and the two rites to perform once you are in.',
    source: 'app/get-started/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-viking',
    text: '/viking/<name>',
    label: 'A viking’s page',
    what: 'One warrior: their title, their oath, their deaths, their catch and their photos. Reached from the Vikings page.',
    source: 'app/viking/[slug]/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-boss',
    text: '/boss/<name>',
    label: 'A war room',
    what: 'One Forsaken: the fight, who stood in it, and the telling that stands. Reached from the World page.',
    source: 'app/boss/[slug]/page.tsx',
  },
];

// ── The words this site uses ───────────────────────────────────────────────
// Nine words a reader meets on this site with no definition anywhere, gathered
// where a newcomer will read them: at the top of Resources, under the page
// register. Every one of them is used in the copy today, which is the whole
// test scripts/commands-page.test.mjs applies to this list.
//
// One plain line each, doctrine voice: the meaning says what the word means,
// and the flavour stays in the section subtitle above it.

export type GlossaryTerm = {
  /** stable anchor id, unique across the glossary */
  id: string;
  /** the word exactly as a reader meets it on the site */
  term: string;
  /** one plain line, no second sentence of atmosphere */
  meaning: string;
  /** the file and symbols this meaning was derived from */
  source: string;
};

export const GLOSSARY: GlossaryTerm[] = [
  {
    id: 'word-hall',
    term: 'the hall',
    meaning: 'Eilif itself: this server and its Discord, taken as one place.',
    source: 'config/server.ts SERVER_NAME',
  },
  {
    id: 'word-rune',
    term: 'rune',
    meaning:
      'The six letter code Eilif whispers you once, to prove your Discord and your viking are the same person.',
    source: 'services/discord-bot/src/identity.js mintClaim',
  },
  {
    id: 'word-telling',
    term: 'telling',
    meaning: 'Your account of one boss falling, shown on that boss’s page.',
    source: 'services/discord-bot/src/tellings.js handleRetell',
  },
  {
    id: 'word-tale',
    term: 'tale',
    meaning: 'Your account of one night, shown on Story.',
    source: 'services/discord-bot/src/tales.js handleWrite',
  },
  {
    id: 'word-skald',
    term: 'the Skald',
    meaning:
      'Eilif writing the first account of a fight itself, from what it recorded, until a viking tells it better.',
    source: 'services/discord-bot/src/retelling.js recordSkaldTelling',
  },
  {
    id: 'word-war-room',
    term: 'war room',
    // Deliberately NOT the wording of SITE_PAGES page-boss, which a reader
    // passes about four hundred pixels above this row. Two identical lines on
    // one screen read as a copy and paste, not as a definition.
    meaning: 'The page one boss keeps of its own: how it fell, and what was written about it.',
    source: 'app/boss/[slug]/page.tsx BossPage',
  },
  {
    id: 'word-storyteller',
    term: 'the Storyteller',
    // "the viking currently holding that office" was the review's wording, and
    // it worked in the review because the sentence before it named the office.
    // Lifted into a nine row list it dangles: nothing on this page ever says
    // what an office is. A definition may not lean on a word the site does not
    // explain, which is the whole reason this block exists.
    meaning: 'The viking whose turn it is to write for the hall, free to set down the tale of any night.',
    source: 'services/discord-bot/src/tales.js mayWriteTale',
  },
  {
    id: 'word-linked-viking',
    term: 'linked viking',
    meaning: 'A viking whose Discord has been bound to their name with a rune.',
    source: 'services/discord-bot/src/identity.js currentLink',
  },
  {
    id: 'word-board',
    term: 'board',
    meaning: 'An in game sign that shows a live leaderboard, written as a marker like [board:kills].',
    source: 'plugins/eilif-boards/src/SignBoards.cs MarkerRe; lib/boards.ts statBoard',
  },
];

// ── Sections ───────────────────────────────────────────────────────────────

export type CommandSection = {
  id: string;
  title: string;
  subtitle: string;
  entries: RegistryEntry[];
};

export const COMMAND_SECTIONS: CommandSection[] = [
  {
    id: 'in-discord',
    title: 'In Discord',
    // The one place on the page that explains the mention. The card above the
    // groups used to say it a second time, and said it about every entry on
    // the page, which is wrong for the shouts and wronger for the board signs.
    subtitle:
      'Tag Eilif and it listens. Type the @ and pick Eilif out of the popup, because the bare letters are only letters. What a chip here copies is the part that goes after the mention.',
    entries: DISCORD_COMMANDS,
  },
  {
    id: 'in-the-game',
    title: 'In the game',
    subtitle:
      'Chat that stays at the campfire never reaches the hall, so every command here is shouted with /s. The board markers are the exception: those are written on a sign.',
    entries: GAME_SHOUTS,
  },
  {
    id: 'what-the-hall-says',
    title: 'What the hall says',
    subtitle: 'Eilif keeps the ledger whether anyone asks it to or not. This is where it reads the ledger back.',
    entries: NOTIFICATIONS,
  },
  {
    id: 'the-pages',
    title: 'The pages',
    subtitle: 'Where everything the hall records ends up.',
    entries: SITE_PAGES,
  },
];

/** Every entry, in section order. The tripwire scans this. */
export const COMMAND_REGISTRY: RegistryEntry[] = COMMAND_SECTIONS.flatMap((s) => s.entries);
