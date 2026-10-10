// Multiplayer card scenario catalog (Layer 1 sketches). The sketch data stays as written (`pending: true`).
// LIVE_PROOF at the end of this file lists the cards whose multiplayer result a live scenario already proves on the real core.
// Rules: docs/adr/0002-multiplayer-duel-rules.md. Spec: docs/specs/2026-09-30-multiplayer-core-design.md.
// Doc: docs/specs/2026-09-30-multiplayer-card-scenarios.md (generated tables use this data).
// Seats: P0 is the activator. In Tag, P0 and P2 are one team, P1 and P3 are the other team.

export type CatalogFormat = "ffa3" | "ffa4" | "tag";
/** U = unchanged, C = core rule, O = per-card override. */
export type RuleClass = "U" | "C" | "O";
/** Where the "one opponent" comes from (spec 4.2). */
export type Binding = "explicit-pick" | "event-opponent" | "target-controller";

export interface Evidence {
  /** Stock script path; overlay/ names an overlay file, manifest/CODE names its entry. */
  file: string;
  line: number;
  /** Text on the script line, or kind:KIND for a manifest entry (line 0). */
  token: string;
}

export interface CatalogScenario {
  id: string;
  group: "all" | "one";
  card: string;
  code: number;
  formats: CatalogFormat[];
  ruleClass: RuleClass;
  binding?: Binding;
  /** Behavior in a normal 1v1 duel. */
  oneVsOne: string;
  /** Expected result per table. */
  results: { ffa3: string; ffa4: string; tag: string };
  evidence: Evidence[];
  setup: string;
  action: string;
  expected: string;
  /** True when the card is also on the forbidden list. The sketch tests a future override. */
  forbidden?: boolean;
  /** ADR-0002 rule ids this scenario tests (see docs/adr/0002-multiplayer-duel-rules.md). */
  rules: string[];
  pending: true;
}

const ALL3: CatalogFormat[] = ["ffa3", "ffa4", "tag"];

const ev = (code: number, line: number, token: string): Evidence => ({ file: `official/c${code}.lua`, line, token });

type Row = Omit<CatalogScenario, "id" | "group" | "pending" | "formats" | "rules"> & { formats?: CatalogFormat[] };

/** Rule ids that a card tests beyond the default of its group (by passcode). */
const EXTRA_RULES: Record<number, string[]> = {
  // Effects on both sides of the field.
  53129443: ["R-COMMON-ALL-BOTH"], // Dark Hole
  19613556: ["R-COMMON-ALL-BOTH"], // Heavy Storm
  42703248: ["R-COMMON-ALL-BOTH"], // Giant Trunade
  53582587: ["R-COMMON-ALL-BOTH"], // Torrential Tribute
  // Ongoing effects on "your opponent".
  72302403: ["R-COMMON-ONGOING", "R-FFA-SWORDS-PROTECT"], // Swords: owner exception, 2026-10-02 night.
  85742772: ["R-COMMON-ONGOING"], // Gravity Bind
  44947065: ["R-COMMON-ONGOING"], // Burden of the Mighty
  51452091: ["R-COMMON-ONGOING", "R-COMMON-CONT-NEG"], // Royal Decree
  58921041: ["R-COMMON-ONGOING", "R-COMMON-CONT-NEG"], // Anti-Spell Fragrance
  77585513: ["R-COMMON-CONT-NEG"], // Jinzo
  82732705: ["R-COMMON-CONT-NEG"], // Skill Drain
  // Both players / each player.
  31036355: ["R-COMMON-EACH-PLAYER", "R-FFA-RESOURCE-ROTATION", "R-TAG-SHARED-CARDS"],
  81674782: ["R-COMMON-EACH-PLAYER"], // Dimensional Fissure
  30241314: ["R-COMMON-EACH-PLAYER"], // Macro Cosmos
  72405967: ["R-COMMON-EACH-PLAYER"], // Royal Tribute
  35480699: ["R-COMMON-ALL-BOTH"], // Book of Eclipse first flips every seat
  5010422: ["R-TAG-PARTNER", "R-TAG-LP"], // Astromorrigan keeps the Tag fields and shared LP.
  35316708: ["R-FFA-ACTIVATED-LOCK", "R-FFA-DECLARED-DURATION", "R-FFA-FIRST-DRAW"], // Time Seal counts the declared seat's next Draw Phase.
  // Partner cards count for "you control".
  2314238: ["R-TAG-SHARED-CARDS"], // Dark Magic Attack
  // A card that works only on an opponent (or negates one activation) never hits the partner.
  97268402: ["R-TAG-PARTNER"], // Effect Veiler
  10045474: ["R-TAG-PARTNER"], // Infinite Impermanence
  14558127: ["R-TAG-PARTNER", "R-FFA-NEGATE"], // Ash Blossom & Joyous Spring
  41420027: ["R-TAG-PARTNER", "R-FFA-NEGATE"], // Solemn Judgment
  // Attacks.
  44095762: ["R-FFA-ATTACK", "R-FFA-OPP-RESPONSE"], // Mirror Force
  88240808: ["R-FFA-OPP-RESPONSE"], // Kycoo binds the opponent that took the battle damage.
  56120475: ["R-FFA-ATTACK"], // Sakuretsu Armor
  70342110: ["R-FFA-ATTACK"], // Dimensional Prison
};

const rulesOf = (group: "all" | "one", row: Row): string[] => {
  const extra = EXTRA_RULES[row.code] ?? [];
  const base = row.code === 31036355 ? [] : group === "one"
    ? [row.binding === "event-opponent" ? "R-FFA-OPP-RESPONSE" : "R-FFA-OPP-ONE", ...(row.binding === "explicit-pick" ? ["R-COMMON-OPP-PICK"] : [])]
    : row.code === 70095154 ? ["R-FFA-OPP-ONE"] // Cyber Dragon: one opponent meeting its condition is enough.
    : row.code === 32807846 ? ["R-COMMON-OPP-PICK"] // Informational hints still reach every opponent.
    : extra.includes("R-COMMON-ONGOING") || extra.includes("R-COMMON-CONT-NEG") ? []
    : ["R-COMMON-ALL-BOTH"];
  return [...new Set([...base, ...extra])];

};

const all = (row: Row): CatalogScenario => ({
  id: `mp-all-${row.code}`,
  group: "all",
  formats: ALL3,
  ...row,
  rules: rulesOf("all", row),
  pending: true,
});
const one = (row: Row): CatalogScenario => ({
  id: `mp-one-${row.code}`,
  group: "one",
  formats: ALL3,
  ...row,
  rules: rulesOf("one", row),
  pending: true,
});

const U = "Same as 1v1.";

/** Group (a): all-seat effects, face-up ongoing effects and no-resource checks. */
export const GROUP_ALL: CatalogScenario[] = [
  all({
    card: "Swords of Revealing Light", code: 72302403, ruleClass: "O",
    oneVsOne: "The opponent cannot attack for three opponent turns. Its face-down monsters are flipped.",
    results: {
      ffa3: "Protects its controller and their monsters. Other opponents can attack each other. Each opponent turn counts.",
      ffa4: "Protects its controller and their monsters. Other opponents can attack each other. Each opponent turn counts.",
      tag: "Keeps the stock attack lock on both opponents. The partner can attack. Each opposing turn counts.",
    },
    evidence: [ev(72302403, 41, "RESET_OPPO_TURN,3"), ev(72302403, 63, "IsTurnPlayer(1-tp)"),
      { file: "overlay/c72302403.lua", line: 24, token: "EFFECT_CANNOT_BE_DIRECT_ATTACKED" },
      { file: "manifest/72302403", line: 0, token: "kind:fix" }],
    setup: "Every seat has a monster. Repeat with an empty controller field.",
    action: "Activate Swords. Check each opponent's attack targets and the third opponent End Phase.",
    expected: "In FFA, only attacks against the controller and their monsters are refused. Swords goes to the GY after three opponent turns.",
  }),
  all({
    card: "Creature Swap", code: 31036355, ruleClass: "O",
    oneVsOne: "Each player picks 1 monster. The players swap control of them.",
    results: {
      ffa3: "Each living duelist must control a monster. Each chooses one in turn order. Each chosen monster goes to the next living seat.",
      ffa4: "Each living duelist chooses one monster. The monsters rotate to the next living seat, including when all Main Monster Zones are full.",
      tag: "The activator and one opposing duelist each choose one monster from their team field. The two monsters swap control.",
    },
    evidence: [ev(31036355, 28, "SelectMatchingCard(tp,s.filter,tp,LOCATION_MZONE,0,1,1,nil)"), ev(31036355, 31, "SelectMatchingCard(1-tp"), ev(31036355, 35, "SwapControl(c1,c2,0,0)")],
    setup: "Each living duelist controls a monster. P0 has Creature Swap.",
    action: "P0 activates Creature Swap. Each affected duelist chooses one monster.",
    expected: "In FFA, each chosen monster goes to the next living seat. In Tag, the two chosen monsters swap control.",
  }),
  all({
    card: "Dark Hole", code: 53129443, ruleClass: "U",
    oneVsOne: "Destroys all monsters on the field.",
    results: { ffa3: "Destroys all monsters of all 3 players.", ffa4: "Destroys all monsters of all 4 players.", tag: "Destroys all monsters of all 4 players, the partner and the activator included (ADR-0002, 'all' effects)." },
    evidence: [ev(53129443, 15, "LOCATION_MZONE,LOCATION_MZONE"), ev(53129443, 20, "LOCATION_MZONE,LOCATION_MZONE")],
    setup: "Each seat controls one monster.",
    action: "P0 activates Dark Hole.",
    expected: "All monsters, including the ones of P0 and the partner, go to the GY.",
  }),
  all({
    card: "Heavy Storm", code: 19613556, ruleClass: "U",
    oneVsOne: "Destroys all Spells and Traps on the field.",
    results: { ffa3: "Destroys the Spells and Traps of all 3 players.", ffa4: "Destroys the Spells and Traps of all 4 players.", tag: "Destroys the Spells and Traps of all 4 players, the partner included." },
    evidence: [ev(19613556, 19, "LOCATION_ONFIELD,LOCATION_ONFIELD"), ev(19613556, 24, "LOCATION_ONFIELD,LOCATION_ONFIELD")],
    setup: "Each seat controls one Spell or Trap.",
    action: "P0 activates Heavy Storm.",
    expected: "Every Spell and Trap other than Heavy Storm is destroyed.",
  }),
  all({
    card: "Giant Trunade", code: 42703248, ruleClass: "U",
    oneVsOne: "Returns all Spells and Traps on the field to the hand.",
    results: { ffa3: "Returns the Spells and Traps of all 3 players.", ffa4: "Returns the Spells and Traps of all 4 players.", tag: "Returns the Spells and Traps of all 4 players, the partner included." },
    evidence: [ev(42703248, 19, "LOCATION_ONFIELD,LOCATION_ONFIELD"), ev(42703248, 24, "LOCATION_ONFIELD,LOCATION_ONFIELD")],
    setup: "Each seat controls one Spell or Trap.",
    action: "P0 activates Giant Trunade.",
    expected: "Each card returns to the hand of its owner.",
  }),
  all({
    card: "Torrential Tribute", code: 53582587, ruleClass: "U",
    oneVsOne: "When a monster is Summoned, destroys all monsters on the field.",
    results: { ffa3: "Destroys all monsters of all 3 players.", ffa4: "Destroys all monsters of all 4 players.", tag: "Destroys all monsters of all 4 players, the partner included." },
    evidence: [ev(53582587, 29, "LOCATION_MZONE,LOCATION_MZONE"), ev(53582587, 34, "LOCATION_MZONE,LOCATION_MZONE")],
    setup: "P0 has Torrential Tribute set. P1 controls one monster. P2 and P3 (or the partner) control one monster each.",
    action: "P1 Normal Summons a monster. P0 activates Torrential Tribute.",
    expected: "All monsters on the field are destroyed.",
  }),
  all({
    card: "Cyber Dragon", code: 70095154, ruleClass: "U",
    oneVsOne: "If only the opponent controls a monster, you can Special Summon this card from the hand.",
    results: { ffa3: "Legal when P0 controls no monster and any opponent controls one.", ffa4: "Legal when P0 controls no monster and any opponent controls one.", tag: "Legal when the team of P0 controls no monster and any opposing member controls one." },
    evidence: [ev(70095154, 16, "GetFieldGroupCount(c:GetControler(),LOCATION_MZONE,0)==0"), ev(70095154, 17, "GetFieldGroupCount(c:GetControler(),0,LOCATION_MZONE)>0")],
    setup: "P0 has Cyber Dragon in hand and no monster. Only P2 controls a monster.",
    action: "P0 tries to Special Summon Cyber Dragon.",
    expected: "The summon is legal. In Tag, it is illegal if the partner controls a monster.",
  }),
  all({
    card: "Gravity Bind", code: 85742772, ruleClass: "U",
    oneVsOne: "Level 4 or higher monsters cannot attack.",
    results: { ffa3: "No level 4 or higher monster on any of the 3 fields can attack.", ffa4: "No level 4 or higher monster on any of the 4 fields can attack.", tag: "No level 4 or higher monster on any field can attack. The partner is affected too." },
    evidence: [ev(85742772, 15, "SetTargetRange(LOCATION_MZONE,LOCATION_MZONE)")],
    setup: "Each seat controls one level 4 monster. P0 controls Gravity Bind.",
    action: "Each seat tries to declare an attack on its turn.",
    expected: "No attack is possible for any seat.",
  }),
  all({
    card: "Burden of the Mighty", code: 44947065, ruleClass: "U",
    oneVsOne: "Opponent monsters lose 100 ATK for each of their Levels.",
    results: { ffa3: "The monsters of both opponents lose ATK.", ffa4: "The monsters of all 3 opponents lose ATK.", tag: "The monsters of both opposing members lose ATK. The partner monsters do not." },
    evidence: [ev(44947065, 15, "SetTargetRange(0,LOCATION_MZONE)"), ev(44947065, 20, "GetLevel()*-100")],
    setup: "Each other seat controls one level 4 monster with 1800 ATK.",
    action: "P0 activates Burden of the Mighty.",
    expected: "Each opponent monster has 1400 ATK. The monster of the partner has 1800 ATK.",
  }),
  all({
    card: "Skill Drain", code: 82732705, ruleClass: "U",
    oneVsOne: "Pay 1000 LP. Face-up monster effects on the field are negated.",
    results: { ffa3: "Negates the monsters of all 3 players.", ffa4: "Negates the monsters of all 4 players.", tag: "Negates the monsters of all 4 players. The 1000 LP comes from the shared pool." },
    evidence: [ev(82732705, 9, "Cost.PayLP(1000)"), ev(82732705, 15, "SetTargetRange(LOCATION_MZONE,LOCATION_MZONE)")],
    setup: "Each seat controls one effect monster. P0 has Skill Drain set.",
    action: "P0 activates Skill Drain.",
    expected: "The effect of each face-up monster is negated. LP of P0 drops by 1000 (Tag: team LP drops by 1000).",
  }),
  all({
    card: "Judgment Dragon", code: 57774843, ruleClass: "U",
    oneVsOne: "Pay 1000 LP to destroy all other cards on the field.",
    results: { ffa3: "Destroys all other cards of all 3 players.", ffa4: "Destroys all other cards of all 4 players.", tag: "Destroys all other cards of all 4 players, the partner included." },
    evidence: [ev(57774843, 58, "LOCATION_ONFIELD,LOCATION_ONFIELD"), ev(57774843, 62, "LOCATION_ONFIELD,LOCATION_ONFIELD")],
    setup: "Each seat controls one monster and one Spell.",
    action: "P0 activates the effect of Judgment Dragon.",
    expected: "Every other card on the field goes to the GY.",
  }),
  all({
    card: "Hammer Shot", code: 26412047, ruleClass: "U",
    oneVsOne: "Destroys the Attack Position monster with the highest ATK on the field.",
    results: { ffa3: "Looks at all 3 fields.", ffa4: "Looks at all 4 fields.", tag: "Looks at all 4 fields. The monster of the partner can be the target." },
    evidence: [ev(26412047, 18, "LOCATION_MZONE,LOCATION_MZONE"), ev(26412047, 24, "LOCATION_MZONE,LOCATION_MZONE")],
    setup: "P0 and P1 control monsters with 2000 and 2500 ATK. P3 controls one with 1800 ATK.",
    action: "P0 activates Hammer Shot.",
    expected: "The monster with 2500 ATK is destroyed.",
  }),
  all({
    card: "Jinzo", code: 77585513, ruleClass: "U",
    oneVsOne: "Negates all Trap cards on the field, their effects and their activations.",
    results: { ffa3: "Negates the Traps of all 3 players.", ffa4: "Negates the Traps of all 4 players.", tag: "Negates the Traps of all 4 players, the partner included." },
    evidence: [ev(77585513, 11, "SetTargetRange(LOCATION_HAND|LOCATION_SZONE,LOCATION_HAND|LOCATION_SZONE)")],
    setup: "P1 has a Trap set. P0 controls Jinzo.",
    action: "P1 tries to activate the Trap.",
    expected: "P1 cannot activate the Trap. The partner cannot activate a Trap either.",
  }),
  all({
    card: "Vanity's Emptiness", code: 5851097, ruleClass: "U",
    oneVsOne: "Neither player can Special Summon.",
    results: { ffa3: "No player can Special Summon.", ffa4: "No player can Special Summon.", tag: "No player can Special Summon, the partner included." },
    evidence: [ev(5851097, 17, "SetTargetRange(1,1)")],
    setup: "P0 controls Vanity's Emptiness.",
    action: "P1, P2 and P3 try to Special Summon.",
    expected: "All attempts are illegal.",
  }),
  all({
    card: "Dimensional Fissure", code: 81674782, ruleClass: "U",
    oneVsOne: "Monsters that leave the field are banished instead.",
    results: { ffa3: "Applies to all 3 players.", ffa4: "Applies to all 4 players.", tag: "Applies to all 4 players." },
    evidence: [ev(81674782, 17, "SetTargetRange(0xff,0xff)"), ev(81674782, 26, "SetTargetRange(0xff,0xff)")],
    setup: "P0 controls Dimensional Fissure. P3 controls one monster.",
    action: "The monster of P3 is destroyed.",
    expected: "The monster is banished.",
  }),
  all({
    card: "Macro Cosmos", code: 30241314, ruleClass: "U",
    oneVsOne: "Cards sent to the GY are banished instead.",
    results: { ffa3: "Applies to all 3 players.", ffa4: "Applies to all 4 players.", tag: "Applies to all 4 players." },
    evidence: [ev(30241314, 21, "SetTargetRange(0xff,0xff)")],
    setup: "P0 controls Macro Cosmos. P2 controls one monster.",
    action: "The monster of P2 is destroyed.",
    expected: "The monster is banished.",
  }),
  all({
    card: "Imperial Iron Wall", code: 30459350, ruleClass: "U",
    oneVsOne: "Neither player can banish cards.",
    results: { ffa3: "No player can banish cards.", ffa4: "No player can banish cards.", tag: "No player can banish cards." },
    evidence: [ev(30459350, 17, "SetTargetRange(1,1)"), ev(30459350, 25, "SetTargetRange(1,1)")],
    setup: "P0 controls Imperial Iron Wall.",
    action: "P2 tries to banish a card.",
    expected: "The banish is illegal.",
  }),
  all({
    card: "Anti-Spell Fragrance", code: 58921041, ruleClass: "U",
    oneVsOne: "Spells must be Set first. A Spell cannot be activated the turn it is Set.",
    results: { ffa3: "Applies to all 3 players.", ffa4: "Applies to all 4 players.", tag: "Applies to all 4 players." },
    evidence: [ev(58921041, 16, "SetTargetRange(1,1)")],
    setup: "P0 controls Anti-Spell Fragrance. P1 has a Spell in hand.",
    action: "P1 tries to activate the Spell from the hand.",
    expected: "The activation is illegal. The player can Set it and activate it next turn.",
  }),
  all({
    card: "Royal Decree", code: 51452091, ruleClass: "U",
    oneVsOne: "Negates all other Trap effects.",
    results: { ffa3: "Negates the Traps of all 3 players.", ffa4: "Negates the Traps of all 4 players.", tag: "Negates the Traps of all 4 players." },
    evidence: [ev(51452091, 16, "SetTargetRange(LOCATION_SZONE,LOCATION_SZONE)"), ev(51452091, 31, "SetTargetRange(LOCATION_MZONE,LOCATION_MZONE)")],
    setup: "P0 controls Royal Decree. P1 activates a Trap.",
    action: "P1 tries to activate a Trap.",
    expected: "The Trap effect is negated.",
  }),
  all({
    card: "Reinforcement of the Army", code: 32807846, ruleClass: "U",
    oneVsOne: "Adds a Warrior monster from the Deck to the hand and shows it to the opponent.",
    results: { ffa3: "Shows the card to both opponents.", ffa4: "Shows the card to all 3 opponents.", tag: "Shows the card to both opposing members. The partner may see it by the team rule; the ADR leaves this to Layer 3." },
    evidence: [ev(32807846, 26, "Duel.ConfirmCards(1-tp,g)")],
    setup: "P0 has a Warrior in the Deck.",
    action: "P0 activates Reinforcement of the Army.",
    expected: "All opponents see the added card (ConfirmCards(1-tp) reaches all opponents).",
  }),
  all({
    card: "Royal Tribute", code: 72405967, ruleClass: "O",
    oneVsOne: "If you control Necrovalley, both players discard any monsters in their hands.",
    results: { ffa3: "Both opponents discard the monsters in their hand. P0 discards theirs too (owner decision 2026-10-01).", ffa4: "All 3 opponents discard the monsters in their hand. P0 discards theirs too.", tag: "Both opposing members discard the monsters in their hand. P0 discards theirs too. The partner discards too: 'both players' means every duelist, the partner included (R-COMMON-EACH-PLAYER, owner decision 2026-10-01)." },
    evidence: [ev(72405967, 22, "GetMatchingGroup(Card.IsMonster,tp,LOCATION_HAND,LOCATION_HAND")],
    setup: "P0 controls Necrovalley. Each other seat holds one monster and one Spell.",
    action: "P0 activates Royal Tribute.",
    expected: "Every monster in every hand goes to the GY. The Spells stay in the hands. There is no opponent pick.",
  }),
];

