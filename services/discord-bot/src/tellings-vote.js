// Telling votes: the hall decides which account of a boss fight stands.
//
// `@Eilif keep <Boss> <n>` is one viking's decision, and it is the right shape
// for most nights. When a boss has collected two or more accounts from the
// people who were actually there, the hall can decide instead: one ballot, one
// reaction per telling, and the winner takes `chosen`. The runner-up is not
// deleted and not hidden; it is marked `apocryphal` and the war room gives it
// its own heading, because the version the hall did not pick is still part of
// how the night is remembered.
//
// THE VERBS (a real `<@Eilif>` mention, in this guild):
//
//   @Eilif vote tellings <Boss>     open a 24 h ballot over that boss's tellings
//   @Eilif close vote <Boss>        close it early and rule
//
// WHO MAY CALL ONE: the Storyteller of Eilif (services/discord-bot/src/
// storyteller.js) or a jarl of this hall. Not the tellers themselves, so a
// viking cannot call a vote on their own telling the moment it is written.
//
// ONE BALLOT PER BOSS AT A TIME, keyed by boss id in state.json, and the ballot
// message is EDITED with its result rather than answered by a second post: a
// hall scrolling back should find one message about one question, carrying the
// tally, not a pair that disagree about whether the count is still open.
//
// OFF BY DEFAULT. index.js only builds this when TELLING_VOTES=1.
//
// Writes: `boss_tellings.chosen` (through tellings.js setChosen, so the partial
// unique index still does the deciding) and `boss_tellings.standing`
// (db/2026-09-06_telling_votes.sql). Before that migration is applied the
// standing write degrades to a journal line and the vote still chooses a
// winner, so the feature is useful the moment the flag is on.

import { serviceClient } from './supabase.js';
import { nameMd, safeText, replyPayload, replySafeName, GOLD } from './format.js';
import { MENTION_STRICT } from './discord.js';
import { matchBoss, listTellings, setChosen, tellingAuthor } from './tellings.js';
import {
  BALLOT_EMOJI,
  MAX_BALLOT_OPTIONS,
  MAX_BALLOT_READ_TRIES,
  cleanName,
  mayHoldElection,
  readCurrentOffice,
  tallyBallot,
  ballotWinner,
  officesNotMigrated,
} from './storyteller.js';

/** A ballot runs a day unless someone closes it early. */
export const VOTE_HOURS = 24;
/** How much of each telling the ballot shows. Charlie's number. */
export const EXCERPT_CHARS = 300;
/** Two tellings is a choice; one is not. */
export const MIN_VOTE_OPTIONS = 2;

/** The two verdicts db/2026-09-06_telling_votes.sql allows, plus null. */
export const STANDING_CANON = 'canon';
export const STANDING_APOCRYPHAL = 'apocryphal';

/**
 * Pull a vote verb out of a mention message, or null if it is not one.
 * Returns { verb: 'vote' | 'close-vote', boss }.
 *
 * Anchored at the start, like every other verb in this bot, so "we should vote
 * on the Bonemass tellings" is a sentence rather than a command. `close vote`
 * cannot collide with storyteller.js's `close election`: each requires its own
 * second word and refuses the other.
 */
export function parseTellingVote(content, botId) {
  const stripped = String(content ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/^[\s,.:!]+/, '')
    .trim();

  const m = stripped.match(/^(vote|close)\b([\s\S]*)$/i);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const rest = m[2].replace(/^[\s:]+/, '').split('\n')[0].trim();

  if (verb === 'vote') {
    const on = rest.match(/^(?:on\s+)?(?:the\s+)?(?:re)?tellings?\b([\s\S]*)$/i);
    if (!on) return null;
    // Word-anchored, never a character class: `[\s:of]` would eat the leading
    // F of "Fader" and open a count on a forsaken called "ader".
    const boss = on[1].replace(/^[\s:]+/, '').replace(/^of\s+/i, '').replace(/[?!.]+$/, '').trim();
    return boss ? { verb: 'vote', boss } : null;
  }

  const on = rest.match(/^(?:the\s+)?vote\b([\s\S]*)$/i);
  if (!on) return null;
  const boss = on[1].replace(/^[\s:]+/, '').replace(/^on\s+/i, '').replace(/[?!.]+$/, '').trim();
  return boss ? { verb: 'close-vote', boss } : null;
}

// ── pure copy ─────────────────────────────────────────────────────────────

/**
 * The ballot options: one reaction per telling, in the order the list already
 * numbers them (chosen first, then newest), capped at the ten marks a ballot
 * carries. Pure.
 */
export function voteOptions(rows = []) {
  return (rows || []).slice(0, MAX_BALLOT_OPTIONS).map((row, i) => ({
    emoji: BALLOT_EMOJI[i],
    tellingId: row.id,
    name: tellingAuthor(row),
    text: row.text,
    chosen: Boolean(row.chosen),
  }));
}

