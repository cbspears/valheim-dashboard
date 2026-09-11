using System;
using System.Collections.Generic;
using System.Reflection;
using BepInEx.Bootstrap;
using BepInEx.Configuration;
using HarmonyLib;

namespace EilifPaths
{
    /// <summary>
    /// ValheimPlus hotfix shim (1.7.2). Removes exactly TWO ValheimPlus Harmony patches and
    /// nothing else, because on Valheim 1.0.12 those two are broken beyond use.
    ///
    /// WHAT BROKE. Valheim hotfix 1.0.10/1.0.12 (dedicated build 25253791) turned
    /// <c>PlayerProfile.s_bypassCheatChecks</c> from a public static FIELD into a static
    /// PROPERTY. ValheimPlus 10.0.2 and 10.0.3 were compiled against the field, so their IL
    /// still carries <c>ldsfld bool [assembly_valheim]PlayerProfile::s_bypassCheatChecks</c> in
    /// two places (verified by IL dump of both DLLs, 2026-09-11):
    ///
    ///   * <c>ValheimPlus.GameClasses.Smelter_Spawn_Patch</c> — its Harmony PREFIX on
    ///     <c>Smelter.Spawn</c>. (The instruction sits in the prefix's compiler-generated local
    ///     function <c>&lt;Prefix&gt;g__spawn|0_0</c>, which only the prefix can reach.)
    ///   * <c>ValheimPlus.GameClasses.Fermenter_DelayedTap_Transpiler</c> — its helper
    ///     <c>DropItemToNearbyChest</c>, which that class's TRANSPILER on
    ///     <c>Fermenter.DelayedTap</c> injects into the vanilla method in place of
    ///     <c>Object.Instantiate</c>.
    ///
    /// A field token that now resolves to a property is a <c>MissingFieldException</c> the
    /// moment Mono JIT-compiles the method holding it, so smelters, kilns, furnaces, windmills,
    /// spinning wheels and fermenter taps stop producing while V+ is loaded.
    ///
    /// WHY REMOVING THEM IS FREE HERE. The Eilif server runs V+ with [Smelter], [Kiln],
    /// [Furnace], [Windmill], [SpinningWheel] and [Fermenter] disabled, so the only thing those
    /// two patches would do if they worked is auto-deposit into nearby chests — a feature this
    /// server does not use. Everything else ValheimPlus does is left completely untouched.
    ///
    /// HOW IT IDENTIFIES A PATCH. <see cref="Strip"/> only ever removes a patch whose patch
    /// method's DECLARING TYPE NAME contains one of the two class names above. That is the hard
    /// gate: a V+ patch on the same method from any other class, and every patch belonging to
    /// any other mod, is left alone. The Harmony owner id (<c>mod.valheim_plus</c>) is checked
    /// too, but only to log a warning if it does not match — a renamed V+ fork with a different
    /// Harmony id still carries the same broken class names, and that is the case worth covering.
    ///
    /// WHY IT RE-RUNS. ValheimPlus does not patch once. <c>ValheimPlusPlugin.PatchAll()</c> is
    /// called again from <c>ReapplyPatches(reason)</c> (= <c>UnpatchSelf()</c> then
    /// <c>PatchAll()</c>) on "Received config from the server" — i.e. on a client the first time
    /// it joins a server — and on "Config source changed", and again whenever the Configuration
    /// Manager window is closed after an edit. A one-shot unpatch in Awake is therefore undone
    /// by the first join. So this shim installs a Harmony POSTFIX on
    /// <c>ValheimPlusPlugin.PatchAll</c> (resolved by reflection, so this file still compiles and
    /// loads when V+ is absent) and re-runs the strip there, with a slow
    /// <see cref="RecheckSeconds"/>-second timer as belt and braces for any repatch route nobody
    /// has found yet. Our postfix survives V+'s own <c>UnpatchSelf()</c>, which only removes
    /// patches owned by <c>mod.valheim_plus</c>.
    ///
    /// NOT A PATCH-ROSTER CLASS. This type carries no [HarmonyPatch] attribute and is applied by
    /// hand (same convention as ToolStamina.Apply), so `Core patch classes: 8/8` and
    /// `VPlusFallback patch classes: 17/17` mean exactly what they meant in 1.7.1.
    ///
    /// NOTE: no System.ValueTuple anywhere in this file — see the comment above BindSurface(...)
    /// in EilifPathsPlugin.cs.
    /// </summary>
    internal static class VPlusHotfix
    {
        internal const string Section = "VPlusHotfixShim";

