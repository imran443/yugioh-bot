// @vitest-environment jsdom
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "../../src/lib/stores/draft-store";

// ---------------------------------------------------------------------------
// Next.js navigation mocks — stable object references prevent fetchDraft
// useCallback from recreating on every render (router is in its dep array).
// ---------------------------------------------------------------------------
const mockRouter = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "test-draft" }),
  useRouter: () => mockRouter,
}));

// ---------------------------------------------------------------------------
// Hook mocks — these have side-effects (WebSocket, timers) we don't want in
// page-level tests.
// ---------------------------------------------------------------------------
vi.mock("../../src/lib/hooks/use-draft-websocket", () => ({
  useDraftWebsocket: vi.fn(),
}));
vi.mock("../../src/lib/hooks/use-draft-countdown", () => ({
  useDraftCountdown: vi.fn(),
}));
vi.mock("../../src/lib/hooks/use-draft-expiry-resync", () => ({
  useDraftExpiryResync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Child component mocks — render minimal stand-ins so we can assert on which
// view is shown without needing full component trees.
// ---------------------------------------------------------------------------
vi.mock("../../src/components/draft/draft-manage-view", () => ({
  DraftManageView: () => <div data-testid="draft-manage-view">Manage</div>,
}));
vi.mock("../../src/components/draft/draft-summary-view", () => ({
  DraftSummaryView: () => <div data-testid="draft-summary-view">Summary</div>,
}));
vi.mock("../../src/components/draft/card-grid", () => ({
  CardGrid: () => <div data-testid="card-grid">CardGrid</div>,
}));
vi.mock("../../src/components/draft/timer-bar", () => ({
  TimerBar: () => <div data-testid="timer-bar" />,
}));
vi.mock("../../src/components/draft/seat-list", () => ({
  SeatList: () => <div data-testid="seat-list" />,
}));
vi.mock("../../src/components/draft/pool-panel", () => ({
  PoolPanel: () => <div data-testid="pool-panel" />,
}));

// ---------------------------------------------------------------------------
// Import page AFTER mocks are set up
// ---------------------------------------------------------------------------
import DraftDetailPage from "../../app/(app)/draft/[slug]/page";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const baseStoreState = {
  slug: "test-draft",
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

const activeDraftResponse = {
  id: 1,
  name: "Test Draft",
  status: "active",
  createdByUserId: "user-1",
  createdAt: "2026-05-06T12:00:00.000Z",
  config: { packSize: 5, packsPerPlayer: 3, pickSeconds: 60, setNames: [] },
  players: [],
  playerCount: 1,
  isParticipant: true,
  packRound: 1,
  pickStep: 1,
  currentPack: [],
  myPool: [],
  seats: [],
  timerSeconds: 30,
  isMyTurn: false,
  completed: false,
  pickSeconds: 60,
};

const completedDraftResponse = {
  ...activeDraftResponse,
  status: "completed",
  completed: true,
  endedAt: "2026-05-06T12:30:00.000Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("DraftDetailPage — completion transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDraftStore.setState(baseStoreState);
  });

  afterEach(() => {
    useDraftStore.setState(baseStoreState);
  });

  it("renders the active draft view when status is active", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: "user-1" } }) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(activeDraftResponse),
      } as Response);
    });

    render(<DraftDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId("card-grid")).toBeTruthy();
    });

    expect(screen.queryByTestId("draft-summary-view")).toBeNull();
    expect(screen.queryByTestId("draft-manage-view")).toBeNull();
  });

  it("transitions to DraftSummaryView when storeCompleted becomes true while draft.status is active", async () => {
    // Track how many times the draft API has been called so we can serve
    // active on the first call and completed on the second.
    let draftApiCallCount = 0;

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: "user-1" } }),
        } as Response);
      }
      // Draft API
      draftApiCallCount += 1;
      if (draftApiCallCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(activeDraftResponse),
        } as Response);
      }
      // Second call (triggered by storeCompleted effect) → completed
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(completedDraftResponse),
      } as Response);
    });

    render(<DraftDetailPage />);

    // Wait for initial active view to render
    await waitFor(() => {
      expect(screen.getByTestId("card-grid")).toBeTruthy();
    });

    // Simulate pick API response setting completed: true in the store,
    // as CardGrid.fetchPick would via setFromServer(data).
    act(() => {
      useDraftStore.getState().setFromServer({ completed: true });
    });

    // The useEffect watching storeCompleted should fire fetchDraft, which
    // returns completedDraftResponse; the page transitions to DraftSummaryView.
    await waitFor(() => {
      expect(screen.getByTestId("draft-summary-view")).toBeTruthy();
    });

    expect(screen.queryByTestId("card-grid")).toBeNull();
    expect(draftApiCallCount).toBe(2);
  });

  it("does NOT re-fetch if storeCompleted becomes true but draft.status is already completed", async () => {
    const fetchDraftMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: "user-1" } }) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(completedDraftResponse),
      } as Response);
    });
    global.fetch = fetchDraftMock;

    render(<DraftDetailPage />);

    // Wait for the completed summary view to appear
    await waitFor(() => {
      expect(screen.getByTestId("draft-summary-view")).toBeTruthy();
    });

    // Capture call count once the page has settled
    const callCountAfterLoad = fetchDraftMock.mock.calls.length;

    // Setting storeCompleted true while draft.status is already "completed"
    // must NOT trigger another fetchDraft call.
    await act(async () => {
      useDraftStore.getState().setFromServer({ completed: true });
      // Flush microtasks so any triggered effects can run
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchDraftMock.mock.calls.length).toBe(callCountAfterLoad);
  });

  it("renders DraftManageView for a pending draft", async () => {
    const pendingDraftResponse = {
      ...activeDraftResponse,
      status: "pending",
      completed: false,
      currentPack: undefined,
      myPool: undefined,
      seats: undefined,
    };

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: "user-1" } }) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(pendingDraftResponse),
      } as Response);
    });

    render(<DraftDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId("draft-manage-view")).toBeTruthy();
    });

    expect(screen.queryByTestId("card-grid")).toBeNull();
    expect(screen.queryByTestId("draft-summary-view")).toBeNull();
  });
});
