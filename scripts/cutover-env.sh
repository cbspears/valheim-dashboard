#!/usr/bin/env bash
# Launch-day environment cutover for the world named in $1 (default Eilif). DRY RUN unless --apply.
# Flips every world-dependent setting on THIS PC and prints the THREE remote steps it cannot do
# (Vercel GS_EXPECTED_WORLD + deploy, the Emitter cfg World= on the box, the pack mint).
# The full launch morning around this is docs/LAUNCH-DAY.md; this is its step 20b.
#   bash scripts/cutover-env.sh Eilif            # show the diff
#   bash scripts/cutover-env.sh Eilif --apply    # write .env files, fix the unit, daemon-reload (no restarts)
#   bash scripts/cutover-env.sh --apply          # same, for the default world
#
# To REHEARSE the --apply path without touching anything live, point the three
# targets at copies:
#   EILIF_BOT_ENV=/tmp/bot.env EILIF_POLLER_ENV=/tmp/pol.env \
#   EILIF_BOT_UNIT=/tmp/fake.service bash scripts/cutover-env.sh --apply
set -u

# --apply may sit in any position, and a flag is never a world name. The old
# `W=${1:-Eilif}; [ "${2:-}" = "--apply" ]` turned `cutover-env.sh --apply` into a
# silent DRY RUN for a world called "--apply" — on launch morning, at the one
# moment nobody re-reads the transcript.
W=''; APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -*) echo "unknown option: $arg (usage: cutover-env.sh [World] [--apply])" >&2; exit 2 ;;
    *) if [ -z "$W" ]; then W="$arg"; else echo "unexpected argument: $arg" >&2; exit 2; fi ;;
  esac
done
W=${W:-Eilif}

# One assignment per line, and each overridable, so the apply path can be
# rehearsed against copies instead of against the live unit.
BOT=${EILIF_BOT_ENV:-services/discord-bot/.env}
POL=${EILIF_POLLER_ENV:-services/log-poller/.env}
UNIT=${EILIF_BOT_UNIT:-/etc/systemd/system/eilif-discord-bot.service}
# The off-box world backup names its world as an ExecStart ARGUMENT, so it is the
# one world-dependent setting on this PC that no .env can carry (T-3 audit, ops-3).
BACKUP_UNIT=${EILIF_BACKUP_UNIT:-/etc/systemd/system/eilif-world-backup.service}
NEST=/191.101.30.229_6028

# The world eilif-world-backup.service currently pulls, or '' when the unit is
# not installed / not readable.
backup_world() {
  [ -r "$BACKUP_UNIT" ] || return 0
  sed -n 's#^ExecStart=.*pull-world\.sh[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*#\1#p' "$BACKUP_UNIT" | head -1
}
BACKUP_W=$(backup_world)
echo "== cutover-env for world '$W' ($([ $APPLY = 1 ] && echo APPLYING || echo dry run)) =="
plan() { printf '  %-44s %s\n' "$1" "$2"; }
plan "$BOT RECAPS_START" "-> 2026-09-09"
plan "$BOT RECAP/MILESTONE/OATH/BOSS_CHANNEL" "-> removed (back to #valheim)"
plan "$BOT TITLE_CHANNEL" "-> valheim"
plan "$UNIT Environment=RECAPS_START" "-> line removed (unit must stop overriding .env)"
plan "$POL MAP_REMOTE_DIR" "-> $NEST/BepInEx/plugins/WebMap/map_data/$W"
plan "$POL LOG_PATH" "unchanged (log path does not depend on the world)"
if [ -z "$BACKUP_W" ]; then
  plan "$BACKUP_UNIT ExecStart world" "-> unit not installed/readable here — nothing to repoint"
elif [ "$BACKUP_W" = "$W" ]; then
  plan "$BACKUP_UNIT ExecStart world" "-> already $W (off-box backups follow the launch world)"
