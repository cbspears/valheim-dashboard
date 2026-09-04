import Link from 'next/link';
import { Compass, Users, Globe2 } from 'lucide-react';
import { Card, CardBody, SectionHeader, EmptyState } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { SERVER_NAME } from '@/config/server';

// Rendered per request so the nav's next-gathering pill is as live here as it
// is everywhere else. Without this, /_not-found is prerendered at build time
// and a mistyped URL shows whatever gathering was next on deploy day.
export const dynamic = 'force-dynamic';

/**
 * Root 404. Also stops Next's default error component from painting its own
 * `body { background: #fff }` over the dark theme (it did, on every mistyped
 * /viking and /boss URL).
 */
export default function NotFound() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader slot="events">
        <SectionHeader
          title="Page not found"
          subtitle="The skald knows no such tale. Try one of the paths below."
          icon={<Compass size={22} />}
        />
      </PageHeader>

      <Card>
        <CardBody>
          <EmptyState
            icon={<Compass size={28} />}
            title="Nothing lives at this address"
            message={`The link may be old, or a name may be misspelled. Everything in ${SERVER_NAME} is one of these two doors away.`}
          />

          <div className="flex flex-wrap items-center justify-center gap-3 pb-6">
            <Link
              href="/players"
              className="gold-ring inline-flex items-center gap-2 rounded-md bg-gold px-5 py-3 font-display text-base tracking-wide text-night transition-colors hover:bg-gold-light"
            >
              <Users size={17} />
              The Vikings
            </Link>
            <Link
              href="/world"
              className="gold-ring inline-flex items-center gap-2 rounded-md border border-gold-dim/60 bg-gold/10 px-4 py-2.5 text-sm font-medium text-gold-light transition-colors hover:bg-gold/20"
            >
              <Globe2 size={15} />
              The World
            </Link>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
