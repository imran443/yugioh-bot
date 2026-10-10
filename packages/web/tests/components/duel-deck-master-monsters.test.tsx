// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelCardInfo, DuelDeck, DuelSettings } from "@yugidraft/shared/duels";
import { DuelRequestError, searchDuelCards } from "../../src/components/duel/api";
import { duelActionErrorText } from "../../src/lib/duel/action-errors";
import { DeckEditor } from "../../src/components/duel/deck-editor";
import { canBeDeckMaster, useDeckCardMeta } from "../../src/components/duel/deck-card-types";
import { TYPE_EFFECT, TYPE_FUSION, TYPE_MONSTER, TYPE_SPELL, TYPE_TOKEN, TYPE_TRAP } from "../../src/components/duel/constants";

const { validateDuelDeck, getDuelCards } = vi.hoisted(() => ({ validateDuelDeck: vi.fn(), getDuelCards: vi.fn() }));

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});
vi.mock("../../src/components/decks/api", () => ({ listSavedDecks: vi.fn(async () => []) }));
vi.mock("../../src/components/duel/api", async (importActual) => ({
  ...await importActual<typeof import("../../src/components/duel/api")>(),
  validateDuelDeck, getDuelCards, searchDuelCards: vi.fn(async (): Promise<{ cards: DuelCardInfo[] }> => ({ cards: [] })),
}));

const settings = { validateDeck: true } as DuelSettings;
const MONSTER = 1001;
const SPELL = 1002;
const TRAP = 1003;
const FUSION = 1004;

function info(code: number, name: string, type: number): DuelCardInfo {
  return { code, name, description: "", type, attack: 0, defense: 0, level: 4, attribute: 1, race: "Warrior" };
}
const CARDS = [
  info(MONSTER, "Test Warrior", TYPE_MONSTER | TYPE_EFFECT),
  info(SPELL, "Test Spell", TYPE_SPELL),
  info(TRAP, "Test Trap", TYPE_TRAP),
  info(FUSION, "Test Fusion", TYPE_MONSTER | TYPE_FUSION),
];
const deck: DuelDeck = { main: [MONSTER, SPELL, TRAP], extra: [FUSION], side: [] };

beforeEach(() => {
  validateDuelDeck.mockReset().mockResolvedValue({ issues: [] });
  getDuelCards.mockReset().mockImplementation(async (codes: number[]) => ({
    cards: CARDS.filter((card) => codes.includes(card.code)),
    missing: [],
  }));
});
afterEach(cleanup);

describe("canBeDeckMaster", () => {
  it("accepts monsters, Extra Deck monsters included, and nothing else", () => {
    expect(canBeDeckMaster(TYPE_MONSTER | TYPE_EFFECT)).toBe(true);
    expect(canBeDeckMaster(TYPE_MONSTER | TYPE_FUSION)).toBe(true);
    expect(canBeDeckMaster(TYPE_SPELL)).toBe(false);
    expect(canBeDeckMaster(TYPE_TRAP)).toBe(false);
    expect(canBeDeckMaster(undefined)).toBe(false);
    expect(canBeDeckMaster(TYPE_MONSTER | TYPE_TOKEN)).toBe(false);
  });
});

