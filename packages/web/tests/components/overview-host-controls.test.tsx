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

describe("OverviewHostControls", () => {
  it("requires inline confirmation, calls DELETE, then redirects to /tournaments", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 1, status: "cancelled" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<OverviewHostControls tournamentSlug="goat-cup" />);

    // First click reveals the confirm row, does NOT call fetch yet.
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

    render(<OverviewHostControls tournamentSlug="goat-cup" />);
    fireEvent.click(screen.getByRole("button", { name: /cancel tournament/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    expect(await screen.findByText(/only the tournament creator can cancel it/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
