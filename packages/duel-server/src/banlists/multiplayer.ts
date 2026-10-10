// Cards that do not work in multiplayer tables, under ADR-0002 (docs/adr/0002-multiplayer-duel-rules.md).
// Scenario catalog and script evidence: docs/specs/2026-09-30-multiplayer-card-scenarios.md
// Script evidence (cNNN.lua:line) for each entry: tests/scenarios/multiplayer/catalog.ts
// The test tests/scenarios/multiplayer/catalog.test.ts checks every code and every cited line
// against data/duel-engine-next.
// Alternate-art passcodes are NOT listed here. The deck check matches them through the
// `alias` column of cards.cdb (an alternate art has alias = original passcode).

/** Table kinds for deck validation. "1v1" is the classic duel and has no multiplayer list. */
export type MultiplayerTable = "1v1" | "tag" | "ffa3" | "ffa4";

export type MultiplayerFormat = "ffa3" | "ffa4" | "tag";

export type MultiplayerCategory =
  | "symmetry" // the script treats "me" and "the opponent" as two equal sides
  | "hand-swap" // the script reads or replaces both hands with one chooser per side
  | "control-swap" // the script swaps control between two named players
  | "turn-count" // a counter or a reset that counts "the opponent's turns"
  | "turn-order" // the script skips or adds a turn for one player
  | "alt-win" // the script ends the duel with Duel.Win ("you win"); decided forbidden in all formats (ADR-0002)
  | "global-state" // a per-player global flag table with two slots
  | "chooser" // the script asks "the opponent" to choose and assumes only one
  | "lp-reset"; // the script sets or compares the LP of exactly two players

export interface MultiplayerForbidden {
  code: number;
  name: string;
  category: MultiplayerCategory;
  reason: string;
  formats: MultiplayerFormat[];
  /** Explicit owner decision; suppresses scanner Tag gaps without hiding script changes. */
  tagDecision?: { allowed: true; source: string };
}

const FFA: MultiplayerFormat[] = ["ffa3", "ffa4"];
const ALL: MultiplayerFormat[] = ["ffa3", "ffa4", "tag"];
const NO_RESULT = " A 'you win' effect has no defined result for the other players.";

