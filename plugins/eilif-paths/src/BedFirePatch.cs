using System;
using System.Globalization;
using BepInEx.Configuration;
using HarmonyLib;
using UnityEngine;

namespace EilifPaths
{
    /// <summary>
    /// Extends the "your bed needs a fire nearby" check so a bed can sit much further from the
    /// hearth than vanilla allows. Client-side only, and configurable.
    ///
    /// VERIFIED BY DECOMPILE (ilspycmd against libs/assembly_valheim.dll, game 0.221.12):
    ///
    ///   private bool CheckFire(Player human)
    ///   {
    ///       if (!EffectArea.IsPointInsideArea(base.transform.position, EffectArea.Type.Heat))
    ///       {
    ///           human.Message(MessageHud.MessageType.Center, "$msg_bednofire");
    ///           return false;
    ///       }
    ///       return true;
    ///   }
    ///
    /// and the API it calls (EffectArea):
    ///
    ///   public static EffectArea IsPointInsideArea(Vector3 p, Type type, float radius = 0f)
    ///   {
    ///       if (type == Type.Burning &amp;&amp; radius.Equals(0.25f))
    ///       {
    ///           return GetBurningAreaPointPlus025(p);
    ///       }
    ///       int num = Physics.OverlapSphereNonAlloc(p, radius, m_tempColliders, s_characterMask);
    ///       for (int i = 0; i &lt; num; i++)
    ///       {
    ///           EffectArea component = m_tempColliders[i].GetComponent&lt;EffectArea&gt;();
    ///           if ((bool)component &amp;&amp; (component.m_type &amp; type) != 0)
    ///           {
    ///               return component;
    ///           }
    ///       }
    ///       return null;
    ///   }
    ///
    /// So: the method DOES take an extra radius, Bed.CheckFire omits it (radius = 0), and a
    /// zero-radius OverlapSphere is a plain point test. Vanilla reach is therefore exactly "the
    /// bed's own origin must lie inside the fireplace's Heat trigger collider" — nothing more.
    /// Passing a radius R turns that point test into a sphere test, so the effective reach becomes
    /// (fireplace Heat collider radius + R). It is purely additive: it can only ever ACCEPT more
    /// spots than vanilla, never fewer, which is why this approach was chosen over reimplementing
    /// the search with EffectArea.GetRadius() (that returns an unscaled local radius, and for a
    /// non-sphere collider it returns bounds.size.magnitude, so distance-vs-radius math there could
    /// come out tighter than vanilla for some hearth prefabs).
    ///
    /// DEFAULT (8 m): the campfire's Heat trigger radius lives in the prefab (Unity asset data), not
    /// in assembly_valheim.dll, so it cannot be quoted from a decompile. It is a small collider on
    /// the order of a few metres — in practice a bed has to be nearly touching the fire. 8 m extra
    /// is a deliberately generous choice that guarantees the "at least double" ask for any hearth
    /// whose Heat collider is 8 m or smaller (which every fire in the game comfortably is): a
    /// campfire in the 3-5 m range ends up with roughly 11-13 m of reach, i.e. 2.5x to 3.5x vanilla.
    /// The real numbers are logged at every successful check (see below) so they can be confirmed
    /// in-game from LogOutput.log and the default retuned from evidence if wanted.
    ///
    /// SAFETY: everything is inside try/catch, and every failure path returns true, which runs the
    /// untouched vanilla CheckFire. Bed interaction can never be broken by this patch. Setting
    /// extraFireRange = 0 disables the patch entirely (vanilla behaviour).
    ///
    /// NOTE: no System.ValueTuple anywhere in this file — see the warning above BindSurface(...) in
    /// EilifPathsPlugin.cs. The game's net462 Mono runtime ships no ValueTuple and a reference to it
    /// makes the plugin fail to load SILENTLY.
    /// </summary>
    internal static class BedFire
    {
        internal const float DefaultExtraRange = 8f;

        internal static ConfigEntry<float> ExtraRange;

        internal static void Bind(ConfigFile config)
        {
            ExtraRange = config.Bind("Bed", "extraFireRange", DefaultExtraRange,
                "Extra metres of reach for the bed's \"needs a fire nearby\" check, added on top of " +
                "the fireplace's own heat area. 0 = vanilla (the bed must sit inside the fire's heat " +
                "collider, roughly touching it). 8 = the Eilif default, comfortably more than double " +
                "the vanilla reach. Client-side; it only affects your own bed claims and sleeps.");
        }

        internal static string Describe()
        {
            float v = ExtraRange != null ? ExtraRange.Value : 0f;
            return v <= 0f
                ? "vanilla"
                : "+" + v.ToString("0.##", CultureInfo.InvariantCulture) + "m";
        }
    }

    /// <summary>
    /// Prefix on the private instance method <c>Bed.CheckFire(Player)</c>. Returns false (skip
    /// vanilla) only when the widened search finds a heat source; in every other case it returns
    /// true so the original method runs and shows its own "$msg_bednofire" message.
    /// </summary>
    [HarmonyPatch(typeof(Bed), "CheckFire")]
    internal static class Patch_Bed_CheckFire
    {
        private static bool Prefix(Bed __instance, ref bool __result)
        {
            try
            {
                ConfigEntry<float> cfg = BedFire.ExtraRange;
                if (cfg == null) return true;              // config not bound yet -> vanilla

                float extra = cfg.Value;
                if (!(extra > 0f)) return true;            // 0 (or NaN) -> vanilla
                if (__instance == null) return true;       // nothing to test -> vanilla

                Vector3 pos = __instance.transform.position;
                EffectArea area = EffectArea.IsPointInsideArea(pos, EffectArea.Type.Heat, extra);
                if (!area) return true;                    // no fire even widened -> vanilla message

                LogHit(pos, area, extra);
                __result = true;
                return false;                              // accept: skip vanilla CheckFire
            }
            catch (Exception ex)
            {
                try
                {
                    if (EilifPathsPlugin.Log != null)
                        EilifPathsPlugin.Log.LogWarning("[EilifPaths] bed fire check failed, using vanilla: " + ex.Message);
                }
                catch { /* logging must never throw out of a patch */ }
                return true;                               // any failure -> vanilla
            }
        }

        // Diagnostic only: reports the fireplace's own heat radius and how far the bed actually is,
        // so the chosen extraFireRange can be checked against real numbers in LogOutput.log.
        private static void LogHit(Vector3 bedPos, EffectArea area, float extra)
        {
            try
            {
                if (EilifPathsPlugin.Log == null) return;
                float dist = Vector3.Distance(bedPos, area.transform.position);
                float radius = area.GetRadius();
                EilifPathsPlugin.Log.LogInfo(
                    "[EilifPaths] bed fire check passed with +" +
                    extra.ToString("0.##", CultureInfo.InvariantCulture) + "m: heat source '" +
                    area.name + "' at " + dist.ToString("0.##", CultureInfo.InvariantCulture) +
                    "m, its own heat radius " + radius.ToString("0.##", CultureInfo.InvariantCulture) + "m.");
            }
            catch { /* diagnostics must never affect the check */ }
        }
    }
}
