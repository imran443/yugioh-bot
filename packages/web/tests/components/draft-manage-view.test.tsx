// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftManageView } from "../../src/components/draft/draft-manage-view";
import type { CardSummary } from "../../src/lib/card-types";
import { installVirtualizerJsdomEnv } from "../helpers/virtualizer-jsdom";

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
    cardsPerPlayer: 45,
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

describe("DraftManageView — config summary", () => {
  it("shows the configured cards-per-player in the read-only summary", () => {
    render(<DraftManageView {...baseProps} />);
    expect(screen.getByText("Cards/Player")).toBeInTheDocument();
    expect(screen.getByText("45")).toBeInTheDocument();
  });
});

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
  beforeEach(() => installVirtualizerJsdomEnv());

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
    expect(screen.getByText((_, el) => !!el && el.tagName === "H3" && /card pool/i.test(el.textContent ?? ""))).toBeTruthy();
  });

  it("shows the empty state when the pool resolves empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/drafts/my-slug/pool") return Response.json({ cards: [] });
      return Response.json({}, { status: 404 });
    }));
    render(<DraftManageView draft={baseDraft} slug="my-slug" isCreator isParticipant={false} onStart={noop} onCancel={noop} onUpdate={noop} onJoin={noop} />);
    await waitFor(() => expect(screen.getByText(/hasn't been resolved yet/i)).toBeTruthy());
  });

  it("shows error UI and Retry button when the pool fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/drafts/my-slug/pool") {
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
      }
      return Response.json({}, { status: 404 });
    }));
    render(<DraftManageView draft={baseDraft} slug="my-slug" isCreator isParticipant={false} onStart={noop} onCancel={noop} onUpdate={noop} onJoin={noop} />);
    await waitFor(() => expect(screen.getByText(/couldn't load the pool/i)).toBeTruthy());
  });
});

describe("DraftManageView — editing config syncs the card pool pane", () => {
  beforeEach(() => installVirtualizerJsdomEnv());

  const dm = { id: 46986414, name: "Dark Magician", type: "Spellcaster / Normal Monster", frameType: "normal", effectText: "", imageUrl: "u", imageUrlSmall: "s" };
  const bewd = { id: 89631139, name: "Blue-Eyes White Dragon", type: "Dragon / Normal Monster", frameType: "normal", effectText: "", imageUrl: "u2", imageUrlSmall: "s2" };

  it("hides the inline pool preview and removes a card from the single synced pane", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/drafts/my-slug/pool") return Response.json({ cards: [] });
      if (url === "/api/cards/resolve") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { setNames?: string[] };
        // Before removal sets are active (qty 2 + 1 = 3 copies); after removal
        // the sets collapse to passcodes and one copy is gone (2 copies).
        const cards = body.setNames && body.setNames.length > 0
          ? [{ ...dm, qty: 2 } as CardSummary, { ...bewd, qty: 1 } as CardSummary]
          : [{ ...dm, qty: 1 } as CardSummary, { ...bewd, qty: 1 } as CardSummary];
        return Response.json({ cards, unknownIds: [] });
      }
      return Response.json({}, { status: 404 });
    }));
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<DraftManageView draft={baseDraft} slug="my-slug" isCreator isParticipant={false} onStart={noop} onCancel={noop} onUpdate={onUpdate} onJoin={noop} />);

    await userEvent.click(screen.getByRole("button", { name: /edit configuration/i }));

    // The synced pane resolves the in-progress pool and exposes remove actions.
    await waitFor(() => expect(screen.getByRole("button", { name: /remove dark magician from pool/i })).toBeTruthy());
    // The duplicate inline "Pool preview" grid is gone — only the left pane remains.
    expect(screen.queryByText(/pool preview/i)).toBeNull();
    // 3 copies before removal.
    await waitFor(() => expect(screen.getByText(/3 copies/i)).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: /remove dark magician from pool/i }));

    // Removal is local (no save) and the synced pane updates to 2 copies.
    await waitFor(() => expect(screen.queryByText(/3 copies/i)).toBeNull());
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
