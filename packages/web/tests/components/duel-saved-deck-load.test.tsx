// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelDeckValidation, DuelSettings, SavedDeck } from "@yugidraft/shared/duels";
import { DeckEditor } from "../../src/components/duel/deck-editor";

const { listSavedDecks } = vi.hoisted(() => ({ listSavedDecks: vi.fn() }));

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

vi.mock("../../src/components/decks/api", () => ({ listSavedDecks }));
vi.mock("../../src/components/duel/api", () => ({
  validateDuelDeck: vi.fn(async () => ({ issues: [] }) as unknown as DuelDeckValidation),
  searchDuelCards: vi.fn(async () => ({ cards: [] })),
  getDuelCards: vi.fn(async () => ({ cards: [], missing: [] })),
}));

function saved(id: number, name: string, main: number[]): SavedDeck {
  return { id, name, mode: "normal", deck: { main, extra: [], side: [] }, createdAt: "", updatedAt: "" };
}

const settings = { validateDeck: true } as DuelSettings;

function renderEditor() {
  render(<DeckEditor slug="table-1" mode="normal" settings={settings} initial={null} busy={false} onReady={vi.fn()} />);
}

async function choose(name: string) {
  const select = screen.getByLabelText("Use a saved deck") as HTMLSelectElement;
  await waitFor(() => expect(select).not.toBeDisabled());
  const option = screen.getByRole("option", { name: new RegExp(`^${name} ·`) }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
  return select;
}

describe("saved deck picker in the duel deck editor", () => {
  beforeEach(() => {
    listSavedDecks.mockResolvedValue([saved(1, "Alpha", [111, 112]), saved(2, "Beta", [221])]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("loads the deck as soon as the player chooses it", async () => {
    renderEditor();
    await choose("Alpha");

    expect(screen.getByRole("button", { name: "Remove 111 from Main" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load deck" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Ready with this deck" })).toBeEnabled());
  });

  it("switches between unchanged saved decks without a confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm");
    renderEditor();
    await choose("Alpha");
    await choose("Beta");

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove 221 from Main" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove 111 from Main" })).not.toBeInTheDocument();
  });

  it("asks before it replaces a changed deck, and keeps it when the player cancels", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderEditor();
    await choose("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Remove 112 from Main" }));

    const select = await choose("Beta");

    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Remove 111 from Main" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove 221 from Main" })).not.toBeInTheDocument();
    expect(select.selectedOptions[0]?.textContent).toMatch(/^Alpha ·/);
  });
});
