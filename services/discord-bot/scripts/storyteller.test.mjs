// Unit tests for the Storyteller of Eilif (src/storyteller.js). No network, no
// Discord, no database.
//
// Covers, in order:
//   1. the verb parser, in every form it accepts and the ones it must refuse
//   2. who may open a count or hand out the office
//   3. the ballot: who is eligible, and in what order
//   4. the tally, including the tie rule and the nobody-voted case
//   5. the backlog: which falls count, and how the line reads
//   6. the nudge clock, including the pre-office grace
//   7. installing a holder: close the old term, then open the new one
//   8. the nudge mark, and its idempotency
//   9. `keep` authority: the Storyteller may keep any telling
//   9b. a ballot that cannot be read: the deferral, its bound, and a real empty count
//  10. every new voice pool against the copy doctrine and the 150-char cap
//  11. the module's own player-facing copy against the same doctrine
//  12. the three flags, as index.js actually reads and reports them
//
// Run: node scripts/storyteller.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  BALLOT_EMOJI,
  ELIGIBLE_DAYS,
  MAX_BALLOT_OPTIONS,
  MAX_BALLOT_READ_TRIES,
  createStoryteller,
  NUDGE_AFTER_KILL_MS,
  NUDGE_GRACE_MS,
  actName,
  backlogBosses,
  ballotWinner,
  bossInProse,
  bossesDueForNudge,
  buildElectionEmbed,
  buildElectionResultEmbed,
  buildNudgeMessage,
  buildProclamationEmbed,
  eligibleCandidates,
  formatBacklog,
  installHolder,
  joinBosses,
  markNudged,
  mayHoldElection,
  nudgeDueAt,
  nudgeVoiceLine,
  parseOfficeCommand,
  proclaimVoiceLine,
  readCurrentOffice,
  readNudgedBossIds,
  tallyBallot,
} from '../src/storyteller.js';
import { mayKeepTelling } from '../src/tellings.js';
import { STORYTELLER_PROCLAIM_LINES, STORYTELLER_NUDGE_LINES, ALTAR_TELLING_TAILS } from '../src/voice.js';
import { clampEmbed } from '../src/discord.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const BOT = 'BOT1';
const DAY = 86_400_000;

const BOSSES = [
  { id: 'b1', name: 'Eikthyr', sort_order: 1, is_killed: true, killed_at: '2026-09-01T00:00:00Z' },
  { id: 'b2', name: 'The Elder', sort_order: 2, is_killed: true, killed_at: '2026-09-03T00:00:00Z' },
  { id: 'b3', name: 'Bonemass', sort_order: 3, is_killed: false, killed_at: null },
];

// ── 1. The verb parser ────────────────────────────────────────────────────
{
  const p = (s) => parseOfficeCommand(s, BOT);

  eq(p('<@BOT1> elect storyteller')?.verb, 'elect', 'elect storyteller is the election verb');
  eq(p('<@!BOT1> ELECT STORYTELLER').verb, 'elect', 'case does not matter, nor does a nickname mention');
  eq(p('<@BOT1>, elect the storyteller').verb, 'elect', 'leading punctuation and "the" are forgiven');
  eq(p('elect storyteller <@BOT1>').verb, 'elect', 'the mention may come last');

  eq(p('<@BOT1> close election')?.verb, 'close-election', 'close election closes the count');
  eq(p('<@BOT1> close the election').verb, 'close-election', '"the" is allowed there too');
  eq(p('<@BOT1> close vote Bonemass'), null, 'close vote belongs to tellings-vote.js, not here');

  const named = p('<@BOT1> name storyteller Bren Bjornsson');
  eq(named?.verb, 'name', 'name storyteller installs a holder');
  eq(named.name, 'Bren Bjornsson', 'and carries the whole character name');
  eq(p('<@BOT1> name storyteller: Bren').name, 'Bren', 'a colon may stand in for the space');
  eq(p('<@BOT1> name storyteller'), null, 'naming nobody is not a command');

  // Sentences that merely contain the words.
  eq(p('<@BOT1> what is the name of the storyteller'), null, 'a question is not a command');
  eq(p('<@BOT1> we should elect a jarl'), null, 'electing something else is not this verb');
  eq(p('<@BOT1> retell Bonemass: it went badly'), null, 'a telling is not an office command');
  eq(p('<@BOT1> closer to the storyteller'), null, '"closer" does not parse as "close"');
}

