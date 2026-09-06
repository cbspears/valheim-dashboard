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
cd plugins/eilif-companion-client
./refresh-libs.sh              # re-copies assembly_valheim.dll, UnityEngine*.dll from the live Steam install
dotnet build -c Release        # outputs + OVERWRITES dist/EilifCompanionClient.dll (intended — the deployable artifact)
```


## Re-packing a rebuilt client DLL

1. Rebuild only after steps 1–3 above (Steam on 1.0, md5 match against the box).
2. **Panel Stop → upload the rebuilt SERVER DLLs → Panel Start** first, and verify with
   `bash scripts/verify-restart.sh <World>`. The server has to be up and correct before the pack is
   minted — otherwise the pack pins client DLLs against a server nobody has proven.
3. Import the new local DLL into the r2modman profile (or bump the pinned Thunderstore version if
   it was published), launch once, join, confirm the plugin's boot lines.
4. **Only then** export the pack code, and wait for the Thunderstore listing index if any pinned
   version is newly published.

## Gotchas confirmed during this warm-check

- **`dotnet build -o <other-dir>` still overwrites `dist/`.** The csproj's `CopyToDist` MSBuild
  target (`AfterTargets="Build"`) unconditionally copies `$(TargetPath)` into the project's own
  `dist/` regardless of `-o`. For a normal rebuild this is what you want — it only matters for a
  throwaway/scratch build, where the fix is `git checkout -- dist/EilifCompanionClient.dll`
  afterward, not relying on `-o` to keep it clean.
- **`System.ValueTuple` must never be used** (target is `net462`; the BepInEx/Unity Mono runtime
  ships no `System.ValueTuple` reference — a tuple literal/field in the plugin's `Awake` path causes
  a **silent** load failure, no exception, the plugin just never registers). This project's source
  does **not** reference tuples (re-checked 2026-08-23 when `src/DeathReporter.cs` was added — it
  deliberately uses ordinary returns, never a tuple). This gotcha is **not** written down anywhere
  else in this plugin's docs (only `eilif-paths` has an inline source comment on it) — keep it in
  mind if the post-1.0 patch adds any reflection/dictionary helper code that uses tuples.
  Verify after any build: `strings -el dist/EilifCompanionClient.dll | grep -i valuetuple` must
  print nothing.
- **Two hooks to re-verify at 1.0, not one** (v0.2.0). Besides `Minimap.m_explored` /
  `m_textureSize`, the death reporter depends on `Character.m_lastHit` (protected field),
  `Player.OnDeath` (protected override), `HitData.m_hitType` / `GetAttacker()`, and the member list
  of the `HitData.HitType` enum (22 values as of 0.221.12). Decompile check:
  `DOTNET_ROLL_FORWARD=Major ilspycmd -t HitData libs/assembly_valheim.dll | grep -A30 'enum HitType'`
  — any NEW value must be added to `lib/deaths.ts` `HIT_TYPES` and given a phrase in
  `lib/episodes.ts` (`ENV_DEATHS` **and** `ENV_DESC`); `scripts/eilif-death.test.mjs` fails until
  both exist.
- Build-only warnings (`MSB3277` reference-conflict-resolution) are expected and benign — targeting
  `net462` via the reference-assemblies package under a newer SDK, not a real problem.
- **Local disk only** for the r2modman profile when importing — NAS profiles can't be written to
  reliably here (repo-wide gotcha, see `PACK.md`).
