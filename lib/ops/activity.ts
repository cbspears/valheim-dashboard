// "What fired": the pure math behind /admin/ops/activity.
//
// WHY THIS FILE IS PURE. Everything here takes plain rows and returns plain
// data. No Supabase client, no 'server-only', no React. That is what lets
// activity.test.mjs run it through tsx with fabricated rows and assert on the
// answers, and it is the same split health.ts (pure, tested) and db.ts
// (server-only, untested) already use. The reads live in
// app/admin/ops/activity/data.ts and hand their rows in here.
//
// THE ONE IDEA. The pipeline writes to nine different tables and there is no
// single "what happened" log. A join lands in `events`, a title lands in
// `title_history`, a spoken line lands in `voice_lines`, a crown lands in
// `poty_history`. Answering "what happened at 21:40 last night" today means
// opening nine tables and sorting them by hand. mergeTimeline() is that sort,
// done once, with each row keeping enough of itself (its producer, its raw
// metadata) that the answer does not stop at "something happened".
//
// PRODUCER ATTRIBUTION IS DERIVED, NOT RECORDED. There is no `source` column on
// `events`. Every attribution below is inferred from the row's type and the keys
// its metadata carries, and the page says so wherever it prints one. The rules
// are written down in attributeProducer() with the evidence for each.
//
// COPY RULES INHERITED FROM THE SPEC: operator English, no em dashes, and every
// number that reaches the page carries a unit and a window. This file returns
// numbers; the components attach the windows.

import { formatDurationSec, toMs, type Bucket } from './window';

// ---------------------------------------------------------------------------
// Producers
// ---------------------------------------------------------------------------

/**
 * Who wrote a row.
 *
 * Four of these are the pipeline's three writers plus the honest fallback, which
 * is what the v2 spec names. 'watchdog' is a fifth, added because `ops_alerts`
 * is written by the /api/ops/watchdog route (pinged by GitHub Actions and, once
 * db/2026-09-06_watchdog_pgcron.sql is applied, by pg_cron) and not by the
 * poller, the ingest route or the bot. Filing it under 'unknown' would be a
 * false statement about a row whose author we know exactly.
 */
export type Producer = 'log-poller' | 'gs-ingest' | 'bot' | 'watchdog' | 'unknown';

export const PRODUCER_LABELS: Record<Producer, string> = {
  'log-poller': 'Log poller',
  'gs-ingest': 'Stats ingest',
  bot: 'Discord bot',
  watchdog: 'Watchdog route',
  unknown: 'Unattributed',
};

/** One line on what each producer is, for the page's own caption. */
export const PRODUCER_NOTES: Record<Producer, string> = {
  'log-poller':
    'services/log-poller on the host, tailing BepInEx/LogOutput.log over SFTP and posting to /api/webhook.',
  'gs-ingest':
    'The GsValheimStats emitter and the Eilif Companion client, posting to /api/gs-ingest.',
  bot: 'services/discord-bot on the host: titles, crowns, voice lines and gallery ingest.',
  watchdog: 'The /api/ops/watchdog route on Vercel, which owns the ops_alerts row.',
  unknown: 'The row shape matches none of the known writers. Worth a look.',
};

