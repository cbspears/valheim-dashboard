// Session Episodes — derive a "season episode guide" from raw sessions + events.
//
// ONE EPISODE PER CALENDAR DAY (America/Chicago). Any day with play activity
// (at least one session) becomes a single Episode; quiet days produce none.
// Sessions, deaths, raids, discoveries, boss kills, oaths and pins are all
// bucketed by their Central-time calendar date, so a late-night session that
// crosses UTC midnight still lands on the day the vikings actually played.
// Episodes are numbered chronologically (Episode 1 = the founding day).
//
// A saga-voiced TITLE and a dynamic DESCRIPTION are generated from template
// pools — ZERO LLM calls. Variant choice is seeded from a hash of the calendar
// date, so a given day always renders identical text (no Math.random here; this
// runs in a server component).
//
// Pure and dependency-free (aside from the Oath row type) so it can be
// unit-tested in isolation.
import type { GameSession, GameEvent, Oath } from './types';

export interface EpisodeParticipant {
  name: string;
  minutes: number;
}

export interface EpisodeDeath {
  name: string;
  cause: string;
}

export interface EpisodePlace {
  name: string;
  kind: string | null;
  by: string | null;
}

export interface EpisodeOath {
  name: string;
  text: string;
}

/** Minimal pin shape the episode builder needs (bucketed by CT calendar day). */
export interface EpisodePinInput {
  name: string;
  kind?: string | null;
  by_character_name?: string | null;
  created_at: string;
}

export interface Episode {
  /** chronological, 1-based (Episode 1 = the founding day) */
  number: number;
  /** ISO of the day's first session — used to date the episode (rendered in CT) */
  date: string;
  startedAt: string;
  endedAt: string;
  participants: EpisodeParticipant[];
  totalVikingHours: number;
  deaths: EpisodeDeath[];
  /** raw raid details, e.g. "The forest is moving..." */
  raids: string[];
  /** raw discovery details, e.g. "entered the Swamp" */
  discoveries: string[];
  /** boss names felled this day, e.g. "Eikthyr" */
  bossKills: string[];
  /** places named on the map this day (via in-game /pin) */
  places: EpisodePlace[];
  /** oaths sworn before the hall this day */
  oaths: EpisodeOath[];
  /** [min, max] world day touched this day, or null if unknown */
  worldDayRange: [number, number] | null;
  title: string;
  /** dynamic, template-generated saga blurb of what happened this day */
  description: string;
}

function ms(iso: string | null | undefined): number {
  if (!iso) return NaN;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? NaN : t;
}

function sessionEnd(s: GameSession, start: number): number {
  const left = ms(s.left_at);
  if (!Number.isNaN(left)) return left;
  const dur = s.duration_minutes ?? 0;
  return start + Math.max(0, dur) * 60_000;
}

function sessionMinutes(s: GameSession, start: number, end: number): number {
  if (s.duration_minutes && s.duration_minutes > 0) return s.duration_minutes;
  return Math.max(0, Math.round((end - start) / 60_000));
}

