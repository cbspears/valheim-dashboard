// The Skald — generates a saga retelling of a boss fight, ONCE per kill.
//
// Flow: gather the fight's facts (boss/biome, world day, war party, fight_stats,
// and any heroes who fell within ±10 min of the kill), ask the local ollama LLM
// (qwen3.6:27b) for 3–5 sentences of grounded past-tense skald prose, sanitize
// it, and write it to bosses.retelling via the service-role client. If ollama is
// unreachable or both attempts fail validation, fall back to a solid hash-seeded
// TEMPLATE built from the same facts so the war-room section is never empty.
//
// Used by src/bosses.js (after the @everyone announcement — never blocking it)
// and by scripts/retell-boss.js (manual generate / regenerate).

// 127.0.0.1, not localhost: Node 20 fetch resolves localhost to ::1 first and
// ollama listens on IPv4 only — "fetch failed" with no further hint.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.6:27b';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '150000', 10);
const MAX_CHARS = 900;
const DEATH_WINDOW_MS = 10 * 60 * 1000; // ±10 min around the kill

// Small, pure 31-multiplier string hash (stable across runs) — mirrors format.js
// and lib/episodes.ts so seeded template choice reads the same way everywhere.
function hashString(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

function pick(pool, seed, offset = 0) {
  return pool[(seed + offset) % pool.length];
}

function firstName(name) {
  return String(name ?? 'a viking').trim().split(/\s+/)[0] || 'a viking';
}

/** "Bjorn", "Bjorn and Ingrid", "A, B and C", "A, B, C and Steve". */
function nameList(names) {
  const list = [...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))];
  if (list.length === 0) return 'a lone viking';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function fightLength(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s} heartbeats`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} minute${m === 1 ? '' : 's'} and ${r} second${r === 1 ? '' : 's'}` : `${m} minute${m === 1 ? '' : 's'}`;
}

// Saga phrasing for a death cause (mirrors the spirit of lib/episodes.ts).
const ENV_DEATHS = {
  fall: 'fell to their death', falling: 'fell to their death',
  drowning: 'was claimed by dark water', drowned: 'was claimed by dark water',
  drown: 'was claimed by dark water', water: 'was claimed by dark water',
  tree: 'was crushed by a falling tree', fire: 'was lost to the flames',
  burning: 'was lost to the flames', smoke: 'choked on hearth-smoke',
  freezing: 'froze where they stood', cold: 'froze where they stood',
  poison: 'succumbed to poison', poisoned: 'succumbed to poison',
  impact: 'was broken by the fall', self: 'was undone by their own hand',
  lava: 'was swallowed by molten rock',
  // Valheim's catch-all HitType for an unnamed killer — mirrors lib/episodes.ts.
  // Without it the skald is handed "was taken by an enemyhit".
  enemyhit: 'was struck down by an unseen foe',
};
function phraseDeath(name, cause) {
  const nm = firstName(name);
  if (!cause) return `${nm} fell in the fray`;
  const low = String(cause).toLowerCase();
  if (ENV_DEATHS[low]) return `${nm} ${ENV_DEATHS[low]}`;
  if (/^the\s/i.test(cause)) return `${nm} was felled by ${cause}`;
  const art = /^[aeiou]/i.test(cause) ? 'an' : 'a';
  return `${nm} was taken by ${art} ${low}`;
}

// ── fact gathering ────────────────────────────────────────────────────
async function gatherFacts(db, boss) {
  const killedAt = boss.killed_at || null;
  const killedMs = killedAt ? new Date(killedAt).getTime() : NaN;

  let worldDay = null;
  try {
    const { data: status } = await db
      .from('server_status')
      .select('world_day')
      .eq('id', 1)
      .maybeSingle();
    if (status && typeof status.world_day === 'number') worldDay = status.world_day;
  } catch {
    // server_status unreadable -> omit world day
  }

  const fallen = [];
  if (Number.isFinite(killedMs)) {
    const lo = new Date(killedMs - DEATH_WINDOW_MS).toISOString();
    const hi = new Date(killedMs + DEATH_WINDOW_MS).toISOString();
    try {
      const { data: rows } = await db
        .from('events')
        .select('character_name, created_at, metadata')
        .eq('type', 'death')
        .gte('created_at', lo)
        .lte('created_at', hi);
      for (const r of rows || []) {
        const nm = (r.character_name || '').trim();
        if (!nm) continue;
        const c = r.metadata?.cause;
        fallen.push({ name: nm, cause: typeof c === 'string' && c.trim() ? c.trim() : null });
      }
    } catch {
      // events unreadable -> no fallen heroes
    }
  }

  const fs = boss.fight_stats || {};
  // The war party is the TRUE fighter set when captured; players_present is the
  // fallback for legacy rows. Never the raw online roster (bystanders don't earn
  // a verse in the saga).
  const warParty =
    Array.isArray(fs.fighters) && fs.fighters.length > 0
      ? fs.fighters
      : Array.isArray(boss.players_present)
        ? boss.players_present
        : [];
  return {
    name: boss.name,
    biome: boss.biome,
    killedAt,
    worldDay,
    players: warParty.filter(Boolean),
    fightSec: typeof fs.fightSec === 'number' && Number.isFinite(fs.fightSec) ? fs.fightSec : null,
    firstBlood: typeof fs.firstBlood === 'string' && fs.firstBlood.trim() ? fs.firstBlood.trim() : null,
    topDamagePlayer:
      typeof fs.topDamagePlayer === 'string' && fs.topDamagePlayer.trim() ? fs.topDamagePlayer.trim() : null,
    topDamage: typeof fs.topDamage === 'number' && Number.isFinite(fs.topDamage) ? Math.round(fs.topDamage) : null,
    participants: typeof fs.participants === 'number' && fs.participants > 0 ? fs.participants : null,
    fallen,
  };
}

