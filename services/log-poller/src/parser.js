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
  // Shouted /oath as echoed by the server console — the mod-free capture path.
  // Shout text arrives display-uppercased; the oath keyword is matched case-
  // insensitively and the sworn text is kept exactly as shouted.
  //   Console: <color=orange>Testman</color>: <color=#FFEB04FF>/OATH I SWEAR ...</color>
  consoleOath: /Console:\s*<color=orange>(.+?)<\/color>:\s*<color=[^>]*>\/oath\s+(.+?)<\/color>/i,
  // The Eilif companion plugin's /pin capture (Harmony patch on
  // Chat.OnNewChatMessage — unlike /oath this NEEDS the plugin, since a
  // world position isn't available from the console echo alone).
  //   [EILIF_PIN] Testman | poi | The Dark Chapel | 123.4 | -567.8
  pin: /\[EILIF_PIN\]\s*(.+?)\s*\|\s*(base|poi)\s*\|\s*(.+?)\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)\s*$/,
  // The Eilif companion plugin's shout-chat capture (raw casing, name/text
  // split on the FIRST " | " like [EILIF_OATH]):
  //   [EILIF_CHAT] Testman | hello there
  chat: /\[EILIF_CHAT\]\s*(.+)$/,
  // The Eilif companion plugin's live position + biome (emitted ~60s per online
  // player). Explicit "|"-separated fields like [EILIF_PIN]; x/z are world
  // coords ("-184.9" style) and biome is a plain enum word (Meadows, BlackForest,
  // …, or None) — matched leniently as a run of non-space chars.
  //   [EILIF_POS] Bjorn | -184.9 | -2.1 | BlackForest
  pos: /\[EILIF_POS\]\s*(.+?)\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)\s*\|\s*(\S+)\s*$/,
  // Any shouted chat as echoed by the server console — the mod-free capture
  // path (text arrives display-UPPERCASED). Command shouts (/oath, /pin, …)
  // are filtered out in processLine, and the consoleOath check runs first.
  //   Console: <color=orange>Testman</color>: <color=#FFEB04FF>HELLO THERE</color>
  consoleShout: /Console:\s*<color=orange>(.+?)<\/color>:\s*<color=[^>]*>(.+?)<\/color>/,
};

