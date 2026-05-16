// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CardPoolPanel } from "../../src/components/cards/card-pool-panel";
import type { CardSummary } from "../../src/lib/card-types";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

const cards: CardSummary[] = [
  { id: 1, name: "Bujingi Crane", type: "Winged Beast / Effect Monster", frameType: "effect", effectText: "", imageUrl: "u1", imageUrlSmall: "s1" },
  { id: 2, name: "Mirror Force", type: "Trap Card", frameType: "trap", effectText: "", imageUrl: "u2", imageUrlSmall: "s2", qty: 3 },
];

describe("CardPoolPanel", () => {
  it("renders the title and a distinct-count summary", () => {
    render(<CardPoolPanel cards={cards} title="Cube Pool" />);
    expect(screen.getByText("Cube Pool")).toBeTruthy();
    expect(screen.getByText(/2 cards/i)).toBeTruthy();
  });

  it("shows total copies when any qty > 1 and countMode is copies", () => {
    render(<CardPoolPanel cards={cards} title="Cube Pool" countMode="copies" />);
    // 1 (qty undefined => 1) + 3 = 4 copies across 2 distinct types
    expect(screen.getByText(/2 cards/i)).toBeTruthy();
    expect(screen.getByText(/4 copies/i)).toBeTruthy();
  });

  it("collapses to just the card count when every qty is 1", () => {
    render(
      <CardPoolPanel
        cards={[{ ...cards[0] }, { ...cards[1], qty: 1 }]}
        title="Cube Pool"
        countMode="copies"
      />,
    );
    expect(screen.getByText(/2 cards/i)).toBeTruthy();
    expect(screen.queryByText(/copies/i)).toBeNull();
  });

  it("renders an error slot", () => {
    render(<CardPoolPanel cards={[]} title="Cube Pool" error="Failed to resolve cards." />);
    expect(screen.getByText("Failed to resolve cards.")).toBeTruthy();
  });

  it("delegates to the grid (renders a preview tile per card)", () => {
    render(<CardPoolPanel cards={cards} title="Cube Pool" />);
    expect(screen.getByRole("button", { name: /preview bujingi crane/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /preview mirror force/i })).toBeTruthy();
  });
});
