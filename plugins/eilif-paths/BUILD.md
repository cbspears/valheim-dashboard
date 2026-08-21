# Rebuild-at-1.0 procedure (client-side plugin, shipped in the pack)

Verified warm 2026-08-21 against the **current live install** (`Valheim game version: l-0.221.12`,
Steam buildid `21981559`, native Steam under `~/snap/steam/...`). `libs/` checksums were already
byte-identical to that install — no drift found. dotnet SDK on this machine: **8.0.422** at
`~/.dotnet`. Offline NuGet restore succeeds in <1s (reference-assemblies package already cached —
no network needed for NuGet on launch day). Full build (`dotnet build -c Release`) takes under 1s.

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

Then re-pack (this plugin ships inside the r2modman pack, not deployed directly to the server):
1. Open r2modman → **Eilif** profile → **Settings → Import local mod** → pick the freshly-built
   `dist/EilifPaths.dll`, overwriting the previous import (see `PACK.md` for the exact
   name/author/version prompts).
2. Confirm the old `Menthus-Useful_Paths` mod is still Disabled/removed (double-stacking bonus if
   not — `PACK.md` section B).
3. Launch once from the profile, join the server, walk onto a path/road/floor, confirm
   `[EilifPaths] terrain: …` lines match expectations.
4. **Profile → Export → Export as code**, share the new pack code.

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
