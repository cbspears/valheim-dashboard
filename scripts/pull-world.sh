#!/usr/bin/env bash
# Eilif ops: pull an OFF-BOX copy of the live world. READ-ONLY over SFTP (get + ls only —
# this script never uploads, renames or deletes anything on the GTX box).
#
#   bash scripts/pull-world.sh                       # defaults to the rehearsal world
#   bash scripts/pull-world.sh MyLaunchWorld         # after cutover
#   WITH_AUTO=1 bash scripts/pull-world.sh <W>       # also grab the newest *_backup_auto-* pair
#                                                    #   (costs a SECOND sftp session — see below)
#   DEST=/some/dir bash scripts/pull-world.sh <W>    # override ~/valheim-world-backups
#
# Why this exists (audit gtx-3 / launch-14, 2026-09-03): the GTX panel only writes a Backups/*.7z
# at a Stop/Start, not on a schedule, and the in-game autobackup writes *_backup_auto-* into
# worlds_local on the SAME DISK. Before this script the only off-box world copy in existence was
# ~/valheim-world-backups/Dedicated-final-20260823 (the retired test world). Saves are forward-only
# — a world that has booted on a newer Valheim build cannot be opened by the old one — so the copy
# taken BEFORE a 1.0 boot is the only rollback that exists.
#
# Layout: 0.221.x = worlds_local/<W>.db + <W>.fwl. PTB 0.221.13 reworked saves into a FOLDER per
# world (worlds_local/<W>/, chunked) which may ship in 1.0 (audit mods-6). The single sftp batch
# below asks for BOTH forms; whichever does not exist fails harmlessly inside the batch.
#
# NOT copied on purpose: <W>.json — it is plaintext world metadata that contains the SEED
# (`{"seedName":"...","seed":-1214706268,...}`). The launch world's seed is secret; keep it off
# this PC and out of any copy that leaves the box (audit gtx-7).
#
# Retention: the newest KEEP (default 14) timestamped directories per world are kept; older ones
# are deleted from THIS PC only.
#
# Needs: sshpass, sftp. Same creds/pattern as scripts/verify-restart.sh (password read from
# services/log-poller/.env, never echoed).
set -u
WORLD=${1:-EilifRehearsal}
KEEP=${KEEP:-14}
DEST=${DEST:-$HOME/valheim-world-backups}
ENV=~/Projects/valheim-dashboard/services/log-poller/.env
export SSHPASS="$(sed -n 's/^SFTP_PASSWORD=//p' "$ENV" | sed 's/^["'"'"']//; s/["'"'"']$//')"
HOST=191.101.30.229
N=${HOST}_6028
STAMP=$(date +%Y%m%d-%H%M)
DIR="$DEST/${WORLD}-${STAMP}"
mkdir -p "$DIR"

echo "== pull-world: $WORLD -> $DIR =="

# ── one sftp session: both world layouts + a listing manifest ────────────────
sshpass -e sftp -q -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -P 8822 charless3@$HOST \
  > "$DIR/worlds_local-listing.txt" 2>&1 <<EOF || true
get $N/worlds_local/$WORLD.db $DIR/$WORLD.db
get $N/worlds_local/$WORLD.fwl $DIR/$WORLD.fwl
get -r $N/worlds_local/$WORLD $DIR/$WORLD
ls -la $N/worlds_local/
EOF

# Empty artefacts happen when the other layout's `get` failed — drop them so the directory only
# ever contains real files.
for f in "$DIR/$WORLD.db" "$DIR/$WORLD.fwl"; do [ -f "$f" ] && [ ! -s "$f" ] && rm -f "$f"; done
[ -d "$DIR/$WORLD" ] && [ -z "$(ls -A "$DIR/$WORLD" 2>/dev/null)" ] && rmdir "$DIR/$WORLD"

if [ -s "$DIR/$WORLD.fwl" ]; then
  echo "  flat layout: got $WORLD.db + $WORLD.fwl"
elif [ -d "$DIR/$WORLD" ]; then
  echo "  folder layout: got worlds_local/$WORLD/ (chunked saves)"
else
  echo "  ⚠️  NOTHING was fetched for world '$WORLD'. Wrong name, or the box moved."
  echo "     worlds_local listing:"; sed 's/^/       /' "$DIR/worlds_local-listing.txt" | head -20
  exit 1
fi

# ── optional: the newest in-game autobackup pair (SECOND sftp session) ───────
# Off by default: the pair is another ~4.4 MB per pull and lives on the same disk as the live
# world anyway, so it only adds value as a "the live save just got corrupted" fallback.
if [ "${WITH_AUTO:-0}" = "1" ]; then
  AUTO=$(grep -oE "${WORLD}_backup_auto-[0-9]+" "$DIR/worlds_local-listing.txt" | sort -u | tail -1)
  if [ -n "$AUTO" ]; then
    echo "  + newest autobackup: $AUTO"
    sshpass -e sftp -q -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -P 8822 charless3@$HOST \
      >> "$DIR/worlds_local-listing.txt" 2>&1 <<EOF || true
get $N/worlds_local/$AUTO.db $DIR/$AUTO.db
get $N/worlds_local/$AUTO.fwl $DIR/$AUTO.fwl
EOF
  else
    echo "  (no ${WORLD}_backup_auto-* found in the listing)"
  fi
fi

echo "== contents =="
ls -la "$DIR" | sed 's/^/  /'
echo "  total: $(du -sh "$DIR" | cut -f1)"

# ── retention: keep the newest $KEEP directories for THIS world ──────────────
mapfile -t OLD < <(ls -1d "$DEST/${WORLD}-"*/ 2>/dev/null | sort | head -n -"$KEEP")
if [ "${#OLD[@]}" -gt 0 ]; then
  echo "== retention: keeping the newest $KEEP, removing ${#OLD[@]} older =="
  for d in "${OLD[@]}"; do echo "  rm -rf $d"; rm -rf "$d"; done
fi
echo "== copies on disk for $WORLD =="
ls -1d "$DEST/${WORLD}-"*/ 2>/dev/null | sed 's/^/  /'
