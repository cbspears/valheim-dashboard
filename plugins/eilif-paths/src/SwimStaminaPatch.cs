using System;
using System.Globalization;
using BepInEx.Configuration;
using HarmonyLib;
using UnityEngine;

namespace EilifPaths
{
    /// <summary>
    /// STAMINA IN WATER (since 1.6.0).
    ///
    /// Vanilla flatly refuses to regenerate stamina while you are in deep water, so a long crossing
    /// is a one-way count down to drowning damage. This gives it back: full rate while treading
    /// (in the water, not moving) and half rate while actively swimming. The swim DRAIN is not
    /// touched at all — that stays ValheimPlus [Stamina] swimStaminaDrain, which is the owner's
    /// lever, and vanilla's Player.OnSwimming is left exactly as it is.
    ///
    /// VERIFIED BY DECOMPILE (ilspycmd against libs/assembly_valheim.dll, game 0.221.12; whole-
    /// assembly dump line numbers, the same ones ToolStaminaPatch.cs cites).
    ///
    /// THERE IS NO Player.UpdateStamina AND NO Character.UpdateStamina. The player's regen lives in
    /// the middle of Player.UpdateStats(float), and it is one contiguous block:
    ///
    ///   17271:  private void UpdateStats(float dt)
    ///   17273:      if (InIntro() || IsTeleporting())
    ///   17275:          return;                                                // &lt;-- vanilla bails
    ///   17280:      bool flag = IsEncumbered();
    ///   17281:      float maxStamina = GetMaxStamina();
    ///   17282:      float num = 1f;
    ///   17283:      if (IsBlocking())
    ///   17285:          num *= 0.8f;
    ///   17287:      if ((IsSwimming() &amp;&amp; !IsOnGround()) || InAttack() || InDodge() || m_wallRunning || flag)
    ///   17289:          num = 0f;                                              // &lt;-- the refusal
    ///   17291:      float num2 = (m_staminaRegen + (1f - m_stamina / maxStamina) * m_staminaRegen * m_staminaRegenTimeMultiplier) * num;
    ///   17292:      float staminaMultiplier = 1f;
    ///   17293:      m_seman.ModifyStaminaRegen(ref staminaMultiplier);
    ///   17294:      num2 *= staminaMultiplier;
    ///   17295:      m_staminaRegenTimer -= dt;
    ///   17296:      if (m_stamina &lt; maxStamina &amp;&amp; m_staminaRegenTimer &lt;= 0f)
    ///   17298:          m_stamina = Mathf.Min(maxStamina, m_stamina + num2 * dt * Game.m_staminaRegenRate);
    ///   17300:      m_nview.GetZDO().Set(ZDOVars.s_stamina, m_stamina);
    ///
    /// (There IS a Sadle.UpdateStamina(float) at 23438-ish in the same dump. That is the MOUNT's
    /// stamina, a different class and a different bar. Do not patch it.)
    ///
    /// THE HOOK IS A POSTFIX, AND IT RE-RUNS EXACTLY THAT ARITHMETIC with the swimming half of line
    /// 17287 taken back out. Not a transpiler: the line the IL would have to be spliced at is a
    /// branch inside a five-way boolean, which is precisely the shape that breaks silently when a
    /// game update reorders the condition. Not a prefix either — a postfix runs AFTER line 17295 has
    /// already decremented m_staminaRegenTimer, so the delay test below is literally vanilla's own
    /// test on vanilla's own value rather than a re-derivation of it.
    ///
    /// THE PRICE OF A POSTFIX is that it also runs when the original RETURNED EARLY, so vanilla's
    /// guard at 17273 has to be replicated by hand. Regenerate() does that as its first game-state
    /// test. Any future early return added above the regen block has to be mirrored there too, and
    /// that is the standing maintenance cost of this hook shape.
    ///
    /// Nothing has to be restored afterwards, so there is nothing here for a finalizer to protect:
    /// the postfix ADDS stamina through the public Player.AddStamina, it never swaps a field. If
    /// UpdateStats throws, Harmony skips this postfix and the player simply does not gain stamina
    /// that tick, which is vanilla.
    ///
    ///   19535:  public override void AddStamina(float v)
    ///   19537:      m_stamina += v;
    ///   19538:      if (m_stamina &gt; m_maxStamina)
    ///   19540:          m_stamina = m_maxStamina;
    ///
    /// AddStamina clamps at max (so "never exceed max stamina" is the game's own code, not ours) and
    /// it does NOT re-arm the regen delay, which is what makes it the right call to use here.
    ///
    /// THE ONE COST OF BEING A POSTFIX: vanilla writes the stamina ZDO at line 17300, one statement
    /// before we add. So the ZDO trails the real bar by a single physics tick. That is visible to
    /// nobody who matters: Player.HaveStamina reads the ZDO only for a player this client does NOT
    /// own (19682-19685), and reads m_stamina directly for the local one. The local bar, every local
    /// gate, and drowning are all on m_stamina.
    ///
    /// WHY m_wallRunning IS NOT REFLECTED FOR. It is one of the five conditions on line 17287 and it
    /// is protected on Character, so undoing only the swimming half looks like it needs an
    /// AccessTools handle. It does not: Character.UpdateMotion sets it false at the top of every
    /// physics tick and only ApplySlide sets it true —
    ///
    ///   7956:   private void UpdateMotion(float dt)
    ///   7960:       m_wallRunning = false;
    ///   7940:           m_wallRunning = true;        // inside ApplySlide, the GROUND branch
    ///   8072:   private void UpdateSwimming(float dt)
    ///
    /// — and ApplySlide is only reached down the ground-movement branch, never from UpdateSwimming.
    /// A character in the water has been through UpdateSwimming, not ApplySlide, so m_wallRunning is
    /// false whenever this postfix's own guards are satisfied. One fewer private member to resolve.
    ///
    /// TREADING VS SWIMMING, AND WHY THE REGEN DELAY IS HANDLED DIFFERENTLY IN EACH.
    ///
    ///   * TREADING (horizontal speed at or below treadingSpeedThreshold). Nothing is being spent,
    ///     so vanilla's own delay timer counts down normally and regen starts after
    ///     m_staminaRegenDelay (1 s in this build) exactly as it does when you stop running on
    ///     land. The delay is respected, and the check is vanilla's own value read after vanilla
    ///     decremented it.
    ///
    ///   * SWIMMING (above the threshold). The delay is DELIBERATELY BYPASSED, and the decompile is
    ///     the reason. Player.OnSwimming charges stamina on EVERY physics tick a movement key is
    ///     held —
    ///
    ///       17800:  protected override void OnSwimming(Vector3 targetVel, float dt)
    ///       17803:      if (targetVel.magnitude &gt; 0.1f)
    ///       17809:          UseStamina(dt * num * Game.m_moveStaminaRate);
    ///
    ///     — and every non-zero charge re-arms the timer to the full delay:
    ///
    ///       19667:  private void RPC_UseStamina(long sender, float v)
    ///       19669:      if (v != 0f)
    ///       19671:          m_stamina -= v;
    ///       19676:          m_staminaRegenTimer = m_staminaRegenDelay;
    ///
    ///     So while you are stroking, m_staminaRegenTimer is pinned at the delay and can never reach
    ///     zero. "Respect the delay" there does not mean "wait a second"; it means regenWhileSwimming
    ///     is a knob that can never fire once, and the owner's ask (recover stamina WHILE swimming)
    ///     would quietly not ship. The delay exists to stop you regenerating the instant you stop
    ///     spending; against a drain that never stops it is not a delay, it is an off switch. Set
    ///     regenWhileSwimming = 0 to get vanilla's behaviour back on that half.
    ///
    /// WHAT THE DEFAULT ACTUALLY BUYS, so it can be retuned from arithmetic rather than vibes. On
    /// the Player class defaults in this build (m_staminaRegen = 5, m_staminaRegenTimeMultiplier = 1,
    /// m_swimStaminaDrainMinSkill = 5, m_swimStaminaDrainMaxSkill = 2, m_staminaRegenDelay = 1) the
    /// vanilla regen curve runs from 5/s at a full bar up to 10/s at an empty one, so half of it is
    /// 2.5/s to 5/s. Vanilla swim drain is 5/s at Swim skill 0 falling to 2/s at skill 100. A new
    /// viking therefore still loses ground while stroking (5/s out, 2.5-5/s back), and a practised
    /// one roughly breaks even or gains. If that is too generous, regenWhileSwimming is the knob;
    /// the drain side stays ValheimPlus [Stamina] swimStaminaDrain, untouched by this plugin.
    /// These are the values compiled into Player.cs; a prefab may override them, which is exactly
    /// why the boot line prints the configured multipliers and nothing pretends to know the rest.
    ///
    /// NOTE: no System.ValueTuple anywhere in this file — see the warning above BindSurface(...) in
    /// EilifPathsPlugin.cs. The game's net462 Mono runtime ships no ValueTuple and a reference to it
    /// makes the plugin fail to load SILENTLY.
    /// </summary>
    internal static class SwimRegen
    {
        internal const string Section = "Swim";

