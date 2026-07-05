// Poller — incrementally tails the server log (over SFTP or a local file),
// runs each new line through LogParser, and forwards derived events to the
// dashboard webhook. Designed to run forever under systemd.

import SftpClient from 'ssh2-sftp-client';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { LogParser } from './parser.js';

export class Poller {
  constructor(config, logger = console) {
    this.cfg = config; // { source, sftp, logPath, webhookUrl, webhookSecret, intervalMs, statePath, syncEveryMs }
    this.log = logger;
    this.offset = 0;
    this.partial = '';
    this.parser = new LogParser();
    this.lastSyncAt = 0;
    this.stopped = false;
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
      const combined = this.partial + text;
      const lines = combined.split('\n');
      this.partial = lines.pop() ?? ''; // last (possibly partial) line held over

      for (const line of lines) {
        const events = this.parser.processLine(line);
        for (const ev of events) {
          await this.dispatch(ev);
        }
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

  async dispatch(ev) {
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
      } catch (err) {
        this.log.error?.(`[tick] ${err.message}`);
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.cfg.intervalMs);
    };
    await loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
