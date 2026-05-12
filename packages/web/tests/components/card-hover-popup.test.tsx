// packages/web/tests/components/card-hover-popup.test.tsx
// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CardHoverPopup } from "../../src/components/draft/card-hover-popup";
import type { CardSummary } from "../../src/lib/card-types";

const card: CardSummary = {
  id: 1, name: "Mirror Force", type: "Trap Card", frameType: "trap",
  effectText: "Destroy all attack position monsters.", imageUrl: "u", imageUrlSmall: "s",
};

describe("CardHoverPopup", () => {
  it("renders the card name and effect", () => {
    render(<CardHoverPopup card={card} position={{ left: 0, top: 0 }} imageError onImageError={() => {}} />);
    expect(screen.getByText("Mirror Force")).toBeTruthy();
    expect(screen.getByText(/destroy all attack position monsters/i)).toBeTruthy();
  });

  it("in dismissible mode shows a close button and fires onDismiss on Escape", () => {
    const onDismiss = vi.fn();
    render(<CardHoverPopup card={card} position={{ left: 0, top: 0 }} imageError onImageError={() => {}} dismissible onDismiss={onDismiss} />);
    expect(screen.getByRole("button", { name: /close preview/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("fires onDismiss when the close button is clicked", () => {
    const onDismiss = vi.fn();
    render(<CardHoverPopup card={card} position={{ left: 0, top: 0 }} imageError onImageError={() => {}} dismissible onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /close preview/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
