// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelFormat, DuelReplayV2, ReplayFrameV2 } from "@yugidraft/shared/duels";
import { resetCoinTossState } from "@/components/duel/coin-toss-lock";
import { frame, replayV2 } from "./replay-fixtures";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

import { DuelReplayView } from "@/components/duel/replay";
import { isFfaFormat, lossOrderAt } from "@/components/duel/replay-ffa";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mediaStub(narrow: boolean) {
  return (query: string) => ({
    matches: narrow && query.includes("max-width"), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}

let calls: Array<{ url: URL; init?: RequestInit }>;
function stubServer(replay: (visibility: "mine" | "public") => DuelReplayV2) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    // Card art and names ask for their own data; the replay itself is the only call that counts.
    if (!url.pathname.endsWith("/replay")) return json({ cards: [] });
    calls.push({ url, init });
    return json(replay(url.searchParams.get("visibility") === "public" ? "public" : "mine"));
  }));
}

class RO {
  constructor(private cb: () => void) {}
  observe() { this.cb(); }
  disconnect() {}
  unobserve() {}
}
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1100 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 860 });
});
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  resetCoinTossState();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/duels/game-1/replay");
  window.matchMedia = mediaStub(false);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetCoinTossState(); });

type Pairing = "facing" | "across" | "none" | "unset";

interface FrameShape {
  out?: number[];
  leaving?: number[];
  pairing?: Pairing;
  turnSeat?: number;
  result?: { winnerSeat: number | null; reason: string };
}

/** An FFA frame: a seat in `out` has 0 LP and is eliminated; the engine's own `sharedExtraWith` names the pairing. */
function ffaFrame(format: "ffa3" | "ffa4", step: number, shape: FrameShape = {}): ReplayFrameV2 {
  const { out = [], leaving = [], pairing = "unset", turnSeat = 0, result } = shape;
  const base = frame({ step, format, hands: { 0: [100, 101], 1: [undefined], 2: [undefined, undefined], 3: [undefined] }, result: result ?? null, kind: result ? "result" : undefined, actorSeat: result ? null : undefined });
  const partnerOf = (seat: number) => (pairing === "facing" ? seat ^ 1 : pairing === "across" ? (seat + 2) % 4 : null);
  const seats = base.view.seats.map((view) => {
    const gone = out.includes(view.seat);
    const next: typeof view = { ...view, lp: gone ? 0 : view.lp, hand: view.hand.map((card, sequence) => ({ ...card, sequence })) };
    if (gone) next.eliminated = true;
    if (leaving.includes(view.seat)) next.pendingElimination = true;
    if (pairing !== "unset") {
      const partner = partnerOf(view.seat);
      next.sharedExtraWith = !gone && partner != null && !out.includes(partner) ? partner : null;
    }
    return next;
  });
  return { ...base, view: { ...base.view, turnSeat, seats } } as ReplayFrameV2;
}

/** A frame that still carries the prompt the live table showed: the replay must not let anyone answer it. */
const withPrompt = (entry: ReplayFrameV2): ReplayFrameV2 => ({
  ...entry,
  view: { ...entry.view, prompt: { id: "p", seat: 0, kind: "choice", title: "Main Phase 1", options: [{ id: "to_ep", label: "End Phase" }] } },
} as unknown as ReplayFrameV2);

const replayOf = (format: "ffa3" | "ffa4", frames: ReplayFrameV2[], mySeat: number | null = 0) =>
  (visibility: "mine" | "public") => replayV2({ visibility, format: format as DuelFormat, frames, mySeat });

async function open() {
  render(<DuelReplayView slug="game-1" />);
  await screen.findByRole("group", { name: "Replay controls" });
}

