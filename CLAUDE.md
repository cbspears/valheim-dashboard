@AGENTS.md

<!-- ───────────────────────────────────────────────────────────── -->
## Eilif — orientation for a fresh session

**This repo** = the Eilif Valheim community dashboard + Discord integration (an *evolving* project). **Site is LIVE:** https://valheim-dashboard.vercel.app

**Get oriented fast — read these (all current):**
1. `docs/PROJECT.md` — requirements, architecture, decisions, risks
2. Obsidian **live tracker** → `~/Documents/Obsidian Vault/30-Personal/projects/Valheim-SuperServer/08-Dashboard/02-Tracker.md` (status, to-dos, ideas — the source of truth; **keep it updated as you work** — user preference)
3. `git log --oneline -20`
4. Auto-memory `project-valheim-dashboard` (loads automatically)

**Current state:** dashboard live (Vercel) — pages Hall (+ **Hearth** server-pulse card), Vikings (+ **attendance grid** "Nights at the Hearth" + **How We Die** cause tally), World, **Map** (fog-masked demo atlas + season-timelapse scrubber + pins/place-photo panels + weekly "world grew" overlay — full map is SECRET, real seed never shown; swaps to the real WebMap SFTP pipeline at launch), Saga (+ **Episodes** — sessions cluster into titled cards via `lib/episodes.ts`), Mods, Gallery, Get Started. Discord bot live (systemd `eilif-discord-bot`, recaps gated to launch). Host = **GTXGaming, SFTP** (G-Portal/FTP retired; ⚠️ box unreachable as of 2026-07-02 — Charlie checking the panel); log poller built + parked. **Stats pivot:** ServerCharacters is DEAD (hard V+ incompat) — plan of record = pilot **GsValheimStats** Emitter+Client → new `/api/gs-ingest`; the `.fch` stats parser survives only as an optional companion idea. Full plan: vault `08-Dashboard/03-Full-Review-2026-07-02.md`. Two newer features are **built + deployed but their bot side is gated off**: Discord **events** → "Coming Up" (`EVENTS_SYNC=0`) and the **photo gallery** (`GALLERY_INGEST=0`) — flip in the bot `.env` + restart to go live. **Demo data seeded in Supabase — wipe before launch.** Full handoff (gated flips, wipe list, empty config slots, open questions) is in the tracker's **"🧭 Pick up here"** section.

**Gotchas:**
- **Node 20 via nvm** (system node is 18): `export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20` before npm/next/vercel.
- **Vercel deploys require the git commit author = `charlie@blockspace.media`** (the team owner). Repo git config is set to it — keep it, or deploys block with `TEAM_ACCESS_REQUIRED`. Deploy: `vercel deploy --prod --yes --scope charlie-9292s-projects` (needs the user's token).
- Local preview: `localhost:3400` (`next start`). Bot/poller `.env` hold secrets (gitignored).

**Next task:** generate the 8 boss portraits + wire them into the World timeline — see the tracker's "Now" list. (All DB migrations this session — `player_stats` columns, `discord_events`, `gallery_photos` + `gallery` Storage bucket — are **already applied to prod**; SQL is checked into `db/` for reference.)
