# The Eilif modpack: minting, cutover, and the rules that bite

Two artifacts have to agree with each other and with the server, every time:

| Artifact | Where it lives | Who uses it |
|---|---|---|
| r2modman pack code | `MODPACK_PROFILE_CODE` in `config/server.ts`, shown on `/get-started` and `/resources#mods` | Windows and Linux players, one click |
| Mac config bundle | `public/downloads/eilif-configs-pack-v<N>.zip`, linked by `CONFIG_BUNDLE_URL` in `app/get-started/page.tsx` | Macheim players, who install the mods by hand because Macheim cannot read a pack code |

Both are now generated from one source: `scripts/pack-templates/`. `scripts/mint-pack.mjs`
renders and mints the pack, `scripts/build-config-bundle.mjs` renders the same files
into the Mac zip. Run them with the same flags and the two cannot drift apart.

```bash
export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
node scripts/mint-pack.mjs --help
node scripts/build-config-bundle.mjs --help
```

## What is in the pack

The zip root holds `export.r2x` (which pins the mods) and `doorstop_config.ini`;
`config/` holds one `.cfg` per mod that has one. **Pack v14 (2026-09-10) is five mods
and five cfgs, eight entries in all**, counting the `config/` directory record
(`unzip -l` on the rendered zip, 2026-09-10). Pack v11 was seven mods and ten entries.
The count is not a check: it moves with every drop, so read the table, not the number.

| Mod | Thunderstore | Pinned in v14 | Its cfg in the pack |
|---|---|---|---|
| BepInExPack | `denikson/BepInExPack_Valheim` | **5.4.2350** | yes (`BepInEx.cfg`) |
| ValheimPlus (Grantapher fork) | `Grantapher/ValheimPlus_Grantapher_Temporary` | **10.0.2** | yes, and it is **`org.bepinex.plugins.valheim_plus.cfg`** now, not `valheim_plus.cfg`. See rule 6 |
| GsValheimStatsClient | `Proudlock_Technology/GsValheimStatsClient` | 0.2.12 | yes (world + ingest URL) |
| EilifPaths | `Eilif/EilifPaths` | **1.7.1** | yes |
| EilifCompanionClient | `Eilif/EilifCompanionClient` | **0.4.0** | yes (ingest URL) |

**Gone, and not waiting on anything:** PlantEverything (`Advize/PlantEverything` 1.20.0)
and AzuCraftyBoxes (`Azumatt/AzuCraftyBoxes` 1.8.15), dropped on launch morning 2026-09-09.
Both embed a ServerSync build that reads `ZRoutedRpc.Everybody`, which Valheim 1.0 turned
from a field into a constant, so both throw at startup on 1.0 (proved by a local load test
that morning). AzuCraftyBoxes has no successor to wait for, because **V+ 10 has a working
`[CraftFromChest]`** and that is exactly the job Azu was doing. The mint flags are
`--no-plant --no-azu`, and the two mods have to be off the box as well as out of the pack.

**The pack pins BepInExPack 5.4.2350 while the box keeps 5.4.2333.** 5.4.2350 is the version
ValheimPlus 10.0.2 declares as its Thunderstore dependency, so r2modman installs it for every
player no matter what we pin; pinning it just makes the pack honest about what a player ends
up with. V+ 10.0.2 loads clean on the box's 5.4.2333 (proved on the local 1.0 rig, 2026-09-10),
so the box is left alone.

`config/mods.ts` lists more than this: it also covers server-side mods (Eilif Companion,
Eilif Boards, ServersideQoL, WebMap, the stats emitter) that players never install. Only
the five above belong in the pack. **Its ValheimPlus row was deleted on launch night and has
to be put back** with the 10.0.2 number, or `/resources#mods` tells a player the pack does
not ship a mod that it does.

