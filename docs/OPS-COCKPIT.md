# Ops Cockpit (`/admin/ops`) — architecture + runbook

> **Reading order, 2026-09-06.** The cockpit is now **five tabs**, not one page.
> Sections 1 to 8 below describe the Overview and the machinery every tab shares
> (health states, consistency checks, auth, the watchdog). **Section 9** describes
> the five tabs and the rules a new panel obeys, **section 10** the explain layer
> and how to add a caption, **section 11** the measured render times. The design
> record for the v2 build is `docs/OPS-COCKPIT-V2.md`.

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
>   network path to Vercel being down, and the cockpit cannot tell you which. **Both landed on
>   2026-09-04** — their registry entries and thresholds are in the tables below, and the
>   quiet-hall rule that applies to `companion-voice` alone is in §1.

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

### Two panels below the roster (shipped 2026-09-05)

The table above answers *is each component alive*. Two panels under it answer
questions the roster cannot, because both are about a component that is alive
and still not doing its job.

**Identity mismatches** (last 7 days) lists every join where the Steam account
differed from the one bound to that character name — `events` rows of
`type='join'` carrying `metadata.identity='steam_mismatch'`, newest first.
Presence is still recorded for those joins; what is frozen is the name's oath,
pin and Discord-link writes, until an admin releases the binding. The panel
prints that release statement for you, one per distinct name in the window
(`releaseBindingSql`, `lib/ops/release-sql.ts`):

```sql
update players set steam_id = null where character_name = 'Bjorn Ironside';
```

Character names are unvalidated player input and this block is meant to be
pasted into Supabase under the service role, so the name is always quoted
through `sqlQuote()` — Postgres's own `''` escape — never interpolated raw.

**Voice queue** shows the age of the oldest line still waiting in `voice_lines`
while a viking is connected, and flips to **degraded** past
`VOICE_QUEUE_DEGRADED_SEC` (10 min). It is the second, independent signal for
the in-game voice half: the `companion-voice` heartbeat says the Companion is
*polling*, this says whether the lines it should be speaking are actually
leaving the queue. It reads "none" when nothing is queued **or** nobody is on —
the queue is only measured with players online.

**The quiet-hall rule, and why the two paths differ on it.** `companion-voice`
reports only when the Companion polls `/api/voice`, which it does only while
players are online — so an empty hall silences it by design. The cockpit can
tell an empty hall from a dead plugin, because it has the roster, and downgrades
that silence from `stale` to `unknown` (and only while `server_status` is itself
fresh: an aged emitter revokes the excuse, because the roster *is*
`server_status.current_players`, and a dead emitter would report an empty hall).
The off-PC watchdog has neither the roster nor a way to trust it, so it takes
the other honest option: `companion-voice` carries `alertsOnSilence: false`
(`lib/ops/watchdog.ts`) and its silence is reported with its age but never
paged on. A beat that arrives and says it *errored* still alerts. `boards-plugin`
gets no such excuse — it polls whether or not anybody is playing.

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
| Launch-only/demo flags still enabled | Surfaces the bot's non-secret pilot-override flags (`recapChannelIsServer`, `milestoneChannelIsServer`, `recapsStartPulledForward` in its heartbeat `metrics`) plus whether demo/seed data is still present in the DB — these are meant to be reverted at launch and are easy to forget. | Run `bash scripts/cutover-env.sh <World>` to read the diff, then `--apply` — it deletes `RECAP_CHANNEL`, `MILESTONE_CHANNEL`, `OATH_CHANNEL` and `BOSS_CHANNEL`, **sets** `TITLE_CHANNEL=valheim` (an absent one routes titles to `#server`, so removing it is wrong), sets `RECAPS_START`, drops the unit file's competing `Environment=RECAPS_START` line and repoints the poller's `MAP_REMOTE_DIR`. Demo data goes with `scripts/launch-wipe.mjs`. Both are `docs/LAUNCH-DAY.md` step 20 — the launch outline that used to live in the Obsidian checklist is superseded. |

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
| boards-plugin | 60s | 20 min |
| companion-voice | 60s | **never on silence** — see the quiet-hall rule in §1. A self-reported error still alerts. |
| ~~stats-parser~~ | — | **retired 2026-08-23; removed from the cockpit registry and the heartbeat allowlist and its `ops_heartbeats` row deleted 2026-09-04, and from the watchdog registry 2026-09-05.** |
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

