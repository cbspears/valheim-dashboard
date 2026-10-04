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

// Every [EILIF_*] marker is written by the companion plugin's BepInEx logger,
// so it ALWAYS carries that logger's source prefix at the very start of the
// line: "[Info   :Eilif Companion] [EILIF_POS] …" (BepInEx formats the source
// as {Source,10}, so the 15-char name is unpadded — verified against the live
// GTX LogOutput.log). Anchoring the markers to it is defence in depth behind
// the console-echo guard in processLine: nothing a player can type — into
// chat, a sign, an item name, anywhere — starts a log line, so an embedded
// marker can no longer be mistaken for a plugin-emitted one even if a future
// edit reorders the checks. Whitespace/level are matched leniently so a
// BepInEx log-format change degrades to "marker ignored", never "marker
// forged".
const EILIF_PREFIX = String.raw`^\[\w+\s*:\s*Eilif Companion\]\s*`;

// --- The log line's own clock (2026-09-12 replay fix) ----------------------
// Unity stamps every console line the game writes with the SERVER BOX's local
// date and time, immediately after the BepInEx source tag:
//
//   [Info   : Unity Log] 09/12/2026 08:42:02: Got connection SteamID 7656…
//
// READ THIS BEFORE USING THE RETURN VALUE. The box is a GTX Windows host whose
// timezone this process does not know and cannot ask for; the stamp carries no
// offset and no zone name. So the number below is deliberately computed as if
// the wall-clock reading were UTC: it is a point in an ARBITRARY BUT CONSISTENT
// frame, and ONLY DIFFERENCES BETWEEN TWO OF THEM ARE MEANINGFUL. Never hand
// one to `new Date()` and call it an event time — anchor it against a line
// known to be fresh first (see Poller.anchorBatchTimes). The one thing that
// distorts a difference is a DST step in the box's local clock, which shifts
// lines on opposite sides of it by an hour; an hour of skew on a four-hour
// replay is a far smaller error than filing all four hours under "now".
const LOG_LINE_TIME_RE = /\b(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2}):/;

/**
 * The line's own timestamp as milliseconds in the arbitrary frame described
 * above, or null when the line carries no (valid) stamp. Exported for tests and
 * for the poller's batch anchoring.
 */
export function parseLogLineTime(line) {
  const m = LOG_LINE_TIME_RE.exec(String(line ?? ''));
  if (!m) return null;
  const [, mm, dd, yyyy, hh, mi, ss] = m.map(Number);
  // Reject impossible readings rather than letting Date.UTC roll them over into
  // a plausible-looking instant (month 13 would silently become January).
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  if (hh > 23 || mi > 59 || ss > 60) return null;
  const ms = Date.UTC(yyyy, mm - 1, dd, hh, mi, ss);
  return Number.isFinite(ms) ? ms : null;
}

// Valheim shouts this automatically whenever a character spawns — it is not
// player speech, and mirroring it doubled every join in #server.
const ARRIVAL_SHOUT_RE = /^\s*i\s+have\s+arrived\s*!*\s*$/i;

/** True for Valheim's automatic spawn shout ("I have arrived!", any casing). */
export function isArrivalShout(text) {
  return ARRIVAL_SHOUT_RE.test(String(text ?? ''));
}

// Length caps applied before an event is dispatched. Chat was already clamped
// downstream at 300; oath/pin text had no cap at all, so one very long shout
// could hand the oath wall (and the Discord embed) an unbounded string.
const MAX_OATH_LEN = 280;
const MAX_PIN_NAME_LEN = 280;
const MAX_CHAT_LEN = 300;

