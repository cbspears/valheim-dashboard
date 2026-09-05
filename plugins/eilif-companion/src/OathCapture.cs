using System;
using HarmonyLib;
using UnityEngine;

namespace EilifCompanion
{
    /// <summary>
    /// EARS: capture in-game "/oath &lt;text&gt;" chat — and mirrorable shout chat — on the
    /// dedicated server.
    ///
    /// ── WHY THIS MOVED IN v0.3.1 (audit voice-6) ────────────────────────────────────────────
    ///
    /// Until 0.3.0 this was a Postfix on <c>Chat.RPC_ChatMessage</c>. That hook is DEAD on this
    /// server and has been for months: ValheimPlus's own [Chat] patch throws an NRE earlier in the
    /// same chain, so the original never completes and no postfix of ours ever runs. The evidence
    /// is unambiguous — the 09-01 boot log contains ZERO <c>[EILIF_OATH]</c> lines, while the
    /// poller's journal shows all ten recorded oaths arriving through the *console echo* fallback
    /// instead. The echo is the server printing a SHOUT, and Valheim display-uppercases shouts, so
    /// every signature on the Oath wall is stored bellowed: "I WILL NOT RUN, JUMP OR CLIMB!".
    ///
    /// The fix is to hook one level DOWN. The decompile (assembly_valheim 0.221.12) shows
    /// <c>RPC_ChatMessage</c> doing exactly one thing:
    ///
    ///     private void RPC_ChatMessage(long sender, Vector3 position, int type, UserInfo userInfo, string text)
    ///         => OnNewChatMessage(null, sender, position, (Talker.Type)type, userInfo, text);
    ///
    /// …so <c>Chat.OnNewChatMessage</c> carries every argument the old hook had, and a Prefix on it
    /// is PROVEN to execute on this exact server: it is the hook the <c>/pin</c> capture has been
    /// running on all along (EilifCompanionPlugin.cs, Patch_OnNewChatMessage_Pin), and pins land.
    ///
    /// AND IT SIDESTEPS THE V+ NRE ENTIRELY, WITHOUT TURNING V+ OFF. ValheimPlus's <c>[Chat]</c>
    /// section STAYS ENABLED on this server — it is what makes <c>/s</c> shouts carry server-wide
    /// (shoutDistance + serverSyncsConfig), which is exactly the behaviour the oath and chat
    /// features are built on top of. Its patch throws inside <c>Chat.AddInworldText</c>, and
    /// <c>AddInworldText</c> is called from the BODY of <c>OnNewChatMessage</c> — so a PREFIX on
    /// <c>OnNewChatMessage</c> has already run and already logged its marker line by the time the
    /// NRE happens. The exception still kills the rest of that call — which is exactly why the old
    /// postfix, sitting one frame further out, never ran and never will — but it can no longer cost
    /// us the capture. Nothing about V+'s configuration has to change for this to work.
    ///
    /// The dead RPC postfix is deleted rather than left in place, and the <see cref="RecentlyLogged"/>
    /// guard below covers the case where something ever revives that path anyway.
    ///
    /// ── THE OUTPUT CONTRACT (do not reformat) ───────────────────────────────────────────────
    ///
    /// The SFTP log poller tails LogOutput.log and parses these two marker lines with fixed
    /// regexes (services/log-poller/src/parser.js `oath` / `chat`, which split on the FIRST " | "):
    ///
    ///     [EILIF_OATH] &lt;name&gt; | &lt;text&gt;
    ///     [EILIF_CHAT] &lt;name&gt; | &lt;text&gt;
    ///
    /// Both are byte-identical to what 0.3.0 emitted. Only the hook they are emitted FROM changed,
    /// so nothing downstream needs a matching edit.
    ///
    /// ⚠ THE ECHO TWIN IS ONLY SUPPRESSED FOR CHAT. Every shout ALSO reaches the poller as the
    /// server's console echo, and poller.js's batch dedupe (`ev.type === 'chat' &amp;&amp; source ===
    /// 'echo'`) drops that twin only for chat lines — an oath's echo twin is dispatched too, and
    /// the webhook's oath handler is delete-then-insert, so whichever arrives LAST wins. The echo
    /// line is written by the game after this Prefix returns, i.e. second. Until the poller learns
    /// to prefer the plugin's oath the same way it prefers its chat, the raw-case win claimed by
    /// 0.3.1 — and the peer-name win added in 0.3.2 below — do not reach the oath wall. That fix
    /// belongs in services/log-poller, not here; this comment exists so the next reader does not
    /// assume the plugin half is the whole story.
    ///
    /// ── WHOSE NAME GOES ON THE LINE (v0.3.2, audit security-3) ──────────────────────────────
    ///
    /// &lt;name&gt; is now the SERVER's own name for the sending peer
    /// (<c>ZNet.instance.GetPeer(senderID).m_playerName</c>), not the <c>UserInfo.Name</c> the
    /// client put in the packet. The two are identical for every honest client; when they differ
    /// the peer name wins and an <c>[EILIF_IDENT] mismatch …</c> warning is logged. See
    /// <see cref="SpeakerIdentity"/> for why the packet's name could never be trusted, and for
    /// the two impersonation routes this does NOT close. The line FORMAT is unchanged, so again
    /// nothing downstream needs an edit.
    ///
    /// The name on the line is only half of it: the poller reads a log line, so the TEXT is an
    /// identity surface too. A shout of the literal string
    /// <c>Console: &lt;color=orange&gt;Victim&lt;/color&gt;: &lt;color=x&gt;/oath …&lt;/color&gt;</c> used to be
    /// reproduced verbatim on this raw-case line and read back by the poller as a genuine console
    /// echo from Victim — no modified client required. <see cref="SpeakerIdentity.Safe"/> defangs
    /// the tag openers that shape needs, and <see cref="SpeakerIdentity.SafeName"/> flattens the
    /// " | " a crafted peer name could use to shift this line's own fields. Both were verified by
    /// driving the real parser (services/log-poller/src/parser.js) with the crafted lines.
    ///
    /// NOTE: normal "say" chat does not traverse ChatMessage and unknown /commands are swallowed
    /// client-side — oaths must be SHOUTED: `/s /oath I swear...` (documented on the Oath page).
    /// </summary>
    [HarmonyPatch(typeof(Chat), "OnNewChatMessage")]
    internal static class OathCapture
    {
        private const string OathPrefix = "/oath ";

