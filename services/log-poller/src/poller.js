// Poller — incrementally tails the server log (over SFTP or a local file),
// runs each new line through LogParser, and forwards derived events to the
// dashboard webhook. Designed to run forever under systemd.

import SftpClient from 'ssh2-sftp-client';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { LogParser, isArrivalShout } from './parser.js';
import { createHeartbeatSender } from './heartbeat.js';
import {
  evaluateLiveness,
  normalizeLiveness,
  logAgeSec,
  formatWhen,
  formatDuration,
} from './liveness.js';

// Hard ceiling on one whole SFTP fetch (connect + stat + get + end). Only
// connect() has its own timeout (readyTimeout); stat/get/end are unbounded, and
// this host stalls often enough that map-snapshot logged 64 timeouts since
// 08-21. A tick that blows through this is counted as FAILED, which is what
// makes the heartbeat go degraded/error instead of reporting the previous
// tick's stale `ok` forever.
const SFTP_TICK_TIMEOUT_MS = 60000;

// SFTP auth failures are special: GTX bans repeated failed logins and the map
// snapshotter shares this one account, so retrying every 20 s after a password
// revert would get this PC banned within minutes (and the ban then presents as
// a false "server DOWN" alert 30 min later — see launch-22).
const AUTH_BACKOFF_MS = 10 * 60 * 1000; // 10m
const AUTH_FAIL_RE = /authentication/i; // ssh2: "All configured authentication methods failed"

// Event types a shout can produce TWICE in one batch: once from the companion
// plugin's marker line and once from the server's console echo of the same
// words. `pin` is not one of them — the echo path drops '/'-prefixed shouts and
// there is no console pin rule (see parser.js).
const TWIN_TYPES = new Set(['chat', 'oath']);

// One 429 retry on the dashboard webhook, capped. Same shape as discordFetch:
// honour the advertised delay once, then give up and let the tick fail.
const WEBHOOK_RETRY_CAP_MS = 10000;
const WEBHOOK_RETRY_DEFAULT_MS = 1000;

/**
 * How long to wait before the single webhook retry: the `retry-after` header
 * (seconds), else a `retry_after` field in the body (seconds, Discord's shape),
 * else one second — clamped to [0, 10 s]. Exported so the clamp is testable
 * without actually sleeping for it.
 */
export function webhookRetryDelayMs(headerValue, body) {
  let after = parseFloat(headerValue ?? '');
  if (!Number.isFinite(after)) {
    try {
      after = parseFloat(JSON.parse(body).retry_after);
    } catch {
      after = NaN;
    }
  }
  const ms = Number.isFinite(after) ? after * 1000 : WEBHOOK_RETRY_DEFAULT_MS;
  return Math.min(Math.max(ms, 0), WEBHOOK_RETRY_CAP_MS);
}

export class Poller {
  constructor(config, logger = console) {
    this.cfg = config; // { source, sftp, logPath, webhookUrl, webhookSecret, intervalMs, statePath, syncEveryMs }
    this.log = logger;
    this.offset = 0;
    this.partial = '';
    this.parser = new LogParser();
    this.lastSyncAt = 0;
    this.stopped = false;
    // Recently-mirrored chat, key -> posted-at ms. The same shout can surface
    // twice (plugin [EILIF_CHAT] line + console echo); this suppresses the twin.
    this.recentChat = new Map();
    // "<name>|<steamId>" pairs already alerted on for an identity mismatch, so
    // the warning fires once per impostor per process, not once per rejoin.
    this.identityAlerts = new Set();
    // Ops-cockpit bookkeeping: last tick outcome + last time a new log line
    // was actually seen (as opposed to just an empty poll).
    this.lastTickAt = 0;
    this.lastTickOk = null;
    this.lastTickError = null;
    this.lastNewLineAt = 0;
    // When the in-flight tick started (null between ticks) and when the last
    // SUCCESSFUL one finished. A wedged tick used to look healthy because
    // lastTickOk kept the previous `true`; the heartbeat now derives its status
    // from how long ago a tick last succeeded (services-4).
    this.tickStartedAt = null;
    this.lastTickOkAt = 0;
    this.startedAt = Date.now();
    // The in-flight tick promise, so stop() can wait for it instead of killing
    // a batch mid-dispatch (which would replay it from the old offset).
    this.current = null;
    // SFTP auth-failure backoff (services-7 / launch-22). Doubles as the
    // episode marker: still-in-the-future means "already logged and alerted",
    // so the distinct log line and the Discord alert fire once per episode
    // rather than once per tick.
    this.authBackoffUntil = 0;
    // Server-liveness state machine (see liveness.js). Persisted in state.json
    // so a poller restart never resets the staleness clock.
    this.liveness = normalizeLiveness(null);
  }

