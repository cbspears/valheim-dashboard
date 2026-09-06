#!/usr/bin/env bash
# Chaos drill: prove the off-PC alerting chain with a real outage of the PC-hosted
# services, on a quiet hall, while the owner watches the watchdog channel.
#
#   bash scripts/chaos-drill.sh            # print the plan, touch nothing
#   bash scripts/chaos-drill.sh --go       # run it (stops live services for ~25 min)
#   options: --wait-min N (default 21: the watchdog's 20-minute silence threshold
#            plus one), --netcut (also drop the SFTP path for 3 minutes while the
#            poller runs, to watch it back off and resume), --force (run with
#            players online, or on a hall that is already unhealthy -- neither
#            is recommended, and the second makes the result mean less)
#
# What it does, in order:
#   0. Baseline: dispatch the GitHub watchdog and REQUIRE a quiet hall --
#      action=none, unhealthyCount=0, and the alert row already back to ok.
#      Anything else and the drill stops here, before it has touched a thing.
#   1. Stop eilif-log-poller, eilif-discord-bot, eilif-map-snapshot.
#   2. Wait for the 20-minute silence threshold to pass (the site must keep
#      answering the whole time: it does not depend on this PC).
#   3. Dispatch the watchdog: expect an alert naming the poller and the bot
#      (the map snapshot's threshold is 45 minutes, so it is not expected yet),
#      and a message in the watchdog channel.
#   4. Start the three services, wait for fresh heartbeats.
#   5. Dispatch the watchdog: expect the recovery and a recovery message.
#   6. Optional: --netcut drops TCP to the game box's SFTP port for 3 minutes.
#      Expected: the poller logs failures, backs off, does not crash, resumes.
# An EXIT trap restarts every service and removes the firewall rule, so an
# interrupted drill never leaves the hall dark.
#
# THERE ARE TWO PINGERS, AND THIS DRILL IS NOT THE ONLY ONE (2026-09-06).
# /api/ops/watchdog is hit by:
#   * .github/workflows/watchdog.yml, which this script dispatches by hand
#     (its schedule nominally says 15 minutes; observed, GitHub fires it about
#     every 4 hours, which is why the drill dispatches rather than waits), and
#   * the Supabase pg_cron job `eilif-watchdog-ping`, live since 2026-09-06
#     10:12 CT (db/2026-09-06_watchdog_pgcron.sql), EVERY FIVE MINUTES.
# The route only speaks on a STATE TRANSITION: ok -> alerting posts the alert,
# alerting -> ok posts the recovery, and every run in between returns
# action=none. So during phase 2's 21-minute wait the pg_cron pinger crosses the
# silence threshold four times over and takes the ok->alerting edge itself; by
# the time this script dispatches in phase 3 the honest answer is
# `action=none, reason=suppressed`. The same happens to the recovery in phase 5.
# Asserting on this script's OWN action word therefore printed DRILL FAIL on a
# night when the chain worked perfectly (T-3 audit ops-2).
#
# What the phases assert instead: THE CHAIN FIRED, no matter which pinger fired
# it. Each dispatch returns the action, the alert reason, unhealthyCount, the
# prior alert state and whether the Discord post went out, and the pass
# conditions are about the state the route reports rather than about who got
# there first:
#   phase 3 PASS if action=alert AND the Discord post succeeded (this drill fired
#                it), OR action=none with unhealthyCount>0 and a CLEAN BASELINE
#                (a pinger already did, and the route is suppressing the repeat)
#                -- "already-fired"
#   phase 5 PASS if action=recover AND the Discord post succeeded (this drill
#                fired it), OR action=none with unhealthyCount=0 AFTER phase 3
#                saw the outage (a pinger already posted the all-clear)
#                -- "already-fired"
# Every run prints which of the two paths it took.
#
# TWO THINGS THE "already-fired" SHORTCUT WOULD OTHERWISE SWALLOW (T-3 fix pass):
#
#   * A DIRTY BASELINE. "action=none while unhealthy" is also what the route
#     answers when the hall was ALREADY down, or already alerting, before the
#     drill started: the services never came up after the last drill, or an
#     outage was never cleared. Phase 3 would read that as "a pinger took the
#     edge" and pass, and phase 5 would pass on the way back, and DRILL PASS
#     would print with nothing whatsoever posted inside the drill window. So
#     phase 0's baseline is now ASSERTED, not merely printed: the drill refuses
#     to stop anything unless the hall is healthy (unhealthyCount=0) AND the
#     alert row is already back to ok. Nothing has been touched at that point,
#     so the refusal is free. --force runs anyway and says the result means less.
#
#   * A DISCORD POST THAT FAILED. When postToDiscord() fails the route answers
#     502 with action=alert, notified.ok=false, and deliberately does NOT persist
#     the new state so the next run retries. Asserting on the action word alone
#     passed that: the one link the drill exists to prove is the link to Discord.
#     dispatch() now reports `notified` as a field, and an action=alert /
#     action=recover path only passes when the post actually went out.
#
# On an "already-fired" path the message is in the watchdog channel with the
# pinger's timestamp, not this script's: read the channel to see the text, this
# script only proves the edge was crossed. To watch the drill fire both edges
# itself instead, unschedule the database job first and re-schedule it
# afterwards:
#   select cron.unschedule('eilif-watchdog-ping');
#   select cron.schedule('eilif-watchdog-ping', '*/5 * * * *', $$ ... $$);
# (the full statement is in db/2026-09-06_watchdog_pgcron.sql).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNITS=(eilif-log-poller.service eilif-discord-bot.service eilif-map-snapshot.service)
BOX_IP=191.101.30.229; SFTP_PORT=8822
GO=0; WAIT_MIN=21; NETCUT=0; FORCE=0
while [ $# -gt 0 ]; do case "$1" in
  --go) GO=1;; --wait-min) WAIT_MIN="$2"; shift;; --netcut) NETCUT=1;; --force) FORCE=1;;
  *) echo "unknown arg $1"; exit 2;; esac; shift; done
