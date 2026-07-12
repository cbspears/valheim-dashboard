// Poller — incrementally tails the server log (over SFTP or a local file),
// runs each new line through LogParser, and forwards derived events to the
// dashboard webhook. Designed to run forever under systemd.

import SftpClient from 'ssh2-sftp-client';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { LogParser } from './parser.js';
import { createHeartbeatSender } from './heartbeat.js';

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
    // Ops-cockpit bookkeeping: last tick outcome + last time a new log line
    // was actually seen (as opposed to just an empty poll).
    this.lastTickAt = 0;
    this.lastTickOk = null;
    this.lastTickError = null;
    this.lastNewLineAt = 0;
  }

  async loadState() {
    try {
      const raw = await readFile(this.cfg.statePath, 'utf8');
      const s = JSON.parse(raw);
      this.offset = Number.isFinite(s.offset) ? s.offset : 0;
      this.parser = new LogParser({ online: s.online || [], connections: s.connections || [], pending: s.pending || [] });
      this.log.info?.(`[state] resumed at offset ${this.offset}, ${this.parser.online.size} online`);
    } catch {
      this.offset = 0;
      this.log.info?.('[state] no prior state; starting fresh');
    }
  }

  async saveState() {
    const s = { offset: this.offset, ...this.parser.snapshot() };
    await writeFile(this.cfg.statePath, JSON.stringify(s), 'utf8');
  }

  // --- Fetch new bytes [offset, size) from the configured source ---
  async fetchNewBytes() {
    if (this.cfg.source === 'file') return this.fetchFromFile();
    return this.fetchFromSftp();
  }

  async fetchFromFile() {
    const { size } = await stat(this.cfg.logPath);
    if (size < this.offset) {
      this.log.warn?.(`[log] file shrank (${size} < ${this.offset}) — restart/rotation, re-reading from 0`);
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return '';
    const buf = await readFile(this.cfg.logPath);
    const slice = buf.subarray(this.offset, size);
    this.offset = size;
    return slice.toString('utf8');
  }

  async fetchFromSftp() {
    const sftp = new SftpClient();
    try {
      await sftp.connect(this.cfg.sftp);
      const { size } = await sftp.stat(this.cfg.logPath);
      if (size < this.offset) {
        this.log.warn?.(`[log] file shrank (${size} < ${this.offset}) — restart/rotation, re-reading from 0`);
        this.offset = 0;
        this.partial = '';
      }
      if (size === this.offset) return '';

      // Read only the new bytes [offset, size). ssh2's read stream takes an
      // inclusive `end`, so end = size - 1. get() with no destination returns
      // the slice as a Buffer.
      const buf = await sftp.get(this.cfg.logPath, undefined, {
        readStreamOptions: { start: this.offset, end: size - 1 },
      });
      this.offset = size;
      return buf.toString('utf8');
    } finally {
      await sftp.end();
    }
  }

  // --- POST one event to the dashboard webhook ---
  async postEvent(payload) {
    const res = await fetch(this.cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': this.cfg.webhookSecret,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`webhook ${res.status}: ${text.slice(0, 120)}`);
    }
    return res.json().catch(() => ({}));
  }

  // --- One poll cycle: fetch, parse, dispatch ---
  async tick() {
    const text = await this.fetchNewBytes();
    if (text) {
      this.lastNewLineAt = Date.now();
      const combined = this.partial + text;
      const lines = combined.split('\n');
      this.partial = lines.pop() ?? ''; // last (possibly partial) line held over

      // Collect the whole batch first so chat dedupe can prefer the plugin's
      // raw-case [EILIF_CHAT] line over the UPPERCASED console echo of the
      // same shout (the two lines land milliseconds apart, i.e. same batch).
      const batch = [];
      for (const line of lines) {
        batch.push(...this.parser.processLine(line));
      }
      const pluginChatKeys = new Set(
        batch
          .filter((e) => e.type === 'chat' && e.metadata.source === 'plugin')
          .map((e) => this.chatKey(e))
      );
      for (const ev of batch) {
        if (ev.type === 'chat' && ev.metadata.source === 'echo' && pluginChatKeys.has(this.chatKey(ev))) {
          continue; // twin of a plugin-captured shout in this same batch
        }
        await this.dispatch(ev);
      }
    }

    // Periodic roster reconciliation, even with no new lines, to self-heal.
    const now = Date.now();
    if (now - this.lastSyncAt >= (this.cfg.syncEveryMs || 120000)) {
      this.lastSyncAt = now;
      await this.dispatch({ type: 'sync', metadata: { online: this.parser.roster(), serverOnline: true } })
        .catch((e) => this.log.warn?.(`[sync] ${e.message}`));
    }

    await this.saveState();
  }

  // Case-insensitive identity of one shout (echo text arrives uppercased).
  chatKey(ev) {
    return `${ev.characterName}|${ev.metadata.text.toUpperCase()}`;
  }

  // --- Mirror one in-game shout to Discord (plain channel webhook) ---
  // Not routed through the dashboard webhook on purpose: chat is Discord-only
  // (the site is public), so it never touches the events table.
  async postChat(ev) {
    const key = this.chatKey(ev);
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
        fetch(this.cfg.chatWebhookUrl, {
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
    const res = await fetch(`https://discord.com/api/v10/channels/${this.cfg.chatChannelId}/messages`, {
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

  async dispatch(ev) {
    if (ev.type === 'chat') {
      const configured = this.cfg.chatWebhookUrl || (this.cfg.discordToken && this.cfg.chatChannelId);
      if (!configured) return; // mirroring not configured
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
      this.log.info?.(`[event] oath ${ev.characterName}`);
      await this.postEvent({ type: 'oath', characterName: ev.characterName, text: ev.metadata.text });
      return;
    }
    if (ev.type === 'pin') {
      this.log.info?.(`[event] pin ${ev.characterName} -> ${ev.metadata.name} (${ev.metadata.kind})`);
      await this.postEvent({ type: 'pin', characterName: ev.characterName, metadata: ev.metadata });
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
    await this.postEvent({ type, characterName, metadata });
  }

  async start() {
    await this.loadState();
    this.log.info?.(
      `[poller] source=${this.cfg.source} interval=${this.cfg.intervalMs}ms target=${this.cfg.webhookUrl}`
    );
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
        this.lastTickOk = true;
        this.lastTickError = null;
      } catch (err) {
        this.log.error?.(`[tick] ${err.message}`);
        this.lastTickOk = false;
        this.lastTickError = err.message;
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
      await sendHeartbeat({
        status: this.lastTickOk === false ? 'error' : 'ok',
        error: this.lastTickOk === false ? this.lastTickError : undefined,
        metrics: {
          onlineCount: this.parser.roster().length,
          lastNewLineAgeSec: this.lastNewLineAt ? Math.round((now - this.lastNewLineAt) / 1000) : null,
          lastTickAgeSec: this.lastTickAt ? Math.round((now - this.lastTickAt) / 1000) : null,
          source: this.cfg.source,
          chatMirrorConfigured: Boolean(this.cfg.chatWebhookUrl || (this.cfg.discordToken && this.cfg.chatChannelId)),
        },
      });
    };
    await heartbeatTick();
    this.heartbeatTimer = setInterval(heartbeatTick, 60000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }
}