        // Belt-and-braces against ONE shout producing TWO marker lines. Nothing reaches this method
        // twice for a single message today — RPC_ChatMessage's only statement is the call to
        // OnNewChatMessage, and the postfix that used to sit on it is gone — but if anything ever
        // revives that path (a re-added postfix, another mod re-invoking OnNewChatMessage), a
        // duplicate would put the same signature on the oath wall twice or mirror the same sentence
        // into #server twice. Same sender + same text + same marker inside a few seconds is a
        // duplicate, not a second thought: a viking who genuinely repeats themselves that fast is
        // hitting Enter twice.
        //
        // Deliberately keyed by MARKER as well, so an oath and a chat line can never suppress each
        // other, and deliberately a one-slot memory: it is guarding against an immediate twin, not
        // policing repetition, and it must not accumulate state on a server that runs for weeks.
        private const double DedupeSeconds = 5.0;
        private static string _lastKey;
        private static DateTime _lastAtUtc = DateTime.MinValue;

        private static bool RecentlyLogged(string marker, string who, string text)
        {
            // NUL separators: neither can occur in a character name or a shout.
            string key = marker + "\u0000" + who + "\u0000" + text;
            DateTime now = DateTime.UtcNow;
            if (key == _lastKey && (now - _lastAtUtc).TotalSeconds < DedupeSeconds) return true;
            _lastKey = key;
            _lastAtUtc = now;
            return false;
        }

        // PREFIX, mirroring the /pin capture: it observes and returns, never altering an argument
        // and never skipping the original, so chat handling is untouched whatever happens here.
        private static void Prefix(GameObject go, long senderID, Vector3 pos, Talker.Type type, UserInfo sender, string text)
        {
            try
            {
                if (type == Talker.Type.Ping) return; // pings carry no chat text
                string t = SpeakerIdentity.Safe(text, SpeakerIdentity.MaxTextLen).Trim();
                if (t.Length == 0) return;

                // v0.3.2 — the speaker is resolved LAST, and only for a line we are actually
                // about to emit. Resolving earlier would put an [EILIF_IDENT] line in the log for
                // every ping, every whisper and every `/pin` (which the pin patch resolves for
                // itself), so one impersonated pin would print the warning twice.
                string claimed = sender != null ? sender.Name : null;

                if (!t.StartsWith(OathPrefix, StringComparison.OrdinalIgnoreCase))
                {
                    // Not an oath. Any other SHOUTED, non-command text is mirrorable chat:
                    // emit it with its ORIGINAL casing (the console echo the poller also
                    // sees is display-uppercased, so this line is the pretty source; the
                    // poller dedupes the echo twin). Slash-commands (/pin etc.) are never
                    // chat.
                    if (type != Talker.Type.Shout) return;
                    if (t.StartsWith("/", StringComparison.Ordinal)) return;
                    string speaker = SpeakerIdentity.Resolve(senderID, claimed, "chat");
                    if (speaker == null) return;
                    if (RecentlyLogged("chat", speaker, t)) return;
                    EilifCompanionPlugin.Log.LogInfo($"[EILIF_CHAT] {speaker} | {t}");
                    return;
                }

                if (t.Length <= OathPrefix.Length) return; // "/oath" with no text
                string oath = t.Substring(OathPrefix.Length).Trim();
                if (oath.Length == 0) return;

                // v0.3.2 — the SERVER's name for the sending peer, never the display name carried
                // in the packet (audit security-3). UserInfo travels inside the client's own
                // ChatMessage RPC and nothing validates it, so an oath signed from userInfo.Name
                // could carry anyone's name; a sender uid with no peer record is dropped rather
                // than trusted. See SpeakerIdentity for the decompiled evidence and the residuals.
                string who = SpeakerIdentity.Resolve(senderID, claimed, "oath");
                if (who == null) return;
                if (RecentlyLogged("oath", who, oath)) return;

                // The one line our SFTP log poller tails from LogOutput.log.
                EilifCompanionPlugin.Log.LogInfo($"[EILIF_OATH] {who} | {oath}");
            }
            catch (Exception ex)
            {
                // Never let a hiccup interfere with normal chat handling.
                EilifCompanionPlugin.Log?.LogWarning($"[Eilif] oath capture error: {ex.Message}");
            }
        }
    }
}
