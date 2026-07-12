// Redaction for the ops cockpit.
//
// Producers (the discord-bot, log poller, map snapshotter) POST heartbeats that
// may carry free-form error strings and string metric values. Those strings can
// accidentally contain a token, key, or a raw credential blob (a stack trace with
// a bearer header, a connection string, a JWT, ...). We NEVER want a secret to
// land in ops_heartbeats — the cockpit reads that table and renders it — so every
// stored string first passes through sanitize() here.
//
// PURE + dependency-free so it unit-tests without a DB or Next. Best-effort: it
// strips the common shapes of a leaked secret (labelled key=value pairs, bearer
// tokens, JWTs, and long hex/base64 runs), collapses whitespace, and truncates.
// It is a guard rail, not a proof — the real defence is producers not sending
// secrets in the first place.

const DEFAULT_MAX = 200;

// Labels that, when followed by a value, mean "the value is a secret".
const SECRET_LABELS =
  'token|key|secret|password|passwd|pwd|apikey|api_key|auth|authorization|bearer|service_role|anon_key';

/**
 * Sanitize an arbitrary value into a safe, short, secret-free string.
 * Non-strings are coerced (null/undefined → ''). Truncates to `maxLen` chars.
 */
export function sanitize(input: unknown, maxLen: number = DEFAULT_MAX): string {
  if (input === null || input === undefined) return '';
  let s = typeof input === 'string' ? input : String(input);

  // `bearer <token>` → keep the word, drop the credential.
  s = s.replace(/\bbearer\s+[A-Za-z0-9._\-+/=]+/gi, 'bearer [redacted]');

  // Labelled secrets: `token=abc`, `api_key: "abc"`, `password => abc`.
  s = s.replace(
    new RegExp(`\\b(${SECRET_LABELS})\\b\\s*[:=]+\\s*"?[^\\s"',;)]+"?`, 'gi'),
    '$1=[redacted]',
  );

  // JWTs (eyJ… header). Do this before the generic base64 rule.
  s = s.replace(/\beyJ[A-Za-z0-9._-]{10,}/g, '[redacted]');

  // Long hex runs (session ids, sha, hex keys).
  s = s.replace(/\b[0-9a-fA-F]{24,}\b/g, '[redacted]');

  // Long base64/base64url runs (raw key/credential blobs). Length floor of 32
  // keeps ordinary prose words safe.
  s = s.replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]');

  // Collapse whitespace, trim, truncate.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return s;
}

/**
 * Deep-sanitize the string values inside a metrics object (numbers/booleans are
 * left intact — only strings can hide a secret). Recurses through nested objects
 * and arrays with a small depth cap. Returns a NEW object; never mutates input.
 * Non-object input yields {}.
 */
export function sanitizeMetrics(input: unknown, depth = 0): Record<string, unknown> {
  if (depth > 6 || input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = sanitizeValue(v, depth + 1);
  }
  return out;
}

function sanitizeValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return sanitize(v, 500);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) {
    if (depth > 6) return [];
    return v.map((x) => sanitizeValue(x, depth + 1));
  }
  if (typeof v === 'object') return sanitizeMetrics(v, depth);
  // functions, symbols, bigint, undefined → drop
  return null;
}
