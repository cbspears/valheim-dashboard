# Adding Eilif Companion Client to the pinned r2modman pack

This plugin **is published on Thunderstore** (Eilif/EilifCompanionClient — 0.1.0 2026-08-22,
0.2.0 2026-08-23), so the pack normally pins the published version rather than importing a local
DLL. The local-import route below is still the correct one for testing an unpublished build, and
is how 0.1.x got in before the listing existed.

**Version state as of 2026-09-04:** Thunderstore latest = **0.2.0**, pack v11 pins **0.2.0**, and
the repo's `dist/EilifCompanionClient.dll` is **0.3.0** (tombstone keep-list, built 2026-09-01).
The 0.3.0 Thunderstore package is staged and zipped at
`../thunderstore/EilifCompanionClient-0.3.0/` but **not uploaded** — see that directory's
`UPLOAD.md` for the ship-now-vs-fold-into-1.0 decision. Until it is uploaded and the pack re-minted,
the keep-list is dark for every player: r2modman reinstalls the pinned pack versions on every
"Start modded", so a hand-copied DLL does not survive.

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
   - **Version:** `0.3.0` (match `PluginVersion` in `src/EilifMapTrackerPlugin.cs`)
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

[Death]
KeepItemTypes = OneHandedWeapon, TwoHandedWeapon, TwoHandedWeaponLeft, Bow, Shield, Torch, Tool, Ammo, AmmoNonEquipable
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
`[EilifMap] … loaded …`, `[EilifDeath] death-cause reporter armed …` **and** (v0.3.0)
`[EilifDeath] tombstone keep-list armed …` on boot, then `[EilifMap] posted …%` after the interval
(or on logout). Then die once on the server and confirm both a
`[EilifDeath] … died in …: hitType=…` line (v0.2.0 reporter) and, on a `deathkeepequip` world, a
`[EilifDeath] tombstone keep-list spared N item(s).` line with your tools and weapons still in
inventory (v0.3.0). Then re-export.

## Notes

- **Local disk only.** If your r2modman profile lives on the NAS, expect trouble — build/copy on
  local disk (repo memory: NAS can't symlink). The DLL itself is fine anywhere once copied in.
- **After a Valheim patch:** rebuild the DLL (`./refresh-libs.sh` + `dotnet build -c Release`),
  re-import the new `dist/EilifCompanionClient.dll` over the old one in the profile, re-export.
- **Gameplay disclosure travels with the pack.** From 0.3.0 this plugin changes what a death
  costs (the tombstone keep-list), so the pack notes and the Thunderstore README must both say so.
  The full-disclosure README style is what got 0.1.1 and 0.2.0 approved after two rejections.
- This does **not** replace GsValheimStatsClient — the two are complementary: GsClient posts combat
  / death / boss stats, this posts map exploration. Both target the same `…/api/gs-ingest`.