function str(meta: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const v = meta?.[key];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(meta: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const v = meta?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function firstName(name: string | null | undefined): string {
  return (name ?? 'A viking').trim().split(/\s+/)[0];
}

// ── Central-time calendar bucketing ───────────────────────────────────
// Same convention the attendance calendar uses: bucket every instant by its
// America/Chicago date so late-night (UTC-crossing) play lands on the right day.
const CT_KEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** "2026-07-04" — the CT calendar-day key for an instant. */
function ctDayKey(t: number): string | null {
  if (Number.isNaN(t)) return null;
  try {
    return CT_KEY_FMT.format(new Date(t));
  } catch {
    return null;
  }
}

// Small, pure 31-multiplier string hash (stable across runs) — mirrors the
// bot's format.js so seeded template choice reads the same way here.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// ── working accumulator while bucketing by day ────────────────────────
interface DayBucket {
  key: string; // CT calendar day, e.g. "2026-07-04"
  start: number; // earliest session join (ms) that day
  end: number; // latest session end (ms) that day
  minutesByName: Map<string, number>;
  order: string[]; // first-seen order, for stable participant listing
}

/**
 * Derive Episodes from sessions + events (+ optional oaths and pins).
 * Everything is bucketed by America/Chicago calendar day; the result is
 * chronological (Episode 1 first). Callers may pass data in any order.
 */
export function buildEpisodes(
  sessions: GameSession[],
  events: GameEvent[],
  oaths: Oath[] = [],
  pins: EpisodePinInput[] = []
): Episode[] {
  const buckets = new Map<string, DayBucket>();

  for (const s of sessions) {
    const start = ms(s.joined_at);
    const key = ctDayKey(start);
    if (key === null) continue;
    const end = sessionEnd(s, start);
    const mins = sessionMinutes(s, start, end);
    const name = s.character_name ?? 'A viking';

    let b = buckets.get(key);
    if (!b) {
      b = { key, start, end, minutesByName: new Map(), order: [] };
      buckets.set(key, b);
    }
    b.start = Math.min(b.start, start);
    b.end = Math.max(b.end, end);
    if (!b.minutesByName.has(name)) b.order.push(name);
    b.minutesByName.set(name, (b.minutesByName.get(name) ?? 0) + mins);
  }

  const days = [...buckets.keys()].sort(); // ascending ISO date == chronological
  return days.map((key, i) => finishEpisode(buckets.get(key)!, i + 1, events, oaths, pins));
}

function finishEpisode(
  b: DayBucket,
  number: number,
  events: GameEvent[],
  oaths: Oath[],
  pins: EpisodePinInput[]
): Episode {
  const deaths: EpisodeDeath[] = [];
  const raids: string[] = [];
  const discoveries: string[] = [];
  const bossKills: string[] = [];
  const worldDays: number[] = [];

  for (const e of events) {
    if (ctDayKey(ms(e.created_at)) !== b.key) continue;

    const day = num(e.metadata, 'world_day');
    if (day !== undefined) worldDays.push(day);

    switch (e.type) {
      case 'death':
        deaths.push({
          name: e.character_name ?? 'A viking',
          cause: str(e.metadata, 'cause') ?? 'the wilds',
        });
        break;
      case 'raid': {
        const detail = str(e.metadata, 'detail') ?? str(e.metadata, 'event');
        if (detail) raids.push(detail);
        break;
      }
      case 'discovery': {
        const detail = str(e.metadata, 'detail');
        if (detail) discoveries.push(detail);
        break;
      }
      case 'boss': {
        const boss = str(e.metadata, 'boss');
        if (boss) bossKills.push(boss);
        break;
      }
    }
  }

  const places: EpisodePlace[] = pins
    .filter((p) => ctDayKey(ms(p.created_at)) === b.key && p.name?.trim())
    .map((p) => ({ name: p.name.trim(), kind: p.kind ?? null, by: p.by_character_name ?? null }));

  const dayOaths: EpisodeOath[] = oaths
    .filter((o) => ctDayKey(ms(o.sworn_at)) === b.key && o.oath_text?.trim())
    .map((o) => ({ name: o.character_name ?? 'A viking', text: o.oath_text.trim() }));

  const participants: EpisodeParticipant[] = b.order
    .map((name) => ({ name, minutes: b.minutesByName.get(name) ?? 0 }))
    .sort((a, c) => c.minutes - a.minutes);

  const totalMinutes = participants.reduce((sum, p) => sum + p.minutes, 0);
  const totalVikingHours = Math.round((totalMinutes / 60) * 10) / 10;

  const worldDayRange: [number, number] | null = worldDays.length
    ? [Math.min(...worldDays), Math.max(...worldDays)]
    : null;

  const core: Omit<Episode, 'title' | 'description'> = {
    number,
    date: new Date(b.start).toISOString(),
    startedAt: new Date(b.start).toISOString(),
    endedAt: new Date(b.end).toISOString(),
    participants,
    totalVikingHours,
    deaths,
    raids,
    discoveries,
    bossKills,
    places,
    oaths: dayOaths,
    worldDayRange,
  };

  const seed = hashString(b.key);
  return { ...core, title: titleFor(core), description: describeEpisode(core, seed) };
}

// ── seeded template helper ────────────────────────────────────────────
/** Deterministic pick — seed comes from the day's hash, offset varies clauses. */
function pick<T>(pool: readonly T[], seed: number, offset = 0): T {
  return pool[(seed + offset) % pool.length];
}

function fill(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function cap(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

/** "Bjorn", "Bjorn and Ingrid", "A, B and C", "A, B, C and 2 more". */
function nameList(names: string[], seed: number): string {
  const fn = [...new Set(names.map(firstName))];
  if (fn.length === 0) return 'A lone viking';
  if (fn.length === 1) return fn[0];
  if (fn.length === 2) return `${fn[0]} and ${fn[1]}`;
  if (fn.length === 3) return `${fn[0]}, ${fn[1]} and ${fn[2]}`;
  void seed;
  return `${fn.slice(0, 3).join(', ')} and ${fn.length - 3} more`;
}

// ── title derivation (saga voice, rule priority) ──────────────────────

const QUIET_TITLES = [
  'A Quiet Evening of Building',
  'Wood Was Chopped, Mead Was Drunk',
  'Small Deeds by Firelight',
  'The Longhouse Grew a Little',
  'Nets Mended, Old Tales Told',
  'A Day Without Incident',
  'Stone Was Laid, Fires Were Fed',
  'Quiet Work Beneath a Cold Sky',
];

const BIOMES = [
  'Meadows',
  'Black Forest',
  'Swamp',
  'Mountain',
  'Mountains',
  'Plains',
  'Mistlands',
  'Ashlands',
  'Deep North',
  'Ocean',
];

/** Turn a raw discovery detail into a saga chapter title. */
function discoveryTitle(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes('trader') || d.includes('haldor')) return 'The Trader Found';
  if (d.includes('crypt')) return 'The Sunken Crypt';
  if (d.includes('tar pit')) return 'The Tar Pit';
  if (d.includes('strait') || d.includes('sailed') || d.includes('charted')) return 'New Waters Charted';
  for (const biome of BIOMES) {
    if (d.includes(biome.toLowerCase())) {
      const b = biome === 'Mountains' ? 'Mountain' : biome;
      if (d.includes('sighted') || d.includes('from a peak')) return `The ${b}, Sighted`;
      return `Into the ${b}`;
    }
  }
  return 'Into Unknown Lands';
}

/** Turn a raw raid detail into a saga chapter title. */
function raidTitle(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes('forest is moving') || d.includes('greydwarf')) return 'The Forest Marched';
  if (d.includes('foul smell') || d.includes('swamp')) return 'A Stench from the Swamp';
  if (d.includes('hunted')) return 'The Night of the Hunt';
  if (d.includes('ground is shaking') || d.includes('troll')) return 'The Ground Shook';
  if (d.includes('cold wind') || d.includes('wolves') || d.includes('wolf')) return 'The Wolves Came';
  if (d.includes('surtling') || d.includes('fire')) return 'A Night of Embers';
  return 'The Siege';
}

const FIRST_PIN_TITLES = ['A Place with a Name', 'New Ground, Newly Named', 'The Map Grew'];
const OATH_TITLES = ['Oaths by Firelight', 'Vows Before the Hall', 'The Swearing of Oaths'];

type EpisodeCore = Omit<Episode, 'title' | 'description'>;

function titleFor(e: EpisodeCore): string {
  const seed = hashString(e.date.slice(0, 10));
  if (e.bossKills.length > 0) return `The Fall of ${e.bossKills[0]}`;
  if (e.deaths.length >= 3) return `The Day of ${e.deaths.length} Deaths`;
  if (e.raids.length > 0) return raidTitle(e.raids[0]);
  if (e.discoveries.length > 0) return discoveryTitle(e.discoveries[0]);
  if (e.places.length > 0) return pick(FIRST_PIN_TITLES, seed);
  if (e.oaths.length > 0) return pick(OATH_TITLES, seed);
  if (e.participants.length >= 6) return 'A Full Hall';
  if (e.participants.length === 1) return `${firstName(e.participants[0]?.name)}'s Lone Vigil`;
  return QUIET_TITLES[(e.number - 1) % QUIET_TITLES.length];
}

// ── description derivation (template pools, seeded per day) ────────────

const OPENERS = {
  solo: [
    '{name} kept a lone vigil over the realm{day}.',
    'Only {name} braved the realm{day}.',
    '{name} sailed alone beneath a cold sky{day}.',
  ],
  small: [
    '{names} gathered at the longfire{day}.',
    '{names} shared the day’s toils{day}.',
    '{names} took to the realm together{day}.',
  ],
  crowd: [
    'A full hall — {names} — answered the horn{day}.',
    'The mead-benches filled as {names} sailed{day}.',
    '{names} crowded the realm{day}.',
  ],
  none: [
    'The realm lay quiet{day}.',
    'No sails were raised, yet the saga still turned{day}.',
  ],
};

const BOSS_DESC = [
  '{boss} fell this day, and a new region opened to the clan.',
  'The forsaken {boss} was cut down at last.',
  '{boss} met its end — skål to the war-party that took its head.',
];

const CREATURE_DESC = [
  '{name} learned to fear the humble {Cause}.',
  '{name} met their end at the claws of {article} {cause}.',
  'A single {cause} sent {name} to Valhalla.',
  '{name} will not soon forget the {cause} that felled them.',
];

// Env death flavor keyed by the lowercased HitType cause (mirrors ENV_DEATHS).
const ENV_DESC: Record<string, string[]> = {
  fall: ['{name} was reminded that vikings cannot fly.', '{name} took one step too many off the high rocks.'],
  falling: ['{name} was reminded that vikings cannot fly.'],
  drowning: ['{name} was dragged under by dark water.', 'The deep swallowed {name} whole.'],
  drowned: ['{name} was dragged under by dark water.'],
  drown: ['{name} was dragged under by dark water.'],
  water: ['{name} was dragged under by dark water.'],
  tree: ['{name} lost an argument with a falling tree.', 'A tree had the last word with {name}.'],
  fire: ['{name} strayed too close to the flames and paid for it.'],
  burning: ['{name} strayed too close to the flames and paid for it.'],
  smoke: ['{name} choked on the hearth-smoke of their own hall.'],
  freezing: ['{name} froze where they stood.'],
  cold: ['{name} froze where they stood.'],
  poison: ['{name} succumbed to poison, cursing the swamp.'],
  poisoned: ['{name} succumbed to poison, cursing the swamp.'],
  stalagmite: ['{name} was skewered from above.'],
  stalagtite: ['{name} was skewered from above.'],
  impact: ['{name} was broken by a merciless fall.'],
  cartcollision: ['{name} was run down by their own cart — a death without honor.'],
  structural: ['{name} was crushed beneath falling timber.'],
  turret: ['{name} was shot down by a ballista, friendly fire perhaps.'],
  boat: ['{name} went down with their ship.'],
  self: ['{name} was undone by their own hand; the hall asks no questions.'],
  edgeofworld: ['{name} sailed clean off the edge of the world.'],
  ashlandsocean: ['{name} was boiled alive in the Ashlands sea.'],
  ashlandsoceanfloor: ['{name} was boiled alive in the Ashlands sea.'],
  lava: ['{name} was swallowed by molten rock.'],
};

const DEADLY_DESC = [
  'Blood was spilled {n} times before the fires dimmed.',
  'The realm claimed {n} lives this day — none for long.',
  '{n} deaths darkened the day’s saga.',
];

const ONE_DEATH_DESC = [
  'One viking fell and rose again by the hearth.',
  'A single death marked the day, brief and unglorious.',
];

const DISCOVERY_DESC = [
  'New country was charted this day.',
  'The clan pushed into lands no map yet held.',
];

const RAID_DESC = [
  'The hall weathered a raid and held.',
  'A raid tested the walls — the walls won.',
  'The clan stood against a siege before the dawn.',
];

const PLACES_ONE_DESC = [
  '{place} was marked upon the map.',
  'The map grew: {place} now bears a name.',
];

const PLACES_MANY_DESC = [
  'New ground was named — {places}.',
  '{places} were marked upon the map.',
];

const OATHS_ONE_DESC = [
  '{name} swore a fresh oath before the hall.',
  'An oath was spoken: {name} bound their word to the clan.',
];

const OATHS_MANY_DESC = [
  '{names} swore new oaths before the clan.',
  '{n} oaths were spoken before the hall this day.',
];

const QUIET_DESC = [
  'Wood was chopped, mead was drunk, and the longhouse grew a little.',
  'Quiet work by firelight — stone laid, nets mended, no blood spilled.',
  'A calm stretch; the fires were fed and the hall kept warm.',
];

// Cause categories (mirror phraseDeath). "the wilds" is the no-cause fallback.
const ENV_KEYS = new Set(Object.keys(ENV_DESC));
function isBossCause(low: string): boolean {
  return /^the\s/i.test(low) || BOSSES.has(low);
}

/** Pick the most "notable" death to feature — one with a real, named cause. */
function featuredDeath(deaths: EpisodeDeath[]): EpisodeDeath | null {
  const named = deaths.filter((d) => d.cause && d.cause.toLowerCase() !== 'the wilds');
  // Prefer a plain creature cause (most colorful), then env, then any named.
  const creature = named.find(
    (d) => !ENV_KEYS.has(d.cause.toLowerCase()) && !isBossCause(d.cause.toLowerCase())
  );
  if (creature) return creature;
  return named[0] ?? null;
}

function deathSentence(deaths: EpisodeDeath[], seed: number): string | null {
  if (deaths.length === 0) return null;
  const feat = featuredDeath(deaths);
  if (feat) {
    const low = feat.cause.toLowerCase();
    const nm = firstName(feat.name);
    if (ENV_DESC[low]) return fill(pick(ENV_DESC[low], seed, 5), { name: nm });
    if (!isBossCause(low)) {
      return fill(pick(CREATURE_DESC, seed, 5), {
        name: nm,
        cause: feat.cause,
        Cause: cap(feat.cause),
        article: article(feat.cause),
      });
    }
  }
  if (deaths.length === 1) return fill(pick(ONE_DEATH_DESC, seed, 5), {});
  return fill(pick(DEADLY_DESC, seed, 5), { n: deaths.length });
}

function daySpanClause(range: [number, number] | null): string {
  if (!range) return '';
  const [lo, hi] = range;
  return lo === hi ? `, the world at day ${lo}` : `, across world-days ${lo}–${hi}`;
}

function describeEpisode(e: EpisodeCore, seed: number): string {
  const names = e.participants.map((p) => p.name);
  const day = daySpanClause(e.worldDayRange);

  const openerPool =
    names.length === 0
      ? OPENERS.none
      : names.length === 1
        ? OPENERS.solo
        : names.length <= 3
          ? OPENERS.small
          : OPENERS.crowd;

  const opener = fill(pick(openerPool, seed, 0), {
    name: names.length ? firstName(names[0]) : 'A lone viking',
    names: nameList(names, seed),
    day,
  });

  // Primary headline clause — highest-priority happening of the day.
  let primary: string | null = null;
  if (e.bossKills.length > 0) {
    primary = fill(pick(BOSS_DESC, seed, 1), { boss: e.bossKills[0] });
  } else if (e.deaths.length > 0) {
    primary = deathSentence(e.deaths, seed);
  } else if (e.discoveries.length > 0) {
    primary = pick(DISCOVERY_DESC, seed, 1);
  } else if (e.raids.length > 0) {
    primary = pick(RAID_DESC, seed, 1);
  } else if (e.places.length > 0) {
    primary = placesClause(e.places, seed);
  } else if (e.oaths.length > 0) {
    primary = oathsClause(e.oaths, seed);
  } else {
    primary = pick(QUIET_DESC, seed, 1);
  }

  // One "color" clause — a different flavor than the headline, when present.
  const secondaries: string[] = [];
  const placeS = e.places.length > 0 ? placesClause(e.places, seed) : null;
  const oathS = e.oaths.length > 0 ? oathsClause(e.oaths, seed) : null;
  const raidS = e.raids.length > 0 ? pick(RAID_DESC, seed, 3) : null;
  for (const s of [oathS, placeS, raidS]) {
    if (s && s !== primary && !secondaries.includes(s)) secondaries.push(s);
  }
  const secondary = secondaries.length ? secondaries[seed % secondaries.length] : null;

  return [opener, primary, secondary].filter(Boolean).join(' ');
}

function placesClause(places: EpisodePlace[], seed: number): string {
  if (places.length === 1) return fill(pick(PLACES_ONE_DESC, seed, 2), { place: places[0].name });
  const list = places.slice(0, 3).map((p) => p.name);
  const rest = places.length - list.length;
  const label = rest > 0 ? `${list.join(', ')} and ${rest} more` : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  return fill(pick(PLACES_MANY_DESC, seed, 2), { places: label });
}

function oathsClause(oaths: EpisodeOath[], seed: number): string {
  if (oaths.length === 1) return fill(pick(OATHS_ONE_DESC, seed, 4), { name: firstName(oaths[0].name) });
  return fill(pick(OATHS_MANY_DESC, seed, 4), {
    names: nameList(oaths.map((o) => o.name), seed),
    n: oaths.length,
  });
}

// Keyed by the LOWERCASED cause (phraseDeath lowercases before lookup). Covers
// Valheim's environmental HitData.HitType words as GsValheimStatsClient reports
// them (e.g. "tree", "fall", "drowning", "edgeofworld", "self") plus a few
// friendly synonyms — so any non-creature death still reads as a full clause.
const ENV_DEATHS: Record<string, string> = {
  fall: 'fell to their death',
  falling: 'fell to their death',
  drowning: 'claimed by dark water',
  drowned: 'claimed by dark water',
  drown: 'claimed by dark water',
  water: 'claimed by dark water',
  tree: 'crushed by a falling tree',
  fire: 'lost to the flames',
  burning: 'lost to the flames',
  smoke: 'choked on hearth-smoke',
  freezing: 'frozen in the cold',
  cold: 'frozen in the cold',
  poison: 'succumbed to poison',
  poisoned: 'succumbed to poison',
  stalagmite: 'skewered from above',
  stalagtite: 'skewered from above',
  impact: 'broken by the fall',
  cartcollision: 'run down by their own cart',
  structural: 'crushed by falling timber',
  turret: 'shot down by a ballista',
  boat: 'wrecked with their ship',
  self: 'undone by their own hand',
  edgeofworld: "sailed off the edge of the world",
  ashlandsocean: 'boiled in the Ashlands sea',
  ashlandsoceanfloor: 'boiled in the Ashlands sea',
  lava: 'swallowed by molten rock',
};

// Named forsaken ones read as "felled by …" rather than "taken by a …".
const BOSSES = new Set([
  'eikthyr',
  'the elder',
  'bonemass',
  'moder',
  'yagluth',
  'the queen',
  'fader',
]);

/** Saga-voiced phrasing for a single death, e.g. "taken by a troll". */
export function phraseDeath(cause: string): string {
  const c = cause.trim();
  const low = c.toLowerCase();
  if (ENV_DEATHS[low]) return ENV_DEATHS[low];
  if (BOSSES.has(low) || /^the\s/i.test(c)) return `felled by ${c}`;
  const article = /^[aeiou]/i.test(c) ? 'an' : 'a';
  return `taken by ${article} ${low}`;
}
