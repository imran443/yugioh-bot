// Negated monsters and chain targets in FFA4 (GitHub issue 321). Plain data, also read by scripts/rule-coverage.ts.
// Seat 0 controls Black Luster Soldier (unaffected by activated effects that do not target it), Magicians' Souls and Toy Soldier.
// Seat 1 chains Destined Rivals to the first Pot of Greed (Souls and Toy Soldier are negated, Black Luster Soldier is not), then
// Effect Veiler to the second one. Veiler skips monsters that are already negated, so Black Luster Soldier is its only legal target
// and the engine picks it without asking seat 1.
import { activate, expectBoard, expectEvents, expectLogSeen, pass, select, zone, position, defineScenario, type Scenario } from "../../support/dsl.js";

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

// These fixtures also run on the legacy engine with a two-seat setup.
export const TARGET_NAMING_SCENARIOS: Scenario[] = [
  defineScenario({
    id: "target-naming-ffa4-salvage-snapshot",
    title: "Salvage keeps its original two names after returning the targets and shuffling the hand",
    source: "PR #328: deferred naming must use the announcement's targets",
    tags: ["multiplayer", "chain-target", "ffa4"],
    setup: { format: "ffa4", p0: { hand: ["Salvage"], grave: ["Deep Sea Diva", "Swap Frog"] }, p1: {}, p2: {}, p3: {} },
    steps: [
      activate("Salvage", "p0"),
      expectBoard({ p0: { hand: { include: ["Deep Sea Diva", "Swap Frog"] }, grave: ["Salvage"] } }),
      expectEvents({ kind: "target", text: "targets Deep Sea Diva and Swap Frog" }),
      expectLogSeen("spectator", { has: ["Salvage targets Deep Sea Diva and Swap Frog"], lacks: ["Salvage targets 0 cards", "Salvage targets 1 card", "Salvage targets 2 cards"] }),
    ],
  }),
  defineScenario({
    id: "target-naming-ffa4-reborn-movement",
    title: "Monster Reborn follows the target to the field without announcing another targeting",
    source: "PR #328: ordinary movement is a board-marker update",
    tags: ["multiplayer", "chain-target", "ffa4"],
    setup: { format: "ffa4", p0: { hand: ["Monster Reborn"], grave: ["Dark Magician"] }, p1: {}, p2: {}, p3: {} },
    steps: [
      activate("Monster Reborn", "p0"), zone("p0", "s0"), zone("p0", "m0"), position("atk"),
      expectBoard({ p0: { zones: { m0: "Dark Magician" }, grave: ["Monster Reborn"] } }),
      expectLogSeen("p0", { has: ["Monster Reborn targets Dark Magician", "Only legal target: Dark Magician"], lacks: ["Monster Reborn targets 1 card", "Only legal target: 1 card"] }),
      expectLogSeen("spectator", { has: ["Monster Reborn targets Dark Magician"], lacks: ["Monster Reborn targets 1 card", "Only legal target"] }),
    ],
  }),
  defineScenario({
    id: "target-naming-ffa4-shift-retarget",
    title: "Shift names Book of Moon's replacement target on the original chain link",
    source: "PR #328: ChangeTargetCard needs its own target-card notes",
    tags: ["multiplayer", "chain-target", "ffa4"],
    setup: { format: "ffa4", p0: { hand: ["Book of Moon"] }, p1: { monsters: ["Dark Magician", BLUE_EYES], spells: [{ card: "Shift", pos: "set" }] }, p2: {}, p3: {} },
    steps: [
      activate("Book of Moon", "p0"), select("Dark Magician"), activate("Shift", "p1"),
      expectBoard({ p1: { zones: { m0: { card: "Dark Magician", pos: "faceup" }, m1: { card: BLUE_EYES, pos: "facedown" } } } }),
      expectEvents({ kind: "target", text: "Chain Link 1 targets Dark Magician" }, { kind: "target", text: "Chain Link 1 targets " + BLUE_EYES }),
      expectLogSeen("spectator", { has: ["Book of Moon targets Dark Magician", "Book of Moon targets " + BLUE_EYES], lacks: ["Book of Moon targets 1 card"] }),
    ],
  }),
  defineScenario({
    id: "target-naming-ffa4-scrap-prompt",
    title: "Scrap Dragon's automatic self-target finishes naming after the opposing-target prompt is answered",
    source: "PR #328: unfinished announcements survive a human answer",
    tags: ["multiplayer", "chain-target", "ffa4"],
    setup: { format: "ffa4", p0: { monsters: ["Scrap Dragon"] }, p1: { monsters: ["Dark Magician", BLUE_EYES] }, p2: {}, p3: {} },
    steps: [
      activate("Scrap Dragon", "p0"), select("Dark Magician"),
      expectBoard({ p0: { grave: ["Scrap Dragon"] }, p1: { grave: ["Dark Magician"], zones: { m1: BLUE_EYES } } }),
      expectEvents({ kind: "target", text: "Chain Link 1 targets Scrap Dragon" }),
      expectLogSeen("p0", { has: ["Only legal target: Scrap Dragon", "Scrap Dragon targets Scrap Dragon"], lacks: ["Only legal target: 1 card", "Only legal target: Scrap Dragon and", "Scrap Dragon targets 1 card"] }),
      expectLogSeen("spectator", { has: ["Scrap Dragon targets Scrap Dragon"], lacks: ["Only legal target", "Scrap Dragon targets 1 card"] }),
    ],
  }),
];
NEGATION_INDICATOR_SCENARIOS.push(...TARGET_NAMING_SCENARIOS);
