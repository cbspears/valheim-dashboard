// Boss polls — "Who lands first blood on <next boss>?"
//
// When a boss flips to felled and there is still a boss left on the ladder, the
// bot posts ONE native Discord poll (the v14 message `poll` option) naming the
// next objective, with up to ten answers: the vikings who put in the most hours
// this week. Single choice, seven-day window. When that boss later falls, one
// follow-up line names who actually drew first blood (bosses.fight_stats
// .firstBlood) and whether the hall called it.
//
// OFF BY DEFAULT. index.js only builds this when BOSS_POLLS=1, so nothing
// changes on launch night unless the flag is flipped.
//
// WHY IT WATCHES THE TABLE ITSELF instead of hooking bosses.js: the boss
// watcher owns exactly-once @everyone delivery through its own `state
// .announcedBosses` set, and a second consumer inside it would couple two
// independent dedupe questions. This keeps its own cursor
// (`state.bossPolls.knownFelled`), seeded on first run so switching the flag on
// mid-season never fires a poll for a boss felled last month.
//
// READ-ONLY against Supabase (selects only). The only writes are state.json and
// the poll message itself, which goes through an injected adapter — the dry run
// hands in a printer, so a rehearsal cannot reach Discord.

/** Poll answers a Discord poll may carry. Hard API limit. */
export const MAX_POLL_ANSWERS = 10;
/** Below this many candidates a poll is not worth posting; it retries later. */
export const MIN_POLL_ANSWERS = 2;
/** Discord limits: question 300 chars, answer 55. */
const MAX_QUESTION = 300;
const MAX_ANSWER = 55;
/** Seven days, in hours (the poll `duration` unit). */
export const POLL_DURATION_HOURS = 168;
/** Window used to rank "most active this week". */
export const CANDIDATE_WINDOW_DAYS = 7;
/** Give up on a boss after this many consecutive post failures. */
const MAX_POST_FAILURES = 3;

import { sessionHours, pickTopHours } from './chronicle.js';

