// Daily recaps: two cron jobs (08:00 and 22:00 America/Chicago) post an
// activity summary embed to #valheim. Stats cover the window since the last
// recap (default 12h).
import cron from 'node-cron';
import { formatRecap } from './format.js';

export function createRecap({ db, post, state, saveState, tz = 'America/Chicago', startsAt = null }) {
  async function buildStats(period) {
    const now = Date.now();
    const windowStart = new Date(
      state.lastRecapAt ? new Date(state.lastRecapAt).getTime() : now - 12 * 3600 * 1000
    );
    const startIso = windowStart.toISOString();

    // Sessions overlapping [windowStart, now]: still-open, or closed after start.
    const { data: sessions } = await db
      .from('sessions')
      .select('character_name, joined_at, left_at')
      .or(`left_at.is.null,left_at.gte.${startIso}`);

    const activeNames = new Set();
    let totalMs = 0;
    for (const s of sessions || []) {
      const start = Math.max(new Date(s.joined_at).getTime(), windowStart.getTime());
      const end = Math.min(s.left_at ? new Date(s.left_at).getTime() : now, now);
      if (end > start) {
        totalMs += end - start;
        if (s.character_name) activeNames.add(s.character_name);
      }
    }

    const { data: deathRows } = await db
      .from('events')
      .select('id')
      .eq('type', 'death')
      .gte('created_at', startIso);

    const { data: bossRows } = await db
      .from('bosses')
      .select('name, killed_at')
      .eq('is_killed', true)
      .gte('killed_at', startIso);

    const { data: status } = await db
      .from('server_status')
      .select('player_count, world_day')
      .eq('id', 1)
      .maybeSingle();

    const playersActive = activeNames.size;
    const deaths = (deathRows || []).length;
    const bossKills = (bossRows || []).map((b) => b.name);

    return {
      period,
      playersActive,
      hoursPlayed: totalMs / 3600000,
      deaths,
      bossKills,
      onlineNow: status?.player_count ?? 0,
      worldDay: status?.world_day ?? 0,
      quiet: playersActive === 0 && deaths === 0 && bossKills.length === 0,
    };
  }

  async function postRecap(period) {
    const stats = await buildStats(period);
    await post('valheim', formatRecap(stats));
    state.lastRecapAt = new Date().toISOString();
    await saveState();
    return stats;
  }

  function schedule() {
    const opts = { timezone: tz };
    // Gate: stay silent until the world launches (startsAt). Relay + boss
    // announcements are event-driven, so they're naturally quiet before then.
    const run = (period) => {
      if (startsAt && Date.now() < startsAt.getTime()) {
        console.log(`[recap] ${period} gated — recaps begin ${startsAt.toISOString().slice(0, 10)}`);
        return Promise.resolve();
      }
      return postRecap(period);
    };
    const jobs = [
      cron.schedule('0 8 * * *', () => run('morning').catch((e) => console.error('[recap] morning:', e.message)), opts),
      cron.schedule('0 22 * * *', () => run('evening').catch((e) => console.error('[recap] evening:', e.message)), opts),
    ];
    console.log(
      `[recap] scheduled 08:00 & 22:00 ${tz}` +
        (startsAt ? ` (begins ${startsAt.toISOString().slice(0, 10)})` : '')
    );
    return jobs;
  }

  return { buildStats, postRecap, schedule };
}
