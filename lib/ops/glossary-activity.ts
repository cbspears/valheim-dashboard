// Glossary entries for the "What fired" tab.
//
// ONE OF THE FOUR SETS lib/ops/glossary.ts INDEXES. It was written beside the
// tab's components while three tracks were building in parallel, so that two of
// them appending to one object literal never became a merge conflict, and moved
// here at integration when the registry folded all four sets into one index.
// Nothing about the entries changed in the move: they were always typed as
// GlossaryEntry for exactly this.
//
// Its ids are unique across all four sets, which glossaryIdCollisions() proves
// rather than assumes, and its category in the index is "The What fired tab".
//
// ONE ENTRY IS DELIBERATELY NOT HERE. `quiet-gap` sits in the shared registry:
// it was written there for this tab's Silences panel, so Silences.tsx imports
// GLOSSARY['quiet-gap'] and the typed GlossaryId union makes a later rename on
// that side a compile error rather than a blank popover.
//
// THE FIVE-FIELD DISCIPLINE, inherited verbatim from lib/ops/glossary.ts:
//   what     literal, names the table or the derivation, no metaphor
//   why      what breaks in the world when it moves
//   healthy  the value that means nothing is wrong, WITH its unit and window
//   whenRed  the first concrete thing to check, and where it lives
//   link     optional pointer to the runbook

import type { GlossaryEntry } from './glossary';

const RUNBOOK = 'https://github.com/cbspears/valheim-dashboard/blob/main/docs/OPS-COCKPIT.md';