// ── 2. Who may open a count ───────────────────────────────────────────────
{
  const member = (perm, { guild = 'G1', roles = [] } = {}) => ({
    user: { id: 'U1' },
    guild: { id: guild },
    permissions: { has: (p) => p === perm },
    roles: { cache: { has: (id) => roles.includes(id) } },
  });

  ok(mayHoldElection(member('Administrator'), { guildId: 'G1' }), 'an Administrator may');
  ok(mayHoldElection(member('ManageGuild'), { guildId: 'G1' }), 'so may Manage Server');
  ok(
    mayHoldElection(member('None', { roles: ['R9'] }), { guildId: 'G1', adminRoleIds: ['R9'] }),
    'so may a listed admin role',
  );
  ok(!mayHoldElection(member('None'), { guildId: 'G1' }), 'an ordinary member may not');
  ok(!mayHoldElection(null, { guildId: 'G1' }), 'a direct message has no member and no permissions');
  ok(
    !mayHoldElection(member('Administrator', { guild: 'G2' }), { guildId: 'G1' }),
    'and an Administrator of ANOTHER guild may not install our Storyteller',
  );
}

// ── 3. The ballot ─────────────────────────────────────────────────────────
{
  const now = Date.parse('2026-09-06T12:00:00Z');
  const players = [
    { character_name: 'Bren', discord_user_id: 'D1' },
    { character_name: 'Astrid', discord_user_id: 'D2' },
    { character_name: 'Ivar', discord_user_id: null }, // never linked
    { character_name: 'Loa', discord_user_id: 'D4' },
  ];
  const session = (name, startDaysAgo, hours) => ({
    character_name: name,
    joined_at: new Date(now - startDaysAgo * DAY).toISOString(),
    left_at: new Date(now - startDaysAgo * DAY + hours * 3600_000).toISOString(),
  });
  const sessions = [
    session('Astrid', 2, 6),
    session('Bren', 3, 9),
    session('Ivar', 1, 20), // most hours of anyone, and unlinked
    session('Loa', 40, 30), // linked, but far outside the window
  ];

  const cands = eligibleCandidates(players, sessions, { nowMs: now });
  eq(cands.length, 2, 'only linked vikings who played inside the window stand');
  eq(cands[0].name, 'Bren', 'ranked by hours in the window, most first');
  eq(cands[1].name, 'Astrid', 'then the next');
  eq(cands[0].emoji, BALLOT_EMOJI[0], 'each carries its own ballot mark');
  ok(!cands.some((c) => c.name === 'Ivar'), 'an unlinked viking cannot hold an office that has to reach them');
  ok(!cands.some((c) => c.name === 'Loa'), `and a viking last seen outside ${ELIGIBLE_DAYS} days is not standing`);

  // The cap is the number of marks, not the number of vikings.
  const many = Array.from({ length: 15 }, (_, i) => ({
    character_name: `V${String(i).padStart(2, '0')}`,
    discord_user_id: `D${i}`,
  }));
  const manySessions = many.map((p, i) => session(p.character_name, 1, 15 - i));
  eq(
    eligibleCandidates(many, manySessions, { nowMs: now }).length,
    MAX_BALLOT_OPTIONS,
    'the ballot is capped at the marks it has',
  );
  eq(eligibleCandidates([], [], { nowMs: now }).length, 0, 'an empty hall stands nobody');
}

// ── 4. The tally ──────────────────────────────────────────────────────────
{
  const options = [
    { emoji: '1️⃣', name: 'Bren', discordId: 'D1' },
    { emoji: '2️⃣', name: 'Astrid', discordId: 'D2' },
    { emoji: '3️⃣', name: 'Loa', discordId: 'D4' },
  ];

  const clear = tallyBallot(options, { '1️⃣': 2, '2️⃣': 5, '3️⃣': 1 });
  eq(clear[0].name, 'Astrid', 'the most ballots wins');
  eq(clear[0].votes, 5, 'carrying its own count');
  eq(ballotWinner(clear).name, 'Astrid', 'and that is the winner');

  // The tie rule: ballot order, which is hours descending.
  const tied = tallyBallot(options, { '1️⃣': 4, '2️⃣': 4, '3️⃣': 0 });
  eq(tied[0].name, 'Bren', 'a dead heat goes to the viking higher on the ballot');
  eq(
    ballotWinner(tallyBallot(options, { '1️⃣': 0, '2️⃣': 0, '3️⃣': 0 })),
    null,
    'nobody voting elects nobody',
  );
  eq(ballotWinner(tallyBallot(options, {})), null, 'an unreadable ballot elects nobody');

  // A negative or nonsense count cannot elect anyone or reorder the board.
  const junk = tallyBallot(options, { '1️⃣': -5, '2️⃣': 'many', '3️⃣': 1 });
  eq(junk[0].name, 'Loa', 'a real single ballot beats a nonsense count');
  eq(junk.find((t) => t.name === 'Bren').votes, 0, 'and a negative count reads as none');
}

