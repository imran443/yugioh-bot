import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { duel1v1EngineForMode } from "@yugidraft/shared/duels";
import { buildPracticeBotDeck } from "../src/practice-bot.js";
import { GameWorker } from "../src/worker-client.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";
import { describeWithCores, needs } from "./support/cores.js";

describeWithCores("Standard-only switch on a real 1v1 worker", [needs.cards(DATA), needs.scripts(DATA), needs.standard(DATA),
  needs.file("legacy Domain core", join(DATA, "ocgcore.domain.legacy.wasm")),
  needs.file("legacy Domain Lua", join(DATA, "card-scripts/domain.legacy.lua"))], () => {
  it.each(["normal", "domain"] as const)("loads the expected %s binary", async (mode) => {
    const engine = duel1v1EngineForMode(mode, { DUEL_1V1_ENGINE: "legacy", DUEL_STANDARD_1V1_ENGINE: "pinned" });
    const errors: string[] = [];
    const worker = new GameWorker(error => errors.push(error.message), error => errors.push(error.message));
    try {
      const deck = buildPracticeBotDeck(mode, DATA);
      await worker.create({ mode, engine, decks: [deck, deck], dataDirectory: DATA, seed: ["1", "2", "3", "4"],
        scriptErrorMode: "strict", firstTurnDraw: false });
      const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8"));
      expect(worker.debugState()).toMatchObject(mode === "normal"
        ? { wasmFile: "ocgcore.standard.wasm", wasmSha: manifest.integrity.standardWasm }
        : { wasmFile: "ocgcore.domain.legacy.wasm", wasmSha: manifest.integrity.domainLegacyWasm });
      expect((await worker.view(0)).seats[0]!.hand).toHaveLength(5);
      expect(errors).toEqual([]);
    } finally { await worker.close(); }
  });
});