export const ACTIVITY_GLOSSARY = {
  'fired-timeline': {
    id: 'fired-timeline',
    title: 'The firing timeline',
    what:
      'One newest-first list merged from nine tables: events (join, leave, death, boss, raid, milestone, chat), voice_lines, milestones, title_history, poty_history, oaths, pins, gallery_photos and ops_alerts. Each row keeps the raw database row behind it, under "raw row". Two tables are deliberately NOT merged: discord_events, whose updated_at is rewritten by every sync tick and so is a heartbeat rather than a moment, and bosses, whose killed_at is the same instant as the events row for the same kill and would double-count it.',
    why:
      'There is no single log of what the system did. Answering "what happened at 21:40 last night" otherwise means opening nine tables and sorting them by hand. This is that sort, done once.',
    healthy:
      'A busy evening writes a few hundred rows across all tables. The shape matters more than the count: joins and leaves should bracket deaths, and a boss kill should be followed within a minute or two by a Great Deed and a voice line.',
    whenRed:
      'A window with joins but nothing else means the log poller is the only producer still writing: check the stats ingest heartbeat on the overview. That is the sharpest signal on this page, because it names a producer rather than describing quiet.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'volume-buckets': {
    id: 'volume-buckets',
    title: 'Volume by hour and by day',
    what:
      'Counts of timeline rows per UTC hour over the last 24 h, or per UTC day over the last 7 d, following whatever kind filter is active. Buckets are aligned in UTC, never in the host zone, so the same row lands in the same column wherever the page renders. The last bar is the current, incomplete bucket and is drawn muted.',
    why:
      'It is the shape of an evening. Comparing tonight against the same hours of the last week is how you notice that the hall got quiet an hour before anybody said so.',
    healthy:
      'Bars that follow when people actually play. Empty hours overnight are correct, not a fault, and the hall being empty is the commonest reason for a flat chart.',
    whenRed:
      'A flat run of empty hours in the middle of an evening, with the ribbon above showing online minutes through it, is worth a look at the producer split. Quiet play alone can produce it, so it is a prompt rather than a verdict.',
  },
  'loudest-hour': {
    id: 'loudest-hour',
    title: 'The loudest hour',
    what:
      'The fullest COMPLETE bucket in the window, named by its UTC start. It counts merged timeline rows across all nine tables, following whatever kind filter is active, not events rows alone. The current, incomplete bucket is excluded: it is drawn muted on the chart precisely because it cannot be compared with a full one, and crowning it anyway would contradict that. Ties go to the later bucket, because the useful answer is the most recent time it was that loud.',
    why: 'It is the peak the pipeline actually had to carry, and the hour to look at first when something went wrong last night.',
    healthy:
      'Any hour. There is no bad value here. Compare it against the same hour in the 7 d view to see whether tonight is unusual.',
    whenRed:
      'Nothing here is red on its own. A loudest hour of one or two events across a whole 24 h window means the window is nearly empty, which the counts beside it will already be saying.',
  },
  'producer-split': {
    id: 'producer-split',
    title: 'Split by producer',
    what:
      'Which writer produced each row in the window, DERIVED from the row rather than recorded on it: there is no source column on events. Joins, leaves, raids, chat and causeless deaths are the log poller; deaths carrying metadata.source of eilif or gs, boss rows and Great Deed rows come through /api/gs-ingest; titles, crowns, voice lines and photos are the Discord bot; the ops_alerts row is the /api/ops/watchdog route.',
    why:
      'If one producer stops writing, this goes lopsided hours before any heartbeat threshold trips, because a heartbeat says the process is alive and this says it is doing work.',
    healthy:
      'All three main producers present on any window where people played. The exact ratio depends on what happened, so read presence and absence rather than percentages.',
    whenRed:
      'A producer that has vanished from an otherwise busy window is the finding. Check that producer on the overview next: log poller and stats ingest are separate heartbeats, and either can be green while writing nothing.',
  },
  'window-delta': {
    id: 'window-delta',
    title: 'Last 24 h against the 7 d average',
    what:
      'Per event type: the count in the last 24 h, the count over 7 d, that total divided by 7 to give a daily average, and the difference between the two.',
    why:
      '"Deaths are double last week" is a sentence about game balance, and in launch week it is the first thing that changes when the player count goes up.',
    healthy:
      'A ratio near 1.0 means today looks like the week. There is no correct value: this is a comparison, not a threshold.',
    whenRed:
      'A ratio with no number means the 7 d baseline is zero, so there is nothing to compare against yet. That is honest, not a fault, and it is the normal state before launch.',
  },
  'death-causes': {
    id: 'death-causes',
    title: 'Death causes',
    what:
      'Counts per events.metadata.cause over the window. Rows with no cause are counted under "cause not recorded" rather than dropped, so the causes always add up to the death count.',
    why:
      'Deaths with no cause come from the log poller reading a ZDOID line, which carries no cause at all. A rising share of causeless deaths means the Companion client half of the pipeline stopped reporting, which nothing else on the cockpit shows.',
    healthy:
      'Most deaths carrying a real cause once the Companion client is installed on players machines. Falls, drownings and named creatures are all normal.',
    whenRed:
      'If nearly every death says "cause not recorded" while players are online, the Eilif Companion client is not reporting: check the stats ingest heartbeat and whether the pack in use pins a Companion Client version that has the death hook.',
  },
  'voice-panel': {
    id: 'voice-panel',
    title: 'The hall voice',
    what:
      'voice_lines rows queued in the window, split by status (queued or spoken), by kind (ambient, event, manual) and by meta.source (dawn, milestone, poty, oath). The wait is spoken_at minus queued_at as a median and a p90.',
    why:
      'The bot queues a line; the Companion plugin in the game polls for it and speaks it. A queue that fills without emptying means the in-game half is not polling, and players hear nothing while the site still looks fine.',
    healthy:
      'A wait of a few seconds while somebody is online. Lines queued with an empty hall stay queued and that is correct: the plugin only polls while a player is connected.',
    whenRed:
      'Queued lines with a growing age while players are online means the Companion plugin is not polling /api/voice. Check the companion-voice heartbeat on the overview and the voice token on both sides.',
  },
  'unannounced': {
    id: 'unannounced',
    title: 'Fired but never announced',
    what:
      'Rows with the doing stamp set and the telling stamp still null: milestones with achieved_at and no announced_at, oaths with sworn_at and no announced_at. Not windowed, because a backlog does not stop being a backlog at 7 days.',
    why:
      'The deed happened and nobody heard about it. Nothing else on the cockpit shows this: the bot heartbeat is green because the loop that ticks is not the loop that failed.',
    healthy: 'Empty, or nothing older than about two minutes: the bot announce loop runs on a 2 min cadence.',
    whenRed:
      'Anything older than about fifteen minutes means the announce loop is not running or is failing on every pass. Check the discord-bot heartbeat and its journal on the host, then whether the target channel still exists.',
  },
  silence: {
    id: 'silence',
    title: 'Silence while somebody was online',
    what:
      'The longest stretch with no events row written WHILE at least one session was open. Online stretches come from the sessions table, including still-open sessions, which is why this works for a viking who is connected right now. It is a description, not a verdict: read the wording under the number, which says whether the silence ran the whole session or sat inside one that was writing on both sides.',
    why:
      'It separates "the hall was empty" from "the hall was full and nothing was written", which the plain quiet gap cannot do.',
    healthy:
      'Usually the whole length of the session, and that is correct rather than a fault. The events table only records joins, leaves, deaths, boss kills, raids and chat, so a viking who spends two hours mining writes nothing at all and the silence comes back as two hours.',
    whenRed:
      'Nothing here is red on its own, and a threshold on this number would fire on every quiet evening. Use it as a prompt: if several vikings were on and a long silence sits inside a stretch that was otherwise writing, check the producer split for the same window, then that producer on the overview.',
  },
  'page-cost': {
    id: 'page-cost',
    title: 'What this page cost',
    what:
      'Wall-clock milliseconds spent in the database block of this render, the number of queries issued, and the number of rows read. Measured around the Promise.all with performance.now().',
    why:
      'The cockpit is allowed to be expensive, but not silently. This is the number that proves the page still fits its budget against real data as the tables grow through launch week.',
    healthy: 'Under about 800 ms for the database block, and the whole page under 3 s.',
    whenRed:
      'A fetch time climbing past a second with the same row count means Supabase round trips are slow, not that the page grew. A row count at 2000 means the events read hit its ceiling and the window is clipped, which the page says beside the chart.',
  },
} as const satisfies Record<string, GlossaryEntry>;
