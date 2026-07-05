/* eslint-disable */
// One-time backfill of the Discord↔character identity link
// (db/2026-07-05_discord_identity.sql). Two safe sources:
//
//   1. Oaths sworn via the Discord bot carry both the Discord author id
//      (oaths.discord_id) and a matched player (oaths.player_id) — a
//      high-confidence link we can adopt directly.
//   2. Gallery photos carry the poster's Discord id + display name. For posters
//      still unlinked, we auto-link ONLY when the display name folds EXACTLY to
//      a character name (case/diacritic/whitespace-insensitive). Anything less
//      certain is logged as a suggestion and never guess-linked.
//
// Uses plain PostgREST over fetch (supabase-js crashes under Node 20 outside
// Next). Runs in PREVIEW mode (no writes) if the migration isn't applied yet,
// so it's always safe to run and re-run (idempotent).
//
//   Usage:  node scripts/backfill-identity.js
//   Node 20: export NVM_DIR=~/.config/nvm && . $NVM_DIR/nvm.sh && nvm use 20

const fs = require('fs');
const path = require('path');

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnv() {
  const file = path.join(__dirname, '..', '.env.local');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = loadEnv();
const URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

async function rest(method, pathq, body, extraHeaders) {
  const res = await fetch(`${URL}/rest/v1/${pathq}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

// ── name folding (mirrors lib/slug.ts + identity.js) ─────────────────────────
function foldName(name) {
  return (name || '')
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

async function main() {
  // Probe whether the migration is applied (discord_user_id column present).
  const probe = await rest('GET', 'players?select=discord_user_id&limit=1');
  const ready = probe.ok;
  if (!ready) {
    console.log('⚠️  players.discord_user_id not found — migration not applied yet.');
    console.log('    Running in PREVIEW mode (no writes). Re-run after the migration to apply.\n');
  }

  const playersRes = await rest('GET', 'players?select=id,character_name' + (ready ? ',discord_user_id' : ''));
  const players = playersRes.data || [];
  const oathsRes = await rest('GET', 'oaths?select=character_name,player_id,discord_id,discord_name,sworn_at&order=sworn_at');
  const oaths = (oathsRes.data || []).filter((o) => o.discord_id);
  const photosRes = await rest('GET', 'gallery_photos?select=posted_by,discord_user_id');
  const photos = photosRes.data || [];

  const byId = new Map(players.map((p) => [p.id, p]));
  const alreadyLinked = new Map(); // discordId -> character_name (existing links)
  if (ready) for (const p of players) if (p.discord_user_id) alreadyLinked.set(p.discord_user_id, p.character_name);

  // discordId already claimed in THIS run (so we don't double-plan / conflict)
  const plannedDiscord = new Set(alreadyLinked.keys());
  // playerId already targeted (one character = one discord)
  const plannedPlayer = new Set(players.filter((p) => ready && p.discord_user_id).map((p) => p.id));

  const links = []; // { discordId, username, player, source }
  const suggestions = []; // { discordId, name, guess, distance, source }

  function resolvePlayer(name) {
    const q = foldName(name);
    if (!q) return null;
    return players.find((p) => foldName(p.character_name) === q) || null;
  }
  function nearest(name) {
    const q = foldName(name);
    let best = null,
      bd = Infinity;
    for (const p of players) {
      const d = levenshtein(q, foldName(p.character_name));
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best ? { guess: best.character_name, distance: bd } : null;
  }
  function planLink(discordId, username, player, source) {
    if (!player) return;
    if (plannedDiscord.has(discordId)) return; // this discord already handled
    if (plannedPlayer.has(player.id)) return; // this character already claimed
    plannedDiscord.add(discordId);
    plannedPlayer.add(player.id);
    links.push({ discordId, username, player, source });
  }

  // ── source 1: oaths (most-recent oath per discord id wins) ──────────────────
  const oathByDiscord = new Map();
  for (const o of oaths) oathByDiscord.set(o.discord_id, o); // ordered asc → last write = newest
  for (const [discordId, o] of oathByDiscord) {
    const player = (o.player_id && byId.get(o.player_id)) || resolvePlayer(o.character_name);
    planLink(discordId, o.discord_name || null, player, 'oath');
  }

  // ── source 2: gallery posters (exact fold only; else suggest) ───────────────
  const posterByDiscord = new Map();
  for (const p of photos) if (p.discord_user_id) posterByDiscord.set(p.discord_user_id, p.posted_by);
  for (const [discordId, postedBy] of posterByDiscord) {
    if (plannedDiscord.has(discordId)) continue; // already linked via oath or existing
    const player = resolvePlayer(postedBy);
    if (player && !plannedPlayer.has(player.id)) {
      planLink(discordId, postedBy, player, 'gallery-exact');
    } else {
      const near = nearest(postedBy);
      suggestions.push({
        discordId,
        name: postedBy,
        guess: near ? near.guess : null,
        distance: near ? near.distance : null,
        source: 'gallery',
      });
    }
  }

  // ── apply (or preview) ──────────────────────────────────────────────────────
  let applied = 0;
  for (const l of links) {
    const label = `${l.player.character_name}  ←  discord ${l.discordId}${l.username ? ` (${l.username})` : ''}  [${l.source}]`;
    if (!ready) {
      console.log(`  would link  ${label}`);
      continue;
    }
    // Move the mapping off any other row, then set it on the target.
    await rest('PATCH', `players?discord_user_id=eq.${encodeURIComponent(l.discordId)}&id=neq.${l.player.id}`, {
      discord_user_id: null,
      discord_username: null,
    });
    const set = await rest('PATCH', `players?id=eq.${l.player.id}`, {
      discord_user_id: l.discordId,
      discord_username: l.username,
    });
    if (set.ok) {
      applied++;
      console.log(`  linked  ${label}`);
    } else {
      console.log(`  FAILED  ${label} — ${set.status} ${JSON.stringify(set.data)}`);
    }
  }

  // ── report ──────────────────────────────────────────────────────────────────
  console.log('\n── backfill-identity report ─────────────────────────────');
  console.log(`  migration applied : ${ready ? 'yes' : 'NO (preview only)'}`);
  console.log(`  players           : ${players.length}`);
  console.log(`  discord oaths      : ${oaths.length}`);
  console.log(`  gallery posters    : ${posterByDiscord.size}`);
  console.log(`  links ${ready ? 'applied' : 'planned'}     : ${ready ? applied : links.length}`);
  console.log(`  suggestions (not linked) : ${suggestions.length}`);
  if (suggestions.length) {
    console.log('\n  Near-misses — a human should confirm with `@Eilif I am <name>`:');
    for (const s of suggestions) {
      const g = s.guess ? `nearest "${s.guess}" (${s.distance} edits)` : 'no close viking';
      console.log(`    • "${s.name}" (discord ${s.discordId}) → ${g}`);
    }
  }
  console.log('─────────────────────────────────────────────────────────');
}

main().catch((e) => {
  console.error('backfill failed:', e.message);
  process.exit(1);
});
