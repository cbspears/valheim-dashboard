// Poller — incrementally tails the server log (over FTP or a local file),
// runs each new line through LogParser, and forwards derived events to the
// dashboard webhook. Designed to run forever under systemd.

import { Client as FtpClient } from 'basic-ftp';
import { Writable } from 'node:stream';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { LogParser } from './parser.js';

export class Poller {
  constructor(config, logger = console) {
    this.cfg = config; // { source, ftp, logPath, webhookUrl, webhookSecret, intervalMs, statePath, syncEveryMs }
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
      this.parser = new LogParser({ online: s.online || [] });
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
    return this.fetchFromFtp();
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

  async fetchFromFtp() {
    const client = new FtpClient(this.cfg.ftp.timeoutMs || 15000);
    client.ftp.verbose = false;
    try {
      await client.access({
        host: this.cfg.ftp.host,
        port: this.cfg.ftp.port,
        user: this.cfg.ftp.user,
        password: this.cfg.ftp.password,
        secure: false,
      });
      const size = await client.size(this.cfg.logPath);
      if (size < this.offset) {
        this.log.warn?.(`[log] file shrank (${size} < ${this.offset}) — restart/rotation, re-reading from 0`);
        this.offset = 0;
        this.partial = '';
      }
      if (size === this.offset) return '';

      const chunks = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
      });
      // basic-ftp: download starting at a byte offset (issues FTP REST).
      await client.downloadTo(sink, this.cfg.logPath, this.offset);
      this.offset = size;
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      client.close();
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
    const { type, characterName, metadata } = ev;
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
