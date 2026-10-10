import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReplayFrames, ReplayBuildCache } from "../src/replay-builder.js";
import { createReplayCursorCodec, replaySourceVersion } from "../src/replay-cursor.js";
import { multiScriptsFolderHash, pinnedEngineVersion } from "../src/multi-scripts.js";
import { ReplayWorker, replaySource } from "./support/replay-fixtures.js";

const codec = createReplayCursorCodec("builder-test-secret");
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function input(format: "1v1" | "tag" | "ffa3" | "ffa4" = "1v1") {
  const source = replaySource(format);
  const resources = { dataDirectory: "/trusted/engine", bundleVersion: "test-bundle", multiScriptsDirectory: undefined as string | undefined };
  if (format !== "1v1") {
    const dir = mkdtempSync(join(tmpdir(), "replay-overlay-")); dirs.push(dir);
    writeFileSync(join(dir, "mp-utility.lua"), "-- fixture");
    resources.multiScriptsDirectory = dir;
    source.bundleVersion = pinnedEngineVersion(resources.bundleVersion, source.decks.length, multiScriptsFolderHash(dir));
  }
  return { source, resources, sourceVersion: replaySourceVersion(source), codec, finalView: null };
}

describe("replay frame builder", () => {
  it.each(["1v1", "tag", "ffa3", "ffa4"] as const)("uses stable %s frame IDs, exact prefixes and independent projection deltas", async format => {
    const options = input(format);
    const workers: ReplayWorker[] = [];
    const build = (dataSeat: number | null) => buildReplayFrames({ ...options, dataSeat,
      createWorker: () => { const worker = new ReplayWorker(); workers.push(worker); return worker; } });
    const mine = await build(0); const other = await build(1); const publicFrames = await build(null);
    expect(mine.map(f => f.frameId)).toEqual(other.map(f => f.frameId));
    expect(mine.map(f => f.frameId)).toEqual(publicFrames.map(f => f.frameId));
    expect(mine.map(f => f.kind)).toEqual(["opening", "engine", "engine", "result"]);
    expect(mine.map(f => f.cursor && codec.open(f.cursor).prefixCount)).toEqual([0, 1, 3, null]);
    expect(mine[1]!.view.log.map(e => e.id)).toEqual([2]);
    expect(other[1]!.view.log[0]!.text).toBe("Private 1 1");
    expect(publicFrames[1]!.view.log[0]!.text).toBe("Public 1");
    expect(publicFrames[0]!.view.seats.every(s => s.hand[0]!.code === undefined)).toBe(true);
    expect(mine[0]!.view.seats[1]!.hand[0]!.code).toBeUndefined();
    for (const frames of [mine, other, publicFrames]) for (const f of frames) {
      expect(f.view.prompt).toBeNull(); expect(f.view.prioritySeat).toBeNull(); expect(f.view).not.toHaveProperty("chainMode");
    }
    expect(workers.every(w => w.closed === 1)).toBe(true);
  });
  it("reveals only hands and Extra Decks on an explicit owner projection", async () => {
    const frames = await buildReplayFrames({ ...input(), dataSeat: null, reveal: true, createWorker: () => new ReplayWorker() });
    expect(frames[0]!.view.seats.map(s => s.hand[0]!.code)).toEqual([900, 901]);
    expect(frames[0]!.view.seats.map(s => s.extra[0]!.code)).toEqual([900, 901]);
    expect(frames[0]!.view.seats.every(s => s.monsters[0]!.code === undefined)).toBe(true);
    expect(frames[0]!.view.log[0]!.text).toBe("Public 0");
  });
  it("makes genuine engine results unplayable without adding a second result", async () => {
    const options = input(); options.source.commands = options.source.commands.slice(0, 1);
    const worker = new ReplayWorker();
    worker.answer = async () => { worker.revision++; worker.result = { winnerSeat: 0, reason: "Life points" }; };
    const frames = await buildReplayFrames({ ...options, dataSeat: 0, createWorker: () => worker });
    expect(frames).toHaveLength(2); expect(frames[1]).toMatchObject({ kind: "result", cursor: null });
    expect(frames[0]!.cursor).toBeTypeOf("string");
  });
  it("refuses cursors for unsequenced old host losses without copying them into early frames", async () => {
    const options = input("ffa3"); options.source.setup!.surrenderedSeats = [1];
    const frames = await buildReplayFrames({ ...options, dataSeat: null, createWorker: () => new ReplayWorker() });
    expect(frames.every(f => f.cursor === null)).toBe(true);
    expect(frames[0]!.view.seats[1]!.eliminated).toBeUndefined();
  });
  it("closes on mismatch, byte limit and bounded timeout", async () => {
    for (const failure of ["mismatch", "bytes", "timeout"]) {
      const worker = new ReplayWorker(); const options = input();
      if (failure === "mismatch") options.source.commands[0]!.command.revision = 9;
      if (failure === "timeout") worker.create = () => new Promise(() => {});
      await expect(buildReplayFrames({ ...options, dataSeat: null, createWorker: () => worker,
        maxBytes: failure === "bytes" ? 20 : undefined, timeoutMs: 20 })).rejects.toMatchObject({
          code: failure === "mismatch" ? "REPLAY_MISMATCH" : "ENGINE_BUSY" });
      expect(worker.closed).toBe(1);
    }
  });
});

describe("bounded replay cache", () => {
  it("deduplicates concurrent builds, retries failures and keeps auth/perspective keys apart", async () => {
    const cache = new ReplayBuildCache({ maxBytes: 100, maxEntries: 2, maxConcurrent: 2 });
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const build = vi.fn(async () => { await wait; return ["a"]; });
    const a = cache.getOrBuild("owner:seat0", build); const b = cache.getOrBuild("owner:seat0", build);
    await Promise.resolve(); expect(build).toHaveBeenCalledTimes(1);
    release(); expect(await a).toEqual(await b);
    await cache.getOrBuild("alpha:public", async () => ["b"]);
    expect(cache.size).toBe(2);
    await expect(cache.getOrBuild("failure", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(await cache.getOrBuild("failure", async () => ["ok"])).toEqual(["ok"]);
  });
  it("evicts by bytes and entries, refuses oversized values and caps detached jobs", async () => {
    const cache = new ReplayBuildCache({ maxBytes: 20, maxEntries: 2, maxConcurrent: 1 });
    await cache.getOrBuild("a", async () => "12345678"); await cache.getOrBuild("b", async () => "123456789");
    expect(cache.size).toBe(1); expect(cache.bytes).toBeLessThanOrEqual(20);
    await expect(cache.getOrBuild("huge", async () => "x".repeat(21))).rejects.toMatchObject({ code: "ENGINE_BUSY" });
    let release!: () => void;
    const pending = cache.getOrBuild("slow", () => new Promise<string>(resolve => { release = () => resolve("ok"); }));
    await Promise.resolve();
    await expect(cache.getOrBuild("other", async () => "ok")).rejects.toMatchObject({ code: "ENGINE_BUSY" });
    release(); await pending; cache.clear(); expect(cache.size).toBe(0); expect(cache.bytes).toBe(0);
  });
});
