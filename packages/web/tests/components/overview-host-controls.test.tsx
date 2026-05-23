// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

import { OverviewHostControls } from "../../src/components/tournament/overview-host-controls";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OverviewHostControls — cancel", () => {
  it("requires inline confirmation, calls DELETE, then redirects to /tournaments", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 1, status: "cancelled" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<OverviewHostControls tournamentSlug="goat-cup" onCompleted={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /cancel tournament/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/goat-cup", { method: "DELETE" });
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/tournaments");
    });
  });

  it("surfaces the server error message and stays on the page", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "Only the tournament creator can cancel it" }, { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<OverviewHostControls tournamentSlug="goat-cup" onCompleted={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel tournament/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    expect(await screen.findByText(/only the tournament creator can cancel it/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("OverviewHostControls — end now (complete)", () => {
  it("requires inline confirmation, POSTs to /complete, then calls onCompleted (no redirect)", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 1, status: "completed" }));
    vi.stubGlobal("fetch", fetchMock);
    const onCompleted = vi.fn();

    render(<OverviewHostControls tournamentSlug="goat-cup" onCompleted={onCompleted} />);

    fireEvent.click(screen.getByRole("button", { name: /end tournament now/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /yes, end now/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/goat-cup/complete", { method: "POST" });
    });
    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalled();
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("surfaces the server error message and does not call onCompleted", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "Cannot end a pending tournament" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onCompleted = vi.fn();

    render(<OverviewHostControls tournamentSlug="goat-cup" onCompleted={onCompleted} />);
    fireEvent.click(screen.getByRole("button", { name: /end tournament now/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, end now/i }));

    expect(await screen.findByText(/cannot end a pending tournament/i)).toBeInTheDocument();
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
