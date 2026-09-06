# Ops Cockpit v2: the plan

**Status:** spec + scaffolding landed 2026-09-06. Five builder tracks work from
this document. `docs/OPS-COCKPIT.md` remains the runbook for the system as it
exists (health model, watchdog, auth, backups); this file is the plan for what is
being added on top of it and does not restate it.

**What the owner asked for, verbatim:**

> "love the operations page. would love explanations of what each thing is,
> perhaps drop down or hover menus. would love even deeper analytics and insights
> on what fired, what's coming up, performance, etc. feel free to go a little
> crazy."

Three requests, and they decompose cleanly into work that does not overlap:

1. **Explanations.** Every number gets a caption you can open in place.
2. **Deeper analytics.** Three new tabs: what fired, what is coming up, how fast
   it all is.
3. **Insight, not just data.** A strip at the top of the overview that reads the
   same data and says the one thing worth saying about it today.

**Hard boundary, unchanged and non-negotiable.** The cockpit is observational.
Nothing on any of these pages restarts, deletes, wipes, applies, rotates, or
posts anything. Every read is bounded. If a new panel cannot be grounded in a
table that exists, it does not ship.

---

## 1. Tab structure

Five routes, one auth model, one nav.

| Route | Tab label | The question it answers | Owner |
|---|---|---|---|
| `/admin/ops` | Overview | Is the pipeline working right now, and what has drifted? | `explain` |
| `/admin/ops/activity` | What fired | What did the system actually do, and when? | `activity` |
| `/admin/ops/horizon` | Coming up | What is scheduled, queued, or about to fire? | `horizon` |
| `/admin/ops/performance` | Performance | How long does each hop take, and how much room is left? | `performance` |
| `/admin/ops/architecture` | Architecture | How does it all connect? (reference, not a signal) | architect, done |

`/admin/ops/login` keeps no nav: there is nothing to navigate to until the cookie
is valid.

### Auth: copy these eleven lines, do not invent a variant

Every new page uses **exactly** the check the overview uses. It is already in the
three scaffolded pages; keep it verbatim.

```tsx
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { COOKIE_NAME, verifySession } from '@/lib/ops/auth';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const store = await cookies();
  if (!verifySession(store.get(COOKIE_NAME)?.value)) {
    redirect('/admin/ops/login');
  }
  // ...
}
```

Why it is safe to copy rather than factor into a helper: `verifySession()` fails
closed when `OPS_PASSWORD` is unset (`lib/ops/auth.ts`), and `redirect()` must be
called from the page's own render to work. A wrapper that returned a boolean
would let a future page forget the redirect and render anyway. Eleven duplicated
lines that cannot fail open beat one clever helper that can.

`export const dynamic = 'force-dynamic'` is required on every page: these read
live data under the service role and must never be prerendered or cached.
(Route Segment Config still supports it in Next 16 because `cacheComponents` is
off in `next.config.ts`. If that ever changes, all five pages change together.)

`metadata` gets `title: { absolute: 'Eilif · Ops <Tab>' }`. The
`robots: noindex, nofollow, nocache` comes from `app/admin/ops/layout.tsx` and
covers the whole segment; do not re-declare it.

---

## 2. File ownership. No two tracks touch the same file.

| Track | Owns, and only this |
|---|---|
| **architect** (done) | `docs/OPS-COCKPIT-V2.md`, `components/ops/OpsNav.tsx`, `components/ops/Explain.tsx`, `components/ops/charts/{Sparkline,Bars,Gauge}.tsx`, `lib/ops/glossary.ts`, `lib/ops/window.ts` + `window.test.mjs`, `lib/ops/client.ts`, `app/admin/ops/architecture/page.tsx` (nav mount only) |
| **explain** | `app/admin/ops/page.tsx`, `components/ops/Explain*.tsx` (new files only; `Explain.tsx` itself is handed over as-is), `lib/ops/glossary.ts` (fill in the registry) |
| **activity** | `app/admin/ops/activity/**`, `lib/ops/activity.ts` + `activity.test.mjs`, `components/ops/activity/**` |
| **horizon** | `app/admin/ops/horizon/**`, `lib/ops/horizon.ts` + `horizon.test.mjs`, `components/ops/horizon/**`, `services/discord-bot/src/heartbeat.js` (and no other bot file) |
| **performance** | `app/admin/ops/performance/**`, `lib/ops/performance.ts` + `performance.test.mjs`, `components/ops/performance/**`, `db/2026-09-06_ops_db_size_rpc.sql` (optional, UNAPPLIED) |
| **insights** | `lib/ops/insights.ts` + `insights.test.mjs`, `components/ops/insights/**` |

**Handover notes on the two shared-looking cells.**

- `lib/ops/glossary.ts` ships with the shape, two worked entries and the lookup
  helpers. `explain` **appends entries**. It does not change `GlossaryEntry`,
  `GlossaryId`, `glossaryEntry()` or `allGlossaryEntries()`: three other tracks
  render `<Explain entry={GLOSSARY['...']} />` against those types.
- `explain` owns `app/admin/ops/page.tsx` outright, including mounting
  `<InsightsStrip/>`. `insights` never edits that file. The contract between them
  is §4, frozen now so both sides can code against it today.

**Files nobody in this work may edit:** `lib/ops/db.ts`, `lib/ops/health.ts`,
`lib/ops/consistency.ts`, `lib/ops/watchdog.ts`, `lib/ops/auth.ts`,
`lib/ops/redact.ts`, `lib/ops/route-heartbeat.ts`, `components/ops/StateChip.tsx`,
`components/ops/format.ts`, `components/ops/OpsControls.tsx`, anything under
`app/api/**`, and every `services/**` file except the one named above. If a track
believes it needs a change in one of those, it stops and reports instead.

**Before editing any file, run `git diff --stat -- <file>`.** If it carries
somebody else's uncommitted change, stop and report.

