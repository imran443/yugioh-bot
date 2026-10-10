// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayFrameV2 } from "@yugidraft/shared/duels";
import { useReplayController, useReplayData } from "@/components/duel/replay-controller";
import { resetCoinTossState } from "@/components/duel/coin-toss-lock";
import { replayV2 } from "./replay-fixtures";

const ids = (count: number) => Array.from({ length: count }, (_, i) => ({ frameId: `f${i}` }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => { resetCoinTossState(); window.history.replaceState(null, "", "/duels/game-1/replay"); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); resetCoinTossState(); });

describe("useReplayController", () => {
  const setup = (frames: readonly { frameId: string }[] | null = ids(5), mySeat: number | null = 0, seatCount = 2) =>
    renderHook(({ list }) => useReplayController({ slug: "game-1", frames: list, seatCount, mySeat }), { initialProps: { list: frames } });

  it("steps and seeks, and a seek or step back restarts effects but a forward step keeps them", () => {
    const { result } = setup();
    expect(result.current.index).toBe(0);
    const epoch0 = result.current.epoch;
    act(() => result.current.stepForward());
    expect(result.current.index).toBe(1);
    expect(result.current.epoch).toBe(epoch0);
    act(() => result.current.seek(3));
    expect(result.current.index).toBe(3);
    expect(result.current.epoch).toBe(epoch0 + 1);
    act(() => result.current.stepBack());
    expect(result.current.index).toBe(2);
    expect(result.current.epoch).toBe(epoch0 + 2);
    act(() => result.current.seek(99));
    expect(result.current.index).toBe(4);
    act(() => result.current.seek(-4));
    expect(result.current.index).toBe(0);
  });

  it("keeps the same frame when the frames are replaced, by frame ID", () => {
    const { result, rerender } = setup();
    act(() => result.current.seek(3));
    expect(result.current.frameId).toBe("f3");
    // Another card view: same IDs in a new array, plus an extra leading frame to move every index.
    rerender({ list: [{ frameId: "x" }, ...ids(5)] });
    expect(result.current.frameId).toBe("f3");
    expect(result.current.index).toBe(4);
  });

  it("falls back to the clamped index when the frame ID is gone", () => {
    const { result, rerender } = setup();
    act(() => result.current.seek(4));
    rerender({ list: [{ frameId: "a" }, { frameId: "b" }] });
    expect(result.current.index).toBe(1);
  });

  it("keeps the selection while frames are not loaded", () => {
    const { result, rerender } = setup();
    act(() => result.current.seek(2));
    rerender({ list: null });
    expect(result.current.index).toBe(0);
    rerender({ list: ids(5) });
    expect(result.current.frameId).toBe("f2");
  });

  it("starts at the frame named in the address and writes the selected frame back, debounced", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/duels/game-1/replay?x=1&frame=f2");
    const { result } = setup();
    expect(result.current.frameId).toBe("f2");
    act(() => result.current.stepForward());
    act(() => result.current.stepForward());
    expect(window.location.search).toBe("?x=1&frame=f2");
    act(() => { vi.advanceTimersByTime(600); });
    expect(window.location.search).toBe("?x=1&frame=f4");
  });

  it("separates the camera from the frame: a camera move keeps the frame and restarts effects", () => {
    const { result } = setup(ids(5), 1, 4);
    expect(result.current.camera).toBe(1);
    act(() => result.current.seek(2));
    const epoch = result.current.epoch;
    act(() => result.current.setCamera(3));
    expect(result.current.camera).toBe(3);
    expect(result.current.frameId).toBe("f2");
    expect(result.current.epoch).toBe(epoch + 1);
  });

  it("autoplays to the last frame, stops there and restarts from the top on Play at the end", () => {
    vi.useFakeTimers();
    const { result } = setup(ids(3));
    act(() => result.current.togglePlay());
    expect(result.current.playing).toBe(true);
    act(() => { vi.advanceTimersByTime(1400); });
    expect(result.current.index).toBe(1);
    act(() => { vi.advanceTimersByTime(1400); });
    expect(result.current.index).toBe(2);
    expect(result.current.playing).toBe(false);
    act(() => result.current.togglePlay());
    expect(result.current.index).toBe(0);
    expect(result.current.playing).toBe(true);
  });

  it("answers the keyboard and stops answering when a dialog is open", () => {
    const { result } = setup();
    const press = (keyName: string) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, cancelable: true })); });
    press("ArrowRight");
    press("ArrowRight");
    expect(result.current.index).toBe(2);
    press("ArrowLeft");
    expect(result.current.index).toBe(1);
    press("End");
    expect(result.current.index).toBe(4);
    press("Home");
    expect(result.current.index).toBe(0);
    press(" ");
    expect(result.current.playing).toBe(true);
    press(" ");
    expect(result.current.playing).toBe(false);
    document.body.insertAdjacentHTML("beforeend", `<div role="dialog" aria-modal="true"></div>`);
    press("ArrowRight");
    expect(result.current.index).toBe(0);
    document.body.innerHTML = "";
  });
});

