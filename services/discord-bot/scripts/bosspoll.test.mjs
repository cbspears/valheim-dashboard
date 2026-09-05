// Unit tests for the boss polls: who goes on the ballot, what the poll and the
// follow-up line say, and the state machine that guarantees ONE poll per boss
// and ONE follow-up per poll.
//
// The loop is exercised against a fake Supabase (a thenable chain returning
// canned rows) and a fake poll adapter, so nothing here touches the network or
// discord.js. The rules being defended:
//   • turning the flag on mid-season never polls for a boss felled last month
//   • a poll is posted once and never re-posted, restart or no restart
//   • a boss that falls while too few vikings are active still gets its poll
//     later, not never
//   • the follow-up names first blood exactly once
//
// Run:
//   node scripts/bosspoll.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import {
  MAX_POLL_ANSWERS,
  POLL_DURATION_HOURS,
  pickPollCandidates,
  nextObjective,
  buildBossPoll,
  formatFirstBlood,
  crowdFavourite,
  createBossPolls,
} from '../src/bosspoll.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const NOW = Date.parse('2026-09-13T01:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const session = (name, fromH, toH) => ({
  character_name: name,
  joined_at: hoursAgo(fromH),
  left_at: toH === null ? null : hoursAgo(toH),
});

// ── pickPollCandidates ─────────────────────────────────────────────────────
{
  const rows = [session('Astrid', 10, 2), session('Bjorn', 5, 4), session('Cnut', 30, 20)];
  const picked = pickPollCandidates(rows, { nowMs: NOW });
  eq(picked[0], 'Cnut', 'the ballot leads with the most hours this week');
  eq(picked[1], 'Astrid', 'then the next');
  eq(picked[2], 'Bjorn', 'then the least');

  const many = Array.from({ length: 14 }, (_, i) => session(`V${String(i).padStart(2, '0')}`, i + 2, 1));
  eq(pickPollCandidates(many, { nowMs: NOW }).length, MAX_POLL_ANSWERS,
    `the ballot is capped at Discord's ${MAX_POLL_ANSWERS} answers`);

  const old = [session('Ghost', 24 * 30, 24 * 29)];
  eq(pickPollCandidates(old, { nowMs: NOW }).length, 0, 'somebody who has not played this week is not on the ballot');
  eq(pickPollCandidates(null, { nowMs: NOW }).length, 0, 'a null read is tolerated');
}

// ── nextObjective ──────────────────────────────────────────────────────────
{
  const ladder = [
    { id: 'a', name: 'Eikthyr', sort_order: 1, is_killed: true },
    { id: 'c', name: 'Bonemass', sort_order: 3, is_killed: false },
    { id: 'b', name: 'The Elder', sort_order: 2, is_killed: false },
  ];
  eq(nextObjective(ladder).name, 'The Elder', 'the next objective is the first boss still standing');
  eq(nextObjective(ladder.map((b) => ({ ...b, is_killed: true }))), null, 'a finished ladder has no next objective');
  eq(nextObjective([]), null, 'and neither does an empty read');
}