---

## 8. Backups (schema + data) — audit backend-2

The Supabase project is on the **free plan**: no automated daily backups, no
PITR, and project deletion is irreversible (it removes any backups with it).
So the recovery story is assembled here, out of three pieces:

| Piece | Where | Cadence |
|---|---|---|
| **Schema** | `db/0000_initial_schema.sql` + the dated `db/*.sql` migrations, in git | on change (hand-applied) |
| **Data** | `~/valheim-db-backups/<YYYYmmdd-HHMM>/<table>.json` | nightly 03:30 CT, `eilif-db-snapshot.timer` |
| **World** | `~/valheim-world-backups/<World>-<YYYYmmdd-HHMM>/` | every 6h, `eilif-world-backup.timer` |

**The snapshot** (`scripts/db-snapshot.mjs`, run by
`services/eilif-db-snapshot.service`) asks PostgREST for the table list and
primary keys (`GET /rest/v1/`, OpenAPI), pages every public table 1000 rows at
a time ordered by PK, and writes one `<table>.json` per table (one row per
line), plus `storage-objects.json` and a `manifest.json` with row counts,
byte sizes and any errors. It keeps the newest **30** runs (`KEEP=`
overrides; `DEST=` moves the destination) and **exits non-zero if any table
fails**, so a partial snapshot shows as a `failed` unit rather than a green
one. It reads `SUPABASE_SERVICE_ROLE_KEY` from `.env.local` itself and never
prints or argv-passes it; snapshot dirs are `0700` because the dumps carry
player names, Steam/Discord ids and chat lines. It also doubles as a
keep-alive — free projects pause after 7 days without API activity.

Check it: `systemctl list-timers 'eilif-*'`,
`journalctl -u eilif-db-snapshot -n 40`, or read the newest `manifest.json`
(`ok: true` + `errors: []`).

**Restore.** Schema first, then rows:

1. Create/repair the project, then apply `db/0000_initial_schema.sql` followed
   by the dated `db/*.sql` files **in filename order** (there is no migration
   runner — they are hand-applied in the SQL editor, as always). Two things that
   replay does NOT get right, both found 2026-09-06:

   - **The eighth boss comes back with the wrong name.** The base schema seeds
     `('The Bog Witch', 'Deep North', 8)`; production runs **`Forsaken VIII`**, which
     is what `lib/gs-client.ts`, `/api/gs-ingest` and the boss tests key on. The first
     seven rows are correct. Fix it immediately after the replay:
     `update public.bosses set name = 'Forsaken VIII' where sort_order = 8 and name = 'The Bog Witch';`
   - **Not every dated file is meant to run.** `db/2026-08-24_loa_zero_baseline.sql`
     is headed `NOT APPLIED. Charlie's call.` and is a hand-targeted UPDATE against one
     player's baseline; `db/2026-09-06_death_ceiling.sql` is headed `STATUS: APPLIED 2026-09-06`
     and is Charlie's decision. A filename-order replay runs both. Today they are
     harmless on a rebuilt database (the row the first targets does not exist), but read
     each file's first line and skip the ones marked unapplied.

   Also: nothing in `db/` creates the **`map`** Storage bucket (only `gallery`, at the
   end of `db/2026-06-25_gallery_photos.sql`). Create `map` by hand before starting
   `eilif-map-snapshot`, or its uploads fail.
2. Insert the JSON back per table with the **service role** (RLS blocks anon
   writes; a `POST /rest/v1/<table>` with the file's array as the body works,
   or `insert … select * from json_populate_recordset` in the SQL editor).
   Insert parents before children — `players` before `sessions`,
   `player_stats`, `title_history`, `events`, `oaths` — then the rest. Every
   PK in this schema is a UUID (`gen_random_uuid()`) or a natural key
   (`identity_claims.code`, `player_positions.character_name`,
   `ops_heartbeats.component`, `ops_alerts.key`); there are **no sequences to
   re-bump**, so re-inserting rows with their original ids is enough and the
   foreign keys still line up.
3. `bosses`, `roadmap`, `milestones` and `server_status` are seed/state tables:
   restoring their JSON restores the *pilot/live* state, which may not be what
   you want after a wipe — `scripts/launch-wipe.mjs` is the tool for resetting
   them.

