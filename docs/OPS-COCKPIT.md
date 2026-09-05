# Ops Cockpit (`/admin/ops`) — architecture + runbook

The ops cockpit is a **read-only** admin page that answers one question:
*"is the Eilif pipeline actually working right now, and if not, where did it
break?"* It replaces guessing from Vercel logs / systemd status / Discord
silence with one page.

**Hard boundary — observational only.** There is no restart, delete, wipe,
migration-apply, secret-rotate, or remote-command control anywhere in the
cockpit, and there must never be one. It reads state and renders it. If a
component is broken, the cockpit tells you *that* and *what to check*; a
human still SSHes in / restarts the systemd unit / re-runs the SQL.

It also never renders anything it isn't supposed to: no live player
coordinates, no raw private chat lines (counts/summaries only), no secret
values (tokens/keys are redacted before they're ever stored, see
"Redaction" below).

> **Roster changes, 2026-09-04.**
> - **`stats-parser` is RETIRED** (2026-08-23). Its job — reading `.fch` profiles for
>   `player_stats` — moved to the Emitter and the Companion Client. The `eilif-stats-parser`
>   systemd unit is stopped and the component should read `unknown`/never-reported, not `stale`;
>   its watchdog row is a leftover (see §7). Do not treat its silence as an incident, and do not
>   restart the unit — `scripts/launch-wipe.mjs` still hard-gates on it precisely because a
>   re-enabled retired service is the surprise nobody would expect.
> - **Two components are being added** by the in-flight instrumentation work: **`boards-plugin`**
>   (the in-game Living Boards sign writer, `plugins/eilif-boards/`) and **`companion-voice`** (the
>   server-side Companion's voice pump, `plugins/eilif-companion/`). Both live *inside the Valheim
>   server process*, so — exactly like `server-emitter` — their health is **inferred from what
>   reaches the dashboard**, never measured at the source. Expect their rows to carry the same
>   caveat: a stale signal is consistent with the plugin being dead, the server being down, or the
>   network path to Vercel being down, and the cockpit cannot tell you which. Their registry
>   entries, thresholds and this document's tables are the other agent's to fill in.

---

## 1. What each component's health signal means, and where it comes from

The cockpit does **not** assume a process "should" be running just because
it's in the roster below. Every state is derived from data the cockpit can
actually observe. Where that's impossible (the emitter, most notably), the
signal is explicitly labeled **inferred**, not measured.

| Component | Source | What "healthy" actually means |
|---|---|---|
| **server-emitter** | `server_status.updated_at` freshness | **Inferred, not measured.** The GsValheimStats Emitter mod runs inside the Valheim server process and cannot itself heartbeat the cockpit. So "healthy" here really means *"the last `/api/gs-ingest` POST we accepted from the server was recent"* — a stale `server_status` row is consistent with the emitter being down, the server being down, or the network path between them and Vercel being down. The cockpit cannot tell you which. |
| **discord-bot** | `ops_heartbeats` row for `component='discord-bot'` | The bot process is running its main loop and could reach the dashboard's heartbeat endpoint within the last cadence window. |
| **log-poller** | `ops_heartbeats` row for `component='log-poller'` | Same, for the SFTP log-tail service. |
| **map-snapshot** | `ops_heartbeats` row for `component='map-snapshot'` | Same, for the periodic WebMap `map.png`/`fog.png` puller. |
| **boards-plugin** *(live since the 2026-09-04 deploy; `/api/boards` writes the heartbeat after each authed poll)* | inferred from board writes reaching `/api/boards` | **Inferred, not measured** — same class as `server-emitter`. Runs inside the Valheim server process (`plugins/eilif-boards/`, EilifBoards 0.2.0). "Healthy" means the sign scan is still pulling board strings; silence cannot distinguish a dead plugin from a dead server. |
| **companion-voice** *(live since the 2026-09-04 deploy; `/api/voice` writes the heartbeat after each authed poll, so it only reports while players are online)* | inferred from `/api/voice` queue drain | **Inferred, not measured.** The server-side Eilif Companion's voice pump polls the queue and speaks lines in-game; the cockpit sees the queue being consumed, not the plugin itself. Note the voice half stays **dormant** (a normal, not-broken state) whenever `VoiceToken` is empty in the plugin cfg. |
| **dashboard-api** | the page itself rendered | Trivially "healthy" whenever the cockpit is being viewed at all — if this Server Component executed, the Next.js app is up. Its `version` is `process.env.VERCEL_GIT_COMMIT_SHA` (unset for `vercel deploy` CLI deploys — see below) falling back to a build-time constant; shows **"unknown"** rather than fabricating a version when neither is available. |
| **supabase** | a lightweight service-role query issued during this render | "Healthy" = Supabase answered a real query just now. This is a point-in-time check, not a heartbeat — there's no history, just this render's result. |
| **events-sync, gallery-ingest, oath-ingest, identity-link, identity-confirm, voice-queue, title-evaluator, milestone-evaluator** | the **discord-bot's own heartbeat `metrics.subLoops`** object, keyed by loop label | These are sub-loops inside the single discord-bot process, **not separate processes** — there is no way to observe them independently of the bot. Each entry carries `{ enabled, lastRunAt, ok, error }` as last recorded by that loop's own tick. If the discord-bot heartbeat itself is missing/stale, every sub-loop's state is **unknown** (not "disabled", not "healthy") — you cannot infer a sub-loop is fine just because the parent used to be. If a sub-loop's `enabled` flag is false, its state is **disabled**, which is a normal, not-broken state (e.g. `gallery-ingest` is intentionally off until `GALLERY_INGEST=1`). |

### The five states

`computeState()` (in `lib/ops/health.ts`, pure, unit-tested) returns exactly
one of:

- **healthy** — last success within `staleAfterSec`, not disabled, no error flag.
- **degraded** — reporting in, but its own last tick recorded an error (`ok: false`), or a consistency check flagged something about it.
- **stale** — last success exists but is older than `staleAfterSec`. This is the "was fine, now silent" state — the most common real failure mode (process died, network path broke, host rebooted and the systemd unit didn't come back).
- **disabled** — deliberately off (a feature flag says so), not a failure.
- **unknown** — no `lastSuccess` at all and not flagged disabled. Default state for anything the cockpit has never heard from — e.g. right after this migration is first applied, or a sub-loop map missing entirely because the parent bot heartbeat itself is missing. **`unknown` is not "assumed healthy"** — the health model never defaults to healthy in the absence of data; silence is silence, not a green light.

### Freshness thresholds (`COMPONENTS` registry, `lib/ops/health.ts`)

| Component | Expected cadence | Marked stale after |
|---|---|---|
| server-emitter | 120s | 300s |
| log-poller | 60s | 300s |
| discord-bot | 60s | 180s |
| map-snapshot | 300s | 900s |

These are deliberately looser than the literal send interval (e.g. the bot
sends every 60s but isn't "stale" until 180s of silence) to absorb one or two
missed ticks from a slow request without flapping the badge.

---

## 2. Consistency checks (`lib/ops/consistency.ts`)

These are cross-checks over the actual data, independent of the heartbeat
mechanism above — they catch problems a "the process is alive" signal can't,
like a process that's running but writing wrong/stale data. Each returns
`{ id, severity: info | warn | critical, title, detail, whatToDo }`, title in
plain operational language first (per the copy doctrine — Norse flavor stays
out of these).

| Check | What it tells you | Remediation |
|---|---|---|
| Stale `server_status` | The dashboard's "server is up" claim is based on old data — the emitter (or the server itself) may be down, or SFTP/network is broken. | Check the server host is up; check the Emitter mod is loaded (`LogOutput.log`); confirm `/api/gs-ingest` is receiving POSTs (Vercel function logs). |
| `players.is_online = true` with no recent join/leave presence | A player is marked online but nothing has confirmed that recently — usually a session that never got closed (crash, ungraceful disconnect) or a poller that stopped updating presence. | Check the log poller heartbeat; if it's healthy, look for a missing "left" line in the raw log; a stuck session may need manual correction in Supabase. |
| Open sessions (`left_at is null`) older than ~6h | A session is still "open" long after any real play session would have ended — the poller likely missed the leave event. | Same as above; these rows quietly poison playtime totals if left uncorrected. |
| Emitter roster vs `is_online` set disagreement | The GsValheimStats Emitter's authoritative online roster (from `/api/gs-ingest`) doesn't match who the dashboard currently shows online — the two ingestion paths (log poller vs emitter) have diverged. | Prefer the emitter (authoritative); investigate why the poller's view differs — usually a missed log line or a stale session (see above). |
| Stale map snapshot | The WebMap image on `/map` is older than expected — `map-snapshot` may be down or SFTP to the host may be failing. | Check the `map-snapshot` heartbeat/state; verify SFTP creds against the host; check `.map-snapshot-state.json` for the last successful pull. |
| Unannounced milestones (`achieved_at` set, no Discord announcement) | A Great Deed was achieved in the data but never posted to Discord — either the bot's `milestone-evaluator` sub-loop is down/erroring, or it's silently behind. | Check `milestone-evaluator`'s `lastRunAt`/`error` in the bot heartbeat; check `MILESTONES_ANNOUNCE` isn't disabled. |
| Unannounced identity confirmations (`consumed_at` set, `announced_at` null) | A player's `@Eilif I am <name>` claim was consumed by the in-game `/oath <CODE>` webhook but the bot never DMed them the confirmation. | Check the bot's `identity-confirm` sub-loop; a backlog usually means the bot was down for a stretch and needs one clean tick to drain. |
| Recent stat-poison flags (`player_stats.gs_stats._flags` present) | The stats guard caught a cross-contaminated or otherwise suspicious client stats POST and flagged it rather than trusting it blindly. | Not urgent by itself, but worth a look if it's a new/unexpected player — could mean two people are sharing a Steam profile, or a client bug. |
| Expired, unconsumed `identity_claims` | A claim code was minted (`@Eilif I am <name>`) but never used in-game before expiring — the player likely forgot the `/oath <CODE>` step. | Informational; no action needed unless a specific player reports being "still not linked." |
| Required migrations not recorded as applied | Probes `information_schema` for the tables/columns this feature set expects (`identity_claims`, `chat_lines`, `player_positions`, `ops_heartbeats`, the `players.steam_id` anon-read revoke) — if one is missing, that whole feature is silently running against a schema that isn't there yet. | Apply the missing migration file from `db/` (see "Migrations" in `AGENTS.md`) — Charlie applies these by hand, this check just tells you one hasn't landed. |
| Launch-only/demo flags still enabled | Surfaces the bot's non-secret pilot-override flags (`recapChannelIsServer`, `milestoneChannelIsServer`, `recapsStartPulledForward` in its heartbeat `metrics`) plus whether demo/seed data is still present in the DB — these are meant to be reverted at launch and are easy to forget. | Flip `RECAP_CHANNEL`/`MILESTONE_CHANNEL` back to `valheim`, restore `RECAPS_START` to the real launch date, wipe demo data — see the launch checklist in the Obsidian tracker. |

Every check above is derivable from data the cockpit actually has (heartbeat
metrics, table contents, `information_schema`). None of them are aspirational
— if a future check can't be grounded this way, it doesn't belong in
`lib/ops/consistency.ts`.

---

## 3. Auth model

Two independent secrets, two independent fail-closed paths:

- **`OPS_PASSWORD`** — gates human login to `/admin/ops` (and `/admin/login`).
  The session cookie is `HMAC-SHA256` signed **using `OPS_PASSWORD` itself as
  the key** — there is no separate signing secret to manage or leak. If
  `OPS_PASSWORD` is unset, login always rejects and any request to
  `/admin/ops` redirects to `/admin/login`; it never falls through to a 500
  or to an unauthenticated view of the page.
- **`OPS_HEARTBEAT_TOKEN`** — gates `POST /api/ops/heartbeat`, the endpoint
  the three producer processes (discord-bot, log-poller, map-snapshot) call
  on their own cadence with `Authorization: Bearer <token>`. If unset, the
  endpoint fails closed (401/503) and accepts **no** heartbeat regardless of
  what token is presented — there's no "accept anything if unconfigured"
  fallback in either direction.

Both variables are read server-side only; neither is ever sent to the
browser. The cockpit's own DB reads go through a dedicated **server-only**
service-role client (`lib/ops/db.ts`, new — `lib/supabase-server.ts` uses the
anon key and is the wrong client for this). There is no client-side data API
for ops data at all; the `/admin/ops` page is a `force-dynamic` Server
Component that fetches, evaluates, and renders in one pass server-side. The
only client-side interactivity is a small "Refresh" button that calls
`router.refresh()` and a "last refreshed" timestamp — no client bundle ever
touches `SUPABASE_SERVICE_ROLE_KEY`, `OPS_PASSWORD`, or `OPS_HEARTBEAT_TOKEN`.

## 4. Setting the env vars

Set these the same way every other secret in this project is set — **never
hardcoded, never committed**:

- **Locally:** copy `.env.local.example` → `.env.local`, fill in
  `OPS_PASSWORD` and `OPS_HEARTBEAT_TOKEN` with your own values (they don't
  need to match production; they just need to be non-empty for the cockpit
  to come out of fail-closed mode locally).
- **Vercel (prod):** Charlie sets `OPS_PASSWORD` and `OPS_HEARTBEAT_TOKEN` as
  encrypted Environment Variables in the Vercel project settings, scoped to
  Production (and Preview if you want the cockpit testable on preview
  deploys). This agent does not set Vercel env vars itself.
- **Producers** (`services/discord-bot/.env`, `services/log-poller/.env`,
  and whatever `map-snapshot` reads its env from): set `OPS_HEARTBEAT_TOKEN`
  to the **same value** as the dashboard's, so their `Authorization: Bearer`
  header matches. Each service's own `.env.example` documents this alongside
  its other vars.

If `OPS_HEARTBEAT_TOKEN` differs between a producer and the dashboard, that
producer's heartbeats 401 silently from the cockpit's point of view — its
component will just look **stale**, with no more specific error surfaced
(the producer logs the 401 client-side; the cockpit has no visibility into
*why* a heartbeat never arrived, only that it didn't).

## 5. Deploy order + rollback

Order matters because the heartbeat table and the cockpit's reads are two
separate deploys (a hand-applied SQL migration vs. a Vercel deploy):

1. **Apply the migration first:** `db/2026-07-11_ops_heartbeats.sql` against
   Supabase (Charlie, by hand — see "Migrations" in `AGENTS.md`). It's
   written to be idempotent, so this is safe to re-run.
2. **Set the env vars** (previous section) in Vercel and in each producer's
   `.env` on the host.
3. **Deploy the dashboard** (`vercel deploy --prod --yes --scope
   charlie-9292s-projects`, git author `charlie@blockspace.media` — see
   `AGENTS.md`). This ships `/api/ops/heartbeat`, `/admin/ops`, and
   `/admin/login`.
4. **Restart the producer services** (systemd) so they pick up the new
   `OPS_HEARTBEAT_TOKEN` / heartbeat code and start sending.
5. **Verify:** open `/admin/ops`, log in, confirm all three producers show
   **healthy** within their cadence window (not just "not stale yet") and
   that `dashboard-api`/`supabase` both read healthy.

**Rollback:** the cockpit is purely additive and read-only — rolling back
the dashboard deploy removes `/admin/ops` and the heartbeat endpoint but
touches nothing else (no write path anywhere else in the app depends on
`ops_heartbeats`). If a producer's heartbeat code causes a problem for the
producer itself, it's designed to fail silently (heartbeat send errors are
swallowed and logged, never thrown) — but if you need to fully back it out,
unset that producer's `OPS_HEARTBEAT_TOKEN` and it stops trying (logs once,
then no-ops). The `ops_heartbeats` table itself can be left in place
indefinitely with no effect on anything else; there's nothing that reads
from it except the cockpit.

---

## 6. What the cockpit can prove vs. what it only infers

Be precise with anyone reading this page — it is not a uniform "all green =
everything is fine" signal. Some rows are hard evidence; others are
best-effort circumstantial signal one step removed from the thing you
actually care about.

**Can prove (direct observation):**
- discord-bot, log-poller, and map-snapshot are alive and completed a tick
  recently (they said so, with a timestamp, over an authenticated channel).
- Supabase answered a real query just now.
- The dashboard app itself is running (you're looking at a rendered page).
- Specific data-integrity problems that are visible in the tables themselves
  (stale rows, open sessions, unannounced achievements, missing schema
  objects) — these are facts about the data, not inferences.
- A sub-loop *inside* the bot process ran and whether its own last attempt
  errored (it self-reports this in its own heartbeat metrics).

**Can only infer (circumstantial, one hop removed):**
- **The emitter mod is running inside the game server.** The cockpit has
  no channel to that process at all — "server-emitter: healthy" only means
  *"we recently got a POST that looks like it came from it."* A silent
  emitter, a silent-but-alive server, and a broken network path between
  Vercel and the game host all look identical from here: stale
  `server_status`.
- **A sub-loop's health when its parent bot heartbeat is itself stale or
  missing.** The cockpit reports `unknown` in that case rather than
  guessing, but be aware the *reason* is always "we lost the whole bot,"
  never "we specifically lost visibility into just this one loop."
- **Anything about the actual Valheim server process, the host machine, or
  GTXGaming's infrastructure.** No component here checks the game server's
  process health, CPU/memory, disk, or the SFTP host's uptime directly —
  every one of those is inferred transitively through whether a downstream
  producer is still getting data from them.
- **Whether a "healthy" component is doing the *right* thing**, only that
  it's doing *a* thing on schedule. A sub-loop can report `ok: true` every
  tick while doing something subtly wrong that a consistency check hasn't
  been written for yet — the health model is a liveness signal, not a
  correctness proof.

If you need to know the emitter or the game server itself is actually up,
this page cannot tell you that directly — you still need to check the host
(SSH, systemd status on the box, or the GTXGaming panel) or watch
`LogOutput.log`. The cockpit's job is to make the *downstream symptoms* of
those failures visible in one place fast, not to replace checking the
source.

---

## 7. The off-PC watchdog (`GET /api/ops/watchdog`)

Everything above is **pull-only**: it tells you the truth, but only when a
human opens the page. And every producer it watches runs on Charlie's PC.
Those two facts together are how a ~7h outage on 2026-08-17 and a 6-day
game-server outage both went unnoticed. The watchdog is the **push** half,
and deliberately shares none of that fate-sharing:

```
GitHub Actions (every 15 min)  →  Vercel /api/ops/watchdog  →  Supabase
                                          │                     (read)
                                          └→ Discord (bot-token REST)
```

Nothing in that chain touches the PC, so "the PC is off" is exactly the
case it still reports.

**Auth.** `Authorization: Bearer $WATCHDOG_TOKEN`, fail-closed in the same
style as the heartbeat route: unset env → `503` for everyone, wrong token →
`401`. Reads use the service-role client (both `ops_heartbeats` and
`ops_alerts` are service-role-only); the key is never returned or logged.

**What it evaluates** (`lib/ops/watchdog.ts`, pure + unit-tested in
`lib/ops/watchdog.test.mjs`) — it reuses `computeState()` from
`lib/ops/health.ts`, so "stale" means the same thing here as on the cockpit;
only the thresholds differ:

| Check | Cadence | Watchdog alerts after |
|---|---|---|
| discord-bot | 60s | 20 min |
| log-poller | 60s | 20 min |
| map-snapshot | 300s | 45 min |
| ~~stats-parser~~ | — | **retired 2026-08-23; removed from the registry and the heartbeat allowlist, and its `ops_heartbeats` row deleted, 2026-09-04.** |
| game-server (`server_status` freshness + `is_online`) | 120s | 20 min |

These are **looser than the cockpit's** on purpose. The cockpit's 180s bot
threshold is right for a human staring at the page; this path is polled
every 15 minutes by GitHub's best-effort scheduler, so any threshold at or
below the poll interval would fire on scheduler jitter alone — and a
watchdog that cries wolf gets muted, which puts us back where we started.
Worst-case detection latency is threshold + one ping interval (~35–60 min).

`is_online` is a secondary signal here: the ingest paths only ever set it
*true*, so freshness is what actually catches a dead server.

**Never-reported is never an alert.** A component with no heartbeat row (or
a row with no `last_success`) is `unknown`, exactly as on the cockpit —
with zero data we cannot tell "not deployed yet" from "down". Once it has
reported successfully once, later silence is `stale` and does alert. The
response lists these under `neverReported` so they are visible, not hidden.

**Anti-spam (`ops_alerts`, `db/2026-08-21_ops_alerts.sql`).** One row, key
`watchdog`, holds `state`, the unhealthy-set `signature`, `since`,
`last_alert_at`, `alert_count`. 96 pings a day must not become 96 messages,
so it posts only on: the ok→unhealthy transition, a change in *which*
components are unhealthy, or a re-alert at most every 6h while it stays
unhealthy — plus exactly one all-clear on the way back to healthy.

**A broken watchdog alerts on itself.** If Supabase is unreachable, the
`ops_alerts` row can't be read/written (usually: migration not applied), or
Discord rejects the post, the route answers `5xx` and does **not** persist
state — the GitHub job fails on any non-2xx and GitHub emails, and the next
run retries the same alert. Silent no-op is the one failure mode this
feature exists to eliminate.

**Manual use.** `curl -H "Authorization: Bearer $WATCHDOG_TOKEN"
https://valheim-dashboard.vercel.app/api/ops/watchdog` returns the full
evaluation (every check, its state, age, and a plain-English `detail`) plus
the alert decision. Add `?dry=1` to evaluate **without** posting to Discord
or touching the state row — use that when tuning thresholds.

**Env / secrets.** Vercel (Production): `WATCHDOG_TOKEN`, `DISCORD_TOKEN`,
`WATCHDOG_CHANNEL_ID`, optional `WATCHDOG_MENTION` (a `<@id>`/`<@&id>`
prefix — without it, mentions are suppressed entirely). GitHub repository
secret: `WATCHDOG_TOKEN`, the same value. Note GitHub disables scheduled
workflows after 60 days of repo inactivity — re-enable from the Actions tab
if that ever happens.
