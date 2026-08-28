// The Voice of the Hall — Eilif's brain.
//
// A server-side game plugin polls GET /api/voice and SPEAKS queued lines
// in-game as "Eilif". THIS module decides what gets queued and when, writing
// rows to the `voice_lines` table (service-role). It is a presence, not a
// chatterbox.
//
// Pacing model (Charlie's decisions, 2026-08-22):
//   • AMBIENT (atmosphere + callback) — one line per ~2 HOURS of someone-online
//     time, AND never within VOICE_MIN_GAP_MS (default 30 min) of the most
//     recent voice line of ANY kind. Never to an empty hall.
//   • WHISPERS ON QUIET NIGHTS — not extra volume: when the ambient slot fires
//     to a nearly-empty hall (exactly 1 viking online, or 2–3 with no `events`
//     row in the last 45 minutes), the ambient POOL is swapped for a closer,
//     spookier one that says a viking's name. Same clock, same gap.
//   • DAWN — a special ambient class on its own clock: once on every 3rd world
//     day (worldDay % 3 === 0), only while players are online. NOT on the 2h
//     clock and NOT subject to the 30-minute gap. Most dawn lines name Eilif so
//     players can tell these are custom, not vanilla.
//   • EVENTS — per-player death milestones, in-game oath echoes, the evening
//     POTY crown, admin `@Eilif say:` lines: EXEMPT from every gap. Great Deeds
//     and title proclamations are queued by milestones.js / titles.js at their
//     own announce moment (also exempt).
//
// Retired here: the warband-every-50th-death line (now per-player tiers) and
// first-biome discovery welcomes (removed entirely).
//
// Voice matches the saga register of format.js — evocative, dry, never
// mechanical, and never an echo of vanilla Valheim's own on-screen text.
// Gated behind VOICE_ENGINE=1 (see index.js), like GALLERY_INGEST.

import { serviceClient } from './supabase.js';

const TICK_MS = 60_000;                 // the caller ticks us every 60s
const CADENCE_MINUTES = 120;            // one ambient line per ~2h online-time
const STALE_MS = 24 * 3600 * 1000;      // queued-but-unspoken lines expire after 24h
const RECENT_KEEP = 5;                  // no template repeats within its last 5 uses
const DEFAULT_MIN_GAP_MS = 1_800_000;   // VOICE_MIN_GAP_MS default — ambient only
const DAWN_EVERY_DAYS = 3;              // dawn line on every 3rd world day
const DEATH_TIER_STEP = 100;            // after 100, a tier every +100 deaths
const WHISPER_CREW_MAX = 3;             // 2..3 online = a quiet crew
const WHISPER_QUIET_MS = 45 * 60_000;   // "nothing eventful" window for the crew whisper

// ── Content bank (saga register — match format.js) ────────────────────────

// (a) Dawn — a special ambient class, once every 3rd world day. {day} rides in.
// Most of these name Eilif: the hall should sound like it knows its own name.
export const DAWN = [
  'Day {day} over Eilif. The mist never lifted, and neither did we.',
  'Dawn on day {day}. Eilif counted the hearths still burning and got the same number as last night. Good.',
  'Day {day}. Eilif has kept the roof on this long. The rest is your business.',
  'Light comes back to Eilif on day {day}, and so do the things that hunt in it.',
  'Day {day}. Eilif marks who rises first and says nothing about who does not.',
  'Another dawn on Eilif, day {day}. The mead survived the night.',
  'Day {day}. Eilif has seen worse mornings, though not lately.',
];

// (b) Pure atmosphere — no data, just weather in the bones.
export const ATMOSPHERE = [
  'Pine smoke and cold salt on the wind. Eilif has never worked out whether that means anything.',
  'Something large turned over in its sleep out past the fog. Leave it where it lies.',
  'The mead is warm and the trolls are only mostly asleep.',
  'A raven circled the hall three times, then thought better of it.',
  'Eilif creaks like an old ship at anchor. It remembers everyone who ever leaned on these walls.',
  'Rain on the roof and wolves at the treeline. The realm keeps its own counsel tonight.',
  'The forge has gone cold, but the coals are still muttering about the blades to come.',
  'Out on the black water the serpents wait, patient as a grudge.',
  'A hundred oaths have been sworn over the stones round the longfire. The stones kept all of them.',
  'Quiet in the hall. That usually means a good story or a bad death is on its way.',
];

