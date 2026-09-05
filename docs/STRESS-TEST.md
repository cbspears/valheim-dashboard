# Local-stack stress test

Twenty vikings, six simulated hours, compressed into roughly twelve real minutes,
run end to end against a throwaway Supabase and a local `next start`. It exists
because the pipeline has never seen more than three concurrent players and launch
is fifteen to twenty at once.

Nothing in here touches production. The harness refuses to start unless both
`BASE_URL` and `SUPABASE_URL` are loopback **and** the site at `BASE_URL` proves
it is reading the database at `SUPABASE_URL` (see the preflight below — a
localhost URL is not on its own evidence of a local database). The dry-run bot
refuses to start if `DISCORD_TOKEN` is set.

- `scripts/stress/run.mjs` — the load generator and the invariant checker.
- `scripts/stress/bot-dryrun.mjs` — a long-running Discord bot with no Discord.
- `scripts/stress/ratelimit-probe.mjs` — measures the real per-IP request budget.

---

## What it simulates

| Producer | Stands in for | Cadence in the run |
|---|---|---|
| `POST /api/webhook` | the SFTP log poller | joins, leaves, positions every simulated minute, chat, oaths, pins, a roster sync every ten minutes |
| `POST /api/gs-ingest` `source:client` | GsValheimStatsClient's cumulative snapshot | every two simulated minutes, per player |
| `POST /api/gs-ingest` `source:eilif-death` | EilifCompanionClient's death report | fired **concurrently** with the gs report for the same death, 0 to 10 ms apart |
| `POST /api/gs-ingest` `source:client-map` | the cartography post | every five simulated minutes, per player |
| `POST /api/gs-ingest` `source:server` | the Emitter | every two simulated minutes, with the roster, the world day and the milestone keys |

The roster is nineteen ASCII names plus `Þóra`, so the identity paths get an
argument they cannot fold with `toLowerCase()` alone. Half the roster arrives
with a lifetime career already on the character file, which is what the world
baseline in `lib/gs-baseline.ts` exists to neutralise.

Scripted moments, all scaled to the run length so a short run still covers them:

- **Minute 0** — all twenty join at once. The launch-night burst.
- **Oaths** in the first hour, **pins** through the evening.
- **A boss fight** at 55 % of the run: eight vikings hit Eikthyr over five
  minutes, with one client owning the ZDO and reporting the other seven as
  bystanders, then the Emitter's `defeated_eikthyr` milestone lands **with a full
  MVP summary**. `planBossKillUpdate` writes that summary's verdict verbatim, so
  reading it back proves the merge kept it — and nothing more.
- **A second boss at 72 %, and nobody files a fight record for it.** Five vikings
  hit `gd_king`, the ZDO owner reports the other four as bystanders, and the only
  thing that ever fells The Elder is the Emitter's `defeated_gdking` key: no
  `bossKillEvents` entry from any producer, so no fighters, no first blood and no
  top damage. That is the 2026-08-28 Eikthyr incident replayed exactly, and it is
  the only shape in which the war party and the top-damage verdict can have come
  from nowhere but `lib/boss-damage.ts`'s client-damage fold.
- **Four corpse runs** — a second death sixty seconds after the first, well
  inside the plus or minus three minute collapse window. Both must survive.
- **Four relogs** at two-thirds through.
- **An impostor** at 83 %: a second join under an existing name with a different
  SteamID. It must be flagged and must not rebind.
- **Closing time** — everyone leaves at once, then a final roster sync.

---

## Reproduce it

### 1. The local Supabase stack

```bash
export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
mkdir -p /tmp/eilif-stress && cd /tmp/eilif-stress
npx supabase@2.116.0 init
```

Copy the repo's schema in, timestamp-prefixed in **date order**, skipping
`db/2026-08-24_loa_zero_baseline.sql` (never applied) and `db/demo-archive/`:

```bash
R=~/Projects/valheim-dashboard
M=/tmp/eilif-stress/supabase/migrations
mkdir -p $M
cp $R/db/0000_initial_schema.sql $M/20260624000000_initial_schema.sql
# then every db/<date>_<slug>.sql as 2026MMDD0000NN_<slug>.sql, NN counting up
# within a day, in the order the dates give.
```

**One file has to move.** `db/2026-07-04_gallery_pin_link.sql` adds a foreign key
to `public.pins`, which `db/2026-07-04_pins.sql` creates — and the second file
sorts after the first. Apply `pins` first or the rebuild stops with
`relation "public.pins" does not exist (SQLSTATE 42P01)`. Nothing in the repo
records that ordering, because production was hand-applied in the working order.

