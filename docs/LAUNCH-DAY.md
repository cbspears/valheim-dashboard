# Launch day — Wednesday 2026-09-09

**This file is the sequence of record for launch morning.** Every other document that
described the launch order now points here: `docs/LAUNCH-WIPE.md` (the wipe's own
procedure and its rationale), `docs/PACK.md` (how minting works), `CLAUDE.md`, the vault
checklist, and the printable HTML runbook. Where any of them disagrees with this file,
this file wins.

Written 2026-09-05 by reconciling six descriptions of the same morning that did not
agree with each other. What each source said, and where each contradiction was resolved,
is in the "Contradictions this file settled" table at the bottom.

One numbered sequence, twenty-two steps. Every step carries: **who**, **the exact
command**, **the line to look for**, and **if it fails**. Steps marked
**CHARLIE ONLY** need the GTX panel, SFTP writes to the box, a Thunderstore account, a
Vercel token or `sudo` — an agent cannot do them and must not try.

Before anything: `export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20`.

---

## The shape of the day

| Window | What happens | Owner |
|---|---|---|
| **before the day, by 2026-09-08** | **Step 0. The launch world is generated and handed over.** Nothing on the 9th can start without it, and it does not exist yet. | **Charlie** |
| 1.0 appears on Steam → +90 min | Steps 1 to 6. Rebuild, stage, stop the services, take the only copies. Nothing on the box has moved. | Claude |
| +90 min → +3 h | Steps 7 to 14. The stopped window: Steam Update, DLL swap, V+ out, cfgs in, world up, Start. | **Charlie** |
| after the first Start | Steps 15 to 17. Read the boot, hand the client zips over, start the Thunderstore index clock. | Claude + Charlie |
| index clock + 40 to 80 min | Steps 18 to 21. Mint, bundle, deploy, wipe, restart, verify. | Claude (deploy is Charlie's trigger) |
| 15:00 CT | **Go / no-go, Charlie's call.** GO-A, vanilla night, or slip to Thursday. | **Charlie** |
| 17:00 to 17:30 CT | Step 22. GO post, then Session Zero. | Charlie posts, Claude watches |

The Thunderstore listing index lags an upload by **40 to 80 minutes** and no script can
shorten it. Step 16 starts that clock as early as the day allows, which is why the client
zips are handed over before the pack is minted rather than with it.

### If 1.0 has not shipped by the morning

Every window above except the last two is measured from "1.0 appears on Steam", while the
15:00 CT go/no-go and the 17:00 GO post are fixed clock times. Adding the documented
durations, **step 1 to 20e is six to seven hours** once step 16's index lag is counted. So
the relative chain and the absolute gates only meet if Steam flips early enough, and there
is no rule anywhere for what to do when it does not. Decide the cutoffs **now**, not at
10:30 with the crew watching:

| Steam still shows 0.221.12 at… | Then |
|---|---|
| **09:00 CT** | GO-A is already tight. Say so in `#valheim`, keep going, and treat noon as the real gate. |
| **12:00 CT** | **Charlie's cutoff (decided 2026-09-06): still no 1.0 at noon means vanilla night.** Declare it now rather than at 15:00, so the crew gets five hours of notice. The box stays on 0.221.12, the wipe and the world and the Casual tier all still happen, and the pack is not re-minted. By the documented durations GO-A is already arithmetically out of reach from about 11:00 (the index lag alone runs past 17:00), so a 1.0 that lands between 11:00 and noon buys a stretch, not a plan: expect the pack to be importable around 17:00 to 18:00 at best, and treat that hour as a bonus if it comes. |
| **15:00 CT** | Step 17's normal go/no-go, with vanilla night and slip-to-Thursday both still on the table. |

**Charlie owns these two numbers.** They cost nothing to set today and they are the only
thing standing between "1.0 is late" and an afternoon that drifts into a decision made at
17:15.

---

## Hold rules — stop at any of these

- Any **FAIL** from `launch-preflight.mjs` for the phase you are in, except the **three**
  known-spurious ones: *world day zeroed by the wipe* and *unit `eilif-*` stopped* (both
  named in step 20c) and **port 3000 open** (steps 15 and 20e). Port 3000 is a **known
  exposure by decision** — Charlie skipped the GTX ticket on 2026-09-05 — and is not a hold.
  `launch-preflight.mjs` now grades it **WARN** for that reason (changed 2026-09-06, another
  track's edit); if you are running an older copy it prints `FAIL port 3000 closed` and
  drags the red **"HOLD. Do not advance the cutover"** banner with it on an otherwise
  perfect night. Read that banner against this list, not the other way round.
- The world copy or the Supabase dump did not finish. There is no undo and no backups.
- `console.log` does not say `DeathPenalty->casual`. Everyone drops their gear on every
  death.
- A pin is not in the Thunderstore listing index yet. The pack imports as
  "mod not found" for every player.
- The bot's `state.json` is back before the bot starts. The first boss kill announces
  nothing.

Post a hold in `#valheim` **at the moment it is decided**, not at kickoff. The copy is in
the vault, `08-Dashboard/10-Launch-Comms-2026-09-09.md` piece 4.

---

## The one thing to hold in your head all day

**ValheimPlus has no 1.0 build.** Grantapher 9.17.1 (2026-02-06) targets 0.221.10 and the
author has been silent since. `enforceMod = true` is a version check in **both**
directions: a pack that still pins V+ refuses to join a server without it, and a server
still running V+ refuses every client from a pack without it. The pack flag and the box
move in the same stopped window, or nobody connects.

**Deleting V+ turns nothing on.** Two switches replace it, on opposite sides of the wire,
and both ship **off**:

| Half | Where | Turned on by | Step |
|---|---|---|---|
| Client | EilifPaths `[VPlusFallback] Enabled` | `mint-pack.mjs --fallback on` | 18 |
| Server | Eilif Companion `[ServerFallback] Enabled` + `MaxPlayers` | a hand-uploaded cfg, in the stopped window | 11 |

Nothing in this repo can set the server half. BepInEx only writes that section on the
**first boot of the new DLL**, so it has to be put there by hand before the Start or the
cap sits at the vanilla 10 all night with no error anywhere. Whatever number goes in
`[ServerFallback] MaxPlayers` is the same number in `config/server.ts` `MAX_PLAYERS`
(step 19) and in the minter's `--cap` (step 18).

What `--fallback on` restores, what is simply gone tonight, and what is worth folding in
later: `docs/PACK.md` rule 6. **Read it before writing the GO post, not after someone
reports a bug.**

---

## Where the day starts

Nothing below starts until Steam actually shows 1.0. Until then the box stays on 0.221.12
and the rehearsal world `EilifRehearsal` is the rollback.

Facts as of 2026-09-05, verified by execution, that the morning assumes:

- Launch world name: **`Eilif`**. It **does not exist anywhere yet** — it is not on the
  box (`worlds_local` holds `EilifRehearsal` and the retired `Dedicated`, verified
  2026-09-05 by `launch-preflight --phase pre-wipe`) and it has not been generated. **Step 0
  creates it, step 12 uploads it, and step 0 is not on the 9th.** It is the one
  precondition the whole stopped window rests on and the only one nobody owned until now.
- Panel death penalty is already **casual** and Combat is **default** (both decided
  2026-09-05).
- On the box: game 0.221.12, Eilif Companion **0.3.2**, Boards 0.2.0, Emitter 0.2.4,
  WebMap 2.7.1, V+ 0.9.17.1, PlantEverything 1.20.0, ServersideQoL 1.8.0,
  AzuCraftyBoxes 1.8.15 — eight plugins.
- In the repo, built for the morning: Companion **0.3.3** (carries `[ServerFallback]`),
  Boards 0.2.0, EilifPaths **1.5.0** (carries `[VPlusFallback]`), Client **0.3.3** (bumped
  2026-09-05 evening: the hardening pass changed the DLL, and Thunderstore's 0.3.2 is immutable).
- On Thunderstore: `Eilif-EilifCompanionClient-0.3.2` is **live** (still works; 0.3.3 adds a
  startup health line **and** wraps `Update()` in a rate-limited try/catch — see step 16,
  where the pin-0.3.2-or-upload-0.3.3 decision is written out).
  `plugins/thunderstore/EilifCompanionClient-0.3.3.zip` and
  `plugins/thunderstore/EilifPaths-1.5.0.zip` are staged and ready for Charlie to upload.
  `Eilif-EilifPaths-1.5.0` is **not uploaded** — the package API 404s it. Until Charlie
  uploads it, `--paths 1.5.0` cannot be minted, and `--fallback on` is refused without
  `--paths 1.5.0`. This is the single longest pole in the day. Uploading it before the 9th
  removes the 40-to-80-minute lag from the critical path but takes the version number with
  it, and the morning's rebuild produces a **different** 1.5.0 — see the branch at step 16.
  `plugins/thunderstore/EilifPaths-1.5.0/` and its zip exist since 2026-09-05 evening (built
  against 0.221.12); step 4 re-stages them only if the 1.0 rebuild changes the DLL.
- `config/server.ts` `MAX_PLAYERS` is **20**, `MODPACK_VERSION_LABEL` is `Pack v11 · Aug 27`,
  `LAUNCH_NOTICE` is empty by decision, `DISCORD_URL` is empty.
- Port 3000 on the box is **OPEN** (HTTP 200). The GTX ticket was skipped. It is not a
  launch blocker; it is a known exposure and `verify-restart.sh` reports it every time.

---

# The sequence

## Step 0 — Generate the launch world and hand over the pair · **CHARLIE ONLY** · **due 2026-09-08, not on the day**

**This is the hard blocker of the whole plan and it is still open.** `Eilif` does not
exist. `launch-preflight --world Eilif --phase pre-wipe` says so in as many words:

```
WARN worlds_local has Eilif · NEITHER Eilif.db+.fwl NOR worlds_local/Eilif/ found
```

Step 12 uploads the pair into a stopped window that opens **after** step 8 has already put
the box irreversibly on 1.0. If the pair does not exist when step 12 arrives, the day stalls
at a point with no rollback. Do not start step 7 without it.

**What to produce.** In Charlie's own Valheim client, not on the box: a world named exactly
`Eilif`, then the **pair** `Eilif.fwl` **and** `Eilif.db` out of that client's
`worlds_local`, handed over together. On this Linux PC's snap Steam that folder is
`~/snap/steam/common/.config/unity3d/IronGate/Valheim/worlds_local/` (checked 2026-09-05:
it holds only `Eiliftest_*` and `modservertest_*` texture caches, so the world is not here
either); on Windows it is `%USERPROFILE%\AppData\LocalLow\IronGate\Valheim\worlds_local\`.

**What must never leave Charlie's machine:** `Eilif.json`. It carries the **seed in
plaintext**. `scripts/pull-world.sh` deliberately skips it, and step 12 deletes it off the
box. The seed is not a dashboard value, and `WORLD_SEED` on the site stays cosmetic.

**The one decision inside this step, and it has to be made before the 9th.** The vault
checklist (written 2026-09-04) says to generate it on **0.221.12**. That predates the
posture settling on "the box goes to 1.0 on launch morning", and the two pull opposite ways:

| Generated on | Buys | Costs |
|---|---|---|
| **0.221.12** | The world still opens on 0.221.12, so it survives the slip-to-Thursday and vanilla-night branches at step 17 intact. | It is upgraded one way the first time it boots on 1.0 (the same forward-only rule as step 6), and what 1.0 does or does not add to an already-generated map is not something this repo can answer. |
| **1.0**, in the morning after Steam updates | The map is generated by the build the server will actually run. | It **cannot be opened by 0.221.12**, which deletes the vanilla-night branch before step 17 gets to choose it. |

Neither is verifiable from this PC, and there is no "decide later" — a world generated on
0.221.12 is upgraded in place, one way, the first time it boots at step 13, and after that
the choice is spent. **Charlie's call, before the 9th. The safer shape is 0.221.12**,
because it is the only one of the two that leaves step 17's vanilla-night and
slip-to-Thursday branches something to fall back to.

**Look for:** `Eilif.fwl` and `Eilif.db`, both non-zero, same base name, in one folder that
Claude can reach on the 9th. Nothing else.

**If it fails:** if the pair is not in hand on the morning of the 9th, that is a **NO-GO
before step 7** — not a hold at step 12. The box stays on 0.221.12, the rehearsal world
keeps running, and the day slips. This is the cheapest possible failure and only if it is
caught here.

**Rollback:** free. Nothing has moved.

---

## Step 1 — Prove Steam is really on 1.0 · Claude

```bash
ls -l ~/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed/assembly_valheim.dll
md5sum   ~/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed/assembly_valheim.dll
```

**Look for:** an md5 that is **not** `2a2990bacab27146173924d88b2628b4`. That is 0.221.12's,
confirmed on this PC 2026-09-05 against the 2026-02-24 file (2,126,848 bytes).

**If it fails:** the md5 still matches 0.221.12, so the Steam client has not finished
updating. Wait. Every rebuild below would otherwise produce 0.221.12 plugins wearing a
1.0 label, and nothing downstream would catch it.

**Rollback:** nothing has changed. Free.

---

## Step 2 — Rebuild all four plugins against the 1.0 assemblies · Claude

```bash
bash scripts/rebuild-plugins.sh --dry-run     # read the plan first
bash scripts/rebuild-plugins.sh               # type REBUILD at the prompt (or --yes)
```

One pass does `refresh-libs.sh` per plugin, then `dotnet build -c Release`, then
md5/size/version/ValueTuple checks.

**Look for:** four `OK` lines in the staging summary, each with the csproj `<Version>`
found inside the DLL and no `System.ValueTuple` reference.

**If it fails:** a compile error names the Valheim API that moved in 1.0. That is the
whole point of doing this at 09:00 and not at 17:00. Fix it, or, if the API move is deep,
that is a vanilla-night trigger — see the go/no-go at step 17.

**Rollback:** the build overwrites the four tracked `dist/` DLLs. `git checkout -- plugins/*/dist`
restores the 0.221.12 builds. Note the md5 caveat in `--help`: a changed md5 after an
in-place rebuild means the source changed **or** HEAD moved (SourceLink stamps the git
sha), and on launch day HEAD will have moved either way.

---

## Step 3 — Load-test the two server DLLs locally · Claude · conditional

Only if the local creative server has **also** updated to 1.0. A 0.221.12 creative server
proves nothing about a 1.0 plugin. Drop the rebuilt `EilifCompanion.dll` and
`EilifBoards.dll` into its `BepInEx/plugins/` and start it.

**Look for:** its `BepInEx/LogOutput.log` shows `Loading [Eilif Companion …]` and
`Loading [Eilif Boards …]` with no `TypeLoadException` and no `MissingMethodException`.

**If it fails, or the local server has not updated:** say so out loud in the channel and
treat the GTX Start at step 13 as the first real load test. Do not skip it silently.

**Rollback:** local only. Free.

---

## Step 4 — Stage the artifacts · Claude

So the stopped window is a file copy and not a build.

```bash
bash scripts/rebuild-plugins.sh --stage ~/eilif-launch-dlls --skip-refresh
```

The directory argument covers the **two server DLLs** only. The two client DLLs always
land in the repo's `plugins/thunderstore/<Name>-<ver>/` with `manifest.json` bumped, and
`--stage <dir>` does not change that.

**Look for:** one md5 and one exact SFTP destination per server DLL
(`191.101.30.229_6028/BepInEx/plugins/<Folder>/<Name>.dll`). **Keep those md5s** — they
are what you compare against the copy on the box at step 9.

**If it fails:** re-run step 2 first; `--skip-refresh` assumes `libs/` is already the 1.0
set.

**Rollback:** free.

---

## Step 5 — Stop the three services, then the pre-wipe gate · Claude

**Stop the bot first.** This is not a formality: the bot's voice tick ends in an
unconditional `saveState()` every 60 seconds, so a running bot re-creates
`services/discord-bot/state.json` — including the same `announcedBosses` ids — within a
minute of the wipe deleting it. The wipe flips `bosses.is_killed` back to `false` but
keeps the row ids, so a resurrected state file makes the bot treat launch night's real
Eikthyr kill as already announced.

```bash
sudo systemctl stop eilif-discord-bot eilif-log-poller eilif-map-snapshot
node scripts/launch-preflight.mjs --world Eilif --phase pre-wipe
```

`sudo` here is Charlie's or an interactive prompt; the wipe refuses `--execute` while
`eilif-discord-bot` or `eilif-stats-parser` is active, and warns on the other two.

The live unit names are `eilif-discord-bot`, `eilif-log-poller`, `eilif-map-snapshot`.
**There is no `valheim-log-poller.service`** — that name survives in `AGENTS.md` (lines 76
and 79) and `services/log-poller/README.md` (lines 44 to 50) and is wrong in both.
`docs/PROJECT.md` was corrected 2026-09-05 and is right; the repo's *reference unit file*
under `services/log-poller/` genuinely still carries the old filename, which is what
`docs/ARCHITECTURE.md` documents.

> **The watchdog keeps running through all of this, and that is not a fault.**
> `.github/workflows/watchdog.yml` pings `/api/ops/watchdog` from GitHub every 15 minutes
> and nothing in this sequence stops it. From this step until 20d the producers are down on
> purpose, so expect Discord alerts on the watchdog channel: the bot and the poller cross
> their 20-minute threshold first, the game server crosses its 20 minutes once Charlie
> Stops the box at step 7, and map-snapshot crosses 45 minutes. They land in **`#server`**
> (`WATCHDOG_CHANNEL_ID`, set 2026-09-05). It is **not** one alert every 15 minutes — `ops_alerts` dedupes, so it posts on the first ok→unhealthy
> transition, again each time *which* components are unhealthy changes, and then at most
> once every 6 hours (`docs/OPS-COCKPIT.md` §7). Call it a handful of messages across the
> day. **Do not mute it and do not disable the workflow to make them stop** — a muted
> watchdog on launch night is the exact failure it exists to prevent. If Charlie wants
> silence anyway, the only clean way is to disable the *ops watchdog* workflow from the
> GitHub Actions tab and **re-enable it at 20e**, and that is a decision, not a step.

**Look for:** the three bridge units `inactive`, `eilif-stats-parser (retired)`
`inactive`, and every WARN in the "pilot overrides" and "world wiring" sections still
present (they are reverted at step 20, not now).

**If it fails:** any FAIL here is a real one and blocks the cutover. `--posture GO-B`
downgrades the mod-dependent checks on a vanilla night; it does not downgrade the unit
checks.

**Rollback:** `sudo systemctl start eilif-log-poller eilif-discord-bot eilif-map-snapshot`
puts the day back exactly as it was.

---

## Step 6 — Three backups, then the wipe preview · Claude

Three copies, **not two**.

```bash
bash scripts/pull-world.sh                    # no argument = the rehearsal world
node scripts/db-snapshot.mjs                  # -> ~/valheim-db-backups/<stamp>/
node scripts/launch-wipe.mjs                  # dry run is the default; reads only
```

`pull-world.sh` with **no argument** defaults to the rehearsal world, which is the one you
are about to lose. Passing the launch world name here fetches nothing: `Eilif` is not on
the box yet.

The third copy is the one no script takes: **the nest**, over SFTP, before the panel Steam
Update at step 8. `pull-world.sh` takes the `.db`/`.fwl` pair and `db-snapshot.mjs` takes
the database, but neither preserves `BepInEx/` (every plugin and cfg, including the V+
install and the working 0.221.12 builds, and `vplus-data/` — the T-3 audit's read-only
listing found that one **under** `BepInEx/`, which the recursive `get` below covers either
way), `BepInEx/plugins/WebMap/map_data/`, or the panel's own `Backups/`. The Steam Update is one
way, and the rollbacks at steps 9, 10, 12 and 14 all name "the step 6 nest copy".

**There is no script for this one, so here is the command.** Same credential pattern as
`pull-world.sh` (the password is read out of the poller `.env` and never echoed):

```bash
NEST=~/valheim-nest-backups/$(date +%Y%m%d-%H%M); mkdir -p "$NEST"
export SSHPASS="$(sed -n 's/^SFTP_PASSWORD=//p' services/log-poller/.env | sed 's/^["'"'"']//; s/["'"'"']$//')"
sshpass -e sftp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -P 8822 \
  charless3@191.101.30.229 <<EOF
ls -la 191.101.30.229_6028/
ls -la 191.101.30.229_6028/Backups/
get -r 191.101.30.229_6028/BepInEx      $NEST/BepInEx
get -r 191.101.30.229_6028/worlds_local $NEST/worlds_local
EOF
du -sh "$NEST"/*
```

The heredoc is **unquoted** on purpose so the shell expands `$NEST` before sftp sees it —
sftp's batch mode does no variable expansion of its own. This is the same shape
`scripts/pull-world.sh` uses. Add
`get -r 191.101.30.229_6028/Backups $NEST/Backups` if the first `ls` shows the panel's
`.7z` archives are worth the minutes.

**Size and time, measured rather than guessed.** `worlds_local` alone was **78 MB** on
2026-09-05 (sum the sizes in the listing `verify-restart.sh` already prints: two `Dedicated`
worlds at ~18.5 MB each plus six `EilifRehearsal` copies at 4.4 MB). `BepInEx/` adds roughly
25 MB — the V+ DLL 4.6 MB, `plugins/MMHOOK/` about 6.5 MB, and a 4.5 MB `map.png` per world
under `WebMap/map_data/`. `Backups/` is the unknown; size it with the `ls` above before
committing to it. The link runs about **0.8 MB/s** (the 6-hourly world backup moves 4.4 MB
in ~5.5 s including the handshake), so roughly **100 MB in two to three minutes** — easily
inside the +90 minute window. **Do not `get -r` the whole nest**: that pulls the Valheim
server install itself, hundreds of megabytes that the Steam Update replaces anyway and that
Steam can re-download, and it would put this step into the tens of minutes.

**Look for:** a new pair under `~/valheim-world-backups/`, a new dump under
`~/valheim-db-backups/` with a `manifest.json`, and in the nest copy specifically
**both `BepInEx/plugins/ValheimPlus.dll` and `BepInEx/config/valheim_plus.cfg` present**
(that is the pair step 10's rollback restores, and looking for it now is also how you learn
before the point of no return that V+ is a loose file and not a folder — see step 10). Then
the preview's row counts pasted into the tracker.

**If it fails:** hold here. Supabase is on the Free plan with no backups and no PITR. The
GTX panel only writes a `Backups/*.7z` at a Stop/Start, and the in-game
`*_backup_auto-*` files live on the same disk as the world. Saves are forward-only: a
world that has booted on 1.0 cannot be opened by 0.221.12 again.

**Rollback:** free. This is the last step that is.

> **The `POST-WIPE CHECKLIST` the dry run prints was reconciled with this file on
> 2026-09-06.** That block (printed once here, once again after `--execute` at 20a) had been
> written 2026-09-04 for an ordinary wipe day and disagreed with this file eight ways. All
> eight were fixed in `scripts/launch-wipe.mjs` itself rather than annotated here, so what is
> on your screen and what is in this file now say the same thing. For the record, what
> changed:
>
> | It used to print | It now prints |
> |---|---|
> | "Full cutover sequence with owners: `docs/LAUNCH-WIPE.md`" | This file, named as the sequence of record. |
> | Item 1, `bash scripts/pull-world.sh <World>` | No argument, with the reason: it defaults to the world on the box, and naming the world you are about to *create* fetches nothing. |
> | The panel work headed "AFTER the wipe" | Headed as steps 12 to 14, **before** the wipe at step 20, already done by the time the block prints. |
> | Item 2, "today only the Companion plugin injects" keep-gear | The panel tier has read `casual` since 2026-09-05 and the game grants it — but the tier belongs to the world, so re-set it on the new Start form. |
> | Item 2's V+ `[Chat]` line, a half-sentence with unbalanced parens | One instruction: leave `[Chat]` enabled, because server-wide `/s` shouts need it, and oath and pin capture read those shouts. |
> | Item 6, "`TITLE_CHANNEL` / any other `*_CHANNEL=server` line → **remove**" | **The one that would have cost something.** `services/discord-bot/src/index.js:229` and `:627` read `TITLE_CHANNEL === 'valheim' ? 'valheim' : 'server'`, so an **absent** `TITLE_CHANNEL` routes launch-night titles to `#server`. It now says SET it to `valheim`, and points at `cutover-env.sh --apply`, which does. |
> | Item 7, "Companion Client 0.3.0 if it shipped", no other pins | Points at `$M` in step 16 as the pin set of record; records that Client 0.3.2 is published and 0.3.3 staged. |
> | Item 11, "port 3000 closed" | Port 3000 will read **OPEN**: the ticket was skipped by decision, a known exposure and not a hold. Also: the plugin count is the one you wrote down, not a hard-coded 8. |
>
> Its restart-order half (items 8 to 10) and its "adjacent tables NOT touched" note were
> right all along and are reproduced at 20d and 20e.

> ### GO / NO-GO 1 — the point of no return
>
> Everything up to here is reversible. From step 8's Steam Update onward there is **no way
> back to 0.221.12** unless the GTX panel can pin the build, which it cannot today (the
> ticket was skipped). The only rollback from step 8 onward is the slip-to-Thursday
> branch, and even that needs the copies from step 6 to be real.
>
> Do not hand the panel to Charlie until all three copies exist.

---

## Step 7 — Panel Stop · **CHARLIE ONLY**

**Stop, never Restart.** Loaded plugin DLLs are file-locked on the Windows host, so this
is the only window in which anything in steps 8 to 12 lands.

**Look for:** the panel reads **Stopped** and stays there through step 12.

**If it fails:** nothing else in this lane is worth attempting. A DLL upload against a
running server silently fails.

**Rollback:** Start it again; nothing has changed yet.

---

## Step 8 — Panel Steam Update, then read the version back · **CHARLIE ONLY**

**Look for:** `console.log` reports the 1.0 version, **not** `0.221.12`. Nothing else in
this lane is worth doing until that line is right.

**If it fails:** the update did not take, or 1.0 broke dedicated servers outright. That is
a **slip to Thursday** trigger, not something to debug at 11:00.

**Rollback: none.** This is the irreversible step. The only path back to 0.221.12 is a
fresh box built from the step 6 copies, which is the Thursday branch.

---

## Step 9 — Swap the two server DLLs · **CHARLIE ONLY**

Of the four rebuilt plugins, two are server-side: `EilifCompanion.dll` and
`EilifBoards.dll`, staged at step 4 with their md5s. Upload with a **retrying** loop; the
Windows file lock can outlive the process by a few seconds.

**Look for:** the md5 of each uploaded file matches the staged one.

**If it fails:** retry. If the lock persists, the panel did not really stop — go back to
step 7.

**Rollback:** re-upload the 0.221.12 DLLs from the step 6 nest copy. They will not load on
a 1.0 server, so in practice this rollback only exists as part of the Thursday branch.

---

## Step 10 — Remove ValheimPlus · **CHARLIE ONLY**

If V+ still has no 1.0 build: delete the **file** `BepInEx/plugins/ValheimPlus.dll` and
leave `BepInEx/config/valheim_plus.cfg` out. **Not optional once the pack drops V+** —
`enforceMod = true` makes the two a matched pair, and a box still running V+ refuses every
client the new pack produces.

> **It is a loose DLL, not a directory.** There is no `BepInEx/plugins/ValheimPlus/` on the
> box and never has been; V+ prints its own install path on every boot and it reads
> `…\BepInEx\plugins\ValheimPlus.dll` (captured 2026-09-01 in the boot log
> `verify-restart.sh` pulls, re-read 2026-09-06). Its config is a loose file too:
> `…\BepInEx\config\valheim_plus.cfg`. `docs/PACK.md` rule 6 said "directory" as well and
> was corrected in the same pass; **`scripts/mint-pack.mjs:800` still prints the folder form
> in its checklist banner** and is another track's file to fix.

**Look for:** `BepInEx/plugins/` no longer holds a `ValheimPlus.dll` (the other entries
there are directories — Advize-PlantEverything, ArgusMagnus-ServersideQoL, AzuCraftyBoxes,
EilifBoards, EilifCompanion, GsValheimStatsEmitter, MMHOOK, WebMap — and none of them is
V+), and step 13's first `Loading [...]` list does not mention `Valheim Plus`.

**If it fails, i.e. V+ ships a 1.0 build after all:** keep V+, and drop `--no-vplus` and
`--fallback on` from every mint command at step 18 — use them together or neither. Skip
step 11 as well: V+ keeps the cap, and the Companion refuses to apply `[ServerFallback]`
while V+ is present.

**Rollback:** restore `ValheimPlus.dll` (and `valheim_plus.cfg`) from the step 6 nest copy.
The V+ DLL that comes back is a 0.221.10-targeted build that will not load on 1.0, so this
too is really the Thursday branch.

> **V+ `[Chat]`:** while V+ is installed, `[Chat] enabled = true` must stay on — it is the
> server-wide `/s` shout feature (shoutDistance 1e6). **Never disable it.** On a
> `--no-vplus` launch the line is moot: shout range goes back to vanilla, and the GO post
> has to say so. Companion 0.3.1+ captures chat and oaths from a Prefix that runs before
> the V+ patch, so the hook itself does not depend on V+.

---

## Step 11 — Put the player cap back · **CHARLIE ONLY**

Deleting V+ takes the cap down to the vanilla **10** and nothing puts it back on its own.
Eilif Companion 0.3.3's `[ServerFallback]` is what lifts it, and it ships
`Enabled = false`. BepInEx only *writes* that section on the first boot of the new DLL, so
it **cannot be edited after the Start** — the file has to be put there by hand, now.

Upload `BepInEx/config/media.blockspace.eilif.companion.cfg` carrying, alongside whatever
the existing file already holds:

```ini
[ServerFallback]
Enabled = true
MaxPlayers = 20
```

20 is the plugin's own default, the value the V+ cfg on the box was set to, and the value
already in `config/server.ts` `MAX_PLAYERS`. It is the "nothing changes" answer. Whatever
number is chosen here is the same number at step 18 (`--cap`) and step 19 (`MAX_PLAYERS`).

**Look for, in step 13's first boot log:**

```
[Eilif] ServerFallback: player cap 10 -> 20
```

**If it says something else:**

| Line | Means |
|---|---|
| `ServerFallback: disabled (ValheimPlus present).` | step 10 did not happen |
| `ServerFallback: OFF and no ValheimPlus installed. This world is capped at the vanilla 10 players.` | the cfg did not take. **This is the one that quietly refuses viking number eleven at the door.** |
| `ServerFallback: Enabled=true but NO patch site was found.` | the 1.0 IL moved. Cap is still 10. Read the errors above it. |
| a `REFUSING to apply` warning block | `Enabled = true` **and** V+ is still installed. Both would rewrite the same instruction in `ZNet.RPC_PeerInfo` with no defined order. |

**If it fails:** either fix the cfg in another stopped window, or drop `MAX_PLAYERS` and
the GO post's cap claim to 10 and say so. Do not leave the site advertising 20 while the
box enforces 10 — the eleventh player is simply told the server is full.

**Rollback:** set `Enabled = false` in the same file at the next stopped window.

---

## Step 12 — Sweep the box, then upload the launch world · **CHARLIE ONLY**

Still stopped. **Valheim auto-restores from leftover `.old` and `*_backup_auto-*` files
and resurrects the old world.** This step is mandatory, not cosmetic.

Delete, in `worlds_local/`:

- `Dedicated.db`, `Dedicated.db.old`, `Dedicated.fwl`, `Dedicated.fwl.old` — the retired
  test world; an off-box copy already exists at
  `~/valheim-world-backups/Dedicated-final-20260823/`
- `*.old` for **every** world
- `*_backup_auto-*` for **every** world, both the `.db` and the `.fwl`
- `EilifRehearsal.json` — plaintext world metadata containing the **seed**. The launch
  world's `.json` must never leave the box either.

and elsewhere on the host:

- `BepInEx/plugins/WebMap/map_data/EilifRehearsal/` (and `…/Dedicated/`)
- `vplus-data/EilifRehearsal_mapSync.dat` — **look under `BepInEx/` for this one.** The T-3
  audit's read-only SFTP listing found it at `BepInEx/vplus-data/EilifRehearsal_mapSync.dat`
  (92 KB) and found no `vplus-data` at the nest root, so the bare relative path this list
  used to give sends you to a directory that is not there. `docs/LAUNCH-WIPE.md` (step 5's
  sweep list) and `scripts/launch-wipe.mjs`'s printed checklist carry the same bare path.

Then, in the same window:

- **Upload the launch world's `.fwl` and `.db` together, never one alone.** An fwl without
  its db gives `MissingDB` and Valheim generates a *random* world under that name.
- Point the **GS Emitter** cfg at it: `BepInEx/config/net.cproudlock.gsvalheimstats.cfg`,
  `[General] World = Eilif`.
- Point the **Companion** cfg's world setting at it, in the same file you edited at
  step 11.
- WebMap: `always_map = false` while port 3000 is open. **Never `server_port = 0`** — it
  NREs during world load.

**Look for:** `worlds_local` contains exactly the launch pair and nothing else;
`map_data/` has no old world directory.

**If it fails:** a leftover pair is how the 08-23 wipe resurrected the old world. Re-sweep
before the Start rather than after.

**Rollback:** the deleted files are in the step 6 nest copy. The world upload is additive.

---

## Step 13 — Fill the Start form and Start · **CHARLIE ONLY**

World = `Eilif`. Death penalty = **Casual**. Combat = **default** (the recorded decision).
From here on it is Stop then Start, never Restart.

**Look for, in `console.log`:**

```
Get create world Eilif
Setting world modifier: DeathPenalty->casual
```

plus the 1.0 version line from step 8 and the `ServerFallback` line from step 11.

**If it fails:** **Casual is the only tier that grants `deathkeepequip`.** Easy and Very
Easy do not — gear survived the rehearsal only because Eilif Companion injected the key
after every boot, which is exactly what a failed 1.0 plugin load takes away. If the line
says anything but `casual`, stop and fix the form before anyone plays.

**Rollback:** Stop, fix the form, Start again. Cheap while nobody is on.

---

## Step 14 — Pull anything that failed to load, then Stop and Start again · **CHARLIE ONLY**

PlantEverything, ServersideQoL, AzuCraftyBoxes, WebMap and the GS Emitter are all
third-party and none are recompiled by us. Any of them can be the one that throws, and a
plugin that throws during load can take the world load with it, so removing it beats
debugging it today.

**Three of them are not free to pull.** Know the cost before you delete anything:

| Mod | What pulling it costs |
|---|---|
| **AzuCraftyBoxes** | It is also a **pack pin**, and its version has to move in lockstep with the server's copy. Pulling it takes the Alt+O unbind with it — the exact problem pack v11 was minted to fix — and means editing `MODS`, the pack templates and `config/mods.ts` by hand under time pressure. Only V+ has a drop flag. **Treat this as a vanilla-night trigger, not a quick fix.** |
| **GS Emitter** (`GsValheimStatsEmitter`) | It is the **sole** producer of the authoritative online roster, the world day, and the Valheim global keys that drive boss detection. Pull it and `server_status` is never written again: `/api/status`, the Hall, the online roster, the boss timeline and **every Great Deed** go dark, and step 20e's `--phase post-start` grades "world day ≥ 1" against a row nothing writes, so that gate can never pass. **Also a vanilla-night trigger, not a quick fix.** |
| **WebMap** | It is the sole producer of `BepInEx/plugins/WebMap/map_data/<World>/`. Pull it and `/map` is dark, and **20d step 3's gate ("only after `map_data/Eilif/` exists … and `/api/status` reports the new world's day") can never be met** — skip 20d step 3 entirely rather than waiting on it, leave `eilif-map-snapshot` stopped, and say in the GO post that there is no map tonight. |

PlantEverything and ServersideQoL are the two that really are free to pull.

**Look for:** a clean `Loading [...]` list and a world that finishes loading.

> ### If there are no `Loading [...]` lines at all
>
> One failing plugin shows up as one named failure. **No plugin lines at all** is a
> different fault: a **preload patcher** that throws aborts the chainloader before any
> plugin is reached. The box has one — `BepInEx/patchers/BepInEx.MonoMod.HookGenPatcher/`,
> which ships with the Grantapher ValheimPlus package, so **step 10 leaves it behind as an
> orphan** — plus its generated output in `BepInEx/plugins/MMHOOK/` (eight generated DLLs, the
> largest of them `MMHOOK_assembly_valheim.dll`) and the `BepInEx/cache/*.dat` caches.
> **All of that was generated against the 0.221.12 `assembly_valheim.dll` that step 8
> replaces**, and the boot log's own line is `HookGenPatcher: Already ran for this version,
> reusing that file` — it will happily reuse the stale set.
>
> The fix, in the same stopped window: delete `BepInEx/plugins/MMHOOK/` and
> `BepInEx/cache/*.dat` (both regenerate on the next boot, which takes longer than usual —
> that is expected), and on a `--no-vplus` night delete
> `BepInEx/patchers/BepInEx.MonoMod.HookGenPatcher/` along with V+, since nothing else on
> the box needs MMHOOK. Cheap to read now, expensive to work out at 12:30.

> ### If BepInEx itself moved
>
> `BepInExPack_Valheim` is pinned at **5.4.2333** (published 2025-08-29, over a year old at
> launch) in **nine** places (plus the Mac list on `/get-started`), and no script and no
> other doc mentions the `--bepinex` flag that `mint-pack.mjs` exposes. If denikson ships a 1.0 pack, bump them in this order:
>
> 1. `plugins/*/refresh-libs.sh` — `BEPINEX_VER="5.4.2333"`, **four copies**, one per plugin.
> 2. Re-run step 2 (`rebuild-plugins.sh`) so the plugins compile against the new
>    `BepInEx.dll` / `0Harmony.dll`.
> 3. `plugins/thunderstore/EilifPaths-1.5.0/manifest.json` and
>    `plugins/thunderstore/EilifCompanionClient-<ver>/manifest.json` — the `dependencies`
>    pin — **before** Charlie zips at step 16.
> 4. `scripts/mint-pack.mjs` `MODS` baseline, `scripts/launch-preflight.mjs`
>    `PACK_V12_PINS`, and `config/mods.ts` — **before** the mint at step 18. The Mac
>    "install these seven" list in `app/get-started/page.tsx` names the loader version too;
>    step 19's grep catches it.
>
> `mint-pack.mjs --bepinex <ver>` covers the pack side; the other eight are by hand. A
> client whose package manifest pins the **old** loader while the pack pins the **new** one
> installs both, which is its own mess — which is why item 3 has to happen before the zip.

**If it fails:** repeat, or take the vanilla-night branch.

**Rollback:** re-upload from the step 6 nest copy at a later stopped window.

---

## Step 15 — Read the boot and write down what actually loaded · Claude

Decide the pack contents from what loaded, not from what was intended.

```bash
bash scripts/verify-restart.sh Eilif
```

(`verify-restart.sh` takes a world name and **has no `--help`** — a flag is treated as a
world name and the script runs anyway against the live box.)

**Look for:** the game version line, one `Loading [...]` line per surviving plugin with its
version, `panel tier: casual`, `ingest status: 200`, the port-3000 check, and — the one
worth spelling out — the `[EILIF_KEY] runtime world keys (N): … deathkeepequip …` line.

**`plugin enforcement: not seen this boot` is the healthy reading, not a failure.** The
Companion only logs `[EILIF_KEY] enforced world key: deathkeepequip` when the key was
**missing** (`if (GetGlobalKeyExact(key)) continue;` — `EilifCompanionPlugin.cs:428`). With
the panel tier on Casual the game already grants it, so that line correctly never appears,
on the 9th or any other day. What proves keep-gear is armed is `deathkeepequip` showing up
in the **runtime world keys** list. That is the durable state the 2026-09-05 tier change
bought; the enforced line was the fragile one.

**Write the surviving plugin list down.** It is the input to step 18. The count was **8**
through the rehearsal; on 2026-09-09 it is **7** if ValheimPlus comes off and fewer if a
third-party mod was pulled at step 14. Compare against your written list, never against a
remembered number.

**Port 3000 will report OPEN.** The GTX ticket was skipped by decision. It is not a hold;
it is a known exposure (WebMap serves the full un-fogged map, `/config` and live player
positions to anyone).

**If it fails:** an SFTP auth failure here means the panel credentials moved. Check the
panel's default-credentials pane before retrying — repeated auth failures get this PC
banned.

**Rollback:** read-only. Free.

---

## Step 16 — Client zips to Charlie, and start the index clock · Claude prepares, **CHARLIE uploads**

Do this **as early as the boot allows**. The 40-to-80-minute listing lag is the longest
pole in the afternoon and nothing shortens it.

`--stage` has already put each client DLL in `plugins/thunderstore/<Name>-<ver>/` with the
manifest version bumped, **and that is all it writes.** Three things describe the release
and none of them can be built:

1. `README.md` — the package page, still a copy of the previous version's
2. `CHANGELOG.md` — same
3. the manifest **description** and **dependencies**

**Fourth, and it is the last chance:** `EilifPaths-1.5.0/README.md` carries **two em
dashes** (lines 5 and 27, both inherited verbatim from the published 1.4.0 page), and the
copy doctrine says player-facing copy carries no em or en dashes. Both are two commas'
worth of work. `EilifCompanionClient-0.3.3/README.md` and both CHANGELOGs are already
clean. A published Thunderstore version cannot be replaced, only deprecated — so the
manifest description, the dashes and the re-zip all happen in one sitting, before the
upload.

Fix all of it, then zip:

```bash
(cd plugins/thunderstore/EilifPaths-1.5.0 && zip -qr ../EilifPaths-1.5.0.zip . -x '*.zip' 'UPLOAD.md')
```

**`plugins/thunderstore/EilifPaths-1.5.0/` and its zip now exist** (staged 2026-09-05
evening against 0.221.12), alongside `EilifPaths`, `-1.1.0`, `-1.3.0`, `-1.4.0` and
`EilifCompanionClient-0.3.3/`, so the `zip` line above runs today. It is step 4 that
re-stages the directory, and only if the 1.0 rebuild changes the DLL — until step 4 has run
on the 9th, that zip is the **pre-1.0** build.

**Two of the three items above are done; one is not** (re-checked 2026-09-06):

| # | Item | State |
|---|---|---|
| 1 | `README.md` | **Done** (rewritten 2026-09-05 22:49). It now carries an "If ValheimPlus ever goes missing" section naming `[VPlusFallback]` in player-facing language, and `EilifPaths-1.5.0.zip` was re-zipped at 22:49 from the edited file — the README inside the zip and on disk are the same bytes. Nothing to redo. |
| 2 | `CHANGELOG.md` | **Done.** It documents `[VPlusFallback]` in full — every setting, and that they all stand down while V+ is loaded. |
| 3 | manifest **description** | **Outstanding.** The only difference from `EilifPaths-1.4.0/manifest.json` is `version_number`; the description is still the unchanged paths/stamina blurb and never says `VPlusFallback`. This is the string mod managers show under the package name. |

Thunderstore renders the **README** as the package page, not the CHANGELOG. The README is
now right; the **description is not**, and a published version cannot be replaced. Fix item
3 **before** the `zip` line, then re-zip.

The old one-line gate (`diff` the two READMEs) now passes and no longer covers the gap that
is still open. Check all three at once instead:

```bash
diff plugins/thunderstore/EilifPaths-{1.4.0,1.5.0}/README.md      # must NOT be empty (passes today)
diff <(python3 -c "import json;print(json.load(open('plugins/thunderstore/EilifPaths-1.4.0/manifest.json'))['description'])") \
     <(python3 -c "import json;print(json.load(open('plugins/thunderstore/EilifPaths-1.5.0/manifest.json'))['description'])")
                                                                  # must NOT be empty (FAILS today)
unzip -o plugins/thunderstore/EilifPaths-1.5.0.zip -d /tmp/p150 >/dev/null && \
  diff -r /tmp/p150 plugins/thunderstore/EilifPaths-1.5.0 -x '*.zip'   # zip matches the directory
```

`rebuild-plugins.sh --stage` refreshes the staging **directory** and never re-zips, and
nothing compares the two — so after step 4 runs on the 9th the directory holds the
1.0-compiled DLL while the same-named zip still holds the 2026-09-05 pre-1.0 build. The
third command above is what catches that.

To stage the directory on its own without a full rebuild pass:

```bash
bash scripts/rebuild-plugins.sh --only eilif-paths --stage
```

An EilifPaths 1.5.0 page that says nothing about `[VPlusFallback]` while the pack ships
`Enabled = true` is a disclosure gap, not a cosmetic one.

### Two uploads, not one — and neither version is published

Re-checked against the Thunderstore package API on **2026-09-06**:

| Package | Published latest | Staged in the repo | Upload needed? |
|---|---|---|---|
| `Eilif/EilifPaths` | **1.4.0** (2026-08-24) | **1.5.0** (`plugins/thunderstore/EilifPaths-1.5.0.zip`, 39,072 B) | **REQUIRED.** `--fallback on` is refused without `--paths 1.5.0` or newer, so a `--no-vplus` pack cannot mint at all until this is up. This is the longest pole in the day. |
| `Eilif/EilifCompanionClient` | **0.3.2** (2026-09-05 22:11 UTC) | **0.3.3** (`plugins/thunderstore/EilifCompanionClient-0.3.3.zip`, 29,676 B) | **Optional — Charlie's call, made before the 9th.** |

**The client decision, stated once.** The repo is at 0.3.3 because the 2026-09-05 hardening
pass changed the DLL, and 0.3.2 on Thunderstore is immutable. Two workable branches:

- **Pin 0.3.2** (published). `--companion-client 0.3.2` mints today. But
  `launch-preflight.mjs`'s built-in `PACK_V12_PINS` derives the client pin from the csproj,
  so it computes **0.3.3** and grades a pin the pack does not contain — **pass `--pins` at
  20c and 20e** or those gates FAIL on a phantom. You are already passing `--pins` on a
  `--no-vplus` night for the ValheimPlus entry, so this costs nothing extra.
- **Upload 0.3.3.** Then `$M` uses 0.3.3 and the gates grade what the pack holds. The two
  uploads **share one index window**, so putting both up together costs no extra clock —
  whereas discovering the second upload at 20c costs the full 40 to 80 minutes again with
  no way to shorten it.

The line that used to sit here — *"0.3.2 is live, so if the Client DLL did not change in
the 1.0 rebuild there is nothing to upload for it"* — is misleading and was removed: the
DLL **already** changed, before the 1.0 rebuild. What the 0.3.3 bump actually carries is
also more than the "startup health line" the facts block claims: it wraps `Update()` in a
rate-limited try/catch, and under 0.3.2 a throw there lands in Unity's loop, logs every
frame in the player's log and stops that player's map reports permanently. On a
recompile day that is the argument **for** uploading 0.3.3, not against it.

> ### If EilifPaths 1.5.0 was already published before the 9th
>
> Uploading it early is the obvious way to take the 40-to-80-minute lag off the critical
> path, and it has a trap in it. **A published Thunderstore version cannot be replaced.**
> `EilifPaths.csproj:8` is pinned at `<Version>1.5.0</Version>`, so step 2 rebuilds *1.5.0*
> against the 1.0 assemblies — a different DLL under a version number that is already taken.
> It differs for two independent reasons, and `rebuild-plugins.sh --help` documents both:
> the 1.0 assemblies change the compiled code, and the .NET 8 SDK's SourceLink stamps
> `AssemblyInformationalVersion = "1.5.0+<HEAD sha>"`, which moves on the 9th no matter what.
>
> A pack pinning `--paths 1.5.0` would then hand every player the **pre-1.0** client DLL
> while the server runs 1.0. So if 1.5.0 is already up when the morning starts:
>
> 1. bump `plugins/eilif-paths/EilifPaths.csproj` to `<Version>1.5.1</Version>` **before**
>    step 2, so the rebuild and the stage both carry the new number;
> 2. upload `EilifPaths-1.5.1` here;
> 3. change `--paths 1.5.0` to `--paths 1.5.1` in `$M` where it is defined at step 16;
>    step 18 reuses the same `$M` on all three of its lines.
>
> `--fallback on` accepts 1.5.1 for the same reason it accepts 1.5.0: it refuses anything
> **older** than 1.5.0, because that is where the `[VPlusFallback]` section arrived.
>
> The same rule applies to `EilifCompanionClient`: 0.3.2 **is** published and immutable. The
> 2026-09-05 hardening already changed the DLL, so the repo is at **0.3.3** with its zip staged.
> If the 1.0 rebuild changes it again, that is 0.3.4, never a re-upload.

Then spend the wait on the one link no script can check — mint under a throwaway profile
name and import it in r2modman by hand (Settings → Import/Export → Import profile), then
delete the profile:

```bash
M="--world Eilif --paths 1.5.0 --companion-client <ver> --no-vplus --fallback on --cap 20"
node scripts/mint-pack.mjs $M --profile-name 'Eilif TEST'
```

**Look for:** the package page shows the new version, and the throwaway profile imports
with every mod and the cfgs already filled in.

**If it fails:** an upload that will not land, or an index that has not caught up by 15:00
CT, is a **vanilla-night** trigger. Nothing about a slow index is broken and re-minting
does not help.

**Rollback:** a Thunderstore version cannot be unpublished, only deprecated. Get the
README and manifest right before the upload, not after.

> **A TEST mint is indistinguishable from a real one once it leaves the screen.** The
> bytes uploaded are deliberately identical to what `--publish` uploads; "TEST" is a label
> in our terminal and nowhere else. A stray paste into Discord is unrecoverable. Never
> give a TEST code to anyone.

---

## Step 17 — 15:00 CT: go / no-go · **CHARLIE ONLY**

The deadline is the point: it leaves two hours to execute whichever branch is picked, and
it stops the afternoon from drifting into a decision made at 17:15 with the crew watching.

**GO-A — the plan above.** Continue to step 18.

**Vanilla night (GO-B).** The server runs 1.0 with `BepInEx/plugins/` moved aside, players
launch plain Valheim with no pack at all, and the cap is 10. Pick this when the game is
fine but our side is not: a plugin will not compile, a third-party mod takes the world
load down, or the Thunderstore index has not caught up. It costs the dashboard stats,
in-game voice, oaths, pins, boards and the map. The wipe, the world, the Casual tier and
the Discord side all still happen exactly as written. Then:

- add `--posture GO-B` to **every** `launch-preflight.mjs` run so the mod-dependent checks
  report instead of failing, and
- pass `--pins` with only the mods actually shipped — preflight's built-in `PACK_V12_PINS`
  still contains ValheimPlus.

**Slip to Thursday.** Same crew, same plan, one evening later. Pick this when the problem
is the game or the box rather than our mods: the Steam Update failed, 1.0 broke dedicated
servers outright, the world will not load, or the 1.0 save format needs work (PTB 0.221.13
replaced the `.db`/`.fwl` pair with a folder per world; whether that landed in 1.0 is
unconfirmed — `pull-world.sh` already asks for both forms). A night nobody can play beats
a rushed cutover that loses the world.

Post whichever it is in `#valheim` **at the moment it is decided.** Copy: vault
`10-Launch-Comms-2026-09-09.md` piece 4, variant A (vanilla) or B (Thursday).

---

## Step 18 — Wait for the index, then mint pack v12 · Claude

A code minted inside the listing window fails for every player with "mod not found".
Rehearse until it clears, then test-mint, then publish. **All three lines, in order.**

```bash
# $M is the flag set from step 16
node scripts/mint-pack.mjs $M --dry-run
node scripts/mint-pack.mjs $M
node scripts/mint-pack.mjs $M --publish --version-label 'Pack v12 · Sep 9'
```

The middle line is the test mint: it uploads and byte-compares the round trip without the
code being one a player can be given. Do not skip it to save five minutes; the alternative
is that the first real upload is also the published one.

The flags, and why each is refusable:

| Flag | What it does | Refusal |
|---|---|---|
| `--no-vplus` | drops the ValheimPlus entry from `export.r2x` **and** `config/valheim_plus.cfg` from the pack | none, but prints the reminder that the box must not run V+ either |
| `--fallback on` | sets EilifPaths `[VPlusFallback] Enabled = true` | **refused without `--paths 1.5.0` or newer.** Verified: `--fallback on writes the [VPlusFallback] section into the EilifPaths cfg, but this pack pins EilifPaths 1.4.0, which has no such section` |
| `--cap 20` | prints the number instead of the rule in the checklist | none |
| `--publish` | the real mint | **refused without `--version-label`**, and refuses `--skip-index-check` outright |

Use `--no-vplus` and `--fallback on` **together or neither**: a fallback alongside a V+ pin
makes the two stack, and both the minter and the plugin warn about that pairing. The pack
pins only `Enabled` on purpose — EilifPaths 1.5.0 binds thirteen keys in that section and
their plugin defaults already match the V+ cfg on the box, so BepInEx appends the other
twelve at first run. `--paths-cfg-version` is **not** needed: the cfg's writer header moves
to 1.5.0 on its own.

Drop a mod that did not survive step 14 by leaving its pin out of `config/mods.ts` and off
the pack. **Only V+ has a drop flag,** because only V+ was expected to die.

**Look for:** every row reads `ok / ok`, the round trip is clean, and `receipt.json`
records the pins, the drops and the fallback mode.

**If it fails:** a `404` in the package column means that version is not uploaded (step 16).
A `skipped`/stale listing-index column means the lag has not cleared — wait, do not
`--skip-index-check` (it is refused with `--publish` anyway). If the wait runs past 15:00
CT that is the vanilla-night branch, not a reason to publish anyway.

**Rollback:** a published code cannot be withdrawn, but it can be superseded: mint again
and repost. `MODPACK_PROFILE_CODE` in `config/server.ts` is what the site hands out, so a
bad code is one config edit and a deploy away from being unreachable.

---

## Step 19 — Rebuild the Mac config bundle, then the site config and deploy · Claude; deploy is **CHARLIE's trigger**

**Copy the `build-config-bundle.mjs` command the mint printed** rather than retyping it. It
forwards the world, the ingest URL, every changed pin and both new flags, which is what
keeps the bundle and the pack identical. It is printed **only in the `--publish` branch**,
so it appears after step 18's third line and nowhere earlier. Append the two required
arguments it leaves as placeholders:

```bash
node scripts/build-config-bundle.mjs --world 'Eilif' --paths 1.5.0 --companion-client <ver> \
  --no-vplus --fallback on --pack-number 12 --pack-date 'Sep 9, 2026'
```

`--pack-number` and `--pack-date` are **required**; without them the script prints usage
and exits 2. The script refuses to overwrite an existing bundle zip of that number
(`--force` to mean it), so a rehearsal cannot quietly rewrite the live v11 zip.

**Look for:** the printed entry list has no `valheim_plus.cfg`, and the `README.txt`
inside the zip says "six settings files" and does not name ValheimPlus anywhere. That
README is the only instructions a Mac player gets.

Then the site config:

- `config/server.ts` — `MODPACK_PROFILE_CODE` (the code from step 18),
  `MODPACK_VERSION_LABEL` (`Pack v12 · Sep 9` — bump it every single time; it is the only
  way a returning player can tell whether their pack is current), `LAUNCH_NOTICE` if
  Charlie has reversed the no-banner decision, `DISCORD_URL`, and `MAX_PLAYERS` = **the
  same N as step 11** (it already reads **20**, which matches the `--cap 20` posture; it is
  only an edit if the cap changed).
- `config/mods.ts` — every version that moved, **and delete the rows for mods this pack no
  longer ships**, or `/mods` advertises a mod nobody has.
- `app/get-started/page.tsx` — **three** edits, not two. Do not trust this count either:
  **grep the file for every pinned version number before you deploy.**

  ```bash
  grep -n "CONFIG_BUNDLE_URL\|Eilif Paths 1\.\|GsValheimStatsClient 0\.\|ValheimPlus (Grantapher)" app/get-started/page.tsx
  ```

  1. `CONFIG_BUNDLE_URL` (line 66) at the new bundle file.
  2. The Mac path's hard-coded "install these seven" mod list (lines 427-432, under the
     `CUTOVER ANCHOR` comment at line 409). That list names ValheimPlus by hand, so a Mac
     player who follows the page installs V+ and is then refused by the box — `enforceMod`
     working exactly as designed, on the one night nobody will read it that way. Drop the
     name and the word "seven" with it.
  3. **The update card's self-check sentence, ~180 lines below the anchor** (lines 609-610,
     paragraph 605-611): *"Installed: Eilif Paths 1.4.0 and GsValheimStatsClient 0.2.12
     means you are on {MODPACK_VERSION_LABEL}."* `MODPACK_VERSION_LABEL` moves at this step
     and those two numbers do not, so the moment the label reads `Pack v12 · Sep 9` the page
     tells a viking still on **v11** that they are current — on the one night an old pack
     gets them kicked by the `enforceMod` version check. **Eilif Paths becomes 1.5.0 in v12;
     GsValheimStatsClient stays 0.2.12.** Either update the number or, better, drop both
     numbers and point at `/mods`, which is config-driven and updates itself.

  The `CUTOVER ANCHOR` comment in the file lists only the first two, and so do
  `docs/PACK.md` step 3b and `mint-pack.mjs`'s printed checklist. Three procedural sources,
  one blind spot; the grep above is the only check that survives the next added pin.

  Leave the old zip in place until the new build is live so no link 404s mid-deploy.
- **Vercel** — `GS_EXPECTED_WORLD` = `Eilif`.

Then, Charlie's call to trigger:

```bash
vercel deploy --prod --yes --scope charlie-9292s-projects
```

**Look for:** `/mods` shows the new pack label and the surviving mod list.

**If it fails:** the deploy blocks with `TEAM_ACCESS_REQUIRED` when the git commit author
is not `charlie@blockspace.media`. A Vercel env edit does nothing until a deploy, and
`NEXT_PUBLIC_SUPABASE_URL` and the anon key are **baked in at `next build` time** — there
is no restart that picks up an env change.

**Rollback:** promote the previous deployment in the Vercel dashboard. The env value stays;
re-deploying the old build simply ignores it.

---

## Step 20 — The wipe, the reverts, and the restart · Claude

**Nothing here is skippable, and the order inside it is load-bearing.**

### 20a — wipe for real

```bash
node scripts/launch-wipe.mjs --execute --i-mean-prod
```

**Exactly this command, with no other flags.** `--i-mean-prod` is **required** for every
`--execute` against a non-loopback Supabase URL; without it the script refuses and prints
the target it was about to wipe. In particular **no `--state-dir`**: that flag is
rehearsal-only and is refused outright against production, because it would clear every row
while deleting none of the three live state files and leave the bot holding the pilot's
`announcedBosses`.

The banner prints the target URL, where that URL came from, and which directory the local
state files will be deleted from, before it counts a single row. **Read those three lines
every time.** The state-file line must read `(repo root — the LIVE services' own files)`.

Then type `WIPE` at the prompt.

**Look for:** the wipe's own summary — a deleted count per table, both state files gone,
buckets emptied.

**If it fails:** it still refuses while a hard-gate unit (`eilif-discord-bot`,
`eilif-stats-parser`) is active. Re-check step 5.

**Rollback: none.** These are real `DELETE`s against production, not soft deletes. The
step 6 Supabase dump is the only copy.

> **Why the wipe runs here and not before the Start.** Between the panel Start at step 13
> and this line, the GS Emitter has been posting to `/api/gs-ingest`, so `server_status`
> and a few `player_stats` rows exist and the wipe deletes them. **That is intended.** The
> Emitter re-reports within a minute, and the poller and bot are still stopped so nothing
> else is writing. What must **not** happen is a real player joining before this step:
> their session and player rows would be wiped with the rest, and the poller is not running
> to re-derive them. **Hold the GO post until 20d is done.**

> **The `POST-WIPE CHECKLIST` prints again here.** Same block as at step 6, reconciled with
> this file on 2026-09-06 and safe to read now. Two things about it are still worth knowing
> at 20a: its panel half (item 2) describes steps 12 to 14, which you finished hours ago, and
> its item 6 is `cutover-env.sh --apply`, which is 20b below — so do not hand-edit the `.env`
> files off the printed list. Items 1 and 7 were already done at steps 6 and 18.

### 20b — revert the pilot overrides

```bash
bash scripts/cutover-env.sh Eilif            # dry run: read the diff
bash scripts/cutover-env.sh Eilif --apply    # writes both .env files, fixes the unit, daemon-reload
```

`--apply` sets `RECAPS_START=2026-09-09` and `TITLE_CHANNEL=valheim` in
`services/discord-bot/.env`, deletes the `RECAP_CHANNEL` / `MILESTONE_CHANNEL` /
`OATH_CHANNEL` / `BOSS_CHANNEL` pilot lines, sets `MAP_REMOTE_DIR` in
`services/log-poller/.env`, removes `Environment=RECAPS_START=` from
`/etc/systemd/system/eilif-discord-bot.service` and reloads systemd. **It restarts
nothing.**

`TITLE_CHANNEL` is set rather than deleted on purpose: the bot reads it as
`TITLE_CHANNEL === 'valheim' ? 'valheim' : 'server'`, so an unset value routes titles to
`#server`.

**Look for:** `unit line removed + daemon-reload done` and the restart-order reminder. The
script **exits non-zero** if it could not edit the unit — without passwordless sudo it
prints the two commands to run by hand, and the unit's own `Environment=RECAPS_START`
keeps winning over `.env` until they are run.

Three things `cutover-env.sh` **cannot** do, which it prints:

1. Vercel `GS_EXPECTED_WORLD` plus a deploy — done at step 19.
2. The GS Emitter cfg `World =` on the box, in a stopped window — done at step 12.
3. The pack mint — done at step 18.

**Also not automated anywhere:** rotate `GS_EMITTER_TOKEN` and `VOICE_API_TOKEN` to fresh
values in **three** places each — the cfg on the box, Vercel, and `.voice-token`. The box
half needs a stopped window, so either do it at step 12 or accept that the pilot tokens
carry into launch night.

**Rollback:** the `.env` edits are idempotent and reversible by hand; the unit line can be
put back. Nothing here is destructive.

### 20c — the post-wipe gate

```bash
node scripts/launch-preflight.mjs --world Eilif --phase post-wipe
```

**Two FAILs here are expected on 2026-09-09 and are not holds.** The phase was written for
a wipe that happens *before* the panel Start, and its own banner says so
("the last gate before the panel Start"). On this sequence the box is already up:

| Check | Why it FAILs anyway |
|---|---|
| `world day zeroed by the wipe` | the wipe zeroes `server_status.world_day`, but the Emitter re-reports the live day within about a minute. Run this within 60 s of 20a to see it PASS; after that, read it as expected. |
| unit `eilif-*` stopped | still correct at this point — the services start in 20d. If you run post-wipe *after* 20d, all three flip to FAIL for the same reason. |

**Port 3000 is the third expected FAIL** and is not in that table because it FAILs in every
phase, not just this one. It is a known exposure by decision (see the Hold rules at the top);
`launch-preflight.mjs` grades it WARN since 2026-09-06, but an older copy prints
`FAIL port 3000 closed` and the red HOLD banner with it. Three expected complaints on a
perfect night, then, not two.

Everything else is a real gate: zero rows, local state files gone, the launch world in
`worlds_local`, the poller's `MAP_REMOTE_DIR` and the bot `.env` reverted, and the pack
pins live on Thunderstore.

Add `--posture GO-B` on a vanilla night. Pass `--pins` whenever the pack dropped a mod —
preflight's built-in `PACK_V12_PINS` still contains ValheimPlus, so a `--no-vplus` pack
grades a pin it does not have.

### 20d — restart the services, in this order

1. **`eilif-log-poller`** — confirm a join line in its journal.
2. **`eilif-discord-bot`** — **only after** `select name, is_killed from bosses` is all
   `false` **and** `services/discord-bot/state.json` is absent. Read its startup log: no
   announced boss, correct `RECAPS_START`, no channel overrides. Manual boss marking, if
   ever needed, is `cd services/discord-bot && node scripts/mark-boss.js "<Boss>"` — that
   file lives under `services/discord-bot/scripts/`, **not** repo-root `scripts/`.
3. **`eilif-map-snapshot` LAST**, and only after `map_data/Eilif/` exists on the host,
   `MAP_REMOTE_DIR` points at it, and `/api/status` reports the new world's day. Then watch
   for `day 1 framed` within 5 minutes.

`eilif-stats-parser` is **not** in this list — retired 2026-08-23. The wipe still hard-gates
on it deliberately, in case someone re-enables it.

Warm the skald model before the event so the first boss retelling does not load a 9 GB
model onto the gaming GPU mid-fight:

```bash
ollama run qwen3:14b ''            # matches OLLAMA_MODEL in services/discord-bot/.env
```

Starting the map snapshotter early is the 08-23 mistake: that wipe left `server_status`
alone and the snapshotter framed the *old* world's day 64 four minutes later. The wipe now
zeroes it, which is the check 20c grades.

### 20e — the live gate

```bash
bash scripts/verify-restart.sh Eilif
node scripts/launch-preflight.mjs --world Eilif --phase post-start
```

`post-start` expects all three bridge units **running**, a world day **≥ 1**, and re-checks
the pilot overrides, the poller's `MAP_REMOTE_DIR`, the Vercel env names and the pack pins.
Add `--posture GO-B` on a vanilla night and `--pins` whenever the pack dropped a mod.

Then open `/admin/ops`.

**Look for:** all PASS except the known port-3000 exposure (a WARN, not a hold — see the
Hold rules at the top), and fresh heartbeats in the cockpit for **the poller, the bot and
the map snapshot**.

**Do not wait for both plugin heartbeats here — one of them cannot report yet.**
`companion-voice` has **never** reported a heartbeat in its life (every watchdog run says
`"neverReported":["companion-voice"]`, state `unknown`, and `lib/ops/watchdog.ts` sets
`alertsOnSilence: false` on that target deliberately, under the quiet-hall rule). The reason
is structural: the Companion's `PumpVoicePoll` returns early unless the server is ready
**and** at least one peer is connected, so the poll that records the heartbeat only happens
while somebody is in the world — and 20e runs **before** the GO post, with nobody on. So at
20e the honest expectation is:

| Cockpit component | Expected at 20e |
|---|---|
| `log-poller`, `discord-bot`, `map-snapshot` | **healthy**, fresh |
| `boards-plugin` ("Boards signs") | **healthy.** It polls `/api/boards` on a timer whether or not anyone is playing, so silence here IS a real signal. |
| `game-server` | **healthy** once the Emitter has posted (`[gs] ingest status: 200` at step 15) |
| `companion-voice` ("In-game voice") | **`unknown` — correct, not a fault.** It polls `/api/voice` only while players are online, so it turns healthy within a minute of the first join and not before. |

**Move the real voice check into step 22**, where a player is actually online. The
consequence of not doing that is worth naming: if the 1.0 recompile broke the voice half,
the cockpit shows the same `unknown` it shows tonight and the watchdog is designed never to
page about it. Also worth remembering while reading it — `VOICE_API_TOKEN` lives in **three**
places (the box cfg, Vercel, `.voice-token`), and rotating two of the three produces exactly
this silent-and-unalerted shape.

**Also expect one watchdog all-clear, and read the duration in it as fiction.** `ops_alerts`
is on the wipe's deliberate do-not-touch list next to `discord_events` and `ops_heartbeats`
(`scripts/launch-wipe.mjs:811`), so the watchdog's `state`, `signature` and `since` survive
step 20a untouched. Its recovery message therefore measures "down for X" from whenever the
first component went stale back at step 5, hours before the cutover, not from anything a
player saw. Post-launch it self-corrects on the next transition; nothing needs editing.

**If the watchdog workflow was disabled at step 5 for quiet, re-enable it now**, from the
GitHub Actions tab, and confirm the next scheduled run is green before anyone goes to bed.

---

**Voice targeting flag, set LAST.** `VOICE_TARGETING=1` in `services/discord-bot/.env` makes
second-person oath lines private (only the swearer sees them). Set it only after BOTH are true:
the box runs Companion 0.3.3 or later (grep the boot log for `voice targeting: supported`) AND the
site deploy carrying the `/api/voice` target field is live (it is, since 2026-09-06). The route
refuses to hand a targeted line to a plugin that did not advertise the capability, so the wrong
order costs silence, never a private line on everyone's screen. Then `sudo systemctl restart
eilif-discord-bot`. Leave it unset on a vanilla night.

**Prerendered pages after the wipe.** `/world`, `/events`, `/gallery`, `/oath`, `/map` and
the eight `/boss/<slug>` pages are ISR pages (revalidate 60 s) since the 2026-09-05 perf
pass, and the deploy at step 19 prerenders them against the **pre-wipe** database. Nothing
in this repo invalidates them, so they have to be walked until they turn.

**Do not count requests.** The first request past the 60 s window is served the stale copy
and only kicks off the rebuild behind it, but how many more it takes is a property of the
machine, not of the code. Both measurements, so nobody over-waits or under-waits from one
anecdote (`lib/data.ts` carries them too): on **production** one stale answer then fresh;
on a **cold local `next start`** two stale answers and only the third request carried the
new number. So reload until the page itself says the world is new. Budget three requests
past the window before you start worrying, and redeploy
(`vercel deploy --prod --yes --scope charlie-9292s-projects`) rather than waiting if it
will not turn after two minutes.

**Read it in a tab that was never opened before the wipe, or with `curl`.** Making a page
static also turns on Next's client Router Cache: production answers every one of these
routes with `x-nextjs-stale-time: 30` (measured again 2026-09-06; it was Next's default 300
until `next.config.ts` set `experimental.staleTimes.static = 30`). A tab that has already
been to `/world` is served the RSC payload it already holds for up to 30 s without asking
the server, so an already-open tab can read "the page did not turn" while the server is
fine. A hard reload, a fresh tab or `curl` beats it.

**Grade `/world` on its Great Deeds numbers, not on its boss row.** `/world` lags longest
because it sits behind **two** independent 60 s caches — the page's own ISR window and
`getMilestoneAggregates`' `unstable_cache` — so the ledger can trail the wipe by about two
minutes after the boss timeline has already turned over. The boss row is the surface that
turns **first**, which makes it the wrong thing to judge the wipe on. Look for the Earned
Deeds card reading **"Nothing earned yet"** with "The first deed is still ahead" under it,
and all **38** deeds sitting at zero in the upcoming list. Only then read `/map` for the new
world.

## Step 21 — Charlie's own last look · **CHARLIE ONLY**

Nothing to run. Confirm on the panel that the box reads **Started**, the world is `Eilif`,
and that the pack code you are about to post is the one in `config/server.ts` on the live
site — not the TEST code, not the one in your terminal scrollback.

---

## Step 22 — The GO post, then Session Zero · **CHARLIE posts**, Claude watches

Copy lives in the vault: `08-Dashboard/10-Launch-Comms-2026-09-09.md`, piece 3. Do not
rewrite it from memory at 17:20.

The post carries: the pack code, the version label, "r2modman: Settings, Import/Export,
Update profile from code" for anyone who already has a profile, the Get Started link for
Mac players, and a plain sentence about what changed — the cap, and which comforts are gone
tonight.

Write that sentence from `docs/PACK.md` rule 6's "gone tonight" list, not from memory. The
four everyone notices first: **weather damage on buildings, no area repair, dropped items
sinking, and shouts no longer crossing the map.** Worth one more line: the restored
comforts run on the machine that owns the object, so a fire or a berry bush inside the
zones the server owns around world origin behaves like vanilla. That is expected, not a
broken install.

Old-pack clients are kicked by the version check. That is expected; say so.

Then **Session Zero**: one test death on purpose, before anyone has anything to lose, then
the oath ceremony (**oaths must be shouted**: `/s /oath <your words>` — an unknown
`/command` is swallowed client-side), then the first tree.

**Look for:** someone other than you has connected; `/admin/ops` shows fresh heartbeats for
the poller, the bot and the map snapshot; **the cockpit's In-game voice component turns
healthy within a minute of the first join** (it reads `unknown` until then and that is
correct — see 20e); armor and held weapon survive the test death; and the oath reaches
`/oath` and `#valheim` within a minute. The oath test exercises the same plugin as the
voice, so if the oath lands and the voice component stays `unknown`, the voice half is the
thing to look at.

**If the test death drops gear:** the tier is not Casual. **Stop before anyone builds** and
go back to step 13.

**Meanwhile:** watch `#valheim` for import failures and `#server` for the chat mirror. If
the pack will not import *for anyone*, the listing index is still catching up. Nothing is
broken and re-minting will not help.

---

## No backup behind these four

This PC (Discord relay, map snapshots, voice) · the Companion plugin (keep-gear, oaths,
pins, positions) · the Supabase Free plan (no backups, no PITR) · the Vercel token and the
`charlie@blockspace.media` git author.

---

## Contradictions this file settled

Found 2026-09-05 by extracting the sequence from every source and diffing. Sources:
**A** `docs/LAUNCH-WIPE.md` launch-morning sequence · **B** `docs/LAUNCH-WIPE.md` "Order of
operations" · **C** `docs/PACK.md` "Re-minting: the launch-day sequence" · **D** the
printable HTML runbook · **E** vault `04-Launch-Readiness-Checklist.md` fast path ·
**F** vault `09-Handoff-2026-09-05.md` · **G** `CLAUDE.md` · **H** the scripts themselves.

| # | Contradiction | Sources | Settled as |
|---|---|---|---|
| 1 | **The wipe runs at position 3, before the panel Stop** | E | **Wrong.** The wipe runs after the Start and after the deploy (step 20). E is the 2026-09-04 order, superseded. |
| 2 | **`launch-wipe.mjs --execute` printed without `--i-mean-prod`** | D, E | **Would be refused.** The only correct form is `--execute --i-mean-prod` (step 20a). |
| 3 | **The launch world upload is missing from the stopped window** | A | Added as step 12. Verified: `worlds_local` has no `Eilif` today, so without this step the Start generates a random world. |
| 4 | **The sweep of `worlds_local` is missing from the stopped window** | A | Added as step 12 (A had it only in B, which sequences it after the wipe). |
| 5 | **`--phase post-wipe` is "the last gate before the panel Start"** | B, H | Impossible on this sequence — the Start is step 13 and the wipe is step 20. Resolved in 20c with the two expected FAILs named. |
| 6 | **"then `--phase post-wipe` all PASS"** | A, D | Cannot all-PASS on launch day: the Emitter re-reports `world_day` within a minute of the wipe. 20c says so. |
| 7 | **`MAX_PLAYERS` "reads 15 today"** | A, D, E, vault comms | **Stale.** It is **20** (`config/server.ts:8`, Charlie 2026-09-05), which already matches the `--cap 20` posture. |
| 8 | **PACK.md ends with "Stop then Start the server" after the deploy** | C | That is the ordinary re-mint day. On 2026-09-09 the Stop/Start is step 7 to 13, long before the mint. C now says so. |
| 9 | **Two panel Starts** | E | One Start (step 13), plus the conditional re-Start at step 14 if a plugin has to be pulled. |
| 10 | **The r2modman import "should land with all seven mods"** | C | Six on a `--no-vplus` pack. Step 16 says "every mod" instead of a count. |
| 11 | **Mint command pinned `--paths 1.4.0`, no `--no-vplus`, no `--fallback`** | F | Would mint a pack every client rejects. The flag set of record is `$M` in step 16. Same class of error as the one `cutover-env.sh` already carries a comment about. |
| 12 | **`cutover-env.sh` header says it prints "the two remote steps"** | H | It prints **three**. Comment corrected. |
| 13 | **`cutover-env.sh` prints `build-config-bundle.mjs --world $W` as if runnable** | H | It exits 2 without `--pack-number` and `--pack-date`. Step 19 carries the full form. Left in the script for the rehearsal track. |
| 14 | **`mint-pack.mjs --publish` checklist ends "deploy, then Stop/Start the server"** | H | Same as #8: wrong for launch day. Left as printed output (script logic is another track's scope); step 19 overrides it. |
| 15 | **Companion on the box is 0.3.0** | G | **Stale.** Verified live: **0.3.2**. The launch build is **0.3.3**. |
| 16 | **"Panel death penalty STILL easy" / keep-gear is plugin-only** | G | **Stale.** Verified live: panel tier `casual`, durable. |
| 17 | **Companion Client 0.3.0 "staged and zipped, not uploaded"** | G | **Stale.** `Eilif-EilifCompanionClient-0.3.2` is live on Thunderstore. |
| 18 | **`valheim-log-poller.service`** | `AGENTS.md` (76, 79), `services/log-poller/README.md` (44-50) | The live unit is **`eilif-log-poller.service`**. There is no unit by the old name. `docs/PROJECT.md` was corrected in the same pass and is **not** one of the stale sources. |
| 19 | **`LAUNCH_NOTICE` is "already set in `config/server.ts`"** | vault comms piece 1 | It is `''` by Charlie's 2026-09-05 no-banner decision. |
| 20 | **"`docs/LAUNCH-WIPE.md` step 16 already carries the edit"** | vault comms | It was step 17 there and is step 19 here. Cross-doc step numbers are why this file exists. |
| 21 | **`ServerFallback: disabled` is the failure line to grep** | A | Only when V+ is present. With V+ gone the line is the longer `OFF and no ValheimPlus installed…` warning. Step 11's table has all four. |
| 22 | **The step numbering itself** | A(19) B(8) C(9) D(12) E(12) | One sequence, 22 steps (plus step 0, which is not on the day). Everything else points here. |

Five more were found on the review pass and settled the same way:

| # | Contradiction | Source | Resolution |
|---|---|---|---|
| 23 | **Nobody owned generating the launch world** | none of them | It appeared as an upload in A and here, and as an open Charlie to-do in E, and in no sequence at all. **Step 0**, due 2026-09-08, with the 0.221.12-vs-1.0 tradeoff named. Without it the stopped window stalls after the point of no return. |
| 24 | **`launch-wipe.mjs`'s own `POST-WIPE CHECKLIST`** | H | Prints at step 6 **and** 20a and disagreed with this file eight ways, including telling the operator to **remove** `TITLE_CHANNEL` when an absent one routes titles to `#server` and `cutover-env.sh` sets it. **Fixed in the script itself on 2026-09-06** (the rehearsal track owned it): the printed block and this file now agree. What changed is tabulated at step 6. |
| 25 | **The watchdog is not mentioned anywhere in the sequence** | A carried the finding, no sequence carried the fix | Pings every 15 min from GitHub through a planned outage that runs from step 5 to 20d. Named at step 5 (what alerts, how often, why not to mute it) and at 20e (`ops_alerts` survives the wipe, so the all-clear's duration is measured from before the cutover). |
| 26 | **`EilifPaths 1.5.0` cannot be re-uploaded once published** | none of them | The csproj is pinned at 1.5.0 and SourceLink restamps on every HEAD move, so an early upload and the morning's rebuild are different DLLs under one immutable version. Branch added at step 16: bump to **1.5.1** and pin `--paths 1.5.1`. |
| 27 | **`docs/OPS-COCKPIT.md`'s launch-revert remediation** | one of the six sources, never reconciled | Listed only `RECAP_CHANNEL`, `MILESTONE_CHANNEL` and `RECAPS_START`, missed `OATH_CHANNEL`, `BOSS_CHANNEL` and `TITLE_CHANNEL` entirely, and pointed at the superseded vault outline. Now points at `cutover-env.sh --apply` and step 20b. |

### Corrected again on the T-3 re-audit (2026-09-06)

Ten more, all found by re-executing the steps rather than re-reading them. Each is fixed in
place above; this table is only the index.

| # | What this file said | Corrected to |
|---|---|---|
| 28 | Step 19: **"two edits, not one"** to `app/get-started/page.tsx` | **Three.** The update card's self-check sentence (lines 609-610) pins Eilif Paths 1.4.0 and tells a stale-pack player they are current. Step 19 now carries a grep instead of a count. |
| 29 | Step 20's page check: open each page **twice** and grade `/world` on its boss row | Do not count requests (production: one stale answer; a cold local build: two). Grade `/world` on its **Great Deeds** numbers, which sit behind a second 60 s cache and turn last. Read it in a never-opened tab or with `curl` — the client Router Cache is **30 s**, not the 300 s the old note assumed. |
| 30 | Step 10: delete the **directory** `BepInEx/plugins/ValheimPlus/` | It is a loose **file**, `BepInEx/plugins/ValheimPlus.dll`, and V+ prints that path itself on every boot. `docs/PACK.md` rule 6 fixed in the same pass; `scripts/mint-pack.mjs:800` still prints the folder form. |
| 31 | Step 16 table: the EilifPaths 1.5.0 README is outstanding, and one `diff` is the gate | The README was rewritten and re-zipped 2026-09-05 22:49. The **manifest description** is what is still outstanding, and the old `diff` gate now passes without covering it. Three checks replace it. |
| 32 | Step 16: "0.3.2 is live, so … there is nothing to upload" for the client | **Two uploads, not one.** EilifPaths 1.5.0 is required; EilifCompanionClient 0.3.3 is optional but the client DLL already changed. Pin 0.3.2 **and pass `--pins`**, or upload both together in one index window. |
| 33 | Step 14: only AzuCraftyBoxes is costly to pull | Three are. Pulling the **GS Emitter** stops the roster, the world day, boss detection and every Great Deed, and makes post-start preflight unpassable; pulling **WebMap** makes 20d step 3's gate unsatisfiable. Both are vanilla-night class, not quick fixes. |
| 34 | Nothing anywhere about HookGenPatcher, MMHOOK or the BepInEx cache | All three survive the Steam Update built against 0.221.12, and a thrown preload patcher presents as **no plugins at all**. Branch added at step 14, with the BepInEx-version-moved branch beside it. |
| 35 | Step 6's third backup: prose, no command, no size | A pasteable SFTP batch, a measured size (worlds_local 78 MB, BepInEx ~25 MB, `Backups/` to be sized on the day) and a rate (~0.8 MB/s), plus "do not `get -r` the whole nest". |
| 36 | No rule for **1.0 being late** | Two cutoffs in the shape-of-the-day table: 09:00 CT is tight, **noon CT is Charlie's hard cutoff (2026-09-06)** and vanilla night is called then rather than at 15:00. Charlie owns both numbers. |
| 37 | 20e: "fresh heartbeats … for both plugins" | `companion-voice` has **never** reported one and cannot before a player joins (`alertsOnSilence: false`, and the poll needs a connected peer). It reads `unknown` at 20e and that is correct; the real check moved to step 22. |

Also corrected in place, from the same pass: the Hold rules said **two** known-spurious
preflight FAILs where there are **three** (port 3000 is the third, a known exposure since
the GTX ticket was skipped on 2026-09-05); step 12's `vplus-data/…_mapSync.dat` sits under
`BepInEx/`; and step 15's `[EILIF_KEY]` Look-for now names the **runtime world keys** line,
because `enforced world key` correctly never prints while the panel tier is Casual.

---

**Still unverifiable from this PC, for Charlie:** the panel itself, the SFTP writes in
steps 9 to 12, the Thunderstore upload in step 16, and the `sudo` in step 5. Every command
in the Claude-owned steps was run with `--help`, `--dry-run` or no arguments on 2026-09-05
and accepted the flags as written.
