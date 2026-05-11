// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TimerBar } from "../../src/components/draft/timer-bar";
import { useDraftStore, type DraftState } from "../../src/lib/stores/draft-store";

const baseState: DraftState = {
  slug: "test-draft",
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

describe("TimerBar", () => {
  beforeEach(() => {
    act(() => {
      useDraftStore.setState({
        ...baseState,
        packRound: 1,
        pickStep: 4,
        timerSeconds: 38,
        pickSeconds: 45,
        myPool: [
          {
            id: 1,
            name: "Bujingi Crane",
            type: "Winged Beast / Effect Monster",
            frameType: "effect",
            effectText: "During damage calculation...",
            imageUrl: "https://img/full/1",
            imageUrlSmall: "https://img/small/1",
          },
          {
            id: 2,
            name: "Archfiend Commander",
            type: "Fiend / Effect Monster",
            frameType: "effect",
            effectText: "If you control an Archfiend card...",
            imageUrl: "https://img/full/2",
            imageUrlSmall: "https://img/small/2",
          },
          {
            id: 3,
            name: "Mirror Force",
            type: "Trap Card",
            frameType: "trap",
            effectText: "Destroy all attack position monsters.",
            imageUrl: "https://img/full/3",
            imageUrlSmall: "https://img/small/3",
          },
        ],
      });
    });
  });

  afterEach(() => {
    act(() => {
      useDraftStore.setState(baseState);
    });
  });

  it("centers timer and drafted count in the sticky draft HUD", () => {
    render(<TimerBar />);

    const hud = screen.getByRole("timer", { name: /time remaining/i }).closest("div");

    expect(hud).not.toBeNull();
    expect(screen.getByText("Pack 1 · Pick 4")).toBeTruthy();
    expect(screen.getByRole("timer", { name: /time remaining/i })).toHaveTextContent("0:38");
    expect(within(hud as HTMLElement).getByText("Drafted")).toBeTruthy();
    expect(within(hud as HTMLElement).getByText("3 / 40")).toBeTruthy();
  });

  it("places the larger live label beside the progress bar", () => {
    render(<TimerBar />);

    const progressbar = screen.getByRole("progressbar");
    const progressRow = progressbar.closest("div")?.parentElement?.parentElement;

    expect(progressRow).not.toBeNull();
    const liveLabel = within(progressRow as HTMLElement).getByText("Live");
    expect(liveLabel).toHaveClass("text-[1.025rem]");
  });
});
