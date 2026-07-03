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
