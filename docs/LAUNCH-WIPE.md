# Launch wipe — clearing the pilot data before 1.0 launch

`scripts/launch-wipe.mjs` clears the pilot/rehearsal test-world data out of prod
Supabase (project `syuwavxpmtdmxupxjzje`) so the dashboard starts clean on the
real launch world (2026-09-09). Full detail and rationale are in the script's
header comment — this is the short "when / in what order" runbook.

Last refreshed **2026-09-04** from the T−6 launch audit (findings launch-8,
discord-1, launch-16, launch-17, gtx-7, mods-6). The cutover step table with
owners lives in the audit report; this file is the wipe's own procedure.

## When to run it

**Launch day, after the fresh world exists but before real players are let back
on the dashboard's data path.** Not before — the rehearsal data stays useful for
testing until then. Not after the first real session has posted anything, or
you'd be wiping real launch data along with the pilot's.

## Order of operations (do NOT skip or reorder)

1. **Stop `eilif-discord-bot` FIRST.** This is not a formality. The bot's voice
   tick ends in an unconditional `saveState()` every 60 seconds, so a running
   bot re-creates `services/discord-bot/state.json` — including the same
   `announcedBosses` ids — within a minute of the wipe deleting it. The wipe
   flips `bosses.is_killed` back to `false` but keeps the row **ids**, so a
   resurrected state file makes the bot treat launch night's real Eikthyr kill
   as already announced: no `@everyone`, no skald retelling, `freshKills` empty.

   ```bash
   sudo systemctl stop eilif-discord-bot eilif-log-poller eilif-map-snapshot
   ```

   The script's pre-flight checks these via `systemctl is-active`. It **refuses
   `--execute` outright** while `eilif-discord-bot` **or** `eilif-stats-parser`
   is active (both are hard gates), and warns without blocking on
   `eilif-log-poller` / `eilif-map-snapshot`.

   > `eilif-stats-parser` was **retired 2026-08-23** — it should report
   > `inactive`/`unknown`. The gate stays deliberately: a retired unit that
   > someone re-enables is exactly the surprise this script exists to prevent.

2. **Backups, and they are the only copies.** Before `--execute` ever runs:

   ```bash
   bash scripts/pull-world.sh <World>     # off-box .db/.fwl pair, keeps the last 14
   ```

   plus a full Supabase dump — the project is on the Free plan with **no
   backups at all**. The GTX panel only writes a `Backups/*.7z` at a Stop/Start,
   and the in-game `*_backup_auto-*` files live on the same disk as the world.
   There is no undo once rows and storage objects are deleted; the wipe is real
   DELETEs against prod, not a soft-delete.

3. **Preview first, always:**

   ```bash
   export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
   node scripts/launch-wipe.mjs
   ```

   This is the default mode (no flag needed) and only ever reads: current row
   counts per table, object counts per storage bucket, and the local state files
   it would touch. Nothing is written. Paste the output into the tracker.

4. **Run for real** once the preview output looks right:

   ```bash
   node scripts/launch-wipe.mjs --execute
   ```

   Still refuses while a hard-gate unit is active, and additionally requires
   typing `WIPE` at a confirmation prompt before touching anything.

5. **Sweep the box while it is STOPPED** (loaded plugin DLLs are file-locked on
   the Windows host, so this is also the only DLL-swap window). Valheim
   **auto-restores from leftover `.old` / `*_backup_auto-*` files and resurrects
   the old world** — the runbook gotcha that makes this step mandatory, not
   cosmetic. Delete, in `worlds_local/`:

   - `Dedicated.db`, `Dedicated.db.old`, `Dedicated.fwl`, `Dedicated.fwl.old`
     (the retired test world — an off-box copy already exists at
     `~/valheim-world-backups/Dedicated-final-20260823/`)
   - `*.old` for **every** world
   - `*_backup_auto-*` for **every** world (both the `.db` and the `.fwl`)
   - `<old world>.json` — plaintext world metadata that contains the **seed**
     (`{"seedName":"…","seed":-1214706268,…}`). The launch world's `.json` must
     never leave the box either.

   and elsewhere on the host:

   - `BepInEx/plugins/WebMap/map_data/<old world>/`
   - `vplus-data/<old world>_mapSync.dat`

