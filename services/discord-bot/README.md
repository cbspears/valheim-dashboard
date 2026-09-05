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
npm start                    # live
npm run dry-run              # rehearse every loop once, print what it WOULD post, exit
npm run dry-run -- --loop    # same, but keep the loops running at production cadence
npm test                     # voice + titles + milestones + gallery-resize unit tests (no network)
```

### What the dry run rehearses

It is a **rehearsal of the live bot, not a subset of it**: it builds the same loops `runLive`
builds, out of the same modules, honouring the same env gates (`VOICE_ENGINE`, `TITLES_ANNOUNCE`,
`MILESTONES_ANNOUNCE`, `RECAP_CHANNEL`, `MILESTONE_CHANNEL`, the gap and interval vars), and ticks
each one once — relay, boss watch, the **voice engine** (plus its stale-queue expiry), the
**living-titles announcer**, the **Great Deeds announcer**, and both recaps. It closes with the
per-loop pass/fail table the ops cockpit would have been sent. `--loop` keeps them all running.

Two guarantees, and neither is a matter of convention:

- **It never logs in to Discord.** `post` prints, the voice engine gets a stub client, and
  `DISCORD_TOKEN` is never read — a dry run works with no token in the environment at all.
- **It never writes.** The announcers return at their first line without a service-role client, so
  a dry run needs one; it gets the real client wrapped **read-only** — selects pass through,
  `insert`/`update`/`upsert`/`delete` are printed as `[dry-run db] … SKIPPED` and answered with the
  success shape. So the whole read → decide → format → post → record path runs against real rows
  and nothing moves. (Which also means nothing is ever marked announced: under `--loop` the same
  deed or title re-announces every pass. That is the point.)

Five things are deliberately **not** rehearsed, and the run names each one on the way in rather
than leaving a silent gap: `events-sync` (needs a live gateway, and POSTs to the webhook for real),
`identity-confirm` (builds its own service-role client inside `identity.js` and DMs real users),
the gallery / oath / identity-link ingests (message handlers — a stub client never emits), the
Skald retelling (a ~90 s local-LLM call per boss, and a dry run makes every felled boss look
fresh), and the ops heartbeat (it must not tell `/admin/ops` that a bot is alive). The
`RECAPS_START` gate is also ignored, so recap formatting is visible before launch day.

> ⚠️ **`npm run dry-run` is the only safe preview.** `scripts/preview.js` and
> `scripts/preview-recap-live.js` log in and **POST live to #server** — they are demo tools for a
> channel you don't mind writing to, not dry runs. `scripts/announce.js` and `scripts/mark-boss.js`
> also write for real.

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

## Photo gallery ingest (`GALLERY_INGEST=1`)
Post an image in `CHANNEL_GALLERY` and @mention the bot: it re-hosts the image in the public
`gallery` Supabase Storage bucket (Discord CDN URLs expire), inserts a `gallery_photos` row for the
dashboard's Gallery page, links it to a map pin if the caption names a pinned place, and reacts 🖼️.
An admin (**Manage Messages**) reacting 🗑️ on the photo message deletes the row(s) + object(s).

**Photos are resized on ingest — the original is never stored.** Each attachment is decoded,
auto-oriented from EXIF, downscaled so its longer edge is at most `GALLERY_MAX_EDGE` (default
**1600 px**, never upscaled) and re-encoded as **WebP q82** via [`sharp`](https://sharp.pixelplumbing.com);
that WebP is what gets uploaded (`.webp` key, `image/webp`) and what `url` points at. The row shape
is unchanged — `content_type`, `width` and `height` just describe the stored WebP now, not the
Discord original.

Why: Valheim screenshots arrive as 3–7 MB full-resolution PNGs, and `/gallery` loads them raw. The
four photos in the bucket on 2026-09-04 were 17.3 MB together — roughly **290 page views/month
would have hit the Supabase Free plan's 5 GB egress cap on four photos alone**, and ~200 such photos
fill the 1 GB storage. Blowing that cap throttles the whole project: the map, the gallery *and* the
REST API the dashboard and bots read. Re-encoded, those same four are **0.17 MB (≈103× smaller)**
with no visible loss at the sizes the masonry grid and lightbox actually render.

Notes:
- Attachments over **12 MB** are still skipped outright before download (unchanged OOM guard);
  the resize happens after, so the cap governs the original, not the stored file.
- **Animated GIF/WebP keeps its first frame** (a still is what the grid shows anyway; re-encoding
  an animation would defeat the byte budget). Anything `sharp`/libvips can't decode is skipped with
  a `[gallery] skipped … could not decode` warning — it is never uploaded full-size as a fallback.
- Attachments are processed **one at a time**; a failure on one photo is logged and the rest of the
  post still lands. Every ingest logs the before/after byte sizes.
- Existing rows are untouched: photos ingested before this change still point at their original PNG.

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
| `GALLERY_MAX_EDGE` | longest edge (px) of a stored gallery photo before WebP re-encode (default `1600`) |
| `ADMIN_ROLE_IDS` | comma-separated role ids allowed to use `@Eilif say:` on top of Administrator / Manage Server |
| `RECAP_EVENING_HOUR` | hour of the nightly recap, local `TZ` (default `23`) |
| `TZ` | recap timezone (`America/Chicago`) |

Full annotated list: `.env.example`.