const seatsOn = (selector: string) => [...document.querySelectorAll(selector)].map((node) => Number(node.getAttribute(selector.replace(/^\[|\]$/g, "")))).sort();
const lpSeats = () => seatsOn("[data-lp-seat]");
const handSeats = () => [...new Set(seatsOn("[data-hand-seat]"))];
const fieldSeats = () => seatsOn("[data-seat-field]");
const outSeats = () => [...document.querySelectorAll("[data-testid='seat-out']")].length;
const go = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const camera = (seat: number) => fireEvent.change(screen.getByRole("combobox", { name: "View from seat" }), { target: { value: String(seat) } });

/** 4 -> 3 -> 2 seats, with a pending loss between: step 0 all in, 1 seat 2 leaving, 2 seat 2 out, 3 seat 3 out, 4 seat 1 out (result). */
const FOUR_TO_TWO = (format: "ffa4" | "ffa3" = "ffa4") => [
  ffaFrame(format, 0),
  ffaFrame(format, 1, { leaving: [2] }),
  ffaFrame(format, 2, { out: [2] }),
  ffaFrame(format, 3, { out: [2, 3] }),
  ffaFrame(format, 4, { out: [1, 2, 3], result: { winnerSeat: 0, reason: "Last duelist standing" } }),
];

describe("lossOrderAt", () => {
  it("groups the seats by the first frame where they are out, earliest first", () => {
    const frames = FOUR_TO_TWO();
    expect(lossOrderAt(frames, 0)).toEqual([]);
    expect(lossOrderAt(frames, 2)).toEqual([[2]]);
    expect(lossOrderAt(frames, 3)).toEqual([[2], [3]]);
    expect(lossOrderAt(frames, 4)).toEqual([[2], [3], [1]]);
  });

  it("keeps a seat that is only leaving out of the order", () => {
    expect(lossOrderAt(FOUR_TO_TWO(), 1)).toEqual([]);
  });

  it("puts seats that lose in the same frame in one group", () => {
    expect(lossOrderAt([ffaFrame("ffa4", 0), ffaFrame("ffa4", 1, { out: [1, 3] })], 1)).toEqual([[1, 3]]);
  });

  it("gives the same order after a rewind as when playing there (it reads frames, not history)", () => {
    const frames = FOUR_TO_TWO();
    expect(lossOrderAt(frames, 3)).toEqual(lossOrderAt(frames.slice(0, 4), 3));
    expect(lossOrderAt(frames, 99)).toEqual(lossOrderAt(frames, 4));
    expect(lossOrderAt(frames, -3)).toEqual([]);
  });

  it("names the table kinds that use the table shell", () => {
    expect(isFfaFormat("ffa3") && isFfaFormat("ffa4")).toBe(true);
    expect(isFfaFormat("1v1") || isFfaFormat("tag")).toBe(false);
  });
});

