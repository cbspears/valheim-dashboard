import type { NextConfig } from "next";

/**
 * The Supabase Storage host, read from the same variable the data layer reads
 * so the image allow-list cannot drift from the project the site actually
 * talks to. If it is somehow absent at build time we fall back to the Supabase
 * subdomain wildcard rather than failing the build — a slightly wider
 * allow-list beats a gallery of broken images.
 */
const SUPABASE_IMAGE_HOST = (() => {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return "*.supabase.co";
  try {
    return new URL(raw).hostname;
  } catch {
    return "*.supabase.co";
  }
})();

const nextConfig: NextConfig = {
  /**
   * IMAGES, AND THE EGRESS INCIDENT OF 2026-10-02.
   *
   * The Supabase project ran out of its monthly Storage egress and started
   * answering 402 to every API and storage call, which read from outside as
   * "the whole site is offline". /gallery was the main bill: 132 community
   * screenshots, 16.6 MB of them, rendered at full size with `<img src>`
   * pointing straight at the public bucket — and Supabase Storage sets
   * `cache-control: no-cache` on every public object, so NOTHING in between
   * ever kept a copy. Every single page view paid all 16.6 MB again.
   *
   * Routing those through next/image means Vercel fetches each source once per
   * (width, quality) and serves everybody else a transcoded copy out of its own
   * cache. Supabase then pays roughly one fetch per photo per size per
   * `minimumCacheTTL`, instead of one per photo per visitor.
   *
   * The MAP is deliberately NOT in here. It changes every five minutes, so an
   * optimizer entry per snapshot would just move the cost onto Vercel's image
   * quota for no transcoding benefit; it goes through app/api/map/* instead,
   * which is a plain proxy with real `Cache-Control` on it. See lib/map-image.
   */
  images: {
    // The gallery bucket, and nothing else. No query strings (`search: ''`),
    // no other bucket, no other host: the optimizer is an open fetcher for
    // whatever it is allowed to fetch, so it is allowed one path.
    remotePatterns: [
      {
        protocol: "https",
        hostname: SUPABASE_IMAGE_HOST,
        port: "",
        pathname: "/storage/v1/object/public/gallery/**",
        search: "",
      },
    ],

    // Default is [...1920, 2048, 3840]. Nothing this site serves is wider than
    // 1915 px (the painterly art plates) and the gallery is capped at 1600 by
    // the Discord bot's own resize, so the 2048 and 3840 rungs could only ever
    // UPSCALE a source — paying twice (once to Supabase, once to the optimizer)
    // to make a bigger file than the original. 1600 is added as an exact rung
    // so a gallery photo at full size lands on its native width.
    deviceSizes: [640, 750, 828, 1080, 1200, 1600, 1920],

    // Thirty-one days. A gallery URL is content-addressed by the Discord
    // attachment id and is never rewritten, so a long TTL is safe and it is the
    // single biggest lever on how often Supabase is asked for the bytes again.
    // CAVEAT, since there is no cache-invalidation API: the local art plates
    // under /images/eilif go through the same optimizer, so REPLACING one of
    // those files in place (same filename, new picture) can show the old one
    // for up to a month. Ship art under a new filename.
    minimumCacheTTL: 2678400,
  },

  experimental: {
    // Client Router Cache TTL for the prerendered (ISR) routes: /world, /events,
    // /gallery, /oath, /map and /boss/[slug]. Next's default is 300 s, which
    // meant a viking who had already opened /world kept seeing the pre-kill
    // boss timeline for up to five minutes after a boss fell, because the
    // browser never asked the server again (measured 2026-09-05:
    // x-nextjs-stale-time: 300). 30 s keeps navigation snappy and bounds the
    // worst case at ISR 60 s + 30 s. Dynamic routes stay at 0 (the default).
    staleTimes: { dynamic: 0, static: 30 },
  },

  /**
   * Addresses people actually type, and the three pages that moved.
   *
   * Every one of the aliases 404'd on 2026-09-06. Redirects are checked before
   * the filesystem, so nothing here can shadow a real route: adding, say, an
   * app/story/page.tsx later would need its line taken out first.
   *
   * PERMANENT (308) for the moves, TEMPORARY (307) for the aliases. /mods and
   * /commands really are gone, merged into /resources, and /oath is gone the
   * same way: the wall is the "Oaths sworn" section under the roster on
   * /players. A browser is right to remember all three forever. The six
   * aliases are guesses at what someone might type, not statements about where
   * a page lives, and a 308 on /story would be very hard to take back if Story
   * ever became its own route.
   *
   * A hash survives the redirect (it rides in the Location header), so a typed
   * address or an old bookmark lands on the mod half, on the register half, or
   * on the oath wall rather than at the top of a long page.
   *
   * It does NOT survive a click inside the site. A <Link> navigation fetches
   * the route, follows the 308, and the resolved URL it routes to has no
   * fragment on it, so the reader lands at the top of the destination.
   * Measured 2026-09-06 against a production build: /oath typed into the bar
   * put #oaths 80px from the top; the same destination clicked through the
   * redirect put it 942px below the fold. So a link inside the site must
   * address the destination directly (/players#oaths, /resources#mods),
   * never the redirect. scripts/commands-page.test.mjs holds that rule.
   */
  async redirects() {
    return [
      { source: '/mods', destination: '/resources#mods', permanent: true },
      { source: '/commands', destination: '/resources#commands', permanent: true },
      { source: '/oath', destination: '/players#oaths', permanent: true },
      { source: '/vikings', destination: '/players', permanent: false },
      { source: '/viking', destination: '/players', permanent: false },
      { source: '/story', destination: '/events', permanent: false },
      { source: '/saga', destination: '/events', permanent: false },
      { source: '/join', destination: '/get-started', permanent: false },
      { source: '/start', destination: '/get-started', permanent: false },
      { source: '/boss', destination: '/world', permanent: false },
    ];
  },
};

export default nextConfig;
