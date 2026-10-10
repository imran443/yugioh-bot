// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelDeck, DuelDeckValidation, DuelFormat, DuelSettings } from "@yugidraft/shared/duels";
import { defaultDuelSettings } from "@yugidraft/shared/duels";
import { DeckEditor } from "../../src/components/duel/deck-editor";
import { RoomLobby } from "../../src/components/duel/room-lobby";
import { makeSeriesRoom } from "../helpers/duel-series";
import { DeckValidationSkippedError } from "../../src/components/duel/api";

const { validateDuelDeck } = vi.hoisted(() => ({ validateDuelDeck: vi.fn() }));

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

vi.mock("../../src/components/decks/api", () => ({ listSavedDecks: vi.fn(async () => []) }));
vi.mock("../../src/components/duel/api", async (importActual) => ({
  ...await importActual<typeof import("../../src/components/duel/api")>(),
  validateDuelDeck, searchDuelCards: vi.fn(async () => ({ cards: [] })),
  getDuelCards: vi.fn(async () => ({ cards: [], missing: [] })),
}));

const settings = { validateDeck: true } as DuelSettings;
const deck: DuelDeck = { main: [111, 112], extra: [], side: [] };
const lockedError = new DeckValidationSkippedError();

beforeEach(() => { validateDuelDeck.mockReset(); });
afterEach(cleanup);

describe("deck check when the duel starts", () => {
  it.each(["1v1", "tag", "ffa3", "ffa4"] as DuelFormat[])("aborts an in-flight %s check when the lobby becomes active", async (format) => {
    vi.useFakeTimers();
    try {
      const room = makeSeriesRoom({ series: null, status: "lobby", mySeat: 0 });
      room.session.format = format;
      room.session.settings = defaultDuelSettings("normal");
      room.myDeck = deck;
      let signal: AbortSignal | undefined;
      let resolve: (value: DuelDeckValidation) => void = () => {};
      validateDuelDeck.mockImplementation((_slug, _deck, current) => {
        signal = current;
        return new Promise<DuelDeckValidation>((done) => { resolve = done; });
      });
      const noop = vi.fn();
      const props = { slug: "t", busy: false, actionError: null, onTakeSeat: noop, onAddBot: noop, onRemoveBot: noop, onReady: noop, onStart: noop, onCancel: noop, onLeave: noop };
      const { rerender, unmount } = render(<RoomLobby room={room} {...props} />);
      await act(() => vi.advanceTimersByTimeAsync(151));
      expect(signal?.aborted).toBe(false);
      rerender(<RoomLobby room={{ ...room, session: { ...room.session, status: "active" } }} {...props} />);
      expect(signal?.aborted).toBe(true);
      await act(async () => { resolve({ issues: [] } as unknown as DuelDeckValidation); });
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(validateDuelDeck).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Deck could not be checked")).toBeNull();
      unmount();
    } finally { vi.useRealTimers(); }
  });

  it("aborts validation when the lobby unmounts", async () => {
    validateDuelDeck.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<DeckEditor slug="t" mode="normal" settings={settings} initial={deck} busy={false} onReady={vi.fn()} />);
    await waitFor(() => expect(validateDuelDeck).toHaveBeenCalledTimes(1));
    const signal = validateDuelDeck.mock.calls[0][2] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
  it("treats a locked answer as a room change: no error box, the room refreshes", async () => {
    validateDuelDeck.mockRejectedValue(lockedError);
    const onLocked = vi.fn();
    render(<DeckEditor slug="t" mode="normal" settings={settings} initial={deck} busy={false} onLocked={onLocked} onReady={vi.fn()} />);

    await waitFor(() => expect(onLocked).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Deck could not be checked")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry validation" })).toBeNull();
  });

  it("still shows other check failures with Retry", async () => {
    validateDuelDeck.mockRejectedValue(new Error("Network down"));
    render(<DeckEditor slug="t" mode="normal" settings={settings} initial={deck} busy={false} onReady={vi.fn()} />);

    expect(await screen.findByText("Deck could not be checked")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry validation" })).toBeTruthy();
  });

  it("runs no deck check while locked", async () => {
    validateDuelDeck.mockResolvedValue({ issues: [] } as unknown as DuelDeckValidation);
    render(<DeckEditor slug="t" mode="normal" settings={settings} initial={deck} busy={false} locked onReady={vi.fn()} />);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(validateDuelDeck).not.toHaveBeenCalled();
    expect(screen.queryByText(/Checking deck/)).toBeNull();
    expect((screen.getByRole("button", { name: "Ready with this deck" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Start duel button", () => {
  function lobby(starting: boolean) {
    const room = makeSeriesRoom({ series: null, status: "lobby", mySeat: 0 });
    room.session.settings = defaultDuelSettings("normal");
    room.session.seats[0].ready = true;
    room.session.seats[1].ready = true;
    room.myDeck = deck;
    const noop = vi.fn();
    render(<RoomLobby room={room} slug="t" busy={starting} starting={starting} actionError={null}
      onTakeSeat={noop} onAddBot={noop} onRemoveBot={noop} onReady={noop} onStart={noop} onCancel={noop} onLeave={noop} />);
  }

  it("is disabled with a Starting state while the request runs", () => {
    lobby(true);
    const button = screen.getByRole("button", { name: /Starting duel/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Start duel/ })).toBeNull();
  });

  it("is ready to click before the request", () => {
    lobby(false);
    expect((screen.getByRole("button", { name: /Start duel/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs no deck check once the start began", async () => {
    validateDuelDeck.mockResolvedValue({ issues: [] } as unknown as DuelDeckValidation);
    lobby(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(validateDuelDeck).not.toHaveBeenCalled();
  });
});
