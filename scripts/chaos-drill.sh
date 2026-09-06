#!/usr/bin/env bash
# Chaos drill: prove the off-PC alerting chain with a real outage of the PC-hosted
# services, on a quiet hall, while the owner watches the watchdog channel.
#
#   bash scripts/chaos-drill.sh            # print the plan, touch nothing
#   bash scripts/chaos-drill.sh --go       # run it (stops live services for ~25 min)
#   options: --wait-min N (default 21: the watchdog's 20-minute silence threshold
#            plus one), --netcut (also drop the SFTP path for 3 minutes while the
#            poller runs, to watch it back off and resume), --force (run with
#            players online, not recommended)
#
# What it does, in order:
#   0. Baseline: dispatch the GitHub watchdog and expect action=none.
#   1. Stop eilif-log-poller, eilif-discord-bot, eilif-map-snapshot.
#   2. Wait for the 20-minute silence threshold to pass (the site must keep
#      answering the whole time: it does not depend on this PC).
#   3. Dispatch the watchdog: expect action=alert naming the poller and the bot
#      (the map snapshot's threshold is 45 minutes, so it is not expected yet),
#      and a message in the watchdog channel.
#   4. Start the three services, wait for fresh heartbeats.
#   5. Dispatch the watchdog: expect action=recover and a recovery message.
#   6. Optional: --netcut drops TCP to the game box's SFTP port for 3 minutes.
#      Expected: the poller logs failures, backs off, does not crash, resumes.
# An EXIT trap restarts every service and removes the firewall rule, so an
# interrupted drill never leaves the hall dark.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNITS=(eilif-log-poller.service eilif-discord-bot.service eilif-map-snapshot.service)
BOX_IP=191.101.30.229; SFTP_PORT=8822
GO=0; WAIT_MIN=21; NETCUT=0; FORCE=0
while [ $# -gt 0 ]; do case "$1" in
  --go) GO=1;; --wait-min) WAIT_MIN="$2"; shift;; --netcut) NETCUT=1;; --force) FORCE=1;;
  *) echo "unknown arg $1"; exit 2;; esac; shift; done
LOGDIR="${CHAOS_LOG_DIR:-/tmp/claude-1000/-home-cbspears/967a92d4-2a82-4ec6-971d-d60481d38142/scratchpad/chaos}"
mkdir -p "$LOGDIR"; LOG="$LOGDIR/drill-$(date +%Y%m%d-%H%M%S).log"
say() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"; }
# Inside dispatch() stdout is CAPTURED by the caller ($(...)), so progress must go
# to stderr and the log, and only the bare action word to stdout.
note() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG" >&2; }
RULE_ON=0
cleanup() {
  if [ "$GO" = 1 ]; then
    say "cleanup: starting all services and clearing the firewall rule"
    sudo -n systemctl start "${UNITS[@]}" 2>/dev/null || true
    if [ "$RULE_ON" = 1 ]; then sudo -n iptables -D OUTPUT -d "$BOX_IP" -p tcp --dport "$SFTP_PORT" -j DROP 2>/dev/null || true; fi
  fi
}
trap cleanup EXIT

dispatch() {  # $1 = label, expects the workflow response JSON to contain "action"
  local label="$1" before after id tries=0
  before=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run watchdog.yml >/dev/null 2>&1 || { note "$label: gh workflow run FAILED"; return 1; }
  sleep 8
  while :; do
    id=$(gh run list --workflow=watchdog.yml --limit 5 --json databaseId,createdAt,status,event \
      --jq "[.[] | select(.event==\"workflow_dispatch\" and .createdAt >= \"$before\")] | .[0].databaseId" 2>/dev/null)
    [ -n "$id" ] && [ "$id" != "null" ] && break
    tries=$((tries+1)); [ $tries -gt 12 ] && { note "$label: no run appeared"; return 1; }; sleep 5
  done
  gh run watch "$id" --exit-status >/dev/null 2>&1; local rc=$?
  local body; body=$(gh run view "$id" --log 2>/dev/null | grep -o '{.*}' | tail -1)
  local action notified
  action=$(printf '%s' "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('alert') or {}).get('action') or (d.get('decision') or {}).get('action') or d.get('action') or '?')" 2>/dev/null || echo '?')
  notified=$(printf '%s' "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); n=d.get('notified',{}); print('posted' if n.get('ok') else ('not-posted:'+str(n.get('error','')) if n.get('attempted') else 'no-post'))" 2>/dev/null || echo '?')
  note "$label: run $id exit=$rc action=$action discord=$notified"
  printf '%s\n' "$body" >> "$LOG"
  echo "$action"
}

