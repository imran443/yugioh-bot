// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelDeckValidation, DuelSettings, SavedDeck } from "@yugidraft/shared/duels";
import { DeckEditor } from "../../src/components/duel/deck-editor";

const { listSavedDecks, createSavedDeck } = vi.hoisted(() => ({ listSavedDecks: vi.fn(), createSavedDeck: vi.fn() }));

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

vi.mock("../../src/components/decks/api", () => ({ listSavedDecks, createSavedDeck }));
vi.mock("../../src/components/duel/api", () => ({
  validateDuelDeck: vi.fn(async () => ({ issues: [] }) as unknown as DuelDeckValidation),
  searchDuelCards: vi.fn(async () => ({ cards: [] })),
  getDuelCards: vi.fn(async () => ({ cards: [], missing: [] })),
}));

function saved(id: number, name: string, main: number[], mode: SavedDeck["mode"] = "normal"): SavedDeck {
  return { id, name, mode, deck: { main, extra: [], side: [] }, createdAt: "", updatedAt: "" };
}

const settings = { validateDeck: true } as DuelSettings;

function renderEditor(mode: "normal" | "domain" = "normal") {
  render(<DeckEditor slug="table-1" mode={mode} settings={settings} initial={null} busy={false} onReady={vi.fn()} />);
}

function importFile(name: string, text: string) {
  const input = screen.getByLabelText("YDK file");
  fireEvent.change(input, { target: { files: [new File([text], name, { type: "text/plain" })] } });
}

const YDK = "#main\n111\n112\n#extra\n!side\n";

