// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RankBadge } from "../../src/components/rank/rank-badge";

describe("RankBadge", () => {
  it("renders the tier name", () => {
    render(<RankBadge rank="Gold" />);
    expect(screen.getByText("Gold")).toBeInTheDocument();
  });

  it("applies the per-tier idle class when animated", () => {
    render(<RankBadge rank="Diamond" />);
    expect(screen.getByTestId("rank-badge").className).toContain("rank-idle-diamond");
  });

  it("gives Bronze no idle class", () => {
    render(<RankBadge rank="Bronze" />);
    expect(screen.getByTestId("rank-badge").className).not.toContain("rank-idle");
  });

  it("omits idle animation when animate is false", () => {
    render(<RankBadge rank="Diamond" animate={false} />);
    expect(screen.getByTestId("rank-badge").className).not.toContain("rank-idle");
  });

  it("renders two twinkles only for Diamond", () => {
    const { container, rerender } = render(<RankBadge rank="Diamond" />);
    expect(container.querySelectorAll(".rank-twinkle").length).toBe(2);
    rerender(<RankBadge rank="Gold" />);
    expect(container.querySelectorAll(".rank-twinkle").length).toBe(0);
  });

  it("falls back to a gray badge for an unknown rank", () => {
    render(<RankBadge rank="Unranked" />);
    const el = screen.getByTestId("rank-badge");
    expect(el).toHaveTextContent("Unranked");
    expect(el.className).not.toContain("rank-idle");
  });
});
