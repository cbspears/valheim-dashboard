#!/usr/bin/env bash
# Eilif ops: what did the last GTX panel Stop->Start actually arm? READ-ONLY over SFTP.
#
#   bash scripts/verify-restart.sh                  # defaults to the rehearsal world
#   bash scripts/verify-restart.sh MyLaunchWorld    # after cutover, pass the launch world name
#   OUT=/some/dir bash scripts/verify-restart.sh
#
# Checks, in the order launch night needs them:
#   0. Valheim version from console.log — the proof no Steam auto-update ran (must stay 0.221.12
#      through launch week unless the posture decision says otherwise).
#   1. AzuCraftyBoxes server DLL loaded by this boot's chainloader (BepInEx/LogOutput.log)
#   2. ValheimPlus [CraftFromChest] enabled=false          (server cfg, fleet-synced)
#   3. ValheimPlus [Workbench] workbenchAttachmentRange=20  (server cfg, fleet-synced)
#   4. Death penalty, reported as TWO SEPARATE FACTS (audit plugins-2, 2026-09-03):
#        (a) PANEL TIER   — the latest `Setting world modifier: DeathPenalty->` line in console.log.
#            Tiers map to keys via Unity scene data (decompile-verified): `veryeasy` grants ONLY
#            `skillreductionrate 15`. KEEP-GEAR (`deathkeepequip`) is granted by the CASUAL tier.
#        (b) PLUGIN ENFORCEMENT — Eilif Companion 0.3.0's `[EILIF_KEY] enforced world key:
#            deathkeepequip` in LogOutput.log. The plugin writes the key with canSaveToServerOptionKeys
#            = true, so it also lands in the world's startingGlobalKeys (.fwl) — which is why the old
#            "grep the .fwl for deathkeepequip" check false-positived as KEEP-GEAR ACTIVE regardless
#            of the panel tier. `easy + deathkeepequip-by-plugin` is a REAL and FRAGILE state: on the
#            first boot where the plugin fails to load (what 1.0 does to an unrecompiled plugin),
#            everybody drops everything again. Panel Casual is the durable fix.
#   5. Combat modifier tier (decided separately from death penalty; live boot has been `default`).
#   6. WebMap port 3000 reachability from this PC (gtx-1: it was serving the full map publicly on
#      2026-09-03; the fix is a GTX firewall ticket, NOT server_port=0 which NREs at world load).
#
# World layout: 0.221.x stores a world as worlds_local/<W>.db + <W>.fwl. PTB 0.221.13 reworked
# saves into a FOLDER per world (worlds_local/<W>/, chunked) and that may ship in 1.0 (audit mods-6).
# This script probes for the folder first and falls back to the flat pair, so it keeps working
# either way — and the death-penalty facts above come from the logs, not the world file, so they
# survive the format change regardless.
#
# Needs: sshpass, sftp, strings (binutils), curl. The GTX nest dir is IP_PORT-derived: if the box
# moves, update N=/HOST= below together with the poller's LOG_PATH / MAP_REMOTE_DIR.
set -u
WORLD=${1:-EilifRehearsal}
ENV=~/Projects/valheim-dashboard/services/log-poller/.env
export SSHPASS="$(sed -n 's/^SFTP_PASSWORD=//p' "$ENV" | sed 's/^["'"'"']//; s/["'"'"']$//')"
OUT=${OUT:-${TMPDIR:-/tmp}/eilif-verify-restart}; mkdir -p "$OUT"
HOST=191.101.30.229
N=${HOST}_6028
WEBMAP_URL=http://${HOST}:3000/

echo "== verify-restart for world '$WORLD' =="

# One SFTP session for everything. `ls` of both possible world layouts; the flat-pair `get`s are
# best-effort (they fail harmlessly with "not found" on a folder-layout world, which is why -q and
# the trailing `|| true` are here).
sshpass -e sftp -q -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -P 8822 charless3@$HOST > "$OUT/sftp-ls.txt" 2>&1 <<EOF || true
get $N/BepInEx/LogOutput.log $OUT/LogOutput.log
get $N/console.log $OUT/console.log
get $N/BepInEx/config/valheim_plus.cfg $OUT/valheim_plus.cfg
get $N/worlds_local/$WORLD.fwl $OUT/$WORLD.fwl
ls -la $N/BepInEx/config/
ls -la $N/worlds_local/
ls -la $N/worlds_local/$WORLD/
ls -la $N/BepInEx/plugins/WebMap/map_data/$WORLD/
EOF