export const MULTIPLAYER_FORBIDDEN: readonly MultiplayerForbidden[] = [
  // --- hand-swap: both hands, one chooser per side
  { code: 74519184, name: "Hand Destruction", category: "hand-swap", reason: "Turn player and one other player draw and discard. The other players do nothing.", formats: FFA, tagDecision: { allowed: true, source: "owner 2026-10-06, option A" } },
  { code: 72892473, name: "Card Destruction", category: "hand-swap", reason: "Both hands go to the GY, but only two players draw.", formats: FFA, tagDecision: { allowed: true, source: "owner 2026-10-06, option A" } },
  { code: 33508719, name: "Morphing Jar", category: "hand-swap", reason: "It discards all hands, but only two players draw 5 cards. In Tag, the partner discards and does not draw.", formats: ALL },
  { code: 14057297, name: "Multiple Destruction", category: "hand-swap", reason: "It reads two hands and two LP totals only. Other players are not part of the cost or the draw.", formats: ALL },
  { code: 17484499, name: "Exchange of the Spirit", category: "hand-swap", reason: "The script swaps the Deck and GY of exactly two players. The condition reads one GY on each side.", formats: ALL },
  // --- symmetry
  { code: 100200298, name: 'Counter Spell "Negate Attack"', category: "symmetry", reason: "Its free-chain options compare two fields and use 1-tp for the event player and Battle Phase skip; binding those operations to the triggering opponent is unproven at 3+ seats.", formats: ALL },
  { code: 82301904, name: "Chaos Emperor Dragon - Envoy of the End", category: "symmetry", reason: "It sends both sides and damages both players. More than two players have no defined split.", formats: FFA, tagDecision: { allowed: true, source: "owner 2026-10-06, option A" } },
  { code: 35059553, name: "Kaiser Colosseum", category: "symmetry", reason: "It compares the monster count of two sides to limit summons.", formats: FFA, tagDecision: { allowed: true, source: "owner 2026-10-06, option A" } },
  { code: 98139712, name: "Skull Invitation", category: "symmetry", reason: "Damage goes by card owner to 'you' and 'the opponent' only.", formats: FFA },
  { code: 83555666, name: "Ring of Destruction", category: "symmetry", reason: "It damages the activator and one opponent. The opponent LP check reads one player.", formats: FFA },
  { code: 62966332, name: "Convulsion of Nature", category: "symmetry", reason: "It reverses Decks through one global check for two sides. A multiplayer table has more than two Decks.", formats: ALL },
  // --- turn-count
  { code: 22804644, name: "Doom Virus Dragon", category: "turn-count", reason: "Its effect lasts 3 'opponent turns'.", formats: FFA },
  { code: 21208154, name: "The Wicked Avatar", category: "turn-count", reason: "Its effect lasts 2 'opponent turns'.", formats: FFA },
  { code: 22888900, name: "Grisaille Prison", category: "turn-count", reason: "Its effect lasts 2 'opponent turns'.", formats: FFA },
  { code: 23746827, name: "Million-Century Ice Prison", category: "turn-count", reason: "Its effect lasts 2 'opponent turns'.", formats: FFA },
  // --- turn-order
  { code: 18326736, name: "Tellarknight Ptolemaeus", category: "turn-order", reason: "It skips a turn. FFA turn order has no 'the opponent's turn'.", formats: FFA },
  { code: 23846921, name: "Arcana Force XXI - The World", category: "turn-order", reason: "It skips a turn. FFA turn order has no 'the opponent's turn'.", formats: FFA },
  { code: 37313786, name: "Gamble", category: "turn-order", reason: "It skips a turn. FFA turn order has no 'the opponent's turn'.", formats: FFA, tagDecision: { allowed: true, source: "owner 2026-10-06, option A" } },
  { code: 6357341, name: "The Six Shinobi", category: "turn-order", reason: "It skips a turn. FFA turn order has no 'the opponent's turn'.", formats: FFA },
  { code: 92182447, name: "Mischief of the Time Goddess", category: "turn-order", reason: "It skips a turn. FFA turn order has no 'the opponent's turn'.", formats: FFA },
  // --- alt-win
  { code: 33396948, name: "Exodia the Forbidden One", category: "alt-win", reason: "It reads both hands and ends the duel with win, loss or draw for two sides.", formats: ALL },
  { code: 95308449, name: "Final Countdown", category: "alt-win", reason: "It keeps one counter for each of two players and then ends the duel.", formats: ALL },
  { code: 28566710, name: "Last Turn", category: "alt-win", reason: "It compares two players and ends the duel with win, loss or draw.", formats: ALL },
  { code: 37984331, name: "True Exodia", category: "alt-win", reason: "It ends the duel with a win for 'the opponent of the controller'. FFA and Tag have no single opponent.", formats: ALL },
  { code: 42776960, name: "Relay Soul", category: "alt-win", reason: `It ends the duel with a win for one saved player when its monster leaves the field.${NO_RESULT}`, formats: ALL },
  { code: 13893596, name: "Exodius the Ultimate Forbidden Lord", category: "alt-win", reason: `It ends the duel with a win for its controller when 5 Forbidden One monsters are in the GY.${NO_RESULT}`, formats: ALL },
  { code: 10000040, name: "Holactie the Creator of Light", category: "alt-win", reason: `The player who Special Summons it wins the duel.${NO_RESULT}`, formats: ALL },
  { code: 15862758, name: "Number iC1000: Numerounius Numerounia", category: "alt-win", reason: `It ends the duel with a win for its controller when it has not battled in an opponent turn.${NO_RESULT}`, formats: ALL },
  { code: 5008836, name: "Exodia, the Legendary Defender", category: "alt-win", reason: `It ends the duel with a win for its controller when it destroys a DARK Fiend of an opponent by battle.${NO_RESULT}`, formats: ALL },
  { code: 53334641, name: "Ghostrick Angel of Mischief", category: "alt-win", reason: `It ends the duel with a win for its controller when it has 10 Xyz Materials.${NO_RESULT}`, formats: ALL },
  { code: 6165656, name: "Number C88: Gimmick Puppet Disaster Leo", category: "alt-win", reason: `It ends the duel with a win for its controller in their turn when one opponent has 2000 LP or less.${NO_RESULT}`, formats: ALL },
  { code: 66765023, name: "Flying Elephant", category: "alt-win", reason: `It ends the duel with a win for its controller when it deals battle damage with a direct attack.${NO_RESULT}`, formats: ALL },
  { code: 69553552, name: "F.A. Winners", category: "alt-win", reason: `It ends the duel with a win for its controller when 3 of its banished cards have different names.${NO_RESULT}`, formats: ALL },
  { code: 77751766, name: "Summer Schoolwork Successful!", category: "alt-win", reason: `It ends the duel with a win for its controller when their Deck has 1 card or less after its effect.${NO_RESULT}`, formats: ALL },
  { code: 8062132, name: "Vennominaga the Deity of Poisonous Snakes", category: "alt-win", reason: `It ends the duel with a win for its controller when it has 3 counters.${NO_RESULT}`, formats: ALL },
  { code: 81171949, name: "Jackpot 7", category: "alt-win", reason: `It ends the duel with a win for its controller when 3 copies are banished.${NO_RESULT}`, formats: ALL },
  { code: 94212438, name: "Destiny Board", category: "alt-win", reason: `It ends the duel with a win for its controller when 4 Spirit Message cards are on their field.${NO_RESULT}`, formats: ALL },
  { code: 96637156, name: "Musical Sumo Dice Games", category: "alt-win", reason: `It ends the duel with a win for its controller when it gets its 7th Xyz Material.${NO_RESULT}`, formats: ALL },
  { code: 97795930, name: "Phantasm Spiral Assault", category: "alt-win", reason: `It ends the duel with a win for its controller when its counter reaches 3.${NO_RESULT}`, formats: ALL },
  { code: 48995978, name: "Number 88: Gimmick Puppet of Leo", category: "alt-win", reason: `It ends the duel with a win for its controller when it has 3 counters.${NO_RESULT}`, formats: ALL },
  // --- global-state
  { code: 27204311, name: "Nibiru, the Primal Being", category: "global-state", reason: "It counts summons in a flag for each of two players and reads the flag of 'the opponent'.", formats: FFA, tagDecision: { allowed: true, source: "owner 2026-10-06, option A" } },
  { code: 94145021, name: "Droll & Lock Bird", category: "global-state", reason: "It keeps a two-slot table of draws for each player.", formats: FFA },
  // --- chooser
  { code: 101402094, name: "Angelechy Opposition", category: "chooser", reason: "Its Extra Deck summon checks zones and summons to 1-tp without a reviewed eligible-opponent choice; recipient selection and zone checks are unproven at 3+ seats.", formats: ALL },
  { code: 57728570, name: "Crush Card Virus", category: "chooser", reason: "It reads the opponent hand, field and Deck, and asks one opponent to choose.", formats: FFA, tagDecision: { allowed: true, source: "owner 2026-10-06, option A" } },
  // --- control-swap
  { code: 15305240, name: "Creature Seizure", category: "control-swap", reason: "The script swaps control between the activator and one named opponent.", formats: FFA, tagDecision: { allowed: true, source: "owner 2026-10-06, option A" } },
  { code: 30426226, name: "Switcheroroo", category: "control-swap", reason: "It needs equal monster counts on two sides and swaps all of them.", formats: FFA },
  { code: 13532663, name: "Dummy Golem", category: "control-swap", reason: "The script swaps control between the activator and a monster chosen by one named opponent.", formats: FFA, tagDecision: { allowed: true, source: "owner 2026-10-06, option A" } },
  // --- lp-reset
  { code: 17178486, name: "Life Equalizer", category: "lp-reset", reason: "It sets the LP of one named opponent and compares two LP totals.", formats: FFA },
];

