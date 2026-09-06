# Eilif Discord Bot

Posts Valheim server activity to Discord and runs the nightly recap. Reads from the same Supabase the
dashboard uses; the SFTP log poller (and later the DiscordConnector mod) feed events in.

## Channel routing
| Channel | Posts | @everyone? |
|---------|-------|-----------|
| **#server** (`CHANNEL_SERVER`) | joins, leaves, deaths, raids — compact activity feed | no |
| **#valheim** (`CHANNEL_VALHEIM`) | **first** boss kills, the nightly recap, manual announcements, and (off by default) the weekly Chronicle + boss polls | boss kills ✅, announcements ✅, recaps ❌, Chronicle ❌, polls ❌ |

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
npm test                     # voice + titles + milestones + gallery-resize + recap + chronicle + boss-poll
                             # unit tests (no network)
```

### What the dry run rehearses

It is a **rehearsal of the live bot, not a subset of it**: it builds the same loops `runLive`
builds, out of the same modules, honouring the same env gates (`VOICE_ENGINE`, `TITLES_ANNOUNCE`,
`MILESTONES_ANNOUNCE`, `WEEKLY_CHRONICLE`, `BOSS_POLLS`, `RECAP_CHANNEL`, `MILESTONE_CHANNEL`, the
gap and interval vars), and ticks each one once — relay, boss watch, the **voice engine** (plus its
stale-queue expiry), the **living-titles announcer**, the **Great Deeds announcer**, the **boss
polls**, the **weekly Chronicle**, and both recaps. It closes with the per-loop pass/fail table the
ops cockpit would have been sent. `--loop` keeps them all running.

The two off-by-default engagement features print **one line each** saying which way their flag is
set, in the dry run and live, so "is the Chronicle on?" is answered by the first ten lines of the
journal. With the flags off they are silent beyond that line. With them on, the dry run prints the
Chronicle embed and the poll it would send (`[dry-run poll → #channel]`, question, answers, duration)
through a **printing adapter** — the gateway is never touched, so no poll can escape a rehearsal. The
Chronicle's weekly cron is not started under a dry run (it would rehearse nothing until Sunday); its
one tick takes the identical read → format → post path. The boss-poll rehearsal also renders the
follow-up line against the most recent kill on record, with no votes read (there is no gateway), so
the other branches of that copy are covered by `scripts/bosspoll.test.mjs` instead.

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

## Player retellings (`TELLINGS`, on unless `TELLINGS=0`)
A boss's saga used to be one column that only the Skald could write. It is now a table
(`boss_tellings`, `db/2026-09-06_boss_tellings.sql`), and any viking whose Discord is linked to a
character can add their own account of a fight. The war-room shows whichever telling is **chosen**
and folds the rest into a collapsed "Other tellings" list underneath.

Accepted formats (verb case-insensitive; the boss may be its name or its URL slug, in any case,
and a unique fragment works too, so `bone` finds Bonemass):
```
@Eilif retell Bonemass: how the fight really went
@Eilif tell the-elder: the mist came in fast
@Eilif retell The Elder:
we lost the shieldwall twice, and Bren held the gate alone

@Eilif tellings Bonemass          list them, numbered: the chosen one, then newest first
@Eilif keep Bonemass 2            make telling 2 the one the page shows
```

- **Identity-gated**, exactly like the oath ingest: the telling is credited to the character the
  **sender's** Discord account is linked to (`@Eilif I am <name>`, then shout the rune in-game),
  never to a name typed in the message. An unlinked viking is told how to link and nothing is
  written.
- **A new telling becomes the one shown.** The previous one is not deleted, it simply stops being
  chosen, and `@Eilif tellings` still lists it. The Skald keeps writing `bosses.retelling` on every
  kill and files the same text as a telling, marked chosen **only when nothing else is** — so
  regenerating a saga never displaces a viking's account of the fight.
- **The chosen telling is always listed first, and always visible.** Both the list and the war-room
  are bounded at 20 rows; sorting by date alone would let a kept telling age out behind twenty
  newer ones, and the page would quietly go back to showing the newest.
- **`keep`** is allowed for that telling's own author, and for anyone with **Administrator** or
  **Manage Server** or a role id in `ADMIN_ROLE_IDS` (the same check `@Eilif say:` uses, guild-pinned
  the same way). Anyone else gets a one-line refusal.
- **One retell per member per 5 minutes**, held in memory, so a restart forgets it. Listing and
  choosing are not rate limited; the roster of the forsaken is cached for a minute, so a stream of
  messages that merely start with "tell" costs one read rather than one each.
- **The numbers in `tellings` are that moment's numbers.** Another viking's telling landing between
  `@Eilif tellings` and `@Eilif keep` shifts them, so read the list again if the hall is busy.
- Reactions: **📜** on a recorded telling and on a successful `keep`, **❓** when the sender has no
  linked viking. Replies never ping anyone, and every player-typed string is escaped before it
  reaches Discord.
- Text is capped at **2000 characters** (Discord's own message ceiling, and the column's check
  constraint), stripped of control and bidi characters, and stored otherwise **raw** — markdown is
  escaped on display, not on storage, so the site can render blank-line paragraphs as paragraphs.
- One in-game voice line is queued per telling, so the hall hears who told it.
- Needs `SUPABASE_SERVICE_ROLE_KEY`. **Before `db/2026-09-06_boss_tellings.sql` is applied** every
  verb answers "the Hall's ledgers are still being carved" and writes nothing, and the war-room
  renders `bosses.retelling` exactly as it did before.

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

## The Skald's Chronicle (`WEEKLY_CHRONICLE=1`, off by default)
One embed a week to `CHRONICLE_CHANNEL` (default `#valheim`), **Sunday 20:00 local** (`CHRONICLE_HOUR`
moves the hour; the day is fixed). It covers the **trailing seven days**: the week's arrivals, hours
by viking (top 5), deaths and their causes (top 3), kills, deeds earned, bosses felled with their war
party, titles that changed, the Player-of-the-Day winners, and one "next on the horizon" line naming
the first boss still standing. Every section is omitted when it is empty, and a week with nothing in
it renders as one short paragraph instead of a wall of zeroes.

It honours the same **`RECAPS_START` launch gate** the nightly recap does, so turning the flag on
before the world opens cannot publish a week of pre-launch demo rows.

**Supabase reads only, and no LLM** (the Skald *retelling* is a different thing — that one calls a
local model per boss). The only state it writes is `state.json`: the last local date it posted on (so
a restart inside the posting minute cannot send the week twice) and a **weekly kill baseline**.
`player_stats.kills` is cumulative, so a week only has a real number once there is a previous
snapshot to diff against — the **first** Chronicle says `Counting starts this week` rather than
publishing a lifetime total dressed up as a week.

Three things it will not do, because supabase-js *resolves* `{data, error}` rather than throwing and
a failed read otherwise looks exactly like an empty table:

- a week whose counters could not be read says `Not counted this week` and **does not roll the
  baseline forward** (rolling an empty snapshot would make the following week diff every lifetime
  total against zero and publish a career kill count as one week's work);
- an unreadable `bosses` table gets an honest "the ladder could not be read" horizon line, never
  "every boss on the ladder has fallen";
- a database outage is never published as "a quiet seven days".

Every optional board shrinks evenly if a very busy week would push the embed past Discord's
6000-character ceiling, so a rejected post can never cost the week.

## Boss polls (`BOSS_POLLS=1`, off by default)
When a boss flips to felled and another is still on the ladder, the bot posts **one native Discord
poll** (the v14 message `poll` option, not reactions) in `BOSS_POLL_CHANNEL` (default `#valheim`):

> **First blood: Bonemass**
> Vote for the viking you think draws it. The book records who was right.
> ❓ *Who lands first blood on Bonemass?* — single choice, 7 days, up to 10 answers

The answers are the vikings with the most **hours in the last 7 days** (the same ranking the
Chronicle's hours board uses). The poll message id is persisted in `state.json`, so a given boss is
polled **once, ever** — restarts included. When that boss later falls, one follow-up line names who
actually drew first blood (`bosses.fight_stats.firstBlood`) and whether the hall called it:

> ⚔️ First blood on **Bonemass**: **Astrid**. The hall called it, with 5 of 7 votes.

Three behaviours worth knowing: it watches the `bosses` table on its **own** cursor rather than
hooking `bosses.js` (the boss watcher owns exactly-once `@everyone` delivery and should not carry a
second dedupe question), the already-felled set is **seeded on first run** so flipping the flag on
mid-season never polls for a boss felled last month, and if fewer than two vikings would appear on
the ballot the question is **held** in `state.json` and asked on a later tick rather than dropped.
Nothing ends the poll early; it expires on its own after seven days, and the follow-up reads the
live counts.

The ballot gate counts **answers, not candidates**: blank names are dropped and two long names can
clip to the same 55-character string, so a two-viking week can still build a one-answer poll, which
Discord rejects outright. If the seed itself fails at startup (Supabase unreachable), the loop is
**not started at all** for that run and the journal says so — an unseeded cursor would make every
boss felled this season look fresh and open a retro poll on the first tick.

## The Storyteller of Eilif (`STORYTELLER=1`, off by default)
One viking keeps the tales. The office is a row in `offices`
(`db/2026-09-06_offices.sql`), at most one holder at a time, and the database enforces that with a
partial unique index on `(office) where until is null`.

```
@Eilif elect storyteller        open a 24 h reaction ballot   (jarls only)
@Eilif close election           close it early and proclaim   (jarls only)
@Eilif name storyteller <Char>  install a holder with no vote (jarls only)
```

- **The ballot is reactions, not a Discord poll.** An election has to be closable on command,
  rewritten with its own result when it closes, and readable afterwards as an embed naming the
  candidates. Discord's native poll (which the boss polls use) does none of the three.
- **Who stands:** every viking whose Discord is **linked** and who has played in the last **14
  days**, ranked by hours in that window, capped at ten. Unlinked vikings cannot stand: the office
  has to be reachable for the nudge and identifiable for the site badge. Fewer than two candidates
  and the verb refuses rather than posting a ballot of one.
- **A tie goes to the viking higher on the ballot**, which is the one with more hours. It is a rule
  rather than a coin flip, it reads the same every time, and the ballot's own footer says so.
- **The proclamation** posts an embed and speaks ONE line to the whole hall, and it carries the
  **backlog**: every boss that has fallen and that no viking has told. "Two tales wait for you,
  Storyteller: Eikthyr and the Elder."
- **Authority:** the holder may `@Eilif keep <Boss> <n>` on **any** telling, not only their own.
  That is the whole power of the office. Everything else about `keep` is unchanged.
- **Nudges:** a 30-minute loop sends **one** nudge per fallen-and-untold boss per term, 24 h after
  the kill, or **7 days after the term opened** for a boss that fell before the holder took office
  (a new Storyteller inherits a backlog and should not be nudged about all of it on their first
  morning). It is marked in `office_nudges (boss_id, office_id)`, whose primary key IS the
  idempotency. **This nudge is the only place the bot mentions a real user**, and it mentions
  exactly one, with `allowed_mentions.users` pinned to that id.
  The private in-game half is queued **only** with `VOICE_TARGETING=1`; without it there is no
  voice line at all, because "your Storyteller is behind" broadcast to the hall is a different
  message.
- **On the site:** a viking's page shows "Storyteller of Eilif" beside their epithet (and
  "Storyteller for the &lt;act&gt; act" for a former holder); the war-room's tellings card names the
  current Storyteller. The **epithet engine is untouched** — an office is shown next to a title,
  never folded into it.
- After a further week untold, the war-room says so itself: *The Skald's draft stands, for want of
  a storyteller.*

## Telling votes (`TELLING_VOTES=1`, off by default)
When a boss has two or more tellings from the warband, the hall can decide between them.

```
@Eilif vote tellings <Boss>     open a 24 h ballot   (Storyteller or a jarl)
@Eilif close vote <Boss>        close it early       (Storyteller or a jarl)
```

One reaction per telling, the first **300 characters** of each on the ballot. The winner takes
`chosen` (through the same insert-unchosen-then-set path `keep` uses, so the partial unique index
still does the deciding) and is marked `standing = 'canon'`; the runner-up is marked
`'apocryphal'` and the war-room gives it its own heading, **The apocryphal version** — the version
the hall did not pick is still part of how the night is remembered. A telling nobody voted for is
never called apocryphal. The Skald's own draft is not on the ballot: a vote exists to replace it.

One count per boss at a time, and the ballot message is **edited** with its result rather than
answered by a second post. A close **wipes the boss's standings first**, so a second count on the
same boss cannot leave the first count's loser still marked apocryphal (the war-room shows one
apocryphal telling and would quietly fold the other away). `standing` needs
`db/2026-09-06_telling_votes.sql`; without it the count still rules and only the heading is missing.

A ballot the bot **cannot read** is not a ballot of zero. A failed read at closing time leaves the
count open and tries again on the next pass, three times, before closing on what it knows; the same
rule holds for the election.

## Altar tellings (`ALTAR_TELLINGS=1`, off by default)
Where a forsaken fell, the hall remembers out loud.

At the kill, `/api/gs-ingest` reads `player_positions` for the war party and, if at least one is
fresher than five minutes, charts **one pin of kind `boss`** at their centroid, named
`<Boss> altar` and credited to the top-damage viking. That half is **always on** and is harmless
data (a pin named for a boss, guarded so a boss never gets a second one). It is deliberately not
the bare boss name: `/api/webhook`'s `pin` branch replaces a pin **by name**, so an altar called
"Bonemass" would be deleted the first time somebody shouted `/pin Bonemass` at the spot, and the
boss is already dead.

The flagged half is a 60-second loop: for every online viking whose position is fresher than 90 s
and who is within **40 m** of an altar whose boss has a chosen telling, and who has not been told
at that altar in **24 h**, it queues the telling's **first sentence** (cut at the sentence end, max
120 chars) plus a line naming who told it. The whole line is capped at **150 characters**, the same
ceiling every other in-game line keeps; the opening yields the room the closing line needs, so the
teller's name is never the half that gets cut.

