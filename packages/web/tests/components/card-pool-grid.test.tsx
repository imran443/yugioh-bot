// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CardPoolGrid, getPopupPosition } from "../../src/components/cards/card-pool-grid";
import { installVirtualizerJsdomEnv } from "../helpers/virtualizer-jsdom";

const imageRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => {
    imageRenders.count += 1;
    return <img alt={alt} {...props} />;
  },
}));
import type { CardSummary } from "../../src/lib/card-types";

const cards: CardSummary[] = [
  { id: 1, name: "Bujingi Crane", type: "Winged Beast / Effect Monster", frameType: "effect", effectText: "...", imageUrl: "u1", imageUrlSmall: "s1" },
  { id: 2, name: "Mirror Force", type: "Trap Card", frameType: "trap", effectText: "...", imageUrl: "u2", imageUrlSmall: "s2" },
  { id: 3, name: "Monster Reborn", type: "Spell Card", frameType: "spell", effectText: "...", imageUrl: "u3", imageUrlSmall: "s3" },
];

const leveledCards: CardSummary[] = [
  { id: 10, name: "Low Monster", type: "Beast / Normal Monster", frameType: "normal", level: 4, effectText: "...", imageUrl: "u10", imageUrlSmall: "s10" },
  { id: 11, name: "Mid Monster", type: "Beast / Effect Monster", frameType: "effect", level: 6, effectText: "...", imageUrl: "u11", imageUrlSmall: "s11" },
  { id: 12, name: "High Monster", type: "Dragon / Effect Monster", frameType: "effect", level: 8, effectText: "...", imageUrl: "u12", imageUrlSmall: "s12" },
  { id: 13, name: "Plain Spell", type: "Spell Card", frameType: "spell", effectText: "...", imageUrl: "u13", imageUrlSmall: "s13" },
];