/** The ballot embed: every telling's opening, under the mark that votes for it. */
export function buildVoteEmbed(bossName, options = [], { hours = VOTE_HOURS } = {}) {
  const blocks = options.map(
    (o) =>
      `${o.emoji}  **${nameMd(o.name)}**${o.chosen ? ' · on the war room now' : ''}\n` +
      `${safeText(o.text, EXCERPT_CHARS)}`,
  );
  return {
    title: `Which telling of ${cleanName(bossName, 40)} stands`,
    description:
      'These are the accounts of that fight. React with the mark beside the one the hall should ' +
      `keep on the war room page. The count closes in ${hours} hours.\n\n${blocks.join('\n\n')}`,
    color: GOLD,
    footer: {
      text: 'A tie keeps the telling that already stands. Close it early with: @Eilif close vote <Boss>',
    },
  };
}

/** The same message, rewritten in place once the count is closed. */
export function buildVoteResultEmbed(bossName, tallied = [], winner = null, runnerUp = null) {
  const rows = tallied.map(
    (t) => `${t.emoji}  ${nameMd(t.name)} · ${t.votes} ${t.votes === 1 ? 'ballot' : 'ballots'}`,
  );
  const head = winner
    ? `The hall keeps **${nameMd(winner.name)}**'s telling of ${cleanName(bossName, 40)}.` +
      (runnerUp ? ` ${nameMd(runnerUp.name)}'s stands beside it as the apocryphal version.` : '')
    : `No ballot was cast, so the telling of ${cleanName(bossName, 40)} that stood still stands.`;
  return {
    title: `The tellings of ${cleanName(bossName, 40)}`,
    description: `${head}\n\n${rows.join('\n')}`,
    color: GOLD,
    footer: { text: 'This count is closed.' },
  };
}

// ── database ──────────────────────────────────────────────────────────────

/**
 * Record a vote's verdict on one telling.
 *
 * `standing` arrived in db/2026-09-06_telling_votes.sql, AFTER the table, so
 * this must survive the column not being there: a missing-column error is
 * reported as `notReady` and the caller keeps going. The vote's real outcome is
 * `chosen`, which the older migration already carries, so a hall that has
 * applied one file and not the other still gets a working vote and simply no
 * "apocryphal version" heading on the page.
 */
export async function setStanding(db, tellingId, standing) {
  const { error } = await db.from('boss_tellings').update({ standing }).eq('id', tellingId);
  if (!error) return { notReady: false, ok: true };
  // PGRST204 is "column not found in the schema cache", which is exactly the
  // pre-migration case; officesNotMigrated already reads it that way.
  if (officesNotMigrated(error) || /standing/i.test(error.message || '')) {
    return { notReady: true, ok: false };
  }
  throw new Error(`set standing: ${error.message}`);
}

/**
 * Wipe every verdict this boss carries, so the count about to be written is the
 * only one on the page.
 *
 * A SECOND VOTE IS NOT AN AMENDMENT, IT IS A NEW VERDICT. Without this, closing
 * two counts on the same boss leaves two rows marked apocryphal: the first
 * vote's loser and the second's. The war room shows exactly one under "The
 * apocryphal version" and folds the other into the collapsed list with no
 * heading at all, so the hall would have voted on something the page never
 * mentions. `chosen` never had this problem because tellings.js setChosen
 * clears the boss's flag before setting the new one; this is the same rule for
 * the other column.
 *
 * Scoped to the boss, so a vote on Bonemass never touches the tellings of Moder.
 */
export async function clearStandings(db, bossId) {
  const { error } = await db
    .from('boss_tellings')
    .update({ standing: null })
    .eq('boss_id', bossId)
    .not('standing', 'is', null);
  if (!error) return { notReady: false, ok: true };
  if (officesNotMigrated(error) || /standing/i.test(error.message || '')) {
    return { notReady: true, ok: false };
  }
  throw new Error(`clear standings: ${error.message}`);
}

// ── the handler and the loop ──────────────────────────────────────────────

