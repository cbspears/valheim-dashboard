<p align="center">
  <img src="public/banner-eilif.webp" alt="Eilif — The Cozy Canon Playthrough" width="100%" />
</p>

<h1 align="center">⚔ Eilif — The Cozy Canon Playthrough</h1>

<p align="center">
  A community dashboard + Discord integration for a modded Valheim server.<br/>
  <em>Bosses gate progression — no sailing ahead of the longship, vikings.</em>
</p>

<p align="center">
  <a href="https://eilif-dashboard.vercel.app">🌐 Live dashboard</a> (also serves <a href="https://valheim-dashboard.vercel.app">valheim-dashboard.vercel.app</a> — do not redirect: ingest/webhook endpoints are hard-coded to it in shipped mod configs) ·
  Next.js 16 · React 19 · Tailwind v4 · Supabase · Discord
</p>

---

## What this is

**Eilif** is a modded Valheim dedicated server (GTXGaming). This repo is the whole stack
that surrounds it: the public dashboard, the Discord integration, the two SFTP bridge
services, the map snapshotter, four custom BepInEx plugins, and the ops tooling that
gets a launch night through the night.

> **New here? Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).** It is the current
> description of the system: every component, every table and its writer, every API route
> and its auth, every env var, and the decisions that are load-bearing.
> `docs/PROJECT.md` is the July history and no longer describes what runs.

| Piece | What it does | Where |
|---|---|---|
| 🖥️ **Dashboard** | Public site: who is on, leaderboards, boss-gated world progress, the fog-masked map, the saga, the oath wall, the gallery | `app/` to Vercel |
| 🤖 **Discord bot** | Relays events to `#server`, first-boss-kill `@everyone` to `#valheim`, the evening recap with Player of the Day, milestones, living titles, the in-game voice queue | `services/discord-bot/` |
| 📜 **Log poller** | Tails the server log over SFTP, derives presence, sessions, deaths, oaths, pins and positions, posts them to the dashboard webhook | `services/log-poller/` |
| 🗺️ **Map snapshot** | Pulls WebMap's map and fog over SFTP, composites the fog-masked atlas and the per-in-game-day timelapse into Supabase Storage | `scripts/map-snapshot.mjs` |
| 🔌 **Custom mods** | Four BepInEx plugins: server-side Companion (oaths, pins, voice, positions, world keys) and Boards (in-game leaderboard signs), client-side Companion Client (cartography, real cause of death, tombstone keep-list) and EilifPaths | `plugins/` |
| 🩺 **Ops** | The `/admin/ops` cockpit plus an off-PC watchdog that runs on GitHub Actions, so an outage is noticed even when the PC that runs every producer is off | `app/admin/ops/`, `.github/workflows/` |

```
  GTX box (Valheim + BepInEx)                       players' PCs (the modpack)
   |            |            |                              |
   | SFTP log   | SFTP map   | Emitter POST                 | client POSTs
   v            v            v                              v
  log poller   map snapshot   +--------------------------------+
   |            |             |   Vercel: dashboard + API      |
   | /api/      | Supabase    |   /api/webhook  /api/gs-ingest |
   | webhook    | Storage     |   /api/voice    /api/boards    |
   +------------+------------>|   /api/status   /api/titles    |
                              |   /api/ops/*                   |
                              +--------------------------------+
                                           |
                                    Supabase Postgres
                                           |
                                    Discord bot  ->  #valheim / #server

  Back the other way: the Boards plugin polls /api/boards and paints in-game signs;
  the Companion polls /api/voice and speaks. Nothing reaches into the GTX box.
```

## Dashboard pages
- **Hall** (`/`) hero, server status, who is sailing, the Hearth pulse, boss progress
- **Vikings** (`/players`) roster, leaderboards, attendance grid, How We Die, anglers
- **Viking** (`/viking/[slug]`) one player: feats, deaths, oath, the catch log
- **World** (`/world`) boss timeline, Great Deeds ledger, scheduled gatherings
- **Boss** (`/boss/[slug]`) war room and full record for one boss
- **Saga** (`/events`) filterable event feed plus Episodes
- **Map** (`/map`) fog-masked atlas, in-game-day timelapse, pins, place albums
- **Gallery** (`/gallery`) screenshots ingested from Discord
- **Oath** (`/oath`) the oath wall
- **Mods** (`/mods`) installed mods (edit `config/mods.ts`)
- **Get Started** (`/get-started`) pack code, Mac config bundle, connect details
- **Ops** (`/admin/ops`) read-only cockpit, password gated, noindexed

## Configure (edit & redeploy)
- `config/server.ts` — server name, tagline, max players, address
- `config/mods.ts` — the mod list shown on the Mods page

## Run locally
> ⚠️ **Node 20+ required** (Next 16). Pinned via `.nvmrc`.
```bash
nvm use && npm install && npm run dev
```

## The services (run on the host, via systemd)
- `services/discord-bot/` — `npm start`; unit: `eilif-discord-bot.service`. Recaps gated until launch via `RECAPS_START`. Mark a boss: `node scripts/mark-boss.js "Bonemass" "Bjorn,Astrid"`.
- `services/log-poller/` — `npm start`; unit: `eilif-log-poller.service`. Parses `BepInEx/LogOutput.log` over SFTP. (The reference unit file in that directory still carries the old `valheim-` name; the unit that runs is the `eilif-` one.)
- root `scripts/map-snapshot.mjs` — `node scripts/map-snapshot.mjs --loop`; unit: `eilif-map-snapshot.service`. Pulls WebMap's map and fog over SFTP every 5 minutes.
- Two timers: `eilif-world-backup.timer` (00/06/12/18 local, read-only off-box world copy) and `eilif-db-snapshot.timer` (03:30 local, logical JSON snapshot of every table).
- Retired: `services/stats-parser/` / `eilif-stats-parser.service`, stood down 2026-08-23. `/api/webhook` still accepts `type:'stats'`, logs it as deprecated, and writes nothing.

## Data model (Supabase)
Twenty tables, public-read RLS, writes via the service role through the API routes; the Discord bot is the one producer holding a Supabase key directly. Two Storage buckets, `gallery` and `map`. Every table and its writer is listed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) section 5.

## Status
- ✅ Dashboard (11 public pages + the ops cockpit, dark Norse theme) · ✅ Discord bot, log poller and map snapshot all live under systemd · ✅ Off-PC watchdog on GitHub Actions
- Services pull over **SFTP** (host: GTXGaming) · the server world launches **Wednesday, September 9, 2026**, the day Valheim 1.0 ships

---
<p align="center"><em>Sailing the tenth world. May your axes stay sharp. 🛡️</em></p>

## Living Boards — the dashboard, on a plank

Write `[board:kills]` on any in-game sign and the server repaints it as a live top-5 leaderboard, refreshed within a minute of the stats moving. Also: `deaths`, `builds`, `resources`, `explored`, `distance`, `titles`, `deeds` — and `[board:kills:leader]` for a plaque naming just the champion. Write anything else on the sign to take it back. Powered by `app/api/boards` (token-authed feed rendering the same numbers the site shows) and `plugins/eilif-boards` (a server-only BepInEx plugin — players install nothing). Details in `plugins/eilif-boards/README.md`.
