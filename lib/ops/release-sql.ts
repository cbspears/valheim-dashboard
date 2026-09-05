// The release statement the ops cockpit shows under the identity-mismatch table.
//
// PURE (names in → SQL text out) so the escaping can be tested, which is the
// whole reason this is not an inline template literal on the page.
//
// Why it needs care: `character_name` is UNVALIDATED player input. The webhook
// accepts any non-empty string for it (app/api/webhook/route.ts only checks
// `typeof === 'string'` and a non-empty trim: no length limit, no character
// class, no escaping) and that string lands in `players.character_name` and then
// in this block — which the surrounding copy invites an admin to paste into
// Supabase under the SERVICE ROLE. React escapes HTML, so there is no XSS; it
// does not escape SQL. The everyday case is an apostrophe (Sig'run) producing a
// syntactically broken statement; the deliberate case is a name chosen to close
// the literal early, in a statement an admin has been nudged to run with full
// privileges.

/**
 * Quote a character name as a Postgres string literal.
 *
 * Doubling the quote is Postgres's own escape (`''` inside a literal is one
 * quote), so both the honest apostrophe and a crafted name come out as one inert
 * string. Never interpolate a name into SQL text without this.
 */
export function sqlQuote(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/**
 * One release statement per DISTINCT character name, in the order first seen.
 *
 * One statement per character, not one for the newest row: the table above it
 * can hold several names at once, and a single hardcoded statement would release
 * one viking while leaving the others silently frozen — the exact failure this
 * panel exists to make visible.
 *
 * `players.character_name` is UNIQUE (db/2026-07-25_players_unique_name.sql), so
 * keying on the name is unambiguous.
 */
export function releaseBindingSql(names: string[]): string {
  return [...new Set(names)]
    .map((name) => `update players set steam_id = null where character_name = ${sqlQuote(name)};`)
    .join('\n');
}
