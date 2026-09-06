// The #server relay's own numbers, in one place.
//
// WHY THIS FILE EXISTS. Three tabs judge the same relay: the overview strip
// ("the relay is N rows behind"), the Coming up tab (how long a backlog takes to
// drain) and the Performance tab (the backlog panel). Each track wrote the
// thresholds into its own module, and by the time they met there were three
// declarations of "50 rows" and two of "5 minutes", one of them as a bare 300
// inside an expression. They happened to agree. Nothing made them agree, and the
// insights track had already had to chase one divergence: `>=` on one page and
// `>` on the other made the strip and the performance tab disagree at exactly
// fifty pending rows, which is the one number where a reader would notice.
//
// So the numbers live here and the three modules re-export them. Changing the
// bot's batch size is now one edit, and a page that prints the threshold in its
// evidence line is printing the same threshold the state was computed from.
//
// EVERY VALUE IS TRANSCRIBED FROM THE BOT, not chosen here. If one of these
// stops matching services/discord-bot/, the cockpit is describing a relay that
// does not exist, so each carries the file and the identifier it came from.

/** services/discord-bot/src/relay.js: `BATCH = 50` rows posted per tick. */
export const RELAY_BATCH = 50;

/** services/discord-bot/src/index.js: `POLL_INTERVAL_MS` default 15000. */
export const RELAY_TICK_MS = 15_000;

/**
 * One waiting row older than this reads 'behind'. Five minutes is twenty ticks:
 * far past any single slow post, well short of an outage nobody would notice.
 */
export const RELAY_BEHIND_SEC = 5 * 60;

/**
 * MORE THAN this many rows waiting reads 'behind'. Strictly more than, not "at
 * least": one batch is 50 rows, so exactly 50 waiting is one tick's work and not
 * yet a backlog. Every comparison against this constant must use `>`.
 */
export const RELAY_BEHIND_ROWS = RELAY_BATCH;