/**
 * Cards that stay legal but need a per-card multiplayer rule (product owner, 2026-10-01, ADR-0002).
 * The deck check does NOT use this list. `rule` is the decided rule. `engine` is "native" when the engine (core patch or
 * overlay script) does the rule AND a live scenario of tests/scenarios/multiplayer proves it for this card, and "pending"
 * when no live scenario proves it for this card yet (the shared script code may still work). `proven` names the table formats
 * that a live scenario proves, in the order ffa3, ffa4, tag (empty when pending). Both come from CARD_RULE_PROOF below.
 * catalog.test.ts compares CARD_RULE_PROOF with LIVE_PROOF in catalog.ts, which names the scenarios.
 */
export interface MultiplayerCardRule {
  code: number;
  name: string;
  /** The decided rule, in one or two short sentences. */
  rule: string;
  engine: "pending" | "native";
  proven: MultiplayerFormat[];
}

/** An entry of the rule list before `engine` and `proven` are set from CARD_RULE_PROOF. */
type MultiplayerCardRuleDraft = Omit<MultiplayerCardRule, "engine" | "proven">;

const TRIBUTE_TO_FIELD =
  "The card goes to the field of the player whose monster was Tributed. In Tag, that player is an opposing member.";
const KAIJU_RULE = `${TRIBUTE_TO_FIELD} The summon with no Tribute needs a Kaiju on the field of any opponent and goes to your own field. If the opponent picked for the Tribute is eliminated before the summon is done, the card is not summoned and stays in your hand.`;
const RA_RULE = "All Tributed monsters come from ONE opponent, and the card goes to the field of that opponent. In Tag, that opponent is an opposing member.";

