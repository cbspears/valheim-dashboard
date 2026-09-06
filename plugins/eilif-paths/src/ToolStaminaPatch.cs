using System;
using System.Reflection;
using HarmonyLib;

namespace EilifPaths
{
    /// <summary>
    /// TOOL / WEAPON STAMINA CONTEXT (since 1.4.0).
    ///
    /// The whole EilifPaths stamina effect is one prefix on <c>Player.UseStamina(float v)</c>, which
    /// sees every stamina charge the local player pays but cannot tell WHY it is being paid. Up to
    /// 1.3.0 every charge got the same per-surface <c>staminadrain</c> discount, so swinging an axe or
    /// holding a bow drawn while standing on a road was as cheap as running along it.
    ///
    /// From 1.4.0 the two are separated:
    ///   * ordinary movement  -> per-surface <c>staminadrain</c>  (unchanged, 0.25 by default)
    ///   * tools and weapons  -> per-surface <c>actionstamina</c> (1.0 on Path/PavedRoad = vanilla,
    ///                                                             0.0 on built floors = free)
    ///
    /// HOW THE "WHY" IS RECOVERED. Vanilla charges tool/weapon stamina from a small, closed set of
    /// methods (verified against a full decompile of assembly_valheim 0.221.12). Each of those methods
    /// is wrapped: a Harmony PREFIX opens a context (depth++) and a Harmony FINALIZER closes it
    /// (depth--). A finalizer, not a postfix, is used deliberately: it runs even when the wrapped
    /// method returns early or throws, so a stuck counter is not possible from an exception. While the
    /// depth is above zero, any <c>Player.UseStamina</c> charge is a tool/weapon charge and gets
    /// <c>actionstamina</c>; otherwise it is movement (or anything unclassified) and gets
    /// <c>staminadrain</c>, exactly as before.
    ///
    /// A COUNTER, NOT A FLAG, because these wraps legitimately nest:
    ///   Player.Repair              nests inside Player.UpdatePlacement
    ///   Attack.FireProjectileBurst nests inside Attack.Update
    ///   a creature's Attack.Update can reach the local player's Humanoid.BlockAttack
    ///
    /// THE WRAPPED METHODS (decompile line numbers are from the 0.221.12 dump):
    ///   Attack.Update(float)                          1310 - every melee / ranged swing's charge
    ///   Attack.FireProjectileBurst()                  1630 - per-burst projectile cost (staves, multishot)
    ///   Humanoid.BlockAttack(HitData, Character)      14550, 14608 - blocking and parry (the blocker pays;
    ///                                                 Player does not override it, so Humanoid is the target)
    ///   Player.UpdatePlacement(bool, float)           16498, 16553 - piece removal, building/placing, and
    ///                                                 ALSO the hoe and the cultivator: terrain work is an
    ///                                                 ordinary piece placement, there is no separate charge
    ///   Player.Repair(ItemDrop.ItemData, Piece)       18807 - repairs (nested inside UpdatePlacement; wrapped
    ///                                                 anyway, the counter handles the nesting)
    ///   Player.UpdateAttackBowDraw(ItemData, float)   17174 - bow / crossbow draw drain
    ///   Player.UpdateActionQueue(float)               22331 - crossbow reload (the only queued action that
    ///                                                 carries a stamina drain; equip/unequip carry 0)
    ///   FishingFloat.FixedUpdate()                    110960, 110974 - fishing: hooked drain and reel-in drain
    ///   SE_Harpooned.UpdateStatusEffect(float)        25315 - harpoon drag (the status effect sits on the
    ///                                                 victim, but the harpooner pays)
    ///
    /// SITES DELIBERATELY NOT WRAPPED, and why that is correct:
    ///   Attack.Start / StartDraw / StartWithoutAnimation / OnAttackTrigger - these only PRE-CHECK stamina;
    ///     the actual charge lands in Attack.Update or FireProjectileBurst, which are wrapped.
    ///   Player.RemovePiece() / Player.TryPlacePiece(Piece) - charge nothing; their caller UpdatePlacement does.
    ///   Sadle.UpdateRiding(float) - charges the MOUNT's own stamina through Sadle.UseStamina, never the
    ///     player's. Out of scope for a player stamina feature.
    ///   SE_Stats.UpdateStatusEffect(float) - a generic data-driven status-effect drain; neither locomotion
    ///     nor a tool. Left unclassified on purpose, so it keeps exactly its 1.3.0 behaviour (staminadrain).
    ///
    /// PRE-CHECKS ARE NOT PATCHED. Vanilla gates each action on HaveStamina(vanilla cost) BEFORE charging.
    /// With actionstamina = 0 on a floor the swing is free but you must still HAVE the vanilla amount in the
    /// bar to start it. That is intentional: HaveStamina also drives StaminaBarEmptyFlash, the projectile
    /// Stop(), fishing-line loss and harpoon release, and patching it would decouple those from the real bar.
    ///
    /// FAILURE BEHAVIOUR. Every hook is applied individually inside try/catch and every patch body is
    /// wrapped, so nothing here can break the game: a hook that cannot be applied simply is not applied.
    /// If any hook fails to apply the plugin enters DEGRADED mode and, for charges it can no longer
    /// classify, falls back to the LARGER of the two multipliers. On a dirt path or paved road that is
    /// 1.0 (vanilla), so a missed tool charge can never silently keep the movement discount; on a built
    /// floor it is 0.25, so nothing becomes unexpectedly free. Normal (non-degraded) operation is
    /// unaffected by that branch.
    /// </summary>
    internal static class ToolStamina
    {
        // Nesting depth of "we are inside a tool/weapon charge" contexts. Single-threaded (Unity main
        // thread only); never allowed to go negative.
        private static int s_depth;
        private static bool s_leakReported;