const RE = {
  connection: /Got connection SteamID (\d+)/,
  zdoid: /Got character ZDOID from (.+?) : (-?\d+):(-?\d+)/,
  closing: /Closing socket (\d+)/,
  connections: /Connections (\d+) ZDOS/,
  randomEvent: /Random event set:(\S+)/,
  serverConnected: /Game server connected/,
  // The Eilif companion plugin's /oath chat command. Anchored to the plugin's
  // own log prefix (EILIF_PREFIX above); name/text split on the FIRST " | " so
  // a text containing " | " itself stays intact.
  //   [Info   :Eilif Companion] [EILIF_OATH] Testman | I swear …
  oath: new RegExp(EILIF_PREFIX + String.raw`\[EILIF_OATH\]\s*(.+)$`),
  // Shouted /oath as echoed by the server console — the mod-free capture path.
  // Shout text arrives display-uppercased; the oath keyword is matched case-
  // insensitively and the sworn text is kept exactly as shouted. The name group
  // is [^<>]+ (not .+?): a shout whose text carries rich-text closers, e.g.
  //   …<color=orange>Bob</color>: <color=#FFFFFFFF></color>: <color=white>/oath x</color>
  // otherwise filed the oath under the name "Bob</color>: <color=#FFFFFFFF>".
  //
  // ANCHORED AT ^ and matched against the echo PAYLOAD (everything after the
  // line's own "Console: " prefix — see ECHO_LINE), never against the raw line.
  // Matching it anywhere in the line let a player SHOUT the echo shape and have
  // the plugin's verbatim [EILIF_CHAT] copy of their own words re-read as a
  // genuine console echo from whoever they named.
  //   <color=orange>Testman</color>: <color=#FFEB04FF>/OATH I SWEAR ...</color>
  consoleOath: /^<color=orange>([^<>]+)<\/color>:\s*<color=[^>]*>\/oath\s+(.+?)<\/color>/i,
  // The Eilif companion plugin's /pin capture (Harmony patch on
  // Chat.OnNewChatMessage — unlike /oath this NEEDS the plugin, since a
  // world position isn't available from the console echo alone).
  //   [Info   :Eilif Companion] [EILIF_PIN] Testman | poi | The Dark Chapel | 123.4 | -567.8
  pin: new RegExp(
    EILIF_PREFIX +
      String.raw`\[EILIF_PIN\]\s*(.+?)\s*\|\s*(base|poi)\s*\|\s*(.+?)\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)\s*$`
  ),
  // The Eilif companion plugin's shout-chat capture (raw casing, name/text
  // split on the FIRST " | " like [EILIF_OATH]).
  //   [Info   :Eilif Companion] [EILIF_CHAT] Testman | hello there
  chat: new RegExp(EILIF_PREFIX + String.raw`\[EILIF_CHAT\]\s*(.+)$`),
  // The Eilif companion plugin's live position + biome (emitted ~60s per online
  // player). Explicit "|"-separated fields like [EILIF_PIN]; x/z are world
  // coords ("-184.9" style) and biome is a plain enum word (Meadows, BlackForest,
  // …, or None) — matched leniently as a run of non-space chars.
  //   [Info   :Eilif Companion] [EILIF_POS] Bjorn | -184.9 | -2.1 | BlackForest
  pos: new RegExp(
    EILIF_PREFIX + String.raw`\[EILIF_POS\]\s*(.+?)\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)\s*\|\s*(\S+)\s*$`
  ),
  // Any shouted chat as echoed by the server console — the mod-free capture
  // path (text arrives display-UPPERCASED). Command shouts (/oath, /pin, …)
  // are filtered out in processLine, and the consoleOath check runs first.
  // Anchored at ^ against the echo PAYLOAD, like consoleOath above.
  //   <color=orange>Testman</color>: <color=#FFEB04FF>HELLO THERE</color>
  consoleShout: /^<color=orange>(.+?)<\/color>:\s*<color=[^>]*>(.+?)<\/color>/,
};

// The console echo's own line prefix, anchored at the START of the line. The
// game writes shout echoes through Unity's logger, so BepInEx stamps them with
// its "Unity Log" source and the game adds its own date/time:
//
//   [Info   : Unity Log] 09/01/2026 09:41:59: Console: <color=orange>…
//
// Every part before "Console: " is FIXED SHAPE — no `.*` anywhere — so this can
// only ever match the line's own prefix. That matters: with a lazy `.*?Console:`
// the engine would happily backtrack past the real prefix to a second, PLAYER
// SUPPLIED "Console:" further along the line, which is exactly the forgery this
// closes (a shout whose text is itself an echo-shaped string, reproduced
// verbatim on the plugin's [EILIF_CHAT] line). The BepInEx prefix and the
// timestamp are both optional so a log-format change degrades to "echo
// ignored", never "echo forged".
const ECHO_LINE = /^(?:\[\w+\s*:\s*Unity Log\]\s*)?(?:[\d/]+\s+[\d:]+:\s*)?Console:\s*/;

// A captured character name that could not have come from Valheim. Rich-text
// markup (`<`/`>`), the plugin's own field separator (`|`) and control
// characters are all signatures of an injected or malformed capture rather than
// a real name — the plugin sanitises what IT logs (SpeakerIdentity.Safe), and
// this is the log parser refusing to be the single point of trust for the
// console-echo path, which no plugin touches.
const IMPLAUSIBLE_NAME_RE = /[<>|]|[\u0000-\u001f\u007f]/;

/** Could this captured string be a real Valheim character name? */
export function isPlausibleCharacterName(name) {
  const n = String(name ?? '');
  return n.length > 0 && n.length <= 64 && !IMPLAUSIBLE_NAME_RE.test(n);
}

// How long a name may sit in `online` with no [EILIF_POS] line of its own
// before the sweep calls it gone: five minutes = five missed 60 s emits.
//
// WHY A SWEEP EXISTS AT ALL (2026-09-10). Presence used to be derived purely
// from the vanilla lines, and under 1.0's 10-25 player join bursts the FIFO
// pairing of "Got connection SteamID N" to the next "Got character ZDOID from
// <name>" is frequently WRONG. Two failures followed from that, both seen live
// on 2026-09-09/10:
//   (1) a name paired with someone else's SteamID is marked offline when THAT
//       player's socket closes (Fjällhnot, still in-world, lost 4 h of hours);
//   (2) the wrongly-removed player's next RESPAWN line re-adds the name with no
//       pairing at all (the pending queue is empty by then), so no "Closing
//       socket" can ever remove it again — a permanent phantom (Rosir, Hel,
//       Psifour), whose phantom hours flipped a Discord title.
// The "Connections N ZDOS:" heartbeat only self-heals at N = 0, which on a busy
// server is never. The companion plugin's position emitter, on the other hand,
// writes one line per peer that is genuinely in-world every 60 s — so that, not
// the socket bookkeeping, is the presence truth.
//
// The trade: a player sitting on the death screen emits no position (the plugin
// skips a peer with no character), so five minutes dead-and-not-respawning
// reads as a leave. A death-to-respawn gap is a few seconds; that edge case is
// the deliberate price of never phantoming again.
const DEFAULT_POS_STALE_MS = 5 * 60 * 1000;

