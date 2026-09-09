using System;
using System.Globalization;
using BepInEx.Configuration;
using HarmonyLib;
using UnityEngine;

namespace EilifPaths
{
    /// <summary>
    /// MAP DISCOVERY RADIUS (since 1.6.0).
    ///
    /// Widens the circle of fog the local player lifts as they travel: twice as much on foot, five
    /// times as much while on a ship (1.5 and 2 through 1.7.0). Client-side, per-frame, configurable,
    /// and it never leaves a changed value behind.
    ///
    /// VERIFIED BY DECOMPILE (ilspycmd against libs/assembly_valheim.dll, game 0.221.12; the line
    /// numbers below are from the whole-assembly dump, the same one ToolStaminaPatch.cs cites).
    /// Minimap owns one radius and one caller:
    ///
    ///   47185:  public float m_exploreInterval = 2f;
    ///   47187:  public float m_exploreRadius = 100f;
    ///
    ///   48509:  private void UpdateExplore(float dt, Player player)
    ///   48510:  {
    ///   48511:      m_exploreTimer += Time.deltaTime;
    ///   48512:      if (m_exploreTimer &gt; m_exploreInterval)
    ///   48513:      {
    ///   48514:          m_exploreTimer = 0f;
    ///   48515:          Explore(player.transform.position, m_exploreRadius);
    ///   48516:      }
    ///   48517:  }
    ///
    /// and its ONE caller, from Minimap.Update, always with the local player:
    ///
    ///   47541:      UpdateExplore(deltaTime, localPlayer);      // localPlayer = Player.m_localPlayer
    ///
    /// THE HOOK: a prefix that MULTIPLIES <c>m_exploreRadius</c> and a FINALIZER that puts the
    /// captured value back. Note what it does not do: it never assigns an absolute radius. Whatever
    /// number is in that field at the moment the frame runs is what gets scaled, so a hand-edited
    /// prefab, a future vanilla retune, or another mod that has already written the field all
    /// compose with this instead of fighting it.
    ///
    /// WHY <c>UpdateExplore</c> AND NOT <c>Explore(Vector3, float)</c>. Explore is the wrong seam
    /// twice over. It is also called by <c>Minimap.ExploreAll</c> (the reveal-everything path), and
    /// it is what <c>VPlusFallback.Tick</c> invokes by reflection for ShareExploration — patching it
    /// would multiply that pass a second time on top of the multiplier that pass already applies for
    /// itself. UpdateExplore is the local player's own per-frame reveal and nothing else.
    ///
    /// THE RADIUS IS QUANTISED, so these knobs move in steps rather than smoothly, and both config
    /// descriptions say so. Explore rounds the metres up to whole fog pixels before it walks them:
    ///
    ///   47175:  public int m_textureSize = 256;
    ///   47177:  public float m_pixelSize = 64f;
    ///   48519:  private void Explore(Vector3 p, float radius)
    ///   48521:      int num = (int)Mathf.Ceil(radius / m_pixelSize);
    ///   48525:      for (int i = py - num; i &lt;= py + num; i++)          // (2*num+1)^2 pixels
    ///
    /// So vanilla's 100 m is ceil(100/64) = 2, x2 is ceil(200/64) = 4, and x5 is ceil(500/64) = 8.
    /// The two defaults land on clean separate steps, which is worth knowing about rather than
    /// design: every multiplier from 1.0 to 1.28 also yields 2 and is a silent no-op. It also bounds
    /// the cost: 5x5 pixels a tick at vanilla, 9x9 at x2, 17x17 at x5, once every
    /// m_exploreInterval = 2 s. Even the x5 case is 289 pixel tests twice a second, which is
    /// nothing next to what the map already redraws.
    ///
    /// COEXISTENCE WITH VALHEIMPLUS. V+ patches the SAME method with a prefix
    /// (Minimap_Patches.ChangeMapBehavior). Reading its decompile, that prefix does not touch
    /// <c>m_exploreRadius</c> at all: it issues its own extra <c>Explore</c> calls passing
    /// <c>Configuration.Current.Map.exploreRadius</c>, and it returns void, so vanilla's own body
    /// still runs afterwards with the field. So the two never write the same storage, our multiply
    /// lands on vanilla's call whichever order Harmony picks, and V+'s [Map] exploreRadius keeps
    /// doing exactly what it did. (That V+ key is a no-op on this server anyway: it is set to 100,
    /// which is the vanilla field value. See the note at the top of src/VPlusFallbackPatch.cs.)
    ///
    /// SAILING. Vanilla's own "am I on a boat" test is a PAIR, not one call —
    /// <c>Character.CalculateLiquidDepth</c> at line 9889 reads
    ///
    ///   if (IsTeleporting() || GetStandingOnShip() != null || IsAttachedToShip())
    ///
    /// and both halves are public:
    ///
    ///   21396:  public override bool IsAttachedToShip()      // Player: m_attached &amp;&amp; m_attachedToShip
    ///   9222:   public Ship GetStandingOnShip()              // Character: InNumShipVolumes, IsOnGround,
    ///                                                       //            m_lastGroundBody.GetComponent&lt;Ship&gt;()
    ///
    /// <c>IsAttachedToShip()</c> ALONE IS NOT ENOUGH and that is worth spelling out, because it is
    /// the obvious single call to reach for. It is true only while the player is bound to an attach
    /// point — at the helm, or sat in a ship's chair (AttachStart is called with onShip = true, and
    /// it is the only thing that sets m_attachedToShip). A viking standing on the deck of a moving
    /// longship is NOT attached; for them the true signal is GetStandingOnShip(), which resolves the
    /// Rigidbody they are standing on and asks it for a Ship component. Using vanilla's own pair
    /// covers the helmsman and the crew alike, which is what "while sailing" has to mean for a crew
    /// that shares one boat.
    ///
    /// NOT PROVEN HERE: nothing in this repo runs the game, so "the deck reads as sailing" is an
    /// argument from the decompile, not an observation. The boot line and the per-change log line
    /// below are there so one trip out of the harbour settles it.
    ///
    /// NOTE: no System.ValueTuple anywhere in this file — see the warning above BindSurface(...) in
    /// EilifPathsPlugin.cs. The game's net462 Mono runtime ships no ValueTuple and a reference to it
    /// makes the plugin fail to load SILENTLY.
    /// </summary>
    internal static class Exploration
    {
        internal const string Section = "Exploration";

