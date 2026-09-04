@AGENTS.md

<!-- ───────────────────────────────────────────────────────────── -->
## Eilif — orientation for a fresh session

**This repo** = the Eilif Valheim community dashboard + Discord integration (an *evolving* project). **Site is LIVE:** https://eilif-dashboard.vercel.app (also serves https://valheim-dashboard.vercel.app — do not redirect: ingest/webhook endpoints are hard-coded to it in shipped mod configs)

**🆕 2026-08-27 LIVING BOARDS (in-game leaderboard signs) is LIVE:** `GET /api/boards` (Bearer `BOARDS_TOKEN`; strings rendered by `lib/boards.ts`) + server-only plugin `plugins/eilif-boards/` (EilifBoards 0.2.0, no Harmony — writes sign ZDO text, revision-based replication). Players write `[board:kills]` (or `[board:kills:leader]` for a champion plaque) on any sign; write anything else to unclaim. Full player how-to + ops crib: vault `08-Dashboard/06-Living-Boards.md`; plugin design/ops: `plugins/eilif-boards/README.md`. ⚠️ GTX host is Windows: loaded plugin DLLs are file-locked — swap DLLs only while the server is STOPPED (retrying-upload pattern).

**Get oriented fast — read these (all current):**
1. `docs/PROJECT.md` — requirements, architecture, decisions, risks
2. Obsidian **live tracker** → `~/Documents/Obsidian Vault/Main/30-Personal/projects/Valheim-SuperServer/08-Dashboard/02-Tracker.md` (status, to-dos, ideas — the source of truth; **keep it updated as you work** — user preference)
3. `git log --oneline -20`
4. Auto-memory `project-valheim-dashboard` (loads automatically)

**🔴 STATE AS OF 2026-09-04 (T−5 — launch is Wed 2026-09-09, Valheim 1.0 / Deep North day)**

Read the **T−6 launch audit** first — it is the punch list of record and supersedes anything older on this page: <https://claude.ai/code/artifact/027b851f-456f-4676-b2c5-cbc1d2fa917a>. Day-by-day owners, the posture tree, corrections to the record, and the twelve-step cutover sequence all live there. Live status board: the tracker's **2026-09-04** block (vault `08-Dashboard/02-Tracker.md`).