        /// <summary>ValheimPlus's BepInEx GUID. Also the SoftDependency on the plugin class, which
        /// is what guarantees BepInEx loads V+ (and runs its Awake, hence its first PatchAll)
        /// BEFORE us.</summary>
        internal const string ValheimPlusGuid = "org.bepinex.plugins.valheim_plus";

        /// <summary>V+'s main Harmony instance id (ValheimPlusPlugin.Harmony). Its ServerSync
        /// helper uses "mod.valheim_plus.serversync"; neither of the two patches below belongs to
        /// that one.</summary>
        private const string VPlusHarmonyId = "mod.valheim_plus";

        private const string VPlusPluginTypeName = "ValheimPlus.ValheimPlusPlugin";
        private const string SmelterPatchClass = "Smelter_Spawn_Patch";
        private const string FermenterPatchClass = "Fermenter_DelayedTap_Transpiler";

        internal const float RecheckSeconds = 30f;

        internal static ConfigEntry<bool> Enabled;

        /// <summary>True once the shim has something to guard, i.e. the config is on AND
        /// ValheimPlus is loaded. The periodic re-check does nothing while this is false.</summary>
        internal static bool Armed { get; private set; }

        private static Harmony _harmony;
        private static bool _inSweep;
        private static string _vplusMatch;

        internal static void Bind(ConfigFile config)
        {
            Enabled = config.Bind(Section, "Enabled", true,
                "Remove the two ValheimPlus Harmony patches that are broken on Valheim 1.0.12 " +
                "(hotfix build 25253791): the prefix on Smelter.Spawn and the transpiler on " +
                "Fermenter.DelayedTap. Both still read PlayerProfile.s_bypassCheatChecks as a " +
                "FIELD, which 1.0.12 turned into a property, so they throw MissingFieldException " +
                "and smelters, kilns, furnaces, windmills, spinning wheels and fermenter taps " +
                "stop producing. Nothing else of ValheimPlus is touched, and the only V+ feature " +
                "lost is auto-deposit into nearby chests, which this server has switched off " +
                "anyway. Set to false only once ValheimPlus ships a build compiled against " +
                "1.0.12 or later. Has no effect at all when ValheimPlus is not installed.");
        }

        /// <summary>
        /// Called once from Awake, AFTER our own Harmony patches are on. Safe to call when V+ is
        /// absent or the section is off: it says so and arms nothing.
        /// </summary>
        internal static void Apply(Harmony harmony)
        {
            _harmony = harmony;
            try
            {
                if (Enabled == null || !Enabled.Value)
                {
                    EilifPathsPlugin.Log.LogInfo("[EilifPaths] VPlusHotfixShim: disabled in config " +
                        "([" + Section + "] Enabled = false); ValheimPlus patches left exactly as they are.");
                    return;
                }

                Type vplus = FindValheimPlus();
                if (vplus == null)
                {
                    EilifPathsPlugin.Log.LogInfo("[EilifPaths] VPlusHotfixShim: inert - ValheimPlus is not " +
                        "loaded, so there is nothing to undo.");
                    return;
                }

                Armed = true;
                HookRepatch(vplus);

                int smelter, fermenter;
                Sweep(out smelter, out fermenter);
                EilifPathsPlugin.Log.LogInfo("[EilifPaths] VPlusHotfixShim: Smelter.Spawn prefix removed (" +
                    smelter + "), Fermenter.DelayedTap transpiler removed (" + fermenter + "). " +
                    "ValheimPlus seen as " + _vplusMatch + "; re-checked on every ValheimPlus repatch and " +
                    "every " + RecheckSeconds.ToString("0") + "s.");

                // The state AFTER the strip, straight out of Harmony.GetPatchInfo, so a boot log
                // proves the removal rather than merely asserting it. Anything still listed here is
                // a patch this shim deliberately did NOT touch.
                EilifPathsPlugin.Log.LogInfo("[EilifPaths] VPlusHotfixShim: after - " +
                    Describe(AccessTools.Method(typeof(Smelter), "Spawn"), "Smelter.Spawn") + "; " +
                    Describe(AccessTools.Method(typeof(Fermenter), "DelayedTap"), "Fermenter.DelayedTap") + ".");

                if (smelter == 0 && fermenter == 0)
                {
                    EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusHotfixShim: ValheimPlus is loaded but " +
                        "neither broken patch was found on Smelter.Spawn or Fermenter.DelayedTap. Either this " +
                        "ValheimPlus build has already been fixed (good - the shim can be switched off), or its " +
                        "patch classes were renamed and this shim is no longer finding them (bad - smelters and " +
                        "fermenters will still be dead). Check the V+ build before grading this line.");
                }
            }
            catch (Exception ex)
            {
                // Never take the plugin down over the shim: everything else in EilifPaths is
                // independent of ValheimPlus.
                EilifPathsPlugin.Log.LogError("[EilifPaths] VPlusHotfixShim: failed to apply: " + ex.Message +
                    " -> ValheimPlus's broken Smelter/Fermenter patches are still in place.");
            }
        }