// ── 5. The backlog ────────────────────────────────────────────────────────
{
  eq(
    backlogBosses(BOSSES, []).join(', '),
    'Eikthyr, The Elder',
    'every fallen boss with no player telling, in ladder order',
  );
  eq(backlogBosses(BOSSES, ['b1']).join(', '), 'The Elder', 'a boss a viking has told is off the list');
  eq(backlogBosses(BOSSES, ['b1', 'b2']).length, 0, 'and a caught-up hall owes nothing');

  eq(bossInProse('The Elder', true), 'The Elder', 'a boss opening a sentence keeps its capital');
  eq(bossInProse('The Elder', false), 'the Elder', 'and reads lower-cased inside one');
  eq(joinBosses(['Eikthyr', 'The Elder']), 'Eikthyr and the Elder', 'two are joined with "and"');
  eq(
    joinBosses(['Eikthyr', 'The Elder', 'Bonemass']),
    'Eikthyr, the Elder and Bonemass',
    'three are a list with an "and" at the end',
  );

  eq(
    formatBacklog(['Eikthyr', 'The Elder']),
    'Two tales wait for you, Storyteller: Eikthyr and the Elder.',
    "Charlie's line, exactly",
  );
  eq(
    formatBacklog(['Eikthyr']),
    'One tale waits for you, Storyteller: Eikthyr.',
    'one tale is singular all the way through',
  );
  ok(/^No tale waits/.test(formatBacklog([])), 'a caught-up hall is told so rather than shown an empty list');
  ok(formatBacklog(Array.from({ length: 12 }, (_, i) => `Boss${i}`)).includes('more'), 'a long backlog is summarised');

  eq(actName(BOSSES), 'The Elder', 'the act is the furthest forsaken to have fallen');
  eq(actName([]), 'opening', 'and "opening" before the first kill');
  eq(actName(BOSSES.map((b) => ({ ...b, is_killed: false }))), 'opening', 'even with bosses on the ladder');
}

// ── 6. The nudge clock ────────────────────────────────────────────────────
{
  const since = '2026-09-05T00:00:00Z';
  const sinceMs = Date.parse(since);

  // A boss felled DURING the term: a day after the kill.
  const during = '2026-09-06T00:00:00Z';
  eq(
    nudgeDueAt(during, since),
    Date.parse(during) + NUDGE_AFTER_KILL_MS,
    'a fall inside the term is nudged a day later',
  );

  // A boss felled BEFORE the term: a week after the term opened.
  eq(
    nudgeDueAt('2026-08-01T00:00:00Z', since),
    sinceMs + NUDGE_GRACE_MS,
    'an inherited fall is nudged a week after the term opened, not a day after a kill nobody was in office for',
  );
  eq(nudgeDueAt('2026-09-06T00:00:00Z', null), Date.parse('2026-09-06T00:00:00Z') + NUDGE_AFTER_KILL_MS,
    'with no term, the kill alone sets the clock');
  eq(nudgeDueAt(null, null), null, 'and with neither date there is nothing to schedule');

  const bosses = [
    { id: 'b1', name: 'Eikthyr', sort_order: 1, is_killed: true, killed_at: '2026-08-01T00:00:00Z' },
    { id: 'b2', name: 'The Elder', sort_order: 2, is_killed: true, killed_at: '2026-09-06T00:00:00Z' },
    { id: 'b3', name: 'Bonemass', sort_order: 3, is_killed: false, killed_at: null },
  ];

  // Two days into the term: the inherited fall is still inside its week's grace,
  // and the fresh one is a day past its kill.
  const twoDaysIn = sinceMs + 2 * DAY;
  const due = bossesDueForNudge({ bosses, officeSince: since, nowMs: twoDaysIn });
  eq(due.length, 1, 'only the fall that is actually due');
  eq(due[0].boss.name, 'The Elder', 'and it is the one felled during the term');

  const eightDaysIn = sinceMs + 8 * DAY;
  eq(
    bossesDueForNudge({ bosses, officeSince: since, nowMs: eightDaysIn }).length,
    2,
    'a week in, the inherited fall is owed as well',
  );
  eq(
    bossesDueForNudge({ bosses, officeSince: since, nowMs: eightDaysIn })[0].boss.name,
    'The Elder',
    'soonest-due first, so the oldest debt is not always the first nudge',
  );
  eq(
    bossesDueForNudge({ bosses, playerToldBossIds: ['b2'], officeSince: since, nowMs: eightDaysIn }).length,
    1,
    'a fall a viking has told is never nudged about',
  );
  eq(
    bossesDueForNudge({ bosses, nudgedBossIds: ['b1', 'b2'], officeSince: since, nowMs: eightDaysIn }).length,
    0,
    'and a fall this term has already been nudged about is not owed twice',
  );
  eq(
    bossesDueForNudge({ bosses, officeSince: since, nowMs: sinceMs }).length,
    0,
    'nothing is due on the day the term opens',
  );
  ok(
    bossesDueForNudge({ bosses, officeSince: since, nowMs: eightDaysIn }).every((d) => d.boss.is_killed),
    'a boss still standing is never in the backlog',
  );
}

