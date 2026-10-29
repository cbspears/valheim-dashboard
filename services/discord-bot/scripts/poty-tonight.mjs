// READ-ONLY operator peek: what would the evening crown be if the recap ran
// right now? Reads the DB through the anon client and a COPY of state.json
// (buildStats never writes; saveState here is a no-op), posts nothing.
//   node scripts/poty-tonight.mjs            (from services/discord-bot)
//   node scripts/poty-tonight.mjs Rosir      also show that viking's standing
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { readClient } from '../src/supabase.js';
import { createRecap } from '../src/recap.js';

const who = process.argv[2] || null;
const state = JSON.parse(await readFile(new URL('../state.json', import.meta.url), 'utf8'));
const recap = createRecap({
  db: readClient(), post: async () => {}, state, saveState: async () => {},
  tz: process.env.TZ || 'America/Chicago',
});
const s = await recap.buildStats('evening');
console.log(`active tonight: ${s.playersActive}, deaths ${s.deaths}, bosses ${s.bossKills.length}, world day ${s.worldDay}`);
console.log('hours tonight:', s.onlineToday.map((p) => `${p.name} ${p.hours.toFixed(2)}h`).join(', '));
if (s.poty) {
  console.log(`crown now: ${s.poty.name} · ${s.poty.label} · ${s.poty.why}`);
  for (const a of s.poty.alternatives || []) console.log(`  runner-up: ${a.name} · ${a.key} · ${a.why}`);
} else console.log('crown now: nobody cleared a floor');
if (who) {
  const row = s.onlineToday.find((p) => p.name.toLowerCase() === who.toLowerCase());
  console.log(`${who}: ${row ? `${row.hours.toFixed(2)} h tonight` : 'NOT in tonight\'s sessions'}`);
  const d = (s._dayDeltaEntry?.byName || {})[row?.name || who];
  console.log(`${who} deltas tonight:`, d || '(none recorded)');
}
process.exit(0);
