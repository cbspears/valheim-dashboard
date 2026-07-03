# Eilif Discord Bot

Posts Valheim server activity to Discord and runs daily recaps. Reads from the same Supabase the
dashboard uses; the SFTP log poller (and later the DiscordConnector mod) feed events in.

## Channel routing
| Channel | Posts | @everyone? |
|---------|-------|-----------|
| **#server** (`CHANNEL_SERVER`) | joins, leaves, deaths, raids — compact activity feed | no |
| **#valheim** (`CHANNEL_VALHEIM`) | **first** boss kills, two daily recaps, manual announcements | boss kills ✅, announcements ✅, recaps ❌ |

A boss is announced only the **first** time it's felled (tracked in `state.json`). Already-killed
bosses are seeded on first run so nothing is retro-announced.

## Setup
```bash
cd services/discord-bot
nvm use               # Node 20+
npm install
cp .env.example .env  # fill DISCORD_TOKEN + Supabase keys
```
The bot must be **invited** to the server first (View Channels, Send Messages, Embed Links,
Mention Everyone). Intents: Guilds only — no privileged intents needed.

## Run
```bash
npm start              # live
npm run dry-run        # no Discord login; prints what it WOULD post (validates formatting)
```

## Operator scripts
```bash
# Manual @everyone announcement to #valheim
node scripts/announce.js "Raid night Saturday 8pm — bring poison mead!"

# Mark a boss felled (boss kills aren't in the server log). Updates the DB and
# inserts a boss event; the running bot announces it to #valheim within ~30s.
node scripts/mark-boss.js "Bonemass" "Bjorn Ironside,Astrid Shieldmaiden" "Took two tries"
```
There are **no slash commands** by design — boss kills are marked with the script above.

## Daily recaps
Two cron jobs (08:00 and 22:00 `America/Chicago`) post an activity embed to #valheim: vikings
active, hours logged, deaths, boss kills, who's online, and the world day — over the window since
the last recap.

## The Oath ingest (`OATH_INGEST=1`, off by default)
When enabled, the bot records **oaths** posted in Discord that @mention it onto the dashboard's
Signature Wall (`/oath`), plus self-served **bio**/**role** profile updates. Because Discord names
≠ in-game names, the message carries the **in-game name**, which is matched to a roster viking:
exact (case/space-insensitive) → fuzzy (Levenshtein similarity ≥ 0.75 vs full name or first token,
links `player_id`) → unmatched (kept anyway, `player_id` null — an oath is never lost).

Accepted formats (keyword case-insensitive):
```
@Eilif oath — YourVikingName: your oath, one line
@Eilif oath - YourVikingName: your oath, one line
@Eilif oath: YourVikingName — your oath, one line
@Eilif bio — YourVikingName: a line about you
@Eilif role — YourVikingName: Cartographer
```
Reactions: **📜** on a recorded oath (plus **❓** when the name didn't match a viking), **📝** on a
bio/role update (**❓** if no viking matched). Re-swearing **replaces** that Discord user's previous
oath (one per user). Needs `SUPABASE_SERVICE_ROLE_KEY` and the GuildMessages intent (already set).

## The Voice of the Hall (`VOICE_ENGINE=1`, off by default)
Eilif's brain. A server-side game plugin polls `GET /api/voice` and **speaks** queued lines in-game
as "Eilif"; this bot decides **what** gets queued and **when**, writing rows to the `voice_lines`
table (service role). Eilif is a *presence, not a chatterbox*.

**Ambient cadence:** roughly **one ambient line per 2 hours of someone-online time** — never to an
empty hall. A 60s tick accumulates online-minutes whenever `server_status.player_count > 0`; at
120 accumulated minutes (with players still on) it queues one line and resets. **Any** event or
manual line also resets the clock. The accumulator lives in `state.json`, so restarts don't
double-speak. Ambient content rotates over ~21 templates (day-cycle ambience using the world day,
dated **callbacks** to deaths from ~1/2/4 weeks ago, and pure atmosphere), never repeating a
template within its last 5 uses.

**Event lines (immediate; bypass the cadence, reset the clock):**
- **POTY coronation** — when the evening recap crowns a Player of the Day (thin hook at the
  `poty_history` insert): *"The hall has spoken. Tonight the crown rests on {name}."*
- **Death milestones** — every 50th warband death: *"That was the warband's {n}th death. The ravens
  grow fat."* (idempotent via `state.json`).
- **First biome** — a `discovery` event entering a new biome earns a welcome line.
- **Oath echoes** — an in-game oath (`oaths` where `source='ingame'`, `announced_at` null) gets an
  in-game echo *"The hall heard you, {firstName}."* **and** is cross-posted to #valheim; then
  `announced_at` is set.

**Puppet mode:** a member with **Administrator** permission can say `@Eilif say: <line>` to queue a
`manual` line (reacts **🗣️**). Non-admins are ignored silently; ordinary oath/bio/role messages pass
straight through to the oath ingest.

**Housekeeping:** queued-but-unspoken lines older than 24h are marked spoken on each tick, so stale
ambience can't flood the hall when the server comes back. Needs `SUPABASE_SERVICE_ROLE_KEY`.

## Run as a service
```bash
sudo cp eilif-discord-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eilif-discord-bot
journalctl -u eilif-discord-bot -f
```

## Config (`.env`)
| Var | Notes |
|-----|-------|
| `DISCORD_TOKEN` | bot token |
| `GUILD_ID` | server id |
| `CHANNEL_VALHEIM` / `CHANNEL_SERVER` | channel ids |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | reads |
| `SUPABASE_SERVICE_ROLE_KEY` | only used by `scripts/mark-boss.js` |
| `POLL_INTERVAL_MS` | event relay cadence (default 15s) |
| `TZ` | recap timezone (`America/Chicago`) |