describe("CardPoolGrid", () => {
  beforeEach(() => installVirtualizerJsdomEnv());
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

  it("narrows by tribute tier: No Trib shows only level 1-4 monsters", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    fireEvent.click(screen.getByRole("button", { name: /^no trib$/i }));
    expect(screen.getByRole("button", { name: /preview low monster/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /preview mid monster/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview high monster/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview plain spell/i })).toBeNull();
  });

  it("narrows by tribute tier: 1 Trib shows only level 5-6 monsters", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    fireEvent.click(screen.getByRole("button", { name: /^1 trib$/i }));
    expect(screen.getByRole("button", { name: /preview mid monster/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /preview low monster/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview high monster/i })).toBeNull();
  });

  it("narrows by tribute tier: 2 Trib shows only level 7+ monsters", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    fireEvent.click(screen.getByRole("button", { name: /^2 trib$/i }));
    expect(screen.getByRole("button", { name: /preview high monster/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /preview low monster/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview mid monster/i })).toBeNull();
  });

  it("ANDs the tribute tier with the type filter, yielding the no-match message for impossible combos", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    fireEvent.click(screen.getByRole("button", { name: /^spells$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^1 trib$/i }));
    expect(screen.getByText(/no cards match/i)).toBeTruthy();
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

  it("opens the preview popup on click and dismisses on Escape", () => {
    render(<CardPoolGrid cards={cards} />);
    fireEvent.click(screen.getByRole("button", { name: /preview mirror force/i }));
    // tapped popup renders the card name in a heading inside the popup
    expect(screen.getAllByText("Mirror Force").length).toBeGreaterThan(1);
    fireEvent.keyDown(window, { key: "Escape" });
    // after dismiss, only the button label text remains
    expect(screen.getAllByText("Mirror Force").length).toBe(1);
  });

  it("uses the custom card click action when provided", () => {
    const onCardClick = vi.fn();
    render(<CardPoolGrid cards={cards} onCardClick={onCardClick} cardActionLabel={(card) => `Remove ${card.name} from cube`} />);

    fireEvent.click(screen.getByRole("button", { name: /remove mirror force from cube/i }));

    expect(onCardClick).toHaveBeenCalledTimes(1);
    expect(onCardClick).toHaveBeenCalledWith(cards[1]);
    expect(screen.getAllByText("Mirror Force")).toHaveLength(1);
  });

  it("opens preview on hover in cube edit mode", () => {
    render(<CardPoolGrid cards={cards} cubeEditMode />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: /preview mirror force/i }));

    expect(screen.getAllByText("Mirror Force").length).toBeGreaterThanOrEqual(2);
  });

  it("does not open preview on click in cube edit mode", () => {
    render(<CardPoolGrid cards={cards} cubeEditMode />);

    fireEvent.click(screen.getByRole("button", { name: /preview mirror force/i }));

    expect(screen.getAllByText("Mirror Force")).toHaveLength(1);
  });

  it("prefers the large image in cube edit mode", () => {
    render(<CardPoolGrid cards={cards} cubeEditMode />);

    expect(screen.getByRole("img", { name: "Bujingi Crane" })).toHaveAttribute("src", "u1");
  });

  it("shows a per-tier count beside each tribute filter", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    // none = 1 (lvl4), one = 1 (lvl6), two = 1 (lvl8); spell is not counted in any tier.
    expect(screen.getByRole("button", { name: /^no trib$/i }).textContent).toMatch(/1/);
    expect(screen.getByRole("button", { name: /^1 trib$/i }).textContent).toMatch(/1/);
    expect(screen.getByRole("button", { name: /^2 trib$/i }).textContent).toMatch(/1/);
    // Any counts every card.
    expect(screen.getByRole("button", { name: /^any$/i }).textContent).toMatch(/4/);
  });

  it("clears all filters when Clear is clicked, and hides the button at defaults", () => {
    render(<CardPoolGrid cards={cards} />);
    // No clear button at defaults.
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
    // Apply a filter that hides a card.
    fireEvent.click(screen.getByRole("button", { name: /^traps$/i }));
    expect(screen.queryByRole("button", { name: /preview monster reborn/i })).toBeNull();
    // Clear restores everything and the button disappears again.
    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(screen.getByRole("button", { name: /preview monster reborn/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });

  it("windows the grid: renders only a subset of a large pool", () => {
    const many: CardSummary[] = Array.from({ length: 400 }, (_, i) => ({
      id: i + 1,
      name: `Card ${i + 1}`,
      type: "Spell Card",
      frameType: "spell",
      effectText: "...",
      imageUrl: `u${i}`,
      imageUrlSmall: `s${i}`,
    }));
    render(<CardPoolGrid cards={many} />);
    const rendered = screen.getAllByRole("button", { name: /^preview card/i });
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(120); // far fewer than 400 → windowed
    // windowed rows are full rows: at 900px the grid is 6 columns, so the
    // rendered tile count is an exact multiple of 6 (no partial top/bottom row).
    expect(rendered.length % 6).toBe(0);
  });
});

function bigPool(n: number): CardSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `Card ${i + 1}`,
    type: "Spell Card",
    frameType: "spell",
    effectText: "...",
    imageUrl: `u${i}`,
    imageUrlSmall: `s${i}`,
  }));
}

