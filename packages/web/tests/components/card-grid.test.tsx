// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardGrid } from "../../src/components/draft/card-grid";
import { useDraftStore } from "../../src/lib/stores/draft-store";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
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
  isMyTurn: false,
  completed: false,
  pickSeconds: 60,
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
    name: "Summoned Skull",
    type: "Fiend / Normal Monster",
    frameType: "normal",
    effectText: "A fiend with dark powers for confusing the enemy. Among the Fiend-Type monsters, this monster boasts considerable force.",
    attribute: "DARK",
    level: 6,
    atk: 2500,
    def: 1200,
    imageUrl: "https://img/full/303",
    imageUrlSmall: "https://img/small/303",
  },
];

describe("CardGrid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDraftStore.setState(baseState);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as unknown as Response);
  });

  afterEach(() => {
    useDraftStore.setState(baseState);
  });

  it("shows a syncing fallback when no pack cards are available yet", () => {
    render(<CardGrid />);

    expect(screen.getByText(/draft feed syncing/i)).toBeTruthy();
    expect(screen.getByText(/waiting for pack/i)).toBeTruthy();
  });

  it("picks a card immediately when clicked without opening a modal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as unknown as Response);
    global.fetch = fetchMock;
    useDraftStore.setState({ ...baseState, currentPack: samplePack, isMyTurn: true });

    render(<CardGrid />);

    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /mirror force/i }));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/drafts/legendary-draft/pick",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ cardId: 101 }),
        }),
      );
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not submit a stale pick after server state ends the turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as unknown as Response);
    global.fetch = fetchMock;

    useDraftStore.setState({ ...baseState, currentPack: samplePack, isMyTurn: true });

    render(<CardGrid />);

    act(() => {
      useDraftStore.getState().setFromServer({
        currentPack: [samplePack[1]],
        isMyTurn: false,
        timerSeconds: 0,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /mystical space typhoon/i }));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders a fixed overlapping hover preview for desktop inspection", async () => {
    useDraftStore.setState({ ...baseState, currentPack: samplePack, isMyTurn: true });

    render(<CardGrid />);

    await act(async () => {
      fireEvent.mouseEnter(screen.getByRole("option", { name: /mirror force/i }));
    });

    expect(screen.getAllByAltText("Mirror Force").length).toBeGreaterThan(1);
    expect(document.querySelector(".pointer-events-none.fixed.z-30")).toBeTruthy();
    expect(screen.getByTestId("hover-preview-card").className).toContain("bg-bg-surface");
    expect(screen.getByTestId("hover-preview-art").className).toContain("bg-bg-elevated");
    expect(screen.getAllByAltText("Mirror Force")[1]).toHaveClass("object-contain");
  });

  it("shows effect text and monster stats in the hover preview", async () => {
    useDraftStore.setState({ ...baseState, currentPack: samplePack, isMyTurn: true });

    render(<CardGrid />);

    await act(async () => {
      fireEvent.mouseEnter(screen.getByRole("option", { name: /summoned skull/i }));
    });

    expect(screen.getByText(/fiend with dark powers/i)).toBeTruthy();
    expect(screen.getByText("ATK 2500")).toBeTruthy();
    expect(screen.getByText("DEF 1200")).toBeTruthy();
    expect(screen.getByText("DARK")).toBeTruthy();
    expect(screen.getByText("Level 6")).toBeTruthy();
  });
});