# Layout probe: sftp writes "Can't ls: ... not found" to stderr (captured above) when the folder
# form does not exist, and a `drwx...  <W>` line in the worlds_local listing when it does.
echo "== world layout on the box =="
FOLDER_WORLD=no
grep -qE "^d.* $WORLD\$" "$OUT/sftp-ls.txt" && FOLDER_WORLD=yes
grep -q "Can't ls:.*worlds_local/$WORLD" "$OUT/sftp-ls.txt" && FOLDER_WORLD=no
if [ "$FOLDER_WORLD" = yes ]; then
  echo "  FOLDER layout detected: worlds_local/$WORLD/ (1.0 chunked saves — the .fwl line below is informational only)"
  echo "  → pull-world.sh must use 'get -r' for this world; the log-based checks below still hold."
elif [ -s "$OUT/$WORLD.fwl" ]; then
  echo "  FLAT layout: worlds_local/$WORLD.db + $WORLD.fwl (0.221.x)"
else
  echo "  ⚠️  neither worlds_local/$WORLD.fwl nor worlds_local/$WORLD/ was found — wrong world name?"
fi
grep -i "$WORLD" "$OUT/sftp-ls.txt" | grep -v "^sftp>" | head -8 || true

echo "== ⓪ Valheim version (console.log — proof no Steam update ran) =="
grep -a -m1 "Valheim version:" "$OUT/console.log" || echo "  (no 'Valheim version:' line in this console.log)"

echo "== AzuCraftyBoxes cfg present on server? (generated at first boot with the DLL) =="
grep -i "AzuCraftyBoxes" "$OUT/sftp-ls.txt" || echo "no Azumatt.AzuCraftyBoxes.cfg/.yml yet"

echo "== boot time / world (console.log) =="
grep -a -m1 "Get create world" "$OUT/console.log"; grep -a -m1 "Load world" "$OUT/console.log"

echo "== plugins loaded at this boot (LogOutput.log) =="
grep -a "Loading \[" "$OUT/LogOutput.log" | sed 's/.*Loading //'

echo "== ① AzuCraftyBoxes server DLL loaded? =="
grep -aq "Loading \[AzuCraftyBoxes" "$OUT/LogOutput.log" \
  && echo "YES: $(grep -a -m1 'Loading \[AzuCraftyBoxes' "$OUT/LogOutput.log" | sed 's/.*Loading //')" \
  || echo "NO - AzuCraftyBoxes not in this boot's chainloader"
grep -a -i "AzuCraftyBoxes" "$OUT/LogOutput.log" | grep -aiv "Loading \[" | head -5

echo "== ② V+ CraftFromChest OFF / ③ workbenchAttachmentRange=20 (server cfg, fleet-synced) =="
awk '/^\[CraftFromChest\]/{f=1} f&&/^enabled/{print "CraftFromChest.enabled =", $3; f=0}' "$OUT/valheim_plus.cfg"
awk '/^\[Workbench\]/{f=1} f&&/^(enabled|workbenchAttachmentRange)/{print "Workbench." $0} f&&/^\[/&&!/Workbench/{f=0}' "$OUT/valheim_plus.cfg"

echo "== ④a PANEL death-penalty tier (latest 'Setting world modifier: DeathPenalty->' in console.log) =="
PANEL_TIER="$(grep -a "Setting world modifier: DeathPenalty->" "$OUT/console.log" | tail -1 | sed 's/.*DeathPenalty->//' | tr -d '\r')"
if [ -n "$PANEL_TIER" ]; then
  echo "  panel tier: $PANEL_TIER"
  case "$PANEL_TIER" in
    casual) echo "  → CASUAL: the panel itself grants deathkeepequip. Keep-gear survives a plugin failure." ;;
    veryeasy) echo "  → VERYEASY grants ONLY 'skillreductionrate 15'. The panel does NOT keep gear." ;;
    easy) echo "  → EASY does NOT keep gear on its own (no deathkeepequip from the panel)." ;;
    *) echo "  → tier '$PANEL_TIER' does not grant deathkeepequip (only Casual does)." ;;
  esac