        internal const float DefaultOnFoot = 2f;
        internal const float DefaultSailing = 5f;

        internal static ConfigEntry<bool> Enabled;
        internal static ConfigEntry<float> OnFootMultiplier;
        internal static ConfigEntry<float> SailingMultiplier;

        internal static void Bind(ConfigFile config)
        {
            Enabled = config.Bind(Section, "enabled", true,
                "Widen the circle of map the game uncovers around you as you travel. false = vanilla " +
                "discovery radius, and no hook is applied to it at all. Client-side: it changes your " +
                "own map, nobody else's.");

            OnFootMultiplier = config.Bind(Section, "onFootMultiplier", DefaultOnFoot,
                "How much wider the discovery circle is while you are NOT on a ship: walking, running, " +
                "riding, swimming. 1 = vanilla (100 m in this build), 2 = the Eilif default, i.e. " +
                "twice as far. This also sets how much map the [VPlusFallback] ShareExploration " +
                "pass reveals around each other viking, so a crew mate's circle matches your own. " +
                "THIS KNOB MOVES IN STEPS, NOT SMOOTHLY: the game uncovers whole 64 m fog pixels " +
                "(ceil(radius / 64)), so vanilla 100 m is 2 pixels, 2 is 4 and 5 is 8. Every value " +
                "from 1 to 1.28 rounds to the same 2 pixels and changes nothing at all. If a small " +
                "increase looks like it did nothing, it did nothing: go up a whole step.");

            SailingMultiplier = config.Bind(Section, "sailingMultiplier", DefaultSailing,
                "How much wider the discovery circle is while you are on a ship, at the helm or " +
                "standing on the deck. 1 = vanilla, 5 = the Eilif default, i.e. five times as far, " +
                "so one coastal run charts a wide band of sea. Set it equal to onFootMultiplier to " +
                "stop treating sailing specially. Steps in whole 64 m fog pixels, same as onFootMultiplier: " +
                "see the note there before you retune it by a tenth.");
        }

