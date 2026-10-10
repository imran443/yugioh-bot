import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultDuelSettings, seatCountFor, toOrdinaryReplayView,
  type DuelEngineChoice, type DuelEngineView, type DuelFormat, type DuelMode, type ReplaySource } from "@yugidraft/shared/duels";
import { createEngineGame } from "../src/engine.js";
import { createLegacyEngineGame } from "../src/legacy/index.js";
import { buildReplayFrames } from "../src/replay-builder.js";
import { createReplayCursorCodec, replaySourceVersion, resolveReplayCursor } from "../src/replay-cursor.js";
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

describeWithCores("real replay frame projections", [needs.cards(DATA), needs.scripts(DATA), needs.standard(DATA), needs.domain(DATA),
  needs.installedMulti(DATA), needs.file("Domain multi core", join(DATA, "ocgcore.multi-domain.wasm")),
  needs.file("legacy Domain core", join(DATA, "ocgcore.domain.legacy.wasm")),
  needs.file("legacy Domain script", join(DATA, "card-scripts/domain.legacy.lua"))], () => {
  it.each(cases)("builds $mode $format $engine with exact cursors and each seat's own deltas", async ({ mode, format, engine }) => {
    const count = seatCountFor(format);
    const bundleVersion = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")).bundleVersion as string;
    const multiScriptsDirectory = count > 2 ? repoMultiScriptsDirectory() : undefined;
    const resources = { dataDirectory: DATA, bundleVersion, multiScriptsDirectory };
    const deck = buildPracticeBotDeck(mode, DATA);
    const source: ReplaySource = {
      session: { id: 1, slug: "real-replay-source", kind: "play", name: "Replay source", guildId: "test-guild", organizerPlayerId: 1,
        mode, format, masterRule: 5, status: "interrupted", settings: { ...defaultDuelSettings(mode), validateDeck: false },
        seats: Array.from({ length: count }, (_, seat) => ({ seat, playerId: seat + 1, displayName: `Seat ${seat}`, ready: true, isBot: false })),
        createdAt: "2026-10-10T00:00:00Z", endedAt: null, archivedAt: null, winnerPlayerId: null, winnerSeat: null, resultReason: "Fixture interruption" },
      decks: Array.from({ length: count }, () => structuredClone(deck)), seed: ["123", "456", "789", "1011"],
      bundleVersion: pinnedEngineVersion(bundleVersion, count, multiScriptsDirectory ? multiScriptsFolderHash(multiScriptsDirectory) : null),
      engineIdentity: null, setup: { engine, firstTurnDraw: mode === "domain" && count > 2, scriptErrorMode: "strict" }, commands: [],
    };
    const direct = await (engine === "legacy" ? createLegacyEngineGame : createEngineGame)({ ...resources, mode, format,
      decks: source.decks, seed: source.seed, settings: source.session.settings, masterRule: 5,
      firstTurnDraw: source.setup!.firstTurnDraw, scriptErrorMode: "strict" });
    try {
      const history: DuelEngineView[][] = [];
      const prefixes = [0];
      const capture = () => history.push(structuredClone([direct.view(null), ...Array.from({ length: count }, (_, seat) => direct.view(seat))]));
      capture();
      for (let step = 0; step < 4; step++) {
        if (step === 2) {
          source.commands.push({ storedSeq: 3 * (source.commands.length + 1), seat: 1,
            command: { revision: direct.view(1).revision, promptId: "chain-mode:off", answer: {} } });
          expect(direct.setChainMode(1, "off")).toBe(false);
        }
        const view = Array.from({ length: count }, (_, seat) => direct.view(seat)).find(v => v.prompt)!;
        const prompt = view.prompt!; const answer = chooseSurrenderedAnswer(prompt);
        source.commands.push({ storedSeq: 3 * (source.commands.length + 1), seat: prompt.seat,
          command: { revision: view.revision, promptId: prompt.id, answer } });
        direct.answer(prompt.seat, prompt.id, answer); capture(); prefixes.push(source.commands.length);
      }
      const before = structuredClone(source);
      const codec = createReplayCursorCodec("real-replay-cursor-secret"); const sourceVersion = replaySourceVersion(source);
      let frameIds: string[] | undefined;
      for (const dataSeat of [null, ...source.session.seats.map(seat => seat.seat)]) {
        const workers: GameWorker[] = [];
        const frames = await buildReplayFrames({ source, sourceVersion, resources, codec, dataSeat, finalView: null,
          createWorker: () => { const worker = new GameWorker(); workers.push(worker); return worker; } });
        expect(workers.every(worker => !worker.running)).toBe(true);
        expect(frames).toHaveLength(history.length + 1);
        const ids = frames.map(frame => frame.frameId); if (frameIds) expect(ids).toEqual(frameIds); else frameIds = ids;
        let lastLog = 0; let lastEvent = 0;
        history.forEach((perspectives, step) => {
          const view = perspectives[dataSeat === null ? 0 : dataSeat + 1]!;
          const log = view.log.filter(entry => entry.id > lastLog); const events = view.events.filter(entry => entry.id > lastEvent);
          for (const entry of log) lastLog = Math.max(lastLog, entry.id); for (const entry of events) lastEvent = Math.max(lastEvent, entry.id);
          expect(frames[step]!.view).toEqual(toOrdinaryReplayView({ ...view, log, events }));
          expect(resolveReplayCursor(codec, frames[step]!.cursor!, source)).toMatchObject({ prefixCount: prefixes[step], revision: view.revision });
        });
        expect(frames.at(-1)).toMatchObject({ kind: "result", cursor: null, view: { result: { reason: "Fixture interruption" } } });
      }
      expect(source).toEqual(before);
    } finally { direct.close(); }
  }, 60_000);
});
