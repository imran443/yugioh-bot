// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useDraftStore } from "../../src/lib/stores/draft-store";
import { useDraftCountdown } from "../../src/lib/hooks/use-draft-countdown";

const baseState = {
  slug: "legendary-draft",
  packRound: 1,
  pickStep: 1,
  currentPack: [],
  myPool: [],
  seats: [],
  timerSeconds: 60,
  isMyTurn: true,
  completed: false,
  pickSeconds: 60,
  selectedCardId: null,
  highlightedIndex: -1,
};

function CountdownHarness() {
  useDraftCountdown();
  return null;
}

const oscillatorStart = vi.fn();
const oscillatorStop = vi.fn();
const oscillatorConnect = vi.fn();
const gainConnect = vi.fn();

class MockAudioContext {
  currentTime = 0;
  destination = {};

  createOscillator() {
    return {
      frequency: { value: 0 },
      connect: oscillatorConnect,
      start: oscillatorStart,
      stop: oscillatorStop,
    };
  }

  createGain() {
    return {
      gain: { value: 0 },
      connect: gainConnect,
    };
  }
}

describe("useDraftCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    (window as any).AudioContext = MockAudioContext;
    (window as any).webkitAudioContext = undefined;
    useDraftStore.setState(baseState);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).AudioContext;
    delete (window as any).webkitAudioContext;
    useDraftStore.setState(baseState);
  });

  it("decrements the timer once per second while the draft is active", () => {
    render(<CountdownHarness />);

    vi.advanceTimersByTime(1000);

    expect(useDraftStore.getState().timerSeconds).toBe(59);
  });

  it("stops decrementing at zero", () => {
    useDraftStore.setState({ ...baseState, timerSeconds: 1 });

    render(<CountdownHarness />);

    vi.advanceTimersByTime(3000);

    expect(useDraftStore.getState().timerSeconds).toBe(0);
  });

  it("does not decrement when the draft is completed", () => {
    useDraftStore.setState({ ...baseState, completed: true });

    render(<CountdownHarness />);

    vi.advanceTimersByTime(1000);

    expect(useDraftStore.getState().timerSeconds).toBe(60);
  });

  it("plays a warning sound once when the timer reaches 10 seconds", () => {
    useDraftStore.setState({ ...baseState, timerSeconds: 11 });

    render(<CountdownHarness />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(useDraftStore.getState().timerSeconds).toBe(10);
    expect(oscillatorStart).toHaveBeenCalledTimes(1);
    expect(oscillatorStop).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(useDraftStore.getState().timerSeconds).toBe(9);
    expect(oscillatorStart).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the warning for the same pick", () => {
    render(<CountdownHarness />);

    act(() => {
      useDraftStore.setState({ ...baseState, timerSeconds: 10 });
    });
    act(() => {
      useDraftStore.setState({ ...baseState, timerSeconds: 9 });
    });
    act(() => {
      useDraftStore.setState({ ...baseState, timerSeconds: 10 });
    });

    expect(oscillatorStart).toHaveBeenCalledTimes(1);
  });

  it("allows the warning sound again on a new pick", () => {
    render(<CountdownHarness />);

    act(() => {
      useDraftStore.setState({ ...baseState, timerSeconds: 10 });
    });
    act(() => {
      useDraftStore.setState({ ...baseState, pickStep: 2, timerSeconds: 10 });
    });

    expect(oscillatorStart).toHaveBeenCalledTimes(2);
  });
});
