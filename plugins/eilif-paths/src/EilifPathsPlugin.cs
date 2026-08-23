using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using BepInEx;
using BepInEx.Bootstrap;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using UnityEngine;

namespace EilifPaths
{
    /// <summary>
    /// A modern, drop-in replacement for the broken Menthus "Useful Paths" mod
    /// (Thunderstore Menthus-Useful_Paths 1.0.5.0, 2021).
    ///
    /// EFFECT (identical surface to the old mod): while the local player stands on a
    /// recognised surface, jog/run speed is multiplied up and stamina drain is multiplied
    /// down. Walking speed gets the same movement multiplier. All multipliers are
    /// per-surface and configurable, and revert instantly the moment you step off.
    ///
    /// WHY THE OLD MOD BROKE: it detected dirt paths / paved roads via
    /// <c>TerrainModifier.FindClosestModifierPieceInRange(pos, 6f)</c>. Modern Valheim no
    /// longer leaves persistent per-hoe TerrainModifier pieces on the ground — terrain paint
    /// is baked into each Heightmap's <c>m_paintMask</c> texture (dirt = R, cultivated = G,
    /// paved = B). So the old lookup returned null for paths/roads and only built floors
    /// (detected via WearNTear) still worked. This mod reads the paint mask directly.
    ///
    /// DETECTION (polled every 0.4s, cheap):
    ///   1. Built floors: GetLastGroundCollider() -> WearNTear.m_materialType
    ///      (Wood / Stone / Iron / HardWood) — unchanged from the old mod, still valid.
    ///   2. Terrain paint: Heightmap.FindHeightmap(pos) -> read m_paintMask pixel.
    ///        blue  channel > 0.5  => PavedRoad  (Heightmap.m_paintMaskPaved = 0,0,1,1)
    ///        red   channel > 0.5  => Path       (Heightmap.m_paintMaskDirt  = 1,0,0,1)
    ///        green channel        => cultivated farmland (not a road; treated as None)
    ///   LevelGround (hoe "level ground") is NOT detectable: leveling only edits heights, it
    ///   paints nothing and leaves no persistent piece, so there is no reliable signal to key
    ///   off. It is intentionally dropped (see README / final report).
    /// </summary>
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    public class EilifPathsPlugin : BaseUnityPlugin
    {
        public const string PluginGuid = "net.eilif.paths";
        public const string PluginName = "Eilif Paths";
        public const string PluginVersion = "1.1.0";

        // GUID of the old Menthus mod — if it is still loaded we must not double-apply.
        private const string OldModGuid = "Menthus.bepinex.plugins.UsefulPaths";

        internal static ManualLogSource Log;

        private const float GroundCheckRate = 0.4f;

        public enum PathType { None, Path, PavedRoad, Wood, Stone, Iron, HardWood }

        // Movement + stamina multipliers, keyed by surface. Set once in Awake from config.
        internal static readonly Dictionary<PathType, ConfigEntry<float>> Movement =
            new Dictionary<PathType, ConfigEntry<float>>();
        internal static readonly Dictionary<PathType, ConfigEntry<float>> StaminaDrain =
            new Dictionary<PathType, ConfigEntry<float>>();

        // The surface the local player is currently standing on (written on the 0.4s timer,
        // read by the Harmony patches). volatile-ish: single writer (main thread), single reader.
        internal static PathType Current { get; private set; } = PathType.None;

        // When the deprecated Useful_Paths mod is also loaded, it still (correctly) boosts
        // built floors via WearNTear. To avoid stacking, we then cede floors to it and only
        // add the Path / PavedRoad detection it can no longer do.
        internal static bool OldModPresent { get; private set; }

        // Owner-chosen defaults. movement = speed multiplier, staminadrain = stamina-cost multiplier.
        // (Path 1.25/0 · PavedRoad 1.75/0 · Wood/Stone/Iron/HardWood 1.5/0 — zero drain on every surface)
        // NOTE: deliberately NOT a tuple/collection field initializer — the plugin class must not
        // reference System.ValueTuple (not shipped with the game's net462 runtime; a static field
        // initializer using it makes the whole class fail to instantiate under BepInEx).
        private void BindSurface(PathType type, float move, float stam)
        {
            string section = type.ToString();
            Movement[type] = Config.Bind(section, "movement", move,
                "Speed multiplier while on " + section + " (1.0 = vanilla, >1 = faster).");
            StaminaDrain[type] = Config.Bind(section, "staminadrain", stam,
                "Stamina-cost multiplier while on " + section + " (1.0 = vanilla, <1 = drains less).");
        }

        private void Awake()
        {
            Log = Logger;

            BindSurface(PathType.Path,      1.25f, 0f);
            BindSurface(PathType.PavedRoad, 1.75f, 0f);
            BindSurface(PathType.Wood,       1.5f, 0f);
            BindSurface(PathType.Stone,      1.5f, 0f);
            BindSurface(PathType.Iron,       1.5f, 0f);
            BindSurface(PathType.HardWood,   1.5f, 0f);

            OldModPresent = Chainloader.PluginInfos != null &&
                            Chainloader.PluginInfos.ContainsKey(OldModGuid);
            if (OldModPresent)
            {
                Log.LogWarning("========================================================================");
                Log.LogWarning("[EilifPaths] The OLD 'Useful_Paths' (Menthus.bepinex.plugins.UsefulPaths)");
                Log.LogWarning("[EilifPaths] mod is ALSO loaded. It is superseded by EilifPaths and its");
                Log.LogWarning("[EilifPaths] path/road detection is broken on current Valheim. To avoid");
                Log.LogWarning("[EilifPaths] DOUBLE-APPLYING bonuses on built floors, EilifPaths is ceding");
                Log.LogWarning("[EilifPaths] Wood/Stone/Iron/HardWood floors to the old mod and handling");
                Log.LogWarning("[EilifPaths] ONLY dirt Path + PavedRoad here. >>> Please DISABLE Useful_Paths");
                Log.LogWarning("[EilifPaths] in the r2modman UI (and re-export the pack) for correct values.");
                Log.LogWarning("========================================================================");
            }

            InvokeRepeating(nameof(UpdateGround), 0f, GroundCheckRate);
            new Harmony(PluginGuid).PatchAll(typeof(EilifPathsPlugin).Assembly);

            Log.LogInfo($"[EilifPaths] {PluginName} v{PluginVersion} loaded. Surfaces: " +
                        "Path x" + F(Movement[PathType.Path]) + "/" + F(StaminaDrain[PathType.Path]) + ", " +
                        "PavedRoad x" + F(Movement[PathType.PavedRoad]) + "/" + F(StaminaDrain[PathType.PavedRoad]) + ", " +
                        "floors x" + F(Movement[PathType.Wood]) + "/" + F(StaminaDrain[PathType.Wood]) +
                        ". Polling every " + GroundCheckRate.ToString("0.0", CultureInfo.InvariantCulture) + "s.");
        }

        private static string F(ConfigEntry<float> c) => c.Value.ToString("0.##", CultureInfo.InvariantCulture);

        /// <summary>
        /// 0.4s poll: work out which surface the local player is on and update <see cref="Current"/>.
        /// Logs exactly once per surface CHANGE at Info level so the owner can verify in one session.
        /// </summary>
        private void UpdateGround()
        {
            var player = Player.m_localPlayer;
            if (player == null) { SetCurrent(PathType.None); return; }

            PathType detected = PathType.None;

            // 1) Built floors via WearNTear material (unchanged from the old mod).
            //    If the old mod is present it already handles these, so we skip to avoid stacking.
            if (!OldModPresent)
            {
                try
                {
                    Collider col = player.GetLastGroundCollider();
                    if (col != null)
                    {
                        WearNTear wnt = col.GetComponentInParent<WearNTear>();
                        if (wnt != null)
                        {
                            switch (wnt.m_materialType)
                            {
                                case WearNTear.MaterialType.Wood:     detected = PathType.Wood;     break;
                                case WearNTear.MaterialType.Stone:    detected = PathType.Stone;    break;
                                case WearNTear.MaterialType.Iron:     detected = PathType.Iron;     break;
                                case WearNTear.MaterialType.HardWood: detected = PathType.HardWood; break;
                            }
                        }
                    }
                }
                catch (Exception ex) { Log.LogWarning($"[EilifPaths] floor check failed: {ex.Message}"); }
            }

            // 2) Terrain paint via the current Heightmap paint mask (the modern API).
            if (detected == PathType.None)
            {
                try
                {
                    Vector3 pos = player.transform.position;
                    Heightmap hm = Heightmap.FindHeightmap(pos);
                    if (hm != null)
                    {
                        // Match the game's own IsCleared() sampling: shift by -0.5 on x/z, convert to
                        // mask-vertex coords, then read the paint pixel. GetPaintMask(x,y) is bounds-safe.
                        Vector3 wp = pos; wp.x -= 0.5f; wp.z -= 0.5f;
                        hm.WorldToVertexMask(wp, out int x, out int y);
                        Color c = hm.GetPaintMask(x, y);
                        if (c.b > 0.5f) detected = PathType.PavedRoad; // Heightmap.m_paintMaskPaved (0,0,1,1)
                        else if (c.r > 0.5f) detected = PathType.Path; // Heightmap.m_paintMaskDirt  (1,0,0,1)
                        // green (cultivated farmland) intentionally ignored -> None
                    }
                }
                catch (Exception ex) { Log.LogWarning($"[EilifPaths] paint check failed: {ex.Message}"); }
            }

            SetCurrent(detected);
        }

        private static void SetCurrent(PathType t)
        {
            if (t == Current) return;
            Current = t;
            if (t == PathType.None)
            {
                Log.LogInfo("[EilifPaths] terrain: None (vanilla speed/stamina)");
            }
            else
            {
                float mv = Movement[t].Value, st = StaminaDrain[t].Value;
                Log.LogInfo($"[EilifPaths] terrain: {t} (x{mv.ToString("0.##", CultureInfo.InvariantCulture)} speed, " +
                            $"x{st.ToString("0.##", CultureInfo.InvariantCulture)} stamina)");
            }
        }

        internal static float MoveMult() =>
            Current == PathType.None ? 1f : Movement[Current].Value;
        internal static float StamMult() =>
            Current == PathType.None ? 1f : StaminaDrain[Current].Value;
    }

    // --- Harmony patches (same surface the old mod used) ---

    // Jog speed factor: multiply the vanilla result while on a surface.
    [HarmonyPatch(typeof(Player), "GetJogSpeedFactor")]
    internal static class Patch_GetJogSpeedFactor
    {
        private static void Postfix(ref float __result)
        {
            if (EilifPathsPlugin.Current != EilifPathsPlugin.PathType.None)
                __result *= EilifPathsPlugin.MoveMult();
        }
    }

    // Run speed factor: multiply the vanilla result while on a surface.
    [HarmonyPatch(typeof(Player), "GetRunSpeedFactor")]
    internal static class Patch_GetRunSpeedFactor
    {
        private static void Postfix(ref float __result)
        {
            if (EilifPathsPlugin.Current != EilifPathsPlugin.PathType.None)
                __result *= EilifPathsPlugin.MoveMult();
        }
    }

    // Stamina drain: scale the cost down while on a surface.
    [HarmonyPatch(typeof(Player), "UseStamina")]
    internal static class Patch_UseStamina
    {
        private static void Prefix(ref float v)
        {
            if (EilifPathsPlugin.Current != EilifPathsPlugin.PathType.None)
                v *= EilifPathsPlugin.StamMult();
        }
    }

    // Walk speed: the jog/run factors above don't touch walking (Character.UpdateWalking sets
    // speed = m_walkSpeed directly when walking). Modern vanilla m_walkSpeed is ~5 (it was 1.6
    // in 2021 — the old mod hard-set "1.6f * mult", which today would SLOW walking). Instead we
    // MULTIPLY the current value for the local player only, then restore it in the postfix so
    // character state is never permanently mutated and reverts cleanly off-path.
    [HarmonyPatch(typeof(Character), "UpdateWalking")]
    internal static class Patch_UpdateWalking
    {
        private static void Prefix(Character __instance, out float __state)
        {
            __state = __instance != null ? __instance.m_walkSpeed : 0f;
            if (__instance != null && __instance == Player.m_localPlayer &&
                EilifPathsPlugin.Current != EilifPathsPlugin.PathType.None)
            {
                __instance.m_walkSpeed *= EilifPathsPlugin.MoveMult();
            }
        }

        private static void Postfix(Character __instance, float __state)
        {
            if (__instance != null)
                __instance.m_walkSpeed = __state;
        }
    }
}
