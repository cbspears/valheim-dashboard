// The Voice of the Hall — Eilif's brain.
//
// A server-side game plugin polls GET /api/voice and SPEAKS queued lines
// in-game as "Eilif". THIS module decides what gets queued and when, writing
// rows to the `voice_lines` table (service-role). It is a presence, not a
// chatterbox: roughly ONE ambient line per 2 hours of someone-online time,
// never to an empty hall. Event lines (POTY crown, death milestones, first
// biome, in-game oaths) bypass the cadence and reset its clock. Admins can
// also puppet Eilif with `@Eilif say: <line>`.
//
// Voice matches the saga register of format.js — evocative, dry, never
// mechanical. Gated behind VOICE_ENGINE=1 (see index.js), like GALLERY_INGEST.

import { serviceClient } from './supabase.js';

const TICK_MS = 60_000;                 // the caller ticks us every 60s
const CADENCE_MINUTES = 120;            // one ambient line per ~2h online-time
const STALE_MS = 24 * 3600 * 1000;      // queued-but-unspoken lines expire after 24h
const DEATH_MILESTONE_STEP = 50;        // announce every Nth warband death
const RECENT_KEEP = 5;                  // no template repeats within its last 5 uses
const ANNOUNCED_CAP = 200;              // bound the discovery-dedupe list

// ── Content bank (saga register — match format.js) ────────────────────────

// (a) Day-cycle ambience — the current world day rides in as {day}.
const DAY_CYCLE = [
  'Day {day}. The mists have not lifted, and neither have we.',
  'Day {day} in the realm. The longfire holds; so does the clan.',
  'Another dawn tallied — day {day}. The dead keep count more carefully than we do.',
  'Day {day}. Somewhere a greydwarf gnaws a fence, patient as the tide.',
  'The saga turns to day {day}. Old horns, new hangovers.',
  'Day {day}, and the sea is still hungry. It always is.',
  'Day {day}. The Allfather watches the ones who rise before the ravens.',
];

// (c) Pure atmosphere — no data, just weather in the bones.
const ATMOSPHERE = [
  'The wind carries the smell of pine and old smoke. A good omen, or none at all.',
  'Somewhere out past the fog, something large turned over in its sleep. Best not to wake it.',
  'The mead is warm, the night is long, and the trolls are only mostly asleep.',
  'A raven circled the hall three times, then thought better of it. Wise bird.',
  'The longhouse creaks like an old ship. It remembers every viking who leaned on it.',
  'Rain on the roof, wolves at the treeline. The realm keeps its own counsel tonight.',
  'The forge has gone cold, but the coals still whisper of the blades to come.',
  'Out on the black water the serpents wait, patient as grudges.',
  'The stones by the fire have heard a hundred oaths. They keep them all.',
  'Quiet in the hall — the kind of quiet that comes before a good story or a bad death.',
];

// (b) Callbacks — dated deaths from ~1/2/4 weeks ago, phrased darkly. {span}
// is the time-ago label, {name}/{cause} come from the archived event.
const CALLBACK_TEMPLATES = [
  '{span} this night, {name} was taken — {cause}. The realm remembers. So do the things that did it.',
  '{span}, the hall lost {name} to the dark: {cause}. A saga is only the deaths we choose to retell.',
  'Cast your horn back {span}: {name} fell, and {cause}. The ravens have not forgotten the meal.',
  '{span} {name} met the void — {cause}. The gods keep a stool warm for the bold.',
];

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