/** Group (b): the effect touches ONE opponent. `binding` names the source (spec 4.2). */
export const GROUP_ONE: CatalogScenario[] = [
  one({
    card: "Time Seal", code: 35316708, ruleClass: "C", binding: "explicit-pick", formats: ["ffa3"],
    oneVsOne: "Skips the Draw Phase of the opponent's next turn.",
    results: {
      ffa3: "Only the opponent declared at activation skips its next Draw Phase. Other opponents' turns do not end the lock (core 0072, W18). If the declared seat leaves, the lock does not move to another seat.",
      ffa4: "The same declared-opponent rule applies; no FFA4 live proof is registered here.",
      tag: "The stock opposing-turn count stays; no Tag live proof is registered here.",
    },
    evidence: [ev(35316708, 18, "EFFECT_SKIP_DP"), ev(35316708, 22, "RESET_PHASE|PHASE_DRAW|RESET_OPPO_TURN"), ev(35316708, 24, "Duel.RegisterEffect(e1,tp)")],
    setup: "P0 has Time Seal set. Each seat has a 20-card Deck.",
    action: "P0 activates Time Seal and declares P2. P1 takes its turn first.",
    expected: "P1 draws on both turns. P2 skips its first Draw Phase and draws on its second turn. No other seat is locked.",
  }),
  // These IDs stay stable when their rows move to the one-opponent group.
  one({
    card: "Raigeki", code: 12580477, ruleClass: "C", binding: "explicit-pick",
    oneVsOne: "Destroys all monsters of the opponent.",
    results: { ffa3: "Destroys only the monsters of the opponent declared at activation.", ffa4: "Destroys only the monsters of one opponent declared at activation; the other two keep theirs.", tag: "Destroys the monsters of both opposing team members. The partner keeps its monsters." },
    evidence: [ev(12580477, 16, "GetMatchingGroup(aux.TRUE,tp,0,LOCATION_MZONE"), ev(12580477, 20, "GetMatchingGroup(aux.TRUE,tp,0,LOCATION_MZONE")],
    setup: "P0 holds Raigeki. Each other seat controls one monster. In Tag, P2 (partner) controls one monster.",
    action: "P0 activates Raigeki.",
    expected: "FFA: only the declared opponent loses its monsters. Tag: both opposing members lose theirs; the partner keeps its monster.",
  }),
  one({
    card: "Harpie's Feather Duster", code: 18144506, ruleClass: "C", binding: "explicit-pick",
    oneVsOne: "Destroys all Spells and Traps of the opponent.",
    results: { ffa3: "Destroys only the Spells and Traps of the opponent declared at activation.", ffa4: "Destroys only the Spells and Traps of one declared opponent; the other two keep theirs.", tag: "Destroys the Spells and Traps of both opposing team members. The partner is safe." },
    evidence: [ev(18144506, 19, "0,LOCATION_ONFIELD"), ev(18144506, 24, "0,LOCATION_ONFIELD")],
    setup: "Each other seat controls one set Spell. The partner (Tag) controls one set Spell.",
    action: "P0 activates Harpie's Feather Duster.",
    expected: "FFA: only the declared opponent loses its Spells and Traps. Tag: both opposing fields lose them; the partner keeps its Spell.",
  }),
  one({
    card: "Mirror Force", code: 44095762, ruleClass: "C", binding: "event-opponent",
    oneVsOne: "When an opponent monster attacks, destroys all attack position monsters of the opponent.",
    results: { ffa3: "Any opponent of the attacker can respond; only the attacker loses its Attack Position monsters.", ffa4: "Any opponent of the attacker can respond; only the attacker loses its Attack Position monsters.", tag: "When an opposing monster attacks, destroys the attack position monsters of both opposing members. The partner is safe." },
    evidence: [ev(44095762, 16, "IsTurnPlayer(1-tp)"), ev(44095762, 27, "GetMatchingGroup(s.filter,tp,0,LOCATION_MZONE")],
    setup: "P0 has Mirror Force set. P1 and P2 each control one attack position monster. P1 is the turn player.",
    action: "P1 attacks. P0 activates Mirror Force.",
    expected: "FFA: only P1 loses its Attack Position monsters; P2 keeps its monsters. Tag: both opposing members lose their Attack Position monsters.",
  }),
  one({
    card: "Dark Magic Attack", code: 2314238, ruleClass: "C", binding: "explicit-pick",
    oneVsOne: "If you control Dark Magician, destroys all Spells and Traps of the opponent.",
    results: { ffa3: "Destroys only the Spells and Traps of the opponent declared at activation.", ffa4: "Destroys only the Spells and Traps of one declared opponent; the other two keep theirs.", tag: "Destroys the Spells and Traps of both opposing members. The condition counts Dark Magician of the partner (you control includes the partner)." },
    evidence: [ev(2314238, 17, "CARD_DARK_MAGICIAN"), ev(2314238, 24, "0,LOCATION_ONFIELD"), ev(2314238, 29, "0,LOCATION_ONFIELD")],
    setup: "Tag: the partner controls face-up Dark Magician and P0 controls none. All opponents control one Spell or Trap.",
    action: "P0 activates Dark Magic Attack.",
    expected: "The partner can meet the activation condition in Tag. FFA: only the declared opponent loses Spells and Traps. Tag: both opposing fields lose them.",
  }),
  one({
    card: "Lightning Storm", code: 14532163, ruleClass: "C", binding: "explicit-pick",
    oneVsOne: "If you control no face-up cards, choose: destroy all Attack Position monsters or all Spells and Traps of the opponent.",
    results: { ffa3: "Destroys the chosen card type of the opponent declared at activation.", ffa4: "Destroys the chosen card type of one declared opponent; the other two keep theirs.", tag: "Destroys the chosen card type of both opposing members. The condition checks the own field, which includes the partner." },
    evidence: [ev(14532163, 18, "IsFaceup,tp,LOCATION_ONFIELD,0"), ev(14532163, 21, "IsAttackPos,tp,0,LOCATION_MZONE"), ev(14532163, 39, "IsSpellTrap,tp,0,LOCATION_ONFIELD")],
    setup: "P0 controls no face-up card. Each opponent controls one attack position monster and one Spell.",
    action: "P0 activates Lightning Storm and chooses the monster option.",
    expected: "FFA: only the declared opponent loses its Attack Position monsters. Tag: both opposing fields lose them. Spells stay.",
  }),
  one({
    card: "Book of Eclipse", code: 35480699, ruleClass: "O", binding: "explicit-pick",
    oneVsOne: "Changes all face-up monsters to face-down. In the End Phase of the turn, the opponent flips its face-down monsters face-up and draws one card for each.",
    results: { ffa3: "The initial flip reaches every seat. The End Phase flip and draw reach only the opponent declared at activation (overlay c35480699.lua).", ffa4: "Same as 3-FFA.", tag: "The initial flip reaches every seat. In the End Phase each opposing member flips and draws for its own monsters." },
    evidence: [ev(35480699, 17, "LOCATION_MZONE,LOCATION_MZONE"), ev(35480699, 38, "IsFacedown,tp,0,LOCATION_MZONE"), ev(35480699, 40, "Duel.Draw(1-tp,ct")],
    setup: "Each seat controls one face-up monster.",
    action: "P0 activates Book of Eclipse. The turn ends.",
    expected: "All face-up monsters become face-down. FFA: only the declared opponent flips and draws in the End Phase. Tag: each opposing member flips and draws for its own monsters.",
  }),
  one({
    card: "Prediction Princess Astromorrigan", code: 5010422, ruleClass: "O", binding: "explicit-pick",
    oneVsOne: "When flipped, it destroys the opponent's Defense Position monsters in the End Phase and deals 500 damage for each monster destroyed.",
    results: { ffa3: "The End Phase destruction and damage affect only the opponent declared when the flip effect enters the chain (overlay c5010422.lua).", ffa4: "Same as 3-FFA.", tag: "The Defense Position monsters of both opposing members are destroyed. Their shared LP takes 500 damage for each monster destroyed." },
    evidence: [ev(5010422, 26, "GetMatchingGroup(s.desfilter,tp,0,LOCATION_MZONE"), ev(5010422, 30, "Duel.Damage(1-tp,ct*500")],
    setup: "P0 controls face-down Astromorrigan. Each opponent controls Defense Position monsters.",
    action: "P0 flips Astromorrigan and declares one opponent in FFA. The turn ends.",
    expected: "FFA: only the declared opponent loses Defense Position monsters and takes 500 damage for each. Tag: both opposing fields lose Defense Position monsters and their shared LP takes the damage.",
  }),
  one({
    card: "Gameciel, the Sea Turtle Kaiju", code: 55063751, ruleClass: "O", binding: "target-controller",
    oneVsOne: "Tribute 1 monster of the opponent to Special Summon this card to their field.",
    results: { ffa3: "The Kaiju goes to the field of the player whose monster was Tributed (owner decision 2026-10-01).", ffa4: "Same as 3-FFA.", tag: "Goes to the field of the player whose monster was Tributed (an opposing member)." },
    evidence: [ev(55063751, 5, "aux.AddKaijuProcedure"), { file: "cards_specific_functions.lua", line: 347, token: "SetTargetRange(position,1)" }, { file: "cards_specific_functions.lua", line: 362, token: "0,LOCATION_MZONE" }],
    setup: "P1 and P2 control one monster each. P0 has Gameciel in hand.",
    action: "P0 Tributes the monster of P2 to summon Gameciel.",
    expected: "Gameciel appears on the field of P2 (target-controller binding). The same rule holds for the other 6 Kaiju and the Lava cards (MULTIPLAYER_CARD_RULES).",
  }),
  one({
    card: "Lightning Vortex", code: 69162969, ruleClass: "C", binding: "explicit-pick",
    oneVsOne: "Discard 1 card. Destroys all face-up monsters of the opponent.",
    results: { ffa3: "Destroys the face-up monsters of the opponent declared at activation.", ffa4: "Destroys the face-up monsters of one declared opponent; the other two keep theirs.", tag: "Destroys all face-up monsters of both opposing members." },
    evidence: [ev(69162969, 21, "IsFaceup,tp,0,LOCATION_MZONE"), ev(69162969, 25, "IsFaceup,tp,0,LOCATION_MZONE")],
    setup: "Each other seat controls one face-up monster.",
    action: "P0 discards a card and activates Lightning Vortex.",
    expected: "FFA: only the declared opponent loses face-up monsters. Tag: both opposing members lose face-up monsters.",
  }),
  one({
    card: "Fissure", code: 66788016, ruleClass: "C", binding: "explicit-pick",
    oneVsOne: "Destroys the face-up monster of the opponent with the lowest ATK.",
    results: { ffa3: "Destroys the lowest ATK face-up monster of the declared opponent (ties: P0 picks).", ffa4: "Destroys the lowest ATK face-up monster of one declared opponent.", tag: "Destroys the lowest ATK face-up monster among the opposing members." },
    evidence: [ev(66788016, 15, "IsFaceup,tp,0,LOCATION_MZONE"), ev(66788016, 16, "IsFaceup,tp,0,LOCATION_MZONE")],
    setup: "P1 controls a monster with 1500 ATK. P2 controls a monster with 1000 ATK.",
    action: "P0 activates Fissure.",
    expected: "FFA: P0 declares P2 and destroys its lowest ATK face-up monster. Tag: use the lowest ATK among both opposing fields.",
  }),
  one({
    card: "Kycoo the Ghost Destroyer", code: 88240808, ruleClass: "C", binding: "event-opponent",
    // Card text: battle damage permits up to 2 monster targets in that opponent's GY.
    // ADR 0002: R-FFA-OPP-RESPONSE binds that opponent; R-TAG-SHARED-CARDS joins the opposing GYs.
    oneVsOne: "After battle damage, targets and banishes up to 2 monsters in the damaged opponent's GY.",
    results: {
      ffa3: "P0 targets and banishes up to 2 monsters from the GY of the opponent that took the battle damage.",
      ffa4: "P0 targets and banishes up to 2 monsters from the GY of the opponent that took the battle damage.",
      tag: "After battle damage to the opposing team, P0 targets and banishes up to 2 monsters from the GYs of its two members.",
    },
    evidence: [ev(88240808, 22, "SetTargetRange(0,1)"), ev(88240808, 37, "IsExistingTarget(s.filter,tp,0,LOCATION_MZONE|LOCATION_GRAVE")],
    setup: "P0 controls Kycoo. Each opponent has two monsters in the GY.",
    action: "Kycoo inflicts battle damage to P1. P0 activates its effect and targets up to 2 monsters in P1's GY in FFA. Tag can use both opposing GYs.",
    expected: "FFA: only the opponent that took the battle damage supplies GY monster targets. Tag: both opposing members supply GY monster targets. The partner's cards are never valid targets.",
  }),

  one({
    card: "Mind Crush", code: 15800838, ruleClass: "U", binding: "explicit-pick",
    oneVsOne: "Name a card. If the opponent has it in hand, they discard all copies. If not, you discard 1 card at random.",
    results: { ffa3: "P0 picks one opponent. Only that hand is read.", ffa4: "P0 picks one of 3 opponents.", tag: "P0 picks one opposing member. The partner hand is never read." },
    evidence: [ev(15800838, 16, "GetFieldGroupCount(tp,0,LOCATION_HAND)"), ev(15800838, 26, "0,LOCATION_HAND"), ev(15800838, 30, "GetFieldGroup(tp,LOCATION_HAND,0)")],
    setup: "P1 and P2 hold different cards. P0 names a card in the hand of P2.",
    action: "P0 activates Mind Crush and picks P2.",
    expected: "P2 discards every copy. P1 is not affected.",
  }),
  one({
    card: "Snatch Steal", code: 45986603, ruleClass: "O", binding: "target-controller",
    oneVsOne: "Take control of a monster. The opponent recovers 1000 LP each Standby Phase.",
    results: { ffa3: "The owner of the monster gains the LP, in the own Standby Phase of that owner (owner decision 2026-10-01). No other opponent gains LP.", ffa4: "Same as 3-FFA.", tag: "The owner of the monster (an opposing member) gains the LP, in the Standby Phase of the own duelist turn of that owner. The team LP gains." },
    evidence: [ev(45986603, 33, "IsTurnPlayer(1-tp)"), ev(45986603, 37, "SetTargetPlayer(1-tp)"), ev(45986603, 39, "CATEGORY_RECOVER")],
    setup: "P1 controls a monster. P0 equips Snatch Steal and takes control of it.",
    action: "Advance to the Standby Phase of each opponent.",
    expected: "P1 owns the monster. P1 gains 1000 LP in the Standby Phase of P1. P2 has a Standby Phase and P1 gains nothing then. Tag: the team of P1 gains 1000 LP.",
  }),
  one({
    card: "Change of Heart", code: 4031928, ruleClass: "C", binding: "target-controller",
    oneVsOne: "Target 1 monster of the opponent. Take control until the End Phase.",
    results: { ffa3: "P0 targets a monster of any opponent. Control returns to the original controller.", ffa4: "Same as 3-FFA.", tag: "P0 targets a monster of an opposing member. It moves to the field of P0." },
    evidence: [ev(4031928, 16, "IsControler(1-tp)"), ev(4031928, 25, "GetControl(tc,tp,PHASE_END,1)")],
    setup: "P1 and P2 each control one monster.",
    action: "P0 targets the monster of P2.",
    expected: "The monster is on the field of P0 until the End Phase, then returns to P2.",
  }),
  one({
    card: "Mind Control", code: 37520316, ruleClass: "C", binding: "target-controller",
    oneVsOne: "Target 1 monster of the opponent. Take control until the End Phase. It cannot attack.",
    results: { ffa3: "P0 targets a monster of any opponent.", ffa4: "Same as 3-FFA.", tag: "P0 targets a monster of an opposing member." },
    evidence: [ev(37520316, 16, "GetControler()~=tp"), ev(37520316, 25, "GetControl(tc,tp,PHASE_END,1)")],
    setup: "P3 controls one monster.",
    action: "P0 targets the monster of P3.",
    expected: "The monster is on the field of P0 until the End Phase and cannot attack.",
  }),
  one({
    card: "Brain Control", code: 87910978, ruleClass: "C", binding: "target-controller",
    oneVsOne: "Pay 800 LP. Take control of a monster until the End Phase.",
    results: { ffa3: "P0 targets a monster of any opponent.", ffa4: "Same as 3-FFA.", tag: "P0 targets a monster of an opposing member. The 800 LP comes from the shared pool." },
    evidence: [ev(87910978, 23, "SelectTarget(tp,s.filter,tp,0,LOCATION_MZONE"), ev(87910978, 29, "GetControl(tc,tp,PHASE_END,1)")],
    setup: "P2 controls one monster.",
    action: "P0 targets the monster of P2.",
    expected: "The monster is on the field of P0 until the End Phase.",
  }),
  one({
    card: "Enemy Controller", code: 98045062, ruleClass: "C", binding: "target-controller",
    oneVsOne: "Change an opponent monster position, or Tribute 1 monster to take control of one.",
    results: { ffa3: "P0 targets a monster of any opponent.", ffa4: "Same as 3-FFA.", tag: "P0 targets a monster of an opposing member." },
    evidence: [ev(98045062, 60, "IsControlerCanBeChanged"), ev(98045062, 73, "GetControl")],
    setup: "P1 controls one face-up monster. P0 controls one monster.",
    action: "P0 activates the control option and targets the monster of P1.",
    expected: "P0 gets control of the monster of P1 until the End Phase.",
  }),
  one({
    card: "Ookazi", code: 19523799, ruleClass: "U", binding: "explicit-pick",
    oneVsOne: "Inflicts 800 damage to the opponent.",
    results: { ffa3: "P0 picks one opponent. Only that player takes damage.", ffa4: "P0 picks one of 3 opponents.", tag: "Damage to the shared LP of the opposing team." },
    evidence: [ev(19523799, 17, "SetTargetPlayer(1-tp)"), ev(19523799, 18, "SetTargetParam(800)")],
    setup: "All players at full LP.",
    action: "P0 activates Ookazi and picks P3.",
    expected: "P3 has 7200 LP. Others are unchanged. Tag: the opposing team has 15200 LP.",
  }),
  one({
    card: "Hinotama", code: 46130346, ruleClass: "U", binding: "explicit-pick",
    oneVsOne: "Inflicts 500 damage to the opponent.",
    results: { ffa3: "P0 picks one opponent.", ffa4: "P0 picks one of 3 opponents.", tag: "Damage to the shared LP of the opposing team." },
    evidence: [ev(46130346, 17, "SetTargetPlayer(1-tp)"), ev(46130346, 18, "SetTargetParam(500)")],
    setup: "All players at full LP.",
    action: "P0 activates Hinotama and picks P1.",
    expected: "P1 has 7500 LP. Others are unchanged.",
  }),
  one({
    card: "Final Flame", code: 73134081, ruleClass: "U", binding: "explicit-pick",
    oneVsOne: "Inflicts 600 damage to the opponent. Requires a Pyro monster.",
    results: { ffa3: "P0 picks one opponent.", ffa4: "P0 picks one of 3 opponents.", tag: "Damage to the shared LP of the opposing team." },
    evidence: [ev(73134081, 17, "SetTargetPlayer(1-tp)"), ev(73134081, 19, "CATEGORY_DAMAGE")],
    setup: "P0 controls a Fire monster. All players at full LP.",
    action: "P0 activates Final Flame and picks P2.",
    expected: "P2 has 7400 LP.",
  }),
  one({
    card: "Thestalos the Firestorm Monarch", code: 26205777, ruleClass: "U", binding: "explicit-pick",
    oneVsOne: "When Tribute Summoned, the opponent discards 1 random card. Damage equals 100 times its Level.",
    results: { ffa3: "P0 picks one opponent. Only that hand is used.", ffa4: "P0 picks one of 3 opponents.", tag: "P0 picks one opposing member." },
    evidence: [ev(26205777, 24, "GetFieldGroup(tp,0,LOCATION_HAND)"), ev(26205777, 30, "Duel.Damage(1-tp")],
    setup: "P1 and P2 hold 3 cards each.",
    action: "P0 Tribute Summons Thestalos and picks P1.",
    expected: "P1 discards 1 random card and takes damage. P2 is unchanged.",
  }),
  one({
    card: "Don Zaloog", code: 76922029, ruleClass: "U", binding: "event-opponent",
    oneVsOne: "When it damages the opponent by attack, choose: discard 1 random card, or send 2 cards from the Deck to the GY.",
    results: { ffa3: "The player who took the damage is the target.", ffa4: "Same as 3-FFA.", tag: "The opposing member who took the damage." },
    evidence: [ev(76922029, 10, "ep==1-tp"), ev(76922029, 34, "GetFieldGroup(tp,0,LOCATION_HAND"), ev(76922029, 40, "DiscardDeck(1-tp,2")],
    setup: "P0 attacks P2 directly with Don Zaloog.",
    action: "The battle damage step ends.",
    expected: "The effect affects P2 only (event opponent). P1 is unchanged.",
  }),
  one({
    card: "Dark Bribe", code: 77538567, ruleClass: "U", binding: "event-opponent",
    oneVsOne: "Negate an opponent Spell or Trap. That opponent draws 1 card.",
    results: { ffa3: "The player who activated the negated card draws.", ffa4: "Same as 3-FFA.", tag: "The opposing member who activated the card draws." },
    evidence: [ev(77538567, 19, "IsPlayerCanDraw(1-tp,1)"), ev(77538567, 27, "NegateActivation(ev)"), ev(77538567, 30, "Duel.Draw(1-tp,1")],
    setup: "P2 activates a Spell. P0 has Dark Bribe set.",
    action: "P0 activates Dark Bribe in response.",
    expected: "The Spell is negated. P2 draws 1 card. P1 draws nothing.",
  }),
  one({
    card: "Soul Taker", code: 81510157, ruleClass: "U", binding: "target-controller",
    oneVsOne: "Destroy 1 monster of the opponent. The opponent gains 1000 LP.",
    results: { ffa3: "The controller of the target gains 1000 LP.", ffa4: "Same as 3-FFA.", tag: "The shared LP of the opposing team gains 1000." },
    evidence: [ev(81510157, 22, "SelectTarget(tp,Card.IsFaceup,tp,0,LOCATION_MZONE"), ev(81510157, 30, "Duel.Recover(1-tp,1000")],
    setup: "P1 and P2 control one monster each.",
    action: "P0 targets the monster of P2.",
    expected: "The monster is destroyed. P2 gains 1000 LP. P1 is unchanged.",
  }),
  one({
    card: "Sakuretsu Armor", code: 56120475, ruleClass: "C", binding: "event-opponent",
    oneVsOne: "When an opponent monster attacks, destroy the attacking monster.",
    results: { ffa3: "Works against the attacker of any opponent.", ffa4: "Same as 3-FFA.", tag: "Works against an attacker of an opposing member." },
    evidence: [ev(56120475, 17, "IsTurnPlayer(1-tp)")],
    setup: "P0 has Sakuretsu Armor set. P1 attacks with one monster.",
    action: "P0 activates Sakuretsu Armor.",
    expected: "The attacker of P1 is destroyed.",
  }),
  one({
    card: "Dimensional Prison", code: 70342110, ruleClass: "C", binding: "event-opponent",
    oneVsOne: "When an opponent monster attacks, banish the attacker.",
    results: { ffa3: "Works against the attacker of any opponent.", ffa4: "Same as 3-FFA.", tag: "Works against an attacker of an opposing member." },
    evidence: [ev(70342110, 17, "IsTurnPlayer(1-tp)")],
    setup: "P0 has Dimensional Prison set. P3 attacks with one monster.",
    action: "P0 activates Dimensional Prison.",
    expected: "The attacker of P3 is banished.",
  }),
  one({
    card: "Infinite Impermanence", code: 10045474, ruleClass: "U", binding: "target-controller",
    oneVsOne: "Negate the effects of 1 face-up monster of the opponent.",
    results: { ffa3: "P0 targets a monster of any opponent.", ffa4: "Same as 3-FFA.", tag: "P0 targets a monster of an opposing member." },
    evidence: [ev(10045474, 24, "IsControler(1-tp)"), ev(10045474, 28, "SelectTarget(tp,Card.IsNegatableMonster")],
    setup: "P1 and P2 control one effect monster each.",
    action: "P0 targets the monster of P2.",
    expected: "The effects of the monster of P2 are negated.",
  }),
  one({
    card: "Dust Tornado", code: 60082869, ruleClass: "U", binding: "target-controller",
    oneVsOne: "Destroy 1 Spell or Trap of the opponent. You may Set 1 Spell or Trap from your hand.",
    results: { ffa3: "P0 targets a card of any opponent.", ffa4: "Same as 3-FFA.", tag: "P0 targets a card of an opposing member." },
    evidence: [ev(60082869, 21, "0,LOCATION_ONFIELD"), ev(60082869, 23, "SelectTarget(tp,s.filter,tp,0,LOCATION_ONFIELD")],
    setup: "P1 and P3 control one Trap each.",
    action: "P0 targets the Trap of P3.",
    expected: "The Trap of P3 is destroyed. P1 is unchanged.",
  }),
  one({
    card: "Stop Defense", code: 63102017, ruleClass: "U", binding: "target-controller",
    oneVsOne: "Change 1 Defense Position monster of the opponent to Attack Position.",
    results: { ffa3: "P0 targets a monster of any opponent.", ffa4: "Same as 3-FFA.", tag: "P0 targets a monster of an opposing member." },
    evidence: [ev(63102017, 16, "IsControler(1-tp)"), ev(63102017, 19, "SelectTarget(tp,Card.IsDefensePos,tp,0,LOCATION_MZONE")],
    setup: "P2 controls a Defense Position monster.",
    action: "P0 targets it.",
    expected: "The monster changes to Attack Position.",
  }),
  one({
    card: "Effect Veiler", code: 97268402, ruleClass: "C", binding: "target-controller",
    oneVsOne: "During the opponent Main Phase, negate the effects of 1 face-up monster of the opponent.",
    results: { ffa3: "Works in the Main Phase of any opponent.", ffa4: "Same as 3-FFA.", tag: "Works in the Main Phase of an opposing member." },
    evidence: [ev(97268402, 22, "IsTurnPlayer(1-tp)"), ev(97268402, 31, "SelectTarget(tp,s.filter,tp,0,LOCATION_MZONE")],
    setup: "It is the Main Phase of P2. P0 holds Effect Veiler. P2 controls one effect monster.",
    action: "P0 discards Effect Veiler and targets the monster of P2.",
    expected: "The effects of that monster are negated. The condition is true for P1, P2 and P3 turns.",
  }),
  one({
    card: "Confiscation", code: 17375316, ruleClass: "U", binding: "explicit-pick",
    oneVsOne: "Pay 1000 LP. Look at the opponent hand and discard 1 card.",
    results: { ffa3: "P0 picks one opponent. Only that hand is shown.", ffa4: "P0 picks one of 3 opponents.", tag: "P0 picks one opposing member. The LP cost is paid from the shared pool." },
    evidence: [ev(17375316, 11, "Cost.PayLP(1000)"), ev(17375316, 17, "GetFieldGroupCount(tp,0,LOCATION_HAND)"), ev(17375316, 23, "GetFieldGroup(p,0,LOCATION_HAND)")],
    setup: "P1 and P2 hold cards.",
    action: "P0 activates Confiscation and picks P1.",
    expected: "P0 sees only the hand of P1 and discards one card from it.",
  }),
  one({
    card: "Delinquent Duo", code: 44763025, ruleClass: "U", binding: "explicit-pick",
    oneVsOne: "Pay 1000 LP. The opponent discards 1 random card and 1 card of their choice.",
    results: { ffa3: "P0 picks one opponent. That player chooses the second discard.", ffa4: "P0 picks one of 3 opponents.", tag: "P0 picks one opposing member." },
    evidence: [ev(44763025, 11, "Cost.PayLP(1000)"), ev(44763025, 25, "g:RandomSelect(p,1)"), ev(44763025, 30, "g:Select(1-p,1,1,nil)")],
    setup: "P1 holds 3 cards. P2 holds 3 cards.",
    action: "P0 activates Delinquent Duo and picks P2.",
    expected: "P2 discards one random card and one chosen card. P1 is unchanged.",
  }),
  one({
    card: "Monster Reborn", code: 83764718, ruleClass: "C", binding: "target-controller",
    oneVsOne: "Special Summon 1 monster from either GY.",
    results: { ffa3: "P0 picks from the union of all GYs. No opponent pick. The monster goes to the field of P0.", ffa4: "Same as 3-FFA.", tag: "The union of all GYs. The monster goes to the field of P0 (Tag: P0 or the partner by the summon rules)." },
    evidence: [ev(83764718, 21, "LOCATION_GRAVE,LOCATION_GRAVE"), ev(83764718, 23, "SelectTarget(tp,s.filter,tp,LOCATION_GRAVE,LOCATION_GRAVE"), ev(83764718, 29, "SpecialSummon(tc,SUMMON_WITH_MONSTER_REBORN,tp,tp")],
    setup: "P1 and P3 have one monster in the GY each.",
    action: "P0 activates Monster Reborn and picks the monster of P3.",
    expected: "The monster of P3 is on the field of P0. The GY is a field-class query, so the card picked is the choice.",
  }),
  one({
    card: "Maxx \"C\"", code: 23434538, ruleClass: "U", binding: "event-opponent",
    oneVsOne: "When the opponent Special Summons, draw 1 card for each summon.",
    results: { ffa3: "Triggers on a summon by any opponent. P0 draws for himself.", ffa4: "Same as 3-FFA.", tag: "Triggers on a summon by an opposing member. A summon by the partner does not trigger it." },
    evidence: [ev(23434538, 48, "eg:IsExists(s.filter,1,nil,1-tp)"), ev(23434538, 52, "Duel.Draw(tp,1"), ev(23434538, 67, "Duel.Draw(tp,n")],
    setup: "P0 has Maxx \"C\" in hand. P1 Special Summons a monster.",
    action: "P0 activates Maxx \"C\".",
    expected: "P0 draws 1 card. The same test with a summon by the partner does not trigger the card.",
  }),
  one({
    card: "Ojama Trio", code: 29843091, ruleClass: "O", binding: "explicit-pick",
    oneVsOne: "Special Summon 3 Ojama Tokens to the field of the opponent. Damage 300 when each token leaves.",
    results: { ffa3: "P0 picks one opponent. The tokens go to that field. The damage goes to the previous controller.", ffa4: "P0 picks one of 3 opponents.", tag: "P0 picks one opposing member. The tokens go to that field (3 empty zones)." },
    evidence: [ev(29843091, 17, "GetLocationCount(1-tp,LOCATION_MZONE,tp)>2"), ev(29843091, 27, "SpecialSummonStep(token,0,tp,1-tp"), ev(29843091, 50, "Duel.Damage(c:GetPreviousControler(),300")],
    setup: "P1 and P2 have 3 empty monster zones.",
    action: "P0 activates Ojama Trio and picks P2.",
    expected: "P2 controls 3 Ojama Tokens. When one is destroyed, P2 takes 300 damage.",
  }),
  one({
    card: "Ash Blossom & Joyous Spring", code: 14558127, ruleClass: "C", binding: "event-opponent",
    oneVsOne: "Negates a card effect that searches, adds from the Deck or sends from the Deck. It can negate an effect of the owner.",
    results: {
      ffa3: "Can negate an effect of any duelist, P0 included. The script has no check for the activating player.",
      ffa4: "Same as 3-FFA.",
      tag: "Cannot negate an effect of the partner (core rule, spec 1.3 requirement 3). Can negate an effect of an opposing member or of P0.",
    },
    evidence: [ev(14558127, 8, "SetCategory(CATEGORY_DISABLE)"), ev(14558127, 10, "SetCode(EVENT_CHAINING)"), ev(14558127, 32, "function s.discon(e,tp,eg,ep,ev,re,r,rp)")],
    setup: "P2 activates a card that searches. P0 holds Ash Blossom.",
    action: "P0 tries to activate Ash Blossom in response.",
    expected: "FFA: the effect of P2 is negated. Tag: P2 is the partner, so Ash Blossom cannot be activated. A search by P1 can be negated at all tables.",
  }),
  one({
    card: "Solemn Judgment", code: 41420027, ruleClass: "C", binding: "event-opponent",
    oneVsOne: "Pay half your LP. Negate a summon, or the activation of a Spell or Trap Card, and destroy that card. It can negate a summon or activation of the owner.",
    results: {
      ffa3: "Can negate a summon or activation of any duelist, P0 included. The script has no player check.",
      ffa4: "Same as 3-FFA.",
      tag: "Cannot negate a summon or activation of the partner (core rule, spec 1.3 requirement 3). Can negate one of an opposing member or of P0. The cost is half of the team LP (spec R7).",
    },
    evidence: [
      ev(41420027, 7, "SetCategory(CATEGORY_DISABLE_SUMMON+CATEGORY_DESTROY)"),
      ev(41420027, 23, "SetCategory(CATEGORY_NEGATE+CATEGORY_DESTROY)"),
      ev(41420027, 33, "return Duel.GetCurrentChain(true)==0"),
      ev(41420027, 37, "Duel.PayLPCost(tp,math.floor(Duel.GetLP(tp)/2))"),
      ev(41420027, 49, "return re:IsHasType(EFFECT_TYPE_ACTIVATE) and Duel.IsChainNegatable(ev)"),
    ],
    setup: "P0 has Solemn Judgment set. P2 Normal Summons a monster. Later P1 Normal Summons a monster.",
    action: "P0 tries to activate Solemn Judgment on each summon.",
    expected: "FFA: P0 can negate both summons. Tag: P2 is the partner, so Solemn Judgment cannot be activated on the summon of P2. It negates the summon of P1, and the team LP goes from 16000 to 8000.",
  }),
  one({
    card: "Card of Safe Return", code: 57953380, ruleClass: "U", binding: "explicit-pick",
    oneVsOne: "If a monster is Special Summoned from your GY, draw 1 card.",
    results: { ffa3: "Only for summons from the own GY. No opponent is involved.", ffa4: "Same as 3-FFA.", tag: "Only for summons from the own GY. A summon from the partner GY does not count." },
    evidence: [ev(57953380, 24, "IsPreviousControler(tp)"), ev(57953380, 27, "eg:IsExists(s.gfilter,1,nil,tp)")],
    setup: "P0 controls Card of Safe Return and has one monster in the GY.",
    action: "P0 summons the monster from the GY.",
    expected: "P0 draws 1 card. A summon from the GY of the partner gives no draw.",
  }),
  one({
    card: "Trap Dustshoot", code: 64697231, ruleClass: "U", binding: "explicit-pick",
    oneVsOne: "If the opponent has 4 or more cards in hand, look at it and send 1 Monster to the Deck.",
    results: { ffa3: "P0 picks one opponent with 4 or more cards.", ffa4: "P0 picks one of 3 opponents.", tag: "P0 picks one opposing member." },
    evidence: [ev(64697231, 22, "SetTargetPlayer(tp)"), ev(64697231, 26, "GetFieldGroup(p,0,LOCATION_HAND)")],
    setup: "P1 holds 5 cards. P2 holds 3 cards.",
    action: "P0 activates Trap Dustshoot.",
    expected: "Only P1 is a valid pick.",
  }),
  one({
    card: "Soul Exchange", code: 68005187, ruleClass: "C", binding: "target-controller",
    oneVsOne: "Target 1 monster the opponent controls. This turn, you may Tribute that monster as if you controlled it. No Battle Phase.",
    results: { ffa3: "P0 targets a monster of any opponent (owner decision 2026-10-01).", ffa4: "Same as 3-FFA.", tag: "P0 targets a monster of an opposing member. The partner monsters are not valid targets." },
    evidence: [ev(68005187, 35, "IsControler(1-tp)"), ev(68005187, 45, "EFFECT_EXTRA_RELEASE")],
    setup: "P1 and P2 control one monster each. P0 holds a monster that needs a Tribute.",
    action: "P0 activates Soul Exchange on the monster of P2 and Tribute Summons using it.",
    expected: "The monster of P2 is Tributed. P1 is unchanged.",
  }),
  one({
    card: "Lava Golem", code: 102380, ruleClass: "O", binding: "target-controller",
    oneVsOne: "Special Summon from the hand to the field of the opponent by Tributing 2 monsters they control.",
    results: { ffa3: "P0 Tributes 2 monsters of the same opponent. Lava Golem goes to the field of that opponent (owner decision 2026-10-01).", ffa4: "Same as 3-FFA.", tag: "P0 Tributes 2 monsters of the same opposing member. Lava Golem goes to the field of that member." },
    evidence: [{ file: "official/c102380.lua", line: 7, token: "aux.AddLavaProcedure(c,2" }, { file: "cards_specific_functions.lua", line: 356, token: "Duel.GetMZoneCount(1-tp,sg,tp)>0" }, { file: "cards_specific_functions.lua", line: 362, token: "0,LOCATION_MZONE" }],
    setup: "P1 controls one monster. P2 controls two monsters. P0 has Lava Golem in hand.",
    action: "P0 tries to summon Lava Golem by Tributing the monster of P1 and one monster of P2.",
    expected: "The summon is illegal. P0 Tributes the 2 monsters of P2 instead and Lava Golem appears on the field of P2.",
  }),
  one({
    card: "Ring of Destruction", code: 83555666, ruleClass: "O", binding: "target-controller", forbidden: true,
    oneVsOne: "Destroy a monster. Both players take damage equal to its ATK.",
    results: { ffa3: "Forbidden. Test of a future override: damage to P0 and to the controller of the target only.", ffa4: "Forbidden. Same as 3-FFA.", tag: "Not forbidden in Tag." },
    evidence: [ev(83555666, 19, "IsTurnPlayer(1-tp)"), ev(83555666, 25, "Duel.GetLP(1-tp)"), ev(83555666, 41, "Duel.Damage(1-tp,val")],
    formats: ["ffa3", "ffa4"],
    setup: "P1 controls a monster with 1000 ATK.",
    action: "P0 activates Ring of Destruction on it.",
    expected: "PENDING: no override exists. The card is on the forbidden list.",
  }),
  one({
    card: "Evenly Matched", code: 15693423, ruleClass: "O", binding: "explicit-pick",
    oneVsOne: "Destroys opponent cards until they control as many as you.",
    results: {
      ffa3: "P0 picks one opponent when P0 activates it. The card compares P0 with that opponent only, and only the cards of that opponent are banished. That opponent chooses their own cards (owner decision 2026-10-01). The other opponent is not affected.",
      ffa4: "Same as 3-FFA. The other 2 opponents are not affected.",
      tag: "The fields of the two opposing members are joined. The count uses the cards of both opposing members together against the cards of the own team. The opposing team chooses from its joined field.",
    },
    evidence: [ev(15693423, 28, "GetFieldGroup(tp,0,LOCATION_ONFIELD)"), ev(15693423, 38, "#g-Duel.GetFieldGroupCount(tp,LOCATION_ONFIELD,0)")],
    setup: "P0 controls 1 card. P1 controls 3 cards. P2 controls 3 cards.",
    action: "P0 activates Evenly Matched and picks P1.",
    expected: "P0 (1 card) is compared with P1 (3 cards) only. P1 chooses 2 of their own cards and they are banished face-down. P2 is not affected. Tag: the 2 opposing members are joined, and the opposing team chooses the cards to banish from its joined field.",
  }),
  one({
    card: "Pineapple Blast", code: 90669991, ruleClass: "O", binding: "explicit-pick",
    oneVsOne: "If the opponent has more monsters, destroys monsters of the opponent until the counts match.",
    results: {
      ffa3: "P0 picks one opponent when P0 activates it. The card compares P0 with that opponent only, and only the monsters of that opponent are destroyed. That opponent chooses their own monsters (owner decision 2026-10-01). The other opponent is not affected.",
      ffa4: "Same as 3-FFA. The other 2 opponents are not affected.",
      tag: "The fields of the two opposing members are joined. The count uses the monsters of both opposing members together against the monsters of the own team. The opposing team chooses from its joined field.",
    },
    evidence: [ev(90669991, 17, "ep==tp"), ev(90669991, 30, "g:Select(1-tp")],
    setup: "P0 controls 1 monster. P1 controls 3 monsters. P2 controls 3 monsters.",
    action: "P0 activates Pineapple Blast after an opponent Special Summon and picks P1.",
    expected: "P0 (1 monster) is compared with P1 (3 monsters) only. P1 keeps 1 monster of their choice and the other 2 are destroyed. P2 is not affected. Tag: the 2 opposing members are joined, and the opposing team chooses the monsters from its joined field.",
  }),
];

