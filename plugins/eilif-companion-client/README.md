# Eilif Companion Client

A deliberately tiny, **client-side** BepInEx 5 plugin for the Eilif Valheim server
(BepInEx 5.4.2333 + ValheimPlus). The client twin of [`../eilif-companion`](../eilif-companion):
same toolchain, same repo conventions, no gameplay changes — purely additive.

**Two jobs, both purely observational.**

1. **Automatic cartography.** While you're connected to a multiplayer server it periodically reads
   your local minimap fog, computes your explored-map percentage, and POSTs it to the dashboard.
   The pack ships this DLL, so **playing = tracked** — no opt-in, no scripts, no `.fch` upload. This
   supersedes the `.fch`-uploader plan (`services/stats-parser/REMOTE.md`) for pack players.
2. **The real cause of your death** (v0.2.0, see [Death reporter](#death-reporter-v020)). The
   third-party GsValheimStatsClient reports every unattributed damage-over-time death — a campfire
   you stood in, the cold, drowning — as the flat catch-all `enemyhit`, because the real cause is
   destroyed at its source. This plugin reads the killing `HitData` out of the game and reports the
   exact cause instead.

`BepInPlugin` GUID: `net.eilif.companionclient` — name `Eilif Companion Client` — v`0.2.0`.

---

## How it works

Valheim tracks map exploration **client-side**: `Minimap.instance.m_explored`, a private
`bool[m_textureSize * m_textureSize]` (verified against a decompile of `assembly_valheim` — see
[Minimap mechanics](#minimap-mechanics-verified-from-the-decompile)). Nothing about it reaches the
dedicated server, which is why the server-side emitter can't see it.

Every `IntervalSeconds` (default **300 s**) — **and once on logout/disconnect** — the plugin, on the
Unity main thread:

1. Confirms it is a **client connected to a remote server** (`ZNet.instance != null &&
   !IsServer() && GetServerPeer() != null`, plus a live `Minimap.instance` + `Player.m_localPlayer`).
   At the main menu, in singleplayer, or while hosting → **silent no-op**.
2. Reads `m_explored` + `m_textureSize` via cached reflection and computes the explored %
   **exactly like the `.fch` stats-parser** (`services/stats-parser/src/fch.js` `exploredPercent`):
   explored cells **inside the inscribed disc** (radius = `size/2`) ÷ disc cells — the map square's
   corners are endless ocean, so a fully-explored world reads ~100 %, never >100 %.
3. Fires a fire-and-forget HTTPS POST (off the main thread) of a tiny JSON:

   ```json
   { "schemaVersion": 1, "game": "valheim", "source": "client-map",
     "playerName": "<char>", "world": "<world>", "exploredPct": 0.87 }
   ```

   to the ingest (default the prod `…/api/gs-ingest`). Success logs
   `[EilifMap] posted 0.87% for <Char> (<World>) [interval]`.

**Timing detail.** Compute is cheap (a single pass over the 256² fog array) and runs on the main
thread; all HTTP is off-thread via `Task.Run`, one request in flight at a time (`Interlocked`
guard). Any network / reflection hiccup is caught and logged at Warning — it never disturbs
gameplay. On a clean quit-to-menu a Harmony prefix on `Game.Logout` sends a **fresh** final
reading (Minimap still alive); a hard disconnect (network drop / kick) that skips `Logout` posts
the **last computed** value instead (exploration only grows + the ingest uses GREATEST, so a
slightly stale final post is harmless).

### Minimap mechanics (verified from the decompile)

From `ilspycmd -t Minimap assembly_valheim.dll` (game build shipped 2026-02, the live pilot build):

- `public static Minimap instance => m_instance;` — the singleton.
- `private bool[] m_explored;` — **your own** fog. Allocated `new bool[m_textureSize * m_textureSize]`.
  (`m_exploredOthers` is the shared/other-players layer — we deliberately read only `m_explored`,
  matching the `.fch` parser's "own" layer.)
- `public int m_textureSize = 256;` — so the array is 65 536 cells.
- Row-major indexing confirmed by `Explore(int x, int y)`: `m_explored[y * m_textureSize + x]`.
- The world is the **disc inscribed** in the square (`m_pixelSize = 64`, half-size = 128 px ≈ the
  world radius); the corners are ocean. Hence the disc-only denominator — identical to the parser.

Both fields are private → read via HarmonyX `AccessTools.Field` (cached `FieldInfo`).

---

## Death reporter (v0.2.0)

Valheim keeps the killing blow in `Character.m_lastHit` (a `HitData`) and `Player.OnDeath` reads
`m_lastHit.m_hitType` from it **unguarded** — so at that exact moment the true cause is still
available, and it is the only moment it is. A Harmony **postfix** on `Player.OnDeath` (local player
only) reads it and fires a fire-and-forget POST:

```json
{ "schemaVersion": 1, "game": "valheim", "source": "eilif-death",
  "world": "<world>", "player": "<char>", "tsUtc": "2026-08-23T12:00:00.000Z",
  "hitType": "Burning", "attacker": null, "biome": "Meadows",
  "pos": { "x": 12.4, "z": -7.8 } }
```

- **`hitType`** is the `HitData.HitType` enum name **verbatim** — one of the 22 values
  (`Undefined`, `EnemyHit`, `PlayerHit`, `Fall`, `Drowning`, `Burning`, `Freezing`, `Poisoned`,
  `Water`, `Smoke`, `EdgeOfWorld`, `Impact`, `Cart`, `Tree`, `Self`, `Structural`, `Turret`, `Boat`,
  `Stalagtite`, `Catapult`, `CinderFire`, `AshlandsOcean`). The server holds the same list in
  `lib/deaths.ts` and maps every one to a rendered phrase.
- **`attacker`** is `null` for an environmental death. For a creature it is the **raw**
  `Character.m_name`, which is a localization token like `$enemy_serpent` — the server humanizes it
  via `config/creatures.ts` so there is exactly one naming table, not two. For a player killer it is
  their character name.
- The server (`/api/gs-ingest` → `lib/deaths.ts`) collapses this with the GsValheimStatsClient and
  log-poller reports of the same death within ±3 minutes, **in either arrival order**, so a death is
  never counted twice and the surviving row always carries this plugin's cause.

Nothing here touches gameplay: everything is wrapped, the POST is off-thread, and any failure ends
in a Warning line and nothing else. No stats are written — only the death `events` row.

## Config (`BepInEx/config/net.eilif.companionclient.cfg`, section `[Map]`)

| Key | Default | Notes |
| --- | --- | --- |
| `Url` | `https://valheim-dashboard.vercel.app/api/gs-ingest` | ingest endpoint (`source:'client-map'`) |
| `Token` | `` (empty) | optional; when set, sent as `Authorization: Bearer <token>`. Empty is fine (pilot) |
| `IntervalSeconds` | `300` | seconds between posts while on a server; clamped `60..3600` |

The defaults already point at prod, so a fresh install works with **zero** config edits.

---

## Build

Needs the user-local .NET SDK (`~/.dotnet`, on PATH) and `libs/` populated.

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
./refresh-libs.sh          # (re)copy game DLLs + fetch BepInEx refs into libs/
dotnet build -c Release    # outputs plugins/eilif-companion-client/dist/EilifCompanionClient.dll
```

`dist/EilifCompanionClient.dll` is the committed, deployable artifact.

## Install / distribute

- **In the pinned pack** (how players get it): see [`PACK.md`](PACK.md) — import the local DLL into
  the r2modman profile and pre-fill the config, then re-export the pack code.
- **Manual (one machine):** drop `dist/EilifCompanionClient.dll` into
  `<Valheim>/BepInEx/plugins/`. Config is generated on first launch (already prod-pointed).

## Verify (from the client `LogOutput.log`)

1. On join a server, wait `IntervalSeconds` (or log out) and look for:
   `[EilifMap] posted 0.87% for <Char> (Dedicated) [interval]` (or `[logout]`).
2. The dashboard's Cartographer board / `player_stats.map_explored_pct` for that character updates.
3. At the menu / in singleplayer there should be **no** `[EilifMap] posted` lines.
4. On boot: `[EilifDeath] death-cause reporter armed …`. Then die on the server (a campfire is the
   quickest honest test) and look for
   `[EilifDeath] <Char> died in <World>: hitType=Burning, attacker=(none), biome=Meadows`
   followed by `[EilifDeath] reported Burning for <Char>`. The Saga / How We Die should read
   "lost to the flames", **not** "struck down by an unseen foe".

## After the Valheim 1.0 / Deep North update

Re-run `./refresh-libs.sh` then `dotnet build -c Release`. If Iron Gate renamed `m_explored` /
`m_textureSize` or changed the fog layout, re-verify against a fresh `Minimap` decompile (the two
`AccessTools.Field` lookups fail-soft: a rename just makes the plugin a silent no-op, never a crash).

The death reporter needs the same re-verification against a fresh decompile of `Character`
(`m_lastHit`), `Player` (`OnDeath`) and `HitData` (`m_hitType`, `GetAttacker()`, and the `HitType`
enum's member list). `m_lastHit` is looked up via `AccessTools.Field` and so fails soft the same way;
**a NEW HitType value would not** — it would arrive as a word the server rejects, which is the
fail-safe (the death still lands via GsValheimStatsClient) but means a lost cause until the value is
added to `lib/deaths.ts` `HIT_TYPES` and given a phrase in `lib/episodes.ts`.
`scripts/eilif-death.test.mjs` is what enforces that pairing.
