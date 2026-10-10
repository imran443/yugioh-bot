import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDuelSettings, seatCountFor, type DuelAnswer, type DuelChainMode, type DuelEngineView,
  type DuelFormat, type EngineIdentity, type ReplaySource } from "@yugidraft/shared/duels";
import { EngineLoopError } from "../src/engine-loop-error.js";
import { applyWorkerJournalCommand } from "../src/journal-command.js";
import { runJournalPrefix, type JournalResources } from "../src/journal-runner.js";
import { multiScriptsFolderHash, pinnedEngineVersion } from "../src/multi-scripts.js";
import type { DuelGameWorker, GameOptions } from "../src/worker-client.js";

function source(format: DuelFormat = "1v1"): ReplaySource {
  const seats = Array.from({ length: seatCountFor(format) }, (_, seat) => ({
    seat, playerId: seat + 1, displayName: `Seat ${seat}`, ready: true, isBot: false,
  }));
  return {
    session: { id: 1, slug: "source-test", kind: "play", name: "Source", guildId: "test-guild", organizerPlayerId: 1,
      mode: "normal", format, masterRule: 5, status: "completed", settings: defaultDuelSettings("normal"), seats,
      createdAt: "2026-10-10T00:00:00Z", endedAt: null, archivedAt: null, winnerPlayerId: null, winnerSeat: null, resultReason: null },
    decks: seats.map(({ seat }) => ({ main: [100 + seat], extra: [200 + seat], side: [300 + seat] })),
    seed: ["1", "2", "3", "18446744073709551615"], bundleVersion: "test-bundle", engineIdentity: null,
    setup: { firstTurnDraw: false },
    commands: [
      { storedSeq: 2, seat: 0, command: { revision: 1, promptId: "p1", answer: { choice: "next" } } },
      { storedSeq: 7, seat: 1, command: { revision: 2, promptId: "chain-mode:off", answer: {} } },
      { storedSeq: 11, seat: 1, command: { revision: 2, promptId: "eliminate:3", answer: {} } },
    ],
  };
}

class TestWorker implements DuelGameWorker {
  running = true;
  created?: GameOptions;
  revision = 1;
  modes: Record<number, DuelChainMode> = {};
  losses: number[] = [];
  calls: unknown[] = [];
  failure?: Error;
  failAt?: "create" | "view" | "answer";
  closeFailure = false;
  async create(options: GameOptions) {
    this.calls.push("create");
    if (this.failAt === "create") throw this.failure;
    this.created = structuredClone(options);
  }
  async view(seat: number | null): Promise<DuelEngineView> {
    this.calls.push(["view", seat]);
    if (this.failAt === "view") throw this.failure;
    return { revision: this.revision, turn: 1, turnSeat: 0, phase: "main1",
      seats: Array.from({ length: this.created!.decks.length }, (_, index) => ({ seat: index, lp: 8000,
        hand: [], deckCount: 35, extraCount: 0, extra: [], monsters: [], spells: [], graveyard: [], banished: [],
        ...(this.losses.includes(index) ? { eliminated: true } : {}) })),
      prompt: seat === 0 ? { id: `p${this.revision}`, seat: 0, kind: "choice", title: "Next",
        options: [{ id: "next", label: "Next" }] } : null,
      prioritySeat: 0, ...(seat === null ? {} : { chainMode: this.modes[seat] ?? "always" }),
      chain: [], events: [], log: [], result: null };
  }
  async answer(seat: number, promptId: string, answer: DuelAnswer) {
    this.calls.push(["answer", seat, promptId, answer]);
    if (this.failAt === "answer") throw this.failure;
    this.revision++;
  }
  async setChainMode(seat: number, mode: DuelChainMode) { this.calls.push(["mode", seat, mode]); this.modes[seat] = mode; return false; }
  async eliminate(seat: number, reason: number, atTurnEnd = false) {
    this.calls.push(["loss", seat, reason, atTurnEnd]); this.losses.push(seat); this.revision++;
  }
  async search() { return []; }
  async close() { this.calls.push("close"); this.running = false; if (this.closeFailure) throw new Error("close failed"); }
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function resources(): JournalResources { return { dataDirectory: "/trusted/engine", bundleVersion: "test-bundle" }; }
function multiResources(input: ReplaySource): JournalResources {
  const dir = mkdtempSync(join(tmpdir(), "journal-overlay-")); dirs.push(dir);
  writeFileSync(join(dir, "mp-utility.lua"), "-- test utility\n");
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ version: 1, cards: [] }));
  input.bundleVersion = pinnedEngineVersion("test-bundle", input.decks.length, multiScriptsFolderHash(dir));
  return { ...resources(), multiScriptsDirectory: dir };
}
function identity(): EngineIdentity { return { version: 1, coreFamily: "legacy", mode: "normal",
  wasmHash: "a".repeat(64), wrapperHash: "b".repeat(64), wrapperVersion: "1", protocolVersion: "1",
  cardDatabaseHash: "c".repeat(64), cardRemapsHash: null, cardScriptsHash: "d".repeat(64),
  domainScriptHash: null, multiOverlayHash: null, hostRuleVersion: "1" }; }