else
  echo "  (no DeathPenalty-> line in this console.log — panel tier unknown)"
fi
grep -a "Setting world modifier preset:" "$OUT/console.log" | tail -1 || true

echo "== ④b PLUGIN key enforcement (Eilif Companion [EILIF_KEY] in LogOutput.log) =="
if grep -aq "\[EILIF_KEY\] enforced world key: deathkeepequip" "$OUT/LogOutput.log"; then
  echo "  plugin enforcement: ACTIVE — $(grep -a '\[EILIF_KEY\] enforced world key' "$OUT/LogOutput.log" | tail -1 | sed 's/.*\[EILIF_KEY\] //')"
else
  echo "  plugin enforcement: not seen this boot (no '[EILIF_KEY] enforced world key: deathkeepequip')"
fi
grep -a "\[EILIF_KEY\] runtime world keys" "$OUT/LogOutput.log" | tail -1 | sed 's/.*\[EILIF_KEY\] /  /' || true

echo "== ④c VERDICT on keep-gear =="
PLUGIN_ON=no; grep -aq "\[EILIF_KEY\] enforced world key: deathkeepequip" "$OUT/LogOutput.log" && PLUGIN_ON=yes
if [ "$PANEL_TIER" = "casual" ]; then
  echo "  KEEP-GEAR ACTIVE AND DURABLE (panel tier Casual). Plugin enforcement: $PLUGIN_ON."
elif [ "$PLUGIN_ON" = "yes" ]; then
  echo "  KEEP-GEAR ACTIVE BUT PLUGIN-ONLY (panel tier '${PANEL_TIER:-unknown}' + Companion injecting deathkeepequip)."
  echo "  ⚠️  FRAGILE: the first boot where Eilif Companion does not load (e.g. an unrecompiled plugin"
  echo "     on Valheim 1.0), everyone DROPS ALL ITEMS on death. Set the panel to Casual."
else
  echo "  NO KEEP-GEAR — players DROP ALL ITEMS on death (panel tier '${PANEL_TIER:-unknown}', no plugin key)."
fi
echo "  (.fwl startingGlobalKeys, informational — the plugin writes deathkeepequip in here too, so this"
echo "   line alone can never distinguish panel-granted from plugin-granted:)"
if [ -s "$OUT/$WORLD.fwl" ]; then
  strings -n 4 "$OUT/$WORLD.fwl" | grep -ioE "deathkeepequip|deathdeleteitems|deathdeleteunequipped|skillreductionrate [0-9]+|deathpenalty_[a-z]+" | sort | uniq -c | sed 's/^/    /' || true
else
  echo "    (no $WORLD.fwl fetched — folder-layout world or wrong name)"
fi

echo "== ⑤ Combat modifier (latest 'Setting world modifier: Combat->' in console.log) =="
COMBAT="$(grep -a "Setting world modifier: Combat->" "$OUT/console.log" | tail -1 | sed 's/.*Combat->//' | tr -d '\r')"
echo "  combat: ${COMBAT:-unknown}${COMBAT:+ }$( [ "$COMBAT" = "default" ] && echo '(June decision was Hard — still undecided as of the T−6 audit)' )"

echo "== ⑤b all world modifiers this boot =="
grep -a "Setting world modifier" "$OUT/console.log" | tail -8 | sed 's/^/  /'

echo "== ⑥ WebMap HTTP port 3000 from this PC =="
CODE="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$WEBMAP_URL" 2>/dev/null || echo 000)"
if [ "$CODE" = "000" ]; then
  echo "  port 3000: closed / unreachable (no HTTP response within 8s) — this is what launch wants"
else
  echo "  port 3000: OPEN (HTTP $CODE from $WEBMAP_URL) — WebMap is serving the world map publicly."
  echo "     Fix = GTX firewall ticket for inbound TCP 3000. Do NOT set webmap.cfg server_port=0 (NREs at world load)."
fi

echo "== companion / emitter alive =="
tail -3 "$OUT/LogOutput.log"
