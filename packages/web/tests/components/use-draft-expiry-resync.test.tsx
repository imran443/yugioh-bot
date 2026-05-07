// @vitest-environment jsdom
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "../../src/lib/stores/draft-store";
import { useDraftExpiryResync } from "../../src/lib/hooks/use-draft-expiry-resync";

const baseState = {
  slug: "legendary-draft",
  packRound: 2,
  pickStep: 2,
  currentPack: [],
  myPool: [],
  seats: [],
  timerSeconds: 0,
  isMyTurn: true,
  completed: false,
  pickSeconds: 60,
  selectedCardId: null,
  highlightedIndex: -1,
};

function ResyncHarness({ slug }: { slug: string }) {
  useDraftExpiryResync(slug);
  return null;
}

describe("useDraftExpiryResync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDraftStore.setState(baseState);
  });

  afterEach(() => {
    useDraftStore.setState(baseState);
  });

  it("refetches draft state when the visible timer reaches zero", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          slug: "legendary-draft",
          packRound: 2,
          pickStep: 3,
          currentPack: [{ id: 99, name: "Card 99", type: "Spell Card", frameType: "spell", effectText: "", imageUrl: "https://img/full/99", imageUrlSmall: "https://img/small/99" }],
          myPool: [],
          seats: [],
          timerSeconds: 58,
          isMyTurn: false,
          completed: false,
          pickSeconds: 60,
        }),
    } as unknown as Response);

    render(<ResyncHarness slug="legendary-draft" />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/drafts/legendary-draft");
      expect(useDraftStore.getState().pickStep).toBe(3);
      expect(useDraftStore.getState().timerSeconds).toBe(58);
    });
  });

  it("does not refetch when the draft is already completed", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
    useDraftStore.setState({ ...baseState, completed: true, timerSeconds: 5 });

    render(<ResyncHarness slug="legendary-draft" />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps retrying after zero until the server advances the draft", async () => {
    vi.useFakeTimers();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            slug: "legendary-draft",
            packRound: 2,
            pickStep: 2,
            currentPack: [],
            myPool: [],
            seats: [],
            timerSeconds: 0,
            isMyTurn: true,
            completed: false,
            pickSeconds: 60,
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            slug: "legendary-draft",
            packRound: 2,
            pickStep: 3,
            currentPack: [{ id: 99, name: "Card 99", type: "Spell Card", frameType: "spell", effectText: "fresh", imageUrl: "https://img/full/99", imageUrlSmall: "https://img/small/99" }],
            myPool: [],
            seats: [],
            timerSeconds: 58,
            isMyTurn: false,
            completed: false,
            pickSeconds: 60,
          }),
      } as unknown as Response)
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            slug: "legendary-draft",
            packRound: 2,
            pickStep: 3,
            currentPack: [{ id: 99, name: "Card 99", type: "Spell Card", frameType: "spell", effectText: "fresh", imageUrl: "https://img/full/99", imageUrlSmall: "https://img/small/99" }],
            myPool: [],
            seats: [],
            timerSeconds: 58,
            isMyTurn: false,
            completed: false,
            pickSeconds: 60,
          }),
      } as unknown as Response);

    render(<ResyncHarness slug="legendary-draft" />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(useDraftStore.getState().pickStep).toBe(3);
    expect(useDraftStore.getState().isMyTurn).toBe(false);

    vi.useRealTimers();
  });
});
