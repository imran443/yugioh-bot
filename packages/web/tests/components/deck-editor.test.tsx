// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardQuery, DeckCardInfo, SavedDeck } from "@yugidraft/shared/duels";
import { SavedDeckEditor } from "../../src/components/decks/editor";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/decks/new",
}));

function card(code: number, name: string, type: number, level = 0): DeckCardInfo {
  return {
    code,
    name,
    description: `${name} text.`,
    type,
    attack: 3000,
    defense: 2500,
    level,
    attribute: 0x10,
    race: "Dragon",
    alias: 0,
    setcodes: [],
    lscale: 0,
    rscale: 0,
    arrows: 0,
    ot: 3,
  };
}

const BLUE_EYES = card(89631139, "Blue-Eyes White Dragon", 0x11, 8);
const POT = card(55144522, "Pot of Greed", 0x2);
const FUSION = card(23995346, "Blue-Eyes Ultimate Dragon", 0x41, 12);
const CARDS = [BLUE_EYES, POT, FUSION];
const queries: CardQuery[] = [];
const searchErrors: string[] = [];
const deleted: number[] = [];
let stored: SavedDeck | null = null;

function savedDeck(main: number[]): SavedDeck {
  return { id: 7, name: "Goat control", mode: "normal", deck: { main, extra: [], side: [] }, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/decks/cards/facets") {
      return Response.json({ archetypes: [], banlists: { "tcg-2026-09": { [POT.code]: 0, [BLUE_EYES.code]: 2 } } });
    }
    if (url === "/api/decks/cards") {
      const query = JSON.parse(String(init?.body)) as CardQuery;
      queries.push(query);
      const error = searchErrors.shift();
      if (error) return Response.json({ error }, { status: 503 });
      // The host folds case and punctuation, so "blue eyes" finds "Blue-Eyes White Dragon".
      const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const cards = CARDS.filter((entry) => fold(entry.name).includes(fold(query.text)));
      return Response.json({ cards, total: cards.length, offset: 0 });
    }
    if (url === "/api/duels/cards") {
      const { codes } = JSON.parse(String(init?.body)) as { codes: number[] };
      return Response.json({ cards: CARDS.filter((entry) => codes.includes(entry.code)), missing: [] });
    }
    if (url === "/api/decks/7" && init?.method === "DELETE") {
      deleted.push(7);
      return Response.json({ ok: true });
    }
    if (url === "/api/decks/7" && stored) return Response.json({ deck: stored });
    if (url === "/api/decks" && init?.method === "POST") {
      return Response.json({ deck: { ...savedDeck([]), ...JSON.parse(String(init.body)) } }, { status: 201 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }));
});

