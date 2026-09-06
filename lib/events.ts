// Shared presentation logic for the event feed — used by Home, Events, and World
// so every event renders with the same icon, color, and phrasing.
import {
  Skull,
  Swords,
  Crown,
  DoorOpen,
  DoorClosed,
  ShieldAlert,
  MessageSquare,
  Hammer,
  MapPin,
  type LucideIcon,
} from 'lucide-react';
import type { GameEvent, EventType } from './types';
import { describeDeath } from './episodes';

export interface EventPresentation {
  icon: LucideIcon;
  /** tailwind text color class for the icon/accent */
  accent: string;
  /** human label for the event type (for filters etc.) */
  label: string;
  /** full sentence describing what happened */
  description: string;
}

export const EVENT_FILTERS: { key: string; label: string; types: EventType[] }[] = [
  { key: 'all', label: 'All', types: [] },
  { key: 'death', label: 'Deaths', types: ['death'] },
  { key: 'boss', label: 'Boss Kills', types: ['boss'] },
  { key: 'session', label: 'Joins & Leaves', types: ['join', 'leave'] },
  { key: 'raid', label: 'Raids', types: ['raid'] },
  // No 'Chat' pill: shouted chat is mirrored to Discord and stored in
  // `chat_lines`, never in `events`, so the filter could only ever show 0.
];

function str(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function describeEvent(e: GameEvent): EventPresentation {
  const name = e.character_name ?? 'A viking';
  const meta = e.metadata ?? {};

  switch (e.type) {
    case 'death': {
      const cause = str(meta, 'cause');
      return {
        icon: Skull,
        accent: 'text-death',
        label: 'Death',
        description: describeDeath(name, cause ?? ''),
      };
    }
    case 'boss': {
      const boss = str(meta, 'boss') ?? 'A boss';
      const players = str(meta, 'players');
      return {
        icon: Crown,
        accent: 'text-gold-light',
        label: 'Boss Kill',
        description: players
          ? `${boss} was felled by ${players}`
          : `${boss} was felled`,
      };
    }
    case 'raid': {
      const event = str(meta, 'event') ?? 'A raid is underway';
      return { icon: ShieldAlert, accent: 'text-raid', label: 'Raid', description: event };
    }
    case 'join':
      return { icon: DoorOpen, accent: 'text-online', label: 'Join', description: `${name} entered the realm` };
    case 'leave':
      return { icon: DoorClosed, accent: 'text-muted', label: 'Leave', description: `${name} left the realm` };
    case 'chat': {
      const msg = str(meta, 'message') ?? '';
      return { icon: MessageSquare, accent: 'text-frost', label: 'Chat', description: `${name}: ${msg}` };
    }
    case 'milestone': {
      // Collective milestone. Player-facing name is "Great Deed" everywhere: the
      // /world headings, the Hall card, the in-game [board:deeds] sign
      // (lib/boards.ts) and the bot embed (services/discord-bot/src/milestones.js).
      // Only the DB table and the event type keep the older `milestone` name.
      const title = str(meta, 'title') ?? 'A great deed';
      const line = str(meta, 'line');
      // Colon and full stop, never an em dash: no em/en dashes in player-facing
      // text (CLAUDE.md copy doctrine). This description renders on /events and,
      // for a deed inside the recent window, on the Hall's Recent Saga card.
      return {
        icon: Crown,
        accent: 'text-gold-light',
        label: 'Great Deed',
        description: line ? `${title}: ${line}` : `${title}. A great deed achieved together.`,
      };
    }
    case 'craft': {
      const item = str(meta, 'item') ?? 'something';
      return { icon: Hammer, accent: 'text-ash-dim', label: 'Craft', description: `${name} crafted ${item}` };
    }
    case 'discovery': {
      const place = str(meta, 'biome') ?? str(meta, 'place') ?? 'new lands';
      return { icon: MapPin, accent: 'text-frost', label: 'Discovery', description: `${name} discovered ${place}` };
    }
    default:
      // Colon, not an em dash (CLAUDE.md copy doctrine).
      return { icon: Swords, accent: 'text-ash-dim', label: e.type, description: `${name}: ${e.type}` };
  }
}