describe("FFA replay: every field, every camera seat", () => {
  for (const format of ["ffa3", "ffa4"] as const) {
    const count = format === "ffa3" ? 3 : 4;
    const all = Array.from({ length: count }, (_, seat) => seat);

    it(`${format}: draws all ${count} fields, life plates and hands from every camera seat, on the same frame`, async () => {
      stubServer(replayOf(format, [ffaFrame(format, 0, { pairing: "facing" }), ffaFrame(format, 1, { pairing: "facing", turnSeat: 1 })]));
      await open();
      go("Next move");
      expect(screen.getByText("Move 1 / 1")).toBeTruthy();
      for (const seat of all) {
        camera(seat);
        expect(screen.getByText("Move 1 / 1")).toBeTruthy();
        expect(fieldSeats()).toEqual(all);
        expect(lpSeats()).toEqual(all);
        expect(handSeats()).toEqual(all);
        expect(document.querySelector("[data-table-shell]")).not.toBeNull();
        expect((screen.getByRole("combobox", { name: "View from seat" }) as HTMLSelectElement).value).toBe(String(seat));
      }
      // One read of the replay: a camera move asks the server for nothing.
      expect(calls).toHaveLength(1);
    });
  }

  it("offers every seat in the camera select and no opposite-seat select", async () => {
    stubServer(replayOf("ffa4", [ffaFrame("ffa4", 0), ffaFrame("ffa4", 1)]));
    await open();
    const options = [...(screen.getByRole("combobox", { name: "View from seat" }) as HTMLSelectElement).options].map((option) => option.textContent);
    expect(options).toEqual(["Ada", "Bo", "Cy", "Di"]);
    expect(screen.queryByRole("combobox", { name: "Across from" })).toBeNull();
  });

  it("draws the FFA3 plaza and the FFA4 grid, and reports the format on the frame wrapper", async () => {
    stubServer(replayOf("ffa4", [ffaFrame("ffa4", 0, { pairing: "facing" }), ffaFrame("ffa4", 1, { pairing: "facing" })]));
    await open();
    expect(document.querySelector("[data-replay-format='ffa4']")).not.toBeNull();
    expect(document.querySelector("[data-table-shell][data-grid='true']")).not.toBeNull();
    cleanup();
    stubServer(replayOf("ffa3", [ffaFrame("ffa3", 0), ffaFrame("ffa3", 1)]));
    await open();
    expect(document.querySelector("[data-replay-format='ffa3']")).not.toBeNull();
    expect(document.querySelector("[data-table-shell][data-grid='true']")).toBeNull();
  });

  it("works for a spectator (no seat of its own) and keeps the hidden hands hidden", async () => {
    stubServer(replayOf("ffa4", [ffaFrame("ffa4", 0, { pairing: "facing" }), ffaFrame("ffa4", 1, { pairing: "facing" })], null));
    await open();
    expect(fieldSeats()).toEqual([0, 1, 2, 3]);
    expect(screen.getByText("Public view — hidden cards stay hidden")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Card visibility" })).toBeNull();
  });
});

describe("FFA replay: the Extra Monster Zones come from the engine", () => {
  const zoneKeys = (seat: number) =>
    [...document.querySelector(`[data-seat-field="${seat}"]`)!.querySelectorAll("[data-zones]")].map((node) => node.getAttribute("data-zones") ?? "");

  it("shares one row between the facing seats (0+1, 2+3) and draws it once per pair", async () => {
    stubServer(replayOf("ffa4", [ffaFrame("ffa4", 0, { pairing: "facing" }), ffaFrame("ffa4", 1, { pairing: "facing" })]));
    await open();
    expect(document.querySelector("[data-table-shell][data-grid='true']")).not.toBeNull();
    // The shared row sits in the bottom field of a pair; the other field of the pair draws none of its own.
    expect(zoneKeys(0).some((key) => key.includes("0:4:5") && key.includes("1:4:6"))).toBe(true);
    expect(zoneKeys(3).some((key) => key.includes("3:4:5") && key.includes("2:4:6"))).toBe(true);
    expect(zoneKeys(1).some((key) => key.includes("1:4:5") && !key.includes("0:4:6"))).toBe(false);
  });

  it("does not draw the facing grid when the engine shares across (0+2, 1+3): the plaza shows all fields", async () => {
    stubServer(replayOf("ffa4", [ffaFrame("ffa4", 0, { pairing: "across" }), ffaFrame("ffa4", 1, { pairing: "across" })]));
    await open();
    expect(document.querySelector("[data-table-shell][data-grid='true']")).toBeNull();
    expect(fieldSeats()).toEqual([0, 1, 2, 3]);
    expect(lpSeats()).toEqual([0, 1, 2, 3]);
  });

  it("keeps the facing grid while one seat of a pair is out, and when it is out the partner has no shared row", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO().map((entry, step) => ffaFrame("ffa4", step, {
      pairing: "facing", out: entry.view.seats.filter((seat) => seat.eliminated).map((seat) => seat.seat),
      leaving: entry.view.seats.filter((seat) => seat.pendingElimination).map((seat) => seat.seat),
      result: entry.view.result ?? undefined,
    }))));
    await open();
    for (let i = 0; i < 4; i += 1) go("Next move");
    expect(screen.getByText("Move 4 / 4")).toBeTruthy();
    expect(document.querySelector("[data-table-shell][data-grid='true']")).not.toBeNull();
  });
});

