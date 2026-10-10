// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelCard, DuelReplayV2, ReplayFrameV2, ReplayVisibility } from "@yugidraft/shared/duels";
import { resetCoinTossState } from "@/components/duel/coin-toss-lock";
import { frame, replayV2 } from "./replay-fixtures";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

import { DuelReplayView } from "@/components/duel/replay";

const NAMES = ["Ada", "Bo", "Cy", "Di"];
/** Seat 0 is the viewer (Ada, team 1 with Cy). Bo and Di are team 2. */
const MY_SEAT = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const code = (value: number, seat: number, sequence: number): DuelCard => ({ controller: seat, location: 2, sequence, position: 1, code: value, name: `Card ${value}` });
const hidden = (seat: number, sequence: number): DuelCard => ({ controller: seat, location: 2, sequence, position: 1 });

/**
 * A Tag frame the way the server projects it. "mine": the viewer sees their own hand and Extra Deck and their partner's
 * hand; every other hand and Extra Deck is hidden (codeless). "public": nothing is shown.
 */
function tagFrame(step: number, visibility: ReplayVisibility, over: { lp?: [number, number]; kind?: ReplayFrameV2["kind"]; actorSeat?: number | null; result?: ReplayFrameV2["view"]["result"] } = {}): ReplayFrameV2 {
  const base = frame({ step, format: "tag", kind: over.kind, actorSeat: over.actorSeat, result: over.result });
  const lp = over.lp ?? [8000, 8000];
  const open = visibility === "mine";
  const handCodes: Record<number, number[]> = { 0: [100, 101], 2: [200, 201], 1: [300, 301], 3: [400, 401] };
  const extraCodes: Record<number, number[]> = { 0: [9001, 9002], 1: [9101], 2: [9201], 3: [9301] };
  base.view.seats = base.view.seats.map((seat) => {
    const shown = open && (seat.seat === MY_SEAT || seat.seat === (MY_SEAT + 2) % 4);
    const own = open && seat.seat === MY_SEAT;
    return {
      ...seat,
      team: seat.seat % 2,
      lp: lp[seat.seat % 2],
      sharedExtraWith: seat.seat % 2 === 0 ? seat.seat + 1 : seat.seat - 1,
      hand: handCodes[seat.seat].map((value, i) => (shown ? code(value, seat.seat, i) : hidden(seat.seat, i))),
      extra: extraCodes[seat.seat].map((value, i) => (own ? { ...code(value, seat.seat, i), location: 64 } : { ...hidden(seat.seat, i), location: 64 })),
      extraCount: extraCodes[seat.seat].length,
    };
  });
  return base;
}

function replay(visibility: ReplayVisibility): DuelReplayV2 {
  return replayV2({
    visibility, format: "tag", mySeat: MY_SEAT,
    sessionOver: { winnerSeat: 1, resultReason: "LP 0" },
    frames: [
      tagFrame(0, visibility),
      tagFrame(1, visibility, { actorSeat: 0 }),
      tagFrame(2, visibility, { actorSeat: 3, lp: [8000, 5000] }),
      tagFrame(3, visibility, { kind: "result", actorSeat: null, lp: [0, 5000], result: { winnerSeat: 1, winnerTeam: 1, reason: "LP 0" } }),
    ],
  });
}

let requests: URL[];
function stubServer() {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    // Card lookups of the inspector: no data, no error.
    if (!url.pathname.includes("/replay")) return json({ cards: [] });
    requests.push(url);
    return json(replay(url.searchParams.get("visibility") === "public" ? "public" : "mine"));
  }));
}