/** Script evidence for the forbidden list (group c). The key is the passcode. */
export const FORBIDDEN_EVIDENCE: Record<number, Evidence[]> = {
  100200298: [
    { file: "pre-release/c100200298.lua", line: 34, token: "Duel.GetAttacker():IsControler(1-tp)" },
    { file: "pre-release/c100200298.lua", line: 35, token: "Duel.GetFieldGroupCount(tp,0,LOCATION_MZONE)" },
    { file: "pre-release/c100200298.lua", line: 38, token: "event_player==1-tp" },
    { file: "pre-release/c100200298.lua", line: 66, token: "Duel.SkipPhase(1-tp,PHASE_BATTLE" },
  ],
  101402094: [
    { file: "pre-release/c101402094.lua", line: 52, token: "Duel.GetLocationCountFromEx(1-tp,tp,nil,c,ZONES_MMZ)" },
    { file: "pre-release/c101402094.lua", line: 77, token: "Duel.SpecialSummon(spc,0,tp,1-tp" },
  ],
  74519184: [ev(74519184, 16, "GetFieldGroupCount(tp,LOCATION_HAND,0)"), ev(74519184, 28, "Duel.GetTurnPlayer()"), ev(74519184, 39, "Duel.Draw(turnp,2")],
  72892473: [ev(72892473, 18, "GetFieldGroupCount(tp,0,LOCATION_HAND)"), ev(72892473, 27, "GetFieldGroup(tp,LOCATION_HAND,LOCATION_HAND)")],
  33508719: [ev(33508719, 19, "GetFieldGroup(tp,LOCATION_HAND,LOCATION_HAND)"), ev(33508719, 23, "Duel.Draw(1-tp,5")],
  14057297: [ev(14057297, 21, "GetFieldGroup(tp,LOCATION_HAND,LOCATION_HAND)"), ev(14057297, 44, "Duel.Draw(tp,5")],
  17484499: [ev(17484499, 15, "SwapDeckAndGrave(turn_player)"), ev(17484499, 16, "SwapDeckAndGrave(1-turn_player)")],
  82301904: [ev(82301904, 96, "LOCATION_HAND|LOCATION_ONFIELD,LOCATION_HAND|LOCATION_ONFIELD"), ev(82301904, 105, "LOCATION_HAND|LOCATION_ONFIELD,LOCATION_HAND|LOCATION_ONFIELD")],
  35059553: [ev(35059553, 16, "SetTargetRange(0,1)"), ev(35059553, 30, "GetFieldGroupCount(e:GetHandlerPlayer(),LOCATION_MZONE,0)")],
  98139712: [ev(98139712, 19, "c:GetOwner()==1-tp"), ev(98139712, 27, "Duel.Damage(1-tp,d1")],
  83555666: [ev(83555666, 25, "Duel.GetLP(1-tp)"), ev(83555666, 41, "Duel.Damage(1-tp,val")],
  62966332: [ev(62966332, 5, "GLOBALFLAG_DECK_REVERSE_CHECK"), ev(62966332, 14, "EFFECT_REVERSE_DECK"), ev(62966332, 17, "SetTargetRange(1,1)")],
  22804644: [ev(22804644, 48, "RESET_OPPO_TURN,3"), ev(22804644, 56, "RESET_OPPO_TURN,3")],
  21208154: [ev(21208154, 62, "RESET_OPPO_TURN,2"), ev(21208154, 71, "RESET_OPPO_TURN,2")],
  22888900: [ev(22888900, 28, "RESET_OPPO_TURN,2"), ev(22888900, 45, "RESET_OPPO_TURN,2")],
  23746827: [ev(23746827, 48, "RESET_OPPO_TURN,2")],
  18326736: [ev(18326736, 73, "EFFECT_SKIP_TURN")],
  23846921: [ev(23846921, 76, "EFFECT_SKIP_TURN")],
  37313786: [ev(37313786, 33, "EFFECT_SKIP_TURN")],
  6357341: [ev(6357341, 28, "EFFECT_SKIP_TURN")],
  92182447: [ev(92182447, 52, "EFFECT_SKIP_TURN")],
  33396948: [ev(33396948, 34, "GetFieldGroup(tp,LOCATION_HAND,0)"), ev(33396948, 40, "Duel.Win(tp,WIN_REASON_EXODIA)")],
  95308449: [ev(95308449, 12, "aux.GlobalCheck"), ev(95308449, 39, "tp==c:GetOwner()")],
  28566710: [ev(28566710, 64, "Duel.Win(0,WIN_REASON_LAST_TURN)"), ev(28566710, 66, "Duel.Win(1,WIN_REASON_LAST_TURN)")],
  27204311: [ev(27204311, 34, "RegisterFlagEffect(tc:GetSummonPlayer()"), ev(27204311, 38, "GetFlagEffect(1-tp,id)>=5")],
  94145021: [ev(94145021, 17, "aux.GlobalCheck"), ev(94145021, 42, "ev==1-tp or ev==PLAYER_ALL")],
  57728570: [ev(57728570, 43, "GetFieldGroup(tp,0,LOCATION_MZONE|LOCATION_HAND)"), ev(57728570, 52, "SelectYesNo(1-tp")],
  15305240: [ev(15305240, 30, "SelectMatchingCard(1-tp"), ev(15305240, 34, "SwapControl(c1,c2,0,0)")],
  30426226: [ev(30426226, 19, "GetFieldGroup(tp,LOCATION_MZONE,LOCATION_MZONE)"), ev(30426226, 29, "SwapControl(g1,g2)")],
  13532663: [ev(13532663, 25, "SelectMatchingCard(1-tp"), ev(13532663, 26, "SwapControl(c,g:GetFirst(),0,0)")],
  17178486: [ev(17178486, 18, "Duel.SetLP(1-tp,3000)")],
  37984331: [ev(37984331, 23, "Duel.Win(1-c:GetControler()")],
  42776960: [ev(42776960, 56, "Duel.Win(e:GetLabel()")],
  13893596: [ev(13893596, 75, "Duel.Win(tp,WIN_REASON_EXODIUS)")],
  10000040: [ev(10000040, 29, "Duel.Win(e:GetHandler():GetSummonPlayer()")],
  15862758: [ev(15862758, 71, "Duel.Win(tp,WIN_REASON_NUMBER_iC1000)")],
  5008836: [ev(5008836, 50, "Duel.Win(tp,WIN_REASON_EXODIA_DEFENDER)")],
  53334641: [ev(53334641, 47, "Duel.Win(tp,WIN_REASON_GHOSTRICK_MISCHIEF)")],
  6165656: [ev(6165656, 84, "Duel.Win(tp,WIN_REASON_DISASTER_LEO)")],
  66765023: [ev(66765023, 50, "Duel.Win(tp,WIN_REASON_FLYING_ELEPHANT)")],
  69553552: [ev(69553552, 61, "Duel.Win(tp,WIN_REASON_FA_WINNERS)")],
  77751766: [ev(77751766, 58, "Duel.Win(tp,WIN_REASON_SUMMER_SCHOOLWORK)")],
  8062132: [ev(8062132, 105, "Duel.Win(tp,WIN_REASON_VENNOMINAGA)")],
  81171949: [ev(81171949, 52, "Duel.Win(tp,WIN_REASON_JACKPOT7)")],
  94212438: [ev(94212438, 122, "Duel.Win(tp,WIN_REASON_DESTINY_BOARD)")],
  96637156: [ev(96637156, 57, "Duel.Win(tp,WIN_REASON_MUSICAL_SUMO)")],
  97795930: [ev(97795930, 77, "Duel.Win(tp,WIN_REASON_PHANTASM_SPIRAL)")],
  48995978: [ev(48995978, 58, "Duel.Win(tp,WIN_REASON_PUPPET_LEO)")],
};

