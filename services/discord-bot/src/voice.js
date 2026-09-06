// The Voice of the Hall — Eilif's brain.
//
// A server-side game plugin polls GET /api/voice and SPEAKS queued lines
// in-game as "Eilif". THIS module decides what gets queued and when, writing
// rows to the `voice_lines` table (service-role). It is a presence, not a
// chatterbox.
//
// Pacing model (Charlie's decisions, 2026-08-22):
//   • AMBIENT (atmosphere + death callback + oath callback) — one line per ~2
//     HOURS of someone-online time, AND never within VOICE_MIN_GAP_MS (default
//     30 min) of the most recent voice line of ANY kind. Never to an empty
//     hall. Roughly one ambient line in four reads a sworn oath back to the
//     viking who swore it, whenever one of them is online to hear it.
//   • WHISPERS ON QUIET NIGHTS — not extra volume: when the ambient slot fires
//     to a nearly-empty hall (exactly 1 viking online, or 2–3 with no `events`
//     row in the last 45 minutes), the ambient POOL is swapped for a closer,
//     spookier one that says a viking's name. Same clock, same gap.
//   • DAWN — a special ambient class on its own clock: once on every 3rd world
//     day (worldDay % 3 === 0), only while players are online. NOT on the 2h
//     clock and NOT subject to the 30-minute gap. Most dawn lines name Eilif so
//     players can tell these are custom, not vanilla.
//   • EVENTS — per-player death milestones, in-game oath echoes, the evening
//     POTY crown, admin `@Eilif say:` lines: EXEMPT from every gap. Great Deeds
//     and title proclamations are queued by milestones.js / titles.js at their
//     own announce moment (also exempt).
//
// Retired here: the warband-every-50th-death line (now per-player tiers) and
// first-biome discovery welcomes (removed entirely).
//
// Voice matches the saga register of format.js — evocative, dry, never
// mechanical, and never an echo of vanilla Valheim's own on-screen text.
// Gated behind VOICE_ENGINE=1 (see index.js), like GALLERY_INGEST.

import { serviceClient } from './supabase.js';
import { causeNoun, clipChars, defangLinks, nameMd, safeText } from './format.js';
import { MENTION_STRICT } from './discord.js';

const TICK_MS = 60_000;                 // the caller ticks us every 60s
const CADENCE_MINUTES = 120;            // one ambient line per ~2h online-time
const STALE_MS = 24 * 3600 * 1000;      // queued-but-unspoken lines expire after 24h
const POTY_STALE_MS = 3 * 3600 * 1000;  // the crown says "tonight": 3h and it is stale
const RECENT_KEEP = 5;                  // no template repeats within its last 5 uses
const DEFAULT_MIN_GAP_MS = 1_800_000;   // VOICE_MIN_GAP_MS default — ambient only
const DAWN_EVERY_DAYS = 3;              // dawn line on every 3rd world day
const DEATH_TIER_STEP = 100;            // after 100, a tier every +100 deaths
const WHISPER_CREW_MAX = 3;             // 2..3 online = a quiet crew
const WHISPER_QUIET_MS = 45 * 60_000;   // "nothing eventful" window for the crew whisper
const OATH_QUOTE_MAX = 90;              // characters of a shouted oath Eilif repeats
const OATH_AMBIENT_SHARE = 0.25;        // ~1 ambient line in 4 is an oath callback

// ── Content bank (saga register — match format.js) ────────────────────────

// (a) Dawn — a special ambient class, once every 3rd world day. {day} rides in.
// Most of these name Eilif: the hall should sound like it knows its own name.
export const DAWN = [
  'Day {day} over Eilif. The mist never lifted, and neither did we.',
  'Dawn on day {day}. Eilif counted the hearths still burning and got the same number as last night. Good.',
  'Day {day}. Eilif has kept the roof on this long. The rest is your business.',
  'Light comes back to Eilif on day {day}, and so do the things that hunt in it.',
  'Day {day}. Eilif marks who rises first and says nothing about who does not.',
  'Another dawn on Eilif, day {day}. The mead survived the night.',
  'Day {day}. Eilif has seen worse mornings, though not lately.',
  // Expanded 2026-09-06 for launch: the bank below is the new writing.
  'Day {day}. Frost on the grass, and one set of tracks through it that Eilif does not know.',
  'The fog sits in the low ground on day {day}, waiting to be invited up. Eilif has not invited it.',
  'Day {day}. The sky is clean for once. Eilif takes a clean sky as a debt, not a gift.',
  'Day {day}. The wind came around to the north before first light. Bring a cloak and bring a plan.',
  'Smoke stands straight up over Eilif on day {day}. No wind, no weather, no excuses.',
  'Sun on the snow, day {day}. A fine sight, and it will show your tracks to everything with a nose.',
  'Cold and clear on day {day}. Eilif can see three days of weather coming and none of it is kind.',
  'Day {day}. The frost broke overnight and the land smells of thaw and rot. Eilif calls both of them honest.',
  'Low cloud on day {day} and the mountain has gone missing again. Eilif has never known it to stay gone.',
  'Day {day}. A raven has sat on the gatepost since first light. Eilif did not ask what it is waiting for.',
  'The howling stopped when the light came on day {day}. Eilif finds that worse than the howling.',
  'The rain stopped at dawn on day {day}, as if something wanted a clear look at you.',
  'Day {day}. Eilif smelled woodsmoke from the north before the sun. Not our smoke.',
  'Deer at the edge of the meadow on day {day}, unbothered. That tells you where the wolves are not.',
  'Day {day}. The sun is up, and every shadow it makes belongs to something.',
  'Wet boots by the door on day {day}, and all of them in pairs. Eilif opens the morning content enough.',
  'Day {day}. Eilif took the measure of the night: one broken cup, one snapped bowstring, no widows.',
  'Dead greylings by the gate on day {day}. Eilif counted them and drew its own conclusions.',
  'Salt crust on the longship rail, day {day}. She came home wet and she came home. Eilif counts both.',
  'Day {day}. Somebody sang half an oath at the longfire and fell asleep. Eilif remembers the half.',
  "First light on day {day}. Somebody's shield is still by the fire. Somebody is going out without it.",
  'Frost reached inside the hall on day {day}. Eilif suggests more wood and fewer plans.',
  'Day {day}. The mist is up to the knee and the gate is a rumor. Walk slowly and walk together.',
  'Eilif marks day {day}: no new graves, no new gaps in the roster. The saga can wait a morning.',
  'Day {day}. Nothing burned down while you slept. Eilif suspects that is the high point already.',
  'Eilif has watched {day} dawns over this land. The land has not once looked grateful.',
  'Eilif has held these stones {day} days and has yet to hear a promise it fully believes.',
  'New light, old land, and the same hungry dark beneath it. Eilif welcomes you to day {day}.',
  'The wind is down, the sea is quiet, and nothing tried the gate. Eilif marks it day {day}.',
  'Eilif has a roof, a fire, and a warband that keeps coming back through the door. That is the whole of day {day}.',
  'Day {day}. The light comes thinner than it did. Eilif has watched enough mornings to be sure of it.',
];