6. **Do the post-wipe checklist** the script prints at the end (world upload +
   `Start.bat World=`, panel death penalty = **Casual**, Combat per the launch
   decision, leave V+ `[Chat]` ENABLED (it is what makes /s shouts server-wide; the Companion 0.3.1 chat/oath hook no longer depends on it), Emitter/Companion cfgs off the old
   world, `GS_EXPECTED_WORLD` in Vercel, `MAP_REMOTE_DIR` in the poller `.env`,
   and the bot `.env` pilot overrides `RECAPS_START` / `RECAP_CHANNEL` /
   `MILESTONE_CHANNEL` / any `*_CHANNEL=server`). None of it is automated — it
   is printed by the script itself so it can't be missed.

7. **Restart the services in this order:**

   1. `eilif-log-poller` — confirm a join line in its journal.
   2. `eilif-discord-bot` — **only after** `select name, is_killed from bosses`
      is all `false` **and** `services/discord-bot/state.json` is absent. Read
      its startup log: no announced boss, correct `RECAPS_START`, no channel
      overrides. Manual boss marking, if ever needed, is
      `cd services/discord-bot && node scripts/mark-boss.js "<Boss>"` — that file
      lives under `services/discord-bot/scripts/`, **not** repo-root `scripts/`.
   3. `eilif-map-snapshot` **LAST**, and only after `map_data/<World>/` exists on
      the host, `MAP_REMOTE_DIR` points at it, and `/api/status` reports the new
      world's day. Then watch for `day 1 framed` within 5 minutes.

   `eilif-stats-parser` is **not** in this list — retired 2026-08-23.

8. **Verify:** `bash scripts/verify-restart.sh <World>` (version unchanged, all
   8 plugins, panel tier Casual, `[EILIF_KEY]`, ingest 200, port 3000 closed),
   then the `/admin/ops` cockpit.

## What it wipes

- **Deletes all rows**: `title_history`, `players`, `sessions`, `events`,
  `chat_lines`, `oaths`, `pins`, `gallery_photos`, `player_stats`, `voice_lines`,
  `poty_history`, `identity_claims`, `player_positions`, and `map_markers` if
  that table exists (it does not, as of this writing).
  `title_history` (the Crowning Log) is deleted **first and explicitly** — its
  `player_id` FK cascades from `players`, but 10 pilot rows were still live in
  prod on 2026-09-03, so it is no longer left to the cascade.
- **Resets state only** (definitions/rows stay):
  - `milestones` — zeroes `achieved_at` / `achieved_value` / `announced_at` /
    `meta` on rows currently marked achieved.
  - `bosses` — flips `is_killed` back to `false` and clears `killed_at` /
    `players_present` / `fight_stats` / `retelling` / `retelling_generated_at`.
  - `server_status` (the singleton `id = 1`) — `world_day` → `0`,
    `player_count` → `0`, `current_players` → `[]`, `is_online` → `false`.
    **This is new (2026-09-04).** It used to be left alone as "it refreshes
    itself", which was wrong and is provable: `scripts/map-snapshot.mjs` reads
    the in-game day from `/api/status`, i.e. from this row, so after the
    2026-08-23 rehearsal wipe it framed `frames-by-day/day-0064.webp` — the OLD
    world's day 64 — four minutes after the wipe, and the public timelapse
    manifest still ends on that pre-wipe frame. Zeroing `world_day` makes
    `currentWorldDay()` return `null` (it guards on `worldDay > 0`), so nothing
    can be framed until the Emitter reports the new world's day.
- **Storage**: every object in the `gallery` bucket and the `map` bucket (the map
  snapshotter's bucket — it is literally named `map`, not "map-frames"; the
  script also picks up any other bucket whose id contains "map").
- **Local state files**: `services/log-poller/state.json`,
  `services/discord-bot/state.json` (announced bosses, voice/discovery dedupe,
  POTY recap streaks all live in this one file), and
  `scripts/.map-snapshot-state.json`. `services/stats-parser` had no local state
  file and is retired regardless.

## What it deliberately does NOT touch

`discord_events` and `ops_heartbeats` (`roadmap` IS wiped since 2026-09-05: the table is orphaned and was added to DELETE_TABLES). Flag to whoever owns
launch-week ops if they also need clearing. (`poty_history` **is** wiped — its
migration documents a pre-launch wipe. `server_status` **is** reset now, see
above.)

## If 1.0 ships the chunked save format

PTB 0.221.13 (2026-05-06) replaced the `<World>.db` + `<World>.fwl` pair with a
**folder** per world (`worlds_local/<World>/`, only changed chunks written).
Whether that lands in 1.0 is unconfirmed. Both `scripts/pull-world.sh` and
`scripts/verify-restart.sh` probe for either layout, and the sweep list in step 5
applies to the folder form too (`worlds_local/<old world>/` instead of the flat
pair). Take the pre-1.0 world **and** a full server-directory backup before any
1.0 boot — saves are forward-only.
