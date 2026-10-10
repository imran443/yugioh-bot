// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DuelRequestError } from "@/components/duel/api";
import {
  createReadOnlyTableController,
  frameCaption,
  isReplayV2,
  legacyFrameId,
  normalizeReplay,
  readFrameParam,
  replayFailure,
  replayKeyAction,
  replayResultHeadline,
  replayRoom,
  resolveCameraSeat,
  resolveFocusSeat,
  withFrameParam,
} from "@/components/duel/replay-controller";
import { buildReplayTimeline } from "@/components/duel/replay-timeline";
import { frame, replayV1, replayV2 } from "./replay-fixtures";

function key(init: KeyboardEventInit & { key: string }, target?: Element): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
}
const noDialog = { querySelector: () => null };

describe("normalizeReplay", () => {
  it("passes v2 frames through with their IDs and strips private prompt fields from every view", () => {
    const raw = replayV2();
    // A careless producer leaves live fields behind; the viewer must not show them.
    Object.assign(raw.frames[1]!.view, { prompt: { id: "p" }, prioritySeat: 1, chainMode: "always" });
    const model = normalizeReplay(raw, "game-1", "mine");
    expect(model.version).toBe(2);
    expect(model.frames.map((entry) => entry.frameId)).toEqual(["f0", "f1", "f2", "f3"]);
    expect(model.frames[1]!.view.prompt).toBeNull();
    expect(model.frames[1]!.view.prioritySeat).toBeNull();
    expect("chainMode" in model.frames[1]!.view).toBe(false);
    expect(model.frames[1]!.cursor).toBe("c1");
    expect(model.visibility).toBe("mine");
    expect(model.dataSeat).toBe(0);
  });

  it("echoes the visibility the server answered with, not the one requested", () => {
    const model = normalizeReplay(replayV2({ visibility: "public" }), "game-1", "mine");
    expect(model.visibility).toBe("public");
    expect(model.requested).toBe("mine");
    expect(model.dataSeat).toBeNull();
  });

  it("turns a v1 answer into stable step-based frame IDs without cursors", () => {
    const model = normalizeReplay(replayV1(), "game-1", "mine");
    expect(model.version).toBe(1);
    expect(model.frames.map((entry) => entry.frameId)).toEqual([0, 1, 2, 3].map(legacyFrameId));
    expect(model.frames.every((entry) => entry.cursor === null)).toBe(true);
    expect(model.frames.map((entry) => entry.kind)).toEqual(["opening", "engine", "engine", "result"]);
    expect(model.visibility).toBe("mine");
  });

  it("keeps a v1 final frame that has an actor as an engine frame", () => {
    const raw = replayV1();
    raw.frames[3]!.actorSeat = 1;
    expect(normalizeReplay(raw, "game-1", "mine").frames[3]!.kind).toBe("engine");
  });

  it("rejects an answer with no frames or session", () => {
    expect(() => normalizeReplay({} as never, "game-1", "mine")).toThrow(DuelRequestError);
    expect(isReplayV2({ version: 2, frames: [{ view: {} }] })).toBe(false);
    expect(isReplayV2(replayV2())).toBe(true);
  });
});

describe("replay timeline over v2 frames", () => {
  it("never shows a prompt, priority or chain mode, even when a frame carries one", () => {
    const frames = replayV2().frames;
    Object.assign(frames[1]!.view, { prioritySeat: 1, chainMode: "off" });
    const view = buildReplayTimeline(frames).viewAt(1);
    expect(view.prompt).toBeNull();
    expect(view.prioritySeat).toBeNull();
    expect(view.chainMode).toBeUndefined();
  });
});

describe("frame address", () => {
  it("reads and writes the frame parameter without touching other parameters", () => {
    expect(readFrameParam("?frame=f2&x=1")).toBe("f2");
    expect(readFrameParam("")).toBeNull();
    expect(readFrameParam(`?frame=${"x".repeat(300)}`)).toBeNull();
    expect(withFrameParam("/duels/game-1/replay?x=1#top", "f3")).toBe("/duels/game-1/replay?x=1&frame=f3#top");
    expect(withFrameParam("/duels/game-1/replay?frame=f1", "f9")).toBe("/duels/game-1/replay?frame=f9");
    expect(withFrameParam("/duels/game-1/replay?frame=f1", null)).toBe("/duels/game-1/replay");
  });
});

