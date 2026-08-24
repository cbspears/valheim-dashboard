#!/usr/bin/env bash
# Eilif ops: what did the last GTX panel Stop->Start actually arm? READ-ONLY over SFTP.
#
#   bash scripts/verify-restart.sh            # creds + host come from services/log-poller/.env
#   OUT=/some/dir bash scripts/verify-restart.sh
#
# Checks, in the order the 2026-08-23 handoff asks for them:
#   1. AzuCraftyBoxes server DLL loaded by this boot's chainloader (BepInEx/LogOutput.log)
#   2. ValheimPlus [CraftFromChest] enabled=false          (server cfg, fleet-synced)
#   3. ValheimPlus [Workbench] workbenchAttachmentRange=20  (server cfg, fleet-synced)
#   4. `-modifier deathpenalty ...` active: shows up as a death* global key in the world .db,
#      but ONLY after a world save that happened after the restart (autosave, or panel console `save`).
# Needs: sshpass, sftp, strings (binutils). The GTX nest dir is IP_PORT-derived: if the box moves,
# update N= below together with the poller's LOG_PATH / MAP_REMOTE_DIR.
set -u
ENV=~/Projects/valheim-dashboard/services/log-poller/.env
export SSHPASS="$(sed -n 's/^SFTP_PASSWORD=//p' "$ENV" | sed 's/^["'"'"']//; s/["'"'"']$//')"
OUT=${OUT:-${TMPDIR:-/tmp}/eilif-verify-restart}; mkdir -p "$OUT"
N=191.101.30.229_6028
sshpass -e sftp -q -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -P 8822 charless3@191.101.30.229 > "$OUT/sftp-ls.txt" <<EOF
get $N/BepInEx/LogOutput.log $OUT/LogOutput.log
get $N/console.log $OUT/console.log
get $N/BepInEx/config/valheim_plus.cfg $OUT/valheim_plus.cfg
get $N/worlds_local/EilifRehearsal.db $OUT/EilifRehearsal.db
ls -la $N/BepInEx/config/
ls -la $N/worlds_local/EilifRehearsal.db
EOF
echo "== AzuCraftyBoxes cfg present on server? (generated at first boot with the DLL) =="; grep -i "AzuCraftyBoxes" "$OUT/sftp-ls.txt" || echo "no Azumatt.AzuCraftyBoxes.cfg/.yml yet"
echo "== boot time / world (console.log) =="; grep -m1 "Get create world" "$OUT/console.log"; grep -m1 "Load world" "$OUT/console.log"
echo "== plugins loaded at this boot (LogOutput.log) =="; grep "Loading \[" "$OUT/LogOutput.log" | sed 's/.*Loading //'
echo "== ① AzuCraftyBoxes server DLL loaded? =="; grep -q "Loading \[AzuCraftyBoxes" "$OUT/LogOutput.log" && echo "YES: $(grep -m1 'Loading \[AzuCraftyBoxes' "$OUT/LogOutput.log" | sed 's/.*Loading //')" || echo "NO - AzuCraftyBoxes not in this boot's chainloader"
grep -i "AzuCraftyBoxes" "$OUT/LogOutput.log" | grep -iv "Loading \[" | head -5
echo "== ② V+ CraftFromChest OFF / ③ workbenchAttachmentRange=20 (server cfg, fleet-synced) =="
awk '/^\[CraftFromChest\]/{f=1} f&&/^enabled/{print "CraftFromChest.enabled =", $3; f=0}' "$OUT/valheim_plus.cfg"
awk '/^\[Workbench\]/{f=1} f&&/^(enabled|workbenchAttachmentRange)/{print "Workbench." $0} f&&/^\[/&&!/Workbench/{f=0}' "$OUT/valheim_plus.cfg"
echo "== ④ deathpenalty modifier: global keys in the world .db (needs a world save AFTER the restart; autosave ~30 min or panel console 'save') =="
strings -n 6 "$OUT/EilifRehearsal.db" | grep -iE "^(death|nomap|noportals|passivemobs|playerevents|teleportall|weakermobs|defeated_)" | sort | uniq -c || true
strings -n 6 "$OUT/EilifRehearsal.db" | grep -qi "^death" && echo "DEATH-PENALTY KEY PRESENT (see above)" || echo "no death* global key in the .db (modifier NOT active as of the last world save; remote mtime: $(grep 'EilifRehearsal.db$' "$OUT/sftp-ls.txt" | awk '{print $6,$7,$8}'))"
echo "== console.log: any modifier/preset lines =="; grep -i "modifier\|preset\|penalty" "$OUT/console.log" | head -5 || true
echo "== companion / emitter alive =="; tail -3 "$OUT/LogOutput.log"
