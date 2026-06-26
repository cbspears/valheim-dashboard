// Pure message formatting — no Discord/Supabase deps, so it can run under
// --dry-run and be unit-tested. Each function returns a payload shape the
// poster understands: { content?, embeds?: object[], mentionEveryone?: boolean }.

export const GOLD = 0xc8952a;
const FOOTER = 'Eilif · The Cozy Canon Playthrough';

function str(meta, key) {
  const v = meta?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// --- Leaderboard helpers (deaths board + Player of the Day) ----------------

// Escape Discord markdown specials so a name like "Bj*rn" can't break layout.
function escapeMd(s) {
  return String(s).replace(/([*_`~])/g, '\\$1');
}
// Defensive 24-char cap (keeps us well under embed field limits) + escaping.
function nameMd(s) {
  const t = String(s);
  return escapeMd(t.length > 24 ? t.slice(0, 24) : t);
}

// Norse-flavored POTY blurbs, keyed by category. Index 0 of EVERY category uses
// only always-present fields, so the missing/zero guard can always fall back to
// it. Placeholders: {name} {boss} {biome} {deaths} {cause} {hours} {kills}
// {resources} {items} {newBiome}. {boss}/{biome}/{newBiome} are pre-bolded here.
const POTY_TEMPLATES = {
  boss_kill: [
    '{name} stood over **{boss}** as the **{biome}** fell silent — skål to the one who came home dripping and grinning.',
    'The **{biome}** bows: {name} put **{boss}** in the dirt and walked back into the hall a legend.',
    '**{boss}** is no more, and {name} was there at the kill — tonight the mead is on the gods.',
    '{name} bled {deaths} times wrestling **{boss}** down, then took its head anyway. The saga writes itself.',
  ],
  most_explored: [
    '{name} put their prow into the **{newBiome}** for the first time and lived to tell it — new horizons, new ways to be eaten.',
    'The map grew today: {name} set boots in the **{newBiome}** where no clansman had walked. Bold sail, viking.',
    '{name} crossed into the **{newBiome}** and the unknown blinked first. Fortune favors the prow that points outward.',
  ],
  most_deaths: [
    '{name} found {deaths} fresh ways to die and laughed at every one. Reckless, doomed, glorious.',
    '{name} met the void {deaths} times this day — the last when {name} {cause}. The Allfather keeps a stool warm.',
    "{deaths} tombstones bear {name}'s name tonight — Valhalla's doorman knows them by sight now.",
    'Death came {deaths} times for {name}; {name} {cause}, then sailed back for more. Mad. Magnificent.',
  ],
  most_kills: [
    '{name} cut down {kills} foes today — the crows of the realm follow them now, fat and grateful.',
    "{kills} beasts fell to {name}'s blade. The forest learned a name to fear.",
    '{name} left {kills} corpses in their wake and barely broke a sweat. Skål to the storm with an axe.',
  ],
  most_resources: [
    "{name} hauled {resources} of the realm's bounty home — the storehouse sings their name.",
    '{name} gathered {resources} while the saga rested. Cozy and unstoppable.',
    '{name} stripped {resources} from the land today, hauling like a draugr with a grudge. The longhouse eats well.',
  ],
  most_crafted: [
    '{name} bent {items} works from anvil and flame today — even Brokkr the dwarf would nod.',
    'The forge never cooled for {name}: {items} pieces hammered true. The clan walks better-armed.',
    "{items} blades, nails, and trinkets left {name}'s anvil this day. A smith of true worth.",
  ],
  most_hours: [
    '{name} held the hall for {hours}h while the rest slept — no glory, just the patient hammer of a true builder.',
    '{name} kept the longfire burning {hours}h. Devotion is its own kind of saga.',
    '{hours} hours of honest toil from {name} today. The longhouse grows because someone refuses to rest.',
  ],
  // Unsung Hero (underdog spotlight). Every blurb uses ONLY {name} — a quiet
  // viking may have ~0 of every stat, so these must never reach for one.
  underdog: [
    'Not every saga is loud — {name} kept the longfire lit and the hall warm tonight. Skål to the steady ones.',
    'The clan raises a horn to {name}: fewer hours, no less heart. Every viking’s name belongs in the saga.',
    '{name} sailed in for a spell and left the realm brighter for it. The gods may not have noticed — the hall did.',
    'Tonight the hall toasts {name}, who shows up, hammer in hand, and asks for no glory. That’s its own kind of legend.',
  ],
};

// Small, pure 31-multiplier string hash (stable across runs).
function hashString(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

// "☠️/💀 **Name** — **TOTAL** (+N)" lines, top 5. Returns '' when empty.
function renderDeathsBoard(board) {
  const rows = (board || []).slice(0, 5);
  if (!rows.length) return '';
  return rows
    .map((row, i) => {
      const marker = i === 0 ? '☠️' : '💀';
      const suffix = row.delta > 0 ? ` (+${row.delta})` : '';
      return `${marker} **${nameMd(row.name)}** — **${row.total}**${suffix}`;
    })
    .join('\n');
}

// Deterministically pick + fill a POTY blurb from poty.{key,name,fields,seed}.
function renderPotyBlurb(poty) {
  const templates = POTY_TEMPLATES[poty.key] || [];
  if (!templates.length) return '';
  const f = poty.fields || {};
  // raw values drive the missing/zero guard; disp values are substituted in.
  const raw = {
    name: poty.name,
    boss: f.boss, biome: f.biome, deaths: f.deaths, cause: f.cause,
    hours: f.hours, kills: f.kills, resources: f.resources, items: f.items,
    newBiome: f.newBiome,
  };
  const intStr = (v) => (v == null ? '' : Math.round(v).toLocaleString());
  const disp = {
    name: `**${nameMd(poty.name)}**`,
    boss: f.boss ? escapeMd(f.boss) : '',
    biome: f.biome ? escapeMd(f.biome) : '',
    deaths: f.deaths != null ? String(f.deaths) : '',
    cause: f.cause ? escapeMd(f.cause) : '',
    hours: f.hours != null ? Number(f.hours).toFixed(1) : '',
    kills: intStr(f.kills),
    resources: intStr(f.resources),
    items: intStr(f.items),
    newBiome: f.newBiome ? escapeMd(f.newBiome) : '',
  };

  let idx = (hashString(poty.name) + (poty.seed || 0)) % templates.length;
  let tpl = templates[idx];
  // GUARD: any placeholder whose raw value is missing/zero -> fall back to [0].
  const ok = (tpl.match(/\{(\w+)\}/g) || []).every((token) => {
    const v = raw[token.slice(1, -1)];
    if (v === undefined || v === null || v === '') return false;
    if (typeof v === 'number' && v === 0) return false;
    return true;
  });
  if (!ok) tpl = templates[0];

  return tpl.replace(/\{(\w+)\}/g, (_, k) => (disp[k] != null ? disp[k] : ''));
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
 *           bossKills:string[], onlineNow, worldDay, quiet:boolean,
 *           deathsBoard:{name,total,delta}[], poty:{key,label,name,fields,seed}|null }
 * The deaths board renders in BOTH recaps; POTY only in the evening when present.
 * Both extras live in the non-quiet branch only.
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

  const fields = [
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
  ];

  // Cumulative deaths leaderboard — both recaps. Omitted when nobody's fallen.
  const board = renderDeathsBoard(stats.deathsBoard);
  if (board) fields.push({ name: '💀 Hall of the Fallen', value: board, inline: false });

  // Player of the Day — evening only, when a crown was earned. The blurb already
  // leads with the (bolded) name, so the value is just the blurb; the award
  // category rides in the field title.
  if (!morning && stats.poty) {
    fields.push({
      name: `🏆 Player of the Day · ${stats.poty.label}`,
      value: renderPotyBlurb(stats.poty),
      inline: false,
    });
  }

  return {
    embeds: [
      {
        title,
        description: morning
          ? 'Deeds from the long night:'
          : 'The day’s saga, before the fires dim:',
        color: GOLD,
        fields,
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
