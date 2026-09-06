// Unit tests for lib/altar.ts — the arithmetic behind the boss altar pin that
// /api/gs-ingest drops at a kill. No database, no network.
//
// Covers: the projection (and that it is the SAME projection the in-game /pin
// branch uses), the freshness window, the centroid, and the whole pin.
//
// Run: npx tsx lib/altar.test.mjs   (npm test picks it up automatically)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  ALTAR_PIN_KIND,
  ALTAR_POSITION_FRESH_MS,
  WORLD_RADIUS,
  altarPinFor,
  altarPinName,
  centroidOf,
  freshPositions,
  worldToMap,
} from './altar.ts';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };
const close = (a, b, m, eps = 1e-9) => {
  assert.ok(Math.abs(a - b) < eps, `${m} (got ${a}, wanted ${b})`);
  passed++;
};

const NOW = Date.parse('2026-09-06T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// ── the projection ────────────────────────────────────────────────────────
{
  const centre = worldToMap(0, 0);
  close(centre.x, 0.5, 'the world origin is the middle of the image, across');
  close(centre.y, 0.5, 'and down');

  const northWest = worldToMap(-WORLD_RADIUS, WORLD_RADIUS);
  close(northWest.x, 0, 'the far west edge is the left of the image');
  close(northWest.y, 0, 'and the far north edge is the top');

  const southEast = worldToMap(WORLD_RADIUS, -WORLD_RADIUS);
  close(southEast.x, 1, 'the far east edge is the right');
  close(southEast.y, 1, 'and the far south edge is the bottom');

  // Clamped: the world is a circle inside a square, and a position past the
  // edge charts at the edge rather than off the picture.
  eq(worldToMap(999_999, 0).x, 1, 'a position past the east edge charts at the edge');
  eq(worldToMap(-999_999, 0).x, 0, 'and one past the west edge at the other');
  eq(worldToMap(0, 999_999).y, 0, 'north is clamped too');
  eq(worldToMap(0, -999_999).y, 1, 'and so is south');

  // ONE PROJECTION, TWO WRITERS. An altar and a shouted /pin have to land in the
  // same place on the same picture; two expressions that agree today and drift
  // next month would be invisible until someone noticed the altars were off.
  const webhook = readFileSync(new URL('../app/api/webhook/route.ts', import.meta.url), 'utf8');
  ok(
    webhook.includes('const WORLD_RADIUS = 10000;'),
    'the /pin branch uses the same world radius this module does',
  );
  ok(
    webhook.includes('(worldX + WORLD_RADIUS) / (2 * WORLD_RADIUS)') &&
      webhook.includes('(WORLD_RADIUS - worldZ) / (2 * WORLD_RADIUS)'),
    'and the identical expression for both axes',
  );
  eq(WORLD_RADIUS, 10000, "and this module's own constant is that number");

  // ONE NOTION OF "THE SAME PIN", TOO. The /pin branch REPLACES a pin by name
  // with a case-insensitive delete, so the ingest's own "is there already an
  // altar here" guard has to match the same way. A case-sensitive guard would
  // let "Bonemass altar" sit beside "bonemass altar" until the next /pin
  // removed both of them.
  ok(
    /\.delete\(\)[\s\S]{0,400}?\.ilike\('name'/.test(webhook),
    'the /pin branch replaces a pin by name, case-insensitively',
  );
  const route = readFileSync(new URL('../app/api/gs-ingest/route.ts', import.meta.url), 'utf8');
  const guard = route.slice(route.indexOf('async function recordBossAltar'));
  ok(
    /\.eq\('kind', ALTAR_PIN_KIND\)[\s\S]{0,120}?\.ilike\('name', name\)/.test(guard),
    'and the altar guard looks for one the same way, scoped to the boss kind',
  );
}

// ── the freshness window ──────────────────────────────────────────────────
{
  const rows = [
    { character_name: 'Bren', x: 10, z: 10, updated_at: ago(30_000) },
    { character_name: 'Astrid', x: 20, z: 20, updated_at: ago(ALTAR_POSITION_FRESH_MS + 60_000) },
    { character_name: 'Loa', x: 30, z: 30, updated_at: null },
    { character_name: 'Ivar', x: 'somewhere', z: 40, updated_at: ago(1000) },
  ];
  const fresh = freshPositions(rows, NOW);
  eq(fresh.length, 1, 'only a position inside the window, with real coordinates');
  eq(fresh[0].character_name, 'Bren', 'and it is the fresh one');

  // A stamp in the future is a producer clock problem, not a viking who has
  // already stood there. lib/event-time.ts exists because that has happened.
  eq(
    freshPositions([{ x: 1, z: 1, updated_at: new Date(NOW + 3600_000).toISOString() }], NOW).length,
    0,
    'a position stamped an hour from now is unusable',
  );
  eq(freshPositions(null, NOW).length, 0, 'and no rows at all is no positions');

  // THE WINDOW IS FIVE MINUTES, IN ABSOLUTE TERMS.
  //
  // Every check above is written relative to ALTAR_POSITION_FRESH_MS, so they
  // all keep passing if the constant is widened: the altar would then be
  // charted from where the war party stood most of an hour ago, which is a pin
  // in the wrong forest and a mistake nothing else in this repo would catch.
  // The number is also spoken out loud in the route's own log line, so pin both
  // and require them to agree.
  eq(ALTAR_POSITION_FRESH_MS, 5 * 60 * 1000, 'a position is evidence of a place for five minutes');
  eq(
    freshPositions([{ x: 1, z: 1, updated_at: ago(6 * 60 * 1000) }], NOW).length,
    0,
    'so a position six minutes old does not chart an altar',
  );
  eq(
    freshPositions([{ x: 1, z: 1, updated_at: ago(4 * 60 * 1000) }], NOW).length,
    1,
    'and one four minutes old still does',
  );
  const route = readFileSync(new URL('../app/api/gs-ingest/route.ts', import.meta.url), 'utf8');
  ok(
    /no war-party position inside the last five minutes/.test(route),
    'and the ingest still tells the log the same five minutes this constant means',
  );
}

// ── the centroid ──────────────────────────────────────────────────────────
{
  const middle = centroidOf([
    { x: 0, z: 0 },
    { x: 10, z: 0 },
    { x: 10, z: 10 },
    { x: 0, z: 10 },
  ]);
  close(middle.x, 5, 'four vikings on a square average to its middle, across');
  close(middle.z, 5, 'and down');

  const one = centroidOf([{ x: -300.5, z: 42.25 }]);
  close(one.x, -300.5, 'one viking is their own centroid');
  close(one.z, 42.25, 'on both axes');

  eq(centroidOf([]), null, 'nobody has no middle');
  eq(centroidOf([{ x: 'a', z: 'b' }]), null, 'and neither does an unreadable position');
  close(centroidOf([{ x: 1, z: 1 }, { x: 'a', z: 2 }]).x, 1, 'a bad row is dropped rather than poisoning the average');
}

// ── the whole pin ─────────────────────────────────────────────────────────
{
  eq(altarPinName('Bonemass'), 'Bonemass altar', 'an altar is named for its forsaken');
  eq(altarPinName(null), '', 'and a nameless boss makes no pin');
  eq(ALTAR_PIN_KIND, 'boss', "the pin's kind is the vocabulary lib/types.ts names");

  const pin = altarPinFor(
    'Bonemass',
    [
      { character_name: 'Bren', x: 0, z: 0, updated_at: ago(10_000) },
      { character_name: 'Astrid', x: 100, z: 100, updated_at: ago(20_000) },
      // Stale: standing somewhere else entirely, and must not drag the altar there.
      { character_name: 'Loa', x: 9000, z: -9000, updated_at: ago(ALTAR_POSITION_FRESH_MS * 3) },
    ],
    { nowMs: NOW },
  );
  eq(pin.name, 'Bonemass altar', 'the pin is named for the boss');
  close(pin.world_x, 50, 'at the middle of the vikings who were actually there');
  close(pin.world_z, 50, 'on both axes');
  close(pin.x, worldToMap(50, 50).x, 'and projected with the same arithmetic as a shouted pin');
  close(pin.y, worldToMap(50, 50).y, 'on both axes');

  eq(
    altarPinFor('Bonemass', [{ character_name: 'Bren', x: 0, z: 0, updated_at: ago(3600_000) }], { nowMs: NOW }),
    null,
    'a war party with nothing fresh leaves no altar, which is the ordinary case without the position plugin',
  );
  eq(altarPinFor('Bonemass', [], { nowMs: NOW }), null, 'and an empty war party leaves none either');
  eq(altarPinFor('', [{ x: 0, z: 0, updated_at: ago(1000) }], { nowMs: NOW }), null, 'a nameless boss leaves none');
}

console.log(`altar.test: ${passed} assertions passed`);
