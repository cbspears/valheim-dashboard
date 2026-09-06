// The reads behind /admin/ops/activity. Server only, service role, GET only.
//
// WHY THE READS LIVE HERE AND THE MATH LIVES IN lib/ops/activity.ts. This module
// imports lib/ops/client.ts, which imports 'server-only', which throws the moment
// it is loaded anywhere but a React Server Component (including under tsx). So
// nothing in here can be unit-tested, and that is fine, because nothing in here
// decides anything: it fetches rows and hands them to pure functions that are
// tested. Keep it that way. A calculation that creeps into this file is a
// calculation that loses its test.
//
// ONE FETCH, TWO WINDOWS. Every read below is bounded to 7 days, and the page
// slices the 24 h view out of the same rows in memory. Fetching twice would
// double the round trips to answer a question the first fetch already contains.
//
// ONE Promise.all. Ten reads issued together cost one round trip of latency, not
// ten. Measured against production on 2026-09-06 with 0 players online: 161 ms
// to 444 ms for the whole block when it was twelve reads.
//
// TWO READS WERE REMOVED AFTER REVIEW, and both removals fixed a defect rather
// than only buying budget:
//   discord_events  its `updated_at` is rewritten by every events_sync tick
//                   whether or not the event changed, so merging it invented
//                   activity. The next gathering is the horizon tab's panel.
//   bosses          `bosses.killed_at` and the `events` type='boss' row are
//                   written from the same variable in the same gs-ingest
//                   request, so merging both double-counted every boss kill.

import 'server-only';
import { opsServiceClient, readTracker } from '@/lib/ops/client';
import { ROW_LIMIT, sinceIso, WINDOW_7D_MS } from '@/lib/ops/window';
import type {
  AlertRowLike,
  EventRowLike,
  MilestoneRowLike,
  OathRowLike,
  PhotoRowLike,
  PinRowLike,
  PotyRowLike,
  SessionRowLike,
  TitleRowLike,
  VoiceRowLike,
} from '@/lib/ops/activity';

export interface ActivityData {
  /** The render clock. Every window on the page is measured from this. */
  nowMs: number;
  /** False when the service-role environment is missing: the page says so. */
  configured: boolean;
  events: EventRowLike[];
  voiceLines: VoiceRowLike[];
  milestones: MilestoneRowLike[];
  titles: TitleRowLike[];
  poty: PotyRowLike[];
  oaths: OathRowLike[];
  pins: PinRowLike[];
  photos: PhotoRowLike[];
  sessions: SessionRowLike[];
  alerts: AlertRowLike[];
  /** True when the events read came back at its ceiling: the window is clipped. */
  eventsTruncated: boolean;
  /**
   * Tables whose read did not come back, by name. Empty is healthy.
   *
   * Without this every panel below renders a failed read as an empty one, and
   * the page says "nothing fired" when what happened is that it could not look.
   * See readTracker in lib/ops/client.ts for why an error here throws nothing.
   */
  failedReads: string[];
  /** How the page reports its own cost. */
  cost: { queries: number; rows: number; fetchMs: number };
}

const EMPTY: Omit<
  ActivityData,
  'nowMs' | 'configured' | 'cost' | 'eventsTruncated' | 'failedReads'
> = {
  events: [],
  voiceLines: [],
  milestones: [],
  titles: [],
  poty: [],
  oaths: [],
  pins: [],
  photos: [],
  sessions: [],
  alerts: [],
};

