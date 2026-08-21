# Launch wipe — clearing the pilot data before 1.0 launch

`scripts/launch-wipe.mjs` clears the July-pilot test-world data out of prod
Supabase (project `syuwavxpmtdmxupxjzje`) so the dashboard starts clean on the
real launch world (~2026-09-09). Full detail and rationale are in the script's
header comment — this is the short "when / in what order" runbook.

## When to run it

**Launch week, after the fresh world exists but before real players are let
back on the dashboard's data path.** Not before — the pilot data stays useful
for testing until then. Not after the first real session has posted anything,
or you'd be wiping real launch data along with the pilot's.

## Order of operations (do NOT skip or reorder)

1. **Backups first.** Before this script ever runs with `--execute`:
   - GTX panel world backup of the pilot save.
   - A `worlds_local` pull of the pilot save to local disk.
   There is no undo once rows and storage objects are deleted — the wipe is
   real DELETEs against prod, not a soft-delete.

2. **Stop the producer services first**, in particular `eilif-stats-parser`.
   It re-upserts `player_stats` from the local `.fch` profiles roughly every
   15 minutes — wiping while it's running just gets repopulated with the same
   pilot-test junk on its next sweep. The script's pre-flight step checks this
   via `systemctl is-active` and **refuses `--execute` outright** while
   `eilif-stats-parser` is active. It also warns (but does not block) if
   `eilif-log-poller` or `eilif-map-snapshot` are still running — those should
   be stopped too, or already be pointed at the new world.

   ```bash
   sudo systemctl stop eilif-stats-parser eilif-log-poller eilif-map-snapshot eilif-discord-bot
   ```

3. **Preview first, always:**

   ```bash
   export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
   node scripts/launch-wipe.mjs
   ```

   This is the default mode (no flag needed) and only ever reads: it prints
   current row counts per table, object counts per storage bucket, and the
   local state file paths it would touch. Nothing is written.

4. **Run for real** once the preview output looks right:

   ```bash
   node scripts/launch-wipe.mjs --execute
   ```

   This still refuses to run if `eilif-stats-parser` is active, and additionally
   requires typing `WIPE` at a confirmation prompt before touching anything.

5. **Do the post-wipe checklist** the script prints at the end (GTX world
   config, `GS_EXPECTED_WORLD` in Vercel, `stats-parser` `WORLD_UID`/`CHARACTERS`,
   the `MAP_WORLD` env for `scripts/map-snapshot.mjs`, reverting the
   `RECAPS_START`/`RECAP_CHANNEL`/`MILESTONE_CHANNEL` pilot overrides) — none of
   that is automated, it's a manual checklist printed by the script itself so
   it can't be missed.

6. **Restart the services**, in this order: `eilif-log-poller` +
   `eilif-stats-parser` first, then `eilif-discord-bot`, then
   `eilif-map-snapshot` last (it needs the new world's WebMap folder to already
   exist on the host).

## What it wipes

- **Deletes all rows**: `players`, `sessions`, `events`, `chat_lines`, `oaths`,
  `pins`, `gallery_photos`, `player_stats`, `voice_lines`, `identity_claims`,
  `player_positions`, and `map_markers` if that table exists (it does not, as
  of this writing).
- **Resets state only** (definitions/rows stay): `milestones` — zeroes
  `achieved_at`/`achieved_value`/`announced_at`/`meta` on rows currently marked
  achieved; `bosses` — flips `is_killed` back to `false` and clears
  `killed_at`/`players_present`/`fight_stats`/`retelling`/`retelling_generated_at`
  on rows currently marked killed.
- **Storage**: every object in the `gallery` bucket and the `map` bucket (the
  map snapshotter's bucket — it is literally named `map`, not "map-frames";
  the script also picks up any other bucket whose id contains "map").
- **Local state files**: `services/log-poller/state.json`,
  `services/discord-bot/state.json` (announced bosses, voice/discovery dedupe,
  POTY recap streaks all live in this one file), and
  `scripts/.map-snapshot-state.json`. `services/stats-parser` has no local
  state file — it re-reads the `.fch` profiles fresh every sweep.

## What it deliberately does NOT touch

`server_status` (singleton row — refreshes itself from the new world),
`discord_events`, `roadmap`, and `ops_heartbeats`. These were out of scope for
this pass — flag to whoever owns launch-week ops if they also need clearing.
(`poty_history` IS wiped — its migration documents a pre-launch wipe.)