describe("journal prefix runner", () => {
  it.each([0, 1, 2, 3])("stops at ordered count %i and leaves the worker paused", async (prefixCount) => {
    const input = source(); const original = structuredClone(input); const worker = new TestWorker();
    const checkpoints: number[] = [];
    const result = await runJournalPrefix({ source: input, resources: resources(), prefixCount, createWorker: () => worker,
      onCheckpoint: ({ prefixCount }) => { checkpoints.push(prefixCount); } });
    expect(result.worker).toBe(worker); expect(worker.running).toBe(true);
    expect(result.prefixCount).toBe(prefixCount);
    expect(checkpoints).toEqual(Array.from({ length: prefixCount + 1 }, (_, n) => n));
    expect(result.views.seats).toHaveLength(2);
    expect(result.views.public.prompt).toBeNull(); expect(result.views.seats[0]!.prompt?.id).toBe(`p${prefixCount === 0 ? 1 : prefixCount === 3 ? 3 : 2}`);
    expect(worker.calls.filter(call => Array.isArray(call) && ["answer", "mode", "loss"].includes(call[0]))).toHaveLength(prefixCount);
    expect(input).toEqual(original); expect(worker.calls).not.toContain("close");
  });

  it.each([-1, 1.5, 4, NaN, Infinity])("rejects invalid count %s before spawning", async (prefixCount) => {
    const createWorker = vi.fn(() => new TestWorker());
    await expect(runJournalPrefix({ source: source(), resources: resources(), prefixCount, createWorker })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it.each(["revision", "prompt"])("closes on a saved %s mismatch before applying input", async (field) => {
    const input = source(); const worker = new TestWorker();
    if (field === "revision") input.commands[0]!.command.revision = 9; else input.commands[0]!.command.promptId = "wrong";
    await expect(runJournalPrefix({ source: input, resources: resources(), prefixCount: 1, createWorker: () => worker })).rejects.toMatchObject({ code: "REPLAY_MISMATCH" });
    expect(worker.running).toBe(false); expect(worker.calls).not.toContainEqual(expect.arrayContaining(["answer"]));
  });

  it("counts no-op mode changes and keeps the exact loss reason", async () => {
    const worker = new TestWorker();
    const result = await runJournalPrefix({ source: source(), resources: resources(), prefixCount: 3, createWorker: () => worker });
    expect(worker.calls).toContainEqual(["mode", 1, "off"]);
    expect(worker.calls).toContainEqual(["loss", 1, 3, false]);
    expect(result.views.seats[1]!.chainMode).toBe("off"); expect(result.views.public.seats[1]!.eliminated).toBe(true);
  });

  it.each(["setChainMode", "eliminate"] as const)("refuses missing %s support and closes", async (operation) => {
    const worker = new TestWorker(); Object.defineProperty(worker, operation, { value: undefined });
    await expect(runJournalPrefix({ source: source(), resources: resources(), prefixCount: 3, createWorker: () => worker })).rejects.toMatchObject({ code: "REPLAY_MISMATCH" });
    expect(worker.running).toBe(false);
  });

  it("does not apply retired loss semantics, but allows an earlier prefix", async () => {
    const input = source(); input.commands[2]!.command.promptId = "eliminate-eot:0";
    const createWorker = vi.fn(() => new TestWorker());
    await expect(runJournalPrefix({ source: input, resources: resources(), prefixCount: 3, createWorker })).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" });
    expect(createWorker).not.toHaveBeenCalled();
    await expect(runJournalPrefix({ source: input, resources: resources(), prefixCount: 2, createWorker })).resolves.toMatchObject({ prefixCount: 2 });
  });

  it.each(["create", "view", "answer"] as const)("closes on %s failure and keeps the right error code", async (failAt) => {
    const worker = new TestWorker(); worker.failAt = failAt; worker.failure = new Error("test failure"); worker.closeFailure = true;
    await expect(runJournalPrefix({ source: source(), resources: resources(), prefixCount: 1, createWorker: () => worker }))
      .rejects.toMatchObject({ code: failAt === "answer" ? "REPLAY_MISMATCH" : "ENGINE_BUSY", message: expect.stringContaining("test failure") });
    expect(worker.running).toBe(false);
  });

  it("preserves engine-loop errors for the live recovery handler", async () => {
    const worker = new TestWorker(); worker.failAt = "answer"; worker.failure = new EngineLoopError();
    await expect(runJournalPrefix({ source: source(), resources: resources(), prefixCount: 1, createWorker: () => worker })).rejects.toBe(worker.failure);
    expect(worker.running).toBe(false);
  });

  it("closes when checkpoint capture fails", async () => {
    const worker = new TestWorker(); const error = new Error("capture failed");
    await expect(runJournalPrefix({ source: source(), resources: resources(), prefixCount: 1, createWorker: () => worker,
      onCheckpoint: () => { throw error; } })).rejects.toBe(error);
    expect(worker.running).toBe(false);
  });

  it("checks target revision and private-view digest", async () => {
    const options = { source: source(), resources: resources(), prefixCount: 2 };
    const result = await runJournalPrefix({ ...options, createWorker: () => new TestWorker() });
    await expect(runJournalPrefix({ ...options, createWorker: () => new TestWorker(),
      target: { revision: 2, stateDigest: result.stateDigest } })).resolves.toMatchObject({ stateDigest: result.stateDigest });
    for (const target of [{ revision: 3 }, { revision: 2, stateDigest: "a".repeat(64) }]) {
      const worker = new TestWorker();
      await expect(runJournalPrefix({ ...options, createWorker: () => worker, target })).rejects.toMatchObject({ code: "REPLAY_MISMATCH" });
      expect(worker.running).toBe(false);
    }
  });

  it("refuses bundle and identity changes before spawning", async () => {
    const createWorker = vi.fn(() => new TestWorker()); const input = source();
    await expect(runJournalPrefix({ source: input, resources: { ...resources(), bundleVersion: "changed" }, prefixCount: 0, createWorker }))
      .rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" });
    input.engineIdentity = identity();
    for (const engineIdentity of [undefined, { ...identity(), wasmHash: "e".repeat(64) }, { ...identity(), hostRuleVersion: "2" }]) {
      await expect(runJournalPrefix({ source: input, resources: { ...resources(), engineIdentity }, prefixCount: 0, createWorker }))
        .rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" });
    }
    expect(createWorker).not.toHaveBeenCalled();
    await expect(runJournalPrefix({ source: input, resources: { ...resources(), engineIdentity: identity() }, prefixCount: 0, createWorker })).resolves.toBeDefined();
  });

  it.each([
    ["seed", (s: ReplaySource) => { s.seed[0] = "0"; }],
    ["seat order", (s: ReplaySource) => { s.session.seats.reverse(); }],
    ["deck count", (s: ReplaySource) => { s.decks.pop(); }],
    ["sequence order", (s: ReplaySource) => { s.commands[1]!.storedSeq = 2; }],
    ["command seat", (s: ReplaySource) => { s.commands[0]!.seat = 2; }],
  ] as const)("rejects invalid %s before spawning", async (_label, change) => {
    const input = source(); change(input); const createWorker = vi.fn(() => new TestWorker());
    await expect(runJournalPrefix({ source: input, resources: resources(), prefixCount: 3, createWorker })).rejects.toMatchObject({ code: "REPLAY_MISMATCH" });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it.each([
    { setup: undefined, engine: "legacy", firstTurnDraw: false, scriptErrorMode: "tolerant" },
    { setup: { engine: "pinned", firstTurnDraw: false, scriptErrorMode: "strict" }, engine: "pinned", firstTurnDraw: false, scriptErrorMode: "strict" },
    { setup: { startupScripts: ["first", "second"] }, engine: "pinned", firstTurnDraw: false, scriptErrorMode: "tolerant" },
    { setup: { engine: "legacy", firstTurnDraw: true }, engine: "legacy", firstTurnDraw: true, scriptErrorMode: "tolerant" },
  ] as Array<{ setup: ReplaySource["setup"]; engine: string; firstTurnDraw: boolean; scriptErrorMode: string }>)("preserves saved creation rules $engine $scriptErrorMode", async ({ setup, ...expected }) => {
    vi.stubEnv("DUEL_1V1_ENGINE", "pinned"); vi.stubEnv("DUEL_SCRIPT_ERROR_MODE", "strict");
    const input = source(); input.session.mode = "domain"; input.setup = structuredClone(setup);
    const worker = new TestWorker();
    await runJournalPrefix({ source: input, resources: resources(), prefixCount: 0, createWorker: () => worker });
    expect(worker.created).toMatchObject({ ...expected, decks: input.decks, seed: input.seed, settings: input.session.settings, masterRule: 5 });
    expect(worker.created!.startupScripts).toEqual(setup?.startupScripts?.map((content, index) => ({ name: `startup-${index}.lua`, content })));
  });

  it.each(["tag", "ffa3", "ffa4"] as const)("pins the selected %s overlay and uses every original seat", async (format) => {
    const input = source(format); input.setup!.engine = "legacy"; const selected = multiResources(input); const worker = new TestWorker();
    await runJournalPrefix({ source: input, resources: selected, prefixCount: 0, createWorker: () => worker });
    expect(worker.created).toMatchObject({ format, multiScriptsDirectory: selected.multiScriptsDirectory, decks: input.decks });
    expect(worker.created!.engine).toBeUndefined();
    writeFileSync(join(selected.multiScriptsDirectory!, "mp-utility.lua"), "-- changed\n");
    await expect(runJournalPrefix({ source: input, resources: selected, prefixCount: 0, createWorker: () => new TestWorker() }))
      .rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" });
  });

  it.each(["ffa3", "ffa4"] as const)("refuses an unknown old %s draw rule", async (format) => {
    const input = source(format); delete input.setup!.firstTurnDraw; const selected = multiResources(input); const createWorker = vi.fn(() => new TestWorker());
    await expect(runJournalPrefix({ source: input, resources: selected, prefixCount: 0, createWorker }))
      .rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" });
    expect(createWorker).not.toHaveBeenCalled();
  });
});

it("awaits worker commands before returning", async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const worker = new TestWorker(); const answer = worker.answer.bind(worker);
  worker.answer = async (...args) => { await wait; await answer(...args); };
  let finished = false;
  const applied = applyWorkerJournalCommand(worker, 0, source().commands[0]!.command).then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false); expect(worker.revision).toBe(1);
  release(); await applied; expect(finished).toBe(true); expect(worker.revision).toBe(2);
});
