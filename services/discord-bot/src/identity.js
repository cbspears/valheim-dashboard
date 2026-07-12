// Discord ↔ character identity link.
//
//   @Eilif I am <CharacterName>   — mint a one-time code to link a viking.
//   @Eilif join                   — same, without naming a character up front.
//   @Eilif who am I               — report the current link (handy for testing).
//
// This does NOT link anything directly. It mints a 6-char code (contract B)
// and inserts an `identity_claims` row (code, discord_user_id, discord_username,
// requested_name, expires_at = now + 20min). The player then shouts
// `/oath <CODE> — <their oath>` in-game; the webhook oath handler
// (app/api/webhook/route.ts) is the SOLE place that consumes a code and links
// `players.discord_user_id` — whatever viking they're playing when they swear
// it becomes theirs. This module only confirms the result back on Discord (see
// createIdentityConfirmations below) once that consumption has happened.
//
// No privileged Message Content intent needed: Discord delivers full content for
// messages that mention the app. Follows the oath/gallery ingest pattern.
//
// Gated behind IDENTITY_LINK (on unless IDENTITY_LINK=0). Degrades gracefully
// before the identity_claims table / db/2026-07-05_discord_identity.sql are
// applied (missing-table/missing-column error → an in-tone "not ready yet"
// reply, nothing crashes).

import { randomInt } from 'node:crypto';
import { serviceClient } from './supabase.js';

const MISSING_COLUMN = /discord_user_id|discord_username|column .* does not exist|schema cache/i;
const MISSING_TABLE = /identity_claims|relation .* does not exist|could not find the table|schema cache/i;

// Contract (B): 6 chars, no I/O/0/1, uppercase.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
export const CLAIM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const CLAIM_TTL_MS = 20 * 60 * 1000;

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// ── name folding (mirrors lib/slug.ts foldName) ─────────────────────────────
// Lowercase, strip diacritics, fold Norse ligatures, drop non-alphanumerics —
// so "Charlie", "Chærlie" and "chaerlie" all fold to the same key. Kept here
// for parity with the dashboard's matching helpers even though the mint path
// below no longer needs to match a typed name against the roster.
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

// Rank roster vikings by edit distance on the folded names; offer the closest
// 1-2 that are actually close. Not used for linking (that's the webhook's job
// now) — kept as a small utility in case future prompts want a "did you mean".
export function matchRoster(name, players) {
  const q = foldName(name);
  if (!q) return { player: null, suggestions: [] };

  const exact = players.find((p) => foldName(p.character_name) === q);
  if (exact) return { player: exact, suggestions: [] };

  const scored = players
    .map((p) => ({ p, d: levenshtein(q, foldName(p.character_name)) }))
    .sort((a, b) => a.d - b.d);
  const suggestions = scored
    .filter((s, i) => s.d <= 2 || (i === 0 && foldName(s.p.character_name).startsWith(q.slice(0, 3))))
    .slice(0, 2)
    .map((s) => s.p.character_name);
  return { player: null, suggestions };
}

