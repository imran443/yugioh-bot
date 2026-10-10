// Live scenarios of cards that compare monsters or cards of "your opponent" with yours, and that review A found without one:
// Kaiser Colosseum (a value of the summoning duelist), the five scan-gap cards (Three in One, Sangen Kaiho, Evilswarm Exciton Knight,
// Ghost Reaper & Winter Cherries, Mimighoul Slime), the target cap of Ultimate Sky and the per-opponent Mystic Mine.
// Each card has the same two cases: the SUM of the opponents passes but no single opponent does (the card is not offered, nothing changes),
// and one opponent passes (the card is offered and acts on that opponent). Plain data, also read by scripts/rule-coverage.ts;
// tests/scenarios/multiplayer/compare-gaps.test.ts runs them on a live core (NSEAT_LIVE=1). Every scenario ends with the state of every seat.
// Decisions: docs/adr/0002-multiplayer-duel-rules.md (question 2): FFA, the activator compares with ONE opponent.

import {
  activate, changePhase, changePosition, choose, endTurn, expectBoard, expectEliminated, expectEvents, expectNoPrompt, expectNotOffered, expectOffered, expectPickOptions, expectPickSeats, expectPrompt, expectRetry, expectTurn,
  normalSummon, pass, pickOpponent, position, select, surrender, yes, zone, type BoardExpect, type DuelistExpect, type Scenario, type Step,
} from "../../support/dsl.js";
import { defineScenarioWithFfaFirstDraw as defineScenario } from "./ffa-first-draw.js";
import { ELF, SOURCE } from "./nseat-scenarios.js";

type Seat = "p0" | "p1" | "p2" | "p3";
const OPP_PICK = `${SOURCE} [R-COMMON-OPP-PICK]`;
const OX = "Battle Ox";
const GUARDIAN = "Celtic Guardian";
const AXE = "Axe Raider";
const FANG = "Silver Fang";
const BEAVER = "Beaver Warrior";
const SKULL = "Summoned Skull";
const RAT = "Giant Rat";
const SANGAN = "Sangan";
const WITCH = "Witch of the Black Forest";
const BUG = "Man-Eater Bug";
const RYU_RAN = "Ryu-Ran";
const NUMERON = "Number 100: Numeron Dragon";
const TIO = "Three in One";
const SANGEN = "Sangen Kaiho";
const GHOST = "Ghost Reaper & Winter Cherries";
const EXCITON = "Evilswarm Exciton Knight";
const SLIME = "Mimighoul Slime";
const MINE = "Mystic Mine";
const PIPER = "Mystic Piper";
const OFFERINGS = "Offerings to the Doomed";
const POT = "Pot of Greed";
const MIRROR = "Mirror Force";
const HOLE = "Trap Hole";

/**
 * The state of EVERY seat of a format, exact for the monster zones, the Spell and Trap zones, the Graveyard, the banished zone and
 * the Life Points (8000 for a seat, 16000 for the team of a Tag duel, unless given). A seat that the spec leaves out must be empty.
 * The hand is checked only when the spec names it.
 */
function everySeat(format: "ffa3" | "ffa4" | "tag", spec: Partial<Record<Seat, DuelistExpect>>): Step {
  const seats: Seat[] = format === "ffa3" ? ["p0", "p1", "p2"] : ["p0", "p1", "p2", "p3"];
  const board: BoardExpect = {};
  for (const seat of seats) board[seat] = { lp: format === "tag" ? 16000 : 8000, monsters: [], spells: [], grave: [], banished: [], ...spec[seat] };
  return expectBoard(board);
}

/**
 * Number 100: Numeron Dragon at 4 seats: every living duelist, the Tag partners included (Q3), Sets 1 Spell/Trap from its OWN Graveyard
 * after every monster is destroyed. The FFA3 case is the scenario above.
 */
