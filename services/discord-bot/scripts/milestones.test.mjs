// Unit tests for the Great Deeds announcer: one announcement moment (Discord
// embed + in-game voice line together), sequential drain, and the
// MILESTONE_MIN_GAP_MS pacing. Run:
//   node scripts/milestones.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { createMilestonesAnnouncer } from '../src/milestones.js';

const silentLog = { info() {}, warn() {}, error() {} };

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

// Chainable fake supabase client (same shape as scripts/voice.test.mjs).
function fakeClient(handler) {
  return {
    from(table) {
      const ops = [];
      const q = {};
      const chain = (name) => (...args) => { ops.push({ op: name, args }); return q; };
      for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'is', 'not', 'order', 'limit', 'update', 'insert', 'upsert', 'delete']) {
        q[m] = chain(m);
      }
      q.maybeSingle = () => Promise.resolve(handler(table, ops, 'maybeSingle'));
      q.single = q.maybeSingle;
      q.then = (onOk, onErr) => Promise.resolve(handler(table, ops, 'list')).then(onOk, onErr);
      return q;
    },
  };
}

function harness({ milestones = [], state = {}, minGapMs, readError = null } = {}) {
  const rows = milestones.map((m) => ({ ...m }));
  const queued = [];   // voice_lines inserts
  const posts = [];    // discord posts
  const handler = (table, ops) => {
    const insert = ops.find((o) => o.op === 'insert');
    if (insert) {
      if (table === 'voice_lines') queued.push(insert.args[0]);
      return { data: null, error: null };
    }
    const update = ops.find((o) => o.op === 'update');
    if (update) {
      const eq = ops.find((o) => o.op === 'eq');
      const row = rows.find((r) => r.id === eq?.args?.[1]);
      if (row) Object.assign(row, update.args[0]);
      return { data: null, error: null };
    }
    if (table === 'milestones') {
      if (readError) return { data: null, error: readError };
      // The polling read carries .limit(1); the progress read does not.
      if (ops.some((o) => o.op === 'limit')) {
        const pending = rows
          .filter((r) => r.achieved_at && !r.announced_at)
          .sort((a, b) => String(a.achieved_at).localeCompare(String(b.achieved_at)));
        return { data: pending.slice(0, 1), error: null };
      }
      return { data: rows, error: null };
    }
    return { data: [], error: null }; // players / player_stats / sessions
  };
  const db = fakeClient(handler);
  const announcer = createMilestonesAnnouncer({
    db,
    writeDb: db,
    post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    channel: 'valheim',
    state,
    saveState: async () => { state._saves = (state._saves || 0) + 1; },
    log: silentLog,
    ...(minGapMs === undefined ? {} : { minGapMs }),
  });
  return { announcer, rows, queued, posts, state };
}

const DEEDS = [
  {
    id: 'run-marathon',
    metric: 'walk_run_total',
    threshold: 42195,
    title: 'The First Marathon',
    line: 'On foot the warband has covered a marathon — {value} metres of mud and bad decisions.',
    equivalence: '≈ 42.2 km',
    achieved_at: '2026-08-22T01:00:00.000Z',
    achieved_value: 42400,
    announced_at: null,
  },
  {
    id: 'sail-skagerrak',
    metric: 'sail_total',
    threshold: 122000,
    title: 'Crossing the Skagerrak',
    line: 'The fleet has sailed as far as Norway is from Denmark.',
    equivalence: 'Skagen to Kristiansand',
    achieved_at: '2026-08-22T01:00:05.000Z',
    achieved_value: 130000,
    announced_at: null,
  },
];

