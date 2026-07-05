import { ImageResponse } from 'next/og';
import {
  getPlayersWithStats,
  getEventsSince,
} from '@/lib/data';
import { slugify } from '@/lib/slug';
import { epithetsFor } from '@/lib/epithets';
import { formatPlaytime, formatNumber } from '@/lib/format';
import type { GameEvent } from '@/lib/types';

export const alt = 'A viking of Eilif';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [roster, deaths] = await Promise.all([
    getPlayersWithStats(),
    getEventsSince(70, ['death']),
  ]);
  const viking = roster.find((p) => slugify(p.character_name) === slug);

  const name = viking?.character_name ?? 'Unknown Viking';
  // Roster-global unique titles — build every viking's causes (Treefoe is unique)
  // and pull this viking's entry so the OG card matches the site exactly.
  const causesByName = new Map<string, string[]>();
  for (const e of deaths as GameEvent[]) {
    const nm = e.character_name;
    if (!nm) continue;
    const cause = typeof e.metadata?.cause === 'string' ? (e.metadata.cause as string) : '';
    if (!cause) continue;
    const arr = causesByName.get(nm) ?? [];
    arr.push(cause);
    causesByName.set(nm, arr);
  }
  const epithet = viking
    ? epithetsFor(roster, { causesByName }).get(name)?.title ?? 'the Unknown'
    : 'the Unknown';

  const pairs = [
    ['Hours', formatPlaytime(viking?.total_playtime_minutes ?? 0)],
    ['Deaths', formatNumber(viking?.stats?.deaths ?? 0)],
    ['Kills', formatNumber(viking?.stats?.kills ?? 0)],
  ];

  const GOLD = '#c8952a';
  const GOLD_LIGHT = '#e8b84b';
  const ASH = '#e7dccb';
  const MUTED = '#6b7585';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background:
            'radial-gradient(1000px 500px at 78% -10%, rgba(200,149,42,0.16), transparent 60%), linear-gradient(160deg, #0d1420 0%, #06080c 100%)',
          padding: '72px 80px',
          fontFamily: 'Georgia, serif',
          color: ASH,
        }}
      >
        {/* Top: name + epithet */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: 30,
              letterSpacing: 6,
              textTransform: 'uppercase',
              color: MUTED,
              marginBottom: 18,
            }}
          >
            The Warband of Eilif
          </div>
          <div style={{ fontSize: 96, fontWeight: 700, lineHeight: 1.02, color: ASH }}>{name}</div>
          <div style={{ fontSize: 52, color: GOLD_LIGHT, marginTop: 12 }}>{epithet}</div>
        </div>

        {/* Bottom: stat pairs + footer */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: 72, marginBottom: 34 }}>
            {pairs.map(([label, value]) => (
              <div key={label} style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: 60, fontWeight: 700, color: ASH }}>{value}</div>
                <div
                  style={{
                    fontSize: 24,
                    letterSpacing: 4,
                    textTransform: 'uppercase',
                    color: MUTED,
                    marginTop: 4,
                  }}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              borderTop: '1px solid rgba(200,149,42,0.35)',
              paddingTop: 22,
              fontSize: 26,
              letterSpacing: 3,
              color: GOLD,
            }}
          >
            EILIF — The Cozy Canon Playthrough
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