        internal const float DefaultTreading = 1f;
        internal const float DefaultSwimming = 0.5f;
        // Vanilla's own "is this viking actually moving through the water" test is
        // `targetVel.magnitude > 0.1f` on the INTENDED velocity (line 17803). We only have the
        // achieved velocity to work with, which carries wave push and the tail of a stroke, so the
        // threshold sits higher than 0.1. Character.m_swimSpeed is 2 m/s (line 6942), so 0.5 m/s
        // separates "drifting" from "swimming" with a factor of four either side.
        internal const float DefaultThreshold = 0.5f;

        internal static ConfigEntry<bool> Enabled;
        internal static ConfigEntry<float> RegenWhileTreading;
        internal static ConfigEntry<float> RegenWhileSwimming;
        internal static ConfigEntry<float> TreadingSpeedThreshold;

        internal static void Bind(ConfigFile config)
        {
            Enabled = config.Bind(Section, "enabled", true,
                "Regenerate stamina in deep water, which vanilla refuses to do at all. false = " +
                "vanilla, and no hook is applied. This never changes the cost of swimming, only the " +
                "recovery; the drain stays whatever ValheimPlus [Stamina] swimStaminaDrain says.");

            RegenWhileTreading = config.Bind(Section, "regenWhileTreading", DefaultTreading,
                "Stamina regeneration while you are in the water and NOT moving, as a multiple of " +
                "the normal on-land rate. 1 = the Eilif default, i.e. treading water recovers exactly " +
                "as fast as standing still on a beach. 0 = vanilla (no recovery at all). The usual " +
                "one-second pause after spending stamina still applies here, exactly as it does on " +
                "land.");

            RegenWhileSwimming = config.Bind(Section, "regenWhileSwimming", DefaultSwimming,
                "Stamina regeneration while you are actively swimming, as a multiple of the normal " +
                "rate. 0.5 = the Eilif default, i.e. half rate against the swim drain, which is left " +
                "alone. 0 = vanilla (no recovery while stroking). NOTE this half deliberately ignores " +
                "the one-second pause after spending: the swim drain re-arms that pause every single " +
                "tick, so honouring it would mean this setting could never do anything.");

            TreadingSpeedThreshold = config.Bind(Section, "treadingSpeedThreshold", DefaultThreshold,
                "Horizontal speed in metres per second below which you count as treading water rather " +
                "than swimming. Vertical bobbing is ignored. Swim speed is about 2 m/s, so the default " +
                "0.5 leaves plenty of room either side; raise it if wave push makes you read as " +
                "swimming while you float, lower it if a gentle drift reads as treading.");
        }