**Known concurrent work, as of 2026-09-06 09:10 CT.** A separate track (boss
"tellings") has uncommitted changes in `app/boss/[slug]/page.tsx`, `lib/data.ts`,
`lib/types.ts`, `docs/ARCHITECTURE.md`, `components/boss/**`,
`db/2026-09-06_boss_tellings.sql`, `scripts/tellings-site.test.mjs` and, inside
the bot, `services/discord-bot/src/index.js`, `retelling.js`, `package.json`,
`README.md` and `.env.example`. None of those is on any v2 track's list.
`horizon` in particular touches `services/discord-bot/src/heartbeat.js`, which
that track has **not** modified, and must not drift into `index.js`, which it
has.

---

## 3. The layering rule, and why it is not negotiable

```
app/admin/ops/<tab>/page.tsx      Server Component. Auth, layout, composition.
app/admin/ops/<tab>/data.ts       The reads. Imports lib/ops/client.ts. Not tested.
lib/ops/<tab>.ts                  PURE compute. No I/O, no 'server-only'. Tested.
lib/ops/<tab>.test.mjs            Plain .mjs through tsx, next to the module.
components/ops/<tab>/*.tsx        Presentational. Props in, markup out.
```

`lib/ops/client.ts` imports `server-only`, which **throws when loaded outside a
React Server Component**, including under `tsx`. So a `lib/ops/<tab>.ts` that
imports the client, directly or transitively, cannot be unit-tested at all, and
`npm test` will tell you so with a confusing error. Keep the math free of I/O and
this never comes up. This is the same split `health.ts` (pure, tested) and `db.ts`
(server-only, untested) already use; it is why `computeState()` has 67 assertions
behind it.

Every pure computation you add lives in `lib/ops/*.ts` with a `*.test.mjs` beside
it, in the repo's style: plain assertions, a passing counter, one summary line.
`npm test` discovers them with no wiring.

---

## 4. The `<InsightsStrip/>` contract (frozen)

`insights` builds it. `explain` mounts it at the top of the overview, directly
under the header and above the roll-up ribbon.

```tsx
// app/admin/ops/page.tsx  (explain)
import { InsightsStrip } from '@/components/ops/insights/InsightsStrip';

<InsightsStrip nowMs={nowMs} />
```

```tsx
// components/ops/insights/InsightsStrip.tsx  (insights)
export interface InsightsStripProps {
  /** The page's render clock, so every panel agrees on "now". Pass data.nowMs. */
  nowMs: number;
  /** Maximum cards to render. Default 4. Values above 6 are clamped to 6. */
  limit?: number;
  /** Extra wrapper classes. The overview passes none today. */
  className?: string;
}

export async function InsightsStrip(props: InsightsStripProps): Promise<React.JSX.Element>;
```

Five rules that make this safe to mount blind:

1. **It fetches its own data.** No props carry rows. `explain` plumbs nothing.
2. **It renders its own `<section>`**, including its own heading and its own
   empty state. `explain` wraps it in nothing.
3. **It never throws.** Every read is wrapped in `safeRead`; a total failure
   renders one card saying the insights could not be computed, and the rest of
   the overview is unaffected.
4. **It renders something for every state.** Nothing worth flagging renders a
   single quiet card, not `null`: a strip that vanishes reads as a broken strip.
5. **It costs at most 6 queries and 400 ms.** It runs them in one
   `Promise.all`, and it is inside the overview's own 3 s budget, not beside it.

`InsightsStrip` is the **only** export `explain` may import from
`components/ops/insights/`. Everything else in that folder is private to
`insights`.

---

## 5. What the scaffolding gives you

All of this exists and compiles today. Use it; do not rebuild it.

### `components/ops/OpsNav.tsx` (Server Component)

```tsx
<OpsNav active="activity" />   // 'overview' | 'activity' | 'horizon' | 'performance' | 'architecture'
```

First element of every page. Costs no client JavaScript, which is why it takes
the active tab as a prop instead of calling `usePathname()`.

### `components/ops/Explain.tsx` (Client Component)

```tsx
import { Explain } from '@/components/ops/Explain';
import { GLOSSARY } from '@/lib/ops/glossary';

<Explain entry={GLOSSARY['poller-lag']} align="end" size="md" />
```

An info button that opens a panel with the five glossary fields. Keyboard
operable, closes on Escape, on an outside pointer press, and on focus leaving it;
focus returns to the trigger. No libraries, no portal.

**The panel is `position: fixed` and placed by measurement, and it has to stay
that way.** `components/ui/Card.tsx` is `overflow-hidden`, so an absolutely
positioned panel gets sliced off at the card edge (this was the first cut, and
the screenshot showed exactly half a popover). Fixed positioning escapes an
ancestor's overflow clipping; the trade is that the component measures the
trigger on open, shifts the panel back on screen, flips it upward when the room
below is under 220 px, caps its height to the space available, and re-places it
on scroll and resize. Do not "simplify" it back to `absolute`.

`align` is a preference for which edge to line up with, not a constraint: the
panel is pushed back on screen either way.

Verified by execution on 2026-09-06 (headless Chrome over the DevTools protocol,
against the scratch build): clicking the trigger sets `aria-expanded="true"`,
`aria-controls` matches the panel's id, the panel is `role="dialog"` with the
label `"<title>: what this measures"`, focus lands on the panel, all four field
terms render, and Escape removes the panel, resets `aria-expanded` and returns
focus to the trigger.

**Every track uses this.** A number with no caption is the thing the owner asked
us to fix, so a new panel ships with its glossary entries or it does not ship.

### `lib/ops/glossary.ts`

