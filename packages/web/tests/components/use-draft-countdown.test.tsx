// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
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

describe("useDraftCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDraftStore.setState(baseState);
  });

  afterEach(() => {
    vi.useRealTimers();
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
});
