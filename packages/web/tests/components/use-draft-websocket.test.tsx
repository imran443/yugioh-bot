// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useDraftStore } from "../../src/lib/stores/draft-store";
import { useTalkStore } from "../../src/lib/stores/talk-store";
import { useDraftWebsocket } from "../../src/lib/hooks/use-draft-websocket";

// ---------------------------------------------------------------------------
// socket.io-client mock
// ---------------------------------------------------------------------------
type EventHandler = (...args: unknown[]) => void;

const mockHandlers: Record<string, EventHandler> = {};
const mockEmit = vi.fn();
const mockDisconnect = vi.fn();
const mockFetch = vi.fn();

const mockSocket = {
  connected: true,
  id: "socket-1",
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
    mockSocket.connected = true;
    mockSocket.id = "socket-1";
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ token: "fresh-token", userId: 101 }) });
    vi.stubGlobal("fetch", mockFetch);
    Object.keys(mockHandlers).forEach((k) => delete mockHandlers[k]);
    useDraftStore.setState(baseState);
  });

  afterEach(() => {
    useDraftStore.setState(baseState);
    vi.unstubAllGlobals();
  });

  it("fetches an authorized token before joining on connect", async () => {
    render(<HookHarness slug="my-draft" />);

    // Trigger the connect event
    act(() => {
      simulateEvent("connect");
    });

    await waitFor(() => expect(mockEmit).toHaveBeenCalledWith("draft:join", {
      slug: "my-draft", token: "fresh-token", userId: 101,
    }, expect.any(Function)));
    expect(mockFetch).toHaveBeenCalledWith("/api/drafts/my-draft/connection", expect.objectContaining({ cache: "no-store" }));
  });

  it("fetches a fresh token on reconnect", async () => {
    render(<HookHarness slug="my-draft" />);
    act(() => simulateEvent("connect"));
    await waitFor(() => expect(mockEmit).toHaveBeenCalledTimes(1));
    mockSocket.id = "socket-2";
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ token: "reconnected-token", userId: 101 }) });
    act(() => simulateEvent("connect"));
    await waitFor(() => expect(mockEmit).toHaveBeenLastCalledWith("draft:join", {
      slug: "my-draft", token: "reconnected-token", userId: 101,
    }, expect.any(Function)));
  });

  it("resyncs after a successful room join to catch events missed while reconnecting", async () => {
    const onResync = vi.fn();
    render(<HookHarness slug="my-draft" options={{ onResync }} />);
    act(() => simulateEvent("connect"));
    await waitFor(() => expect(mockEmit).toHaveBeenCalledTimes(1));
    act(() => mockEmit.mock.calls[0][2]());
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("resyncs and rejoins when the tab becomes visible again, and stops after unmount", async () => {
    const onResync = vi.fn();
    const { unmount } = render(<HookHarness slug="my-draft" options={{ onResync }} />);
    act(() => simulateEvent("connect"));
    await waitFor(() => expect(mockEmit).toHaveBeenCalledTimes(1));
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(onResync).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(onResync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockEmit).toHaveBeenCalledTimes(2));
    unmount();
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(onResync).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it("does not resync when the room join is refused", async () => {
    const onResync = vi.fn();
    render(<HookHarness slug="my-draft" options={{ onResync }} />);
    act(() => simulateEvent("connect"));
    await waitFor(() => expect(mockEmit).toHaveBeenCalledTimes(1));
    act(() => mockEmit.mock.calls[0][2]({ error: "Access denied" }));
    expect(onResync).not.toHaveBeenCalled();
  });

  it("ignores a join acknowledgement after unmounting", async () => {
    const onResync = vi.fn();
    const { unmount } = render(<HookHarness slug="my-draft" options={{ onResync }} />);
    act(() => simulateEvent("connect"));
    await waitFor(() => expect(mockEmit).toHaveBeenCalledTimes(1));
    unmount();
    act(() => mockEmit.mock.calls[0][2]({ error: "Access denied" }));
    expect(onResync).not.toHaveBeenCalled();
  });

  it("renews after its room subscription expires", async () => {
    render(<HookHarness slug="my-draft" />);
    act(() => simulateEvent("connect"));
    await waitFor(() => expect(mockEmit).toHaveBeenCalledTimes(1));
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ token: "renewed-token", userId: 101 }) });
    act(() => simulateEvent("draft:subscription-expired", { slug: "my-draft" }));
    await waitFor(() => expect(mockEmit).toHaveBeenLastCalledWith("draft:join", {
      slug: "my-draft", token: "renewed-token", userId: 101,
    }, expect.any(Function)));
  });

  it("does not join when the token endpoint denies access", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    render(<HookHarness slug="my-draft" />);
    await act(async () => simulateEvent("connect"));
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("does not join when token fetching fails", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    render(<HookHarness slug="my-draft" />);
    await act(async () => simulateEvent("connect"));
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("does not use a token request from before a disconnect", async () => {
    let resolve!: (response: unknown) => void;
    mockFetch.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<HookHarness slug="my-draft" />);
    act(() => simulateEvent("connect"));
    act(() => { mockSocket.connected = false; simulateEvent("disconnect"); });
    await act(async () => resolve({ ok: true, json: async () => ({ token: "old-token", userId: 101 }) }));
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("does not join after unmounting while a token request is pending", async () => {
    let resolve!: (response: unknown) => void;
    mockFetch.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { unmount } = render(<HookHarness slug="my-draft" />);
    act(() => simulateEvent("connect"));
    unmount();
    await act(async () => resolve({ ok: true, json: async () => ({ token: "old-token", userId: 101 }) }));
    expect(mockEmit).not.toHaveBeenCalled();
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

  it("calls onHostStopped when the host cancels the draft", () => {
    const onHostStopped = vi.fn();

    render(<HookHarness slug="my-draft" options={{ onHostStopped }} />);

    act(() => {
      simulateEvent("connect");
      simulateEvent("draft:status", { status: "cancelled" });
    });

    expect(onHostStopped).toHaveBeenCalledExactlyOnceWith("cancelled");
  });

  it("does not call onHostStopped for a completed status, but still reports the status", () => {
    const onHostStopped = vi.fn();
    const onStatusChange = vi.fn();

    render(<HookHarness slug="my-draft" options={{ onHostStopped, onStatusChange }} />);

    act(() => {
      simulateEvent("connect");
      simulateEvent("draft:status", { status: "completed" });
    });

    expect(onHostStopped).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith("completed");
  });

  it("does not call onHostStopped when the draft finishes by itself", () => {
    const onHostStopped = vi.fn();

    render(<HookHarness slug="my-draft" options={{ onHostStopped }} />);

    act(() => {
      simulateEvent("connect");
      simulateEvent("draft:complete");
    });

    expect(onHostStopped).not.toHaveBeenCalled();
  });

  it("disconnects the socket when unmounted", () => {
    const { unmount } = render(<HookHarness slug="my-draft" />);

    unmount();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  describe("table talk", () => {
    afterEach(() => useTalkStore.getState().clear());

    it("keeps the line a seat said, by player", () => {
      render(<HookHarness slug="my-draft" />);
      act(() => simulateEvent("draft:talk", { playerId: 2, line: "gg" }));
      expect(useTalkStore.getState().heard[2]?.line).toBe("gg");
    });

    it("drops a line that is not one of the fixed ids, and does not touch the picks", () => {
      render(<HookHarness slug="my-draft" />);
      const before = useDraftStore.getState().seats;
      act(() => simulateEvent("draft:talk", { playerId: 2, line: "show me your pool" }));
      act(() => simulateEvent("draft:talk", undefined));
      expect(useTalkStore.getState().heard).toEqual({});
      expect(useDraftStore.getState().seats).toBe(before);
    });
  });
});