function mediaStub(narrow: boolean) {
  return (query: string) => ({ matches: narrow && query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
}

beforeAll(() => {
  class RO {
    constructor(private cb: () => void) {}
    observe() { this.cb(); }
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  HTMLElement.prototype.getAnimations = () => [];
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1100 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 860 });
});
beforeEach(() => {
  resetCoinTossState();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/duels/game-1/replay");
  vi.stubGlobal("matchMedia", mediaStub(false));
  stubServer();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetCoinTossState(); });

async function open(container?: { narrow?: boolean }) {
  if (container?.narrow) vi.stubGlobal("matchMedia", mediaStub(true));
  const view = render(<DuelReplayView slug="game-1" />);
  await screen.findByRole("group", { name: "Replay controls" });
  return view;
}
const camera = (seat: number) => act(() => void fireEvent.change(screen.getByRole("combobox", { name: "View from seat" }), { target: { value: String(seat) } }));
const click = (name: string) => act(() => void fireEvent.click(screen.getByRole("button", { name })));
const plates = () => [...document.querySelectorAll<HTMLElement>("[data-team-plate]")];
const handSeat = (selector: string) => document.querySelector<HTMLElement>(selector)?.getAttribute("data-hand-seat");
const html = () => document.body.innerHTML;

describe("Tag replay page", () => {
  it("draws the Rooftop table in replay mode, read-only, with four seats and the shared Extra Monster zones", async () => {
    const { container } = await open();
    const root = container.querySelector<HTMLElement>("[data-table-shell='tag']")!;
    expect(root).not.toBeNull();
    expect(root.getAttribute("data-can-act")).toBe("false");
    expect(container.querySelectorAll("[data-seat-field]")).toHaveLength(4);
    expect(container.querySelector("[data-replay-label]")?.textContent).toBe("Replay");
    expect(container.querySelector("[data-prompt-panel], [data-prompt-tray]")).toBeNull();
    expect(screen.getByTestId("shared-emz-pair-0-1")).toBeTruthy();
    expect(screen.getByTestId("shared-emz-pair-2-3")).toBeTruthy();
    // Nothing of the two-seat page is left.
    expect(container.querySelector("[aria-label='Opposite seat']")).toBeNull();
    expect(screen.queryByText(/Two seats are drawn at a time/)).toBeNull();
  });

  it("shows each team once, with its shared LP, and the members on the plate", async () => {
    await open();
    expect(plates()).toHaveLength(2);
    const names = plates().map((plate) => plate.querySelector("[data-team-name]")?.textContent);
    expect([...names].sort()).toEqual(["Team 1", "Team 2"]);
    const near = plates().find((plate) => plate.getAttribute("data-team-plate") === "near")!;
    expect(near.querySelector("[data-team-name]")?.textContent).toBe("Team 1");
    expect(near.textContent).toContain("Ada");
    expect(near.textContent).toContain("Cy");
    expect(near.textContent).not.toContain("Bo");
    // One LP chip per seat, four in all; the team LP itself is drawn once per plate.
    expect(document.querySelectorAll("[data-lp-seat]")).toHaveLength(4);
    click("Next move");
    click("Next move");
    const far = plates().find((plate) => plate.getAttribute("data-team-plate") === "far")!;
    expect(far.textContent).toMatch(/5,?000/);
    expect(near.textContent).toMatch(/8,?000/);
    expect(document.body.textContent!.match(/5,?000/g)?.length ?? 0).toBe(1);
  });

  it.each([0, 1, 2, 3])("camera on seat %i draws that seat at home with its partner beside it, and team names follow", async (seat) => {
    await open();
    camera(seat);
    await waitFor(() => expect(handSeat("[data-hand-seat][data-side='you']")).toBe(String(seat)));
    expect(handSeat("[data-partner-hand]")).toBe(String((seat + 2) % 4));
    const near = plates().find((plate) => plate.getAttribute("data-team-plate") === "near")!;
    expect(near.querySelector("[data-team-name]")?.textContent).toBe(`Team ${(seat % 2) + 1}`);
    // The camera seat is not "you": the replay viewer is not a player at that seat.
    expect(document.querySelector("[data-team-plate]")!.textContent).not.toContain("YOU");
    expect(document.querySelector("[data-partner-caption]")!.textContent).not.toMatch(/only your team/);
    expect(screen.getByRole("combobox", { name: "View from seat" })).toHaveProperty("value", String(seat));
    // The camera never asked the server for anything.
    expect(requests).toHaveLength(1);
  });

  it("keeps the frame and the moves when the camera changes", async () => {
    await open();
    click("Next move");
    click("Next move");
    camera(3);
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(screen.getByText("Di acted")).toBeTruthy();
  });
});

describe("Tag replay card visibility", () => {
  it("shows the cards the server sent for the viewer and the partner, and no others", async () => {
    await open();
    const dock = document.querySelector<HTMLElement>("[data-hand-dock]")!;
    expect(within(dock).getByRole("button", { name: "Card 100" })).toBeTruthy();
    const partner = document.querySelector<HTMLElement>("[data-partner-hand]")!;
    expect(within(partner).getByRole("button", { name: "Card 200" })).toBeTruthy();
    expect(html()).not.toMatch(/Card (300|301|400|401|9101|9201|9301)\b/);
  });

  it("does not reveal a rival's hand or Extra Deck when the camera moves to that seat", async () => {
    await open();
    camera(1);
    await waitFor(() => expect(handSeat("[data-hand-seat][data-side='you']")).toBe("1"));
    expect(html()).not.toMatch(/Card (300|301|400|401|9101|9301)\b/);
    camera(0);
    await waitFor(() => expect(handSeat("[data-hand-seat][data-side='you']")).toBe("0"));
    expect(requests).toHaveLength(1);
  });

  it("keeps the private Extra Deck private: the viewer's pile opens, a rival's pile shows backs only", async () => {
    await open();
    const pile = (seat: number) => document.querySelector<HTMLElement>(`[data-seat-field='${seat}'] [data-pile][data-kind='extra'] button, [data-field-hold='${seat}'] [data-pile][data-kind='extra'] button`);
    const own = pile(0);
    expect(own).not.toBeNull();
    act(() => void fireEvent.click(own!));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Card 9001/);
    act(() => void fireEvent.keyDown(window, { key: "Escape" }));
    const rival = pile(1);
    expect(rival).not.toBeNull();
    act(() => void fireEvent.click(rival!));
    expect(document.body.textContent).not.toMatch(/Card 9101/);
  });

  it("switches to the public view with a new request, the same frame and camera, and no card names", async () => {
    await open();
    click("Next move");
    click("Next move");
    camera(1);
    click("Public");
    await waitFor(() => expect(document.querySelector("[data-replay-visibility='public']")).not.toBeNull());
    expect(requests.map((url) => url.searchParams.get("visibility"))).toEqual(["mine", "public"]);
    expect(screen.getByText("Di acted")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "View from seat" })).toHaveProperty("value", "1");
    expect(html()).not.toMatch(/Card \d{3,}/);
    expect(screen.getByText(/Public view/)).toBeTruthy();
    // Back to the viewer's cards: the partner's hand is there again for a camera on seat 0.
    click("My cards");
    await waitFor(() => expect(document.querySelector("[data-replay-visibility='mine']")).not.toBeNull());
    camera(0);
    await waitFor(() => expect(document.querySelector("[data-partner-hand]")?.textContent).toBeTruthy());
    expect(html()).toMatch(/Card 200/);
  });
});

