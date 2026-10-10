import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuelEngineView, DuelPrompt } from "@yugidraft/shared/duels";
import { seatCountFor } from "@yugidraft/shared/duels";
import { createEngineGame, type EngineGame } from "../src/engine.js";
import { compileBoard } from "../src/presets/board.js";
import { getPreset, multiCoreAvailable, PRESETS, summarizePreset, type Preset } from "../src/presets/index.js";
import { activate, chooseScripted, pass, type Rule } from "../src/scripted-bot.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";
import { itWithCores, needs } from "./support/cores.js";
import { nseatWasmBinary, probeSetupDuelists } from "./support/session.js";

const seed = ["11", "22", "33", "44"];

interface Played {
  game: EngineGame;
  journal: Array<{ seat: number; note: string; choice: string }>;
  view(seat: number): DuelEngineView;
  /** Answers seen in prompts of a seat, to check what was offered. */
  offered: Map<number, string[][]>;
}

/** Play a preset: seat 0 follows `human` (then passes), every other seat follows the preset bot rules. */
async function play(preset: Preset, human: Rule[], options: { maxSteps?: number; stopWhen?: (view: DuelEngineView, steps: number) => boolean } = {}): Promise<Played> {
  const compiled = compileBoard(preset.board, DATA);
  const multiWasmBinary = seatCountFor(preset.format) > 2 ? nseatWasmBinary() : undefined;
  const game = await createEngineGame({
    ...compiled.options,
    seed,
    dataDirectory: DATA,
    format: preset.format,
    ...(multiWasmBinary ? { multiWasmBinary } : {}),
  } as Parameters<typeof createEngineGame>[0]);
  const seats = seatCountFor(preset.format);
  const journal: Played["journal"] = [];
  const offered = new Map<number, string[][]>();
  let humanActed = 0;
  for (let step = 0; step < (options.maxSteps ?? 80); step += 1) {
    let acted = false;
    for (let seat = 0; seat < seats; seat += 1) {
      const view = game.view(seat);
      if (view.result) return { game, journal, view: (s) => game.view(s), offered };
      const prompt: DuelPrompt | null = view.prompt;
      if (!prompt || prompt.seat !== seat) continue;
      const list = offered.get(seat) ?? [];
      list.push(prompt.options.map((option) => option.id));
      offered.set(seat, list);
      if (seat === 0 && options.stopWhen?.(view, step)) return { game, journal, view: (s) => game.view(s), offered };
      const rules = seat === 0 ? human : preset.bots[seat] ?? [];
      const chosen = chooseScripted(rules, prompt, view, { seat });
      if (seat === 0 && chosen.rule >= 0) humanActed += 1;
      game.answer(seat, prompt.id, chosen.answer);
      journal.push({ seat, note: chosen.note, choice: JSON.stringify(chosen.answer) });
      acted = true;
      break;
    }
    if (!acted) break;
  }
  void humanActed;
  return { game, journal, view: (s) => game.view(s), offered };
}

const names = (view: DuelEngineView, seat: number, zone: "graveyard" | "monsters" | "spells") =>
  (view.seats![seat]![zone] as Array<{ name?: string } | null>).filter(Boolean).map((card) => card!.name);

describe("preset registry", () => {
  it("has unique ids and one rules array and checklist per preset", () => {
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(PRESETS.length);
    for (const preset of PRESETS) {
      expect(preset.checklist.length, preset.id).toBeGreaterThan(2);
      expect(preset.rules.length, preset.id).toBeGreaterThan(0);
      expect(preset.rules.every((rule) => /^R-[A-Z]+(-[A-Z]+)+$/.test(rule)), preset.id).toBe(true);
      expect(Object.keys(preset.bots).map(Number).sort(), preset.id).toEqual(
        Array.from({ length: seatCountFor(preset.format) - 1 }, (_, index) => index + 1),
      );
    }
    expect(PRESETS.filter((preset) => !preset.needs).map((preset) => preset.id)).toEqual([
      "dust-tornado-chain",
      "solemn-judgment-summon",
      "jinzo-stops-trap",
      "negation-veiler-1v1",
    ]);
    expect(PRESETS.filter((preset) => preset.needs === "multi-core").map((preset) => preset.id).sort()).toEqual([
      "ffa3-elimination-chain-control",
      "ffa3-elimination-chain-loss",
      "ffa3-elimination-cut-turn",
      "ffa3-elimination-deck-out",
      "ffa3-elimination-exchanged-hand",
      "ffa3-elimination-last-two-draw",
      "ffa3-elimination-ongoing-control",
      "ffa3-elimination-ongoing-loss",
      "ffa3-elimination-owned-elsewhere",
      "ffa3-elimination-pending-chain",
      "ffa3-elimination-pending-chain-control",
      "ffa3-elimination-return-owned",
      "ffa3-mind-crush-pick",
      "ffa3-rules-activated-lock",
      "ffa3-rules-direct-response",
      "ffa3-rules-extra-zones",
      "ffa3-rules-negate",
      "ffa3-rules-opponent-field",
      "ffa3-rules-opponent-lp",
      "ffa3-rules-resource-rotation",
      "ffa3-rules-triggers",
      "ffa3-rules-triggers-rotated",
      "ffa3-table-battle",
      "ffa3-table-chain",
      "ffa3-table-direct",
      "ffa3-third-response",
      "ffa3-turn-player-last",
      "ffa4-chain-order-heavy-storm",
      "ffa4-rules-across-extra-zones",
      "ffa4-surrender-in-chain",
      "mind-crush-ffa4-pick",
      "negation-veiler-ffa4",
      "raigeki-dark-hole-ffa4",
      "raigeki-dark-hole-tag",
      "tag-jinzo-blocks-traps",
      "tag-lp-solemn-partner",
    ]);
    expect(getPreset("nope")).toBeUndefined();
  });

  it("marks multi-core presets unavailable when the data directory has no multi wasm", () => {
    const summary = summarizePreset(getPreset("mind-crush-ffa4-pick")!, DATA);
    expect(summary.needsMultiCore).toBe(true);
    expect(summary.available).toBe(existsSync(join(DATA, "ocgcore.multi.wasm")));
    expect(multiCoreAvailable(DATA)).toBe(summary.available);
    expect(summarizePreset(getPreset("dust-tornado-chain")!, DATA).available).toBe(true);
  });
});

