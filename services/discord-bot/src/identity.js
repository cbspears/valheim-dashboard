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
import { replyPayload, replySafeName, clipChars } from './format.js';
import { MENTION_STRICT } from './discord.js';

// A typed name is free text from a Discord message. It is stored on the claim
// row and echoed nowhere, but "unbounded" and "goes in a database column" do
// not belong in the same sentence on launch night. 64 is four times the longest
// name Valheim's own field will produce.
const MAX_REQUESTED_NAME = 64;

const MISSING_COLUMN = /discord_user_id|discord_username|column .* does not exist|schema cache/i;
const MISSING_TABLE = /identity_claims|relation .* does not exist|could not find the table|schema cache/i;

// Contract (B): 6 chars, no I/O/0/1, uppercase.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
export const CLAIM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const CLAIM_TTL_MS = 20 * 60 * 1000;

// THE FLOOD THIS CLOSES (red-team round 2, 2026-09-05). `@Eilif I am <name>`
// minted a fresh identity_claims row AND sent a DM every single time, with no
// throttle of any kind: one member holding down enter filled the table with
// service-role writes and DM'd themselves as fast as the gateway allowed.
//
// A cooldown rather than a lock: an honest viking who mistypes their name, or
// whose rune scrolled away, retries after a few seconds and the copy tells them
// the rune they already hold is still good. 45 s is well inside the 20-minute
// rune life, so nobody is ever left without a usable code.
const CLAIM_COOLDOWN_MS = 45_000;
// Ten times the player cap. The key is a Discord user id, so the key space is
// "everyone in the guild" rather than "the roster" — bounded on the same
// oldest-first rule relay.js uses for its death memory.
const CLAIM_MEMORY_MAX = 200;

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
    // First line only, then capped. A name is a name; a paragraph pasted after
    // "I am" is not one, and neither belongs in identity_claims.requested_name.
    const raw = m[1]
      .split('\n')[0]
      .trim()
      .replace(/^["“]|["”.!]+$/g, '')
      .trim();
    // clipChars, not slice: a code-unit cut can strand a lone surrogate, and
    // this string goes into a JSON insert body. Postgres refuses an unpaired
    // \uD83D escape, so the claim would fail and the viking would never get a
    // rune. Same reason every cap in format.js moved off slice.
    const name = clipChars(raw, MAX_REQUESTED_NAME);
    if (name) return { kind: 'claim', name };
  }
  return null;
}