describe("useReplayData", () => {
  function stubFetch() {
    const calls: Array<{ url: string; signal: AbortSignal | undefined; reply: ReturnType<typeof deferred<Response>> }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const reply = deferred<Response>();
      calls.push({ url, signal: init?.signal ?? undefined, reply });
      return reply.promise;
    }));
    return calls;
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("asks for version 2 and the visibility, and nothing that selects a seat", async () => {
    const calls = stubFetch();
    const { result } = renderHook(() => useReplayData("game-1", "mine"));
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url, "http://x");
    expect(url.pathname).toBe("/api/duels/game-1/replay");
    expect([...url.searchParams.keys()].sort()).toEqual(["version", "visibility"]);
    expect(url.searchParams.get("version")).toBe("2");
    expect(url.searchParams.get("visibility")).toBe("mine");
    await act(async () => { calls[0]!.reply.resolve(json(replayV2())); });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.model?.frames).toHaveLength(4);
  });

  it("ignores a late answer for a view that is no longer requested", async () => {
    const calls = stubFetch();
    const { result, rerender } = renderHook(({ visibility }) => useReplayData("game-1", visibility), { initialProps: { visibility: "mine" as "mine" | "public" } });
    rerender({ visibility: "public" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal?.aborted).toBe(true);
    // The public answer lands first, then the stale private one.
    await act(async () => { calls[1]!.reply.resolve(json(replayV2({ visibility: "public" }))); });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.model?.visibility).toBe("public");
    await act(async () => { calls[0]!.reply.resolve(json(replayV2({ visibility: "mine" }))); });
    expect(result.current.model?.visibility).toBe("public");
    expect(result.current.settled).toBe(true);
  });

  it("keeps the old answer, unsettled, while another view loads", async () => {
    const calls = stubFetch();
    const { result, rerender } = renderHook(({ visibility }) => useReplayData("game-1", visibility), { initialProps: { visibility: "mine" as "mine" | "public" } });
    await act(async () => { calls[0]!.reply.resolve(json(replayV2())); });
    await waitFor(() => expect(result.current.settled).toBe(true));
    rerender({ visibility: "public" });
    expect(result.current.model?.visibility).toBe("mine");
    expect(result.current.settled).toBe(false);
  });

  it("reports an error for the current request only and drops another duel's answer", async () => {
    const calls = stubFetch();
    const { result, rerender } = renderHook(({ slug }) => useReplayData(slug, "mine"), { initialProps: { slug: "game-1" } });
    await act(async () => { calls[0]!.reply.resolve(json(replayV2())); });
    await waitFor(() => expect(result.current.model).not.toBeNull());
    rerender({ slug: "game-2" });
    expect(result.current.model).toBeNull();
    await act(async () => { calls[1]!.reply.resolve(json({ error: "No", code: "NOT_PLAYABLE", finalBoard: "available" }, 409)); });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect((result.current.error as { code?: string }).code).toBe("NOT_PLAYABLE");
  });

  it("accepts the v1 answer of an older server", async () => {
    const calls = stubFetch();
    const { result } = renderHook(() => useReplayData("game-1", "mine"));
    const v2 = replayV2();
    const v1 = { session: v2.session, role: v2.role, mySeat: 0, frames: v2.frames.map((f: ReplayFrameV2) => ({ step: f.step, actorSeat: f.actorSeat, view: f.view })) };
    await act(async () => { calls[0]!.reply.resolve(json(v1)); });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.model?.version).toBe(1);
    expect(result.current.model?.frames[0]!.frameId).toBe("step-0");
  });
});