// ── 7 and 8. Installing a holder, and the nudge mark ──────────────────────
function fakeDb({ offices = [], nudges = [], tellings = [], tableError = null } = {}) {
  const state = { offices: [...offices], nudges: [...nudges], tellings: [...tellings], seq: 0 };
  const fail = (table) => (tableError && tableError.table === table ? tableError.error : null);

  const rowsOf = (table) =>
    table === 'offices' ? state.offices : table === 'office_nudges' ? state.nudges : state.tellings;

  function query(table) {
    const preds = [];
    const api = {
      eq(col, val) { preds.push((r) => r[col] === val); return api; },
      is(col, val) { preds.push((r) => (r[col] ?? null) === val); return api; },
      order() { return api; },
      limit() {
        const e = fail(table);
        return Promise.resolve(e ? { data: null, error: e } : { data: rowsOf(table).filter((r) => preds.every((p) => p(r))), error: null });
      },
      maybeSingle() {
        const e = fail(table);
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: rowsOf(table).filter((r) => preds.every((p) => p(r)))[0] ?? null, error: null });
      },
    };
    return api;
  }

  return {
    state,
    from(table) {
      return {
        select: () => query(table),
        insert(row) {
          const e = fail(table);
          if (e) {
            return {
              select: () => ({ single: () => Promise.resolve({ data: null, error: e }) }),
              then: (r) => Promise.resolve({ error: e }).then(r),
            };
          }
          if (table === 'office_nudges') {
            const clash = state.nudges.some(
              (n) => n.boss_id === row.boss_id && n.office_id === row.office_id,
            );
            if (clash) {
              return Promise.resolve({
                error: { code: '23505', message: 'duplicate key value violates unique constraint "office_nudges_pkey"' },
              });
            }
            state.nudges.push(row);
            return Promise.resolve({ error: null });
          }
          if (table === 'offices') {
            // offices_one_holder_idx, in the stub.
            if ((row.until ?? null) === null && state.offices.some((o) => o.office === row.office && o.until == null)) {
              const err = { code: '23505', message: 'duplicate key value violates unique constraint "offices_one_holder_idx"' };
              return { select: () => ({ single: () => Promise.resolve({ data: null, error: err }) }) };
            }
            const saved = { id: `o${++state.seq}`, ...row };
            state.offices.unshift(saved);
            return { select: () => ({ single: () => Promise.resolve({ data: saved, error: null }) }) };
          }
          const saved = { id: `t${++state.seq}`, ...row };
          state.tellings.unshift(saved);
          return { select: () => ({ single: () => Promise.resolve({ data: saved, error: null }) }) };
        },
        update(patch) {
          const preds = [];
          const api = {
            eq(col, val) { preds.push((r) => r[col] === val); return api; },
            is(col, val) { preds.push((r) => (r[col] ?? null) === val); return api; },
            then(res, rej) {
              const e = fail(table);
              if (e) return Promise.resolve({ error: e }).then(res, rej);
              for (const r of rowsOf(table).filter((row) => preds.every((p) => p(row)))) Object.assign(r, patch);
              return Promise.resolve({ error: null }).then(res, rej);
            },
          };
          return api;
        },
      };
    },
  };
}

