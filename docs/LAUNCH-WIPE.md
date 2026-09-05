# Launch wipe — clearing the pilot data before 1.0 launch

`scripts/launch-wipe.mjs` clears the pilot/rehearsal test-world data out of prod
Supabase (project `syuwavxpmtdmxupxjzje`) so the dashboard starts clean on the
real launch world (2026-09-09). Full detail and rationale are in the script's
header comment — this is the short "when / in what order" runbook.

Last refreshed **2026-09-05** for the posture decision below (earlier pass:
2026-09-04, from the T−6 launch audit: findings launch-8, discord-1, launch-16,
launch-17, gtx-7, mods-6). The cutover step table with owners lives in the audit
report; this file is the wipe's own procedure, and the launch-morning sequence
it sits inside.

Two companion scripts check the steps below rather than replacing them:
`scripts/launch-preflight.mjs` (read-only; one PASS/FAIL/WARN line per T-0
precondition, run once per phase) and `scripts/rebuild-plugins.sh` (rebuilds all
four custom plugins for the 1.0 recompile, prints what to stage where, and with
`--stage` does the copying).

## The launch-morning sequence (2026-09-09)

**Decision of record, Charlie, 2026-09-05 08:00 CT.** Valheim 1.0 ships the
morning of Wednesday 9 September. The server goes to 1.0 **the same day**.
Kickoff is 17:00 to 17:30 CT, so the whole morning and afternoon is the
rebuild-and-test window. Anything that breaks is hot-swapped, and any dead mod's
must-have features get folded into our own plugins.

The one consequence to hold in your head all morning: **ValheimPlus has no 1.0
build** (Grantapher 9.17.1, 2026-02-06, targets 0.221.10; the author has been
silent). Plan for V+ being absent. V+ `enforceMod = true` is a version check in
**both** directions, so a pack that still pins V+ refuses to join a server
without it, and a server that still runs V+ refuses every client from a pack
without it. The two have to move together, which is what `--no-vplus` is for.

**Deleting V+ turns nothing on.** Two switches replace it, on opposite sides of
the wire, and both ship off:

- **client** — EilifPaths `[VPlusFallback] Enabled`, set by minting with
  `--fallback on` (step 15).
- **server** — Eilif Companion `[ServerFallback] Enabled` and `MaxPlayers`, in
  `BepInEx/config/media.blockspace.eilif.companion.cfg` on the box. Nothing in
  this repo can set it, and BepInEx only writes that section on the first boot of
  the new DLL, so it is uploaded by hand in the stopped window (step 10) or the
  player cap sits at the vanilla **10** all night with no error anywhere.

`docs/PACK.md` rule 6 carries the full inventory of what V+ was doing, split into
what `--fallback on` restores, what is simply gone tonight (weather damage on
buildings, area repair, floating items, grid snapping, map-wide shouts, camera
zoom and FOV, comfort radius, full refund on deconstruct), and what is worth
folding into our own plugins later. The GO post is written from that middle
group, so read it before writing the post, not after someone reports a bug.

Nothing below starts until Steam actually shows 1.0. Until then the box stays on
0.221.12 and the rehearsal world is the rollback.

### Lane 1 — Claude, from "1.0 appears on Steam"

1. **Let the Steam client finish updating**, then confirm the local install is
   really on 1.0 before anything is compiled against it:

   ```bash
   ls -l ~/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed/assembly_valheim.dll
   md5sum   ~/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed/assembly_valheim.dll
   ```

   > **Proof:** the md5 differs from 0.221.12's `2a2990bacab2…`. If it matches,
   > Steam has not actually updated yet and every rebuild below would produce
   > 0.221.12 plugins with a 1.0 label on them.

2. **Refresh each plugin's `libs/` from that install and rebuild all four**,
   which `rebuild-plugins.sh` does in one pass (`refresh-libs.sh` per plugin,
   then `dotnet build -c Release`, then md5/size/version/ValueTuple checks):

   ```bash
   bash scripts/rebuild-plugins.sh --dry-run                 # read the plan first
   bash scripts/rebuild-plugins.sh                           # type REBUILD at the prompt
   ```

   > **Proof:** four `OK` lines in the staging summary, each with the csproj
   > `<Version>` found inside the DLL and no `ValueTuple` reference. A compile
   > error here names the Valheim API that moved in 1.0, and that is the whole
   > point of doing this at 09:00 rather than at 17:00.

