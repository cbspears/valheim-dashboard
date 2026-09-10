using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace EilifCompanionClient
{
    /// <summary>
    /// EilifCompanionClient — the RAW PROFILE-STATS reporter (since v0.4.0).
    ///
    /// THE PROBLEM IT SOLVES. The third-party GsValheimStatsClient is blind on
    /// Valheim 1.0: its per-player payload still carries weapons/skills, but its
    /// `stats` map (the "vh_&lt;PlayerStatType&gt;" counters the dashboard's
    /// baseline layer reads) is empty, and its top-level kills/deaths read 0. The
    /// dashboard's current stopgap derives kills from the weapon breakdown and
    /// deaths from our own `events` rows, and cannot speak for builds, crafts or
    /// distance at all (lib/gs-client.ts "VALHEIM 1.0 STOPGAP", lib/gs-baseline.ts).
    ///
    /// THE FIX. Valheim keeps the authoritative lifetime counters on the local
    /// PlayerProfile. We read them straight off <c>Game.instance.GetPlayerProfile()</c>
    /// with the game's own <c>GetStat(PlayerStatType)</c> accessor and POST them to
    /// the dashboard ingest in the EXACT shape GsValheimStatsClient uses
    /// (<c>source:'client'</c>, a <c>players[]</c> array whose only entry is the
    /// reporter, carrying a <c>stats</c> map of "vh_&lt;StatType&gt;" plus
    /// entry-level <c>kills</c>/<c>deaths</c>). The ingest route and
    /// lib/gs-client + lib/gs-baseline parse it with ZERO changes: parseSelfSnapshot
    /// finds our entry (name === reporter, carries stats → "cumulative" + "ownEntry"),
    /// reads self.kills/self.deaths and stats.vh_Builds/vh_Crafts, and
    /// parseSelfDistances reads the vh_Distance* subset. Columns we omit become
    /// baseline HOLES, so the blind GS client's weapons/skills/boss breakdowns still
    /// fill their own columns alongside ours — the two producers compose.
    ///
    /// DECOMPILE-VERIFIED against <c>libs/assembly_valheim.dll</c> (1.0 build
    /// 25185596, ilspycmd), mirrored in scratchpad decompile PlayerProfile.cs:
    ///   • <c>Game</c>: <c>public PlayerProfile GetPlayerProfile()</c>.
    ///   • <c>PlayerProfile</c>: <c>public float GetStat(PlayerStatType stat)</c>
    ///     (reads the RawStats bucket <c>m_playerStats[0]</c> unless achievements
    ///     are enabled; the PlayerStats ctor pre-seeds every enum index 0..204, so
    ///     the dictionary read never throws for any member we touch).
    ///   • <c>PlayerStatType</c> members used — Deaths, EnemyKills, Builds, Crafts,
    ///     DistanceTraveled, DistanceWalk, DistanceRun, DistanceSail, DistanceAir —
    ///     all present in the 1.0 enum. `Crafts` (not `CraftsOrUpgrades`) maps to
    ///     `vh_Crafts` so a returning pre-1.0 baseline is differenced like against
    ///     like (the .fch "vh_Crafts" counter was the Crafts total).
    ///
    /// ⚠️ NO System.ValueTuple ANYWHERE (target net462; the BepInEx/Unity Mono
    /// runtime ships no ValueTuple reference and a tuple on a load path fails the
    /// plugin SILENTLY — see BUILD.md). Every helper here uses ordinary returns.
    ///
    /// SAFETY. Gameplay comes first: the whole read+post is wrapped so no exception
    /// can escape, the POST is fire-and-forget off the main thread (shared plumbing
    /// with the cartography + death posts), and a stat we cannot read is simply
    /// omitted — never posted as an invented zero (the baseline layer treats an
    /// absent key as a HOLE and a present 0 as a real zero-point, so a fabricated 0
    /// would wrongly seed a zero-point the next snapshot is differenced against).
    /// </summary>
    internal static class EilifStatsReporter
    {
        // Config toggle [Stats] Enabled, mirrored here in Awake (same pattern as
        // IngestUrl/IngestToken) so the post path never touches a ConfigEntry.
        internal static bool Enabled = true;

        // vh_<key> -> the profile counter it carries. DistanceTraveled and friends
        // are metres; Builds/Crafts are counts. All are rounded to whole numbers
        // (the parser does Math.round anyway; fractional metres are noise).
        private struct StatKey
        {
            public readonly string VhKey;
            public readonly PlayerStatType Type;
            public StatKey(string vhKey, PlayerStatType type) { VhKey = vhKey; Type = type; }
        }

        private static readonly StatKey[] StatMap =
        {
            new StatKey("vh_Builds", PlayerStatType.Builds),
            new StatKey("vh_Crafts", PlayerStatType.Crafts),
            new StatKey("vh_DistanceTraveled", PlayerStatType.DistanceTraveled),
            new StatKey("vh_DistanceWalk", PlayerStatType.DistanceWalk),
            new StatKey("vh_DistanceRun", PlayerStatType.DistanceRun),
            new StatKey("vh_DistanceSail", PlayerStatType.DistanceSail),
            new StatKey("vh_DistanceAir", PlayerStatType.DistanceAir),
        };

        /// <summary>
        /// Read the local profile and POST one self-snapshot. Silent no-op unless
        /// enabled AND the local player is connected to a remote server (the same
        /// single gate every other post in this plugin uses).
        /// </summary>
        internal static void Post(string reason)
        {
            try
            {
                if (!Enabled) return;
                if (!EilifMapTrackerPlugin.IsOnServer()) return;

                var game = Game.instance;
                var znet = ZNet.instance;
                var player = Player.m_localPlayer;
                if (game == null || znet == null || player == null) return;

                PlayerProfile profile = game.GetPlayerProfile();
                if (profile == null) return;

                string reporter = player.GetPlayerName();
                if (string.IsNullOrEmpty(reporter)) return;
                string world = znet.GetWorldName() ?? "";

                int counters = 0;

                // Entry-level kills/deaths — parseSelfSnapshot reads self.kills /
                // self.deaths, NOT a vh_ key. EnemyKills is the total-kills counter
                // the dashboard's kill board + the "killsSource:'client'" path want.
                // 0.4.3: kills and deaths are NO LONGER posted. The dashboard takes kills
                // from the per-world weapon breakdown and deaths from its own death events;
                // a lifetime profile counter next to those made the ingest flip its
                // zero-point every five minutes on 2026-09-10. Builds, crafts and distance
                // are what this reporter is for.

                // stats:{ "vh_...": n } — only keys we actually read.
                var statsFrag = new StringBuilder();
                for (int i = 0; i < StatMap.Length; i++)
                {
                    long v;
                    if (!TryReadStat(profile, StatMap[i].Type, out v)) continue;
                    if (statsFrag.Length > 0) statsFrag.Append(',');
                    statsFrag.Append(EilifMapTrackerPlugin.JsonStr(StatMap[i].VhKey)).Append(':')
                             .Append(v.ToString(CultureInfo.InvariantCulture));
                    counters++;
                }

                // Build the reporter's single players[] entry.
                var entry = new StringBuilder();
                entry.Append("{\"name\":").Append(EilifMapTrackerPlugin.JsonStr(reporter));
                entry.Append(",\"stats\":{").Append(statsFrag).Append("}}");

                if (counters == 0) return; // nothing usable to report

                string json =
                    "{\"schemaVersion\":1,\"game\":\"valheim\",\"source\":\"client\"," +
                    "\"reporter\":" + EilifMapTrackerPlugin.JsonStr(reporter) + "," +
                    "\"world\":" + EilifMapTrackerPlugin.JsonStr(world) + "," +
                    "\"players\":[" + entry + "]}";

                EilifMapTrackerPlugin.PostJson(
                    json,
                    "[EilifStats]",
                    $"[EilifStats] posted {counters} counters for {reporter} ({world}) [{reason}]");
            }
            catch (Exception ex)
            {
                // A stats read must never touch gameplay — degrade to one warning.
                EilifMapTrackerPlugin.Log?.LogWarning($"[EilifStats] read/post failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Read one PlayerStatType via the game's own accessor, rounded to a whole
        /// number. Returns false (and sets value 0) if the read throws or is not a
        /// finite number — in which case the caller OMITS the key rather than
        /// posting an invented zero.
        /// </summary>
        private static bool TryReadStat(PlayerProfile profile, PlayerStatType type, out long value)
        {
            value = 0;
            try
            {
                // 0.4.3: read the ALL-TIME bucket directly. Valheim 1.0 keeps ten stat
                // buckets on the profile (PlayerProfile.cs:86 `m_playerStats[10]`); the
                // game's GetStat() returns bucket 0 only while achievements are blocked and
                // otherwise the achievement-eligible bucket for the current difficulty
                // (PlayerProfile.cs:945). The eligible bucket is empty for anyone who played
                // modded before Unshamed, and it stops counting the moment a character is
                // flagged, so on 2026-09-10 eight of eleven vikings posted zero builds and
                // zero distance after an hour of play. Bucket 0 is lifetime and monotonic.
                float raw;
                var buckets = profile.m_playerStats;
                if (buckets != null && buckets.Length > 0 && buckets[0] != null) raw = buckets[0][type];
                else raw = profile.GetStat(type);
                if (float.IsNaN(raw) || float.IsInfinity(raw)) return false;
                value = (long)Math.Round(raw, MidpointRounding.AwayFromZero);
                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}