const MYSTIC_MINE_RULE =
  "Only an opponent that alone controls more monsters than you is locked (no monster effect, no attack). The sum of two opponents does not count. You are locked if at least one opponent controls fewer monsters than you. It destroys itself in the End Phase only when every living player controls the same number of monsters. In Tag, compare the joined monster counts of the two teams.";
const NUMERON_DRAGON_RULE =
  "It is offered only when a direct attack goes at YOU (in Tag, at your team). A direct attack at another seat does not offer it. Each duelist Sets from its own Graveyard.";
const ULTIMATE_SKY_RULE =
  "In free-for-all, you pick one opponent when you activate it. The card is offered when ONE opponent controls more monsters than you, and it reads only that opponent.";
const DICE_JAR_RULE =
  "You and one opponent, picked when it flips, each roll a die. Only the side that loses the roll takes the damage, and nobody else changes. In Tag, the team LP takes it.";

const PICK_ONE_COUNT =
  "In free-for-all, you pick one opponent when you activate it. The card compares you with that opponent only.";
const JOINED_COUNT = "In Tag, the fields of the two opposing members are joined, and the opposing team chooses from its joined field.";
const OPPONENT_FIELD_SUMMON =
  "The summoning player picks one opponent when they summon. The card or the tokens go to the field of that opponent. In Tag, that opponent is an opposing member.";

/**
 * Cards with an effect that Special Summons a card or tokens to the field of an opponent
 * (`Duel.SpecialSummon(..., tp, 1-tp, ...)` in the card script). Found by a scan of the card scripts.
 * Each one gets OPPONENT_FIELD_SUMMON. The scenario test checks that the scan finds no card that is missing here.
 */
