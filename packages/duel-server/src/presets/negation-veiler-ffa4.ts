import { chainWith } from "../scripted-bot.js";
import { onChain, type Preset } from "./types.js";

const RIVALS = "Destined Rivals";
const VEILER = "Effect Veiler";

/** Seat 1 has used Destined Rivals this turn: it is in its Graveyard. */
const rivalsUsed = (_prompt: unknown, view: { seats: Array<{ graveyard: Array<{ name?: string }> }> }): boolean =>
  view.seats[1]?.graveyard.some((card) => card.name === RIVALS) ?? false;

/**
 * FFA4. The human controls three face-up monsters: Black Luster Soldier (unaffected by activated effects that do not
 * target it), Magicians' Souls and Toy Soldier. Seat 1 answers the first Pot of Greed with Destined Rivals, which negates
 * Magicians' Souls and Toy Soldier but not Black Luster Soldier. After that, the second Pot of Greed is answered with
 * Effect Veiler. Black Luster Soldier is the only face-up Effect Monster left that is not negated, so the engine picks
 * the target for the bot without asking (the single legal target).
 * The table must show which monsters are negated, and name Black Luster Soldier as the target of Effect Veiler.
 */
export const preset: Preset = {
  id: "negation-veiler-ffa4",
  title: "Negated monsters and a single legal Veiler target (4 seats)",
  format: "ffa4",
  humanSeat: 0,
  needs: "multi-core",
  rules: ["R-FFA-NEGATE"],
  board: {
    format: "ffa4",
    p0: {
      hand: ["Pot of Greed", "Pot of Greed"],
      monsters: ["Black Luster Soldier - Soldier of Light and Darkness", "Magicians' Souls", "Toy Soldier"],
    },
    p1: {
      hand: [VEILER],
      monsters: ["Blue-Eyes White Dragon"],
      spells: [{ card: RIVALS, pos: "set" }],
    },
    p2: {},
    p3: {},
  },
  bots: {
    1: [
      chainWith(VEILER, { if: (prompt, view) => onChain(prompt, view) && rivalsUsed(prompt, view), note: "seat 1 chains Effect Veiler after Destined Rivals resolved" }),
      chainWith(RIVALS, { if: (prompt, view) => onChain(prompt, view) && !rivalsUsed(prompt, view), note: "seat 1 chains Destined Rivals" }),
    ],
    2: [],
    3: [],
  },
  checklist: [
    "You start in Main Phase 1 with two Pot of Greed. You control Black Luster Soldier, Magicians' Souls and Toy Soldier, all face-up.",
    "Activate the first Pot of Greed. Seat 1 chains Destined Rivals.",
    "Magicians' Souls and Toy Soldier show the negated mark. Black Luster Soldier does not: it is unaffected.",
    "Activate the second Pot of Greed. Seat 1 chains Effect Veiler. The only legal target is Black Luster Soldier.",
    "The log reads \"Effect Veiler targets Black Luster Soldier ...\" and the monster shows the target marker, then the negated mark.",
  ],
};