// (b) Pure atmosphere — no data, just weather in the bones.
export const ATMOSPHERE = [
  'Pine smoke and cold salt on the wind. Eilif has never worked out whether that means anything.',
  'Something large turned over in its sleep out past the fog. Leave it where it lies.',
  'The mead is warm and the trolls are only mostly asleep.',
  'A raven circled the hall three times, then thought better of it.',
  'Eilif creaks like an old ship at anchor. It remembers everyone who ever leaned on these walls.',
  'Rain on the roof and wolves at the treeline. The realm keeps its own counsel tonight.',
  'The forge has gone cold, but the coals are still muttering about the blades to come.',
  'Out on the black water the serpents wait, patient as a grudge.',
  'Every oath sworn at this longfire goes into the stones. Stone is patient about that sort of thing.',
  'Quiet in the hall. That usually means a good story or a bad death is on its way.',
  // Expanded 2026-09-06 for launch: the bank below is the new writing.
  'Eilif settles at night. Old timber does that. Old halls do it for other reasons.',
  'There is a draft in here that comes through no door anyone cut. Eilif has stopped hunting for it.',
  'The floorboards remember where the heavy ones stand. Eilif reads them like a ledger.',
  'Something has been nesting in the thatch all season. Eilif has decided it may stay.',
  'Eilif is warm tonight. That took work from somebody, and the hall knows which somebody.',
  'A hall is only a fire with walls around it. Keep the fire.',
  'Nine halls came before this one. They are all quiet now. Eilif is the tenth.',
  'There is a cold spot near the north wall. There has always been a cold spot near the north wall.',
  'There is a sound the hall makes before a hard night. Eilif is not making it. Yet.',
  'Eilif does not sleep. Eilif dims.',
  'Eilif watches the door more than it watches the fire. Habit.',
  'Every stone in this wall was carried here by somebody. Most of them are gone now. The wall is not.',
  'The trees went quiet a moment ago. Eilif noticed. You should have too.',
  'Something in the Black Forest stopped moving when you did.',
  'Every greydwarf out there knows exactly where the light is. That is what light is for.',
  'The forest does not hate the warband. It only has more patience than the warband has.',
  'The far hills went dark all at once, as if something walked in front of them.',
  'The tide is out and the shore smells of old iron. Eilif has never liked that smell.',
  'The gulls went inland this morning. Sailors used to know what that meant.',
  'The sea keeps everything it takes and shows you none of it back.',
  'Iron never forgives a rushed quench. Eilif has seen the blades that prove it.',
  'Bellows and sparks going up through the smoke hole. A good sound to grow old beside.',
  'Munin remembers what you did last winter. Munin remembers all of it. That is his trouble.',
  'A raven landed on the woodpile and stayed. Eilif is not superstitious. Eilif is careful.',
  'The Valkyries have nothing to do tonight. Try to keep it that way.',
  'Odin keeps a tally and never shows it. That is the whole cruelty of him.',
  'The gods do not love the bold. They only watch the bold for longer.',
  'The mead barrel is lighter than it was this morning. Nobody is a suspect and everybody is.',
  'Eat before you go out. Eilif has buried plenty who meant to eat later.',
  'Sit down. The realm will still be trying to kill you in ten minutes.',
  'Somewhere in the Deep North the eighth of the Forsaken has not been introduced to anybody yet.',
  'Smoke, salt pork, wet boots by the fire. Some evenings the realm just lets you have it.',
  'The hall is loud tonight and Eilif would not trade it for a quiet one.',
  'Long night ahead. The wood is stacked, the door is barred, and the dark can do its work outside.',
  'There is bread rising by the coals and a serpent somewhere in the bay. Both are true at once.',
  'The fog came off the water and has not moved since. Fog usually moves.',
  'There are shapes in the mist that keep the same distance however fast you walk.',
  'Something walked the treeline twice and came no closer. Eilif finds the second pass worse.',
  'Something in the Mistlands sings a note too low to hear and everyone hears it.',
  'Eilif has never once been surprised by a troll. Eilif has been surprised by vikings constantly.',
  'Frost in the low grass. Winter is trying the latch.',
  'Thunder somewhere behind the mountains. Not our storm. Not yet.',
  'Clear sky, hard cold, every star showing. A beautiful night to die stupidly under.',
  'Sun through the smoke hole and the dust turning in it. Eilif keeps a few hours like this one.',
  'The wind found a new gap in the shutters and is bragging about it.',
  'Eilif keeps a corner for the ones who did not come back. Not a large corner. Not a small one.',
  'The ground here takes a body easily. Loose soil. That is all Eilif means by it.',
  'Somewhere a stone is standing in the rain with your name on it and your good axe beneath.',
  "The saga of this warband is mostly other people's bad ideas and Eilif is fond of it.",
  'Somewhere a skeleton is standing in a burial chamber exactly where it stood a thousand years ago.',
  'The gate is standing open. Eilif will assume that was deliberate.',
  'Torches burn down faster when no one is watching them. Eilif has tested this.',
  'The bees are working. Nobody ever thanks the bees.',
  'Haldor is out there somewhere in the dark, counting coin and afraid of nothing.',
  'Deathsquitos do not hum until they are close. Consider that a courtesy or do not.',
  'Fulings shout at each other all night in the tall grass. They are not shouting at each other.',
  'The lox in the plains have never once been afraid. Learn from them or learn from the ground.',
  'Necks come up on the shore at night to watch the fires. They want nothing. That is worse.',
  'Moths came to the light and something came for the moths.',
  'A lantern is moving on the far ridge. Nobody in this hall is on the far ridge.',
];

// (c) Callbacks — dated deaths from ~1/2/4 weeks ago, phrased darkly. {span}
// is the time-ago label ("a week ago", and every label ends the same way so it
// reads in any of these sentences), {name}/{cause} come from the archived
// event. {cause} is always a NOUN PHRASE (causeNoun, plus findCallbackEvent's
// fallback) so it can sit inside a sentence without breaking the grammar.
export const CALLBACK_TEMPLATES = [
  '{Span} tonight, {name} was taken by {cause}. The hall marked it and got on with the evening.',
  '{Span} this hall lost {name} to {cause}. A saga is only the deaths we bother to tell twice.',
  'Raise a horn for {name}, who fell to {cause} {span}. The ravens ate well that night.',
  'It was {span} that {cause} put {name} in the ground. The gods keep a stool warm for the bold. The careless get a cold one.',
  // Expanded 2026-09-06 for launch: the bank below is the new writing.
  '{Span} Eilif wrote {name} into the ledger and {cause} beside it. The ink dried. Nothing else changed.',
  '{Span} to the hour, {cause} had {name}. Eilif brings it up now because the hour is right.',
  'Eilif counted {name} among the living {span}. Then {cause} took the count down by one.',
  'Two things happened {span}. {name} ended, and {cause} did not. Eilif has trouble with the second half.',
  '{Span} {name} was swearing oaths at this longfire, and {cause} answered. Eilif keeps both on one page.',
  'Hugin remembers {name}. Munin remembers {cause}. Between them they make {span} feel like this morning.',
  '{Span} this floor was scrubbed on account of {name} and {cause}. It came up clean. It always does.',
  '{name} met {cause} {span} and lost. The saga gives it four words. Eilif remembers the longer version.',
  'Eilif has stood through worse than {cause}. {name} did not get the chance. That was {span}.',
  'The warband forgot {name} inside three days. It was {span}, by way of {cause}. Eilif did not forget.',
  'Some nights the hall brings up {name} unasked. Tonight is one. It was {cause}, and it was {span}.',
  '{Span} {cause} took {name}. The wind tonight smells the same. Eilif is not saying that means anything.',
  'Witnesses still argue over how {cause} got {name}, and that was only {span}. Eilif does not argue.',
  '{name} was lost to {cause} {span}. Eilif has never called that bad luck. Eilif calls it the land.',
  'No one has said {name} aloud since the night {cause} won, {span}. Eilif says it now. Halls are for that.',
];