describe("Deck Master controls in the room deck editor", () => {
  it("shows Master on Main and Extra monsters only, never on Spells or Traps", async () => {
    render(<DeckEditor slug="t" mode="domain" settings={settings} initial={deck} busy={false} onReady={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Use Test Warrior as Deck Master" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Use Test Fusion as Deck Master" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Use Test Spell as Deck Master/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Use Test Trap as Deck Master/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /as Deck Master$/ })).toHaveLength(2);
  });

  it("shows no Master control before the card types are known", async () => {
    getDuelCards.mockImplementation(() => new Promise(() => {}));
    render(<DeckEditor slug="t" mode="domain" settings={settings} initial={deck} busy={false} onReady={vi.fn()} />);
    await waitFor(() => expect(getDuelCards).toHaveBeenCalled());
    expect(screen.queryAllByRole("button", { name: /as Deck Master$/ })).toHaveLength(0);
  });

  it("shows no Master control outside Domain", async () => {
    render(<DeckEditor slug="t" mode="normal" settings={settings} initial={deck} busy={false} onReady={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getDuelCards).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("button", { name: /as Deck Master$/ })).toHaveLength(0);
  });

  it("shows the Master buttons after a failed card lookup is retried", async () => {
    getDuelCards.mockRejectedValueOnce(new Error("offline"));
    render(<DeckEditor slug="t" mode="domain" settings={settings} initial={deck} busy={false} onReady={vi.fn()} />);
    await waitFor(() => expect(getDuelCards).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByRole("button", { name: /as Deck Master$/ })).toHaveLength(0);
    expect(await screen.findByRole("button", { name: "Use Test Warrior as Deck Master" }, { timeout: 4000 })).toBeInTheDocument();
    expect(getDuelCards).toHaveBeenCalledTimes(2);
  });

  it("names the Remove buttons from the card lookup", async () => {
    render(<DeckEditor slug="t" mode="domain" settings={settings} initial={deck} busy={false} onReady={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Remove Test Spell from Main" })).toBeInTheDocument();
  });

  it("shows the Spell or Trap message next to the Deck Master slot as soon as the card is known", async () => {
    validateDuelDeck.mockImplementation(() => new Promise(() => {}));
    render(<DeckEditor slug="t" mode="domain" settings={settings} initial={{ ...deck, deckMaster: TRAP }} busy={false} onReady={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You can't use a Spell or Trap as your Deck Master.");
    expect(screen.getByRole("button", { name: "Clear Deck Master" })).toBeEnabled();
  });

  it("shows no Spell or Trap message for a monster Deck Master", async () => {
    render(<DeckEditor slug="t" mode="domain" settings={settings} initial={{ ...deck, deckMaster: MONSTER }} busy={false} onReady={vi.fn()} />);
    await waitFor(() => expect(getDuelCards).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/Spell or Trap/)).toBeNull();
  });

  it("lists the server's deck check message and puts it on the Deck Master slot", async () => {
    validateDuelDeck.mockResolvedValue({
      issues: [{ message: "You can't use a Spell or Trap as your Deck Master.", cards: [{ section: "deckMaster", index: 0, code: SPELL, name: "Test Spell" }] }],
    });
    render(<DeckEditor slug="t" mode="domain" settings={settings} initial={{ ...deck, deckMaster: SPELL }} busy={false} onReady={vi.fn()} />);
    expect(await screen.findByText("Invalid deck — fix the following before readying")).toBeInTheDocument();
    const list = screen.getByRole("status").querySelector("li");
    expect(list).toHaveTextContent("You can't use a Spell or Trap as your Deck Master.");
    expect(screen.getByRole("alert")).toHaveTextContent("You can't use a Spell or Trap as your Deck Master.");
  });

  it("offers no Spell or Trap in the Deck Master search", async () => {
    vi.mocked(searchDuelCards).mockResolvedValue({ cards: CARDS });
    render(<DeckEditor slug="t" mode="domain" settings={settings} initial={deck} busy={false} onReady={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Find Deck Master by name or passcode"), { target: { value: "test" } });
    const results = await screen.findByRole("list", { name: "Deck Master search results" });
    expect(results).toHaveTextContent("Test Warrior");
    expect(results).toHaveTextContent("Test Fusion");
    expect(results).not.toHaveTextContent("Test Spell");
    expect(results).not.toHaveTextContent("Test Trap");
  });

  it("does not crash on a saved Spell Deck Master and shows the server problem", async () => {
    validateDuelDeck.mockResolvedValue({
      issues: [{ message: "Deck Master must be a playable monster card", cards: [{ section: "deckMaster", index: 0, code: SPELL, name: "Test Spell" }] }],
    });
    render(<DeckEditor slug="t" mode="domain" settings={settings} initial={{ ...deck, deckMaster: SPELL }} busy={false} onReady={vi.fn()} />);
    expect((await screen.findAllByText("Deck Master must be a playable monster card")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Use Test Spell as Deck Master/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear Deck Master" })).toBeInTheDocument();
  });
});

describe("a refused save", () => {
  it("shows the server's words for a 400 on save or Ready", () => {
    const message = "You can't use a Spell or Trap as your Deck Master.";
    expect(duelActionErrorText(new DuelRequestError(message, 400))).toBe(message);
  });
});

describe("useDeckCardMeta", () => {
  it("asks only for the codes it does not know when the deck changes", async () => {
    const { result, rerender } = renderHook(({ main }: { main: number[] }) => useDeckCardMeta({ main, extra: [], side: [] }), {
      initialProps: { main: [MONSTER, SPELL] },
    });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(getDuelCards).toHaveBeenCalledTimes(1);
    expect(getDuelCards.mock.calls[0][0].sort()).toEqual([MONSTER, SPELL]);
    rerender({ main: [MONSTER, SPELL, TRAP] });
    await waitFor(() => expect(result.current.size).toBe(3));
    expect(getDuelCards).toHaveBeenCalledTimes(2);
    expect(getDuelCards.mock.calls[1][0]).toEqual([TRAP]);
    rerender({ main: [SPELL] });
    expect(getDuelCards).toHaveBeenCalledTimes(2);
  });

  it("asks again when the retry value changes after a failure", async () => {
    getDuelCards.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    const { result, rerender } = renderHook(({ retry }: { retry: number }) => useDeckCardMeta({ main: [MONSTER], extra: [], side: [] }, { retry }), {
      initialProps: { retry: 0 },
    });
    await waitFor(() => expect(getDuelCards).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(result.current.size).toBe(0);
    rerender({ retry: 1 });
    await waitFor(() => expect(result.current.size).toBe(1));
  });
});
