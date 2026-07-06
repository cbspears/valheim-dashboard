@AGENTS.md

<!-- ───────────────────────────────────────────────────────────── -->
## Eilif — orientation for a fresh session

**This repo** = the Eilif Valheim community dashboard + Discord integration (an *evolving* project). **Site is LIVE:** https://valheim-dashboard.vercel.app

**Get oriented fast — read these (all current):**
1. `docs/PROJECT.md` — requirements, architecture, decisions, risks
2. Obsidian **live tracker** → `~/Documents/Obsidian Vault/30-Personal/projects/Valheim-SuperServer/08-Dashboard/02-Tracker.md` (status, to-dos, ideas — the source of truth; **keep it updated as you work** — user preference)
3. `git log --oneline -20`
4. Auto-memory `project-valheim-dashboard` (loads automatically)

**🆕 2026-07-06 session (chat mirror → copy pass → angler/milestones → ART OVERHAUL, all LIVE in prod through `a740bcf`):**
- **Visual overhaul SHIPPED:** 24 painterly EILIF images in `public/images/eilif/` — hero (02) on the Hall, header bands on all 8 pages, 7 boss portraits (defeated/next/locked states) on the World timeline + war-rooms, Deep North = "???" mystery card, og:image = 00. All gated by `config/art.ts ART_AVAILABLE` (to add/swap art: drop a jpg + edit the manifest). Full-res source archives in Charlie's Drive folder.
- **Copy doctrine (Charlie, MANDATORY for all new copy):** titles/labels say plainly WHAT is shown; Norse flavor lives in subtitles + empty states. Get Started is the model register.
- **Angler:** fish → `gs_stats.fish` via `config/fish.ts` (⚠️ prefab ids UNVERIFIED vs live — watch Vercel logs for the "unknown Fish*" info line on the first real catch). Anglers board on /players, The Catch log on viking pages.
- **Great Deeds (collective milestones):** `milestones` table (15 deeds) + evaluator in gs-ingest → in-game voice + Saga + Discord embed (bot loop, `MILESTONE_CHANNEL=server` = PILOT override). Hall card + /world ledger. **"The First Marathon" is at ~99% and will fire on the next play session — first live end-to-end test, watch #server.** Backfill guard ran; junk `player_stats` rows (manual-test, Chærlie) deleted — Chærlie's row rebuilds from his client's cumulative POST.
- **Chat mirror (one-way game→Discord):** shouts → #server via the log poller (console-echo path live NOW, UPPERCASED; Companion **v0.1.2** uploaded to `plugins/EilifCompanion/` arms raw-case `[EILIF_CHAT]` at the NEXT restart; poller dedupes twins). Poller env: `DISCORD_TOKEN`+`CHAT_CHANNEL_ID`; bot does NOT have Manage Webhooks (posts-as-player upgrade needs Charlie to grant it).

**Current state (post pilot-night, 2026-07-04):** THE PIPELINE IS LIVE ON THE REAL SERVER (test world "Dedicated", seed SuperSeed — real launch world comes ~Sept). Pages: Hall (+ **Hearth** pulse card — live), Vikings (+ attendance grid + How We Die), World, **Map** (LIVE fog-masked world + real per-in-game-day timelapse replay + real `/pin` markers; demo timelapse below it), Saga (+ Episodes), Mods, Gallery, **Oath** (+ `/viking/[slug]` + `/boss/[slug]` dynamic pages). Server mods (all verified loading next to V+ 0.9.17.1): **Eilif Companion** (in-game `/oath`+`/pin` capture via shout; VOICE speaks center-screen via /api/voice queue), **GsValheimStats Emitter** (→ `/api/gs-ingest`: authoritative online roster + worldDay), **WebMap** (map.png/fog.png pulled over SFTP by `scripts/map-snapshot.mjs`).

**✅ ALL THREE SERVICES ARE SYSTEMD (2026-07-04, enabled = auto-boot):** `eilif-log-poller` (`services/log-poller`, state.json), `eilif-map-snapshot` (`node scripts/map-snapshot.mjs --loop`, 5-min cadence, day-frames + manifest), and `eilif-discord-bot` (`VOICE_ENGINE=1`, `EVENTS_SYNC=1`, `GALLERY_INGEST=1` all ON). Unit files: `/etc/systemd/system/eilif-*.service` (reference copies in `services/`). ⚠️ Bot and poller have identical cmdlines (`node src/index.js`) — tell them apart by cwd, never pkill by pattern.