// --- The last viking out (2026-10-02/03, Imogen) ---------------------------
// The sweep's own guard had a hole shaped exactly like an empty server. When
// the LAST player in the world logs off, the emitter stops emitting — and the
// guard above reads that silence as "the plugin died", disarms, and the one
// name still on the roster can never be swept. Imogen's socket close was
// mis-attributed at 21:46:20, her next position re-added her two seconds later
// with no pairing, her positions stopped at 01:52 when she really left, and
// nothing removed her until the next evening's join closed the session at
// 1,435 minutes "played". Same shape as Fjällhnot on 09-15.
//
// The way out is that the silence is not our only evidence: the server itself
// writes "Connections N ZDOS:" every ~10 minutes whether anyone is playing or
// not, and N comes from the server's own socket table, not from the plugin. So
// when the emitter is silent overall we fall back on N — but only while it is
// FRESH, because a heartbeat from an hour ago says nothing about now and a
// server that has stopped writing the log entirely (the liveness path's job)
// must not be mistaken for an empty one.
const SERVER_COUNT_FRESH_MS = 3 * 60 * 1000;

// --- The leave that wasn't (same incident, defect B) -----------------------
// "Closing socket <steamId>" is NOT proof that the named viking left: the id
// may be mis-bound (FIFO pairing under a join burst — see above), or the
// server may simply be closing a duplicate socket for a player who is still in
// the world. Imogen's 21:46:20 leave was one of these, and her [EILIF_POS] two
// seconds later re-opened the session as a pos-join with no steam binding at
// all, splitting one evening in two and leaving nothing that a later socket
// close could ever match.
//
// So a socket-close leave for a name the emitter has just vouched for waits
// this long before it is believed. One more position line inside the window
// cancels it outright; silence confirms it, and the leave is then emitted with
// the time of the socket close, not the time the window ran out.
const DEFAULT_LEAVE_GRACE_MS = 90 * 1000;

export class LogParser {
  /**
   * @param {object} [initial] persisted state to resume from
   * @param {string[]} [initial.online] character names known online
   * @param {[string, string][]} [initial.connections] persisted steamId->characterName pairs
   * @param {string[]} [initial.pending] persisted unresolved-connection steamIds, oldest first
   * @param {[string, number][]} [initial.posSeen] persisted name->last [EILIF_POS] ms
   * @param {number} [initial.lastAnyPosAt] persisted ms of the last POS line from anyone
   * @param {[string, object][]} [initial.leavePending] persisted name->unconfirmed socket-close leave
   * @param {number} [initial.lastConnectionCount] persisted last "Connections N" reading
   * @param {number} [initial.lastConnectionCountAt] persisted ms that reading was taken
   * @param {object} [log] optional logger (`info`/`warn`); presence decisions the
   *   event stream cannot carry (a cancelled leave) are narrated through it.
   */
  constructor(initial = {}, log = null) {
    this.log = log;
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
    // Names whose SteamID pairing was made while MORE THAN ONE handshake was
    // waiting. FIFO order is not spawn order when several people join in the
    // same seconds (launch night 2026-09-09: five joins in 40 s crossed two
    // pairings and the identity guard refused the owner's own oath). Such a
    // pairing still serves roster/leave bookkeeping, but steamIdFor() reports
    // null for it, so the webhook allows the write without binding or refusing.
    this.ambiguous = new Set(Array.isArray(initial.ambiguous) ? initial.ambiguous : []);
    this.contestedLeft = Number.isInteger(initial.contestedLeft) ? initial.contestedLeft : 0;
    // Last value seen on a "Connections N" heartbeat (null until first seen),
    // and when we read it. The timestamp is what makes the count usable as
    // evidence: see SERVER_COUNT_FRESH_MS and sweepStale.
    this.lastConnectionCount = Number.isInteger(initial.lastConnectionCount)
      ? initial.lastConnectionCount
      : null;
    this.lastConnectionCountAt = Number.isFinite(initial.lastConnectionCountAt)
      ? initial.lastConnectionCountAt
      : null;
    // name -> wall-clock ms of the last liveness evidence for that name: an
    // [EILIF_POS] line, or the moment the name entered `online` if it has not
    // been seen in a position emit yet. Only names in `online` are kept.
    // Wall clock is fine here: the poller drags the log by ~20 s and never
    // replays it (the byte offset is persisted), so parse time IS log time
    // within one tick.
    this.posSeen = new Map(Array.isArray(initial.posSeen) ? initial.posSeen : []);
    // When ANY player's position last arrived. The sweep below refuses to run
    // when this is stale: silence from the emitter means the PLUGIN died, not
    // that the server emptied, and sweeping on that would evict everyone.
    this.lastAnyPosAt = Number.isFinite(initial.lastAnyPosAt) ? initial.lastAnyPosAt : null;
    // name -> { at, steamId } for a "Closing socket" leave that is waiting out
    // its grace window (see DEFAULT_LEAVE_GRACE_MS). The name is still on the
    // roster and still carries its binding while it sits here. Persisted like
    // posSeen so the in-memory snapshot/restore tick() does on a failed batch
    // — and a real restart — neither loses the leave nor emits it twice.
    //
    // Unlike posSeen the clock is NOT re-stamped on restore: `at` is when the
    // socket actually closed and is the time the leave will be filed under, so
    // a window that expired while we were down must expire, not restart.
    this.leavePending = new Map(Array.isArray(initial.leavePending) ? initial.leavePending : []);
    // name -> ms of the last [EILIF_POS] line for that name, and ONLY that.
    // posSeen above answers "how long since we had any reason to believe this
    // name is here", which markOnline also stamps; this one answers the
    // narrower question the grace window asks — "did the emitter itself vouch
    // for her just now?" — so a name that has never been in a position line
    // (no plugin, a join burst, a fixture replay) gets the old prompt leave.
    this.posVouchedAt = new Map(Array.isArray(initial.posVouchedAt) ? initial.posVouchedAt : []);
    // A restart (or the in-memory snapshot/restore tick() does on a failed
    // batch) must not evict the roster it just inherited: every restored name
    // gets a full staleMs of grace, and stamps for anyone no longer online are
    // dropped so the map can't grow across restarts.
    const restoredAt = Date.now();
    for (const name of this.posSeen.keys()) {
      if (!this.online.has(name)) this.posSeen.delete(name);
    }
    for (const name of this.online) this.posSeen.set(name, restoredAt);
    for (const name of [...this.leavePending.keys()]) {
      if (!this.online.has(name)) this.leavePending.delete(name);
    }
    for (const name of [...this.posVouchedAt.keys()]) {
      if (!this.online.has(name)) this.posVouchedAt.delete(name);
    }
  }

