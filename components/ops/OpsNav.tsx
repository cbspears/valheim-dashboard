// The cockpit tab bar. A Server Component: it renders links and nothing else,
// so it costs no client JavaScript on any of the five pages that mount it.
//
// WHY A PROP AND NOT usePathname(). Marking this 'use client' just to know which
// tab is active would pull it, clsx and the icon set into every cockpit page's
// browser bundle for a piece of chrome that never changes after paint. Each page
// already knows which page it is, so it says so.
//
// EVERY PAGE MOUNTS THIS AS ITS FIRST ELEMENT. That is the whole navigation
// model for /admin/ops. There is deliberately no link to the cockpit from the
// public site, and the login page does not mount the nav (there is nothing to
// navigate to until the cookie is valid).

import Link from 'next/link';
import { clsx } from 'clsx';
import { Activity, ListChecks, CalendarClock, Gauge, Network } from 'lucide-react';

export type OpsTab = 'overview' | 'activity' | 'horizon' | 'performance' | 'architecture';

interface TabDef {
  id: OpsTab;
  href: string;
  label: string;
  /** One line, shown under the active tab and as the link title attribute. */
  hint: string;
  Icon: typeof Activity;
}

const TABS: TabDef[] = [
  {
    id: 'overview',
    href: '/admin/ops',
    label: 'Overview',
    hint: 'What is running right now, and what has drifted.',
    Icon: Activity,
  },
  {
    id: 'activity',
    href: '/admin/ops/activity',
    label: 'What fired',
    hint: 'Everything the pipeline did, last 24 h and last 7 d.',
    Icon: ListChecks,
  },
  {
    id: 'horizon',
    href: '/admin/ops/horizon',
    label: 'Coming up',
    hint: 'What is scheduled, queued, or close to firing.',
    Icon: CalendarClock,
  },
  {
    id: 'performance',
    href: '/admin/ops/performance',
    label: 'Performance',
    hint: 'Pipeline delay, announce latency, and the free-plan budget.',
    Icon: Gauge,
  },
  {
    id: 'architecture',
    href: '/admin/ops/architecture',
    label: 'Architecture',
    hint: 'How every piece connects. Reference, not a live signal.',
    Icon: Network,
  },
];

export function OpsNav({ active }: { active: OpsTab }) {
  return (
    <nav aria-label="Operations sections" className="border-b border-rune">
      {/* The hint is the link's title attribute only. Every page already prints
          its own one-line subtitle under its heading, and printing the same
          sentence twice, two centimetres apart, reads as a rendering bug. */}
      <ul className="-mb-px flex flex-wrap gap-x-1 gap-y-0 overflow-x-auto">
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          return (
            <li key={tab.id}>
              <Link
                href={tab.href}
                title={tab.hint}
                aria-current={isActive ? 'page' : undefined}
                className={clsx(
                  'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition',
                  isActive
                    ? 'border-gold text-ash'
                    : 'border-transparent text-muted hover:border-rune-bright hover:text-ash-dim',
                )}
              >
                <tab.Icon size={15} aria-hidden="true" className={isActive ? 'text-gold' : ''} />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