// ── LLM path ──────────────────────────────────────────────────────────
function buildPrompt(f) {
  const lines = [`- The beast felled: ${f.name}, a forsaken one of the ${f.biome}.`];
  if (f.worldDay != null) lines.push(`- It fell on the ${ordinal(f.worldDay)} day of the world.`);
  if (f.players.length) lines.push(`- The war party: ${nameList(f.players)}.`);
  const len = fightLength(f.fightSec);
  if (len) lines.push(`- The battle lasted ${len}.`);
  if (f.firstBlood) lines.push(`- First to draw blood: ${f.firstBlood}.`);
  if (f.topDamagePlayer)
    lines.push(
      `- Struck the hardest blows: ${f.topDamagePlayer}${f.topDamage != null ? ` (${f.topDamage} damage dealt)` : ''}.`
    );
  if (f.participants != null) lines.push(`- Warriors in the fray: ${f.participants}.`);
  if (f.fallen.length)
    lines.push(`- Heroes who fell in the fight: ${f.fallen.map((d) => phraseDeath(d.name, d.cause)).join('; ')}.`);

  return [
    "You are a Norse skald composing the saga of a battle for a Viking clan's mead-hall.",
    'Recount the fall of the beast in 3 to 5 sentences of flowing, past-tense prose.',
    '',
    'Rules:',
    '- Use ONLY the facts listed below. Never invent names, numbers, places, weapons, or events that are not given.',
    '- The warriors are real people playing Vikings. Refer to them ONLY by the character names given, never invent others.',
    '- Grand and evocative, but grounded — no modern words, no anachronisms.',
    '- Output prose ONLY: no title, no headers, no markdown, no bullet points, no quotation marks, and no preamble such as "Here is". Begin directly with the saga.',
    '',
    'Facts:',
    ...lines,
    '',
    'Write the saga now:',
  ].join('\n');
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function callOllama(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.8 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const json = await res.json();
    return json.response || '';
  } finally {
    clearTimeout(timer);
  }
}