/** The shape attributeProducer() needs. Deliberately looser than the real row. */
export interface EventRowLike {
  type: string;
  character_name?: string | null;
  created_at: string;
  inserted_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Which producer wrote an `events` row, derived from its type and metadata.
 *
 * The evidence for each rule, so a future reader can check it rather than trust
 * it (all verified against production on 2026-09-06, 95 rows):
 *
 *   join / leave / raid / chat   The log poller is the only writer of these.
 *                                It parses them out of the server log and posts
 *                                them to /api/webhook, and they carry no
 *                                metadata.source at all.
 *   death, metadata.source set   'eilif' (the Companion's own death report) and
 *                                'gs' (the stats client's deathEvents[]) both
 *                                arrive through /api/gs-ingest: lib/deaths.ts
 *                                is imported only by app/api/gs-ingest/route.ts.
 *   death, no metadata.source    The poller's bare death, derived from a ZDOID
 *                                log line, which carries no cause at all.
 *   boss                         metadata.source = 'gs-milestone', written by
 *                                the boss-kill branch of gs-ingest.
 *   milestone                    Written by lib/milestones.ts, which runs inside
 *                                the gs-ingest request.
 *
 * Anything else is 'unknown' on purpose. A new producer should show up on the
 * page as unattributed rather than be quietly folded into an existing bar.
 */
export function attributeProducer(e: EventRowLike): Producer {
  const type = (e.type ?? '').toLowerCase();
  const source = readString(e.metadata, 'source');

  if (type === 'join' || type === 'leave' || type === 'raid' || type === 'chat') {
    return 'log-poller';
  }
  if (type === 'death') {
    if (source === 'eilif' || source === 'gs') return 'gs-ingest';
    return source === null ? 'log-poller' : 'unknown';
  }
  if (type === 'boss') return source === 'gs-milestone' || source === null ? 'gs-ingest' : 'unknown';
  if (type === 'milestone') return 'gs-ingest';
  return 'unknown';
}

function readString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// The merged timeline
// ---------------------------------------------------------------------------

/**
 * What kind of thing fired.
 *
 * Wider than the v2 spec's draft union by three members, each of which is a real
 * row in a real table that the timeline merges and that would otherwise be
 * flattened into 'other': `raid` (events), `alert` (ops_alerts) and `chat`
 * (events, counted only, never rendered as text).
 *
 * THERE IS NO 'gathering'. `discord_events` was merged here in the first cut,
 * keyed on `updated_at`, and that was wrong: app/api/webhook/route.ts upserts
 * EVERY scheduled event on every `events_sync` tick with `updated_at` set to the
 * tick time, whether or not anything about the event changed. Proved against
 * production on 2026-09-06: one unchanged row ("Deep North Launch Night", status
 * scheduled, user_count 9, starts_at fixed) carried three different `updated_at`
 * values inside thirteen minutes. So `updated_at` is a sync heartbeat, not a
 * moment something fired, and every row it produced here was fabricated activity
 * that then decided the producer split and the loudest hour. The next gathering
 * belongs to the horizon tab, which reads `starts_at`, a real future instant.
 */
export type FiredKind =
  | 'join'
  | 'leave'
  | 'death'
  | 'boss_kill'
  | 'raid'
  | 'chat'
  | 'voice'
  | 'deed'
  | 'title'
  | 'poty'
  | 'oath'
  | 'pin'
  | 'photo'
  | 'alert'
  | 'other';

/** Display name and grouping order for every kind. Order is the page's order. */
export const KIND_LABELS: Record<FiredKind, string> = {
  join: 'Joins',
  leave: 'Leaves',
  death: 'Deaths',
  boss_kill: 'Boss kills',
  raid: 'Raids',
  chat: 'Chat lines',
  voice: 'Voice lines',
  deed: 'Great Deeds',
  title: 'Titles',
  poty: 'Crowns',
  oath: 'Oaths',
  pin: 'Map pins',
  photo: 'Photos',
  alert: 'Watchdog',
  other: 'Other',
};

export const KIND_ORDER: FiredKind[] = [
  'join',
  'leave',
  'death',
  'boss_kill',
  'raid',
  'voice',
  'deed',
  'title',
  'poty',
  'oath',
  'pin',
  'photo',
  'alert',
  'chat',
  'other',
];

export interface FiredRow {
  /** Stable key: table prefix plus the row's own identity. Also the tie-break. */
  id: string;
  /** ISO timestamp of the moment it fired. */
  at: string;
  /** The same instant in epoch ms, so sorting never re-parses. */
  atMs: number;
  kind: FiredKind;
  /** One line, operator English: "ChÆrleif joined", "Eikthyr fell". */
  label: string;
  /** The viking it is about, or null for a world-level row. */
  who: string | null;
  producer: Producer;
  /** Optional second line: a cause, a source, a status. */
  detail?: string;
  /** The raw row behind it, rendered inside a <details> on the page. */
  raw?: Record<string, unknown> | null;
}

/** Rows as the reads hand them over. Every field is optional-tolerant on purpose. */
export interface TimelineSources {
  events?: EventRowLike[];
  voiceLines?: VoiceRowLike[];
  milestones?: MilestoneRowLike[];
  titles?: TitleRowLike[];
  poty?: PotyRowLike[];
  oaths?: OathRowLike[];
  pins?: PinRowLike[];
  photos?: PhotoRowLike[];
  alerts?: AlertRowLike[];
}

export interface VoiceRowLike {
  id?: string | null;
  kind?: string | null;
  status?: string | null;
  queued_at: string;
  spoken_at?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface MilestoneRowLike {
  id: string;
  title?: string | null;
  achieved_at?: string | null;
  announced_at?: string | null;
}

export interface TitleRowLike {
  title: string;
  awarded_at: string;
  player_id?: string | null;
  /** PostgREST resource embedding: title_history -> players. */
  players?: { character_name?: string | null } | null;
}

export interface PotyRowLike {
  character_name?: string | null;
  award_label?: string | null;
  award_category?: string | null;
  awarded_at: string;
  world_day?: number | null;
}

export interface OathRowLike {
  character_name?: string | null;
  source?: string | null;
  sworn_at: string;
  announced_at?: string | null;
  match_status?: string | null;
}

export interface PinRowLike {
  name: string;
  kind?: string | null;
  by_character_name?: string | null;
  created_at: string;
  day?: number | null;
}

export interface PhotoRowLike {
  posted_by?: string | null;
  posted_at: string;
  content_type?: string | null;
}

export interface AlertRowLike {
  key: string;
  state?: string | null;
  signature?: string | null;
  since?: string | null;
  last_alert_at?: string | null;
  alert_count?: number | null;
  updated_at?: string | null;
}

/** Map an events row to its timeline kind. */
function eventKind(type: string): FiredKind {
  switch ((type ?? '').toLowerCase()) {
    case 'join':
      return 'join';
    case 'leave':
      return 'leave';
    case 'death':
      return 'death';
    case 'boss':
      return 'boss_kill';
    case 'raid':
      return 'raid';
    case 'chat':
      return 'chat';
    case 'milestone':
      return 'deed';
    default:
      return 'other';
  }
}

function push(out: FiredRow[], row: FiredRow | null): void {
  if (row && Number.isFinite(row.atMs)) out.push(row);
}

function at(iso: string | null | undefined): number | null {
  return toMs(iso);
}

/**
 * Merge every source table into one newest-first list.
 *
 * Sorting is by instant, then by id, so two rows written in the same
 * millisecond keep the same order on every render. A page that reshuffles
 * between refreshes is a page an operator stops trusting.
 *
 * Nothing is windowed here. The caller has already bounded every read, and the
 * page filters the merged list per window so the 24 h and 7 d views are one
 * fetch and two slices rather than two fetches.
 */
export function mergeTimeline(sources: TimelineSources): FiredRow[] {
  const out: FiredRow[] = [];

  for (const [i, e] of (sources.events ?? []).entries()) {
    const ms = at(e.created_at);
    if (ms === null) continue;
    const kind = eventKind(e.type);
    const who = e.character_name ?? null;
    const meta = e.metadata ?? null;
    push(out, {
      id: `event:${e.created_at}:${e.type}:${who ?? ''}:${i}`,
      at: e.created_at,
      atMs: ms,
      kind,
      label: eventLabel(kind, e),
      who,
      producer: attributeProducer(e),
      detail: eventDetail(kind, e) ?? undefined,
      raw: meta,
    });
  }

  for (const [i, v] of (sources.voiceLines ?? []).entries()) {
    // A voice line has two moments. The one that "fired" is when it was spoken;
    // a line still sitting in the queue fired nothing yet, so it enters the
    // timeline at its queue time and says so.
    const spokenMs = at(v.spoken_at);
    const queuedMs = at(v.queued_at);
    const ms = spokenMs ?? queuedMs;
    if (ms === null) continue;
    const source = readString(v.meta, 'source');
    const status = (v.status ?? 'queued').toLowerCase();
    const waited = spokenMs !== null && queuedMs !== null ? Math.max(0, (spokenMs - queuedMs) / 1000) : null;
    push(out, {
      id: `voice:${v.id ?? `${v.queued_at}:${i}`}`,
      at: (spokenMs !== null ? v.spoken_at : v.queued_at) as string,
      atMs: ms,
      kind: 'voice',
      label:
        status === 'spoken'
          ? `Eilif spoke a ${source ?? v.kind ?? 'voice'} line`
          : `A ${source ?? v.kind ?? 'voice'} line is ${status} and has not been spoken`,
      who: null,
      producer: 'bot',
      detail: [
        v.kind ? `kind ${v.kind}` : null,
        source ? `source ${source}` : null,
        waited !== null ? `waited ${formatDurationSec(waited)} in the queue` : null,
      ]
        .filter(Boolean)
        .join(', ') || undefined,
      raw: v.meta ?? null,
    });
  }

  for (const m of sources.milestones ?? []) {
    // Two separate moments, two separate rows: a deed can be achieved hours
    // before anyone hears about it, and collapsing them would hide exactly that.
    const achieved = at(m.achieved_at);
    if (achieved !== null) {
      push(out, {
        id: `deed-achieved:${m.id}`,
        at: m.achieved_at as string,
        atMs: achieved,
        kind: 'deed',
        label: `Great Deed achieved: ${m.title ?? m.id}`,
        who: null,
        producer: 'gs-ingest',
        detail: m.announced_at ? undefined : 'not announced yet',
        raw: { id: m.id, achieved_at: m.achieved_at, announced_at: m.announced_at },
      });
    }
    const announced = at(m.announced_at);
    if (announced !== null) {
      push(out, {
        id: `deed-announced:${m.id}`,
        at: m.announced_at as string,
        atMs: announced,
        kind: 'deed',
        label: `Great Deed announced: ${m.title ?? m.id}`,
        who: null,
        producer: 'bot',
        detail:
          achieved !== null
            ? `${formatDurationSec(Math.max(0, (announced - achieved) / 1000))} after it was achieved`
            : undefined,
        raw: { id: m.id, achieved_at: m.achieved_at, announced_at: m.announced_at },
      });
    }
  }

  for (const [i, t] of (sources.titles ?? []).entries()) {
    const ms = at(t.awarded_at);
    if (ms === null) continue;
    const who = t.players?.character_name ?? null;
    push(out, {
      id: `title:${t.awarded_at}:${t.title}:${i}`,
      at: t.awarded_at,
      atMs: ms,
      kind: 'title',
      label: who ? `${who} became "${t.title}"` : `Title awarded: "${t.title}"`,
      who,
      producer: 'bot',
      detail: who ? undefined : 'the players row behind this title could not be read',
      raw: { title: t.title, player_id: t.player_id ?? null },
    });
  }

  for (const [i, p] of (sources.poty ?? []).entries()) {
    const ms = at(p.awarded_at);
    if (ms === null) continue;
    push(out, {
      id: `poty:${p.awarded_at}:${p.character_name ?? ''}:${i}`,
      at: p.awarded_at,
      atMs: ms,
      kind: 'poty',
      label: `${p.character_name ?? 'Someone'} was crowned ${p.award_label ?? 'player of the day'}`,
      who: p.character_name ?? null,
      producer: 'bot',
      detail: p.world_day != null ? `world day ${p.world_day}` : undefined,
      raw: { award_category: p.award_category ?? null, world_day: p.world_day ?? null },
    });
  }

  for (const [i, o] of (sources.oaths ?? []).entries()) {
    const ms = at(o.sworn_at);
    if (ms === null) continue;
    const announced = at(o.announced_at);
    push(out, {
      id: `oath:${o.sworn_at}:${o.character_name ?? ''}:${i}`,
      at: o.sworn_at,
      atMs: ms,
      kind: 'oath',
      label: `${o.character_name ?? 'Someone'} swore an oath`,
      who: o.character_name ?? null,
      // An in-game oath is captured by the poller from the shout echo; a Discord
      // oath is written by the bot. The `source` column records which.
      producer: (o.source ?? '').toLowerCase() === 'discord' ? 'bot' : 'log-poller',
      detail: [
        o.source ? `via ${o.source}` : null,
        o.match_status ? `match ${o.match_status}` : null,
        announced === null ? 'not announced yet' : null,
      ]
        .filter(Boolean)
        .join(', ') || undefined,
      // The oath text itself is player-written and belongs on the public site,
      // not in an ops feed. Only the metadata about it is carried here.
      raw: { source: o.source ?? null, match_status: o.match_status ?? null, announced_at: o.announced_at ?? null },
    });
  }

  for (const [i, p] of (sources.pins ?? []).entries()) {
    const ms = at(p.created_at);
    if (ms === null) continue;
    push(out, {
      id: `pin:${p.created_at}:${i}`,
      at: p.created_at,
      atMs: ms,
      kind: 'pin',
      label: `${p.by_character_name ?? 'Someone'} pinned "${p.name}"`,
      who: p.by_character_name ?? null,
      producer: 'log-poller',
      detail: [p.kind ? `${p.kind} pin` : null, p.day != null ? `world day ${p.day}` : null]
        .filter(Boolean)
        .join(', ') || undefined,
      // Coordinates are deliberately not carried: this is an ops feed, and the
      // map page is where a pin's position belongs.
      raw: { kind: p.kind ?? null, day: p.day ?? null },
    });
  }

  for (const [i, p] of (sources.photos ?? []).entries()) {
    const ms = at(p.posted_at);
    if (ms === null) continue;
    push(out, {
      id: `photo:${p.posted_at}:${i}`,
      at: p.posted_at,
      atMs: ms,
      kind: 'photo',
      label: `${p.posted_by ?? 'Someone'} posted a photo to the gallery`,
      who: p.posted_by ?? null,
      producer: 'bot',
      detail: p.content_type ?? undefined,
      raw: { content_type: p.content_type ?? null },
    });
  }

  // NO `bosses` LOOP, AND THAT IS THE FIX FOR A DOUBLE COUNT. A boss kill is
  // written twice in one request by app/api/gs-ingest/route.ts: it flips
  // `bosses.killed_at = killedAt` and then inserts an `events` row of type
  // 'boss' with `created_at = killedAt`, the same variable. Merging both tables
  // put two "Eikthyr fell" rows on the timeline at the identical instant, and
  // that double fed the rows-fired ribbon, the boss_kill kind count and the
  // volume chart. Proved against production on 2026-09-06: the one boss kill in
  // the database carries created_at 2026-08-28T03:49:34.419+00:00 in `events`
  // and killed_at 2026-08-28T03:49:34.419+00:00 in `bosses`, to the millisecond.
  // The `events` row is the one kept: it is inside the window the page already
  // bounds, and it carries the war-party size the `bosses` row does not.

  for (const a of sources.alerts ?? []) {
    // ops_alerts has ONE row per key, upserted. There is no alert history table,
    // so the only two instants it can contribute are the start of the current
    // episode and the last message actually posted. The page says so.
    const since = at(a.since);
    if (since !== null) {
      push(out, {
        id: `alert-since:${a.key}:${a.since}`,
        at: a.since as string,
        atMs: since,
        kind: 'alert',
        label:
          (a.state ?? '').toLowerCase() === 'alerting'
            ? `Watchdog started alerting: ${a.signature ?? 'no signature recorded'}`
            : 'Watchdog returned to ok',
        who: null,
        producer: 'watchdog',
        detail: 'current episode, from the single ops_alerts row',
        raw: { key: a.key, state: a.state ?? null, signature: a.signature ?? null, alert_count: a.alert_count ?? null },
      });
    }
    const lastAlert = at(a.last_alert_at);
    if (lastAlert !== null && lastAlert !== since) {
      push(out, {
        id: `alert-last:${a.key}:${a.last_alert_at}`,
        at: a.last_alert_at as string,
        atMs: lastAlert,
        kind: 'alert',
        label: `Watchdog posted its most recent message (${a.alert_count ?? 0} this episode)`,
        who: null,
        producer: 'watchdog',
        detail: a.signature ?? undefined,
        raw: { key: a.key, alert_count: a.alert_count ?? null },
      });
    }
  }

  out.sort((a, b) => (b.atMs - a.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function eventLabel(kind: FiredKind, e: EventRowLike): string {
  const who = e.character_name ?? 'Someone';
  switch (kind) {
    case 'join':
      return `${who} joined`;
    case 'leave':
      return `${who} left`;
    case 'death': {
      const cause = readString(e.metadata, 'cause');
      return cause ? `${who} died: ${cause}` : `${who} died`;
    }
    case 'boss_kill': {
      const boss = readString(e.metadata, 'boss');
      return boss ? `${boss} fell` : 'A boss fell';
    }
    case 'raid': {
      const ev = readString(e.metadata, 'event');
      return ev ? `Raid: ${ev}` : 'A raid began';
    }
    case 'chat':
      // Chat is counted, never rendered. Inherited rule, not negotiable.
      return `${who} spoke in chat (text is never shown here)`;
    case 'deed': {
      const title = readString(e.metadata, 'title');
      return title ? `Great Deed fired: ${title}` : 'A Great Deed fired';
    }
    default:
      return `${e.type} event`;
  }
}

/**
 * The death row's second line.
 *
 * KEYED ON `cause`, NOT ON `causeSource`, and the difference is the commonest
 * launch-night row. lib/deaths.ts writes `causeSource` only on the Eilif
 * Companion path (line 239 and the eilifCausePatch); the GsValheimStats path
 * sets `cause` from humanizeKiller() and never sets `causeSource`. So a viking
 * running the stats emitter WITHOUT the Companion plugin, which is the normal
 * case, produced a row whose headline read "Ylva died: Greydwarf" over a
 * subtitle reading "no cause recorded, the log line carries none": the subtitle
 * contradicted the headline and blamed the poller for a row the stats ingest
 * wrote. Three states now, and each one says the true thing:
 *
 *   cause + causeSource   the Companion stamped it, and it is named.
 *   cause, no causeSource   the row's own writer recorded it (metadata.source).
 *   no cause                really nothing, which for a poller row is expected.
 */
function eventDetail(kind: FiredKind, e: EventRowLike): string | null {
  if (kind === 'death') {
    const cause = readString(e.metadata, 'cause');
    const causeSource = readString(e.metadata, 'causeSource');
    const source = readString(e.metadata, 'source');
    let note: string;
    if (cause && causeSource) note = `cause reported by ${causeSource}`;
    else if (cause && source) note = `cause recorded by ${source}, not confirmed by the Companion`;
    else if (cause) note = 'cause recorded, no reporter named on the row';
    else if (source) note = `no cause recorded, though ${source} wrote the row`;
    else note = 'no cause recorded, the poller log line carries none';
    return [readString(e.metadata, 'biome'), note].filter(Boolean).join(', ') || null;
  }
  if (kind === 'boss_kill') return readString(e.metadata, 'players');
  return null;
}

// ---------------------------------------------------------------------------
// Counting and comparing
// ---------------------------------------------------------------------------

/**
 * Count `events` rows per type.
 *
 * `types`, when given, fixes the key set: every listed type appears in the
 * result even at zero, which is what keeps a table from silently losing its
 * "deaths" row on a night with no deaths. Types not listed are dropped.
 */
export function countByType(rows: EventRowLike[], types?: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (types) for (const t of types) out[t] = 0;
  for (const r of rows) {
    const t = (r.type ?? '').toLowerCase();
    if (!t) continue;
    if (types && !(t in out)) continue;
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

export interface TypeDelta {
  type: string;
  /** Count in the short window (24 h by convention). */
  recent: number;
  /** Count in the long window (7 d by convention). */
  baseline: number;
  /** The long window's count divided by its length in days. */
  baselinePerDay: number;
  /** recent minus baselinePerDay, rounded to one decimal. */
  delta: number;
  /**
   * recent / baselinePerDay, or null when the baseline is zero. Null, never
   * Infinity: "the first death in a week" is a fact, not a ratio.
   */
  ratio: number | null;
}

/**
 * Put a short window's per-type counts next to a long window's daily average.
 *
 * Both windows are counted over the same table, so this is the "deaths are
 * double last week's" sentence, computed. `baselineDays` is how many days the
 * `baseline` counts span, which is the only way a 7 d total can be compared with
 * a 24 h one at all.
 *
 * Sorted by the size of the move, so the type that changed most is first.
 */
export function compareWindows(
  recent: Record<string, number>,
  baseline: Record<string, number>,
  baselineDays: number = 7,
): TypeDelta[] {
  const days = baselineDays > 0 ? baselineDays : 1;
  const keys = [...new Set([...Object.keys(recent), ...Object.keys(baseline)])].sort();
  return keys
    .map((type) => {
      const r = recent[type] ?? 0;
      const b = baseline[type] ?? 0;
      const perDay = b / days;
      return {
        type,
        recent: r,
        baseline: b,
        baselinePerDay: Math.round(perDay * 10) / 10,
        delta: Math.round((r - perDay) * 10) / 10,
        ratio: perDay > 0 ? Math.round((r / perDay) * 100) / 100 : null,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.type.localeCompare(b.type));
}

/** Count FiredRows per kind, in KIND_ORDER, dropping kinds with no rows. */
export function countsByKind(rows: FiredRow[]): { kind: FiredKind; label: string; count: number }[] {
  const counts = new Map<FiredKind, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return KIND_ORDER.filter((k) => (counts.get(k) ?? 0) > 0).map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    count: counts.get(kind) ?? 0,
  }));
}

export interface ProducerShare {
  producer: Producer;
  label: string;
  count: number;
  /** Share of the total, 0 to 1. Zero when there are no rows at all. */
  share: number;
}

/**
 * How the window's rows split across the writers.
 *
 * Every producer with at least one row is listed, largest first, with 'unknown'
 * pinned last so an unattributed tail never displaces a real writer from the
 * top of the list.
 */
export function producerSplit(rows: FiredRow[]): ProducerShare[] {
  const counts = new Map<Producer, number>();
  for (const r of rows) counts.set(r.producer, (counts.get(r.producer) ?? 0) + 1);
  const total = rows.length;
  return [...counts.entries()]
    .map(([producer, count]) => ({
      producer,
      label: PRODUCER_LABELS[producer],
      count,
      share: total > 0 ? count / total : 0,
    }))
    .sort((a, b) => {
      if (a.producer === 'unknown') return 1;
      if (b.producer === 'unknown') return -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}

/**
 * The fullest bucket in a series, named.
 *
 * Ties go to the LATEST bucket, because "the loudest hour" on an ops page means
 * the most recent time it was that loud, not the first time it ever was. Returns
 * null when no eligible bucket has a row: there is no loudest hour in a silent
 * day, and printing "00:00, 0 rows" would invent one.
 *
 * `excludePartial` DROPS THE LAST BUCKET, and the page passes it. hourBuckets()
 * and dayBuckets() both end on the current, incomplete bucket, which the chart
 * draws muted precisely so nobody compares it with the full ones. Crowning that
 * same bucket "the loudest hour" a line below the muting contradicted the
 * caption: at 14:53 UTC the 14:00 bar was drawn muted and the readout beside it
 * still called it the loudest hour, on 53 minutes of data against 24 full ones.
 * A partial bucket can be the busiest so far and still not be the busiest hour.
 */
export function loudestBucket(
  counts: number[],
  buckets: Bucket[],
  opts: { excludePartial?: boolean } = {},
): { index: number; label: string; count: number; startMs: number; endMs: number } | null {
  const last = Math.min(counts.length, buckets.length);
  const end = opts.excludePartial ? last - 1 : last;
  let best = -1;
  for (let i = 0; i < end; i++) {
    if (counts[i] > 0 && (best < 0 || counts[i] >= counts[best])) best = i;
  }
  if (best < 0) return null;
  return {
    index: best,
    label: buckets[best].label,
    count: counts[best],
    startMs: buckets[best].startMs,
    endMs: buckets[best].endMs,
  };
}

// ---------------------------------------------------------------------------
// Deaths
// ---------------------------------------------------------------------------

/**
 * Death counts per cause, largest first.
 *
 * A death row with no `cause` is real and common (the poller derives deaths from
 * a ZDOID log line that carries no cause at all), so it is counted under an
 * explicit "cause not recorded" rather than dropped. Dropping it would make the
 * causes add up to less than the death count, which is the kind of quiet
 * subtraction that costs an operator an hour.
 */
export function deathCauses(rows: EventRowLike[]): { cause: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if ((r.type ?? '').toLowerCase() !== 'death') continue;
    const cause = readString(r.metadata, 'cause') ?? 'cause not recorded';
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
}

/** Deaths per viking in the window, largest first. Unnamed rows are grouped. */
export function deathsByViking(rows: EventRowLike[]): { who: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if ((r.type ?? '').toLowerCase() !== 'death') continue;
    const who = r.character_name?.trim() || 'unnamed';
    counts.set(who, (counts.get(who) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([who, count]) => ({ who, count }))
    .sort((a, b) => b.count - a.count || a.who.localeCompare(b.who));
}

// ---------------------------------------------------------------------------
// Silence
// ---------------------------------------------------------------------------

export interface QuietGap {
  startMs: number;
  endMs: number;
  sec: number;
  /** True when the gap is still running: nothing has fired since startMs. */
  open: boolean;
}

/**
 * The longest stretch inside the window with no row at all.
 *
 * The window's own edges are boundaries, which is what makes the two edge cases
 * behave:
 *
 *   • No rows at all: the whole window is the gap. That is the correct answer,
 *     not null, and it is exactly the shape of an outage nobody noticed.
 *   • The last row is old: the gap runs to `nowMs` and comes back `open: true`,
 *     so the page can say "and it is still quiet" rather than printing a closed
 *     interval that ends in the past.
 *
 * Null only when the window is empty or inverted, which is a caller bug rather
 * than a fact about the data.
 */
export function longestQuietGap(
  timestamps: (string | number | Date | null | undefined)[],
  windowStartMs: number,
  nowMs: number,
): QuietGap | null {
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(nowMs) || nowMs <= windowStartMs) return null;
  const inWindow = timestamps
    .map((t) => toMs(t))
    .filter((t): t is number => t !== null && t >= windowStartMs && t <= nowMs)
    .sort((a, b) => a - b);

  let bestStart = windowStartMs;
  let bestEnd = windowStartMs;
  let prev = windowStartMs;
  for (const t of [...inWindow, nowMs]) {
    if (t - prev > bestEnd - bestStart) {
      bestStart = prev;
      bestEnd = t;
    }
    prev = Math.max(prev, t);
  }
  return {
    startMs: bestStart,
    endMs: bestEnd,
    sec: (bestEnd - bestStart) / 1000,
    open: bestEnd === nowMs,
  };
}

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface SessionRowLike {
  character_name?: string | null;
  joined_at: string;
  left_at?: string | null;
  duration_minutes?: number | null;
}

/** Merge overlapping intervals into the smallest set covering the same time. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, iv.endMs);
    } else {
      out.push({ startMs: iv.startMs, endMs: iv.endMs });
    }
  }
  return out;
}

/**
 * The stretches inside the window when at least one viking was connected,
 * derived from `sessions` and clipped to the window.
 *
 * An open session (left_at null) runs to `nowMs`, which is the whole point of
 * reading sessions rather than pairing join and leave events: a viking who is
 * online right now has no leave row to pair with.
 */
export function onlineIntervals(
  sessions: SessionRowLike[],
  windowStartMs: number,
  nowMs: number,
): Interval[] {
  const raw: Interval[] = [];
  for (const s of sessions) {
    const start = toMs(s.joined_at);
    if (start === null) continue;
    const end = toMs(s.left_at) ?? nowMs;
    const clippedStart = Math.max(start, windowStartMs);
    const clippedEnd = Math.min(end, nowMs);
    if (clippedEnd > clippedStart) raw.push({ startMs: clippedStart, endMs: clippedEnd });
  }
  return mergeIntervals(raw);
}

export interface Silence extends QuietGap {
  /** The online stretch the silence sits inside. */
  duringStartMs: number;
  duringEndMs: number;
  /** How long that whole online stretch ran, in seconds. */
  stretchSec: number;
  /**
   * True when the silence IS the whole online stretch: nothing at all was
   * written between one end of it and the other.
   *
   * This is the flag that keeps the panel honest, and it is normally true. A
   * session's own join row sits exactly at the stretch's start and its leave row
   * exactly at the end, so a viking who plays quietly, and `events` only records
   * join, leave, death, boss, raid and chat, produces one interior gap the exact
   * length of the session. Reading that as "a producer stopped writing" is a
   * false alarm, and it fired on real production data: Loa's ordinary 2 h 35 m
   * solo session on Aug 30 was rendered in the danger tone with remediation copy
   * while every producer was healthy. The number is worth showing; the alarm was
   * not, and the caller uses this flag to say which one it is looking at.
   */
  wholeStretch: boolean;
}

/**
 * The longest stretch with nobody heard from WHILE somebody was online.
 *
 * DESCRIPTIVE, NOT DIAGNOSTIC, and the distinction is the whole of this
 * function's honesty. The plain quiet gap cannot separate "the hall was empty"
 * from "the hall was full and nothing was written", and this can. What it still
 * cannot do is tell quiet play from a broken producer, because `events` only
 * records join, leave, death, boss, raid and chat: a viking mining for two hours
 * writes exactly nothing, and the interior gap comes back as the whole session.
 * See `wholeStretch` on the return type, which is what the caller reads to say
 * which of the two it is looking at rather than banding the raw number.
 *
 * Each online stretch is scored on its own, with the stretch's own edges as
 * boundaries, and the longest silence across all of them wins. Returns null when
 * nobody was online in the window, which the page renders as "nobody was on"
 * rather than as a clean bill of health.
 */
export function longestSilenceWhileOnline(
  timestamps: (string | number | Date | null | undefined)[],
  intervals: Interval[],
  nowMs?: number,
): Silence | null {
  if (intervals.length === 0) return null;
  const stamps = timestamps
    .map((t) => toMs(t))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);

  let best: Silence | null = null;
  for (const iv of intervals) {
    const inside = stamps.filter((t) => t >= iv.startMs && t <= iv.endMs);
    let prev = iv.startMs;
    for (const t of [...inside, iv.endMs]) {
      const sec = (t - prev) / 1000;
      if (!best || sec > best.sec) {
        best = {
          startMs: prev,
          endMs: t,
          sec,
          open: nowMs !== undefined && t >= nowMs,
          duringStartMs: iv.startMs,
          duringEndMs: iv.endMs,
          stretchSec: (iv.endMs - iv.startMs) / 1000,
          wholeStretch: prev <= iv.startMs && t >= iv.endMs,
        };
      }
      prev = Math.max(prev, t);
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export interface VoiceSummary {
  total: number;
  /** Counts keyed by `status` exactly as the table spells it. */
  byStatus: { status: string; count: number }[];
  /** Counts keyed by `kind` (ambient, event, manual). */
  byKind: { kind: string; count: number }[];
  /** Counts keyed by `meta.source` (dawn, milestone, poty, oath, manual). */
  bySource: { source: string; count: number }[];
  /** Lines with a spoken_at, and the median and p90 wait in seconds. */
  spoken: number;
  waitMedianSec: number | null;
  waitP90Sec: number | null;
  /** Still queued, and the age in seconds of the oldest one. */
  queued: number;
  oldestQueuedSec: number | null;
}

/**
 * The state of the hall's voice over a window.
 *
 * Statuses are reported by their own name rather than mapped onto a fixed
 * enum: the table today writes 'queued' and 'spoken', and a status this code has
 * never seen should appear on the page as itself, not be silently folded into
 * "other". `nowMs` is only used for the oldest queued age.
 */
export function voiceBreakdown(lines: VoiceRowLike[], nowMs: number = Date.now()): VoiceSummary {
  const byStatus = new Map<string, number>();
  const byKind = new Map<string, number>();
  const bySource = new Map<string, number>();
  const waits: number[] = [];
  let spoken = 0;
  let queued = 0;
  let oldestQueuedMs: number | null = null;

  for (const l of lines) {
    const status = (l.status ?? 'unknown').toLowerCase();
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    const kind = (l.kind ?? 'unknown').toLowerCase();
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const source = readString(l.meta, 'source') ?? 'unlabelled';
    bySource.set(source, (bySource.get(source) ?? 0) + 1);

    const q = toMs(l.queued_at);
    const s = toMs(l.spoken_at);
    if (s !== null) {
      spoken += 1;
      if (q !== null) waits.push(Math.max(0, (s - q) / 1000));
    } else {
      queued += 1;
      if (q !== null && (oldestQueuedMs === null || q < oldestQueuedMs)) oldestQueuedMs = q;
    }
  }

  const sortedWaits = [...waits].sort((a, b) => a - b);
  const pick = (p: number): number | null => {
    if (sortedWaits.length === 0) return null;
    const pos = (sortedWaits.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sortedWaits[lo] : sortedWaits[lo] + (sortedWaits[hi] - sortedWaits[lo]) * (pos - lo);
  };

  const entries = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return {
    total: lines.length,
    byStatus: entries(byStatus).map(([status, count]) => ({ status, count })),
    byKind: entries(byKind).map(([kind, count]) => ({ kind, count })),
    bySource: entries(bySource).map(([source, count]) => ({ source, count })),
    spoken,
    waitMedianSec: pick(0.5),
    waitP90Sec: pick(0.9),
    queued,
    oldestQueuedSec: oldestQueuedMs === null ? null : Math.max(0, (nowMs - oldestQueuedMs) / 1000),
  };
}

export interface QueueBacklog {
  /** Every fetched line with no spoken_at, whatever its age. */
  waiting: number;
  /** How many of those were queued before the window the page is showing. */
  olderThanWindow: number;
  /** The oldest one, or null when nothing is waiting. */
  oldest: {
    ageSec: number;
    kind: string;
    source: string;
    queuedAt: string;
    beforeWindow: boolean;
  } | null;
}

/**
 * The whole unspoken queue, deliberately NOT windowed.
 *
 * WHY THIS IS SEPARATE FROM voiceBreakdown(). The breakdown answers "what did
 * the voice do in the last 24 h / 7 d", so it is windowed and must stay
 * windowed. The queue answers "is anything stuck", and a line stuck for nine
 * days is more stuck than one stuck for six, not less. Reading the oldest
 * waiting line out of a 7 d slice put a floor under the very number the panel
 * exists to raise: the in-game plugin only polls while a player is connected, so
 * a line queued during a week nobody played is exactly the row that goes stale,
 * and it was the one row the panel could not see. `oaths` already solves this
 * with an .or() and `milestones` by not windowing at all; this is the same fix
 * in the third place that needed it.
 *
 * Pass every line the read returned, in and out of window. `windowStartMs` only
 * decides the `beforeWindow` label, never what is counted.
 */
export function queueBacklog(
  lines: VoiceRowLike[],
  nowMs: number,
  windowStartMs: number,
): QueueBacklog {
  let waiting = 0;
  let olderThanWindow = 0;
  let best: { ms: number; line: VoiceRowLike } | null = null;

  for (const l of lines) {
    if (toMs(l.spoken_at) !== null) continue;
    waiting += 1;
    const q = toMs(l.queued_at);
    if (q === null) continue;
    if (q < windowStartMs) olderThanWindow += 1;
    if (best === null || q < best.ms) best = { ms: q, line: l };
  }

  return {
    waiting,
    olderThanWindow,
    oldest:
      best === null
        ? null
        : {
            ageSec: Math.max(0, (nowMs - best.ms) / 1000),
            kind: (best.line.kind ?? 'unknown').toLowerCase(),
            source: readString(best.line.meta, 'source') ?? 'unlabelled',
            queuedAt: best.line.queued_at,
            beforeWindow: best.ms < windowStartMs,
          },
  };
}

// ---------------------------------------------------------------------------
// Fired but never announced
// ---------------------------------------------------------------------------

export interface UnannouncedItem {
  id: string;
  /** What fired, in operator English. */
  what: string;
  /** Which table it is in, so the fix has an address. */
  table: string;
  /** When it fired. */
  at: string;
  ageSec: number;
}

/**
 * Things that happened in the data and that nobody was told about.
 *
 * A deed achieved at 21:00 whose announced_at is still null at 23:00 means the
 * bot's announce loop is not running, and NOTHING else on the cockpit shows it:
 * the bot's own heartbeat is green because the loop that ticks is not the loop
 * that failed. Oldest first, because the oldest one is the one that proves how
 * long it has been broken.
 */
export function unannouncedItems(
  input: { milestones?: MilestoneRowLike[]; oaths?: OathRowLike[] },
  nowMs: number,
): UnannouncedItem[] {
  const out: UnannouncedItem[] = [];
  for (const m of input.milestones ?? []) {
    const achieved = toMs(m.achieved_at);
    if (achieved === null || m.announced_at) continue;
    out.push({
      id: `milestone:${m.id}`,
      what: `Great Deed "${m.title ?? m.id}" was achieved and never announced`,
      table: 'milestones',
      at: m.achieved_at as string,
      ageSec: Math.max(0, (nowMs - achieved) / 1000),
    });
  }
  for (const [i, o] of (input.oaths ?? []).entries()) {
    const sworn = toMs(o.sworn_at);
    if (sworn === null || o.announced_at) continue;
    out.push({
      id: `oath:${o.sworn_at}:${i}`,
      what: `${o.character_name ?? 'Someone'} swore an oath that was never announced`,
      table: 'oaths',
      at: o.sworn_at,
      ageSec: Math.max(0, (nowMs - sworn) / 1000),
    });
  }
  return out.sort((a, b) => b.ageSec - a.ageSec);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Slice the merged timeline to a window and, optionally, one kind.
 *
 * `limit` is applied last and is the page's render cap, not a data bound: the
 * counts above the feed are computed over the whole window, so a truncated feed
 * never makes the totals beside it wrong.
 */
export function filterTimeline(
  rows: FiredRow[],
  opts: { sinceMs: number; nowMs?: number; kind?: FiredKind | 'all'; limit?: number },
): FiredRow[] {
  const until = opts.nowMs ?? Number.POSITIVE_INFINITY;
  const kind = opts.kind && opts.kind !== 'all' ? opts.kind : null;
  const filtered = rows.filter(
    (r) => r.atMs >= opts.sinceMs && r.atMs <= until && (kind === null || r.kind === kind),
  );
  return opts.limit != null ? filtered.slice(0, opts.limit) : filtered;
}

/** True when `value` is a FiredKind. Used to validate a searchParams filter. */
export function isFiredKind(value: unknown): value is FiredKind {
  return typeof value === 'string' && (KIND_ORDER as string[]).includes(value);
}