describe("every preset board compiles", () => {
  for (const preset of PRESETS) {
    it(preset.id, () => {
      const compiled = compileBoard(preset.board, DATA);
      expect(compiled.options.decks).toHaveLength(seatCountFor(preset.format));
      expect(compiled.options.startupScripts?.length).toBeGreaterThan(0);
    });
  }
});

describe("1v1 presets run to the end of their checklist", () => {
  it("dust-tornado-chain", async () => {
    const preset = getPreset("dust-tornado-chain")!;
    const human: Rule[] = [
      activate("Mystical Space Typhoon"),
      {
        note: "target the face-down card of the bot",
        when: (prompt) => prompt.kind === "cards" && prompt.options.some((option) => option.controller === 1),
        do: (prompt) => ({ selected: [prompt.options.find((option) => option.controller === 1)!.id] }),
      },
      pass(),
    ];
    const run = await play(preset, human, { maxSteps: 40, stopWhen: (view) => view.turn >= 2 });
    const view = run.view(0);
    expect(run.journal.some((entry) => entry.seat === 1 && entry.note.includes("Dust Tornado"))).toBe(true);
    expect(names(view, 0, "graveyard")).toEqual(expect.arrayContaining(["Mystical Space Typhoon", "Swords of Revealing Light"]));
    expect(names(view, 1, "graveyard")).toContain("Dust Tornado");
    run.game.close();
  });

  it("solemn-judgment-summon", async () => {
    const preset = getPreset("solemn-judgment-summon")!;
    const human: Rule[] = [
      { note: "normal summon Celtic Guardian", when: (p) => p.options.some((o) => o.id.startsWith("summon:")), do: (p) => ({ choice: p.options.find((o) => o.id.startsWith("summon:"))!.id }) },
      pass(),
    ];
    const run = await play(preset, human, { maxSteps: 40, stopWhen: (view) => view.turn >= 2 });
    const view = run.view(0);
    expect(view.seats![1]!.lp).toBe(4000);
    expect(names(view, 0, "graveyard")).toContain("Celtic Guardian");
    expect(names(view, 0, "monsters")).not.toContain("Celtic Guardian");
    expect(names(view, 1, "graveyard")).toContain("Solemn Judgment");
    run.game.close();
  });

  it("jinzo-stops-trap", async () => {
    const preset = getPreset("jinzo-stops-trap")!;
    const run = await play(preset, [pass()], { maxSteps: 40, stopWhen: (view) => view.turn >= 3 });
    const view = run.view(0);
    expect(view.seats![0]!.lp).toBe(5600);
    expect(names(view, 0, "spells")).toContain("Mirror Force");
    // The human never had a chain prompt with a card to activate.
    expect((run.offered.get(0) ?? []).some((ids) => ids.some((id) => id.startsWith("card:")))).toBe(false);
    run.game.close();
  });
});

describe("multi-core presets", async () => {
  const available = await probeSetupDuelists();
  for (const preset of PRESETS.filter((item) => item.needs === "multi-core")) {
    itWithCores(`${preset.id} starts and the human has the first prompt`, needs.setupDuelists(available), async () => {
      const run = await play(preset, [pass()], { maxSteps: 20, stopWhen: () => true });
      expect(run.view(0).prompt?.seat).toBe(0);
      run.game.close();
    });
  }
});
