// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDuelSettings, type DuelFormat, type DuelRoom } from "@yugidraft/shared/duels";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/duel/deck-editor", () => ({ DeckEditor: () => <div data-testid="deck-editor" /> }));
vi.mock("@/components/duel/deck-card-preview", () => ({ DeckCardPreview: () => null }));
vi.mock("@/components/duel/room-settings", () => ({
  DuelSettingsSummary: () => <div data-testid="settings" />,
  RoomInvite: () => <div data-testid="invite" />,
}));

import { DuelCreator } from "@/components/duel/creator";
import { RoomLobby } from "@/components/duel/room-lobby";
import { addPracticeBot } from "@/components/duel/api";
import { formatSeatCount, seatGroups, tagSeatCode } from "@/components/duel/table-format";

afterEach(() => {
  cleanup();
  push.mockReset();
  vi.unstubAllGlobals();
});

function room(format: DuelFormat, seats: Array<{ seat: number; ready?: boolean; isBot?: boolean }>, mySeat: number | null = 0): DuelRoom {
  return {
    session: {
      id: 1, slug: "t", kind: "play", name: "Table", guildId: "g", organizerPlayerId: 10, mode: "normal", format, masterRule: 5,
      status: "lobby", settings: defaultDuelSettings("normal"),
      seats: seats.map((s) => ({
        seat: s.seat, playerId: s.isBot ? null : s.seat === 0 ? 10 : 20 + s.seat, displayName: s.isBot ? "Bot" : `P${s.seat}`,
        ready: s.ready ?? false, isBot: s.isBot ?? false,
      })),
      createdAt: "", endedAt: null, archivedAt: null, winnerPlayerId: null, winnerSeat: null, resultReason: null,
    },
    role: "player", mySeat, myDeck: null, engine: null, clock: null, metadataOnly: false,
  };
}

const handlers = { onTakeSeat: vi.fn(), onRemoveBot: vi.fn(), onReady: vi.fn(), onStart: vi.fn(), onCancel: vi.fn(), onLeave: vi.fn() };

describe("table format helpers", () => {
  it("counts seats and groups Tag into teams", () => {
    expect(formatSeatCount("ffa3")).toBe(3);
    expect(formatSeatCount(undefined)).toBe(2);
    expect(seatGroups("tag")).toEqual([
      { title: "Team 1", seats: [0, 2] },
      { title: "Team 2", seats: [1, 3] },
    ]);
    expect(seatGroups("ffa4")).toEqual([{ title: null, seats: [0, 1, 2, 3] }]);
    expect([0, 1, 2, 3].map((s) => tagSeatCode("tag", s))).toEqual(["1A", "2A", "1B", "2B"]);
    expect(tagSeatCode("ffa4", 1)).toBeNull();
  });
});

describe("DuelCreator format picker", () => {
  it("defaults to 1v1 and sends the chosen format", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ session: { slug: "abc" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DuelCreator multiplayerTables multiCoreReady />);
    const picker = screen.getByLabelText("Table type") as HTMLSelectElement;
    expect(picker.value).toBe("1v1");
    fireEvent.change(picker, { target: { value: "tag" } });
    expect(screen.getByTestId("format-rule").textContent).toContain("16,000 LP per team");
    expect(screen.getByTestId("format-rule").textContent).toContain("turn 4");
    fireEvent.click(screen.getByRole("button", { name: /Create game/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).format).toBe("tag");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/duels/abc"));
  });

  it("shows FFA life points per duelist", () => {
    render(<DuelCreator multiplayerTables multiCoreReady />);
    fireEvent.change(screen.getByLabelText("Table type"), { target: { value: "ffa4" } });
    const note = screen.getByTestId("format-rule").textContent ?? "";
    expect(note).toContain("4 seats");
    expect(note).toContain("8,000 LP each");
    expect(note).toContain("No attack until every duelist has had a turn");
  });
});

describe("RoomLobby seats", () => {
  it("shows two teams with 4 seats in Tag and adds a bot to the clicked seat", () => {
    const onAddBot = vi.fn();
    render(<RoomLobby room={room("tag", [{ seat: 0, ready: true }])} slug="t" busy={false} actionError={null} onAddBot={onAddBot} {...handlers} />);
    expect(screen.getByRole("heading", { name: "Team 1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Team 2" })).toBeTruthy();
    expect(screen.getAllByText("Open seat")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Add bot to seat 3" }));
    expect(onAddBot).toHaveBeenCalledWith(2);
  });

  it("removes the practice bot of the clicked seat", () => {
    const onRemoveBot = vi.fn();
    const seats = [{ seat: 0, ready: true }, { seat: 1, ready: true, isBot: true }, { seat: 2, ready: true, isBot: true }];
    render(<RoomLobby room={room("ffa3", seats)} slug="t" busy={false} actionError={null} onAddBot={vi.fn()} {...handlers} onRemoveBot={onRemoveBot} />);
    const buttons = screen.getAllByRole("button", { name: "Remove practice bot" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(onRemoveBot).toHaveBeenCalledWith(2);
  });

  it("unlocks Start only when every FFA seat is ready", () => {
    const base = { busy: false, actionError: null, onAddBot: vi.fn(), ...handlers };
    const two = room("ffa3", [{ seat: 0, ready: true }, { seat: 1, isBot: true, ready: true }]);
    const { unmount } = render(<RoomLobby room={two} slug="t" {...base} />);
    expect(screen.queryByRole("button", { name: /Start duel/ })).toBeNull();
    unmount();
    const three = room("ffa3", [{ seat: 0, ready: true }, { seat: 1, isBot: true, ready: true }, { seat: 2, isBot: true, ready: true }]);
    render(<RoomLobby room={three} slug="t" {...base} />);
    expect(screen.getByRole("button", { name: /Start duel/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add bot to seat/ })).toBeNull();
  });

  it("keeps the 1v1 lobby to two seats", () => {
    render(<RoomLobby room={room("1v1", [{ seat: 0 }])} slug="t" busy={false} actionError={null} onAddBot={vi.fn()} {...handlers} />);
    expect(screen.getAllByText("Open seat")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Team 1" })).toBeNull();
  });
});

describe("addPracticeBot", () => {
  it("sends no body without a seat and a seat index with one", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ session: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await addPracticeBot("t");
    await addPracticeBot("t", 2);
    expect(fetchMock.mock.calls[0]).toEqual(["/api/duels/t/bot", { method: "POST" }]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ seat: 2 });
  });
});