**Storage objects are NOT copied.** `storage-objects.json` is a *listing*
only — names, ids, sizes, mimetypes, timestamps for the `gallery` and `map`
buckets. The image bytes (~18 MB of gallery photos, ~1 MB of map frames) live
only in Supabase Storage, and Supabase's own database backups exclude Storage
too. If the project is deleted, those images are gone; the listing tells you
exactly what was lost and lets `gallery_photos` rows be re-pointed at
re-uploaded files. Downloading the bytes is a deliberate future item, not
something this timer does.

### Node runtime for the service units — audit services-6

`eilif-log-poller`, `eilif-discord-bot`, `eilif-map-snapshot` and
`eilif-db-snapshot` all run **`/opt/eilif/node`**, a copy of Node 20.20.2
taken out of nvm on 2026-09-04. They used to point straight at
`~/.config/nvm/versions/node/v20.20.2/bin/node`, where a routine
`nvm install 20` + `nvm uninstall 20.20.2` deletes the path and takes all of
them down at once with a silent `203/EXEC` restart loop. Each unit now also
has `ExecStartPre=/usr/bin/test -x /opt/eilif/node`, so a missing runtime
fails loudly instead of crash-looping.

**After an nvm upgrade the binary must be re-copied deliberately:**

```bash
sudo install -D -m 0755 ~/.config/nvm/versions/node/vXX.YY.Z/bin/node /opt/eilif/node
/opt/eilif/node -v
sudo systemctl restart eilif-log-poller eilif-discord-bot eilif-map-snapshot
```

Stay on Node **20** unless `services/*/node_modules` and the root
`node_modules` are rebuilt as well — sharp's native binaries
(`@img/sharp-linux-x64`, used by the map loop) are ABI-bound to the Node
major. `eilif-world-backup` runs bash + sftp and is deliberately independent
of both nvm and `/opt/eilif/node`, so a broken Node runtime can never stop
world backups.

---

## 9. The five tabs (cockpit v2, 2026-09-06)

Everything above section 8 describes the **Overview**, which was the whole
cockpit until 2026-09-06. It is now one of five tabs behind
`components/ops/OpsNav.tsx`, which every page mounts as its first element. There
is still no link to any of them from the public site, and the login page mounts
no nav because there is nothing to navigate to until the cookie is valid.

| Tab | Path | The question it answers |
|---|---|---|
| **Overview** | `/admin/ops` | Is anything wrong right now? A one-line verdict, then the insights strip, the open consistency checks, and the component roster that is the evidence for all three. |
| **What fired** | `/admin/ops/activity` | What did the pipeline actually do? One timeline merged from nine tables, volume by hour or by day, a producer split, death causes, the voice breakdown, an announce backlog and a silences panel. `?w=24h\|7d` and `?kind=` are the only inputs. |
| **Coming up** | `/admin/ops/horizon` | What has not happened yet, and what clock is it waiting on? The launch countdown against `docs/LAUNCH-DAY.md`, the next recap and dawn line, ambient voice cadence, the relay cursor, Great Deeds near their thresholds, titles about to change hands, scheduled gatherings, expiring claim codes and the bot's twelve loops with their next-due times. |
| **Performance** | `/admin/ops/performance` | How long does each hop take, and how much of the free plan is left? Pipeline delay percentiles, ingest rates, announce and speak latency, heartbeat pressure gauges, the freshness ladder, and the database and storage budget. |
| **Architecture** | `/admin/ops/architecture` | How does it all connect? Reference, not a live signal: zones, transports, a component index and four end-to-end journeys. |

Every tab is a `force-dynamic` Server Component that fetches, computes and
renders in one server pass. The only Client Components in the cockpit are the
explain popover, the glossary filter box, the refresh button and the activity
tab's window and kind toggles.

### The layering rule, and why every number is testable

Each tab is three files and the split is not negotiable:

- `lib/ops/<tab>.ts` is **pure**. Data in, data out, no imports from Next and no
  database. This is where percentiles, backlogs, countdowns and verdicts live,
  and it is why `lib/ops/<tab>.test.mjs` can assert on them without a running
  anything.
