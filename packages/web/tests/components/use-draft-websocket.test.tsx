// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useDraftStore } from "../../src/lib/stores/draft-store";
import { useDraftWebsocket } from "../../src/lib/hooks/use-draft-websocket";

// ---------------------------------------------------------------------------
// socket.io-client mock
// ---------------------------------------------------------------------------
type EventHandler = (...args: unknown[]) => void;

const mockHandlers: Record<string, EventHandler> = {};
const mockEmit = vi.fn();
const mockDisconnect = vi.fn();

const mockSocket = {
  on: vi.fn((event: string, handler: EventHandler) => {
    mockHandlers[event] = handler;
  }),
  emit: mockEmit,
  disconnect: mockDisconnect,
};

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => mockSocket),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function simulateEvent(event: string, payload?: unknown) {
  const handler = mockHandlers[event];
  if (!handler) throw new Error(`No handler registered for "${event}"`);
  handler(payload);
}

const baseState = {
  slug: "test-draft",
  packRound: 1,
  pickStep: 1,
  currentPack: [],
  myPool: [],
  seats: [
    { seatIndex: 0, playerId: 1, displayName: "Alice", hasPicked: false, isCurrentPlayer: true },
    { seatIndex: 1, playerId: 2, displayName: "Bob", hasPicked: false, isCurrentPlayer: false },
  ],
  timerSeconds: 0,
  isMyTurn: true,
  completed: false,
  pickSeconds: 60,
  selectedCardId: null,
  highlightedIndex: -1,
};

function HookHarness({
  slug,
  options = {},
}: {
  slug: string;
  options?: Parameters<typeof useDraftWebsocket>[1];
}) {
  useDraftWebsocket(slug, options);
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("useDraftWebsocket", () => {
  beforeEach(() => {
    // Reset all mock state before each test
    vi.clearAllMocks();
    Object.keys(mockHandlers).forEach((k) => delete mockHandlers[k]);
    useDraftStore.setState(baseState);
  });

  afterEach(() => {
    useDraftStore.setState(baseState);
  });

  it("emits draft:join with { slug } on connect", () => {
    render(<HookHarness slug="my-draft" />);

    // Trigger the connect event
    act(() => {
      simulateEvent("connect");
    });

    expect(mockEmit).toHaveBeenCalledWith("draft:join", { slug: "my-draft" });
  });

  it("calls onResync when draft:resync is received", () => {
    const onResync = vi.fn();

    render(<HookHarness slug="my-draft" options={{ onResync }} />);

    act(() => {
      simulateEvent("connect");
      simulateEvent("draft:resync", { packRound: 1, pickStep: 2 });
    });

    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("calls onStatusChange when draft:status is received", () => {
    const onStatusChange = vi.fn();

    render(<HookHarness slug="my-draft" options={{ onStatusChange }} />);

    act(() => {
      simulateEvent("connect");
      simulateEvent("draft:status", { status: "cancelled" });
    });

    expect(onStatusChange).toHaveBeenCalledWith("cancelled");
  });

  it("sets completed: true in store when draft:status completed is received", () => {
    render(<HookHarness slug="my-draft" />);

    act(() => {
      simulateEvent("connect");
      simulateEvent("draft:status", { status: "completed" });
    });

    expect(useDraftStore.getState().completed).toBe(true);
    expect(useDraftStore.getState().isMyTurn).toBe(false);
  });

  it("marks hasPicked for the player when draft:pick matches current packRound/pickStep", () => {
    render(<HookHarness slug="my-draft" />);

    act(() => {
      simulateEvent("connect");
      simulateEvent("draft:pick", { playerId: 1, packRound: 1, pickStep: 1 });
    });

    const { seats } = useDraftStore.getState();
    expect(seats.find((s) => s.playerId === 1)?.hasPicked).toBe(true);
    expect(seats.find((s) => s.playerId === 2)?.hasPicked).toBe(false);
  });

  it("ignores draft:pick when packRound/pickStep does not match current state", () => {
    render(<HookHarness slug="my-draft" />);

    act(() => {
      simulateEvent("connect");
      // Payload is for a different round
      simulateEvent("draft:pick", { playerId: 1, packRound: 2, pickStep: 1 });
    });

    const { seats } = useDraftStore.getState();
    expect(seats.find((s) => s.playerId === 1)?.hasPicked).toBe(false);
  });

  it("sets completed: true and calls onStatusChange('completed') on draft:complete", () => {
    const onStatusChange = vi.fn();

    render(<HookHarness slug="my-draft" options={{ onStatusChange }} />);

    act(() => {
      simulateEvent("connect");
      simulateEvent("draft:complete");
    });

    expect(useDraftStore.getState().completed).toBe(true);
    expect(useDraftStore.getState().isMyTurn).toBe(false);
    expect(onStatusChange).toHaveBeenCalledWith("completed");
  });

  it("disconnects the socket when unmounted", () => {
    const { unmount } = render(<HookHarness slug="my-draft" />);

    unmount();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
