// Boss watcher: announces the FIRST time each boss is felled, to #valheim
// (with @everyone). Already-killed bosses are seeded as "announced" on first
// run so we never retro-spam.
import { formatBossKill } from './format.js';

export function createBossWatcher({ db, post, state, saveState, skald = null }) {
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
    const freshKills = [];
    let posted = 0;
    for (const b of bosses) {
      if (b.is_killed && !announced.has(b.id)) {
        await post('valheim', formatBossKill(b));
        announced.add(b.id);
        freshKills.push(b);
        posted++;
      }
    }
    state.announcedBosses = [...announced];
    if (posted) await saveState();

    // Skald retellings run AFTER announce + dedupe-persist, so a slow/failing
    // LLM call can never block or re-fire the @everyone announcement. The skald
    // swallows its own errors; this guard is belt-and-suspenders.
    if (skald && freshKills.length) {
      for (const b of freshKills) {
        try {
          await skald.generate(b);
        } catch (e) {
          console.error('[skald] generate failed:', e.message);
        }
      }
    }
    return posted;
  }

  return { init, tick };
}
