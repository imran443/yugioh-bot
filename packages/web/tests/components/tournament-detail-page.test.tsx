// @vitest-environment jsdom
//
// Integration spec for the tabbed tournament page. Carries forward the
// behavioral intent of PR #28/#29 (Kanban board, my-matches filter, empty
// state, accessible report actions, dev Add Bot) adapted to the tabbed
// architecture: the matches board lives in the All Matches tab, "my
// matches" is its own tab, and Add Bot lives in the pending lobby.
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "goat-cup" }),
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/hooks/use-tournament-websocket", () => ({
  useTournamentWebsocket: () => {},
}));

import TournamentDetailPage from "../../app/(app)/tournament/[slug]/page";

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
  currentUserPlayerId: 11 as number | null,
  matches: [
    { id: 101, matchId: 1001, roundNumber: 1, playerOneId: 11, playerTwoId: 22, playerOneName: "Alice", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {} },
    { id: 102, matchId: 1002, roundNumber: 1, playerOneId: 33, playerTwoId: 44, playerOneName: "Carol", playerTwoName: "Dave", status: "completed", winnerId: 33, reporterId: null, metadata: {} },
    { id: 103, matchId: 1003, roundNumber: 2, playerOneId: 11, playerTwoId: 33, playerOneName: "Alice", playerTwoName: "Carol", status: "pending_approval", winnerId: null, reporterId: 33, metadata: {} },
  ],
};

const roundRobinTournament = {
  id: 2,
  name: "Round Robin Cup",
  format: "round_robin",
  status: "active",
  createdByUserId: "user-1",
  participants: [
    { playerId: 11, displayName: "Alice" },
    { playerId: 22, displayName: "Bob" },
    { playerId: 33, displayName: "Carol" },
  ],
  isParticipant: false,
  currentUserPlayerId: null as number | null,
  matches: [
    { id: 201, matchId: 2001, roundNumber: 1, playerOneId: 11, playerTwoId: 22, playerOneName: "Alice", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {} },
    { id: 202, matchId: 2002, roundNumber: 2, playerOneId: 11, playerTwoId: 33, playerOneName: "Alice", playerTwoName: "Carol", status: "completed", winnerId: 11, reporterId: null, metadata: {} },
    { id: 203, matchId: 2003, roundNumber: 3, playerOneId: 22, playerTwoId: 33, playerOneName: "Bob", playerTwoName: "Carol", status: "completed", winnerId: 22, reporterId: null, metadata: {} },
  ],
};

const singleElimTournament = {
  id: 3,
  name: "Single Elim Cup",
  format: "single_elim",
  status: "active",
  createdByUserId: "user-1",
  participants: [
    { playerId: 11, displayName: "Alice" },
    { playerId: 22, displayName: "Bob" },
    { playerId: 33, displayName: "Carol" },
    { playerId: 44, displayName: "Dave" },
  ],
  isParticipant: false,
  currentUserPlayerId: null as number | null,
  matches: [
    { id: 301, matchId: 3001, roundNumber: 1, playerOneId: 11, playerTwoId: 22, playerOneName: "Alice", playerTwoName: "Bob", status: "completed", winnerId: 11, reporterId: null, metadata: {} },
    { id: 302, matchId: 3002, roundNumber: 1, playerOneId: 33, playerTwoId: 44, playerOneName: "Carol", playerTwoName: "Dave", status: "completed", winnerId: 33, reporterId: null, metadata: {} },
    { id: 303, matchId: 3003, roundNumber: 2, playerOneId: 11, playerTwoId: 33, playerOneName: "Alice", playerTwoName: "Carol", status: "open", winnerId: null, reporterId: null, metadata: {} },
  ],
};

function stubFetch(overrides?: {
  currentUserPlayerId?: number | null;
  status?: string;
  tournamentData?: typeof tournament;
}) {
  const base = overrides?.tournamentData ?? tournament;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/session") {
      return Response.json({ user: { id: "user-1" } });
    }
    if (url === "/api/tournaments/goat-cup") {
      return Response.json({
        ...base,
        status: overrides?.status ?? base.status,
        currentUserPlayerId: overrides?.currentUserPlayerId ?? base.currentUserPlayerId,
      });
    }
    if (url === "/api/tournaments/goat-cup/join-bot") {
      return Response.json({ success: true, displayName: "Bot 1", playerId: 99 });
    }
    return Response.json([], { status: 200 });
  });
}