`GlossaryEntry` is `{ id, title, what, why, healthy, whenRed, link? }`. The five
fields have a discipline attached (see the file's own header): `what` is literal
and names the table, `healthy` carries a unit and a window, `whenRed` is the
first concrete action rather than a restatement of the symptom.

### `components/ops/charts/{Sparkline,Bars,Gauge}.tsx`

Inline SVG, server-rendered, no library, theme-aware through `currentColor` and
the Tailwind tokens in `app/globals.css`. Each takes a required `label` that
becomes its accessible name.

- `Sparkline`: one series, gaps stay gaps (a null breaks the line rather than
  drawing through a missing hour).
- `Bars`: one bar per bucket, three axis labels, `partial: true` mutes the
  current incomplete bucket, per-bar `<title>` for hover with no JavaScript.
- `Gauge`: `role="meter"`, colours at `warnAt` (0.7) and `dangerAt` (0.9),
  `valueText` is what the reader sees so it always carries its units.

**No other chart types.** If a panel wants a scatter or a stacked area, it wants
a table instead.

### `lib/ops/window.ts` (pure, 96 assertions)

Buckets, percentiles, and every formatter. Use these rather than writing your
own, so four tabs cannot disagree about what "last 24 h" means.

- `hourBuckets(nowMs, 24)`, `dayBuckets(nowMs, 7)`: UTC-aligned, oldest first,
  the last bucket partial (mark it `partial` in `Bars`). Buckets are UTC:
  `BUCKET_TZ` is exported so a page can say so next to the axis.
- `countInBuckets(timestamps, buckets)`, `groupIntoBuckets(rows, at, buckets)`:
  out-of-window rows are **dropped**, never folded into an end bucket.
- `percentile(values, p)`, `median`, `mean`: linear interpolation, empty set
  returns `null` so a page renders "no data" instead of a confident zero.
- `ageSecFrom`, `untilSecFrom`, `sinceIso`, `toMs`.
- `formatDurationSec`, `formatAgeSec`, `formatCountdownSec`, `formatCount`,
  `formatBytes`, `formatPercent`, `formatRatePerHour`, `windowLabel`.
- `WINDOW_24H_MS`, `WINDOW_7D_MS`, `ROW_LIMIT` (2000, the ceiling no single read
  may exceed).

### `lib/ops/client.ts` (server only)

```ts
import { opsServiceClient, safeRead } from '@/lib/ops/client';

const client = opsServiceClient();       // null when unconfigured, never a throw
const rows = await safeRead(async () => { /* one query */ }, []);
```

Exists so that four tracks do not each edit `lib/ops/db.ts`. Service role,
server side, read only. A `null` client means the page renders "database
unreachable", which is the honest signal, not a 500.

---

## 6. Rules every panel obeys

**Bounded reads.** Every query carries a time window **and** an explicit
`.limit()`. `limit` never exceeds `ROW_LIMIT` (2000). Prefer
`select('*', { count: 'exact', head: true })` when you only need a count: it
transfers no rows.

**Pin the leading index column.** `events` has
`events_type_created_idx (type, created_at desc)` and
`events_character_created_idx`, `sessions` has `sessions_joined_at_idx` plus two
partial open-session indexes, and `events_inserted_at_idx` serves the relay
cursor. A read that filters on `type` and a `created_at` range uses one index
scan; the same read without the type pin degrades to a sequential scan as the
table grows. `lib/ops/db.ts` has the worked EXPLAIN for this; copy the shape.

**Parallel, not sequential.** One `Promise.all` per page. Ten awaited queries in
a row is ten round trips to Supabase's US region and it is the only realistic way
to blow the render budget.

**Never assume healthy on absence.** The v1 health model's central rule applies
to every new number: no data is "no data", never zero and never green. `percentile`
returning `null` is doing this for you; do not `?? 0` it away.

**Say the window on the number.** "18 events (last 24 h)", not "18 events". Every
figure on these pages carries a unit and a window, in the text, not only in a
section heading three cards up.

**Copy.** These pages are for one admin, so the Norse register does not apply:
plain operator English. The no-em-dash rule does still apply. Use commas, colons
and periods.

**Steam ids.** Public rows carry fingerprints; the cockpit runs under the service
role and may show full ids, exactly as the identity mismatch panel does today.
No new redaction rules.

---

## 7. Performance budget

**The whole page renders in under 3 s against production with no player online.**
Measured on a scratch build (`docs/STRESS-TEST.md` §2, copied not symlinked)
pointed at the production database.

**The baseline, measured 2026-09-06 against production with 0 players online**
(production `next build`, `next start`, one warm-up then three timed
authenticated GETs, wall clock including transfer):

| Page | Run 1 | Run 2 | Run 3 | Bytes |
|---|---|---|---|---|
| `/admin/ops` (today, before any v2 work) | 1.20 s | 1.17 s | 1.26 s | 87.6 kB |
| `/admin/ops/activity` (scaffold) | 0.006 s | 0.006 s | 0.007 s | 30.8 kB |
| `/admin/ops/horizon` (scaffold) | 0.006 s | 0.005 s | 0.005 s | 31.1 kB |
| `/admin/ops/performance` (scaffold) | 0.007 s | 0.006 s | 0.005 s | 30.9 kB |
| `/admin/ops/architecture` | 0.012 s | 0.010 s | 0.011 s | 134.3 kB |

Read the overview row as the real constraint: `loadOpsData()` alone already
spends about **1.2 s** of the 3 s, all of it in Supabase round trips from this
machine. That leaves roughly **1.8 s** for everything v2 adds to that page, which
is why `<InsightsStrip/>` is capped at 6 queries in one `Promise.all`. The three
new tabs start from nothing and get the whole budget to themselves.

Per-page allowance:

| Page | Queries | Server render budget |
|---|---|---|
| Overview (existing `loadOpsData` + InsightsStrip) | existing + 6 | 3 s total, of which InsightsStrip 400 ms |
| Activity | 8 | 2.5 s |
| Horizon | 8 | 2.5 s |
| Performance | 10 | 2.5 s |

If a panel cannot fit, it drops the panel, not the budget. The owner will sit on
the overview for the whole of launch night; a cockpit that takes six seconds to
answer "is it working" is not an ops page.

**How to measure** (each track re-measures its own page and reports the number):

```bash
# One scratch copy per track, built against production, GET only.
S=<your scratchpad>/site
tar cf - --exclude=node_modules --exclude=.git --exclude=.next --exclude='.env' \
  --exclude='services/*/.env' --exclude=.vercel -C ~/Projects/valheim-dashboard . \
  | (mkdir -p $S && cd $S && tar xf -)
cp -al ~/Projects/valheim-dashboard/node_modules $S/node_modules
set -a; . ~/Projects/valheim-dashboard/.env.local; set +a
export OPS_PASSWORD="scratch-only-$RANDOM$RANDOM"   # NOT the production one
cd $S && ./node_modules/.bin/next build && ./node_modules/.bin/next start -p 3407
# then mint a cookie with lib/ops/auth signSession() under that scratch password
# and time an authenticated GET. Warm it once, then time three.
```

Never run `next build` inside `~/Projects/valheim-dashboard`. Never POST
anything at production, including the login form: mint the cookie with
`signSession()` instead.

---

## 8. The data inventory

Everything below exists in `db/`. This is the menu each tab orders from; nothing
in the panel lists that follow reaches beyond it.

| Table | Time columns | What it can answer |
|---|---|---|
| `events` | `created_at` (producer time), **`inserted_at`** (insertion order, applied 2026-09-05) | What fired and when; poller lag is `inserted_at - created_at`; `type` in join/leave/death/boss_kill/...; `metadata` jsonb carries `identity`, death cause, source hints |
| `sessions` | `joined_at`, `left_at`, `duration_minutes` | Attendance, concurrency by hour, open-session leaks |
| `players` | `first_seen_at`, `last_seen_at`, `title_updated_at` | Roster, `is_online`, `current_title`, `steam_id`, `discord_id` |
| `player_stats` | `updated_at`, `gs_updated_at` | Per-viking totals, `gs_reporter`, `gs_stats` jsonb (`_flags` = poison guard), `gs_baseline` |
| `voice_lines` | `queued_at`, `spoken_at` | Speak latency, queue depth, `kind` (ambient/event/manual), `status` (queued/spoken), `meta` (`source: dawn`, `template`, `world_day`) |
| `milestones` | `achieved_at`, `announced_at` | Great Deeds: which fired, announce lag, and how close the unachieved ones are (`metric`, `threshold`) |
| `title_history` | `awarded_at` | Title churn per viking, title flap detection |
| `poty_history` | `awarded_at` | Player of the day, per recap; proof a recap ran |
| `oaths` | `sworn_at`, `announced_at` | Oath volume, announce lag, `source` (discord/ingame), `match_status` |
| `pins` | `created_at` | Map pin volume, `kind`, `by_character_name`, `day` |
| `gallery_photos` | `posted_at` | Gallery ingest volume, `content_type`, `width`/`height` |
| `chat_lines` | `created_at` | Chat mirror volume. **Counts only, never the text** |
| `player_positions` | `updated_at` | Position writer liveness. **Never render coordinates** |
| `bosses` | `killed_at` | Progression, `fight_stats` jsonb (with a `rev` for compare-and-swap), `players_present` |
| `discord_events` | `starts_at`, `ends_at`, `updated_at` | The next gathering, `status`, `user_count` |
| `identity_claims` | `expires_at`, `consumed_at`, `announced_at` | Claims about to expire, confirmations owed |
| `ops_heartbeats` | `last_success`, `last_attempt`, `updated_at` | Component liveness and the bot's `metrics` jsonb. **One row per component: there is no history here** |
| `ops_alerts` | `since`, `last_alert_at` | Watchdog state, `signature`, `alert_count`, next re-alert window |
| `server_status` | `updated_at` | Emitter freshness, `current_players`, `world_day` |

**Three things this inventory does not have, and the panels must not pretend
otherwise:**

1. **No heartbeat history.** `ops_heartbeats` is one row per component, upserted.
   You cannot chart a component's uptime over a week. You can chart the *effects*
   of its work (rows it wrote, bucketed) and that is the honest substitute.
2. **No HTTP request log.** Vercel's function logs are not in the database. Any
   "requests per minute" panel would be fiction.
3. **No exact database size over PostgREST.** See §11 (performance).

---

## 9. Tab specs

### 9.1 Overview, owned by `explain`

**Route:** `/admin/ops` (existing page, enriched)

**The questions:** unchanged from v1 (is it working, what has drifted) plus a new
one: *what does this number mean, and what do I do about it?*

**What changes on the page:**

1. `<OpsNav active="overview" />` as the first element.
2. `<InsightsStrip nowMs={nowMs} />` under the header, above the roll-up ribbon.
3. An `<Explain/>` beside every measurement already on the page. Minimum set,
   which is also the minimum set of glossary entries to write:

| Where | Glossary entry |
|---|---|
| Roll-up ribbon | `state-healthy`, `state-degraded`, `state-stale`, `state-disabled`, `state-unknown`, and `stale-vs-unknown` (shipped) |
| Needs attention heading | `consistency-check`, `severity-levels` |
| Component table header, per column | `last-success`, `cadence-vs-stale`, `component-version` |
| `server-emitter` row | `inferred-vs-measured` |
| `companion-voice` row | `quiet-hall-rule` |
| Bot loops section | `bot-subloop`, `subloop-unknown-when-parent-down` |
| Voice queue card | `voice-queue-age` |
| Identity mismatches card | `steam-mismatch`, `binding-release` |
| Dashboard/Database rows | `render-liveness` |

4. A **glossary index** at the foot of the page (or a `Resources` row linking to
   one): `allGlossaryEntries()` rendered as a definition list, so the same text is
   reachable without hunting for the button that owns it.

**Data sources:** none new. The page keeps `loadOpsData()` exactly as it is.
Do not add queries to `lib/ops/db.ts`; that file is frozen for this work.

**Pure functions:** none new beyond the glossary data itself.

**Copy discipline for the entries:** `what` names the table or signal
(`ops_heartbeats.last_success`, `server_status.updated_at`), `healthy` carries a
unit and a window, `whenRed` names the first thing to check and where it lives.
The two shipped entries are the model.

---

### 9.2 What fired, owned by `activity`

**Route:** `/admin/ops/activity`

**The questions:** What did the system actually do in the last 24 h and the last
7 d? When was it busy and when was it silent? Which producer wrote it? And what
fired in the data but never reached anybody?

**Minimum analytics (all of these, at least):**

1. **Firing timeline.** One merged, newest-first list of the last 24 h across
   `events`, `voice_lines` (spoken), `milestones` (achieved), `title_history`,
   `poty_history`, `oaths`, `pins`, `gallery_photos`, `bosses` (killed). Each row:
   time, what fired, who, and which producer wrote it. Limit 200 rendered.
   *The insight:* one place to answer "what happened at 21:40 last night".
2. **Volume by hour (24 h) and by day (7 d).** `Bars` over
   `countInBuckets(events.created_at, hourBuckets(now, 24))`, with a type filter
   (all / join / leave / death / boss_kill). Current bucket marked `partial`.
   *The insight:* the shape of an evening, and whether tonight matches it.
3. **Breakdown by type.** Counts per `events.type` for both windows, side by side,
   with the delta. *The insight:* "deaths are double last week's" is a sentence
   about balance, and it is the first thing that changes at 20 players.
4. **Producer split.** Rows attributed to the log poller versus `/api/gs-ingest`
   versus the bot. Derive from what the row carries (`type` plus `metadata` keys),
   and label the attribution as derived, because there is no `source` column.
   *The insight:* if one producer stops writing, this goes lopsided hours before a
   heartbeat threshold trips.
5. **Fired but never announced.** `milestones` with `achieved_at` set and
   `announced_at` null; `oaths` the same; `identity_claims` consumed but not
   announced. With ages. *The insight:* the deed happened and nobody heard about
   it, which is invisible on every other page.
6. **Deaths.** Count by cause from `events.metadata` for both windows, and deaths
   per viking. *The insight:* death penalty and difficulty tuning, on real data,
   in launch week.
7. **Voice.** Lines by `kind` and `status` over 7 d, spoken versus queued versus
   still waiting, and the `meta.source` split (dawn versus ambient versus event).
   *The insight:* whether the hall's voice is actually speaking or just queueing.
8. **The quiet gap.** Longest stretch in the window with no `events` row at all,
   with its start and end. *The insight:* an outage nobody noticed leaves exactly
   this fingerprint, and no heartbeat threshold catches a gap that ended before
   anyone looked.

**Data sources:**

| Panel | Table, columns | Window | Limit |
|---|---|---|---|
| Timeline | `events(type, character_name, created_at, inserted_at, metadata)` | 24 h | 500 |
| Timeline | `voice_lines(kind, status, spoken_at, meta)` where `spoken_at` not null | 24 h | 200 |
| Timeline | `milestones(id, title, achieved_at, announced_at)` | 7 d | 50 |
| Timeline | `title_history(title, awarded_at, player_id)` | 7 d | 100 |
| Timeline | `poty_history(character_name, award_label, awarded_at)` | 7 d | 30 |
| Timeline | `oaths(character_name, source, sworn_at, announced_at)` | 7 d | 100 |
| Timeline | `pins(name, kind, by_character_name, created_at)` | 7 d | 100 |
| Timeline | `gallery_photos(posted_by, posted_at)` | 7 d | 100 |
| Buckets | `events(type, created_at)` | 7 d | `ROW_LIMIT` |

That is 9 reads; merge the two `events` reads into one 7 d read and bucket the
24 h subset in memory to hit the 8-query budget.

**Pure functions, `lib/ops/activity.ts`:**

```ts
export type FiredKind = 'join' | 'leave' | 'death' | 'boss_kill' | 'voice' | 'deed'
                      | 'title' | 'poty' | 'oath' | 'pin' | 'photo' | 'other';
export interface FiredRow { at: string; kind: FiredKind; label: string; who: string | null;
                            producer: Producer; detail?: string }
export function mergeTimeline(sources: {...}): FiredRow[];          // newest first, stable tie-break
export function attributeProducer(e: EventRowLike): Producer;       // 'log-poller' | 'gs-ingest' | 'bot' | 'unknown'
export function countByType(rows, types): Record<string, number>;
export function compareWindows(a: Record<string, number>, b: Record<string, number>): TypeDelta[];
export function deathCauses(rows: EventRowLike[]): { cause: string; count: number }[];
export function longestQuietGap(timestamps: string[], windowStartMs: number, nowMs: number):
  { startMs: number; endMs: number; sec: number } | null;
export function voiceBreakdown(lines: VoiceRowLike[]): VoiceSummary;
```

Every one of them pure, every one tested. `longestQuietGap` in particular needs
tests for the two edges that matter: a gap that runs to *now* (still open) and a
window with no rows at all (the whole window is the gap, and that is the correct
answer, not `null`).

**Components:** `components/ops/activity/{Timeline,VolumeChart,TypeDeltaTable,ProducerSplit,UnannouncedPanel,DeathCauses,VoicePanel,QuietGap}.tsx`.

---

### 9.3 Coming up, owned by `horizon`

**Route:** `/admin/ops/horizon`

**The questions:** What is scheduled to happen next, what is queued waiting to
happen, and what is close enough to a threshold that it will happen soon?

**Minimum analytics:**

1. **Next recap.** The bot's evening cron (`0 <RECAP_EVENING_HOUR, default 23> * * *`,
   in `process.env.TZ` which defaults to `America/Chicago`,
   `services/discord-bot/src/recap.js`) as a countdown, plus when the last
   one actually ran (newest `poty_history.awarded_at`). *The insight:* a recap
   that did not run is otherwise invisible until somebody notices Discord was
   quiet.