// (d) Whispers on quiet nights — the ambient pool SWAP for a near-empty hall.
// SOLO: exactly one viking online. Second person, spooky-cozy, names them.
export const SOLO_WHISPERS = [
  'You are alone in Eilif tonight, {firstName}. Probably.',
  'Just you and the wind out here, {firstName}. One of you is being watched, and it is not the wind.',
  'Odin sees you, {firstName}. He has always seen you. He thinks the roof pitch is bold.',
  'Nobody else came tonight, {firstName}. Something did. It is keeping its distance for now.',
  'The hall counts one heartbeat, {firstName}, and two sets of footsteps.',
  'Work while it is quiet, {firstName}. The dark only ever lends quiet out.',
  // Expanded 2026-09-06 for launch: the bank below is the new writing.
  'The benches are empty tonight, {firstName}. Eilif kept your seat warm and let the rest go cold.',
  'Eilif hears one axe working in the dark, {firstName}. It is a small sound. It carries further than you would like.',
  'Bar the door, {firstName}. Not because Eilif is worried. Because Eilif is thorough.',
  'The hall is yours tonight, {firstName}. So is every creak in it.',
  'You are the only warm thing for a long way, {firstName}. The cold has noticed.',
  'Eilif marks you awake and alone, {firstName}, and marks the hour, in case anyone asks after.',
  'Sleep is cheaper than a funeral, {firstName}. Eilif offers both and recommends the bed.',
  'The pot is still warm, {firstName}. Eat before you go out. The dark will keep.',
  'Eilif has stood empty for whole seasons, {firstName}. By that measure you are a crowd.',
  'You could go to bed, {firstName}. You will not. Eilif has met your kind of tired before.',
  'Nothing in this hall will hurt you, {firstName}. Eilif makes no promises about the yard.',
  'A neck is croaking down at the water, {firstName}. That is the whole of the news. Eilif thought you should have some.',
  'The wind found a gap in the wall tonight, {firstName}. Patch it in the morning. Let it sing until then.',
  'Eilif has seen vikings do their finest work alone, {firstName}. Eilif has buried a few of those as well.',
  'A torch burns on the far wall, {firstName}. You did not light that one. Eilif has been watching all evening.',
  'Your boar is asleep, {firstName}. Your bees are asleep. Something out past the fence is not.',
  'Alone is only dangerous when you forget that you are, {firstName}. You have not forgotten. Not yet.',
  'Bring a torch and a friend, the old rule says, {firstName}. You brought a torch.',
  'A raven sat on the ridgepole all evening, {firstName}, and left the moment you looked up.',
  'This is how most sagas open, {firstName}. One viking, one fire, and something walking around outside.',
  'You built this place in the daylight, {firstName}. Tonight you learn how well.',
  'Something out there breathed, {firstName}. Or the wind did. Eilif is not going to go and look.',
  'Take the long way home tonight, {firstName}, and the dark comes along for all of it.',
  'Yours is the only name in the hall tonight, {firstName}. Eilif says it aloud so the walls learn it.',
  'You went still for a moment there, {firstName}. So did something else.',
  'Wolves are up in the hills tonight, {firstName}. They are not close. They are not far either.',
  'Put your back to a wall, {firstName}. Eilif has plenty of them and charges nothing.',
  'Your shadow moved before you did, {firstName}. That will be the torchlight. Eilif is fairly certain.',
];

// QUIET CREW: 2–3 online and nothing eventful in the last 45 minutes. Some of
// these name a viking; some let the whole crew feel watched.
export const CREW_WHISPERS = [
  'No deeds tonight. Just work and the dark and whatever is counting you from the treeline.',
  'Odin is watching the hall tonight, {firstName}. You in particular.',
  'Heads down, hammers busy. The ravens take notes on the quiet ones.',
  'A small crew and a long night. Eilif has known both to end well, though not often.',
  'Nothing has gone wrong yet, {firstName}. Eilif finds that suspicious.',
  'Torchlight only reaches so far. Past it, something has been very patient tonight.',
  // Expanded 2026-09-06 for launch: the bank below is the new writing.
  'Nobody has screamed in an hour. Eilif cannot tell if that is progress or a held breath.',
  'Small work, small crew. Sagas rarely mention the roof, but the roof is why anyone lived to be mentioned.',
  'A quiet night is when the hall gets built. The loud ones are when it gets tested.',
  'Somebody is sorting a chest. Eilif finds that more heroic than most of what happens here.',
  'Eilif keeps a page for tonight. So far it is empty. That is the best kind of page.',
  'Hugin came in from the cold and said nothing. Munin is still out there, and Munin is the one who remembers.',
  'A greydwarf came to the edge of the light, looked at the work, and went back into the dark.',
  'Stew on the fire and nothing trying to eat you. Eilif calls that a fine hour.',
  'The boars are asleep and the crops are slow. From the inside, this is what winning looks like.',
  'Nobody has walked back for their gear tonight. Eilif notices the missing walk.',
  'The hammers stop, and for a moment the hall listens back. Then it goes back to pretending.',
  'Eilif has known bigger warbands who did less in a loud week than this handful does in silence.',
  'The fog sat down at the edge of the field and has not moved. Neither has whatever brought it.',
  'Quiet is not peace. Quiet is the realm holding its tongue, {firstName}.',
  'Sharpen something while it is quiet, {firstName}. A dull edge is a slow way of choosing how you die.',
  'A raven has sat on the ridgepole for an hour, {firstName}. It is not waiting for crumbs.',
  'The trees have been very still, {firstName}. Trees are only still when something else is moving.',
  'No one has a tale yet, {firstName}. Eilif will wait. Eilif is very good at waiting.',
  'The mead is going slowly tonight, {firstName}. That is either discipline or dread.',
  'The longship is tied and dry, {firstName}. Eilif has known it to be neither.',
  'It is late enough that mistakes start getting interesting, {firstName}.',
  'Whatever you are building, {firstName}, build it a door that shuts.',
  'A short crew is a careful crew. Careful earns a second night, {firstName}.',
  'Eilif counts the boots by the door and comes up short, {firstName}. The hall does not mind. Eilif does.',
  'Every board you set tonight, {firstName}, is a board the dark has to get through later.',
  'Eilif does not need many of you, {firstName}. Eilif needs the fire kept and the horns full.',
];

// (e) Per-player death milestones — tiers at 20, 50, 100, then every +100.
// {name} is the first name, {count} the death total at the tier.
export const DEATH_LINES = {
  20: 'Twenty deaths for {name}. Eilif keeps the count, and {name} keeps getting back up.',
  50: 'Fifty deaths for {name}. The ravens know that name by heart and still it walks back in through the door.',
  100: 'One hundred deaths, {name}. Eilif stopped flinching somewhere around sixty.',
  next: '{count} deaths, {name}. Eilif has stopped being surprised. The ink holds out anyway.',
};

