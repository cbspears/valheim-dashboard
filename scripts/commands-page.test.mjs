// TRIPWIRE for the Commands register (config/commands.ts, /commands).
//
// The register is hand-written prose about code that lives in four other
// places: the Discord bot's parse regexes and permission helpers, the Companion
// plugin's shout prefixes, the feature flags in the bot's index.js, and the
// channel routing in the deployed .env. Prose about code rots silently. This
// test reads all four SOURCES rather than a copy of them, and fails when the
// register and the code disagree.
//
// What it holds:
//   1. Every verb the bot actually accepts, extracted from the real regexes and
//      keyword lists, has an entry here whose command text carries it.
//   2. Every shout prefix the plugin actually matches, extracted from the C#
//      source, has an entry too.
//   3. No entry names a feature that ships OFF. The flag defaults are read out
//      of index.js (`=== '1'` is off, `!== '0'` is on), not remembered here,
//      and the two flags the deployed bot turns on are checked against its own
//      .env when that file is readable.
//   3b. Every notice that names a Discord channel names the one the DEPLOYED
//      bot posts to. The routing expression is read out of the bot's source and
//      resolved against its live .env, so a pilot override that is lifted (or
//      added) fails this test instead of quietly making the page lie.
//   3c. Who may use a command is held to the gate that enforces it, read out of
//      `mayPuppet` / `mayKeepTelling` / `resolveSenderPlayer` rather than
//      remembered. "the owner" is not an audience: Manage Server is in the set.
//   3d. Every module index.js attaches is either cited by the register or
//      listed here as deliberately not player facing, so a whole notice cannot
//      be dropped from the page without this failing.
//   4. The copy holds the doctrine: no em dashes, no en dashes, no exclamation
//      marks (CLAUDE.md) — in the register AND in the page's own prose.
//   5. Every `source` names a file that exists AND symbols that are really in
//      it, and the nav and the page list agree with each other.
//
// Picked up automatically by `npm test` (find scripts lib -name '*.test.mjs').
// Run alone: npx tsx scripts/commands-page.test.mjs
import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_REGISTRY,
  COMMAND_SECTIONS,
  DISCORD_COMMANDS,
  GAME_SHOUTS,
  NOTIFICATIONS,
  SITE_PAGES,
} from '../config/commands.ts';

let passed = 0;
const skips = [];
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };
const skip = (m) => { skips.push(m); };

const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => readFileSync(repo(p), 'utf8');
const entryById = (id) => {
  const e = COMMAND_REGISTRY.find((x) => x.id === id);
  assert.ok(e, `the register still carries an entry with id "${id}"`);
  return e;
};

const BOT = 'services/discord-bot/src';

// ── source readers ─────────────────────────────────────────────────────────

/**
 * Every regex literal in a slice of JavaScript. Deliberately crude: these files
 * only ever write a regex as `/.../flags` in a `.test(`, a `.match(` or a
 * `const`, and the scan is scoped to one function body by the callers below, so
 * the division ambiguity that makes this hard in general never arises here.
 */
function regexLiterals(src) {
  const out = [];
  const re = /\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+)\/([gimsuy]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/**
 * The verb word(s) a regex accepts at the head of a message, or [] when the
 * regex leads with something that is not a word (a character class of
 * separators, a free-text capture). An alternation of bare words at the head is
 * a verb LIST and yields all of them, which is exactly the shape tellings.js
 * uses.
 */
function leadingVerbs(source) {
  if (!source.startsWith('^')) return [];
  const rest = source.slice(1);
  if (rest.startsWith('(')) {
    const close = rest.indexOf(')');
    if (close < 0) return [];
    const inner = rest.slice(1, close).replace(/^\?:/, '');
    const parts = inner.split('|');
    return parts.every((p) => /^[a-zA-Z]+$/.test(p)) ? parts.map((p) => p.toLowerCase()) : [];
  }
  const word = /^[a-zA-Z]+/.exec(rest);
  return word ? [word[0].toLowerCase()] : [];
}

/** The body of a named function, from its declaration to `until`. */
function slice(src, from, until) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `could not find ${JSON.stringify(from)} to scan`);
  const b = src.indexOf(until, a);
  assert.ok(b > a, `could not find ${JSON.stringify(until)} after it`);
  return src.slice(a, b);
}