afterEach(() => {
  queries.length = 0;
  searchErrors.length = 0;
  deleted.length = 0;
  stored = null;
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** A real mouse click: the primary-button press, then the click with a detail of 1. */
function mouseClick(element: Element, init: { ctrlKey?: boolean; metaKey?: boolean; detail?: number } = {}) {
  fireEvent.pointerDown(element, { pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(element, { pointerType: "mouse", button: 0 });
  fireEvent.click(element, { detail: 1, ...init });
}

function mainCards() {
  return within(screen.getByRole("region", { name: "Main Deck" })).queryAllByRole("button", { name: /Main Deck card/ });
}

describe("SavedDeckEditor", () => {
  it.each([81480461, 81480462])("loads the original metadata for saved artwork %i without a card search", async (code) => {
    const base = card(81480460, "Barrel Dragon", 0x21, 7);
    const art = { ...base, code: 81480461, alias: base.code };
    const secondArt = { ...base, code: 81480462, alias: art.code };
    stored = savedDeck([code]);
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      if (url === "/api/duels/cards") {
        const { codes } = JSON.parse(String(init?.body)) as { codes: number[] };
        return Response.json({ cards: [base, art, secondArt].filter((entry) => codes.includes(entry.code)), missing: [] });
      }
      return original(url, init);
    });
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /Barrel Dragon, Main Deck card/ });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/duels/cards", expect.objectContaining({ body: JSON.stringify({ codes: [base.code], mode: "normal" }) })));
  });
  it("counts a saved Barrel Dragon artwork against the canonical draft pool on load", async () => {
    const base = card(81480460, "Barrel Dragon", 0x21, 7);
    const art = { ...base, code: 81480461, alias: base.code };
    stored = { ...savedDeck([art.code]), draftId: 3 };
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      if (url === "/api/duels/cards") {
        const { codes } = JSON.parse(String(init?.body)) as { codes: number[] };
        return Response.json({ cards: [base, art].filter((entry) => codes.includes(entry.code)), missing: [] });
      }
      return original(url, init);
    });
    render(<SavedDeckEditor deckId="7" pool={{ slug: "retro", draftId: 3, draftName: "Retro draft", cards: [{ code: base.code, count: 1 }], mainPoolCount: 1, unresolved: [], savedDeckId: 7, registration: null }} />);
    const full = await screen.findByRole("button", { name: "Barrel Dragon, 0 copies left in your pool" });
    expect(screen.getByText("1 card in your pool")).toBeInTheDocument();
    expect(screen.getByText(/not in the deck/)).toHaveTextContent("0 not in the deck");
    fireEvent.doubleClick(full);
    expect(mainCards()).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("no copies left in your pool");
  });
  it("adds cards from the card list, stops at three copies and undoes", async () => {
    render(<SavedDeckEditor />);
    const tile = await screen.findByRole("button", { name: "Blue-Eyes White Dragon" });

    fireEvent.doubleClick(tile);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Blue-Eyes White Dragon, 1 in deck/ }));
    fireEvent.doubleClick(screen.getByRole("button", { name: /^Blue-Eyes White Dragon, 2 in deck/ }));
    await waitFor(() => expect(mainCards()).toHaveLength(3));

    fireEvent.doubleClick(screen.getByRole("button", { name: /^Blue-Eyes White Dragon, 3 in deck/ }));
    expect(mainCards()).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent("you already have 3 copies");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(mainCards()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(mainCards()).toHaveLength(3);

    fireEvent.keyDown(mainCards()[0]!, { key: "Delete" });
    expect(mainCards()).toHaveLength(2);
  });

  it("uses the chosen banlist for copy limits", async () => {
    render(<SavedDeckEditor />);
    await screen.findByRole("button", { name: "Pot of Greed" });

    fireEvent.change(screen.getByLabelText("Banlist"), { target: { value: "tcg-2026-09" } });
    const pot = await screen.findByRole("button", { name: "Pot of Greed, Forbidden" });
    fireEvent.doubleClick(pot);

    expect(mainCards()).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("Pot of Greed");
    expect(screen.getByRole("status")).toHaveTextContent("is Forbidden");
  });

  it("shows card text and deck controls for the selected card", async () => {
    render(<SavedDeckEditor />);
    fireEvent.click(await screen.findByRole("button", { name: "Blue-Eyes White Dragon" }));

    const details = screen.getByRole("complementary", { name: "Card details" });
    fireEvent.click(within(details).getByRole("button", { name: "Add one Blue-Eyes White Dragon to Side" }));
    expect(within(screen.getByRole("region", { name: "Side Deck" })).getAllByRole("button", { name: /Side Deck card/ })).toHaveLength(1);
    expect(mainCards()).toHaveLength(0);
  });

  it("shows the card under the pointer in the card details pane", async () => {
    render(<SavedDeckEditor />);
    fireEvent.click(await screen.findByRole("button", { name: "Blue-Eyes White Dragon" }));
    const details = screen.getByRole("complementary", { name: "Card details" });
    expect(within(details).getByRole("heading", { name: "Blue-Eyes White Dragon" })).toBeInTheDocument();

    fireEvent.pointerEnter(screen.getByRole("button", { name: "Pot of Greed" }));
    expect(await within(details).findByRole("heading", { name: "Pot of Greed" })).toBeInTheDocument();
    expect(within(details).getByText("Pot of Greed text.")).toBeInTheDocument();
    // Deck controls stay with the selected card, so they hide while another card shows.
    expect(within(details).queryByRole("button", { name: /Add one/ })).toBeNull();

    fireEvent.pointerLeave(screen.getByRole("button", { name: "Pot of Greed" }));
    expect(await within(details).findByRole("heading", { name: "Blue-Eyes White Dragon" })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Add one Blue-Eyes White Dragon to Main" })).toBeInTheDocument();
  });

  it("ends the pointer preview when a new search removes the card", async () => {
    render(<SavedDeckEditor />);
    fireEvent.click(await screen.findByRole("button", { name: "Blue-Eyes White Dragon" }));
    const details = screen.getByRole("complementary", { name: "Card details" });

    fireEvent.pointerEnter(screen.getByRole("button", { name: "Pot of Greed" }));
    expect(await within(details).findByRole("heading", { name: "Pot of Greed" })).toBeInTheDocument();

    // The tile goes away under a still pointer, so it never sends pointerleave.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "blue" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Pot of Greed" })).toBeNull());
    expect(await within(details).findByRole("heading", { name: "Blue-Eyes White Dragon" })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Add one Blue-Eyes White Dragon to Main" })).toBeInTheDocument();
  });

  it("ends the pointer preview when the test hand closes", async () => {
    render(<SavedDeckEditor />);
    fireEvent.click(await screen.findByRole("button", { name: "Pot of Greed" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Blue-Eyes White Dragon" }));
    await waitFor(() => expect(mainCards()).toHaveLength(1));
    const details = screen.getByRole("complementary", { name: "Card details" });

    fireEvent.click(screen.getByRole("button", { name: "Test hand" }));
    const hand = screen.getByRole("region", { name: "Test hand" });
    fireEvent.pointerEnter(within(hand).getByRole("button", { name: "Blue-Eyes White Dragon" }));
    expect(await within(details).findByRole("heading", { name: "Blue-Eyes White Dragon" })).toBeInTheDocument();

    // Undo changes the Main Deck, which closes the hand under the pointer.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByRole("region", { name: "Test hand" })).toBeNull();
    expect(within(details).getByRole("heading", { name: "Pot of Greed" })).toBeInTheDocument();
  });

  it("undoes a format change", async () => {
    render(<SavedDeckEditor />);
    await screen.findByRole("button", { name: "Pot of Greed" });

    fireEvent.click(screen.getByRole("button", { name: "Domain" }));
    expect(screen.getByRole("region", { name: "Deck Master" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByRole("region", { name: "Deck Master" })).toBeNull();
    expect(screen.getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "true");
  });

  it("sends the search text to the card query", async () => {
    render(<SavedDeckEditor />);
    await screen.findByRole("button", { name: "Pot of Greed" });

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "pot" } });
    await waitFor(() => expect(queries.at(-1)?.text).toBe("pot"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Blue-Eyes White Dragon" })).toBeNull());
  });

  it("finds a card from a lowercase partial name, with no passcode, and adds it to the deck", async () => {
    render(<SavedDeckEditor />);
    await screen.findByRole("button", { name: "Pot of Greed" });

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "blue eyes" } });
    await waitFor(() => expect(queries.at(-1)?.text).toBe("blue eyes"));
    const tile = await screen.findByRole("button", { name: "Blue-Eyes White Dragon" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Pot of Greed" })).toBeNull());

    fireEvent.doubleClick(tile);
    expect(mainCards()).toHaveLength(1);
    expect(mainCards()[0]).toHaveAccessibleName(/Blue-Eyes White Dragon/);
  });

  it("searches the draft pool by a lowercase partial name and adds the match from the pool", async () => {
    const pool = { slug: "retro", draftId: 3, draftName: "Retro draft", cards: [{ code: BLUE_EYES.code, count: 2 }, { code: POT.code, count: 1 }], mainPoolCount: 3, unresolved: [], savedDeckId: null, registration: null };
    render(<SavedDeckEditor pool={pool} />);
    await screen.findByRole("button", { name: "Pot of Greed, 1 copy left in your pool" });

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "blue eyes" } });
    const tile = await screen.findByRole("button", { name: "Blue-Eyes White Dragon, 2 copies left in your pool" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Pot of Greed/ })).toBeNull());

    fireEvent.doubleClick(tile);
    expect(screen.getByRole("button", { name: "Blue-Eyes White Dragon, 1 copy left in your pool" })).toBeInTheDocument();
    expect(mainCards()).toHaveLength(1);
  });

  describe("draft deck copy limit", () => {
    const draftPool = (cards: Array<{ code: number; count: number }>, forcedCopies?: Record<string, number>) => ({
      slug: "retro", draftId: 3, draftName: "Retro draft", cards, forcedCopies, mainPoolCount: 5, unresolved: [], savedDeckId: null, registration: null,
    });

    it("allows a 4th copy for one forced pick and blocks the 5th", async () => {
      render(<SavedDeckEditor pool={draftPool([{ code: BLUE_EYES.code, count: 5 }], { [BLUE_EYES.code]: 1 })} />);
      const tile = await screen.findByRole("button", { name: "Blue-Eyes White Dragon, 4 copies left in your pool" });
      fireEvent.doubleClick(tile);
      fireEvent.doubleClick(screen.getByRole("button", { name: "Blue-Eyes White Dragon, 3 copies left in your pool" }));
      fireEvent.doubleClick(screen.getByRole("button", { name: "Blue-Eyes White Dragon, 2 copies left in your pool" }));
      fireEvent.doubleClick(screen.getByRole("button", { name: "Blue-Eyes White Dragon, 1 copy left in your pool" }));
      expect(mainCards()).toHaveLength(4);
      const full = screen.getByRole("button", { name: "Blue-Eyes White Dragon, 0 copies left in your pool" });
      fireEvent.doubleClick(full);
      expect(mainCards()).toHaveLength(4);
      expect(screen.getByRole("status")).toHaveTextContent("no copies left in your pool");
      fireEvent.click(mainCards()[0]);
      const summary = screen.getAllByText((_, el) => el?.tagName === "P" && /4\s*of\s*4\s*pool copies in deck/.test(el.textContent ?? ""));
      expect(summary.length).toBeGreaterThan(0);
      expect(screen.getAllByText(/incl\. forced pick/).length).toBeGreaterThan(0);
    });

    it("counts a forced copy under the canonical code of an alternate artwork", async () => {
      const base = card(81480460, "Barrel Dragon", 0x21, 7);
      const art = { ...base, code: 81480461, alias: base.code };
      const fetch = vi.mocked(globalThis.fetch);
      const original = fetch.getMockImplementation()!;
      fetch.mockImplementation(async (url, init) => {
        if (url === "/api/duels/cards") {
          const { codes } = JSON.parse(String(init?.body)) as { codes: number[] };
          return Response.json({ cards: [base, art].filter((entry) => codes.includes(entry.code)), missing: [] });
        }
        return original(url, init);
      });
      stored = { ...savedDeck([art.code, art.code, art.code, base.code]), draftId: 3 };
      render(<SavedDeckEditor deckId="7" pool={draftPool([{ code: base.code, count: 4 }], { [art.code]: 1 })} />);
      await screen.findByRole("button", { name: "Barrel Dragon, 0 copies left in your pool" });
    });

    it("caps a draft deck with no forced pick at 3 even when the pool has more", async () => {
      render(<SavedDeckEditor pool={draftPool([{ code: BLUE_EYES.code, count: 5 }])} />);
      fireEvent.doubleClick(await screen.findByRole("button", { name: "Blue-Eyes White Dragon, 3 copies left in your pool" }));
      fireEvent.doubleClick(screen.getByRole("button", { name: "Blue-Eyes White Dragon, 2 copies left in your pool" }));
      fireEvent.doubleClick(screen.getByRole("button", { name: "Blue-Eyes White Dragon, 1 copy left in your pool" }));
      expect(mainCards()).toHaveLength(3);
      fireEvent.doubleClick(screen.getByRole("button", { name: "Blue-Eyes White Dragon, 0 copies left in your pool" }));
      expect(mainCards()).toHaveLength(3);
    });
  });

  it("caps a normal deck at 3 copies", async () => {
    stored = savedDeck([BLUE_EYES.code, BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await waitFor(() => expect(mainCards()).toHaveLength(3));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "blue eyes" } });
    await waitFor(() => expect(queries.at(-1)?.text).toBe("blue eyes"));
    fireEvent.doubleClick(await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, 3 in deck/ }));
    expect(mainCards()).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent("you already have 3 copies");
  });

  it("uses copy for one Forbidden card and makes problem rows select their card", async () => {
    stored = savedDeck([POT.code, BLUE_EYES.code, BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /Pot of Greed, Main Deck card/ });
    fireEvent.change(screen.getByLabelText("Banlist"), { target: { value: "tcg-2026-09" } });
    const details = screen.getByRole("complementary", { name: "Card details" });
    const problem = await within(details).findByRole("button", { name: "Pot of Greed 1 copy, Forbidden" });
    expect(within(details).getByText("3 copies, 2 allowed on TCG September 2026")).toBeInTheDocument();
    expect(screen.queryByText(/1 copies/)).toBeNull();
    expect(within(details).getByText(/On TCG September 2026\. You can save an unfinished deck/)).toBeInTheDocument();
    fireEvent.click(problem);
    expect(within(details).getByRole("heading", { name: "Pot of Greed" })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Remove one Pot of Greed from Main" })).toBeInTheDocument();
  });

  it("shows the missing-engine banner and retries card search without blocking saves", async () => {
    searchErrors.push("The duel engine is not set up on this server: DUEL_INTERNAL_URL is missing.");
    render(<SavedDeckEditor />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Card search isn't available. The duel engine is not set up on this server. Your deck is safe and still saves.");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Blue-Eyes White Dragon" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(queries).toHaveLength(2);
  });

  it("uses generic copy for another search failure and still saves the deck", async () => {
    searchErrors.push("Request failed (502)");
    render(<SavedDeckEditor />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Card search failed. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("hides Import, Delete, the more menu, format and banlist in pool mode", async () => {
    render(<SavedDeckEditor pool={{ slug: "retro", draftId: 3, draftName: "Retro draft", cards: [{ code: BLUE_EYES.code, count: 2 }, { code: POT.code, count: 1 }], mainPoolCount: 3, unresolved: [], savedDeckId: null, registration: null }} />);
    const tile = await screen.findByRole("button", { name: "Blue-Eyes White Dragon, 2 copies left in your pool" });
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More deck actions" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Format" })).toBeNull();
    expect(screen.queryByLabelText("Banlist")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to the draft" })).toHaveAttribute("href", "/draft/retro");
    expect(screen.getByText("Draft deck from Retro draft")).toBeInTheDocument();
    expect(screen.getByText("3 cards in your pool")).toBeInTheDocument();
    // the bar's rule line is short enough for one line; the full sentence sits in its tooltip
    expect(screen.getByText("Main: all 3 cards. Extra: up to 15.")).toBeInTheDocument();
    expect(screen.getByText("Draft deck from Retro draft").closest("p")).toHaveAttribute("title", expect.stringContaining("all 3 main deck cards"));
    fireEvent.doubleClick(tile);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Blue-Eyes White Dragon, 1 copy left in your pool" }));
    const full = screen.getByRole("button", { name: "Blue-Eyes White Dragon, 0 copies left in your pool" });
    expect(full).toHaveAttribute("data-full", "true");
    expect(within(full).getByText("0 left")).toBeInTheDocument();
    fireEvent.doubleClick(full);
    expect(mainCards()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("A draft deck needs at least 3 main deck cards.")).toBeInTheDocument();
  });

  it("keeps the page bar and the menu button in the loading screen and the loaded draft editor", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, this.hasAttribute("data-pool") ? 0 : 118, 1204, 788);
    });
    try {
      const { container } = render(<SavedDeckEditor deckId="7" pool={{ slug: "retro", draftId: 3, draftName: "Retro draft", cards: [{ code: BLUE_EYES.code, count: 2 }], mainPoolCount: 2, unresolved: [], savedDeckId: 7, registration: null }} />);
      expect(screen.getByText("Loading deck…")).toBeInTheDocument();
      expect(container.querySelector("[data-shell-bar='own']")).not.toBeNull();
      expect(screen.getByRole("heading", { name: "Draft deck" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to the draft" })).toHaveAttribute("href", "/draft/retro");
      expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
      await screen.findByRole("button", { name: /Blue-Eyes White Dragon, Main Deck card/ });
      expect(container.querySelector("[data-shell-bar='own']")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
      expect(container.querySelector<HTMLElement>("[data-pool]")?.style.getPropertyValue("--de-top")).toBe("0px");
    } finally {
      bounds.mockRestore();
    }
  });

  it("leaves a saved deck without the shell bar or menu button", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    const { container } = render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /Blue-Eyes White Dragon, Main Deck card/ });
    expect(container.querySelector("[data-shell-bar='own']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });

  it("puts Delete in the more menu and focuses Keep before confirming", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /Blue-Eyes White Dragon, Main Deck card/ });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    const more = screen.getByRole("button", { name: "More deck actions" });
    more.focus();
    fireEvent.click(more);
    const menu = await screen.findByRole("menu", { name: "More deck actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete Goat control?" });
    await waitFor(() => expect(within(confirm).getByRole("button", { name: "Keep" })).toHaveFocus());
    expect(confirm.closest(".ms-flow")).not.toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep" }));
    expect(deleted).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(more);
    fireEvent.click(within(await screen.findByRole("menu", { name: "More deck actions" })).getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete Goat control?" })).getByRole("button", { name: "Delete deck" }));
    await waitFor(() => expect(deleted).toEqual([7]));
  });

  it("imports pasted cards in a portal and restores the previous deck with Undo", async () => {
    render(<SavedDeckEditor />);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Blue-Eyes White Dragon" }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    const popover = await screen.findByRole("dialog", { name: "Import a deck" });
    expect(popover.closest(".ms-flow")).not.toBeNull();
    fireEvent.change(within(popover).getByLabelText("Or paste YDK text or a ydke:// link"), { target: { value: `#main\n${POT.code}\n#extra\n!side` } });
    fireEvent.click(within(popover).getByRole("button", { name: "Load paste" }));
    expect(mainCards()[0]).toHaveAccessibleName(/Pot of Greed/);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(mainCards()).toHaveLength(1);
    expect(mainCards()[0]).toHaveAccessibleName(/Blue-Eyes White Dragon/);
  });

  it("uses the container width for the phone sheet and returns focus to its card", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() { this.callback([{ contentRect: { width: 390 } }]); }
      disconnect() {}
    });
    const { container } = render(<SavedDeckEditor />);
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    const tile = await screen.findByRole("button", { name: "Blue-Eyes White Dragon" });
    fireEvent.click(tile);
    const sheet = await screen.findByRole("dialog", { name: "Blue-Eyes White Dragon" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(container.contains(sheet)).toBe(false);
    const close = within(sheet).getByRole("button", { name: "Close card" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(within(sheet).getByRole("button", { name: "Add one Blue-Eyes White Dragon to Side" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Blue-Eyes White Dragon" })).toBeNull();
    expect(tile).toHaveFocus();
    fireEvent.keyDown(window, { key: "/" });
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
    expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps slash shortcut focus inside the open card sheet", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() { this.callback([{ contentRect: { width: 390 } }]); }
      disconnect() {}
    });
    render(<SavedDeckEditor />);
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    const search = screen.getByRole("searchbox");
    const tile = await screen.findByRole("button", { name: "Blue-Eyes White Dragon" });
    fireEvent.click(tile);
    const sheet = await screen.findByRole("dialog", { name: "Blue-Eyes White Dragon" });
    const close = within(sheet).getByRole("button", { name: "Close card" });
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.keyDown(close, { key: "/" });
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(close).toHaveFocus();
    expect(search).not.toHaveFocus();
    expect(sheet).toBeInTheDocument();

    fireEvent.keyDown(close, { key: "Escape" });
    expect(tile).toHaveFocus();
    fireEvent.keyDown(tile, { key: "/" });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it.each(["list", "deck"] as const)("keeps the card sheet closed when dragging from the %s below 960px", async (source) => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() { this.callback([{ contentRect: { width: 959 } }]); }
      disconnect() {}
    });
    stored = savedDeck([BLUE_EYES.code]);
    const { container } = render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /Blue-Eyes White Dragon, Main Deck card/ });
    fireEvent.click(screen.getByRole("tab", { name: source === "list" ? "Cards" : /^Deck/ }));
    const tile = await screen.findByRole("button", { name: source === "list" ? "Blue-Eyes White Dragon, 1 in deck" : /Blue-Eyes White Dragon, Main Deck card/ });
    const data = new Map<string, string>();
    const transfer = { types: [] as string[], effectAllowed: "copyMove", dropEffect: "move", setData(type: string, value: string) { data.set(type, value); this.types = [...data.keys()]; }, getData(type: string) { return data.get(type) ?? ""; } };

    fireEvent.dragStart(tile, { dataTransfer: transfer });
    expect(tile).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.firstElementChild).not.toHaveAttribute("aria-hidden", "true");
    const side = screen.getByRole("region", { name: "Side Deck" });
    fireEvent.drop(side, { dataTransfer: transfer });
    expect(mainCards()).toHaveLength(source === "list" ? 1 : 0);
    const moved = within(side).getByRole("button", { name: /Blue-Eyes White Dragon, Side Deck card/ });

    fireEvent.dragStart(moved, { dataTransfer: transfer });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.drop(screen.getByRole("complementary", { name: "Card list" }), { dataTransfer: transfer });
    expect(within(side).queryByRole("button", { name: /Side Deck card/ })).toBeNull();
  });

  it("keeps drag moves between sections and drag removal to the card list", async () => {
    render(<SavedDeckEditor />);
    const tile = await screen.findByRole("button", { name: "Blue-Eyes White Dragon" });
    const data = new Map<string, string>();
    const transfer = { types: [] as string[], effectAllowed: "copyMove", dropEffect: "move", setData(type: string, value: string) { data.set(type, value); this.types = [...data.keys()]; }, getData(type: string) { return data.get(type) ?? ""; } };
    fireEvent.dragStart(tile, { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("region", { name: "Main Deck" }), { dataTransfer: transfer });
    expect(mainCards()).toHaveLength(1);
    fireEvent.dragStart(mainCards()[0]!, { dataTransfer: transfer });
    const side = screen.getByRole("region", { name: "Side Deck" });
    fireEvent.drop(side, { dataTransfer: transfer });
    expect(mainCards()).toHaveLength(0);
    const moved = within(side).getByRole("button", { name: /Blue-Eyes White Dragon, Side Deck card/ });
    fireEvent.dragStart(moved, { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("complementary", { name: "Card list" }), { dataTransfer: transfer });
    expect(within(side).queryByRole("button", { name: /Side Deck card/ })).toBeNull();
  });

  it("opens the build tips on an empty new deck and keeps the section guidance", async () => {
    render(<SavedDeckEditor />);
    await screen.findByRole("button", { name: "Blue-Eyes White Dragon" });
    const summary = screen.getByText("How to build");
    expect(summary.closest("details")).toHaveAttribute("open");
    const main = screen.getByRole("region", { name: "Main Deck" });
    expect(within(main).getByRole("meter", { name: "Main 0 cards. Tables want 40 to 60." })).toHaveAttribute("data-state", "short");
    expect(within(main).getByText("40 short")).toBeInTheDocument();
    expect(within(main).getByText("Add cards from the list on the right.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Extra Deck" })).getByText("Fusion, Synchro, Xyz and Link monsters go here.")).toBeInTheDocument();
  });
});

