// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardQuery, CardQueryResult, DeckCardInfo, DuelSettings } from "@yugidraft/shared/duels";
import { defaultDuelSettings } from "@yugidraft/shared/duels";
import { DeckEditor } from "../../src/components/duel/deck-editor";

const { queryDeckCards, getDeckCardFacets, validateDuelDeck } = vi.hoisted(() => ({
  queryDeckCards: vi.fn(),
  getDeckCardFacets: vi.fn(),
  validateDuelDeck: vi.fn(),
}));

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

vi.mock("../../src/components/decks/api", async (importActual) => ({
  ...await importActual<typeof import("../../src/components/decks/api")>(),
  listSavedDecks: vi.fn(async () => []),
  queryDeckCards,
  getDeckCardFacets,
}));
vi.mock("../../src/components/duel/api", async (importActual) => ({
  ...await importActual<typeof import("../../src/components/duel/api")>(),
  validateDuelDeck,
  searchDuelCards: vi.fn(async () => ({ cards: [] })),
  getDuelCards: vi.fn(async () => ({ cards: [], missing: [] })),
}));

function card(code: number, name: string, type: number, ot = 3): DeckCardInfo {
  return {
    code, name, description: "", type, attack: 2500, defense: 2000, level: 7, attribute: 0x10, race: "Dragon",
    alias: 0, setcodes: [], lscale: 0, rscale: 0, arrows: 0, ot,
  };
}

const BLUE_EYES = card(89631139, "Blue-Eyes White Dragon", 0x11);
const BLUE_EYES_ULTIMATE = card(23995346, "Blue-Eyes Ultimate Dragon", 0x41);
const POT = card(55144522, "Pot of Greed", 0x2);
const OCG_ONLY = card(70000001, "Blue-Eyes OCG Promo", 0x11, 1);

const normalSettings = (patch: Partial<DuelSettings> = {}): DuelSettings => ({ ...defaultDuelSettings("normal"), ...patch });

function answer(cards: DeckCardInfo[]): CardQueryResult {
  return { cards: cards.map(card => ({ ...card, altArtCount: 0 })), total: cards.length, offset: 0 };
}

function renderEditor(settings = normalSettings()) {
  return render(
    <DeckEditor slug="t" mode="normal" settings={settings} initial={{ main: [], extra: [], side: [] }} busy={false} onReady={vi.fn()} />,
  );
}

const field = () => screen.getByRole("combobox", { name: "Add card" });
const section = (title: string) => within(screen.getByRole("region", { name: `${title} deck` }));
const cardsIn = (title: string) => section(title).queryAllByRole("button", { name: /^Remove/ });

/** The dropdown's options (the saved-deck select also holds <option>s). */
const optionsNow = () => within(screen.getByRole("listbox")).getAllByRole("option");

/** Lets timers and resolved searches run; fake timers keep the 250 ms pause out of real time. */
const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const PAUSE = 260;

function type(text: string) {
  fireEvent.focus(field());
  fireEvent.change(field(), { target: { value: text } });
}

async function search(text: string) {
  type(text);
  await flush(PAUSE);
  return optionsNow();
}

