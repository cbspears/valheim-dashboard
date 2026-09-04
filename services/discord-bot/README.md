# Eilif Discord Bot

Posts Valheim server activity to Discord and runs the nightly recap. Reads from the same Supabase the
dashboard uses; the SFTP log poller (and later the DiscordConnector mod) feed events in.

## Channel routing
| Channel | Posts | @everyone? |
|---------|-------|-----------|
| **#server** (`CHANNEL_SERVER`) | joins, leaves, deaths, raids — compact activity feed | no |
| **#valheim** (`CHANNEL_VALHEIM`) | **first** boss kills, the nightly recap, manual announcements | boss kills ✅, announcements ✅, recaps ❌ |

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
Mention Everyone). Intents (all non-privileged, declared in `src/discord.js`): **Guilds**,
**GuildScheduledEvents** (the events sync), **GuildMessages** (gallery/oath/identity/`say:` ingest via
@mentions) and **GuildMessageReactions** (the 🗑️ gallery trash react).

## Run
```bash
npm start              # live
npm run dry-run        # no Discord login; prints what it WOULD post (validates formatting)
npm test               # voice + titles + milestones unit tests (no network)
```

> ⚠️ **`npm run dry-run` is the only safe preview.** It never logs in to Discord and never writes
> (reads Supabase, prints to the console). `scripts/preview.js` and `scripts/preview-recap-live.js`
> log in and **POST live to #server** — they are demo tools for a channel you don't mind writing to,
> not dry runs. `scripts/announce.js` and `scripts/mark-boss.js` also write for real.

## Operator scripts
```bash
# Manual @everyone announcement to #valheim
node scripts/announce.js "Raid night Saturday 8pm — bring poison mead!"

# Mark a boss felled (boss kills aren't in the server log). Updates the DB and
# inserts a boss event; the running bot announces it to #valheim within ~30s.
node scripts/mark-boss.js "Bonemass" "Bjorn Ironside,Astrid Shieldmaiden" "Took two tries"
```
There are **no slash commands** by design — boss kills are marked with the script above.

## Daily recap
**One** cron job (23:00 `America/Chicago` by default; `RECAP_EVENING_HOUR` moves the hour) posts an
activity embed to `RECAP_CHANNEL` (default #valheim): vikings active, hours logged, deaths, boss
kills, who's online, the world day, the day boards and the Player of the Day — over the trailing 24
hours. The old 08:00 morning recap is retired; `postRecap('morning')` still exists for previews.
Recaps stay silent until `RECAPS_START`.

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
empty hall — **and** never within `VOICE_MIN_GAP_MS` (default 30 min) of the most recent voice line
of *any* kind. A 60s tick accumulates online-minutes whenever `server_status.player_count > 0`; at
120 accumulated minutes it queues one line and resets (if the gap isn't clear the cadence is *held*,
not thrown away). **Any** event or manual line also resets the clock. The accumulator lives in
`state.json`, so restarts don't double-speak. Ambient content rotates over atmosphere lines and
dated **callbacks** to deaths from ~1/2/4 weeks ago, never repeating a template within its last 5
uses.

**Whispers on quiet nights** — a *pool swap* for that same ambient slot, not extra volume (same
clock, same gap): when exactly **1** viking is online, Eilif whispers to them by name; when **2–3**
are online and the `events` table has been silent for 45 minutes, it uses the quiet-crew pool. Any
other hall (4+, or a busy one) gets the normal atmosphere/callback lines. Whispers carry
`meta.source = 'whisper'`.

**Dawn lines** — their own clock: once on **every 3rd world day** (`world_day % 3 == 0`), only while
players are online. Not on the 2h cadence and not gap-limited. Most name **Eilif**, so players can
tell these from vanilla Valheim's own on-screen text.

**Event lines (immediate; exempt from every gap, reset the ambient clock):**
- **POTY coronation** — when the evening recap crowns a Player of the Day (thin hook at the
  `poty_history` insert).
- **Death milestones — per player**, at **20 / 50 / 100 / then every +100** deaths, once each
  (tiers tracked per viking in `state.json`; the first pass after this shipped adopts everyone's
  current tier *silently*). The old every-50th-**warband**-death line is retired.
- **Oath echoes** — an in-game oath (`oaths` where `source='ingame'`, `announced_at` null) gets an
  in-game echo **and** is cross-posted to #valheim; then `announced_at` is set.
- **Great Deeds** and **title changes** — queued by `milestones.js` / `titles.js` at their own
  announce moment (see below).
- There is **no** first-biome discovery line — removed entirely.

## Great Deeds & titles (announcements)
**Great Deeds** (collective milestones): the dashboard's evaluator stamps `achieved_at`; this bot
announces them. **One announcement moment** — the Discord embed **and** the in-game voice line fire
together, in the same pass. Deeds that cross at the same instant are drained **one per tick, oldest
first** (ties broken by the ladder's `sort`), with `MILESTONE_MIN_GAP_MS` (**default 60000 = 1 min**)
of quiet between them; `MILESTONES_INTERVAL_MS` sets how often the announcer looks (keep it at or
below the gap, or the loop — not the gap — paces the drain). Nothing is ever silenced; rarity is the
thresholds' job. Channel: `MILESTONE_CHANNEL` (default `valheim`).

**Titles**: the loop polls `/api/titles` and, whenever a viking's computed title **changes**, posts a
⚔️ line to `TITLE_CHANNEL` (default `server`, i.e. unchanged) and queues the matching voice line — no
rate limiting, the API's hysteresis makes changes rare. A viking's first-ever title is recorded
silently. Set `TITLE_CHANNEL=valheim` at launch if titles should follow deeds/oaths/recaps.

**Puppet mode:** a member with **Administrator** or **Manage Server**, or any role id listed in
`ADMIN_ROLE_IDS`, can say `@Eilif say: <line>` to queue a `manual` line (reacts **🗣️**). Anyone else
gets a one-line `(admins only)` reply; ordinary oath/bio/role messages pass straight through to the
oath ingest untouched.

**Housekeeping:** queued-but-unspoken lines are marked **`expired`** (status `expired`, `spoken_at`
left NULL, so an unspoken line can never look delivered) after **24h** — except the POTY coronation,
which says "tonight" and expires after **3h**. This runs on its own 5-minute timer, independent of
the voice tick and of anyone being online. `GET /api/voice` only ever serves `status='queued'`, so
the in-game side is unaffected. Needs `SUPABASE_SERVICE_ROLE_KEY`.

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
| `SUPABASE_SERVICE_ROLE_KEY` | all writes: voice lines, oaths, titles, deed `announced_at`, `scripts/mark-boss.js` |
| `POLL_INTERVAL_MS` | event relay cadence (default 15s) |
| `VOICE_MIN_GAP_MS` | min quiet before an **ambient** line (default `1800000` = 30 min; 0 disables). Dawn/event lines ignore it |
| `MILESTONE_MIN_GAP_MS` | quiet between two Great Deed announcements (default `60000` = 1 min) |
| `MILESTONES_INTERVAL_MS` | how often the deed announcer polls (keep ≤ the gap; live `.env` is `60000`) |
| `TITLE_CHANNEL` | where title proclamations go: `server` (default, unchanged behaviour) or `valheim` |
| `ADMIN_ROLE_IDS` | comma-separated role ids allowed to use `@Eilif say:` on top of Administrator / Manage Server |
| `RECAP_EVENING_HOUR` | hour of the nightly recap, local `TZ` (default `23`) |
| `TZ` | recap timezone (`America/Chicago`) |

Full annotated list: `.env.example`.
