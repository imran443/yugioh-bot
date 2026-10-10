// GitHub issue 321 on the legacy 1v1 engine: a negated face-up monster carries `negated`, a lone legal target is named in the log.
import { describe, expect, it } from "vitest";
import type { DuelEngineView } from "@yugidraft/shared/duels";
import { createEngineGame, type EngineGame } from "../../src/legacy/engine.js";
import { compileBoard } from "../../src/presets/board.js";
import { engineDataDirectory as DATA } from "../engine-data-dir.js";
import { describeWithCores, needs } from "../support/cores.js";
import { createLegacyEngineGame } from "../../src/legacy/index.js";
import { Session } from "../support/session.js";
import { runScenarios } from "../support/runner.js";
import { TARGET_NAMING_SCENARIOS } from "../scenarios/multiplayer/negation-indicator.js";

const TOY = "Toy Soldier";
const VEILER = "Effect Veiler";
const POT = "Pot of Greed";

function waiting(game: EngineGame): { seat: number; view: DuelEngineView } {
  for (const seat of [0, 1]) {
    const view = game.view(seat);
    if (view.prompt && view.prompt.seat === seat) return { seat, view };
  }
  throw new Error("no prompt");
}

describeWithCores("legacy 1v1 negation indicator", [needs.cards(), needs.scripts()], () => {
  runScenarios("legacy target naming", TARGET_NAMING_SCENARIOS.map((scenario) => ({
    ...scenario, id: scenario.id.replace("ffa4", "legacy"), setup: { ...scenario.setup, format: "1v1" as const, p2: undefined, p3: undefined },
  })), async (scenario) => {
    const compiled = compileBoard(scenario.setup, DATA);
    const game = await createLegacyEngineGame({ ...compiled.options, seed: ["1", "2", "3", "4"], dataDirectory: DATA });
    try {
      const session = new Session(scenario, game);
      session.reachMainPhase();
      session.startRecording();
      scenario.steps.forEach((step, index) => session.run(step, index + 1));
    } finally { game.close(); }
  });
  it("Effect Veiler negates its only legal target: the monster shows negated, the log names it, and only seat 1 gets the note", async () => {
    const compiled = compileBoard({
      p0: { hand: [POT], monsters: [TOY, { card: "Dark Magician", pos: "set" }] },
      p1: { hand: [VEILER] },
    }, DATA);
    const game = await createEngineGame({ ...compiled.options, seed: ["5", "6", "7", "8"], dataDirectory: DATA });
    try {
      for (const seat of [0, 1, null]) {
        const view = game.view(seat);
        expect(view.seats[0]!.monsters[0]!.negated, `before, viewer ${seat}`).toBeUndefined();
      }
      let acted = false;
      let veiled = false;
      for (let step = 0; step < 40 && !veiled; step += 1) {
        const { seat, view } = waiting(game);
        const prompt = view.prompt!;
        let answer: Parameters<EngineGame["answer"]>[2] = prompt.cancelable ? { cancel: true } : { choice: prompt.options.find((o) => o.id === "to_ep" || o.id === "no")?.id ?? prompt.options[0]!.id };
        if (seat === 0 && !acted) {
          const pot = prompt.options.find((option) => option.id.startsWith("activate:") && option.card?.name === POT);
          if (pot) { acted = true; answer = { choice: pot.id }; }
        } else if (seat === 1 && prompt.context?.type === "chain") {
          const veiler = prompt.options.find((option) => option.card?.name === VEILER);
          if (veiler) { veiled = true; answer = { choice: veiler.id }; }
        }
        game.answer(seat, prompt.id, answer);
      }
      expect(veiled).toBe(true);
      // The chain resolves; Veiler's only legal target (the face-up Toy Soldier) is negated. The Set monster never carries the mark.
      for (let guard = 0; guard < 10; guard += 1) {
        const open = waiting(game);
        if (open.view.chain.length === 0) break;
        game.answer(open.seat, open.view.prompt!.id, open.view.prompt!.cancelable ? { cancel: true } : { choice: open.view.prompt!.options[0]!.id });
      }
      const owner = game.view(0);
      expect(owner.seats[0]!.monsters[0]).toMatchObject({ name: TOY, negated: true });
      expect(owner.seats[0]!.monsters[1]!.negated).toBeUndefined();
      expect(game.view(1).seats[0]!.monsters[0]!.negated).toBe(true);
      expect(game.view(null).seats[0]!.monsters[0]!.negated).toBe(true);
      // Hidden-information safety: the Set monster is hidden from the opponent and the spectator, and shows no status.
      for (const viewer of [1, null] as const) {
        const hidden = game.view(viewer).seats[0]!.monsters[1]!;
        expect(hidden.code).toBeUndefined();
        expect(hidden.negated).toBeUndefined();
      }
      expect(game.view(1).log.map((line) => line.text)).toEqual(expect.arrayContaining([
        `Chain Link 2: ${VEILER} targets ${TOY}`,
        `Only legal target: ${TOY}`,
      ]));
      for (const viewer of [0, null] as const) {
        const text = game.view(viewer).log.map((line) => line.text);
        expect(text).toContain(`Chain Link 2: ${VEILER} targets ${TOY}`);
        expect(text.some((line) => line.startsWith("Only legal target"))).toBe(false);
      }
    } finally { game.close(); }
  });
});
