using System;
using HarmonyLib;
using UnityEngine;

namespace EilifCompanion
{
    /// <summary>
    /// EARS: capture in-game "/oath &lt;text&gt;" chat — and mirrorable shout chat — on the
    /// dedicated server.
    ///
    /// Hooked directly onto Chat.RPC_ChatMessage — proven to execute on this very server for
    /// shouted messages (observed in LogOutput.log with this exact signature via a ValheimPlus
    /// stack trace: Chat.RPC_ChatMessage(System.Int64 sender, UnityEngine.Vector3 position,
    /// System.Int32 type, UserInfo userInfo, System.String text)). Harmony hands us the parsed
    /// arguments; no ZPackage parsing, no method-hash matching.
    ///
    /// NOTE: normal "say" chat does not traverse ChatMessage and unknown /commands are swallowed
    /// client-side — oaths must be SHOUTED: `/s /oath I swear...` (documented on the Oath page).
    /// </summary>
    [HarmonyPatch(typeof(Chat), "RPC_ChatMessage")]
    internal static class OathCapture
    {
        private const string OathPrefix = "/oath ";

        private static void Postfix(long sender, Vector3 position, int type, UserInfo userInfo, string text)
        {
            try
            {
                if (type == (int)Talker.Type.Ping) return; // pings carry no chat text
                string t = (text ?? "").Trim();
                if (t.Length == 0) return;

                if (!t.StartsWith(OathPrefix, StringComparison.OrdinalIgnoreCase))
                {
                    // Not an oath. Any other SHOUTED, non-command text is mirrorable chat:
                    // emit it with its ORIGINAL casing (the console echo the poller also
                    // sees is display-uppercased, so this line is the pretty source; the
                    // poller dedupes the echo twin). Slash-commands (/pin etc.) are never
                    // chat.
                    if (type != (int)Talker.Type.Shout) return;
                    if (t.StartsWith("/", StringComparison.Ordinal)) return;
                    EilifCompanionPlugin.Log.LogInfo($"[EILIF_CHAT] {userInfo.Name ?? ""} | {t}");
                    return;
                }

                if (t.Length <= OathPrefix.Length) return; // "/oath" with no text
                string oath = t.Substring(OathPrefix.Length).Trim();
                if (oath.Length == 0) return;

                // The one line our SFTP log poller tails from LogOutput.log.
                EilifCompanionPlugin.Log.LogInfo($"[EILIF_OATH] {userInfo.Name ?? ""} | {oath}");
            }
            catch (Exception ex)
            {
                // Never let a hiccup interfere with normal chat handling.
                EilifCompanionPlugin.Log?.LogWarning($"[Eilif] oath capture error: {ex.Message}");
            }
        }
    }
}
