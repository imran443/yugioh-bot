// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelDeckValidation, DuelMode, DuelSettings, SavedDeck } from "@yugidraft/shared/duels";
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

function saved(id: number, name: string, mode: DuelMode, main: number[]): SavedDeck {
  return { id, name, mode, deck: { main, extra: [], side: [] }, createdAt: "", updatedAt: "" };
}

function renderEditor(mode: DuelMode, validateDeck: boolean) {
  render(<DeckEditor slug="table-1" mode={mode} settings={{ validateDeck } as DuelSettings} initial={null} busy={false} onReady={vi.fn()} />);
}

async function picker() {
  const select = screen.getByLabelText("Use a saved deck") as HTMLSelectElement;
  await waitFor(() => expect(select).not.toBeDisabled());
  return select;
}

function optionNames(): string[] {
  const select = screen.getByLabelText("Use a saved deck") as HTMLSelectElement;
  return Array.from(select.options, (entry) => entry.textContent ?? "");
}

describe("saved deck picker and the table's format", () => {
  beforeEach(() => {
    listSavedDecks.mockResolvedValue([
      saved(1, "Blue-Eyes DOMAIN", "normal", [111, 112]),
      saved(2, "Real Domain", "domain", [221]),
      saved(3, "Plain Normal", "normal", [331]),
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["checked", true],
    ["custom", false],
  ])("lists Domain decks first at a %s Domain table", async (_label, validateDeck) => {
    renderEditor("domain", validateDeck);
    const select = await picker();

    expect(optionNames()).toEqual([
      "Choose a deck",
      "Real Domain · 1 Main / 0 Extra / 0 Side",
      "Blue-Eyes DOMAIN · Saved as Standard. Not usable in a Domain room.",
      "Plain Normal · Saved as Standard. Not usable in a Domain room.",
    ]);
    fireEvent.change(select, { target: { value: select.options[1]!.value } });
    expect(screen.getByRole("button", { name: "Remove 221 from Main" })).toBeInTheDocument();
  });

  it("shows decks of the other format disabled after the usable ones, with a hint", async () => {
    renderEditor("domain", true);
    const select = await picker();

    expect(select.options[1]).not.toBeDisabled();
    expect(select.options[2]).toBeDisabled();
    expect(select.options[3]).toBeDisabled();
    expect(screen.getByText(/2 saved decks use another format and can't be loaded here/)).toBeInTheDocument();
    expect(screen.getByText(/save a deck as Domain/i)).toBeInTheDocument();
  });

  it("shows no hint when every saved deck fits the table", async () => {
    listSavedDecks.mockResolvedValue([saved(2, "Real Domain", "domain", [221])]);
    renderEditor("domain", true);
    await picker();

    expect(screen.queryByText(/another format/)).not.toBeInTheDocument();
    expect(screen.queryByText(/save a deck as Domain/i)).not.toBeInTheDocument();
  });

  it.each([
    ["checked", true],
    ["custom", false],
  ])("lists Standard decks first at a %s Standard table", async (_label, validateDeck) => {
    renderEditor("normal", validateDeck);
    await picker();

    expect(optionNames()).toEqual([
      "Choose a deck",
      "Blue-Eyes DOMAIN · 2 Main / 0 Extra / 0 Side",
      "Plain Normal · 1 Main / 0 Extra / 0 Side",
      "Real Domain · Saved as Domain. Not usable in a Standard room.",
    ]);
  });

  it("says how to get a Domain deck when none is saved as Domain, even at a custom table", async () => {
    listSavedDecks.mockResolvedValue([saved(1, "Blue-Eyes DOMAIN", "normal", [111])]);
    renderEditor("domain", false);
    await picker();

    expect(optionNames()).toEqual([
      "No saved Domain decks",
      "Blue-Eyes DOMAIN · Saved as Standard. Not usable in a Domain room.",
    ]);
    expect(screen.getByText(/1 saved deck uses another format/)).toBeInTheDocument();
    expect(screen.getByText(/save a deck as Domain/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage decks" })).toHaveAttribute("href", "/decks");
  });

  it("keeps the empty message when no deck is saved", async () => {
    listSavedDecks.mockResolvedValue([]);
    renderEditor("normal", true);
    await picker();

    expect(optionNames()).toEqual(["No saved Standard decks"]);
  });
});