```bash
cd /tmp/eilif-stress && npx supabase@2.116.0 start
```

Note the API URL, the anon key and the service role key it prints. They are the
standard local demo keys and are local-only. Then create the two public buckets
the site expects (a `db reset` drops `map`, so re-create it after every reset):

```bash
for b in gallery map; do
  curl -s -X POST "http://127.0.0.1:54321/storage/v1/bucket" \
    -H "Authorization: Bearer $LOCAL_SERVICE_KEY" -H "apikey: $LOCAL_SERVICE_KEY" \
    -H 'content-type: application/json' -d "{\"id\":\"$b\",\"name\":\"$b\",\"public\":true}"
done
```

### 2. The site

**`next start` alone cannot be pointed at another database.** `NEXT_PUBLIC_*` is
inlined at build time, so a production `.next` carries the production Supabase
URL as a string literal inside the compiled route handlers — exporting
`NEXT_PUBLIC_SUPABASE_URL` before `next start` changes nothing, and the running
server keeps writing where it was built to write. Verify before trusting any
local run:

```bash
grep -rl "<prod-supabase-ref>" .next/server | head
```

Two ways out. Either rebuild with the local values in the environment, or — to
test the exact bytes that are in production — copy the tree to scratch and
repoint the copy:

**Exclude the service `.env` files.** `services/discord-bot/.env`,
`services/log-poller/.env` and `services/stats-parser/.env` hold the live Discord
bot token, the production service-role key and the GTX box's SFTP credentials.
They are gitignored, so `tar` takes them unless told not to, and the copy is
world-readable inside the scratch tree. Nothing in the local run needs them.

```bash
S=/tmp/eilif-stress
tar cf - --exclude=node_modules --exclude=.git --exclude='.next/cache' \
  --exclude='.next/dev' --exclude='.env' --exclude='services/*/.env' \
  --exclude='.vercel' -C ~/Projects/valheim-dashboard . | (mkdir -p $S/site && cd $S/site && tar xf -)
ln -s ~/Projects/valheim-dashboard/node_modules $S/site/node_modules
# replace the inlined prod URL and anon key inside $S/site/.next with the local ones,
# and write a local-only $S/site/.env.local
grep -rl "<prod-supabase-ref>" $S/site/.next | wc -l   # must print 0
find $S/site -name '.env' -not -path '*/node_modules/*' | wc -l   # must print 0
```

Then run it:

```bash
cd $S/site
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
export NEXT_PUBLIC_SUPABASE_ANON_KEY=<local anon>
export SUPABASE_SERVICE_ROLE_KEY=<local service>
export WEBHOOK_SECRET=stress-secret GS_EMITTER_TOKEN=stress-emitter
export VOICE_API_TOKEN=stress-voice BOARDS_TOKEN=stress-boards
export OPS_HEARTBEAT_TOKEN=stress-hb OPS_PASSWORD=stress TV_ACCESS_KEY=stress
export GS_EXPECTED_WORLD=StressWorld
./node_modules/.bin/next start -p 3400 > /tmp/eilif-stress/next.log 2>&1 &
curl -s http://localhost:3400/api/status
```

That last call must answer from the **empty** local database:
`{"online":false,"players":0,"maxPlayers":15,"worldDay":0,...}`. If it reports a
world day or players you recognise, the build is still pointed at production.
Stop and fix it before going further.

### 3. The dry-run bot

`npm run dry-run` in `services/discord-bot` is a **one-shot**: one relay tick,
one boss tick, one recap, then `process.exit(0)`. It never builds the milestone
announcer, the title announcer or the voice engine, so it cannot exercise the
loops this test is about and cannot stay up alongside a load run.
`scripts/stress/bot-dryrun.mjs` imports the same modules out of
`services/discord-bot/src`, wires them to the dry-run poster and runs them on a
loop:

```bash
cd ~/Projects/valheim-dashboard
unset DISCORD_TOKEN
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_ANON_KEY=<local anon> SUPABASE_SERVICE_ROLE_KEY=<local service> \
WEBHOOK_URL=http://localhost:3400/api/webhook WEBHOOK_SECRET=stress-secret \
VOICE_ENGINE=1 EVENTS_SYNC=0 GALLERY_INGEST=0 \
TITLES_API=http://localhost:3400/api/titles TZ=America/Chicago \
node scripts/stress/bot-dryrun.mjs > /tmp/eilif-stress/bot.log 2>&1 &
```

Everything it would have said to Discord is printed as `[dry-run → #channel]`.

