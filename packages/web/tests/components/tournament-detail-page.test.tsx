// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TournamentDetailPage from "../../app/(app)/tournament/[slug]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "goat-cup" }),
}));

vi.mock("../../src/lib/hooks/use-tournament-websocket", () => ({
  useTournamentWebsocket: vi.fn(),
}));

const tournament = {
  id: 1,
  name: "Goat Cup",
  format: "single_elim",
  status: "active",
  createdByUserId: "user-1",
  participants: [
    { playerId: 11, displayName: "Alice" },
    { playerId: 22, displayName: "Bob" },
    { playerId: 33, displayName: "Carol" },
    { playerId: 44, displayName: "Dave" },
  ],
  isParticipant: true,
  currentUserPlayerId: 11,
  matches: [
    {
      id: 101,
      matchId: 1001,
      roundNumber: 1,
      playerOneId: 11,
      playerTwoId: 22,
      playerOneName: "Alice",
      playerTwoName: "Bob",
      status: "open",
      winnerId: null,
      reporterId: null,
      metadata: {},
    },
    {
      id: 102,
      matchId: 1002,
      roundNumber: 1,
      playerOneId: 33,
      playerTwoId: 44,
      playerOneName: "Carol",
      playerTwoName: "Dave",
      status: "completed",
      winnerId: 33,
      reporterId: null,
      metadata: {},
    },
    {
      id: 103,
      matchId: 1003,
      roundNumber: 2,
      playerOneId: 11,
      playerTwoId: 33,
      playerOneName: "Alice",
      playerTwoName: "Carol",
      status: "pending_approval",
      winnerId: null,
      reporterId: 33,
      metadata: {},
    },
  ],
};

function stubFetch(overrides?: {
  currentUserPlayerId?: number | null;
  matches?: typeof tournament.matches;
  createdByUserId?: string;
  status?: string;
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/session") {
      return Response.json({ user: { id: "user-1" } });
    }
    if (url === "/api/tournaments/goat-cup") {
      return Response.json({
        ...tournament,
        createdByUserId: overrides?.createdByUserId ?? tournament.createdByUserId,
        status: overrides?.status ?? tournament.status,
        currentUserPlayerId: overrides?.currentUserPlayerId ?? tournament.currentUserPlayerId,
        matches: overrides?.matches ?? tournament.matches,
      });
    }
    if (url === "/api/tournaments/goat-cup/join-bot") {
      return Response.json({ success: true, displayName: "Bot 1", playerId: 99 });
    }
    return Response.json({}, { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TournamentDetailPage", () => {
  it("renders rounds as horizontal board columns", async () => {
    vi.stubGlobal("fetch", stubFetch());

    render(<TournamentDetailPage />);

    expect(await screen.findByTestId("tournament-round-board")).toBeInTheDocument();
    expect(screen.getByTestId("tournament-round-column-1")).toBeInTheDocument();
    expect(screen.getByTestId("tournament-round-column-2")).toBeInTheDocument();
    expect(screen.getByTestId("tournament-page-shell")).toHaveClass("max-w-7xl");
    expect(screen.getByTestId("tournament-round-board")).toHaveClass("xl:overflow-visible");
    expect(screen.getByTestId("tournament-round-board-grid")).toHaveClass("xl:grid");
  });

  it("filters to the current user's matches", async () => {
    vi.stubGlobal("fetch", stubFetch());

    render(<TournamentDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: /my matches/i }));

    await waitFor(() => {
      const board = screen.getByTestId("tournament-round-board");
      expect(within(board).getAllByText("Alice").length).toBeGreaterThan(0);
      expect(within(board).queryByText("Dave")).toBeNull();
    });
  });

  it("shows an empty state when my matches has no visible matches", async () => {
    vi.stubGlobal("fetch", stubFetch({ currentUserPlayerId: 99 }));

    render(<TournamentDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: /my matches/i }));

    expect(await screen.findByText(/you do not have any matches/i)).toBeInTheDocument();
  });

  it("keeps report actions accessible in the board layout", async () => {
    vi.stubGlobal("fetch", stubFetch());

    render(<TournamentDetailPage />);

    expect(await screen.findByRole("button", { name: /report/i })).toBeInTheDocument();
  });

  it("shows Add Bot for the organizer on pending tournaments in development and calls the route", async () => {
    const fetchMock = stubFetch({ status: "pending" });
    vi.stubGlobal("fetch", fetchMock);

    render(<TournamentDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: /add bot/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/goat-cup/join-bot", { method: "POST" });
    });
  });
});
