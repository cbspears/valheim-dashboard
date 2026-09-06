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
// WHERE THINGS LAND, AND WHY IT IS #server. Four announcements route by env var
// (RECAP_CHANNEL, MILESTONE_CHANNEL, OATH_CHANNEL, BOSS_CHANNEL). Their CODE
// default is `valheim`; the deployed bot overrides all four to `server` for the
// rehearsal pilot, and `scripts/cutover-env.sh --apply` (docs/LAUNCH-DAY.md step
// 20b) deletes those four lines at launch, at which point they go back to
// #valheim. The `channel` field on each entry below is therefore what the
// DEPLOYED bot does right now, and the tripwire resolves the same var out of
// index.js and the live .env and fails when the two disagree. When 20b runs,
// this file has to be re-pointed at #valheim in the same pass, and the test is
// what will say so.
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

/** Something a player shouts in game. Every one of these leads with /s. */
export type GameShout = TypedCommand & { kind: 'in-game' };

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
    note: 'Bind your Discord first, because Eilif files the telling against your viking. Up to 2000 characters, and one telling every five minutes. The boss may be named or slugged, in any case: Bonemass, bonemass, the-elder and The Elder all resolve. A newline may stand in for the space after the colon, so you can write a paragraph.',
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
    id: 'gallery',
    text: '@Eilif <your caption> (with an image attached)',
    copy: '',
    who: 'any member',
    what: 'The picture is copied into the hall’s own store and appears on the Gallery, with your words as its caption. If the caption names a place someone has pinned, the photo is tied to that pin on the map. Eilif reacts with a frame when it lands.',
    example: '@Eilif the longhouse at last, roof and all',
    note: 'Works in any channel of the hall, because no gallery channel is set. Images up to 12 MB, and a few at a time. An admin can pull a photo back down by reacting with a bin on the post.',
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
// Every one of these must be SHOUTED. Proximity chat never reaches the
// dedicated server, so a plain line is never seen by the hall; the plugin's
// hooks only fire on Talker.Type.Shout.

export const GAME_SHOUTS: GameShout[] = [
  {
    kind: 'in-game',
    id: 'oath-first',
    text: '/s /oath <RUNE> <your vow, one line>',
    copy: '/s /oath ',
    who: 'any member',
    what: 'Swears your vow onto the Oath page and binds your Discord to the viking you are playing. This is the shout the rune from @Eilif I am is for.',
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
    where: 'Discord, in #server, with everyone called',
    trigger: 'One of the Forsaken is felled for the first time',
    cadence: 'Once per boss, checked every thirty seconds',
    channel: 'server',
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
    where: 'Discord, in #server',
    trigger: 'The day closes: hours kept, vikings fallen, and the Viking of the Day',
    cadence: 'Once a night at 23:00 America/Chicago',
    channel: 'server',
    channelVar: 'RECAP_CHANNEL',
    source: 'services/discord-bot/src/recap.js schedule, postRecap',
  },
  {
    kind: 'notification',
    id: 'great-deeds',
    text: 'Great Deeds',
    where: 'Discord, in #server, and spoken in game',
    trigger: 'The warband crosses a threshold that belongs to all of you at once',
    cadence: 'One deed at a time, with a minute of quiet between them',
    channel: 'server',
    channelVar: 'MILESTONE_CHANNEL',
    source: 'services/discord-bot/src/milestones.js createMilestonesAnnouncer, DEFAULT_MIN_GAP_MS',
    flag: 'MILESTONES_ANNOUNCE',
  },
  {
    kind: 'notification',
    id: 'titles',
    text: 'Title proclamations',
    where: 'Discord, in #server, and spoken in game',
    trigger: 'Your standing against the warband shifts far enough to earn you a new epithet',
    cadence: 'Checked every ten minutes, and rare by design',
    channel: 'server',
    channelVar: 'TITLE_CHANNEL',
    source: 'services/discord-bot/src/titles.js createTitlesAnnouncer',
    flag: 'TITLES_ANNOUNCE',
  },
  {
    kind: 'notification',
    id: 'oath-echo',
    text: 'The oath echo',
    where: 'Spoken in game, and posted to Discord in #server',
    trigger: 'You shout an oath',
    cadence: 'Once per oath, straight away',
    channel: 'server',
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
    text: 'The Viking of the Day crown',
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
    what: 'Who is online now, the hearth’s pulse, the Great Deeds standing, the latest saga and what is coming up.',
    source: 'app/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-players',
    text: '/players',
    label: 'Vikings',
    what: 'Every warrior who has set foot on these shores, the leaderboards, the attendance grid and how we die.',
    source: 'app/players/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-world',
    text: '/world',
    label: 'World',
    what: 'Boss gated progression: each Forsaken felled opens the next leg, with the ledger of Great Deeds earned and on the horizon.',
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
    label: 'Saga',
    what: 'Each night the vikings gather becomes a chapter, with the running feed of everything the hall recorded.',
    source: 'app/events/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-mods',
    text: '/mods',
    label: 'Mods',
    what: 'Every mod running on the server, which ones you must install to join, and the one click pack code.',
    source: 'app/mods/page.tsx',
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
    id: 'page-oath',
    text: '/oath',
    label: 'Oath',
    what: 'How to swear and bind, and the wall of every vow sworn in the hall.',
    source: 'app/oath/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-commands',
    text: '/commands',
    label: 'Commands',
    what: 'This register: every command, every shout, and everything the hall says back.',
    source: 'app/commands/page.tsx',
  },
  {
    kind: 'page',
    id: 'page-get-started',
    text: '/get-started',
    label: 'Get Started',
    what: 'Log on and install the mods in five steps, then the two rites to perform once you are in.',
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
    subtitle:
      'Tag Eilif and it listens. Type the @ and pick Eilif out of the popup, because the bare letters are only letters.',
    entries: DISCORD_COMMANDS,
  },
  {
    id: 'in-the-game',
    title: 'In the game',
    subtitle:
      'Chat that stays at the campfire never reaches the hall. Every line below has to be shouted, so lead with /s.',
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
