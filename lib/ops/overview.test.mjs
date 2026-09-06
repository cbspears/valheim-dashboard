// Unit tests for the overview's headline verdict.
// Run: npx tsx lib/ops/overview.test.mjs
//
// The verdict is the first thing on the page and the only thing somebody reads
// when they are in a hurry, so the interesting cases are the ones where it could
// be too reassuring: a roster full of unknowns, a single info finding, a
// degraded component with no findings at all.

import assert from 'node:assert';
import { summarizeOps, joinNames } from './overview.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

/** Minimal ComponentReport, enough for the fields summarizeOps reads. */
const comp = (key, state, label = key) => ({
  key,
  label,
  group: 'pipeline',
  state,
  ageSec: 0,
  cadenceSec: 60,
  staleAfterSec: 300,
  version: null,
  lastSuccess: null,
  lastError: null,
  flags: [],
  detail: '',
});

const finding = (id, severity) => ({
  id,
  severity,
  title: id,
  detail: 'detail',
  whatToDo: 'do the thing',
});

// ── clear ────────────────────────────────────────────────────────────────
{
  const v = summarizeOps({
    reports: [comp('a', 'healthy'), comp('b', 'healthy'), comp('c', 'healthy')],
    findings: [],
  });
  ok(v.level === 'clear', 'all healthy and nothing open → clear');
  ok(v.headline === 'All clear', 'clear headline');
  ok(v.detail.includes('3 of 3 components healthy right now'), 'detail counts components');
  // Sentence case: this part is joined onto the one before it with a period,
  // and it is the sentence shown on a good night, so it cannot start lowercase.
  ok(v.detail.includes('. No consistency checks open.'), 'detail says the checks are clean, as a sentence');
  ok(v.worstState === 'healthy', 'worst state is healthy');
  ok(v.openFindings === 0 && v.brokenKeys.length === 0, 'nothing broken, nothing open');
  ok(v.counts.healthy === 3 && v.counts.stale === 0, 'counts are per state');
  ok(v.total === 3, 'total counts every report');
}

// ── disabled is not a fault ──────────────────────────────────────────────
{
  const v = summarizeOps({
    reports: [comp('a', 'healthy'), comp('b', 'disabled')],
    findings: [],
  });
  ok(v.level === 'clear', 'a deliberately disabled loop does not spoil the verdict');
  ok(v.detail.includes('1 switched off on purpose'), 'but it is still said out loud');
}

// ── unknown never reads as clear ─────────────────────────────────────────
{
  const v = summarizeOps({
    reports: [comp('a', 'healthy'), comp('voice', 'unknown', 'In-game voice')],
    findings: [],
  });
  ok(v.level === 'watch', 'an unknown component blocks clear, the never-green-on-absence rule');
  ok(v.headline === 'Running, with things to note', 'watch headline');
  ok(v.detail.includes('1 unknown (In-game voice)'), 'the unknown component is named');
  ok(
    v.detail.includes('not the same as healthy'),
    'and the detail says so, because a reader in a hurry will read it as fine otherwise',
  );
  ok(v.unknownKeys.length === 1 && v.brokenKeys.length === 0, 'unknown is reported, never counted as broken');
}

// ── info-only findings ───────────────────────────────────────────────────
{
  const v = summarizeOps({
    reports: [comp('a', 'healthy')],
    findings: [finding('expired-claims', 'info'), finding('demo-data-present', 'info')],
  });
  ok(v.level === 'watch', 'info findings alone are a note, not an alarm');
  ok(v.detail.includes('2 checks open (2 info)'), 'findings counted by severity');
}

// ── a warning is attention, a critical is an incident ────────────────────
{
  const warn = summarizeOps({
    reports: [comp('a', 'healthy')],
    findings: [finding('roster-disagreement', 'warn'), finding('expired-claims', 'info')],
  });
  ok(warn.level === 'attention', 'a warning-level check reaches attention');
  ok(
    warn.headline === 'Something needs a look',
    'attention headline, deliberately not the words "Needs attention": that is the name of a section further down the same page, and two different things with one name is how a page stops being readable at speed',
  );
  ok(warn.detail.includes('2 checks open (1 warning, 1 info)'), 'both severities in the detail');

  const crit = summarizeOps({
    reports: [comp('a', 'healthy')],
    findings: [finding('future-dated-events', 'critical')],
  });
  ok(crit.level === 'incident', 'a critical check is an incident even with every component healthy');
  ok(
    crit.headline === 'Something is broken in the data',
    'and the headline says data, because no component is down',
  );
  ok(crit.detail.includes('1 check open (1 critical)'), 'singular check, not "1 checks"');
}