// ── buildBossPoll ──────────────────────────────────────────────────────────
{
  const poll = buildBossPoll({ bossName: 'Bonemass', candidates: ['Astrid', 'Bjorn', 'Cnut'] });
  eq(poll.poll.question.text, 'Who lands first blood on Bonemass?', 'the question is asked plainly');
  eq(poll.poll.answers.length, 3, 'one answer per candidate');
  eq(poll.poll.answers[0].text, 'Astrid', 'answers are the viking names, unformatted');
  eq(poll.poll.duration, POLL_DURATION_HOURS, 'the poll runs seven days');
  eq(POLL_DURATION_HOURS, 168, 'and seven days is 168 hours, the unit Discord wants');
  eq(poll.poll.allowMultiselect, false, 'single choice');
  ok(poll.content.startsWith('**First blood: Bonemass**'), 'the plain label leads the message');
  ok(!/[—–]/.test(poll.content), 'no em dash or en dash in the message copy');
  ok(!/[—–]/.test(poll.poll.question.text), 'nor in the question');

  const overflow = buildBossPoll({
    bossName: 'Bonemass',
    candidates: Array.from({ length: 14 }, (_, i) => `Viking${i}`),
  });
  eq(overflow.poll.answers.length, MAX_POLL_ANSWERS, 'more than ten candidates are trimmed to ten');

  const longName = 'A'.repeat(90);
  const clipped = buildBossPoll({ bossName: 'Bonemass', candidates: [longName, 'Bjorn'] });
  ok(clipped.poll.answers[0].text.length <= 55, 'an absurd name is clipped to the 55-char answer limit');
  ok(clipped.poll.question.text.length <= 300, 'and the question stays inside 300 chars');

  // Two long names that clip to the same string would be a duplicate answer,
  // which Discord rejects outright.
  const twins = buildBossPoll({ bossName: 'Bonemass', candidates: [`${longName}1`, `${longName}2`, 'Bjorn'] });
  eq(twins.poll.answers.length, 2, 'answers that collide after clipping are deduped');
  eq(new Set(twins.poll.answers.map((a) => a.text)).size, twins.poll.answers.length,
    'so every answer text is unique');
  eq(buildBossPoll({ bossName: 'Bonemass', candidates: ['Astrid', '  ', 'Bjorn'] }).poll.answers.length, 2,
    'and a blank name is never an answer');
}

// ── crowdFavourite ─────────────────────────────────────────────────────────
{
  const top = crowdFavourite({ answers: [{ text: 'Astrid', votes: 2 }, { text: 'Bjorn', votes: 6 }], totalVotes: 8 });
  eq(top.text, 'Bjorn', 'the favourite is the most-voted answer');
  eq(top.votes, 6, 'with its own count');
  eq(top.totalVotes, 8, 'and the total');

  const tie = crowdFavourite({ answers: [{ text: 'Bjorn', votes: 3 }, { text: 'Astrid', votes: 3 }], totalVotes: 6 });
  eq(tie.text, 'Astrid', 'a tie breaks on name so the same result always reads the same way');

  eq(crowdFavourite({ answers: [{ text: 'Astrid', votes: 0 }], totalVotes: 0 }), null, 'nobody voting is no favourite');
  eq(crowdFavourite(null), null, 'an unreadable poll is no favourite');
  eq(crowdFavourite({}), null, 'and neither is an empty result');
}

