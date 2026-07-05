#!/usr/bin/env node
// Manually generate (or regenerate) a boss's Skald retelling.
//
//   node scripts/retell-boss.js eikthyr           # generate if none yet
//   node scripts/retell-boss.js eikthyr --force    # overwrite an existing one
//
// Runs the exact same generation the Discord bot uses (services/discord-bot/
// src/retelling.js): gather facts -> local ollama (qwen3.6:27b) -> sanitize ->
// template fallback -> write bosses.retelling via the service role. It prints
// the retelling to stdout regardless of whether the DB write succeeds, so it
// works even before db/2026-07-05_boss_retelling.sql has been applied (the
// write simply fails-soft and is reported as "persisted: false").
//
// Doubles as the regeneration tool if a retelling needs redoing.
const path = require('path');
const { pathToFileURL } = require('url');

const BOT_DIR = path.join(__dirname, '..', 'services', 'discord-bot');
const esm = (p) => import(pathToFileURL(p).href);

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const slugArg = args.find((a) => !a.startsWith('--'));
  if (!slugArg) {
    console.error('usage: node scripts/retell-boss.js <boss-slug> [--force]');
    process.exit(1);
  }

  const dotenv = await esm(path.join(BOT_DIR, 'node_modules', 'dotenv', 'lib', 'main.js')).catch(() =>
    import('dotenv')
  );
  (dotenv.default || dotenv).config({ path: path.join(BOT_DIR, '.env') });

  const { readClient, serviceClient } = await esm(path.join(BOT_DIR, 'src', 'supabase.js'));
  const { createSkald } = await esm(path.join(BOT_DIR, 'src', 'retelling.js'));

  const slugify = (s) =>
    String(s)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const target = slugify(slugArg);

  const db = readClient();
  const writeDb = process.env.SUPABASE_SERVICE_ROLE_KEY ? serviceClient() : null;
  if (!writeDb) console.warn('[retell-boss] no SUPABASE_SERVICE_ROLE_KEY — DB write will be skipped');

  const { data: bosses, error } = await db.from('bosses').select('*').order('sort_order');
  if (error) {
    console.error('[retell-boss] bosses query failed:', error.message);
    process.exit(1);
  }
  const boss = (bosses || []).find((b) => slugify(b.name) === target);
  if (!boss) {
    console.error(
      `[retell-boss] no boss matching "${slugArg}". Known:`,
      (bosses || []).map((b) => slugify(b.name)).join(', ')
    );
    process.exit(1);
  }

  console.log(`\n[retell-boss] ${boss.name} — killed=${boss.is_killed}, force=${force}\n`);
  const skald = createSkald({ db, writeDb });
  const result = await skald.generate(boss, { force });

  console.log(`\n────────── RETELLING (${result.source}) ──────────\n`);
  console.log(result.retelling);
  console.log('\n──────────────────────────────────────────────────\n');
  console.log(`persisted to DB: ${result.wrote}`);
  process.exit(0);
})().catch((e) => {
  console.error('[retell-boss] fatal:', e);
  process.exit(1);
});