- `app/admin/ops/<tab>/data.ts` is the **only** place that reads. Bounded twice,
  by an explicit time window and an explicit `.limit()`.
- `app/admin/ops/<tab>/page.tsx` composes. It should read as a list of panels.

`lib/ops/client.ts` imports `server-only`, which is what makes an accidental
import of the service-role key from a Client Component a build error rather than
a runtime surprise. It is also why the pure modules may not import it.

### Windows, and the one copy of everything

Two windows exist and no others: **last 24 h** and **last 7 d**, both rolling,
both aligned to UTC buckets (`BUCKET_TZ`), because Vercel renders in UTC and this
workstation does not. Every number on every tab carries its unit and its window.

Anything four tabs would otherwise write four ways lives once:

| Shared | Where | What it settles |
|---|---|---|
| Buckets, percentiles, durations, ages, counts, byte sizes, UTC clock labels | `lib/ops/window.ts` | One definition of "last 24 h", one rounding rule, one clock format. `formatDurationSec` rounds to a single unit before splitting, because splitting first printed "1 m 60 s", "23 h 60 m" and "4 d 24 h" on three different tabs. |
| The relay's batch size, tick interval and behind-thresholds | `lib/ops/relay.ts` | The overview strip, Coming up and Performance judge the same relay by the same two numbers. They were declared three times and had already diverged once on `>` versus `>=` at exactly 50 pending rows. |
| `HEADROOM_WARN_FRACTION` | `lib/ops/health.ts` | The insights headroom card, `heartbeatPressure()`'s "tightening" band and the gauge warning mark soften the same cliff at the same point. |
| Chart primitives | `components/ops/charts/` | Inline SVG, no chart library, no CDN. |

`relayDrain()` in `lib/ops/horizon.ts` and `relayBacklog()` in
`lib/ops/performance.ts` are deliberately **not** one function. One is given a
bounded `count(*)` and estimates drain time; the other counts pending rows out of
the events already in memory and reports the age of the oldest. They were both
called `relayBacklog` until integration, which is exactly how two different
measurements end up quoted as one number.

### A read that fails must say so

`await client.from('events').select(...)` **resolves** when PostgREST refuses the
query. A revoked grant, a renamed column, a statement timeout and a 5xx all come
back as `{ data: null, error }` and throw nothing, so `safeRead(fn, [])` returns
`[]` and a page built on it says "nothing fired in the last 24 h" over a database
holding hundreds of rows it could not see. A quiet hall and a blind cockpit look
identical.

So every tab names its reads. `readTracker()` (`lib/ops/read-tracker.ts`,
re-exported from `lib/ops/client.ts`) collects the ones that did not come back,
and `components/ops/FailedReads.tsx` prints them at the top of the page, above
the numbers they invalidate. Coming up goes further and returns `null` rather
than `[]` per read, so each of its panels can say "this read failed" in its own
words. **A new read on any tab must be added through the tracker**, or it will
render its own failure as an empty table.

## 10. The explain layer

The owner's request was "explanations of what each thing is, perhaps drop down or
hover menus". It is four pieces:

- **`lib/ops/glossary.ts`** is the registry. Every entry has the same five
  fields: `what` it literally measures (naming the table or the file), `why` an
  operator should care, what `healthy` looks like *with its unit and window*,
  `whenRed` the first concrete thing to check, and an optional `link` into this
  runbook or `docs/LAUNCH-DAY.md`. Pure data, no JSX, no live values: it is read
  by a Client Component.
- **`components/ops/Explain.tsx`** is the info button beside a number. It opens a
  `role="dialog"` panel with those five fields, positioned `fixed` (a `<Card/>` is
  `overflow-hidden` and would slice an absolutely positioned one off at its
  edge). Escape closes it, focus returns to the trigger, and every listener is
  attached only while it is open.
- **`components/ops/ExplainTerm.tsx`** is a label with its caption attached:
  the browser's own tooltip on hover (the first sentence of `what`), the full
  panel on click. Hover and click are split on purpose: a hover-opened panel
  cannot be reached by keyboard and flickers across a table.
- **`components/ops/ExplainIndex.tsx`** is the whole glossary, filterable, at the
  foot of the Overview. It is the other half of the job: reading every
  consistency check once before launch night, rather than hunting for the button
  that owns one at 21:00.