/** Verbs extracted from one parser, deduped. */
function verbsIn(src, from, until) {
  const found = new Set();
  for (const lit of regexLiterals(slice(src, from, until))) {
    for (const v of leadingVerbs(lit)) found.add(v);
  }
  return [...found];
}

/** `KEY=value` out of a dotenv file, or null. Values are never printed. */
function envValue(text, name) {
  const m = new RegExp(`^${name}\\s*=\\s*(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

const BOT_ENV_PATH = repo('services/discord-bot/.env');
const POLLER_ENV_PATH = repo('services/log-poller/.env');
const botEnv = existsSync(BOT_ENV_PATH) ? readFileSync(BOT_ENV_PATH, 'utf8') : null;
const pollerEnv = existsSync(POLLER_ENV_PATH) ? readFileSync(POLLER_ENV_PATH, 'utf8') : null;

// Every string a viking could be asked to type, from every entry that offers a
// command. `also` counts: it is the register's way of naming a second spelling
// of the same verb, and the bot accepts both.
const commandStrings = [...DISCORD_COMMANDS, ...GAME_SHOUTS].flatMap((e) => [
  e.text,
  ...(e.also ?? []),
]);

const offersVerb = (verb) =>
  commandStrings.some((s) => new RegExp(`(^|[^a-z])${verb}([^a-z]|$)`, 'i').test(s));

// ── 1. the verbs the bot really accepts ────────────────────────────────────
{
  const identity = read(`${BOT}/identity.js`);
  const identityVerbs = verbsIn(identity, 'export function parseIdentity(', '\nexport function createIdentityLink');
  ok(identityVerbs.length >= 3, `parseIdentity offers at least three verbs (found ${identityVerbs.join(', ')})`);
  for (const v of identityVerbs) {
    ok(offersVerb(v), `identity.js accepts "${v}" and the register offers it`);
  }

  const tellings = read(`${BOT}/tellings.js`);
  const tellingVerbs = verbsIn(tellings, 'export function parseTellings(', '// ── the in-game voice');
  ok(tellingVerbs.includes('keep'), `parseTellings still carries a verb list (found ${tellingVerbs.join(', ')})`);
  for (const v of tellingVerbs) {
    ok(offersVerb(v), `tellings.js accepts "${v}" and the register offers it`);
  }

  const voice = read(`${BOT}/voice.js`);
  const voiceVerbs = verbsIn(voice, 'async function handleMessage(', 'function attach()');
  ok(voiceVerbs.length >= 1, `the voice puppet parses a verb (found ${voiceVerbs.join(', ')})`);
  for (const v of voiceVerbs) {
    ok(offersVerb(v), `voice.js accepts "${v}" and the register offers it`);
  }

  // The gallery has no verb: a mention plus an image IS the command. Pin the
  // two conditions the register describes instead.
  const gallery = read(`${BOT}/gallery.js`);
  ok(/message\.attachments/.test(gallery), 'gallery.js still triggers on an attachment');
  ok(
    DISCORD_COMMANDS.some((e) => e.id === 'gallery' && /image/i.test(e.what + e.text)),
    'and the register says so',
  );
}

// ── 2. the shout prefixes the plugin really matches ────────────────────────
{
  const oathCs = read('plugins/eilif-companion/src/OathCapture.cs');
  const prefixes = [...oathCs.matchAll(/const\s+string\s+\w*Prefix\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  ok(prefixes.length >= 1, `OathCapture.cs declares a shout prefix (found ${JSON.stringify(prefixes)})`);
  for (const p of prefixes) {
    const token = p.trim();
    ok(
      GAME_SHOUTS.some((e) => e.text.includes(token)),
      `the plugin captures "${token}" and the register offers it`,
    );
  }
  ok(
    /Talker\.Type\.Shout/.test(oathCs),
    'and the capture is still gated on a SHOUT, which is why every in-game entry leads with /s',
  );
  for (const e of GAME_SHOUTS) {
    ok(e.text.startsWith('/s '), `"${e.text}" is written as a shout`);
  }

  // The mirror drops anything that begins with a slash, so the catch-all entry
  // must not promise that every other shout is relayed.
  ok(
    /StartsWith\("\/", StringComparison\.Ordinal\)\) return;/.test(oathCs),
    'OathCapture still refuses to mirror a slash-prefixed shout',
  );
  const mirror = entryById('shout-mirror');
  ok(
    /not a command/i.test(mirror.text) || /slash/i.test(mirror.what + (mirror.note ?? '')),
    'and the register says so rather than promising that any other shout is mirrored',
  );

  const pluginCs = read('plugins/eilif-companion/src/EilifCompanionPlugin.cs');
  const pinRe = /PinRe\s*=[\s\S]{0,240}?@"([^"]+)"/.exec(pluginCs);
  ok(pinRe, 'EilifCompanionPlugin.cs still declares the /pin regex as a literal this test can read');
  const pinTokens = [...pinRe[1].matchAll(/\/[a-z]+/g)].map((m) => m[0]);
  ok(pinTokens.length >= 1, `and it names a slash command (found ${JSON.stringify(pinTokens)})`);
  for (const t of pinTokens) {
    ok(
      GAME_SHOUTS.some((e) => e.text.includes(t)),
      `the plugin captures "${t}" and the register offers it`,
    );
  }
  // The ONE keyword the pin shout takes. Everything else in the line is the
  // place name, which is why the register never offers a "poi" keyword.
  const kinds = [...pinRe[1].matchAll(/\((?!\?:)([a-z]+)\)/g)].map((m) => m[1]);
  for (const k of kinds) {
    ok(
      GAME_SHOUTS.some((e) => new RegExp(`/pin ${k}\\b`).test(e.text)),
      `the pin shout takes the keyword "${k}" and the register offers it`,
    );
  }
  ok(
    !commandStrings.some((s) => /\/pin\s+poi\b/.test(s)),
    'and never offers "poi" as a keyword, because the regex treats it as part of the name',
  );

  // A pin REPLACES by name, which is the only way to correct one. The register
  // has to carry that or a viking has no way to move a marker.
  const webhook = read('app/api/webhook/route.ts');
  ok(
    /from\('pins'\)\s*\.delete\(\)/.test(webhook),
    'the webhook still deletes a same-named pin before inserting',
  );
  ok(
    GAME_SHOUTS.some((e) => e.id.startsWith('pin-') && /MOVED|moves?\b/i.test(e.note ?? '')),
    'and the register tells a viking that re-shouting a name moves the pin',
  );
}

// ── 3. nothing behind a flag that ships off ────────────────────────────────

/**
 * Flag defaults, read out of index.js rather than remembered here.
 *   process.env.X === '1'  -> ships OFF
 *   process.env.X !== '0'  -> ships ON
 */
function flagDefaults(src) {
  const map = new Map();
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*(===|!==)\s*'([01])'/g)) {
    const [, name, op, val] = m;
    const on = (op === '!==' && val === '0');
    // A flag read both ways (index.js does this for VOICE_TARGETING) is off
    // unless every reading says on.
    map.set(name, map.has(name) ? map.get(name) && on : on);
  }
  return map;
}

// The flags that ship off in code and are turned on in the deployed bot's own
// .env. This list is the ONLY place the register is allowed to lean on runtime
// configuration for a FLAG, and the .env check below proves it when the file is
// there. (Channel routing leans on runtime too, and is proved in 3b.)
const LIVE_ON = ['GALLERY_INGEST', 'VOICE_ENGINE'];

// Features that ship off and stay off. Nothing about them belongs on a page
// players read.
const HARD_OFF = [
  'OATH_INGEST',
  'WEEKLY_CHRONICLE',
  'BOSS_POLLS',
  'STORYTELLER',
  'TELLING_VOTES',
  'ALTAR_TELLINGS',
  'VOICE_TARGETING',
];

const indexSrc = read(`${BOT}/index.js`);

{
  const defaults = flagDefaults(indexSrc);

  for (const f of HARD_OFF) {
    ok(defaults.has(f), `index.js still gates ${f}`);
    eq(defaults.get(f), false, `${f} still ships off`);
    ok(
      !COMMAND_REGISTRY.some((e) => e.flag === f),
      `and no entry in the register is gated behind ${f}`,
    );
  }

  for (const f of LIVE_ON) {
    ok(defaults.has(f), `index.js still gates ${f}`);
  }

  for (const entry of COMMAND_REGISTRY) {
    if (!entry.flag) continue;
    ok(defaults.has(entry.flag), `${entry.id} names ${entry.flag}, which index.js still reads`);
    ok(
      defaults.get(entry.flag) === true || LIVE_ON.includes(entry.flag),
      `${entry.id} is gated behind ${entry.flag}, which is either on by default or on in the live .env`,
    );
  }

  // The verbs of a module that ships off must not appear as a Discord command,
  // however tempting. oaths.js is the live example: `@Eilif oath` is dark, and
  // the in-game `/s /oath` shout is a different code path entirely.
  const oaths = read(`${BOT}/oaths.js`);
  const kindsLine = /const KINDS = \[([^\]]+)\]/.exec(oaths);
  ok(kindsLine, 'oaths.js still declares its verb list as a literal this test can read');
  const offVerbs = [...kindsLine[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  ok(offVerbs.length >= 3, `and it names them (found ${offVerbs.join(', ')})`);
  for (const v of offVerbs) {
    ok(
      !DISCORD_COMMANDS.some((e) => new RegExp(`^@\\w+\\s+${v}\\b`, 'i').test(e.text)),
      `"@Eilif ${v}" is behind OATH_INGEST and the register does not offer it`,
    );
  }
  // The shout path is not the same thing and must survive that check.
  ok(
    GAME_SHOUTS.some((e) => e.text.includes('/oath ')),
    'while the in-game /oath shout, which no bot flag gates, is still offered',
  );

  // If the deployed bot's own .env is readable, hold it to the same story.
  if (botEnv) {
    for (const f of LIVE_ON) {
      eq(envValue(botEnv, f), '1', `the live bot really does set ${f}=1`);
    }
    for (const f of HARD_OFF) {
      ok(envValue(botEnv, f) !== '1', `and does not set ${f}=1`);
    }
  } else {
    // Not a failure: the file is gitignored and absent in CI. The defaults
    // above are still enforced.
    skip('services/discord-bot/.env not present, skipped the live-flag check');
  }
}

// ── 3b. every named channel is the one the deployed bot posts to ───────────
//
// Four announcements route by env var. Their CODE default is #valheim and the
// deployed bot overrides all four to #server for the rehearsal pilot;
// `scripts/cutover-env.sh --apply` (LAUNCH-DAY step 20b) removes the overrides
// at launch. Neither value is remembered here: the routing EXPRESSION is read
// out of the bot's own source and resolved against its live .env.
{
  const botSrc = readdirSync(repo(BOT))
    .filter((f) => f.endsWith('.js'))
    .map((f) => read(`${BOT}/${f}`))
    .join('\n');

  /** How one env var decides a channel name, read from the source. */
  function routingFor(name) {
    const ors = [...botSrc.matchAll(new RegExp(`process\\.env\\.${name}\\s*\\|\\|\\s*'([a-z]+)'`, 'g'))]
      .map((m) => m[1]);
    const ternaries = [
      ...botSrc.matchAll(
        new RegExp(`process\\.env\\.${name}\\s*===\\s*'([a-z]+)'\\s*\\?\\s*'([a-z]+)'\\s*:\\s*'([a-z]+)'`, 'g'),
      ),
    ].map((m) => ({ test: m[1], then: m[2], otherwise: m[3] }));

    if (ors.length) {
      ok(new Set(ors).size === 1, `${name} falls back to one channel everywhere it is read`);
      return (v) => v || ors[0];
    }
    ok(ternaries.length > 0, `${name} is still read as a channel in the bot's source`);
    const uniq = new Set(ternaries.map((t) => `${t.test}|${t.then}|${t.otherwise}`));
    ok(uniq.size === 1, `${name} is read the same way everywhere`);
    const t = ternaries[0];
    return (v) => (v === t.test ? t.then : t.otherwise);
  }

  for (const n of NOTIFICATIONS) {
    if (!n.channel) {
      ok(!/ in #[a-z]/.test(n.where), `${n.id} names no channel and claims none`);
      continue;
    }
    ok(n.where.includes(`#${n.channel}`), `${n.id} says where it lands, and says #${n.channel}`);

    if (n.channelVar) {
      const resolve = routingFor(n.channelVar);
      if (botEnv) {
        eq(
          resolve(envValue(botEnv, n.channelVar)),
          n.channel,
          `${n.id} routes by ${n.channelVar}, and the deployed bot sends it to #${n.channel}`,
        );
      } else {
        skip(`services/discord-bot/.env not present, skipped the ${n.channelVar} routing check`);
      }
    } else if (n.channelIdVar) {
      // Routed by channel ID from another service's .env. Compared by equality
      // against the bot's own two ids so no id is ever printed.
      if (botEnv && pollerEnv) {
        const id = envValue(pollerEnv, n.channelIdVar);
        ok(id, `${n.channelIdVar} is set for ${n.id}`);
        const named =
          id === envValue(botEnv, 'CHANNEL_SERVER')
            ? 'server'
            : id === envValue(botEnv, 'CHANNEL_VALHEIM')
              ? 'valheim'
              : null;
        eq(named, n.channel, `${n.id} posts to the channel the register calls #${n.channel}`);
      } else {
        skip(`a service .env is not present, skipped the ${n.channelIdVar} routing check`);
      }
    } else {
      // Hard-coded in the producer. Prove it from the file the entry cites.
      const files = n.source.split(';').map((r) => r.trim().split(/\s+/)[0]);
      ok(
        files.some((f) => new RegExp(`post\\('${n.channel}'`).test(read(f))),
        `${n.id} names no env var, and one of its sources posts to '${n.channel}' outright`,
      );
    }
  }

  // The gallery's "any channel of the hall" is true only while CHANNEL_GALLERY
  // is unset. gallery.js says so itself; hold the claim to the live value.
  const gallery = read(`${BOT}/gallery.js`);
  ok(/if \(galleryChannelId\)/.test(gallery), 'gallery.js still narrows to CHANNEL_GALLERY when it is set');
  const galleryEntry = entryById('gallery');
  if (/any channel/i.test(galleryEntry.note ?? '')) {
    if (botEnv) {
      ok(
        !envValue(botEnv, 'CHANNEL_GALLERY'),
        'the register says any channel, and the deployed bot really has CHANNEL_GALLERY unset',
      );
    } else {
      skip('services/discord-bot/.env not present, skipped the CHANNEL_GALLERY check');
    }
  }
}

// ── 3c. who may use a command, held to the gate that enforces it ───────────
//
// The most dangerous error this page can carry is telling the hall that a
// command is narrower than it is. None of these audiences are remembered: each
// is derived from the helper the handler actually calls.
{
  const configSrc = read('config/commands.ts');
  const unionBlock = /export type Audience =([\s\S]*?);/.exec(configSrc);
  ok(unionBlock, 'config/commands.ts still declares the Audience union as a literal this test can read');
  const audiences = [...unionBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  ok(audiences.length >= 3, `and it names them (found ${audiences.length})`);
  for (const e of [...DISCORD_COMMANDS, ...GAME_SHOUTS]) {
    ok(audiences.includes(e.who), `${e.id} claims an audience the union declares`);
  }

  const voice = read(`${BOT}/voice.js`);
  const puppet = slice(voice, 'function mayPuppet(member)', 'async function handleMessage(');
  ok(/permissions\?\.has\?\.\('Administrator'\)/.test(puppet), 'mayPuppet still admits Administrator');
  ok(/permissions\?\.has\?\.\('ManageGuild'\)/.test(puppet), 'and Manage Server');
  ok(/ADMIN_ROLE_IDS/.test(puppet), 'and an admin role id');
  const say = entryById('say');
  ok(say.who !== 'any member', 'the voice puppet is gated, and the register does not call it open');
  ok(
    /admin/i.test(say.who),
    `and names an ADMIN rather than one person, because Manage Server is in mayPuppet's set (got ${JSON.stringify(say.who)})`,
  );
  ok(
    !/\bowner\b/i.test(say.who),
    'and never says "the owner", which mayPuppet does not test for',
  );
  ok(
    /Manage Server/i.test(say.what),
    'and the entry spells out that Manage Server is enough',
  );

  const tellings = read(`${BOT}/tellings.js`);
  const mayKeep = slice(tellings, 'export function mayKeepTelling(', '// ── the handler');
  ok(/authorId === senderId/.test(mayKeep), 'mayKeepTelling still lets an author re-choose their own');
  ok(/permissions\?\.has\?\.\('ManageGuild'\)/.test(mayKeep), 'and admits Manage Server');
  const keep = entryById('keep');
  ok(/told it/i.test(keep.who), 'and the register credits the author');
  ok(
    /admin/i.test(keep.who),
    `and the admin set, not one person (got ${JSON.stringify(keep.who)})`,
  );
  ok(!/\bowner\b/i.test(keep.who), 'and never says "the owner"');

  // A gate a handler DOES call, and a gate it does not, both decide an audience.
  const retellBody = slice(tellings, 'async function handleRetell({', 'async function handleList({');
  ok(/resolveSenderPlayer\(/.test(retellBody), 'handleRetell still resolves the sender to a linked viking');
  eq(entryById('retell').who, 'a linked viking', 'and the register says a linked viking');

  const listBody = slice(tellings, 'async function handleList({', 'async function handleKeep({');
  ok(
    !/resolveSenderPlayer\(|mayKeepTelling\(/.test(listBody),
    'handleList gates on nothing',
  );
  eq(entryById('tellings').who, 'any member', 'and the register says any member');

  const keepBody = slice(tellings, 'async function handleKeep({', 'async function handleMessage(');
  ok(/mayKeepTelling\(/.test(keepBody), 'handleKeep calls the gate the register describes');

  const identity = read(`${BOT}/identity.js`);
  const identityBody = slice(identity, 'async function handleMessage(', '  function attach()');
  ok(!/permissions\?\.has/.test(identityBody), 'the identity handler tests no permission');
  for (const id of ['i-am', 'join', 'who-am-i']) {
    eq(entryById(id).who, 'any member', `and ${id} is open to any member`);
  }

  const galleryBody = slice(read(`${BOT}/gallery.js`), 'async function handleMessage(', 'async function handleReaction(');
  ok(!/permissions\?\.has/.test(galleryBody), 'the gallery ingest tests no permission');
  eq(entryById('gallery').who, 'any member', 'and the register says any member');

  // The in-game oath path is gated by the webhook, not by a Discord link. An
  // entry that claims otherwise sends an unbound viking away from the one
  // shout written for them.
  const webhook = read('app/api/webhook/route.ts');
  const oathBranch = slice(webhook, "if (type === 'oath') {", "if (type === 'pin'");
  ok(!/discord_user_id\s*(!==|===)\s*/.test(oathBranch) || /identityOf/.test(oathBranch),
    'the oath branch gates on a Steam identity mismatch, not on a Discord link');
  for (const id of ['oath-first', 'oath-again', 'oath-link-only']) {
    eq(entryById(id).who, 'any member', `${id} needs no Discord link, and the register says any member`);
  }
}

// ── 3d. nothing the bot announces has fallen off the page ──────────────────
//
// Every module index.js pulls in is either cited by the register or listed
// below as deliberately not player facing, with the reason. A new bot module
// fails this test until someone decides which it is, and a deleted entry fails
// it because its module loses its only citation.
{
  const imported = [...indexSrc.matchAll(/from '\.\/([a-z-]+)\.js'/g)].map((m) => `${m[1]}.js`);
  ok(imported.length > 15, `index.js imports the bot's modules (${imported.length} found)`);

  /** Modules that produce something a player types at or hears from. */
  const PRODUCERS = [
    'relay.js',       // the death feed, arrivals, raids
    'bosses.js',      // the first fall of a boss
    'retelling.js',   // the Skald's account on the war room
    'recap.js',       // the daily recap
    'gallery.js',     // the photo ingest
    'tellings.js',    // retell / tellings / keep, and the telling echo
    'identity.js',    // I am / join / who am I, and both DMs
    'voice.js',       // say:, and every spoken line
    'titles.js',      // title proclamations
    'milestones.js',  // Great Deeds
  ];

  /** Modules with nothing on this page, and why. */
  const NOT_PLAYER_FACING = {
    'state.js': 'the bot\'s own state file',
    'supabase.js': 'database clients',
    'discord.js': 'the poster the others post through',
    'events.js': 'writes the saga rows the site reads, and says nothing itself',
    'heartbeat.js': 'ops telemetry, not a player notice',
    'oaths.js': 'OATH_INGEST ships off',
    'chronicle.js': 'WEEKLY_CHRONICLE ships off',
    'bosspoll.js': 'BOSS_POLLS ships off',
    'storyteller.js': 'STORYTELLER ships off',
    'tellings-vote.js': 'TELLING_VOTES ships off',
    'altar.js': 'ALTAR_TELLINGS ships off',
  };

  const classified = new Set([...PRODUCERS, ...Object.keys(NOT_PLAYER_FACING)]);
  for (const mod of imported) {
    ok(classified.has(mod), `index.js imports ${mod}, and this test knows whether players meet it`);
  }
  for (const mod of classified) {
    ok(imported.includes(mod), `${mod} is still imported by index.js`);
  }

  const cited = COMMAND_REGISTRY.map((e) => e.source).join(' ');
  for (const mod of PRODUCERS) {
    ok(
      cited.includes(`/${mod}`),
      `${mod} produces something players meet, and the register still carries an entry from it`,
    );
  }

  // The notification group specifically: it is the half with no verb to catch a
  // deletion, so hold its shape directly.
  ok(NOTIFICATIONS.length >= 15, `the hall still speaks in ${NOTIFICATIONS.length} ways on this page`);
  for (const producer of ['relay.js', 'recap.js', 'milestones.js', 'titles.js', 'bosses.js', 'voice.js', 'identity.js']) {
    ok(
      NOTIFICATIONS.some((n) => n.source.includes(`/${producer}`)),
      `and one of them is the notice ${producer} sends`,
    );
  }

  // The feed is four notices in one function, and losing one of them would
  // otherwise leave relay.js still cited by the other three. Read the event
  // types formatFeedEvent actually turns into a Discord post out of its own
  // switch, and hold every one of them to an entry that names it.
  const format = read(`${BOT}/format.js`);
  const feed = slice(format, 'export function formatFeedEvent(', 'export function formatBossKill(');
  const feedTypes = [...feed.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]);
  ok(feedTypes.length >= 4, `formatFeedEvent still relays named event types (found ${feedTypes.join(', ')})`);
  for (const t of feedTypes) {
    ok(
      NOTIFICATIONS.some((n) =>
        n.source.split(/[\s,;]+/).includes(t) && n.source.includes('/format.js'),
      ),
      `the feed relays a "${t}" event, and the register carries the notice for it`,
    );
  }
}

// ── 4. copy doctrine ───────────────────────────────────────────────────────
{
  // Everything a reader sees. `source` and `id` are machinery, not copy.
  const MACHINERY = new Set(['source', 'id', 'kind', 'flag', 'channel', 'channelVar', 'channelIdVar']);
  const copyOf = (o) =>
    Object.entries(o)
      .filter(([k]) => !MACHINERY.has(k))
      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .filter((v) => typeof v === 'string');

  const strings = [
    ...COMMAND_REGISTRY.flatMap(copyOf),
    ...COMMAND_SECTIONS.flatMap((s) => [s.title, s.subtitle]),
  ];
  ok(strings.length > 60, `the register carries real copy to check (${strings.length} strings)`);

  for (const s of strings) {
    ok(!s.includes('—'), `no em dash in ${JSON.stringify(s.slice(0, 60))}`);
    ok(!s.includes('–'), `no en dash in ${JSON.stringify(s.slice(0, 60))}`);
    ok(!s.includes('!'), `no exclamation mark in ${JSON.stringify(s.slice(0, 60))}`);
  }

  // The page's OWN prose, which the register cannot see. Comments are stripped
  // first: the doctrine is about what a reader reads, and this repo's comments
  // are written for the next engineer.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const pageFiles = [
    'app/commands/page.tsx',
    ...readdirSync(repo('components/commands')).map((f) => `components/commands/${f}`),
  ];
  let pageStrings = 0;
  for (const f of pageFiles) {
    const src = stripComments(read(f));
    // JSX text nodes, plus the prose props a SectionHeader takes.
    const nodes = [...src.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((m) => m[1]);
    const props = [...src.matchAll(/(?:title|subtitle|label|description|aria-label)=["']([^"']+)["']/g)]
      .map((m) => m[1]);
    const literals = [...src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)]
      .map((m) => m[1] ?? m[2])
      .filter((s) => s && / [a-z]/.test(s));
    for (const s of [...nodes, ...props, ...literals]) {
      ok(!s.includes('—'), `no em dash in ${f}: ${JSON.stringify(s.slice(0, 60))}`);
      ok(!s.includes('–'), `no en dash in ${f}: ${JSON.stringify(s.slice(0, 60))}`);
      pageStrings++;
    }
    for (const s of [...nodes, ...props]) {
      ok(!s.includes('!'), `no exclamation mark in ${f}: ${JSON.stringify(s.slice(0, 60))}`);
    }
  }
  ok(pageStrings > 20, `the page's own copy was really scanned (${pageStrings} strings)`);

  // Titles say plainly what a thing is; the Norse register lives in the
  // subtitles (CLAUDE.md, and the Get Started page is the model).
  for (const s of COMMAND_SECTIONS) {
    ok(s.title.length <= 24, `"${s.title}" is a plain title, not a sentence`);
    ok(s.subtitle.length > 24, `"${s.title}" carries a subtitle with something in it`);
  }
}

// ── 5. shape, sources, and the nav ─────────────────────────────────────────
{
  const ids = COMMAND_REGISTRY.map((e) => e.id);
  eq(new Set(ids).size, ids.length, 'every entry id is unique');

  // `source` is the whole trust mechanism this page advertises, so a citation
  // has to be followable: the file exists AND every symbol named after it is
  // really in that file.
  let symbolsChecked = 0;
  for (const entry of COMMAND_REGISTRY) {
    ok(entry.source && entry.source.length > 4, `${entry.id} names its source`);
    for (const ref of entry.source.split(';')) {
      const tokens = ref.trim().split(/[\s,]+/).filter(Boolean);
      const file = tokens[0];
      ok(existsSync(repo(file)), `${entry.id} cites ${file}, which exists`);
      const text = read(file).toLowerCase();
      for (const sym of tokens.slice(1)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(sym)) continue; // "n", "the", punctuation
        ok(
          text.includes(sym.toLowerCase()),
          `${entry.id} cites "${sym}" in ${file}, which is really there`,
        );
        symbolsChecked++;
      }
    }
  }
  ok(symbolsChecked > 40, `and the citations name real symbols (${symbolsChecked} checked)`);

  for (const entry of [...DISCORD_COMMANDS, ...GAME_SHOUTS]) {
    ok(entry.example.length > 0, `${entry.id} carries a worked example`);
    ok(entry.who.length > 0, `${entry.id} says who may use it`);
  }

  // The nav and the page list must not drift apart.
  const nav = read('components/NavBar.tsx');
  const hrefs = [...nav.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);
  ok(hrefs.includes('/commands'), 'the nav carries the Commands tab');
  ok(/label: 'Commands'/.test(nav), 'labelled Commands');
  for (const href of hrefs) {
    ok(
      SITE_PAGES.some((p) => p.text === href),
      `the nav links ${href} and the register describes it`,
    );
  }
  for (const p of SITE_PAGES) {
    if (p.text.includes('<')) continue; // dynamic route, no single address
    const route = p.text === '/' ? 'app/page.tsx' : `app${p.text}/page.tsx`;
    ok(existsSync(repo(route)), `${p.text} is a real page (${route})`);
  }

  // The page itself must render from the register rather than a second copy of
  // it, or this whole test grades a file nobody reads.
  const page = read('app/commands/page.tsx');
  ok(/from '@\/config\/commands'/.test(page), 'the page reads the register');
  ok(/COMMAND_SECTIONS/.test(page), 'and walks its sections');
  ok(/export const metadata/.test(page), 'and sets its own title and description');
}

for (const s of skips) console.log(`commands-page.test: SKIPPED ${s}`);
console.log(`commands-page.test: ${passed} assertions passed`);
