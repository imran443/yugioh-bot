// Negated monsters and chain targets in FFA4 (GitHub issue 321). Plain data, also read by scripts/rule-coverage.ts.
// Seat 0 controls Black Luster Soldier (unaffected by activated effects that do not target it), Magicians' Souls and Toy Soldier.
// Seat 1 chains Destined Rivals to the first Pot of Greed (Souls and Toy Soldier are negated, Black Luster Soldier is not), then
// Effect Veiler to the second one. Veiler skips monsters that are already negated, so Black Luster Soldier is its only legal target
// and the engine picks it without asking seat 1.
import { activate, expectBoard, expectEvents, expectLogSeen, pass, defineScenario, type Scenario } from "../../support/dsl.js";

const BLS = "Black Luster Soldier - Soldier of Light and Darkness";
const SOULS = "Magicians' Souls";
const TOY = "Toy Soldier";
const POT = "Pot of Greed";
const RIVALS = "Destined Rivals";
const VEILER = "Effect Veiler";
const BLUE_EYES = "Blue-Eyes White Dragon";

export const NEGATION_INDICATOR_SCENARIOS: Scenario[] = [
  defineScenario({
    id: "negation-indicator-ffa4-rivals-then-veiler-single-target",
    title: "FFA4: Destined Rivals negates Magicians' Souls and Toy Soldier but not Black Luster Soldier; Effect Veiler then has Black Luster Soldier as its only legal target, the engine picks it for seat 1, and the log names it",
    source: "GitHub issue 321: the table showed no negated mark and no cue where the auto-picked Veiler landed",
    rules: ["R-FFA-NEGATE"],
    tags: ["multiplayer", "negation", "chain-target", "ffa4", `card:${22634473}`, `card:${97268402}`],
    setup: {
      format: "ffa4",
      attackFirstTurn: true,
      p0: { hand: [POT, POT], monsters: [BLS, SOULS, TOY] },
      p1: { hand: [VEILER], monsters: [BLUE_EYES], spells: [{ card: RIVALS, pos: "set" }] },
      p2: {},
      p3: {},
    },
    steps: [
      expectBoard({ p0: { zones: { m0: { card: BLS, negated: false, attack: 3000 }, m1: { card: SOULS, negated: false }, m2: { card: TOY, negated: false } } } }),
      activate(POT, "p0"),
      activate(RIVALS, "p1"),
      pass("p1"), pass("p1"),
      expectBoard({
        p0: { zones: { m0: { card: BLS, negated: false, attack: 3000 }, m1: { card: SOULS, negated: true }, m2: { card: TOY, negated: true } } },
        p1: { zones: { m0: { card: BLUE_EYES, negated: false } } },
      }),
      activate(POT, "p0"),
      activate(VEILER, "p1"),
      expectLogSeen("p1", { has: ["Chain Link 2: Effect Veiler targets " + BLS, "Only legal target: " + BLS] }),
      expectBoard({
        p0: { zones: { m0: { card: BLS, negated: true, attack: 3000 }, m1: { card: SOULS, negated: true }, m2: { card: TOY, negated: true } } },
      }),
      expectLogSeen("p0", { has: ["Chain Link 2: Effect Veiler targets " + BLS], lacks: ["Only legal target"] }),
      expectLogSeen("p2", { has: ["Chain Link 2: Effect Veiler targets " + BLS], lacks: ["Only legal target"] }),
      expectLogSeen("spectator", { has: ["Chain Link 2: Effect Veiler targets " + BLS], lacks: ["Only legal target"] }),
    ],
  }),
  defineScenario({
    id: "negation-indicator-ffa4-skill-drain-continuous",
    title: "FFA4: a continuous negation (face-up Skill Drain) shows as negated on every field, the owner's and the opponent's",
    source: "GitHub issue 321: the negated mark follows the core's status bit, so continuous negation counts too",
    rules: ["R-FFA-NEGATE"],
    tags: ["multiplayer", "negation", "ffa4"],
    setup: {
      format: "ffa4",
      attackFirstTurn: true,
      p0: { hand: [POT], monsters: [TOY], spells: [{ card: "Skill Drain", pos: "up" }] },
      p1: { monsters: [SOULS] },
      p2: {},
      p3: {},
    },
    steps: [
      activate(POT, "p0"),
      expectBoard({ p0: { zones: { m0: { card: TOY, negated: true } } }, p1: { zones: { m0: { card: SOULS, negated: true } } } }),
    ],
  }),
];
