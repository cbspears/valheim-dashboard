#!/usr/bin/env bash
# Launch-day dress rehearsal, end to end, against a LOCAL stack only.
#
# What it rehearses, in the runbook's own order (docs/LAUNCH-WIPE.md):
#
#   0. cutover-env.sh, DRY RUN, and diff every line it plans against the real files
#   1. seed  — a stress run, so the wipe has an evening to wipe (skipped if the
#              database already holds one)
#   2. WIPE  — the announcer stopped FIRST (launch-day order, and launch-wipe
#              refuses --execute while one is writing to this database), then
#              scripts/launch-wipe.mjs --execute against the LOCAL url with the
#              three state files relocated to a scratch copy, then verify every
#              table, bucket, reset and state file it claimed, then the
#              announcer back up against the wiped database
#   3. DAY ONE — the first evening stage by stage, with the eight player-facing
#              pages read BETWEEN every stage rather than only at the end
#   4. verify — the day-one invariants, and the dry-run bot's recap
#
# It never touches production: every URL it uses must be loopback, launch-wipe is
# invoked with an explicit --supabase-url, and the state files it deletes are
# copies under $WORK, never the live services' own.
#
# Usage:
#   scripts/stress/rehearse-launch.sh                 # full rehearsal
#   scripts/stress/rehearse-launch.sh --skip-seed     # wipe an already-seeded db
#   scripts/stress/rehearse-launch.sh --no-wipe       # day one only
#
# Required in the environment (all LOCAL — see docs/STRESS-TEST.md):
#   BASE_URL                    site under test, e.g. http://localhost:3405
#   SUPABASE_URL                e.g. http://127.0.0.1:55321
#   SUPABASE_SERVICE_ROLE_KEY   that stack's service key
# Optional, but SITE_DIR only in the sense that the run tells you it is missing:
#   SITE_DIR   the built copy $BASE_URL is serving (the directory holding .next).
#              Since the 2026-09-05 perf pass, /world, /events, /gallery, /oath,
#              /map and /boss/[slug] are ISR pages with a 60 s window, and the whole
#              day-one section below runs in about twenty seconds — so without this
#              every one of them answers with the same build-time HTML at all six
#              checkpoints and page-check grades a render that never saw the evening.
#              With it, page-check forces a real regeneration per read. Without it,
#              those pages report STALE instead of PASS and the run fails, which is
#              the honest outcome: an inconclusive check must not look clean.
#   WORLD (default Eilif) · WORK (default $TMPDIR/eilif-rehearsal) · WEBHOOK_SECRET ·
#   GS_EMITTER_TOKEN · SEED_SIM_MINUTES (default 90) · SEED_TICK_MS (default 2000)

set -u
cd "$(dirname "$0")/../.."
REPO=$PWD

BASE_URL=${BASE_URL:-http://localhost:3405}
SUPABASE_URL=${SUPABASE_URL:-http://127.0.0.1:55321}
SERVICE_KEY=${SUPABASE_SERVICE_ROLE_KEY:-}
WORLD=${WORLD:-Eilif}
# NOT inside $REPO. The default used to be $REPO/.rehearsal, which is not in
# .gitignore, so a plain run dropped logs, page dumps and copies of the live
# services' state.json into the working tree four days before launch, where the
# next `git add -A` would sweep them into a commit.
WORK=${WORK:-${TMPDIR:-/tmp}/eilif-rehearsal}
SITE_DIR=${SITE_DIR:-}
WEBHOOK_SECRET=${WEBHOOK_SECRET:-stress-secret}
GS_EMITTER_TOKEN=${GS_EMITTER_TOKEN:-stress-emitter}
SEED_SIM_MINUTES=${SEED_SIM_MINUTES:-90}
SEED_TICK_MS=${SEED_TICK_MS:-2000}

SKIP_SEED=0; NO_WIPE=0
for a in "$@"; do
  case "$a" in
    --skip-seed) SKIP_SEED=1 ;;
    --no-wipe)   NO_WIPE=1 ;;
    *) echo "unknown flag: $a"; exit 2 ;;
  esac
done