2. **Next dawn line.** Dawn fires on every 3rd world day to a populated hall
   (`DAWN_EVERY_DAYS = 3`, `voice.js`). From `server_status.world_day` and the
   bot's `lastDawnDay`: the next world day that will speak, and whether today's
   already did.
3. **Ambient voice cadence.** One ambient line per ~120 minutes of online time,
   with a global min-gap (`VOICE_MIN_GAP_MS`, default 30 min). Show minutes
   accumulated against the cadence and time owed on the gap. *The insight:* "why
   has Eilif not said anything in two hours" has a real answer.
4. **Relay cursor and backlog.** The bot's cursor
   (`state.relay.lastInsertedAt` / `lastEventAt`) against the newest
   `events.inserted_at`: how many rows are waiting to be relayed to `#server`,
   and how far behind in seconds. *The insight:* this is the exact failure the
   2026-09-06 rehearsal found (21 of 43 rows silently never posted). A backlog
   that grows while the bot reads healthy is the only visible symptom.
5. **Great Deeds closest to firing.** Reuse `computeAggregates()` and
   `summarizeMilestones()` from `lib/milestones.ts` (pure, already tested) over
   `player_stats`: the unachieved deeds sorted by percent of threshold, with the
   value still needed. *The insight:* what the hall is about to earn tonight.
