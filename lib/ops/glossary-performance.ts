// Glossary entries for the Performance tab.
//
// ONE OF THE FOUR SETS lib/ops/glossary.ts INDEXES. It was written beside the
// tab's components while three tracks were building in parallel, and moved here
// at integration so the glossary index at the foot of the overview holds every
// caption on every tab rather than only the overview's own. The entries are
// unchanged by the move.
//
// Its ids are unique across all four sets, which glossaryIdCollisions() proves
// rather than assumes, and its category in the index is "The Performance tab".
//
// THE DISCIPLINE, copied from the registry's header because it is what makes the
// entries worth reading:
//   what     literal, and it names the table or the file it comes from
//   why      what breaks in the world when the number moves
//   healthy  a value WITH ITS UNIT and the window it is measured over
//   whenRed  the first concrete thing to check, and where that thing lives
//
// Plain operator English. No Norse register (these pages are for one admin), no
// em dashes.

import type { GlossaryEntry } from './glossary';

const RUNBOOK = 'https://github.com/cbspears/valheim-dashboard/blob/main/docs/OPS-COCKPIT.md';
const V2 = 'https://github.com/cbspears/valheim-dashboard/blob/main/docs/OPS-COCKPIT-V2.md';
// Heading anchors, generated from the real headings rather than guessed: a label
// that names a section has to land on that section, which lib/ops/glossary.test.mjs
// now enforces across all four sets.
const V2_LIMITS = `${V2}#11-known-limits-written-down-so-no-panel-pretends-otherwise`;
const V2_BUDGET = `${V2}#7-performance-budget`;
const RUNBOOK_STATES = `${RUNBOOK}#the-five-states`;

