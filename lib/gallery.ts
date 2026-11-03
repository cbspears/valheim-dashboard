// The arithmetic of the paged gallery (2026-11-03), kept free of React and
// Supabase so the tests can run it without either. The pages live in the PATH,
// /gallery for page 1 and /gallery/N after it, because a query string would
// opt the route out of ISR (see app/events/page.tsx).

/** How many pages a gallery of `total` photos fills. Never less than one, so an
 *  empty gallery still has a page 1 to say so. */
export function galleryPageCount(total: number, perPage: number): number {
  if (!Number.isFinite(total) || total <= 0 || perPage <= 0) return 1;
  return Math.ceil(total / perPage);
}

/** The canonical address of page `n`. Page 1 is plain /gallery, never /gallery/1. */
export function galleryPageHref(n: number): string {
  return n <= 1 ? '/gallery' : `/gallery/${n}`;
}

/**
 * The page number a `[page]` segment names, or null when it names none. Only
 * plain positive integers count: "abc", "0", "-2", "2.5" and "02" are all null,
 * so one page has exactly one address. "1" parses to 1, and the route turns
 * that into a redirect to /gallery rather than a second copy of page 1.
 */
export function parseGalleryPage(raw: string): number | null {
  if (!/^[1-9]\d{0,5}$/.test(raw)) return null;
  return Number(raw);
}
