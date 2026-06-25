# Eilif stats parser

Pulls the [ServerCharacters](https://valheim.thunderstore.io/package/Smoothbrain/ServerCharacters/)
`.fch` profiles the mod keeps server-side, parses the **full vanilla stat suite**,
and posts each player's stats to the dashboard webhook → `player_stats`.

This is the only way to get kills / builds / distance / resources / map
exploration: Valheim tracks all of it **client-side**, so none of it appears in
the server log (which the [log-poller](../log-poller) reads). ServerCharacters
mirrors each player's profile to the host, and we parse it here.

## What it produces

Per player → `player_stats`:

| Column | Source stat(s) |
|---|---|
| `kills` | `EnemyKills` |
| `deaths` | `Deaths` |
| `resources_harvested` | `Tree + Mines + BeesHarvested + SapHarvested` (composite) |
| `items_crafted` | `Crafts` |
| `distance_traveled` | `DistanceTraveled` (metres) |
| `structures_built` | `Builds` |
| `map_explored_pct` | % of the world disc uncovered (best world, or `WORLD_UID`) |

## How the `.fch` format works

See the header comment in [`src/fch.js`](src/fch.js) — it documents the full
byte layout. Key facts:

- The file is a Valheim `ZPackage`; stats are a flat `float[]` indexed by the
  `PlayerStatType` enum ordinal.
- **It is version-fragile.** The `dataVersion` and the enum can change with game
  updates (the 1.0 / Deep North patch is the known risk). The parser reads the
  stat count dynamically and **self-synchronizes** past the variable run of flag
  bytes before the world block, so a single added/removed field won't break it.
- The `PlayerStatType` ordering in `src/fch.js` was extracted straight from the
  live `assembly_valheim.dll`. After a Valheim update, refresh it:

  ```bash
  node scripts/extract-stat-enum.mjs   # prints a ready-to-paste STAT_TYPES array
  ```

## Run

```bash
cp .env.example .env   # fill in WEBHOOK_SECRET + FTP creds
npm install

npm run once           # single sweep, then exit (good for cron / manual)
npm start              # loop every POLL_INTERVAL_MS (systemd)
```

Test against a local folder of real profiles (e.g. your Steam characters dir):

```bash
STATS_TEST_DIR="$HOME/.../remote/characters" npm test
STATS_SOURCE=dir CHARACTERS_PATH="$HOME/.../remote/characters" \
  WEBHOOK_URL=... WEBHOOK_SECRET=... npm run once
```

## Deploy (systemd)

```bash
sudo cp eilif-stats-parser.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eilif-stats-parser
journalctl -u eilif-stats-parser -f
```

Like the recaps, this should only run **after the server launches** (and after
ServerCharacters is installed + the demo data is wiped).