Four of the five are fixed. **ValheimPlus is the one the pack can be minted without**
(`--no-vplus`), and pack v13 was exactly that: launch night ran with no V+ at all, because
Grantapher 9.17.1 targeted 0.221.10 and there was no 1.0 build until 10.0.2 landed on
2026-09-10. The flag drops its `export.r2x` entry **and** its cfg together; see rule 6.
(`--no-companion-client` exists too, as insurance against another Thunderstore listing
rejection; it costs the tombstone keep-list, death causes and the explored-map stat.)

Three files in this repo hold a version list for those five, and they have to be edited
together: `MODS` in `scripts/mint-pack.mjs` (the renderer of record), `PACK_V14_PINS` in
`scripts/launch-preflight.mjs` (which checks the same Thunderstore endpoints from the
preflight side), and the player-facing list in `config/mods.ts`. If they disagree,
preflight can green-light a pin the minter refuses, or `/resources#mods` can claim a version nobody
is running. Folding preflight's list into an `import { MODS }` is the obvious fix and is
not done yet.

## Six rules

**1. The listing index lags uploads by 40 to 80 minutes.** Thunderstore's package API
knows about a new version the instant it uploads, but mod managers resolve a profile code
against a pre-baked, gzipped `package-listing-index`, which is rebuilt on a schedule. A
code minted inside that window looks perfect on the package page and fails for every
player with "mod not found". `mint-pack.mjs` checks **both** and refuses to mint until the
index has caught up. Do not work around it; wait and re-run.

**2. A pack code carries no DLLs.** It is a list of Thunderstore package names and
versions (plus our cfgs). A mod installed as a local file exports only as a stub that
importers cannot resolve. That is why EilifPaths and EilifCompanionClient are published on
Thunderstore under the `Eilif` namespace: **publish the plugin first, wait for the index,
then mint.** The order is not negotiable. `plugins/eilif-companion-client/PACK.md` and each
`plugins/thunderstore/<pkg>/UPLOAD.md` cover the upload side.

**State as of 2026-09-10.** This table has gone stale inside a day more than once, so treat
it as a snapshot and **ask the API when it matters**:

```bash
for n in EilifPaths EilifCompanionClient; do
  curl -s "https://thunderstore.io/api/experimental/package/Eilif/$n/" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['full_name'], d['latest']['version_number'], d['latest']['date_created'])"
done
# or, with the pins and the listing index graded for you:
node scripts/launch-preflight.mjs --world Eilif --phase post-start   # "Modpack pins on Thunderstore"
```

| Package | Published (immutable) | Staged in this repo |
|---|---|---|
| `Grantapher/ValheimPlus_Grantapher_Temporary` | **10.0.2**, published 2026-09-10 by Grantapher. Assembly version 0.10.0.2 | not ours to stage |
| `Eilif/EilifPaths` | **1.7.1** | **1.7.1**, the same bytes |
| `Eilif/EilifCompanionClient` | **0.3.4** (what pack v13 pins) | **0.4.0** built and committed (`3f56704`), **not uploaded yet** |

So the v14 mint waits on exactly one thing: **EilifCompanionClient 0.4.0 has to be uploaded and
indexed.** Until it is, `--companion-client 0.4.0` is refused, which is the tool working. The
dry run below has already been rehearsed against Thunderstore with 0.3.4 in that slot.

```bash
node scripts/mint-pack.mjs --world Eilif --paths 1.7.1 --companion-client 0.4.0 \
  --vplus 10.0.2 --bepinex 5.4.2350 --no-plant --no-azu --fallback off --cap 24 --dry-run
```

**Never hard-code a client version in a command you are about to copy.** A published
Thunderstore version can never be replaced, so if the 0.4.0 build changes again it goes up as
0.4.1 and the pin moves with it.

