# Staged, NOT uploaded — Charlie's call

`../EilifCompanionClient-0.3.0.zip` is built and ready. Nothing has been uploaded to
Thunderstore: the live listing is still **0.2.0** (published 2026-08-23) and pack v11 pins
0.2.0, so the tombstone keep-list is currently dark for every player.

Staged 2026-09-04 by the T−6 launch-audit follow-up (finding plugins-3).

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
2. Upload `../EilifCompanionClient-0.3.0.zip` to the **Eilif** team on Thunderstore.
3. **Wait for the listing index** before minting a pack that pins the new version — r2modman
   resolves pinned versions against the index, not the upload.
4. Re-mint the pack, publish the new code on Get Started / Mods, and update `config/mods.ts`.

The full-disclosure README style in this package is the one that got 0.1.1 and 0.2.0 approved
after two earlier rejections — keep the gameplay-change paragraph in any future edit, it is the
part that matters for approval.

## Before players see it

The keep-list has **not** been exercised on a live server yet (the audit was read-only and forced
no deaths). One deliberate death on a `deathkeepequip` world from a profile carrying this DLL,
confirming `[EilifDeath] tombstone keep-list spared N item(s)` in `LogOutput.log` and what
actually stayed in the inventory, is the test that should happen before or during Session Zero.
