# Launch wipe — clearing the pilot data before 1.0 launch

`scripts/launch-wipe.mjs` clears the pilot/rehearsal test-world data out of prod
Supabase (project `syuwavxpmtdmxupxjzje`) so the dashboard starts clean on the
real launch world (2026-09-09). Full detail and rationale are in the script's
header comment — this is the short "when / in what order" runbook.

Last refreshed **2026-09-05** for the posture decision below (earlier pass:
2026-09-04, from the T−6 launch audit: findings launch-8, discord-1, launch-16,
launch-17, gtx-7, mods-6). The cutover step table with owners lives in the audit
report; this file is the wipe's own procedure. The launch-morning sequence it sits
inside moved to `docs/LAUNCH-DAY.md` on 2026-09-05.

Two companion scripts check the steps below rather than replacing them:
`scripts/launch-preflight.mjs` (read-only; one PASS/FAIL/WARN line per T-0
precondition, run once per phase) and `scripts/rebuild-plugins.sh` (rebuilds all
four custom plugins for the 1.0 recompile, prints what to stage where, and with
`--stage` does the copying).

## The launch-morning sequence (2026-09-09) — moved

**The launch-morning sequence now lives in `docs/LAUNCH-DAY.md`,** as one numbered,
time-boxed, 23-step run (0 through 22) from "Valheim 1.0 is out on Steam" to "players are in", with the
owner, the exact command, the line to look for and the "if it fails" branch on every step.
It reconciles the six places this morning used to be described in, and where it disagrees
with anything below, **it wins**.

This file keeps what is unique to the wipe itself: when to run it, its own order of
operations, the rehearsal that shaped it, exactly what it wipes and what it deliberately
does not touch, and the chunked-save-format contingency.

What moved to `docs/LAUNCH-DAY.md`, and where to find it there:

| Was here as | Now |
|---|---|
| Lane 1, steps 1 to 5 (md5, rebuild, load test, stage, backups) | LAUNCH-DAY steps 1 to 6 |
| Lane 2, steps 6 to 12 (the stopped window) | LAUNCH-DAY steps 7 to 14, **plus the world sweep and upload that Lane 2 was missing** |
| Lane 3, steps 13 to 19 (verify, zips, mint, bundle, deploy, wipe, GO post) | LAUNCH-DAY steps 15 to 22 |
| "If the morning goes badly" (vanilla night / slip to Thursday, Charlie by 15:00 CT) | LAUNCH-DAY step 17, the go/no-go |

Two things that used to sit in that sequence and are worth repeating here, because they
are the reason this file exists at all:

- **ValheimPlus has no 1.0 build,** and `enforceMod = true` is a version check in *both*
  directions, so the pack flag and the box have to move in the same stopped window.
  `--no-vplus` is what moves them together. `docs/PACK.md` rule 6 carries the full
  inventory of what V+ was doing.
- **Deleting V+ turns nothing on.** The client half is EilifPaths `[VPlusFallback]`
  (`mint-pack.mjs --fallback on`); the server half is Eilif Companion `[ServerFallback]`
  in `BepInEx/config/media.blockspace.eilif.companion.cfg`, which nothing in this repo can
  set and BepInEx only writes on the new DLL's first boot. It goes up by hand in the
  stopped window or the cap sits at the vanilla 10 all night with no error anywhere.

Nothing starts until Steam actually shows 1.0. Until then the box stays on 0.221.12 and
the rehearsal world is the rollback.


## When to run it

**Launch day, after the fresh world exists but before real players are let back
on the dashboard's data path.** Not before — the rehearsal data stays useful for
testing until then. Not after the first real session has posted anything, or
you'd be wiping real launch data along with the pilot's.

## Order of operations (do NOT skip or reorder)

1. **Stop `eilif-discord-bot` FIRST.** This is not a formality. The bot's voice
   tick ends in an unconditional `saveState()` every 60 seconds, so a running
   bot re-creates `services/discord-bot/state.json` — including the same
   `announcedBosses` ids — within a minute of the wipe deleting it. The wipe
   flips `bosses.is_killed` back to `false` but keeps the row **ids**, so a
   resurrected state file makes the bot treat launch night's real Eikthyr kill
   as already announced: no `@everyone`, no skald retelling, `freshKills` empty.

   ```bash
   sudo systemctl stop eilif-discord-bot eilif-log-poller eilif-map-snapshot
   ```

   The script's pre-flight checks these via `systemctl is-active`. It **refuses
   `--execute` outright** while `eilif-discord-bot` **or** `eilif-stats-parser`
   is active (both are hard gates), and warns without blocking on
   `eilif-log-poller` / `eilif-map-snapshot`.

   Wider gate, same moment (units, pilot overrides, world wiring, Vercel env
   names, site, prod counts, the box, port 3000, the pack pins):

   ```bash
   node scripts/launch-preflight.mjs --world <World> --phase pre-wipe
   ```

   > `eilif-stats-parser` was **retired 2026-08-23** — it should report
   > `inactive`/`unknown`. The gate stays deliberately: a retired unit that
   > someone re-enables is exactly the surprise this script exists to prevent.