**🗨️ Chat mirror (2026-07-05, one-way game→Discord):** shouted in-game chat mirrors to #server via the log poller (console-echo path live now, UPPERCASED; Companion v0.1.2's raw-case `[EILIF_CHAT]` line arms at the next server restart — poller dedupes the twins, prefers plugin). Chat never touches the events table or the public site. Poller env: `DISCORD_TOKEN`+`CHAT_CHANNEL_ID` (or `CHAT_DISCORD_WEBHOOK` for posts-as-player — needs someone to grant the bot Manage Webhooks first; it does NOT have Administrator despite older notes).

**⏳ Armed at the NEXT server panel restart:** Eilif Companion **v0.1.2** (chat capture) + the Emitter `Token` (written into `net.cproudlock.gsvalheimstats.cfg` over SFTP 2026-07-04 — after that restart, enforce Bearer in `/api/gs-ingest`). Still needed in that window: **crossplay OFF** in panel launch params (was NOT done at the 2026-07-04 14:31 CDT restart — PlayFab session still active). Also outstanding: GTX support ticket to firewall public port 3000 (WebMap page). **Oaths/pins must be SHOUTED in-game** (`/s /oath ...`) — unknown /commands are swallowed client-side; capture is via the server's console shout echo (mod-free) + the plugin hook (pins need position). Full ops gotchas: vault `05-Server/Server-Setup-Runbook.md`; live board: vault `08-Dashboard/02-Tracker.md`; review of record: `08-Dashboard/03-Full-Review-2026-07-02.md`. Two newer features are **built + deployed but their bot side is gated off**: Discord **events** → "Coming Up" (`EVENTS_SYNC=0`) and the **photo gallery** (`GALLERY_INGEST=0`) — flip in the bot `.env` + restart to go live. **Demo data seeded in Supabase — wipe before launch.** Full handoff (gated flips, wipe list, empty config slots, open questions) is in the tracker's **"🧭 Pick up here"** section.

**Gotchas:**
- **Node 20 via nvm** (system node is 18): `export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20` before npm/next/vercel.
- **Vercel deploys require the git commit author = `charlie@blockspace.media`** (the team owner). Repo git config is set to it — keep it, or deploys block with `TEAM_ACCESS_REQUIRED`. Deploy: `vercel deploy --prod --yes --scope charlie-9292s-projects` (needs the user's token).
- Local preview: `localhost:3400` (`next start`). Bot/poller `.env` hold secrets (gitignored).

**Next tasks (updated 2026-07-06):**
1. **Next server restart window** (panel, Charlie/Benson): crossplay OFF → then enforce Bearer in `/api/gs-ingest` (Emitter token armed since 07-04) → verify Companion v0.1.2 chat capture (`[EILIF_CHAT]` in LogOutput.log, pretty casing in #server). Remember the gotcha: confirm the log actually truncated before trusting new plugin code loaded.
2. **Pack v3 export** (Charlie, in r2modman): disable Useful_Paths, import `plugins/eilif-paths/dist/EilifPaths.dll` as local mod, export code → Claude verifies + publishes on Get Started/Mods. Crew's v2 pack still carries broken Useful_Paths; unmodded players' deaths stay invisible until they update.
3. **Verify live:** first Great Deed announcement ("The First Marathon", ~300m away) — voice line + #server embed + Saga event; and fish prefab ids on the first real catch (Vercel logs).
4. **Pilot overrides to revert before launch:** `RECAP_CHANNEL=server`, `RECAPS_START`, `MILESTONE_CHANNEL=server` (→ valheim), zero milestones achieved state (SQL comment in `db/2026-07-05_milestones.sql`), cull joke roster chars if desired.
5. Deep North boss art when the game reveals it → drop jpg + add to `ART_AVAILABLE` (mystery card flips automatically). Polish: boss war-room portrait uses `locked` for the current objective — consider `next`.
6. GTX support ticket: firewall public port 3000 (WebMap).
7. Optional: grant the bot Manage Webhooks → set `CHAT_DISCORD_WEBHOOK` in poller `.env` so mirrored chat posts AS the player. Oath charter wording still Charlie's draft to finalize.
All DB migrations applied to prod; SQL in `db/`. Parked ideas (Regatta, Tithe Chest, Server Firsts) in `docs/SPEC-2026-07-05-angler-milestones.md`.