        /// <summary>True while a wrapped tool/weapon method is on the stack.</summary>
        internal static bool Active { get { return s_depth > 0; } }

        /// <summary>True when at least one hook could not be applied (see the class doc).</summary>
        internal static bool Degraded { get; private set; }

        // --- the Harmony patch bodies (shared by every wrapped method) ---

        private static void ScopePrefix()
        {
            try { if (s_depth < int.MaxValue) s_depth++; }
            catch { /* a patch body must never throw into game code */ }
        }

        private static void ScopeFinalizer()
        {
            // Finalizer, not postfix: runs on early return AND on exception. Clamped at 0 so an
            // unbalanced call (e.g. another mod's prefix returning false and skipping ours) cannot
            // drive the counter negative and wedge the feature off.
            try { if (s_depth > 0) s_depth--; }
            catch { /* a patch body must never throw into game code */ }
        }

        /// <summary>
        /// Belt-and-braces self-heal, called from the plugin's 0.4s ground poll. That poll runs from
        /// Unity's Invoke queue, never nested inside any wrapped method, so the depth must be 0 every
        /// time it fires. If it is not, something leaked: reset it and say so once.
        /// </summary>
        internal static void SanityReset()
        {
            if (s_depth == 0) return;
            int leaked = s_depth;
            s_depth = 0;
            if (s_leakReported) return;
            s_leakReported = true;
            try
            {
                if (EilifPathsPlugin.Log != null)
                    EilifPathsPlugin.Log.LogWarning(
                        "[EilifPaths] tool/weapon stamina context was left open (depth " + leaked +
                        ") and has been reset. Stamina costs are correct again; this notice is logged once.");
            }
            catch { /* logging must never throw */ }
        }

        // --- hook application ---

        private sealed class Site
        {
            internal readonly Type Owner;
            internal readonly string Method;
            internal readonly Type[] Args;
            internal readonly string What;

            internal Site(Type owner, string method, Type[] args, string what)
            {
                Owner = owner;
                Method = method;
                Args = args;
                What = what;
            }

            internal string Label()
            {
                return (Owner != null ? Owner.Name : "?") + "." + Method;
            }
        }

        // NOTE: explicit argument types everywhere. Player.UpdateStats and Attack.Update have
        // same-named siblings/overloads in the game assembly, and a future update adding an overload to
        // any of these would otherwise turn a hook into an ambiguous-match failure at load time.
        //
        // ONE FACTORY PER SITE, AND THAT SHAPE IS LOAD-BEARING (v1.5.0, audit plugins-1.0). This used
        // to be a single method returning `new Site[] { new Site(typeof(Attack), …), … }`, which put
        // NINE typeof tokens in ONE method body. A typeof against a type the game no longer has
        // throws TypeLoadException, and it throws for the whole METHOD, so a single renamed or
        // deleted class in 1.0 — FishingFloat and SE_Harpooned are the plausible ones, both sit on
        // content Deep North touches — cost every one of the nine hooks at once and produced one
        // vague "hook setup failed" line. Each lambda below compiles to its own method, so its
        // typeof tokens are resolved only when THAT entry is built: the other eight hooks still go
        // on, and the log names the one that did not.
        //
        // WHAT THIS DOES *NOT* BUY, so nobody under-reacts to an "8/9 applied" line: one lost site
        // still calls MarkDegraded, which sets the single global Degraded flag, and CostMult() then
        // takes Max(actionstamina, staminadrain) for every unclassified charge — i.e. the headline
        // movement-stamina discount is gone on paths and roads whether one hook failed or nine.
        // That is deliberate and it is the SAFE direction: with a hook missing, a tool charge is
        // indistinguishable from a movement charge, so the discount cannot be applied honestly.
        // Read an 8/9 as "one named feature lost AND the road stamina discount is off until it is
        // fixed", not as "fishing only".
        //
        // Deliberately NOT AccessTools.TypeByName with string names: that would trade a compile-time
        // check (a renamed type fails the launch-morning rebuild, loudly, on this machine) for a
        // runtime string lookup that cannot fail until the server is already up.
        private static readonly Func<Site>[] SiteFactories =
        {
            () => new Site(typeof(Attack), "Update", new Type[] { typeof(float) },
                           "melee and ranged swings"),
            () => new Site(typeof(Attack), "FireProjectileBurst", new Type[0],
                           "projectile bursts"),
            () => new Site(typeof(Humanoid), "BlockAttack", new Type[] { typeof(HitData), typeof(Character) },
                           "blocking and parry"),
            () => new Site(typeof(Player), "UpdatePlacement", new Type[] { typeof(bool), typeof(float) },
                           "building, hoe and cultivator, piece removal"),
            () => new Site(typeof(Player), "Repair", new Type[] { typeof(ItemDrop.ItemData), typeof(Piece) },
                           "repairs"),
            () => new Site(typeof(Player), "UpdateAttackBowDraw", new Type[] { typeof(ItemDrop.ItemData), typeof(float) },
                           "bow and crossbow draw"),
            () => new Site(typeof(Player), "UpdateActionQueue", new Type[] { typeof(float) },
                           "crossbow reload"),
            () => new Site(typeof(FishingFloat), "FixedUpdate", new Type[0],
                           "fishing"),
            () => new Site(typeof(SE_Harpooned), "UpdateStatusEffect", new Type[] { typeof(float) },
                           "harpoon drag"),
        };

