// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TournamentLobby } from "../../src/components/tournament/tournament-lobby";
import type { TournamentDetail } from "../../src/components/tournament/types";

const pending: TournamentDetail = {
  id: 1, name: "Friday", format: "round_robin", status: "pending", createdByUserId: "host",
  isParticipant: false, currentUserPlayerId: null,
  startedAt: null, createdAt: "2026-01-01T00:00:00Z",
  participants: [{ playerId: 1, displayName: "Ann" }],
  matches: [],
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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

  it("shows Add Bot for the organizer in dev and posts to the join-bot route", async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, displayName: "Bot 1" }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();

    render(
      <TournamentLobby
        tournament={pending}
        tournamentSlug="slug1"
        isCreator
        currentUserId="host"
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add bot/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/slug1/join-bot", { method: "POST" }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("does not show Add Bot to non-organizers", () => {
    render(
      <TournamentLobby
        tournament={pending}
        tournamentSlug="slug1"
        isCreator={false}
        currentUserId="someone"
        onChanged={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /add bot/i })).toBeNull();
  });
});
