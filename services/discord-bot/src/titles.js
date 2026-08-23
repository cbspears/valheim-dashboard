// The Living Titles announcer.
//
// The dashboard's shared epithet engine (lib/epithets.ts) names every viking from
// their deeds + rank against the warband; GET /api/titles exposes the current
// title for each player as the single source of truth. THIS loop polls that
// endpoint (~every 10 min), compares each viking's computed title to the one the
// hall currently knows them by (players.current_title), and when it CHANGES:
//   • records it — players.current_title + title_updated_at + a title_history row,
//   • proclaims it in #server (one in-tone line, no @everyone),
//   • and queues an in-game voice line for Eilif to speak center-screen (the same
//     voice_lines queue the Companion plugin already polls).
//
// The API applies hysteresis against current_title, so a title only changes here
// once a challenger clears a real margin — no churn from 24-vs-23 kill noise.
//
// NO RATE LIMITING, by decision (Charlie, 2026-08-22): every title change is
// proclaimed the moment it is recorded — #server line AND in-game voice line,
// together. Title proclamations are exempt from the voice engine's ambient
// min-gap (VOICE_MIN_GAP_MS) and from the Great Deeds gap; hysteresis already
// makes a change rare enough that a gate would only ever lose one.
//
// SEED-SILENT: a viking whose current_title is still NULL (never recorded) is
// seeded WITHOUT announcing — so the very first pass after the migration doesn't
// dump a storm of "earned a new title" for the whole existing roster.
//
// Gated behind TITLES_ANNOUNCE (on by default; set 0 to disable). Degrades
// gracefully before db/2026-07-05_titles.sql is applied: it detects the missing
// column, logs once, and skips (no seed, no announcement).

const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || 'viking';

// Postgres "column does not exist" (registry not migrated yet).
function isMissingColumn(error) {
  if (!error) return false;
  const msg = `${error.message || ''} ${error.details || ''}`.toLowerCase();
  return error.code === '42703' || /current_title|title_updated_at|column .* does not exist/.test(msg);
}

export function createTitlesAnnouncer({
  db,
  post,
  writeDb,
  apiUrl,
  log = console,
  dryRun = false,
}) {
  let warnedMissing = false;
  let warnedNoWrite = false;

  async function fetchComputed() {
    const res = await fetch(apiUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${apiUrl} -> ${res.status}`);
    const body = await res.json();
    const players = Array.isArray(body?.players) ? body.players : [];
    // name -> title (last wins; names are unique on the roster)
    const map = new Map();
    for (const p of players) {
      const name = String(p?.name || '').trim();
      const title = String(p?.title || '').trim();
      if (name && title) map.set(name, title);
    }
    return map;
  }

  async function announce(row, title) {
    const name = (row.character_name || '').trim() || 'A viking';
    const line = `⚔️ **${name}** has earned a new title: **${title}**`;
    if (dryRun) {
      log.info?.(`[titles] (dry) would announce: ${name} -> "${title}"`);
      return;
    }
    // Proclaim in #server, then let Eilif speak it in-game. Neither failure
    // should block the registry write below (handled by the caller's try).
    try {
      await post('server', { content: line });
    } catch (e) {
      log.error?.(`[titles] #server post failed for ${name}: ${e.message}`);
    }
    try {
      const { error: vErr } = await writeDb.from('voice_lines').insert({
        text: `From tonight, ${firstName(name)} goes by ${title}.`,
        kind: 'event',
        meta: { title, player_id: row.id },
        status: 'queued',
        queued_at: new Date().toISOString(),
      });
      if (vErr) log.error?.(`[titles] voice enqueue failed for ${name}: ${vErr.message}`);
    } catch (e) {
      log.error?.(`[titles] voice enqueue failed for ${name}: ${e.message}`);
    }
  }

  async function tick() {
    if (!writeDb) {
      if (!warnedNoWrite) {
        log.warn?.('[titles] no service-role client — titles registry disabled');
        warnedNoWrite = true;
      }
      return { seeded: 0, announced: 0, unchanged: 0 };
    }

    let computed;
    try {
      computed = await fetchComputed();
    } catch (e) {
      log.warn?.(`[titles] titles API unreachable, skipping: ${e.message}`);
      return { seeded: 0, announced: 0, unchanged: 0 };
    }
    if (computed.size === 0) return { seeded: 0, announced: 0, unchanged: 0 };

    const { data, error } = await writeDb
      .from('players')
      .select('id, character_name, current_title');
    if (error) {
      if (isMissingColumn(error)) {
        if (!warnedMissing) {
          log.info?.('[titles] registry not migrated yet (players.current_title missing) — skipping until db/2026-07-05_titles.sql is applied');
          warnedMissing = true;
        }
        return { seeded: 0, announced: 0, unchanged: 0 };
      }
      log.error?.(`[titles] players read failed: ${error.message}`);
      return { seeded: 0, announced: 0, unchanged: 0 };
    }
    warnedMissing = false;

    let seeded = 0;
    let announced = 0;
    let unchanged = 0;

    // One proclamation per NAME per pass — duplicate players rows (the 2026-07-25
    // Testman incident: 325 dups → 325 announcements) must never multiply the
    // announcement, whatever upstream let them in.
    const handled = new Set();

    for (const row of data || []) {
      const name = (row.character_name || '').trim();
      if (!name) continue;
      if (handled.has(name)) continue;
      handled.add(name);
      const title = computed.get(name);
      if (!title) continue; // no computed title for this viking this pass
      const current = row.current_title;

      if (title === current) {
        unchanged++;
        continue;
      }

      const isSeed = current == null || current === '';
      const now = new Date().toISOString();

      if (dryRun) {
        if (isSeed) log.info?.(`[titles] (dry) would seed ${name} -> "${title}"`);
        else await announce(row, title);
        isSeed ? seeded++ : announced++;
        continue;
      }

      // Record first — the registry is the truth even if the proclamation fails.
      const { error: upErr } = await writeDb
        .from('players')
        .update({ current_title: title, title_updated_at: now })
        .eq('id', row.id);
      if (upErr) {
        log.error?.(`[titles] update failed for ${name}: ${upErr.message}`);
        continue;
      }

      if (isSeed) {
        // First time we've ever recorded a title for this viking — stay silent.
        seeded++;
        continue;
      }

      await writeDb.from('title_history').insert({
        player_id: row.id,
        title,
        awarded_at: now,
      });
      await announce(row, title);
      announced++;
      log.info?.(`[titles] ${name}: "${current}" -> "${title}"`);
    }

    if (seeded || announced) {
      log.info?.(`[titles] pass: seeded ${seeded}, announced ${announced}, unchanged ${unchanged}${dryRun ? ' (dry-run)' : ''}`);
    }
    return { seeded, announced, unchanged };
  }

  return { tick };
}