        /// <summary>
        /// Plain-string names for the factories above, IN THE SAME ORDER. Used only when a factory
        /// throws before it can build its Site — the one case where there is no Site to ask for a
        /// label, and the case that matters most, because it means a game type disappeared.
        /// These are strings on purpose: a typeof here would reintroduce the very failure the
        /// factories exist to contain.
        /// </summary>
        private static readonly string[] SiteLabels =
        {
            "Attack.Update", "Attack.FireProjectileBurst", "Humanoid.BlockAttack",
            "Player.UpdatePlacement", "Player.Repair", "Player.UpdateAttackBowDraw",
            "Player.UpdateActionQueue", "FishingFloat.FixedUpdate", "SE_Harpooned.UpdateStatusEffect",
        };

        /// <summary>
        /// Applies every tool/weapon context hook, each one isolated: one failure never stops the others
        /// and never stops the rest of the plugin. Logs how many of the hooks went on, and logs any that
        /// did not as an error naming the target, so a future game update that renames a private method
        /// shows up in LogOutput.log rather than silently handing the discount back to tools.
        /// </summary>
        internal static void Apply(Harmony harmony)
        {
            try
            {
                if (harmony == null) { MarkDegraded("Harmony instance was null"); return; }

                MethodInfo prefix = AccessTools.Method(typeof(ToolStamina), "ScopePrefix");
                MethodInfo finalizer = AccessTools.Method(typeof(ToolStamina), "ScopeFinalizer");
                if (prefix == null || finalizer == null)
                {
                    MarkDegraded("the patch bodies themselves could not be resolved");
                    return;
                }

                int applied = 0;
                int total = SiteFactories.Length;
                for (int i = 0; i < total; i++)
                {
                    Site site = null;
                    try
                    {
                        // The factory call is INSIDE the per-site try on purpose: this is where a
                        // vanished game type surfaces, and it must cost one hook, not the batch.
                        site = SiteFactories[i]();
                        MethodBase target = AccessTools.Method(site.Owner, site.Method, site.Args);
                        if (target == null)
                        {
                            MarkDegraded("could not find " + site.Label() + " (" + site.What + ")");
                            continue;
                        }

                        // CreateProcessor (not the obsolete Harmony.Patch overload) so this keeps
                        // compiling against current HarmonyX.
                        harmony.CreateProcessor(target)
                               .AddPrefix(new HarmonyMethod(prefix))
                               .AddFinalizer(new HarmonyMethod(finalizer))
                               .Patch();
                        applied++;
                    }
                    catch (Exception ex)
                    {
                        // `site` is null when the FACTORY itself threw — i.e. one of its typeof
                        // tokens named a game type that is gone. SiteLabels carries the name for
                        // exactly that case, so the line still says which hook was lost.
                        string label = site != null
                            ? site.Label() + " (" + site.What + ")"
                            : SiteLabels[i] + " (its game type could not be loaded)";
                        MarkDegraded("could not hook " + label + ": " + ex.Message);
                    }
                }

                try
                {
                    if (EilifPathsPlugin.Log != null)
                        EilifPathsPlugin.Log.LogInfo(
                            "[EilifPaths] tool/weapon stamina hooks: " + applied + "/" + total +
                            " applied" + (Degraded ? " (DEGRADED - see the errors above)" : "") + ".");
                }
                catch { /* logging must never throw */ }
            }
            catch (Exception ex)
            {
                MarkDegraded("hook setup failed: " + ex.Message);
            }
        }

        private static void MarkDegraded(string reason)
        {
            Degraded = true;
            try
            {
                if (EilifPathsPlugin.Log != null)
                    EilifPathsPlugin.Log.LogError(
                        "[EilifPaths] tool/weapon stamina hook problem: " + reason +
                        ". Falling back to the safer of the two multipliers for charges that can no " +
                        "longer be classified (vanilla cost on paths and roads, 0.25 on built floors).");
            }
            catch { /* logging must never throw */ }
        }
    }
}
