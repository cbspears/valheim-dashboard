# Eilif — Project Doc (requirements, decisions, architecture, to-dos)

Living doc for the Eilif Valheim server dashboard + integrations. Updated 2026-06-24.
See [README](../README.md) for the quick overview.

---

## 1. Requirements (what this is for)

A community hub for the **Eilif** modded Valheim super-server ("The Cozy Canon Playthrough"), launching ~Sept 2026, ~15–20 players. Must provide:

- **Players** — who's online now (real-time) + who's played (historical sessions, last seen, hours).
- **Leaderboards** — kills, deaths, playtime, resources gathered, items crafted, distance, exploration, building pieces.
- **World progress** — boss-gated progression timeline + a living, editable roadmap/schedule.
- **Mods** — the installed mod list.
- **Discord integration** — relay in-game events (joins/leaves/deaths/raids) to Discord; announce major events (first boss kills) with `@everyone`; post daily stat recaps; (chat relay desired, deferred).
- **Public** on Vercel; **dark Norse fantasy** aesthetic; **evolving** (frequent tweaks expected).

## 2. Architecture

```
Valheim server (GTXGaming) ─SFTP─> log poller ───┐
ServerCharacters .fch ─────SFTP─> stats parser ──┼──> /api/webhook ──> Supabase ──┬──> Dashboard (Vercel)
                                                  │                               └──> Discord bot ──> #valheim / #server
(manual)  mark-boss script ───────────────────────┘
```

- **Dashboard** (`app/`) — Next.js 16 · React 19 · Tailwind v4 · TS · Supabase. 5 pages (Hall/Vikings/World/Saga/Mods). Banner hero + derived blue-slate background + gold-"E" favicon + OG image. → Vercel.
- **Supabase** — `players, sessions, events, player_stats, bosses, roadmap, server_status, discord_events, gallery_photos` (+ a public `gallery` Storage bucket). Public-read RLS; writes go through `/api/webhook` (service-role + `x-webhook-secret`). `occurredAt` + `sync` + `events_sync` supported.
- **Discord bot** (`services/discord-bot/`) — discord.js v14, systemd `eilif-discord-bot` (live, auto-boot). Relays joins/leaves/deaths/raids → `#server`; first boss kills `@everyone` → `#valheim`; **8 AM & 10 PM Central recaps** (deaths leaderboard + Player-of-the-Day) → `#valheim`. Recaps gated by `RECAPS_START`. Scripts: `mark-boss.js`, `announce.js`, `preview.js`.
- **Log poller** (`services/log-poller/`) — Node + ssh2-sftp-client, systemd `valheim-log-poller` (built, not yet running). Tails `BepInEx/LogOutput.log` over SFTP → derives presence/sessions/deaths/raids → `/api/webhook`. Parser unit-tested.
- **Stats parser** (`services/stats-parser/`) — Node + ssh2-sftp-client. `ServerCharacters` stores each player's full vanilla `.fch` profile server-side → SFTP-pull → parse the `ZPackage` stat array + map-exploration fog → POST `{type:'stats'}` to `/api/webhook` → `player_stats`. Built + validated against 30 real profiles (v37/39/43). The `PlayerStatType` ordinal map is extracted from the live `assembly_valheim.dll` (`scripts/extract-stat-enum.mjs`); the parser reads the stat count dynamically and self-synchronizes past version-variable flag bytes, so a game patch degrades gracefully rather than corrupting data. Runs post-launch under systemd (`eilif-stats-parser`).

**Runtime:** Node 20 via nvm (`~/.config/nvm`; system node is 18). Pinned via `.nvmrc`.

## 3. Decisions log

