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
import type { GameSession, GameEvent, Oath, Boss } from './types';
import { taleByline } from './tales';

export interface EpisodeParticipant {
  name: string;
  minutes: number;
}

export interface EpisodeDeath {
  name: string;
  cause: string;
  /**
   * Where they fell, when the producer said so (`events.metadata.biome`,
   * lib/deaths.ts). Optional because most of the history predates it and
   * because only the expressive death picture reads it.
   */
  biome?: string | null;
  /**
   * Who did it, when the death row named them separately from the cause
   * (`events.metadata.attacker`). Read only to count a boss's toll.
   */
  attacker?: string | null;
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

// ── NEW INPUTS (2026-09-27, the expressive Story pass) ────────────────────
// Everything below arrives through buildEpisodes' optional SIXTH argument and
// is bucketed to a Central calendar day exactly like sessions and events are.
// All of it is optional: the five-argument call sites that predate this pass
// keep working and keep rendering the terse description they always did.

/** One living title conferred on a viking (title_history joined to players). */
export interface EpisodeTitleAwardInput {
  characterName: string;
  title: string;
  awardedAt: string;
}

/** One Player-of-the-Day crown (poty_history). */
export interface EpisodePotyAwardInput {
  characterName: string;
  awardLabel: string;
  awardedAt: string;
}

/** One mirrored in-game shout (chat_lines), a candidate for the night's quote. */
export interface EpisodeChatLineInput {
  characterName: string;
  message: string;
  createdAt: string;
}

/** players.first_seen_at, so a viking's very first night can be called one. */
export interface EpisodeFirstSeenInput {
  characterName: string;
  firstSeenAt: string;
}

/**
 * A felled forsaken's own record of its fight (the `bosses` row), as the
 * episode builder needs it. Added 2026-10-02 for Moder's inaugural kill: the
 * `events` row the Story has always used carries the boss name and a COUNT,
 * and everything that makes a boss night worth reading was in this table.
 */
export interface EpisodeBossFightInput {
  name: string;
  killedAt: string;
  playersPresent: string[];
  fightStats: Boss['fight_stats'];
  /** when the Skald wrote the retelling, or null — the card links, never renders it */
  retellingAt: string | null;
}

/** The same fight, resolved and bucketed onto the night it happened. */
export interface EpisodeBossFight {
  name: string;
  killedAt: string;
  /** everyone who landed a blow, best-known order (damage desc, then listed order) */
  fighters: string[];
  /** fighter → damage, sorted hardest first; empty when the fight kept no ledger */
  damage: { name: string; amount: number }[];
  topDamagePlayer: string | null;
  topDamage: number | null;
  /** how many were still in the realm when it dropped */
  onlineAtKill: number;
  /** how long the fight ran, in seconds, when anyone clocked it */
  fightSec: number | null;
  /** the vikings this boss killed on the way down, that same night */
  toll: string[];
  /** the world day it fell on, from the kill event */
  worldDay: number | null;
  retellingAt: string | null;
}

/** The optional sixth argument of buildEpisodes. */
export interface EpisodeExtras {
  titleAwards?: EpisodeTitleAwardInput[];
  potyAwards?: EpisodePotyAwardInput[];
  chatLines?: EpisodeChatLineInput[];
  firstSeen?: EpisodeFirstSeenInput[];
  /** the `bosses` rows for every forsaken already felled */
  bossFights?: EpisodeBossFightInput[];
  /** boss name → the longest fight anyone clocked, seconds (gs_stats fallback) */
  bossFightSeconds?: Record<string, number>;
}

/** A Great Deed achieved on this night (events of type 'milestone'). */
export interface EpisodeMilestone {
  title: string;
  line: string | null;
}

/** A living title conferred on this night, as the card's prose names it. */
export interface EpisodeTitleAward {
  name: string;
  title: string;
}

/** A Player-of-the-Day crown worn for this night. */
export interface EpisodePotyAward {
  name: string;
  label: string;
}

/** A shout from this night that passed the quote filter. */
export interface EpisodeChatLine {
  name: string;
  message: string;
}

/**
 * Minimal tale shape the episode builder needs (db/2026-09-06_tales.sql).
 *
 * `told_for` is ALREADY a Central calendar day, which is what makes attaching a
 * tale different from everything else in this file: sessions, deaths, pins and
 * oaths all carry an instant and have to be bucketed through ctDayKey, and a
 * tale simply says which night it is about. Never run it through ctDayKey.
 */
export interface EpisodeTaleInput {
  id?: string | null;
  title: string;
  text: string;
  author_character?: string | null;
  told_for: string;
  created_at: string;
}

/** A tale as an episode card renders it. */
export interface EpisodeTale {
  id: string | null;
  title: string;
  text: string;
  /** the byline: a character name, or 'the Storyteller' */
  by: string;
  createdAt: string;
}

/** Minimal pin shape the episode builder needs (bucketed by CT calendar day). */
export interface EpisodePinInput {
  name: string;
  kind?: string | null;
  by_character_name?: string | null;
  created_at: string;
}

/**
 * How loudly a night is told.
 *
 * Decided by RANK over the whole list, not by a fixed score (see assignTiers),
 * and carried on the Episode so titleFor and describeEpisode read one decision
 * rather than each re-deriving it.
 */
export type EpisodeTier = 'terse' | 'expressive';

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
  /**
   * The Storyteller's tales OF this night, oldest first
   * (db/2026-09-06_tales.sql). Empty on every day nobody wrote one about, which
   * is every day before the migration runs.
   */
  tales: EpisodeTale[];
  /** Great Deeds achieved this day (events of type 'milestone') */
  milestones: EpisodeMilestone[];
  /** `events.metadata.players` from the day's boss kill, when it carried one */
  bossParty: string | null;
  /** the world day the boss fell on, from the kill event */
  bossWorldDay: number | null;
  /** the `bosses` record of any forsaken felled this night, newest last */
  bossFights: EpisodeBossFight[];
  /** living titles conferred this day (title_history) */
  titleAwards: EpisodeTitleAward[];
  /** Player-of-the-Day crowns awarded for this day (poty_history) */
  potyAwards: EpisodePotyAward[];
  /** participants whose very first session ever was this day */
  newcomers: string[];
  /** the day's shouts that passed the quote filter, oldest first */
  chatLines: EpisodeChatLine[];
  /** [min, max] world day touched this day, or null if unknown */
  worldDayRange: [number, number] | null;
  /** terse or expressive, decided against the nights either side of it */
  tier: EpisodeTier;
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
  pins: EpisodePinInput[] = [],
  tales: EpisodeTaleInput[] = [],
  extras: EpisodeExtras = {}
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

  // A TALE DOES NOT OPEN AN EPISODE, and that is deliberate. An episode is a
  // night somebody PLAYED (at least one session), and a tale about a night with
  // no sessions has no card to sit on. It is not lost: /events/storyteller
  // shows every tale whether or not its night produced an episode, which is the
  // view that exists for exactly this reason.
  const talesForDay = new Map<string, EpisodeTaleInput[]>();
  for (const t of tales) {
    // `told_for` is already a Central calendar day. Slicing rather than parsing
    // is what keeps a `date` that PostgREST hands back as '2026-09-12' and one
    // a caller built as '2026-09-12T00:00:00' on the same night.
    const key = typeof t?.told_for === 'string' ? t.told_for.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const list = talesForDay.get(key);
    if (list) list.push(t);
    else talesForDay.set(key, [t]);
  }

  // `first_seen_at` is a property of the VIKING, not of a night, so it is
  // reduced to one calendar day here and looked up per bucket rather than
  // re-scanned for every episode.
  const firstSeenDay = new Map<string, string>();
  for (const f of extras.firstSeen ?? []) {
    const name = (f?.characterName ?? '').trim();
    const key = ctDayKey(ms(f?.firstSeenAt));
    if (name && key && !firstSeenDay.has(name)) firstSeenDay.set(name, key);
  }
  const prepared: PreparedExtras = {
    titleAwards: extras.titleAwards ?? [],
    potyAwards: extras.potyAwards ?? [],
    chatLines: extras.chatLines ?? [],
    firstSeenDay,
    bossFights: extras.bossFights ?? [],
    bossFightSeconds: extras.bossFightSeconds ?? {},
  };

  // TWO PASSES, AND IT HAS TO BE TWO. A night's tier depends on the nights
  // either side of it (assignTiers), so every night's facts must exist before
  // any night's prose can be written.
  const days = [...buckets.keys()].sort(); // ascending ISO date == chronological
  const cores = days.map((key, i) =>
    finishEpisode(buckets.get(key)!, i + 1, events, oaths, pins, talesForDay.get(key) ?? [], prepared)
  );
  const tiers = assignTiers(cores, days);
  // Deaths may lead a night only when it was the deadliest of its own week,
  // which is another thing that can only be known from the whole list.
  const deathPeaks = assignDeathPeaks(cores, days);

  // NO TWO NIGHTS IN A ROW SHARE A TITLE (2026-10-07: three "The Siege"
  // nights running). Each night is titled knowing the previous night's final
  // title; on a match it is re-titled with a bumped attempt (seed + attempt for
  // the pick() pools, index + attempt for QUIET_TITLES). Titles that ARE a fact
  // (a boss, a specific discovery or raid kind, a lone viking's name) come back
  // unchanged on every attempt, so they simply stand. Still deterministic: the
  // same nights in the same order give the same titles.
  let previousTitle: string | null = null;
  return cores.map((core, i) => {
    const seed = hashString(days[i]);
    const tier = tiers[i];
    const peak = deathPeaks[i];
    const title = titleAvoiding(core, tier, peak, previousTitle);
    previousTitle = title;
    return {
      ...core,
      tier,
      title,
      description: describeEpisode(core, seed, tier, peak),
    };
  });
}

const TITLE_REPICK_ATTEMPTS = 4;

