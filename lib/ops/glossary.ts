// The cockpit's glossary: one entry per thing the pages put a number on.
//
// WHY. Every panel on /admin/ops is a number without a caption. "server-emitter:
// stale", "voice queue 12 m", "poller lag p90 34 s": each is obvious to whoever
// wrote it and opaque six weeks later at 2 am. An entry here is the caption, and
// <Explain/> (components/ops/Explain.tsx) is how it reaches the page: an info
// button beside the number that opens a small panel with the same five fields
// every time, so the reader learns the shape once.
//
// THE FIVE FIELDS, and the discipline behind them:
//   what     one sentence: what this number literally measures, in terms of the
//            table or signal it comes from. No metaphor.
//   why      why an operator should care. What breaks in the world when it moves.
//   healthy  the value or range that means nothing is wrong, WITH ITS UNIT and
//            the window it is measured over.
//   whenRed  what to look at, and in what order, when it is not healthy. The
//            first concrete action, not a restatement of the problem.
//   link     optional: the runbook section or file that goes deeper.
//
// PURE DATA, no JSX, no imports. It is read by a Client Component, so nothing
// here may be a secret, a live value, or a function.
//
// COPY RULES (these pages are for one admin, not for players): plain operator
// English, no Norse register, no em dashes, and every number carries a unit and
// a window.
//
// ── THE ID SCHEME (added by the explain track, 2026-09-06) ──────────────────
// Ids are namespaced by what they caption, because four different kinds of
// thing end up in the same registry and the prefix is what lets the glossary
// index group them without a second field on GlossaryEntry:
//
//   component:<key>   one per key in COMPONENTS and BOT_SUBLOOPS (lib/ops/health.ts).
//   check:<id>        one per Finding id in lib/ops/consistency.ts.
//   watchdog:<key>    one per target in WATCHDOG_TARGETS (lib/ops/watchdog.ts).
//                     Separate from component: on purpose: the cockpit's job is
//                     to show you a state, the watchdog's job is to wake you up,
//                     and their thresholds are deliberately different.
//   arch:<slug>       one per box on /admin/ops/architecture.
//   everything else   a concept or a measurement that is not keyed by a registry
//                     (the five states, a column heading, a percentile, a budget).
//
// lib/ops/glossary.test.mjs enforces the first three: a component, check or
// watchdog target with no entry here is a failing test, not a silent gap. That
// is the whole point of the file. A new check ships with its explanation or it
// does not ship.
//
// The two entries the scaffolding shipped, 'poller-lag' and 'stale-vs-unknown',
// are unchanged below and are still the model for the five-field shape.

import { ACTIVITY_GLOSSARY } from './glossary-activity';
import { HORIZON_GLOSSARY } from './glossary-horizon';
import { PERF_GLOSSARY } from './glossary-performance';

export interface GlossaryLink {
  /** Where it points. An in-app path, or an absolute URL for the repo or docs. */
  href: string;
  /** What the reader is clicking through to, in two or three words. */
  label: string;
}

export interface GlossaryEntry {
  /** Stable id. Also the key in GLOSSARY, and what a page cites in a bug report. */
  id: string;
  /** The name of the thing, spelled the way the page labels it. */
  title: string;
  /** What this number literally measures. */
  what: string;
  /** Why it is worth an operator's attention. */
  why: string;
  /** The value that means nothing is wrong, with unit and window. */
  healthy: string;
  /** What to check first when it is not healthy. */
  whenRed: string;
  /** Optional pointer to the runbook or source. */
  link?: GlossaryLink;
}

const REPO = 'https://github.com/cbspears/valheim-dashboard';
const RUNBOOK = `${REPO}/blob/main/docs/OPS-COCKPIT.md`;
const LAUNCH_DAY = `${REPO}/blob/main/docs/LAUNCH-DAY.md`;
const ARCH = '/admin/ops/architecture';

// ── DEEP LINKS ──────────────────────────────────────────────────────────────
// A label that names a section has to land on that section. These heading ids
// were read back off the rendered markdown on GitHub rather than guessed from
// the slug rules, because the generator drops punctuation and doubles the
// hyphen wherever a heading carried a long dash, so the 20b heading becomes
// "20b--revert-the-pilot-overrides" with two hyphens in the middle.
const RUNBOOK_SIGNALS = `${RUNBOOK}#1-what-each-components-health-signal-means-and-where-it-comes-from`;
const RUNBOOK_PANELS = `${RUNBOOK}#two-panels-below-the-roster-shipped-2026-09-05`;
const RUNBOOK_STATES = `${RUNBOOK}#the-five-states`;
const RUNBOOK_THRESHOLDS = `${RUNBOOK}#freshness-thresholds-components-registry-libopshealthts`;
const RUNBOOK_CHECKS = `${RUNBOOK}#2-consistency-checks-libopsconsistencyts`;
const RUNBOOK_AUTH = `${RUNBOOK}#3-auth-model`;
const RUNBOOK_PROOF = `${RUNBOOK}#6-what-the-cockpit-can-prove-vs-what-it-only-infers`;
const RUNBOOK_WATCHDOG = `${RUNBOOK}#7-the-off-pc-watchdog-get-apiopswatchdog`;
const LAUNCH_STEP_15 = `${LAUNCH_DAY}#step-15--read-the-boot-and-write-down-what-actually-loaded--claude`;
const LAUNCH_STEP_20A = `${LAUNCH_DAY}#20a--wipe-for-real`;
const LAUNCH_STEP_20B = `${LAUNCH_DAY}#20b--revert-the-pilot-overrides`;
const LAUNCH_STEP_20D = `${LAUNCH_DAY}#20d--restart-the-services-in-this-order`;
const LAUNCH_STEP_20E = `${LAUNCH_DAY}#20e--the-live-gate`;

/**
 * The registry. Keys are the namespaced ids described in the header.
 *
 * `satisfies` keeps every entry type-checked while `as const` keeps the keys
 * literal, so GlossaryId is the union of real ids and a typo is a compile error
 * rather than an undefined popover at runtime.
 */
