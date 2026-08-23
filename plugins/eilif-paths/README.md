# EilifPaths

A modern, drop-in replacement for the broken **Menthus "Useful Paths"** mod
(`Menthus-Useful_Paths` 1.0.5.0, 2021). Client-side BepInEx plugin for the Eilif Valheim server.

Players move faster and spend less stamina while on dirt paths, paved roads, and built floors —
exactly like the old mod — but detection uses the terrain API *current* Valheim actually uses, so
paths and roads work again.

Since **1.2.0** it also carries one unrelated quality-of-life patch: beds accept a fire much
further away (see [Bed fire range](#bed-fire-range-120)).

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

Plus one non-surface section: `[Bed] extraFireRange` = `8` (see below).

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

On boot: `[EilifPaths] Eilif Paths v1.2.0 loaded. … Bed fire range: +8m.` Then each surface change
logs once at Info:

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
