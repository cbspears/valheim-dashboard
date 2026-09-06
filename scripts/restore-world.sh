#!/usr/bin/env bash
# Print the exact steps to roll the live world back to a restore point.
# This script CHANGES NOTHING: world uploads happen over SFTP inside a panel
# stopped window, by hand, because the game file-locks the world while running.
#
#   bash scripts/restore-world.sh <World>            # list the restore points
#   bash scripts/restore-world.sh <World> <stamp>    # print the restore steps for one
#
# Restore points come from two places:
#   1. THIS PC: ~/valheim-world-backups/<World>-<YYYYMMDD-HHMM>/ (eilif-world-backup.timer,
#      hourly since 2026-09-06, newest 168 kept = 7 days).
#   2. THE BOX: worlds_local/<World>_backup_auto-<stamp>.db/.fwl, written by the game itself
#      (roughly every two hours while the server runs). Those are already on the box:
#      restoring one is a rename in the same stopped window.
set -euo pipefail
WORLD=${1:-}; STAMP=${2:-}
DEST=${DEST:-$HOME/valheim-world-backups}
if [ -z "$WORLD" ]; then echo "usage: $0 <World> [<stamp>]"; exit 2; fi
if [ -z "$STAMP" ]; then
  echo "Restore points for $WORLD on this PC (newest last):"
  ls -1d "$DEST/${WORLD}-"*/ 2>/dev/null | sed -E "s#.*/${WORLD}-([0-9-]+)/#  \1#" || echo "  (none)"
  echo; echo "Pick one and re-run: $0 $WORLD <stamp>"; exit 0
fi
SRC="$DEST/${WORLD}-${STAMP}"
[ -f "$SRC/$WORLD.db" ] && [ -f "$SRC/$WORLD.fwl" ] || { echo "no $WORLD.db + $WORLD.fwl under $SRC"; exit 3; }
SZ=$(stat -c %s "$SRC/$WORLD.db")
cat <<STEPS
Roll $WORLD back to $STAMP  (db $SZ bytes, from $SRC)

  1. GTX panel: STOP the server. Wait until the console shows it exited (the world is
     file-locked while it runs; an upload against a running server fails or corrupts).
  2. Optional safety copy of what is live right now, from this PC:
       bash scripts/pull-world.sh $WORLD
  3. Upload the restore point over SFTP (host 191.101.30.229 port 8822, user charless3),
     into the nest's worlds_local/ directory, overwriting the live pair:
       sftp -P 8822 charless3@191.101.30.229
       cd 191.101.30.229_6028/worlds_local
       put "$SRC/$WORLD.db"  $WORLD.db
       put "$SRC/$WORLD.fwl" $WORLD.fwl
       ls -l $WORLD.*
     The listed size of $WORLD.db must read $SZ.
  4. GTX panel: START (Stop then Start, never Restart). Then from this PC:
       bash scripts/verify-restart.sh $WORLD
  5. Tell the crew what was rolled back and to what time; anything built after $STAMP is gone,
     and a player who was online keeps their own character (characters live on their PCs).

Rollback of the rollback: step 2's copy, restored the same way.
STEPS