function sameTitle(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * titleFor, re-picked until it differs from `previous`. Gives up after a few
 * attempts and keeps the FIRST choice — a repeat that names a fact beats an
 * arbitrary pool entry.
 */
function titleAvoiding(
  e: EpisodeCore,
  tier: EpisodeTier,
  deathsPeak: boolean,
  previous: string | null
): string {
  const first = titleFor(e, tier, deathsPeak, 0);
  if (!sameTitle(first, previous)) return first;
  for (let attempt = 1; attempt <= TITLE_REPICK_ATTEMPTS; attempt++) {
    const t = titleFor(e, tier, deathsPeak, attempt);
    if (!sameTitle(t, previous)) return t;
  }
  return first;
}

/** The sixth argument after buildEpisodes has reduced it once, not per day. */
interface PreparedExtras {
  titleAwards: EpisodeTitleAwardInput[];
  potyAwards: EpisodePotyAwardInput[];
  chatLines: EpisodeChatLineInput[];
  firstSeenDay: Map<string, string>;
  bossFights: EpisodeBossFightInput[];
  bossFightSeconds: Record<string, number>;
}

function finishEpisode(
  b: DayBucket,
  number: number,
  events: GameEvent[],
  oaths: Oath[],
  pins: EpisodePinInput[],
  dayTales: EpisodeTaleInput[] = [],
  prepared: PreparedExtras = {
    titleAwards: [], potyAwards: [], chatLines: [], firstSeenDay: new Map(),
    bossFights: [], bossFightSeconds: {},
  }
): EpisodeCore {
  // Collected with their instants so the list can be put in the order they
  // HAPPENED rather than the order the caller handed the events over.
  // buildEpisodes promises callers may pass data in any order, and the boss's
  // toll ("Æymundr and Yunter paid for it") was reading that promise back.
  const deathRows: { at: number; death: EpisodeDeath }[] = [];
  const raids: string[] = [];
  const discoveries: string[] = [];
  const bossKills: string[] = [];
  const milestones: EpisodeMilestone[] = [];
  let bossParty: string | null = null;
  let bossWorldDay: number | null = null;
  const worldDays: number[] = [];

  for (const e of events) {
    if (ctDayKey(ms(e.created_at)) !== b.key) continue;

    const day = num(e.metadata, 'world_day');
    if (day !== undefined) worldDays.push(day);

    switch (e.type) {
      case 'death':
        deathRows.push({
          at: ms(e.created_at),
          death: {
            name: e.character_name ?? 'A viking',
            cause: str(e.metadata, 'cause') ?? 'the wilds',
            biome: str(e.metadata, 'biome') ?? null,
            attacker: str(e.metadata, 'attacker') ?? null,
          },
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
        if (boss) {
          bossKills.push(boss);
          // Who was standing there when it dropped, exactly as the feed says it
          // (lib/events.ts reads the same key).
          if (!bossParty) bossParty = str(e.metadata, 'players') ?? null;
          if (bossWorldDay === null) bossWorldDay = num(e.metadata, 'world_day') ?? null;
        }
        break;
      }
      case 'milestone': {
        // A Great Deed. `milestone` is only the database's name for it; every
        // surface a player reads says Great Deed (lib/events.ts).
        const title = str(e.metadata, 'title');
        if (title) milestones.push({ title, line: str(e.metadata, 'line') ?? null });
        break;
      }
    }
  }

  // Chronological. Array.prototype.sort is stable, so two deaths recorded at
  // the same instant keep the order they arrived in, exactly as before.
  const deaths: EpisodeDeath[] = deathRows
    .sort((a, c) => (Number.isNaN(a.at) ? 0 : a.at) - (Number.isNaN(c.at) ? 0 : c.at))
    .map((r) => r.death);

  const places: EpisodePlace[] = pins
    .filter((p) => ctDayKey(ms(p.created_at)) === b.key && p.name?.trim())
    .map((p) => ({ name: p.name.trim(), kind: p.kind ?? null, by: p.by_character_name ?? null }));

  const dayOaths: EpisodeOath[] = oaths
    .filter((o) => ctDayKey(ms(o.sworn_at)) === b.key && o.oath_text?.trim())
    .map((o) => ({ name: o.character_name ?? 'A viking', text: o.oath_text.trim() }));

  const participants: EpisodeParticipant[] = b.order
    .map((name) => ({ name, minutes: b.minutesByName.get(name) ?? 0 }))
    .sort((a, c) => c.minutes - a.minutes);

  // ── the new inputs, all bucketed to this same Central calendar day ──
  const onDay = (iso: string | null | undefined) => ctDayKey(ms(iso)) === b.key;

  const seenTitle = new Set<string>();
  const titleAwards: EpisodeTitleAward[] = [];
  for (const t of prepared.titleAwards) {
    const name = (t?.characterName ?? '').trim();
    const title = (t?.title ?? '').trim();
    if (!name || !title || !onDay(t?.awardedAt)) continue;
    // One viking can be re-awarded the same title inside a day (a handover that
    // bounces back); the hall only hears about it once.
    const k = `${name}\u0000${title}`;
    if (seenTitle.has(k)) continue;
    seenTitle.add(k);
    titleAwards.push({ name, title });
  }

  const potyAwards: EpisodePotyAward[] = prepared.potyAwards
    .filter((a) => (a?.characterName ?? '').trim() && (a?.awardLabel ?? '').trim() && onDay(a?.awardedAt))
    .map((a) => ({ name: a.characterName.trim(), label: a.awardLabel.trim() }));

  // A NEWCOMER IS A PARTICIPANT, not merely a row created today. `first_seen_at`
  // is written when a viking is first SEEN, which a join alone can do, so the
  // list is intersected with the people who actually logged a session here.
  const newcomers = participants
    .map((p) => p.name)
    .filter((name) => prepared.firstSeenDay.get(name) === b.key);

  // Only quotable shouts are carried, so the Episode never ships the night's
  // whole chat log to a renderer that wants at most one line of it. Speakers
  // who were in the hall are preferred; if none of them said anything usable,
  // any quotable line from the day will do.
  const dayChat: EpisodeChatLine[] = [];
  for (const c of prepared.chatLines) {
    const name = (c?.characterName ?? '').trim();
    if (!name || !onDay(c?.createdAt)) continue;
    const message = quotable(c?.message);
    if (!message) continue;
    dayChat.push({ name, message });
  }
  const present = new Set(participants.map((p) => p.name));
  const fromPresent = dayChat.filter((c) => present.has(c.name));
  const chatLines = fromPresent.length > 0 ? fromPresent : dayChat;

  // ── the night's boss fights, from the `bosses` row rather than the event ──
  const bossFights: EpisodeBossFight[] = prepared.bossFights
    .filter((f) => (f?.name ?? '').trim() && onDay(f?.killedAt))
    .map((f) => resolveBossFight(f, deaths, bossWorldDay, prepared.bossFightSeconds));

  const totalMinutes = participants.reduce((sum, p) => sum + p.minutes, 0);
  const totalVikingHours = Math.round((totalMinutes / 60) * 10) / 10;

  const worldDayRange: [number, number] | null = worldDays.length
    ? [Math.min(...worldDays), Math.max(...worldDays)]
    : null;

  // Oldest first, because two tales of one night read as a sequence. The bot's
  // own list is newest first for a different reason (it is a working list a
  // Storyteller numbers a correction against), and neither ordering is the
  // other's business.
  const episodeTales: EpisodeTale[] = [...dayTales]
    .filter((t) => (t?.title ?? '').trim() && (t?.text ?? '').trim())
    .sort((a, c) => ms(a.created_at) - ms(c.created_at))
    .map((t) => ({
      id: t.id ?? null,
      title: t.title.trim(),
      text: t.text,
      by: taleByline(t.author_character),
      createdAt: t.created_at,
    }));

  const core: EpisodeCore = {
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
    tales: episodeTales,
    milestones,
    bossParty,
    bossWorldDay,
    bossFights,
    titleAwards,
    potyAwards,
    newcomers,
    chatLines,
    worldDayRange,
  };

  return core;
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

// The raid rung's fallback, for a raid whose detail names no particular kind.
// It used to be the single string 'The Siege', which gave three nights running
// the same headline (and, with a fixed first entry, every other night after
// that). Picked per night from the date's seed like the other pools; a re-pick
// (seed + attempt) walks to the next entry.
const RAID_TITLES = ['The Siege', 'Raiders at the Walls', 'The Walls Held', 'A Night Under Siege', 'Shields to the Palisade'];

/** Turn a raw raid detail into a saga chapter title. */
function raidTitle(detail: string, seed: number): string {
  const d = detail.toLowerCase();
  if (d.includes('forest is moving') || d.includes('greydwarf')) return 'The Forest Marched';
  if (d.includes('foul smell') || d.includes('swamp')) return 'A Stench from the Swamp';
  if (d.includes('hunted')) return 'The Night of the Hunt';
  if (d.includes('ground is shaking') || d.includes('troll')) return 'The Ground Shook';
  if (d.includes('cold wind') || d.includes('wolves') || d.includes('wolf')) return 'The Wolves Came';
  if (d.includes('surtling') || d.includes('fire')) return 'A Night of Embers';
  return pick(RAID_TITLES, seed, 24);
}

const FIRST_PIN_TITLES = ['A Place with a Name', 'New Ground, Newly Named', 'The Map Grew'];
const OATH_TITLES = ['Oaths by Firelight', 'Vows Before the Hall', 'The Swearing of Oaths'];

/**
 * An episode's FACTS: everything buildEpisodes derives from the raw rows,
 * before anything has been decided about how to tell it. Deliberately without
 * `tier`, because the tier is computed FROM this and handing it back in would
 * be a loop; and without title/description for the same reason.
 */
type EpisodeCore = Omit<Episode, 'title' | 'description' | 'tier'>;

// ══ WHAT LEADS A NIGHT ════════════════════════════════════════════════════
//
// WHY THIS EXISTS (Charlie, on the shipped page): "The story each day seems to
// over index on deaths." He was right, and the numbers were embarrassing: 13
// of the season's 19 nights carried a title of the form "The Day of N Deaths",
// and the death sentence led most descriptions. Deaths were never chosen as
// the most interesting thing that happened; they were simply second in an old
// ladder and they are the one thing that happens every single night.
//
// So there is now ONE ladder, shared by the title and by both renderers, and
// deaths are one colour in it rather than the default. The order is
//
//   a boss fell > a Great Deed landed > somebody's first night > [deaths, but
//   only if this was the deadliest night of its week] > new country >
//   a raid > places named > oaths sworn > titles conferred
//
// and below that the title adds turnout/hours and then, last, a death count.
//
// THE TWO WAYS DEATHS MAY STILL LEAD, both deliberately narrow:
//   • `deathsPeak` — this night had more deaths than any other night within
//     three calendar days either side. That is the honest "this was the bad
//     one" signal, and it is computed over the list (assignDeathPeaks) for
//     exactly the reason the tier is: a count only means something next to
//     the counts around it.
//   • thirty or more deaths with nothing else at all to report.
//
// A night with one death and nothing else still leads with that death rather
// than with "wood was chopped, mead was drunk": filler must never displace a
// real event. That is the one place this ladder bottoms out differently from
// the literal reading, and it is why the pre-existing death-phrasing tests
// still pass unchanged.
type HeadlineKind =
  | 'boss' | 'deed' | 'newcomer' | 'deaths' | 'discovery'
  | 'raid' | 'places' | 'oaths' | 'titles' | 'none';

function leadKind(e: EpisodeCore, deathsPeak: boolean): HeadlineKind {
  if (e.bossKills.length > 0) return 'boss';
  if (e.milestones.length > 0) return 'deed';
  if (e.newcomers.length > 0) return 'newcomer';
  if (e.deaths.length > 0 && deathsPeak) return 'deaths';
  if (e.discoveries.length > 0) return 'discovery';
  if (e.raids.length > 0) return 'raid';
  if (e.places.length > 0) return 'places';
  if (e.oaths.length > 0) return 'oaths';
  if (e.titleAwards.length > 0) return 'titles';
  return 'none';
}

/**
 * Which nights were the deadliest of their own week.
 *
 * Same seven-calendar-night window as assignTiers, same reason: a raw count
 * says nothing on its own. Ties go to the earlier date, and a night with no
 * neighbours is NOT a peak — being the only night in the list is not an
 * achievement, and treating it as one would make every single-night render
 * (every test, every one-off) a death story again.
 */
function assignDeathPeaks(cores: EpisodeCore[], dayKeys: string[]): boolean[] {
  const day = dayKeys.map(dayNumber);
  const counts = cores.map((c) => c.deaths.length);
  return cores.map((_, i) => {
    if (counts[i] === 0) return false;
    let neighbours = 0;
    for (let j = 0; j < cores.length; j++) {
      if (j === i || Math.abs(day[j] - day[i]) > TIER_WINDOW_RADIUS_DAYS) continue;
      neighbours += 1;
      if (counts[j] > counts[i] || (counts[j] === counts[i] && day[j] < day[i])) return false;
    }
    return neighbours > 0;
  });
}

// ── the new title pools ───────────────────────────────────────────────────

// Six of the season's 19 nights land a Great Deed, so the deed rung needs more
// than one shape or the rebalance simply swaps one repeated headline for
// another. A leading "The" is lowercased inside "The Night of ..." the same
// way the boss rung does it.
const DEED_TITLES = ['{title}, Achieved', 'The Night of {title}', '{title}, At Last'];

const NEWCOMER_TITLES = ["{name}'s First Night", '{name} Came to the Realm', '{name} at the Gate'];
const TURNOUT_TITLES = ['{n} at the Benches', 'A Hall of {n}', '{n} Answered the Horn'];
const FULL_HALL_TITLES = ['A Full Hall', 'Every Bench Taken', 'The Benches Filled'];
const HOURS_TITLES = ['{h} Hours by the Fire', '{h} Hours Between Them'];
const TITLE_AWARD_TITLES_ONE = ['{name} Took Up {title}', 'A New Name for {name}'];
const TITLE_AWARD_TITLES_MANY = ['{n} Titles Changed Hands', 'New Names by Firelight'];

/** "Grimbly's First Night", "Grimbly and Ravena Arrive", "Five New Vikings". */
function newcomerTitle(newcomers: string[], seed: number): string {
  const names = [...new Set(newcomers.map(firstName))];
  if (names.length === 1) return fill(pick(NEWCOMER_TITLES, seed, 20), { name: names[0] });
  if (names.length === 2) return `${names[0]} and ${names[1]} Arrive`;
  return `${numTitle(names.length)} New Vikings`;
}

function titleAwardTitle(awards: EpisodeTitleAward[], seed: number): string | null {
  if (awards.length === 0) return null;
  if (awards.length === 1) {
    const t = plainText(awards[0].title);
    if (!t) return null;
    return fill(pick(TITLE_AWARD_TITLES_ONE, seed, 21), { name: firstName(awards[0].name), title: t });
  }
  return fill(pick(TITLE_AWARD_TITLES_MANY, seed, 21), { n: numTitle(awards.length) });
}

/** The turnout rung: how many came, or how long they stayed. */
function turnoutTitle(e: EpisodeCore, seed: number): string | null {
  const heads = e.participants.length;
  const hours = Math.round(e.totalVikingHours);
  if (heads < 6) return null;
  // Two shapes, chosen by the day's seed so a run of full halls does not read
  // as the same headline five nights running.
  if (hours >= 40 && (seed & 1) === 0) return fill(pick(HOURS_TITLES, seed, 22), { h: numTitle(hours) });
  if (heads >= 8) return fill(pick(TURNOUT_TITLES, seed, 22), { n: numTitle(heads) });
  // Seeded like the other pools; a re-pick (seed + attempt) walks to the next entry.
  return pick(FULL_HALL_TITLES, seed, 26);
}

/** The death-count rung, in each tier's own register. */
function deathTitle(e: EpisodeCore, tier: EpisodeTier): string {
  if (tier === 'expressive') {
    const horde = dominantCreature(e.deaths);
    if (horde) return `The Night of the ${horde} Horde`;
    return `The Night of ${numTitle(e.deaths.length)} Deaths`;
  }
  return `The Day of ${e.deaths.length} Deaths`;
}

/**
 * `attempt` > 0 is a re-pick (titleAvoiding): every pool rotates by it, while
 * the boss rung deliberately keeps the date's own seed so a boss night always
 * carries the same boss title.
 */
function titleFor(e: EpisodeCore, tier: EpisodeTier, deathsPeak: boolean, attempt = 0): string {
  const dateSeed = hashString(e.date.slice(0, 10));
  const seed = dateSeed + attempt;
  const loud = tier === 'expressive';

  // THE SHARED LADDER (leadKind), in each tier's own register. An expressive
  // night gets the louder phrasing of the same fact; a terse night keeps the
  // wording the season already carries.
  switch (leadKind(e, deathsPeak)) {
    case 'boss': {
      // The richer pool needs the fight's own record; without one the night
      // keeps the title it has always had.
      const fight = e.bossFights[0];
      if (fight) {
        const t = bossNightTitle(fight, dateSeed);
        if (t) return t;
      }
      const boss = plainText(e.bossKills[0]);
      if (boss) return loud ? `The Night ${boss.replace(/^The\s+/, 'the ')} Fell` : `The Fall of ${boss}`;
      break;
    }
    case 'deed': {
      const t = plainText(e.milestones[0].title);
      if (t) {
        const shape = pick(DEED_TITLES, seed, 23);
        // "The Night of The Five Hundred" and "...of A Hundred Hours" both
        // read as a typo; the article is lowercased mid-sentence.
        const inner = t.replace(/^(The|An|A)\s+/, (_m, a) => `${a.toLowerCase()} `);
        return fill(shape, { title: shape.startsWith('The Night of') ? inner : t });
      }
      break;
    }
    case 'newcomer':
      return newcomerTitle(e.newcomers, seed);
    case 'deaths':
      return deathTitle(e, tier);
    case 'discovery':
      return discoveryTitle(e.discoveries[0]);
    case 'raid':
      return raidTitle(e.raids[0], seed);
    case 'places':
      return pick(FIRST_PIN_TITLES, seed);
    case 'oaths':
      return pick(OATH_TITLES, seed);
    case 'titles': {
      const t = titleAwardTitle(e.titleAwards, seed);
      if (t) return t;
      break;
    }
  }

  // Nothing happened that names itself. Who turned up, then how deadly it was,
  // then the quiet pool, which is still the right answer for a genuinely quiet
  // night and is reached the same way it always was.
  const turnout = turnoutTitle(e, seed);
  if (turnout) return turnout;
  if (e.deaths.length >= 30) return deathTitle(e, tier);
  if (e.participants.length === 1) return `${firstName(e.participants[0]?.name)}'s Lone Vigil`;
  return QUIET_TITLES[(e.number - 1 + attempt) % QUIET_TITLES.length];
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
    'The hall was full. {names} answered the horn{day}.',
    'The mead-benches filled as {names} sailed{day}.',
    '{names} crowded the realm{day}.',
  ],
  none: [
    'The realm lay quiet{day}.',
    'No sails were raised, yet the saga still turned{day}.',
  ],
};

const BOSS_DESC = [
  '{boss} fell this day, and a new region opened to the warband.',
  '{boss} was felled at last.',
  '{boss} met its end. Skål to the war party that took its head.',
];

const CREATURE_DESC = [
  '{name} learned to fear the {Cause}.',
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
  cartcollision: ['{name} was run down by their own cart. No honor in that one.'],
  structural: ['{name} was crushed beneath falling timber.'],
  turret: ['{name} was shot down by a ballista. Friendly fire, perhaps.'],
  boat: ['{name} was run down by a longship.'],
  self: ['{name} was undone by their own hand; the hall asks no questions.'],
  // Mirrors the ENV_DEATHS entry — and it must exist HERE too, because ENV_KEYS
  // (derived from this map) is what tells featuredDeath a cause is an
  // environmental one. Missing, "enemyhit" would be classed as a creature name
  // and featured as "{name} learned to fear the humble Enemyhit."
  enemyhit: [
    '{name} was struck down by an unseen foe.',
    'Something out in the dark took {name}, and did not show its face.',
  ],
  edgeofworld: ['{name} sailed clean off the edge of the world.'],
  ashlandsocean: ['{name} was boiled alive in the Ashlands sea.'],
  ashlandsoceanfloor: ['{name} was boiled alive in the Ashlands sea.'],
  lava: ['{name} was swallowed by molten rock.'],
  // Added with the eilif-death reporter (our own plugin sends the HitType word
  // verbatim, so EVERY value of HitData.HitType needs a phrase here as well as
  // in ENV_DEATHS — scripts/eilif-death.test.mjs asserts the whole enum).
  undefined: ['{name} fell to something that left no name behind.'],
  playerhit: ['{name} was cut down by one of their own.'],
  cart: ['{name} was run down by their own cart. No honor in that one.'],
  catapult: ['{name} was smashed flat by a catapult stone.'],
  cinderfire: ['{name} was caught in a rain of burning cinders.'],
};

const DEADLY_DESC = [
  'Blood was spilled {n} times before the fires dimmed.',
  'The realm claimed {n} lives this day, none of them for long.',
  '{n} deaths darkened the day’s saga.',
];

const ONE_DEATH_DESC = [
  'One viking fell and rose again by the hearth.',
  'A single death marked the day, brief and unglorious.',
];

const DISCOVERY_DESC = [
  'New country was charted this day.',
  'The warband pushed into lands no map yet held.',
];

const RAID_DESC = [
  'The hall weathered a raid and held.',
  'A raid tested the walls, and the walls won.',
  'The warband stood against a siege before the dawn.',
];

const PLACES_ONE_DESC = [
  '{place} was marked upon the map.',
  'The map grew: {place} now bears a name.',
];

const PLACES_MANY_DESC = [
  'New ground was named: {places}.',
  '{places} were marked upon the map.',
];

const OATHS_ONE_DESC = [
  '{name} swore a fresh oath before the hall.',
  'An oath was spoken: {name} bound their word to the warband.',
];

const OATHS_MANY_DESC = [
  '{names} swore new oaths before the warband.',
  '{n} oaths were spoken before the hall this day.',
];

const QUIET_DESC = [
  'Wood was chopped, mead was drunk, and the longhouse grew a little.',
  'Quiet work by firelight: stone laid, nets mended, no blood spilled.',
  'A calm stretch; the fires were fed and the hall kept warm.',
];

// OWN-PROPERTY lookup for the cause-keyed maps. A cause is attacker-reachable
// (a modded client names its own killer), and a bare `MAP[low]` walks
// Object.prototype: a death "caused by constructor" handed ENV_DESC the Object
// function, and buildEpisodes threw on it — a 500 on every page that renders
// the saga. `toString` was quieter and worse: it rendered.
function lookup<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

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
    const envPool = lookup(ENV_DESC, low);
    if (envPool) return fill(pick(envPool, seed, 5), { name: nm });
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
  return lo === hi ? `, the world at day ${lo}` : `, across world days ${lo} to ${hi}`;
}

/**
 * The night in prose.
 *
 * TWO RENDERERS, ONE DOOR. An ordinary night goes through describeTerse, which
 * is the original function byte for byte, so nothing already on the season's
 * cards moves. An expressive night goes through describeExpressive instead and
 * gets four to seven specific sentences.
 *
 * The tier is DECIDED ELSEWHERE (assignTiers, over the whole list) and passed
 * in. The score is still read here, but only to choose between the two closing
 * pools, never to decide the tier a second time.
 */
function describeEpisode(
  e: EpisodeCore,
  seed: number,
  tier: EpisodeTier,
  deathsPeak: boolean
): string {
  const kind = leadKind(e, deathsPeak);
  if (tier !== 'expressive') return describeTerse(e, seed, kind);
  return describeExpressive(e, seed, notability(e).score, kind);
}

function describeTerse(e: EpisodeCore, seed: number, kind: HeadlineKind): string {
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

  // Primary headline clause, from the shared ladder (leadKind). `kind` is kept
  // so the colour clause below never tells the same event a second time ("The
  // warband stood against a siege. A raid tested the walls, and the walls
  // won." was two sentences about one raid).
  let primary: string | null = null;
  switch (kind) {
    case 'boss':
      primary = fill(pick(BOSS_DESC, seed, 1), { boss: e.bossKills[0] });
      break;
    case 'deed': {
      const t = plainText(e.milestones[0].title);
      primary = t ? sentence(fill(pick(EXPR_DEED, seed, 1), { title: t })) : null;
      break;
    }
    case 'newcomer':
      primary = newcomerSentence(e.newcomers, seed);
      break;
    case 'deaths':
      primary = deathSentence(e.deaths, seed);
      break;
    case 'discovery':
      primary = pick(DISCOVERY_DESC, seed, 1);
      break;
    case 'raid':
      primary = pick(RAID_DESC, seed, 1);
      break;
    case 'places':
      primary = placesClause(e.places, seed);
      break;
    case 'oaths':
      primary = oathsClause(e.oaths, seed);
      break;
    case 'titles':
      primary = titleAwardsSentence(e.titleAwards);
      break;
  }
  // NOTHING NAMED ITSELF. A night with deaths and nothing else still leads
  // with the death rather than with "wood was chopped, mead was drunk":
  // generic filler must never displace a real event, which is also why the
  // pre-existing death-phrasing tests read the same as they always did.
  if (!primary) primary = e.deaths.length > 0 ? deathSentence(e.deaths, seed) : pick(QUIET_DESC, seed, 1);

  // ONE colour clause, a different flavour from the headline. A death is one
  // of the candidates here rather than the automatic headline it used to be,
  // and as a colour it is the single most notable death, never a count.
  const secondaries: string[] = [];
  const candidates = [
    kind !== 'oaths' && e.oaths.length > 0 ? oathsClause(e.oaths, seed) : null,
    kind !== 'places' && e.places.length > 0 ? placesClause(e.places, seed) : null,
    kind !== 'raid' && e.raids.length > 0 ? pick(RAID_DESC, seed, 3) : null,
    kind !== 'discovery' && e.discoveries.length > 0 ? discoveryClause(e.discoveries, seed) : null,
    kind !== 'titles' && e.titleAwards.length > 0 ? titleAwardsSentence(e.titleAwards) : null,
    kind !== 'deaths' ? notableDeathSentence(e.deaths, seed, e.newcomers) : null,
  ];
  for (const s of candidates) {
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


// ══ NOTABILITY, AND THE EXPRESSIVE NIGHT ══════════════════════════════════
//
// WHY THIS EXISTS (Charlie, 2026-09-27): a 21-viking night with 41 deaths read
// exactly like a four-viking night, because the terse renderer above always
// spends the same two or three sentences no matter what it is given. Ordinary
// nights are fine as they are. Big ones are not.
//
// So every episode is scored, and only a night that crosses the threshold gets
// the longer treatment. Everything below is still pure, still seeded off the
// calendar day, still zero LLM calls.
//
// THE SCORE, and why each weight is what it is:
//
//   +4  14 or more vikings      the hall is genuinely full
//   +2  8 to 13 vikings         a crowd, but not a season high
//   +4  a boss fell             the rarest thing that happens here
//   +2  15 or more deaths       a night with a body count is a story
//   +2  60 or more viking-hours people stayed
//   +2  a Great Deed landed     collective, announced, remembered
//   +2  somebody's first night  it only happens to each viking once
//   +1  a living title changed hands
//   +2  MAX for variety         raids, discoveries, places named, oaths,
//                               tales: one point each, capped at two, so a
//                               busy-but-small night cannot creep over the
//                               line on flavour alone
//
// Player-of-the-Day scores NOTHING on purpose. The bot crowns somebody every
// single evening recap, so a point for it would lift the floor of every night
// in the season by one and quietly make "expressive" the default.
//
// THE SCORE ALONE CANNOT DECIDE THE TIER, and the real data is what proves it
// (2026-09-27). Launch week scored 15 to 19 every night and the nine nights
// after it scored 7 to 12, so ANY fixed bar gives launch week five expressive
// nights and last week none. Charlie wants about two a week, always. So the
// score ranks, and assignTiers decides — see it for the rule.
//
// EXPRESSIVE_SCORE is now a FLOOR rather than a threshold: it stops a dead
// week being forced to produce a headline night just because something has to
// come top of it. Eight is "a full hall that stayed", which is the least this
// server should have to clear before a night gets the loud treatment.
export const EXPRESSIVE_SCORE = 8;
/**
 * At or above this, the night gets the loudest closing lines.
 *
 * MOVED WITH THE FLOOR (it was 8, the same number the floor now is, which
 * would have made every expressive night "big" and retired one of the two
 * closing pools). Thirteen is roughly launch-week weight against the season so
 * far: it splits the 19 nights played to 2026-09-27 about seven to twelve.
 */
export const BIG_NIGHT_SCORE = 13;

/**
 * How notable a night was, and why.
 *
 * Pure, and exported so the tests can assert WHICH nights qualify rather than
 * inferring it from the prose. `reasons` is plain English and is not rendered
 * anywhere today; it exists so that "why is this night expressive?" is a
 * question with an answer.
 */
export function notability(e: EpisodeCore): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(why);
  };

  const heads = e.participants.length;
  if (heads >= 14) add(4, `${heads} vikings in the hall`);
  else if (heads >= 8) add(2, `${heads} vikings in the hall`);

  if (e.bossKills.length > 0) add(4, `${e.bossKills[0]} fell`);
  if (e.deaths.length >= 15) add(2, `${e.deaths.length} deaths`);
  if (e.totalVikingHours >= 60) add(2, `${e.totalVikingHours} viking-hours`);
  if (e.milestones.length > 0) {
    add(2, e.milestones.length === 1 ? 'a Great Deed' : `${e.milestones.length} Great Deeds`);
  }
  if (e.newcomers.length > 0) {
    add(2, e.newcomers.length === 1 ? `${firstName(e.newcomers[0])}'s first night` : `${e.newcomers.length} newcomers`);
  }
  if (e.titleAwards.length > 0) {
    add(1, e.titleAwards.length === 1 ? 'a title conferred' : `${e.titleAwards.length} titles conferred`);
  }

  // The variety bucket, capped at two (see the note above).
  let variety = 0;
  const varietyReasons: string[] = [];
  const bump = (on: boolean, why: string) => {
    if (on) {
      variety += 1;
      varietyReasons.push(why);
    }
  };
  bump(e.raids.length > 0, 'a raid');
  bump(e.discoveries.length > 0, 'new country');
  bump(e.places.length > 0, 'places named');
  bump(e.oaths.length > 0, 'oaths sworn');
  bump(e.tales.length > 0, 'a tale told');
  if (variety > 0) {
    score += Math.min(variety, 2);
    reasons.push(varietyReasons.join(', '));
  }

  return { score, reasons };
}

// ── the tier, decided by RANK over the list ───────────────────────────────
//
// WHY RANK AND NOT A THRESHOLD (2026-09-27, Charlie: "about twice a week").
// A fixed bar cannot deliver a rate, because the score measures how busy the
// season is as much as how notable one night was. Measured on the real 19
// nights: launch week scored 15 to 19 every single night, the nine nights
// after it scored 7 to 12. A bar low enough to catch anything in the second
// week catches all seven of the first; a bar high enough to thin the first
// week out catches nothing in the second. Either way the rate is wrong.
//
// THE RULE. A night is expressive when
//
//   • its score is one of the TOP TWO in its window (itself plus every night
//     within three calendar days either side, so seven calendar nights wide,
//     counting only the nights that exist), AND
//   • its score is at least EXPRESSIVE_SCORE, so a dead week is never forced
//     to produce a headline night just because something has to come top
//     of it;
//   • or a boss fell, which is loud whatever else the week was doing.
//
// The window is seven nights wide and keeps two, which is the rate asked for,
// and it slides: a night is judged against its own neighbours rather than
// against the season, so a quiet fortnight still gets its best two nights told
// properly and launch week does not get all of them.
//
// THE WINDOW IS CALENDAR DAYS, NOT LIST POSITIONS. Nobody plays every night,
// and counting three entries either way would quietly stretch the window to a
// fortnight across a gap. Days that nobody played simply contribute nothing.
//
// TIES GO TO THE EARLIER DATE, which matters only for the second slot and is
// there so the whole thing stays deterministic: this runs in a prerendered
// Server Component and the same input must always give the same page.
const TIER_WINDOW_RADIUS_DAYS = 3;
const TIER_TOP_PER_WINDOW = 2;

/** "2026-09-27" → a day number, for comparing dates without parsing instants. */
function dayNumber(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  const t = Date.UTC(y, (m || 1) - 1, d || 1);
  return Number.isNaN(t) ? 0 : Math.floor(t / 86_400_000);
}

/**
 * Which nights get told loudly, given every night in the list.
 *
 * Pure, order-preserving (result[i] is the tier of cores[i]) and deterministic.
 * `dayKeys` are the Central calendar days the cores were bucketed on, in the
 * same order.
 */
function assignTiers(cores: EpisodeCore[], dayKeys: string[]): EpisodeTier[] {
  const day = dayKeys.map(dayNumber);
  const scores = cores.map((c) => notability(c).score);

  return cores.map((core, i) => {
    if (core.bossKills.length > 0) return 'expressive';
    if (scores[i] < EXPRESSIVE_SCORE) return 'terse';

    const window: number[] = [];
    for (let j = 0; j < cores.length; j++) {
      if (Math.abs(day[j] - day[i]) <= TIER_WINDOW_RADIUS_DAYS) window.push(j);
    }
    window.sort((a, b) => scores[b] - scores[a] || day[a] - day[b]);
    return window.indexOf(i) < TIER_TOP_PER_WINDOW ? 'expressive' : 'terse';
  });
}

// ── small prose utilities the expressive path needs ───────────────────────

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];

