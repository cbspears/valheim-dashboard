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
// Hard ceiling on the MODEL's output. The prompt asks for 90 words at the most
// and the bench came in at 200 to 400 characters; 700 leaves headroom without
// letting a runaway model onto the war-room page.
//
// It does NOT govern the template fallback, which is ours and is bounded by
// construction (3 to 5 sentences) rather than by a count. A full 20-viking war
// party names all twenty, which can run past 700 on its own — deliberately: the
// saga names everyone who fought, and the war-room paragraph is unclamped.
const MAX_CHARS = 700;
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
  if (s < 60) return `${s} heartbeat${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} minute${m === 1 ? '' : 's'} and ${r} second${r === 1 ? '' : 's'}` : `${m} minute${m === 1 ? '' : 's'}`;
}

// Saga phrasing for a death cause (mirrors the spirit of lib/episodes.ts).
// EVERY HitData.HitType word must resolve here: our own client plugin sends the
// enum name verbatim, and anything missing falls through to the creature branch
// and reaches the skald's prompt as "was taken by a playerhit". lib/deaths.ts
// HIT_TYPES is the list of record; scripts/voice.test.mjs walks it.
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
  stalagmite: 'was skewered from above', stalagtite: 'was skewered from above',
  cartcollision: 'was run down by their own cart', cart: 'was run down by their own cart',
  structural: 'was crushed under falling timber',
  turret: 'was shot down by a ballista',
  boat: 'was run down by a longship',
  edgeofworld: 'sailed off the edge of the world',
  ashlandsocean: 'was boiled alive in the Ashlands sea',
  ashlandsoceanfloor: 'was boiled alive in the Ashlands sea',
  catapult: 'was smashed flat by a catapult stone',
  cinderfire: 'was caught in a rain of burning cinders',
  playerhit: 'was cut down by one of their own',
  undefined: 'fell to something that left no name',
};
// Named forsaken ones read as "felled by Eikthyr", never "taken by an eikthyr"
// — and this is the ONE list that matters most, because the heroes who fall in
// a boss fight are usually killed by the boss the saga is about. Mirrors
// lib/episodes.ts BOSSES and format.js BOSS_NAMES.
const BOSSES = new Set(['eikthyr', 'the elder', 'bonemass', 'moder', 'yagluth', 'the queen', 'fader']);

// Own-property lookup: `cause` is attacker-reachable (a modded client names its
// own killer) and a bare ENV_DEATHS[low] walks Object.prototype, so a viking
// "killed by constructor" put `function Object() { [native code] }` into the
// skald's fact list.
function own(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function phraseDeath(name, cause) {
  const nm = firstName(name);
  const c = typeof cause === 'string' ? cause.trim() : '';
  if (!c) return `${nm} fell in the fray`;
  const low = c.toLowerCase();
  const env = own(ENV_DEATHS, low);
  if (env) return `${nm} ${env}`;
  if (BOSSES.has(low) || /^the\s/i.test(c)) return `${nm} was felled by ${c}`;
  const art = /^[aeiou]/i.test(c) ? 'an' : 'a';
  // The creature keeps its own casing ("a Deathsquito"), like lib/episodes.ts:
  // a lowercased name in the fact list teaches the model to lowercase it back.
  return `${nm} was taken by ${art} ${c}`;
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
    // Strings only. fight_stats is free-form jsonb written by the game client;
    // an object in `fighters` would reach the prompt as "[object Object]",
    // which is the one shape of fight_stats leak the prompt cannot survive.
    players: warParty.filter((n) => typeof n === 'string' && n.trim()),
    fightSec: typeof fs.fightSec === 'number' && Number.isFinite(fs.fightSec) ? fs.fightSec : null,
    firstBlood: typeof fs.firstBlood === 'string' && fs.firstBlood.trim() ? fs.firstBlood.trim() : null,
    topDamagePlayer:
      typeof fs.topDamagePlayer === 'string' && fs.topDamagePlayer.trim() ? fs.topDamagePlayer.trim() : null,
    topDamage: typeof fs.topDamage === 'number' && Number.isFinite(fs.topDamage) ? Math.round(fs.topDamage) : null,
    participants: typeof fs.participants === 'number' && fs.participants > 0 ? fs.participants : null,
    fallen,
  };
}

