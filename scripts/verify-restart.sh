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
#   4. `-modifier deathpenalty ...` active: the keys it grants land in the world .fwl's
#      startingGlobalKeys (saved on the post-restart world save). NOTE (2026-08-31): tiers map to
#      keys via Unity scene data, decompile-verified per the live .fwl — veryeasy grants ONLY
#      `skillreductionrate 15` (softer skill loss). KEEP-GEAR = `deathkeepequip`, granted by the
#      CASUAL tier only. Player.OnDeath drops everything unless deathkeepequip is set.
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
get $N/worlds_local/EilifRehearsal.fwl $OUT/EilifRehearsal.fwl
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
echo "== ④ death-penalty keys in the world .fwl startingGlobalKeys (saved on the post-restart world save) =="
strings -n 4 "$OUT/EilifRehearsal.fwl" | grep -ioE "deathkeepequip|deathdeleteitems|deathdeleteunequipped|skillreductionrate [0-9]+|deathpenalty_[a-z]+" | sort | uniq -c || true
if strings -n 4 "$OUT/EilifRehearsal.fwl" | grep -qi "deathkeepequip"; then
  echo "KEEP-GEAR ACTIVE (deathkeepequip present — equipped items survive death)"
else
  echo "NO deathkeepequip — players DROP ALL ITEMS on death (veryeasy only softens skill loss; keep-gear needs tier=Casual)"
fi
echo "== console.log: any modifier/preset lines =="; grep -i "modifier\|preset\|penalty" "$OUT/console.log" | head -5 || true
echo "== companion / emitter alive =="; tail -3 "$OUT/LogOutput.log"