// ── a broken component is an incident with no findings at all ────────────
{
  const v = summarizeOps({
    reports: [comp('a', 'healthy'), comp('log-poller', 'stale', 'Log poller')],
    findings: [],
  });
  ok(v.level === 'incident', 'a stale component is an incident on its own');
  ok(v.headline === 'Something is not running', 'and the headline points at a process');
  ok(v.detail.includes('1 stale (Log poller)'), 'the stale component is named');
  ok(v.worstState === 'stale', 'worst state tracks the roster');

  const deg = summarizeOps({
    reports: [comp('bot', 'degraded', 'Discord bot')],
    findings: [],
  });
  ok(deg.level === 'incident', 'degraded is an incident too: alive and failing still fails');
  ok(deg.detail.includes('1 degraded (Discord bot)'), 'named as degraded, not as stale');
  // A degraded component reported INSIDE its window, so it just ran. Saying it
  // is "not running" sends the operator to look for a dead process that is up.
  ok(
    deg.headline === 'Something is running and failing',
    'degraded gets its own headline, because it is not the same fault as stale',
  );

  const both = summarizeOps({
    reports: [comp('bot', 'degraded', 'Discord bot'), comp('p', 'stale', 'Log poller')],
    findings: [],
  });
  ok(
    both.headline === 'Something is not running',
    'with both present the silent one wins the headline: it is the worse fault',
  );
}

// ── mixed: stale and degraded together, worst first ──────────────────────
{
  const v = summarizeOps({
    reports: [
      comp('m', 'degraded', 'Map snapshot'),
      comp('p', 'stale', 'Log poller'),
      comp('b', 'stale', 'Boards signs'),
      comp('h', 'healthy', 'Dashboard'),
    ],
    findings: [finding('x', 'critical')],
  });
  ok(v.level === 'incident', 'still one incident, not three');
  ok(
    v.brokenKeys[0] === 'Boards signs' && v.brokenKeys[1] === 'Log poller',
    'stale outranks degraded, then alphabetical inside a state',
  );
  ok(v.brokenKeys[2] === 'Map snapshot', 'the degraded one comes last');
  ok(v.detail.includes('2 stale, 1 degraded'), 'counted by state before being named');
}

// ── empty roster: never green on absence ─────────────────────────────────
// Zero reports is zero evidence, and this module's central rule is that an
// absence of evidence never reads as health. It used to return "All clear" here,
// which is the most reassuring possible sentence computed from nothing.
{
  const v = summarizeOps({ reports: [], findings: [] });
  ok(v.level === 'watch', 'no reports at all cannot be clear: nothing has been proven');
  ok(v.headline === 'Nothing is reporting', 'and the headline says so rather than inventing a fault');
  ok(
    v.detail.startsWith('No components in the roster at all'),
    'the detail names the absence instead of printing "0 of 0"',
  );
  ok(!v.detail.includes('0 of 0'), 'and does not dress zero evidence up as a ratio');
  ok(v.worstState === 'healthy', 'the fold seed is unchanged, so an empty roster invents no component fault');
  ok(v.brokenKeys.length === 0 && v.openFindings === 0, 'and nothing is fabricated into the lists');
}

// ── joinNames ────────────────────────────────────────────────────────────
{
  ok(joinNames([]) === '', 'empty list is an empty string');
  ok(joinNames(['a']) === 'a', 'one name');
  ok(joinNames(['a', 'b']) === 'a and b', 'two names');
  ok(joinNames(['a', 'b', 'c']) === 'a, b and c', 'three names');
  ok(joinNames(['a', 'b', 'c', 'd']) === 'a, b, c and 1 more', 'four names truncate');
  ok(joinNames(['a', 'b', 'c', 'd', 'e']) === 'a, b, c and 2 more', 'five names truncate');
  ok(joinNames(['a', 'b', 'c'], 2) === 'a, b and 1 more', 'the cap is configurable');
}

console.log(`overview.test: ${passed} assertions passed`);
