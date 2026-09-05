using System;
using System.Globalization;
using System.Reflection;
using BepInEx;
using HarmonyLib;
using UnityEngine;

namespace EilifCompanionClient
{
    /// <summary>
    /// EilifCompanionClient — the authoritative DEATH-CAUSE reporter (since v0.2.0;
    /// self-binding `reporter` field since v0.3.1, see Report()).
    ///
    /// THE PROBLEM IT SOLVES. Death causes used to reach the dashboard only via the
    /// third-party GsValheimStatsClient's `deathEvents[]`, which reports every
    /// unattributed damage-over-time death — a campfire you stood in, the cold on a
    /// mountain, poison in the swamp — as the flat catch-all <c>enemyhit</c>. The
    /// real cause is destroyed at its source, so nothing downstream can recover it.
    ///
    /// THE FIX. Valheim knows exactly what killed you: the killing
    /// <c>HitData</c> is still sitting in <c>Character.m_lastHit</c> when
    /// <c>Player.OnDeath</c> runs. We Harmony-Postfix that method for the LOCAL
    /// player only, read the hit, and POST the exact <c>HitData.HitType</c> word
    /// plus the attacker (when there is one) to the dashboard ingest — the same
    /// endpoint, config and fire-and-forget plumbing the cartography post already
    /// uses (<c>source:'eilif-death'</c> instead of <c>'client-map'</c>).
    ///
    /// DECOMPILE-VERIFIED against <c>libs/assembly_valheim.dll</c> (game 0.221.12,
    /// ilspycmd), because a wrong member name here is a silent no-op at runtime:
    ///
    ///   • <c>Character</c>: <c>protected HitData m_lastHit;</c> — assigned in
    ///     <c>Character.Damage(HitData hit)</c> as <c>m_lastHit = hit;</c> BEFORE the
    ///     health subtraction that can bring the player to 0. Protected, hence the
    ///     cached <c>AccessTools.Field</c> handle below rather than a direct member
    ///     access.
    ///   • <c>Player</c>: <c>protected override void OnDeath()</c>, and its very
    ///     first real statement is <c>switch (m_lastHit.m_hitType)</c> — an
    ///     UNGUARDED dereference. The game itself therefore treats m_lastHit as
    ///     guaranteed non-null at this exact point, which is precisely why this is
    ///     the right hook site. (We still null-check: a mod-induced null must
    ///     degrade to "no report", never to an exception inside a death handler.)
    ///   • <c>HitData</c>: <c>public HitType m_hitType;</c>,
    ///     <c>public ZDOID m_attacker = ZDOID.None;</c>,
    ///     <c>public Character GetAttacker()</c> (resolves the ZDOID through
    ///     <c>ZNetScene.instance.FindInstance</c>, returns null when the attacker is
    ///     None / the scene is gone / the object has despawned),
    ///     <c>public Vector3 m_point</c>.
    ///   • <c>HitData.HitType : byte</c> has 22 values — Undefined, EnemyHit,
    ///     PlayerHit, Fall, Drowning, Burning, Freezing, Poisoned, Water, Smoke,
    ///     EdgeOfWorld, Impact, Cart, Tree, Self, Structural, Turret, Boat,
    ///     Stalagtite, Catapult, CinderFire, AshlandsOcean. We send
    ///     <c>ToString()</c> VERBATIM; the server (lib/deaths.ts HIT_TYPES) holds the
    ///     same list and maps each to a rendered phrase.
    ///   • <c>Character</c>: <c>public string m_name</c> is a LOCALIZATION TOKEN
    ///     (<c>GetHoverName()</c> returns <c>Localization.instance.Localize(m_name)</c>),
    ///     so a serpent reads "$enemy_serpent". We send it RAW — the server
    ///     humanizes via config/creatures.ts, keeping one naming table, not two.
    ///   • <c>Player</c>: <c>public override string GetHoverName()</c> is censored
    ///     UGC, so a player attacker uses <c>GetPlayerName()</c> instead.
    ///   • <c>Heightmap</c>: <c>public static Biome FindBiome(Vector3 point)</c>
    ///     (returns <c>Biome.None</c> with no loaded heightmap), with
    ///     <c>WorldGenerator.instance.GetBiome(float wx, float wy, ...)</c> as the
    ///     fallback — the same pair EilifPaths / EilifCompanion use.
    ///
    /// ⚠️ NO System.ValueTuple ANYWHERE in this file (target is net462; the
    /// BepInEx/Unity Mono runtime ships no ValueTuple reference and a tuple on a
    /// load path fails the plugin SILENTLY — see BUILD.md and the source comment in
    /// ../../eilif-paths/src/EilifPathsPlugin.cs). Every multi-value return here is
    /// an ordinary class.
    ///
    /// SAFETY. Gameplay comes first, always: the whole report is wrapped so no
    /// exception can escape into Valheim's death handling, the POST is
    /// fire-and-forget off the main thread, and a missing field degrades the report
    /// rather than aborting it. Worst case the dashboard learns nothing new and the
    /// player notices nothing at all.
    /// </summary>
    internal static class EilifDeathReporter
    {
        // Cached reflection handle for the protected `Character.m_lastHit` field
        // (see the decompile notes above). Resolved once; null means the field
        // moved in a game update, in which case we simply never report.
        private static readonly FieldInfo LastHitField = AccessTools.Field(typeof(Character), "m_lastHit");

