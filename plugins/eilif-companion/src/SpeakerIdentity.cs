using System;
using System.Text;

namespace EilifCompanion
{
    /// <summary>
    /// WHO REALLY SPOKE (v0.3.2, audit security-3 part 1).
    ///
    /// ── THE HOLE ────────────────────────────────────────────────────────────────────────────
    ///
    /// Every chat-driven capture in this plugin — <c>[EILIF_OATH]</c>, <c>[EILIF_CHAT]</c>,
    /// <c>[EILIF_PIN]</c> — used to name the speaker from <c>UserInfo.Name</c>, the display name
    /// carried INSIDE the chat packet. The decompile (assembly_valheim 0.221.12) shows where that
    /// comes from:
    ///
    ///     private void RPC_ChatMessage(long sender, Vector3 position, int type, UserInfo userInfo, string text)
    ///         =&gt; OnNewChatMessage(null, sender, position, (Talker.Type)type, userInfo, text);
    ///
    /// …i.e. <c>userInfo</c> is forwarded from the client's own packet, unchecked. Nothing in the
    /// server validates it against the account that sent it. A one-line client mod that sends a
    /// ChatMessage RPC with <c>userInfo.Name = "Alice"</c> could therefore sign Alice's name to an
    /// oath, mirror words into #server as Alice, and move Alice's map pins — without ever creating
    /// a character called Alice.
    ///
    /// ── THE FIX ─────────────────────────────────────────────────────────────────────────────
    ///
    /// The server keeps its OWN name for every connected peer: <c>ZNetPeer.m_playerName</c>, set
    /// once during the handshake in <c>ZNet.RPC_PeerInfo</c> and thereafter the name the server
    /// itself uses for kicks, the permitted-list check and the player list. The routed-RPC
    /// envelope hands the hook the sender's peer uid, and <c>ZNet.GetPeer(long uid)</c> is public,
    /// so the real name is one lookup away:
    ///
    ///     ZNet.instance.GetPeer(senderID)?.m_playerName
    ///
    /// Every marker line is now emitted under THAT name. The claimed name is never printed as the
    /// speaker — only inside an <c>[EILIF_IDENT] mismatch</c> line, where it is evidence, not
    /// identity. A sender uid with no peer record (a forged or stale uid; nothing legitimate on a
    /// dedicated server) is refused outright rather than falling back to the claim, because
    /// falling back is exactly the hole.
    ///
    /// ── WHAT THIS DOES NOT FIX ──────────────────────────────────────────────────────────────
    ///
    /// Two routes survive by construction and are the poller's / dashboard's problem, not this
    /// file's (audit security-3 parts 2 and 3):
    ///   • Valheim allows DUPLICATE character names. Someone who rolls a second character
    ///     literally named "Alice" gets <c>m_playerName == "Alice"</c> honestly, and no
    ///     server-side name check can tell the two apart — only a SteamID/peer-identity binding
    ///     downstream can.
    ///   • <c>m_senderPeerID</c> is itself written by the sending client
    ///     (<c>ZRoutedRpc.InvokeRoutedRPC</c> stamps <c>m_senderPeerID = m_id</c>) and the server
    ///     does not verify it against the socket the packet arrived on. A deeply modified client
    ///     could claim another peer's uid — but it then inherits that peer's REAL name from the
    ///     server's own record, so the forgery only works if it names a peer who is genuinely
    ///     connected, and the impersonation is no longer free-text.
    ///
    /// ── LOG SAFETY ──────────────────────────────────────────────────────────────────────────
    ///
    /// <see cref="Safe"/> also exists because these strings end up in <c>LogOutput.log</c>, which
    /// the SFTP poller parses LINE BY LINE. A name or a shout containing a carriage return could
    /// otherwise emit a second, unprefixed line of the attacker's choosing — including a perfect
    /// imitation of the server's console echo (<c>Console: &lt;color=orange&gt;Victim&lt;/color&gt;: …</c>),
    /// which the poller trusts as a mod-free oath. Control characters are flattened to spaces and
    /// both names and text are length-capped before anything is logged.
    ///
    /// A carriage return is not even required for that echo imitation, because the poller's guard
    /// is a substring test rather than an anchored one — so <see cref="Safe"/> also defangs
    /// rich-text tag openers, and <see cref="SafeName"/> additionally flattens the " | " field
    /// separator that a crafted <c>m_playerName</c> could otherwise use to shift a marker line's
    /// fields and file it under a shorter, borrowed name. EVERY field this plugin logs (speaker
    /// name, chat text, oath text, pin place name, position name, and the claimed name printed as
    /// evidence on an <c>[EILIF_IDENT]</c> line) goes through one of the two. See the remarks on
    /// each.
    /// </summary>
    internal static class SpeakerIdentity
    {
        /// Marker for the identity audit lines. Deliberately NOT one of the markers the poller
        /// parses ([EILIF_OATH]/[EILIF_CHAT]/[EILIF_PIN]/[EILIF_POS]) — this is for humans and
        /// for the launch-night grep, and adding it needs no poller change.
        private const string Marker = "[EILIF_IDENT]";