/** Under thirteen is spelled out, thirteen and up is digits (house style). */
function numProse(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < 13 ? ONES[n] : String(n);
}

const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const TEENS = [
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];

/**
 * A number spelled out in TITLE case ("Twenty-One"). Titles are a different
 * register from body copy: "The Day of 41 Deaths" is a log line, "Twenty-One at
 * the Benches" is a chapter heading. Falls back to digits above 99.
 */
function numTitle(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n);
  if (n < 10) return cap(ONES[n]);
  if (n < 20) return TEENS[n - 10];
  const t = TENS[Math.floor(n / 10)];
  const o = n % 10;
  return o === 0 ? t : `${t}-${cap(ONES[o])}`;
}

/**
 * Scrub a string that came from OUTSIDE this file before it reaches the page.
 *
 * Boss names, creature names, biomes, deed titles, living titles and award
 * labels are all producer-supplied (a modded client names its own killer; the
 * bot writes its own labels), and three of them would break the copy doctrine
 * on their own: an em or en dash is the loudest AI tell in the copy and is
 * banned in player-facing text, a stray brace reads as an unfilled template,
 * and runaway whitespace reads as a bug.
 */
function plainText(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One clean sentence: no doubled full stop, no dangling space. */
function sentence(s: string): string {
  const t = s.trim().replace(/\s*\.+$/, '');
  return t ? `${t}.` : '';
}

// A handful of creature names that are already their own plural in Valheim's
// own English. Everything else takes a plain "s" ("Greydwarfs", "Fulings"),
// which is how the game itself writes them.
const NO_PLURAL = new Set(['draugr', 'deer', 'moose', 'fish', 'serpent offspring']);

function pluralCreature(name: string): string {
  const low = name.toLowerCase();
  if (NO_PLURAL.has(low)) return name;
  if (low.endsWith('wolf')) {
    const tail = name.slice(-4)[0] === 'W' ? 'Wolves' : 'wolves';
    return `${name.slice(0, -4)}${tail}`;
  }
  if (/[sxz]$/i.test(name)) return name;
  return `${name}s`;
}

/** "a Fuling", "two Draugr", "three Greydwarfs". */
function countCreature(n: number, name: string): string {
  return n === 1 ? `${article(name)} ${name}` : `${numProse(n)} ${pluralCreature(name)}`;
}

/** "A", "A and B", "A, B and C" — no "and N more" tail; callers add their own. */
function andList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ── the quote filter ──────────────────────────────────────────────────────
//
// A shout is the only text on the Story page a PLAYER wrote, so the bar is
// high and the filter is deliberately mean. It rejects far more than it keeps,
// which is correct: there is exactly one quote per night and plenty of nights
// have no good one.
const URLISH = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|gg|io|dev|xyz)\b)/i;