beforeEach(() => {
  vi.useFakeTimers();
  queryDeckCards.mockReset();
  getDeckCardFacets.mockReset().mockResolvedValue({ archetypes: [], banlists: {} });
  validateDuelDeck.mockReset().mockResolvedValue({ issues: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("deck editor add card by name", () => {
  it("shows the closest matches with image, name and type while typing", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES, BLUE_EYES_ULTIMATE, POT]));
    renderEditor();
    type("blue eyes");
    expect(queryDeckCards).not.toHaveBeenCalled();
    await flush(PAUSE);

    const options = optionsNow();
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toContain("Blue-Eyes White Dragon");
    expect(options[0].textContent).toContain("Normal");
    expect(options[2].textContent).toContain("Spell");
    expect(options[0].querySelector("img")?.getAttribute("src")).toBe("/api/cards/89631139/image?size=small");

    const request = queryDeckCards.mock.calls[0][0] as CardQuery;
    expect(request).toMatchObject({ text: "blue eyes", scope: "name", sort: "match", limit: 8 });
    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(field().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(field().getAttribute("aria-activedescendant")).toBe(options[0].id);
  });

  it("moves with the arrow keys, adds with Enter, and defaults an Extra Deck monster to Extra", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES, BLUE_EYES_ULTIMATE, POT]));
    renderEditor();
    await search("blue");

    fireEvent.keyDown(field(), { key: "ArrowDown" });
    const options = optionsNow();
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(field().getAttribute("aria-activedescendant")).toBe(options[1].id);
    expect((screen.getByRole("combobox", { name: "Section" }) as HTMLSelectElement).value).toBe("extra");

    fireEvent.keyDown(field(), { key: "Enter" });
    expect(cardsIn("Extra")).toHaveLength(1);
    expect(cardsIn("Extra")[0].getAttribute("aria-label")).toContain("23995346");
    expect(cardsIn("Main")).toHaveLength(0);
    expect((field() as HTMLInputElement).value).toBe("");
  });

  it("adds the best match with Enter alone, to Main for a Main Deck card", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES, BLUE_EYES_ULTIMATE]));
    renderEditor();
    await search("blue-eyes white");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(cardsIn("Main")).toHaveLength(1);
    expect(cardsIn("Main")[0].getAttribute("aria-label")).toContain("89631139");
  });

  it("adds a card on click, to the section the player chose", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES]));
    renderEditor();
    fireEvent.change(screen.getByRole("combobox", { name: "Section" }), { target: { value: "side" } });
    fireEvent.click((await search("blue"))[0]);
    expect(cardsIn("Side")).toHaveLength(1);
    expect(cardsIn("Main")).toHaveLength(0);
  });

  it("uses a chosen Section for one add only, then goes back to the default", async () => {
    queryDeckCards.mockImplementation(async (request: CardQuery) =>
      answer(request.text === "ash" ? [POT] : [BLUE_EYES_ULTIMATE]));
    renderEditor();
    fireEvent.change(screen.getByRole("combobox", { name: "Section" }), { target: { value: "side" } });
    await search("ash");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(cardsIn("Side")).toHaveLength(1);
    expect((screen.getByRole("combobox", { name: "Section" }) as HTMLSelectElement).value).toBe("main");

    await search("decode");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(cardsIn("Extra")).toHaveLength(1);
    expect(cardsIn("Side")).toHaveLength(1);
  });

  it("keeps a chosen Section for an Extra Deck monster", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES_ULTIMATE]));
    renderEditor();
    fireEvent.change(screen.getByRole("combobox", { name: "Section" }), { target: { value: "main" } });
    await search("ultimate");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(cardsIn("Main")).toHaveLength(1);
    expect(cardsIn("Extra")).toHaveLength(0);
  });

  it("closes the dropdown on Escape and reopens it when typing", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES]));
    renderEditor();
    await search("blue");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(field(), { target: { value: "blue e" } });
    await flush(PAUSE);
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("closes the dropdown when the field loses focus", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES]));
    renderEditor();
    await search("blue");
    fireEvent.blur(field());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  it("still adds a plain number as a passcode", async () => {
    queryDeckCards.mockResolvedValue(answer([]));
    renderEditor();
    type("46986414");
    await flush(PAUSE);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(cardsIn("Main")).toHaveLength(1);
    expect(cardsIn("Main")[0].getAttribute("aria-label")).toContain("46986414");
    type("0");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Enter a positive passcode.");
  });

  it("shows the Extra default for a typed passcode of an Extra Deck monster, and adds it there", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES_ULTIMATE]));
    renderEditor();
    await search("23995346");
    expect((screen.getByRole("combobox", { name: "Section" }) as HTMLSelectElement).value).toBe("extra");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(cardsIn("Extra")).toHaveLength(1);
    expect(cardsIn("Main")).toHaveLength(0);
  });

  it("ignores a slow answer for an older search", async () => {
    const pending: Array<(value: CardQueryResult) => void> = [];
    queryDeckCards.mockImplementation(() => new Promise<CardQueryResult>((resolve) => { pending.push(resolve); }));
    renderEditor();
    type("blue");
    await flush(PAUSE);
    type("pot of");
    await flush(PAUSE);
    expect(queryDeckCards).toHaveBeenCalledTimes(2);

    await act(async () => { pending[1](answer([POT])); });
    expect(optionsNow().map((option) => option.textContent)).toEqual([expect.stringContaining("Pot of Greed")]);
    await act(async () => { pending[0](answer([BLUE_EYES, BLUE_EYES_ULTIMATE])); });
    expect(optionsNow()).toHaveLength(1);
    expect(screen.queryByText(/Blue-Eyes White Dragon/)).toBeNull();
  });

  it("searches at once when Enter comes before the results, then adds the best match", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES, BLUE_EYES_ULTIMATE]));
    renderEditor();
    type("blue-eyes white");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(cardsIn("Main")).toHaveLength(0);
    await flush(0);
    expect(queryDeckCards).toHaveBeenCalledTimes(1);
    expect(cardsIn("Main")).toHaveLength(1);
    expect(cardsIn("Main")[0].getAttribute("aria-label")).toContain("89631139");
  });

  it("Enter, results arrive, Enter adds once", async () => {
    let resolve: (value: CardQueryResult) => void = () => {};
    queryDeckCards.mockImplementation(() => new Promise<CardQueryResult>((done) => { resolve = done; }));
    renderEditor();
    type("blue-eyes white");
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush(0);
    await act(async () => {
      resolve(answer([BLUE_EYES]));
      await Promise.resolve();
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush(PAUSE);
    expect(cardsIn("Main")).toHaveLength(1);
    expect(queryDeckCards).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not search again after an early Enter found no allowed card", async () => {
    queryDeckCards.mockResolvedValue(answer([OCG_ONLY]));
    renderEditor(normalSettings({ cardPool: "tcg" }));
    type("blue");
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush(0);
    expect(screen.getByRole("alert").textContent).toContain("None of these cards can be added");
    await flush(PAUSE * 2);
    expect(queryDeckCards).toHaveBeenCalledTimes(1);
    expect(optionsNow()).toHaveLength(1);
  });

  it("cancels an early Enter when the text changes before the results come", async () => {
    const pending: Array<(value: CardQueryResult) => void> = [];
    queryDeckCards.mockImplementation(() => new Promise<CardQueryResult>((resolve) => { pending.push(resolve); }));
    renderEditor();
    type("blue");
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush(0);
    expect(queryDeckCards).toHaveBeenCalledTimes(1);

    type("pot");
    await act(async () => { pending[0](answer([BLUE_EYES])); });
    await flush(PAUSE);
    await act(async () => { pending[1](answer([POT])); });
    expect(cardsIn("Main")).toHaveLength(0);
    expect(optionsNow()).toHaveLength(1);
  });

  it("checks a typed passcode against the pool when Enter comes before the results", async () => {
    queryDeckCards.mockResolvedValue(answer([OCG_ONLY]));
    renderEditor(normalSettings({ cardPool: "tcg" }));
    type("70000001");
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush(0);
    expect(cardsIn("Main")).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain("Blue-Eyes OCG Promo cannot be added: Not TCG legal.");
  });

  it("sends an early-Enter passcode of an Extra Deck monster to Extra", async () => {
    queryDeckCards.mockResolvedValue(answer([BLUE_EYES_ULTIMATE]));
    renderEditor();
    type("23995346");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await flush(0);
    expect(cardsIn("Extra")).toHaveLength(1);
    expect(cardsIn("Main")).toHaveLength(0);
  });

  it("shows a card outside the room's card pool as disabled and cannot add it", async () => {
    queryDeckCards.mockResolvedValue(answer([OCG_ONLY, BLUE_EYES]));
    renderEditor(normalSettings({ cardPool: "tcg" }));
    const options = await search("blue");
    expect(options[0].getAttribute("aria-disabled")).toBe("true");
    expect(options[0].textContent).toContain("Not TCG legal");
    expect(options[1].getAttribute("aria-disabled")).toBeNull();
    // The best allowed match is selected, not the blocked first row.
    expect(field().getAttribute("aria-activedescendant")).toBe(options[1].id);

    fireEvent.click(options[0]);
    expect(cardsIn("Main")).toHaveLength(0);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(field().getAttribute("aria-activedescendant")).toBe(options[1].id);

    // Typing its passcode does not get around the pool either.
    await search("70000001");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(cardsIn("Main")).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain("Blue-Eyes OCG Promo cannot be added: Not TCG legal.");
  });

  it("marks a card the room's banlist forbids", async () => {
    getDeckCardFacets.mockResolvedValue({ archetypes: [], banlists: { "tcg-2026-09": { [POT.code]: 0 } } });
    queryDeckCards.mockResolvedValue(answer([POT]));
    renderEditor(normalSettings({ banlist: "tcg-2026-09", validateDeck: true }));
    const [option] = await search("pot");
    await flush(0);
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain("Forbidden");
    fireEvent.click(option);
    expect(cardsIn("Main")).toHaveLength(0);
  });
});
