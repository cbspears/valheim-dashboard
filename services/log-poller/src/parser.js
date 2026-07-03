// LogParser — turns raw Valheim dedicated-server log lines (as written to
// BepInEx/LogOutput.log) into normalized dashboard events.
//
// Why a stateful parser? The reliable presence signals are spread across
// several lines and must be correlated:
//
//   "Got connection SteamID 7656..."          a client begins connecting
//   "Got character ZDOID from Bjorn : 12:3"   that client's character spawned
//   "Got character ZDOID from Bjorn : 0:0"    Bjorn DIED (zdoid reset to 0:0)
//   "Closing socket 7656..."                  that client disconnected
//   "Connections 2 ZDOS:..."                  periodic online-count heartbeat
//   "Random event set:army_theelder"          a raid/random event started
//
// A character-ZDOID line fires on every spawn AND every respawn, so we can't
// treat it as "join" directly — we emit `join` only the first time a connected
// SteamID resolves to a name, and `leave` when its socket closes. The roster we
// track is also exported for periodic `sync` reconciliation.

// Friendly text for Valheim's random/raid event keys (the in-game banner).
const RAID_MESSAGES = {
  army_eikthyr: 'Eikthyr rallies the creatures of the forest',
  army_theelder: 'The forest is moving…',
  army_gdking: 'The forest is moving…',
  army_bonemass: 'A foul smell from the swamp',
  army_moder: 'A cold wind blows from the mountains',
  army_goblin: 'The horde is attacking',
  army_goblinking: "Yagluth's horde is attacking",
  foresttrolls: 'The ground is shaking',
  blobs: 'A foul smell from the swamp',
  skeletons: 'Skeleton surprise',
  surtlings: 'The air is getting warmer',
  wolves: 'You are being hunted',
  bats: 'You stirred the cauldron',
  hildirboss1: 'A distant howl',
};

const RE = {
  connection: /Got connection SteamID (\d+)/,
  zdoid: /Got character ZDOID from (.+?) : (-?\d+):(-?\d+)/,
  closing: /Closing socket (\d+)/,
  connections: /Connections (\d+) ZDOS/,
  randomEvent: /Random event set:(\S+)/,
  serverConnected: /Game server connected/,
  // The Eilif companion plugin's /oath chat command. Marker can be embedded
  // anywhere in the standard BepInEx log prefix; name/text split on the FIRST
  // " | " so a text containing " | " itself stays intact.
  oath: /\[EILIF_OATH\]\s*(.+)$/,
};

export class LogParser {
  /**
   * @param {object} [initial] persisted state to resume from
   * @param {string[]} [initial.online] character names known online
   */
  constructor(initial = {}) {
    // SteamIDs that have connected but not yet resolved to a character name,
    // oldest first. Used to correlate the next ZDOID spawn to a connection.
    this.pendingConnections = [];
    // steamId -> characterName, and the reverse, for leave correlation.
    this.steamToName = new Map();
    this.nameToSteam = new Map();
    // Authoritative roster of who is currently online (by character name).
    this.online = new Set(Array.isArray(initial.online) ? initial.online : []);
    // Last value seen on a "Connections N" heartbeat (null until first seen).
    this.lastConnectionCount = null;
  }

  /** Names currently online, sorted for stable output. */
  roster() {
    return [...this.online].sort();
  }

  /**
   * Feed one log line. Returns an array of event objects (possibly empty):
   *   { type, characterName?, metadata, raid?, count? }
   * `type` is one of: join | leave | death | raid | heartbeat.
   */
  processLine(line) {
    const events = [];
    if (!line) return events;

    // --- In-game sworn oath (/oath) ---
    const o = line.match(RE.oath);
    if (o) {
      const rest = o[1];
      const sep = rest.indexOf(' | ');
      if (sep !== -1) {
        const name = rest.slice(0, sep).trim();
        const text = rest.slice(sep + ' | '.length).trim();
        if (name && text) {
          events.push({ type: 'oath', characterName: name, metadata: { text } });
        }
      }
      return events;
    }

    // --- Death or spawn (character ZDOID) ---
    const z = line.match(RE.zdoid);
    if (z) {
      const name = z[1].trim();
      const isDead = z[2] === '0' && z[3] === '0';
      if (isDead) {
        events.push({ type: 'death', characterName: name, metadata: { cause: 'has fallen' } });
      } else {
        // A spawn. Treat as a join only if this name isn't already online
        // (otherwise it's a respawn / world-change reload).
        if (!this.online.has(name)) {
          this.online.add(name);
          // Correlate to the oldest unresolved connection, if any.
          const steamId = this.pendingConnections.shift();
          if (steamId) {
            this.steamToName.set(steamId, name);
            this.nameToSteam.set(name, steamId);
          }
          events.push({ type: 'join', characterName: name, metadata: {} });
        }
      }
      return events;
    }

    // --- New connection (SteamID, name not yet known) ---
    const c = line.match(RE.connection);
    if (c) {
      this.pendingConnections.push(c[1]);
      // Guard against unbounded growth from failed/duplicate handshakes.
      if (this.pendingConnections.length > 32) this.pendingConnections.shift();
      return events;
    }

    // --- Socket closed (disconnect) ---
    const x = line.match(RE.closing);
    if (x) {
      const steamId = x[1];
      const name = this.steamToName.get(steamId);
      // Drop any matching pending (unresolved) connection too.
      this.pendingConnections = this.pendingConnections.filter((s) => s !== steamId);
      if (name) {
        this.steamToName.delete(steamId);
        this.nameToSteam.delete(name);
        if (this.online.delete(name)) {
          events.push({ type: 'leave', characterName: name, metadata: {} });
        }
      }
      return events;
    }

    // --- Online-count heartbeat ---
    const n = line.match(RE.connections);
    if (n) {
      const count = parseInt(n[1], 10);
      this.lastConnectionCount = count;
      // If the server reports zero, force the roster empty (self-heals any
      // join/leave we missed). Otherwise just emit a reconcile signal carrying
      // our current roster.
      if (count === 0 && this.online.size > 0) {
        this.online.clear();
        this.steamToName.clear();
        this.nameToSteam.clear();
        this.pendingConnections = [];
      }
      events.push({ type: 'heartbeat', count, metadata: { online: this.roster() } });
      return events;
    }

    // --- Random / raid event ---
    const r = line.match(RE.randomEvent);
    if (r) {
      const key = r[1];
      const message = RAID_MESSAGES[key] || `A random event has begun (${key})`;
      events.push({ type: 'raid', metadata: { event: message, key } });
      return events;
    }

    return events;
  }

  /** Serializable state to persist across restarts. */
  snapshot() {
    return { online: this.roster() };
  }
}

export { RAID_MESSAGES, RE };