6. **Next boss.** Lowest `sort_order` boss with `is_killed = false`, plus how long
   since the previous one fell. *The insight:* progression pace.
7. **Next Discord gathering.** `discord_events` with `starts_at > now`, soonest
   first, with `user_count`. `lib/next-gathering.ts` already does this shape.
8. **Expiring soon.** `identity_claims` unconsumed with `expires_at` inside 24 h.
   *The insight:* a player who is about to have to start the link over.
9. **Voice queue.** Every line still `status = 'queued'`, oldest first, with age
   and `kind`. The overview shows the oldest age only; this shows the queue.
10. **Watchdog next window.** From `ops_alerts`: current state, signature, how
    long it has been in it, and when the 6 h re-alert is next allowed.
11. **Loops that are on, and the ones that are not.** From the bot heartbeat's
    `subLoops`: which loops are enabled, when each last ticked, and which are
    disabled by flag. The overview says the state; this says the schedule.

**Data sources:**

| Panel | Source | Window | Limit |
|---|---|---|---|
| Recap, dawn, cadence, relay cursor, loop schedule | `ops_heartbeats` row `discord-bot`, `metrics.schedule` (new, see below) plus `metrics.subLoops` | current | 1 row |
| Recap actually ran | `poty_history(awarded_at)` order desc | 7 d | 5 |
| Relay backlog | `events(inserted_at)` count where `inserted_at > cursor`, head-only | since cursor | count only |
| Deeds | `milestones(*)` + `player_stats(<AGGREGATE_STAT_COLUMNS>)` | all | 20 / 40 |
| Next boss | `bosses(name, biome, sort_order, is_killed, killed_at)` | all | 10 |
| Gathering | `discord_events(name, starts_at, status, user_count)` where `starts_at > now` | next 30 d | 10 |
| Claims | `identity_claims(code, expires_at, consumed_at)` where unconsumed and expiring | 24 h | 50 |
| Voice queue | `voice_lines(kind, queued_at, meta)` where `status = 'queued'` | all | 100 |
| Watchdog | `ops_alerts` key `watchdog` | current | 1 row |