3. **Load-test the two server DLLs on the local creative server** first, but only
   if that install has also updated to 1.0 (a 0.221.12 creative server proves
   nothing about a 1.0 plugin). Drop the rebuilt `EilifCompanion.dll` and
   `EilifBoards.dll` into its `BepInEx/plugins/` and start it.

   > **Proof:** its `BepInEx/LogOutput.log` shows `Loading [Eilif Companion …]`
   > and `Loading [Eilif Boards …]` with no `TypeLoadException` and no
   > `MissingMethodException`. If the local server has not updated, say so out
   > loud and treat the GTX Start in lane 2 as the first real load test.

4. **Stage the artifacts** so the stopped window is a file copy and not a build:

   ```bash
   bash scripts/rebuild-plugins.sh --stage ~/eilif-launch-dlls --skip-refresh
   ```

   The directory argument is only for the two server DLLs; pass the session's own
   scratch path instead if that is where the rest of the morning's files live. The
   client DLLs always land in the repo's `plugins/thunderstore/`.

   > **Proof:** each SERVER DLL prints its md5 and the exact SFTP destination
   > (`191.101.30.229_6028/BepInEx/plugins/<Folder>/<Name>.dll`), and each CLIENT
   > DLL lands in `plugins/thunderstore/<Name>-<ver>/` with `manifest.json`
   > bumped to that version. Keep those md5s: they are what you compare against
   > the copy on the box afterwards.

