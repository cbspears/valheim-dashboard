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
};

export default nextConfig;
