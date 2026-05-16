// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoolPanel } from "../../src/components/draft/pool-panel";
import { useDraftStore, type DraftCardDetail, type DraftState } from "../../src/lib/stores/draft-store";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, priority: _priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; priority?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

vi.mock("../../src/lib/ydk", () => ({
  downloadYdk: vi.fn(),
}));

const baseState: DraftState = {
  slug: "legendary-draft",
  packRound: 1,
  pickStep: 1,
  currentPack: [],
  myPool: [],
  seats: [],
  timerSeconds: 0,
  isMyTurn: false,
  completed: false,
  pickSeconds: 60,
  previewCardId: null,
  selectedCardId: null,
  highlightedIndex: -1,
};

const draftedPool: DraftCardDetail[] = [
  {
    id: 101,
    name: "Blue-Eyes White Dragon",
    type: "Dragon / Normal Monster",
    frameType: "normal",
    effectText: "This legendary dragon is a powerful engine of destruction.",
    attribute: "LIGHT",
    level: 8,
    atk: 3000,
    def: 2500,
    imageUrl: "https://img/full/101",
    imageUrlSmall: "https://img/small/101",
  },
  {
    id: 202,
    name: "Mystical Space Typhoon",
    type: "Spell Card",
    frameType: "spell",
    effectText: "Target 1 spell or trap on the field; destroy that target.",
    imageUrl: "https://img/full/202",
    imageUrlSmall: "https://img/small/202",
  },
  {
    id: 303,
    name: "Trap Hole",
    type: "Trap Card",
    frameType: "trap",
    effectText: "When your opponent Normal or Flip Summons 1 monster with 1000 or more ATK: Target that monster; destroy that target.",
    imageUrl: "https://img/full/303",
    imageUrlSmall: "https://img/small/303",
  },
  {
    id: 404,
    name: "Summoned Skull",
    type: "Fiend / Normal Monster",
    frameType: "normal",
    effectText: "A fiend with dark powers for confusing the enemy.",
    attribute: "DARK",
    level: 6,
    atk: 2500,
    def: 1200,
    imageUrl: "https://img/full/404",
    imageUrlSmall: "https://img/small/404",
  },
  {
    id: 505,
    name: "Breaker the Magical Warrior",
    type: "Spellcaster / Effect Monster",
    frameType: "effect",
    effectText: "If this card is Normal Summoned: Place 1 Spell Counter on it.",
    attribute: "DARK",
    level: 4,
    atk: 1600,
    def: 1000,
    imageUrl: "https://img/full/505",
    imageUrlSmall: "https://img/small/505",
  },
];

const mixedTypePool: DraftCardDetail[] = [
  {
    id: 505,
    name: "Breaker the Magical Warrior",
    type: "Spellcaster / Effect Monster",
    frameType: "effect",
    effectText: "If this card is Normal Summoned: Place 1 Spell Counter on it.",
    attribute: "DARK",
    level: 4,
    atk: 1600,
    def: 1000,
    imageUrl: "https://img/full/505",
    imageUrlSmall: "https://img/small/505",
  },
];

function renderPoolPanel(pool: DraftCardDetail[] = []) {
  act(() => {
    useDraftStore.setState({ ...baseState, myPool: pool });
  });
  return render(<PoolPanel />);
}

function expectSummaryCount(label: string, count: number) {
  const statCard = screen
    .getAllByText(label)
    .map((node) => node.closest("div"))
    .find((candidate) => {
      if (!(candidate instanceof HTMLElement)) {
        return false;
      }

      return within(candidate).queryByText(String(count)) !== null;
    });

  expect(statCard).not.toBeNull();
  expect(within(statCard as HTMLElement).getByText(String(count))).toBeTruthy();
}

function expectDraftedSoFarCount(count: number) {
  const labelNode = screen.getByText("Drafted so far");
  const summaryCard = labelNode.closest("div");

  expect(summaryCard).not.toBeNull();
  expect(within(summaryCard as HTMLElement).getByText(String(count))).toBeTruthy();
}

function getPoolPanelContainer() {
  const heading = screen.getByRole("heading", { name: /your pool/i });
  const panel = heading.closest("div");

  expect(panel).not.toBeNull();
  return panel as HTMLElement;
}

