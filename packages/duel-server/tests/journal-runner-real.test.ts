import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { defaultDuelSettings, seatCountFor, type DuelEngineChoice, type DuelFormat, type DuelMode, type ReplaySource } from "@yugidraft/shared/duels";
import { createEngineGame, type EngineGame } from "../src/engine.js";
import { createLegacyEngineGame } from "../src/legacy/index.js";
import { runJournalPrefix, type JournalTargetViews } from "../src/journal-runner.js";
import { multiScriptsFolderHash, pinnedEngineVersion, repoMultiScriptsDirectory } from "../src/multi-scripts.js";
import { buildPracticeBotDeck, chooseSurrenderedAnswer } from "../src/practice-bot.js";
import { GameWorker } from "../src/worker-client.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";
import { describeWithCores, needs } from "./support/cores.js";

const cases: Array<{ mode: DuelMode; format: DuelFormat; engine?: DuelEngineChoice }> =
  (["normal", "domain"] as const).flatMap(mode => [
    { mode, format: "1v1", engine: "legacy" }, { mode, format: "1v1", engine: "pinned" },
    { mode, format: "tag" }, { mode, format: "ffa3" }, { mode, format: "ffa4" },
  ]);

function snapshot(game: EngineGame, count: number): JournalTargetViews {
  return structuredClone({ public: game.view(null), seats: Array.from({ length: count }, (_, seat) => game.view(seat)) });
}

describeWithCores("real journal prefix workers", [needs.cards(DATA), needs.scripts(DATA), needs.standard(DATA), needs.domain(DATA),
  needs.installedMulti(DATA), needs.file("Domain multi core", join(DATA, "ocgcore.multi-domain.wasm")),
  needs.file("legacy Domain core", join(DATA, "ocgcore.domain.legacy.wasm")),
  needs.file("legacy Domain script", join(DATA, "card-scripts/domain.legacy.lua"))], () => {
  it.each(cases)("reproduces $mode $format $engine checkpoints and continues after handoff", async ({ mode, format, engine }) => {
    const count = seatCountFor(format);
    const bundleVersion = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")).bundleVersion as string;
    const multiScriptsDirectory = count > 2 ? repoMultiScriptsDirectory() : undefined;
    const resources = { dataDirectory: DATA, bundleVersion, multiScriptsDirectory };
    const base = buildPracticeBotDeck(mode, DATA);
    const source: ReplaySource = {
      session: { id: 1, slug: "real-prefix-source", kind: "play", name: "Prefix source", guildId: "test-guild", organizerPlayerId: 1,
        mode, format, masterRule: 5, status: "completed", settings: { ...defaultDuelSettings(mode), validateDeck: false },
        seats: Array.from({ length: count }, (_, seat) => ({ seat, playerId: seat + 1, displayName: `Seat ${seat}`, ready: true, isBot: false })),
        createdAt: "2026-10-10T00:00:00Z", endedAt: null, archivedAt: null, winnerPlayerId: null, winnerSeat: null, resultReason: null },
      decks: Array.from({ length: count }, (_, seat) => ({ ...base, main: [...base.main.slice(seat), ...base.main.slice(0, seat)] })),
      seed: ["123", "456", "789", "1011"],
      bundleVersion: pinnedEngineVersion(bundleVersion, count, multiScriptsDirectory ? multiScriptsFolderHash(multiScriptsDirectory) : null),
      engineIdentity: null, setup: { engine, firstTurnDraw: mode === "domain" && count > 2, scriptErrorMode: "strict" }, commands: [],
    };
    const created = { ...resources, mode, format, decks: source.decks, seed: source.seed, settings: source.session.settings,
      masterRule: source.session.masterRule, firstTurnDraw: source.setup!.firstTurnDraw, scriptErrorMode: "strict" as const };
    const direct = await (engine === "legacy" ? createLegacyEngineGame : createEngineGame)(created);
    try {
      const history = [snapshot(direct, count)];
      // Both entries have the same revision. They count even though no visible frame changes.
      for (const mode of ["off", "auto"] as const) {
        source.commands.push({ storedSeq: 3 * (source.commands.length + 1), seat: 1,
          command: { revision: direct.view(1).revision, promptId: `chain-mode:${mode}`, answer: {} } });
        expect(direct.setChainMode(1, mode)).toBe(false); history.push(snapshot(direct, count));
      }
      for (let step = 0; step < 6; step++) {
        const view = Array.from({ length: count }, (_, seat) => direct.view(seat)).find(view => view.prompt);
        expect(view?.prompt).toBeTruthy();
        const prompt = view!.prompt!; const answer = chooseSurrenderedAnswer(prompt);
        source.commands.push({ storedSeq: 3 * (source.commands.length + 1), seat: prompt.seat,
          command: { revision: view!.revision, promptId: prompt.id, answer } });
        direct.answer(prompt.seat, prompt.id, answer); history.push(snapshot(direct, count));
      }
      if (count > 2) {
        source.commands.push({ storedSeq: 3 * (source.commands.length + 1), seat: 1,
          command: { revision: direct.view(1).revision, promptId: "eliminate:3", answer: {} } });
        direct.eliminate(1, 3); history.push(snapshot(direct, count));
      }
      const original = structuredClone(source);
      vi.stubEnv("DUEL_1V1_ENGINE", engine === "legacy" ? "pinned" : "legacy");
      try {
        for (const prefixCount of [0, 2, 5, source.commands.length]) {
          const worker = new GameWorker();
          try {
            const result = await runJournalPrefix({ source, resources, prefixCount, createWorker: () => worker,
              target: { revision: history[prefixCount]!.public.revision } });
            expect(result.views).toEqual(history[prefixCount]); expect(worker.running).toBe(true);
            const expectedFile = count > 2 ? mode === "domain" ? "ocgcore.multi-domain.wasm" : "ocgcore.multi.wasm"
              : engine === "legacy" ? mode === "domain" ? "ocgcore.domain.legacy.wasm" : "ocgcore-wasm npm package core (built in)"
              : mode === "domain" ? "ocgcore.domain.wasm" : "ocgcore.standard.wasm";
            expect(worker.debugState().wasmFile).toBe(expectedFile);
            if (prefixCount === 5) {
              const next = source.commands[prefixCount]!;
              await worker.answer(next.seat, next.command.promptId, next.command.answer);
              expect(await worker.view(null)).toEqual(history[prefixCount + 1]!.public);
            }
          } finally { await worker.close(); }
        }
      } finally { vi.unstubAllEnvs(); }
      expect(source).toEqual(original);
    } finally { direct.close(); }
  }, 60_000);
});