{
  const db = fakeDb();
  const first = await installHolder(db, {
    character: 'Bren',
    discordId: 'D1',
    electedBy: 'vote',
    act: 'Eikthyr',
    nowIso: '2026-09-06T00:00:00Z',
  });
  eq(first.notReady, false, 'the office is installed');
  eq(db.state.offices.length, 1, 'one term');
  eq(db.state.offices[0].until, undefined, 'and it is open');

  const current = await readCurrentOffice(db);
  eq(current.office.holder_character, 'Bren', 'and it reads back as the open term');

  // A second holder CLOSES the first term. Doing it the other way round would
  // hit offices_one_holder_idx, which the stub enforces.
  const second = await installHolder(db, {
    character: 'Astrid',
    discordId: 'D2',
    electedBy: 'vote',
    act: 'The Elder',
    nowIso: '2026-09-20T00:00:00Z',
  });
  eq(second.notReady, false, 'the next holder is installed');
  eq(db.state.offices.length, 2, 'as a second term, not an overwrite');
  eq(db.state.offices.filter((o) => o.until == null).length, 1, 'with exactly one term open');
  eq((await readCurrentOffice(db)).office.holder_character, 'Astrid', 'and it is the new holder');
  eq(
    db.state.offices.find((o) => o.holder_character === 'Bren').until,
    '2026-09-20T00:00:00Z',
    "the previous holder's term is closed at the moment the new one opened",
  );

  // Pre-migration: every path answers "not ready" and nothing throws.
  const missing = fakeDb({ tableError: { table: 'offices', error: { code: '42P01', message: 'relation "offices" does not exist' } } });
  eq((await readCurrentOffice(missing)).notReady, true, 'a missing table reads as not-migrated');
  eq((await installHolder(missing, { character: 'Bren', discordId: 'D1' })).notReady, true, 'and installing says the same');
}

{
  const db = fakeDb({ offices: [{ id: 'o1', office: 'storyteller', holder_character: 'Bren', holder_discord_id: 'D1', since: '2026-09-05T00:00:00Z', until: null }] });
  eq((await markNudged(db, { bossId: 'b1', officeId: 'o1' })).marked, true, 'a nudge is marked');
  eq(db.state.nudges.length, 1, 'as one row');
  eq((await markNudged(db, { bossId: 'b1', officeId: 'o1' })).marked, true, 'marking it twice is still marked');
  eq(db.state.nudges.length, 1, 'and writes nothing the second time');
  eq((await readNudgedBossIds(db, 'o1')).ids.join(','), 'b1', 'the term reads its own nudges back');
  eq((await readNudgedBossIds(db, 'o2')).ids.length, 0, 'and another term reads none of them');
}