function sanitize(raw) {
  if (!raw) return '';
  let t = String(raw);
  // Strip complete <think>...</think> blocks (qwen3.6 may emit reasoning).
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Unclosed leading think block: drop everything up to a lone </think>.
  if (/<\/think>/i.test(t) && !/<think>/i.test(t)) t = t.replace(/[\s\S]*?<\/think>/i, '');
  t = t.replace(/<\/?think>/gi, '');
  t = t.trim();
  // Strip surrounding quotes/backticks the model sometimes wraps prose in.
  t = t.replace(/^[`"'“”‘’]+/, '').replace(/[`"'“”‘’]+$/, '').trim();
  // Collapse excess blank lines.
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

function isValid(t) {
  if (!t) return false;
  if (t.length > MAX_CHARS) return false;
  if (/^\s*#{1,6}\s/m.test(t)) return false; // markdown header line
  return true;
}

// ── template fallback (hash-seeded, same 3–5 sentence shape) ───────────
const OPENERS = [
  'On the {day} the forsaken {name} rose in the {biome}, and the clan sailed to meet it.',
  'The saga tells of the {day}, when {name} stirred in the {biome} and the war-horn sounded.',
  'In the {biome} stood {name}, ancient and cruel, and on the {day} the clan came to end it.',
  'Long had {name} haunted the {biome}; on the {day} its reckoning arrived.',
];
const PARTY = [
  '{party} strode into the fray with shield and steel.',
  '{party} answered the horn and formed the shield-wall.',
  'It was {party} who dared the beast that day.',
];
const BLOW = [
  'It was {first} who drew first blood, and {top} who struck the hardest — {dmg} wounds carved into the beast.',
  '{first} landed the opening blow, while {top} rained the fiercest strikes, dealing {dmg} damage.',
  'First blood fell to {first}, and {top} dealt the deepest wounds, {dmg} in all.',
];
const BLOW_NODMG = [
  'It was {first} who drew first blood, and {top} who struck the hardest.',
  '{first} landed the opening blow, while {top} rained the fiercest strikes.',
];
const LENGTH = [
  'For {len} the battle raged before the beast was thrown down.',
  'The struggle lasted {len}, and then the forsaken one fell.',
  'After {len} of fury, the beast crashed lifeless to the ground.',
];
const FALLEN = [
  'Not all returned unbloodied: {fallen}.',
  'The victory was bought in blood — {fallen}.',
  'Yet the fight took its toll: {fallen}.',
];
const CLOSERS = [
  'A new region opened to the clan, and the mead flowed long into the night. Skål.',
  'The {biome} bowed at last, and the saga gained another verse. Skål to the war-party.',
  'Its head taken, the way lay open, and the hall rang with victory-songs. Skål.',
  'The beast was cairned, its trophy raised, and the clan sailed on richer for the deed. Skål.',
];

function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

function buildTemplate(f) {
  const seed = hashString(`${f.name}|${f.killedAt || ''}`);
  const vars = {
    name: f.name,
    biome: f.biome,
    day: f.worldDay != null ? `${ordinal(f.worldDay)} day` : 'day of reckoning',
    party: nameList(f.players),
    first: f.firstBlood ? firstName(f.firstBlood) : null,
    top: f.topDamagePlayer ? firstName(f.topDamagePlayer) : null,
    dmg: f.topDamage != null ? f.topDamage : null,
    len: fightLength(f.fightSec),
    fallen: f.fallen.length ? f.fallen.map((d) => phraseDeath(d.name, d.cause)).join(', and ') : null,
  };

  const sentences = [fill(pick(OPENERS, seed, 0), vars)];
  if (f.players.length) sentences.push(fill(pick(PARTY, seed, 1), vars));
  if (vars.len) sentences.push(fill(pick(LENGTH, seed, 2), vars));
  if (vars.first && vars.top) {
    sentences.push(fill(pick(vars.dmg != null ? BLOW : BLOW_NODMG, seed, 3), vars));
  }
  if (vars.fallen) sentences.push(fill(pick(FALLEN, seed, 4), vars));
  sentences.push(fill(pick(CLOSERS, seed, 5), vars));

  // Keep to a tight 3–5 sentence shape: opener + closer are mandatory; trim
  // the middle if we overran, but always keep the most colorful clause.
  let out = sentences;
  if (out.length > 5) {
    const opener = out[0];
    const closer = out[out.length - 1];
    const middle = out.slice(1, -1).slice(0, 3);
    out = [opener, ...middle, closer];
  }
  return out.join(' ');
}

// ── DB write (service role); tolerate failure pre-migration ────────────
async function writeRetelling(writeDb, boss, text) {
  if (!writeDb) {
    console.warn('[skald] no service-role client — retelling NOT persisted');
    return false;
  }
  try {
    const { error } = await writeDb
      .from('bosses')
      .update({ retelling: text, retelling_generated_at: new Date().toISOString() })
      .eq('id', boss.id);
    if (error) {
      console.warn(`[skald] DB write failed (ok pre-migration): ${error.message}`);
      return false;
    }
    console.log(`[skald] wrote retelling for ${boss.name} (${boss.id})`);
    return true;
  } catch (e) {
    console.warn(`[skald] DB write threw (ok pre-migration): ${e.message}`);
    return false;
  }
}

/**
 * createSkald({ db, writeDb }) — db = read client (anon), writeDb = service role.
 * Returns { generate(boss, { force }), gatherFacts(boss), buildTemplate }.
 */
export function createSkald({ db, writeDb }) {
  async function generate(boss, { force = false } = {}) {
    if (!force && typeof boss.retelling === 'string' && boss.retelling.trim()) {
      console.log(`[skald] ${boss.name} already has a retelling — skipping (use force to regen)`);
      return { retelling: boss.retelling, source: 'existing', wrote: false, facts: null };
    }

    const facts = await gatherFacts(db, boss);
    let text = '';
    let source = 'template';
    const prompt = buildPrompt(facts);

    for (let attempt = 1; attempt <= 2; attempt++) {
      let out;
      try {
        const t0 = Date.now();
        out = await callOllama(prompt);
        console.log(`[skald] ollama attempt ${attempt} returned in ${Date.now() - t0}ms`);
      } catch (e) {
        console.warn(`[skald] ollama attempt ${attempt} failed: ${e.message}`);
        continue;
      }
      const cleaned = sanitize(out);
      if (isValid(cleaned)) {
        text = cleaned;
        source = 'llm';
        break;
      }
      console.warn(
        `[skald] ollama attempt ${attempt} rejected (empty/markdown/over ${MAX_CHARS} chars); len=${cleaned.length}`
      );
    }

    if (!text) {
      text = buildTemplate(facts);
      source = 'template';
      console.log(`[skald] falling back to template for ${facts.name}`);
    }

    console.log(`[skald] ${facts.name}: ${source} retelling, ${text.length} chars`);
    const wrote = await writeRetelling(writeDb, boss, text);
    return { retelling: text, source, wrote, facts };
  }

  return {
    generate,
    gatherFacts: (boss) => gatherFacts(db, boss),
    buildTemplate,
  };
}
