# Staged, NOT uploaded — Charlie's call

`../EilifCompanionClient-0.3.2.zip` is built and ready. Nothing has been uploaded to
Thunderstore: the live listing is still **0.2.0** (published 2026-08-23) and pack v11 pins
0.2.0, so the tombstone keep-list is currently dark for every player.

Staged 2026-09-04 by the T−6 launch-audit follow-up (finding plugins-3).

## 0.3.2 REPLACES the 0.3.1 package, which replaced 0.3.0 — the upload decision is unchanged

Neither 0.3.0 nor 0.3.1 was ever uploaded, so those version numbers were still free to change;
both staging directories and their zips have been deleted and this directory supersedes them
entirely. What has accumulated since 0.3.0, all from the audit follow-up:

- **`reporter` on the map post** (finding security-4, new in 0.3.2). The cartography POST now
  carries the local character's own name next to the name whose exploration it raises, and
  `/api/gs-ingest` requires the two to match and runs its "are you actually on this server" check
  on the reporter. Without it, anyone who could reach the endpoint could pin any online viking at
  100 % explored — permanently, because the ingest keeps the highest reading — handing out the
  Far-Seer title, the in-game explored board and a collective Great Deed. Same shape as the death
  binding below, applied to the other unauthenticated write.
- **`reporter` on the death report** (finding security-2, 0.3.1). Anyone reaching the endpoint
  could otherwise fabricate a death, with attacker-written cause text, for any viking who
  happened to be online, and it would land in Discord, the Saga and that viking's death log.
- **Per-patch isolation** (finding plugins-6, 0.3.1). Each of the three Harmony hooks is applied
  in its own try/catch and the plugin logs `[EilifDeath] patch classes applied: N/M`. Previously
  one unresolvable target in a game update would abort the rest silently.

Both `reporter` fields are backward compatible: the server still accepts reports and readings
from older clients (it logs one line per serverless instance saying so), so nothing breaks for
anyone still on 0.2.0 while the pack is unminted.

Nothing about the ship-now-vs-fold-into-1.0 decision below changes: it is the same package, one
patch version further on, and the same five-minute upload whenever the call is made.

## The decision

Two options, and the audit recommends the second:

1. **Upload now** → mint pack v12 → players update once this week, then update **again** at
   cutover for the mandatory 1.0 rebuild.
2. **Recommended: fold it into the 1.0 rebuild.** Every BepInEx plugin has to be recompiled
   against the 1.0 assemblies on Sep 9 anyway (there was no PTB build to pre-test against), so
   waiting means **one** Thunderstore upload and **one** pack re-mint on launch day instead of
   two of each. The DLL in this directory would then be replaced by the 1.0-rebuilt one before
   the zip is uploaded.

Either way the package is ready and the disclosure README is written, so the upload itself is a
five-minute job whenever the call is made.

## If uploading

1. Confirm `manifest.json` `version_number` matches the DLL you are shipping (bump if the DLL was
   rebuilt for 1.0 — Thunderstore refuses a re-upload of an existing version number).
2. Upload `../EilifCompanionClient-0.3.2.zip` to the **Eilif** team on Thunderstore.
3. **Wait for the listing index** before minting a pack that pins the new version — r2modman
   resolves pinned versions against the index, not the upload.
4. Re-mint the pack, publish the new code on Get Started / Mods, and update `config/mods.ts`.

The full-disclosure README style in this package is the one that got 0.1.1 and 0.2.0 approved
after two earlier rejections — keep the gameplay-change paragraph in any future edit, it is the
part that matters for approval. The two `reporter` paragraphs in the "full disclosure" list are
part of that: they say plainly that the character name is sent twice and that nothing new is
collected.

## Before players see it

The keep-list has **not** been exercised on a live server yet (the audit was read-only and forced
no deaths). One deliberate death on a `deathkeepequip` world from a profile carrying this DLL,
confirming `[EilifDeath] tombstone keep-list spared N item(s)` in `LogOutput.log` and what
actually stayed in the inventory, is the test that should happen before or during Session Zero.

That same session is the end-to-end test for both `reporter` fields:

- boot: `[EilifDeath] patch classes applied: 3/3` in the client log;
- the death lands on the dashboard with **no** `[gs-ingest] eilif-death accepted WITHOUT a
  reporter` line in the Vercel logs (that line means the payload came from a ≤0.3.0 build);
- after five minutes on the server, a `[EilifMap] posted …%` line with **no**
  `[gs-ingest] client-map accepted WITHOUT a reporter` line beside it (that one means ≤0.3.1).

Both Vercel lines print at most once per serverless instance, so read them as "is anyone still on
an old build", not as a per-request alarm.