describe("SavedDeckEditor registration", () => {
  const registration = (locked: boolean) => ({ tournament: { id: 4, slug: "autumn-cup", name: "Autumn cup", status: "active" }, locked });

  it("shows where the deck is in and says nothing about locking while it can still change", async () => {
    stored = { ...savedDeck([BLUE_EYES.code]), registration: registration(false) } as SavedDeck;
    render(<SavedDeckEditor deckId="7" />);
    const link = await screen.findByRole("link", { name: "Autumn cup" });
    expect(link).toHaveAttribute("href", "/tournament/autumn-cup");
    expect(screen.getByText(/Deck in/)).toBeInTheDocument();
    expect(screen.queryByText("Locked")).toBeNull();
    expect(screen.queryByText(/Changes to this deck will not reach/)).toBeNull();
  });

  it("says in one line that a locked deck's changes will not reach the tournament, and keeps editing open", async () => {
    stored = { ...savedDeck([BLUE_EYES.code]), registration: registration(true) } as SavedDeck;
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("link", { name: "Autumn cup" });
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(screen.getAllByText(/Changes to this deck will not reach Autumn cup/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByLabelText("Deck name")).toBeEnabled();
  });

  it("shows no mark for a deck that is not registered", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /Blue-Eyes White Dragon, Main Deck card/ });
    expect(screen.queryByText(/Deck in/)).toBeNull();
  });
});

