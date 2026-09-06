// Unit tests for telling votes (src/tellings-vote.js). No network, no Discord.
//
// Covers, in order:
//   1. the verb parser, including the two verbs it must NOT steal
//   2. the ballot: which tellings stand, and how the excerpt is cut
//   3. the tally, the winner, and who becomes apocryphal
//   4. closing a vote end to end against a stub database
//   5. `standing` before its migration is applied
//   5b. a SECOND count on the same boss, and the standings the first one left
//   5c. a ballot that cannot be read: the deferral and its bound
//   6. the result embed and the copy doctrine
//
// Run: node scripts/tellings-vote.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  EXCERPT_CHARS,
  STANDING_APOCRYPHAL,
  STANDING_CANON,
  buildVoteEmbed,
  buildVoteResultEmbed,
  clearStandings,
  createTellingVotes,
  parseTellingVote,
  setStanding,
  voteOptions,
} from '../src/tellings-vote.js';
import { parseTellings } from '../src/tellings.js';
import { MAX_BALLOT_READ_TRIES, parseOfficeCommand, tallyBallot, ballotWinner } from '../src/storyteller.js';
import { clampEmbed } from '../src/discord.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const BOT = 'BOT1';
const silentLog = { info() {}, warn() {}, error() {} };

const BOSSES = [
  { id: 'b1', name: 'Eikthyr', sort_order: 1 },
  { id: 'b2', name: 'The Elder', sort_order: 2 },
  { id: 'b3', name: 'Bonemass', sort_order: 3 },
  { id: 'b7', name: 'Fader', sort_order: 7 },
];

// ── 1. The verb parser ────────────────────────────────────────────────────
{
  const p = (s) => parseTellingVote(s, BOT);

  eq(p('<@BOT1> vote tellings Bonemass')?.verb, 'vote', 'vote tellings opens a count');
  eq(p('<@BOT1> vote tellings Bonemass').boss, 'Bonemass', 'and names the boss');
  eq(p('<@BOT1> vote telling Bonemass').boss, 'Bonemass', 'the singular works too');
  eq(p('<@BOT1> vote retellings Bonemass').boss, 'Bonemass', 'and so does "retellings"');
  eq(p('<@BOT1> vote on the tellings of Bonemass').boss, 'Bonemass', 'the long form reads the same');
  eq(p('<@BOT1> VOTE TELLINGS the-elder').boss, 'the-elder', 'case does not matter and a slug is fine');

  eq(p('<@BOT1> close vote Bonemass')?.verb, 'close-vote', 'close vote closes it');
  eq(p('<@BOT1> close vote on Bonemass').boss, 'Bonemass', '"on" is allowed');
  eq(p('<@BOT1> close the vote Bonemass').boss, 'Bonemass', 'and so is "the"');

  // THE BUG THIS PINS. A character class of [\s:of] would have eaten the
  // leading F of "Fader" and opened a count on a forsaken called "ader".
  eq(p('<@BOT1> vote tellings Fader').boss, 'Fader', 'a boss whose name starts with an "f" keeps it');
  eq(p('<@BOT1> close vote on Odin').boss, 'Odin', 'and one starting with an "o" keeps that');

  // Verbs it must not steal from the two other parsers.
  eq(p('<@BOT1> close election'), null, 'close election belongs to storyteller.js');
  eq(parseOfficeCommand('<@BOT1> close vote Bonemass', BOT), null, 'and close vote does not parse as an office command');
  eq(p('<@BOT1> tellings Bonemass'), null, 'listing tellings is tellings.js, not a vote');
  eq(parseTellings('<@BOT1> vote tellings Bonemass', BOT), null, 'and a vote does not parse as a telling verb');
  eq(p('<@BOT1> we should vote on this'), null, 'a sentence about voting is not a command');
  eq(p('<@BOT1> vote tellings'), null, 'a vote with no boss is not a command');
}