describe("PoolPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useDraftStore.setState(baseState);
    });
  });

  afterEach(() => {
    act(() => {
      useDraftStore.setState(baseState);
    });
  });

  it("shows an in-panel empty state when no cards have been drafted", () => {
    renderPoolPanel();

    expect(within(getPoolPanelContainer()).getByText(/no cards drafted yet/i)).toBeTruthy();
  });

  it("shows full-pool summary counts", () => {
    renderPoolPanel(draftedPool);

    expect(screen.getByText("Drafted so far")).toBeTruthy();
    expectDraftedSoFarCount(5);
    expectSummaryCount("Monsters", 3);
    expectSummaryCount("Spells", 1);
    expectSummaryCount("Traps", 1);
  });

  it("filters visible cards by name", () => {
    renderPoolPanel(draftedPool);
    const poolPanel = getPoolPanelContainer();

    fireEvent.change(within(poolPanel).getByRole("textbox", { name: /search cards/i }), {
      target: { value: "blue" },
    });

    expect(within(poolPanel).getByText("Blue-Eyes White Dragon")).toBeTruthy();
    expect(within(poolPanel).queryByText("Mystical Space Typhoon")).toBeNull();
    expect(within(poolPanel).queryByText("Trap Hole")).toBeNull();
    expect(within(poolPanel).queryByText("Summoned Skull")).toBeNull();
  });

  it("filters visible cards by type pill", () => {
    renderPoolPanel(draftedPool);
    const poolPanel = getPoolPanelContainer();
    const spellsButton = within(poolPanel).getByRole("button", { name: /spells/i });

    expect(spellsButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(spellsButton);
    expect(spellsButton).toHaveAttribute("aria-pressed", "true");

    expect(within(poolPanel).getByText("Mystical Space Typhoon")).toBeTruthy();
    expect(within(poolPanel).queryByText("Blue-Eyes White Dragon")).toBeNull();
    expect(within(poolPanel).queryByText("Trap Hole")).toBeNull();
    expect(within(poolPanel).queryByText("Summoned Skull")).toBeNull();
  });

  it("filters visible cards by normal and effect monster pills", () => {
    renderPoolPanel(draftedPool);
    const poolPanel = getPoolPanelContainer();
    const normalButton = within(poolPanel).getByRole("button", { name: /normal monsters/i });
    const effectButton = within(poolPanel).getByRole("button", { name: /effect monsters/i });

    fireEvent.click(normalButton);

    expect(normalButton).toHaveAttribute("aria-pressed", "true");
    expect(within(poolPanel).getByText("Blue-Eyes White Dragon")).toBeTruthy();
    expect(within(poolPanel).getByText("Summoned Skull")).toBeTruthy();
    expect(within(poolPanel).queryByText("Breaker the Magical Warrior")).toBeNull();
    expect(within(poolPanel).queryByText("Mystical Space Typhoon")).toBeNull();
    expect(within(poolPanel).queryByText("Trap Hole")).toBeNull();

    fireEvent.click(effectButton);

    expect(effectButton).toHaveAttribute("aria-pressed", "true");
    expect(within(poolPanel).getByText("Breaker the Magical Warrior")).toBeTruthy();
    expect(within(poolPanel).queryByText("Blue-Eyes White Dragon")).toBeNull();
    expect(within(poolPanel).queryByText("Summoned Skull")).toBeNull();
  });

  it("treats spellcaster monsters as monsters instead of spells", () => {
    renderPoolPanel(mixedTypePool);
    const poolPanel = getPoolPanelContainer();

    expectSummaryCount("Monsters", 1);
    expectSummaryCount("Spells", 0);

    fireEvent.click(within(poolPanel).getByRole("button", { name: /effect monsters/i }));
    expect(within(poolPanel).getByText("Breaker the Magical Warrior")).toBeTruthy();

    fireEvent.click(within(poolPanel).getByRole("button", { name: /spells/i }));
    expect(within(poolPanel).queryByText("Breaker the Magical Warrior")).toBeNull();
    expect(within(poolPanel).getByText(/no cards match/i)).toBeTruthy();
  });

  it("renders drafted cards as a responsive image grid with name and type only", () => {
    renderPoolPanel(draftedPool);
    const poolPanel = getPoolPanelContainer();
    const cardGallery = within(poolPanel).getByTestId("card-pool-grid");
    const blueEyesTile = within(poolPanel).getByRole("button", { name: /preview blue-eyes white dragon/i });

    expect(cardGallery).toHaveClass("grid");
    expect(cardGallery.className).toContain("grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]");
    expect(within(blueEyesTile).getByText("Blue-Eyes White Dragon")).toBeTruthy();
    expect(within(blueEyesTile).getByText("Monster")).toBeTruthy();
    expect(within(blueEyesTile).queryByText("Dragon")).toBeNull();
    expect(within(blueEyesTile).queryByText("LIGHT")).toBeNull();
    expect(within(blueEyesTile).queryByText("Lv8")).toBeNull();
    expect(blueEyesTile.querySelector('img[src="https://img/small/101"]')).toBeTruthy();
  });

  it("keeps the hover popup when a drafted grid tile is hovered", () => {
    renderPoolPanel(draftedPool);
    const poolPanel = getPoolPanelContainer();
    const trapHoleTile = within(poolPanel).getByRole("button", { name: /preview trap hole/i });

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

    vi.spyOn(trapHoleTile, "getBoundingClientRect").mockReturnValue({
      x: 1200,
      y: 280,
      width: 120,
      height: 210,
      top: 280,
      right: 1320,
      bottom: 490,
      left: 1200,
      toJSON: () => ({}),
    });

    fireEvent.mouseEnter(trapHoleTile);

    expect(screen.getAllByText("Trap Hole")).toHaveLength(2);
    expect(screen.getByText(/when your opponent normal or flip summons/i)).toBeTruthy();
  });
});
