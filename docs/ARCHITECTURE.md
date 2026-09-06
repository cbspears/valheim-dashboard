# Eilif architecture

**Current as of 2026-09-05 (T-4).** This is the working description of the system that
exists today: what runs where, what writes what, how each thing is authenticated, and
which decisions are load-bearing. It replaces `docs/PROJECT.md`, which is kept as the
July record and is wrong about most of the runtime.

Written for whoever picks this up next (a person or a fresh Claude session). Every claim
below was checked against the code on 2026-09-05; where a fact is a live-host observation
rather than something in the repo, it says so.

Companion docs, all current:

| Doc | Covers |
|---|---|
| `AGENTS.md` | build/test/deploy commands, verification expectations |
| `CLAUDE.md` | session orientation, the launch-week state block |
| **`docs/LAUNCH-DAY.md`** | **the launch sequence of record for 2026-09-09 — 22 numbered steps, owners, commands, expected output, failure branches, rollbacks** |
| `docs/LAUNCH-WIPE.md` | the wipe procedure itself, the rehearsal, and what it does and does not touch |
| `docs/PACK.md` | minting the modpack and the Mac config bundle |
| `docs/OPS-COCKPIT.md` | `/admin/ops`, component health, redaction, watchdog runbook |
| `docs/STRESS-TEST.md` | the local twenty-viking load test and its local Supabase stack |
| `plugins/*/README.md`, `plugins/*/BUILD.md` | per-plugin design, hooks, and rebuild steps |

---

## 1. The three machines

Everything runs on one of three places, and almost every failure is a question of which.

**1. The GTX box** (GTXGaming, Windows, `191.101.30.229:6028`, SFTP on port 8822).
Runs the Valheim dedicated server, BepInEx 5.4.2333, and every server-side mod. We do
not have shell on it: the only access is the GTX web panel plus SFTP. Loaded plugin DLLs
are file-locked while the server runs, so any DLL swap happens in a stopped window.
Game build on the box is 0.221.12.

**2. Charlie's Linux PC** (`cbspears-linux`). Runs the three bridge services and two
timers under systemd. It is a desktop, not a server: it gets turned off, which is why
the watchdog lives on GitHub and not here.

**3. Vercel** (team `charlie-9292s-projects`). Serves the Next.js 16 dashboard and every
API route. Deploys are CLI only, and Vercel requires the git commit author to be
`charlie@blockspace.media` or the deploy is blocked with `TEAM_ACCESS_REQUIRED`.

Plus **Supabase** (project `syuwavxpmtdmxupxjzje`, free plan: no automated backups, no
PITR) and **GitHub Actions**, which runs one scheduled job.

---

## 2. Data flow

```
                        THE GTX BOX (Windows, Valheim 0.221.12 + BepInEx)
  +---------------------------------------------------------------------------+
  |  Eilif Companion (server)   oath/pin capture, voice, position lines, keys  |
  |  Eilif Boards (server)      polls /api/boards, paints sign ZDOs            |
  |  GsValheimStats Emitter     roster + world day + global keys               |
  |  WebMap                     map.png / fog.png on disk, HTTP on port 3000   |
  |  ValheimPlus, ServersideQoL, AzuCraftyBoxes                                |
  +---------------------------------------------------------------------------+
        |  BepInEx/LogOutput.log        |  map_data/<World>/    |  HTTPS out
        |  (SFTP pull)                  |  (SFTP pull)          |
        v                               v                       v
  +------------------+          +------------------+     POST /api/gs-ingest
  |  eilif-log-      |          |  eilif-map-      |     (source:'server',
  |  poller          |          |  snapshot        |      Bearer GS_EMITTER_TOKEN)
  |  (Linux PC)      |          |  (Linux PC)      |
  +------------------+          +------------------+
        |  POST /api/webhook            |  upload to Supabase Storage bucket `map`
        |  (x-webhook-secret)           |  current.webp, day frames,
        |                               |  frames-manifest.json, status.json
        v                               v
  +=========================================================================+
  |            VERCEL: Next.js dashboard + API routes                       |
  |   /api/webhook   /api/gs-ingest   /api/voice   /api/boards              |
  |   /api/status    /api/titles      /api/ops/*                            |
  +=========================================================================+
                     |  service-role writes / anon+RLS reads
                     v
              +---------------------+
              |  Supabase Postgres  |  20 tables, public-read RLS
              |  + Storage buckets  |  `gallery`, `map`
              +---------------------+
                     ^        ^
                     |        |
  +------------------+        +---------------------------------+
  |  eilif-discord-bot (Linux PC)                                |
  |  relay, boss announce, recap cron, milestones, titles,       |
  |  voice queue, gallery ingest, oath ingest, identity link,    |
  |  Discord scheduled-events sync                               |
  +--------------------------------------------------------------+
                     |
                     v
              Discord: #valheim (announcements) and #server (activity)

  PLAYERS' PCs (the r2modman pack)
  +---------------------------------------------------------------------------+
  |  EilifCompanionClient   -> POST /api/gs-ingest  source:'client-map'        |
  |                         -> POST /api/gs-ingest  source:'eilif-death'       |
  |  GsValheimStatsClient   -> POST /api/gs-ingest  source:'client'            |
  |  EilifPaths, ValheimPlus, PlantEverything, AzuCraftyBoxes, BepInExPack     |
  +---------------------------------------------------------------------------+

  GITHUB ACTIONS (every 15 min)  ->  GET /api/ops/watchdog (Bearer WATCHDOG_TOKEN)
                                     which reads Supabase and posts to Discord itself
```

Two facts the diagram cannot show but that explain most of the design:

- **Nothing on the GTX box can be told to do anything.** Server-side plugins reach out
  (the Emitter POSTs, Boards and the Companion's voice pump poll). The two bridge
  services pull over SFTP. There is no inbound control path at all.
- **The site is the only writer of record.** Every producer writes through an API route
  with the service-role key held on Vercel. No producer holds a Supabase key except the
  Discord bot, which needs one for the work it does that has no route (gallery uploads,
  title history, POTY history, voice queueing, milestone announce bookkeeping).

---

## 3. Components

### 3.1 Server-side, inside the Valheim process

| Mod | Version on the box | What it does for us |
|---|---|---|
| Eilif Companion | 0.3.2 (repo is at 0.3.3) | `/oath` and `/pin` capture into the log, voice pump, `[EILIF_POS]` position lines, world-key enforcement |
| Eilif Boards | 0.2.0 | polls `/api/boards`, writes leaderboard text onto sign ZDOs |
| GsValheimStats Emitter | 0.2.4 | POSTs roster, world day and Valheim global keys to `/api/gs-ingest` |
| WebMap | 2.7.1 | writes `map.png` and `fog.png` under `map_data/<World>/`, and serves an HTTP UI on port 3000 |
| ValheimPlus (Grantapher fork) | 0.9.17.1 | player cap, shout distance, config sync, dozens of QoL toggles |
| ServersideQoL, AzuCraftyBoxes | see `config/mods.ts` | quality of life; AzuCraftyBoxes is version-checked against clients |

Versions on the box are a live-host observation, not something the repo can prove. Every
row above was read off the box with `bash scripts/verify-restart.sh` on 2026-09-05, which
is also how you re-confirm them after any panel Stop then Start. That same run reported
game 0.221.12, panel death penalty **casual**, combat **default**, and port 3000 still
open.

### 3.2 eilif-log-poller (systemd, Linux PC)

`services/log-poller/`, `WorkingDirectory=.../services/log-poller`,
`ExecStart=/opt/eilif/node src/index.js`. Reference unit file in the repo is
`services/log-poller/valheim-log-poller.service`; **the live unit is
`eilif-log-poller.service`** and the repo copy still carries the old name.

Tails `BepInEx/LogOutput.log` over SFTP every `POLL_INTERVAL_MS` (default 20 s), parses
new bytes, and POSTs event objects to `/api/webhook`. Types it posts: `join`, `leave`,
`death`, `raid`, `oath`, `pin`, `pos`, `chat`, and `sync`. The parser also produces an
internal `heartbeat` type from the server's `Connections N ZDOS:` line; that never
reaches the webhook as itself, it is turned into an authoritative roster `sync`. A
timed `sync` also fires every `SYNC_EVERY_MS` (default 120 s).

Three behaviours worth knowing:

- **At-least-once delivery.** `tick()` snapshots the byte cursor before dispatch and
  restores it if anything throws, so a webhook 500 or a network blip re-reads the batch
  instead of skipping it. Duplicates beat losses; the webhook is written to absorb them.
- **Server liveness** (`src/liveness.js`). The live server writes a `Connections N ZDOS:`
  line roughly every 10 minutes even with nobody on, so a log that has not grown in
  `STALE_LOG_THRESHOLD_MS` (default 30 m) means the game server is down. A failed SFTP
  connect freezes the clock instead of advancing it, because a broken network is a
  different failure from a dead server. Down alerts re-fire every 6 h, backing off to
  every 24 h once the outage passes a day.
- **Chat mirror.** Shouts go to Discord from the poller directly, never through the bot.
  Preferred transport is `CHAT_DISCORD_WEBHOOK` (posts as the player), fallback is
  `DISCORD_TOKEN` plus `CHAT_CHANNEL_ID`. The bot does not have Manage Webhooks, so today
  it is the fallback path. Past both dedupe gates the same line is also mirrored to
  `/api/webhook` as `type:'chat'`, fire and forget, purely to fill `chat_lines` for the
  `/tv` chat rail. Chat never enters the `events` table and never appears on a public
  page.

State lives in `services/log-poller/state.json` (byte offset, online set, liveness).

### 3.3 eilif-map-snapshot (systemd, Linux PC)

`scripts/map-snapshot.mjs --loop`, run from the repo root every 5 minutes. Pulls
WebMap's `map.png` and `fog.png` over SFTP, composites the fog-masked known world with
`sharp`, and uploads to the public Supabase Storage bucket `map`:

- `current.webp` (the live atlas)
- `frames-by-day/day-<N>.webp` plus `frames-manifest.json` (the in-game-day timelapse)
- `status.json`

The full un-fogged map never leaves the PC, and the real seed is never referenced.

**Why `status.json` exists.** Supabase leaves an object's last-modified untouched when an
upsert writes byte-identical content, and the composite *is* byte-identical for days
whenever nobody plays. So `current.webp` headers cannot distinguish "the loop is paused"
from "the world is quiet". `status.json` changes every run (it carries `capturedAt`,
`revealedPct`, `worldDay`, `dayFramed`), and `lib/data.ts getLiveMap()` reads it for
freshness, falling back to the object header only when it is missing.

The remote directory is namespaced by **world name**:
`/191.101.30.229_6028/BepInEx/plugins/WebMap/map_data/<World>`, resolved from
`MAP_REMOTE_DIR` (full override) or `MAP_WORLD` (path segment), defaulting to
`Dedicated`, the retired test world. This must be repointed at cutover or the loop keeps
framing a frozen world in silence.

### 3.4 eilif-discord-bot (systemd, Linux PC)

`services/discord-bot/`, discord.js v14, `ExecStart=/opt/eilif/node src/index.js`. The
only component holding a Supabase key directly. Loops, with their intervals:

| Loop | Cadence | What it does |
|---|---|---|
| `relay` | `POLL_INTERVAL_MS`, default 15 s | new `events` rows to `#server`, cursored on `events.inserted_at` (see below) |
| `bosses` | 30 s | first boss kill to `#valheim` with `@everyone`, plus the skald retelling |
| `events` (Discord scheduled-events sync) | `EVENTS_INTERVAL_MS`, default 10 m | posts `type:'events_sync'` to `/api/webhook` |
| `identity-confirm` | 30 s | confirms `/oath CODE` Discord links |
| `voice` | 60 s | queues lines into `voice_lines` for the in-game speaker |
| voice expiry | 5 m | ages out unspoken lines |
| `titles` | `TITLES_INTERVAL_MS`, default 10 m | reads `/api/titles`, announces changes, writes `title_history` |
| `milestones` | `MILESTONES_INTERVAL_MS`, default 2 m | announces Great Deeds |
| heartbeat | 60 s | POSTs to `/api/ops/heartbeat` with per-sub-loop status |
| recap | one `node-cron` job, `RECAP_EVENING_HOUR` (default 23) America/Chicago | the evening recap and Player of the Day |
| `boss-polls` | `BOSS_POLLS_INTERVAL_MS`, default 60 s | watches `bosses` for a fresh kill and posts one native Discord poll naming who takes first blood on the next boss, plus a follow-up when it falls. **Off unless `BOSS_POLLS=1`** |
| chronicle | one `node-cron` job, `0 <CHRONICLE_HOUR> * * 0` (Sunday, default 20:00) America/Chicago | the weekly Skald's Chronicle embed. **Off unless `WEEKLY_CHRONICLE=1`** |

Recaps are gated by `RECAPS_START`. Gallery ingest, oath ingest and identity linking are
Discord event handlers rather than loops, each behind its own env flag.

**The relay cursors on insertion order, not on producer time.** `events.created_at` is
supplied by whoever wrote the row: the log poller stamps a join or leave with the LOG
LINE's time and only ships it on its next 20 s SFTP poll, so its rows routinely land 20 to
30 s after the instant they claim, while gs-ingest and the bot's own rows land at real
now. A relay cursored on `created_at` therefore loses rows silently — a client death at
12:00:00 relayed at 12:00:05 parks the cursor at 12:00:00, the poller writes a leave
stamped 11:59:50 at 12:00:08, and `.gt('created_at', …)` never matches it again. The
2026-09-06 launch rehearsal graded that: `join 20/20 · leave 0/20 · death 2/3 — 21 of 43
feed rows NEVER POSTED, silently`, and every other check in the run was green, because a
tick that posts nothing is a success. `events.id` is a UUID, so `db/2026-09-06_events_inserted_at.sql`
adds `inserted_at timestamptz not null default now()` (backfilled from `created_at`, so
history keeps its order) and the relay reads
`.gte('inserted_at', cursor).order('inserted_at').order('created_at').limit(50 + n)`.
`now()` is fixed for a whole transaction, so two rows written by one statement share an
`inserted_at`: the cursor is therefore the pair `(lastInsertedAt, lastInsertedIds)` — the
`.gte` re-reads that timestamp and the ids already relayed at it are skipped by id, which
is why `.gt` alone would drop the second row of every pair. `lastEventAt` survives as the
pre-migration fallback (PostgREST 42703) and as the seed for the new cursor on first run.
One consequence: a future-dated `created_at` can no longer freeze the feed, so the relay
now SKIPS such a row and advances instead of stalling on it — under insertion order the
forged row is not last in the scan, and stalling would hold the cursor in front of every
honest row behind it.

**`now()` is not commit order either, so the cursor lags.** `now()` is fixed at
TRANSACTION START and a row only becomes visible at COMMIT, so two overlapping writers can
commit in the opposite order to their stamps — transaction A starts at `12:00:10.000` and
takes 40 ms (a contended `ingest_death` advisory lock is the realistic case), transaction B
starts at `12:00:10.020` and commits at `12:00:10.021`. A tick landing in that window sees
only B, parks the cursor at B's stamp, and `.gte` never matches A again: bug 1 all over,
one row at a time and just as silent. So each tick reads from `RELAY_INSERTION_LAG_MS`
(default 2000 ms) BEHIND the high-water mark, `lastInsertedIds` is a rolling window of the
last 200 relayed ids rather than "the ids at exactly the cursor", and `insertionFloor`
stops the lag from ever reaching back past the point the cursor was seeded or repaired at,
where there are no ids to recognise history with. Everything the lag re-reads is dropped by
id, so the cost is a few wasted rows per tick and the benefit is that no commit this system
performs is fast enough to slip behind the cursor. A 300-trial randomized differential run
(`scripts/relay-cursor.test.mjs` is its deterministic residue) lost rows in 299 trials with
the lag at 0 and none with it at 2 s.

**The pre-migration fallback flips forward the moment it can.** `fetchByCreatedAt` selects
`*`, so once the ALTER has run its answers carry `inserted_at` — which is proof the
migration is applied. The relay flips on that evidence and re-reads on the insertion cursor
rather than waiting out the 5-minute probe, because relaying a post-ALTER row on the legacy
path copies its `created_at` into the insertion cursor and mis-sets it: a poller leave
stamped 12:00:20 and written at 12:00:35, followed by a client join stamped 12:00:30 and
written at 12:00:31, leaves the cursor at 12:00:30 with the leave's insert time ahead of it.

Persistent local state is `services/discord-bot/state.json` (announced bosses, among
other things). This file is why the launch wipe stops the bot first: its voice tick ends
in an unconditional save every 60 s, so a wipe with the bot running gets a resurrected
`announcedBosses` array and launch night's real first kill is treated as already
announced. `scripts/launch-wipe.mjs` refuses `--execute` while the unit is active.

### 3.5 Timers (systemd, Linux PC)

| Timer | Schedule | Runs |
|---|---|---|
| `eilif-world-backup.timer` | 00:00, 06:00, 12:00, 18:00 local, `Persistent=true` | `scripts/pull-world.sh <World>`, a read-only SFTP copy of the world into `~/valheim-world-backups/`, keeping 14 |
| `eilif-db-snapshot.timer` | 03:30 local, `Persistent=true` | `scripts/db-snapshot.mjs`, a logical JSON snapshot of every Supabase table into `~/valheim-db-backups/`, keeping 30 |

Both are installed and enabled. The world-backup unit passes the world name as an
`ExecStart` argument, so cutover means editing the unit and running `daemon-reload`.
The world-backup unit deliberately runs `bash` and `sftp`, never Node, so a broken Node
runtime cannot stop world backups.

### 3.6 The off-PC watchdog

`.github/workflows/watchdog.yml` runs every 15 minutes and every `workflow_dispatch`, and
does nothing but `curl` `GET https://valheim-dashboard.vercel.app/api/ops/watchdog` with
`Authorization: Bearer $WATCHDOG_TOKEN` (a GitHub repository secret). Any non-2xx fails
the job, which GitHub emails about.

All the work happens in the route: it reads `ops_heartbeats` and `server_status` directly
from Supabase, decides which components are down, and posts to Discord itself using the
bot token over REST (no discord.js on Vercel). Nothing in that chain touches the PC,
which is the whole point: `/admin/ops` is pull-only, and "the PC is off" is exactly the
case nothing local can report.

The route is deliberately loud on misconfiguration. A DB it cannot reach, an
`ops_alerts` row it cannot read or write, or a Discord post Discord rejects all produce
a 5xx, so a broken watchdog is itself alerted on.

### 3.7 The dashboard (Vercel)

Next.js 16 App Router, React 19, Tailwind v4, TypeScript. Public pages:

| Path | Page |
|---|---|
| `/` | Hall: status, who is on, Hearth pulse, boss progress, recent saga |
| `/players` | Vikings: roster, leaderboards, attendance grid, How We Die, anglers |
| `/viking/[slug]` | one viking: stats, feats, deaths, oath, catch log |
| `/world` | boss timeline, Great Deeds ledger, scheduled gatherings |
| `/boss/[slug]` | one boss: war room and full record |
| `/events` | Saga feed plus Episodes |
| `/map` | fog-masked atlas, per-in-game-day timelapse, player pins, place albums |
| `/gallery` | photos ingested from Discord |
| `/oath` | the oath wall |
| `/mods` | the mod list from `config/mods.ts` |
| `/get-started` | pack code, Mac config bundle, connect details |
| `/tv` | experimental TV mode, unlinked and noindexed (delete `app/tv` and `components/tv` to remove) |
| `/admin/ops`, `/admin/ops/architecture` | the ops cockpit, cookie-gated |

Public reads go through `lib/data.ts` with the anon key under public-read RLS. Only the
ingest and ops routes use the service-role key.

---

## 4. API routes and their auth

Every secret compare uses `safeEqual` from `lib/ops/auth.ts`, which hashes both sides
first so it leaks neither content nor length. Every authenticated route fails closed when
its env var is unset.

| Route | Method | Auth | Privilege | Notes |
|---|---|---|---|---|
| `/api/webhook` | POST | `x-webhook-secret` header vs `WEBHOOK_SECRET` | service role | Two-tier per-IP rate limit: the secret is checked first because it decides the budget, and the unauthenticated bucket is drawn on before the 401. The whole event stream arrives from one address. |
| `/api/gs-ingest` | POST | split by `source`. `server` requires `Authorization: Bearer GS_EMITTER_TOKEN` or 401. `client`, `client-map`, `eilif-death` carry no secret and are gated by `GS_EXPECTED_WORLD` plus a server-presence cross-check | service role | An unknown `source` is 400. A missing `world` counts as a mismatch, not a free pass. `PRESENCE_CHECK_ENABLED=false` bypasses the presence gate. |
| `/api/status` | GET, OPTIONS | none | anon reads | CORS `*`, `no-store`. Feeds status widgets. |
| `/api/titles` | GET, OPTIONS | none | anon reads | CORS `*`, per-IP rate limit, 60 s per-instance cache (`?fresh=1` skips). Four Supabase reads plus the whole epithet engine per miss. The single source of truth for titles, shared with the site. |
| `/api/boards` | GET | `Authorization: Bearer BOARDS_TOKEN`. Unset is 503, wrong is 401 | anon reads | 30 s per-instance cache (`?fresh=1` skips). Records the `boards-plugin` heartbeat. The token is server-only and never ships in a player pack. |
| `/api/voice` | GET | `x-voice-token` vs `VOICE_API_TOKEN` | service role | `voice_lines` has no public-read policy on purpose. Claims up to 3 queued lines and flips them to spoken. Records the `companion-voice` heartbeat. |
| `/api/ops/heartbeat` | POST | `Authorization: Bearer OPS_HEARTBEAT_TOKEN`. Unset is 503, wrong is 401 | service role | Every stored string is run through `lib/ops/redact.ts` first, so a producer cannot persist a token into a table the cockpit renders. |
| `/api/ops/watchdog` | GET | `Authorization: Bearer WATCHDOG_TOKEN`. Unset is 503, wrong is 401 | service role | Evaluates, alerts, and answers 5xx on any internal failure. |
| `/api/ops/login` | POST | password vs `OPS_PASSWORD`, sets an HMAC-SHA256 signed cookie (signed with the password itself, no separate secret) | none | Tighter rate limit than ingest: 10 per minute per IP. |
| `/api/ops/logout` | POST | none | none | Overwrites the cookie with `maxAge` 0. |

`type:'stats'` on `/api/webhook` is **retired**: it is accepted, logged loudly as
deprecated, and writes nothing. Its only producer was `eilif-stats-parser.service`,
retired 2026-08-23.

---

## 5. Tables and who writes them

Supabase Postgres, 20 tables, RLS on with public-read policies. All writes below use the
service-role key, either from a Vercel route or from the Discord bot.

| Table | Written by | What it holds |
|---|---|---|
| `players` | `/api/webhook` (insert, update), `/api/gs-ingest` (update only), bot `titles.js` and `oaths.js` (update) | roster, `steam_id` binding, `discord_id`, online flag. **Only the webhook creates rows**; gs-ingest never inserts. |
| `sessions` | `/api/webhook` only | join/leave sessions, duration |
| `events` | `/api/webhook`, `/api/gs-ingest`, `lib/deaths.ts`, `lib/milestones.ts` | the saga feed: joins, leaves, deaths, bosses, raids, milestones |
| `player_stats` | `/api/gs-ingest` (upsert) | leaderboard numbers plus the `gs_stats` jsonb long tail. Baselined per world by `lib/gs-baseline.ts`. |
| `bosses` | `/api/gs-ingest` (update), bot `retelling.js` (update), `services/discord-bot/scripts/mark-boss.js` (manual) | the eight progression gates, `fight_stats` jsonb |
| `roadmap` | nothing in code (hand-edited in Supabase) | the living schedule |
| `server_status` | `/api/webhook`, `/api/gs-ingest` | single row: online, player count, current players, world day |
| `discord_events` | `/api/webhook` (`events_sync`, upsert and delete) | Discord scheduled events, rolled forward for recurrence |
| `gallery_photos` | bot `gallery.js` (insert, delete), `/api/webhook` (update, for pin linking) | Discord-ingested screenshots |
| `poty_history` | bot `recap.js` | Player of the Day archive |
| `oaths` | `/api/webhook` (insert, delete), bot `oaths.js` and `voice.js` | the oath wall |
| `pins` | `/api/webhook` (insert, delete) | named places from `/pin` |
| `voice_lines` | bot `milestones.js`, `titles.js`, `voice.js` (insert and update), `/api/voice` (update to spoken) | the in-game speech queue. No public-read policy. |
| `milestones` | `lib/milestones.ts` via `/api/gs-ingest`, bot `milestones.js` | Great Deeds, their progress and announce state |
| `title_history` | bot `titles.js` | every title change |
| `identity_claims` | bot `identity.js` (insert, update), `/api/webhook` (update) | the `/oath CODE` Discord-to-viking link flow |
| `chat_lines` | `/api/webhook` | mirrored shouts for the `/tv` chat rail, not the public site |
| `player_positions` | `/api/webhook` (upsert) | live positions for the map layer and `/tv` |
| `ops_heartbeats` | `/api/ops/heartbeat`, `lib/ops/route-heartbeat.ts` | producer liveness. Service-role only. |
| `ops_alerts` | `/api/ops/watchdog` (upsert) | watchdog alert state and re-alert timing. Service-role only. |

That is all twenty, verified against the live project on 2026-09-05. One of `players`'s
columns is narrower than the rest of the row: `steam_id` is revoked from the anon role by
`db/2026-07-11_players_pii_revoke.sql`, so public reads never see it. `discord_id`,
`discord_user_id` and `discord_username` **are** readable by anon over PostgREST: that
migration revokes the blanket table grant and then deliberately re-grants those three,
because the viking pages render them. If that is not what you want, it is a product
decision, not a bug in the migration.

Storage buckets: `gallery` (public, written by the bot) and `map` (public, written by
`scripts/map-snapshot.mjs`).

**Migrations.** `db/*.sql`, one file per change, applied by hand against the live project.
There is no migration runner. `db/0000_initial_schema.sql` is the base schema exported
verbatim from production on 2026-09-04 and is **disaster recovery only**: re-running it
against the live project fails on the first `CREATE TABLE`, and that is the guard.
Replay order is filename order; `2026-07-04_a_pins.sql` was renamed specifically so it
sorts before `2026-07-04_gallery_pin_link.sql`, which references `public.pins`.

The only stored routine is `public.ingest_death(...)`, added 2026-09-04 and applied to
prod. See section 8.

---

## 6. Environment variables, by component

### Vercel (the site and all routes)

| Var | Used by | Launch value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | everything | unchanged |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public reads | unchanged |
| `SUPABASE_SERVICE_ROLE_KEY` | ingest and ops routes, `/tv` server reads | unchanged |
| `WEBHOOK_SECRET` | `/api/webhook` | unchanged (must match the poller) |
| `GS_EMITTER_TOKEN` | `/api/gs-ingest` server payloads | **rotate at cutover**, in Vercel and in the Emitter cfg on the box |
| `GS_EXPECTED_WORLD` | `/api/gs-ingest` client payloads | set to `Eilif`. Vercel env only, and it **needs a deploy** to take effect |
| `PRESENCE_CHECK_ENABLED` | `/api/gs-ingest` | unset (defaults to on) |
| `BOARDS_TOKEN` | `/api/boards` | unchanged unless rotated; must match the Boards plugin cfg on the box |
| `VOICE_API_TOKEN` | `/api/voice` | **rotate at cutover**, in Vercel, in the Companion cfg, and in `.voice-token` |
| `TV_ACCESS_KEY` | `/tv` positions gate | optional |
| `OPS_PASSWORD` | `/admin/ops` login | unchanged |
| `OPS_HEARTBEAT_TOKEN` | `/api/ops/heartbeat` | unchanged (must match all three producers) |
| `WATCHDOG_TOKEN` | `/api/ops/watchdog` | unchanged (must match the GitHub repository secret of the same name) |
| `DISCORD_TOKEN` | watchdog alert posts | unchanged |
| `WATCHDOG_CHANNEL_ID`, `WATCHDOG_MENTION` | watchdog alert posts | unchanged |
| `NEXT_PUBLIC_SITE_URL` | link in watchdog messages | optional |

`.env.local.example` is supposed to be the source of truth for this list. It is currently
missing `VOICE_API_TOKEN`, `GS_EXPECTED_WORLD` and `PRESENCE_CHECK_ENABLED`. See
section 11.

### services/log-poller/.env

`WEBHOOK_URL`, `WEBHOOK_SECRET`, `SFTP_HOST`, `SFTP_PORT` (8822), `SFTP_USER`,
`SFTP_PASSWORD`, `SFTP_TIMEOUT_MS`, `LOG_SOURCE`, `LOG_PATH`, `POLL_INTERVAL_MS`,
`SYNC_EVERY_MS`, `EMIT_DEATHS`, `STATE_PATH`, `STALE_LOG_THRESHOLD_MS`,
`SERVER_DOWN_REALERT_MS`, `SERVER_DOWN_REALERT_LONG_MS`, `CHAT_DISCORD_WEBHOOK` or
`DISCORD_TOKEN` plus `CHAT_CHANNEL_ID`, `ALERT_DISCORD_WEBHOOK` or `ALERT_CHANNEL_ID`,
`OPS_HEARTBEAT_URL`, `OPS_HEARTBEAT_TOKEN`.

Also read by `scripts/map-snapshot.mjs`, which loads this file plus `.env.local`:
`MAP_REMOTE_DIR` or `MAP_WORLD`, `MAP_DEMO_PREVIEW`.

**Launch value:** `MAP_REMOTE_DIR` becomes
`/191.101.30.229_6028/BepInEx/plugins/WebMap/map_data/Eilif`.

### services/discord-bot/.env

`DISCORD_TOKEN`, `GUILD_ID`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `TZ`, `POLL_INTERVAL_MS`,
`CHANNEL_VALHEIM`, `CHANNEL_SERVER`, `CHANNEL_GALLERY`, `RECAPS_START`,
`RECAP_EVENING_HOUR`, `RECAP_CHANNEL`, `MILESTONE_CHANNEL`, `OATH_CHANNEL`,
`BOSS_CHANNEL`, `TITLE_CHANNEL`, `EVENTS_SYNC`, `EVENTS_INTERVAL_MS`, `GALLERY_INGEST`,
`GALLERY_MAX_EDGE`, `OATH_INGEST`, `IDENTITY_LINK`, `ADMIN_ROLE_IDS`, `VOICE_ENGINE`,
`VOICE_MIN_GAP_MS`, `TITLES_ANNOUNCE`, `TITLES_API_URL`, `TITLES_INTERVAL_MS`,
`TITLES_DRY`, `MILESTONES_ANNOUNCE`, `MILESTONES_INTERVAL_MS`, `MILESTONE_MIN_GAP_MS`,
`OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`, `OPS_HEARTBEAT_URL`,
`OPS_HEARTBEAT_TOKEN`, `DRY_RUN`, and, for the two loops that ship off,
`BOSS_POLLS`, `BOSS_POLLS_INTERVAL_MS`, `BOSS_POLL_CHANNEL`, `WEEKLY_CHRONICLE`,
`CHRONICLE_CHANNEL`, `CHRONICLE_HOUR`.

**Launch values (pilot overrides to revert):** `RECAPS_START` becomes `2026-09-09`;
`RECAP_CHANNEL`, `MILESTONE_CHANNEL`, `OATH_CHANNEL` and `BOSS_CHANNEL` are **removed**
so announcements go back to `#valheim`; `TITLE_CHANNEL` is added as `valheim`.

There is one trap here. The live unit file
`/etc/systemd/system/eilif-discord-bot.service` still carries
`Environment=RECAPS_START=2026-07-04` (verified on the host 2026-09-05), and a unit
`Environment=` line **beats** the `.env` file. Both have to change, then
`systemctl daemon-reload`. `scripts/cutover-env.sh` does all of it.

### Where launch values actually live

`scripts/cutover-env.sh <World> --apply` is the single place. It rewrites both `.env`
files, deletes the unit's `RECAPS_START` line, reloads systemd, and then **prints the
three steps it cannot do**: the Vercel `GS_EXPECTED_WORLD` swap plus a deploy, the GS
Emitter cfg `World =` on the box (in a stopped window), and the pack re-mint. Run it
dry first; it is a dry run unless `--apply` is passed.

---

## 7. The four custom plugins

All four are BepInEx 5 plugins built from this repo, and **all four need a recompile for
Valheim 1.0**. Each has a `BUILD.md` carrying the launch-day sequence: confirm Steam is on
1.0, md5-compare the box's `assembly_valheim.dll`, rebuild, stop the server, upload,
start, and only then re-mint the pack.

| Plugin | Side | Repo version | GUID | What it hooks |
|---|---|---|---|---|
| `plugins/eilif-companion` | server only | 0.3.3 (box runs 0.3.2) | `media.blockspace.eilif.companion` | `Chat.OnNewChatMessage` Prefix (oath and pin capture), `ZNet.RPC_PeerInfo`, `ZSteamMatchmaking.RegisterServer`, and `ZNet.GetNrOfPlayers` plus `ServerFallback.PlayerLimit` for the dormant V+ fallback. `ZoneSystem.SendGlobalKeys` is called by reflection, not patched |
| `plugins/eilif-boards` | server only | 0.2.0 | `media.blockspace.eilif.boards` | **no Harmony patches at all.** It reads and writes sign ZDO text and replicates by revision |
| `plugins/eilif-companion-client` | client, ships in the pack | 0.3.2 (published to Thunderstore 2026-09-05) | `net.eilif.companionclient` | `Player.OnDeath` (death reporter), `Inventory.MoveInventoryToGrave` (tombstone keep-list), `Game.Logout` (final cartography post) |
| `plugins/eilif-paths` | client, ships in the pack | 1.5.0 (Thunderstore latest is 1.4.0) | `net.eilif.paths` | `Player.GetJogSpeedFactor`, `GetRunSpeedFactor`, `UseStamina`, `Character.UpdateWalking`, `Bed.CheckFire`, `StationExtension.Awake`, `CraftingStation.Start` and `CheckUsable`, and, only when the V+ fallback is switched on, `Fireplace.Awake`, `CookingStation.UpdateCooking`, `Smelter.UpdateSmelter`, `ShieldGenerator.*`, `Pickable.RPC_Pick`, `DropTable.GetDropList` and `CharacterDrop.GenerateDropList`. `Minimap.Explore` is called by reflection, not patched |

Three things about them that are not obvious:

**The Companion's oath hook moved in 0.3.1, and V+ `[Chat]` is why.** The capture used to
postfix `Chat.RPC_ChatMessage`. That hook is dead on this server: ValheimPlus's `[Chat]`
patch throws an NRE earlier in the same chain, so the original never completes and the
postfix never runs. Every oath on record actually arrived through the poller's console
echo, which is the server printing a SHOUT, which Valheim display-uppercases. That is why
the old signatures on the oath wall are in capitals. The fix was to Prefix
`Chat.OnNewChatMessage` instead, which is one level further down, carries the same
arguments, and is proven to run because `/pin` already lived there.

**V+ `[Chat]` must stay enabled.** That section is what makes `/s` shouts carry
server-wide (`shoutDistance` plus `serverSyncsConfig`), and shouts are what oaths, pins
and the chat mirror are built on. Turning it off to dodge the NRE would take the whole
capture path with it. The NRE happens inside `Chat.AddInworldText`, which is called from
the body of `OnNewChatMessage`, so our Prefix has already written its marker line by the
time it throws.

**Identity on an oath line is the server's name for the peer**, not the name inside the
packet. `RPC_ChatMessage` forwards the client's claimed `UserInfo.Name` unchecked, so the
Companion uses `ZNet.instance.GetPeer(senderID)?.m_playerName` and logs an
`[EILIF_IDENT] mismatch` warning (rate limited to one a minute) when the two differ. A
sender uid with no peer record is refused outright.

**Keep-gear now comes from the panel, with the plugin as a belt-and-braces backstop.**
The GTX panel death-penalty tier and the Companion's world-key enforcement are two
separate facts, which is why `scripts/verify-restart.sh` reports them separately. Panel
`veryeasy` grants only `skillreductionrate 15`; keep-gear comes from the **Casual** tier.
For months keep-gear existed only because the Companion asserts `deathkeepequip` into the
running world every 30 s (`[WorldKeys] EnforcedGlobalKeys`, on by default), which meant
the first boot where the plugin failed to load silently dropped everyone's gear. The
durable fix is Casual on the panel, and the 2026-09-05 verify run confirms it: panel tier
`casual`, `deathkeepequip` present in the runtime key list, and no `[EILIF_KEY] enforced
world key` line this boot, because the plugin only logs that when it actually had to add
a missing key.

---

## 8. Design decisions worth knowing before you change anything

**Name-keyed identity with first-sight Steam binding.** Valheim allows duplicate character
names and never verifies them, so every name-keyed write path would happily file a second
"Alice" under the real Alice. The only stable identity the dedicated server offers is the
connecting SteamID, which the poller pairs with a character name from the log (`Got
connection SteamID <id>` followed by `Got character ZDOID from <name>`) and forwards as
`steamId`. `lib/identity-guard.ts` turns that into four decisions: `bind` (nobody owns the
name yet, record it), `match`, `mismatch` (freeze the name-keyed writes and log the
release SQL), and `unknown` (no usable pairing, **allow** the write, because this guard
must never invent a false positive). First sight binds, and the binding is only released
by hand. That is deliberate, and it is part of why the launch wipe matters: after it,
every name rebinds fresh.

A refusal answers **200**, not an error. The poller rewinds its byte cursor on any non-2xx
and re-reads the whole batch forever, so a permanently-refused oath would wedge the entire
pipeline (joins, deaths and chat included) rather than dropping one write. The refusal is
in the body, and both sides log it.

**At-least-once poller plus idempotent webhook.** The poller only advances its cursor past
a fully dispatched batch, so failures replay. The webhook therefore has to tolerate
duplicates rather than assume exactly-once. Duplicates beat losses.

**The `ingest_death` advisory lock.** Every launch player runs two death producers:
GsValheimStatsClient's `deathEvents[]` and our own EilifCompanionClient
(`source:'eilif-death'`). Both Harmony-patch `Player.OnDeath` and POST immediately, so
they land within the few hundred milliseconds each handler spends between its dedupe
SELECT and its INSERT. Both read "nothing nearby", both insert, and one death becomes two
rows. Four of ten dual-producer deaths duplicated during the pilot.

`db/2026-09-04_ingest_death.sql` moves the window check and the write into one transaction,
serialized per character by `pg_advisory_xact_lock(hashtext('death:'||lower(name)))`. It
is not a unique index, because the natural key would need `date_trunc('second', ...)`,
which is STABLE rather than IMMUTABLE and which straddles second boundaries for about 1 %
of pairs anyway given the observed 1 to 13 ms clock skew. `lib/deaths.ts` calls it through
`client.rpc('ingest_death', ...)` and falls back to the old select-then-insert path on
Postgres error 42883, so the code and the migration can land in either order.

Three defences exist against duplicate deaths, at different widths: the Discord relay
collapses at 10 s, `lib/webhook/dedupe.ts` uses a deliberately wide plus or minus 3 minute
window, and `ingest_death` holds the lock over that same window.

**Map liveness via `status.json`.** Covered in section 3.3. The short version: a
byte-identical upsert does not move an object's last-modified, so the atlas cannot report
its own freshness and needs a sidecar that always changes.

**`NEXT_PUBLIC_*` is baked at build time.** Next.js inlines these into the client bundle
during `next build`, so a production `.next` carries the production Supabase URL and anon
key inside its JavaScript. Exporting a different `NEXT_PUBLIC_SUPABASE_URL` before
`next start` changes nothing. This is why the stress test copies the build directory and
`sed`-repoints it rather than re-exporting env vars, and why `GS_EXPECTED_WORLD`, which is
server-side, still needs a deploy to take effect (it is read at request time, but the
deploy is what carries the new env into the running functions).

**Everything fails closed.** Every authenticated route treats an unset env var as "serve
nobody" rather than "no auth configured, let everyone in". `/api/boards` and the two
`/api/ops` token routes answer 503 (unconfigured); `/api/webhook` and `/api/voice` answer
401. Either way an unset secret admits nobody. The ops cockpit redirects to its login page
when `OPS_PASSWORD` is unset instead of 500ing.

**The cockpit is observational only.** There is no restart, wipe, migration-apply, or
remote-command control anywhere in `/admin/ops`, and there must never be one. It renders
state and tells you what to check; a human does the thing.

---

## 9. The pack pipeline

Two artifacts have to agree with each other and with the server: the r2modman pack code
(`MODPACK_PROFILE_CODE` in `config/server.ts`) and the Mac config bundle
(`public/downloads/eilif-configs-pack-v<N>.zip`, linked by `CONFIG_BUNDLE_URL` in
`app/get-started/page.tsx`, because Macheim cannot read a pack code).

Both render from one source, `scripts/pack-templates/`:

- `scripts/mint-pack.mjs` renders, verifies, zips, uploads to Thunderstore, then pulls the
  minted profile back down and byte-compares it.
- `scripts/build-config-bundle.mjs` renders the same templates into the Mac zip.

Run them with the same flags and they cannot drift. Full detail in `docs/PACK.md`.

Three rules that bite:

1. **The Thunderstore listing index lags uploads by 40 to 80 minutes.** The package API
   knows about an upload instantly, but mod managers resolve a profile code against a
   pre-baked gzipped `package-listing-index` rebuilt on a schedule. A code minted inside
   that window looks perfect on the package page and fails for every player with "mod not
   found". `mint-pack.mjs` checks both and refuses to mint until the index catches up.
   Wait and re-run; do not work around it.
2. **A pack code carries no DLLs.** It is a list of Thunderstore package names and
   versions. A locally installed mod exports as an unresolvable stub. That is why
   EilifPaths and EilifCompanionClient are published under the `Eilif` namespace, and why
   the order is publish, wait for the index, then mint.
3. **AzuCraftyBoxes moves in lockstep with the server's copy.** Its `Prevent Pulling
   Logic` hotkey is client-side and not server-synced, so only the pack can unbind Alt+O
   fleet-wide. That is the entire reason pack v11 exists.

Three files hold a version list for the seven packed mods and must be edited together:
`MODS` in `scripts/mint-pack.mjs` (the renderer of record), `PACK_V12_PINS` in
`scripts/launch-preflight.mjs`, and the player-facing list in `config/mods.ts`.

**State as of 2026-09-05.** Pack of record is **v11** (`01a0440c-b54a-8d15-5882-22f86a4333b4`),
which pins EilifCompanionClient 0.2.0 and EilifPaths 1.4.0. EilifCompanionClient **0.3.2
is published** (Thunderstore, 2026-09-05), and its staging directory
`plugins/thunderstore/EilifCompanionClient-0.3.2/` plus zip are still on disk. EilifPaths
is at **1.5.0 in the repo with nothing staged**; Thunderstore still serves 1.4.0, so a
v12 mint needs that package built and published first, then the index wait in rule 1.
`CONFIG_BUNDLE_URL` still points at
`/downloads/eilif-configs-pack-v11.zip` and has to be repointed by hand after a re-mint;
the bundle script prints the reminder but does not do it.

`--no-vplus` mints without ValheimPlus, dropping both its `export.r2x` entry and
`config/valheim_plus.cfg`. V+ `enforceMod = true` is a version check in both directions,
so a pack that still pins V+ refuses to join a server without it, and vice versa. The two
sides move together, and deleting V+ turns nothing on by itself: the replacements are
EilifPaths `[VPlusFallback] Enabled` on the client (minted with `--fallback on`) and Eilif
Companion `[ServerFallback]` on the box, both shipping off.

---

## 10. Ops tooling

All read-only unless stated. Node 20 via nvm first:
`export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20`.

| Tool | What it does |
|---|---|
| `bash scripts/verify-restart.sh [World]` | What the last panel Stop then Start actually armed, over read-only SFTP: game version (the proof no Steam update ran), AzuCraftyBoxes loaded, two V+ settings, the death-penalty **panel tier and plugin key enforcement as two separate facts**, the Combat tier, and a port-3000 reachability check |
| `node scripts/launch-preflight.mjs --world <W> --phase <p>` | One PASS/FAIL/WARN/SKIP line per T-0 precondition, exits non-zero on any FAIL. Phases: `pre-wipe`, `post-wipe`, `post-start` |
| `node scripts/launch-wipe.mjs` | Clears pilot data from prod Supabase. **Dry run by default**; `--execute` also requires typing `WIPE`, and against a non-loopback target it is refused outright unless `--i-mean-prod` is passed too. Refuses to execute while `eilif-discord-bot` is active, and still hard-gates on `eilif-stats-parser` on purpose, in case someone re-enables a retired service |
| `bash scripts/cutover-env.sh <W> [--apply]` | Flips every world-dependent setting on this PC and prints the three remote steps it cannot do. Dry run without `--apply` |
| `bash scripts/pull-world.sh [World]` | Read-only off-box world copy into `~/valheim-world-backups/<W>-<stamp>/`, keeping 14. Deliberately does **not** copy `<W>.json`, which contains the seed. Handles both the 0.221.x two-file layout and the possible 1.0 chunked folder layout |
| `node scripts/db-snapshot.mjs` | Logical JSON snapshot of every table via PostgREST paging, plus a storage-bucket listing and a manifest. Exits non-zero if any table fails, so the unit shows failed |
| `bash scripts/rebuild-plugins.sh [--dry-run] [--stage]` | Rebuilds all four custom plugins against a given set of game assemblies and proves the result is deployable. Written for the 1.0 recompile inside one stopped window. `--sandbox` builds copies; `--source-revision <sha>` reproduces a committed DLL exactly |
| `node scripts/mint-pack.mjs`, `node scripts/build-config-bundle.mjs` | Section 9 |
| `npm run smoke` | The pre-deploy smoke test: the stress rehearsal with the assembly automated and the length cut to about seven minutes. Starts or reuses the local Supabase stack, rebuilds it from `db/*.sql`, copies the repo and builds it against the local database (which is what "repointed" means), then runs the load and checks the same invariants. Run it to prove a change did not break the pipeline before asking for a deploy. `-- --keep` leaves the stack up. Landed 2026-09-05 |
| `node scripts/stress/run.mjs` | Twenty vikings, six simulated hours, against a throwaway local Supabase and a repointed local build. Refuses to start unless both `BASE_URL` and `SUPABASE_URL` are loopback **and** the site proves it is reading the database at `SUPABASE_URL`. See `docs/STRESS-TEST.md` |
| `node scripts/stress/bot-dryrun.mjs` | A long-running Discord bot with no Discord. Refuses to start if `DISCORD_TOKEN` is set |
| `node scripts/stress/day-one.mjs` | The other half of the stress question: not throughput, but the states nobody has ever seen rendered, because until the wipe there has never been an empty database in front of a running site. Runs in stages (server up with nobody on, exactly one viking / one oath / one death, the first deed, titles seeding, Eikthyr on day 3) so the counts of exactly one get looked at. Landed 2026-09-05 |
| `node scripts/stress/page-check.mjs` | Fetches the player-facing pages off the local site and reads the text a player would see, looking for `undefined` / `NaN` / `Invalid Date` / `[object Object]` leaks, `Day 0`, broken plural agreement at exactly one, empty headings, and (with `--stale`) names from the previous world surviving a wipe. Landed 2026-09-05 |
| `node scripts/stress/ratelimit-probe.mjs` | Measures the real per-IP request budget |
| `npm test` | Every `*.test.mjs` under `scripts/` and `lib/`, run through `tsx`. The three services are separate npm projects with their own tests |

Verification before calling anything done, in order: `npx tsc --noEmit`, `npm test`,
`npm run build`.

---

## 11. Known residuals

Things that are true today and will surprise someone if they are not written down.

1. **The live poller unit is `eilif-log-poller.service`; the repo reference file is still
   named `services/log-poller/valheim-log-poller.service`.** `AGENTS.md` repeats the old
   name. The unit that is running is the `eilif-` one.
2. **The live bot unit still carries `Environment=RECAPS_START=2026-07-04`**, which beats
   the `.env` file. Verified on the host 2026-09-05. `cutover-env.sh --apply` removes it.
3. **`.env.local.example` is incomplete.** It is documented as the source of truth for the
   variable list but is missing `VOICE_API_TOKEN`, `GS_EXPECTED_WORLD` and
   `PRESENCE_CHECK_ENABLED`, all of which the routes read.
4. **Three files hold the packed-mod version list** (`mint-pack.mjs`,
   `launch-preflight.mjs`, `config/mods.ts`). Folding preflight's copy into an
   `import { MODS }` is the obvious fix and is not done.
5. **`CONFIG_BUNDLE_URL` is hand-maintained** in `app/get-started/page.tsx` and still
   points at pack v11.
6. **The Companion on the box is 0.3.2; the repo is at 0.3.3.** Verified on the host
   2026-09-05. The DLL swap needs a stopped window because Windows file-locks loaded
   plugins.
7. **The tombstone keep-list has never run on a live server.** Pack v11 pins
   EilifCompanionClient 0.2.0, so it is dark for every player until v12 is minted, even
   though 0.3.2 is published on Thunderstore. The pack pin, not the published version, is
   what players get.
8. **`eilif-stats-parser` is retired** (2026-08-23) and is not in the restart order. Its
   `ops_heartbeats` row is left in the database on purpose (deleting rows is Charlie's
   call), and `lib/ops/health.ts` no longer reads it. `type:'stats'` on `/api/webhook` is
   accepted and ignored with a loud log line.
9. **WebMap's port 3000 is open to the internet** (HTTP 200, re-verified 2026-09-05), serving
   the full un-fogged map, `/config`, and live player positions over a WebSocket.
   `verify-restart.sh` checks it. The fix is a GTX firewall ticket. Never set
   `server_port = 0`: it NREs during world load.
10. **The `/api/voice` claim is not atomic.** It selects the oldest queued rows then
    updates them by id. supabase-js has no `FOR UPDATE SKIP LOCKED` and a real claim RPC
    would need a migration. There is exactly one poller consuming the queue, so the race
    is an accepted risk.
11. **Supabase is on the free plan:** no automated daily backups, no PITR. The two local
    timers (`eilif-world-backup`, `eilif-db-snapshot`) plus `db/0000_initial_schema.sql`
    are the whole recovery story. The standing recommendation is a periodic
    `supabase db dump` to the NAS.
12. **`roadmap` has no writer in code.** It is hand-edited in the Supabase table editor.
13. **`/tv` is experimental and unlinked.** Delete `app/tv` and `components/tv` to remove
    it.
14. **The bot lacks Manage Webhooks**, so mirrored chat cannot post as the player.

---

## 12. Launch day

The launch world is **Eilif**, launching Wednesday 2026-09-09, the same day Valheim 1.0
ships. Decision of record (Charlie, 2026-09-05): the server goes to 1.0 that day, which
means all four custom plugins are recompiled in the morning window and ValheimPlus is
assumed absent.

**Do not run the launch from this file.** The procedure of record is
**`docs/LAUNCH-DAY.md`** (added 2026-09-05): one numbered, time-boxed, 22-step sequence
from "1.0 is out on Steam" to "players are in", with the owner, the exact command, the
line to look for, the "if it fails" branch and the rollback on every step, and the
go/no-go at 15:00 CT. It carries the ordering rules that were learned the hard way (stop
the Discord bot first, start the map snapshotter last) and marks every Charlie-only step.

It also carries a **step 0**, which is not on the 9th: the launch world does not exist
yet, and none of the six sources the file reconciled said who creates it or when. Charlie
generates `Eilif` in his own client and hands over the `.fwl`+`.db` pair by 2026-09-08.
Step 12 uploads it into a stopped window that opens after the irreversible Steam Update,
so a missing pair is a no-go before step 7, not a hold at step 12.

`docs/LAUNCH-WIPE.md` keeps the wipe's own procedure and the rehearsal that shaped it.
`docs/PACK.md` carries the re-mint mechanics and the flag reference. `CLAUDE.md` carries
the current state block and the links to the launch audit and the printable runbook.
Earlier notes calling this a "twelve-step cutover" were counting the HTML runbook's
numbering; `LAUNCH-DAY.md` has 22 steps and is the only numbering to quote.