const OPPONENT_FIELD_EFFECT_SUMMON: readonly (readonly [number, string])[] = [
  [131182, "Miracle Flipper"],
  [561300, "Poisonous Viper"],
  [1041278, "Branded Expulsion"],
  [3376703, "Arcana Force V - The Hierophant"],
  [3685372, "CXyz Gimmick Puppet Fanatix Machinix"],
  [6203182, "Two Toads with One Sting"],
  [7392745, "Chewbone"],
  [7623640, "Ceruli, Guru of Dark World"],
  [8837932, "Cubic Mandala"],
  [9400127, "Flogos, the Ogdoadic Boundless"],
  [10158145, "Knightmare Corruptor Iblee"],
  [11654067, "Fire Ejection"],
  [11677278, "Mimighoul Armor"],
  [13204145, "Mimighoul Maker"],
  [13452889, "Vector Scare Archfiend"],
  [13935001, "Lunalight Serenade Dance"],
  [14283055, "Concours de Cuisine (Culinary Confrontation)"],
  [14470845, "Ojama Duo"],
  [17000165, "Reptilianne Recoil"],
  [17228908, "Lost World"],
  [22404675, "Mithra the Thunder Vassal"],
  [22411609, "Volcanic Trooper"],
  [23920796, "Mimighoul Cerberus"],
  [25131968, "Ken the Warrior Dragon"],
  [26259179, "Couple of Aces"],
  [26364381, "Demiurge Ema"],
  [26913989, "Geistgrinder Golem"],
  [26964762, "Destiny HERO - Dark Angel"],
  [28062325, "Bamboo Scrap"],
  [29843091, "Ojama Trio"],
  [30069398, "Wall of Ivy"],
  [31313405, "Salamangreat Pyro Phoenix"],
  [31322640, "Allure Palace"],
  [33970665, "Guts of Steel"],
  [34968834, "Lucent, Netherlord of Dark World"],
  [36890111, "Mansion of the Dreadful Dolls"],
  [37129797, "Vampire Sucker"],
  [38041940, "Seed of Flame"],
  [38811586, "Albion the Sanctifire Dragon"],
  [39829561, "Destiny HERO - Departed"],
  [40343749, "House Duston"],
  [41141943, "Superheavy Samurai Transporter"],
  [42956963, "Nightmare Archfiends"],
  [43066927, "Mimighoul Fairy"],
  [44265115, "Brain Controller"],
  [44689688, "Jurrac Spinos"],
  [46647144, "World Legacy - \"World Lance\""],
  [47126872, "Space-Time Police"],
  [48228390, "Pyrite Knight"],
  [49966595, "Graydle Parasite"],
  [50415441, "Mimighoul Archfiend"],
  [52126602, "Gen the Diamond Tiger"],
  [52782439, "Exceptional Schedule"],
  [54191698, "Number 29: Mannequin Cat"],
  [54658815, "Remote Rebirth"],
  [55465441, "Give and Take"],
  [56562619, "Black Dragon Ninja"],
  [57357130, "Salamangreat Weasel"],
  [57844634, "Nimble Musasabi"],
  [59900655, "Gold Pride - Nytro Head"],
  [61665245, "Summon Sorceress"],
  [62767644, "Inferno of the Ashened"],
  [63013339, "Sky Striker Ace - Camellia"],
  [63086455, "Terrors of the Overroot"],
  [65477143, "Abyss Actor - Liberty Dramatist"],
  [65676461, "Number 32: Shark Drake"],
  [66094973, "Transforming Sphere"],
  [66661678, "Royal Knight of the Ice Barrier"],
  [67508932, "Timelord Progenitor Vorpgate"],
  [68378605, "Vodnika the Fountain Spirit"],
  [69811710, "Girsu, the Orcust Mekk-Knight"],
  [71015787, "Silent Wobby"],
  [71645242, "Black Garden"],
  [72554664, "Light of the Branded"],
  [73355951, "Alpha Summon"],
  [74440055, "Cactus Fighter"],
  [75524092, "Vicious Claw"],
  [76384284, "Trojan Gladiator Beast"],
  [76683171, "Worm Ugly"],
  [78610936, "Xyz Encore"],
  [78783557, "Veidos the Eruption Dragon of Extinction"],
  [80044027, "Mikanko Fire Dance"],
  [80551022, "Mimighoul Slime"],
  [80978111, "Flying \"C\""],
  [81003500, "Elemental HERO Necroid Shaman"],
  [81522098, "Mimighoul Dragon"],
  [81794107, "R.B. Lambda Cannon"],
  [82012319, "Scrap Golem"],
  [82773292, "Indulged Darklord"],
  [82933935, "Mimighoul Flower"],
  [82994509, "Horseytail"],
  [83778600, "Foolish Revival"],
  [85698115, "Terrors of the Afterroot"],
  [87170768, "Contact \"C\""],
  [88124568, "SPYRAL Double Agent"],
  [90884403, "Phantasmal Lord Ultimitl Bishbaalkin"],
  [93775296, "Reverse Reuse"],
  [93912845, "Revival Gift"],
  [93983867, "Trick Box"],
  [96857854, "Diamond Duston"],
  [99229085, "Gimmick Puppet Cattle Scream"],
  [99330325, "Interrupted Kaiju Slumber"],
];

