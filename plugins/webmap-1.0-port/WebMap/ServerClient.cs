using System;
using System.Collections.Generic;
using HarmonyLib;
using Splatform;
using Steamworks;
using UnityEngine;

// Authored by Jere Kuusela <https://github.com/JereKuusela>
// https://github.com/JereKuusela/valheim-expand_world_prefabs/blob/main/ExpandWorldPrefabs/service/ServerClient.cs (public domain)

namespace WebMap
{
    public class ServerClient
    {
        public static ZNet.PlayerInfo Client => client ??= CreatePlayerInfo();
        private static ZNet.PlayerInfo? client;

        // Server client is only sent to clients, so this is needed for the server to recognize it.
        [HarmonyPatch(typeof(ZNet), nameof(ZNet.TryGetPlayerByPlatformUserID))]
        public class RecognizeServerClient
        {
            static bool Postfix(bool result, PlatformUserID platformUserID, ref ZNet.PlayerInfo playerInfo)
            {
                if (result) return result;
                if (platformUserID != Client.m_userInfo.m_id) return result;

                playerInfo = Client;
                return true;
            }
        }

        // Valheim 1.0 moved the packet building out of SendPlayerList into the new helper
        // ZNet.WritePlayerInfo(List<PlayerInfo>). The old transpiler matched the last `ldfld m_players`,
        // which in 1.0 is the `WritePlayerInfo(m_players)` argument load, and injected `ldloc.0` BEFORE
        // the ZPackage local was assigned -> AddServer received null -> NullReferenceException on every
        // SendPlayerList tick and inside RPC_PeerInfo, so joining clients never got a player list.
        // A postfix on the helper is both simpler and immune to codegen churn.
        [HarmonyPatch(typeof(ZNet), nameof(ZNet.WritePlayerInfo), new Type[] { typeof(List<ZNet.PlayerInfo>) })]
        public class AddExtraPlayer
        {
            static void Postfix(List<ZNet.PlayerInfo> playerInfoList, ref ZPackage __result)
            {
                ZPackage pkg = __result;

                // The helper writes the entry count as a fixed 4-byte int at offset 0, then one blob per
                // entry. Append our fake "Server" entry and bump that count.
                int end = pkg.GetPos();
                pkg.SetPos(0);
                int count = pkg.ReadInt();

                // Needed in case multiple mods are adding extra players.
                if (count >= playerInfoList.Count + 1)
                {
                    pkg.SetPos(end);
                    return;
                }

                pkg.SetPos(0);
                pkg.Write(playerInfoList.Count + 1);
                pkg.SetPos(end);
                Write(pkg);
            }
        }

        private static ZNet.PlayerInfo CreatePlayerInfo() => new()
        {
            m_name = "Server",
            // Receiving chat messages requires a valid character ID.
            m_characterID = new ZDOID(ZDOMan.GetSessionID(), uint.MaxValue),
            // 1.0 moved m_serverAssignedDisplayName from PlayerInfo onto PlayerInfo.m_userInfo (CrossNetworkUserInfo).
            // m_playfabId MUST be non-null: ZNet.WritePlayerInfo (and Write below) pass it straight to
            // BinaryWriter.Write(string), which throws ArgumentNullException on null. Vanilla never hits
            // this because ZNetPeer.m_playfabId defaults to "". "" is the same wire value a Steam-only
            // peer produces, so the packet stays byte-identical to vanilla.
            m_userInfo = new() { m_id = new(ZNet.instance.m_steamPlatform, GetId()), m_displayName = "Server", m_serverAssignedDisplayName = "Server", m_playfabId = "" },
            m_publicPosition = false,
            m_position = Vector3.zero,
        };

        private static string GetId()
        {
            try
            {
                return SteamGameServer.GetSteamID().ToString();
            }
            catch (InvalidOperationException)
            {
                return "0";
            }
        }

        // Field order MUST match ZNet.WritePlayerInfo (the PlayerList packet), NOT
        // ZNet.PlayerInfo.Write(BinaryWriter) -- that is a different serializer used elsewhere with a
        // different order (displayName before id, playfabId before serverAssignedDisplayName) and no
        // position fields. Using it here would corrupt the packet.
        public static void Write(ZPackage pkg)
        {
            pkg.Write(Client.m_name);
            pkg.Write(Client.m_characterID);
            pkg.Write(Client.m_userInfo.m_id.ToString());
            pkg.Write(Client.m_userInfo.m_displayName);
            pkg.Write(Client.m_userInfo.m_serverAssignedDisplayName);
            pkg.Write(Client.m_userInfo.m_playfabId);
            // Server position is never public.
            pkg.Write(false);
        }
    }
}
