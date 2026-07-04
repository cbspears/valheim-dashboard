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

**⚠️ RUNNING AS nohup ON THIS PC (not reboot-safe — systemd-ify = top next task):** log-poller (`services/log-poller`, `npm start`, state.json) and the map-snapshot loop (`node scripts/map-snapshot.mjs --loop`, 5-min cadence, day-frames + manifest). The Discord bot IS systemd (`eilif-discord-bot`) with `VOICE_ENGINE=1` currently ON.

**⏳ Armed at the NEXT server panel restart:** the /pin-capable Companion DLL (already uploaded); do in the same window: add `Token = <VOICE_API_TOKEN>` to `net.cproudlock.gsvalheimstats.cfg` + enforce it in `/api/gs-ingest`, and turn **crossplay OFF** in panel launch params. Also outstanding: GTX support ticket to firewall public port 3000 (WebMap page). **Oaths/pins must be SHOUTED in-game** (`/s /oath ...`) — unknown /commands are swallowed client-side; capture is via the server's console shout echo (mod-free) + the plugin hook (pins need position). Full ops gotchas: vault `05-Server/Server-Setup-Runbook.md`; live board: vault `08-Dashboard/02-Tracker.md`; review of record: `08-Dashboard/03-Full-Review-2026-07-02.md`. Two newer features are **built + deployed but their bot side is gated off**: Discord **events** → "Coming Up" (`EVENTS_SYNC=0`) and the **photo gallery** (`GALLERY_INGEST=0`) — flip in the bot `.env` + restart to go live. **Demo data seeded in Supabase — wipe before launch.** Full handoff (gated flips, wipe list, empty config slots, open questions) is in the tracker's **"🧭 Pick up here"** section.

**Gotchas:**
- **Node 20 via nvm** (system node is 18): `export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20` before npm/next/vercel.
- **Vercel deploys require the git commit author = `charlie@blockspace.media`** (the team owner). Repo git config is set to it — keep it, or deploys block with `TEAM_ACCESS_REQUIRED`. Deploy: `vercel deploy --prod --yes --scope charlie-9292s-projects` (needs the user's token).
- Local preview: `localhost:3400` (`next start`). Bot/poller `.env` hold secrets (gitignored).

**Next tasks (in order):** 1) systemd-ify log-poller + map-snapshot (reboot safety); 2) the restart-window bundle above (pin DLL arm + ingest token + crossplay off); 3) GsValheimStats **Client** staging pilot → rich per-viking stats into `/api/gs-ingest` (server payloads already consumed; client payloads ack'd-only); 4) Oath page copy: add the in-game ritual ("SHOUT it: `/s /oath ...`"); 5) boss portraits → World timeline. All DB migrations are applied to prod; SQL lives in `db/` for reference. All demo/test data is on the tracker's launch wipe list.