const CARD_RULE_DRAFTS: readonly MultiplayerCardRuleDraft[] = [
  // --- Kaiju and Lava summon: Tribute a monster of an opponent, the card goes to that opponent's field
  { code: 55063751, name: "Gameciel, the Sea Turtle Kaiju", rule: KAIJU_RULE },
  { code: 28674152, name: "Radian, the Multidimensional Kaiju", rule: KAIJU_RULE },
  { code: 29726552, name: "Kumongous, the Sticky String Kaiju", rule: KAIJU_RULE },
  { code: 36956512, name: "Gadarla, the Mystery Dust Kaiju", rule: KAIJU_RULE },
  { code: 48770333, name: "Thunder King, the Lightningstrike Kaiju", rule: KAIJU_RULE },
  { code: 63941210, name: "Jizukiru, the Star Destroying Kaiju", rule: KAIJU_RULE },
  { code: 93332803, name: "Dogoran, the Mad Flame Kaiju", rule: KAIJU_RULE },
  { code: 102380, name: "Lava Golem", rule: `${TRIBUTE_TO_FIELD} It must Tribute 2 monsters of the same opponent.` },
  { code: 63014935, name: "Volcanic Queen", rule: TRIBUTE_TO_FIELD },
  { code: 25920413, name: "Alien Skull", rule: TRIBUTE_TO_FIELD },
  { code: 46565218, name: "Santa Claws", rule: TRIBUTE_TO_FIELD },
  { code: 10000080, name: "The Winged Dragon of Ra - Sphere Mode", rule: RA_RULE },
  { code: 33331231, name: "Surgical Striker - H.A.M.P.", rule: "In the procedure for an opponent field, the card goes to the field of the player whose monster was Tributed. In Tag, that player is an opposing member." },
  // --- Special Summon procedure to the field of an opponent (the card, or tokens, goes to the opponent's field)
  { code: 64203620, name: "Jormungardr the Nordic Serpent", rule: OPPONENT_FIELD_SUMMON },
  { code: 91697229, name: "Fenrir the Nordic Wolf", rule: OPPONENT_FIELD_SUMMON },
  { code: 75732622, name: "Grinder Golem", rule: OPPONENT_FIELD_SUMMON },
  { code: 82090807, name: "Fallen of Argyros", rule: OPPONENT_FIELD_SUMMON },
  // --- count rules: one opponent in free-for-all, the joined opposing fields in Tag
  { code: 90669991, name: "Pineapple Blast", rule: `${PICK_ONE_COUNT} Only the monsters of that opponent are destroyed, and that opponent chooses their own monsters, as in 1v1. ${JOINED_COUNT} The count uses the monsters of both opposing members together.` },
  { code: 15693423, name: "Evenly Matched", rule: `${PICK_ONE_COUNT} Only the cards of that opponent are banished, and that opponent chooses their own cards, as in 1v1. ${JOINED_COUNT} The count uses the cards of both opposing members together.` },
  // --- effect that Special Summons a card or tokens to the field of an opponent
  ...OPPONENT_FIELD_EFFECT_SUMMON.map(([code, name]) => ({ code, name, rule: OPPONENT_FIELD_SUMMON })),
  // --- other cards that compare you with the opponents, or roll against one opponent (owner-reviewed 2026-10-01)
  { code: 76375976, name: "Mystic Mine", rule: MYSTIC_MINE_RULE },
  { code: 57314798, name: "Number 100: Numeron Dragon", rule: NUMERON_DRAGON_RULE },
  { code: 38817295, name: "Ultimate Sky", rule: ULTIMATE_SKY_RULE },
  { code: 3549275, name: "Dice Jar", rule: DICE_JAR_RULE },
  // --- the other cards use the defaults
  { code: 44656491, name: "Messenger of Peace", rule: "You pay the 100 LP only in your own Standby Phase. In Tag, only the Standby Phase of your own duelist turn counts, and the team LP pays." },
  { code: 72405967, name: "Royal Tribute", rule: "Every opponent discards the monsters in their hand. As in 1v1, you discard yours too. In Tag, 'both players' means every duelist, the partner included (R-COMMON-EACH-PLAYER)." },
  { code: 68005187, name: "Soul Exchange", rule: "You may target 1 monster of any opponent. This turn, a Tribute may use it as if you controlled it." },
  { code: 45986603, name: "Snatch Steal", rule: "The owner of the monster gains the 1000 LP, in the own Standby Phase of that owner. In Tag, the Standby Phase of the own duelist turn counts, and the team LP gains." },
];

/**
 * Table formats where a live scenario proves the rule of one card (by passcode). Add a card here only when the outcome of a
 * scenario in tests/scenarios/multiplayer asserts the rule of THAT card at that table. A card whose script shares code with a
 * proven card stays "pending" until it has a scenario of its own. catalog.test.ts compares this with LIVE_PROOF in catalog.ts.
 */