export function createVoiceEngine({ client, db, post, state, saveState, log = console, writeDb: injectedWriteDb }) {
  // `injectedWriteDb` is a test seam; production builds the real service client.
  const writeDb = injectedWriteDb ?? (process.env.SUPABASE_SERVICE_ROLE_KEY ? serviceClient() : null);
  if (!writeDb) {
    log.warn?.('[voice] no SUPABASE_SERVICE_ROLE_KEY — voice engine disabled (reads only)');
  }

  function st() {
    if (!state.voice) {
      state.voice = {
        onlineMinutes: 0,       // cadence accumulator (someone-online minutes)
        ambientCount: 0,        // total ambient lines queued (variety seed)
        recentTemplates: [],    // last RECENT_KEEP template ids (no-repeat)
        lastDeathMilestone: 0,  // highest death-count multiple already announced
        announcedDiscoveries: [], // discovery event ids already welcomed
      };
    }
    return state.voice;
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

  // ── ambient content selection ────────────────────────────────────────────

  // Build the candidate lines for one category as {id, text}. Callback candidates
  // require a DB read, so they're only built when the roll actually lands there.
  async function buildCategory(cat, status, rand) {
    if (cat === 'dayCycle') {
      return DAY_CYCLE.map((t, i) => ({ id: `day:${i}`, text: t.replace(/\{day\}/g, status.worldDay) }));
    }
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
        const cause = typeof r.metadata?.cause === 'string' && r.metadata.cause.trim()
          ? r.metadata.cause.trim()
          : 'the realm took its due';
        return { span: span.label, name: (r.character_name || '').trim(), cause };
      }
    }
    return null;
  }

  // Weighted category pick + no-repeat guard. Deterministic-ish per world-day.
  async function pickAmbient(status) {
    const v = st();
    const rand = mulberry32(((status.worldDay | 0) * 1000 + (v.ambientCount | 0)) >>> 0);
    const roll = rand();
    // ≈ atmosphere 40% / day-cycle 35% / callback 25% (callback only if data exists;
    // day-cycle & atmosphere are always non-empty, so callback only runs its DB
    // read when it wins the FIRST slot — keeping ticks cheap).
    let order;
    if (roll < 0.25) order = ['callback', 'atmosphere', 'dayCycle'];
    else if (roll < 0.6) order = ['dayCycle', 'atmosphere', 'callback'];
    else order = ['atmosphere', 'dayCycle', 'callback'];

    for (const cat of order) {
      const cand = await buildCategory(cat, status, rand);
      if (!cand.length) continue;
      const recent = v.recentTemplates || [];
      const fresh = cand.filter((c) => !recent.includes(c.id));
      const pool = fresh.length ? fresh : cand;
      return pool[Math.floor(rand() * pool.length)];
    }
    return null;
  }

  async function queueAmbient(status) {
    const v = st();
    const pick = await pickAmbient(status);
    if (!pick) return false;
    const ok = await enqueue(pick.text, 'ambient', { template: pick.id, world_day: status.worldDay });
    if (!ok) return false;
    v.ambientCount = (v.ambientCount | 0) + 1;
    v.recentTemplates = [...(v.recentTemplates || []), pick.id].slice(-RECENT_KEEP);
    log.info?.(`[voice] ambient queued (${pick.id})`);
    return true;
  }

  // ── event lines (immediate; bypass cadence, reset the clock) ──────────────

  // In-game oaths: echo in-game + cross-post to #valheim, then mark announced.
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
      await enqueue(`The hall heard you, ${firstName(name)}.`, 'event', { oath_id: o.id });
      try {
        await post('valheim', {
          embeds: [
            {
              title: '📜 A new oath is sworn',
              description: `**${name}** has sworn upon the charter:\n\n_"${o.oath_text}"_`,
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

  // Death milestones: every Nth warband death crosses a threshold once.
  async function checkDeathMilestone() {
    const v = st();
    const { count, error } = await db
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'death');
    if (error || count == null) return 0;
    const milestone = Math.floor(count / DEATH_MILESTONE_STEP) * DEATH_MILESTONE_STEP;
    if (milestone >= DEATH_MILESTONE_STEP && milestone > (v.lastDeathMilestone || 0)) {
      const ok = await enqueue(
        `That was the warband's ${milestone}th death. The ravens grow fat.`,
        'event',
        { death_total: count, milestone },
      );
      if (ok) {
        v.lastDeathMilestone = milestone;
        log.info?.(`[voice] death milestone ${milestone} announced`);
        return 1;
      }
    }
    return 0;
  }

  // First-biome discoveries: welcome a viking into a new land, once per event.
  async function checkDiscoveries() {
    const v = st();
    const { data, error } = await db
      .from('events')
      .select('id, character_name, metadata, created_at')
      .eq('type', 'discovery')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return 0;
    const seen = new Set(v.announcedDiscoveries || []);
    let n = 0;
    for (const ev of data || []) {
      if (seen.has(ev.id)) continue;
      const biome = biomeFromDiscovery(ev.metadata);
      if (!biome) continue; // not a first-biome discovery we can phrase
      const name = (ev.character_name || '').trim() || 'A viking';
      const ok = await enqueue(
        `${firstName(name)} has set foot in the ${biome} where none of the clan had walked. New horizons, new ways to be eaten.`,
        'event',
        { discovery_id: ev.id, biome },
      );
      if (ok) {
        seen.add(ev.id);
        n++;
      }
    }
    // remember what we've welcomed (bounded) so restarts don't re-welcome
    v.announcedDiscoveries = [...seen].slice(-ANNOUNCED_CAP);
    if (n) log.info?.(`[voice] welcomed ${n} new-biome discovery(ies)`);
    return n;
  }

  // Pull a biome name out of a discovery event's metadata, if it looks like a
  // first-time biome entry. Lenient about the exact shape the log poller emits.
  function biomeFromDiscovery(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const biome = [meta.biome, meta.region, meta.location, meta.detail]
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .find(Boolean);
    if (!biome) return null;
    // If the event carries an explicit not-first flag, skip it; otherwise a
    // discovery event is treated as a first entry (idempotent via the id set).
    if (meta.first === false || meta.first_time === false) return null;
    return biome;
  }

  // ── POTY coronation (called by recap.js at the poty_history insert) ───────
  async function announcePoty(poty, worldDay = null) {
    if (!poty?.name) return;
    const name = String(poty.name).trim();
    await enqueue(`The hall has spoken. Tonight the crown rests on ${firstName(name)}.`, 'event', {
      poty: name,
      award: poty.key,
      world_day: worldDay,
    });
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

    // Immediate event lines first — they bypass the cadence and reset its clock.
    let events = 0;
    events += await checkOathEchoes();
    events += await checkDeathMilestone();
    events += await checkDiscoveries();

    if (events > 0) {
      v.onlineMinutes = 0; // a presence, not a chatterbox
    } else if (status.playerCount > 0) {
      // Accumulate someone-online time; queue one ambient line per ~2h.
      v.onlineMinutes = (v.onlineMinutes || 0) + TICK_MS / 60000;
      if (v.onlineMinutes >= CADENCE_MINUTES) {
        await queueAmbient(status);
        v.onlineMinutes = 0;
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
    log.info?.('[voice] engine active — ambient cadence + events; admins: `@Eilif say: <line>`');
  }

  return { tick, attach, announcePoty, handleMessage, pickAmbient, _state: st };
}