export function createTellingVotes({
  client,
  db: injectedDb,
  adapter,
  state,
  saveState,
  channel = 'valheim',
  log = console,
  voteHours = VOTE_HOURS,
}) {
  const db = injectedDb ?? serviceClient();

  const guildId = process.env.GUILD_ID || null;
  const adminRoleIds = String(process.env.ADMIN_ROLE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const reply = (message, content) => message.reply(replyPayload(content)).catch(() => {});

  const NOT_READY = 'The Hall’s ledgers are still being carved. Ask again shortly.';

  function st() {
    if (!state.tellingVotes || typeof state.tellingVotes !== 'object') state.tellingVotes = {};
    return state.tellingVotes;
  }

  const BOSS_CACHE_MS = 60_000;
  let bossCache = { at: 0, rows: null };
  async function fetchBosses() {
    if (bossCache.rows && Date.now() - bossCache.at < BOSS_CACHE_MS) return bossCache.rows;
    const { data, error } = await db.from('bosses').select('id, name, sort_order').order('sort_order');
    if (error) throw new Error(`bosses query: ${error.message}`);
    bossCache = { at: Date.now(), rows: data ?? [] };
    return bossCache.rows;
  }

  /**
   * Who may call a vote: the Storyteller, or a jarl. The office read is
   * best-effort, so a hall that has not applied db/2026-09-06_offices.sql still
   * has working votes under the admin half of the rule.
   */
  async function mayCallVote(member) {
    if (mayHoldElection(member, { guildId, adminRoleIds })) return true;
    const senderId = member?.user?.id ?? member?.id ?? null;
    if (!senderId) return false;
    try {
      const { notReady, office } = await readCurrentOffice(db);
      if (notReady || !office) return false;
      return office.holder_discord_id === senderId;
    } catch (e) {
      log.warn?.(`[telling-votes] office check skipped: ${e.message}`);
      return false;
    }
  }

  async function openVote(message, boss) {
    const votes = st();
    if (votes[boss.id]) {
      await reply(
        message,
        `A count on the tellings of ${replySafeName(boss.name)} is already open. Close it with ` +
          `\`@Eilif close vote ${boss.name}\`.`,
      );
      return;
    }

    const { notReady, rows } = await listTellings(db, boss.id);
    if (notReady) {
      await reply(message, NOT_READY);
      return;
    }
    // Only accounts a viking wrote go on a ballot. The Skald's draft is what a
    // vote is trying to replace, and putting it on the ballot would let the
    // hall vote to keep the machine's version over its own people's.
    const told = rows.filter((r) => r.source !== 'skald');
    if (told.length < MIN_VOTE_OPTIONS) {
      await reply(
        message,
        `${replySafeName(boss.name)} has ${told.length === 1 ? 'one telling' : 'no tellings'} from the ` +
          'warband, so there is nothing to choose between. A count needs two.',
      );
      return;
    }

    const options = voteOptions(told);
    const sent = await adapter.postBallot(channel, {
      embed: buildVoteEmbed(boss.name, options, { hours: voteHours }),
      emojis: options.map((o) => o.emoji),
    });
    votes[boss.id] = {
      bossName: boss.name,
      messageId: sent?.messageId ?? null,
      channel,
      openedAt: new Date().toISOString(),
      closesAt: new Date(Date.now() + voteHours * 3600 * 1000).toISOString(),
      options: options.map((o) => ({ emoji: o.emoji, tellingId: o.tellingId, name: o.name })),
    };
    await saveState();
    await reply(
      message,
      `The count is open in #${channel}, with ${options.length} tellings of ` +
        `${replySafeName(boss.name)} on the ballot. It closes in ${voteHours} hours.`,
    );
    log.info?.(`[telling-votes] opened a vote on ${boss.name} (${options.length} tellings)`);
  }

  /**
   * Close one boss's vote.
   *
   * Returns { set, outcome }, where outcome is 'none', 'deferred' (the ballot
   * could not be read, so the count stays open), 'no-votes' or 'ruled'. The
   * deferral is the same rule storyteller.js closeElection keeps and exists for
   * the same reason: a ballot that cannot be read is not a ballot of zero, and
   * announcing one as the other throws away a day of real votes.
   */
  async function closeVote(bossId, { reason = 'clock' } = {}) {
    const votes = st();
    const vote = votes[bossId];
    if (!vote) return { set: 0, outcome: 'none' };

    // READ BEFORE CLEARING, so a failed read is still recoverable. readBallot
    // does not throw, so nothing between here and the clear can half-close.
    const counts = vote.messageId ? await adapter.readBallot(vote.channel || channel, vote.messageId) : null;

    if (counts === null && vote.messageId) {
      const tries = (Number(vote.readFailures) || 0) + 1;
      if (tries < MAX_BALLOT_READ_TRIES) {
        vote.readFailures = tries;
        await saveState();
        log.warn?.(
          `[telling-votes] the ${vote.bossName} ballot could not be read (${reason}, attempt ${tries} of ` +
            `${MAX_BALLOT_READ_TRIES}); the count stays open and will be tried again.`,
        );
        return { set: 0, outcome: 'deferred' };
      }
      log.warn?.(
        `[telling-votes] the ${vote.bossName} ballot could not be read after ${tries} attempts; ` +
          'closing it on what is known.',
      );
    }

    // Cleared here, for the reason storyteller.js clears its ballot: a close
    // that throws after this point must not close again on the next tick.
    delete votes[bossId];
    await saveState();

    const tallied = tallyBallot(vote.options || [], counts || {});
    const winner = ballotWinner(tallied);
    // The runner-up is the second line of the tally, and only when it is a real
    // second: one telling with votes and the rest at zero has no runner-up to
    // mark, and marking a zero-vote telling apocryphal would be the ballot
    // saying something nobody voted on.
    const runnerUp = winner && tallied[1] && tallied[1].votes > 0 ? tallied[1] : null;

    if (vote.messageId) {
      await adapter.editBallot(vote.channel || channel, vote.messageId, {
        embed: buildVoteResultEmbed(vote.bossName, tallied, winner, runnerUp),
      });
    }

    if (!winner) {
      log.info?.(`[telling-votes] the ${vote.bossName} count closed with no votes (${reason})`);
      return { set: 0, outcome: 'no-votes' };
    }

    let set = 0;
    try {
      const res = await setChosen(db, bossId, winner.tellingId);
      if (res.ok) set = 1;
      else log.warn?.(`[telling-votes] ${vote.bossName}: the winning telling could not be set as chosen`);
    } catch (e) {
      log.warn?.(`[telling-votes] ${vote.bossName}: choosing the winner failed: ${e.message}`);
    }

    // The verdicts. Best-effort by contract: the ballot has already been ruled
    // on in public, and a standing that will not write is a missing heading on
    // one page, not a wrong outcome.
    //
    // The wipe comes FIRST, so this count is the only verdict on the boss: a
    // second vote must not leave the first vote's loser still marked, or the
    // war room shows one apocryphal telling out of two and silently drops the
    // one the hall just ruled on.
    try {
      const cleared = await clearStandings(db, bossId);
      const canon = await setStanding(db, winner.tellingId, STANDING_CANON);
      if (runnerUp) await setStanding(db, runnerUp.tellingId, STANDING_APOCRYPHAL);
      if (cleared.notReady || canon.notReady) {
        log.info?.(
          '[telling-votes] db/2026-09-06_telling_votes.sql is not applied yet, so the verdicts were not recorded',
        );
      }
    } catch (e) {
      log.warn?.(`[telling-votes] ${vote.bossName}: standings not recorded: ${e.message}`);
    }

    log.info?.(
      `[telling-votes] ${vote.bossName}: the hall kept ${winner.name}'s telling ` +
        `(${winner.votes} ballots)${runnerUp ? `, ${runnerUp.name}'s is apocryphal` : ''}`,
    );
    return { set, outcome: 'ruled' };
  }

  /** One pass: close every vote whose clock has run out. */
  async function tick(nowMs = Date.now()) {
    let closed = 0;
    for (const [bossId, vote] of Object.entries(st())) {
      if (!vote?.closesAt || Date.parse(vote.closesAt) > nowMs) continue;
      const res = await closeVote(bossId, { reason: 'clock' });
      closed += res.set;
    }
    return closed;
  }

  async function handleMessage(message) {
    try {
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user, MENTION_STRICT)) return;
      if (!message.guild) return;
      if (guildId && message.guildId !== guildId) return;

      const cmd = parseTellingVote(message.content, client.user.id);
      if (!cmd) return;

      const bosses = await fetchBosses();
      const match = matchBoss(cmd.boss, bosses);
      if (match.status === 'ambiguous') {
        await reply(
          message,
          `More than one of the forsaken answers to that. Did you mean ${match.candidates
            .map(replySafeName)
            .join(' or ')}?`,
        );
        return;
      }
      if (!match.boss) {
        await reply(
          message,
          'I do not know that one. Name a forsaken, like `@Eilif vote tellings Bonemass`.',
        );
        return;
      }

      if (!(await mayCallVote(message.member))) {
        await reply(
          message,
          'Only the Storyteller of Eilif, or a jarl of this hall, may call a count on the tellings.',
        );
        return;
      }

      if (cmd.verb === 'vote') {
        await openVote(message, match.boss);
        return;
      }

      if (!st()[match.boss.id]) {
        await reply(
          message,
          `No count is open on the tellings of ${replySafeName(match.boss.name)}.`,
        );
        return;
      }
      const closed = await closeVote(match.boss.id, { reason: 'command' });
      if (closed.outcome === 'deferred') {
        await reply(
          message,
          'The ballot could not be read just now, so the count stays open and nothing is lost. ' +
            'Ask again in a moment.',
        );
        return;
      }
      await reply(
        message,
        closed.set
          ? `The count is closed. The telling the hall kept now stands on the war room page for ${replySafeName(match.boss.name)}.`
          : 'The count is closed. No ballot was cast, so the telling that stood still stands.',
      );
    } catch (e) {
      log.error?.(`[telling-votes] ${e.message}`);
      await reply(message, 'That count could not be run just now. Try again in a moment.').catch(() => {});
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
  }

  return { attach, handleMessage, tick, closeVote, _state: st };
}