// ── 1. One announcement moment: embed + voice line, then announced_at ─────
{
  const h = harness({ milestones: DEEDS });
  const n = await h.announcer.tick();
  ok(n === 1, `announces one deed per tick, got ${n}`);
  ok(h.posts.length === 1 && h.posts[0].ch === 'valheim', 'posts to the configured channel');

  const embed = h.posts[0].p.embeds[0];
  ok(embed.title === '🏆 A Great Deed: The First Marathon', `embed title, got: ${embed.title}`);
  ok(embed.description === 'On foot the warband has covered a marathon — 42,400 metres of mud and bad decisions.',
    `ceremonial line is the description, {value} interpolated, got: ${embed.description}`);
  ok(embed.fields.some((f) => f.name === 'That is' && f.value === '≈ 42.2 km'), 'equivalence field kept');
  ok(h.posts[0].p.content === undefined, 'no @everyone / plain content');

  ok(h.queued.length === 1, `the voice line fires in the SAME pass, got ${h.queued.length}`);
  ok(h.queued[0].text === embed.description, 'Discord and Eilif say the same words');
  ok(h.queued[0].kind === 'event' && h.queued[0].status === 'queued', 'queued as an event line');
  ok(h.queued[0].meta.source === 'milestone' && h.queued[0].meta.id === 'run-marathon',
    `voice meta carries {source:'milestone', id}, got: ${JSON.stringify(h.queued[0].meta)}`);

  ok(h.rows[0].announced_at != null, 'announced_at stamped so it never re-fires');
  ok(typeof h.state.lastMilestonePostAt === 'string', 'lastMilestonePostAt persisted');
  ok((h.state._saves || 0) >= 1, 'state saved after the announcement');
}

// ── 2. MILESTONE_MIN_GAP_MS holds the next deed, then releases it ─────────
{
  const h = harness({ milestones: DEEDS, minGapMs: 600_000 });
  await h.announcer.tick();
  ok(h.posts.length === 1, 'first deed out');

  const n2 = await h.announcer.tick();
  ok(n2 === 0 && h.posts.length === 1 && h.queued.length === 1,
    'a second deed inside the gap is held (not dropped, not posted)');
  ok(h.rows[1].announced_at == null, 'the held deed is still unannounced');

  // Ten minutes later the queue drains the next one — sequentially, oldest first.
  h.state.lastMilestonePostAt = new Date(Date.now() - 601_000).toISOString();
  const n3 = await h.announcer.tick();
  ok(n3 === 1 && h.posts.length === 2, 'gap elapsed -> the next deed announces');
  ok(h.posts[1].p.embeds[0].title === '🏆 A Great Deed: Crossing the Skagerrak', 'oldest-unannounced first');
  ok(h.queued.length === 2 && h.queued[1].meta.id === 'sail-skagerrak', 'and its voice line fires with it');

  const n4 = await h.announcer.tick();
  ok(n4 === 0, 'nothing left to announce');
}

// ── 3. Gap of 0 drains back-to-back; nothing is ever silenced ────────────
{
  const h = harness({ milestones: DEEDS, minGapMs: 0 });
  await h.announcer.tick();
  await h.announcer.tick();
  ok(h.posts.length === 2 && h.queued.length === 2, 'both deeds announced with the gap disabled');
  ok(h.rows.every((r) => r.announced_at != null), 'both marked announced');
}

// ── 4. Backfilled / already-announced deeds stay silent ─────────────────
{
  const h = harness({
    milestones: [{ ...DEEDS[0], announced_at: '2026-07-05T00:00:00.000Z' }],
    minGapMs: 0,
  });
  const n = await h.announcer.tick();
  ok(n === 0 && h.posts.length === 0 && h.queued.length === 0, 'announced deeds never re-fire');
}

// ── 5. Pre-migration: missing milestones table -> clean skip ─────────────
{
  const h = harness({
    milestones: DEEDS,
    minGapMs: 0,
    readError: { code: '42P01', message: 'relation "public.milestones" does not exist' },
  });
  const n = await h.announcer.tick();
  ok(n === 0 && h.posts.length === 0 && h.queued.length === 0, 'missing table -> skip, no throw');
}

// ── 6. No service-role client -> disabled, no writes attempted ───────────
{
  const posts = [];
  const announcer = createMilestonesAnnouncer({
    db: fakeClient(() => ({ data: [], error: null })),
    writeDb: null,
    post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    log: silentLog,
  });
  const n = await announcer.tick();
  ok(n === 0 && posts.length === 0, 'no write client -> announcer stays quiet');
}

console.log(`milestones.test: ${passed} assertions passed`);
