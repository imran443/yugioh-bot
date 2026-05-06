// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardGrid } from "../../src/components/draft/card-grid";
import { useDraftStore } from "../../src/lib/stores/draft-store";

const baseState = {
  slug: "legendary-draft",
  packRound: 1,
  pickStep: 1,
  currentPack: [],
  myPool: [],
  seats: [],
  timerSeconds: 0,
  isMyTurn: false,
  completed: false,
  pickSeconds: 60,
  selectedCardId: null,
  highlightedIndex: -1,
};

describe("CardGrid", () => {
  beforeEach(() => {
    useDraftStore.setState(baseState);
  });

  afterEach(() => {
    useDraftStore.setState(baseState);
  });

  it("shows a syncing fallback when no pack cards are available yet", () => {
    render(<CardGrid />);

    expect(screen.getByText(/draft feed syncing/i)).toBeTruthy();
    expect(screen.getByText(/waiting for pack/i)).toBeTruthy();
  });
});