2. **Backups, and they are the only copies.** Before `--execute` ever runs:

   ```bash
   bash scripts/pull-world.sh             # no argument = the world you are LOSING
   node scripts/db-snapshot.mjs           # -> ~/valheim-db-backups/<stamp>/
   ```

   `pull-world.sh` with **no argument** defaults to the rehearsal world, which is
   the one about to be lost. Naming the launch world here fetches nothing: it is
   not on the box until the stopped window uploads it. `db-snapshot.mjs` is the
   Supabase dump — the project is on the Free plan with **no backups at all**.
   Plus, on 2026-09-09 only, a full off-box copy of the server
   directory before the panel Steam Update (`docs/LAUNCH-DAY.md` step 6). `pull-world.sh` takes the world and nothing else; `BepInEx/`,
   `WebMap/map_data/` and `vplus-data/` are not in it, and the update is one way. The GTX panel only writes a `Backups/*.7z` at a Stop/Start,
   and the in-game `*_backup_auto-*` files live on the same disk as the world.
   There is no undo once rows and storage objects are deleted; the wipe is real
   DELETEs against prod, not a soft-delete.

3. **Preview first, always:**

   ```bash
   export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
   node scripts/launch-wipe.mjs
   ```

   This is the default mode (no flag needed) and only ever reads: current row
   counts per table, object counts per storage bucket, and the local state files
   it would touch. Nothing is written. Paste the output into the tracker.

4. **Run for real** once the preview output looks right:

   ```bash
   node scripts/launch-wipe.mjs --execute --i-mean-prod
   ```

   `--i-mean-prod` was added by the launch rehearsal and is required for every `--execute`
   against a non-loopback Supabase URL. Without it the script refuses and prints
   the target it was about to wipe. A **dry run is never blocked**, so step 3
   above is unchanged. The flag exists because the rehearsal added
   `--supabase-url` / `--service-key`, and a tool that can be aimed somewhere
   else must say out loud when it is aimed at production. The banner now prints
   the target URL, where that URL came from, and which directory the local state
   files will be deleted from, before it counts a single row: read those three
   lines every time.

   **Exactly this command, with no other flags.** In particular no `--state-dir`:
   that one is for the rehearsal, and against production it is refused, because
   it would clear every row while deleting none of the three live state files
   and leave the bot holding the pilot's `announcedBosses`. The state-file line
   in the banner must read `(repo root — the LIVE services’ own files)`.

   Still refuses while a hard-gate unit is active, and additionally requires
   typing `WIPE` at a confirmation prompt before touching anything. Its own
   summary is the proof for this step; the `--phase post-wipe` check comes at the
   end of step 6, not here — run it now and roughly ten of its checks FAIL for
   the sole reason that their step has not happened yet.

5. **Sweep the box while it is STOPPED** (loaded plugin DLLs are file-locked on
   the Windows host, so this is also the only DLL-swap window). Rebuilt DLLs for
   that swap come from `bash scripts/rebuild-plugins.sh` (`--dry-run` first; it
   prints the staging summary and refuses anything that references
   `System.ValueTuple`. The real run overwrites the four tracked `dist/` DLLs, so
   it asks you to type `REBUILD`, or takes `--yes`. Then `--stage <dir>` puts the
   two server DLLs in one place with their md5s and the exact SFTP path, and the
   two client DLLs into `plugins/thunderstore/<Name>-<ver>/`). On 2026-09-09 this
   is `docs/LAUNCH-DAY.md` steps 9 to 12, and V+ comes off the box in the
   same window. Valheim
   **auto-restores from leftover `.old` / `*_backup_auto-*` files and resurrects
   the old world** — the runbook gotcha that makes this step mandatory, not
   cosmetic. Delete, in `worlds_local/`:

   - `Dedicated.db`, `Dedicated.db.old`, `Dedicated.fwl`, `Dedicated.fwl.old`
     (the retired test world — an off-box copy already exists at
     `~/valheim-world-backups/Dedicated-final-20260823/`)
   - `*.old` for **every** world
   - `*_backup_auto-*` for **every** world (both the `.db` and the `.fwl`)
   - `<old world>.json` — plaintext world metadata that contains the **seed**
     (`{"seedName":"…","seed":-1214706268,…}`). The launch world's `.json` must
     never leave the box either.

   and elsewhere on the host:

   - `BepInEx/plugins/WebMap/map_data/<old world>/`
   - `vplus-data/<old world>_mapSync.dat` — **under `BepInEx/`.** The T-3 audit's read-only
     SFTP listing (2026-09-06) found it at `BepInEx/vplus-data/<world>_mapSync.dat` and
     found no `vplus-data` at the nest root.