/** Lines of the shared Kaiju and Lava procedure in cards_specific_functions.lua (the card goes to the field of the player whose monster was Tributed). */
const lavaCore: Evidence[] = [
  { file: "cards_specific_functions.lua", line: 347, token: "SetTargetRange(position,1)" },
  { file: "cards_specific_functions.lua", line: 362, token: "0,LOCATION_MZONE" },
];

/** Script evidence for the per-card rule list (MULTIPLAYER_CARD_RULES). The key is the passcode. */
/** Script line of the effect that Special Summons to the field of an opponent, by passcode. */
const OPPONENT_FIELD_LINES: Record<number, number> = {
  131182: 79, 561300: 64, 1041278: 92, 3376703: 112, 3685372: 86, 6203182: 65,
  7392745: 25, 7623640: 35, 8837932: 65, 9400127: 62, 10158145: 102, 11654067: 45,
  11677278: 79, 13204145: 56, 13452889: 53, 13935001: 66, 14283055: 85, 14470845: 41,
  17000165: 89, 17228908: 77, 22404675: 45, 22411609: 63, 23920796: 62, 25131968: 66,
  26259179: 44, 26364381: 81, 26913989: 65, 26964762: 55, 28062325: 41, 29843091: 27,
  30069398: 24, 31313405: 78, 31322640: 96, 33970665: 43, 34968834: 55, 36890111: 80,
  37129797: 61, 38041940: 44, 38811586: 79, 39829561: 52, 40343749: 57, 41141943: 82,
  42956963: 32, 43066927: 84, 44265115: 94, 44689688: 32, 46647144: 79, 47126872: 65,
  48228390: 59, 49966595: 80, 50415441: 83, 52126602: 65, 52782439: 51, 54191698: 48,
  54658815: 31, 55465441: 38, 56562619: 154, 57357130: 75, 57844634: 43, 59900655: 68,
  61665245: 44, 62767644: 67, 63013339: 72, 63086455: 61, 65477143: 55, 65676461: 39,
  66094973: 107, 66661678: 29, 67508932: 89, 68378605: 76, 69811710: 72, 71015787: 43,
  71645242: 98, 72554664: 52, 73355951: 46, 74440055: 30, 75524092: 41, 76384284: 30,
  76683171: 29, 78610936: 51, 78783557: 51, 80044027: 58, 80551022: 82, 80978111: 40,
  81003500: 46, 81522098: 80, 81794107: 75, 82012319: 47, 82773292: 46, 82933935: 86,
  82994509: 29, 83778600: 29, 85698115: 51, 87170768: 40, 88124568: 52, 90884403: 124,
  93775296: 39, 93912845: 50, 93983867: 44, 96857854: 68, 99229085: 68, 99330325: 69,
};