// Emoji, dingbats and arrows. A shout is stripped of them rather than thrown
// away: "wanna do a fishing tour 🐟🐟" is a perfectly good line of the saga
// once the fish come off, and the Story page's register has no emoji in it
// anywhere else.
const PICTOGRAPHS =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu;

// A COARSE, DELIBERATELY OVER-EAGER BLOCKLIST.
//
// This is the only text on the public Story page that a player wrote, it is
// baked into a prerendered page nobody reviews, and the first real render of
// this feature put "buttplains from leroy" on a card. The list matches as a
// SUBSTRING and therefore over-rejects ("button" and "butter" are casualties
// of "butt"), which is the right way round: a rejected line costs that night
// its quote and nothing else, while an accepted one is on the internet.
// Extend it freely; it is a list, not a policy.
const UNQUOTABLE_WORDS = [
  'fuck', 'shit', 'cunt', 'nigg', 'fagg', 'whore', 'slut', 'wank', 'retard',
  'bastard', 'dildo', 'penis', 'vagina', 'boob', 'butt', 'tits', 'pussy',
  'porn', 'bollock', 'arse', 'twat', 'jizz', 'anal', 'rape', 'rapist',
  'nude', 'naked', 'sexy', 'bitch', 'damn', 'crap', 'piss',
];