  async loadState() {
    try {
      const raw = await readFile(this.cfg.statePath, 'utf8');
      const s = JSON.parse(raw);
      this.offset = Number.isFinite(s.offset) ? s.offset : 0;
      this.parser = new LogParser({ online: s.online || [], connections: s.connections || [], pending: s.pending || [] });
      this.liveness = normalizeLiveness(s.liveness);
      this.log.info?.(
        `[state] resumed at offset ${this.offset}, ${this.parser.online.size} online` +
          (this.liveness.serverDown ? `, server marked DOWN since ${formatWhen(this.liveness.downSince)}` : '')
      );
    } catch {
      this.offset = 0;
      this.log.info?.('[state] no prior state; starting fresh');
    }
  }

  async saveState() {
    const s = { offset: this.offset, ...this.parser.snapshot(), liveness: this.liveness };
    await writeFile(this.cfg.statePath, JSON.stringify(s), 'utf8');
  }

  // --- Fetch new bytes [offset, size) from the configured source ---
  // Returns { text, size, mtimeMs }: the new bytes plus the observed file
  // metrics, which feed the liveness state machine (a log that stops growing
  // means the game server process is gone). Throws on transport failure — the
  // caller treats that as "unobserved", NOT as server-down.
  //
  // The fetchers deliberately do NOT advance `this.offset` — tick() owns the
  // cursor, so a fetch whose result is discarded (teardown failure, lost race
  // against the timeout) can never skip bytes nobody has processed.
  async fetchNewBytes() {
    if (this.cfg.source === 'file') return this.fetchFromFile();
    return this.fetchFromSftp();
  }

