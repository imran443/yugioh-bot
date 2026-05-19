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

  it("reconciles an active draft even while the pick timer is still counting down", async () => {
    // Regression: a non-last picker only learns the step advanced via a single
    // fire-and-forget resync broadcast. If that broadcast is lost (dropped HTTP
    // relay, Socket.IO reconnect, backgrounded tab, or the step-completing pick
    // threw SQLITE_BUSY before emitting it), the client must still converge to
    // server truth on its own — not stay frozen on the stale pack until the
    // full pick timer expires.
    useDraftStore.setState({
      ...baseState,
      timerSeconds: 25,
      isMyTurn: false,
      pickStep: 2,
      currentPack: [],
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          slug: "legendary-draft",
          packRound: 2,
          pickStep: 3,
          currentPack: [{ id: 77, name: "Card 77", type: "Spell Card", frameType: "spell", effectText: "", imageUrl: "https://img/full/77", imageUrlSmall: "https://img/small/77" }],
          myPool: [],
          seats: [],
          timerSeconds: 25,
          isMyTurn: false,
          completed: false,
          pickSeconds: 60,
        }),
    } as unknown as Response);

    render(<ResyncHarness slug="legendary-draft" />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/drafts/legendary-draft");
      expect(useDraftStore.getState().pickStep).toBe(3);
      expect(useDraftStore.getState().currentPack.map((c) => c.id)).toEqual([77]);
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