  /**
   * Put a name on the roster and stamp its liveness clock. Returns true if it
   * was not already there (i.e. the caller should emit a `join`). Every path
   * that adds to `online` goes through here so no name can ever be online
   * without a stamp — an unstamped name would be swept on sight.
   */
  markOnline(name, nowMs = Date.now()) {
    if (this.online.has(name)) return false;
    this.online.add(name);
    this.posSeen.set(name, nowMs);
    return true;
  }

  /** Take a name off the roster and forget its liveness stamp. */
  markOffline(name) {
    this.posSeen.delete(name);
    this.posVouchedAt.delete(name);
    // A name that is leaving for any other reason has no unconfirmed leave to
    // confirm later — dropping it here is what keeps the map from outliving
    // the roster (every removal path funnels through this method).
    this.leavePending.delete(name);
    return this.online.delete(name);
  }

  /**
   * Call off a socket-close leave that is still inside its grace window,
   * because something just proved the viking is in the world after all.
   * Returns true if there really was one. `why` names the proof for the log.
   */
  cancelPendingLeave(name, why) {
    if (!this.leavePending.delete(name)) return false;
    this.log?.info?.(`[presence] ${name} socket closed but ${why}; leave cancelled`);
    return true;
  }

  /** Names currently online, sorted for stable output. */
  roster() {
    return [...this.online].sort();
  }

  /**
   * The SteamID currently paired with a character name, or null if we have
   * none. This is the ONLY stable identity the dedicated server hands us:
   * Valheim allows duplicate character names and never verifies them, so the
   * dashboard's name-keyed writes (oath, pin, the /oath CODE Discord link) are
   * impersonable without it (audit security-3). Never authoritative — a pairing
   * we simply haven't seen yet (a shout before the join line, a poller restart)
   * reads the same as "no such player", so downstream treats null as "allow".
   */
  steamIdFor(name) {
    if (this.ambiguous.has(name)) return null;
    return this.nameToSteam.get(name) ?? null;
  }

  /**
   * Feed one log line. Returns an array of event objects (possibly empty):
   *   { type, characterName?, steamId?, metadata, raid?, count? }
   * `type` is one of: join | leave | death | raid | heartbeat | oath | pin |
   * chat | pos.
   *
   * Every event that names a character also carries the `steamId` we currently
   * pair with that name, when we have one — attached HERE, in one place, so no
   * individual rule can forget it. `leave` sets its own before the pairing is
   * torn down; anything already carrying a steamId is left alone.
   */
  processLine(line) {
    const events = this.parseLine(line);
    // The producing line's own clock reading, in the arbitrary frame
    // parseLogLineTime documents. The poller anchors it against the newest line
    // in the same batch to recover a real instant; nothing else may use it.
    const logTimeMs = parseLogLineTime(line);
    for (const ev of events) {
      if (logTimeMs !== null && ev.logTimeMs === undefined) ev.logTimeMs = logTimeMs;
      if (ev.characterName && ev.steamId === undefined) {
        const steamId = this.steamIdFor(ev.characterName);
        if (steamId) ev.steamId = steamId;
      }
    }
    return events;
  }

