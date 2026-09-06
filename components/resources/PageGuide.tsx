import { Compass } from 'lucide-react';
import { Card, CardBody, SectionHeader } from '@/components/ui';
import { PageRow, isDoorPage } from '@/components/commands/RegistryRows';
import { SITE_PAGES } from '@/config/commands';

/**
 * What each page of this site is for, from `config/commands.ts` SITE_PAGES.
 *
 * This used to be the LAST group of the register, at the bottom of the longest
 * page on the site, which is the one place a first-timer would never reach it.
 * It is the best orientation content the site has and it is build-tested
 * against the real routes (scripts/commands-page.test.mjs), so it now opens
 * Resources instead of closing it.
 *
 * It renders SITE_PAGES directly rather than the `the-pages` section of
 * COMMAND_SECTIONS: the register still carries that section, because the
 * tripwire walks COMMAND_REGISTRY for sources and ids, but the page draws it
 * once, here, and the Commands half below skips it.
 */
export function PageGuide() {
  // Not SITE_PAGES.length. Three of the twelve entries are not pages of their
  // own: `/viking/<name>` and `/boss/<name>` are dynamic templates with no
  // single address behind them, and the oath wall is `/players#oaths`, a
  // section of the Vikings page since the fold on 2026-09-06. All three are
  // reached from inside another page, so the subtitle calls them rooms and
  // counts nine doors. One exported predicate decides it, so the count and the
  // rows cannot drift apart.
  const doors = SITE_PAGES.filter(isDoorPage).length;
  const rooms = SITE_PAGES.length - doors;

  return (
    <div>
      <SectionHeader
        title="What each page is for"
        subtitle={`${doors} doors off one hall, and ${rooms} rooms you reach from inside them. Take the one that answers your question.`}
        icon={<Compass size={22} />}
      />

      <Card>
        <CardBody>
          <ul>
            {SITE_PAGES.map((entry) => (
              <PageRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