**3. Whatever the server cannot sync, only the pack can set.** This was AzuCraftyBoxes' rule
first: its `Prevent Pulling Logic` hotkey was client-side and not server-synced, so only the
pack could unbind Alt+O fleet-wide, and that was the whole reason pack v11 existed. Azu is
gone, but the rule came back with V+ 10. V+ has `serverSyncsConfig = true`, so the box wins
on almost everything, and **almost is the load-bearing word**: FOV, the HUD settings and the
grid-snap keybinds are not synced. Those values reach a player only because the pack ships
them, which is why the shipped cfg is the box's own file verbatim rather than a trimmed one.

**4. `World` in the stats cfg must match the server's world exactly.** `--world` writes it
into `config/net.cproudlock.gsvalheimstatsclient.cfg`. The ingest route drops client
payloads whose `world` does not match `GS_EXPECTED_WORLD`, so a typo here means silently
missing stats, not an error anyone sees. Rehearsal pack: `EilifRehearsal`. Launch pack:
whatever the 1.0 world is actually named.

**5. No tokens in the pack.** A pack code is public the moment it is posted in Discord, so
the `Token =` lines ship blank on purpose. The ingest token is server-side only.

**6. ValheimPlus is all-or-nothing, on both sides at once.** V+ `enforceMod = true` is a
version check in **both** directions: a server running V+ refuses every client without it,
and a client from a V+ pack is refused by a server without it. That was true when V+ left the
pack on 2026-09-09 and it is just as true now that it has come back, only pointing the other
way. Pinning V+ and putting it on the box are one decision, taken in one stopped window. The
minter cannot check the box, so it prints the reminder loudly instead, twice.

**Bringing V+ back, 2026-09-10.** Grantapher published **10.0.2**, a real 1.0 build (assembly
version 0.10.0.2) with a working `CraftFromChest`. Three things move together:

| Where | What | How |
|---|---|---|
| box | `BepInEx/plugins/ValheimPlus.dll` | uploaded by hand. A loose DLL, not a directory: V+ logs that path itself on every boot |
| box | `BepInEx/config/org.bepinex.plugins.valheim_plus.cfg` | uploaded by hand, in the same window. 202,422 bytes, the config of record |
| box | Eilif Companion `[ServerFallback] Enabled` | set to **false**, in `BepInEx/config/media.blockspace.eilif.companion.cfg` |
| pack | `--vplus 10.0.2 --bepinex 5.4.2350 --fallback off` | the mint |

**The cfg changed name and format.** V+ 10 reads `BepInEx/config/org.bepinex.plugins.valheim_plus.cfg`,
a standard BepInEx cfg (60 sections, `enabled = true/false` per section), not the old
`valheim_plus.cfg` with its `;` comments. On first run it imports any old `valheim_plus.cfg`
it finds and renames it `.migrated`. So the pack ships the **new** name, and which name it
ships follows the pin: `--vplus` below 10.0.0 renders `config/valheim_plus.cfg`, 10.0.0 or
above renders `config/org.bepinex.plugins.valheim_plus.cfg`. Getting that wrong is invisible
at every stage that could catch it, because a pack carrying the old name against a 10.x pin
mints clean, imports clean, boots clean, and leaves every setting at its plugin default.

**The cfg the pack ships is the box's own file, byte for byte.** V+ syncs server config to
clients (`serverSyncsConfig = true`), so the client copy is overwritten on connect for
everything except the handful of keys V+ does not sync (FOV, the HUD settings, the grid-snap
keybinds), which carry the crew's values. Shipping a trimmed or hand-edited copy would only
create a second opinion that loses every argument except the ones nobody is watching. The
template is `scripts/pack-templates/config/org.bepinex.plugins.valheim_plus.cfg.tmpl`;
re-capture it from the box whenever the box's copy changes.

The settings that matter, all in that one file: `[Server] maxPlayers = 24`,
`enforceMod = true`, `serverSyncsConfig = true`; `[CraftFromChest] enabled = true, range = 30`;
`[Workbench] workbenchAttachmentRange = 20`; `[Camera] 100 / 100 / 75`.

