// @vitest-environment jsdom
import React from "react";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "../../../src/lib/stores/draft-store";

vi.mock("next/font/google", () => {
  const font = (name: string) => () => ({ variable: `--mock-${name}`, className: name });
  return {
    Newsreader: font("newsreader"),
    Oxanium: font("oxanium"),
    Sofia_Sans_Extra_Condensed: font("sofia-c"),
    Sofia_Sans_Semi_Condensed: font("sofia-sc"),
  };
});
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

import { DraftRoom } from "../../../src/components/draft/room/draft-room";
configure({ asyncUtilTimeout: 4000 });

const card = (id: number) => ({
  id,
  passcode: id + 100000,
  name: `Card ${id}`,
  type: "Effect Monster",
  frameType: "effect",
  attribute: "DARK",
  level: 4,
  atk: 1000,
  def: 1000,
  effectText: "Does a thing.",
  imageUrl: `/c/${id}.jpg`,
  imageUrlSmall: `/c/${id}s.jpg`,
});

async function renderRoom(onCancel?: () => Promise<void>) {
  render(
    <DraftRoom slug="d" name="Friday" config={{ packSize: 3, packsPerPlayer: 2, cardsPerPlayer: 6, pickSeconds: 60 }} isParticipant onCancel={onCancel} />,
  );
  await screen.findByRole("button", { name: "Card 1" });
}

const room = () => document.querySelector(".room") as HTMLElement;
const cancelButton = () => screen.getByRole("button", { name: "Cancel draft" });

async function openConfirm() {
  fireEvent.click(cancelButton());
  return screen.findByRole("alertdialog");
}

describe("host controls in the draft room", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("yugidraft-room-motion", "off");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response));
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    useDraftStore.setState({
      slug: "d",
      packRound: 1,
      pickStep: 1,
      currentPack: [card(1), card(2), card(3)],
      myPool: [],
      seats: [
        { seatIndex: 0, playerId: 1, displayName: "Ann", hasPicked: false, isCurrentPlayer: true },
        { seatIndex: 1, playerId: 2, displayName: "Bo", hasPicked: false, isCurrentPlayer: false },
      ],
      timerSeconds: 40,
      isMyTurn: true,
      completed: false,
      pickSeconds: 60,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the Cancel draft button to the host and not to another player", async () => {
    await renderRoom(vi.fn());
    expect(cancelButton()).toBeInTheDocument();
    // One direct button: no Host menu, no End now.
    expect(screen.queryByRole("button", { name: "Host controls" })).toBeNull();
    expect(screen.queryByText(/End now/)).toBeNull();
    cleanup();
    await renderRoom(undefined);
    expect(screen.queryByRole("button", { name: "Cancel draft" })).toBeNull();
  });

  it("locks the room behind the confirm dialog, and frees it when the dialog closes", async () => {
    await renderRoom(vi.fn().mockResolvedValue(undefined));
    expect(room()).not.toHaveAttribute("inert");
    const dialog = await openConfirm();
    expect(room()).toHaveAttribute("inert");
    expect(dialog.closest("[inert]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep drafting" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(room()).not.toHaveAttribute("inert");
  });

  it("frees the room after a confirmed cancel and does not leave inert behind on unmount", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    await renderRoom(onCancel);
    let dialog = await openConfirm();
    expect(room()).toHaveAttribute("inert");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "cancel" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel draft" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledExactlyOnceWith());
    await waitFor(() => expect(room()).not.toHaveAttribute("inert"));
    // Focus goes back to the button that opened the dialog.
    await waitFor(() => expect(cancelButton()).toHaveFocus());

    dialog = await openConfirm();
    expect(room()).toHaveAttribute("inert");
    const detached = room();
    cleanup();
    // The room leaves the page with the dialog, and nothing outside it was marked.
    expect(detached.isConnected).toBe(false);
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });
});
