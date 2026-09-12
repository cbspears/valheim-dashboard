// THE 4.5 HOUR WEDGE (2026-09-12) and the two guards that now sit behind it.
//
// WHAT HAPPENED. 08:42:02 logged `[tick] getConnection: Timed out while waiting
// for handshake` and then the journal went silent for four and a half hours —
// no [event] lines, no further [tick] errors — while the process stayed up and
// the 10-minute heartbeat kept posting `no successful tick for 16154s`.
//
// WHY. fetchFromSftp's `finally` ran `await sftp.end()`. ssh2-sftp-client's
// end() resolves only when the client emits 'close', and ssh2's Client.end()
// writes its disconnect ONLY `if (this._sock && isWritable(this._sock))` — so
// against a socket this host had already black-holed, end() was a no-op that
// never emitted 'close' and never settled. An `await` in a `finally` delays the
// rethrow above it, so the tick's own error never propagated either: loop()
// never reached `setTimeout(loop, intervalMs)` and the poll loop simply stopped
// existing, while the heartbeat's independent setInterval kept the cockpit
// posting.
//
// Fully offline — no SFTP, no webhook, no real timers longer than ~200ms. Run:
//   node test-hang.js   (from services/log-poller)
import { Poller, endSftpQuietly, destroySftpClient } from './src/poller.js';