| Decision | Choice | Why |
|---|---|---|
| Server file access | **SFTP** (port 8822) | Provider moved to **GTXGaming** (was G-Portal/plain-FTP); GTX exposes SFTP only |
| Boss-kill tracking | **Manual** (`mark-boss.js`) | No log signal; auto-detect plugin deferred |
| In-game chat relay | **Deferred** | Needs a client-side mod on every player |
| `@everyone` | Manual announcements + **first** kill of each boss only | Keep pings rare/meaningful |
| Slash commands | **None** | Simpler; `mark-boss` script instead |
| Stats source | **Full suite via ServerCharacters** | Only way to get kills/resources/builds/exploration (all client-tracked in vanilla) |
| Recap times | **8 AM + 10 PM Central** | Morning recap + evening with Player-of-the-Day |
| Deploy | Vercel; **auto-deploy via GitHub** (pending connect) | CLI deploys hit a Hobby rate-limit/penalty |
| Channels | **#valheim** (announcements) + **#server** (activity) | (supersedes the older #valheim-updates/#valheim-chat plan) |

## 4. Status

- ✅ Dashboard built + **LIVE** at https://valheim-dashboard.vercel.app (the long deploy block was a git-author access check, not a rate-limit — fixed; deploys require commit author `charlie@blockspace.media`).
- ✅ Discord bot **live** (systemd, auto-boot); recaps gated until launch.
- ✅ Log poller built + parser-tested — not running (waits for server launch).
- ✅ Stats parser built + validated (ServerCharacters `.fch` → parser → `player_stats`); `structures_built` + `map_explored_pct` columns + Master Builder / Cartographer cards. Run `db/2026-06-24_player_stats_extra_columns.sql` before it goes live; service runs post-launch.
- 🌱 Demo data seeded so the dashboard looks alive — **WIPE before go-live.**

## 5. To-dos / ongoing

1. **[HIGH] Unblock the deploy** — connect GitHub → Vercel (Account Settings → Connections → GitHub; then Project → Settings → Git). Auto-deploy on push; bypasses the CLI penalty. Brings Eilif + all visuals live.
2. ✅ **Stats parser** — DONE. SFTP-pull `*.fch` → parse the stat array (dynamic field count, live build = v43) → map to `player_stats` (keyed on character name; SteamID backfilled from the filename when present). Added **`structures_built`** + **`map_explored_pct`** columns + Master Builder / Cartographer cards.
3. **Install `ServerCharacters`** on server + all clients; **test the ValheimPlus conflict** (Benson's domain). Distribute via r2modman profile.
4. **Validate the parser** against one real `.fch`.
5. **At launch:** wipe demo data, bring the log poller online (systemd), confirm recaps un-gate.
6. **Boss portraits** — generate the 8 boss illustrations; wire into the World timeline.
7. **Set `RECAPS_START`** to the ACTUAL launch date (may differ from Sept 9 — see risks).
8. *(later)* boss-kill auto-detection plugin; in-game chat relay (client plugin).

## 6. Risks & open questions

- ⚠️ **Sept 9, 2026 = Valheim 1.0 / Deep North.** A 1.0 patch **breaks every BepInEx mod** until recompiled, and **likely bumps the character-profile version** (the `.fch` parser targets v42). → Launch may pin to `0.221.x` or **slip to late September**. The parser must read the field count **dynamically**, the modlist must be re-validated, and `RECAPS_START` must track the real launch date. (Cross-ref the Obsidian Mod-Tracker / Config-and-Mods notes.)
- The `.fch` parser is **version-fragile** — re-verify ordinals against the live build.
- `ServerCharacters` adds **per-player client install** friction (mitigated: players already install ValheimPlus) and has documented V+ conflicts.
- Mods make the server **Steam-PC only** (no crossplay/console).

## 7. Where things live (not secrets)

- Code: `~/Projects/valheim-dashboard` · GitHub `cbspears/valheim-dashboard` (private).
- Secrets: `.env.local` (dashboard) + `services/*/.env` (gitignored). Supabase project `syuwavxpmtdmxupxjzje`. Vercel team `charlie-9292s-projects`.
- Obsidian project: `30-Personal/projects/Valheim-SuperServer/`.
