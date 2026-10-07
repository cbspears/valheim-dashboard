// Night titles must not repeat the previous night's, and world_day stamped on
// events must reach the "Day N" phrasing (lib/episodes.ts, no network).
//
// 2026-10-07: the Story showed "The Siege" three nights running (the raid
// rung's single fallback string), and every night's world-day range was null
// because nothing wrote events.metadata.world_day.
//
// Run: npx tsx scripts/episodes-titles.test.mjs
import assert from 'node:assert';
import { buildEpisodes } from '../lib/episodes.ts';

/** n vikings playing 23:00Z–01:00Z on each given date (18:00 CT, same CT day). */
function sessionsFor(dates, n) {
  const out = [];
  for (const d of dates) {
    for (let i = 0; i < n; i++) {
      out.push({
        character_name: `Viking${i}`,
        joined_at: `${d}T23:00:00Z`,
        left_at: `${d}T23:59:00Z`,
        duration_minutes: 59,
      });
    }
  }
  return out;
}
const at = (d, hh = '23:30') => `${d}T${hh}:00Z`;
const DATES = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];

function noConsecutiveRepeats(eps, label) {
  for (let i = 1; i < eps.length; i++) {
    assert.notEqual(
      eps[i].title.trim().toLowerCase(),
      eps[i - 1].title.trim().toLowerCase(),
      `${label}: nights ${i} and ${i + 1} share "${eps[i].title}"`,
    );
  }
}

// ── quiet nights: identical inputs, consecutive dates ─────────────────────
{
  const eps = buildEpisodes(sessionsFor(DATES.slice(0, 2), 2), []);
  assert.equal(eps.length, 2);
  assert.notEqual(eps[0].title, eps[1].title, 'two identical quiet nights get different titles');
}

// ── the bug itself: generic raids on consecutive nights ───────────────────
{
  const events = DATES.map((d) => ({ type: 'raid', character_name: null, created_at: at(d), metadata: { detail: 'raid' } }));
  const eps = buildEpisodes(sessionsFor(DATES, 3), events);
  const RAID_POOL = ['The Siege', 'Raiders at the Walls', 'The Walls Held', 'A Night Under Siege', 'Shields to the Palisade'];
  for (const ep of eps) assert.ok(RAID_POOL.includes(ep.title), `generic raid title comes from the pool: ${ep.title}`);
  noConsecutiveRepeats(eps, 'generic raids');
}

// ── full halls with nothing else: the turnout pools rotate ────────────────
{
  noConsecutiveRepeats(buildEpisodes(sessionsFor(DATES, 9), []), 'turnout 9');
  noConsecutiveRepeats(buildEpisodes(sessionsFor(DATES, 6), []), 'turnout 6');
}

// ── a boss night keeps its boss title ─────────────────────────────────────
{
  const boss = (d) => ({ type: 'boss', character_name: 'Viking0', created_at: at(d), metadata: { boss: 'Eikthyr' } });
  const alone = buildEpisodes(sessionsFor(['2026-10-02'], 3), [boss('2026-10-02')])[0].title;
  assert.match(alone, /Eikthyr/);
  const twice = buildEpisodes(sessionsFor(DATES.slice(0, 2), 3), [boss(DATES[0]), boss(DATES[1])]);
  assert.match(twice[1].title, /Eikthyr/, 'a repeated boss night still names its boss');
  // And a boss night after an ordinary one is untouched by the rotation.
  const after = buildEpisodes(sessionsFor(['2026-10-01', '2026-10-02'], 3), [boss('2026-10-02')]);
  assert.equal(after[1].title, alone, 'the boss title is the same with or without a previous night');
}

// ── deterministic ─────────────────────────────────────────────────────────
{
  const events = DATES.map((d) => ({ type: 'raid', character_name: null, created_at: at(d), metadata: { detail: 'raid' } }));
  const a = buildEpisodes(sessionsFor(DATES, 3), events).map((e) => e.title);
  const b = buildEpisodes(sessionsFor(DATES, 3), [...events].reverse()).map((e) => e.title);
  assert.deepEqual(a, b, 'same nights → same titles, whatever the input order');
}

// ── world_day on events reaches the day range and the prose ───────────────
{
  const d = '2026-10-02';
  const events = [
    { type: 'join', character_name: 'Viking0', created_at: at(d, '23:00'), metadata: { world_day: 212 } },
    { type: 'leave', character_name: 'Viking0', created_at: at(d, '23:50'), metadata: { world_day: 212 } },
  ];
  const [ep] = buildEpisodes(sessionsFor([d], 2), events);
  assert.deepEqual(ep.worldDayRange, [212, 212]);
  assert.match(ep.description, /day 212/, `the night names its world day: ${ep.description}`);

  const span = [
    ...events,
    { type: 'death', character_name: 'Viking1', created_at: at(d, '23:55'), metadata: { cause: 'fall', world_day: 213 } },
  ];
  const [ep2] = buildEpisodes(sessionsFor([d], 2), span);
  assert.deepEqual(ep2.worldDayRange, [212, 213]);
  assert.match(ep2.description, /212 to (day )?213/, `a night spanning a rollover says so: ${ep2.description}`);

  const [none] = buildEpisodes(sessionsFor([d], 2), [{ type: 'join', character_name: 'Viking0', created_at: at(d), metadata: {} }]);
  assert.equal(none.worldDayRange, null, 'no stamp → no day, nothing invented');
}

console.log('episodes-titles: all passed');