// ── 9b. A BALLOT THAT CANNOT BE READ ──────────────────────────────────────
//
// createBallotAdapter.readBallot answers null for a rate limit, a fetch that
// failed and a message someone deleted, all alike. Closing on null would tally
// every candidate at zero, install nobody, rewrite the ballot to say the hall
// voted for no one, and clear the count from state so there is nothing left to
// retry. Twenty-four hours of real ballots, gone, with a false statement in
// their place. So a failed read defers, bounded.
{
  const OFFICE_BOSSES = [];
  const stubClient = { user: { id: 'BOT1' } };
  const posts = [];

  function makeStoryteller({ readBallot }) {
    const db = fakeDb();
    const state = {};
    const adapter = {
      calls: { edited: 0, read: 0 },
      async postBallot() { return { messageId: 'm1', channelId: 'c1' }; },
      async readBallot() { adapter.calls.read++; return readBallot(); },
      async editBallot() { adapter.calls.edited++; return true; },
      async sendMentioning() { return true; },
    };
    const teller = createStoryteller({
      client: stubClient,
      db,
      post: async (channel, payload) => { posts.push({ channel, payload }); },
      adapter,
      state,
      saveState: async () => {},
      log: { info() {}, warn() {}, error() {} },
    });
    state.offices = {
      election: {
        messageId: 'm1',
        channel: 'valheim',
        openedAt: '2026-09-06T00:00:00Z',
        closesAt: '2026-09-07T00:00:00Z',
        candidates: [
          { emoji: BALLOT_EMOJI[0], name: 'Bren', discordId: 'D1' },
          { emoji: BALLOT_EMOJI[1], name: 'Astrid', discordId: 'D2' },
        ],
      },
    };
    return { teller, db, state, adapter, bosses: OFFICE_BOSSES };
  }

  // The read fails at the moment the clock runs out.
  {
    let counts = null;
    const { teller, db, state, adapter } = makeStoryteller({ readBallot: () => counts });
    eq(await teller.tick(Date.parse('2026-09-07T00:00:01Z')), 0, 'a failed read installs nobody');
    ok(state.offices.election, 'the count stays open, so no ballot is lost');
    eq(state.offices.election.readFailures, 1, 'and the failure is counted');
    eq(adapter.calls.edited, 0, 'the ballot is NOT rewritten to say nobody voted');
    eq(db.state.offices.length, 0, 'and no term is opened');

    // The next tick reads it fine, and the count rules on the real ballots.
    counts = { [BALLOT_EMOJI[0]]: 2, [BALLOT_EMOJI[1]]: 5 };
    eq(await teller.tick(Date.parse('2026-09-07T00:30:00Z')), 1, 'the retry closes it properly');
    eq(state.offices.election, null, 'the ballot is cleared once it has actually been counted');
    eq(db.state.offices.length, 1, 'a term is opened');
    eq(db.state.offices[0].holder_character, 'Astrid', 'for the viking the hall actually chose');
    eq(adapter.calls.edited, 1, 'and the message is rewritten exactly once');
  }

  // A message someone deleted never comes back: the retry is bounded, so the
  // ballot cannot stay open forever.
  {
    const { teller, state, adapter } = makeStoryteller({ readBallot: () => null });
    for (let i = 0; i < MAX_BALLOT_READ_TRIES; i++) {
      await teller.tick(Date.parse('2026-09-07T00:00:01Z'));
    }
    eq(state.offices.election, null, `after ${MAX_BALLOT_READ_TRIES} tries the count closes on what is known`);
    eq(adapter.calls.read, MAX_BALLOT_READ_TRIES, 'having tried the read every time');
    eq(adapter.calls.edited, 1, 'and the hall is told once that it closed');
  }

  // A genuinely empty ballot is a different thing and still closes on the first
  // pass: nobody voted, and the hall is told so.
  {
    const { teller, state, db, adapter } = makeStoryteller({ readBallot: () => ({}) });
    eq(await teller.tick(Date.parse('2026-09-07T00:00:01Z')), 0, 'an empty count installs nobody');
    eq(state.offices.election, null, 'and closes immediately, because it was read');
    eq(db.state.offices.length, 0, 'with the office left as it was');
    eq(adapter.calls.edited, 1, 'the ballot says so in place');
  }
}

// ── 9. `keep` authority ───────────────────────────────────────────────────
{
  const telling = { id: 't1', author_discord_id: 'D9' };
  const member = (id) => ({
    user: { id },
    guild: { id: 'G1' },
    permissions: { has: () => false },
    roles: { cache: { has: () => false } },
  });

  ok(mayKeepTelling(member('D9'), telling, { guildId: 'G1' }), 'the author may keep their own telling');
  ok(!mayKeepTelling(member('D1'), telling, { guildId: 'G1' }), 'a stranger may not');
  ok(
    mayKeepTelling(member('D1'), telling, { guildId: 'G1', storytellerDiscordId: 'D1' }),
    'the Storyteller may keep any telling',
  );
  ok(
    !mayKeepTelling(member('D1'), telling, { guildId: 'G1', storytellerDiscordId: 'D2' }),
    'and being SOMEONE ELSE while the office is held changes nothing',
  );
  ok(
    !mayKeepTelling(member('D1'), telling, { guildId: 'G1', storytellerDiscordId: null }),
    'a vacant office grants nobody anything',
  );
  ok(
    !mayKeepTelling({ ...member('D1'), guild: { id: 'G2' } }, telling, { guildId: 'G1', storytellerDiscordId: 'D1' }),
    'and the Storyteller of another guild is not ours',
  );
}