let failed = 0;
const check = (label, pass) => {
  console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed++;
};
const quiet = () => ({ info: () => {}, warn: () => {}, error: () => {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

/** A client whose end() never settles — the 2026-09-12 shape. */
function wedgedClient() {
  const rec = { destroyed: false, sockDestroyed: false, endCalls: 0 };
  return {
    rec,
    sftp: {}, // truthy: end() takes the "wait for 'close'" branch
    client: {
      destroy() {
        rec.destroyed = true;
      },
      _sock: {
        destroy() {
          rec.sockDestroyed = true;
        },
      },
    },
    end() {
      rec.endCalls++;
      return never();
    },
  };
}

// ── 1. endSftpQuietly bounds a teardown that never settles ──────────────────
{
  const sftp = wedgedClient();
  const t0 = Date.now();
  const outcome = await endSftpQuietly(sftp, 60, quiet());
  const tookMs = Date.now() - t0;
  check('a never-settling end() returns "timeout" instead of hanging', outcome === 'timeout');
  check('and returns promptly', tookMs < 1000);
  check('the ssh2 client was destroyed', sftp.rec.destroyed);
  check('and its socket with it', sftp.rec.sockDestroyed);
}

// ── 2. …and still resolves when end() merely THROWS ─────────────────────────
// Teardown failure was never fatal (the bytes are already in hand); that must
// not have regressed into a rejection the tick would have to catch.
{
  const outcome = await endSftpQuietly(
    {
      end: async () => {
        throw new Error('read ETIMEDOUT');
      },
    },
    1000,
    quiet(),
  );
  check('a THROWING end() resolves "ended" and never rejects', outcome === 'ended');
}
{
  let ended = false;
  const outcome = await endSftpQuietly({ end: async () => { ended = true; } }, 1000, quiet());
  check('a healthy end() resolves "ended" without destroying anything', outcome === 'ended' && ended);
}
{
  // destroySftpClient is the last resort and must never throw, whatever it is
  // handed — it runs when everything else has already failed.
  let threw = false;
  try {
    destroySftpClient({}, quiet());
    destroySftpClient({ client: { destroy() { throw new Error('nope'); } } }, quiet());
  } catch {
    threw = true;
  }
  check('destroySftpClient never throws, even on a junk client', !threw);
}

// ── 3. THE REGRESSION. A fetch whose teardown hangs must still reject ───────
{
  const p = new Poller(
    { source: 'sftp', sftp: {}, statePath: '/dev/null', sftpEndTimeoutMs: 60 },
    quiet(),
  );
  const sftp = wedgedClient();
  p.newSftpClient = () => sftp;
  p.fetchFromSftpInner = async () => {
    throw new Error('getConnection: Timed out while waiting for handshake');
  };

  let settled = null;
  const t0 = Date.now();
  await Promise.race([
    p.fetchFromSftp().then(
      () => (settled = 'resolved'),
      (e) => (settled = e.message),
    ),
    sleep(3000).then(() => (settled = settled ?? 'WEDGED')),
  ]);
  const tookMs = Date.now() - t0;

  // Before the fix this assertion was the whole bug: `settled` stayed null,
  // the tick never completed, and the loop never rescheduled itself.
  check('a handshake failure propagates even when end() never settles', settled !== 'WEDGED' && settled !== null);
  check('and it is the ORIGINAL error, not the teardown', /handshake/.test(String(settled)));
  check('inside the teardown budget, not the 3s wedge detector', tookMs < 3000);
  check('the abandoned client was destroyed on the way out', sftp.rec.destroyed);
}

// ── 4. The hard fetch timeout fires when the fetch itself hangs ─────────────
{
  const p = new Poller(
    { source: 'sftp', sftp: {}, statePath: '/dev/null', sftpEndTimeoutMs: 60 },
    quiet(),
  );
  p.newSftpClient = () => wedgedClient();
  p.fetchTimeoutMs = () => 60; // stands in for the real ~60s deadline
  p.fetchFromSftpInner = () => never(); // connect/stat/get that answers nothing

  let msg = null;
  await Promise.race([
    p.fetchFromSftp().then(
      () => (msg = 'resolved'),
      (e) => (msg = e.message),
    ),
    sleep(3000).then(() => (msg = msg ?? 'WEDGED')),
  ]);
  check('a hung fetch rejects on the hard deadline', /sftp tick timed out after 60ms/.test(String(msg)));
}

// ── 5. The deadline is derived from SFTP_TIMEOUT_MS (sftp.readyTimeout) ─────
{
  const at = (readyTimeout) =>
    new Poller({ source: 'sftp', sftp: { readyTimeout }, statePath: '/dev/null' }, quiet()).fetchTimeoutMs();
  check('default handshake budget (15s) keeps the 60s floor', at(15000) === 60000);
  check('a raised handshake budget widens it to 2x', at(45000) === 90000);
  check('junk falls back to the floor', at(undefined) === 60000 && at(NaN) === 60000);
}

// ── 6. A failing tick does NOT wedge the loop — the next one still runs ─────
{
  const calls = [];
  const p = new Poller(
    { source: 'sftp', sftp: {}, statePath: '/dev/null', intervalMs: 10, syncEveryMs: 24 * 3600 * 1000 },
    quiet(),
  );
  p.fetchNewBytes = async () => {
    calls.push(Date.now());
    if (calls.length === 1) throw new Error('getConnection: Timed out while waiting for handshake');
    return { text: '', size: 0, mtimeMs: Date.now() };
  };
  p.updateLiveness = async () => {};
  p.saveState = async () => {};
  p.lastSyncAt = Date.now();

  await p.start(); // returns once the FIRST tick has completed
  check('the first (failing) tick is recorded as failed', p.lastTickOk === false);
  await sleep(120); // long enough for several 10ms ticks
  await p.stop();

  check(`the loop kept ticking after the failure (${calls.length} fetches)`, calls.length >= 3);
  check('and a later tick succeeded', p.lastTickOk === true && p.lastTickOkAt > 0);
}

// ── 7. The tick watchdog ────────────────────────────────────────────────────
{
  const p = new Poller({ statePath: '/dev/null', intervalMs: 20000 }, quiet());
  check('deadline floors at 5 min for the live 20s interval', p.tickWatchdogDeadlineMs() === 300000);
  check(
    'and follows 6x the interval when that is longer',
    new Poller({ statePath: '/dev/null', intervalMs: 60000 }, quiet()).tickWatchdogDeadlineMs() === 360000,
  );
  check(
    'junk intervals still get the 5 min floor',
    new Poller({ statePath: '/dev/null' }, quiet()).tickWatchdogDeadlineMs() === 300000,
  );
}
{
  // Injected clock + injected exit: the watchdog's real move is process.exit(1),
  // which is not something a test may actually take.
  const lines = [];
  const exits = [];
  let clock = 1_000_000;
  const p = new Poller(
    { statePath: '/dev/null', intervalMs: 20000 },
    { info: () => {}, warn: () => {}, error: (m) => lines.push(m) },
  );
  p.startedAt = clock;
  p.lastTickAt = clock;

  const wd = p.startTickWatchdog({
    checkEveryMs: 3600_000, // the real interval must not fire during the test
    exit: (code) => exits.push(code),
    now: () => clock,
  });
  check('watchdog deadline is 300000ms', wd.deadlineMs === 300000);

  clock += 299_000;
  check('does not trip one second short of the deadline', wd.check() === false && exits.length === 0);

  clock += 2_000; // 301s since the last completed tick
  const tripped = wd.check();
  check('trips once the deadline passes', tripped === true);
  check('and exits(1) so systemd restarts the poller', exits.join(',') === '1');
  check('the log line is loud and greppable', /\[watchdog\] TICK LOOP WEDGED/.test(lines[0] ?? ''));
  check('and says how long it has been', /no tick has completed for 301s/.test(lines[0] ?? ''));
  check('deadline named in the same line', /deadline 300s/.test(lines[0] ?? ''));

  // Disarmed after tripping: a real process is on its way out, and a second
  // exit() would only confuse the journal.
  clock += 600_000;
  check('does not fire twice', wd.check() === false && exits.length === 1);

  // A completed tick moves the clock forward, so a slow-but-alive poller is
  // never killed.
  const p2 = new Poller({ statePath: '/dev/null', intervalMs: 20000 }, quiet());
  let clock2 = 2_000_000;
  p2.startedAt = clock2;
  const wd2 = p2.startTickWatchdog({ checkEveryMs: 3600_000, exit: () => {}, now: () => clock2 });
  clock2 += 400_000;
  p2.lastTickAt = clock2 - 10_000; // a tick finished 10s ago
  check('a recently completed tick keeps it quiet', wd2.check() === false);
  // A stopped poller is shutting down, not wedged.
  p2.stopped = true;
  clock2 += 999_999;
  check('a stopping poller is never killed by the watchdog', wd2.check() === false);
  wd2.stop();
}

console.log(failed === 0 ? '\nOK — the tick loop cannot be wedged by a hung SFTP teardown' : `\nFAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