describe("FFA replay: losses come from the selected frame", () => {
  it("shows a pending loss as leaving, not out, and places it only when the engine says it is out", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    go("Next move");
    expect(screen.getByText("Move 1 / 4")).toBeTruthy();
    expect(document.querySelector("[data-testid='seat-strip-leaving-2']")).not.toBeNull();
    expect(outSeats()).toBe(0);
    go("Next move");
    expect(document.querySelector("[data-testid='seat-strip-leaving-2']")).toBeNull();
    expect(outSeats()).toBe(1);
  });

  it("goes 4 -> 3 -> 2 as the frames go, in the order the seats lost", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    const stripOut = () => [...document.querySelectorAll("[data-testid^='seat-strip-'][data-eliminated='true']")].map((node) => Number(node.getAttribute("data-seat")));
    expect(stripOut()).toEqual([]);
    go("Last move");
    expect(screen.getByText("Move 4 / 4")).toBeTruthy();
    expect(stripOut()).toEqual([1, 2, 3]);
    expect(outSeats()).toBe(3);
    // The place of each loss: Cy (seat 2) first out, then Di, then Bo.
    const places = [...document.querySelectorAll("[data-testid='seat-out']")].map((node) => node.textContent ?? "");
    expect(places).toHaveLength(3);
    const text = (name: string) => places.find((line) => line.includes(name)) ?? "";
    expect(text("Cy")).toContain("4th");
    expect(text("Di")).toContain("3rd");
    expect(text("Bo")).toContain("2nd");
    // All four fields are still part of the table; the grid keeps the cells of the out seats.
    expect(fieldSeats().length).toBeGreaterThanOrEqual(1);
    expect(lpSeats()).toEqual([0, 1, 2, 3]);
  });

  it("rewinds: stepping back and seeking restore the seats that had not lost yet", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    go("Last move");
    expect(outSeats()).toBe(3);
    go("Previous move");
    expect(screen.getByText("Move 3 / 4")).toBeTruthy();
    expect(outSeats()).toBe(2);
    fireEvent.change(screen.getByRole("slider", { name: "Replay position" }), { target: { value: "2" } });
    expect(outSeats()).toBe(1);
    expect(document.querySelector("[data-testid='seat-strip-3'][data-eliminated='false']")).not.toBeNull();
    go("First move");
    expect(screen.getByText("Move 0 / 4")).toBeTruthy();
    expect(outSeats()).toBe(0);
    expect(document.querySelectorAll("[data-testid^='seat-strip-'][data-eliminated='true']")).toHaveLength(0);
    // And forward again lands on the same state as the first time.
    go("Last move");
    expect(outSeats()).toBe(3);
  });

  it("does not mark seats that were already out in a seek as fresh losses", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    go("Last move");
    expect(document.querySelectorAll("[data-testid='seat-out'][data-fresh='true']")).toHaveLength(0);
  });

  it("keeps the out seats and the camera seat on a camera change at a later frame", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    for (let i = 0; i < 3; i += 1) go("Next move");
    expect(outSeats()).toBe(2);
    camera(1);
    expect(screen.getByText("Move 3 / 4")).toBeTruthy();
    expect(outSeats()).toBe(2);
    camera(2);
    expect(outSeats()).toBe(2);
    expect(lpSeats()).toEqual([0, 1, 2, 3]);
  });

  it("does the same for FFA3 (3 -> 2)", async () => {
    stubServer(replayOf("ffa3", [
      ffaFrame("ffa3", 0),
      ffaFrame("ffa3", 1, { leaving: [1] }),
      ffaFrame("ffa3", 2, { out: [1] }),
      ffaFrame("ffa3", 3, { out: [1, 2], result: { winnerSeat: 0, reason: "Last duelist standing" } }),
    ], 0));
    await open();
    expect(outSeats()).toBe(0);
    go("Next move");
    expect(document.querySelector("[data-testid='seat-strip-leaving-1']")).not.toBeNull();
    go("Next move");
    expect(outSeats()).toBe(1);
    go("Next move");
    expect(outSeats()).toBe(2);
    expect(screen.getByText("Ada wins")).toBeTruthy();
    go("First move");
    expect(outSeats()).toBe(0);
  });
});

