// Discord ↔ character identity link.
//
//   @Eilif I am <CharacterName>   — claim a viking. Case/diacritic-tolerant
//                                   (chaerlie == Chærlie). One Discord user maps
//                                   to one character at a time; re-declaring is
//                                   how you switch mains.
//   @Eilif who am I               — report the current link (handy for testing).
//
// On a successful claim we write players.discord_user_id + discord_username on
// the matched row, clearing that Discord id from any other row first. Old
// gallery photos re-attach automatically: they already store discord_user_id,
// and the viking page joins photos on it — so no gallery rewrite is needed.
//
// No privileged Message Content intent needed: Discord delivers full content for
// messages that mention the app. Follows the oath/gallery ingest pattern.
//
// Gated behind IDENTITY_LINK (on unless IDENTITY_LINK=0). Degrades gracefully
// before db/2026-07-05_discord_identity.sql is applied (missing-column error →
// an in-tone "not ready yet" reply, nothing crashes).

import { serviceClient } from './supabase.js';

const MISSING_COLUMN = /discord_user_id|discord_username|column .* does not exist|schema cache/i;

// ── name folding (mirrors lib/slug.ts foldName) ─────────────────────────────
// Lowercase, strip diacritics, fold Norse ligatures, drop non-alphanumerics —
// so "Charlie", "Chærlie" and "chaerlie" all fold to the same key.
export function foldName(name) {
  return (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/ð/g, 'd')
    .replace(/þ/g, 'th')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      cur[j + 1] = Math.min(cur[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

// Parse the mention into a command, or null if it isn't one of ours.
//   { kind: 'claim', name } | { kind: 'whoami' }
export function parseIdentity(content, botId) {
  const stripped = (content ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .trim();
  if (/^who\s*(is|am)\s*i\b\??$/i.test(stripped)) return { kind: 'whoami' };
  const m = stripped.match(/^i\s*['’]?\s*am\b\s*[:\-—–]?\s*([\s\S]+)$/i);
  if (m) {
    const name = m[1].trim().replace(/^["“]|["”.!]+$/g, '').trim();
    if (name) return { kind: 'claim', name };
  }
  return null;
}

// Resolve a typed name to a roster viking.
//   exact : identical fold → confident link
//   near  : within a small edit distance → offered as a suggestion, NOT linked
export function matchRoster(name, players) {
  const q = foldName(name);
  if (!q) return { player: null, suggestions: [] };

  const exact = players.find((p) => foldName(p.character_name) === q);
  if (exact) return { player: exact, suggestions: [] };

  // Rank the rest by edit distance on the folded names; offer the closest 1-2
  // that are actually close (≤ 2 edits, or a shared prefix) as "did you mean".
  const scored = players
    .map((p) => ({ p, d: levenshtein(q, foldName(p.character_name)) }))
    .sort((a, b) => a.d - b.d);
  const suggestions = scored
    .filter((s, i) => s.d <= 2 || (i === 0 && foldName(s.p.character_name).startsWith(q.slice(0, 3))))
    .slice(0, 2)
    .map((s) => s.p.character_name);
  return { player: null, suggestions };
}

export function createIdentityLink({ client, log = console }) {
  const db = serviceClient();

  async function fetchPlayers() {
    const { data, error } = await db.from('players').select('id, character_name, discord_user_id');
    if (error) {
      // Pre-migration: discord_user_id column absent → retry without it.
      if (MISSING_COLUMN.test(error.message)) {
        const { data: d2, error: e2 } = await db.from('players').select('id, character_name');
        if (e2) throw new Error(`players: ${e2.message}`);
        return { players: d2 ?? [], ready: false };
      }
      throw new Error(`players: ${error.message}`);
    }
    return { players: data ?? [], ready: true };
  }

  // Link this Discord user to `player`, moving the mapping off any other row.
  async function linkPlayer(player, message) {
    const discordId = message.author.id;
    const username = message.member?.displayName ?? message.author.username;

    const clear = await db
      .from('players')
      .update({ discord_user_id: null, discord_username: null })
      .eq('discord_user_id', discordId)
      .neq('id', player.id);
    if (clear.error && MISSING_COLUMN.test(clear.error.message)) return { ok: false, notReady: true };
    if (clear.error) throw new Error(`clear: ${clear.error.message}`);

    const set = await db
      .from('players')
      .update({ discord_user_id: discordId, discord_username: username })
      .eq('id', player.id);
    if (set.error && MISSING_COLUMN.test(set.error.message)) return { ok: false, notReady: true };
    if (set.error) throw new Error(`set: ${set.error.message}`);
    return { ok: true };
  }

  async function currentLink(message) {
    const { data, error } = await db
      .from('players')
      .select('character_name')
      .eq('discord_user_id', message.author.id)
      .maybeSingle();
    if (error) {
      if (MISSING_COLUMN.test(error.message)) return { notReady: true };
      throw new Error(`whoami: ${error.message}`);
    }
    return { name: data?.character_name ?? null };
  }

  const reply = (message, content) =>
    message.reply({ content, allowedMentions: { repliedUser: false } }).catch(() => {});

  async function handleMessage(message) {
    try {
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user)) return;

      const cmd = parseIdentity(message.content, client.user.id);
      if (!cmd) return;

      if (cmd.kind === 'whoami') {
        const cur = await currentLink(message);
        if (cur.notReady) {
          await reply(message, 'The Hall’s ledgers are still being carved. Ask again shortly.');
        } else if (cur.name) {
          await reply(message, `The Hall knows you as **${cur.name}**.`);
        } else {
          await reply(
            message,
            'The Hall does not yet know you. Speak your name: `@Eilif I am <YourViking>`.'
          );
        }
        return;
      }

      // kind === 'claim'
      const { players } = await fetchPlayers();
      const { player, suggestions } = matchRoster(cmd.name, players);

      if (!player) {
        const hint = suggestions.length
          ? ` Did you mean ${suggestions.map((s) => `**${s}**`).join(' or ')}?`
          : ' No viking by that name stands in the mead-hall.';
        await reply(message, `I find no **${cmd.name}** among the warband.${hint}`);
        await message.react('❓').catch(() => {});
        return;
      }

      const res = await linkPlayer(player, message);
      if (res.notReady) {
        await reply(message, 'The Hall’s ledgers are still being carved. Ask again shortly.');
        await message.react('⏳').catch(() => {});
        return;
      }
      await reply(message, `The Hall knows you now, **${player.character_name}**. Your deeds gather beneath your name.`);
      await message.react('🪶').catch(() => {});
      log.info?.(`[identity] ${message.author.username} -> ${player.character_name}`);
    } catch (e) {
      log.error?.(`[identity] ${e.message}`);
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
    log.info?.('[identity] link active — `@Eilif I am <name>` / `@Eilif who am I`');
  }

  return { attach, handleMessage };
}