        /// <summary>Sanitises one knob: anything that is not a usable positive number reads as 1
        /// (vanilla). Same shape as EilifPathsPlugin.Mult — these are read from inside a patch body
        /// that Valheim runs every frame, and Harmony does NOT swallow an exception out of a patch.
        /// </summary>
        private static float Safe(ConfigEntry<float> entry)
        {
            if (entry == null) return 1f;
            float v = entry.Value;
            if (float.IsNaN(v) || float.IsInfinity(v) || !(v > 0f)) return 1f;
            return v;
        }

        internal static bool Active
        {
            get
            {
                try { return Enabled != null && Enabled.Value; }
                catch { return false; }
            }
        }

        /// <summary>
        /// Vanilla's own on-a-boat test, both halves of it (Character.cs:9889). True at the helm, in
        /// a ship's chair, and standing on the deck.
        ///
        /// CALLED EVERY FRAME, and that is affordable. IsAttachedToShip is two field reads.
        /// GetStandingOnShip short-circuits on `InNumShipVolumes == 0` before it reaches
        /// `m_lastGroundBody.GetComponent&lt;Ship&gt;()` (lines 9222-9236), so the only GetComponent
        /// happens when the player is standing inside a ship's volume, which is the case this
        /// feature exists for. Vanilla itself pays that same call once per PHYSICS tick from
        /// Character.CalculateLiquidDepth, i.e. more often than this does.
        /// </summary>
        internal static bool IsSailing(Player player)
        {
            try
            {
                if (player == null) return false;
                if (player.IsAttachedToShip()) return true;
                return player.GetStandingOnShip() != null;
            }
            catch { return false; }
        }

        /// <summary>The multiplier for the local player right now. 1 whenever the section is off, the
        /// player is gone, or a knob is unusable.</summary>
        internal static float MultiplierFor(Player player)
        {
            if (!Active) return 1f;
            return IsSailing(player) ? Safe(SailingMultiplier) : Safe(OnFootMultiplier);
        }

        /// <summary>
        /// The multiplier the [VPlusFallback] ShareExploration pass applies around OTHER players.
        /// Always the ON-FOOT one, never the sailing one: ZNet.PlayerInfo carries a name, a position
        /// and a public-position flag, and nothing that says whether the viking at the far end of
        /// that Vector3 is standing on a deck or on a beach. On foot is the smaller of the two, so
        /// it is the conservative answer as well as the only knowable one.
        /// </summary>
        internal static float SharedMultiplier()
        {
            if (!Active) return 1f;
            return Safe(OnFootMultiplier);
        }

        internal static string Describe()
        {
            if (!Active) return "vanilla";
            return "x" + F(Safe(OnFootMultiplier)) + " on foot, x" + F(Safe(SailingMultiplier)) + " sailing";
        }

        private static string F(float v) => v.ToString("0.##", CultureInfo.InvariantCulture);

        // ---- Diagnostics ---------------------------------------------------------------------
        //
        // One Info line each time the local player crosses between "on a ship" and "not on a ship",
        // never per frame. That is the line that settles the deck question in-game (see the class
        // doc): step onto a moving longship and it must say sailing.

        private static bool _lastSailing;
        private static bool _lastSailingKnown;

        internal static void NoteState(bool sailing, float radiusBefore, float radiusAfter)
        {
            try
            {
                if (_lastSailingKnown && _lastSailing == sailing) return;
                _lastSailingKnown = true;
                _lastSailing = sailing;
                if (EilifPathsPlugin.Log == null) return;
                EilifPathsPlugin.Log.LogInfo(
                    "[EilifPaths] map discovery: " + (sailing ? "sailing" : "on foot") + " (" +
                    F(radiusBefore) + "m -> " + F(radiusAfter) + "m).");
            }
            catch { /* diagnostics must never affect the patch */ }
        }
    }