6. **Do the post-wipe checklist** the script prints at the end (world upload +
   `Start.bat World=`, panel death penalty = **Casual**, Combat per the launch
   decision, leave V+ `[Chat]` ENABLED **if V+ is still installed at all** (it is what makes /s shouts server-wide; the Companion 0.3.1 chat/oath hook no longer depends on it, and on a `--no-vplus` launch this line is moot: shout range goes back to vanilla and the GO post has to say so), Emitter/Companion cfgs off the old
   world, `GS_EXPECTED_WORLD` in Vercel, `MAP_REMOTE_DIR` in the poller `.env`,
   Note (2026-09-05): `NEXT_PUBLIC_SUPABASE_URL` and the anon key are baked into the build at `next build` time, so any Vercel env change needs a REDEPLOY, not just a restart; a local `next start` cannot be repointed at another database without a rebuild (see docs/STRESS-TEST.md).
   and the bot `.env` pilot overrides `RECAPS_START` / `RECAP_CHANNEL` /
   `MILESTONE_CHANNEL` / any `*_CHANNEL=server`). None of it is automated — it
   is printed by the script itself so it can't be missed.

   Then, with the checklist done, run the post-wipe gate:

   ```bash
   node scripts/launch-preflight.mjs --world <World> --phase post-wipe
   ```

   It expects all of the above to be finished: zero rows, `world_day` zeroed,
   local state files gone, the launch world in `worlds_local`, the poller's
   `MAP_REMOTE_DIR` and the bot `.env` reverted, and the pack pins live on
   Thunderstore. On a vanilla night add `--posture GO-B` so the mod-dependent
   checks report instead of failing. Whenever the pack no longer ships a mod,
   pass `--pins` too: preflight's built-in list is `PACK_V12_PINS` in
   `scripts/launch-preflight.mjs` and it still contains ValheimPlus, so a
   `--no-vplus` pack grades a pin it does not have.

   > **On 2026-09-09 this gate does NOT run before the panel Start, and two of
   > its FAILs are expected.** This ordering — wipe while the box is stopped,
   > then Start — is the wipe's own procedure for an ordinary day. The launch-day
   > sequence Starts the box first (`docs/LAUNCH-DAY.md` step 13) and wipes at
   > step 20, so `world day zeroed by the wipe` FAILs as soon as the Emitter
   > re-reports the live day, about a minute after `--execute`. The phase's own
   > on-screen banner still says "the last gate before the panel Start"; on
   > launch day, read it as `docs/LAUNCH-DAY.md` step 20c instead. Every other
   > FAIL here is a real one.

7. **Restart the services in this order:**

   1. `eilif-log-poller` — confirm a join line in its journal.
   2. `eilif-discord-bot` — **only after** `select name, is_killed from bosses`
      is all `false` **and** `services/discord-bot/state.json` is absent. Read
      its startup log: no announced boss, correct `RECAPS_START`, no channel
      overrides. Manual boss marking, if ever needed, is
      `cd services/discord-bot && node scripts/mark-boss.js "<Boss>"` — that file
      lives under `services/discord-bot/scripts/`, **not** repo-root `scripts/`.
   3. `eilif-map-snapshot` **LAST**, and only after `map_data/<World>/` exists on
      the host, `MAP_REMOTE_DIR` points at it, and `/api/status` reports the new
      world's day. Then watch for `day 1 framed` within 5 minutes.

   `eilif-stats-parser` is **not** in this list — retired 2026-08-23.

8. **Verify:** `bash scripts/verify-restart.sh <World>` (game version, the
   `Loading [...]` list, panel tier Casual, `[EILIF_KEY]`, ingest 200, and the
   port-3000 check — which reports **OPEN** today, because the GTX ticket was
   skipped by decision), then `node scripts/launch-preflight.mjs --world <World> --phase
   post-start` (which also re-checks the pilot overrides, the poller's
   `MAP_REMOTE_DIR`, the Vercel env names and the pack pins; add `--posture GO-B`
   on a vanilla night and `--pins` whenever the pack dropped a mod), then the
   `/admin/ops` cockpit.

   The plugin count was 8 through the rehearsal. On 2026-09-09 it is whatever
   survived `docs/LAUNCH-DAY.md` step 14, which is 7 if ValheimPlus
   comes off and fewer if a third-party mod is pulled. Compare against the list
   written down in LAUNCH-DAY step 15, not against a remembered number.

## Rehearsal 2026-09-06

The whole sequence above, run end to end against a local stack: seed, wipe,
verify, then a first evening on a world named `Eilif` with the pages read
between every step. One command re-runs it:

```bash
export BASE_URL=http://localhost:3405 \
       SUPABASE_URL=http://127.0.0.1:55321 \
       SUPABASE_SERVICE_ROLE_KEY=<that stack's service key> \
       SITE_DIR=<the built copy serving $BASE_URL, the dir holding .next>
scripts/stress/rehearse-launch.sh
```

**`SITE_DIR` is not decoration, and a rehearsal without it proves less than it
looks like it does.** The 2026-09-05 perf pass put `/world`, `/events`,
`/gallery`, `/oath`, `/map` and `/boss/[slug]` behind `revalidate = 60`. The
day-one section of this rehearsal runs in about **twenty seconds**, so all six of
them answer every checkpoint with the same build-time HTML, and the run reports
them clean without ever rendering a row of the evening. Caught on 2026-09-06 by
diffing the page dumps: `1-postwipe-Events.txt` and `2-close-Events.txt` were
byte-identical at 579 characters across a night that ended with Eikthyr felled,
where the same rehearsal before the perf pass had grown that page 579 → 1707 →
2152 → 2195 → 3110. With `SITE_DIR`, `page-check.mjs` reads `previewModeId` out of
`.next/prerender-manifest.json` and sends it as `x-prerender-revalidate`, which
forces a synchronous regeneration (`x-nextjs-cache: REVALIDATED`). Without it,
every cached page reports **STALE instead of PASS** and the run exits non-zero.