function numeronEverySeat(format: "ffa4" | "tag"): Scenario {
  const label = format === "tag" ? "Tag" : "FFA4";
  const DARK_HOLE = "Dark Hole";
  return defineScenario({
    id: `compare-gaps-${format}-numeron-dragon-every-seat-sets-its-own-card`,
    title: `${label}: Numeron Dragon of p0 is destroyed by an effect: every monster is destroyed, then p0, p1, p2 and p3 each Set 1 Spell/Trap from their OWN Graveyard${format === "tag" ? " (the partners p2 and p3 too)" : ""}`,
    source: OPP_PICK,
    rules: format === "tag" ? ["R-COMMON-OPP-PICK", "R-TAG-PARTNER"] : ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "chooser", "trigger", format, "card:57314798"],
    setup: {
      format,
      p0: { hand: [OFFERINGS], monsters: [NUMERON], grave: [POT] },
      p1: { monsters: [OX], grave: [MIRROR] },
      p2: { monsters: [GUARDIAN], grave: [HOLE] },
      p3: { monsters: [AXE], grave: [DARK_HOLE] },
    },
    steps: [
      activate(OFFERINGS, "p0"),
      select(NUMERON),
      yes("p0"),
      select(POT),
      // Tag: the Graveyard of a scope is the one of the team. p1 chooses between Mirror Force and Dark Hole (its team), and p2 between Trap Hole
      // and Offerings to the Doomed (the Spell of p0 is in the Graveyard of the team too, as it is for p0): the card that p0 chose is not offered
      // again. p3 has Dark Hole left. FFA4: p1, p2 and p3 have one candidate each, so their scopes pick without a prompt.
      ...(format === "tag" ? [select(MIRROR), select(HOLE)] : []),
      everySeat(format, {
        p0: { hand: [], monsters: [], spells: [POT], grave: [NUMERON, OFFERINGS] },
        p1: { monsters: [], spells: [MIRROR], grave: [OX] },
        p2: { monsters: [], spells: [HOLE], grave: [GUARDIAN] },
        p3: { monsters: [], spells: [DARK_HOLE], grave: [AXE] },
      }),
    ],
  });
}