describe("deck card clicks", () => {
  const sideCards = () => within(screen.getByRole("region", { name: "Side Deck" })).queryAllByRole("button", { name: /Side Deck card/ });
  const extraCards = () => within(screen.getByRole("region", { name: "Extra Deck" })).queryAllByRole("button", { name: /Extra Deck card/ });
  const pool = { slug: "retro", draftId: 3, draftName: "Retro draft", cards: [{ code: BLUE_EYES.code, count: 2 }], mainPoolCount: 2, unresolved: [], savedDeckId: null, registration: null };

  it("removes a card on a left-click and one undo step puts it back", async () => {
    stored = savedDeck([BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findAllByRole("button", { name: /Main Deck card/ });
    mouseClick(mainCards()[0]!);
    expect(mainCards()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(mainCards()).toHaveLength(2);
  });

  it("returns a removed draft card to the pool", async () => {
    render(<SavedDeckEditor pool={pool} />);
    fireEvent.doubleClick(await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, 2 copies left in your pool/ }));
    expect(mainCards()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Blue-Eyes White Dragon, 1 copy left in your pool/ })).toBeInTheDocument();
    mouseClick(mainCards()[0]!);
    expect(mainCards()).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^Blue-Eyes White Dragon, 2 copies left in your pool/ })).toBeInTheDocument();
  });

  it("moves a card to the Side Deck with Ctrl+click and back with Cmd+click", async () => {
    stored = savedDeck([BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findAllByRole("button", { name: /Main Deck card/ });
    fireEvent.click(mainCards()[0]!, { detail: 1, ctrlKey: true });
    expect(mainCards()).toHaveLength(1);
    expect(sideCards()).toHaveLength(1);
    fireEvent.click(sideCards()[0]!, { detail: 1, metaKey: true });
    expect(sideCards()).toHaveLength(0);
    expect(mainCards()).toHaveLength(2);
  });

  it("sends a Side Deck card back to the Extra Deck when it belongs there", async () => {
    stored = { ...savedDeck([]), deck: { main: [], extra: [], side: [FUSION.code] } };
    render(<SavedDeckEditor deckId="7" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Blue-Eyes Ultimate Dragon, Side Deck card/ }), { detail: 1, ctrlKey: true });
    expect(extraCards()).toHaveLength(1);
    expect(sideCards()).toHaveLength(0);
  });

  it("keeps the card in Main and says so when the format has no Side Deck", async () => {
    stored = { ...savedDeck([BLUE_EYES.code]), mode: "domain" };
    render(<SavedDeckEditor deckId="7" />);
    await screen.findAllByRole("button", { name: /Main Deck card/ });
    fireEvent.click(mainCards()[0]!, { detail: 1, ctrlKey: true });
    expect(mainCards()).toHaveLength(1);
    expect(sideCards()).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("Domain has no Side Deck.");
  });

  it("only selects on Enter or Space and on a tap; Delete and Backspace remove", async () => {
    stored = savedDeck([BLUE_EYES.code, BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findAllByRole("button", { name: /Main Deck card/ });
    // A keyboard click has no detail.
    fireEvent.click(mainCards()[0]!, { detail: 0 });
    expect(mainCards()).toHaveLength(3);
    expect(mainCards()[0]).toHaveAttribute("aria-pressed", "true");
    // A tap on a touch screen selects and removes nothing.
    fireEvent.pointerDown(mainCards()[1]!, { pointerType: "touch" });
    fireEvent.pointerUp(mainCards()[1]!, { pointerType: "touch" });
    fireEvent.click(mainCards()[1]!, { detail: 1 });
    expect(mainCards()).toHaveLength(3);
    expect(mainCards()[1]).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(mainCards()[0]!, { key: "Delete" });
    expect(mainCards()).toHaveLength(2);
    fireEvent.keyDown(mainCards()[0]!, { key: "Backspace" });
    expect(mainCards()).toHaveLength(1);
  });

  it("opens the art menu on a long press and the click that ends it removes nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      stored = savedDeck([BLUE_EYES.code]);
      const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
      vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
        if (url === "/api/duels/cards") {
          const { codes } = JSON.parse(String(init?.body)) as { codes: number[] };
          return Response.json({ cards: CARDS.filter((entry) => codes.includes(entry.code)).map((entry) => ({ ...entry, altArtCount: 1 })), missing: [] });
        }
        return original(url, init);
      });
      render(<SavedDeckEditor deckId="7" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      const tile = screen.getAllByRole("button", { name: /Main Deck card/ })[0]!;
      fireEvent.pointerDown(tile, { pointerType: "touch", clientX: 5, clientY: 5 });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(screen.getByRole("dialog", { name: "Change art of Blue-Eyes White Dragon" })).toBeInTheDocument();
      fireEvent.pointerUp(tile, { pointerType: "touch" });
      fireEvent.click(tile, { detail: 1 });
      expect(screen.getAllByRole("button", { name: /Main Deck card/ })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open the menu when the finger moves away before the long press", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      stored = savedDeck([BLUE_EYES.code]);
      render(<SavedDeckEditor deckId="7" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      const tile = screen.getAllByRole("button", { name: /Main Deck card/ })[0]!;
      fireEvent.pointerDown(tile, { pointerType: "touch", clientX: 5, clientY: 5 });
      fireEvent.pointerMove(tile, { pointerType: "touch", clientX: 5, clientY: 60 });
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the Deck Master on a left-click and says Domain has no Side Deck on Ctrl+click", async () => {
    stored = { ...savedDeck([]), mode: "domain", deck: { main: [], extra: [], side: [], deckMaster: BLUE_EYES.code } };
    render(<SavedDeckEditor deckId="7" />);
    const slot = await screen.findByRole("button", { name: "Deck Master: Blue-Eyes White Dragon" });
    fireEvent.click(slot, { detail: 1, ctrlKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("Domain has no Side Deck.");
    expect(screen.getByRole("button", { name: "Deck Master: Blue-Eyes White Dragon" })).toBeInTheDocument();
    mouseClick(slot);
    expect(screen.queryByRole("button", { name: /^Deck Master:/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Deck Master: Blue-Eyes White Dragon" })).toBeInTheDocument();
  });
});

describe("deck card copy", () => {
  const sideCards = () => within(screen.getByRole("region", { name: "Side Deck" })).queryAllByRole("button", { name: /Side Deck card/ });
  const extraCards = () => within(screen.getByRole("region", { name: "Extra Deck" })).queryAllByRole("button", { name: /Extra Deck card/ });
  const base = card(81480460, "Barrel Dragon", 0x21, 7);
  const art = { ...base, code: 81480461, alias: base.code, altArtCount: 1 };
  /** The text of the editor notice; the card panel has status lines of its own. */
  const notices = () => screen.getAllByRole("status").map((node) => node.textContent).join(" | ");
  /** A right-click with the mouse: the secondary press, then contextmenu. */
  const rightClick = (element: Element, init: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
    fireEvent.pointerDown(element, { pointerType: "mouse", button: 2, ...init });
    return fireEvent.contextMenu(element, { button: 2, ...init });
  };

  function withArt() {
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      if (url === "/api/duels/cards") {
        const { codes } = JSON.parse(String(init?.body)) as { codes: number[] };
        return Response.json({ cards: [...CARDS, base, art].filter((entry) => codes.includes(entry.code)), missing: [] });
      }
      return original(url, init);
    });
  }

  it("adds a copy next to the clicked card on Ctrl+right-click, without the browser menu or the art menu", async () => {
    withArt();
    stored = savedDeck([art.code, POT.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Barrel Dragon, Main Deck card 1/ });
    await screen.findByRole("button", { name: /^Pot of Greed, Main Deck card 2/ });
    expect(rightClick(mainCards()[0]!, { ctrlKey: true })).toBe(false);
    expect(mainCards().map((tile) => tile.getAttribute("aria-label")?.split(",")[0])).toEqual(["Barrel Dragon", "Barrel Dragon", "Pot of Greed"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mainCards()[1]).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the art passcode of the clicked copy", async () => {
    withArt();
    stored = savedDeck([art.code, base.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Barrel Dragon, Main Deck card 1/ });
    const artOf = (tile: Element) => tile.querySelector("img")?.getAttribute("src") ?? "";
    const before = mainCards().map(artOf);
    rightClick(mainCards()[0]!, { ctrlKey: true });
    const after = mainCards().map(artOf);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
    expect(before[0]).not.toBe(before[1]);
  });

  it("copies into the Extra and Side Decks where the clicked card sits", async () => {
    stored = { ...savedDeck([]), deck: { main: [], extra: [FUSION.code], side: [POT.code] } };
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Blue-Eyes Ultimate Dragon, Extra Deck card 1/ });
    await screen.findByRole("button", { name: /^Pot of Greed, Side Deck card 1/ });
    rightClick(extraCards()[0]!, { ctrlKey: true });
    rightClick(sideCards()[0]!, { ctrlKey: true });
    expect(extraCards()).toHaveLength(2);
    expect(sideCards()).toHaveLength(2);
    expect(mainCards()).toHaveLength(0);
  });

  it("is blocked at three copies, with the notice of a blocked add", async () => {
    stored = savedDeck([BLUE_EYES.code, BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    rightClick(mainCards()[0]!, { ctrlKey: true });
    expect(mainCards()).toHaveLength(3);
    expect(notices()).toContain("you already have 3 copies");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("counts copies across Main, Extra and Side against the limit of three", async () => {
    stored = { ...savedDeck([BLUE_EYES.code]), deck: { main: [BLUE_EYES.code], extra: [], side: [BLUE_EYES.code, BLUE_EYES.code] } };
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    rightClick(mainCards()[0]!, { ctrlKey: true });
    expect(mainCards()).toHaveLength(1);
    expect(sideCards()).toHaveLength(2);
    expect(notices()).toContain("you already have 3 copies");
  });

  it("is blocked at the banlist limit", async () => {
    stored = savedDeck([BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    fireEvent.change(screen.getByLabelText("Banlist"), { target: { value: "tcg-2026-09" } });
    await screen.findByRole("button", { name: "Pot of Greed, Forbidden" });
    rightClick(mainCards()[0]!, { ctrlKey: true });
    expect(mainCards()).toHaveLength(2);
    expect(notices()).toContain("Blue-Eyes White Dragon");
  });

  it("is blocked when the draft pool has no copy left, and adds while it has one", async () => {
    const pool = { slug: "retro", draftId: 3, draftName: "Retro draft", cards: [{ code: BLUE_EYES.code, count: 2 }], mainPoolCount: 2, unresolved: [], savedDeckId: null, registration: null };
    render(<SavedDeckEditor pool={pool} />);
    fireEvent.doubleClick(await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, 2 copies left in your pool/ }));
    rightClick(mainCards()[0]!, { ctrlKey: true });
    expect(mainCards()).toHaveLength(2);
    rightClick(mainCards()[0]!, { ctrlKey: true });
    expect(mainCards()).toHaveLength(2);
    expect(notices()).toContain("no copies left in your pool");
  });

  it("opens the art menu on a plain right-click and adds nothing", async () => {
    withArt();
    stored = savedDeck([art.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Barrel Dragon, Main Deck card 1/ });
    rightClick(mainCards()[0]!);
    expect(await screen.findByRole("dialog", { name: "Change art of Barrel Dragon" })).toBeInTheDocument();
    expect(mainCards()).toHaveLength(1);
  });

  it("adds a copy with the + and = keys and undoes it in one step", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    expect(mainCards()[0]).toHaveAttribute("aria-keyshortcuts", expect.stringContaining("Plus"));
    fireEvent.keyDown(mainCards()[0]!, { key: "+", shiftKey: true });
    expect(mainCards()).toHaveLength(2);
    fireEvent.keyDown(mainCards()[0]!, { key: "=" });
    expect(mainCards()).toHaveLength(3);
    fireEvent.keyDown(mainCards()[0]!, { key: "+" });
    expect(mainCards()).toHaveLength(3);
    expect(notices()).toContain("you already have 3 copies");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(mainCards()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(mainCards()).toHaveLength(1);
  });

  it("makes the copy dirty so the deck can be saved", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    rightClick(mainCards()[0]!, { ctrlKey: true });
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0);
  });

  it("copies nothing from the Deck Master, which cannot also be in the deck, and opens no menu", async () => {
    stored = { ...savedDeck([]), mode: "domain", deck: { main: [], extra: [], side: [], deckMaster: BLUE_EYES.code } };
    render(<SavedDeckEditor deckId="7" />);
    const slot = await screen.findByRole("button", { name: "Deck Master: Blue-Eyes White Dragon" });
    expect(rightClick(slot, { ctrlKey: true })).toBe(false);
    expect(mainCards()).toHaveLength(0);
    expect(extraCards()).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(notices()).toContain("The Deck Master cannot also be in the deck.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });
});

describe("deck card copy feedback and guards", () => {
  const notices = () => screen.getAllByRole("status").map((node) => node.textContent).join(" | ");

  it("says what was added and how many copies the deck has now", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    const tile = await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    fireEvent.keyDown(tile, { key: "=" });
    expect(notices()).toContain("Added Blue-Eyes White Dragon (2 of 3).");
  });

  it("adds one copy for one key press, not for a held key", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    const tile = await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    fireEvent.keyDown(tile, { key: "+", repeat: true });
    fireEvent.keyDown(tile, { key: "+", repeat: true });
    expect(mainCards()).toHaveLength(1);
    fireEvent.keyDown(tile, { key: "+" });
    expect(mainCards()).toHaveLength(2);
  });

  it("adds nothing on Ctrl+= or Cmd++, which stay with the browser", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    const tile = await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    fireEvent.keyDown(tile, { key: "=", ctrlKey: true });
    fireEvent.keyDown(tile, { key: "+", metaKey: true });
    fireEvent.keyDown(tile, { key: "+", ctrlKey: true, shiftKey: true });
    expect(mainCards()).toHaveLength(1);
  });

  it("does not copy a card that is not in the card database", async () => {
    stored = savedDeck([123456789]);
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (url === "/api/duels/cards") return Response.json({ cards: [], missing: [123456789] });
      if (url === "/api/decks/7") return Response.json({ deck: stored });
      return Response.json({ archetypes: [], banlists: {}, cards: [], total: 0, offset: 0 });
    });
    render(<SavedDeckEditor deckId="7" />);
    const tile = await screen.findByRole("button", { name: /not in the card database/ });
    fireEvent.keyDown(tile, { key: "+" });
    expect(mainCards()).toHaveLength(1);
    expect(notices()).toContain("123456789 is not in the card database.");
  });
});

describe("Domain one copy of each card", () => {
  const domainDeck = (main: number[]): SavedDeck => ({ ...savedDeck(main), mode: "domain" });

  it("blocks a second copy added from the card list, and flags two copies in the deck", async () => {
    stored = domainDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "blue eyes" } });
    await waitFor(() => expect(queries.at(-1)?.text).toBe("blue eyes"));
    fireEvent.doubleClick(await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, 1 in deck/ }));
    expect(mainCards()).toHaveLength(1);
    expect(screen.getAllByRole("status").map((node) => node.textContent).join(" | ")).toContain("Domain decks hold one copy of each card.");
  });

  it("adds no copy on Ctrl+right-click or the + key, and says why", async () => {
    stored = domainDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    const tile = await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    fireEvent.pointerDown(tile, { pointerType: "mouse", button: 2, ctrlKey: true });
    expect(fireEvent.contextMenu(tile, { button: 2, ctrlKey: true })).toBe(false);
    expect(mainCards()).toHaveLength(1);
    expect(screen.getAllByRole("status").map((node) => node.textContent).join(" | ")).toContain("Domain decks hold one copy of each card.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a draft deck in Domain at one copy of a card, even when the pool holds more", async () => {
    stored = { ...domainDeck([BLUE_EYES.code]), draftId: 3 };
    const pool = { slug: "retro", draftId: 3, draftName: "Retro draft", cards: [{ code: BLUE_EYES.code, count: 2 }], mainPoolCount: 2, unresolved: [], savedDeckId: 7, registration: null };
    render(<SavedDeckEditor deckId="7" pool={pool} />);
    await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    fireEvent.doubleClick(await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, 1 copy left in your pool/ }));
    expect(mainCards()).toHaveLength(1);
    expect(screen.getAllByRole("status").map((node) => node.textContent).join(" | ")).toContain("Domain decks hold one copy of each card.");
  });

  it("flags two copies in a Domain draft deck", async () => {
    stored = { ...domainDeck([BLUE_EYES.code, BLUE_EYES.code]), draftId: 3 };
    const pool = { slug: "retro", draftId: 3, draftName: "Retro draft", cards: [{ code: BLUE_EYES.code, count: 2 }], mainPoolCount: 2, unresolved: [], savedDeckId: 7, registration: null };
    render(<SavedDeckEditor deckId="7" pool={pool} />);
    await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    expect(screen.getAllByText(/1 card has too many copies/).length).toBeGreaterThan(0);
  });

  it("lets another art replace the current Deck Master, which adds no copy", async () => {
    const base = card(81480460, "Barrel Dragon", 0x21, 7);
    const art = { ...base, code: 81480461, alias: base.code };
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      if (url === "/api/duels/cards") {
        const { codes } = JSON.parse(String(init?.body)) as { codes: number[] };
        return Response.json({ cards: [base, art].filter((entry) => codes.includes(entry.code)), missing: [] });
      }
      if (url === "/api/decks/cards") return Response.json({ cards: [art], total: 1, offset: 0 });
      return original(url, init);
    });
    stored = { ...savedDeck([]), mode: "domain", deck: { main: [], extra: [], side: [], deckMaster: base.code } };
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Deck Master: Barrel Dragon/ });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "barrel" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Barrel Dragon/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Use as Deck Master" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Deck Master: Barrel Dragon/ }).querySelector("img")?.getAttribute("src")).toContain(String(art.code)));
    expect(mainCards()).toHaveLength(0);
  });

  it("lists the + key on a deck card in Standard but not in Domain", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    const standard = render(<SavedDeckEditor deckId="7" />);
    expect(await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ })).toHaveAttribute("aria-keyshortcuts", expect.stringContaining("Plus"));
    standard.unmount();
    stored = domainDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    const tile = await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ });
    expect(tile).toHaveAttribute("aria-keyshortcuts", "Delete ContextMenu Shift+F10");
    fireEvent.keyDown(tile, { key: "+" });
    expect(mainCards()).toHaveLength(1);
    expect(screen.queryAllByRole("status").map((node) => node.textContent).join(" | ")).not.toContain("Domain decks hold one copy");
  });

  it("flags a Domain deck that holds two copies of a card", async () => {
    stored = domainDeck([POT.code, POT.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Pot of Greed, Main Deck card 1/ });
    expect(screen.getAllByText(/1 card has too many copies/).length).toBeGreaterThan(0);
  });

  it("offers Use as Deck Master for a monster but not for a Spell", async () => {
    stored = domainDeck([BLUE_EYES.code, POT.code]);
    render(<SavedDeckEditor deckId="7" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ }));
    expect(await screen.findByRole("button", { name: "Use as Deck Master" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /^Pot of Greed, Main Deck card/ }));
    await waitFor(() => expect(screen.getAllByText("Pot of Greed").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Use as Deck Master" })).toBeNull();
  });

  it("renders a saved Spell Deck Master without crashing and offers no Master control for it", async () => {
    stored = { ...domainDeck([BLUE_EYES.code]), deck: { main: [BLUE_EYES.code], extra: [], side: [], deckMaster: POT.code } };
    render(<SavedDeckEditor deckId="7" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Deck Master: Pot of Greed/ }));
    await waitFor(() => expect(screen.getAllByText("Pot of Greed").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "This is your Deck Master" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use as Deck Master" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("You can't use a Spell or Trap as your Deck Master.");
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
  });

  it("shows no Spell or Trap message for a monster Deck Master", async () => {
    stored = { ...domainDeck([POT.code]), deck: { main: [POT.code], extra: [], side: [], deckMaster: BLUE_EYES.code } };
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Deck Master: Blue-Eyes White Dragon/ });
    expect(screen.queryByText(/Spell or Trap/)).toBeNull();
  });

  it("shows the server's message when a save is refused for a Spell Deck Master", async () => {
    stored = { ...domainDeck([BLUE_EYES.code]), deck: { main: [BLUE_EYES.code], extra: [], side: [], deckMaster: POT.code } };
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      if (url === "/api/decks/7" && init?.method === "PUT") return Response.json({ error: "You can't use a Spell or Trap as your Deck Master." }, { status: 400 });
      return original(url, init);
    });
    render(<SavedDeckEditor deckId="7" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Blue-Eyes White Dragon, Main Deck card 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getAllByText("You can't use a Spell or Trap as your Deck Master.").length).toBeGreaterThan(1));
  });

  it("does not flag two copies in a Standard deck", async () => {
    stored = savedDeck([POT.code, POT.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findByRole("button", { name: /^Pot of Greed, Main Deck card 1/ });
    expect(screen.queryByText(/too many copies/)).toBeNull();
  });
});