// ── formatFirstBlood: every branch ─────────────────────────────────────────
{
  const called = formatFirstBlood({ bossName: 'Bonemass', firstBlood: 'Astrid', crowdPick: 'Astrid', crowdVotes: 6, totalVotes: 11 });
  ok(called.content.includes('First blood on **Bonemass**: **Astrid**'), 'the winner is named first');
  ok(called.content.includes('The hall called it'), 'and the crowd is told it was right');
  ok(called.content.includes('6 of 11 votes'), 'with the tally');

  const missed = formatFirstBlood({ bossName: 'Bonemass', firstBlood: 'Astrid', crowdPick: 'Bjorn', crowdVotes: 4, totalVotes: 9 });
  ok(missed.content.includes('**Astrid**'), 'a wrong call still names who actually drew first blood');
  ok(missed.content.includes('**Bjorn**'), 'and names who the hall picked');
  ok(missed.content.includes('comes to nothing'), 'and says the wager failed');

  const silent = formatFirstBlood({ bossName: 'Bonemass', firstBlood: 'Astrid', crowdPick: null });
  ok(silent.content.includes('**Astrid**'), 'with no votes the winner is still named');
  ok(silent.content.includes('Nobody voted'), 'and the silence is stated');

  const unrecorded = formatFirstBlood({ bossName: 'Bonemass', firstBlood: null, crowdPick: 'Bjorn', crowdVotes: 2, totalVotes: 3 });
  ok(unrecorded.content.includes('went unrecorded'), 'a missing fight_stats.firstBlood is admitted, never invented');
  ok(unrecorded.content.includes('**Bjorn**'), 'and the hall pick is still reported');

  const nothing = formatFirstBlood({ bossName: 'Bonemass', firstBlood: null, crowdPick: null });
  ok(nothing.content.includes('has fallen'), 'the quietest branch still announces the kill');
  ok(!nothing.content.includes('undefined'), 'and never renders the word undefined');

  const one = formatFirstBlood({ bossName: 'Bonemass', firstBlood: 'Astrid', crowdPick: 'Astrid', crowdVotes: 1, totalVotes: 1 });
  ok(one.content.includes('1 of 1 vote.'), 'a single vote is singular');

  for (const line of [called, missed, silent, unrecorded, nothing, one]) {
    ok(!/[—–]/.test(line.content), 'no em dash or en dash reaches the players');
    ok(line.content.length <= 2000, 'and the line fits a Discord message');
    ok(line.content.split('\n').length === 1, 'the follow-up is exactly one line');
  }

  const nasty = formatFirstBlood({ bossName: 'Bonemass', firstBlood: 'Bj*rn', crowdPick: null });
  ok(nasty.content.includes('\\*'), 'markdown specials in a name are escaped');

  // The ballot answer and fight_stats.firstBlood come from two different
  // producers (sessions vs the boss payload). Comparing the RENDERED strings
  // made a case difference or a name past the 24-char clip read as a missed
  // call, which is the one branch that must never be wrong: it tells the hall
  // it guessed badly when it guessed right.
  const cased = formatFirstBlood({ bossName: 'Bonemass', firstBlood: 'astrid ', crowdPick: 'Astrid', crowdVotes: 3, totalVotes: 4 });
  ok(cased.content.includes('The hall called it'), 'a case or whitespace difference is still the same viking');

  const longName = `${'Ragnhildr Sigurdsdottir'.repeat(2)}!`; // > the 24-char render clip
  const longMatch = formatFirstBlood({ bossName: 'Bonemass', firstBlood: longName, crowdPick: longName, crowdVotes: 2, totalVotes: 2 });
  ok(longMatch.content.includes('The hall called it'), 'and so is a name longer than the render clip');

  // A half-read poll must never publish "5 of 0 votes".
  const skewed = formatFirstBlood({ bossName: 'Bonemass', firstBlood: 'Astrid', crowdPick: 'Astrid', crowdVotes: 5, totalVotes: 0 });
  ok(skewed.content.includes('5 of 5 votes'), `the total is never below the winner's own count, got: ${skewed.content}`);
  ok(!/of 0 votes/.test(skewed.content), 'so no line ever reads "of 0 votes"');
}

// ── the loop, against a fake Supabase + a fake adapter ─────────────────────
function fakeDb(getBosses, getSessions) {
  const chainFor = (rows) => {
    const chain = {
      select: () => chain,
      order: () => chain,
      or: () => chain,
      eq: () => chain,
      gte: () => chain,
      limit: () => chain,
      then: (res, rej) => Promise.resolve({ data: rows(), error: null }).then(res, rej),
    };
    return chain;
  };
  return {
    from(table) {
      if (table === 'bosses') return chainFor(getBosses);
      if (table === 'sessions') return chainFor(getSessions);
      return chainFor(() => []);
    },
  };
}

function harness({ bosses, sessions = [session('Astrid', 10, 2), session('Bjorn', 8, 4)], results = null }) {
  const posts = [];
  const polls = [];
  const state = {};
  const adapter = {
    async postPoll(channelKey, payload) {
      polls.push({ channelKey, payload });
      return { messageId: `msg-${polls.length}`, channelId: 'chan' };
    },
    async fetchPollResults() {
      return results;
    },
  };
  const loop = createBossPolls({
    db: fakeDb(() => bosses, () => sessions),
    post: async (channelKey, payload) => posts.push({ channelKey, payload }),
    adapter,
    state,
    saveState: async () => {},
    channel: 'valheim',
  });
  return { loop, posts, polls, state };
}

const ladder = () => [
  { id: 'a', name: 'Eikthyr', sort_order: 1, is_killed: true, killed_at: hoursAgo(200), fight_stats: null },
  { id: 'b', name: 'The Elder', sort_order: 2, is_killed: false, killed_at: null, fight_stats: null },
  { id: 'c', name: 'Bonemass', sort_order: 3, is_killed: false, killed_at: null, fight_stats: null },
];

