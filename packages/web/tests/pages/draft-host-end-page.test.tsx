// @vitest-environment jsdom
import { fixtureUserId, fixtureDiscordId } from "../fixtures/identity";
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "../../src/lib/stores/draft-store";

const mockRouter = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "test-draft" }),
  useRouter: () => mockRouter,
}));
vi.mock("../../src/lib/hooks/use-draft-websocket", () => ({ useDraftWebsocket: vi.fn() }));
vi.mock("../../src/lib/hooks/use-draft-countdown", () => ({ useDraftCountdown: vi.fn() }));
vi.mock("../../src/lib/hooks/use-draft-expiry-resync", () => ({ useDraftExpiryResync: vi.fn() }));

// What the page hands the draft room and the lobby, as data attributes and captured props.
const room = vi.hoisted(() => ({ onCancel: undefined as undefined | (() => Promise<void>) }));
const lobby = vi.hoisted(() => ({ onCancel: undefined as undefined | (() => Promise<void>) }));
vi.mock("../../src/components/draft/room/draft-room", () => ({
  DraftRoom: (props: { onCancel?: () => Promise<void> }) => {
    room.onCancel = props.onCancel;
    return <div data-testid="draft-room" data-host-action={String(Boolean(props.onCancel))}>Room</div>;
  },
}));
vi.mock("../../src/components/draft/draft-manage-view", () => ({
  DraftManageView: (props: { canCancel?: boolean; onCancel: () => Promise<void> }) => {
    lobby.onCancel = props.onCancel;
    return (
      <div data-testid="draft-manage-view" data-can-cancel={String(props.canCancel)}>
        Manage
      </div>
    );
  },
}));
vi.mock("../../src/components/draft/draft-summary-view", () => ({
  DraftSummaryView: ({ draft }: { draft: { status: string } }) => <div data-testid="draft-summary-view" data-status={draft.status}>Summary</div>,
}));
vi.mock("../../src/components/draft/room/finale", () => ({ DraftFinale: () => <div data-testid="draft-finale">Finale</div> }));

import DraftDetailPage from "../../app/(app)/draft/[slug]/page";
import { useDraftWebsocket } from "../../src/lib/hooks/use-draft-websocket";

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

const draftBody = {
  id: 1,
  name: "Test Draft",
  status: "active",
  createdByUserId: fixtureUserId("host"),
  createdAt: "2026-05-06T12:00:00.000Z",
  config: { packSize: 5, packsPerPlayer: 3, pickSeconds: 60, setNames: [] },
  players: [],
  playerCount: 2,
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

type Body = Record<string, unknown>;

/** Answers the session, the draft (whatever `draft.current` holds) and the cancel post. */
function stubFetch(viewer: string, draft: { current: Body }, post: () => Promise<Partial<Response>> = async () => ({ ok: true, status: 200, json: async () => ({ changed: true }) })) {
  const calls: Array<{ url: string; method: string }> = [];
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/auth/session") {
      return { ok: true, json: async () => ({ user: { id: String(fixtureUserId(viewer)), discordUserId: fixtureDiscordId(viewer) } }) } as Response;
    }
    calls.push({ url, method });
    if (method === "POST" && /\/cancel$/.test(url)) return post();
    return { ok: true, json: async () => draft.current } as Response;
  });
  return calls;
}

const lastWsOptions = () => vi.mocked(useDraftWebsocket).mock.calls.at(-1)?.[1];