        internal static bool Active
        {
            get
            {
                try { return Enabled != null && Enabled.Value; }
                catch { return false; }
            }
        }

        private static float Safe(ConfigEntry<float> entry, float fallback)
        {
            if (entry == null) return fallback;
            float v = entry.Value;
            if (float.IsNaN(v) || float.IsInfinity(v) || v < 0f) return fallback;
            return v;
        }

        internal static string Describe()
        {
            if (!Active) return "vanilla";
            return "x" + F(Safe(RegenWhileTreading, 0f)) + " treading, x" +
                   F(Safe(RegenWhileSwimming, 0f)) + " swimming";
        }

        private static string F(float v) => v.ToString("0.##", CultureInfo.InvariantCulture);

        // ---- the private regen-delay timer ---------------------------------------------------
        //
        // Player.m_staminaRegenTimer is private (line 15654), so it goes through AccessTools the
        // same way VPlusFallback reaches the m_nview fields. Resolved once. If it cannot be
        // resolved, the TREADING half goes inert with a named warning and the swimming half — which
        // does not consult the timer at all, see the class doc — keeps working. Degrading toward
        // vanilla, never toward "regenerate whenever".
        private static bool _timerRefTried;
        private static AccessTools.FieldRef<Player, float> _regenTimerRef;