# Default log directory. It used to be one agent session's scratchpad path, which
# only existed on the machine that wrote it (T-3 audit ops-13). Override with
# CHAOS_LOG_DIR to keep a drill's logs somewhere durable.
LOGDIR="${CHAOS_LOG_DIR:-${TMPDIR:-/tmp}/eilif-chaos}"
mkdir -p "$LOGDIR"; LOG="$LOGDIR/drill-$(date +%Y%m%d-%H%M%S).log"
say() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"; }
# Inside dispatch() stdout is CAPTURED by the caller ($(...)), so progress must go
# to stderr and the log, and only the one machine-readable line to stdout.
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

# Dispatch the GitHub watchdog once and report what the ROUTE said, not just what
# this dispatch did. Prints ONE line to stdout for the caller to read with
# `read -r`, five space-separated fields (each one a single token, so a `read -r`
# with five names always lines up):
#
#     <action> <reason> <unhealthyCount> <priorState> <notified>
#
#   action        alert | recover | none | ?            (alert.action)
#   reason        first-unhealthy | suppressed | healthy | recovered | ...
#                 (alert.reason -- this is what distinguishes "none because the
#                 hall is fine" from "none because a pinger already alerted")
#   unhealthy     unhealthyCount, the number of failing checks right now
#   priorState    ok | alerting -- the ops_alerts row BEFORE this run, i.e. what
#                 the last pinger to speak left behind. A 502 (Discord post
#                 failed) has no alert.priorState at all, so it reads `?`.
#   notified      posted | not-posted | no-post | ?  -- did the message reach
#                 Discord. `no-post` is the honest answer for action=none: the
#                 route only posts on a transition, so there was nothing to send.
#                 The failure DETAIL is not in this field (it would contain
#                 spaces); it goes to the log line and the run log instead.
#
# Any field that cannot be read comes back as `?`, and the caller treats a `?` as
# a failure rather than as a pass: a drill that cannot read the answer has not
# proven anything.
dispatch() {  # $1 = label
  local label="$1" before id tries=0
  before=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run watchdog.yml >/dev/null 2>&1 || { note "$label: gh workflow run FAILED"; echo "? ? ? ? ?"; return 1; }
  sleep 8
  while :; do
    id=$(gh run list --workflow=watchdog.yml --limit 5 --json databaseId,createdAt,status,event \
      --jq "[.[] | select(.event==\"workflow_dispatch\" and .createdAt >= \"$before\")] | .[0].databaseId" 2>/dev/null)
    [ -n "$id" ] && [ "$id" != "null" ] && break
    tries=$((tries+1)); [ $tries -gt 12 ] && { note "$label: no run appeared"; echo "? ? ? ? ?"; return 1; }; sleep 5
  done
  gh run watch "$id" --exit-status >/dev/null 2>&1; local rc=$?
  local body; body=$(gh run view "$id" --log 2>/dev/null | grep -o '{.*}' | tail -1)
  local fields
  fields=$(printf '%s' "$body" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('? ? ? ? ?'); raise SystemExit
a = d.get('alert') or d.get('decision') or {}
action = a.get('action') or d.get('action') or '?'
reason = a.get('reason') or '?'
n = d.get('unhealthyCount')
prior = (a.get('priorState') or {}).get('state') or '?'
# One token, no spaces: the caller reads this with a five-name \`read -r\`.
# The route sets notified.attempted only when it actually tried to post, which
# is only on a transition, so 'no-post' is correct-and-expected for action=none.
nf = d.get('notified')
if not isinstance(nf, dict):
    notified = '?'
elif nf.get('ok'):
    notified = 'posted'
elif nf.get('attempted'):
    notified = 'not-posted'
else:
    notified = 'no-post'
print(action, reason, ('?' if n is None else n), prior, notified)
" 2>/dev/null || echo '? ? ? ? ?')
  # The failure detail (which is prose, with spaces) never goes on the machine
  # line; it goes here and into the run log, where a human reads it.
  local detail
  detail=$(printf '%s' "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); n=d.get('notified') or {}; print(str(n.get('error') or ''))" 2>/dev/null || echo '')
  note "$label: run $id exit=$rc [$fields]${detail:+ discord-error=$detail}"
  printf '%s\n' "$body" >> "$LOG"
  echo "$fields"
}

# >>> drill-verdicts (extracted verbatim by scripts/chaos-drill.test.mjs — keep
# this block free of anything that is not pure decision logic, so the test can
# run it in a bare shell with no GitHub CLI, no privileges and no network.)
#
# The three functions take the five fields dispatch() prints. The two edge
# verdicts echo exactly one word, and ANY WORD BEGINNING `fail` IS A FAILURE —
# the caller matches `fail*`, so a new failure reason can be added here with its
# own name without touching the caller:
#   this-drill        this dispatch crossed the edge itself, and Discord took it
#   already-fired     the edge was already crossed by the pg_cron pinger
#   fail-not-posted   the route decided to speak and the Discord post FAILED
#   fail-baseline     the hall was not quiet when the drill started, so
#                     "already-fired" cannot be told apart from "was already
#                     broken and nobody said anything new"
#   fail              no edge was crossed, or the answer could not be read

# $1 action  $2 reason  $3 unhealthyCount  $4 priorState  ($5 notified, unused)
# Echoes clean | dirty. CLEAN means the drill is measuring its own outage and
# nobody else's: nothing unhealthy, and the alert row already back to ok so the
# ok->alerting edge is genuinely still ahead of us. `?` in either field is dirty,
# because a baseline that could not be read is not a baseline.
baseline_clean() {
  if [ "$1" = none ] && [[ "$3" =~ ^[0-9]+$ ]] && [ "$3" -eq 0 ] && [ "$4" = ok ]; then
    echo clean; return 0
  fi
  echo dirty
}

# $1 action  $2 reason  $3 unhealthyCount  $4 priorState  $5 notified
# $6 the phase-0 baseline verdict (clean | dirty)
alert_edge_taken() {
  if [ "$1" = alert ]; then
    # The route answers 502 with action=alert when postToDiscord() failed, and
    # deliberately does not persist the state. The action word alone would call
    # that a pass, on the one link this drill exists to prove.
    if [ "$5" = posted ]; then echo this-drill; return 0; fi
    echo fail-not-posted; return 0
  fi
  # `none` is a pass ONLY while something is actually unhealthy: that is the
  # route suppressing a repeat of an alert that is already out. A non-numeric
  # count means the response could not be read, which proves nothing.
  if [ "$1" = none ] && [[ "$3" =~ ^[0-9]+$ ]] && [ "$3" -gt 0 ]; then
    # ...and only if the hall was quiet to begin with. On a dirty baseline this
    # exact answer is also what a hall that was ALREADY down returns, with no
    # message posted anywhere inside the drill window.
    if [ "$6" = clean ]; then echo already-fired; return 0; fi
    echo fail-baseline; return 0
  fi
  echo fail
}

# $1 action  $2 reason  $3 unhealthyCount  $4 priorState  $5 notified
# $6 the phase-3 verdict
recovery_edge_taken() {
  if [ "$1" = recover ]; then
    if [ "$5" = posted ]; then echo this-drill; return 0; fi
    echo fail-not-posted; return 0
  fi
  # `none` while healthy means the ops_alerts row is already back to ok, i.e.
  # somebody posted the all-clear — but only if the outage was established in
  # the first place. Without the phase-3 gate this is also what a drill that
  # never stopped anything would return.
  if [ "$1" = none ] && [[ "$3" =~ ^[0-9]+$ ]] && [ "$3" -eq 0 ] && [ "${6#fail}" = "$6" ]; then
    echo already-fired; return 0
  fi
  echo fail
}
# <<< drill-verdicts

status_ok() { curl -s -m 15 https://valheim-dashboard.vercel.app/api/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'])" 2>/dev/null; }

say "chaos drill $( [ $GO = 1 ] && echo RUN || echo PLAN ) wait=${WAIT_MIN}m netcut=$NETCUT log=$LOG"
players=$(status_ok); say "site answers, players online: ${players:-unknown}"
if [ "$GO" != 1 ]; then
  cat <<PLAN
Plan (nothing was changed):
  0. dispatch watchdog and REQUIRE a quiet hall: action=none, unhealthyCount=0,
     and the alert row already back to ok. If it is not, the drill stops here
     without touching a service (--force runs anyway, and says the result means
     less: on a hall that is already unhealthy, "a pinger already alerted" and
     "nothing new was ever posted" look identical from here).
  1. stop ${UNITS[*]}
  2. wait ${WAIT_MIN} minutes (site checked every 5 min)
  3. dispatch watchdog, expect the ALERT edge to have been crossed: action=alert
     from this dispatch AND the Discord post reported ok, or action=none with
     unhealthyCount>0 because the Supabase pg_cron pinger (every 5 min) got
     there first. Either way the message is in the watchdog channel. An
     action=alert whose Discord post FAILED (the route answers 502 and does not
     persist) is a FAIL, not a pass.
  4. start the services, wait 3 minutes for heartbeats
  5. dispatch watchdog, expect the RECOVERY edge to have been crossed:
     action=recover from this dispatch (post ok), or action=none with
     unhealthyCount=0 because a pinger already posted the all-clear.
  6. $( [ $NETCUT = 1 ] && echo "drop SFTP to $BOX_IP:$SFTP_PORT for 3 minutes, watch the poller journal, restore" || echo "(netcut not requested)" )
Re-run with --go to execute.
PLAN
  exit 0
fi
if [ "${players:-0}" != "0" ] && [ $FORCE != 1 ]; then say "players online; refusing without --force"; exit 3; fi
sudo -n true 2>/dev/null || { say "sudo -n is not available; cannot stop services"; exit 4; }

# Each phase reads the four fields dispatch() prints. `p3path` / `p5path` record
# WHICH way the phase passed, so the summary can say it out loud.
say "phase 0: baseline"
read -r a0 r0 u0 s0 n0 <<<"$(dispatch baseline)"
say "  baseline: action=$a0 reason=$r0 unhealthy=$u0 priorState=$s0 discord=$n0"
# THE BASELINE IS AN ASSERTION, NOT A PRINTOUT. It used to be captured and never
# compared, which let a drill started on an already-broken hall pass both edges
# with nothing posted: phase 3 would read the route's `none while unhealthy` as
# "a pinger already alerted" when the truth was "this was already broken before
# you got here". Checked BEFORE phase 1, so a refusal costs nothing: no service
# has been stopped and no firewall rule exists yet.
p0=$(baseline_clean "$a0" "$r0" "$u0" "$s0" "$n0")
if [ "$p0" != clean ]; then
  say "  baseline DIRTY — the hall is not quiet: expected action=none, unhealthy=0, priorState=ok."
  say "    unhealthy=$u0 says something is already failing (or the answer could not be read),"
  say "    priorState=$s0 says whether an alert is still standing from an earlier outage."
  say "    Fix the hall first (start the three units, let one pinger post the all-clear, wait"
  say "    for the alert row to go back to ok) and re-run. A drill from here proves nothing:"
  say "    'a pinger already alerted' and 'nothing new was posted at all' look the same."
  if [ $FORCE != 1 ]; then
    say "  refusing to continue. Nothing was stopped. --force runs it anyway."
    exit 5
  fi
  say "  --force given: continuing. The alert edge can now only pass via this drill's OWN"
  say "  dispatch (already-fired is refused on a dirty baseline)."
fi
say "phase 1: stopping ${UNITS[*]}"
sudo -n systemctl stop "${UNITS[@]}"; systemctl is-active "${UNITS[@]}" | tr '\n' ' ' | sed 's/^/  states: /' | tee -a "$LOG"; echo
say "phase 2: waiting ${WAIT_MIN} minutes for the silence threshold"
for ((m=5; m<=WAIT_MIN; m+=5)); do sleep 300; say "  +${m}m site players=$(status_ok) (site still answering without this PC)"; done
rem=$(( (WAIT_MIN % 5) * 60 )); [ $rem -gt 0 ] && sleep $rem
say "phase 3: dispatch, expecting the alert edge to have been crossed"
read -r a3 r3 u3 s3 n3 <<<"$(dispatch outage)"
say "  outage: action=$a3 reason=$r3 unhealthy=$u3 priorState=$s3 discord=$n3"
# PASS if this dispatch fired the alert AND the message reached Discord, or if
# the route is suppressing a repeat of an alert that is already out AND the hall
# is genuinely still unhealthy AND phase 0 found it quiet. `unhealthy` must be a
# number: a `?` means the response could not be read, and an unreadable response
# proves nothing.
p3path=$(alert_edge_taken "$a3" "$r3" "$u3" "$s3" "$n3" "$p0")
case "$p3path" in
  this-drill)      say "  phase 3 PASS — this dispatch fired the alert ($u3 unhealthy) and Discord accepted the post.";;
  already-fired)   say "  phase 3 PASS — the alert was ALREADY out when this dispatch ran ($u3 unhealthy, reason=$r3): the Supabase pg_cron pinger took the ok->alerting edge. The message is in the watchdog channel with ITS timestamp.";;
  fail-not-posted) say "  phase 3 FAIL — the route decided to ALERT and the Discord post did not go out (notified=$n3). The route answered 502 and did not persist the state, so the next ping will retry. The detection half works; the delivery half is broken. Check WATCHDOG_DISCORD_WEBHOOK / the channel, and the discord-error line above.";;
  fail-baseline)   say "  phase 3 FAIL — action=none with $u3 unhealthy is exactly what an ALREADY-BROKEN hall returns, and phase 0 said the baseline was dirty. Nothing here proves a message was posted during the drill.";;
  *)               say "  phase 3 FAIL — action=$a3 reason=$r3 unhealthy=$u3 discord=$n3: no alert edge was crossed.";;