// Seeding: a boss felled before the flag was ever on must not trigger a poll.
{
  const bosses = ladder();
  const h = harness({ bosses });
  await h.loop.init();
  eq(h.state.bossPolls.knownFelled.length, 1, 'init seeds the already-felled bosses');
  const sent = await h.loop.tick(NOW);
  eq(sent, 0, 'and the first tick posts nothing for them');
  eq(h.polls.length, 0, 'no retro poll for a boss felled before the flag was flipped');
}

// A fresh kill opens exactly one poll, for the NEXT boss, once.
{
  const bosses = ladder();
  const h = harness({ bosses });
  await h.loop.init();
  await h.loop.tick(NOW);

  bosses[1].is_killed = true;
  bosses[1].killed_at = hoursAgo(1);
  bosses[1].fight_stats = { firstBlood: 'Astrid', fighters: ['Astrid', 'Bjorn'] };

  const sent = await h.loop.tick(NOW);
  eq(sent, 1, 'the kill sends one message');
  eq(h.polls.length, 1, 'and it is one poll');
  eq(h.polls[0].payload.poll.question.text, 'Who lands first blood on Bonemass?',
    'the poll asks about the NEXT objective, not the boss that just died');
  eq(h.polls[0].channelKey, 'valheim', 'posted to the configured channel');
  eq(h.polls[0].payload.poll.answers.length, 2, 'the ballot is this week\'s active vikings');
  eq(h.state.bossPolls.polls.c.messageId, 'msg-1', 'the poll id is persisted so it never re-posts');

  await h.loop.tick(NOW);
  await h.loop.tick(NOW);
  eq(h.polls.length, 1, 'later ticks never re-post the same poll');

  // ...and a restart (same state.json, fresh loop object) must not either.
  const restarted = createBossPolls({
    db: fakeDb(() => bosses, () => []),
    post: async () => {},
    adapter: { postPoll: async () => { throw new Error('must not post'); }, fetchPollResults: async () => null },
    state: h.state,
    saveState: async () => {},
    channel: 'valheim',
  });
  await restarted.init();
  await restarted.tick(NOW);
  eq(h.polls.length, 1, 'a restart re-reads state.json and stays quiet');
}

// The polled boss falls: one follow-up line, once, naming first blood.
{
  const bosses = ladder();
  const h = harness({
    bosses,
    results: { answers: [{ text: 'Astrid', votes: 5 }, { text: 'Bjorn', votes: 2 }], totalVotes: 7 },
  });
  await h.loop.init();
  bosses[1].is_killed = true;
  bosses[1].killed_at = hoursAgo(2);
  await h.loop.tick(NOW); // opens the Bonemass poll

  bosses[2].is_killed = true;
  bosses[2].killed_at = hoursAgo(1);
  bosses[2].fight_stats = { firstBlood: 'Astrid' };

  const sent = await h.loop.tick(NOW);
  ok(sent >= 1, 'the fall sends at least the follow-up');
  const followUp = h.posts.at(-1);
  ok(followUp.payload.content.includes('First blood on **Bonemass**: **Astrid**'),
    'the follow-up names the viking from fight_stats');
  ok(followUp.payload.content.includes('The hall called it'), 'and settles whether the crowd was right');
  ok(h.state.bossPolls.polls.c.resolvedAt, 'the poll is marked resolved');

  const before = h.posts.length;
  await h.loop.tick(NOW);
  eq(h.posts.length, before, 'and the follow-up is never posted twice');
}

