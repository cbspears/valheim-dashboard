#!/usr/bin/env bash
# Launch-day environment cutover for the world named in $1 (default Eilif). DRY RUN unless --apply.
# Flips every world-dependent setting on THIS PC and prints the two remote steps it cannot do.
#   bash scripts/cutover-env.sh Eilif            # show the diff
#   bash scripts/cutover-env.sh Eilif --apply    # write .env files, fix the unit, daemon-reload (no restarts)
set -u
W=${1:-Eilif}; APPLY=0; [ "${2:-}" = "--apply" ] && APPLY=1
BOT=services/discord-bot/.env; POL=services/log-poller/.env; UNIT=/etc/systemd/system/eilif-discord-bot.service
NEST=/191.101.30.229_6028
echo "== cutover-env for world '$W' ($([ $APPLY = 1 ] && echo APPLYING || echo dry run)) =="
plan() { printf '  %-44s %s\n' "$1" "$2"; }
plan "$BOT RECAPS_START" "-> 2026-09-09"
plan "$BOT RECAP/MILESTONE/OATH/BOSS_CHANNEL" "-> removed (back to #valheim)"
plan "$BOT TITLE_CHANNEL" "-> valheim"
plan "$UNIT Environment=RECAPS_START" "-> line removed (unit must stop overriding .env)"
plan "$POL MAP_REMOTE_DIR" "-> $NEST/BepInEx/plugins/WebMap/map_data/$W"
plan "$POL LOG_PATH" "unchanged (log path does not depend on the world)"
if [ $APPLY = 1 ]; then
  sed -i -E 's/^RECAPS_START=.*/RECAPS_START=2026-09-09/' "$BOT"
  sed -i -E '/^(RECAP|MILESTONE|OATH|BOSS)_CHANNEL=/d' "$BOT"
  grep -q '^TITLE_CHANNEL=' "$BOT" && sed -i -E 's/^TITLE_CHANNEL=.*/TITLE_CHANNEL=valheim/' "$BOT" || echo 'TITLE_CHANNEL=valheim' >> "$BOT"
  sed -i -E "s#^MAP_REMOTE_DIR=.*#MAP_REMOTE_DIR=$NEST/BepInEx/plugins/WebMap/map_data/$W#" "$POL"
  sudo -n sed -i '/^Environment=RECAPS_START=/d' "$UNIT" && sudo -n systemctl daemon-reload && echo "  unit line removed + daemon-reload done"
  echo "  .env files written. Restart order: poller, then bot (after the wipe), map-snapshot LAST (after map_data/$W exists)."
fi
echo "== remote steps (Charlie / Claude, not scriptable here) =="
echo "  1. Vercel: vercel env rm GS_EXPECTED_WORLD production --yes; printf '$W' | vercel env add GS_EXPECTED_WORLD production   -> then vercel deploy --prod"
echo "  2. GTX (server STOPPED): BepInEx/config/net.cproudlock.gsvalheimstats.cfg  [General] World = $W"
echo "  3. Pack: node scripts/mint-pack.mjs --world $W --companion-client 0.3.2 --paths 1.4.0 --publish   (then MODPACK_PROFILE_CODE + MODPACK_VERSION_LABEL in config/server.ts, node scripts/build-config-bundle.mjs --world $W, deploy)"