  async fetchFromFile() {
    const { size, mtimeMs } = await stat(this.cfg.logPath);
    if (size < this.offset) {
      this.log.warn?.(`[log] file shrank (${size} < ${this.offset}) — restart/rotation, re-reading from 0`);
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return { text: '', size, mtimeMs };
    const buf = await readFile(this.cfg.logPath);
    const slice = buf.subarray(this.offset, size);
    return { text: slice.toString('utf8'), size, mtimeMs };
  }

  // --- SFTP fetch, hardened the same way scripts/map-snapshot.mjs is --------
  // Two failure modes this guards against, both observed on this host:
  //
  // (1) A raw ssh2 'error' event that reaches no listener. ssh2-sftp-client's
  //     errorListener re-throws when the calling method didn't hand it a
  //     `reject` — that is a synchronous EventEmitter throw, NOT a rejected
  //     promise, so no try/catch around an `await` can ever see it. It killed
  //     the poller 6× in 30 days on v11 (connect() was the offender). v12.1.1
  //     fixes connect(), but several other methods still take the throwing
  //     branch, so the scoped uncaughtException trap stays as belt-and-braces:
  //     installed and removed around this ONE bounded unit of work, never
  //     globally (a global swallow-and-continue handler would mask real bugs
  //     and could leave the tick loop dead while the heartbeat still says ok).
  //
  // (2) A connection that neither errors nor completes — stat/get/end have no
  //     timeout of their own. The 60 s race turns that into a failed tick.
  async fetchFromSftp() {
    const now = Date.now();
    if (now < this.authBackoffUntil) {
      const leftSec = Math.round((this.authBackoffUntil - now) / 1000);
      throw new Error(`sftp auth backoff — not reconnecting for another ${leftSec}s`);
    }

    // Quiet callbacks: the library's defaults console.log every close/end event
    // (50 "Global close listener" lines in the journal) and console.error the
    // errors we already handle.
    const sftp = new SftpClient('poller', {
      error: (e) => this.log.warn?.(`[sftp] client error: ${e.message}`),
      end: () => {},
      close: () => {},
    });

    let onTrap;
    const trapped = new Promise((_, reject) => {
      onTrap = (err) => reject(err instanceof Error ? err : new Error(String(err)));
      process.on('uncaughtException', onTrap);
    });
    trapped.catch(() => {}); // never awaited on the happy path — prevent an unhandled rejection

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sftp tick timed out after ${SFTP_TICK_TIMEOUT_MS}ms`)),
        SFTP_TICK_TIMEOUT_MS
      );
    });

    try {
      return await Promise.race([this.fetchFromSftpInner(sftp), trapped, timeout]);
    } catch (err) {
      this.noteAuthFailure(err);
      throw err;
    } finally {
      clearTimeout(timer);
      process.removeListener('uncaughtException', onTrap);
      // Teardown failure is NOT fatal: by this point the bytes are already in
      // hand (or already lost to a real error), and a throwing end() used to
      // discard a whole fetched batch (3× '[tick] end: read ETIMEDOUT').
      await sftp.end().catch((e) => this.log.warn?.(`[sftp] end: ${e.message}`));
    }
  }

  async fetchFromSftpInner(sftp) {
    // retries:0 — v12 dropped the internal retry loop, but say it explicitly:
    // the 20 s tick loop (and the auth backoff above) owns all retrying.
    await sftp.connect({ ...this.cfg.sftp, retries: 0 });
    const { size, modifyTime } = await sftp.stat(this.cfg.logPath);
    const mtimeMs = Number.isFinite(modifyTime) ? modifyTime : null;
    if (size < this.offset) {
      this.log.warn?.(`[log] file shrank (${size} < ${this.offset}) — restart/rotation, re-reading from 0`);
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return { text: '', size, mtimeMs };

    // Read only the new bytes [offset, size). ssh2's read stream takes an
    // inclusive `end`, so end = size - 1. get() with no destination returns
    // the slice as a Buffer.
    const buf = await sftp.get(this.cfg.logPath, undefined, {
      readStreamOptions: { start: this.offset, end: size - 1 },
    });
    return { text: buf.toString('utf8'), size, mtimeMs };
  }

  // --- SFTP auth failure: back off hard instead of hammering the box -------
  // Seen 13× on the old box and 2× on the current one WITH the correct
  // password (transient server-side flakiness), and the runbook records two
  // silent password reverts to the panel default. Deliberately does NOT touch
  // the liveness clock: this is a transport/credentials failure, not evidence
  // about the game server, so it can never fake a "server DOWN" alert.
  noteAuthFailure(err) {
    if (!AUTH_FAIL_RE.test(err?.message || '')) return;
    const inEpisode = Date.now() < this.authBackoffUntil;
    this.authBackoffUntil = Date.now() + AUTH_BACKOFF_MS;
    if (inEpisode) return; // same episode — already logged and alerted once
    this.log.error?.('[sftp] AUTH FAILED - check the GTX panel default-credentials pane (retrying in 10m)');
    this.postAlert(
      '🔐 **Eilif log poller: SFTP AUTH FAILED** — check the GTX panel default-credentials pane ' +
        '(the server password may have reverted to the panel default). Retrying in 10 minutes; ' +
        'joins/deaths/chat and map frames are paused until it clears. This is NOT a server-down signal.'
    ).catch(() => {});
  }

  // --- POST one event to the dashboard webhook ---
  // ONE 429 retry, mirroring discordFetch. A refusal here is not like a 500:
  // the caller treats any non-2xx as a failed tick, tick() rewinds the byte
  // cursor and the WHOLE batch is re-read next time — so a single rate-limited
  // request costs the entire batch, and a batch bigger than the budget can
  // never drain. Pausing for the advertised delay and trying once more turns
  // that into a pause. `retry-after` is in seconds (header first, then a
  // `retry_after` body field), defaulting to 1 s and capped at 10 s: anything
  // longer is not something a tick should sit on.
  async webhookFetch(payload) {
    return fetch(this.cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': this.cfg.webhookSecret,
      },
      body: JSON.stringify(payload),
    });
  }

  async postEvent(payload) {
    let res = await this.webhookFetch(payload);
    if (res.status === 429) {
      const raw = await res.text().catch(() => '');
      const waitMs = webhookRetryDelayMs(res.headers?.get?.('retry-after'), raw);
      this.log.warn?.(`[webhook] 429 rate limited — one retry in ${Math.round(waitMs)}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      res = await this.webhookFetch(payload);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`webhook ${res.status}: ${text.slice(0, 120)}`);
    }
    return res.json().catch(() => ({}));
  }

  // --- One poll cycle: fetch, parse, dispatch ---
  // At-least-once delivery: the cursor only advances past a batch that was
  // fully dispatched. A webhook 500 or a network blip used to leave
  // this.offset past bytes nobody had seen — the next tick fetched from there
  // and those joins/deaths/oaths were gone for good. Now the cursor is
  // restored and the error rethrown, so saveState() is never reached with an
  // advanced offset and the batch is simply re-read (duplicates beat losses).
  async tick() {
    const prev = { offset: this.offset, partial: this.partial };
    const { text, size, mtimeMs } = await this.fetchNewBytes();
    try {
      await this.tickAfterFetch({ text, size, mtimeMs });
    } catch (err) {
      this.offset = prev.offset;
      this.partial = prev.partial;
      throw err;
    }
  }

  async tickAfterFetch({ text, size, mtimeMs }) {
    this.offset = size;

    // Liveness first: if the log just came back to life we want the recovery
    // alert out before the replayed join lines it brought with it.
    await this.updateLiveness({ size, mtimeMs });

    if (text) {
      this.lastNewLineAt = Date.now();
      const combined = this.partial + text;
      const lines = combined.split('\n');
      this.partial = lines.pop() ?? ''; // last (possibly partial) line held over

      // Collect the whole batch first so the twin dedupe can prefer the
      // plugin's raw-case [EILIF_CHAT]/[EILIF_OATH] line over the UPPERCASED
      // console echo of the same shout (the two lines land milliseconds apart,
      // i.e. same batch).
      //
      // OATHS ARE DEDUPED TOO, and that is the whole point of this block. The
      // webhook's oath handler is delete-then-insert, and the echo is always
      // the LATER line (our Harmony prefix runs before OnNewChatMessage's body,
      // which is what produces the echo) — so before this, every shouted oath
      // was written by the plugin and then immediately overwritten by the echo,
      // bellowed in uppercase and filed under the CLIENT-SUPPLIED display name.
      // Both of Companion 0.3.1's and 0.3.2's identity fixes reached the log
      // and nowhere else.
      const batch = [];
      for (const line of lines) {
        batch.push(...this.parser.processLine(line));
      }
      const pluginTwinKeys = new Set(
        batch
          .filter((e) => TWIN_TYPES.has(e.type) && e.metadata?.source === 'plugin')
          .map((e) => this.twinKey(e))
      );
      for (const ev of batch) {
        if (
          TWIN_TYPES.has(ev.type) &&
          ev.metadata?.source === 'echo' &&
          pluginTwinKeys.has(this.twinKey(ev))
        ) {
          continue; // twin of a plugin-captured shout in this same batch
        }
        await this.dispatch(ev);
      }
    }

    // Periodic roster reconciliation, even with no new lines, to self-heal.
    // While the server is known down this keeps re-asserting offline/0 players
    // rather than re-publishing a roster that can no longer be connected.
    const now = Date.now();
    if (now - this.lastSyncAt >= (this.cfg.syncEveryMs || 120000)) {
      this.lastSyncAt = now;
      const down = this.liveness.serverDown;
      await this.dispatch({
        type: 'sync',
        metadata: { online: down ? [] : this.parser.roster(), serverOnline: !down },
      }).catch((e) => this.log.warn?.(`[sync] ${e.message}`));
    }

    await this.saveState();
  }

  // --- Server liveness: has the remote log grown recently? ---------------
  // The log carries a "Connections N ZDOS:" heartbeat every ~10 minutes even
  // with zero players, so a static log past the threshold means the game
  // server process is down — while SFTP itself still answers (a failed
  // connect throws before we ever get here, and is deliberately NOT treated
  // as server-down: that is a network/host failure, handled as before).
  async updateLiveness(obs) {
    const { state, action } = evaluateLiveness(
      this.liveness,
      { now: Date.now(), ok: true, size: obs.size, mtimeMs: obs.mtimeMs },
      {
        staleLogThresholdMs: this.cfg.staleLogThresholdMs,
        downReAlertMs: this.cfg.downReAlertMs,
        downReAlertLongMs: this.cfg.downReAlertLongMs,
      }
    );
    this.liveness = state;
    if (!action) return;

    const since = formatWhen(action.downSince);
    const forStr = formatDuration(action.downForSec);

    if (action.kind === 'down') {
      this.log.error?.(`[liveness] server DOWN — log static for ${forStr} (since ${since})`);
      // The host is gone: nobody is connected, and none of the parser's
      // in-flight connection correlations survive a server restart. Reset so
      // the replayed (truncated) log rebuilds the roster from scratch.
      this.parser = new LogParser();
      await this.dispatch({ type: 'sync', metadata: { online: [], serverOnline: false } })
        .catch((e) => this.log.warn?.(`[liveness sync] ${e.message}`));
      this.lastSyncAt = Date.now();
      await this.postAlert(
        `⚠️ **Eilif server appears DOWN** — log silent since ${since} (${forStr} ago). ` +
          `SFTP still answers, so the game server process looks stopped, not the host.`
      );
      return;
    }

    if (action.kind === 'still-down') {
      this.log.warn?.(`[liveness] server STILL down — log static for ${forStr}`);
      await this.dispatch({ type: 'sync', metadata: { online: [], serverOnline: false } })
        .catch((e) => this.log.warn?.(`[liveness sync] ${e.message}`));
      this.lastSyncAt = Date.now();
      await this.postAlert(`⚠️ **Eilif server still DOWN** — log silent since ${since} (${forStr} ago).`);
      return;
    }

    // recovered
    this.log.info?.(`[liveness] server BACK UP — log growing again after ${forStr}`);
    await this.dispatch({ type: 'sync', metadata: { online: this.parser.roster(), serverOnline: true } })
      .catch((e) => this.log.warn?.(`[liveness sync] ${e.message}`));
    this.lastSyncAt = Date.now();
    await this.postAlert(`✅ **Eilif server is BACK UP** — the log is growing again after ${forStr} of silence.`);
  }

  /** Age of the newest log write, in seconds (null before the first poll). */
  logAgeSec(now = Date.now()) {
    return logAgeSec(this.liveness, now);
  }

  // --- Discord POST with one 429 retry ------------------------------------
  // #server's per-channel bucket is shared with the relay bot (same token), so
  // a 15-20 player join burst rate-limits us and every 429 used to be a
  // silently dropped message — worst case a dropped "⚠️ server DOWN" alert.
  // One retry after the advertised delay (header `retry-after`, else body
  // `retry_after`, both in seconds) is enough for a per-channel bucket;
  // anything longer than the 10 s cap is a global limit we shouldn't sit on.
  async discordFetch(url, init) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    const raw = await res.text().catch(() => '');
    let after = parseFloat(res.headers.get('retry-after') ?? '');
    if (!Number.isFinite(after)) {
      try {
        after = parseFloat(JSON.parse(raw).retry_after);
      } catch {
        after = NaN;
      }
    }
    const waitMs = Math.min(Math.max(Number.isFinite(after) ? after : 1, 0) * 1000, 10000);
    this.log.warn?.(`[discord] 429 rate limited — one retry in ${Math.round(waitMs)}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetch(url, init);
  }

  // --- Ops alert to Discord (bot token, same credentials as the chat mirror) ---
  // Best-effort: never throws, so an alert failure cannot break the tick loop.
  async postAlert(content) {
    try {
      if (this.cfg.discordToken && this.cfg.alertChannelId) {
        const res = await this.discordFetch(
          `https://discord.com/api/v10/channels/${this.cfg.alertChannelId}/messages`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bot ${this.cfg.discordToken}`,
            },
            body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
          }
        );
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          this.log.warn?.(`[alert] discord ${res.status}: ${detail.slice(0, 120)}`);
        }
        return;
      }
      if (this.cfg.alertWebhookUrl) {
        const res = await this.discordFetch(this.cfg.alertWebhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          this.log.warn?.(`[alert] discord webhook ${res.status}: ${detail.slice(0, 120)}`);
        }
        return;
      }
      this.log.warn?.(`[alert] no Discord target configured; alert not sent: ${content}`);
    } catch (e) {
      this.log.warn?.(`[alert] ${e.message}`);
    }
  }

  // Case-insensitive identity of one shout, keyed on the TEXT and the event
  // type ALONE — deliberately NOT the name.
  //
  // With Companion 0.3.2 the plugin's line carries the server-verified peer
  // name while the console echo carries the name the CLIENT claimed. For an
  // honest player they are identical and nothing changes. For a forged
  // ChatMessage RPC they differ — which is precisely when a name-inclusive key
  // stops matching, fails to recognise the echo as a twin, and lets the
  // impersonation through to #server and to the oath wall under the claimed
  // name. Keying on the text alone makes the plugin line always win.
  //
  // The cost is one collision case: two vikings shouting the identical words
  // inside the same batch (or the same 60 s cross-batch window) mirror once
  // instead of twice. A dropped duplicate line is a far smaller thing than a
  // mirrored impersonation.
  twinKey(ev) {
    return `${ev.type}|${String(ev.metadata?.text ?? '').toUpperCase()}`;
  }

  // --- Mirror one in-game shout to Discord (plain channel webhook) ---
  // Not routed through the dashboard webhook on purpose: chat is Discord-only
  // (the site is public), so it never touches the events table.
  async postChat(ev) {
    const key = this.twinKey(ev);
    const now = Date.now();
    // Cross-batch twin suppression (plugin line + console echo split across
    // two polls, or a re-read after a log rotation glitch).
    for (const [k, t] of this.recentChat) {
      if (now - t > 60000) this.recentChat.delete(k);
    }
    if (this.recentChat.has(key)) {
      this.log.info?.(`[chat] duplicate suppressed: ${key.slice(0, 60)}`);
      return;
    }
    this.recentChat.set(key, now);

    const name = ev.characterName;
    const text = ev.metadata.text.slice(0, 1900);

    // Past every dedup gate (same-batch plugin-preferred + cross-batch twin):
    // this is the single point where a shout is committed to the Discord
    // mirror, so mirror the exact same line to the dashboard webhook for the
    // /tv chat rail — never a superset. Best-effort and fire-and-forget: a
    // webhook failure must NEVER block the Discord post below.
    this.postEvent({ type: 'chat', characterName: name, message: ev.metadata.text })
      .catch((e) => this.log.warn?.(`[chat->webhook] ${e.message}`));

    if (this.cfg.chatWebhookUrl) {
      // Channel webhook: post AS the player (username override). Discord
      // rejects a few reserved/invalid usernames — fall back to bolded-name.
      const send = (body) =>
        this.discordFetch(this.cfg.chatWebhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }),
        });
      let res = await send({ username: name.slice(0, 80), content: text });
      if (res.status === 400) {
        res = await send({ content: `**${name}:** ${text}` });
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`chat webhook ${res.status}: ${detail.slice(0, 120)}`);
      }
      return;
    }

    // Bot-token path (the bot lacks MANAGE_WEBHOOKS as of 2026-07-05, so no
    // channel webhook exists yet): plain message in the configured channel.
    const res = await this.discordFetch(`https://discord.com/api/v10/channels/${this.cfg.chatChannelId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bot ${this.cfg.discordToken}`,
      },
      body: JSON.stringify({
        content: `🗨️ **${name}:** ${text}`,
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`chat post ${res.status}: ${detail.slice(0, 120)}`);
    }
  }

  // --- Send one parsed event onward -----------------------------------------
  // IDENTITY (audit security-3): Valheim allows duplicate character names and
  // never verifies them, so every name-keyed write downstream is impersonable.
  // The parser pairs each name with the SteamID that connected under it, and
  // dispatch forwards that pairing as `steamId` on join/leave/oath/pin. The
  // webhook binds it on first sight and refuses name-keyed writes that arrive
  // under a different account. When there is no pairing (a shout captured
  // before the join line, a restart mid-session) the field is simply absent and
  // the webhook allows the write — we never guess an identity.
  async dispatch(ev) {
    if (ev.type === 'chat') {
      const configured = this.cfg.chatWebhookUrl || (this.cfg.discordToken && this.cfg.chatChannelId);
      if (!configured) return; // mirroring not configured
      // Valheim shouts "I have arrived!" automatically on every spawn, so 76%
      // of the mirror was that one line — every join produced two #server
      // messages and burned the shared rate-limit bucket. Not player speech;
      // the join line already says it.
      if (isArrivalShout(ev.metadata.text)) return;
      this.log.info?.(`[event] chat ${ev.characterName} (${ev.metadata.source})`);
      await this.postChat(ev).catch((e) => this.log.warn?.(`[chat] ${e.message}`));
      return;
    }
    if (ev.type === 'heartbeat') {
      // Heartbeat → authoritative roster sync (no feed event).
      this.log.info?.(`[heartbeat] ${ev.count} online: [${ev.metadata.online.join(', ')}]`);
      await this.postEvent({ type: 'sync', metadata: ev.metadata });
      this.lastSyncAt = Date.now();
      return;
    }
    if (ev.type === 'oath') {
      // Oath payload carries `text` at the top level (not nested in metadata).
      // `steamId` rides along so the webhook can refuse an oath (and the /oath
      // CODE identity link) shouted by a different Steam account than the one
      // bound to that viking — see the identity guard note above dispatch().
      this.log.info?.(`[event] oath ${ev.characterName}`);
      const res = await this.postEvent({
        type: 'oath',
        characterName: ev.characterName,
        text: ev.metadata.text,
        steamId: ev.steamId,
      });
      if (res?.status === 'identity_mismatch') {
        this.log.warn?.(`[identity] oath from ${ev.characterName} refused — steam id does not match the binding`);
      }
      return;
    }
    if (ev.type === 'pin') {
      this.log.info?.(`[event] pin ${ev.characterName} -> ${ev.metadata.name} (${ev.metadata.kind})`);
      const res = await this.postEvent({
        type: 'pin',
        characterName: ev.characterName,
        metadata: ev.metadata,
        steamId: ev.steamId,
      });
      if (res?.status === 'identity_mismatch') {
        this.log.warn?.(`[identity] pin from ${ev.characterName} refused — steam id does not match the binding`);
      }
      return;
    }
    if (ev.type === 'pos') {
      // Live position → webhook only (never Discord). Best-effort: a webhook
      // failure must not spam the tick loop. Cadence is already ~60s/player
      // server-side, so we forward every parsed line as-is (raw world coords;
      // the /tv display does the world→fraction conversion).
      this.log.info?.(`[event] pos ${ev.characterName} (${ev.metadata.biome})`);
      await this.postEvent({
        type: 'pos',
        characterName: ev.characterName,
        x: ev.metadata.x,
        z: ev.metadata.z,
        biome: ev.metadata.biome,
      }).catch((e) => this.log.warn?.(`[pos] ${e.message}`));
      return;
    }
    const { type, characterName, metadata } = ev;
    // Death source of record: the server log only knows THAT a player died, not
    // how. Once GsValheimStatsClient is rolled out (its `deathEvents` carry the
    // real cause → /api/gs-ingest), set EMIT_DEATHS=false here so the two sources
    // don't double-count. Until then this stays the reliable death signal.
    if (type === 'death' && this.cfg.emitDeaths === false) {
      this.log.info?.(`[event] death ${characterName} suppressed (EMIT_DEATHS=false; gs-ingest owns deaths)`);
      return;
    }
    this.log.info?.(`[event] ${type}${characterName ? ` ${characterName}` : ''}${metadata?.event ? ` (${metadata.event})` : ''}`);
    const res = await this.postEvent({ type, characterName, metadata, steamId: ev.steamId });
    // The webhook binds players.steam_id on first sight and flags a join that
    // arrives under a different Steam account than the one already bound. It
    // still records the presence (someone really is in the world), but every
    // name-keyed write for that viking is frozen until an admin clears the
    // binding — so say so out loud, once.
    if (type === 'join' && res?.identityMismatch) {
      await this.alertIdentityMismatch(characterName, ev.steamId);
    }
  }

  // --- Identity mismatch alert (audit security-3) ---------------------------
  // Once per (character name, SteamID) pair for the life of this process: the
  // same impostor rejoining every five minutes must not turn #server into a
  // siren. Best-effort — postAlert never throws.
  async alertIdentityMismatch(name, steamId) {
    const key = `${name}|${steamId ?? '?'}`;
    if (this.identityAlerts.has(key)) return;
    this.identityAlerts.add(key);
    this.log.warn?.(`[identity] STEAM MISMATCH on join: ${name} (seen ${steamId ?? 'unknown'})`);
    await this.postAlert(
      `⚠️ Identity check: ${name} just joined under a different Steam account than the one bound ` +
        `to that viking. Oaths, pins and the Discord link for that name are frozen until an admin ` +
        `clears players.steam_id.`
    );
  }

  async start() {
    await this.loadState();
    this.log.info?.(
      `[poller] source=${this.cfg.source} interval=${this.cfg.intervalMs}ms target=${this.cfg.webhookUrl}`
    );
    const loop = async () => {
      if (this.stopped) return;
      this.tickStartedAt = Date.now();
      try {
        // Held so stop() can await the in-flight tick instead of killing a
        // batch mid-dispatch (which replays it from the old offset on restart).
        this.current = this.tick();
        await this.current;
        this.lastTickOk = true;
        this.lastTickError = null;
        this.lastTickOkAt = Date.now();
      } catch (err) {
        // A blown 60 s race lands here too, so a wedged fetch counts as a
        // FAILED tick rather than silently keeping the previous `ok`.
        this.log.error?.(`[tick] ${err.message}`);
        this.lastTickOk = false;
        this.lastTickError = err.message;
      } finally {
        this.current = null;
        this.tickStartedAt = null;
      }
      this.lastTickAt = Date.now();
      if (!this.stopped) this.timer = setTimeout(loop, this.cfg.intervalMs);
    };
    await loop();

    // Ops cockpit heartbeat: reports roster size + log freshness + the last
    // poll/SFTP outcome every ~60s. Best-effort — sendHeartbeat never throws
    // (see heartbeat.js), and skips entirely if OPS_HEARTBEAT_TOKEN unset.
    const sendHeartbeat = createHeartbeatSender('log-poller', this.log);
    const heartbeatTick = async () => {
      if (this.stopped) return;
      const now = Date.now();
      // A wedged tick used to report the PREVIOUS tick's `ok` forever while
      // nothing was being polled — green cockpit, dead pipeline. Status now
      // also degrades on the age of the last SUCCESSFUL tick.
      const intervalMs = this.cfg.intervalMs || 20000;
      const lastOkAgeMs = now - (this.lastTickOkAt || this.startedAt);
      const lastTickOkAgeSec = Math.round(lastOkAgeMs / 1000);
      const tickInFlightSec = this.tickStartedAt ? Math.round((now - this.tickStartedAt) / 1000) : null;
      let status = 'ok';
      if (this.lastTickOk === false || lastOkAgeMs > intervalMs * 10) status = 'error';
      else if (lastOkAgeMs > intervalMs * 3) status = 'degraded';
      const error =
        this.lastTickOk === false
          ? this.lastTickError
          : status === 'ok'
            ? undefined
            : `no successful tick for ${lastTickOkAgeSec}s`;
      await sendHeartbeat({
        status,
        error,
        metrics: {
          // How long the current tick has been running (null between ticks) and
          // how long since one last succeeded — the two numbers that tell a
          // wedged poller apart from an idle one.
          tickInFlightSec,
          lastTickOkAgeSec,
          onlineCount: this.parser.roster().length,
          // Game-server liveness, distinct from this poller's own liveness:
          // serverLive=false means the log has gone static past the threshold.
          serverLive: !this.liveness.serverDown,
          logAgeSec: this.logAgeSec(now),
          downSinceIso: this.liveness.downSince ? new Date(this.liveness.downSince).toISOString() : null,
          lastNewLineAgeSec: this.lastNewLineAt ? Math.round((now - this.lastNewLineAt) / 1000) : null,
          lastTickAgeSec: this.lastTickAt ? Math.round((now - this.lastTickAt) / 1000) : null,
          source: this.cfg.source,
          chatMirrorConfigured: Boolean(this.cfg.chatWebhookUrl || (this.cfg.discordToken && this.cfg.chatChannelId)),
          // `flags` is what the ops cockpit renders as labelled chips
          // (lib/ops/health.ts flagsFromMetrics), so surface liveness there too.
          flags: { serverLive: !this.liveness.serverDown },
        },
      });
    };
    await heartbeatTick();
    this.heartbeatTimer = setInterval(heartbeatTick, 60000);
  }

  // Stop the loops and wait (bounded) for the in-flight tick to finish. A
  // SIGTERM used to exit immediately, killing a tick mid-dispatch before its
  // saveState() — the whole batch was then re-read and re-posted on the next
  // start. Deliberately does NOT saveState() itself: while a tick is still
  // running, this.offset already points past the batch it hasn't finished
  // dispatching, so persisting it here would be exactly the loss tick() guards
  // against. A successful tick saves its own state.
  async stop(waitMs = 20000) {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (!this.current) return;
    let timer;
    await Promise.race([
      this.current.catch(() => {}),
      new Promise((r) => {
        timer = setTimeout(r, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }
}