describe("camera", () => {
  it("defaults to the viewer's own seat, then seat 0, and only picks real seats", () => {
    expect(resolveCameraSeat(null, 2, 4)).toBe(2);
    expect(resolveCameraSeat(null, null, 4)).toBe(0);
    expect(resolveCameraSeat(3, 1, 4)).toBe(3);
    expect(resolveCameraSeat(7, 1, 4)).toBe(0);
    expect(resolveCameraSeat(-1, null, 2)).toBe(0);
    expect(resolveCameraSeat(1, null, 2)).toBe(1);
  });

  it("draws an opponent across from the camera unless another seat is chosen", () => {
    expect(resolveFocusSeat({ format: "1v1" }, 0, null)).toBe(1);
    expect(resolveFocusSeat({ format: "1v1" }, 1, null)).toBe(0);
    expect(resolveFocusSeat({ format: "ffa3" }, 1, null)).toBe(0);
    expect(resolveFocusSeat({ format: "ffa4" }, 0, 3)).toBe(3);
    expect(resolveFocusSeat({ format: "ffa4" }, 3, 3)).toBe(0);
    // Tag: the first opponent is on the other team, not the partner.
    expect(resolveFocusSeat({ format: "tag" }, 0, null)).toBe(1);
    expect(resolveFocusSeat({ format: "tag" }, 1, null)).toBe(0);
    expect(resolveFocusSeat({ format: "tag" }, 0, 9)).toBe(1);
  });
});

describe("replayKeyAction", () => {
  it("maps the transport keys", () => {
    expect(replayKeyAction(key({ key: " " }), noDialog)).toBe("toggle");
    expect(replayKeyAction(key({ key: "ArrowRight" }), noDialog)).toBe("next");
    expect(replayKeyAction(key({ key: "ArrowLeft" }), noDialog)).toBe("previous");
    expect(replayKeyAction(key({ key: "Home" }), noDialog)).toBe("first");
    expect(replayKeyAction(key({ key: "End" }), noDialog)).toBe("last");
    expect(replayKeyAction(key({ key: "a" }), noDialog)).toBeNull();
  });

  it("leaves modified keys and prevented events alone", () => {
    expect(replayKeyAction(key({ key: "ArrowRight", ctrlKey: true }), noDialog)).toBeNull();
    expect(replayKeyAction(key({ key: "ArrowRight", metaKey: true }), noDialog)).toBeNull();
    expect(replayKeyAction(key({ key: "ArrowRight", altKey: true }), noDialog)).toBeNull();
    const prevented = key({ key: "ArrowRight" });
    prevented.preventDefault();
    expect(replayKeyAction(prevented, noDialog)).toBeNull();
  });

  it("does not take keys from fields, focused buttons (space) or dialogs", () => {
    document.body.innerHTML = `<input id="i"><select id="s"></select><textarea id="t"></textarea><button id="b"></button>
      <div role="dialog" aria-modal="true"><button id="d"></button></div>`;
    const get = (id: string) => document.getElementById(id)!;
    for (const id of ["i", "s", "t"]) expect(replayKeyAction(key({ key: "ArrowRight" }, get(id)), noDialog)).toBeNull();
    expect(replayKeyAction(key({ key: " " }, get("b")), noDialog)).toBeNull();
    expect(replayKeyAction(key({ key: "ArrowRight" }, get("b")), noDialog)).toBe("next");
    expect(replayKeyAction(key({ key: "ArrowRight" }, get("d")), noDialog)).toBeNull();
    // Focus still on the page behind an open modal dialog.
    expect(replayKeyAction(key({ key: "ArrowRight" }, document.body))).toBeNull();
    document.body.innerHTML = "";
    expect(replayKeyAction(key({ key: "ArrowRight" }, document.body))).toBe("next");
  });

  it("ignores a dialog that is closing (inert)", () => {
    document.body.innerHTML = `<div role="dialog" aria-modal="true" inert></div>`;
    expect(replayKeyAction(key({ key: "ArrowRight" }, document.body))).toBe("next");
    document.body.innerHTML = "";
  });
});