#### The bot's clock, and why it decides what the rehearsal means

The bot's loop intervals and its two anti-spam gaps are **derived**, not typed:
each is the production value divided by `BOT_COMPRESSION` (default 30, which is
`60000 / TICK_MS`). Both are printed at startup next to their production
counterpart, so no number this bot produces can be read without knowing the
configuration that produced it.

| Knob | Production | Effective at the default 30x | What it gates |
|---|---|---|---|
| `RELAY_MS` | 15,000 | 500 | the #server feed |
| `BOSS_MS` | 30,000 | 1,000 | boss-kill announcements |
| `MILESTONES_MS` | 120,000 | 4,000 | one Great Deed per tick |
| `TITLES_MS` | 600,000 | 20,000 | title changes |
| `VOICE_MS` | 60,000 | 2,000 | the voice queue |
| `VOICE_EXPIRE_MS` | 300,000 | 10,000 | expiring stale queued lines |
| `MILESTONE_MIN_GAP_MS` | 60,000 | 2,000 | quiet between deeds |
| `VOICE_MIN_GAP_MS` | 1,800,000 | 60,000 | quiet between **ambient** lines only |

This matters because it is easy to get wrong in both directions, and both were
gotten wrong here first. Passing `MILESTONE_MIN_GAP_MS=0` switches the deed gap
**off** — `services/discord-bot/src/milestones.js:154` accepts 0 rather than
falling back to its own 60 s default — and the bot then announces a burst that
production would have spaced out; the "21 deeds, 21 announcements, no
duplicates" result is worthless under it. Leaving the gaps at literal production
values against a 30x clock is wrong the other way: 21 deeds at one per 120 s
tick is **about 42 minutes of trickle**, and a thirteen-minute run ends long
before the queue drains.

`BOT_COMPRESSION=1` gives literal production values for a real-time rehearsal.
Setting any knob explicitly overrides it and is printed as `ENV OVERRIDE`.

### 4. The run

```bash
cd ~/Projects/valheim-dashboard
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local service> \
BASE_URL=http://localhost:3400 WEBHOOK_SECRET=stress-secret \
GS_EMITTER_TOKEN=stress-emitter GS_EXPECTED_WORLD=StressWorld \
SIM_MINUTES=360 TICK_MS=2000 SETTLE_MS=60000 OUT=/tmp/eilif-stress/results.json \
node scripts/stress/run.mjs
```

It prints a latency table, waits `SETTLE_MS` for the bot's loops to catch up,
prints the invariant table, writes `results.json` and exits non-zero if any
invariant failed.

| Variable | Default | What it does |
|---|---|---|
| `SIM_MINUTES` | 360 | simulated minutes to replay |
| `TICK_MS` | 2000 | real milliseconds per simulated minute |
| `PLAYERS` | 20 | roster size, capped at the 20 names |
| `SEED` | 20260909 | deterministic RNG, so a failure reproduces |
| `SETTLE_MS` | 45000 | how long to let the bot's loops run before checking |
| `POLLER_SHARDS` | 16 | see below |
| `OUT` | `/tmp/stress-results.json` | machine-readable results |
| `EXPECTED_IN` | the value of `OUT` | `--verify-only` only: the results file to rehydrate expectations from |

`--verify-only` re-runs the invariant checks against whatever is already in the
database without generating any load.

**Fourteen of them need the run's own expectations** — how many deaths were
real, who fought each boss, which viking the impostor impersonated, what each
viking's zero-point was — and the flag skips the
simulation that produces those. So it reads them back from the `results.json` a
full run wrote (`OUT`, or `EXPECTED_IN` to point somewhere else) and rehydrates
them, including each viking's zero-point and last accepted snapshot. If it cannot
find that file, those checks print **`SKIP`, never `PASS` and never `FAIL`** —
a check that compared nothing must not read as evidence, and it must not accuse
production of a defect the harness invented:

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local service> \
BASE_URL=http://localhost:3400 EXPECTED_IN=/tmp/eilif-stress/results.json \
node scripts/stress/run.mjs --verify-only
```

### The preflight, which runs before anything is written

Both `BASE_URL` and `SUPABASE_URL` must be **loopback hostnames** (a substring
test passes `http://localhost.example.com`), and then the harness proves the two
belong together: it stamps a random sentinel world day straight into the local
`server_status` row and requires `GET $BASE_URL/api/status` to read it back,
restoring the old value either way. A `next start` serving a production `.next`
on a localhost port cannot echo a number that only exists locally, so the trap in
§2 becomes a refusal rather than 12,000 rows in production.

