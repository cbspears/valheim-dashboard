// Tiny persisted state (cursors + dedupe sets) so restarts don't replay history.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';

const STATE_PATH = new URL('../state.json', import.meta.url);

/**
 * THE TWO WAYS THIS FILE USED TO BITE (red-team, 2026-09-05).
 *
 * 1. `JSON.parse` succeeding is not the same as getting an object back. A
 *    state.json holding `null` (or `5`, or `"…"`, or `[]`) parsed fine and was
 *    handed straight to the loops, where the first `state.relay = …` threw
 *    "Cannot set properties of null" at startup — under systemd Restart=always
 *    that is a crash loop, not a degraded bot, and the message points at the
 *    wrong file. Anything that is not a plain object is now treated the way a
 *    corrupt file already was: start fresh, loudly.
 *
 * 2. `writeFile` is not atomic. state.json is rewritten after every relayed
 *    row; a kill (or the box losing power) in the middle of one leaves a
 *    truncated file, which loadState then discards WHOLE — the relay cursor,
 *    the announced-boss set and the poll cursors all reset at once. Writing to
 *    a sibling and renaming makes the swap atomic on the same filesystem, so
 *    the reader only ever sees the old file or the new one.
 */
function asState(parsed, path, log) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  log.error?.(
    `[state] ${path} does not hold an object (${Array.isArray(parsed) ? 'array' : typeof parsed}) — ` +
      `starting from empty state. Cursors reset: the relay resumes from now, and already-felled ` +
      `bosses are re-seeded rather than re-announced.`,
  );
  return {};
}

export async function loadState(path = STATE_PATH, log = console) {
  try {
    const raw = await readFile(path, 'utf8');
    return asState(JSON.parse(raw), path, log);
  } catch {
    // Missing or unparseable (including a torn write): start fresh. The loops
    // all re-seed their own cursors, so this is recoverable by design.
    return {};
  }
}

// THE RACE THIS CLOSES (red-team round 2, 2026-09-05). The first cut of the
// atomic write used ONE fixed `state.json.tmp`. index.js hands every loop the
// same `saveState` closure, `safe()` serialises a loop only against ITSELF, and
// relay.tick() saves after EVERY row (up to 50 a tick) while bosses, voice,
// titles, milestones, recap and the boss polls all save on their own clocks —
// so two writers overlap routinely. Both wrote the same temp path; the first
// rename consumed it and the second threw ENOENT. Measured: 900 concurrent
// saveState calls on one shared object produced 600 rejections.
//
// That throw is not cosmetic. `await saveState()` sits inside relay.tick()'s
// row loop, so an ENOENT aborted the batch mid-flight and `safe('relay')`
// reported the relay loop FAILING to the ops cockpit — poisoning the exact
// alarm the isPermanentPostError change above tells the operator to trust on
// launch night.
//
// A per-call temp name makes concurrent writers independent: each renames its
// own file over state.json, last writer wins, and every caller still sees a
// whole file or the old one. A failed write cleans its own temp up so a full
// disk cannot leave a litter of siblings behind.
let saveSeq = 0;
export async function saveState(state, path = STATE_PATH) {
  const suffix = `.${process.pid}.${++saveSeq}.tmp`;
  const tmp = path instanceof URL ? new URL(`${path.href}${suffix}`) : `${path}${suffix}`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