/**
 * The shout as it would be quoted, or null if it is not quotable.
 *
 * Rejected: anything shorter than 12 or longer than 90 characters, anything
 * with a link in it, anything with a bracket (a `[board:kills]` sign claim is
 * a command, not speech), anything with an "@" (a ping), anything 40% or more
 * capitals (the log poller's console-echo path UPPERCASES its mirror, and a
 * shouted all-caps line is not prose either), anything with a nested quote or
 * a brace, and anything with sentence punctuation in the MIDDLE — a two-clause
 * shout would silently change the card's sentence count.
 *
 * Any em or en dash in a kept line becomes a comma, per the copy doctrine.
 */
function quotable(message: string | null | undefined): string | null {
  const collapsed = (message ?? '')
    .replace(PICTOGRAPHS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim();
  if (!collapsed) return null;
  const m = collapsed.replace(/\s*[—–]\s*/g, ', ');
  if (m.length < 12 || m.length > 90) return null;
  // At least two words: a single run-on token ("Katieisthecoolest") is a
  // handle or a joke, not a line of speech, and it reads as a bug on the card.
  if (m.split(' ').length < 2) return null;
  const low = m.toLowerCase();
  if (UNQUOTABLE_WORDS.some((w) => low.includes(w))) return null;
  if (URLISH.test(m)) return null;
  if (/[[\]{}<>"“”]/.test(m)) return null;
  if (m.includes('@')) return null;
  if (/[.!?]/.test(m.slice(0, -1))) return null;
  const letters = m.replace(/[^A-Za-z]/g, '');
  if (letters.length < 6) return null;
  const caps = m.replace(/[^A-Z]/g, '').length;
  if (caps / letters.length >= 0.4) return null;
  return m;
}

/** `"we found 6 crypts," said Yosh.` — plain text; React escapes it. */
function quoteSentence(line: EpisodeChatLine): string {
  const body = line.message.replace(/[.!?]+$/, '').trim();
  return `"${body}," said ${firstName(line.name)}.`;
}

// ── expressive pools ──────────────────────────────────────────────────────

const EXPR_OPENERS = {
  solo: [
    '{name} held the realm alone{scale}.',
    'Only {name} sailed{scale}.',
    '{name} kept the fires alone{scale}.',
  ],
  band: [
    '{names} took to the realm together{scale}.',
    '{names} gathered at the longfire{scale}.',
    '{names} shared the night{scale}.',
  ],
  crowd: [
    '{names} crowded the realm{scale}.',
    'The hall was full: {names} answered the horn{scale}.',
    'The mead-benches filled as {names} sailed{scale}.',
  ],
};

// `{who}` is `events.metadata.players`, which real boss rows carry as a COUNT
// ("13 vikings") rather than a name list — lib/events.ts renders it the same
// way. Every line here has to read with either.
const EXPR_BOSS_PARTY = [
  '{boss} fell, and {who} stood over the body.',
  '{boss} was brought down at last by {who}.',
  '{boss} met its end, and {who} drank to it.',
];

const EXPR_DEED = [
  'A great deed landed: {title}.',
  'The warband finished {title} together.',
  '{title} was achieved, and the hall knew it.',
];

const EXPR_NEWCOMER_ONE = [
  "It was {name}'s first night in the realm.",
  '{name} saw the realm for the first time.',
  'The hall met {name} for the first time.',
];

const EXPR_NEWCOMER_MANY = [
  '{names} saw the realm for the first time.',
  'The hall met {names} this night, all of them new.',
];

const EXPR_MOST_DEATHS = [
  '{name} fell {n} times, more than anyone.',
  'Nobody died harder than {name}, {n} times over.',
  '{name} walked back from the hearth {n} times.',
];

const EXPR_WATCH = [
  '{name} kept the longest watch, {n} hours by the fire.',
  '{name} stayed longest, {n} hours of it.',
  'The longest watch was {name}, {n} hours.',
];

const EXPR_NO_DEATHS = [
  'Not a drop of blood was spilled.',
  'Nobody fell, which is its own kind of luck.',
  'No one saw the inside of Valhalla.',
];

const EXPR_TALE = [
  'Someone thought it worth writing down.',
  'A tale of this night was set down afterwards.',
];

const CLOSERS_BIG = [
  'It was that kind of night.',
  'Long will the hall speak of it.',
  'The saga keeps this one whole.',
];

const CLOSERS_EXPRESSIVE = [
  'A night worth the telling.',
  'The fires burned late.',
  'It was a night with weight to it.',
];

// ── expressive clause builders ────────────────────────────────────────────

function expressiveOpener(e: EpisodeCore, seed: number): string {
  const names = e.participants.map((p) => p.name);
  const heads = names.length;
  const hours = Math.round(e.totalVikingHours);

  // The world-day span is deliberately NOT in the expressive opener: the card
  // header already prints "Days 88-91" two lines above, and a fourth comma in
  // the first sentence buys nothing.
  let scale = '';
  if (heads >= 8) {
    scale = `, ${numProse(heads)} vikings in all`;
    if (hours >= 40) scale += ` and ${numProse(hours)} hours between them`;
  } else if (hours >= 40) {
    scale = `, ${numProse(hours)} hours between them`;
  }

  const pool = heads === 1 ? EXPR_OPENERS.solo : heads <= 7 ? EXPR_OPENERS.band : EXPR_OPENERS.crowd;
  return fill(pick(pool, seed, 0), {
    name: heads ? firstName(names[0]) : 'A lone viking',
    names: nameList(names, seed),
    scale,
  });
}

/** boss kill > Great Deed > a newcomer's first night > raid > discovery. */
function expressiveHeadline(
  e: EpisodeCore,
  seed: number,
  kind: HeadlineKind
): string | null {
  switch (kind) {
    case 'boss': {
      const boss = plainText(e.bossKills[0]);
      const who = plainText(e.bossParty);
      if (who) return fill(pick(EXPR_BOSS_PARTY, seed, 1), { boss, who });
      return fill(pick(BOSS_DESC, seed, 1), { boss });
    }
    case 'deed': {
      const title = plainText(e.milestones[0].title);
      if (title) return sentence(fill(pick(EXPR_DEED, seed, 1), { title }));
      return null;
    }
    case 'newcomer':
      return newcomerSentence(e.newcomers, seed);
    case 'deaths':
      return deathGroupSentence(e.deaths) ?? deathSentence(e.deaths, seed);
    case 'discovery':
      return discoveryClause(e.discoveries, seed);
    case 'raid':
      return pick(RAID_DESC, seed, 1);
    case 'places':
      return placesClause(e.places, seed);
    case 'oaths':
      return oathsClause(e.oaths, seed);
    case 'titles':
      return titleAwardsSentence(e.titleAwards);
    default:
      return null;
  }
}

// ── "what people were doing", which is what the freed budget is for ───────

const EXPR_DISCOVERY = [
  'The warband pushed into {where}.',
  '{where} was charted for the first time.',
  'New country: {where}.',
];

/** "entered the Swamp" → "the Swamp", so a discovery names itself. */
function discoveryPlace(detail: string): string | null {
  const d = detail.toLowerCase();
  if (d.includes('trader') || d.includes('haldor')) return "the trader's camp";
  if (d.includes('crypt')) return 'a sunken crypt';
  if (d.includes('tar pit')) return 'the tar pits';
  for (const biome of BIOMES) {
    if (d.includes(biome.toLowerCase())) return `the ${biome === 'Mountains' ? 'Mountain' : biome}`;
  }
  return null;
}

function discoveryClause(discoveries: string[], seed: number): string {
  const where = discoveryPlace(plainText(discoveries[0]));
  if (!where) return pick(DISCOVERY_DESC, seed, 10);
  const rest = discoveries.length - 1;
  const base = fill(pick(EXPR_DISCOVERY, seed, 10), { where });
  if (rest <= 0) return base;
  return sentence(
    `${base.replace(/\.$/, '')}, and ${numProse(rest)} more ${rest === 1 ? 'stretch' : 'stretches'} of new country besides`
  );
}

function newcomerSentence(newcomers: string[], seed: number): string {
  if (newcomers.length === 1) {
    return fill(pick(EXPR_NEWCOMER_ONE, seed, 6), { name: firstName(newcomers[0]) });
  }
  return fill(pick(EXPR_NEWCOMER_MANY, seed, 6), { names: nameList(newcomers, seed) });
}

/**
 * "The Swamp took eleven of them; a Fuling and two Draugr did most of the work."
 *
 * Only on a night with five or more deaths, because below that the single
 * featured death (the terse renderer's job, kept here as its own beat) already
 * says everything there is to say.
 */
function deathGroupSentence(deaths: EpisodeDeath[]): string | null {
  if (deaths.length < 5) return null;
  const parts: string[] = [];

  const byBiome = new Map<string, number>();
  for (const d of deaths) {
    const bm = plainText(d.biome);
    if (bm) byBiome.set(bm, (byBiome.get(bm) ?? 0) + 1);
  }
  const topBiome = [...byBiome.entries()].sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))[0];
  if (topBiome && topBiome[1] >= 3) {
    parts.push(`the ${cap(topBiome[0])} took ${numProse(topBiome[1])} of them`);
  }

  // Creature causes only: an environmental cause gets its own beat below, and
  // "the fall did most of the work" is not a sentence anybody wants.
  const byCause = new Map<string, { n: number; label: string }>();
  for (const d of deaths) {
    const label = plainText(d.cause);
    const low = label.toLowerCase();
    if (!label || low === 'the wilds' || ENV_KEYS.has(low) || isBossCause(low)) continue;
    const cur = byCause.get(low);
    if (cur) cur.n += 1;
    else byCause.set(low, { n: 1, label });
  }
  const top = [...byCause.values()]
    .sort((a, c) => c.n - a.n || a.label.localeCompare(c.label))
    .slice(0, 2);
  if (top.length > 0) {
    parts.push(`${andList(top.map((t) => countCreature(t.n, t.label)))} did most of the work`);
  }

  if (parts.length === 0) return null;
  return sentence(cap(parts.join('; ')));
}

function mostDeathsSentence(deaths: EpisodeDeath[], seed: number): string | null {
  const byName = new Map<string, number>();
  for (const d of deaths) byName.set(d.name, (byName.get(d.name) ?? 0) + 1);
  const top = [...byName.entries()].sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))[0];
  if (!top || top[1] < 3) return null;
  return fill(pick(EXPR_MOST_DEATHS, seed, 7), { name: firstName(top[0]), n: numProse(top[1]) });
}

