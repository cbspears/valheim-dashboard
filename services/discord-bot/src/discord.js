// Discord connection + a uniform `post(channelKey, payload)` interface.
// Two implementations: the real gateway client, and a dry-run console printer.
import { Client, GatewayIntentBits, Events } from 'discord.js';

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
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildScheduledEvents,
      GatewayIntentBits.GuildMessages,
    ],
  });

  const ready = new Promise((resolve, reject) => {
    client.once(Events.ClientReady, (c) => resolve(c));
    client.once(Events.Error, reject);
  });

  try {
    await client.login(token);
  } catch (err) {
    throw new Error(`Discord login failed (bad token?): ${err.message}`);
  }
  const me = await ready;
  console.log(`[discord] logged in as ${me.user.tag}`);

  const resolved = {};
  for (const [key, id] of Object.entries(channels)) {
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
    await ch.send({
      content: payload.content,
      embeds: payload.embeds,
      // Only ever ping @everyone when explicitly asked; otherwise suppress all
      // mentions so a stray "@name" in chat can't ping the server.
      allowedMentions: payload.mentionEveryone ? { parse: ['everyone'] } : { parse: [] },
    });
  };

  return { client, post, destroy: () => client.destroy() };
}

/** Prints what it *would* send. No network, no Discord login. */
export function createDryRunPoster() {
  const post = async (channelKey, payload) => {
    const out = [`\n[dry-run → #${channelKey}]${payload.mentionEveryone ? ' (@everyone)' : ''}`];
    if (payload.content) out.push(`  ${payload.content}`);
    for (const e of payload.embeds || []) {
      if (e.title) out.push(`  «${e.title}»`);
      if (e.description) out.push(`   ${e.description}`);
      for (const f of e.fields || []) out.push(`   • ${f.name}: ${f.value}`);
    }
    console.log(out.join('\n'));
  };
  return { post, destroy: () => {} };
}
