# Valheim Log Poller (Eilif)

Tails the Valheim dedicated-server log over **SFTP** (`BepInEx/LogOutput.log` on GTXGaming) and
forwards derived events — joins, leaves, deaths, raids, and roster sync — to the Eilif dashboard
webhook. Runs forever on the Linux PC under systemd.

## How it works
- Fetches only the **new bytes** of the log each poll (SFTP byte-range read from the saved offset),
  so 20s polling is cheap.
- A stateful parser correlates the connection → character-name → socket-close sequence into
  `join` / `leave`, detects `death` (the `ZDOID … : 0:0` reset), `raid` (`Random event set:…`),
  and reads the `Connections N` heartbeat. Respawns do **not** double-count as joins.
- Periodically sends a `sync` of the live roster so a player who drops without a clean disconnect
  doesn't get stuck "online".
- Byte offset + roster are persisted to `state.json`, so restarts resume where they left off; if the
  log shrinks (server restart/rotation) it re-reads from the top.
- **Server-liveness detection** (see below): a log that stops growing means the game server process
  is down, so the dashboard gets flipped offline and Discord gets an alert.

## Setup
```bash
cd services/log-poller
nvm use            # Node 20+ (see ../../.nvmrc)
npm install
cp .env.example .env   # then fill in SFTP creds + WEBHOOK_SECRET
```

## Test (no server activity needed)
```bash
npm test              # both offline suites (parser + liveness)
npm run test:parser   # offline: validates parsing against fixtures/sample-session.log
npm run test:liveness # offline: drives the server-liveness state machine on a fake clock
npm run test:sftp     # connects to the real SFTP, shows log tail + matched patterns
```

## Run
```bash
npm start
# or against a local log file instead of SFTP:
LOG_SOURCE=file LOG_PATH=./fixtures/sample-session.log npm start
```

## Run as a service
Edit `valheim-log-poller.service` if your Node path differs (it points at the nvm Node 20 binary),
then:
```bash
sudo cp valheim-log-poller.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now valheim-log-poller
journalctl -u valheim-log-poller -f
```

## Config (`.env`)
| Var | Default | Notes |
|-----|---------|-------|
| `LOG_SOURCE` | `sftp` | `sftp` or `file` |
| `LOG_PATH` | `BepInEx/LogOutput.log` | remote (sftp) or local (file) path |
| `SFTP_HOST/PORT/USER/PASSWORD` | — | GTXGaming SFTP (port 8822) |
| `WEBHOOK_URL` | prod dashboard | `…/api/webhook` |
| `WEBHOOK_SECRET` | — | must match the dashboard |
| `POLL_INTERVAL_MS` | `20000` | log fetch cadence |
| `SYNC_EVERY_MS` | `120000` | roster reconciliation cadence |
| `EMIT_DEATHS` | `true` | `false` once gs-ingest owns deaths (avoids double-count) |
| `CHAT_DISCORD_WEBHOOK` | — | optional channel webhook for the chat mirror (posts AS the player) |
| `DISCORD_TOKEN` + `CHAT_CHANNEL_ID` | — | chat-mirror fallback: bot-token post (`🗨️ **Name:** text`) |
| `STALE_LOG_THRESHOLD_MS` | `1800000` (30 min) | log silent this long ⇒ game server treated as DOWN |
| `SERVER_DOWN_REALERT_MS` | `21600000` (6 h) | while down, repeat the Discord alert at most this often |
| `ALERT_CHANNEL_ID` | falls back to `CHAT_CHANNEL_ID` | where down/up alerts are posted |
| `ALERT_DISCORD_WEBHOOK` | falls back to `CHAT_DISCORD_WEBHOOK` | webhook alert target if no bot token |

## Server-liveness detection
The failure this fixes: when the game server process stops, the log simply stops growing. The poller
sits at EOF forever and the dashboard keeps saying **online** — that went unnoticed for two multi-day
outages (2026-07-15→07-28 and 2026-08-15→08-20).

The live server writes a `Connections N ZDOS:` line roughly every ~10 minutes even with zero players,
so a log that hasn't grown in `STALE_LOG_THRESHOLD_MS` (default 30 min) means the server is down:

- **Down transition** → `sync` webhook with `serverOnline: false` and an empty roster (dashboard shows
  offline, 0 players), the local roster is reset, and a `⚠️` alert goes to Discord. Fires **once**;
  while down it repeats at most every `SERVER_DOWN_REALERT_MS`.
- **Recovery** (log grows again — including a *shrink*, which is what a restart's truncation looks
  like) → `sync` with `serverOnline: true` and a `✅` alert.
- **A failed SFTP connect is not server-down.** That's a network/host/credential failure and is
  handled exactly as before: the staleness clock freezes rather than advancing on unobserved ticks.
- The clock (`liveness` in `state.json`, seeded from the remote log's mtime on a cold start) survives
  a poller restart, so restarting the poller can't reset a running outage timer.
- The ops heartbeat carries `serverLive`, `logAgeSec`, and `downSinceIso` in its metrics.

State machine lives in `src/liveness.js` (pure functions) and is covered by `npm run test:liveness`.

## Chat mirror (in-game → Discord, one-way)
Shouted chat is mirrored to Discord (only shouts reach a dedicated server —
proximity "say"/whisper never do, so shout = the server's global chat).
Two capture paths, deduped (plugin preferred for its original casing):
1. `[EILIF_CHAT] name | text` from Eilif Companion ≥0.1.2 (raw casing);
2. the mod-free console shout echo (text arrives UPPERCASED).
Slash-command shouts (`/oath`, `/pin`, …) are never mirrored as chat. Chat is
posted straight to Discord — it never touches the dashboard webhook/events
table (the site is public; chat is not). Mentions are hard-disabled.

## Viking identity (SteamID pairing)
Valheim allows **duplicate character names** and never verifies them, so a name on its own is not
an identity — anyone can roll a second "Alice" and, before this, take over her oath, her pins and
her Discord link (audit security-3). The parser already correlates `Got connection SteamID <id>`
with the following `Got character ZDOID from <name>` line, and the poller now forwards that pairing
as `steamId` on `join` / `leave` / `oath` / `pin`. The webhook binds it to `players.steam_id` on
**first sight** (the first Steam account to join under a name owns that name), never overwrites a
binding, and refuses oath / pin / `/oath CODE` link writes that arrive under a different account —
while still recording presence, because someone really is in the world. A join under the wrong
account also makes the poller post one `⚠️ Identity check:` alert per (name, SteamID) pair.
Events we have no pairing for (a shout captured before the join line, a restart mid-session) carry
no `steamId` and are allowed through, so the guard never invents a false positive.
**Admin release procedure:** first sight binds and nothing clears a binding automatically, so a
viking that legitimately changes hands — a new Steam account, a mis-bind during testing, an
impostor who got there first — must be released by hand in the Supabase SQL editor with
`update players set steam_id = null where character_name = '<name>'`. The next join under that name
binds it fresh and unfreezes that name's oaths, pins and Discord link immediately. (The Discord
link has its own separate release, `update players set discord_user_id = null where …` — clear both
if a viking is being handed over wholesale.)

## Notes / future
- Boss kills are **not** in the log — tracked manually for now (no parser rule).
- The `Connections N` server heartbeat is only emitted ~every 10 min; join/leave events are
  real-time, so presence still updates within one poll interval.
