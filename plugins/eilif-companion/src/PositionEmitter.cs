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

                    string name = peer.m_playerName ?? "";
                    if (name.Length == 0) continue;

                    // Prefer the authoritative character ZDO position; fall back to the peer's
                    // last replicated reference position if the ZDO isn't resolvable here.
                    Vector3 pos = peer.m_refPos;
                    var zdo = zdoMan?.GetZDO(peer.m_characterID);
                    if (zdo != null) pos = zdo.GetPosition();

                    string biome = "None";
                    try
                    {
                        if (gen != null) biome = gen.GetBiome(pos.x, pos.z).ToString();
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