describe("saving an imported deck to My Decks", () => {
  beforeEach(() => {
    listSavedDecks.mockResolvedValue([saved(1, "Alpha", [221])]);
    createSavedDeck.mockImplementation(async (input: { name: string; mode: SavedDeck["mode"]; deck: SavedDeck["deck"] }) => (
      { id: 9, name: input.name, mode: input.mode, deck: input.deck, createdAt: "", updatedAt: "" }
    ));
  });
  afterEach(() => vi.clearAllMocks());

  it("saves a file under its name without .ydk and lists it at once", async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    importFile("Red Eyes.ydk", YDK);

    expect(await screen.findByText("Saved to your decks as Red Eyes")).toBeInTheDocument();
    expect(createSavedDeck).toHaveBeenCalledWith({ name: "Red Eyes", mode: "normal", deck: { main: [111, 112], extra: [], side: [] } }, expect.any(AbortSignal));
    expect(screen.getByRole("option", { name: /^Red Eyes ·/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove 111 from Main" })).toBeInTheDocument();
  });

  it("names a paste Imported deck with the date and time", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Paste YDK or YDKE"), { target: { value: YDK } });
    fireEvent.click(screen.getByRole("button", { name: "Load paste" }));

    await waitFor(() => expect(createSavedDeck).toHaveBeenCalledOnce());
    expect(createSavedDeck.mock.calls[0][0].name).toMatch(/^Imported deck \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("adds (2) when the name is used", async () => {
    listSavedDecks.mockResolvedValue([saved(1, "Red Eyes", [221])]);
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    importFile("Red Eyes.ydk", YDK);

    expect(await screen.findByText("Saved to your decks as Red Eyes (2)")).toBeInTheDocument();
  });

  it("does not save the same cards twice", async () => {
    listSavedDecks.mockResolvedValue([saved(1, "Alpha", [112, 111])]);
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    importFile("Copy.ydk", YDK);

    expect(await screen.findByText("Already in your decks: Alpha")).toBeInTheDocument();
    expect(createSavedDeck).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove 111 from Main" })).toBeInTheDocument();
  });

  it("still saves when the same cards are saved in the other format", async () => {
    listSavedDecks.mockResolvedValue([saved(1, "Alpha", [111, 112], "domain")]);
    renderEditor("normal");
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    importFile("Copy.ydk", YDK);

    expect(await screen.findByText("Saved to your decks as Copy")).toBeInTheDocument();
  });

  it("keeps the import when the save fails", async () => {
    createSavedDeck.mockRejectedValue(new Error("Request failed (500)"));
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    importFile("Red Eyes.ydk", YDK);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save to your decks: Request failed (500)");
    expect(screen.getByRole("button", { name: "Remove 111 from Main" })).toBeInTheDocument();
  });

  it("saves a Domain import in the Manage decks shape, with the lone Side card as the Deck Master", async () => {
    renderEditor("domain");
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    importFile("Dom.ydk", "#main\n111\n112\n#extra\n!side\n113\n");

    await waitFor(() => expect(createSavedDeck).toHaveBeenCalledOnce());
    expect(createSavedDeck.mock.calls[0][0].deck).toEqual({ main: [111, 112], extra: [], side: [], deckMaster: 113 });
    expect(createSavedDeck.mock.calls[0][0].mode).toBe("domain");
  });

  it("saves two quick pastes of the same deck once", async () => {
    const server: SavedDeck[] = [];
    listSavedDecks.mockImplementation(async () => [...server]);
    createSavedDeck.mockImplementation(async (input: { name: string; mode: SavedDeck["mode"]; deck: SavedDeck["deck"] }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const deck = { id: 50 + server.length, name: input.name, mode: input.mode, deck: input.deck, createdAt: "", updatedAt: "" };
      server.unshift(deck);
      return deck;
    });
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Paste YDK or YDKE"), { target: { value: YDK } });
    fireEvent.click(screen.getByRole("button", { name: "Load paste" }));
    fireEvent.click(screen.getByRole("button", { name: "Load paste" }));

    expect(await screen.findByText(/^Already in your decks: Imported deck/)).toBeInTheDocument();
    expect(createSavedDeck).toHaveBeenCalledOnce();
    expect(screen.queryByText(/^Saved to your decks as/)).not.toBeInTheDocument();
  });

  it("saves an import made while the list loads, and the list then shows it", async () => {
    const server: SavedDeck[] = [saved(1, "Alpha", [221])];
    let release: (decks: SavedDeck[]) => void = () => undefined;
    listSavedDecks.mockImplementationOnce(() => new Promise<SavedDeck[]>((resolve) => { release = resolve; }));
    listSavedDecks.mockImplementation(async () => [...server]);
    createSavedDeck.mockImplementation(async (input: { name: string; mode: SavedDeck["mode"]; deck: SavedDeck["deck"] }) => {
      const deck = { id: 9, name: input.name, mode: input.mode, deck: input.deck, createdAt: "", updatedAt: "" };
      server.unshift(deck);
      return deck;
    });
    renderEditor();
    importFile("Red Eyes.ydk", YDK);

    expect(await screen.findByText("Saved to your decks as Red Eyes")).toBeInTheDocument();
    release([saved(1, "Alpha", [221])]);
    await waitFor(() => expect(screen.getByRole("option", { name: /^Red Eyes ·/ })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: /^Alpha ·/ })).toBeInTheDocument();
  });

  it("saves an import after the list failed to load, and the list then loads", async () => {
    const server: SavedDeck[] = [saved(1, "Alpha", [221])];
    listSavedDecks.mockRejectedValueOnce(new Error("Request failed (500)"));
    listSavedDecks.mockImplementation(async () => [...server]);
    createSavedDeck.mockImplementation(async (input: { name: string; mode: SavedDeck["mode"]; deck: SavedDeck["deck"] }) => {
      const deck = { id: 9, name: input.name, mode: input.mode, deck: input.deck, createdAt: "", updatedAt: "" };
      server.unshift(deck);
      return deck;
    });
    renderEditor();
    expect(await screen.findByText("Request failed (500)")).toBeInTheDocument();
    importFile("Red Eyes.ydk", YDK);

    expect(await screen.findByText("Saved to your decks as Red Eyes")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: /^Red Eyes ·/ })).toBeInTheDocument());
    expect(screen.queryByText("Request failed (500)")).not.toBeInTheDocument();
  });

  it("finds a Manage decks copy of a Domain import with a lone Side card", async () => {
    listSavedDecks.mockResolvedValue([
      { id: 4, name: "Manage copy", mode: "domain", deck: { main: [111, 112], extra: [], side: [], deckMaster: 113 }, createdAt: "", updatedAt: "" },
    ]);
    renderEditor("domain");
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    importFile("Dom.ydk", "#main\n111\n112\n#extra\n!side\n113\n");

    expect(await screen.findByText("Already in your decks: Manage copy")).toBeInTheDocument();
    expect(createSavedDeck).not.toHaveBeenCalled();
  });

  it("does not save a list that cannot be a Domain deck, and still imports it", async () => {
    renderEditor("domain");
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    importFile("Dom.ydk", "#main\n111\n112\n#extra\n!side\n113\n114\n");

    const note = await screen.findByText("Not saved to your decks: saved Domain decks have no Side Deck.");
    expect(note).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(createSavedDeck).not.toHaveBeenCalled();
  });

  it("saves a #deckmaster file as a Domain deck in a Standard room and says so", async () => {
    renderEditor("normal");
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());
    importFile("Master.ydk", "#main\n111\n#extra\n#deckmaster\n113\n");

    expect(await screen.findByText("Saved to your decks as Master, as a Domain deck because it has a Deck Master.")).toBeInTheDocument();
    expect(createSavedDeck.mock.calls[0][0]).toMatchObject({ mode: "domain", deck: { main: [111], deckMaster: 113 } });
  });

  it("connects the hint to the saved deck select", async () => {
    listSavedDecks.mockResolvedValue([saved(1, "Alpha", [221], "domain")]);
    renderEditor("normal");
    await waitFor(() => expect(screen.getByLabelText("Use a saved deck")).not.toBeDisabled());

    const select = screen.getByLabelText("Use a saved deck");
    const hint = document.getElementById(select.getAttribute("aria-describedby") ?? "");
    expect(hint).toHaveTextContent("1 saved deck uses another format");
  });
});