else
  plan "$BACKUP_UNIT ExecStart world" "-> $W (currently $BACKUP_W) — needs sudo, printed below"
fi

# Set a key to a value whether or not it is already in the file. `sed -i s/^K=.*/`
# alone did NOTHING when the key was absent, and services/discord-bot/src/index.js
# treats an UNSET RECAPS_START as "no gate" rather than "blocked" — so a missing
# key meant recaps could post before launch day, from a run that reported success.
set_key() {
  local file=$1 key=$2 value=$3
  if grep -q "^$key=" "$file"; then
    sed -i -E "s#^$key=.*#$key=$value#" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

if [ $APPLY = 1 ]; then
  FAILED=0
  set_key "$BOT" RECAPS_START 2026-09-09
  sed -i -E '/^(RECAP|MILESTONE|OATH|BOSS)_CHANNEL=/d' "$BOT"
  set_key "$BOT" TITLE_CHANNEL valheim
  set_key "$POL" MAP_REMOTE_DIR "$NEST/BepInEx/plugins/WebMap/map_data/$W"
  echo "  .env files written."

  # THE STEP THAT USED TO FAIL SILENTLY. This was one `sudo -n … && sudo -n … &&
  # echo` chain with no `set -e`: without passwordless sudo the whole chain
  # short-circuited, nothing said so, and the success line below printed anyway.
  # That re-introduced the trap CLAUDE.md sets in bold — the unit's own
  # Environment=RECAPS_START keeps winning over .env — behind a transcript that
  # looked clean. Checked, reported, and fatal now.
  if ! grep -q '^Environment=RECAPS_START=' "$UNIT" 2>/dev/null; then
    echo "  unit line already absent — nothing to remove"
  else
    sudo -n sed -i '/^Environment=RECAPS_START=/d' "$UNIT" 2>/dev/null || true
    # VERIFY THE POSTCONDITION, never sudo's exit code. What matters is whether
    # the line is gone, and only re-reading the file can answer that.
    if grep -q '^Environment=RECAPS_START=' "$UNIT" 2>/dev/null; then
      FAILED=1
      echo "  !! FAILED to edit $UNIT (passwordless sudo unavailable?)." >&2
      echo "  !! The unit's own Environment=RECAPS_START still WINS over $BOT." >&2
      echo "  !! Run these two by hand before starting the bot:" >&2
      echo "         sudo sed -i '/^Environment=RECAPS_START=/d' $UNIT" >&2
      echo "         sudo systemctl daemon-reload" >&2
    else
      sudo -n systemctl daemon-reload 2>/dev/null ||
        echo "  !! unit line removed, but daemon-reload FAILED — run: sudo systemctl daemon-reload" >&2
      echo "  unit line removed + daemon-reload done"
    fi
  fi

  if [ $FAILED = 0 ]; then
    echo "  Restart order: poller, then bot (after the wipe), map-snapshot LAST (after map_data/$W exists)."
  fi
fi
# ── THE OFF-BOX WORLD BACKUP (T-3 audit, ops-3) ─────────────────────────────
# eilif-world-backup.timer keeps firing after the cutover, but its service hard-codes
# the world as an ExecStart argument, so it goes on pulling the OLD world. LAUNCH-DAY
# step 12 deletes that world off the box, so every firing from then on exits 1 with
# "NOTHING was fetched" — a failed unit every six hours that nothing alerts on, while
# the launch world, whose saves are forward-only and whose only rollback is an off-box
# copy, has no backup at all. Preflight does not catch it either: it grades the timer
# on `systemctl is-active` alone, so an active timer pulling a deleted world PASSes.
#
# This one is PRINTED, never attempted: it is a root-owned unit file, and a silent
# `sudo -n` failure here would leave the operator believing backups followed the world.
if [ -n "$BACKUP_W" ] && [ "$BACKUP_W" != "$W" ]; then
  echo "== off-box world backup: repoint it (needs sudo, run by hand) =="
  echo "  The timer still pulls '$BACKUP_W'. After the cutover that world is gone from the box,"
  echo "  so the backup fails every 6 h and '$W' has no off-box copy."
  echo "    sudo sed -i 's#\\(pull-world\\.sh\\)[[:space:]]\\{1,\\}$BACKUP_W#\\1 $W#' $BACKUP_UNIT"
  echo "    sudo systemctl daemon-reload"
  echo "    sudo systemctl start eilif-world-backup.service"
  echo "    journalctl -u eilif-world-backup -n 20 --no-pager   # look for: flat layout: got $W.db + $W.fwl"
  echo "  Verify:  systemctl cat eilif-world-backup.service | grep ExecStart"
elif [ -n "$BACKUP_W" ]; then
  echo "== off-box world backup: already pinned to '$W' — nothing to do =="
else
  echo "== off-box world backup: $BACKUP_UNIT not installed here — no timer to repoint =="
fi

echo "== remote steps (Charlie / Claude, not scriptable here) =="
echo "  1. Vercel: vercel env rm GS_EXPECTED_WORLD production --yes; printf '$W' | vercel env add GS_EXPECTED_WORLD production   -> then vercel deploy --prod"
echo "  2. GTX (server STOPPED): BepInEx/config/net.cproudlock.gsvalheimstats.cfg  [General] World = $W"
# THE PACK LINE IS NOT A COMMAND TO PASTE. It used to print
#   node scripts/mint-pack.mjs --world $W --companion-client 0.3.2 --paths 1.4.0 --publish
# which contradicts the runbook it is supposed to summarise: the 1.0 posture
# needs --paths 1.5.0 --no-vplus --fallback on --cap <N>, mint-pack REFUSES
# --fallback below EilifPaths 1.5.0, and a pack still pinning ValheimPlus is
# refused by a box that no longer runs it (enforceMod checks both directions).
# Following the old line under time pressure minted a pack every client rejects,
# so this now prints the runbook's own flag set and sends the operator there.
#
# THE BUNDLE LINE IS A COMMAND THAT RUNS (fixed 2026-09-06, T-3 audit ops-27).
# It used to print `node scripts/build-config-bundle.mjs --world $W, deploy.` —
# which looks pasteable and exits 2, because that script REQUIRES --pack-number
# and --pack-date as well. Now it prints every flag with a placeholder in the two
# the operator has to decide, so pasting it and filling in <N> and the date is a
# run rather than a usage screen.
#
# Note the flag sets are NOT the same: $M above is mint-pack's, and --cap is
# mint-pack's alone (build-config-bundle rejects it as an unknown argument). The
# pins and --no-vplus/--fallback ARE shared, so they are repeated here rather
# than being reached for out of $M. `mint-pack.mjs --publish` prints this same
# line already filled in from the mint it just did; that one is the authority.
echo "  3. Pack: docs/LAUNCH-DAY.md steps 16 and 18 (throwaway test mint, then dry-run, mint, publish)."
echo "        M=\"--world $W --paths 1.5.0 --companion-client <ver> --no-vplus --fallback on --cap <N>\""
echo "        Then MODPACK_PROFILE_CODE + MODPACK_VERSION_LABEL in config/server.ts, and the bundle:"
echo "        node scripts/build-config-bundle.mjs --world $W --pack-number <N> --pack-date '<Mon D, YYYY>' \\"
echo "          --paths 1.5.0 --companion-client <ver> --no-vplus --fallback on"
echo "        (fill in <N> and the date; --cap is mint-pack's flag only. mint-pack --publish"
echo "         prints this line already filled in — use that one. Then deploy.)"

# A cutover that could not finish must not exit 0 — the operator's next step is
# to start the bot, and this is the one failure they cannot see from its logs.
if [ $APPLY = 1 ] && [ "${FAILED:-0}" != 0 ]; then
  echo "== cutover INCOMPLETE: the unit still overrides RECAPS_START (see above) ==" >&2
  exit 1
fi
