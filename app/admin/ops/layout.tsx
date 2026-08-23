import type { Metadata } from 'next';

// The cockpit is private + unlinked. noindex/nofollow across the whole /admin/ops
// segment keeps both the login and the dashboard out of search engines. There is
// deliberately NO nav link to it anywhere on the public site.
export const metadata: Metadata = {
  title: { absolute: 'Eilif · Ops' },
  robots: { index: false, follow: false, nocache: true },
};

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