    /// <summary>
    /// Prefix + FINALIZER on the private instance method <c>Minimap.UpdateExplore(float, Player)</c>.
    /// The prefix multiplies this Minimap's <c>m_exploreRadius</c>; the finalizer restores it.
    ///
    /// FINALIZER, NOT POSTFIX, and it is the same lesson Patch_UpdateWalking carries. m_exploreRadius
    /// is real, shared component state that the prefix temporarily inflates, and Harmony SKIPS
    /// postfixes when the original method throws. One throw inside Minimap.UpdateExplore with a
    /// postfix restore would leave the field at 200 (or 500) for the session, and the next frame
    /// would multiply the multiplied value again: 100 -&gt; 200 -&gt; 400 -&gt; 800, compounding every
    /// frame until the pixel loop in Explore is walking a radius of thousands of metres. A finalizer
    /// runs on both paths and returns void, so the original exception is rethrown untouched.
    ///
    /// THE GUARD IS <c>&gt; 0f</c>, NOT JUST <c>!IsNaN</c>, for the reason spelled out in full on
    /// Patch_UpdateWalking.Finalizer: HarmonyManipulator.WriteFinalizers opens its try block ABOVE
    /// the prefixes, so a THIRD-PARTY prefix that throws before ours runs still lands here with
    /// __state left at the zero-initialised local rather than at the NaN sentinel. Restoring that
    /// zero would pin the discovery radius at 0 for the session and it would not self-heal, because
    /// the next frame would capture 0 and multiply 0. A genuine captured radius is always positive.
    ///
    /// It takes NO original parameters. Harmony injects those by NAME, so a prefix declaring
    /// <c>Player player</c> stops applying the day Iron Gate renames that argument — and the reveal
    /// is always around <c>Player.m_localPlayer</c> anyway (Minimap.Update is UpdateExplore's only
    /// caller, line 47541). One fewer name to be right about at the 1.0 rebuild.
    /// </summary>
    [HarmonyPatch(typeof(Minimap), "UpdateExplore", new Type[] { typeof(float), typeof(Player) })]
    internal static class Patch_Minimap_UpdateExplore
    {
        // __state stays at the NaN sentinel on every path that does NOT write the field, and is
        // assigned STRICTLY BEFORE the write on the one path that does. So the finalizer restores
        // if and only if this prefix actually changed something.
        //
        // That is deliberately narrower than Patch_UpdateWalking, which captures and restores
        // unconditionally. m_exploreRadius is a field another map mod could plausibly want to SET
        // for real, and a finalizer runs after every postfix — restoring a value we never touched
        // would silently undo their write once a frame. Nothing on m_walkSpeed has that shape.
        private static void Prefix(Minimap __instance, out float __state)
        {
            __state = float.NaN; // sentinel: nothing to restore
            try
            {
                if (__instance == null) return;
                if (!Exploration.Active) return;

                Player player = Player.m_localPlayer;
                if (player == null) return;

                float baseRadius = __instance.m_exploreRadius;
                bool sailing = Exploration.IsSailing(player);
                float mult = Exploration.MultiplierFor(player);
                if (mult == 1f) { Exploration.NoteState(sailing, baseRadius, baseRadius); return; }

                float widened = baseRadius * mult;
                if (float.IsNaN(widened) || float.IsInfinity(widened) || !(widened > 0f)) return;

                __state = baseRadius;   // captured BEFORE the write; the finalizer now has work
                __instance.m_exploreRadius = widened;
                Exploration.NoteState(sailing, baseRadius, widened);
            }
            catch { /* vanilla radius; the finalizer still restores whatever was captured */ }
        }

        private static void Finalizer(Minimap __instance, float __state)
        {
            try
            {
                if (__instance == null) return;
                if (float.IsNaN(__state) || __state <= 0f) return; // sentinel, or a prefix that never ran
                __instance.m_exploreRadius = __state;
            }
            catch { /* a patch body must never throw into game code */ }
        }
    }
}
