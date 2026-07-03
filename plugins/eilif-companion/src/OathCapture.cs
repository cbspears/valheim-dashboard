using System;
using HarmonyLib;
using UnityEngine;

namespace EilifCompanion
{
    /// <summary>
    /// EARS: capture in-game "/oath &lt;text&gt;" chat commands on the dedicated server.
    ///
    /// Pattern mirrored verbatim from h0tw1r3/valheim-webmap (MIT): a Postfix on
    /// ZRoutedRpc.HandleRoutedRPC. On a dedicated server EVERY routed RPC passes through
    /// this method, so we can observe the routed "ChatMessage" payload with zero client installs.
    ///
    /// ChatMessage payload layout (verified against assembly_valheim 0.221.x
    /// Chat.RPC_ChatMessage(long sender, Vector3 position, int type, UserInfo userInfo, string text)):
    ///   Vector3 position
    ///   int     type        (Talker.Type: Whisper=0, Normal=1, Shout=2, Ping=3)
    ///   UserInfo userInfo    (userInfo.Name == exact character name)
    ///   string  text
    /// The leading 'sender' long is the routed sender id and is NOT in the ZPackage body.
    ///
    /// This is a Postfix, so the message is already routed/re-broadcast to other players by the
    /// time we see it: we do NOT suppress the /oath line (suppression would require a Prefix that
    /// drops the whole routed RPC, which is invasive and risky). /oath messages appear in chat as
    /// normal — acceptable per spec; noted in README.
    /// </summary>
    // HandleRoutedRPC(RoutedRPCData) is private in current assembly_valheim, so target it by
    // string name (Harmony resolves non-public methods fine); nameof() cannot reference it.
    [HarmonyPatch(typeof(ZRoutedRpc), "HandleRoutedRPC", new Type[] { typeof(ZRoutedRpc.RoutedRPCData) })]
    internal static class OathCapture
    {
        private const string OathPrefix = "/oath ";

        // Cached stable hash for the "ChatMessage" routed method.
        private static int _chatMessageHash;

        /// <summary>
        /// Canonical Valheim string stable-hash (the algorithm behind the game's
        /// String.GetStableHashCode()). Reimplemented here because that extension is not exposed
        /// as a public/accessible method in current assembly_valheim; this stays correct as long
        /// as Iron Gate keeps the same hashing (unchanged for many years). data.m_methodHash is
        /// produced by this exact algorithm, so our "ChatMessage" hash matches at runtime.
        /// </summary>
        private static int GetStableHashCode(string str)
        {
            int num1 = 5381;
            int num2 = num1;
            for (int i = 0; i < str.Length && str[i] != '\0'; i += 2)
            {
                num1 = ((num1 << 5) + num1) ^ str[i];
                if (i == str.Length - 1 || str[i + 1] == '\0') break;
                num2 = ((num2 << 5) + num2) ^ str[i + 1];
            }
            return num1 + num2 * 1566083941;
        }

        private static void Postfix(ref ZRoutedRpc.RoutedRPCData data)
        {
            try
            {
                if (data == null) return;
                if (_chatMessageHash == 0) _chatMessageHash = GetStableHashCode("ChatMessage");
                if (data.m_methodHash != _chatMessageHash) return;
                if (data.m_parameters == null) return;

                // Read a COPY of the payload so we never disturb the original package read pointer
                // (mirrors webmap: new ZPackage(data.m_parameters.GetArray())).
                var package = new ZPackage(data.m_parameters.GetArray());
                Vector3 pos = package.ReadVector3();
                int messageType = package.ReadInt();
                var userInfo = new UserInfo();
                userInfo.Deserialize(ref package);

                if (messageType == (int)Talker.Type.Ping) return; // pings carry no chat text
                string text = package.ReadString() ?? "";
                text = text.Trim();

                if (text.Length < OathPrefix.Length) return;
                if (!text.Substring(0, OathPrefix.Length).Equals(OathPrefix, StringComparison.OrdinalIgnoreCase))
                    return;

                string oath = text.Substring(OathPrefix.Length).Trim();
                if (oath.Length == 0) return; // empty oath after the prefix -> ignore

                string charName = userInfo.Name ?? "";

                // The one line our SFTP log poller tails from LogOutput.log.
                EilifCompanionPlugin.Log.LogInfo($"[EILIF_OATH] {charName} | {oath}");
            }
            catch (Exception ex)
            {
                // Never let a parse hiccup interfere with normal chat routing.
                EilifCompanionPlugin.Log?.LogWarning($"[Eilif] oath capture error: {ex.Message}");
            }
        }
    }
}