**The three decisions that determine launch night** (all Charlie's, none of them code):
1. **The 1.0 posture.** ValheimPlus has **no 1.0 build** and Grantapher has been silent since 2026-02-06. Steam's `default_old` branch is the pre-February build, *not* 0.221.12, so "pin the server and have players opt back" only works if Iron Gate rotates that branch on patch day. Recommended: stay on **0.221.12** for launch night with a Steam-independent rollback copy, migrate to 1.0 when the mods are green.
2. **Panel → Death penalty = Casual.** Keep-gear (`deathkeepequip`) exists today **only** because Eilif Companion 0.3.0 injects it 30 s after every boot; the panel still says `DeathPenalty->easy`. The first boot where that plugin fails to load — which is what 1.0 does to an unrecompiled plugin — everyone drops everything again. Casual is the durable fix, plus one recorded test death.
3. **The GTX ticket** — pin the game build (no scheduled Steam Update on the 9th; the box auto-bumped the game once already, and there is no branch pin) **and firewall inbound TCP 3000**. Port 3000 is **OPEN** (HTTP 200, re-verified 2026-09-04): WebMap serves the full un-fogged map, `/config`, and live player positions over a WebSocket to anyone. Never `server_port = 0` — it NREs during world load.

**What is where right now**
- **Pack of record: v11** (`01a0440c…`) — decodes cleanly, all eight third-party mods at Thunderstore latest. It pins Companion Client **0.2.0**, so the tombstone keep-list is dark for every player until v12 is minted at cutover.
- **On the box:** Eilif **Companion 0.3.0** and **Boards 0.2.0**, both byte-identical to the repo; Emitter 0.2.4; V+ 0.9.17.1; WebMap 2.7.1; game **0.221.12**.
- **Built but not shipped:** Companion **Client 0.3.0** (tombstone keep-list). The Thunderstore package is **staged and zipped, not uploaded**: `plugins/thunderstore/EilifCompanionClient-0.3.0/` + `…-0.3.0.zip`; see that directory's `UPLOAD.md` for the ship-now-vs-fold-into-the-1.0-rebuild call. The keep-list has **never been exercised on a live server**.
- **Four custom plugins, not three** (`eilif-companion`, `eilif-boards`, `eilif-companion-client`, `eilif-paths`) — all four need a 1.0 recompile, and each `BUILD.md` now carries the launch-day sequence (confirm Steam is on 1.0 → md5-compare the box's `assembly_valheim.dll` → rebuild → **server STOPPED** → upload → Start → only then re-mint the pack).
- **`eilif-stats-parser` is RETIRED** (2026-08-23). It is not in the restart order and its `WORLD_UID`/`CHARACTERS` chores are moot. `scripts/launch-wipe.mjs` still hard-gates on it deliberately, in case someone re-enables it.

**Pilot overrides still live, and their launch values** (bot `.env`, cutover step 8):
`RECAPS_START` → **2026-09-09** *(and delete the systemd unit's own `RECAPS_START` line, or the unit keeps winning over `.env`)* · `RECAP_CHANNEL=server` → **remove** (back to `#valheim`) · `MILESTONE_CHANNEL=server` → **remove** · any other `*_CHANNEL=server` → **remove**, and add a `TITLE_CHANNEL`. Then `daemon-reload`. Poller `.env`: `MAP_REMOTE_DIR` → `map_data/<W>`. Vercel: `GS_EXPECTED_WORLD=<W>` (Vercel env only; **needs a deploy** to take effect). Rotate `GS_EMITTER_TOKEN` and `VOICE_API_TOKEN` to fresh values in the cfg **and** Vercel **and** `.voice-token`.

**Cutover order — `docs/LAUNCH-WIPE.md`.** Two things in it are non-obvious and both were learned the hard way: **stop `eilif-discord-bot` FIRST** (it rewrites `state.json` within 60 s, which would silently swallow launch night's first boss kill — `launch-wipe.mjs` now refuses `--execute` while it runs), and **start `eilif-map-snapshot` LAST**, only after `map_data/<W>` exists and `/api/status` shows the new world's day (the 08-23 wipe left `server_status` alone and the snapshotter framed the *old* world's day 64 four minutes later; the wipe now zeroes it).

**Ops scripts to reach for:** `bash scripts/verify-restart.sh [World]` — what the last panel Stop→Start actually armed: game version (the proof no Steam update ran), plugin list, V+ settings, **panel death-penalty tier and plugin key enforcement as two separate facts**, Combat tier, port-3000 check. `bash scripts/pull-world.sh [World]` — read-only off-box world copy into `~/valheim-world-backups/<W>-<stamp>/`, keeps 14; reference `eilif-world-backup.service`/`.timer` (6 h) are staged in `services/` but **not installed** (needs sudo). `node scripts/launch-wipe.mjs` — dry run by default, read-only.

---

*Everything below this line is historical session context (July–August 2026). It is kept for the reasoning, not the status — where it disagrees with the block above, the block above wins.*

**🆕 2026-07-07 session (recap v2 → milestones ledger v2 → gallery↔map live → /tv, prod `3a3daba`):** recaps = trailing-24h per-name day boards (cumulative board gone) + stale-open-session guard; /world Great Deeds grouped into per-metric tracker chains (plain labels first); **gallery↔map photo linking is LIVE** (migration finally applied — code was already complete); experimental **/tv** TV Mode (unlinked, noindexed, delete `app/tv`+`components/tv` to remove). ~~Server restart verified: Companion v0.1.2 + Emitter token armed, **crossplay STILL ON** (launch param not removed); **Bearer enforcement deferred** until pack v3 pre-fills the client Token.~~ *(All three superseded: Companion on the box is **0.3.0**, crossplay is **OFF**, Bearer on `/api/gs-ingest` is **enforced** and fails closed.)* Full detail: tracker "Recently done" 2026-07-07.

**2026-07-06 session (chat mirror → copy pass → angler/milestones → ART OVERHAUL, all LIVE in prod through `a740bcf`):**
- **Visual overhaul SHIPPED:** 24 painterly EILIF images in `public/images/eilif/` — hero (02) on the Hall, header bands on all 8 pages, 7 boss portraits (defeated/next/locked states) on the World timeline + war-rooms, Deep North = "???" mystery card, og:image = 00. All gated by `config/art.ts ART_AVAILABLE` (to add/swap art: drop a jpg + edit the manifest). Full-res source archives in Charlie's Drive folder.
- **Copy doctrine (Charlie, MANDATORY for all new copy):** titles/labels say plainly WHAT is shown; Norse flavor lives in subtitles + empty states. Get Started is the model register.
- **Angler:** fish → `gs_stats.fish` via `config/fish.ts` (⚠️ prefab ids UNVERIFIED vs live — watch Vercel logs for the "unknown Fish*" info line on the first real catch). Anglers board on /players, The Catch log on viking pages.
- **Great Deeds (collective milestones):** `milestones` table (15 deeds) + evaluator in gs-ingest → in-game voice + Saga + Discord embed (bot loop, `MILESTONE_CHANNEL=server` = PILOT override). Hall card + /world ledger. **"The First Marathon" is at ~99% and will fire on the next play session — first live end-to-end test, watch #server.** Backfill guard ran; junk `player_stats` rows (manual-test, Chærlie) deleted — Chærlie's row rebuilds from his client's cumulative POST.
- **Chat mirror (one-way game→Discord):** shouts → #server via the log poller (console-echo path live NOW, UPPERCASED; Companion **v0.1.2** uploaded to `plugins/EilifCompanion/` arms raw-case `[EILIF_CHAT]` at the NEXT restart; poller dedupes twins). Poller env: `DISCORD_TOKEN`+`CHAT_CHANNEL_ID`; bot does NOT have Manage Webhooks (posts-as-player upgrade needs Charlie to grant it).

**Current state (post pilot-night, 2026-07-04):** THE PIPELINE IS LIVE ON THE REAL SERVER (test world "Dedicated", seed SuperSeed — real launch world comes ~Sept). Pages: Hall (+ **Hearth** pulse card — live), Vikings (+ attendance grid + How We Die), World, **Map** (LIVE fog-masked world + real per-in-game-day timelapse replay + real `/pin` markers; demo timelapse below it), Saga (+ Episodes), Mods, Gallery, **Oath** (+ `/viking/[slug]` + `/boss/[slug]` dynamic pages). Server mods (all verified loading next to V+ 0.9.17.1): **Eilif Companion** (in-game `/oath`+`/pin` capture via shout; VOICE speaks center-screen via /api/voice queue), **GsValheimStats Emitter** (→ `/api/gs-ingest`: authoritative online roster + worldDay), **WebMap** (map.png/fog.png pulled over SFTP by `scripts/map-snapshot.mjs`).

**✅ ALL THREE SERVICES ARE SYSTEMD (2026-07-04, enabled = auto-boot):** `eilif-log-poller` (`services/log-poller`, state.json), `eilif-map-snapshot` (`node scripts/map-snapshot.mjs --loop`, 5-min cadence, day-frames + manifest), and `eilif-discord-bot` (`VOICE_ENGINE=1`, `EVENTS_SYNC=1`, `GALLERY_INGEST=1` all ON). Unit files: `/etc/systemd/system/eilif-*.service` (reference copies in `services/`). ⚠️ Bot and poller have identical cmdlines (`node src/index.js`) — tell them apart by cwd, never pkill by pattern.

**🗨️ Chat mirror (2026-07-05, one-way game→Discord):** shouted in-game chat mirrors to #server via the log poller (console-echo path live now, UPPERCASED; Companion v0.1.2's raw-case `[EILIF_CHAT]` line arms at the next server restart — poller dedupes the twins, prefers plugin). Chat never touches the events table or the public site. Poller env: `DISCORD_TOKEN`+`CHAT_CHANNEL_ID` (or `CHAT_DISCORD_WEBHOOK` for posts-as-player — needs someone to grant the bot Manage Webhooks first; it does NOT have Administrator despite older notes).

**Gotchas:**
- **Node 20 via nvm** (system node is 18): `export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20` before npm/next/vercel.
- **Vercel deploys require the git commit author = `charlie@blockspace.media`** (the team owner). Repo git config is set to it — keep it, or deploys block with `TEAM_ACCESS_REQUIRED`. Deploy: `vercel deploy --prod --yes --scope charlie-9292s-projects` (needs the user's token).
- Local preview: `localhost:3400` (`next start`). Bot/poller `.env` hold secrets (gitignored).

**Historical note.** The "Next tasks (updated 2026-07-06)" list that used to sit here, and the "Armed at the NEXT server panel restart" paragraph that used to precede it, described a world that no longer exists (Companion v0.1.2, pack v3, the test world "Dedicated", Bearer enforcement pending, stats-parser alive). Both are replaced by the 2026-09-04 state block at the top of this file. Kept from them because they are still true: **oaths and pins must be SHOUTED in-game** (`/s /oath …` — unknown `/commands` are swallowed client-side; capture is the server's shout echo plus the plugin hook, which needs the position); **crossplay is now OFF**; **Bearer on `/api/gs-ingest` is enforced**; the `/tv` TV Mode page is still experimental and unlinked (delete `app/tv` + `components/tv` to remove); Deep North boss art still drops in via `config/art.ts ART_AVAILABLE`; and the bot still lacks **Manage Webhooks**, so mirrored chat cannot post as the player.

All DB migrations applied to prod; SQL in `db/`. Parked ideas (Regatta, Tithe Chest, Server Firsts) in `docs/SPEC-2026-07-05-angler-milestones.md`.