  /** The rule table itself. Use processLine() — it adds the SteamID pairing. */
  parseLine(line) {
    const events = [];
    if (!line) return events;

    // --- Console-echoed shout (checked BEFORE any [EILIF_*] marker) ---
    // A player can SHOUT the literal text "[EILIF_OATH] Victim | fake text"
    // (or [EILIF_PIN]/[EILIF_POS]/[EILIF_CHAT]) and the server console echoes
    // it back verbatim as "Console: <color=orange>Attacker</color>: <color=
    // ...>[EILIF_OATH] Victim | fake text</color>". If a marker regex ran over
    // an echo line first it would trust the embedded marker as if the plugin
    // emitted it — impersonating (and overwriting) another player's real
    // oath/pin/chat/position. So: a line that IS a console echo is handled
    // ONLY as an echoed oath/chat and never falls through to a marker check.
    // (The markers are also anchored to the plugin's own log prefix, which an
    // echo line can never carry — two independent guards.)
    //
    // "IS a console echo" now means the echo prefix at the START of the line
    // (ECHO_LINE), not the echo SHAPE anywhere in it. The old test was itself
    // forgeable: shout an echo-shaped string and the plugin's raw-case
    // [EILIF_CHAT] copy of your own words carried that shape, so the parser
    // read it as a genuine echo from whatever name you had embedded — an oath
    // filed under someone else's viking. Anchoring also means the payload the
    // two regexes below see always starts at the line's OWN "Console: ",
    // never at one a player typed.
    const echoPrefix = line.match(ECHO_LINE);
    if (echoPrefix) {
      const payload = line.slice(echoPrefix[0].length);

      // --- In-game sworn oath (shouted, via the server's console echo) ---
      const co = payload.match(RE.consoleOath);
      if (co) {
        const name = co[1].trim();
        const text = co[2].trim().slice(0, MAX_OATH_LEN);
        // `source` tells the poller which of the two lines a /oath shout
        // produces this is. The plugin's own [EILIF_OATH] line carries the
        // SERVER-verified peer name (Companion 0.3.2) and the raw casing, so
        // when both are in one batch the plugin's must win — see the twin
        // dedupe in poller.js.
        if (name && text && isPlausibleCharacterName(name)) {
          events.push({ type: 'oath', characterName: name, metadata: { text, source: 'echo' } });
        }
        return events;
      }

      // --- Any other shouted chat (console echo, mod-free but UPPERCASED) ---
      const cs = payload.match(RE.consoleShout);
      if (cs) {
        const name = cs[1].trim();
        const text = cs[2].trim().slice(0, MAX_CHAT_LEN);
        // '/'-prefixed shouts are commands (/oath handled above, /pin via the
        // plugin, anything else is noise) — never mirror them as chat.
        if (name && text && !text.startsWith('/') && isPlausibleCharacterName(name)) {
          events.push({ type: 'chat', characterName: name, metadata: { text, source: 'echo' } });
        }
      }
      return events;
    }

    // --- In-game sworn oath (/oath) ---
    const o = line.match(RE.oath);
    if (o) {
      const rest = o[1];
      const sep = rest.indexOf(' | ');
      if (sep !== -1) {
        const name = rest.slice(0, sep).trim();
        const text = rest.slice(sep + ' | '.length).trim().slice(0, MAX_OATH_LEN);
        // Tagged 'plugin' so the poller can drop the server's console echo of
        // the same shout. This line is the authoritative one: with Companion
        // 0.3.2 the name is the server's record for the sending peer, not the
        // client-supplied display name the echo carries, and the text keeps
        // its real casing instead of Terminal.AddString's uppercase.
        if (name && text) {
          events.push({ type: 'oath', characterName: name, metadata: { text, source: 'plugin' } });
        }
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
        const text = rest.slice(sep + ' | '.length).trim().slice(0, MAX_CHAT_LEN);
        if (name && text && !text.startsWith('/')) {
          events.push({ type: 'chat', characterName: name, metadata: { text, source: 'plugin' } });
        }
      }
      return events;
    }

    // --- In-game pin (/pin, via the Eilif companion plugin) ---
    // No `source` tag and no twin to dedupe: the console-echo path CANNOT emit
    // a pin. A shouted "/pin base Odinshold" is a '/'-prefixed command, which
    // the echo branch above drops, and there is no consolePin rule — a pin
    // needs the world position only the plugin has. If an echo pin is ever
    // added, tag both sides 'plugin'/'echo' like oath and chat and add 'pin' to
    // the twin dedupe in poller.js.
    const p = line.match(RE.pin);
    if (p) {
      const [, name, kind, place, worldX, worldZ] = p;
      if (name && place) {
        events.push({
          type: 'pin',
          characterName: name.trim(),
          metadata: {
            kind,
            name: place.trim().slice(0, MAX_PIN_NAME_LEN),
            worldX: parseFloat(worldX),
            worldZ: parseFloat(worldZ),
          },
        });
      }
      return events;
    }

    // --- Live position + biome (via the Eilif companion plugin, ~60s) ---
    const pos = line.match(RE.pos);
    if (pos) {
      const [, rawName, worldX, worldZ, biome] = pos;
      if (rawName) {
        const name = rawName.trim();
        // THE AUTHORITATIVE LIVENESS SIGNAL. The plugin only emits for a peer
        // whose character is actually in the world, so this line is proof of
        // presence in a way no vanilla line is.
        const now = Date.now();
        this.lastAnyPosAt = now;
        this.posSeen.set(name, now);
        this.posVouchedAt.set(name, now);
        // THE CANCELLATION (2026-10-03). A position for a name whose socket
        // just closed says the close was not hers: she is still in the world.
        // She never left the roster (that is the whole point of the grace
        // window), so there is nothing to re-add and no join to fire — the
        // session simply continues, binding and all, instead of being torn in
        // two by a leave and a pairing-less pos-join two seconds apart.
        this.cancelPendingLeave(name, 'positions continue');
        // A name the socket bookkeeping lost (wrongly paired SteamID, missed
        // ZDOID, poller started mid-session) is put back on the roster HERE,
        // and the webhook opens a session for it. Deliberately no SteamID
        // pairing and no touch of the pending queue: a position line says
        // WHERE someone is, never WHO their Steam account is, and guessing one
        // is exactly the bug this fixes. The webhook treats a join with no
        // pairing as allowed, and dedupes if a session is already open.
        if (!this.online.has(name)) {
          this.online.add(name);
          events.push({ type: 'join', characterName: name, metadata: { source: 'pos' } });
        }
        events.push({
          type: 'pos',
          characterName: name,
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
      // A ZDOID line of either kind is the server still talking about this
      // character, which contradicts a socket-close leave inside its grace
      // window just as a position does (a corpse cannot have disconnected
      // before it died). Cancel it.
      const hadPendingLeave = this.cancelPendingLeave(
        name,
        isDead ? 'the character died in-world' : 'the character spawned'
      );
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
        if (hadPendingLeave) {
          // A relog inside the grace window comes back on the SAME Steam
          // account, so the handshake that just landed is already bound to
          // this name and needs no correlation — but left in the queue it
          // would be FIFO-stolen by the next unrelated joiner, which is the
          // very corruption case 3 below exists to prevent.
          const bound = this.nameToSteam.get(name);
          if (bound) this.pendingConnections = this.pendingConnections.filter((s) => s !== bound);
        }
        if (!alreadyOnline || !alreadyMapped) {
          // Correlate to the oldest unresolved connection, if any.
          // A queue holding more than one handshake is a burst, and EVERY name
          // drained from it is suspect, including the last one (if two crossed,
          // both are wrong). contestedLeft counts the tail of such a burst.
          if (this.pendingConnections.length > 1) {
            this.contestedLeft = Math.max(this.contestedLeft, this.pendingConnections.length);
          }
          const steamId = this.pendingConnections.shift();
          if (steamId) {
            if (this.contestedLeft > 0) {
              this.ambiguous.add(name);
              this.contestedLeft -= 1;
            } else {
              this.ambiguous.delete(name);
            }
            const prevName = this.steamToName.get(steamId);
            if (prevName && prevName !== name && this.online.has(prevName)) {
              // Same Steam connection, different character: the player
              // relogged to a new character. Valheim's log has no explicit
              // "character left" event for an in-session character switch
              // (only a fresh ZDOID line for the new one), so we synthesize
              // the missing leave for the old character here — otherwise it
              // stays phantom-online forever (real incident: Testman ->
              // Testmantwo, 2026-07-04).
              this.markOffline(prevName);
              this.nameToSteam.delete(prevName);
              // Stamped here, not by processLine: the pairing this leave
              // belongs to has just been torn down above.
              events.push({ type: 'leave', characterName: prevName, steamId, metadata: {} });
            }
            this.steamToName.set(steamId, name);
            this.nameToSteam.set(name, steamId);
          }
        }
        if (this.markOnline(name)) {
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
        // THE GRACE WINDOW (2026-10-03, defect B above). If the position
        // emitter vouched for this name within the last 90 s, this close is as
        // likely to be a mis-bound id or a duplicate socket as a real
        // departure — so do not tear anything down yet. The name stays on the
        // roster WITH its binding, and flushPendingLeaves() either emits the
        // leave when the window runs out (stamped with the close, not with the
        // flush) or never, because a position cancelled it.
        //
        // A name with no recent position is handled exactly as before: the
        // emitter has nothing to say about her, so the socket is all we have.
        if (this.leavePending.has(name)) return events; // already waiting one out
        const closedAt = Date.now();
        const vouchedAt = this.posVouchedAt.get(name);
        if (this.online.has(name) && Number.isFinite(vouchedAt) && closedAt - vouchedAt < DEFAULT_LEAVE_GRACE_MS) {
          this.leavePending.set(name, { at: closedAt, steamId });
          return events;
        }
        this.steamToName.delete(steamId);
        this.nameToSteam.delete(name);
        this.ambiguous.delete(name);
        if (this.markOffline(name)) {
          // Same as the relog case: stamp the closing socket's SteamID before
          // processLine can look for a pairing that no longer exists.
          events.push({ type: 'leave', characterName: name, steamId, metadata: {} });
        }
      }
      return events;
    }

    // --- Online-count heartbeat ---
    const n = line.match(RE.connections);
    if (n) {
      const count = parseInt(n[1], 10);
      // Stamped, not just stored: the sweep uses this as evidence about NOW
      // when the position emitter has nothing to say, and a reading from an
      // hour ago is not evidence about now (SERVER_COUNT_FRESH_MS).
      this.lastConnectionCount = count;
      this.lastConnectionCountAt = Date.now();
      // If the server reports zero, force the roster empty (self-heals any
      // join/leave we missed). Otherwise just emit a reconcile signal carrying
      // our current roster.
      if (count === 0 && this.online.size > 0) {
        // SAY SO (2026-10-03). This used to empty the roster in silence, and
        // that silence is how Imogen's session stayed open for 1,435 minutes:
        // the next `sync` listed nobody, but no `leave` ever told the webhook
        // to close her session, so it was still open when she rejoined the
        // following evening. The server's headcount is the same evidence
        // sweepStale leans on when the emitter has gone quiet (see
        // SERVER_COUNT_FRESH_MS), so it produces the same leaves — here, on
        // the line itself, which carries the log's own clock and so dates them
        // correctly even in a replay.
        const now = Date.now();
        for (const name of [...this.online]) {
          const seen = this.posSeen.get(name);
          const silentMs = Number.isFinite(seen) ? Math.max(0, now - seen) : 0;
          events.push(this.evictStale(name, silentMs, { serverCount: 0 }));
        }
        this.online.clear();
        this.posSeen.clear();
        this.posVouchedAt.clear();
        this.leavePending.clear();
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

  /**
   * Evict every name that has gone silent — no [EILIF_POS] of its own for
   * `staleMs` — and return the `leave` events for them. Called once per tick by
   * the poller; see DEFAULT_POS_STALE_MS above for why this exists.
   *
   * THE GUARD, AND ITS HOLE (2026-10-03). The per-name path only runs while
   * the position emitter is demonstrably alive (SOMEBODY's position within the
   * last staleMs/2). If the plugin crashes, is unloaded, or the server is
   * rebuilt without it, every name goes silent at once — and sweeping then
   * would mark the whole server offline on the strength of our own missing
   * input. Silence from everyone means "no evidence", not "no players".
   *
   * But it also means "the last player logged off", and under the old guard
   * that was unreachable: the silence that proves the server emptied was the
   * very thing that disarmed the sweep, so the LAST viking out could never be
   * swept (Imogen, 1,435 minutes — see SERVER_COUNT_FRESH_MS above). So when
   * the emitter has been silent for longer than staleMs we stop treating our
   * own input as the only witness and ask the SERVER, through the fresh
   * "Connections N" count it writes with or without the plugin:
   *
   *   N = 0  -> nobody is connected at all; every name on the roster goes.
   *   N > 0  -> the roster may still be too long; drop the longest-silent
   *             names (and only names silent past staleMs) until it is N.
   *
   * No fresh count, or a count that agrees with the roster, still means no
   * sweep — the guard holds everywhere it used to.
   *
   * The SteamID pairing of a swept name is torn down with it (both maps and the
   * ambiguous set), exactly as a real "Closing socket" would, so a later
   * reconnect under that SteamID pairs cleanly instead of colliding.
   */
  sweepStale(nowMs = Date.now(), staleMs = DEFAULT_POS_STALE_MS) {
    const events = [];
    if (!Number.isFinite(staleMs) || staleMs <= 0) return events;

    // --- The emitter is live: per-name silence is the whole story ---------
    if (Number.isFinite(this.lastAnyPosAt) && nowMs - this.lastAnyPosAt <= staleMs / 2) {
      for (const name of [...this.online]) {
        const seen = this.posSeen.get(name);
        if (!Number.isFinite(seen)) {
          // Should not happen (markOnline stamps every entry), but a name with
          // no stamp must start its clock now rather than be swept on sight.
          this.posSeen.set(name, nowMs);
          continue;
        }
        const silentMs = nowMs - seen;
        if (silentMs <= staleMs) continue;
        events.push(this.evictStale(name, silentMs));
      }
      return events;
    }

    // --- The emitter is silent overall: ask the server --------------------
    // Between staleMs/2 and staleMs the emitter is merely late, which is not
    // yet evidence of anything; wait for it as before.
    if (Number.isFinite(this.lastAnyPosAt) && nowMs - this.lastAnyPosAt <= staleMs) return events;
    if (!Number.isInteger(this.lastConnectionCount) || !Number.isFinite(this.lastConnectionCountAt)) {
      return events; // the server has not told us a count we can lean on
    }
    if (nowMs - this.lastConnectionCountAt > SERVER_COUNT_FRESH_MS) {
      return events; // …and a stale count says nothing about now
    }
    const connected = this.lastConnectionCount;

    if (connected === 0) {
      for (const name of [...this.online]) {
        const seen = this.posSeen.get(name);
        const silentMs = Number.isFinite(seen) ? nowMs - seen : staleMs;
        events.push(this.evictStale(name, silentMs, { serverCount: 0 }));
      }
      return events;
    }

    if (this.online.size <= connected) return events;
    // Longest-silent first, and never a name the emitter spoke for inside
    // staleMs: the server's count is a headcount, not a list of names, so it
    // can only tell us HOW MANY are wrong, never which.
    const silent = [...this.online]
      .map((name) => [name, this.posSeen.get(name)])
      .filter(([, seen]) => Number.isFinite(seen) && nowMs - seen > staleMs)
      .sort((a, b) => a[1] - b[1]);
    let excess = this.online.size - connected;
    for (const [name, seen] of silent) {
      if (excess <= 0) break;
      excess -= 1;
      events.push(this.evictStale(name, nowMs - seen, { serverCount: connected }));
    }
    return events;
  }

  /**
   * Take one name off the roster as a stale-presence `leave`, tearing its
   * SteamID pairing down with it. Shared by every sweep path so they can never
   * drift apart. `extra` rides along in the event metadata.
   */
  evictStale(name, silentMs, extra = {}) {
    const steamId = this.nameToSteam.get(name) ?? null;
    this.markOffline(name);
    this.ambiguous.delete(name);
    if (steamId) {
      this.nameToSteam.delete(name);
      this.steamToName.delete(steamId);
    }
    const ev = {
      type: 'leave',
      characterName: name,
      metadata: { source: 'pos-stale', silentMs, ...extra },
    };
    // Stamped here, like the other two leave paths, because the pairing this
    // leave belongs to has just been torn down.
    if (steamId) ev.steamId = steamId;
    return ev;
  }

  /**
   * Emit the `leave` events for socket closes whose grace window has run out
   * with no position to contradict them (see DEFAULT_LEAVE_GRACE_MS). Called
   * once per tick by the poller, immediately before sweepStale.
   *
   * The event is filed under the time the SOCKET CLOSED, not the moment the
   * window expired — `occurredAtMs` is set here, so the webhook records the
   * departure where it really happened rather than 90 s late. (Like posSeen,
   * that clock is our own: the poller drags the log by ~20 s and never replays
   * it, so parse time is log time within one tick. A socket close caught in a
   * long REPLAY is the documented exception and lands at replay time.)
   */
  flushPendingLeaves(nowMs = Date.now(), graceMs = DEFAULT_LEAVE_GRACE_MS) {
    const events = [];
    for (const [name, pending] of [...this.leavePending]) {
      const at = Number.isFinite(pending?.at) ? pending.at : nowMs;
      if (nowMs - at < graceMs) continue; // still inside its window
      this.leavePending.delete(name);
      if (!this.online.has(name)) continue; // already left by another path
      const steamId = pending?.steamId ?? this.nameToSteam.get(name) ?? null;
      this.markOffline(name);
      this.ambiguous.delete(name);
      if (steamId) {
        this.steamToName.delete(steamId);
        if (this.nameToSteam.get(name) === steamId) this.nameToSteam.delete(name);
      }
      const ev = {
        type: 'leave',
        characterName: name,
        // Deliberately the same metadata a prompt socket-close leave carries:
        // this IS that leave, only confirmed late. Nothing downstream should
        // have to know it waited.
        metadata: {},
        occurredAtMs: at,
      };
      if (steamId) ev.steamId = steamId;
      events.push(ev);
    }
    return events;
  }

  /** Serializable state to persist across restarts. */
  snapshot() {
    return {
      online: this.roster(),
      ambiguous: [...this.ambiguous],
      contestedLeft: this.contestedLeft,
      // Presence liveness (see sweepStale). Restored names are re-stamped with
      // `now` by the constructor, so this round-trips the shape, never a grace
      // period that has already expired.
      posSeen: [...this.posSeen.entries()],
      posVouchedAt: [...this.posVouchedAt.entries()],
      lastAnyPosAt: this.lastAnyPosAt,
      // Socket closes still waiting out their grace window, and the server's
      // own headcount with the moment we read it — both are evidence the
      // sweep needs and neither survives a restart any other way. The window
      // keeps its original clock on restore (see the constructor), so a leave
      // is never lost and never emitted twice.
      leavePending: [...this.leavePending.entries()],
      lastConnectionCount: this.lastConnectionCount,
      lastConnectionCountAt: this.lastConnectionCountAt,
      // steamId->characterName correlation + unresolved-connection queue,
      // so a restart mid-session doesn't forget who's connected to what
      // (see the constructor/relog comments for why this matters).
      connections: [...this.steamToName.entries()],
      pending: [...this.pendingConnections],
    };
  }
}

export {
  RAID_MESSAGES,
  RE,
  ECHO_LINE,
  MAX_OATH_LEN,
  MAX_PIN_NAME_LEN,
  MAX_CHAT_LEN,
  DEFAULT_POS_STALE_MS,
  DEFAULT_LEAVE_GRACE_MS,
  SERVER_COUNT_FRESH_MS,
};