### Four sets, one index

The three v2 tabs were built in parallel and each wrote its captions into a
private module beside its own components, so that two tracks appending to one
object literal never became a merge conflict. Those modules are now
`lib/ops/glossary-activity.ts`, `lib/ops/glossary-horizon.ts` and
`lib/ops/glossary-performance.ts`, and `lib/ops/glossary.ts` joins all four into
one index. Before that fold the index said it held "every measurement on these
pages" and was short by 48 entries, all of them on the tabs carrying most of the
numbers.

Ids are unique across all four sets and `glossaryIdCollisions()` proves it rather
than assuming it. Nine ids collided when the sets first met, because the explain
track had written captions for numbers the other tabs had not shipped yet; in
every case the tab that shipped the number had written the better caption (it
names the column, the env var and the file), so the rendered copy won and the
unreachable copy was deleted.

**Current shape: 151 entries.** 39 concepts and measurements, 17 components and
bot loops, 16 consistency conditions, 11 watchdog, 10 What fired, 19 Coming up,
19 Performance, 20 architecture.

### The gate: a caption is not optional

`lib/ops/glossary.test.mjs` reads the registries themselves and fails when
anything they hold has no entry:

- every key in `COMPONENTS` and `BOT_SUBLOOPS` needs `component:<key>`
- every `Finding` id **scanned out of the source of `lib/ops/consistency.ts`**
  needs `check:<id>` (scanned, not run: several checks report one of two or three
  mutually exclusive conditions, so no fabricated input can fire them all)
- every key in `WATCHDOG_TARGETS` needs `watchdog:<key>`

It also holds all 151 entries to the copy discipline: five non-empty fields, no
em dashes, no placeholders, no duplicate id, no duplicate title, and **every
`#anchor` a caption points at must exist as a heading in the document it names**,
which is why renaming a heading in this file fails the test rather than silently
turning 77 links into "the top of a 500 line document".

`CONSISTENCY_CONDITION_COUNT` is derived from the registry and pinned to that
scan, so the overview's "1 open, of 16 conditions checked this render" cannot
drift. It used to be a literal 16 typed in three places, and it was wrong in its
vocabulary: `consistency.ts` holds thirteen check *functions* returning sixteen
distinct condition ids.

### Adding to it

- **A new consistency check:** write it in `lib/ops/consistency.ts`, then add
  `check:<id>` to `lib/ops/glossary.ts`. The test fails until you do.
- **A new component or bot loop:** add it to `COMPONENTS` or `BOT_SUBLOOPS`, then
  `component:<key>`. Same gate.
- **A caption for one tab's own number:** add it to that tab's
  `lib/ops/glossary-<tab>.ts` and cite it from the panel. It reaches the index
  automatically, under that tab's heading.
- **A caption two tabs share:** it belongs in `lib/ops/glossary.ts`, cited as
  `GLOSSARY['<id>']` so a rename is a compile error rather than a blank popover.

## 11. Measured, 2026-09-06

A scratch copy of the repo built against the production database and served with
`next start`, read-only, with 0 vikings online. Budget is 3 s.

| Tab | Cold (first render after a server start) | Warm (median of five) |
|---|---|---|
| Overview | 1.31 s | 0.93 s |
| What fired | 0.18 s | 0.09 s |
| Coming up | 0.32 s | 0.21 s |
| Performance | 0.18 s | 0.10 s |
| Architecture | 0.02 s | 0.01 s |

The Overview is the slowest by an order of magnitude because it is the only tab
that runs the full `loadOpsData()` fetch, all sixteen consistency checks and the
insights strip's own six reads in one pass. Its 151-entry glossary costs bytes,
not queries.

Every page renders with no horizontal overflow at 390 px, no console errors, and
no em dashes in its rendered text; the screenshot harness asserts all three.

## 12. Where the design record lives

`docs/OPS-COCKPIT-V2.md` is the **plan** the five tabs were built from: the
frozen `<InsightsStrip/>` contract, the file-ownership split that let five tracks
work in parallel, the per-tab specs and, in its section 11, the known limits that
several captions link to directly. It is kept as written rather than folded in
here, because it is the record of what was decided and why, and because ten
glossary captions point into it.

**This file is the operational document.** Where the two disagree about what
shipped, this one is right.
