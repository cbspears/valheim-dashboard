# EilifPaths

A modern, drop-in replacement for the broken **Menthus "Useful Paths"** mod
(`Menthus-Useful_Paths` 1.0.5.0, 2021). Client-side BepInEx plugin for the Eilif Valheim server.

Players move faster and spend less stamina while on dirt paths, paved roads, and built floors —
exactly like the old mod — but detection uses the terrain API *current* Valheim actually uses, so
paths and roads work again.

It also carries two unrelated quality-of-life patches: beds accept a fire much further away
(**1.2.0**, see [Bed fire range](#bed-fire-range-120)) and crafting-station upgrades attach from
much further out at *every* station (**1.3.0**, see
[Workstation attachment range](#workstation-attachment-range-130)).

## Why the old mod broke

Useful Paths detected dirt/paved terrain with
`TerrainModifier.FindClosestModifierPieceInRange(pos, 6f)`. Modern Valheim no longer leaves
persistent per-hoe `TerrainModifier` pieces lying on the ground — terrain paint is baked into each
`Heightmap`'s `m_paintMask` texture. So that lookup returned null and only built floors (found via
`WearNTear`) still got a bonus. Dirt paths and paved roads silently did nothing.

## How EilifPaths detects the ground (polled every 0.4s, cheap)

1. **Built floors** — `Player.GetLastGroundCollider()` → `WearNTear.m_materialType`
   (`Wood` / `Stone` / `Iron` / `HardWood`). Unchanged from the old mod; still valid.
2. **Terrain paint** — `Heightmap.FindHeightmap(pos)`, then read the paint-mask pixel under the
   player (`WorldToVertexMask` + `GetPaintMask(x,y)`), matching the game's own `IsCleared()`
   sampling. The channels are defined by the game as:
   - `Heightmap.m_paintMaskDirt`  = **(1,0,0,1)** → red   → **Path** (hoe dirt path)
   - `Heightmap.m_paintMaskCultivated` = (0,1,0,1) → green → cultivated farmland (ignored)
   - `Heightmap.m_paintMaskPaved` = **(0,0,1,1)** → blue  → **PavedRoad** (paved road)

   So: **blue > 0.5 ⇒ PavedRoad, else red > 0.5 ⇒ Path.** Paved wins over dirt (a paved tile is
   painted blue over any dirt).

**LevelGround is not supported** — leveling ground only edits heights, it paints nothing and leaves
no persistent marker, so there's no reliable way to detect it. Dropped intentionally.

## Effect surface (same Harmony hooks as the old mod)

- `Player.GetJogSpeedFactor` postfix — multiply result by the surface's `movement`.
- `Player.GetRunSpeedFactor` postfix — multiply result by the surface's `movement`.
- `Player.UseStamina` prefix — multiply the stamina cost by the surface's `staminadrain`.
- `Character.UpdateWalking` prefix/postfix — the jog/run factors don't affect *walking*
  (walk uses `m_walkSpeed` directly), so for the local player we **multiply** `m_walkSpeed` by
  `movement` and **restore it** in the postfix. We do not hard-set it: modern vanilla `m_walkSpeed`
  is ~5 (it was 1.6 in 2021, which is why the old mod's `m_walkSpeed = 1.6f * mult` would *slow*
  walking today). State is never permanently mutated and reverts cleanly off-path.
- `Bed.CheckFire` prefix (1.2.0) — re-runs the vanilla heat lookup with an extra radius; falls
  through to the untouched original on no-match or any error. See below.
- `StationExtension.Awake` postfix (1.3.0) — widens that instance's `m_maxStationDistance`, the one
  field every station-attachment distance check reads. See below.

## Config (baked-in defaults, no pre-fill needed)

`net.eilif.paths.cfg`, sections named per surface, keys `movement` / `staminadrain`:

| Surface   | movement | staminadrain |
|-----------|----------|--------------|
| Path      | 1.4      | 0            |
| PavedRoad | 1.4      | 0            |
| Wood      | 1.4      | 0            |
| Stone     | 1.4      | 0            |
| Iron      | 1.4      | 0            |
| HardWood  | 1.4      | 0            |

Plus two non-surface sections: `[Bed] extraFireRange` = `8` and
`[Workstation] extraAttachmentRange` = `10` (see below).

## Bed fire range (1.2.0)

Vanilla requires a bed to be practically inside the fire before it will let you claim it or sleep.
Decompiled from `libs/assembly_valheim.dll` (game 0.221.12):

```csharp
private bool CheckFire(Player human)
{
    if (!EffectArea.IsPointInsideArea(base.transform.position, EffectArea.Type.Heat))
    {
        human.Message(MessageHud.MessageType.Center, "$msg_bednofire");
        return false;
    }
    return true;
}
```

and the API it calls:

```csharp
public static EffectArea IsPointInsideArea(Vector3 p, Type type, float radius = 0f)
{
    if (type == Type.Burning && radius.Equals(0.25f))
    {
        return GetBurningAreaPointPlus025(p);
    }
    int num = Physics.OverlapSphereNonAlloc(p, radius, m_tempColliders, s_characterMask);
    for (int i = 0; i < num; i++)
    {
        EffectArea component = m_tempColliders[i].GetComponent<EffectArea>();
        if ((bool)component && (component.m_type & type) != 0)
        {
            return component;
        }
    }
    return null;
}
```

`Bed.CheckFire` omits the radius, so `radius = 0` and the OverlapSphere degenerates into a point
test: the bed's origin has to fall inside the fireplace's own `Heat` trigger collider. EilifPaths
patches `Bed.CheckFire` with a Harmony **prefix** that re-runs the same call with a configurable
extra radius. Because the parameter simply widens the sphere, the patch is purely additive — it can
only accept more spots than vanilla, never fewer.

| Section | Key | Default | Meaning |
|---|---|---|---|
| `[Bed]` | `extraFireRange` | `8` | Metres added on top of the fireplace's own heat area. `0` = vanilla. |

**Why 8 m.** The campfire's `Heat` collider radius lives in the prefab (Unity asset data), not in
`assembly_valheim.dll`, so it can't be quoted from a decompile — it is a small collider on the order
of a few metres. 8 m extra guarantees at least double the reach for any hearth whose heat collider
is 8 m or smaller (all of them are), and for a campfire in the 3–5 m range works out to roughly
2.5–3.5×. Every successful extended check logs the real numbers so the default can be retuned from
evidence:

```
[EilifPaths] bed fire check passed with +8m: heat source 'FireWarmth' at 6.42m, its own heat radius 4m.
```

The whole prefix is inside a `try/catch` and every non-match / error path returns control to the
untouched vanilla method (which shows its own `$msg_bednofire`), so bed interaction can't break.
The check is client-side, so it only affects the beds of players running the mod.

## Workstation attachment range (1.3.0)

Vanilla gives a station upgrade roughly 5 m to reach its station, so chests, anvils, tanning racks
and the rest end up crammed against the bench. ValheimPlus has a knob for this but it lives under
`[Workbench]`; this patch is generic and covers **every** crafting station.

### Why one hook covers both sides

Decompiled from `libs/assembly_valheim.dll` (game 0.221.12). There is exactly **one** distance value
in the game that gates station attachments, and it lives on the **extension**, not on the station:

```csharp
public class StationExtension : MonoBehaviour, Hoverable
{
    public CraftingStation m_craftingStation;
    public float m_maxStationDistance = 5f;
    ...
}
```

**Station side** — the station enumerating/counting its attachments, i.e. what raises its level:

```csharp
public static void FindExtensions(CraftingStation station, Vector3 pos, List<StationExtension> extensions)
{
    foreach (StationExtension allExtension in m_allExtensions)
    {
        if (Vector3.Distance(allExtension.transform.position, pos) < allExtension.m_maxStationDistance
            && allExtension.m_craftingStation.m_name == station.m_name
            && (allExtension.m_stack || !ExtensionInList(extensions, allExtension)))
        {
            extensions.Add(allExtension);
        }
    }
}
```

reached from `CraftingStation.GetExtensions()` → `GetExtentionCount()` → `GetLevel()`. Note what is
**not** there: `CraftingStation` has no distance constant of its own for attachments. Its own numbers
(`m_discoverRange` 4, `m_rangeBuild` 10, `m_useDistance` 2, `m_extraRangePerLevel`) govern discovery,
the build radius and the interact distance — none of them gate whether an extension attaches. **The
station side reads the extension's field.** That is why there is no second constant to patch in
tandem: one field, both sides.

**Extension side** — placement validity, from `Player.UpdatePlacementGhost()`:

```csharp
StationExtension component2 = component.GetComponent<StationExtension>();
if (component2 != null)
{
    CraftingStation craftingStation = component2.FindClosestStationInRange(point);
    if ((bool)craftingStation) { component2.StartConnectionEffect(craftingStation); }
    else { component2.StopConnectionEffect(); m_placementStatus = PlacementStatus.ExtensionMissingStation; }
    ...
}
```

and the instance methods it calls, which read the same field again:

```csharp
public List<CraftingStation> FindStationsInRange(Vector3 center)
{
    List<CraftingStation> list = new List<CraftingStation>();
    CraftingStation.FindStationsInRange(m_craftingStation.m_name, center, m_maxStationDistance, list);
    return list;
}

public CraftingStation FindClosestStationInRange(Vector3 center)
{
    return CraftingStation.FindClosestStationInRange(m_craftingStation.m_name, center, m_maxStationDistance);
}
```

### The hook

A Harmony **postfix on `StationExtension.Awake`** that *adds* the configured metres to that
instance's `m_maxStationDistance`. Every consumer above then sees the wider range, so placement
validity, the station's extension count/level and the connection beam all move together: a piece the
game lets you place is always a piece the station actually counts.

- **Per instance, never the prefab.** `Awake` runs once per spawned object and never on the shared
  prefab asset, so the bump cannot accumulate.
- **Generic.** It keys off `StationExtension`, not off any station name, so workbench, forge, black
  forge, galdr table, artisan table and anything a future update adds are covered with no list.
- **The placement ghost is covered.** `Player.SetupPlacementGhost()` does
  `Instantiate(selectedPrefab)` with `ZNetView.m_forceDisableInit = true`, so the ghost's `Awake`
  runs (its vanilla body early-returns because `GetZDO()` is null, which does not stop a postfix).
- **Additive, not absolute.** `m_maxStationDistance` is authored per prefab; a flat assignment would
  silently *shrink* any extension whose default is larger. Adding can only widen — the same
  "can only accept more" property the bed patch is built on.

| Section | Key | Default | Meaning |
|---|---|---|---|
| `[Workstation]` | `extraAttachmentRange` | `10` | Metres added on top of each attachment piece's own built-in distance (5 m for most). `0` = vanilla. |

Everything is inside a `try/catch`; on any failure the vanilla value is left untouched. Each distinct
extension prefab logs its real numbers once, so the default can be retuned from evidence:

```
[EilifPaths] workstation attachment 'piece_workbench_ext1': reach 5m -> 15m.
```

**ValheimPlus coexistence.** V+ patches the same method with a *prefix*
(`StationExtension_Awake_Patch`, `public static void Prefix(ref float ___m_maxStationDistance)`) that
**sets** the field to `Workbench.workbenchAttachmentRange` when its `[Workbench]` section is enabled.
Ours is a postfix, so it always runs after that assignment and adds on top of whatever V+ decided —
no ordering fight, no double-set. In the Eilif profile V+'s `[Workbench]` is `enabled = false`, so we
add to the vanilla per-prefab default.

**Out of scope, deliberately:** `CraftingStation.m_rangeBuild` / `m_extraRangePerLevel`, i.e. how far
from a workbench you may build at all. That is the separate "workbench range" knob (V+
`workbenchRange`), not an attachment's reach.

## Coexistence guard

If the old `Menthus.bepinex.plugins.UsefulPaths` is still loaded, EilifPaths logs a loud warning
and cedes built floors to it (only adding the Path/PavedRoad detection the old mod can no longer do)
so bonuses don't double-stack. The proper fix is to disable Useful_Paths — see `PACK.md`.

## Build

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
./refresh-libs.sh          # re-copy game + BepInEx reference DLLs (after any Valheim patch)
dotnet build -c Release    # outputs dist/EilifPaths.dll
```

Reference DLLs in `libs/` are compile-time only (never shipped). Re-run `refresh-libs.sh` after a
Valheim patch. If Iron Gate ever renames `m_paintMask` / `GetPaintMask` / `m_materialType`, update
`src/EilifPathsPlugin.cs` accordingly.

## Install

Copy `dist/EilifPaths.dll` into the BepInEx `plugins/` folder (both the r2modman **Eilif** profile
and the manual game install are targeted for this server). See `PACK.md` for adding it to the pinned
pack as a local mod and removing the old Useful_Paths before the next pack export.

## Verifying in-game

On boot: `[EilifPaths] Eilif Paths v1.3.0 loaded. … Bed fire range: +8m. Workstation attachment
range: +10m.` Then each surface change logs once at Info:

```
[EilifPaths] terrain: PavedRoad (x1.75 speed, x0 stamina)
[EilifPaths] terrain: Path (x1.5 speed, x0 stamina)
[EilifPaths] terrain: Wood (x1.35 speed, x0 stamina)
[EilifPaths] terrain: None (vanilla speed/stamina)
```

If Path and PavedRoad look swapped (dirt logging as PavedRoad or vice-versa), the R/B channel
mapping is inverted for your build — swap the `c.b`/`c.r` checks in `UpdateGround`. Confidence in
the current mapping is high: the channel colors are read straight from the game's own
`Heightmap.m_paintMaskDirt/Paved` constants.