describe("DraftDetailPage: host cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    room.onCancel = undefined;
    lobby.onCancel = undefined;
    useDraftStore.setState(baseStoreState);
  });
  afterEach(() => {
    cleanup();
    useDraftStore.setState(baseStoreState);
  });

  describe("active draft room", () => {
    it("gives the host the control", async () => {
      stubFetch("host", { current: draftBody });
      render(<DraftDetailPage />);
      await waitFor(() => expect(screen.getByTestId("draft-room")).toHaveAttribute("data-host-action", "true"));
    });

    it("gives an owner who is not the host the control, from the server flag", async () => {
      stubFetch("owner", { current: { ...draftBody, canCancel: true } });
      render(<DraftDetailPage />);
      await waitFor(() => expect(screen.getByTestId("draft-room")).toHaveAttribute("data-host-action", "true"));
    });

    it("does not give another player the control", async () => {
      stubFetch("player", { current: draftBody });
      render(<DraftDetailPage />);
      await waitFor(() => expect(screen.getByTestId("draft-room")).toBeInTheDocument());
      expect(screen.getByTestId("draft-room")).toHaveAttribute("data-host-action", "false");
      expect(room.onCancel).toBeUndefined();
    });

    it("posts to /cancel and shows the cancelled state", async () => {
      const draft = { current: draftBody as Body };
      const calls = stubFetch("host", draft);
      render(<DraftDetailPage />);
      await waitFor(() => expect(room.onCancel).toBeDefined());
      draft.current = { ...draftBody, status: "cancelled" };
      await act(async () => room.onCancel?.());
      expect(calls.filter((c) => c.method === "POST")).toEqual([{ url: "/api/drafts/test-draft/cancel", method: "POST" }]);
      await waitFor(() => expect(screen.getByTestId("draft-summary-view")).toHaveAttribute("data-status", "cancelled"));
    });

    it("passes the server error to the dialog, and reads the draft again when it is not what the page shows", async () => {
      const calls = stubFetch("host", { current: draftBody }, async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "raw", code: "DRAFT_ALREADY_FINISHED" }),
      }));
      render(<DraftDetailPage />);
      await waitFor(() => expect(room.onCancel).toBeDefined());
      const before = calls.filter((c) => c.method === "GET").length;
      await expect(act(async () => room.onCancel?.())).rejects.toThrow(/already finished/);
      await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(before));
    });

    it("does not read the draft again for a plain 503", async () => {
      const calls = stubFetch("host", { current: draftBody }, async () => ({ ok: false, status: 503, json: async () => ({ error: "session_unavailable" }) }));
      render(<DraftDetailPage />);
      await waitFor(() => expect(room.onCancel).toBeDefined());
      const before = calls.filter((c) => c.method === "GET").length;
      await expect(act(async () => room.onCancel?.())).rejects.toThrow(/not available/);
      expect(calls.filter((c) => c.method === "GET").length).toBe(before);
    });
  });

  describe("lobby", () => {
    const pending = { ...draftBody, status: "pending", seats: [], myPool: [], currentPack: [] };

    it.each([
      ["the host", "host", pending, "true"],
      ["an owner who is not the host", "owner", { ...pending, canCancel: true }, "true"],
      ["another player", "player", pending, "false"],
    ])("offers Cancel to %s: %s", async (_label, viewer, body, expected) => {
      stubFetch(viewer, { current: body });
      render(<DraftDetailPage />);
      await waitFor(() => expect(screen.getByTestId("draft-manage-view")).toHaveAttribute("data-can-cancel", expected));
    });

    it("cancels with POST /cancel, not DELETE", async () => {
      const calls = stubFetch("host", { current: pending });
      render(<DraftDetailPage />);
      await waitFor(() => expect(lobby.onCancel).toBeDefined());
      await act(async () => lobby.onCancel?.());
      const writes = calls.filter((c) => c.method !== "GET");
      expect(writes).toEqual([{ url: "/api/drafts/test-draft/cancel", method: "POST" }]);
    });
  });

  describe("another player", () => {
    it("is told the draft was cancelled, and moves to the cancelled state", async () => {
      const draft = { current: draftBody as Body };
      stubFetch("player", draft);
      render(<DraftDetailPage />);
      await waitFor(() => expect(screen.getByTestId("draft-room")).toBeInTheDocument());

      draft.current = { ...draftBody, status: "cancelled" };
      act(() => lastWsOptions()?.onHostStopped?.("cancelled"));
      act(() => lastWsOptions()?.onStatusChange?.("cancelled"));

      const notice = await screen.findByRole("status");
      expect(notice).toHaveTextContent("The draft was cancelled");
      expect(notice).toHaveTextContent("No picks were kept");
      expect(notice).toHaveTextContent("Start a new draft");
      expect(screen.getByRole("link", { name: "All drafts" })).toHaveAttribute("href", "/drafts");
      await waitFor(() => expect(screen.getByTestId("draft-summary-view")).toHaveAttribute("data-status", "cancelled"));
    });

    it("is not told anything when the draft ends by itself", async () => {
      stubFetch("player", { current: draftBody });
      render(<DraftDetailPage />);
      await waitFor(() => expect(screen.getByTestId("draft-room")).toBeInTheDocument());
      // A natural finish arrives as draft:complete, which never calls onHostStopped.
      act(() => lastWsOptions()?.onResync?.());
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  it("does not tell the host about their own click, even when the socket answers first", async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    stubFetch("host", { current: draftBody }, async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ changed: true }) };
    });
    render(<DraftDetailPage />);
    await waitFor(() => expect(room.onCancel).toBeDefined());
    let sent: Promise<void> | undefined;
    act(() => {
      sent = room.onCancel?.();
    });
    // The echo from the socket arrives before the POST answer.
    act(() => lastWsOptions()?.onHostStopped?.("cancelled"));
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      finish();
      await sent;
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is not told about a stop made in another tab of the host", async () => {
    stubFetch("host", { current: draftBody });
    render(<DraftDetailPage />);
    await waitFor(() => expect(room.onCancel).toBeDefined());
    act(() => lastWsOptions()?.onHostStopped?.("cancelled"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tells an owner who is not the host about a later stop, after their own request failed", async () => {
    stubFetch("owner", { current: { ...draftBody, canCancel: true } }, async () => ({ ok: false, status: 503, json: async () => ({ error: "x" }) }));
    render(<DraftDetailPage />);
    await waitFor(() => expect(room.onCancel).toBeDefined());
    await expect(act(async () => room.onCancel?.())).rejects.toThrow();
    // The failed request cleared the self mark, so a later real change is announced.
    act(() => lastWsOptions()?.onHostStopped?.("cancelled"));
    expect(await screen.findByRole("status")).toHaveTextContent("The draft was cancelled");
  });

  it("does not tell an owner about their own click, even when the socket answers first", async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    stubFetch("owner", { current: { ...draftBody, canCancel: true } }, async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ changed: true }) };
    });
    render(<DraftDetailPage />);
    await waitFor(() => expect(room.onCancel).toBeDefined());
    let sent: Promise<void> | undefined;
    act(() => {
      sent = room.onCancel?.();
    });
    act(() => lastWsOptions()?.onHostStopped?.("cancelled"));
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      finish();
      await sent;
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