**Pure functions, `lib/ops/horizon.ts`:**

```ts
export function nextCronRun(nowMs: number, hour: number, tz: string): number | null;   // next daily HH:00 in tz
export function nextDawnWorldDay(worldDay: number, lastDawnDay: number | null, everyDays?: number):
  { day: number; isToday: boolean };
export function ambientCadence(onlineMinutes: number, cadenceMinutes: number, minGapRemainingSec: number):
  { minutesOwed: number; blockedByGapSec: number; ready: boolean };
export function relayBacklog(cursorIso: string | null, newestInsertedAt: string | null, pending: number, nowMs: number):
  { behindSec: number | null; pending: number; state: 'idle' | 'working' | 'behind' | 'unknown' };
export function upcomingDeeds(defs, aggregates, limit): DeedProgress[];  // wraps summarizeMilestones
export function expiringSoon<T>(rows: T[], at: (r: T) => string | null, nowMs: number, withinMs: number): T[];
export function nextWatchdogAlertAt(lastAlertAtIso: string | null, reAlertHours?: number): number | null;
```

`nextCronRun` is the one with real edges: a timezone that is not the server's,
and the day the hour has already passed. Implement it with `Intl.DateTimeFormat`
and the `timeZone` option (no library) and test it across a DST boundary in
`America/Chicago`, both directions. If it cannot be made correct in an hour, fall
back to reporting the configured hour and its zone as text, plus the time since
the last recap, and say plainly that the countdown is not shown. A wrong
countdown is worse than none.

**Components:** `components/ops/horizon/{NextUp,DawnCard,VoiceCadence,RelayBacklog,DeedsClose,NextBoss,Gathering,ExpiringClaims,VoiceQueue,WatchdogWindow,LoopSchedule}.tsx`.

#### The one bot change this track may make

`horizon` may edit **`services/discord-bot/src/heartbeat.js` and no other bot
file**, to add a `metrics.schedule` block so the cockpit can read the bot's own
schedule instead of guessing at it.

Why that file and only that file: `createHeartbeatSender()` already wraps every
outgoing heartbeat, so merging a computed block there reaches the cockpit without
touching `index.js` (which is where the metrics object is assembled today, and
which is out of bounds).

Shape to add, merged only for `component === 'discord-bot'`:

```js
metrics.schedule = {
  recapHour,            // parseInt(process.env.RECAP_EVENING_HOUR || '23', 10)
  recapTz,              // process.env.TZ || 'America/Chicago'   (index.js const TZ)
  recapsStart,          // process.env.RECAPS_START || null
  voiceCadenceMinutes,  // 120, the CADENCE_MINUTES constant
  voiceMinGapMs,        // Number(process.env.VOICE_MIN_GAP_MS || 1800000)
  dawnEveryDays,        // 3
  onlineMinutes,        // state.voice.onlineMinutes
  lastDawnDay,          // state.voice.lastDawnDay
  relayCursor,          // state.relay.lastInsertedAt ?? state.relay.lastEventAt
  loopsEnabled: { ... } // the env gates, as booleans
};
```

Three constraints on that change:

- **Read only, best effort, never throws.** The state file is read with the same
  expression `state.js` uses (`new URL('../state.json', import.meta.url)`),
  inside a `try`, and a failure yields `schedule: null` rather than a heartbeat
  that does not send. A heartbeat that can break the bot is worse than a cockpit
  panel that says "the bot has not reported its schedule yet".
- **No secrets.** Only cadence numbers, hours, zone names and booleans. Every
  string still goes through the existing `sanitize()`.
- **The cockpit must render correctly without it.** The bot is deployed by hand
  on the host and will not have restarted when the cockpit ships. Every panel
  that reads `metrics.schedule` renders "the bot has not reported this yet"
  when it is absent. That is the default state on day one and it must look
  deliberate.

The bot is **not** restarted by this work. Note in the handoff that the panels go
live at the next bot restart, which is Charlie's call.

---

### 9.4 Performance, owned by `performance`

**Route:** `/admin/ops/performance`

**The questions:** How long does each hop of the pipeline take? Is anything
getting slower? And how much of the free plan is left?

**Minimum analytics:**

1. **Poller lag.** `events.inserted_at - events.created_at` for poller-sourced
   types (join, leave, death), as median / p90 / max over 24 h and 7 d, plus a
   per-hour p90 sparkline. *The insight:* the delay a player feels between
   walking in and appearing on the site. This is the headline number of the tab.
2. **Ingest lag by producer.** The same statistic split by attributed producer,
   because gs-ingest rows land at real now and poller rows do not: one number over
   both is a blend of two different things. *The insight:* which half of the
   pipeline is slow.
3. **Announce latency.** `milestones.announced_at - achieved_at`,
   `oaths.announced_at - sworn_at`, and identity confirmations. p50/p90 over 7 d,
   plus the current oldest unannounced. *The insight:* how long between a thing
   happening and Discord hearing about it. The bot polls on a 2 min loop, so
   anything past a few minutes is a real backlog.
4. **Voice speak latency.** `voice_lines.spoken_at - queued_at`, p50/p90/max over
   24 h and 7 d, split by `kind`. *The insight:* the Companion's real round trip,
   which the queue-age gauge on the overview only sees when it is already bad.
5. **Heartbeat freshness against threshold.** One `Gauge` per component: age of
   `last_success` against `staleAfterSec` from the (read-only) `COMPONENTS`
   registry. *The insight:* "healthy" with 90% of the window used is a different
   fact from "healthy" at 10%, and today the page cannot tell them apart. Read
   the registry; do not edit `health.ts`.
6. **Free-plan budget.** Supabase free plan: **500 MB database, 1 GB storage.**
   Exact row counts per table (`head: true, count: 'exact'`), a per-table byte
   estimate, the total against 500 MB in a `Gauge`, and 7 d growth from
   `events.inserted_at` day buckets projected forward. Label the total an
   **estimate** everywhere it appears (see §11). Storage: sum of the `gallery` and
   `map` bucket listings, capped at 100 objects per bucket, labelled sampled if it
   hits the cap. *The insight:* the free plan is the actual constraint on this
   project's life, and nothing else in the system watches it.
7. **Table growth.** Rows added per day over 7 d for the tables that grow with
   play (`events`, `sessions`, `voice_lines`, `chat_lines`, `player_positions`
   is a fixed-size table and should be excluded, say so). *The insight:* what
   launch week costs, and how long until the ceiling.
8. **This page's own cost.** Wall-clock milliseconds for the render, the number
   of queries issued, and the number of rows read. Measure with
   `performance.now()` around the fetch block. *The insight:* the cockpit is
   allowed to be expensive, but not silently, and this is what proves the 3 s
   budget holds against real data.
9. **Data freshness ladder.** For each surface the site shows (roster, map frame,
   stats, gallery), the age of the newest row behind it. `lib/data.ts` already has
   `statsFreshness()` and `mapFreshness()`; reuse them, do not reimplement.

**Data sources:**

| Panel | Table, columns | Window | Limit |
|---|---|---|---|
| Poller lag | `events(type, created_at, inserted_at)` | 7 d | `ROW_LIMIT` |
| Announce latency | `milestones(achieved_at, announced_at)` | all | 50 |
| Announce latency | `oaths(sworn_at, announced_at)` | 7 d | 200 |
| Voice latency | `voice_lines(kind, queued_at, spoken_at)` | 7 d | `ROW_LIMIT` |
| Heartbeat gauges | `ops_heartbeats(component, last_success, status)` | current | all rows |
| Row counts | per table, `head: true, count: 'exact'` | all | count only |
| Growth | `events(inserted_at)`, `sessions(joined_at)`, `voice_lines(queued_at)` | 7 d | `ROW_LIMIT` each |
| Storage | Storage API `list()` on `gallery` and `map` | current | 100 each |

**Pure functions, `lib/ops/performance.ts`:**

