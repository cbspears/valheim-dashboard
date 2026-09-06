# Rebuild-at-1.0 procedure (client-side plugin, shipped in the pack)

Verified warm 2026-08-21 against the **current live install** (`Valheim game version: l-0.221.12`,
Steam buildid `21981559`, native Steam under `~/snap/steam/...`). `libs/` checksums were already
byte-identical to that install — no drift found. dotnet SDK on this machine: **8.0.422** at
`~/.dotnet`. Offline NuGet restore succeeds in <1s (reference-assemblies package already cached —
no network needed for NuGet on launch day). Full build (`dotnet build -c Release`) takes under 1s.

## Launch-day sequence — do these BEFORE `refresh-libs.sh` (added 2026-09-04, audit plugins-9)

`refresh-libs.sh` copies the game DLLs out of the **local Steam client install**
(`~/snap/steam/.../Valheim/valheim_Data/Managed`). That install has `AutoUpdateBehavior 0`, i.e. it
only updates while Steam is running — so on launch day it is entirely possible to rebuild every
plugin against the **0.221.12** assemblies and ship them to a **1.0** server. Nothing in the build
catches that; the symptom is eight plugins that silently fail to load.

1. **Launch Steam and confirm Valheim shows the 1.0 build** before touching `refresh-libs.sh`.
   Let the download finish; check the build id in Steam → Valheim → Properties → Updates.
2. **Prove the server is on the same build — by its version line, not by md5.**

   ```bash
   bash scripts/verify-restart.sh <World>     # read-only; step ⓪ prints the box's version
   ```

   Look for `Valheim version: <the 1.0 number> (network version NN)`, read out of the box's
   own `console.log`. Compare it with what Steam shows for the local client (step 1).

   > **Do NOT md5-compare the box's `assembly_valheim.dll` against the local client's.** That
   > gate was written here on 2026-09-04 and **can never pass**: the dedicated-server and
   > client assemblies are different compilations of the same game. Measured on this PC
   > 2026-09-06, both reporting `Valheim version: l-0.221.12 (network version 36)` —
   >
   > | Install | Size | md5 |
   > |---|---|---|
   > | Steam **client** `valheim_Data/Managed/assembly_valheim.dll` | 2,126,848 | `2a2990bacab27146173924d88b2628b4` |
   > | local **dedicated server** `valheim_server_Data/Managed/assembly_valheim.dll` | 2,119,680 | `d09453434188a144b179a4d448289352` |
   >
   > The server assembly carries `SetMaxPlayerCount` and `SteamGameServer`, which the client
   > assembly does not — this repo already relies on that difference elsewhere. So the old
   > step 2 produced a **guaranteed** mismatch and told the operator to "stop and reconcile",
   > i.e. a false STOP on the critical path. `docs/LAUNCH-DAY.md` never routed through here
   > (its step 1 compares the local client against a known-good literal and is correct), but
   > `CLAUDE.md` advertises this BUILD.md sequence, so a fresh session could have followed it.
   >
   > A local **dedicated-server** install of the same build would be a valid comparison
   > (`~/Valheim-Test-Server-2` is what `docs/LAUNCH-DAY.md` step 3 uses), but on launch
   > morning it may not have updated to 1.0 yet — which is exactly why step 3 there is
   > conditional. The version line works unconditionally.

3. **Verifying a rebuilt DLL, when you get there.** `md5` on `dist/` is still the right thing
   to compare against the copy you upload to the box, but it is **not** a "did the source
   change" test: SourceLink stamps `AssemblyInformationalVersion = "<Version>+<HEAD sha>"`, so
   on launch day HEAD has moved and the md5 differs either way. PE sections are 512-byte
   aligned, so a small code change routinely leaves the **size** unchanged too. The only way
   to prove a rebuild is stamp-only is a second build:

   ```bash
   bash scripts/rebuild-plugins.sh --source-revision <the before-DLL's sha> --sandbox /tmp/rb
   # then compare that DLL's md5 with the before value
   ```

   Cheaper day-of check when you only need "is this the new artifact": the csproj `<Version>`
   string must appear inside the built DLL, plus its size — which is what
   `rebuild-plugins.sh` already asserts and prints per plugin.
4. Only then run the build sequence below.

