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
2. **Prove the server is on the same build.** SFTP-get the box's
   `valheim_server_Data/Managed/assembly_valheim.dll` and md5-compare it with the local
   `valheim_Data/Managed/assembly_valheim.dll`:

   ```bash
   md5sum ~/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed/assembly_valheim.dll
   # and the box's copy, fetched read-only:
   #   sshpass -e sftp ... <<< 'get <nest>/valheim_server_Data/Managed/assembly_valheim.dll /tmp/srv.dll'
   md5sum /tmp/srv.dll
   ```

   Client and dedicated-server builds are not always byte-identical across the whole Managed dir,
   but `assembly_valheim.dll` is the one this plugin compiles against — a mismatch there means the
   two are on different game builds and the rebuild is pointed at the wrong target. Stop and
   reconcile before compiling.
3. Only then run the build sequence below.

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
