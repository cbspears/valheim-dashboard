import type { Metadata } from 'next';

// `absolute` opts out of the root layout's `%s · Eilif` title template so the
// tab reads exactly "Eilif — TV". noindex/nofollow keeps this experimental,
// unlinked page out of search engines (hidden-URL-only, per Charlie).
export const metadata: Metadata = {
  title: { absolute: 'Eilif — TV' },
  robots: { index: false, follow: false },
};

/**
 * Chrome suppression for TV Mode — WITHOUT touching the root layout.
 *
 * app/layout.tsx wraps every route in <NavBar/>, a width-capped <main>, and
 * <Footer/>. TV Mode is experimental and may be deprecated, so we keep it fully
 * self-contained: rather than editing the root layout (or restructuring the app
 * into multiple root layouts via route groups, which would move existing files),
 * this nested segment layout renders the entire /tv view inside a
 * `position: fixed`, full-viewport layer at z-100 — above the sticky z-50
 * NavBar — which visually covers all site chrome. Delete app/tv + components/tv
 * and the site is untouched.
 */
export default function TvLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] overflow-hidden bg-night text-ash">
      {/* faint gold aurora at the top edge — echoes globals.css body ambience */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_120%_60%_at_50%_-10%,rgba(200,149,42,0.08),transparent_60%)]"
      />
      <div className="relative flex h-full w-full flex-col">{children}</div>
    </div>
  );
}