export function createIdentityLink({ client, log = console, db: injectedDb }) {
  // `injectedDb` is a test seam — the same one createVoiceEngine already uses
  // for writeDb. Production passes nothing and builds the real service client.
  const db = injectedDb ?? serviceClient();

  // THE HALL THIS PINS (round 3 review, 2026-09-05). d66384b tightened all four
  // mention handlers to MENTION_STRICT and pinned the voice puppet and the
  // gallery to GUILD_ID, but identity and oaths never got the guild gate that
  // gallery.js:322 carries. Driven with the real MessageMentions and GUILD_ID
  // set to this hall, a message from ANOTHER guild minted an identity_claims
  // row and sent the rune: every service-role write this module makes was
  // reachable by anyone who could invite the bot to a server of their own, and
  // "Public Bot" in the Developer Portal is still on. Read at factory time,
  // matching gallery.js and voice.js.
  const guildId = process.env.GUILD_ID || null;

  // Mint a one-time claim code for this Discord user. Retries on the
  // vanishingly rare PK collision with a fresh code.
  // discordId -> ms of that user's last successful mint. In process only: a
  // restart forgets it, which is the right trade (the DB row is the real
  // record, and this exists to stop a burst, not to enforce a quota).
  const lastMintAt = new Map();

  function mintCooldownLeftMs(discordId) {
    const at = lastMintAt.get(discordId);
    if (typeof at !== 'number') return 0;
    const left = CLAIM_COOLDOWN_MS - (Date.now() - at);
    return left > 0 ? left : 0;
  }

  function rememberMint(discordId) {
    lastMintAt.set(discordId, Date.now());
    if (lastMintAt.size <= CLAIM_MEMORY_MAX) return;
    // Map iterates in insertion order and every entry is re-inserted on mint,
    // so the front of the map is the least recently used.
    for (const key of lastMintAt.keys()) {
      lastMintAt.delete(key);
      if (lastMintAt.size <= CLAIM_MEMORY_MAX) break;
    }
  }

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
      if (!error) {
        rememberMint(discordId);
        return { ok: true, code };
      }
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

  // parse: [] (see format.js replyPayload) — a nickname of "@everyone" echoed
  // back must render as four words, not ping the guild.
  const reply = (message, content) => message.reply(replyPayload(content)).catch(() => {});

  async function handleMessage(message) {
    try {
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user, MENTION_STRICT)) return;

      // Same two locks gallery.js has, and for the same reasons. `guild` is
      // null in a direct message: the bot asks for no DirectMessages intent
      // today so nothing delivers one, but the intent list is a config away
      // from changing and this handler mints rows and sends DMs.
      if (!message.guild) return;
      if (guildId && message.guildId !== guildId) return;

      const cmd = parseIdentity(message.content, client.user.id);
      if (!cmd) return;

      if (cmd.kind === 'whoami') {
        const cur = await currentLink(message);
        if (cur.notReady) {
          await reply(message, 'The Hall’s ledgers are still being carved. Ask again shortly.');
        } else if (cur.name) {
          await reply(message, `The Hall knows you as **${replySafeName(cur.name)}**.`);
        } else {
          await reply(
            message,
            'The Hall does not yet know you. Speak your name: `@Eilif I am <YourViking>`.'
          );
        }
        return;
      }

      // kind === 'claim'
      // `username` is a Discord DISPLAY NAME: user-chosen, and echoed back into a
      // channel message below. Escaped + capped at the point of use so the copy
      // reads the same for an honest nickname and cannot be used as a payload.
      const username = message.member?.displayName ?? message.author.username;
      const shownName = replySafeName(username);

      // Rate limit (see CLAIM_COOLDOWN_MS). Deliberately BEFORE the insert and
      // before the DM, so a burst costs one reply and nothing else.
      if (mintCooldownLeftMs(message.author.id) > 0) {
        await reply(
          message,
          'Your rune is already carved and still good. Look in your private messages and shout it in-game. ' +
            'Ask again in a minute if it never reached you.'
        );
        return;
      }

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
      //
      // Two variants: a viking who ALREADY swore an oath must not be pushed
      // through the whole oath ceremony again (re-swearing deletes + reinserts
      // the oath row, which re-fires the echo/announcement). The webhook
      // supports a link-only shout — rune with nothing after it — so point
      // already-sworn vikings at that instead.
      let alreadySworn = false;
      try {
        const db2 = injectedDb ?? serviceClient();
        if (db2) {
          const { data: existing } = await db2
            .from('oaths')
            .select('id')
            .ilike('character_name', cmd.name.replace(/[%_]/g, (c) => `\\${c}`))
            .limit(1);
          alreadySworn = !!(existing && existing.length > 0);
        }
      } catch {
        /* copy nicety only — never block the claim on this lookup */
      }
      const rune = alreadySworn
        ? `You have already sworn your oath, so this is just the binding. **Shout** the rune by itself in-game, starting with \`/s\` and nothing after the code:\n` +
          `\`/s /oath ${res.code}\`\n\n` +
          `That links your Discord to your viking and leaves your oath exactly as it stands. No second ceremony. ` +
          `The rune fades in 20 minutes. Ask again if it does.`
        : `Carve this rune and **shout** it in-game. Open chat and type it exactly like this, starting with \`/s\`:\n` +
          `\`/s /oath ${res.code} your vow, one line\`\n\n` +
          `The \`/s\` is what makes it a shout. A plain chat line never leaves the campfire, so the Hall will not hear it.\n` +
          `Whatever viking you are playing when you swear it becomes yours, bound to this voice in the Hall. ` +
          `The rune fades in 20 minutes. Ask again if it does.`;
      try {
        await message.author.send(rune);
        await reply(
          message,
          `I have whispered your rune in a private message, **${shownName}**. Shout it in-game to bind your viking.`
        );
        await message.react('📜').catch(() => {});
        log.info?.(`[identity] ${username} minted claim (rune DM'd)`);
      } catch {
        // DMs are closed — tell them how to open them; NEVER post the code here.
        await reply(
          message,
          `I could not send you a private message, **${shownName}**. Open your DMs for this server ` +
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
          `Your oath is sworn and your saga is linked. The Hall now knows you as **${claim.linked_character}**.`
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