New tools, all local-only and all refusing any non-loopback URL:

| File | What it does |
|---|---|
| `scripts/stress/rehearse-launch.sh` | chains the whole rehearsal and diffs `cutover-env.sh` against the real files |
| `scripts/stress/day-one.mjs` | the first evening in stages (`boot`, `first-join`, `day1`, `day2`, `day3`, `close`, `verify`) so the pages can be read between them. `verify` also takes `--bot-log <the dry-run announcer's log>` and compares what the relay POSTED against what the rows HOLD — added 2026-09-06, because every other invariant here is a database assertion, and that is how two whole rehearsals graded clean while twenty of the evening's forty-six event rows never reached `#server`. A check it cannot make reports **SKIP**, never PASS |
| `scripts/stress/page-check.mjs` | reads the eight player-facing pages (Hall, Vikings, World, Map, Boss, Events, Gallery, Oath) as text, plus anything given to `--also` (the rehearsal passes `/viking/alvis` from the first join onward), and fails on `undefined`, `NaN`, `null`, `Invalid Date`, `Day 0`, plural disagreement at exactly one, names from the previous world, and the copy doctrine: an em or en dash, `Milestones` where the site says Great Deeds, and the old world's name. Gallery and Boss were added 2026-09-06; both are ISR pages `docs/LAUNCH-DAY.md` names in its post-wipe check, and neither was being read. Reports a cached ISR render as STALE rather than grading it |

`page-check.mjs`'s refusal is the newest of the three (2026-09-06) and it is not
tidiness: with `--site-dir` it attaches the built site's `previewModeId` to every
request as `x-prerender-revalidate`, which is a Next.js on-demand-revalidation
bypass token. A mistyped `--base` used to send a stray GET; it would now hand a
build secret to a stranger, so a non-loopback host exits 2 before the first
request.

The rehearsal also **stamps the commit it ran against** into the top of its log,
and says plainly when the working tree is dirty under `services/`. The bot half
of the rehearsal imports `services/discord-bot/src/*` out of the working tree,
not out of the built site copy, so a rehearsal run while another change is in
flight is not reproducible from any commit. For the final pre-launch run, run it
from a clean tree so the log of record names one sha.

`scripts/launch-wipe.mjs` grew three flags for this (`--supabase-url`,
`--service-key`, `--state-dir`, plus env equivalents) and **three** refusals:

1. no `--execute` against a non-loopback URL without `--i-mean-prod`;
2. no `--execute` against a loopback URL **without** `--state-dir`;
3. no `--execute` against a non-loopback URL **with** `--state-dir`.

The second matters more than it looks: the three state files the wipe deletes
are the LIVE services' own, because `eilif-discord-bot`, `eilif-log-poller` and
`eilif-map-snapshot` all run out of this working copy. A rehearsal that pointed
the wipe at a local database while leaving those paths alone would delete
production's byte cursor and announced-boss ledger and prove nothing.

The third closes the footgun the other two created, and it is the combination
that reads harmless. `--state-dir` is a rehearsal flag; carried into the
launch-day command (the rehearsal block above sits a hundred lines below the
real command, which is where a copy-paste comes from) it wipes every production
row and then deletes **nothing**, leaving `services/discord-bot/state.json`
holding the pilot's `announcedBosses`. That is precisely the silence this script
exists to prevent: launch night's first boss kill announced to no one. Drop
`--state-dir` and `LAUNCH_WIPE_STATE_DIR` for the real wipe.

A fourth guard is not about targets: on a loopback target, `--execute` is
refused while a `bot-dryrun.mjs` **pointed at that same database** is running.
It is the loopback twin of the `eilif-discord-bot` gate, matched by the
process's own `SUPABASE_URL` (never by pattern) so another agent's rehearsal on
another stack is left alone. `rehearse-launch.sh` therefore stops the announcer
before the wipe and starts it again after the verification, which is the
launch-day order anyway.

The rehearsal ran on its own Supabase project (`dressrehearsal`, ports 553xx)
rather than the 543xx stress stack, because two agents writing to one database
turns every count into a coin flip. Two of those coin flips were caught in the
act: the first wipe read 641 rows and the row counts had moved twice before the
verification finished.

### What passed

- **The wipe, entirely.** Every table it claimed to empty is empty, every
  milestone reset (`achieved_at`, `achieved_value`, `announced_at`, `meta` back
  to `{}`), all eight bosses back to `is_killed=false` with `players_present=[]`,
  and `server_status` at `world_day=0, player_count=0, current_players=[],
  is_online=false`.
- **Storage, including the nested prefixes.** Seeded with the snapshotter's real
  layout (`current.webp`, `frames-by-day/day-0001.webp`,
  `frames-by-day/day-0064.webp`, `frames-fog/day-0064.png`,
  `frames-manifest.json`, plus a `gallery/2026/07/` photo and its thumb), the
  wipe removed all of it. The recursion into folder pseudo-entries works. Worth
  knowing because a stack whose buckets are already empty prints "already empty"
  and never exercises this path at all.