        /// A character name is 15 chars in Valheim's own UI; 64 is generous and still bounded.
        internal const int MaxNameLen = 64;

        /// Well past the poller's own caps (oath 280, chat 300) so nothing real is ever clipped.
        internal const int MaxTextLen = 512;

        /// One [EILIF_IDENT] line per minute, at most. A healthy server prints none of these, so
        /// the throttle never hides anything real — but a modified client can drive Resolve() as
        /// fast as it can send chat packets, and LogOutput.log is what the SFTP poller drags down
        /// every 20s. The first offence is always logged immediately, and the next line to get
        /// through carries the suppressed count, so nothing is silently lost.
        private const double IdentCooldownSeconds = 60d;

        private static DateTime _lastIdentUtc = DateTime.MinValue;
        private static int _identSuppressed;

        /// <summary>
        /// Emit one identity-audit line, rate-limited. The message text (and therefore the
        /// launch-night grep for "[EILIF_IDENT]") is unchanged; only the frequency is bounded.
        /// </summary>
        private static void LogIdent(string message)
        {
            DateTime now = DateTime.UtcNow;
            if (_lastIdentUtc != DateTime.MinValue && (now - _lastIdentUtc).TotalSeconds < IdentCooldownSeconds)
            {
                if (_identSuppressed < int.MaxValue) _identSuppressed++;
                return;
            }
            int suppressed = _identSuppressed;
            _identSuppressed = 0;
            _lastIdentUtc = now;
            EilifCompanionPlugin.Log?.LogWarning(
                suppressed > 0 ? $"{message} (+{suppressed} suppressed in the last minute)" : message);
        }

        /// <summary>
        /// The server's own name for the peer that sent this routed RPC, or null when that uid
        /// has no peer record (never legitimate for player chat on a dedicated server).
        /// </summary>
        internal static string PeerName(long uid)
        {
            try
            {
                var znet = ZNet.instance;
                if (znet == null) return null;
                var peer = znet.GetPeer(uid); // public ZNetPeer GetPeer(long uid) — verified by decompile
                if (peer == null) return null;
                string name = peer.m_playerName;
                return string.IsNullOrEmpty(name) ? null : name;
            }
            catch
            {
                // A reflection/API change must never take chat handling with it.
                return null;
            }
        }

        /// <summary>
        /// The name a chat-driven marker line may be emitted under, or null when the line must be
        /// dropped. Logs an <c>[EILIF_IDENT]</c> line on any mismatch or unknown sender.
        /// </summary>
        /// <param name="uid">The routed-RPC sender's peer uid (the hook's senderID argument).</param>
        /// <param name="claimedName">The client-supplied <c>UserInfo.Name</c> from the packet.</param>
        /// <param name="what">What is being dropped, for the log line ("oath", "chat", "pin").</param>
        internal static string Resolve(long uid, string claimedName, string what)
        {
            string claimed = SafeName(claimedName);
            string peerName = PeerName(uid);

            if (peerName == null)
            {
                LogIdent($"{Marker} unknown sender uid={uid} claimed={claimed} - {what} dropped");
                return null;
            }

            string real = SafeName(peerName);
            if (!string.Equals(peerName, claimedName ?? "", StringComparison.Ordinal))
            {
                // The exact shape asked for by the audit fix, so it greps cleanly on launch night.
                LogIdent($"{Marker} mismatch peer={real} claimed={claimed} uid={uid}");
            }
            return real;
        }

