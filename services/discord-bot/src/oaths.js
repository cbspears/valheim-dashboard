// The Oath ingest. When a viking @mentions the bot with an `oath` message,
// record their sworn line on the dashboard's Signature Wall. Because Discord
// names ≠ in-game names, the message carries the IN-GAME name; we match it to
// a roster viking (exact → fuzzy → unmatched) so the mark lands on the right
// person — and an unmatched oath is NEVER lost.
//
// The same module also accepts `bio` and `role` messages, updating that
// viking's profile fields via the same name matching.
//
// No privileged Message Content intent needed: Discord delivers full content
// for messages that mention the app. We only need GuildMessages.
//
// Gated behind OATH_INGEST=1 (see index.js).

import { serviceClient } from './supabase.js';

const KINDS = ['oath', 'bio', 'role'];
const FUZZY_THRESHOLD = 0.75;

// ── name matching ─────────────────────────────────────────────────────────
const norm = (s) => (s ?? '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

// Classic Levenshtein edit distance.
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

// Normalized similarity in [0,1]; 1 = identical.
function similarity(a, b) {
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

// Resolve an in-game name to a roster viking.
//   exact  : normalized full name matches → link player_id
//   fuzzy  : similarity ≥ 0.75 vs full name OR first token → link player_id
//   unmatched : no confident match → player_id null (oath is still kept)
function matchPlayer(name, players) {
  const q = norm(name);
  const qFirst = q.split(' ')[0];
  if (!q) return { player: null, status: 'unmatched' };

  for (const p of players) {
    if (norm(p.character_name) === q) return { player: p, status: 'exact' };
  }

  let best = null;
  let bestSim = 0;
  for (const p of players) {
    const full = norm(p.character_name);
    const first = full.split(' ')[0];
    const sim = Math.max(
      similarity(q, full),
      similarity(q, first),
      similarity(qFirst, first)
    );
    if (sim > bestSim) {
      bestSim = sim;
      best = p;
    }
  }
  if (best && bestSim >= FUZZY_THRESHOLD) return { player: best, status: 'fuzzy' };
  return { player: null, status: 'unmatched' };
}

// ── message parsing ───────────────────────────────────────────────────────
const DASH = '[—–\\-]';

// Split the text after the keyword into { name, text }. Accepts:
//   — Name: text     (dash, name, colon, body)
//   - Name: text
//   : Name — text     (colon, name, dash, body)
//   (also tolerates a bare "Name: text" with no leading separator)
function splitNameBody(rest) {
  const s = rest.trim();
  const lead = s[0];

  if (lead === ':') {
    const body = s.slice(1).trim();
    let m = body.match(new RegExp(`^(.+?)\\s*${DASH}\\s*([\\s\\S]+)$`));
    if (m) return { name: m[1].trim(), text: m[2].trim() };
    m = body.match(/^(.+?)\s*:\s*([\s\S]+)$/); // ": Name: text" fallback
    return m ? { name: m[1].trim(), text: m[2].trim() } : null;
  }

  if (lead === '—' || lead === '–' || lead === '-') {
    const body = s.replace(new RegExp(`^${DASH}\\s*`), '');
    let m = body.match(/^(.+?)\s*:\s*([\s\S]+)$/);
    if (m) return { name: m[1].trim(), text: m[2].trim() };
    m = body.match(new RegExp(`^(.+?)\\s*${DASH}\\s*([\\s\\S]+)$`)); // dash fallback
    return m ? { name: m[1].trim(), text: m[2].trim() } : null;
  }

  // no leading separator — prefer a colon split, then a dash split
  let m = s.match(/^(.+?)\s*:\s*([\s\S]+)$/);
  if (m) return { name: m[1].trim(), text: m[2].trim() };
  m = s.match(new RegExp(`^(.+?)\\s*${DASH}\\s*([\\s\\S]+)$`));
  return m ? { name: m[1].trim(), text: m[2].trim() } : null;
}

// Pull { kind, name, text } out of a mention message, or null if it isn't one.
function parse(content, botId) {
  const stripped = (content ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .trim();
  const km = stripped.match(new RegExp(`\\b(${KINDS.join('|')})\\b([\\s\\S]*)`, 'i'));
  if (!km) return null;
  const kind = km[1].toLowerCase();
  const nb = splitNameBody(km[2]);
  if (!nb || !nb.name || !nb.text) return null;
  return { kind, name: nb.name, text: nb.text };
}

export function createOathIngest({ client, log = console }) {
  const db = serviceClient();

  async function fetchPlayers() {
    const { data, error } = await db.from('players').select('id, character_name');
    if (error) throw new Error(`players: ${error.message}`);
    return data ?? [];
  }

  // Re-swearing replaces the viking's previous mark (one oath per Discord user).
  async function recordOath({ parsed, match, message }) {
    const row = {
      character_name: parsed.name,
      player_id: match.player?.id ?? null,
      discord_id: message.author.id,
      discord_name: message.member?.displayName ?? message.author.username,
      oath_text: parsed.text,
      match_status: match.status,
      sworn_at: new Date(message.createdTimestamp).toISOString(),
    };
    await db.from('oaths').delete().eq('discord_id', message.author.id);
    const { error } = await db.from('oaths').insert(row);
    if (error) throw new Error(`insert oath: ${error.message}`);
  }

  async function recordProfile({ parsed, match }) {
    if (!match.player) return false; // nothing to attach to
    const patch = parsed.kind === 'bio' ? { bio: parsed.text } : { role: parsed.text };
    const { error } = await db.from('players').update(patch).eq('id', match.player.id);
    if (error) throw new Error(`update ${parsed.kind}: ${error.message}`);
    return true;
  }

  async function handleMessage(message) {
    try {
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user)) return;

      const parsed = parse(message.content, client.user.id);
      if (!parsed) return;

      const players = await fetchPlayers();
      const match = matchPlayer(parsed.name, players);

      if (parsed.kind === 'oath') {
        await recordOath({ parsed, match, message });
        await message.react('📜').catch(() => {});
        if (match.status === 'unmatched') await message.react('❓').catch(() => {});
        log.info?.(
          `[oath] ${parsed.name} (${match.status}) swore: ${parsed.text.slice(0, 60)}`
        );
      } else {
        const ok = await recordProfile({ parsed, match });
        if (ok) {
          await message.react('📝').catch(() => {});
          log.info?.(`[oath] updated ${parsed.kind} for ${match.player.character_name}`);
        } else {
          await message.react('❓').catch(() => {}); // couldn't find the viking
          log.info?.(`[oath] ${parsed.kind} for "${parsed.name}" — no matching viking`);
        }
      }
    } catch (e) {
      log.error?.(`[oath] ${e.message}`);
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
    log.info?.('[oath] ingest active — tag the bot with `oath — Name: your line`');
  }

  return { attach, handleMessage, parse, matchPlayer };
}
