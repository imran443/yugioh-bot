// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelEvent } from "@yugidraft/shared/duels";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

import { FFA3_FIXTURES } from "@/components/duel/table/fixtures/ffa3";
import { FFA4_FIXTURES } from "@/components/duel/table/fixtures/ffa4";
import type { TableFixtureSet } from "@/components/duel/table/fixtures/common";
import { useFixtureController } from "@/components/duel/table/fixtures/use-fixture-controller";
import { readOnlyReplayController, replayFrameStatus } from "@/components/duel/table/replay-mode";
import { TableShell, type TableShellProps } from "@/components/duel/table/table-shell";
import type { TableController } from "@/components/duel/table/types";
import { TAG_FIXTURES, TAG_TEAM_NAMES } from "@/components/duel/tag/fixtures";
import { TagShell } from "@/components/duel/tag/tag-shell";

function mediaStub(narrow: boolean) {
  return (query: string) => ({ matches: narrow && query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {} });
}

beforeAll(() => {
  class RO {
    constructor(private cb: () => void) {}
    observe() { this.cb(); }
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1100 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 860 });
});
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", mediaStub(false));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Kind = "table" | "tag";
const CASES: ReadonlyArray<readonly [string, TableFixtureSet, Kind]> = [
  ["FFA3 TableShell", FFA3_FIXTURES, "table"],
  ["FFA4 TableShell", FFA4_FIXTURES, "table"],
  ["Tag TagShell", TAG_FIXTURES, "tag"],
];

interface ViewProps {
  set: TableFixtureSet;
  kind: Kind;
  id?: string;
  resetKey?: number;
  more?: DuelEvent[];
  reducedMotion?: boolean;
  tweak?: (controller: TableController) => TableController;
  tools?: React.ReactNode;
  shell?: Partial<TableShellProps>;
}

function View({ set, kind, id = "main", resetKey = 0, more, reducedMotion = true, tweak, tools, shell }: ViewProps) {
  const state = set.states[id as keyof typeof set.states] ?? set.extra?.[id];
  const base = useFixtureController(state, { reducedMotion });
  let controller = base;
  if (more) controller = { ...controller, engine: { ...controller.engine, events: [...controller.engine.events, ...more] } };
  if (tweak) controller = tweak(controller);
  const replay = { transport: <div data-testid="transport-body">Transport</div>, resetKey, tools };
  return kind === "tag"
    ? <TagShell controller={controller} teamNames={[...TAG_TEAM_NAMES] as [string, string]} replay={replay} {...shell} />
    : <TableShell controller={controller} replay={replay} {...shell} />;
}

const press = (key: string) => act(() => void fireEvent.keyDown(window, { key }));
const fixtureAnswers = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((call) => call[0] === "[table-preview] answer");

describe("readOnlyReplayController", () => {
  it("strips every way to act, whatever controller it gets", () => {
    const onAnswer = vi.fn();
    const onAim = vi.fn();
    const onInspect = vi.fn();
    const onActivate = vi.fn();
    const onHoverCard = vi.fn();
    const state = FFA3_FIXTURES.states.main;
    const engine = state.room.engine!;
    const live = {
      room: { ...state.room, clock: { seats: [] } as never, series: { id: 1 } as never, inviteCode: "ABCDE" },
      engine,
      viewerSeat: 0,
      nameOf: (seat: number) => `P${seat}`,
      prompt: engine.prompt,
      promptSeat: 0,
      canAct: true,
      busy: true,
      offline: true,
      revealed: true,
      draft: {} as never,
      legalKeys: new Set(["a"]),
      selectedKeys: new Set(["b"]),
      aim: { from: "a", to: null } as never,
      seatPick: { onPick: () => {} } as never,
      reducedMotion: true,
      onAnswer,
      onActivate,
      onInspect,
      onHoverCard,
      onAim,
      attackAim: {} as never,
    } as TableController;
    const safe = readOnlyReplayController(live);
    safe.onAnswer({ choice: "x" });
    safe.onAim?.(null);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onAim).not.toHaveBeenCalled();
    expect(safe).toMatchObject({ prompt: null, promptSeat: null, canAct: false, busy: false, offline: false, revealed: false, aim: null, seatPick: null, attackAim: null });
    expect(safe.legalKeys.size).toBe(0);
    expect(safe.selectedKeys.size).toBe(0);
    expect(safe.engine.prompt).toBeNull();
    expect(safe.room.clock).toBeNull();
    expect(safe.room.series).toBeNull();
    expect(safe.room.inviteCode).toBeUndefined();
    expect(safe.viewerSeat).toBe(0);
    // Inspection and the camera seat stay.
    expect(safe.onInspect).toBe(onInspect);
    expect(safe.onHoverCard).toBe(onHoverCard);
    expect(safe.onActivate).toBe(onActivate);
  });

  it("reads a frame as finished only when the frame has the result", () => {
    expect(replayFrameStatus("completed", { result: null })).toBe("active");
    expect(replayFrameStatus("completed", { result: { winnerSeat: 0, reason: "lp" } })).toBe("completed");
    expect(replayFrameStatus("interrupted", { result: { winnerSeat: null, reason: "x" } })).toBe("interrupted");
    expect(replayFrameStatus("active", { result: { winnerSeat: 0, reason: "lp" } })).toBe("completed");
  });
});