esac
say "phase 4: starting services"
sudo -n systemctl start "${UNITS[@]}"; sleep 180; systemctl is-active "${UNITS[@]}" | tr '\n' ' ' | sed 's/^/  states: /' | tee -a "$LOG"; echo
say "phase 5: dispatch, expecting the recovery edge to have been crossed"
read -r a5 r5 u5 s5 n5 <<<"$(dispatch recovery)"
say "  recovery: action=$a5 reason=$r5 unhealthy=$u5 priorState=$s5 discord=$n5"
# PASS if this dispatch fired the recovery, or if everything is healthy again and
# phase 3 had established the outage first. The phase-3 gate is what makes the
# second case mean anything: action=none with nothing unhealthy is also what a
# drill that never took the services down would return, and that is not a pass.
# (A healthy run with priorState=alerting can only return `recover`, so
# action=none while healthy necessarily means somebody already cleared the row.)
p5path=$(recovery_edge_taken "$a5" "$r5" "$u5" "$s5" "$n5" "$p3path")
case "$p5path" in
  this-drill)      say "  phase 5 PASS — this dispatch fired the recovery and Discord accepted the post.";;
  already-fired)   say "  phase 5 PASS — the all-clear was ALREADY posted when this dispatch ran (0 unhealthy, reason=$r5, priorState=$s5): a pinger took the alerting->ok edge. The message is in the watchdog channel with ITS timestamp.";;
  fail-not-posted) say "  phase 5 FAIL — the route decided to RECOVER and the Discord post did not go out (notified=$n5). The hall is healthy again but nobody was told, and the alert row still says alerting.";;
  *)               say "  phase 5 FAIL — action=$a5 reason=$r5 unhealthy=$u5 discord=$n5: no recovery edge was crossed.";;