        /// <summary>Slow belt-and-braces re-check (see the class comment). Quiet unless it
        /// actually had to remove something.</summary>
        internal static void Recheck()
        {
            if (!Armed) return;
            ReSweep("periodic re-check");
        }

        /// <summary>Harmony postfix on ValheimPlusPlugin.PatchAll — the moment V+ has finished
        /// (re-)applying everything, strip the two patches again. Must never throw: it runs
        /// inside V+'s own call stack.</summary>
        private static void AfterVPlusPatchAll()
        {
            try
            {
                if (!Armed) return;
                ReSweep("ValheimPlus re-applied its patches");
            }
            catch { /* a throw here would surface as a ValheimPlus patch failure */ }
        }

        private static void ReSweep(string reason)
        {
            if (_inSweep) return;
            _inSweep = true;
            try
            {
                int smelter, fermenter;
                Sweep(out smelter, out fermenter);
                if (smelter > 0 || fermenter > 0)
                {
                    EilifPathsPlugin.Log.LogInfo("[EilifPaths] VPlusHotfixShim: " + reason +
                        "; removed again (Smelter.Spawn prefix " + smelter +
                        ", Fermenter.DelayedTap transpiler " + fermenter + ").");
                }
            }
            catch (Exception ex)
            {
                EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusHotfixShim: re-check failed (" + reason +
                    "): " + ex.Message);
            }
            finally { _inSweep = false; }
        }

        private static void Sweep(out int smelter, out int fermenter)
        {
            smelter = Strip(AccessTools.Method(typeof(Smelter), "Spawn"), "Smelter.Spawn",
                            HarmonyPatchType.Prefix, SmelterPatchClass);
            fermenter = Strip(AccessTools.Method(typeof(Fermenter), "DelayedTap"), "Fermenter.DelayedTap",
                              HarmonyPatchType.Transpiler, FermenterPatchClass);
        }

        /// <summary>
        /// Remove every patch of <paramref name="kind"/> on <paramref name="original"/> whose patch
        /// method is declared by a type whose NAME contains <paramref name="patchClassFragment"/>.
        /// The name test is the hard gate — nothing else is ever unpatched.
        /// </summary>
        private static int Strip(MethodBase original, string targetLabel, HarmonyPatchType kind,
                                 string patchClassFragment)
        {
            if (original == null)
            {
                EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusHotfixShim: " + targetLabel +
                    " not found on this game build - cannot check it for the broken ValheimPlus patch.");
                return 0;
            }