# ── refusals, before anything runs ───────────────────────────────────────────
# Same rule as run.mjs: the HOSTNAME must be loopback, because
# "http://localhost.example.com" contains the substring and is not local.
host_of() { printf '%s' "$1" | sed -E 's#^[a-z]+://##; s#/.*##; s#:[0-9]+$##'; }
for u in "$BASE_URL" "$SUPABASE_URL"; do
  h=$(host_of "$u")
  case "$h" in
    localhost|127.0.0.1|::1|'[::1]'|0.0.0.0) ;;
    *) echo "Refusing to run: '$u' is not loopback. This rehearsal writes and DELETES."; exit 2 ;;
  esac
done
[ -n "$SERVICE_KEY" ] || { echo "SUPABASE_SERVICE_ROLE_KEY is required (the LOCAL one)."; exit 2; }

export NVM_DIR=${NVM_DIR:-$HOME/.config/nvm}
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 20 >/dev/null

mkdir -p "$WORK/pages" "$WORK/state/services/discord-bot" "$WORK/state/services/log-poller" "$WORK/state/scripts"
LOG=$WORK/rehearsal.log
: > "$LOG"
FAILURES=0

say()  { printf '\n\033[1m══ %s\033[0m\n' "$*" | tee -a "$LOG"; }
note() { printf '   %s\n' "$*" | tee -a "$LOG"; }
run()  { "$@" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }
step() { # step <label> <cmd...>
  local label=$1; shift
  if run "$@"; then note "OK   $label"; else FAILURES=$((FAILURES+1)); note "FAIL $label"; fi
}

curl_count() { # curl_count <table>  -> a number, or the empty string if unreadable
  curl -s -o /dev/null -D - "$SUPABASE_URL/rest/v1/$1?select=*&limit=1" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" -H 'Prefer: count=exact' \
    | tr -d '\r' | sed -n 's#^[Cc]ontent-[Rr]ange: .*/##p'
}

# curl_count prints NOTHING when the stack is down or the key is wrong, and ''
# is `!= "0"`, so an unreachable database used to read as an already-seeded one:
# the script announced "database already holds an evening (events= players=)",
# skipped the seed, and failed at the wipe several steps past the real cause.
require_count() { # require_count <table>  -> the number, or exit 2 with the reason
  local n; n=$(curl_count "$1")
  case "$n" in
    ''|*[!0-9]*)
      echo "Cannot read $SUPABASE_URL/rest/v1/$1 (got '${n:-no Content-Range}')." >&2
      echo "Is the stack up, and is SUPABASE_SERVICE_ROLE_KEY the key for THIS one?" >&2
      echo "  npx supabase@2.116.0 status   (in the project dir named in docs/STRESS-TEST.md)" >&2
      exit 2 ;;
  esac
  printf '%s' "$n"
}

# TOP LEVEL ONLY, and it is a count of entries, not of objects: the storage list
# API returns one folder pseudo-entry per prefix, so `map/frames-by-day/x.webp`
# shows up as the single entry `frames-by-day`. Everything this script uses the
# number for is an empty/non-empty decision, which is exact either way.
#
# It also used to be wrong a second way: the API answers on ONE line, so
# `grep -c '"name"'` returned 1 for a bucket holding three entries (measured:
# grep -c = 1, grep -o | wc -l = 3). The note it printed was a fabricated number.
bucket_top_count() { # bucket_top_count <bucket> -> entries at the TOP level
  curl -s -X POST "$SUPABASE_URL/storage/v1/object/list/$1" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H 'Content-Type: application/json' -d '{"prefix":"","limit":100}' \
    | grep -o '"name"' | wc -l | tr -d ' '
}

# The rehearsal's announcer, matched the way scripts/smoke/run.mjs matches it:
# by script path, then narrowed to the processes whose own environment names
# THIS database. A dry-run bot on another stack is somebody else's rehearsal,
# and the bracket trick alone does not make a pattern safe (it also stops
# matching this script's own command line, heredoc bodies included).
bots_on_this_db() {
  local pid
  for pid in $(pgrep -f 'scripts/stress/bot[-]dryrun.mjs' 2>/dev/null); do
    if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qxF "SUPABASE_URL=$SUPABASE_URL"; then
      printf '%s\n' "$pid"
    fi
  done
}