**Both fallbacks go OFF, and they are two separate switches.** They exist because V+ was gone.
With V+ back they do not merely become unnecessary, they become wrong: both patch the same
methods, so anything left on stacks and comes out roughly double.

| Half | Where | v13 (no V+) | v14 (V+ back) |
|---|---|---|---|
| client | EilifPaths `[VPlusFallback] Enabled` | `--fallback on` | **`--fallback off`** |
| server | Eilif Companion `[ServerFallback] Enabled` + `MaxPlayers` | on, `MaxPlayers = 24` | **false**, by hand on the box |

The client half is now enforced: **`--fallback on` while V+ is still pinned is a hard refusal**
in both scripts. EilifPaths 1.5.0 and newer also detects V+ at runtime and declines to apply
the section, logging `VPlusFallback: ValheimPlus detected (...); the section is off, which is
correct`, and the Companion logs `ServerFallback: disabled (ValheimPlus present).` Both lines
are what `scripts/verify-restart.sh` check ① greps for.

Note that `--fallback off` is not the same as leaving the section out. EilifPaths 1.7.1 **has**
the section, so omitting it (`--fallback none`) would let the key arrive at the plugin's own
default on each player's first run instead of at our decision. Write it false and it is a
decision anyone can read.

The server half is the one that gets forgotten, because nothing in this repo can set it. Under
v13 forgetting it left the cap at the vanilla 10; under v14 it leaves a second set of patches
running alongside V+. **The player cap now lives in V+ `[Server] maxPlayers`, not in
`[ServerFallback]`.**

`config/server.ts` `MAX_PLAYERS` must equal whatever the box actually enforces: **24**, from
`[Server] maxPlayers` in the file above. Pass the minter `--cap 24` and it prints that number
in the publish checklist instead of the rule.

### Historical: what left with ValheimPlus on launch night (2026-09-09)

**This section is a record, not a current state.** It is the inventory the launch-night GO post
was written from, when packs v12 and v13 shipped with no ValheimPlus at all. **Pack v14 brings
V+ back, so everything below is restored by V+ itself and `[VPlusFallback]` is off.** Keep it
for the day V+ has to leave again, and for the reasoning about who owns which object.

Walked section by section against the live `valheim_plus.cfg` the crew had been playing.

**Restored by `--fallback on`** (client side): infinite fireplace, oven, hot tub and shield
generator fuel; station build range 30m, attachment range 20m, no roof check; +30% gathering,
+30% picking, +30% loot amount; shared map exploration. **From EilifPaths 1.7.0**, four more:
no weather damage on buildings, area repair at 7.5m, dropped items float, and the lifted shout
range. The fallback health line moves with them: `VPlusFallback patch classes: 16/16 applied.`,
not `12/12`, so a pack pinning 1.7.0 needs the new number at the go/no-go.

One caveat on that list: those patches run on whichever machine **owns** the object, and a
dedicated server owns the zones around world origin, where it has no EilifPaths. A fire or a
bush inside that box keeps vanilla behaviour. V+ did not have this problem because V+ was
installed on both sides. On a fresh wipe the first hall is often within a few zones of spawn,
so say it out loud rather than letting someone report it as a bug.

**Gone tonight, restored by nothing** (and mostly building-comfort, which is what a launch
night is made of):

- **grid snapping** and its LeftAlt / F6 / F7 keys
- dropped items linger for less than the hour V+ gave them (`droppedItemOnGroundDurationInSeconds`
  is separate from the floating fix and is not restored)
- **pings go back to vanilla range**, and **whispers** with them
- camera **zoom 100 and FOV 75** back to vanilla, comfort radius 20 back to vanilla
- **full resource refund** on deconstruct, and placement in spots vanilla refuses
- sleeping in an **unclaimed bed**, carts and boats shown on the map

