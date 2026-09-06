// Discord connection + a uniform `post(channelKey, payload)` interface.
// Two implementations: the real gateway client, and a dry-run console printer.
import { Client, GatewayIntentBits, Events, Partials, MessageFlags } from 'discord.js';

// Discord's hard limits. Anything longer is rejected outright (a 400), which
// would otherwise stall whichever loop was posting it, so we trim instead.
const MAX_CONTENT = 2000;
const MAX_EMBED_DESCRIPTION = 4096;
const MAX_EMBED_TITLE = 256;
const MAX_EMBED_FIELDS = 25;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_FOOTER = 2048;
const MAX_AUTHOR_NAME = 256;
// The API's ceiling is 6000 across title + description + footer + author +
// every field name and value. We stop short of it so a formatter that is a few
// characters optimistic still lands.
const MAX_EMBED_TOTAL = 5900;

function clip(s, max) {
  if (typeof s !== 'string' || s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * THE GATE THIS TIGHTENS (red-team round 2, 2026-09-05). Every message handler
 * in this bot opens with "did this message name me?" and spells it
 * `message.mentions.has(client.user)`. That is a much looser question than it
 * reads. discord.js MessageMentions#has (node_modules/discord.js/src/structures/
 * MessageMentions.js:260) answers true when:
 *   - the message contains a live @everyone, whoever sent it;
 *   - the message is a REPLY to any message the bot posted, with the reply ping
 *     left on (Discord's default) and no @mention typed anywhere;
 *   - the message mentions any ROLE the bot's member happens to hold.
 *
 * With CHANNEL_GALLERY unset the ingest accepts any channel in the guild, so
 * "reply to one of Eilif's own #server feed lines with a screenshot" published
 * that image to the public /gallery page — no mention, no gallery channel, and
 * nothing that looks like an attack in the channel log. The same gate guards
 * identity claims, the oath ingest and the voice puppet.
 *
 * These three options reduce it to what every module's header already claims:
 * a real `<@botid>` typed in the content. Verified against the real class: an
 * explicit mention still passes, @everyone / reply-ping / role-mention do not.
 */
export const MENTION_STRICT = { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true };

/**
 * THE UNFURL THIS CLOSES (red-team round 2, 2026-09-05). Player-typed text
 * reaches #server as plain message content — a character name in a join line, a
 * death cause, a raid label — and none of it is escaped against being a URL,
 * because `:` `/` and `.` are not markdown. A forged death whose cause was
 * `https://…` (the ingest paths that write it carry no token) made the bot post
 * a live link, and Discord rendered the ATTACKER'S preview card under it.
 *
 * format.js defangs the text; this is the second lock, at the one place every
 * loop posts through. `SUPPRESS_EMBEDS` tells Discord to render no embeds at
 * all for the message — which is exactly right for a content-only line and
 * exactly wrong for one of ours, so it is only ever set when the payload
 * carries no embeds of its own. Nothing this bot posts as bare content wants an
 * unfurl (checked: the only literal URLs in the source are the ollama and
 * titles API endpoints, neither of which is ever posted).
 */
function suppressUnfurls(embeds) {
  return embeds.length === 0 ? { flags: MessageFlags.SuppressEmbeds } : {};
}

/**
 * THE BACKSTOP (red-team, 2026-09-05). Every embed limit below is enforced HERE,
 * at the one place every loop posts through, not only in the formatters.
 *
 * The bug this closes: `formatBossKill` put the war party into an embed field
 * with no cap, and the war party is `bosses.fight_stats.fighters` /
 * `players_present` — character names, which the game lets a player choose and
 * which reach the table through ingest paths that carry no token. One viking
 * with a long enough name pushed that field past 1024 chars, Discord answered
 * 400, `bosses.tick()` threw BEFORE marking the boss announced, and the
 * @everyone first-kill announcement was wedged: it re-threw on every 30s tick
 * and never posted. Formatters are still the right place to truncate WELL (see
 * format.js), but a formatter can only protect the surface it knows about;
 * this protects every surface, including the next one somebody adds.
 *
 * Returns a new embed object; the caller's is never mutated.
 */
export function clampEmbed(embed) {
  if (!embed || typeof embed !== 'object') return embed;
  const out = { ...embed };
  if (typeof out.title === 'string') out.title = clip(out.title, MAX_EMBED_TITLE);
  if (typeof out.description === 'string') out.description = clip(out.description, MAX_EMBED_DESCRIPTION);
  if (out.footer && typeof out.footer.text === 'string') {
    out.footer = { ...out.footer, text: clip(out.footer.text, MAX_FOOTER) };
  }
  if (out.author && typeof out.author.name === 'string') {
    out.author = { ...out.author, name: clip(out.author.name, MAX_AUTHOR_NAME) };
  }

  const size = () =>
    (out.title?.length ?? 0) +
    (out.description?.length ?? 0) +
    (out.footer?.text?.length ?? 0) +
    (out.author?.name?.length ?? 0) +
    (out.fields ?? []).reduce((n, f) => n + (f.name?.length ?? 0) + (f.value?.length ?? 0), 0);

  if (Array.isArray(out.fields)) {
    out.fields = out.fields.slice(0, MAX_EMBED_FIELDS).map((f) => ({
      ...f,
      name: clip(String(f?.name ?? ''), MAX_FIELD_NAME),
      // A field with an empty value is a 400 of its own, so an all-whitespace
      // value becomes a visible placeholder rather than a rejected message.
      // 'none' rather than a dash: this string renders in an embed the hall
      // reads, and the copy doctrine bars em/en dashes from player-facing text.
      value: clip(String(f?.value ?? '').trim() || 'none', MAX_FIELD_VALUE),
    }));
    // Still over the whole-embed ceiling: drop fields from the END (the boards
    // and extras) so the headline title/description always survive.
    while (out.fields.length > 0 && size() > MAX_EMBED_TOTAL) out.fields.pop();
  }
  // Nothing left to drop and still over: the description is the only thing big
  // enough to be the culprit.
  if (size() > MAX_EMBED_TOTAL && typeof out.description === 'string') {
    const room = MAX_EMBED_TOTAL - (size() - out.description.length);
    out.description = clip(out.description, Math.max(1, room));
  }
  return out;
}

/**
 * Connect to Discord and resolve the target channels.
 * @param {object} opts
 * @param {string} opts.token
 * @param {Record<string,string>} opts.channels  key -> channelId (e.g. {server, valheim})
 */
export async function createDiscordPoster({ token, channels }) {
  // All non-privileged intents:
  //  - GuildScheduledEvents: read the server's scheduled events ("Coming Up").
  //  - GuildMessages: receive messages so the gallery can ingest photos that
  //    @mention the bot (mentions exempt us from the Message Content intent).
  //  - GuildMessageReactions: receive reactions so an admin can trash a
  //    gallery photo with a 🗑️ react (gallery.js).
  // Partials for Message/Reaction/User so those reaction events still resolve
  // when the message isn't in the cache (e.g. after a restart).
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildScheduledEvents,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });

  const ready = new Promise((resolve, reject) => {
    client.once(Events.ClientReady, (c) => resolve(c));
    client.once(Events.Error, reject);
  });

  // Gateway flaps used to leave no trace in the journal; these four lines are
  // the whole post-mortem trail for "the bot went quiet for ten minutes".
  client.on(Events.ShardDisconnect, (event, id) =>
    console.warn(`[discord] shard ${id} disconnected (code ${event?.code ?? '?'})`)
  );
  client.on(Events.ShardError, (error, id) =>
    console.error(`[discord] shard ${id} error: ${error?.message ?? error}`)
  );
  client.on(Events.ShardReconnecting, (id) => console.warn(`[discord] shard ${id} reconnecting`));
  client.on(Events.ShardResume, (id, replayed) =>
    console.log(`[discord] shard ${id} resumed, ${replayed} event(s) replayed`)
  );

  try {
    await client.login(token);
  } catch (err) {
    throw new Error(`Discord login failed (bad token?): ${err.message}`);
  }
  const me = await ready;
  console.log(`[discord] logged in as ${me.user.tag}`);

  const resolved = {};
  for (const [key, id] of Object.entries(channels)) {
    // An unset env var used to reach client.channels.fetch(undefined) and come
    // back as the same "not found — is the bot invited?" error, which sends the
    // reader to Discord's permission screens instead of to the .env line they
    // just edited. Cutover step 8 rewrites exactly these vars.
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error(
        `channel "${key}" has no id — set CHANNEL_${key.toUpperCase()} in services/discord-bot/.env`
      );
    }
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch) {
      throw new Error(
        `channel "${key}" (${id}) not found — is the bot invited to the server and able to see it?`
      );
    }
    resolved[key] = ch;
    console.log(`[discord] #${key} -> ${ch.name ?? id}`);
  }

  const post = async (channelKey, payload) => {
    const ch = resolved[channelKey];
    if (!ch) throw new Error(`unknown channel key "${channelKey}"`);
    const embeds = (payload.embeds || []).map(clampEmbed);
    await ch.send({
      content: clip(payload.content, MAX_CONTENT),
      embeds,
      // Only ever ping @everyone when explicitly asked; otherwise suppress all
      // mentions so a stray "@name" in chat can't ping the server.
      allowedMentions: payload.mentionEveryone ? { parse: ['everyone'] } : { parse: [] },
      ...suppressUnfurls(embeds),
    });
  };

  return { client, post, destroy: () => client.destroy() };
}

/** Prints what it *would* send. No network, no Discord login. */
export function createDryRunPoster() {
  const post = async (channelKey, payload) => {
    const embedsOut = (payload.embeds || []).map(clampEmbed);
    const out = [
      `\n[dry-run → #${channelKey}]${payload.mentionEveryone ? ' (@everyone)' : ''}` +
        (suppressUnfurls(embedsOut).flags ? ' (link previews suppressed)' : ''),
    ];
    if (payload.content) out.push(`  ${clip(payload.content, MAX_CONTENT)}`);
    // Same clamp the live poster applies, so a rehearsal shows exactly what
    // would go out rather than the pre-truncation draft.
    for (const e of embedsOut) {
      if (e.title) out.push(`  «${e.title}»`);
      if (e.description) out.push(`   ${e.description}`);
      for (const f of e.fields || []) out.push(`   • ${f.name}: ${f.value}`);
    }
    console.log(out.join('\n'));
  };
  return { post, destroy: () => {} };
}
