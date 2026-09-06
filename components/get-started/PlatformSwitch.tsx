'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Monitor, Terminal, Laptop } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import {
  DEFAULT_PLATFORM,
  PLATFORMS,
  platformFromHash,
  readStoredPlatform,
  storePlatform,
  type PlatformChoice,
  type PlatformId,
} from '@/lib/get-started';

const ICONS: Record<PlatformId, ReactNode> = {
  windows: <Monitor size={16} />,
  linux: <Terminal size={16} />,
  mac: <Laptop size={16} />,
};

/* ── the chosen platform, as an external store ─────────────────────────────
   The choice lives in the browser, not in React: it is remembered across
   visits, so the first client render has to be able to disagree with the HTML
   the server sent. `useSyncExternalStore` is the one hook built for exactly
   that. It renders the server's answer during hydration, then re-reads and
   re-renders once, with no effect, no flash of the wrong platform, and no
   hydration warning.

   `chosen` holds the choice this tab is on: a click, or the platform an arriving
   link asked for. It wins over storage so that the chooser answers instantly
   even where localStorage refuses to save.

   A hash is LATCHED into `chosen` rather than re-read on every snapshot. Reading
   it live was a trap: `hashchange` fires on any in-page jump, and the moment a
   Mac reader followed the server card's own "See the fixes below" link the hash
   stopped saying mac, the snapshot fell back to storage, and the page quietly
   swapped itself to Windows instructions behind them. */

let chosen: PlatformChoice | null = null;
let hashRead = false;
const listeners = new Set<() => void>();

/** Take the platform an anchor asks for, once, and keep it for the session. */
function latchHash(): void {
  const fromHash = platformFromHash(window.location.hash);
  // Deliberately not written to storage: arriving on someone else's link should
  // not repaint this reader's own choice for every visit after it.
  if (fromHash) chosen = fromHash;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onHashChange = () => {
    // A later jump to a platform anchor still selects it; a jump to #trouble or
    // #once-you-are-in says nothing about the platform and changes nothing.
    latchHash();
    onChange();
  };
  // Another tab of the same page, and the reader's own back button.
  window.addEventListener('storage', onChange);
  window.addEventListener('hashchange', onHashChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
    window.removeEventListener('hashchange', onHashChange);
  };
}

function getSnapshot(): PlatformChoice {
  if (!hashRead) {
    hashRead = true;
    latchHash();
  }
  if (chosen) return chosen;
  return readStoredPlatform() ?? DEFAULT_PLATFORM;
}

/** What the server renders, and what the client renders while hydrating. */
function getServerSnapshot(): PlatformChoice {
  return DEFAULT_PLATFORM;
}

/** Record an explicit click, remember it, and wake every reader of the store. */
function choose(next: PlatformChoice): void {
  chosen = next;
  // storePlatform ignores 'all' on purpose, so leaving the escape hatch has the
  // reader's own platform to go back to.
  storePlatform(next);
  for (const notify of listeners) notify();
}

/**
 * Leave "show all platforms" for whichever single platform is remembered.
 *
 * The `!== 'all'` guard is for a reader whose browser still holds an 'all' that
 * an earlier build wrote: without it, closing the escape hatch would reopen it.
 */
function closeShowAll(): void {
  const stored = readStoredPlatform();
  choose(stored && stored !== 'all' ? stored : DEFAULT_PLATFORM);
}

/**
 * The platform chooser, and the only interactive thing on Get Started.
 *
 * It swaps steps one to four in place. Everything from the join onwards is the
 * same on every platform and is passed as `children`, so the spine stays one
 * spine: choosing Mac changes four step bodies, not the page.
 *
 * Deliberately small. It reads no data, loads no library, and holds one string
 * of state. The three step lists are rendered on the server and shipped in the
 * HTML; this only decides which of them is `hidden`, so nothing about the
 * instructions depends on the browser finishing its JavaScript.
 *
 * On a wide screen the chooser is a sticky rail beside the steps, which keeps
 * "you are reading the Windows path" on screen through all seven of them. Below
 * `lg` it collapses to a row of chips above the spine.
 */
export function PlatformSwitch({
  windows,
  linux,
  mac,
  children,
}: {
  windows: ReactNode;
  linux: ReactNode;
  mac: ReactNode;
  children: ReactNode;
}) {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const showAll = choice === 'all';
  const panels: { id: PlatformId; content: ReactNode }[] = [
    { id: 'windows', content: windows },
    { id: 'linux', content: linux },
    { id: 'mac', content: mac },
  ];

  return (
    <div className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-8">
      {/* ── the chooser ───────────────────────────────────────────────── */}
      <div className="mb-6 lg:mb-0">
        <div className="rounded-md border border-rune bg-surface-raised/40 p-3 lg:sticky lg:top-24">
          <p
            id="platform-chooser-label"
            className="mb-2 text-xs uppercase tracking-wider text-muted"
          >
            Your computer
          </p>
          <div
            role="group"
            aria-labelledby="platform-chooser-label"
            className="flex flex-wrap gap-2 lg:flex-col"
          >
            {PLATFORMS.map((p) => {
              const active = choice === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => choose(p.id)}
                  aria-pressed={active}
                  aria-controls={`steps-${p.id}`}
                  className={clsx(
                    'gold-ring inline-flex items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm font-medium transition-colors lg:w-full',
                    active
                      ? 'border-gold-dim bg-gold/15 text-gold-light'
                      : 'border-rune bg-surface text-ash-dim hover:border-gold-dim/60 hover:text-ash',
                  )}
                >
                  <span aria-hidden className={active ? 'text-gold' : 'text-muted'}>
                    {ICONS[p.id]}
                  </span>
                  {/* The whole name at every width, and no aria-label over it,
                      so what the button says and what it is called are the same
                      string. The short form ("Linux / Deck" against a name of
                      "Linux and Steam Deck") failed WCAG 2.5.3: a voice-control
                      user could read the button and not be able to say it. */}
                  {p.name}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => (showAll ? closeShowAll() : choose('all'))}
            className="gold-ring prose-link mt-2.5 rounded text-xs text-gold-light"
          >
            {showAll ? 'Show one platform' : 'Show all platforms'}
          </button>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {showAll
              ? 'Every path at once. Follow the one that matches your computer.'
              : 'Steps 1 to 4 change with your computer. Steps 5 to 7 are the same for everyone.'}
          </p>
        </div>
      </div>

      {/* ── the steps ─────────────────────────────────────────────────── */}
      <Card>
        <CardBody>
          {panels.map(({ id, content }) => {
            const p = PLATFORMS.find((x) => x.id === id);
            const name = p ? p.name : id;
            return (
              <section
                key={id}
                id={`steps-${id}`}
                data-platform-panel
                hidden={!showAll && choice !== id}
                aria-label={`Steps 1 to 4 on ${name}`}
              >
                {showAll && (
                  <p className="mb-4 flex items-center gap-2 border-b border-rune pb-2 font-display text-base tracking-wide text-gold-light">
                    <span aria-hidden className="text-gold">
                      {ICONS[id]}
                    </span>
                    {name}
                  </p>
                )}
                {content}
              </section>
            );
          })}
          {children}
        </CardBody>
      </Card>
    </div>
  );
}