> *The bog took two of us. Bren tells the rest.*

⚠️ **It does nothing at all without `VOICE_TARGETING=1`.** The line carries `meta.target` and is
meant for one viking; reading somebody's telling out to the whole server because a third party
walked past would be the wrong message. With targeting off the loop enqueues nothing, and the
startup line says which of the two it is doing. The 24-hour memory lives in `state.json` and is
bounded oldest-first.

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
| `ADMIN_ROLE_IDS` | comma-separated role ids allowed to use `@Eilif say:` and `@Eilif keep` on top of Administrator / Manage Server |
| `TELLINGS` | `0` turns player retellings off — both the verbs (`@Eilif retell/tellings/keep`) and the `boss_tellings` row the Skald files on each kill, so nothing touches the table; anything else, including unset, leaves them on |
| `RECAP_EVENING_HOUR` | hour of the nightly recap, local `TZ` (default `23`) |
| `WEEKLY_CHRONICLE` | `1` turns the weekly Chronicle on (default off) |
| `CHRONICLE_CHANNEL` / `CHRONICLE_HOUR` | where the Chronicle posts (default `valheim`) and the Sunday hour, local `TZ` (default `20`) |
| `BOSS_POLLS` | `1` turns the first-blood polls on (default off) |
| `BOSS_POLL_CHANNEL` / `BOSS_POLLS_INTERVAL_MS` | where polls post (default `valheim`) and how often the watcher looks (default `60000`) |
| `TZ` | recap timezone (`America/Chicago`) |

Full annotated list: `.env.example`.