**Done, 2026-09-09.** The three candidates that used to sit here, `noWeatherDamage`, area repair
and `itemsFloatInWater`, are in EilifPaths **1.7.0** along with the shout range, all four under
`[VPlusFallback]` and all four on by default once the section is enabled. They carry the same
ownership caveat as the rest of the list above: they run on whichever client owns the object, so
a piece near world origin, owned by the server, keeps vanilla behaviour. `--fallback on` still
switches the whole section, and `--paths` must pin 1.7.0 or newer for these four to exist at all.

### The flags

```bash
# pack v14, the current shape
node scripts/mint-pack.mjs --world Eilif --paths 1.7.1 --companion-client 0.4.0 \
  --vplus 10.0.2 --bepinex 5.4.2350 --no-plant --no-azu --fallback off --cap 24 ...
# pack v13, the shape to fall back to if V+ has to leave again
node scripts/mint-pack.mjs --world Eilif --paths 1.7.1 --no-vplus --fallback on ...
```

`--fallback on|off|none` writes `Enabled` in the rendered `net.eilif.paths.cfg`. Default is
`none`: no section at all, which is what EilifPaths 1.4.0 wrote and what reproduces published
pack v11 byte for byte. `off` writes the section with `Enabled = false`; `on` writes it true.

**`on` and `off` both require `--paths 1.5.0` or newer, and the render refuses otherwise.**
That section is 1.5.0 code; written against an older pin it is an orphaned BepInEx key, so
every restored comfort would be silently absent with no error at mint, at import or at boot.
It is the one failure this toolchain cannot see after the fact, which is why it is a hard
refusal rather than a warning. The writer header follows the section automatically (a cfg
carrying `[VPlusFallback]` could only have been written by a build that has it), so
`--paths-cfg-version` is no longer needed for this; pass it only when a real re-capture says
otherwise.

**`--fallback on` with ValheimPlus still pinned is refused outright** (both scripts, since
2026-09-10). Both patch the same methods, so with V+ present their effects stack and the
ranges come out roughly double, and EilifPaths 1.5.0 and newer detects V+ at boot and declines
to apply the section anyway, logging a warning nobody reads. Either way the pack would be
lying about what it does. A pack that ships V+ wants `--fallback off`; `--fallback on` belongs
only with `--no-vplus`.

**The pack pins only `Enabled`, on purpose.** EilifPaths binds thirteen keys in that
section (`InfiniteFireplaceFuel`, `StationBuildRange`, `GatheringBonusPercent`,
`ShareExploration` and the rest) and has since 1.5.0, and their plugin defaults already are the values the V+ cfg
on the box was set to. BepInEx appends the missing twelve at those defaults on first run, so
shipping only the master switch is both correct and one fewer thing to keep in sync. If any
of them ever has to differ from its default, that is the point at which the whole section
gets re-captured from a real r2modman run and dropped into
`scripts/pack-templates/config/net.eilif.paths.cfg.tmpl`, with `--paths-cfg-version` moved to
match.

Related: `--ingest-url` exists but should almost never be used. The dashboard answers on two
hostnames and the shipped mod configs hard-code `valheim-dashboard.vercel.app`; repointing it
strands every player still on an older pack, because their cfg keeps posting to the old one.

## Re-minting: the sequence

