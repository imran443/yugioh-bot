// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "slug1" }),
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/hooks/use-tournament-websocket", () => ({
  useTournamentWebsocket: () => {},
}));

import TournamentDetailPage from "../../app/(app)/tournament/[slug]/page";

const activeTournament = {
  id: 1, name: "RR", format: "round_robin", status: "active", createdByUserId: "host",
  isParticipant: true, currentUserPlayerId: 10,
  participants: [{ playerId: 10, displayName: "Me" }],
  matches: [{ id: 1, matchId: null, roundNumber: 1, playerOneId: 10, playerTwoId: 20, playerOneName: "Me", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {} }],
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); searchParams = new URLSearchParams(); });

describe("tournament page shell", () => {
  it("renders the tab bar for an active tournament and defaults to Overview", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/auth/session") return Response.json({ user: { id: "host" } });
      if (url === "/api/tournaments/slug1") return Response.json(activeTournament);
      return Response.json([], { status: 200 });
    }));
    render(<TournamentDetailPage />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeTruthy());
    expect(screen.getByRole("tab", { name: /overview/i }).getAttribute("aria-selected")).toBe("true");
  });
});
