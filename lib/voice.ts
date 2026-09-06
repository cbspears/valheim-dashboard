// Shaping helpers for GET /api/voice — the queue the in-game EilifCompanion polls.
//
// PER-PLAYER TARGETING, WITHOUT A SCHEMA CHANGE. A spoken line can be addressed to
// exactly one viking. The recipient rides in the row's existing `meta` jsonb as
// `meta.target`, a character name spelled the way the game shows it; there is no
// `target` column and no migration. Rows without one keep behaving exactly as they
// always have: the plugin speaks them to everybody.
//
// WHY THE RULES ARE STRICT (and why an over-long or blank target is DROPPED rather
// than trimmed to fit or passed through): the plugin matches this string against
// `ZNetPeer.m_playerName` and, when it matches nothing, refuses to broadcast the
// line — a targeted line is never downgraded to everyone. So a malformed target is
// the difference between "one viking hears it" and "nobody does", and truncating a
// 70-character value to 64 would silently retarget the line at whatever peer that
// prefix happens to hit. Valheim's own character names are 15 characters; 64 is the
// same generous bound SpeakerIdentity.MaxNameLen uses on the plugin side. Anything
// past it is not a name, so the field is ignored and the line goes out untargeted —
// which is the pre-existing behaviour, i.e. the fail-safe direction.

/** Matches SpeakerIdentity.MaxNameLen in plugins/eilif-companion/src/SpeakerIdentity.cs. */
export const MAX_VOICE_TARGET_LEN = 64;

/**
 * The character name a voice line is addressed to, or null when it is addressed to
 * the whole hall. Never throws, and never returns an empty string.
 */
export function voiceTarget(meta: unknown): string | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>).target;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_VOICE_TARGET_LEN) return null;
  return trimmed;
}

export interface VoiceRow {
  id: string;
  text: string;
  speaker: string;
  meta?: unknown;
}

export interface VoiceLinePayload {
  id: string;
  text: string;
  speaker: string;
  /** Present ONLY for a targeted line — an absent key is what tells the plugin "everybody". */
  target?: string;
}

/**
 * One line of the `{lines:[…]}` response. `target` is omitted entirely rather than
 * sent as null/"": the plugin's DataContractJsonSerializer leaves an absent member
 * null, and `line.target == null` is exactly the "speak to everyone" branch there.
 */
export function voiceLinePayload(row: VoiceRow): VoiceLinePayload {
  const line: VoiceLinePayload = { id: row.id, text: row.text, speaker: row.speaker };
  const target = voiceTarget(row.meta);
  if (target !== null) line.target = target;
  return line;
}

// A type alias, not an interface, on purpose: only an alias gets an implicit index
// signature, and this value is handed straight to recordRouteHeartbeat's
// `Record<string, unknown>` metrics parameter.
export type CompanionCapabilities = {
  /** True when the polling Companion said it can address a line at one peer. */
  targeting: boolean;
  /** The Companion's own version string, when it sent a plausible one. */
  plugin?: string;
};

/** At most this many capability tokens are read; the rest of the header is ignored. */
const MAX_CAPS = 8;
const MAX_CAP_LEN = 32;
const PLUGIN_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

/**
 * What the polling plugin says about itself, read off two optional request headers
 * (`x-eilif-caps`, `x-eilif-plugin`). Used for two different things, and the difference
 * matters:
 *
 *   1. As a DELIVERY GATE, per request, in `voiceBatch()` below — a plugin that did not
 *      say it can target is not handed a targeted line at all. This is the load-bearing
 *      use, and it is why the value is read from the live request.
 *   2. As cockpit DISPLAY, recorded in the `companion-voice` heartbeat so an operator can
 *      see which Companion is on the box. That write is throttled to once a minute per
 *      serverless instance, so the stored `metrics.targeting` belongs to whichever caller
 *      won the slot — fine to look at, never safe to decide on.
 *
 * It is a self-report from whoever holds VOICE_API_TOKEN, so it is a capability claim,
 * not an authentication one. It can only ever cost its own caller a line: a caller that
 * lies "targeting" gets targeted lines it may broadcast, which is the exact situation the
 * token holder was trusted with anyway (it is handed the line text either way), and a
 * caller that says nothing simply gets fewer lines. Everything is bounded and whitelisted
 * before it can reach a jsonb column.
 */
export function companionCapabilities(
  capsHeader: string | null | undefined,
  versionHeader: string | null | undefined,
): CompanionCapabilities {
  let targeting = false;
  if (typeof capsHeader === 'string' && capsHeader.length > 0) {
    const tokens = capsHeader.split(',', MAX_CAPS);
    for (const token of tokens) {
      if (token.trim().slice(0, MAX_CAP_LEN).toLowerCase() === 'targeting') targeting = true;
    }
  }
  const out: CompanionCapabilities = { targeting };
  if (typeof versionHeader === 'string' && PLUGIN_VERSION_RE.test(versionHeader)) {
    out.plugin = versionHeader;
  }
  return out;
}

// ─── The delivery gate ────────────────────────────────────────────────────────────
//
// TARGETING MUST FAIL CLOSED, AND THIS IS THE ONLY PLACE THAT CAN MAKE IT.
//
// A targeted line is private by construction: "You swore to bring back the swamp key"
// is written for one viking and is a different thing entirely on twenty screens. But a
// Companion older than 0.3.3 does not know the `target` member exists —
// DataContractJsonSerializer silently ignores a member it was never told about — so an
// old plugin handed a targeted line speaks it to the WHOLE HALL. Every other failure
// direction of this feature is closed (a blank or over-long target degrades to
// untargeted, an offline target is dropped in-game rather than broadcast); this one was
// open, and it is the only one where the failure is a private line read out loud.
//
// The producer cannot close it. `services/discord-bot/src/voice.js` decides whether to
// queue a targeted line from `process.env.VOICE_TARGETING`, an env var a human sets, and
// a human setting it before the box has 0.3.3 on it is exactly the mistake to expect on
// launch morning. So the gate lives HERE, at the one point where "this line is private"
// and "the plugin asking for it can keep it private" are both known in the same request.
//
// A withheld line is CONSUMED, not left queued. `/api/voice` selects the three oldest
// queued rows, so three stuck targeted rows at the head would wedge the whole voice
// queue permanently — the hall would go silent rather than lose one private nudge. That
// is the worse failure, and it is the same reasoning the plugin's own drop path uses.
//
// This gate reads the header off THIS request, not the heartbeat row: `recordRouteHeartbeat`
// is throttled to one write a minute per instance, so `metrics.targeting` is a cockpit
// display of whichever caller won the slot and must never be a control input.

/** A line that was claimed but deliberately not handed over. */
export interface WithheldVoiceLine {
  id: string;
  target: string;
}

export interface VoiceBatch {
  /** What the polling plugin is given. */
  lines: VoiceLinePayload[];
  /** Targeted lines a plugin that cannot target would have broadcast. Claimed, never sent. */
  withheld: WithheldVoiceLine[];
}

/**
 * Split the rows claimed by one poll into what this particular plugin may be handed and
 * what it may not. Pure; the caller marks EVERY claimed row spoken either way.
 */
export function voiceBatch(rows: readonly VoiceRow[], caps: CompanionCapabilities): VoiceBatch {
  const lines: VoiceLinePayload[] = [];
  const withheld: WithheldVoiceLine[] = [];
  for (const row of rows) {
    const line = voiceLinePayload(row);
    if (line.target !== undefined && !caps.targeting) {
      withheld.push({ id: line.id, target: line.target });
      continue;
    }
    lines.push(line);
  }
  return { lines, withheld };
}
