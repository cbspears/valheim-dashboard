// The Storyteller of Eilif.
//
// `boss_tellings` (db/2026-09-06_boss_tellings.sql) lets any linked viking tell
// a boss's fall, and the war-room shows whichever telling is chosen. What it
// does not do is make anyone RESPONSIBLE for the falls nobody has told. This
// module is that: one office, one holder at a time, elected by the hall or
// named by a jarl, with the authority to choose which telling stands on any
// boss and a small loop that nudges them about the tales still owed.
//
// THE VERBS (a real `<@Eilif>` mention, in this guild, guild admins only):
//
//   @Eilif elect storyteller        open a 24 h ballot over the active vikings
//   @Eilif close election           close it early and proclaim the winner
//   @Eilif name storyteller <Char>  install a holder with no vote at all
//
// BALLOTS ARE REACTIONS, not Discord's native poll. bosspoll.js uses the native
// poll because a first-blood question wants to run its full seven days and be
// read once; an election has to be closable on command, has to be re-rendered
// with its own result when it closes, and has to name the candidates back in an
// embed the hall can read after the fact. Reactions do all three; the native
// poll does none of them. What IS reused from bosspoll.js is its shape: pure
// selection, pure copy, a two-method adapter so the loop never touches
// discord.js, and a cursor in state.json so a restart mid-ballot loses nothing.
//
// OFF BY DEFAULT. index.js only builds this when STORYTELLER=1, so nothing
// about launch night changes until Charlie flips it. With the flag off the
// handler is not attached, the loop is not started, and tellings.js does not
// even read the offices table.
//
// Writes: `offices` and `office_nudges` (service role), one voice line per
// proclamation, and state.json for the open ballot. Degrades gracefully before
// db/2026-09-06_offices.sql is applied: a missing table becomes an in-tone
// "not ready yet" reply and the loop does nothing, exactly like identity.js.

import { serviceClient } from './supabase.js';
import { nameMd, replyPayload, replySafeName, clipChars, GOLD } from './format.js';
import { MENTION_STRICT, clampEmbed } from './discord.js';
import { sessionHours, pickTopHours } from './chronicle.js';
import { STORYTELLER_PROCLAIM_LINES, STORYTELLER_NUDGE_LINES } from './voice.js';

/** The only office there is. The check constraint on `offices.office` agrees. */
export const OFFICE = 'storyteller';

/** A ballot runs a day unless a jarl closes it early. */
export const ELECTION_HOURS = 24;
/** Who may stand: a linked viking who has played inside this window. */
export const ELIGIBLE_DAYS = 14;
/**
 * One reaction per candidate. Ten because that is what fits on a message
 * without the ballot reading as a wall of glyphs, and because it is the same
 * ceiling Discord's own poll carries (bosspoll.js MAX_POLL_ANSWERS), so the two
 * features cannot disagree about how many vikings a ballot holds.
 */
export const BALLOT_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
export const MAX_BALLOT_OPTIONS = BALLOT_EMOJI.length;
/** Below this a ballot is not a choice; the verb refuses rather than posting. */
export const MIN_BALLOT_OPTIONS = 2;
/**
 * How many times a close will retry a ballot it could not read before giving
 * up and closing on what it knows. Shared by the election and by telling votes,
 * so the two behave the same way when Discord is unreachable at the wrong
 * minute. Three tries across a thirty minute loop is an hour and a half of
 * grace, which covers a rate limit and a restart; a message someone deleted is
 * never coming back, and a ballot that can never close is worse than one that
 * closes empty.
 */
export const MAX_BALLOT_READ_TRIES = 3;

/** A boss felled after the term began is nudged a day later. */
export const NUDGE_AFTER_KILL_MS = 24 * 3600 * 1000;
/**
 * A boss felled BEFORE the term began is a debt the new holder inherited, not
 * something they let slip, so the clock starts at the term and runs a week.
 */
export const NUDGE_GRACE_MS = 7 * 24 * 3600 * 1000;

// Same two probes tellings.js carries, and for the same reason: a constraint
// violation is a working table saying no, and must never be read as "the
// migration has not run" (which would answer a real refusal with "the ledgers
// are still being carved").
const MISSING_TABLE =
  /relation .* does not exist|could not find the table|undefined table/i;

const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** True when this error means db/2026-09-06_offices.sql has not run. */
export function officesNotMigrated(error) {
  if (!error) return false;
  if (error.code === '23505' || error.code === '23514' || error.code === '23503') return false;
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST204') return true;
  return MISSING_TABLE.test(error.message || '');
}

