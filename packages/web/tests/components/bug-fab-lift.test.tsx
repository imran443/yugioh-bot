// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BugReportFab } from "@/components/bug-report/bug-report-fab";
import { BugFabLift, liftFor } from "@/components/bug-report/fab-lift";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
});

describe("liftFor", () => {
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height });

  it("lifts a stuck bar's height plus a gap above the button's bottom offset", () => {
    // 844px tall screen, a 100px bar stuck to the bottom: top 744.
    expect(liftFor(rect(744, 100), "sticky", 844)).toBe(100 + 8 - 12);
  });

  it("lifts for a fixed bar too", () => {
    expect(liftFor(rect(764, 80), "fixed", 844)).toBe(80 + 8 - 12);
  });

  it("does not lift when the bar is not sticky or fixed (desktop column)", () => {
    expect(liftFor(rect(744, 100), "static", 844)).toBe(0);
  });

  it("does not lift when the bar sits above the button's corner (scrolled to the end)", () => {
    expect(liftFor(rect(500, 100), "sticky", 844)).toBe(0);
  });

  it("does not lift for a hidden bar", () => {
    expect(liftFor(rect(844, 0), "sticky", 844)).toBe(0);
  });
});

describe("the Report bug button over a bottom bar", () => {
  it("lifts above a registered bar and drops back when the bar goes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-bar") ? ({ top: 744, bottom: 844, height: 100, left: 0, right: 390, width: 390, x: 0, y: 744, toJSON() {} } as DOMRect) : ({ top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} } as DOMRect);
    });
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    const { rerender } = render(<><BugReportFab /><BugFabLift data-bar style={{ position: "sticky" }}>Create draft</BugFabLift></>);
    const button = screen.getByRole("button", { name: "Report bug" });
    expect(button.style.bottom).toContain("96px");
    act(() => rerender(<BugReportFab />));
    expect(screen.getByRole("button", { name: "Report bug" }).style.bottom).toBe("");
  });

  it("stays at its place when no bar is registered", () => {
    render(<BugReportFab />);
    expect(screen.getByRole("button", { name: "Report bug" }).style.bottom).toBe("");
  });
});

describe("re-measuring the lift", () => {
  const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON() {} }) as DOMRect;

  /** A bar whose rect the test moves, a manual animation-frame queue, and a recording ResizeObserver. */
  function setup() {
    const bar = { top: 744, height: 100 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-bar") ? box(bar.top, bar.height) : box(0, 0);
    });
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const observers: { callback: () => void; observed: Element[]; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      entry = { callback: () => {}, observed: [] as Element[], disconnect: vi.fn() };
      constructor(callback: () => void) { this.entry.callback = callback; observers.push(this.entry); }
      observe(target: Element) { this.entry.observed.push(target); }
      disconnect() { this.entry.disconnect(); }
    });
    const flush = () => act(() => { frames.splice(0).forEach((cb) => cb(0)); });
    return { bar, frames, observers, flush };
  }

  const renderBar = () => render(<><BugReportFab /><div data-testid="parent"><BugFabLift data-bar style={{ position: "sticky" }}>Create draft</BugFabLift></div></>);
  const bottom = () => screen.getByRole("button", { name: "Report bug" }).style.bottom;

  it("measures against the layout viewport, not the visual viewport the phone keyboard shrinks", () => {
    setup();
    const visual = Object.assign(new EventTarget(), { height: 300 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(844);
    renderBar();
    expect(bottom()).toContain("96px");
  });

  it("re-measures when the visual viewport resizes or scrolls, and stops after unmount", () => {
    const { bar, flush } = setup();
    const visual = new EventTarget();
    const add = vi.spyOn(visual, "addEventListener");
    const remove = vi.spyOn(visual, "removeEventListener");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: Object.assign(visual, { height: 300 }) });
    const { unmount } = renderBar();
    expect(bottom()).toContain("96px");

    bar.top = 794; // the bar moved down; only a visual viewport resize tells us
    act(() => { visual.dispatchEvent(new Event("resize")); });
    flush();
    expect(bottom()).toContain("46px");

    bar.top = 600; // the bar rose clear of the button's corner; only a visual viewport scroll tells us
    act(() => { visual.dispatchEvent(new Event("scroll")); });
    flush();
    expect(bottom()).toBe("");

    unmount();
    expect(add.mock.calls.map(([type]) => type).sort()).toEqual(["resize", "scroll"]);
    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual(["resize", "scroll"]);
  });

  it("watches the bar, its parent and the page body, and re-measures when the content resizes", () => {
    const { bar, observers, flush } = setup();
    const { unmount } = renderBar();
    expect(bottom()).toContain("96px");
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toContain(screen.getByTestId("parent"));
    expect(observers[0].observed).toContain(document.body);
    expect(observers[0].observed).toContain(screen.getByText("Create draft"));

    bar.top = 844; // content shrank: the bar is no longer stuck over the button's corner
    act(() => observers[0].callback());
    flush();
    expect(bottom()).toBe("");

    unmount();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });
});
