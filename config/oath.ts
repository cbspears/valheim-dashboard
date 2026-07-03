// The Oath — Session Zero charter for the Eilif warband.
//
// This is the doctrine every viking swears to before launch. It is content,
// not code: edit the wording here and the /oath page re-renders.
//
// ⚠️ CHARLIE: this is a first draft of the doctrine — FINALIZE THE WORDING
// before launch (tone, exact rules, the "Benson model" phrasing). The page
// reads this file directly; nothing else needs to change.

export interface OathClause {
  /** short carved-in-stone heading */
  title: string;
  /** one or two sentences in the saga voice */
  text: string;
}

export const OATH_CHARTER: {
  title: string;
  preamble: string;
  clauses: OathClause[];
  closing: string;
} = {
  title: 'The Oath of Eilif',
  preamble:
    'Before the first tree falls, we swear it together. These are not rules imposed from a high seat — they are the promises we make to one another, so that the tenth world is a saga we write as one warband, not ten lone wanderers. Read them. Mean them. Then set your mark below.',

  clauses: [
    {
      title: 'No forsaken one falls alone',
      text: 'No boss is hunted without the warband. We gather, we prepare, we sail together — every viking who wants to be there is there when a forsaken one goes down. Glory is shared or it is not glory.',
    },
    {
      title: 'The Sacred Night',
      text: 'Saturday is the Sacred Night — the one evening the whole warband keeps for the longship. Bosses, great builds, and the big pushes wait for it. Guard the night; the saga is written on it.',
    },
    {
      title: 'Equal shares — the Benson model',
      text: 'Loot is split fairly among those who sailed for it. What the raid earns, the raid divides — no hoarding the rare drop, no one viking walking off richer than the crew. Everyone leaves the deck equipped.',
    },
    {
      title: 'Never sail ahead of the longship',
      text: 'Bosses gate the frontier. We do not rush the next biome, farm the metal, or wake the next threat before the warband is ready together. Progress is a tide the whole crew rides — not a race.',
    },
    {
      title: 'The community chest gives and receives',
      text: 'The shared chest is the heart of the hall: take what you need, leave what you can spare. It is stocked in good faith and drawn from in good faith. A well-fed warband is a bold one.',
    },
    {
      title: 'Name what you find',
      text: 'Chart the world for those who come after. Pin the places worth remembering, name your discoveries, and record the tale — a saga unwritten is a saga lost.',
    },
  ],

  closing:
    'By this oath I sail with the warband of Eilif, and by this oath I am bound to it.',
};