describe("Tag replay result and rewind", () => {
  it("shows the result once at the last frame and removes it on the way back", async () => {
    await open();
    expect(document.querySelector("[data-replay-result]")).toBeNull();
    click("Last move");
    const results = document.querySelectorAll("[data-replay-result]");
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toContain("Team 2 wins · Bo & Di");
    expect(results[0].textContent).toContain("LP 0");
    expect(screen.getByText("Final result")).toBeTruthy();
    // The live shell's result screen stays away.
    expect(document.querySelector("[data-placings], [role='dialog'][aria-label='Duel result']")).toBeNull();
    const near = plates().find((plate) => plate.getAttribute("data-team-plate") === "near")!;
    expect(near.getAttribute("data-cracked")).toBe("true");
    click("Previous move");
    expect(document.querySelector("[data-replay-result]")).toBeNull();
    expect(plates().every((plate) => plate.getAttribute("data-cracked") == null)).toBe(true);
    expect(plates().find((plate) => plate.getAttribute("data-team-plate") === "near")!.textContent).toMatch(/8,?000/);
    click("First move");
    expect(screen.getByText("Opening board")).toBeTruthy();
  });

  it("plays from the result again from the start", async () => {
    await open();
    click("Last move");
    click("Play");
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByText("Opening board")).toBeTruthy();
    expect(document.querySelector("[data-replay-result]")).toBeNull();
  });
});

describe("Tag replay on a narrow screen", () => {
  it("keeps one transport, the view controls and the team plates", async () => {
    const { container } = await open({ narrow: true });
    expect(container.querySelectorAll("[data-testid='replay-transport']")).toHaveLength(1);
    expect(screen.getAllByRole("group", { name: "Replay controls" })).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "View from seat" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Card visibility" })).toBeTruthy();
    expect(plates().length).toBeGreaterThan(0);
    camera(2);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "View from seat" })).toHaveProperty("value", "2"));
    click("Last move");
    expect(container.querySelectorAll("[data-replay-result]")).toHaveLength(1);
  });
});