describe.each(CASES)("%s in replay mode", (_name, set, kind) => {
  it("cannot answer, even when the controller still has a prompt and says it can act", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const onAnswer = vi.fn();
    const { container } = render(<View set={set} kind={kind} tweak={(controller) => ({ ...controller, canAct: true, onAnswer })} />);
    const root = container.querySelector("[data-table-shell]") as HTMLElement;
    expect(root.getAttribute("data-can-act")).toBe("false");
    expect(container.querySelector("button[aria-label='Battle Phase']")).toBeNull();
    expect(container.querySelector("[data-prompt-panel], [data-prompt-tray]")).toBeNull();
    for (const key of ["Enter", "Escape", "y", "n", "1"]) press(key);
    for (const button of container.querySelectorAll<HTMLButtonElement>("nav button")) act(() => void fireEvent.click(button));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(fixtureAnswers(info)).toHaveLength(0);
  });

  it("draws no surrender, exit, series, clock, connection or result control", () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const { container, queryByText } = render(
      <View
        set={set}
        kind={kind}
        id="result"
        tools={<button type="button">Jump in</button>}
        shell={{
          headerTools: <button type="button">Surrender</button>,
          settingsTools: <button type="button">Settings tool</button>,
          modals: <div data-testid="room-modal" />,
          actions: { onExit },
          connection: { connected: true, syncing: false, recovering: false, presence: null, resync: async () => {} } as never,
        }}
      />,
    );
    act(() => void vi.advanceTimersByTime(3000));
    expect(queryByText("Surrender")).toBeNull();
    expect(queryByText("Exit duel")).toBeNull();
    expect(queryByText("Show result")).toBeNull();
    expect(container.querySelector("[data-testid='room-modal']")).toBeNull();
    expect(container.querySelector("[data-placings], [role='dialog'][aria-label='Duel result']")).toBeNull();
    expect(container.textContent).not.toMatch(/Live duel|Reconnecting|Catch up now|Next game/);
    expect(container.querySelector("[data-clock], [data-series-banner]")).toBeNull();
    expect(container.querySelector("[data-replay-label]")?.textContent).toBe("Replay");
    expect(queryByText("Jump in")).not.toBeNull();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("puts the transport in its slot on a wide and a narrow screen", () => {
    const wide = render(<View set={set} kind={kind} />);
    expect(wide.container.querySelectorAll("[data-testid='replay-transport'] [data-testid='transport-body']")).toHaveLength(1);
    wide.unmount();
    vi.stubGlobal("matchMedia", mediaStub(true));
    const narrow = render(<View set={set} kind={kind} />);
    expect(narrow.container.querySelectorAll("[data-testid='replay-transport'] [data-testid='transport-body']")).toHaveLength(1);
  });
});

