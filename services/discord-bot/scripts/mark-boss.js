// Mark a boss as felled (boss kills aren't in the server log, so this is the
// manual trigger). Updates the bosses row AND inserts a `boss` event — the
// running bot then detects the kill and announces it to #valheim.
//
//   node scripts/mark-boss.js "Bonemass" "Bjorn Ironside,Astrid Shieldmaiden" "Took two tries"
import 'dotenv/config';
import { serviceClient } from '../src/supabase.js';

const [name, playersArg, notes] = process.argv.slice(2);

if (!name) {
  console.error('Usage: node scripts/mark-boss.js "<Boss Name>" "[Player1,Player2,...]" "[notes]"');
  console.error('Example: node scripts/mark-boss.js "Bonemass" "Bjorn Ironside,Astrid Shieldmaiden" "Took two tries"');
  process.exit(1);
}

const players = playersArg
  ? playersArg.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

const db = serviceClient();

const { data: matches, error: findErr } = await db.from('bosses').select('*').ilike('name', name);
if (findErr) {
  console.error('✗ lookup failed:', findErr.message);
  process.exit(1);
}
if (!matches || matches.length === 0) {
  console.error(`✗ no boss named "${name}". Known bosses: Eikthyr, The Elder, Bonemass, Moder, Yagluth, The Queen, Fader, The Bog Witch`);
  process.exit(1);
}

const boss = matches[0];
const nowIso = new Date().toISOString();

const { error: updErr } = await db
  .from('bosses')
  .update({
    is_killed: true,
    killed_at: nowIso,
    players_present: players,
    notes: notes || boss.notes || null,
  })
  .eq('id', boss.id);
if (updErr) {
  console.error('✗ update failed:', updErr.message);
  process.exit(1);
}

const { error: evErr } = await db.from('events').insert({
  type: 'boss',
  character_name: null,
  metadata: { boss: boss.name, players: `${players.length} viking${players.length === 1 ? '' : 's'}` },
  created_at: nowIso,
});
if (evErr) {
  console.error('⚠ boss marked, but event insert failed:', evErr.message);
  process.exit(1);
}

console.log(`✓ ${boss.name} (${boss.biome}) marked felled${players.length ? ` — war party: ${players.join(', ')}` : ''}`);
console.log('  The bot will announce it to #valheim within ~30s.');
process.exit(0);