// (f) Oath echo — spoken in-game the moment a shouted `/oath` is captured.
// {firstName} is the swearer, {oath} the shout itself: lower-cased, stripped of
// markdown and control characters, clipped and already wrapped in quotes by
// oathQuote() below. The Discord cross-post is unchanged.
export const OATH_ECHO_LINES = [
  'Eilif has your words now, {firstName}: {oath}. Eilif does not give words back.',
  'The ravens lifted off the moment you said it, {firstName}. {oath} is already north.',
  'So be it, {firstName}. {oath}, sworn out loud, with the whole hall listening.',
  'Eilif adds a line to the saga, {firstName}: {oath}. Ink does not care whether you meant it.',
  'Odin heard that, {firstName}. {oath}. He has better hearing than the rest of us.',
  'That is an oath, {firstName}, not a plan. {oath}. Eilif will watch which it becomes.',
  'Sworn and set, {firstName}. {oath} belongs to the warband now, not to you.',
  'There. It is out of your mouth and into the hall, {firstName}: {oath}.',
  'Eilif has heard vows and Eilif has heard boasts, {firstName}. Yours reads {oath}. Time sorts them.',
  'Eilif seals it, {firstName}: {oath}. Undoing an oath here costs more than swearing one.',
];

// (g) Oath callbacks — an AMBIENT class alongside atmosphere and callbacks:
// an oath a viking who is ONLINE RIGHT NOW swore, read back to them later.
// {firstName} and {oath} as above; {days} is whole days since sworn_at, so the
// three templates that use it are dropped when the row has no usable date.
export const OATH_CALLBACKS = [
  'Hugin carried it north and Munin carried it back. {firstName} swore {oath}.',
  'The gods keep a ledger, {firstName}, and one line of it is yours: {oath}.',
  'You said {oath}, {firstName}. The longfire heard you. Fire keeps nothing to itself.',
  'Eilif has buried vikings with lighter oaths than yours, {firstName}. You swore {oath}.',
  'The warband heard you swear {oath}, {firstName}. The warband is not known for letting things go.',
  'Eilif marks the oath of {firstName}: {oath}. Marked is not the same as kept.',
  'You swore {oath}, {firstName}. Eilif is patient. Eilif is also counting.',
  'A vow does not rot, {firstName}. Yours still reads {oath}.',
  'Odin is in no hurry, {firstName}. He is still waiting on {oath}.',
  'The Valkyries remember it word for word, {firstName}. You swore {oath}.',
  'Eilif has no opinion on {oath}, {firstName}. Eilif only remembers that you swore it.',
  'Say it again if you like, {firstName}. Eilif already has it: {oath}.',
  'You swore {oath}, {firstName}. Nobody made you say it.',
  'It has been {days} days since {firstName} swore {oath}. Not one of them loosened it.',
  'Eilif has held {oath} for {days} days, {firstName}. It weighs what it weighed that night.',
  'Two things in these walls never sleep, {firstName}. One is your oath: {oath}.',
  'Wind has taken the thatch twice since, {firstName}. It has not taken {oath}.',
  'Even the greydwarfs at the treeline know it by now, {firstName}. You swore {oath}.',
  'Some vows are load bearing, {firstName}. Eilif keeps yours in the wall: {oath}.',
  'The mead wore off long ago, {firstName}. What you swore did not: {oath}.',
  'The saga has your name once so far, {firstName}, beside {oath}. There is room for more.',
  'Nine worlds came before this one, {firstName}. In this one you swore {oath}.',
  'Eilif carved it where the smoke cannot reach, {firstName}: {oath}.',
  'You swore {oath}, {firstName}. Eilif does not ask how it is going.',
  "The oath is yours, {firstName}. The remembering is Eilif's work: {oath}.",
];

// (h) THE OFFICE AND THE ALTAR. Three small pools that this engine never picks
// from itself: they belong to the Storyteller of Eilif and to the boss-altar
// tellings, and both of those live in their own modules behind their own flags
// (services/discord-bot/src/storyteller.js, STORYTELLER=1; src/altar.js,
// ALTAR_TELLINGS=1). They are HERE so that every line the hall can hear sits in
// one file and is swept by one doctrine test, rather than scattered across
// whichever module happened to need it.
//
// Each is filled and then spoken center-screen, so the same 150-character
// ceiling the rest of this bank keeps applies to all three (scripts/
// storyteller.test.mjs and scripts/altar.test.mjs check them filled).

// (h1) The proclamation, spoken to the WHOLE hall the moment a Storyteller is
// installed, by vote or by name. {firstName} is the new holder.
export const STORYTELLER_PROCLAIM_LINES = [
  'By the voice of the hall, {firstName} is named Storyteller. The tales are theirs to keep.',
  'The hall has spoken. {firstName} keeps the tales of Eilif from this night on.',
  "{firstName} takes the Storyteller's seat. What the warband does, {firstName} sets down.",
  'Eilif hands the tales to {firstName}. Ink is heavier than it looks.',
  'The office falls to {firstName}. Every fall of a forsaken now waits on a telling.',
  'Hear it. {firstName} is Storyteller of Eilif, and the saga answers to them.',
];

// (h2) The nudge, spoken to the STORYTELLER ALONE about a boss nobody has told.
// Second person throughout, so it is queued only when the plugin can aim a line
// at one peer (VOICE_TARGETING=1); with targeting off, storyteller.js sends the
// Discord half and no voice line at all. {boss} is the untold forsaken.
export const STORYTELLER_NUDGE_LINES = [
  'Storyteller, {boss} has fallen and no viking has told it. The page still shows the Skald.',
  '{boss} waits on you, Storyteller. Nobody has set that fight down yet.',
  'The fall of {boss} is untold, Storyteller. Eilif is patient and the page is bare.',
  'You keep the tales, Storyteller, and {boss} has none. Only the Skald has spoken for it.',
  'Eilif marks one gap in the saga: {boss}, untold. That one is yours, Storyteller.',
];

// (h3) The tail of an altar telling: the first sentence of the chosen telling is
// spoken at the altar where the boss fell, and one of these closes it and names
// who told it. {teller} is that viking, or the Skald.
export const ALTAR_TELLING_TAILS = [
  '{teller} tells the rest.',
  'So says {teller}, who was there.',
  'The rest of it belongs to {teller}.',
  '{teller} set the rest of it down.',
  'Ask {teller} for the rest of it.',
  'That is {teller} speaking. The rest is on the page.',
];

// ── tiny deterministic RNG (mulberry32) + string hash (mirrors format.js) ──
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || 'viking';

