using System;
using System.Globalization;
using UnityEngine;

namespace EilifCompanion
{
    /// <summary>
    /// POSITION: periodically emit one tagged log line per connected player so the SFTP
    /// log poller can plot a live "where is everyone" layer on the dashboard map.
    ///
    /// Every <see cref="EmitIntervalSeconds"/> seconds, IF ≥1 player is connected, we log
    /// (Info level) one line per fully-in-world peer:
    ///
    ///     [EILIF_POS] &lt;name&gt; | &lt;x&gt; | &lt;z&gt; | &lt;biome&gt;
    ///
    /// - name  = ZNetPeer.m_playerName (the peer's character name).
    /// - x / z = world coordinates, formatted F1 with InvariantCulture (NEVER locale commas).
    /// - biome = Heightmap.Biome word at that position via WorldGenerator on the server
    ///           (e.g. "Meadows"); "None" if the world generator isn't ready / lookup throws.
    ///
    /// Runs on the main thread (driven from the plugin's Update pump), so ZDO/WorldGenerator
    /// access is safe. Dedicated-server hardened: every dereference is null-guarded and each
    /// peer is wrapped in its own try/catch so one bad peer never kills the loop.
    /// </summary>
    internal static class PositionEmitter
    {
        // Fixed contract: the poller expects a 60s cadence.
        internal const float EmitIntervalSeconds = 60f;

        private static float _timer;

        // Called every frame from EilifCompanionPlugin.Update (main thread).
        internal static void Tick(float unscaledDelta)
        {
            _timer += unscaledDelta;
            if (_timer < EmitIntervalSeconds) return;
            _timer = 0f;

            try { Emit(); }
            catch (Exception ex)
            {
                EilifCompanionPlugin.Log?.LogWarning($"[Eilif] position emit failed: {ex.Message}");
            }
        }

        /// <summary>
        /// The biome word, guaranteed to survive the poller's field parser.
        ///
        /// <c>Heightmap.Biome</c> is a <c>[Flags]</c> enum (verified against assembly_valheim
        /// 0.221.12: None=0, Meadows=1 … Mistlands=0x200, All=0x37F). Today
        /// <c>WorldGenerator.GetBiome</c> always hands back a single bit, so ToString gives one bare
        /// word — but a value carrying two bits, or an unnamed one, formats as "Meadows, Swamp" or
        /// "384", and the poller's regex ends
        /// <c>\|\s*(\S+)\s*$</c> (services/log-poller/src/parser.js, RE.pos). A space in the last
        /// field does not degrade the biome, it fails the WHOLE match, and the player's position is
        /// dropped with no error anywhere. 1.0 adds Deep North content, so this is exactly the kind
        /// of thing worth not betting on: whitespace is stripped, an empty result becomes "None".
        /// </summary>
        private static string BiomeWord(Heightmap.Biome biome)
        {
            string s = biome.ToString();
            if (string.IsNullOrEmpty(s)) return "None";
            var sb = new System.Text.StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == ' ' || c == '\t') continue;   // "Meadows, Swamp" -> "Meadows,Swamp"
                if (c < ' ' || c == '\u007f') continue;
                if (c == '|') { sb.Append('/'); continue; } // never shift this line's own fields
                sb.Append(c);
            }
            return sb.Length == 0 ? "None" : sb.ToString();
        }

        private static void Emit()
        {
            var znet = ZNet.instance;
            if (znet == null) return;

            var peers = znet.GetPeers();
            if (peers == null || peers.Count == 0) return;

            var zdoMan = ZDOMan.instance;
            var gen = WorldGenerator.instance;

            foreach (var peer in peers)
            {
                if (peer == null) continue;
                try
                {
                    // Skip peers not fully in-world: a zero character id means they've
                    // connected but their player ZDO hasn't spawned yet (no real position).
                    if (peer.m_characterID == ZDOID.None) continue;

                    // Already the server's own peer record (never a client-supplied chat name), so
                    // there is nothing to cross-check here — but m_playerName still ARRIVES from
                    // the client during the handshake (ZNet.RPC_PeerInfo assigns it straight from
                    // the packet), so it is flattened, de-piped and capped before it reaches a log
                    // line the poller parses field by field (v0.3.2, SpeakerIdentity.SafeName).
                    string name = SpeakerIdentity.SafeName(peer.m_playerName);
                    if (name.Length == 0) continue;

                    // Prefer the authoritative character ZDO position; fall back to the peer's
                    // last replicated reference position if the ZDO isn't resolvable here.
                    Vector3 pos = peer.m_refPos;
                    var zdo = zdoMan?.GetZDO(peer.m_characterID);
                    if (zdo != null) pos = zdo.GetPosition();

                    // A non-finite coordinate formats as "NaN" or "∞", which the poller's
                    // `(-?[\d.]+)` field cannot match — so the WHOLE line is discarded silently and
                    // this peer simply stops appearing on the map. Skipping the tick is the same
                    // outcome, minus the mystery: there is no honest position to report.
                    if (float.IsNaN(pos.x) || float.IsNaN(pos.z) ||
                        float.IsInfinity(pos.x) || float.IsInfinity(pos.z)) continue;

                    string biome = "None";
                    try
                    {
                        if (gen != null) biome = BiomeWord(gen.GetBiome(pos.x, pos.z));
                    }
                    catch { biome = "None"; } // position is the load-bearing part; never fail on biome

                    string x = pos.x.ToString("F1", CultureInfo.InvariantCulture);
                    string z = pos.z.ToString("F1", CultureInfo.InvariantCulture);

                    EilifCompanionPlugin.Log.LogInfo($"[EILIF_POS] {name} | {x} | {z} | {biome}");
                }
                catch (Exception ex)
                {
                    // One bad peer must never abort the rest of the sweep.
                    EilifCompanionPlugin.Log?.LogWarning($"[Eilif] position emit (peer) failed: {ex.Message}");
                }
            }
        }
    }
}
