// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoolPanel } from "../../src/components/draft/pool-panel";
import { useDraftStore, type DraftCardDetail, type DraftState } from "../../src/lib/stores/draft-store";

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
    expectDraftedSoFarCount(4);
    expectSummaryCount("Monsters", 2);
    expectSummaryCount("Spells", 1);
    expectSummaryCount("Traps", 1);
  });

  it("filters visible cards by name", () => {
    renderPoolPanel(draftedPool);
    const poolPanel = getPoolPanelContainer();

    fireEvent.change(within(poolPanel).getByRole("textbox", { name: /filter cards/i }), {
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

  it("combines name and type filters", () => {
    renderPoolPanel(draftedPool);
    const poolPanel = getPoolPanelContainer();

    fireEvent.click(within(poolPanel).getByRole("button", { name: /monsters/i }));
    fireEvent.change(within(poolPanel).getByRole("textbox", { name: /filter cards/i }), {
      target: { value: "summoned" },
    });

    expect(within(poolPanel).getByText("Summoned Skull")).toBeTruthy();
    expect(within(poolPanel).queryByText("Blue-Eyes White Dragon")).toBeNull();
    expect(within(poolPanel).queryByText("Mystical Space Typhoon")).toBeNull();
    expect(within(poolPanel).queryByText("Trap Hole")).toBeNull();
  });

  it("treats spellcaster monsters as monsters instead of spells", () => {
    renderPoolPanel(mixedTypePool);
    const poolPanel = getPoolPanelContainer();

    expectSummaryCount("Monsters", 1);
    expectSummaryCount("Spells", 0);

    fireEvent.click(within(poolPanel).getByRole("button", { name: /monsters/i }));
    expect(within(poolPanel).getByText("Breaker the Magical Warrior")).toBeTruthy();

    fireEvent.click(within(poolPanel).getByRole("button", { name: /spells/i }));
    expect(within(poolPanel).queryByText("Breaker the Magical Warrior")).toBeNull();
    expect(within(poolPanel).getByText(/no cards match this filter/i)).toBeTruthy();
  });
});