function firstRowColumns(): number {
  const row = document.querySelector<HTMLElement>("[data-index]");
  if (!row) throw new Error("no virtualized row rendered");
  const match = /repeat\((\d+),/.exec(row.style.gridTemplateColumns);
  return match ? Number(match[1]) : 0;
}

// columns = max(1, floor((clientWidth - PAD_X + GAP) / (TILE_MIN + GAP)))
// PAD_X=24, GAP=12, TILE_MIN=120 (default) / 200 (cube edit).
describe.each([
  { width: 480, columns: 3 }, // floor((480-12)/132) = floor(3.54)
  { width: 900, columns: 6 }, // floor((900-12)/132) = floor(6.72)
  { width: 1600, columns: 12 }, // floor((1600-12)/132) = floor(12.03)
])("CardPoolGrid column math at $width px", ({ width, columns }) => {
  beforeEach(() => installVirtualizerJsdomEnv({ width, height: 600 }));

  it("derives the column count from the measured width and lays the row out to match", () => {
    render(<CardPoolGrid cards={bigPool(60)} />);
    expect(firstRowColumns()).toBe(columns);
    const firstRow = document.querySelector<HTMLElement>("[data-index='0']")!;
    expect(within(firstRow).getAllByRole("button", { name: /^preview card/i })).toHaveLength(columns);
  });
});

describe("CardPoolGrid column math in cube edit mode", () => {
  // TILE_MIN widens to 200 → floor((900-24+12)/(200+12)) = floor(4.18) = 4.
  beforeEach(() => installVirtualizerJsdomEnv({ width: 900, height: 600 }));

  it("uses fewer, wider columns than the default grid at the same width", () => {
    render(<CardPoolGrid cards={bigPool(60)} cubeEditMode />);
    expect(firstRowColumns()).toBe(4);
    const firstRow = document.querySelector<HTMLElement>("[data-index='0']")!;
    expect(within(firstRow).getAllByRole("button", { name: /^preview card/i })).toHaveLength(4);
  });
});

const POPUP_W = 288;
const POPUP_H = 560;
const MARGIN = 16;

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function rect(r: { left: number; right: number; top: number; height: number }): DOMRect {
  return {
    ...r,
    x: r.left,
    y: r.top,
    width: r.right - r.left,
    bottom: r.top + r.height,
    toJSON: () => r,
  } as DOMRect;
}

describe("getPopupPosition", () => {
  it("places the popup to the left of the card when there is room", () => {
    setViewport(1600, 900);
    const card = rect({ left: 900, right: 1044, top: 300, height: 200 });

    const { left } = getPopupPosition(card);

    // Popup sits entirely to the left of the card, on-screen.
    expect(left + POPUP_W).toBeLessThanOrEqual(card.left);
    expect(left).toBeGreaterThanOrEqual(MARGIN);
  });

  it("flips the popup to the right of the card when the left has no room (sidebar case)", () => {
    setViewport(1600, 900);
    // Leftmost preview card next to the app sidebar — left placement would
    // clamp to the viewport edge and land under the sidebar.
    const card = rect({ left: 120, right: 264, top: 300, height: 200 });

    const { left } = getPopupPosition(card);

    // Popup is placed to the right of the card, clear of the left edge.
    expect(left).toBeGreaterThanOrEqual(card.right);
  });

  it("keeps the popup on-screen even when neither side fully fits", () => {
    setViewport(360, 640);
    const card = rect({ left: 80, right: 224, top: 200, height: 200 });

    const { left } = getPopupPosition(card);

    expect(left).toBeGreaterThanOrEqual(MARGIN);
    expect(left).toBeLessThanOrEqual(360 - POPUP_W - MARGIN);
  });

  it("vertically centers on the card and clamps to the viewport", () => {
    setViewport(1600, 900);
    const card = rect({ left: 900, right: 1044, top: 400, height: 200 });

    const { top } = getPopupPosition(card);

    // Popup's vertical center aligns with the card's center when unclamped.
    expect(top + POPUP_H / 2).toBe(card.top + card.height / 2);
    expect(top).toBeGreaterThanOrEqual(MARGIN);
    expect(top).toBeLessThanOrEqual(900 - POPUP_H - MARGIN);
  });

  it("clamps the popup within the viewport when the card sits near the bottom", () => {
    setViewport(1600, 700);
    const card = rect({ left: 900, right: 1044, top: 660, height: 200 });

    const { top } = getPopupPosition(card);

    expect(top).toBeLessThanOrEqual(700 - POPUP_H - MARGIN);
    expect(top).toBeGreaterThanOrEqual(MARGIN);
  });
});

describe("CardPoolGrid memoization", () => {
  beforeEach(() => installVirtualizerJsdomEnv());
  it("does not re-render its tiles when its parent re-renders with the same props", () => {
    function Harness() {
      const [tick, setTick] = React.useState(0);
      return (
        <>
          <button onClick={() => setTick((t) => t + 1)}>bump {tick}</button>
          <CardPoolGrid cards={cards} />
        </>
      );
    }

    render(<Harness />);
    const tilesAfterMount = imageRenders.count;

    // Parent re-renders with an identical `cards` reference (mirrors typing in
    // an unrelated field on the create-draft form). The memoized grid must not
    // re-render its tiles — this is the typing-lag regression.
    fireEvent.click(screen.getByText(/bump/));

    expect(imageRenders.count).toBe(tilesAfterMount);
  });
});