export const CARD_RULE_PROOF: Readonly<Record<number, readonly MultiplayerFormat[]>> = {
  55063751: ["ffa3", "ffa4", "tag"], // Gameciel (Kaiju procedure)
  102380: ["ffa3", "ffa4", "tag"], // Lava Golem
  63014935: ["ffa3"], // Volcanic Queen
  10000080: ["ffa3"], // The Winged Dragon of Ra - Sphere Mode
  90669991: ["ffa3", "ffa4", "tag"], // Pineapple Blast
  15693423: ["ffa3", "ffa4", "tag"], // Evenly Matched
  29843091: ["ffa3", "ffa4", "tag"], // Ojama Trio
  71645242: ["ffa3", "tag"], // Black Garden
  80551022: ["ffa3"], // Mimighoul Slime
  83778600: ["ffa3", "ffa4", "tag"], // Foolish Revival
  76375976: ["ffa3", "ffa4", "tag"], // Mystic Mine
  57314798: ["ffa3"], // Number 100: Numeron Dragon
  38817295: ["ffa3"], // Ultimate Sky
  3549275: ["ffa3", "ffa4", "tag"], // Dice Jar
  72405967: ["ffa3", "ffa4", "tag"], // Royal Tribute
  44656491: ["ffa3", "ffa4", "tag"], // Messenger of Peace
  28674152: ["ffa3", "ffa4", "tag"], // Radian (Kaiju procedure)
  29726552: ["ffa3", "ffa4", "tag"], // Kumongous (Kaiju procedure)
  36956512: ["ffa3", "ffa4", "tag"], // Gadarla (Kaiju procedure)
  48770333: ["ffa3", "ffa4", "tag"], // Thunder King (Kaiju procedure)
  63941210: ["ffa3", "ffa4", "tag"], // Jizukiru (Kaiju procedure)
  93332803: ["ffa3", "ffa4", "tag"], // Dogoran (Kaiju procedure)
  25920413: ["ffa3", "ffa4", "tag"], // Alien Skull (Lava procedure)
  46565218: ["ffa3", "ffa4", "tag"], // Santa Claws (Lava procedure)
  33331231: ["ffa3", "ffa4", "tag"], // H.A.M.P. (Lava procedure, both fields)
  64203620: ["ffa3", "ffa4", "tag"], // Jormungardr (Nordic)
  91697229: ["ffa3", "ffa4", "tag"], // Fenrir (Nordic)
  75732622: ["ffa3", "ffa4", "tag"], // Grinder Golem
  82090807: ["ffa3", "ffa4", "tag"], // Fallen of Argyros
  11654067: ["ffa3", "ffa4", "tag"], // Fire Ejection
  14470845: ["ffa3", "ffa4", "tag"], // Ojama Duo
  28062325: ["ffa3", "ffa4", "tag"], // Bamboo Scrap
  42956963: ["ffa3", "ffa4", "tag"], // Nightmare Archfiends
  55465441: ["ffa3", "ffa4", "tag"], // Give and Take
  6203182: ["ffa3", "ffa4", "tag"], // Two Toads with One Sting
  17228908: ["ffa3", "ffa4", "tag"], // Lost World
  33970665: ["ffa3", "ffa4", "tag"], // Guts of Steel
  36890111: ["ffa3", "ffa4", "tag"], // Mansion of the Dreadful Dolls
  52782439: ["ffa3", "ffa4", "tag"], // Exceptional Schedule
  62767644: ["ffa3", "ffa4", "tag"], // Inferno of the Ashened
  72554664: ["ffa3", "ffa4", "tag"], // Light of the Branded
  73355951: ["ffa3", "ffa4", "tag"], // Alpha Summon
  76384284: ["ffa3", "ffa4", "tag"], // Trojan Gladiator Beast
  78610936: ["ffa3", "ffa4", "tag"], // Xyz Encore
  80044027: ["ffa3", "ffa4", "tag"], // Mikanko Fire Dance
  93775296: ["ffa3", "ffa4", "tag"], // Reverse Reuse
  93912845: ["ffa3", "ffa4", "tag"], // Revival Gift
  99330325: ["ffa3", "ffa4", "tag"], // Interrupted Kaiju Slumber
  1041278: ["ffa3", "ffa4", "tag"], // Branded Expulsion
  8837932: ["ffa3", "ffa4", "tag"], // Cubic Mandala
  13204145: ["ffa3", "ffa4", "tag"], // Mimighoul Maker
  13935001: ["ffa3", "ffa4", "tag"], // Lunalight Serenade Dance
  14283055: ["ffa3", "ffa4", "tag"], // Concours de Cuisine
  49966595: ["ffa3", "ffa4", "tag"], // Graydle Parasite
  63086455: ["ffa3", "ffa4", "tag"], // Terrors of the Overroot
  85698115: ["ffa3", "ffa4", "tag"], // Terrors of the Afterroot
  93983867: ["ffa3", "ffa4", "tag"], // Trick Box
  96857854: ["ffa3", "ffa4", "tag"], // Diamond Duston
  561300: ["ffa3", "ffa4", "tag"], // Poisonous Viper
  7392745: ["ffa3", "ffa4", "tag"], // Chewbone
  7623640: ["ffa3", "ffa4", "tag"], // Ceruli, Guru of Dark World
  11677278: ["ffa3", "ffa4", "tag"], // Mimighoul Armor
  22404675: ["ffa3", "ffa4", "tag"], // Mithra the Thunder Vassal
  22411609: ["ffa3", "ffa4", "tag"], // Volcanic Trooper
  23920796: ["ffa3", "ffa4", "tag"], // Mimighoul Cerberus
  25131968: ["ffa3", "ffa4", "tag"], // Ken the Warrior Dragon
  26964762: ["ffa3", "ffa4", "tag"], // Destiny HERO - Dark Angel
  30069398: ["ffa3", "ffa4", "tag"], // Wall of Ivy
  37129797: ["ffa3", "ffa4", "tag"], // Vampire Sucker
  38041940: ["ffa3", "ffa4", "tag"], // Seed of Flame
  39829561: ["ffa3", "ffa4", "tag"], // Destiny HERO - Departed
  41141943: ["ffa3", "ffa4", "tag"], // Superheavy Samurai Transporter
  43066927: ["ffa3", "ffa4", "tag"], // Mimighoul Fairy
  44689688: ["ffa3", "ffa4", "tag"], // Jurrac Spinos
  48228390: ["ffa3", "ffa4", "tag"], // Pyrite Knight
  50415441: ["ffa3", "ffa4", "tag"], // Mimighoul Archfiend
  52126602: ["ffa3", "ffa4", "tag"], // Gen the Diamond Tiger
  54191698: ["ffa3", "ffa4", "tag"], // Number 29: Mannequin Cat
  74440055: ["ffa3", "ffa4", "tag"], // Cactus Fighter
  81522098: ["ffa3", "ffa4", "tag"], // Mimighoul Dragon
  82933935: ["ffa3", "ffa4", "tag"], // Mimighoul Flower
  69811710: ["ffa3", "ffa4", "tag"], // Girsu, the Orcust Mekk-Knight
  82012319: ["ffa3", "ffa4", "tag"], // Scrap Golem
  9400127: ["ffa3", "ffa4", "tag"], // Flogos, the Wind Warrior
  78783557: ["ffa3", "ffa4", "tag"], // Veidos the Eruption Dragon of Extinction
  82773292: ["ffa3", "ffa4", "tag"], // Indulged Darklord
  88124568: ["ffa3", "ffa4", "tag"], // SPYRAL Double Agent
  71015787: ["ffa3", "ffa4", "tag"], // Silent Wobby
  68378605: ["ffa3", "ffa4", "tag"], // Vodnika the Water Dragon
  26913989: ["ffa3", "ffa4", "tag"], // Geistgrinder Golem
  82994509: ["ffa3", "ffa4", "tag"], // Horseytail
  81003500: ["ffa3", "ffa4", "tag"], // Necroid Shaman
  66661678: ["ffa3", "ffa4", "tag"], // Royal Knight of the Ice Barrier
  57844634: ["ffa3", "ffa4", "tag"], // Nimble Musasabi
  65676461: ["ffa3", "ffa4", "tag"], // Number 32: Shark Drake
  59900655: ["ffa3", "ffa4", "tag"], // Gold Pride - Nytro Head
  63013339: ["ffa3", "ffa4", "tag"], // Sky Striker Ace - Camellia
  65477143: ["ffa3", "ffa4", "tag"], // Abyss Actor - Liberty Dramatist
  40343749: ["ffa3", "ffa4", "tag"], // House Duston
  3685372: ["ffa3", "ffa4", "tag"], // CXyz Gimmick Puppet Fanatix Machinix
  47126872: ["ffa3", "ffa4", "tag"], // Space-Time Police
};