```ts
export function lagSeconds(rows: { created_at: string; inserted_at: string | null }[]): number[];
export function lagSummary(values: number[]): { p50: number | null; p90: number | null; max: number | null; n: number };
export function announceLatency(rows, at: keyof T, announcedAt: keyof T, nowMs): LatencySummary;
export function estimateTableBytes(counts: Record<string, number>): { table: string; rows: number; bytes: number }[];
export function projectGrowth(perDay: number[], currentBytes: number, ceilingBytes: number):
  { bytesPerDay: number; daysToCeiling: number | null };
export function freshnessLadder(inputs): { surface: string; ageSec: number | null; state: 'fresh' | 'aging' | 'stale' }[];
```

`estimateTableBytes` carries its per-row constants as a documented table with the
reasoning for each one, and every caller labels the output an estimate.
`projectGrowth` returns `null` days when growth is zero or negative rather than
`Infinity`, and the page says "not growing" rather than printing a number.

**Components:** `components/ops/performance/{LagPanel,LatencyPanel,VoiceLatency,HeartbeatGauges,BudgetPanel,GrowthChart,RenderCost,FreshnessLadder}.tsx`.

---

### 9.5 Insights strip, owned by `insights`

**Mounted on:** the overview, by `explain`, per the frozen contract in §4.

**The question:** of everything true right now, what is the one thing worth
saying? The overview is a wall of facts. This is the paragraph on top.

**Minimum analytics.** Compute every candidate, rank them, render the top `limit`
(default 4). Each card: a one-line headline, one line of evidence with its
numbers and window, and an `<Explain/>`.

Candidate insights, each with the rule that fires it:

| Insight | Fires when |
|---|---|
| **Silent hall** | No `events` row in the last N hours while `server_status` says players are online. Something is on but nothing is being recorded. |
| **Relay behind** | `events.inserted_at` newer than the bot's relay cursor by more than 5 minutes, or more than 50 rows pending. |
| **Announce backlog** | Anything achieved or sworn more than 15 min ago and still unannounced. |
| **Busiest hour** | The peak hour in the last 24 h, with its count against the 7 d average for that hour. The one purely positive card. |
| **Deed imminent** | An unachieved Great Deed above 90% of its threshold. |
| **Death spike** | Deaths in the last 24 h more than 2x the 7 d daily average, with both numbers. |
| **New viking** | A `players` row first seen in the last 24 h. Launch week makes this the interesting one. |
| **Budget** | Estimated database size above 70% of 500 MB, or projected to reach it within 30 d. |
| **Quiet component** | A component whose `last_success` age is above 70% of its stale threshold but not yet stale. The early warning the state chip cannot give. |
| **Nothing to report** | Nothing above fired. Renders one card saying the last 24 h look normal, with the three numbers it checked. |

**Ranking.** `severity` first (`critical` > `warn` > `info`), then recency, then a
fixed tie-break by id so two renders a second apart do not reshuffle the strip.

**Data sources:** its own bounded reads, at most 6, in one `Promise.all`:
`events` (7 d, type + created_at + inserted_at, `ROW_LIMIT`), `ops_heartbeats`
(all rows), `server_status` (1 row), `milestones` + `player_stats` (for deed
progress), `players` (first_seen_at inside 24 h, limit 20), `oaths`
(unannounced, limit 50).

**Pure functions, `lib/ops/insights.ts`:**

```ts
export type InsightSeverity = 'critical' | 'warn' | 'info' | 'good';
export interface Insight { id: string; severity: InsightSeverity; headline: string;
                           evidence: string; glossaryId?: string }
export interface InsightInput { nowMs: number; /* ...plain rows, no client... */ }
export function buildInsights(input: InsightInput): Insight[];   // every candidate, unranked
export function rankInsights(all: Insight[], limit: number): Insight[];
```

`buildInsights` is one pure function over plain rows, which is what makes the
whole strip testable: the test feeds it a fabricated 24 h and asserts which cards
fire. Test the boundary of every rule (just under and just over each threshold)
and the empty case, which must return the "nothing to report" card and never an
empty array.

**Components:** `components/ops/insights/{InsightsStrip,InsightCard}.tsx` plus
`components/ops/insights/loadInsights.ts` for the reads (server-only, imports
`lib/ops/client.ts`).

---

## 10. Gates

Run in the repo, in this order, before calling a track done:

```bash
export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
npx tsc --noEmit
npm test
```

Both must be clean. **Do not run `npm run build` inside the repo**; build a
scratch copy per §7 when you need a real render.

Each track reports: files created or changed, what was verified by execution
(with numbers, not adjectives), its measured render time against production with
no player online, screenshots, and anything left undone.

---

## 11. Known limits, written down so no panel pretends otherwise

1. **No exact database size over PostgREST.** `pg_database_size()` needs SQL, and
   there is no RPC for it. The budget panel is therefore a **row-count estimate**
   and must say so on the number itself, not in a footnote. `performance` may
   write `db/2026-09-06_ops_db_size_rpc.sql` (headed `STATUS: UNAPPLIED`,
   idempotent, `security definer`, returning only two integers) as a future exact
   source, but **must not apply it**, and the page must render correctly whether
   or not it ever is.
2. **No heartbeat history.** `ops_heartbeats` is one upserted row per component.
   Uptime over time cannot be charted. Chart the rows a component wrote instead,
   and label that as what it is.
3. **Producer attribution is derived**, not recorded. There is no `source` column
   on `events`. Say "derived from the row shape" wherever it is shown.
4. **The bot's schedule is only as fresh as its last heartbeat**, and the new
   `metrics.schedule` block does not exist until the bot is restarted by hand on
   the host. Every panel that reads it renders an explicit "not reported yet".
5. **Storage bytes are sampled**, capped at 100 objects per bucket.
6. **`chat_lines` is counted, never rendered.** `player_positions` is used for
   liveness only; coordinates never appear. Both rules are inherited from v1 and
   are not negotiable.
7. **Timezones.** Buckets are UTC (`BUCKET_TZ`). The only place a local zone
   appears is the bot's recap hour, which is the bot's own configured zone and is
   printed with its name beside it.