        /// <summary>
        /// Build and send one death report. Called from the Player.OnDeath postfix.
        /// Silent no-op unless this is the LOCAL player dying while connected to a
        /// remote server.
        /// </summary>
        internal static void Report(Player who)
        {
            if (who == null || who != Player.m_localPlayer) return;   // never someone else's death
            if (!EilifMapTrackerPlugin.IsOnServer()) return;          // menu / singleplayer / hosting
            if (LastHitField == null)
            {
                EilifMapTrackerPlugin.Log?.LogWarning(
                    "[EilifDeath] Character.m_lastHit not found — the game's field layout changed; no death reported.");
                return;
            }

            var znet = ZNet.instance;
            if (znet == null) return;

            HitData hit = LastHitField.GetValue(who) as HitData;
            if (hit == null)
            {
                // The game dereferences m_lastHit unguarded here, so this should be
                // unreachable; if some other mod cleared it, say so rather than
                // inventing a cause.
                EilifMapTrackerPlugin.Log?.LogWarning("[EilifDeath] no m_lastHit at death — nothing to report.");
                return;
            }

            string hitType = hit.m_hitType.ToString();
            string attacker = ResolveAttacker(hit);
            string biome = ResolveBiome(who);
            string player = who.GetPlayerName();
            string world = znet.GetWorldName() ?? "";
            if (string.IsNullOrEmpty(player)) return;

            // v0.3.1 — WHO SENT THIS. `who` is already proven to be
            // Player.m_localPlayer above, so this is the very same identity the
            // cartography post reports as `playerName`: the character sitting at
            // this keyboard. The server requires reporter == player and runs its
            // presence cross-check on the REPORTER, which is what makes a death
            // report self-only — before this field existed, anyone who could reach
            // /api/gs-ingest (client payloads carry no secret, by design: they run
            // on players' PCs) could POST a fabricated death, with an
            // attacker-written cause, for any viking who happened to be online.
            // For an honest client the two names are always identical; the field
            // exists so the server can TELL that, instead of having to assume it.
            string reporter = Player.m_localPlayer.GetPlayerName();

            Vector3 pos = who.transform.position;
            string tsUtc = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);

            string json =
                "{\"schemaVersion\":1,\"game\":\"valheim\",\"source\":\"eilif-death\"," +
                "\"world\":" + EilifMapTrackerPlugin.JsonStr(world) + "," +
                "\"player\":" + EilifMapTrackerPlugin.JsonStr(player) + "," +
                "\"reporter\":" + EilifMapTrackerPlugin.JsonStr(reporter) + "," +
                "\"tsUtc\":" + EilifMapTrackerPlugin.JsonStr(tsUtc) + "," +
                "\"hitType\":" + EilifMapTrackerPlugin.JsonStr(hitType) + "," +
                "\"attacker\":" + (attacker == null ? "null" : EilifMapTrackerPlugin.JsonStr(attacker)) + "," +
                "\"biome\":" + EilifMapTrackerPlugin.JsonStr(biome) + "," +
                "\"pos\":{\"x\":" + Fmt(pos.x) + ",\"z\":" + Fmt(pos.z) + "}}";

