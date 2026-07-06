@AGENTS.md

<!-- ───────────────────────────────────────────────────────────── -->
## Eilif — orientation for a fresh session

**This repo** = the Eilif Valheim community dashboard + Discord integration (an *evolving* project). **Site is LIVE:** https://valheim-dashboard.vercel.app

**Get oriented fast — read these (all current):**
1. `docs/PROJECT.md` — requirements, architecture, decisions, risks
2. Obsidian **live tracker** → `~/Documents/Obsidian Vault/30-Personal/projects/Valheim-SuperServer/08-Dashboard/02-Tracker.md` (status, to-dos, ideas — the source of truth; **keep it updated as you work** — user preference)
3. `git log --oneline -20`
4. Auto-memory `project-valheim-dashboard` (loads automatically)

**Current state (post pilot-night, 2026-07-04):** THE PIPELINE IS LIVE ON THE REAL SERVER (test world "Dedicated", seed SuperSeed — real launch world comes ~Sept). Pages: Hall (+ **Hearth** pulse card — live), Vikings (+ attendance grid + How We Die), World, **Map** (LIVE fog-masked world + real per-in-game-day timelapse replay + real `/pin` markers; demo timelapse below it), Saga (+ Episodes), Mods, Gallery, **Oath** (+ `/viking/[slug]` + `/boss/[slug]` dynamic pages). Server mods (all verified loading next to V+ 0.9.17.1): **Eilif Companion** (in-game `/oath`+`/pin` capture via shout; VOICE speaks center-screen via /api/voice queue), **GsValheimStats Emitter** (→ `/api/gs-ingest`: authoritative online roster + worldDay), **WebMap** (map.png/fog.png pulled over SFTP by `scripts/map-snapshot.mjs`).

**✅ ALL THREE SERVICES ARE SYSTEMD (2026-07-04, enabled = auto-boot):** `eilif-log-poller` (`services/log-poller`, state.json), `eilif-map-snapshot` (`node scripts/map-snapshot.mjs --loop`, 5-min cadence, day-frames + manifest), and `eilif-discord-bot` (`VOICE_ENGINE=1`, `EVENTS_SYNC=1`, `GALLERY_INGEST=1` all ON). Unit files: `/etc/systemd/system/eilif-*.service` (reference copies in `services/`). ⚠️ Bot and poller have identical cmdlines (`node src/index.js`) — tell them apart by cwd, never pkill by pattern.

**🗨️ Chat mirror (2026-07-05, one-way game→Discord):** shouted in-game chat mirrors to #server via the log poller (console-echo path live now, UPPERCASED; Companion v0.1.2's raw-case `[EILIF_CHAT]` line arms at the next server restart — poller dedupes the twins, prefers plugin). Chat never touches the events table or the public site. Poller env: `DISCORD_TOKEN`+`CHAT_CHANNEL_ID` (or `CHAT_DISCORD_WEBHOOK` for posts-as-player — needs someone to grant the bot Manage Webhooks first; it does NOT have Administrator despite older notes).

**⏳ Armed at the NEXT server panel restart:** Eilif Companion **v0.1.2** (chat capture) + the Emitter `Token` (written into `net.cproudlock.gsvalheimstats.cfg` over SFTP 2026-07-04 — after that restart, enforce Bearer in `/api/gs-ingest`). Still needed in that window: **crossplay OFF** in panel launch params (was NOT done at the 2026-07-04 14:31 CDT restart — PlayFab session still active). Also outstanding: GTX support ticket to firewall public port 3000 (WebMap page). **Oaths/pins must be SHOUTED in-game** (`/s /oath ...`) — unknown /commands are swallowed client-side; capture is via the server's console shout echo (mod-free) + the plugin hook (pins need position). Full ops gotchas: vault `05-Server/Server-Setup-Runbook.md`; live board: vault `08-Dashboard/02-Tracker.md`; review of record: `08-Dashboard/03-Full-Review-2026-07-02.md`. Two newer features are **built + deployed but their bot side is gated off**: Discord **events** → "Coming Up" (`EVENTS_SYNC=0`) and the **photo gallery** (`GALLERY_INGEST=0`) — flip in the bot `.env` + restart to go live. **Demo data seeded in Supabase — wipe before launch.** Full handoff (gated flips, wipe list, empty config slots, open questions) is in the tracker's **"🧭 Pick up here"** section.

**Gotchas:**
- **Node 20 via nvm** (system node is 18): `export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20` before npm/next/vercel.
- **Vercel deploys require the git commit author = `charlie@blockspace.media`** (the team owner). Repo git config is set to it — keep it, or deploys block with `TEAM_ACCESS_REQUIRED`. Deploy: `vercel deploy --prod --yes --scope charlie-9292s-projects` (needs the user's token).
- Local preview: `localhost:3400` (`next start`). Bot/poller `.env` hold secrets (gitignored).

**Next tasks (in order):** 1) ~~systemd-ify~~ DONE 2026-07-04; 2) crossplay OFF at next restart + then enforce gs-ingest Bearer (token already armed); 3) GsValheimStats **Client** rollout (Benson adds 0.2.9 to the pinned pack) → live death-cause verify → flip poller `EMIT_DEATHS=false`; 4) rest of the client per-player stats merge + webhook boss branch in `/api/gs-ingest`; 5) Oath page copy: add the in-game ritual ("SHOUT it: `/s /oath ...`"); 6) boss portraits → World timeline. All DB migrations are applied to prod; SQL lives in `db/` for reference. All demo/test data is on the tracker's launch wipe list.
