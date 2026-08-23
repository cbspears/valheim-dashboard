# Eilif Companion Client

Companion plugin for the **Eilif** community Valheim server, a private friends-and-family server with a public stats dashboard at [valheim-dashboard.vercel.app](https://valheim-dashboard.vercel.app).

## What it does — full disclosure

While you are connected to a server, this plugin sends two kinds of data to the Eilif community dashboard, and nothing else:

1. **Explored-map percentage**: one number read from your own local map data, posted with your character name every 5 minutes and at logout. Feeds the Cartographer leaderboard.
2. **Your own deaths** (new in 0.2.0): when your character dies, the plugin reads the game's own record of the killing blow (its hit type, such as Fall, Drowning or Burning, and the attacking creature's name if there was one) plus the biome, and posts that single event. This exists because the death causes from other stats mods are often wrong, and the Eilif dashboard shows honest ones.

- **Never sent:** position history, chat, inventory, skills, system information, or anything about other players.
- **Where:** only to the endpoint in `net.eilif.companionclient.cfg`. The Eilif modpack pre-fills the community dashboard URL. **With no URL configured the plugin does nothing at all.**
- **Source:** fully open on [GitHub](https://github.com/cbspears/valheim-dashboard/tree/main/plugins/eilif-companion-client).

Intended for members of the Eilif server; harmless but useless anywhere else.

## Changelog
See CHANGELOG.md.
