# World backups and rollback

Two independent sets of restore points exist for the live world.

| Where | Cadence | Retention | Made by |
|---|---|---|---|
| This PC, `~/valheim-world-backups/<World>-<stamp>/` | hourly (top of the hour, up to 2 min jitter) | newest 168 per world, about 7 days | `eilif-world-backup.timer` running `scripts/pull-world.sh <World>` over SFTP |
| The box, `worlds_local/<World>_backup_auto-<stamp>.db` and `.fwl` | roughly every two hours while the server runs | the game's own rolling set | the Valheim dedicated server itself |
| This PC, nightly Supabase snapshot (all tables to JSON) | 03:30 CT | see `scripts/db-snapshot.mjs` | `eilif-db-snapshot.timer` |

Until 2026-09-06 the PC pull ran four times a day. It was made hourly with a unit drop-in
(`/etc/systemd/system/eilif-world-backup.timer.d/hourly.conf`) and the retention raised to 168
(`.../eilif-world-backup.service.d/retention.conf`), so a rollback of one hour or one day is
always available from this PC. The pilot world weighs about 4.4 MB per pull; a mature world is
tens of megabytes, so a week of hourly copies stays under a few gigabytes.

**The world the timer pulls is an argument on the unit's ExecStart.** It says `EilifRehearsal`
today; the cutover script prints the one-line edit that points it at `Eilif`, and the launch
preflight warns until that is done (LAUNCH-DAY step 20b).

## Rolling back

`bash scripts/restore-world.sh <World>` lists the restore points on this PC;
`bash scripts/restore-world.sh <World> <stamp>` prints the exact steps. The upload itself is by
hand inside a panel stopped window, because the game file-locks the world while it runs. A
`backup_auto` pair already on the box can be restored by renaming it over the live pair in the
same window, no upload needed.

The dashboard's database is separate from the world: rolling the world back does not roll the
site back (deaths, deeds and tellings recorded after the restore point stay recorded). If both
must move together, the nightly Supabase snapshot is the matching restore point for the site.
