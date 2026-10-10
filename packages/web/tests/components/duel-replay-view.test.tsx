// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelEngineView, DuelFormat, DuelReplayV2 } from "@yugidraft/shared/duels";
import { resetCoinTossState } from "@/components/duel/coin-toss-lock";
import { frame, replayV1, replayV2 } from "./replay-fixtures";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

interface FieldProps {
  engine: DuelEngineView;
  mySeat: number | null;
  bottomSeat?: number | null;
  topSeat?: number | null;
  bottomName: string;
  topName: string;
}
const field = vi.hoisted(() => ({ last: null as unknown }));
const lastField = () => field.last as FieldProps;

// The board is a stub that prints what the replay hands it; the real field is covered by its own tests.
vi.mock("@/components/duel/field", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/duel/field")>();
  return {
    ...actual,
    DuelField: (props: FieldProps) => {
      field.last = props;
      const bottom = props.engine.seats.find((seat) => seat.seat === (props.bottomSeat ?? props.mySeat ?? 0));
      return (
        <div data-testid="field" data-bottom={props.bottomSeat ?? props.mySeat ?? 0} data-top={props.topSeat ?? ""}
          data-spectator={props.mySeat == null ? "true" : "false"}>
          <span data-testid="bottom-name">{props.bottomName}</span>
          <span data-testid="top-name">{props.topName}</span>
          <span data-testid="bottom-hand">{bottom?.hand.map((card) => card.code ?? "back").join(",")}</span>
        </div>
      );
    },
  };
});

import { DuelReplayView } from "@/components/duel/replay";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Pending { url: URL; init?: RequestInit; resolve: (response: Response) => void }
let calls: Pending[];

/** Answers every replay request with `answer(url)` at once, unless `hold` keeps it for the test to release. */
function stubServer(answer: (url: URL) => Response | Promise<Response>, hold = false) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => new Promise<Response>((resolve) => {
    const url = new URL(input, "http://localhost");
    calls.push({ url, init, resolve });
    if (!hold) void Promise.resolve(answer(url)).then(resolve);
  })));
}

beforeEach(() => {
  resetCoinTossState();
  window.history.replaceState(null, "", "/duels/game-1/replay");
  window.matchMedia = window.matchMedia ?? ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetCoinTossState(); });

const byVisibility = (build: (visibility: "mine" | "public") => DuelReplayV2) =>
  (url: URL) => json(build(url.searchParams.get("visibility") === "public" ? "public" : "mine"));

async function open(slug = "game-1") {
  render(<DuelReplayView slug={slug} />);
  await screen.findByRole("group", { name: "Replay controls" });
}

describe("DuelReplayView transport", () => {
  it("steps, seeks and plays through the frames", async () => {
    stubServer(byVisibility((visibility) => replayV2({ visibility })));
    await open();
    expect(screen.getByText("Move 0 / 3")).toBeTruthy();
    expect(screen.getByText("Opening board")).toBeTruthy();
    const first = screen.getByRole("button", { name: "First move" }) as HTMLButtonElement;
    const previous = screen.getByRole("button", { name: "Previous move" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next move" }) as HTMLButtonElement;
    const lastButton = screen.getByRole("button", { name: "Last move" }) as HTMLButtonElement;
    expect(first.disabled && previous.disabled).toBe(true);
    fireEvent.click(next);
    expect(screen.getByText("Move 1 / 3")).toBeTruthy();
    fireEvent.click(next);
    expect(screen.getByText("Bo acted")).toBeTruthy();
    fireEvent.click(lastButton);
    expect(screen.getByText("Move 3 / 3")).toBeTruthy();
    expect(screen.getByText("Final result")).toBeTruthy();
    expect(screen.getByText("Ada wins")).toBeTruthy();
    expect(next.disabled && lastButton.disabled).toBe(true);
    fireEvent.click(previous);
    expect(screen.getByText("Move 2 / 3")).toBeTruthy();
    expect(screen.queryByText("Ada wins")).toBeNull();
    fireEvent.change(screen.getByRole("slider", { name: "Replay position" }), { target: { value: "1" } });
    expect(screen.getByText("Move 1 / 3")).toBeTruthy();
    fireEvent.click(first);
    expect(screen.getByText("Move 0 / 3")).toBeTruthy();
  });

  it("plays on a timer", async () => {
    stubServer(byVisibility((visibility) => replayV2({ visibility })));
    await open();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1400); });
      expect(screen.getByText("Move 1 / 3")).toBeTruthy();
      fireEvent.change(screen.getByRole("combobox", { name: "Playback speed" }), { target: { value: "4" } });
      act(() => { vi.advanceTimersByTime(350); });
      expect(screen.getByText("Move 2 / 3")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the transport keys and leaves them alone inside a dialog", async () => {
    stubServer(byVisibility((visibility) => replayV2({ visibility })));
    await open();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Move 1 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "End" });
    expect(screen.getByText("Move 3 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Home" });
    expect(screen.getByText("Move 0 / 3")).toBeTruthy();
    // A focused field keeps its own keys.
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Playback speed" }), { key: "ArrowRight" });
    expect(screen.getByText("Move 0 / 3")).toBeTruthy();
    document.body.insertAdjacentHTML("beforeend", `<div role="dialog" aria-modal="true"><button id="in-dialog">Close</button></div>`);
    fireEvent.keyDown(document.getElementById("in-dialog")!, { key: "ArrowRight", bubbles: true });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Move 0 / 3")).toBeTruthy();
  });

  it("keeps the selected frame in the address and returns to it after a reload", async () => {
    stubServer(byVisibility((visibility) => replayV2({ visibility })));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    await waitFor(() => expect(window.location.search).toBe("?frame=f2"));
    cleanup();
    await open();
    expect(screen.getByText("Move 2 / 3")).toBeTruthy();
  });
});

