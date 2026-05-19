// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyMatchesTab } from "../../src/components/tournament/my-matches-tab";
import { AllMatchesTab } from "../../src/components/tournament/all-matches-tab";
import { StandingsTab } from "../../src/components/tournament/standings-tab";
import type { TournamentDetail } from "../../src/components/tournament/types";

const t: TournamentDetail = {
  id: 1, name: "RR", format: "round_robin", status: "active", createdByUserId: "host",
  isParticipant: true, currentUserPlayerId: 10,
  participants: [{ playerId: 10, displayName: "Me" }, { playerId: 20, displayName: "Bob" }],
  matches: [
    { id: 1, matchId: null, roundNumber: 1, playerOneId: 10, playerTwoId: 20, playerOneName: "Me", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {} },
    { id: 2, matchId: null, roundNumber: 1, playerOneId: 20, playerTwoId: 30, playerOneName: "Bob", playerTwoName: "Cy", status: "open", winnerId: null, reporterId: null, metadata: {} },
  ],
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("tournament tab panels", () => {
  it("MyMatchesTab shows only the user's matches", () => {
    render(<MyMatchesTab tournament={t} tournamentSlug="s1" onChanged={() => {}} />);
    expect(screen.getByText(/me/i)).toBeTruthy();
    expect(screen.queryByText(/cy/i)).toBeNull();
  });

  it("AllMatchesTab groups by round", () => {
    render(<AllMatchesTab tournament={t} tournamentSlug="s1" onChanged={() => {}} />);
    expect(screen.getByText(/round 1/i)).toBeTruthy();
  });

  it("StandingsTab fetches and renders standings", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([{ playerId: 10, displayName: "Me", wins: 2, losses: 0 }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<StandingsTab tournamentSlug="s1" />);
    await waitFor(() => expect(screen.getByText("Me")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/s1/standings");
  });
});