**On 2026-09-09 do not run the launch from this section.** The launch morning is
`docs/LAUNCH-DAY.md`, one numbered sequence with owners and rollbacks; the mint is its
steps 16 to 19 and it slots the pieces below into a different order (in particular the
server Stop/Start happens *before* the mint, not after it — see step 8's note). What
follows is the recipe for an ordinary re-mint, and the reference for what each flag does.

Assume the four plugins have been rebuilt for Valheim 1.0 and the two Eilif client plugins
are uploaded to Thunderstore.

The worked examples below leave the client pin as `<ver>`, because a published Thunderstore
version is immutable and that number moves on its own. **Today's flags are the v14 set** and
they go on **every** command in this section, including step 6's bundle rebuild:

```
--paths 1.7.1 --companion-client <ver> --vplus 10.0.2 --bepinex 5.4.2350 \
  --no-plant --no-azu --fallback off --cap 24
```

Pass them every time or the two artifacts disagree. `--vplus` in particular decides the NAME of
the cfg the bundle ships, so a bundle rebuilt without it hands Mac players `valheim_plus.cfg`
for a plugin that reads `org.bepinex.plugins.valheim_plus.cfg`. If V+ ever has to leave again,
the flags become `--paths 1.7.1 --no-vplus --fallback on` instead, and `--fallback on` without
`--paths 1.5.0` or newer is refused outright (rule 6). The minter prints step 6's command with
the flags already in it, which is why copying it beats retyping it.

1. **Wait for the index.** Rehearse the pins first, which also tells you when the wait is
   over (this uploads nothing):

   ```bash
   node scripts/mint-pack.mjs --world <World> --companion-client <ver> --dry-run
   ```

   Re-run until every row reads `ok / ok`.

2. **Test mint.** Without `--publish` the script uploads, downloads the minted profile back
   and byte-compares every file, then prints a code labelled TEST.

   ```bash
   node scripts/mint-pack.mjs --world <World> --companion-client <ver>
   ```

   "TEST" is a label in our terminal and nowhere else: the bytes uploaded are deliberately
   identical to what `--publish` would upload, so a TEST code is indistinguishable from a
   real one once it leaves the screen. That is on purpose (it is what makes the test
   meaningful) and it means a stray paste into Discord is unrecoverable. Do not give a TEST
   code to anyone.

   To rehearse the player-side import, mint one under a name that cannot collide with your
   own profile and delete it afterwards:

   ```bash
   node scripts/mint-pack.mjs --world <World> --companion-client <ver> \
     --profile-name 'Eilif TEST'
   ```

   Then in r2modman: Settings, Import/Export, Import profile, paste the code. It should land
   with **every mod the pack ships** and the cfgs already filled in. Do not check it against a
   count: v11 shipped seven, v13 four and v14 five. Worth doing once before any pack the crew
   has not seen before; it is the only link in the chain the script cannot check for itself.

3. **Real mint.**

   ```bash
   node scripts/mint-pack.mjs --world <World> --companion-client <ver> \
     --publish --version-label 'Pack v14 · Sep 10'
   ```

   `--publish` refuses without a version label, and refuses `--skip-index-check` outright.
   It writes a `receipt.json` next to the zip: keep it, it is the record of exactly what
   was pinned.

3b. **If the pack dropped a mod**, four more edits belong with it, and none of them are
   done by these scripts:

   - `config/server.ts` `MAX_PLAYERS` — the number the box actually enforces (rule 6), not
     a guess. The minter prints it if you pass `--cap <n>`.
   - `config/mods.ts` — delete the row, or `/mods` advertises a mod nobody has.
   - `app/get-started/page.tsx` — **three pinned places, not one.** Grep, do not count:
     `grep -n "CONFIG_BUNDLE_URL\|Eilif Paths 1\.\|GsValheimStatsClient 0\." app/get-started/page.tsx`.
     (a) `CONFIG_BUNDLE_URL` (line 66). (b) The Mac path's hard-coded mod list and its count
     word (around lines 427-432, under the `CUTOVER ANCHOR` comment). It names each mod by
     hand, so a Mac player who follows that page installs whatever it still lists. With
     ValheimPlus that is not just untidy in either direction: a page that names V+ when the
     pack has dropped it gets that player refused by the box, and a page that omits V+ when
     the pack ships it gets them refused just the same. `enforceMod` working exactly as
     designed. Fix the names and the count word together.
     (c) **The update card's self-check sentence, ~180 lines further down** (lines 609-610):
     *"Installed: Eilif Paths 1.4.0 and GsValheimStatsClient 0.2.12 means you are on
     {MODPACK_VERSION_LABEL}."* Eilif Paths is 1.7.1 in v14 and that sentence does not move on
     its own, so it tells a viking still on the old pack that they are current on exactly the
     day an old pack gets them kicked. This list, `docs/LAUNCH-DAY.md` step 19 and `mint-pack`'s
     own printed checklist all used to stop at (b). (Deriving that Mac list and its count
     from `config/mods.ts` filtered on the client-installed mods would make this one edit
     instead of three; not done yet.)
   - `PACK_V14_PINS` in `scripts/launch-preflight.mjs` — or pass preflight `--pins`, or it
     grades a pin the pack does not have.

4. **Paste the code.** In `config/server.ts`:

   ```ts
   export const MODPACK_PROFILE_CODE = '<code from step 3>';
   export const MODPACK_VERSION_LABEL = 'Pack v14 · Sep 10';
   ```

   Bump the label every single time. It is the only way a returning player can tell whether
   their pack is current.

5. **Bump `config/mods.ts`** for every mod whose version moved, so `/mods` stops claiming
   the old one.

6. **Rebuild the Mac bundle** with the same world and the same pins:

   ```bash
   node scripts/build-config-bundle.mjs --world <World> --companion-client <ver> \
     --pack-number 14 --pack-date 'Sep 10, 2026'
   ```

   Copy the exact command the mint printed in step 3 rather than retyping it: it forwards
   the world, the ingest URL and every cfg header flag that mint actually used, which is
   what keeps the bundle and the pack identical. The script refuses to overwrite a bundle
   file that already exists (`--force` to mean it), so a rehearsal cannot quietly rewrite
   the live bundle zip.

   Then point `CONFIG_BUNDLE_URL` in `app/get-started/page.tsx` at
   `/downloads/eilif-configs-pack-v14.zip`. Leave the old zip in place until the new build
   is live so no link 404s mid-deploy.

7. **Deploy** (Charlie's call, CLI only):

   ```bash
   vercel deploy --prod --yes --scope charlie-9292s-projects
   ```

8. **Stop then Start the server** from the GTX panel, so it comes up on the same plugin
   builds the pack now hands out. A restart is not the same thing as Stop then Start for
   config changes.

   > **Not on 2026-09-09.** The launch-day stopped window comes *first* — the Steam
   > Update, the DLL swap, V+ removal, the `[ServerFallback]` cfg, the world upload and
   > the Start are all done before the pack is minted, precisely so the mint can be built
   > from what actually loaded. `docs/LAUNCH-DAY.md` steps 7 to 14. Doing an extra
   > Stop/Start here would kick the crew off after the GO post for no reason.
   > `mint-pack.mjs --publish` prints this same line in its checklist; it is written for
   > an ordinary re-mint day too.

9. **Tell the crew**, in Discord, in this order: the new code, the version label, and
   "r2modman: Settings, Import/Export, Update profile from code" for people who already
   have a profile. Mac players: re-download the config bundle from Get Started.

## Changing a setting without changing a version

Edit the template in `scripts/pack-templates/config/`, then re-mint and rebuild the bundle.
That is what pack v11 was: no Thunderstore upload, no listing lag, just a cfg change
(`Azumatt.AzuCraftyBoxes.cfg`, hotkey set to None) republished as a new code.

`scripts/mint-pack.test.mjs` pins the sha256 of every rendered file against pack v11 as
published, so an accidental edit fails `npm test` instead of silently shipping. When you
change a template **on purpose**, update those hashes in the same commit, and say in the
commit message which setting moved.

**The companion-client cfg is the one place a template does not carry the whole schema.**
`net.eilif.companionclient.cfg` ships only the `[Map]` section and stamps a writer header of
`0.1.0`, on the reasoning that the schema had not moved since. **That stopped being true in
0.3.0**, which added a fourth binding: `[Death] KeepItemTypes`, the tombstone keep-list
(`EilifMapTrackerPlugin.cs`). The pack does not pin it, so **BepInEx appends `[Death]` at the
plugin's own default on each player's first run**. That is benign at the default and is the
deliberate state, but it means the keep-list is not something the pack can set. If a
non-default keep-list is ever wanted it needs a fresh cfg capture from a real r2modman run of
the pinned build, plus `--companion-cfg-version` to move the header, and not a flag.

A template can also carry a `{{#NAME}}` ... `{{/NAME}}` block, each marker alone on its own
line. A kept block loses only its two marker lines, so a rendered file is byte-identical to
one written without the machinery; a dropped block takes its whole body with it. That is how
`--no-vplus` removes the ValheimPlus entry from `export.r2x` and how `--fallback none`
removes `[VPlusFallback]` from the paths cfg. An unbalanced or undeclared marker throws
rather than shipping as a literal, because BepInEx would read `{{#VPLUS}}` in a cfg as a
setting.

Two things the templates deliberately do not derive from the pins:

- **`doorstop_config.ini` and `BepInEx.cfg`** are verbatim. They have no version in them.
- **The `## Settings file was created by plugin X vN` header** in a cfg records the build
  that actually wrote the template body we ship, not the pin, so **no header moves when a
  pin moves** - bumping `--azu 1.9.0` while shipping the 1.8.15 capture would otherwise
  stamp a version that never touched the file. Today the companion client's header reads
  `v0.1.0` against a 0.2.0 pin (its settings schema has not changed since 0.1.0); the
  other four happen to equal their v11 pin.

  Bumping a pin whose cfg schema actually moved means **replacing the template**, not
  passing a flag: re-capture that cfg from a real r2modman run of the new build, drop it
  into `scripts/pack-templates/config/`, then pass the matching header flag
  (`--companion-cfg-version`, `--paths-cfg-version`, `--gs-cfg-version`,
  `--plant-cfg-version`, `--azu-cfg-version`) so the stamp matches the capture. Both
  scripts take the same flags; `--help` lists what each header currently says.

## Inspecting a code someone hands you

A profile code is just a stored file: `#r2modman\n` followed by base64 of the zip.

```bash
curl -sL -H 'User-Agent: eilif-pack-check' \
  https://thunderstore.io/api/experimental/legacyprofile/get/<code>/ \
  | tail -n +2 | base64 -d > profile.zip
unzip -o profile.zip -d unpacked
chmod -R u+rwX unpacked        # NOT optional on Linux. See below.
```

**The `chmod` is what stops a fake panic.** An r2modman-exported zip stores `config/`
without the directory execute bit, so `unzip` recreates it as `drw-------` and nothing can
list what is inside it. Every cfg then reads as missing and `--compare-to` prints **one
`FAIL` line per cfg and "rendered pack does NOT match the reference"** on a pack that is
perfectly fine. Reproduced against pack v11 on 2026-09-06: seven FAILs before the `chmod`, clean
after it.

Then diff `unpacked/` against a `--dry-run` render, or point the minter straight at it:

```bash
node scripts/mint-pack.mjs --world <World> --compare-to ./unpacked --dry-run
```

Match the render to the pack you are comparing against, or every difference is your own
flags. Pack v11 and anything else minted before EilifPaths 1.5.0 needs nothing extra (the
defaults are v11's); a pack that carries `[VPlusFallback]` needs `--paths 1.5.0` plus
`--fallback on` or `--fallback off` to match which way its switch was set; a pack minted
without ValheimPlus needs `--no-vplus`; and pack v14 needs its whole flag set, `--vplus 10.0.2`
included, or the V+ cfg comes out under the wrong name and every file after it reads as a
mismatch.

## What these scripts will not do

They do not edit `config/server.ts`, do not touch `config/mods.ts`, do not deploy, and do
not post to Discord. Minting is cheap and reversible; publishing a code is not, so that
half stays a human decision.
