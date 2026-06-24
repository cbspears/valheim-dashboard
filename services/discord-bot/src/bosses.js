// Boss watcher: announces the FIRST time each boss is felled, to #valheim
// (with @everyone). Already-killed bosses are seeded as "announced" on first
// run so we never retro-spam.
import { formatBossKill } from './format.js';

export function createBossWatcher({ db, post, state, saveState }) {
  async function fetchBosses() {
    const { data, error } = await db.from('bosses').select('*').order('sort_order');
    if (error) throw new Error(`bosses query: ${error.message}`);
    return data || [];
  }

  // Seed the dedupe set with currently-killed bosses (no retro announcements).
  async function init() {
    if (Array.isArray(state.announcedBosses)) return;
    const bosses = await fetchBosses();
    state.announcedBosses = bosses.filter((b) => b.is_killed).map((b) => b.id);
    await saveState();
  }

  async function tick() {
    const bosses = await fetchBosses();
    const announced = new Set(state.announcedBosses || []);
    let posted = 0;
    for (const b of bosses) {
      if (b.is_killed && !announced.has(b.id)) {
        await post('valheim', formatBossKill(b));
        announced.add(b.id);
        posted++;
      }
    }
    state.announcedBosses = [...announced];
    if (posted) await saveState();
    return posted;
  }

  return { init, tick };
}
