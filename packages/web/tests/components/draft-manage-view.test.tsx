// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftManageView } from "../../src/components/draft/draft-manage-view";
import type { CardSummary } from "../../src/lib/card-types";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

const baseDraft = {
  id: 1,
  name: "Legendary Draft",
  status: "pending",
  createdByUserId: "creator-1",
  createdAt: "2026-05-06T12:00:00.000Z",
  config: {
    packSize: 5,
    packsPerPlayer: 3,
    pickSeconds: 60,
    setNames: ["Legend of Blue Eyes White Dragon"],
  },
  players: [],
  playerCount: 0,
};

const baseProps = {
  draft: baseDraft,
  isCreator: true,
  isParticipant: true,
  onStart: vi.fn().mockResolvedValue(undefined),
  onCancel: vi.fn().mockResolvedValue(undefined),
  onUpdate: vi.fn().mockResolvedValue(undefined),
  onJoin: vi.fn().mockResolvedValue(undefined),
};

describe("DraftManageView — Add Bot button", () => {
  it("shows Add Bot button when isDev=true and isCreator=true", () => {
    const onAddBot = vi.fn().mockResolvedValue(undefined);
    render(<DraftManageView {...baseProps} isDev={true} onAddBot={onAddBot} />);
    expect(screen.getByRole("button", { name: /add bot/i })).toBeInTheDocument();
  });

  it("hides Add Bot button when isDev=false", () => {
    const onAddBot = vi.fn().mockResolvedValue(undefined);
    render(<DraftManageView {...baseProps} isDev={false} onAddBot={onAddBot} />);
    expect(screen.queryByRole("button", { name: /add bot/i })).not.toBeInTheDocument();
  });

  it("hides Add Bot button when isDev=true but isCreator=false", () => {
    const onAddBot = vi.fn().mockResolvedValue(undefined);
    render(
      <DraftManageView {...baseProps} isCreator={false} isDev={true} onAddBot={onAddBot} />
    );
    expect(screen.queryByRole("button", { name: /add bot/i })).not.toBeInTheDocument();
  });

  it("calls onAddBot when the button is clicked", async () => {
    const onAddBot = vi.fn().mockResolvedValue(undefined);
    render(<DraftManageView {...baseProps} isDev={true} onAddBot={onAddBot} />);
    await userEvent.click(screen.getByRole("button", { name: /add bot/i }));
    expect(onAddBot).toHaveBeenCalledOnce();
  });
});

const noop = async () => {};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("DraftManageView — card pool section", () => {
  it("fetches and renders the resolved pool", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/drafts/my-slug/pool") {
        return Response.json({ cards: [{ id: 46986414, name: "Dark Magician", type: "Spellcaster / Normal Monster", frameType: "normal", effectText: "", imageUrl: "u", imageUrlSmall: "s" } as CardSummary] });
      }
      return Response.json({}, { status: 404 });
    }));
    render(<DraftManageView draft={baseDraft} slug="my-slug" isCreator isParticipant={false} onStart={noop} onCancel={noop} onUpdate={noop} onJoin={noop} />);
    await waitFor(() => expect(screen.getByText(/card pool/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: /preview dark magician/i })).toBeTruthy());
    expect(screen.getByText((_, el) => !!el && el.tagName === "H2" && /card pool/i.test(el.textContent ?? "") && /1 card/.test(el.textContent ?? ""))).toBeTruthy();
  });

  it("shows the empty state when the pool resolves empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/drafts/my-slug/pool") return Response.json({ cards: [] });
      return Response.json({}, { status: 404 });
    }));
    render(<DraftManageView draft={baseDraft} slug="my-slug" isCreator isParticipant={false} onStart={noop} onCancel={noop} onUpdate={noop} onJoin={noop} />);
    await waitFor(() => expect(screen.getByText(/hasn't been resolved yet/i)).toBeTruthy());
  });
});
