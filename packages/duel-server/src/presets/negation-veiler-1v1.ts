import { chainWith } from "../scripted-bot.js";
import { onChain, type Preset } from "./types.js";

const VEILER = "Effect Veiler";

/**
 * 1v1. The human controls Toy Soldier face-up and activates Pot of Greed. The bot chains Effect Veiler, whose only legal
 * target is Toy Soldier, so the engine picks it without asking. The field must show Toy Soldier as negated afterwards
 * and the log must name the target.
 */
export const preset: Preset = {
  id: "negation-veiler-1v1",
  title: "Negated monster and a single legal Veiler target (1v1)",
  format: "1v1",
  humanSeat: 0,
  rules: ["R-COMMON-CONT-NEG"],
  board: {
    p0: { hand: ["Pot of Greed"], monsters: ["Toy Soldier"] },
    p1: { hand: [VEILER], monsters: ["Blue-Eyes White Dragon"] },
  },
  bots: {
    1: [chainWith(VEILER, { if: onChain, note: "chain Effect Veiler to the Pot of Greed" })],
  },
  checklist: [
    "You start in Main Phase 1 with Pot of Greed in your hand and Toy Soldier face-up on your field.",
    "Activate Pot of Greed. The bot chains Effect Veiler.",
    "Toy Soldier is the only legal target, so the engine picks it for the bot. The log reads \"Effect Veiler targets Toy Soldier\".",
    "Toy Soldier shows the negated mark and the inspector says \"Effects negated\".",
  ],
};
