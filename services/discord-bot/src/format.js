// Pure message formatting — no Discord/Supabase deps, so it can run under
// --dry-run and be unit-tested. Each function returns a payload shape the
// poster understands: { content?, embeds?: object[], mentionEveryone?: boolean }.

export const GOLD = 0xc8952a;
const FOOTER = 'Eilif · The Cozy Canon Playthrough';

function str(meta, key) {
  const v = meta?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Compact one-line feed messages for #server.
 * Returns null for event types the feed should ignore (chat, boss, unknown).
 */
export function formatFeedEvent(event) {
  const name = event.character_name || 'A viking';
  const meta = event.metadata || {};
  switch (event.type) {
    case 'join':
      return { content: `🛡️ **${name}** entered the realm` };
    case 'leave':
      return { content: `🚪 **${name}** left the realm` };
    case 'death': {
      const cause = str(meta, 'cause');
      return { content: cause ? `💀 **${name}** ${cause}` : `💀 **${name}** has fallen` };
    }
    case 'raid':
      return { content: `⚔️ ${str(meta, 'event') || 'A raid has begun'}` };
    default:
      return null; // chat / boss / sync / anything else: not for the feed
  }
}

/** Big @everyone embed for #valheim when a boss is felled for the first time. */
export function formatBossKill(boss) {
  const fields = [];
  if (Array.isArray(boss.players_present) && boss.players_present.length > 0) {
    fields.push({ name: '⚔️ War party', value: boss.players_present.join(', ') });
  }
  if (boss.notes) {
    fields.push({ name: '📜 Notes', value: boss.notes });
  }
  return {
    content: '@everyone',
    mentionEveryone: true,
    embeds: [
      {
        title: `👑 ${boss.name} has fallen!`,
        description: `The **${boss.biome}** bows to the clan. A new region opens — sail on, vikings.`,
        color: GOLD,
        fields,
        footer: { text: FOOTER },
      },
    ],
  };
}

/**
 * Daily recap embed for #valheim (no ping).
 * stats = { period:'morning'|'evening', playersActive, hoursPlayed, deaths,
 *           bossKills:string[], onlineNow, worldDay, quiet:boolean }
 */
export function formatRecap(stats) {
  const morning = stats.period === 'morning';
  const title = morning ? '🌅 Morning, vikings' : '🌙 The hall winds down';

  if (stats.quiet) {
    return {
      embeds: [
        {
          title,
          description:
            'A quiet stretch in the realm — no deeds recorded. The mead halls rest. ' +
            `Day **${stats.worldDay}**, **${stats.onlineNow}** sailing now.`,
          color: GOLD,
          footer: { text: FOOTER },
        },
      ],
    };
  }

  return {
    embeds: [
      {
        title,
        description: morning
          ? 'Deeds from the long night:'
          : 'The day’s saga, before the fires dim:',
        color: GOLD,
        fields: [
          { name: 'Vikings active', value: `${stats.playersActive}`, inline: true },
          { name: 'Hours logged', value: `${stats.hoursPlayed.toFixed(1)}h`, inline: true },
          { name: 'Deaths', value: `${stats.deaths}`, inline: true },
          {
            name: 'Bosses felled',
            value: stats.bossKills.length ? stats.bossKills.join(', ') : '—',
            inline: true,
          },
          { name: 'Online now', value: `${stats.onlineNow}`, inline: true },
          { name: 'World day', value: `${stats.worldDay}`, inline: true },
        ],
        footer: { text: FOOTER },
      },
    ],
  };
}

/** Manual announcement to #valheim with @everyone. */
export function formatAnnouncement(text) {
  return {
    content: `@everyone 📯 ${text}`,
    mentionEveryone: true,
  };
}
