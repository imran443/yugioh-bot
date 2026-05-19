// @vitest-environment jsdom
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchBoard } from "../../src/components/tournament/match-board";
import type { Match } from "../../src/components/tournament/types";

const matches: Match[] = [
  { id: 101, matchId: 1001, roundNumber: 1, playerOneId: 11, playerTwoId: 22, playerOneName: "Alice", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {} },
  { id: 102, matchId: 1002, roundNumber: 1, playerOneId: 33, playerTwoId: 44, playerOneName: "Carol", playerTwoName: "Dave", status: "completed", winnerId: 33, reporterId: null, metadata: {} },
  { id: 103, matchId: 1003, roundNumber: 2, playerOneId: 11, playerTwoId: 33, playerOneName: "Alice", playerTwoName: "Carol", status: "open", winnerId: null, reporterId: null, metadata: {} },
];

afterEach(() => { vi.clearAllMocks(); });

describe("MatchBoard", () => {
  it("renders rounds as horizontal board columns with responsive classes", () => {
    render(
      <MatchBoard
        matches={matches}
        tournamentSlug="goat-cup"
        tournamentFormat="single_elim"
        currentUserPlayerId={11}
        isHost={false}
        onChanged={() => {}}
      />,
    );

    const board = screen.getByTestId("tournament-round-board");
    expect(board).toBeInTheDocument();
    expect(board).toHaveClass("xl:overflow-visible");

    const grid = screen.getByTestId("tournament-round-board-grid");
    expect(grid).toHaveClass("xl:grid");
    expect(grid).toHaveClass("2xl:flex-wrap");

    expect(screen.getByTestId("tournament-round-column-1")).toBeInTheDocument();
    expect(screen.getByTestId("tournament-round-column-2")).toBeInTheDocument();
    expect(screen.getByTestId("tournament-round-column-1")).toHaveClass("2xl:min-w-[28rem]");
  });

  it("places each match in its round column", () => {
    render(
      <MatchBoard
        matches={matches}
        tournamentSlug="goat-cup"
        tournamentFormat="single_elim"
        currentUserPlayerId={11}
        isHost={false}
        onChanged={() => {}}
      />,
    );

    const round1 = screen.getByTestId("tournament-round-column-1");
    expect(within(round1).getByText("Alice")).toBeInTheDocument();
    expect(within(round1).getByText("Dave")).toBeInTheDocument();

    const round2 = screen.getByTestId("tournament-round-column-2");
    expect(within(round2).getByText("Carol")).toBeInTheDocument();
    expect(within(round2).queryByText("Dave")).toBeNull();
  });

  it("shows the empty-state message when there are no matches", () => {
    render(
      <MatchBoard
        matches={[]}
        tournamentSlug="goat-cup"
        tournamentFormat="single_elim"
        currentUserPlayerId={11}
        isHost={false}
        onChanged={() => {}}
        emptyMessage="You do not have any matches in this view yet."
      />,
    );

    expect(screen.getByText(/you do not have any matches/i)).toBeInTheDocument();
    expect(screen.queryByTestId("tournament-round-board")).toBeNull();
  });
});