/**
 * The ONE death worth a sentence: a boss took them, the world did, or it
 * happened to somebody on their very first night.
 *
 * Never a count. A count is what the grouped picture is for, and the whole
 * point of the rebalance is that most nights do not get one.
 */
function notableDeathSentence(
  deaths: EpisodeDeath[],
  seed: number,
  newcomers: string[] = []
): string | null {
  const chosen = mostNotableDeath(deaths, newcomers);
  if (!chosen) return null;
  const low = chosen.cause.toLowerCase();
  const nm = firstName(chosen.name);
  if (isBossCause(low)) return `${nm} was felled by ${plainText(chosen.cause)}.`;
  const pool = lookup(ENV_DESC, low);
  if (pool) return fill(pick(pool, seed, 8), { name: nm });
  return fill(pick(CREATURE_DESC, seed, 8), {
    name: nm,
    cause: plainText(chosen.cause),
    Cause: cap(plainText(chosen.cause)),
    article: article(chosen.cause),
  });
}

/** Boss cause, then the world, then a first-timer, then the most colourful. */
function mostNotableDeath(deaths: EpisodeDeath[], newcomers: string[]): EpisodeDeath | null {
  const named = deaths.filter((d) => d.cause && d.cause.toLowerCase() !== 'the wilds');
  if (named.length === 0) return null;
  const boss = named.find((d) => isBossCause(d.cause.toLowerCase()));
  if (boss) return boss;
  const env = named.find((d) => {
    const low = d.cause.toLowerCase();
    return ENV_KEYS.has(low) && low !== 'enemyhit' && low !== 'undefined';
  });
  if (env) return env;
  const fresh = new Set(newcomers);
  const firstTimer = named.find((d) => fresh.has(d.name));
  if (firstTimer) return firstTimer;
  return featuredDeath(named);
}

function titleAwardsSentence(awards: EpisodeTitleAward[]): string | null {
  if (awards.length === 0) return null;
  const shown = awards
    .slice(0, 3)
    .map((a) => `${firstName(a.name)} took up ${plainText(a.title)}`);
  const rest = awards.length - shown.length;
  let s = andList(shown);
  if (rest > 0) s += `, and ${numProse(rest)} more ${rest === 1 ? 'title' : 'titles'} changed hands`;
  return sentence(cap(s));
}

/**
 * The Player-of-the-Day crown, which shares the titles slot and only renders
 * when no living title changed hands (otherwise the card spends two sentences
 * on two kinds of award and reads like a ceremony programme).
 */
function potySentence(awards: EpisodePotyAward[]): string | null {
  const a = awards[0];
  if (!a) return null;
  // '👑 Bane of Beasts (Boss-Slayer)' → 'Bane of Beasts'. The bot writes the
  // label for Discord, where an emoji and a parenthetical both belong.
  const label = plainText(a.label.replace(/\([^)]*\)/g, '').replace(/[^\x20-\x7E]/g, ''))
    .replace(/\s*,\s*$/, '')
    .trim();
  if (!label) return null;
  return `${firstName(a.name)} wore the day's crown as ${label}.`;
}

function watchSentence(e: EpisodeCore, seed: number): string | null {
  if (e.participants.length < 2) return null;
  const top = e.participants[0];
  if (!top || top.minutes < 240) return null;
  return fill(pick(EXPR_WATCH, seed, 9), {
    name: firstName(top.name),
    n: numProse(Math.round(top.minutes / 60)),
  });
}

function worldDaySentence(range: [number, number] | null): string | null {
  if (!range) return null;
  const [lo, hi] = range;
  return lo === hi ? `The world stood at day ${lo}.` : `The world turned from day ${lo} to day ${hi}.`;
}

// ══ THE BOSS NIGHT ════════════════════════════════════════════════════════
//
// A boss falls eight times in a season. Until 2026-10-02 the Story told each
// one in a single sentence built from an `events` row that knew the boss's
// name and how many people were there, while the `bosses` row beside it held
// the war party, a per-fighter damage ledger, the fight's length and the
// online roster at the moment it dropped. Moder's inaugural kill is the
// occasion for spending that.
//
// A boss night gets a BLOCK of five to seven sentences in place of the one
// headline line, and the night's budget widens from seven sentences to twelve
// to make room for it. Everything is seeded and deterministic exactly like the
// rest of this file, and when there is no `bosses` row (an old kill, a kill
// the ingest missed) the single original line is still what renders.