/** A name, made safe to put in one line of copy or one spoken line. */
export function cleanName(raw, max = 48) {
  const t = String(raw ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return clipChars(t, max);
}

/** "Bren Bjornsson" to "Bren". */
export function firstName(name) {
  const t = cleanName(name);
  return t.split(' ')[0] || 'A viking';
}

/** Case- and space-insensitive roster key, so "bren " and "Bren" are one viking. */
const nameKey = (s) => String(s ?? '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

// Small, pure 31-multiplier string hash, stable across runs. Mirrors format.js,
// retelling.js and tellings.js so seeded choice reads the same way everywhere.
function hashString(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

// ── the verbs ─────────────────────────────────────────────────────────────

/**
 * Pull an office verb out of a mention message, or null if it is not one.
 * Returns { verb: 'elect' | 'close-election' | 'name', name? }.
 *
 * Anchored at the start of what is left after the mention is stripped, so an
 * ordinary sentence that happens to contain "name" or "close" is not a command.
 * `storyteller` is required after `elect` and `name` so the grammar has room
 * for a second office later without re-teaching the hall a new verb.
 */
export function parseOfficeCommand(content, botId) {
  const stripped = String(content ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/^[\s,.:!]+/, '')
    .trim();

  const m = stripped.match(/^(elect|name|close)\b([\s\S]*)$/i);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const rest = m[2].replace(/^[\s:]+/, '').split('\n')[0].trim();

  if (verb === 'close') {
    return /^(the\s+)?election\b/i.test(rest) ? { verb: 'close-election' } : null;
  }

  const office = rest.match(/^(?:the\s+)?storyteller\b([\s\S]*)$/i);
  if (!office) return null;
  const tail = office[1].replace(/^[\s:]+/, '').replace(/[?!.]+$/, '').trim();

  if (verb === 'elect') return { verb: 'elect' };
  return tail ? { verb: 'name', name: tail } : null;
}

/**
 * Who may open, close or hand out the office: a jarl of THIS hall.
 *
 * The same check the voice puppet uses (voice.js mayPuppet) and `keep` uses
 * (tellings.js mayKeepTelling), including the guild pin: `member.permissions`
 * is authority in the guild the message came from, so without it the owner of
 * any other guild the bot is in could install their own Storyteller here.
 */
export function mayHoldElection(member, { guildId = null, adminRoleIds = [] } = {}) {
  if (!member) return false; // a direct message has no member, so it has no permissions
  if (guildId && member.guild?.id !== guildId) return false;
  if (member.permissions?.has?.('Administrator')) return true;
  if (member.permissions?.has?.('ManageGuild')) return true;
  return adminRoleIds.some((id) => member.roles?.cache?.has?.(id));
}

// ── pure selection ────────────────────────────────────────────────────────

/**
 * The ballot: linked vikings who have actually played inside the window, most
 * hours first, then name ascending, capped at MAX_BALLOT_OPTIONS.
 *
 * Ranking is `sessionHours` + `pickTopHours` from chronicle.js, the same pair
 * the weekly hours board and the boss poll's ballot use, so "active lately"
 * means one thing across the whole bot. The linked-only filter is what makes
 * the office reachable: the holder has to be addressable in Discord for the
 * nudge, and identifiable as a character for the site badge.
 *
 * Pure. `players` are roster rows, `sessions` are session rows.
 */
export function eligibleCandidates(
  players = [],
  sessions = [],
  { nowMs = Date.now(), days = ELIGIBLE_DAYS, max = MAX_BALLOT_OPTIONS } = {},
) {
  const linked = new Map();
  for (const p of players || []) {
    const name = cleanName(p?.character_name);
    const discordId = p?.discord_user_id;
    if (!name || !discordId) continue;
    linked.set(nameKey(name), { name, discordId: String(discordId) });
  }
  if (linked.size === 0) return [];

  const startMs = nowMs - days * 24 * 3600 * 1000;
  const { hours } = sessionHours(sessions, startMs, nowMs);
  // A generous slice first, then the linked filter, so a hall where the top ten
  // by hours happen to be unlinked still puts the linked eleventh on the ballot.
  return pickTopHours(hours, 200)
    .map((row) => ({ row, linked: linked.get(nameKey(row.name)) }))
    .filter((r) => r.linked)
    .slice(0, max)
    .map((r, i) => ({
      emoji: BALLOT_EMOJI[i],
      name: r.linked.name,
      discordId: r.linked.discordId,
      hours: r.row.hours,
    }));
}

/**
 * Count a reaction ballot. `counts` maps an emoji to the votes cast on it (the
 * bot's own seeding react already subtracted by the adapter).
 *
 * Ties break on BALLOT ORDER, which is hours descending: the viking who has
 * given the hall more of their time this fortnight wins a dead heat. That is a
 * rule rather than a coin flip, so the same ballot always reads the same way,
 * and it is stated out loud in the ballot's own footer.
 *
 * Pure. Returns every option, sorted, so the result embed can show the tally.
 */
export function tallyBallot(options = [], counts = {}) {
  return (options || [])
    .map((opt, index) => ({ ...opt, index, votes: Math.max(0, Number(counts?.[opt.emoji]) || 0) }))
    .sort((a, b) => b.votes - a.votes || a.index - b.index);
}

/** The winner of a tallied ballot, or null when nobody voted at all. */
export function ballotWinner(tallied = []) {
  const top = tallied[0];
  return top && top.votes > 0 ? top : null;
}

/**
 * The act of the saga a term opens in: the furthest forsaken the warband has
 * put down. It is the roughest possible measure of "when", and it is the one a
 * viking actually remembers ("that was back in the Bonemass days").
 * Pure. 'opening' before the first kill.
 */
export function actName(bosses = []) {
  const felled = (bosses || [])
    .filter((b) => b?.is_killed && b?.name)
    .sort((a, b) => (b.sort_order || 0) - (a.sort_order || 0))[0];
  return felled ? cleanName(felled.name, 40) : 'opening';
}

/**
 * The backlog: every boss that has fallen and that no VIKING has told. The
 * Skald's own telling does not clear a debt; it is the draft the office exists
 * to replace.
 *
 * Pure. `playerToldBossIds` is the set of boss ids carrying a `player` telling.
 * Ladder order, so the list reads the way the World timeline does.
 */
export function backlogBosses(bosses = [], playerToldBossIds = []) {
  const told = new Set(playerToldBossIds);
  return (bosses || [])
    .filter((b) => b?.is_killed && b?.id && !told.has(b.id))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map((b) => b.name)
    .filter(Boolean);
}

const COUNT_WORDS = [
  'No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
];

/**
 * A boss inside a sentence. "The Elder" opens a list as itself and sits inside
 * one lower-cased, so "Eikthyr and the Elder" reads as English rather than as
 * two headlines. Pure.
 */
export function bossInProse(name, first = false) {
  const clean = cleanName(name, 40);
  if (first) return clean;
  return clean.replace(/^The\b/, 'the');
}

/** "Eikthyr, the Elder and Bonemass". Pure. */
export function joinBosses(names = []) {
  const list = (names || []).map((n, i) => bossInProse(n, i === 0)).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The line the proclamation closes on: what the new Storyteller has inherited.
 * Pure, and deliberately never a scolding: a full backlog is the hall's debt,
 * not the holder's failure, on the night they take the office.
 */
export function formatBacklog(names = []) {
  const list = (names || []).filter(Boolean);
  if (list.length === 0) {
    return 'No tale waits for you, Storyteller. Every forsaken that has fallen has been told.';
  }
  const word = COUNT_WORDS[list.length] ?? String(list.length);
  const shown = list.slice(0, 8);
  const tail = list.length > shown.length ? `${joinBosses(shown)} and ${list.length - shown.length} more` : joinBosses(shown);
  return `${word} ${list.length === 1 ? 'tale waits' : 'tales wait'} for you, Storyteller: ${tail}.`;
}

// ── the nudge clock ───────────────────────────────────────────────────────

/**
 * When the Storyteller is owed a nudge about one fallen boss.
 *
 * A boss felled DURING the term: a day after the kill, which is long enough for
 * the war party to have slept on it and short enough that the fight is still in
 * their hands. A boss felled BEFORE the term: a week after the term opened,
 * because a new holder inherits a backlog and should not be nudged about all of
 * it on their first morning.
 *
 * Pure. Returns epoch ms, or null when neither date is readable.
 */
export function nudgeDueAt(killedAt, officeSince) {
  const killed = Date.parse(killedAt ?? '');
  const since = Date.parse(officeSince ?? '');
  if (!Number.isFinite(killed)) {
    return Number.isFinite(since) ? since + NUDGE_GRACE_MS : null;
  }
  if (!Number.isFinite(since)) return killed + NUDGE_AFTER_KILL_MS;
  return killed >= since ? killed + NUDGE_AFTER_KILL_MS : since + NUDGE_GRACE_MS;
}

/**
 * The fallen bosses this term still owes a nudge for, soonest-due first.
 * Pure, so the whole schedule is testable without a clock or a database.
 */
export function bossesDueForNudge({
  bosses = [],
  playerToldBossIds = [],
  nudgedBossIds = [],
  officeSince = null,
  nowMs = Date.now(),
} = {}) {
  const told = new Set(playerToldBossIds);
  const nudged = new Set(nudgedBossIds);
  return (bosses || [])
    .filter((b) => b?.is_killed && b?.id && !told.has(b.id) && !nudged.has(b.id))
    .map((boss) => ({ boss, dueAt: nudgeDueAt(boss.killed_at, officeSince) }))
    .filter((r) => r.dueAt != null && nowMs >= r.dueAt)
    .sort((a, b) => a.dueAt - b.dueAt);
}

// ── the voice ─────────────────────────────────────────────────────────────

/** The line the whole hall hears when a Storyteller is installed. */
export function proclaimVoiceLine(characterName, seed = null) {
  const key = seed ?? `proclaim|${characterName}`;
  const tpl = STORYTELLER_PROCLAIM_LINES[hashString(key) % STORYTELLER_PROCLAIM_LINES.length];
  return tpl.replace(/\{firstName\}/g, () => firstName(characterName));
}

/** The line the Storyteller alone hears about an untold fall. */
export function nudgeVoiceLine(bossName, seed = null) {
  const key = seed ?? `nudge|${bossName}`;
  const tpl = STORYTELLER_NUDGE_LINES[hashString(key) % STORYTELLER_NUDGE_LINES.length];
  return tpl.replace(/\{boss\}/g, () => cleanName(bossName, 32) || 'a forsaken');
}

// ── pure copy ─────────────────────────────────────────────────────────────

/** The ballot embed. Plain label first, the Norse register underneath. */
export function buildElectionEmbed(candidates = [], { hours = ELECTION_HOURS } = {}) {
  const lines = candidates.map((c) => `${c.emoji}  ${nameMd(cleanName(c.name, 32))}`);
  return {
    title: 'The hall chooses a Storyteller',
    description:
      'One viking keeps the tales of Eilif: which telling stands on a war room page, and the falls ' +
      'nobody has told yet.\n\nReact with the mark beside a name to cast your ballot. ' +
      `The count closes in ${hours} hours.\n\n${lines.join('\n')}`,
    color: GOLD,
    footer: {
      text: 'A tie goes to the viking with more hours in the hall. Close it early with: @Eilif close election',
    },
  };
}

/** The same message, rewritten in place once the ballot is closed. */
export function buildElectionResultEmbed(tallied = [], winner = null) {
  const rows = tallied.map(
    (t) => `${t.emoji}  ${nameMd(cleanName(t.name, 32))} · ${t.votes} ${t.votes === 1 ? 'ballot' : 'ballots'}`,
  );
  return {
    title: winner ? 'The hall has chosen' : 'The ballot closed with no votes',
    description: winner
      ? `**${nameMd(cleanName(winner.name, 32))}** is Storyteller of Eilif.\n\n${rows.join('\n')}`
      : `No ballot was cast, so the office stands as it was.\n\n${rows.join('\n')}`,
    color: GOLD,
    footer: { text: 'This count is closed.' },
  };
}

/** The proclamation, posted fresh so the hall sees it rather than an edit. */
export function buildProclamationEmbed(name, backlogNames = [], { electedBy = 'vote' } = {}) {
  return {
    title: 'Storyteller of Eilif',
    description:
      `**${nameMd(cleanName(name, 32))}** keeps the tales of Eilif from this hour. ` +
      `They choose which telling stands on any war room page.\n\n${formatBacklog(backlogNames)}`,
    color: GOLD,
    footer: {
      text:
        electedBy === 'vote'
          ? 'Chosen by the hall. Tell one with: @Eilif retell <Boss>: <your telling>'
          : 'Named by a jarl. Tell one with: @Eilif retell <Boss>: <your telling>',
    },
  };
}

/**
 * The nudge itself. THE ONE PLACE IN THIS BOT A REAL MENTION IS ALLOWED: the
 * whole point is to reach one viking who agreed to be reachable, and the
 * adapter pins allowed_mentions to that single user id, never to a role and
 * never to everyone.
 */
export function buildNudgeMessage(mentionId, bossName, { untoldCount = 1 } = {}) {
  const boss = replySafeName(bossName);
  const more =
    untoldCount > 1
      ? ` ${untoldCount - 1} other ${untoldCount - 1 === 1 ? 'fall waits' : 'falls wait'} as well.`
      : '';
  return {
    content:
      `<@${mentionId}> ${boss} has fallen and no viking has told it. The war room still shows the ` +
      `Skald's draft.${more}\nSet it down with \`@Eilif retell ${boss}: <your telling>\`, or ` +
      'ask whoever swung hardest to write theirs.',
    userIds: [String(mentionId)],
  };
}

// ── the ballot adapter ────────────────────────────────────────────────────
//
// The poster in discord.js only speaks {content, embeds} and pins
// allowedMentions to nothing; a reaction ballot needs the raw channel (to react
// and to edit), and the nudge needs the one permitted user mention. Both live
// behind this adapter so the loop below never touches discord.js and the dry
// run can hand in a printer. Same division bosspoll.js draws.

/** Real adapter: reacts, reads reactions back, edits, and mentions one user. */
export function createBallotAdapter({ client, channelIds }) {
  const channelFor = async (key) => {
    const id = channelIds[key];
    if (!id) throw new Error(`no channel id configured for "${key}"`);
    const ch = await client.channels.fetch(id);
    if (!ch) throw new Error(`channel "${key}" (${id}) not found`);
    return ch;
  };

  return {
    /** Post a ballot and seed one reaction per option. */
    async postBallot(channelKey, { embed, emojis = [] }) {
      const ch = await channelFor(channelKey);
      const msg = await ch.send({
        embeds: [clampEmbed(embed)],
        allowedMentions: { parse: [] },
      });
      // Seeded in order and awaited, so the marks read 1,2,3 rather than in
      // whatever order the gateway acknowledged them. A react that fails is not
      // fatal: the option is still on the embed and a voter can add the mark.
      for (const emoji of emojis) {
        await msg.react(emoji).catch((e) => {
          console.warn(`[storyteller] could not seed the ${emoji} ballot mark: ${e.message}`);
        });
      }
      return { messageId: msg.id, channelId: ch.id };
    },

    /**
     * Votes per emoji. The bot seeded every mark itself, so its own reaction is
     * subtracted: a ballot nobody touched must read zero, not one each.
     * Null when the message is gone.
     */
    async readBallot(channelKey, messageId) {
      try {
        const ch = await channelFor(channelKey);
        const msg = await ch.messages.fetch(messageId);
        const counts = {};
        for (const reaction of msg.reactions.cache.values()) {
          const key = reaction.emoji?.name;
          if (!key) continue;
          counts[key] = Math.max(0, (reaction.count || 0) - (reaction.me ? 1 : 0));
        }
        return counts;
      } catch (e) {
        console.warn(`[storyteller] could not read ballot ${messageId}: ${e.message}`);
        return null;
      }
    },

    /** Rewrite the ballot in place with its result. Never re-posts. */
    async editBallot(channelKey, messageId, { embed }) {
      try {
        const ch = await channelFor(channelKey);
        const msg = await ch.messages.fetch(messageId);
        await msg.edit({ embeds: [clampEmbed(embed)], allowedMentions: { parse: [] } });
        return true;
      } catch (e) {
        console.warn(`[storyteller] could not rewrite ballot ${messageId}: ${e.message}`);
        return false;
      }
    },

    /**
     * The nudge. `users` is the ONLY allowed_mentions this bot ever sets beyond
     * @everyone on a boss kill, and it is pinned to the ids the caller named.
     */
    async sendMentioning(channelKey, { content, userIds = [] }) {
      const ch = await channelFor(channelKey);
      await ch.send({
        content,
        allowedMentions: { parse: [], users: userIds.map(String) },
      });
      return true;
    },
  };
}

/** Dry-run adapter: prints what it would send, reacts to nothing, reads nothing. */
export function createDryRunBallotAdapter() {
  let n = 0;
  return {
    async postBallot(channelKey, { embed, emojis = [] }) {
      n += 1;
      console.log(`\n[dry-run ballot → #${channelKey}]`);
      console.log(`  «${embed.title}»`);
      console.log(`   ${String(embed.description).replace(/\n/g, '\n   ')}`);
      console.log(`  (marks: ${emojis.join(' ')})`);
      return { messageId: `dry-run-ballot-${n}`, channelId: null };
    },
    async readBallot() {
      console.log('  [dry-run ballot] reactions are not read (no gateway); the count reads as empty');
      return null;
    },
    async editBallot(channelKey, messageId, { embed }) {
      console.log(`\n[dry-run ballot edit → #${channelKey}] «${embed.title}»`);
      return true;
    },
    async sendMentioning(channelKey, { content }) {
      console.log(`\n[dry-run nudge → #${channelKey}]\n  ${content.replace(/\n/g, '\n  ')}`);
      return true;
    },
  };
}

// ── database ──────────────────────────────────────────────────────────────

/**
 * The open term, or null when the office is vacant.
 * `{ notReady: true }` means db/2026-09-06_offices.sql has not run.
 */
export async function readCurrentOffice(db) {
  const { data, error } = await db
    .from('offices')
    .select('id, office, holder_character, holder_discord_id, since, elected_by, act')
    .eq('office', OFFICE)
    .is('until', null)
    .maybeSingle();
  if (error) {
    if (officesNotMigrated(error)) return { notReady: true, office: null };
    throw new Error(`offices read: ${error.message}`);
  }
  return { notReady: false, office: data ?? null };
}

/**
 * Install a holder: close the open term, then open a new one.
 *
 * IN THAT ORDER, because `offices_one_holder_idx` will not hold two open terms
 * at once. A failure between the two statements leaves the hall with no
 * Storyteller, which every reader renders correctly (no badge, no nudges, and
 * `keep` falls back to author-or-jarl), and the next `elect` repairs it. The
 * other order would fail the insert and leave the OLD holder in office while
 * the hall had just been told someone else won, which is worse.
 */
export async function installHolder(
  db,
  { character, discordId, electedBy = 'vote', act = null, nowIso = new Date().toISOString() },
) {
  const closed = await db
    .from('offices')
    .update({ until: nowIso })
    .eq('office', OFFICE)
    .is('until', null);
  if (closed.error) {
    if (officesNotMigrated(closed.error)) return { notReady: true, office: null };
    throw new Error(`close term: ${closed.error.message}`);
  }

  const { data, error } = await db
    .from('offices')
    .insert({
      office: OFFICE,
      holder_character: character ?? null,
      holder_discord_id: discordId ?? null,
      since: nowIso,
      elected_by: electedBy,
      act,
    })
    .select('id, holder_character, holder_discord_id, since, elected_by, act')
    .single();
  if (error) {
    if (officesNotMigrated(error)) return { notReady: true, office: null };
    throw new Error(`open term: ${error.message}`);
  }
  return { notReady: false, office: data ?? null };
}

/** Boss ids that carry at least one telling written by a viking. */
export async function readPlayerToldBossIds(db) {
  const { data, error } = await db
    .from('boss_tellings')
    .select('boss_id')
    .eq('source', 'player')
    .limit(500);
  if (error) {
    // The tellings table is a separate migration, and a hall that has not
    // applied it has no player tellings at all, so an empty list is the honest
    // answer rather than a failure.
    if (officesNotMigrated(error)) return { notReady: true, ids: [] };
    throw new Error(`player tellings: ${error.message}`);
  }
  return { notReady: false, ids: [...new Set((data ?? []).map((r) => r.boss_id).filter(Boolean))] };
}

/** Boss ids this term has already been nudged about. */
export async function readNudgedBossIds(db, officeId) {
  const { data, error } = await db
    .from('office_nudges')
    .select('boss_id')
    .eq('office_id', officeId)
    .limit(500);
  if (error) {
    if (officesNotMigrated(error)) return { notReady: true, ids: [] };
    throw new Error(`office nudges: ${error.message}`);
  }
  return { notReady: false, ids: (data ?? []).map((r) => r.boss_id).filter(Boolean) };
}

/** Mark one boss nudged for one term. The primary key is the idempotency. */
export async function markNudged(db, { bossId, officeId, nowIso = new Date().toISOString() }) {
  const { error } = await db
    .from('office_nudges')
    .insert({ boss_id: bossId, office_id: officeId, sent_at: nowIso });
  if (!error) return { notReady: false, marked: true };
  // 23505 = the row is already there, which is the mark doing its job.
  if (error.code === '23505') return { notReady: false, marked: true };
  if (officesNotMigrated(error)) return { notReady: true, marked: false };
  throw new Error(`mark nudged: ${error.message}`);
}

// ── the handler and the loop ──────────────────────────────────────────────

export function createStoryteller({
  client,
  db: injectedDb,
  post,
  adapter,
  state,
  saveState,
  channel = 'valheim',
  log = console,
  electionHours = ELECTION_HOURS,
}) {
  // `injectedDb` is the same test seam createTellings and createVoiceEngine use.
  const db = injectedDb ?? serviceClient();

  // Pinned to this hall for the reasons identity.js and tellings.js are: this
  // module writes with the service role and answers in a channel.
  const guildId = process.env.GUILD_ID || null;
  const adminRoleIds = String(process.env.ADMIN_ROLE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const targeting = () => process.env.VOICE_TARGETING === '1';

  // Nudges posted by THIS process whose office_nudges row has not landed yet.
  // Same guard milestones.js carries: the post is the irreversible half, so a
  // failed mark must retry the WRITE on the next tick, never the message.
  const nudgedHere = new Set();

  // Every answer to a jarl is plain text: the ballot and the proclamation are
  // the embeds, and they go to the channel rather than back at the command.
  // `clampEmbed` still guards both, inside the adapter and inside `post`.
  const reply = (message, content) => message.reply(replyPayload(content)).catch(() => {});

  const NOT_READY = 'The Hall’s ledgers are still being carved. Ask again shortly.';

  function st() {
    if (!state.offices || typeof state.offices !== 'object') state.offices = {};
    const s = state.offices;
    if (!s.election || typeof s.election !== 'object') s.election = null;
    return s;
  }

  async function fetchBosses() {
    const { data, error } = await db
      .from('bosses')
      .select('id, name, sort_order, is_killed, killed_at')
      .order('sort_order');
    if (error) throw new Error(`bosses query: ${error.message}`);
    return data ?? [];
  }

  async function queueVoiceLine(text, meta) {
    const { error } = await db.from('voice_lines').insert({
      text,
      kind: 'event',
      meta,
      status: 'queued',
      queued_at: new Date().toISOString(),
    });
    if (error) log.warn?.(`[storyteller] voice line not queued: ${error.message}`);
    return !error;
  }

  /** The backlog as of right now, for the proclamation. Never fatal. */
  async function currentBacklog(bosses) {
    try {
      const told = await readPlayerToldBossIds(db);
      return backlogBosses(bosses, told.ids);
    } catch (e) {
      log.warn?.(`[storyteller] backlog skipped: ${e.message}`);
      return [];
    }
  }

  /**
   * Install a holder and tell the hall: the Discord embed and the one spoken
   * line, in the same moment, the way milestones.js announces a deed.
   */
  async function proclaim({ name, discordId, electedBy, bosses }) {
    const act = actName(bosses);
    const res = await installHolder(db, { character: name, discordId, electedBy, act });
    if (res.notReady) return { notReady: true, office: null };

    const backlog = await currentBacklog(bosses);
    await post(channel, { embeds: [buildProclamationEmbed(name, backlog, { electedBy })] });
    await queueVoiceLine(proclaimVoiceLine(name, res.office?.id ?? name), {
      source: 'storyteller',
      office_id: res.office?.id ?? null,
      holder: name,
      elected_by: electedBy,
    });
    log.info?.(
      `[storyteller] ${name} holds the office (${electedBy}, act "${act}", ${backlog.length} tale(s) owed)`,
    );
    return { notReady: false, office: res.office };
  }

  // ── elections ───────────────────────────────────────────────────────────

  async function openElection(message) {
    const s = st();
    if (s.election) {
      await reply(
        message,
        'A count is already open. Close it with `@Eilif close election`, then call another.',
      );
      return;
    }

    const [playersRes, sessionsRes] = await Promise.all([
      db.from('players').select('character_name, discord_user_id'),
      db
        .from('sessions')
        .select('character_name, joined_at, left_at')
        .or(`left_at.is.null,left_at.gte.${new Date(Date.now() - ELIGIBLE_DAYS * 86400000).toISOString()}`),
    ]);
    if (playersRes.error) throw new Error(`players: ${playersRes.error.message}`);
    if (sessionsRes.error) throw new Error(`sessions: ${sessionsRes.error.message}`);

    const candidates = eligibleCandidates(playersRes.data ?? [], sessionsRes.data ?? []);
    if (candidates.length < MIN_BALLOT_OPTIONS) {
      await reply(
        message,
        `Only ${candidates.length} linked viking has been in the hall these last ${ELIGIBLE_DAYS} days, ` +
          'so there is nothing to choose between. Name one instead with `@Eilif name storyteller <Viking>`.',
      );
      return;
    }

    const embed = buildElectionEmbed(candidates, { hours: electionHours });
    const sent = await adapter.postBallot(channel, { embed, emojis: candidates.map((c) => c.emoji) });
    s.election = {
      messageId: sent?.messageId ?? null,
      channel,
      openedAt: new Date().toISOString(),
      closesAt: new Date(Date.now() + electionHours * 3600 * 1000).toISOString(),
      candidates: candidates.map((c) => ({ emoji: c.emoji, name: c.name, discordId: c.discordId })),
    };
    await saveState();
    await reply(
      message,
      `The count is open in #${channel}, with ${candidates.length} vikings on the ballot. ` +
        `It closes in ${electionHours} hours.`,
    );
    log.info?.(`[storyteller] election opened with ${candidates.length} candidates`);
  }

  /**
   * Close the open ballot: read it, rewrite it in place with the tally, and
   * install the winner.
   *
   * Returns { installed, outcome }, where outcome is one of 'none' (no ballot
   * was open), 'deferred' (the count could not be read, so the ballot stays
   * open), 'no-votes', 'not-ready' (the offices migration has not run) or
   * 'installed'.
   *
   * A COUNT THAT CANNOT BE READ IS NOT A COUNT OF ZERO. `readBallot` answers
   * null for a rate limit, a fetch that failed and a message someone deleted
   * alike, and treating null as an empty tally would throw away a day of real
   * ballots and tell the hall, in writing, that nobody voted. So a failed read
   * leaves the ballot exactly where it was and tries again on the next tick.
   * Bounded, because a deleted message never comes back: after
   * MAX_BALLOT_READ_TRIES the close goes through on whatever it has, and the
   * hall gets an honest "no votes" rather than a ballot that never closes.
   */
  async function closeElection({ reason = 'clock' } = {}) {
    const s = st();
    const election = s.election;
    if (!election) return { installed: 0, outcome: 'none' };

    // READ BEFORE CLEARING, so a failure is still recoverable. `readBallot`
    // does not throw, so nothing between here and the clear below can leave a
    // half-closed ballot.
    const counts = election.messageId
      ? await adapter.readBallot(election.channel || channel, election.messageId)
      : null;

    if (counts === null && election.messageId) {
      const tries = (Number(election.readFailures) || 0) + 1;
      if (tries < MAX_BALLOT_READ_TRIES) {
        election.readFailures = tries;
        await saveState();
        log.warn?.(
          `[storyteller] the ballot could not be read (${reason}, attempt ${tries} of ` +
            `${MAX_BALLOT_READ_TRIES}); the count stays open and will be tried again.`,
        );
        return { installed: 0, outcome: 'deferred' };
      }
      log.warn?.(
        `[storyteller] the ballot could not be read after ${tries} attempts; closing it on what is known.`,
      );
    }

    // The ballot is cleared from state HERE. A close that throws after this
    // point must not leave a ballot that closes again on the next tick and
    // proclaims a second time; the message on Discord is the record either way.
    s.election = null;
    await saveState();

    const tallied = tallyBallot(election.candidates || [], counts || {});
    const winner = ballotWinner(tallied);

    if (election.messageId) {
      await adapter.editBallot(election.channel || channel, election.messageId, {
        embed: buildElectionResultEmbed(tallied, winner),
      });
    }

    if (!winner) {
      log.info?.(`[storyteller] the ballot closed with no votes (${reason})`);
      return { installed: 0, outcome: 'no-votes' };
    }

    const bosses = await fetchBosses();
    const res = await proclaim({
      name: winner.name,
      discordId: winner.discordId,
      electedBy: 'vote',
      bosses,
    });
    return res.notReady
      ? { installed: 0, outcome: 'not-ready' }
      : { installed: 1, outcome: 'installed' };
  }

  async function nameHolder(message, typedName) {
    const { data: players, error } = await db
      .from('players')
      .select('character_name, discord_user_id');
    if (error) throw new Error(`players: ${error.message}`);

    const key = nameKey(typedName);
    const match = (players ?? []).find((p) => nameKey(p.character_name) === key);
    if (!match) {
      await reply(
        message,
        `I do not know a viking called ${replySafeName(typedName)}. Name them exactly as the roster does.`,
      );
      return;
    }
    if (!match.discord_user_id) {
      await reply(
        message,
        `${replySafeName(match.character_name)} has not told Eilif who they are yet, so the office cannot ` +
          'reach them. Ask them for `@Eilif I am <their viking>` first.',
      );
      return;
    }

    const bosses = await fetchBosses();
    const res = await proclaim({
      name: match.character_name,
      discordId: match.discord_user_id,
      electedBy: 'named',
      bosses,
    });
    if (res.notReady) {
      await reply(message, NOT_READY);
      return;
    }
    await reply(
      message,
      `${replySafeName(match.character_name)} is Storyteller of Eilif. It is proclaimed in #${channel}.`,
    );
  }

  // ── nudges ──────────────────────────────────────────────────────────────

  /** One nudge per tick at most, oldest debt first. Returns how many it sent. */
  async function nudgeTick(nowMs = Date.now()) {
    const current = await readCurrentOffice(db);
    if (current.notReady || !current.office) return 0;
    const office = current.office;
    if (!office.holder_discord_id) return 0;

    const [bosses, told, nudged] = await Promise.all([
      fetchBosses(),
      readPlayerToldBossIds(db),
      readNudgedBossIds(db, office.id),
    ]);
    if (told.notReady || nudged.notReady) return 0;

    // A nudge this process already sent but could not mark is not owed again.
    const alreadySent = [
      ...nudged.ids,
      ...[...nudgedHere].filter((k) => k.startsWith(`${office.id}|`)).map((k) => k.slice(office.id.length + 1)),
    ];
    const due = bossesDueForNudge({
      bosses,
      playerToldBossIds: told.ids,
      nudgedBossIds: alreadySent,
      officeSince: office.since,
      nowMs,
    });

    // Retry any mark this process owes before opening a new debt, so a run of
    // failed writes cannot re-post anything.
    for (const key of [...nudgedHere]) {
      const [officeId, bossId] = key.split('|');
      if (officeId !== office.id) continue;
      const marked = await markNudged(db, { bossId, officeId }).catch(() => ({ marked: false }));
      if (marked.marked) nudgedHere.delete(key);
    }

    if (due.length === 0) return 0;
    const { boss } = due[0];

    await adapter.sendMentioning(channel, {
      ...buildNudgeMessage(office.holder_discord_id, boss.name, { untoldCount: due.length }),
    });
    // The message is out. From here the nudge counts as sent whatever the write
    // below does: a post that happened cannot be unhappened.
    nudgedHere.add(`${office.id}|${boss.id}`);

    // The private half. A broadcast would tell the whole hall that their
    // Storyteller is behind, which is a different message entirely, so with
    // targeting off there is simply no voice line.
    if (targeting()) {
      await queueVoiceLine(nudgeVoiceLine(boss.name, `${office.id}|${boss.id}`), {
        source: 'storyteller_nudge',
        target: office.holder_character,
        office_id: office.id,
        boss: boss.name,
      });
    }

    const marked = await markNudged(db, { bossId: boss.id, officeId: office.id });
    if (marked.marked) nudgedHere.delete(`${office.id}|${boss.id}`);

    log.info?.(
      `[storyteller] nudged ${office.holder_character ?? 'the Storyteller'} about ${boss.name} ` +
        `(${due.length} tale(s) owed)`,
    );
    return 1;
  }

  /** One pass: close a ballot whose clock has run out, then owe one nudge. */
  async function tick(nowMs = Date.now()) {
    let sent = 0;
    const s = st();
    if (s.election?.closesAt && Date.parse(s.election.closesAt) <= nowMs) {
      const closed = await closeElection({ reason: 'clock' });
      sent += closed.installed;
    }
    sent += await nudgeTick(nowMs);
    return sent;
  }

  // ── the message handler ─────────────────────────────────────────────────

  async function handleMessage(message) {
    try {
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user, MENTION_STRICT)) return;
      if (!message.guild) return;
      if (guildId && message.guildId !== guildId) return;

      const cmd = parseOfficeCommand(message.content, client.user.id);
      if (!cmd) return;

      if (!mayHoldElection(message.member, { guildId, adminRoleIds })) {
        await reply(message, 'Only a jarl of this hall may open a count or hand out the office.');
        return;
      }

      if (cmd.verb === 'elect') {
        await openElection(message);
        return;
      }
      if (cmd.verb === 'close-election') {
        if (!st().election) {
          await reply(message, 'No count is open. Call one with `@Eilif elect storyteller`.');
          return;
        }
        const closed = await closeElection({ reason: 'command' });
        // Four different things happened, and three of them are not "nobody
        // voted". A jarl told the wrong one would either think the hall stayed
        // silent or go looking for a Storyteller who was never installed.
        if (closed.outcome === 'deferred') {
          await reply(
            message,
            'The ballot could not be read just now, so the count stays open and nothing is lost. ' +
              'Ask again in a moment.',
          );
          return;
        }
        if (closed.outcome === 'not-ready') {
          await reply(message, NOT_READY);
          return;
        }
        await reply(
          message,
          closed.installed
            ? `The count is closed and the hall has its Storyteller. It is proclaimed in #${channel}.`
            : 'The count is closed. No ballot was cast, so the office stands as it was.',
        );
        return;
      }
      if (cmd.verb === 'name') await nameHolder(message, cmd.name);
    } catch (e) {
      log.error?.(`[storyteller] ${e.message}`);
      // Never leave a jarl's command unanswered: an unhandled read failure used
      // to look exactly like the bot ignoring them.
      await reply(message, 'That could not be done just now. Try again in a moment.').catch(() => {});
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
  }

  return {
    attach,
    handleMessage,
    tick,
    closeElection,
    _proclaim: proclaim,
    _state: st,
  };
}