// Small, pure 31-multiplier string hash (mirrors format.js's own).
function hashStr(s) {
  let h = 0;
  const t = String(s);
  for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * A shouted oath, ready to sit inside a spoken line: collapsed to one line,
 * lower-cased, clipped to OATH_QUOTE_MAX with an ellipsis, and wrapped in
 * quotes. Returns '' when nothing usable survives, so callers can fall back.
 *
 * The same treatment safeText gives the Discord embed, with one difference:
 * markdown specials are REMOVED here, not escaped. This string is SPOKEN
 * in-game by the Companion, where an escape backslash is read out as a
 * backslash. Control characters go first (an oath is `oaths.oath_text`, which
 * lib/webhook/oath.ts only trims), then the specials, then the whitespace
 * collapse, and defangLinks last so a `https://…` shout cannot put a URL in
 * front of the hall.
 */
export function oathQuote(raw, max = OATH_QUOTE_MAX) {
  const stripped = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\\*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const clean = defangLinks(stripped).trim();
  if (!clean) return '';
  const body = clean.length > max ? `${clipChars(clean, max - 1)}\u2026` : clean;
  return `"${body}"`;
}

// Not every sworn string deserves to be read back. A one-word shout, or the
// crew's own "TEST OATH PLEASE IGNORE", is quoted by nobody. Kept deliberately
// narrow: the hall quotes jokes with a straight face, it only refuses junk.
const OATH_MIN_WORDS = 3;
const OATH_UNSPEAKABLE = /\btest oath\b|\bplease ignore\b|\bignore (this|me)\b/i;
export function speakableOath(raw) {
  const quoted = oathQuote(raw, 10_000);
  if (!quoted) return false;
  const body = quoted.slice(1, -1);
  if (OATH_UNSPEAKABLE.test(body)) return false;
  return body.split(/\s+/).filter(Boolean).length >= OATH_MIN_WORDS;
}

// Second-person oath callbacks ("You swore ...") are meant for the swearer's
// eyes; third-person ones are for the hall. Once the server plugin can aim a
// line at one peer (VOICE_TARGETING=1, set after the rebuild that ships it),
// the private ones carry meta.target and only that viking sees them. Until
// then every line is spoken to everyone, exactly like the whispers.
const SECOND_PERSON = /\b(you|your|yours|yourself)\b/i;
const targetingEnabled = () => process.env.VOICE_TARGETING === '1';

/** Highest death tier a total has crossed: 20, 50, 100, then every +100. 0 = none. */
export function deathTier(deaths) {
  const n = Math.floor(Number(deaths) || 0);
  if (n >= 100) return Math.floor(n / DEATH_TIER_STEP) * DEATH_TIER_STEP;
  if (n >= 50) return 50;
  if (n >= 20) return 20;
  return 0;
}

/** The line for a crossed death tier, with {name}/{count} filled in. */
export function deathMilestoneLine(tier, name) {
  const template = DEATH_LINES[tier] ?? DEATH_LINES.next;
  return template.replace(/\{name\}/g, firstName(name)).replace(/\{count\}/g, String(tier));
}

export function createVoiceEngine({
  client,
  db,
  post,
  state,
  saveState,
  log = console,
  writeDb: injectedWriteDb,
  minGapMs = DEFAULT_MIN_GAP_MS,
}) {
  // `injectedWriteDb` is a test seam; production builds the real service client.
  const writeDb = injectedWriteDb ?? (process.env.SUPABASE_SERVICE_ROLE_KEY ? serviceClient() : null);
  if (!writeDb) {
    log.warn?.('[voice] no SUPABASE_SERVICE_ROLE_KEY — voice engine disabled (reads only)');
  }
  const gapMs = Number.isFinite(minGapMs) && minGapMs >= 0 ? minGapMs : DEFAULT_MIN_GAP_MS;

  function st() {
    if (!state.voice || typeof state.voice !== 'object') state.voice = {};
    const v = state.voice;
    if (typeof v.onlineMinutes !== 'number') v.onlineMinutes = 0;   // ambient cadence accumulator
    if (typeof v.ambientCount !== 'number') v.ambientCount = 0;     // variety seed
    if (!Array.isArray(v.recentTemplates)) v.recentTemplates = [];  // last RECENT_KEEP template ids
    if (!v.deathTiers || typeof v.deathTiers !== 'object') v.deathTiers = {}; // name -> last tier said
    if (typeof v.deathTiersSeeded !== 'boolean') v.deathTiersSeeded = false;
    if (!('lastDawnDay' in v)) v.lastDawnDay = null;                // world day of the last dawn line
    // Retired mechanics — drop their keys so state.json stays honest.
    delete v.lastDeathMilestone;   // warband-every-50th (now per-player tiers)
    delete v.announcedDiscoveries; // first-biome welcomes (removed)
    return v;
  }

  // Queue a line for the in-game plugin to speak. speaker defaults to 'Eilif'.
  async function enqueue(text, kind, meta = {}) {
    if (!writeDb || !text) return false;
    const { error } = await writeDb.from('voice_lines').insert({
      text,
      kind,
      meta,
      status: 'queued',
      queued_at: new Date().toISOString(),
    });
    if (error) {
      log.error?.(`[voice] enqueue failed: ${error.message}`);
      return false;
    }
    return true;
  }

  // Cheapest online read: the single server_status row the recap already uses.
  async function readStatus() {
    const { data } = await db
      .from('server_status')
      .select('is_online, player_count, world_day')
      .eq('id', 1)
      .maybeSingle();
    return {
      online: !!data?.is_online,
      playerCount: data?.player_count ?? 0,
      worldDay: data?.world_day ?? 0,
    };
  }

  // ── global pacing (ambient only) ─────────────────────────────────────────

  // When the most recent voice line of ANY kind was queued, in epoch ms.
  // voice_lines has no public-read policy, so this must use the service client.
  async function lastVoiceQueuedAt() {
    if (!writeDb) return null;
    const { data, error } = await writeDb
      .from('voice_lines')
      .select('queued_at')
      .order('queued_at', { ascending: false })
      .limit(1);
    if (error) {
      log.warn?.(`[voice] gap check failed, treating hall as quiet: ${error.message}`);
      return null;
    }
    const ts = Array.isArray(data) ? data[0]?.queued_at : data?.queued_at;
    const t = ts ? Date.parse(ts) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  // Milliseconds still owed before an AMBIENT line may be queued (0 = clear).
  async function ambientGapRemaining() {
    if (gapMs <= 0) return 0;
    const last = await lastVoiceQueuedAt();
    if (last == null) return 0;
    return Math.max(0, gapMs - (Date.now() - last));
  }

  // ── ambient content selection ────────────────────────────────────────────

  // Build the candidate lines for one category as {id, text}. Callback candidates
  // require a DB read, so they're only built when the roll actually lands there.
  async function buildCategory(cat, status, rand, roster = []) {
    if (cat === 'atmosphere') {
      return ATMOSPHERE.map((t, i) => ({ id: `atmo:${i}`, text: t }));
    }
    if (cat === 'callback') {
      const ev = await findCallbackEvent(rand);
      if (!ev) return [];
      // {Span} is the same label at the head of a sentence, so a callback
      // never opens with a lowercase "a week ago".
      const Span = ev.span.charAt(0).toUpperCase() + ev.span.slice(1);
      // Function replacers, not strings: a character name is player-chosen and
      // "$&" or "$'" in a string replacement is a substitution pattern, not
      // text. Same for the cause, which carries a creature name.
      return CALLBACK_TEMPLATES.map((t, i) => ({
        id: `cb:${i}`,
        text: t
          .replace(/\{Span\}/g, () => Span)
          .replace(/\{span\}/g, () => ev.span)
          .replace(/\{name\}/g, () => ev.name)
          .replace(/\{cause\}/g, () => ev.cause),
      }));
    }
    if (cat === 'oath') {
      const o = await findOathCallback(rand, roster);
      if (!o) return [];
      // Same function-replacer rule as the death callback: the name and the
      // oath are both player-typed, and "$&" in a string replacement is a
      // substitution pattern rather than text.
      return OATH_CALLBACKS
        .map((text, i) => ({ text, i }))
        // {days} only reads right with a real span behind it, so an oath sworn
        // today, or a row with no usable sworn_at, keeps the other templates.
        .filter(({ text }) => o.days != null || !text.includes('{days}'))
        .map(({ text, i }) => ({
          id: `oathcb:${i}`,
          source: 'oath_callback',
          ...(SECOND_PERSON.test(text) && targetingEnabled() ? { target: o.name } : {}),
          text: text
            .replace(/\{firstName\}/g, () => firstName(o.name))
            .replace(/\{oath\}/g, () => o.oath)
            .replace(/\{days\}/g, () => String(o.days)),
        }));
    }
    return [];
  }

  // An oath sworn by a viking who is ONLINE RIGHT NOW, for the ambient slot.
  // ONE read, and only when the roll lands on this class: the roster is already
  // in hand from the whisper check, so an ambient tick costs at most one query
  // more than it did before. Never a write: `announced_at` belongs to the echo.
  //
  // An 'unmatched' oath belongs to no viking yet (the name it was sworn under
  // never resolved), so it can never be read back at anybody.
  async function findOathCallback(rand, roster) {
    if (!roster.length) return null;
    const { data, error } = await db
      .from('oaths')
      .select('character_name, oath_text, sworn_at, match_status')
      .order('sworn_at', { ascending: false })
      .limit(100);
    if (error) {
      log.warn?.(`[voice] oath callback read failed: ${error.message}`);
      return null;
    }
    // Case-insensitive, because `oaths.character_name` is typed by a player in
    // a Discord message and the roster comes from the game.
    const online = new Map(roster.map((n) => [n.toLowerCase(), n]));
    const rows = [];
    for (const r of data || []) {
      const status = String(r.match_status || '').toLowerCase();
      if (status !== 'exact' && status !== 'fuzzy') continue;
      const key = String(r.character_name || '').trim().toLowerCase();
      if (!key || !online.has(key)) continue;
      const oath = oathQuote(r.oath_text);
      if (!oath || !speakableOath(r.oath_text)) continue;
      rows.push({ row: r, key, oath });
    }
    if (!rows.length) return null;
    const { row, key, oath } = rows[Math.floor(rand() * rows.length)];
    const sworn = row.sworn_at ? Date.parse(row.sworn_at) : NaN;
    const days = Number.isFinite(sworn) ? Math.floor((Date.now() - sworn) / 86_400_000) : null;
    return { name: online.get(key), oath, days: days != null && days >= 1 ? days : null };
  }

  // Find a death from ~1/2/4 weeks ago (spans tried in a seeded order).
  async function findCallbackEvent(rand) {
    // Every label ends in "ago" so it reads the same way in all four callback
    // templates ("four weeks past tonight …" did not).
    const spans = [
      { days: 7, label: 'a week ago' },
      { days: 14, label: 'a fortnight ago' },
      { days: 28, label: 'four weeks ago' },
    ];
    // seeded shuffle so the chosen span/event varies without repeating patterns
    for (let i = spans.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [spans[i], spans[j]] = [spans[j], spans[i]];
    }
    for (const span of spans) {
      const end = new Date(Date.now() - span.days * 24 * 3600 * 1000);
      const start = new Date(end.getTime() - 24 * 3600 * 1000);
      const { data } = await db
        .from('events')
        .select('character_name, metadata, created_at')
        .eq('type', 'death')
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString())
        .limit(20);
      const rows = (data || []).filter((r) => (r.character_name || '').trim());
      if (rows.length) {
        const r = rows[Math.floor(rand() * rows.length)];
        // Noun phrase, always: the callback templates drop {cause} mid-sentence,
        // and the stored cause is a raw HitType word ("Tree", "EnemyHit") or a
        // creature name, neither of which reads as English on its own.
        // markdown:false — this line is SPOKEN in-game, where an escape
        // backslash would be read out as a backslash.
        const cause = causeNoun(r.metadata?.cause, { markdown: false }) || 'something nobody wrote down';
        return { span: span.label, name: (r.character_name || '').trim(), cause };
      }
    }
    return null;
  }

  // Online character names, sorted so a seeded pick is stable across ticks.
  async function onlineRoster() {
    const { data, error } = await db.from('players').select('character_name, is_online');
    if (error) {
      log.warn?.(`[voice] roster read failed: ${error.message}`);
      return [];
    }
    return (data || [])
      .filter((p) => p.is_online && String(p.character_name || '').trim())
      .map((p) => String(p.character_name).trim())
      .sort();
  }

  // Has the saga recorded NOTHING for 45 minutes? A read failure counts as a
  // busy hall, so a broken query can never invent a quiet night.
  async function hallHasBeenQuiet() {
    const since = new Date(Date.now() - WHISPER_QUIET_MS).toISOString();
    const { data, error } = await db
      .from('events')
      .select('id')
      .gte('created_at', since)
      .limit(1);
    if (error) {
      log.warn?.(`[voice] quiet check failed, treating the hall as busy: ${error.message}`);
      return false;
    }
    return (data || []).length === 0;
  }

  // Whispers on quiet nights: candidates for the ambient slot when the hall is
  // nearly empty. Returns [] when the night doesn't qualify — then the normal
  // atmosphere/callback pools run, untouched. This is a POOL SWAP, never an
  // extra line: the 2h clock and VOICE_MIN_GAP_MS still decide *when*.
  async function buildWhispers(status, rand = Math.random, knownRoster = null) {
    // Presence must be unambiguous: whispers lean on WHO is in the hall, so an
    // empty/stale roster, or one that disagrees with server_status, says
    // nothing clever and lets the normal pools run. `knownRoster` is the read
    // pickAmbient already did for this slot, not a second one.
    const roster = knownRoster ?? (await onlineRoster());
    const count = roster.length;
    if (count < 1 || count > WHISPER_CREW_MAX) return [];
    const reported = status.playerCount | 0;
    if (reported > 0 && reported !== count) return [];

    let pool;
    let prefix;
    if (count === 1) {
      pool = SOLO_WHISPERS;
      prefix = 'solo';
    } else {
      if (!(await hallHasBeenQuiet())) return [];
      pool = CREW_WHISPERS;
      prefix = 'crew';
    }

    // One viking, picked deterministically from the (sorted) online roster.
    const named = roster[Math.floor(rand() * roster.length)];
    return pool.map((text, i) => ({
      id: `${prefix}:${i}`,
      source: 'whisper',
      text: text.replace(/\{firstName\}/g, firstName(named)),
    }));
  }

  // No-repeat guard: prefer templates outside the last RECENT_KEEP uses.
  function chooseFresh(cand, v, rand) {
    const recent = v.recentTemplates || [];
    const fresh = cand.filter((c) => !recent.includes(c.id));
    const pool = fresh.length ? fresh : cand;
    return pool[Math.floor(rand() * pool.length)];
  }

  // Weighted category pick + no-repeat guard. Deterministic-ish per world-day.
  // Dawn lines are NOT in this pool — they run on their own every-3rd-day clock.
  async function pickAmbient(status) {
    const v = st();
    const rand = mulberry32(((status.worldDay | 0) * 1000 + (v.ambientCount | 0)) >>> 0);

    // One roster read serves the whole slot: the quiet-night check needs to know
    // who is in the hall, and so does the oath callback (whose viking has to be
    // online to hear it).
    const roster = await onlineRoster();

    // A quiet night takes the slot before the normal pools are ever consulted.
    const whispers = await buildWhispers(status, rand, roster);
    if (whispers.length) return chooseFresh(whispers, v, rand);

    const roll = rand();
    // ≈ oath 25% / callback 30% / atmosphere 45%. Oath and callback each need a
    // DB read (a sworn oath from someone online, a dated death) and each falls
    // through to atmosphere, which is always non-empty — so an ambient tick
    // still costs at most ONE read beyond the roster, as it did before.
    const order = roll < OATH_AMBIENT_SHARE ? ['oath', 'atmosphere']
      : roll < 0.55 ? ['callback', 'atmosphere']
        : ['atmosphere', 'callback'];

    for (const cat of order) {
      const cand = await buildCategory(cat, status, rand, roster);
      if (!cand.length) continue;
      return chooseFresh(cand, v, rand);
    }
    return null;
  }

  async function queueAmbient(status) {
    const v = st();
    const pick = await pickAmbient(status);
    if (!pick) return false;
    const ok = await enqueue(pick.text, 'ambient', {
      template: pick.id,
      ...(pick.target ? { target: pick.target } : {}),
      world_day: status.worldDay,
      ...(pick.source ? { source: pick.source } : {}),
    });
    if (!ok) return false;
    v.ambientCount = (v.ambientCount | 0) + 1;
    v.recentTemplates = [...(v.recentTemplates || []), pick.id].slice(-RECENT_KEEP);
    log.info?.(`[voice] ambient queued (${pick.id})`);
    return true;
  }

  // ── dawn: every 3rd world day, once, only to a populated hall ─────────────
  // Independent of the 2h ambient clock and exempt from VOICE_MIN_GAP_MS. The
  // once-per-day guard is an equality check, so a world wipe (day counter back
  // to 1) starts the cycle over instead of going silent.
  async function checkDawn(status) {
    const v = st();
    const day = status.worldDay | 0;
    if (!(day > 0) || day % DAWN_EVERY_DAYS !== 0) return false;
    if ((status.playerCount ?? 0) <= 0) return false;
    if (v.lastDawnDay === day) return false;

    const rand = mulberry32(((day * 7919) >>> 0));
    const cand = DAWN.map((t, i) => ({ id: `dawn:${i}`, text: t.replace(/\{day\}/g, String(day)) }));
    const recent = v.recentTemplates || [];
    const fresh = cand.filter((c) => !recent.includes(c.id));
    const pool = fresh.length ? fresh : cand;
    const pick = pool[Math.floor(rand() * pool.length)];

    const ok = await enqueue(pick.text, 'ambient', {
      source: 'dawn',
      template: pick.id,
      world_day: day,
    });
    if (!ok) return false;
    v.lastDawnDay = day;
    v.recentTemplates = [...recent, pick.id].slice(-RECENT_KEEP);
    log.info?.(`[voice] dawn line queued for day ${day} (${pick.id})`);
    return true;
  }

  // ── event lines (immediate; exempt from every gap, reset the ambient clock) ─

  // In-game oaths: echo in-game + cross-post to Discord, then mark announced.
  // Channel: env OATH_CHANNEL ('server' during the rehearsal pilot, default
  // 'valheim' — revert/remove at launch alongside RECAP_CHANNEL/MILESTONE_CHANNEL).
  const OATH_CHANNEL = process.env.OATH_CHANNEL === 'server' ? 'server' : 'valheim';

  // The line the hall SPEAKS when an oath is captured. Seeded by the oath row
  // id, so a tick that runs twice over the same row says the same thing rather
  // than inventing a second version of the moment.
  function oathEchoLine(oath, name) {
    const quote = oathQuote(oath?.oath_text);
    // Nothing usable left (an all-markdown shout): keep the fixed line Eilif
    // used before the pool existed, rather than speaking an empty pair of
    // quotes back at the swearer.
    if (!quote) {
      return { text: `Eilif heard you, ${firstName(name)}. These walls will hold you to it.`, template: null };
    }
    const cand = OATH_ECHO_LINES.map((t, i) => ({
      id: `oathecho:${i}`,
      text: t
        .replace(/\{firstName\}/g, () => firstName(name))
        .replace(/\{oath\}/g, () => quote),
    }));
    const pick = chooseFresh(cand, st(), mulberry32(hashStr(`oath:${oath?.id ?? name}`)));
    return { text: pick.text, template: pick.id };
  }

  async function checkOathEchoes() {
    if (!writeDb) return 0;
    const v = st();
    const { data, error } = await writeDb
      .from('oaths')
      .select('id, character_name, oath_text')
      .eq('source', 'ingame')
      .is('announced_at', null)
      .limit(10);
    if (error) {
      log.error?.(`[voice] oath echo query: ${error.message}`);
      return 0;
    }
    let n = 0;
    for (const o of data || []) {
      const name = (o.character_name || '').trim() || 'A viking';
      const echo = oathEchoLine(o, name);
      const spoken = await enqueue(echo.text, 'event', {
        source: 'oath',
        oath_id: o.id,
        ...(echo.template ? { template: echo.template } : {}),
      });
      // Only a line that actually reached the queue narrows the no-repeat
      // window, and it narrows it before the next oath in this same batch is
      // picked, so three oaths at once are three different sentences.
      if (spoken && echo.template) {
        v.recentTemplates = [...(v.recentTemplates || []), echo.template].slice(-RECENT_KEEP);
      }
      try {
        await post(OATH_CHANNEL, {
          embeds: [
            {
              title: '📜 A new oath is sworn',
              // THE RAW SHOUT THIS CLOSES (red-team round 2, 2026-09-05). Both
              // halves used to be interpolated verbatim. `oath_text` is the
              // text of an in-game `/s /oath …` shout, which /api/webhook
              // records for ANY viking with no cap and no sanitising
              // (lib/webhook/oath.ts normalizeOathText only trims), and
              // `character_name` is player-chosen. Unescaped, a `_` or `"`
              // broke straight out of the italic wrapper, `||…||` hid the rest
              // of the embed, and a `https://…` in the oath put a live link
              // into the hall in Eilif's own voice. Same treatment every other
              // announcement path already had.
              description: `**${nameMd(name)}** swore on the charter, and the hall heard it.\n\n_"${safeText(o.oath_text, 900)}"_`,
              color: 0xc8952a,
              footer: { text: 'Eilif · The Cozy Canon Playthrough' },
            },
          ],
        });
      } catch (e) {
        log.error?.(`[voice] oath cross-post: ${e.message}`);
      }
      await writeDb.from('oaths').update({ announced_at: new Date().toISOString() }).eq('id', o.id);
      n++;
    }
    return n;
  }

  // Per-player death milestones: 20, 50, 100, then every +100 deaths, once each.
  // Deaths come from player_stats (the cumulative per-character counter the
  // dashboard already trusts), joined to players for the name.
  async function checkDeathMilestones() {
    const v = st();
    const [playersRes, statsRes] = await Promise.all([
      db.from('players').select('id, character_name'),
      db.from('player_stats').select('player_id, deaths'),
    ]);
    if (playersRes.error || statsRes.error) {
      log.warn?.('[voice] death milestone read failed — skipping this tick');
      return 0;
    }

    const idToName = new Map();
    for (const p of playersRes.data || []) {
      const nm = (p.character_name || '').trim();
      if (nm) idToName.set(p.id, nm);
    }
    // Keyed by NAME, keeping the highest count: duplicate players rows (the
    // 2026-07-25 Testman incident) must never split or multiply a viking's tally.
    const deathsByName = new Map();
    for (const s of statsRes.data || []) {
      const nm = idToName.get(s.player_id);
      if (!nm) continue;
      const n = Math.floor(Number(s.deaths) || 0);
      deathsByName.set(nm, Math.max(deathsByName.get(nm) ?? 0, n));
    }
    if (deathsByName.size === 0) return 0;

    // First pass after this mechanic shipped: adopt everyone's CURRENT tier
    // silently, so a roster that already died plenty doesn't get a storm of
    // back-dated proclamations. Vikings who appear later start from tier 0.
    if (!v.deathTiersSeeded) {
      for (const [name, deaths] of deathsByName) {
        const tier = deathTier(deaths);
        if (tier > 0) v.deathTiers[name] = tier;
      }
      v.deathTiersSeeded = true;
      log.info?.(`[voice] death tiers seeded silently for ${deathsByName.size} viking(s)`);
      return 0;
    }

    let n = 0;
    for (const [name, deaths] of deathsByName) {
      const tier = deathTier(deaths);
      if (tier <= 0) continue;
      const last = Math.floor(Number(v.deathTiers[name]) || 0);
      if (tier <= last) continue;
      const ok = await enqueue(deathMilestoneLine(tier, name), 'event', {
        source: 'deaths',
        player: name,
        tier,
        deaths,
      });
      if (ok) {
        v.deathTiers[name] = tier;
        n++;
        log.info?.(`[voice] death milestone ${tier} announced for ${name}`);
      }
    }
    return n;
  }

  // ── POTY coronation (called by recap.js at the poty_history insert) ───────
  async function announcePoty(poty, worldDay = null) {
    if (!poty?.name) return;
    const name = String(poty.name).trim();
    await enqueue(
      `The crown goes to ${firstName(name)} tonight. Eilif will remember it come morning.`,
      'event',
      { source: 'poty', poty: name, award: poty.key, world_day: worldDay },
    );
    st().onlineMinutes = 0; // an event line resets the ambient clock
    await saveState();
    log.info?.(`[voice] POTY coronation queued for ${name}`);
  }

  // ── housekeeping: expire stale queued lines (never flood on server return) ─
  //
  // Expired lines get status 'expired' with spoken_at left NULL, so an unspoken
  // line can never look delivered (it used to be written as 'spoken', which hid
  // a silent Companion). /api/voice only ever serves status='queued', so the
  // in-game side is unchanged.
  //
  // TTLs by kind: the POTY coronation says "tonight", so it goes stale in 3
  // hours instead of 24. PARTIAL FIX for the wider POTY problem (voice-2): the
  // decision still owed from Charlie is whether to queue the crown at all when
  // the hall is empty at 23:00, or to reword it for the morning after.
  async function expireStale() {
    if (!writeDb) return 0;
    let expired = 0;

    const sweep = async (label, ageMs, narrow) => {
      const cutoff = new Date(Date.now() - ageMs).toISOString();
      let q = writeDb
        .from('voice_lines')
        .update({ status: 'expired' })
        .eq('status', 'queued')
        .lt('queued_at', cutoff);
      if (narrow) q = narrow(q);
      const { data, error } = await q.select('id');
      if (error) {
        log.error?.(`[voice] expire stale (${label}): ${error.message}`);
        return;
      }
      expired += Array.isArray(data) ? data.length : 0;
    };

    // POTY first (the tighter window), then everything else at 24h.
    await sweep('poty', POTY_STALE_MS, (q) => q.eq('meta->>source', 'poty'));
    await sweep('all', STALE_MS, null);

    if (expired > 0) log.info?.(`[voice] expired ${expired} stale line(s)`);
    return expired;
  }

  // ── the 60s tick ──────────────────────────────────────────────────────────
  async function tick() {
    if (!writeDb) return;
    const v = st();
    // NOTE: expireStale() is NOT called here. It runs on its own timer in
    // index.js so housekeeping keeps going while the hall is empty and while a
    // voice tick is stuck on a slow read.

    const status = await readStatus();

    // Immediate event lines first — exempt from every gap; they reset the
    // ambient clock so Eilif doesn't follow a proclamation with small talk.
    let events = 0;
    events += await checkOathEchoes();
    events += await checkDeathMilestones();

    // Dawn rides its own every-3rd-day clock, gap-exempt, never to an empty hall.
    const dawn = await checkDawn(status);

    if (events > 0) {
      v.onlineMinutes = 0; // a presence, not a chatterbox
    } else if ((status.playerCount ?? 0) > 0) {
      // Accumulate someone-online time; one ambient line per ~2h, and never
      // within the global min-gap of the last voice line of ANY kind.
      v.onlineMinutes = (v.onlineMinutes || 0) + TICK_MS / 60000;
      if (v.onlineMinutes >= CADENCE_MINUTES && !dawn) {
        const owed = await ambientGapRemaining();
        if (owed > 0) {
          // Hold the accumulator and retry next tick — the cadence is owed, the
          // hall just spoke too recently.
          log.info?.(`[voice] ambient held ${Math.round(owed / 1000)}s for the min-gap`);
        } else if (await queueAmbient(status)) {
          v.onlineMinutes = 0;
        }
      }
    }
    await saveState();
  }

  // ── puppet mode: `@Eilif say: <line>` from an admin ────────────────────────
  //
  // No role in the live guild actually carries the Administrator bit, so the
  // owner was the only operator. Manage Server counts too, and ADMIN_ROLE_IDS
  // (comma-separated role ids) is the escape hatch for a guild whose "Admin"
  // role carries neither.
  const ADMIN_ROLE_IDS = String(process.env.ADMIN_ROLE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // THE WRONG GUILD (red-team, 2026-09-05). `member.permissions` is authority
  // in the guild the message came from — not in this hall. If the bot is ever
  // in a second guild (a staging server, or a public-bot invite), the owner of
  // THAT guild is an Administrator there, and `@Eilif say: <line>` would put
  // their text on every Eilif player's screen, center-screen, in Eilif's voice.
  // GUILD_ID is already set on the live bot and already used by the events
  // sync; this pins the puppet to it.
  const PUPPET_GUILD_ID = process.env.GUILD_ID || null;


  function mayPuppet(member) {
    if (!member) return false; // a DM has no member, so it has no permissions
    if (PUPPET_GUILD_ID && member.guild?.id !== PUPPET_GUILD_ID) return false;
    if (member.permissions?.has?.('Administrator')) return true;
    if (member.permissions?.has?.('ManageGuild')) return true;
    return ADMIN_ROLE_IDS.some((id) => member.roles?.cache?.has?.(id));
  }

  async function handleMessage(message) {
    try {
      if (!writeDb) return;
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user, MENTION_STRICT)) return;

      // Parse the say-command BEFORE anything else, but only for admins — so an
      // ordinary member's message falls straight through to the oath ingest.
      const stripped = (message.content ?? '')
        .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
        .trim();
      const m = stripped.match(/^say\s*:\s*([\s\S]+)$/i);
      if (!m) return;

      if (!mayPuppet(message.member)) {
        // Say why, instead of the old silence: a co-admin who cannot use it
        // should learn that in one line, not by wondering.
        await message.reply('(admins only)').catch(() => {});
        return;
      }

      const line = m[1].trim();
      if (!line) return;

      const ok = await enqueue(line, 'manual', {
        by: message.member?.displayName ?? message.author.username,
        discord_id: message.author.id,
      });
      if (ok) {
        st().onlineMinutes = 0; // manual line resets the ambient clock
        await saveState();
        await message.react('🗣️').catch(() => {});
        log.info?.(`[voice] manual line by ${message.author.username}: ${line.slice(0, 60)}`);
      }
    } catch (e) {
      log.error?.(`[voice] say: ${e.message}`);
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
    log.info?.(
      `[voice] engine active — ambient every ${CADENCE_MINUTES}m online-time (min gap ${Math.round(gapMs / 60000)}m), ` +
      `dawn every ${DAWN_EVERY_DAYS} world days, events exempt; admins: \`@Eilif say: <line>\``,
    );
  }

  return {
    tick,
    expireStale,
    attach,
    announcePoty,
    handleMessage,
    pickAmbient,
    _state: st,
    _checkDawn: checkDawn,
    _buildWhispers: buildWhispers,
    _findOathCallback: findOathCallback,
    _oathEchoLine: oathEchoLine,
    _checkDeathMilestones: checkDeathMilestones,
    _ambientGapRemaining: ambientGapRemaining,
  };
}