            Patches info;
            try { info = Harmony.GetPatchInfo(original); }
            catch (Exception ex)
            {
                EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusHotfixShim: could not read patch info for " +
                    targetLabel + ": " + ex.Message);
                return 0;
            }
            if (info == null) return 0;

            // Copy first: Unpatch mutates the live collection this came from.
            var candidates = new List<Patch>();
            var source = kind == HarmonyPatchType.Prefix ? info.Prefixes : info.Transpilers;
            if (source != null) candidates.AddRange(source);

            int removed = 0;
            foreach (Patch p in candidates)
            {
                MethodInfo pm = null;
                try { pm = p == null ? null : p.PatchMethod; } catch { pm = null; }
                if (pm == null) continue;

                Type decl = pm.DeclaringType;
                string declName = decl == null ? "" : decl.Name;
                if (declName.IndexOf(patchClassFragment, StringComparison.Ordinal) < 0) continue;

                string owner = p.owner ?? "(none)";
                if (!string.Equals(owner, VPlusHarmonyId, StringComparison.Ordinal))
                {
                    EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusHotfixShim: " + targetLabel + " carries a " +
                        declName + " patch owned by '" + owner + "', not '" + VPlusHarmonyId +
                        "'. Removing it anyway - that class name is ValheimPlus's and it is broken on 1.0.12.");
                }

                try
                {
                    _harmony.Unpatch(original, pm);
                    removed++;
                }
                catch (Exception ex)
                {
                    EilifPathsPlugin.Log.LogError("[EilifPaths] VPlusHotfixShim: could not unpatch " + declName +
                        "." + pm.Name + " from " + targetLabel + ": " + ex.Message);
                }
            }
            return removed;
        }

        /// <summary>A one-line dump of who still patches a method, for the boot log.</summary>
        private static string Describe(MethodBase original, string label)
        {
            if (original == null) return label + " NOT FOUND on this game build";
            try
            {
                Patches info = Harmony.GetPatchInfo(original);
                if (info == null) return label + " prefixes 0, transpilers 0 (no patches at all)";
                return label + " prefixes " + info.Prefixes.Count + " " + Owners(info.Prefixes) +
                       ", transpilers " + info.Transpilers.Count + " " + Owners(info.Transpilers);
            }
            catch (Exception ex) { return label + " patch info unreadable (" + ex.Message + ")"; }
        }

        private static string Owners(System.Collections.ObjectModel.ReadOnlyCollection<Patch> list)
        {
            if (list == null || list.Count == 0) return "[]";
            var sb = new System.Text.StringBuilder("[");
            for (int i = 0; i < list.Count; i++)
            {
                if (i > 0) sb.Append(", ");
                MethodInfo pm = null;
                try { pm = list[i].PatchMethod; } catch { }
                sb.Append(list[i].owner ?? "?").Append(':')
                  .Append(pm != null && pm.DeclaringType != null ? pm.DeclaringType.Name : "?");
            }
            return sb.Append(']').ToString();
        }

        /// <summary>ValheimPlus is identified by BepInEx GUID first and by its plugin TYPE second,
        /// so a fork that renamed the DLL (or the GUID) is still found.</summary>
        private static Type FindValheimPlus()
        {
            try
            {
                if (Chainloader.PluginInfos != null &&
                    Chainloader.PluginInfos.ContainsKey(ValheimPlusGuid))
                {
                    var t0 = AccessTools.TypeByName(VPlusPluginTypeName);
                    _vplusMatch = "BepInEx GUID " + ValheimPlusGuid;
                    return t0; // may be null if the type was renamed; HookRepatch handles that
                }
            }
            catch { /* fall through to the type scan */ }

            Type t;
            try { t = AccessTools.TypeByName(VPlusPluginTypeName); }
            catch { t = null; }
            if (t != null) _vplusMatch = "type " + VPlusPluginTypeName + " in " + t.Assembly.GetName().Name;
            return t;
        }

        private static void HookRepatch(Type vplusPluginType)
        {
            if (vplusPluginType == null)
            {
                EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusHotfixShim: ValheimPlus is loaded but its " +
                    VPlusPluginTypeName + " type could not be resolved, so the PatchAll postfix is NOT armed. " +
                    "The " + RecheckSeconds.ToString("0") + "s re-check still covers a ValheimPlus repatch, " +
                    "with up to that much of a gap.");
                return;
            }

            MethodInfo patchAll = AccessTools.Method(vplusPluginType, "PatchAll", Type.EmptyTypes);
            if (patchAll == null)
            {
                EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusHotfixShim: " + VPlusPluginTypeName +
                    ".PatchAll() not found, so the repatch postfix is NOT armed. ValheimPlus re-applies its " +
                    "patches when a client receives the server config, so without this hook the shim relies " +
                    "on the " + RecheckSeconds.ToString("0") + "s re-check alone.");
                return;
            }

            try
            {
                _harmony.Patch(patchAll, null,
                    new HarmonyMethod(AccessTools.Method(typeof(VPlusHotfix), nameof(AfterVPlusPatchAll))));
            }
            catch (Exception ex)
            {
                EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusHotfixShim: could not hook " +
                    VPlusPluginTypeName + ".PatchAll: " + ex.Message + " (falling back to the " +
                    RecheckSeconds.ToString("0") + "s re-check alone).");
            }
        }
    }
}