function renderPage(tournamentData: typeof tournament) {
  vi.stubGlobal("fetch", stubFetch({ tournamentData }));
  render(<TournamentDetailPage />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
});

describe("TournamentDetailPage (tabbed integration)", () => {
  it("renders the matches board on the All Matches tab inside a wide shell", async () => {
    searchParams = new URLSearchParams("tab=all");
    vi.stubGlobal("fetch", stubFetch());

    render(<TournamentDetailPage />);

    expect(await screen.findByTestId("tournament-round-board")).toBeInTheDocument();
    expect(screen.getByTestId("tournament-page-shell")).toHaveClass("max-w-[120rem]");
    expect(screen.getByTestId("tournament-round-board")).toHaveClass("xl:overflow-visible");
    expect(screen.getByTestId("tournament-round-board-grid")).toHaveClass("xl:grid");
    expect(screen.getByTestId("tournament-round-board-grid")).toHaveClass("2xl:flex-wrap");
    expect(screen.getByTestId("tournament-round-column-1")).toBeInTheDocument();
    expect(screen.getByTestId("tournament-round-column-2")).toBeInTheDocument();
    expect(screen.getByTestId("tournament-round-column-1")).toHaveClass("2xl:min-w-[28rem]");
    expect(screen.getByTestId("tournament-match-card-101")).toHaveClass("2xl:p-5");
    expect(screen.getByTestId("tournament-match-card-header-101")).toHaveClass("lg:flex-col");
    expect(screen.getByTestId("tournament-match-card-actions-101")).toHaveClass("w-full");
  });

  it("My Matches tab shows only the current user's matches", async () => {
    searchParams = new URLSearchParams("tab=my");
    vi.stubGlobal("fetch", stubFetch());

    render(<TournamentDetailPage />);

    const board = await screen.findByTestId("tournament-round-board");
    expect(within(board).getAllByText("Alice").length).toBeGreaterThan(0);
    expect(within(board).queryByText("Dave")).toBeNull();
  });

  it("My Matches tab shows an empty state when the user has no matches", async () => {
    searchParams = new URLSearchParams("tab=my");
    vi.stubGlobal("fetch", stubFetch({ currentUserPlayerId: 99 }));

    render(<TournamentDetailPage />);

    expect(await screen.findByText(/you do not have any matches/i)).toBeInTheDocument();
  });

  it("keeps report actions accessible in the board layout", async () => {
    searchParams = new URLSearchParams("tab=all");
    vi.stubGlobal("fetch", stubFetch());

    render(<TournamentDetailPage />);

    expect(await screen.findByRole("button", { name: /report/i })).toBeInTheDocument();
  });

  it("shows Add Bot for the organizer on a pending tournament and calls the route", async () => {
    const fetchMock = stubFetch({ status: "pending" });
    vi.stubGlobal("fetch", fetchMock);

    render(<TournamentDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: /add bot/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/goat-cup/join-bot", { method: "POST" });
    });
  });

  it("round-robin overview shows match progress but NOT a round number", async () => {
    renderPage(roundRobinTournament);
    expect(await screen.findByText(/2\/3 matches done/i)).toBeTruthy();
    expect(screen.queryByText(/round \d+ of \d+/i)).toBeNull();
  });

  it("single-elim overview still shows the current round", async () => {
    renderPage(singleElimTournament);
    expect(await screen.findByText(/round 2 of 2/i)).toBeTruthy();
    expect(screen.getByText(/2\/3 matches done/i)).toBeTruthy();
  });

  it("active overview shows Recent Results for completed matches", async () => {
    renderPage(roundRobinTournament);
    expect(await screen.findByText(/recent results/i)).toBeInTheDocument();
    // round-robin fixture has two completed matches → at least one "def." line
    expect(screen.getAllByText(/def\./i).length).toBeGreaterThan(0);
  });

  it("organizer can cancel an ACTIVE tournament from the Overview", async () => {
    // tournament fixture: status active, createdByUserId 'user-1' === session user.
    searchParams = new URLSearchParams("tab=overview");
    vi.stubGlobal("fetch", stubFetch());

    render(<TournamentDetailPage />);

    expect(await screen.findByRole("button", { name: /cancel tournament/i })).toBeInTheDocument();
  });

  it("organizer can end an ACTIVE tournament from the Overview", async () => {
    // tournament fixture: status active, createdByUserId 'user-1' === session user.
    searchParams = new URLSearchParams("tab=overview");
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<TournamentDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: /end tournament now/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, end now/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/goat-cup/complete", { method: "POST" });
    });
  });
});
