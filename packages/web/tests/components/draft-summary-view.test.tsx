// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DraftSummaryView } from "../../src/components/draft/draft-summary-view";

const baseDraft = {
  id: 1,
  name: "Legendary Draft",
  status: "completed",
  createdByUserId: "creator-1",
  createdAt: "2026-05-06T12:00:00.000Z",
  endedAt: "2026-05-06T12:30:00.000Z",
  config: {
    packSize: 5,
    packsPerPlayer: 3,
    pickSeconds: 60,
    setNames: ["Legend of Blue Eyes White Dragon", "Metal Raiders", "Spell Ruler"],
  },
  players: [
    {
      playerId: 1,
      displayName: "You",
      seatIndex: 0,
      pickCount: 15,
      joinedAt: "2026-05-06T12:00:00.000Z",
    },
  ],
  playerCount: 1,
};

describe("DraftSummaryView", () => {
  it("hides YDK export for completed drafts with fewer than 40 picks", () => {
    render(
      <DraftSummaryView
        draft={{ ...baseDraft, participantPickCount: 15 } as any}
        isParticipant={true}
        onExportYdk={vi.fn().mockResolvedValue("#main")}
      />
    );

    expect(screen.queryByRole("button", { name: /export ydk/i })).toBeNull();
    expect(screen.getByText(/requires 40 picks/i)).toBeTruthy();
  });
});