        /// <summary>
        /// Log-safe TEXT: control characters (CR/LF above all) flattened to spaces, rich-text tag
        /// openers defanged, length capped. Never returns null.
        ///
        /// The tag opener is the load-bearing part, and it is not cosmetic. The poller's
        /// console-echo guard (services/log-poller/src/parser.js, RE.consoleShout) is an
        /// UNANCHORED substring test that runs BEFORE every marker regex, so ANY log line merely
        /// CONTAINING <c>Console: &lt;color=orange&gt;NAME&lt;/color&gt;: &lt;color=…&gt;TEXT&lt;/color&gt;</c>
        /// is read as a mod-free console echo and filed under NAME. No newline is needed for that:
        /// a player who simply SHOUTS that literal string gets it reproduced verbatim inside our
        /// own raw-case <c>[EILIF_CHAT]</c> line, and the oath inside it lands on somebody else's
        /// name. (The genuine console echo cannot be abused the same way only because Valheim
        /// display-uppercases shouts, which breaks the lowercase <c>&lt;color=orange&gt;</c> match —
        /// an accident that our raw-case line removes.) The same shape can also arrive through a
        /// pin's place name and through a crafted <c>ZNetPeer.m_playerName</c>.
        ///
        /// Every rich-text tag the guard needs begins <c>&lt;</c> + a letter or <c>&lt;/</c>, so only
        /// those openers are flattened. <c>&lt;3</c>, <c>-&gt;</c>, <c>5 &gt; 3</c> and <c>&gt;_&lt;</c>
        /// pass through untouched — which matters, because the poller suppresses the console-echo
        /// twin of a shout by comparing name + UPPERCASED text, so rewriting ordinary punctuation
        /// here would double-post those shouts to Discord.
        ///
        /// Anchoring RE.consoleShout to the Unity Log prefix would close the same hole at the
        /// consumer and is worth doing as well (a log-poller change, not this file's).
        /// </summary>
        internal static string Safe(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            int take = s.Length < max ? s.Length : max;
            var sb = new StringBuilder(take);
            for (int i = 0; i < take; i++)
            {
                char c = s[i];
                if (c < ' ' || c == '\u007f') sb.Append(' ');
                else if (c == '<' && i + 1 < s.Length && IsTagStart(s[i + 1])) sb.Append('(');
                else sb.Append(c);
            }
            return sb.ToString();
        }

        /// True for the characters that can follow '&lt;' in a Unity rich-text tag.
        private static bool IsTagStart(char c)
        {
            return c == '/' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        }

        /// <summary>
        /// Log-safe NAME: <see cref="Safe"/> plus the field separator.
        ///
        /// Every marker line this plugin writes is " | "-delimited and the poller splits
        /// <c>[EILIF_OATH]</c>/<c>[EILIF_CHAT]</c> on the FIRST separator, so a name carrying one
        /// shifts the boundary and files the line under a shorter, borrowed name: a peer called
        /// <c>"Bren | hello"</c> emits <c>[EILIF_CHAT] Bren | hello | (their words)</c>, which the
        /// poller reads as Bren speaking. <c>[EILIF_PIN]</c> is worse — a name of
        /// <c>"Bren | poi | X | 1.0 | 2.0"</c> plants a pin on Bren. Both were verified by driving
        /// the real parser. And a name is exactly the wrong place to trust: <c>m_playerName</c> is
        /// assigned in <c>ZNet.RPC_PeerInfo</c> straight from the client's handshake packet, with
        /// no length or character check, so it is attacker-written on a modified client.
        ///
        /// Valheim's own character creation cannot produce a name containing '|', so nothing
        /// legitimate is altered. Text keeps its pipes: the poller splits on the first separator
        /// only, so they stay inside the text where they belong.
        /// </summary>
        internal static string SafeName(string s)
        {
            return Safe(s, MaxNameLen).Replace('|', '/');
        }
    }
}