            // One local line, whatever happens to the network afterwards.
            EilifMapTrackerPlugin.Log?.LogInfo(
                $"[EilifDeath] {player} died in {world}: hitType={hitType}, attacker={(attacker ?? "(none)")}, biome={biome}");

            EilifMapTrackerPlugin.PostJson(
                json,
                "[EilifDeath]",
                $"[EilifDeath] reported {hitType}" + (attacker == null ? "" : " by " + attacker) + $" for {player}");
        }

        /// <summary>
        /// The killer's RAW name, or null when the hit had no attacker (every
        /// environmental death: fall, drowning, an unattended campfire).
        ///
        /// A player killer gives their character name; a creature gives
        /// <c>Character.m_name</c>, which is a localization token like
        /// "$enemy_serpent". Sent raw on purpose — config/creatures.ts server-side
        /// owns the token → display-name table so there is exactly one of them.
        /// Falls back to the prefab name (minus Unity's "(Clone)" suffix) for a
        /// creature whose m_name is blank.
        /// </summary>
        private static string ResolveAttacker(HitData hit)
        {
            try
            {
                Character atk = hit.GetAttacker();   // null when m_attacker is None / despawned
                if (atk == null) return null;

                Player ap = atk as Player;
                if (ap != null)
                {
                    string pn = ap.GetPlayerName();
                    return string.IsNullOrEmpty(pn) ? null : pn;
                }

                string n = atk.m_name;
                if (!string.IsNullOrEmpty(n)) return n;
                return PrefabName(atk.gameObject);
            }
            catch (Exception ex)
            {
                // The attacker is a bonus, never the load-bearing part — a death
                // still reports with its HitType if this fails.
                EilifMapTrackerPlugin.Log?.LogWarning($"[EilifDeath] attacker lookup failed: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Heightmap biome word at the death position — same approach EilifPaths /
        /// EilifCompanion use. Heightmap.FindBiome first (the loaded terrain's own
        /// answer), WorldGenerator second (works even where no heightmap is loaded).
        /// "None" is a real, honest answer, never an error.
        /// </summary>
        private static string ResolveBiome(Player who)
        {
            try
            {
                Vector3 pos = who.transform.position;
                Heightmap.Biome b = Heightmap.FindBiome(pos);
                if (b == Heightmap.Biome.None && WorldGenerator.instance != null)
                    b = WorldGenerator.instance.GetBiome(pos.x, pos.z);
                return b.ToString();
            }
            catch
            {
                return "None"; // position/hitType are the load-bearing parts; never fail on biome
            }
        }

        private static string PrefabName(GameObject go)
        {
            if (go == null) return null;
            string n = go.name;
            if (string.IsNullOrEmpty(n)) return null;
            int i = n.IndexOf("(Clone)", StringComparison.OrdinalIgnoreCase);
            return i > 0 ? n.Substring(0, i) : n;
        }

        /// <summary>Invariant-culture number — never emit "12,5" for a Swedish locale.</summary>
        private static string Fmt(float v)
        {
            return ((float)Math.Round(v, 1)).ToString("0.#", CultureInfo.InvariantCulture);
        }
    }

    /// <summary>
    /// Postfix on <c>Player.OnDeath</c> (protected override — Harmony resolves it by
    /// name on the declaring type). POSTFIX deliberately: it never sits in front of
    /// Valheim's own death handling, and it still runs if another mod's prefix
    /// skipped the original. It also fires for OTHER players' Player objects on this
    /// client (their OnDeath returns early at the <c>!m_nview.IsOwner()</c> check but
    /// the postfix runs regardless), which is why Report() re-checks
    /// <c>Player.m_localPlayer</c> first.
    /// </summary>
    [HarmonyPatch(typeof(Player), "OnDeath")]
    internal static class Patch_PlayerOnDeath
    {
        private static void Postfix(Player __instance)
        {
            try
            {
                EilifDeathReporter.Report(__instance);
            }
            catch (Exception ex)
            {
                // Nothing that happens in here may ever disturb a real death.
                EilifMapTrackerPlugin.Log?.LogWarning($"[EilifDeath] death hook failed: {ex.Message}");
            }
        }
    }
}
