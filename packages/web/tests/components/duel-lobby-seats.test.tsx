// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultDuelSettings, type DuelRoom, type DuelListItem } from "@yugidraft/shared/duels";
import { makeSeries, makeSeriesRoom } from "../helpers/duel-series";

const { listSavedDecks, listData, takeDuelSeat, push, requireDuelActor, roomView } = vi.hoisted(() => ({
  listSavedDecks: vi.fn(), listData: { duels: [] as DuelListItem[] }, takeDuelSeat: vi.fn(), push: vi.fn(),
  requireDuelActor: vi.fn(), roomView: vi.fn(),
}));
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("swr", () => ({ default: () => ({ data: listData, mutate: vi.fn() }) }));
vi.mock("../../src/components/decks/api", () => ({ listSavedDecks }));
vi.mock("../../src/components/duel/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/components/duel/api")>(),
  takeDuelSeat,
  validateDuelDeck: vi.fn(async () => ({ issues: [] })),
  searchDuelCards: vi.fn(async () => ({ cards: [] })),
  getDuelCards: vi.fn(async () => ({ cards: [], missing: [] })),
}));
vi.mock("@/lib/duel-host", () => ({ requireDuelActor }));
vi.mock("@/components/duel/room", () => ({ DuelRoomView: (props: unknown) => {
  roomView(props);
  return <div>Room</div>;
} }));

import { navigateDuelWindow } from "../../src/components/duel/duel-window";
import { RoomLobby } from "../../src/components/duel/room-lobby";
import { DuelLobby } from "../../src/components/duel/lobby";
import DuelRoomPage from "../../app/(app)/duels/[slug]/page";