function escapeMd(s) {
  return String(s).replace(/([*_`~])/g, '\\$1');
}

function clip(s, max) {
  const t = String(s ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// --- pure selection ---------------------------------------------------------

/**
 * Who goes on the ballot: the vikings with the most played hours in the trailing
 * window, hours DESC then name ASC, capped at ten (the API's own limit).
 *
 * Pure. Ranking is shared with the weekly Chronicle's hours board on purpose, so
 * "most active this week" means the same thing in both features.
 */
export function pickPollCandidates(sessions, { nowMs = Date.now(), days = CANDIDATE_WINDOW_DAYS, max = MAX_POLL_ANSWERS } = {}) {
  const startMs = nowMs - days * 24 * 3600 * 1000;
  const { hours } = sessionHours(sessions, startMs, nowMs);
  return pickTopHours(hours, max).map((r) => r.name);
}

/**
 * The next objective after `felled`: the first boss on the ladder that is still
 * standing. Null when the ladder is finished. Pure.
 */
export function nextObjective(bosses = []) {
  return (
    [...(bosses || [])]
      .filter((b) => b && !b.is_killed)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0] || null
  );
}

// --- pure copy --------------------------------------------------------------

/**
 * The poll message. Plain label first, Norse flavor in the line under it; the
 * poll question itself stays a plain question.
 */
export function buildBossPoll({ bossName, candidates, durationHours = POLL_DURATION_HOURS }) {
  const name = clip(bossName, 60);
  // Clipping two very long names could collapse them into the same answer text,
  // which Discord rejects outright. Dedupe after clipping, never before.
  const answers = [];
  const seen = new Set();
  for (const c of candidates || []) {
    const text = clip(c, MAX_ANSWER);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    answers.push({ text });
    if (answers.length >= MAX_POLL_ANSWERS) break;
  }
  return {
    content:
      `**First blood: ${escapeMd(name)}**\n` +
      'Vote for the viking you think draws it. The book records who was right.',
    poll: {
      question: { text: clip(`Who lands first blood on ${name}?`, MAX_QUESTION) },
      answers,
      duration: durationHours,
      allowMultiselect: false,
    },
  };
}

/**
 * "6 of 11 votes" / "1 of 1 vote". The total can never be smaller than the
 * winning answer's own count: a truncated or half-read poll result must not
 * publish "5 of 0 votes".
 */
function voteTally(votes, total) {
  const n = Math.max(Number(votes) || 0, 0);
  const t = Math.max(Number(total) || 0, n);
  return `${n} of ${t} vote${t === 1 ? '' : 's'}`;
}

/** Two viking names the game would treat as the same person. */
function sameViking(a, b) {
  return Boolean(a) && Boolean(b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * The single follow-up line, posted when the boss the poll asked about falls.
 * Pure; every branch is one sentence pair and none of them use a dash.
 *
 * arg = { bossName, firstBlood, crowdPick, crowdVotes, totalVotes }
 *   firstBlood — bosses.fight_stats.firstBlood, or null when nothing recorded it
 *   crowdPick  — the poll's leading answer, or null (no votes / unreadable poll)
 */
export function formatFirstBlood({ bossName, firstBlood, crowdPick, crowdVotes = 0, totalVotes = 0 }) {
  const boss = escapeMd(clip(bossName, 60));
  const fb = firstBlood ? escapeMd(clip(firstBlood, 24)) : null;
  const pick = crowdPick ? escapeMd(clip(crowdPick, 24)) : null;

  // Compare the RAW names, not the escaped-and-clipped render: a 30-char name
  // clips differently on the two sides, and a case difference between the
  // ballot and fight_stats would otherwise read as a missed call.
  if (fb && pick && sameViking(firstBlood, crowdPick)) {
    return {
      content: `⚔️ First blood on **${boss}**: **${fb}**. The hall called it, with ${voteTally(crowdVotes, totalVotes)}.`,
    };
  }
  if (fb && pick) {
    return {
      content: `⚔️ First blood on **${boss}**: **${fb}**. The hall had put its ${voteTally(crowdVotes, totalVotes)} on **${pick}**, so the wager comes to nothing.`,
    };
  }
  if (fb) {
    return {
      content: `⚔️ First blood on **${boss}**: **${fb}**. Nobody voted, so nobody gets to say they called it.`,
    };
  }
  if (pick) {
    return {
      content: `⚔️ **${boss}** has fallen, but the first strike went unrecorded. The hall had picked **${pick}**.`,
    };
  }
  return {
    content: `⚔️ **${boss}** has fallen. The first strike went unrecorded, and no votes were cast.`,
  };
}

/**
 * Leading answer of a poll result, or null when nothing was voted for.
 * Ties break on the answer text so the same result always reads the same way.
 * Pure. results = { answers: [{ text, votes }], totalVotes }
 */
export function crowdFavourite(results) {
  const answers = (results?.answers || []).filter((a) => a && a.text && (a.votes || 0) > 0);
  if (!answers.length) return null;
  const top = [...answers].sort(
    (a, b) => (b.votes || 0) - (a.votes || 0) || String(a.text).toLowerCase().localeCompare(String(b.text).toLowerCase())
  )[0];
  return { text: top.text, votes: top.votes || 0, totalVotes: results.totalVotes || 0 };
}

// --- adapters ---------------------------------------------------------------
//
// The poster in discord.js only speaks {content, embeds}; polls need the raw
// channel, and reading a poll back needs the gateway client. Both live behind
// this two-method adapter so the loop below never touches discord.js and the
// dry run can hand in a printer.

/** Real adapter: sends through the gateway client, reads results back. */
export function createDiscordPollAdapter({ client, channelIds }) {
  const channelFor = async (key) => {
    const id = channelIds[key];
    if (!id) throw new Error(`no channel id configured for "${key}"`);
    const ch = await client.channels.fetch(id);
    if (!ch) throw new Error(`channel "${key}" (${id}) not found`);
    return ch;
  };

  return {
    async postPoll(channelKey, payload) {
      const ch = await channelFor(channelKey);
      const msg = await ch.send({
        content: payload.content,
        poll: payload.poll,
        allowedMentions: { parse: [] },
      });
      return { messageId: msg.id, channelId: ch.id };
    },
    /** Live vote counts. Null when the message or its poll is gone. */
    async fetchPollResults(channelKey, messageId) {
      try {
        const ch = await channelFor(channelKey);
        const msg = await ch.messages.fetch(messageId);
        const poll = msg?.poll;
        if (!poll) return null;
        const answers = [...poll.answers.values()].map((a) => ({ text: a.text, votes: a.voteCount || 0 }));
        return { answers, totalVotes: answers.reduce((sum, a) => sum + a.votes, 0) };
      } catch (e) {
        console.warn(`[boss-polls] could not read poll ${messageId}: ${e.message}`);
        return null;
      }
    },
  };
}

/** Dry-run adapter: prints the poll it would send, never logs in, reads nothing. */
export function createDryRunPollAdapter() {
  let n = 0;
  return {
    async postPoll(channelKey, payload) {
      n += 1;
      const out = [`\n[dry-run poll → #${channelKey}]`];
      if (payload.content) out.push(`  ${payload.content.replace(/\n/g, '\n  ')}`);
      out.push(`  ❓ ${payload.poll.question.text}`);
      for (const a of payload.poll.answers) out.push(`   ○ ${a.text}`);
      out.push(
        `  (${payload.poll.answers.length} answers, ${payload.poll.duration}h, ` +
          `${payload.poll.allowMultiselect ? 'multi' : 'single'} choice)`
      );
      console.log(out.join('\n'));
      return { messageId: `dry-run-poll-${n}`, channelId: null };
    },
    async fetchPollResults() {
      console.log('  [dry-run poll] results are not read (no gateway); the follow-up renders without a crowd pick');
      return null;
    },
  };
}

// --- the loop ---------------------------------------------------------------

export function createBossPolls({
  db,
  post,
  adapter,
  state,
  saveState,
  channel = 'valheim',
  days = CANDIDATE_WINDOW_DAYS,
  durationHours = POLL_DURATION_HOURS,
}) {
  // In-memory so a "not enough vikings yet" notice is logged once per boss and
  // not on every tick for a week.
  const warned = new Set();

  const store = () => {
    if (!state.bossPolls || typeof state.bossPolls !== 'object') state.bossPolls = {};
    const s = state.bossPolls;
    if (!Array.isArray(s.knownFelled)) s.knownFelled = null; // null = unseeded
    if (!s.polls || typeof s.polls !== 'object') s.polls = {};
    if (!s.failures || typeof s.failures !== 'object') s.failures = {};
    // The boss a poll is owed for but could not be opened yet (too few vikings
    // active this week). Persisted so a restart does not lose the question.
    if (!s.pending || typeof s.pending !== 'object') s.pending = null;
    return s;
  };

  async function fetchBosses() {
    const { data, error } = await db
      .from('bosses')
      .select('id, name, biome, sort_order, is_killed, killed_at, fight_stats')
      .order('sort_order');
    if (error) throw new Error(`bosses query: ${error.message}`);
    return data || [];
  }

  /**
   * Seed the felled cursor with whatever is already dead, so turning the flag on
   * mid-season never opens a poll for a boss the clan felled weeks ago.
   */
  async function init() {
    const s = store();
    if (Array.isArray(s.knownFelled)) return;
    const bosses = await fetchBosses();
    s.knownFelled = bosses.filter((b) => b.is_killed).map((b) => b.id);
    await saveState();
  }

  async function candidateNames(nowMs) {
    const startIso = new Date(nowMs - days * 24 * 3600 * 1000).toISOString();
    // supabase-js resolves with {data,error} rather than throwing, so an
    // unreadable sessions table would silently look like an empty hall. It is
    // still not fatal (the question stays pending and retries), but it has to
    // say so rather than reading as "nobody played this week".
    const { data: sessions, error } = await db
      .from('sessions')
      .select('character_name, joined_at, left_at')
      .or(`left_at.is.null,left_at.gte.${startIso}`);
    if (error) {
      console.warn(`[boss-polls] sessions read failed, the ballot is empty this tick: ${error.message}`);
      return [];
    }
    return pickPollCandidates(sessions, { nowMs, days });
  }

  /** Open ONE poll for `boss`. Returns true when a poll was actually posted. */
  async function openPoll(boss, triggerName, nowMs) {
    const s = store();
    if (s.polls[boss.id]) return false; // never re-post: one poll per boss, ever
    if ((s.failures[boss.id] || 0) >= MAX_POST_FAILURES) return false;

    const candidates = await candidateNames(nowMs);
    // Count the ANSWERS the payload actually carries, not the candidates: blank
    // names are dropped and two long names can collide into one after clipping,
    // so a two-candidate ballot can build a one-answer (or zero-answer) poll.
    // Discord rejects both, and a rejected poll burns one of the three tries.
    const payload = buildBossPoll({ bossName: boss.name, candidates, durationHours });
    if (payload.poll.answers.length < MIN_POLL_ANSWERS) {
      if (!warned.has(boss.id)) {
        warned.add(boss.id);
        console.log(
          `[boss-polls] only ${payload.poll.answers.length} viking(s) on the ballot for the last ${days}d, holding the ${boss.name} poll until there are ${MIN_POLL_ANSWERS}`
        );
      }
      return false;
    }

    let sent;
    try {
      sent = await adapter.postPoll(channel, payload);
    } catch (e) {
      s.failures[boss.id] = (s.failures[boss.id] || 0) + 1;
      await saveState();
      console.error(
        `[boss-polls] posting the ${boss.name} poll failed (${s.failures[boss.id]}/${MAX_POST_FAILURES}): ${e.message}`
      );
      return false;
    }

    s.polls[boss.id] = {
      bossName: boss.name,
      messageId: sent?.messageId || null,
      channel,
      // The answers as SENT, which is what the follow-up's crowd pick comes
      // back as; `candidates` may hold names the ballot dropped or clipped.
      answers: payload.poll.answers.map((a) => a.text),
      openedAt: new Date(nowMs).toISOString(),
      after: triggerName || null,
      resolvedAt: null,
    };
    await saveState();
    console.log(
      `[boss-polls] opened a first-blood poll for ${boss.name} (${payload.poll.answers.length} answers)`
    );
    return true;
  }

  /** Post the single follow-up line for a boss whose poll is now answerable. */
  async function resolvePoll(boss) {
    const s = store();
    const rec = s.polls[boss.id];
    if (!rec || rec.resolvedAt) return false;

    const fs = boss.fight_stats;
    const firstBlood =
      fs && typeof fs.firstBlood === 'string' && fs.firstBlood.trim() ? fs.firstBlood.trim() : null;

    let favourite = null;
    if (rec.messageId) {
      const results = await adapter.fetchPollResults(rec.channel || channel, rec.messageId);
      favourite = crowdFavourite(results);
    }

    await post(rec.channel || channel, formatFirstBlood({
      bossName: rec.bossName || boss.name,
      firstBlood,
      crowdPick: favourite?.text || null,
      crowdVotes: favourite?.votes || 0,
      totalVotes: favourite?.totalVotes || 0,
    }));

    rec.resolvedAt = new Date().toISOString();
    await saveState();
    console.log(`[boss-polls] resolved the ${rec.bossName} poll (first blood: ${firstBlood || 'unrecorded'})`);
    return true;
  }

  /**
   * One pass: resolve any poll whose boss has since fallen, then open a poll for
   * the next objective behind every newly felled boss.
   * Returns how many messages it sent (polls + follow-ups).
   */
  async function tick(nowMs = Date.now()) {
    const s = store();
    const bosses = await fetchBosses();
    const byId = new Map(bosses.map((b) => [b.id, b]));
    let sent = 0;

    // 1. Outcomes first, so the follow-up lands before the next question.
    for (const bossId of Object.keys(s.polls)) {
      const boss = byId.get(bossId);
      if (!boss || !boss.is_killed) continue;
      if (await resolvePoll(boss)) sent += 1;
    }

    // 2. Newly felled bosses -> the next objective becomes the pending question.
    const known = new Set(Array.isArray(s.knownFelled) ? s.knownFelled : []);
    const fresh = bosses.filter((b) => b.is_killed && !known.has(b.id));
    if (fresh.length) {
      for (const b of fresh) known.add(b.id);
      s.knownFelled = [...known];
      // Several bosses can flip between two ticks; they all point at the same
      // next objective, and openPoll's own guard keeps that to ONE poll.
      const next = nextObjective(bosses);
      if (next) s.pending = { bossId: next.id, after: fresh[fresh.length - 1]?.name || null };
      else console.log('[boss-polls] no boss left on the ladder, so no poll');
      await saveState();
    }

    // 3. Try the pending question. It survives ticks (and restarts) because the
    // ballot needs vikings who actually played this week, and a boss can fall on
    // a night when nobody else has been on.
    if (s.pending) {
      const target = byId.get(s.pending.bossId);
      const stale =
        !target ||
        target.is_killed ||
        Boolean(s.polls[s.pending.bossId]) ||
        (s.failures[s.pending.bossId] || 0) >= MAX_POST_FAILURES;
      if (stale) {
        s.pending = null;
        await saveState();
      } else if (await openPoll(target, s.pending.after, nowMs)) {
        s.pending = null;
        sent += 1;
        await saveState();
      }
    }

    return sent;
  }

  /**
   * DRY RUN ONLY. A live tick can only show the follow-up line on the night a
   * boss actually falls, so a rehearsal would print the poll and never the copy
   * that closes it. This ticks normally, then renders the follow-up for the most
   * recent kill on record so both halves are visible. It reads no votes (there
   * is no gateway), so it always renders the "nobody voted" branch; the other
   * branches are covered by scripts/bosspoll.test.mjs.
   */
  async function rehearseFollowUp() {
    const bosses = await fetchBosses();
    const felled = bosses
      .filter((b) => b.is_killed && b.killed_at)
      .sort((a, b) => Date.parse(b.killed_at) - Date.parse(a.killed_at))[0];
    if (!felled) {
      console.log('  (no boss has fallen yet, so the follow-up line has nothing to rehearse)');
      return 0;
    }
    const fs = felled.fight_stats;
    const firstBlood =
      fs && typeof fs.firstBlood === 'string' && fs.firstBlood.trim() ? fs.firstBlood.trim() : null;
    console.log(`  (rehearsing the follow-up against the most recent kill: ${felled.name})`);
    await post(
      channel,
      formatFirstBlood({ bossName: felled.name, firstBlood, crowdPick: null, crowdVotes: 0, totalVotes: 0 })
    );
    return 1;
  }

  return { init, tick, openPoll, resolvePoll, rehearseFollowUp };
}