// ── 10. The voice pools ───────────────────────────────────────────────────
{
  const VOICE_MAX = 150;
  const LONG_NAME = 'Ragnhildr Sigurdsdottir';
  const LONG_BOSS = 'The Elder';

  const check = (label, lines, fill) => {
    ok(lines.length >= 4, `${label} has enough lines to not repeat itself (${lines.length})`);
    eq(new Set(lines).size, lines.length, `${label} has no duplicate line`);
    for (const raw of lines) {
      const filled = fill(raw);
      ok(!/[—–]/.test(filled), `${label} has no em or en dash: ${filled}`);
      ok(!/!/.test(filled), `${label} has no exclamation mark: ${filled}`);
      ok(!/\{[a-zA-Z]+\}/.test(filled), `${label} leaves no unfilled placeholder: ${filled}`);
      ok(filled.length <= VOICE_MAX, `${label} fits the ${VOICE_MAX} char ceiling (${filled.length}): ${filled}`);
    }
  };

  check('the proclamation pool', STORYTELLER_PROCLAIM_LINES, (t) =>
    t.replace(/\{firstName\}/g, LONG_NAME.split(' ')[0]));
  check('the nudge pool', STORYTELLER_NUDGE_LINES, (t) => t.replace(/\{boss\}/g, LONG_BOSS));
  check('the altar tail pool', ALTAR_TELLING_TAILS, (t) => t.replace(/\{teller\}/g, LONG_NAME.split(' ')[0]));

  // The picker is a pure hash, so the same seed reads the same way forever.
  eq(
    proclaimVoiceLine('Bren Bjornsson', 'seed-1'),
    proclaimVoiceLine('Bren Bjornsson', 'seed-1'),
    'the proclamation line is stable for a given seed',
  );
  ok(proclaimVoiceLine('Bren Bjornsson', 'seed-1').includes('Bren'), 'and names the new holder by their first name');
  ok(!proclaimVoiceLine('Bren Bjornsson', 'seed-1').includes('Bjornsson'), 'first name only, as every other spoken line does');
  ok(nudgeVoiceLine('Bonemass', 'seed-1').includes('Bonemass'), 'the nudge names the untold forsaken');
  ok(
    /\byou\b|\byour\b|Storyteller/i.test(nudgeVoiceLine('Bonemass', 'seed-1')),
    'and speaks to one viking, which is why it is only ever queued with a target',
  );

  // A player-chosen name full of markdown cannot break a spoken line.
  const nasty = proclaimVoiceLine('**Bren**', 'seed-2');
  ok(typeof nasty === 'string' && nasty.length > 0, 'a name full of markdown still produces a line');
}