### A caveat you must read before believing the 429 column

`lib/rate-limit.ts` counts against the **wall clock**: 60 requests per 60 real
seconds per IP, keyed on the first `x-forwarded-for` hop. The harness replays a
simulated minute every two real seconds, so the poller's roughly twenty-one posts
per simulated minute arrive as roughly 630 per real minute. In a first
uncorrected run that emptied the bucket immediately and 2,232 of 2,305 position
posts came back 429, drowning every other measurement.

`POLLER_SHARDS` spreads the poller's traffic over sixteen addresses so the
per-real-minute rate matches what the real poller produces, and the run measures
the pipeline instead of the limiter. **Production has exactly one poller
address.** To measure that budget honestly, use the probe:

```bash
BASE_URL=http://localhost:3400 WEBHOOK_SECRET=stress-secret \
  node scripts/stress/ratelimit-probe.mjs
```

`PROBE_IP` is the address phases 1 and 2 use; `PROBE_IP_BATCH` is the separate
one phase 3 replays the catch-up batch from, so that phase always starts on a
full bucket. Give phase 3 a fresh address when re-running inside a minute, or its
first tick under-reports.

---

## The invariants

Each is asserted through the local PostgREST API after the run and printed as a
row in the invariant table.

| Invariant | Why it matters |
|---|---|
| exactly one `events` row per real death | the gs and eilif reports race on every death; `db/2026-09-04_ingest_death.sql` is what stops the twin |
| no two death rows for one viking under two seconds apart | the twin's signature |
| every death row carries `causeSource='eilif'` | the authoritative cause survived the race |
| corpse-run doubles both kept | the plus or minus three minute window must not collapse two real deaths |
| every session closed, with a plausible duration | an unclosed session inflates playtime forever |
| session count equals the joins | the join replay guard neither dropped nor duplicated |
| `players.steam_id` bound, and equal to the first account seen | first sight binds and nothing overwrites it |
| the impostor join is flagged and does **not** rebind | a second join under an existing name with a different SteamID |
| `player_stats` equals the last accepted snapshot minus the zero-point, **for every viking** | the world baseline credited exactly what was earned here; a viking whose snapshots were all refused is reported as NOT COMPARED, never as passed |
| the harness's own death schedule collided with nothing | two harness deaths on one `name\|tsUtc` key are correctly ONE row; without this check that reads as a production defect |
| Eikthyr `is_killed`, fighters equal the eight attackers | the war party is the truth, not the online roster |
| Eikthyr per-fighter damage attributed correctly | a right total can still credit every blow to the wrong viking |
| Eikthyr MVP summary written verbatim | an **echo** of what the harness sent — a server fight record owns the verdict by design, so this proves the merge, not the fold |
| Eikthyr damage total not double counted | own-entry and observed damage must stay disjoint |
| The Elder felled by the milestone alone, war party and per-fighter damage from the fold | the 2026-08-28 shape: nothing reported fighters, so an empty list is the failure |
| The Elder top damage computed by the fold, `topDamageFrom = gs-client-damage` | the one verdict in the run that is not an echo, and the milestone flip has to preserve it |
| exactly one boss event row | the milestone flip is guarded |
| at least one Great Deed crossed, one saga row per deed | `achieved_at` is set once |
| titles unique across the roster **and everyone has one** | uniqueness alone passes when nobody is titled at all |
| `server_status.player_count` matches, nobody left marked online | |
| voice lines queued | the in-game voice actually has something to say |
| chat mirrored, positions one row per viking, oaths matched | |
| no 5xx anywhere | |

---

## Measured baseline, 2026-09-05

Twenty vikings, 360 simulated minutes at 2 s each, against the production `.next`
build of `53553ff` repointed at a local stack, with the dry-run bot running the
whole time at `BOT_COMPRESSION=30`. 12,764 requests in 12 real minutes, **no 5xx,
no non-2xx of any kind, and no retries**.

| Endpoint | n | p50 | p95 | max |
|---|---|---|---|---|
| `POST /api/gs-ingest` client | 3,572 | 99 | 132 | 229 |
| `POST /api/gs-ingest` client-map | 1,418 | 131 | 190 | 771 |
| `POST /api/gs-ingest` server | 183 | 117 | 138 | 209 |
| `POST /api/gs-ingest` eilif-death | 38 | 27 | 167 | 171 |
| `POST /api/webhook` pos | 7,088 | 20 | 34 | 241 |
| `POST /api/webhook` sync | 38 | 185 | 761 | 776 |
| `POST /api/webhook` join | 24 | 80 | 117 | 125 |
| `POST /api/webhook` leave | 24 | 60 | 131 | 178 |
| `POST /api/webhook` chat | 355 | 24 | 37 | 241 |
| `POST /api/webhook` oath | 20 | 32 | 41 | 43 |