export const MULTIPLAYER_CARD_RULES: readonly MultiplayerCardRule[] = CARD_RULE_DRAFTS.map((draft) => {
  const proven = [...(CARD_RULE_PROOF[draft.code] ?? [])];
  return { ...draft, engine: proven.length > 0 ? "native" : "pending", proven };
});

const TABLE_FORMAT: Record<Exclude<MultiplayerTable, "1v1">, MultiplayerFormat> = {
  tag: "tag",
  ffa3: "ffa3",
  ffa4: "ffa4",
};

export const MULTIPLAYER_TABLE_LABEL: Record<Exclude<MultiplayerTable, "1v1">, string> = {
  tag: "2v2 Tag Duel",
  ffa3: "3-player free-for-all",
  ffa4: "4-player free-for-all",
};

const BY_CODE = new Map<number, MultiplayerForbidden>(MULTIPLAYER_FORBIDDEN.map((entry) => [entry.code, entry]));

/**
 * Find the forbidden entry for a card at a table. `alias` is the `alias` column of cards.cdb:
 * an alternate art has alias = passcode of the original card, so it matches the same entry.
 * Returns undefined for the "1v1" table.
 */
export function multiplayerForbiddenFor(
  table: MultiplayerTable,
  code: number,
  alias = 0,
): MultiplayerForbidden | undefined {
  if (table === "1v1") return undefined;
  const format = TABLE_FORMAT[table];
  const entry = BY_CODE.get(code) ?? (alias ? BY_CODE.get(alias) : undefined);
  return entry && entry.formats.includes(format) ? entry : undefined;
}