- **The state files**, deleted from the scratch directory, with the live ones
  untouched and still being written by the running services throughout.
- **The post-wipe checklist matches reality.** Running
  `launch-preflight.mjs --phase post-wipe` immediately after the wipe, from a
  repo copy whose `.env.local` points at the rehearsal stack, turns all five row
  counts and all three state-file checks green.
- **Day one on the pages.** Boot with the world at day 1 and nobody online, the
  first join, twenty vikings, three oaths, three deaths, Eikthyr felled on day 3,
  everyone logging off. Six pages read at each of those seven points: no
  `undefined`, no `NaN`, no `Invalid Date`, no empty heading, no name from the
  previous world, and every empty state reads as written.
- **The day-one invariants**, 19 of 20: one session per join and all closed, one
  events row per death with `causeSource='eilif'`, the war party equal to the
  eight who swung, exactly one `boss` saga row, no second boss felled, the ledger
  still at one deed of thirty-eight.
- **Titles seed silently.** On the wiped roster the first announcer pass recorded
  twenty titles, all distinct, with **zero** `title_history` rows and zero
  proclamations. That is the behaviour the launch depends on: without it, launch
  night opens with twenty "earned a new title" messages.
- **The day-one recap reads right.** `Vikings on today: 20 · Hours logged: 15.1h
  · Deaths: 3 · Bosses felled: Eikthyr · World day: 3`, and a Player of the Day
  naming the viking who stood over Eikthyr.
- **The map manifest starts at day 1, by construction.** `map-snapshot.mjs`
  cannot run here (it reads the in-game day from the production `/api/status` at
  a hard-coded URL, `scripts/map-snapshot.mjs:94`), so this was settled by
  reading it: `loadState()` returns `{days: []}` when the file is missing, and
  `currentWorldDay()` returns null unless `worldDay > 0`. The wipe deletes the
  state file and zeroes `world_day`, so the first frame after the cutover can
  only be the first day the Emitter reports. Both preconditions were verified
  after the wipe.

### What failed

Five findings, in the order they cost the most:

1. **The `MAP_REMOTE_DIR` check in `launch-preflight.mjs` grades with
   `includes(WORLD)` while its own message says "must end in map_data/Eilif".**
   (Cited by symbol on purpose: `grep -n 'MAP_REMOTE_DIR names the world'
   scripts/launch-preflight.mjs`. It was line 352 when the rehearsal ran and 354
   an hour later.) The poller `.env`
   on this box reads `.../map_data/EilifRehearsal` today, and the launch world is
   `Eilif`, so the stale value **passes** the check in all three phases. If
   `cutover-env.sh --apply` is skipped or fails, every gate says PASS and
   `map-snapshot` spends launch night framing the rehearsal world's map. This is
   the 2026-08-23 day-64 incident with a green light on top of it. Fix:
   `endsWith('/map_data/' + WORLD)`.
2. **The first-boss deed cannot fire from the kill.** `evaluateAndRecord()` has
   exactly one call site in the repo, inside the `source:'client'` branch of
   `app/api/gs-ingest/route.ts`, behind `if (merged)`; the server branch that
   flips the boss is `ingestBossMilestones()` in the same file. (Find both with
   `grep -n evaluateAndRecord app/api/gs-ingest/route.ts` rather than by line
   number: that file is being edited daily this week and the call site moved
   twice during the review of this document. Any fix must be applied by symbol
   for the same reason.) The Emitter's
   `defeated_eikthyr` key flips `bosses.is_killed` and never re-evaluates the
   collective deeds. In the rehearsal Eikthyr went down, the boss saga row was
   written, the recap said "Bosses felled: Eikthyr", and **"First of the
   Forsaken" stayed unachieved** because the warband logged off inside the ~120 s
   before the next client snapshot. The Hall then reads
   `Next deed · The First Mile` (the boss chain was retired 2026-09-06) directly above `Map explored · 0 of
   1`. Launch night is the one night this is likely: the first boss, then people
   stop playing.
3. **The Hall's `const worldDay = status?.world_day ?? 0` (in `app/page.tsx`,
   rendered as `Day {worldDay} of the tenth world` and as a `World Day` stat
   tile) reads "Day 0 of the tenth world"** (and a `World Day 0` stat tile) for the whole window
   between the wipe and the Emitter's first post. The wipe zeroes `world_day`
   deliberately, and `docs/LAUNCH-DAY.md` step 20 puts the wipe after
   the panel Start, which is when the GO post goes out.
4. **`app/players/page.tsx` renders `{roster.length} vikings` with the plural
   hard-coded**, so the first viking to join sees "1 vikings". `app/tv/page.tsx`
   already writes `{playerCount === 1 ? 'viking' : 'vikings'}` in the same repo.