# THE ONE DESTRUCTIVE PATH A REHEARSAL NEVER PROVED (added 2026-09-06). The
# wipe recurses into the storage buckets and deletes the map frames and the
# gallery, and that is how the 2026-08-23 wipe went wrong: a leftover frame of
# the OLD world. But scripts/stress/run.mjs writes no objects, so on a fresh
# stack both buckets are already empty, the wipe prints "already empty", and the
# recursion into the folder pseudo-entries is never executed at all — a green
# rehearsal that says nothing about the code path it is supposed to be proving.
#
# So: if (and only if) both buckets are empty, plant the snapshotter's real
# layout first, nested prefixes included. The verification below already asserts
# both buckets end at zero, so seeding here turns that assertion into evidence.
#
# AND IT MUST CHECK ITS OWN WORK. The first version of this piped every upload
# through `curl -s -o /dev/null` with no status check and then announced
# "planted 7 objects" unconditionally — so pointed at a bucket that does not
# exist (an ordinary state right after a `supabase db reset` that did not
# re-create them) it printed the claim, returned 0 and planted nothing, the wipe
# then printed "already empty", and the verification's `objects = 0` passed
# vacuously. That is the same false green this seeding was added to remove, with
# a log line asserting the opposite.
SEEDED_BUCKETS=0
seed_buckets_for_the_wipe() {
  local n_map n_gal obj code ok=0 want=0
  n_map=$(bucket_top_count map); n_gal=$(bucket_top_count gallery)
  if [ "$n_map" != 0 ] || [ "$n_gal" != 0 ]; then
    note "buckets already hold objects (top-level entries: map=$n_map gallery=$n_gal) — not seeding, the wipe has real work"
    SEEDED_BUCKETS=1
    return 0
  fi
  for obj in \
    "map/current.webp" \
    "map/frames-by-day/day-0001.webp" \
    "map/frames-by-day/day-0064.webp" \
    "map/frames-fog/day-0064.png" \
    "map/frames-manifest.json" \
    "gallery/2026/07/rehearsal-photo.webp" \
    "gallery/2026/07/thumbs/rehearsal-photo.webp"
  do
    want=$((want+1))
    code=$(printf 'rehearsal placeholder, not an image\n' | curl -s -o /dev/null -w '%{http_code}' \
      -X POST "$SUPABASE_URL/storage/v1/object/${obj}" \
      -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
      -H 'Content-Type: application/octet-stream' --data-binary @-)
    case "$code" in
      2*) ok=$((ok+1)) ;;
      *)  note "  upload $obj -> HTTP $code" ;;
    esac
  done
  if [ "$ok" = "$want" ]; then
    SEEDED_BUCKETS=1
    note "planted $ok objects across map/ and gallery/ (current.webp, frames-by-day/, frames-fog/, frames-manifest.json, gallery/2026/07/ + thumbs/) so the wipe's storage recursion actually runs"
  else
    FAILURES=$((FAILURES+1))
    note "FAIL planted only $ok of $want storage objects — the wipe's storage recursion will NOT be exercised,"
    note "     and the 'bucket objects: 0' check below will pass on an empty bucket that was never filled."
    note "     Most likely the 'map' and 'gallery' buckets do not exist on this stack (a db reset drops them):"
    note "     re-create them, see docs/STRESS-TEST.md."
  fi
}

# Stop them the way launch day stops the real bot: FIRST, before the wipe, and
# by pid. Each one's environment and cwd are saved so the same process can be
# put back afterwards, because the day-one stages need an announcer running
# (titles seeding, deed announcements) and it must be reading a wiped database.
stop_local_bots() {
  local pid n=0
  rm -f "$WORK"/bot-*.environ "$WORK"/bot-*.cwd
  for pid in $(bots_on_this_db); do
    cp "/proc/$pid/environ" "$WORK/bot-$pid.environ" 2>/dev/null || continue
    readlink "/proc/$pid/cwd" > "$WORK/bot-$pid.cwd" 2>/dev/null || echo "$REPO" > "$WORK/bot-$pid.cwd"
    kill "$pid" 2>/dev/null && n=$((n+1))
  done
  [ "$n" = 0 ] && { note "no dry-run bot on this database (nothing to stop)"; return 0; }
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$(bots_on_this_db)" ] && break
    sleep 1
  done
  for pid in $(bots_on_this_db); do kill -9 "$pid" 2>/dev/null; done
  note "stopped $n dry-run bot(s) on this database (launch-day order: announcer first)"
}