esac
if [ $NETCUT = 1 ]; then
  say "phase 6: dropping SFTP to $BOX_IP:$SFTP_PORT for 3 minutes"
  sudo -n iptables -I OUTPUT -d "$BOX_IP" -p tcp --dport "$SFTP_PORT" -j DROP && RULE_ON=1
  sleep 180
  sudo -n iptables -D OUTPUT -d "$BOX_IP" -p tcp --dport "$SFTP_PORT" -j DROP && RULE_ON=0
  say "  poller journal during the cut:"; journalctl -u eilif-log-poller.service --since "-4min" --no-pager -o cat | grep -iv "^$" | tail -8 | sed 's/^/    /' | tee -a "$LOG"
  sleep 60; say "  poller after restore: $(systemctl is-active eilif-log-poller.service), last lines:"; journalctl -u eilif-log-poller.service --since "-70s" --no-pager -o cat | tail -3 | sed 's/^/    /' | tee -a "$LOG"
fi
say "RESULT baseline=$a0/$r0 [$p0]  outage=$a3/$r3 unhealthy=$u3 discord=$n3 [$p3path]  recovery=$a5/$r5 unhealthy=$u5 discord=$n5 [$p5path]"
# Every failure verdict begins `fail`, so a new one added to the verdict block
# needs no change here.
if [ "${p3path#fail}" = "$p3path" ] && [ "${p5path#fail}" = "$p5path" ]; then
  say "DRILL PASS — alert edge via $p3path, recovery edge via $p5path"
  if [ "$p3path" = already-fired ] || [ "$p5path" = already-fired ]; then
    say "  (at least one edge was taken by the Supabase pg_cron pinger rather than by this drill."
    say "   That is a pass: the chain fired. Read the watchdog channel for the message text,"
    say "   and unschedule 'eilif-watchdog-ping' first if you want the drill to fire both edges itself.)"
  fi
else
  say "DRILL FAIL: see $LOG"
fi