5. **`ops_alerts` is neither wiped nor listed as deliberately untouched.** The
   watchdog's state row (`state`, `signature`, `since`, `alert_count`) survives
   the wipe, and nothing in this runbook mentions the watchdog at all, even
   though two pingers hit `/api/ops/watchdog` (a Supabase `pg_cron` job,
   `eilif-watchdog-ping`, every 5 minutes, plus `.github/workflows/watchdog.yml`
   about every 4 hours) and the launch-day sequence stops all three producers
   for most of the day. Expect
   Discord alerts for the planned outage, and a "down for X" duration measured
   from before the cutover.
   **Resolved 2026-09-05 (review pass), in the sequence rather than here:**
   `docs/LAUNCH-DAY.md` step 5 says what alerts and how often (`ops_alerts`
   dedupes — first transition, each change in the unhealthy set, then 6-hourly,
   so it is a handful of messages and not one per ping) and why not to mute it,
   and step 20e says the eventual all-clear's duration is measured from before
   the cutover and self-corrects. `scripts/launch-wipe.mjs:811` does now list
   `ops_alerts` as deliberately untouched.

### Fixes in the rehearsal tooling

`scripts/stress/bot-dryrun.mjs` hard-coded `channel: 'server'` for the recap, the
titles announcer and the deed announcer, so the one launch-day change nobody
could see locally was the channel revert, which is step 6 of the cutover. It now
reads `RECAP_CHANNEL` / `MILESTONE_CHANNEL` / `TITLE_CHANNEL` exactly as
`services/discord-bot/src/index.js` does, and prints the routing at startup next
to the clock.

Eight more found by reviewing the harness itself, all of the same shape: a check
that could not fail, or a default that made a bad state look like a good one.

- **`day-one.mjs --stage verify` could report a majority PASS against an empty
  database.** Most of its checks compare a filtered row count against a counter
  in the state file, so with an empty state file both sides are zero and "0
  sessions for 0 joins" passes. A crashed stage, a `boot` re-run mid-sequence or
  a wrong `DAY_ONE_STATE` all produced that. Verify now gates on the evening's
  own shape first (all six stages run, 20 joins, 3 deaths, 8 at Eikthyr) and
  stops there when it does not hold, so an inconclusive run cannot read as a
  clean one.
- **The rehearsal's proof that the LIVE state files survived was dead code.** It
  was guarded on a `.orig` file nothing ever wrote, so the second half of the
  condition was always false. It now records which of the three files existed
  before the wipe and asserts each of those is still there afterwards, naming
  them one by one. (`scripts/.map-snapshot-state.json` is gitignored and
  legitimately absent on a fresh checkout, which is why "missing afterwards"
  only means something for files that were present to begin with.)
- **An unreachable database read as an already-seeded one.** The row count is
  scraped out of a `Content-Range` header; with the stack down it is the empty
  string, and `'' != "0"`, so the script announced "database already holds an
  evening (events= players=)" and skipped ahead to a wipe that then failed for
  an unrelated-looking reason. A non-numeric count now stops the run where the
  cause is.
- **`WORK` defaulted to `$REPO/.rehearsal`**, which is not in `.gitignore`, so a
  plain run left logs, page dumps and copies of the live services' `state.json`
  in the working tree four days before launch. It defaults to
  `$TMPDIR/eilif-rehearsal` now.
- **The verification raced the announcer.** The rehearsal wiped and immediately
  re-counted every table with the dry-run bot still writing, which is the same
  "another writer was writing the whole time" problem that made the rehearsal
  move off the shared stack in the first place. The announcer is now stopped
  before the wipe and started again after the verification, matched on its own
  `SUPABASE_URL`, and `launch-wipe` refuses a loopback `--execute` while one is
  up.
- **Nothing compared what the announcer POSTED against what the rows HOLD**, so
  two full rehearsals graded clean while the relay had silently stopped 21 rows
  into a 43-row evening: every `left the realm` line was missing from `#server`
  and no check could see it, because all 21 invariants are database assertions.
  `day-one.mjs --stage verify --bot-log <log>` now counts join, leave and death
  rows for the roster and compares them with the relay's own output, accounting
  for the duplicate deaths it collapses and the rows Discord permanently rejects.
  It fails the final rehearsal on purpose: the cause is in
  `services/discord-bot/src/relay.js`, which cursors on the producer-supplied
  `events.created_at` and advances onto every consumed row, so a row stamped
  later than one written after it is lost for good. **On launch night the same
  shape arrives from a player's PC with a fast clock** (`lib/event-time.ts`
  deliberately trusts anything up to now+5min), which silently deletes up to five
  minutes of everyone else's joins, leaves and deaths from the feed.
- **The storage seeding announced work it had not done.** The loop that plants
  the snapshotter's nested layout before the wipe piped every upload through
  `curl -s -o /dev/null` with no status check and then printed "planted 7
  objects" unconditionally, so aimed at buckets that do not exist (an ordinary
  state after a `db reset`) it planted nothing, the wipe printed "already empty",
  and the `objects = 0` assertion passed vacuously. It counts the 2xx responses
  now, fails loudly when the number is short, and afterwards asserts the wipe's
  own summary really reported deleting objects out of each bucket.
- **`bucket_count` returned 1 for a bucket holding three objects.** The storage
  list API answers on one line and the function was `grep -c`, which counts
  lines. Renamed `bucket_top_count`, counts occurrences, and its comment now says
  what it actually measures: top-level entries, not objects at any depth.