describe("DuelReplayView requests and live actions", () => {
  it("only reads: one GET with version and visibility, and no seat, reveal or action calls", async () => {
    stubServer(byVisibility((visibility) => replayV2({ visibility })));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    fireEvent.change(screen.getByRole("combobox", { name: "View from seat" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Public" }));
    await screen.findByRole("group", { name: "Replay controls" });
    for (const call of calls) {
      expect(call.url.pathname).toBe("/api/duels/game-1/replay");
      expect([...call.url.searchParams.keys()].sort()).toEqual(["version", "visibility"]);
      expect((call.init?.method ?? "GET").toUpperCase()).toBe("GET");
    }
    expect(calls.map((call) => call.url.searchParams.get("visibility"))).toEqual(["mine", "public"]);
    expect(calls.every((call) => !call.url.pathname.includes("/actions"))).toBe(true);
  });

  it("works against a server that only knows the v1 answer, with no card-view switch offered", async () => {
    stubServer(() => json(replayV1()));
    await open();
    expect(screen.getByText("Move 0 / 3")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Card visibility" })).toBeNull();
  });
});

describe("DuelReplayView camera and card visibility", () => {
  it("moves the camera without changing the frame or the cards the server sent", async () => {
    stubServer(byVisibility((visibility) => replayV2({ visibility })));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    expect(lastField().mySeat).toBe(0);
    expect(screen.getByTestId("bottom-hand").textContent).toBe("100,101");
    fireEvent.change(screen.getByRole("combobox", { name: "View from seat" }), { target: { value: "1" } });
    expect(screen.getByText("Move 1 / 3")).toBeTruthy();
    expect(screen.getByTestId("field").dataset.bottom).toBe("1");
    expect(screen.getByTestId("field").dataset.spectator).toBe("true");
    expect(screen.getByTestId("bottom-name").textContent).toBe("Bo");
    expect(screen.getByTestId("top-name").textContent).toBe("Ada");
    expect(calls).toHaveLength(1);
    // Back on the viewer's own seat the board is theirs again.
    fireEvent.change(screen.getByRole("combobox", { name: "View from seat" }), { target: { value: "0" } });
    expect(screen.getByTestId("field").dataset.spectator).toBe("false");
  });

  it("keeps the same frame when the camera moves in a four-seat game and offers every seat", async () => {
    stubServer(byVisibility((visibility) => replayV2({ visibility, format: "ffa4", frames: [
      frame({ step: 0, format: "ffa4" }), frame({ step: 1, format: "ffa4", actorSeat: 2 }), frame({ step: 2, format: "ffa4", actorSeat: 3 }),
    ] })));
    await open();
    expect(screen.getByText(/4-player FFA/)).toBeTruthy();
    expect(within(screen.getByRole("combobox", { name: "View from seat" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["Ada", "Bo", "Cy", "Di"]);
    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    fireEvent.change(screen.getByRole("combobox", { name: "View from seat" }), { target: { value: "3" } });
    expect(screen.getByText("Move 2 / 2")).toBeTruthy();
    expect(screen.getByText("Di acted")).toBeTruthy();
    expect(screen.getByTestId("field").dataset.bottom).toBe("3");
    expect(screen.getByTestId("field").dataset.top).toBe("0");
    fireEvent.change(screen.getByRole("combobox", { name: "Opposite seat" }), { target: { value: "2" } });
    expect(screen.getByTestId("field").dataset.top).toBe("2");
    expect(screen.getByTestId("top-name").textContent).toBe("Cy");
  });

  it("names a team in a Tag result", async () => {
    stubServer(byVisibility((visibility) => replayV2({ visibility, format: "tag", frames: [
      frame({ step: 0, format: "tag" }),
      frame({ step: 1, format: "tag", kind: "result", actorSeat: null, result: { winnerSeat: 1, winnerTeam: 1, reason: "LP 0" } }),
    ] })));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Last move" }));
    expect(screen.getByText(/Team 2 wins/)).toBeTruthy();
  });

  it("public view hides the cards, keeps the frame and the camera, and clears the inspector", async () => {
    stubServer(byVisibility((visibility) => replayV2({
      visibility,
      frames: [0, 1, 2, 3].map((step) => frame({
        step, hands: { 0: visibility === "public" ? [undefined, undefined] : [100, 101] },
        kind: step === 3 ? "result" : undefined, actorSeat: step === 0 || step === 3 ? null : 0,
      })),
    })));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    fireEvent.change(screen.getByRole("combobox", { name: "View from seat" }), { target: { value: "1" } });
    expect(screen.getByTestId("field").dataset.bottom).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Public" }));
    await waitFor(() => expect(document.querySelector("[data-replay-visibility='public']")).not.toBeNull());
    expect(screen.getByText("Move 2 / 3")).toBeTruthy();
    expect(screen.getByTestId("field").dataset.bottom).toBe("1");
    fireEvent.change(screen.getByRole("combobox", { name: "View from seat" }), { target: { value: "0" } });
    expect(screen.getByTestId("bottom-hand").textContent).toBe("back,back");
    expect(screen.getByText(/hidden cards stay hidden/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Public" })).getAttribute("aria-pressed")).toBe("true");
    // And back to the viewer's own cards.
    fireEvent.click(screen.getByRole("button", { name: "My cards" }));
    await waitFor(() => expect(document.querySelector("[data-replay-visibility='mine']")).not.toBeNull());
    expect(screen.getByText("Move 2 / 3")).toBeTruthy();
    expect(screen.getByTestId("bottom-hand").textContent).toBe("100,101");
  });

  it("never shows the old card view while the public one loads", async () => {
    let release: (() => void) | null = null;
    calls = [];
    vi.stubGlobal("fetch", vi.fn((input: string) => new Promise<Response>((resolve) => {
      const url = new URL(input, "http://localhost");
      const visibility = url.searchParams.get("visibility") === "public" ? "public" : "mine";
      const respond = () => resolve(json(replayV2({ visibility })));
      if (visibility === "public") release = respond; else respond();
    })));
    await open();
    expect(screen.getByTestId("bottom-hand").textContent).toBe("100,101");
    fireEvent.click(screen.getByRole("button", { name: "Public" }));
    expect(screen.queryByTestId("field")).toBeNull();
    expect(screen.getByText("Loading replay…")).toBeTruthy();
    await act(async () => { release?.(); });
    await screen.findByTestId("field");
    expect(screen.getByText("Move 0 / 3")).toBeTruthy();
  });

  it("falls back to the cards on screen and says so when the switch fails", async () => {
    stubServer((url) => url.searchParams.get("visibility") === "public"
      ? json({ error: "Public view is busy.", code: "ENGINE_BUSY" }, 503) : json(replayV2()));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Public" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toMatch(/busy/i);
    await waitFor(() => expect(screen.getByRole("button", { name: "My cards" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("Move 0 / 3")).toBeTruthy();
  });

  it("offers no card switch to a viewer with no seat", async () => {
    stubServer((url) => json(replayV2({ visibility: "public", mySeat: null, sessionOver: { name: String(url.pathname) } })));
    await open();
    expect(screen.queryByRole("group", { name: "Card visibility" })).toBeNull();
    expect(screen.getByText(/hidden cards stay hidden/)).toBeTruthy();
    expect(screen.getByTestId("field").dataset.spectator).toBe("true");
  });
});

describe("DuelReplayView failures", () => {
  const failing = (format: DuelFormat, body: Record<string, unknown>, status = 409) => stubServer(() => json({ ...body, format }, status));

  it("says why an old game cannot run and links the saved final board", async () => {
    failing("1v1", { code: "ENGINE_UNAVAILABLE_FOR_SOURCE", error: "gone", finalBoard: "available" });
    render(<DuelReplayView slug="game-1" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no longer installed/);
    expect((screen.getByRole("link", { name: "Final board" }) as HTMLAnchorElement).getAttribute("href")).toBe("/duels/game-1");
  });

  it("hides the final board link when the server has none", async () => {
    failing("1v1", { code: "NOT_PLAYABLE", error: "nope", finalBoard: "none" });
    render(<DuelReplayView slug="game-1" />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("link", { name: "Final board" })).toBeNull();
    expect(screen.getByRole("link", { name: "Match history" })).toBeTruthy();
  });

  it("keeps an old server's message and final board link", async () => {
    stubServer(() => json({ error: "Replay is not available for this duel." }, 409));
    render(<DuelReplayView slug="game-1" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Replay is not available for this duel.");
    expect(screen.getByRole("link", { name: "Final board" })).toBeTruthy();
  });

  it("says when a replay has no moves", async () => {
    stubServer(() => json(replayV2({ frames: [] })));
    render(<DuelReplayView slug="game-1" />);
    expect((await screen.findByRole("alert")).textContent).toBe("This replay has no recorded moves.");
  });
});