## Exact sequence, once the 1.0 game DLLs are live

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
cd plugins/eilif-paths
./refresh-libs.sh              # re-copies assembly_valheim.dll, UnityEngine*.dll from the live Steam install
dotnet build -c Release        # outputs + OVERWRITES dist/EilifPaths.dll (intended — the deployable artifact)
```

**Extra 1.0 risk for this plugin specifically:** terrain detection reads `Heightmap.m_paintMaskDirt`
/ `m_paintMaskCultivated` / `m_paintMaskPaved` and `WearNTear.m_materialType` by name (see
`README.md`). If Iron Gate renamed these fields or changed the paint-mask channel layout in the 1.0
/ Deep North update, this is where it'll show — watch for the surface-change log lines
(`[EilifPaths] terrain: …`) misreporting or never firing after rebuild, not just a compile error.

**Second 1.0 risk (added 1.2.0):** the bed patch hooks the *private* method `Bed.CheckFire` by name
and calls `EffectArea.IsPointInsideArea(Vector3, EffectArea.Type, float)` with its optional radius
argument. A rename or a signature change there is a Harmony *runtime* miss, not a compile error, so
after rebuilding confirm the boot line reads `Bed fire range: +8m` and that claiming a bed a few
metres from a campfire logs `[EilifPaths] bed fire check passed with +8m: …`. Re-verify with
`DOTNET_ROLL_FORWARD=Major ilspycmd -t Bed libs/assembly_valheim.dll | grep -A10 CheckFire` if not.

**Third 1.0 risk (added 1.3.0):** the workstation patch hooks the *private* Unity message
`StationExtension.Awake` and mutates the public field `StationExtension.m_maxStationDistance`. Both
are resolved by name, so a rename (or moving the attachment distance onto `CraftingStation`, or
replacing the `Vector3.Distance(...) < allExtension.m_maxStationDistance` test in
`StationExtension.FindExtensions` with something else) is a Harmony *runtime* miss or a silent no-op,
not a compile error. After rebuilding, confirm the boot line reads
`Workstation attachment range: +10m` **and** that a station upgrade placed well beyond hugging
distance both turns green and raises the station level — the boot line alone does not prove the
field is still the gate. Each attachment prefab logs
`[EilifPaths] workstation attachment '<prefab>': reach 5m -> 15m.` once. Re-verify with
`DOTNET_ROLL_FORWARD=Major ilspycmd -t StationExtension libs/assembly_valheim.dll` and
`... -t CraftingStation ... | grep -n "GetExtensions\|GetLevel\|m_rangeBuild"` if not; the design
note in `README.md` (Workstation attachment range) explains why one field covers both sides, and
that reasoning is what a 1.0 rebuild has to re-confirm.

**Fourth 1.0 risk (added 1.5.0):** the dormant `[VPlusFallback]` section hooks twelve more vanilla
methods, all resolved by name, several of them private: `Fireplace.Awake`,
`CookingStation.UpdateCooking`, `Smelter.UpdateSmelter`, `ShieldGenerator.Start` /
`OnProjectileHit` / `RPC_Attack`, `CraftingStation.Start` / `CheckUsable`,
`StationExtension.Awake`, `DropTable.GetDropList(int)`, `Pickable.RPC_Pick`,
`CharacterDrop.GenerateDropList`. It also reaches three private members through `AccessTools`
(`CookingStation.m_nview`, `Smelter.m_nview`, `ShieldGenerator.m_nview`, plus `Minimap.Explore` and
`ZNet.m_players` for `ShareExploration`). **None of this is applied while `Enabled = false`**, which
is how it ships — so a 1.0 rebuild does not have to get it right on launch night. If Charlie does
turn it on, the boot line to check is `[EilifPaths] VPlusFallback patch classes: 12/12 applied.`;
anything less names the missing class on the ERROR line above it, and the feature list that follows
says which comforts are actually live. Re-verify a missing one with
`DOTNET_ROLL_FORWARD=Major ilspycmd -t <Type> libs/assembly_valheim.dll`; the decompiled vanilla body
each hook was written against is quoted in full above each patch class in
`src/VPlusFallbackPatch.cs`.

Two of those twelve are `Prefix` + **`Finalizer`** pairs, not `Prefix` + `Postfix`
(`Pickable.RPC_Pick` and `CharacterDrop.GenerateDropList`). Both temporarily inflate shared
per-instance state — `Pickable.m_amount`, `CharacterDrop.m_drops` — and restore it afterwards, and
Harmony **skips postfixes when the original method throws**. A postfix there would leave the bush or
the creature permanently inflated and compound on the next call (1.3 × 1.3). Harmony picks the
finalizer up by method name (`HarmonyLib.AttributePatch` scans for `Finalizer` exactly as it does
`Postfix`), and a `void` finalizer leaves the original exception to propagate unchanged. Same
convention as `ToolStaminaPatch.ScopeFinalizer` and `eilif-companion-client`'s `TombstoneKeeper`.
**If a 1.0 rebuild ever renames one of these back to `Postfix`, the restore silently stops covering
the throw path** — the class count stays 12/12 either way, so the count will not catch it.

**The first grep after a 1.0 rebuild: `MISSING patch class`.** Zero lines is healthy. A plugin
prints its `Loading [...]` line whether or not its Harmony patches went on, so `Loading` proves the
DLL was chainloaded and nothing more; each `MISSING patch class` line names the class **and the
feature that died with it** (`EilifPathsPlugin.cs:306`). Read it in the **player's**
`BepInEx/LogOutput.log` inside the r2modman profile — EilifPaths is a client plugin and never
appears in the server's log. Alongside it, two counts that must be exact:

- **`[EilifPaths] Core patch classes: 6/6`** — jog speed, run speed, stamina, walking, bed, station.
- **`[EilifPaths] tool/weapon stamina hooks: 9/9 applied`**, with **no `(DEGRADED - see the errors
  above)`** suffix. These nine are applied one by one on purpose, so a single unresolvable target
  costs one hook rather than the plugin. **8/9 is not "one small feature lost"** — it means a Valheim
  method this plugin patches was renamed or removed, and the discount it bought is silently back to
  vanilla.

Both denominators are fixed rosters in the source (`ExpectedCoreClasses`, `SiteLabels`), never a
count of what happened to load, so a class the runtime could not even enumerate still shows as a
shortfall.

**Boot lines a 1.0 rebuild should grep for (1.5.0), on the fallback half:** three, not one.
`VPlusFallback patch classes: 12/12 applied.` (section on and healthy),
`VPlusFallback: disabled (ValheimPlus present).` (off because V+ is doing the job), and
`[Warning] VPlusFallback: OFF and no ValheimPlus installed` (off with **nothing** providing the
comforts — the state that used to print the same bland line as the healthy one). There is also an
`[Error] ValheimPlus IS loaded after all` block from the ~8 s late re-check, which only fires when
a ValheimPlus under an unrecognised file name loaded after we had already patched.

**A trap that already bit once (1.5.0):** for anything SERVER-side, `libs/assembly_valheim.dll` is
the wrong reference. `refresh-libs.sh` copies the **client** assembly, and several method bodies
differ between the client and dedicated-server builds — `ZSteamMatchmaking.RegisterServer` calls
`SteamMatchmaking.CreateLobby(type, 10)` on the client and `SteamGameServer.SetMaxPlayerCount(10)` on
the server, and the PlayFab player-count literals are `10` on the client and `11` on the server.
EilifPaths is a client plugin, so the client assembly is the right reference *here* — but do not
carry a shape read from it over to Eilif Companion without re-checking against
`valheim_server_Data/Managed/assembly_valheim.dll`.

**ValheimPlus ordering (1.3.0):** V+ patches the same `StationExtension.Awake` with a *prefix* that
**sets** `m_maxStationDistance`; ours is a *postfix* that **adds**. That ordering is what keeps the
two composable — if this is ever changed to a prefix, or to an absolute assignment, the two mods
start fighting. Keep it a postfix.


## Re-packing a rebuilt client DLL

1. Rebuild only after steps 1–3 above (Steam on 1.0, md5 match against the box).
2. **Panel Stop → upload the rebuilt SERVER DLLs → Panel Start** first, and verify with
   `bash scripts/verify-restart.sh <World>`. The server has to be up and correct before the pack is
   minted — otherwise the pack pins client DLLs against a server nobody has proven.
3. Import the new local DLL into the r2modman profile (or bump the pinned Thunderstore version if
   it was published — EilifPaths is published), and confirm the old `Menthus-Useful_Paths` mod is
   still Disabled/removed (double-stacking bonus if not — `PACK.md` section B).
4. Launch once from the profile, join the server, walk onto a path/road/floor, and confirm the
   `[EilifPaths] terrain: …` lines plus the `Bed fire range: +8m` /
   `Workstation attachment range: +10m` boot lines match expectations.
5. **Only then** export the pack code, and wait for the Thunderstore listing index if any pinned
   version is newly published. **1.5.0 is already published** (2026-09-06 10:01 CT) and a published
   Thunderstore version is immutable, so a 1.0 rebuild that changes this DLL goes up as **1.5.1**,
   never as a re-upload of 1.5.0. Bump `EilifPaths.csproj` **after** the rebuild, not before:
   `launch-preflight`'s `PACK_V12_PINS` reads this csproj directly
   (`scripts/launch-preflight.mjs:95`), so a version that is not yet uploaded makes its pin gate
   FAIL on a 404. `mint-pack` pins from its own `MODS` table and the `--paths` flag rather than
   from the csproj, but it checks whatever version you pass it, so the same 404 reaches it as
   soon as you type the new number.

## Gotchas confirmed during this warm-check

- **`dotnet build -o <other-dir>` still overwrites `dist/`.** The csproj's `CopyToDist` MSBuild
  target (`AfterTargets="Build"`) unconditionally copies `$(TargetPath)` into the project's own
  `dist/` regardless of `-o`. For a normal rebuild this is what you want — it only matters for a
  throwaway/scratch build, where the fix is `git checkout -- dist/EilifPaths.dll` afterward, not
  relying on `-o` to keep it clean.
- **`System.ValueTuple` must never be used** (target is `net462`; the BepInEx/Unity Mono runtime
  ships no `System.ValueTuple` reference — a tuple literal/field in the plugin's `Awake` path causes
  a **silent** load failure, no exception, the plugin just never registers). **This is already
  documented in-source** — see the comment above `BindSurface(...)` in
  `src/EilifPathsPlugin.cs` explaining why the owner-chosen surface defaults are bound via
  individual `Config.Bind` calls instead of a tuple/collection field initializer. Keep that pattern
  if you touch this code post-1.0.
- Build-only warnings (`MSB3277` reference-conflict-resolution) are expected and benign — targeting
  `net462` via the reference-assemblies package under a newer SDK, not a real problem.
- **Local disk only** for the r2modman profile when importing — NAS profiles can't be written to
  reliably here (repo-wide gotcha, see `PACK.md`).