describe("FFA replay: narrow screens", () => {
  it("keeps the transport, every camera seat and every field on a phone-width screen", async () => {
    window.matchMedia = mediaStub(true);
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    expect(screen.getByTestId("replay-transport")).toBeTruthy();
    for (const seat of [0, 1, 2, 3]) {
      camera(seat);
      expect(lpSeats()).toEqual([0, 1, 2, 3]);
    }
    go("Last move");
    expect(outSeats()).toBe(3);
    expect(screen.getByText("Ada wins")).toBeTruthy();
  });

  it("does the same for FFA3", async () => {
    window.matchMedia = mediaStub(true);
    stubServer(replayOf("ffa3", [ffaFrame("ffa3", 0), ffaFrame("ffa3", 1)], 0));
    await open();
    expect(screen.getByTestId("replay-transport")).toBeTruthy();
    expect(lpSeats()).toEqual([0, 1, 2]);
  });
});

describe("FFA replay: read only", () => {
  it("never sends an action, a seat claim or a reveal: only GETs of the replay", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    go("Next move");
    camera(2);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: " " });
    fireEvent.click(screen.getByRole("button", { name: "Public" }));
    await screen.findByRole("group", { name: "Replay controls" });
    for (const call of calls) {
      expect(call.url.pathname).toBe("/api/duels/game-1/replay");
      expect((call.init?.method ?? "GET").toUpperCase()).toBe("GET");
    }
    expect(calls.map((call) => call.url.searchParams.get("visibility"))).toEqual(["mine", "public"]);
  });

  it("offers no live control: no surrender, no clock, no prompt answer, nothing legal to click", async () => {
    stubServer(replayOf("ffa4", [
      ffaFrame("ffa4", 0, { pairing: "facing" }),
      withPrompt(ffaFrame("ffa4", 1, { pairing: "facing" })),
    ], 0));
    await open();
    go("Next move");
    expect(screen.queryByRole("button", { name: /surrender/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "End Phase" })).toBeNull();
    expect(document.querySelectorAll("[data-legal='true']")).toHaveLength(0);
    expect(document.querySelector("[data-testid='prompt-dock'][data-mode='answer']")).toBeNull();
    expect(calls.every((call) => (call.init?.method ?? "GET").toUpperCase() === "GET")).toBe(true);
  });

  it("keeps the transport keys working over the table", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Move 1 / 4")).toBeTruthy();
    fireEvent.keyDown(window, { key: "End" });
    expect(screen.getByText("Move 4 / 4")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("Move 3 / 4")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Home" });
    expect(screen.getByText("Move 0 / 4")).toBeTruthy();
  });

  it("keeps the replay in the address and reloads to the same frame and the same losses", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    go("Next move"); go("Next move"); go("Next move");
    await waitFor(() => expect(window.location.search).toBe("?frame=f3"));
    cleanup();
    await open();
    expect(screen.getByText("Move 3 / 4")).toBeTruthy();
    expect(outSeats()).toBe(2);
  });

  it("plays on a timer across a loss", async () => {
    stubServer(replayOf("ffa4", FOUR_TO_TWO(), 0));
    await open();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      for (let i = 0; i < 3; i += 1) act(() => { vi.advanceTimersByTime(1400); });
      expect(screen.getByText("Move 3 / 4")).toBeTruthy();
      expect(outSeats()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
