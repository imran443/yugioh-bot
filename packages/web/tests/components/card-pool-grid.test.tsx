// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CardPoolGrid } from "../../src/components/cards/card-pool-grid";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));
import type { CardSummary } from "../../src/lib/card-types";

const cards: CardSummary[] = [
  { id: 1, name: "Bujingi Crane", type: "Winged Beast / Effect Monster", frameType: "effect", effectText: "...", imageUrl: "u1", imageUrlSmall: "s1" },
  { id: 2, name: "Mirror Force", type: "Trap Card", frameType: "trap", effectText: "...", imageUrl: "u2", imageUrlSmall: "s2" },
  { id: 3, name: "Monster Reborn", type: "Spell Card", frameType: "spell", effectText: "...", imageUrl: "u3", imageUrlSmall: "s3" },
];

describe("CardPoolGrid", () => {
  it("renders a tile per card with an accessible preview label", () => {
    render(<CardPoolGrid cards={cards} />);
    expect(screen.getByRole("button", { name: /preview bujingi crane/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /preview mirror force/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /preview monster reborn/i })).toBeTruthy();
  });

  it("narrows by search", () => {
    render(<CardPoolGrid cards={cards} />);
    fireEvent.change(screen.getByLabelText(/search cards/i), { target: { value: "mirror" } });
    expect(screen.queryByRole("button", { name: /preview bujingi crane/i })).toBeNull();
    expect(screen.getByRole("button", { name: /preview mirror force/i })).toBeTruthy();
  });

  it("narrows by type filter", () => {
    render(<CardPoolGrid cards={cards} />);
    fireEvent.click(screen.getByRole("button", { name: /^traps$/i }));
    expect(screen.getByRole("button", { name: /preview mirror force/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /preview monster reborn/i })).toBeNull();
  });

  it("shows the empty message when there are no cards", () => {
    render(<CardPoolGrid cards={[]} emptyMessage="Nothing here yet." />);
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
  });

  it("shows a skeleton while loading with no cards", () => {
    render(<CardPoolGrid cards={[]} loading />);
    expect(screen.getByTestId("card-pool-grid-skeleton")).toBeTruthy();
  });

  it("shows an updating overlay while loading with cards present", () => {
    render(<CardPoolGrid cards={cards} loading />);
    expect(screen.getByText(/updating/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /preview bujingi crane/i })).toBeTruthy();
  });

  it("renders unknownIds as placeholder tiles", () => {
    render(<CardPoolGrid cards={cards} unknownIds={[99999999]} />);
    const placeholder = screen.getByText(/99999999/);
    expect(placeholder).toBeTruthy();
    expect(within(placeholder.closest("[data-testid='card-pool-grid-unknown']") as HTMLElement).getByText(/not in catalog/i)).toBeTruthy();
  });

  it("opens the preview popup on focus", () => {
    render(<CardPoolGrid cards={cards} />);
    fireEvent.focus(screen.getByRole("button", { name: /preview mirror force/i }));
    // CardHoverPopup renders the card name as a heading
    expect(screen.getAllByText("Mirror Force").length).toBeGreaterThan(1);
  });
});
