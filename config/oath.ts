// The Oath — Session Zero charter for the Eilif warband.
//
// The doctrine every viking swears to before launch. This is content, not
// code: edit the wording here and the /oath page re-renders. Clause titles
// state each rule plainly (clarity-first copy doctrine); the saga voice lives
// in the supporting text below them. Tune freely as the group's customs grow.

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
    'Before the first tree falls, we swear this together. These are not rules handed down from a high seat — they are the promises we make to each other, so the tenth world becomes one warband’s saga and not ten wanderers each going their own way. Read them, mean them, then set your mark below.',

  clauses: [
    {
      title: 'No boss falls without the warband',
      text: 'The Forsaken are hunted as a crew, never alone. We gather, we prepare, and we sail together, so every viking who wants to stand there when one falls can. The glory of a kill belongs to everyone who earned it.',
    },
    {
      title: 'Saturday is the warband’s night',
      text: 'Saturday is our Sacred Night — the one evening the whole crew keeps for the longship. The bosses, the great builds, and the big pushes happen then, so guard it when you can.',
    },
    {
      title: 'Equal shares',
      text: 'What the raid earns, the raid divides — fairly, among everyone who sailed for it. No hoarding the rare drop, no one viking walking off richer than the crew. We call it the Benson model: everyone leaves the deck equipped.',
    },
    {
      title: 'Nobody rushes ahead',
      text: 'The bosses gate the world, and we cross each threshold together. Don’t rush the next biome, farm the next metal, or wake the next threat before the warband is ready for it. We move at the pace of the whole crew.',
    },
    {
      title: 'The community chest',
      text: 'The shared chest is the heart of the hall: take what you need, leave what you can spare. It runs on good faith in both directions — a warband that pools its stores is a bolder one.',
    },
    {
      title: 'Name what you find',
      text: 'Chart the world for the vikings who come after you. Pin the places worth remembering, name what you discover, and record the tale while it is fresh — the map and the saga are only as good as what we bother to write down.',
    },
  ],

  closing:
    'By this oath I sail with the warband of Eilif, and to it I am bound.',
};