start_local_bots() {
  local f pid n=0
  for f in "$WORK"/bot-*.environ; do
    [ -e "$f" ] || continue
    pid=${f##*/bot-}; pid=${pid%.environ}
    (
      while IFS= read -r -d '' kv; do
        case "$kv" in
          [A-Za-z_]*=*) export "${kv%%=*}=${kv#*=}" ;;
        esac
      done < "$f"
      cd "$(cat "$WORK/bot-$pid.cwd" 2>/dev/null || echo "$REPO")" || exit 1
      exec node scripts/stress/bot-dryrun.mjs
    ) >> "$WORK/bot-dryrun.log" 2>&1 &
    n=$((n+1))
    rm -f "$f" "$WORK/bot-$pid.cwd"
  done
  [ "$n" = 0 ] && return 0
  note "restarted $n dry-run bot(s) against the wiped database (log: $WORK/bot-dryrun.log)"
  sleep 3
}

export BASE_URL SUPABASE_URL WEBHOOK_SECRET GS_EMITTER_TOKEN
export SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
export GS_EXPECTED_WORLD=$WORLD
export DAY_ONE_STATE=$WORK/day-one-state.json

# WHAT CODE DID THIS RUN ACTUALLY REHEARSE. The site under test is a built copy
# pinned at whatever was on disk when it was built, but bot-dryrun.mjs imports
# services/discord-bot/src/* out of THIS working tree, live, so the bot half runs
# whatever is uncommitted at this instant. Three runs on 2026-09-06 each
# rehearsed a slightly different bot and none of them was reproducible from a
# commit, because nothing wrote that down. Now it does.
say "log of record"
note "HEAD: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo 'not a git tree')  $(git -C "$REPO" log -1 --format=%s 2>/dev/null | cut -c1-72)"
dirty=$(git -C "$REPO" status --porcelain -- services/ scripts/stress/ 2>/dev/null)
if [ -n "$dirty" ]; then
  note "WORKING TREE IS DIRTY — this run is not reproducible from a commit:"
  printf '%s\n' "$dirty" | sed 's/^/      /' | tee -a "$LOG"
  note "  (the bot half imports services/discord-bot/src/* from the tree, not from the built site copy)"
else
  note "working tree clean under services/ and scripts/stress/"
fi

say "0 · cutover-env.sh $WORLD (DRY RUN — never --apply from here)"
run bash scripts/cutover-env.sh "$WORLD"
note "compare each line above against the real files:"
for f in services/discord-bot/.env services/log-poller/.env; do
  if [ -r "$f" ]; then
    note "  $f"
    grep -nE '^(RECAPS_START|[A-Z]+_CHANNEL|MAP_REMOTE_DIR|LOG_PATH)=' "$f" | sed 's/^/      /' | tee -a "$LOG"
  else
    note "  $f  (absent — nothing to compare)"
  fi
done
note "  unit override (the line cutover-env removes with sudo -n):"
grep -n '^Environment=RECAPS_START=' /etc/systemd/system/eilif-discord-bot.service 2>/dev/null | sed 's/^/      /' | tee -a "$LOG" \
  || note "      none found (already removed, or the unit is not installed here)"

say "1 · seed"
if [ "$SKIP_SEED" = 1 ]; then
  note "skipped (--skip-seed)"
else
  # An unreadable count must stop the run here, not be read as "already seeded".
  seed_events=$(require_count events) || exit 2
  seed_players=$(require_count players) || exit 2
  if [ "$seed_events" != "0" ] || [ "$seed_players" != "0" ]; then
    note "database already holds an evening (events=$seed_events, players=$seed_players) — not re-seeding"
  else
    note "empty database: replaying $SEED_SIM_MINUTES simulated minutes at ${SEED_TICK_MS}ms"
    SIM_MINUTES=$SEED_SIM_MINUTES TICK_MS=$SEED_TICK_MS SETTLE_MS=30000 \
      OUT=$WORK/seed-results.json run node scripts/stress/run.mjs
    note "seed run exit $? (invariant failures here are the stress test's business, not the wipe's)"
  fi