status_ok() { curl -s -m 15 https://valheim-dashboard.vercel.app/api/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'])" 2>/dev/null; }

say "chaos drill $( [ $GO = 1 ] && echo RUN || echo PLAN ) wait=${WAIT_MIN}m netcut=$NETCUT log=$LOG"
players=$(status_ok); say "site answers, players online: ${players:-unknown}"
if [ "$GO" != 1 ]; then
  cat <<PLAN
Plan (nothing was changed):
  0. dispatch watchdog, expect action=none
  1. stop ${UNITS[*]}
  2. wait ${WAIT_MIN} minutes (site checked every 5 min)
  3. dispatch watchdog, expect action=alert (poller + bot) and a Discord message
  4. start the services, wait 3 minutes for heartbeats
  5. dispatch watchdog, expect action=recover and a recovery message
  6. $( [ $NETCUT = 1 ] && echo "drop SFTP to $BOX_IP:$SFTP_PORT for 3 minutes, watch the poller journal, restore" || echo "(netcut not requested)" )
Re-run with --go to execute.
PLAN
  exit 0
fi
if [ "${players:-0}" != "0" ] && [ $FORCE != 1 ]; then say "players online; refusing without --force"; exit 3; fi
sudo -n true 2>/dev/null || { say "sudo -n is not available; cannot stop services"; exit 4; }

say "phase 0: baseline"
a0=$(dispatch baseline)
say "phase 1: stopping ${UNITS[*]}"
sudo -n systemctl stop "${UNITS[@]}"; systemctl is-active "${UNITS[@]}" | tr '\n' ' ' | sed 's/^/  states: /' | tee -a "$LOG"; echo
say "phase 2: waiting ${WAIT_MIN} minutes for the silence threshold"
for ((m=5; m<=WAIT_MIN; m+=5)); do sleep 300; say "  +${m}m site players=$(status_ok) (site still answering without this PC)"; done
rem=$(( (WAIT_MIN % 5) * 60 )); [ $rem -gt 0 ] && sleep $rem
say "phase 3: dispatch, expecting an alert"
a3=$(dispatch outage)
say "phase 4: starting services"
sudo -n systemctl start "${UNITS[@]}"; sleep 180; systemctl is-active "${UNITS[@]}" | tr '\n' ' ' | sed 's/^/  states: /' | tee -a "$LOG"; echo
say "phase 5: dispatch, expecting recovery"
a5=$(dispatch recovery)
if [ $NETCUT = 1 ]; then
  say "phase 6: dropping SFTP to $BOX_IP:$SFTP_PORT for 3 minutes"
  sudo -n iptables -I OUTPUT -d "$BOX_IP" -p tcp --dport "$SFTP_PORT" -j DROP && RULE_ON=1
  sleep 180
  sudo -n iptables -D OUTPUT -d "$BOX_IP" -p tcp --dport "$SFTP_PORT" -j DROP && RULE_ON=0
  say "  poller journal during the cut:"; journalctl -u eilif-log-poller.service --since "-4min" --no-pager -o cat | grep -iv "^$" | tail -8 | sed 's/^/    /' | tee -a "$LOG"
  sleep 60; say "  poller after restore: $(systemctl is-active eilif-log-poller.service), last lines:"; journalctl -u eilif-log-poller.service --since "-70s" --no-pager -o cat | tail -3 | sed 's/^/    /' | tee -a "$LOG"
fi
say "RESULT baseline=$a0 outage=$a3 recovery=$a5 (expected none / alert / recover)"
[ "$a3" = alert ] && [ "$a5" = recover ] && say "DRILL PASS" || say "DRILL FAIL: see $LOG"