// Too few active vikings: the poll waits, then posts when the hall fills up.
{
  const bosses = ladder();
  let sessions = [session('Astrid', 3, 1)]; // one viking only
  const posts = [];
  const polls = [];
  const state = {};
  const loop = createBossPolls({
    db: fakeDb(() => bosses, () => sessions),
    post: async (c, p) => posts.push({ c, p }),
    adapter: {
      postPoll: async (channelKey, payload) => {
        polls.push(payload);
        return { messageId: `msg-${polls.length}` };
      },
      fetchPollResults: async () => null,
    },
    state,
    saveState: async () => {},
    channel: 'valheim',
  });
  await loop.init();
  bosses[1].is_killed = true;
  bosses[1].killed_at = hoursAgo(1);

  eq(await loop.tick(NOW), 0, 'one viking is not a poll');
  eq(polls.length, 0, 'so nothing is posted');
  ok(state.bossPolls.pending, 'but the question is remembered');
  eq(state.bossPolls.pending.bossId, 'c', 'against the right boss');

  sessions = [session('Astrid', 3, 1), session('Bjorn', 4, 2)];
  eq(await loop.tick(NOW), 1, 'once a second viking has played, the poll goes up');
  eq(polls.length, 1, 'exactly one poll');
  eq(state.bossPolls.pending, null, 'and the pending question is cleared');
}

// The last boss on the ladder: a kill with nothing after it asks nothing.
{
  const bosses = ladder().map((b) => ({ ...b, is_killed: b.id !== 'c' }));
  const h = harness({ bosses });
  await h.loop.init();
  bosses[2].is_killed = true;
  bosses[2].killed_at = hoursAgo(1);
  bosses[2].fight_stats = { firstBlood: 'Astrid' };
  await h.loop.tick(NOW);
  eq(h.polls.length, 0, 'the last kill on the ladder opens no poll');
  eq(h.posts.length, 0, 'and there was no poll to follow up on');
}

// A ballot that COLLAPSES below two answers is held, not sent. Two candidates
// is the gate, but blank names are dropped and two long names can clip to the
// same text, so a two-candidate week can build a one-answer poll. Discord
// rejects a poll with fewer than two usable answers outright, and a rejected
// send burns one of the three tries the boss ever gets.
{
  const bosses = ladder();
  const twin = 'B'.repeat(60);
  const posts = [];
  const polls = [];
  const state = {};
  let sessions = [session(`${twin}1`, 6, 2), session(`${twin}2`, 5, 1)];
  const loop = createBossPolls({
    db: fakeDb(() => bosses, () => sessions),
    post: async (c, p) => posts.push({ c, p }),
    adapter: {
      postPoll: async (channelKey, payload) => {
        polls.push(payload);
        return { messageId: `msg-${polls.length}` };
      },
      fetchPollResults: async () => null,
    },
    state,
    saveState: async () => {},
    channel: 'valheim',
  });
  await loop.init();
  bosses[1].is_killed = true;
  bosses[1].killed_at = hoursAgo(1);

  eq(await loop.tick(NOW), 0, 'two candidates that clip to one answer are not a poll');
  eq(polls.length, 0, 'so nothing is sent to Discord');
  eq(state.bossPolls.failures.c, undefined, 'and no failure is burned against the boss');
  ok(state.bossPolls.pending, 'the question is held instead');

  sessions = [...sessions, session('Astrid', 4, 1)];
  eq(await loop.tick(NOW), 1, 'a third, distinct viking makes the ballot legal');
  eq(polls.length, 1, 'and the poll finally goes up');
  eq(polls[0].poll.answers.length, 2, 'with the two answers that survived clipping');
  eq(new Set(polls[0].poll.answers.map((a) => a.text)).size, 2, 'both unique, as Discord requires');
  eq(state.bossPolls.polls.c.answers.length, 2,
    'and the record persists the answers as SENT, which is what the follow-up compares against');
}

// The persisted record is the ballot, not the candidate list.
{
  const bosses = ladder();
  const h = harness({ bosses, sessions: [session('Astrid', 6, 2), session('  ', 5, 1), session('Bjorn', 4, 1)] });
  await h.loop.init();
  bosses[1].is_killed = true;
  bosses[1].killed_at = hoursAgo(1);
  await h.loop.tick(NOW);
  eq(h.state.bossPolls.polls.c.answers.join(','), 'Astrid,Bjorn',
    'a blank name never reaches the persisted ballot');
}

console.log(`bosspoll.test: ${passed} assertions passed`);