// (c) Callbacks — dated deaths from ~1/2/4 weeks ago, phrased darkly. {span}
// is the time-ago label, {name}/{cause} come from the archived event. {cause}
// is always a NOUN PHRASE (see findCallbackEvent's fallback) so it can sit
// inside a sentence without breaking the grammar.
export const CALLBACK_TEMPLATES = [
  '{span} tonight the dark took {name}. Cause of death, {cause}. The thing that did it remembers too.',
  '{span} this hall lost {name} to {cause}. A saga is only the deaths we bother to tell twice.',
  'Cast your horn back {span}. {name} fell to {cause}, and the ravens ate well.',
  '{span} {name} went into the void courtesy of {cause}. The gods keep a stool warm for the bold. The careless get a cold one.',
];

// (d) Whispers on quiet nights — the ambient pool SWAP for a near-empty hall.
// SOLO: exactly one viking online. Second person, spooky-cozy, names them.
export const SOLO_WHISPERS = [
  'You are alone in Eilif tonight, {firstName}. Probably.',
  'Just you and the wind out here, {firstName}. One of you is being watched, and it is not the wind.',
  'Odin sees you, {firstName}. He has always seen you. He thinks the roof pitch is bold.',
  'Nobody else came tonight, {firstName}. Something did. It is keeping its distance for now.',
  'The hall counts one heartbeat, {firstName}, and two sets of footsteps.',
  'Work while it is quiet, {firstName}. The dark only ever lends quiet out.',
];

// QUIET CREW: 2–3 online and nothing eventful in the last 45 minutes. Some of
// these name a viking; some let the whole crew feel watched.
export const CREW_WHISPERS = [
  'No deeds tonight. Just work and the dark and whatever is counting you from the treeline.',
  'Odin sees you too, {firstName}. Especially you.',
  'Heads down, hammers busy. The ravens take notes on the quiet ones.',
  'A small crew and a long night. Eilif has known both to end well, though not often.',
  'Nothing has gone wrong yet, {firstName}. Eilif finds that suspicious.',
  'Torchlight only reaches so far. Past it, something has been very patient tonight.',
];

// (e) Per-player death milestones — tiers at 20, 50, 100, then every +100.
// {name} is the first name, {count} the death total at the tier.
export const DEATH_LINES = {
  20: 'Twenty deaths for {name}. Eilif keeps the count, and {name} keeps getting back up.',
  50: 'Fifty deaths for {name}. The ravens know that name by heart and still it walks back in through the door.',
  100: 'One hundred deaths, {name}. Eilif stopped flinching somewhere around sixty.',
  next: '{count} deaths, {name}. Eilif has stopped being surprised. The ink holds out anyway.',
};

// ── tiny deterministic RNG (mulberry32) + string hash (mirrors format.js) ──
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || 'viking';

/** Highest death tier a total has crossed: 20, 50, 100, then every +100. 0 = none. */
export function deathTier(deaths) {
  const n = Math.floor(Number(deaths) || 0);
  if (n >= 100) return Math.floor(n / DEATH_TIER_STEP) * DEATH_TIER_STEP;
  if (n >= 50) return 50;
  if (n >= 20) return 20;
  return 0;
}

/** The line for a crossed death tier, with {name}/{count} filled in. */
export function deathMilestoneLine(tier, name) {
  const template = DEATH_LINES[tier] ?? DEATH_LINES.next;
  return template.replace(/\{name\}/g, firstName(name)).replace(/\{count\}/g, String(tier));
}