export const PERF_GLOSSARY = {
  'lag-window': {
    id: 'lag-window',
    title: 'Pipeline delay',
    what:
      'events.inserted_at minus events.created_at, in seconds, for every event row in the window. created_at is the producer\'s clock (the log line\'s time, or real now for a direct write); inserted_at is when the row actually landed in Postgres.',
    why:
      'It is the delay a player feels between doing a thing in the world and seeing it on the site or in Discord. It also bounds how far behind the recap, the Great Deeds evaluator and the #server relay can be running, because all three read this table.',
    healthy:
      'Median under 30 s and p90 under 60 s over the last 24 h. The log poller reads over SFTP on a 20 s cadence, so a steady 20 s to 30 s is the floor and not a fault. Client ingest rows should be under 5 s.',
    whenRed:
      'Check the log-poller heartbeat on the Overview tab first. If it reads healthy and the delay is still climbing, the SFTP pull is slow or the log file rotated under the poller: read the poller journal on the host. A delay that jumps and then holds usually means the poller restarted and is replaying from its byte cursor.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'lag-backfill': {
    id: 'lag-backfill',
    title: 'Backfilled rows',
    what:
      'Rows written before db/2026-09-06_events_inserted_at.sql was applied on the night of 2026-09-05. The migration set inserted_at = created_at for every row that already existed, so all of them read as exactly 0 s of delay.',
    why:
      'They are real rows with a fabricated delay. Averaged in, they drag every percentile toward zero and make the pipeline look faster than it is. The count is printed so the median can be read for what it is.',
    healthy:
      'Zero backfilled rows in the window. That becomes automatic once the window no longer reaches back to 2026-09-05, which is from 2026-09-13 for the 7 d window.',
    whenRed:
      'Not a fault and nothing to fix. Read the percentiles as covering only the rows inserted after the migration, and prefer the last 24 h column until the 7 d window has rolled past the backfill.',
    link: { href: V2_LIMITS, label: 'Cockpit v2 plan, known limits' },
  },
  'lag-producer': {
    id: 'lag-producer',
    title: 'Producer split',
    what:
      'Which half of the pipeline wrote a row, derived from the row shape rather than recorded. events has no source column, so joins, leaves and raids are attributed to the log poller, deaths stamped source "eilif" or carrying a gsDeathId to client ingest, deed and boss-flip rows to gs-ingest, and a hand-marked boss to the bot.',
    why:
      'The two halves have different physics: client ingest writes at real now, the poller writes 20 to 30 s late by design. One median over both is a blend of two different things and hides a slowdown in either. Split, a producer that stops writing shows up here hours before any heartbeat threshold trips.',
    healthy:
      'Both halves writing over the last 24 h whenever players were online, with client ingest under 5 s and the poller between 20 s and 60 s.',
    whenRed:
      'A producer at zero rows while players were on means that writer is down: check the log-poller heartbeat for the poller half, and the Vercel function logs for /api/gs-ingest for the client half. A growing "unattributed" count means a new writer landed that does not stamp metadata.source, and the rule table in lib/ops/performance.ts needs a line.',
    link: { href: V2_LIMITS, label: 'Cockpit v2 plan, known limits' },
  },
  'relay-backlog': {
    id: 'relay-backlog',
    title: 'Relay backlog',
    what:
      'Event rows with an inserted_at newer than the cursor the Discord bot last published in its heartbeat, and the age of the oldest of them. The cursor reaches this page only inside ops_heartbeats.metrics for the discord-bot row.',
    why:
      'This is the exact failure the 2026-09-06 rehearsal found: 21 of 43 feed rows were never posted to #server and nothing noticed, because a tick that posts nothing looks identical to a tick with nothing to post. The heartbeat stayed green the whole time. A cursor that stops moving while rows keep landing is the only visible symptom.',
    healthy:
      'Idle, or a handful of rows less than 15 s old: the relay loop ticks every 15 s. Anything over 5 minutes behind, or more than 50 rows waiting, reads as behind.',
    whenRed:
      'Check the relay sub-loop on the Overview tab for an error, then the bot journal on the host. A relay stalled on a 401, 403 or 404 holds its cursor deliberately rather than dropping rows, so the backlog will drain once the cause is fixed.',
    link: { href: V2, label: 'Cockpit v2 plan' },
  },
  'announce-latency': {
    id: 'announce-latency',
    title: 'Announce latency',
    what:
      'For Great Deeds, milestones.announced_at minus milestones.achieved_at. For oaths, oaths.announced_at minus oaths.sworn_at. Rows with the first stamp and not the second are counted separately as pending.',
    why:
      'It is the gap between a thing happening in the world and Discord hearing about it. The bot polls for unannounced rows on a two minute loop, so anything much past that is a backlog rather than jitter, and a pending row that keeps ageing means the deed fired and nobody was told.',
    healthy:
      'p90 under 3 minutes over the window, and nothing pending for more than about 5 minutes.',
    whenRed:
      'Check the milestone-evaluator and events-sync sub-loops on the Overview tab. A pending row with a healthy bot usually means the announce channel is misconfigured: MILESTONE_CHANNEL is still a pilot override in the bot .env and is reverted at cutover.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'voice-speak': {
    id: 'voice-speak',
    title: 'Speak latency',
    what:
      'voice_lines.spoken_at minus voice_lines.queued_at, in seconds, split by kind. A line is marked spoken the moment the Companion collects it from GET /api/voice, so this measures how long it waited to be collected, not how long the words took to appear.',
    why:
      'It is the in-game Companion\'s real round trip. The queue-age number on the Overview only shows it once it is already bad; this shows the distribution while it is still fine, and the split by kind separates a dawn line queued at 04:00 for an empty hall from an event line nobody collected.',
    healthy:
      'p50 under 5 s and p90 under 30 s over the last 24 h while someone is online. Lines queued to an empty hall can wait hours and that is correct: the Companion only polls while a viking is connected.',
    whenRed:
      'Check the companion-voice heartbeat on the Overview tab. If it is stale, the Companion is not polling at all and every queued line will sit. If it is healthy and lines still sit, the plugin is polling but not speaking, which is what the queue-age gauge is for.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'voice-stalled': {
    id: 'voice-stalled',
    title: 'Stalled voice lines',
    what:
      'Lines still status = queued whose queued_at is more than 10 minutes old. There is no expiry column in voice_lines and nothing deletes a queued line, so "stalled" is the only honest word: an old queued line is one nobody ever came to collect.',
    why:
      'Every stalled line is something Eilif was supposed to say and did not. They also queue up behind each other: the route hands out the three oldest rows per poll, so a stalled head of queue delays everything after it.',
    healthy:
      'Zero stalled lines while a viking is online. A non-zero count with an empty hall is normal and drains on the next join.',
    whenRed:
      'Check whether anybody was online at the time the lines queued. If they were, the Companion stopped polling: check the companion-voice heartbeat, then whether the plugin loaded at all in the server BepInEx log.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'heartbeat-pressure': {
    id: 'heartbeat-pressure',
    title: 'Silence budget',
    what:
      'The age of a component\'s ops_heartbeats.last_success as a fraction of the staleAfterSec threshold that component is given in lib/ops/health.ts. 0% means it just reported; 100% is the instant it turns stale.',
    why:
      'The state chip on the Overview is a cliff: healthy right up to the threshold, then stale. A component sitting at 92% of its window has been in a slow decline that nothing could show. This is the same fact as a fraction, which is what makes a decline visible before it becomes an incident.',
    healthy:
      'Every component under 70% of its own window. The bar turns amber at 70% and red at 90%.',
    whenRed:
      'A component past 70% is not yet an incident but it is missing beats. Check that process on the host before it crosses. The two in-game plugins are the exception: they only poll while somebody is connected, so a rising bar with an empty hall is expected.',
    link: { href: RUNBOOK_STATES, label: 'Ops runbook, the five states' },
  },
  'heartbeat-history': {
    id: 'heartbeat-history',
    title: 'Heartbeat history',
    what:
      'ops_heartbeats holds exactly one upserted row per component: the latest beat and nothing before it. There is no history in the database, so a component\'s uptime over a week cannot be charted at all.',
    why:
      'Knowing a component is healthy now is a different question from knowing whether it has been flapping. The honest substitute is to chart what a component wrote, which the other panels on this page do, and to say plainly that the liveness history does not exist.',
    healthy:
      'Not applicable. This is a limit of the schema, not a signal.',
    whenRed:
      'If a history is genuinely wanted, db/2026-09-06_ops_heartbeat_log.sql adds an append-only sample table with a pruning function. It is written and UNAPPLIED. Applying it is Charlie\'s call and nothing here does it.',
    link: { href: V2_LIMITS, label: 'Cockpit v2 plan, known limits' },
  },
  'route-heartbeat': {
    id: 'route-heartbeat',
    title: 'Route heartbeats',
    what:
      'Two components cannot POST a heartbeat of their own, so the routes they poll record one for them (lib/ops/route-heartbeat.ts). What is recorded is a timestamp and the fact that the poll authenticated, plus whatever small metrics the route passes. No duration is recorded anywhere.',
    why:
      'EilifBoards and the Companion\'s voice queue both run inside Valheim on the GTX host. Before this existed, a token rotation could freeze the leaderboard signs and a failed plugin load could kill in-game voice with no database-visible symptom at all, and the cockpit stayed green through both.',
    healthy:
      'Both routes polled inside the last 5 minutes while a viking is online. The write is throttled to once per 60 s per serverless instance, so the age shown is an upper bound: the real poll is up to a minute more recent than it says.',
    whenRed:
      'An unknown route heartbeat means that plugin has never polled successfully: check that the plugin loaded (server BepInEx log) and that its token matches on both sides. A stale one after a token rotation is the boards plugin backing off, which it logs exactly once and then never again.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'db-budget': {
    id: 'db-budget',
    title: 'Database budget',
    what:
      'An ESTIMATE of the database size against the Supabase free plan\'s 500 MB ceiling: each table\'s exact row count multiplied by a documented per-row byte constant, plus a 60 MB floor for the catalogs and the auth, storage and realtime schemas that a brand new project already carries.',
    why:
      'The free plan is the real constraint on this project\'s life and nothing else in the system watches it. Launch week is the first time this database will see twenty players, and events, sessions and chat_lines all grow with play.',
    healthy:
      'Under 70% of 500 MB, with a projection that does not reach the ceiling inside 30 days.',
    whenRed:
      'The two tables that will get there first are events and chat_lines. Neither is pruned by anything today. Past 70%, either prune chat_lines (it is counted here and never rendered anywhere) or move to a paid plan.',
    link: { href: V2_LIMITS, label: 'Cockpit v2 plan, known limits' },
  },
  'db-exact': {
    id: 'db-exact',
    title: 'Why it is an estimate',
    what:
      'The exact size needs pg_database_size(), which is SQL, and PostgREST has no route to SQL. Every number in this panel is therefore a row count (exact) multiplied by a per-row byte constant (a documented guess).',
    why:
      'A guess printed next to a measurement is how an ops page starts lying, so the word estimate appears on the number itself rather than in a footnote. The row counts underneath it are exact and are worth reading on their own.',
    healthy:
      'Not applicable. Treat the total as accurate to roughly plus or minus 30% and the row counts as exact.',
    whenRed:
      'db/2026-09-06_ops_db_size_rpc.sql defines a read-only function that returns the real byte totals for the database and the storage buckets. It is written and UNAPPLIED. Once Charlie applies it this panel switches to the exact number by itself, with no deploy.',
    link: { href: V2_LIMITS, label: 'Cockpit v2 plan, known limits' },
  },
  'storage-budget': {
    id: 'storage-budget',
    title: 'Storage budget',
    what:
      'A SAMPLED estimate of the two storage buckets against the free plan\'s 1 GB ceiling. map is weighed by measuring current.webp and status.json directly and extrapolating the per-day frame archive from a few sampled days; gallery is weighed by measuring the newest photos and averaging across the gallery_photos row count.',
    why:
      'The map bucket grows by one composited webp and one fog mask per in-game day, forever, and nothing prunes it. That is the only thing in this system with unbounded growth that nobody is watching.',
    healthy:
      'Under 70% of 1 GB. The day archive is a few megabytes per hundred in-game days at today\'s sizes.',
    whenRed:
      'The fog masks are the larger half and are kept for one reason: they let the timelapse be rebuilt if the game ever re-renders terrain. Old ones are the first thing to prune. Object sizes are read over HTTP HEAD on the public objects, so a bucket turned private would make this read unknown rather than wrong.',
    link: { href: V2_LIMITS, label: 'Cockpit v2 plan, known limits' },
  },
  'growth-projection': {
    id: 'growth-projection',
    title: 'Growth projection',
    what:
      'Rows added per day over the last 7 d for the tables that grow with play, converted to bytes with the same per-row constants, averaged, and extended forward until the 500 MB ceiling. player_positions is excluded because it is one row per viking, overwritten in place, and never grows.',
    why:
      'A percentage full says where the project is. A rate says how long it has. In launch week the rate is the number that changes, and 7 d of pre-launch data is a floor rather than a forecast: twenty players will not write at the rate three did.',
    healthy:
      'No projected ceiling inside 30 days. "Not growing" is a legitimate answer during a quiet week and is printed instead of a number rather than as an infinity.',
    whenRed:
      'Re-read it a day after launch. If the projection collapses to weeks, the growth is in events and chat_lines and both can be pruned by date without affecting anything the site renders except the Saga feed.',
    link: { href: V2, label: 'Cockpit v2 plan' },
  },
  'peak-concurrency': {
    id: 'peak-concurrency',
    title: 'Peak concurrency',
    what:
      'The deepest overlap of sessions inside each UTC day, swept from sessions.joined_at and sessions.left_at. A session still open counts as running to now, and a session spanning midnight counts in both days.',
    why:
      'This is the load the whole system has never seen. The pipeline has run with three concurrent players; the server is capped at twenty. The peak per day is the number to watch against that cap on launch night, and it is what every other number on this page should be read against.',
    healthy:
      'Anything up to the configured cap. A peak that exceeds the number of vikings who were actually on is a leaked open session, not a record.',
    whenRed:
      'A peak that stays high overnight means sessions are not being closed: the poller writes the leave that closes one, so check the log-poller heartbeat and the open-session finding on the Overview tab.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'deaths-per-hour': {
    id: 'deaths-per-hour',
    title: 'Deaths per hour played',
    what:
      'Death events in the window divided by viking-hours played in the same window, where viking-hours is the summed overlap of every session with the window. Two players on for an hour is two viking-hours.',
    why:
      'Raw death counts scale with attendance and say nothing about difficulty. Per hour played is the number that actually reflects the death penalty setting and the combat tier, and launch week is when both get judged.',
    healthy:
      'There is no established baseline yet: this world has run with three players. Record what launch night reads and compare against it. It is null, not zero, when nobody played.',
    whenRed:
      'A jump with no change to the tier usually means a new biome rather than a broken setting. Cross-check the death causes on the What fired tab before touching the panel.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'boss-rev': {
    id: 'boss-rev',
    title: 'Fight revision counter',
    what:
      'bosses.fight_stats carries a rev key that lib/fight-stats-cas.ts increments on every successful compare-and-swap write. It is the count of times that row has been folded, and it is the only visible measure of write contention anywhere in this database.',
    why:
      'fight_stats is the one row written by concurrent writers: the client-damage fold, the observed-damage fold and the kill flip all read-modify-write the same jsonb. A rev climbing during a fight is the fold working. A rev that stops while damage is still being reported means writes are losing the race and giving up.',
    healthy:
      'A rev that climbs while a boss is being fought and holds still afterwards. Every boss in production today shows "not stamped": the rows predate the counter, which is expected and is not a fault.',
    whenRed:
      'A rev that is present but not a number (a hand edit in the SQL editor, or a restore) can never be matched by the compare-and-swap filter, so every write to that row gives up forever. Set it back to an integer, or null the whole fight_stats blob, in the SQL editor.',
    link: { href: V2, label: 'Cockpit v2 plan' },
  },
  'freshness-ladder': {
    id: 'freshness-ladder',
    title: 'Freshness ladder',
    what:
      'For each surface the public site shows, the age of the newest row or object behind it, against the threshold that surface uses. The map and stats thresholds are lib/data.ts\'s own MAP_STALE_AFTER_MS and STATS_STALE_AFTER_MS, read from that file rather than restated here.',
    why:
      'A visitor does not see components, they see pages. This is the same health question asked in the reader\'s terms: if the roster is 40 minutes old, the Hall is showing a hall that emptied 40 minutes ago and nothing on the page says so.',
    healthy:
      'Every surface fresh. "Aging" is the band this exists for: past 70% of its threshold and not yet stale, which no other page can show.',
    whenRed:
      'Each rung names the row or object behind it. Follow that to the component that writes it on the Overview tab. An unknown age is unknown and never counts as fresh.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'render-cost': {
    id: 'render-cost',
    title: 'This page\'s cost',
    what:
      'Wall-clock milliseconds spent inside this page\'s fetch block, the number of HTTP requests it issued to Supabase (each head-only row count counts as one), the rows actually transferred, and the storage requests. Measured with performance.now() around the reads, on the server, every render.',
    why:
      'The cockpit is allowed to be expensive and not allowed to be silently expensive. This is the number that proves the budget holds against real data instead of against a promise, and it is the first thing to look at when the page feels slow.',
    healthy:
      'Under 2500 ms of fetch time, which is this tab\'s share of the 3 s budget the whole cockpit is held to. The bar turns amber at 70% of that.',
    whenRed:
      'The row counts are the cheapest requests here and the storage HEADs the slowest. If the page goes over, drop a panel rather than the budget: an ops page that takes six seconds to answer "is it working" is not an ops page.',
    link: { href: V2_BUDGET, label: 'Cockpit v2 plan, the performance budget' },
  },
} as const satisfies Record<string, GlossaryEntry>;

export type PerfGlossaryId = keyof typeof PERF_GLOSSARY;

/** Every entry on this tab, sorted by title, for the index at the foot. */
export function allPerfEntries(): GlossaryEntry[] {
  return Object.values(PERF_GLOSSARY as Record<string, GlossaryEntry>).sort((a, b) =>
    a.title.localeCompare(b.title),
  );
}
