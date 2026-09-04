# Eilif Companion Client

Companion plugin for the **Eilif** community Valheim server, a private friends-and-family server with a public stats dashboard at [valheim-dashboard.vercel.app](https://valheim-dashboard.vercel.app).

## What it does — full disclosure

While you are connected to a server, this plugin sends two kinds of data to the Eilif community dashboard, and nothing else:

1. **Explored-map percentage**: one number read from your own local map data, posted with your character name every 5 minutes and at logout. Feeds the Cartographer leaderboard.
2. **Your own deaths** (since 0.2.0): when your character dies, the plugin reads the game's own record of the killing blow (its hit type, such as Fall, Drowning or Burning, and the attacking creature's name if there was one) plus the biome, and posts that single event. This exists because the death causes from other stats mods are often wrong, and the Eilif dashboard shows honest ones.

- **Never sent:** position history, chat, inventory, skills, system information, or anything about other players.
- **Where:** only to the endpoint in `net.eilif.companionclient.cfg`. The Eilif modpack pre-fills the community dashboard URL. **With no URL configured the plugin sends nothing at all.**
- **Source:** fully open on [GitHub](https://github.com/cbspears/valheim-dashboard/tree/main/plugins/eilif-companion-client).

## It also changes one gameplay rule — read this before installing (new in 0.3.0)

Version 0.3.0 adds a **client-side tombstone keep-list**, and it is the only part of this plugin that touches gameplay rather than just reporting on it.

Valheim decides what goes into your tombstone on **your own machine**, in `Inventory.MoveInventoryToGrave`, which spares quest items and whatever you had equipped. This plugin adds a Harmony **prefix** on that method which briefly marks keep-listed items as equipped so the game's own filter spares them, and a **finalizer** that unmarks them immediately afterwards — the flag never outlives that single call, and if the patch ever fails to apply you simply get exact vanilla behaviour. The result: your tools, weapons, shield, torch and ammo stay on you when you die, while resources, food and loot still drop into the grave, so a death stays a corpse run without becoming a re-gearing chore.

**It is gated on the server, not on you.** The patch only does anything on a world whose vanilla `deathkeepequip` global key is set — the key the Casual death-penalty tier grants (and which the Eilif server also asserts through its server-side companion plugin). On any server that has not opted into gentle deaths, including every public server you might carry this profile onto, the keep-list is inert and your deaths are exactly vanilla.

The list is yours to change, in `net.eilif.companionclient.cfg` under `[Death]`:

```ini
[Death]
KeepItemTypes = OneHandedWeapon, TwoHandedWeapon, TwoHandedWeaponLeft, Bow, Shield, Torch, Tool, Ammo, AmmoNonEquipable
```

Those are `ItemDrop.ItemData.ItemType` names. **Blank the value to turn the feature off entirely** and get vanilla tombstones back even on a `deathkeepequip` world.

Intended for members of the Eilif server; harmless but useless anywhere else.

## Changelog
See CHANGELOG.md.
