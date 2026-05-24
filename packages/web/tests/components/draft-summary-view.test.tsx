// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DraftSummaryView } from "../../src/components/draft/draft-summary-view";
import { installVirtualizerJsdomEnv } from "../helpers/virtualizer-jsdom";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, priority: _priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; priority?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

const samplePool = [
  {
    id: 89631139,
    name: "Blue-Eyes White Dragon",
    type: "Normal Monster",
    frameType: "normal",
    attribute: "LIGHT",
    level: 8,
    effectText: "This legendary dragon is a powerful engine of destruction.",
    atk: 3000,
    def: 2500,
    imageUrl: "https://images.ygoprodeck.com/images/cards/89631139.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/89631139.jpg",
  },
  {
    id: 46986414,
    name: "Dark Hole",
    type: "Spell Card",
    frameType: "spell",
    attribute: "SPELL",
    effectText: "Destroy all monsters on the field.",
    imageUrl: "https://images.ygoprodeck.com/images/cards/46986414.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/46986414.jpg",
  },
  {
    id: 77563800,
    name: "Mirror Force",
    type: "Trap Card",
    frameType: "trap",
    attribute: "TRAP",
    effectText: "When an opponent's monster declares an attack: Destroy all Attack Position monsters your opponent controls.",
    imageUrl: "https://images.ygoprodeck.com/images/cards/77563800.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/77563800.jpg",
  },
];

const subtypePool = [
  {
    id: 1,
    name: "Monster Reborn",
    type: "Quick-Play Spell Card",
    frameType: "spell",
    attribute: "SPELL",
    effectText: "Special Summon 1 monster from either GY.",
    imageUrl: "https://images.ygoprodeck.com/images/cards/1.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/1.jpg",
  },
  {
    id: 2,
    name: "Solemn Judgment",
    type: "Counter Trap Card",
    frameType: "trap",
    attribute: "TRAP",
    effectText: "Negate the activation.",
    imageUrl: "https://images.ygoprodeck.com/images/cards/2.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/2.jpg",
  },
  {
    id: 3,
    name: "Gravity Bind",
    type: "Continuous Trap Card",
    frameType: "trap",
    attribute: "TRAP",
    effectText: "Level 4 or higher monsters cannot attack.",
    imageUrl: "https://images.ygoprodeck.com/images/cards/3.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/3.jpg",
  },
];

const baseDraft = {
  id: 1,
  name: "Legendary Draft",
  status: "completed",
  createdByUserId: "creator-1",
  createdAt: "2026-05-06T12:00:00.000Z",
  endedAt: "2026-05-06T12:30:00.000Z",
  config: {
    packSize: 5,
    packsPerPlayer: 3,
    pickSeconds: 60,
    setNames: ["Legend of Blue Eyes White Dragon", "Metal Raiders", "Spell Ruler"],
  },
  players: [
    {
      playerId: 1,
      displayName: "You",
      seatIndex: 0,
      pickCount: 15,
      joinedAt: "2026-05-06T12:00:00.000Z",
    },
  ],
  playerCount: 1,
};

describe("DraftSummaryView", () => {
  beforeEach(() => installVirtualizerJsdomEnv());
  it("hides YDK export for completed drafts with fewer than 40 picks", () => {
    render(
      <DraftSummaryView
        draft={{ ...baseDraft, participantPickCount: 15 } as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: /export ydk/i })).toBeNull();
    expect(screen.getByText(/requires 40 picks/i)).toBeTruthy();
  });

  it("renders card pool section with correct card names when isParticipant=true and myPool has cards", () => {
    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={samplePool}
      />
    );

    expect(screen.getByText(/your pool \(3 cards\)/i)).toBeTruthy();
    expect(screen.getByText("Blue-Eyes White Dragon")).toBeTruthy();
    expect(screen.getByText("Dark Hole")).toBeTruthy();
    expect(screen.getByText("Mirror Force")).toBeTruthy();
  });

  it("renders card metadata for monster, spell, and trap cards", () => {
    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={samplePool}
      />
    );

    // The card type appears both in the pool row and in the type-breakdown chip,
    // so there can be more than one match.
    expect(screen.getAllByText(/Normal Monster/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Spell Card/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Trap Card/).length).toBeGreaterThan(0);
    expect(screen.getByText("3000/2500")).toBeTruthy();
  });

  it("shows monster attribute but hides SPELL/TRAP attribute labels", () => {
    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={samplePool}
      />
    );

    // LIGHT appears in the pool row and the attribute-breakdown chip.
    expect(screen.getAllByText(/LIGHT/).length).toBeGreaterThan(0);
    expect(screen.queryByText("SPELL")).toBeNull();
    expect(screen.queryByText("TRAP")).toBeNull();
  });

  it("does NOT render card pool section when isParticipant=false", () => {
    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={false}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={samplePool}
      />
    );

    expect(screen.queryByText(/your pool/i)).toBeNull();
    expect(screen.queryByText("Blue-Eyes White Dragon")).toBeNull();
  });

  it("does NOT render card pool section when myPool is empty", () => {
    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={[]}
      />
    );

    expect(screen.queryByText(/your pool/i)).toBeNull();
  });

  it("does NOT render card pool section when myPool is undefined", () => {
    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
      />
    );

    expect(screen.queryByText(/your pool/i)).toBeNull();
  });

  it("renders spell and trap subtype metadata", () => {
    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={subtypePool}
      />
    );

    // Each subtype appears in both the pool row and the type-breakdown chip.
    expect(screen.getAllByText("Quick-Play Spell Card").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Counter Trap Card").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Continuous Trap Card").length).toBeGreaterThan(0);
  });

  it("renders an attribute/type breakdown of the pool", () => {
    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={samplePool}
      />,
    );
    const attrs = screen.getByLabelText("Attributes drafted");
    expect(attrs.textContent).toContain("LIGHT");
    const types = screen.getByLabelText("Types drafted");
    expect(types.textContent).toContain("Normal Monster");
    expect(types.textContent).toContain("Spell Card");
  });

  it("lazily loads and shows the full pool when expanded", async () => {
    const cards = [
      { id: 1, name: "Pot of Greed", type: "Spell Card", frameType: "spell", attribute: "SPELL", effectText: "Draw 2.", imageUrl: "u1", imageUrlSmall: "s1", qty: 3 },
    ];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cards }) });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={samplePool}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /view full pool used/i }));
    expect(fetchMock).toHaveBeenCalledWith("/api/drafts/test-draft/pool");
    expect(await screen.findByText("Pot of Greed")).toBeTruthy();

    vi.unstubAllGlobals();
  });
});