        private static bool TryGetRegenTimer(Player player, out float timer)
        {
            timer = 0f;
            if (!_timerRefTried)
            {
                _timerRefTried = true;
                try { _regenTimerRef = AccessTools.FieldRefAccess<Player, float>("m_staminaRegenTimer"); }
                catch (Exception ex)
                {
                    _regenTimerRef = null;
                    Warn("Player.m_staminaRegenTimer not reachable (" + ex.Message + "); stamina " +
                         "recovery while TREADING water is off for this session. Recovery while " +
                         "actively swimming is unaffected.");
                }
            }
            if (_regenTimerRef == null) return false;
            timer = _regenTimerRef(player);
            return true;
        }

        private static bool _warned;

        private static void Warn(string line)
        {
            try
            {
                if (_warned) return;
                _warned = true;
                if (EilifPathsPlugin.Log != null)
                    EilifPathsPlugin.Log.LogWarning("[EilifPaths] swim stamina: " + line);
            }
            catch { /* logging must never throw out of a patch */ }
        }

        /// <summary>
        /// True while the local player is moving through the water rather than floating in it.
        /// HORIZONTAL speed only: buoyancy drives a constant vertical velocity (lines 8114-8130) and
        /// bobbing on a swell is not swimming.
        /// </summary>
        private static bool IsStroking(Player player)
        {
            try
            {
                Vector3 v = player.GetVelocity();
                float horizontalSq = v.x * v.x + v.z * v.z;
                float threshold = Safe(TreadingSpeedThreshold, DefaultThreshold);
                return horizontalSq > threshold * threshold;
            }
            catch
            {
                // Unknown speed reads as swimming, i.e. the SMALLER default multiplier.
                return true;
            }
        }