/** fold a name/boss for tolerant comparison, the same spirit as lib/slug. */
function foldish(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/[^a-z0-9]+/g, '');
}

/** 9713 → "9,713". Fixed separator, never toLocaleString: this must not move. */
function groupDigits(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function resolveBossFight(
  input: EpisodeBossFightInput,
  deaths: EpisodeDeath[],
  bossWorldDay: number | null,
  fightSeconds: Record<string, number>
): EpisodeBossFight {
  const name = plainText(input.name);
  const fs = input.fightStats ?? {};

  const damageMap = fs.damage && typeof fs.damage === 'object' ? fs.damage : {};
  const damage = Object.entries(damageMap)
    .filter(([who, amount]) => who.trim() && typeof amount === 'number' && Number.isFinite(amount) && amount > 0)
    .map(([who, amount]) => ({ name: who.trim(), amount: amount as number }))
    // Hardest first; ties by name so the order never depends on key insertion.
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

  // The war party, best known order: the damage ledger first (hardest hitters
  // lead the march), then anyone the fight listed but never credited, then
  // whoever the row merely recorded as present.
  const seen = new Set<string>();
  const fighters: string[] = [];
  const addFighter = (who: string | null | undefined) => {
    const n = (who ?? '').trim();
    if (!n || seen.has(foldish(n))) return;
    seen.add(foldish(n));
    fighters.push(n);
  };
  for (const d of damage) addFighter(d.name);
  for (const f of Array.isArray(fs.fighters) ? fs.fighters : []) addFighter(f);
  for (const p of input.playersPresent) addFighter(p);

  // The toll: who this boss killed that same night. A death names its killer
  // in `cause` and sometimes separately in `attacker`; either counts.
  const target = foldish(name);
  const toll: string[] = [];
  for (const d of deaths) {
    if (foldish(d.cause) !== target && foldish(d.attacker) !== target) continue;
    const who = firstName(d.name);
    if (!toll.includes(who)) toll.push(who);
  }

  // The fight's own number first; the warband's clocks only as a fallback.
  const ownSec = typeof fs.fightSec === 'number' && Number.isFinite(fs.fightSec) && fs.fightSec > 0 ? fs.fightSec : null;
  const clocked = Object.entries(fightSeconds).find(([boss]) => foldish(boss) === target)?.[1] ?? null;

  const online = Array.isArray(fs.onlineAtKill) ? fs.onlineAtKill.length : 0;
  const topName = typeof fs.topDamagePlayer === 'string' && fs.topDamagePlayer.trim()
    ? fs.topDamagePlayer.trim()
    : (damage[0]?.name ?? null);
  const topAmount = typeof fs.topDamage === 'number' && Number.isFinite(fs.topDamage) && fs.topDamage > 0
    ? fs.topDamage
    : (damage[0]?.amount ?? null);

  return {
    name,
    killedAt: input.killedAt,
    fighters,
    damage,
    topDamagePlayer: topName,
    topDamage: topAmount,
    onlineAtKill: online,
    fightSec: ownSec ?? (clocked && clocked > 0 ? clocked : null),
    toll,
    worldDay: bossWorldDay,
    retellingAt: input.retellingAt,
  };
}

// ── boss-night pools ──────────────────────────────────────────────────────

// A by-name epithet for the title pool's third shape. Keyed on the folded
// name so "The Elder" and "the elder" are the same forsaken.
const BOSS_EPITHETS: Record<string, string> = {
  eikthyr: 'The Horned Stag',
  theelder: 'The Ancient of the Forest',
  bonemass: 'The Reeking Mass',
  moder: "The Mountain's Dragon",
  yagluth: 'The Last of the Fallen Kings',
  thequeen: 'The Queen of the Mist',
  fader: 'The Father of the North',
};

const MARCH_LINES = [
  'A warband of {n} marched on {boss}: {names}.',
  '{names} went up against {boss}, {n} in all.',
  'The warband that went for {boss} was {n} strong: {names}.',
];

const FIGHT_LENGTH_LINES = [
  'It took {len}.',
  '{Len}, start to finish.',
  'The whole thing ran {len}.',
];

const HARDEST_ONE = [
  '{top} struck hardest, {amount} of it.',
  'Nobody hit it like {top}, {amount} of damage.',
];

const HARDEST_MANY = [
  '{top} struck hardest, {amount} of it; {rest} close behind.',
  '{top} did the most damage at {amount}, with {rest} not far back.',
];

const TOLL_LINES = [
  '{boss} took {names} down with it.',
  'It did not go quietly: {names} fell to it.',
  '{names} paid for it on the way.',
];

// None of these may say the boss went DOWN: the kill line is the very next
// sentence and "It went down without taking a viking. Bonemass fell." tells
// the same thing twice.
const NO_TOLL_LINES = [
  'It took nobody with it.',
  'Not one of them fell to it.',
  'Not a single viking was lost to it.',
];

const KILL_LINES_DAY = [
  '{boss} fell on day {day}.',
  'On day {day} it went down.',
  'Day {day} is when it dropped.',
];

const KILL_LINES = [
  '{boss} fell.',
  'And then it was down.',
  'It went down.',
];

// Same rule as MARCH_LINES: never open on a numeral.
const STANDING_LINES = [
  'There were {n} still in the realm when it dropped.',
  'Some {n} vikings were there to see it.',
  'The hall counted {n} in the realm at the end.',
];

const BOSS_DEED_LINES = [
  'A great deed landed with it: {title}.',
  'And {title} came with the kill.',
];

const BOSS_NIGHT_TITLES = [
  'The Night {boss} Fell',
  '{boss} Falls to the Warband',
  '{epithet}, Brought Down',
  '{n} Against {boss}',
  '{boss} Is Felled at Last',
];

/** "253" → "four minutes"; short fights keep their seconds. */
function fightLength(sec: number): string {
  const s = Math.round(sec);
  if (s < 90) return `${numProse(s)} seconds`;
  const m = Math.round(s / 60);
  return `${numProse(m)} ${m === 1 ? 'minute' : 'minutes'}`;
}

/**
 * The title of a night a boss fell, when the fight left a record.
 *
 * Five shapes; the two that need data the fight may not carry (an epithet for
 * this forsaken, a fighter count) drop out when it does not, so the pool never
 * renders a hole.
 */
function bossNightTitle(fight: EpisodeBossFight, seed: number): string | null {
  const boss = fight.name;
  if (!boss) return null;
  const epithet = BOSS_EPITHETS[foldish(boss)] ?? null;
  const n = fight.fighters.length;
  const shapes = BOSS_NIGHT_TITLES.filter((t) => {
    if (t.includes('{epithet}')) return Boolean(epithet);
    if (t.includes('{n}')) return n >= 2;
    return true;
  });
  return fill(pick(shapes, seed, 24), {
    boss,
    epithet: epithet ?? '',
    n: numTitle(n),
  });
}

/**
 * FIVE TO SEVEN SENTENCES about the fight, in the order a saga would tell it:
 * who marched, how long it took, who hit hardest, what it cost, that it fell,
 * who was standing there, and the deed that landed with it.
 *
 * Each clause appears only when the fight's record supports it, so a kill with
 * nothing but a name and a date still produces two or three honest sentences
 * rather than a paragraph of hedging.
 */
function bossBlock(e: EpisodeCore, fight: EpisodeBossFight, seed: number): Beat[] {
  const out: Beat[] = [];
  // Keeps run from 99 downwards so the block survives any trim ahead of every
  // ordinary beat, and so its own sentences drop from the back if they must.
  let keep = 99;
  const add = (text: string | null) => {
    if (text) out.push({ text, keep });
    keep -= 1;
  };
  const boss = fight.name;

  // 1. the march
  if (fight.fighters.length > 0) {
    const shown = fight.fighters.slice(0, 6).map(firstName);
    const rest = fight.fighters.length - shown.length;
    const names = rest > 0 ? `${shown.join(', ')} and ${numProse(rest)} more` : andList(shown);
    add(fill(pick(MARCH_LINES, seed, 25), { boss, names, n: numProse(fight.fighters.length) }));
  }

  // 2. how long it ran
  if (fight.fightSec && fight.fightSec > 0) {
    const len = fightLength(fight.fightSec);
    add(fill(pick(FIGHT_LENGTH_LINES, seed, 26), { len, Len: cap(len) }));
  }

  // 3. the hardest blows
  if (fight.topDamagePlayer && fight.topDamage) {
    const top = firstName(fight.topDamagePlayer);
    const amount = groupDigits(fight.topDamage);
    const others = fight.damage
      .filter((d) => foldish(d.name) !== foldish(fight.topDamagePlayer))
      .slice(0, 2)
      .map((d) => firstName(d.name));
    add(
      others.length > 0
        ? fill(pick(HARDEST_MANY, seed, 27), { top, amount, rest: andList(others) })
        : fill(pick(HARDEST_ONE, seed, 27), { top, amount })
    );
  }

  // 4. what it cost
  add(
    fight.toll.length > 0
      ? fill(pick(TOLL_LINES, seed, 28), { boss, names: andList(fight.toll.slice(0, 4)) })
      : pick(NO_TOLL_LINES, seed, 28)
  );

  // 5. the kill itself
  add(
    fight.worldDay !== null
      ? fill(pick(KILL_LINES_DAY, seed, 29), { boss, day: String(fight.worldDay) })
      : fill(pick(KILL_LINES, seed, 29), { boss })
  );

  // 6. who was standing there at the end
  if (fight.onlineAtKill >= 2) {
    add(fill(pick(STANDING_LINES, seed, 30), { n: numProse(fight.onlineAtKill) }));
  }

  // 7. and the deed, if one landed the same night
  const deed = e.milestones[0] ? plainText(e.milestones[0].title) : '';
  if (deed) add(sentence(fill(pick(BOSS_DEED_LINES, seed, 31), { title: deed })));

  return out;
}

// ── assembly ──────────────────────────────────────────────────────────────
//
// FOUR TO SEVEN SENTENCES, always. The closing line is one of them and is
// never dropped, so the beats before it spend between three and six sentences
// between them (a beat is usually one sentence but is not guaranteed to be:
// see beatCost). When there is more to say than there is room for, the lowest
// KEEP weight goes first: the longest watch and the colour clauses are the
// first out, the quote and the titles survive, the opener and the headline are
// never touched. When there is too little, true-but-quiet filler is added in a
// fixed order rather than anything being invented.
const MAX_BODY_SENTENCES = 6;
const MIN_BODY_SENTENCES = 3;
// A BOSS NIGHT IS WIDER, and only a boss night. The block alone is five to
// seven sentences, so an ordinary budget would spend the whole card on it and
// leave no room for the rest of the evening. Eight to twelve sentences total,
// which is the opener, the block, two or three ordinary beats and the closer.
const MAX_BOSS_BODY_SENTENCES = 11;
const MIN_BOSS_BODY_SENTENCES = 7;

interface Beat {
  text: string;
  keep: number;
}

/**
 * How many sentences a beat spends.
 *
 * NOT ALWAYS ONE. Several of the pools the expressive path borrows from the
 * terse renderer are two sentences ("{boss} met its end. Skål to the war party
 * that took its head."), and budgeting by BEAT rather than by sentence let one
 * of those push a card to eight. The reader counts sentences, so the budget
 * counts sentences.
 */
function beatCost(text: string): number {
  return (text.match(/\.(\s|$)/g) ?? []).length || 1;
}

/**
 * How much of the night's dying is worth telling.
 *
 * THE GROUPED DEATH PICTURE IS NOW RARE. It is three sentences about one
 * subject and it used to run on any night with five deaths, which on this
 * server is every night. It now runs only when the night really was about
 * dying: twenty or more deaths, or the deadliest night of its week. Otherwise
 * the night gets at most ONE death sentence, ranked low enough that a place
 * named or new country charted beats it.
 */
const DEATH_PICTURE_MIN = 20;

function describeExpressive(
  e: EpisodeCore,
  seed: number,
  score: number,
  kind: HeadlineKind
): string {
  const beats: Beat[] = [];
  const push = (text: string | null, keep: number) => {
    if (text && !beats.some((b) => b.text === text)) beats.push({ text, keep });
  };

  push(expressiveOpener(e, seed), 100);

  // A BOSS NIGHT WITH A RECORD replaces the single headline line with the
  // block. Without a `bosses` row (an old kill, or one the ingest missed) the
  // original one-liner is still exactly what renders.
  const fight = e.bossFights[0] ?? null;
  const blockBeats = fight ? bossBlock(e, fight, seed) : [];
  if (blockBeats.length > 0) {
    for (const b of blockBeats) push(b.text, b.keep);
  } else {
    push(expressiveHeadline(e, seed, kind), 95);
  }

  // A newcomer that lost the headline still gets said: it happens to each
  // viking exactly once and it is never the same fact as a boss or a deed.
  if (e.newcomers.length > 0 && kind !== 'newcomer') {
    push(newcomerSentence(e.newcomers, seed), 80);
  }

  const boss = blockBeats.length > 0;
  const picture = !boss && (kind === 'deaths' || e.deaths.length >= DEATH_PICTURE_MIN);
  if (picture) {
    if (kind !== 'deaths') push(deathGroupSentence(e.deaths), 74);
    push(mostDeathsSentence(e.deaths, seed), 50);
    push(notableDeathSentence(e.deaths, seed, e.newcomers), 56);
  } else if (!boss || (fight?.toll.length ?? 0) === 0) {
    // One sentence at most, and only if nothing better wants the room. On a
    // boss night the block's toll line has already named who the forsaken
    // took, and "Æymundr and Yunter paid for it on the way. Æymundr was felled
    // by Moder." is one death told twice.
    push(notableDeathSentence(e.deaths, seed, e.newcomers), 42);
  }

  const titles = kind === 'titles' ? null : titleAwardsSentence(e.titleAwards);
  push(titles ?? potySentence(e.potyAwards), 70);

  // WHAT PEOPLE WERE DOING. This is where the budget freed from the death
  // picture goes, and it ranks above the lone death sentence on purpose.
  if (e.places.length > 0 && kind !== 'places') push(placesClause(e.places, seed), 62);
  if (e.discoveries.length > 0 && kind !== 'discovery') push(discoveryClause(e.discoveries, seed), 58);
  if (e.raids.length > 0 && kind !== 'raid') push(pick(RAID_DESC, seed, 3), 54);
  if (e.oaths.length > 0 && kind !== 'oaths') push(oathsClause(e.oaths, seed), 52);
  if (e.tales.length > 0) push(pick(EXPR_TALE, seed, 11), 44);

  push(watchSentence(e, seed), 40);

  const quote = e.chatLines.length > 0 ? quoteSentence(pick(e.chatLines, seed, 12)) : null;
  push(quote, 72);

  // Too many: take the most valuable beats that fit the sentence budget, then
  // put them back in render order.
  const maxBody = boss ? MAX_BOSS_BODY_SENTENCES : MAX_BODY_SENTENCES;
  const minBody = boss ? MIN_BOSS_BODY_SENTENCES : MIN_BODY_SENTENCES;
  const taken: { b: Beat; i: number }[] = [];
  let spent = 0;
  for (const cand of beats.map((b, i) => ({ b, i })).sort((x, y) => y.b.keep - x.b.keep || x.i - y.i)) {
    const cost = beatCost(cand.b.text);
    if (spent + cost > maxBody) continue;
    taken.push(cand);
    spent += cost;
  }
  const kept = taken.sort((x, y) => x.i - y.i).map((r) => r.b);

  // Too few: true, quiet filler in a fixed order. Nothing here is invented —
  // a night with no deaths really had none, and the world really was on that
  // day — it is simply the least interesting true thing left to say.
  if (spent < minBody) {
    const filler: (string | null)[] = [
      e.deaths.length === 0 ? pick(EXPR_NO_DEATHS, seed, 13) : null,
      worldDaySentence(e.worldDayRange),
      pick(QUIET_DESC, seed, 14),
      pick(QUIET_DESC, seed, 15),
    ];
    for (const f of filler) {
      if (spent >= minBody) break;
      if (!f || kept.some((b) => b.text === f)) continue;
      kept.push({ text: f, keep: 10 });
      spent += beatCost(f);
    }
  }

  const closer = pick(score >= BIG_NIGHT_SCORE ? CLOSERS_BIG : CLOSERS_EXPRESSIVE, seed, 16);
  return [...kept.map((b) => b.text), closer].join(' ');
}

// ── expressive titles ─────────────────────────────────────────────────────
//
// A notable night may name its headline in the title. Everything here is still
// a pure function of the day's data plus the day's seed, and every rule that
// does not fire falls through to the ordinary titleFor ladder below.
/** The creature behind a third or more of the night's deaths, if there is one. */
function dominantCreature(deaths: EpisodeDeath[]): string | null {
  const byCause = new Map<string, { n: number; label: string }>();
  for (const d of deaths) {
    const label = plainText(d.cause);
    const low = label.toLowerCase();
    if (!label || low === 'the wilds' || ENV_KEYS.has(low) || isBossCause(low)) continue;
    const cur = byCause.get(low);
    if (cur) cur.n += 1;
    else byCause.set(low, { n: 1, label });
  }
  const top = [...byCause.values()].sort((a, c) => c.n - a.n || a.label.localeCompare(c.label))[0];
  if (!top || top.n * 3 < deaths.length) return null;
  return cap(top.label);
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
  boat: 'run down by a longship',
  self: 'undone by their own hand',
  // Valheim's catch-all HitType for damage from a creature the client couldn't
  // name (an off-screen projectile, a despawned attacker, a mod-spawned foe).
  // Without an entry here it would fall through to the creature branch and read
  // "taken by an EnemyHit", so give it an honest, unnamed-attacker phrasing.
  enemyhit: 'struck down by an unseen foe',
  edgeofworld: "sailed off the edge of the world",
  ashlandsocean: 'boiled in the Ashlands sea',
  ashlandsoceanfloor: 'boiled in the Ashlands sea',
  lava: 'swallowed by molten rock',
  // ── the remaining HitData.HitType values ──────────────────────────────────
  // Our own client plugin (source:'eilif-death') sends the HitType enum name
  // verbatim, so every one of the 22 values must resolve to a phrase here or a
  // raw token would reach the Saga. lib/deaths.ts HIT_TYPES is the decompiled
  // list; scripts/eilif-death.test.mjs walks it and fails on any gap.
  undefined: 'struck down by something nameless',
  playerhit: 'cut down by another viking',
  cart: 'run down by their own cart',
  catapult: 'smashed flat by a catapult stone',
  cinderfire: 'burned by falling cinders',
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
  const env = lookup(ENV_DEATHS, low);
  if (env) return env;
  if (BOSSES.has(low) || /^the\s/i.test(c)) return `felled by ${c}`;
  const article = /^[aeiou]/i.test(c) ? 'an' : 'a';
  // Preserve the creature's own casing (gs-ingest sends Title Case, e.g.
  // "Neck", "Greyling") — only the lookup above needs lowercasing.
  return `taken by ${article} ${c}`;
}

// A handful of ENV_DEATHS entries are already active-voice, past-tense verb
// phrases ("fell to their death", "choked on hearth-smoke"...) — they read
// fine straight after a name. The rest are passive participles ("crushed by
// a falling tree") and need a "was" to form a full sentence. Kept as its own
// small set here rather than restructuring ENV_DEATHS, since phraseDeath()'s
// existing consumers (DeathLog, EpisodeList) use its output as a bare
// fragment (after an em dash, or with the name shown elsewhere) and must
// keep working unchanged.
const ACTIVE_VOICE_CAUSES = new Set(['fall', 'falling', 'smoke', 'poison', 'poisoned', 'edgeofworld']);

/**
 * Full-sentence death line, e.g. "Testman was taken by a Neck" or
 * "Testmantwo fell to their death" — for surfaces that show name + cause
 * together as one line (home "Recent Saga", /events full chronicle). Wraps
 * phraseDeath() rather than duplicating its vocabulary.
 */
export function describeDeath(name: string, cause: string): string {
  const nm = (name ?? '').trim() || 'A viking';
  const c = (cause ?? '').trim();
  if (!c) return `${nm} has fallen`;
  const phrase = phraseDeath(c);
  const activeVoice = ACTIVE_VOICE_CAUSES.has(c.toLowerCase());
  return activeVoice ? `${nm} ${phrase}` : `${nm} was ${phrase}`;
}
