// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewRecentResults } from "../../src/components/tournament/overview-recent-results";
import type { Match } from "../../src/components/tournament/types";

function match(over: Partial<Match>): Match {
  return {
    id: 1,
    matchId: 1,
    roundNumber: 1,
    playerOneId: 11,
    playerTwoId: 22,
    playerOneName: "Alice",
    playerTwoName: "Bob",
    status: "completed",
    winnerId: 11,
    reporterId: null,
    resolvedAt: null,
    metadata: {},
    ...over,
  };
}

describe("OverviewRecentResults", () => {
  it("renders an empty state when there are no completed matches", () => {
    render(<OverviewRecentResults matches={[match({ status: "open", winnerId: null })]} />);
    expect(screen.getByText(/no results yet/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows '<winner> def. <loser>' newest-first and caps at 5", () => {
    const matches: Match[] = [
      match({ id: 1, winnerId: 11, resolvedAt: "2026-05-01T10:00:00Z" }),
      match({ id: 2, winnerId: 22, resolvedAt: "2026-05-03T10:00:00Z" }),
      match({ id: 3, winnerId: 11, resolvedAt: "2026-05-02T10:00:00Z" }),
    ];
    render(<OverviewRecentResults matches={matches} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // newest (id:2, 05-03) first → "Bob def. Alice"
    expect(items[0]).toHaveTextContent(/bob\s+def\.\s+alice/i);
    expect(items[1]).toHaveTextContent(/alice\s+def\.\s+bob/i); // id:3, 05-02
  });

  it("ignores non-completed and winner-less matches", () => {
    const matches: Match[] = [
      match({ id: 1, status: "open", winnerId: null }),
      match({ id: 2, status: "completed", winnerId: 22, resolvedAt: "2026-05-03T10:00:00Z" }),
    ];
    render(<OverviewRecentResults matches={matches} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