// A boss night with a full hall can put a dozen deaths inside the ±10 min
// window. Every one of them in the fact list would break BOTH consumers: the
// prompt asks the model to use every fact it is given inside 90 words, and the
// template would run to a 1,200-character wall of names in what is meant to be
// three to five sentences. So the list is capped and the rest are counted.
const MAX_FALLEN_NAMED = 6;
function fallenPhrases(fallen) {
  const named = fallen.slice(0, MAX_FALLEN_NAMED).map((d) => phraseDeath(d.name, d.cause));
  const rest = fallen.length - named.length;
  if (rest > 0) named.push(`${rest} more fell beside them`);
  return named;
}

/** "A", "A and B", "A, B and C" — nameList's grammar without its de-duping,
 *  which would silently drop the second of two vikings who share a first name
 *  and died the same way. */
function listJoin(items) {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ── LLM path ──────────────────────────────────────────────────────────
//
// PROMPT, rewritten 2026-09-05 after a bench of five variants against the live
// Eikthyr record (qwen3:14b). The old prompt asked for "flowing, evocative"
// prose and, with only four facts to work from, the model filled the gap: a
// bench run invented howling winds, an axe, a cleaved spine and "their names
// etched into the saga", at 117 words. What fixed it was not more prohibitions
// but a SHAPE — a sentence plan, an explicit word ceiling, permission to write
// less when the facts are few, and the warriors' names quoted back verbatim.
// The bench is in the session notes; the current shape holds at 38 to 71 words
// with zero invented facts on both a thin and a rich fight record.
export function buildPrompt(f) {
  const lines = [`- The beast felled: ${f.name}, a forsaken one of the ${f.biome}.`];
  if (f.worldDay != null) lines.push(`- It fell on the ${ordinal(f.worldDay)} day of the world.`);
  if (f.players.length) lines.push(`- The war party: ${nameList(f.players)}.`);
  const len = fightLength(f.fightSec);
  if (len) lines.push(`- The battle lasted ${len}.`);
  if (f.firstBlood) lines.push(`- First to draw blood: ${f.firstBlood}.`);
  if (f.topDamagePlayer)
    lines.push(
      `- Struck the hardest blows: ${f.topDamagePlayer}${f.topDamage != null ? ` (${f.topDamage} wounds dealt)` : ''}.`
    );
  if (f.participants != null) lines.push(`- Warriors in the fray: ${f.participants}.`);
  if (f.fallen.length) lines.push(`- Heroes who fell in the fight: ${fallenPhrases(f.fallen).join('; ')}.`);

  const names = f.players.length ? nameList(f.players) : 'the war party';

  return [
    'You are the skald of a Viking hall. Set down the record of a battle so it can be read aloud at the longfire.',
    '',
    'Write 3 to 5 sentences of past-tense prose, 90 words at the most, in this order:',
    '1. The beast, the country it haunted and the day it fell.',
    '2. The warriors who went after it, named exactly as given.',
    '3. How the fight went and who fell, using every fact that is given. This may take two sentences.',
    '4. One short line about the hall or the road onward. It must add no new events.',
    'Write fewer sentences when the facts are few. Never pad.',
    '',
    'Rules:',
    '- Every fact must come from the list below. Do not invent weapons, wounds, weather, places, numbers, speeches, or other creatures.',
    '- Name no place beyond the one given.',
    '- A number may be used only for the exact thing it is given for.',
    `- The warriors are real people. Their names are exactly: ${names}. Copy the spelling and the accents. Use no other names.`,
    '- Give a warrior a deed only where the facts give them one. Naming the rest is enough.',
    '- Tell it, do not list it. Never write that a war party consisted of anyone, and use no other report language.',
    '- Plain, concrete language. One idea per sentence. No stacked adjectives. No modern words.',
    '- Use ordinary punctuation, including commas between names in a list. Never use a dash of any kind.',
    '- Do not use these words: tapestry, testament, annals, sinew, ichor, whispers, echo, ages, legend, forever, unyielding.',
    '- Nothing echoes through the ages, and nothing is etched into anything.',
    '- Output the prose only. No title, no headers, no markdown, no bullet points, no quotation marks, and no preamble such as "Here is".',
    '',
    'Facts:',
    ...lines,
    '',
    'Write it now:',
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

export function sanitize(raw) {
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
  // Strip the "Here is the saga:" preamble the prompt forbids but a model still
  // volunteers. Narrow on purpose: only an opener that announces itself and
  // ends in a colon. Nothing a skald would write starts that way.
  t = t.replace(/^(?:sure|certainly|of course|here(?:'s| is| are))\b[^\n:]{0,60}:[ \t]*\n*/i, '').trim();
  // DASHES: the doctrine is no em/en dash in player-visible text, and the
  // prompt says so. Rewriting beats rejecting — a saga that is right about
  // everything except its punctuation should not be thrown away for it, and
  // the em-dash is the single most common thing a model ignores. isValid still
  // rejects a dash afterwards, so this is a repair, not the only guard.
  t = t.replace(/(\d)\s*[—–]\s*(\d)/g, '$1 to $2'); // "10–20" is a range
  t = t.replace(/^[\s—–]+/, '').replace(/[\s—–]+$/, ''); // a dash at either end is just noise
  t = t.replace(/([\n.!?])\s*[—–]\s*/g, '$1 '); // and one opening a sentence takes no comma
  t = t.replace(/\s*[—–]\s*/g, ', ');
  t = t.replace(/,\s*,/g, ',').replace(/,\s*([.!?,;:])/g, '$1');
  // Collapse excess blank lines and runs of spaces (the war-room renders this
  // in one <p>, so a double space is only ever a mistake).
  t = t.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  // Close the sentence. A model that trailed off on a dash (now stripped) or
  // ran out of tokens leaves the page looking unfinished.
  if (/[A-Za-z0-9]$/.test(t)) t += '.';
  return t;
}

// The prompt asks for no dashes and no AI tells; this is the enforcement. A
// rejected attempt is retried once and then falls back to the template, which
// is written to the same rules, so a stubborn model can never put an em-dash or
// a "testament to their valor" on the war-room page.
//
// The word list MIRRORS the prompt's own list, minus the four words that are
// also ordinary English ("echo", "ages", "legend", "forever") — banning those
// outright would reject an honest sentence and cost us a good saga. The ones
// kept here are pure tell: no skald of ours needs "ichor". The stock phrases
// are matched whole so "the annals" alone is not a hanging offence.
const BANNED =
  /[—–]|tapestry|testament|\bannals\b|\bsinew\b|\bichor\b|\bunyielding\b|whispers of|through the ages|etched into/i;

export function isValid(t) {
  if (!t) return false;
  if (t.length > MAX_CHARS) return false;
  if (/^\s*#{1,6}\s/m.test(t)) return false; // markdown header line
  if (BANNED.test(t)) return false;
  return true;
}

/** Why isValid said no — for the log line, so a rejection is diagnosable. */
function rejection(t) {
  if (!t) return 'empty';
  if (t.length > MAX_CHARS) return `over ${MAX_CHARS} chars (${t.length})`;
  if (/^\s*#{1,6}\s/m.test(t)) return 'markdown header';
  const hit = t.match(BANNED);
  if (hit) return `banned: ${JSON.stringify(hit[0])}`;
  return 'unknown';
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
  'It was {first} who drew first blood, and {top} who struck the hardest, {dmg} wounds carved into the beast.',
  '{first} landed the opening blow, while {top} rained the fiercest strikes, dealing {dmg} wounds.',
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
  'The victory was bought in blood: {fallen}.',
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
    // List grammar, not a ", and " chain: six fallen used to read "A, and B,
    // and C, and D, and E, and F".
    fallen: f.fallen.length ? listJoin(fallenPhrases(f.fallen)) : null,
  };

  // The middle clauses in NARRATIVE order, each carrying how badly it is wanted
  // (1 = kept first). Opener and closer are mandatory.
  const middle = [];
  if (f.players.length) middle.push({ keep: 3, text: fill(pick(PARTY, seed, 1), vars) });
  if (vars.len) middle.push({ keep: 4, text: fill(pick(LENGTH, seed, 2), vars) });
  if (vars.first && vars.top) {
    middle.push({ keep: 2, text: fill(pick(vars.dmg != null ? BLOW : BLOW_NODMG, seed, 3), vars) });
  }
  if (vars.fallen) middle.push({ keep: 1, text: fill(pick(FALLEN, seed, 4), vars) });

  // Keep to a tight 3 to 5 sentence shape. With all four middles present we are
  // one over, so the LEAST interesting clause goes. The old slice took the TAIL
  // instead, which is who fell: the one line a reader remembers, dropped on
  // exactly the busy boss nights that earned it.
  const kept = new Set([...middle].sort((a, b) => a.keep - b.keep).slice(0, 3));
  return [
    fill(pick(OPENERS, seed, 0), vars),
    ...middle.filter((m) => kept.has(m)).map((m) => m.text),
    fill(pick(CLOSERS, seed, 5), vars),
  ].join(' ');
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
      console.warn(`[skald] ollama attempt ${attempt} rejected (${rejection(cleaned)}); len=${cleaned.length}`);
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