// Parse the mention into a command, or null if it isn't one of ours.
//   { kind: 'claim', name } | { kind: 'whoami' }
export function parseIdentity(content, botId) {
  const stripped = (content ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .trim();
  if (/^who\s*(is|am)\s*i\b\??$/i.test(stripped)) return { kind: 'whoami' };
  if (/^join\b\??$/i.test(stripped)) return { kind: 'claim', name: null };
  const m = stripped.match(/^i\s*['’]?\s*am\b\s*[:\-—–]?\s*([\s\S]+)$/i);
  if (m) {
    const name = m[1].trim().replace(/^["“]|["”.!]+$/g, '').trim();
    if (name) return { kind: 'claim', name };
  }
  return null;
}

export function createIdentityLink({ client, log = console }) {
  const db = serviceClient();

  // Mint a one-time claim code for this Discord user. Retries on the
  // vanishingly rare PK collision with a fresh code.
  async function mintClaim({ discordId, username, requestedName }) {
    const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      const { error } = await db.from('identity_claims').insert({
        code,
        discord_user_id: discordId,
        discord_username: username,
        requested_name: requestedName,
        expires_at: expiresAt,
      });
      if (!error) return { ok: true, code };
      if (MISSING_TABLE.test(error.message)) return { ok: false, notReady: true };
      if (error.code === '23505') continue; // code collision — try again
      throw new Error(`insert claim: ${error.message}`);
    }
    throw new Error('insert claim: exhausted retries generating a unique code');
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
      const username = message.member?.displayName ?? message.author.username;
      const res = await mintClaim({
        discordId: message.author.id,
        username,
        requestedName: cmd.name,
      });

      if (res.notReady) {
        await reply(message, 'The Hall’s ledgers are still being carved. Ask again shortly.');
        await message.react('⏳').catch(() => {});
        return;
      }

      // Deliver the rune PRIVATELY over DM. Anyone who can read the code in a
      // public channel could shout it in-game first and bind THIS user's
      // Hall-voice to their own viking — so the code must never appear in the
      // channel, and there is deliberately NO public fallback that leaks it.
      const rune =
        `Carve this rune and shout it in-game:\n\`/oath ${res.code} — <your oath>\`\n\n` +
        `Whatever viking you are playing when you swear it becomes yours, bound to this voice in the Hall. ` +
        `The rune fades in 20 minutes — ask again if it does.`;
      try {
        await message.author.send(rune);
        await reply(
          message,
          `I have whispered your rune in a private message, **${username}** — swear it in-game to bind your viking.`
        );
        await message.react('📜').catch(() => {});
        log.info?.(`[identity] ${username} minted claim (rune DM'd)`);
      } catch {
        // DMs are closed — tell them how to open them; NEVER post the code here.
        await reply(
          message,
          `I could not send you a private message, **${username}**. Open your DMs for this server ` +
            `(Privacy Settings → Direct Messages), then ask again: \`@Eilif I am <YourViking>\`.`
        );
        await message.react('⚠️').catch(() => {});
        log.warn?.(`[identity] ${username} minted claim but DM failed (DMs closed?)`);
      }
    } catch (e) {
      log.error?.(`[identity] ${e.message}`);
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
    log.info?.('[identity] link active — `@Eilif I am <name>` / `@Eilif join` / `@Eilif who am I`');
  }

  return { attach, handleMessage };
}

// Confirms claims the webhook oath handler has already consumed: DMs the
// Discord user once (consumed_at set, announced_at still null), then marks
// announced_at so it never re-fires. DM failures are swallowed (the claim is
// still marked announced — no point retrying a DM Discord won't deliver).
export function createIdentityConfirmations({ client, log = console }) {
  const db = serviceClient();
  let warnedMissing = false;

  async function tick() {
    const { data, error } = await db
      .from('identity_claims')
      .select('code, discord_user_id, linked_character')
      .not('consumed_at', 'is', null)
      .is('announced_at', null);

    if (error) {
      if (MISSING_TABLE.test(error.message)) {
        if (!warnedMissing) {
          log.info?.('[identity] identity_claims not migrated yet — skipping confirmations');
          warnedMissing = true;
        }
        return 0;
      }
      log.error?.(`[identity] confirmations poll failed: ${error.message}`);
      return 0;
    }
    warnedMissing = false;

    let confirmed = 0;
    for (const claim of data ?? []) {
      try {
        const user = await client.users.fetch(claim.discord_user_id);
        await user.send(
          `Your oath is sworn, your saga is linked — the Hall now knows you as **${claim.linked_character}**.`
        );
      } catch (e) {
        log.warn?.(`[identity] DM failed for ${claim.discord_user_id}: ${e.message}`);
      }

      const { error: upErr } = await db
        .from('identity_claims')
        .update({ announced_at: new Date().toISOString() })
        .eq('code', claim.code)
        .is('announced_at', null);
      if (upErr) {
        log.error?.(`[identity] mark announced failed for ${claim.code}: ${upErr.message}`);
        continue;
      }
      confirmed++;
    }
    if (confirmed) log.info?.(`[identity] confirmed ${confirmed} linked oath(s)`);
    return confirmed;
  }

  return { tick };
}
