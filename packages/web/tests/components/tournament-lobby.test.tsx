// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TournamentLobby } from "../../src/components/tournament/tournament-lobby";
import type { TournamentDetail } from "../../src/components/tournament/types";

const pending: TournamentDetail = {
  id: 1, name: "Friday", format: "round_robin", status: "pending", createdByUserId: "host",
  isParticipant: false, currentUserPlayerId: null,
  participants: [{ playerId: 1, displayName: "Ann" }],
  matches: [],
};

describe("TournamentLobby", () => {
  it("renders invite link and players for a pending tournament", () => {
    render(
      <TournamentLobby
        tournament={pending}
        tournamentSlug="slug1"
        isCreator={false}
        currentUserId={null}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/invite link/i)).toBeTruthy();
    expect(screen.getByText("Ann")).toBeTruthy();
  });
});
