# Adding Eilif Companion Client to the pinned r2modman pack

This plugin is a **local custom DLL** (not published to Thunderstore), so it goes into the profile
as an *imported local mod*. r2modman / Thunderstore Mod Manager fully support this, and local mods
are included when you export the profile code. Do this once, re-export, share the new code — every
pack player then gets automatic cartography with **no** extra steps.

## Files you need

- `dist/EilifCompanionClient.dll` (built by `dotnet build -c Release` in this folder)
- The config below (pre-fills the endpoint so players never touch settings)

## Steps (r2modman / Thunderstore Mod Manager)

1. Open the manager → select the **Eilif** profile (the same one that has ValheimPlus, WebMap,
   GsValheimStatsClient, etc.).
2. **Settings → Import local mod** (under "Profile"/"Locations" depending on version).
3. Choose `dist/EilifCompanionClient.dll`. When prompted:
   - **Name:** `EilifCompanionClient`
   - **Author:** `BlockspaceMedia` (or any — local mods aren't namespaced on Thunderstore)
   - **Version:** `0.2.0`
   The manager copies the DLL into `<profile>/BepInEx/plugins/EilifCompanionClient/`.
4. **Enable** the mod if it isn't already, and make sure BepInEx + the other Eilif mods stay enabled.

## Pre-fill the config (so players never edit settings)

The plugin's defaults already point at prod, so this is only needed if you want the config present
in the exported pack from the first launch. Create
`<profile>/BepInEx/config/net.eilif.companionclient.cfg`:

```ini
[Map]
Url = https://valheim-dashboard.vercel.app/api/gs-ingest
Token =
IntervalSeconds = 300
```

(BepInEx rewrites this with full comments on first launch; your values are preserved. Leave `Token`
blank for the pilot — the ingest accepts token-less `client-map` posts.)

> Getting a config file to ship inside the exported **pack code** depends on the manager version:
> some include `BepInEx/config` in the export, some don't. If yours doesn't, the defaults still make
> it work on first launch — the config is a convenience, not a requirement.

## Re-export the pack

1. **Profile → Export → Export as code** (or "Export as file" for a `.r2z`).
2. Share the new code / file. Players **Import** it → they get the DLL automatically.

## Sanity check before sharing

Launch Valheim once from the profile, join the server, and confirm `LogOutput.log` shows
`[EilifMap] … loaded …` **and** `[EilifDeath] death-cause reporter armed …` on boot, then
`[EilifMap] posted …%` after the interval (or on logout). For the v0.2.0 death reporter, die once on
the server and confirm a `[EilifDeath] … died in …: hitType=…` line. Then re-export.

## Notes

- **Local disk only.** If your r2modman profile lives on the NAS, expect trouble — build/copy on
  local disk (repo memory: NAS can't symlink). The DLL itself is fine anywhere once copied in.
- **After a Valheim patch:** rebuild the DLL (`./refresh-libs.sh` + `dotnet build -c Release`),
  re-import the new `dist/EilifCompanionClient.dll` over the old one in the profile, re-export.
- This does **not** replace GsValheimStatsClient — the two are complementary: GsClient posts combat
  / death / boss stats, this posts map exploration. Both target the same `…/api/gs-ingest`.
