// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RankBadge } from "../../src/components/rank/rank-badge";

beforeEach(() => {
  window.localStorage.clear();
});

describe("RankBadge celebration", () => {
  it("pops and records the tier when the player ranked up", async () => {
    window.localStorage.setItem("rank:lastSeen:7", "Silver");
    render(<RankBadge rank="Gold" celebrate playerId={7} />);
    await waitFor(() =>
      expect(screen.getByTestId("rank-badge").className).toContain("rank-pop"),
    );
    expect(window.localStorage.getItem("rank:lastSeen:7")).toBe("Gold");
  });

  it("does not pop on a first-ever view but still records the tier", async () => {
    render(<RankBadge rank="Diamond" celebrate playerId={9} />);
    await waitFor(() =>
      expect(window.localStorage.getItem("rank:lastSeen:9")).toBe("Diamond"),
    );
    expect(screen.getByTestId("rank-badge").className).not.toContain("rank-pop");
  });

  it("does not touch storage or pop when celebrate is off", () => {
    window.localStorage.setItem("rank:lastSeen:3", "Bronze");
    render(<RankBadge rank="Diamond" playerId={3} />);
    expect(window.localStorage.getItem("rank:lastSeen:3")).toBe("Bronze");
    expect(screen.getByTestId("rank-badge").className).not.toContain("rank-pop");
  });
});