describe.each(CASES.filter(([, , kind]) => kind === "table"))("%s loss history", (_name, set, kind) => {
  it("shows a loss as fresh in forward play and as already there after a seek", () => {
    const out = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-testid='seat-out']")];
    const view = render(<View set={set} kind={kind} id="main" resetKey={1} />);
    expect(out(view.container)).toHaveLength(0);
    // Forward play: the loss happens while the viewer watches.
    view.rerender(<View set={set} kind={kind} id="elimination" resetKey={1} />);
    expect(out(view.container).length).toBeGreaterThan(0);
    expect(out(view.container).every((node) => node.getAttribute("data-fresh") === "true")).toBe(true);
    // Rewind: nothing of the later frame stays.
    view.rerender(<View set={set} kind={kind} id="main" resetKey={2} />);
    expect(out(view.container)).toHaveLength(0);
    // A seek onto a frame with a loss draws it as an old one, not as a new loss.
    view.rerender(<View set={set} kind={kind} id="elimination" resetKey={3} />);
    expect(out(view.container).length).toBeGreaterThan(0);
    expect(out(view.container).every((node) => node.getAttribute("data-fresh") === null)).toBe(true);
  });
});

describe("FFA3 camera across a seek", () => {
  it("keeps the camera the viewer chose and never moves it by itself", () => {
    const [, set, kind] = CASES[0];
    const view = render(<View set={set} kind={kind} resetKey={1} />);
    const overview = () => view.container.querySelector("[data-cam='overview']")?.getAttribute("aria-pressed");
    expect(overview()).toBe("false");
    press("o");
    expect(overview()).toBe("true");
    view.rerender(<View set={set} kind={kind} id="chain-2" resetKey={2} />);
    expect(overview()).toBe("true");
    view.rerender(<View set={set} kind={kind} id="battle-aim" resetKey={3} />);
    expect(overview()).toBe("true");
  });
});

describe("Tag camera lock", () => {
  const [, set, kind] = CASES[2];
  const attack = (id: number): DuelEvent => ({ id, kind: "attack", seat: 0, text: "attack", target: { seat: 1 } } as unknown as DuelEvent);
  const locked = (container: HTMLElement) => container.querySelector("[data-camera-dock]")?.getAttribute("data-locked");
  const seatPressed = (container: HTMLElement, seat: number) => container.querySelector(`[data-seat-btn='${seat}']`)?.getAttribute("aria-pressed");

  it("locks for a new event in forward play and clears the lock history on a seek", () => {
    const view = render(<View set={set} kind={kind} reducedMotion={false} resetKey={1} />);
    expect(locked(view.container)).toBe("false");
    press("4");
    expect(seatPressed(view.container, 3)).toBe("true");
    view.rerender(<View set={set} kind={kind} reducedMotion={false} resetKey={1} more={[attack(900)]} />);
    expect(locked(view.container)).toBe("true");
    // The seek keeps the frame's events but starts clean: no lock for them, and the chosen seat is still the camera.
    view.rerender(<View set={set} kind={kind} reducedMotion={false} resetKey={2} more={[attack(900)]} />);
    expect(locked(view.container)).toBe("false");
    expect(seatPressed(view.container, 3)).toBe("true");
  });
});

describe.each(CASES)("%s forward play", (_name, set, kind) => {
  it("shows the events that arrive on the same reset key and not the ones a seek lands on", () => {
    const first = render(<View set={set} kind={kind} reducedMotion={false} resetKey={1} />);
    const engineEvents = (id: number): DuelEvent[] => [{ id, kind: "activate", seat: 0, text: "activating", chainIndex: 1, card: { code: 14, name: "Test", description: "Test text", controller: 0, location: 2, sequence: 0 } } as unknown as DuelEvent];
    expect(first.container.querySelector("[data-feedback-cue]")).toBeNull();
    first.rerender(<View set={set} kind={kind} reducedMotion={false} resetKey={1} more={engineEvents(900)} />);
    expect(first.container.querySelector("[data-feedback-cue][data-kind='activate']")).not.toBeNull();
    first.unmount();
    const seeked = render(<View set={set} kind={kind} reducedMotion={false} resetKey={2} more={engineEvents(900)} />);
    expect(seeked.container.querySelector("[data-feedback-cue]")).toBeNull();
  });
});
