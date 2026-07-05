# Remote players — opt-in stats upload (phase 2, design only)

> **SUPERSEDED for map exploration (2026-07-05).** The **Eilif Companion Client**
> BepInEx plugin (`plugins/eilif-companion-client`) now tracks each player's
> explored-map % **automatically** — the pinned pack ships the DLL, so playing =
> tracked, no opt-in and no script to run. It reads the local minimap fog in
> memory and POSTs `source:'client-map'` to `/api/gs-ingest` (which writes
> `player_stats.map_explored_pct` with GREATEST). Combat / death / boss stats
> already arrive via **GsValheimStatsClient** on the same pack.
>
> So for **pack players**, the `.fch`-uploader design below is **no longer
> needed** for the Cartographer board. Keep it only as a **fallback** for
> non-pack players (or if you ever want the *other* per-player counters —
> builds / resources / crafts — from a player who isn't running the client mods).
> The **local** systemd `.fch` parser still runs for Charlie's own characters.

## The problem

Valheim tracks kills / builds / distance / resources / **map exploration**
client-side, in each player's `.fch` character profile. That file lives on the
player's own machine, not the server (the server-side ServerCharacters mirror
was never deployed). This machine runs the parser against *Charlie's* local
profiles only — so the dashboard sees Charlie's stats, and no one else's.

To put every viking on the Cartographer / Master Builder boards, each player has
to hand us their `.fch`. This doc sketches the smallest viable way to do that.
**Nothing here is implemented yet.**

Note one consequence of the per-machine model: a stat sweep only reflects a
player's most recent *local save*. The `.fch` rewrites on autosave (~20 min
in-game) and on logout, so a player who plays the server from a laptop but runs
the uploader on a desktop will look stale. The uploader should run on the same
machine they play from.

## Recommended: a one-file uploader the player runs

Give each player a single script + a personal token. It finds their newest
server-world profile, POSTs the raw bytes to a new upload endpoint, and the
server parses it with the **exact same `src/fch.js`** the local pipeline uses
(one parser, one source of truth).

### Client (what the player runs)

- A tiny cross-platform script (Node single-file, or a `.sh`/`.ps1` pair).
  Distribute via the pinned mod-pack folder or a Discord pin.
- It auto-locates the Steam characters dir per-OS:
  - Linux (snap): `~/snap/steam/common/.local/share/Steam/userdata/<id>/892970/remote/characters`
  - Linux (native)/Proton: `~/.local/share/Steam/userdata/<id>/892970/remote/characters`
  - Windows: `%USERPROFILE%\AppData\LocalLow\IronGate\Valheim\characters`
  - macOS: `~/Library/Application Support/IronGate/Valheim/characters`
- It skips `_backup`/`.old` files, picks the profile the player names (or the
  one whose world list contains the server `WORLD_UID`), and uploads it.
- Runs on a timer (cron / Task Scheduler / launchd) or a "click after you play"
  one-shot. Cadence 10–15 min matches the local systemd sweep.

### Server (new, small)

- `POST /api/stats-upload` (multipart or raw body):
  - Auth via a **per-player token** (map token → `player_id`; a player can only
    write their own row). Do NOT reuse the shared `WEBHOOK_SECRET`.
  - Parse in-process with `parseProfile` / `toPlayerStats`, pinning the server
    `WORLD_UID`, then upsert `player_stats` exactly like the `stats` webhook
    branch. Reject if the profile doesn't contain the server world (prevents
    someone uploading a 100% singleplayer save).
  - Cap body size (a maxed profile is a few MB) and rate-limit per token.
- The `.fch` is transient — parse and discard; never store the raw profile.

Effort: ~1 endpoint + a ~60-line client + a token table. No game mod required.

## Alternatives considered

- **Shared-folder drop** (Syncthing / a synced Dropbox each player installs, all
  pointed at one `characters/` dir the systemd parser already reads). Zero new
  server code — but every player installs and configures a sync client, name
  collisions are possible, and it's fragile. Fine for 2–3 trusted players as a
  stopgap; the uploader scales better.
- **A client mod** that POSTs stats on logout (like the GsValheimStats emitter
  but client-side). Most seamless, but it's a real BepInEx plugin to build,
  sign, and add to the pinned pack — overkill for a handful of players and it
  duplicates the parser we already trust.

## Recommendation

Ship the **one-file uploader + `/api/stats-upload`**. It reuses `fch.js`, needs
no game mod, keeps each player writing only their own row, and works no matter
which machine a player games on. Do a shared-folder drop only if you need
something for the next play session tonight.
