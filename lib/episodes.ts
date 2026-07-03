// Session Episodes — derive a "season episode guide" from raw sessions + events.
//
// Every real-world play night becomes one Episode: sessions are clustered
// server-wide by time, then the deaths, raids, discoveries and boss kills that
// happened during that window are folded in and a saga-voiced title is chosen.
//
// Pure and dependency-free so it can be unit-tested in isolation.
import type { GameSession, GameEvent } from './types';

export interface EpisodeParticipant {
  name: string;
  minutes: number;
}

export interface EpisodeDeath {
  name: string;
  cause: string;
}

export interface Episode {
  /** chronological, 1-based (Episode 1 = the founding night) */
  number: number;
  /** ISO of the night's start — used to date the episode (rendered in CT) */
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
  /** boss names felled this night, e.g. "Eikthyr" */
  bossKills: string[];
  /** [min, max] world day touched this night, or null if unknown */
  worldDayRange: [number, number] | null;
  title: string;
}

const GAP_MS = 45 * 60 * 1000; // a session joins the current episode within 45 min
const EDGE_MS = 15 * 60 * 1000; // events count if within 15 min of the window edges

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

// ── working accumulator while clustering ──────────────────────────────
interface Cluster {
  start: number;
  end: number;
  minutesByName: Map<string, number>;
  order: string[]; // first-seen order, for stable participant listing
}

/**
 * Derive Episodes from sessions + events.
 * Sessions must be oldest-first (as `getSessionsSince` returns them); events
 * likewise. The result is chronological (Episode 1 first).
 */
export function buildEpisodes(sessions: GameSession[], events: GameEvent[]): Episode[] {
  // Defensive: sort by join time in case callers pass an unordered set.
  const ordered = [...sessions]
    .filter((s) => !Number.isNaN(ms(s.joined_at)))
    .sort((a, b) => ms(a.joined_at) - ms(b.joined_at));

  const clusters: Cluster[] = [];
  let current: Cluster | null = null;

  for (const s of ordered) {
    const start = ms(s.joined_at);
    const end = sessionEnd(s, start);
    const mins = sessionMinutes(s, start, end);
    const name = s.character_name ?? 'A viking';

    if (current && start <= current.end + GAP_MS) {
      current.end = Math.max(current.end, end);
    } else {
      current = { start, end, minutesByName: new Map(), order: [] };
      clusters.push(current);
    }
    if (!current.minutesByName.has(name)) current.order.push(name);
    current.minutesByName.set(name, (current.minutesByName.get(name) ?? 0) + mins);
  }

  return clusters.map((c, i) => finishEpisode(c, i + 1, events));
}

function finishEpisode(c: Cluster, number: number, events: GameEvent[]): Episode {
  const from = c.start - EDGE_MS;
  const to = c.end + EDGE_MS;

  const deaths: EpisodeDeath[] = [];
  const raids: string[] = [];
  const discoveries: string[] = [];
  const bossKills: string[] = [];
  const worldDays: number[] = [];

  for (const e of events) {
    const t = ms(e.created_at);
    if (Number.isNaN(t) || t < from || t > to) continue;

    const day = num(e.metadata, 'world_day');
    if (day !== undefined) worldDays.push(day);

    switch (e.type) {
      case 'death':
        deaths.push({ name: e.character_name ?? 'A viking', cause: str(e.metadata, 'cause') ?? 'the wilds' });
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

  const participants: EpisodeParticipant[] = c.order
    .map((name) => ({ name, minutes: c.minutesByName.get(name) ?? 0 }))
    .sort((a, b) => b.minutes - a.minutes);

  const totalMinutes = participants.reduce((sum, p) => sum + p.minutes, 0);
  const totalVikingHours = Math.round((totalMinutes / 60) * 10) / 10;

  const worldDayRange: [number, number] | null = worldDays.length
    ? [Math.min(...worldDays), Math.max(...worldDays)]
    : null;

  const episode: Omit<Episode, 'title'> = {
    number,
    date: new Date(c.start).toISOString(),
    startedAt: new Date(c.start).toISOString(),
    endedAt: new Date(c.end).toISOString(),
    participants,
    totalVikingHours,
    deaths,
    raids,
    discoveries,
    bossKills,
    worldDayRange,
  };

  return { ...episode, title: titleFor(episode) };
}

// ── title derivation (saga voice, rule priority) ──────────────────────

const QUIET_TITLES = [
  'A Quiet Evening of Building',
  'Wood Was Chopped, Mead Was Drunk',
  'Small Deeds by Firelight',
  'The Longhouse Grew a Little',
  'Nets Mended, Old Tales Told',
  'A Night Without Incident',
  'Stone Was Laid, Fires Were Fed',
  'Quiet Work Beneath a Cold Moon',
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

function titleFor(e: Omit<Episode, 'title'>): string {
  if (e.bossKills.length > 0) return `The Fall of ${e.bossKills[0]}`;
  if (e.deaths.length >= 3) return `The Night of ${e.deaths.length} Deaths`;
  if (e.raids.length > 0) return raidTitle(e.raids[0]);
  if (e.discoveries.length > 0) return discoveryTitle(e.discoveries[0]);
  if (e.participants.length >= 6) return 'A Full Hall';
  if (e.participants.length === 1) return `${firstName(e.participants[0]?.name)}'s Lone Vigil`;
  return QUIET_TITLES[(e.number - 1) % QUIET_TITLES.length];
}

const ENV_DEATHS: Record<string, string> = {
  fall: 'fell to their death',
  drowning: 'claimed by dark water',
  drowned: 'claimed by dark water',
  tree: 'crushed by a falling tree',
  fire: 'lost to the flames',
  smoke: 'choked on hearth-smoke',
  freezing: 'frozen in the cold',
  cold: 'frozen in the cold',
  stalagmite: 'skewered from above',
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