Milliseconds, local Postgres on the same machine, so treat these as relative
costs rather than as Vercel-to-Supabase numbers.

What the evening produced: 110 `events` rows (38 deaths, 25 joins, 24 leaves, 21
deeds, 2 bosses), 25 sessions, 20 `players` and 20 `player_stats` rows, 355 chat
lines, 20 positions, 20 oaths, 49 queued voice lines, and 21 Great Deeds achieved
and announced exactly once each.

**Thirty of thirty-two invariants passed. The two failures are one defect:** the
impostor join opened a second session for `Ulf` and left his real one open
forever. The morning recap rendered from that database reads `Ulf 7.2h` against
everyone else's `5.9h` and `Hours logged: 119.4h`, while `/players` credits him
the 56-minute impostor session instead of his real 355 minutes. See the finding
on `app/api/webhook/route.ts` §5.

The two things the boss scenarios settle, which is why there are two of them:

- **Eikthyr**, felled with a full MVP summary: fighters exactly the eight who
  swung (not the roster), each of the eight credited exactly their own blows, and
  the total 2,942 against an expected 2,942 — own-entry and observed damage stayed
  disjoint through 3,572 client posts.
- **The Elder**, felled by `defeated_gdking` with no fight record at all: war
  party `[Magnus, Njal, Orm, Sigrid, Torvald]`, top damage `Sigrid 352`,
  `topDamageFrom = gs-client-damage`, and every fighter credited exactly their own
  blows. Nothing in that row was echoed from anything the harness sent, and it is
  the 2026-08-28 shape end to end.

**The deed announcer at the production ratio.** All 21 deeds announced, none left
queued. The shortest gap between two announcements was 4.0 s — exactly one
`MILESTONES_MS` tick, never the 2.0 s minimum gap — with five back-to-back pairs,
so bursts really were spaced one deed per tick. The worst wait between a deed
being earned and announced was 14.2 s. Multiply by the 30x clock for production:
back-to-back deeds land **120 s apart** and the worst deed waits about **seven
minutes**. Note what that number is worth only because the gaps were derived: run
this with `MILESTONE_MIN_GAP_MS=0` and the same 21 deeds come out as an
undifferentiated burst that production would never produce.

Per-producer webhook load, which is the number that matters for the rate limit:
7,573 webhook posts over 360 simulated minutes is **21 requests per minute from
the single poller address**, against a budget the probe measured at exactly 60
per 60 s (first 429 on request #61; 59 of 60 accepted at a sustained 1/s).
Roughly a third of the budget in steady state, with no headroom for a catch-up
batch.

The probe's third phase shows what "no headroom" costs. A 75-event batch — about
three minutes of a twenty-player evening — replayed from a clean address with the
poller's own semantics (`poller.js:237` throws on any non-2xx, `tick()` restores
the byte cursor and rethrows) never drains:

```
tick 1: delivered 60/75, refused at #61 — poller rewinds and re-reads the SAME batch
tick 2: delivered 20/75, refused at #21
tick 3: delivered 20/75, refused at #21
tick 4: delivered 20/75, refused at #21
tick 5: delivered 20/75, refused at #21
```

Twenty per twenty-second tick is exactly the bucket's refill rate, and the batch
grows by another twenty-one events every minute it is stalled. Joins, leaves,
deaths, chat and the roster sync all stop, and a restart does not help because
the offset is in `state.json`. Measured against a single local server, which is
the worst case — on Vercel each warm instance has its own bucket.

---

## Stop everything

```bash
pkill -f "stress/bot[-]dryrun.mjs"     # the brackets stop pkill matching its OWN
pkill -f "next start -p 3400"          # command line and killing your shell
fuser -k 3400/tcp 2>/dev/null || true
cd /tmp/eilif-stress && npx supabase@2.116.0 stop
rm -rf /tmp/eilif-stress/site          # the repo copy: build output and config
```

The bracket in the first pattern is not decoration. `pkill -f bot-dryrun.mjs`
run from an interactive shell matches the shell's own command line and kills the
terminal along with the bot.

`npx supabase@2.116.0 stop --no-backup` also discards the database volume. To
start a fresh run without tearing the stack down, `npx supabase@2.116.0 db reset`
re-applies every migration — then re-create the `map` bucket, which the reset
drops.
