// Pure message formatting — no Discord/Supabase deps, so it can run under
// --dry-run and be unit-tested. Each function returns a payload shape the
// poster understands: { content?, embeds?: object[], mentionEveryone?: boolean }.

export const GOLD = 0xc8952a;
const FOOTER = 'Eilif · The Cozy Canon Playthrough';

function str(meta, key) {
  const v = meta?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// --- Leaderboard helpers (deaths board + Player of the Day) ----------------

// Discord's embed field-value ceiling. Mirrors chronicle.js.
const MAX_FIELD_VALUE = 1024;

// Characters that are only ever the tail of somebody else's character: the
// low half of a surrogate pair, and every combining mark.
const COMBINING_MARK = /\p{M}/u;

/**
 * THE TORN CHARACTER THIS CLOSES (red-team round 3, 2026-09-05). Every cap in
 * this file used `String.prototype.slice`, which counts UTF-16 CODE UNITS. A
 * name whose 24th unit falls inside an astral character (any emoji, and every
 * character above U+FFFF) was cut in half and left a LONE HIGH SURROGATE in the
 * payload: `"aaaaaaaaaaaaaaaaaaaaaaa\ud83d"`. JSON.stringify escapes it rather
 * than refusing it, so the malformed string reaches Discord, which answers 400
 * Invalid Form Body — and a 400 is the one status relay.js treats as permanent,
 * so the event is logged and BURNED rather than retried.
 *
 * Same rule one step out for combining marks: cutting between a base letter and
 * the mark that belongs to it turns "é" into "e" mid-render. Step back to the
 * start of the cluster instead. The guard is bounded because a hostile string
 * can carry hundreds of marks in a row and this must not become a scan.
 */
export function clipChars(s, max) {
  const t = String(s);
  if (max <= 0) return '';
  if (t.length <= max) return t;
  let end = max;
  const backOffSurrogate = () => {
    const hi = t.charCodeAt(end - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) end -= 1;
  };
  backOffSurrogate();
  for (let guard = 0; guard < 8 && end > 0 && COMBINING_MARK.test(t[end] ?? ''); guard++) {
    end -= 1;
    backOffSurrogate();
  }
  return t.slice(0, end);
}

// Escape Discord markdown specials so a name like "Bj*rn" can't break layout.
// The backslash goes FIRST: escaping it last would leave "Bj\" + "\*" = "Bj\\*",
// which renders as a literal backslash followed by a LIVE italic marker — the
// one input that walked straight through the old escape.
export function escapeMd(s) {
  return String(s).replace(/([\\*_`~|])/g, '\\$1');
}

// THE UNFURL THIS CLOSES (red-team round 2, 2026-09-05). Escaping markdown does
// nothing to a URL: `:` `/` and `.` are not markdown specials, so a viking who
// named himself `http://a.co/pwn`, or a forged death whose `cause` was a link,
// put a LIVE link into #server and Discord rendered the attacker's own preview
// card (title, description, image) under it. Character names and death causes
// reach the events table through ingest paths that carry no token, so this was
// a defacement channel into the community channel with no account required.
//
// Two locks. This is the text one: any `scheme://…` or `www.…` run inside a
// player-typed field is replaced with the word `link`, so nothing linkifiable
// survives into the copy. The second lock is `flags: SuppressEmbeds` on every
// content-only message in discord.js, which kills the preview card even for a
// formatter that forgets to come through here.
//
// No honest input is touched: a Valheim character name cannot contain `/`, and
// no death cause, creature name or raid label in the game contains `://`.
const LINK_RUN = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;
export function defangLinks(s) {
  return String(s).replace(LINK_RUN, 'link');
}

// Defensive 24-char cap (keeps us well under embed field limits) + escaping +
// link defanging. The cap runs FIRST so the 24-char budget is measured against
// what the player actually typed, not against the escapes we added.
//
// THE STRAY SPACE (round 3 review, 2026-09-05). Every caller wraps this in a
// bold run, and this was the one player-name helper that neither collapsed nor
// trimmed: a name carrying a trailing space reached the hall as
// `**Ragnar **` (bold with a gap before the close), and an all-whitespace name
// as `****`. safeText and replySafeName both already collapse, trim and fall
// back; this now matches them, which also means whitespace can never eat part
// of the 24-char budget.
export function nameMd(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return defangLinks(escapeMd(clipChars(t, 24))) || 'viking';
}

/**
 * Free text typed by a player that is about to land in a message or an embed:
 * clipped, markdown-escaped and link-defanged. Used for the in-game oath echo
 * (voice.js), where the raw shout text used to go into an embed description
 * with no treatment at all.
 */
export function safeText(s, max = 1000) {
  // Whitespace collapses to single spaces FIRST. escapeMd does not cover `#`,
  // `>` or `-`, which Discord only treats as markdown at the START of a line —
  // so removing the line breaks removes that whole class (heading, quote and
  // list injection) instead of growing the escape table. Both callers are
  // single-line by nature: an oath is one shouted line, a raid label is one
  // log label.
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return defangLinks(escapeMd(t.length > max ? `${clipChars(t, max - 1)}\u2026` : t));
}
/** Join board lines and clip to the embed field ceiling. Mirrors chronicle.js. */
function joinCapped(lines, sep = ', ') {
  const out = lines.filter(Boolean).join(sep);
  return out.length > MAX_FIELD_VALUE ? `${clipChars(out, MAX_FIELD_VALUE - 1)}…` : out;
}

// Norse-flavored POTY blurbs, keyed by category. Index 0 of EVERY category uses
// only always-present fields, so the missing/zero guard can always fall back to
// it. Placeholders: {name} {boss} {biome} {deaths} {cause} {hours} {kills}
// {resources} {items} {newBiome}. {boss}/{biome}/{newBiome} are pre-bolded here.
//
// COUNT TOKENS carry their own noun so a tally of one never reads "1 times":
// {deathsTimes} "once / twice / 4 times", {gravesCount} "1 fresh grave",
// {killsCount} "1 foe", {corpsesCount} "1 corpse", {piecesCount} "1 piece",
// {worksCount} "1 work". Each is backed by a raw number in COUNT_TOKEN_SOURCE
// below, so the missing/zero guard still sees the value behind the phrase.
export const POTY_TEMPLATES = {
  boss_kill: [
    '{name} stood over **{boss}** while the **{biome}** went quiet. Skål.',
    'The **{biome}** bows. {name} put **{boss}** in the dirt and walked back into the hall.',
    '**{boss}** is done, and {name} was there at the kill. The mead is on the gods tonight.',
    '{name} bled {deathsTimes} wrestling **{boss}** down and took its head anyway.',
  ],
  most_explored: [
    '{name} put a prow into the **{newBiome}** for the first time and lived to tell it.',
    'The map grew today. {name} set boots in the **{newBiome}**, where no clansman had walked.',
    '{name} crossed into the **{newBiome}** and the unknown blinked first.',
  ],
  most_deaths: [
    '{name} died {deathsTimes} today and laughed off most of it.',
    '{name} met the void {deathsTimes}. {causeCap} had the last word, and the Allfather keeps a stool warm.',
    "{name}'s name is on {gravesCount} tonight. Valhalla's doorman knows it by sight.",
    'Death came for {name} {deathsTimes}. {causeCap} got the last word, and {name} sailed back for more.',
  ],
  most_kills: [
    '{name} cut down {killsCount} today. The crows of the realm follow them now, fat and grateful.',
    "The forest learned a name to fear: {killsCount} fell to {name}'s blade.",
    '{name} left {corpsesCount} in their wake and barely broke a sweat.',
  ],
  most_resources: [
    "{name} hauled {piecesCount} of the realm's bounty home. The storehouse sings.",
    '{name} gathered {piecesCount} while the saga rested. Cozy and unstoppable.',
    '{name} stripped {piecesCount} out of the land today, hauling like a draugr with a grudge.',
  ],
  most_crafted: [
    '{name} bent {worksCount} out of anvil and flame today. Even Brokkr the dwarf would nod.',
    'The forge never cooled for {name}. {worksCount} came off the anvil true, and the clan walks better armed.',
    "Blades, nails and trinkets: {worksCount} left {name}'s anvil this day. A smith of true worth.",
  ],
  most_hours: [
    '{name} held the hall for {hours}h while the rest slept. No glory in it. Somebody has to.',
    '{name} kept the longfire burning {hours}h.',
    '{hours}h of honest toil from {name} today. The longhouse grows because someone refuses to rest.',
  ],
  // Unsung Hero (underdog spotlight). Every blurb uses ONLY {name} — a quiet
  // viking may have ~0 of every stat, so these must never reach for one.
  underdog: [
    '{name} kept the longfire lit and the hall warm tonight. Skål to the steady ones.',
    'The clan raises a horn to {name}. Fewer hours, no less heart.',
    '{name} sailed in for a spell and left the realm brighter for it. The gods may not have noticed. The hall did.',
    'Tonight the hall toasts {name}, who shows up with a hammer and asks for no glory.',
  ],
};

// Small, pure 31-multiplier string hash (stable across runs).
function hashString(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

// Shared day-board renderer: one line per name, capped so a big roster can't
// blow the 1024-char embed field limit. Returns '' when empty.
function renderBoard(rows, line, cap = 10) {
  if (!rows || !rows.length) return '';
  const shown = rows.slice(0, cap).map(line);
  if (rows.length > cap) shown.push(`…and ${rows.length - cap} more`);
  return shown.join('\n');
}

// "🛡️ **Name** · 2.3h" lines: everyone who played in the window.
function renderOnlineToday(board) {
  return renderBoard(board, (row) => `🛡️ **${nameMd(row.name)}** · ${Number(row.hours).toFixed(1)}h`);
}

// "💀 **Name** ×3" lines: everyone who died in the window.
function renderFallenToday(board) {
  return renderBoard(board, (row) => `💀 **${nameMd(row.name)}** ×${row.count}`);
}

/** "once" / "twice" / "7 times" — a tally that never reads "1 times". */
function times(n) {
  const v = Math.round(Number(n) || 0);
  if (v === 1) return 'once';
  if (v === 2) return 'twice';
  return `${v.toLocaleString()} times`;
}

/** "a falling tree" -> "A falling tree", for a sentence-initial token. */
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "1 foe" / "60 foes" — a count that carries its own noun. */
function counted(n, one, many) {
  const v = Math.round(Number(n) || 0);
  return `${v.toLocaleString()} ${v === 1 ? one : many}`;
}

// Which raw number backs each count token, so the missing/zero guard below can
// still see the value behind the phrase it renders.
const COUNT_TOKEN_SOURCE = {
  causeCap: 'cause',
  deathsTimes: 'deaths',
  gravesCount: 'deaths',
  killsCount: 'kills',
  corpsesCount: 'kills',
  piecesCount: 'resources',
  worksCount: 'items',
};

// Deterministically pick + fill a POTY blurb from poty.{key,name,fields,seed}.
function renderPotyBlurb(poty) {
  const templates = POTY_TEMPLATES[poty.key] || [];
  if (!templates.length) return '';
  const f = poty.fields || {};
  // raw values drive the missing/zero guard; disp values are substituted in.
  const raw = {
    name: poty.name,
    boss: f.boss, biome: f.biome, deaths: f.deaths, cause: f.cause,
    hours: f.hours, kills: f.kills, resources: f.resources, items: f.items,
    newBiome: f.newBiome,
  };
  for (const [token, source] of Object.entries(COUNT_TOKEN_SOURCE)) raw[token] = raw[source];
  const intStr = (v) => (v == null ? '' : Math.round(v).toLocaleString());
  const disp = {
    name: `**${nameMd(poty.name)}**`,
    boss: f.boss ? escapeMd(f.boss) : '',
    biome: f.biome ? escapeMd(f.biome) : '',
    deaths: f.deaths != null ? String(f.deaths) : '',
    // The cause arrives raw (a bare HitType word like "Tree" or a creature
    // name), so it is turned into a noun phrase before it lands mid-sentence.
    cause: f.cause ? causeNoun(f.cause) : '',
    // The same noun phrase where a template OPENS on it ("A falling tree had
    // the last word."), which is not the same string as mid-sentence.
    causeCap: f.cause ? capitalize(causeNoun(f.cause)) : '',
    hours: f.hours != null ? Number(f.hours).toFixed(1) : '',
    kills: intStr(f.kills),
    resources: intStr(f.resources),
    items: intStr(f.items),
    newBiome: f.newBiome ? escapeMd(f.newBiome) : '',
    deathsTimes: times(f.deaths),
    gravesCount: counted(f.deaths, 'fresh grave', 'fresh graves'),
    killsCount: counted(f.kills, 'foe', 'foes'),
    corpsesCount: counted(f.kills, 'corpse', 'corpses'),
    piecesCount: counted(f.resources, 'piece', 'pieces'),
    worksCount: counted(f.items, 'work', 'works'),
  };

  let idx = (hashString(poty.name) + (poty.seed || 0)) % templates.length;
  let tpl = templates[idx];
  // GUARD: any placeholder whose raw value is missing/zero -> fall back to [0].
  const ok = (tpl.match(/\{(\w+)\}/g) || []).every((token) => {
    const v = raw[token.slice(1, -1)];
    if (v === undefined || v === null || v === '') return false;
    if (typeof v === 'number' && v === 0) return false;
    return true;
  });
  if (!ok) tpl = templates[0];

  return tpl.replace(/\{(\w+)\}/g, (_, k) => (disp[k] != null ? disp[k] : ''));
}

// --- Death message copy -----------------------------------------------------
// #server gets exactly one line per death row (relay.js owns exactly-once
// delivery — see its cursor). What follows just keeps the copy from
// repeating and reading well. Cause classification mirrors lib/episodes.ts's
// ENV_DEATHS semantics (bare HitType words vs named bosses vs plain creature
// names) but the wording here is the bot's own, kept in the same Norse/saga
// register as the recap + POTY copy above.

function pickOne(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

function article(word) {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

// OWN-PROPERTY lookup for every cause-keyed map below. `cause` is
// attacker-reachable (a modded client picks the killer name it reports), and a
// bare `MAP[low]` walks Object.prototype: a viking "killed by constructor" made
// ENV_DEATH_POOLS hand back the Object function, and buildDeathMessage threw on
// it — a crash in the #server relay, from a death line.
function own(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

// Bare environmental HitType words, as gs-ingest/GsValheimStatsClient report
// them (e.g. "tree", "fall", "drowning") — same key set as episodes.ts's
// ENV_DEATHS, own phrasing.
export const ENV_DEATH_POOLS = {
  fall: ['{name} took a fatal fall.', "{name} forgot vikings can't fly.", 'Gravity finally caught up with {name}.'],
  falling: ['{name} took a fatal fall.', "{name} forgot vikings can't fly.", 'Gravity finally caught up with {name}.'],
  drowning: ['{name} was dragged under by dark water.', "{name} went down and didn't come back up.", 'The deep claimed {name}.'],
  drowned: ['{name} was dragged under by dark water.', "{name} went down and didn't come back up.", 'The deep claimed {name}.'],
  drown: ['{name} was dragged under by dark water.', "{name} went down and didn't come back up.", 'The deep claimed {name}.'],
  water: ['{name} was dragged under by dark water.', "{name} went down and didn't come back up.", 'The deep claimed {name}.'],
  tree: ['{name} was flattened by a falling tree.', 'A tree had the last word with {name}.', '{name} lost an argument with a tree.'],
  fire: ['{name} burned to a crisp.', '{name} got too close to the flames.', 'Fire took {name} tonight.'],
  burning: ['{name} burned to a crisp.', '{name} got too close to the flames.', 'Fire took {name} tonight.'],
  smoke: ['{name} choked on hearth-smoke.'],
  freezing: ['{name} froze solid in the cold.', 'The cold finally caught up with {name}.'],
  cold: ['{name} froze solid in the cold.', 'The cold finally caught up with {name}.'],
  poison: ['{name} succumbed to poison.', "Something {name} touched didn't agree with them."],
  poisoned: ['{name} succumbed to poison.', "Something {name} touched didn't agree with them."],
  stalagmite: ['{name} was skewered from above.'],
  stalagtite: ['{name} was skewered from above.'],
  impact: ['{name} was broken by the fall.'],
  cartcollision: ['{name} was run down by their own cart. Embarrassing.'],
  cart: ['{name} was run down by their own cart. Embarrassing.'],
  structural: ['{name} was crushed under falling timber.'],
  turret: ['{name} was shot down by a ballista. Friendly fire, perhaps?'],
  // HitType.Boat is a hull hitting a viking, not a sinking. "Went down with
  // their ship" blamed the wrong thing entirely.
  boat: ['{name} was run down by a longship.', '{name} was caught between hull and shore.'],
  self: ["{name} was undone by their own hand. We don't ask questions."],
  catapult: ['{name} was smashed flat by a catapult stone.'],
  cinderfire: ['{name} was caught in a rain of burning cinders.'],
  // Another viking landed the killing blow. Never dressed up as an unseen foe.
  playerhit: ['{name} was cut down by one of their own.', 'One of the clan put {name} in the ground. It happens.'],
  // The client had no HitType to report at all.
  undefined: ['{name} fell to something that left no name behind.'],
  // Valheim's catch-all HitType for a killer the client couldn't name (an
  // off-screen projectile, a despawned attacker, a mod-spawned foe). Mirrors
  // lib/episodes.ts — without it the feed reads "killed by an Enemyhit".
  enemyhit: [
    '{name} was struck down by an unseen foe.',
    'Something in the dark took {name} and never showed its face.',
    "{name} fell to an attacker nobody got a look at. The woods aren't saying.",
  ],
  edgeofworld: ['{name} sailed off the edge of the world.', "{name} found out what's past the edge. Nothing good."],
  ashlandsocean: ['{name} was boiled alive in the Ashlands sea.'],
  ashlandsoceanfloor: ['{name} was boiled alive in the Ashlands sea.'],
  lava: ['{name} was swallowed by molten rock.'],
};

// Named forsaken ones (mirrors episodes.ts's BOSSES set) read as a proper
// clash rather than "killed by a X".
const BOSS_NAMES = new Set(['eikthyr', 'the elder', 'bonemass', 'moder', 'yagluth', 'the queen', 'fader']);

export const BOSS_TEMPLATES = [
  '{name} fell in battle against {cause}.',
  '{causeCap} sent {name} to Valhalla.',
  '{name} did not rise again after facing {cause}.',
  'Only ash remains where {name} met {cause}.',
];

// Plain creature names (e.g. "Neck", "Greydwarf", "Deathsquito").
export const CREATURE_TEMPLATES = [
  '{name} was killed by {article} {cause}.',
  '{name} fell to {article} {cause}.',
  '{name} met their end at the claws of {article} {cause}.',
  '{articleCap} {cause} put {name} in the ground.',
  "{name} didn't see the {cause} coming.",
];

// A raw cause turned into a NOUN PHRASE, for the surfaces that drop it into the
// middle of a sentence (the POTY blurb, the voice engine's callbacks) rather
// than building a whole line around it. Without this the evening recap says
// "Tree got the last word" or "the last one courtesy of enemyhit".
const CAUSE_NOUNS = {
  fall: 'a long drop', falling: 'a long drop',
  drowning: 'dark water', drowned: 'dark water', drown: 'dark water', water: 'dark water',
  tree: 'a falling tree',
  fire: 'fire', burning: 'fire',
  smoke: 'hearth smoke',
  freezing: 'the cold', cold: 'the cold',
  poison: 'poison', poisoned: 'poison',
  stalagmite: 'a spike of rock', stalagtite: 'a spike of rock',
  impact: 'a hard landing',
  cartcollision: 'their own cart', cart: 'their own cart',
  structural: 'falling timber',
  turret: 'a ballista bolt',
  boat: 'a longship hull',
  self: 'their own hand',
  enemyhit: 'something they never saw',
  edgeofworld: 'the edge of the world',
  ashlandsocean: 'the boiling sea', ashlandsoceanfloor: 'the boiling sea',
  lava: 'molten rock',
  undefined: 'something that left no name',
  playerhit: 'another viking',
  catapult: 'a catapult stone',
  cinderfire: 'falling cinders',
};

/**
 * Noun phrase for a raw cause: a HitType word becomes plain English, a named
 * forsaken one keeps its name, and anything else is read as a creature
 * ("a Greydwarf"). Returns '' for an absent cause so callers can guard on it.
 * `markdown: false` for the in-game voice line, where an escape backslash would
 * be read out as a backslash.
 */
export function causeNoun(rawCause, { markdown = true } = {}) {
  const cause = typeof rawCause === 'string' ? rawCause.trim() : '';
  if (!cause) return '';
  const low = cause.toLowerCase();
  const noun = own(CAUSE_NOUNS, low);
  if (noun) return noun;
  // Defanged as well as escaped on the markdown path: the cause is player-
  // reachable text (see defangLinks above) and this one lands in #server.
  const shown = markdown ? defangLinks(escapeMd(cause)) : cause;
  if (BOSS_NAMES.has(low) || /^the\s/i.test(cause)) return shown;
  return `${article(cause)} ${shown}`;
}

// No cause at all — legacy log-derived deaths (unmodded players) carry empty
// metadata, since the server log never records what killed you.
export const NO_CAUSE_TEMPLATES = [
  '{name} has fallen.',
  '{name} met their end in the wilds.',
  'The realm claims another: {name}.',
  '{name} did not make it home tonight.',
  'Valhalla gains a new guest: {name}.',
];

/**
 * Build the #server death line body (no leading emoji). `boldName` should
 * already be markdown-escaped/bolded; `rawCause` is metadata.cause verbatim
 * (a bare creature/boss name or HitType word, or absent).
 */
export function buildDeathMessage(boldName, rawCause) {
  const cause = typeof rawCause === 'string' ? rawCause.trim() : '';
  if (!cause) return fillTemplate(pickOne(NO_CAUSE_TEMPLATES), { name: boldName });

  const low = cause.toLowerCase();
  const escapedCause = defangLinks(escapeMd(cause));

  const envPool = own(ENV_DEATH_POOLS, low);
  if (envPool) {
    return fillTemplate(pickOne(envPool), { name: boldName });
  }

  if (BOSS_NAMES.has(low) || /^the\s/i.test(cause)) {
    // A PlayerHit with a named attacker arrives as "the hand of Bjorn", so the
    // cause has to be capitalized where a template opens on it.
    return fillTemplate(pickOne(BOSS_TEMPLATES), {
      name: boldName,
      cause: escapedCause,
      causeCap: escapedCause.charAt(0).toUpperCase() + escapedCause.slice(1),
    });
  }

  const art = article(cause);
  return fillTemplate(pickOne(CREATURE_TEMPLATES), {
    name: boldName,
    cause: escapedCause,
    article: art,
    articleCap: art[0].toUpperCase() + art.slice(1),
  });
}

/**
 * Compact one-line feed messages for #server.
 * Returns null for event types the feed should ignore (chat, boss, unknown).
 */
export function formatFeedEvent(event) {
  const name = event.character_name || 'A viking';
  const meta = event.metadata || {};
  switch (event.type) {
    case 'join':
      return { content: `🛡️ **${nameMd(name)}** entered the realm` };
    case 'leave':
      return { content: `🚪 **${nameMd(name)}** left the realm` };
    case 'death': {
      const cause = str(meta, 'cause');
      return { content: `💀 ${buildDeathMessage(`**${nameMd(name)}**`, cause)}` };
    }
    case 'raid':
      // No name in a raid line, but the label is free text from the log, so it
      // gets the same markdown escaping (without the 24-char name cap).
      return { content: `⚔️ ${safeText(str(meta, 'event') || 'A raid has begun', 200)}` };
    default:
      return null; // chat / boss / sync / anything else: not for the feed
  }
}

/** Big @everyone embed for #valheim when a boss is felled for the first time. */
export function formatBossKill(boss) {
  const fields = [];
  // The war party is who actually FOUGHT (fight_stats.fighters), mirroring
  // recap.js and the skald; players_present is the fallback for legacy rows
  // recorded before fighters were captured, and can name bystanders.
  const warParty =
    boss.fight_stats && Array.isArray(boss.fight_stats.fighters) && boss.fight_stats.fighters.length > 0
      ? boss.fight_stats.fighters
      : Array.isArray(boss.players_present)
        ? boss.players_present
        : [];
  // THE WEDGE THIS CLOSES (red-team, 2026-09-05). These are CHARACTER NAMES —
  // the player picks them in the game's own name field, and they reach
  // fight_stats/players_present through ingest paths that carry no token. Raw
  // and uncapped they used to be able to push this field past Discord's 1024
  // ceiling, and a 400 here throws out of bosses.tick() BEFORE the boss is
  // marked announced: the @everyone first-kill announcement never posts and
  // re-throws every 30 seconds, for good. Same treatment the chronicle's war
  // party already got: cap each name, escape its markdown, clip the join.
  const names = warParty.map((n) => String(n || '').trim()).filter(Boolean);
  if (names.length > 0) {
    fields.push({ name: '⚔️ War party', value: joinCapped(names.map(nameMd)) });
  }
  // Notes are admin-authored (scripts/mark-boss.js, service role), so their
  // markdown is deliberate and stays live. The length cap is not optional.
  if (boss.notes) {
    fields.push({ name: '📜 Notes', value: joinCapped([String(boss.notes)]) });
  }
  return {
    content: '@everyone',
    mentionEveryone: true,
    embeds: [
      {
        title: `👑 ${boss.name} has fallen!`,
        description: `The **${boss.biome}** bows to the clan. The way onward is open, so sail while the mead is warm.`,
        color: GOLD,
        fields,
        footer: { text: FOOTER },
      },
    ],
  };
}

// Nothing happened in the last 24h. One of these leads the recap instead of the
// stat block; the picker below keeps a dry week from reading like a stuck record.
export const QUIET_RECAP_LINES = [
  'Nothing to report. The realm kept to itself and so did we.',
  'A quiet stretch. No deeds went into the book today.',
  'Empty hall and a cold hearth, though no new graves either.',
  'The saga has a blank page for today. It happens.',
];

/**
 * Daily recap embed for #valheim (no ping). Every number/name covers the
 * TRAILING 24 HOURS.
 * stats = { period:'morning'|'evening', playersActive, hoursPlayed, deaths,
 *           bossKills:string[], onlineNow, worldDay, quiet:boolean,
 *           onlineToday:{name,hours}[], fallenToday:{name,count}[],
 *           poty:{key,label,name,fields,seed}|null }
 * The day boards render in BOTH recaps; POTY only in the evening when present.
 * All extras live in the non-quiet branch only.
 */
export function formatRecap(stats) {
  const morning = stats.period === 'morning';
  const title = morning ? '🌅 Morning, vikings' : '🌙 The hall winds down';

  if (stats.quiet) {
    // Rotate the quiet-day line so a dry spell doesn't post the same sentence
    // twice a day for a week. Deterministic (period + world day), so the same
    // recap always renders identically.
    const idx = hashString(`${stats.period}:${stats.worldDay}`) % QUIET_RECAP_LINES.length;
    return {
      embeds: [
        {
          title,
          description:
            `${QUIET_RECAP_LINES[idx]} ` +
            `Day **${stats.worldDay}**, **${stats.onlineNow}** sailing now.`,
          color: GOLD,
          footer: { text: FOOTER },
        },
      ],
    };
  }

  const fields = [
    { name: 'Vikings on today', value: `${stats.playersActive}`, inline: true },
    { name: 'Hours logged', value: `${stats.hoursPlayed.toFixed(1)}h`, inline: true },
    { name: 'Deaths', value: `${stats.deaths}`, inline: true },
    {
      name: 'Bosses felled',
      value: stats.bossKills.length ? stats.bossKills.join(', ') : 'None',
      inline: true,
    },
    { name: 'Online now', value: `${stats.onlineNow}`, inline: true },
    { name: 'World day', value: `${stats.worldDay}`, inline: true },
  ];

  // Day boards — who played and who fell in the last 24h. Either is omitted
  // when empty (nobody on / nobody died).
  const online = renderOnlineToday(stats.onlineToday);
  if (online) fields.push({ name: '🛡️ Online today', value: online, inline: false });
  const fallen = renderFallenToday(stats.fallenToday);
  if (fallen) fields.push({ name: '💀 Fallen today', value: fallen, inline: false });

  // Player of the Day — evening only, when a crown was earned. The blurb already
  // leads with the (bolded) name, so the value is just the blurb; the award
  // category rides in the field title.
  if (!morning && stats.poty) {
    fields.push({
      name: `🏆 Player of the Day · ${stats.poty.label}`,
      value: renderPotyBlurb(stats.poty),
      inline: false,
    });
  }

  return {
    embeds: [
      {
        title,
        description: morning
          ? 'What the last day turned up, read out at sunrise.'
          : 'The day’s saga, set down before the fires dim.',
        color: GOLD,
        fields,
        footer: { text: FOOTER },
      },
    ],
  };
}

// --- Replies to Discord messages -------------------------------------------

/**
 * THE PING THIS CLOSES (red-team, 2026-09-05). identity.js and oaths.js replied
 * with `allowedMentions: { repliedUser: false }`. Leaving `parse` OUT is not
 * "no mentions" — it is Discord's DEFAULT, which parses every mention in the
 * content. identity.js echoes the sender's own server nickname back
 * ("I have whispered your rune, **<nick>**"), and a nickname may be `@everyone`
 * or `<@&roleId>`: any guild member could make the bot mass-ping the server, on
 * demand, because the bot holds Mention Everyone for the boss announcement.
 *
 * Every reply the bot makes to a member goes through here. `parse: []` is the
 * whole fix; the caller should still `replySafeName` anything it echoes so the
 * text reads as text instead of a dead ping.
 */
export function replyPayload(content) {
  return { content: clipContent(content), allowedMentions: { parse: [], repliedUser: false } };
}

/** Discord's message-content ceiling, enforced here as well as in the poster. */
const MAX_CONTENT = 2000;
function clipContent(s) {
  const t = String(s ?? '');
  return t.length > MAX_CONTENT ? `${clipChars(t, MAX_CONTENT - 1)}…` : t;
}

/**
 * A name (Discord nickname or character name) that is safe to echo INTO a reply:
 * capped at 32 (Discord's own nickname limit) and markdown-escaped. With
 * `parse: []` above this is belt-and-braces, but it also stops a nickname full
 * of backticks from eating the rest of the sentence.
 */
export function replySafeName(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return defangLinks(escapeMd(clipChars(t, 32))) || 'viking';
}

/** Manual announcement to #valheim with @everyone. */
export function formatAnnouncement(text) {
  return {
    content: `@everyone 📯 ${text}`,
    mentionEveryone: true,
  };
}
