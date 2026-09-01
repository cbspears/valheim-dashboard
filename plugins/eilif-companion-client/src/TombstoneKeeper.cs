using System;
using System.Collections.Generic;
using HarmonyLib;

namespace EilifCompanionClient
{
    /// <summary>
    /// v0.3.0 — keep tools, weapons and ammo out of the tombstone.
    ///
    /// The server's death rules (vanilla `deathkeepequip`, enforced by the server-side
    /// Eilif Companion 0.3.0) only spare items that are EQUIPPED at the moment of death.
    /// Charlie's house rule goes further: everything you fight and build with stays on
    /// you — spare arrows/bolts, the hammer, the hoe, backup weapons — while resources,
    /// food and loot still drop, so a death remains a corpse run without being a
    /// re-gearing chore.
    ///
    /// Tombstone contents are decided CLIENT-side (`Player.CreateTombStone` →
    /// `Inventory.MoveInventoryToGrave`, which skips quest items and `m_equipped`
    /// items), so this must live in the client plugin. Rather than reimplement the
    /// method (private-field access + drift risk at every game patch), the Prefix
    /// briefly marks keep-listed items `m_equipped = true` so vanilla's own filter
    /// spares them, and the Finalizer unflags them again — the flag never survives
    /// past the one call, and if the patch ever fails to apply the game degrades to
    /// exact vanilla behavior.
    ///
    /// Deliberately gated on the world's DeathKeepEquip global key: on a server that
    /// hasn't opted into gentle deaths (someone carrying this profile to a random
    /// public server), the patch does nothing.
    /// </summary>
    internal static class TombstoneKeeper
    {
        // Parsed from config in Awake; read on the death path. Empty set = feature off.
        internal static readonly HashSet<ItemDrop.ItemData.ItemType> KeepTypes =
            new HashSet<ItemDrop.ItemData.ItemType>();

        internal const string DefaultKeepTypes =
            "OneHandedWeapon, TwoHandedWeapon, TwoHandedWeaponLeft, Bow, Shield, Torch, Tool, Ammo, AmmoNonEquipable";

        internal static void Configure(string csv)
        {
            KeepTypes.Clear();
            if (string.IsNullOrEmpty(csv)) return;
            foreach (var raw in csv.Split(','))
            {
                var name = raw.Trim();
                if (name.Length == 0) continue;
                try
                {
                    KeepTypes.Add((ItemDrop.ItemData.ItemType)Enum.Parse(typeof(ItemDrop.ItemData.ItemType), name, true));
                }
                catch
                {
                    EilifMapTrackerPlugin.Log.LogWarning($"[EilifDeath] unknown item type '{name}' in KeepItemTypes - ignored.");
                }
            }
        }
    }

    [HarmonyPatch(typeof(Inventory), "MoveInventoryToGrave")]
    internal static class Patch_MoveInventoryToGrave
    {
        // Death runs on the main thread and graves never nest; a static scratch list is safe.
        private static readonly List<ItemDrop.ItemData> Flagged = new List<ItemDrop.ItemData>();

        private static void Prefix(Inventory original)
        {
            Flagged.Clear();
            try
            {
                if (TombstoneKeeper.KeepTypes.Count == 0) return;
                if (ZoneSystem.instance == null ||
                    !ZoneSystem.instance.GetGlobalKey(GlobalKeys.DeathKeepEquip)) return;

                foreach (var item in original.GetAllItems())
                {
                    if (item == null || item.m_equipped) continue;
                    if (item.m_shared == null || item.m_shared.m_questItem) continue;
                    if (!TombstoneKeeper.KeepTypes.Contains(item.m_shared.m_itemType)) continue;
                    item.m_equipped = true; // vanilla's grave filter now spares it
                    Flagged.Add(item);
                }
                if (Flagged.Count > 0)
                    EilifMapTrackerPlugin.Log.LogInfo($"[EilifDeath] tombstone keep-list spared {Flagged.Count} item(s).");
            }
            catch (Exception ex)
            {
                EilifMapTrackerPlugin.Log.LogWarning($"[EilifDeath] tombstone keep-list prefix failed: {ex.Message}");
            }
        }

        // Finalizer (not Postfix) so the temporary flags are removed even if the
        // patched method throws mid-move.
        private static void Finalizer()
        {
            foreach (var item in Flagged)
            {
                try { item.m_equipped = false; } catch { }
            }
            Flagged.Clear();
        }
    }
}