export function createVoiceEngine({
  client,
  db,
  post,
  state,
  saveState,
  log = console,
  writeDb: injectedWriteDb,
  minGapMs = DEFAULT_MIN_GAP_MS,
}) {
  // `injectedWriteDb` is a test seam; production builds the real service client.
  const writeDb = injectedWriteDb ?? (process.env.SUPABASE_SERVICE_ROLE_KEY ? serviceClient() : null);
  if (!writeDb) {
    log.warn?.('[voice] no SUPABASE_SERVICE_ROLE_KEY — voice engine disabled (reads only)');
  }
  const gapMs = Number.isFinite(minGapMs) && minGapMs >= 0 ? minGapMs : DEFAULT_MIN_GAP_MS;

  function st() {
    if (!state.voice || typeof state.voice !== 'object') state.voice = {};
    const v = state.voice;
    if (typeof v.onlineMinutes !== 'number') v.onlineMinutes = 0;   // ambient cadence accumulator
    if (typeof v.ambientCount !== 'number') v.ambientCount = 0;     // variety seed
    if (!Array.isArray(v.recentTemplates)) v.recentTemplates = [];  // last RECENT_KEEP template ids
    if (!v.deathTiers || typeof v.deathTiers !== 'object') v.deathTiers = {}; // name -> last tier said
    if (typeof v.deathTiersSeeded !== 'boolean') v.deathTiersSeeded = false;
    if (!('lastDawnDay' in v)) v.lastDawnDay = null;                // world day of the last dawn line
    // Retired mechanics — drop their keys so state.json stays honest.
    delete v.lastDeathMilestone;   // warband-every-50th (now per-player tiers)
    delete v.announcedDiscoveries; // first-biome welcomes (removed)
    return v;
  }

  // Queue a line for the in-game plugin to speak. speaker defaults to 'Eilif'.
  async function enqueue(text, kind, meta = {}) {
    if (!writeDb || !text) return false;
    const { error } = await writeDb.from('voice_lines').insert({
      text,
      kind,
      meta,
      status: 'queued',
      queued_at: new Date().toISOString(),
    });
    if (error) {
      log.error?.(`[voice] enqueue failed: ${error.message}`);
      return false;
    }
    return true;
  }

  // Cheapest online read: the single server_status row the recap already uses.
  async function readStatus() {
    const { data } = await db
      .from('server_status')
      .select('is_online, player_count, world_day')
      .eq('id', 1)
      .maybeSingle();
    return {
      online: !!data?.is_online,
      playerCount: data?.player_count ?? 0,
      worldDay: data?.world_day ?? 0,
    };
  }

  // ── global pacing (ambient only) ─────────────────────────────────────────

  // When the most recent voice line of ANY kind was queued, in epoch ms.
  // voice_lines has no public-read policy, so this must use the service client.
  async function lastVoiceQueuedAt() {
    if (!writeDb) return null;
    const { data, error } = await writeDb
      .from('voice_lines')
      .select('queued_at')
      .order('queued_at', { ascending: false })
      .limit(1);
    if (error) {
      log.warn?.(`[voice] gap check failed, treating hall as quiet: ${error.message}`);
      return null;
    }
    const ts = Array.isArray(data) ? data[0]?.queued_at : data?.queued_at;
    const t = ts ? Date.parse(ts) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  // Milliseconds still owed before an AMBIENT line may be queued (0 = clear).
  async function ambientGapRemaining() {
    if (gapMs <= 0) return 0;
    const last = await lastVoiceQueuedAt();
    if (last == null) return 0;
    return Math.max(0, gapMs - (Date.now() - last));
  }

  // ── ambient content selection ────────────────────────────────────────────

  // Build the candidate lines for one category as {id, text}. Callback candidates
  // require a DB read, so they're only built when the roll actually lands there.
  async function buildCategory(cat, status, rand) {
    if (cat === 'atmosphere') {
      return ATMOSPHERE.map((t, i) => ({ id: `atmo:${i}`, text: t }));
    }
    if (cat === 'callback') {
      const ev = await findCallbackEvent(rand);
      if (!ev) return [];
      return CALLBACK_TEMPLATES.map((t, i) => ({
        id: `cb:${i}`,
        text: t
          .replace(/\{span\}/g, ev.span)
          .replace(/\{name\}/g, ev.name)
          .replace(/\{cause\}/g, ev.cause),
      }));
    }
    return [];
  }

  // Find a death from ~1/2/4 weeks ago (spans tried in a seeded order).
  async function findCallbackEvent(rand) {
    const spans = [
      { days: 7, label: 'a week ago' },
      { days: 14, label: 'a fortnight ago' },
      { days: 28, label: 'four weeks past' },
    ];
    // seeded shuffle so the chosen span/event varies without repeating patterns
    for (let i = spans.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [spans[i], spans[j]] = [spans[j], spans[i]];
    }
    for (const span of spans) {
      const end = new Date(Date.now() - span.days * 24 * 3600 * 1000);
      const start = new Date(end.getTime() - 24 * 3600 * 1000);
      const { data } = await db
        .from('events')
        .select('character_name, metadata, created_at')
        .eq('type', 'death')
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString())
        .limit(20);
      const rows = (data || []).filter((r) => (r.character_name || '').trim());
      if (rows.length) {
        const r = rows[Math.floor(rand() * rows.length)];
        // Noun phrase, always: the callback templates drop {cause} mid-sentence.
        const cause = typeof r.metadata?.cause === 'string' && r.metadata.cause.trim()
          ? r.metadata.cause.trim()
          : 'something nobody wrote down';
        return { span: span.label, name: (r.character_name || '').trim(), cause };
      }
    }
    return null;
  }

  // Online character names, sorted so a seeded pick is stable across ticks.
  async function onlineRoster() {
    const { data, error } = await db.from('players').select('character_name, is_online');
    if (error) {
      log.warn?.(`[voice] roster read failed: ${error.message}`);
      return [];
    }
    return (data || [])
      .filter((p) => p.is_online && String(p.character_name || '').trim())
      .map((p) => String(p.character_name).trim())
      .sort();
  }

  // Has the saga recorded NOTHING for 45 minutes? A read failure counts as a
  // busy hall, so a broken query can never invent a quiet night.
  async function hallHasBeenQuiet() {
    const since = new Date(Date.now() - WHISPER_QUIET_MS).toISOString();
    const { data, error } = await db
      .from('events')
      .select('id')
      .gte('created_at', since)
      .limit(1);
    if (error) {
      log.warn?.(`[voice] quiet check failed, treating the hall as busy: ${error.message}`);
      return false;
    }
    return (data || []).length === 0;
  }

  // Whispers on quiet nights: candidates for the ambient slot when the hall is
  // nearly empty. Returns [] when the night doesn't qualify — then the normal
  // atmosphere/callback pools run, untouched. This is a POOL SWAP, never an
  // extra line: the 2h clock and VOICE_MIN_GAP_MS still decide *when*.
  async function buildWhispers(status, rand = Math.random) {
    // Presence must be unambiguous: whispers lean on WHO is in the hall, so an
    // empty/stale roster, or one that disagrees with server_status, says
    // nothing clever and lets the normal pools run.
    const roster = await onlineRoster();
    const count = roster.length;
    if (count < 1 || count > WHISPER_CREW_MAX) return [];
    const reported = status.playerCount | 0;
    if (reported > 0 && reported !== count) return [];

    let pool;
    let prefix;
    if (count === 1) {
      pool = SOLO_WHISPERS;
      prefix = 'solo';
    } else {
      if (!(await hallHasBeenQuiet())) return [];
      pool = CREW_WHISPERS;
      prefix = 'crew';
    }

    // One viking, picked deterministically from the (sorted) online roster.
    const named = roster[Math.floor(rand() * roster.length)];
    return pool.map((text, i) => ({
      id: `${prefix}:${i}`,
      source: 'whisper',
      text: text.replace(/\{firstName\}/g, firstName(named)),
    }));
  }

  // No-repeat guard: prefer templates outside the last RECENT_KEEP uses.
  function chooseFresh(cand, v, rand) {
    const recent = v.recentTemplates || [];
    const fresh = cand.filter((c) => !recent.includes(c.id));
    const pool = fresh.length ? fresh : cand;
    return pool[Math.floor(rand() * pool.length)];
  }

  // Weighted category pick + no-repeat guard. Deterministic-ish per world-day.
  // Dawn lines are NOT in this pool — they run on their own every-3rd-day clock.
  async function pickAmbient(status) {
    const v = st();
    const rand = mulberry32(((status.worldDay | 0) * 1000 + (v.ambientCount | 0)) >>> 0);

    // A quiet night takes the slot before the normal pools are ever consulted.
    const whispers = await buildWhispers(status, rand);
    if (whispers.length) return chooseFresh(whispers, v, rand);

    const roll = rand();
    // ≈ atmosphere 65% / callback 35% (callback only if a dated death exists;
    // atmosphere is always non-empty, so callback only runs its DB read when it
    // wins the FIRST slot — keeping ticks cheap).
    const order = roll < 0.35 ? ['callback', 'atmosphere'] : ['atmosphere', 'callback'];

    for (const cat of order) {
      const cand = await buildCategory(cat, status, rand);
      if (!cand.length) continue;
      return chooseFresh(cand, v, rand);
    }
    return null;
  }

  async function queueAmbient(status) {
    const v = st();
    const pick = await pickAmbient(status);
    if (!pick) return false;
    const ok = await enqueue(pick.text, 'ambient', {
      template: pick.id,
      world_day: status.worldDay,
      ...(pick.source ? { source: pick.source } : {}),
    });
    if (!ok) return false;
    v.ambientCount = (v.ambientCount | 0) + 1;
    v.recentTemplates = [...(v.recentTemplates || []), pick.id].slice(-RECENT_KEEP);
    log.info?.(`[voice] ambient queued (${pick.id})`);
    return true;
  }

  // ── dawn: every 3rd world day, once, only to a populated hall ─────────────
  // Independent of the 2h ambient clock and exempt from VOICE_MIN_GAP_MS. The
  // once-per-day guard is an equality check, so a world wipe (day counter back
  // to 1) starts the cycle over instead of going silent.
  async function checkDawn(status) {
    const v = st();
    const day = status.worldDay | 0;
    if (!(day > 0) || day % DAWN_EVERY_DAYS !== 0) return false;
    if ((status.playerCount ?? 0) <= 0) return false;
    if (v.lastDawnDay === day) return false;

    const rand = mulberry32(((day * 7919) >>> 0));
    const cand = DAWN.map((t, i) => ({ id: `dawn:${i}`, text: t.replace(/\{day\}/g, String(day)) }));
    const recent = v.recentTemplates || [];
    const fresh = cand.filter((c) => !recent.includes(c.id));
    const pool = fresh.length ? fresh : cand;
    const pick = pool[Math.floor(rand() * pool.length)];

    const ok = await enqueue(pick.text, 'ambient', {
      source: 'dawn',
      template: pick.id,
      world_day: day,
    });
    if (!ok) return false;
    v.lastDawnDay = day;
    v.recentTemplates = [...recent, pick.id].slice(-RECENT_KEEP);
    log.info?.(`[voice] dawn line queued for day ${day} (${pick.id})`);
    return true;
  }

  // ── event lines (immediate; exempt from every gap, reset the ambient clock) ─

  // In-game oaths: echo in-game + cross-post to Discord, then mark announced.
  // Channel: env OATH_CHANNEL ('server' during the rehearsal pilot, default
  // 'valheim' — revert/remove at launch alongside RECAP_CHANNEL/MILESTONE_CHANNEL).
  const OATH_CHANNEL = process.env.OATH_CHANNEL === 'server' ? 'server' : 'valheim';
  async function checkOathEchoes() {
    if (!writeDb) return 0;
    const { data, error } = await writeDb
      .from('oaths')
      .select('id, character_name, oath_text')
      .eq('source', 'ingame')
      .is('announced_at', null)
      .limit(10);
    if (error) {
      log.error?.(`[voice] oath echo query: ${error.message}`);
      return 0;
    }
    let n = 0;
    for (const o of data || []) {
      const name = (o.character_name || '').trim() || 'A viking';
      await enqueue(`Eilif heard you, ${firstName(name)}. These walls will hold you to it.`, 'event', {
        source: 'oath',
        oath_id: o.id,
      });
      try {
        await post(OATH_CHANNEL, {
          embeds: [
            {
              title: '📜 A new oath is sworn',
              description: `**${name}** swore on the charter, and the hall heard it.\n\n_"${o.oath_text}"_`,
              color: 0xc8952a,
              footer: { text: 'Eilif · The Cozy Canon Playthrough' },
            },
          ],
        });
      } catch (e) {
        log.error?.(`[voice] oath cross-post: ${e.message}`);
      }
      await writeDb.from('oaths').update({ announced_at: new Date().toISOString() }).eq('id', o.id);
      n++;
    }
    return n;
  }

  // Per-player death milestones: 20, 50, 100, then every +100 deaths, once each.
  // Deaths come from player_stats (the cumulative per-character counter the
  // dashboard already trusts), joined to players for the name.
  async function checkDeathMilestones() {
    const v = st();
    const [playersRes, statsRes] = await Promise.all([
      db.from('players').select('id, character_name'),
      db.from('player_stats').select('player_id, deaths'),
    ]);
    if (playersRes.error || statsRes.error) {
      log.warn?.('[voice] death milestone read failed — skipping this tick');
      return 0;
    }

    const idToName = new Map();
    for (const p of playersRes.data || []) {
      const nm = (p.character_name || '').trim();
      if (nm) idToName.set(p.id, nm);
    }
    // Keyed by NAME, keeping the highest count: duplicate players rows (the
    // 2026-07-25 Testman incident) must never split or multiply a viking's tally.
    const deathsByName = new Map();
    for (const s of statsRes.data || []) {
      const nm = idToName.get(s.player_id);
      if (!nm) continue;
      const n = Math.floor(Number(s.deaths) || 0);
      deathsByName.set(nm, Math.max(deathsByName.get(nm) ?? 0, n));
    }
    if (deathsByName.size === 0) return 0;

    // First pass after this mechanic shipped: adopt everyone's CURRENT tier
    // silently, so a roster that already died plenty doesn't get a storm of
    // back-dated proclamations. Vikings who appear later start from tier 0.
    if (!v.deathTiersSeeded) {
      for (const [name, deaths] of deathsByName) {
        const tier = deathTier(deaths);
        if (tier > 0) v.deathTiers[name] = tier;
      }
      v.deathTiersSeeded = true;
      log.info?.(`[voice] death tiers seeded silently for ${deathsByName.size} viking(s)`);
      return 0;
    }

    let n = 0;
    for (const [name, deaths] of deathsByName) {
      const tier = deathTier(deaths);
      if (tier <= 0) continue;
      const last = Math.floor(Number(v.deathTiers[name]) || 0);
      if (tier <= last) continue;
      const ok = await enqueue(deathMilestoneLine(tier, name), 'event', {
        source: 'deaths',
        player: name,
        tier,
        deaths,
      });
      if (ok) {
        v.deathTiers[name] = tier;
        n++;
        log.info?.(`[voice] death milestone ${tier} announced for ${name}`);
      }
    }
    return n;
  }

  // ── POTY coronation (called by recap.js at the poty_history insert) ───────
  async function announcePoty(poty, worldDay = null) {
    if (!poty?.name) return;
    const name = String(poty.name).trim();
    await enqueue(
      `The crown goes to ${firstName(name)} tonight. Eilif will remember it come morning.`,
      'event',
      { source: 'poty', poty: name, award: poty.key, world_day: worldDay },
    );
    st().onlineMinutes = 0; // an event line resets the ambient clock
    await saveState();
    log.info?.(`[voice] POTY coronation queued for ${name}`);
  }

  // ── housekeeping: expire stale queued lines (never flood on server return) ─
  async function expireStale() {
    if (!writeDb) return;
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const { error } = await writeDb
      .from('voice_lines')
      .update({ status: 'spoken', spoken_at: new Date().toISOString() })
      .eq('status', 'queued')
      .lt('queued_at', cutoff);
    if (error) log.error?.(`[voice] expire stale: ${error.message}`);
  }

  // ── the 60s tick ──────────────────────────────────────────────────────────
  async function tick() {
    if (!writeDb) return;
    const v = st();
    await expireStale();

    const status = await readStatus();

    // Immediate event lines first — exempt from every gap; they reset the
    // ambient clock so Eilif doesn't follow a proclamation with small talk.
    let events = 0;
    events += await checkOathEchoes();
    events += await checkDeathMilestones();

    // Dawn rides its own every-3rd-day clock, gap-exempt, never to an empty hall.
    const dawn = await checkDawn(status);

    if (events > 0) {
      v.onlineMinutes = 0; // a presence, not a chatterbox
    } else if ((status.playerCount ?? 0) > 0) {
      // Accumulate someone-online time; one ambient line per ~2h, and never
      // within the global min-gap of the last voice line of ANY kind.
      v.onlineMinutes = (v.onlineMinutes || 0) + TICK_MS / 60000;
      if (v.onlineMinutes >= CADENCE_MINUTES && !dawn) {
        const owed = await ambientGapRemaining();
        if (owed > 0) {
          // Hold the accumulator and retry next tick — the cadence is owed, the
          // hall just spoke too recently.
          log.info?.(`[voice] ambient held ${Math.round(owed / 1000)}s for the min-gap`);
        } else if (await queueAmbient(status)) {
          v.onlineMinutes = 0;
        }
      }
    }
    await saveState();
  }

  // ── puppet mode: `@Eilif say: <line>` from an Administrator ────────────────
  async function handleMessage(message) {
    try {
      if (!writeDb) return;
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user)) return;

      // Parse the say-command BEFORE anything else, but only for admins — so an
      // ordinary member's message falls straight through to the oath ingest.
      const stripped = (message.content ?? '')
        .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
        .trim();
      const m = stripped.match(/^say\s*:\s*([\s\S]+)$/i);
      if (!m) return;

      const isAdmin = message.member?.permissions?.has?.('Administrator');
      if (!isAdmin) return; // non-admins: ignore silently

      const line = m[1].trim();
      if (!line) return;

      const ok = await enqueue(line, 'manual', {
        by: message.member?.displayName ?? message.author.username,
        discord_id: message.author.id,
      });
      if (ok) {
        st().onlineMinutes = 0; // manual line resets the ambient clock
        await saveState();
        await message.react('🗣️').catch(() => {});
        log.info?.(`[voice] manual line by ${message.author.username}: ${line.slice(0, 60)}`);
      }
    } catch (e) {
      log.error?.(`[voice] say: ${e.message}`);
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
    log.info?.(
      `[voice] engine active — ambient every ${CADENCE_MINUTES}m online-time (min gap ${Math.round(gapMs / 60000)}m), ` +
      `dawn every ${DAWN_EVERY_DAYS} world days, events exempt; admins: \`@Eilif say: <line>\``,
    );
  }

  return {
    tick,
    attach,
    announcePoty,
    handleMessage,
    pickAmbient,
    _state: st,
    _checkDawn: checkDawn,
    _buildWhispers: buildWhispers,
    _checkDeathMilestones: checkDeathMilestones,
    _ambientGapRemaining: ambientGapRemaining,
  };
}