        /// <summary>
        /// Re-runs vanilla's regen arithmetic (Player.UpdateStats lines 17280-17298) with the
        /// swimming clause of line 17287 removed, scaled by the configured multiplier. Called from
        /// the postfix, for the local player only.
        /// </summary>
        internal static void Regenerate(Player player, float dt)
        {
            if (!Active) return;
            if (player == null) return;
            if (!(dt > 0f) || float.IsNaN(dt) || float.IsInfinity(dt)) return;

            // VANILLA'S OWN EARLY RETURN, replicated. UpdateStats opens at line 17273 with
            //
            //   17271:  private void UpdateStats(float dt)
            //   17273:      if (InIntro() || IsTeleporting())
            //   17275:          return;
            //
            // BEFORE it reaches the regen block or the m_staminaRegenTimer decrement at 17295. A
            // Harmony POSTFIX still runs after an early return, so without this clause the postfix
            // would regenerate on the one path where vanilla deliberately regenerates nothing.
            // It is reachable: IsSwimming() is `m_swimTimer < 0.5f` (line 9834), so it stays true
            // for up to half a second after the character leaves the water — long enough for a
            // portal taken from the water to open a sub-second window of free stamina. Small
            // (~0.5 s at most, and AddStamina clamps at max) but it is vanilla's guard and we do
            // not get to skip it just because skipping it is cheap.
            if (player.InIntro() || player.IsTeleporting()) return;

            // The swimming clause of line 17287, and only that one. Everything else on that line
            // still refuses regen, exactly as vanilla does — this feature is "water no longer
            // blocks recovery", not "recovery is always on".
            if (!player.IsSwimming() || player.IsOnGround()) return;
            if (player.InAttack() || player.InDodge() || player.IsEncumbered()) return;
            // m_wallRunning is provably false here; see the class doc.

            float maxStamina = player.GetMaxStamina();
            if (!(maxStamina > 0f) || float.IsNaN(maxStamina) || float.IsInfinity(maxStamina)) return;
            float stamina = player.GetStamina();          // vanilla's m_stamina (line 19453)
            if (!(stamina < maxStamina)) return;          // line 17296, first half

            bool stroking = IsStroking(player);
            float mult = stroking
                ? Safe(RegenWhileSwimming, 0f)
                : Safe(RegenWhileTreading, 0f);
            if (!(mult > 0f)) return;                     // 0 = this half is switched off

            if (!stroking)
            {
                // Line 17296, second half. Vanilla has ALREADY decremented the timer by this dt at
                // line 17295, so reading it in a postfix is reading vanilla's own answer.
                float timer;
                if (!TryGetRegenTimer(player, out timer)) return;
                if (timer > 0f) return;
            }
            // While stroking the timer is pinned by the swim drain and is deliberately not
            // consulted — see the class doc.

            // Lines 17282-17286: blocking costs a fifth of the regen rate.
            float rate = player.IsBlocking() ? 0.8f : 1f;

            // Line 17291, with `num` forced back to `rate` instead of 0.
            float regen = (player.m_staminaRegen +
                           (1f - stamina / maxStamina) * player.m_staminaRegen *
                           player.m_staminaRegenTimeMultiplier) * rate;

            // Lines 17292-17294: status effects get their say (rested, wet, potions).
            float staminaMultiplier = 1f;
            SEMan seman = player.GetSEMan();
            if (seman != null) seman.ModifyStaminaRegen(ref staminaMultiplier);
            regen *= staminaMultiplier;

            // Line 17298, plus our own multiplier. Game.m_staminaRegenRate is the world modifier
            // (public static, and 1 on a default world).
            float gain = regen * dt * Game.m_staminaRegenRate * mult;
            if (float.IsNaN(gain) || float.IsInfinity(gain) || !(gain > 0f)) return;

            // AddStamina clamps at max (lines 19535-19542) and does not re-arm the regen delay.
            player.AddStamina(gain);
        }
    }

    /// <summary>
    /// Postfix on the private instance method <c>Player.UpdateStats(float)</c>.
    ///
    /// EXPLICIT ARGUMENT TYPES ARE LOAD-BEARING: Player declares BOTH <c>UpdateStats()</c> and
    /// <c>UpdateStats(float dt)</c>, so a name-only patch is an ambiguous match. Same reason
    /// ToolStaminaPatch spells out every signature it hooks.
    ///
    /// <c>dt</c> is injected by NAME from the original's parameter list. If a future build renames
    /// that argument, Harmony throws while applying this class, the apply loop catches it, and the
    /// boot log carries `MISSING patch class Patch_Player_UpdateStats` naming the feature that died.
    /// That is a visible failure, which is the point.
    /// </summary>
    [HarmonyPatch(typeof(Player), "UpdateStats", new Type[] { typeof(float) })]
    internal static class Patch_Player_UpdateStats
    {
        private static void Postfix(Player __instance, float dt)
        {
            try
            {
                // Only the local player. UpdateStats is already only called for the owned local
                // player (lines 16093-16114), so this is belt and braces rather than a filter.
                if (__instance == null || __instance != Player.m_localPlayer) return;
                SwimRegen.Regenerate(__instance, dt);
            }
            catch { /* a patch body must never throw into game code */ }
        }
    }
}
