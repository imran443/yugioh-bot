import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentEngineResources } from "../src/engine-resource-resolver.js";
import { handleWorkerRequest } from "../src/worker.js";
import { GameWorker } from "../src/worker-client.js";

const { create, legacyCreate } = vi.hoisted(() => ({ create: vi.fn(), legacyCreate: vi.fn() }));
vi.mock("../src/engine.js", () => ({ createEngineGame: create }));
vi.mock("../src/legacy/index.js", () => ({ createLegacyEngineGame: legacyCreate }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { parentPort: null, Worker: class extends EventEmitter {
    postMessage(request: Parameters<typeof handleWorkerRequest>[0]) {
      void handleWorkerRequest(request).then(response => this.emit("message", response));
    }
    async terminate() { return 0; }
  } };
});

const directories: string[] = [];
afterEach(async () => {
  await handleWorkerRequest({ id: 0, op: "close" });
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function options() {
  const directory = mkdtempSync(join(tmpdir(), "worker-identity-"));
  directories.push(directory);
  mkdirSync(join(directory, "card-scripts"));
  writeFileSync(join(directory, "card-scripts/constant.lua"), "constant");
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ bundleVersion: "test-bundle" }));
  writeFileSync(join(directory, "cards.cdb"), "cards");
  writeFileSync(join(directory, "ocgcore.standard.wasm"), "core");
  const { identity } = getCurrentEngineResources(directory, { mode: "normal", engine: "pinned" });
  return { mode: "normal" as const, engine: "pinned" as const, dataDirectory: directory, decks: [], seed: [], engineIdentity: identity };
}

describe("worker resource identity gate", () => {
  it("refuses a changed core before calling either engine factory", async () => {
    const input = options();
    writeFileSync(join(input.dataDirectory, "ocgcore.standard.wasm"), "changed");
    const result = await handleWorkerRequest({ id: 1, op: "create", options: input });
    expect(result).toMatchObject({ ok: false, code: "ENGINE_UNAVAILABLE_FOR_SOURCE" });
    expect(create).not.toHaveBeenCalled();
    expect(legacyCreate).not.toHaveBeenCalled();
  });

  it("preserves the stable error through the worker client", async () => {
    const input = options();
    input.engineIdentity.wrapperHash = "0".repeat(64);
    const worker = new GameWorker();
    try {
      await expect(worker.create(input)).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE", status: 409 });
    } finally { await worker.close(); }
  });

  it("accepts an exact identity and passes the saved rules to the engine", async () => {
    const input = options();
    create.mockResolvedValueOnce({ close: vi.fn() });
    expect(await handleWorkerRequest({ id: 1, op: "create", options: { ...input, firstTurnDraw: false } })).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ engineIdentity: input.engineIdentity, firstTurnDraw: false }));
  });
});
