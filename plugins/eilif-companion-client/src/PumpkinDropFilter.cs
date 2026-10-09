using System;
using System.Collections.Generic;
using System.Reflection;
using HarmonyLib;
using UnityEngine;

namespace EilifCompanionClient
{
    /// <summary>
    /// v0.4.6: HalloweenPieces pumpkins drop only from SELECTED creatures.
    ///
    /// The server runs blacks7ar-HalloweenPieces 1.2.0. Its CharacterDropPatch is a postfix on
    /// <c>Ragdoll.Setup</c> that appends a <c>BHP_PumpkinDrop</c> entry to the dying creature's
    /// <c>CharacterDrop.m_drops</c> for every enemy (any <c>$enemy_</c> name or non-Players faction)
    /// and then calls <c>Ragdoll.SaveLootList</c>, which rolls <c>CharacterDrop.GenerateDropList()</c>
    /// and writes the result into the ragdoll's ZDO. The roll happens on the client that owns the
    /// dying creature (normally the killer's), so the filter has to live in this client plugin.
    ///
    /// WHY GenerateDropList AND NOT Ragdoll.Setup. Every path that turns m_drops into loot goes through
    /// <c>public List&lt;KeyValuePair&lt;GameObject, int&gt;&gt; CharacterDrop.GenerateDropList()</c>:
    /// the ragdoll's SaveLootList (vanilla's call and the Halloween mod's second one) and
    /// <c>CharacterDrop.OnDeath</c> for creatures with no ragdoll. A postfix here removes the rolled
    /// pumpkin entries from the RESULT, so the order against the Halloween mod's own postfix does not
    /// matter, and m_drops itself is never touched.
    ///
    /// Config: <c>[Halloween] PumpkinDropCreatures</c> (comma-separated creature PREFAB names).
    /// <c>*</c> = every creature (filter off, the Halloween mod's own behaviour); empty = no creature
    /// drops pumpkins. Without HalloweenPieces there is no BHP_PumpkinDrop entry to remove, so the
    /// patch is inert on any other server.
    ///
    /// SAFETY. Runs on every loot roll, so it never throws into the game and never logs per kill:
    /// any exception is swallowed and reported once per session. If the patch fails to apply, drops
    /// are exactly what HalloweenPieces alone would produce.
    /// </summary>
    internal static class PumpkinDropFilter
    {
        internal const string PumpkinPrefab = "BHP_PumpkinDrop";

        internal const string DefaultCreatures =
            "Draugr,Draugr_Ranged,Draugr_Elite";

        // Mirrored from config in Awake (main thread), read on the loot path. Active = false means
        // "*" (every creature keeps its pumpkin); Active with an empty set means none do.
        internal static bool Active;
        internal static readonly HashSet<string> Allowed =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        internal static void Configure(string csv)
        {
            Allowed.Clear();
            Active = true;
            if (csv == null) return;
            foreach (var raw in csv.Split(','))
            {
                var name = raw.Trim();
                if (name.Length == 0) continue;
                if (name == "*") { Active = false; Allowed.Clear(); return; }
                Allowed.Add(name);
            }
        }

        internal static string Describe()
        {
            if (!Active) return "off (* = every creature, HalloweenPieces' own behaviour)";
            if (Allowed.Count == 0) return "no creature drops pumpkins";
            return Allowed.Count + " creature prefab(s) may drop pumpkins";
        }

        /// <summary>Same rule as the game's <c>Utils.GetPrefabName(string)</c> (assembly_utils, not
        /// referenced by this build): cut at the first '(' or ' ', which strips "(Clone)".</summary>
        internal static string PrefabName(string name)
        {
            if (string.IsNullOrEmpty(name)) return "";
            int cut = name.IndexOfAny(PrefabCut);
            return cut >= 0 ? name.Substring(0, cut) : name;
        }

        private static readonly char[] PrefabCut = { '(', ' ' };
    }

    [HarmonyPatch(typeof(CharacterDrop), nameof(CharacterDrop.GenerateDropList))]
    internal static class Patch_PumpkinDropFilter
    {
        // CharacterDrop.m_character is private; null handle falls back to GetComponent below.
        private static readonly FieldInfo CharacterField = AccessTools.Field(typeof(CharacterDrop), "m_character");

        private static bool _warned;

        private static void Postfix(CharacterDrop __instance, ref List<KeyValuePair<GameObject, int>> __result)
        {
            try
            {
                if (!PumpkinDropFilter.Active) return;
                if (__result == null || __result.Count == 0 || __instance == null) return;

                // Cheap pre-check: nothing to do unless a pumpkin was actually rolled.
                bool hasPumpkin = false;
                for (int i = 0; i < __result.Count; i++)
                {
                    if (IsPumpkin(__result[i].Key)) { hasPumpkin = true; break; }
                }
                if (!hasPumpkin) return;

                Character character = null;
                if (CharacterField != null) character = CharacterField.GetValue(__instance) as Character;
                if (character == null) character = __instance.GetComponent<Character>();
                if (character == null) return;

                string creature = PumpkinDropFilter.PrefabName(character.gameObject.name).Trim();
                if (PumpkinDropFilter.Allowed.Contains(creature)) return;

                __result.RemoveAll(kv => IsPumpkin(kv.Key));
            }
            catch (Exception ex)
            {
                if (_warned) return;
                _warned = true;
                try
                {
                    EilifMapTrackerPlugin.Log?.LogWarning(
                        "[EilifHalloween] pumpkin drop filter failed (logged once, drops left as rolled): " + ex.Message);
                }
                catch { }
            }
        }

        private static bool IsPumpkin(GameObject go)
        {
            return go != null &&
                   string.Equals(PumpkinDropFilter.PrefabName(go.name), PumpkinDropFilter.PumpkinPrefab,
                       StringComparison.OrdinalIgnoreCase);
        }
    }
}
