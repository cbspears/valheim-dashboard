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

---

## Hold rules — stop at any of these

- Any **FAIL** from `launch-preflight.mjs` for the phase you are in, except the two
  known-spurious ones named in step 20.
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
- On Thunderstore: `Eilif-EilifCompanionClient-0.3.2` is **live** (still works; 0.3.3 only
  changes the startup health line). `plugins/thunderstore/EilifCompanionClient-0.3.3.zip` and
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

The third copy is the one no script takes: **the whole server directory**, over SFTP,
before the panel Steam Update at step 8. `pull-world.sh` takes the `.db`/`.fwl` pair and
`db-snapshot.mjs` takes the database, but neither preserves `BepInEx/` (every plugin and
cfg, including the V+ install and the working 0.221.12 builds), `WebMap/map_data/`,
`vplus-data/`, or the panel's own `Backups/`. The Steam Update is one way.

**Look for:** a new pair under `~/valheim-world-backups/`, a new dump under
`~/valheim-db-backups/` with a `manifest.json`, an off-box copy of
`191.101.30.229_6028/` whose `BepInEx/plugins/` listing you have actually looked at, and
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

If V+ still has no 1.0 build: delete `BepInEx/plugins/ValheimPlus/` and leave
`valheim_plus.cfg` out. **Not optional once the pack drops V+** — `enforceMod = true`
makes the two a matched pair, and a box still running V+ refuses every client the new pack
produces.

**Look for:** the plugins folder no longer contains ValheimPlus, and step 13's first
`Loading [...]` list does not mention it.

**If it fails, i.e. V+ ships a 1.0 build after all:** keep V+, and drop `--no-vplus` and
`--fallback on` from every mint command at step 18 — use them together or neither. Skip
step 11 as well: V+ keeps the cap, and the Companion refuses to apply `[ServerFallback]`
while V+ is present.

**Rollback:** restore the folder from the step 6 nest copy. The V+ DLL that comes back is
a 0.221.10-targeted build that will not load on 1.0, so this too is really the Thursday
branch.

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
- `vplus-data/EilifRehearsal_mapSync.dat`

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

**One of them is not free to pull.** **AzuCraftyBoxes is also a pack pin**, and its
version has to move in lockstep with the server's copy. Pulling it takes the Alt+O unbind
with it, which is the exact problem pack v11 was minted to fix, and it means editing
`MODS`, the pack templates and `config/mods.ts` by hand under time pressure — only V+ has
a drop flag. **If Azu is the mod that will not load, treat that as a vanilla-night
trigger, not a quick fix.**

**Look for:** a clean `Loading [...]` list and a world that finishes loading.

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
version, `panel tier: casual`, `[EILIF_KEY]`, `ingest status: 200`, and the port-3000
check.

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

Fix all three, then zip:

```bash
(cd plugins/thunderstore/EilifPaths-1.5.0 && zip -qr ../EilifPaths-1.5.0.zip . -x '*.zip' 'UPLOAD.md')
```

**`plugins/thunderstore/EilifPaths-1.5.0/` and its zip now exist** (staged 2026-09-05
evening against 0.221.12), alongside `EilifPaths`, `-1.1.0`, `-1.3.0`, `-1.4.0` and
`EilifCompanionClient-0.3.3/`, so the `zip` line above runs today. It is step 4 that
re-stages the directory, and only if the 1.0 rebuild changes the DLL — until step 4 has run
on the 9th, that zip is the **pre-1.0** build.

**One of the three items above is done; the other two are not** (checked 2026-09-06):

| # | Item | State |
|---|---|---|
| 1 | `README.md` | **Outstanding.** `diff plugins/thunderstore/EilifPaths-1.4.0/README.md plugins/thunderstore/EilifPaths-1.5.0/README.md` is **empty**: it is still 1.4.0's page, word for word, and it never says `VPlusFallback`. |
| 2 | `CHANGELOG.md` | **Done.** It documents `[VPlusFallback]` in full — every setting, and that they all stand down while V+ is loaded. |
| 3 | manifest **description** | **Outstanding.** The only difference from 1.4.0's `manifest.json` is `version_number`. The description is the unchanged paths/stamina blurb. |

Thunderstore renders the **README** as the package page, not the CHANGELOG, so as things
stand the page Charlie publishes says nothing about the fallback at all. Fix items 1 and 3
**before** the `zip` line — `EilifPaths-1.5.0.zip` was built at 20:08 on 2026-09-05 from
these exact files and already carries the stale pair, so re-zip after editing. The one-line
check before you zip:

```bash
diff plugins/thunderstore/EilifPaths-{1.4.0,1.5.0}/README.md   # must NOT be empty
```

To stage the directory on its own without a full rebuild pass:

```bash
bash scripts/rebuild-plugins.sh --only eilif-paths --stage
```

An EilifPaths 1.5.0 page that says nothing about `[VPlusFallback]` while the pack ships
`Enabled = true` is a disclosure gap, not a cosmetic one.

**EilifPaths 1.5.0 is not on Thunderstore today** (verified 2026-09-05: the package API
404s that version; latest published is 1.4.0). `EilifCompanionClient 0.3.2` **is** live,
so if the Client DLL did not change in the 1.0 rebuild there is nothing to upload for it.

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
- `app/get-started/page.tsx` — **two** edits, not one: `CONFIG_BUNDLE_URL` at the new
  bundle file, **and** the Mac path's hard-coded "install these seven" mod list a dozen
  lines above it. That list names ValheimPlus by hand, so a Mac player who follows the page
  installs V+ and is then refused by the box — `enforceMod` working exactly as designed, on
  the one night nobody will read it that way. Drop the name and the word "seven" with it.
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

**Look for:** all PASS except the known port-3000 exposure, and fresh heartbeats in the
cockpit for the poller, the bot, the map snapshot and both plugins.

**Also expect one watchdog all-clear, and read the duration in it as fiction.** `ops_alerts`
is on the wipe's deliberate do-not-touch list next to `discord_events` and `ops_heartbeats`
(`scripts/launch-wipe.mjs:811`), so the watchdog's `state`, `signature` and `since` survive
step 20a untouched. Its recovery message therefore measures "down for X" from whenever the
first component went stale back at step 5, hours before the cutover, not from anything a
player saw. Post-launch it self-corrects on the next transition; nothing needs editing.

**If the watchdog workflow was disabled at step 5 for quiet, re-enable it now**, from the
GitHub Actions tab, and confirm the next scheduled run is green before anyone goes to bed.

---

**Prerendered pages after the wipe.** `/world`, `/events`, `/gallery`, `/oath`, `/map` and `/boss/<slug>` are ISR pages (revalidate 60 s) since the 2026-09-05 perf pass, and the deploy in step 19 prerenders them against the PRE-wipe database. The first request after the 60 s window is served the **stale** copy and only triggers the regeneration behind it — the **second** request is the fresh one, which is why the procedure here opens each page twice. So before the launch post: open `/world` and `/map` once, wait a minute, open them again, and read the SECOND render; confirm no boss is marked felled and the map shows the new world. If a page still shows the old world after two minutes, redeploy (`vercel deploy --prod --yes --scope charlie-9292s-projects`) rather than waiting.

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
the poller, the bot, the map snapshot and both plugins; armor and held weapon survive the
test death; and the oath reaches `/oath` and `#valheim` within a minute.

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

**Still unverifiable from this PC, for Charlie:** the panel itself, the SFTP writes in
steps 9 to 12, the Thunderstore upload in step 16, and the `sudo` in step 5. Every command
in the Claude-owned steps was run with `--help`, `--dry-run` or no arguments on 2026-09-05
and accepted the flags as written.
