// Captions for every number on the "Coming up" tab.
//
// ONE OF THE FOUR SETS lib/ops/glossary.ts INDEXES. It was written beside the
// tab's components while three tracks were building in parallel (the registry
// was another track's file and this one could not edit it), and moved here at
// integration, which is the "moved across wholesale" this header used to
// describe as a possibility. The entries are unchanged by the move.
//
// Its ids are unique across all four sets, which glossaryIdCollisions() proves
// rather than assumes, and its category in the index is "The Coming up tab".
//
// THE DISCIPLINE, copied from lib/ops/glossary.ts so the reader learns one shape:
//   what     what the number literally measures, naming the table or file.
//   why      what breaks in the world when it moves.
//   healthy  the value that means nothing is wrong, with a unit and a window.
//   whenRed  the first concrete thing to check, and where it lives.
//
// Plain operator English. No Norse register (these pages are for one admin), no
// em dashes, and every number carries its unit.

import type { GlossaryEntry } from './glossary';

const RUNBOOK = 'https://github.com/cbspears/valheim-dashboard/blob/main/docs/OPS-COCKPIT.md';
const LAUNCH_DOC = 'https://github.com/cbspears/valheim-dashboard/blob/main/docs/LAUNCH-DAY.md';
const RUNBOOK_CHECKS = `${RUNBOOK}#2-consistency-checks-libopsconsistencyts`;
const RUNBOOK_BACKUPS = `${RUNBOOK}#8-backups-schema--data--audit-backend-2`;
const LAUNCH_STEP_20B = `${LAUNCH_DOC}#20b--revert-the-pilot-overrides`;