export const GLOSSARY = {
  // ── The verdict line and the five states ─────────────────────────────────
  'ops-verdict': {
    id: 'ops-verdict',
    title: 'Overall verdict',
    what:
      'One sentence computed from two things this page already has: the worst state across every component in the roster below, and the worst severity across the open consistency checks. It reads "all clear" only when every component is healthy or deliberately disabled and no check has fired. A single unknown component holds it at "running, with things to note" instead, because silence is not evidence of health.',
    why:
      'The overview is a wall of facts and the question at 21:00 on launch night is not a fact, it is "do I need to do something". This line is the answer, and everything under it is the evidence for it.',
    healthy:
      'All clear, with every component healthy or deliberately disabled and zero open checks. Unknowns are called out separately: they are not failures, but they are not proof of health either.',
    whenRed:
      'Read the Needs attention list directly under this line first, worst severity at the top. Each finding carries its own next action. If the verdict is red because of a component rather than a check, the roster below names it and its Notes column says how that state was derived. The two component headlines mean different things: "not running" is a component that has gone silent past its own stale window, "running and failing" is one that reported on time and said it had an error.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'state-healthy': {
    id: 'state-healthy',
    title: 'Healthy',
    what:
      'The component reported a success inside its own stale window, is not flagged disabled, and its last report did not carry an error. Computed by computeState() in lib/ops/health.ts, the same function the off-PC watchdog uses.',
    why:
      'It is the only state that means "this piece of the pipeline is doing its job right now". Every other state is either a fault or an absence of evidence.',
    healthy:
      'Healthy is the healthy value. Note the window it is measured over: each component has its own, listed in the Cadence column and in the stale threshold beside it.',
    whenRed:
      'Nothing to do. Worth knowing: healthy at 90 percent of the stale window is a different fact from healthy at 10 percent, and this chip cannot tell them apart. The Performance tab gauges the age against the threshold if you want that detail.',
    link: { href: RUNBOOK_STATES, label: 'The five states' },
  },
  'state-degraded': {
    id: 'state-degraded',
    title: 'Degraded',
    what:
      'The component is still reporting inside its window, but the beat it sent said something is wrong: ops_heartbeats.status is "error" or "degraded", or a bot loop recorded ok:false. The in-game voice half also goes degraded when it is polling but lines have sat queued for 10 minutes or more with players online.',
    why:
      'It is the state that catches a process that is alive and failing, which is the failure mode no liveness check can see. A component that crashes goes stale; a component that runs and throws on every tick stays perfectly punctual.',
    healthy:
      'No component degraded, in any window. Degraded is never normal and never expected.',
    whenRed:
      'Read the Notes column on that row: the last error summary is stored there, already redacted. Then read the host journal for that unit, for example journalctl -u eilif-log-poller -n 100 --no-pager. Restarting is host-side and Charlie’s call, never this page’s.',
    link: { href: RUNBOOK_STATES, label: 'The five states' },
  },
  'state-stale': {
    id: 'state-stale',
    title: 'Stale',
    what:
      'The component reported successfully at some point and has now been silent for longer than its stale threshold. Age is measured from ops_heartbeats.last_success, or from server_status.updated_at for the inferred components.',
    why:
      'This is the common real failure: the process died, the host rebooted without bringing the unit back, or the network path to Vercel broke. It is the state that means an incident, as opposed to unknown, which usually means a question.',
    healthy:
      'Nothing stale. Each component has its own threshold, from 180 s for the Discord bot to 900 s for the map snapshot; the roster prints the cadence beside every row.',
    whenRed:
      'Identify the host first. The Discord bot, log poller and map snapshot are systemd units on Charlie’s PC (eilif-discord-bot, eilif-log-poller, eilif-map-snapshot), so a PC that is off makes all three stale at once and that pattern is the tell. The two in-game plugins and the emitter run on the GTX box, so those three going stale together points at the game server, not the PC.',
    link: { href: RUNBOOK_STATES, label: 'The five states' },
  },
  'state-disabled': {
    id: 'state-disabled',
    title: 'Disabled',
    what:
      'The bot reported this loop with enabled:false. Only bot sub-loops can be disabled: it comes from an env gate in services/discord-bot/.env, such as GALLERY_INGEST being unset.',
    why:
      'It separates "off on purpose" from "broken", which is the distinction that keeps a cockpit worth reading. A loop that is off by design should not colour the page red, and a loop that is off by accident should still be visible.',
    healthy:
      'Whatever the launch configuration says should be off. Anything you did not intend to turn off is the real finding here, not the colour of the chip.',
    whenRed:
      'Disabled is never an alert. If a loop should be on, the flag lives in services/discord-bot/.env on the host and takes effect at the next bot restart, which is Charlie’s call. The launch values for every override are in docs/LAUNCH-DAY.md step 20b, and scripts/cutover-env.sh prints the diff before it applies it.',
    link: { href: LAUNCH_STEP_20B, label: 'Launch day, step 20b' },
  },
  'state-unknown': {
    id: 'state-unknown',
    title: 'Unknown',
    what:
      'No success has ever been recorded for this component, or the one signal that would tell us is itself missing (the database was unreachable this render, or the parent bot heartbeat is absent so its loops cannot be read).',
    why:
      'Unknown is the honest answer when there is no evidence, and this health model never goes green on absence. It is also the correct steady state for one component: the in-game voice half reports only while a player is connected.',
    healthy:
      'Unknown is expected for companion-voice whenever the hall is empty, and expected for anything that has genuinely never been deployed. Every other unknown is a question worth asking once.',
    whenRed:
      'Ask whether the component has ever worked. If it never has, check that it is deployed and that its token matches on both sides. If it used to and this is new, look at the database row: an unknown that used to be healthy usually means the heartbeat write path broke rather than the component.',
    link: { href: RUNBOOK_STATES, label: 'The five states' },
  },
  'stale-vs-unknown': {
    id: 'stale-vs-unknown',
    title: 'Stale versus unknown',
    what:
      'Two different silences. Stale means the component reported successfully at some point and has now gone quiet for longer than its threshold. Unknown means it has never reported at all, or the one signal that would tell us is itself missing.',
    why:
      'They call for opposite actions. Stale is a thing that was working and broke, so it is an incident. Unknown is usually a thing that was never deployed, never configured, or is silent by design (the in-game voice half stops polling when the hall is empty), so it is a question, not an alarm.',
    healthy:
      'Neither. Every component in the roster should read healthy inside its own cadence window, which is listed in the Cadence column beside it.',
    whenRed:
      'For stale: the component is down, its host is down, or the network path to Vercel is down, and the cockpit cannot tell which. Check the process on the host. For unknown: check whether it has ever been configured (the heartbeat token has to match on both sides) before treating it as an outage.',
    link: { href: RUNBOOK_STATES, label: 'Ops runbook, the five states' },
  },
  'roll-up-counts': {
    id: 'roll-up-counts',
    title: 'State counts',
    what:
      'How many components are in each state right now, counted across the roster below: the two core liveness rows, the six pipeline producers, and the seven bot sub-loops. Fifteen rows in total when the bot is reporting.',
    why:
      'It is the shape of the page in one glance. The number that matters is not the healthy count, it is whether stale or degraded is above zero.',
    healthy:
      'Zero stale and zero degraded. Thirteen of the fifteen healthy is the normal reading on an empty server: In-game voice reports only while somebody is connected, and Gallery ingest reports enabled with no tick result until the first photo is posted, so both sit at unknown. Neither is a fault.',
    whenRed:
      'A count of stale that equals three usually means Charlie’s PC is off, because the three host units go silent together. Read the roster to see which three.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },

  // ── Column headings on the component roster ──────────────────────────────
  'last-success': {
    id: 'last-success',
    title: 'Last success',
    what:
      'The timestamp of the most recent report that the component itself called a success: ops_heartbeats.last_success for the host units, server_status.updated_at for the inferred ones, and the loop’s own lastSuccessAt inside the bot heartbeat metrics for a sub-loop. It is not the last attempt.',
    why:
      'Every state on this page is derived from the age of this one timestamp. A component that is attempting and failing keeps a fresh last_attempt and a frozen last_success, and it is the frozen one that turns the row red.',
    healthy:
      'Within the component’s stale threshold, which is 180 s for the Discord bot, 300 s for the log poller, the emitter and both in-game plugins, and 900 s for the map snapshot.',
    whenRed:
      'Compare it against the Cadence column beside it. A last success that is a small multiple of the cadence is a missed tick or two, which is what the threshold slack is for. A last success from hours ago is an outage with a start time, and that start time is the most useful thing on this page when you go reading a journal.',
    link: { href: RUNBOOK_THRESHOLDS, label: 'Freshness thresholds' },
  },
  'cadence-vs-stale': {
    id: 'cadence-vs-stale',
    title: 'Cadence',
    what:
      'How often the component is supposed to report, from the COMPONENTS registry in lib/ops/health.ts. The stale threshold is a separate, larger number: the bot sends every 60 s but is not called stale until 180 s of silence.',
    why:
      'The gap between the two is deliberate slack, so one slow request does not flap the badge. Knowing both is what lets you read "45 s ago" as fine and "12 m ago" as an outage without looking anything up.',
    healthy:
      'An age in the Last success column of roughly one cadence. Two missed ticks is still inside every threshold on this page.',
    whenRed:
      'If a component is stale by only a little and recovers on the next render, it is jitter and not worth chasing. If it sits past the threshold for two page loads in a row, treat it as down.',
    link: { href: RUNBOOK_THRESHOLDS, label: 'Freshness thresholds' },
  },
  'component-version': {
    id: 'component-version',
    title: 'Version',
    // REWRITTEN 2026-09-06 (T-3 audit ops-4). This used to explain the column as
    // the way to tell whether a host unit was restarted — a reading that could
    // never happen, because no component sent a version at all and every one of
    // the fifteen rows read "unknown". The bot and the poller now put their
    // package.json version on every heartbeat, so this describes what each row
    // ACTUALLY shows, including the three that still show nothing and why.
    what:
      'Whatever the component put in the version field of its own heartbeat. The Discord bot and the log poller send their package.json version, added 2026-09-06, so each of those rows keeps reading "unknown" until its unit is restarted on that code. The dashboard row is the Vercel commit SHA, which a CLI deploy does not set, so it reads "unknown" too until a build carries one. The map snapshotter, the server emitter and the database send none at all.',
    why:
      'It is the one field on this page that comes from the running build rather than from what the repo says should be running. That matters most on the one day of the year when four plugins get recompiled and every service is restarted by hand.',
    healthy:
      'A version string that matches the code you deployed, or an honest "unknown" for the pieces that do not report one. "unknown" on the bot or the poller after a restart means the restart did not pick up this code.',
    whenRed:
      'A version behind what you deployed means the host unit was not restarted on it. But note what this column CANNOT answer: the service versions move only when somebody bumps a package.json, so two different builds can both read the same number, and it says nothing about a plugin on the game box. For "was this restarted, and on what", the authority is bash scripts/verify-restart.sh Eilif, which reads the plugin list and the game version off the box itself, plus the unit\'s own startup log. On this page the Age column is the better tell: a restart resets the heartbeat clock.',
    link: { href: LAUNCH_STEP_15, label: 'Launch day, step 15' },
  },
  'component-notes': {
    id: 'component-notes',
    title: 'Notes',
    what:
      'A plain sentence saying how this row’s state was derived, written by lib/ops/health.ts rather than stored anywhere. When the component reported an error, the redacted error summary is printed under it in red.',
    why:
      'Two components can show the same chip for completely different reasons, and this column is where that difference lives. "Nobody is on the server" and "the bot heartbeat did not report this loop" are both unknown and they call for different actions.',
    healthy:
      'A note that matches what you expect the component to be doing. There is no bad value here, only a surprising one.',
    whenRed:
      'Read it before you read anything else on the row. Error text is passed through lib/ops/redact.ts on the way in, so a truncated or partly redacted string is the guard working, not data loss.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'component-flags': {
    id: 'component-flags',
    title: 'Flags',
    what:
      'Small key=value chips describing the component, at most eight per row. The two core rows and the pipeline producers take theirs straight from the heartbeat’s metrics.flags object, and only log-poller sends one today (serverLive). The seven bot loops send no such object: their chip is synthesised in lib/ops/health.ts from metrics.loops[loop].enabled, so it is always exactly enabled=true or enabled=false. Everything shown has been through lib/ops/redact.ts.',
    why:
      'It is how a producer tells the cockpit about its own configuration without a deploy, and for a bot loop it is how you tell "switched off on purpose" apart from "broken". What it is not is where the launch-only pilot overrides live: the bot sends those as three top-level booleans in its heartbeat, never under flags, so they will never appear here as chips.',
    healthy:
      'Chips that match the intended configuration: serverLive=true on the log poller while the game server is up, enabled=true on every bot loop that should be running. An empty Flags cell is normal, and is the reading for most rows.',
    whenRed:
      'There is no red value here, only a surprising one. If you came looking for the pilot overrides, read Needs attention instead: they surface only through the "Launch-only pilot flags still enabled" check, and the fix is scripts/cutover-env.sh <World> to read the diff, then --apply, then a bot restart on the host.',
    link: { href: LAUNCH_STEP_20B, label: 'Launch day, step 20b' },
  },
  'heartbeat-source': {
    id: 'heartbeat-source',
    title: 'Where the signal comes from',
    what:
      'Each component gets its state from exactly one of four sources: a heartbeat the process POSTs itself (ops_heartbeats), the freshness of a row it writes (server_status), this page rendering at all (render), or a field inside the Discord bot’s heartbeat (bot_metrics).',
    why:
      'The source sets what the state can and cannot prove. A POSTed heartbeat proves the process ran and could reach Vercel. A freshness inference proves only that something recent wrote a row, and cannot separate a dead mod from a dead server from a dead network.',
    healthy:
      'Not a measurement, so it has no healthy value. The Notes column on each row names its source in plain words.',
    whenRed:
      'When a state surprises you, check the source before you chase the component. Half of the confusing states on this page are inferred signals being read as measured ones.',
    link: { href: RUNBOOK_SIGNALS, label: 'What each health signal means' },
  },
  'inferred-vs-measured': {
    id: 'inferred-vs-measured',
    title: 'Inferred, not measured',
    what:
      'Three components cannot report for themselves and are inferred from a side effect: the server emitter from how fresh server_status is, the boards plugin from its authenticated polls of /api/boards, and the in-game voice half from its authenticated polls of /api/voice.',
    why:
      'An inferred healthy is weaker evidence than a measured one, and an inferred stale names a set of possible faults rather than one. Stale on the emitter is consistent with the mod being unloaded, the game server being down, or the network path to Vercel being down, and this page cannot tell you which.',
    healthy:
      'The same freshness windows as everything else, 300 s for all three. What differs is what you may conclude from them, not the numbers.',
    whenRed:
      'Go to the box, not to the code. Open the panel, confirm the server is Started, then read the boot log for the plugin list (bash scripts/verify-restart.sh Eilif prints exactly this). An emitter stale while the two plugins are healthy is a mod problem; all three stale together is a server problem.',
    link: { href: RUNBOOK_PROOF, label: 'Proof versus inference' },
  },
  'render-liveness': {
    id: 'render-liveness',
    title: 'Dashboard and database liveness',
    what:
      'Two rows that are not heartbeats at all. Dashboard is healthy because this Server Component executed, which means the Next app is up. Database is healthy because a service-role query succeeded during this same render.',
    why:
      'They are point-in-time proofs with no history: they say the site answered you just now. That is genuinely useful, because it separates "the pipeline is broken" from "I cannot see the pipeline".',
    healthy:
      'Both healthy on every page load. Database degraded means the service-role query failed or the environment is unconfigured, and then almost every other row on this page turns unknown, which is the correct cascade.',
    whenRed:
      'A degraded database row with unknown everywhere else is one fault, not fifteen. Check the Supabase project status and that SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL are set in the Vercel environment for this deployment. There is nothing to fix on the host.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'service-role-read': {
    id: 'service-role-read',
    title: 'Read with the service role',
    what:
      'Every number on this page was read server side with the Supabase service-role key at render time, bypassing row level security. Nothing here is cached and nothing is fetched from the browser.',
    why:
      'It is why the cockpit can show full Steam ids and unannounced rows that the public site cannot, and it is why the page must stay behind its own password. It is also why the page costs about a second: those are real round trips to Supabase on every load.',
    healthy:
      'The footer says the read succeeded. Every figure on the page carries its own window, and the page is never served from a cache: dynamic is forced.',
    whenRed:
      'If the footer says the database is unreachable or unconfigured, the page is still telling the truth, it just has nothing to tell. Nothing on the host will fix that; it is an environment or a Supabase problem.',
    link: { href: RUNBOOK_AUTH, label: 'Auth model' },
  },
  'ops-auth': {
    id: 'ops-auth',
    title: 'Cockpit login',
    what:
      'A single shared password (OPS_PASSWORD) exchanged for a signed, httpOnly session cookie. Every cockpit page verifies that cookie in its own render and redirects to the login page when it is missing or invalid.',
    why:
      'This page reads with the service role and shows full Steam ids, unannounced rows and the release SQL. It is the one part of the site that must fail closed, and it does: with OPS_PASSWORD unset, verification fails and nobody gets in.',
    healthy:
      'You are reading this, so the cookie is valid. The whole /admin/ops segment is noindex, nofollow, nocache from its layout.',
    whenRed:
      'A redirect loop back to the login page means the environment variable is missing on the deployment rather than that the password is wrong. Rotating it invalidates every existing cookie, which is the intended behaviour.',
    link: { href: RUNBOOK_AUTH, label: 'Auth model' },
  },

  // ── One per component in the roster (COMPONENTS, lib/ops/health.ts) ──────
  'component:dashboard-api': {
    id: 'component:dashboard-api',
    title: 'Dashboard',
    what:
      'The Next app on Vercel that serves the public site and this cockpit. Its state is not a heartbeat: it is healthy because this page rendered, and its version is the deployed commit.',
    why:
      'It is the surface every player sees and the only one Charlie cannot check from the outside without loading it. If it were down you would not be reading this.',
    healthy: 'Healthy on every page load, with a version string that matches the deploy you expect.',
    whenRed:
      'It cannot be red here. If the site is down you will find out from Vercel or from a player, not from this row. Check the Vercel dashboard for the project and the most recent deployment’s build log.',
    link: { href: ARCH, label: 'Architecture, the surfaces' },
  },
  'component:supabase': {
    id: 'component:supabase',
    title: 'Database',
    what:
      'Supabase Postgres, the single store every other component writes into and reads from. Healthy means one service-role query succeeded during this render; there is no history behind it.',
    why:
      'Everything else on this page is a row in it. A database problem does not look like one failing component, it looks like the whole roster turning unknown at once.',
    healthy: 'Healthy on every render, with the footer at the bottom of this page confirming the live read.',
    whenRed:
      'Degraded means the query failed or the keys are unset on this deployment. Check the Supabase project is not paused, then check the environment variables on Vercel. Nothing on the host is involved.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'component:server-emitter': {
    id: 'component:server-emitter',
    title: 'Server emitter',
    what:
      'The third-party GsValheimStats mod inside the Valheim server process, which POSTs the roster, world day, boss kills and per-player stats to /api/gs-ingest. It cannot heartbeat, so its state is inferred from how fresh server_status.updated_at is.',
    why:
      'It is the authoritative source for who is online and what world day it is. When it stops, the site keeps showing the last roster it wrote, and the health model stops trusting the empty hall excuse that keeps the voice half from reading as broken.',
    healthy:
      'Updated inside 300 s. The mod posts about every 120 s while the server is up, whether or not anybody is playing.',
    whenRed:
      'Confirm the game server is Started on the GTX panel, then confirm the mod loaded: bash scripts/verify-restart.sh Eilif prints the plugin list from the boot log. Look for the [gs] ingest status: 200 line. A rotated GS_EMITTER_TOKEN that was changed in only one of the two places produces exactly this, with 401s on the box and silence here.',
    link: { href: RUNBOOK_SIGNALS, label: 'What each health signal means' },
  },
  'component:log-poller': {
    id: 'component:log-poller',
    title: 'Log poller',
    what:
      'The eilif-log-poller systemd unit on Charlie’s PC. It tails the server’s BepInEx LogOutput.log over SFTP and derives joins, leaves, deaths, sessions, oaths, pins and the chat mirror from it, then POSTs them to /api/webhook. It POSTs its own heartbeat.',
    why:
      'Half the events on the site come from here, and it is the half that carries a producer timestamp from a log line rather than from now, which is why poller lag exists as a number at all.',
    healthy: 'Heartbeat inside 300 s, against a 60 s send cadence.',
    whenRed:
      'Check the unit on the host: journalctl -u eilif-log-poller -n 100 --no-pager. A poller that is running but silent is usually an SFTP problem or a rotated log file. If it restarted, it resumes from its byte cursor, which shows up as a burst of catch-up rows with old timestamps rather than as loss.',
    link: { href: ARCH, label: 'Architecture, the host zone' },
  },
  'component:discord-bot': {
    id: 'component:discord-bot',
    title: 'Discord bot',
    what:
      'The eilif-discord-bot systemd unit on Charlie’s PC. One process running every loop in the bot-loop group below: the event relay, boss watch, recaps, milestones, titles, gallery ingest and the voice queue. It POSTs its own heartbeat with those loops attached as metrics.',
    why:
      'It is the only bridge between the database and Discord. When it stops, the site keeps working perfectly and Discord simply goes quiet, which nobody notices until somebody asks why the recap never came.',
    healthy: 'Heartbeat inside 180 s, the tightest window on this page, against a 60 s send cadence.',
    whenRed:
      'Check the unit on the host: journalctl -u eilif-discord-bot -n 100 --no-pager. Every sub-loop below turns unknown while this row is stale, and that is one fault, not eight. The bot and the poller have identical command lines, so tell them apart by working directory, never by pkill pattern.',
    link: { href: ARCH, label: 'Architecture, the host zone' },
  },
  'component:map-snapshot': {
    id: 'component:map-snapshot',
    title: 'Map snapshot',
    what:
      'The eilif-map-snapshot systemd unit on Charlie’s PC. It pulls WebMap’s map.png and fog.png over SFTP on a 5 minute cadence, writes fog-masked day frames and a manifest into Supabase Storage, and POSTs its own heartbeat.',
    why:
      'It is the only thing that moves the /map page forward. A stale snapshotter freezes the world map at its last successful pull, silently, and the page gives no sign that what it is showing is old.',
    healthy: 'Heartbeat inside 900 s, the loosest window on this page, against a 300 s cadence.',
    whenRed:
      'Check the unit on the host, then check SFTP access to the box and that MAP_REMOTE_DIR points at the live world’s map_data directory. After a world change this is the classic failure: the unit is healthy and pulling the wrong world’s files. Start it last after any cutover, per docs/LAUNCH-DAY.md step 20d.',
    link: { href: LAUNCH_STEP_20D, label: 'Launch day, step 20d' },
  },
  'component:boards-plugin': {
    id: 'component:boards-plugin',
    title: 'Boards signs',
    what:
      'EilifBoards, a server-side plugin inside the Valheim process that paints the in-game leaderboard signs. It cannot POST a heartbeat, so its liveness is its own authenticated poll of GET /api/boards, recorded by the route at most once a minute.',
    why:
      'On a 401 after a token rotation it logs one line to a file on the GTX box and then keeps the last text on the signs forever. Before this row existed, that failure was completely invisible: the signs looked fine and were simply frozen.',
    healthy:
      'Polled inside 300 s, against a 60 s cadence. It polls on a timer whether or not anyone is playing, so silence here is always a real signal.',
    whenRed:
      'Suspect the token first: BOARDS_TOKEN has to match between the plugin cfg on the box and the Vercel environment. Then confirm the plugin is loaded, in the boot log plugin list. This is one of the two components whose silence at launch is meaningful even with an empty hall.',
    link: { href: RUNBOOK_SIGNALS, label: 'Route-recorded heartbeats' },
  },
  'component:companion-voice': {
    id: 'component:companion-voice',
    title: 'In-game voice',
    what:
      'The Eilif Companion’s voice pump inside the Valheim process, which polls GET /api/voice for lines to speak in the hall. Like the boards plugin it cannot heartbeat, so the poll is the signal. It polls only while at least one player is connected.',
    why:
      'It is the half of the Companion that speaks, and it fails quietly: a plugin that does not load after a game update stops voice, pins and positions with no other symptom in the database.',
    healthy:
      'Healthy inside 300 s while somebody is online. Unknown with an empty hall is the correct reading, not a fault, and the roster is only believed while server_status is itself fresh.',
    whenRed:
      'With players online and this stale, check the Voice queue panel below: polling but not speaking shows up there as a queue that stops draining. VOICE_API_TOKEN lives in three places (the box cfg, Vercel, and .voice-token) and rotating two of the three produces exactly this silent shape. Note the off-PC watchdog deliberately never pages about this one, so nobody will be woken up for it.',
    link: { href: LAUNCH_STEP_20E, label: 'Launch day, step 20e' },
  },

  // ── One per bot sub-loop (BOT_SUBLOOPS, lib/ops/health.ts) ───────────────
  'bot-subloop': {
    id: 'bot-subloop',
    title: 'Bot loops',
    what:
      'Seven timers inside the single Discord bot process, not seven processes. Their state is read out of the bot’s own heartbeat metrics, where each loop reports whether it is enabled and when it last ticked.',
    why:
      'They are where the bot’s work actually happens, and they fail independently: the relay can be stuck while recaps keep posting. Splitting them out is the only way to see that.',
    healthy:
      'Every enabled loop inside its own window, which ranges from 300 s for the fast relay to 3600 s for the two evaluators. Disabled is a configuration fact, not a fault.',
    whenRed:
      'One loop red is that loop. All seven unknown at once is the parent bot, and the Discord bot row above will say so. Loop windows are deliberately much looser than their tick intervals because a loop that skips one tick has not failed.',
    link: { href: RUNBOOK_SIGNALS, label: 'Bot sub-loops' },
  },
  'subloop-unknown-when-parent-down': {
    id: 'subloop-unknown-when-parent-down',
    title: 'Loops unknown while the bot is silent',
    what:
      'When the discord-bot heartbeat is missing or stale, every loop below it reports unknown rather than keeping its last known state. The loops have no independent signal: their only evidence rides inside the parent heartbeat.',
    why:
      'It would be worse to leave seven green chips standing on evidence that stopped arriving an hour ago. A sub-loop cannot be inferred healthy from a parent that used to be healthy.',
    healthy: 'Not applicable. This is a rule, not a measurement.',
    whenRed:
      'Fix the parent. Seven unknown loops under a stale Discord bot row is one incident with one cause, and the loops will repopulate on the first heartbeat after it comes back.',
    link: { href: RUNBOOK_SIGNALS, label: 'Bot sub-loops' },
  },
  'component:relay': {
    id: 'component:relay',
    title: 'Event relay',
    what:
      'The bot loop that reads new events rows and posts them into the Discord #server channel. It keeps a cursor in the bot’s state file and only ever moves it forward.',
    why:
      'It is the busiest loop and the one with a real failure mode behind a green light: a tick that posts nothing is recorded as a success, so a stuck cursor looks exactly like a quiet evening. A future-dated event row freezes it permanently.',
    healthy: 'A tick inside 300 s, against a 15 s interval. Enabled at all times.',
    whenRed:
      'Check Needs attention for "Events are dated in the future" first: that check exists precisely because it is the one fault this loop cannot report about itself. The Coming up tab shows the cursor and the pending row count, which is the direct measurement.',
    link: { href: RUNBOOK_SIGNALS, label: 'Bot sub-loops' },
  },
  'component:bosses': {
    id: 'component:bosses',
    title: 'Boss watch',
    what:
      'The bot loop that watches the bosses table for a kill and posts the announcement, the retelling and the follow-on Great Deed checks.',
    why:
      'A boss kill is the single most visible moment the server produces. If this loop is stuck, the kill is recorded correctly on the site and Discord never hears about it.',
    healthy: 'A tick inside 600 s, against a 30 s interval.',
    whenRed:
      'Read the Notes column for the loop’s own last error. Manual boss marking exists as a last resort and lives in services/discord-bot/scripts/mark-boss.js, run from the bot directory on the host.',
    link: { href: RUNBOOK_SIGNALS, label: 'Bot sub-loops' },
  },
  'component:events-sync': {
    id: 'component:events-sync',
    title: 'Events sync',
    what:
      'The bot loop that syncs Discord scheduled events into the discord_events table, which is what the site’s next gathering card reads.',
    why:
      'It is the only writer for that table. When it stops, the site keeps advertising a gathering that has already happened, or shows nothing when one is scheduled.',
    healthy: 'A tick inside 1800 s, against a 300 s interval.',
    whenRed:
      'Check that the bot still has the guild permissions to read scheduled events. A seeded demo row with a null discord_event_id is a separate thing and is reported by its own check in Needs attention.',
    link: { href: RUNBOOK_SIGNALS, label: 'Bot sub-loops' },
  },
  'component:gallery-ingest': {
    id: 'component:gallery-ingest',
    title: 'Gallery ingest',
    what:
      'The bot loop that pulls images posted in the gallery channel into Supabase Storage and the gallery_photos table.',
    why:
      'It is the only path from Discord to the /gallery page. It is also the loop most likely to be legitimately disabled, since it is gated behind GALLERY_INGEST in the bot environment.',
    healthy:
      'A tick inside 900 s against a 120 s interval once it has handled its first photo. Until then the bot reports it enabled with no run result and the row reads unknown, which is the normal state on a quiet server. Disabled is also a valid state. Neither is a fault.',
    whenRed:
      'Unknown on its own needs nothing: post one image in the gallery channel and the row should turn healthy inside 120 s. If it is disabled and should not be, the flag is in services/discord-bot/.env on the host and needs a bot restart. Worth checking CHANNEL_GALLERY is set: unset, a mention with an image in any guild channel can land on /gallery.',
    link: { href: RUNBOOK_SIGNALS, label: 'Bot sub-loops' },
  },
  'component:voice-queue': {
    id: 'component:voice-queue',
    title: 'Voice queue loop',
    what:
      'The bot loop that decides what Eilif should say and writes lines into voice_lines with status queued. It is the producer half of the voice pipeline; the in-game Companion is the consumer half.',
    why:
      'A stuck producer means silence in the hall with an empty queue. A stuck consumer means silence with a growing queue. The Voice queue panel below tells the two apart, which this chip cannot.',
    healthy: 'A tick inside 600 s, against a 60 s interval.',
    whenRed:
      'Read the Voice queue panel below at the same time. Loop healthy with an old oldest-line age means the Companion is not speaking, which is the in-game half, not the bot.',
    link: { href: RUNBOOK_PANELS, label: 'Voice queue panel' },
  },
  'component:title-evaluator': {
    id: 'component:title-evaluator',
    title: 'Title evaluator',
    what:
      'The bot loop that recomputes each viking’s earned title from player_stats and writes changes into players.current_title and title_history.',
    why:
      'Titles are a slow, low-stakes loop, which is exactly why nobody notices when it stops. The symptom is titles that stop changing, weeks later.',
    healthy: 'A tick inside 3600 s, against a 600 s interval.',
    whenRed:
      'Not urgent. Check the loop’s error in Notes, and check TITLE_CHANNEL is set in the bot environment: an absent one routes title posts to #server rather than #valheim.',
    link: { href: LAUNCH_STEP_20B, label: 'Launch day, step 20b' },
  },
  'component:milestone-evaluator': {
    id: 'component:milestone-evaluator',
    title: 'Milestone evaluator',
    what:
      'The bot loop that evaluates the Great Deeds against aggregate player_stats, stamps milestones.achieved_at when one lands, and announces it.',
    why:
      'A Great Deed is a collective moment and it is announced once. If this loop is behind, the deed is recorded in the database and the hall never hears about it, which is the one failure the site cannot show you.',
    healthy: 'A tick inside 3600 s, against a 600 s interval.',
    whenRed:
      'Check Needs attention for "Great Deeds achieved but not announced", which is the direct evidence. Then read this loop’s error in Notes. The Coming up tab lists the deeds closest to firing so you can tell whether the silence is a fault or simply nothing having happened.',
    link: { href: RUNBOOK_SIGNALS, label: 'Bot sub-loops' },
  },

  // ── Needs attention: the checks themselves ───────────────────────────────
  'consistency-check': {
    id: 'consistency-check',
    title: 'Needs attention',
    what:
      'Cross-checks over the data itself, run fresh on every render by lib/ops/consistency.ts. The count beside this heading is the number of distinct conditions they can report, which is larger than the number of check functions: several report one of two or three mutually exclusive conditions, so server status missing, stale and very stale are three conditions from one check. They are independent of the heartbeat model above: a check asks whether the rows the processes produced hang together, not whether the processes are alive.',
    why:
      'A process can be perfectly healthy and writing wrong data, and no liveness signal will ever catch that. Every real incident this project has had was visible in the data before it was visible in a heartbeat.',
    healthy:
      'Zero open findings. A check that does not fire renders nothing at all, so this list is empty on a good day rather than green.',
    whenRed:
      'Work top down: the list is sorted worst severity first. Every finding carries its own next action in its own words, and that action is the intended first step, not a suggestion to investigate.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'severity-levels': {
    id: 'severity-levels',
    title: 'Severity',
    what:
      'Three levels, assigned by the check that fired. Critical means something is broken now and will stay broken until somebody acts. Warning means something has drifted and is likely to matter. Info means housekeeping, safe to leave.',
    why:
      'It is the ordering of this list, and on a busy night the ordering is the whole value. Two criticals and six infos is a very different evening from eight infos.',
    healthy: 'Nothing open at any level.',
    whenRed:
      'Do not treat info as noise to be cleared: several of them are launch checklist items in disguise, such as demo rows still in the database. Do treat critical as an interrupt: both criticals on this page (future-dated events and missing tables) stop a whole pipeline until they are fixed.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:server-status-missing': {
    id: 'check:server-status-missing',
    title: 'Server status has no timestamp',
    what:
      'server_status.updated_at is empty, so the cockpit cannot tell when the world was last heard from at all. Fires as a warning.',
    why:
      'It is the one row that carries the roster and the world day. With no timestamp on it, the roster the site shows has no age, and the health model cannot use the empty hall rule that keeps the voice half honest.',
    healthy: 'A timestamp inside 300 s while the server is up.',
    whenRed:
      'This is a never-written row rather than a stale one, so it usually means a fresh database or a wipe that cleared it. Confirm the emitter is posting to /api/gs-ingest and that the server is Started. After a launch wipe the row is deliberately zeroed and repopulates on the first ingest.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:server-status-stale': {
    id: 'check:server-status-stale',
    title: 'Server status is going stale',
    what:
      'server_status.updated_at is at least 10 minutes old. Fires as a warning, and escalates to its own critical check at 30 minutes.',
    why:
      'The site’s claim that the server is up is built on this row. Past ten minutes the roster on the front page is fiction, and the world day may be as well.',
    healthy: 'Updated inside 300 s. The emitter posts roughly every 120 s whenever the server is running.',
    whenRed:
      'If players are online, treat it as the emitter or the network path. If the world is genuinely empty this is still worth a look, because the mod posts on a timer regardless of who is playing.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:server-status-stale-critical': {
    id: 'check:server-status-stale-critical',
    title: 'Server status is very stale',
    what:
      'server_status.updated_at is at least 30 minutes old. Fires as critical. Nothing has refreshed the roster or the world day in that time.',
    why:
      'At half an hour, the plain reading is that the game server is down or unreachable, and everybody who loads the site is being told a roster that is half an hour old with no indication that it is.',
    healthy: 'Updated inside 300 s.',
    whenRed:
      'Confirm the server is Started on the GTX panel, then read the boot log for the emitter with bash scripts/verify-restart.sh Eilif. If the box is up and the mod is loaded, suspect GS_EMITTER_TOKEN: it exists on the box and in Vercel, and a rotation applied to only one of them produces exactly this.',
    link: { href: LAUNCH_STEP_15, label: 'Launch day, the emitter' },
  },
  'check:roster-disagreement': {
    id: 'check:roster-disagreement',
    title: 'Online roster disagrees with the emitter',
    what:
      'The set of names in server_status.current_players (written by the emitter) differs from the set of players rows with is_online true (maintained by the log poller). The finding names which side each disputed name is on.',
    why:
      'Two independent ingest paths have diverged, and the site reads one of them. The usual cause is harmless (a missed leave line, a session that never closed) and the usual outcome is a player who looks online for hours after they left.',
    healthy: 'The two sets identical, which is the normal state within one roster sync.',
    whenRed:
      'Prefer the emitter: it is authoritative. If it persists past the next sync, the poller is missing lines, so read its journal on the host. A single stuck name usually clears itself the next time that player joins.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:online-without-join': {
    id: 'check:online-without-join',
    title: 'Players marked online without a recent join',
    what:
      'A players row says is_online true, but the most recent presence event for that name is a leave, or there is no presence event for them at all in the window the cockpit read.',
    why:
      'It is the fingerprint of an unclean disconnect: the join was recorded, the leave never was, and the flag was left set. It quietly inflates who the site says is in the world.',
    healthy: 'No names listed. Every online player has a join as their latest presence event.',
    whenRed:
      'Usually self-healing on the next roster sync. If a name is stuck for hours, check the log poller heartbeat, then look for a missing leave line in the raw log. A stuck row can be corrected by hand in Supabase, which is Charlie’s call rather than this page’s.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:stale-open-sessions': {
    id: 'check:stale-open-sessions',
    title: 'Play sessions left open too long',
    what:
      'Rows in sessions with left_at still null more than 6 hours after joined_at. The finding counts them and names up to eight.',
    why:
      'An open session keeps accruing playtime forever. Left uncorrected these rows poison every playtime total on the site, the attendance grid, and any title that depends on hours played.',
    healthy: 'Zero, outside an actual marathon session. Real sessions close within minutes of a player leaving.',
    whenRed:
      'One or two after a crash is normal and they close on the next leave or roster sync. Several at once means the poller missed a stretch of log, so read its journal. Closing them by hand is a Supabase edit and is Charlie’s call.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:map-snapshot-missing': {
    id: 'check:map-snapshot-missing',
    title: 'No map snapshot recorded',
    what:
      'The map snapshotter has never reported a successful pull. Fires as info, because before a world exists this is the correct state.',
    why:
      'It separates "not started yet" from "broken". On a fresh world this is expected for the first few minutes and then should clear on its own.',
    healthy: 'A successful pull inside 30 minutes once the world exists.',
    whenRed:
      'After a cutover, check that map_data for the new world exists on the box and that the poller’s MAP_REMOTE_DIR points at it. The snapshotter is deliberately started last during a launch, so this finding is expected during that window.',
    link: { href: LAUNCH_STEP_20D, label: 'Launch day, step 20d' },
  },
  'check:map-snapshot-stale': {
    id: 'check:map-snapshot-stale',
    title: 'Map snapshot is stale',
    what:
      'The last successful map pull is at least 30 minutes old, against a 5 minute cadence. Fires as a warning.',
    why:
      'The /map page is frozen at that last pull and shows no sign of it. Explored fog, day frames and the timelapse all stop moving together.',
    healthy: 'A pull inside 30 minutes, normally inside 5.',
    whenRed:
      'Check the eilif-map-snapshot unit and its SFTP access to the box, then check .map-snapshot-state.json for the last successful pull. A unit that is healthy while this is stale usually means it is pulling from the wrong world directory.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:unannounced-milestones': {
    id: 'check:unannounced-milestones',
    title: 'Great Deeds achieved but not announced',
    what:
      'Rows in milestones with achieved_at set and announced_at still null. The finding counts them and names up to six.',
    why:
      'The deed happened, the site shows it, and Discord never heard. It is invisible on every other page, because from the site’s point of view nothing is wrong.',
    healthy: 'Zero. The bot announces within one milestone-evaluator tick, which is at most a few minutes.',
    whenRed:
      'Check the milestone-evaluator loop in the roster above for its last tick and error, and check the bot is not simply down. A backlog after an outage drains on the first clean tick, so give it one loop interval before doing anything.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:unannounced-identities': {
    id: 'check:unannounced-identities',
    title: 'Identity links confirmed but not announced',
    what:
      'Rows in identity_claims with consumed_at set and announced_at null: a player linked their Discord account in game and never got the confirmation message. Fires as info.',
    why:
      'The link works, so nothing is broken for the player except that nobody told them it worked. It usually means the bot was down for a stretch.',
    healthy: 'Zero, with confirmations sent within one bot loop of the in-game claim.',
    whenRed:
      'One clean tick of the bot normally drains the backlog. If it does not, check the bot’s identity-confirm path and whether it can send direct messages to that user.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:stat-poison-flags': {
    id: 'check:stat-poison-flags',
    title: 'Stat-poison flags recorded',
    what:
      'One or more player_stats rows carry gs_stats._flags, which the ingest guard writes when a client posts an implausible counter jump. The value it flagged was merged and marked rather than dropped.',
    why:
      'It is the guard telling you it caught something, not an error. Two people sharing a Steam profile, a client bug, or a genuine outlier all land here, and the difference matters for the leaderboards.',
    healthy: 'No reporters flagged. A single flag on a new player is worth one look and rarely more.',
    whenRed:
      'Read the flagged rows in Supabase: gs_stats._flags records the previous and next values, so you can see the size of the jump and undo it by hand if it is wrong. Not urgent unless it repeats.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:future-dated-events': {
    id: 'check:future-dated-events',
    title: 'Events are dated in the future',
    what:
      'Rows in events whose created_at is ahead of now. Fires as critical, and prints up to five of them with their type, character and timestamp.',
    why:
      'The Discord relay’s cursor is events.created_at and only moves forward, so one future-dated row freezes #server permanently, and freezes it silently: a tick that posts nothing counts as a success and every health signal stays green. The same row also sits inside the recap window every day until its date arrives.',
    healthy: 'Zero rows. Ingest now clamps producer-supplied timestamps, so new ones should not appear.',
    whenRed:
      'Delete the rows in Supabase, then check the relay cursor in the bot state file. Until they are gone the relay will not advance past them and #server stays quiet no matter how healthy the bot looks.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:expired-claims': {
    id: 'check:expired-claims',
    title: 'Expired identity codes never used',
    what:
      'Rows in identity_claims whose expires_at has passed with consumed_at still null: a code was minted in Discord and never redeemed in game. Fires as info.',
    why:
      'It is a record of players who started the linking flow and did not finish it. Useful to know, never urgent.',
    healthy: 'A small number at any time. Codes expire by design.',
    whenRed:
      'Nothing to do unless a specific player says they are still not linked, in which case have them mint a fresh code. Prune the table occasionally if it grows.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'check:missing-migrations': {
    id: 'check:missing-migrations',
    title: 'Expected tables are missing',
    what:
      'The cockpit probes for the tables this feature set needs and one of them was not found. Fires as critical and names them.',
    why:
      'A missing table means a whole feature is running against a schema that is not there. The code paths that write to it fail quietly, so nothing else on the site shows a symptom.',
    healthy: 'Every probed table present. There is no partially-applied state to worry about here: a table exists or it does not.',
    whenRed:
      'Apply the matching db/*.sql file in Supabase. Migrations in this repo are hand-applied by Charlie and nothing runs them automatically, so a file existing in db/ is not evidence that it ran.',
    link: { href: `${REPO}/tree/main/db`, label: 'Migration files' },
  },
  'check:pilot-flags-enabled': {
    id: 'check:pilot-flags-enabled',
    title: 'Launch-only pilot flags still enabled',
    what:
      'The bot’s heartbeat reports one or more pilot overrides still active: recaps or milestones forced into the pilot channel, or RECAPS_START pulled forward for a demo. Fires as a warning.',
    why:
      'These were set for testing and are meant to be reverted at launch. Left on, recaps and milestone posts land in the wrong channel on the one night the whole server is watching.',
    healthy: 'No overrides reported. That is what the launch configuration looks like.',
    whenRed:
      'Run bash scripts/cutover-env.sh <World> to read the diff, then the same command with --apply. It removes the channel overrides, sets TITLE_CHANNEL (an absent one routes titles to #server, so removing it is wrong), sets RECAPS_START, drops the competing Environment line from the unit file and repoints the poller. Then restart the bot on the host.',
    link: { href: LAUNCH_STEP_20B, label: 'Launch day, step 20b' },
  },
  'check:demo-data-present': {
    id: 'check:demo-data-present',
    title: 'Demo data still present',
    what:
      'Rows in discord_events with a null discord_event_id, which is the signature of a hand-seeded demo row rather than one synced from Discord. Fires as info.',
    why:
      'Seeded rows advertise gatherings that do not exist. Harmless during development and embarrassing on launch night.',
    healthy: 'Zero seeded rows once the real Discord events are syncing.',
    whenRed:
      'They are cleared as part of the launch wipe (node scripts/launch-wipe.mjs, which is a dry run by default). Removing them by hand in Supabase is equally fine.',
    link: { href: LAUNCH_STEP_20A, label: 'Launch day, step 20a' },
  },

  // ── The two panels under the roster ──────────────────────────────────────
  'voice-queue-age': {
    id: 'voice-queue-age',
    title: 'Voice queue age',
    what:
      'The age of the oldest line still sitting in voice_lines with status queued, measured only while at least one viking is connected. It reads "none" when the queue is empty and also when nobody is online.',
    why:
      'It is the second, independent signal for the in-game voice half, and the only one that survives the heartbeat being wrong. The heartbeat says the Companion is polling; this says whether the lines it should be speaking are actually leaving the queue. A plugin that loads but cannot speak, or polls with a stale token, keeps its heartbeat green and stops draining this queue.',
    healthy:
      'Under 10 minutes with players online, and normally a few seconds. Past 10 minutes the In-game voice row above is forced to degraded.',
    whenRed:
      'Check the In-game voice row: polling plus a stalled queue points at the plugin’s speak path, not at the bot. VOICE_API_TOKEN exists in three places (the box cfg, Vercel and .voice-token) and a rotation applied to two of them looks exactly like this. The Coming up tab lists the queue line by line if you need to see what is stuck.',
    link: { href: RUNBOOK_PANELS, label: 'Voice queue panel' },
  },
  'quiet-hall-rule': {
    id: 'quiet-hall-rule',
    title: 'The quiet-hall rule',
    what:
      'The In-game voice component reports only when the Companion polls /api/voice, which it does only while a player is connected. With nobody online the cockpit downgrades its silence from stale to unknown, and only while server_status is itself fresh.',
    why:
      'Without the rule this component turned red five minutes after the last player left, every single night, for behaving exactly as designed. The freshness condition matters too: the roster comes from server_status, so a dead emitter would report an empty hall and quietly excuse a genuinely dead voice half at the worst possible moment.',
    healthy:
      'Unknown with an empty hall. Healthy within a minute of the first join. Never healthy on absence: the downgrade goes to unknown and stops there.',
    whenRed:
      'If it is stale with an empty hall, look at the server emitter first: an aged server_status revokes the excuse, and that is the row that will tell you why. The off-PC watchdog applies the opposite rule for the same reason, reporting this component’s silence but never paging on it.',
    link: { href: RUNBOOK_SIGNALS, label: 'The quiet-hall rule' },
  },
  'steam-mismatch': {
    id: 'steam-mismatch',
    title: 'Steam identity mismatch',
    what:
      'A join in the last 7 days where the Steam account differed from the one bound to that character name. Read from events rows of type join carrying metadata.identity of steam_mismatch, newest first.',
    why:
      'The name is how every deed, oath and title is attributed. A mismatch means somebody joined under a name that belongs to another account, so presence is still recorded but the name’s oath, pin and Discord-link writes are frozen until an admin releases the binding.',
    healthy: 'No rows in the window. The usual innocent cause is one person with two Steam accounts.',
    whenRed:
      'Decide who owns the name. The bound account keeps it by default and stays frozen for the other. The full Steam id of whoever joined is not stored on the public row, only a 12 character fingerprint; the full id is in the bot host’s journal on the STEAM MISMATCH line for that character.',
    link: { href: RUNBOOK_PANELS, label: 'Identity mismatches' },
  },
  'binding-release': {
    id: 'binding-release',
    title: 'Releasing a binding',
    what:
      'The SQL under the mismatch table, generated fresh for the names in the window: one statement per character that clears players.steam_id so the next join binds the name to whoever joins with it.',
    why:
      'It is the only way out of a frozen name, and it is deliberately not a button. This cockpit never writes, so the page hands you a statement to paste into Supabase under the service role instead of doing it for you.',
    healthy:
      'Nothing to run. The block is shown whenever there is at least one mismatch in the window, whether or not you decide to act on it.',
    whenRed:
      'Run only the statements for names you actually mean to release. It is one statement per name on purpose, so releasing one never quietly leaves another frozen. Character names are unvalidated player input and are quoted through Postgres’s own escape, never interpolated raw.',
    link: { href: `${REPO}/blob/main/lib/ops/release-sql.ts`, label: 'release-sql.ts' },
  },
  'identity-fingerprint': {
    id: 'identity-fingerprint',
    title: 'Joining account fingerprint',
    what:
      'A 12 character hash of the Steam id that attempted the join, not the id itself. The bound id in the column beside it is the real one, read live from players under the service role.',
    why:
      'The event row that records a mismatch is readable by anyone holding the publishable key, so it stores no Steam id. The cockpit could show a full id here and deliberately does not, because the row it reads never had one.',
    healthy: 'Not a measurement. Two rows with the same fingerprint are the same account.',
    whenRed:
      'When you need the full id, it is on the STEAM MISMATCH line in the bot host’s journal for that character, and nowhere else in this system.',
    link: { href: RUNBOOK_PANELS, label: 'Identity mismatches' },
  },

  // ── The off-PC watchdog (lib/ops/watchdog.ts) ────────────────────────────
  'watchdog-loop': {
    id: 'watchdog-loop',
    title: 'The off-PC watchdog',
    what:
      'Two off-PC pingers call GET /api/ops/watchdog on Vercel: a Supabase pg_cron job (eilif-watchdog-ping) every 5 minutes, and a GitHub Actions schedule declared every 15 minutes that in practice fires about every 4 hours. The route evaluates the same components this page shows and posts to the ops channel when one of them is unhealthy, de-duplicating between pingers. Its state lives in one ops_alerts row.',
    why:
      'This page is pull-only: somebody has to open it. Every host-side producer runs on Charlie’s PC, so a PC that is off takes down the producers and the person most likely to notice, at the same time. A seven hour outage and a six day server outage both went unseen exactly that way.',
    healthy:
      'A green scheduled run in the Actions tab, and an ops_alerts row that says ok. Detection latency is the threshold plus one ping interval, which is 35 to 60 minutes by design.',
    whenRed:
      'If the workflow was disabled for quiet during a launch window, re-enable it from the Actions tab and confirm the next run is green before anybody goes to bed.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },
  'watchdog-thresholds': {
    id: 'watchdog-thresholds',
    title: 'Why the watchdog waits longer than this page',
    what:
      'The watchdog’s stale thresholds are 20 minutes for the 60 second producers and 45 minutes for the map snapshot, against 180 to 900 seconds on this page. Same state machine, deliberately different numbers.',
    why:
      'This page is read by a human who wants the truth now. The watchdog is polled every 15 minutes by a best-effort scheduler that routinely runs late, so any threshold near the poll interval would fire on jitter alone. A watchdog that cries wolf gets muted, which puts you back where you started.',
    healthy: 'Nothing unhealthy at either set of thresholds.',
    whenRed:
      'A component stale here and quiet in Discord is normal for the first 20 to 60 minutes. If it is still stale after an hour with no Discord message, check the workflow ran at all.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },
  'watchdog-re-alert': {
    id: 'watchdog-re-alert',
    title: 'Re-alert window',
    what:
      'While something stays unhealthy the watchdog repeats itself at most once every 6 hours, unless the signature changes, in which case it posts immediately because a different or additional thing broke.',
    why:
      'Anti-spam. A component that is down overnight should produce one message and one recovery message, not twenty-four.',
    healthy: 'No alert outstanding, so nothing is scheduled to repeat.',
    whenRed:
      'Silence for hours during a known outage is the anti-spam working, not a second failure. The Coming up tab shows the current state, how long it has been in it, and when the next repeat is allowed.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },
  'watchdog-signature': {
    id: 'watchdog-signature',
    title: 'Alert signature',
    what:
      'A stable fingerprint of what is currently wrong, built as key:state pairs sorted and joined. Stored on the ops_alerts row alongside the state and the time it started.',
    why:
      'It is how the watchdog tells "the same thing is still broken" from "something else broke too". A changed signature during an open alert is worth an immediate message even inside the 6 hour window.',
    healthy: 'An empty signature, which is what ok means.',
    whenRed:
      'Read it as a list. Three keys in the signature is three components, and if they are the three host units it is one PC rather than three faults.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },
  'watchdog-never-reported': {
    id: 'watchdog-never-reported',
    title: 'Never reported',
    what:
      'Components that have no successful heartbeat at all are listed separately and never alerted on. The watchdog cannot tell "not deployed yet" from "down" with zero data.',
    why:
      'A watchdog that pages about a component that has not shipped yet is noise, and noise is how a watchdog gets ignored. Once a component reports once, later silence is stale and does alert.',
    healthy:
      'An empty list on a mature deployment, with one standing exception: the in-game voice half has never reported in its life, because it only polls while somebody is online.',
    whenRed:
      'If something new appears here after it was working, that is not a never-reported case at all: it means the row was cleared. Check the database rather than the host.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },
  'watchdog:discord-bot': {
    id: 'watchdog:discord-bot',
    title: 'Watchdog target: Discord bot',
    what:
      'The watchdog alerts when the discord-bot heartbeat has been silent for 20 minutes, against the 180 seconds this page uses.',
    why:
      'Its meaning line in the alert says it plainly: no events, recaps, milestones or chat mirror are reaching Discord. It is the target most likely to matter overnight, because the bot is what talks to people while nobody is looking at the site.',
    healthy: 'A heartbeat inside 20 minutes. It sends every 60 seconds.',
    whenRed:
      'Check the eilif-discord-bot unit on the host. If all three host units alerted together, check whether the PC is on before anything else.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },
  'watchdog:log-poller': {
    id: 'watchdog:log-poller',
    title: 'Watchdog target: Log poller',
    what:
      'The watchdog alerts when the log-poller heartbeat has been silent for 20 minutes, against the 300 seconds this page uses.',
    why:
      'Its alert says: joins, leaves, deaths and shouts are not being ingested. While it is down the site simply stops learning that anybody played.',
    healthy: 'A heartbeat inside 20 minutes. It sends every 60 seconds.',
    whenRed:
      'Check the eilif-log-poller unit and its SFTP path to the box. A poller that comes back resumes from its byte cursor, so the gap is usually filled in rather than lost.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },
  'watchdog:map-snapshot': {
    id: 'watchdog:map-snapshot',
    title: 'Watchdog target: Map snapshot',
    what:
      'The watchdog alerts when the map-snapshot heartbeat has been silent for 45 minutes, the loosest threshold it carries, against the 900 seconds this page uses.',
    why:
      'Its alert says: the /map image is frozen at its last successful pull. It is the least urgent target, which is why it gets the longest rope.',
    healthy: 'A heartbeat inside 45 minutes. It sends every 5 minutes.',
    whenRed:
      'Check the eilif-map-snapshot unit, then its SFTP access and MAP_REMOTE_DIR. Remember it is started last after any world cutover, so an alert during that window is expected.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },
  'watchdog:boards-plugin': {
    id: 'watchdog:boards-plugin',
    title: 'Watchdog target: Boards signs',
    what:
      'The watchdog alerts when /api/boards has not been polled by the in-game plugin for 20 minutes. This target does alert on silence, unlike the voice half.',
    why:
      'The plugin polls on a timer whether or not anybody is playing, so silence is unambiguous. Its alert says: the in-game leaderboard signs are frozen at their last text, which is a failure nothing else in the system can see.',
    healthy: 'A poll inside 20 minutes. It polls about once a minute.',
    whenRed:
      'Suspect BOARDS_TOKEN first, since a rotation applied on one side only produces silence here and a single log line on the box. Then confirm the plugin is in the boot log’s loaded list.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },
  'watchdog:companion-voice': {
    id: 'watchdog:companion-voice',
    title: 'Watchdog target: In-game voice',
    what:
      'Evaluated and reported like every other target, but carries alertsOnSilence false: its silence is never paged on. A beat that arrives and says it errored still alerts.',
    why:
      'The watchdog has no roster and no way to trust one, so it cannot tell an empty hall from a dead voice half. Given that, the honest choice is to report the silence with its age and not wake anybody about it.',
    healthy:
      'Reported with an age while players are online. It has never reported at all in this deployment’s life, which is expected rather than broken.',
    whenRed:
      'Nothing will page you about this one, so check it deliberately: with a player online, confirm the In-game voice row on this page goes healthy within a minute of the first join, and watch the Voice queue panel drain.',
    link: { href: LAUNCH_STEP_20E, label: 'Launch day, step 20e' },
  },
  'watchdog:game-server': {
    id: 'watchdog:game-server',
    title: 'Watchdog target: Game server',
    what:
      'The watchdog’s name for the emitter signal: server_status.updated_at older than 20 minutes. It is the same inferred source this page calls Server emitter, watched from outside.',
    why:
      'It is the only target that can catch the game server itself being down, which is the outage that matters most to players and the one nothing on Charlie’s PC can report.',
    healthy: 'server_status written inside 20 minutes. The emitter posts about every 120 seconds.',
    whenRed:
      'Check the GTX panel first: this target cannot separate a dead server from a dead mod from a dead network path. Note that is_online in that row is effectively sticky-true, so freshness is the load-bearing signal and the flag is only a second opinion.',
    link: { href: RUNBOOK_WATCHDOG, label: 'The off-PC watchdog' },
  },

  // ── The architecture tab. Reference, not live signals. ───────────────────
  // Nothing under arch: is a measurement, so `healthy` says what "right" looks
  // like structurally and `whenRed` says what breaks when that shape is wrong.
  'arch:zones': {
    id: 'arch:zones',
    title: 'Zones',
    what:
      'The five coloured groups on the diagram: the game (inside the Valheim process on the GTX box), the host (systemd units on Charlie’s PC), the API (Next route handlers on Vercel), the database (Supabase Postgres and Storage), and the surfaces people actually look at.',
    why:
      'A zone is a blast radius. Everything in one zone tends to fail together and for the same reason, which is why the roster on the overview reads so much faster once you know which zone each row belongs to.',
    healthy:
      'Three zones can be down independently: the GTX box, Charlie’s PC, and Vercel. Nothing in this system requires all three at once except live play with a live site.',
    whenRed:
      'Group the failures before you chase them. Three host units stale at once is one PC. Emitter plus both in-game plugins stale at once is one game server.',
    link: { href: ARCH, label: 'Architecture' },
  },
  'arch:zone-game': {
    id: 'arch:zone-game',
    title: 'Zone: the game',
    what:
      'Everything running inside the Valheim server process on the GTX host: the Eilif Companion, the Boards plugin, the third-party GsValheimStats emitter, WebMap, and the gameplay mods. Plus the client mods players install from the pack.',
    why:
      'This zone is the only source of primary facts. Every number on the site began as something that happened here, and none of it can be recovered if this zone is not producing.',
    healthy:
      'Server Started on the panel, the expected plugin list in the boot log, and zero MISSING patch class lines in the first boot after a game update.',
    whenRed:
      'bash scripts/verify-restart.sh <World> is the authority: it reads the game version, the plugin list, the death-penalty tier and the port check off the box itself rather than trusting anything stored here.',
    link: { href: LAUNCH_STEP_15, label: 'Launch day, step 15' },
  },
  'arch:zone-host': {
    id: 'arch:zone-host',
    title: 'Zone: the host',
    what:
      'The three systemd units on Charlie’s PC: eilif-log-poller, eilif-discord-bot and eilif-map-snapshot. They pull from the game box over SFTP and push into the API over HTTPS.',
    why:
      'It is the only zone that is a personal computer, so it is the one that goes off at night. That single fact is why the off-PC watchdog exists.',
    healthy: 'All three units healthy on the overview, each inside its own window.',
    whenRed:
      'All three stale together is the PC, not the code. The bot and the poller have identical command lines, so tell them apart by working directory and never by pkill pattern.',
    link: { href: ARCH, label: 'Architecture, the host zone' },
  },
  'arch:zone-api': {
    id: 'arch:zone-api',
    title: 'Zone: the API',
    what:
      'The Next route handlers on Vercel that everything writes through: /api/gs-ingest, /api/webhook, /api/voice, /api/boards and /api/ops/*. Every one of them authenticates before it writes.',
    why:
      'It is the only writer to the database that is not a person. Producers hold a token each, and a token that matches on one side only is the single most common cause of a component going quiet without an error anywhere visible.',
    healthy:
      'Ingest returning 200 to the emitter, the two plugins polling successfully, and the three host units heartbeating.',
    whenRed:
      'When one producer goes silent and everything else is fine, suspect its token before its process. Each one lives in at least two places, on the box or the host and in the Vercel environment.',
    link: { href: ARCH, label: 'Architecture, the API zone' },
  },
  'arch:zone-db': {
    id: 'arch:zone-db',
    title: 'Zone: the database',
    what:
      'Supabase Postgres plus Storage: one shared store, written by the API under the service role and read by the public site under row level security with the publishable key.',
    why:
      'It is the single source of truth, which is what lets the site, Discord and this cockpit disagree about presentation and never about facts. It is also the free-plan ceiling this project will eventually hit.',
    healthy: 'The Database row on the overview healthy, and the free-plan estimate on the Performance tab well under 500 MB.',
    whenRed:
      'A database problem shows up as the whole roster turning unknown at once rather than as one failing component. Check the project is not paused, then the keys on the deployment.',
    link: { href: ARCH, label: 'Architecture, the database' },
  },
  'arch:zone-out': {
    id: 'arch:zone-out',
    title: 'Zone: surfaces and people',
    what:
      'What the data is for: the public dashboard, the Discord channels the bot writes into, and this cockpit. All three read the same rows.',
    why:
      'It is the zone where a failure is finally noticed by a human, usually last. Every earlier zone exists to keep this one honest.',
    healthy: 'The site serving, Discord receiving the relay, and this page rendering.',
    whenRed:
      'A surface that looks wrong is almost never wrong by itself. Walk back one zone at a time: surface, database, API, producer, game.',
    link: { href: ARCH, label: 'Architecture, the surfaces' },
  },
  'arch:transports': {
    id: 'arch:transports',
    title: 'Arrows: how components talk',
    what:
      'Six transports on the diagram, coloured rather than labelled: authenticated HTTPS POST, SFTP file pull, database read under row level security, database write under the service role, the Discord gateway, and a dashed poll on a timer.',
    why:
      'The transport tells you what a failure will look like. A POST fails loudly with a status code, an SFTP pull fails quietly and repeats, and a poll that stops is invisible unless the far end records it, which is exactly why the two in-game plugins get route-recorded heartbeats.',
    healthy: 'Not a measurement. Every arrow on the diagram is a path that exists today.',
    whenRed:
      'Two arrows run backwards from what people expect and both are covered in the walkthroughs: the game server polls /api/voice for lines to speak, and the bot both reads from and writes to the database.',
    link: { href: ARCH, label: 'Architecture, the legend' },
  },
  'arch:component-index': {
    id: 'arch:component-index',
    title: 'Component index',
    what:
      'The table at the foot of the architecture tab: every moving part, the zone it lives in, what it does, and who it talks to. Names link to the code on GitHub.',
    why:
      'It is the map from a name in a heartbeat to a directory in the repo. Half of ops work is knowing which file to open.',
    healthy: 'Not a measurement. The index is reference material and carries no state.',
    whenRed:
      'If a component on the overview roster is not in this index, the index is out of date, not the roster. The roster is generated from the registry in lib/ops/health.ts; this table is written by hand.',
    link: { href: ARCH, label: 'Architecture, component index' },
  },
  'arch:eilif-companion': {
    id: 'arch:eilif-companion',
    title: 'eilif-companion',
    what:
      'The server-side BepInEx plugin written for this project. It captures shouted /oath and /pin commands into the log, speaks Eilif’s lines in the hall by polling /api/voice, and emits player positions.',
    why:
      'Three separate features share one plugin, so when it fails to load after a game update, oaths, pins, positions and the voice all stop at once with no single obvious symptom.',
    healthy:
      'Present in the boot log plugin list, and the In-game voice row healthy within a minute of the first player joining.',
    whenRed:
      'A game update is the usual cause. It needs a recompile against the new assemblies, and the DLL can only be swapped while the server is stopped because the Windows host file-locks loaded plugins.',
    link: { href: `${REPO}/tree/main/plugins/eilif-companion`, label: 'plugins/eilif-companion' },
  },
  'arch:eilif-companion-client': {
    id: 'arch:eilif-companion-client',
    title: 'eilif-companion-client',
    what:
      'The client-side half, shipped in the mod pack players install. It posts each player’s explored-map percentage to /api/gs-ingest and carries the tombstone keep-list.',
    why:
      'It runs on player machines, so its version is whatever the pack pins, and it can only be updated by publishing a new pack. That makes it the slowest thing in the system to change.',
    healthy: 'The version pinned in the current pack matches the one published on Thunderstore.',
    whenRed:
      'Nothing here can fix a client mod. It is a pack mint plus a Thunderstore upload, and both are documented in the pack and launch-day runbooks.',
    link: { href: `${REPO}/tree/main/plugins/eilif-companion-client`, label: 'plugins/eilif-companion-client' },
  },
  'arch:eilif-paths': {
    id: 'arch:eilif-paths',
    title: 'eilif-paths',
    what: 'A client-side gameplay mod for roads and paths, shipped in the pack. It talks to nothing in this system.',
    why:
      'It is in the index so the pack contents and the architecture agree. A mod that produces no data still has to be built, versioned and published like the others.',
    healthy: 'Present in the pack at the version the pack pins.',
    whenRed: 'Not an ops concern. It has no runtime relationship with the site.',
    link: { href: `${REPO}/tree/main/plugins/eilif-paths`, label: 'plugins/eilif-paths' },
  },
  'arch:gsvalheimstats': {
    id: 'arch:gsvalheimstats',
    title: 'GsValheimStats',
    what:
      'The third-party mod, server and client, that produces the authoritative roster, world day, boss kills, per-player stats and deaths, and posts them to /api/gs-ingest.',
    why:
      'It is the largest single source of facts in the system and it is not ours. It cannot heartbeat, cannot be patched, and its behaviour on a new game version is not under this project’s control.',
    healthy: 'server_status fresh inside 300 s, and [gs] ingest status: 200 in the boot log.',
    whenRed:
      'Confirm the mod loaded, then confirm the token. Everything downstream of it, including the empty-hall rule that keeps the voice half honest, depends on this one row staying fresh.',
    link: { href: ARCH, label: 'Architecture, the game zone' },
  },
  'arch:api-gs-ingest': {
    id: 'arch:api-gs-ingest',
    title: '/api/gs-ingest',
    what:
      'The authenticated route the emitter and the client mod POST into. It validates, clamps producer timestamps, guards against implausible stat jumps, and writes the roster, stats, deaths and boss kills.',
    why:
      'It is the widest write path in the system and the one with the most hostile input, since some of it comes from player machines. Both the timestamp clamp and the stat-poison guard live here.',
    healthy: 'Returning 200 to the emitter on its normal cadence, with no new stat-poison flags.',
    whenRed:
      'A 401 here is a token mismatch and shows up on the overview as a stale server emitter. Bearer authentication on this route fails closed by design.',
    link: { href: `${REPO}/blob/main/app/api/gs-ingest/route.ts`, label: 'app/api/gs-ingest' },
  },
  'arch:api-webhook': {
    id: 'arch:api-webhook',
    title: '/api/webhook',
    what:
      'The authenticated route the log poller POSTs into with presence, sessions, deaths, oaths, pins and chat lines derived from the server log.',
    why:
      'It is the other half of ingest, and the half whose rows carry a producer timestamp taken from a log line rather than from now. That difference is the entire reason poller lag is a number worth watching.',
    healthy: 'Accepting the poller’s posts on its 60 second cadence, with poller lag under a minute at p90.',
    whenRed:
      'Check the poller before this route: it is far more likely that nothing is being sent than that the route is refusing it.',
    link: { href: `${REPO}/blob/main/app/api/webhook/route.ts`, label: 'app/api/webhook' },
  },
  'arch:api-voice': {
    id: 'arch:api-voice',
    title: '/api/voice',
    what:
      'The route the in-game Companion polls for lines to speak. It hands out queued voice_lines, marks them spoken, and records the poll as the companion-voice heartbeat at most once a minute.',
    why:
      'It is one of the two arrows that run backwards: the game server pulls from the site rather than being pushed to. That is why the Companion’s liveness had to be recorded here rather than reported by the plugin.',
    healthy: 'Polled continuously while anybody is online, with the voice queue draining within seconds.',
    whenRed:
      'A queue that stops draining while the poll continues is the plugin’s speak path. The route also refuses to hand a targeted line to a plugin that has not advertised that capability, which costs silence rather than a wrong line.',
    link: { href: `${REPO}/blob/main/app/api/voice/route.ts`, label: 'app/api/voice' },
  },
  'arch:api-ops': {
    id: 'arch:api-ops',
    title: '/api/ops/*',
    what:
      'Two routes: the heartbeat endpoint the three host units POST into, and the watchdog endpoint GitHub Actions calls every 15 minutes. Only three components may heartbeat, enforced by an allowlist.',
    why:
      'Everything on the overview’s roster ultimately comes from here. The allowlist is why a retired service cannot put a permanently stale row back into the cockpit.',
    healthy: 'Three components heartbeating and a green scheduled watchdog run.',
    whenRed:
      'A component POSTing an unknown name gets a 400 rather than a row, on purpose. Error strings and metric values are redacted on the way in, so a truncated message here is the guard working.',
    link: { href: `${REPO}/tree/main/app/api/ops`, label: 'app/api/ops' },
  },
  'arch:supabase': {
    id: 'arch:supabase',
    title: 'Supabase',
    what:
      'Postgres plus Storage on the free plan: 500 MB of database and 1 GB of storage. Migrations live in db/*.sql and are applied by hand.',
    why:
      'There is no migration runner in this repo. A file existing in db/ is not evidence that it ran, which is exactly what the missing tables check exists to catch.',
    healthy: 'Every probed table present, and the estimated database size well under 500 MB.',
    whenRed:
      'Apply the matching migration in Supabase. The Performance tab tracks the free-plan budget and the growth rate, which is the only thing in this system that watches the ceiling.',
    link: { href: `${REPO}/tree/main/db`, label: 'db/' },
  },
  'arch:public-dashboard': {
    id: 'arch:public-dashboard',
    title: 'Public dashboard',
    what:
      'The player-facing site: the Hall, Vikings, World, Map, Saga, Gallery and Oath pages. It reads the database with the publishable key under row level security, never with the service role.',
    why:
      'It is the surface that has to stay honest without exposing anything. Steam ids are fingerprinted on public rows for this reason, and the cockpit shows the full ones only because it runs behind a password with the service role.',
    healthy:
      'Pages serving current data. Several are cached for 60 seconds, so a change can take a minute plus a revalidation to appear.',
    whenRed:
      'After a world change, prerendered pages hold the old world until they revalidate. Read them in a fresh tab or with curl: an already-open tab can hold a client-side copy for up to 30 seconds and report that the page did not turn while the server is fine.',
    link: { href: LAUNCH_STEP_20E, label: 'Launch day, prerendered pages' },
  },
  'arch:ops-cockpit': {
    id: 'arch:ops-cockpit',
    title: '/admin/ops cockpit',
    what:
      'These pages. Password-gated, service-role, read only, never cached, and never linked from the public site.',
    why:
      'It is deliberately observational: nothing here restarts, deletes, wipes, applies, rotates or posts anything. Every action it recommends is something a human runs elsewhere, which is why the findings carry commands rather than buttons.',
    healthy: 'Rendering in under 3 seconds against production with nobody online.',
    whenRed:
      'If a page is slow, the Performance tab measures its own render cost and query count, which is the honest place to look rather than guessing.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'arch:journeys': {
    id: 'arch:journeys',
    title: 'The four journeys',
    what:
      'Four worked walkthroughs on the architecture tab: a boss falling, a viking swearing in and linking identity, a player opening the site, and you opening this cockpit. Each follows one fact through every zone it touches.',
    why:
      'The diagram shows what connects to what. The journeys show the order things happen in, which is what you actually need when you are deciding which end of a broken path to start at.',
    healthy: 'Not a measurement. They are reference material.',
    whenRed:
      'When something is missing at the far end, read the matching journey backwards from the surface. The first hop where the data is absent is the failure, and it is usually one hop earlier than it looks.',
    link: { href: ARCH, label: 'Architecture, the journeys' },
  },

  // ── Measurements the other three tabs introduce ──────────────────────────
  // Written here rather than in each tab so four pages cannot disagree about
  // what a percentile, a bucket or a budget means.
  'poller-lag': {
    id: 'poller-lag',
    title: 'Poller lag',
    what:
      'For events written by the log poller (join, leave, death), the gap between the time on the log line (events.created_at) and the time the row actually landed in the database (events.inserted_at). Quoted as a median and a p90 over the window.',
    why:
      'It is the pipeline delay a player feels: how long after stepping through the door their name appears on the site and in the Discord relay. It also bounds how far behind the recap and the Great Deeds evaluator can be running.',
    healthy:
      'Median under 30 s and p90 under 60 s over the last 24 h. The poller reads the log over SFTP on a 20 s cadence, so a steady 20 s to 30 s is the floor, not a fault.',
    whenRed:
      'Check the log-poller heartbeat on the overview first. If it is healthy and lag is still climbing, the SFTP pull is slow or the log file is being rotated under it: read the poller journal on the host. A lag that jumps and stays there usually means the poller restarted and is replaying from its byte cursor.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'producer-attribution': {
    id: 'producer-attribution',
    title: 'Producer, derived',
    what:
      'Which component wrote a row, worked out from the shape of the row itself: its type and which metadata keys it carries. There is no source column on events, so this is inference, not a record.',
    why:
      'Two producers write into the same table with very different timing, and a statistic that blends them is a statistic about nothing. Splitting them is also the fastest way to see one producer stop: the split goes lopsided hours before any heartbeat threshold trips.',
    healthy:
      'A split that matches what is happening in the world. Poller rows dominate while people are playing; ingest rows arrive on the emitter’s cadence regardless.',
    whenRed:
      'Treat a surprising attribution as a question about the row shape, not as proof about the producer. Wherever this appears it is labelled derived for that reason.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'ingest-lag-by-producer': {
    id: 'ingest-lag-by-producer',
    title: 'Ingest lag by producer',
    what:
      'The same inserted_at minus created_at gap as poller lag, split by attributed producer over 24 h and 7 d.',
    why:
      'Rows from /api/gs-ingest are stamped at very close to now, so their lag is near zero by construction. Rows from the poller carry a log-line time and are minutes old on arrival. One number over both is an average of two unrelated things.',
    healthy:
      'Ingest rows within a couple of seconds. Poller rows at the poller-lag figures: median under 30 s, p90 under 60 s over 24 h.',
    whenRed:
      'A rise on the ingest side points at the API or the network from the game box. A rise on the poller side points at SFTP or the log file. They almost never move together, and when they do, suspect the database.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'voice-speak-latency': {
    id: 'voice-speak-latency',
    title: 'Voice speak latency',
    what:
      'voice_lines.spoken_at minus queued_at, as p50, p90 and max over 24 h and 7 d, split by line kind.',
    why:
      'It is the Companion’s real round trip, and it degrades before the queue-age gauge on the overview notices: that gauge only reacts once a line has been stuck for 10 minutes. This shows the trend on the way there.',
    healthy: 'p50 within a few seconds while players are online, since the plugin polls every few seconds.',
    whenRed:
      'Rising latency with a healthy heartbeat is the plugin speaking slowly or failing on some lines. Compare kinds: if one kind is slow and the others are not, the problem is in what that kind contains, not in the pump.',
    link: { href: RUNBOOK_PANELS, label: 'Voice queue panel' },
  },
  'quiet-gap': {
    id: 'quiet-gap',
    title: 'The quiet gap',
    what:
      'The longest stretch inside the window with no events row of any kind, with its start and end. A window with no rows at all is reported as one gap covering the whole window, which is the honest answer.',
    why:
      'An outage that started and ended while nobody was looking leaves exactly this fingerprint and no other. No heartbeat threshold catches a gap that had already closed by the time somebody opened the page.',
    healthy:
      'Gaps that match when nobody was playing. Overnight silence in a small community is normal; a two hour gap in the middle of an evening is not.',
    whenRed:
      'Line the gap up against the session data. If people were online through it, something stopped recording, and the start of the gap is the timestamp to take to a journal.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'deed-progress': {
    id: 'deed-progress',
    title: 'Great Deeds close to firing',
    what:
      'Unachieved Great Deeds ranked by percent of their threshold, computed from aggregate player_stats by the same pure functions the site and the bot use.',
    why:
      'It is the one panel that is about what is coming rather than what broke. It also gives an unannounced-deed finding its context: a deed at 99 percent is about to fire, and a silent evening after it fires is a real symptom.',
    healthy: 'Not a health signal. Anything above 90 percent is worth watching in the next session.',
    whenRed:
      'A deed that reads over 100 percent and is still unachieved means the evaluator has not run. Check the milestone-evaluator loop on the overview.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'next-gathering': {
    id: 'next-gathering',
    title: 'Next gathering',
    what:
      'The soonest Discord scheduled event with a start time in the future, from the discord_events table, with its interested count.',
    why:
      'The site advertises it on the front page, so a stale or seeded row here is publicly wrong rather than privately wrong.',
    healthy: 'A row that matches a real scheduled event in Discord, synced by the events-sync loop.',
    whenRed:
      'A gathering the site shows and Discord does not have is usually a seeded demo row, which the demo-data check on the overview reports separately.',
    link: { href: RUNBOOK_CHECKS, label: 'Consistency checks' },
  },
  'heartbeat-freshness-gauge': {
    id: 'heartbeat-freshness-gauge',
    title: 'Freshness against threshold',
    what:
      'For each component, the age of its last success as a fraction of its own stale threshold. A gauge rather than a chip, so 10 percent used and 90 percent used look different.',
    why:
      'Healthy at 90 percent of the window is a component about to fail, and the overview’s chip cannot tell you that: it shows the same green either way.',
    healthy: 'Under 70 percent of the threshold. Past 90 percent, expect the chip to turn on the next render.',
    whenRed:
      'A gauge that sits high and never resets means the producer is reporting only just inside its window, which usually means the host is under load or the network path is slow.',
    link: { href: RUNBOOK_THRESHOLDS, label: 'Freshness thresholds' },
  },
  'free-plan-budget': {
    id: 'free-plan-budget',
    title: 'Free-plan budget',
    what:
      'An estimate of how much of Supabase’s free plan is used: 500 MB of database and 1 GB of storage. Database size is estimated from exact row counts times a documented per-row constant, because the exact figure needs SQL that PostgREST cannot run.',
    why:
      'The free plan is the real constraint on this project’s life, and nothing else in the system watches it. Launch week is also the week the growth rate changes.',
    healthy: 'Under 70 percent of 500 MB, with a projection that does not reach the ceiling inside 30 days.',
    whenRed:
      'Read the growth panel next to it to see which table is doing it. Note the total is labelled an estimate everywhere it appears, on the number itself, because it is one.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'table-growth': {
    id: 'table-growth',
    title: 'Rows added per day',
    what:
      'Rows added per day over the last 7 d for the tables that grow with play: events, sessions, voice_lines and chat_lines. Player positions are excluded because that table is fixed size and overwrites in place.',
    why:
      'It converts the budget from a number into a date. It is also the fastest way to see a producer double-writing, which shows up here days before it shows up as a size problem.',
    healthy: 'A rate that tracks how much people actually played that day.',
    whenRed:
      'A flat rate on a busy day means something stopped writing. A spike on a quiet day means something is writing twice, and the duplicate rows are worth finding before they become the estimate.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'bucket-window': {
    id: 'bucket-window',
    title: 'Buckets and windows',
    what:
      'Charts on these pages bucket by UTC hour over 24 h or by UTC day over 7 d. Rows outside the window are dropped rather than folded into an end bucket, so the first and last bars are not inflated.',
    why:
      'The bot’s recap hour is in a local zone and the buckets are not, so the two will not line up. Saying which is which on the number is the only way to keep that from becoming a bug report.',
    healthy: 'Not a measurement. Every chart on these pages names its window.',
    whenRed:
      'If a chart disagrees with a count somewhere else, check the windows before the data. 24 h ending now and today in local time are different questions.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'partial-bucket': {
    id: 'partial-bucket',
    title: 'The current bucket is partial',
    what:
      'The newest bar on any of these charts covers a period that has not finished yet, and is drawn muted to say so.',
    why:
      'An hour that is eight minutes old always looks like a collapse in activity. Muting it is cheaper than explaining it every time.',
    healthy: 'Not a measurement.',
    whenRed:
      'Never read the last bar as a trend. Compare the two before it if you want to know whether tonight is quiet.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  percentile: {
    id: 'percentile',
    title: 'Median, p90 and max',
    what:
      'The middle value, the value 90 percent of samples come in under, and the worst one. Computed with linear interpolation over the samples in the window, and null when there are no samples at all.',
    why:
      'A median says what a normal case looks like and hides the tail; a p90 is where the complaints come from; the max is the worst thing that happened and is often one row. Reading all three at once is what keeps a single outlier from being mistaken for a trend.',
    healthy: 'Depends on the measurement. Every panel that shows percentiles states its own target.',
    whenRed:
      'An empty window reads "no data" rather than zero, deliberately: zero would be a confident claim about something never measured. A max far above the p90 is one bad sample, not a pattern.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
  'insight-severity': {
    id: 'insight-severity',
    title: 'Insight cards',
    what:
      'A ranked strip of the few things most worth saying about the current data, computed from the same tables the rest of the page reads. Ranked by severity first, then recency, with a fixed tie-break so two renders a second apart do not reshuffle.',
    why:
      'The overview is a wall of facts. This is the paragraph on top: one line of headline, one line of evidence with its numbers and its window.',
    healthy:
      'A strip that says the last 24 h look normal, with the numbers it checked. It never renders empty, because a strip that vanishes reads as a broken strip.',
    whenRed:
      'Each card carries its own evidence and its own explanation. A critical card is the same fact as a finding in Needs attention, said earlier and shorter.',
    link: { href: RUNBOOK, label: 'Ops runbook' },
  },
} as const satisfies Record<string, GlossaryEntry>;

/** Every id currently in the registry. Adding an entry widens this union. */
export type GlossaryId = keyof typeof GLOSSARY;

// ── THE TAB REGISTRIES ──────────────────────────────────────────────────────
//
// The three v2 tabs were built in parallel, and each one wrote its captions into
// a private module beside its components rather than into this file, so that two
// tracks appending to one object literal never became a merge conflict. Each of
// those modules said in its own header that folding it in later was a copy and
// paste. This is that fold, done at integration: the files moved to lib/ops/
// (pure data belongs beside the registry that indexes it, not under components/)
// and are joined here.
//
// WHY IT MATTERS RATHER THAN BEING TIDINESS. The glossary index at the foot of
// the overview says it holds "every component, check, watchdog target and
// measurement on these pages". With three sets sitting outside it that sentence
// was false by 48 entries, and the half of the job the index exists for, reading
// every caption once before launch night instead of hunting the button that owns
// it, could not reach the three tabs where most of the numbers are.
//
// The sets stay separate objects for two reasons: each is its tab's to own, and
// the category an entry lands in is then the set it came from rather than a
// prefix convention that 48 already-shipped ids would have had to be renamed to
// follow.
//
// IDS ARE UNIQUE ACROSS ALL FOUR SETS, and `glossaryIdCollisions()` below is how
// that is proven rather than assumed. Nine entries collided when the sets first
// met: the explain track had written captions for numbers the other tabs had not
// shipped yet, and the tab that shipped the number wrote a better one (it names
// the column, the env var and the file). The rendered copy won every time, the
// dead copy was deleted, and the one genuine cross-tab clash, `relay-backlog` on
// both Coming up and Performance, was renamed on the Coming up side to
// `relay-cursor`, which is what its title already said it was.
const TAB_SETS: { category: GlossaryCategory; entries: Record<string, GlossaryEntry> }[] = [
  { category: 'activity', entries: ACTIVITY_GLOSSARY },
  { category: 'horizon', entries: HORIZON_GLOSSARY },
  { category: 'performance', entries: PERF_GLOSSARY },
];

/** id to category, for the tab sets only. Built once at module load. */
const TAB_CATEGORY_BY_ID: Map<string, GlossaryCategory> = new Map(
  TAB_SETS.flatMap((set) =>
    Object.keys(set.entries).map((id) => [id, set.category] as [string, GlossaryCategory]),
  ),
);

/**
 * Every id registered more than once across the four sets, with where it was
 * seen. Empty is the contract; lib/ops/glossary.test.mjs asserts it.
 *
 * A duplicate id is not a cosmetic problem: `glossaryEntry()` would silently
 * return whichever set is consulted first, so one of the two captions would be
 * unreachable, and the index would print the winner twice under two headings.
 */
export function glossaryIdCollisions(): { id: string; sets: string[] }[] {
  const seen = new Map<string, string[]>();
  const record = (id: string, where: string) => {
    const at = seen.get(id);
    if (at) at.push(where);
    else seen.set(id, [where]);
  };
  for (const id of Object.keys(GLOSSARY)) record(id, 'shared');
  for (const set of TAB_SETS) for (const id of Object.keys(set.entries)) record(id, set.category);
  return [...seen.entries()]
    .filter(([, sets]) => sets.length > 1)
    .map(([id, sets]) => ({ id, sets }));
}

/**
 * Look an entry up by id, across the shared registry and all three tab sets.
 * Returns undefined for an id that is not registered, so a page can decide
 * between rendering nothing and rendering a placeholder rather than crashing a
 * whole panel over a missing caption.
 */
export function glossaryEntry(id: string): GlossaryEntry | undefined {
  const shared = (GLOSSARY as Record<string, GlossaryEntry>)[id];
  if (shared) return shared;
  for (const set of TAB_SETS) {
    const hit = set.entries[id];
    if (hit) return hit;
  }
  return undefined;
}

/** Every entry from every set, sorted by title. For the glossary index panel. */
export function allGlossaryEntries(): GlossaryEntry[] {
  const all: GlossaryEntry[] = [
    ...Object.values(GLOSSARY as Record<string, GlossaryEntry>),
    ...TAB_SETS.flatMap((set) => Object.values(set.entries)),
  ];
  return all.sort((a, b) => a.title.localeCompare(b.title));
}

// ── Grouping, for the glossary index at the foot of the overview ───────────
// Derived from the id prefix rather than stored on the entry, so GlossaryEntry
// keeps the exact shape three other tracks already render against.

export type GlossaryCategory =
  | 'component'
  | 'check'
  | 'watchdog'
  | 'architecture'
  | 'concept'
  | 'activity'
  | 'horizon'
  | 'performance';

/** Human labels and one line of framing per category, in display order. */
export const GLOSSARY_CATEGORIES: { id: GlossaryCategory; label: string; blurb: string }[] = [
  {
    id: 'concept',
    label: 'States, columns and measurements',
    blurb: 'What the words on these pages mean, and what each number is measured over.',
  },
  {
    id: 'component',
    label: 'Components and bot loops',
    blurb: 'One per row in the health roster, including the seven loops inside the Discord bot.',
  },
  {
    id: 'check',
    label: 'Consistency checks',
    blurb: 'One per finding that can appear under Needs attention, whether or not it has fired.',
  },
  {
    id: 'watchdog',
    label: 'The off-PC watchdog',
    blurb: 'What wakes somebody up when this page is not open, and what it deliberately never pages about.',
  },
  {
    id: 'activity',
    label: 'The What fired tab',
    blurb: 'The merged timeline, the volume chart and the silence panels, and what each one is counting.',
  },
  {
    id: 'horizon',
    label: 'The Coming up tab',
    blurb: 'Countdowns, queues and cursors: everything that has not happened yet and the clock it is waiting on.',
  },
  {
    id: 'performance',
    label: 'The Performance tab',
    blurb: 'Delay, latency and cost, each against the threshold the page judges it by.',
  },
  {
    id: 'architecture',
    label: 'Architecture',
    blurb: 'Zones, transports and components on the architecture tab.',
  },
];

/**
 * Which group an entry belongs to: the tab it was written for, when it came
 * from one of the tab sets, and otherwise its id prefix.
 *
 * The tab lookup comes first because those 48 ids carry no prefix. Prefixing
 * them would have been the other way to do this and would have renamed every id
 * three already-shipped tabs cite by hand.
 */
export function glossaryCategory(id: string): GlossaryCategory {
  const fromTab = TAB_CATEGORY_BY_ID.get(id);
  if (fromTab) return fromTab;
  if (id.startsWith('component:') || id.startsWith('bot-subloop') || id.startsWith('subloop-')) {
    return 'component';
  }
  if (id.startsWith('check:')) return 'check';
  if (id.startsWith('watchdog')) return 'watchdog';
  if (id.startsWith('arch:')) return 'architecture';
  return 'concept';
}

/** Every entry grouped for display, categories in order, entries by title. */
export function glossaryByCategory(): {
  id: GlossaryCategory;
  label: string;
  blurb: string;
  entries: GlossaryEntry[];
}[] {
  const all = allGlossaryEntries();
  return GLOSSARY_CATEGORIES.map((c) => ({
    ...c,
    entries: all.filter((e) => glossaryCategory(e.id) === c.id),
  })).filter((g) => g.entries.length > 0);
}

/**
 * How many distinct conditions the consistency checks can report.
 *
 * DERIVED, not typed. The overview used to carry the literal 16 in three places
 * and it was wrong in its vocabulary: lib/ops/consistency.ts holds thirteen
 * check FUNCTIONS, which between them return sixteen distinct Finding ids,
 * because several report one of two or three mutually exclusive conditions.
 * Counting the registry is the only count the page can take without importing
 * the checks themselves, and lib/ops/glossary.test.mjs pins it to the ids it
 * scans out of consistency.ts, so a new condition either moves this number on
 * its own or fails the test.
 */
export const CONSISTENCY_CONDITION_COUNT: number = Object.keys(GLOSSARY).filter((id) =>
  id.startsWith('check:'),
).length;
