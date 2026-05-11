// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftCardPreview } from "../../src/components/draft/draft-card-preview";
import { useDraftStore } from "../../src/lib/stores/draft-store";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, priority: _priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; priority?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

const baseState = {
  slug: "legendary-draft",
  packRound: 1,
  pickStep: 1,
  currentPack: [],
  myPool: [],
  seats: [],
  timerSeconds: 0,
  isMyTurn: true,
  completed: false,
  pickSeconds: 60,
  previewCardId: null,
  selectedCardId: null,
  highlightedIndex: -1,
};

const samplePack = [
  {
    id: 101,
    name: "Mirror Force",
    type: "Trap Card",
    frameType: "trap",
    effectText: "Destroy all attack position monsters your opponent controls.",
    imageUrl: "https://img/full/101",
    imageUrlSmall: "https://img/small/101",
  },
];

describe("DraftCardPreview", () => {
  beforeEach(() => {
    useDraftStore.setState(baseState);
  });

  afterEach(() => {
    useDraftStore.setState(baseState);
  });

  it("stays hidden before a card is hovered", () => {
    useDraftStore.setState({ ...baseState, currentPack: samplePack });

    render(<DraftCardPreview />);

    expect(screen.queryByTestId("draft-card-preview")).toBeNull();
    expect(screen.queryByTestId("draft-card-preview-image")).toBeNull();
  });

  it("renders the full-resolution image without card detail text", () => {
    useDraftStore.setState({ ...baseState, currentPack: samplePack, previewCardId: 101 });

    render(<DraftCardPreview />);

    const preview = screen.getByTestId("draft-card-preview");
    const art = screen.getByTestId("draft-card-preview-art");
    const image = screen.getByTestId("draft-card-preview-image");

    expect(preview).toHaveClass("fixed");
    expect(preview).toHaveClass("pointer-events-none");
    expect(preview).toHaveClass("bottom-[5.625rem]");
    expect(preview).toHaveClass("left-[17.5rem]");
    expect(preview).toHaveClass("hidden");
    expect(preview).toHaveClass("xl:block");
    expect(preview).toHaveClass("w-full");
    expect(preview).toHaveClass("max-w-[30.45rem]");
    expect(art).toHaveClass("aspect-[421/614]");
    expect(image).toHaveAttribute("src", "https://img/full/101");
    expect(image).toHaveAttribute("sizes", "(min-width: 1536px) 488px, 0px");
    expect(image).toHaveClass("object-contain");
    expect(screen.queryByText("Mirror Force")).toBeNull();
    expect(screen.queryByText(/destroy all attack position/i)).toBeNull();
  });

  it("shows a no-image fallback if the full image fails", () => {
    useDraftStore.setState({ ...baseState, currentPack: samplePack, previewCardId: 101 });

    render(<DraftCardPreview />);

    fireEvent.error(screen.getByTestId("draft-card-preview-image"));

    expect(screen.getByTestId("draft-card-preview-art")).toHaveTextContent(/no image/i);
  });
});
