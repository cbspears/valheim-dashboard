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

## Setup
```bash
cd services/log-poller
nvm use            # Node 20+ (see ../../.nvmrc)
npm install
cp .env.example .env   # then fill in SFTP creds + WEBHOOK_SECRET
```

## Test (no server activity needed)
```bash
npm run test:parser   # offline: validates parsing against fixtures/sample-session.log
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

## Chat mirror (in-game → Discord, one-way)
Shouted chat is mirrored to Discord (only shouts reach a dedicated server —
proximity "say"/whisper never do, so shout = the server's global chat).
Two capture paths, deduped (plugin preferred for its original casing):
1. `[EILIF_CHAT] name | text` from Eilif Companion ≥0.1.2 (raw casing);
2. the mod-free console shout echo (text arrives UPPERCASED).
Slash-command shouts (`/oath`, `/pin`, …) are never mirrored as chat. Chat is
posted straight to Discord — it never touches the dashboard webhook/events
table (the site is public; chat is not). Mentions are hard-disabled.

## Notes / future
- Boss kills are **not** in the log — tracked manually for now (no parser rule).
- The `Connections N` server heartbeat is only emitted ~every 10 min; join/leave events are
  real-time, so presence still updates within one poll interval.