export class LogParser {
  /**
   * @param {object} [initial] persisted state to resume from
   * @param {string[]} [initial.online] character names known online
   * @param {[string, string][]} [initial.connections] persisted steamId->characterName pairs
   * @param {string[]} [initial.pending] persisted unresolved-connection steamIds, oldest first
   */
  constructor(initial = {}) {
    // SteamIDs that have connected but not yet resolved to a character name,
    // oldest first. Used to correlate the next ZDOID spawn to a connection.
    // Persisted across restarts (see snapshot()) — without this, a restart
    // mid-session forgets the correlation for players who were already
    // online, which corrupts FIFO matching for every connection after them
    // (this caused a real incident: see the relog handling below).
    this.pendingConnections = Array.isArray(initial.pending) ? [...initial.pending] : [];
    // steamId -> characterName, and the reverse, for leave correlation.
    // Also persisted across restarts.
    this.steamToName = new Map(Array.isArray(initial.connections) ? initial.connections : []);
    this.nameToSteam = new Map();
    for (const [steamId, name] of this.steamToName) this.nameToSteam.set(name, steamId);
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

    // --- In-game sworn oath (shouted, via the server's console echo) ---
    const co = line.match(RE.consoleOath);
    if (co) {
      const name = co[1].trim();
      const text = co[2].trim();
      if (name && text) {
        events.push({ type: 'oath', characterName: name, metadata: { text } });
      }
      return events;
    }

    // --- Any other shouted chat (console echo, mod-free but UPPERCASED) ---
    const cs = line.match(RE.consoleShout);
    if (cs) {
      const name = cs[1].trim();
      const text = cs[2].trim();
      // '/'-prefixed shouts are commands (/oath handled above, /pin via the
      // plugin, anything else is noise) — never mirror them as chat.
      if (name && text && !text.startsWith('/')) {
        events.push({ type: 'chat', characterName: name, metadata: { text, source: 'echo' } });
      }
      return events;
    }

    // --- Shout chat (raw casing, via the Eilif companion plugin) ---
    const ch = line.match(RE.chat);
    if (ch) {
      const rest = ch[1];
      const sep = rest.indexOf(' | ');
      if (sep !== -1) {
        const name = rest.slice(0, sep).trim();
        const text = rest.slice(sep + ' | '.length).trim();
        if (name && text && !text.startsWith('/')) {
          events.push({ type: 'chat', characterName: name, metadata: { text, source: 'plugin' } });
        }
      }
      return events;
    }

    // --- In-game pin (/pin, via the Eilif companion plugin) ---
    const p = line.match(RE.pin);
    if (p) {
      const [, name, kind, place, worldX, worldZ] = p;
      if (name && place) {
        events.push({
          type: 'pin',
          characterName: name.trim(),
          metadata: { kind, name: place.trim(), worldX: parseFloat(worldX), worldZ: parseFloat(worldZ) },
        });
      }
      return events;
    }

    // --- Live position + biome (via the Eilif companion plugin, ~60s) ---
    const pos = line.match(RE.pos);
    if (pos) {
      const [, name, worldX, worldZ, biome] = pos;
      if (name) {
        events.push({
          type: 'pos',
          characterName: name.trim(),
          metadata: { x: parseFloat(worldX), z: parseFloat(worldZ), biome: biome.trim() },
        });
      }
      return events;
    }

    // --- Death or spawn (character ZDOID) ---
    const z = line.match(RE.zdoid);
    if (z) {
      const name = z[1].trim();
      const isDead = z[2] === '0' && z[3] === '0';
      if (isDead) {
        // Valheim's dedicated-server log records THAT a character died (the
        // ZDOID reset to 0:0) but never HOW — the vanilla log carries no
        // killer/cause. So we do NOT fabricate one; downstream renderers show an
        // honest fallback (feed: "<name> has fallen"; death-roll: "Lost to the
        // wilds"). To surface a REAL cause we'd need a server plugin to emit it
        // to the log for us to parse, exactly like the /oath path above.
        events.push({ type: 'death', characterName: name, metadata: {} });
      } else {
        // A spawn. Three cases:
        //   1. Not yet online -> genuine new join.
        //   2. Already online AND already correlated to a connection ->
        //      plain respawn / world-change reload. Nothing to do.
        //   3. Already online but with NO known connection (e.g. this
        //      process restarted mid-session and inherited `online` from
        //      state.json before connections/pending were persisted, or a
        //      connect line for this player was otherwise missed) -> this
        //      ZDOID line is actually a live (re)connect we lost track of.
        //      We MUST still correlate it, otherwise the stale entry sits
        //      at the front of pendingConnections and gets FIFO-stolen by
        //      the next unrelated player's join, corrupting correlation
        //      for everyone after.
        const alreadyOnline = this.online.has(name);
        const alreadyMapped = this.nameToSteam.has(name);
        if (!alreadyOnline || !alreadyMapped) {
          // Correlate to the oldest unresolved connection, if any.
          const steamId = this.pendingConnections.shift();
          if (steamId) {
            const prevName = this.steamToName.get(steamId);
            if (prevName && prevName !== name && this.online.has(prevName)) {
              // Same Steam connection, different character: the player
              // relogged to a new character. Valheim's log has no explicit
              // "character left" event for an in-session character switch
              // (only a fresh ZDOID line for the new one), so we synthesize
              // the missing leave for the old character here — otherwise it
              // stays phantom-online forever (real incident: Testman ->
              // Testmantwo, 2026-07-04).
              this.online.delete(prevName);
              this.nameToSteam.delete(prevName);
              events.push({ type: 'leave', characterName: prevName, metadata: {} });
            }
            this.steamToName.set(steamId, name);
            this.nameToSteam.set(name, steamId);
          }
        }
        if (!alreadyOnline) {
          this.online.add(name);
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
    return {
      online: this.roster(),
      // steamId->characterName correlation + unresolved-connection queue,
      // so a restart mid-session doesn't forget who's connected to what
      // (see the constructor/relog comments for why this matters).
      connections: [...this.steamToName.entries()],
      pending: [...this.pendingConnections],
    };
  }
}

export { RAID_MESSAGES, RE };