// ── 11. The embeds and the copy doctrine ──────────────────────────────────
{
  const candidates = [
    { emoji: '1️⃣', name: 'Bren', discordId: 'D1' },
    { emoji: '2️⃣', name: 'Astrid', discordId: 'D2' },
  ];

  const ballot = clampEmbed(buildElectionEmbed(candidates));
  ok(ballot.description.includes('1️⃣'), 'the ballot shows its marks');
  ok(ballot.description.includes('Bren'), 'and its candidates');
  ok(ballot.description.includes('24 hours'), 'and says when it closes');

  const result = clampEmbed(buildElectionResultEmbed(tallyBallot(candidates, { '1️⃣': 3, '2️⃣': 1 }), { name: 'Bren' }));
  ok(result.description.includes('3 ballots'), 'the result carries the tally');
  ok(result.description.includes('1 ballot'), 'and says "ballot" for one');

  const empty = clampEmbed(buildElectionResultEmbed(tallyBallot(candidates, {}), null));
  ok(/no votes|No ballot/i.test(`${empty.title} ${empty.description}`), 'a ballot nobody cast says so plainly');

  const proc = clampEmbed(buildProclamationEmbed('Bren', ['Eikthyr', 'The Elder']));
  ok(proc.description.includes('Two tales wait for you'), 'the proclamation carries the backlog');

  const nudge = buildNudgeMessage('D1', 'Bonemass', { untoldCount: 3 });
  ok(nudge.content.startsWith('<@D1>'), 'the nudge mentions the holder');
  eq(nudge.userIds.join(','), 'D1', 'and allows exactly that one mention');
  ok(nudge.content.includes('2 other'), 'and says how much else is owed');
  eq(buildNudgeMessage('D1', 'Bonemass').content.includes('other'), false, 'a single debt says nothing about others');

  // A boss name full of markdown cannot break the nudge line.
  ok(!buildNudgeMessage('D1', '**Bonemass**').content.includes('**Bonemass**'), 'a boss name is escaped into the nudge');

  // Charlie's doctrine, swept over the module's own player-visible copy. Only
  // comment lines, journal lines and parser tokens are exempt, exactly as
  // scripts/tellings.test.mjs sweeps tellings.js.
  const isNotPlayerCopy = (line) =>
    /^\s*(\/\/|\*|\/\*)/.test(line) ||
    /log\.(info|warn|error)\?\./.test(line) ||
    /console\.(log|warn|error)/.test(line) ||
    /\.match\(|\.replace\(|RegExp|new Error\(/.test(line);

  const src = readFileSync(new URL('../src/storyteller.js', import.meta.url), 'utf8');
  const offenders = [];
  src.split('\n').forEach((raw, i) => {
    if (isNotPlayerCopy(raw)) return;
    const code = raw.replace(/(^|[^:])\/\/.*$/, '$1');
    if (/[—–]/.test(code)) offenders.push(`storyteller.js:${i + 1}: ${code.trim()}`);
  });
  ok(offenders.length === 0, `no em/en dash in the reply copy, found: ${JSON.stringify(offenders.slice(0, 3))}`);

  // The four locks this module shares with every other mention handler.
  ok(/mentions\?\.has\(client\.user, MENTION_STRICT\)/.test(src), 'it gates on an explicit mention');
  ok(/if \(!message\.guild\) return;/.test(src), 'it refuses a direct message');
  ok(/if \(guildId && message\.guildId !== guildId\) return;/.test(src), 'it refuses another guild');
  ok(/replyPayload\(content\)/.test(src), 'every answer to a member goes through replyPayload, which pins parse: []');
  ok(/allowedMentions: \{ parse: \[\] \}/.test(src), 'and the ballot it posts pings nobody either');
  // The ONE permitted real mention, and it is pinned to named user ids.
  ok(
    /allowedMentions: \{ parse: \[\], users: userIds\.map\(String\) \}/.test(src),
    'the nudge is the only mention, and it names its user ids explicitly',
  );
  ok(!/parse: \['everyone'\]/.test(src), 'nothing here can ping the hall');
}

// ── 12. The three flags, as index.js reads them ───────────────────────────
{
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  for (const [flag, konst, line] of [
    ['STORYTELLER', 'STORYTELLER_ON', '[storyteller]'],
    ['TELLING_VOTES', 'TELLING_VOTES_ON', '[telling-votes]'],
    ['ALTAR_TELLINGS', 'ALTAR_TELLINGS_ON', '[altar-tellings]'],
  ]) {
    const reads = idx.match(new RegExp(`process\\.env\\.${flag}\\b`, 'g')) ?? [];
    eq(reads.length, 1, `${flag} is read exactly once, at startup`);
    ok(
      new RegExp(`const ${konst} = process\\.env\\.${flag} === '1';`).test(idx),
      `${flag} is on only when it is exactly '1'`,
    );
    const mentions = idx.split('\n').filter((l) => l.includes(line));
    ok(mentions.length >= 2, `${line} prints a startup line in live mode and in the dry run`);
    ok(
      mentions.some((l) => /off \(set [A-Z_]+=1 to enable\)/.test(l)) ||
        idx.includes(`'off (set ${flag}=1 to enable)'`),
      `${line} says how to turn it on when it is off`,
    );
  }

  ok(/if \(STORYTELLER_ON\) \{/.test(idx), 'the storyteller handler and loop are behind the flag');
  ok(/if \(TELLING_VOTES_ON\) \{/.test(idx), 'so are the telling votes');
  ok(
    /if \(ALTAR_TELLINGS_ON && VOICE_TARGETING_ON\) \{/.test(idx),
    'and the altar loop additionally refuses to start without targeting, because a broadcast would be wrong',
  );
  ok(
    /office: STORYTELLER_ON/.test(idx),
    'tellings.js only consults the offices table when the office feature is on',
  );
}

console.log(`storyteller.test: ${passed} assertions passed`);