// ── 2. The ballot ─────────────────────────────────────────────────────────
{
  const rows = [
    { id: 't1', text: 'A'.repeat(500), author_character: 'Bren', source: 'player', chosen: true },
    { id: 't2', text: 'The mist came in fast. Then it broke.', author_character: 'Astrid', source: 'player', chosen: false },
  ];
  const options = voteOptions(rows);
  eq(options.length, 2, 'one option per telling');
  eq(options[0].tellingId, 't1', 'in the order the list numbers them');
  eq(options[0].name, 'Bren', 'bylined to its teller');
  eq(options[0].chosen, true, 'and it knows which one already stands');

  const embed = clampEmbed(buildVoteEmbed('Bonemass', options));
  ok(embed.description.includes('on the war room now'), 'the ballot says which telling already stands');
  ok(embed.description.includes('Astrid'), 'and names every teller');
  // 300 characters of each, not the whole telling.
  ok(!embed.description.includes('A'.repeat(EXCERPT_CHARS + 20)), 'a long telling is cut to its opening');

  eq(voteOptions([]).length, 0, 'no tellings, no options');
  eq(voteOptions(Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, text: 'x', source: 'player' }))).length, 10,
    'and the ballot is capped at the marks it has');
}

// ── 3 and 4. Closing a count ──────────────────────────────────────────────
function fakeDb({ tellings = [], bosses = BOSSES, standingMissing = false } = {}) {
  const state = { tellings: [...tellings], bosses };
  const MISSING_COL = { code: 'PGRST204', message: "Could not find the 'standing' column of 'boss_tellings' in the schema cache" };

  function tellingQuery() {
    const preds = [];
    const api = {
      eq(col, val) { preds.push((r) => r[col] === val); return api; },
      order() { return api; },
      limit(n) {
        return Promise.resolve({ data: state.tellings.filter((r) => preds.every((p) => p(r))).slice(0, n), error: null });
      },
      then(res, rej) {
        return Promise.resolve({ data: state.tellings.filter((r) => preds.every((p) => p(r))), error: null }).then(res, rej);
      },
    };
    return api;
  }

  return {
    state,
    from(table) {
      return {
        select() {
          if (table === 'bosses') return { order: () => Promise.resolve({ data: state.bosses, error: null }) };
          if (table === 'offices') {
            const api = { eq: () => api, is: () => api, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
            return api;
          }
          return tellingQuery();
        },
        update(patch) {
          const preds = [];
          const api = {
            eq(col, val) { preds.push((r) => r[col] === val); return api; },
            // `.not('standing', 'is', null)`, which clearStandings uses so it
            // only touches rows that actually carry a verdict.
            not(col, op, val) {
              if (op === 'is' && val === null) preds.push((r) => r[col] != null);
              else preds.push((r) => r[col] !== val);
              return api;
            },
            then(res, rej) {
              if (standingMissing && 'standing' in patch) {
                return Promise.resolve({ error: MISSING_COL }).then(res, rej);
              }
              const targets = state.tellings.filter((r) => preds.every((p) => p(r)));
              // boss_tellings_one_chosen_idx, in the stub.
              if (patch.chosen === true) {
                for (const t of targets) {
                  if (state.tellings.some((r) => r.boss_id === t.boss_id && r.chosen && r.id !== t.id)) {
                    return Promise.resolve({
                      error: { code: '23505', message: 'duplicate key value violates unique constraint "boss_tellings_one_chosen_idx"' },
                    }).then(res, rej);
                  }
                }
              }
              for (const r of targets) Object.assign(r, patch);
              return Promise.resolve({ error: null }).then(res, rej);
            },
          };
          return api;
        },
      };
    },
  };
}

function fakeAdapter({ counts = {} } = {}) {
  const calls = { posted: [], edited: [], read: 0 };
  return {
    calls,
    async postBallot(channel, payload) {
      calls.posted.push({ channel, payload });
      return { messageId: 'm1', channelId: 'c1' };
    },
    async readBallot() { calls.read++; return counts; },
    async editBallot(channel, messageId, payload) {
      calls.edited.push({ channel, messageId, payload });
      return true;
    },
    async sendMentioning() { return true; },
  };
}

{
  const tellings = [
    { id: 't1', boss_id: 'b3', text: 'Bren was there.', author_character: 'Bren', source: 'player', chosen: true, standing: null },
    { id: 't2', boss_id: 'b3', text: 'Astrid was there.', author_character: 'Astrid', source: 'player', chosen: false, standing: null },
    { id: 't3', boss_id: 'b3', text: 'The Skald wrote this.', author_character: 'The Skald', source: 'skald', chosen: false, standing: null },
  ];
  const db = fakeDb({ tellings });
  const adapter = fakeAdapter({ counts: { '1️⃣': 1, '2️⃣': 4 } });
  const state = {};
  const votes = createTellingVotes({
    client: { user: { id: BOT } },
    db,
    adapter,
    state,
    saveState: async () => {},
    log: silentLog,
  });

  // Open it by hand through the state the handler would have written, so the
  // close path is exercised without a Discord message.
  state.tellingVotes = {
    b3: {
      bossName: 'Bonemass',
      messageId: 'm1',
      channel: 'valheim',
      openedAt: '2026-09-06T00:00:00Z',
      closesAt: '2026-09-07T00:00:00Z',
      options: [
        { emoji: '1️⃣', tellingId: 't1', name: 'Bren' },
        { emoji: '2️⃣', tellingId: 't2', name: 'Astrid' },
      ],
    },
  };

  const closed = await votes.tick(Date.parse('2026-09-07T00:00:01Z'));
  eq(closed, 1, 'the clock closes the count');
  eq(adapter.calls.edited.length, 1, 'and the ballot message is EDITED, never answered with a second post');
  eq(adapter.calls.posted.length, 0, 'nothing new is posted on close');

  const byId = Object.fromEntries(db.state.tellings.map((t) => [t.id, t]));
  eq(byId.t2.chosen, true, "the winning telling is the one the war room shows");
  eq(byId.t1.chosen, false, 'and the one that lost stops being shown');
  eq(byId.t2.standing, STANDING_CANON, 'the winner is canon');
  eq(byId.t1.standing, STANDING_APOCRYPHAL, 'the runner-up is apocryphal');
  eq(byId.t3.standing, null, 'and a telling nobody voted on is untouched');
  eq(Object.keys(state.tellingVotes).length, 0, 'the vote is cleared from state, so it cannot close twice');
  eq(await votes.tick(Date.parse('2026-09-08T00:00:00Z')), 0, 'and a second tick has nothing to close');
}

{
  // Nobody voted: nothing is chosen, nothing is marked, the message still says so.
  const tellings = [
    { id: 't1', boss_id: 'b3', text: 'One.', author_character: 'Bren', source: 'player', chosen: true, standing: null },
    { id: 't2', boss_id: 'b3', text: 'Two.', author_character: 'Astrid', source: 'player', chosen: false, standing: null },
  ];
  const db = fakeDb({ tellings });
  const adapter = fakeAdapter({ counts: {} });
  const state = {
    tellingVotes: {
      b3: {
        bossName: 'Bonemass', messageId: 'm1', channel: 'valheim', closesAt: '2026-09-07T00:00:00Z',
        options: [{ emoji: '1️⃣', tellingId: 't1', name: 'Bren' }, { emoji: '2️⃣', tellingId: 't2', name: 'Astrid' }],
      },
    },
  };
  const votes = createTellingVotes({ client: { user: { id: BOT } }, db, adapter, state, saveState: async () => {}, log: silentLog });
  eq(await votes.tick(Date.parse('2026-09-07T00:00:01Z')), 0, 'an empty ballot chooses nobody');
  eq(db.state.tellings[0].chosen, true, 'the telling that stood still stands');
  eq(db.state.tellings.every((t) => t.standing === null), true, 'and no verdict is recorded');
  eq(adapter.calls.edited.length, 1, 'the message is still rewritten so the hall sees the count is closed');
}

{
  // One clear winner and nobody else with a ballot: no runner-up to condemn.
  const tellings = [
    { id: 't1', boss_id: 'b3', text: 'One.', author_character: 'Bren', source: 'player', chosen: false, standing: null },
    { id: 't2', boss_id: 'b3', text: 'Two.', author_character: 'Astrid', source: 'player', chosen: false, standing: null },
  ];
  const db = fakeDb({ tellings });
  const state = {
    tellingVotes: {
      b3: {
        bossName: 'Bonemass', messageId: 'm1', channel: 'valheim', closesAt: '2026-09-07T00:00:00Z',
        options: [{ emoji: '1️⃣', tellingId: 't1', name: 'Bren' }, { emoji: '2️⃣', tellingId: 't2', name: 'Astrid' }],
      },
    },
  };
  const votes = createTellingVotes({
    client: { user: { id: BOT } }, db, adapter: fakeAdapter({ counts: { '1️⃣': 3 } }), state, saveState: async () => {}, log: silentLog,
  });
  await votes.tick(Date.parse('2026-09-07T00:00:01Z'));
  const byId = Object.fromEntries(db.state.tellings.map((t) => [t.id, t]));
  eq(byId.t1.standing, STANDING_CANON, 'the only telling anyone voted for is canon');
  eq(byId.t2.standing, null, 'and a telling with no ballots at all is not called apocryphal');
}

// ── 5. Before db/2026-09-06_telling_votes.sql ─────────────────────────────
{
  const db = fakeDb({
    tellings: [{ id: 't1', boss_id: 'b3', text: 'One.', source: 'player', chosen: false }],
    standingMissing: true,
  });
  const res = await setStanding(db, 't1', STANDING_CANON);
  eq(res.notReady, true, 'a missing `standing` column reads as not-migrated');
  eq(res.ok, false, 'and nothing was written');

  // The vote still rules: `chosen` belongs to the earlier migration.
  const state = {
    tellingVotes: {
      b3: {
        bossName: 'Bonemass', messageId: 'm1', channel: 'valheim', closesAt: '2026-09-07T00:00:00Z',
        options: [{ emoji: '1️⃣', tellingId: 't1', name: 'Bren' }],
      },
    },
  };
  const votes = createTellingVotes({
    client: { user: { id: BOT } }, db, adapter: fakeAdapter({ counts: { '1️⃣': 2 } }), state, saveState: async () => {}, log: silentLog,
  });
  eq(await votes.tick(Date.parse('2026-09-07T00:00:01Z')), 1, 'the count still rules without the newer column');
  eq(db.state.tellings[0].chosen, true, 'and the winner still reaches the war room page');

  // The WIPE degrades the same way. It runs first and names the same column, so
  // a version that let its error escape would take the whole close down before
  // the winner was ever chosen.
  eq((await clearStandings(db, 'b3')).notReady, true, 'clearing standings reads as not-migrated too');

  // Production answers a select naming a missing column with 42703 rather than
  // PGRST204, and 42703 is NOT in officesNotMigrated's code list: the message
  // test is what catches it. Pin that, because it is the shape the live
  // database actually returns today.
  const pg42703 = {
    from: () => ({
      update: () => {
        const api = {
          eq: () => api,
          not: () => api,
          then: (res, rej) =>
            Promise.resolve({ error: { code: '42703', message: 'column boss_tellings.standing does not exist' } }).then(res, rej),
        };
        return api;
      },
    }),
  };
  eq((await setStanding(pg42703, 't1', STANDING_CANON)).notReady, true, 'and so does a 42703 from Postgres itself');
  eq((await clearStandings(pg42703, 'b3')).notReady, true, 'on both writes');
}

// ── 5b. A SECOND COUNT ON THE SAME BOSS ───────────────────────────────────
//
// Two votes, one boss. The first vote's loser must not still read apocryphal
// after the second vote has ruled: components/boss/tellings.ts shows exactly
// ONE apocryphal telling and folds anything else into the collapsed list with
// no heading, so a stale verdict does not merely look untidy, it hides the
// version the hall just voted against.
{
  const tellings = [
    { id: 't1', boss_id: 'b3', text: 'One.', author_character: 'Bren', source: 'player', chosen: true, standing: null },
    { id: 't2', boss_id: 'b3', text: 'Two.', author_character: 'Astrid', source: 'player', chosen: false, standing: null },
    { id: 't3', boss_id: 'b3', text: 'Three.', author_character: 'Loa', source: 'player', chosen: false, standing: null },
    // A different boss entirely, marked by an older vote. Nothing here may touch it.
    { id: 'x1', boss_id: 'b4', text: 'Elsewhere.', author_character: 'Sigrun', source: 'player', chosen: true, standing: STANDING_CANON },
    { id: 'x2', boss_id: 'b4', text: 'Elsewhere too.', author_character: 'Ulf', source: 'player', chosen: false, standing: STANDING_APOCRYPHAL },
  ];
  const db = fakeDb({ tellings });
  const state = {};
  const openVote = (options, closesAt) => {
    state.tellingVotes = {
      b3: { bossName: 'Bonemass', messageId: 'm1', channel: 'valheim', closesAt, options },
    };
  };
  const mark = ['1️⃣', '2️⃣', '3️⃣'];
  const opts = [
    { emoji: mark[0], tellingId: 't1', name: 'Bren' },
    { emoji: mark[1], tellingId: 't2', name: 'Astrid' },
    { emoji: mark[2], tellingId: 't3', name: 'Loa' },
  ];

  // Vote one: Astrid wins, Bren is the runner-up.
  let adapter = fakeAdapter({ counts: { '1️⃣': 2, '2️⃣': 5 } });
  let votes = createTellingVotes({ client: { user: { id: BOT } }, db, adapter, state, saveState: async () => {}, log: silentLog });
  openVote(opts, '2026-09-07T00:00:00Z');
  eq(await votes.tick(Date.parse('2026-09-07T00:00:01Z')), 1, 'the first count rules');
  let byId = Object.fromEntries(db.state.tellings.map((t) => [t.id, t]));
  eq(byId.t2.standing, STANDING_CANON, 'the first winner is canon');
  eq(byId.t1.standing, STANDING_APOCRYPHAL, 'and the first runner-up is apocryphal');

  // Vote two, on the same boss: Loa wins, Astrid is the runner-up.
  adapter = fakeAdapter({ counts: { '2️⃣': 1, '3️⃣': 6 } });
  votes = createTellingVotes({ client: { user: { id: BOT } }, db, adapter, state, saveState: async () => {}, log: silentLog });
  openVote(opts, '2026-09-09T00:00:00Z');
  eq(await votes.tick(Date.parse('2026-09-09T00:00:01Z')), 1, 'the second count rules too');

  byId = Object.fromEntries(db.state.tellings.map((t) => [t.id, t]));
  eq(byId.t3.standing, STANDING_CANON, 'the new winner is canon');
  eq(byId.t2.standing, STANDING_APOCRYPHAL, 'the new runner-up is apocryphal');
  eq(byId.t1.standing, null, "and the OLD vote's loser is no longer condemned by a count that has been overruled");
  eq(
    db.state.tellings.filter((t) => t.boss_id === 'b3' && t.standing === STANDING_APOCRYPHAL).length,
    1,
    'so the boss carries exactly one apocryphal telling, which is what the war room can show',
  );
  eq(byId.t3.chosen, true, 'the winner is the telling on the page');

  eq(byId.x1.standing, STANDING_CANON, "a vote on one boss never disturbs another boss's verdicts");
  eq(byId.x2.standing, STANDING_APOCRYPHAL, 'on either side of it');
}

// ── 5c. A BALLOT THAT CANNOT BE READ ──────────────────────────────────────
//
// readBallot answers null for a rate limit, a failed fetch and a deleted
// message alike. Treating that as a count of zero would throw away a day of
// real ballots and announce, in writing, that nobody voted.
{
  const tellings = [
    { id: 't1', boss_id: 'b3', text: 'One.', author_character: 'Bren', source: 'player', chosen: true, standing: null },
    { id: 't2', boss_id: 'b3', text: 'Two.', author_character: 'Astrid', source: 'player', chosen: false, standing: null },
  ];
  const db = fakeDb({ tellings });
  let counts = null; // the read fails
  const adapter = {
    calls: { edited: 0, read: 0 },
    async postBallot() { return { messageId: 'm1', channelId: 'c1' }; },
    async readBallot() { adapter.calls.read++; return counts; },
    async editBallot() { adapter.calls.edited++; return true; },
    async sendMentioning() { return true; },
  };
  const state = {
    tellingVotes: {
      b3: {
        bossName: 'Bonemass', messageId: 'm1', channel: 'valheim', closesAt: '2026-09-07T00:00:00Z',
        options: [{ emoji: '1️⃣', tellingId: 't1', name: 'Bren' }, { emoji: '2️⃣', tellingId: 't2', name: 'Astrid' }],
      },
    },
  };
  const votes = createTellingVotes({ client: { user: { id: BOT } }, db, adapter, state, saveState: async () => {}, log: silentLog });

  eq(await votes.tick(Date.parse('2026-09-07T00:00:01Z')), 0, 'a failed read closes nothing');
  ok(state.tellingVotes.b3, 'the ballot is still open, so no vote is lost');
  eq(adapter.calls.edited, 0, 'and the message is NOT rewritten to say the count was empty');
  eq(db.state.tellings.every((t) => t.standing === null), true, 'no verdict is recorded on a count nobody could read');

  // The read comes good on the next tick and the count rules normally.
  counts = { '1️⃣': 1, '2️⃣': 4 };
  eq(await votes.tick(Date.parse('2026-09-07T00:30:00Z')), 1, 'the retry closes it properly');
  const byId = Object.fromEntries(db.state.tellings.map((t) => [t.id, t]));
  eq(byId.t2.standing, STANDING_CANON, 'and the ballots that were nearly thrown away decide it');
  eq(adapter.calls.edited, 1, 'with the message rewritten exactly once');

  // Bounded: a message someone deleted never comes back, so the retry gives up.
  counts = null;
  const state2 = {
    tellingVotes: {
      b3: {
        bossName: 'Bonemass', messageId: 'gone', channel: 'valheim', closesAt: '2026-09-07T00:00:00Z',
        options: [{ emoji: '1️⃣', tellingId: 't1', name: 'Bren' }],
      },
    },
  };
  const votes2 = createTellingVotes({ client: { user: { id: BOT } }, db: fakeDb({ tellings }), adapter, state: state2, saveState: async () => {}, log: silentLog });
  for (let i = 0; i < MAX_BALLOT_READ_TRIES; i++) await votes2.tick(Date.parse('2026-09-07T00:00:01Z'));
  eq(state2.tellingVotes.b3, undefined, `after ${MAX_BALLOT_READ_TRIES} tries the ballot closes rather than staying open forever`);
}

// ── 6. The result embed and the copy doctrine ─────────────────────────────
{
  const options = [
    { emoji: '1️⃣', tellingId: 't1', name: 'Bren' },
    { emoji: '2️⃣', tellingId: 't2', name: 'Astrid' },
  ];
  const tallied = tallyBallot(options, { '1️⃣': 1, '2️⃣': 3 });
  const winner = ballotWinner(tallied);
  const embed = clampEmbed(buildVoteResultEmbed('Bonemass', tallied, winner, tallied[1]));
  ok(embed.description.includes('Astrid'), 'the result names the telling the hall kept');
  ok(embed.description.includes('apocryphal'), 'and says what became of the other one');
  ok(embed.description.includes('3 ballots'), 'with the tally');

  const src = readFileSync(new URL('../src/tellings-vote.js', import.meta.url), 'utf8');
  const isNotPlayerCopy = (line) =>
    /^\s*(\/\/|\*|\/\*)/.test(line) ||
    /log\.(info|warn|error)\?\./.test(line) ||
    /\.match\(|\.replace\(|RegExp|new Error\(/.test(line);
  const offenders = [];
  src.split('\n').forEach((raw, i) => {
    if (isNotPlayerCopy(raw)) return;
    const code = raw.replace(/(^|[^:])\/\/.*$/, '$1');
    if (/[—–]/.test(code)) offenders.push(`tellings-vote.js:${i + 1}: ${code.trim()}`);
  });
  ok(offenders.length === 0, `no em/en dash in the reply copy, found: ${JSON.stringify(offenders.slice(0, 3))}`);
  ok(!/!/.test(src.split('\n').filter((l) => /^\s*'[A-Z]/.test(l)).join('\n')), 'and no exclamation marks in the copy');

  ok(/mentions\?\.has\(client\.user, MENTION_STRICT\)/.test(src), 'it gates on an explicit mention');
  ok(/if \(!message\.guild\) return;/.test(src), 'it refuses a direct message');
  ok(/if \(guildId && message\.guildId !== guildId\) return;/.test(src), 'it refuses another guild');
  ok(/safeText\(/.test(src) && /nameMd\(/.test(src), 'and every player-typed string is escaped on display');
  ok(/r\.source !== 'skald'/.test(src), "the Skald's draft never goes on a ballot the hall votes on");
}

console.log(`tellings-vote.test: ${passed} assertions passed`);