`cutover-env.sh` was diffed line by line against the real files and every value
it writes is correct, including the non-obvious one: `TITLE_CHANNEL` defaults to
`server` inside `services/discord-bot/src/index.js`, so writing
`TITLE_CHANNEL=valheim` really is required rather than cosmetic. The rehearsal
turned up three defects around those correct values, and all three are now
fixed:

- **Argument parsing.** `APPLY` was `[ "${2:-}" = "--apply" ]`, so
  `cutover-env.sh --apply` with no world argument did a silent dry run for a
  world named `--apply`. Every argument is scanned now, and any other leading
  dash is an error.
- **The unit-file edit failing silently.** It was one
  `sudo -n sed ... && sudo -n systemctl daemon-reload && echo` chain with no
  `set -e` and no else branch: without passwordless sudo the whole chain was
  skipped, nothing said so, and the script still exited 0 while the unit kept
  overriding `RECAPS_START`. It now re-reads the unit to check the postcondition
  rather than trusting sudo's exit code, says so loudly when the line is still
  there, and exits non-zero.
- **The printed pack command.** It read `--companion-client 0.3.2 --paths 1.4.0`
  and omitted `--no-vplus --fallback on --cap <N>`, contradicting `docs/LAUNCH-DAY.md`
  step 18: `mint-pack` refuses `--fallback` below EilifPaths
  1.5.0, and a pack still pinning ValheimPlus is refused by a box that no longer
  runs it. Pasted under time pressure it minted a pack every client rejects. The
  script now prints that flag set and points at `docs/LAUNCH-DAY.md` steps 16 and 18.

### Found on the re-run, and fixed

**The wipe left the war party of a boss that was fought and never killed.** The
boss reset filtered on `is_killed = true`, but `gs-ingest` folds client damage
into `players_present` and `fight_stats` on every snapshot with no kill
required, and both folds are grow-only unions. So a boss the pilot world only
attempted kept its fighters and its damage numbers through the wipe, and the
next kill inherited them. The second rehearsal run made it visible on a page:
`/world` read `War party: Astrid Bjorn Cnut Dagny Eirik Freydis Gunnar Halla
Ingimar Brynja …` after day three, sixteen names for eight vikings, eight of
them from the world that had just been wiped, and the damage board was topped by
one of them. `page-check.mjs --stale` is what caught it, which is the check the
first rehearsal added for exactly this and had not yet had a chance to fire.
The reset now clears all eight rows; the same run afterwards reported `war party
is the eight who swung · 8 present`, and `/world` was clean.

Prod is not carrying this today (only Eikthyr has residue, and it is killed, so
the old filter would have caught it), but a failed boss attempt between now and
the 9th puts it back.

### Known artifacts of the rehearsal, not defects

- The day-one harness anchors its evening three hours in the past, so the
  Emitter's `emittedAtUtc` at the boot stage is three hours old and the Hall shows
  "Live stats are paused". `statsFreshness` reads `server_status.updated_at`
  (`lib/data.ts:74`) and a real Emitter post carries a real timestamp.