describe("read-only table controller", () => {
  const model = normalizeReplay(replayV2({ format: "ffa3" }), "game-1", "mine");
  const engine = buildReplayTimeline(model.frames).viewAt(1);

  it("has no prompt, no legal or selected keys and cannot answer", () => {
    const onActivate = vi.fn();
    const onInspect = vi.fn();
    const table = createReadOnlyTableController({
      room: replayRoom(model, engine), engine, camera: 2, nameOf: (seat) => `S${seat}`, reducedMotion: true, onActivate, onInspect,
    });
    expect(table.viewerSeat).toBe(2);
    expect(table.prompt).toBeNull();
    expect(table.promptSeat).toBeNull();
    expect(table.canAct).toBe(false);
    expect(table.busy).toBe(false);
    expect(table.revealed).toBe(false);
    expect(table.legalKeys.size).toBe(0);
    expect(table.selectedKeys.size).toBe(0);
    expect(table.aim).toBeNull();
    expect(table.seatPick).toBeNull();
    expect(table.attackAim).toBeNull();
    expect(table.room.clock).toBeNull();
    expect(table.room.myDeck).toBeNull();
    expect(table.room.mySeat).toBe(0);
    expect(table.onAnswer({ type: "pass" } as never)).toBeUndefined();
    // Draft setters are inert: nothing a shell does to the draft survives.
    table.draft.setSelected(["x"]);
    expect(table.draft.selected).toEqual([]);
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe("replay words", () => {
  const name = (seat: number) => ["Ada", "Bo", "Cy", "Di"][seat]!;

  it("names the frame actor", () => {
    expect(frameCaption(frame({ step: 0 }), 0, false, name)).toBe("Opening board");
    expect(frameCaption(frame({ step: 2, actorSeat: 1 }), 2, false, name)).toBe("Bo acted");
    expect(frameCaption(frame({ step: 3, kind: "result", actorSeat: null }), 3, true, name)).toBe("Final result");
    expect(frameCaption(frame({ step: 3, actorSeat: null }), 3, false, name)).toBe("Update");
  });

  it("names the winner, the team in Tag, a draw and an interrupted game", () => {
    expect(replayResultHeadline({ status: "completed", format: "1v1" }, { winnerSeat: 1 }, name)).toBe("Bo wins");
    expect(replayResultHeadline({ status: "completed", format: "ffa4" }, { winnerSeat: null }, name)).toBe("Draw");
    expect(replayResultHeadline({ status: "completed", format: "tag" }, { winnerSeat: 1 }, name)).toBe("Team 2 wins · Bo & Di");
    expect(replayResultHeadline({ status: "interrupted", format: "1v1" }, null, name)).toBe("Interrupted");
  });

  it("explains typed engine failures and honors a missing final board", () => {
    const unavailable = replayFailure(new DuelRequestError("x", 409, "ENGINE_UNAVAILABLE_FOR_SOURCE", "available"));
    expect(unavailable.message).toMatch(/no longer installed/);
    expect(unavailable.finalBoard).toBe(true);
    const none = replayFailure(new DuelRequestError("x", 409, "NOT_PLAYABLE", "none"));
    expect(none.finalBoard).toBe(false);
    expect(none.message).not.toMatch(/still available/);
    // Older servers send no code: keep their message and the final board link.
    const old = replayFailure(new DuelRequestError("Replay is not available for this duel.", 409));
    expect(old).toEqual({ message: "Replay is not available for this duel.", finalBoard: true });
    expect(replayFailure(new DuelRequestError("denied", 404, "ACCESS_DENIED")).finalBoard).toBe(false);
    expect(replayFailure(null).message).toBe("Could not load this replay.");
  });
});