export const CARD_RULE_EVIDENCE: Record<number, Evidence[]> = {
  // Kaiju and Lava procedure: Tribute a monster of an opponent, summon to that field.
  55063751: [ev(55063751, 5, "aux.AddKaijuProcedure"), ...lavaCore],
  28674152: [ev(28674152, 5, "aux.AddKaijuProcedure"), ...lavaCore],
  29726552: [ev(29726552, 5, "aux.AddKaijuProcedure"), ...lavaCore],
  36956512: [ev(36956512, 5, "aux.AddKaijuProcedure"), ...lavaCore],
  48770333: [ev(48770333, 7, "aux.AddKaijuProcedure"), ...lavaCore],
  63941210: [ev(63941210, 5, "aux.AddKaijuProcedure"), ...lavaCore],
  93332803: [ev(93332803, 5, "aux.AddKaijuProcedure"), ...lavaCore],
  102380: [ev(102380, 7, "aux.AddLavaProcedure(c,2"), ...lavaCore, ev(102380, 16, "IsTurnPlayer(tp)")],
  63014935: [ev(63014935, 7, "aux.AddLavaProcedure(c,1"), ...lavaCore],
  25920413: [ev(25920413, 6, "aux.AddLavaProcedure(c,1"), ...lavaCore],
  46565218: [ev(46565218, 6, "aux.AddLavaProcedure(c,1"), ...lavaCore],
  33331231: [ev(33331231, 19, "aux.AddLavaProcedure(c,0"), ...lavaCore],
  64203620: [ev(64203620, 13, "SetTargetRange(POS_FACEUP_DEFENSE,1)")],
  91697229: [ev(91697229, 13, "SetTargetRange(POS_FACEUP_DEFENSE,1)")],
  75732622: [ev(75732622, 12, "SetTargetRange(POS_FACEUP,1)")],
  82090807: [ev(82090807, 20, "SetTargetRange(POS_FACEUP,1)")],
  10000080: [ev(10000080, 12, "SetTargetRange(POS_FACEUP_ATTACK,1)")],

  // Special Summon of a card or tokens to the field of an opponent (`Duel.SpecialSummon(..., tp, 1-tp, ...)`)
  ...Object.fromEntries(
    Object.entries(OPPONENT_FIELD_LINES).map(([code, line]) => [code, [ev(Number(code), line, ",tp,1-tp,")]]),
  ),
  // Count rules.
  90669991: [ev(90669991, 17, "ep==tp"), ev(90669991, 30, "g:Select(1-tp")],
  15693423: [ev(15693423, 28, "GetFieldGroup(tp,0,LOCATION_ONFIELD)"), ev(15693423, 38, "#g-Duel.GetFieldGroupCount(tp,LOCATION_ONFIELD,0)")],
  // Defaults.
  44656491: [ev(44656491, 33, "IsTurnPlayer(tp)"), ev(44656491, 37, "Duel.PayLPCost(tp,100)")],
  72405967: [ev(72405967, 22, "GetMatchingGroup(Card.IsMonster,tp,LOCATION_HAND,LOCATION_HAND")],
  68005187: [ev(68005187, 35, "IsControler(1-tp)"), ev(68005187, 45, "EFFECT_EXTRA_RELEASE")],
  45986603: [ev(45986603, 33, "IsTurnPlayer(1-tp)"), ev(45986603, 37, "SetTargetPlayer(1-tp)")],
  // Cards that compare the field with the opponents, or roll against one opponent.
  76375976: [
    ev(76375976, 53, "GetFieldGroupCount(tp,LOCATION_MZONE,0)>"),
    ev(76375976, 57, "GetFieldGroupCount(tp,LOCATION_MZONE,0)<"),
    ev(76375976, 63, "GetFieldGroupCount(tp,LOCATION_MZONE,0)=="),
  ],
  57314798: [ev(57314798, 98, "Duel.GetAttacker():IsControler(1-tp)")],
  38817295: [
    ev(38817295, 15, "GetFieldGroupCount(tp,0,LOCATION_MZONE)>"),
    ev(38817295, 30, "GetMatchingGroupCount(Card.IsFaceup,tp,0,LOCATION_MZONE"),
  ],
  3549275: [ev(3549275, 22, "Duel.TossDice(tp,1,1)"), ev(3549275, 26, "Duel.Damage(tp,6000"), ev(3549275, 32, "Duel.Damage(1-tp,6000")],
};