fi

if [ "$NO_WIPE" = 0 ]; then
  say "2 · WIPE"
  # The three state files belong to the LIVE services: copy them, and never
  # point launch-wipe at the repo root while rehearsing. Which of the three
  # exist RIGHT NOW is written down before the wipe, because the check
  # afterwards is that each of THOSE is still there.
  # scripts/.map-snapshot-state.json is gitignored and legitimately absent on a
  # fresh checkout, so "the file is missing afterwards" only means something for
  # the ones that were there to begin with.
  : > "$WORK/state/.staged"
  for pair in "services/discord-bot/state.json" "services/log-poller/state.json" "scripts/.map-snapshot-state.json"; do
    if [ -f "$REPO/$pair" ]; then
      cp "$REPO/$pair" "$WORK/state/$pair"
      printf '%s\n' "$pair" >> "$WORK/state/.staged"
    fi
  done
  note "state files staged under $WORK/state ($(wc -l < "$WORK/state/.staged" | tr -d ' ') of 3 present; the live ones are never touched)"

  # Launch-day order, rehearsed rather than assumed: the announcer stops FIRST.
  # launch-wipe refuses --execute while one is up on this database, and a wipe
  # verified with a writer still running is the flakiness this stack was
  # isolated to avoid.
  #
  # If the rehearsal dies between the stop and the restart (a failed wipe, a
  # Ctrl-C), the announcer must still come back: start_local_bots deletes each
  # saved environment as it uses it, so after the normal restart below this trap
  # has nothing left to do.
  trap 'start_local_bots' EXIT
  stop_local_bots
  seed_buckets_for_the_wipe

  before_events=$(require_count events) || exit 2
  before_players=$(require_count players) || exit 2
  note "before: events=$before_events players=$before_players sessions=$(curl_count sessions)"

  echo WIPE | run node scripts/launch-wipe.mjs --execute \
    --supabase-url "$SUPABASE_URL" --service-key "$SERVICE_KEY" --state-dir "$WORK/state"

  say "2b · verify the wipe's claims"
  bad=0
  for t in title_history players sessions events chat_lines oaths pins gallery_photos \
           player_stats voice_lines poty_history identity_claims player_positions roadmap; do
    n=$(curl_count "$t")
    printf '   %-18s %s\n' "$t" "$n" | tee -a "$LOG"
    [ "$n" = "0" ] || { bad=1; note "   ^^ NOT EMPTY"; }
  done
  ach=$(curl -s "$SUPABASE_URL/rest/v1/milestones?select=id&achieved_at=not.is.null" -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" | grep -c '"id"')
  kil=$(curl -s "$SUPABASE_URL/rest/v1/bosses?select=name&is_killed=is.true" -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" | grep -c '"name"')
  sst=$(curl -s "$SUPABASE_URL/rest/v1/server_status?select=world_day,player_count,is_online" -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY")
  note "milestones still achieved: $ach (want 0)"; [ "$ach" = 0 ] || bad=1
  note "bosses still killed:       $kil (want 0)"; [ "$kil" = 0 ] || bad=1
  # NOT just the kill flag. A boss the previous world FOUGHT and never killed
  # keeps players_present and fight_stats, and gs-ingest's folds are grow-only
  # unions, so the next kill inherits that war party. The wipe used to reset
  # only is_killed=true rows and this is the check that would have caught it.
  res=$(curl -s "$SUPABASE_URL/rest/v1/bosses?select=name,players_present,fight_stats" -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    | python3 -c "
import sys,json
try: rows=json.load(sys.stdin)
except Exception: print('unreadable'); raise SystemExit
print(','.join(b['name'] for b in rows if (b.get('players_present') or []) or b.get('fight_stats')) or 'none')")
  note "bosses still carrying a war party or fight stats: $res (want none)"
  [ "$res" = "none" ] || bad=1
  note "server_status:             $sst"
  case "$sst" in *'"world_day":0'*'"player_count":0'*'"is_online":false'*) ;; *) bad=1; note "   ^^ NOT RESET" ;; esac
  for b in map gallery; do
    n=$(bucket_top_count "$b")
    note "bucket $b top-level entries: $n (want 0)"; [ "$n" = 0 ] || bad=1
    # AND THE ZERO HAS TO MEAN SOMETHING. An empty bucket that was never filled
    # reads identically to one the wipe emptied, so when the seeding above did
    # its job, the wipe's own summary must show it deleting objects out of this
    # bucket. Without this the whole storage half of the verification can pass
    # while the recursion never ran — which is what it did until 2026-09-06.
    if [ "$SEEDED_BUCKETS" = 1 ]; then
      if grep -qE "^ +$b +deleted [1-9][0-9]* object" "$LOG"; then
        note "  ^ and the wipe reported deleting objects from $b, so the recursion really ran"
      else
        bad=1
        note "  ^^ VACUOUS: $b was seeded but the wipe never reported deleting anything from it"
      fi
    fi
  done
  for pair in "services/discord-bot/state.json" "services/log-poller/state.json" "scripts/.map-snapshot-state.json"; do
    if [ -f "$WORK/state/$pair" ]; then bad=1; note "state file NOT deleted: $WORK/state/$pair"; fi
  done
  # THE ONE THAT JUSTIFIES --state-dir. Every file that existed before the wipe
  # must still exist after it. (This used to be guarded on a `.orig` file that
  # nothing ever wrote, so the check could never fire — the same shape of bug as
  # the reset loop launch-wipe's own comment records as having silently never
  # run once.)
  while IFS= read -r pair; do
    [ -n "$pair" ] || continue
    if [ -f "$REPO/$pair" ]; then
      note "live state file intact: $pair"
    else
      bad=1; note "LIVE state file went missing: $REPO/$pair"
    fi
  done < "$WORK/state/.staged"
  if [ "$bad" = 0 ]; then note "OK   every table, bucket, reset and state file matches the wipe's summary"
  else FAILURES=$((FAILURES+1)); note "FAIL the wipe's summary and the database disagree"; fi

  # Only now, with the wipe verified against a database nobody was writing to,
  # does the announcer come back — reading the wiped state, the way it does on
  # launch night.
  start_local_bots
  trap - EXIT

  step "post-wipe pages" node scripts/stress/page-check.mjs --base "$BASE_URL" \
    ${SITE_DIR:+--site-dir "$SITE_DIR"} \
    --label 1-postwipe --dump "$WORK/pages" --stale 'Astrid,Bjorn,Þóra,Ulf,Sigrid,Magnus'
fi

say "3 · DAY ONE on world '$WORLD'"
STALE='Astrid,Bjorn,Þóra,Ulf,Sigrid,Magnus'
# /viking/<slug> only exists once somebody has joined, so it joins the read from
# the first-join stage onward and never at the post-wipe checkpoint (where the
# roster is empty by design and a 404 would be a false failure). It is the page
# with the most generated copy on the whole site and nothing was reading it.
for s in boot first-join day1 day2 day3 close; do
  step "stage $s" node scripts/stress/day-one.mjs --stage "$s" --world "$WORLD"
  sleep 2
  ALSO=''
  [ "$s" = boot ] || ALSO='--also /viking/alvis'
  # shellcheck disable=SC2086
  step "pages after $s" node scripts/stress/page-check.mjs --base "$BASE_URL" \
    ${SITE_DIR:+--site-dir "$SITE_DIR"} $ALSO \
    --label "2-$s" --dump "$WORK/pages" --stale "$STALE"
done

say "4 · day-one invariants"
# --bot-log is what makes the LAST invariant possible: every other check reads
# the database, and that is how the 2026-09-06 runs graded clean while the relay
# had silently stopped 21 rows into a 43-row evening. verify() compares what the
# announcer POSTED against what the rows say.
step "verify" node scripts/stress/day-one.mjs --stage verify --world "$WORLD" \
  --bot-log "$WORK/bot-dryrun.log"

say "result"
note "page text for reading by hand: $WORK/pages/*.txt"
note "full log: $LOG"
if [ "$FAILURES" = 0 ]; then
  note "rehearsal clean"
else
  note "$FAILURES step(s) failed — read the log"
fi
exit $((FAILURES > 0))