beforeEach(() => {
  takeDuelSeat.mockReset();
  takeDuelSeat.mockResolvedValue({ session: room(1, true).session });
  requireDuelActor.mockReset();
  requireDuelActor.mockResolvedValue({ ok: true, playerId: 11 });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function room(mySeat: number | null = null, full = false): DuelRoom {
  const data = makeSeriesRoom({ series: null, status: "lobby", mySeat });
  data.session.settings = defaultDuelSettings("normal");
  data.session.seriesId = null;
  data.session.seats = data.session.seats.slice(0, full ? 2 : 1).map((seat) => ({ ...seat, ready: false }));
  data.myDeck = null;
  return data;
}

function props(data: DuelRoom, busy = false) {
  return {
    room: data, slug: "game-1", busy, actionError: null,
    onTakeSeat: vi.fn(), onAddBot: vi.fn(), onRemoveBot: vi.fn(), onReady: vi.fn(), onStart: vi.fn(), onCancel: vi.fn(), onLeave: vi.fn(),
  };
}

describe("choosing a lobby seat", () => {
  it("shows room presence beside readiness and clears it independently", () => {
    const data = room(null, true);
    data.series = makeSeries({ tournamentId: 4 });
    data.session.seats[0].ready = true;
    const handlers = props(data);
    const view = render(<RoomLobby {...handlers} presence={{ onlineSeats: [1], spectatorCount: 0 }} />);
    const cards = within(screen.getByRole("region", { name: "Seats" })).getAllByRole("listitem");
    expect(within(cards[0]).getByText("Ready")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Away")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Not ready")).toBeInTheDocument();
    expect(within(cards[1]).getByText("In the room")).toBeInTheDocument();
    view.rerender(<RoomLobby {...handlers} presence={null} />);
    expect(screen.queryByText("In the room")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Seats" })).getAllByText("Presence unavailable")).toHaveLength(2);
  });

  it("shows presence per seat in a four-seat lobby without marking bots away", () => {
    const data = room(null, true);
    data.series = null;
    data.session.format = "ffa4";
    data.session.seats.push({ seat: 2, playerId: 33, displayName: "Joey", isBot: false, ready: true },
      { seat: 3, playerId: null, displayName: "Practice Bot", isBot: true, ready: true });
    render(<RoomLobby {...props(data)} presence={{ onlineSeats: [2], spectatorCount: 1 }} />);
    const cards = within(screen.getByRole("region", { name: "Seats" })).getAllByRole("listitem");
    expect(cards).toHaveLength(4);
    expect(within(cards[0]).getByText("Away")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Away")).toBeInTheDocument();
    expect(within(cards[2]).getByText("In the room")).toBeInTheDocument();
    expect(within(cards[3]).queryByText("Away")).toBeNull();
  });
  it.each(["normal", "domain"] as const)("offers a spectator an explicit seat action in a %s lobby without showing a deck editor", (mode) => {
    const data = room();
    data.session.mode = mode;
    const handlers = props(data);
    render(<RoomLobby {...handlers} />);
    expect(screen.getByText(/You are watching/)).toBeInTheDocument();
    const seats = screen.getByRole("region", { name: "Seats" });
    fireEvent.click(within(seats).getByRole("button", { name: "Take seat 2" }));
    expect(handlers.onTakeSeat).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("region", { name: "Deck import" })).toBeNull();
  });

  it("shows a full-table spectator state without a take-seat action", () => {
    render(<RoomLobby {...props(room(null, true))} />);
    expect(screen.getByText(/table is full.*watching/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Take seat|Join table/ })).toBeNull();
  });

  it("shows an open seat as soon as live room data releases it", () => {
    const handlers = props(room(null, true));
    const view = render(<RoomLobby {...handlers} />);
    expect(screen.queryByRole("button", { name: /Take seat/ })).toBeNull();
    view.rerender(<RoomLobby {...handlers} room={room()} />);
    expect(screen.getByRole("button", { name: "Take seat 2" })).toBeInTheDocument();
    view.rerender(<RoomLobby {...handlers} room={room(null, true)} />);
    expect(screen.queryByRole("button", { name: /Take seat/ })).toBeNull();
  });

  it("lets a seated guest watch instead, then removes the deck flow when their seat is released", () => {
    listSavedDecks.mockResolvedValue([]);
    const handlers = props(room(1, true));
    const view = render(<RoomLobby {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "Watch instead" }));
    expect(handlers.onLeave).toHaveBeenCalledTimes(1);
    view.rerender(<RoomLobby {...handlers} room={room()} />);
    expect(screen.queryByRole("region", { name: "Deck import" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Watch instead" })).toBeNull();
    expect(screen.getByRole("button", { name: "Take seat 2" })).toBeInTheDocument();
  });

  it("keeps the host seated and offers Cancel table", () => {
    listSavedDecks.mockResolvedValue([]);
    render(<RoomLobby {...props(room(0))} />);
    expect(screen.queryByRole("button", { name: "Watch instead" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel table" })).toBeInTheDocument();
  });

  it("preserves saved-deck selection and Ready after taking a seat", async () => {
    const deck = { main: new Array(40).fill(123), extra: [], side: [] };
    listSavedDecks.mockResolvedValue([{ id: 1, name: "Saved deck", mode: "normal", deck, createdAt: "", updatedAt: "" }]);
    const handlers = props(room(1, true));
    render(<RoomLobby {...handlers} />);
    const select = screen.getByLabelText("Use a saved deck");
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: "1" } });
    const ready = screen.getByRole("button", { name: "Ready with this deck" });
    await waitFor(() => expect(ready).not.toBeDisabled());
    fireEvent.click(ready);
    expect(handlers.onReady).toHaveBeenCalledWith(deck);
  });

  it("disables seat changes while an action is running and surfaces race errors", () => {
    render(<RoomLobby {...props(room(), true)} actionError="That seat is already taken. You are still watching." />);
    expect(screen.getByRole("button", { name: "Take seat 2" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/already taken/);
  });

  it.each(["opening", "series", "active"])("hides seat actions when locked by %s", (reason) => {
    const data = room(1, true);
    listSavedDecks.mockResolvedValue([]);
    if (reason === "opening") data.opening = { phase: "rps" } as DuelRoom["opening"];
    if (reason === "series") { data.series = makeSeries({ gameNumber: 2 }); data.session.seriesId = data.series.id; }
    if (reason === "active") data.session.status = "active";
    const handlers = props(data);
    const view = render(<RoomLobby {...handlers} />);
    expect(screen.queryByRole("button", { name: "Watch instead" })).toBeNull();
    view.rerender(<RoomLobby {...handlers} room={{ ...data, mySeat: null, session: { ...data.session, seats: data.session.seats.slice(0, 1) } }} />);
    expect(screen.queryByRole("button", { name: /Take seat|Join table/ })).toBeNull();
  });

  it("keeps a bot seat unavailable to human spectators", () => {
    const data = room(null, true);
    data.session.seats[1] = { seat: 1, playerId: null, displayName: "Practice Bot", isBot: true, ready: true };
    render(<RoomLobby {...props(data)} />);
    expect(screen.queryByRole("button", { name: /Take seat/ })).toBeNull();
  });
});

describe("own table row", () => {
  it("focuses the duel window this page already opened instead of loading a second board", () => {
    const popup = { closed: false, name: "", location: { href: "about:blank" }, focus: vi.fn() };
    const data = room(0, true);
    navigateDuelWindow(popup as unknown as Window, data.session.slug);
    popup.focus.mockClear();
    listData.duels = [{ ...data.session, status: "active", mySeat: 0, lastActivityAt: "", series: null }];
    render(<DuelLobby />);
    const link = screen.getByRole("link", { name: /Return/ });
    expect(fireEvent.click(link)).toBe(false);
    expect(popup.focus).toHaveBeenCalledOnce();
    popup.closed = true;
    expect(fireEvent.click(link)).toBe(true);
  });
});

describe("table list entry", () => {
  function table(full = false, occupiedSeat = 0) {
    const data = room(null, full);
    if (!full) data.session.seats[0].seat = occupiedSeat;
    listData.duels = [{ ...data.session, mySeat: null, lastActivityAt: "", series: null }];
    render(<DuelLobby />);
  }

  it.each([0, 1])("claims the open seat before navigating when seat %i is occupied", async (occupiedSeat) => {
    let resolveClaim!: (value: unknown) => void;
    takeDuelSeat.mockReturnValue(new Promise((resolve) => { resolveClaim = resolve; }));
    table(false, occupiedSeat);
    const join = screen.getByRole("button", { name: /Join/ });
    fireEvent.click(join);
    expect(takeDuelSeat).toHaveBeenCalledWith("game-1", occupiedSeat === 0 ? 1 : 0);
    expect(join).toBeDisabled();
    fireEvent.click(join);
    expect(takeDuelSeat).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    resolveClaim({ session: room(1, true).session });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/duels/game-1"));
  });

  it.each([409, 500])("opens the room as a spectator with a notice after a failed claim (%i)", async (status) => {
    const { DuelRequestError } = await import("../../src/components/duel/api");
    takeDuelSeat.mockRejectedValue(new DuelRequestError("That seat is already taken.", status));
    table();
    fireEvent.click(screen.getByRole("button", { name: /Join/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/duels/game-1?join=failed"));
    cleanup();
    render(await DuelRoomPage({ params: Promise.resolve({ slug: "game-1" }), searchParams: Promise.resolve({ join: "failed" }) }));
    expect(screen.getByRole("status")).toHaveTextContent(/could not confirm the seat claim/i);
  });

  it("keeps the notice neutral if the server seats the player before its response is lost", async () => {
    takeDuelSeat.mockImplementation(async () => {
      listData.duels[0].seats.push(room(1, true).session.seats[1]);
      throw new TypeError("Failed to fetch");
    });
    table();
    fireEvent.click(screen.getByRole("button", { name: /Join/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/duels/game-1?join=failed"));
    cleanup();
    render(await DuelRoomPage({ params: Promise.resolve({ slug: "game-1" }), searchParams: Promise.resolve({ join: "failed" }) }));
    expect(screen.getByRole("status")).toHaveTextContent("Could not confirm the seat claim.");
    expect(screen.getByRole("status")).not.toHaveTextContent(/spectator/);
  });

  it("offers Watch as a plain room link without claiming a seat", () => {
    table();
    const watch = screen.getByRole("link", { name: "Watch" });
    expect(watch).toHaveAttribute("href", "/duels/game-1");
    // Keep jsdom on the test page while exercising the link click.
    watch.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(watch);
    expect(takeDuelSeat).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the guild actor identity and failed-claim notice while spectating", async () => {
    render(await DuelRoomPage({ params: Promise.resolve({ slug: "game-1" }),
      searchParams: Promise.resolve({ join: "failed", spectate: "1", window: "1", stage: "legacy", invite: "code" }) }));
    expect(requireDuelActor).toHaveBeenCalledTimes(1);
    expect(roomView).toHaveBeenCalledWith({ slug: "game-1", inviteCode: "code", windowed: true,
      legacyStage: true, spectate: true, actorPlayerId: 11 });
    expect(screen.getByRole("status")).toHaveTextContent(/could not confirm the seat claim/i);
  });

  it("does not forward an actor identity when the guild guard denies access", async () => {
    requireDuelActor.mockResolvedValue({ ok: false });
    render(await DuelRoomPage({ params: Promise.resolve({ slug: "game-1" }), searchParams: Promise.resolve({ spectate: "1" }) }));
    expect(roomView).toHaveBeenCalledWith(expect.objectContaining({ spectate: true, actorPlayerId: null }));
  });

  it("shows no failed-claim notice for ordinary room entry", async () => {
    render(await DuelRoomPage({ params: Promise.resolve({ slug: "game-1" }), searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("labels a full lobby Full — watch and has no Join action", () => {
    table(true);
    expect(screen.getByRole("link", { name: /Full — watch/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Join/ })).toBeNull();
  });
});