export const SCENARIOS: CatalogScenario[] = [...GROUP_ALL, ...GROUP_ONE];

/**
 * Live scenarios (tests/scenarios/multiplayer/*.ts, run on the real core) that prove the multiplayer result of ONE card, by
 * passcode. List a card only when the outcome asserts of the scenario show the rule of that card. A card that only appears
 * in a scenario as a helper (a chain link, a cost, a fodder monster) is not listed. The table of each scenario is its
 * setup.format. catalog.test.ts checks that every id exists, and that the formats here equal CARD_RULE_PROOF in
 * src/banlists/multiplayer.ts for the cards of the rule list. A sketch in SCENARIOS whose card is listed runs as a test.
 * Not claimed (no scenario shows it yet): the Tag result of most cards, the FFA result of Solemn Judgment, and the
 * target cap of Ultimate Sky.
 */
export const LIVE_PROOF: Readonly<Record<number, readonly string[]>> = {
  72302403: ["rule-gaps-swords-protects-controller-ffa3", "swords-protect-ffa4-p0-p1-direct-targets",
    "rule-gaps-swords-opponents-not-partner-tag", "swords-protect-ffa4-p0-p1-direct-targets-domain"],
  35316708: [
    "r3-ffa3-time-seal-skips-the-draw-of-the-declared-opponent",
    "r3-ffa3-time-seal-declares-p2-and-skips-only-its-next-draw",
    "r3-ffa3-time-seal-declared-opponent-leaves-the-lock-does-not-move",
  ], // Time Seal: FFA3 only. Each row also runs as a Domain variant.
  88240808: [
    "p3-catalog-ffa3-kycoo-battle-opponent",
    "p3-catalog-ffa4-kycoo-battle-opponent",
    "p3-catalog-tag-kycoo-battle-opponent",
    "p3-catalog-ffa3-kycoo-battle-opponent-domain",
    "p3-catalog-ffa4-kycoo-battle-opponent-domain",
    "p3-catalog-tag-kycoo-battle-opponent-domain",
  ],
  18144506: [
    "p3-catalog-ffa3-harpie-s-feather-duster",
    "p3-catalog-ffa4-harpie-s-feather-duster",
    "p3-catalog-tag-harpie-s-feather-duster",
  ],
  2314238: [
    "p3-catalog-ffa3-dark-magic-attack",
    "p3-catalog-ffa4-dark-magic-attack",
    "p3-catalog-tag-dark-magic-attack",
  ],
  14532163: [
    "p3-catalog-ffa3-lightning-storm-monsters",
    "p3-catalog-ffa3-lightning-storm-spells",
    "p3-catalog-ffa4-lightning-storm-monsters",
    "p3-catalog-ffa4-lightning-storm-spells",
    "p3-catalog-tag-lightning-storm-monsters",
    "p3-catalog-tag-lightning-storm-spells",
  ],
  69162969: [
    "p3-catalog-ffa3-lightning-vortex",
    "p3-catalog-ffa4-lightning-vortex",
    "p3-catalog-tag-lightning-vortex",
  ],
  66788016: [
    "p3-catalog-ffa3-fissure",
    "p3-catalog-ffa4-fissure",
    "p3-catalog-tag-fissure",
  ],
  44095762: [
    "p3-catalog-ffa3-third-duelist-mirror-force",
    "p3-catalog-ffa4-third-duelist-mirror-force",
    "p3-catalog-tag-third-duelist-mirror-force",
  ],
  19613556: [
    "p3-catalog-ffa3-heavy-storm",
    "p3-catalog-ffa4-heavy-storm",
    "p3-catalog-tag-heavy-storm",
  ],
  53582587: [
    "p3-catalog-ffa3-torrential-tribute",
    "p3-catalog-ffa4-torrential-tribute",
    "p3-catalog-tag-torrential-tribute",
  ],
  // Group (a) and (b) sketches.
  12580477: [
    "p3-catalog-ffa3-raigeki",
    "p3-catalog-ffa4-raigeki",
    "p3-catalog-tag-raigeki",
    "compare-ffa3-window-closes-after-evenly-matched",
  ], // Raigeki: its own declared opponent after a prior binding.
  53129443: [
    "seats-r2-ffa3-fatal-abacus-damages-each-real-controller-of-the-destroyed-monsters",
    "seats-r2-tag-fatal-abacus-damages-the-team-of-each-real-controller",
  ], // Dark Hole (every seat, the partner included)
  15800838: ["nseat-ffa3-mind-crush-pick", "nseat-ffa4-mind-crush-pick-after-elimination"], // Mind Crush
  41420027: ["nseat-tag-partner-trap-does-not-answer", "nseat-tag-opponent-trap-answers"], // Solemn Judgment (Tag)
  46130346: [
    "nseat-ffa3-effect-elimination-last-wins",
    "nseat-ffa4-effect-elimination-skips-turn",
    "nseat-tag-burn-spares-partner",
  ], // Hinotama
  // Sketches that are also on the rule list.
  55063751: [
    "p3-catalog-ffa3-gameciel-tribute-controller",
    "p3-catalog-ffa4-gameciel-tribute-controller",
    "p3-catalog-tag-gameciel-tribute-controller",
    "p3-catalog-ffa3-gameciel-tribute-controller-domain",
    "p3-catalog-ffa4-gameciel-tribute-controller-domain",
    "p3-catalog-tag-gameciel-tribute-controller-domain",
    "procedures-ffa3-kaiju-tribute-goes-to-tributed-field",
    "procedures-ffa4-kaiju-tribute-goes-to-tributed-field",
    "procedures-tag-kaiju-tribute-goes-to-opposing-member",
    "procedures-ffa3-kaiju-bound-seat-eliminated-no-widening",
    "procedures-ffa4-kaiju-bound-seat-eliminated-no-widening",
  ], // Gameciel
  102380: [
    "procedures-ffa3-lava-golem-split-rejected",
    "procedures-ffa3-lava-golem-one-opponent-accepted",
    "procedures-ffa4-lava-golem-picked-opponent",
    "procedures-tag-lava-golem-split-rejected",
    "procedures-tag-lava-golem-one-opposing-member-accepted",
    "procedures-tag-lava-golem-partner-monsters-do-not-pay",
  ], // Lava Golem
  90669991: [
    "compare-ffa3-pineapple-blast-pick-and-choice",
    "compare-ffa3-first-opponent-fails-second-passes",
    "compare-ffa3-sum-passes-no-single-opponent",
    "compare-ffa4-pineapple-blast-three-opponents",
    "compare-tag-pineapple-blast-joined-field-picked-duelist-chooses",
  ], // Pineapple Blast
  15693423: [
    "compare-ffa3-window-closes-after-evenly-matched",
    "compare-ffa4-evenly-matched-three-opponents",
    "compare-tag-evenly-matched-joined-field-picked-duelist-banishes",
  ], // Evenly Matched
  29843091: [
    "w9-ffa3-opponent-pick-and-place-refuse-wrong-answers",
    "w9-tag-opponent-pick-and-place-refuse-wrong-answers",
    "opponent-field-effects-ffa3-ojama-trio-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-ojama-trio-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-ojama-trio-goes-to-an-opposing-member",
  ], // Ojama Trio
  72405967: [
    "late-ffa3-royal-tribute-every-duelist-discards-its-monsters",
    "late-ffa4-royal-tribute-every-duelist-discards-its-monsters",
    "late-tag-royal-tribute-every-duelist-discards-its-monsters",
  ], // Royal Tribute
  // Rule list only.
  63014935: ["procedures-ffa3-volcanic-queen-goes-to-tributed-field"], // Volcanic Queen
  10000080: [
    "procedures-ffa3-ra-sphere-mode-split-rejected",
    "procedures-ffa3-ra-sphere-mode-one-opponent-accepted",
    "procedures-ffa3-ra-sphere-mode-picked-opponent",
  ], // The Winged Dragon of Ra - Sphere Mode
  71645242: [
    "seats-r2-ffa3-black-garden-token-goes-to-one-picked-opponent-or-to-the-controller",
    "seats-r2-tag-black-garden-token-goes-to-one-picked-opponent-or-to-the-controller",
  ], // Black Garden
  80551022: ["compare-gaps-ffa3-mimighoul-slime-picked-opponent-does-not-pass"], // Mimighoul Slime
  83778600: [
    "late-ffa3-foolish-revival-target-and-summon-use-the-declared-opponent",
    "late-tag-foolish-revival-target-in-the-grave-of-the-opponent-that-is-not-picked",
    "opponent-field-effects-ffa3-foolish-revival-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-foolish-revival-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-foolish-revival-goes-to-an-opposing-member",
  ], // Foolish Revival
  76375976: [
    "compare-gaps-ffa3-mystic-mine-only-the-opponent-with-more-monsters-is-locked",
    "compare-gaps-ffa3-mystic-mine-no-opponent-has-more-nobody-is-locked",
    "compare-ffa3-mystic-mine-stays-with-only-one-equal-opponent",
    "compare-ffa3-mystic-mine-destroys-itself-when-all-counts-equal",
    "compare-ffa4-mystic-mine-destroys-itself-when-all-counts-equal",
    "compare-ffa4-mystic-mine-stays-when-only-the-last-opponent-differs",
    "compare-gaps-ffa3-mystic-mine-self-locks-if-one-opponent-has-fewer",
    "tag-copies-mystic-mine-locks-the-opposing-team-by-the-joined-count",
    "tag-copies-mystic-mine-joined-counts-equal-locks-nobody-and-destroys-itself",
    "tag-copies-mystic-mine-self-locks-by-unequal-joined-counts",
  ], // Mystic Mine
  57314798: [
    "compare-extra-ffa3-numeron-dragon-summons-itself-when-p0-is-attacked-directly",
    "compare-extra-ffa3-numeron-dragon-not-offered-when-the-direct-attack-may-go-to-another-seat",
    "compare-extra-ffa3-numeron-dragon-offered-when-the-direct-attack-is-picked-at-p0",
    "compare-gaps-ffa3-numeron-dragon-every-seat-sets-its-own-card",
  ], // Number 100: Numeron Dragon
  38817295: [
    "compare-ffa3-activation-condition-one-opponent",
    "compare-extra-ffa3-w10-sky-and-evenly-matched-chain",
    "compare-ffa3-chain-of-three-each-link-its-own-opponent",
  ], // Ultimate Sky
  3549275: [
    "late-ffa3-dice-jar-owner-wins-picked-opponent-takes-the-damage",
    "late-ffa4-dice-jar-owner-wins-picked-opponent-takes-the-damage",
    "late-tag-dice-jar-owner-wins-picked-opponent-takes-the-damage",
    "late-ffa3-dice-jar-owner-loses-and-takes-the-damage",
    "late-ffa4-dice-jar-owner-loses-and-takes-the-damage",
    "late-tag-dice-jar-owner-loses-and-takes-the-damage",
  ], // Dice Jar
  44656491: [
    "late-ffa3-messenger-of-peace-limit-for-all-and-payment-only-in-own-standby",
    "late-ffa4-messenger-of-peace-limit-for-all-and-payment-only-in-own-standby",
    "late-tag-messenger-of-peace-limit-for-all-and-payment-only-in-own-standby",
  ], // Messenger of Peace
  28674152: [
    "summon-procedures-ffa3-radian-tribute-goes-to-tributed-field",
    "summon-procedures-ffa4-radian-tribute-goes-to-tributed-field",
    "summon-procedures-tag-radian-tribute-goes-to-opposing-member",
    "summon-procedures-ffa3-radian-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-ffa4-radian-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-tag-radian-no-tribute-with-kaiju-on-opposing-member",
  ], // Radian
  29726552: [
    "summon-procedures-ffa3-kumongous-tribute-goes-to-tributed-field",
    "summon-procedures-ffa4-kumongous-tribute-goes-to-tributed-field",
    "summon-procedures-tag-kumongous-tribute-goes-to-opposing-member",
    "summon-procedures-ffa3-kumongous-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-ffa4-kumongous-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-tag-kumongous-no-tribute-with-kaiju-on-opposing-member",
  ], // Kumongous
  36956512: [
    "summon-procedures-ffa3-gadarla-tribute-goes-to-tributed-field",
    "summon-procedures-ffa4-gadarla-tribute-goes-to-tributed-field",
    "summon-procedures-tag-gadarla-tribute-goes-to-opposing-member",
    "summon-procedures-ffa3-gadarla-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-ffa4-gadarla-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-tag-gadarla-no-tribute-with-kaiju-on-opposing-member",
  ], // Gadarla
  48770333: [
    "summon-procedures-ffa3-thunder-king-tribute-goes-to-tributed-field",
    "summon-procedures-ffa4-thunder-king-tribute-goes-to-tributed-field",
    "summon-procedures-tag-thunder-king-tribute-goes-to-opposing-member",
    "summon-procedures-ffa3-thunder-king-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-ffa4-thunder-king-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-tag-thunder-king-no-tribute-with-kaiju-on-opposing-member",
  ], // Thunder King
  63941210: [
    "summon-procedures-ffa3-jizukiru-tribute-goes-to-tributed-field",
    "summon-procedures-ffa4-jizukiru-tribute-goes-to-tributed-field",
    "summon-procedures-tag-jizukiru-tribute-goes-to-opposing-member",
    "summon-procedures-ffa3-jizukiru-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-ffa4-jizukiru-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-tag-jizukiru-no-tribute-with-kaiju-on-opposing-member",
  ], // Jizukiru
  93332803: [
    "summon-procedures-ffa3-dogoran-tribute-goes-to-tributed-field",
    "summon-procedures-ffa4-dogoran-tribute-goes-to-tributed-field",
    "summon-procedures-tag-dogoran-tribute-goes-to-opposing-member",
    "summon-procedures-ffa3-dogoran-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-ffa4-dogoran-no-tribute-with-kaiju-on-opponent",
    "summon-procedures-tag-dogoran-no-tribute-with-kaiju-on-opposing-member",
  ], // Dogoran
  25920413: [
    "summon-procedures-ffa3-alien-skull-tribute-goes-to-tributed-field",
    "summon-procedures-ffa4-alien-skull-tribute-goes-to-tributed-field",
    "summon-procedures-tag-alien-skull-tribute-goes-to-opposing-member",
  ], // Alien Skull (Lava procedure)
  46565218: [
    "summon-procedures-ffa3-santa-claws-tribute-goes-to-tributed-field-and-it-draws",
    "summon-procedures-ffa4-santa-claws-tribute-goes-to-tributed-field-and-it-draws",
    "summon-procedures-tag-santa-claws-tribute-goes-to-opposing-member-and-it-draws",
  ], // Santa Claws (Lava procedure)
  33331231: [
    "summon-procedures-ffa3-hamp-tribute-goes-to-tributed-field",
    "summon-procedures-ffa4-hamp-tribute-goes-to-tributed-field",
    "summon-procedures-tag-hamp-tribute-goes-to-opposing-member",
    "summon-procedures-ffa3-hamp-own-field-tributes-own-monster",
    "summon-procedures-ffa4-hamp-own-field-tributes-own-monster",
    "summon-procedures-tag-hamp-own-field-tributes-own-monster",
  ], // H.A.M.P. (Lava procedure, both fields)
  64203620: [
    "summon-procedures-ffa3-jormungardr-goes-to-picked-opponent",
    "summon-procedures-ffa4-jormungardr-opponent-with-full-field-is-not-offered",
    "summon-procedures-tag-jormungardr-goes-to-opposing-member-not-partner",
  ], // Jormungardr (Nordic)
  91697229: [
    "summon-procedures-ffa3-fenrir-goes-to-picked-opponent",
    "summon-procedures-ffa4-fenrir-opponent-with-full-field-is-not-offered",
    "summon-procedures-tag-fenrir-goes-to-opposing-member-not-partner",
  ], // Fenrir (Nordic)
  75732622: [
    "summon-procedures-ffa3-grinder-golem-goes-to-picked-opponent-and-tokens-to-the-own-field",
    "summon-procedures-ffa4-grinder-golem-opponent-with-full-field-is-not-offered",
    "summon-procedures-tag-grinder-golem-goes-to-opposing-member-not-partner",
  ], // Grinder Golem
  82090807: [
    "summon-procedures-ffa3-fallen-of-argyros-opponent-field-goes-to-picked-opponent",
    "summon-procedures-ffa4-fallen-of-argyros-opponent-field-goes-to-picked-opponent",
    "summon-procedures-tag-fallen-of-argyros-opponent-field-goes-to-opposing-member",
    "summon-procedures-ffa3-fallen-of-argyros-own-field-asks-no-opponent",
    "summon-procedures-ffa4-fallen-of-argyros-own-field-asks-no-opponent",
    "summon-procedures-tag-fallen-of-argyros-own-field-asks-no-opponent",
  ], // Fallen of Argyros
  11654067: [
    "opponent-field-effects-ffa3-fire-ejection-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-fire-ejection-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-fire-ejection-goes-to-an-opposing-member",
  ], // Fire Ejection
  14470845: [
    "opponent-field-effects-ffa3-ojama-duo-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-ojama-duo-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-ojama-duo-goes-to-an-opposing-member",
  ], // Ojama Duo
  28062325: [
    "opponent-field-effects-ffa3-bamboo-scrap-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-bamboo-scrap-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-bamboo-scrap-goes-to-an-opposing-member",
  ], // Bamboo Scrap
  42956963: [
    "opponent-field-effects-ffa3-nightmare-archfiends-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-nightmare-archfiends-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-nightmare-archfiends-goes-to-an-opposing-member",
  ], // Nightmare Archfiends
  55465441: [
    "opponent-field-effects-ffa3-give-and-take-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-give-and-take-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-give-and-take-goes-to-an-opposing-member",
  ], // Give and Take
  6203182: [
    "opponent-field-effects-ffa3-two-toads-with-one-sting-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-two-toads-with-one-sting-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-two-toads-with-one-sting-goes-to-an-opposing-member",
  ], // Two Toads with One Sting
  17228908: [
    "opponent-field-effects-ffa3-lost-world-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-lost-world-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-lost-world-goes-to-an-opposing-member",
  ], // Lost World
  33970665: [
    "opponent-field-effects-ffa3-guts-of-steel-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-guts-of-steel-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-guts-of-steel-goes-to-an-opposing-member",
  ], // Guts of Steel
  36890111: [
    "opponent-field-effects-ffa3-mansion-of-the-dreadful-dolls-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mansion-of-the-dreadful-dolls-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mansion-of-the-dreadful-dolls-goes-to-an-opposing-member",
  ], // Mansion of the Dreadful Dolls
  52782439: [
    "opponent-field-effects-ffa3-exceptional-schedule-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-exceptional-schedule-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-exceptional-schedule-goes-to-an-opposing-member",
  ], // Exceptional Schedule
  62767644: [
    "opponent-field-effects-ffa3-inferno-of-the-ashened-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-inferno-of-the-ashened-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-inferno-of-the-ashened-goes-to-an-opposing-member",
  ], // Inferno of the Ashened
  72554664: [
    "opponent-field-effects-ffa3-light-of-the-branded-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-light-of-the-branded-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-light-of-the-branded-goes-to-an-opposing-member",
  ], // Light of the Branded
  73355951: [
    "opponent-field-effects-ffa3-alpha-summon-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-alpha-summon-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-alpha-summon-goes-to-an-opposing-member",
  ], // Alpha Summon
  76384284: [
    "opponent-field-effects-ffa3-trojan-gladiator-beast-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-trojan-gladiator-beast-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-trojan-gladiator-beast-goes-to-an-opposing-member",
  ], // Trojan Gladiator Beast
  78610936: [
    "opponent-field-effects-ffa3-xyz-encore-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-xyz-encore-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-xyz-encore-goes-to-an-opposing-member",
  ], // Xyz Encore
  80044027: [
    "opponent-field-effects-ffa3-mikanko-fire-dance-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mikanko-fire-dance-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mikanko-fire-dance-goes-to-an-opposing-member",
  ], // Mikanko Fire Dance
  93775296: [
    "opponent-field-effects-ffa3-reverse-reuse-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-reverse-reuse-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-reverse-reuse-goes-to-an-opposing-member",
  ], // Reverse Reuse
  93912845: [
    "opponent-field-effects-ffa3-revival-gift-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-revival-gift-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-revival-gift-goes-to-an-opposing-member",
  ], // Revival Gift
  99330325: [
    "opponent-field-effects-ffa3-interrupted-kaiju-slumber-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-interrupted-kaiju-slumber-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-interrupted-kaiju-slumber-goes-to-an-opposing-member",
  ], // Interrupted Kaiju Slumber
  1041278: [
    "opponent-field-effects-ffa3-branded-expulsion-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-branded-expulsion-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-branded-expulsion-goes-to-an-opposing-member",
  ], // Branded Expulsion
  8837932: [
    "opponent-field-effects-ffa3-cubic-mandala-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-cubic-mandala-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-cubic-mandala-goes-to-an-opposing-member",
  ], // Cubic Mandala
  13204145: [
    "opponent-field-effects-ffa3-mimighoul-maker-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mimighoul-maker-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mimighoul-maker-goes-to-an-opposing-member",
  ], // Mimighoul Maker
  13935001: [
    "opponent-field-effects-ffa3-lunalight-serenade-dance-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-lunalight-serenade-dance-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-lunalight-serenade-dance-goes-to-an-opposing-member",
  ], // Lunalight Serenade Dance
  14283055: [
    "opponent-field-effects-ffa3-concours-de-cuisine-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-concours-de-cuisine-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-concours-de-cuisine-goes-to-an-opposing-member",
  ], // Concours de Cuisine
  49966595: [
    "opponent-field-effects-ffa3-graydle-parasite-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-graydle-parasite-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-graydle-parasite-goes-to-an-opposing-member",
  ], // Graydle Parasite
  63086455: [
    "opponent-field-effects-ffa3-terrors-of-the-overroot-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-terrors-of-the-overroot-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-terrors-of-the-overroot-goes-to-an-opposing-member",
  ], // Terrors of the Overroot
  85698115: [
    "opponent-field-effects-ffa3-terrors-of-the-afterroot-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-terrors-of-the-afterroot-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-terrors-of-the-afterroot-goes-to-an-opposing-member",
  ], // Terrors of the Afterroot
  93983867: [
    "opponent-field-effects-ffa3-trick-box-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-trick-box-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-trick-box-goes-to-an-opposing-member",
  ], // Trick Box
  96857854: [
    "opponent-field-effects-ffa3-diamond-duston-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-diamond-duston-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-diamond-duston-goes-to-an-opposing-member",
  ], // Diamond Duston
  561300: [
    "opponent-field-effects-ffa3-poisonous-viper-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-poisonous-viper-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-poisonous-viper-goes-to-an-opposing-member",
  ], // Poisonous Viper
  7392745: [
    "opponent-field-effects-ffa3-chewbone-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-chewbone-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-chewbone-goes-to-an-opposing-member",
  ], // Chewbone
  7623640: [
    "opponent-field-effects-ffa3-ceruli-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-ceruli-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-ceruli-goes-to-an-opposing-member",
  ], // Ceruli, Guru of Dark World
  11677278: [
    "opponent-field-effects-ffa3-mimighoul-armor-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mimighoul-armor-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mimighoul-armor-goes-to-an-opposing-member",
  ], // Mimighoul Armor
  22404675: [
    "opponent-field-effects-ffa3-mithra-the-thunder-vassal-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mithra-the-thunder-vassal-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mithra-the-thunder-vassal-goes-to-an-opposing-member",
  ], // Mithra the Thunder Vassal
  22411609: [
    "opponent-field-effects-ffa3-volcanic-trooper-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-volcanic-trooper-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-volcanic-trooper-goes-to-an-opposing-member",
  ], // Volcanic Trooper
  23920796: [
    "opponent-field-effects-ffa3-mimighoul-cerberus-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mimighoul-cerberus-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mimighoul-cerberus-goes-to-an-opposing-member",
  ], // Mimighoul Cerberus
  25131968: [
    "opponent-field-effects-ffa3-ken-the-warrior-dragon-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-ken-the-warrior-dragon-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-ken-the-warrior-dragon-goes-to-an-opposing-member",
  ], // Ken the Warrior Dragon
  26964762: [
    "opponent-field-effects-ffa3-destiny-hero-dark-angel-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-destiny-hero-dark-angel-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-destiny-hero-dark-angel-goes-to-an-opposing-member",
  ], // Destiny HERO - Dark Angel
  30069398: [
    "opponent-field-effects-ffa3-wall-of-ivy-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-wall-of-ivy-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-wall-of-ivy-goes-to-an-opposing-member",
  ], // Wall of Ivy
  37129797: [
    "opponent-field-effects-ffa3-vampire-sucker-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-vampire-sucker-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-vampire-sucker-goes-to-an-opposing-member",
  ], // Vampire Sucker
  38041940: [
    "opponent-field-effects-ffa3-seed-of-flame-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-seed-of-flame-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-seed-of-flame-goes-to-an-opposing-member",
  ], // Seed of Flame
  39829561: [
    "opponent-field-effects-ffa3-destiny-hero-departed-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-destiny-hero-departed-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-destiny-hero-departed-goes-to-an-opposing-member",
  ], // Destiny HERO - Departed
  41141943: [
    "opponent-field-effects-ffa3-superheavy-samurai-transporter-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-superheavy-samurai-transporter-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-superheavy-samurai-transporter-goes-to-an-opposing-member",
  ], // Superheavy Samurai Transporter
  43066927: [
    "opponent-field-effects-ffa3-mimighoul-fairy-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mimighoul-fairy-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mimighoul-fairy-goes-to-an-opposing-member",
  ], // Mimighoul Fairy
  44689688: [
    "opponent-field-effects-ffa3-jurrac-spinos-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-jurrac-spinos-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-jurrac-spinos-goes-to-an-opposing-member",
  ], // Jurrac Spinos
  48228390: [
    "opponent-field-effects-ffa3-pyrite-knight-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-pyrite-knight-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-pyrite-knight-goes-to-an-opposing-member",
  ], // Pyrite Knight
  50415441: [
    "opponent-field-effects-ffa3-mimighoul-archfiend-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mimighoul-archfiend-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mimighoul-archfiend-goes-to-an-opposing-member",
  ], // Mimighoul Archfiend
  52126602: [
    "opponent-field-effects-ffa3-gen-the-diamond-tiger-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-gen-the-diamond-tiger-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-gen-the-diamond-tiger-goes-to-an-opposing-member",
  ], // Gen the Diamond Tiger
  54191698: [
    "opponent-field-effects-ffa3-number-29-mannequin-cat-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-number-29-mannequin-cat-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-number-29-mannequin-cat-goes-to-an-opposing-member",
  ], // Number 29: Mannequin Cat
  74440055: [
    "opponent-field-effects-ffa3-cactus-fighter-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-cactus-fighter-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-cactus-fighter-goes-to-an-opposing-member",
  ], // Cactus Fighter
  81522098: [
    "opponent-field-effects-ffa3-mimighoul-dragon-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mimighoul-dragon-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mimighoul-dragon-goes-to-an-opposing-member",
  ], // Mimighoul Dragon
  82933935: [
    "opponent-field-effects-ffa3-mimighoul-flower-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-mimighoul-flower-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-mimighoul-flower-goes-to-an-opposing-member",
  ], // Mimighoul Flower
  69811710: [
    "opponent-field-effects-ffa3-girsu-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-girsu-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-girsu-goes-to-an-opposing-member",
  ], // Girsu, the Orcust Mekk-Knight
  82012319: [
    "opponent-field-effects-ffa3-scrap-golem-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-scrap-golem-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-scrap-golem-goes-to-an-opposing-member",
  ], // Scrap Golem
  9400127: [
    "opponent-field-effects-ffa3-flogos-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-flogos-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-flogos-goes-to-an-opposing-member",
  ], // Flogos, the Wind Warrior
  78783557: [
    "opponent-field-effects-ffa3-veidos-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-veidos-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-veidos-goes-to-an-opposing-member",
  ], // Veidos the Eruption Dragon of Extinction
  82773292: [
    "opponent-field-effects-ffa3-indulged-darklord-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-indulged-darklord-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-indulged-darklord-goes-to-an-opposing-member",
  ], // Indulged Darklord
  88124568: [
    "opponent-field-effects-ffa3-spyral-double-agent-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-spyral-double-agent-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-spyral-double-agent-goes-to-an-opposing-member",
  ], // SPYRAL Double Agent
  71015787: [
    "opponent-field-effects-ffa3-silent-wobby-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-silent-wobby-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-silent-wobby-goes-to-an-opposing-member",
  ], // Silent Wobby
  68378605: [
    "opponent-field-effects-ffa3-vodnika-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-vodnika-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-vodnika-goes-to-an-opposing-member",
  ], // Vodnika the Water Dragon
  26913989: [
    "opponent-field-effects-ffa3-geistgrinder-golem-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-geistgrinder-golem-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-geistgrinder-golem-goes-to-an-opposing-member",
  ], // Geistgrinder Golem
  82994509: [
    "opponent-field-effects-ffa3-horseytail-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-horseytail-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-horseytail-goes-to-an-opposing-member",
  ], // Horseytail
  81003500: [
    "opponent-field-effects-ffa3-elemental-hero-necroid-shaman-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-elemental-hero-necroid-shaman-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-elemental-hero-necroid-shaman-goes-to-an-opposing-member",
  ], // Necroid Shaman
  66661678: [
    "opponent-field-effects-ffa3-royal-knight-of-the-ice-barrier-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-royal-knight-of-the-ice-barrier-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-royal-knight-of-the-ice-barrier-goes-to-an-opposing-member",
  ], // Royal Knight of the Ice Barrier
  57844634: [
    "opponent-field-effects-ffa3-nimble-musasabi-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-nimble-musasabi-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-nimble-musasabi-goes-to-an-opposing-member",
  ], // Nimble Musasabi
  65676461: [
    "opponent-field-effects-ffa3-number-32-shark-drake-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-number-32-shark-drake-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-number-32-shark-drake-goes-to-an-opposing-member",
  ], // Number 32: Shark Drake
  59900655: [
    "opponent-field-effects-ffa3-gold-pride-nytro-head-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-gold-pride-nytro-head-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-gold-pride-nytro-head-goes-to-an-opposing-member",
  ], // Gold Pride - Nytro Head
  63013339: [
    "opponent-field-effects-ffa3-sky-striker-ace-camellia-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-sky-striker-ace-camellia-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-sky-striker-ace-camellia-goes-to-an-opposing-member",
  ], // Sky Striker Ace - Camellia
  65477143: [
    "opponent-field-effects-ffa3-abyss-actor-liberty-dramatist-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-abyss-actor-liberty-dramatist-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-abyss-actor-liberty-dramatist-goes-to-an-opposing-member",
  ], // Abyss Actor - Liberty Dramatist
  40343749: [
    "opponent-field-effects-ffa3-house-duston-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-house-duston-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-house-duston-goes-to-an-opposing-member",
  ], // House Duston
  3685372: [
    "opponent-field-effects-ffa3-gimmick-puppet-fanatix-machinix-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-gimmick-puppet-fanatix-machinix-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-gimmick-puppet-fanatix-machinix-goes-to-an-opposing-member",
  ], // CXyz Gimmick Puppet Fanatix Machinix
  47126872: [
    "opponent-field-effects-ffa3-space-time-police-goes-to-the-picked-opponent",
    "opponent-field-effects-ffa4-space-time-police-goes-to-the-picked-opponent",
    "opponent-field-effects-tag-space-time-police-goes-to-an-opposing-member",
  ], // Space-Time Police
  // Cross-seat staples proven live (the event binding and the delayed draw), all three tables.
  35480699: [
    "book-of-eclipse-ffa3-p0-declared-opponent-flips-its-own-monsters-and-draws-for-them",
    "book-of-eclipse-ffa3-p1-declared-opponent-flips-its-own-monsters-and-draws-for-them",
    "book-of-eclipse-ffa4-p0-declared-opponent-flips-its-own-monsters-and-draws-for-them",
    "book-of-eclipse-ffa4-p2-declared-opponent-flips-its-own-monsters-and-draws-for-them",
    "book-of-eclipse-tag-p0-each-opponent-flips-its-own-monsters-and-draws-for-them",
    "book-of-eclipse-tag-p1-each-opponent-flips-its-own-monsters-and-draws-for-them",
    "book-of-eclipse-ffa3-p0-activates-in-the-turn-of-p1-declared-opponent-flips-its-own-monsters-and-draws-for-them",
    "book-of-eclipse-ffa4-p0-declared-p2-has-no-monsters-no-other-opponent-flips-or-draws",
    "book-of-eclipse-ffa4-p0-declared-p3-eliminated-before-end-phase",
  ], // Book of Eclipse
  5010422: [
    "astromorrigan-ffa3-p0-declared-opponent-takes-damage-for-its-own-destroyed-monsters",
    "astromorrigan-ffa3-p1-declared-opponent-takes-damage-for-its-own-destroyed-monsters",
    "astromorrigan-ffa4-p0-declared-opponent-takes-damage-for-its-own-destroyed-monsters",
    "astromorrigan-ffa4-p2-declared-opponent-takes-damage-for-its-own-destroyed-monsters",
    "astromorrigan-tag-p0-each-opponent-takes-damage-for-its-own-destroyed-monsters",
    "astromorrigan-tag-p1-each-opponent-takes-damage-for-its-own-destroyed-monsters",
    "astromorrigan-ffa3-p0-flipped-in-the-turn-of-p1-declared-opponent-takes-damage-for-its-own-destroyed-monsters",
    "astromorrigan-ffa4-p0-declared-p2-has-no-defense-monsters-no-other-opponent-destroyed-or-damaged",
  ], // Prediction Princess Astromorrigan
  76922029: [
    "don-zaloog-ffa3-p1-damages-p2-deck-effect-hits-only-p2",
    "don-zaloog-ffa3-p1-damages-p0-hand-effect-hits-only-p0",
    "don-zaloog-ffa4-p3-damages-p1-deck-effect-hits-only-p1",
    "don-zaloog-ffa4-p2-damages-p0-hand-effect-hits-only-p0",
    "don-zaloog-tag-p1-damages-p2-deck-effect-hits-only-p2",
    "don-zaloog-tag-p0-damages-p3-hand-effect-hits-only-p3",
    "don-zaloog-tag-p2-damages-p1-hand-effect-hits-only-p1",
    "don-zaloog-tag-p3-damages-p0-deck-effect-hits-only-p0",
  ], // Don Zaloog
  77538567: [
    "dark-bribe-ffa3-p1-pot-negated-by-p2-only-p1-draws",
    "dark-bribe-ffa3-p1-pot-negated-by-p0-only-p1-draws",
    "dark-bribe-ffa4-p2-pot-negated-by-p0-only-p2-draws",
    "dark-bribe-ffa4-p2-pot-negated-by-p3-only-p2-draws",
    "dark-bribe-tag-p1-pot-negated-by-p0-only-p1-draws",
    "dark-bribe-tag-p1-pot-negated-by-p2-only-p1-draws",
    "dark-bribe-tag-p0-pot-negated-by-p3-only-p0-draws",
    "dark-bribe-tag-p0-pot-negated-by-p1-only-p0-draws",
  ], // Dark Bribe
  81510157: [
    "soul-taker-ffa3-p1-destroys-monster-of-p2-p2-gains-1000",
    "soul-taker-ffa3-p1-destroys-monster-of-p0-p0-gains-1000",
    "soul-taker-ffa4-p2-destroys-monster-of-p3-p3-gains-1000",
    "soul-taker-ffa4-p3-destroys-monster-of-p1-p1-gains-1000",
    "soul-taker-tag-p1-destroys-monster-of-p0-p0-gains-1000",
    "soul-taker-tag-p1-destroys-monster-of-p2-p2-gains-1000",
    "soul-taker-tag-p0-destroys-monster-of-p3-p3-gains-1000",
  ], // Soul Taker
  10045474: [
    "infinite-impermanence-ffa3-p1-turn-p2-negates-calculator-of-p1",
    "infinite-impermanence-ffa4-p2-turn-p0-negates-calculator-of-p2",
    "infinite-impermanence-tag-p0-turn-p1-negates-calculator-of-p0",
    "infinite-impermanence-tag-p0-turn-p3-negates-calculator-of-p2",
    "infinite-impermanence-tag-p1-turn-p2-negates-calculator-of-p3",
  ], // Infinite Impermanence
  97268402: [
    "effect-veiler-ffa3-p1-turn-p2-negates-calculator-of-p1",
    "effect-veiler-ffa3-p1-turn-p0-negates-calculator-of-p1",
    "effect-veiler-ffa4-p2-turn-p3-negates-calculator-of-p2",
    "effect-veiler-ffa4-p1-turn-p0-negates-calculator-of-p1",
    "effect-veiler-tag-p0-turn-p1-negates-calculator-of-p0",
    "effect-veiler-tag-p0-turn-p1-negates-calculator-of-p2",
    "effect-veiler-tag-p1-turn-p0-negates-calculator-of-p1",
    "effect-veiler-tag-p1-turn-p2-negates-calculator-of-p3",
    "effect-veiler-tag-p0-turn-partner-p2-is-never-offered",
  ], // Effect Veiler
  23434538: [
    "maxx-c-ffa3-p1-special-summons-p2-draws",
    "maxx-c-ffa3-p1-special-summons-p0-draws",
    "maxx-c-ffa4-p2-special-summons-p0-draws",
    "maxx-c-ffa4-p2-special-summons-p3-draws",
    "maxx-c-tag-p1-special-summons-p0-draws",
    "maxx-c-tag-p1-special-summons-p2-draws",
    "maxx-c-tag-p1-special-summons-p3-no-draw",
    "maxx-c-tag-p0-special-summons-p2-no-draw",
  ], // Maxx "C"
};