export const COMPARE_GAP_SCENARIOS: Scenario[] = [
  defineScenario({
    id: "compare-gaps-ffa3-kaiser-colosseum-limit-counts-the-summoner-only",
    title: "FFA3: Kaiser Colosseum limits the Tribute of a monster of p0 by the monsters of the SUMMONING duelist (p1: none), not by the sum of the opponents of p0",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK", "R-FFA-OPP-ONE"],
    tags: ["multiplayer", "compare", "ffa3", "card:35059553", "card:68005187"],
    // p0 controls 2 monsters and Kaiser Colosseum. p1 has none, p2 has 1. Soul Exchange of p1 Tributes a monster of p0: one Tribute leaves p1 with 1 monster,
    // not more than p0 (1 after the Tribute). The sum of p1 and p2 (1) would block it.
    setup: {
      format: "ffa3",
      p0: { monsters: [OX, GUARDIAN], spells: ["Kaiser Colosseum"] },
      p1: { hand: [SKULL, "Soul Exchange"] },
      p2: { monsters: [BEAVER] },
    },
    steps: [
      endTurn("p0"),
      activate("Soul Exchange", "p1"),
      // R-FFA-OPP-ONE: Soul Exchange declares p0 before selecting its monster.
      pickOpponent("p0", "p1"),
      select(OX),
      expectOffered("tributeSummon", SKULL, "p1"),
      normalSummon(SKULL, "p1"),
      select(OX),
      everySeat("ffa3", {
        p0: { monsters: [GUARDIAN], spells: ["Kaiser Colosseum"], grave: [OX] },
        p1: { monsters: [SKULL], grave: ["Soul Exchange"], hand: [ELF] },
        p2: { monsters: [BEAVER] },
      }),
    ],
  }),
  // Three in One: Quick-Play Spell, End Phase of an opponent turn, "your opponent has more cards in the hand and on the field".
  // p0 holds 3 cards (the set Three in One and 2 in the hand). p1 draws in its turn and holds 3 in its End Phase.
  defineScenario({
    id: "compare-gaps-ffa3-three-in-one-sum-passes-no-single-opponent",
    title: "FFA3: p1 and p2 hold 3 cards each and p0 holds 3: the sum (6) is more but no single opponent is: Three in One is not offered in the End Phase of p1",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:50838440"],
    setup: {
      format: "ffa3",
      p0: { hand: [FANG, BEAVER], spells: [{ card: TIO, pos: "set" }], grave: [OX, GUARDIAN, AXE] },
      p1: { hand: [RAT, FANG] },
      p2: { hand: [RAT, OX, GUARDIAN] },
    },
    steps: [
      endTurn("p0"),
      // p0 gets no window in the End Phase of p1 (nothing of p0 can be activated): the turn goes on to p2.
      endTurn("p1"),
      expectTurn("p2", 3),
      everySeat("ffa3", {
        p0: { hand: [FANG, BEAVER], spells: [TIO], grave: [OX, GUARDIAN, AXE] },
        p1: { hand: [RAT, FANG, ELF] },
        p2: { hand: [RAT, OX, GUARDIAN, ELF] },
      }),
    ],
  }),
  defineScenario({
    id: "compare-gaps-ffa3-three-in-one-only-the-turn-player-counts",
    title: "FFA3: p2 holds 4 cards, more than p0 (3), but it is the End Phase of p1 (3 cards): Three in One is not offered, the opponent whose turn it is does not have more",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:50838440"],
    setup: {
      format: "ffa3",
      p0: { hand: [FANG, BEAVER], spells: [{ card: TIO, pos: "set" }], grave: [OX, GUARDIAN, AXE] },
      p1: { hand: [RAT, FANG] },
      p2: { hand: [RAT, OX, GUARDIAN, ELF] },
    },
    steps: [
      endTurn("p0"),
      // p0 gets no window in the End Phase of p1: the turn goes on to p2.
      endTurn("p1"),
      expectTurn("p2", 3),
      everySeat("ffa3", {
        p0: { hand: [FANG, BEAVER], spells: [TIO], grave: [OX, GUARDIAN, AXE] },
        p1: { hand: [RAT, FANG, ELF] },
        p2: { hand: [RAT, OX, GUARDIAN, ELF, ELF] },
      }),
    ],
  }),
  defineScenario({
    id: "compare-gaps-ffa3-three-in-one-one-opponent-has-more",
    title: "FFA3: p1 holds 5 cards in its own End Phase, more than p0 (4), and p2 holds 3: Three in One is offered and Special Summons 3 Normal Monsters from the Graveyard of p0",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:50838440"],
    setup: {
      format: "ffa3",
      p0: { hand: [FANG, BEAVER], spells: [{ card: TIO, pos: "set" }], grave: [OX, GUARDIAN, AXE] },
      p1: { hand: [RAT, FANG, OX, AXE] },
      p2: { hand: [RAT, OX, GUARDIAN] },
    },
    steps: [
      endTurn("p0"),
      changePhase("end", "p1"),
      expectOffered("activate", TIO, "p0"),
      activate(TIO, "p0"),
      // Exactly 3 Normal Monsters in the Graveyard: the engine summons them with no pick, then the turn goes on to p2.
      expectTurn("p2", 3),
      everySeat("ffa3", {
        p0: { hand: [FANG, BEAVER], monsters: [OX, GUARDIAN, AXE], grave: [TIO] },
        p1: { hand: [RAT, FANG, OX, AXE, ELF] },
        p2: { hand: [RAT, OX, GUARDIAN, ELF] },
      }),
    ],
  }),
  // Sangen Kaiho: Quick-Play Spell, "you control only FIRE Dragon monsters and your opponent controls more monsters".
  defineScenario({
    id: "compare-gaps-ffa3-sangen-kaiho-sum-passes-no-single-opponent",
    title: "FFA3: p0 controls 1 monster (Ryu-Ran), p1 and p2 control 1 each (sum 2): Sangen Kaiho is not offered",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:25388971"],
    setup: {
      format: "ffa3",
      p0: { monsters: [RYU_RAN], spells: [{ card: SANGEN, pos: "set" }] },
      p1: { monsters: [OX] },
      p2: { monsters: [GUARDIAN] },
    },
    steps: [
      expectNotOffered("activate", SANGEN, "p0"),
      endTurn("p0"),
      everySeat("ffa3", { p0: { monsters: [RYU_RAN], spells: [SANGEN] }, p1: { hand: [ELF], monsters: [OX] }, p2: { monsters: [GUARDIAN] } }),
    ],
  }),
  defineScenario({
    id: "compare-gaps-ffa3-sangen-kaiho-one-opponent-has-more",
    title: "FFA3: p2 controls 2 monsters, more than p0 (1): Sangen Kaiho is offered and resolves",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:25388971"],
    setup: {
      format: "ffa3",
      p0: { monsters: [RYU_RAN], spells: [{ card: SANGEN, pos: "set" }] },
      p1: { monsters: [OX] },
      p2: { monsters: [GUARDIAN, AXE] },
    },
    steps: [
      expectOffered("activate", SANGEN, "p0"),
      activate(SANGEN, "p0"),
      everySeat("ffa3", { p0: { monsters: [RYU_RAN], grave: [SANGEN] }, p1: { monsters: [OX] }, p2: { monsters: [GUARDIAN, AXE] } }),
    ],
  }),
  // Ghost Reaper & Winter Cherries: Quick Effect from the hand, "your opponent controls more monsters than you"; it banishes the copies
  // of the chosen Extra Deck card from the Extra Deck of the opponent. Every seat holds one Numeron Dragon in its Extra Deck.
  defineScenario({
    id: "compare-gaps-ffa3-ghost-reaper-sum-passes-no-single-opponent",
    title: "FFA3: p0 controls 1 monster, p1 and p2 control 1 each (sum 2): Ghost Reaper & Winter Cherries is not offered",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:62015408"],
    setup: {
      format: "ffa3",
      p0: { hand: [GHOST], monsters: [ELF], extra: [NUMERON] },
      p1: { monsters: [SANGAN], extra: [NUMERON] },
      p2: { monsters: [WITCH], extra: [NUMERON] },
    },
    steps: [
      expectNotOffered("activate", GHOST, "p0"),
      endTurn("p0"),
      everySeat("ffa3", {
        p0: { hand: [GHOST], monsters: [ELF], extra: [NUMERON] },
        p1: { hand: [ELF], monsters: [SANGAN], extra: [NUMERON] },
        p2: { monsters: [WITCH], extra: [NUMERON] },
      }),
    ],
  }),
  defineScenario({
    id: "compare-gaps-ffa3-ghost-reaper-one-opponent-has-more",
    title: "FFA3: p2 controls 2 monsters, more than p0 (1): Ghost Reaper & Winter Cherries is offered and acts on the Extra Deck of the opponent",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:62015408"],
    setup: {
      format: "ffa3",
      p0: { hand: [GHOST], monsters: [ELF], extra: [NUMERON] },
      p1: { monsters: [SANGAN], extra: [NUMERON] },
      p2: { monsters: [WITCH, BUG], extra: [NUMERON] },
    },
    steps: [
      expectOffered("activate", GHOST, "p0"),
      activate(GHOST, "p0"),
      everySeat("ffa3", {
        p0: { hand: [], monsters: [ELF], extra: [NUMERON], grave: [GHOST] },
        p1: { monsters: [SANGAN], extra: [NUMERON] },
        p2: { monsters: [WITCH, BUG], extra: [], banished: [NUMERON] },
      }),
    ],
  }),
  // Evilswarm Exciton Knight: Quick Effect, "your opponent has more cards in the hand and on the field than you"; it destroys all other cards on the field.
  defineScenario({
    id: "compare-gaps-ffa3-exciton-knight-sum-passes-no-single-opponent",
    title: "FFA3: p0 holds 1 card (the Xyz monster), p1 and p2 hold 1 each (sum 2): Evilswarm Exciton Knight is not offered",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:46772449"],
    setup: {
      format: "ffa3",
      p0: { monsters: [{ card: EXCITON, materials: [AXE, BEAVER] }] },
      p1: { monsters: [RAT] },
      p2: { monsters: [OX] },
    },
    steps: [
      expectNotOffered("activate", EXCITON, "p0"),
      endTurn("p0"),
      everySeat("ffa3", { p0: { monsters: [EXCITON] }, p1: { hand: [ELF], monsters: [RAT] }, p2: { monsters: [OX] } }),
    ],
  }),
  defineScenario({
    id: "compare-gaps-ffa3-exciton-knight-one-opponent-has-more",
    title: "FFA3: p2 holds 3 cards, more than p0 (2): Evilswarm Exciton Knight is offered and destroys the other cards on the field",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:46772449"],
    setup: {
      format: "ffa3",
      p0: { monsters: [{ card: EXCITON, materials: [AXE, BEAVER] }] },
      p1: { monsters: [RAT] },
      p2: { hand: [ELF], monsters: [OX, GUARDIAN] },
    },
    steps: [
      expectOffered("activate", EXCITON, "p0"),
      activate(EXCITON, "p0"),
      select(AXE),
      everySeat("ffa3", { p0: { monsters: [EXCITON], grave: [AXE] }, p1: { grave: [RAT] }, p2: { hand: [ELF], grave: [OX, GUARDIAN] } }),
    ],
  }),
  // Mimighoul Slime: ignition effect from the hand. It is summoned face-down to the field of an opponent, or face-up to your own when
  // ONE opponent controls more monsters than you (the second branch is the compare).
  defineScenario({
    id: "compare-gaps-ffa3-mimighoul-slime-sum-passes-no-single-opponent",
    title: "FFA3: p0 controls 1 monster, p1 and p2 control 1 each (sum 2): Mimighoul Slime offers only the face-down branch, not the summon to the own field",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:80551022"],
    setup: {
      format: "ffa3",
      p0: { hand: [SLIME], monsters: [ELF] },
      p1: { monsters: [SANGAN] },
      p2: { monsters: [WITCH] },
    },
    steps: [
      activate(SLIME, "p0"),
      expectPickSeats(["p1", "p2"], "p0"),
      pickOpponent("p2", "p0"),
      // No opponent passes the compare alone: there is no option prompt, the card goes face-down to the picked opponent.
      everySeat("ffa3", { p0: { hand: [], monsters: [ELF] }, p1: { monsters: [SANGAN] }, p2: { monsters: [WITCH, SLIME] } }),
    ],
  }),
  defineScenario({
    id: "compare-gaps-ffa3-mimighoul-slime-one-opponent-has-more",
    title: "FFA3: p2 controls 2 monsters, more than p0 (1): Mimighoul Slime offers both branches and the summon to the own field works",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:80551022"],
    setup: {
      format: "ffa3",
      p0: { hand: [SLIME], monsters: [ELF] },
      p1: { monsters: [SANGAN] },
      p2: { monsters: [WITCH, BUG] },
    },
    steps: [
      activate(SLIME, "p0"),
      pickOpponent("p2", "p0"),
      // The picked opponent p2 passes the compare: both branches are offered.
      expectPickOptions({ count: 2 }, "p0"),
      choose("face-up on your field", "p0"),
      everySeat("ffa3", { p0: { hand: [], monsters: [ELF, SLIME] }, p1: { monsters: [SANGAN] }, p2: { monsters: [WITCH, BUG] } }),
    ],
  }),
  defineScenario({
    id: "compare-gaps-ffa3-mimighoul-slime-picked-opponent-does-not-pass",
    title: "FFA3: p2 controls 2 monsters (more than p0) but p1 controls 1: p0 picks p1, so the face-up branch is not offered and the card goes face-down to p1",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:80551022"],
    setup: {
      format: "ffa3",
      p0: { hand: [SLIME], monsters: [ELF] },
      p1: { monsters: [SANGAN] },
      p2: { monsters: [WITCH, BUG] },
    },
    steps: [
      activate(SLIME, "p0"),
      pickOpponent("p1", "p0"),
      everySeat("ffa3", { p0: { hand: [], monsters: [ELF] }, p1: { monsters: [SANGAN, SLIME] }, p2: { monsters: [WITCH, BUG] } }),
    ],
  }),
  // Mystic Mine: only an opponent that ALONE controls more monsters than the controller of the Mine cannot activate monster effects and
  // cannot declare an attack. Mystic Piper (Tribute itself: draw 1 card) is a monster effect that any duelist can activate on its own.
  defineScenario({
    id: "compare-gaps-ffa3-mystic-mine-only-the-opponent-with-more-monsters-is-locked",
    title: "FFA3: p0 controls 2 monsters, p1 controls 3 and p2 controls 1: Mystic Mine locks p1 (no monster effect, no attack) and leaves p2 free",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:76375976"],
    setup: {
      format: "ffa3",
      p0: { hand: [MINE], monsters: [ELF, RAT] },
      p1: { monsters: [PIPER, WITCH, BUG] },
      p2: { monsters: [PIPER] },
    },
    steps: [
      activate(MINE, "p0"),
      endTurn("p0"),
      // Round 1 (no attack is legal in it): the activation lock shows on the Piper of p1, the Piper of p2 is free.
      expectNotOffered("activate", PIPER, "p1"),
      endTurn("p1"),
      expectOffered("activate", PIPER, "p2"),
      endTurn("p2"),
      // Round 2: p0 ends its turn, then the attack lock shows: no monster of p1 may attack, the Piper of p2 may.
      endTurn("p0"),
      changePhase("battle", "p1"),
      expectNotOffered("attack", PIPER, "p1"),
      expectNotOffered("attack", WITCH, "p1"),
      expectNotOffered("attack", BUG, "p1"),
      endTurn("p1"),
      changePhase("battle", "p2"),
      expectOffered("attack", PIPER, "p2"),

      everySeat("ffa3", {
        p0: { hand: [ELF], monsters: [ELF, RAT], spells: [MINE] },
        p1: { hand: [ELF, ELF], monsters: [PIPER, WITCH, BUG] },
        p2: { hand: [ELF, ELF], monsters: [PIPER] },
      }),
    ],
  }),
  defineScenario({
    id: "compare-gaps-ffa3-mystic-mine-no-opponent-has-more-nobody-is-locked",
    title: "FFA3: p0 controls 2 monsters, p1 and p2 control 1 each (no opponent has more): Mystic Mine locks nobody, p1 and p2 activate and attack",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:76375976"],
    setup: {
      format: "ffa3",
      p0: { hand: [MINE], monsters: [ELF, RAT] },
      p1: { monsters: [PIPER] },
      p2: { monsters: [PIPER] },
    },
    steps: [
      activate(MINE, "p0"),
      endTurn("p0"),
      expectOffered("activate", PIPER, "p1"),
      endTurn("p1"),
      expectOffered("activate", PIPER, "p2"),
      endTurn("p2"),
      endTurn("p0"),
      changePhase("battle", "p1"),
      expectOffered("attack", PIPER, "p1"),
      endTurn("p1"),
      changePhase("battle", "p2"),
      expectOffered("attack", PIPER, "p2"),
      everySeat("ffa3", {
        p0: { hand: [ELF], monsters: [ELF, RAT], spells: [MINE] },
        p1: { hand: [ELF, ELF], monsters: [PIPER] },
        p2: { hand: [ELF, ELF], monsters: [PIPER] },
      }),
    ],
  }),
  defineScenario({
    id: "compare-gaps-ffa3-mystic-mine-self-locks-if-one-opponent-has-fewer",
    title: "FFA3: Mystic Mine locks its controller when one opponent has fewer monsters, even if another has more",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "compare", "ffa3", "card:76375976"],
    setup: { format: "ffa3", p0: { hand: [MINE], monsters: [PIPER, ELF] }, p1: { monsters: [OX, GUARDIAN, AXE] }, p2: { monsters: [FANG] } },
    steps: [
      activate(MINE, "p0"), expectNotOffered("activate", PIPER, "p0"),
      endTurn("p0"), endTurn("p1"), endTurn("p2"),
      expectNotOffered("activate", PIPER, "p0"), changePhase("battle", "p0"),
      expectNotOffered("attack", PIPER, "p0"), expectNotOffered("attack", ELF, "p0"),
      everySeat("ffa3", { p0: { monsters: [PIPER, ELF], spells: [MINE] }, p1: { monsters: [OX, GUARDIAN, AXE] }, p2: { monsters: [FANG] } }),
    ],
  }),
  // Number 100: Numeron Dragon (destroy trigger): destroys every monster, then EVERY duelist Sets 1 Spell/Trap from its own Graveyard.
  // Each Set is done in the window of the seat that chose the card (the owner of a card is folded to 1 in FFA).
  defineScenario({
    id: "compare-gaps-ffa3-numeron-dragon-every-seat-sets-its-own-card",
    title: "FFA3: Numeron Dragon of p0 is destroyed by an effect: every monster is destroyed, then p0, p1 and p2 each Set 1 Spell/Trap from their OWN Graveyard",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK"],
    tags: ["multiplayer", "chooser", "trigger", "ffa3", "card:57314798"],
    setup: {
      format: "ffa3",
      p0: { hand: [OFFERINGS], monsters: [NUMERON], grave: [POT] },
      p1: { monsters: [OX], grave: [MIRROR] },
      p2: { monsters: [GUARDIAN], grave: [HOLE] },
    },
    steps: [
      activate(OFFERINGS, "p0"),
      select(NUMERON),
      yes("p0"),
      select(POT),
      // p1 and p2 have one candidate each, so their windows pick without a prompt.
      everySeat("ffa3", {
        p0: { hand: [], monsters: [], spells: [POT], grave: [NUMERON, OFFERINGS] },
        p1: { monsters: [], spells: [MIRROR], grave: [OX] },
        p2: { monsters: [], spells: [HOLE], grave: [GUARDIAN] },
      }),
    ],
  }),
  // W7: the only opponent that passes the compare gives up. A seat that is out is not an opponent: nothing is offered, no pick.
  defineScenario({
    id: "compare-gaps-ffa3-eliminated-seat-is-the-only-one-that-passes-not-offered",
    title: "FFA3: p2 is the only opponent with more monsters than p0 and gives up: Ultimate Sky is not offered and no pick prompt opens (W7)",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK", "R-FFA-ELIMINATION"],
    tags: ["multiplayer", "compare", "elimination", "ffa3", "card:38817295"],
    setup: {
      format: "ffa3",
      p0: { hand: ["Ultimate Sky"], monsters: [ELF, RAT] },
      p1: { monsters: [SANGAN] },
      p2: { monsters: [WITCH, BUG, OX] },
    },
    steps: [
      expectOffered("activate", "Ultimate Sky", "p0"),
      surrender("p2"),
      // The loss lands at the next Adjust: p0 changes the position of a monster, then p2 is out.
      changePosition(ELF, "p0"),
      expectEliminated("p2"),
      expectNotOffered("activate", "Ultimate Sky", "p0"),
      endTurn("p0"),
      expectBoard({
        p0: { lp: 8000, hand: ["Ultimate Sky"], monsters: [ELF, RAT] },
        p1: { lp: 8000, monsters: [SANGAN] },
      }),
    ],
  }),
  // W8 in FFA3: surrender removes one option, so the sole surviving opponent is picked automatically.
  defineScenario({
    id: "compare-gaps-ffa3-surrender-while-the-opponent-pick-is-open",
    title: "FFA3: p1 gives up while p0 picks an opponent for Ultimate Sky: p1 is removed immediately, p2 is picked automatically, and Sky negates p2's Man-Eater Bug for 800 LP (W8)",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK", "R-FFA-OPP-ONE", "R-FFA-ELIMINATION", "R-COMMON-SURRENDER-EOT"],
    tags: ["multiplayer", "compare", "elimination", "ffa3", "card:38817295"],
    setup: {
      format: "ffa3",
      p0: { hand: ["Ultimate Sky"], monsters: [ELF] },
      p1: { monsters: [SANGAN, WITCH] },
      p2: { monsters: [BUG, OX, WITCH] },
    },
    steps: [
      activate("Ultimate Sky", "p0"),
      expectPickSeats(["p1", "p2"], "p0"),
      expectPickOptions([{ id: "opt:0", seat: "p1" }, { id: "opt:1", seat: "p2" }], "p0"),
      surrender("p1"),
      // R-COMMON-SURRENDER-EOT: p1 is out before p0 answers.
      expectEliminated("p1"),
      // The filtered opt:1 and the only Spell zone are answered automatically.
      // R-FFA-OPP-ONE: p2's two effect monsters keep the target choice open.
      expectPickOptions([{ card: BUG, seat: "p2" }, { card: WITCH, seat: "p2" }], "p0"),
      select(BUG),
      expectEvents({ kind: "target", by: "p0", text: "targets Man-Eater Bug" }),
      expectPrompt({ by: "p0", title: "Choose an action", context: "action" }),
      expectEliminated("p1"),
      everySeat("ffa3", {
        p0: { lp: 7200, hand: [], monsters: [ELF], grave: ["Ultimate Sky"] },
        p2: { monsters: [BUG, OX, WITCH] },
      }),
    ],
  }),
  // W8 in FFA4: two opponents survive, so the filtered pick stays open and keeps their core option IDs.
  defineScenario({
    id: "compare-gaps-ffa4-surrender-while-the-opponent-pick-is-open",
    title: "FFA4: p1 gives up while p0 picks an opponent for Ultimate Sky: p1's removed option returns seat_left, p0 picks p2, and Sky negates p2's Man-Eater Bug for 800 LP (W8)",
    source: OPP_PICK,
    rules: ["R-COMMON-OPP-PICK", "R-FFA-OPP-ONE", "R-FFA-ELIMINATION", "R-COMMON-SURRENDER-EOT"],
    tags: ["multiplayer", "compare", "elimination", "ffa4", "card:38817295"],
    setup: {
      format: "ffa4",
      p0: { hand: ["Ultimate Sky"], monsters: [ELF] },
      p1: { monsters: [SANGAN, WITCH] },
      p2: { monsters: [BUG, OX, WITCH] },
      // Two Normal Monsters keep p3 eligible for the opponent pick without adding effect targets.
      p3: { monsters: [AXE, GUARDIAN] },
    },
    steps: [
      activate("Ultimate Sky", "p0"),
      expectPickSeats(["p1", "p2", "p3"], "p0"),
      expectPickOptions([{ id: "opt:0", seat: "p1" }, { id: "opt:1", seat: "p2" }, { id: "opt:2", seat: "p3" }], "p0"),
      surrender("p1"),
      expectEliminated("p1"),
      expectPickOptions([{ id: "opt:1", seat: "p2" }, { id: "opt:2", seat: "p3" }], "p0"),
      expectRetry({ choice: "opt:0" }, { error: "That player has left. Pick again.", code: "seat_left", by: "p0" }),
      pickOpponent("p2", "p0"),
      zone("p0", "s0", "p0"),
      expectPickOptions([{ card: BUG, seat: "p2" }, { card: WITCH, seat: "p2" }], "p0"),
      select(BUG),
      expectEvents({ kind: "target", by: "p0", text: "targets Man-Eater Bug" }),
      expectPrompt({ by: "p0", title: "Choose an action", context: "action" }),
      expectEliminated("p1"),
      everySeat("ffa4", {
        p0: { lp: 7200, hand: [], monsters: [ELF], grave: ["Ultimate Sky"] },
        p2: { monsters: [BUG, OX, WITCH] },
        p3: { monsters: [AXE, GUARDIAN] },
      }),
    ],
  }),
  numeronEverySeat("ffa4"),
  numeronEverySeat("tag"),
];
