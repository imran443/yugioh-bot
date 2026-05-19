// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YourActionCard } from "../../src/components/tournament/your-action-card";
import type { Match } from "../../src/components/tournament/types";

const openMine: Match = {
  id: 1, matchId: null, roundNumber: 2, playerOneId: 10, playerTwoId: 20,
  playerOneName: "Me", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {},
};

describe("YourActionCard", () => {
  it("prompts to report when the action match is an open match", () => {
    render(
      <YourActionCard
        actionMatch={openMine}
        tournamentSlug="s1"
        tournamentFormat="round_robin"
        currentUserPlayerId={10}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/your match/i)).toBeTruthy();
    expect(screen.getByText(/round 2/i)).toBeTruthy();
  });

  it("shows a caught-up state when there is no action match", () => {
    render(
      <YourActionCard
        actionMatch={null}
        tournamentSlug="s1"
        tournamentFormat="round_robin"
        currentUserPlayerId={10}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/caught up/i)).toBeTruthy();
  });
});
