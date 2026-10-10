// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelConfirm } from "../../../src/components/draft/room/cancel-confirm";
import { RoomBar } from "../../../src/components/draft/room/room-bar";
import { setCurrentMotion } from "../../../src/components/draft/room/motion";
import { DraftTerminalError, draftCancelMessage, requestDraftCancel } from "../../../src/lib/draft-terminal-client";

beforeEach(() => {
  setCurrentMotion("full");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Cancel draft button in the room bar", () => {
  const base = {
    name: "Friday cube night",
    sub: "6 at the table",
    motion: "full" as const,
    motionOpen: false,
    onMotion: () => {},
    canSay: false,
    sayOpen: false,
    onSay: () => {},
    progress: 0,
    where: { theme: false, extra: false, packRound: 1, packsPerPlayer: 3, pickStep: 1, packSize: 15, direction: 1 as const, phaseDone: 0, phaseOf: 0 },
  };

  it("is there for the host, labelled, and sends nothing itself", () => {
    const onCancel = vi.fn();
    render(<RoomBar {...base} canCancel onCancel={onCancel} />);
    const button = screen.getByRole("button", { name: "Cancel draft" });
    expect(button).toHaveTextContent("Cancel draft");
    expect(button).toHaveAttribute("data-tone", "danger");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).not.toHaveAttribute("aria-expanded");
    fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledExactlyOnceWith(button);
  });

  it("has no End now choice and no Host menu", () => {
    render(<RoomBar {...base} canCancel onCancel={() => {}} />);
    expect(screen.queryByRole("button", { name: "Host controls" })).toBeNull();
    expect(screen.queryByText(/End now/)).toBeNull();
  });

  it("is missing for a player who is not the host", () => {
    render(<RoomBar {...base} />);
    expect(screen.queryByRole("button", { name: "Cancel draft" })).toBeNull();
  });
});

describe("cancel confirm", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<CancelConfirm open={false} onConfirm={vi.fn()} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says the draft is void and the players must start a new one, and keeps focus on the safe button", () => {
    render(<CancelConfirm open onConfirm={vi.fn()} onClose={() => {}} />);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Cancel this draft?");
    expect(dialog).toHaveTextContent("The draft is void");
    expect(dialog).toHaveTextContent("Nobody keeps any cards");
    expect(dialog).toHaveTextContent("must start a new draft");
    expect(dialog).not.toHaveTextContent(/End now|keep the picks/i);
    expect(screen.getByRole("button", { name: "Keep drafting" })).toHaveFocus();
  });

  it("backs out without sending", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<CancelConfirm open onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep drafting" }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps Cancel draft off until the host types the word", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<CancelConfirm open onConfirm={onConfirm} onClose={() => {}} />);
    const confirm = screen.getByRole("button", { name: "Cancel draft" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("data-kind", "danger");
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "cance" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: "Cancel" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledExactlyOnceWith());
  });

  it("sends one request when the host clicks twice, and turns both buttons off while it runs", async () => {
    let finish: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    render(<CancelConfirm open onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "cancel" } });
    const confirm = screen.getByRole("button", { name: "Cancel draft" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const busy = screen.getByRole("button", { name: "Cancelling…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Keep drafting" })).toBeDisabled();
    // Escape does not close the dialog under a running request
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows the error in the dialog, stays open, and lets the host try again", async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("This draft is already finished or cancelled. Nothing was changed."))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<CancelConfirm open onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "cancel" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("already finished");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel draft" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});

describe("draft terminal client", () => {
  const reply = (status: number, body: unknown) =>
    vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

  it("posts to the cancel route without a body", async () => {
    const fetchMock = reply(200, { id: 1, status: "cancelled", changed: true });
    vi.stubGlobal("fetch", fetchMock);
    await requestDraftCancel("my draft");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/drafts/my%20draft/cancel", { method: "POST" });
  });

  it.each([
    [409, "DRAFT_ALREADY_FINISHED", /already finished/, true],
    [409, "DRAFT_HAS_TOURNAMENT", /tournament/, false],
    [503, undefined, /not available/, false],
    [401, undefined, /Sign in again/, false],
    [403, undefined, /host or an owner/, false],
    [500, undefined, /could not be cancelled/, false],
  ])("turns %s %s into plain words", async (status, code, words, refresh) => {
    vi.stubGlobal("fetch", reply(status, { error: "raw", code }));
    const err = await requestDraftCancel("d").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftTerminalError);
    expect((err as DraftTerminalError).message).toMatch(words);
    expect((err as DraftTerminalError).status).toBe(status);
    expect((err as DraftTerminalError).refresh).toBe(refresh);
  });

  it("never offers End as a way out", () => {
    for (const code of ["DRAFT_ALREADY_FINISHED", "DRAFT_HAS_TOURNAMENT"]) {
      expect(draftCancelMessage(409, code, null)).not.toMatch(/\bend(ed)?\b/i);
    }
    expect(draftCancelMessage(403, null, null)).toBe("Only the host or an owner can cancel this draft.");
  });

  it("explains a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fail")));
    const err = await requestDraftCancel("d").catch((e: unknown) => e);
    expect((err as DraftTerminalError).message).toMatch(/Could not reach the server/);
    expect((err as DraftTerminalError).status).toBeNull();
  });

  it("falls back to the server text for an unknown status", () => {
    expect(draftCancelMessage(418, null, "teapot")).toBe("teapot");
    expect(draftCancelMessage(418, null, null)).toBe("Failed to cancel the draft.");
  });
});