describe("deck controls legend", () => {
  it("lists the deck and card list clicks in the left panel", async () => {
    render(<SavedDeckEditor />);
    const legend = await screen.findByRole("region", { name: "Controls" });
    expect(legend).toHaveTextContent("Left-click remove");
    expect(legend).toHaveTextContent("Ctrl+click move to/from Side Deck");
    expect(legend).toHaveTextContent("Right-click change art");
    expect(legend).toHaveTextContent("Ctrl+right-click add a copy");
    expect(legend).toHaveTextContent("Ctrl+right-click add a copy (Cmd on Mac), Standard only");
    expect(legend).toHaveTextContent("Click preview");
    expect(legend).toHaveTextContent("Double-click or Right-click add");
    expect(within(screen.getByRole("complementary", { name: "Card details" })).getByRole("region", { name: "Controls" })).toBe(legend);
  });

  it("shows the touch hint in the deck column on a phone", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() { this.callback([{ contentRect: { width: 390 } }]); }
      disconnect() {}
    });
    render(<SavedDeckEditor />);
    expect(await screen.findByText("Tap: select a card · Hold: change art")).toBeInTheDocument();
  });
});

describe("deck card hover and click guards", () => {
  it("previews the deck card under the pointer in Card details", async () => {
    stored = savedDeck([BLUE_EYES.code, POT.code]);
    render(<SavedDeckEditor deckId="7" />);
    const pot = await screen.findByRole("button", { name: /Pot of Greed, Main Deck card/ });
    const details = screen.getByRole("complementary", { name: "Card details" });
    fireEvent.pointerEnter(pot, { pointerType: "mouse" });
    expect(await within(details).findByRole("heading", { name: "Pot of Greed" })).toBeInTheDocument();
    fireEvent.pointerLeave(pot, { pointerType: "mouse" });
    await waitFor(() => expect(within(details).queryByRole("heading", { name: "Pot of Greed" })).toBeNull());
  });

  it("does not preview on a touch pointer", async () => {
    stored = savedDeck([BLUE_EYES.code, POT.code]);
    render(<SavedDeckEditor deckId="7" />);
    const pot = await screen.findByRole("button", { name: /Pot of Greed, Main Deck card/ });
    const details = screen.getByRole("complementary", { name: "Card details" });
    fireEvent.pointerEnter(pot, { pointerType: "touch" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(within(details).queryByRole("heading", { name: "Pot of Greed" })).toBeNull();
  });

  it("removes one card on a double-click, not two", async () => {
    stored = savedDeck([BLUE_EYES.code, BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findAllByRole("button", { name: /Main Deck card/ });
    const first = mainCards()[0]!;
    mouseClick(first);
    // The second click of the double-click lands on the card that took its place.
    fireEvent.pointerDown(mainCards()[0]!, { pointerType: "mouse", button: 0 });
    fireEvent.click(mainCards()[0]!, { detail: 2 });
    expect(mainCards()).toHaveLength(2);
  });

  it("only selects on a click that has no mouse press, as a screen reader sends it", async () => {
    stored = savedDeck([BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findAllByRole("button", { name: /Main Deck card/ });
    fireEvent.click(mainCards()[0]!, { detail: 1 });
    expect(mainCards()).toHaveLength(2);
    expect(mainCards()[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("does not remove a card when the press began on another card", async () => {
    stored = savedDeck([BLUE_EYES.code, BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findAllByRole("button", { name: /Main Deck card/ });
    fireEvent.pointerDown(mainCards()[0]!, { pointerType: "mouse", button: 0 });
    fireEvent.click(mainCards()[1]!, { detail: 1 });
    expect(mainCards()).toHaveLength(2);
  });

  it("treats a pen tap like a touch tap", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findAllByRole("button", { name: /Main Deck card/ });
    fireEvent.pointerDown(mainCards()[0]!, { pointerType: "pen", button: 0 });
    fireEvent.pointerUp(mainCards()[0]!, { pointerType: "pen", button: 0 });
    fireEvent.click(mainCards()[0]!, { detail: 1 });
    expect(mainCards()).toHaveLength(1);
  });

  it("moves a card to the Side Deck with Ctrl+Enter", async () => {
    stored = savedDeck([BLUE_EYES.code]);
    render(<SavedDeckEditor deckId="7" />);
    await screen.findAllByRole("button", { name: /Main Deck card/ });
    fireEvent.click(mainCards()[0]!, { detail: 0, ctrlKey: true });
    expect(mainCards()).toHaveLength(0);
    expect(within(screen.getByRole("region", { name: "Side Deck" })).getAllByRole("button", { name: /Side Deck card/ })).toHaveLength(1);
  });

  it("lists the keyboard keys in the legend and names Ctrl+click in the Side Deck hint", async () => {
    render(<SavedDeckEditor />);
    const legend = await screen.findByRole("region", { name: "Controls" });
    expect(legend).toHaveTextContent("Enter or Space select");
    expect(legend).toHaveTextContent("+ or = add a copy");
    expect(legend).toHaveTextContent("Ctrl+Enter move to/from Side Deck");
    expect(screen.getByText(/Ctrl\+click a deck card/)).toBeInTheDocument();
  });
});
