// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchCard } from "../../src/components/tournament/match-card";
import type { Match } from "../../src/components/tournament/types";

const completed: Match = {
  id: 3, matchId: 9, roundNumber: 1, playerOneId: 10, playerTwoId: 20,
  playerOneName: "Me", playerTwoName: "Bob", status: "completed",
  winnerId: 10, reporterId: 10, metadata: {},
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("MatchCard host reopen", () => {
  it("shows Reopen for the host on a completed round-robin match and posts to the reopen API", async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onResolved = vi.fn();
    render(
      <MatchCard
        match={completed}
        tournamentSlug="slug1"
        tournamentFormat="round_robin"
        currentUserPlayerId={99}
        isHost
        isReporting={false}
        onReport={() => {}}
        onCancelReport={() => {}}
        onReported={() => {}}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reopen/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tournaments/slug1/reopen",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it("does not show Reopen for single-elim", () => {
    render(
      <MatchCard
        match={completed}
        tournamentSlug="slug1"
        tournamentFormat="single_elim"
        currentUserPlayerId={99}
        isHost
        isReporting={false}
        onReport={() => {}}
        onCancelReport={() => {}}
        onReported={() => {}}
        onResolved={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /reopen/i })).toBeNull();
  });
});