export async function loadActivityData(): Promise<ActivityData> {
  const nowMs = Date.now();
  const client = opsServiceClient();
  if (!client) {
    return {
      nowMs,
      configured: false,
      ...EMPTY,
      eventsTruncated: false,
      failedReads: [],
      cost: { queries: 0, rows: 0, fetchMs: 0 },
    };
  }

  // Every read below names itself here, so a read that PostgREST refuses is a
  // sentence on the page rather than an empty panel. See lib/ops/client.ts.
  const track = readTracker();

  const since = sinceIso(nowMs, WINDOW_7D_MS);
  // One hour of slack on the insertion-order bound, explained at its use below.
  const insertedSince = sinceIso(nowMs, WINDOW_7D_MS + 60 * 60 * 1000);
  const t0 = performance.now();

  const [
    events,
    voiceLines,
    milestones,
    titles,
    poty,
    oaths,
    pins,
    photos,
    sessions,
    alerts,
  ] = await Promise.all([
    // The spine of the page: every event row of the last 7 days.
    //
    // TWO BOUNDS, ONE OF THEM PURELY FOR THE PLANNER. `created_at` is producer
    // time and is what "when it fired" means, but there is no index on
    // created_at alone (events_type_created_idx leads with `type`, and this read
    // deliberately does not pin a type: a NEW event type must show up on this
    // page as "other", not vanish). `events_inserted_at_idx` does exist, so the
    // read also bounds inserted_at, one hour wider.
    //
    // That second bound is provably lossless. Every ingest site clamps
    // created_at to at most FUTURE_EVENT_TOLERANCE_MS (5 minutes,
    // lib/event-time.ts) ahead of the moment it writes, so a row with
    // created_at >= T always has inserted_at >= T - 5 min, which is inside a one
    // hour margin with 55 minutes to spare.
    track.read('events', async () => {
      const { data, error } = await client
        .from('events')
        .select('type, character_name, created_at, inserted_at, metadata')
        .gte('inserted_at', insertedSince)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT);
      track.noteError('events', error);
      return (data ?? []) as EventRowLike[];
    }, [] as EventRowLike[]),

    // Two questions, one read, the same shape the oaths read uses: every line
    // queued inside the window (for the breakdown) PLUS every line still waiting
    // to be spoken whatever its age (for the backlog figure).
    //
    // The age bound alone was a bug. The in-game plugin only polls while a
    // player is connected, so a line queued during a week nobody played is
    // exactly the line that goes stale, and a 7 d bound made the panel's own
    // "oldest line still waiting" unable to see it: it could never report more
    // than 7 d however long a line had actually been stuck. queueBacklog() reads
    // the whole set; voiceBreakdown() still reads only the windowed slice.
    track.read('voice_lines', async () => {
      const { data, error } = await client
        .from('voice_lines')
        .select('id, kind, status, queued_at, spoken_at, meta')
        .or(`queued_at.gte.${since},spoken_at.is.null`)
        .order('queued_at', { ascending: false })
        .limit(ROW_LIMIT);
      track.noteError('voice_lines', error);
      return (data ?? []) as VoiceRowLike[];
    }, [] as VoiceRowLike[]),

    // Not windowed, and that is deliberate. There are 38 deed rows in total, and
    // the "achieved but never announced" panel has to see a deed that fired
    // three weeks ago: a backlog does not stop being a backlog at 7 days.
    track.read('milestones', async () => {
      const { data, error } = await client
        .from('milestones')
        .select('id, title, achieved_at, announced_at')
        .order('sort', { ascending: true })
        .limit(50);
      track.noteError('milestones', error);
      return (data ?? []) as MilestoneRowLike[];
    }, [] as MilestoneRowLike[]),

    // PostgREST resource embedding through title_history.player_id -> players.
    // One round trip instead of a second query plus an id-to-name join here.
    track.read('title_history', async () => {
      const { data, error } = await client
        .from('title_history')
        .select('title, awarded_at, player_id, players(character_name)')
        .gte('awarded_at', since)
        .order('awarded_at', { ascending: false })
        .limit(100);
      track.noteError('title_history', error);
      return (data ?? []) as unknown as TitleRowLike[];
    }, [] as TitleRowLike[]),

    track.read('poty_history', async () => {
      const { data, error } = await client
        .from('poty_history')
        .select('character_name, award_label, award_category, awarded_at, world_day')
        .gte('awarded_at', since)
        .order('awarded_at', { ascending: false })
        .limit(30);
      track.noteError('poty_history', error);
      return (data ?? []) as PotyRowLike[];
    }, [] as PotyRowLike[]),

    // Two questions, one read: oaths inside the window (for the timeline) and
    // every unannounced oath whatever its age (for the backlog panel).
    track.read('oaths', async () => {
      const { data, error } = await client
        .from('oaths')
        .select('character_name, source, sworn_at, announced_at, match_status')
        .or(`sworn_at.gte.${since},announced_at.is.null`)
        .order('sworn_at', { ascending: false })
        .limit(100);
      track.noteError('oaths', error);
      return (data ?? []) as OathRowLike[];
    }, [] as OathRowLike[]),

    track.read('pins', async () => {
      const { data, error } = await client
        .from('pins')
        .select('name, kind, by_character_name, created_at, day')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(100);
      track.noteError('pins', error);
      return (data ?? []) as PinRowLike[];
    }, [] as PinRowLike[]),

    track.read('gallery_photos', async () => {
      const { data, error } = await client
        .from('gallery_photos')
        .select('posted_by, posted_at, content_type')
        .gte('posted_at', since)
        .order('posted_at', { ascending: false })
        .limit(100);
      track.noteError('gallery_photos', error);
      return (data ?? []) as PhotoRowLike[];
    }, [] as PhotoRowLike[]),

    // Sessions inside the window PLUS every still-open session whatever its age.
    // An open session is the whole reason this reads `sessions` rather than
    // pairing join and leave events: a viking online right now has no leave row.
    // sessions_joined_at_idx and the two partial open-session indexes both serve
    // this shape (db/2026-09-06_perf_indexes.sql).
    track.read('sessions', async () => {
      const { data, error } = await client
        .from('sessions')
        .select('character_name, joined_at, left_at, duration_minutes')
        .or(`joined_at.gte.${since},left_at.is.null`)
        .order('joined_at', { ascending: false })
        .limit(500);
      track.noteError('sessions', error);
      return (data ?? []) as SessionRowLike[];
    }, [] as SessionRowLike[]),

    // One row today, keyed 'watchdog'. There is no alert history table, which is
    // why this contributes at most two instants to the timeline.
    track.read('ops_alerts', async () => {
      const { data, error } = await client
        .from('ops_alerts')
        .select('key, state, signature, since, last_alert_at, alert_count, updated_at')
        .limit(5);
      track.noteError('ops_alerts', error);
      return (data ?? []) as AlertRowLike[];
    }, [] as AlertRowLike[]),

  ]);

  const fetchMs = performance.now() - t0;
  const rows =
    events.length +
    voiceLines.length +
    milestones.length +
    titles.length +
    poty.length +
    oaths.length +
    pins.length +
    photos.length +
    sessions.length +
    alerts.length;

  return {
    nowMs,
    configured: true,
    events,
    voiceLines,
    milestones,
    titles,
    poty,
    oaths,
    pins,
    photos,
    sessions,
    alerts,
    eventsTruncated: events.length >= ROW_LIMIT,
    failedReads: track.failed,
    cost: { queries: 10, rows, fetchMs },
  };
}