export const HORIZON_GLOSSARY = {
  'launch-countdown': {
    id: 'launch-countdown',
    title: 'Launch countdown',
    what:
      'Time until Session Zero on 2026-09-09. The instant is the scheduled Discord gathering on that date (discord_events.starts_at) when one exists, and otherwise 17:00 America/Chicago, which is the hour docs/LAUNCH-DAY.md step 22 gives.',
    why:
      'Every step in the runbook is sequenced against it, and two of them have hard deadlines that are not on the day itself: the launch world is due 2026-09-08 and the Thunderstore index needs an hour of lead time.',
    healthy:
      'There is no healthy value. It is a clock. What matters is the open step count beside it.',
    whenRed:
      'If the countdown disagrees with the Discord event, the event has been moved and the runbook has not been. Check the gathering row on this page and docs/LAUNCH-DAY.md together.',
    link: { href: LAUNCH_DOC, label: 'The launch sequence of record' },
  },
  'launch-steps': {
    id: 'launch-steps',
    title: 'Open launch steps',
    what:
      'The next steps in docs/LAUNCH-DAY.md that are not confirmed done. Exactly one step (20, the wipe and the reverts) leaves a trace the cockpit can read; every other step is listed as not visible from here, because nothing in the database records it.',
    why:
      'The runbook is 22 steps with owners and a point of no return at step 8. Knowing which is next, and who owns it, is the whole of launch morning.',
    healthy:
      'Before the day: steps 0, 1 and 2 open, with step 0 (the launch world handover) due 2026-09-08. After the cutover: step 20 confirmed done.',
    whenRed:
      'A step you believe is finished still showing as open means the cockpit cannot see it, not that it failed. Only step 20 is actually checked here. Track the rest in the runbook.',
    link: { href: LAUNCH_DOC, label: 'docs/LAUNCH-DAY.md' },
  },
  'next-up-rail': {
    id: 'next-up-rail',
    title: 'What fires next',
    what:
      'Every clock on this page merged into one list, soonest first: the nightly recap, the dawn line, the ambient voice slot, the next gathering, the map frame and the two host timers. Items whose time cannot be computed sit at the bottom rather than being dropped.',
    why:
      'The panels below each answer for one producer. This answers the question an operator actually asks, which is what happens in the next hour.',
    healthy:
      'Nothing overdue. An item marked estimated is projected from a cadence rather than read off a clock and can drift by a cycle.',
    whenRed:
      'An item counting up instead of down has missed its window. Open its own panel below for the reason, then the component row on the Overview tab.',
  },
  'next-recap': {
    id: 'next-recap',
    title: 'Next recap',
    what:
      "The bot's nightly evening recap, a node-cron job at RECAP_EVENING_HOUR (default 23:00) in the bot's own TZ (default America/Chicago), scheduled in services/discord-bot/src/recap.js.",
    why:
      'It is the one scheduled Discord post of the day. A recap that does not run is invisible until somebody notices the channel was quiet, which is usually the next morning.',
    healthy:
      'A countdown under 24 h, and a Player of the Day archived within the last 24 h once the world is live. Before launch, RECAPS_START gates it and no recap is expected at all.',
    whenRed:
      'If the countdown is right but no recap ran, check the RECAPS_START gate first (it is set to a pilot date during the rehearsal and reverted at step 20b), then the bot heartbeat on the Overview tab.',
    // The gate this caption sends the reader to is a launch step, so the link
    // lands on that step rather than on the top of the runbook.
    link: { href: LAUNCH_STEP_20B, label: 'Launch day, step 20b' },
  },
  'recap-ran': {
    id: 'recap-ran',
    title: 'Last recap that actually ran',
    what:
      'The newest row in poty_history, within the last 7 d. The bot archives a Player of the Day on every recap it posts, so a row here is proof the job fired rather than proof it was scheduled.',
    why:
      'A cron that is scheduled and a cron that ran are different facts, and the difference is exactly what a gated or crashed recap looks like.',
    healthy:
      'One row per day once the world is live, awarded within a few minutes of the recap hour.',
    whenRed:
      'No row and a schedule that has passed means the run was gated (RECAPS_START), the bot was down at the hour, or the recap threw. The bot journal on the host has the reason.',
  },
  'next-dawn': {
    id: 'next-dawn',
    title: 'Next dawn line',
    what:
      'The in-game dawn line fires on every third world day (DAWN_EVERY_DAYS = 3 in services/discord-bot/src/voice.js), once per day, and only to a hall with somebody in it. Computed from server_status.world_day and the bot state\'s lastDawnDay.',
    why:
      'It is the one voice line with a schedule rather than a trigger, so it is the cheapest end-to-end proof that the whole voice path still works: bot writes a row, plugin polls it, hall hears it.',
    healthy:
      'A next day that is at most three world days out, and a lastDawnDay matching the most recent multiple of three the hall was populated on.',
    whenRed:
      'A dawn day that passed with players online and no line means the voice loop is not queueing. Check the voice-queue sub-loop on the Overview tab and the queue panel here.',
  },
  'ambient-cadence': {
    id: 'ambient-cadence',
    title: 'Ambient voice cadence',
    what:
      'Two clocks that both have to clear before Eilif says something unprompted: 120 minutes of banked someone-online time (CADENCE_MINUTES in voice.js), and no voice line of any kind inside VOICE_MIN_GAP_MS (default 30 min).',
    why:
      'It is the answer to "why has Eilif not said anything in two hours", and it distinguishes a hall that is simply quiet from a voice engine that has stopped.',
    healthy:
      'Minutes banked climbing while players are online, and the gap clearing within 30 min of the last line. An empty hall banks nothing, which is correct and not a fault.',
    whenRed:
      'Banked minutes stuck at a number while players are online means the voice tick is not running. Banked minutes reported as unknown means the bot has not restarted since this block was added, not that the engine is off.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  // ID NOTE: this was 'relay-backlog' until the tracks were merged, which is
  // the id the Performance tab's own backlog entry already carried. Two entries
  // cannot share an id in one registry, and these are not the same measurement:
  // that one counts the rows still waiting, this one is about the cursor that
  // decides which rows those are. Renamed to match its own title.
  'relay-cursor': {
    id: 'relay-cursor',
    title: 'Relay cursor and backlog',
    what:
      "The bot's #server relay walks events in insertion order and keeps a high-water mark (state.relay.lastInsertedAt). Backlog is the count of rows in events with a later inserted_at, which is rows the relay has not reached yet, not rows it has refused.",
    why:
      'This is the failure the 2026-09-06 rehearsal found: 21 of 43 rows never reached #server while every heartbeat read healthy. A relay whose loop ticks fine but whose cursor is wrong looks perfect everywhere else.',
    healthy:
      'Zero pending, or a handful clearing inside a minute. One tick is 15 s and one batch is 50 rows, so a healthy relay drains 200 rows a minute.',
    whenRed:
      'More than 50 rows waiting, or a cursor more than 5 min behind the newest row, while players are online. Check the relay sub-loop on the Overview tab: a permanent post error (401, 403, 404 on the channel) stalls the cursor deliberately rather than dropping rows.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'deeds-close': {
    id: 'deeds-close',
    title: 'Great Deeds nearest their thresholds',
    what:
      'The unachieved rows in milestones, scored against the live server-wide aggregates from player_stats and sessions, nearest first. Same numbers the Hall card and the evaluator use (lib/milestones summarizeMilestones), so all three agree.',
    why:
      'A deed crossing fires a Discord embed and an in-game voice line together. Knowing which is about to cross is knowing what the hall is about to hear.',
    healthy:
      'Percentages that move on a play night. The aggregate behind them is cached for 60 s, so a bar can read one minute stale.',
    whenRed:
      'A deed sitting at 99 percent for hours with players online means the aggregate is not updating: check the gs-ingest path, because every metric here is summed from player_stats.',
  },
  'title-contest': {
    id: 'title-contest',
    title: 'Titles about to change hands',
    what:
      "The living-title engine (lib/epithets) run twice over the same roster: once with each viking's persisted current_title as the hysteresis incumbent, which is what /api/titles returns, and once with every incumbent stripped. Flipping means the engine disagrees with the incumbent and the announcer would be willing to make the change. Held means the viking wears an earned title and the engine now offers a placeholder, which is refused outright. Contested means hysteresis is the only thing holding the title.",
    why:
      'Titles are deliberately sticky and rare since 2026-09-10: at most 3 proclamations a rolling 24 hours, no demotion of an earned title, silent placeholder reshuffles, and any announced change needs the same offer on two passes 15 minutes apart plus 24 hours of tenure. So a row here is a change the hall may eventually proclaim, not one that is due.',
    healthy:
      'A handful of rows that persist. Held rows are permanent by design. Two or three proclamations on a busy night is the target, not zero and not a stream.',
    whenRed:
      'A flip listed for many hours with the budget unspent and the bot healthy means the titles loop is not writing: check the title-evaluator sub-loop, and whether TITLES_DRY is set on the host.',
  },
  'next-boss': {
    id: 'next-boss',
    title: 'Next Forsaken',
    what:
      'The lowest sort_order row in bosses with is_killed false, and how long since the most recent kill.',
    why:
      'Progression pace, and the trigger for several things at once: a boss kill fires the boss watcher, the Skald retelling, a Great Deed and, if boss polls are on, a Discord poll.',
    healthy:
      'One boss down at a time, at whatever pace the hall plays. Nothing here alarms.',
    whenRed:
      'A boss the hall has actually felled still showing as standing means the milestone payload never reached the site. Check the server emitter row on the Overview tab.',
    link: { href: '/admin/ops/architecture', label: 'Architecture, a boss falls' },
  },
  'gathering': {
    id: 'gathering',
    title: 'Scheduled gatherings',
    what:
      'Rows in discord_events with status scheduled or active, rolled forward to their next occurrence for the recurring ones, soonest first. Mirrored from Discord by the bot\'s events-sync loop.',
    why:
      'It is the only thing on the site with a date the players have committed to, and the launch-night event is what the countdown at the top of this page points at.',
    healthy:
      'The launch event present with a plausible RSVP count, and updated_at inside the events-sync cadence of 10 minutes.',
    whenRed:
      'A gathering that exists in Discord and not here means events-sync is off or failing (EVENTS_SYNC=1 gates it). Rows with no discord_event_id are seeded demo rows and should not survive launch.',
  },
  'expiring-claims': {
    id: 'expiring-claims',
    title: 'Claim codes about to expire',
    what:
      'Rows in identity_claims with consumed_at null and expires_at inside the next 7 d. A claim is minted when a player says "I am <name>" to the bot and is consumed by the in-game /oath <CODE> shout.',
    why:
      'An expired claim means the player has to start the link over, and an unlinked player gets no photos, no title and no viking page.',
    healthy:
      'An empty list. A claim normally lives minutes: it is minted in Discord and consumed in game in the same sitting.',
    whenRed:
      'A claim aging toward its expiry means the player never shouted the code in game, or the shout never reached the webhook. Oaths and pins must be SHOUTED, which is the usual reason.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'voice-queue': {
    id: 'voice-queue',
    title: 'Voice queue',
    what:
      'Every row in voice_lines still status queued, oldest first. The in-game Companion polls GET /api/voice and flips them to spoken. The Overview tab shows only the oldest age; this is the queue itself.',
    why:
      'A queue that grows is the in-game half of the voice being deaf, and it is silent everywhere else: the bot writes happily to a queue nobody drains.',
    healthy:
      'Empty, or a line or two seconds old. The Companion polls every few seconds while a player is connected.',
    whenRed:
      'Lines older than 10 minutes with a player online means the Companion is not polling: check the in-game voice row on the Overview tab and the plugin on the box. An empty hall never drains the queue, and that is correct.',
  },
  'watchdog-window': {
    id: 'watchdog-window',
    title: 'Watchdog re-alert window',
    what:
      'The single row in ops_alerts, key watchdog: its current state, the signature of what is unhealthy, when that state began, and the earliest it may post again. The route is pinged every 15 min by GitHub Actions and re-alerts at most every 6 h while unhealthy.',
    why:
      'It explains a silence. A system that is still broken and has not alerted in four hours is not a system that recovered, and this is the only place that difference is visible.',
    healthy:
      'State ok, no signature, alert_count 0. During a planned outage it will alert once and then hold.',
    whenRed:
      'State alerting with a signature naming components is a real incident. State ok while the Overview shows stale components means the watchdog itself has not run: check the GitHub Actions schedule.',
  },
  'loop-schedule': {
    id: 'loop-schedule',
    title: 'Bot loops and their intervals',
    what:
      'Each of the bot\'s sub-loops with the interval it ticks on, when it last succeeded, and when the next tick is due. Enabled comes from the env gates on the host; last run comes from the heartbeat metrics.',
    why:
      'The Overview says whether a loop is healthy. This says when it is next due, which is what turns "no announcement yet" into either "expected, wait 90 s" or "that should have happened".',
    healthy:
      'Every enabled loop with a last success inside its own interval. Loops that are off by flag are off deliberately.',
    whenRed:
      'A loop enabled with no last run at all has never completed a tick since the bot started. A loop whose next-due time has passed by more than one interval is stuck: the bot journal on the host has the error.',
  },
  'host-timers': {
    id: 'host-timers',
    title: 'Host timers the cockpit cannot see',
    what:
      'The world backup (eilif-world-backup.timer, 00/06/12/18 local) and the nightly database snapshot (eilif-db-snapshot.timer, 03:30 local) are systemd timers on Charlie\'s PC. Neither sends a heartbeat, so the schedule shown here is read from the unit files in the repo, not from the host.',
    why:
      'The Supabase project is on the free plan: no automated backups and no point-in-time recovery. These two timers are the only copies of the world and the data, and nothing else in the system watches them.',
    healthy:
      'Not knowable from here. The schedule is what the units say; whether they ran is a systemctl question on the host.',
    whenRed:
      'If either needs to be observable, it has to POST to /api/ops/heartbeat like the poller and the snapshotter do. Until then, verify by hand: systemctl list-timers eilif-*.',
    link: { href: RUNBOOK_BACKUPS, label: 'Ops runbook, backups' },
  },
  'map-frame': {
    id: 'map-frame',
    title: 'Next map frame',
    what:
      'The map snapshot loop pulls the WebMap composite over SFTP every 5 minutes and writes map/status.json with the capture time. The next frame is that time plus the cadence, so it is a projection from the last run, not a schedule.',
    why:
      'status.json exists because the object\'s own last-modified header is not a liveness signal: Supabase leaves it untouched when an upsert writes byte-identical content, which is exactly what happens for days when nobody plays.',
    healthy:
      'A capture inside the last 5 minutes while the service is running, and a world day matching server_status.',
    whenRed:
      'More than one cadence late means the loop is not running or the SFTP pull is failing. A world day that disagrees with server_status means the snapshotter is framing a different world, which is what happened on the 2026-08-23 wipe.',
  },
  'bot-schedule-source': {
    id: 'bot-schedule-source',
    title: 'Where these numbers come from',
    what:
      'The bot reports its own schedule in its heartbeat metrics (services/discord-bot/src/heartbeat.js, metrics.schedule): its cron hour, its zone, its voice accumulators and its relay cursor, all read fresh from the host env and state.json on every beat.',
    why:
      'None of that is knowable from Vercel. Before the bot reports it, this page can only quote the constants in the repo, and a constant that has silently drifted from the host is the sort of number that gets trusted on the wrong night.',
    healthy:
      'A schedule block reported within the last 2 minutes, matching the bot heartbeat cadence of 60 s.',
    whenRed:
      'Not reported means the bot has not been restarted since this block was added. Every panel that depends on it says so and falls back to the repo defaults, clearly labelled. Restarting the bot is a host action and Charlie\'s call.',
  },
} as const satisfies Record<string, GlossaryEntry>;

export type HorizonGlossaryId = keyof typeof HORIZON_GLOSSARY;