5. **Do the read-only half of the wipe now**, while nothing is moving. Stop the
   three services first (the bot re-creates `state.json` within 60 seconds, and
   the wipe refuses `--execute` while it is up), then take the copies and the
   preview. Full detail in "Order of operations" below, steps 1 to 3.

   Take **three** copies here, not two. `pull-world.sh` fetches the `.db`/`.fwl`
   pair and the Supabase dump covers the database, but neither one preserves the
   rest of the server directory, and the panel Steam Update in step 7 is one way:
   `BepInEx/` (every plugin and cfg, including the V+ install and the working
   0.221.12 builds), `WebMap/map_data/`, `vplus-data/` and the panel's own
   `Backups/` all go with it. Pull the whole nest dir over SFTP before the Stop.

   > **Proof:** `--phase pre-wipe` passes its unit checks, a new pair under
   > `~/valheim-world-backups/`, a new dump under `~/valheim-db-backups/`, **and**
   > a full off-box copy of `191.101.30.229_6028/` whose `BepInEx/plugins/`
   > listing you have actually looked at. Then the preview's row counts pasted
   > into the tracker.
   >
   > After step 7 there is no way back to 0.221.12 unless the GTX panel can pin
   > the build (still on Charlie's open list). Without that pin, the only rollback
   > from step 7 onward is the slip-to-Thursday branch, not a restart.

### Lane 2 — Charlie, the stopped window

6. **Panel Stop.** Not Restart. Loaded DLLs are file-locked on the Windows host,
   so this is the only window in which anything below lands.

7. **Panel Steam Update** of the server, then read the version line back.

   > **Proof:** `console.log` reports the 1.0 version, not `0.221.12`. Nothing
   > else in this lane is worth doing until that line is right.

8. **Still stopped, swap the server-side DLLs.** Of the four rebuilt plugins two
   are server-side: `EilifCompanion.dll` and `EilifBoards.dll`, staged in lane 1
   with their md5s. Upload with a retrying loop; the Windows lock can outlive the
   process by a few seconds.

   > **Proof:** md5 of each uploaded file matches the staged one.

9. **Remove ValheimPlus if it has no 1.0 build.** Delete
   `BepInEx/plugins/ValheimPlus/` and leave `valheim_plus.cfg` out. This is not
   optional once the pack drops V+: `enforceMod = true` makes the two a matched
   pair, and a box still running V+ refuses every client the new pack produces.

   > **Proof:** the plugins folder no longer contains ValheimPlus, and the first
   > Start's `Loading [...]` list does not mention it.

10. **Switch the server half back on, in the same window.** Deleting V+ takes the
    player cap down to the vanilla **10** and nothing puts it back on its own.
    Eilif Companion 0.3.3's `[ServerFallback]` is what lifts it, and it ships
    `Enabled = false`. BepInEx only *writes* that section on the first boot of
    the new DLL, so it cannot be edited in this window unless the file is put
    there by hand: upload a `BepInEx/config/media.blockspace.eilif.companion.cfg`
    carrying, alongside whatever the existing file already holds,

    ```ini
    [ServerFallback]
    Enabled = true
    MaxPlayers = <the decided cap>
    ```

    The plugin's own default is `MaxPlayers = 20`, which is what the V+ cfg was
    set to, so 20 is the "nothing changes" answer. Whatever number is chosen here
    is the same number that goes into `config/server.ts` `MAX_PLAYERS` at step 17
    and into the minter's `--cap` at step 15. Skip this step and the site
    advertises a cap the box will not honour, and the eleventh player is told the
    server is full.

    > **Proof:** the first Start's log has
    > `[Eilif] ServerFallback: player cap 10 -> <N>`. If it instead says
    > `ServerFallback: disabled`, the cfg did not take; if it says
    > `disabled (ValheimPlus present)`, step 9 did not.

11. **Fill the Start form and Start.** World = the launch world name, Death
    penalty = **Casual**, Combat = the recorded decision.

    > **Proof:** `console.log` says `DeathPenalty->casual`. Casual is the only
    > tier that grants `deathkeepequip`. Easy and Very Easy do not: gear survived
    > the rehearsal only because Eilif Companion injected the key after every
    > boot, which is exactly the thing a failed 1.0 plugin load takes away.

12. **Remove any third-party plugin that fails to load on that first Start**,
    then Stop and Start again. PlantEverything, ServersideQoL, AzuCraftyBoxes,
    WebMap and the stats Emitter are all third-party and all unrecompiled by us;
    any of them can be the one that throws. A plugin that throws during load can
    take the world load with it, so removing it beats debugging it today.

    One of them is not free to pull: **AzuCraftyBoxes is also a pack pin**, and
    its version has to move in lockstep with the server's copy. Pulling it takes
    the Alt+O unbind with it, which is the exact problem pack v11 was minted to
    fix, and it means editing `MODS`, the templates and `config/mods.ts` by hand
    under time pressure (only V+ has a drop flag). If Azu is the mod that will not
    load, treat that as a vanilla-night trigger rather than a quick fix.

    > **Proof:** a clean `Loading [...]` list and a world that finishes loading.

### Lane 3 — Claude, after the first Start

13. **Read the boot log and decide the pack contents from what actually loaded.**
    Not from what was intended:

    ```bash
    bash scripts/verify-restart.sh <World>
    ```

    > **Proof:** one `Loading [...]` line per surviving plugin with its version,
    > the game version line, panel tier `casual`, `[EILIF_KEY]`, `ingest status:
    > 200`, port 3000 closed. Write the surviving list down; it is the input to
    > step 15.

14. **Prepare the client zips; Charlie uploads them.** The Thunderstore account
    is his. `--stage` has already put each client DLL in
    `plugins/thunderstore/<Name>-<ver>/` with the manifest version bumped, and
    that is all it writes. Three things describe the release and none of them can
    be built: **README.md** (the package page, still a copy of the previous
    version's), **CHANGELOG.md** (same), and the manifest **description** and
    dependencies. Fix all three, then zip and hand it over:

    ```bash
    (cd plugins/thunderstore/EilifPaths-<ver> && zip -qr ../EilifPaths-<ver>.zip . -x '*.zip' 'UPLOAD.md')
    ```

    An EilifPaths 1.5.0 page that says nothing about `[VPlusFallback]` while the
    pack ships `Enabled = true` is a disclosure gap, not a cosmetic one.

    Then spend the 40 to 80 minute index wait on the one link no script can check:
    mint under a throwaway profile name and import it in r2modman by hand
    (Settings, Import/Export, Import profile), then delete it.

    ```bash
    M="--world <World> --paths 1.5.0 --companion-client <ver> --no-vplus --fallback on --cap <N>"
    node scripts/mint-pack.mjs $M --profile-name 'Eilif TEST'
    ```

    > **Proof:** the package page shows the new version, and the throwaway profile
    > imports with every mod and the cfgs already filled in. That is the upload
    > landing, not the pack being mintable; see the next step.

15. **Wait for the listing index, then mint pack v12.** The index that mod
    managers actually read lags uploads by 40 to 80 minutes, and a code minted
    inside that window fails for every player with "mod not found". Rehearse
    until it clears, then test-mint, then publish:

    ```bash
    # $M is the flag set from step 14
    node scripts/mint-pack.mjs $M --dry-run
    node scripts/mint-pack.mjs $M
    node scripts/mint-pack.mjs $M --publish --version-label 'Pack v12 · Sep 9'
    ```

    The middle line is the test mint: it uploads and byte-compares the round trip
    without the code being one a player can be given. Do not skip it to save five
    minutes; the alternative is that the first real upload is also the published
    one.

    `--no-vplus` drops the ValheimPlus entry from `export.r2x` **and**
    `config/valheim_plus.cfg` from the pack, and prints the reminder that the box
    must not run V+ either. `--fallback on` sets EilifPaths' `[VPlusFallback]
    Enabled = true`, which is the client half of what V+ was doing; the pack pins
    that master switch only, and EilifPaths 1.5.0 fills in the other twelve keys
    of the section at defaults that already match the old V+ cfg. **`--fallback`
    requires `--paths 1.5.0` or newer and is refused without it** — the section is
    1.5.0 code, and written against an older pin it is an orphaned key that
    restores nothing and errors nowhere. The cfg's writer header moves to 1.5.0 on
    its own, so `--paths-cfg-version` is not needed here. `--cap <N>` is the number
    step 10 put in the box's `[ServerFallback] MaxPlayers`; it only makes the
    printed checklist say the number instead of the rule. Use `--no-vplus` and
    `--fallback on` together or neither: the fallback alongside a V+ pin makes the
    two stack, and both the minter and the plugin warn about that pairing. Drop a
    mod that did not survive step 12 by leaving its pin out of `config/mods.ts` and
    off the pack; only V+ has a drop flag, because only V+ was expected to die.

    > **Proof:** every row reads `ok / ok`, the round trip is clean, and
    > `receipt.json` records the pins, the drops and the fallback mode.

16. **Rebuild the Mac config bundle with the same flags**, copying the command
    the mint printed rather than retyping it (it forwards `--no-vplus` and
    `--fallback` for exactly this reason):

    ```bash
    node scripts/build-config-bundle.mjs --world <World> --paths 1.5.0 --no-vplus \
      --fallback on --pack-number 12 --pack-date 'Sep 9, 2026'
    ```

    > **Proof:** the printed entry list has no `valheim_plus.cfg` in it, and the
    > README inside the zip says "six settings files" and does not mention
    > ValheimPlus anywhere. That README is the only instructions a Mac player
    > gets.

17. **Site config and deploy.** In `config/server.ts`: `MODPACK_PROFILE_CODE`,
    `MODPACK_VERSION_LABEL`, `LAUNCH_NOTICE` (say plainly what changed and what
    the crew loses), `DISCORD_URL`, and `MAX_PLAYERS` = **the same N as step 10**
    (it reads 15 today, which matches neither posture). In `config/mods.ts`: every
    version that moved, and delete the rows for mods this pack no longer ships. In
    Vercel: `GS_EXPECTED_WORLD` = the new world name.

    In `app/get-started/page.tsx`, **two** edits, not one: `CONFIG_BUNDLE_URL` at
    the new bundle file, **and** the Mac path's hard-coded "install these seven"
    mod list a dozen lines above it. That list names ValheimPlus by hand, so a Mac
    player who follows the page installs V+ and is then refused by the box —
    `enforceMod` working exactly as designed, on the one night nobody will read it
    that way. Drop the name and the word "seven" with it.

    Then, Charlie's call to trigger:

    ```bash
    vercel deploy --prod --yes --scope charlie-9292s-projects
    ```

    > **Proof:** `/mods` shows the new pack label and the surviving mod list. A
    > Vercel env edit does nothing until a deploy; `NEXT_PUBLIC_SUPABASE_URL` and
    > the anon key are baked in at `next build` time.

18. **Run the wipe for real**, then the rest of its own sequence: revert the
    pilot overrides, `--phase post-wipe`, restart poller then bot then map
    snapshot, `--phase post-start`. That is "Order of operations" below, steps 4
    through 8, and none of it is skippable.

    One thing to know about running it here rather than before the Start: between
    the panel Start and `--execute`, the stats Emitter on the box has been posting
    to `/api/gs-ingest`, so `server_status` and a few `player_stats` rows exist
    and the wipe deletes them. That is intended. The Emitter re-reports within a
    minute of the wipe, and the poller and bot are still stopped so nothing else
    is writing. What must **not** happen is a real player joining before
    `--execute`: their session and player rows would be wiped with the rest, and
    the poller is not running to re-derive them. Hold the GO post until this step
    is done.

    > **Proof:** the wipe's own summary (deleted count per table, both state
    > files gone, buckets emptied), then `--phase post-wipe` all PASS, then
    > `--phase post-start` all PASS.

19. **GO post.** The pack code, the version label, "r2modman: Settings,
    Import/Export, Update profile from code" for anyone who already has a
    profile, the Get Started link for Mac players, and a plain sentence about
    what changed: the cap, and which comforts are gone tonight. Write that
    sentence from `docs/PACK.md` rule 6's "gone tonight" list rather than from
    memory — the four everyone will notice first are weather damage on buildings,
    no area repair, dropped items sinking, and shouts no longer crossing the map.
    Worth one more line: the restored comforts run on the machine that owns the
    object, so a fire or a berry bush inside the zones the server owns around
    world origin behaves like vanilla. That is expected, not a broken install.

    > **Proof:** someone other than you has connected, and `/admin/ops` shows
    > fresh heartbeats for the poller, the bot, the map snapshot and both
    > plugins.

### If the morning goes badly

Two ways out, and the call is **Charlie's, by 15:00 CT**. That deadline is the
point: it leaves two hours to execute whichever branch he picks, and it stops the
afternoon from drifting into a decision made at 17:15 with the crew watching.

**Vanilla night.** The server runs 1.0 with `BepInEx/plugins/` moved aside, the
players launch plain Valheim with no pack at all, and the cap is 10. Pick this
when the game is fine but our side is not: a plugin will not compile, a
third-party mod takes the world load down, or the Thunderstore index has not
caught up in time. What it costs: no dashboard stats, no in-game voice, no oaths
or pins, no boards, no map. The wipe, the world, the Casual tier and the Discord
side all still happen exactly as written. Add `--posture GO-B` to every
`launch-preflight.mjs` run so the mod-dependent checks report instead of failing,
and pass `--pins` with only the mods you are actually shipping (its default list
still contains ValheimPlus). Say so in the GO post rather than letting people
discover it.

**Slip to the next evening.** Same crew, same plan, Thursday. Pick this when the
problem is the game or the box rather than our mods: the panel Steam Update
fails, 1.0 breaks dedicated servers outright, the world will not load, or the
1.0 save format turns out to need work (see the last section of this file). A
night nobody can play is worse than a night one day later, and a rushed cutover
that loses the world is worse than both.

Post whichever it is in #valheim **at the moment it is decided**, not at kickoff.

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
   bash scripts/pull-world.sh <World>     # off-box .db/.fwl pair, keeps the last 14
   ```

   plus a full Supabase dump — the project is on the Free plan with **no
   backups at all** — plus, on 2026-09-09 only, a full off-box copy of the server
   directory before the panel Steam Update (lane 1 step 5 of the launch-morning
   sequence). `pull-world.sh` takes the world and nothing else; `BepInEx/`,
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
   node scripts/launch-wipe.mjs --execute
   ```

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
   is step 8 of the launch-morning sequence above, and V+ comes off the box in the
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
   - `vplus-data/<old world>_mapSync.dat`

6. **Do the post-wipe checklist** the script prints at the end (world upload +
   `Start.bat World=`, panel death penalty = **Casual**, Combat per the launch
   decision, leave V+ `[Chat]` ENABLED **if V+ is still installed at all** (it is what makes /s shouts server-wide; the Companion 0.3.1 chat/oath hook no longer depends on it, and on a `--no-vplus` launch this line is moot: shout range goes back to vanilla and the GO post has to say so), Emitter/Companion cfgs off the old
   world, `GS_EXPECTED_WORLD` in Vercel, `MAP_REMOTE_DIR` in the poller `.env`,
   Note (2026-09-05): `NEXT_PUBLIC_SUPABASE_URL` and the anon key are baked into the build at `next build` time, so any Vercel env change needs a REDEPLOY, not just a restart; a local `next start` cannot be repointed at another database without a rebuild (see docs/STRESS-TEST.md).
   and the bot `.env` pilot overrides `RECAPS_START` / `RECAP_CHANNEL` /
   `MILESTONE_CHANNEL` / any `*_CHANNEL=server`). None of it is automated — it
   is printed by the script itself so it can't be missed.

   Then, with the checklist done and the box **still stopped**, this is the last
   gate before the panel Start:

   ```bash
   node scripts/launch-preflight.mjs --world <World> --phase post-wipe
   ```

   It expects all of the above to be finished: zero rows, `world_day` zeroed,
   local state files gone, the launch world in `worlds_local`, the poller's
   `MAP_REMOTE_DIR` and the bot `.env` reverted, and the pack pins live on
   Thunderstore. Any FAIL here is a real one. On a vanilla night (see "If the
   morning goes badly" above) add `--posture GO-B` so the mod-dependent checks
   report instead of failing. Whenever the pack no longer ships a mod, pass
   `--pins` too: preflight's built-in list is `PACK_V12_PINS` in
   `scripts/launch-preflight.mjs` and it still contains ValheimPlus, so a
   `--no-vplus` pack grades a pin it does not have.

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
   `Loading [...]` list, panel tier Casual, `[EILIF_KEY]`, ingest 200, port 3000
   closed), then `node scripts/launch-preflight.mjs --world <World> --phase
   post-start` (which also re-checks the pilot overrides, the poller's
   `MAP_REMOTE_DIR`, the Vercel env names and the pack pins; add `--posture GO-B`
   on a vanilla night and `--pins` whenever the pack dropped a mod), then the
   `/admin/ops` cockpit.

   The plugin count was 8 through the rehearsal. On 2026-09-09 it is whatever
   survived step 12 of the launch-morning sequence, which is 7 if ValheimPlus
   comes off and fewer if a third-party mod is pulled. Compare against the list
   written down in step 13, not against a remembered number.

## What it wipes

- **Deletes all rows**: `title_history`, `players`, `sessions`, `events`,
  `chat_lines`, `oaths`, `pins`, `gallery_photos`, `player_stats`, `voice_lines`,
  `poty_history`, `identity_claims`, `player_positions`, and `map_markers` if
  that table exists (it does not, as of this writing).
  `title_history` (the Crowning Log) is deleted **first and explicitly** — its
  `player_id` FK cascades from `players`, but 10 pilot rows were still live in
  prod on 2026-09-03, so it is no longer left to the cascade.
- **Resets state only** (definitions/rows stay):
  - `milestones` — zeroes `achieved_at` / `achieved_value` / `announced_at` /
    `meta` on rows currently marked achieved.
  - `bosses` — flips `is_killed` back to `false` and clears `killed_at` /
    `players_present` / `fight_stats` / `retelling` / `retelling_generated_at`.
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
  POTY recap streaks all live in this one file), and
  `scripts/.map-snapshot-state.json`. `services/stats-parser` had no local state
  file and is retired regardless.

## What it deliberately does NOT touch

`discord_events` and `ops_heartbeats` (`roadmap` IS wiped since 2026-09-05: the table is orphaned and was added to DELETE_TABLES). Flag to whoever owns
launch-week ops if they also need clearing. (`poty_history` **is** wiped — its
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