- `page-check.mjs` reads text with the tags stripped, so a filter chip row
  ("All 1 Deaths 0") and a heading after a count ("Greylings 1 Players of the
  Day") both look like plural faults. Both shapes are reported separately as
  notes rather than failures.
- Never `pkill -f` a bot pattern from an interactive shell, including with the
  bracket trick `bot[-]dryrun`: the shell's own command line is matched, and a
  heredoc body inside that command counts as part of it. This killed the
  rehearsal shell twice. Match on the process's `SUPABASE_URL` instead, from a
  script file.

## What it wipes

- **Deletes all rows**: `title_history`, `players`, `sessions`, `events`,
  `chat_lines`, `oaths`, `pins`, `gallery_photos`, `player_stats`, `voice_lines`,
  `poty_history`, `identity_claims`, `player_positions`, and `map_markers` if
  that table exists (it does not, as of this writing).
  `title_history` (the Crowning Log) is deleted **first and explicitly** — its
  `player_id` FK cascades from `players`, but 10 pilot rows were still live in
  prod on 2026-09-03, so it is no longer left to the cascade.
- **Added 2026-09-06**, four tables that shipped to production the same morning
  and were in neither list until the T-3 audit found them:
  - `boss_tellings` — the pilot world's accounts of a boss fall, including
    ChÆrleif's `chosen` Eikthyr telling. Resetting `bosses` does not clear them
    (a telling is its own row), and `pickTelling()` returns the chosen row
    first, so the pilot's saga would have reappeared at launch night's first
    kill with the real telling filed underneath it.
  - `tales` — nights of the hall recounted by the Storyteller and jarls; every
    row's `told_for` is a pilot date, so all of them are false history.
  - `office_nudges` — which boss each office term has already been nudged
    about; deleted **before** `offices` for the `title_history` reason (its
    `office_id` FK cascades, and the explicit delete keeps the printed count
    honest). Composite PK, so the wipe filters on `boss_id`.
  - `offices` — terms of the Storyteller. Empty in prod today (`STORYTELLER=1`
    is unset), so this is latent until that one `.env` line is added.
- **Resets state only** (definitions/rows stay):
  - `milestones` — zeroes `achieved_at` / `achieved_value` / `announced_at` /
    `meta` on rows currently marked achieved.
  - `bosses` — flips `is_killed` back to `false` and clears `killed_at` /
    `players_present` / `fight_stats` / `retelling` / `retelling_generated_at`,
    on **every** row. **It does not touch `name`, and that matters if the table is
    ever rebuilt rather than reset:** `db/0000_initial_schema.sql:130` seeds the eighth
    row as `('The Bog Witch', 'Deep North', 8)` while production runs **`Forsaken VIII`**
    (verified 2026-09-06 — the first seven match, and no later `db/*.sql` renames row 8).
    So a rebuild from `db/*.sql` in filename order silently renames the one boss Valheim
    1.0 makes reachable, and the site, `/api/gs-ingest` and the boss tests all key on
    `Forsaken VIII`. After any such rebuild:
    `update public.bosses set name = 'Forsaken VIII' where sort_order = 8 and name = 'The Bog Witch';`
    The wipe itself is unaffected — it resets rows, it does not re-seed them. **This changed on 2026-09-06.** It used to reset only the
    rows with `is_killed = true`, which misses a boss the pilot world FOUGHT and
    never killed: `gs-ingest` folds client damage into `players_present` and
    `fight_stats` on every snapshot, kill or no kill, and both folds are
    grow-only unions. So the residue survived the wipe and launch night's first
    kill of that boss inherited it. Caught in the rehearsal on 2026-09-06: the
    seed left Eikthyr fought-but-unkilled, the wipe skipped the row, and the
    day-three kill came out with a war party of **16** — the eight who actually
    swung plus eight vikings from the wiped world, one of them topping the
    damage board. Prod is clean of this today (only Eikthyr carries residue and
    it is killed, so the old filter caught it), but any boss attempt that fails
    between now and the 9th recreates it.
  - `server_status` (the singleton `id = 1`) — `world_day` → `0`,
    `player_count` → `0`, `current_players` → `[]`, `is_online` → `false`.
    **This is new (2026-09-04).** It used to be left alone as "it refreshes
    itself", which was wrong and is provable: `scripts/map-snapshot.mjs` reads
    the in-game day from `/api/status`, i.e. from this row, so after the
    2026-08-23 rehearsal wipe it framed `frames-by-day/day-0064.webp` — the OLD
    world's day 64 — four minutes after the wipe, and the public timelapse
    manifest still ends on that pre-wipe frame. Zeroing `world_day` makes
    `currentWorldDay()` return `null` (it guards on `worldDay > 0`), so nothing
    can be framed until the Emitter reports the new world's day.
- **Storage**: every object in the `gallery` bucket and the `map` bucket (the map
  snapshotter's bucket — it is literally named `map`, not "map-frames"; the
  script also picks up any other bucket whose id contains "map").
- **Local state files**: `services/log-poller/state.json`,
  `services/discord-bot/state.json` (announced bosses, voice/discovery dedupe,
  POTY recap streaks, plus the two boss-telling-dependent keys added 2026-09-06:
  `altar.told`, which viking heard which chosen telling, and `offices`, the open
  ballot cursor pointing at a term row this wipe deletes), and
  `scripts/.map-snapshot-state.json`. `services/stats-parser` had no local state
  file and is retired regardless.

## What it deliberately does NOT touch

`discord_events`, `ops_heartbeats` and **`ops_alerts`** (`roadmap` IS wiped since
2026-09-05: the table is orphaned and was added to DELETE_TABLES). Flag to
whoever owns launch-week ops if they also need clearing.

`ops_alerts` was added to this list on 2026-09-06 because it was in neither list
before, which is worse than being in the wrong one. It is the watchdog's dedupe
memory (`db/2026-08-21_ops_alerts.sql`: one row, `key='watchdog'`, carrying
`state`, `signature`, `since` and `alert_count`), and it survives the wipe. Two
consequences on launch morning, neither of them fatal and both surprising if
nobody said so first: two pingers hit `/api/ops/watchdog` (a Supabase `pg_cron`
job, `eilif-watchdog-ping`, every 5 minutes, and `.github/workflows/watchdog.yml`
about every 4 hours) and the route posts to the ops channel itself, so the hours
in which all three producers are deliberately stopped will generate a real alert
within five minutes plus a re-alert every six hours; and the `since` that drives the "down for X" line is measured from
whenever that episode began, which is before the cutover rather than after it. (`poty_history` **is** wiped — its
migration documents a pre-launch wipe. `server_status` **is** reset now, see
above.)

## If 1.0 ships the chunked save format

PTB 0.221.13 (2026-05-06) replaced the `<World>.db` + `<World>.fwl` pair with a
**folder** per world (`worlds_local/<World>/`, only changed chunks written).
Whether that lands in 1.0 is unconfirmed. Both `scripts/pull-world.sh` and
`scripts/verify-restart.sh` probe for either layout, and the sweep list in step 5
applies to the folder form too (`worlds_local/<old world>/` instead of the flat
pair). Take the pre-1.0 world **and** a full server-directory backup before any
1.0 boot — saves are forward-only.
