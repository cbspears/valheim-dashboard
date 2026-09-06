import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
